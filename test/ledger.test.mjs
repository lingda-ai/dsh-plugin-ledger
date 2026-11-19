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


test('tool/result 会记体积，下一步模型调用带上 contextChars', () => {
  const { store, ledger } = harness()
  const session = { id: 's-size' }
  ledger.onSessionEvent(session, { type: 'tool/call', turn: 2, step: 1, callId: 'c1', name: 'tools.hr', arguments: '{}' })
  ledger.onSessionEvent(session, {
    type: 'tool/result',
    turn: 2,
    step: 1,
    message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'x'.repeat(18442) }] },
  })
  ledger.onSessionEvent(session, {
    type: 'assistant/message',
    turn: 2,
    step: 2,
    message: { source: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
    usage: { inputTokens: 9000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
  })

  const snapshot = store.snapshot('s-size')
  const model = snapshot.recent.find((e) => e.kind === 'model')
  assert.equal(model.contextChars, 18442)
})

test('只记体积不记内容：账本条目里不该出现工具输出原文', () => {
  const { store, ledger } = harness()
  const session = { id: 's-privacy' }
  const secret = 'TOP-SECRET-PAYLOAD'
  ledger.onSessionEvent(session, { type: 'tool/call', turn: 1, step: 1, callId: 'c9', name: 'tools.fs', arguments: '{}' })
  ledger.onSessionEvent(session, { type: 'tool/result', turn: 1, step: 1, message: { content: [{ type: 'text', text: secret }] } })
  const dump = JSON.stringify(store.snapshot('s-privacy'))
  assert.ok(!dump.includes(secret), '工具输出原文不得进入账本')
})


test('压缩前后上下文对照：压缩条目记前值，后一条模型调用记省下的量', () => {
  const { store, ledger } = harness()
  const session = { id: 's-compact' }
  // 压缩前：一次大上下文调用（input 30000 + cacheRead 12000 = 42k）
  ledger.onSessionEvent(session, {
    type: 'assistant/message',
    turn: 1, step: 1,
    usage: { inputTokens: 30000, outputTokens: 100, cacheReadTokens: 12000, cacheWriteTokens: 0 },
    message: { source: { provider: 'deepseek', model: 'chat' } },
  })
  // 压缩（本身也是一次模型调用，有自己的支出）
  ledger.onSessionEvent(session, {
    type: 'compaction/start',
    turn: 1, step: 2,
    usage: { inputTokens: 42000, outputTokens: 500 },
    message: { source: { provider: 'deepseek', model: 'chat' } },
  })
  // 压缩后：上下文降到 18k
  ledger.onSessionEvent(session, {
    type: 'assistant/message',
    turn: 1, step: 3,
    usage: { inputTokens: 15000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 0 },
    message: { source: { provider: 'deepseek', model: 'chat' } },
  })

  const recent = store.snapshot('s-compact').recent
  const compaction = recent.find((e) => e.kind === 'compaction')
  const after = recent.filter((e) => e.kind === 'model').at(-1)
  assert.equal(compaction.contextBeforeTokens, 42000, '压缩条目要记压缩前的上下文规模')
  assert.equal(after.contextSavedTokens, 24000, '后一条调用记省下的 42k - 18k')
})

test('压缩后如果上下文反而更大，不报"省了"（负值不出现在面板）', () => {
  const { store, ledger } = harness()
  const session = { id: 's-compact-big' }
  ledger.onSessionEvent(session, {
    type: 'assistant/message', turn: 1, step: 1,
    usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    message: { source: { provider: 'deepseek', model: 'chat' } },
  })
  ledger.onSessionEvent(session, {
    type: 'compaction/start', turn: 1, step: 2,
    usage: { inputTokens: 1000, outputTokens: 10 },
    message: { source: { provider: 'deepseek', model: 'chat' } },
  })
  ledger.onSessionEvent(session, {
    type: 'assistant/message', turn: 1, step: 3,
    usage: { inputTokens: 9000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    message: { source: { provider: 'deepseek', model: 'chat' } },
  })
  const after = store.snapshot('s-compact-big').recent.filter((e) => e.kind === 'model').at(-1)
  assert.equal(after.contextSavedTokens, null)
})


test('缓存命中省下的钱严格可算：命中量 × (未命中价 − 命中价)', () => {
  const store = new LedgerStore({ capacity: 50, traceCapacity: 10, traceEnabled: false, maxSessions: 4 })
  const pricing = createPricing({
    rates: { 'deepseek/chat': { input: 1e-6, output: 2e-6, cacheRead: 0.02e-6, cacheWrite: 0, currency: 'CNY' } },
  })
  const attribution = createAttribution({ toolOwners: {} })
  const trace = createTrace({ enabled: false })
  const ledger = createLedger({ store, pricing, attribution, trace })
  ledger.onSessionEvent({ id: 's-hit' }, {
    type: 'assistant/message', turn: 1, step: 1,
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 10000, cacheWriteTokens: 0, complete: true },
    message: { source: { provider: 'deepseek', model: 'chat' } },
  })
  const saved = store.totals('s-hit').saved
  // 10000 × (1 - 0.02) / 1e6 = 0.0098
  assert.equal(Math.round(saved.amount * 1e6) / 1e6, 0.0098)
  assert.equal(saved.entries, 1)
})

test('没有缓存命中时不报"省了 0 元"（amount 为 null）', () => {
  const { store, ledger } = harness()
  ledger.onSessionEvent({ id: 's-nohit' }, {
    type: 'assistant/message', turn: 1, step: 1,
    usage: { inputTokens: 10, outputTokens: 5 },
    message: { source: { provider: 'deepseek', model: 'chat' } },
  })
  assert.equal(store.totals('s-nohit').saved.amount, 0)
  assert.equal(store.totals('s-nohit').saved.entries, 1)
  assert.equal(store.totals('s-absent').saved.amount, null)
})
