# Changelog

本文件记录本插件的所有重要变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- **`defaultDays` / `since` 现在真的减少扫描量。** 旧版注释自认「只收窄返回结果，不收窄
  扫描量」，用户设了 90 天却照样读全部——看着能用但语义骗人的配置比没有更糟。现在：
  日志版本令牌没变、且最后一次写入早于窗口下界的会话会被直接跳过而不重放。
  冷启动（本进程第一次见到某会话）拿不到时间上界，仍须读一次；这一点在文档里写明。
- **不再单独调用 `readTitleSnapshots`。** 该方法内部是
  `foldSessionTitle(events)` = `events.findLast(e => e.type === 'session/title')` 取
  `data.title`，与插件在同一份日志上顺手折出的标题完全等价，却要把每个会话的日志
  **重读一遍**。冷启动因此减半（实测 538.0 ms → 270.6 ms）。
- **存在性检查默认关闭。** 新增 `checkExists` 参数（默认 `false`）。开启后单次最多探测
  前 50 个文件，输出说明实际检查了多少个；超出预算的条目**不写 `exists` 字段**（语义是
  「未知」），而不是谎报 `false`。探测出错也返回「未知」而非「不存在」。
- **输出结构升级。** `scanned` 现在给出 `candidates` / `considered` / `replayed` /
  `reused` / `pruned` / `empty` / `failed` / `existsChecked` / `complete`，
  render 明确报出「扫描了几个、因为什么跳过了几个」以及结果是否完整。
- 包名与归属更新为 `@star-12-bytedance`（作者 star-12-Bytedance）。

### Added

- 新增 `sessionCacheSize` 配置（默认 `200`，LRU）：进程内的按会话折叠缓存，
  记录每个会话的日志版本令牌与该会话折叠出的血统。设 0 可关闭。
- 日志版本探测走**可选**的 `sessionPersistence.stat()`（只读元信息，不解压不重放），
  且只把返回的 `revision` 当相等性令牌用，不解析其内容。
- `scripts/check.mjs` 新增「读取策略检查」一档：在可控语料上断言剪枝不改变结果、
  版本变化后强制重放、活动会话不走缓存、无持久层时优雅退化、`checkExists` 默认零
  `stat` 且封顶 50。

### Fixed

- **`fs` 与 `sessionPersistence` 改用 `ctx.get(name)` 取值。** 直接硬读 `ctx.fs` 会抛
  `cannot get property "fs" without inject`；而把它们写进 `inject` 又会让缺少该服务的
  组合整个 fiber 停在 PENDING、插件无声消失。两者都会让插件在完全正常的部署里不可用。
- **恢复被遗漏的 `.github/workflows/check.yml`。** 仓库历史重建时该工作流未被纳入，
  导致 CI 实际不存在。已恢复为「先装 peer 依赖、再以 `--strict` 跑契约检查」。
- **`cordis.patch.yml` 里的包名大小写不一致**（`@star-12-Bytedance` vs `package.json` 的
  `@star-12-bytedance`）。npm 包名必须小写，不一致会让补丁在大小写敏感的平台上挂不上。

### Performance

在本机真实语料（13 个会话、解压后 25.09 MB，每场景 5 次取中位）实测：

| 指标 | 优化前 | 优化后 |
| --- | --- | --- |
| 冷启动 | 513.8 ms | 279.4 ms（≈1.8×） |
| 重复查询 | 524.0 ms | 0.9 ms（≈580×） |
| 冷启动 `readSession` 调用 | 26 | 13 |
| 标题批读引发的重复日志重放 | 26 | 0 |
| 重复查询的日志重放 | 26 | 0 |
| 默认 `fs.stat` 往返 | 134 | 0 |
| 血统命中数 | 67 | 67（逐字段一致） |

两次独立实测复现同一结论（冷启动 538.0→270.6、重复 531.5→0.8）；绝对毫秒有约 ±10%
机器噪声，重放次数与命中数一致是确定的。

## [0.1.0] - 2026-10-05

### Added

- 首个版本。
- 注册 `file_lineage` 工具，支持按 `query` / `pathPrefix` / `since` / `limit` /
  `groupBySession` 跨历史会话检索产出文件。
- 从 `tool/call` 参数推断文件血统：`pathKeys` 顶层直取，并额外解析
  `files: [{ path }]` 这种数组嵌套形状（DSH 的 `present` 就是这种）。
- 用 `callId` 关联 `tool/result`，`error` 存在的调用一律剔除；没有结果的调用
  （回合被中断）保留并在输出里标明。
- 同一会话内重复写入同一路径合并为一条并累加 `count`，同时保留最后一次的
  工具名、回合与时间。
- 会话标题来自 `readTitleSnapshots` 批量读取，失败时回退到日志里的
  `session/title` 事件；标题按单行折叠后输出。
- 通过 `ctx.fs` 把相对路径按会话 `cwd` 绝对化，并探测文件当前是否仍然存在。
- 失败按会话隔离：单个会话读失败只跳过它，不会让整次检索失败。
- `scripts/check.mjs` 契约自检，覆盖六类静默失败点。
- `cordis.patch.yml` 挂载补丁与 GitHub Actions 契约检查工作流。

### Notes

- 已在本机真实会话语料（13 个会话、51 次成功的 write/edit/present 调用）上验证
  路径抽取，并在 18 项边界用例上验证失败剔除、合并计数、嵌套路径与故障隔离。

[Unreleased]: https://github.com/star-12-Bytedance/dsh-lineage/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/star-12-Bytedance/dsh-lineage/releases/tag/v0.1.0
