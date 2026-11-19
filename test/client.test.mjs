/**
 * 浏览器半的契约：类型登记 + 正文/标题 seat 注册 + 清理可逆。
 * React 从 devDependency 取（宿主运行时同样是 require("react")），
 * 组件用 renderToStaticMarkup 渲染，断言首屏文案。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { apply, createFetchView, __internal } from '../lib/client.js'

function fakeCtx({ withSlots = false } = {}) {
  const log = []
  const components = {}
  const ctx = {
    sidebarRightTabs: {
      register(def) {
        log.push(['register', def])
        return () => log.push(['disposeTab'])
      },
    },
    sidebarRight: {
      registerCloseHandler(kind, handler) {
        log.push(['closeHandler', kind, typeof handler])
        return () => log.push(['disposeClose'])
      },
    },
    effect(fn) {
      const cleanup = fn()
      log.push(['effect'])
      ctx.cleanup = cleanup
      return cleanup
    },
  }
  if (withSlots) {
    ctx.slots = {
      inject(seat, factory) {
        log.push(['inject', seat])
        return factory()
      },
      register(entry, Component) {
        log.push(['registerSlot', entry.name, entry.key])
        components[entry.name] = Component
        return () => log.push(['disposeSlot', entry.name])
      },
    }
  }
  return { ctx, log, components }
}

test('注册一个 ledger.cost tab，带引导页入口', async () => {
  const { ctx, log } = fakeCtx()
  await apply(ctx)
  const def = log.find((e) => e[0] === 'register')[1]
  assert.equal(def.id, '@lingda/ledger')
  assert.equal(def.kind, 'ledger.cost')
  assert.equal(def.priority, 'extension')
  assert.equal(def.keepMounted, true)
  assert.equal(def.title('sidebar://ledger.cost'), '账本')
  assert.equal(def.patterns, undefined)
  assert.deepEqual([def.guide[0].id, def.guide[0].order], ['ledger.cost', 10])
  assert.equal(def.guide[0].title(), '账本')
  assert.equal(def.guide[0].description(), '本会话的 token 用量与成本归因')
})

test('登记关闭处理器，kind 与 tab 一致', async () => {
  const { ctx, log } = fakeCtx()
  await apply(ctx)
  const close = log.find((e) => e[0] === 'closeHandler')
  assert.equal(close[1], 'ledger.cost')
  assert.equal(close[2], 'function')
})

test('有 slots 时，正文与标题各注册一次，key 是包名', async () => {
  const { ctx, log, components } = fakeCtx({ withSlots: true })
  await apply(ctx)
  const seats = log.filter((e) => e[0] === 'registerSlot').map((e) => [e[1], e[2]])
  assert.deepEqual(seats, [
    ['sidebar.right.pane.tab', '@lingda/ledger'],
    ['sidebar.right.pane.tab.title', '@lingda/ledger'],
  ])
  const injected = log.filter((e) => e[0] === 'inject').map((e) => e[1])
  assert.deepEqual(injected, ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])
  assert.equal(typeof components['sidebar.right.pane.tab'], 'function')
  assert.equal(typeof components['sidebar.right.pane.tab.title'], 'function')
})

test('正文首屏：标题、截断的会话 id、刷新按钮', async () => {
  const { ctx, components } = fakeCtx({ withSlots: true })
  await apply(ctx)
  const Body = components['sidebar.right.pane.tab']
  const html = renderToStaticMarkup(createElement(Body, { sessionId: 'session-9f2a41' }))
  assert.match(html, /账本/)
  assert.match(html, /会话 sessio…a41/)
  assert.match(html, /刷新/)
  // SSR 不跑 effect：首帧应是读取中，而不是假装有数据
  assert.match(html, /正在读取/)
})

test('无会话时正文仍可渲染，不抛错', async () => {
  const { ctx, components } = fakeCtx({ withSlots: true })
  await apply(ctx)
  const Body = components['sidebar.right.pane.tab']
  const html = renderToStaticMarkup(createElement(Body, {}))
  assert.match(html, /会话 —/)
})

test('标题 seat 渲染「账本」', async () => {
  const { ctx, components } = fakeCtx({ withSlots: true })
  await apply(ctx)
  const Title = components['sidebar.right.pane.tab.title']
  assert.equal(renderToStaticMarkup(createElement(Title, {})), '<span>账本</span>')
})

test('cleanup 可逆：slot → 关闭处理器 → tab', async () => {
  const { ctx, log } = fakeCtx({ withSlots: true })
  await apply(ctx)
  ctx.cleanup()
  const disposals = log.filter((e) => e[0].startsWith('dispose')).map((e) => e[0])
  assert.deepEqual(disposals, ['disposeSlot', 'disposeSlot', 'disposeClose', 'disposeTab'])
})

test('无 sidebar-right 时静默退出，不抛错', async () => {
  await assert.doesNotReject(() => apply({}))
  await assert.doesNotReject(() => apply({ sidebarRightTabs: {} }))
  await assert.doesNotReject(() => apply({ sidebarRightTabs: { register: 'not-a-fn' } }))
})

// ---------------------------------------------------------------------------
// 取数：相对路径 stat → absolutePath → read → JSON
// ---------------------------------------------------------------------------
function fakeRemote({ statResult, readResult, throwOn } = {}) {
  return {
    workspaceFiles: {
      async stat(sessionId, path) {
        if (throwOn === 'stat') throw new Error('stat boom')
        return statResult ?? { ok: false }
      },
      async read(sessionId, path, range) {
        if (throwOn === 'read') throw new Error('read boom')
        assert.ok(range && range.limit > 0)
        return readResult ?? { ok: false }
      },
    },
  }
}

const payload = {
  version: 1,
  sessionId: 'session-abc',
  generatedAt: '2026-11-19T10:00:00.000Z',
  totals: { cost: { amount: 0.015316, currency: 'CNY', knownEntries: 6, unknownEntries: 0 }, tokens: { input: 9260, output: 1462, cacheRead: 15660, cacheWrite: 0, reasoning: 0, missing: 0 }, entries: 6 },
  topSources: [],
  sources: [{ plugin: '@lingzhi/tools/hr', amount: 0.005552, entries: 1, share: 0.362 }],
  sourceCount: 5,
}

test('取数：stat 拿到 absolutePath，再 read 解析成 payload', async () => {
  const remote = fakeRemote({
    statResult: { ok: true, value: { absolutePath: '/ws/.dsh/ledger/session-abc.json', bytes: 2048 } },
    readResult: { ok: true, value: { text: JSON.stringify(payload, null, 2), eof: true } },
  })
  const view = await createFetchView({ remote })('session-abc')
  assert.equal(view.sessionId, 'session-abc')
  assert.equal(view.totals.cost.amount, 0.015316)
  assert.equal(view.sources.length, 1)
})

test('取数：文件不存在时返回 null（未落盘不是错误）', async () => {
  const view = await createFetchView({ remote: fakeRemote({ statResult: { ok: false } }) })('session-abc')
  assert.equal(view, null)
})

test('取数：无 workspaceFiles 通道时给明确原因', async () => {
  const view = await createFetchView({})('session-abc')
  assert.equal(view.error, '宿主未提供 workspaceFiles 通道')
})

test('取数：空 sessionId 不发起请求', async () => {
  const view = await createFetchView({ remote: fakeRemote({}) })('')
  assert.equal(view, null)
})

test('取数：非法 JSON / 未读完 / 过大 都返回可读原因', async () => {
  const broken = await createFetchView({
    remote: fakeRemote({
      statResult: { ok: true, value: { absolutePath: '/ws/a.json' } },
      readResult: { ok: true, value: { text: '{oops', eof: true } },
    }),
  })('s1')
  assert.match(broken.error, /不是合法 JSON/)

  const partial = await createFetchView({
    remote: fakeRemote({
      statResult: { ok: true, value: { absolutePath: '/ws/a.json' } },
      readResult: { ok: true, value: { text: '{}', eof: false } },
    }),
  })('s1')
  assert.match(partial.error, /过长/)

  const huge = await createFetchView({
    remote: fakeRemote({ statResult: { ok: true, value: { absolutePath: '/ws/a.json', bytes: 2 * 1024 * 1024 } } }),
  })('s1')
  assert.match(huge.error, /过大/)
})

test('取数：通道抛错被包成一句话，不向外抛', async () => {
  const view = await createFetchView({ remote: fakeRemote({ throwOn: 'stat' }) })('s1')
  assert.equal(view.error, 'stat boom')
})

test('格式化口径：金额、千分位、占比', () => {
  const { formatAmount, formatTokens, formatShare } = __internal
  assert.equal(formatAmount(0.015316, 'CNY'), '¥0.0153')
  assert.equal(formatAmount(null, 'CNY'), '—')
  assert.equal(formatAmount(0.5, 'USD'), '0.5000 USD')
  assert.equal(formatTokens(9260), '9,260')
  assert.equal(formatTokens(undefined), '—')
  assert.equal(formatShare(0.362), '36.2%')
  assert.equal(formatShare(undefined), '—')
})

test('来源桶显示名：保留 key 不原样露给用户', () => {
  const { sourceLabel } = __internal
  assert.equal(sourceLabel('shared:unknown'), '多个插件共同（拆不开）')
  assert.equal(sourceLabel('unattributed'), '未归因')
  assert.equal(sourceLabel('system:compaction'), '上下文压缩')
  assert.equal(sourceLabel('@lingzhi/tools/hr'), '@lingzhi/tools/hr')
})

test('时钟格式化：毫秒时间戳 → HH:MM，缺失给 —', () => {
  const { formatClock } = __internal
  assert.equal(formatClock(undefined), '—')
  assert.match(formatClock(Date.now()), /^\d{2}:\d{2}$/)
})

// ---------------------------------------------------------------------------
// 数据态渲染：把渲染当纯函数，才能断言金额/明细/预算真的画出来了
// ---------------------------------------------------------------------------
const fullView = {
  version: 1,
  sessionId: 'session-abc',
  generatedAt: '2026-11-19T10:00:00.000Z',
  totals: {
    cacheHitRate: 0.6284,
    cost: {
      amount: 0.015316,
      currency: 'CNY',
      knownEntries: 6,
      unknownEntries: 1,
      parts: { input: 0.00926, output: 0.002924, cacheRead: 0.003132, cacheWrite: 0 },
    },
    tokens: { input: 9260, output: 1462, cacheRead: 15660, cacheWrite: 0, reasoning: 100, missing: 0 },
    entries: 7,
  },
  topSources: [{ plugin: '@lingzhi/tools/hr', amount: 0.005552, entries: 1, share: 0.362 }],
  sources: [
    { plugin: '@lingzhi/tools/hr', amount: 0.005552, entries: 1, share: 0.362 },
    { plugin: 'shared:unknown', amount: 0.005412, entries: 2, share: 0.353 },
    { plugin: 'unattributed', amount: 0.001, entries: 1, share: 0.065 },
  ],
  sourceCount: 3,
  recent: [
    { at: 1700000000000, turn: 2, step: 2, kind: 'model', amount: 0.001716, contextChars: 18442, unknownReason: null, route: { provider: 'deepseek', model: 'chat-mini' }, tokens: { input: 100, output: 50, cacheRead: 200, cacheWrite: 0 }, plugin: '@lingzhi/tools/kb', system: null },
    { at: 1700000000000, turn: 2, step: 3, kind: 'compaction', amount: null, unknownReason: 'no-rate', route: null, tokens: null, plugin: null, system: 'compaction' },
  ],
  overview: [
    { sessionId: 'session-abc', amount: 0.015316, currency: 'CNY', entries: 7, lastAt: 1 },
    { sessionId: 'session-def', amount: 0.0042, currency: 'CNY', entries: 2, lastAt: 2 },
  ],
  budget: { limit: 0.03, currency: 'CNY', used: 0.015316, ratio: 0.5105, callsLeft: 5 },
  peak: { amount: 0.001716, turn: 2, step: 2, kind: 'model', model: 'chat-mini' },
}

const ReactStub = { createElement }
function htmlOf(view, options) {
  const Head = () => createElement('div', null, 'head')
  const element = __internal.renderPayload(ReactStub, view, 'session-abc', createElement(Head), options)
  return renderToStaticMarkup(element)
}

/** 造 8 个来源：折叠阈值是 6，用它验证"展开/收起" */
const manySources = Array.from({ length: 8 }, (_, i) => ({
  plugin: `@lingzhi/tools/p${i}`,
  amount: (8 - i) * 0.001,
  entries: 1,
  share: (8 - i) / 36,
}))

