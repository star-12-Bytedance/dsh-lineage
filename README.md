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
- 「这个文件哪来的？」→ 给出**会话 id、会话标题、回合、工具名、写入次数、时间**。
- 每次查询都报出**扫了几个会话、复用了几个、跳过了几个、为什么跳过**，让你能判断结果完不完整。

不需要索引、不需要网络、不写任何工作区文件：检索时直接读会话日志。

## 真实观测示例

下面是在一台真实机器上、对其全部 13 个历史会话执行 `file_lineage` 的**原样输出**
（`query: "dsh-llm-profile"`）：

```
找到 11 条血统记录（自 2026-07-07T14:02:52.145Z 起）：
C:\dev\dsh-llm-profile\package.json
  2026-10-05T13:56:55.624Z · edit×5 · 回合 21 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\CHANGELOG.md
  2026-10-05T13:56:53.460Z · edit×2 · 回合 21 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\README.md
  2026-10-05T13:56:40.880Z · edit×4 · 回合 21 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\scripts\test-persistence.mjs
  2026-10-05T13:55:52.796Z · write×1 · 回合 21 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\index.js
  2026-10-05T13:55:15.309Z · edit×22 · 回合 21 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\.gitattributes
  2026-10-05T13:21:22.868Z · write×1 · 回合 13 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\.github\workflows\check.yml
  2026-10-05T13:21:15.480Z · write×1 · 回合 13 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\scripts\check.mjs
  2026-10-05T13:21:07.342Z · edit×2 · 回合 13 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\.gitignore
  2026-10-05T13:20:42.088Z · write×1 · 回合 13 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\LICENSE
  2026-10-05T13:20:42.055Z · write×1 · 回合 13 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
C:\dev\dsh-llm-profile\cordis.patch.yml
  2026-10-05T13:17:32.313Z · write×1 · 回合 13 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
会话扫描：语料 13 个 → 重放 13、复用缓存 0
结果完整：语料里所有相关会话都已被考虑。
```

一眼可见的四件事：

1. **绝对路径直接可用。** 会话日志里记的是 `file_path` 参数，插件按该会话的 `cwd` 绝对化后给出。
2. **`edit×22` / `edit×5` 是合并后的次数。** 同一会话内对同一路径的重复写入折成一条并计数，
   工具名与时间取**最后一次**——也就是「这个文件最后是被谁动的」。
3. **同一路径出现在两个会话里就是两条记录。** 两个会话各自写过的，血统不该被抹掉。
4. **结尾两行是可信度声明。** 「语料 13 个 → 重放 13」说明这次是冷启动、每个会话都真读了；
   「结果完整」说明没有会话被截断，也没有读取失败。

再查一次同样的东西（**同一个 DSH 进程内**），就是复用 + 跳过：

```
找到 60 条血统记录（自 2026-10-05T02:02:52.442Z 起）：
C:\Users\lenovo\AppData\Local\Temp\dsh-lineage-verify\compare.mjs
  2026-10-05T14:01:38.332Z · write×1 · 回合 2 · 会话 af6d8850-bc24-46d1-88ea-2747ab18e54a · <system-reminder> You are teammate "line
C:\dev\dsh-lineage\scripts\check.mjs
  2026-10-05T14:01:09.387Z · edit×11 · 回合 2 · 会话 af6d8850-bc24-46d1-88ea-2747ab18e54a · <system-reminder> You are teammate "line
C:\dev\dsh-lineage\cordis.patch.yml
  2026-10-05T14:00:17.697Z · edit×3 · 回合 2 · 会话 af6d8850-bc24-46d1-88ea-2747ab18e54a · <system-reminder> You are teammate "line
C:\dev\dsh-lineage\.github\workflows\check.yml
  2026-10-05T14:00:12.654Z · write×2 · 回合 2 · 会话 af6d8850-bc24-46d1-88ea-2747ab18e54a · <system-reminder> You are teammate "line
C:\dev\dsh-lineage\index.js
  2026-10-05T14:00:12.617Z · edit×11 · 回合 2 · 会话 af6d8850-bc24-46d1-88ea-2747ab18e54a · <system-reminder> You are teammate "line
C:\Users\lenovo\AppData\Local\Temp\llm-profile-v2-msg.txt
  2026-10-05T13:57:06.998Z · write×1 · 回合 21 · 会话 af334781-0f89-4e5d-a10c-ba2152b7d382 · 电脑是否安装Steam
（还有 54 条未显示，可用 limit 调大或收窄 query。）
会话扫描：语料 13 个 → 重放 0、复用缓存 12、跳过 1（since 跳过 1）
结果完整：语料里所有相关会话都已被考虑。
```

