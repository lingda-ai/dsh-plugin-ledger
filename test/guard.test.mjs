import test from 'node:test'
import assert from 'node:assert/strict'
import { createBudgetGuard } from '../lib/guard.js'
import { resolveConfig } from '../lib/config.js'

function fakeStore(amount, unknown = 0) {
  return {
    totals: () => ({ cost: { amount, currency: 'CNY', knownEntries: amount === null ? 0 : 1, unknownEntries: unknown }, tokens: null, entries: 1 }),
  }
}

test('未超阈值不投递', () => {
  const delivered = []
  const g = createBudgetGuard({
    store: fakeStore(5), config: resolveConfig({ budget: { limit: 100, threshold: 0.8 } }), deliver: (_s, f) => delivered.push(f),
  })
  g.onEntry('s', { turn: 1, step: 1 })
  assert.equal(delivered.length, 0)
  assert.equal(g.evaluate('s', 1, 1), null)
})

test('跨越阈值投递一次，回滞到 72% 以下才重新武装', () => {
  let amount = 85
  const delivered = []
  const store = { totals: () => ({ cost: { amount, currency: 'CNY', knownEntries: 1, unknownEntries: 0 }, tokens: null, entries: 1 }) }
  const g = createBudgetGuard({ store, config: resolveConfig({ budget: { limit: 100 } }), deliver: (_s, f) => delivered.push(f) })

  g.onEntry('s', { turn: 1, step: 1 })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].suggestion, 'consider_compaction_or_model_downgrade')
  assert.ok(delivered[0].remainingRatio <= 0.15 + 1e-9)

  g.onEntry('s', { turn: 1, step: 2 })
  assert.equal(delivered.length, 1, '不重复刷屏')

  amount = 80 // 仍在阈值附近，不重新武装
  g.evaluate('s', 1, 3)
  amount = 90
  g.onEntry('s', { turn: 1, step: 4 })
  assert.equal(delivered.length, 1)

  amount = 50 // 低于 80%*0.9 = 72%
  g.evaluate('s', 1, 5)
  amount = 90
  g.onEntry('s', { turn: 1, step: 6 })
  assert.equal(delivered.length, 2)
})

test('有未知成本条目时不做预算判断（宁可不判，也不拿假数字判）', () => {
  const g = createBudgetGuard({ store: fakeStore(999, 1), config: resolveConfig({ budget: { limit: 100 } }), deliver: () => {} })
  assert.equal(g.evaluate('s', 1, 1), null)
})

test('代理签发器失败不影响采集', () => {
  const g = createBudgetGuard({ store: fakeStore(90), config: resolveConfig({ budget: { limit: 100 } }), deliver: () => { throw new Error('boom') } })
  assert.doesNotThrow(() => g.onEntry('s', { turn: 1, step: 1 }))
})

test('未启用预算时 onRequest 原样返回配置', async () => {
  const cfg = { provider: 'p', model: 'm' }
  const g = createBudgetGuard({ store: fakeStore(90), config: resolveConfig({}), deliver: () => {} })
  const out = await g.onRequest({ agent: { session: { id: 's' } } }, async () => cfg)
  assert.equal(out, cfg)
})

test('forget：会话销毁后重新武装，与"回滞"无关，也不会残留', () => {
  let amount = 85
  const store = { totals: () => ({ cost: { amount, currency: 'CNY', knownEntries: 1, unknownEntries: 0 }, tokens: null, entries: 1 }) }
  const g = createBudgetGuard({ store, config: resolveConfig({ budget: { limit: 100, threshold: 0.8 } }) })

  assert.ok(g.evaluate('s-x', 1, 1), '首次超阈值应给事实')
  assert.equal(g.evaluate('s-x', 1, 2), null, 'armed 之后不该重复投递')

  g.forget('s-x')
  assert.ok(g.evaluate('s-x', 2, 1), 'forget 之后应能重新投递')
})
