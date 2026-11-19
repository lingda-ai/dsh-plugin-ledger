import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createIdentity, normalizeRemote } from '../lib/identity.js'

const DEVICE = '0123456789abcdef'

function workspace(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ledger-id-'))
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

test('remote 归一：三种写法都落到 host/owner/repo', () => {
  assert.equal(normalizeRemote('git@github.com:LingDaAi/dsh-plugin-ledger.git'), 'github.com/lingdaai/dsh-plugin-ledger')
  assert.equal(normalizeRemote('https://user:pass@github.com/a/b.git'), 'github.com/a/b')
  assert.equal(normalizeRemote('ssh://gitlab.example.com/x/y'), 'gitlab.example.com/x/y')
  assert.equal(normalizeRemote('https://github.com/a/b'), 'github.com/a/b')
  // 认不出来的宁可 null，也不猜一个
  assert.equal(normalizeRemote('nonsense'), null)
  assert.equal(normalizeRemote(''), null)
  assert.equal(normalizeRemote(null), null)
  assert.equal(normalizeRemote('https://github.com/onlyowner'), null)
})

test('仓库本地 email 优先于全局，且大小写归一', () => {
  const root = workspace({
    '.git/config': '[user]\n\temail = LinZhengTong@Example.COM\n[remote "origin"]\n\turl = git@github.com:LingDaAi/dsh-plugin-ledger.git\n',
  })
  const globalCfg = join(root, 'global-gitconfig')
  writeFileSync(globalCfg, '[user]\n\temail = should-not-win@example.com\n')

  const identity = createIdentity({ deviceId: DEVICE, globalGitConfig: globalCfg })
  const value = identity.resolve(root)
  assert.equal(value.actor.email, 'linzhengtong@example.com')
  assert.equal(value.actor.source, 'git-local')
  assert.equal(value.project.key, 'github.com/lingdaai/dsh-plugin-ledger')
  assert.equal(value.project.source, 'git-remote')
  rmSync(root, { recursive: true, force: true })
})

test('本地没有 email 时退到全局配置，并标明来源', () => {
  const root = workspace({ '.git/config': '[core]\n\trepositoryformatversion = 0\n' })
  const globalCfg = join(root, 'global-gitconfig')
  writeFileSync(globalCfg, '[user]\n\temail = Team@Corp.com\n')

  const identity = createIdentity({ deviceId: DEVICE, globalGitConfig: globalCfg })
  const value = identity.resolve(root)
  assert.equal(value.actor.email, 'team@corp.com')
  assert.equal(value.actor.source, 'git-global')
  rmSync(root, { recursive: true, force: true })
})

test('两处都没有 email：actor 给 null，不拿系统用户名去猜', () => {
  const root = workspace({})
  const identity = createIdentity({ deviceId: DEVICE, globalGitConfig: join(root, 'nope') })
  const value = identity.resolve(root)
  assert.equal(value.actor, null)
  rmSync(root, { recursive: true, force: true })
})

test('没有 git remote 时项目键不含绝对路径（隐私）', () => {
  const root = workspace({})
  const identity = createIdentity({ deviceId: DEVICE, globalGitConfig: join(root, 'nope') })
  const value = identity.resolve(root)
  assert.equal(value.project.source, 'cwd')
  assert.match(value.project.key, /^dir\/.+?-[0-9a-f]{6}$/)
  assert.ok(!value.project.key.includes(root), '项目键不得带出绝对路径')
  rmSync(root, { recursive: true, force: true })
})

test('同一 cwd 只解析一次（缓存），不同 cwd 各自解析', () => {
  const root = workspace({})
  const identity = createIdentity({ deviceId: DEVICE, globalGitConfig: join(root, 'nope') })
  const first = identity.resolve(root)
  const second = identity.resolve(root)
  assert.equal(first, second, '缓存命中应返回同一对象')
  assert.equal(identity.stats().cwdCount, 1)
  const other = workspace({})
  identity.resolve(other)
  assert.equal(identity.stats().cwdCount, 2)
  rmSync(root, { recursive: true, force: true })
  rmSync(other, { recursive: true, force: true })
})

test('路径不存在或为空时也不抛错（身份是增强信息，不是运行前提）', () => {
  const identity = createIdentity({ deviceId: DEVICE, globalGitConfig: '/nonexistent/gitconfig' })
  assert.equal(identity.resolve('/nonexistent/deep/path').actor, null)
  const empty = identity.resolve('')
  assert.equal(empty.actor, null)
  assert.equal(empty.deviceId, DEVICE)
})

test('deviceId 注入后稳定，且形如 16 位 hex', () => {
  const identity = createIdentity({ deviceId: DEVICE })
  assert.equal(identity.deviceId(), DEVICE)
  assert.match(identity.deviceId(), /^[0-9a-f]{16}$/)
})
