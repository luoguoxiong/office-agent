/**
 * 工作区文件级工具:
 *   - file_tree 查:递归目录树(供 Agent 感知 VSCode 风格目录结构)
 *
 * 注:出于安全设计,Agent 仅可修改「当前选中文件」的内容,不支持新增/删除文件,
 * 因此不再提供 file_delete 工具。
 */
import { createTextContent, type Tool } from '@aipack-ai/agent';
import type { Workspace } from '../workspace.js';
import { resolveInWorkspace } from '../workspace.js';
import { buildFileTree, treeToText } from '../file-tree.js';

// ─── 查:file_tree ─────────────────────────────────────────────────

export function createFileTreeTool(ws: Workspace): Tool {
  return {
    name: 'file_tree',
    description:
      '返回工作区递归目录树(文件夹 + 文件,跳过隐藏/.trash/.bak)。' +
      '当用户说"打开 reports 文件夹""列出所有 Excel"或需要感知目录结构时调用。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '可选,只列某子目录(相对工作区,如 "reports")' },
        depth: { type: 'number', description: '可选,递归深度(默认 3,上限 10)' },
      },
    },
    permissions: ['fs:read'],
    async execute(_toolCallId, args) {
      const { dir, depth } = (args ?? {}) as { dir?: string; depth?: number };
      try {
        const targetDepth = Math.min(Math.max(depth ?? 3, 0), 10);
        if (dir) {
          const subAbs = resolveInWorkspace(ws.root, dir);
          const tree = await buildFileTree(subAbs, dir, targetDepth);
          return {
            content: [createTextContent(`目录 ${dir} 树:\n${treeToText(tree)}`)],
            details: { dir, tree },
          };
        }
        const tree = await buildFileTree(ws.root, '', targetDepth);
        return {
          content: [createTextContent(`工作区目录树:\n${treeToText(tree)}`)],
          details: { tree },
        };
      } catch (err) {
        return {
          content: [createTextContent(`[file_tree] ${(err as Error).message}`)],
          details: { error: (err as Error).message },
        };
      }
    },
  };
}

// ─── 删:file_delete 已移除(Agent 不支持删除文件) ──────────────────

/** 汇总导出文件工具集 */
export function createFileTools(ws: Workspace): Tool[] {
  return [createFileTreeTool(ws)];
}
