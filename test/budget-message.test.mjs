import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeBudgetMessage } from '../lib/budget-message.js'

const FACT = { spent: 3.2, limit: 5, currency: 'CNY', remainingRatio: 0.36, asOfStep: { turn: 2, step: 5 } }

test('有构造函数时产出合法 user 消息（形态对齐 createUserMessage）', () => {
  const calls = []
  const fake = (input) => {
    calls.push(input)
    return { id: 'm1', role: 'user', ...input }
  }
  const msg = makeBudgetMessage(FACT, fake)
  assert.equal(msg.role, 'user')
  assert.deepEqual(msg.source, { kind: 'user' })
  assert.equal(typeof msg.content[0].text, 'string')
  assert.match(msg.content[0].text, /已花费 CNY3\.2000/)
  assert.match(msg.content[0].text, /剩余 36%/)
  assert.equal(calls.length, 1)
})

test('没有构造函数时返回 null（通道自动降级，不抛错）', () => {
  assert.equal(makeBudgetMessage(FACT, null), null)
  assert.equal(makeBudgetMessage(FACT, undefined), null)
})

test('异常入参不炸：没有剩余比例也能给出可读文本', () => {
  const fake = (input) => ({ id: 'm', role: 'user', ...input })
  const msg = makeBudgetMessage({ spent: 1, limit: 2, currency: 'USD' }, fake)
  assert.match(msg.content[0].text, /剩余 0%/)
  assert.equal(makeBudgetMessage(null, fake), null)
})
