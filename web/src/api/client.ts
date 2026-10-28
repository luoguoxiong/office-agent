/** 后端 API fetch 封装 + Tauri 原生目录选择器 */
import type {
  ConfigResponse,
  WorkspaceInfo,
  TreeResponse,
  OpenWorkspaceResponse,
  FileOpenResponse,
  CreateFileRequest,
  CreateFileResponse,
  CreateDirRequest,
  CreateDirResponse,
} from '../types/api';

const API = '/api/v1';

/** 是否运行在 Tauri 桌面环境 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 调用 Tauri 原生目录选择器,返回选中目录绝对路径(取消或非 Tauri 返回 null) */
export async function pickWorkspaceDir(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<string | null>('pick_workspace_dir');
    return result || null;
  } catch {
    return null;
  }
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  config: () => getJSON<ConfigResponse>(`${API}/config`),
  workspace: () => getJSON<WorkspaceInfo>(`${API}/workspace`),
  openWorkspace: (path: string) => postJSON<OpenWorkspaceResponse>(`${API}/workspace/open`, { path }),
  tree: (path?: string, depth?: number) => {
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    if (depth != null) params.set('depth', String(depth));
    const qs = params.toString();
    return getJSON<TreeResponse>(`${API}/workspace/tree${qs ? `?${qs}` : ''}`);
  },
  openFile: (path: string) => getJSON<FileOpenResponse>(`${API}/file/open?path=${encodeURIComponent(path)}`),
  downloadUrl: (path: string) => `${API}/file/download?path=${encodeURIComponent(path)}`,
  createFile: (req: CreateFileRequest) => postJSON<CreateFileResponse>(`${API}/workspace/file/create`, req),
  createDir: (req: CreateDirRequest) => postJSON<CreateDirResponse>(`${API}/workspace/dir/create`, req),
};
