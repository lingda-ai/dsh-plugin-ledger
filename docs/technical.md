# 账本（@lingda/ledger）技术文档

> 版本 0.1.0 · 代码仓 `gitee.com/linzhengtong/dsh-plugin-ledger` · 协议见 `docs/wire-format.md`
> 本文只写**为什么这么设计**和**数字怎么来的**，不写安装步骤（见 README）。

---

## 1. 问题定义

DSH 一次对话的成本不是「一条消息一个价」，而是四类互不重叠的 token 各自计价：

| 计量档 | 来源字段 | 单价（deepseek-v4-flash） |
|---|---|---|
| 未缓存输入 | `inputTokens` | 1 元 / 百万 |
| 缓存命中 | `cacheReadTokens` | 0.02 元 / 百万 |
| 缓存写 | `cacheWriteTokens` | 0（官方无独立写价） |
| 输出（含 reasoning） | `outputTokens` | 2 元 / 百万 |

宿主的 `TokenUsage` 注释明确 **counts are DISJOINT**（`@deepseek-ai/dsh-llm`），即 `inputTokens` 只含未命中部分。
这个事实决定了三件事：

1. **不能用平均价乘总数**。缓存命中的价格是未命中的 1/50，命中率越高，用平均价算出的金额错得越离谱。
2. **`cacheWriteTokens` 必须记 0 而不是"未命中价打折"**。DeepSeek 的缓存写入 token 已计入未命中输入，再给一个价就是重复计费。
3. **`reasoningTokens` 不单独计价**，它已含在 `outputTokens` 里（适配器口径）。

所以计价只有一种正确做法：**四档分开乘，再相加**。`lib/pricing.js` 的 `costOf()` 返回 `parts` 而不是单一金额，
就是因为面板必须能按四档分行显示，而费率只在 Host 进程里，浏览器半不能自己乘。

---

## 2. 三种「未知」必须区分

这是整个插件最核心的设计原则。同一个"没有数字"，有三种完全不同的含义：

| 语义 | 表示 | 面板表现 | 为什么不能混 |
|---|---|---|---|
| 真的没有 | `0` | `¥0.0000` | cacheWrite 恒为 0，是事实 |
| 算不出来 | `null` + `reason` | `— no-rate` | 费率缺失，乘任何数都是编 |
| 完全不适用 | 不出现 | 不画这一行 | 压缩条目的金额本就不该对比 |

具体契约：

- `cost` 是联合类型：`{kind:'known', amount, parts, tier}` 或 `{kind:'unknown', reason}`，**永不退化成 0**
- `reason` 有四种：`no-usage`（事件没带 usage）、`usage-incomplete`（缺输入或输出）、`no-rate`（价表没这个模型）、`no-cost`（无成本字段）
- 合计金额在**一条已知条目都没有**时返回 `null`，面板显示「未计价」而不是 `¥0.0000`
- 有未知条目时合计旁边必须写「其中 N 条费率未知，合计偏低」——否则那个数字会被当成确定值

这条原则的代价是面板会出现"不完整"的观感，收益是：**一个敢说"我不知道"的账本，才配被拿去做决策。**

---

## 3. 缓存节省额：唯一能严格算出来的「省了多少钱」

### 3.1 数学

同一份 token，命中与未命中的差价是确定的：

```
saved = cacheReadTokens × (rate.input − rate.cacheRead)
      = 15,660 × (1 − 0.02) 元/百万
      = ¥0.0153
```

两个单价都在同一张价表里，**不需要任何假设**。这是账本里唯一一笔可以这样算出来的收益。

### 3.2 为什么压缩节省不给金额

压缩省下的是上下文 token（`contextBeforeTokens − 后续 input+cacheRead`），但**省下的那部分 token 属于"命中"还是"未命中"无法推断**：

- 压缩后第一次请求的命中率会被整体重算（摘要不再命中旧前缀）
- 省下的 token 若原本是缓存命中，价值只有 0.02 元/百万；若是未命中，是 1 元/百万
- 两者差 50 倍，硬乘任一个单价都是编数字

