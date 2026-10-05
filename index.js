/**
 * @xinghe-source/dsh-lineage — 跨会话文件血统检索。
 *
 * 回答两个问题，都不需要网络、也不写任何文件：
 *   1. 「那个文件在哪？」—— 按文件名/路径片段跨历史会话检索产出文件，给出绝对路径。
 *   2. 「这个文件哪来的？」—— 给出写入它的会话、会话标题、回合、工具与时间。
 *
 * 数据源：`ctx.sessionQuery` 的历史会话语料。血统从工具调用推断——DSH 的会话事件流
 * 里没有专门的文件写入事件（只有 `tool/call` 与 `tool/result`），所以按 `mutateTools`
 * 取出调用参数中的路径，用 `callId` 关联结果并剔除失败调用。
 *
 * 全部只读。失败按会话隔离：一个会话读不出来只跳过它，不影响整体检索。
 *
 * 注意：必须以**命名导出**暴露 apply/inject，Loader 的 unwrapExports 会折叠
 * `export default` 并静默丢掉 inject，插件会无声失效。
 * @module @xinghe-source/dsh-lineage
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

/** 插件在 Loader 树里显示的名字。 */
const name = 'lineage';

/**
 * 硬依赖。`sessionQuery` 是历史会话语料的只读服务，`tools` 是本插件要注册进
 * 的注册表。这里**故意不注入 `fs`**：`fs` 只用于把相对路径绝对化和探测文件是否
 * 还存在，属于增强而非必需；一旦写进 inject，某个组合缺 `fs` 时整个 fiber 会停在
 * PENDING，插件会无声消失——那正是本插件要避免的失败模式。
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
    .description('未显式指定 since 时默认回溯的天数。它只收窄**返回结果**，不收窄扫描量。'),
  maxSessions: z
    .number()
    .default(40)
    .description(
      '单次检索最多读取的会话数（取最近者）。' +
        '读取走 sessionQuery.readSession，会重放整个会话日志，所以这个上限直接决定耗时；' +
        '需要更早的历史时显式调大它。',
    ),
});

/** 一天有多少毫秒，用于 since 计算。 */
const DAY_MS = 86_400_000;

/** limit 的硬上限：结果列表以外的存在性探测也要花时间，不能让模型随手传个 100000。 */
const LIMIT_MAX = 500;

/** 渲染时标题的最大长度：标题常常是首条 prompt 的兜底文本，可能非常长且含换行。 */
const TITLE_RENDER_MAX = 100;

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
 * 那通常是回合被中断，文件可能已经落盘，宁可多报也不要漏报（render 层会说明）。
 *
 * 同一路径的重复写入合并为一条并累加次数，时间/回合/工具取最新的一次，
 * 也就是「这个文件最后一次是被谁动的」。
 *
 * @param events - 该会话的原始事件记录，按 seq 升序。
 * @param wantedTools - 视为会写文件的工具名集合。
 * @param pathKeys - 候选路径键名。
 * @returns `hits`（按时间倒序的路径条目）与日志里顺带读到的 `title`。
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
      // 标题也写在日志里；readTitleSnapshots 失败时可以拿它兜底。
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
 * @param fs - 文件系统服务。
 * @param path - 绝对路径。
 * @param signal - 取消信号。
 * @returns 存在为 true；服务缺席或探测出错时为 false。
 */
async function probeExists(fs, path, signal) {
  if (fs === undefined || fs === null) return false;
  try {
    const target = await fs.resolve(path, { signal });
    return (await fs.stat(target, signal)) !== undefined;
  } catch {
    return false;
  }
}

/**
 * 用 `callId → 标题` 读一批会话标题。
 *
 * 标题是独立事件、不在 header 里，所以走 readTitleSnapshots 批量读；整批失败
 * 不算错误，标题只是锦上添花，调用方还有日志内的兜底。
 * @param sessionQuery - 会话查询服务。
 * @param sessionIds - 要读标题的会话 id。
 * @param signal - 取消信号。
 * @returns id 到标题的映射（可能为空）。
 */
