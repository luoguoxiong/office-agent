/**
 * Office 文档「所见即所得」预览:基于 OfficeCLI 的 `watch` 子命令。
 *
 * `officecli watch <file> --port <port>` 启动一个 HTTP 预览服务器,
 * 渲染效果与 Office/LibreOffice 一致(xlsx 表格、docx 排版、pptx 幻灯片),
 * 页面无 X-Frame-Options,可被 iframe 嵌入。文档被 officecli 修改后预览页会自动刷新。
 *
 * 进程池管理:
 *   - 按文件路径缓存 watch 进程,重复预览复用端口
 *   - 动态分配空闲端口,支持多文件同时预览(多 Tab)
 *   - LRU 上限(默认 4),超出时关闭最久未用的进程
 *   - stopAllWatch() 供工作区切换 / 服务关闭时统一清理
 *   - 启动时自动清理上一次残留的 officecli watch 进程(避免重启后端口占用/僵尸进程)
 */
import { spawn, type ChildProcess, exec } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveOfficeCliBin } from './tools/officecli.js';

const OFFICECLI_BIN = resolveOfficeCliBin();
const execAsync = promisify(exec);
const WATCH_MAX = 4; // 同时保留的最大 watch 进程数(超出按 LRU 关闭)
const WATCH_START_TIMEOUT_MS = 15_000;
/** SIGTERM 后最多等待多少毫秒再 SIGKILL */
const KILL_GRACE_MS = 400;

interface WatchEntry {
  port: number;
  proc: ChildProcess;
  lastUsed: number;
}

const watchCache = new Map<string, WatchEntry>();
/** 正在启动中的 watch 进程(abs → Promise<port>),避免同一文件并发启动多个 watch */
const pendingWatch = new Map<string, Promise<number>>();

/** 找本机一个空闲端口 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 可靠地终止一个子进程:SIGTERM → 等待 → SIGKILL 兜底。
 * 同时对 officecli vendor 的嵌套孙进程也尝试用 officecli unwatch 优雅释放。
 */
function killProcessTree(entry: { proc: ChildProcess; abs?: string }): void {
  const { proc, abs } = entry;
  // 1) 先尝试 officecli unwatch(优雅关闭,释放文件句柄)
  if (abs) {
    try {
      spawn(OFFICECLI_BIN, ['unwatch', abs], { stdio: 'ignore' }).unref();
    } catch {
      // ignore
    }
  }

  // 2) 发 SIGTERM(允许子进程做收尾)
  try {
    proc.kill('SIGTERM');
  } catch {
    // ignore
  }

  // 3) 若 KILL_GRACE_MS 后还活着,升级为 SIGKILL
  const timer = setTimeout(() => {
    try {
      if (proc.exitCode === null && !proc.killed) {
        proc.kill('SIGKILL');
      }
    } catch {
      // ignore
    }
  }, KILL_GRACE_MS);
  timer.unref?.();

  proc.once('exit', () => clearTimeout(timer));
}

function stopWatch(abs: string) {
  const entry = watchCache.get(abs);
  if (!entry) return;
  watchCache.delete(abs);
  killProcessTree({ proc: entry.proc, abs });
}

/**
 * 启动时清理残留的 officecli watch 进程:
 *   - 遍历所有命令行包含 "officecli watch" 的进程
 *   - 不属于当前 Node 进程组的,一律杀掉(正常情况下所有 watch 都应该是本后端起的子进程)
 * 这个函数只在后端刚启动时调用一次,用于清理上次异常退出残留的僵尸进程。
 */
