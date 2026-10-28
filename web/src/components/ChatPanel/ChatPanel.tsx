/** 聊天面板主容器:三栏布局最右侧。
 * - 把 editorStore 的 activePath 作为上下文(filePath)注入到发送请求
 * - 依赖 chatStore 的 send() 走 SSE 流式(已在 store 内部处理 tool→file→editorStore.markModified 链路)
 * - 多模型:下拉从已保存配置切换,「🧰」按钮打开模型配置管理器(添加/编辑/删除)
 * - 多会话:按 activePath 自动切换独立上下文(每个文件独立聊天历史 + LLM 记忆)
 */
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { ModelManager } from './ModelManager';
import { useChatStore, fileSessionKey, GLOBAL_SESSION_KEY } from '../../store/chatStore';
import { useEditorStore } from '../../store/editorStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useEffect, useState } from 'react';

/** 聊天面板主容器 */
export function ChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const error = useChatStore((s) => s.error);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const clear = useChatStore((s) => s.clear);
  const switchSession = useChatStore((s) => s.switchSession);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const sessionCount = useChatStore((s) => Object.keys(s.sessionBuckets).length);

  const activePath = useEditorStore((s) => s.activePath);
  const activeTab = useEditorStore((s) => s.tabs.find((t) => t.path === activePath));

  // 多模型相关
  const savedModels = useSettingsStore((s) => s.models);
  const activeModelId = useSettingsStore((s) => s.activeModelId);
  const setActiveModelId = useSettingsStore((s) => s.setActiveModel);
  const [showManager, setShowManager] = useState(false);
  const activeModel = savedModels.find((m) => m.id === activeModelId) ?? null;

  // ⭐️ activePath 变化 → 自动切换到对应文件的独立会话上下文
  useEffect(() => {
    const key = fileSessionKey(activePath);
    switchSession(key);
  }, [activePath, switchSession]);

  const handleSend = (text: string) => {
    void send(text, activePath ?? undefined);
  };

  // 会话归属提示文本
  const sessionHint =
    currentSessionKey === GLOBAL_SESSION_KEY
      ? '💬 当前会话: 通用(未绑定文件,所有文件共享)'
      : activeTab
        ? `💬 当前会话:「${activeTab.name}」(${activePath})  — 独立上下文`
        : `💬 当前会话: ${currentSessionKey}  — 独立上下文`;

  return (
    <aside className="relative w-96 shrink-0 border-l border-white/5 bg-neutral-850/60 flex flex-col min-h-0">
      {/* 头部:标题 + 清空(模型切换已移至底部工具栏) */}
      <div className="flex items-center px-3 h-10 border-b border-white/5 gap-2 shrink-0 surface-gradient">
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 shadow-[0_0_4px] shadow-green-400/60" />
          <span className="text-sm font-semibold text-neutral-100">AI 助手</span>
        </div>
        <div className="flex-1" />
        <button
          onClick={clear}
          disabled={streaming}
          className="inline-flex items-center justify-center text-xs w-7 h-7 rounded-md hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed text-neutral-400 hover:text-neutral-200"
          title="清空对话"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>

      {/* 会话归属提示(文件上下文隔离提示) */}
      <div className="shrink-0 px-3 h-7 border-b border-white/5 bg-neutral-900/30 flex items-center justify-between gap-2">
        <span
          className="text-[11px] truncate flex items-center gap-1.5 min-w-0"
          title={sessionHint}
        >
          {currentSessionKey === GLOBAL_SESSION_KEY ? (
            <>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-500 shrink-0">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <span className="text-neutral-500">通用会话</span>
            </>
          ) : (
            <>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400 shrink-0">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span className="text-neutral-500">上下文:</span>
              <span className="text-neutral-300 truncate">
                {activeTab?.name ?? activePath ?? currentSessionKey}
              </span>
            </>
          )}
        </span>
        <span
          className="text-[10px] text-neutral-600 shrink-0 tabular-nums"
          title={`已保存 ${sessionCount} 个会话上下文`}
        >
          {sessionCount} 会话
        </span>
      </div>

      {/* 消息列表(占满剩余空间,可滚动) */}
      <MessageList messages={messages} streaming={streaming} />

      {/* 输入区 */}
      <Composer
        onSend={handleSend}
        onStop={stop}
        streaming={streaming}
        error={error}
        activeFilePath={activePath}
        activeFileName={activeTab?.name}
        activeFileExt={activeTab?.ext}
        onToggleSettings={() => setShowManager((v) => !v)}
        settingsOpen={showManager}
        models={savedModels}
        activeModelId={activeModelId}
        onSelectModel={setActiveModelId}
      />

      {/* 模型配置面板(从最底部弹起,向上展开) */}
      {showManager && (
        <>
          {/* 点击遮罩关闭(盖住面板上方区域) */}
          <div
            className="absolute inset-0 z-20"
            onClick={() => setShowManager(false)}
          />
          <div className="absolute left-0 right-0 bottom-0 z-30">
            <ModelManager onClose={() => setShowManager(false)} />
          </div>
        </>
      )}
    </aside>
  );
}
