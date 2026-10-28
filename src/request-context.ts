/**
 * per-request 上下文(基于 AsyncLocalStorage)。
 *
 * office_exec 工具执行成功后,通过 onFileModified 回调通知当前 SSE 请求,
 * 后端据此推送 SSE file 事件,前端刷新对应文件预览。
 *
 * 用 AsyncLocalStorage 而非模块级变量:支持并发 SSE 请求隔离,
 * 每个请求的回调互不干扰。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  /** office_exec 成功修改文件时回调(参数=相对工作区路径) */
  onFileModified?: (filePath: string) => void;
  /** 当前请求绑定的「选中文件」(相对工作区路径)。
   *  写工具据此限制:只能修改该文件,禁止新增/删除其他文件。 */
  currentFilePath?: string;
}

export const requestCtx = new AsyncLocalStorage<RequestContext>();
