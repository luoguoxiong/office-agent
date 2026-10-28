/** 编辑器 Tab 栏:多标签切换 + 关闭 + AI 修改标记(黄点)。
 * Tab 数据来自 editorStore;点击文件树文件 → openTab → 这里显示。
 * openFile 请求未返回时也会展示 loading Tab(带 spinner),让用户知道正在加载。 */
import { useEditorStore } from '../../store/editorStore';
import { fileIcon } from '../FileTree/icons';

/** 从路径中提取文件名(最后一段)作为 loading Tab 的占位显示名 */
function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** 从路径提取扩展名(小写,不带点),找不到返回空串 */
function extOf(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf('.');
  return i >= 0 ? b.slice(i + 1).toLowerCase() : '';
}

export function EditorTabs() {
  const tabs = useEditorStore((s) => s.tabs);
  const loadingPaths = useEditorStore((s) => s.loadingPaths);
  const activePath = useEditorStore((s) => s.activePath);
  const setActive = useEditorStore((s) => s.setActive);
  const closeTab = useEditorStore((s) => s.closeTab);

  if (tabs.length === 0 && loadingPaths.length === 0) return null;

  // 合并显示:已有 tabs(真实) + loading 中但还没加入 tabs 的 path(loading 态)
  const loadingPathsNotInTabs = loadingPaths.filter(
    (lp) => !tabs.some((t) => t.path === lp),
  );
  const items: Array<
    | { type: 'tab'; path: string; name: string; ext: string; isActive: boolean; modified?: boolean }
    | { type: 'loading'; path: string; name: string; ext: string; isActive: boolean }
  > = [];
  for (const t of tabs) {
    items.push({
      type: 'tab',
      path: t.path,
      name: t.name,
      ext: t.ext,
      isActive: t.path === activePath,
      modified: !!t.modifiedAt,
    });
  }
  for (const lp of loadingPathsNotInTabs) {
    items.push({
      type: 'loading',
      path: lp,
      name: basename(lp),
      ext: extOf(lp),
      isActive: lp === activePath,
    });
  }

  return (
    <div
      className="flex items-stretch h-9 border-b border-white/5 bg-neutral-850/60 overflow-x-auto no-scrollbar"
      style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' as const }}
    >
      {items.map((item) => {
        const isLoading = item.type === 'loading';
        const baseBtn = `group relative flex items-center gap-1.5 px-3 cursor-pointer border-r border-white/5 text-sm select-none whitespace-nowrap`;
        const activeBtn = item.isActive
          ? 'bg-neutral-900 text-neutral-100'
          : 'bg-transparent text-neutral-400 hover:bg-white/5 hover:text-neutral-200';
        return (
          <div
            key={`${item.type}:${item.path}`}
            onClick={() => setActive(item.path)}
            className={`${baseBtn} ${activeBtn}`}
            title={item.path}
          >
            {/* 活动指示条：底部蓝线 */}
            {item.isActive && (
              <span className="absolute left-0 right-0 bottom-0 h-[2px] bg-blue-500" />
            )}
            {/* 文件图标 / 加载 spinner */}
            {isLoading ? (
              <svg
                className="w-3.5 h-3.5 animate-spin text-blue-400"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden
              >
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="3"
                  className="opacity-25"
                />
                <path
                  d="M22 12a10 10 0 0 1-10 10"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  className="opacity-75"
                />
              </svg>
            ) : (
              <span className="text-xs">{fileIcon(item.ext)}</span>
            )}

            {/* 名称:loading 时半透明 italic */}
            <span
              className={`truncate max-w-[140px] ${isLoading ? 'italic opacity-70' : ''}`}
            >
              {item.name}
              {isLoading && <span className="ml-1 text-[10px] opacity-60">加载中…</span>}
            </span>

            {!isLoading && item.modified && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-amber-400 shadow-[0_0_4px] shadow-amber-400/60"
                title="AI 已修改,预览已刷新"
              />
            )}

            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTab(item.path);
              }}
              className="ml-1 w-4 h-4 flex items-center justify-center rounded hover:bg-white/15 text-neutral-500 hover:text-neutral-100 text-xs opacity-0 group-hover:opacity-100"
              title={isLoading ? '取消加载并关闭' : '关闭'}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
