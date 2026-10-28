/**
 * 按 key 的互斥锁:同一文件的并发「读-改-写」整文件操作串行化。
 * Office 原地修改(officecli batch 覆盖)是整文件操作,并发写同一文件会互相覆盖。
 *
 * 修复:之前存在 finally 清理时引用不一致导致 queues 永不删除的 bug(存 next.catch()
 * 却比较 next 原对象),现改为把「最新任务引用」和「队列 Promise」解耦维护。
 */
interface LockEntry {
  /** 最新的排队 Promise 引用(用于 finally 判断是否仍是自己) */
  tail: Promise<unknown>;
}

const queues = new Map<string, LockEntry>();

export async function withFileLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  // 1) 读取(或初始化)上一条尾巴
  let entry = queues.get(key);
  if (!entry) {
    entry = { tail: Promise.resolve() };
    queues.set(key, entry);
  }
  const prevTail = entry.tail;

  // 2) 挂载当前 task,无论前一个成功/失败都执行
  const next = prevTail.then(task, task);

  // 3) 立刻把当前 next 作为新的尾部写入同一个 entry
  entry.tail = next;

  try {
    return await next;
  } finally {
    // 4) 仅当「entry.tail 仍等于本任务的 next」(没有更新的任务排队)时才删 entry
    // 引用一致,终于能可靠清理
    if (entry.tail === next) queues.delete(key);
  }
}
