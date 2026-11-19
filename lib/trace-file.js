/**
 * 行为流水落盘（JSONL）。
 *
 * 为什么必须缓冲：`recordTrace` 在 `session/event` 热路径上，同步 append 会直接
 * 拖慢 post-commit 广播（性能门禁测的就是这条路径）。所以这里只入队，
 * 由定时器合并成一次 `appendFileSync`。
 *
 * 边界：
 *   - 每会话一个文件 `<root>/.dsh/ledger/<safe>.trace.jsonl`；
 *   - 队列有上限，满了就丢最旧的并计数（宁可丢流水，不拖慢宿主）；
 *   - 单文件超过 maxBytes 后停止追加，只写一次"截断"提示行；
 *   - 所有异常吞掉并计数，绝不向调用方抛。
 */
import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import { PANEL_DIR, safeFileName } from './panel-path.js'

/** 流水文件的后缀，与快照文件区分。 */
export const TRACE_SUFFIX = '.trace.jsonl'

/**
 * @param {object} options
 * @param {string} [options.dir] - 相对会话工作区根
 * @param {string} [options.rootOf]
 * @param {number} [options.maxBytes] - 单文件上限
 * @param {number} [options.intervalMs] - 合并写盘间隔
 * @param {number} [options.maxQueued] - 每会话队列上限
 * @param {() => number} [options.now]
 */
export function createTraceSink(options) {
  const relativeDir = options.dir ?? PANEL_DIR
  const fixedDir = isAbsolute(relativeDir) ? relativeDir : null
  const rootOf = typeof options.rootOf === 'function' ? options.rootOf : () => process.cwd()
  const dirOf = (sessionId) => (fixedDir !== null ? fixedDir : resolve(rootOf(sessionId), relativeDir))
  const maxBytes = Math.max(64 * 1024, Number(options.maxBytes ?? 4 * 1024 * 1024))
  const intervalMs = Math.max(50, Number(options.intervalMs ?? 500))
  const maxQueued = Math.max(2, Number(options.maxQueued ?? 1000))
  const now = options.now ?? Date.now

  /** sessionId → string[]（已序列化好的行） */
  const queues = new Map()
  const sealed = new Set() // 超过 maxBytes 的会话，后续直接丢
  const stats = { lines: 0, dropped: 0, errors: 0, sealed: 0 }

  function filePathOf(sessionId) {
    return join(dirOf(sessionId), `${safeFileName(sessionId)}${TRACE_SUFFIX}`)
  }

  /** 热路径：只做一次 Map 取 + push，不做任何 IO。 */
  function append(sessionId, record) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    if (sealed.has(sessionId)) {
      stats.dropped += 1
      return false
    }
    let line
    try {
      line = JSON.stringify(record)
    } catch {
      stats.errors += 1
      return false
    }
    let queue = queues.get(sessionId)
    if (queue === undefined) {
      queue = []
      queues.set(sessionId, queue)
    }
    if (queue.length >= maxQueued) {
      queue.shift() // 丢最旧：保留最近的行为，避免无限占内存
      stats.dropped += 1
    }
    queue.push(line)
    return true
  }

  /** 把队列写成文件；由定时器或 dispose 调用。 */
  function flush() {
    for (const [sessionId, queue] of queues) {
      if (queue.length === 0) continue
      const path = filePathOf(sessionId)
      try {
        mkdirSync(dirOf(sessionId), { recursive: true })
        let size = 0
        try {
          size = statSync(path).size
        } catch {
          size = 0 // 文件还不存在
        }
        let body = ''
        let written = 0
        for (const line of queue) {
          if (size + body.length + line.length + 1 > maxBytes) break
          body += `${line}\n`
          written += 1
        }
        if (body.length > 0) appendFileSync(path, body, 'utf8')
        if (written < queue.length) {
          // 到上限了：写一条自解释的收尾行，然后封口
          if (!sealed.has(sessionId)) {
            appendFileSync(path, `${JSON.stringify({ truncated: true, at: now(), dropped: queue.length - written })}\n`, 'utf8')
            sealed.add(sessionId)
            stats.sealed += 1
          }
          stats.dropped += queue.length - written
        }
        queue.length = 0
        stats.lines += written
      } catch {
        stats.errors += 1
        queue.length = 0
      }
    }
  }

  let timer = null
  if (intervalMs > 0) {
    timer = setInterval(flush, intervalMs)
    // 别为了写流水把进程拖住
    if (typeof timer.unref === 'function') timer.unref()
  }

  function dispose() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    flush()
    queues.clear()
    sealed.clear()
  }

  /** 会话结束：丢掉它的队列与封口标记，避免按会话索引无界增长 */
  function remove(sessionId) {
    queues.delete(sessionId)
    sealed.delete(sessionId)
  }

  return { append, flush, dispose, stats, filePathOf, dirOf, remove }
}
