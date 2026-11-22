# 账本 · Ledger

[![ci](https://github.com/lingda-ai/dsh-plugin-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/lingda-ai/dsh-plugin-ledger/actions/workflows/ci.yml)

DSH 右侧栏的**会话成本仪表**：这次会话花了多少、花在哪一步、还能问几次。

> 安装包：`@lingda-ai/dsh-plugin-ledger` · 源码镜像：[GitHub](https://github.com/lingda-ai/dsh-plugin-ledger) · [Gitee](https://gitee.com/linzhengtong/dsh-plugin-ledger)

## 30 秒上手

```bash
dsh plugin --profile <你的 profile> add @lingda-ai/dsh-plugin-ledger
```

装完打开右侧栏的「**账本**」标签页即可；空白右栏的引导页里也有入口。

```
┌ 账本  会话 sessio…615                     复制摘要  刷新 ┐
│ ¥0.1083  8 次调用 · 归因无信号 · 约 10.8 分               │
│ 缓存已省 ¥4.8390 · 如未命中需 ¥4.9473（少花 97.8%）       │
│ 未设预算 · 加 budget: { limit: 0.5 } 可显示"还能问几次"   │
├──────────────────────────────────────────────────────────┤
│ 未缓存输入  2,288 tok                            ¥0.0023  │
│ 缓存命中    4,937,728 tok · 几乎全命中            ¥0.0988  │
│ 输出        3,647 tok                            ¥0.0073  │
├──────────────────────────────────────────────────────────┤
│ 谁花的  共 1 个来源                                      │
│ 未归因                               ¥0.1083  100.0%     │
├──────────────────────────────────────────────────────────┤
│ 最近                    最贵 T20·S32 ¥0.0154 · 占 14.2%  │
│ 15:09 模型 T20·S28  616k tok · 工具结果 1,264 字符  ¥0.0133│
│ 15:09 模型 T20·S29  616k tok · 工具结果   397 字符  ¥0.0127│
└ 快照 15:11:52 · 40 分钟前 · 按自定义费率估算 · 2026-11-20 ┘
```

## 面板在说什么

| 位置 | 含义 |
|---|---|
| `¥0.1083 · 8 次调用` | 本会话累计金额与模型调用次数 |
| `约 10.8 分` | 同一个数换成人民币角分，四位小数对人太细 |
| `缓存已省 ¥4.8390` | 缓存命中相对未命中单价省下的钱（严格相减，见下） |
| **四档** | 未缓存输入 / 缓存命中 / 缓存写 / 输出，各按各的单价算 |
| `谁花的` | 按插件归因的来源桶；`未归因` 表示宿主没给来源信号 |
| `最近` | 最近几次模型调用，带该步工具结果的字符量 |
| 页脚 | 快照时间、距今多久、按哪套费率算的、费率表日期 |

## 怎么读这些数字

**1. 四档分开算，不给平均价。**
同一份 token，命中与未命中差几十倍。把四档压成一个平均单价，算出来的数字既不是这档也不是那档。

**2. 缓存省下的钱是严格算出来的。**
`saved = cacheReadTokens × (input 单价 − cacheRead 单价)`，两个单价在同一张表里，差额是确定值。
这是账本里唯一能这样算的"省了多少钱"。

**3. 未知永远显示成未知。**
费率缺失显示 `— no-rate`，面板会写「其中 N 条费率未知，合计偏低」，**不会用 0 或估算值填坑**。
一个敢说"我不知道"的账本，才配用来做决策。

**4. 压缩省下的上下文只报 token，不折钱。**
省下的 token 属命中还是未命中无法可靠推断，硬乘单价就是编数字。

## 设置

```yaml
# profile 的插件配置里
panel:
  enabled: true        # 默认开：关掉会让"装完打开面板看到没数据"
  dir: .dsh/ledger     # 相对会话工作区根
  intervalMs: 3000     # 同会话两次落盘的最小间隔
  maxBytes: 262144     # 超限降级为合计 + Top 来源
  windowHours: 24      # 快照附带「最近 N 小时」的增量
budget:
  limit: 0.5           # 配了才显示"还能问几次"
  threshold: 0.8
archive:
  enabled: true        # 会话结束追加到 ~/.dsh/ledger/archive/<日期>.jsonl，默认留 90 天
trace:
  enabled: false       # 行为流水，隐私优先默认关
```

**官方调价了怎么办**：写一份覆盖文件，不用改代码、不用等新版本。

```bash
cat > ~/.dsh/ledger/pricing.json <<'JSON'
{ "asOf": "2026-12-01",
  "rates": { "deepseek-v4-flash": { "input": 1.2, "output": 2.4, "cacheRead": 0.03, "cacheWrite": 0 } } }
JSON
```

- 单位是**元 / 百万 tokens**（与官方公告一致）；
- **四档必须齐，整条生效或整条拒绝**——缺一档就拿旧价补新价，算出来既不是旧价也不是新价；
- 写错了不会静默回退：面板顶部会出现琥珀色警示，说明金额仍按内置价计算。

## 隐私

- 快照只含 **token 数与金额**，不含任何对话内容；
- 快照文件在工作区 `.dsh/ledger/<会话>.json`，单文件 ≤256KB，原子写，**会话结束即删**；
- 历史归档默认只写 token 与金额，`actor`（git email）默认不写；
- 行为流水（`trace`）默认关闭——它才可能包含工具名与参数摘要。

## 已知限制

- **归因只到插件级**：宿主不提供工具来源字段，只能靠 `attribution.toolOwners` 声明映射。
- **压缩省下的上下文不折钱**：只报 token 差。
- **内置价表的日期是 2026-11-19**，厂商调价后用 `pricing.json` 覆盖，面板脚注会显示这个日期，不假装"实时"。
- **面板数据来自 Host 落盘快照**：刚重启、或恰好没有模型调用时，面板会显示"还没有成本快照"，
  下一次调用后自动出现（轮询 5 秒）。

## 卸载

```bash
dsh plugin --profile <你的 profile> remove @lingda-ai/dsh-plugin-ledger
rm -rf ~/.dsh/ledger          # 可选：删掉归档与费率覆盖
```

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/technical.md`](docs/technical.md) | 模块职责、性能、对外接口、构建与真机验证方法 |
| [`docs/snapshot-contract.md`](docs/snapshot-contract.md) | 快照 JSON 契约（供其它插件只读消费） |
| [`docs/wire-format.md`](docs/wire-format.md) | 计量协议与身份字段（不可逆部分） |
