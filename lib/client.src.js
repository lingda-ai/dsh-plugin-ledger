/**
 * @lingda-ai/ledger —— 浏览器半（右侧栏 tab）**源码**
 *
 * 注意：本文件不是发布产物。发布入口是 `lib/client.js`，由
 * `node scripts/build-client.mjs` 从本文件 + panel-view.js + panel-path.js +
 * tool-size.js 打包成宿主要求的 loader 形态（`window.__ModuleLoader__.load`）。
 * 手工改 `lib/client.js` 会在下次构建时被覆盖。
 *
 * 为什么必须有这一步（真机崩溃换来的）：
 *   dsh-client-modules 的 Node 半侧把每个包的 `client.js` **原样拼接**成一个
 *   combo 脚本（`/plugins/??a/client.js,b/client.js&rev=…`），浏览器按 classic
 *   script 解析。所以客户端入口里不能出现任何 `import` / `export` 语句，
 *   否则整页抛 `SyntaxError: Cannot use import statement outside a module`，
 *   连宿主一起带崩。0.1.4 就是直接发布了 ESM 源码，一重启就崩。
 *
 * 已核实的契约（源码逐条对过，勿凭记忆改）：
 *
 * 1) 类型登记 @ dsh-client-ui-sidebar-right
 *    ctx.sidebarRightTabs.register(definition) → disposer
 *    definition: { id, kind, title(address), priority?, patterns?, canOpen?, guide?, multiple?, keepMounted? }
 *    guide entry: { id, order, title(), description?(), icon?, commandId? }
 *
 * 2) 正文/标题 seat @ 同一包（keyed，session scope，key = type.id）
 *    - 'sidebar.right.pane.tab'
 *    - 'sidebar.right.pane.tab.title'
 *    宿主自带的注册形态（sidebar-right 自己的 guide 就是这么写的）：
 *      ctx.slots.inject('<seat>', () => ctx.slots.register({ name: '<seat>', key: ID }, Component))
 *
 * 3) React 来自宿主模块表（`require("react")`）。本文件在 Node 侧（单测、脚本）
 *    走动态 import('react')；打进 client.js 后由构建产物通过 __setReactLoader
 *    注入 factory 拿到的 require。两条路都失败时退回"只登记类型、不挂正文"。
 *
 * 取数通道（已接，细节见 docs/spikes.md C-3）：
 *   数据在 Host 的 ctx.ledger 上，浏览器进程拿不到；Host 把只读快照写成
 *   工作区里的 JSON，这里用 `ctx.remote.workspaceFiles` 的 stat/read 读回。
 *   接入点集中在 createFetchView() 一处。
 *
 * 约定（dsh-client-modules）：客户端模块是 lazy factory，副作用只能发生在 apply() 内。
 */

/** 本实现的身份，也是两个 keyed seat 的 key。 */
const LEDGER_ID = '@lingda-ai/ledger'
/** tab 类型判别串，`openTab('ledger.cost', …)` 用的就是它。 */
const LEDGER_KIND = 'ledger.cost'

/** 读回快照时的分页参数：一次最多 400 行（宿主 maxLines 的常见上限），最多翻 20 页。 */
const PAGE_LINES = 400
const MAX_PAGES = 20
/** 文本总量的硬上限：超过就不是快照了（Host 侧 maxBytes 是 256KB） */
const MAX_CHARS = 1_500_000
// 注意：自动刷新间隔 REFRESH_MS 定义在 panel-view.js（组件住在那里）。
// 打包时四个模块共用同一个作用域，重名会直接 SyntaxError —— 这是产物测试抓出来的。

/**
 * 硬依赖：没有右栏 tab 服务，这个插件什么都不用做。
 *
 * 这条**必须声明**。cordis 的 ctx 是代理：访问未声明的服务属性会直接抛
 * `cannot get property "sidebarRightTabs" without inject`，而且是在 apply 里抛，
 * 等同于让宿主启动失败（0.1.5 重启即崩就是这么来的——之前只写了 package.json 的
 * dsh.client.inject，那是"先加载哪个包"，不是"这个插件依赖哪个服务"，两回事）。
 */
export const inject = ['sidebarRightTabs']

/**
 * 取可选服务。不能写成 `ctx.xxx`——没在 inject 里声明的服务，属性访问会抛。
 * 宿主提供了 `ctx.get(name)` 这条不受 inject 约束的通道；Node 侧单测的假 ctx
 * 没有 get，退回普通属性读。
 * @param {any} ctx
 * @param {string} name
 */
