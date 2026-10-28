/** 设置:多模型配置 + 当前选中模型(localStorage 持久化,服务器不存储) */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** 用户保存的一个模型配置(含 API Key) */
export interface SavedModel {
  /** 本地唯一 ID(随机生成) */
  id: string;
  /** 用户自定义显示名,如「我的 DeepSeek」 */
  name: string;
  /** Provider,对应 @aipack-ai/agent 的 BUILTIN_PROVIDERS.id,如 deepseek/openai */
  provider: string;
  /** 模型 ID,如 deepseek-chat / gpt-4o-mini */
  modelId: string;
  /** 对应模型的 API Key(仅本机存储) */
  apiKey: string;
}

interface SettingsState {
  /** 用户保存的所有模型配置 */
  models: SavedModel[];
  /** 当前选中的模型 ID;null 表示未选择 */
  activeModelId: string | null;

  /**
   * 获取当前选中的模型(selector 便捷函数,外部用 useSettingsStore(s => s.getActiveModel()))
   * 注意:放在 state 里是为了 getState() 也能直接拿到;不是响应式 getter,调用时读最新
   */
  getActiveModel: () => SavedModel | null;

  /** 添加一个新模型,返回新模型 id,并自动设为 active(第一个模型时) */
  addModel: (m: Omit<SavedModel, 'id'>) => string;

  /** 更新已有模型字段 */
  updateModel: (id: string, patch: Partial<Omit<SavedModel, 'id'>>) => void;

  /** 删除一个模型;如果是 active 模型,active 自动置空 */
  deleteModel: (id: string) => void;

  /** 切换当前选中模型;传 null 取消选择 */
  setActiveModel: (id: string | null) => void;
}

function modelId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      models: [],
      activeModelId: null,

      getActiveModel: () => {
        const { models, activeModelId } = get();
        if (!activeModelId) return null;
        return models.find((m) => m.id === activeModelId) ?? null;
      },

      addModel: (m) => {
        const id = modelId();
        const saved: SavedModel = { ...m, id };
        set((s) => ({
          models: [...s.models, saved],
          // 第一个添加的模型自动激活
          activeModelId: s.activeModelId ?? s.models.length === 0 ? id : s.activeModelId,
        }));
        return id;
      },

      updateModel: (id, patch) => {
        set((s) => ({
          models: s.models.map((m) => (m.id === id ? { ...m, ...patch } : m)),
        }));
      },

      deleteModel: (id) => {
        set((s) => {
          const models = s.models.filter((m) => m.id !== id);
          const activeModelId = s.activeModelId === id ? null : s.activeModelId;
          return { models, activeModelId };
        });
      },

      setActiveModel: (id) => set({ activeModelId: id }),
    }),
    {
      name: 'ai-office-settings',
      /** 迁移:旧版本只存单个 model + apiKey,升级时把它转成一个 SavedModel
       *  注意:migrate 只需要返回「数据字段」(models/activeModelId),方法字段由 persist
       *  结合 state factory 重新应用。因此这里用 as unknown as SettingsState 跳过方法检查
       */
      migrate: (persisted: unknown): SettingsState => {
        const obj = persisted as Record<string, unknown> | undefined;
        if (!obj) return { models: [], activeModelId: null } as unknown as SettingsState;

        // 已经是新版(models 数组存在) → 直接返回(只保留数据字段,方法 persist 会补)
        if (Array.isArray((obj as { models?: unknown[] }).models)) {
          const data = {
            models: (obj as { models: SavedModel[] }).models ?? [],
            activeModelId: (obj as { activeModelId?: string | null }).activeModelId ?? null,
          };
          return data as unknown as SettingsState;
        }

        // 旧版: { model: {provider,modelId} | null, apiKey: string }
        const oldModel = obj.model as { provider: string; modelId: string } | null | undefined;
        const oldKey = (obj.apiKey as string) ?? '';
        if (oldModel && oldModel.provider && oldModel.modelId) {
          const id = modelId();
          const migrated: SavedModel = {
            id,
            name: `${oldModel.provider}/${oldModel.modelId}`,
            provider: oldModel.provider,
            modelId: oldModel.modelId,
            apiKey: oldKey,
          };
          return {
            models: [migrated],
            activeModelId: oldKey ? id : null, // 有 Key 才默认激活
          } as unknown as SettingsState;
        }
        return { models: [], activeModelId: null } as unknown as SettingsState;
      },
    },
  ),
);
