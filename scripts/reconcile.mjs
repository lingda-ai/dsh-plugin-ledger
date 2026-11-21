/**
 * 对账 PoC：把本地归档和厂商账单比出差异。
 *
 * 这是"企业版对账"的最小可交付物——**不需要服务端、不需要对方装任何东西**：
 *   1. 客户导出一份账单 CSV；
 *   2. 我们读本地归档（`~/.dsh/ledger/archive/YYYY-MM-DD.jsonl`）；
 *   3. 按天并排，给出差异与差异率，并明确标注"哪些天存在未计价条目"。
 *
 * 为什么先做脚本而不是做界面：这一步的目的是**验证客户愿不愿意为一份对账报告付钱**，
 * 工程成本越低越好。脚本能跑通、报告有人愿意看，再谈做进产品。
 *
 * 用法：
 *   node scripts/reconcile.mjs --bill bill.csv
 *   node scripts/reconcile.mjs --bill bill.csv --from 2026-11-01 --to 2026-11-30 --out report.md
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 归档默认目录，与 lib/archive.js 保持一致 */
const DEFAULT_ARCHIVE = join(homedir(), '.dsh', 'ledger', 'archive')

/** 极简 CSV 解析：支持双引号包裹与转义引号，够读账单导出 */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

/** 表头 → 列下标：账单导出格式千差万别，按关键词猜，猜不到就用第 1/2 列 */
export function locateBillColumns(header) {
  const norm = (s) => String(s ?? '').trim().toLowerCase()
  const dateIdx = header.findIndex((h) => /date|日期|时间|day/.test(norm(h)))
  const amountIdx = header.findIndex((h) => /amount|金额|费用|cost|charge|总价|合计/.test(norm(h)))
  return {
    date: dateIdx >= 0 ? dateIdx : 0,
    amount: amountIdx >= 0 ? amountIdx : 1,
  }
}

/** 账单行 → { 'YYYY-MM-DD': 金额 }；无法解析的行计入 skipped */
export function sumBillByDay(rows) {
  if (rows.length === 0) return { byDay: {}, skipped: 0 }
  const { date, amount } = locateBillColumns(rows[0])
  const byDay = {}
  let skipped = 0
  for (const row of rows.slice(1)) {
    const rawDate = String(row[date] ?? '').trim()
    const rawAmount = String(row[amount] ?? '').replace(/[¥,\s元]/g, '')
    const value = Number(rawAmount)
    const day = normalizeDay(rawDate)
    if (day === null || !Number.isFinite(value)) {
      skipped += 1
      continue
    }
    byDay[day] = (byDay[day] ?? 0) + value
  }
  return { byDay, skipped }
}

/** 各种日期写法 → YYYY-MM-DD（本地时区口径，账单一般也是本地） */
export function normalizeDay(text) {
  const s = String(text ?? '').trim()
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s)
  if (m !== null) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`
  m = /^(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(s)
  if (m !== null) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`
  const t = Date.parse(s)
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 读归档分片，按天汇总金额/条数/未计价条数。
 * @param {string} dir
 * @param {{ from?: string, to?: string }} [range]
 */
export function sumArchiveByDay(dir, range = {}) {
  const byDay = {}
  let names = []
  try {
    names = readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()
  } catch {
    return byDay
  }
  for (const name of names) {
    const day = name.slice(0, 10)
    if (range.from !== undefined && day < range.from) continue
    if (range.to !== undefined && day > range.to) continue
    const bucket = byDay[day] ?? { amount: 0, entries: 0, unknown: 0, models: new Map() }
    const lines = readFileSync(join(dir, name), 'utf8').split('\n')
    for (const line of lines) {
      if (line.trim() === '') continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue // 坏行跳过：手改过的文件不能炸掉整份报告
      }
      bucket.entries += 1
      if (typeof record.cost === 'number') bucket.amount += record.cost
      else bucket.unknown += 1
      const model = record.model ?? '—'
      bucket.models.set(model, (bucket.models.get(model) ?? 0) + 1)
    }
    byDay[day] = bucket
  }
  return byDay
}

