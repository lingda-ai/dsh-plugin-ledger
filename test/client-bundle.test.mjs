/**
 * 发布产物 lib/client.js 的形态契约。
 *
 * 这条测试守的是一个**真机崩溃**：0.1.4 把未打包的 ESM 源码当客户端入口发布，
 * 宿主把它原样拼进 classic script，浏览器在第一个 `import` 处抛
 * `SyntaxError: Cannot use import statement outside a module`，
 * client-modules 报 "import failed"，Desktop 宿主直接停住。
 *
 * 所以这里不测逻辑（逻辑在 client.test.mjs），只测三件事：
 *   1) 产物里没有任何 import / export 语句；
 *   2) 形态是 window.__ModuleLoader__.load({ id, factory })；
 *   3) id 等于包名，factory 返回的 exports 上有 apply。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function loadArtifact() {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  return { name: manifest.name, source }
}

/** 用最小的假 require 跑一遍 factory，拿到 exports。 */
function instantiate(source, { react = { createElement: () => null } } = {}) {
  const registrations = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.equal(registrations.length, 1, 'client.js 必须且只能注册一个模块')
  const [registration] = registrations
  const requested = []
  const require = (specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return react
    throw new Error(`产物请求了宿主模块表以外的模块：${specifier}`)
  }
  const exported = registration.factory(require)
  return { registration, exported, requested }
}

/** 最小的假 ctx：只提供 apply 会碰到的服务。 */
function fakeCtx({ registered = [], slots = [] } = {}) {
  return {
    sidebarRightTabs: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    sidebarRight: {},
    // 宿主形态：inject(seat, () => register({ name, key }, Component))
    slots: {
      inject(seat, factory) {
        factory()
        return () => {}
      },
      register(definition, Component) {
        slots.push({ seat: definition.name, key: definition.key, Component })
        return () => {}
      },
    },
    // cleanup 走 effect 分支；没有 effect 时退到 on('dispose')
    effect: () => {},
  }
}

test('产物里没有 import / export 语句（否则 classic script 直接语法错误）', async () => {
  const { source } = await loadArtifact()
  // 注释里提到 import 不算违规，看真正会被解析的代码
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(
    /^\s*(import|export)\s/m.test(code),
    false,
    'lib/client.js 出现了模块语法——重跑 node scripts/build-client.mjs',
  )
  // 动态 import 不是语法错误，但浏览器里解析不了 react 的裸说明符，产物里必须没有
  assert.equal(/\bimport\s*\(/.test(code), false, '产物里不应残留 import(\'react\')')
  assert.match(code, /let reactLoader = async \(\) => null/, 'React 应改由 __setReactLoader 注入')
})

test('形态是 __ModuleLoader__.load({ id, factory })，id 等于包名', async () => {
  const { name, source } = await loadArtifact()
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  const { registration } = instantiate(source)
  assert.equal(registration.id, name, 'id 必须等于包名，宿主按包名索引模块')
  assert.equal(typeof registration.factory, 'function')
})

test('factory 返回的 exports 上有 apply', async () => {
  const { source } = await loadArtifact()
  const { exported } = instantiate(source)
  assert.equal(typeof exported.apply, 'function')
})

test('apply 只向宿主模块表要 react（不再走裸 import）', async () => {
  const { source } = await loadArtifact()
  const { exported, requested } = instantiate(source)
  await exported.apply(fakeCtx({}))
  assert.deepEqual(requested, ['react'])
})

test('apply 在假 ctx 上登记右栏 tab（端到端形状）', async () => {
  const { source } = await loadArtifact()
  const { exported } = instantiate(source)
  const registered = []
  const ctx = fakeCtx({ registered })
  await exported.apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'ledger.cost')
  assert.equal(registered[0].title(), '账本')
})
