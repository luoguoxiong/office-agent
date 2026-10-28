/** 前后端共享 API 类型(对齐后端 /api/v1 响应) */

export interface ModelOption {
  provider: string;
  providerName: string;
  modelId: string;
  modelName: string;
  available: boolean;
  reasoning: boolean;
  envVar: string;
}

export interface ConfigResponse {
  provider: string;
  model: string;
  llmReady: boolean;
  officecliReady: boolean;
  defaultModel: { provider: string; modelId: string };
  models: ModelOption[];
  workspace: string;
  workspaceRoot: string;
  tools: string[];
}

export interface WorkspaceInfo {
  root: string;
  name: string;
  defaultRoot?: string;
}

export type NodeType = 'dir' | 'file';

export interface TreeNode {
  name: string;
  type: NodeType;
  path: string;
  ext?: string;
  size?: number;
  children?: TreeNode[] | null;
  expandable?: boolean;
}

export interface TreeResponse {
  root: string;
  path: string;
  nodes: TreeNode[];
}

export interface OpenWorkspaceResponse {
  root: string;
  name: string;
  tree: TreeNode[];
}

export interface CreateFileRequest {
  dir?: string;
  name: string;
  ext?: string;
}

export interface CreateFileResponse {
  path: string;
  name: string;
}

export interface CreateDirRequest {
  dir?: string;
  name: string;
}

export interface CreateDirResponse {
  path: string;
  name: string;
}

export type FileKind = 'office' | 'text' | 'image' | 'pdf' | 'unsupported' | 'error';

export interface FileOpenResponse {
  kind: FileKind;
  path: string;
  name: string;
  ext: string;
  size: number;
  previewUrl?: string;
  content?: string;
  dataUrl?: string;
  url?: string;
  message?: string;
}

/** 编辑器 Tab 数据(由 FileOpenResponse 派生) */
export interface Tab {
  path: string;
  name: string;
  ext: string;
  kind: FileKind;
  previewUrl?: string;
  content?: string;
  dataUrl?: string;
  url?: string;
  message?: string;
  /** 最近一次被 AI 修改的时间戳(供预览刷新) */
  modifiedAt?: number;
}
