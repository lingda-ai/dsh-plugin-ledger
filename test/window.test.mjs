/**
 * 窗口增量：快照要能回答"最近 N 小时花了多少"，而不是只有"这个会话一共花了多少"。
 *
 * 三条约束钉死在这里：
 *   1. 只统计窗口内条目（按 `at` 过滤），窗口外的钱不许混进来；
 *   2. 未知费率单独计数，绝不折成 0；
 *   3. `covered` 必须诚实：环里最老条目晚于窗口起点时，说明窗口起点之前的条目已被淘汰，
 *      此时窗口**可能不完整**，消费方据此降级标注。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LedgerStore } from '../lib/store.js'
import { buildPanelPayload } from '../lib/snapshot-file.js'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 21, 12, 0, 0)

function entry(at, amount, extra = {}) {
  return {
    at,
    sessionId: 'session-a',
    turn: 1,
    step: 1,
    kind: 'model',
    callId: `c-${at}-${amount}`,
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 120, billableInput: 100, complete: true },
    cost: amount === null ? { kind: 'unknown', reason: 'no-rate' } : { kind: 'known', amount, currency: 'CNY', parts: { input: amount, output: 0, cacheRead: 0, cacheWrite: 0 }, tier: 'exact' },
    attribution: { primary: { plugin: 'plugin-food', confidence: 'exact' }, sharedContext: [], system: null },
    route: { provider: 'deepseek-official', model: 'deepseek-flash' },
    savedAmount: amount === null ? undefined : amount * 10,
    ...extra,
  }
}

function store() {
  return new LedgerStore({ capacity: 100, traceCapacity: 10, traceEnabled: false, maxSessions: 5 })
}

test('只统计窗口内条目', () => {
  const s = store()
  s.recordEntry('session-a', entry(NOW - 3 * HOUR, 1))
  s.recordEntry('session-a', entry(NOW - 30 * 60000, 0.25))
  s.recordEntry('session-a', entry(NOW - 10 * 60000, 0.5))
  const w = s.windowTotals('session-a', { hours: 1, now: NOW })
  assert.equal(w.entries, 2)
  assert.equal(w.cost, 0.75)
  assert.equal(w.saved, 7.5)
  assert.equal(w.currency, 'CNY')
  assert.equal(w.hours, 1)
})

test('未知费率单独计数，不折成 0', () => {
  const s = store()
  s.recordEntry('session-a', entry(NOW - 60000, null))
  s.recordEntry('session-a', entry(NOW - 60000, 0.5))
  const w = s.windowTotals('session-a', { hours: 1, now: NOW })
  assert.equal(w.entries, 2)
  assert.equal(w.knownEntries, 1)
  assert.equal(w.unknownEntries, 1)
  assert.equal(w.cost, 0.5)
})

test('covered：最老条目早于窗口起点才算完整', () => {
  const s = store()
  s.recordEntry('session-a', entry(NOW - 2 * HOUR, 1))
  s.recordEntry('session-a', entry(NOW - 60000, 0.2))
  assert.equal(s.windowTotals('session-a', { hours: 1, now: NOW }).covered, true, '有窗口外条目在场 → 覆盖完整')

  const t = store()
  t.recordEntry('session-a', entry(NOW - 10 * 60000, 0.2))
  assert.equal(t.windowTotals('session-a', { hours: 1, now: NOW }).covered, false, '环里全是窗口内条目 → 可能被淘汰过，标记不完整')
})

test('snapshot 只在请求窗口时带 window', () => {
  const s = store()
  s.recordEntry('session-a', entry(NOW - 60000, 0.3))
  assert.equal(s.snapshot('session-a').window, null, '不请求就不带，不冒充 0')
  const withWindow = s.snapshot('session-a', { windowHours: 24 })
  assert.ok(withWindow.window)
  assert.equal(withWindow.window.cost, 0.3)
  assert.equal(withWindow.window.hours, 24)
})

test('buildPanelPayload 把 window 落进 payload', () => {
  const s = store()
  s.recordEntry('session-a', entry(NOW - 60000, 0.3))
  const snapshot = s.snapshot('session-a', { windowHours: 24 })
  const { payload } = buildPanelPayload(snapshot, { sources: [], sourceCount: 0 }, { maxBytes: 262144 })
  assert.ok(payload.window, 'payload 带 window')
  assert.equal(payload.window.cost, 0.3)
  assert.equal(payload.version, 1, '版本号不变：纯增量字段，老消费方忽略即可')

  const legacy = buildPanelPayload({ ...snapshot, window: undefined }, { sources: [], sourceCount: 0 }, { maxBytes: 262144 })
  assert.equal(legacy.payload.window, null, '老快照没有 window 时给 null')
})
