/**
 * totals 的四档金额：只累加已知条目，无已知条目时 parts 为 null。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { LedgerStore } from '../lib/store.js'

function makeStore() {
  return new LedgerStore({ capacity: 10, traceCapacity: 10, traceEnabled: false, maxSessions: 2 })
}

function entryWith(amount, parts) {
  return {
    at: 1,
    sessionId: 's1',
    turn: 1,
    step: 1,
    kind: 'model',
    callId: 'c1',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0, reasoningTokens: 0, missing: 0, complete: true },
    cost: { kind: 'known', amount, parts, currency: 'CNY', tier: 'exact' },
    attribution: { primary: { plugin: 'p', confidence: 'exact' } },
    route: { provider: 'deepseek', model: 'chat' },
  }
}

test('四档金额按条目累加，合计与 parts 自洽', () => {
  const store = makeStore()
  store.recordEntry('s1', entryWith(0.01, { input: 0.004, output: 0.003, cacheRead: 0.003, cacheWrite: 0 }))
  store.recordEntry('s1', entryWith(0.02, { input: 0.008, output: 0.006, cacheRead: 0.006, cacheWrite: 0 }))
  const totals = store.totals('s1')
  assert.equal(totals.cost.amount.toFixed(4), '0.0300')
  assert.equal(totals.cost.parts.input.toFixed(4), '0.0120')
  assert.equal(totals.cost.parts.output.toFixed(4), '0.0090')
  assert.equal(totals.cost.parts.cacheRead.toFixed(4), '0.0090')
  const sum = Object.values(totals.cost.parts).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - totals.cost.amount) < 1e-9)
})

test('只有未知费率条目时 parts 为 null，amount 也是 null', () => {
  const store = makeStore()
  store.recordEntry('s1', {
    ...entryWith(0.01, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    cost: { kind: 'unknown', reason: 'no-rate' },
  })
  const totals = store.totals('s1')
  assert.equal(totals.cost.amount, null)
  assert.equal(totals.cost.parts, null)
  assert.equal(totals.cost.unknownEntries, 1)
})

test('没有该会话时 totals 是空壳，不抛错', () => {
  const totals = makeStore().totals('nope')
  assert.equal(totals.entries, 0)
  assert.equal(totals.cost.parts, null)
})
