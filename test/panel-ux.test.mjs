/**
 * 面板文案与信息取舍的回归测试。
 *
 * 这一组守的不是"能不能算"，而是"读起来是不是那个意思"。
 * 每一条都对应一次真实误读：
 *   - 「9 条」在金额旁边被读成 9 元；
 *   - 「占输入 100%」占了版面却零信息量；
 *   - 全部未归因时仍画一整块来源区，等于什么都没说；
 *   - 金额算不出来时给 ¥0.0000，把"不知道"说成了"确认没花钱"；
 *   - 明细里 184,121 tok 没有主语，被当成累计上下文。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderPayload } from '../lib/panel-view.js'

const React = { createElement: (type, props, ...children) => ({ type, props, children }) }

function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) texts(item, out)
    return out
  }
  if (node && typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) texts(child, out)
  }
  return out
}

const flat = (view) => texts(renderPayload(React, view, 'session-ux', null)).join(' ')

function view(overrides = {}) {
  const base = {
    generatedAt: '2026-11-20T14:32:42.000Z',
    totals: {
      cost: { amount: 0.0479, currency: 'CNY', knownEntries: 9, unknownEntries: 0, parts: { input: 0.0033, output: 0.011, cacheRead: 0.0336, cacheWrite: 0 } },
      saved: { amount: 1.6467, currency: 'CNY', entries: 9 },
      tokens: { input: 3330, output: 5496, cacheRead: 1_680_256, cacheWrite: 0, reasoning: 0, missing: 0 },
      entries: 9,
      cacheHitRate: 0.998,
      savedShare: 0.9717,
    },
    sources: [{ plugin: 'unattributed', amount: 0.0479, entries: 9, share: 1 }],
    sourceCount: 1,
    recent: [
      { at: 1_795_185_076_862, turn: 7, step: 6, kind: 'model', amount: 0.0069, unknownReason: null, contextChars: 1208, contextBeforeTokens: null, contextSavedTokens: null, route: { provider: 'deepseek-official', model: 'deepseek-flash' }, tokens: { input: 900, output: 120, cacheRead: 178_980, cacheWrite: 0 }, plugin: null, system: null },
    ],
    peak: { amount: 0.0069, turn: 7, step: 6, kind: 'model', model: 'deepseek-flash' },
    overview: [],
    budget: null,
    pricing: { kind: 'file', asOf: '2026-11-20', source: 'manual', models: ['deepseek-flash'], rejected: [], error: null },
  }
  return { ...base, ...overrides }
}

test('副标题用「次调用」，不会在金额旁边被读成元', () => {
  const out = flat(view())
  assert.match(out, /9 次调用/)
  assert.equal(/9 条/.test(out), false, '「9 条」紧挨金额会被读成 9 元')
})

test('全部未归因时，副标题说「归因无信号」而不是甩锅给配置', () => {
  // unattributed 桶同时收 no-signal（本会话没调工具）与 no-origin（工具没登记 owner），
  // 写「来源未配置」会把纯聊天会话指去改一个不存在的配置
  const out = flat(view())
  assert.match(out, /归因无信号/)
  assert.equal(out.includes('来源未配置'), false)
})

test('部分未归因时给次数，不吞掉这条信息', () => {
  const out = flat(
    view({
      sources: [
        { plugin: 'plugin-food', amount: 0.03, entries: 6, share: 0.63 },
        { plugin: 'unattributed', amount: 0.0179, entries: 3, share: 0.37 },
      ],
      sourceCount: 2,
    }),
  )
  assert.match(out, /3 次未归因/)
})

test('全部命中时不给「占输入 100%」，改成有信息量的说法', () => {
  const out = flat(view())
  assert.match(out, /几乎全命中/)
  assert.equal(out.includes('占输入 100%'), false)
})

test('命中率为 0 时不画命中率后缀（那只是"这次没缓存"）', () => {
  const out = flat(
    view({
      totals: {
        ...view().totals,
        cacheHitRate: 0,
        tokens: { input: 5200, output: 480, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: 0 },
      },
    }),
  )
  assert.equal(out.includes('占输入 0%'), false)
})

test('金额整体算不出来时：合计给 —、提示「本次未计价」、来源不给 ¥0.0000', () => {
  const out = flat(
    view({
      totals: {
        cost: { amount: null, currency: 'CNY', knownEntries: 0, unknownEntries: 3, parts: null },
        saved: null,
        tokens: { input: 2100, output: 480, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: 0 },
        entries: 3,
        cacheHitRate: null,
      },
      sources: [{ plugin: 'unattributed', amount: 0, entries: 3, share: null }],
      recent: [],
      peak: null,
    }),
  )
  assert.match(out, /3 条费率未知，本次未计价/)
  assert.equal(out.includes('合计偏低'), false, '没有任何已知金额时不存在"下限"')
  assert.equal(out.includes('¥0.0000'), false, '算不出来不是"确认没花钱"')
})

test('零金额、零条目的来源行不占版面', () => {
  const out = flat(
    view({
      sources: [
        { plugin: 'plugin-food', amount: 0.0479, entries: 9, share: 1 },
        { plugin: 'plugin-web', amount: 0, entries: 0, share: 0 },
        { plugin: 'plugin-search', amount: 0, entries: 0, share: 0 },
      ],
      sourceCount: 3,
    }),
  )
  assert.equal(out.includes('plugin-web'), false)
  // 过滤掉零金额来源后必须说明，否则"8 个来源只画 5 行"看起来像渲染坏了
  assert.match(out, /共 1 个有金额来源/)
})

test('明细里的 token 数要有主语（本次），不是累计上下文', () => {
  assert.match(flat(view()), /本次 180k tok/)
})

test('工具结果体量用「工具结果」而不是无解释的箭头', () => {
  const out = flat(view())
  assert.match(out, /工具结果 1,208 字符/)
  assert.equal(out.includes('↑1,208'), false)
})

test('页脚用「快照 HH:MM:SS」而不是「快照生成于」', () => {
  assert.match(flat(view()), /快照 2026-11-20 /)
})

test('预算缺席时给一行配置提示，而不是整段静默消失', () => {
  const out = flat(view())
  assert.match(out, /未设预算/)
  assert.match(out, /budget\.limit/)
})

test('最贵一步带轮次与占比（只说"最贵"会让人去优化一个 11% 的峰值）', () => {
  const out = flat(view())
  assert.match(out, /最贵 T7·S6 ¥0\.0069 · 占 14\.4%/)
})

test('命中一档占大头时，给一句"钱花在哪"的结论', () => {
  const v = view()
  v.totals.cost.parts = { input: 0.002, output: 0.008, cacheRead: 0.0379, cacheWrite: 0 }
  const out = flat(v)
  assert.match(out, /钱主要花在重复送出的上下文/)
  assert.match(out, /命中一档 ¥0\.0379/)
})

test('命中一档不占大头时不硬凑结论', () => {
  const v = view()
  v.totals.cost.parts = { input: 0.03, output: 0.016, cacheRead: 0.0019, cacheWrite: 0 }
  assert.equal(flat(v).includes('钱主要花在重复送出的上下文'), false)
})
