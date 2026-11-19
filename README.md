# @lingda/ledger

DSH 运行时账本插件（生态发布名 `dsh-plugin-ledger`，中文名「账本」）。

代码仓：`dsh-plugin-ledger`（独立仓库，不放在 `lingzhi` 单仓的 `packages/` 下）。
DSH 侧以外部插件方式接入：`dsh.bundle.patch` 指向本仓库的 `cordis.patch.yml`，
`dsh.client` 声明浏览器半的注入依赖。

旁路观测 Agent 的 token 与成本，并把"超预算"变成对下一次请求的**决策**，
而不是对本次请求的**污染**。

## 三条铁律

1. **采集只订阅**：不改 session/event、不 emit、不在关键路径上做重活。
2. **决策只改配置**：只经 `agent/request` 返回替换的 `LlmCallConfig`，
   不在工具执行中途中断。
3. **未知即未知**：费率缺失、用量不全、工具来源不明，一律显式返回 unknown
   及原因，**绝不用 0 或估算值填坑**。

## 架构

```
session/event (post-commit, fire-and-forget)
        │  根 ctx 订阅（agent scope 会被过滤，故不能挂 agent 内）
        ▼
   lib/ledger.js  ── 归一化 usage → 计价 → 归因 → 入账
        │                    │          │
        │              lib/pricing.js   lib/attribution.js
        ▼                    │          │
   lib/store.js  ◄───────────┴──────────┘
   （每会话双环 + 增量聚合 + LRU 会话淘汰）
        │
        ├──► lib/guard.js ──► agent/request（只改 LlmCallConfig，默认关）
        │                 └──► agent.inject（用 createUserMessage 自造事实，需配 budget.limit）
        └──► lib/audit-tool.js（ledger_query，Agent 主动查账，默认开）
                 └──► lib/client.js（M5：侧栏面板，只读快照）
```

## 对外接口

```js
// Host 半：插件通过 ctx.provide 暴露只读账本服务
ctx.ledger.snapshot(sessionId, { lastN })   // 冻结快照：totals / topSources / recent / trace
ctx.ledger.totals(sessionId)                // 只要累计
ctx.ledger.stats()                          // { handled, failures, sessions }
ctx.ledger.config                           // 生效配置（已合并默认值）

// 模型半：工具
ledger_query({ sessionId, lastN? })          // 人类可读摘要，未知成本显示"未知(原因)"
```

`snapshot` 返回的对象是被冻结的，面板可以放心持有，不用担心被采集路径改写。

## 性能

`node --expose-gc scripts/bench.mjs`（本机 v22.23.4）：

| 场景 | 单事件成本 |
|---|---|
| 4 会话稳定态 | 1.21 µs |
| 64 会话稳定态 | 1.12 µs |
| 每条事件都换新会话（LRU 抖动，最坏） | 3.81 µs |
| 300k 事件后 heapUsed | 3.2 MB（有界） |

稳定态是微秒级、且与会话数无关；唯一会放大成本的是会话高频换入换出。


## 模块

| 文件 | 职责 | 关键点 |
|---|---|---|
| `lib/index.js` | 插件入口、事件接线、服务暴露 | `apply(ctx, config)`，纯 ESM |
| `lib/config.js` | 默认值与合并 | 改变行为的开关默认关闭 |
| `lib/usage.js` | TokenUsage 归一化 | 计数 disjoint，`totalTokens` 缺失不伪造 |
| `lib/pricing.js` | 四档单价计价 | 缓存读/写分价；无费率返回 unknown |
| `lib/ring.js` | 有界环形缓冲 | O(1) 写入，无 shift |
| `lib/store.js` | 会话账本与聚合 | 双环 + LRU + 已知/未知分离 |
| `lib/attribution.js` | 归因 | 仅 exact / shared / unresolved 三态 |
| `lib/ledger.js` | 采集 | 归因取 `step-1` 工具集（因果方向） |
| `lib/guard.js` | 预算守卫 | 双通道 + 回滞，只在跨阈值投递一次 |
| `lib/trace.js` | 行为流水 | OTel `gen_ai.*` 命名 + 默认脱敏 |
| `lib/audit-tool.js` | `ledger_query` | 返回摘要而非原始 JSONL |
| `lib/client.js` | 浏览器半 | M0 为空，保证可加载可卸载 |

