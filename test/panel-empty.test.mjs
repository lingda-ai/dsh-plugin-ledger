/**
 * 空态：装完第一次打开右栏的那一屏。
 * 核心断言：零条目要说"还没有数据"，绝不能说"¥0.0000"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderPayload } from '../lib/panel-view.js'

// 最小 React 替身：把树展开成纯文本，不引入 React 依赖
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
}

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
  // 注意：顶层元素的 props 常为 null（h('div', null, ...)），
  // 不能拿 props 是否存在当"是不是元素"的判据，否则整棵树会被跳过
  if (node && typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) texts(child, out)
  }
  return out
}

function flat(view, sessionId = 's1') {
  return texts(renderPayload(React, view, sessionId, null)).join(' ')
}

test('E-1 零条目：说"还没有数据"，不显示 ¥0.0000', () => {
  const out = flat({ totals: { entries: 0 }, recent: [], sources: [] })
  assert.match(out, /本会话还没有模型调用/)
  assert.equal(out.includes('¥0.0000'), false)
  // 三个要点必须都在：用户要知道这面板会记什么
  assert.match(out, /每步花多少/)
  assert.match(out, /谁花的/)
  assert.match(out, /还能问几次/)
})

test('E-2 有条目：走正常面板，不出现空态文案', () => {
  const out = flat({
    totals: {
      entries: 3,
      cost: { amount: 0.0153, currency: 'CNY', knownEntries: 3, unknownEntries: 0 },
      tokens: { input: 1000, output: 200, cacheRead: 400 },
    },
    recent: [{ at: '2026-11-20T01:00:00Z', turn: 1, step: 1, kind: 'model', amount: 0.0153 }],
 vanillaSources: [],
  })
  assert.equal(out.includes('本会话还没有模型调用'), false)
  assert.match(out, /0\.0153/)
})

test('E-3 有调用但费率未知（金额为 null）：不是空会话，不能走空态', () => {
  const out = flat({
    totals: { entries: 2, cost: { amount: null, currency: 'CNY', knownEntries: 0, unknownEntries: 2 } },
    recent: [{ at: '2026-11-20T01:00:00Z', turn: 1, step: 1, kind: 'model', unknownReason: 'no-rate' }],
  })
  assert.equal(out.includes('本会话还没有模型调用'), false)
  assert.match(out, /2 条费率未知/)
})

test('E-4 空态也带费率脚注；自定义费率时脚注必须换文案', () => {
  const builtin = flat({ totals: { entries: 0 }, pricing: { kind: 'builtin', asOf: '2026-11-19' } })
  assert.match(builtin, /按内置官方价估算 · 2026-11-19/)

  const custom = flat({
    totals: { entries: 0 },
    pricing: { kind: 'file', asOf: '2026-12-01', rejected: [{ model: 'm', reason: 'fields-missing' }] },
  })
  assert.match(custom, /费率：自定义 2026-12-01/)
  // 费率没完全生效这件事必须出现在正文里（顶部警示条），不能只藏在页脚
  assert.match(custom, /1 个模型费率无效，已按内置价处理/)
})

test('E-5 明细的 tokens 不完整：不崩，也不把缺失当 0 算出一个假总数', () => {
  // 这条曾经会让整个面板崩掉（item.tokens.input 直接相加）
  const out = flat({
    totals: { entries: 1, cost: { amount: 0.01, currency: 'CNY', knownEntries: 1, unknownEntries: 0 } },
    recent: [{ at: '2026-11-20T01:00:00Z', turn: 1, step: 1, kind: 'model', amount: 0.01, tokens: { input: 100 } }],
  })
  assert.equal(out.includes('NaN'), false)
  assert.match(out, /0\.0100/)
})

test('E-6 已经有钱在面板上时，费率失效同样要警示（这时候错得更隐蔽）', () => {
  const out = flat({
    totals: { entries: 5, cost: { amount: 0.2, currency: 'CNY', knownEntries: 5, unknownEntries: 0 } },
    recent: [{ at: '2026-11-20T01:00:00Z', turn: 1, step: 1, kind: 'model', amount: 0.2 }],
    pricing: { kind: 'builtin', asOf: '2026-11-19', error: 'bad-json' },
  })
  assert.match(out, /pricing\.json 不是合法 JSON/)
  assert.match(out, /仍按内置价计算/)
})
