/**
 * 真机验证：在**没有真实模型凭据**的机器上，跑通 采集 → 计价 → 落盘 → 读数 全链路。
 *
 * 做法：宿主 llm-deepseek 的端点可配（$DEEPSEEK_BASE_URL），
 * 本脚本起一个本地 Messages 兼容端点返回**固定 usage**，让 DSH 真的发一次请求，
 * 然后读账本快照，逐项核对金额。
 *
 * 诚实边界（必读）：
 *   - 模型是假的（固定文本），token 数是脚本给的固定值；
 *   - 所以它证明的是"链路 + 计价 + 落盘 + 读数对"，**不证明模型跑得好**；
 *   - 真模型验证仍需真实 key，这是本脚本替代不了的。
 *
 * 用法：
 *   node scripts/verify-real-host.mjs [--profile ledger-test] [--cwd <dir>]
 *
 * 前置：该 profile 里必须打开 panel.enabled（写盘是外部副作用，插件默认关）。
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const profile = argOf('profile', 'ledger-test')
const workDir = resolve(argOf('cwd', process.cwd()))
const dshBin = join(workDir, 'node_modules/.bin/dsh')
const sdkPath = 'node_modules/.pnpm/@agentclientprotocol+sdk@1.4.0_zod@4.6.5/node_modules/@agentclientprotocol/sdk/dist/acp.js'

// 固定 usage：deepseek-v4-flash 内置价（元/百万）1 / 2 / 0.02 / 0
const USAGE = { input: 1000, cacheRead: 4000, output: 200, cacheWrite: 0 }
const EXPECTED = USAGE.input * 1e-6 + USAGE.cacheRead * 0.02e-6 + USAGE.output * 2e-6
const EXPECTED_SAVED = USAGE.cacheRead * (1e-6 - 0.02e-6)

if (!existsSync(dshBin)) {
  console.error(`✗ 找不到 ${dshBin}（--cwd 指向含 DSH 的目录）`)
  process.exit(1)
}

// ---- 1. 本地 Messages 兼容端点 ----
let seq = 0
const stub = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => {
    body += c
  })
  req.on('end', () => {
    seq += 1
    const parsed = (() => {
      try {
        return JSON.parse(body)
      } catch {
        return {}
      }
    })()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
    send('message_start', {
      message: {
        id: `msg_verify_${seq}`,
        type: 'message',
        role: 'assistant',
        model: parsed.model ?? 'deepseek-v4-flash',
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: USAGE.input,
          cache_read_input_tokens: USAGE.cacheRead,
          cache_creation_input_tokens: USAGE.cacheWrite,
        },
      },
    })
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'verify-ok' } })
    send('content_block_stop', { index: 0 })
    send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: USAGE.output } })
    send('message_stop', {})
    res.end()
  })
})

await new Promise((done) => stub.listen(0, '127.0.0.1', done))
const port = stub.address().port
console.log(`· 本地端点 127.0.0.1:${port}`)

// ---- 2. 起 DSH，发一次真实 prompt ----
const child = spawn(dshBin, ['--profile', profile], {
  cwd: workDir,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}`, DEEPSEEK_API_KEY: 'verify-local' },
})
let stderr = ''
child.stderr.on('data', (d) => {
  stderr += d.toString()
})
if (stderr.includes('lingda-ledger')) {
  console.error('✗ 插件未激活（见告警）：\n' + stderr.split('\n').filter((l) => l.includes('ledger')).join('\n'))
  child.kill()
  stub.close()
  process.exit(1)
}

const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = await import(
  join(workDir, sdkPath).replace(/\\/g, '/')
)
const { Writable, Readable } = await import('node:stream')
const conn = new ClientSideConnection(
  () => ({ sessionUpdate: async () => {}, requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }) }),
  ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
)
await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
const session = await conn.newSession({ cwd: workDir, mcpServers: [] })
await new Promise((done) => setTimeout(done, 300))
await conn.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: 'verify' }] })
// 落盘有 3s 节流，给足时间
await new Promise((done) => setTimeout(done, 3200))

// ---- 3. 读快照，逐项核对 ----
const snapDir = join(workDir, '.dsh/ledger')
if (!existsSync(snapDir)) {
  console.error(`✗ 没有快照目录 ${snapDir}（profile 里 panel.enabled 打开了吗？）`)
  child.kill()
  stub.close()
  process.exit(1)
}
if (!existsSync(snapDir)) mkdirSync(snapDir, { recursive: true })
const file = readdirSync(snapDir).filter((f) => f.endsWith('.json') && f.includes(session.sessionId))[0]
const payload = JSON.parse(readFileSync(join(snapDir, file), 'utf8'))
const totals = payload.totals ?? {}
const cost = totals.cost ?? {}
const saved = totals.saved ?? {}

const checks = []
const check = (name, pass, detail) => checks.push({ name, pass, detail })
check('条目已入账', totals.entries >= 1, `entries=${totals.entries}`)
check('金额与手算一致', Math.abs((cost.amount ?? 0) - EXPECTED * (cost.knownEntries ?? 1)) < 1e-9,
  `amount=${cost.amount} 期望≈${(EXPECTED * (cost.knownEntries ?? 1)).toFixed(6)}`)
check('无未知条目', (cost.unknownEntries ?? 0) === 0, `unknown=${cost.unknownEntries}`)
check('四档拆分齐全', !!cost.parts, JSON.stringify(cost.parts ?? null))
check('缓存节省可算', Math.abs((saved.amount ?? 0) - EXPECTED_SAVED * (saved.entries ?? 1)) < 1e-9,
  `saved=${saved.amount}`)
check('路由已识别', !!payload.recent?.[0]?.route?.model, String((payload.recent ?? [])[0]?.route?.model))
check('生成时间是 ISO', typeof payload.generatedAt === 'string', String(payload.generatedAt))

child.kill()
stub.close()

console.log('')
for (const c of checks) console.log(`${c.pass ? '✓' : '✗'} ${c.name}  ${c.detail}`)
const failed = checks.filter((c) => !c.pass).length
console.log(failed === 0 ? '\n全部通过（模型为本地固定端点）' : `\n${failed} 项未通过`)
process.exit(failed === 0 ? 0 : 1)
