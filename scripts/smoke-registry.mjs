/**
 * 工具契约冒烟：用**真实** dsh-tools 的校验器检查我们的工具定义。
 *
 *   node scripts/smoke-registry.mjs
 *   DSH_NODE_ROOT=/path/to/node_modules node scripts/smoke-registry.mjs
 *
 * 已核实的运行时导出（dsh-tools 0.1.7-rc.2）：
 *   assertSupportedJsonSchema / assertObjectJsonSchema / validateJsonSchemaValue
 *
 * 局限（诚实标注）：registry 实例（ToolRuntime）在裸 cordis Context 里起不来，
 * 它依赖 scope/logger 等服务，必须真机 boot 才能验证 `register()` 本身。
 * 本脚本只证明"schema 会被 registry 接受"，不冒充已注册。
 */
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createLedgerQueryTool } from '../lib/audit-tool.js'

const ROOT = process.env.DSH_NODE_ROOT ?? '/home/user/lingzhi/node_modules'
const PNPM = `${ROOT}/.pnpm`

function findToolsDir() {
  try {
    const name = fs.readdirSync(PNPM).find((d) => d.startsWith('@deepseek-ai+dsh-tools@'))
    return name ? `${PNPM}/${name}/node_modules/@deepseek-ai/dsh-tools/lib/index.js` : null
  } catch {
    return null
  }
}

const entry = findToolsDir()
let tools
try {
  if (!entry) throw new Error('未找到 @deepseek-ai/dsh-tools')
  tools = await import(entry)
} catch (error) {
  console.log(`SKIP 未找到 DSH 工具运行时（${PNPM}）：${error.message}`)
  process.exit(0)
}

const fakeStore = {
  snapshot: () => ({ totals: { cost: { amount: null, unknownEntries: 0, currency: 'CNY' } }, recent: [], topSources: [], trace: [] }),
  totals: () => ({ cost: { amount: null, unknownEntries: 0, currency: 'CNY' } }),
}
const def = createLedgerQueryTool({ store: fakeStore })

assert.equal(typeof tools.assertSupportedJsonSchema, 'function', 'REG-1: 校验器必须存在')
console.log('PASS  REG-1  真实校验器可用')

tools.assertSupportedJsonSchema(def.output.schema)
console.log(`PASS  REG-2  output.schema ${JSON.stringify(def.output.schema)} 属于受支持子集`)

tools.assertObjectJsonSchema(def.parameters)
console.log(`PASS  REG-3  parameters 是受支持的 object schema（required=${JSON.stringify(def.parameters.required)}）`)

// 返回值必须能通过自己声明的 output.schema 校验
const value = await def.execute({ sessionId: 'probe', lastN: 3 }, {})
tools.validateJsonSchemaValue(def.output.schema, value)
console.log(`PASS  REG-4  execute 的实际返回值通过 output.schema 校验（长度 ${String(value).length}）`)

assert.equal(def.output.render({}, value)[0].type, 'text', 'REG-5: render 必须产出 text 块')
console.log('PASS  REG-5  render 产出合法 ContentBlock')

console.log('\n全部通过：工具定义的三处 schema 契约与真实运行时一致。')
console.log('未验证：ctx.tools.register() 本身（需真机 boot，见 docs/spikes.md）。')
