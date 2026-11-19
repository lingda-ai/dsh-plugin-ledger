/**
 * 四级计价。
 *
 * 为什么必须四级：TokenUsage 的计数 disjoint，缓存读写与未缓存输入单价不同。
 * 用一个平均价乘总数会系统性偏高（缓存命中率越高错得越多）。
 *
 * 费率未知时返回 { kind: 'unknown' }，**绝不退化成 0 或猜一个数**。
 */

/**
 * Cost 是联合类型：
 *   { kind:'known', amount, currency, tier }
 *   { kind:'unknown', reason }
 */

const REQUIRED_RATE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite']

/**
 * @param {{currency?: string, rates?: Record<string, object>}} [options]
 */
export function createPricing(options = {}) {
  const currency = options.currency ?? 'CNY'
  const rates = new Map(Object.entries(options.rates ?? {}))

  /** 查找费率：优先 provider/model，其次裸 model，最后 provider/* */
  function rateFor(provider, model) {
    if (!model) return null
    const exact = provider ? rates.get(`${provider}/${model}`) : null
    return exact ?? rates.get(model) ?? (provider ? rates.get(`${provider}/*`) : null) ?? null
  }

  /**
   * @param {ReturnType<import('./usage.js').normalizeUsage>} usage
   * @param {{provider?: string, model?: string}|null} route
   * @returns {{kind:'known',amount:number,currency:string,tier:'exact'}|{kind:'unknown',reason:string}}
   */
  function costOf(usage, route) {
    if (!usage) return { kind: 'unknown', reason: 'no-usage' }
    if (!usage.complete) return { kind: 'unknown', reason: 'usage-incomplete' }

    const rate = rateFor(route?.provider, route?.model)
    if (!rate) return { kind: 'unknown', reason: 'no-rate' }
    for (const field of REQUIRED_RATE_FIELDS) {
      if (!Number.isFinite(rate[field])) return { kind: 'unknown', reason: 'no-rate' }
    }

    // reasoningTokens 已计入 outputTokens（适配器口径），不重复计价。
    // 四档分开保留：面板要按"未缓存输入 / 缓存命中 / 缓存写 / 输出"分行显示，
    // 前端不能自己乘（费率只在 Host 手里）。
    const parts = {
      input: usage.inputTokens * rate.input,
      output: usage.outputTokens * rate.output,
      cacheRead: usage.cacheReadTokens * rate.cacheRead,
      cacheWrite: usage.cacheWriteTokens * rate.cacheWrite,
    }
    const amount = parts.input + parts.output + parts.cacheRead + parts.cacheWrite

    return { kind: 'known', amount, parts, currency: rate.currency ?? currency, tier: 'exact' }
  }

  /**
   * 缓存命中省下的钱 = cacheReadTokens × (未命中单价 − 命中单价)。
   *
   * 为什么这个数**可以报**而压缩省下的不能：两个单价都在同一张价表里，
   * 差额是确定的，不需要假设「省下的 token 属哪一档」。这是账本里唯一
   * 一个能严格算出来的"省了多少钱"。
   */
  function savingsOf(usage, route) {
    if (!usage || !usage.complete) return { kind: 'unknown', reason: 'no-usage' }
    const rate = rateFor(route?.provider, route?.model)
    if (!rate) return { kind: 'unknown', reason: 'no-rate' }
    if (!Number.isFinite(rate.input) || !Number.isFinite(rate.cacheRead)) {
      return { kind: 'unknown', reason: 'no-rate' }
    }
    const hit = usage.cacheReadTokens ?? 0
    if (hit <= 0) return { kind: 'known', amount: 0, currency: rate.currency ?? currency }
    const spread = rate.input - rate.cacheRead
    // 命中价高于未命中价（配置写反了）时不报负数：那不是"省了"
    if (!(spread > 0)) return { kind: 'known', amount: 0, currency: rate.currency ?? currency }
    return { kind: 'known', amount: hit * spread, currency: rate.currency ?? currency }
  }

  return { costOf, savingsOf, rateFor, currency }
}
