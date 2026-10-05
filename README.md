# dsh-lineage

> DeepSeek Harness (DSH) 插件的**跨会话文件血统检索**。
> 你记得让 DSH 做过那份文档，但不记得存哪了；你看到桌面上一个文件，想知道它是哪次会话留下的——
> 这个插件回答的正是这两问。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

---

## 它解决什么问题

DSH 的会话历史里躺着一条完整的事实：**哪个会话、哪个回合、用哪个工具、写到了哪个绝对路径**。
但这些事实散在几十上百个会话日志里，模型和用户都拿不到，于是每次都得靠猜路径、重新
`ls` 整个目录，或者干脆重做一遍。

`dsh-lineage` 注册一个 `file_lineage` 工具，把历史会话里的**文件写入调用**折成一张血统表：

- 「那个文件在哪？」→ 按文件名/路径片段跨会话检索，给出**绝对路径**。
- 「这个文件哪来的？」→ 给出**会话 id、会话标题、回合、工具名、写入次数、时间**，以及文件现在**是否还在**。

不需要索引、不需要网络、不写任何工作区文件：检索时直接读会话日志。

## 真实观测示例

下面是在一台真实机器上、对其全部 13 个历史会话执行 `file_lineage` 的**原样输出**
（`query: "dsh-llm-profile"`）：

```
找到 10 条血统记录（扫描 13/13 个会话，自 2026-07-07T13:26:02.910Z 起）：
C:\dev\dsh-llm-profile\.gitattributes
  2026-10-05T13:21:22.868Z · write×1 · 回合 13 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\CHANGELOG.md
  2026-10-05T13:21:15.498Z · write×1 · 回合 13 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\.github\workflows\check.yml
  2026-10-05T13:21:15.480Z · write×1 · 回合 13 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\scripts\check.mjs
  2026-10-05T13:21:07.342Z · edit×2 · 回合 13 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\package.json
  2026-10-05T13:20:59.832Z · edit×3 · 回合 13 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\README.md
  2026-10-05T13:20:50.370Z · write×1 · 回合 13 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\.gitignore
  2026-10-05T13:20:42.088Z · write×1 · 回合 13 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\LICENSE
  2026-10-05T13:20:42.055Z · write×1 · 回合 13 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\index.js
  2026-10-05T13:20:34.813Z · edit×6 · 回合 13 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\cordis.patch.yml
  2026-10-05T13:17:32.313Z · write×1 · 回合 13 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
```

一眼可见的三件事：

1. **绝对路径直接可用。** 会话日志里记的是 `file_path` 参数，插件按该会话的 `cwd` 绝对化后给出。
2. **`edit×6` / `edit×3` 是合并后的次数。** 同一会话内对同一路径的重复写入折成一条并计数，
   工具名与时间取**最后一次**——也就是「这个文件最后是被谁动的」。
3. **同一路径出现在两个会话里就是两条记录。** `C:\dev\dsh-lineage\index.js` 在本次检索中
   出现在两个不同会话下，因为这确实是两个会话各自写过的——血统不该被抹掉。

再举一个「找文件」的例子，`query: ".md"` 会连带标出**已经被删掉**的产出：

```
找到 3 条血统记录（扫描 13/13 个会话，自 2026-07-07T13:26:02.910Z 起）：
C:\dev\dsh-llm-profile\CHANGELOG.md
  2026-10-05T13:21:15.498Z · write×1 · 回合 13 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\README.md
  2026-10-05T13:20:50.370Z · write×1 · 回合 13 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\Users\lenovo\OneDrive\Desktop\dsh-plugin-recon.md  [文件已不存在]
  2026-10-05T11:47:05.942Z · write×1 · 回合 1 · 会话 6bda2e7c-baf6-4fc8-85f6-d00bfe544250 · You are researching how to
```

## 功能

| 能力 | 说明 |
| --- | --- |
| 跨会话检索 | 一次查询覆盖全部历史会话，不只是当前会话 |
| 绝对路径 | 用**产出它的那个会话**的 `cwd` 解析相对路径，而不是用当前工作目录 |
| 完整血统 | 会话 id、会话标题、回合、工具名、写入次数、ISO 时间戳 |
| 存在性 | 逐条探测文件现在是否还在，已删除的明确标注 |
| 失败剔除 | `tool/result` 带 `error` 的调用一律不计入血统 |
| 重复合并 | 同会话同路径的多次写入合并计数，保留最新一次的工具/回合/时间 |
| 嵌套路径 | 既认 `{ file_path }`（`write`/`edit`），也认 `{ files: [{ path }] }`（`present`） |
| 故障隔离 | 单个会话读失败只跳过它，绝不让整次检索失败 |
| 按会话分组 | `groupBySession: true` 时额外给出「哪次会话产出了这批文件」 |
| 完全只读 | 不写任何文件、不建索引、不访问网络 |

## 安装

```bash
dsh plugin --profile <你的profile> add @xinghe-source/dsh-lineage
```

