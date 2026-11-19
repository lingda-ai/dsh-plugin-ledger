/**
 * 会话级账本存储。
 *
 * 性能与内存：
 *   - 每个会话固定两块环（账本条目 + 行为流水），容量预先固定，不随会话变长增长；
 *   - 会话数受 maxSessions 约束，Map 的插入顺序直接当 LRU 用，淘汰 O(1)；
 *   - 聚合值是增量维护的，快照不做全量重算。
 *
 * 诚实性：
 *   - 已知金额与未知条目分开累计。unknown 不是 0，不能被平均掉。
 */
import { RingBuffer } from './ring.js'
import { sumUsage } from './usage.js'

export class LedgerStore {
  #sessions = new Map()
  #capacity
  #traceCapacity
  #traceEnabled
  #maxSessions

  constructor({ capacity, traceCapacity, traceEnabled, maxSessions }) {
    this.#capacity = capacity
    this.#traceCapacity = traceCapacity
    this.#traceEnabled = traceEnabled
    this.#maxSessions = maxSessions
  }

  #bucket(sessionId) {
    let bucket = this.#sessions.get(sessionId)
    if (bucket) {
      // LRU touch：重新插入到队尾
      this.#sessions.delete(sessionId)
      this.#sessions.set(sessionId, bucket)
      return bucket
    }
    if (this.#sessions.size >= this.#maxSessions) {
      const oldest = this.#sessions.keys().next().value
      if (oldest !== undefined) this.#sessions.delete(oldest)
    }
    bucket = {
      entries: new RingBuffer(this.#capacity),
      trace: this.#traceEnabled ? new RingBuffer(this.#traceCapacity) : null,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: 0 },
      bySource: new Map(),      // 归因来源 → 已知金额
      unknownCostEntries: 0,
      knownCostEntries: 0,
      costAmount: 0,
      currency: null,
      lastStep: null,
      stepTools: new Map(),     // "turn:step" → Set(toolName)
    }
    this.#sessions.set(sessionId, bucket)
    return bucket
  }

  recordEntry(sessionId, entry) {
    const bucket = this.#bucket(sessionId)
    bucket.entries.push(entry)
    bucket.lastStep = { turn: entry.turn, step: entry.step }

    const usage = entry.usage
    if (usage) {
      bucket.tokens.input += usage.inputTokens ?? 0
      bucket.tokens.output += usage.outputTokens ?? 0
      bucket.tokens.cacheRead += usage.cacheReadTokens
      bucket.tokens.cacheWrite += usage.cacheWriteTokens
      bucket.tokens.reasoning += usage.reasoningTokens
      if (!usage.complete) bucket.tokens.missing += 1
    }

    if (entry.cost?.kind === 'known') {
      bucket.costAmount += entry.cost.amount
      bucket.knownCostEntries += 1
      bucket.currency = entry.cost.currency
      const source = entry.attribution?.system === 'compaction'
        ? 'system:compaction'
        : (entry.attribution?.primary?.plugin ?? 'shared:unknown')
      bucket.bySource.set(source, (bucket.bySource.get(source) ?? 0) + entry.cost.amount)
    } else {
      bucket.unknownCostEntries += 1
    }

    return bucket
  }

  recordTrace(sessionId, record) {
    if (!this.#traceEnabled) return
    const bucket = this.#bucket(sessionId)
    bucket.trace?.push(record)
  }

  noteToolCall(sessionId, turn, step, name) {
    const bucket = this.#bucket(sessionId)
    const key = `${turn}:${step}`
    const set = bucket.stepTools.get(key) ?? new Set()
    set.add(name)
    bucket.stepTools.set(key, set)
    // 只保留最近 8 个步骤的工具集合，防止长会话无限增长
    if (bucket.stepTools.size > 8) {
      const first = bucket.stepTools.keys().next().value
      bucket.stepTools.delete(first)
    }
  }

  toolsForStep(sessionId, turn, step) {
    const bucket = this.#sessions.get(sessionId)
    return [...(bucket?.stepTools.get(`${turn}:${step}`) ?? [])]
  }

  totals(sessionId) {
    const bucket = this.#sessions.get(sessionId)
    if (!bucket) {
      return { cost: { amount: null, currency: null, knownEntries: 0, unknownEntries: 0 }, tokens: null, entries: 0 }
    }
    return {
      cost: {
        // 没有任何已知条目时 amount 就是 null —— 不发布假数字
        amount: bucket.knownCostEntries > 0 ? bucket.costAmount : null,
        currency: bucket.currency,
        knownEntries: bucket.knownCostEntries,
        unknownEntries: bucket.unknownCostEntries,
      },
      tokens: { ...bucket.tokens },
      entries: bucket.entries.size,
    }
  }

  snapshot(sessionId, { lastN = 20 } = {}) {
    const bucket = this.#sessions.get(sessionId)
    if (!bucket) return null
    const top = [...bucket.bySource.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    return Object.freeze({
      sessionId,
      totals: this.totals(sessionId),
      topSources: top.map(([plugin, amount]) => ({ plugin, amount })),
      recent: bucket.entries.last(lastN),
      trace: bucket.trace ? bucket.trace.last(lastN) : null,
    })
  }

  traceTail(sessionId, n) {
    return this.#sessions.get(sessionId)?.trace?.last(n) ?? []
  }

  entriesOf(sessionId) {
    return this.#sessions.get(sessionId)?.entries.toArray() ?? []
  }

  drop(sessionId) {
    this.#sessions.delete(sessionId)
  }

  get sessionCount() {
    return this.#sessions.size
  }
}
