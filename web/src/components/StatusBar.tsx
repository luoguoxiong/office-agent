/** 底部状态栏:工作区 / 模型 / LLM 状态
 *  LLM 就绪状态不再依赖后端 llmReady(后端不读 env Key),而是按前端是否已填 Key + 已选模型判断
 */
import { useWorkspaceStore } from '../store/workspaceStore';
import { useSettingsStore } from '../store/settingsStore';

export function StatusBar() {
  const name = useWorkspaceStore((s) => s.name);
  const activeModel = useSettingsStore((s) => {
    const m = s.models.find((x) => x.id === s.activeModelId);
    return m ?? null;
  });

  // 前端侧的 LLM 就绪标志:已选 active 模型 + 该模型已填非空 Key
  const llmReadyLocal = !!activeModel?.provider && !!activeModel?.modelId && !!activeModel?.apiKey?.trim();
  const modelDisplay = activeModel
    ? `${activeModel.name} (${activeModel.provider}/${activeModel.modelId})`
    : '未选择';

  return (
    <div className="h-6 flex items-center px-3 gap-3 bg-neutral-850/80 border-t border-white/5 text-[11px] text-neutral-400 select-none">
      <span className="flex items-center gap-1.5 min-w-0">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-500 shrink-0">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span className="truncate max-w-[180px]" title={name || ''}>{name || '-'}</span>
      </span>

      <span className="w-px h-3 bg-white/10" />

      <span className="flex items-center gap-1.5 min-w-0" title={modelDisplay}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-500 shrink-0">
          <rect x="3" y="11" width="18" height="10" rx="2" />
          <circle cx="12" cy="5" r="2" />
          <path d="M12 7v4" />
          <line x1="8" y1="16" x2="8" y2="16" />
          <line x1="16" y1="16" x2="16" y2="16" />
        </svg>
        <span className="truncate max-w-[160px]">{modelDisplay}</span>
      </span>

      <div className="flex-1" />

      <span className={`flex items-center gap-1.5 ${llmReadyLocal ? 'text-green-400' : 'text-amber-400'}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${llmReadyLocal ? 'bg-green-400' : 'bg-amber-400'} ${llmReadyLocal ? '' : 'animate-pulse'}`} />
        <span>LLM {llmReadyLocal ? '就绪' : '未就绪'}</span>
      </span>
    </div>
  );
}
