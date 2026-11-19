import { formatChars } from './tool-size.js'

/** 缓存节省：为 null 或 0 时都不画收益行——0 收益不值得占版面，未知更不该冒充 0 */
function savedOf(view) {
  const saved = view.totals?.saved
  if (!saved || typeof saved.amount !== 'number' || saved.amount <= 0) return null
  return saved
}

/** 明细第二行的路由文案；压缩条目已经写了"压缩前 42.0k"，再写一次"上下文压缩"就是重复 */
function routeTextOf(item) {
  if (item.route !== null && typeof item.route === 'object') {
    return `${item.route.provider ?? '?'}/${item.route.model ?? '?'}`
  }
  if (typeof item.contextBeforeTokens === 'number') return null
  return item.system === 'compaction' ? '上下文压缩' : '无路由'
}

/** 上下文规模用 k 缩写：42.0k 比 42,000 更适合一眼扫 */
function formatContextTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 10_000) return value.toLocaleString('en-US')
  return `${(value / 1000).toFixed(1)}k`
}

/**
 * 面板的纯展示部分：样式常量、格式化、组件工厂。
 *
 * 这里不碰 ctx、不发请求、不写文件 —— 输入是"已经拿到的快照"，
 * 输出是 React 元素。取数与注册留在 client.js。
 */

/**
 * 数字的可信度要能自证：面板上每个金额都来自内置官方价表，
 * 用户看到这一行才知道"这是按什么价、哪天的价算的"，也才知道该不该信。
 */
/** 警示色（与预算 ≥80% 同色系）：只用来标"这个数不是确定值" */
const WARN = '#c98a12'

/** 收益色（品牌绿）：压缩省下的上下文属于"赚到了"，不能和支出一个颜色 */
const GOOD = '#2f7d64'

/** "谁花的"折叠前先显示几条：6 条是 300px 宽度下不做滚动还看得完的上限 */
const SOURCE_HEAD = 6

const PRICING_NOTE = '按内置官方价估算 · 2026-11-19'

const INK = '#1f2733'
const INK2 = '#5a6472'
const INK3 = '#8a93a0'

function shortId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return '—'
  return sessionId.length <= 10 ? sessionId : `${sessionId.slice(0, 6)}…${sessionId.slice(-3)}`
}

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

function makeLedgerBody(React, fetchView) {
  const h = React.createElement

  return function LedgerBody(props) {
    const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : null
    const [view, setView] = React.useState(undefined)
    const [busy, setBusy] = React.useState(false)
    const [expanded, setExpanded] = React.useState(false)

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

    // 来源多于 6 个时才能展开：展开只是"多显示几行"，不做分页、不过滤
    return renderPayload(React, view, sessionId, head, { expanded, onToggleSources: () => setExpanded((v) => !v) })
  }
}

/** 副标题：条数 + 未归因条数（未归因来自来源桶，不是"金额未知"） */
function summaryOf(totals, list) {
  const entries = totals.entries ?? 0
  const unattributed = list.find((item) => item?.plugin === 'unattributed')
  const lost = typeof unattributed?.entries === 'number' && unattributed.entries > 0 ? unattributed.entries : null
  return lost === null ? `${entries} 条` : `${entries} 条 · 未归因 ${lost}`
}

/** "还能问几次"：Host 已按均价算好，这里只加一句人话，面板不做除法以外的推断 */
function callsLeftOf(budget) {
  const left = budget?.callsLeft
  if (typeof left !== 'number' || !Number.isFinite(left)) return ''
  // 0 次不能写成"还可约 0 次"：读起来像还能问，实际是已经问不起了
  return left === 0 ? ' · 余量不足一问' : ` · 还可约 ${left} 次`
}

/** 命中率是"输入里走了缓存的比例"，分母不含缓存写 */
function hitRateOf(rate) {
  return typeof rate === 'number' && Number.isFinite(rate) ? ` · 占输入 ${Math.round(rate * 100)}%` : ''
}

