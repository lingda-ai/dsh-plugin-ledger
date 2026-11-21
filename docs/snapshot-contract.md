# 快照契约（供其它插件只读消费）

面板快照写到 `<会话工作区>/.dsh/ledger/<safeSessionId>.json`，`version: 1`，**只增字段、不删字段**。

```jsonc
{
  "version": 1,
  "generatedAt": "2026-11-21T08:02:22.500Z",
  "sessionId": "session-…",
  "sessionTitle": null,
  "totals": {
    "cost": { "amount": 0.0359, "currency": "CNY", "knownEntries": 2, "unknownEntries": 0 },
    "saved": { "amount": 1.25, "currency": "CNY" },
    "tokens": { "input": 2288, "output": 3647, "cacheRead": 4937728 },
    "entries": 2,
    "cacheHitRate": 0.9995,
    "savedShare": 0.978
  },
  "window": {              // 0.1.14+：最近 N 小时（panel.windowHours，默认 24）的增量
    "hours": 24,
    "since": 1795161742500,
    "cost": 0.035909,
    "saved": 1.250762,
    "entries": 2,
    "knownEntries": 2,
    "unknownEntries": 0,
    "currency": "CNY",
    "covered": false       // true = 窗口内条目都在；false = 环已淘汰早期条目，窗口可能不完整
  },
  "recent": [{ "at": 1795243411871, "turn": 16, "step": 14, "amount": 0.0126, "kind": "model" }],
  "peak": { "amount": 0.0182, "turn": 17, "step": 1, "model": "deepseek-flash" },
  "overview": [{ "sessionId": "…", "amount": 0.0359, "entries": 2, "lastAt": 1795243875205 }],
  "truncated": false       // true = 快照被 maxBytes 截断，合计仍可用、明细不全
}
```

## 消费方约定

1. **只读**：不写这个目录、不 import 本包；文件不在或 `version !== 1` 就当「没有这个能力」，
   不要当成 0 或报错给用户看。
2. **口径必须写清**：有 `window` 才能说「窗口增量」；只有 `totals` 时必须写明是
   **会话自开始以来的累计**。两者不可相加。
3. **`covered: false` 必须一路带出去**：它表示窗口起点之前的条目已被环形缓冲淘汰，
   下游要据此提示「窗口可能不完整」，而不是给一个看起来完整的数。
4. **未知费率不得折 0**：`unknownEntries > 0` 时，合计旁边必须保留「其中 N 条费率未知」。
5. **`truncated: true` 表示明细不全**，合计仍可信。

## 稳定性

- 新增字段只追加，语义不变；破坏性变更会提升 `version`。
- `window` 是 0.1.14 新增；更早版本没有该字段，消费方必须能降级到 `totals`。

## 参考实现

塔台（`dsh-plugin-tower`）的报告成本节就是按这份契约读的：
`readLedgerCosts()` 只读文件、双模口径、覆盖 `covered/truncated/stale`。