test('数据态：合计、四档金额、来源、明细、预算都画出来', () => {
  const html = htmlOf(fullView)
  assert.match(html, /¥0.0153/)            // 合计
  assert.match(html, /¥0.0093/)            // 未缓存输入
  assert.match(html, /¥0.0029/)            // 输出
  assert.match(html, /¥0.0031/)            // 缓存命中
  assert.match(html, /预算 ¥0.0300/)
  assert.match(html, /已用 51%/)
  assert.match(html, /多个插件共同（拆不开）/)
  assert.match(html, /未归因/)
  assert.match(html, /deepseek\/chat-mini/)
  assert.match(html, /其他会话/)
  assert.match(html, /sessio…def/)          // session-def 截断显示
  assert.match(html, /上下文压缩/)          // 压缩条目的系统标签
  assert.match(html, /内置官方价估算/)      // 金额按什么价算的，要写在面板上
  assert.match(html, /最贵一步 ¥0.0017/)   // 治理时要能一眼看到哪一问最贵
  assert.match(html, /T2·S2/)             // 明细带轮次，时间定位不了问题
  assert.match(html, /其中 1 条费率未知，合计偏低/)  // 有未知费率时合计只是下限
  assert.match(html, /占输入 63%/)         // 命中率：输入里有多少走了缓存
  assert.match(html, /还可约 5 次/)        // 比"已用 51%"更可行动
  assert.match(html, /↑18\.4k 字符/)       // 工具结果体量：解释"这一步为什么贵"
})

