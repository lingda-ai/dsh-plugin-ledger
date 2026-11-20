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

/**
 * 一条条目的成本记到哪个来源桶。
 *
 * 三种无 primary 的情形必须分开，否则面板会把"拆不开"和"没信号"混成一个数：
 *   - `shared:unknown`：确实有多个已知 owner 共同贡献上下文，但无法拆到单个（多贡献者）
 *   - `unattributed`  ：完全没有归因信号（no-signal / no-origin 且无 owner）
 *   - `system:compaction`：压缩产生的调用，不属于任何插件
 * @param {object} entry
 * @returns {string}
 */
export function sourceKeyOf(entry) {
  const attribution = entry?.attribution
  if (attribution?.system === 'compaction') return 'system:compaction'
  if (typeof attribution?.primary?.plugin === 'string' && attribution.primary.plugin.length > 0) {
    return attribution.primary.plugin
  }
  const owners = (attribution?.sharedContext ?? []).filter(
    (item) => item?.note === 'shared-context-cost' && typeof item.plugin === 'string',
  )
  return owners.length > 0 ? 'shared:unknown' : 'unattributed'
}

export class LedgerStore {
  #sessions = new Map()
  #capacity
  #traceCapacity
  #traceEnabled
  #maxSessions

  /** @type {null | ((sessionId: string, record: object) => void)} */
  #onTrace = null

