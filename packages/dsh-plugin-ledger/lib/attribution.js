/**
 * 归因。
 *
 * P-2 探针结论（源码证据见 docs/spikes.md）：
 *   - `tool/call` 会话事件只带 {turn, step, callId, name, arguments}，**没有插件身份**；
 *   - `tools/change` 是无载荷的全局通知，不告诉你是谁注册/注销；
 *   - `tools.register()` 返回 disposer，但注册来源只存在于调用方的 ctx scope，
 *     外部插件无法从公开 API 反查。
 *
 * 结论：**插件级归因无法从公开契约获得**。首版只做两种可信粒度：
 *   1) exact  —— 配置里显式声明 toolOwners 的工具名映射；
 *   2) none   —— 其余一律 unresolved，宁可空着也不编。
 *
 * "共享上下文"不是精度问题，是事实：多个插件共同贡献 prompt/schema 时，
 * 成本无法拆分，只能标注。
 */

/**
 * @param {{toolOwners?: Record<string, string>}} config
 */
export function createAttribution(config = {}) {
  const owners = new Map(Object.entries(config.toolOwners ?? {}))

  function forTool(name) {
    const owner = owners.get(name)
    if (owner) {
      return { primary: { plugin: owner, confidence: 'exact' }, sharedContext: [], system: null }
    }
    return { primary: null, sharedContext: [], system: null, unresolvedReason: 'no-origin' }
  }

  /**
   * 模型调用归因。
   * @param {{toolNames?: string[]}} input 触发本次请求的上一轮工具集
   */
  function forModel({ toolNames = [] } = {}) {
    const owned = []
    const unknown = []
    for (const name of toolNames) {
      const owner = owners.get(name)
      if (owner) {
        if (!owned.includes(owner)) owned.push(owner)
      } else {
        unknown.push(name)
      }
    }

    if (owned.length === 1 && unknown.length === 0) {
      return { primary: { plugin: owned[0], confidence: 'exact' }, sharedContext: [], system: null }
    }
    if (owned.length > 1) {
      return {
        primary: null,
        // 多插件共同贡献 → 只能标注为共享成本，不排序、不给百分比
        sharedContext: owned.map((plugin) => ({ plugin, note: 'shared-context-cost' })),
        system: null,
        unresolvedReason: 'multi-contributor',
      }
    }
    return {
      primary: null,
      sharedContext: unknown.map((tool) => ({ plugin: `tool:${tool}`, note: 'unlisted-tool' })),
      system: null,
      unresolvedReason: unknown.length ? 'no-origin' : 'no-signal',
    }
  }

  function forCompaction() {
    return { primary: null, sharedContext: [], system: 'compaction' }
  }

  return { forTool, forModel, forCompaction }
}
