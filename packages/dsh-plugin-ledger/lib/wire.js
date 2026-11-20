/**
 * 上报协议（wire format）。
 *
 * 现在一条都不发，但协议形状必须先冻住，因为它是**不可逆**的那一半：
 *   - 字段名一旦写进历史流水，后面想从 `inputTokens` 改成 `measures[]`，老数据永远迁不干净；
 *   - `eventId` 一旦用于幂等去重，算法变更会让历史事件重复入账。
 *
 * 设计取舍：
 *   1. 计量用 `measures[]`（单位 + 数值）而不是 token 专用字段——订阅制工具（Cursor/Trae/Qoder）
 *      根本没有 token 成本，只有席位成本；把 token 当主键，第二类工具就进不来。
 *   2. `gen_ai.*` 仍保留在本地流水里（OTel 标准 + 便于本地排查），但**不是上报口径**。
 *   3. 上报不带 summary、不带任何文本——服务端结构上收不到用户内容。
 */
import { createHash } from 'node:crypto'

export const WIRE_VERSION = 1

/** token 计量单位；未来席位是 `seat.day`、按次是 `request`、时长是 `minute` */
export const UNIT = Object.freeze({
  tokenInput: 'token.input',
  tokenOutput: 'token.output',
  tokenCacheRead: 'token.cache_read',
  tokenCacheWrite: 'token.cache_write',
})

const UNIT_FIELDS = [
  [UNIT.tokenInput, 'inputTokens'],
  [UNIT.tokenOutput, 'outputTokens'],
  [UNIT.tokenCacheRead, 'cacheReadTokens'],
  [UNIT.tokenCacheWrite, 'cacheWriteTokens'],
]

/**
 * 幂等键：同一会话同一 turn/step/类型只可能产生一条，重复上报必须落成同一 id。
 * 这条是双端（Desktop + 云主机）重复上报的唯一防线——没有它，账会翻倍。
 */
export function eventIdOf({ sessionId, turn, step, operation }) {
  const key = [sessionId ?? '', turn ?? 0, step ?? 0, operation ?? ''].join('|')
  return createHash('sha1').update(key).digest('hex').slice(0, 16)
}

/**
 * usage → 中性计量数组。0 值不进数组：既没成本也没信息量，白白撑大流水。
 * 注意"缺字段"与"值为 0"的区别由 usage.complete 承载，不靠 measures 表达。
 */
export function measuresOf(usage) {
  if (!usage) return []
  const out = []
  for (const [unit, field] of UNIT_FIELDS) {
    const value = usage[field]
    if (Number.isFinite(value) && value > 0) out.push({ unit, value })
  }
  return out
}

/**
 * 本地流水行 → 上报事件（白名单投影，未知字段一律丢弃）。
 * 服务端 strict 校验依赖这个白名单：多出来的字段会被拒，所以这里必须显式列全。
 */
export function wireEventOf(row, options = {}) {
  if (!row || typeof row !== 'object') return null
  const operation = row['gen_ai.operation.name'] ?? null
  const usage = {
    inputTokens: row['gen_ai.usage.input_tokens'],
    outputTokens: row['gen_ai.usage.output_tokens'],
    cacheReadTokens: row['gen_ai.usage.cache_read_tokens'],
    cacheWriteTokens: row['gen_ai.usage.cache_write_tokens'],
  }
  return {
    wireVersion: WIRE_VERSION,
    eventId: row.eventId ?? eventIdOf({ sessionId: row.sessionId, turn: row.turn, step: row.step, operation }),
    timestamp: row.timestamp,
    source: options.source ?? 'dsh',
    deviceId: row.deviceId ?? null,
    actor: row.actor ?? null,
    project: row.project ?? null,
    sessionId: row.sessionId ?? null,
    turn: row.turn ?? null,
    step: row.step ?? null,
    operation,
    plugin: row['gen_ai.agent.name'] ?? null,
    // 已有 measures 就用它（未来非 token 计量直接写这里），否则从 gen_ai 派生
    measures: Array.isArray(row.measures) && row.measures.length > 0 ? row.measures : measuresOf(usage),
    cost: row.cost ?? null,
    costUnknownReason: row.costUnknownReason ?? null,
  }
}