  constructor({ capacity, traceCapacity, traceEnabled, maxSessions, onTrace = null }) {
    this.#capacity = capacity
    this.#traceCapacity = traceCapacity
    this.#traceEnabled = traceEnabled
    this.#onTrace = typeof onTrace === 'function' ? onTrace : null
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
      bySourceCount: new Map(), // 归因来源 → 条目数（来源数很少，有界）
      unknownCostEntries: 0,
      knownCostEntries: 0,
      // 缓存命中省下的钱（能严格算出来的那一个；压缩节省只给 token，不折钱）
      savedAmount: 0,
      savedEntries: 0,
      costAmount: 0,
      // 四档金额累计：只在已知费率的条目上累加，unknown 不计入
      costParts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      currency: null,
      lastStep: null,
      lastAt: 0,
      stepTools: new Map(),     // "turn:step" → Set(toolName)
      stepResultChars: new Map(), // "turn:step" → number（该步工具结果文本总字符数）
    }
    this.#sessions.set(sessionId, bucket)
    return bucket
  }

  recordEntry(sessionId, entry) {
    const bucket = this.#bucket(sessionId)
    bucket.entries.push(entry)
    bucket.lastStep = { turn: entry.turn, step: entry.step }
    if (typeof entry.at === 'number') bucket.lastAt = entry.at

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
      const parts = entry.cost.parts
      if (parts) {
        bucket.costParts.input += parts.input ?? 0
        bucket.costParts.output += parts.output ?? 0
        bucket.costParts.cacheRead += parts.cacheRead ?? 0
        bucket.costParts.cacheWrite += parts.cacheWrite ?? 0
      }
      const source = sourceKeyOf(entry)
      bucket.bySource.set(source, (bucket.bySource.get(source) ?? 0) + entry.cost.amount)
      bucket.bySourceCount.set(source, (bucket.bySourceCount.get(source) ?? 0) + 1)
    } else {
      bucket.unknownCostEntries += 1
    }

    // 与成本分开累加：费率未知的条目算不出节省，就和算不出成本一样处理，不冒充 0
    if (typeof entry.savedAmount === 'number' && Number.isFinite(entry.savedAmount)) {
      bucket.savedAmount += entry.savedAmount
      bucket.savedEntries += 1
    }

    return bucket
  }

  recordTrace(sessionId, record) {
    if (!this.#traceEnabled) return
    const bucket = this.#bucket(sessionId)
    bucket.trace?.push(record)
    // 落盘钩子必须是同步且廉价的（只入队）；IO 由 sink 自己合并
    if (typeof this.#onTrace === 'function') this.#onTrace(sessionId, record)
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

  /**
   * 记一次工具结果的体积。同一步可以调多次工具，累加。
   * 只保留最近 8 步——与 stepTools 同一窗口，避免两条索引不同步。
   */
  noteToolResult(sessionId, turn, step, chars) {
    if (!Number.isFinite(chars) || chars <= 0) return
    const bucket = this.#bucket(sessionId)
    const key = `${turn}:${step}`
    bucket.stepResultChars.set(key, (bucket.stepResultChars.get(key) ?? 0) + chars)
    if (bucket.stepResultChars.size > 8) {
      const first = bucket.stepResultChars.keys().next().value
      bucket.stepResultChars.delete(first)
    }
  }

  /**
   * 最近一条模型调用的"上下文规模" = 未命中输入 + 缓存命中输入。
   * 压缩前用它当前值，压缩后用下一步的值，差额才是"压缩省下的上下文"。
   */
  lastModelContextTokens(sessionId) {
    const bucket = this.#sessions.get(sessionId)
    if (!bucket) return null
    const entries = bucket.entries.last(20) ?? []
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i]
      if (entry?.kind !== 'model' || entry.usage === null) continue
      return (entry.usage.inputTokens ?? 0) + (entry.usage.cacheReadTokens ?? 0)
    }
    return null
  }

  /** 该步工具结果文本总字符数；没有记录就是 0（不是未知，确实没结果） */
  resultCharsForStep(sessionId, turn, step) {
    const bucket = this.#sessions.get(sessionId)
    return bucket?.stepResultChars.get(`${turn}:${step}`) ?? 0
  }

  toolsForStep(sessionId, turn, step) {
    const bucket = this.#sessions.get(sessionId)
    return [...(bucket?.stepTools.get(`${turn}:${step}`) ?? [])]
  }

  totals(sessionId) {
    // 只读视图：不 touch LRU。否则面板每 30s 轮询就把所有会话续命，淘汰策略会失效。
    const bucket = this.#sessions.get(sessionId)
    if (!bucket) {
      return {
        cost: { amount: null, currency: null, knownEntries: 0, unknownEntries: 0, parts: null },
        saved: { amount: null, currency: null, entries: 0 },
        tokens: null,
        entries: 0,
      }
    }
    return {
      cost: {
        // 没有任何已知条目时 amount 就是 null —— 不发布假数字
        amount: bucket.knownCostEntries > 0 ? bucket.costAmount : null,
        currency: bucket.currency,
        knownEntries: bucket.knownCostEntries,
        unknownEntries: bucket.unknownCostEntries,
        // 四档金额：一条已知条目都没有时给 null（面板显示"未计价"）
        parts: bucket.knownCostEntries > 0 ? { ...bucket.costParts } : null,
      },
      // 缓存节省：没有可算的条目时 amount 为 null，面板据此不显示这一行
      saved: {
        amount: bucket.savedEntries > 0 ? bucket.savedAmount : null,
        currency: bucket.savedEntries > 0 ? bucket.currency : null,
        entries: bucket.savedEntries,
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
      generatedAt: Date.now(),
    })
  }

  /**
   * 全部来源（不截断到 Top3）。
   *
   * 只读聚合，纯前端无法伪造：unknown 条目不进入金额排序，但单独计数返回，
   * 让调用方自己决定"未知要不要参与排名"，而不是由 store 悄悄补 0。
   *
   * @param {string} sessionId
   * @param {{ limit?: number, sort?: 'amount'|'entries'|'name' }} [opts]
   */
  sources(sessionId, { limit = 20, sort = 'amount' } = {}) {
    const bucket = this.#sessions.get(sessionId)
    if (!bucket) return null
    const all = [...bucket.bySource.entries()].map(([plugin, amount]) => ({
      plugin,
      amount,
      entries: bucket.bySourceCount.get(plugin) ?? 0,
    }))
    const cmp = {
      amount: (a, b) => b.amount - a.amount || a.plugin.localeCompare(b.plugin),
      entries: (a, b) => b.entries - a.entries || a.plugin.localeCompare(b.plugin),
      name: (a, b) => a.plugin.localeCompare(b.plugin),
    }[sort] ?? ((a, b) => b.amount - a.amount)
    all.sort(cmp)
    const total = this.totals(sessionId)
    const shown = all.slice(0, Math.max(1, limit))
    return Object.freeze({
      sessionId,
      sort,
      total: total.cost.amount,
      unknownEntries: total.cost.unknownEntries,
      knownEntries: total.cost.knownEntries,
      sourceCount: all.length,
      truncated: shown.length < all.length,
      sources: shown.map((s) => Object.freeze({
        ...s,
        share: total.cost.amount ? s.amount / total.cost.amount : null,
      })),
      generatedAt: Date.now(),
    })
  }

  /**
   * 跨会话概览：按 LRU 顺序（最近使用在前）返回各会话的汇总。
   *
   * 只遍历会话表，不遍历条目，成本 O(maxSessions)；maxSessions 有硬上限 64。
   */
  overview({ limit = 64 } = {}) {
    const ids = [...this.#sessions.keys()].reverse()
    const shown = ids.slice(0, Math.max(1, limit))
    const sessions = shown.map((id) => {
      const b = this.#sessions.get(id)
      return Object.freeze({
        sessionId: id,
        cost: Object.freeze({
          amount: b.knownCostEntries > 0 ? b.costAmount : null,
          currency: b.currency,
          knownEntries: b.knownCostEntries,
          unknownEntries: b.unknownCostEntries,
        }),
        tokens: Object.freeze({ ...b.tokens }),
        entries: b.entries.size,
        lastAt: b.lastAt || null,
      })
    })
    return Object.freeze({
      generatedAt: Date.now(),
      sessionCount: this.#sessions.size,
      truncated: shown.length < this.#sessions.size,
      sessions,
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