**这一行就是优化的全部意义**：`重放 0、复用缓存 12、跳过 1` —— 13 个会话的日志一个都没重读，
结果与冷启动逐字段一致（见「性能」）。

## 功能

| 能力 | 说明 |
| --- | --- |
| 跨会话检索 | 一次查询覆盖全部历史会话，不只是当前会话 |
| 绝对路径 | 用**产出它的那个会话**的 `cwd` 解析相对路径，而不是用当前工作目录 |
| 完整血统 | 会话 id、会话标题、回合、工具名、写入次数、ISO 时间戳 |
| 失败剔除 | `tool/result` 带 `error` 的调用一律不计入血统 |
| 重复合并 | 同会话同路径的多次写入合并计数，保留最新一次的工具/回合/时间 |
| 嵌套路径 | 既认 `{ file_path }`（`write`/`edit`），也认 `{ files: [{ path }] }`（`present`） |
| 增量缓存 | 进程内按会话缓存折叠结果；日志没长过的会话在后续查询里**不再重放** |
| 窗口剪枝 | `since` / `defaultDays` 真正参与「要不要读这个会话」，而不是只过滤输出 |
| 成本可控 | `maxSessions` 限制冷启动重放量；存在性检查默认关闭且有预算上限 |
| 可信度声明 | 每次输出都报「重放/复用/跳过」明细与完整性结论 |
| 故障隔离 | 单个会话读失败只跳过它，绝不让整次检索失败 |
| 按会话分组 | `groupBySession: true` 时额外给出「哪次会话产出了这批文件」 |
| 完全只读 | 不写任何文件、不建索引、不访问网络 |

## 安装

