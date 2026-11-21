/**
 * 对账 PoC：本地归档 vs 厂商账单。
 *
 * 这是验证"团队愿不愿为对账付钱"的最低成本工具（脚本级，无服务端）。
 * 测试重点不是格式化，而是**口径不能被改坏**：
 *   - 未计价条目不计入采集额（否则差异率会假性变小）；
 *   - 账单里坏行只计数不炸；
 *   - 差异率为负要有可读解释。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReport, locateBillColumns, normalizeDay, parseCsv, sumArchiveByDay, sumBillByDay } from '../scripts/reconcile.mjs'

test('CSV 解析：引号、逗号、换行都能活下来', () => {
  const rows = parseCsv('日期,说明,金额\n2026-11-18,"API, 批量",0.0087\n"2026-11-19","带""引号""",0.0053\n')
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[1], ['2026-11-18', 'API, 批量', '0.0087'])
  assert.equal(rows[2][1], '带"引号"')
})

test('账单列定位：中英文表头都能认，认不出退回第 1/2 列', () => {
  assert.deepEqual(locateBillColumns(['日期', '项目', '金额']), { date: 0, amount: 2 })
  assert.deepEqual(locateBillColumns(['Date', 'Usage', 'Cost']), { date: 0, amount: 2 })
  assert.deepEqual(locateBillColumns(['a', 'b']), { date: 0, amount: 1 })
})

test('日期归一：2026/11/20、2026-11-20、2026年11月20日 都是同一天', () => {
  assert.equal(normalizeDay('2026-11-20'), '2026-11-20')
  assert.equal(normalizeDay('2026/11/20'), '2026-11-20')
  assert.equal(normalizeDay('2026年11月20日'), '2026-11-20')
  assert.equal(normalizeDay('不是日期'), null)
})

test('账单按天汇总；坏行只计数不抛出', () => {
  const { byDay, skipped } = sumBillByDay(parseCsv('日期,金额\n2026-11-18,0.0087\n2026-11-18,0.0003\n坏行,x\n2026-11-19,¥0.0053\n'))
  assert.equal(byDay['2026-11-18'], 0.009)
  assert.equal(byDay['2026-11-19'], 0.0053)
  assert.equal(skipped, 1)
})

test('归档按天汇总：未计价单独计数，坏行跳过，区间可裁', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-archive-'))
  try {
    writeFileSync(join(dir, '2026-11-18.jsonl'), [
      '{"v":1,"model":"deepseek-flash","cost":0.0042}',
      '{"v":1,"model":"deepseek-flash","cost":0.0042}',
      '{"v":1,"model":"mystery","cost":null,"reason":"no-rate"}',
      'not json',
      '',
    ].join('\n'))
    writeFileSync(join(dir, '2026-11-19.jsonl'), '{"v":1,"model":"deepseek-flash","cost":0.0051}\n')
    const all = sumArchiveByDay(dir)
    assert.equal(all['2026-11-18'].amount.toFixed(4), '0.0084')
    assert.equal(all['2026-11-18'].entries, 3, '坏行不计入条目')
    assert.equal(all['2026-11-18'].unknown, 1)
    const ranged = sumArchiveByDay(dir, { from: '2026-11-19' })
    assert.deepEqual(Object.keys(ranged), ['2026-11-19'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('报告：合计行、未计价提示、差异率符号都对', () => {
  const report = buildReport({
    archiveByDay: {
      '2026-11-18': { amount: 0.0084, entries: 3, unknown: 1, models: new Map([['deepseek-flash', 2], ['mystery', 1]]) },
    },
    billByDay: { '2026-11-18': 0.009, '2026-11-19': 0.002 },
    billSkipped: 1,
    range: {},
  })
  assert.match(report, /# 账本 · 对账报告/)
  assert.match(report, /\*\*合计\*\*/)
  assert.match(report, /\| 2026-11-19 \| 0\.0000 \| 0\.0020 \| -0\.0020 \|/)
  assert.match(report, /未计价\*\* 1 条/)
  assert.match(report, /账单里 1 行无法解析/)
  assert.match(report, /deepseek-flash \| 2/)
})
