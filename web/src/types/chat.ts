/** 聊天请求参数(对齐后端 /api/v1/chat body) */
export interface ChatParams {
  message: string;
  sessionKey?: string;
  model?: { provider?: string; modelId?: string };
  apiKey?: string;
  /** 当前选中文件(相对工作区),注入到对话上下文引导 Agent 先读再改 */
  filePath?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 思考增量(reasoning 模型,可选展示) */
  thinking?: string;
  /** 工具执行事件序列 */
  toolEvents?: ToolEvent[];
  /** 是否出错 */
  error?: boolean;
  /** 运行期告警(如 stopReason=length 被截断),展示给用户 */
  warnings?: string[];
}

export interface ToolEvent {
  toolName: string;
  state: 'start' | 'end';
  isError?: boolean;
}
