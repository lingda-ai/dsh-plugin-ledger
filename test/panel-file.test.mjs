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
  safeFileName,
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
