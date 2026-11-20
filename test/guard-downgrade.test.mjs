/**
 * 预算降级（agent/request）的完整矩阵。
 *
 * 这是"决策"这条产品路径的全部实现（把下一次请求换到便宜模型/压小 maxTokens），
 * 而它此前**一条用例都没有**：原测试只覆盖"预算未启用时原样返回"，看起来像测过了。
 * 跟着一起修的是 next() 的语义：上游抛错必须冒泡，降级失败必须回退原配置。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { LedgerStore } from '../lib/store.js'
import { createBudgetGuard } from '../lib/guard.js'

const SESSION = 'session-guard-0001'

function entry(amount, { unknown = false } = {}) {
  return {
    at: 1,
    sessionId: SESSION,
    turn: 1,
    step: 1,
    kind: 'model',
    callId: null,
    usage: unknown ? null : { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 20, billableInput: 10, complete: true },
    cost: unknown ? { kind: 'unknown', reason: 'no-rate' } : { kind: 'known', amount, currency: 'CNY', parts: {}, tier: 'exact' },
    attribution: { primary: null, sharedContext: [], system: null },
    route: { provider: 'p', model: 'm' },
    contextChars: null,
    contextSavedTokens: null,
    savedAmount: null,
  }
}

function makeGuard({ spent = 0.1, unknown = false, downgrade = { provider: 'cheap', model: 'mini' }, limit = 0.1, threshold = 0.8 } = {}) {
  const store = new LedgerStore({ capacity: 50, traceCapacity: 5, traceEnabled: false, maxSessions: 4 })
  store.recordEntry(SESSION, entry(spent, { unknown }))
  const config = { budget: { limit, threshold, downgrade } }
  return { store, guard: createBudgetGuard({ store, config, deliver: () => {} }) }
}

const payload = { agent: { session: { id: SESSION } } }
const original = { provider: 'orig', model: 'big', maxTokens: 4096, temperature: 0.3 }
const nextOk = async () => original

test('超过阈值且显式配置降级：替换 provider/model，其余字段原样保留', async () => {
  const { guard } = makeGuard()
  const out = await guard.onRequest(payload, nextOk)
  assert.equal(out.provider, 'cheap')
  assert.equal(out.model, 'mini')
  assert.equal(out.temperature, 0.3, '没让我们改的字段不能动')
  assert.equal(out.maxTokens, 4096)
})

test('maxTokens 一起配了就一起换', async () => {
  const { guard } = makeGuard({ downgrade: { model: 'mini', maxTokens: 128 } })
  const out = await guard.onRequest(payload, nextOk)
  assert.equal(out.model, 'mini')
  assert.equal(out.maxTokens, 128)
  assert.equal(out.provider, 'orig', '只配了 model 就不要动 provider')
})

test('低于阈值：不降级', async () => {
  const { guard } = makeGuard({ spent: 0.02 })
  assert.deepEqual(await guard.onRequest(payload, nextOk), original)
})

test('有未知成本条目时不判预算，也不降级（不能拿不完整的数做决策）', async () => {
  const { guard } = makeGuard({ unknown: true })
  assert.deepEqual(await guard.onRequest(payload, nextOk), original)
})

test('没配降级：即使超预算也原样返回（只告警不擅自改路由）', async () => {
  const { guard } = makeGuard({ downgrade: null })
  assert.deepEqual(await guard.onRequest(payload, nextOk), original)
})

test('没有 session 的 payload：原样返回，不抛', async () => {
  const { guard } = makeGuard()
  assert.deepEqual(await guard.onRequest({}, nextOk), original)
})

test('上游 next() 抛错：错误必须冒泡（不能吞掉伪装成"正常请求"）', async () => {
  const { guard } = makeGuard()
  await assert.rejects(
    () => guard.onRequest(payload, async () => {
      throw new Error('next-boom')
    }),
    /next-boom/,
  )
})

test('降级过程中抛错：回退到原配置而不是让请求崩掉', async () => {
  const { store } = makeGuard()
  const guard = createBudgetGuard({
    store,
    config: { budget: { limit: 0.1, threshold: 0.8, downgrade: { provider: 'cheap' } } },
    deliver: () => {},
  })
  // 让 spent 计算在 try 内抛：把 totals 换成一个会炸的 getter
  const brokenStore = {
    totals() {
      throw new Error('boom-in-spent')
    },
  }
  const guard2 = createBudgetGuard({
    store: brokenStore,
    config: { budget: { limit: 0.1, threshold: 0.8, downgrade: { provider: 'cheap' } } },
    deliver: () => {},
  })
  assert.deepEqual(await guard2.onRequest(payload, nextOk), original)
  assert.ok(typeof guard.onRequest === 'function')
})