function renderPayload(React, view, sessionId, head, options = {}) {
  const expanded = options.expanded === true
  const h = React.createElement
  const totals = view.totals ?? {}
  const peak = view.peak ?? null
  const unknownCount = typeof view.totals?.cost?.unknownEntries === 'number' ? view.totals.cost.unknownEntries : 0
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
        h('span', { style: { fontSize: 11, color: INK3 } }, summaryOf(totals, list)),
      ),
      // 合计偏低必须说：有未知费率的条目时，这个数字就是下限，不能摆得像确定值
      unknownCount > 0
        ? h(
            'div',
            { style: { marginTop: 4, fontSize: 10.5, lineHeight: 1.6, color: WARN } },
            `其中 ${unknownCount} 条费率未知，合计偏低`,
          )
        : null,
      // 收益行：账本里唯一能严格算出的"省了多少钱"（两个单价都在价表里，差额确定）。
      // 位置刻意紧贴总支出——商业化上，客户先看见"省了多少"才会觉得这个插件有价值。
      savedOf(view) === null
        ? null
        : h(
            'div',
            { style: { marginTop: 4, fontSize: 10.5, lineHeight: 1.6, color: GOOD, fontVariantNumeric: 'tabular-nums' } },
            `缓存命中已省 ${formatAmount(view.totals.saved.amount, view.totals.saved.currency)}${
              typeof view.totals.savedShare === 'number'
                ? ` · 占应花 ${formatShare(view.totals.savedShare)}`
                : ''
            }`,
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
                : `已用 ${Math.round((view.budget.ratio ?? 0) * 100)}%${callsLeftOf(view.budget)}`,
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
            rowOf(
              React,
              '缓存命中',
              formatAmount(parts?.cacheRead, cost.currency),
              `${formatTokens(tokens.cacheRead)} tok${hitRateOf(totals.cacheHitRate)}`,
            ),
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
        h(
          'span',
          { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
          h(
            'span',
            { style: { fontSize: 10.5, color: INK3 } },
            view.sourceCount === null || view.sourceCount === undefined ? '' : `共 ${view.sourceCount} 个来源`,
          ),
          // 只在前 6 条放不下时才给按钮：按钮一出来就说明"你少看了几条"
          list.length > SOURCE_HEAD
            ? h(
                'button',
                {
                  type: 'button',
                  onClick: options.onToggleSources,
                  style: { border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontSize: 10.5, color: '#2f7d64' },
                },
                expanded ? '收起' : `展开全部 ${list.length}`,
              )
            : null,
        ),
      ),
      list.length === 0
        ? h('p', { style: { margin: 0, fontSize: 11.5, color: INK3 } }, '还没有可归因的来源')
        : (expanded ? list : list.slice(0, SOURCE_HEAD)).map((source, index) =>
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
            { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, padding: '8px 0 4px', borderTop: '1px solid #eef1f5' } },
            h('span', { style: { fontSize: 12, fontWeight: 600, color: INK } }, '最近'),
            peak === null
              ? null
              : h(
                  'span',
                  { style: { fontSize: 10.5, color: INK3, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
                  `最贵一步 ${formatAmount(peak.amount, cost.currency)}`,
                ),
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
                  // 轮次：治理时要能定位到"哪一问最贵"，时间不够用
                  typeof item.turn === 'number'
                    ? h('span', { style: { fontSize: 10.5, color: INK3, marginLeft: 6 } }, `T${item.turn}·S${item.step ?? '—'}`)
                    : null,
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
                // 工具结果的体量排在最前：它是"这一步为什么贵"的直接解释，
                // 归属和路由被省略号截掉了也不影响判断
                // 压缩：前值 → 下一步的值；省下的量用水绿标出来，它是一笔"收益"不是支出
                item.contextBeforeTokens === null || item.contextBeforeTokens === undefined
                  ? null
                  : h(
                      'span',
                      { style: { color: GOOD, marginRight: 6, fontVariantNumeric: 'tabular-nums' } },
                      // 省下的量记在"压缩后的第一条调用"上；这条只有前值，就别画一个悬空的箭头
                      `压缩前 ${formatContextTokens(item.contextBeforeTokens)}`,
                    ),
                item.contextSavedTokens === null || item.contextSavedTokens === undefined
                  ? null
                  : h(
                      'span',
                      { style: { color: GOOD, marginRight: 6, fontVariantNumeric: 'tabular-nums' } },
                      `↓省 ${formatContextTokens(item.contextSavedTokens)}`,
                    ),
                item.contextChars === null || item.contextChars === undefined
                  ? null
                  : h(
                      'span',
                      { style: { color: item.contextChars >= 10_000 ? WARN : INK3, marginRight: 6 } },
                      `↑${formatChars(item.contextChars)}`,
                    ),
                routeTextOf(item),
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
    h('div', { style: { padding: '0 14px 12px', fontSize: 10.5, color: INK3 } }, PRICING_NOTE),
  )
}

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

function makeLedgerTitle(React) {
  const h = React.createElement
  return function LedgerTitle() {
    return h('span', null, '账本')
  }
}

export { makeLedgerBody, makeLedgerTitle, renderPayload, rowOf, formatAmount, formatTokens, formatShare, formatClock, shortId, sourceLabel }
