/**
 * 面板快照的路径约定（纯函数，两侧共用）。
 *
 * 为什么单独成文件：Host 半要写盘（用 node:fs），浏览器半要读回（用 workspace 文件 remote）。
 * 两侧必须给出**同名同路径**，所以文件名规则和相对路径只在这里定义一次，
 * 不能一边用 node:path 拼、一边又手写一遍。
 *
 * 路径形态：相对路径 `<root>/.dsh/ledger/<safeSessionId>.json`。
 * `workspaceFiles.stat/list` 接受以 Session cwd 为基准的相对路径，
 * `read` 则要绝对路径 —— 客户端先 stat 拿 `absolutePath` 再 read，无需配置。
 */

/** 默认目录（相对会话工作区根）。 */
export const PANEL_DIR = '.dsh/ledger'

/** 快照文件名的固定后缀。 */
export const PANEL_SUFFIX = '.json'

/**
 * sessionId 进文件名前必须清洗：只留 `[A-Za-z0-9_-]`。
 * 换掉 `../` 这类字符是为了不让会话 id 变成路径穿越。
 * @param {unknown} sessionId
 * @returns {string}
 */
export function safeFileName(sessionId) {
  const raw = typeof sessionId === 'string' ? sessionId : ''
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '_')
  return safe.length > 0 ? safe : 'unknown'
}

/**
 * 一份快照在工作区里的相对路径。
 * @param {unknown} sessionId
 * @param {string} [dir] - 相对目录，默认 {@link PANEL_DIR}
 * @returns {string}
 */
export function panelRelativePath(sessionId, dir = PANEL_DIR) {
  return `${dir}/${safeFileName(sessionId)}${PANEL_SUFFIX}`
}
