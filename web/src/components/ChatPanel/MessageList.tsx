/** 消息列表:滚动 + 流式时自动滚到底部,空状态显示引导。
 * - 流式产出中强制贴底(对话进行时始终保持最新内容可见)
 * - 非流式时若距底部 > 120px 显示「回到底部」浮动按钮 */
import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../../types/chat';
import { MessageItem } from './MessageItem';

export function MessageList({ messages, streaming }: { messages: ChatMessage[]; streaming: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [showJump, setShowJump] = useState(false);

  // 滚动位置检测:距底部 > 120px 显示「回到底部」
  const checkScroll = () => {
    const el = ref.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJump(dist > 120);
  };

  // 流式或新消息追加时自动贴底:
  // - streaming=true(对话进行中):强制贴底,保证最新内容可见
  // - streaming=false(新消息追加结束):接近底部(< 120px)时才贴底,尊重用户上滑阅读历史
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (streaming || dist < 120) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const jumpToBottom = () => {
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-neutral-500 gap-3 px-6 text-center animate-fade-in">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20 flex items-center justify-center text-2xl">
          🤖
        </div>
        <div className="space-y-1.5">
          <p className="text-sm text-neutral-300 font-medium">AI 助手准备就绪</p>
          <p className="text-xs text-neutral-500 leading-relaxed max-w-[260px]">
            打开一个 Office 文件后,AI 会自动感知。<br />
            试试问「读取一下这个文件的结构」<br />或「把第一列改成蓝色」
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={ref}
        onScroll={checkScroll}
        className="absolute inset-0 overflow-auto px-3 py-3 space-y-3 no-scrollbar"
      >
        {messages.map((m) => (
          <MessageItem key={m.id} msg={m} streaming={streaming && m.id === messages[messages.length - 1].id} />
        ))}
      </div>

      {/* 回到底部浮动按钮 */}
      {showJump && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-neutral-800 border border-white/15 text-neutral-200 text-[11px] shadow-lg shadow-black/40 hover:bg-neutral-700 hover:border-white/25 active:scale-95 transition animate-fade-in"
          title="回到底部"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
          {streaming && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
          最新
        </button>
      )}
    </div>
  );
}
