/**
 * 来源桶的口径：拆不开（shared:unknown）与没信号（unattributed）必须分开。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { LedgerStore, sourceKeyOf } from '../lib/store.js'

test('有 primary 的条目记到插件名', () => {
  assert.equal(
    sourceKeyOf({ attribution: { primary: { plugin: '@lingzhi/tools/hr', confidence: 'exact' } } }),
    '@lingzhi/tools/hr',
  )
})

test('压缩调用记到 system:compaction，不算任何插件的账', () => {
  assert.equal(sourceKeyOf({ attribution: { primary: null, sharedContext: [], system: 'compaction' } }), 'system:compaction')
})

test('多个已知 owner 共同贡献 → shared:unknown（拆不开，但有来源）', () => {
  const entry = {
    attribution: {
      primary: null,
      sharedContext: [
        { plugin: 'a', note: 'shared-context-cost' },
        { plugin: 'b', note: 'shared-context-cost' },
      ],
      unresolvedReason: 'multi-contributor',
    },
  }
  assert.equal(sourceKeyOf(entry), 'shared:unknown')
})

test('完全没有归因信号 → unattributed（不是拆不开，是没来源）', () => {
  assert.equal(sourceKeyOf({ attribution: { primary: null, sharedContext: [], unresolvedReason: 'no-signal' } }), 'unattributed')
  assert.equal(sourceKeyOf({ attribution: undefined }), 'unattributed')
  // 只有未列名工具时也属于"没来源"
  assert.equal(
    sourceKeyOf({
      attribution: { primary: null, sharedContext: [{ plugin: 'tool:shell', note: 'unlisted-tool' }], unresolvedReason: 'no-origin' },
    }),
    'unattributed',
  )
})

test('存储层：两个桶各自累计，不会互相吞并', () => {
  const store = new LedgerStore({ capacity: 10, traceCapacity: 10, traceEnabled: false, maxSessions: 2 })
  const base = {
    at: 1,
    sessionId: 's1',
    turn: 1,
    step: 1,
    kind: 'model',
    callId: 'c1',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, complete: true },
    cost: { kind: 'known', amount: 0.01, parts: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 }, currency: 'CNY', tier: 'exact' },
  }
  store.recordEntry('s1', {
    ...base,
    attribution: { primary: null, sharedContext: [{ plugin: 'a', note: 'shared-context-cost' }], unresolvedReason: 'multi-contributor' },
  })
  store.recordEntry('s1', { ...base, callId: 'c2', attribution: { primary: null, sharedContext: [], unresolvedReason: 'no-signal' } })
  const keys = store.sources('s1').sources.map((s) => s.plugin).sort()
  assert.deepEqual(keys, ['shared:unknown', 'unattributed'])
})
