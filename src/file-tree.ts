/**
 * 递归文件树构建(/workspace/tree API 与 file_tree 工具共用)。
 * 跳过隐藏目录(.trash/.aipack/.git)与 .bak 文件。
 *
 * 懒加载策略:目录节点的 children 在未展开时为 null + expandable=true,
 * 前端点击展开时再请求该子目录下一层。
 */
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';

export type NodeType = 'dir' | 'file';

export interface TreeNode {
  name: string;
  type: NodeType;
  /** 相对工作区路径 */
  path: string;
  /** 仅 file:扩展名(小写,如 .xlsx) */
  ext?: string;
  /** 仅 file:字节大小 */
  size?: number;
  /** 仅 dir:子节点;null 表示未展开(懒加载),[] 表示空目录 */
  children?: TreeNode[] | null;
  /** 是否可展开(目录) */
  expandable?: boolean;
}

const MAX_DEPTH = 10;
const OFFICE_EXTS = new Set(['.xlsx', '.docx', '.pptx']);

/** 跳过隐藏/.trash/.bak/.git */
function shouldSkip(name: string): boolean {
  return name.startsWith('.') || name.endsWith('.bak');
}

/**
 * 构建一层文件树。
 * @param rootAbs 要列出的目录绝对路径
 * @param relBase 该目录相对工作区的路径(根传 '')
 * @param targetDepth 要展开到的深度(0=只列当前层,目录 children=null)
 * @param currentDepth 当前深度(递归用)
 */
export async function buildFileTree(
  rootAbs: string,
  relBase: string,
  targetDepth: number,
  currentDepth: number = 0,
): Promise<TreeNode[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(rootAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  // 目录优先,再按名称排序(中文友好)
  const sorted = entries.slice().sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh');
  });
  const nodes: TreeNode[] = [];
  for (const e of sorted) {
    if (shouldSkip(e.name)) continue;
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      let children: TreeNode[] | null = null;
      if (currentDepth < targetDepth && currentDepth + 1 < MAX_DEPTH) {
        children = await buildFileTree(path.join(rootAbs, e.name), rel, targetDepth, currentDepth + 1);
      }
      nodes.push({ name: e.name, type: 'dir', path: rel, children, expandable: true });
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      let size = 0;
      try {
        size = (await fs.stat(path.join(rootAbs, e.name))).size;
      } catch {
        // 忽略 stat 失败
      }
      nodes.push({ name: e.name, type: 'file', path: rel, ext, size });
    }
  }
  return nodes;
}

/** 判断是否 office 文件 */
export function isOfficeFile(ext: string): boolean {
  return OFFICE_EXTS.has(ext.toLowerCase());
}

/** 把树转成文本(供 LLM 阅读层级结构) */
export function treeToText(nodes: TreeNode[], indent: number = 0): string {
  const pad = '  '.repeat(indent);
  const lines: string[] = [];
  for (const n of nodes) {
    if (n.type === 'dir') {
      lines.push(`${pad}📁 ${n.name}/`);
      if (n.children && n.children.length) {
        lines.push(treeToText(n.children, indent + 1));
      }
    } else {
      const icon = n.ext && isOfficeFile(n.ext) ? '📊' : '📄';
      lines.push(`${pad}${icon} ${n.name}`);
    }
  }
  return lines.join('\n');
}
