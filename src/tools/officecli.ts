/**
 * OfficeCLI(https://github.com/iOfficeAI/OfficeCLI)统一封装。
 * 通过 child_process 调用 officecli 单二进制创建/修改/读取 Office 文档。
 * 无需安装 Office、跨平台(macOS/Linux/Windows)、Apache-2.0。
 * 安装:npm i -g @officecli/officecli 或 brew install officecli
 *
 * 设计:不在代码里写死文档模板,所有增删改查采用「识别意图 → 生成 officecli 参数 → 执行」,
 * 由 LLM 负责生成 commands:
 *   - 读取:officecli view <file> <outline|text> --max-lines N
 *   - 写入:officecli create → batch(JSON 命令数组)→ close
 *
 * 可靠性:
 *  - 用 spawn(而非 promisify execFile)实现:execFile 的 timeout 只抛错不杀进程,
 *    spawn 版超时/出错时显式 SIGTERM→SIGKILL,保证不产生僵尸 officecli 占用文件句柄
 *  - 所有关键路径带日志(可复现性):[officecli:xxx] 开始/结束/耗时/参数(敏感内容截断)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 解析 officecli 二进制路径:
 * 1. 优先从本地 node_modules/@officecli/officecli/vendor/officecli 解析
 * 2. 回退到 PATH 中的全局 officecli
 *
 * 注意:该包 package.json 的 exports 只暴露 "."(lib/install-binary.js),
 * require.resolve('<pkg>/package.json') 会抛 ERR_PACKAGE_PATH_NOT_EXPORTED,
 * 导致打包后(无 node_modules/.bin 加入 PATH)解析失败。改为解析包入口文件,
 * 再向上取包目录定位 vendor 二进制,dev 与打包布局均可用。
 */
export function resolveOfficeCliBin(): string {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@officecli/officecli');
    const pkgDir = path.dirname(path.dirname(entry));
    const pkgJson = path.join(pkgDir, 'package.json');
    const binName = process.platform === 'win32' ? 'officecli.exe' : 'officecli';
    const binPath = path.join(pkgDir, 'vendor', binName);
    if (fs.existsSync(pkgJson) && fs.existsSync(binPath)) return binPath;
  } catch {
    // 本地未安装,回退到 PATH 全局命令
  }
  return 'officecli';
}

const OFFICECLI_BIN = resolveOfficeCliBin();

const RUN_TIMEOUT_MS = 120_000;
/** SIGTERM 后等待多久再 SIGKILL */
const KILL_GRACE_MS = 500;

export class OfficeCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeCliError';
  }
}

/**
 * 可靠终止子进程:SIGTERM → 等待 → SIGKILL 兜底
 */
function killProc(proc: ChildProcess): void {
  try {
    proc.kill('SIGTERM');
  } catch {
    // ignore
  }
  const t = setTimeout(() => {
    try {
      if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, KILL_GRACE_MS);
  t.unref?.();
  proc.once('exit', () => clearTimeout(t));
}

/**
 * 安全运行 officecli 命令:
 *  - 返回 stdout(trim)
 *  - timeout / exitCode≠0 / 信号终止 均抛 OfficeCliError
 *  - 任何异常路径都会显式 kill 子进程(兜底防僵尸)
 *  - 全程带日志
 */
async function runOfficeCli(args: string[]): Promise<string> {
  const label = args[0] ?? 'cmd';
  const t0 = Date.now();
  // 日志中 commands JSON 太长 → 截断到 200 字符
  const loggableArgs = args.map((a) => (a.length > 200 ? a.slice(0, 200) + '…(len=' + a.length + ')' : a));
  console.log(`[officecli:${label}] 开始 → officecli ${loggableArgs.join(' ')}`);

  let proc: ChildProcess | null = null;
  let settled = false;

  const timer = setTimeout(() => {
    if (settled || !proc) return;
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(
      `[officecli:${label}] 超时(${RUN_TIMEOUT_MS}ms/${dur}s),正在终止 officecli 子进程 pid=${proc.pid}`,
    );
    killProc(proc);
  }, RUN_TIMEOUT_MS);
  timer.unref?.();

  try {
    return await new Promise<string>((resolve, reject) => {
      proc = spawn(OFFICECLI_BIN, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d) => (stdout += String(d)));
      proc.stderr?.on('data', (d) => (stderr += String(d)));

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new OfficeCliError(
              '未检测到 officecli,请先安装:npm i -g @officecli/officecli 或在项目中 yarn add @officecli/officecli',
            ),
          );
        } else {
          reject(new OfficeCliError(`启动 officecli 失败: ${err.message}`));
        }
      });
      proc.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const dur = ((Date.now() - t0) / 1000).toFixed(1);
        const stderrTrim = stderr.trim();
        const stdoutTrim = stdout.trim();
        if (code === 0 && !signal) {
          console.log(`[officecli:${label}] ✓ 成功 ${dur}s, stdout=${stdoutTrim.length}ch`);
          resolve(stdoutTrim);
        } else {
          const reason = signal
            ? `被信号 ${signal} 终止`
            : `退出码 ${code}`;
          console.error(
            `[officecli:${label}] ✗ 失败 ${dur}s, ${reason}. stderr=${stderrTrim.slice(0, 500) || '(空)'}`,
          );
          reject(
            new OfficeCliError(
              `officecli ${label} 失败: ${reason}. ${stderrTrim || stdoutTrim || '(无输出)'}`,
            ),
          );
        }
      });
    });
  } finally {
    if (!settled && proc) killProc(proc);
  }
}

