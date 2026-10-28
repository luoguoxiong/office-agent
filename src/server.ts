/**
 * ai-office 后端入口(原生 http,零运行时框架依赖):
 *   - GET  /api/v1/config                 → 模型/工作区/officecli 状态(JSON)
 *   - GET  /api/v1/workspace              → 当前工作区信息(JSON)
 *   - POST /api/v1/workspace/open         → 打开文件夹(body {path},持久化,返回 tree)
 *   - GET  /api/v1/workspace/tree?path=&depth=  → 递归文件树(懒加载)
 *   - GET  /api/v1/file/open?path=        → 打开 office 文件(返回 officecli watch 预览 url)
 *   - GET  /api/v1/file/download?path=    → 下载工作区文件
 *   - POST /api/v1/chat                   → SSE 流式:text/thinking/tool/file/done
 *   - GET  /  (prod)                      → serve dist-web/ 静态产物(SPA 回退 index.html)
 *
 * 启动:yarn dev (或 yarn serve 生产模式)
 *
 * 可靠性改进(异常关闭 → 再次打开可正常使用):
 *   - 启动时自动清理残留 officecli watch 进程
 *   - 启动时若监听端口被占用,先尝试识别并终止旧的 ai-office 后端进程(避免"重启后端口占用卡死")
 *   - 关闭信号(SIGINT/SIGTERM/SIGHUP/SIGQUIT)统一走 shutdown,超时兜底强制退出
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, buildModel, resolveModelChoice } from './config.js';
import { createOfficeRuntime, runOfficeAgent, type OfficeEvent } from './runtime.js';
import { createWorkspace, resolveInWorkspace, type Workspace, ensureDirForFile } from './workspace.js';
import { buildFileTree, type TreeNode } from './file-tree.js';
import { ensureWatch, stopAllWatch, cleanupStaleOfficecliWatches } from './preview.js';
import { officecliAvailable, officeCreateClose } from './tools/officecli.js';
import type { Runtime } from '@aipack-ai/agent';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 工作区选择持久化文件(服务重启后沿用上次选择) */
const STATE_FILE = process.env.AI_OFFICE_DATA_DIR
  ? path.resolve(process.env.AI_OFFICE_DATA_DIR, '.aipack', 'workspace-state.json')
  : path.resolve(__dirname, '../.aipack/workspace-state.json');
/** prod 模式静态产物目录(Vite build → dist-web) */
const STATIC_DIR = process.env.AI_OFFICE_STATIC
  ? path.resolve(process.env.AI_OFFICE_STATIC)
  : path.resolve(__dirname, '../dist-web');

/** 开发模式:开启前端自动刷新;NODE_ENV=production 关闭 */
const IS_DEV = process.env.NODE_ENV !== 'production';
const BOOT_ID = `${process.pid}:${Date.now()}`;

/** 关闭阶段:正常清理最多等待这么久,之后强制 process.exit 兜底 */
const SHUTDOWN_FORCE_EXIT_MS = 3000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.bak': 'application/octet-stream',
};

const PREVIEW_TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.json', '.log', '.html']);
const PREVIEW_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico']);
const PREVIEW_OFFICE_EXTS = new Set(['.xlsx', '.docx', '.pptx']);
const PREVIEW_MAX_CHARS = 300_000;

// ─── officecli 预览反代(token → 文件路径,同源后可注入 CSS 隐藏滚动条)──
const pathToToken = new Map<string, string>();
const tokenToPath = new Map<string, string>();

/** 获取或创建文件路径对应的预览 token(稳定,同一文件复用同一 token) */
function getOrCreatePreviewToken(absPath: string): string {
  let token = pathToToken.get(absPath);
  if (!token) {
    token = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    pathToToken.set(absPath, token);
    tokenToPath.set(token, absPath);
  }
  return token;
}

/** 清空所有预览 token 映射(工作区切换 / 服务关闭时调用) */
function clearPreviewTokens(): void {
  pathToToken.clear();
  tokenToPath.clear();
}

/** 注入到 officecli 预览 HTML 中隐藏滚动条的 CSS */
const HIDE_SCROLLBAR_CSS =
  '<style id="ai-office-hide-scrollbar">::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}*{scrollbar-width:none!important;-ms-overflow-style:none!important}</style>';

