/**
 * 行为流水。
 *
 * 三个硬约束：
 *   1. 字段从第一版就按 OTel GenAI 语义（gen_ai.*）组织，避免阶段二重构数据模型；
 *   2. 脱敏是默认行为，不是可选开关；
 *   3. 记录失败绝不影响主流程（session/event 是 post-commit 广播，抛错会污染日志）。
 */

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi,
  /\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]{6,}/gi,
]

/** 绝对路径会把用户目录结构泄进审计日志 */
const ABS_PATH = /(?:^|[\s"'(])((?:[A-Za-z]:)?(?:[\\/](?:[^\\/\s"']+)){2,})/g

export function redactText(value, maxLength = 200) {
  if (typeof value !== 'string') return ''
  let text = value
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]')
  text = text.replace(ABS_PATH, ' [path]')
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

/**
 * @param {{enabled:boolean, capacity:number, maxTextLength:number}} config
 */
export function createTrace(config) {
  const maxLength = config?.maxTextLength ?? 200

  /**
   * @param {object} input
   * @returns {object|null} 关闭时返回 null，由调用方跳过写入
   */
  function project(input) {
    if (!config?.enabled) return null
    const {
      sessionId, turn, step, eventType, pluginSource, cost, summary, at,
    } = input

    return Object.freeze({
      timestamp: new Date(at ?? Date.now()).toISOString(),
      sessionId,
      turn,
      step,
      'gen_ai.operation.name': eventType,
      'gen_ai.agent.name': pluginSource ?? 'unattributed',
      'gen_ai.usage.input_tokens': input.usage?.inputTokens ?? null,
      'gen_ai.usage.output_tokens': input.usage?.outputTokens ?? null,
      'gen_ai.usage.cache_read_tokens': input.usage?.cacheReadTokens ?? null,
      'gen_ai.usage.cache_write_tokens': input.usage?.cacheWriteTokens ?? null,
      cost: cost?.kind === 'known' ? { amount: cost.amount, currency: cost.currency } : null,
      costUnknownReason: cost?.kind === 'unknown' ? cost.reason : null,
      summary: redactText(summary ?? '', maxLength),
    })
  }

  return { project, redactText: (v) => redactText(v, maxLength) }
}
