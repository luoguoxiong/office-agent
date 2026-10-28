/** 左侧文件树:递归 + 懒加载展开 + office 图标。
 * - 目录 children===null 时点击展开向后端请求下一层
 * - 点击文件 → editorStore.openTab
 * - 空工作区/加载中/出错均有提示
 * - 目录 hover 显示操作:新建文件 / 新增文件夹 / 刷新
 * - 新建文件/文件夹弹窗 */
import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { useEditorStore } from '../../store/editorStore';
import { api } from '../../api/client';
import { Dropdown } from '../Dropdown';
import type { TreeNode as TreeNodeType } from '../../types/api';
import { fileIcon, fileColor } from './icons';

/** 文件类型选项(下拉) */
interface FileTypeOption {
  label: string;
  ext: string;
  icon: string;
}
const FILE_TYPE_OPTIONS: FileTypeOption[] = [
  { label: 'Excel 表格 (.xlsx)', ext: 'xlsx', icon: '📊' },
  { label: 'Word 文档 (.docx)', ext: 'docx', icon: '📝' },
  { label: 'PPT 演示 (.pptx)', ext: 'pptx', icon: '📽️' },
  { label: 'Markdown (.md)', ext: 'md', icon: '📘' },
  { label: '纯文本 (.txt)', ext: 'txt', icon: '📃' },
  { label: 'CSV 数据 (.csv)', ext: 'csv', icon: '📊' },
  { label: 'JSON (.json)', ext: 'json', icon: '🔧' },
  { label: '网页 (.html)', ext: 'html', icon: '🌐' },
];

/** 目录节点 hover 时的操作图标栏 */
function DirActions({
  dirPath,
  onNewFile,
  onNewFolder,
  onRefresh,
}: {
  dirPath: string;
  onNewFile: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onRefresh: () => void;
}) {
  const stop = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  return (
    <div
      className="flex items-center gap-0.5 text-neutral-400 hover:text-neutral-100 shrink-0"
      onClick={stop}
    >
      <button
        onClick={(e) => {
          stop(e);
          onNewFile(dirPath);
        }}
        className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/10 transition-colors"
        title="新建文件"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="12" y1="18" x2="12" y2="12" />
          <line x1="9" y1="15" x2="15" y2="15" />
        </svg>
      </button>
      <button
        onClick={(e) => {
          stop(e);
          onNewFolder(dirPath);
        }}
        className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/10 transition-colors"
        title="新增文件夹"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          <line x1="12" y1="11" x2="12" y2="17" />
          <line x1="9" y1="14" x2="15" y2="14" />
        </svg>
      </button>
      <button
        onClick={(e) => {
          stop(e);
          onRefresh();
        }}
        className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/10 transition-colors"
        title="刷新"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      </button>
    </div>
  );
}