所以压缩只报 token 差（`压缩前 42.0k` / `↓省 24.0k`），**不折算金额**。这条边界写进了代码注释和 README。

### 3.3 占比

面板显示 `缓存命中已省 ¥0.0153 · 占应花 25.1%`：

```
savedShare = saved / (实花 + saved)
```

分母是「假如没有缓存本来要花的钱」。占比比绝对值有感知力——"省了三分之一"比"省了 1 分钱"更能让人相信缓存值得开。

`amount` 为 `null` 或 `≤ 0` 时整行不画，不写「已省 ¥0.0000」。

---

## 4. 处理链路与时序

```
宿主 session/event（post-commit 广播）
        │
        ├─ ledger.onSessionEvent(session, event)
        │      ├─ normalizeUsage()        归一 usage（disjoint 语义）
        │      ├─ pricing.costOf()        四档计价 → known | unknown
        │      ├─ pricing.savingsOf()     缓存节省额
        │      ├─ attribution.forStep()   归因到插件
        │      ├─ store.note()            入环形缓冲 + 累加 totals
        │      ├─ guard.onEntry()         预算回滞判定
        │      └─ trace.project()         脱敏 + 不可逆字段（可关）
        │
        ├─ publisher.schedule(sessionId)  节流落盘（默认 3s）
        │      └─ buildPanelPayload() → <cwd>/.dsh/ledger/<safe>.json
        │
        └─ 浏览器半：workspaceFiles.read() → renderPayload() → 面板
```

关键点：**所有订阅都在 post-commit 之后**，任何一环抛错都不会影响 Agent 主流程（`trace` 层全程 try/catch，
`ledger` 用 `failures` 计数而不是抛出）。

### 4.1 数据通道为什么落文件

浏览器半与 Host 是两个进程。已验证的事实（`docs/spikes.md` C-1..C-3）：

- 浏览器侧不能直接读 `ctx.ledger`（跨进程）
- 自定义 Typert remote 需要生成产物 + zod 校验，纯 JS 仓库不划算
- `workspaceFiles` remote 可用：`list / stat / read(sessionId, absolutePath, range)`，相对路径以 Session 的 `cwd` 为基准

所以通道是「Host 落 JSON → 浏览器读回」。代价是面板数据有一个节流窗口（默认 3 秒），
收益是零自定义协议、零握手、断线仍能显示最后一帧。

---

## 5. 幂等与身份：三件不可逆的事

现在一条都不上报，但以下三项在采集时就写入（`docs/wire-format.md`），因为它们是**事后补不回来**的：

### 5.1 幂等键

```
eventId = sha1(sessionId | turn | step | operation)[0:16]
```

同一会话同一 `turn/step/类型`只可能产生一条事件。这条设计的唯一目标是应对**双端重复上报**
（Desktop + 云主机同时跑同一会话）——没有幂等键，金额会翻倍，而双端是这个产品最常见的真实场景。

### 5.2 中性计量

```
measures: [{unit:'token.input', value:9260}, {unit:'token.cache_read', value:15660}]
```

token 只是 `measures` 里的一种单位。计划中的第二个来源（Trae / Qoder / WorkBuddy / Cursor）多数**按席位订阅**，
没有 token 成本。单位表预留：`seat.month` / `seat.day`（席位）、`request`（按次）、`minute`（按时长）。

值为 0 不进数组（既无成本也无信息量），"缺字段"与"值为 0"由 `usage.complete` 区分。

### 5.3 身份线索

| 维度 | 首选 | 兜底 |
|---|---|---|
| `actor` | 仓库 `.git/config` 的 `user.email` | `~/.gitconfig` 的 `user.email` |
| `project` | git remote 归一成 `host/owner/repo` | `dir/<目录名>-<路径短hash>` |
| `deviceId` | `~/.dsh/ledger/device-id` | `sha1(hostname\|platform\|arch)` |

用 `git user.email` 的理由：所有 coding agent 都在 git 仓库里工作，这个线索跨工具一致，
**不依赖各工具自己的登录态**（Trae/Qoder 未必给你账号）。

实现上有两条硬约束：

