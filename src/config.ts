/**
 * ai-office 配置解析 + aipack 模型/streamFn 装配。
 * 硬约束:模型与 API Key 只能由前端用户选择/输入,绝不从 .env 读取。
 *   - loadConfig():仍读取 PORT/OFFICE_WORKSPACE 这类运行时 env(非 LLM 机密);内置模型列表全部 available=true,由前端负责让用户选/填 Key
 *   - buildModel():必须显式传入 apiKey,不再 fallback 到 env
 *   - resolveModelChoice():必须显式提供 provider/modelId,且 apiKey 非空;完全去掉 env fallback
 */
import './loadEnv.js'; // 副作用:仍加载 .env(仅用于 PORT/OFFICE_WORKSPACE 等非机密运行时参数)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptAiModel, createStreamFnFromAi, type Model, type StreamFn } from '@aipack-ai/agent';
import {
  getBuiltinModel,
  getBuiltinModels,
  BUILTIN_PROVIDERS,
} from '@aipack-ai/agent/ai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 各 provider 的默认展示名用模型(仅在 loadConfig 启动期用于 banner 显示,非运行时默认值) */
const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  deepseek: 'deepseek-chat',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-latest',
  google: 'gemini-2.0-flash',
  groq: 'llama-3.3-70b-versatile',
  mistral: 'mistral-small-latest',
  xai: 'grok-3-mini',
  moonshot: 'moonshot-v1-128k',
};

export interface ModelOption {
  provider: string;
  providerName: string;
  modelId: string;
  modelName: string;
  /** 全部为 true:所有内置模型都允许前端选择,Key 是否存在由前端界面管控 */
  available: boolean;
  reasoning: boolean;
  envVar: string;
}

export interface AppConfig {
  port: number;
  /** 仅用于启动 banner / config 接口默认值(前端选择为空时的占位) */
  provider: string;
  /** 仅用于启动 banner / config 接口默认值(前端选择为空时的占位) */
  modelId: string;
  /** 仅用于 loadConfig 自身的占位(buildModel 不走这个) */
  model: Model;
  /** 仅用于 loadConfig 自身的占位(buildModel 不走这个) */
  streamFn: StreamFn;
  /** 始终为 false:真实 LLM 就绪状态只能前端依据用户填写 Key 判断 */
  llmReady: boolean;
  /** 文件工作区绝对路径 */
  workspace: string;
  /** 内置模型目录(供前端渲染模型选择下拉;全部 available=true) */
  models: ModelOption[];
}

export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT) || 3001;
  // 仅作为 banner 占位显示:实际运行模型由前端请求里的 model 字段显式指定
  const provider = 'deepseek';
  const modelId = DEFAULT_MODEL_BY_PROVIDER[provider] ?? 'deepseek-chat';

  const dataDir = process.env.AI_OFFICE_DATA_DIR;
  const workspace = (() => {
    const envWs = process.env.OFFICE_WORKSPACE;
    if (envWs) {
      return path.isAbsolute(envWs)
        ? envWs
        : path.resolve(dataDir ?? path.resolve(__dirname, '..'), envWs);
    }
    return dataDir
      ? path.join(dataDir, 'office-workspace')
      : path.resolve(__dirname, '..', 'office-workspace');
  })();

  const knownProviders = new Set(BUILTIN_PROVIDERS.map((p) => p.id));
  void knownProviders; // 保持引用避免无用告警

  const aiModel = getBuiltinModel(provider, modelId)!;

  const models: ModelOption[] = getBuiltinModels().map((m) => {
    const meta = BUILTIN_PROVIDERS.find((p) => p.id === m.provider);
    return {
      provider: m.provider,
      providerName: meta?.name ?? m.provider,
      modelId: m.id,
      modelName: m.name,
      available: true, // 硬约束:所有内置模型都可选,Key 由前端填写
      reasoning: !!m.reasoning,
      envVar: meta?.envVar ?? `${m.provider.toUpperCase()}_API_KEY`,
    };
  });

  // 启动期提示:强调不读取 env Key
  console.log('ℹ️  配置策略:模型选择与 API Key 均由前端用户在界面填写,不读取 .env 中的 *_API_KEY');

  return {
    port,
    provider,
    modelId,
    model: adaptAiModel(aiModel),
    streamFn: createStreamFnFromAi(aiModel),
    llmReady: false, // 后端永远无法知道(不读 env Key)
    workspace,
    models,
  };
}