```bash
dsh plugin --profile <你的profile> add @star-12-bytedance/dsh-lineage
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
| `since` | string | 见 `defaultDays` | ISO 8601 时间戳，只返回此时间之后写入的文件（如 `"2026-09-01"`）。窗口越窄越快 |
| `limit` | number | `30` | 返回的最大条目数，上限 500 |
| `groupBySession` | boolean | `false` | 为 true 时额外按会话分组返回 |
| `checkExists` | boolean | `false` | 是否逐个探测文件现在是否还存在。默认**关闭**；开启后单次最多检查前 50 个 |

也可以直接问模型，例如：

- 「我上次让你写的那份报告存哪了？」
- 「桌面上那个 `dsh-plugin-recon.md` 是哪次会话弄出来的？」
- 「最近有没有产出过 `.md` 文件？」
- 「`C:\dev` 下面这些文件分别是哪次会话写的？」

### 关于 `checkExists`

存在性检查是**每次一条文件系统往返**，默认 30 条结果就是 30 次往返，`limit` 放到 500 就是 500 次——
这个成本不该默认背上，所以它默认关闭。关闭时结果里**不带 `exists` 字段**，语义是「存在性未知」，
而不是「不存在」。开启后：

```
已检查全部 3 个文件是否存在。
```
或（结果多于预算时）：
```
只检查了前 50 个文件是否存在（共 67 个，单次上限 50）。
```

超预算的条目不写 `exists`，绝不谎报 `false`；`ctx.fs` 不可用时整项检查静默跳过并在输出里说明。

### 返回结构

`render` 产出上面那种人类可读文本，同时 `execute` 返回结构化结果供模型继续推理：

```json
{
  "scanned": {
    "candidates": 13, "considered": 13,
    "replayed": 0, "reused": 12, "pruned": 1, "empty": 0, "failed": 0,
    "existsChecked": 0,
    "since": "2026-10-05T02:02:52.442Z",
    "truncated": false, "resolved": true, "complete": true
  },
  "count": 60,
  "files": [
    {
      "path": "C:\\dev\\dsh-llm-profile\\index.js",
      "name": "index.js",
      "tool": "edit",
      "count": 22,
      "time": "2026-10-05T13:55:15.309Z",
      "sessionId": "af334781-0f89-4e5d-a10c-ba2152b7d382",
      "sessionTitle": "电脑是否安装Steam",
      "turn": 21,
      "cwd": "C:\\Users\\lenovo\\OneDrive\\Desktop"
    }
  ]
}
```

`scanned` 的每个字段都有明确含义，合起来回答「这次结果完不完整」：

| 字段 | 含义 |
| --- | --- |
| `candidates` | 语料里的会话总数 |
| `considered` | 本次实际纳入考虑的会话数（受 `maxSessions` 限制） |
| `replayed` | 本次**真正重放日志**的会话数 |
| `reused` | 日志版本没变、直接复用缓存结论的会话数 |
| `pruned` | 因最后一次写入早于窗口下界而跳过的会话数 |
| `empty` | 既非活动会话、又没有持久日志，因而跳过的会话数 |
| `failed` | 读取失败的会话数 |
| `existsChecked` | 实际做了存在性探测的文件数 |
| `truncated` | 语料会话数超过 `maxSessions`，结果可能不完整 |
| `resolved` | 路径是否已用 `ctx.fs` 绝对化 |
| `complete` | 结果是否完整（未截断且没有读取失败） |

`count` 是**窗口内的命中总数**，`files` 只含 `limit` 条（超出时 render 会提示还有多少条未显示）。

## 配置

在 DSH 设置界面或 profile patch 里可改：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `mutateTools` | `['write', 'edit', 'present']` | 视为「会产出文件」的工具名 |
| `pathKeys` | `['path', 'file_path', 'filePath', 'notebook_path', 'target_file']` | 从参数里找路径时依次尝试的键名 |
| `defaultDays` | `90` | 未显式传 `since` 时的回溯天数。既过滤返回结果，也参与跳过决策 |
| `maxSessions` | `40` | 单次检索最多重放多少个会话日志，**决定冷启动耗时** |
| `sessionCacheSize` | `200` | 进程内折叠缓存的会话数上限（LRU）；设 0 关闭缓存 |

## 性能

`readSession` 会解压并重放**整个**会话日志，所以性能问题等价于一个问句：**这次查询到底重放了几个日志？**
下面是在本机真实语料上实测的前后对比（13 个会话、解压后 25.09 MB；同一台机器，
每种场景 5 次取中位数；`since=2020-01-01, limit=500`）：

| 指标 | 优化前 | 优化后 | 变化 |
| --- | --- | --- | --- |
| 冷启动（首次查询） | 513.8 ms | **279.4 ms** | ≈1.8× 更快 |
| 重复查询（同参数） | 524.0 ms | **0.9 ms** | ≈580× 更快 |
| 冷启动 `readSession` 调用 | 26 次 | **13 次** | 减半 |
| 冷启动标题批读里的**重复日志重放** | 26 次 | **0 次** | 全部消除 |
| 重复查询的日志重放 | 26 次 | **0 次** | 全部消除 |
| 默认 `fs.stat` 往返 | 134 次 | **0 次** | 默认关闭 |
| 血统命中数（冷启动 / 重复） | 67 / 67 | **67 / 67** | **完全一致** |

两次独立实测复现了同一结论（冷启动 538.0→270.6 与 513.8→279.4，重复查询 531.5→0.8 与
524.0→0.9）；绝对毫秒数有约 ±10% 的机器噪声，**重放次数与命中数的对比是确定的**。

三处改动各自贡献了什么：

1. **砍掉重复的标题批读（≈2×）。** 优化前每个会话被读两遍：一遍取血统，一遍由
   `readTitleSnapshots` 取标题。而那个方法内部就是
   `foldSessionTitle(events)` = `events.findLast(e => e.type === 'session/title')` 取 `data.title`
   （见 `@deepseek-ai/dsh-session-title`），与插件在同一个日志上顺手折出的标题**完全等价**。
   日志本来就在手上，标题是免费的——把那一次批读整个删掉，冷启动直接减半。
2. **进程内会话缓存（重复查询 → 亚毫秒）。** 缓存记下每个会话的持久日志版本令牌与该会话的
   折叠结果；版本令牌没变就说明日志逐字节没变，结论直接复用，一次盘都不读。
3. **`since` 真正参与跳过决策。** 已知最后写入早于窗口下界的会话被直接剪掉，不再重放。

`since` 剪枝在真实语料上的实测（同一实例先预热，再用越来越窄的窗口查询；
每个窗口都与**全新实例**的冷启动结果逐字段比对）：

```
  since=2020-01-01: 缓存实例重放 0、复用 13、剪枝  0、命中 67，耗时 0.7ms  ‖ 全新实例命中 67  ⇒ 结果一致: 是
  since=2026-09-30: 缓存实例重放 0、复用 13、剪枝  0、命中 66，耗时 0.7ms  ‖ 全新实例命中 66  ⇒ 结果一致: 是
  since=2026-10-04: 缓存实例重放 0、复用 12、剪枝  1、命中 60，耗时 0.9ms  ‖ 全新实例命中 60  ⇒ 结果一致: 是
  since=2026-10-05: 缓存实例重放 0、复用 12、剪枝  1、命中 60，耗时 0.9ms  ‖ 全新实例命中 60  ⇒ 结果一致: 是
