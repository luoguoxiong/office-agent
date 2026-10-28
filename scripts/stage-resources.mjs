// scripts/stage-resources.mjs
// 打包前将运行时资源 staging 到 src-tauri/resources(dist + dist-web + 生产依赖)。
// 生产依赖在 workspace 外的临时目录用 yarn 装成扁平 node_modules:
//  - yarn 默认就是 hoisted 扁平布局(无符号链接),解链复制进 .app 后模块解析依然成立
//    (修复 isolated 布局 realpath 链断裂导致 @aipack-ai/agent 找不到 @sinclair/typebox 的问题);
//  - 在 workspace 外安装,避免 yarn 把它当作 workspace 根而连带安装 web/ 的前端依赖。
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resDir = join(root, 'src-tauri', 'resources');
const stageDir = mkdtempSync(join(tmpdir(), 'aioffice-stage-'));

try {
  // 1. 清理并重建资源目录
  rmSync(resDir, { recursive: true, force: true });
  mkdirSync(resDir, { recursive: true });

  // 2. 拷贝编译产物(server 与前端静态资源)
  for (const name of ['dist', 'dist-web']) {
    const src = join(root, name);
    if (!existsSync(src)) throw new Error(`缺少构建产物 ${src},请先执行 yarn build`);
    cpSync(src, join(resDir, name), { recursive: true, dereference: true });
  }

  // 3. 在临时目录生成仅含生产依赖的 package.json(yarn 装成扁平 node_modules)
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  writeFileSync(
    join(stageDir, 'package.json'),
    JSON.stringify(
      {
        name: 'aioffice-runtime',
        private: true,
        type: 'module',
        dependencies: rootPkg.dependencies,
      },
      null,
      2,
    ),
  );

  // 4. 安装生产依赖(officecli 的 postinstall 负责下载 vendor 二进制,yarn 默认执行构建脚本)
  //    两轮尝试:
  //      ① --prefer-offline:命中 yarn 全局缓存时无需联网,CI 上更快;
  //      ② 纯联网安装:缓存条目损坏(如缺 package.json 的不完整缓存目录)会让 ① 直接失败,
  //         去掉 --prefer-offline 由 yarn 重新拉取即可绕过,避免本地/CI 打包被脏缓存卡死。
  const attempts = [
    ['install', '--production', '--prefer-offline', '--no-lockfile', '--non-interactive'],
    ['install', '--production', '--no-lockfile', '--non-interactive', '--network-timeout', '600000'],
  ];
  let install = null;
  for (const [i, args] of attempts.entries()) {
    console.log(`[stage:resources] 安装生产依赖(${i === 0 ? '离线优先' : '联网重试'}): yarn ${args.join(' ')}`);
    install = runYarn(args, { stdio: 'inherit', cwd: stageDir });
    if (install.status === 0) break;
  }
  if (!install || install.status !== 0) {
    throw new Error(`yarn install 失败(exit=${install?.status}),请确认网络可用或 yarn 缓存中存在生产依赖`);
  }

  // 5. 校验关键产物后拷入资源目录
  //    Windows 上 officecli 的可执行文件名为 officecli.exe
  const officecliBin = join(
    stageDir,
    'node_modules',
    '@officecli',
    'officecli',
    'vendor',
    process.platform === 'win32' ? 'officecli.exe' : 'officecli',
  );
  if (!existsSync(officecliBin)) throw new Error(`officecli 二进制缺失: ${officecliBin}`);
  cpSync(join(stageDir, 'node_modules'), join(resDir, 'node_modules'), {
    recursive: true,
    dereference: true,
  });

  // 6. 打包 node 运行时,让 App 自包含(从 Finder/launchd/资源管理器启动时系统 PATH 极简,找不到 node 会启动崩溃)
  const nodeSrc = resolveNodeBinary();
  if (nodeSrc) {
    const runtimeDir = join(resDir, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
    const dest = join(runtimeDir, nodeName);
    cpSync(nodeSrc, dest, { dereference: true });
    chmodSync(dest, 0o755);
    console.log(`[stage:resources] 已打包 node 运行时 → resources/runtime/${nodeName} (${nodeSrc})`);
  } else {
    console.warn('[stage:resources] ⚠️ 未找到可打包的 node,App 启动时将回退到系统 PATH 查找');
  }

  // 7. 写入 dist/package.json(type: module)
  //    项目根 package.json 声明 "type":"module",但打包后 resources/ 下没有 package.json,
  //    内置 node 会把 dist/server.js 当 CommonJS 解析 → SyntaxError → 后端起不来 → 启动超时崩溃。
  //    放在 dist/ 内最安全:只影响 dist/*.js(全为 ESM 产物),不会波及 node_modules
  //    (Node 的 type 解析在 node_modules 边界即停止)。
  writeFileSync(
    join(resDir, 'dist', 'package.json'),
    JSON.stringify({ name: 'aioffice-dist', private: true, type: 'module' }, null, 2) + '\n',
  );

  console.log(`[stage:resources] 完成 → ${resDir}`);
} finally {
  rmSync(stageDir, { recursive: true, force: true });
}

// ─── 辅助:跨平台执行 yarn ─────────────────────────────────────────────
// Windows 下 npm 全局安装的 yarn 是 yarn.cmd 脚本,Node 的 spawnSync 不带 shell
// 时无法直接启动 .cmd/.bat(返回 ENOENT/EINVAL,stdout 为 null),而 shell:true
// 又不会对含空格的参数加引号。这里用 cmd.exe /d /s /c 执行并手动对含空白/特殊
// 字符的参数加引号,保证含空格的路径也能正确传参。
function quoteCmdArg(arg) {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

function runYarn(args, options = {}) {
  if (process.platform !== 'win32') {
    return spawnSync('yarn', args, { encoding: 'utf8', ...options });
  }
  const cmdline = `yarn ${args.map(quoteCmdArg).join(' ')}`;
  return spawnSync('cmd.exe', ['/d', '/s', '/c', cmdline], { encoding: 'utf8', ...options });
}

// ─── 辅助:解析要打包进 bundle 的 node 二进制 ─────────────────────────────
// 优先级:AI_OFFICE_NODE 环境变量 → PATH 中的 node → 常见安装位置 → nvm/fnm 等版本目录
function resolveNodeBinary() {
  const envNode = process.env.AI_OFFICE_NODE;
  if (envNode && existsSync(envNode)) return envNode;

  // 1) PATH 搜索(Windows: where,其他: which)
  if (process.platform === 'win32') {
    const nodeName = 'node.exe';
    const where = spawnSync('where', [nodeName], { encoding: 'utf8' });
    if (where.status === 0 && where.stdout.trim()) {
      const hit = where.stdout
        .split(/\r?\n/)
        .map((p) => p.trim())
        .find((p) => p && existsSync(p));
      if (hit) return hit;
    }
  } else {
    const which = spawnSync('which', ['node'], { encoding: 'utf8' });
    if (which.status === 0 && which.stdout.trim() && existsSync(which.stdout.trim())) {
      return which.stdout.trim();
    }
  }

  // 2) 常见安装位置
  if (process.platform === 'win32') {
    // Windows 默认安装路径:%ProgramFiles%\nodejs\node.exe(优先 64 位)
    for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (!pf) continue;
      const candidate = join(pf, 'nodejs', 'node.exe');
      if (existsSync(candidate)) return candidate;
    }
  } else {
    for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
      if (existsSync(p)) return p;
    }
  }

  // 3) 版本管理器安装目录(nvm: ~/.nvm/versions/node/v*/bin/node,取版本最高)
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const nvmRoot = join(homedir(), '.nvm', 'versions', 'node');
  if (existsSync(nvmRoot)) {
    const versions = readdirSync(nvmRoot)
      .map((n) => join(nvmRoot, n, 'bin', nodeName))
      .filter((p) => existsSync(p))
      .sort();
    if (versions.length) return versions[versions.length - 1];
  }
  return null;
}