async function main() {
  // ─── 启动前置清理(解决「关闭再打开卡住」核心问题) ──────────────
  // 1) 清掉上次异常退出残留的 officecli watch 进程(释放随机预览端口 + 文件句柄)
  try {
    await cleanupStaleOfficecliWatches();
  } catch {
    // ignore:失败不阻塞启动
  }

  const config = loadConfig();

  // 2) 若目标端口已被占用,尝试识别是不是「旧的 ai-office 后端自己」,是则主动终止它
  //    (用户上次异常关闭 Tauri 窗口,beforeDevCommand 信号没传下来,Node 后端残留导致端口占用)
  try {
    await freeUpPortIfOwnedByUs(config.port);
  } catch {
    // ignore:判断失败就让后续 server.listen 抛错正常暴露问题
  }

  // 文件工作区:优先加载上次持久化的选择
  let ws = await createWorkspace(config.workspace);
  try {
    const saved = JSON.parse(await fs.readFile(STATE_FILE, 'utf-8')) as { root?: unknown };
    if (typeof saved.root === 'string' && saved.root.trim()) {
      ws = await createWorkspace(saved.root);
    }
  } catch {
    // 无持久化记录 → 使用默认工作区
  }
  const saveWorkspaceState = async () => {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify({ root: ws.root }, null, 2));
  };
  await saveWorkspaceState();

  const officecliReady = await officecliAvailable();

  // Runtime 注册表:按「工作区 + 模型」按需构建并缓存(切换模型/工作区时重建)
  const cache = new Map<string, Runtime>();
  const getRuntime = async (provider: string, modelId: string, apiKey: string): Promise<Runtime> => {
    const cacheKey = `${ws.root}|${provider}/${modelId}:u:${apiKey.slice(0, 4)}`;
    let rt = cache.get(cacheKey);
    if (!rt) {
      const { model, streamFn } = buildModel(provider, modelId, apiKey);
      rt = await createOfficeRuntime(model, streamFn, ws.root);
      cache.set(cacheKey, rt);
    }
    return rt;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const p = url.pathname;

      // ── GET /api/v1/config ─────────────────────────────────────
      if (req.method === 'GET' && p === '/api/v1/config') {
        return json(res, 200, {
          provider: config.provider,
          model: config.modelId,
          llmReady: config.llmReady,
          officecliReady,
          models: config.models,
          workspace: path.basename(ws.root),
          workspaceRoot: ws.root,
          tools: ['office_read', 'office_help', 'office_exec', 'file_tree'],
        });
      }

      // ── GET /api/v1/workspace ───────────────────────────────────
      if (req.method === 'GET' && p === '/api/v1/workspace') {
        return json(res, 200, {
          root: ws.root,
          name: path.basename(ws.root),
          defaultRoot: config.workspace,
        });
      }

      // ── POST /api/v1/workspace/open (打开文件夹) ───────────────
      if (req.method === 'POST' && p === '/api/v1/workspace/open') {
        const body = (await readJson(req).catch(() => null)) as { path?: unknown } | null;
        const inputPath = typeof body?.path === 'string' ? body.path.trim() : '';
        if (!inputPath) return json(res, 400, { error: '缺少 path 参数' });
        if (inputPath.length > 2048) return json(res, 400, { error: '路径过长(限 2048 字符)' });
        let stat;
        try {
          stat = await fs.stat(inputPath);
        } catch {
          return json(res, 404, { error: `目录不存在: ${inputPath}` });
        }
        if (!stat.isDirectory()) return json(res, 400, { error: '路径不是目录' });
        ws = await createWorkspace(path.resolve(inputPath));
        cache.clear();
        stopAllWatch();
        clearPreviewTokens();
        await saveWorkspaceState();
        const tree = await buildFileTree(ws.root, '', 1);
        return json(res, 200, { root: ws.root, name: path.basename(ws.root), tree });
      }

      // ── GET /api/v1/workspace/tree (递归文件树,懒加载) ─────────
      if (req.method === 'GET' && p === '/api/v1/workspace/tree') {
        const dirParam = (url.searchParams.get('path') || '').trim();
        const depthParam = Math.min(Math.max(Number(url.searchParams.get('depth')) || 1, 0), 10);
        let rootAbs: string;
        let relBase: string;
        if (dirParam) {
          rootAbs = resolveInWorkspace(ws.root, dirParam);
          relBase = dirParam;
        } else {
          rootAbs = ws.root;
          relBase = '';
        }
        const tree = await buildFileTree(rootAbs, relBase, depthParam);
        return json(res, 200, { root: ws.root, path: relBase, nodes: tree });
      }

      // ── GET /api/v1/file/open (打开单个文件 → 预览信息) ────────
      if (req.method === 'GET' && p === '/api/v1/file/open') {
        return handleFileOpen(url.searchParams.get('path') || '', ws, officecliReady, res);
      }

      // ── GET /api/v1/file/download (下载) ──────────────────────
      if (req.method === 'GET' && p === '/api/v1/file/download') {
        return handleFileDownload(url.searchParams.get('path') || '', ws, res);
      }

      // ── POST /api/v1/workspace/file/create (新建文件) ───────────
      if (req.method === 'POST' && p === '/api/v1/workspace/file/create') {
        const body = (await readJson(req).catch(() => null)) as
          | { dir?: unknown; name?: unknown; ext?: unknown }
          | null;
        const parentDir = typeof body?.dir === 'string' ? body.dir.trim() : '';
        const rawName = typeof body?.name === 'string' ? body.name.trim() : '';
        const extRaw = typeof body?.ext === 'string' ? body.ext.trim().toLowerCase() : '';
        if (!rawName) return json(res, 400, { error: '请输入文件名' });
        if (rawName.length > 255) return json(res, 400, { error: '文件名过长(限 255 字符)' });
        if (rawName.includes('/') || rawName.includes('\\') || rawName.includes('\0'))
          return json(res, 400, { error: '文件名包含非法字符' });

        // 扩展名:若用户没传则自动从文件名提取;若传入则追加
        let name = rawName;
        let ext = extRaw;
        if (ext) {
          if (!ext.startsWith('.')) ext = `.${ext}`;
          if (!name.toLowerCase().endsWith(ext)) {
            name = `${name}${ext}`;
          }
        } else {
          ext = path.extname(name).toLowerCase();
        }

        // 工作区内父目录
        let parentAbs: string;
        try {
          if (parentDir) {
            parentAbs = resolveInWorkspace(ws.root, parentDir);
          } else {
            parentAbs = ws.root;
          }
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }

        // 确保父目录存在
        try {
          const stat = await fs.stat(parentAbs);
          if (!stat.isDirectory()) return json(res, 400, { error: '父路径不是目录' });
        } catch {
          return json(res, 404, { error: '父目录不存在' });
        }

        const relPath = parentDir ? `${parentDir}/${name}` : name;
        let abs: string;
        try {
          abs = resolveInWorkspace(ws.root, relPath);
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }

        // 已存在检查
        try {
          await fs.access(abs);
          return json(res, 409, { error: '文件已存在' });
        } catch {
          // ok:不存在
        }

        try {
          await ensureDirForFile(abs);
          const OFFICE_EXTS = new Set(['.xlsx', '.docx', '.pptx']);
          if (OFFICE_EXTS.has(ext)) {
            if (!(await officecliAvailable())) {
              return json(res, 400, { error: '创建 Office 文档需要安装 officecli' });
            }
            await officeCreateClose(abs);
          } else {
            // 文本/其他类型:创建空文件
            await fs.writeFile(abs, '', 'utf-8');
          }
          // 返回创建后的相对路径
          return json(res, 200, { path: relPath, name });
        } catch (e) {
          return json(res, 500, { error: `创建失败: ${(e as Error).message}` });
        }
      }

      // ── POST /api/v1/workspace/dir/create (新建文件夹) ──────────
      if (req.method === 'POST' && p === '/api/v1/workspace/dir/create') {
        const body = (await readJson(req).catch(() => null)) as
          | { dir?: unknown; name?: unknown }
          | null;
        const parentDir = typeof body?.dir === 'string' ? body.dir.trim() : '';
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (!name) return json(res, 400, { error: '请输入文件夹名称' });
        if (name.length > 255) return json(res, 400, { error: '文件夹名过长(限 255 字符)' });
        if (name.startsWith('.') || name.includes('/') || name.includes('\\') || name.includes('\0'))
          return json(res, 400, { error: '文件夹名包含非法字符或以 . 开头' });

        let parentAbs: string;
        try {
          if (parentDir) {
            parentAbs = resolveInWorkspace(ws.root, parentDir);
          } else {
            parentAbs = ws.root;
          }
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }

        try {
          const stat = await fs.stat(parentAbs);
          if (!stat.isDirectory()) return json(res, 400, { error: '父路径不是目录' });
        } catch {
          return json(res, 404, { error: '父目录不存在' });
        }

        const relPath = parentDir ? `${parentDir}/${name}` : name;
        let abs: string;
        try {
          abs = resolveInWorkspace(ws.root, relPath);
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }

        try {
          await fs.access(abs);
          return json(res, 409, { error: '文件夹已存在' });
        } catch {
          // ok:不存在
        }

        try {
          await fs.mkdir(abs, { recursive: false });
          return json(res, 200, { path: relPath, name });
        } catch (e) {
          return json(res, 500, { error: `创建失败: ${(e as Error).message}` });
        }
      }

      // ── POST /api/v1/chat (SSE 流式) ───────────────────────────
      if (req.method === 'POST' && p === '/api/v1/chat') {
        return handleChat(req, res, { getRuntime });
      }

      // ── GET /api/v1/preview/<token>/* (officecli 预览反代,同源 → 注入 CSS 隐藏滚动条)
      if (req.method === 'GET' && p.startsWith('/api/v1/preview/')) {
        // 解析:/api/v1/preview/<token>/<sub-path>
        const rest = p.slice('/api/v1/preview/'.length);
        const slashIdx = rest.indexOf('/');
        const token = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
        const subPath = slashIdx >= 0 ? rest.slice(slashIdx) : '/';

        const absPath = tokenToPath.get(token);
        if (!absPath) {
          return json(res, 404, { error: '预览不存在或已过期' });
        }

        let port: number;
        try {
          port = await ensureWatch(absPath);
        } catch {
          return json(res, 502, { error: '预览服务不可用' });
        }

        // 转发请求到 officecli(不转发 accept-encoding → 获取未压缩 HTML 便于注入)
        const proxyReq = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: subPath + url.search,
            method: 'GET',
            headers: {
              Accept: req.headers.accept || '*/*',
              'Accept-Language': req.headers['accept-language'] || '',
              Host: `127.0.0.1:${port}`,
            },
          },
          (proxyRes) => {
            const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
            const isHtml = contentType.includes('text/html');

            if (isHtml) {
              // 缓冲 HTML → 注入隐藏滚动条 CSS → 发送
              const chunks: Buffer[] = [];
              proxyRes.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
              proxyRes.on('end', () => {
                let body = Buffer.concat(chunks).toString('utf-8');
                if (body.includes('</head>')) {
                  body = body.replace('</head>', `${HIDE_SCROLLBAR_CSS}\n</head>`);
                } else if (body.includes('</body>')) {
                  body = body.replace('</body>', `${HIDE_SCROLLBAR_CSS}\n</body>`);
                } else {
                  body = HIDE_SCROLLBAR_CSS + body;
                }
                const headers = { ...proxyRes.headers };
                delete headers['content-length'];
                delete headers['content-encoding'];
                delete headers['transfer-encoding'];
                // AI 修改后前端会带新 v= 参数重载,但仍强制 no-cache 防止浏览器复用旧 HTML
                headers['cache-control'] = 'no-cache, no-store, must-revalidate';
                headers['pragma'] = 'no-cache';
                headers['expires'] = '0';
                headers['content-length'] = String(Buffer.byteLength(body, 'utf-8'));
                res.writeHead(proxyRes.statusCode || 200, headers);
                res.end(body);
              });
              proxyRes.on('error', () => {
                if (!res.headersSent) json(res, 502, { error: '预览读取失败' });
              });
            } else {
              // 非 HTML 资源(JS/CSS/图片/SSE)直接透传
              res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
              proxyRes.pipe(res);
            }
          },
        );

        proxyReq.on('error', () => {
          if (!res.headersSent) json(res, 502, { error: '预览服务连接失败' });
        });
        proxyReq.end();
        return;
      }

      // ── GET /api/live-reload (dev 模式前端自动刷新指纹) ────────
      if (req.method === 'GET' && p === '/api/live-reload') {
        if (!IS_DEV) return json(res, 404, { error: 'Not Found' });
        return json(res, 200, { v: `${BOOT_ID}:${await staticFingerprint()}` });
      }

      // ── 静态资源(prod 模式 serve dist-web,dev 交给 Vite)──────
      if (req.method === 'GET') {
        return serveStatic(p, res);
      }

      return json(res, 405, { error: 'Method Not Allowed' });
    } catch (err) {
      console.error('[server] 未捕获错误:', err);
      return json(res, 500, { error: 'Internal Server Error', message: (err as Error).message });
    }
  });

  server.listen(config.port, () => {
    const banner = [
      '',
      '╔══════════════════════════════════════════════════╗',
      '║          📊 AI Office (desktop)                  ║',
      '╠══════════════════════════════════════════════════╣',
      `║  模型:       ${pad(`${config.provider}/${config.modelId}`, 38)}║`,
      `║  LLM 就绪:   ${pad(config.llmReady ? '✅ 是' : '❌ 否(请配置 API Key)', 38)}║`,
      `║  officecli:  ${pad(officecliReady ? '✅ 已安装' : '❌ 未安装', 38)}║`,
      `║  工作区:     ${pad(path.basename(ws.root), 38)}║`,
      `║  地址:       ${pad(`http://localhost:${config.port}`, 38)}║`,
      '╚══════════════════════════════════════════════════╝',
      '',
    ].join('\n');
    console.log(banner);
  });

  let shutdownRunning = false;
  const shutdown = async (sig: string) => {
    if (shutdownRunning) return;
    shutdownRunning = true;
    console.log(`\n[${sig}] 正在关闭...`);
    // 兜底:超过 SHUTDOWN_FORCE_EXIT_MS 仍没正常退出,强制退出避免卡死
    const forceTimer = setTimeout(() => {
      console.warn(`[${sig}] 关闭超时(${SHUTDOWN_FORCE_EXIT_MS}ms),强制退出`);
      process.exit(1);
    }, SHUTDOWN_FORCE_EXIT_MS);
    forceTimer.unref?.();

    try {
      server.closeAllConnections?.();
    } catch {
      // ignore:Node 18+ 才有 closeAllConnections
    }
    try {
      server.close();
    } catch {
      // ignore
    }
    stopAllWatch();
    clearPreviewTokens();
    await Promise.allSettled([...cache.values()].map((rt) => rt.close().catch(() => {})));
    clearTimeout(forceTimer);
    process.exit(0);
  };
  // 统一注册多种关闭信号
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
    process.on(sig, () => void shutdown(sig));
  }
  // 兜底:Node 事件循环清空时若仍有未清理 watch,再做一次尝试
  process.on('beforeExit', () => {
    try {
      stopAllWatch();
    } catch {
      // ignore
    }
  });
}