test('数据态：未知费率条目显示原因码而不是 0', () => {
  const html = htmlOf(fullView)
  assert.match(html, /— no-rate/)
  // 未知费率条目不该被渲染成 0
  assert.ok(!html.includes('¥0.0000  no-rate'))
})

test('数据态：没有预算、没有明细、没有其他会话时不画空块', () => {
  const view = { ...fullView, budget: null, recent: [], overview: [], sources: [], topSources: [], sourceCount: null }
  const html = htmlOf(view)
  assert.ok(!html.includes('预算 ¥'))
  assert.ok(!html.includes('最近'))
  assert.ok(!html.includes('其他会话'))
  assert.match(html, /还没有可归因的来源/)
})

test('数据态：token 缺失时明确说明，不显示 0', () => {
  const view = { ...fullView, totals: { ...fullView.totals, tokens: null } }
  const html = htmlOf(view)
  assert.match(html, /没有可用的 token 计数/)
  assert.ok(!html.includes('0 tok · 含 reasoning'))
})


test('来源超过 6 个：默认只显示 6 条并给出展开按钮', () => {
  const view = { ...fullView, sources: manySources, topSources: [], sourceCount: 8 }
  const html = htmlOf(view)
  assert.match(html, /展开全部 8/)
  assert.match(html, /@lingzhi\/tools\/p5/)
  assert.ok(!html.includes('@lingzhi/tools/p6'), '未展开时第 7 条不该出现')
})

