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
export function buildPanelPayload(snapshot, sources, { maxBytes = 262144, budget = null } = {}) {
  const base = {
    version: SNAPSHOT_VERSION,
    generatedAt: snapshot?.generatedAt ?? null,
    sessionId: snapshot?.sessionId ?? null,
    totals: snapshot?.totals ?? null,
    topSources: snapshot?.topSources ?? [],
    // 预算只给面板读数用：limit 为 null 表示未启用，面板不画进度条
    budget: normalizeBudget(budget, snapshot?.totals),
  }
  const full = { ...base, sources: sources?.sources ?? [], sourceCount: sources?.sourceCount ?? null }
  const bytes = Buffer.byteLength(JSON.stringify(full))
  return bytes <= maxBytes ? { payload: full, truncated: false } : { payload: base, truncated: true }
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
  return {
    limit,
    currency,
    used,
    ratio: used === null ? null : Math.min(1, used / limit),
  }
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
      const { payload, truncated } = buildPanelPayload(snapshot, sources, { maxBytes, budget })
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
