/**
 * 面板状态总表：把 renderPayload 在各关键状态下渲染成一张对照图。
 *
 * 为什么要有它：
 *   面板的"状态空间"（正常 / 空态 / 费率未知 / 费率文件被拒 / 多来源展开 / 预算告急 / 300px 窄栏）
 *   比单条路径重要的多，但单测只能断言文本，看不到观感。这个脚本用**同一份真实数据口径**
 *   把所有状态并排画出来，改 UI 后跑一次就能肉眼对比，也能当视觉回归的基线图。
 *
 * 用法：
 *   node scripts/render-states.mjs            # → docs/panel-states.html
 *   （可选）再用无头浏览器截一张 docs/panel-states.png
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { __internal } from '../lib/client.src.js'

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'))
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const h = React.createElement

const NOW = Date.UTC(2026, 10, 20, 14, 32, 42)
const SESSION = 'session-4eae8a7c-58e5-4f63-8a35-2f4fa34affe8'

/** 一条明细（字段与 snapshot-file.js 的 compactEntry 完全一致）。 */
function entry({ turn, step, amount, at, chars = null, tokens = 180_000, plugin = null, unknownReason = null }) {
  return {
    at: at ?? NOW - (10 - turn) * 60_000,
    turn,
    step,
    contextChars: chars,
    contextBeforeTokens: null,
    contextSavedTokens: null,
    kind: 'model',
    amount,
    unknownReason,
    route: { provider: 'deepseek-official', model: 'deepseek-flash' },
    tokens: { input: 900, output: 120, cacheRead: tokens - 1020, cacheWrite: 0 },
    plugin,
    system: null,
  }
}

/** 与 buildPanelPayload 输出同构。 */
function payload(overrides = {}) {
  const base = {
    version: 1,
    generatedAt: '2026-11-20T14:32:42.000Z',
    sessionId: SESSION,
    sessionTitle: '修复账本面板崩溃',
    totals: {
      cost: {
        amount: 0.0479,
        currency: 'CNY',
        knownEntries: 9,
        unknownEntries: 0,
        parts: { input: 0.0033, output: 0.011, cacheRead: 0.0336, cacheWrite: 0 },
      },
      saved: { amount: 1.6467, currency: 'CNY', entries: 9 },
      tokens: { input: 3330, output: 5496, cacheRead: 1_680_256, cacheWrite: 0, reasoning: 0, missing: 0 },
      entries: 9,
      cacheHitRate: 0.998,
      savedShare: 0.9717,
    },
    topSources: [{ plugin: 'unattributed', amount: 0.0479, entries: 9, share: 1 }],
    sources: [{ plugin: 'unattributed', amount: 0.0479, entries: 9, share: 1 }],
    sourceCount: 1,
    peak: { amount: 0.0069, turn: 7, step: 6, kind: 'model', model: 'deepseek-flash' },
    overview: [
      { sessionId: SESSION, amount: 0.0479, currency: 'CNY', entries: 9, lastAt: NOW },
      { sessionId: 'session-77ac21b0-1f22-4f4a-9c31-0b7de4e2a9f0', amount: 0.2845, currency: 'CNY', entries: 41, lastAt: NOW - 3_600_000 },
    ],
    budget: null,
    pricing: { kind: 'file', asOf: '2026-11-20', source: 'manual', models: ['deepseek-flash'], rejected: [], error: null },
    truncated: false,
    recent: [
      entry({ turn: 7, step: 3, amount: 0.0042 }),
      entry({ turn: 7, step: 4, amount: 0.0046, chars: 490 }),
      entry({ turn: 7, step: 5, amount: 0.0047, chars: 234 }),
      entry({ turn: 7, step: 6, amount: 0.0069, chars: 1208 }),
      entry({ turn: 8, step: 1, amount: 0.0055 }),
    ],
  }
  return { ...base, ...overrides }
}

