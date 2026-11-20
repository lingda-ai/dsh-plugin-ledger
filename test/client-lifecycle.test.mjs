/**
 * 客户端插件的生命周期契约：登记、清理、再登记。
 *
 * 为什么单独测这一组：右栏 tab 是**长期驻留**的 UI，插件在 HMR、禁用/启用、
 * 切 profile 时会被反复 apply / dispose。只要有一次"登记了但没释放"，
 * 用户就会看到重复的「账本」标签，而且点了没反应——这类问题在真机上极难复现，
 * 因为它取决于宿主何时重载插件图。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 用发布产物加载模块（测的是用户真正装到机器上的那一份）。 */
async function loadClient() {
  const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  const registrations = []
  vm.runInNewContext(
    source,
    { window: { __ModuleLoader__: { load: (r) => registrations.push(r) } } },
    { filename: 'client.js' },
  )
  const [registration] = registrations
  const exported = registration.factory((specifier) => {
    if (specifier === 'react') return { createElement: () => null }
    throw new Error(`unexpected require: ${specifier}`)
  })
  return exported
}

/** 记录所有登记/释放动作的假宿主。 */
function fakeHost({ slots = true } = {}) {
  const calls = []
  const services = {
    sidebarRightTabs: {
      register(definition) {
        calls.push(['tab.register', definition.kind])
        return () => calls.push(['tab.dispose', definition.kind])
      },
    },
    sidebarRight: {
      registerCloseHandler(kind) {
        calls.push(['close.register', kind])
        return () => calls.push(['close.dispose', kind])
      },
    },
  }
  if (slots) {
    services.slots = {
      // 真实语义：factory 在 inject 的作用域里运行，作用域销毁时连带释放里面登记的 seat
      // （宿主自己的 office 插件就是这么用的：inject(seat, () => register(...)) 且不保存返回值）
      inject(seat, factory) {
        calls.push(['slot.inject', seat])
        const innerDispose = factory()
        return () => {
          calls.push(['slot.dispose', seat])
          if (typeof innerDispose === 'function') innerDispose()
        }
      },
      register(definition) {
        calls.push(['slot.register', definition.name])
        return () => calls.push(['slot.unregister', definition.name])
      },
    }
  }
  const disposers = []
  // 真 cordis 的 ctx 既支持 ctx.<service>（声明的依赖），也支持 ctx.get(name)（未声明的可选服务），
  // 所以假宿主两者都给，否则测出来的是"假 ctx 缺属性"而不是插件问题
  const ctx = {
    ...services,
    get: (name) => services[name] ?? null,
    effect(setup) {
      disposers.push(setup())
    },
  }
  return { ctx, calls, disposeAll: () => disposers.map((fn) => fn()) }
}

test('apply 登记 tab，并通过 ctx.effect 交回清理函数', async () => {
  const client = await loadClient()
  const host = fakeHost()
  await client.apply(host.ctx)
  assert.deepEqual(host.calls.slice(0, 1), [['tab.register', 'ledger.cost']])
  assert.equal(host.calls.some(([name]) => name === 'slot.register'), true, '有 slots 时应挂正文与标题')
})

test('dispose 可逆：每类登记与释放次数相等（不多释放、也不漏释放）', async () => {
  const client = await loadClient()
  const host = fakeHost()
  await client.apply(host.ctx)
  host.disposeAll()

  const count = (name) => host.calls.filter(([actual]) => actual === name).length
  const pairs = [
    ['tab.register', 'tab.dispose'],
    ['close.register', 'close.dispose'],
    ['slot.inject', 'slot.dispose'],
    ['slot.register', 'slot.unregister'],
  ]
  for (const [registered, disposed] of pairs) {
    assert.equal(
      count(disposed),
      count(registered),
      `${registered} ${count(registered)} 次，但 ${disposed} ${count(disposed)} 次（实际：${JSON.stringify(host.calls)}）`,
    )
  }
  assert.ok(count('tab.register') > 0)
})

test('重复 apply（HMR / 重新启用）不抛错，且每次都能独立释放', async () => {
  const client = await loadClient()
  const host = fakeHost()
  await client.apply(host.ctx)
  await client.apply(host.ctx)
  assert.equal(host.calls.filter(([name]) => name === 'tab.register').length, 2)

  const disposers = []
  const host2 = fakeHost()
  host2.ctx.effect = (setup) => disposers.push(setup())
  await client.apply(host2.ctx)
  await client.apply(host2.ctx)
  for (const fn of disposers) fn()
  assert.equal(host2.calls.filter(([name]) => name === 'tab.dispose').length, 2)
})

test('宿主没有 slots 时：只登记 tab，不抛错（降级而不是崩）', async () => {
  const client = await loadClient()
  const host = fakeHost({ slots: false })
  await client.apply(host.ctx)
  const names = host.calls.map(([name]) => name)
  assert.equal(names.includes('tab.register'), true, 'tab 必须登记')
  assert.equal(names.some((n) => n.startsWith('slot.')), false, '没有 slots 就不该碰 seat')
})

test('登记阶段抛错时不把异常抛给宿主（UI 插件不能因此带走整个页面）', async () => {
  const client = await loadClient()
  const ctx = {
    get: () => null,
    effect: () => {},
    sidebarRightTabs: {
      register() {
        throw new Error('seat 冲突')
      },
    },
  }
  await client.apply(ctx)
})
