/**
 * 生成文件，勿手改。源在 lib/*.src.js 与 lib/panel-*.js，改完跑：
 *   node scripts/build-client.mjs
 *
 * 形态由宿主决定：dsh-client-modules 会把本文件原样拼进 classic script，
 * 所以这里不能出现任何 import / export 语句。
 */
window.__ModuleLoader__.load({
  id: "@lingda-ai/ledger",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    //#region panel-path.js
    /**
     * 面板快照的路径约定（纯函数，两侧共用）。
     *
     * 为什么单独成文件：Host 半要写盘（用 node:fs），浏览器半要读回（用 workspace 文件 remote）。
     * 两侧必须给出**同名同路径**，所以文件名规则和相对路径只在这里定义一次，
     * 不能一边用 node:path 拼、一边又手写一遍。
     *
     * 路径形态：相对路径 `<root>/.dsh/ledger/<safeSessionId>.json`。
     * `workspaceFiles.stat/list` 接受以 Session cwd 为基准的相对路径，
     * `read` 则要绝对路径 —— 客户端先 stat 拿 `absolutePath` 再 read，无需配置。
     */
    
    /** 默认目录（相对会话工作区根）。 */
    const PANEL_DIR = '.dsh/ledger'
    
    /** 快照文件名的固定后缀。 */
    const PANEL_SUFFIX = '.json'
    
    /**
     * sessionId 进文件名前必须清洗：只留 `[A-Za-z0-9_-]`。
     * 换掉 `../` 这类字符是为了不让会话 id 变成路径穿越。
     * @param {unknown} sessionId
     * @returns {string}
     */
    function safeFileName(sessionId) {
      const raw = typeof sessionId === 'string' ? sessionId : ''
      const safe = raw.replace(/[^A-Za-z0-9_-]/g, '_')
      return safe.length > 0 ? safe : 'unknown'
    }
    
    /**
     * 一份快照在工作区里的相对路径。
     * @param {unknown} sessionId
     * @param {string} [dir] - 相对目录，默认 {@link PANEL_DIR}
     * @returns {string}
     */
    function panelRelativePath(sessionId, dir = PANEL_DIR) {
      return `${dir}/${safeFileName(sessionId)}${PANEL_SUFFIX}`
    }
    //#endregion

    //#region tool-size.js
    /**
     * 工具结果的"体积"：只数字符，不估 token。
     *
     * 为什么不估 token：不同 provider 的 tokenizer 不同，用 1 token ≈ 4 字符这种
     * 经验系数去报"约 xx token"，就是把不确定的东西伪装成确定。面板要显示的是
     * "这次工具结果有多大"，字符数本身就是事实。
     *
     * 只数 text：图片、文件引用等非文本块不占"文本上下文"，数进去反而误导。
     */
    function toolResultChars(message) {
      const blocks = message?.content
      if (!Array.isArray(blocks)) return 0
      let chars = 0
      for (const block of blocks) {
        if (block !== null && typeof block === 'object' && typeof block.text === 'string') chars += block.text.length
      }
      return chars
    }
    
    /** 给面板用的紧凑写法：18,442 → 18.4k（超过 1 万才缩写，小数字不做无意义转换） */
    function formatChars(chars) {
      if (typeof chars !== 'number' || !Number.isFinite(chars) || chars < 0) return null
      if (chars < 10_000) return `${chars.toLocaleString('en-US')} 字符`
      return `${(chars / 1000).toFixed(1)}k 字符`
    }
    //#endregion

    //#region panel-view.js
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
    /** 四档都齐才给总数：缺一档就当不知道，不把缺失当 0 加进去（否则会造出一个假数） */
    /** 实付 + 省下 = "如果没有缓存本来要花的钱"，也就是节省比例的分母。 */
    function grossAmountOf(view) {
      const saved = view?.totals?.saved?.amount
      const spent = view?.totals?.cost?.amount
      return typeof saved === 'number' && typeof spent === 'number' ? saved + spent : null
    }
    
    function tokensTotal(tokens) {
      if (!tokens || typeof tokens !== 'object') return null
      const parts = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite]
      if (!parts.every((v) => Number.isFinite(v))) return null
      return parts[0] + parts[1] + parts[2] + parts[3]
    }
    
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
    
    /** 面板自动刷新间隔：Host 落盘节流 3s，这里 5s，够快又不空转。 */
    const REFRESH_MS = 5000
    /** 单次读取的超时：超过它就必须报错，而不是让面板一直转圈。 */
    const READ_TIMEOUT_MS = 8000
    
    /**
     * 给一次远端读取加超时。
     *
     * RPC 卡住时 Promise 永远不 settle，界面就会停在"正在读取…"——用户既看不出坏在哪，
     * 也没有重试的余地。宁可报"读取超时"，也不要无声地转圈。
     * @template T
     * @param {Promise<T>} promise
     * @param {number} ms
     * @returns {Promise<T>}
     */
    function withTimeout(promise, ms) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`读取超时（${ms}ms）`)), ms)
        promise.then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (error) => {
            clearTimeout(timer)
            reject(error)
          },
        )
      })
    }
    
    // 老快照（没有 pricing 字段）的兜底文案。新快照一律由 pricingNoteOf 生成，
    // 因为"内置还是自定义、哪天的价、有没有被忽略的模型"只能从数据里读，不能写死。
    const PRICING_NOTE = '按内置官方价估算 · 2026-11-19'
    
    /** 原因码 → 用户能看懂的一句话。原因码在代码里稳定，人话在这里换。 */
    const PRICING_ERROR_TEXT = {
      'bad-json': 'pricing.json 不是合法 JSON',
      'not-an-object': 'pricing.json 顶层不是对象',
      'no-rates': 'pricing.json 缺少 rates 字段',
      'all-rejected': 'pricing.json 里没有一个完整费率',
      'read-failed': 'pricing.json 读取失败',
    }
    
    /**
     * 费率脚注：用户看到这一行，才知道这些金额按什么价、哪天的价算的。
     *
     * 三种状态必须分开显示，尤其第三种：
     *   - 自定义生效：说明日期，用户知道自己改过；
     *   - 没文件：内置价 + 基准日；
     *   - 文件写了但没生效：**必须显形**。静默回退内置价、金额照常显示，
     *     会让人以为自己调过价——这比显示"未知"危险得多。
     *
     * @returns {{text:string, warn:boolean, kind:'builtin'|'file'}}
     */
    function pricingNoteOf(pricing) {
      if (!pricing || typeof pricing !== 'object') {
        return { text: PRICING_NOTE, banner: null, warn: false, kind: 'builtin' }
      }
      const asOf = typeof pricing.asOf === 'string' && pricing.asOf.length > 0 ? pricing.asOf : null
      const rejected = Array.isArray(pricing.rejected) ? pricing.rejected.length : 0
    
      if (pricing.kind === 'file') {
        if (rejected > 0) {
          // 部分被拒：金额里混了两套价，必须顶到显眼位置说清楚，
          // 页脚只留一句来源，避免同一个信息说两遍
          return {
            text: `费率：自定义${asOf !== null ? ` ${asOf}` : ''}`,
            banner: `${rejected} 个模型费率无效，已按内置价处理`,
            warn: true,
            kind: 'file',
          }
        }
        return {
          text: asOf !== null ? `按自定义费率估算 · ${asOf}` : '按自定义费率估算 · 日期未标注',
          banner: null,
          warn: false,
          kind: 'file',
        }
      }
    
      if (typeof pricing.error === 'string' && pricing.error.length > 0) {
        const why = PRICING_ERROR_TEXT[pricing.error] ?? `pricing.json 未生效（${pricing.error}）`
        const detail = typeof pricing.detail === 'string' ? `（${pricing.detail}）` : ''
        return {
          // 页脚只说"现在按什么价算"，为什么没生效放顶部的 banner
          text: asOf !== null ? `费率：内置官方价 ${asOf}` : '费率：内置官方价',
          banner: `${why}${detail}，金额仍按内置价计算`,
          warn: true,
          kind: 'builtin',
        }
      }
    
      return {
        text: asOf !== null ? `按内置官方价估算 · ${asOf}` : PRICING_NOTE,
        banner: null,
        warn: rejected > 0,
        kind: 'builtin',
      }
    }
    
    /**
     * 费率异常警示条。为什么放顶部而不是页脚：
     * 页脚 10.5px 灰字等于藏起来。而"我改的价没生效、金额其实是内置价算的"
     * 如果不说清楚，用户会拿着一个自己以为调过的错数字去做判断。
     */
    function pricingBanner(React, note) {
      if (!note || note.warn !== true || note.banner === null) return null
      const h = React.createElement
      return h(
        'div',
        {
          style: {
            margin: '10px 14px 0',
            padding: '8px 10px',
            background: '#fdf6e7',
            borderLeft: `2px solid ${WARN}`,
            fontSize: 11,
            lineHeight: 1.65,
            color: '#8a5a00',
          },
        },
        note.banner,
      )
    }
    
    const INK = '#1f2733'
    const INK2 = '#5a6472'
    const INK3 = '#64707f'
    
    /**
     * 时间一律按**本地时区**显示。
     *
     * 为什么不能直接截 ISO 字符串：快照里的 generatedAt 是 UTC（toISOString），
     * 而明细行的"最近"用的是本地时间戳。同一块面板上"07:35"和"15:35"并存，
     * 用户只会以为数据错了。同一个面板里只能有一套时间口径。
     */
    function formatLocalTime(value) {
      if (typeof value !== 'string' || value.length === 0) return '—'
      const d = new Date(value)
      if (Number.isNaN(d.getTime())) return '—'
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }
    
    function shortId(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return '—'
      return sessionId.length <= 10 ? sessionId : `${sessionId.slice(0, 6)}…${sessionId.slice(-3)}`
    }
    
    /**
     * 金额精度按量级自适应。
     *
     * 为什么不能固定 4 位：单步模型调用常在 1e-5 量级，缓存命中那档一档只有 3.2e-5 元，
     * toFixed(4) 会显示成 ¥0.0000 —— 用户读到的是"这一步没花钱"，而那是假信息。
     * 和"未知"一样，显示一个不存在的 0 也是撒谎。
     */
    function formatAmount(amount, currency) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—'
      let digits = 4
      if (amount !== 0 && Math.abs(amount) < 0.001) digits = 6
      // 再小就换科学计数：1e-7 量级写 0.0000001 已经读不清了
      const n = amount !== 0 && Math.abs(amount) < 1e-6 ? amount.toExponential(1) : amount.toFixed(digits)
      return currency === 'CNY' ? `¥${n}` : `${n} ${currency ?? ''}`.trim()
    }
    
    /** token 数：千分位，缺失显示 —。 */
    function formatTokens(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—'
    }
    
    /**
     * 明细行专用的紧凑写法：180,000 → 180k。
     *
     * 这一行还要放轮次、工具体量、模型名，380px 下必然是抢空间的；
     * 金额在右边单独对齐，token 只要量级可读就够，不需要个位精度。
     */
    function formatTokensCompact(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value < 10_000) return value.toLocaleString('en-US')
      return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k`
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
     * 最近一次成功读取的快照，按会话索引。
     *
     * 为什么放在模块级而不是组件 state：右栏 tab 是 keepMounted 的常驻 UI，
     * 宿主在切会话/重挂时会重建组件；state 一丢就又回到"正在读取…"。
     * 有了这份缓存，第二次打开是**立刻有数**，轮询只负责刷新。
     * @type {Map<string, object>}
     */
    const viewCache = new Map()
    
    function makeLedgerBody(React, fetchView) {
      const h = React.createElement
    
      return function LedgerBody(props) {
        const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : null
        const [view, setView] = React.useState(() => (sessionId === null ? undefined : viewCache.get(sessionId)))
        const [busy, setBusy] = React.useState(false)
        const [expanded, setExpanded] = React.useState(false)
        // 正在飞的那一次请求：轮询必须跳过"上一拍还没回来"的这一次。
        // 否则每 REFRESH_MS 就有一个新请求把上一个响应判定为过期，
        // 只要单次读取慢于轮询间隔，面板就会**永远停在"正在读取…"**（真机上就是这个现象）。
        const inFlight = React.useRef(false)
        // 当前挂着的会话：响应回来时用它判断"是不是还在看同一个会话"
        const liveSession = React.useRef(sessionId)
        /** 挂载时刻：用来判断"这次读取是不是慢得反常" */
        const mountedAt = React.useRef(Date.now())
    
        const refresh = React.useCallback(async () => {
          if (sessionId === null) return
          if (inFlight.current) return
          inFlight.current = true
          const forSession = sessionId
          const startedAt = Date.now()
          setBusy(true)
          try {
            const next = await withTimeout(fetchView(forSession), READ_TIMEOUT_MS)
            if (next !== null && next?.error === undefined) viewCache.set(forSession, next)
            if (liveSession.current === forSession) setView(next)
          } catch (error) {
            // 任何异常都要落成可见的错误态。永久 loading 是最糟的失败方式：
            // 用户既不知道坏在哪，也不知道能不能重试。
            console.warn('[ledger] 读取账本快照失败:', error)
            if (liveSession.current === forSession) {
              setView({ error: `${error?.message ?? error}（耗时 ${Date.now() - startedAt}ms）` })
            }
          } finally {
            inFlight.current = false
            if (liveSession.current === forSession) setBusy(false)
          }
        }, [sessionId])
    
        React.useEffect(() => {
          liveSession.current = sessionId
          // 切会话先清空：宁可闪一帧"正在读取"，也不能让 B 会话标题下挂着 A 会话的金额
          setView(undefined)
          void refresh()
          // 成本是持续读数，不是一张照片：挂载后自动刷新（Host 侧 3 秒落盘节流）
          const timer = setInterval(() => { void refresh() }, REFRESH_MS)
          return () => clearInterval(timer)
        }, [refresh, sessionId])
    
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
    
        // loading：还没跑完第一次。超过 1.5 秒就把"读得慢"显出来，
        // 永久转圈是最没法排查的失败方式（既没有错误码，也没有重试入口）
        if (view === undefined) {
          const slow = Date.now() - mountedAt.current > 1500
          return h(
            'div',
            null,
            head,
            h('p', { style: { margin: '12px 14px', fontSize: 12, color: INK3 } }, slow ? '正在读取…（比预期慢）' : '正在读取…'),
            slow
              ? h(
                  'p',
                  { style: { margin: '0 14px 12px', fontSize: 11, lineHeight: 1.7, color: INK3 } },
                  `已等待 ${Math.round((Date.now() - mountedAt.current) / 1000)} 秒 · 点「刷新」可重试。`
                  + '若一直如此，多半是快照文件还没落盘（Host 每 3 秒最多写一次）。',
                )
              : null,
          )
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
              '常见原因：快照文件正在写入、Host 侧没开 panel.enabled、或工作区文件读取权限不足。点「刷新」可以重试。',
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
    
    /**
     * 副标题：调用次数 + 未归因次数。
     *
     * 三个坑都踩过：
     *   - 「9 条」在金额旁边会被读成 9 元 → 写「9 次调用」；
     *   - 「未归因 9」没单位，且全部未归因时这行等于什么都没说
     *     → 全部未归因时直接点明原因「来源未配置」，那是用户能动手改的；
     *   - 未归因统计的是**条目数**，不是金额未知，两者不能混成一句话。
     */
    function summaryOf(totals, list) {
      const entries = totals.entries ?? 0
      const unattributed = list.find((item) => item?.plugin === 'unattributed')
      const lost = typeof unattributed?.entries === 'number' && unattributed.entries > 0 ? unattributed.entries : null
      if (lost === null) return `${entries} 次调用`
      // 全部落在 unattributed 时不能写"来源未配置"：那个桶里既有"本会话没调用工具"（no-signal），
      // 也有"调了工具但没登记 owner"（no-origin）。写"配置"会把纯聊天会话指去改配置。
      if (lost === entries) return `${entries} 次调用 · 归因无信号`
      return `${entries} 次调用 · ${lost} 次未归因`
    }
    
    /** "还能问几次"：Host 已按均价算好，这里只加一句人话，面板不做除法以外的推断 */
    function callsLeftOf(budget) {
      const left = budget?.callsLeft
      if (typeof left !== 'number' || !Number.isFinite(left)) return ''
      // 0 次不能写成"还可约 0 次"：读起来像还能问，实际是已经问不起了
      return left === 0 ? ' · 余量不足一问' : ` · 还可约 ${left} 次`
    }
    
    /**
     * 命中率是"输入里走了缓存的比例"，分母不含缓存写。
     *
     * 两个退化：
     *   - ≥99.5% 时「占输入 100%」没有任何信息量，写成「几乎全命中」；
     *   - 0% 时不写（那只是"这次没缓存"，不是一条值得占版面的读数）。
     */
    function hitRateOf(rate) {
      if (typeof rate !== 'number' || !Number.isFinite(rate)) return ''
      if (rate >= 0.995) return ' · 几乎全命中'
      const pct = Math.round(rate * 100)
      return pct === 0 ? '' : ` · 占输入 ${pct}%`
    }
    
    /**
     * 空态：装完第一次打开右栏看到的就是这一屏。
     *
     * 为什么不能沿用主面板渲染：零条目时主面板会显示一个大「—」加一排空区块，
     * 用户第一反应是"这东西坏了"。空态要回答三个问题——这是什么、为什么还没数据、
     * 我该做什么——而不是把一张空表摆出来。
     *
     * 也不显示"¥0.0000"：0 元的意思是"确认没花钱"，而"还没有数据"不是那个意思。
     * 这两者混淆是成本类产品最常见的错误。
     */
    function renderEmptyState(React, view, sessionId, head, options = {}) {
      const h = React.createElement
      const note = pricingNoteOf(view?.pricing)
      const item = (title, detail) =>
        h(
          'div',
          { style: { marginTop: 8 } },
          h('div', { style: { fontSize: 11, fontWeight: 600, color: INK2 } }, title),
          h('div', { style: { fontSize: 11, lineHeight: 1.65, color: INK3, marginTop: 2 } }, detail),
        )
    
      return h(
        'div',
        null,
        head,
        pricingBanner(React, note),
        h(
          'div',
          { style: { padding: '14px 14px 6px' } },
          h('div', { style: { fontSize: 16, fontWeight: 600, color: INK } }, '本会话还没有模型调用'),
          h(
            'div',
            { style: { fontSize: 11.5, lineHeight: 1.7, color: INK2, marginTop: 6 } },
            '发一条消息，这里就开始记账。只读观测，不改你的请求。',
          ),
          h('div', { style: { height: 1, background: '#e8ebef', margin: '12px 0 10px' } }),
          h('div', { style: { fontSize: 11, color: INK3, letterSpacing: 0.3 } }, '会记什么'),
          item('每步花多少', '未命中输入 / 缓存命中 / 输出 分开计价，不用平均价套总数'),
          item('谁花的', '按同轮上一步的工具调用归因，跨轮不硬猜'),
          item('还能问几次', '按预算与均价估算；费率未知的条目不进均价'),
          h(
            'div',
            {
              style: {
                marginTop: 14,
                padding: '8px 10px',
                background: '#f6f7f9',
                borderLeft: `2px solid ${INK3}`,
                fontSize: 11,
                lineHeight: 1.7,
                color: INK2,
              },
            },
            '一直为空？面板靠 Host 落盘快照取数，需要在 profile 里打开 ',
            h('span', { style: { color: INK, fontWeight: 600 } }, 'panel.enabled'),
            '。',
          ),
        ),
        h(
          'div',
          { style: { padding: '4px 14px 12px', fontSize: 11, color: note.warn ? WARN : INK3 } },
          note.text,
        ),
      )
    }
    
    function renderPayload(React, view, sessionId, head, options = {}) {
      const expanded = options.expanded === true
      const note = pricingNoteOf(view?.pricing)
      const h = React.createElement
      const totals = view.totals ?? {}
      const peak = view.peak ?? null
      const unknownCount = typeof view.totals?.cost?.unknownEntries === 'number' ? view.totals.cost.unknownEntries : 0
      const cost = totals.cost ?? {}
      const tokens = totals.tokens ?? null
      const parts = cost.parts ?? null
      const rawList = Array.isArray(view.sources) && view.sources.length > 0 ? view.sources : view.topSources ?? []
      // 金额为 0 且没有条目的来源行没有信息量（多见于"注册了工具但没产生成本"的插件），
      // 但它们会让面板出现一排 ¥0.0000，读起来像"这些插件花过钱"
      const list = rawList.filter((source) => !(source?.amount === 0 && (source?.entries ?? 0) === 0))
      // 整个会话都算不出钱时，各来源的 0 元不是"真花了 0"，而是"分不出来" —— 一律显示 —
      const moneyKnown = typeof cost.amount === 'number' && Number.isFinite(cost.amount)
      const recent = Array.isArray(view.recent) ? view.recent.filter((item) => item !== null) : []
      const others = Array.isArray(view.overview)
        ? view.overview.filter((row) => row !== null && row?.sessionId !== undefined && row.sessionId !== sessionId)
        : []
    
      // 零条目走空态。判据用 entries（账本累计条目数），不用 cost.amount：
      // 金额为 null 可能是"有调用但费率未知"，那不是空会话
      const entryCount = typeof totals?.entries === 'number' ? totals.entries : recent.length
      if (entryCount === 0) return renderEmptyState(React, view, sessionId, head, options)
    
      return h(
        'div',
        null,
        head,
        pricingBanner(React, note),
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
                { style: { marginTop: 4, fontSize: 11, lineHeight: 1.6, color: WARN } },
                // "偏低"只在真有一个下限时成立；一条都算不出来时，说"未计价"才是实话
                moneyKnown
                  ? `其中 ${unknownCount} 条费率未知，合计偏低`
                  : `${unknownCount} 条费率未知，本次未计价`,
              )
            : null,
          // 收益行：账本里唯一能严格算出的"省了多少钱"（两个单价都在价表里，差额确定）。
          // 位置刻意紧贴总支出——商业化上，客户先看见"省了多少"才会觉得这个插件有价值。
          savedOf(view) === null
            ? null
            : h(
                'div',
                { style: { marginTop: 4, fontSize: 11, lineHeight: 1.6, color: GOOD, fontVariantNumeric: 'tabular-nums' } },
                `缓存已省 ${formatAmount(view.totals.saved.amount, view.totals.saved.currency)}${
                  typeof view.totals.savedShare === 'number'
                    ? ` · 如未命中需 ${formatAmount(grossAmountOf(view), view.totals.saved.currency)}（少花 ${formatShare(view.totals.savedShare)}）`
                    : ''
                }`,
              ),
        ),
        // 预算条：只有配置了 limit 才画，未计价时不假装花了 0
        view.budget === null || view.budget === undefined
          ? h(
              'div',
              { style: { padding: '0 14px 8px', fontSize: 11, color: INK3 } },
              // 静默消失会被读成"这个面板没有这个功能"；说清是配置项，用户才知道怎么开
              '未设预算 · 配 budget.limit 后这里显示"还能问几次"',
            )
          : h(
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
            ),
        // token 四档
        h(
          'div',
          { style: { padding: '4px 14px 10px' } },
          !tokens
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
                // 缓存写：DeepSeek 没有独立写价，这一档恒为 0。占一行"0 tok ¥0.0000"只是噪音，
                // 但真的产生了写 token 时必须画出来（其它 provider 会有）
                (tokens.cacheWrite ?? 0) > 0 || (parts?.cacheWrite ?? 0) > 0
                  ? rowOf(React, '缓存写', formatAmount(parts?.cacheWrite, cost.currency), `${formatTokens(tokens.cacheWrite)} tok`)
                  : null,
                rowOf(
                  React,
                  '输出',
                  formatAmount(parts?.output, cost.currency),
                  // "含 reasoning" 在 reasoning=0 时是假陈述
                  `${formatTokens(tokens.output)} tok${(tokens.reasoning ?? 0) > 0 ? ' · 含 reasoning' : ''}`,
                ),
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
                { style: { fontSize: 11, color: INK3 } },
                // 计数用"有金额的来源"，并在过滤掉零金额来源时说清楚，
                // 免得"共 8 个来源"下面只画 5 行被当成渲染 bug
                view.sourceCount === null || view.sourceCount === undefined
                  ? ''
                  : list.length === (view.sourceCount ?? list.length)
                    ? `共 ${view.sourceCount} 个来源`
                    : `共 ${list.length} 个有金额来源`,
              ),
              // 只在前 6 条放不下时才给按钮：按钮一出来就说明"你少看了几条"
              list.length > SOURCE_HEAD
                ? h(
                    'button',
                    {
                      type: 'button',
                      onClick: options.onToggleSources,
                      style: { border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontSize: 11, color: '#2f7d64' },
                    },
                    expanded ? '收起' : `展开全部 ${list.length}`,
                  )
                : null,
            ),
          ),
          list.length === 0
            ? h(
                'p',
                { style: { margin: 0, fontSize: 11.5, color: INK3 } },
                rawList.length > 0 ? '有工具调用，但都没有产生可计的金额' : '还没有可归因的来源',
              )
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
                    moneyKnown
                      ? `${formatAmount(source.amount, cost.currency)}  ${formatShare(source.share)}`
                      : '—',
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
                      { style: { fontSize: 11, color: INK3, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
                      // 只说"最贵"会让人去优化那一步；补上定位与占比才知道值不值得优化
                      `最贵 ${typeof peak.turn === 'number' ? `T${peak.turn}·S${peak.step ?? '—'} ` : ''}${formatAmount(peak.amount, cost.currency)}${
                        moneyKnown && cost.amount > 0
                          ? ` · 占 ${formatShare(peak.amount / cost.amount)}`
                          : ''
                      }`,
                    ),
              ),
              recent.slice(0, 5).map((item, index, all) =>
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
                      h('span', { style: { fontSize: 11, color: INK3, marginLeft: 6 } }, item.kind === 'compaction' ? '压缩' : '模型'),
                      // 轮次：治理时要能定位到"哪一问最贵"，时间不够用
                      typeof item.turn === 'number'
                        ? h('span', { style: { fontSize: 11, color: INK3, marginLeft: 6 } }, `T${item.turn}·S${item.step ?? '—'}`)
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
                    { style: { fontSize: 11, color: INK3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    // 第二行的优先级 = "为什么这一步贵"：压缩收益 > 本次 token 量 > 工具体量 > 路由 > 归属。
                    // 380px 下这一行必定会被省略号截断，所以要让它从右边开始丢信息，
                    // 而不是从左边（左边留住的是解释，右边留住的是标识）。
                    ...detailPartsOf(React, item, cost, {
                      // 同一段的模型名大多相同，重复 N 遍等于把"为什么贵"的信息挤出去
                      hideRoute: index > 0 && routeTextOf(item) === routeTextOf(all[index - 1]),
                    }),
                  ),
                ),
              ),
            )
          : null,
        // 结论行：② 问的是"为什么贵"，一张等高的小额明细表回答不了。
        // 只在"命中这一档确实占大头"时给一句人话，其余情况闭嘴（不为了凑结论而编结论）。
        (() => {
          if (!moneyKnown || typeof parts?.cacheRead !== 'number' || cost.amount <= 0) return null
          const share = parts.cacheRead / cost.amount
          const calls = totals.entries ?? 0
          if (share < 0.5 || calls < 3) return null
          const totalTok = tokens ? (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.output ?? 0) : null
          return h(
            'div',
            { style: { padding: '0 14px 10px', fontSize: 11, lineHeight: 1.65, color: INK2 } },
            `钱主要花在重复送出的上下文：命中一档 ${formatAmount(parts.cacheRead, cost.currency)}（占 ${formatShare(share)}）`,
            totalTok === null ? '' : `，${calls} 次调用共送出 ${formatTokensCompact(totalTok)} tok`,
          )
        })(),
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
        // 页脚：快照时间 + 费率来源合成一行，省 20px 且不会出现"两个日期像两个时间戳"
        h(
          'div',
          {
            // 费率无效时整行转警示色：这是"金额不可信"的信号，不能和普通脚注同色
            style: { padding: '6px 14px 12px', fontSize: 11, lineHeight: 1.65, color: note.warn ? WARN : INK3 },
          },
          `快照 ${formatLocalTime(view.generatedAt)} · ${note.text}`,
        ),
      )
    }
    
    /**
     * 明细第二行的片段，用「 · 」连接。
     *
     * 抽成纯函数是为了让"谁被截断"这件事可测：片段顺序固定，
     * 极少数的压缩条目也只是在最前面多两段，不会影响后面的相对顺序。
     * @param {any} React
     * @param {object} item - compactEntry 产出的一条明细
     * @param {object} cost - totals.cost（取币种与可读性标记）
     */
    function detailPartsOf(React, item, cost, options = {}) {
      const h = React.createElement
      const parts = []
      if (item.contextBeforeTokens !== null && item.contextBeforeTokens !== undefined) {
        parts.push(h('span', { style: { color: GOOD, fontVariantNumeric: 'tabular-nums' } }, `压缩前 ${formatContextTokens(item.contextBeforeTokens)}`))
      }
      if (item.contextSavedTokens !== null && item.contextSavedTokens !== undefined) {
        parts.push(h('span', { style: { color: GOOD, fontVariantNumeric: 'tabular-nums' } }, `↓省 ${formatContextTokens(item.contextSavedTokens)}`))
      }
      const total = tokensTotal(item.tokens)
      // 「本次」两个字不能省：没有主语的 180k tok 会被读成累计上下文
      if (total !== null) parts.push(`本次 ${formatTokensCompact(total)} tok`)
      if (item.contextChars !== null && item.contextChars !== undefined) {
        parts.push(h('span', { style: { color: item.contextChars >= 10_000 ? WARN : INK3 } }, `工具结果 ${formatChars(item.contextChars)}`))
      }
      const route = routeTextOf(item)
      if (route && options.hideRoute !== true) parts.push(route)
      if (item.plugin !== null && item.plugin !== undefined) parts.push(sourceLabel(item.plugin))
      return parts.flatMap((part, index) => (index === 0 ? [part] : [' · ', part]))
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
          hint === undefined ? null : h('span', { style: { fontSize: 11, color: INK3, marginLeft: 4 } }, hint),
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
    //#endregion

    //#region client.src.js
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
    const inject = ['sidebarRightTabs']
    
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
    // 产物里没有裸 import 可解析；由 wrapper 的 __setReactLoader 覆盖
    let reactLoader = async () => null
    
    /** 只给构建产物用：把 React 换成宿主模块表给的 require。 */
    function __setReactLoader(fn) {
      if (typeof fn === 'function') reactLoader = fn
    }
    
    
    
    
    
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
    function createFetchView(ctx) {
      return async function fetchView(sessionId, opts = {}) {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return null
        const files = workspaceFilesOf(ctx)
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
    
    /**
     * 取 workspaceFiles remote。
     *
     * 真机报错：`cannot get property "remote.workspaceFiles" without inject`。
     * 原因：remote 是按 `remote.<name>` 为 key 注册的服务，`ctx.remote.workspaceFiles`
     * 这种点号访问最终会落到 ctx 代理上做 inject 校验——没声明就抛，而它在 apply 之后、
     * 面板读取时才第一次触发（所以表现为"面板读取失败"，不是启动失败）。
     *
     * 正确姿势是用 `ctx.get('remote.workspaceFiles')` 这条**不受 inject 约束**的通道
     * （cordis 自己在服务目录里就把 ctx.get 标成 optional access）。
     * 逐级兜底，任何一层抛错都当作"没有这条通道"。
     * @param {any} ctx
     * @returns {any|null}
     */
    function workspaceFilesOf(ctx) {
      if (typeof ctx?.get === 'function') {
        try {
          const direct = ctx.get('remote.workspaceFiles')
          if (direct) return direct
        } catch {
          // 某些版本只注册了命名空间，继续往下试
        }
        try {
          const namespace = ctx.get('remote')
          const files = namespace?.workspaceFiles
          if (files) return files
        } catch {
          // 命名空间访问同样可能被代理拦，忽略
        }
      }
      try {
        return ctx?.remote?.workspaceFiles ?? null
      } catch {
        return null
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
    async function apply(ctx) {
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
    const __internal = {
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
    //#endregion

    // React 只能来自宿主模块表：浏览器里没有裸 import('react') 能解析的路径
    __setReactLoader(() => require("react"));

    exports.apply = apply;
    // 硬依赖必须跟着产物一起导出：cordis 靠它判断"什么时候允许 apply"，
    // 漏了就会在 apply 里抛 cannot get property "..." without inject，把宿主启动带崩。
    exports.inject = inject;
    // 纯函数面：只给测试与诊断用（renderPayload 等），不参与宿主运行
    exports.__internal = __internal;
    return module.exports;
  },
});
