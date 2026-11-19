import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
const require = createRequire('/home/user/lingzhi/package.json')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { __internal } = await import('../lib/client.js')

const h = React.createElement
const sessionId = 'session-9f2a41'

const view = {
  version: 1,
  sessionId,
  generatedAt: '2026-11-19T13:52:00.000Z',
  totals: {
    cost: { amount: 0.015316, currency: 'CNY', knownEntries: 6, unknownEntries: 0,
      parts: { input: 0.00926, output: 0.002924, cacheRead: 0.003132, cacheWrite: 0 } },
    tokens: { input: 9260, output: 1462, cacheRead: 15660, cacheWrite: 0, reasoning: 312, missing: 0 },
    entries: 6,
  },
  topSources: [],
  sources: [
    { plugin: '@lingzhi/tools/hr', amount: 0.005552, entries: 1, share: 0.3624 },
    { plugin: 'shared:unknown', amount: 0.005412, entries: 2, share: 0.3532 },
    { plugin: '@lingzhi/tools/kb', amount: 0.001716, entries: 1, share: 0.1121 },

  ],
  sourceCount: 5,
  recent: [
    { at: 1763521920000, kind: 'model', amount: 0.001716, unknownReason: null, route: { provider: 'deepseek', model: 'chat-mini' }, tokens: { input: 3200, output: 620, cacheRead: 4100, cacheWrite: 0 }, plugin: '@lingzhi/tools/kb', system: null },
    { at: 1763521860000, kind: 'model', amount: 0.005552, unknownReason: null, route: { provider: 'deepseek', model: 'chat' }, tokens: { input: 6060, output: 842, cacheRead: 11560, cacheWrite: 0 }, plugin: '@lingzhi/tools/hr', system: null },
    { at: 1763521800000, kind: 'compaction', amount: null, unknownReason: 'no-rate', route: null, tokens: null, plugin: null, system: 'compaction' },
  ],
  overview: [
    { sessionId, amount: 0.015316, currency: 'CNY', entries: 6, lastAt: 1763521920000 },
    { sessionId: 'session-77c1de', amount: 0.0204, currency: 'CNY', entries: 9, lastAt: 1763520900000 },
    { sessionId: 'session-c40ab2', amount: 0.0019, currency: 'CNY', entries: 2, lastAt: 1763519100000 },
  ],
  budget: { limit: 0.03, currency: 'CNY', used: 0.015316, ratio: 0.5105 },
}

const head = h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px 8px', borderBottom: '1px solid #eef1f5' } },
  h('span', { style: { fontSize: 13, fontWeight: 600, color: '#1f2733' } }, '账本'),
  h('span', { style: { fontSize: 11, color: '#8a93a0' } }, '会话 sessio…a41'),
  h('button', { type: 'button', style: { marginLeft: 'auto', border: '1px solid #d8dee7', background: '#fff', borderRadius: 7, padding: '3px 9px', fontSize: 11.5, color: '#5a6472' } }, '刷新'),
)

const panel = renderToStaticMarkup(__internal.renderPayload(React, view, sessionId, head))

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>账本面板 · 代码真实渲染</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;padding:28px}
.row{display:flex;gap:24px;align-items:flex-start}
.wrap{border:1px solid #e3e8ef;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.04)}
.warn{width:${500}px}
.label{font:12px/1.6 -apple-system;color:#6b7684;margin:0 0 8px}
.hint{font:11.5px/1.8 -apple-system;color:#8a93a0;margin:10px 0 0;max-width:${500}px}
</style>
<body>
<div class="row">
  <div>
    <p class="label">① 右栏 380px（代码 renderPayload 的真实输出）</p>
    <div class="wrap" style="width:380px">${panel}</div>
  </div>
  <div>
    <p class="label">② 右栏 300px（极窄，分栏用）</p>
    <div class="wrap" style="width:300px">${panel}</div>
  </div>
</div>
<p class="hint">这两块不是设计稿，是 <code>lib/client.js</code> 的 <code>renderPayload()</code> 用测试同一份 payload 生成的真实 DOM。改动 UI 后重跑 <code>node scripts/render-panel.mjs</code> 即可刷新。</p>
</body></html>`

writeFileSync(new URL('../docs/panel-preview.html', import.meta.url), html)
console.log('docs/panel-preview.html 已刷新，', html.length, 'bytes')
