import test from 'node:test'
import assert from 'node:assert/strict'
import { LedgerStore } from '../lib/store.js'

function mk({ maxSessions = 4, capacity = 50 } = {}) {
  return new LedgerStore({ capacity, traceCapacity: 10, traceEnabled: false, maxSessions })
}

let seq = 0
function entry({ at = 1_700_000_000_000, plugin = 'p1', amount = 1, kind = 'known', reason = 'no-rate', turn = 1, step = 1 } = {}) {
  seq += 1
  return {
    at: at + seq,
    sessionId: 's',
    turn, step,
    kind: 'model',
    callId: null,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, complete: true },
    cost: kind === 'known'
      ? { kind: 'known', amount, currency: 'CNY' }
      : { kind: 'unknown', reason },
    attribution: plugin ? { primary: { plugin, confidence: 'exact' } } : { primary: null, unresolvedReason: reason },
    route: { provider: 'deepseek', model: 'chat' },
  }
}

test('sources：按金额降序，含条目数与占比', () => {
  const s = mk()
  s.recordEntry('s1', entry({ plugin: 'a', amount: 3 }))
  s.recordEntry('s1', entry({ plugin: 'a', amount: 3 }))
  s.recordEntry('s1', entry({ plugin: 'b', amount: 4 }))
  const res = s.sources('s1')
  assert.equal(res.sourceCount, 2)
  // a 累计 6 > b 的 4
  assert.deepEqual(res.sources.map((x) => x.plugin), ['a', 'b'])
  assert.equal(res.sources[0].entries, 2)
  assert.equal(res.sources[1].entries, 1)
  assert.equal(res.total, 10)
  assert.equal(Math.round(res.sources[0].share * 100), 60)
  // 占比之和为 1（已知部分内部守恒）
  const sum = res.sources.reduce((acc, x) => acc + x.share, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9)
})

test('sources：unknown 不进金额排序，但单独计数且不补 0', () => {
  const s = mk()
  s.recordEntry('s1', entry({ plugin: 'a', amount: 2 }))
  s.recordEntry('s1', entry({ plugin: null, kind: 'unknown', reason: 'no-rate' }))
  const res = s.sources('s1')
  assert.equal(res.sourceCount, 1)
  assert.equal(res.unknownEntries, 1)
  assert.equal(res.total, 2)
  assert.equal(res.sources[0].share, 1)
})

test('sources：sort=entries / name 生效，limit 截断并标记', () => {
  const s = mk()
  s.recordEntry('s1', entry({ plugin: 'aaa', amount: 1 }))
  s.recordEntry('s1', entry({ plugin: 'aaa', amount: 1 }))
  s.recordEntry('s1', entry({ plugin: 'zzz', amount: 9 }))
  assert.deepEqual(s.sources('s1', { sort: 'entries' }).sources.map((x) => x.plugin), ['aaa', 'zzz'])
  assert.deepEqual(s.sources('s1', { sort: 'name' }).sources.map((x) => x.plugin), ['aaa', 'zzz'])
  const limited = s.sources('s1', { limit: 1 })
  assert.equal(limited.sources.length, 1)
  assert.equal(limited.truncated, true)
  assert.equal(s.sources('s1', { limit: 1 }).sources[0].plugin, 'zzz')
})

test('sources：无该会话返回 null', () => {
  const s = mk()
  assert.equal(s.sources('missing'), null)
})

test('overview：按最近使用排序；只读查询不续命，写入才提前', () => {
  const s = mk({ maxSessions: 3 })
  s.recordEntry('old', entry({ plugin: 'a', amount: 1 }))
  s.recordEntry('mid', entry({ plugin: 'b', amount: 2 }))
  s.recordEntry('new', entry({ plugin: 'c', amount: 3 }))
  assert.deepEqual(s.overview().sessions.map((x) => x.sessionId), ['new', 'mid', 'old'])
  // 只读（totals/snapshot/sources）不得把已淘汰边缘的会话续命
  s.totals('old')
  s.snapshot('old')
  assert.deepEqual(s.overview().sessions.map((x) => x.sessionId), ['new', 'mid', 'old'])
  // 有新事件才算"使用"
  s.recordEntry('old', entry({ plugin: 'a', amount: 1 }))
  assert.deepEqual(s.overview().sessions.map((x) => x.sessionId), ['old', 'new', 'mid'])
})

test('overview：含 lastAt / tokens / 未知计数，超限标记 truncated', () => {
  const s = mk({ maxSessions: 4 })
  s.recordEntry('a', entry({ plugin: 'x', amount: 1, at: 1_000 }))
  s.recordEntry('a', entry({ plugin: null, kind: 'unknown', reason: 'no-rate', at: 1_001 }))
  const ov = s.overview({ limit: 1 })
  assert.equal(ov.sessionCount, 1)
  assert.equal(ov.truncated, false)
  const a = ov.sessions[0]
  assert.equal(a.cost.amount, 1)
  assert.equal(a.cost.unknownEntries, 1)
  assert.equal(a.entries, 2)
  assert.ok(a.lastAt >= 1_001)
  assert.equal(typeof a.tokens.input, 'number')

  for (const id of ['b', 'c', 'd']) s.recordEntry(id, entry({ plugin: 'y', amount: 1 }))
  const capped = s.overview({ limit: 2 })
  assert.equal(capped.truncated, true)
  assert.equal(capped.sessions.length, 2)
})

test('snapshot 带 generatedAt，且 topSources 仍只给 3 条', () => {
  const s = mk()
  for (const plugin of ['p1', 'p2', 'p3', 'p4']) s.recordEntry('s1', entry({ plugin, amount: 1 }))
  const snap = s.snapshot('s1')
  assert.equal(typeof snap.generatedAt, 'number')
  assert.equal(snap.topSources.length, 3)
  assert.equal(s.sources('s1').sourceCount, 4)
})
