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
 * 取数通道（已接，细节见 docs/spikes.md C-3）：
 *   数据在 Host 的 ctx.ledger 上，浏览器进程拿不到；Host 把只读快照写成
 *   工作区里的 JSON，这里用 `ctx.remote.workspaceFiles` 的 stat/read 读回。
 *   接入点集中在 createFetchView() 一处。
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

import { panelRelativePath } from './panel-path.js'

const INK = '#1f2733'
const INK2 = '#5a6472'
const INK3 = '#8a93a0'

/** 会话 id 太长时截断成 chip 能放下的样子。 */
function shortId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return '—'
  return sessionId.length <= 10 ? sessionId : `${sessionId.slice(0, 6)}…${sessionId.slice(-3)}`
}

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
function formatAmount(amount, currency) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—'
  const n = amount.toFixed(4)
  return currency === 'CNY' ? `¥${n}` : `${n} ${currency ?? ''}`.trim()
}

/** token 数：千分位，缺失显示 —。 */
function formatTokens(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—'
}

/**
 * 来源桶的显示名。三个保留 key 有业务含义，直接显示原始字符串会让人以为坏了。
 * @param {string} key
 */
function sourceLabel(key) {
  if (key === 'shared:unknown') return '多个插件共同（拆不开）'
  if (key === 'unattributed') return '未归因'
  if (key === 'system:compaction') return '上下文压缩'
  return key
}

