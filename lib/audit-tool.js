/**
 * ledger_query：让 Agent 查自己的运行时账本。
 *
 * 契约对齐（@deepseek-ai/dsh-llm ToolSchema / dsh-tools ToolDefinition）：
 *   { name, description, parameters } + output: { schema, render } + execute
 *   execute 返回唯一 canonical 值（这里是字符串），render 把它变成 ContentBlock[]。
 *
 * 返回摘要而不是原始 JSONL：消费者是 Agent，不是人。
 *
 * 三个 op：
 *   snapshot（默认）：单会话总览 + 最近 N 条
 *   sources：单会话全部成本来源（不截断到 Top3），可按金额/条目数排序
 *   overview：跨会话概览（LRU 顺序），用于"这周哪个会话最贵"
 *
 * 未知成本一律带原因返回，不做估算、不补 0。
 */

function formatAmount(cost) {
  if (!cost) return 'n/a'
  if (cost.kind === 'unknown') return `未知(${cost.reason})`
  return `${cost.amount.toFixed(6)} ${cost.currency}`
}

function formatPct(share) {
  return typeof share === 'number' ? ` (${(share * 100).toFixed(1)}%)` : ''
}

export function createLedgerQueryTool({ store }) {
  return {
    name: 'ledger_query',
    description:
      '查询运行时账本：模型调用与工具调用流水、token 用量、成本归因。'
      + 'op=snapshot 看单会话总览与最近 N 条；op=sources 看该会话全部成本来源（含条目数与占比）；'
      + 'op=overview 看跨会话概览。成本未知时明确返回 unknown 及原因，不给出估算值。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        op: {
          type: 'string',
          enum: ['snapshot', 'sources', 'overview'],
          description: '查询类型，默认 snapshot',
        },
        sessionId: {
          type: 'string',
          description: '目标会话 id；op=overview 时可省略',
        },
        lastN: { type: 'number', description: 'snapshot 最近 N 条条目，默认 10，上限 100' },
        limit: { type: 'number', description: 'sources/overview 返回条数上限，默认 20，上限 64' },
        sort: {
          type: 'string',
          enum: ['amount', 'entries', 'name'],
          description: 'sources 排序，默认 amount（金额降序）',
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      },
    },
    async execute(args) {
      const op = args?.op ?? 'snapshot'

      if (op === 'overview') {
        const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 64)
        const ov = store.overview({ limit })
        if (!ov.sessions.length) return '暂无任何会话账本记录（可能未被采集或已全部淘汰）。'
        const lines = [`会话数 ${ov.sessionCount}${ov.truncated ? `（仅显示最近 ${ov.sessions.length} 个）` : ''}`, '按最近使用排序：']
        for (const s of ov.sessions) {
          const amount = s.cost.amount === null ? '未知' : `${s.cost.amount.toFixed(6)} ${s.cost.currency}`
          lines.push(`  - ${s.sessionId} | ${amount} | 已知 ${s.cost.knownEntries} / 未知 ${s.cost.unknownEntries} | ${s.entries} 条`)
        }
        return lines.join('\n')
      }

      const sessionId = args?.sessionId
      if (!sessionId) return '缺少 sessionId（op=overview 之外必须提供）。'

      if (op === 'sources') {
        const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 64)
        const sort = args?.sort ?? 'amount'
        const res = store.sources(sessionId, { limit, sort })
        if (!res) return `会话 ${sessionId} 无账本记录（可能未被采集或已淘汰）。`
        const total = res.total === null ? '未知' : res.total.toFixed(6)
        const lines = [
          `会话 ${sessionId} 成本来源（排序 ${sort}，共 ${res.sourceCount} 个${res.truncated ? `，显示前 ${res.sources.length}` : ''}）`,
          `已知合计 ${total} / 条目 已知 ${res.knownEntries} 未知 ${res.unknownEntries}`,
        ]
        if (!res.sources.length) lines.push('  暂无可归因来源。')
        for (const s of res.sources) {
          lines.push(`  - ${s.plugin}: ${s.amount.toFixed(6)}${formatPct(s.share)} | ${s.entries} 条`)
        }
        if (res.unknownEntries > 0) lines.push(`注意：${res.unknownEntries} 条成本未知，未计入上述合计与占比。`)
        return lines.join('\n')
      }

      const n = Math.min(Math.max(Number(args?.lastN) || 10, 1), 100)
      const snap = store.snapshot(sessionId, { lastN: n })
      if (!snap) return `会话 ${sessionId} 无账本记录（可能未被采集或已淘汰）。`

      const t = snap.totals
      const lines = []
      lines.push(`会话 ${sessionId}`)
      lines.push(`累计成本：${t.cost.amount === null ? '未知（无已知费率条目）' : `${t.cost.amount.toFixed(6)} ${t.cost.currency}`}`)
      lines.push(`计费条目：已知 ${t.cost.knownEntries} / 未知 ${t.cost.unknownEntries}`)
      if (t.tokens) {
        lines.push(
          `Token：input ${t.tokens.input} / output ${t.tokens.output} / cacheRead ${t.tokens.cacheRead} / cacheWrite ${t.tokens.cacheWrite}`
          + (t.tokens.missing > 0 ? `（${t.tokens.missing} 条 usage 不完整）` : ''),
        )
      }
      if (snap.topSources.length) {
        lines.push('成本来源 Top:')
        for (const item of snap.topSources) lines.push(`  - ${item.plugin}: ${item.amount.toFixed(6)}`)
      } else {
        lines.push('成本来源：暂无。')
      }
      lines.push(`最近 ${snap.recent.length} 条：`)
      for (const e of snap.recent) {
        const who = e.attribution?.system === 'compaction'
          ? 'system:compaction'
          : e.attribution?.primary?.plugin
            ?? (e.attribution?.unresolvedReason ? `unattributed(${e.attribution.unresolvedReason})` : 'unattributed')
        lines.push(`  #${e.turn}.${e.step} ${e.kind} ${e.callId ?? ''} → ${who} | ${formatAmount(e.cost)}`.replace(/\s+/g, ' '))
      }
      return lines.join('\n')
    },
  }
}
