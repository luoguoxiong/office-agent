/** 多模型配置管理器:添加/编辑/删除/激活已保存的模型配置
 * - 内联展开面板(非弹窗,保证 Tauri 可用)
 * - 内置 provider/model 列表从 /api/v1/config 获取,与后端 buildModel 保持一致
 * - 所有数据走 useSettingsStore,自动 localStorage 持久化
 * - 交互优化:内联字段错误(替代 alert)、内联两步删除(替代 confirm)、API Key 显隐、全字段键盘流
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { Dropdown } from '../Dropdown';
import { SavedModel, useSettingsStore } from '../../store/settingsStore';
import type { ModelOption } from '../../types/api';

type EditState =
  | { mode: 'none' }
  | { mode: 'add' }
  | { mode: 'edit'; id: string };

interface DraftModel {
  name: string;
  provider: string;
  modelId: string;
  apiKey: string;
}

/** 字段级错误:key 为字段名,value 为错误消息;空对象表示无错误 */
type FieldErrors = Partial<Record<keyof DraftModel, string>>;

const EMPTY_DRAFT: DraftModel = { name: '', provider: '', modelId: '', apiKey: '' };

/** 从内置 ModelOption[] 中按 provider 分组,返回去重后的 provider 列表 + 对应模型 */
function useBuiltinModels() {
  const [options, setOptions] = useState<ModelOption[]>([]);
  useEffect(() => {
    api.config().then((c) => setOptions(c.models)).catch(() => {});
  }, []);

  const providers = useMemo(() => {
    const map = new Map<string, string>(); // provider -> providerName
    for (const m of options) {
      if (!map.has(m.provider)) map.set(m.provider, m.providerName);
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [options]);

  const modelsByProvider = useMemo(() => {
    const map = new Map<string, { id: string; name: string }[]>();
    for (const m of options) {
      const arr = map.get(m.provider) ?? [];
      arr.push({ id: m.modelId, name: m.modelName });
      map.set(m.provider, arr);
    }
    return map;
  }, [options]);

  return { options, providers, modelsByProvider };
}

export function ModelManager({ onClose }: { onClose: () => void }) {
  const { providers, modelsByProvider } = useBuiltinModels();
  const models = useSettingsStore((s) => s.models);
  const activeId = useSettingsStore((s) => s.activeModelId);
  const addModel = useSettingsStore((s) => s.addModel);
  const updateModel = useSettingsStore((s) => s.updateModel);
  const deleteModel = useSettingsStore((s) => s.deleteModel);
  const setActive = useSettingsStore((s) => s.setActiveModel);

  const [edit, setEdit] = useState<EditState>({ mode: 'none' });
  const [draft, setDraft] = useState<DraftModel>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [showApiKey, setShowApiKey] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 进入编辑态:初始化草稿
  useEffect(() => {
    if (edit.mode === 'add') {
      // 预选第一个 provider,加速填写
      const firstProvider = providers[0]?.id ?? '';
      const firstModels = modelsByProvider.get(firstProvider) ?? [];
      setDraft({
        name: '',
        provider: firstProvider,
        modelId: firstModels[0]?.id ?? '',
        apiKey: '',
      });
      setErrors({});
      setShowApiKey(false);
      requestAnimationFrame(() => nameInputRef.current?.focus());
    } else if (edit.mode === 'edit') {
      const m = models.find((x) => x.id === edit.id);
      if (m) {
        setDraft({ name: m.name, provider: m.provider, modelId: m.modelId, apiKey: m.apiKey });
        setErrors({});
        setShowApiKey(false);
        requestAnimationFrame(() => nameInputRef.current?.focus());
      } else {
        setEdit({ mode: 'none' });
      }
    }
  }, [edit, models, providers, modelsByProvider]);

  const draftModelOptions = modelsByProvider.get(draft.provider) ?? [];

  // 切换 provider 时,如果当前 modelId 不在新 provider 的列表中,自动选第一个
  useEffect(() => {
    if (edit.mode === 'none') return;
    if (!draft.provider) return;
    if (!draftModelOptions.find((m) => m.id === draft.modelId)) {
      setDraft((d) => ({ ...d, modelId: draftModelOptions[0]?.id ?? '' }));
    }
  }, [draft.provider, draftModelOptions, draft.modelId, edit.mode]);

  /** 字段级校验:返回各字段错误对象;空对象表示全部通过 */
  const validateFields = (): FieldErrors => {
    const e: FieldErrors = {};
    if (!draft.name.trim()) e.name = '请填写名称';
    if (!draft.provider) e.provider = '请选择';
    if (!draft.modelId) e.modelId = '请选择';
    if (!draft.apiKey.trim()) e.apiKey = '请填写 API Key';
    return e;
  };

  const submit = () => {
    const errs = validateFields();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      // 聚焦第一个出错的字段
      const firstField = Object.keys(errs)[0] as keyof DraftModel;
      if (firstField === 'name') nameInputRef.current?.focus();
      return;
    }
    const payload: Omit<SavedModel, 'id'> = {
      name: draft.name.trim(),
      provider: draft.provider,
      modelId: draft.modelId,
      apiKey: draft.apiKey.trim(),
    };
    if (edit.mode === 'add') {
      addModel(payload);
    } else if (edit.mode === 'edit') {
      updateModel(edit.id, payload);
    }
    setEdit({ mode: 'none' });
    setDraft(EMPTY_DRAFT);
    setErrors({});
  };

  const cancel = () => {
    setEdit({ mode: 'none' });
    setDraft(EMPTY_DRAFT);
    setErrors({});
  };

  /** 草稿字段更新时清除该字段的错误(即时反馈) */
  const updateDraft = (field: keyof DraftModel, value: string) => {
    setDraft((d) => ({ ...d, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  };

  /** 表单内统一的键盘处理:Enter 提交 / Escape 取消 */
  const onFormKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };

  /** 根级键盘:列表态 Escape 关闭面板;删除确认态 Escape 取消删除 */
  const onRootKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (edit.mode !== 'none') return; // 表单内自己处理
    e.preventDefault();
    if (deletingId !== null) {
      cancelDelete();
    } else {
      onClose();
    }
  };

  const startAdd = () => setEdit({ mode: 'add' });
  const startEdit = (id: string) => setEdit({ mode: 'edit', id });

  // 面板打开时自动聚焦根容器,使 Escape 立即生效
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  /** 内联两步删除:第一次点击进入确认态,第二次点击执行删除 */
  const handleDeleteClick = (id: string) => {
    if (deletingId === id) {
      deleteModel(id);
      setDeletingId(null);
    } else {
      setDeletingId(id);
    }
  };

  const cancelDelete = () => setDeletingId(null);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onRootKeyDown}
      className="rounded-t-lg border-t border-x border-white/10 bg-neutral-900/95 backdrop-blur-sm text-neutral-200 flex flex-col max-h-[70vh] overflow-hidden shadow-2xl shadow-black/50 animate-fade-in focus:outline-none"
    >
      {/* 顶部:标题 + 添加按钮 + 关闭 */}
      <div className="flex items-center justify-between px-3 h-9 border-b border-white/5 shrink-0">
        <span className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">模型配置</span>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-neutral-500 tabular-nums">{models.length} 个</span>
          {edit.mode === 'none' && (
            <button
              onClick={startAdd}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-medium shadow-sm shadow-blue-600/20"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              添加
            </button>
          )}
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-white/10 text-neutral-400 hover:text-neutral-200"
            title="关闭 (Esc)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      <div className="overflow-y-auto no-scrollbar">
        {/* 添加/编辑表单 */}
        {edit.mode !== 'none' && (
          <div className="px-3 py-3 border-b border-white/5 bg-neutral-850/50 space-y-3 shrink-0 animate-fade-in" onKeyDown={onFormKeyDown}>
            <div className="text-xs font-medium text-blue-400 flex items-center gap-1.5">
              {edit.mode === 'add' ? (
                <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>新增模型配置</>
              ) : (
                <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>编辑模型配置</>
              )}
            </div>

            {/* 自定义名称 */}
            <label className="block space-y-1">
              <span className="text-[11px] text-neutral-400 flex items-center gap-1">
                自定义名称
                {errors.name && <span className="text-red-400">· {errors.name}</span>}
              </span>
              <input
                ref={nameInputRef}
                type="text"
                value={draft.name}
                onChange={(e) => updateDraft('name', e.target.value)}
                placeholder="如:我的 DeepSeek / 公司 OpenAI"
                className={`w-full text-xs bg-neutral-900/80 text-neutral-100 border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500/30 placeholder:text-neutral-600 ${errors.name ? 'border-red-500/50 focus:border-red-500' : 'border-white/10 focus:border-blue-500'}`}
              />
            </label>

            {/* Provider + Model */}
            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1">
                <span className="text-[11px] text-neutral-400 flex items-center gap-1">
                  Provider
                  {errors.provider && <span className="text-red-400">· {errors.provider}</span>}
                </span>
                <Dropdown
                  value={draft.provider}
                  onChange={(v) => updateDraft('provider', v)}
                  placeholder="— 选择 —"
                  error={!!errors.provider}
                  options={providers.map((p) => ({ value: p.id, label: p.name }))}
                />
              </label>

              <label className="block space-y-1">
                <span className="text-[11px] text-neutral-400 flex items-center gap-1">
                  模型
                  {errors.modelId && <span className="text-red-400">· {errors.modelId}</span>}
                </span>
                <Dropdown
                  value={draft.modelId}
                  onChange={(v) => updateDraft('modelId', v)}
                  placeholder="— 选择 —"
                  disabled={!draft.provider || draftModelOptions.length === 0}
                  error={!!errors.modelId}
                  options={draftModelOptions.map((m) => ({ value: m.id, label: m.name }))}
                />
              </label>
            </div>

            {/* API Key(带显隐切换) */}
            <label className="block space-y-1">
              <span className="text-[11px] text-neutral-400 flex items-center gap-1">
                API Key
                {errors.apiKey && <span className="text-red-400">· {errors.apiKey}</span>}
                <span className="text-neutral-600 ml-auto">仅本机 localStorage</span>
              </span>
              <div className="relative">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={draft.apiKey}
                  onChange={(e) => updateDraft('apiKey', e.target.value)}
                  placeholder="如 sk-..."
                  autoComplete="off"
                  spellCheck={false}
                  className={`w-full text-xs bg-neutral-900/80 text-neutral-100 border rounded-md px-2.5 py-1.5 pr-9 focus:outline-none focus:ring-1 focus:ring-blue-500/30 placeholder:text-neutral-600 font-mono ${errors.apiKey ? 'border-red-500/50 focus:border-red-500' : 'border-white/10 focus:border-blue-500'}`}
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((v) => !v)}
                  tabIndex={-1}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded text-neutral-500 hover:text-neutral-200 hover:bg-white/10"
                  title={showApiKey ? '隐藏' : '显示'}
                >
                  {showApiKey ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </label>

            {/* 操作按钮 */}
            <div className="flex gap-1.5 justify-end pt-1">
              <button
                onClick={cancel}
                className="text-xs px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-neutral-300"
              >
                取消
                <span className="text-neutral-600 ml-1">Esc</span>
              </button>
              <button
                onClick={submit}
                className="text-xs px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-medium shadow-sm shadow-blue-600/20"
              >
                保存
                <span className="text-blue-200/70 ml-1">↵</span>
              </button>
            </div>
          </div>
        )}

        {/* 已保存模型列表 - 空状态 */}
        {models.length === 0 && edit.mode === 'none' && (
          <div className="px-3 py-8 text-center text-xs text-neutral-500 space-y-3 animate-fade-in">
            <div className="w-10 h-10 mx-auto rounded-xl bg-neutral-800/60 flex items-center justify-center text-lg">📭</div>
            <div className="text-neutral-400">尚未配置任何模型</div>
            <div className="text-[10px] text-neutral-600 leading-relaxed max-w-[220px] mx-auto">
              所有配置仅保存在本机,不会上传服务器。
            </div>
            <button
              onClick={startAdd}
              className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-medium shadow-sm shadow-blue-600/20"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              添加第一个模型
            </button>
            <div className="text-[10px] text-neutral-600">或按 Esc 关闭</div>
          </div>
        )}

        {/* 已保存模型列表 */}
        {models.length > 0 && (
          <ul className="divide-y divide-white/5">
            {models.map((m) => {
              const isActive = m.id === activeId;
              const pName = providers.find((p) => p.id === m.provider)?.name ?? m.provider;
              const isDeleting = deletingId === m.id;
              return (
                <li
                  key={m.id}
                  className={`px-3 py-2 transition-colors ${
                    isActive ? 'bg-blue-500/10' : isDeleting ? 'bg-red-500/10' : 'hover:bg-white/5'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {/* 激活按钮/状态(单选样式) */}
                    <button
                      onClick={() => setActive(isActive ? null : m.id)}
                      className={`mt-0.5 shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-all ${
                        isActive
                          ? 'border-blue-500 bg-blue-500'
                          : 'border-neutral-600 hover:border-blue-400 bg-transparent'
                      }`}
                      title={isActive ? '点击取消使用此模型' : '点击设为当前使用模型'}
                      aria-pressed={isActive}
                    >
                      {isActive && (
                        <span className="w-1.5 h-1.5 rounded-full bg-white" />
                      )}
                    </button>

                    {/* 信息主体 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`text-xs font-medium truncate ${isActive ? 'text-blue-200' : 'text-neutral-100'}`}>
                          {m.name}
                        </span>
                        {isActive && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30">
                            使用中
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-neutral-500 mt-0.5 truncate font-mono">
                        {pName} · {m.modelId}
                      </div>
                      {/* 删除确认提示(内联) */}
                      {isDeleting && (
                        <div className="mt-1.5 flex items-center gap-2 text-[11px] animate-fade-in">
                          <span className="text-red-400">确认删除?不可恢复</span>
                          <button
                            onClick={() => handleDeleteClick(m.id)}
                            className="px-1.5 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white"
                          >
                            删除
                          </button>
                          <button
                            onClick={cancelDelete}
                            className="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-neutral-300"
                          >
                            取消
                          </button>
                        </div>
                      )}
                    </div>

                    {/* 操作按钮 */}
                    {!isDeleting && (
                      <div className="flex shrink-0 gap-0.5">
                        <button
                          onClick={() => startEdit(m.id)}
                          disabled={edit.mode !== 'none'}
                          className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-white/10 text-neutral-400 hover:text-neutral-200 disabled:opacity-30 disabled:cursor-not-allowed"
                          title="编辑"
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => handleDeleteClick(m.id)}
                          disabled={edit.mode !== 'none'}
                          className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-red-500/15 text-neutral-400 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed"
                          title="删除"
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
