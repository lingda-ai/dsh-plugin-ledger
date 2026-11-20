# 上报协议 v1（已冻结，未启用）

现在一条数据都不发。这个文件存在的唯一理由：**协议形状是不可逆的**。字段名一旦写进历史流水，
后面想从 `inputTokens` 改成 `measures[]`，老数据永远迁不干净。

代码：`lib/wire.js`（协议）、`lib/identity.js`（身份线索）、`lib/trace.js`（落盘行）。

## 为什么要先冻结，哪怕只有 DSH 一个来源

计划中的第二个来源（Trae / Qoder / WorkBuddy / Cursor）**大多不按 token 计费**，而是席位订阅。
如果协议主键是 token，第二类工具根本进不来。所以计量的载体必须是「单位 + 数值」：

```jsonc
// 本地流水行（.trace.jsonl，已带全部不可逆字段）
{
  "timestamp": "2026-11-19T05:52:00.000Z",
  "sessionId": "session-9f2a41",
  "turn": 2, "step": 1,
  "wireVersion": 1,
  "eventId": "9c1e4f7a2b3d8e05",          // 幂等键
  "measures": [                            // 中性计量，token 只是其中一种单位
    { "unit": "token.input",  "value": 9260 },
    { "unit": "token.output", "value": 1462 },
    { "unit": "token.cache_read", "value": 15660 }
  ],
  "deviceId": "a1b2c3d4e5f60789",
  "actor":   { "email": "lin@example.com", "source": "git-local" },
  "project": { "key": "github.com/lingdaai/dsh-plugin-ledger", "source": "git-remote" },
  "gen_ai.operation.name": "chat",
  "gen_ai.agent.name": "@lingzhi/tools/hr",
  "cost": { "amount": 0.0235, "currency": "CNY" },
  "costUnknownReason": null,
  "summary": "deepseek/deepseek-v4-pro"    // 已脱敏截断，**不上报**
}
```

## 三条硬规则

### 1. 幂等键

```
eventId = sha1(sessionId | turn | step | operation)[0:16]
```

同一会话同一 turn/step/类型只可能产生一条。双端（Desktop + 云主机）重复上报必须落成同一个 id，
服务端主键冲突即丢弃。**没有这条，账会翻倍**——而双端重复是这个产品最常见的真实场景。

### 2. 计量用 `measures[]`，不用 token 专用字段

| 单位 | 含义 |
|---|---|
| `token.input` / `token.output` / `token.cache_read` / `token.cache_write` | 按量（DSH 类） |
| `seat.month` / `seat.day` | 席位订阅（Cursor / WorkBuddy 类） |
| `request` | 按次 |
| `minute` | 按时长（云开发环境） |

值为 0 不进数组（既没成本也没信息量）。「字段缺失」与「值为 0」的区别由 `usage.complete` 承载。

**席位成本与按量成本不能加成一个「单价」**：把 $20/月的 seat 摊到 token 上，必须先假设「这个月跑了多少
token」，那个假设就是编数字。两轨各自出账，汇总时给两个数（边际成本 / 总拥有成本），并明示口径。

### 3. 上报投影走白名单，服务端结构上收不到文本

`wireEventOf(row)` 只输出：`wireVersion / eventId / timestamp / source / deviceId / actor / project /
sessionId / turn / step / operation / plugin / measures / cost / costUnknownReason`。

**不带 `summary`，不带 `gen_ai.*` 原始字段**。工具输出原文永远不出本地（只有 `contextChars` 这个数字
会进快照，且从不进流水）。

## 身份线索的优先级

| 维度 | 首选 | 兜底 | 为什么 |
|---|---|---|---|
| actor（是谁） | 仓库 `.git/config` 的 `user.email` | `~/.gitconfig` 的 `user.email` | 所有 coding agent 都在 git 仓库里工作，这个线索跨工具一致，不依赖各工具自己的登录态 |
| project（哪个项目） | git remote 归一成 `host/owner/repo` | `dir/<目录名>-<路径短hash>` | remote 跨机器、跨目录重命名都一致；兜底键**绝不带绝对路径**（用户目录结构属隐私） |
| deviceId | `~/.dsh/ledger/device-id` | `sha1(hostname\|platform\|arch)` | 换进程不变；写不了盘时仍稳定，不用随机数 |

实现细节：**只读几十字节的配置文件，绝不 fork `git config` 子进程**。解析在会话第一条事件上发生一次，
之后只有一次 Map 读。缓存有界（默认 64 个 cwd）。

## 新增一个来源要做什么

1. 写映射：把该工具的事件 → 上面那个行结构（`measures` 用对应单位，`cost` 允许 unknown）；
2. 提供身份线索：能拿到 git email / 工作区路径就给，拿不到就给 `deviceId`，**不许猜一个人出来**；
3. 复用 `wire.js` 的 `eventIdOf` / `measuresOf` / `wireEventOf`，不要自己发明幂等规则。

一个 adapter 的合理体量是 200 行左右的映射函数，重活（幂等、游标、重试、脱敏）都在共享层。

## 尚未做的部分（等验证通过再做）

- 上报客户端（读 `.trace.jsonl` → 批量 POST → 游标推进，旁路定时器，**热路径零改动**）
- 聚合服务（`POST /v1/ingest`、`events` 表、rollup、对账）
- 席位摊销的会计口径与「边际成本 / 总拥有成本」两个视图

这些都可逆，不提前垫资。先让单工具的账本被真正用起来。
