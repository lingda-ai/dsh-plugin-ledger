/**
 * 历史归档：会话结束不再"人走账消"。
 *
 * 这是产品从"一个会话的快照"走向"时间维度"的地基：
 * 没有归档就答不了"昨天/本周花了多少"，也没有团队聚合的原料。
 *
 * 三条约束在这里被钉死：
 *   1. 只记体积与金额，不记任何对话内容；
 *   2. 未知成本原样保留原因（`cost: null` + `reason`），绝不写成 0；
 *   3. 落盘不进热路径（enqueue 只入队），且队列有界、异常吞掉计数。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveRecordOf, createArchive, shardNameOf } from '../lib/archive.js'
import { LedgerStore } from '../lib/store.js'

const DAY = 86_400_000

function entry(overrides = {}) {
  return {
    at: Date.UTC(2026, 10, 21, 12, 0, 0),
    sessionId: 'session-a',
    turn: 7,
    step: 6,
    kind: 'model',
    callId: 'c1',
    usage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 180_000, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 181_020, billableInput: 180_900, complete: true },
    cost: { kind: 'known', amount: 0.0042, currency: 'CNY', parts: { input: 0.0009, output: 0.00024, cacheRead: 0.0036, cacheWrite: 0 }, tier: 'exact' },
    attribution: { primary: { plugin: 'plugin-food', confidence: 'exact' }, sharedContext: [], system: null },
    route: { provider: 'deepseek-official', model: 'deepseek-flash' },
    contextChars: 490,
    ...overrides,
  }
}

test('分片文件名按本地日期', () => {
  assert.equal(shardNameOf(Date.UTC(2026, 10, 21, 12)), '2026-11-21.jsonl')
})

test('记录里没有任何对话内容字段（隐私红线）', () => {
  const record = archiveRecordOf(entry(), { sessionId: 's', title: '修复面板', project: 'gitee.com/a/b', device: 'dev1' })
  const keys = Object.keys(record).sort()
  for (const banned of ['text', 'content', 'summary', 'message', 'prompt', 'arguments']) {
    assert.equal(keys.includes(banned), false, `归档不应包含 ${banned}`)
  }
  assert.equal(record.title, '修复面板')
  assert.equal(record.project, 'gitee.com/a/b')
  assert.equal(record.tok.cr, 180_000)
  assert.equal(record.cost, 0.0042)
})

test('未知成本保留原因，绝不写成 0', () => {
  const record = archiveRecordOf(entry({ cost: { kind: 'unknown', reason: 'no-rate' } }))
  assert.equal(record.cost, null)
  assert.equal(record.reason, 'no-rate')
})

test('默认不带 actor（git email 不落盘）', () => {
  const record = archiveRecordOf(entry(), { sessionId: 's' })
  assert.equal('actor' in record, false)
})

test('enqueue + flush 按天分片写出，行数正确', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-archive-'))
  try {
    const archive = createArchive({ dir, flushMs: 60_000 })
    archive.enqueue(archiveRecordOf(entry({ at: Date.UTC(2026, 10, 20, 12) })))
    archive.enqueue(archiveRecordOf(entry({ at: Date.UTC(2026, 10, 21, 12) })))
    archive.enqueue(archiveRecordOf(entry({ at: Date.UTC(2026, 10, 21, 13) })))
    assert.equal(archive.pending, 3)
    assert.equal(archive.flush(), 3)

    const files = readdirSync(dir).sort()
    assert.deepEqual(files, ['2026-11-20.jsonl', '2026-11-21.jsonl'])
    const day21 = readFileSync(join(dir, '2026-11-21.jsonl'), 'utf8').trim().split('\n')
    assert.equal(day21.length, 2)
    assert.equal(JSON.parse(day21[0]).v, 1)
    archive.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('队列有界：超限丢最旧的并计数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-archive-cap-'))
  try {
    const archive = createArchive({ dir, maxQueued: 100, flushMs: 60_000 })
    for (let i = 0; i < 150; i += 1) archive.enqueue(archiveRecordOf(entry({ turn: i })))
    assert.equal(archive.pending, 100)
    assert.ok(archive.stats.dropped >= 50)
    archive.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('保留策略：只删过期的日期分片，不碰别的文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-archive-prune-'))
  try {
    const now = Date.UTC(2026, 10, 21, 12)
    writeFileSync(join(dir, '2026-08-01.jsonl'), '{}\n')
    writeFileSync(join(dir, '2026-11-20.jsonl'), '{}\n')
    writeFileSync(join(dir, 'README.md'), 'keep me\n')
    const archive = createArchive({ dir, retentionDays: 90, now: () => now })
    assert.equal(archive.prune(), 1)
    assert.equal(existsSync(join(dir, '2026-08-01.jsonl')), false)
    assert.equal(existsSync(join(dir, '2026-11-20.jsonl')), true)
    assert.equal(existsSync(join(dir, 'README.md')), true)
    archive.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dispose 会把队列刷出去（不丢最后一段）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-archive-dispose-'))
  try {
    const archive = createArchive({ dir, flushMs: 60_000 })
    archive.enqueue(archiveRecordOf(entry()))
    archive.dispose()
    const files = readdirSync(dir)
    assert.equal(files.length, 1)
    assert.equal(readFileSync(join(dir, files[0]), 'utf8').trim().split('\n').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store.entriesOf 返回全部条目且不 touch LRU', () => {
  const store = new LedgerStore({ capacity: 10, traceCapacity: 5, traceEnabled: false, maxSessions: 2 })
  store.recordEntry('a', entry({ turn: 1 }))
  store.recordEntry('a', entry({ turn: 2 }))
  store.recordEntry('b', entry({ turn: 3 }))
  // b 是最近的；读 a 不应该把它变成"最近"
  const entries = store.entriesOf('a')
  assert.equal(entries.length, 2)
  assert.equal(entries[1].turn, 2)
  assert.deepEqual(store.sessionIds().slice(-1), ['b'])
  assert.equal(store.entriesOf('nope'), null)
})

test('插件级：会话销毁时把剩余条目并进归档（不人走账消）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-archive-e2e-'))
  try {
    const { apply } = await import('../lib/index.js')
    const handlers = new Map()
    const ctx = {
      on(event, fn) {
        const list = handlers.get(event) ?? []
        list.push(fn)
        handlers.set(event, list)
      },
      emit(event, ...args) {
        for (const fn of handlers.get(event) ?? []) fn(...args)
      },
      provide() {},
      tools: { register: () => () => {} },
    }
    await apply(ctx, { archive: { dir, flushMs: 60_000 }, panel: { enabled: false }, trace: { enabled: false } })

    const session = { id: 'session-e2e', header: { cwd: dir } }
    ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 },
      },
    })
    ctx.emit('session/disposed', session)
    ctx.emit('dispose')

    const files = readdirSync(dir)
    assert.equal(files.length, 1, `应写出一个分片，实际 ${files.join(',')}`)
    const lines = readFileSync(join(dir, files[0]), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const record = JSON.parse(lines[0])
    assert.equal(record.sid, 'session-e2e')
    assert.equal(record.model, 'deepseek-flash')
    assert.equal(typeof record.cost, 'number')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
