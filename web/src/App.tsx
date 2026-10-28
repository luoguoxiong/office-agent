/** 应用根:三栏布局(文件树 | 编辑器 | 聊天)。 */
import { useEffect } from 'react';
import { TopBar } from './components/TopBar';
import { StatusBar } from './components/StatusBar';
import { FileTree } from './components/FileTree/FileTree';
import { EditorTabs } from './components/EditorTabs/EditorTabs';
import { OfficePreview } from './components/EditorTabs/OfficePreview';
import { ChatPanel } from './components/ChatPanel/ChatPanel';
import { useWorkspaceStore } from './store/workspaceStore';
import { useEditorStore } from './store/editorStore';

export default function App() {
  const init = useWorkspaceStore((s) => s.init);
  const root = useWorkspaceStore((s) => s.root);
  const closeAll = useEditorStore((s) => s.closeAll);

  useEffect(() => {
    void init();
  }, [init]);

  // 工作区切换时清空所有 Tab(避免预览指向已失效路径)
  useEffect(() => {
    closeAll();
  }, [root, closeAll]);

  return (
    <div className="h-screen w-screen flex flex-col bg-neutral-900 text-neutral-100 overflow-hidden">
      <TopBar />
      <div className="flex-1 flex min-h-0">
        {/* 左:文件树 */}
        <FileTree />
        {/* 中:编辑器 Tab + 预览 */}
        <main className="flex-1 min-w-0 flex flex-col bg-neutral-900">
          <EditorTabs />
          <OfficePreview />
        </main>
        {/* 右:聊天面板(SSE 流式 + 选中文件上下文注入) */}
        <ChatPanel />
      </div>
      <StatusBar />
    </div>
  );
}
