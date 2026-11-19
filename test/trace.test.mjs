import test from 'node:test'
import assert from 'node:assert/strict'
import { createTrace, redactText } from '../lib/trace.js'

test('脱敏：密钥样式与绝对路径都不外泄', () => {
  const out = redactText('call with sk-abcdef123456 and /home/user/secret/project/foo.ts', 200)
  assert.ok(!out.includes('sk-abcdef123456'))
  assert.ok(!out.includes('/home/user'))
  assert.equal(typeof out, 'string')
})

test('长文本截断到上限', () => {
  const out = redactText('a'.repeat(500), 20)
  assert.equal(out.length, 21) // 20 + 省略号
  assert.ok(out.endsWith('…'))
})

test('关闭时不产生记录', () => {
  const t = createTrace({ enabled: false })
  assert.equal(t.project({ sessionId: 's', turn: 1, step: 1, eventType: 'chat' }), null)
})

test('OTel GenAI 字段命名', () => {
  const t = createTrace({ enabled: true, maxTextLength: 50 })
  const r = t.project({
    sessionId: 's', turn: 1, step: 2, eventType: 'chat',
    pluginSource: 'p', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    cost: { kind: 'unknown', reason: 'no-rate' },
  })
  assert.equal(r['gen_ai.operation.name'], 'chat')
  assert.equal(r['gen_ai.agent.name'], 'p')
  assert.equal(r['gen_ai.usage.cache_read_tokens'], 3)
  assert.equal(r.cost, null)
  assert.equal(r.costUnknownReason, 'no-rate')
})
