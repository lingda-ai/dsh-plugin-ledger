import test from 'node:test'
import assert from 'node:assert/strict'
import { LedgerStore } from '../lib/store.js'
import { createPricing } from '../lib/pricing.js'
import { createAttribution } from '../lib/attribution.js'
import { createTrace } from '../lib/trace.js'
import { createLedger } from '../lib/ledger.js'

function harness(overrides = {}) {
  const store = new LedgerStore({ capacity: 50, traceCapacity: 50, traceEnabled: true, maxSessions: 4 })
  const pricing = createPricing({
    rates: { 'deepseek/chat': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, currency: 'CNY' } },
  })
  const attribution = createAttribution({ toolOwners: { 'food.query': 'plugin-food', 'kb.search': 'plugin-kb' } })
  const trace = createTrace({ enabled: true, capacity: 50, maxTextLength: 40 })
  const ledger = createLedger({ store, pricing, attribution, trace, now: () => 1_700_000_000_000, ...overrides })
  return { store, ledger }
}

test('模型调用入账：金额、token、归因、流水齐全', () => {
  const { store, ledger } = harness()
  ledger.onSessionEvent({ id: 's1' }, {
    type: 'assistant/message',
    turn: 1, step: 1,
    usage: { inputTokens: 10, outputTokens: 5 },
    message: { source: { provider: 'deepseek', model: 'chat' } },
  })
  const totals = store.totals('s1')
  assert.equal(totals.cost.amount, 15)
  assert.equal(totals.tokens.input, 10)
  assert.equal(store.traceTail('s1', 5).length, 1)
  assert.equal(store.traceTail('s1', 5)[0]['gen_ai.operation.name'], 'chat')
})

test('费率未知仍入账，但成本标记 unknown 且不计入金额', () => {
  const { store, ledger } = harness()
  ledger.onSessionEvent({ id: 's2' }, {
    type: 'assistant/message', turn: 1, step: 1,
    usage: { inputTokens: 10, outputTokens: 5 },
    message: { source: { provider: 'unknown', model: 'model' } },
  })
  const totals = store.totals('s2')
  assert.equal(totals.cost.amount, null)
  assert.equal(totals.cost.unknownEntries, 1)
})

test('模型成本归因到上一轮工具：因果方向正确', () => {
  const { store, ledger } = harness()
  // 第 1 步：模型请求 → 工具调用
  ledger.onSessionEvent({ id: 's3' }, {
    type: 'assistant/message', turn: 1, step: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
    message: { source: { provider: 'deepseek', model: 'chat' } },
  })
  ledger.onSessionEvent({ id: 's3' }, { type: 'tool/call', turn: 1, step: 1, callId: 'c1', name: 'food.query' })
  // 第 2 步：模型带着工具结果再次请求 → 应归因到 plugin-food
  ledger.onSessionEvent({ id: 's3' }, {
    type: 'assistant/message', turn: 1, step: 2,
    usage: { inputTokens: 1, outputTokens: 1 },
    message: { source: { provider: 'deepseek', model: 'chat' } },
  })
  const entries = store.entriesOf('s3').filter((e) => e.kind === 'model')
  assert.equal(entries.length, 2)
  assert.equal(entries[0].attribution.primary, null)
  assert.equal(entries[1].attribution.primary.plugin, 'plugin-food')
})

test('多个工具所有者 → 共享成本，不排序、不拆百分比', () => {
  const { store, ledger } = harness()
  ledger.onSessionEvent({ id: 's4' }, { type: 'tool/call', turn: 1, step: 1, callId: 'a', name: 'food.query' })
  ledger.onSessionEvent({ id: 's4' }, { type: 'tool/call', turn: 1, step: 1, callId: 'b', name: 'kb.search' })
  ledger.onSessionEvent({ id: 's4' }, {
    type: 'assistant/message', turn: 1, step: 2,
    usage: { inputTokens: 1, outputTokens: 0 },
    message: { source: { provider: 'deepseek', model: 'chat' } },
  })
  const entry = store.entriesOf('s4').at(-1)
  assert.equal(entry.attribution.primary, null)
  assert.deepEqual(entry.attribution.sharedContext.map((s) => s.plugin), ['plugin-food', 'plugin-kb'])
  assert.equal(entry.attribution.unresolvedReason, 'multi-contributor')
})

test('压缩事件单列 system:compaction，不污染业务插件', () => {
  const { store, ledger } = harness()
  ledger.onSessionEvent({ id: 's5' }, {
    type: 'compaction/summary', turn: 1, step: 3,
    usage: { inputTokens: 100, outputTokens: 10 },
    message: { source: { provider: 'deepseek', model: 'chat' } },
  })
  const snap = store.snapshot('s5')
  assert.equal(snap.topSources[0].plugin, 'system:compaction')
})

test('坏事件不冒泡：failures 计数，其余照常', () => {
  const { store, ledger, } = harness()
  ledger.onSessionEvent({ id: 's6' }, { type: 'assistant/message', turn: 1, step: 1, get usage() { throw new Error('boom') } })
  assert.equal(ledger.stats().failures, 1)
  ledger.onSessionEvent({ id: 's6' }, {
    type: 'assistant/message', turn: 1, step: 2,
    usage: { inputTokens: 2, outputTokens: 1 },
    message: { source: { provider: 'deepseek', model: 'chat' } },
  })
  assert.equal(store.totals('s6').cost.amount, 3)
})

test('会话数达上限时淘汰最旧，内存有界', () => {
  const store = new LedgerStore({ capacity: 2, traceCapacity: 2, traceEnabled: false, maxSessions: 2 })
  for (const id of ['a', 'b', 'c']) store.recordEntry(id, { turn: 0, step: 0, kind: 'model', usage: null, cost: { kind: 'unknown', reason: 'no-usage' }, attribution: {} })
  assert.equal(store.sessionCount, 2)
  assert.equal(store.snapshot('a'), null)
})
