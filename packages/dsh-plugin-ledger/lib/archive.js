/**
 * 历史账本归档（JSONL）。
 *
 * 为什么需要它：
 *   账本只在内存里，`session/disposed` 时快照被删——**昨天花了多少无从查起**。
 *   没有历史就没有"本周/本月"、没有周报、没有团队聚合，也就没有商业化的地基。
 *
 * 为什么按天分片：
 *   - 单文件不会无限长，`prune()` 直接按文件名删，不需要读内容；
 *   - 用户能 `grep 2026-11-21` 自查，零工具；
 *   - 以后换 SQLite 时，按天导入是最自然的迁移路径。
 *
 * 为什么落盘不在热路径：
 *   与 trace 同一套路：`append()` 只把已序列化的行推进队列，由定时器合并成一次
 *   `appendFileSync`。任何异常都吞掉并计数——采集失败绝不能影响宿主。
 *
 * 隐私边界（比 trace 更严）：
 *   - 只记**体积与金额**，不记任何对话内容；
 *   - 不记绝对路径；
 *   - `actor`（git email）默认**不落盘**，只有 `includeActor: true` 才带。
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 默认目录：与 device-id、pricing.json 同级 */
export function defaultArchiveDir() {
  return join(homedir(), '.dsh', 'ledger', 'archive')
}

/** 一天的分片文件名：2026-11-21.jsonl */
export function shardNameOf(at) {
  const d = new Date(at)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}.jsonl`
}

/**
 * 一条账本条目 → 一行归档记录。字段名刻意缩短：归档是要长期存的。
 * @param {object} entry - store 里的账本条目
 * @param {{ sessionId?: string, title?: string|null, project?: string|null, device?: string|null, actor?: string|null }} ctx
 */
export function archiveRecordOf(entry, ctx = {}) {
  const usage = entry?.usage ?? null
  const cost = entry?.cost ?? null
  const record = {
    v: 1,
    at: entry?.at ?? null,
    sid: ctx.sessionId ?? entry?.sessionId ?? null,
    turn: entry?.turn ?? null,
    step: entry?.step ?? null,
    kind: entry?.kind ?? null,
  }
  if (typeof ctx.title === 'string' && ctx.title.length > 0) record.title = ctx.title
  if (entry?.route?.provider || entry?.route?.model) {
    record.provider = entry.route.provider ?? null
    record.model = entry.route.model ?? null
  }
  if (usage !== null) {
    // 四档全部保留：少一档就没法用归档重算金额（对账的前提）
    record.tok = {
      i: usage.inputTokens ?? null,
      o: usage.outputTokens ?? null,
      cr: usage.cacheReadTokens ?? 0,
      cw: usage.cacheWriteTokens ?? 0,
    }
    if (usage.complete !== true) record.tokIncomplete = true
  }
  if (cost?.kind === 'known') {
    record.cost = cost.amount
    record.cur = cost.currency ?? null
    record.parts = cost.parts ?? null
  } else {
    // 未知必须原样保留原因：归档里出现 0 就等于把"不知道"说成"没花钱"
    record.cost = null
    record.reason = cost?.reason ?? 'no-cost'
  }
  const attribution = entry?.attribution
  if (typeof attribution?.primary?.plugin === 'string') record.plugin = attribution.primary.plugin
  if (typeof attribution?.system === 'string') record.system = attribution.system
  if (typeof ctx.project === 'string') record.project = ctx.project
  if (typeof ctx.device === 'string') record.device = ctx.device
  if (typeof ctx.actor === 'string') record.actor = ctx.actor
  return record
}

/**
 * @param {object} [options]
 * @param {string} [options.dir] - 归档目录（默认 ~/.dsh/ledger/archive）
 * @param {number} [options.flushMs] - 合并写盘间隔
 * @param {number} [options.maxQueued] - 队列上限（满了丢最旧的并计数，绝不拖慢热路径）
 * @param {number} [options.retentionDays] - 保留天数（默认 90，0 表示不裁剪）
 * @param {() => number} [options.now]
 */
export function createArchive(options = {}) {
  const dir = options.dir ?? defaultArchiveDir()
  const flushMs = Math.max(200, Number(options.flushMs ?? 5000))
  const maxQueued = Math.max(100, Number(options.maxQueued ?? 20000))
  const retentionDays = Math.max(0, Number(options.retentionDays ?? 90))
  const now = options.now ?? Date.now

  /** @type {{at:number, line:string}[]} */
  let queue = []
  const stats = { written: 0, dropped: 0, errors: 0, pruned: 0, flushes: 0 }
  let timer = null

  function enqueue(record) {
    const at = typeof record?.at === 'number' ? record.at : now()
    queue.push({ at, line: JSON.stringify(record) })
    // 队列满了丢最旧的：宁可少历史，也不让内存无界增长
    while (queue.length > maxQueued) {
      queue.shift()
      stats.dropped += 1
    }
    if (timer === null) {
      timer = setInterval(() => flush(), flushMs)
      // Node 环境下不阻止进程退出；浏览器/测试环境没有 unref
      if (typeof timer.unref === 'function') timer.unref()
    }
  }

  /** 把队列按天分片写出；返回写出的行数。 */
  function flush() {
    if (queue.length === 0) return 0
    const byShard = new Map()
    for (const item of queue) {
      const name = shardNameOf(item.at)
      const bucket = byShard.get(name)
      if (bucket === undefined) byShard.set(name, [item.line])
      else bucket.push(item.line)
    }
    queue = []
    let written = 0
    for (const [name, lines] of byShard) {
      try {
        mkdirSync(dir, { recursive: true })
        appendFileSync(join(dir, name), `${lines.join('\n')}\n`, 'utf8')
        written += lines.length
      } catch {
        stats.errors += 1
      }
    }
    stats.written += written
    stats.flushes += 1
    return written
  }

  /**
   * 按保留天数裁剪。只删文件名像日期的分片，绝不碰目录里别的东西。
   * @returns {number} 删除的文件数
   */
  function prune() {
    if (retentionDays <= 0) return 0
    const cutoff = now() - retentionDays * 86_400_000
    let removed = 0
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return 0 // 目录还不存在
    }
    for (const name of names) {
      const match = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name)
      if (match === null) continue
      const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12).getTime()
      if (!Number.isFinite(at) || at >= cutoff) continue
      try {
        rmSync(join(dir, name), { force: true })
        removed += 1
      } catch {
        stats.errors += 1
      }
    }
    stats.pruned += removed
    return removed
  }

  function dispose() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    flush()
  }

  return { dir, enqueue, flush, prune, dispose, stats, get pending() { return queue.length } }
}
