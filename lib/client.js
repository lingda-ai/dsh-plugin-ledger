/**
 * 浏览器半（占位）。
 *
 * 约定（来自 dsh-client-modules）：客户端模块以 lazy CJS factory 执行，
 * **所有副作用（含 CSS 注入）必须发生在 factory 闭包内**，
 * 不能在模块顶层执行 —— 否则会在脚本执行期提前跑，污染启动。
 *
 * M5 在这里接 sidebarRightTabs.register 与 settings 卡片。
 * M0 阶段故意为空：先保证清单可加载、卸载干净。
 */
export function apply() {
  // no-op until M5
}
