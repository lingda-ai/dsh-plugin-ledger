/**
 * 配置默认值。
 *
 * 取舍原则：
 *   - 会改变 Agent 行为质量的开关（预算降级、事实推送）默认 **关闭**；
 *   - 只读观测（账本）默认开启，但容量有界；
 *   - 任何"猜"的字段都不给默认值，宁可为 null。
 */
export const DEFAULT_CONFIG = Object.freeze({
  ledger: {
    capacity: 2000,      // 每个会话保留的账本条目数
    maxSessions: 64,     // 同时保留状态的会话上限（LRU 淘汰）
  },
  pricing: {
    currency: 'CNY',
    rates: {},           // "provider/model" 或 "model" → {input,output,cacheRead,cacheWrite}
  },
  budget: {
    limit: null,         // null = 不启用预算
    threshold: 0.8,      // 触发投递的比例
    downgrade: null,     // {provider, model, maxTokens} | null，默认关闭
  },
  trace: {
    enabled: false,      // 行为流水默认关闭（隐私优先）
    capacity: 5000,
    maxTextLength: 200,  // 摘要截断长度
  },
  attribution: {
    toolOwners: {},      // 工具名 → 所属插件（唯一可得的归因依据，见 docs/spikes.md）
  },
})

function merge(base, patch) {
  if (!patch || typeof patch !== 'object') return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = base[key]
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)) {
      out[key] = merge(current, value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

export function resolveConfig(raw) {
  return merge(DEFAULT_CONFIG, raw)
}

/** 预算是否真的可用：有 limit 才算，避免 limit=0 被当成"启用" */
export function budgetEnabled(config) {
  return typeof config?.budget?.limit === 'number' && config.budget.limit > 0
}
