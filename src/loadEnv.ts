/**
 * ai-office 后端 .env 加载器(零依赖,Node 原生不读取 .env)。
 * 启动时从本模块所在目录向上查找 .env,解析后注入 process.env。
 * 优先级:真实 shell 环境变量 > .env 文件 > 默认值(已存在的 env 不被覆盖)。
 * 支持:注释、空行、export 前缀、单/双引号、双引号内 \n 转义、行内 # 注释。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 从当前目录向上查找 .env,最多回溯 5 层;失败时回退到 AI_OFFICE_ENV_DIR(打包运行由宿主指定) */
function findEnvFile(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 打包运行:.env 不在 dist/ 上层,改从宿主配置目录加载(如 ~/Library/Application Support/com.aipack.aioffice/.env)
  const envDir = process.env.AI_OFFICE_ENV_DIR;
  if (envDir) {
    const candidate = path.join(envDir, '.env');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function parseLine(line: string): [string, string] | null {
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed.trim() || trimmed.trim().startsWith('#')) return null;
  const m = trimmed.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) return null;
  const key = m[1];
  let value = m[2];
  if (!value.startsWith('"') && !value.startsWith("'")) {
    const hashIdx = value.indexOf(' #');
    if (hashIdx !== -1) value = value.slice(0, hashIdx);
    value = value.trim();
  } else {
    const quote = value[0];
    const end = value.lastIndexOf(quote);
    if (end > 0) {
      let inner = value.slice(1, end);
      if (quote === '"') {
        inner = inner
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\r/g, '\r')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
      value = inner;
    }
  }
  return [key, value];
}

export function loadEnvFile(): { loaded: number; path: string | null } {
  const file = findEnvFile();
  if (!file) return { loaded: 0, path: null };
  let content: string;
  try {
    content = readFileSync(file, 'utf-8');
  } catch (err) {
    console.warn(`[loadEnv] 读取 ${file} 失败:`, (err as Error).message);
    return { loaded: 0, path: file };
  }
  let loaded = 0;
  for (const line of content.split('\n')) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded++;
    }
  }
  return { loaded, path: file };
}

// 副作用:模块加载时即执行
const result = loadEnvFile();
if (result.loaded > 0) {
  console.log(`[loadEnv] 已从 ${result.path} 加载 ${result.loaded} 个环境变量`);
}
