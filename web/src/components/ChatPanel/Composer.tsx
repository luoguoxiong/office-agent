/** 输入区:textarea(Shift+Enter换行,Enter发送)在上一行,
 *  下一行工具栏:模型切换 + 设置 + 发送/停止。 */
import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { fileIcon } from '../FileTree/icons';
import { Dropdown } from '../Dropdown';
import type { SavedModel } from '../../store/settingsStore';

export function Composer({
  onSend,
  onStop,
  streaming,
  error,
  activeFilePath,
  activeFileName,
  activeFileExt,
  onToggleSettings,
  settingsOpen,
  models,
  activeModelId,
  onSelectModel,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  error: string | null;
  activeFilePath: string | null;
  activeFileName?: string;
  activeFileExt?: string;
  onToggleSettings: () => void;
  settingsOpen: boolean;
  models: SavedModel[];
  activeModelId: string | null;
  onSelectModel: (id: string | null) => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (ref.current) {
      // 自适应高度(最多 6 行)
      ref.current.style.height = 'auto';
      ref.current.style.height = Math.min(ref.current.scrollHeight, 140) + 'px';
    }
  }, [text]);

  const canSend = text.trim().length > 0 && !streaming;

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) {
        onSend(text.trim());
        setText('');
      }
    }
  };

  const send = () => {
    if (canSend) {
      onSend(text.trim());
      setText('');
    }
  };

  return (
    <div className="shrink-0 border-t border-white/5 bg-neutral-850/80 p-2.5 space-y-2">
      {/* 错误提示条 */}
      {error && (
        <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-md px-2.5 py-1.5 flex items-start gap-1.5 animate-fade-in">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="break-words">{error}</span>
        </div>
      )}

      {/* 上下文提示:当前选中的 office 文件 */}
      {activeFilePath ? (
        <div className="text-[11px] flex items-center gap-1.5 px-1 text-neutral-400">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-neutral-500">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
            <circle cx="12" cy="10" r="3" />
          </svg>
          <span className="text-neutral-500">可修改</span>
          <span className="inline-flex items-center gap-1 bg-white/5 border border-white/10 rounded px-1.5 py-0.5 max-w-full">
            <span>{fileIcon(activeFileExt)}</span>
            <span className="truncate max-w-[180px] text-neutral-300" title={activeFilePath}>
              {activeFileName ?? activeFilePath}
            </span>
          </span>
          <span className="text-neutral-600 shrink-0" title="助手仅可修改当前选中文件的内容,不支持新增/删除文件">
            仅此文件
          </span>
        </div>
      ) : (
        <div className="text-[11px] px-1 text-neutral-600 flex items-center gap-1.5">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-neutral-500">
            <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.5.4.8 1 .8 1.6V17h6.4v-.7c0-.6.3-1.2.8-1.6A7 7 0 0 0 12 2z" />
          </svg>
          <span>打开一个 Office 文件,助手仅可修改当前选中文件的内容(不支持新增/删除文件)</span>
        </div>
      )}

      {/* 输入框(上一行) */}
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={streaming ? 'AI 回复中…(可点击停止)' : '告诉 AI 要做什么…'}
        disabled={streaming}
        rows={2}
        className="w-full resize-none bg-neutral-900/80 text-neutral-100 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 disabled:opacity-60 disabled:cursor-not-allowed placeholder:text-neutral-600 min-h-[38px] max-h-[140px] no-scrollbar"
      />

      {/* 工具栏(下一行):模型切换 + 设置 + 发送/停止 */}
      <div className="flex items-center gap-2">
        {/* 模型快速切换(自定义下拉) */}
        <Dropdown
          className="flex-1 min-w-0"
          value={activeModelId ?? ''}
          onChange={(v) => onSelectModel(v || null)}
          placeholder={models.length === 0 ? '(请先配置模型)' : '(请选择模型)'}
          options={models.map((m) => ({
            value: m.id,
            label: m.name,
            badge: m.apiKey ? undefined : '缺Key',
            badgeClass: 'text-amber-400',
          }))}
          title="切换模型"
        />

        {/* 设置按钮 */}
        <button
          onClick={onToggleSettings}
          className={`shrink-0 w-[32px] h-[32px] flex items-center justify-center rounded-md border transition-colors ${
            settingsOpen
              ? 'bg-blue-600 border-blue-500 text-white'
              : 'bg-neutral-900/80 border-white/10 text-neutral-400 hover:text-neutral-200 hover:border-white/20'
          }`}
          title="模型配置"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={settingsOpen ? 'animate-spin' : ''} style={settingsOpen ? { animationDuration: '3s' } : undefined}>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>

        {/* 发送 / 停止 */}
        {streaming ? (
          <button
            onClick={onStop}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-neutral-700 hover:bg-neutral-600 active:bg-neutral-800 text-neutral-100 text-xs font-medium h-[32px] shadow-sm"
          >
            <span className="w-2 h-2 bg-neutral-100 rounded-sm" />
            停止
          </button>
        ) : (
          <button
            onClick={send}
            disabled={!canSend}
            className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 active:bg-blue-700 disabled:bg-neutral-700 disabled:text-neutral-500 text-white text-xs font-medium h-[32px] shadow-sm shadow-blue-600/20 disabled:shadow-none"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
            发送
          </button>
        )}
      </div>
    </div>
  );
}
