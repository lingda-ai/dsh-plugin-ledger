import test from 'node:test'
import assert from 'node:assert/strict'
import { createPricing } from '../lib/pricing.js'
import { normalizeUsage } from '../lib/usage.js'

const rates = {
  'deepseek/chat': { input: 0.000001, output: 0.000002, cacheRead: 0.0000002, cacheWrite: 0.0000012, currency: 'CNY' },
}

test('四级计价：缓存读写必须按不同单价，不能平均', () => {
  const p = createPricing({ rates, currency: 'CNY' })
  const u = normalizeUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 0 })
  const cost = p.costOf(u, { provider: 'deepseek', model: 'chat' })
  assert.equal(cost.kind, 'known')
  // 100*1e-6 + 50*2e-6 + 1000*0.2e-6 = 0.0001 + 0.0001 + 0.0002
  assert.ok(Math.abs(cost.amount - 0.0004) < 1e-12, `got ${cost.amount}`)
})

test('费率缺失：unknown，绝不返回 0', () => {
  const p = createPricing({ rates })
  const u = normalizeUsage({ inputTokens: 10, outputTokens: 1 })
  const cost = p.costOf(u, { provider: 'x', model: 'y' })
  assert.equal(cost.kind, 'unknown')
  assert.equal(cost.reason, 'no-rate')
})

test('usage 不完整：unknown/usage-incomplete', () => {
  const p = createPricing({ rates })
  const u = normalizeUsage({ inputTokens: 10 })
  const cost = p.costOf(u, { provider: 'deepseek', model: 'chat' })
  assert.equal(cost.kind, 'unknown')
  assert.equal(cost.reason, 'usage-incomplete')
})

test('裸 model 也能命中，provider/* 作为兜底', () => {
  const p = createPricing({ rates: { chat: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, 'p/*': { input: 2, output: 2, cacheRead: 2, cacheWrite: 2 } } })
  assert.ok(p.rateFor('anything', 'chat'))
  assert.equal(p.rateFor('p', 'other').input, 2)
})

test('四档金额之和等于合计金额（不重不漏）', () => {
  const pricing = createPricing({
    currency: 'CNY',
    rates: { 'deepseek/chat': { input: 1e-6, output: 2e-6, cacheRead: 2e-7, cacheWrite: 1.2e-6 } },
  })
  const usage = { inputTokens: 9260, outputTokens: 1462, cacheReadTokens: 15660, cacheWriteTokens: 0, reasoningTokens: 300, complete: true }
  const cost = pricing.costOf(usage, { provider: 'deepseek', model: 'chat' })
  assert.equal(cost.kind, 'known')
  const sum = cost.parts.input + cost.parts.output + cost.parts.cacheRead + cost.parts.cacheWrite
  assert.ok(Math.abs(sum - cost.amount) < 1e-12)
  assert.ok(Math.abs(cost.parts.input - 9260 * 1e-6) < 1e-12)
  // reasoning 不重复计价：output 档只按 outputTokens 计
  assert.ok(Math.abs(cost.parts.output - 1462 * 2e-6) < 1e-12)
})

test('费率缺失时 unknown 不带 parts（不给半截数字）', () => {
  const pricing = createPricing({ rates: {} })
  const cost = pricing.costOf(
    { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, complete: true },
    { provider: 'x', model: 'y' },
  )
  assert.equal(cost.kind, 'unknown')
  assert.equal(cost.parts, undefined)
})