1. **绝不 fork `git config` 子进程**。只同步读 `.git/config` 与 `~/.gitconfig` 两个几十字节的文件。
2. **绝不把绝对路径写进账本**。无 remote 时用 `dir/<basename>-<sha1(cwd)[:6]>`，hash 不可逆但稳定。

解析只发生在会话第一条事件（`identityBySession` 缓存），`session/disposed` 时释放。

---

## 6. 归因模型：为什么只认同轮上一步

`attribution.toolOwners` 把工具名映射到插件（唯一可得的归因依据）。默认按当前 step 的工具调用归因，
且**只认同一轮的上一步**（`store.toolsForStep(sessionId, turn, step − 1)`），跨轮不继承。

理由：模型调用发生在工具结果之后，归因链是「模型这次读了谁的结果」。上一步是对的；
再往前追是猜测——你无法证明第三步的模型调用是因为第一步的工具结果。

面板上因此有「多个插件共同（拆不开）」这一桶：一次调用读了 3 个插件的工具结果时，金额按结果体积分摊，
但标注为不可精确归因。

---

## 7. 性能设计

用户对性能的要求是硬约束：**热路径不许 IO、不许分配**。

### 7.1 环形缓冲

`store` 每会话保留固定容量（默认 2000 条），满了覆盖最旧一条。容量与事件数无关，
所以内存是**有界**的，不随会话变长而增长。`ring.js` 是纯数组 + 双指针，不用 `Array.shift()`（O(n)）。

### 7.2 零分配热路径

踩过的一个坑：`trace.project()` 的参数是一个 15 字段对象字面量，**即使 trace 关闭也会构造**。
改为 `trace.enabled ? trace.project({...}) : null` 后：

| 场景 | 短路前 | 短路后 |
|---|---|---|
| 4 会话 / 20 万事件 | 1.76 µs | **1.35 µs** |
| 64 会话 / 20 万事件 | 1.41 µs | **1.28 µs** |
| 无限新会话（触发 LRU 淘汰） | 5.09 µs | **3.8 µs** |
| 单会话 1 万条 | 1.76 µs | 1.88 µs |

长会话略慢的 0.12µs 是身份与压缩字段的代价，仍在 8µs 阈值内。另一处优化：`pendingCompaction.size === 0`
时直接跳过 Map 访问，长会话从 2.37µs 回到 1.88µs。

### 7.3 实测基线（`node --expose-gc scripts/bench.mjs --gate`）

```
4 会话 / 混合同步事件     1.35 µs/event
64 会话 / 混合同步事件    1.28 µs/event
无限新会话                3.8  µs/event
单会话 1 万条             1.88 µs/event   heap 增量 4.4 MB
300k 事件后留存            3.7 MB（强制 GC 后）
```

> 门禁必须带 `--expose-gc`。不带的话测到的是未回收垃圾（同一次跑能测出 42MB），
> 会把"GC 还没跑"误判成泄漏。

门禁阈值：稳定态 <6µs、LRU 抖动 <15µs、长会话 <8µs 且 <20MB/万条、留存 <32MB。

---

## 8. 面板的信息架构

自下而上四层，每层回答一个问题：

| 层 | 内容 | 回答 |
|---|---|---|
| 合计 | 总额 + 条数 + 偏低提示 + 缓存已省 | 这次会话贵不贵 |
| 预算 | 进度条 + 「已用 92% · 还可约 5 次」 | 还能问几次 |
| 四档 | 未缓存/命中/写/输出 + 命中率 | 钱花在哪一类 token |
| 谁花的 | 插件来源 + 占比（>6 个才出现「展开」） | 哪个插件在偷 |
| 最近 | 时间 + 轮次 + 金额 + `↑18.4k 字符` / `压缩前 42.0k` / `↓省 24.0k` | 哪一步、为什么贵 |
| 其他会话 | 跨会话对比 + 脚注（价表日期） | 别的会话什么水平 |

设计约束：

- **300px 极窄下必须能用**，所以明细第二行用 ellipsis 且把"为什么贵"的信息放最前（体量），归属放最后
- **「还能问几次」用 `knownEntries` 算均价**，未知条目不进均价，否则会把"还能问 8 次"算成"还能问 3 次"
- 余量为 0 时写「余量不足一问」，不写「还可约 0 次」

