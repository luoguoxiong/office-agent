/** 顶栏:打开文件夹 + 工作区名(阶段 G 加模型选择/设置) */
import { pickWorkspaceDir, isTauri } from '../api/client';
import { useWorkspaceStore } from '../store/workspaceStore';

export function TopBar() {
  const name = useWorkspaceStore((s) => s.name);
  const loading = useWorkspaceStore((s) => s.loading);
  const openFolder = useWorkspaceStore((s) => s.openFolder);

  const handleOpen = async () => {
    if (isTauri()) {
      const path = await pickWorkspaceDir();
      if (path) await openFolder(path);
    } else {
      // 浏览器模式:手动输入路径
      const path = window.prompt('浏览器模式:请输入文件夹绝对路径', '');
      if (path && path.trim()) await openFolder(path.trim());
    }
  };

  return (
    <div className="h-11 flex items-center px-3 gap-3 bg-neutral-850/80 surface-gradient border-b border-white/5 text-neutral-200 select-none backdrop-blur-sm">
      {/* 品牌区 */}
      <div className="flex items-center gap-2 pr-2">
        <div className="w-6 h-6 rounded-md bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center shadow-sm shadow-blue-500/30">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </div>
        <span className="text-sm font-semibold text-neutral-100 tracking-tight">AI Office</span>
      </div>

      <div className="w-px h-5 bg-white/10" />

      <button
        onClick={handleOpen}
        disabled={loading}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium shadow-sm shadow-blue-600/20"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={loading ? 'animate-spin' : ''}>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        {loading ? '加载中…' : '打开文件夹'}
      </button>

      <span className="text-sm text-neutral-400 truncate flex items-center gap-1.5 min-w-0">
        {name ? (
          <>
            <span className="text-neutral-600">/</span>
            <span className="truncate text-neutral-300" title={name}>{name}</span>
          </>
        ) : (
          <span className="text-neutral-500 italic">(未选择工作区)</span>
        )}
      </span>
    </div>
  );
}
