/**
 * @star-12-bytedance/dsh-lineage — 跨会话文件血统检索。
 *
 * 回答两个问题，都不需要网络、也不写任何文件：
 *   1. 「那个文件在哪？」—— 按文件名/路径片段跨历史会话检索产出文件，给出绝对路径。
 *   2. 「这个文件哪来的？」—— 给出写入它的会话、会话标题、回合、工具与时间。
 *
 * 数据源：`ctx.sessionQuery` 的历史会话语料。血统从工具调用推断——DSH 的会话事件流
 * 里没有专门的文件写入事件（只有 `tool/call` 与 `tool/result`），所以按 `mutateTools`
 * 取出调用参数中的路径，用 `callId` 关联结果并剔除失败调用。
 *
 * 读取很贵：`readSession` 会解压并重放**整个**会话日志。因此本插件有三层成本控制：
 *   1. 进程内的按会话折叠缓存，日志没长过的会话直接复用结论（见 `sessionCache`）；
 *   2. `since` / `defaultDays` 对**已知**会话真正参与「要不要读」的决策（见 `execute` 注释）；
 *   3. `maxSessions` 兜底，限制冷启动一次最多重放多少个会话。
 *
 * 全部只读。失败按会话隔离：一个会话读不出来只跳过它，不影响整体检索。
 *
 * 注意：必须以**命名导出**暴露 apply/inject，Loader 的 unwrapExports 会折叠
 * `export default` 并静默丢掉 inject，插件会无声失效。
 * @module @star-12-bytedance/dsh-lineage
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

/** 插件在 Loader 树里显示的名字。 */
const name = 'lineage';

/**
 * 硬依赖。`sessionQuery` 是历史会话语料的只读服务，`tools` 是本插件要注册进
 * 的注册表。
 *
 * 这里**故意不注入** `fs` 与 `sessionPersistence`：两者都只是增强（`fs` 用来绝对化
 * 路径与探测存在性，`sessionPersistence` 用来廉价地判断会话日志有没有变），缺了插件
 * 依然可用。一旦把它们写进 inject，某个组合不提供该服务时整个 fiber 会停在 PENDING，
 * 插件会**无声消失**——那正是本插件要避免的失败模式。可选服务一律用 `ctx.get(name)`
 * 取值（`Context.get` 在服务缺席时返回 `undefined`，不抛错）。
 */
const inject = ['tools', 'sessionQuery'];

/** 部署配置，可在 DSH 设置界面或 profile patch 里调整。 */
const Config = z.object({
  mutateTools: z
    .array(z.string())
    .default(['write', 'edit', 'present'])
    .description('工具名列表：这些工具的调用参数里带有产出文件路径，用来推断血统。'),
  pathKeys: z
    .array(z.string())
    .default(['path', 'file_path', 'filePath', 'notebook_path', 'target_file'])
    .description('从工具参数里提取路径时依次尝试的键名。'),
  defaultDays: z
    .number()
    .default(90)
    .description(
      '未显式指定 since 时默认回溯的天数。它既过滤**返回结果**，也参与「要不要读这个会话」的决策：' +
        '本进程内已经观察过、且日志自上次读取后没有增长的会话，若其最后一次写入早于窗口下界，就直接跳过不重放。' +
        '冷启动（首次遇到某会话）时拿不到时间上界，仍需读一次它的日志。',
    ),
  maxSessions: z
    .number()
    .default(40)
    .description(
      '单次检索最多重放多少个会话日志（取最近者）。' +
        '读取走 sessionQuery.readSession，会重放整个会话日志，所以这个上限决定冷启动的耗时；' +
        '需要更早的历史时显式调大它。',
    ),
  sessionCacheSize: z
    .number()
    .default(200)
    .description(
      '进程内折叠缓存的会话数上限（LRU）。缓存记录每个会话的日志版本与该会话折叠出的血统，' +
        '日志版本没变的会话在后续查询里不再重放。设为 0 可关闭缓存。',
    ),
});

