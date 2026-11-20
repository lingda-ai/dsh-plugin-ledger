/**
 * 费率覆盖文件 —— 让"官方调价"不必改代码，也让改错不至于算错钱。
 *
 * 为什么需要它：
 *   内置价表（pricing-table.js）写死了 2026-11-19 的价格。官方一调价，
 *   所有用户看到的金额就**静默地**错了。对成本类产品，算错钱是信任级事故，
 *   比少一个功能严重得多。
 *
 * 为什么是"整条生效或整条拒绝"，而不是逐档合并：
 *   四档费率共同定义一个模型的价格语义。缺一档就合并，等于拿旧价补新价，
 *   算出来的数字既不是旧价也不是新价。宁可不认这个模型（costOf 返回 no-rate，
 *   面板显示"—"），也不给一个看起来像真的假数。
 *
 * 为什么在 boot 读一次、不监听文件变化：
 *   计价发生在每条 assistant/message 的热路径上。热路径不做 IO 是硬约束。
 *   改费率后重启会话即可生效——这个代价换的是"每笔计价都稳定"，
 *   而计价不稳定比多等一次重启危险得多。
 *
 * 单位：文件里写的是**元 / 百万 tokens**（和官方页面、和价格公告一致），
 * 内部转成元 / token。让人手写 1.2 而不是 0.0000012。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 覆盖文件默认位置：与 device-id 同目录，都在 ~/.dsh/ledger 下 */
export const PRICING_FILE_NAME = 'pricing.json'

const M = 1e-6
const REQUIRED_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite']

export function defaultPricingPath() {
  return join(homedir(), '.dsh', 'ledger', PRICING_FILE_NAME)
}

/**
 * 解析文件文本。纯函数，异常不外抛——文件是用户手写的，必须能给出可读原因。
 *
 * @param {string} text
 * @returns {{kind:'ok', rates:Record<string,object>, rejected:Array<object>, asOf:string|null, source:string|null, currency:string|null}
 *          |{kind:'invalid', reason:string, rejected:Array<object>}}
 */
export function parsePricingFile(text) {
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return { kind: 'invalid', reason: 'bad-json', rejected: [] }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { kind: 'invalid', reason: 'not-an-object', rejected: [] }
  }
  const raw = doc.rates
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'invalid', reason: 'no-rates', rejected: [] }
  }

  const rates = {}
  const rejected = []
  for (const [model, value] of Object.entries(raw)) {
    if (typeof model !== 'string' || model.trim() === '') {
      rejected.push({ model: String(model), reason: 'empty-model' })
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      rejected.push({ model, reason: 'not-an-object' })
      continue
    }
    const missing = REQUIRED_FIELDS.filter((f) => !Number.isFinite(value[f]))
    if (missing.length > 0) {
      // 缺档给缺档；写了非数字/负数给 field-invalid。两种 reject 原因分开，
      // 用户才知道是"漏写"还是"写错"
      const invalidField = REQUIRED_FIELDS.find(
        (f) => value[f] !== undefined && !Number.isFinite(value[f]),
      )
      if (invalidField !== undefined) rejected.push({ model, reason: 'field-invalid', field: invalidField })
      else rejected.push({ model, reason: 'fields-missing', missing })
      continue
    }
    const negative = REQUIRED_FIELDS.find((f) => value[f] < 0)
    if (negative !== undefined) {
      rejected.push({ model, reason: 'negative', field: negative })
      continue
    }
    // 元/百万 → 元/token。显式保留四档，不吞掉任何一档
    rates[model] = Object.freeze({
      input: value.input * M,
      output: value.output * M,
      cacheRead: value.cacheRead * M,
      cacheWrite: value.cacheWrite * M,
      currency: typeof value.currency === 'string' ? value.currency : undefined,
    })
  }

  if (Object.keys(rates).length === 0) {
    // 有内容但一条都不合法：这比"文件不存在"更值得报警，原因要带出去
    return { kind: 'invalid', reason: rejected.length > 0 ? 'all-rejected' : 'no-rates', rejected }
  }

  return {
    kind: 'ok',
    rates,
    rejected,
    asOf: typeof doc.asOf === 'string' ? doc.asOf : null,
    source: typeof doc.source === 'string' ? doc.source : null,
    currency: typeof doc.currency === 'string' ? doc.currency : null,
  }
}

/**
 * 读覆盖文件并解析。文件不存在是正常情况（返回 absent），不是错误。
 *
 * @param {{path?: string, readFile?: (p:string)=>string}} [options]
 * @returns {{kind:'absent'}|{kind:'ok',rates,rejected,asOf,source,currency}|{kind:'invalid',reason,rejected,detail?}}
 */
export function loadPricingOverride(options = {}) {
  const path = options.path || defaultPricingPath()
  const read = options.readFile ?? ((p) => readFileSync(p, 'utf8'))
  let text
  try {
    text = read(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') return { kind: 'absent' }
    // 读不了和写错了要分开：一种是权限/路径问题，一种是内容问题
    return { kind: 'invalid', reason: 'read-failed', rejected: [], detail: error?.code ?? 'unknown' }
  }
  return parsePricingFile(text)
}

/**
 * 把覆盖结果折算成面板/工具要展示的元信息。
 *
 * 关键：**失败也必须有 meta**。静默回退内置价、面板照常显示金额，
 * 等于让用户以为自己的费率生效了——那正是这个文件机制要防的事。
 *
 * @param {ReturnType<typeof loadPricingOverride>} result
 * @param {{asOf?: string, source?: string}} builtin
 */
export function pricingMetaOf(result, builtin = {}) {
  if (result.kind === 'ok') {
    return {
      kind: 'file',
      asOf: result.asOf,
      source: result.source,
      models: Object.keys(result.rates),
      rejected: result.rejected,
      error: null,
    }
  }
  if (result.kind === 'invalid') {
    return {
      kind: 'builtin',
      asOf: builtin.asOf ?? null,
      source: builtin.source ?? null,
      models: [],
      rejected: result.rejected ?? [],
      // 原因码要原样带出去，面板据此给一句人话
      error: result.reason,
    }
  }
  return {
    kind: 'builtin',
    asOf: builtin.asOf ?? null,
    source: builtin.source ?? null,
    models: [],
    rejected: [],
    error: null,
  }
}
