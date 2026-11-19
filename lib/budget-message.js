/**
 * 预算事实 → 合法 model-facing UserMessage。
 *
 * 纯函数：构造函数由调用方注入。
 *   - 真实运行时传 `createUserMessage`（已核实导出，见 docs/spikes.md）；
 *   - 测试传替身，不需要装整个 dsh-llm。
 * 这样既不把 dsh-llm 绑成硬依赖，也不靠"猜消息结构"。
 *
 * 已核实契约：
 *   createUserMessage({ content: ContentBlock[], source: { kind: 'user' } })
 *   → { id, role: 'user', content, source }
 */
export function makeBudgetMessage(fact, createUserMessage) {
  if (typeof createUserMessage !== 'function') return null
  if (!fact || typeof fact !== 'object') return null

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