## 配置示例

```yaml
ledger:
  capacity: 2000        # 每会话条目上限
  maxSessions: 64       # 会话 LRU 上限
pricing:
  currency: CNY
  rates:
    deepseek/chat:
      input: 0.000001
      output: 0.000002
      cacheRead: 0.0000002
      cacheWrite: 0.0000012
budget:
  limit: 5              # null = 不启用
  threshold: 0.8
  downgrade: null       # {provider, model, maxTokens}；显式配置才生效
attribution:
  toolOwners:
    food.query: plugin-food
    kb.search: plugin-kb
trace:
  enabled: false        # 隐私优先，默认关
  capacity: 5000
  maxTextLength: 200
```

## 已知边界（不要绕过）

- **工具级归因无法自动获得**：`tool/call` 无来源字段、`tools/change` 无载荷、
  `register` 签名不带来源。只能靠 `attribution.toolOwners` 声明。
  详见 `docs/spikes.md` P-2。
- **不能在 `agent/request` 里改上下文**：返回类型是 `LlmCallConfig`，
  源码注释明确 "cannot mutate messages"。
- **首版不写回会话日志**：`KNOWN_SESSION_EVENT_TYPES` 是固定集合，
  集合外事件会阻断持久化读取，除非带 `ignorable`。

## 开发

```bash
node --test test/*.test.mjs    # 38 例
npm run bench                  # 热路径基准（需 --expose-gc）
bash scripts/ci.sh             # 等价 CI：单测 + 性能门禁 + 契约冒烟
```

CI（`.github/workflows/ci.yml`）：Node 18/20/22 三档跑单测，仅 Node 22 跑性能门禁，
阈值只拦数量级劣化（稳定态 >6µs、会话抖动 >15µs、heap >32MB 才失败）。

`scripts/smoke-dsh.mjs` 用**真实** `@deepseek-ai/dsh-llm` 构造一次预算消息，
验证 `createUserMessage` 的契约；没装运行时时自动 SKIP 而不是失败。
这是唯一"必须真机才有意义"的检查，所以不放进单测。

`scripts/smoke-registry.mjs` 用**真实** `@deepseek-ai/dsh-tools` 的三个校验器
（`assertSupportedJsonSchema` / `assertObjectJsonSchema` / `validateJsonSchemaValue`）
验证工具定义，并真跑一次 `execute` 确认返回值能通过自己声明的 schema。

## 开发期挂载（不 install、不改 profile）

`mount/ledger-dev.overlay.yml` 是可直接叠加的 patch 层：

```bash
dsh --profile <已有profile> --patch <仓库>/mount/ledger-dev.overlay.yml
```

已实测：loader 会把 overlay 里的绝对路径规范化为 `file:///...` 再装配，
所以开发期不需要把插件装进 profile 的 `node_modules`。
先 `--dump-config` 看装配结果，确认 `lingda-ledger` 那一条在那里。


零构建、零运行时依赖：不 import 任何 `@deepseek-ai/*` 做业务逻辑；
唯一例外是预算事实要用的 `createUserMessage`，走可选 peer + 动态 import，
拿不到就自动降级为"只经 ledger_query 拉取"。

## 里程碑

- M0 骨架 + 计价/归因/存储/守卫/工具 + 探针报告 ✅
- M1 契约核实 + 装配集成测试 + 热路径基准 ✅（4 处猜测全部落定，见 `docs/spikes.md`）
- M2 `ledger_query` / `ctx.ledger` 真机接入 DSH 进程
- M3 行为流水落盘（含 `ignorable` 事件回归）
- M4 面板只读快照 + 成本 Top
- M5 侧栏「成本」Tab 与设置卡片

