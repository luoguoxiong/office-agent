/**
 * ai-office Office 智能体 Runtime 装配 + 流式编排。
 *
 * 单 Agent 设计:一个 Runtime 挂载 Office 工具 + 文件工具,LLM 识别意图生成
 * officecli 参数。通过 ResultChunk 归一化为 SSE 事件:
 *   text → 回答增量;thinking → 思考;tool_start/tool_end → 工具执行;
 *   file → office_exec 成功修改文件(供前端刷新预览);done → 完成。
 *
 * file 事件实现:office_exec 工具内部通过 requestCtx.onFileModified 回调上报
 * 修改的文件路径(AsyncLocalStorage 隔离并发请求),runOfficeAgent 在 tool_end 后 drain。
 */
import path from 'node:path';
import {
  createRuntime,
  createRequest,
  createFileSessionStorage,
  createAllowListPolicy,
  type Model,
  type StreamFn,
  type Runtime,
} from '@aipack-ai/agent';
import { createOfficeTools } from './tools/office-tools.js';
import { createFileTools } from './tools/file-tools.js';
import { createWorkspace, type Workspace } from './workspace.js';
import { requestCtx } from './request-context.js';

const OFFICE_SYSTEM_PROMPT = `你是 Office 文档智能助手,可以读取、修改 Excel/Word/PPT 文件的内容。

⚠️ 重要:能力边界(必须严格遵守)
你【只能修改当前选中的那一个文件】的内容。这是出于安全设计,不可逾越:
- 禁止新建文件:不能创建任何新文件;office_exec 的 filePath 必须等于当前选中文件。
- 禁止删除文件:你不具备删除文件的能力,也不要尝试。
- 禁止修改其他文件:只能对当前选中文件执行 office_exec;若用户请求改别的文件,请礼貌说明,并建议先在左侧文件树切换到目标文件。
- 当用户的请求超出上述边界(如"新建一个文件""删除文件""修改另一个文件")时,不要调用工具,直接用友好的中文向用户解释:你只能修改当前选中文件的内容,不支持新增/删除文件,并给出可行的替代建议(如"请先在左侧文件树打开目标文件")。

可用工具:
- office_read:读取 Office 文档内容(xlsx -> 单元格文本;docx/pptx -> 结构大纲)。修改前先读当前文件以了解结构。
- office_help:查询 OfficeCLI 能力参考(某格式的元素清单 / 某元素的完整属性语法),生成命令前不确定语法时先查。
- office_exec:对【当前选中文件】执行 officecli batch 命令(add/set/remove 元素)以修改其内容。filePath 参数必须填当前选中文件路径,传其他路径会被系统拒绝。
- file_tree:工作区递归目录树(用户说"列出所有 Excel"时调用,仅查看)。

操作规则:
1. 所有文件路径一律使用「相对工作区的相对路径」,如 "report.xlsx",禁止使用绝对路径。
2. 修改文件前,必须先用 office_read 读原文,确定元素路径(add 用 parent 如 '/slide[1]'、'/body';set/remove 用 path 如 '/slide[2]'、'/Sheet1/A1')再生成命令。
3. 生成 office_exec 的 commands 时,不确定某元素的路径/属性名/属性值时,先调用 office_help 查询(如 office_help format='xlsx' topic='autofilter'、topic='cell'、topic='sort'),不要凭记忆编造属性名。
4. office_exec 的 filePath 必须与当前选中文件完全一致;不要传其他路径,系统会拒绝。
   - pptx:先 add slide(可带 background 渐变如 "0F172A-7C3AED")再向 slide 添加 shape/chart/table;
   - docx:add paragraph / markdown / table;标题如需样式先 add style(Heading1-6);
   - xlsx:add sheet(name)后逐格 add cell(ref='A1', value=...);修改或设置样式用 set cell,path 指向单元格或范围(如 '/Sheet1/A1:K1');表头筛选用 add autofilter(range='A1:K300'),按列排序用 set sheet(sort='B desc', sortHeader='true')。
5. 修改策略:Excel 用 set cell / add row / remove 做精准修改;Word/PPT 可 remove 后重新 add 或全量重写当前文件,保证内容完整。
6. 生成 PPT 时产出高质量结构化大纲:内容精炼每页 3-6 条短句要点,有数据对比时用 chart 元素,每页 shape 用英寸坐标布局。
7. 生成 Word 时使用规范的段落结构(标题/列表/表格/加粗),避免通篇平铺文本。
8. 修改文档后,建议调用 office_read 自查结构是否完整。
9. 完成后在回答中说明修改的文件路径与内容概要。回答使用中文。`;

