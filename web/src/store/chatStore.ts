/** 聊天状态:按「文件路径」隔离的多会话消息列表 + SSE 流式接收
 *
 * 会话规则:
 * - 打开一个文件(Tab 的相对路径 path)时,对应 sessionKey = `file:${path}`
 * - 未选中任何文件时,使用通用会话 sessionKey = `__global__`
 * - 每个 session 有独立的 messages / streaming / error(前端消息列表隔离)
 * - 调 streamChat 时 sessionKey 同步传入 → 后端 @aipack-ai/agent 的 sessionStorage
 *   也会把 Agent 历史按同一 key 持久化到 .aipack/sessions/ 下,实现 LLM 侧上下文隔离
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { streamChat } from '../api/sse';
import { useSettingsStore } from './settingsStore';
import { useEditorStore } from './editorStore';
import type { ChatMessage, ToolEvent } from '../types/chat';

export const GLOBAL_SESSION_KEY = '__global__';
export function fileSessionKey(relativePath: string | null | undefined): string {
  return relativePath ? `file:${relativePath}` : GLOBAL_SESSION_KEY;
}

interface PerSessionState {
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;
}

const EMPTY_SESSION: PerSessionState = { messages: [], streaming: false, error: null };

interface ChatState {
  /** 所有会话:key 是 `file:xxx` 或 `__global__` */
  sessionBuckets: Record<string, PerSessionState>;
  /** 当前显示/操作的会话 key */
  currentSessionKey: string;

  /** 以下为当前会话的派生态,与 sessionBuckets[currentSessionKey] 保持同步 */
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;

  /** 切换到指定会话(不存在则自动创建空会话),自动同步顶部派生字段 */
  switchSession: (key: string) => void;
  /** 发送消息(在当前会话上下文中);filePath 仍然会被注入到单条消息头部 */
  send: (message: string, filePath?: string) => Promise<void>;
  /** 停止当前会话的流式请求 */
  stop: () => void;
  /** 清空当前会话的消息/错误 */
  clear: () => void;
}

let abortController: AbortController | null = null;

function uid(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : String(Date.now() + Math.random());
}

/** 把「当前 session 状态」从 sessionBuckets 同步到顶层 messages/streaming/error 字段,
 *  这样组件里的 useChatStore(s => s.messages) 选择器不用改就能响应切换。 */
function syncTopFromBucket(
  state: Pick<ChatState, 'sessionBuckets' | 'currentSessionKey'>,
): Pick<ChatState, 'messages' | 'streaming' | 'error'> {
  const bucket = state.sessionBuckets[state.currentSessionKey] ?? EMPTY_SESSION;
  return { messages: bucket.messages, streaming: bucket.streaming, error: bucket.error };
}

/** 辅助:更新当前 session 的 bucket,同时同步顶层字段
 *  updater 接收当前 bucket 的浅拷贝,直接在副本上修改即可 */
