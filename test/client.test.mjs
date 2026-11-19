/**
 * 浏览器半的注册契约：一条 kind、一个引导页入口、清理可逆。
 * 用假 ctx 断言，不需要真宿主（本机也没有 slots 包）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/client.js'

function fakeCtx() {
  const log = []
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
  return { ctx, log }
}

test('注册一个 ledger.cost tab，带引导页入口', () => {
  const { ctx, log } = fakeCtx()
  apply(ctx)
  const def = log.find((e) => e[0] === 'register')[1]
  assert.equal(def.id, '@lingda/ledger')
  assert.equal(def.kind, 'ledger.cost')
  assert.equal(def.priority, 'extension')
  assert.equal(def.keepMounted, true)
  assert.equal(def.title('sidebar://ledger.cost'), '账本')
  // 页面型不认领资源地址
  assert.equal(def.patterns, undefined)
  assert.equal(def.guide.length, 1)
  assert.deepEqual(
    [def.guide[0].id, def.guide[0].order],
    ['ledger.cost', 10],
  )
  assert.equal(def.guide[0].title(), '账本')
  assert.equal(def.guide[0].description(), '本会话的 token 用量与成本归因')
})

test('登记关闭处理器，kind 与 tab 一致', () => {
  const { ctx, log } = fakeCtx()
  apply(ctx)
  const close = log.find((e) => e[0] === 'closeHandler')
  assert.equal(close[1], 'ledger.cost')
  assert.equal(close[2], 'function')
})

test('cleanup 可逆：先释放关闭处理器，再注销 tab', () => {
  const { ctx, log } = fakeCtx()
  apply(ctx)
  assert.equal(typeof ctx.cleanup, 'function')
  ctx.cleanup()
  const disposals = log.filter((e) => e[0].startsWith('dispose')).map((e) => e[0])
  assert.deepEqual(disposals, ['disposeClose', 'disposeTab'])
})

test('无 sidebar-right 时静默退出，不抛错', () => {
  assert.doesNotThrow(() => apply({}))
  assert.doesNotThrow(() => apply({ sidebarRightTabs: {} }))
  assert.doesNotThrow(() => apply({ sidebarRightTabs: { register: 'not-a-fn' } }))
})

test('两次 apply 各自独立注册，互不干扰', () => {
  const a = fakeCtx()
  const b = fakeCtx()
  apply(a.ctx)
  apply(b.ctx)
  assert.equal(a.log.filter((e) => e[0] === 'register').length, 1)
  assert.equal(b.log.filter((e) => e[0] === 'register').length, 1)
})