/** 一天有多少毫秒，用于 since 计算。 */
const DAY_MS = 86_400_000;

/** `limit` 的硬上限：结果条数不该由模型随手放大到无意义。 */
const LIMIT_MAX = 500;

/** 渲染时标题的最大长度：标题常常是首条 prompt 的兜底文本，可能非常长且含换行。 */
const TITLE_RENDER_MAX = 100;

/**
 * 一次调用里最多做多少次存在性探测。
 *
 * 存在性检查是锦上添花，却是**每次一条文件系统往返**——不设上限就会变成瓶颈。
 * 因此它默认关闭（`checkExists`），开启后也只探测前这么多条，并在输出里说明。
 */
const EXISTS_PROBE_MAX = 50;

/**
 * 把标题压成单行短文本。
 *
 * DSH 在没有模型生成标题时会用首条消息兜底，那种标题可能很长而且**含换行**——
 * 直接拼进「一行一条」的血统列表会把输出撕成多行。这里统一折叠空白字符。
 * @param value - 原始标题。
 * @returns 折叠后的单行标题，或 undefined。
 */
function normalizeTitle(value) {
  if (typeof value !== 'string') return undefined;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? undefined : collapsed;
}

/**
 * 解析一次 `tool/call` 的 arguments。
 *
 * `arguments` 是 JSON **字符串**；也有工具传纯文本，那种载荷解析不出路径，直接
 * 当作没有血统贡献，而不是让整个查询失败。
 * @param raw - 事件里的 `arguments` 字段。
 * @returns 解析出的对象，或 undefined。
 */
function parseArguments(raw) {
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 从一组已解析的工具参数里取出文件路径。
 *
 * 先按 `pathKeys` 做顶层直取（`write` / `edit` / `str_replace_editor` 的形状：
 * `{ file_path, content }`）；顶层取不到时再看一层数组元素——DSH 的 `present`
 * 是 `{ files: [{ path }] }`，路径嵌在数组里的对象上，直取会漏掉它。
 * @param args - 已解析的参数对象。
 * @param keys - 候选键名，按优先级排列。
 * @returns 去重后的路径字符串列表，可能为空。
 */
function collectPaths(args, keys) {
  const found = new Set();
  if (args === null || typeof args !== 'object') return [];

  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') found.add(value.trim());
  }
  if (found.size > 0) return [...found];

  for (const value of Object.values(args)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
      for (const key of keys) {
        const nested = item[key];
        if (typeof nested === 'string' && nested.trim() !== '') {
          found.add(nested.trim());
          break;
        }
      }
    }
  }
  return [...found];
}

/**
 * 把一个会话的事件流折叠成它写过的文件。
 *
 * 两趟：先收集 `tool/call` 里属于 mutateTools 且参数带路径的调用，再标记出
 * `tool/result` 报告了 `error` 的 callId 并剔除。**完全没有结果的调用会保留**——
 * 那通常是回合被中断，文件可能已经落盘，宁可多报也不要漏报。
 *
 * 同一路径的重复写入合并为一条并累加次数，时间/回合/工具取最新的一次，
 * 也就是「这个文件最后一次是被谁动的」。
 *
 * 标题顺手在这里折出来，**不再单独调 `readTitleSnapshots`**：那个方法内部是
 * `foldSessionTitle(events)`，展开就是 `events.findLast(e => e.type === 'session/title')`
 * 取 `data.title`（见 @deepseek-ai/dsh-session-title），与本函数下面这几行完全等价，
 * 而它自己要重新解压重放一遍每个会话的日志——等于把整轮读取翻倍。日志本来就在手上，
 * 顺带折出标题是免费的。
 *
 * @param events - 该会话的原始事件记录，按 seq 升序。
 * @param wantedTools - 视为会写文件的工具名集合。
 * @param pathKeys - 候选路径键名。
 * @returns `hits`（按时间倒序的路径条目）与日志里折出的 `title`。
 */
