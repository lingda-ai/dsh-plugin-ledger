/**
 * 面板链路冒烟：Host 落盘 → 浏览器侧读回。
 *
 * 覆盖的是整条真实链路（除网络与 http 网关）：
 *   session/event → 计价 → store → snapshot 落盘 → workspaceFiles.stat/read → payload
 *
 * 这里不需要 boot 真正的 DSH，也不吃模型凭据：用假 ctx 派发事件，
 * 用本地文件实现一个最小的 workspaceFiles remote（签名与生成声明一致）。
 * 真机上唯一多出来的一层就是 remote 的物理传输，口径不再变化。
 *
 * 退出码 0 = 全通过；任何一步失败打印 FAIL 并以 1 退出。
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyHost } from '../lib/index.js'
import { createFetchView } from '../lib/client.js'
import { panelRelativePath } from '../lib/panel-path.js'

let failed = 0
function check(id, name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail === undefined ? '' : `  ${detail}`}`)
  if (!ok) failed += 1
}

const sessionId = 'session-9f2a41'
const root = mkdtempSync(join(tmpdir(), 'ledger-smoke-'))

// ---- 假 Host ctx：只提供 apply 真正用到的四个能力 ----
const listeners = new Map()
const ctx = {
  on(event, handler) {
    const list = listeners.get(event) ?? []
    list.push(handler)
    listeners.set(event, list)
    return () => {}
  },
  tools: { register: () => () => {} },
  provide: () => {},
  effect: () => () => {},
}
function emit(event, payload, extra) {
  for (const handler of listeners.get(event) ?? []) handler(payload, extra)
}

try {
  // 不传 pricing：走内置官方费率表，等于顺带验证"表→面板金额"这条线
  applyHost(ctx, {
    panel: { enabled: true, dir: '.dsh/ledger', intervalMs: 0 },
    attribution: { toolOwners: { 'tools.hr': '@lingzhi/tools/hr' } },
  })
  check('PANEL-1', 'Host 半可装配（假 ctx 不抛错）', true)

  const session = { id: sessionId, header: { cwd: root } }
  // 工具先行：归因取"同轮上一步"的工具集（跨轮不继承，这是设计口径）
  emit('session/event', session, { type: 'tool/call', turn: 2, step: 1, name: 'tools.hr', callId: 'c1' })
  // 模型调用：四档齐全
  emit('session/event', session, {
    type: 'assistant/message',
    turn: 2,
    step: 2,
    callId: 'c2',
    usage: { inputTokens: 9260, outputTokens: 1462, cacheReadTokens: 15660, cacheWriteTokens: 0, reasoningTokens: 312, complete: true },
    message: { source: { provider: 'deepseek', model: 'deepseek-v4-flash' }, usage: { inputTokens: 9260, outputTokens: 1462, cacheReadTokens: 15660, cacheWriteTokens: 0, reasoningTokens: 312 } },
  })

  const relative = panelRelativePath(sessionId)
  const abs = join(root, relative)
  let exists = false
  try {
    exists = statSync(abs).size > 0
  } catch {
    exists = false
  }
  const files = exists ? readdirSync(join(root, '.dsh', 'ledger')) : []
  check('PANEL-2', '快照按会话工作区落盘（panel.enabled 生效）', exists, `${relative} · ${files.join(',')}`)
  if (!exists) throw new Error('没有落盘，后续断言无从进行')

  const raw = JSON.parse(readFileSync(abs, 'utf8'))
  const expect = 0.0124972 // 9260×1e-6 + 15660×2e-8 + 1462×2e-6（内置 flash 官方价）
  check(
    'PANEL-3',
    '快照金额与内置费率手算一致（四档之和）',
    Math.abs(raw.totals.cost.amount - expect) < 1e-9,
    `amount=${raw.totals.cost.amount}`,
  )
  check(
    'PANEL-4',
    '四档金额随 payload 落到文件',
    raw.totals.cost.parts !== null &&
      Math.abs(raw.totals.cost.parts.input + raw.totals.cost.parts.output + raw.totals.cost.parts.cacheRead + raw.totals.cost.parts.cacheWrite - raw.totals.cost.amount) < 1e-9,
  )
  check('PANEL-5', '来源归因按 toolOwners 落到 hr', raw.sources.some((s) => s.plugin === '@lingzhi/tools/hr'),
    `sources=${raw.sources.map((s) => s.plugin).join(',')}`)
  check('PANEL-6', '明细已压缩（无 callId / usage 原字段）',
    raw.recent.length > 0 && raw.recent[0].callId === undefined && Array.isArray(raw.recent))

  // ---- 浏览器侧：用与生成声明一致的 remote 签名读回 ----
  const remote = {
    workspaceFiles: {
      async stat(scopeId, path) {
        // 相对路径以会话 cwd 为基准 —— 与 Host 侧 remote 行为一致
        if (typeof path !== 'string' || !path.startsWith('.dsh/ledger/')) return { ok: false }
        const target = join(root, path)
        try {
          return { ok: true, value: { absolutePath: target, bytes: statSync(target).size } }
        } catch {
          return { ok: false }
        }
      },
      async read(scopeId, absolutePath, range) {
        if (typeof range?.limit !== 'number') throw new Error('read 必须给 range.limit')
        const text = readFileSync(absolutePath, 'utf8')
        const lines = text.split('\n')
        const page = lines.slice(range.offset ?? 0, (range.offset ?? 0) + range.limit)
        return { ok: true, value: { text: page.join('\n'), offset: range.offset ?? 0, lines: page.length, eof: page.length < range.limit } }
      },
    },
  }

  const view = await createFetchView({ remote })(sessionId)
  check('PANEL-7', '客户端 stat→read→JSON.parse 读到同一份快照', view !== null && view.sessionId === sessionId)
  check('PANEL-8', '两侧口径一致（金额、条目数、四档）',
    view !== null &&
      Math.abs(view.totals.cost.amount - raw.totals.cost.amount) < 1e-12 &&
      view.totals.entries === raw.totals.entries &&
      view.totals.cost.parts.input === raw.totals.cost.parts.input,
    view === null ? 'view=null' : `amount=${view.totals.cost.amount}`)

  const missing = await createFetchView({ remote })('session-not-there')
  check('PANEL-9', '没有快照的会话返回 null（不是错误）', missing === null)

  // 写坏的文件：面板要给可读原因，而不是崩
  const badPath = join(root, '.dsh', 'ledger', 'session-broken.json')
  mkdirSync(join(root, '.dsh', 'ledger'), { recursive: true })
  writeFileSync(badPath, '{ broken', 'utf8')
  const brokenRemote = {
    workspaceFiles: {
      async stat() { return { ok: true, value: { absolutePath: badPath, bytes: 9 } } },
      async read() { return { ok: true, value: { text: '{ broken', eof: true } } },
    },
  }
  const broken = await createFetchView({ remote: brokenRemote })('session-broken')
  check('PANEL-10', '坏 JSON 给可读原因，不抛错', broken !== null && typeof broken.error === 'string', broken?.error)
} catch (error) {
  check('PANEL-ERR', '冒烟过程未抛异常', false, String(error))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failed === 0 ? '\n全部通过：面板落盘与读回口径一致。' : `\n${failed} 项失败。`)
process.exit(failed === 0 ? 0 : 1)
