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
    const amount =
      usage.inputTokens * rate.input +
      usage.outputTokens * rate.output +
      usage.cacheReadTokens * rate.cacheRead +
      usage.cacheWriteTokens * rate.cacheWrite

    return { kind: 'known', amount, currency: rate.currency ?? currency, tier: 'exact' }
  }

  return { costOf, rateFor, currency }
}
