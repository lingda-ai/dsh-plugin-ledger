/**
 * 身份线索：跨工具、跨仓库都成立的那几个"事实"。
 *
 * 为什么现在就要做（哪怕只有 DSH 一个 adapter）：
 *   `actor` / `project` 是**唯一真正时间不可逆**的字段——采集时不记，那段历史就永远缺这个维度，
 *   后面做团队视图再想按人/按项目聚合，只能从零开始积累。字段名可以改，幂等键可以换代，
 *   没采到的线索补不回来。
 *
 * 三个硬约束：
 *   1. 绝不在热路径上 fork 子进程（不许调 `git config`）——只同步读几十字节的配置文件；
 *   2. 绝不把绝对路径写进账本（用户目录结构属于隐私），项目键用 git remote 归一化，兜底用 basename + 短 hash；
 *   3. 任何一步失败都不抛错，最差返回 null——身份是增强信息，不是运行前提。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

/** 只匹配 `[user]` 段里的 email；不解析完整 ini，够用且不会误伤其它段 */
const EMAIL_LINE = /^\s*email\s*=\s*(.+)$/im
const REMOTE_LINE = /^\s*url\s*=\s*(.+)$/im
const DEVICE_ID = /^[0-9a-f]{16}$/

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function emailIn(text) {
  const match = text?.match(EMAIL_LINE)
  return match ? match[1].trim() : null
}

/**
 * git remote 归一成 `host/owner/repo`。
 * 认 `git@host:owner/repo.git`、`https://user:pass@host/owner/repo.git`、`ssh://host/owner/repo` 三种写法。
 */
export function normalizeRemote(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let text = raw.trim().replace(/\.git$/i, '')
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // 去协议
  text = text.replace(/^[^@/]*@/, '') // 去 user:pass@ 与 git@
  text = text.replace(/^([^:/]+):/, '$1/') // host:owner/repo → host/owner/repo
  const parts = text.split('/').filter(Boolean)
  if (parts.length < 3) return null // 至少 host/owner/repo，不足就认不出来
  return parts.slice(0, 3).join('/').toLowerCase()
}

function remoteIn(text) {
  const match = text?.match(REMOTE_LINE)
  return match ? normalizeRemote(match[1]) : null
}

/** 机器标识：优先持久化到 ~/.dsh/ledger/device-id；写不了就用 hostname 派生一个稳定值，绝不用随机数 */
function readOrCreateDeviceId() {
  const dir = join(homedir(), '.dsh', 'ledger')
  const path = join(dir, 'device-id')
  const existing = readText(path)?.trim()
  if (existing && DEVICE_ID.test(existing)) return existing

  const id = createHash('sha1').update(`${hostname()}|${process.platform}|${process.arch}`).digest('hex').slice(0, 16)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, `${id}\n`)
  } catch {
    // 无写权限时仍然返回同一个稳定 id，只是不落盘
  }
  return id
}

/**
 * @param {{globalGitConfig?: string, maxCwd?: number, deviceId?: string}} [options]
 */
export function createIdentity(options = {}) {
  const globalConfig = options.globalGitConfig ?? join(homedir(), '.gitconfig')
  const maxCwd = Math.max(2, Number(options.maxCwd ?? 64))
  const byCwd = new Map()
  let deviceId = null

  function deviceIdOf() {
    // 显式注入的 id 优先（测试与多设备场景），否则读/建 ~/.dsh/ledger/device-id
    if (deviceId === null) deviceId = typeof options.deviceId === 'string' && DEVICE_ID.test(options.deviceId) ? options.deviceId : readOrCreateDeviceId()
    return deviceId
  }

  function resolve(cwd) {
    if (typeof cwd !== 'string' || cwd === '') {
      return { actor: null, project: null, deviceId: deviceIdOf() }
    }
    const cached = byCwd.get(cwd)
    if (cached !== undefined) return cached

    const localConfig = readText(join(cwd, '.git', 'config'))
    const localEmail = emailIn(localConfig)
    const globalEmail = localEmail === null ? emailIn(readText(globalConfig)) : null

    let actor = null
    if (localEmail !== null) actor = { email: localEmail.toLowerCase(), source: 'git-local' }
    else if (globalEmail !== null) actor = { email: globalEmail.toLowerCase(), source: 'git-global' }

    // 项目键：git remote 最稳（跨机器、跨目录重命名都一致）；没有 remote 就退到目录名 + 路径短 hash
    const remote = remoteIn(localConfig)
    const project = remote !== null
      ? { key: remote, source: 'git-remote' }
      : { key: `dir/${cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'root'}-${createHash('sha1').update(cwd).digest('hex').slice(0, 6)}`, source: 'cwd' }

    const value = Object.freeze({ actor, project: Object.freeze(project), deviceId: deviceIdOf() })

    // 有界缓存：cwd 数量在团队规模内不会失控，超出淘汰最旧即可
    if (byCwd.size >= maxCwd) byCwd.delete(byCwd.keys().next().value)
    byCwd.set(cwd, value)
    return value
  }

  return { resolve, deviceId: deviceIdOf, normalizeRemote, stats: () => ({ cwdCount: byCwd.size }) }
}
