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
import { normalizeUsage } from './usage.js'

const MODEL_EVENTS = new Set(['assistant/message', 'assistant/attempt'])
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
export function createLedger({ store, pricing, attribution, trace, onEntry, now = () => Date.now() }) {
  let failures = 0
  let handled = 0

  /**
   * 唯一入账出口。`onEntry` 是给 Budget Guard 的正式钩子，
   * 不再用替换 store.recordEntry 的方式挂副作用（那会污染 store 的职责边界）。
   */
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
    const route = routeOf(event)
    const cost = pricing.costOf(usage, route)

    // 因果映射：本步请求由 **上一轮** 的工具结果推动，因此归因取 step-1 的工具集
    const drivingTools = store.toolsForStep(sessionId, turn, step - 1)
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
    })

    const record = trace.project({
      sessionId, turn, step,
      eventType: 'chat',
      pluginSource: attr.primary?.plugin ?? null,
      usage,
      cost,
      summary: route ? `${route.provider ?? '?'}/${route.model ?? '?'}` : 'model call',
      at: now(),
    })
    if (record) store.recordTrace(sessionId, record)
  }

  /** tool/call：记录工具名，供下一步归因 */
  function onToolCall(session, event) {
    const sessionId = sessionIdOf(session)
    if (!sessionId || typeof event.name !== 'string') return
    store.noteToolCall(sessionId, event.turn ?? 0, event.step ?? 0, event.name)

    const attr = attribution.forTool(event.name)
    const record = trace.project({
      sessionId,
      turn: event.turn ?? 0,
      step: event.step ?? 0,
      eventType: 'execute_tool',
      pluginSource: attr.primary?.plugin ?? null,
      usage: null,
      cost: null,
      summary: `${event.name} ${event.callId ?? ''}`,
    })
    if (record) store.recordTrace(sessionId, record)
  }

  /** compaction/*：压缩成本必须单列，不能算到业务插件头上 */
  function onCompaction(session, event, type) {
    const sessionId = sessionIdOf(session)
    if (!sessionId) return
    const usage = normalizeUsage(event.usage ?? event.message?.usage)
    const cost = pricing.costOf(usage, routeOf(event))

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
    })

    const record = trace.project({
      sessionId,
      turn: event.turn ?? 0,
      step: event.step ?? 0,
      eventType: 'compaction',
      pluginSource: 'system:compaction',
      usage,
      cost,
      summary: type,
    })
    if (record) store.recordTrace(sessionId, record)
  }

  function onSessionEvent(session, event) {
    handled += 1
    try {
      const type = event?.type
      if (!type) return
      if (MODEL_EVENTS.has(type)) onModelEvent(session, event)
      else if (type === 'tool/call') onToolCall(session, event)
      else if (type.startsWith(COMPACTION_PREFIX)) onCompaction(session, event, type)
    } catch {
      // 采集失败只能计数：绝不让它冒泡到已提交的 append 路径
      failures += 1
    }
  }

  return {
    onSessionEvent,
    stats: () => ({ handled, failures }),
  }
}
