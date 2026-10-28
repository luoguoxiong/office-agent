/** 单条消息:user(右) / assistant(左,支持 markdown + 思考块 + 工具进度)。
 * Markdown 节流渲染:流式过程中每 150ms 解析一次,避免每 token 重排闪烁。 */
import { useEffect, useState, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { ChatMessage } from '../../types/chat';
import { ToolProgress } from './ToolProgress';
// oneDark 主题映射,库的类型签名复杂,转 any 简化使用
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const oneDarkTheme: any = oneDark;

function _MessageItem({ msg, streaming }: { msg: ChatMessage; streaming: boolean }) {
  const isUser = msg.role === 'user';
  // assistant 流式过程中节流渲染 markdown,减少闪烁
  const [displayContent, setDisplayContent] = useState(msg.content);
  useEffect(() => {
    if (!streaming || isUser) {
      setDisplayContent(msg.content);
      return;
    }
    const t = setTimeout(() => setDisplayContent(msg.content), 150);
    return () => clearTimeout(t);
  }, [msg.content, streaming, isUser]);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[92%] px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words ${
        isUser
          ? 'bg-blue-600 text-white rounded-br-md shadow-sm shadow-blue-600/20'
          : msg.error
            ? 'bg-red-500/10 text-red-200 border border-red-500/30 rounded-bl-md'
            : 'bg-white/5 text-neutral-100 border border-white/10 rounded-bl-md'
      }`}>
        {/* 思考过程块(reasoning 模型,可选) */}
        {msg.thinking && (
          <details className="mb-2 text-xs text-neutral-400 border-b border-white/10 pb-1.5">
            <summary className="cursor-pointer select-none hover:text-neutral-200 inline-flex items-center gap-1">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-500">
                <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 1 1 7.072 0l-.5.8a2 2 0 0 0-.316 1.072v.528a2 2 0 0 1-2 2h-.5a2 2 0 0 1-2-2v-.528a2 2 0 0 0-.316-1.072l-.5-.8z" />
              </svg>
              思考过程
            </summary>
            <div className="mt-1 italic">{msg.thinking}</div>
          </details>
        )}

        {/* 正文:流式且暂无内容时显示三点思考动画 */}
        {isUser ? (
          <div>{displayContent}</div>
        ) : streaming && !displayContent ? (
          <div className="flex items-center gap-1 py-0.5" aria-label="AI 正在思考">
            <span className="w-1.5 h-1.5 rounded-full bg-neutral-400 animate-[thinking_1.2s_ease-in-out_infinite]" />
            <span className="w-1.5 h-1.5 rounded-full bg-neutral-400 animate-[thinking_1.2s_ease-in-out_infinite_0.2s]" />
            <span className="w-1.5 h-1.5 rounded-full bg-neutral-400 animate-[thinking_1.2s_ease-in-out_infinite_0.4s]" />
          </div>
        ) : (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            className="markdown-body text-sm"
            components={{
              code(props) {
                const { className, children, ref: _ref, ...rest } = props as { className?: string; children?: unknown; ref?: unknown } & Record<string, unknown>;
                // react-markdown v9:行内 code 的 className 不含 language-xxx,通过 class 名中是否包含 language 判断
                const match = /language-(\w+)/.exec(className || '');
                const isInline = !match;
                return !isInline && match ? (
                  <SyntaxHighlighter
                    language={match[1]}
                    PreTag="div"
                    style={oneDarkTheme}
                    customStyle={{ margin: '0.5rem 0', fontSize: '12px', borderRadius: '6px' }}
                  >
                    {String(children).replace(/\n$/, '')}
                  </SyntaxHighlighter>
                ) : (
                  <code className={`${className ?? ''} bg-black/30 px-1 rounded text-[12px]`} {...rest as Record<string, unknown>}>
                    {children as React.ReactNode}
                  </code>
                );
              },
              table({ children }) {
                return <table className="border-collapse border border-neutral-500 my-1 text-xs">{children}</table>;
              },
              th({ children }) {
                return <th className="border border-neutral-500 px-2 py-1 bg-neutral-800">{children}</th>;
              },
              td({ children }) {
                return <td className="border border-neutral-500 px-2 py-1">{children}</td>;
              },
            }}
          >
            {displayContent || (streaming ? '…' : '')}
          </ReactMarkdown>
        )}

        {/* 工具执行进度(assistant 专属) */}
        {!isUser && <ToolProgress events={msg.toolEvents ?? []} />}
      </div>
    </div>
  );
}

export const MessageItem = memo(_MessageItem, (a, b) => {
  if (a.msg.id !== b.msg.id) return false;
  if (a.streaming !== b.streaming) return false;
  // 流式过程中每帧都会变 content/thinking/toolEvents → 不 memo 拦截
  if (a.streaming) return false;
  return a.msg.content === b.msg.content && a.msg.thinking === b.msg.thinking;
});
