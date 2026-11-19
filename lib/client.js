/**
 * @lingda/ledger —— 浏览器半（右侧栏 tab）
 *
 * 已核实（读 @deepseek-ai/dsh-client-ui-sidebar-right@0.1.7-rc.2 的类型定义）：
 *   - ctx.sidebarRightTabs.register(definition) → disposer
 *     definition: { id, kind, title(address), priority?, patterns?, canOpen?, guide?, multiple?, keepMounted? }
 *   - ctx.sidebarRight.registerCloseHandler(kind, handler) → disposer
 *   - 正文与 chip 标题分别注册在 keyed seat `sidebar.right.pane.tab` /
 *     `sidebar.right.pane.tab.title`，key 是 definition.id（即本包名）。
 *   - 页面型 tab 可以没有 patterns：按 kind 打开，address 由框架合成。
 *
 * 未核实（本机未安装，故不写死签名）：
 *   - `@deepseek-ai/dsh-client-ui-slots` 的上下文注册入口（ctx.slots.*）。
 *     正文注册需要它 + React 运行时，两样本仓库当前都没有。
 *   → 所以这里只做"身份登记"：类型、引导页入口、关闭清理、标题位预留；
 *     不伪造 body 注册。缺 body 时宿主显示"无法查看此内容"，不白屏、不报错，
 *     这是有意的降级。
 *
 * 约定（来自 dsh-client-modules）：客户端模块是 lazy factory，
 * 所有副作用必须发生在 apply() 闭包内，不能放模块顶层。
 */

/** 本实现的身份，也是 `sidebar.right.pane.tab` 这个 keyed seat 的 key。 */
const LEDGER_ID = '@lingda/ledger'
/** tab 类型判别串，`openTab('ledger.cost', …)` 用的就是它。 */
const LEDGER_KIND = 'ledger.cost'

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  // sidebar-right 未挂载时（例如纯 CLI 宿主）安静退出，不抛错
  const tabs = ctx.sidebarRightTabs
  if (!tabs || typeof tabs.register !== 'function') return

  /** @type {import('@deepseek-ai/dsh-client-ui-sidebar-right/client').SidebarRightTabDefinition} */
  const definition = {
    id: LEDGER_ID,
    kind: LEDGER_KIND,
    // chip 初始文案；要显示实时金额，再注册 `sidebar.right.pane.tab.title`
    title: () => '账本',
    // 页面型：不认领资源地址，只能按 kind 打开
    priority: 'extension',
    // 空白右栏的引导页入口——用户"发现账本"的最短路径
    guide: [
      {
        id: 'ledger.cost',
        order: 10,
        title: () => '账本',
        description: () => '本会话的 token 用量与成本归因',
      },
    ],
    // 切会话不重建面板体：成本是常驻读数，重建会丢滚动位置
    keepMounted: true,
  }

  const disposeTab = tabs.register(definition)

  // 关闭 tab 时释放本插件的持有；当前无副作用，但保持与宿主约定一致
  const disposeClose =
    typeof ctx.sidebarRight?.registerCloseHandler === 'function'
      ? ctx.sidebarRight.registerCloseHandler(LEDGER_KIND, () => {})
      : null

  const cleanup = () => {
    disposeClose?.()
    disposeTab()
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
  else ctx.on('dispose', cleanup)

  // TODO(M5-body): 正文注册在 `sidebar.right.pane.tab`（key = LEDGER_ID），
  // 依赖 `@deepseek-ai/dsh-client-ui-slots` 与宿主 React 运行时——两样本机都没有，
  // 签名未经核实，故不猜。接入顺序：
  //   1) 从 navigation.params 取 { sessionId } 定位会话，缺参时显示"已结束的会话"；
  //   2) 取数只走 ctx.ledger 的 snapshot / sources / overview，前端不聚合、不补零；
  //   3) tab 非 active 时停掉任何定时刷新，避免 keepMounted 后轮询叠加。
}
