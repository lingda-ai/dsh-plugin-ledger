/**
 * Budget Guard。
 *
 * P-3 探针修正（源码证据见 docs/spikes.md）：
 *   原设计想在 agent/request 里把 budget_pressure 塞进"请求参数"让模型读到。
 *   源码事实是：该 waterfall 的返回类型是 LlmCallConfig
 *     { provider, model, reasoningEffort?, temperature?, maxTokens?, stop? }
 *   且注释明确 "this waterfall cannot mutate messages"。
 *   → 因此 **prompt 事实注入不能走 agent/request**，只能走可持久化的日志通道。
 *
 * 拆分后的两条通道：
 *   通道 A（事实/推送）：agent 可读的 budget 事实 → 由宿主注入一个 UserMessage
 *                        （经 agent.inject，属于 logged channel），**默认关闭**，
 *                         需要宿主提供 messageFactory，插件自身不猜消息结构。
 *   通道 B（决策/降级）：agent/request 返回替换的 LlmCallConfig（只改路由与预算），
 *                        这是真·原生能力，默认关闭。
 *
 * 两条通道都遵守：绝不 throwing、绝不短路 next()。
 */
import { budgetEnabled } from './config.js'

export function createBudgetGuard({ store, config, deliver }) {
  const threshold = config?.budget?.threshold ?? 0.8
  const limit = config?.budget?.limit ?? null
  const downgrade = config?.budget?.downgrade ?? null
  const armed = new Map() // sessionId → 是否已在本轮超限中投递过

  function spentOf(sessionId) {
    const totals = store.totals(sessionId)
    // 只按已知金额判断；有未知条目时该会话不可判预算
    if (totals.cost.amount === null || totals.cost.unknownEntries > 0) return null
    return totals.cost.amount
  }

  function evaluate(sessionId, turn, step) {
    if (!budgetEnabled(config)) return null
    const spent = spentOf(sessionId)
    if (spent === null) return null
    const ratio = spent / limit
    if (ratio < threshold) {
      // 回滞：低于 90% 阈值才重新武装，避免在阈值附近反复投递
      if (ratio < threshold * 0.9) armed.delete(sessionId)
      return null
    }
    if (armed.get(sessionId) === true) return null
    armed.set(sessionId, true)
    return {
      spent,
      limit,
      // 币种来自计价层，不在展示层假设
      currency: store.totals(sessionId).cost.currency ?? null,
      remainingRatio: Math.max(0, 1 - ratio),
      suggestion: 'consider_compaction_or_model_downgrade',
      asOfStep: { turn, step },
    }
  }

  /** 每条账本条目后调用；仅在跨越阈值那一次投递 */
  function onEntry(sessionId, entry) {
    try {
      const fact = evaluate(sessionId, entry.turn, entry.step)
      if (!fact) return
      deliver?.(sessionId, fact)
    } catch {
      // 投递失败不影响采集
    }
  }

  /** agent/request waterfall：只做降级，不做事实注入 */
  async function onRequest(payload, next) {
    const config0 = await next()
    try {
      if (!downgrade || !budgetEnabled(config)) return config0
      if (!downgrade.provider && !downgrade.model) return config0
      const sessionId = payload?.agent?.session?.id
      if (!sessionId) return config0
      const spent = spentOf(sessionId)
      if (spent === null || spent / limit < threshold) return config0

      // 已超阈值且用户显式启用降级：替换路由。字段来自 LlmCallConfig，逐项覆盖即可。
      return {
        ...config0,
        provider: downgrade.provider ?? config0.provider,
        model: downgrade.model ?? config0.model,
        maxTokens: downgrade.maxTokens ?? config0.maxTokens,
      }
    } catch {
      // 降级失败必须回退到原配置，宁可超预算也不能让请求崩掉
      return config0
    }
  }

  /**
   * 会话结束要释放按会话索引的状态。
   * armed 只存 boolean，但它按会话无界增长——长跑进程里就是一条缓慢的内存泄漏。
   */
  function forget(sessionId) {
    armed.delete(sessionId)
  }

  return { onEntry, onRequest, evaluate, forget }
}
