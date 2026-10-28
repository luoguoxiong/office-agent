/** 文件/目录图标:office 文件按类型区分,其余按扩展名归类 */

export function fileIcon(ext?: string): string {
  if (!ext) return '📄';
  const e = ext.toLowerCase();
  if (e === '.xlsx' || e === '.xls' || e === '.csv') return '📊';
  if (e === '.docx' || e === '.doc') return '📝';
  if (e === '.pptx' || e === '.ppt') return '📽️';
  if (e === '.pdf') return '📕';
  if (e === '.png' || e === '.jpg' || e === '.jpeg' || e === '.gif' || e === '.svg' || e === '.webp') return '🖼️';
  if (e === '.md') return '📘';
  if (e === '.json') return '🔧';
  if (e === '.txt' || e === '.log') return '📃';
  if (e === '.html' || e === '.htm') return '🌐';
  return '📄';
}

/** office 文件高亮色(供文件名着色,VSCode 风格) */
export function fileColor(ext?: string): string {
  if (!ext) return 'text-neutral-300';
  const e = ext.toLowerCase();
  if (e === '.xlsx' || e === '.xls' || e === '.csv') return 'text-green-400';
  if (e === '.docx' || e === '.doc') return 'text-blue-400';
  if (e === '.pptx' || e === '.ppt') return 'text-orange-400';
  return 'text-neutral-300';
}

/** 是否 office 文件(双击打开预览) */
export function isOfficeExt(ext?: string): boolean {
  if (!ext) return false;
  const e = ext.toLowerCase();
  return e === '.xlsx' || e === '.docx' || e === '.pptx' || e === '.xls' || e === '.doc' || e === '.ppt' || e === '.csv';
}