/** officecli 是否已安装 —— 单独实现(避免递归,失败立刻返回 false) */
export async function officecliAvailable(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const proc = spawn(OFFICECLI_BIN, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    const t = setTimeout(() => {
      killProc(proc);
      resolve(false);
    }, 8000);
    t.unref?.();
    proc.on('error', () => {
      clearTimeout(t);
      resolve(false);
    });
    proc.on('close', (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
  });
}

/** 创建空白文档并释放驻留(create 会驻留后台进程,须 close 才能让其他程序安全读取文件) */
export async function officeCreateClose(abs: string): Promise<void> {
  await runOfficeCli(['create', abs]);
  await runOfficeCli(['close', abs]).catch(() => {});
}

/** 批量执行命令(单次 open→apply→save 周期)后刷盘 */
async function officeBatchClose(abs: string, commands: object[]): Promise<string> {
  const out = await runOfficeCli(['batch', abs, '--commands', JSON.stringify(commands)]);
  await runOfficeCli(['close', abs]).catch(() => {});
  return out;
}

/**
 * 读取文档内容(officecli view):
 *   - xlsx → text(单元格文本)
 *   - docx/pptx → outline(结构大纲)
 * maxLines 限制输出行数,大文档按行截断。
 */
export async function officeReadDocument(
  abs: string,
  opts?: { mode?: 'outline' | 'text'; maxLines?: number },
): Promise<string> {
  const mode = opts?.mode ?? (path.extname(abs).toLowerCase() === '.xlsx' ? 'text' : 'outline');
  const maxLines = opts?.maxLines ?? 60;
  return await runOfficeCli(['view', abs, mode, '--max-lines', String(maxLines)]);
}

/**
 * 查询 OfficeCLI 能力参考(officecli help):schema 驱动、随版本自动更新。
 * 不传 topic:返回该格式全部元素清单;传 topic:返回元素/操作完整语法。
 */
export async function officeHelp(format: 'xlsx' | 'docx' | 'pptx', topic?: string): Promise<string> {
  return await runOfficeCli(['help', format, ...(topic ? [topic] : [])]);
}

export interface OfficeBatchCommand {
  /** 操作:add 新增 / set 修改 / remove 删除 */
  command: 'add' | 'set' | 'remove';
  /** DOM 路径:set/remove 必填,add 可用作 parent 兜底 */
  path?: string;
  /** 父路径:add 必填 */
  parent?: string;
  /** 元素类型:add 必填 */
  type?: string;
  props?: Record<string, unknown>;
}

/**
 * 执行 officecli batch 脚本(单次 open→apply→save 周期)。
 * create=true 时先创建空文档,再执行命令。返回执行摘要。
 */
export async function officeExecuteScript(
  abs: string,
  commands: OfficeBatchCommand[],
  opts: { create?: boolean } = {},
): Promise<string> {
  const fileLabel = path.basename(abs);
  const n = commands.length;
  const createFlag = opts.create ? ' create' : '';
  console.log(`[officecli:exec] ${fileLabel}${createFlag} commands=${n}`);
  const t0 = Date.now();
  try {
    if (opts.create) {
      await officeCreateClose(abs);
    }
    const summary = await officeBatchClose(abs, commands as object[]);
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[officecli:exec] ✓ ${fileLabel} 完成 commands=${n} ${dur}s`);
    return summary;
  } catch (e) {
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`[officecli:exec] ✗ ${fileLabel} 失败 commands=${n} ${dur}s:`, (e as Error).message);
    throw e;
  }
}
