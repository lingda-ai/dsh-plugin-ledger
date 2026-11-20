/**
 * 面板快照落盘：原子、节流、可截断、失败不影响采集。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SNAPSHOT_VERSION,
  normalizeBudget,
  compactEntry,
  compactSession,
  safeFileName,
  peakOf,
  withPanelTotals,
  buildPanelPayload,
  createSnapshotPublisher,
  readPanelFile,
} from '../lib/snapshot-file.js'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'ledger-panel-'))
}

const snap = {
  sessionId: 'session-abc',
  generatedAt: '2026-11-19T10:00:00.000Z',
  totals: { cost: { amount: 0.015316, currency: 'CNY', knownEntries: 6, unknownEntries: 0 }, tokens: null, entries: 6 },
  topSources: [{ plugin: '@lingzhi/tools/hr', amount: 0.005552, entries: 1, share: 0.362 }],
}
const srcs = { sessionId: 'session-abc', sourceCount: 5, truncated: false, sources: [{ plugin: 'hr', amount: 0.005552, entries: 1, share: 0.362 }] }

test('文件名只保留安全字符，空值退化为 unknown', () => {
  assert.equal(safeFileName('session-9f2a41'), 'session-9f2a41')
  assert.equal(safeFileName('../../etc/passwd'), '______etc_passwd')
  assert.equal(safeFileName(''), 'unknown')
  assert.equal(safeFileName(null), 'unknown')
})

test('payload 带版本号与口径字段', () => {
  const { payload, truncated } = buildPanelPayload(snap, srcs)
  assert.equal(truncated, false)
  assert.equal(payload.version, SNAPSHOT_VERSION)
  assert.equal(payload.sessionId, 'session-abc')
  assert.equal(payload.totals.cost.currency, 'CNY')
  assert.equal(payload.sources.length, 1)
  assert.equal(payload.sourceCount, 5)
})

test('超限降级为合计 + Top，不带明细', () => {
  const big = { ...srcs, sources: Array.from({ length: 500 }, (_, i) => ({ plugin: `p${i}`, amount: 0.1, entries: 1, share: 0 })) }
  const r = buildPanelPayload(snap, big, { maxBytes: 1024 })
  assert.equal(r.truncated, true)
  assert.equal(r.payload.sources, undefined)
  assert.ok(r.payload.totals)
})

test('写盘是原子的：目录自动创建，无 .tmp 残留', () => {
  const dir = join(tmpDir(), 'nested', 'ledger')
  const pub = createSnapshotPublisher({ dir, snapshot: () => snap, sources: () => srcs })
  assert.equal(pub.publishNow('session-abc'), true)
  const files = readdirSync(dir)
  assert.deepEqual(files, ['session-abc.json'])
  const back = readPanelFile(join(dir, 'session-abc.json'))
  assert.equal(back.sessionId, 'session-abc')
  assert.equal(back.version, SNAPSHOT_VERSION)
  pub.dispose()
})

test('没有快照的会话不写文件（已淘汰）', () => {
  const dir = tmpDir()
  const pub = createSnapshotPublisher({ dir, snapshot: () => null, sources: () => null })
  assert.equal(pub.publishNow('gone'), false)
  assert.equal(existsSync(join(dir, 'gone.json')), false)
})

test('节流：intervalMs 内同一会话只落一次，别的会话不受影响', () => {
  const dir = tmpDir()
  let clock = 1000
  const pub = createSnapshotPublisher({ dir, intervalMs: 3000, snapshot: () => snap, sources: () => srcs, now: () => clock })
  assert.equal(pub.schedule('s1'), true)
  clock += 1000
  assert.equal(pub.schedule('s1'), false) // 被节流
  assert.equal(pub.schedule('s2'), true) // 另一个会话
  clock += 3000
  assert.equal(pub.schedule('s1'), true) // 间隔够了
  assert.equal(pub.stats.writes, 3)
  pub.dispose()
})

test('异常被吞掉并计数，不向上抛', () => {
  const dir = tmpDir()
  const pub = createSnapshotPublisher({
    dir,
    snapshot: () => {
      throw new Error('boom')
    },
    sources: () => null,
  })
  assert.equal(pub.publishNow('s1'), false)
  assert.equal(pub.stats.errors, 1)
})

test('会话结束删快照并忘记节流状态', () => {
  const dir = tmpDir()
  let clock = 1000
  const pub = createSnapshotPublisher({ dir, intervalMs: 3000, snapshot: () => snap, sources: () => srcs, now: () => clock })
  pub.schedule('s1')
  assert.equal(existsSync(join(dir, 's1.json')), true)
  pub.remove('s1')
  assert.equal(existsSync(join(dir, 's1.json')), false)
  assert.equal(pub.schedule('s1'), true) // 状态已清，立刻可写
})

test('写坏的文件读回 null，不抛错', () => {
  const dir = tmpDir()
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{not json', 'utf8')
  assert.equal(readPanelFile(bad), null)
  assert.equal(readPanelFile(join(dir, 'missing.json')), null)
})

test('相对目录 + rootOf：每个会话写进自己的工作区根', () => {
  const base = tmpDir()
  const roots = { s1: join(base, 'ws1'), s2: join(base, 'ws2') }
  const pub = createSnapshotPublisher({
    dir: '.dsh/ledger',
    snapshot: () => ({ ...snap, sessionId: 's1' }),
    sources: () => srcs,
    rootOf: (sessionId) => roots[sessionId] ?? base,
  })
  assert.equal(pub.publishNow('s1'), true)
  assert.equal(pub.publishNow('s2'), true)
  assert.equal(existsSync(join(roots.s1, '.dsh', 'ledger', 's1.json')), true)
  assert.equal(existsSync(join(roots.s2, '.dsh', 'ledger', 's2.json')), true)
})

test('落盘是多行 JSON：浏览器按行分页读得动', () => {
  const dir = tmpDir()
  const pub = createSnapshotPublisher({ dir, snapshot: () => snap, sources: () => srcs })
  pub.publishNow('session-abc')
  const text = readFileSync(join(dir, 'session-abc.json'), 'utf8')
  assert.ok(text.split('\n').length > 5, '应至少写成一个可分行读取的对象')
  assert.ok(JSON.parse(text).totals)
})

test('预算读数：限额为 null 时整个字段为 null', () => {
  assert.equal(normalizeBudget({ limit: null }, snap.totals), null)
  assert.equal(normalizeBudget(undefined, snap.totals), null)
  assert.equal(normalizeBudget({ limit: 0 }, snap.totals), null)
})

test('预算读数：已用取合计金额，ratio 封顶 1，金额缺失不编 0', () => {
  const b = normalizeBudget({ limit: 0.03, currency: 'CNY' }, snap.totals)
  assert.equal(b.limit, 0.03)
  assert.equal(b.used, 0.015316)
  assert.ok(Math.abs(b.ratio - 0.5105333333) < 1e-6)
  const over = normalizeBudget({ limit: 0.01 }, { cost: { amount: 0.5, currency: 'CNY' } })
  assert.equal(over.ratio, 1)
  const missing = normalizeBudget({ limit: 0.03 }, { cost: { amount: null } })
  assert.equal(missing.used, null)
  assert.equal(missing.ratio, null)
})

test('payload 里带上预算（未启用时为 null）', () => {
  const off = buildPanelPayload(snap, srcs, { budget: { limit: null } })
  assert.equal(off.payload.budget, null)
  const on = buildPanelPayload(snap, srcs, { budget: { limit: 0.03, currency: 'CNY' } })
  assert.equal(on.payload.budget.limit, 0.03)
})

test('明细压缩：去掉 trace/callId，金额未知给原因而不是 0', () => {
  const known = compactEntry({
    at: 1700000000000,
    turn: 2,
    step: 3,
    kind: 'model',
    callId: 'c1',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0, reasoningTokens: 7, missing: 0, complete: true },
    cost: { kind: 'known', amount: 0.01, parts: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 }, currency: 'CNY', tier: 'exact' },
    attribution: { primary: { plugin: 'p', confidence: 'exact' } },
    route: { provider: 'deepseek', model: 'chat' },
    trace: { huge: true },
  })
  assert.equal(known.amount, 0.01)
  assert.equal(known.unknownReason, null)
  assert.equal(known.plugin, 'p')
  assert.equal(known.trace, undefined)
  assert.equal(known.callId, undefined)
  assert.equal(known.tokens.input, 10)

  const unknown = compactEntry({ kind: 'model', cost: { kind: 'unknown', reason: 'no-rate' }, attribution: { primary: null } })
  assert.equal(unknown.amount, null)
  assert.equal(unknown.unknownReason, 'no-rate')
})

test('会话对比项只保留四个字段', () => {
  const row = compactSession({
    sessionId: 's2',
    cost: { amount: 0.02, currency: 'CNY', knownEntries: 3, unknownEntries: 1 },
    tokens: { input: 1 },
    entries: 4,
    lastAt: 123,
  })
  assert.deepEqual(row, { sessionId: 's2', amount: 0.02, currency: 'CNY', entries: 4, lastAt: 123 })
})

test('payload 带 recent 与 overview，且都做了压缩', () => {
  const payload = buildPanelPayload(
    { ...snap, recent: [{ kind: 'model', cost: { kind: 'unknown', reason: 'no-rate' }, attribution: { primary: null } }] },
    srcs,
    { overview: [{ sessionId: 's2', cost: { amount: 0.02, currency: 'CNY' }, entries: 2, lastAt: 9 }] },
  )
  assert.equal(payload.payload.recent.length, 1)
  assert.equal(payload.payload.recent[0].amount, null)
  assert.equal(payload.payload.overview[0].sessionId, 's2')
})

test('peakOf：只在已知金额里挑最大，未知不参与比较', () => {
  const recent = [
    { at: 1, turn: 1, step: 1, kind: 'model', amount: 0.002, unknownReason: null, route: { provider: 'deepseek', model: 'flash' } },
    { at: 2, turn: 2, step: 1, kind: 'model', amount: null, unknownReason: 'no-rate', route: null },
    { at: 3, turn: 2, step: 2, kind: 'model', amount: 0.009, unknownReason: null, route: { provider: 'deepseek', model: 'pro' } },
    null,
  ]
  const peak = peakOf(recent)
  assert.equal(peak.amount, 0.009)
  assert.equal(peak.turn, 2)
  assert.equal(peak.step, 2)
  assert.equal(peak.model, 'pro')
})

test('peakOf：全是未知金额时返回 null，不拿 0 冒充', () => {
  assert.equal(peakOf([{ amount: null, unknownReason: 'no-rate' }]), null)
  assert.equal(peakOf([]), null)
})


test('withPanelTotals：命中率分母只算未命中输入 + 命中输入', () => {
  const t = withPanelTotals({ tokens: { input: 9260, output: 1462, cacheRead: 15660, cacheWrite: 0, reasoning: 312 } })
  assert.equal(t.cacheHitRate, 15660 / 24920) // 缓存写不参与分母
  assert.equal(t.tokens.input, 9260)           // 原字段不动
})

test('withPanelTotals：没有 token 计数时命中率给 null，不给 0', () => {
  assert.equal(withPanelTotals(null), null)
  assert.equal(withPanelTotals({ tokens: null }).cacheHitRate, null)
})

test('normalizeBudget：按已知条目均价算"还可约几次"，未知条目不算进均价', () => {
  const budget = normalizeBudget(
    { limit: 0.03, currency: 'CNY' },
    { cost: { amount: 0.015316, knownEntries: 6, unknownEntries: 2 } },
  )
  assert.equal(budget.perCall, 0.015316 / 6)
  assert.equal(budget.remaining, 0.03 - 0.015316)
  assert.equal(budget.callsLeft, 5) // floor(0.014684 / 0.0025527) = 5
})

test('normalizeBudget：没有已知条目时不算均价（避免用假数预测）', () => {
  const budget = normalizeBudget({ limit: 0.03 }, { cost: { amount: null, knownEntries: 0 } })
  assert.equal(budget.callsLeft, null)
})

test('生成时间统一成 ISO 字符串（store 给的是数字，面板按字符串截取）', () => {
  const at = 1795159549380
  const { payload } = buildPanelPayload(
    { sessionId: 's1', generatedAt: at, totals: { entries: 0, cost: { amount: null } }, recent: [], topSources: [] },
    { sources: [], sourceCount: 0 },
  { maxBytes: 262144 }
  )
  assert.equal(typeof payload.generatedAt, 'string')
  assert.match(payload.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(new Date(payload.generatedAt).getTime(), at)
})
