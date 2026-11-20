/**
 * 采集层：session/event 旁路 → 账本条目。
 *
 * 为什么只订阅 session/event：
 *   源码注释写明它是 "Post-commit, fire-and-forget append feed"，
 *   监听器失败会被记录并吞掉，不会让已提交的 append 失败。
 *   这正是治理插件需要的：可观测，且不进入关键路径。
 *
 * 为什么不会阻塞：单事件处理只做常量级工作（复用对象、O(1) 环形写、增量累计）。
 */
import { toolResultChars } from './tool-size.js'
import { normalizeUsage } from './usage.js'

/**
 * 宿主派发的 session/event 实际形状是 {type, seq, time, data, surfaceOp}，
 * 载荷在 data 里；而类型声明（dsh-session types.d.ts）写的是扁平的 {turn,step,message}。
 *
 * 两种都认：data 是普通对象就用它，否则退回事件本身。
 *
 * 这条是 2026-11-20 真机跑出来的：单测当时用的是扁平形状，所以 158 例全绿，
 * 但线上真实事件读不到 turn/usage → 每条都记成 unknown(no-usage)、金额全是 null。
 * 教训：**只测自己假设的契约，等于没测宿主。**
 */
function payloadOf(event) {
  const data = event?.data
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) return data
  return event
}

const MODEL_EVENTS = new Set(['assistant/message', 'assistant/attempt'])
const TOOL_RESULT = 'tool/result'
const COMPACTION_PREFIX = 'compaction/'

/**
 * @param {{
 *   store: import('./store.js').LedgerStore,
 *   pricing: ReturnType<import('./pricing.js').createPricing>,
 *   attribution: ReturnType<import('./attribution.js').createAttribution>,
 *   trace: ReturnType<import('./trace.js').createTrace>,
 *   onEntry?: (sessionId: string, entry: object) => void,
 *   now?: () => number,
 * }} deps
 */