function foldMutations(events, wantedTools, pathKeys) {
  const calls = new Map();
  const failed = new Set();
  let title;
  let anonymous = 0;

  for (const event of events) {
    const data = event.data;
    if (data === null || typeof data !== 'object') continue;

    if (event.type === 'tool/call') {
      if (!wantedTools.has(data.name)) continue;
      const paths = collectPaths(parseArguments(data.arguments), pathKeys);
      if (paths.length === 0) continue;
      // callId 理论上总是存在；缺席时用序号兜底，避免多个调用挤进同一个 key。
      const callId = data.callId === undefined ? `\u0000anon:${anonymous++}` : String(data.callId);
      calls.set(callId, {
        tool: data.name,
        paths,
        turn: typeof data.turn === 'number' ? data.turn : 0,
        time: typeof event.time === 'number' ? event.time : 0,
      });
    } else if (event.type === 'tool/result') {
      // 失败通过 `error` 表示，callId 在 message.toolCallId 上（不是 data.callId）。
      const callId = data.message !== null && typeof data.message === 'object' ? data.message.toolCallId : undefined;
      if (callId !== undefined && data.error !== undefined) failed.add(String(callId));
    } else if (event.type === 'session/title') {
      const fallback = normalizeTitle(data.title);
      if (fallback !== undefined) title = fallback;
    }
  }

  const merged = new Map();
  for (const [callId, call] of calls) {
    if (failed.has(callId)) continue;
    for (const path of call.paths) {
      const previous = merged.get(path);
      if (previous === undefined) {
        merged.set(path, { path, tool: call.tool, turn: call.turn, time: call.time, count: 1 });
        continue;
      }
      previous.count += 1;
      if (call.time > previous.time) {
        previous.time = call.time;
        previous.turn = call.turn;
        previous.tool = call.tool;
      }
    }
  }

  return { hits: [...merged.values()].sort((a, b) => b.time - a.time), title };
}

/**
 * 把会话里记录的路径转成绝对路径。
 * @param fs - 组合出来的文件系统服务，可能缺席。
 * @param path - 工具调用里记录的路径原样。
 * @param cwd - 该会话的工作目录。
 * @returns `{ path, resolved }`；`resolved` 为 false 表示没能绝对化。
 */
async function absolutize(fs, path, cwd) {
  if (fs === undefined || fs === null) return { path, resolved: false };
  try {
    const options = typeof cwd === 'string' && cwd !== '' ? { cwd } : {};
    const target = await fs.resolve(path, options);
    const absolute = fs.processPath(target);
    return typeof absolute === 'string' && absolute !== ''
      ? { path: absolute, resolved: true }
      : { path, resolved: false };
  } catch {
    // 解析失败（路径非法、cwd 已消失）时退回原字符串，总比丢掉这条血统好。
    return { path, resolved: false };
  }
}

/**
 * 探测文件现在是否还存在。
 *
 * 三态：`true` 存在、`false` 确定不存在、`undefined` **不知道**。
 * 「不知道」必须与「不存在」区分开——服务缺席或探测本身出错时说文件已删除是撒谎。
 * @param fs - 文件系统服务，可能缺席。
 * @param path - 绝对路径。
 * @param signal - 取消信号。
 * @returns 存在为 true，确定不存在为 false，无法判断为 undefined。
 */
async function probeExists(fs, path, signal) {
  if (fs === undefined || fs === null) return undefined;
  try {
    const target = await fs.resolve(path, { signal });
    return (await fs.stat(target, signal)) !== undefined;
  } catch {
    return undefined;
  }
}

