import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUsage } from '../lib/usage.js'

test('完整 usage：缓存字段单列，且 billableInput 是派生量', () => {
  const u = normalizeUsage({
    inputTokens: 100, outputTokens: 40,
    cacheReadTokens: 900, cacheWriteTokens: 10,
    reasoningTokens: 5, totalTokens: 1045,
  })
  assert.equal(u.inputTokens, 100)
  assert.equal(u.cacheReadTokens, 900)
  assert.equal(u.cacheWriteTokens, 10)
  // disjoint：input 不含缓存，因此可计费输入 = 100 + 900 + 10
  assert.equal(u.billableInput, 1010)
  assert.equal(u.complete, true)
  assert.equal(u.totalTokens, 1045)
})

test('缺缓存字段：视为 0，但 complete 仍为真', () => {
  const u = normalizeUsage({ inputTokens: 10, outputTokens: 2 })
  assert.equal(u.cacheReadTokens, 0)
  assert.equal(u.cacheWriteTokens, 0)
  assert.equal(u.complete, true)
})

test('缺 output：不可计费（complete=false），不编造为 0', () => {
  const u = normalizeUsage({ inputTokens: 10 })
  assert.equal(u.outputTokens, null)
  assert.equal(u.complete, false)
})

test('totalTokens 缺失：保持 null，不自行相加冒充上游事实', () => {
  const u = normalizeUsage({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 7 })
  assert.equal(u.totalTokens, null)
})

test('无 usage：返回 null', () => {
  assert.equal(normalizeUsage(null), null)
  assert.equal(normalizeUsage({}), null)
})
