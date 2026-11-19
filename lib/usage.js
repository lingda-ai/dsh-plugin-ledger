/**
 * TokenUsage 归一化。
 *
 * 源码事实（@deepseek-ai/dsh-llm TokenUsage）：
 *   - 计数是 **disjoint**（互不重叠）：`inputTokens` 只含未缓存输入，
 *     缓存输入单列为 `cacheReadTokens` / `cacheWriteTokens`。
 *   - `totalTokens` 是可选的；缺了就缺了，**不做加法冒充**。
 *
 * 因此 billableInput = input + cacheRead + cacheWrite 是派生量，
 * 必须显式标注 derived，避免下游误当成上游上报值。
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * @param {unknown} raw assistant/message 携带的 usage
 * @returns {{
 *   inputTokens: number|null, outputTokens: number|null,
 *   cacheReadTokens: number, cacheWriteTokens: number,
 *   reasoningTokens: number, totalTokens: number|null,
 *   billableInput: number|null, complete: boolean
 * }|null}
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null

  const input = isNum(raw.inputTokens) ? raw.inputTokens : null
  const output = isNum(raw.outputTokens) ? raw.outputTokens : null
  const cacheRead = isNum(raw.cacheReadTokens) ? raw.cacheReadTokens : 0
  const cacheWrite = isNum(raw.cacheWriteTokens) ? raw.cacheWriteTokens : 0
  const reasoning = isNum(raw.reasoningTokens) ? raw.reasoningTokens : 0
  const total = isNum(raw.totalTokens) ? raw.totalTokens : null

  // 完全没有计数信号时视为"没有 usage"，而不是"用量为 0"
  if (input === null && output === null && cacheRead === 0 && cacheWrite === 0 && total === null) {
    return null
  }

  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: reasoning,
    totalTokens: total,
    // 派生量：仅在 input 可得时才有意义
    billableInput: input === null ? null : input + cacheRead + cacheWrite,
    // 计费必须同时拿到输入与输出；缺任何一个都不可计费
    complete: input !== null && output !== null,
  }
}

/** 汇总多个 usage（用于会话级 token 总数）。缺失字段不参与求和，避免被 0 稀释。 */
export function sumUsage(list) {
  const acc = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, reported: 0, missing: 0 }
  for (const u of list) {
    if (!u) continue
    acc.inputTokens += u.inputTokens ?? 0
    acc.outputTokens += u.outputTokens ?? 0
    acc.cacheReadTokens += u.cacheReadTokens ?? 0
    acc.cacheWriteTokens += u.cacheWriteTokens ?? 0
    acc.reasoningTokens += u.reasoningTokens ?? 0
    if (u.complete) acc.reported += 1
    else acc.missing += 1
  }
  return acc
}
