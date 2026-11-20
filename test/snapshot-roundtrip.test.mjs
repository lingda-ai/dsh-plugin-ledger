/**
 * 快照往返：Host 写盘 → 浏览器按行分页读回。
 *
 * 这条链路是面板"能看见数据"的唯一通路，而它此前从未被端到端测过：
 *   - Host 侧测的是 payload 对象（没写盘）；
 *   - 浏览器侧测的是 mock 远程（没真文件）；
 *   - 两侧各用小样本，谁都没发现 `read` 是**按行分页**的，而真实快照有 400+ 行。
 * 结果是：任何稍成熟点的会话打开面板都显示"读取失败：快照过长"。
 *
 * 所以这里用真 store + 真 publisher + 真文件 + 按行分页的假 remote，
 * 断言"20 条明细的快照能完整读回"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LedgerStore } from '../lib/store.js'
import { createSnapshotPublisher } from '../lib/snapshot-file.js'
import { panelRelativePath } from '../lib/panel-path.js'
import { createFetchView } from '../lib/client.src.js'

const SESSION = 'session-roundtrip-0001'

/** 造一个有 20 条明细的账本（一条也不能少，否则测不出分页）。 */
function makeStore(entries = 20) {
  const store = new LedgerStore({ capacity: 200, traceCapacity: 10, traceEnabled: false, maxSessions: 8 })
  for (let i = 0; i < entries; i += 1) {
    store.recordEntry(SESSION, {
      at: Date.UTC(2026, 10, 20, 14, 0, i),
      sessionId: SESSION,
      turn: i + 1,
      step: 1,
      kind: 'model',
      callId: `call-${i}`,
      usage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 180_000, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 181_020, billableInput: 180_900, complete: true },
      cost: { kind: 'known', amount: 0.004, currency: 'CNY', parts: { input: 0.0009, output: 0.00024, cacheRead: 0.0036, cacheWrite: 0 }, tier: 'exact' },
      attribution: { primary: null, sharedContext: [], system: null, unresolvedReason: 'no-origin' },
      route: { provider: 'deepseek-official', model: 'deepseek-flash' },
      contextChars: 512,
      contextSavedTokens: null,
      savedAmount: 0.0176,
    })
  }
  return store
}

/**
 * 按宿主语义实现的 workspaceFiles：`read` 取的是**行窗口**，
 * offset 是首页行号（从 1 开始），limit 是最大行数，eof 表示是否到了最后一行。
 */
function linePagedRemote(absolutePath, { pageLines = 400 } = {}) {
  const text = readFileSync(absolutePath, 'utf8')
  const lines = text.split('\n')
  const reads = []
  return {
    reads,
    async stat() {
      return { ok: true, value: { absolutePath, bytes: Buffer.byteLength(text), version: 1 } }
    },
    async read(scopeId, path, range = {}) {
      reads.push({ scopeId, path, offset: range.offset, limit: range.limit })
      const offset = Math.max(1, range.offset ?? 1)
      const limit = Math.min(pageLines, range.limit ?? pageLines)
      const start = offset - 1
      const slice = lines.slice(start, start + limit)
      return {
        ok: true,
        value: { offset, lines: slice.length, text: slice.join('\n'), eof: start + slice.length >= lines.length },
      }
    },
  }
}

function ctxWith(remote) {
  const services = { remote: { workspaceFiles: remote } }
  return { remote: services.remote, get: (name) => services[name] ?? null }
}

test('20 条明细的快照（400+ 行）能被完整读回，而不是"快照过长"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-roundtrip-'))
  try {
    const store = makeStore(20)
    const publisher = createSnapshotPublisher({
      dir: '.dsh/ledger',
      rootOf: () => dir,
      snapshot: (sid) => store.snapshot(sid, { lastN: 20 }),
      sources: (sid) => store.sources(sid, { limit: 20 }),
      overview: () => store.overview({ limit: 8 }),
      budget: { limit: null, currency: 'CNY' },
      pricing: { kind: 'builtin', asOf: '2026-11-19', source: null, models: [], rejected: [], error: null },
      now: () => 1_795_185_000_000,
    })
    assert.equal(publisher.publishNow(SESSION), true)

    const file = publisher.filePathOf(SESSION)
    const lineCount = readFileSync(file, 'utf8').split('\n').length
    assert.ok(lineCount > 400, `快照应有 400+ 行（实际 ${lineCount}），否则测不出分页问题`)

    const remote = linePagedRemote(file)
    const fetchView = createFetchView(ctxWith(remote))
    const view = await fetchView(SESSION, {})
    assert.equal(view?.error, undefined, `读回失败：${view?.error}`)
    assert.equal(view.totals.entries, 20)
    assert.equal(view.recent.length, 20, '最近明细应完整保留 20 条')
    // 分页确实发生了：不止一次 read
    assert.ok(remote.reads.length > 1, `应翻页读取（实际 ${remote.reads.length} 次）`)
    assert.equal(remote.reads[0].limit, 400)
    assert.equal(remote.reads[1].offset, 401, '第二页从第 401 行开始')
    // 参数位也要对：scopeId 是 sessionId，path 是宿主给的绝对路径
    assert.equal(remote.reads[0].scopeId, SESSION)
    assert.equal(remote.reads[0].path, file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('超过 maxBytes 时 truncated 真的落到文件里，面板才看得见"明细已截断"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-trunc-'))
  try {
    const store = makeStore(20)
    const publisher = createSnapshotPublisher({
      dir: '.dsh/ledger',
      rootOf: () => dir,
      maxBytes: 4000,
      snapshot: (sid) => store.snapshot(sid, { lastN: 20 }),
      sources: (sid) => store.sources(sid, { limit: 20 }),
      budget: { limit: null, currency: 'CNY' },
      now: () => 1,
    })
    assert.equal(publisher.publishNow(SESSION), true)
    const raw = JSON.parse(readFileSync(publisher.filePathOf(SESSION), 'utf8'))
    assert.equal(raw.truncated, true, 'truncated 必须是落盘字段，不能只存在于返回值')
    assert.ok(Buffer.byteLength(JSON.stringify(raw)) <= 4000, '二级降级后必须真的不超 maxBytes')
    assert.equal(publisher.stats.truncated, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('默认尺寸下不标截断', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-notrunc-'))
  try {
    const store = makeStore(20)
    const publisher = createSnapshotPublisher({
      dir: '.dsh/ledger',
      rootOf: () => dir,
      snapshot: (sid) => store.snapshot(sid, { lastN: 20 }),
      sources: (sid) => store.sources(sid, { limit: 20 }),
      budget: { limit: null, currency: 'CNY' },
      now: () => 1,
    })
    publisher.publishNow(SESSION)
    const raw = JSON.parse(readFileSync(publisher.filePathOf(SESSION), 'utf8'))
    assert.equal(raw.truncated, false)
    assert.ok(Array.isArray(raw.sources) || raw.sources === undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
