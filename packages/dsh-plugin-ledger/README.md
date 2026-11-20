# @lingda-ai/dsh-plugin-ledger

**这是分发入口，不是实现。** 真正的代码在 [`@lingda-ai/ledger`](https://www.npmjs.com/package/@lingda-ai/ledger)。

存在的唯一理由：DSH 社区插件的惯例命名是 `dsh-plugin-*`，用这个名字便于在插件市场被检索到。

## 装

```bash
dsh plugin --profile <profile> add @lingda-ai/dsh-plugin-ledger
```

装完请在 `cordis.patch.yml` 里打开面板（默认关，因为写盘是外部副作用）：

```yaml
- id: lingda-ledger
  name: '@lingda-ai/ledger'
  config:
    panel:
      enabled: true
```

> 与 `@lingda-ai/ledger` **二选一**，两个都装会重复注册同一个插件席位。
