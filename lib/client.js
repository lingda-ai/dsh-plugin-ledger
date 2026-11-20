/**
 * @lingdaai/ledger —— 浏览器半（右侧栏 tab）
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
 * 3) React 由宿主模块表提供（sidebar-right 编译产物里是 require("react")），
 *    故这里用动态 import 取，取不到就退回"只登记类型、不挂正文"的降级态。
 *
 * 取数通道（已接，细节见 docs/spikes.md C-3）：
 *   数据在 Host 的 ctx.ledger 上，浏览器进程拿不到；Host 把只读快照写成
 *   工作区里的 JSON，这里用 `ctx.remote.workspaceFiles` 的 stat/read 读回。
 *   接入点集中在 createFetchView() 一处。
 *
 * 约定（dsh-client-modules）：客户端模块是 lazy factory，副作用只能发生在 apply() 内。
 */

/** 本实现的身份，也是两个 keyed seat 的 key。 */
const LEDGER_ID = '@lingdaai/ledger'
/** tab 类型判别串，`openTab('ledger.cost', …)` 用的就是它。 */
const LEDGER_KIND = 'ledger.cost'

/** 面板用到的 seat 名，抽出来避免字符串散落。 */
const SEAT_BODY = 'sidebar.right.pane.tab'
const SEAT_TITLE = 'sidebar.right.pane.tab.title'

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
    const files = ctx?.remote?.workspaceFiles
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

    let page
    try {
      page = await files.read(sessionId, absolutePath, { offset: 0, limit: 400 }, opts.signal)
    } catch (error) {
      return { error: stringifyError(error) }
    }
    if (!page?.ok) return { error: '读取快照失败' }
    const text = page.value?.text
    if (typeof text !== 'string') return { error: '快照内容为空' }
    if (page.value?.eof === false) return { error: '快照过长，未能一次读完' }

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

  const disposeTab = tabs.register(definition)
  const disposeClose =
    typeof ctx.sidebarRight?.registerCloseHandler === 'function'
      ? ctx.sidebarRight.registerCloseHandler(LEDGER_KIND, () => {})
      : null

  // 正文与标题：宿主把 seat 声明在 sidebar-right 里，先 inject 再 register
  let disposeBody = null
  let disposeTitle = null
  const slots = ctx.slots
  if (typeof slots?.inject === 'function' && typeof slots.register === 'function') {
    let React = null
    try {
      React = (await import('react')).default ?? null
    } catch {
      React = null // 宿主没给 React：保持无正文的降级态
    }
    if (React !== null) {
      const fetchView = createFetchView(ctx)
      disposeBody = slots.inject(SEAT_BODY, () =>
        slots.register({ name: SEAT_BODY, key: LEDGER_ID }, makeLedgerBody(React, fetchView)),
      )
      disposeTitle = slots.inject(SEAT_TITLE, () =>
        slots.register({ name: SEAT_TITLE, key: LEDGER_ID }, makeLedgerTitle(React)),
      )
    }
  }

  const cleanup = () => {
    disposeTitle?.()
    disposeBody?.()
    disposeClose?.()
    disposeTab()
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