// ─── 启动时端口占用自动清理辅助 ────────────────────────────────────

/**
 * 检测指定 port 当前是否有进程监听。
 * 如果有,判断它是不是"看起来像 ai-office 后端的旧 Node 进程"(命令行包含 src/server.ts 或 dist/server.js 等特征),
 * 确认是则 SIGTERM → 等待 → SIGKILL 强制终止它,从而把端口让出。
 *
 * 注意:只杀明显匹配"ai-office 后端"特征的进程,避免误杀其他占用了 3001 端口的用户程序。
 */
async function freeUpPortIfOwnedByUs(port: number): Promise<void> {
  if (!port || port <= 0) return;
  const myPid = process.pid;
  const projRoot = path.resolve(__dirname, '..');

  // 1) 先用 lsof 找 LISTEN 该端口的 PID(macOS/Linux 通用;Windows 环境跳过)
  let pidStr: string | null = null;
  try {
    const { stdout } = await execAsync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -F p 2>/dev/null`, { timeout: 3000 });
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p') && /^p\d+$/.test(line)) {
        pidStr = line.slice(1);
        break;
      }
    }
  } catch {
    // 没装 lsof 或失败 → 跳过
    return;
  }
  if (!pidStr) return;
  const pid = Number(pidStr);
  if (!Number.isFinite(pid) || pid <= 1 || pid === myPid) return;

  // 2) 再用 ps 看该 PID 的命令行,确认是"ai-office 自己的旧后端"才动手
  let cmdline = '';
  try {
    const { stdout } = await execAsync(`ps -o command= -p ${pid} 2>/dev/null`, { timeout: 2000 });
    cmdline = stdout.trim();
  } catch {
    return;
  }
  if (!cmdline) return;

  // 特征匹配:命令行中包含项目路径下的 (src/server.ts | dist/server.js | ai-office)
  const normalizedCmd = cmdline.replace(/\\/g, '/');
  const normalizedRoot = projRoot.replace(/\\/g, '/');
  const looksLikeUs =
    /(^|[\\/])src\/server\.ts(\s|$)/.test(normalizedCmd) ||
    /(^|[\\/])dist\/server\.js(\s|$)/.test(normalizedCmd) ||
    (normalizedRoot.length > 4 && normalizedCmd.includes(normalizedRoot)) ||
    /tsx.*server\.ts/.test(normalizedCmd);
  if (!looksLikeUs) {
    console.warn(
      `[server] 端口 ${port} 已被 pid=${pid} 占用,但命令行不像是 ai-office 旧后端,交给系统处理。cmd=${cmdline.slice(0, 120)}`,
    );
    return;
  }

  console.warn(`[server] 端口 ${port} 被 ai-office 旧后端 pid=${pid} 占用,正在主动回收...`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // ignore
  }
  // 等 500ms 给它机会优雅退出
  await new Promise((r) => setTimeout(r, 500));
  try {
    // 如果还活着,补 SIGKILL
    process.kill(pid, 0); // 仅检查是否存在
    process.kill(pid, 'SIGKILL');
  } catch {
    // 已经退出了,OK
  }
  // 再给系统 100ms 释放端口(close → TIME_WAIT 场景下 listen 一般还是能 reuse)
  await new Promise((r) => setTimeout(r, 100));
}

function pad(s: string, n: number): string {
  let width = 0;
  for (const ch of s) width += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - width));
}

// ─── 打开单个文件(返回预览信息)────────────────────────────────────

async function handleFileOpen(
  rawPath: string,
  ws: Workspace,
  officecliReady: boolean,
  res: http.ServerResponse,
) {
  let relPath: string;
  try {
    relPath = decodeURIComponent(rawPath);
    if (!relPath || relPath.includes('\0')) throw new Error('bad path');
  } catch {
    return json(res, 400, { error: '路径参数无效' });
  }
  let abs: string;
  try {
    abs = resolveInWorkspace(ws.root, relPath);
  } catch (e) {
    return json(res, 400, { error: (e as Error).message });
  }
  try {
    if (!(await fs.stat(abs)).isFile()) throw new Error('not a file');
  } catch {
    return json(res, 404, { error: `文件不存在: ${relPath}` });
  }
  const name = path.basename(abs);
  const ext = path.extname(abs).toLowerCase();
  const size = (await fs.stat(abs)).size;

  if (PREVIEW_OFFICE_EXTS.has(ext)) {
    if (!officecliReady) {
      return json(res, 200, {
        kind: 'error',
        path: relPath,
        name,
        ext,
        size,
        message: '预览 Office 文档需要安装 officecli:npm i -g @officecli/officecli 或 brew install officecli',
      });
    }
    try {
      await ensureWatch(abs);
      const token = getOrCreatePreviewToken(abs);
      return json(res, 200, {
        kind: 'office',
        path: relPath,
        name,
        ext,
        size,
        previewUrl: `/api/v1/preview/${token}/`,
      });
    } catch (e) {
      return json(res, 200, { kind: 'error', path: relPath, name, ext, size, message: `预览失败: ${(e as Error).message}` });
    }
  }

  if (PREVIEW_TEXT_EXTS.has(ext)) {
    let content = await fs.readFile(abs, 'utf-8');
    if (content.length > PREVIEW_MAX_CHARS) {
      content = content.slice(0, PREVIEW_MAX_CHARS) + '\n\n[…内容过长,仅显示前 300KB…]';
    }
    return json(res, 200, { kind: 'text', path: relPath, name, ext, size, content });
  }

  if (PREVIEW_IMAGE_EXTS.has(ext)) {
    const data = await fs.readFile(abs);
    return json(res, 200, {
      kind: 'image',
      path: relPath,
      name,
      ext,
      size,
      dataUrl: `data:${MIME[ext] || 'application/octet-stream'};base64,${data.toString('base64')}`,
    });
  }

  if (ext === '.pdf') {
    return json(res, 200, { kind: 'pdf', path: relPath, name, ext, size, url: `/api/v1/file/download?path=${encodeURIComponent(relPath)}` });
  }

  return json(res, 200, {
    kind: 'unsupported',
    path: relPath,
    name,
    ext,
    size,
    message: '该类型暂不支持在线预览,请下载后查看',
  });
}

// ─── 下载工作区文件 ───────────────────────────────────────────────

async function handleFileDownload(rawPath: string, ws: Workspace, res: http.ServerResponse) {
  let relPath: string;
  try {
    relPath = decodeURIComponent(rawPath);
    if (!relPath || relPath.includes('\0')) throw new Error('bad path');
  } catch {
    return json(res, 400, { error: '路径参数无效' });
  }
  let abs: string;
  try {
    abs = resolveInWorkspace(ws.root, relPath);
  } catch (e) {
    return json(res, 400, { error: (e as Error).message });
  }
  try {
    const data = await fs.readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    const filename = path.basename(abs);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': String(data.length),
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
    });
    res.end(data);
  } catch {
    return json(res, 404, { error: `文件不存在: ${relPath}` });
  }
}

// ─── SSE: /api/v1/chat ────────────────────────────────────────────

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: {
    getRuntime: (provider: string, modelId: string, apiKey: string) => Promise<Runtime>;
  },
) {
  const body =
    (await readJson(req).catch(() => null)) as
      | {
          message?: string;
          sessionKey?: string;
          model?: { provider?: string; modelId?: string };
          apiKey?: string;
          filePath?: string;
        }
      | null;
  if (!body || typeof body.message !== 'string' || !body.message.trim()) {
    return json(res, 400, { error: '缺少 message 参数' });
  }
  if (body.message.trim().length > 20000) {
    return json(res, 400, { error: '消息过长(限 20000 字符)' });
  }
  const filePath = typeof body.filePath === 'string' && body.filePath.trim() ? body.filePath.trim() : undefined;

  const { choice, error: modelError } = resolveModelChoice(body.model, body.apiKey);
  if (modelError) return json(res, 400, { error: modelError });

  const msgPreview = body.message.trim().slice(0, 60).replace(/\n/g, ' ');
  const reqId =
    'req_' + (Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4));
  const t0 = Date.now();
  console.log(
    `[chat:${reqId}] ↓ 接收 model=${choice.provider}/${choice.modelId} session=${
      body.sessionKey ?? 'default'
    } file=${filePath ?? '(无)'} message="${msgPreview}${
      body.message.trim().length > 60 ? '…' : ''
    }"`,
  );

  let runtime: Runtime;
  try {
    runtime = await ctx.getRuntime(choice.provider, choice.modelId, choice.apiKey);
  } catch (e) {
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`[chat:${reqId}] ✗ 获取 Runtime 失败 ${dur}s:`, (e as Error).message);
    return json(res, 400, { error: (e as Error).message });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const ac = new AbortController();
  let clientClosed = false;
  req.on('close', () => {
    clientClosed = true;
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.warn(`[chat:${reqId}] 客户端断开 ${dur}s,触发 abort`);
    ac.abort();
  });

  // 追踪事件流:给每个重要事件打点,日志一屏就能看出进度
  const counters = { text: 0, thinking: 0, toolStart: 0, toolEnd: 0, file: 0 };
  const onEvent = (e: OfficeEvent) => {
    switch (e.type) {
      case 'text':
        counters.text += (e.content?.length ?? 0);
        send('delta', { delta: e.content });
        break;
      case 'thinking':
        counters.thinking += (e.content?.length ?? 0);
        send('thinking', { delta: e.content });
        break;
      case 'tool_start':
        counters.toolStart++;
        console.log(`[chat:${reqId}] ⚙ tool_start #${counters.toolStart} ${e.toolName}`);
        send('tool', { state: 'start', toolName: e.toolName });
        break;
      case 'tool_end':
        counters.toolEnd++;
        console.log(
          `[chat:${reqId}] ⚙ tool_end   #${counters.toolEnd} ${e.toolName} ${
            e.isError ? '✗ error' : '✓ ok'
          }`,
        );
        send('tool', { state: 'end', toolName: e.toolName, isError: e.isError });
        break;
      case 'file':
        counters.file++;
        console.log(`[chat:${reqId}] 📄 file modified #${counters.file} ${e.filePath}`);
        send('file', { path: e.filePath, action: 'modified' });
        break;
      case 'warning':
        console.warn(`[chat:${reqId}] ⚠️  runtime warning: ${e.content}`);
        send('warning', { message: e.content });
        break;
      case 'done':
        send('done', {});
        break;
    }
  };

  try {
    await runOfficeAgent(
      { message: body.message.trim(), sessionKey: body.sessionKey, filePath },
      runtime,
      onEvent,
      ac.signal,
    );
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `[chat:${reqId}] ✓ 完成 ${dur}s  events:text=${counters.text}ch thinking=${counters.thinking}ch tools=${counters.toolStart} start/${counters.toolEnd} end files=${counters.file}`,
    );
  } catch (err) {
    const msg = (err as Error).message === 'aborted' ? '客户端已断开' : (err as Error).message;
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    if (msg !== '客户端已断开') {
      console.error(`[chat:${reqId}] ✗ 失败 ${dur}s:`, err);
      send('error', { message: msg });
    } else {
      console.log(`[chat:${reqId}] 中止 ${dur}s: ${msg}`);
    }
  } finally {
    // 兜底:不管哪个路径,确保有一条"结束"日志,避免看起来像还在跑
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `[chat:${reqId}] 连接关闭 ${dur}s${clientClosed ? ' (客户端主动断开)' : ''}`,
    );
  }
}

