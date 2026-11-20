/**
 * @lingda-ai/ledger —— DSH 运行时账本插件（Host 半）
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
import { loadPricingOverride, pricingMetaOf } from './pricing-file.js'
import { BUILTIN_AS_OF, BUILTIN_SOURCE } from './pricing-table.js'
import { LedgerStore } from './store.js'
import { createAttribution } from './attribution.js'
import { createTrace } from './trace.js'
import { createLedger } from './ledger.js'
import { createIdentity } from './identity.js'
import { createBudgetGuard } from './guard.js'
import { createLedgerQueryTool } from './audit-tool.js'
import { makeBudgetMessage } from './budget-message.js'
import { createSnapshotPublisher } from './snapshot-file.js'
import { PANEL_DIR } from './panel-path.js'
import { createTraceSink } from './trace-file.js'

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
// 构造函数惰性加载到 userMessageCtor，随后交给纯函数 makeBudgetMessage 使用。
// 拿不到构造函数（老运行时/裁剪安装）时 A 通道自动不可用，
// 事实退化为只经 ledger_query 拉取——少一个能力，不伪造契约。
// ---------------------------------------------------------------------------
let userMessageCtor = null
void import('@deepseek-ai/dsh-llm')
  .then((mod) => {
    if (typeof mod.createUserMessage === 'function') userMessageCtor = mod.createUserMessage
  })
  .catch(() => {})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  // 每个会话的工作区根：面板与流水都写进各自的工作区，而不是进程 cwd
  // （session.header.cwd 已核实为会话创建时的绝对工作目录）
  const sessionRoots = new Map()

  // 流水落盘：trace.enabled 且 trace.file.enabled 才开（两层开关，隐私优先）
  // rootOf 在 store 构造时还拿不到会话 cwd，所以先给默认；append 时按会话解析。
  const traceSink =
    config.trace.enabled === true && config.trace.file?.enabled === true
      ? createTraceSink({
          dir: config.panel?.dir ?? '.dsh/ledger',
          maxBytes: config.trace.file.maxBytes,
          rootOf: (sessionId) => sessionRoots?.get(sessionId) ?? process.cwd(),
        })
      : null

  const store = new LedgerStore({
    capacity: config.ledger.capacity,
    traceCapacity: config.trace.capacity,
    traceEnabled: config.trace.enabled,
    maxSessions: config.ledger.maxSessions,
    onTrace: traceSink === null ? null : (sessionId, record) => traceSink.append(sessionId, record),
  })

  // 费率覆盖：boot 时读一次（热路径不做 IO）。文件不存在不算错误；
  // 写坏了必须留痕——静默回退内置价会让人以为自己的费率生效了。
  const pricingOverride = loadPricingOverride({ path: config.pricing?.file ?? undefined })
  const pricingMeta = pricingMetaOf(pricingOverride, { asOf: BUILTIN_AS_OF, source: BUILTIN_SOURCE })
  const effectivePricing =
    pricingOverride.kind === 'ok'
      ? {
          ...config.pricing,
          // 只覆盖同名模型，内置其余模型继续可用（不是"全量替换"）
          rates: { ...config.pricing.rates, ...pricingOverride.rates },
          currency: pricingOverride.currency ?? config.pricing.currency,
        }
      : config.pricing

  const pricing = createPricing(effectivePricing)
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
      const factory = config.budget?.messageFactory
      const message =
        typeof factory === 'function'
          ? factory(fact)
          : makeBudgetMessage(fact, userMessageCtor)
      // 工厂返回 falsy 表示"这次不推送"，不是错误
      if (!message) return
      agent.inject(message)
    },
  })

  // 右侧栏面板的数据通道：Host 落快照 JSON，浏览器半用 workspace 文件 remote 读回。
  // 默认关闭（config.panel.enabled），打开才有写盘副作用。
  // 客户端的读路径固定是 <session cwd>/.dsh/ledger/<safe>.json（panel-path.js 两侧共用）。
  // 自定义 panel.dir 会让 Host 写到别处、面板读空——这不是"配置不生效"，是"看不到"，
  // 必须显性说出来，否则用户会以为是插件坏了。
  if (config.panel?.enabled === true && (config.panel.dir ?? PANEL_DIR) !== PANEL_DIR) {
    console.warn(
      `[ledger] panel.dir=${JSON.stringify(config.panel.dir)} 与浏览器侧的固定读路径 ${PANEL_DIR} 不一致，`
      + '面板将读不到快照。面板开启时请保持默认目录。',
    )
  }

  const publisher =
    config.panel?.enabled === true
      ? createSnapshotPublisher({
          dir: config.panel.dir,
          intervalMs: config.panel.intervalMs,
          maxBytes: config.panel.maxBytes,
          rootOf: (sessionId) => sessionRoots.get(sessionId) ?? process.cwd(),
          // 预算读数：面板画进度条用，口径来自配置，不由前端推算
          budget: { limit: config.budget?.limit ?? null, currency: config.pricing?.currency ?? 'CNY' },
          // 会话对比：只读 overview，不 touch LRU（store 已保证）
          overview: () => store.overview({ limit: 8 }),
          snapshot: (sessionId, opts) => store.snapshot(sessionId, opts),
          sources: (sessionId, opts) => store.sources(sessionId, opts),
          // 面板必须知道"这些金额是拿哪套价算的"，否则数字不可信
          pricing: pricingMeta,
          // 标题：让面板能说"这笔钱是哪段对话花的"
          titleOf: (sessionId) => titles.get(sessionId) ?? null,
        })
      : null

  // 会话标题：右栏只显示 "sessio…affe8" 时用户没法把它和对话对上。
  // 标题通过 session/event 的 session/title 事件到达（数据在 data 里，与其它事件一致）。
  const titles = new Map()

  // 身份线索（actor/project/deviceId）：解析只发生在会话第一条事件上，热路径零成本。
  // 读的是 .git/config 与 ~/.gitconfig 两个小文件，**不起 git 子进程**。
  const identity = createIdentity()

  const ledger = createLedger({
    store,
    pricing,
    attribution,
    trace,
    cwdOf: (sessionId) => sessionRoots?.get(sessionId) ?? null,
    identity,
    onEntry: (sessionId, entry) => guard.onEntry(sessionId, entry),
  })

  ctx.on('session/event', (session, event) => {
    const sid = session?.id
    if (typeof sid === 'string' && !sessionRoots.has(sid) && typeof session?.header?.cwd === 'string') {
      sessionRoots.set(sid, session.header.cwd)
    }
    if (typeof sid === 'string' && !titles.has(sid)) {
      // 两条来源都试：标题事件（新会话）、会话对象上的现成标题（老会话，插件启动前就有标题的）
      const fromEvent = event?.type === 'session/title' ? (event?.data ?? event)?.title : null
      const fromSession = session?.title ?? session?.header?.title
      const title = typeof fromEvent === 'string' && fromEvent.length > 0 ? fromEvent : fromSession
      if (typeof title === 'string' && title.length > 0) titles.set(sid, title)
    } else if (event?.type === 'session/title' && typeof sid === 'string') {
      // 标题会被重新生成（例如更好的一条），已存在时也要更新
      const payload = event?.data ?? event
      if (typeof payload?.title === 'string' && payload.title.length > 0) titles.set(sid, payload.title)
    }
    ledger.onSessionEvent(session, event)
    // 节流落盘在 publisher 内部完成：热路径只多一次 Map 读 + 比较
    if (publisher !== null) publisher.schedule(session?.id)
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
    publisher?.remove(id)
    // 按会话索引的状态必须一起释放，否则长跑进程里这几张 Map 只增不减
    guard.forget(id)
    ledger.forget(id)
    traceSink?.remove(id)
    sessionRoots.delete(id)
    titles.delete(id)
    store.drop(id)
  })

  ctx.on('agent/request', (payload, next) => guard.onRequest(payload, next))

  ctx.tools.register(
    createLedgerQueryTool({ store, pricingMeta, rates: effectivePricing.rates }),
  )

  const api = {
    snapshot: (sessionId, opts) => store.snapshot(sessionId, opts),
    totals: (sessionId) => store.totals(sessionId),
    // 面板需要"看全部来源"和"跨会话对比"：这两个只能由存储层给，前端不拼
    sources: (sessionId, opts) => store.sources(sessionId, opts),
    overview: (opts) => store.overview(opts),
    stats: () => ({ ...ledger.stats(), sessions: store.sessionCount }),
    // 面板诊断：面板读不到数据时，先看这里是 enabled 还是 dir 不对
    panel: publisher === null ? { enabled: false } : { enabled: true, dir: publisher.dir, stats: publisher.stats },
    // 费率来源与拒收明细：对外可查，避免"我改了价但数字没变"变成悬案
    pricing: pricingMeta,
    config,
  }
  // 仓库既有插件统一用 ctx.provide 暴露服务（见 lingzhi-core / lingzhi-workbench）。
  // 但同一个 ctx 被重复装配时（HMR、禁用后重新启用）provide 会抛 "service already exists"，
  // 而它在 apply 里抛=宿主启动失败。服务已经在了就复用，插件其余部分照常工作。
  try {
    ctx.provide('ledger', api)
  } catch (error) {
    console.warn('[ledger] 服务 ledger 已存在，复用既有实例（重复装配）:', error?.message ?? error)
  }

  let disposed = false
  const cleanup = () => {
    // 幂等：宿主可能既跑 effect 清理又触发 dispose 事件，重复释放会二次 flush/close
    if (disposed) return
    disposed = true
    publisher?.dispose()
    traceSink?.dispose()
  }
  if (publisher !== null || traceSink !== null) {
    if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
    else ctx.on('dispose', cleanup)
  }

  return api
}