export async function cleanupStaleOfficecliWatches(): Promise<void> {
  try {
    const myPid = process.pid;
    // macOS / Linux 通用:ps -ax -o pid=,ppid=,command=
    let out: { stdout: string };
    try {
      out = await execAsync('ps -axo pid=,ppid=,command=', { timeout: 5000 });
    } catch {
      return;
    }
    const candidates: Array<{ pid: number; ppid: number; cmd: string }> = [];
    for (const line of out.stdout.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      const m = s.match(/^(\d+)\s+(\d+)\s+([\s\S]*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      const cmd = m[3];
      if (pid === myPid || ppid === myPid) continue; // 自己或自己的子进程跳过(它们是 watchCache 管的)
      // 匹配 officecli watch <path> --port <n> 或 vendor/officecli watch
      if (/officecli(\s+vendor\/officecli)?\s+watch\s+/i.test(cmd)) {
        candidates.push({ pid, ppid, cmd });
      }
    }
    if (candidates.length === 0) return;
    console.warn(
      `[preview] 检测到 ${candidates.length} 个残留 officecli watch 进程,正在清理:`,
      candidates.map((c) => `pid=${c.pid} ${c.cmd.slice(0, 80)}`).join(' | '),
    );
    // 先 TERM,再 KILL
    for (const c of candidates) {
      try {
        process.kill(c.pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
    await new Promise((r) => setTimeout(r, KILL_GRACE_MS + 100));
    for (const c of candidates) {
      try {
        process.kill(c.pid, 'SIGKILL');
      } catch {
        // ignore:可能已经自行退出
      }
    }
  } catch (e) {
    // 清理失败不影响启动:只打日志
    console.warn('[preview] 清理残留 officecli watch 进程失败(忽略):', (e as Error).message);
  }
}

/**
 * 确保目标文件有运行的 watch 预览进程,返回其预览端口。
 * 已缓存则直接复用;否则启动新进程并等待就绪。
 */
export async function ensureWatch(abs: string): Promise<number> {
  const cached = watchCache.get(abs);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.port;
  }

  // 复用正在启动中的 Promise,避免同一文件并发启动多个 watch 进程
  // (场景:office_exec 写后异步 ensureWatch,同时 SSE file 事件触发前端重载
  //  → 反代再次 ensureWatch;两次调用应共享同一个启动过程)
  const pending = pendingWatch.get(abs);
  if (pending) return pending;

  const p = (async () => {
    try {
      // LRU:超过上限时关闭最久未用的
      if (watchCache.size >= WATCH_MAX) {
        let oldest: [string, WatchEntry] | null = null;
        for (const [k, v] of watchCache) {
          if (!oldest || v.lastUsed < oldest[1].lastUsed) oldest = [k, v];
        }
        if (oldest) stopWatch(oldest[0]);
      }

      const port = await findFreePort();
      const proc = spawn(OFFICECLI_BIN, ['watch', abs, '--port', String(port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const entry: WatchEntry = { port, proc, lastUsed: Date.now() };
      watchCache.set(abs, entry);

      proc.stderr.on('data', (d) => {
        const s = String(d).trim();
        if (s) console.error(`[watch:${path.basename(abs)}] ${s}`);
      });
      proc.on('exit', () => {
        if (watchCache.get(abs) === entry) watchCache.delete(abs);
      });

      // 等待 stdout 输出 "Watch: http://localhost:<port>" 确认就绪
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          stopWatch(abs);
          reject(new Error('officecli watch 启动超时'));
        }, WATCH_START_TIMEOUT_MS);
        const onData = (d: Buffer) => {
          const s = String(d);
          if (s.includes(`http://localhost:${port}`) || s.includes(`http://127.0.0.1:${port}`)) {
            clearTimeout(timer);
            proc.stdout?.off('data', onData);
            resolve();
          }
        };
        proc.stdout?.on('data', onData);
        proc.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`officecli watch 意外退出,code=${code}`));
        });
      });

      return port;
    } finally {
      pendingWatch.delete(abs);
    }
  })();
  pendingWatch.set(abs, p);
  return p;
}

/** 停止单个文件的 watch 进程 */
export function stopWatchByPath(abs: string): void {
  stopWatch(abs);
}

/** 停止所有 watch 进程(工作区切换 / 服务关闭时调用) */
export function stopAllWatch(): void {
  for (const abs of [...watchCache.keys()]) stopWatch(abs);
}
