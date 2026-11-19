# M0 源码探针报告（三条关键假设的实证结论）

版本：0.1.0 · 探针对象：`@deepseek-ai/dsh-*` 0.1.7-rc.2（node_modules 实装）

结论先行：**P-1 通过，P-2 不可行需降级，P-3 原设计不成立需改架构。**
这三条决定了插件的整个骨架，不是细节。

---

## P-1 会话可见性：通过

`@deepseek-ai/dsh-session` 的 `session/event` 事件声明：

> Post-commit, fire-and-forget append feed.

> Scope-filtered dispatch: agent-scoped listeners receive only events from sessions
> entered through that agent's context.

推论：

1. 在**根 ctx** 上 `ctx.on('session/event', ...)` 可收到全部会话事件；
   只有把监听器挂在某个 agent 的 scope 内才会被过滤。
   → 账本插件必须挂在根 ctx，不能挂在 agent 内。
2. 监听器抛错会被"logged and contained"，不会让已提交的 append 失败。
   → 我们仍然自己 try/catch 并计数（不想在日志里刷 stack），
     但这条保证了旁路观测**不进入关键路径**。
3. `session/created` / `session/disposed` / `session/event` 三件套齐全，
   → 会话生命周期与淘汰可对齐（`session/disposed` 时 `store.drop()`）。

**代价**：post-commit 意味着事件已经落盘，账本是**事后账**，不是拦截点。
任何"阻止本次调用"的诉求都做不到，只能做下一次调用的决策（见 P-3）。

---

## P-2 工具级归因：不可行，必须降级

三条独立证据：

1. `tool/call` 事件载荷只有 `{ turn, step, callId, name, arguments }`，
   **没有任何插件身份字段**。
2. `tools/change` 是 "UNFILTERED registry-subject notification"，但**无 payload**——
   只能知道"工具表变了"，不知道是谁注册了谁。
3. `ctx.tools.register(definition)` 只返回 disposer，签名不携带来源；
   来源只存在于调用方的 ctx scope，外部插件无法从公开 API 反查。

**为什么不 wrap `register`**：那是猴子补丁。会在多插件并发注册时产生顺序依赖，
且破坏 cordis 的 disposer 语义，是典型的"能跑但不能维护"。否决。

**降级方案（已实现于 `lib/attribution.js`）**：

| 粒度 | 依据 | 置信度 |
|---|---|---|
| 工具级 exact | 配置 `attribution.toolOwners[toolName]` 显式声明 | exact |
| 模型级 exact | 上一轮只被单一已知所有者的工具驱动 | exact |
| 模型级 shared | 上一轮由多个已声明插件共同驱动 | 共享成本，不排序、不拆百分比 |
| 未归因 | 工具名未声明 | `unresolvedReason: 'no-origin'` |

关键设计：**模型调用的成本归因到 `step - 1` 的工具集**。
因果方向是"工具结果 → 下一步模型请求"，不是同一步。同一步的归因是错的。

另外：`compaction/*` 单列 `system:compaction`，不计入任何业务插件的成本。
压缩成本是系统开销，混进业务会让"哪个插件最贵"失去意义。

---

## P-3 预算事实注入：原设计错误，架构必须改

原设计（技术方案文档）：

> 在 `agent/request` waterfall 中把 `budget_pressure` 附加到请求参数，
> 随请求进入模型上下文。

源码事实：

```ts
// dsh-agent/runtime-types.d.ts
'agent/request': (payload: { agent, turn, step, signal },
                 next: () => Promise<LlmCallConfig>) => Promise<LlmCallConfig>
// @mode waterfall
```

注释明确写着：

> this waterfall cannot mutate messages.
> Model-visible content must use logged channels.

而 `LlmCallConfig` 只有：

```ts
interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  temperature?: number
  maxTokens?: number
  stop?: string[]
}
```

→ **返回值里没有任何"上下文/消息"槽位**，改不了模型能看到什么。
原设计在架构上不成立，不是实现难度问题。

### 拆分后的双通道

| 通道 | 载体 | 能力 | 默认 |
|---|---|---|---|
| A 事实（推送） | `agent.inject(message)` + 宿主提供的 `messageFactory` | 让模型读到"预算已用 92%" | 关闭 |
| B 决策（降级） | `agent/request` 返回替换的 `LlmCallConfig` | 换 provider/model/maxTokens | 关闭 |
| C 拉取 | `ledger_query` 工具 + `ctx.ledger.snapshot()` | Agent 主动查账 | **开启** |

通道 A 的依赖倒置：插件**不猜** `UserMessage` 结构。
已核实 `UserMessage extends MessageBase { role: 'user' }`，但 `MessageBase` 的
id/content 组织与 `MessageSource.kind` 词表未逐一确认，因此由宿主注入工厂函数；
没提供工厂时 A 通道静默不可用，退化为 C 通道。宁可少一个能力，不伪造契约。

通道 B 是**真·原生能力**，代价明确：降级会改变输出质量，所以默认关闭，
且只允许用户显式配置 `budget.downgrade`。

---

## P-4（附带纠正）TokenUsage 语义

```ts
interface TokenUsage {
  inputTokens: number      // 仅未缓存输入
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}
```

源码注释：

> Counts are DISJOINT: inputTokens is uncached input only;
> cached input is reported separately.

后果（已修正计价）：

1. 原文档的单一 `cachedTokens` 字段是错的，缓存读/写必须分开。
2. 计费输入 = `inputTokens + cacheReadTokens + cacheWriteTokens`。
3. 统一价乘总量会系统性偏高，缓存命中率越高偏得越多
   → 必须是"未缓存输入/缓存读/缓存写/输出"四档单价。
