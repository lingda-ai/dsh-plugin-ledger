import { BUILTIN_RATES } from './pricing-table.js'

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
    // 内置官方价（来源与日期见 pricing-table.js），用户配置按单模型深合并覆盖。
    // "provider/model" 或 "model" → {input,output,cacheRead,cacheWrite}，单位 元/token
    rates: BUILTIN_RATES,
    // 费率覆盖文件：null = 用默认 ~/.dsh/ledger/pricing.json（不存在就纯用内置价）。
    // 文件里写 元/百万，整条生效或整条拒绝，见 pricing-file.js 的取舍说明。
    file: null,
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
    // 落盘是二次副作用，必须显式再开一层；开启后写 <cwd>/.dsh/ledger/<sid>.trace.jsonl
    file: {
      enabled: false,
      maxBytes: 4194304, // 单文件 4MB 封顶
    },
  },
  attribution: {
    toolOwners: {},      // 工具名 → 所属插件（唯一可得的归因依据，见 docs/spikes.md）
  },
  // 右侧栏面板的数据通道：Host 把只读快照落成 JSON，浏览器半用 workspace 文件 remote 读回。
  // 默认关闭——写盘是外部副作用，不该由观测默认产生。
  panel: {
    enabled: false,
    dir: '.dsh/ledger',   // 相对 process.cwd()；也可给绝对路径
    intervalMs: 3000,     // 同一会话两次落盘的最小间隔
    maxBytes: 262144,     // 超过则只写 totals + topSources
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
