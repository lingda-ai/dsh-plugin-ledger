/**
 * 宿主事件形状回归（2026-11-20 真机抓取）。
 *
 * 为什么要单独一个文件：单测原来用的是"扁平事件"假设，
 * 而宿主实际派发 {type, seq, time, data}。两边都绿，线上却一条记录都没有。
 * 这个文件固定真机抓到的原始形状，避免同类假绿再次发生。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { LedgerStore } from '../lib/store.js'
import { createPricing } from '../lib/pricing.js'
import { BUILTIN_RATES } from '../lib/pricing-table.js'
import { createAttribution } from '../lib/attribution.js'
import { createTrace } from '../lib/trace.js'
import { createLedger } from '../lib/ledger.js'

function harness() {
  const store = new LedgerStore({ capacity: 50, traceCapacity: 50, traceEnabled: true, maxSessions: 4 })
  const pricing = createPricing({ currency: 'CNY', rates: BUILTIN_RATES })
  const attribution = createAttribution({ toolOwners: {} })
  const trace = createTrace({ enabled: false, capacity: 50, maxTextLength: 40 })
  const ledger = createLedger({ store, pricing, attribution, trace, now: () => 1_700_000_000_000 })
  return { store, ledger }
}

/** 真机抓到的 assistant/message（字段名与层级原样保留，只把无关的 content/stream 省略） */
const REAL_EVENT = {
  type: 'assistant/message',
  seq: 12,
  time: 1795159594090,
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      id: 'msg_stub_2',
      content: [],
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    },
    usage: { inputTokens: 260, outputTokens: 140, cacheReadTokens: 1600, cacheWriteTokens: 0, totalTokens: 2000 },
    stream: {},
  },
  surfaceOp: {},
}

// 内置价 flash：260×1e-6 + 1600×0.02e-6 + 140×2e-6 = 0.000572
const EXPECTED_COST = 0.000572
// 缓存节省：1600 × (1 − 0.02)e-6 = 0.001568
const EXPECTED_SAVED = 0.001568

test('EV-1 真机形状 {type,data}：turn/step、usage、route、金额都要认出来', () => {
  const { store, ledger } = harness()
  ledger.onSessionEvent({ id: 'real' }, REAL_EVENT)

  const totals = store.totals('real')
  assert.equal(totals.entries, 1)
  assert.equal(totals.cost.knownEntries, 1, '一条已知金额，不能是 no-usage')
  assert.ok(Math.abs(totals.cost.amount - EXPECTED_COST) < 1e-12)
  assert.equal(totals.tokens.input, 260)
  assert.equal(totals.tokens.cacheRead, 1600)

  const snap = store.snapshot('real', { lastN: 5 })
  assert.equal(snap.recent[0].turn, 1, 'turn 必须来自 data.turn')
  assert.equal(snap.recent[0].step, 1)
  assert.equal(snap.recent[0].route.model, 'deepseek-v4-flash')
  // 没有未知原因时字段可能是 null 也可能不存在：这里断言"没有 reason"，不钉死某个空值
  assert.equal(snap.recent[0].unknownReason ?? null, null)
  assert.notEqual(snap.recent[0].amount, null, '金额必须是已知数')
})

test('EV-2 缓存节省额同时算对（两个单价都在表里才报）', () => {
  const { store, ledger } = harness()
  ledger.onSessionEvent({ id: 'save' }, REAL_EVENT)
  const totals = store.totals('save')
  assert.ok(Math.abs(totals.saved.amount - EXPECTED_SAVED) < 1e-12)
})

test('EV-3 扁平形状仍然兼容（老契约/单测路径不回归）', () => {
  const { store, ledger } = harness()
  ledger.onSessionEvent({ id: 'flat' }, {
    type: 'assistant/message',
    turn: REAL_EVENT.data.turn,
    step: REAL_EVENT.data.step,
    message: REAL_EVENT.data.message,
    usage: REAL_EVENT.data.usage,
  })
  const totals = store.totals('flat')
  assert.ok(Math.abs(totals.cost.amount - EXPECTED_COST) < 1e-12)
})

test('EV-4 真机形状的 tool/result 也能被归因（载荷同样在 data 里）', () => {
  const { store, ledger } = harness()
  ledger.onSessionEvent({ id: 'tool' }, {
    type: 'tool/call',
    seq: 3,
    data: { turn: 1, step: 0, callId: 'c1', name: 'kb.search', arguments: '{}' },
  })
  ledger.onSessionEvent({ id: 'tool' }, {
    type: 'tool/result',
    seq: 4,
    data: {
      turn: 1,
      step: 0,
      message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'x'.repeat(1200) }], source: {} },
    },
  })
  // 上一步工具的结果体量要能取到，否则"这一步为什么贵"解释不了
  assert.equal(store.resultCharsForStep('tool', 1, 0), 1200)
  assert.deepEqual(store.toolsForStep('tool', 1, 0), ['kb.search'])
})
