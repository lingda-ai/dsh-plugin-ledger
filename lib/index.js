/**
 * @lingda/ledger —— DSH 运行时账本插件（Host 半）
 *
 * 三条铁律（改动前先读）：
 *   1. 采集只订阅，不 emit、不修改 session/event；
 *   2. 决策只经 agent/request 改 LlmCallConfig，不在工具执行中途中断；
 *   3. 面板只读快照，计量只发生在 Host 半。
 *
 * 性能约定：
 *   - 事件热路径无 async、无 JSON 序列化、无定时器；
 *   - 所有缓存容量固定；
 *   - 任何异常都被吞掉并计数，绝不污染 post-commit 广播。
 */
import { resolveConfig } from './config.js'
import { createPricing } from './pricing.js'
import { LedgerStore } from './store.js'
import { createAttribution } from './attribution.js'
import { createTrace } from './trace.js'
import { createLedger } from './ledger.js'
import { createBudgetGuard } from './guard.js'
import { createLedgerQueryTool } from './audit-tool.js'

export const name = 'ledger'
export const inject = ['sessions', 'tools', 'llm']

// ---------------------------------------------------------------------------
// 预算事实通道 A 的消息构造
//
// 已核实的契约（dsh-llm/lib/types/message.d.ts）：
//   MessageBase = { id, content: ContentBlock[], source: MessageSource }
//   MessageSourceMap.user = { kind: 'user' }
//   createUserMessage({ content, source }) → 带稳定 id 的冻结消息
//
// 所以这里不再"猜消息结构"，而是直接调用运行时的构造函数。
// 动态 import 失败（老版本运行时/裁剪安装）时 A 通道自动不可用，
// 事实退化为只经 ledger_query 拉取——少一个能力，不伪造契约。
// ---------------------------------------------------------------------------
let createUserMessage = null
void import('@deepseek-ai/dsh-llm')
  .then((mod) => {
    if (typeof mod.createUserMessage === 'function') createUserMessage = mod.createUserMessage
  })
  .catch(() => {})

function defaultMessageFactory(fact) {
  if (typeof createUserMessage !== 'function') return null
  const money = (v) => (typeof v === 'number' ? v.toFixed(4) : String(v))
  const cur = fact.currency ?? ''
  const pct = Math.round((fact.remainingRatio ?? 0) * 100)
  const text =
    `[账本] 本会话已花费 ${cur}${money(fact.spent)} / 预算 ${cur}${money(fact.limit)}` +
    `（剩余 ${pct}%）。建议：压缩上下文，或改用更低档的模型继续。`
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  const store = new LedgerStore({
    capacity: config.ledger.capacity,
    traceCapacity: config.trace.capacity,
    traceEnabled: config.trace.enabled,
    maxSessions: config.ledger.maxSessions,
  })

  const pricing = createPricing(config.pricing)
  const attribution = createAttribution(config.attribution)
  const trace = createTrace(config.trace)

  // sessionId → agent：预算事实需要 agent 才能投递到 logged channel
  // agent/created 载荷已核实为 { agent, source, signal? }
  const agents = new Map()

  const guard = createBudgetGuard({
    store,
    config,
    deliver(sessionId, fact) {
      const agent = agents.get(sessionId)
      if (!agent || typeof agent.inject !== 'function') return
      const factory =
        typeof config.budget?.messageFactory === 'function'
          ? config.budget.messageFactory
          : defaultMessageFactory
      const message = factory(fact)
      // 工厂返回 falsy 表示"这次不推送"，不是错误
      if (!message) return
      agent.inject(message)
    },
  })

  const ledger = createLedger({
    store,
    pricing,
    attribution,
    trace,
    onEntry: (sessionId, entry) => guard.onEntry(sessionId, entry),
  })

  ctx.on('session/event', (session, event) => {
    ledger.onSessionEvent(session, event)
  })

  ctx.on('agent/created', ({ agent }) => {
    if (agent?.session?.id) agents.set(agent.session.id, agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.session?.id) agents.delete(agent.session.id)
  })
  // session/disposed 载荷就是 session 本身（不是 {session}）
  ctx.on('session/disposed', (session) => {
    const id = session?.id
    if (!id) return
    agents.delete(id)
    // 会话消失即释放内存：账本不跨会话累积，避免长期运行的内存增长
    store.drop(id)
  })

  ctx.on('agent/request', (payload, next) => guard.onRequest(payload, next))

  ctx.tools.register(createLedgerQueryTool({ store }))

  const api = {
    snapshot: (sessionId, opts) => store.snapshot(sessionId, opts),
    totals: (sessionId) => store.totals(sessionId),
    stats: () => ({ ...ledger.stats(), sessions: store.sessionCount }),
    config,
  }
  // 仓库既有插件统一用 ctx.provide 暴露服务（见 lingzhi-core / lingzhi-workbench）
  ctx.provide('ledger', api)
  return api
}
