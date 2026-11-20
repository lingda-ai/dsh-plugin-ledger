// 把主包产物同步进自包含单包 @lingda-ai/dsh-plugin-ledger。
// 目的：插件只能从国内镜像（如华为云）安装时，镜像对"老包的新版本"同步滞后，
// 任何跨包硬依赖都会让安装失败；单包零依赖可绕开这个坑。
import { cp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClient } from './build-client.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'packages/dsh-plugin-ledger')

const main = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const self = JSON.parse(await readFile(join(dest, 'package.json'), 'utf8'))

// 1. 产物与文档（docs 只带 markdown，截图/预览 html 不进包体）
for (const item of ['lib', 'LICENSE']) {
  await rm(join(dest, item), { recursive: true, force: true })
  await cp(join(root, item), join(dest, item), { recursive: true })
}
await rm(join(dest, 'docs'), { recursive: true, force: true })
await cp(join(root, 'docs'), join(dest, 'docs'), {
  recursive: true,
  filter: (src) => src.endsWith('.md') || !src.includes('docs/'),
})

// 2. patch 指回自身（原来指向 @lingda-ai/ledger）
const patch = (await readFile(join(root, 'cordis.patch.yml'), 'utf8'))
  .replace('name: "@lingda-ai/ledger"', `name: "${self.name}"`)
await writeFile(join(dest, 'cordis.patch.yml'), patch)

// 3. manifest：dsh 字段必须与主包一致（bundle + client），否则右栏面板不出现；
//    入口字段（type/main/exports/engines）也必须照抄，否则 DSH 加载时报 failed to import
const next = {
  ...self,
  version: process.argv[2] || self.version,
  description: 'DSH 插件搜索入口：运行时账本（成本/用量观测）。自包含单包，不依赖其他 npm 包，便于从镜像源安装。',
  files: ['lib', 'cordis.patch.yml', 'README.md', 'docs'],
  type: main.type,
  main: main.main,
  exports: main.exports,
  engines: main.engines,
  dsh: main.dsh,
  peerDependencies: main.peerDependencies,
  publishConfig: { access: 'public' },
}
delete next.dependencies
await writeFile(join(dest, 'package.json'), JSON.stringify(next, null, 2) + '\n')

// 4. 客户端产物必须按本包的包名重建：
//    __ModuleLoader__.load({ id }) 的 id 就是宿主模块表的索引键，直接拷过来的
//    那份 id 写的是 @lingda-ai/ledger，装成 dsh-plugin-ledger 后会对不上。
const clientArtifact = await buildClient(dest)

const size = (await stat(join(dest, 'lib/index.js'))).size
console.log(`已同步 ${main.name}@${main.version} -> ${next.name}@${next.version}（lib/index.js ${size} B，零运行时依赖）`)
console.log(`客户端产物 ${clientArtifact.out}（id=${clientArtifact.id}，${clientArtifact.bytes} B）`)