export function createLedger({ store, pricing, attribution, trace, onEntry, cwdOf, identity, now = () => Date.now() }) {
  let failures = 0
  let handled = 0
  /** 无 usage 的模型事件数（assistant/attempt 之类）。它们是"尝试"，不是计费调用。 */
  let skipped = 0

  /**
   * 唯一入账出口。`onEntry` 是给 Budget Guard 的正式钩子，
   * 不再用替换 store.recordEntry 的方式挂副作用（那会污染 store 的职责边界）。
   */
  /** sessionId → {actor, project, deviceId}。解析只发生一次，热路径上只有一次 Map 读。 */
  const identityBySession = new Map()

  function identityFor(sessionId) {
    const hit = identityBySession.get(sessionId)
    if (hit !== undefined) return hit
    if (!identity || typeof identity.resolve !== 'function') return null
    const cwd = typeof cwdOf === 'function' ? cwdOf(sessionId) : null
    const value = identity.resolve(cwd)
    identityBySession.set(sessionId, value)
    return value
  }

  function commit(sessionId, entry) {
    store.recordEntry(sessionId, entry)
    if (typeof onEntry !== 'function') return
    try {
      onEntry(sessionId, entry)
    } catch {
      failures += 1
    }
  }

  function routeOf(event) {
    const source = event?.message?.source
    const provider = source?.provider ?? event?.provider ?? null
    const model = source?.model ?? event?.model ?? null
    return provider || model ? { provider, model } : null
  }

  function sessionIdOf(session) {
    return session?.id ?? session?.sessionId ?? null
  }

  /** assistant/message：模型调用成本 */
  function onModelEvent(session, event) {
    const sessionId = sessionIdOf(session)
    if (!sessionId) return
    const turn = event.turn ?? 0
    const step = event.step ?? 0

    const usage = normalizeUsage(event.usage ?? event.message?.usage)
    // 没有 usage 的模型事件（assistant/attempt）不是计费调用，**不能入账**：
    //   - 它会变成一条 unknown(no-usage)，而 guard 见到 unknownEntries > 0 就整条放弃预算，
    //     于是"预算降级"静默失效，面板还会误报"合计偏低"（实测注入 0 条预算事实）；
    //   - 它也没有任何金额可记，记了只会在明细里多一行"未知"噪音。
    // 计数留在 stats.skipped 里，仍然可观测。
    if (usage === null) {
      skipped += 1
      return
    }
    const route = routeOf(event)
    const cost = pricing.costOf(usage, route)

    // 因果映射：本步请求由 **上一轮** 的工具结果推动，因此归因取 step-1 的工具集
    const drivingTools = store.toolsForStep(sessionId, turn, step - 1)
    // 上一步工具结果有多大：成本高的真实原因往往不是模型单价，而是塞进上下文的体量
    const contextChars = store.resultCharsForStep(sessionId, turn, step - 1)
    // 压缩后的第一条调用：与压缩前的规模对照。只报 token 差，不折算金额——
    // 省下的 token 属于"命中"还是"未命中"无法可靠推断，硬乘单价就是编数字。
    const afterContext = usage === null ? null : (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
    // 绝大多数会话没有待对照的压缩：size 为 0 时直接跳过 Map 访问（热路径少一次哈希）
    const beforeContext = pendingCompaction.size === 0 ? undefined : pendingCompaction.get(sessionId)
    const contextSaved = beforeContext !== null && beforeContext !== undefined && afterContext !== null && beforeContext > afterContext
      ? beforeContext - afterContext
      : null
    if (beforeContext !== null && beforeContext !== undefined) pendingCompaction.delete(sessionId)
    const attr = attribution.forModel({ toolNames: drivingTools })

    commit(sessionId, {
      at: now(),
      sessionId,
      turn,
      step,
      kind: 'model',
      callId: event.callId ?? null,
      usage,
      cost,
      attribution: attr,
      route,
      contextChars: contextChars > 0 ? contextChars : null,
      contextSavedTokens: contextSaved,
      // 缓存命中省下的钱：两个单价都在价表里，差额确定，不需要任何假设
      savedAmount: pricing.savingsOf(usage, route).amount ?? null,
    })

    const record = trace.enabled
      ? trace.project({
          identity: identityFor(sessionId),
          sessionId, turn, step,
          eventType: 'chat',
          pluginSource: attr.primary?.plugin ?? null,
          usage,
          cost,
          summary: route ? `${route.provider ?? '?'}/${route.model ?? '?'}` : 'model call',
          at: now(),
        })
      : null
    if (record) store.recordTrace(sessionId, record)
  }

  /** tool/call：记录工具名，供下一步归因 */
  /** tool/result：只记体积，不记内容（内容可能含用户文件全文，不落账本） */
  function onToolResult(session, event) {
    const sessionId = sessionIdOf(session)
    if (!sessionId) return
    const chars = toolResultChars(event.message)
    store.noteToolResult(sessionId, event.turn ?? 0, event.step ?? 0, chars)

    const record = trace.enabled
      ? trace.project({
      identity: identityFor(sessionId),
      sessionId,
      turn: event.turn ?? 0,
      step: event.step ?? 0,
      eventType: 'tool_result',
      pluginSource: null,
      usage: null,
      cost: null,
      summary: `${chars} chars`,
      })
      : null
    if (record) store.recordTrace(sessionId, record)
  }

  function onToolCall(session, event) {
    const sessionId = sessionIdOf(session)
    if (!sessionId || typeof event.name !== 'string') return
    store.noteToolCall(sessionId, event.turn ?? 0, event.step ?? 0, event.name)

    const attr = attribution.forTool(event.name)
    const record = trace.enabled
      ? trace.project({
      identity: identityFor(sessionId),
      sessionId,
      turn: event.turn ?? 0,
      step: event.step ?? 0,
      eventType: 'execute_tool',
      pluginSource: attr.primary?.plugin ?? null,
      usage: null,
      cost: null,
      summary: `${event.name} ${event.callId ?? ''}`,
      })
      : null
    if (record) store.recordTrace(sessionId, record)
  }

  /** compaction/*：压缩成本必须单列，不能算到业务插件头上 */
  /** 压缩前上下文规模，等压缩后的第一条模型调用来对照。按会话存，会话销毁必须清。 */
  const pendingCompaction = new Map()

  function onCompaction(session, event, type) {
    const sessionId = sessionIdOf(session)
    if (!sessionId) return
    const usage = normalizeUsage(event.usage ?? event.message?.usage)
    const cost = pricing.costOf(usage, routeOf(event))

    // 压缩前的上下文规模：压缩本身是一笔支出，要和"省下来多少"一起看才有意义
    const before = store.lastModelContextTokens(sessionId)
    if (before !== null) pendingCompaction.set(sessionId, before)

    commit(sessionId, {
      at: now(),
      sessionId,
      turn: event.turn ?? 0,
      step: event.step ?? 0,
      kind: 'compaction',
      callId: null,
      usage,
      cost,
      attribution: attribution.forCompaction(),
      route: routeOf(event),
      contextBeforeTokens: before,
    })

    const record = trace.enabled
      ? trace.project({
      identity: identityFor(sessionId),
      sessionId,
      turn: event.turn ?? 0,
      step: event.step ?? 0,
      eventType: 'compaction',
      pluginSource: 'system:compaction',
      usage,
      cost,
      summary: type,
      })
      : null
    if (record) store.recordTrace(sessionId, record)
  }

  function onSessionEvent(session, event) {
    handled += 1
    try {
      const type = event?.type
      if (!type) return
      // 载荷在 data 里（见 payloadOf）。所有 handler 都按扁平形状读，这里统一摊平一次
      const payload = payloadOf(event)
      if (MODEL_EVENTS.has(type)) onModelEvent(session, payload)
      else if (type === 'tool/call') onToolCall(session, payload)
      else if (type === TOOL_RESULT) onToolResult(session, payload)
      else if (type.startsWith(COMPACTION_PREFIX)) onCompaction(session, payload, type)
    } catch {
      // 采集失败只能计数：绝不让它冒泡到已提交的 append 路径
      failures += 1
    }
  }

  return {
    onSessionEvent,
    /** 会话销毁：pendingCompaction 是按会话索引的状态，必须一起释放 */
    forget: (sessionId) => {
      pendingCompaction.delete(sessionId)
      identityBySession.delete(sessionId)
    },
    stats: () => ({ handled, failures, skipped }),
  }
}
