/**
 * 工具结果的"体积"：只数字符，不估 token。
 *
 * 为什么不估 token：不同 provider 的 tokenizer 不同，用 1 token ≈ 4 字符这种
 * 经验系数去报"约 xx token"，就是把不确定的东西伪装成确定。面板要显示的是
 * "这次工具结果有多大"，字符数本身就是事实。
 *
 * 只数 text：图片、文件引用等非文本块不占"文本上下文"，数进去反而误导。
 */
export function toolResultChars(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return 0
  let chars = 0
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && typeof block.text === 'string') chars += block.text.length
  }
  return chars
}

/** 给面板用的紧凑写法：18,442 → 18.4k（超过 1 万才缩写，小数字不做无意义转换） */
export function formatChars(chars) {
  if (typeof chars !== 'number' || !Number.isFinite(chars) || chars < 0) return null
  if (chars < 10_000) return `${chars.toLocaleString('en-US')} 字符`
  return `${(chars / 1000).toFixed(1)}k 字符`
}
