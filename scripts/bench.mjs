/**
 * 热路径基准（不是压测，只是确认没有隐藏的 O(n)）。
 *
 *   node scripts/bench.mjs
 *
 * 关心三件事：
 *   1. 单事件成本是否是常数级（不随会话长度增长）；
 *   2. 内存是否有界（环形缓冲 + LRU 会话淘汰后 RSS 是否稳定）；
 *   3. 最坏情况（每次事件都换新会话）是否仍不退化。
 */
import { LedgerStore } from '../lib/store.js'
import { createPricing } from '../lib/pricing.js'
import { createAttribution } from '../lib/attribution.js'
import { createTrace } from '../lib/trace.js'
import { createLedger } from '../lib/ledger.js'

const RATES = { 'deepseek/chat': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.2, currency: 'CNY' } }

function build({ capacity = 2000, maxSessions = 64, traceEnabled = false } = {}) {
  const store = new LedgerStore({ capacity, traceCapacity: 5000, traceEnabled, maxSessions })
  const pricing = createPricing({ currency: 'CNY', rates: RATES })
  const attribution = createAttribution({ toolOwners: { 'food.query': 'plugin-food' } })
  const trace = createTrace({ enabled: traceEnabled, capacity: 5000, maxTextLength: 200 })
  const ledger = createLedger({ store, pricing, attribution, trace })
  return { store, ledger }
}

const MODEL_EVENT = (turn, step) => ({
  type: 'assistant/message',
  turn,
  step,
  message: { source: { provider: 'deepseek', model: 'chat' } },
  usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 0 },
})

function run(label, n, { sessions = 4, capacity = 2000 } = {}) {
  const { store, ledger } = build({ capacity })
  // 预热，避免把 JIT 编译计入（复用同一批会话 id，否则会话数会被预热污染）
  for (let i = 0; i < 2000; i += 1) ledger.onSessionEvent({ id: `s${i % sessions}` }, MODEL_EVENT(1, i))

  const start = process.hrtime.bigint()
  for (let i = 0; i < n; i += 1) {
    const sid = `s${i % sessions}`
    if (i % 3 === 0) {
      ledger.onSessionEvent({ id: sid }, { type: 'tool/call', turn: 1, step: i, callId: `c${i}`, name: 'food.query' })
    } else {
      ledger.onSessionEvent({ id: sid }, MODEL_EVENT(1, i))
    }
  }
  const end = process.hrtime.bigint()

  const nsPer = Number(end - start) / n
  const stats = ledger.stats()
  const sessionsHeld = store.sessionCount
  console.log(
    `${label.padEnd(28)} ${n} events  ${(nsPer / 1000).toFixed(2).padStart(8)} µs/event` +
      `  sessions=${sessionsHeld}  failures=${stats.failures}`,
  )
  return nsPer
}

console.log('--- 热路径（容量有界） ---')
const steady4 = run('4 会话 / 混合同步事件', 200_000, { sessions: 4 })
const steady64 = run('64 会话 / 混合同步事件', 200_000, { sessions: 64 })

console.log('--- 最坏情况：每条事件都是新会话（触发 LRU 淘汰） ---')
const churn = run('无限新会话', 100_000, { sessions: 100_000, capacity: 2000 })

console.log('--- 内存（有界验证） ---')
const { ledger } = build()
for (let i = 0; i < 300_000; i += 1) {
  ledger.onSessionEvent({ id: `m${i % 8}` }, MODEL_EVENT(1, i))
}
global.gc?.()
const mb = process.memoryUsage().heapUsed / 1024 / 1024
console.log(`300k 事件后 heapUsed = ${mb.toFixed(1)} MB（环形缓冲固定容量，不随事件数增长）`)

// ---------------------------------------------------------------------------
// CI 门禁：node scripts/bench.mjs --gate
// 阈值取得比实测宽 3–4 倍，只拦"数量级劣化"（例如有人把环形缓冲换成数组 shift），
// 不做微基准抖动判断。
// ---------------------------------------------------------------------------
if (process.argv.includes('--gate')) {
  const LIMIT_STEADY_US = 6
  const LIMIT_CHURN_US = 15
  const MEMORY_LIMIT_MB = 32
  const failures = []
  if (steady4 / 1000 > LIMIT_STEADY_US) failures.push(`稳定态 ${(steady4 / 1000).toFixed(2)}µs > ${LIMIT_STEADY_US}µs`)
  if (steady64 / 1000 > LIMIT_STEADY_US) failures.push(`64 会话 ${(steady64 / 1000).toFixed(2)}µs > ${LIMIT_STEADY_US}µs`)
  if (churn / 1000 > LIMIT_CHURN_US) failures.push(`LRU 抖动 ${(churn / 1000).toFixed(2)}µs > ${LIMIT_CHURN_US}µs`)
  if (mb > MEMORY_LIMIT_MB) failures.push(`heap ${mb.toFixed(1)}MB > ${MEMORY_LIMIT_MB}MB`)
  if (failures.length) {
    console.error(`\nGATE FAIL\n- ${failures.join('\n- ')}`)
    process.exit(1)
  }
  console.log('\nGATE PASS（阈值：稳定态 <6µs、抖动 <15µs、heap <32MB）')
}