/** 生成 markdown 报告 */
export function buildReport({ archiveByDay, billByDay, billSkipped = 0, range = {} }) {
  const days = [...new Set([...Object.keys(archiveByDay), ...Object.keys(billByDay)])].sort()
  const fmt = (n) => (Number.isFinite(n) ? n.toFixed(4) : '—')
  const pct = (diff, base) => (base > 0 ? `${((diff / base) * 100).toFixed(1)}%` : '—')

  const lines = []
  lines.push('# 账本 · 对账报告')
  lines.push('')
  lines.push(`区间：${range.from ?? days[0] ?? '—'} → ${range.to ?? days[days.length - 1] ?? '—'}`)
  lines.push('')
  lines.push('| 日期 | 本地采集 | 厂商账单 | 差异 | 差异率 | 条数 | 未计价 |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|')
  let localTotal = 0
  let billTotal = 0
  let unknownTotal = 0
  for (const day of days) {
    const local = archiveByDay[day]?.amount ?? 0
    const bill = billByDay[day] ?? 0
    const diff = local - bill
    localTotal += local
    billTotal += bill
    unknownTotal += archiveByDay[day]?.unknown ?? 0
    lines.push(
      `| ${day} | ${fmt(local)} | ${fmt(bill)} | ${fmt(diff)} | ${pct(diff, bill)} | ${archiveByDay[day]?.entries ?? 0} | ${archiveByDay[day]?.unknown ?? 0} |`,
    )
  }
  lines.push(`| **合计** | **${fmt(localTotal)}** | **${fmt(billTotal)}** | **${fmt(localTotal - billTotal)}** | **${pct(localTotal - billTotal, billTotal)}** |  | **${unknownTotal}** |`)
  lines.push('')

  const models = new Map()
  for (const bucket of Object.values(archiveByDay)) {
    for (const [model, count] of bucket.models) models.set(model, (models.get(model) ?? 0) + count)
  }
  if (models.size > 0) {
    lines.push('## 模型分布（按调用次数）')
    lines.push('')
    lines.push('| 模型 | 次数 |')
    lines.push('|---|---:|')
    for (const [model, count] of [...models.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${model} | ${count} |`)
    }
    lines.push('')
  }

  lines.push('## 怎么读这份报告')
  lines.push('')
  lines.push('- **差异率**为负表示本地采集低于账单：常见原因是本地价表滞后于厂商调价，或该模型不在价表里。')
  lines.push(`- **未计价** ${unknownTotal} 条：这些条目算不出钱，**不会**被当成 0 计入采集额，所以采集额天然偏低。`)
  if (billSkipped > 0) lines.push(`- 账单里 ${billSkipped} 行无法解析（日期或金额格式），已跳过。`)
  lines.push('- 口径：本地采集 = 四档（未命中/命中/写/输出）分别乘单价后相加；账单 = 厂商导出的应结金额。')
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------- CLI
if (process.argv[1] !== undefined && process.argv[1].endsWith('reconcile.mjs')) {
  const args = process.argv.slice(2)
  const flag = (name) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  const archiveDir = flag('archive') ?? DEFAULT_ARCHIVE
  const billPath = flag('bill')
  const from = flag('from')
  const to = flag('to')
  const out = flag('out')

  if (billPath === undefined) {
    console.error('用法: node scripts/reconcile.mjs --bill <账单.csv> [--archive <dir>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--out report.md]')
    process.exit(2)
  }
  if (!existsSync(billPath)) {
    console.error(`账单文件不存在：${billPath}`)
    process.exit(2)
  }
  const { byDay: billByDay, skipped } = sumBillByDay(parseCsv(readFileSync(billPath, 'utf8')))
  const archiveByDay = sumArchiveByDay(archiveDir, { from, to })
  const report = buildReport({ archiveByDay, billByDay, billSkipped: skipped, range: { from, to } })
  if (out !== undefined) {
    writeFileSync(out, report, 'utf8')
    console.log(`已写出 ${out}`)
  }
  console.log(report)
}