```

**剪枝不改变结果**：窄窗口下剪掉 1 个会话、命中 60 条，与全新实例全量重放得到的 60 条一致。
（这份语料只横跨约 6 天，所以窄窗口最多剪掉 1 个会话；会话越多、跨度越长，剪枝收益越大。）

## 设计取舍

**血统是从工具调用推断的，不是从文件系统快照来的。** DSH 的会话事件流里没有专门的
「文件被写入」事件，只有 `tool/call` 和 `tool/result`。所以插件按 `mutateTools` 挑出调用、
从参数里取路径，再用 `callId` 关联结果。这意味着：**只要某次写入没有走这三类工具**
（比如 `pwsh` 里的 `Out-File`），就不会出现在血统里。这是本插件已知的边界，见下方「已知限制」。

**必须走 `readSession`。** `sessionQuery` 提供了多个读路径，但 `listEvents` 与 `filterEvents`
返回的记录**被剥掉了 `data` 字段**——拿不到工具参数，也就推断不出任何血统。只有
`readSession` 返回带 `data` 的完整事件。这是本插件唯一的正确读路径。

**`since` 为什么不能只靠 `header.createdAt` 剪枝。** 会话是可以被恢复的：九十天前创建的会话
今天仍在写文件，那种写入同样属于窗口内的产出。`createdAt` 是事件时间的**下界**（会话不可能有
早于它的写入），不是上界，所以它无法证明「这个会话里没有窗口内的写入」——只按它筛会**漏结果**。
真正能证明的是**时间上界**：日志最后一次追加的时刻早于窗口下界。

**那个上界只能从「日志没有长过」间接得到。** 插件走可选的 `sessionPersistence` 服务做一次
`stat()`——它只读文件元信息，不解压、不重放，返回一个不透明的 `revision`。插件只把这个
`revision` 当**相等性令牌**用，绝不解析它的内容（那是后端的私有实现）。于是：

- 令牌与上次读过的一致 → 日志逐字节没变 → 上次算出的「最新一次写入时间」仍然成立 →
  若它早于窗口下界，这个会话**可以安全跳过**；
- 令牌变了，或本进程还没见过这个会话 → **老老实实重放**。

因此诚实地说明：**冷启动（本进程第一次见到某会话）时拿不到时间上界，必须读一次它的日志**。
`since` 对扫描量的收窄从第二次查询开始生效；`maxSessions` 才是冷启动的兜底旋钮。

**活动会话不进缓存路径。** 进程内正在使用的会话，其内存日志尾部未必已经落盘，持久层的
`revision` 代表不了它的真实内容。所以 `live` 会话每次都重读（通常只有当前这一个），
并且不写入缓存。这不是保守，是正确性：拿落盘版本去判断内存会话是否变了会给出过期血统。

**缓存是有界的。** LRU 上限 `sessionCacheSize`（默认 200 个会话），靠 `Map` 的插入顺序淘汰，
不会随语料增长而无限膨胀。缓存条目里存的是**未按 `since` 过滤**的完整折叠结果，所以后一次
更宽的查询仍能命中原先被剪掉的会话。

**不断言 `fs` / `sessionPersistence` 依赖。** `inject` 里只写 `['tools', 'sessionQuery']`。
`fs` 用于绝对化路径与（可选的）存在性检查，`sessionPersistence` 用于廉价的版本探测，两者都是
增强而非必需；一旦写进 `inject`，某个组合缺哪个服务就会让 fiber 停在 PENDING，插件会
**无声消失**——那正是这个插件要避免的失败模式。可选服务一律用 `ctx.get(name)` 取值
（服务缺席时返回 `undefined`，不抛错）。两者都缺席时：路径退回原始字符串（`scanned.resolved`
标记），缓存无从判断变化而退化为每次重读（`scanned.reused` 保持 0，不谎报复用）。

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
- **存在性默认未知。** `checkExists` 默认关闭，因此结果里通常没有 `exists` 字段。
  需要「文件还在不在」时显式开启，且只有前 50 条会被检查。
- **冷启动一定会读满 `maxSessions` 个候选会话。** 本进程第一次见到某个会话时没有时间上界，
  无法剪枝。这一步的耗时由 `maxSessions` 决定。
- **缓存以进程为界。** 重启 DSH 后缓存为空，第一次查询照常变慢；插件不落盘任何索引。
- **`sessionPersistence` 缺席时没有复用。** 缓存依赖持久层提供的日志版本令牌；服务不可用时
  插件如实退化为每次重读（`scanned.reused` 为 0），不会猜测。
- **未在实时 DSH 运行时内做过端到端启动验证。** 见下方「验证到什么程度」。

## 验证到什么程度

本仓库的 `scripts/check.mjs` 覆盖契约与装配；除此之外，插件逻辑在**真实会话语料**上跑过：

- **真实数据**：解压本机 `~/.dsh/sessions` 下全部会话日志（`session.v4.jsonl.zstd`，解压后
  25.09 MB），重放 `tool/call` + `tool/result`，经插件**公开的 `apply()` 入口**注册工具后执行
  `file_lineage`。语料是活的：每跑一次验证脚本，它自己写出的文件也会被记进去，
  所以下面的数字会随运行增长。
- **优化前后结果一致**：用同一个 `git show <旧提交>:index.js` 导出的旧版本与当前版本，
  在同一份真实语料上跑同一组参数，**67 条命中逐字段一致**（path / tool / count / time /
  sessionId / turn / sessionTitle 全部相同）。
- **`since` 剪枝不丢结果**：每个窄窗口都与**全新实例**的冷启动结果逐字段比对，全部一致
  （见「性能」）。
- **失败剔除未在真实语料上被触发**：这份语料里确实有带 `error` 的 `tool/result`，
  但**没有一条**属于 `write`/`edit`/`present`，所以「剔除失败调用」这条路径是靠下面的
  边界用例证明的，不是靠真实数据。
- **边界用例**：`scripts/check.mjs` 的「读取策略检查」一节在可控语料上断言 26 项行为，
  覆盖 since 剪枝、缓存复用、版本变化后强制重放、活动会话不走缓存、无持久层优雅退化、
  `checkExists` 默认零 stat、探测预算封顶 50、超预算不谎报、截断与完整性声明。
  加上前三档，`npm run check` 一共 61 项断言。
- 上面 README 里的示例输出是**原样粘贴**的真实运行结果，未做美化。

**没有验证的部分**：这些验证是在一个**忠实复刻 `sessionQuery` / `fs` / `sessionPersistence`
契约的测试 ctx** 上驱动插件的生产代码路径，**不是**在启动起来的 DSH 进程里。也就是说，契约层
（`inject` 名、服务方法签名、事件形状、`stat().revision` 语义）是按 DSH `0.2.0-rc.2` 的实际
实现与真实日志核对过的，但「装进 profile 后 DSH 能正常加载」这一步未在本机验证。
性能数字同理：它衡量的是插件在真实日志上的**读放大**（每个会话被读了几遍、读没读），
这是本次优化针对的量，但不是端到端延迟。

## 开发

```bash
git clone https://github.com/star-12-Bytedance/dsh-lineage.git
cd dsh-lineage