/** 按 (provider, modelId, apiKey) 构建模型 + streamFn。
 * 硬约束:apiKey 必须非空,绝不 fallback 到环境变量。
 *
 * maxTokens 策略(解决 thinking 吃光 output 配额导致的 stopReason=length):
 *   - 每个内置模型默认 maxTokens=8192(参见 BUILTIN_MODELS)
 *   - 但 Office 生成 PPT/Word 这类"长推理+长 commands"场景,模型会产生超长
 *     thinking/reasoning 草稿,8192 token 很容易被 thinking 全部吃光,
 *     结果 stopReason=length、一条 toolCall/text 都没产出 → 用户以为"卡死"。
 *   - 这里按「contextWindow 的 1/4」重算一个合理上限,并钳制到 [8192, 65536],
 *     同时在 streamFn options 中显式传入,覆盖 provider 默认。
 *   - reasoning 模型(深度思考模型)再额外放宽 1.5×。
 */
function deriveMaxTokens(aiModel: { reasoning: boolean; contextWindow: number; maxTokens: number }): number {
  const base = Math.max(aiModel.maxTokens, Math.floor(aiModel.contextWindow / 4));
  const withReasoningBoost = aiModel.reasoning ? Math.floor(base * 1.5) : base;
  return Math.min(65536, Math.max(8192, withReasoningBoost));
}

export function buildModel(provider: string, modelId: string, apiKey: string): { model: Model; streamFn: StreamFn } {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('缺少 API Key,请在 AI 助手面板中输入 Key');
  }
  const aiModel = getBuiltinModel(provider, modelId);
  if (!aiModel) {
    throw new Error(`找不到内置模型 ${provider}/${modelId}`);
  }
  const maxTokens = deriveMaxTokens(aiModel);
  // Model 侧写死:Runtime 内部复用 model.maxTokens 作为内部安全上限
  const model: Model = {
    ...(adaptAiModel(aiModel) as Model),
    maxTokens,
  };
  // StreamFn 侧显式传 maxTokens:覆盖 @aipack-ai/agent 内部 streamOpenAI/streamAnthropic 的默认
  const streamFn = createStreamFnFromAi(aiModel, { apiKey: apiKey.trim(), maxTokens });
  console.log(
    `[model] ${provider}/${modelId} reasoning=${String(aiModel.reasoning)} ` +
      `contextWindow=${aiModel.contextWindow} → maxTokens=${maxTokens}(原默认 ${aiModel.maxTokens})`,
  );
  return { model, streamFn };
}

export interface ModelChoice {
  provider: string;
  modelId: string;
  modelKey: string;
  apiKey: string;
}

/** 解析并校验前端传入的 model + apiKey。
 * 硬约束:必须显式提供 provider、modelId、apiKey,绝不 fallback 到 env。
 */
export function resolveModelChoice(
  picked: { provider?: unknown; modelId?: unknown } | undefined,
  userKey?: string,
): { choice: ModelChoice; error: string | null } {
  const provider = String(picked?.provider || '').trim().toLowerCase();
  const modelId = String(picked?.modelId || '').trim();
  if (!provider || !modelId) {
    return {
      choice: { provider, modelId, modelKey: `${provider}/${modelId}`, apiKey: '' },
      error: '请先在 AI 助手面板选择模型',
    };
  }
  const modelKey = `${provider}/${modelId}`;
  const apiKey = userKey?.trim() ?? '';
  if (!apiKey) {
    return {
      choice: { provider, modelId, modelKey, apiKey: '' },
      error: '请先在 AI 助手面板输入 API Key',
    };
  }
  if (!getBuiltinModel(provider, modelId)) {
    return { choice: { provider, modelId, modelKey, apiKey }, error: `未知模型 ${modelKey}` };
  }
  return { choice: { provider, modelId, modelKey, apiKey }, error: null };
}