export interface OfficeEvent {
  type: 'text' | 'tool_start' | 'tool_end' | 'thinking' | 'done' | 'error' | 'file' | 'warning';
  content?: string;
  toolName?: string;
  isError?: boolean;
  /** file 事件:被修改的文件相对工作区路径 */
  filePath?: string;
}

export interface OfficeInput {
  message: string;
  sessionKey?: string;
  /** 用户选中的目标文件(相对工作区路径) */
  filePath?: string;
}

/**
 * 构建 Office 智能体 Runtime。
 * @param workspaceRoot 文件工作区绝对路径(工具读写都限制在此目录内)
 */
export async function createOfficeRuntime(
  model: Model,
  streamFn: StreamFn,
  workspaceRoot: string,
): Promise<Runtime> {
  const ws: Workspace = await createWorkspace(workspaceRoot);
  const tools = [...createOfficeTools(ws), ...createFileTools(ws)];
  return createRuntime({
    model,
    streamFn,
    systemPrompt: OFFICE_SYSTEM_PROMPT,
    tools,
    sessionStorage: createFileSessionStorage({
      baseDir: path.join(workspaceRoot, '.aipack', 'sessions'),
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 天
    }),
    // 框架级权限层默认 fail-closed:不配置策略则所有工具被拒
    // ("permission denied — no permissionPolicy configured")。
    // 这里放行且仅放行本项目自建的 Office/文件工具(名称从 tools 派生,新增工具自动纳入),
    // 未登记的工具一律 deny。文件读写的工作区边界、当前选中文件校验、
    // 越界路径拦截仍由各工具内部兜底(见 tools/office-tools.ts)。
    permissionPolicy: createAllowListPolicy({ allow: tools.map((t) => t.name) }),
    maxTurns: 15,
    config: { role: 'office-assistant', workspace: workspaceRoot, toolCount: tools.length },
  });
}

/**
 * 流式执行一次 Office 任务,把底层 chunk 归一化为 OfficeEvent 回调。
 * 错误(含 aborted)以异常抛出,由调用方转 SSE error。
 *
 * 通过 requestCtx.run 注入 per-request 的 onFileModified 回调,
 * office_exec 工具执行成功后通过该回调上报修改的文件路径,
 * 在 tool_end(office_exec, !isError) 后 drain 为 file 事件。
 *
 * 防卡死:AbortSignal 在「每个 chunk 之间」+「for-await 整体 Promise 层」双通道检测,
 * 即使 runtime.stream(req) 卡在底层 await(不产出 chunk),abort 也能中断整个任务。
 */