/** 递归树节点 */
function TreeNode({
  node,
  depth,
  expanded,
  lazyChildren,
  onToggle,
  onOpenFile,
  activePath,
  hoveredPath,
  setHoveredPath,
  onNewFile,
  onNewFolder,
  onRefresh,
}: {
  node: TreeNodeType;
  depth: number;
  expanded: Set<string>;
  lazyChildren: Map<string, TreeNodeType[]>;
  onToggle: (node: TreeNodeType) => void;
  onOpenFile: (node: TreeNodeType) => void;
  activePath: string | null;
  hoveredPath: string | null;
  setHoveredPath: (p: string | null) => void;
  onNewFile: (dir: string) => void;
  onNewFolder: (dir: string) => void;
  onRefresh: () => void;
}) {
  const isExpanded = expanded.has(node.path);
  const children = lazyChildren.get(node.path) ?? node.children;
  const hasChildren = node.expandable && (children === undefined ? false : children !== null);
  const pad = 8 + depth * 12;
  const isHovered = hoveredPath === node.path;

  if (node.type === 'dir') {
    return (
      <div
        onMouseEnter={() => setHoveredPath(node.path)}
        onMouseLeave={() => {
          if (hoveredPath === node.path) setHoveredPath(null);
        }}
      >
        <div
          onClick={() => onToggle(node)}
          className="w-full flex items-center gap-1 py-[3px] pr-2 text-left hover:bg-white/5 rounded text-sm cursor-pointer group"
          style={{ paddingLeft: pad }}
          title={node.path}
        >
          <span className="text-[10px] w-3 text-neutral-500 shrink-0 transition-transform duration-150 group-hover:text-neutral-300">{isExpanded ? '▼' : '▶'}</span>
          <span className="shrink-0 text-[13px]">{isExpanded ? '📂' : '📁'}</span>
          <span className="text-neutral-200 truncate flex-1 group-hover:text-neutral-100">{node.name}</span>
          <div className={isHovered ? '' : 'opacity-0'}>
            <DirActions
              dirPath={node.path}
              onNewFile={onNewFile}
              onNewFolder={onNewFolder}
              onRefresh={onRefresh}
            />
          </div>
        </div>
        {isExpanded && hasChildren && children && children.length > 0 && (
          <div>
            {children.map((c) => (
              <TreeNode
                key={c.path}
                node={c}
                depth={depth + 1}
                expanded={expanded}
                lazyChildren={lazyChildren}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
                activePath={activePath}
                hoveredPath={hoveredPath}
                setHoveredPath={setHoveredPath}
                onNewFile={onNewFile}
                onNewFolder={onNewFolder}
                onRefresh={onRefresh}
              />
            ))}
          </div>
        )}
        {isExpanded && hasChildren && children && children.length === 0 && (
          <div className="text-xs text-neutral-600 italic py-0.5" style={{ paddingLeft: pad + 24 }}>
            空目录
          </div>
        )}
      </div>
    );
  }

  // 文件节点
  const isActive = activePath === node.path;
  return (
    <button
      onClick={() => onOpenFile(node)}
      className={`w-full flex items-center gap-1.5 py-[3px] pr-2 text-left rounded text-sm ${
        isActive
          ? 'bg-blue-500/15 text-blue-200 border-l-2 border-l-blue-400'
          : 'border-l-2 border-l-transparent hover:bg-white/5'
      }`}
      style={{ paddingLeft: pad + 14 }}
      title={node.path}
    >
      <span className="text-[13px]">{fileIcon(node.ext)}</span>
      <span className={`truncate ${isActive ? 'text-blue-100' : fileColor(node.ext)}`}>{node.name}</span>
    </button>
  );
}