async function readTitles(sessionQuery, sessionIds, signal) {
  const titles = new Map();
  if (typeof sessionQuery.readTitleSnapshots !== 'function') return titles;
  try {
    const snapshots = await sessionQuery.readTitleSnapshots(sessionIds, signal);
    for (const item of snapshots) {
      if (item === null || typeof item !== 'object' || item.status !== 'fulfilled') continue;
      const title = item.value !== null && typeof item.value === 'object' ? item.value.title?.title : undefined;
      const normalized = normalizeTitle(title);
      if (normalized !== undefined) titles.set(String(item.sessionId), normalized);
    }
  } catch {
    // 批量标题读取失败不影响血统结果。
  }
  return titles;
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
  const wantedTools = new Set(mutateTools);

  ctx.tools.register(
    defineTool({
      name: 'file_lineage',
      description:
        'Search every past DSH session for files that were created or modified, and report the absolute path plus the session, turn and tool that wrote it. ' +
        'Use it whenever you or the user need to locate a file produced in an earlier session, or to explain where a file came from — it replaces guessing paths and re-listing whole directories. ' +
        'Lineage is inferred from the arguments of file-mutating tool calls (write/edit/present by default); failed calls are excluded, and repeated writes to one path collapse into a single entry with a count. ' +
        'Read-only: it never writes, and it reads session history locally without touching the network. ' +
        '跨会话检索产出文件并给出血统（绝对路径 / 会话 / 会话标题 / 回合 / 工具 / 次数 / 时间 / 是否仍存在）。',
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
            'ISO 8601 时间戳，只返回此时间之后写入的文件（例如 "2026-09-01"）。省略则用 defaultDays 回溯窗口。',
        },
        limit: {
          type: 'number',
          description: `返回的最大条目数，默认 30，上限 ${LIMIT_MAX}。`,
        },
        groupBySession: {
          type: 'boolean',
          description: '为 true 时额外按会话分组返回，便于看清「哪一次会话产出了这批文件」。',
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
                sessions: { type: 'integer', required: true, description: '成功读取的会话数。' },
                candidates: { type: 'integer', required: true, description: '窗口内候选会话数。' },
                since: { type: 'string', required: true, description: '本次检索的时间下界（ISO 8601）。' },
                truncated: { type: 'boolean', required: true, description: '候选会话数超过 maxSessions，结果可能不完整。' },
                resolved: { type: 'boolean', required: true, description: '是否可用 ctx.fs 把路径绝对化。' },
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
                  exists: { type: 'boolean', required: true, description: '文件现在是否还存在。' },
                  cwd: { type: 'string', description: '该会话的工作目录。' },
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
        render: (_args, value) => {
          const head = value.scanned;
          const lines = [];
          const note = head.truncated === true ? ' 注意：候选会话超过 maxSessions 上限，结果可能不完整。' : '';

          if (value.count === 0) {
            lines.push(`未找到匹配的产出文件（扫描 ${head.sessions}/${head.candidates} 个会话，自 ${head.since} 起）。`);
            lines.push('提示：调大 query 更宽泛的片段、显式传更早的 since，或调大 maxSessions。');
            if (note !== '') lines.push(note);
            return [{ type: 'text', text: lines.join('\n') }];
          }

          lines.push(`找到 ${value.count} 条血统记录（扫描 ${head.sessions}/${head.candidates} 个会话，自 ${head.since} 起）：`);
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
          if (head.resolved === false) lines.push(' 注意：ctx.fs 不可用，路径按会话记录原样返回，未绝对化。');
          if (note !== '') lines.push(note);
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

        const sessionQuery = ctx.sessionQuery;
        // `fs` 是**可选**服务，必须走 ctx.get() 取值：直接写 `ctx.fs` 会抛出
        // "cannot get property \"fs\" without inject"（未声明 inject 的硬读取会被
        // Cordis 拒绝），而把它写进 inject 又会让缺 `fs` 的组合整个 fiber 停在
        // PENDING。两者都会让插件在一个完全正常的组合里不可用。
        const fs = ctx.get('fs');

        // listSessions 已经按最新优先返回，直接取前 maxSessions 个。
        // 不用 header.createdAt 预筛掉旧会话：会话可以被恢复，九十天前建的会话今天
        // 仍在写文件，那种写入同样是窗口内的产出。since 只过滤事件时间（下面按
        // hit.time 判断），收窄扫描量的旋钮是 maxSessions。
        const records = await sessionQuery.listSessions(signal);
        const truncated = records.length > maxSessions;
        const selected = records.slice(0, maxSessions);

        const titles = await readTitles(
          sessionQuery,
          selected.map((record) => record.header.id),
          signal,
        );

        const hits = [];
        let scanned = 0;
        let resolved = fs !== undefined && fs !== null;

        for (const record of selected) {
          if (signal?.aborted) break;
          const sessionId = String(record.header.id);
          let folded;
          try {
            // readSession 是唯一返回完整事件的读路径：listEvents / filterEvents
            // 都会剥掉 data，拿不到工具参数，因此推断不了血统。
            const snapshot = await sessionQuery.readSession(sessionId);
            folded = foldMutations(snapshot.events ?? [], wantedTools, pathKeys);
          } catch {
            continue; // 单个会话读失败只跳过它，绝不让整次检索失败。
          }
          scanned += 1;

          const title = titles.get(sessionId) ?? folded.title;
          const cwd = typeof record.header.cwd === 'string' ? record.header.cwd : undefined;

          for (const hit of folded.hits) {
            if (hit.time < sinceMs) continue;
            const absolute = await absolutize(fs, hit.path, cwd);
            if (absolute.resolved === false) resolved = false;
            if (query !== '' && !absolute.path.toLowerCase().includes(query)) continue;
            if (prefix !== '' && !absolute.path.toLowerCase().startsWith(prefix)) continue;
            const entry = {
              path: absolute.path,
              name: absolute.path.split(/[\\/]/).pop() ?? absolute.path,
              tool: hit.tool,
              count: hit.count,
              time: hit.time,
              sessionId,
              turn: hit.turn,
              title,
              cwd,
            };
            hits.push(entry);
          }
        }

        hits.sort((a, b) => b.time - a.time || a.path.localeCompare(b.path));

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
            exists: await probeExists(fs, hit.path, signal),
          };
          if (typeof hit.title === 'string' && hit.title !== '') entry.sessionTitle = hit.title;
          if (typeof hit.cwd === 'string' && hit.cwd !== '') entry.cwd = hit.cwd;
          files.push(entry);
        }

        const result = {
          scanned: {
            sessions: scanned,
            candidates: selected.length,
            since: new Date(sinceMs).toISOString(),
            truncated,
            resolved,
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