4. `reasoningTokens` 已计入 `outputTokens`（适配器口径），**不重复计价**。
5. `totalTokens` 缺失时保持 `null`，不用加法冒充上游事实。

---

## C4 兼容性：首版不写回会话日志

`KNOWN_SESSION_EVENT_TYPES` 是生成的固定集合，持久化读取路径遇到集合外事件
会拒绝解析，除非事件带 `ignorable` 标记。

→ M0–M4 账本只存在于内存 + 只读快照，**不写自定义 session 事件**。
若后续要与会话日志同生命周期，必须走 `ignorable` 标记并回归读取路径，
这是独立的一笔工作（计划里 R4）。

---

## M1 复核：四处曾经的"防御式猜测"已落定

M0 阶段代码里有 4 处用可能为空的取值兜底，属于"没核实前先不崩"。M1 全部核实：

| 契约 | 结论 | 依据 | 对代码的影响 |
|---|---|---|---|
| 消息构造 | `MessageBase = { id, content: ContentBlock[], source }`，user 的 `source` 就是 `{ kind: 'user' }`；`createUserMessage({content, source})` 返回带稳定 id 的冻结消息 | `dsh-llm/lib/types/message.d.ts` L101–133、L213 | 通道 A **不再依赖宿主提供 messageFactory**，插件自己就能构造合法 `UserMessage`；只剩"运行时没装 dsh-llm"这一种降级 |
| 工具返回值 | `ToolOutputDefinition.schema` 是"对每次成功返回值强校验的 JSON Schema" | `dsh-tools/lib/types/index.d.ts` L106–113 | 返回字符串 + `{type:'string'}` 是自洽的，不是偷懒 |
| 工具参数 | `ToolSchema.parameters` 是 "JSON Schema object for the arguments" | `dsh-llm/lib/types/types.d.ts` | 直接写 JSON Schema 正确；仓库里 `defineTool({query:{type,required}})` 的 map 写法只是别的包自己的封装，不是运行时要求 |
| 服务暴露 | 仓库既有插件统一 `ctx.provide(name, api)`（`lingzhi-core` L119/L123、`lingzhi-workbench` L8641）；`ctx.set` 不存在 | 源码 grep | 已改为 `ctx.provide('ledger', api)`，去掉 try/catch 兜底 |
| 事件载荷 | `assistant/message = { turn, step, message, stream, usage? }`，**usage 在事件顶层** | `dsh-session/.../types.d.ts` L330–338 | `event.usage ?? event.message?.usage` 保留（`attempt` 事件无 usage），但主路径就是顶层 |
| agent 事件 | `agent/created = { agent, source, signal? }`；`agent/disposed = { agent }`；`session/disposed` 直接给 `session` | `dsh-agent/runtime-types.d.ts` L227–242、`dsh-session/index.d.ts` L42–52 | 订阅签名正确，无隐式包装 |
| 卸载语义 | `ctx.on` 返回 disposer；`session/disposed` 时 `store.drop(id)` | 同上 | 会话消失即释放账本，内存不跨会话累积（已加测试锁住） |

顺带修掉一处架构级坏味道：M0 里用 `store.recordEntry = wrapped` 给 store 挂预算副作用，
属于替换他人方法的 monkey patch，多实例/多插件时会互相踩。
现在改为 `createLedger({ onEntry })` 显式钩子，store 只负责存，guard 只负责判。

---

## 对性能的实测口径


事件热路径单条成本：一次 `RingBuffer.push`（O(1)）+ 若干标量累加，
无 JSON 序列化、无 async、无定时器、无数组 shift。

`scripts/bench.mjs`（`node --expose-gc scripts/bench.mjs`，本机 v22.23.4）：

| 场景 | 单事件成本 | 备注 |
|---|---|---|
| 4 会话稳定态 | 1.21 µs | 正常形态 |
| 64 会话稳定态 | 1.12 µs | 与 4 会话同量级 → 不随会话数增长 |
| 每条事件都是新会话（LRU 抖动） | 3.81 µs | 最坏情况，主要花在桶创建与淘汰 |
| 300k 事件后 heapUsed | 3.2 MB | 固定容量，不随事件数增长 |

结论：稳定态在微秒级，插件对 Agent 循环的影响是噪声量级；
真正会放大成本的是"会话高频换入换出"（3.8 µs），这不是常态。

29 个单测（含 6 会话 × 多事件）整体耗时 167ms，平均单测 < 6ms。
这不是基准测试，只是确认"没有隐藏的 O(n) 操作"。

---

## M2 冒烟（真实运行时，不是替身）

`scripts/smoke-dsh.mjs` 直接加载 `/home/user/lingzhi/node_modules/@deepseek-ai/dsh-llm`，
用真实 `createUserMessage` 构造一条预算事实消息，结果：

- `CLM-1` 导出存在；
- `CLM-2..6` 产出 `{ id: <uuid>, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }`；
- `CLM-7` 返回对象**已冻结**（`Object.isFrozen === true`）。

意义：通道 A 不需要宿主配合构造消息，插件自己就能产出可交给 `agent.inject` 的合法对象。
剩下未验证的只有两件：真实进程里 `session/event` 是否真的派发到根 ctx 监听器，
以及 `ctx.tools.register` 的 registry 是否接受本工具的 `output.schema`（需要真机 boot，M2 尾）。