function optionalService(ctx, name) {
  if (typeof ctx?.get === 'function') {
    try {
      return ctx.get(name) ?? null
    } catch {
      return null
    }
  }
  try {
    return ctx?.[name] ?? null
  } catch {
    return null
  }
}

/** 面板用到的 seat 名，抽出来避免字符串散落。 */
const SEAT_BODY = 'sidebar.right.pane.tab'
const SEAT_TITLE = 'sidebar.right.pane.tab.title'

/**
 * React 取用方式：默认走动态 import（Node 侧单测/脚本）。
 * 构建成 client.js 后，产物在 factory 里用宿主模块表的 `require('react')` 覆盖它——
 * 浏览器里没有裸 `import('react')` 能解析的相对路径，动态 import 必然失败。
 * @type {() => Promise<any>}
 */
// #region react-loader-default
let reactLoader = async () => {
  const mod = await import('react')
  return mod.default ?? mod ?? null
}
// #endregion react-loader-default

/** 只给构建产物用：把 React 换成宿主模块表给的 require。 */
export function __setReactLoader(fn) {
  if (typeof fn === 'function') reactLoader = fn
}

import { panelRelativePath } from './panel-path.js'
import {
  makeLedgerBody,
  makeLedgerTitle,
  renderPayload,
  formatAmount,
  formatTokens,
  formatShare,
  formatClock,
  shortId,
  sourceLabel,
} from './panel-view.js'


/** 会话 id 太长时截断成 chip 能放下的样子。 */

/**
 * 面板取数的唯一注入点：读 Host 落在工作区里的只读快照。
 *
 * 通道已核实（@deepseek-ai/dsh-api-workspace-files 的生成 remote 声明）：
 *   list(scopeId, path, signal?)                       → RemoteResult<WorkspaceDirectoryListing>
 *   stat(scopeId, path, signal?)                       → RemoteResult<WorkspaceFileStat>（带 absolutePath）
 *   read(scopeId, absolutePath, range, signal?)        → RemoteResult<WorkspaceFileText>
 * 相对路径以 Session 的 cwd 为基准，所以客户端**不需要知道**工作区绝对路径：
 * 先用相对路径 stat 换出 absolutePath，再 read。
 *
 * 返回形状：
 *   null                      → 还没有快照（Host 未开启或尚未落盘）
 *   { error: '...' }          → 通道/解析失败，面板显示原因
 *   payload                   → Host 写的 JSON（version / totals / topSources / sources）
 *
 * @param {any} ctx - 浏览器侧 cordis 上下文
 * @returns {(sessionId: string, opts?: { signal?: AbortSignal }) => Promise<any>}
 */
export function createFetchView(ctx) {
  return async function fetchView(sessionId, opts = {}) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null
    const files = optionalService(ctx, 'remote')?.workspaceFiles
    if (!files || typeof files.stat !== 'function' || typeof files.read !== 'function') {
      return { error: '宿主未提供 workspaceFiles 通道' }
    }
    const relative = panelRelativePath(sessionId)

    let stat
    try {
      stat = await files.stat(sessionId, relative, opts.signal)
    } catch (error) {
      return { error: stringifyError(error) }
    }
    if (!stat?.ok) return null // 文件不存在＝尚未落盘，不是错误
    const absolutePath = stat.value?.absolutePath
    if (typeof absolutePath !== 'string') return null
    // 快照可能被写坏/过大：超过上限直接拒绝，避免把整份文件拖进内存
    const bytes = stat.value?.bytes
    if (typeof bytes === 'number' && bytes > 1024 * 1024) return { error: '快照文件过大，已跳过' }

    // 宿主的 workspaceFiles.read 是**按行分页**的（offset=首页行号，limit=最大行数，
    // 且 limit 不得超过宿主配置的 maxLines）。一份 20 条明细的快照实测 461~587 行，
    // 而这里原来只读一页 400 行并要求 eof —— 结果是任何稍成熟点的会话打开面板都显示
    // "读取失败：快照过长"。必须翻页读完，而不是把页宽当文件长度。
    let text = ''
    let offset = 1
    let eof = false
    for (let page = 0; page < MAX_PAGES && !eof; page += 1) {
      let result
      try {
        result = await files.read(sessionId, absolutePath, { offset, limit: PAGE_LINES }, opts.signal)
      } catch (error) {
        return { error: stringifyError(error) }
      }
      if (!result?.ok) return { error: '读取快照失败' }
      const chunk = result.value?.text
      if (typeof chunk !== 'string') return { error: '快照内容为空' }
      // 分页边界可能落在换行上也可能不落：拼之前补一个换行，避免两页粘成一行坏 JSON
      if (text.length > 0 && !text.endsWith('\n')) text += '\n'
      text += chunk
      if (text.length > MAX_CHARS) return { error: '快照文件过大，已跳过' }
      eof = result.value?.eof !== false
      const lines = typeof result.value?.lines === 'number' ? result.value.lines : 0
      if (lines <= 0) break
      offset += lines
    }
    if (!eof) return { error: '快照过长，分页读取未完成' }

    try {
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' ? parsed : { error: '快照格式无法识别' }
    } catch {
      return { error: '快照不是合法 JSON（可能正写到一半）' }
    }
  }
}