export async function runOfficeAgent(
  input: OfficeInput,
  runtime: Runtime,
  onEvent: (e: OfficeEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  // 选中文件时,把目标文件上下文注入消息头部,引导 Agent 先读该文件再修改
  let message = input.message;
  if (input.filePath) {
    message =
      `【当前选中文件】工作区相对路径: ${input.filePath}\n` +
      `你只能修改这一个文件的内容。office_exec 的 filePath 必须填 "${input.filePath}",禁止新建/删除文件、禁止修改其他文件。请先读取该文件,再按用户要求修改其内容。\n` +
      `---\n${message}`;
  } else {
    // 未选中文件:告知 Agent 无可修改目标,不要执行写操作
    message =
      `【当前未选中任何文件】你目前没有可修改的目标文件,请不要调用 office_exec。\n` +
      `若用户想修改文件,请用友好的中文提示:先在左侧文件树打开一个 Office 文件,助手才能修改它的内容(助手仅支持修改当前选中文件,不支持新增或删除文件)。\n` +
      `---\n${message}`;
  }
  const req = createRequest(message, { sessionKey: input.sessionKey ?? 'default' });

  // ── 构建 aborted Promise:信号触发时立刻 reject,用于 race 中断 for-await ──
  let removeAbortListener: (() => void) | undefined;
  const abortedP = new Promise<never>((_, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  abortedP.catch(() => {}); // 防 unhandledRejection

  const raiseIfAborted = () => {
    if (signal?.aborted) throw new Error('aborted');
  };

  const pendingFiles: string[] = [];
  // 累计这一轮产出的工具调用数 + 文本字符数,用于 done 时检测 stopReason=length 的"空产出"
  let toolCallsThisTurn = 0;
  let textCharsThisTurn = 0;
  let lastDoneResult: { stopReason?: string; toolsUsed?: string[]; usage?: Record<string, number> } | undefined;

  try {
    await requestCtx.run({ onFileModified: (fp) => pendingFiles.push(fp), currentFilePath: input.filePath }, async () => {
      const iter = runtime.stream(req)[Symbol.asyncIterator]();
      // 注意:iter 是原生 AsyncGenerator;不能直接传 signal 进去,用 Promise.race 中断
      try {
        while (true) {
          raiseIfAborted();
          // 每一步 next 都和 abortedP race:即便是卡在「LLM 返回第一个 token」这种情况,
          // abort 也能让整个 runOfficeAgent 立刻跳出,不会等到 LLM 超时
          const step = await Promise.race([iter.next(), abortedP]);
          raiseIfAborted();
          if (step.done) break;
          const chunk = step.value;

          switch (chunk.type) {
            case 'text':
              if (chunk.content) {
                textCharsThisTurn += chunk.content.length;
                onEvent({ type: 'text', content: chunk.content });
              }
              break;
            case 'thinking':
              if (chunk.content) onEvent({ type: 'thinking', content: chunk.content });
              break;
            case 'tool_start':
              toolCallsThisTurn++;
              onEvent({ type: 'tool_start', toolName: chunk.toolName });
              break;
            case 'tool_end':
              onEvent({ type: 'tool_end', toolName: chunk.toolName, isError: chunk.isError });
              // office_exec 成功后,drain 上报的修改文件,推 file 事件
              if (chunk.toolName === 'office_exec' && !chunk.isError) {
                while (pendingFiles.length) {
                  onEvent({ type: 'file', filePath: pendingFiles.shift()! });
                }
              }
              break;
            case 'error':
              throw new Error(chunk.content || '运行出错');
            case 'done':
              // 保留最终 result(stopReason / toolsUsed / usage)用于"空产出告警"
              if (chunk.result) {
                lastDoneResult = {
                  stopReason: chunk.result.stopReason,
                  toolsUsed: chunk.result.toolsUsed,
                  usage: chunk.result.usage,
                };
              }
              break;
          }
        }
      } finally {
        // 关键:手动迭代器 + abort 抛错时,for-await 的隐式 gen.return() 不会跑,
        // 必须显式调用 iter.return() 触发上游 generator 的 finally 块
        // (streamWithStorageLock 里的 lock.release()),否则会话锁永久泄漏。
        await iter.return?.(undefined);
      }
    });
  } finally {
    removeAbortListener?.();
  }

  // ── stopReason=length 空产出告警 ──
  // 现象:模型把全部 output tokens(默认仅 8192)都花在 thinking 草稿上,
  // 真正的 text/toolCall 还没生成就被 provider 截断了 → stopReason='length'。
  // 此时 UI 上只会看到 thinking 输出、看不到任何动作完成 → 用户以为"卡死"。
  // 这里显式识别并上报 warning 事件,后端日志同时打 warning,便于直接定位。
  if (
    lastDoneResult?.stopReason === 'length' &&
    toolCallsThisTurn === 0 &&
    textCharsThisTurn === 0
  ) {
    const u = lastDoneResult.usage ?? {};
    const inp = u.input ?? '?';
    const out = u.output ?? '?';
    const tot = u.total ?? '?';
    const msg =
      '模型本轮回复因 output 配额用尽被截断(stopReason=length),' +
      ' 大量 token 被思考草稿占用,未能产出实际动作或回复。' +
      ' 请重试或切换支持更大 max_tokens 的模型(如 deepseek-v4-flash 32K 以上)。' +
      ` (usage: input=${inp} output=${out} total=${tot})`;
    console.warn(`[runtime] ⚠️ ${msg}`);
    onEvent({ type: 'warning', content: msg });
  }

  onEvent({ type: 'done' });
}