---

## 9. 验证手段

| 手段 | 覆盖 | 产出 |
|---|---|---|
| `node --test test/*.test.mjs` | 158 例断言 | 计价、归因、预算回滞、幂等、身份、卸载残留、面板 SSR |
| `scripts/bench.mjs --gate` | 热路径 + 内存 | 上表数字 |
| `scripts/smoke-registry.mjs` | 插件装配契约 | 假 ctx 下工具注册/提供不抛 |
| `scripts/smoke-dsh.mjs` | 宿主契约 | 右栏 tab、seat、事件形状 |
| `scripts/smoke-panel.mjs` | 面板链路 | PANEL-1..10：落盘 → 读回口径一致 |
| `scripts/render-panel.mjs` | 视觉 | 真实 `renderPayload()` 输出，三列宽度 |

**SKIP 不等于通过**：冒烟脚本找不到 DSH 运行时用退出码 2 表示 SKIP，`prepublish.sh` 第 6 步把 SKIP 判 FAIL。
这条是为了避免"换台机器 CI 照样全绿，但契约一条没验"。

---


## 10. 费率覆盖：把"算错钱"变成可见事件

内置价表带一个固定基准日（`BUILTIN_AS_OF`）。厂商一调价，所有用户看到的金额就**静默地**错了——
这是成本类产品最危险的一种错：数字还在，看起来还挺精确。`pricing.json` 解决的就是这件事。

**为什么整条生效或整条拒绝，不逐档合并。**
四档费率（`input` / `output` / `cacheRead` / `cacheWrite`）共同定义一个模型的价格语义。缺一档就合并，
等于拿旧价补新价——最终数字既不是旧价也不是新价，而且没有任何痕迹说明它是混合出来的。
所以校验失败时整条进 `rejected`：该模型 `costOf()` 返回 `unknown(no-rate)`，面板显示 `—`，
而不是一个"看起来像真的"数字。

**为什么 boot 时读一次，不 watch 文件。**
计价发生在每条 `assistant/message` 的热路径上，热路径不做 IO 是硬约束（见第 7 节）。
代价是改完费率要重启会话。这个代价换的是"每一笔计价都稳定"——而计价不稳定，
比多等一次重启危险得多。

**为什么失败也要显形（这是本节的重点）。**
"文件写坏了 → 静默回退内置价 → 面板照常显示金额"，看起来是个体贴的降级，
实际上是在骗人：用户以为自己调过价了，拿着错数字去做判断。所以 `pricingMetaOf()` 对三种状态
**都**产出元信息（`kind:'file'` / `kind:'builtin'` / `kind:'builtin'` + `error`），面板据它在顶部画
琥珀色警示条，页脚只留"现在按什么价算"。信息层级是刻意的：异常在上，来源在下，
不把原因塞进 10.5px 的灰字里。

**自查出口。** `ledger_query` 的 `op: 'rates'` 返回当前生效表（还原成元/百万，和官方公告同单位）、
来源与基准日、被忽略的模型及原因码（`fields-missing` / `field-invalid` / `negative` / `bad-json` / …）。
这样"我改了价但数字没变"有了一条可查证的路径，不会变成悬案。

---

## 11. 已知限制

1. **归因只到插件级**：宿主不提供工具归属信息，跨轮不继承。
2. **面板数据有 3 秒节流**：故意如此，热路径不落盘。
3. **内置价表带固定基准日** `2026-11-19`：厂商调价可写 `~/.dsh/ledger/pricing.json` 覆盖，
   无需改代码；写坏了会在面板顶部警示而不是静默回退。仍是"人工提供价格"，不假装实时。
4. **`private: true` 未改**：npm registry 未定。代码仓已在 Gitee。
5. **未真机验证五项**（`ctx.tools.register` 真注册、真进程全量派发、`ctx.provide` 冲突、
   宿主是否真给 `ctx.slots`、插件侧 `workspaceFiles` 权限）——都需能 boot DSH 且带凭据的进程。
