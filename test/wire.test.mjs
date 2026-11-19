import test from 'node:test'
import assert from 'node:assert/strict'
import { createTrace } from '../lib/trace.js'
import { WIRE_VERSION, eventIdOf, measuresOf, wireEventOf } from '../lib/wire.js'

test('幂等键：同会话同 turn/step/类型恒等，改任一维度就变', () => {
  const base = { sessionId: 's-1', turn: 2, step: 3, operation: 'assistant/message' }
  const a = eventIdOf(base)
  const b = eventIdOf({ ...base })
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{16}$/)

  // 一个维度不同就必须不同，否则会丢事件
  for (const patch of [{ turn: 3 }, { step: 4 }, { operation: 'assistant/attempt' }, { sessionId: 's-2' }]) {
    assert.notEqual(eventIdOf({ ...base, ...patch }), a, `维度变化后不应撞键：${JSON.stringify(patch)}`)
  }
})

test('measures：0 与缺字段都不进数组，正数按单位入表', () => {
  assert.deepEqual(measuresOf({ inputTokens: 9260, outputTokens: 1462, cacheReadTokens: 15660, cacheWriteTokens: 0 }), [
    { unit: 'token.input', value: 9260 },
    { unit: 'token.output', value: 1462 },
    { unit: 'token.cache_read', value: 15660 },
  ])
  assert.deepEqual(measuresOf({ inputTokens: 0, outputTokens: 0 }), [])
  assert.deepEqual(measuresOf(null), [])
  assert.deepEqual(measuresOf(undefined), [])
})

test('流水行自带三件不可逆字段：eventId / measures / 身份线索', () => {
  const trace = createTrace({ enabled: true, capacity: 100, maxTextLength: 40 })
  const row = trace.project({
    sessionId: 's-9',
    turn: 1,
    step: 1,
    eventType: 'assistant/message',
    pluginSource: '@lingda/tools/hr',
    at: 1_700_000_000_000,
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, complete: true },
    cost: { kind: 'known', amount: 0.001, currency: 'CNY' },
    identity: {
      actor: { email: 'a@b.com', source: 'git-local' },
      project: { key: 'github.com/a/b', source: 'git-remote' },
      deviceId: '0123456789abcdef',
    },
  })
  assert.equal(row.wireVersion, WIRE_VERSION)
  assert.match(row.eventId, /^[0-9a-f]{16}$/)
  assert.deepEqual(row.measures, [{ unit: 'token.input', value: 100 }, { unit: 'token.output', value: 20 }])
  assert.deepEqual(row.actor, { email: 'a@b.com', source: 'git-local' })
  assert.deepEqual(row.project, { key: 'github.com/a/b', source: 'git-remote' })
  assert.equal(row.deviceId, '0123456789abcdef')
})

test('没有身份信息时字段为 null，不编一个占位值', () => {
  const trace = createTrace({ enabled: true, capacity: 100, maxTextLength: 40 })
  const row = trace.project({ sessionId: 's-9', turn: 1, step: 1, eventType: 'assistant/message' })
  assert.equal(row.actor, null)
  assert.equal(row.project, null)
  assert.equal(row.deviceId, null)
})

test('上报投影走白名单：不带 summary，也不带 gen_ai.* 原始字段', () => {
  const trace = createTrace({ enabled: true, capacity: 100, maxTextLength: 40 })
  const row = trace.project({
    sessionId: 's-9',
    turn: 1,
    step: 1,
    eventType: 'assistant/message',
    pluginSource: '@lingda/tools/hr',
    summary: '查了考勤表 sk-abcdefgh1234',
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, complete: true },
    cost: { kind: 'known', amount: 0.001, currency: 'CNY' },
  })
  const wire = wireEventOf(row)
  assert.equal(wire.wireVersion, WIRE_VERSION)
  assert.equal(wire.operation, 'assistant/message')
  assert.equal(wire.plugin, '@lingda/tools/hr')
  assert.equal(wire.summary, undefined, 'summary 不上报（服务端结构上收不到文本）')
  assert.equal(wire['gen_ai.usage.input_tokens'], undefined, '上报口径是 measures，不是 gen_ai 字段')
  assert.deepEqual(wire.measures, [{ unit: 'token.input', value: 100 }, { unit: 'token.output', value: 20 }])
  assert.deepEqual(wire.cost, { amount: 0.001, currency: 'CNY' })
})

test('未知费率也要如实上报原因，不能变成 null 金额了事', () => {
  const trace = createTrace({ enabled: true, capacity: 100, maxTextLength: 40 })
  const row = trace.project({ sessionId: 's-1', turn: 1, step: 1, eventType: 'compaction/start', cost: { kind: 'unknown', reason: 'no-rate' } })
  const wire = wireEventOf(row)
  assert.equal(wire.cost, null)
  assert.equal(wire.costUnknownReason, 'no-rate')
})

test('未来非 token 计量（席位）能直接走 measures 进同一条协议', () => {
  const wire = wireEventOf(
    { timestamp: '2026-01-01T00:00:00.000Z', sessionId: 's-1', turn: 1, step: 1, 'gen_ai.operation.name': 'seat/month', measures: [{ unit: 'seat.month', value: 1 }] },
    { source: 'cursor' },
  )
  assert.equal(wire.source, 'cursor')
  assert.deepEqual(wire.measures, [{ unit: 'seat.month', value: 1 }])
})

test('坏输入返回 null，不抛错', () => {
  assert.equal(wireEventOf(null), null)
  assert.equal(wireEventOf('not-an-object'), null)
})
