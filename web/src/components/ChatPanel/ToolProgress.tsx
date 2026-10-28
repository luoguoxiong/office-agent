/** 工具执行进度指示器:SSE tool 事件 → 小标签显示 start(蓝)/end(绿/红)。
 * 通常嵌套在 assistant 消息底部。 */
import type { ToolEvent } from '../../types/chat';

function toolLabel(name: string): string {
  // 把工具名映射成更友好的展示名
  const map: Record<string, string> = {
    office_read: '读取 Office',
    office_help: '查询命令',
    office_exec: '修改 Office',
    file_tree: '浏览目录',
  };
  return map[name] ?? name;
}

export function ToolProgress({ events }: { events: ToolEvent[] }) {
  if (!events || events.length === 0) return null;
  // 仅显示最新的 6 个(避免长历史过多干扰)
  const recent = events.slice(-6);
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {recent.map((ev, i) => {
        const running = ev.state === 'start';
        const bad = ev.state === 'end' && ev.isError;
        const ok = ev.state === 'end' && !ev.isError;
        return (
          <span
            key={i}
            className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border font-mono ${
              running
                ? 'bg-blue-500/15 text-blue-300 border-blue-500/40'
                : bad
                  ? 'bg-red-500/15 text-red-300 border-red-500/40'
                  : ok
                    ? 'bg-green-500/15 text-green-300 border-green-500/40'
                    : 'bg-neutral-700/50 text-neutral-300 border-neutral-600'
            }`}
          >
            {running ? (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="animate-spin">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : bad ? (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : ok ? (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : null}
            {toolLabel(ev.toolName)}
          </span>
        );
      })}
    </div>
  );
}
