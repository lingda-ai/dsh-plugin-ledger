/**
 * 契约冒烟：用**真实**的 dsh-llm 构造预算消息，验证我们没有靠猜。
 *
 *   node scripts/smoke-dsh.mjs
 *   DSH_NODE_ROOT=/path/to/node_modules node scripts/smoke-dsh.mjs
 *
 * 为什么不做成单测：它依赖外部安装的 DSH 运行时，可能不存在。
 * 找不到运行时 = SKIP（退出码 0），找到但契约不符 = FAIL（退出码 1）。
 */
import assert from 'node:assert/strict'
import { makeBudgetMessage } from '../lib/budget-message.js'

const ROOT = process.env.DSH_NODE_ROOT ?? '/home/user/lingzhi/node_modules'

let llm
try {
  llm = await import(`${ROOT}/@deepseek-ai/dsh-llm/lib/index.js`)
} catch (error) {
  console.log(`SKIP 未找到 DSH 运行时（${ROOT}/@deepseek-ai/dsh-llm）：${error.message}`)
  // 退出码 2 = 本机没有运行时（SKIP）。它绝不能和"通过"混为一谈：
  // 发布闸门要求这两个冒烟必须真的跑过，否则等于没验证契约。
  process.exit(2)
}

assert.equal(typeof llm.createUserMessage, 'function', 'CLM-1: dsh-llm 必须导出 createUserMessage')
console.log('PASS  CLM-1  createUserMessage 导出存在')

const FACT = { spent: 3.2, limit: 5, currency: 'CNY', remainingRatio: 0.36, asOfStep: { turn: 2, step: 5 } }
const msg = makeBudgetMessage(FACT, llm.createUserMessage)

assert.ok(msg, 'CLM-2: 有构造函数时必须产出消息')
assert.equal(msg.role, 'user', 'CLM-2: 角色必须是 user')
assert.equal(msg.source.kind, 'user', 'CLM-3: source.kind 必须是 user')
assert.equal(typeof msg.id, 'string', 'CLM-4: 必须带稳定 id')
assert.ok(Array.isArray(msg.content) && msg.content.length > 0, 'CLM-5: content 必须是非空数组')
assert.equal(msg.content[0].type, 'text', 'CLM-5: 首块必须是 text')
assert.match(msg.content[0].text, /已花费 CNY3\.2000/, 'CLM-6: 金额格式')
console.log(`PASS  CLM-2..6  role=${msg.role} id=${msg.id} text=${JSON.stringify(msg.content[0].text)}`)

// agent.inject 需要的是不可变消息；运行时构造函数会冻结，这里确认一次
assert.ok(Object.isFrozen(msg), 'CLM-7: createUserMessage 必须返回冻结对象')
console.log('PASS  CLM-7  消息已冻结（可安全交给 agent.inject）')

console.log('\n全部通过：预算事实通道 A 的消息构造与运行时常量一致。')