function head(sessionId = SESSION) {
  return h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px 8px', borderBottom: '1px solid #eef1f5' } },
    h('span', { style: { fontSize: 13, fontWeight: 600, color: '#1f2733' } }, '账本'),
    h('span', { style: { fontSize: 11, color: '#8a93a0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 } }, '修复账本面板崩溃'),
    h('button', { type: 'button', style: { marginLeft: 'auto', border: '1px solid #d8dee7', background: '#fff', borderRadius: 7, padding: '3px 9px', fontSize: 11.5, color: '#5a6472' } }, '复制摘要'),
    h('button', { type: 'button', style: { border: '1px solid #d8dee7', background: '#fff', borderRadius: 7, padding: '3px 9px', fontSize: 11.5, color: '#5a6472' } }, '刷新'),
  )
}

const multiSources = {
  ...payload(),
  sourceCount: 8,
  sources: [
    { plugin: 'plugin-food', amount: 0.021, entries: 4, share: 0.44 },
    { plugin: 'plugin-kb', amount: 0.0132, entries: 3, share: 0.28 },
    { plugin: 'unattributed', amount: 0.0081, entries: 2, share: 0.17 },
    { plugin: 'shared:unknown', amount: 0.0031, entries: 1, share: 0.06 },
    { plugin: 'system:compaction', amount: 0.0025, entries: 1, share: 0.05 },
    { plugin: 'plugin-web', amount: 0, entries: 0, share: 0 },
    { plugin: 'plugin-search', amount: 0, entries: 0, share: 0 },
    { plugin: 'plugin-chart', amount: 0, entries: 0, share: 0 },
  ],
}
multiSources.topSources = multiSources.sources.slice(0, 3)

const scenarios = [
  {
    label: '① 常规（380px）—多来源、费率自定义',
    width: 380,
    node: __internal.renderPayload(React, { ...multiSources, sources: multiSources.sources.slice(0, 3), sourceCount: 3 }, SESSION, head()),
  },
  {
    label: '② 空态（第一次打开）',
    width: 380,
    node: __internal.renderPayload(React, payload({ totals: { entries: 0 }, recent: [], sources: [], topSources: [], sourceCount: 0, peak: null, overview: [] }), SESSION, head()),
  },
  {
    label: '③ 费率未知（金额必须显式给原因）',
    width: 380,
    node: __internal.renderPayload(
      React,
      payload({
        totals: {
          cost: { amount: null, currency: 'CNY', knownEntries: 0, unknownEntries: 3, parts: null },
          saved: null,
          tokens: { input: 2100, output: 480, cacheRead: 0, cacheWrite: 0, reasoning: 0, missing: 0 },
          entries: 3,
          cacheHitRate: null,
        },
        sources: [{ plugin: 'unattributed', amount: 0, entries: 3, share: null }],
        topSources: [],
        recent: [
          entry({ turn: 2, step: 1, amount: null, unknownReason: 'no-rate' }),
          entry({ turn: 2, step: 2, amount: null, unknownReason: 'no-rate' }),
          entry({ turn: 2, step: 3, amount: null, unknownReason: 'usage-incomplete' }),
        ],
        peak: null,
      }),
      SESSION,
      head(),
    ),
  },
  {
    label: '④ 费率文件被拒（警示条 + 仍按内置价）',
    width: 380,
    node: __internal.renderPayload(
      React,
      payload({ pricing: { kind: 'builtin', asOf: '2026-11-19', source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing', models: [], rejected: [{ model: 'deepseek-flash', reason: 'fields-missing', missing: ['cacheWrite'] }], error: 'fields-missing' } }),
      SESSION,
      head(),
    ),
  },
  {
    label: '⑤ 多来源 · 展开全部 8',
    width: 380,
    node: __internal.renderPayload(React, multiSources, SESSION, head(), { expanded: true, onToggleSources: () => {} }),
  },
  {
    label: '⑥ 预算告急（已用 92%）',
    width: 380,
    node: __internal.renderPayload(
      React,
      payload({ budget: { limit: 0.052, currency: 'CNY', used: 0.0479, ratio: 0.921, callsLeft: 5 } }),
      SESSION,
      head(),
    ),
  },
  {
    label: '⑦ 极窄 300px（同数据）',
    width: 300,
    node: __internal.renderPayload(React, multiSources, SESSION, head()),
  },
]

const columns = scenarios
  .map(
    (s) => `<div class="col">
    <p class="label">${s.label}</p>
    <div class="wrap" style="width:${s.width}px">${renderToStaticMarkup(s.node)}</div>
  </div>`,
  )
  .join('\n')

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>账本面板 · 状态总表</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#eef1f5;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;padding:20px}
.grid{display:flex;gap:18px;align-items:flex-start}
.col{display:flex;flex-direction:column}
.wrap{border:1px solid #e3e8ef;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 2px 10px rgba(16,24,40,.06)}
.label{font:12px/1.5 -apple-system;color:#5a6472;margin:0 0 8px}
</style>
<body><div class="grid">${columns}</div></body></html>`

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'panel-states.html')
writeFileSync(out, html)
console.log(`docs/panel-states.html 已刷新（${scenarios.length} 个状态，${html.length} B）`)
