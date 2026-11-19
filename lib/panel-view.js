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

function renderPayload(React, view, sessionId, head, options = {}) {
  const expanded = options.expanded === true
  const h = React.createElement
  const totals = view.totals ?? {}
  const peak = view.peak ?? null
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