function updateCurrentBucket(
  state: ChatState,
  updater: (bucket: PerSessionState) => void,
): Partial<ChatState> {
  const current = state.sessionBuckets[state.currentSessionKey] ?? EMPTY_SESSION;
  const next: PerSessionState = { ...current };
  updater(next);
  const nextBuckets = { ...state.sessionBuckets, [state.currentSessionKey]: next };
  return {
    sessionBuckets: nextBuckets,
    messages: next.messages,
    streaming: next.streaming,
    error: next.error,
  };
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => {
      // 初始状态:只创建 global session,顶部字段同步
      const initialBuckets: Record<string, PerSessionState> = {
        [GLOBAL_SESSION_KEY]: { ...EMPTY_SESSION },
      };
      const initial: ChatState = {
        sessionBuckets: initialBuckets,
        currentSessionKey: GLOBAL_SESSION_KEY,
        ...syncTopFromBucket({
          sessionBuckets: initialBuckets,
          currentSessionKey: GLOBAL_SESSION_KEY,
        }),

        switchSession: (key) => {
          set((s) => {
            if (s.currentSessionKey === key) return {}; // 没变化
            // 若目标 bucket 不存在 → 初始化一个
            const buckets = s.sessionBuckets[key]
              ? s.sessionBuckets
              : { ...s.sessionBuckets, [key]: { ...EMPTY_SESSION } };
            const next = {
              sessionBuckets: buckets,
              currentSessionKey: key,
            };
            return { ...next, ...syncTopFromBucket(next) };
          });
        },

        send: async (message, filePath) => {
          // 从 settingsStore 取当前选中的 active 模型
          const activeModel = useSettingsStore.getState().getActiveModel();

          // ── 前置校验:把校验产生的错误消息也写入「当前 session bucket」
          const pushError = (assistantText: string, errTag: string) => {
            set((s) =>
              updateCurrentBucket(s, (b) => {
                b.messages = [
                  ...b.messages,
                  { id: uid(), role: 'user', content: message },
                  { id: uid(), role: 'assistant', content: assistantText, error: true },
                ];
                b.streaming = false;
                b.error = errTag;
              }),
            );
          };

          if (!activeModel) {
            pushError(
              '⚠️ 请先在 🧰 模型管理器中添加模型,并在顶部下拉选择一个模型',
              '未选择模型',
            );
            return;
          }
          if (!activeModel.provider || !activeModel.modelId) {
            pushError(
              `⚠️ 模型「${activeModel.name}」配置不完整(缺少 provider 或 modelId),请在 🧰 管理器中编辑`,
              '模型配置不完整',
            );
            return;
          }
          const apiKey = activeModel.apiKey.trim();
          if (!apiKey) {
            pushError(
              `⚠️ 模型「${activeModel.name}」尚未设置 API Key,请在 🧰 管理器中编辑`,
              '缺少 API Key',
            );
            return;
          }

          const userMsg: ChatMessage = { id: uid(), role: 'user', content: message };
          const assistantId = uid();
          const assistantMsg: ChatMessage = {
            id: assistantId,
            role: 'assistant',
            content: '',
            toolEvents: [],
          };

          // 写入当前 bucket(用户消息 + 空助手消息 + streaming=true + error=null)
          set((s) =>
            updateCurrentBucket(s, (b) => {
              b.messages = [...b.messages, userMsg, assistantMsg];
              b.streaming = true;
              b.error = null;
            }),
          );

          const model = { provider: activeModel.provider, modelId: activeModel.modelId };
          const { currentSessionKey } = get();

          abortController = new AbortController();
          try {
            await streamChat(
              // 关键:把 currentSessionKey 传给后端,实现 LLM 侧 agent 记忆隔离
              { message, sessionKey: currentSessionKey, model, apiKey, filePath },
              {
                onDelta: (delta) =>
                  set((s) =>
                    updateCurrentBucket(s, (b) => {
                      b.messages = b.messages.map((m) =>
                        m.id === assistantId ? { ...m, content: m.content + delta } : m,
                      );
                    }),
                  ),
                onThinking: (delta) =>
                  set((s) =>
                    updateCurrentBucket(s, (b) => {
                      b.messages = b.messages.map((m) =>
                        m.id === assistantId
                          ? { ...m, thinking: (m.thinking ?? '') + delta }
                          : m,
                      );
                    }),
                  ),
                onToolStart: (toolName) =>
                  set((s) =>
                    updateCurrentBucket(s, (b) => {
                      b.messages = b.messages.map((m) =>
                        m.id === assistantId
                          ? {
                              ...m,
                              toolEvents: [
                                ...(m.toolEvents ?? []),
                                { toolName, state: 'start' } as ToolEvent,
                              ],
                            }
                          : m,
                      );
                    }),
                  ),
                onToolEnd: (toolName, isError) =>
                  set((s) =>
                    updateCurrentBucket(s, (b) => {
                      b.messages = b.messages.map((m) =>
                        m.id === assistantId
                          ? {
                              ...m,
                              toolEvents: [
                                ...(m.toolEvents ?? []),
                                { toolName, state: 'end', isError } as ToolEvent,
                              ],
                            }
                          : m,
                      );
                    }),
                  ),
                onFile: (path) => {
                  useEditorStore.getState().markModified(path);
                },
                onWarning: (msg) =>
                  set((s) =>
                    updateCurrentBucket(s, (b) => {
                      b.messages = b.messages.map((m) =>
                        m.id === assistantId
                          ? { ...m, warnings: [...(m.warnings ?? []), msg] }
                          : m,
                      );
                      // 同时在 bucket.error 上挂一个简短提示,让用户在底部状态栏也能看到
                      if (!b.error) b.error = '⚠️ ' + msg;
                    }),
                  ),
                onDone: () =>
                  set((s) =>
                    updateCurrentBucket(s, (b) => {
                      b.streaming = false;
                    }),
                  ),
                onError: (msg) =>
                  set((s) =>
                    updateCurrentBucket(s, (b) => {
                      b.streaming = false;
                      b.error = msg;
                    }),
                  ),
              },
              abortController.signal,
            );
          } catch (e) {
            const msg = (e as Error).name === 'AbortError' ? '已停止' : (e as Error).message;
            set((s) =>
              updateCurrentBucket(s, (b) => {
                b.streaming = false;
                b.error = msg;
                b.messages = b.messages.map((m) =>
                  m.id === assistantId && !m.content
                    ? { ...m, content: `⚠️ ${msg}`, error: true }
                    : m,
                );
              }),
            );
          } finally {
            abortController = null;
          }
        },

        stop: () => {
          abortController?.abort();
          // 无论是否有正在运行的请求,都强制重置 streaming=false
          // 防止因持久化恢复或 abortController 丢失导致按钮卡在"停止"状态
          set((s) =>
            updateCurrentBucket(s, (b) => {
              b.streaming = false;
            }),
          );
        },

        clear: () => {
          set((s) =>
            updateCurrentBucket(s, (b) => {
              b.messages = [];
              b.error = null;
            }),
          );
        },
      };
      return initial;
    },
    {
      name: 'ai-office-chat-sessions',
      // 只持久化每个 session 的消息历史 + 当前 sessionKey
      // 不持久化 streaming/error 这类临时状态,否则刷新后会恢复 streaming=true 导致按钮卡在停止
      partialize: (state) => {
        const cleanedBuckets: Record<string, { messages: ChatMessage[] }> = {};
        for (const [k, v] of Object.entries(state.sessionBuckets)) {
          cleanedBuckets[k] = { messages: v.messages };
        }
        return {
          sessionBuckets: cleanedBuckets,
          currentSessionKey: state.currentSessionKey,
        } as unknown as ChatState;
      },
      // 从 localStorage 恢复后,补全每个 session 缺少的 streaming/error 字段
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const buckets: Record<string, PerSessionState> = {};
        for (const [k, v] of Object.entries(state.sessionBuckets)) {
          buckets[k] = {
            messages: (v as { messages?: ChatMessage[] }).messages ?? [],
            streaming: false,
            error: null,
          };
        }
        state.sessionBuckets = buckets;
        // 同时同步顶层派生字段
        const top = syncTopFromBucket({
          sessionBuckets: buckets,
          currentSessionKey: state.currentSessionKey,
        });
        state.messages = top.messages;
        state.streaming = top.streaming;
        state.error = top.error;
      },
    },
  ),
);
