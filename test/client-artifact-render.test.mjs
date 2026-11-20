/**
 * 用**发布产物**渲染面板（不是源码）。
 *
 * 为什么必须测产物：`lib/client.js` 是构建生成的（去模块语法 + 拼接 + loader 包装），
 * 而此前所有渲染断言都跑在 `client.src.js` 上。构建一旦把组件拼坏——比如顺序错、
 * 变量重名、去 export 时切掉半个函数——源码测试全绿，用户装到的产物却崩。
 * 这和当初"ESM 直接发布"是同一类失效：**测的东西和用户拿到的东西不是同一个**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

/** 载入产物，返回导出的模块面 + 被登记的组件。 */
async function loadArtifact({ slots = true } = {}) {
  const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  const registrations = []
  vm.runInNewContext(
    source,
    { window: { __ModuleLoader__: { load: (r) => registrations.push(r) } }, console },
    { filename: 'client.js' },
  )
  const mod = registrations[0].factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require: ${specifier}`)
  })

  const components = {}
  const services = {
    sidebarRightTabs: { register: () => () => {} },
    slots: slots
      ? {
          inject(seat, factory) {
            factory()
            return () => {}
          },
          register(definition, Component) {
            components[definition.name] = Component
            return () => {}
          },
        }
      : null,
  }
  const ctx = { ...services, get: (name) => services[name] ?? null, effect: () => {} }
  await mod.apply(ctx)
  return { mod, components }
}

const payload = {
  version: 1,
  generatedAt: '2026-11-20T14:32:42.000Z',
  sessionId: 'session-artifact',
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
  recent: [],
  peak: null,
  overview: [],
  budget: null,
  pricing: { kind: 'file', asOf: '2026-11-20', source: 'manual', models: ['deepseek-flash'], rejected: [], error: null },
  truncated: false,
}

test('产物里的 renderPayload 能渲染出金额、四档与费率来源', async () => {
  const { mod } = await loadArtifact()
  const html = renderToStaticMarkup(mod.__internal.renderPayload(React, payload, payload.sessionId, null))
  assert.match(html, /¥0\.0479/)
  assert.match(html, /缓存已省/)
  assert.match(html, /几乎全命中/)
  assert.match(html, /按自定义费率估算/)
})

test('产物里的面板正文组件能挂载渲染（首帧是"正在读取"）', async () => {
  const { components } = await loadArtifact()
  const Body = components['sidebar.right.pane.tab']
  assert.equal(typeof Body, 'function', '产物应把正文组件登记到 sidebar.right.pane.tab')
  const html = renderToStaticMarkup(React.createElement(Body, { sessionId: 'session-artifact' }))
  assert.match(html, /正在读取/)
})

test('产物里的标题组件能渲染', async () => {
  const { components } = await loadArtifact()
  const Title = components['sidebar.right.pane.tab.title']
  assert.equal(typeof Title, 'function')
  renderToStaticMarkup(React.createElement(Title, { sessionId: 'session-artifact' }))
})

test('产物导出的纯函数面齐全（诊断与测试用）', async () => {
  const { mod } = await loadArtifact()
  for (const name of ['renderPayload', 'makeLedgerBody', 'makeLedgerTitle', 'formatAmount', 'formatTokens']) {
    assert.equal(typeof mod.__internal[name], 'function', `__internal.${name} 缺失`)
  }
})
