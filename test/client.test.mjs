/**
 * 浏览器半的契约：类型登记 + 正文/标题 seat 注册 + 清理可逆。
 * React 从 devDependency 取（宿主运行时同样是 require("react")），
 * 组件用 renderToStaticMarkup 渲染，断言首屏文案。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { apply, createFetchView } from '../lib/client.js'

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

test('正文首屏：标题、截断的会话 id、未接通提示、刷新按钮', async () => {
  const { ctx, components } = fakeCtx({ withSlots: true })
  await apply(ctx)
  const Body = components['sidebar.right.pane.tab']
  const html = renderToStaticMarkup(createElement(Body, { sessionId: 'session-9f2a41' }))
  assert.match(html, /账本/)
  assert.match(html, /会话 sessio…a41/)
  assert.match(html, /尚未接通/)
  assert.match(html, /刷新/)
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

test('取数注入点当前返回 null（M2 接通前）', async () => {
  assert.equal(await createFetchView({})('session-1'), null)
})