或从本地目录安装（开发用）：

```bash
dsh plugin --profile <你的profile> add /absolute/path/to/dsh-lineage
```

装完**先核对配置层再启动**，否则容易把「没挂载」误判成「插件有 bug」：

```bash
dsh --profile <你的profile> --dump-config   # 确认能看到 lineage 这一行
dsh --profile <你的profile>
```

## 使用

插件注册一个工具 `file_lineage`，直接让模型调用即可，参数全部可选：

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `query` | string | — | 文件名或路径的片段，大小写不敏感（如 `"steam"`、`"报告.docx"`、`"Desktop"`）。留空返回窗口内全部产出 |
| `pathPrefix` | string | — | 只返回绝对路径以此前缀开头的条目，大小写不敏感（如 `"C:\\dev"`） |
| `since` | string | 见 `defaultDays` | ISO 8601 时间戳，只返回此时间之后写入的文件（如 `"2026-09-01"`） |
| `limit` | number | `30` | 返回的最大条目数，上限 500 |
| `groupBySession` | boolean | `false` | 为 true 时额外按会话分组返回 |

也可以直接问模型，例如：

- 「我上次让你写的那份报告存哪了？」
- 「桌面上那个 `dsh-plugin-recon.md` 是哪次会话弄出来的？」
- 「最近有没有产出过 `.md` 文件？」
- 「`C:\dev` 下面这些文件分别是哪次会话写的？」

### 返回结构

`render` 产出上面那种人类可读文本，同时 `execute` 返回结构化结果供模型继续推理：

```json
{
  "scanned": {
    "sessions": 13, "candidates": 13,
    "since": "2026-07-07T13:26:02.910Z",
    "truncated": false, "resolved": true
  },
  "count": 10,
  "files": [
    {
      "path": "C:\\dev\\dsh-llm-profile\\index.js",
      "name": "index.js",
      "tool": "edit",
      "count": 6,
      "time": "2026-10-05T13:20:34.813Z",
      "sessionId": "af334781-0f89-4e5d-a10c-ba2152b7d382",
      "sessionTitle": "电脑是否安装Steam",
      "turn": 13,
      "exists": true,
      "cwd": "C:\\Users\\lenovo\\OneDrive\\Desktop"
    }
  ]
}
```

`count` 是**窗口内的命中总数**，`files` 只含 `limit` 条（超出时 render 会提示还有多少条未显示）。

## 配置

在 DSH 设置界面或 profile patch 里可改：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `mutateTools` | `['write', 'edit', 'present']` | 视为「会产出文件」的工具名 |
| `pathKeys` | `['path', 'file_path', 'filePath', 'notebook_path', 'target_file']` | 从参数里找路径时依次尝试的键名 |
| `defaultDays` | `90` | 未显式传 `since` 时的回溯天数 |
| `maxSessions` | `40` | 单次检索最多重放多少个会话日志，**直接决定耗时** |

## 设计取舍

**血统是从工具调用推断的，不是从文件系统快照来的。** DSH 的会话事件流里没有专门的
「文件被写入」事件，只有 `tool/call` 和 `tool/result`。所以插件按 `mutateTools` 挑出调用、
从参数里取路径，再用 `callId` 关联结果。这意味着：**只要某次写入没有走这三类工具**
（比如 `pwsh` 里的 `Out-File`），就不会出现在血统里。这是本插件已知的边界，见下方「已知限制」。

**必须走 `readSession`。** `sessionQuery` 提供了多个读路径，但 `listEvents` 与 `filterEvents`
返回的记录**被剥掉了 `data` 字段**——拿不到工具参数，也就推断不出任何血统。只有
`readSession` 返回带 `data` 的完整事件。这是本插件唯一的正确读路径。

**`maxSessions` 而不是 `defaultDays` 决定耗时。** `readSession` 会重放整个会话日志，所以
真正的成本旋钮是「读几个会话」。`since` 只过滤**返回结果**，不过滤扫描范围——因为会话
是可以被恢复的，九十天前创建的会话今天仍在写文件，那种写入同样属于窗口内的产出。
因此插件**始终取最新的 `maxSessions` 个会话**，再用 `since` 过滤条目时间。

**不断言 `fs` 依赖。** `inject` 里只写 `['tools', 'sessionQuery']`。`ctx.fs` 只用于把相对路径
绝对化和探测存在性，属于增强而非必需；一旦写进 `inject`，某个组合里缺 `fs` 就会让 fiber
停在 PENDING，插件会**无声消失**——那正是这个插件要避免的失败模式。`ctx.fs` 缺席时，
插件退回原始路径并在 `scanned.resolved` 里说明。

**没有结果的调用选择保留。** 只有 `tool/call` 而没有 `tool/result`，通常是回合被中断。
文件可能已经落盘，所以这类调用计入血统而不是丢弃——宁可多报，不可漏报。

