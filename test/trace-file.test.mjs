/**
 * 流水落盘：热路径只入队、按会话分文件、超限封口、异常吞掉。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTraceSink, TRACE_SUFFIX } from '../lib/trace-file.js'
import { LedgerStore } from '../lib/store.js'

const tmpDir = () => mkdtempSync(join(tmpdir(), 'ledger-trace-'))

test('append 不做 IO：flush 之前文件不存在', () => {
  const dir = tmpDir()
  const sink = createTraceSink({ dir, intervalMs: 0 })
  sink.append('s1', { eventType: 'chat', at: 1 })
  assert.equal(existsSync(join(dir, `s1${TRACE_SUFFIX}`)), false)
  sink.flush()
  assert.equal(existsSync(join(dir, `s1${TRACE_SUFFIX}`)), true)
  sink.dispose()
})

test('JSONL：一行一条，能逐行解析', () => {
  const dir = tmpDir()
  const sink = createTraceSink({ dir, intervalMs: 0 })
  sink.append('s1', { eventType: 'chat', at: 1 })
  sink.append('s1', { eventType: 'execute_tool', at: 2 })
  sink.flush()
  const lines = readFileSync(join(dir, `s1${TRACE_SUFFIX}`), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.deepEqual(JSON.parse(lines[0]), { eventType: 'chat', at: 1 })
  sink.dispose()
})

test('按会话分文件，会话之间不混写', () => {
  const dir = tmpDir()
  const sink = createTraceSink({ dir, intervalMs: 0 })
  sink.append('a', { n: 1 })
  sink.append('b', { n: 2 })
  sink.flush()
  assert.deepEqual(readdirSync(dir).sort(), [`a${TRACE_SUFFIX}`, `b${TRACE_SUFFIX}`])
  assert.equal(JSON.parse(readFileSync(join(dir, `b${TRACE_SUFFIX}`), 'utf8').trim()).n, 2)
  sink.dispose()
})

test('队列满时丢最旧并计数，不无限占内存', () => {
  const dir = tmpDir()
  const sink = createTraceSink({ dir, intervalMs: 0, maxQueued: 2 })
  sink.append('s1', { n: 1 })
  sink.append('s1', { n: 2 })
  sink.append('s1', { n: 3 })
  assert.equal(sink.stats.dropped, 1)
  sink.flush()
  const lines = readFileSync(join(dir, `s1${TRACE_SUFFIX}`), 'utf8').trim().split('\n').map((l) => JSON.parse(l).n)
  assert.deepEqual(lines, [2, 3])
  sink.dispose()
})

test('超过 maxBytes 后封口：写截断行，之后不再追加', () => {
  const dir = tmpDir()
  const sink = createTraceSink({ dir, intervalMs: 0, maxBytes: 64 * 1024 })
  const big = { pad: 'x'.repeat(40000) }
  sink.append('s1', big)
  sink.append('s1', big)
  sink.append('s1', big)
  sink.flush()
  const text = readFileSync(join(dir, `s1${TRACE_SUFFIX}`), 'utf8')
  assert.match(text, /"truncated":true/)
  assert.equal(sink.stats.sealed, 1)
  // 封口后 append 直接丢
  sink.append('s1', { n: 9 })
  assert.ok(sink.stats.dropped >= 1)
  sink.dispose()
})

test('相对目录 + rootOf：写进各自会话的工作区根', () => {
  const base = tmpDir()
  const sink = createTraceSink({ dir: '.dsh/ledger', intervalMs: 0, rootOf: (sid) => join(base, sid) })
  sink.append('s1', { n: 1 })
  sink.flush()
  assert.equal(existsSync(join(base, 's1', '.dsh', 'ledger', `s1${TRACE_SUFFIX}`)), true)
  sink.dispose()
})

test('写盘失败被吞掉并计数，不向调用方抛', () => {
  const dir = join(tmpDir(), 'file-not-dir')
  writeFileSync(dir, 'x') // 目录位置被文件占了
  const sink = createTraceSink({ dir, intervalMs: 0 })
  sink.append('s1', { n: 1 })
  assert.doesNotThrow(() => sink.flush())
  assert.equal(sink.stats.errors, 1)
  sink.dispose()
})

test('store 的 onTrace 钩子在 recordTrace 时被调用（同步、无 IO）', () => {
  const seen = []
  const store = new LedgerStore({
    capacity: 4,
    traceCapacity: 4,
    traceEnabled: true,
    maxSessions: 1,
    onTrace: (sessionId, record) => seen.push([sessionId, record.eventType]),
  })
  store.recordTrace('s1', { eventType: 'chat' })
  assert.deepEqual(seen, [['s1', 'chat']])
})
