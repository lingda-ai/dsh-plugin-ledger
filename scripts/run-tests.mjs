/**
 * 测试跑者：把测试放进**沙箱环境**里跑。
 *
 * 为什么需要它：CI 连红三次的根因之一，是 archive 的 e2e 测试隐式读取开发者本机
 * ~/.dsh/ledger/pricing.json 才算出价；CI 上没有该文件 → cost 为 null → 断言失败。
 * 依赖本机状态的测试，在本机与 CI 会给出不同结论，等于没有测试。
 *
 * 每个测试进程都拿到全新的 HOME / DSH_HOME / XDG，与所在机器无关。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const sandbox = mkdtempSync(join(tmpdir(), 'ledger-tests-'))
const home = join(sandbox, 'home')
const dshHome = join(sandbox, 'dsh-home')
for (const dir of [home, dshHome, join(home, '.config'), join(home, '.cache'), join(home, '.local', 'share')]) {
  mkdirSync(dir, { recursive: true })
}
const env = Object.assign({}, process.env, {
  HOME: home,
  USERPROFILE: home,
  DSH_HOME: dshHome,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_CACHE_HOME: join(home, '.cache'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
})

const only = process.argv[2]
const files = only ? [only] : readdirSync('test').filter((n) => n.endsWith('.test.mjs')).sort().map((n) => join('test', n))
console.log('# 沙箱测试：HOME=' + home + '  DSH_HOME=' + dshHome + '\n')
const result = spawnSync(process.execPath, ['--test', ...files], { env, stdio: 'inherit' })
rmSync(sandbox, { recursive: true, force: true })
process.exit(result.status === 0 ? 0 : 1)
