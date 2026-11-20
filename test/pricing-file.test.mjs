import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePricingFile, loadPricingOverride, pricingMetaOf } from '../lib/pricing-file.js'
import { pricingNoteOf } from '../lib/panel-view.js'
import { createPricing } from '../lib/pricing.js'
import { BUILTIN_RATES } from '../lib/pricing-table.js'
import { createLedgerQueryTool } from '../lib/audit-tool.js'

const okDoc = JSON.stringify({
  asOf: '2026-12-01',
  source: 'https://example.com/pricing',
  currency: 'CNY',
  rates: {
    'deepseek-v4-flash': { input: 1.2, output: 2.4, cacheRead: 0.02, cacheWrite: 0 },
  },
})

test('PF-1 合法文件：元/百万换算成元/token', () => {
  const r = parsePricingFile(okDoc)
  assert.equal(r.kind, 'ok')
  assert.equal(r.rates['deepseek-v4-flash'].input, 1.2e-6)
  assert.equal(r.rates['deepseek-v4-flash'].output, 2.4e-6)
  assert.equal(r.asOf, '2026-12-01')
  assert.equal(r.source, 'https://example.com/pricing')
  assert.equal(r.rejected.length, 0)
})

test('PF-2 缺一档：整条拒绝，reason 指出缺哪几档（不半套合并）', () => {
  const r = parsePricingFile(
    JSON.stringify({ rates: { 'deepseek-v4-pro': { input: 3, output: 6, cacheRead: 0.025 } } }),
  )
  assert.equal(r.kind, 'invalid')
  assert.equal(r.reason, 'all-rejected')
  assert.equal(r.rejected.length, 1)
  assert.equal(r.rejected[0].reason, 'fields-missing')
  assert.deepEqual(r.rejected[0].missing, ['cacheWrite'])
})

test('PF-3 写了非数字：field-invalid，和"漏写"分开报', () => {
  const r = parsePricingFile(
    JSON.stringify({ rates: { m: { input: '3', output: 6, cacheRead: 0.02, cacheWrite: 0 } } }),
  )
  assert.equal(r.rejected[0].reason, 'field-invalid')
  assert.equal(r.rejected[0].field, 'input')
})

test('PF-4 负数：单列 reason，不静默接受', () => {
  const r = parsePricingFile(
    JSON.stringify({ rates: { m: { input: 1, output: 2, cacheRead: 0.02, cacheWrite: -1 } } }),
  )
  assert.equal(r.rejected[0].reason, 'negative')
  assert.equal(r.rejected[0].field, 'cacheWrite')
})

test('PF-5 坏 JSON / 缺 rates：给可读原因，不抛错', () => {
  assert.equal(parsePricingFile('{oops').reason, 'bad-json')
  assert.equal(parsePricingFile('[]').reason, 'not-an-object')
  assert.equal(parsePricingFile('{"asOf":"x"}').reason, 'no-rates')
})

test('PF-6 部分合法：合法的生效，坏的进 rejected（两者都保留）', () => {
  const r = parsePricingFile(
    JSON.stringify({
      rates: {
        good: { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 0 },
        bad: { input: 1, output: 2 },
      },
    }),
  )
  assert.equal(r.kind, 'ok')
  assert.deepEqual(Object.keys(r.rates), ['good'])
  assert.equal(r.rejected[0].model, 'bad')
})

test('PF-7 文件不存在 = absent（不是错误）；读失败 = invalid(read-failed)', () => {
  const absent = loadPricingOverride({
    path: '/nope/pricing.json',
    readFile: () => {
      const e = new Error('not found')
      e.code = 'ENOENT'
      throw e
    },
  })
  assert.equal(absent.kind, 'absent')

  const failed = loadPricingOverride({
    path: '/nope/pricing.json',
    readFile: () => {
      const e = new Error('denied')
      e.code = 'EACCES'
      throw e
    },
  })
  assert.equal(failed.kind, 'invalid')
  assert.equal(failed.reason, 'read-failed')
  assert.equal(failed.detail, 'EACCES')
})

