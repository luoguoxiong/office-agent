/** SSE 流式聊天(fetch POST + ReadableStream 解析,EventSource 不支持 POST body) */
import type { ChatParams } from '../types/chat';

export interface ChatHandlers {
  onDelta?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolStart?: (toolName: string) => void;
  onToolEnd?: (toolName: string, isError: boolean) => void;
  onFile?: (path: string) => void;
  onWarning?: (message: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

/** 解析一个 SSE 帧,返回 {event, data} */
function parseFrame(frame: string): { event: string; data: string } {
  let event = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  return { event, data };
}

/**
 * 发起 SSE 流式聊天。
 * 后端事件:delta / thinking / tool / file / done / error。
 */
export async function streamChat(
  params: ChatParams,
  handlers: ChatHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  if (!res.body) throw new Error('响应无 body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 帧以 \n\n 分隔
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const { event, data } = parseFrame(frame);
      const parsed = data ? (JSON.parse(data) as Record<string, unknown>) : {};
      switch (event) {
        case 'delta':
          handlers.onDelta?.((parsed.delta as string) ?? '');
          break;
        case 'thinking':
          handlers.onThinking?.((parsed.delta as string) ?? '');
          break;
        case 'tool':
          if (parsed.state === 'start') handlers.onToolStart?.((parsed.toolName as string) ?? '');
          else handlers.onToolEnd?.((parsed.toolName as string) ?? '', !!parsed.isError);
          break;
        case 'file':
          handlers.onFile?.((parsed.path as string) ?? '');
          break;
        case 'done':
          handlers.onDone?.();
          break;
        case 'error':
          handlers.onError?.((parsed.message as string) ?? '未知错误');
          break;
        case 'warning':
          handlers.onWarning?.((parsed.message as string) ?? '模型输出异常');
          break;
      }
    }
  }
  // 流正常结束但未收到 done 事件时,也视为完成
  handlers.onDone?.();
}
