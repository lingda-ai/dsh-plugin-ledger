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