test('PF-8 覆盖只替换同名模型，内置其余模型仍可用', () => {
  const r = parsePricingFile(okDoc)
  const pricing = createPricing({ rates: { ...BUILTIN_RATES, ...r.rates } })
  assert.equal(pricing.rateFor(null, 'deepseek-v4-pro').input, 3e-6) // 内置未被波及
  assert.equal(pricing.rateFor(null, 'deepseek-v4-flash').input, 1.2e-6) // 被文件覆盖
})

test('PF-9 meta：三种状态都要有（失败不能变成"看起来正常"）', () => {
  const builtin = { asOf: '2026-11-19', source: 'https://builtin' }
  assert.equal(pricingMetaOf({ kind: 'absent' }, builtin).error, null)
  assert.equal(pricingMetaOf({ kind: 'absent' }, builtin).kind, 'builtin')

  const okMeta = pricingMetaOf(parsePricingFile(okDoc), builtin)
  assert.equal(okMeta.kind, 'file')
  assert.equal(okMeta.asOf, '2026-12-01')
  assert.deepEqual(okMeta.models, ['deepseek-v4-flash'])

  const badMeta = pricingMetaOf(parsePricingFile('{oops'), builtin)
  assert.equal(badMeta.kind, 'builtin')
  assert.equal(badMeta.error, 'bad-json')
})

test('PF-10 面板脚注：自定义/内置/未生效三种文案互不混淆，未生效必须是警示色', () => {
  const file = pricingNoteOf({ kind: 'file', asOf: '2026-12-01', rejected: [] })
  assert.equal(file.text, '按自定义费率估算 · 2026-12-01')
  assert.equal(file.warn, false)

  // 有异常时：原因进 banner（顶部警示条），页脚只留"现在按什么价算"
  const partial = pricingNoteOf({ kind: 'file', asOf: '2026-12-01', rejected: [{}, {}] })
  assert.equal(partial.text, '费率：自定义 2026-12-01')
  assert.match(partial.banner, /2 个模型费率无效/)
  assert.equal(partial.warn, true)

  const broken = pricingNoteOf({ kind: 'builtin', asOf: '2026-11-19', error: 'bad-json' })
  assert.equal(broken.text, '费率：内置官方价 2026-11-19')
  assert.match(broken.banner, /不是合法 JSON/)
  assert.match(broken.banner, /仍按内置价计算/)
  assert.equal(broken.warn, true)

  const plain = pricingNoteOf({ kind: 'builtin', asOf: '2026-11-19', error: null })
  assert.equal(plain.text, '按内置官方价估算 · 2026-11-19')
  assert.equal(plain.warn, false)
})

test('PF-11 ledger_query op=rates：能查到自己改的价和被拒原因', async () => {
  const rate = { input: 1.2e-6, output: 2.4e-6, cacheRead: 0.02e-6, cacheWrite: 0 }
  const tool = createLedgerQueryTool({
    store: { snapshot: () => null },
    rates: { 'deepseek-v4-flash': rate },
    pricingMeta: {
      kind: 'file',
      asOf: '2026-12-01',
      source: null,
      models: ['deepseek-v4-flash'],
      rejected: [{ model: 'deepseek-v4-pro', reason: 'fields-missing', missing: ['cacheWrite'] }],
      error: null,
    },
  })
  const text = await tool.execute({ op: 'rates' })
  assert.match(text, /自定义文件 · 2026-12-01/)
  // 单位要还原成元/百万，否则用户对不上官方公告
  assert.match(text, /未命中 1\.2/)
  assert.match(text, /输出 2\.4/)
  assert.match(text, /deepseek-v4-pro：缺字段 cacheWrite/)
  assert.match(text, /整条不生效/)
})

test('PF-12 op=rates 没有费率时如实说没注入，不返回空表冒充"没有费率"', async () => {
  const tool = createLedgerQueryTool({ store: { snapshot: () => null } })
  assert.match(await tool.execute({ op: 'rates' }), /未注入/)
})
