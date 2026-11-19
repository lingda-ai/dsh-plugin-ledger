import test from 'node:test'
import assert from 'node:assert/strict'
import { createPricing } from '../lib/pricing.js'
import { resolveConfig } from '../lib/config.js'
import { BUILTIN_RATES, BUILTIN_SOURCE, builtinRateTable } from '../lib/pricing-table.js'
import { normalizeUsage } from '../lib/usage.js'

const usage = normalizeUsage({
  inputTokens: 9260,
  outputTokens: 1462,
  cacheReadTokens: 15660,
  cacheWriteTokens: 0,
  reasoningTokens: 312,
  complete: true,
})

test('内置表锚定官方价（元/百万 tokens 换算到 元/token）', () => {
  assert.equal(BUILTIN_RATES['deepseek-v4-flash'].input, 1e-6)
  assert.equal(BUILTIN_RATES['deepseek-v4-flash'].output, 2e-6)
  assert.equal(BUILTIN_RATES['deepseek-v4-flash'].cacheRead, 2e-8)
  assert.equal(BUILTIN_RATES['deepseek-v4-pro'].input, 3e-6)
  assert.equal(BUILTIN_RATES['deepseek-v4-pro'].output, 6e-6)
  assert.equal(BUILTIN_RATES['deepseek-v4-pro'].cacheRead, 2.5e-8)
})

test('flash 四档金额与手算一致', () => {
  const pricing = createPricing({ currency: 'CNY', rates: BUILTIN_RATES })
  const cost = pricing.costOf(usage, { provider: 'deepseek', model: 'deepseek-v4-flash' })
  assert.equal(cost.kind, 'known')
  // 9260 × 1e-6 = 0.00926；15660 × 2e-8 = 0.0003132；1462 × 2e-6 = 0.002924
  assert.equal(Number(cost.parts.input.toFixed(10)), 0.00926)
  assert.equal(Number(cost.parts.cacheRead.toFixed(10)), 0.0003132)
  assert.equal(Number(cost.parts.output.toFixed(10)), 0.002924)
  assert.equal(Number(cost.amount.toFixed(10)), 0.0124972)
})

test('pro 四档金额与手算一致', () => {
  const pricing = createPricing({ currency: 'CNY', rates: BUILTIN_RATES })
  const cost = pricing.costOf(usage, { provider: 'deepseek', model: 'deepseek-v4-pro' })
  assert.equal(Number(cost.parts.input.toFixed(10)), 0.02778)
  assert.equal(Number(cost.parts.cacheRead.toFixed(10)), 0.0003915)
  assert.equal(Number(cost.parts.output.toFixed(10)), 0.008772)
  assert.equal(Number(cost.amount.toFixed(10)), 0.0369435)
})

test('deepseek-chat 是 flash 的别名（官方脚注明示），价格同额', () => {
  const pricing = createPricing({ currency: 'CNY', rates: BUILTIN_RATES })
  const a = pricing.costOf(usage, { provider: 'deepseek', model: 'deepseek-chat' })
  const b = pricing.costOf(usage, { provider: 'deepseek', model: 'deepseek-v4-flash' })
  assert.equal(a.kind, 'known')
  assert.equal(a.amount, b.amount)
})

test('未在表里的模型仍然 unknown，不给 0', () => {
  const pricing = createPricing({ currency: 'CNY', rates: BUILTIN_RATES })
  const cost = pricing.costOf(usage, { provider: 'deepseek', model: 'deepseek-v9' })
  assert.equal(cost.kind, 'unknown')
  assert.equal(cost.reason, 'no-rate')
})

test('用户配置按单模型深合并：只改 output，其余保留', () => {
  const config = resolveConfig({ pricing: { rates: { 'deepseek-v4-flash': { output: 4e-6 } } } })
  const pricing = createPricing(config.pricing)
  const cost = pricing.costOf(usage, { provider: 'deepseek', model: 'deepseek-v4-flash' })
  assert.equal(Number(cost.parts.output.toFixed(10)), 0.005848) // 1462 × 4e-6
  assert.equal(Number(cost.parts.input.toFixed(10)), 0.00926) // 未被覆盖
  // 其它模型不受影响
  const pro = pricing.costOf(usage, { provider: 'deepseek', model: 'deepseek-v4-pro' })
  assert.equal(Number(pro.parts.output.toFixed(10)), 0.008772)
})

test('可读表用于文档/面板，单位是元/百万', () => {
  const table = builtinRateTable()
  const flash = table.find((row) => row.model === 'deepseek-v4-flash')
  assert.equal(flash.perMillion.input, 1)
  assert.equal(flash.perMillion.output, 2)
  assert.equal(flash.perMillion.cacheRead, 0.02)
  assert.match(BUILTIN_SOURCE, /api-docs\.deepseek\.com/)
})