/** 时间戳 → HH:MM（面板只到分钟；没有就 —）。 */
function formatClock(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '—'
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 占比：0.362 → 36.2%。 */
function formatShare(share) {
  return typeof share === 'number' && Number.isFinite(share) ? `${(share * 100).toFixed(1)}%` : '—'
}

/**
 * 正文组件。用 createElement 而不引 JSX，避免给独立仓库引入构建链。
 * @param {any} React - 宿主的 React
 * @param {(sid: string, opts?: object) => Promise<any>} fetchView
 */
function makeLedgerBody(React, fetchView) {
  const h = React.createElement

  return function LedgerBody(props) {
    const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : null
    const [view, setView] = React.useState(undefined)
    const [busy, setBusy] = React.useState(false)

    const refresh = React.useCallback(async () => {
      if (sessionId === null) return
      setBusy(true)
      try {
        setView(await fetchView(sessionId))
      } finally {
        setBusy(false)
      }
    }, [sessionId])

    React.useEffect(() => {
      void refresh()
    }, [refresh])

    const head = h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px 8px',
          borderBottom: '1px solid #eef1f5',
        },
      },
      h('span', { style: { fontSize: 13, fontWeight: 600, color: INK } }, '账本'),
      h('span', { style: { fontSize: 11, color: INK3 } }, `会话 ${shortId(sessionId)}`),
      h(
        'button',
        {
          type: 'button',
          onClick: () => void refresh(),
          disabled: busy || sessionId === null,
          style: {
            marginLeft: 'auto',
            border: '1px solid #d8dee7',
            background: '#fff',
            borderRadius: 7,
            padding: '3px 9px',
            fontSize: 11.5,
            color: busy ? INK3 : INK2,
            cursor: busy ? 'default' : 'pointer',
          },
        },
        busy ? '刷新中' : '刷新',
      ),
    )

    // loading：还没跑完第一次
    if (view === undefined) {
      return h('div', null, head, h('p', { style: { margin: '12px 14px', fontSize: 12, color: INK3 } }, '正在读取…'))
    }

    // 通道或解析出错
    if (view !== null && typeof view.error === 'string') {
      return h(
        'div',
        null,
        head,
        h('p', { style: { margin: '12px 14px', fontSize: 12, lineHeight: 1.7, color: '#a03a2a' } }, `读取失败：${view.error}`),
        h(
          'p',
          { style: { margin: '0 14px 12px', fontSize: 11.5, lineHeight: 1.7, color: INK3 } },
          '通道细节见 docs/spikes.md 的 C-3 节。',
        ),
      )
    }

    // 还没有快照：Host 未开启或尚未落盘（这不是错误）
    if (view === null) {
      return h(
        'div',
        null,
        head,
        h(
          'div',
          { style: { padding: '12px 14px', fontSize: 12, lineHeight: 1.75, color: INK2 } },
          h('p', { style: { margin: 0 } }, '这个会话还没有成本快照。'),
          h(
            'p',
            { style: { margin: '8px 0 0', color: INK3, fontSize: 11.5 } },
            '在插件配置里打开 panel.enabled，Host 会按 panel.intervalMs 把只读快照写进工作区；',
            '也可以先在对话里用 ledger_query 查。',
          ),
        ),
      )
    }

    return renderPayload(React, view, sessionId, head)
  }
}

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
function renderPayload(React, view, sessionId, head) {
  const h = React.createElement
  const totals = view.totals ?? {}
  const cost = totals.cost ?? {}
  const tokens = totals.tokens ?? null
  const parts = cost.parts ?? null
  const list = Array.isArray(view.sources) && view.sources.length > 0 ? view.sources : view.topSources ?? []
  const recent = Array.isArray(view.recent) ? view.recent.filter((item) => item !== null) : []
  const others = Array.isArray(view.overview)
    ? view.overview.filter((row) => row !== null && row?.sessionId !== undefined && row.sessionId !== sessionId)
    : []

  return h(
    'div',
    null,
    head,
    // 合计
    h(
      'div',
      { style: { padding: '12px 14px 6px' } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
        h(
          'span',
          { style: { fontSize: 22, fontWeight: 600, color: INK, fontVariantNumeric: 'tabular-nums' } },
          formatAmount(cost.amount, cost.currency),
        ),
        h('span', { style: { fontSize: 11, color: INK3 } }, `${totals.entries ?? 0} 条 · 未归因 ${cost.unknownEntries ?? 0}`),
      ),
    ),
    // 预算条：只有配置了 limit 才画，未计价时不假装花了 0
    view.budget !== null && view.budget !== undefined
      ? h(
          'div',
          { style: { padding: '0 14px 10px' } },
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: INK3, marginBottom: 4 } },
            h('span', null, `预算 ${formatAmount(view.budget.limit, view.budget.currency)}`),
            h(
              'span',
              null,
              view.budget.used === null
                ? '未计价'
                : `已用 ${Math.round((view.budget.ratio ?? 0) * 100)}%`,
            ),
          ),
          h(
            'div',
            { style: { height: 4, borderRadius: 2, background: '#eef1f5', overflow: 'hidden' } },
            h('div', {
              style: {
                height: '100%',
                width: `${Math.round((view.budget.ratio ?? 0) * 100)}%`,
                background: (view.budget.ratio ?? 0) >= 0.8 ? '#c98a12' : '#2f7d64',
              },
            }),
          ),
        )
      : null,
    // token 四档
    h(
      'div',
      { style: { padding: '4px 14px 10px' } },
      tokens === null
        ? h('p', { style: { margin: 0, fontSize: 11.5, color: INK3 } }, '该会话没有可用的 token 计数')
        : h(
            'div',
            { style: { borderTop: '1px solid #eef1f5', paddingTop: 6 } },
            // 金额只由 Host 给（pricing.parts）；没有已知条目时整列给 —，不显示 0
            rowOf(React, '未缓存输入', formatAmount(parts?.input, cost.currency), `${formatTokens(tokens.input)} tok`),
            rowOf(React, '缓存命中', formatAmount(parts?.cacheRead, cost.currency), `${formatTokens(tokens.cacheRead)} tok`),
            rowOf(React, '缓存写', formatAmount(parts?.cacheWrite, cost.currency), `${formatTokens(tokens.cacheWrite)} tok`),
            rowOf(React, '输出', formatAmount(parts?.output, cost.currency), `${formatTokens(tokens.output)} tok · 含 reasoning`),
          ),
    ),
    // 来源
    h(
      'div',
      { style: { padding: '0 14px 10px' } },
      h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0 4px', borderTop: '1px solid #eef1f5' } },
        h('span', { style: { fontSize: 12, fontWeight: 600, color: INK } }, '谁花的'),
        h('span', { style: { fontSize: 10.5, color: INK3 } }, view.sourceCount === null || view.sourceCount === undefined ? '' : `共 ${view.sourceCount} 个来源`),
      ),
      list.length === 0
        ? h('p', { style: { margin: 0, fontSize: 11.5, color: INK3 } }, '还没有可归因的来源')
        : list.slice(0, 6).map((source, index) =>
            h(
              'div',
              {
                key: `${source.plugin ?? 'unknown'}-${index}`,
                style: { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0' },
              },
              h(
                'span',
                { style: { fontSize: 12, color: INK2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                sourceLabel(source.plugin ?? 'unattributed'),
              ),
              h(
                'span',
                { style: { fontSize: 12, color: INK, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
                `${formatAmount(source.amount, cost.currency)}  ${formatShare(source.share)}`,
              ),
            ),
          ),
      view.truncated === true
        ? h('p', { style: { margin: '6px 0 0', fontSize: 11, color: INK3 } }, '明细已截断，只保留合计与 Top 来源')
        : null,
    ),
    // 明细（表格视图）：最近几条，金额未知时显示原因而不是 0
    recent.length > 0
      ? h(
          'div',
          { style: { padding: '0 14px 8px' } },
          h(
            'div',
            { style: { fontSize: 12, fontWeight: 600, color: INK, padding: '8px 0 4px', borderTop: '1px solid #eef1f5' } },
            '最近',
          ),
          recent.slice(0, 5).map((item, index) =>
            h(
              'div',
              { key: `r-${index}`, style: { padding: '4px 0' } },
              h(
                'div',
                { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
                h(
                  'span',
                  { style: { fontSize: 11.5, color: INK2, fontVariantNumeric: 'tabular-nums' } },
                  formatClock(item.at),
                  h('span', { style: { fontSize: 10.5, color: INK3, marginLeft: 6 } }, item.kind === 'compaction' ? '压缩' : '模型'),
                ),
                h(
                  'span',
                  { style: { fontSize: 11.5, color: item.amount === null ? INK3 : INK, fontVariantNumeric: 'tabular-nums' } },
                  item.amount === null ? `— ${item.unknownReason ?? ''}`.trim() : formatAmount(item.amount, cost.currency),
                ),
              ),
              h(
                'div',
                { style: { fontSize: 10.5, color: INK3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                item.route === null || item.route === undefined
                  ? (item.system === 'compaction' ? '上下文压缩' : '无路由')
                  : `${item.route.provider ?? '?'}/${item.route.model ?? '?'}`,
                item.tokens === null
                  ? ''
                  : ` · ${formatTokens(item.tokens.input + item.tokens.output + item.tokens.cacheRead + item.tokens.cacheWrite)} tok`,
                item.plugin === null ? '' : ` · ${sourceLabel(item.plugin)}`,
              ),
            ),
          ),
        )
      : null,
    // 会话对比：只给其他会话，自己已经在顶部
    others.length > 0
      ? h(
          'div',
          { style: { padding: '0 14px 8px' } },
          h(
            'div',
            { style: { fontSize: 12, fontWeight: 600, color: INK, padding: '8px 0 4px', borderTop: '1px solid #eef1f5' } },
            '其他会话',
          ),
          others.slice(0, 3).map((row, index) =>
            h(
              'div',
              {
                key: `o-${index}`,
                style: { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '3px 0', fontSize: 11.5 },
              },
              h('span', { style: { color: INK2 } }, shortId(row.sessionId)),
              h(
                'span',
                { style: { color: INK, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
                `${formatAmount(row.amount, row.currency ?? cost.currency)} · ${row.entries ?? 0} 条`,
              ),
            ),
          ),
        )
      : null,
    // 页脚
    h(
      'div',
      { style: { padding: '6px 14px 12px', fontSize: 10.5, color: INK3 } },
      `快照生成于 ${typeof view.generatedAt === 'string' ? view.generatedAt.replace('T', ' ').slice(0, 19) : '—'}`,
    ),
  )
}

/** 一行 label / value，两个渲染入口共用。 */
function rowOf(React, label, value, hint) {
  const h = React.createElement
  return h(
    'div',
    { style: { display: 'flex', justifyContent: 'space-between', gap: 10, padding: '5px 0' } },
    h(
      'span',
      { style: { fontSize: 12, color: INK2 } },
      label,
      hint === undefined ? null : h('span', { style: { fontSize: 10.5, color: INK3, marginLeft: 4 } }, hint),
    ),
    h('span', { style: { fontSize: 12, color: INK, fontVariantNumeric: 'tabular-nums' } }, value),
  )
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

/**
 * 测试可见的内部件：组件工厂与格式化函数不对外导出，
 * 但 panel 的显示口径需要被断言，所以在这里开一个只读的口子。
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
