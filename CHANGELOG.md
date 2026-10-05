# Changelog

本文件记录本插件的所有重要变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
