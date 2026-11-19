/**
 * 插件装配集成测试：用一个最小的 cordis 替身验证 index.js 的真实接线，
 * 而不是只测各 lib 模块的内部函数。
 *
 * 这个测试的职责是锁住"接线契约"：
 *   - inject 声明；
 *   - session/event 订阅到采集；
 *   - 账本条目触发预算判定；
 *   - ctx.provide 暴露服务；
 *   - 工具注册形状可被 registry 接受（output.schema + execute）；
 *   - dispose 后不再计数（可卸载）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, inject } from '../lib/index.js'

/** 最小 cordis 替身：只实现本插件真正用到的那几个接口 */
function makeCtx() {
  const handlers = new Map()
  const provided = new Map()
  const registered = []
  const ctx = {
    handlers,
    provided,
    registered,
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
    },
    emit(event, ...args) {
      for (const fn of handlers.get(event) ?? []) fn(...args)
    },
    provide(key, value) {
      provided.set(key, value)
    },
    tools: {
      register(def) {
        registered.push(def)
        return () => {}
      },
    },
  }
  return ctx
}

test('插件元信息：name 与 inject 声明', () => {
  assert.equal(name, 'ledger')
  assert.ok(inject.includes('sessions'))
  assert.ok(inject.includes('tools'))
})

test('装配：订阅、服务暴露、工具注册齐全', () => {
  const ctx = makeCtx()
  const api = apply(ctx, {
    pricing: { currency: 'CNY', rates: { 'deepseek/chat': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } } },
    attribution: { toolOwners: { 'food.query': 'plugin-food' } },
  })

  for (const ev of ['session/event', 'agent/created', 'agent/disposed', 'session/disposed', 'agent/request']) {
    assert.equal(ctx.handlers.get(ev)?.length, 1, `应订阅 ${ev}`)
  }

  assert.equal(ctx.registered.length, 1)
  const tool = ctx.registered[0]
  assert.equal(tool.name, 'ledger_query')
  assert.equal(tool.output.schema.type, 'string')
  assert.equal(typeof tool.execute, 'function')
  assert.deepEqual(tool.output.render({}, 'x'), [{ type: 'text', text: 'x' }])

  assert.equal(ctx.provided.get('ledger'), api)
  assert.equal(api.stats().sessions, 0)
})

test('端到端：事件 → 入账 → 快照可读', () => {
  const ctx = makeCtx()
  const api = apply(ctx, {
    pricing: { currency: 'CNY', rates: { 'deepseek/chat': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } } },
  })
  const session = { id: 's-e2e' }

  ctx.emit('session/event', session, { type: 'tool/call', turn: 1, step: 1, callId: 'c1', name: 'food.query' })
  ctx.emit('session/event', session, {
    type: 'assistant/message',
    turn: 1,
    step: 2,
    message: { source: { provider: 'deepseek', model: 'chat' } },
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
  })

  const snap = api.snapshot('s-e2e')
  assert.equal(snap.recent.length, 1)
  assert.equal(snap.recent[0].kind, 'model')
  assert.equal(snap.totals.cost.amount, 10 * 1 + 2 * 0.1 + 5 * 2)
  assert.equal(api.stats().handled, 2)
  assert.equal(api.stats().failures, 0)
})

test('工具 execute 返回可读摘要，且未知成本不伪造数字', async () => {
  const ctx = makeCtx()
  apply(ctx, { pricing: { currency: 'CNY', rates: {} } })
  const tool = ctx.registered[0]
  ctx.emit('session/event', { id: 's-x' }, {
    type: 'assistant/message', turn: 1, step: 1,
    message: { source: { provider: 'deepseek', model: 'chat' } },
    usage: { inputTokens: 3, outputTokens: 1 },
  })
  const text = await tool.execute({ sessionId: 's-x', lastN: 5 }, {})
  assert.equal(typeof text, 'string')
  assert.match(text, /未知/)
  assert.match(text, /s-x/)
})

test('session/disposed 会释放该会话账本（内存不跨会话累积）', () => {
  const ctx = makeCtx()
  const api = apply(ctx, {})
  const session = { id: 's-drop' }
  ctx.emit('session/event', session, {
    type: 'assistant/message', turn: 1, step: 1,
    message: { source: { provider: 'p', model: 'm' } },
    usage: { inputTokens: 1, outputTokens: 1 },
  })
  assert.equal(api.stats().sessions, 1)
  ctx.emit('session/disposed', session)
  assert.equal(api.stats().sessions, 0)
  assert.equal(api.snapshot('s-drop'), null)
})

test('坏事件不冒泡：失败计数 +1，后续事件照常入账', () => {
  const ctx = makeCtx()
  // 流水默认关闭（隐私优先），本用例显式打开
  const api = apply(ctx, { trace: { enabled: true, capacity: 20, maxTextLength: 40 } })
  const session = { id: 's-bad' }
  ctx.emit('session/event', session, {
    type: 'assistant/message',
    get usage() { throw new Error('boom') },
    message: { source: { provider: 'p', model: 'm' } },
  })
  assert.equal(api.stats().failures, 1)
  ctx.emit('session/event', session, { type: 'tool/call', turn: 1, step: 1, callId: 'c', name: 'x' })
  assert.equal(api.stats().handled, 2)
  assert.equal(api.snapshot('s-bad').trace.length, 1)
})