/** 新建文件弹窗 */
function NewFileModal({
  dir,
  onClose,
  onSubmit,
}: {
  dir: string;
  onClose: () => void;
  onSubmit: (name: string, ext: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [typeIdx, setTypeIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const close = () => {
    if (!submitting) onClose();
  };

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请输入文件名');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const opt = FILE_TYPE_OPTIONS[typeIdx];
      await onSubmit(trimmed, opt.ext);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void handleSubmit();
    else if (e.key === 'Escape') close();
  };

  const displayPath = dir ? `${dir}/` : '';
  const opt = FILE_TYPE_OPTIONS[typeIdx];
  const preview = `${name || '文件名'}.${opt.ext}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={close}>
      <div
        className="w-96 bg-neutral-800 border border-neutral-600 rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-neutral-700 flex items-center justify-between">
          <div className="text-sm font-medium text-neutral-100">📄 新建文件</div>
          <button
            onClick={close}
            className="text-neutral-400 hover:text-neutral-100 text-lg leading-none"
            disabled={submitting}
          >
            ×
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="block text-xs text-neutral-400 mb-1">文件类型</label>
            <Dropdown
              value={String(typeIdx)}
              onChange={(v) => setTypeIdx(Number(v))}
              disabled={submitting}
              options={FILE_TYPE_OPTIONS.map((o, i) => ({
                value: String(i),
                label: `${o.icon} ${o.label}`,
              }))}
            />
          </div>
          <div>
            <label className="block text-xs text-neutral-400 mb-1">文件名(不含扩展名)</label>
            <input
              ref={inputRef}
              className="w-full bg-neutral-900 border border-neutral-600 rounded px-2 py-1.5 text-sm text-neutral-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="输入文件名"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={onKey}
              disabled={submitting}
            />
            <div className="mt-1 text-xs text-neutral-500 truncate">
              位置: {displayPath || '(根目录)'}
              <span className="text-neutral-400 ml-1">{preview}</span>
            </div>
          </div>
          {error && <div className="text-xs text-red-400">⚠️ {error}</div>}
        </div>
        <div className="px-4 py-3 border-t border-neutral-700 flex justify-end gap-2 bg-neutral-800/80">
          <button
            onClick={close}
            className="px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700 rounded transition-colors"
            disabled={submitting}
          >
            取消
          </button>
          <button
            onClick={() => void handleSubmit()}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50"
            disabled={submitting}
          >
            {submitting ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 新建文件夹弹窗 */
function NewFolderModal({
  dir,
  onClose,
  onSubmit,
}: {
  dir: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const close = () => {
    if (!submitting) onClose();
  };

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请输入文件夹名称');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void handleSubmit();
    else if (e.key === 'Escape') close();
  };

  const displayPath = dir ? `${dir}/` : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={close}>
      <div
        className="w-96 bg-neutral-800 border border-neutral-600 rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-neutral-700 flex items-center justify-between">
          <div className="text-sm font-medium text-neutral-100">📁 新增文件夹</div>
          <button
            onClick={close}
            className="text-neutral-400 hover:text-neutral-100 text-lg leading-none"
            disabled={submitting}
          >
            ×
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="block text-xs text-neutral-400 mb-1">文件夹名称</label>
            <input
              ref={inputRef}
              className="w-full bg-neutral-900 border border-neutral-600 rounded px-2 py-1.5 text-sm text-neutral-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="输入文件夹名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={onKey}
              disabled={submitting}
            />
            <div className="mt-1 text-xs text-neutral-500 truncate">
              位置: {displayPath || '(根目录)'}
              <span className="text-neutral-400 ml-1">{name || '文件夹名'}/</span>
            </div>
          </div>
          {error && <div className="text-xs text-red-400">⚠️ {error}</div>}
        </div>
        <div className="px-4 py-3 border-t border-neutral-700 flex justify-end gap-2 bg-neutral-800/80">
          <button
            onClick={close}
            className="px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700 rounded transition-colors"
            disabled={submitting}
          >
            取消
          </button>
          <button
            onClick={() => void handleSubmit()}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50"
            disabled={submitting}
          >
            {submitting ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function FileTree() {
  const tree = useWorkspaceStore((s) => s.tree);
  const root = useWorkspaceStore((s) => s.root);
  const loading = useWorkspaceStore((s) => s.loading);
  const error = useWorkspaceStore((s) => s.error);
  const refresh = useWorkspaceStore((s) => s.refresh);
  const createFile = useWorkspaceStore((s) => s.createFile);
  const createDir = useWorkspaceStore((s) => s.createDir);
  const openTab = useEditorStore((s) => s.openTab);
  const activePath = useEditorStore((s) => s.activePath);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [lazyChildren, setLazyChildren] = useState<Map<string, TreeNodeType[]>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const [headerHovered, setHeaderHovered] = useState(false);

  const [newFileForDir, setNewFileForDir] = useState<string | null>(null);
  const [newFolderForDir, setNewFolderForDir] = useState<string | null>(null);

  const onToggle = useCallback(
    async (node: TreeNodeType) => {
      if (node.type !== 'dir') return;
      setLoadError(null);
      const next = new Set(expanded);
      if (next.has(node.path)) {
        next.delete(node.path);
        setExpanded(next);
        return;
      }
      next.add(node.path);
      if (node.children === null && !lazyChildren.has(node.path)) {
        try {
          const res = await api.tree(node.path, 1);
          setLazyChildren((prev) => new Map(prev).set(node.path, res.nodes));
        } catch (e) {
          setLoadError((e as Error).message);
          next.delete(node.path);
        }
      }
      setExpanded(next);
    },
    [expanded, lazyChildren],
  );

  const onOpenFile = useCallback(
    (node: TreeNodeType) => {
      if (node.type !== 'file') return;
      void openTab(node.path);
    },
    [openTab],
  );

  const handleNewFile = useCallback(
    async (name: string, ext: string) => {
      const dir = newFileForDir ?? '';
      const path = await createFile(dir, name, ext);
      // 自动展开所在目录并打开新文件(文本类自动打开,Office 类也尝试打开预览)
      if (dir) {
        const next = new Set(expanded);
        next.add(dir);
        setExpanded(next);
      }
      void openTab(path);
    },
    [newFileForDir, createFile, expanded, openTab],
  );

  const handleNewFolder = useCallback(
    async (name: string) => {
      const dir = newFolderForDir ?? '';
      const path = await createDir(dir, name);
      // 自动展开父目录与新目录
      const next = new Set(expanded);
      if (dir) next.add(dir);
      next.add(path);
      setExpanded(next);
    },
    [newFolderForDir, createDir, expanded],
  );

  const handleRefresh = useCallback(async () => {
    setLoadError(null);
    setLazyChildren(new Map());
    await refresh();
  }, [refresh]);

  let body: ReactNode;
  if (loading) {
    body = (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-neutral-500 animate-fade-in">
        <svg className="w-5 h-5 animate-spin text-blue-400" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
          <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
        </svg>
        <span className="text-xs">加载中…</span>
      </div>
    );
  } else if (error) {
    body = (
      <div className="flex items-start gap-2 m-2 p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-xs animate-fade-in">
        <span>⚠️</span>
        <span className="break-words">{error}</span>
      </div>
    );
  } else if (loadError) {
    body = (
      <div className="flex items-start gap-2 m-2 p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-xs animate-fade-in">
        <span>⚠️</span>
        <span className="break-words">{loadError}</span>
      </div>
    );
  } else if (!root) {
    body = (
      <div className="flex flex-col items-center gap-3 px-4 py-10 text-center animate-fade-in">
        <div className="w-12 h-12 rounded-xl bg-neutral-700/50 flex items-center justify-center text-2xl">📁</div>
        <div className="space-y-1">
          <p className="text-sm text-neutral-300">尚未打开工作区</p>
          <p className="text-xs text-neutral-500 leading-relaxed">点击顶部「打开文件夹」<br />选择一个目录开始</p>
        </div>
      </div>
    );
  } else if (tree.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-2 py-10 text-center text-neutral-500 animate-fade-in">
        <span className="text-2xl opacity-50">📂</span>
        <p className="text-xs">空目录</p>
      </div>
    );
  } else {
    body = tree.map((n) => (
      <TreeNode
        key={n.path}
        node={n}
        depth={0}
        expanded={expanded}
        lazyChildren={lazyChildren}
        onToggle={onToggle}
        onOpenFile={onOpenFile}
        activePath={activePath}
        hoveredPath={hoveredPath}
        setHoveredPath={setHoveredPath}
        onNewFile={(d) => setNewFileForDir(d)}
        onNewFolder={(d) => setNewFolderForDir(d)}
        onRefresh={handleRefresh}
      />
    ));
  }

  return (
    <aside className="w-60 shrink-0 border-r border-white/5 bg-neutral-850/60 flex flex-col min-h-0">
      <div
        className="px-3 h-8 flex items-center justify-between text-[11px] font-semibold text-neutral-400 uppercase tracking-wider border-b border-white/5 surface-gradient"
        onMouseEnter={() => setHeaderHovered(true)}
        onMouseLeave={() => setHeaderHovered(false)}
      >
        <span>资源管理器</span>
        <div className={`transition-opacity duration-150 ${headerHovered ? 'opacity-100' : 'opacity-0'}`}>
          <DirActions
            dirPath=""
            onNewFile={(d) => setNewFileForDir(d)}
            onNewFolder={(d) => setNewFolderForDir(d)}
            onRefresh={handleRefresh}
          />
        </div>
      </div>
      <div className="flex-1 overflow-auto py-1 no-scrollbar">{body}</div>

      {newFileForDir !== null && (
        <NewFileModal
          dir={newFileForDir}
          onClose={() => setNewFileForDir(null)}
          onSubmit={handleNewFile}
        />
      )}
      {newFolderForDir !== null && (
        <NewFolderModal
          dir={newFolderForDir}
          onClose={() => setNewFolderForDir(null)}
          onSubmit={handleNewFolder}
        />
      )}
    </aside>
  );
}