test('展开后显示全部来源，按钮变「收起」', () => {
  const view = { ...fullView, sources: manySources, topSources: [], sourceCount: 8 }
  const html = htmlOf(view, { expanded: true })
  assert.match(html, /收起/)
  assert.match(html, /@lingzhi\/tools\/p7/)
})

test('来源不超过 6 个时不该出现展开按钮', () => {
  const html = htmlOf(fullView)
  assert.ok(!html.includes('展开全部'))
})


test('全部条目都有费率时不出现"合计偏低"警示', () => {
  const view = { ...fullView, totals: { ...fullView.totals, cost: { ...fullView.totals.cost, unknownEntries: 0 } } }
  const html = htmlOf(view)
  assert.ok(!html.includes('合计偏低'))
})

test('余量不足一问时说人话，不说"还可约 0 次"', () => {
  const view = { ...fullView, budget: { ...fullView.budget, callsLeft: 0 } }
  const html = htmlOf(view)
  assert.match(html, /余量不足一问/)
  assert.ok(!html.includes('还可约 0 次'))
})

test('没有 callsLeft（预算未启用或无已知条目）时不编造"还能问几次"', () => {
  const view = { ...fullView, budget: { ...fullView.budget, callsLeft: null } }
  const html = htmlOf(view)
  assert.ok(!html.includes('还可约'))
  assert.match(html, /已用 51%/)
})
