/** 工作区 + 文件树状态 */
import { create } from 'zustand';
import { api } from '../api/client';
import type { TreeNode } from '../types/api';

interface WorkspaceState {
  root: string;
  name: string;
  tree: TreeNode[];
  loading: boolean;
  error: string | null;
  /** 启动时加载当前工作区 + 根层文件树 */
  init: () => Promise<void>;
  /** 切换工作区(打开文件夹) */
  openFolder: (path: string) => Promise<void>;
  /** 替换文件树(子目录懒加载展开时用) */
  setTree: (tree: TreeNode[]) => void;
  /** 刷新根文件树 */
  refresh: () => Promise<void>;
  /** 新建文件,返回创建后的相对路径 */
  createFile: (dir: string, name: string, ext?: string) => Promise<string>;
  /** 新建文件夹,返回创建后的相对路径 */
  createDir: (dir: string, name: string) => Promise<string>;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  root: '',
  name: '',
  tree: [],
  loading: false,
  error: null,
  init: async () => {
    try {
      const ws = await api.workspace();
      set({ root: ws.root, name: ws.name });
      const treeRes = await api.tree('', 1);
      set({ tree: treeRes.nodes });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
  openFolder: async (path) => {
    set({ loading: true, error: null });
    try {
      const res = await api.openWorkspace(path);
      set({ root: res.root, name: res.name, tree: res.tree, loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },
  setTree: (tree) => set({ tree }),
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const treeRes = await api.tree('', 1);
      set({ tree: treeRes.nodes, loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },
  createFile: async (dir, name, ext) => {
    const res = await api.createFile({ dir: dir || undefined, name, ext });
    // 新建后刷新文件树
    await get().refresh();
    return res.path;
  },
  createDir: async (dir, name) => {
    const res = await api.createDir({ dir: dir || undefined, name });
    // 新建后刷新文件树
    await get().refresh();
    return res.path;
  },
}));
