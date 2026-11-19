/**
 * ledger_query：让 Agent 查自己的运行时账本。
 *
 * 契约对齐（@deepseek-ai/dsh-llm ToolSchema / dsh-tools ToolDefinition）：
 *   { name, description, parameters } + output: { schema, render } + execute
 *   execute 返回唯一 canonical 值（这里是字符串），render 把它变成 ContentBlock[]。
 *
 * 返回摘要而不是原始 JSONL：消费者是 Agent，不是人。
 */

function formatAmount(cost) {
  if (!cost) return 'n/a'
  if (cost.kind === 'unknown') return `未知(${cost.reason})`
  return `${cost.amount.toFixed(6)} ${cost.currency}`
}

export function createLedgerQueryTool({ store }) {
  return {
    name: 'ledger_query',
    description:
      '查询本会话的运行时账本：模型调用与工具调用流水、token 用量、成本归因、以及最近 N 步开销。'
      + '用于回答“钱花在哪”“哪个工具最贵”“这一步用了多少 token”。'
      + '成本未知时会明确返回 unknown 及原因，不会给出估算值。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: '目标会话 id' },
        lastN: { type: 'number', description: '最近 N 条条目，默认 10，上限 100' },
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      },
    },
    async execute(args) {
      const sessionId = args?.sessionId
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