6. **团队版零代码**：身份、上报、聚合、对账均未开工（有意为之，见商业计划书）。

---


## 12. 真机作为最终裁判：四处被单测掩盖的偏差

第一次把插件装进真实宿主跑通之后，暴露了四个单测没有任何办法发现的问题。
本节留档不是为了追责，而是因为**同一个错误模式还会再犯**：用自己假设的契约写测试，
测试全绿，线上全空。

**12.1 `session/event` 的载荷在 `data` 里。**
类型声明写的是扁平 `{turn, step, message}`；运行时实际派发
`{type, seq, time, data: {turn, step, message, usage, stream}, surfaceOp}`。
后果是灾难性的安静：每条模型调用都记成 `unknown(no-usage)`、金额整片 `null`，
而 158 例单测依然全绿——因为它们喂的是扁平形状。
修法不是二选一，而是两种都认（`payloadOf()`：`data` 是普通对象就用它，否则退回事件本身），
并用真机抓到的原始事件建立一个专门的 `event/shape` 测试文件固定它。

**12.2 金额精度不能吞掉小额。**
单步模型调用常在 1e-5 量级，缓存命中那一档只有 `3.2e-5` 元。`toFixed(4)` 把它显示成
`¥0.0000` —— 用户读到的是"这一步没花钱"。这和"未知显示成 0"是同一类错误：
**显示一个不存在的 0，就是撒谎。** 改为按量级自适应（<0.001 给 6 位，<1e-6 给科学计数）。

**12.3 `generatedAt` 类型不一致。**
`store.snapshot()` 给 `Date.now()` 数字，面板按字符串截取显示。真机上页脚是
"快照生成于 —" —— 数据明明在，看起来却像坏了。在快照组装层统一转 ISO，让消费方只面对一种类型。

**12.4 同一块面板两套时间口径。**
页脚用 UTC 的 ISO（`07:35`），明细行用本地时间戳（`15:35`）。差 8 小时，用户只会以为数据错。
新增 `formatLocalTime()`，一律本地时区——**同一个面板里只能有一套时间口径**。

### 工程侧的一条硬约束

`dsh plugin --profile <p> add file:<path>` 是 pnpm 的 `file:` 依赖：**文件硬链接、目录复制**。
所以改已有文件即时生效，**新增文件不会同步**，重装才能看到。
副作用是反的也要小心：直接改 profile 里的副本，等于在改源仓库（同 inode）。
症状是启动告警 `failed to import`。

---

## 附：文件职责

```
lib/index.js          装配、取数、清理（session/disposed 统一释放 guard/store/publisher/ledger）
lib/ledger.js         事件订阅 → 归一 → 计价 → 归因 → 入账；压缩对照与身份缓存
lib/store.js          环形缓冲、totals 累加、跨会话 overview、trace 窗口
lib/pricing.js        四档计价 + 缓存节省额；未知一律返回 reason
lib/pricing-table.js  内置官方价（含来源与日期）
lib/pricing-file.js   pricing.json 覆盖：元/百万入、整条校验、失败留痕（boot 读一次）
lib/attribution.js    工具 → 插件映射，同轮上一步归因，不可归因分桶
lib/guard.js          预算回滞（超阈值只投递一次，ratio < 0.9×阈值才重新武装）
lib/budget-message.js 预算消息文案（降级建议）
lib/snapshot-file.js  快照构建/压缩/落盘/读回；withPanelTotals 派生字段
lib/panel-view.js     纯展示函数 + 组件工厂（renderPayload 为纯函数，可 SSR 断言）
lib/client.js         浏览器半入口：createFetchView / apply
lib/panel-path.js     安全文件名与目录解析
lib/trace.js          脱敏 + 不可逆字段落盘
lib/trace-file.js     JSONL 缓冲写盘（队列有界，满了丢最旧并计数）
lib/wire.js           上报协议（measures/幂等键/白名单投影）
lib/identity.js       actor/project/deviceId 线索（不 fork 子进程）
lib/tool-size.js      工具结果体积（只数 text 块）
lib/usage.js          usage 归一（disjoint 语义）
lib/ring.js           定容环形缓冲
```