/** 把任意抛出物变成一句话。 */
function stringifyError(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '未知错误'
}

/** CNY 用 ¥，其它币种保留原符号 + 代码。 */

/**
 * 正文组件。用 createElement 而不引 JSX，避免给独立仓库引入构建链。
 * @param {any} React - 宿主的 React
 * @param {(sid: string, opts?: object) => Promise<any>} fetchView
 */

/**
 * 渲染已取到的快照。
 *
 * 从组件里抽出来是为了可测：SSR 不跑 effect，组件首帧永远是"读取中"，
 * 只有把渲染当纯函数，才能在测试里断言四档金额、明细、预算条真的画出来了。
 * @param {any} React
 * @param {any} view - 快照 payload
 * @param {string|null} sessionId
 * @param {any} head - 已在组件侧建好的头部（含刷新按钮）
 */

/** 一行 label / value，两个渲染入口共用。 */

/** 标题组件：chip 上的实时文案（不做金额，避免每次事件都改布局）。 */

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export async function apply(ctx) {
  const tabs = ctx.sidebarRightTabs
  if (!tabs || typeof tabs.register !== 'function') return

  const definition = {
    id: LEDGER_ID,
    kind: LEDGER_KIND,
    title: () => '账本',
    priority: 'extension',
    guide: [
      {
        id: 'ledger.cost',
        order: 10,
        title: () => '账本',
        description: () => '本会话的 token 用量与成本归因',
      },
    ],
    // 切会话不重建面板体：成本是常驻读数，重建会丢滚动位置
    keepMounted: true,
  }

  // 客户端契约里除 sidebarRightTabs 之外的部分都没被真机证实过。
  // 这是一个 UI 插件：任何一处契约偏差都应该退化成"没有面板"，而不是让宿主起不来。
  let disposeTab = null
  try {
    disposeTab = tabs.register(definition)
  } catch (error) {
    console.warn('[ledger] 右栏 tab 登记失败，面板不出现（宿主其它功能不受影响）:', error)
    return
  }

  const sidebarRight = optionalService(ctx, 'sidebarRight')
  let disposeClose = null
  if (typeof sidebarRight?.registerCloseHandler === 'function') {
    try {
      disposeClose = sidebarRight.registerCloseHandler(LEDGER_KIND, () => {})
    } catch (error) {
      console.warn('[ledger] registerCloseHandler 失败:', error)
    }
  }

  // 正文与标题：宿主把 seat 声明在 sidebar-right 里，先 inject 再 register
  let disposeBody = null
  let disposeTitle = null
  const slots = optionalService(ctx, 'slots')
  if (typeof slots?.inject === 'function' && typeof slots.register === 'function') {
    let React = null
    try {
      React = await reactLoader()
    } catch {
      React = null // 宿主没给 React：保持无正文的降级态
    }
    if (React !== null) {
      try {
        const fetchView = createFetchView(ctx)
        disposeBody = slots.inject(SEAT_BODY, () =>
          slots.register({ name: SEAT_BODY, key: LEDGER_ID }, makeLedgerBody(React, fetchView)),
        )
        disposeTitle = slots.inject(SEAT_TITLE, () =>
          slots.register({ name: SEAT_TITLE, key: LEDGER_ID }, makeLedgerTitle(React)),
        )
      } catch (error) {
        // seat 名对不上、权限不足、host 版本差异：只丢面板正文，tab 仍在
        console.warn('[ledger] 面板正文挂载失败（只剩 tab 标题）:', error)
      }
    }
  }

  const cleanup = () => {
    for (const dispose of [disposeTitle, disposeBody, disposeClose, disposeTab]) {
      try {
        dispose?.()
      } catch {
        // 卸载阶段的异常同样不能冒泡
      }
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
  else ctx.on('dispose', cleanup)
}

/**
 * 测试可见的内部件。实现都在 panel-view.js（纯展示），
 * 这里重导出，是为了让断言只认 `client.js` 一个入口。
 */
export const __internal = {
  makeLedgerBody,
  makeLedgerTitle,
  renderPayload,
  formatAmount,
  formatTokens,
  formatShare,
  formatClock,
  shortId,
  sourceLabel,
}