/**
 * 廉价地问一句「这个会话的日志变了没有」。
 *
 * 走可选的 `sessionPersistence` 服务：`stat()` 只读文件元信息，**不解压、不重放日志**，
 * 返回的 `revision` 是后端定义的不透明版本串（JSONL 后端把它建立在 dev/ino/size/
 * mtimeNs/ctimeNs 上，任何一次追加都会改变它）。本插件只把它当作**相等性比较**的
 * 令牌使用，绝不解析它的内容——那是后端的私有实现。
 *
 * 对 `live` 会话返回 `undefined`：进程内活动的会话，其内存日志尾部未必已经落盘，
 * 持久层的 revision 不能代表它的真实内容，所以活动会话一律老老实实重读。
 *
 * @param persistence - 持久层服务，可能缺席。
 * @param sessionId - 会话 id。
 * @param signal - 取消信号。
 * @returns `{ absent: true }` 表示没有持久日志；`{ signature }` 表示版本令牌（可能是
 *   `undefined`，那就不能用来比较）；`undefined` 表示问不出来，必须老实重读。
 */
async function probeSignature(persistence, sessionId, signal) {
  if (persistence === undefined || persistence === null) return undefined;
  if (typeof persistence.stat !== 'function') return undefined;
  try {
    const snapshot = await persistence.stat(sessionId, signal === undefined ? undefined : { signal });
    if (snapshot === undefined || snapshot === null) return { absent: true };
    const revision = snapshot.revision;
    return { absent: false, signature: revision === undefined ? undefined : String(revision) };
  } catch {
    // 探测失败（后端换了、会话正在迁移）→ 当作问不出来，退回重读。
    return undefined;
  }
}

/**
 * 读缓存并把命中的条目移到 LRU 末端。
 * @param cache - 会话缓存 Map。
 * @param sessionId - 会话 id。
 * @returns 缓存条目，或 undefined。
 */
function cacheGet(cache, sessionId) {
  const entry = cache.get(sessionId);
  if (entry === undefined) return undefined;
  cache.delete(sessionId);
  cache.set(sessionId, entry);
  return entry;
}

/**
 * 写缓存并按容量淘汰最久未用的条目。
 *
 * 淘汰靠 Map 的插入顺序：命中时会 delete + set 把条目移到末端，所以头部就是 LRU。
 * 上限保证缓存不会随会话数无限增长。
 * @param cache - 会话缓存 Map。
 * @param sessionId - 会话 id。
 * @param entry - 要写入的条目。
 * @param max - 容量上限；小于 1 时不写。
 */
