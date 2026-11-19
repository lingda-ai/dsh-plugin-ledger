/**
 * 内置费率表 —— 只放**有官方页面可查**的价格，不猜、不估。
 *
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 抓取日期：2026-11-19（官方页面原文："产品价格可能发生变动，DeepSeek 保留修改价格的权利"）
 *
 * 官方口径（元 / 百万 tokens）：
 *   deepseek-v4-flash  缓存命中 0.02   缓存未命中 1    输出 2
 *   deepseek-v4-pro    缓存命中 0.025  缓存未命中 3    输出 6
 *
 * 换算：本表单位是"元 / token"，即官方价 × 1e-6。
 *
 * 三个刻意的选择：
 *  1. cacheWrite 记 0：DeepSeek 官方只有"命中/未命中"两档，**没有独立的缓存写单价**。
 *     其缓存写入的 token 本来就计入"未命中输入"。若这里再给一个价，会和 input 重复计费
 *     （同一批 token 收两次钱，正是本插件最不该犯的错）。其它 provider 若单独收缓存写，
 *     请在配置里覆盖。
 *  2. cacheRead 用官方命中价（0.02 / 0.025），不是"未命中价打折估算"。
 *  3. deepseek-chat / deepseek-reasoner 是官方明示的兼容别名
 *     （分别对应 v4-flash 的非思考 / 思考模式），因此与 v4-flash 同价；
 *     官方声明这两个模型名将于北京时间 2026/07/24 23:59 弃用。
 *
 * 表里没有的模型，`costOf()` 返回 unknown(no-rate)，面板显示"— no-rate"，
 * 绝不用 0 或平均值冒充。
 */

const M = 1e-6 // 元 / 百万 tokens → 元 / token

const FLASH = Object.freeze({ input: 1 * M, output: 2 * M, cacheRead: 0.02 * M, cacheWrite: 0 })
const PRO = Object.freeze({ input: 3 * M, output: 6 * M, cacheRead: 0.025 * M, cacheWrite: 0 })

export const BUILTIN_RATES = Object.freeze({
  'deepseek-v4-flash': FLASH,
  'deepseek-v4-pro': PRO,
  // 兼容别名（官方页面脚注 (1)）
  'deepseek-chat': FLASH,
  'deepseek-reasoner': FLASH,
})

export const BUILTIN_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'
export const BUILTIN_AS_OF = '2026-11-19'

/** 给面板/README 用的可读表，避免各处重复抄数字。 */
export function builtinRateTable() {
  return Object.entries(BUILTIN_RATES).map(([model, rate]) => ({
    model,
    currency: 'CNY',
    perMillion: {
      cacheRead: rate.cacheRead / M,
      input: rate.input / M,
      output: rate.output / M,
      cacheWrite: rate.cacheWrite / M,
    },
  }))
}
