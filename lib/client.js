/**
 * @lingda/ledger —— 浏览器半（右侧栏 tab）
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
 * 未接的部分（有意留空，别伪造）：
 *   面板取数需要浏览器 ↔ 服务端的 Typert remote（数据在 Host 的 ctx.ledger 上，
 *   浏览器进程拿不到）。该通道属于 M2，接入点集中在 fetchView() 一处。
 *
 * 约定（dsh-client-modules）：客户端模块是 lazy factory，副作用只能发生在 apply() 内。
 */

/** 本实现的身份，也是两个 keyed seat 的 key。 */
const LEDGER_ID = '@lingda/ledger'
/** tab 类型判别串，`openTab('ledger.cost', …)` 用的就是它。 */
const LEDGER_KIND = 'ledger.cost'

/** 面板用到的 seat 名，抽出来避免字符串散落。 */
const SEAT_BODY = 'sidebar.right.pane.tab'
const SEAT_TITLE = 'sidebar.right.pane.tab.title'

const INK = '#1f2733'
const INK2 = '#5a6472'
const INK3 = '#8a93a0'

/** 会话 id 太长时截断成 chip 能放下的样子。 */
function shortId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return '—'
  return sessionId.length <= 10 ? sessionId : `${sessionId.slice(0, 6)}…${sessionId.slice(-3)}`
}

/**
 * 面板取数的唯一注入点。
 *
 * M2 接通 Typert remote 后，只改这里：返回 { totals, sources, generatedAt }，
 * 前端只做格式化，不聚合、不补零、不重算金额（口径必须留在 Host）。
 *
 * @param {unknown} ctx - 浏览器侧 cordis 上下文
 * @returns {(sessionId: string) => Promise<null | { totals: object, sources: object[] }>}
 */
export function createFetchView(ctx) {
  void ctx
  return async function fetchView() {
    return null // 未接通：面板显示"取数通道待接入"
  }
}

/**
 * 正文组件工厂。用 createElement 而不引 JSX，避免给独立仓库引入构建链。
 * @param {any} React - 宿主的 React
 * @param {(sid: string) => Promise<any>} fetchView
 */
function makeLedgerBody(React, fetchView) {
  const h = React.createElement

  return function LedgerBody(props) {
    const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : null
    const [view, setView] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState(null)

    const refresh = React.useCallback(async () => {
      if (sessionId === null) return
      setBusy(true)
      setError(null)
      try {
        setView(await fetchView(sessionId))
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    }, [sessionId])

    React.useEffect(() => {
      void refresh()
    }, [refresh])

    const head = h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '12px 14px 0' } },
      h('span', { style: { fontSize: 13, fontWeight: 600, color: INK } }, '账本'),
      h('span', { style: { fontSize: 11, color: INK3 } }, `会话 ${shortId(sessionId)}`),
    )

    if (error !== null) {
      return h(
        'div',
        null,
        head,
        h('p', { style: { margin: '10px 14px', fontSize: 12, color: '#a03a2a' } }, `读取失败：${error}`),
      )
    }

    if (view === null) {
      return h(
        'div',
        null,
        head,
        h(
          'p',
          { style: { margin: '10px 14px', fontSize: 12, lineHeight: 1.65, color: INK2 } },
          busy ? '正在读取…' : '面板已挂载。浏览器与服务端的取数通道（Typert remote）尚未接通，',
          busy ? '' : '当前会话的花费请先用对话里的 ledger_query 查询。',
        ),
        h(
          'div',
          { style: { padding: '0 14px 12px' } },
          h(
            'button',
            {
              type: 'button',
              onClick: () => void refresh(),
              disabled: busy || sessionId === null,
              style: {
                border: '1px solid #d8dee7',
                background: '#fff',
                borderRadius: 7,
                padding: '4px 10px',
                fontSize: 12,
                color: busy ? INK3 : INK2,
                cursor: busy ? 'default' : 'pointer',
              },
            },
            busy ? '刷新中' : '刷新',
          ),
        ),
      )
    }

    // 数据到位后的渲染：字段名与 lib/store.js 的 totals / sources 对齐
    const known = view.totals?.cost?.knownEntries ?? 0
    const unknown = view.totals?.cost?.unknownEntries ?? 0
    return h(
      'div',
      null,
      head,
      h(
        'div',
        { style: { padding: '10px 14px', fontSize: 12, lineHeight: 1.7, color: INK2 } },
        h('div', null, `已归因条目 ${known}，未归因 ${unknown}`),
        h('div', null, `生成于 ${view.generatedAt ?? '—'}`),
      ),
    )
  }
}

/** 标题组件：chip 上的实时文案（不做金额，避免每次事件都改布局）。 */
function makeLedgerTitle(React) {
  const h = React.createElement
  return function LedgerTitle() {
    return h('span', null, '账本')
  }
}

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
