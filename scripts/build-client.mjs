// 把浏览器半打包成宿主真正能吃下的形态。
//
// 为什么需要它（真机崩溃换来的）：
//   dsh-client-modules 的 Node 半侧把每个包的 `client.js` **原样拼接**成一个
//   combo 脚本（`/plugins/??a/client.js,b/client.js&rev=…`），浏览器按 classic
//   script 解析。因此客户端入口里不能出现任何 `import` / `export` 语句——
//   0.1.4 直接发布了 ESM 源码，结果整页抛
//   `SyntaxError: Cannot use import statement outside a module`，
//   import 失败被宿主判为致命错误，Desktop 宿主直接停住。
//
// 产物契约（对齐宿主自带插件与社区插件，如 dsh-ppt / dsh-api-gateway）：
//   window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => { …; return module.exports } })
//   - id 必须等于安装后的包名（宿主模块表按包名索引）；
//   - factory 返回的 exports 上要有 apply(ctx)，可选 inject；
//   - 依赖只能来自 factory 的 require（React 就是 require("react")）。
//
// 用法：
//   node scripts/build-client.mjs            # 主包 @lingda-ai/ledger
//   node scripts/build-client.mjs --pkg packages/dsh-plugin-ledger
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 拼接顺序 = 依赖顺序；同名字符在打包后会撞车，改名要同步这里。 */
const SOURCES = ['panel-path.js', 'tool-size.js', 'panel-view.js', 'client.src.js']

/**
 * 去掉模块语法，只留函数/常量声明。
 *
 * 覆盖本仓实际用到的四种写法（多行 import、副作用 import、export 列表、export 声明）。
 * 不做通用 JS 解析：这个仓库的客户端半边只有纯函数和常量，够用且零依赖。
 * @param {string} text
 * @param {string} file
 * @returns {string}
 */
export function stripModuleSyntax(text, file = '<inline>') {
  let out = text
    // import { a, b } from './x.js'（可能跨行）
    .replace(/^import\s[\s\S]*?from\s+['"][^'"\n]+['"];?[ \t]*$/gm, '')
    // import './x.js'
    .replace(/^import\s+['"][^'"\n]+['"];?[ \t]*$/gm, '')
    // export { a, b }（可能跨行）
    .replace(/^export\s*\{[\s\S]*?\}\s*;?[ \t]*$/gm, '')
    // export const / export function / export class / export default
    .replace(/^export\s+(default\s+)?/gm, '')

  const leftover = out.match(/^\s*(import|export)\s/gm)
  if (leftover !== null) {
    throw new Error(`${file}: 去模块语法后仍有残留 ${JSON.stringify(leftover.slice(0, 3))}`)
  }
  return out.trim()
}

/**
 * 生成 client.js 全文。
 * @param {{id: string, parts: {file: string, code: string}[]}} input
 */
export function composeBundle({ id, parts }) {
  const body = parts
    .map((part) => `    //#region ${part.file}\n${part.code.replace(/^/gm, '    ')}\n    //#endregion`)
    .join('\n\n')

  return `/**
 * 生成文件，勿手改。源在 lib/*.src.js 与 lib/panel-*.js，改完跑：
 *   node scripts/build-client.mjs${id === '@lingda-ai/ledger' ? '' : ' --pkg <该包目录>'}
 *
 * 形态由宿主决定：dsh-client-modules 会把本文件原样拼进 classic script，
 * 所以这里不能出现任何 import / export 语句。
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

${body}

    // React 只能来自宿主模块表：浏览器里没有裸 import('react') 能解析的路径
    __setReactLoader(() => require("react"));

    exports.apply = apply;
    return module.exports;
  },
});
`
}

/**
 * 把 Node 侧的 React 兜底加载器换掉。
 *
 * 源码里 `await import('react')` 是给单测/脚本用的；打进 classic script 后
 * 裸说明符解析不了，是永远不会成功的死代码。产物统一改用宿主模块表，
 * 所以这里换成 null 兜底——真正的 loader 由 wrapper 里的 __setReactLoader 注入。
 */
const REACT_LOADER_REGION = /\/\/ #region react-loader-default[\s\S]*?\/\/ #endregion react-loader-default/

export function inlineReactLoaderStub(code, file = '<inline>') {
  if (!REACT_LOADER_REGION.test(code)) {
    throw new Error(`${file}: 找不到 react-loader-default 区域，构建规则与源码脱节了`)
  }
  const stub = [
    '// 产物里没有裸 import 可解析；由 wrapper 的 __setReactLoader 覆盖',
    'let reactLoader = async () => null',
  ].join('\n')
  return code.replace(REACT_LOADER_REGION, stub)
}

/** @param {string} pkgDir */
export async function buildClient(pkgDir = root) {
  const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'))
  const id = manifest.name
  if (typeof id !== 'string' || id === '') throw new Error(`${pkgDir}: package.json 缺 name`)

  const parts = []
  for (const file of SOURCES) {
    const text = await readFile(join(pkgDir, 'lib', file), 'utf8')
    let code = stripModuleSyntax(text, file)
    if (file === 'client.src.js') code = inlineReactLoaderStub(code, file)
    parts.push({ file, code })
  }

  const bundle = composeBundle({ id, parts })
  const out = join(pkgDir, 'lib', 'client.js')
  await writeFile(out, bundle)
  return { id, out, bytes: Buffer.byteLength(bundle), parts: parts.map((p) => p.file) }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const flag = process.argv.indexOf('--pkg')
  const pkgDir = flag > 0 ? resolve(process.argv[flag + 1]) : root
  const result = await buildClient(pkgDir)
  console.log(`已生成 ${result.out}（id=${result.id}，${result.bytes} B，源 ${result.parts.join(' + ')}）`)
}