function cacheSet(cache, sessionId, entry, max) {
  if (!(max >= 1)) return;
  cache.delete(sessionId);
  cache.set(sessionId, entry);
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * 把扫描统计渲染成一行人类可读的说明。
 *
 * 「扫描了 N 个 / 共 M 个，因为 X 被跳过」必须能一眼看出来，否则用户无法判断
 * 结果是不是完整的。
 * @param head - 结果里的 `scanned` 对象。
 * @returns 一行说明文本。
 */
function describeScan(head) {
  const skipped = head.pruned + head.empty + head.failed;
  const parts = [`重放 ${head.replayed}`, `复用缓存 ${head.reused}`];
  if (skipped > 0) {
    const reasons = [];
    if (head.pruned > 0) reasons.push(`since 跳过 ${head.pruned}`);
    if (head.empty > 0) reasons.push(`无日志 ${head.empty}`);
    if (head.failed > 0) reasons.push(`读取失败 ${head.failed}`);
    parts.push(`跳过 ${skipped}（${reasons.join('、')}）`);
  }
  const cap = head.truncated === true ? `，已按 maxSessions 截断到 ${head.considered} 个` : '';
  return `会话扫描：语料 ${head.candidates} 个${cap} → ${parts.join('、')}`;
}

/**
 * 注册 `file_lineage` 工具。
 * @param ctx - 携带 `tools`、`sessionQuery` 的注册上下文。
 * @param config - 已解析的部署配置。
 */
function apply(ctx, config = {}) {
  const mutateTools = config.mutateTools ?? ['write', 'edit', 'present'];
  const pathKeys = config.pathKeys ?? ['path', 'file_path', 'filePath', 'notebook_path', 'target_file'];
  const defaultDays = config.defaultDays ?? 90;
  const maxSessions = config.maxSessions ?? 40;
  const sessionCacheSize = config.sessionCacheSize ?? 200;
  const wantedTools = new Set(mutateTools);

  /**
   * 进程内的按会话折叠缓存：`sessionId -> 条目`。
   *
   * 条目形状：
   *   `signature`       持久日志版本令牌（相等即「日志没长过」）
   *   `hasLineage`      该会话有没有折叠出任何血统
   *   `lastLineageTime` 该会话**最新**一次写入的时间；为 0 表示没有血统
   *   `hits`            折叠结果（**未按 since 过滤**，这样后一次更宽的查询仍能命中）
   *   `title`           日志里折出的标题
   *
   * `apply` 只在插件挂载时调用一次，所以这个 Map 的生命周期就是进程生命周期。
   */
  const sessionCache = new Map();

  ctx.tools.register(
    defineTool({
      name: 'file_lineage',
      description:
        'Search every past DSH session for files that were created or modified, and report the absolute path plus the session, turn and tool that wrote it. ' +
        'Use it whenever you or the user need to locate a file produced in an earlier session, or to explain where a file came from — it replaces guessing paths and re-listing whole directories. ' +
        'Lineage is inferred from the arguments of file-mutating tool calls (write/edit/present by default); failed calls are excluded, and repeated writes to one path collapse into a single entry with a count. ' +
        'Sessions whose logs have not grown since the last search in this process are answered from an in-memory cache instead of being replayed, and the result always reports how many sessions were read versus skipped so you can judge completeness. ' +
        'Read-only: it never writes, and it reads session history locally without touching the network. ' +
        '跨会话检索产出文件并给出血统（绝对路径 / 会话 / 会话标题 / 回合 / 工具 / 次数 / 时间）。',
      parameters: {
        query: {
          type: 'string',
          description:
            '文件名或路径的片段，大小写不敏感（例如 "steam"、"报告.docx"、"Desktop"）。留空则返回回溯窗口内的全部产出。',
        },
        pathPrefix: {
          type: 'string',
          description:
            '只返回绝对路径以此前缀开头的产出，大小写不敏感（例如 "C:\\\\Users\\\\lenovo\\\\OneDrive\\\\Desktop"）。',
        },
        since: {
          type: 'string',
          description:
            'ISO 8601 时间戳，只返回此时间之后写入的文件（例如 "2026-09-01"）。省略则用 defaultDays 回溯窗口。' +
            '窗口同时用来跳过已知的最后写入早于它的会话，所以窗口越窄越快。',
        },
        limit: {
          type: 'number',
          description: `返回的最大条目数，默认 30，上限 ${LIMIT_MAX}。`,
        },
        groupBySession: {
          type: 'boolean',
          description: '为 true 时额外按会话分组返回，便于看清「哪一次会话产出了这批文件」。',
        },
        checkExists: {
          type: 'boolean',
          description:
            '是否逐个探测文件现在是否还存在，默认 false。每次探测都是一条文件系统往返，' +
            `因此开启后最多只检查前 ${EXISTS_PROBE_MAX} 个文件，输出会说明实际检查了多少个。` +
            '关闭时（默认）结果里不带 exists 字段，即「存在性未知」。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scanned: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                candidates: { type: 'integer', required: true, description: '语料里的会话总数。' },
                considered: { type: 'integer', required: true, description: '本次实际纳入考虑的会话数（受 maxSessions 限制）。' },
                replayed: { type: 'integer', required: true, description: '本次真正重放日志的会话数。' },
                reused: { type: 'integer', required: true, description: '日志未变、直接复用缓存结论的会话数。' },
                pruned: { type: 'integer', required: true, description: '因最后一次写入早于窗口下界而跳过的会话数。' },
                empty: { type: 'integer', required: true, description: '既非活动会话、又没有持久日志，因而跳过的会话数。' },
                failed: { type: 'integer', required: true, description: '读取失败的会话数。' },
                existsChecked: { type: 'integer', required: true, description: '实际做了存在性探测的文件数。' },
                since: { type: 'string', required: true, description: '本次检索的时间下界（ISO 8601）。' },
                truncated: { type: 'boolean', required: true, description: '语料会话数超过 maxSessions，结果可能不完整。' },
                resolved: { type: 'boolean', required: true, description: '路径是否已用 ctx.fs 绝对化。' },
                complete: { type: 'boolean', required: true, description: '结果是否完整（未截断且没有读取失败）。' },
              },
            },
            count: { type: 'integer', required: true, description: '命中的条目总数（可能大于 files 的长度）。' },
            files: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true, description: '绝对路径。' },
                  name: { type: 'string', required: true, description: '文件名。' },
                  tool: { type: 'string', required: true, description: '最后一次写入它的工具名。' },
                  count: { type: 'integer', required: true, description: '合并后的写入次数。' },
                  time: { type: 'string', required: true, description: '最后一次写入时间（ISO 8601）。' },
                  sessionId: { type: 'string', required: true, description: '录入它的会话 id。' },
                  sessionTitle: { type: 'string', description: '该会话的标题，读不到时省略。' },
                  turn: { type: 'integer', required: true, description: '最后一次写入所在回合。' },
                  cwd: { type: 'string', description: '该会话的工作目录。' },
                  exists: {
                    type: 'boolean',
                    description: '文件现在是否还存在；仅在 checkExists 为 true 且落在探测预算内时给出，缺省表示未知。',
                  },
                },
              },
            },
            groups: {
              type: 'array',
              description: '仅在 groupBySession 为 true 时出现。',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  sessionId: { type: 'string', required: true },
                  sessionTitle: { type: 'string' },
                  count: { type: 'integer', required: true },
                  paths: { type: 'array', required: true, items: { type: 'string' } },
                },
              },
            },
          },
        },
        render: (args, value) => {
          const head = value.scanned;
          const lines = [];

          if (value.count === 0) {
            lines.push(`未找到匹配的产出文件（自 ${head.since} 起）。`);
            lines.push('提示：换更宽泛的 query 片段、显式传更早的 since，或调大 maxSessions。');
          } else {
            lines.push(`找到 ${value.count} 条血统记录（自 ${head.since} 起）：`);
            for (const file of value.files) {
              const gone = file.exists === false ? '  [文件已不存在]' : '';
              lines.push(`${file.path}${gone}`);
              const raw = file.sessionTitle;
              const title =
                raw === undefined
                  ? ''
                  : ` · ${raw.length > TITLE_RENDER_MAX ? `${raw.slice(0, TITLE_RENDER_MAX)}…` : raw}`;
              lines.push(`  ${file.time} · ${file.tool}×${file.count} · 回合 ${file.turn} · 会话 ${file.sessionId}${title}`);
            }
            if (value.count > value.files.length) {
              lines.push(`（还有 ${value.count - value.files.length} 条未显示，可用 limit 调大或收窄 query。）`);
            }
          }

          lines.push(describeScan(head));
          if (head.complete === true) lines.push('结果完整：语料里所有相关会话都已被考虑。');
          else if (head.truncated === true) lines.push('结果可能不完整：语料会话数超过 maxSessions。');
          else if (head.failed > 0) lines.push(`结果可能不完整：有 ${head.failed} 个会话读取失败。`);

          if (args.checkExists === true) {
            const total = value.files.length;
            lines.push(
              head.existsChecked >= total
                ? `已检查全部 ${total} 个文件是否存在。`
                : `只检查了前 ${head.existsChecked} 个文件是否存在（共 ${total} 个，单次上限 ${EXISTS_PROBE_MAX}）。`,
            );
            if (head.resolved === false) lines.push('注意：ctx.fs 不可用，存在性检查已跳过。');
          }
          if (head.resolved === false) lines.push('注意：ctx.fs 不可用，路径按会话记录原样返回，未绝对化。');
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args, exec) {
        const requested = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : 30;
        const limit = Math.min(Math.max(requested, 1), LIMIT_MAX);

        let sinceMs = Date.now() - defaultDays * DAY_MS;
        if (typeof args.since === 'string' && args.since.trim() !== '') {
          const parsed = Date.parse(args.since);
          if (Number.isNaN(parsed)) throw new Error(`file_lineage: since 不是有效时间: ${args.since}`);
          sinceMs = parsed;
        }

        const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
        const prefix = typeof args.pathPrefix === 'string' ? args.pathPrefix.trim().toLowerCase() : '';
        const signal = exec?.signal;
        const checkExists = args.checkExists === true;

        const sessionQuery = ctx.sessionQuery;
        // `fs` 与 `sessionPersistence` 都是**可选**服务，必须走 ctx.get() 取值：直接写
        // `ctx.fs` 会抛 "cannot get property \"fs\" without inject"，而把它们塞进
        // inject 又会让缺服务的组合整个 fiber 停在 PENDING。两者都会让插件在一个
        // 完全正常的部署里不可用。
        const fs = ctx.get('fs');
        const persistence = ctx.get('sessionPersistence');

        // listSessions 已按最新优先返回，取前 maxSessions 个。
        //
        // 为什么**不**用 header.createdAt 直接筛掉旧会话：会话可以被恢复，九十天前
        // 创建的会话今天仍在写文件，那种写入同样属于窗口内的产出。createdAt 是**下界**
        // （会话不可能有早于它的写入），不是上界，因此它无法证明「这个会话里没有窗口内
        // 的写入」，只按它筛会漏结果。
        //
        // 真正能证明「没有窗口内写入」的是**时间上界**：日志最后一次追加的时刻早于
        // 窗口下界。这个上界只能通过「日志没长过」间接拿到——也就是下面的缓存。
        // 冷启动（本进程第一次见到某会话）时拿不到上界，只能读一次；所以 since 对
        // 扫描量的收窄从第二次查询开始生效，而 maxSessions 是冷启动的兜底旋钮。
        const records = await sessionQuery.listSessions(signal);
        const candidates = records.length;
        const truncated = candidates > maxSessions;
        const selected = records.slice(0, maxSessions);

        const counters = { replayed: 0, reused: 0, pruned: 0, empty: 0, failed: 0 };
        const hits = [];
        let resolvedFs = fs !== undefined && fs !== null;

        for (const record of selected) {
          if (signal?.aborted) break;
          const sessionId = String(record.header.id);
          const cwd = typeof record.header.cwd === 'string' ? record.header.cwd : undefined;
          const live = record.live === true;

          // 活动会话的内存日志尾部未必落盘，持久层版本令牌代表不了它 → 不进缓存路径。
          let signature;
          if (!live && persistence !== undefined) {
            const probe = await probeSignature(persistence, sessionId, signal);
            if (probe !== undefined) {
              if (probe.absent === true) {
                // 既不是活动会话、又没有持久日志 → 它没有任何事件，读也读不出血统。
                counters.empty += 1;
                continue;
              }
              signature = probe.signature;
            }
          }

          const cached = signature === undefined ? undefined : cacheGet(sessionCache, sessionId);
          let entry;
          if (cached !== undefined && cached.signature === signature) {
            // 日志版本令牌没变 → 内容与上次折叠时逐字节一致，结论可以直接复用。
            if (!cached.hasLineage) {
              counters.reused += 1;
              continue;
            }
            // 最新一次写入都早于窗口下界 → 该会话不可能贡献窗口内的条目。
            // 这条剪枝是**可靠**的：没有新字节就没有新事件。
            if (cached.lastLineageTime < sinceMs) {
              counters.pruned += 1;
              continue;
            }
            counters.reused += 1;
            entry = cached;
          } else {
            let folded;
            try {
              // readSession 是唯一返回完整事件的读路径：listEvents / filterEvents
              // 都会剥掉 data，拿不到工具参数，因此推断不了血统。
              const snapshot = await sessionQuery.readSession(sessionId);
              folded = foldMutations(snapshot.events ?? [], wantedTools, pathKeys);
            } catch {
              counters.failed += 1; // 单个会话读失败只跳过它，绝不让整次检索失败。
              continue;
            }
            counters.replayed += 1;
            const foldedHits = folded.hits;
            entry = {
              signature,
              hasLineage: foldedHits.length > 0,
              // hits 按时间倒序，[0] 就是最新的一次写入。
              lastLineageTime: foldedHits.length === 0 ? 0 : foldedHits[0].time,
              hits: foldedHits,
              title: folded.title,
            };
            if (signature !== undefined) cacheSet(sessionCache, sessionId, entry, sessionCacheSize);
          }

          for (const hit of entry.hits) {
            if (hit.time < sinceMs) continue;
            const absolute = await absolutize(fs, hit.path, cwd);
            if (absolute.resolved === false) resolvedFs = false;
            if (query !== '' && !absolute.path.toLowerCase().includes(query)) continue;
            if (prefix !== '' && !absolute.path.toLowerCase().startsWith(prefix)) continue;
            hits.push({
              path: absolute.path,
              name: absolute.path.split(/[\\/]/).pop() ?? absolute.path,
              tool: hit.tool,
              count: hit.count,
              time: hit.time,
              sessionId,
              turn: hit.turn,
              title: entry.title,
              cwd,
            });
          }
        }

        hits.sort((a, b) => b.time - a.time || a.path.localeCompare(b.path));

        // 存在性检查默认关闭：每条都要一次文件系统往返，不该成为瓶颈。
        // 开启后只花前 EXISTS_PROBE_MAX 条的预算，剩下的保持「未知」而不是谎报 false。
        let existsChecked = 0;
        const files = [];
        for (const hit of hits.slice(0, limit)) {
          const entry = {
            path: hit.path,
            name: hit.name,
            tool: hit.tool,
            count: hit.count,
            time: new Date(hit.time).toISOString(),
            sessionId: hit.sessionId,
            turn: hit.turn,
          };
          if (typeof hit.title === 'string' && hit.title !== '') entry.sessionTitle = hit.title;
          if (typeof hit.cwd === 'string' && hit.cwd !== '') entry.cwd = hit.cwd;
          if (checkExists && existsChecked < EXISTS_PROBE_MAX && resolvedFs) {
            const exists = await probeExists(fs, hit.path, signal);
            if (exists !== undefined) {
              existsChecked += 1;
              entry.exists = exists;
            }
          }
          files.push(entry);
        }

        const result = {
          scanned: {
            candidates,
            considered: selected.length,
            replayed: counters.replayed,
            reused: counters.reused,
            pruned: counters.pruned,
            empty: counters.empty,
            failed: counters.failed,
            existsChecked,
            since: new Date(sinceMs).toISOString(),
            truncated,
            resolved: resolvedFs,
            complete: !truncated && counters.failed === 0,
          },
          count: hits.length,
          files,
        };

        if (args.groupBySession === true) {
          const groups = new Map();
          for (const file of files) {
            const existing = groups.get(file.sessionId);
            if (existing === undefined) {
              const group = { sessionId: file.sessionId, count: file.count, paths: [file.path] };
              if (file.sessionTitle !== undefined) group.sessionTitle = file.sessionTitle;
              groups.set(file.sessionId, group);
            } else {
              existing.count += file.count;
              existing.paths.push(file.path);
            }
          }
          result.groups = [...groups.values()];
        }

        return result;
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `file_lineage: ${typeof args.query === 'string' && args.query !== '' ? args.query : '(全部产出)'}`,
        kind: 'read',
        rawInput: args.query ?? '',
      }),
    }),
  );
}

export { Config, apply, inject, name };
