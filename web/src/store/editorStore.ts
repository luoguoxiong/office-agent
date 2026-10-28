/** 多 Tab 编辑器状态(打开/切换/关闭 office 文件,预览刷新标记) */
import { create } from 'zustand';
import { api } from '../api/client';
import type { Tab, FileOpenResponse } from '../types/api';

interface EditorState {
  tabs: Tab[];
  activePath: string | null;
  /** 正在执行 openFile 请求的路径集合;UI 可据此展示 loading Tab / 预览 loading */
  loadingPaths: string[];
  /** 打开文件(已存在则激活,否则新建 Tab) */
  openTab: (path: string) => Promise<void>;
  closeTab: (path: string) => void;
  setActive: (path: string) => void;
  /** 标记文件被 AI 修改(供预览刷新) */
  markModified: (path: string) => void;
  /** 切换工作区时清空所有 Tab */
  closeAll: () => void;
}

function toTab(res: FileOpenResponse): Tab {
  return {
    path: res.path,
    name: res.name,
    ext: res.ext,
    kind: res.kind,
    previewUrl: res.previewUrl,
    content: res.content,
    dataUrl: res.dataUrl,
    url: res.url,
    message: res.message,
  };
}

/** 防止重复点击时并发多次 openFile:维护正在加载中的 path 集合(store 外层闭包,跨调用共享) */
const _openingSet = new Set<string>();
/** 把 _openingSet 转成新数组用于更新 zustand state(保证引用变化触发订阅) */
const snapshotLoading = (): string[] => Array.from(_openingSet);

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activePath: null,
  loadingPaths: [],
  openTab: async (path) => {
    // 1) 已在 tabs 中 → 直接切换激活
    if (get().tabs.some((t) => t.path === path)) {
      set({ activePath: path });
      return;
    }
    // 2) 已在加载中(第一次点击的请求还没返回) → 只激活,不再重复请求
    if (_openingSet.has(path)) {
      set({ activePath: path });
      return;
    }

    _openingSet.add(path);
    // 立即同步 loadingPaths,让 UI 第一时间显示 loading
    set({ loadingPaths: snapshotLoading(), activePath: path });
    try {
      const res = await api.openFile(path);
      // 3) 请求返回后再次检查:异步等待期间可能已有其他逻辑写入
      set((s) => {
        if (s.tabs.some((t) => t.path === path)) {
          return { activePath: path };
        }
        return { tabs: [...s.tabs, toTab(res)], activePath: path };
      });
    } finally {
      _openingSet.delete(path);
      set({ loadingPaths: snapshotLoading() });
    }
  },
  closeTab: (path) =>
    set((s) => {
      // 加载中就关闭 → 释放 loading 标记
      if (_openingSet.has(path)) _openingSet.delete(path);
      const tabs = s.tabs.filter((t) => t.path !== path);
      const activePath =
        s.activePath === path ? (tabs[tabs.length - 1]?.path ?? null) : s.activePath;
      return { tabs, activePath, loadingPaths: snapshotLoading() };
    }),
  setActive: (path) => set({ activePath: path }),
  markModified: (path) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, modifiedAt: Date.now() } : t)),
    })),
  closeAll: () => {
    _openingSet.clear();
    set({ tabs: [], activePath: null, loadingPaths: [] });
  },
}));
