/**
 * 面板快照落盘。
 *
 * 为什么是文件而不是自定义 Remote：
 *   面板跑在浏览器，Host 的 ctx.ledger 它够不到。自定义 Typert remote 需要
 *   代码生成产物（见 docs/spikes.md C-3），而宿主**已经**给了一条现成通道：
 *   浏览器侧 `ctx.remote.workspaceFiles.read(absolutePath)` 可直接读工作区文本
 *   文件。于是 Host 只负责把只读快照写成 JSON，面板读回即可——零新增协议。
 *
 * 设计约束：
 *   - 只读快照，不写流水（流水是 trace 的事，隐私优先）；
 *   - 写盘失败绝不影响采集与预算：所有异常在内部吞掉，只记计数；
 *   - 节流：同一会话 intervalMs 内最多落盘一次，避免每个 token 都写盘；
 *   - 原子写：先写 `.tmp` 再 rename，面板永远读不到半截 JSON。
 */
import { mkdirSync, renameSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import { PANEL_DIR, safeFileName } from './panel-path.js'

/** 快照文件的格式版本：字段变了就加，面板据此决定要不要重渲染。 */
export const SNAPSHOT_VERSION = 1

export { safeFileName }

/**
 * 组装落盘内容。超过 maxBytes 时降级为"只有合计 + Top 来源"，
 * 面板据此显示"明细已截断"，而不是显示一份不完整的明细。
 */
export function buildPanelPayload(snapshot, sources, { maxBytes = 262144, budget = null, overview = null } = {}) {
  const base = {
    version: SNAPSHOT_VERSION,
    generatedAt: snapshot?.generatedAt ?? null,
    sessionId: snapshot?.sessionId ?? null,
    // 面板口径的派生字段集中在这里算一次，避免浏览器半各算一套
    totals: withPanelTotals(snapshot?.totals ?? null),
    topSources: snapshot?.topSources ?? [],
    // 最近明细：面板的"表格视图"直接用它，不再另拉一次
    recent: (snapshot?.recent ?? []).map(compactEntry),
    // 最贵一步：只从"最近这段"里挑，面板会明说是"最近最贵"，不冒充全程最贵
    peak: peakOf((snapshot?.recent ?? []).map(compactEntry)),
    // 跨会话对比：只给数字，不给别的内容（面板按 lastAt 排序取前几条）
    overview: Array.isArray(overview) ? overview.slice(0, 8).map(compactSession) : null,
    // 预算只给面板读数用：limit 为 null 表示未启用，面板不画进度条
    budget: normalizeBudget(budget, snapshot?.totals),
  }
  const full = { ...base, sources: sources?.sources ?? [], sourceCount: sources?.sourceCount ?? null }
  const bytes = Buffer.byteLength(JSON.stringify(full))
  return bytes <= maxBytes ? { payload: full, truncated: false } : { payload: base, truncated: true }
}

/**
 * 最近明细里金额最高的一条。没有已知金额时返回 null（未知不能用 0 参与比较）。
 * @param {Array<ReturnType<typeof compactEntry>>} recent
 */
export function peakOf(recent) {
  let best = null
  for (const item of recent ?? []) {
    if (item === null || typeof item.amount !== 'number' || !Number.isFinite(item.amount)) continue
    if (best === null || item.amount > best.amount) best = item
  }
  if (best === null) return null
  return {
    amount: best.amount,
    turn: best.turn,
    step: best.step,
    kind: best.kind,
    model: best.route?.model ?? null,
  }
}

/**
 * 一条明细压成面板够用的形状：去掉 callId、usage 明细与 trace 引用。
 * 金额与 token 都由 Host 算，面板只做显示。
 */
export function compactEntry(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const cost = entry.cost
  return {
    at: entry.at ?? null,
    turn: entry.turn ?? null,
    step: entry.step ?? null,
    // 上一步工具结果的文本字符数：解释"为什么这一步贵"的唯一线索
    contextChars: typeof entry.contextChars === 'number' ? entry.contextChars : null,
    // 压缩：前值 + 后一条省下的差值，两者都只在能算出来时给
    contextBeforeTokens: typeof entry.contextBeforeTokens === 'number' ? entry.contextBeforeTokens : null,
    contextSavedTokens: typeof entry.contextSavedTokens === 'number' ? entry.contextSavedTokens : null,
    kind: entry.kind ?? null,
    // 已知金额给数字，未知给原因码——面板据此显示"—"而不是 0
    amount: cost?.kind === 'known' ? cost.amount : null,
    unknownReason: cost?.kind === 'unknown' ? cost.reason : null,
    route: entry.route === null || entry.route === undefined ? null : { provider: entry.route.provider ?? null, model: entry.route.model ?? null },
    tokens: entry.usage === null || entry.usage === undefined
      ? null
      : { input: entry.usage.inputTokens ?? 0, output: entry.usage.outputTokens ?? 0, cacheRead: entry.usage.cacheReadTokens ?? 0, cacheWrite: entry.usage.cacheWriteTokens ?? 0 },
    plugin: entry.attribution?.primary?.plugin ?? null,
    system: entry.attribution?.system ?? null,
  }
}

/**
 * 一个会话对比项：只有 id、金额、条目数、最后时间。
 * 共享上下文拆不开时 amount 仍然是该会话的合计（面板不重算）。
 */
export function compactSession(row) {
  const cost = row?.cost
  return {
    sessionId: row?.sessionId ?? null,
    amount: typeof cost?.amount === 'number' ? cost.amount : null,
    currency: cost?.currency ?? null,
    entries: row?.entries ?? 0,
    lastAt: row?.lastAt ?? null,
  }
}

/**
 * 预算读数：限额由配置给，已用取 snapshot 的合计金额。
 * 金额缺失时不编 0 —— 面板显示"未计价"，而不是假装花了 0。
 */
export function normalizeBudget(budget, totals) {
  const limit = typeof budget?.limit === 'number' && budget.limit > 0 ? budget.limit : null
  if (limit === null) return null
  const amount = totals?.cost?.amount
  const currency = budget?.currency ?? totals?.cost?.currency ?? 'CNY'
  const used = typeof amount === 'number' && Number.isFinite(amount) ? amount : null
  const known = totals?.cost?.knownEntries

  // "还能问几次"比"已用 92%"更可行动：按已算出钱的条目均价反推。
  // 只认已知条目——把未知金额的条目算进均价就是拿假数做预测。
  const perCall = used !== null && typeof known === 'number' && known > 0 ? used / known : null
  const remaining = used !== null ? limit - used : null
  const callsLeft =
    perCall !== null && perCall > 0 && remaining !== null ? Math.max(0, Math.floor(remaining / perCall)) : null

  return {
    limit,
    currency,
    used,
    ratio: used === null ? null : Math.min(1, used / limit),
    remaining,
    perCall,
    // 语义是"约"：均价随缓存命中率波动，面板必须按约数展示
    callsLeft,
  }
}

/**
 * 面板要的两个派生读数，口径只能有一处（否则前后端各算一套，迟早对不上）。
 *
 * cacheHitRate：输入里有多少走了缓存 = cacheRead / (未命中输入 + 命中输入)。
 *   分母不含 cacheWrite —— DeepSeek 没有缓存写这一档，算进去会把命中率稀释。
 */
export function withPanelTotals(totals) {
  if (totals === null || typeof totals !== 'object') return null
  const t = totals.tokens ?? {}
  const miss = typeof t.input === 'number' ? t.input : null
  const hit = typeof t.cacheRead === 'number' ? t.cacheRead : null
  const denom = miss === null || hit === null ? null : miss + hit
  const cacheHitRate = denom !== null && denom > 0 ? hit / denom : null
  return { ...totals, cacheHitRate }
}

/**
 * @param {object} options
 * @param {string} options.dir - 输出目录（相对路径按 process.cwd() 解析）
 * @param {number} [options.intervalMs]
 * @param {number} [options.maxBytes]
 * @param {(sessionId: string, opts?: object) => object} options.snapshot
 * @param {(sessionId: string, opts?: object) => object} options.sources
 * @param {() => number} [options.now]
 */
export function createSnapshotPublisher(options) {
  const relativeDir = options.dir ?? PANEL_DIR
  // 绝对路径＝固定目录；相对路径＝每个会话各自的工作区根 + 该相对目录
  const fixedDir = isAbsolute(relativeDir) ? relativeDir : null
  const rootOf = typeof options.rootOf === 'function' ? options.rootOf : () => process.cwd()
  const dirOf = (sessionId) =>
    fixedDir !== null ? fixedDir : resolve(rootOf(sessionId), relativeDir)
  /** 诊断用：默认目录（固定目录时为它本身） */
  const dir = fixedDir ?? relativeDir

  const intervalMs = Math.max(0, Number(options.intervalMs ?? 0))
  const maxBytes = Math.max(1024, Number(options.maxBytes ?? 262144))
  const budget = options.budget ?? null // {limit, currency} 由调用方给（配置侧）
  const overview = typeof options.overview === 'function' ? options.overview : null
  const now = options.now ?? Date.now

  /** sessionId → 上次落盘时间戳 */
  const lastAt = new Map()
  const stats = { writes: 0, truncated: 0, errors: 0, sessions: () => lastAt.size }

  function filePathOf(sessionId) {
    return join(dirOf(sessionId), `${safeFileName(sessionId)}.json`)
  }

  /** 立刻落盘一次；返回是否真的写了。 */
  function publishNow(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    try {
      const snapshot = options.snapshot(sessionId)
      if (snapshot === null || snapshot === undefined) return false // 该会话已淘汰
      const sources = typeof options.sources === 'function' ? options.sources(sessionId) : null
      const ov = overview === null ? null : overview()
      const { payload, truncated } = buildPanelPayload(snapshot, sources, { maxBytes, budget, overview: ov?.sessions ?? ov })
      // 多行写：浏览器侧 read 是按行取页的，单行超长 JSON 会被页宽截断
      const body = JSON.stringify(payload, null, 2)
      mkdirSync(dirOf(sessionId), { recursive: true })
      const target = filePathOf(sessionId)
      const tmp = `${target}.${process.pid}.tmp`
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, target)
      lastAt.set(sessionId, now())
      stats.writes += 1
      if (truncated) stats.truncated += 1
      return true
    } catch (error) {
      stats.errors += 1
      // 临时文件可能残留：尽力清理，失败就算了
      try {
        rmSync(`${filePathOf(sessionId)}.${process.pid}.tmp`, { force: true })
      } catch {}
      void error
      return false
    }
  }

  /** 节流入口：由 session/event 高频调用，内部按 intervalMs 合并。 */
  function schedule(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    const previous = lastAt.get(sessionId)
    if (previous !== undefined && intervalMs > 0 && now() - previous < intervalMs) return false
    return publishNow(sessionId)
  }

  /** 会话结束：删掉快照并忘记节流状态（面板读到"会话已结束"）。 */
  function remove(sessionId) {
    lastAt.delete(sessionId)
    try {
      rmSync(filePathOf(sessionId), { force: true })
      return true
    } catch {
      stats.errors += 1
      return false
    }
  }

  function dispose() {
    lastAt.clear()
  }

  return { dir, publishNow, schedule, remove, dispose, stats, filePathOf }
}

/**
 * 读回一份快照（测试与 Host 侧诊断用；浏览器侧走 workspace 文件 remote）。
 * @param {string} filePath
 * @returns {object|null}
 */
export function readPanelFile(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}