// ─── 静态资源(prod 模式 serve dist-web)────────────────────────────

const LIVE_RELOAD_SCRIPT = `<script>
(function () {
  var __lr = null;
  function poll() {
    fetch('/api/live-reload', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (__lr && __lr !== d.v) { location.reload(); return; }
        __lr = d.v;
      })
      .catch(function () {})
      .then(function () { setTimeout(poll, 800); });
  }
  poll();
})();
<\/script>`;

async function staticFingerprint(): Promise<string> {
  let entries: string[];
  try {
    entries = (await fs.readdir(STATIC_DIR)).sort();
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const name of entries) {
    try {
      const s = await fs.stat(path.join(STATIC_DIR, name));
      parts.push(`${name}:${s.mtimeMs}:${s.size}`);
    } catch {
      // 忽略被并发删除的文件
    }
  }
  return parts.join('|');
}

async function serveStatic(pathname: string, res: http.ServerResponse) {
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(STATIC_DIR, safe);
  if (filePath === STATIC_DIR || filePath === STATIC_DIR + '/') filePath = path.join(STATIC_DIR, 'index.html');
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    // SPA 回退:未匹配静态文件 → 返回 index.html(前端路由)
    filePath = path.join(STATIC_DIR, 'index.html');
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const headers: Record<string, string> = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (IS_DEV && (ext === '.html' || ext === '.js' || ext === '.css')) {
      headers['Cache-Control'] = 'no-cache';
      if (ext === '.html') {
        const html = data.toString('utf-8');
        const out = html.includes('</body>')
          ? html.replace('</body>', `${LIVE_RELOAD_SCRIPT}\n</body>`)
          : html + LIVE_RELOAD_SCRIPT;
        res.writeHead(200, headers);
        res.end(out);
        return;
      }
    }
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    // dist-web 不存在(开发模式前端由 Vite 托管,后端不 serve 静态)
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found (前端由 Vite 托管,请访问 http://localhost:5173)');
  }
}

// ─── 工具:JSON 读取/响应 ──────────────────────────────────────────

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2_000_000) reject(new Error('body too large')), req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
