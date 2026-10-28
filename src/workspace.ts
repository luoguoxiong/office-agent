/**
 * ai-office 文件工作区:所有工具读写限制在工作区内,防 LLM 越权访问磁盘任意位置。
 * 约定:
 *   - 工具参数一律传「相对工作区」路径,如 "report.xlsx"
 *   - resolveInWorkspace 拒绝绝对路径与 .. 逃逸
 *   - 覆盖写前自动备份为 {file}.bak
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';

export interface Workspace {
  readonly root: string;
}

/** 创建(确保存在)工作区目录,初始化 .trash 回收站 */
export async function createWorkspace(root: string): Promise<Workspace> {
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, '.trash'), { recursive: true });
  return { root };
}

/** 将相对路径解析为工作区内绝对路径,越界(绝对路径 / .. 逃逸)时抛错 */
export function resolveInWorkspace(root: string, relPath: string): string {
  const normalized = path.normalize(relPath || '').replace(/^[/\\]+/, '');
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new Error(`非法文件路径: "${relPath}"`);
  }
  const abs = path.resolve(root, normalized);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径越界,只允许工作区内路径: "${relPath}"`);
  }
  return abs;
}

/** 覆盖写前备份为 {file}.bak(文件不存在则跳过) */
export async function backupFile(filePath: string): Promise<void> {
  try {
    await fs.copyFile(filePath, `${filePath}.bak`);
  } catch {
    // 原文件不存在 → 首次创建,无需备份
  }
}

/** 确保文件父目录存在(写工具落盘前调用) */
export async function ensureDirForFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function assertExists(filePath: string): Promise<void> {
  if (!(await exists(filePath))) {
    throw new Error(`文件不存在: "${path.basename(filePath)}"`);
  }
}