**故障隔离到会话级。** 标题读取整批失败、单个会话读取失败、单个路径解析失败，都不会
让整次检索失败；对应的降级信息出现在 `scanned` 和 render 的提示行里。

## 已知限制

诚实标注，避免误用：

- **只认 `mutateTools` 里列出的工具。** 通过 shell（`pwsh`、`bash`）重定向、`Out-File`、
  `Set-Content` 等方式写出的文件**不在**血统内。这是设计边界，不是 bug。
- **血统来自被记录的工具参数，不是内核观测。** 如果某次调用最终写失败但结果里没有
  `error`（例如工具自身吞掉了异常），这条记录会留在血统里。
- **同一路径不跨会话去重。** 两个会话都写过同一路径就是两条记录（各自带自己的会话 id）。
  这是刻意的：合并掉反而丢失「谁还写过它」。
- **标题可能是兜底文本。** DSH 在未生成模型标题时用首条消息兜底，那种标题可能很长；
  插件会折叠空白并截断到 100 字符显示。
- **`session/title` 折叠时机。** 标题以 `readTitleSnapshots` 批量读取为准，读取整批失败时
  回退到会话日志里的 `session/title` 事件。
- **未在实时 DSH 运行时内做过端到端启动验证。** 见下方「验证到什么程度」。

## 验证到什么程度

本仓库的 `scripts/check.mjs` 覆盖契约与装配；除此之外，插件逻辑在**真实会话语料**上跑过：

- **真实数据**：解压本机 `~/.dsh/sessions` 下全部会话日志（`session.v4.jsonl.zstd`），
  重放 `tool/call` + `tool/result`，经插件**公开的 `apply()` 入口**注册工具后执行
  `file_lineage`。一次实测的口径：扫描 **13/13** 个会话，得到 **48 条 (会话, 路径) 血统记录**、
  **30 个不同绝对路径**，页面内的 30 条路径 **30/30** 全部成功绝对化。独立计数器在同一份
  语料上数到 **88 次成功的 `write`/`edit`/`present` 调用**，与 88 → 48 的合并结果一致。
  （语料是活的：每跑一次验证脚本，它自己写出的文件也会被记进去，所以这些数字会随运行增长。）
- **失败剔除未在真实语料上被触发**：这份语料里确实有带 `error` 的 `tool/result`，
  但**没有一条**属于 `write`/`edit`/`present`，所以「剔除失败调用」这条路径是靠下面的
  边界用例证明的，不是靠真实数据。
- **边界用例**：18 项断言覆盖失败调用剔除、重复写入合并计数、`present` 的嵌套路径、
  非 JSON 参数容忍、无路径参数跳过、中断调用保留、非 mutate 工具忽略、相对路径按会话
  `cwd` 绝对化、单会话读失败隔离、标题折叠与回退、存在性探测、空结果文案。
- 上面 README 里的示例输出是**原样粘贴**的真实运行结果，未做美化。

**没有验证的部分**：这些验证是在一个**忠实复刻 `sessionQuery`/`fs` 契约的测试 ctx**
上驱动插件的生产代码路径，**不是**在启动起来的 DSH 进程里。也就是说，契约层
（`inject` 名、服务方法签名、事件形状）是按 DSH `0.2.0-rc.2` 的实际实现与真实日志
核对过的，但「装进 profile 后 DSH 能正常加载」这一步未在本机验证。

## 开发

```bash
git clone https://github.com/Xinghe-Source/dsh-lineage.git
cd dsh-lineage

# 插件的裸导入 @deepseek-ai/* 由 DSH 载体提供；本地开发建一个软链指向它：
#   Windows:  cmd /c mklink /J node_modules "<DSH>\resources\app\dsh\node_modules"
#   macOS/Linux:  ln -s "<DSH>/resources/app/dsh/node_modules" node_modules

npm run check         # 契约自检（依赖解析不到时装配检查 SKIP）
npm run check:strict  # CI 用：装配检查不允许跳过
npm run pack:check    # 检查将要发布的文件清单
```

`npm run check` 分三档，钉的都是 DSH 插件的**静默失败点**：

| 档位 | 检查内容 | 需要依赖 |
| --- | --- | --- |
| 静态检查 | 没有 `export default`；`apply`/`inject`/`name`/`Config` 以命名导出暴露；声明处无重复导出；裸导入只来自 `@deepseek-ai/*` | 否 |
| 包契约检查 | `dsh.bundle.patch` 已声明且被 `files` 收录；补丁存在、包名一致、`insert` 语义 | 否 |
| 装配检查 | 工具能注册；`parameters` 是平铺 DSL 而非包裹层；`Config` 默认值与文档一致；空语料 `execute`/`render` 不抛错；非法 `since` 被拒绝 | 是 |

CI 会先显式安装 peer 依赖再以 `--strict` 运行，因此装配检查在 CI 里**不会**被跳过。

## License

[MIT](LICENSE) © 2026 Xinghe-Source