# 插件的裸导入 @deepseek-ai/* 由 DSH 载体提供；本地开发建一个软链指向它：
#   Windows:  cmd /c mklink /J node_modules "<DSH>\resources\app\dsh\node_modules"
#   macOS/Linux:  ln -s "<DSH>/resources/app/dsh/node_modules" node_modules

npm run check         # 契约自检（依赖解析不到时装配检查 SKIP）
npm run check:strict  # CI 用：装配检查不允许跳过
npm run pack:check    # 检查将要发布的文件清单
```

`npm run check` 分四档，钉的都是 DSH 插件的**静默失败点**：

| 档位 | 检查内容 | 需要依赖 |
| --- | --- | --- |
| 静态检查 | 没有 `export default`；`apply`/`inject`/`name`/`Config` 以命名导出暴露；声明处无重复导出；裸导入只来自 `@deepseek-ai/*` | 否 |
| 包契约检查 | `dsh.bundle.patch` 已声明且被 `files` 收录；补丁存在、包名一致、`insert` 语义 | 否 |
| 装配检查 | 工具能注册；`parameters` 是平铺 DSL 而非包裹层；`Config` 默认值与文档一致；空语料 `execute`/`render` 不抛错；非法 `since` 被拒绝 | 是 |
| 读取策略检查 | 同一份语料连续查询：结果不变而重放次数下降；版本令牌变化后强制重放；活动会话不走缓存；无持久层时优雅退化；`checkExists` 默认零 `stat` 且封顶 50 | 是 |

CI 会先显式安装 peer 依赖再以 `--strict` 运行，因此后两档在 CI 里**不会**被跳过。

## License

[MIT](LICENSE) © 2026 star-12-Bytedance
