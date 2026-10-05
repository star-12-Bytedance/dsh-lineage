/**
 * 契约自检：把 DSH 插件的**静默失败点**钉死。
 *
 * 这些错误的共同点是**不报错**——插件看上去装好了，实际什么都没做：
 *   1. 只用 `export default` → Loader 的 unwrapExports 会折叠它并丢掉 `inject`
 *   2. 漏掉命名导出 → `apply` 从未被调用，插件无声消失
 *   3. `inject` 声明了服务但服务缺席 → fiber 停在 PENDING，同样无声消失
 *   4. `parameters` 多写了 `type`/`properties` 包裹层 → 参数被当成名叫 "type" 的字段
 *   5. `package.json` 少了 `dsh.bundle.patch`，或 `files` 漏掉补丁文件 → 装了不挂载
 *   6. 空数据下 `execute` / `render` 抛错 → 第一次真实调用才炸
 *
 * 分三档执行：
 *   静态检查 / 包契约检查 —— 不需要任何依赖，CI 里也能跑，失败即退出码 1。
 *   装配检查 —— 需要解析 `@deepseek-ai/*`。解析不到时默认 SKIP 并仍然成功退出；
 *              传 `--strict`（CI 用）则把 SKIP 视为失败。
 *
 * 本地开发先建好依赖软链，装配检查才会真正执行：
 *   mklink /J node_modules "<DSH>/resources/app/dsh/node_modules"   (Windows)
 *   ln -s "<DSH>/resources/app/dsh/node_modules" node_modules       (macOS/Linux)
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const entry = join(root, 'index.js');
const strict = process.argv.includes('--strict') || process.env.DSH_LINEAGE_STRICT_CHECK === '1';

let failures = 0;
let skips = 0;
const pass = (msg) => console.log(`  \u2713 ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.error(`  \u2717 ${msg}`);
};
const skip = (msg) => {
  skips += 1;
  console.log(`  \u2500 SKIP ${msg}`);
};
const check = (label, ok, detail = '') => {
  if (ok) pass(detail === '' ? label : `${label}  (${detail})`);
  else fail(detail === '' ? label : `${label}  (${detail})`);
};

console.log('DSH 插件契约自检 (@xinghe-source/dsh-lineage)\n');

// ---- 0. 文本预处理 -------------------------------------------------------
/**
 * 去掉注释后再做文本匹配。这个脚本和 index.js 的文档都会提到 `export default`
 * 这个词，不剥离注释会把自己判成违规。
 * @param text - 源码全文。
 * @returns 注释被替换成空白的源码，保留原有换行以便定位。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix) => prefix + ' '.repeat(match.length - prefix.length));
}

const source = await readFile(entry, 'utf8');
const code = stripComments(source);

// ---- 1. 静态检查：导出形态 -----------------------------------------------
console.log('静态检查');

if (/export\s+default\b/.test(code)) {
  fail('发现 `export default` —— Loader 会折叠它并静默丢掉 inject');
} else {
  pass('没有 export default');
}

const exportStatement = /export\s*\{([^}]*)\}/.exec(code);
const exportedNames =
  exportStatement === null
    ? []
    : exportStatement[1]
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '');

for (const required of ['apply', 'inject', 'name', 'Config']) {
  if (exportedNames.includes(required)) pass(`命名导出包含 ${required}`);
  else fail(`命名导出缺少 ${required} —— 插件不会正常装配`);
}
if (exportStatement !== null) pass(`末尾命名导出语句：export { ${exportedNames.join(', ')} }`);
else fail('找不到末尾的 `export { ... }` 语句');

// 声明处不能再挂 export，否则会与本行重复导出（语法错误，模块直接加载失败）。
for (const name of ['name', 'inject', 'Config', 'apply']) {
  if (new RegExp(`export\\s+(const|function|let|var|class)\\s+${name}\\b`).test(code)) {
    fail(`\`export { ${name} }\` 与声明处重复导出 —— 会抛 SyntaxError: Duplicate export`);
  }
}
pass('声明处没有重复导出');

// 顶层裸导入必须是 DSH 自己的包，且只有这两个。
const bareImports = [...code.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
const unexpected = bareImports.filter((spec) => !spec.startsWith('@deepseek-ai/'));
if (unexpected.length > 0) fail(`引入了非 DSH 依赖：${unexpected.join(', ')}`);
else pass(`裸导入全部来自 @deepseek-ai：${bareImports.join(', ')}`);

// ---- 2. 包契约检查：发布与挂载 ------------------------------------------
console.log('\n包契约检查');

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const patchPath = pkg.dsh?.bundle?.patch;

if (typeof patchPath === 'string' && patchPath !== '') pass(`package.json 声明了 dsh.bundle.patch = ${patchPath}`);
else fail('package.json 缺少 dsh.bundle.patch —— 装了不会挂载');

if (Array.isArray(pkg.files) && pkg.files.includes(patchPath?.replace(/^\.\//, ''))) {
  pass(`files 数组包含补丁文件 ${patchPath}`);
} else {
  fail(`files 数组没有包含 ${patchPath} —— 发布出去就少了挂载补丁`);
}

if (pkg.type === 'module') pass('package.json type = module');
else fail('package.json 缺少 "type": "module" —— ESM 入口加载不了');

if (pkg.main === 'index.js') pass('main = index.js');
else fail(`main = ${pkg.main}，与仓库入口不一致`);

const peers = Object.keys(pkg.peerDependencies ?? {});
if (peers.length > 0) pass(`peerDependencies：${peers.join(', ')}`);
else fail('没有声明任何 peerDependencies');

// 补丁文件必须真的存在，且 id / name 与 package.json 对得上。
const patchFile = join(root, patchPath ?? 'cordis.patch.yml');
try {
  const patch = await readFile(patchFile, 'utf8');
  pass(`${patchPath} 存在（${patch.split('\n').length} 行）`);
  if (patch.includes(`name: '${pkg.name}'`) || patch.includes(`name: "${pkg.name}"`)) {
    pass(`补丁里的 name 与包名一致：${pkg.name}`);
  } else {
    fail(`补丁里找不到 name: '${pkg.name}' —— 挂载的会是别的包`);
  }
  if (/^- insert:/m.test(patch)) pass('补丁使用 insert 语义');
  else fail('补丁缺少 `- insert:` 段');
} catch {
  fail(`${patchPath} 不存在`);
}

// ---- 3. 装配检查：注册工具 + 空态执行 ------------------------------------
console.log('\n装配检查');

let mod;
try {
  mod = await import(new URL('../index.js', import.meta.url).href);
} catch (error) {
  const missing = error.code === 'ERR_MODULE_NOT_FOUND';
  if (missing) {
    const message = `依赖解析不到（${error.message.split('\n')[0]}）`;
    if (strict) fail(`${message} —— --strict 下不允许跳过装配检查`);
    else {
      skip(`${message}；装配检查未执行`);
      console.log(
        '    → 建一个指向 DSH node_modules 的软链后重跑：\n' +
          '      mklink /J node_modules "<DSH>/resources/app/dsh/node_modules"   (Windows)\n' +
          '      ln -s "<DSH>/resources/app/dsh/node_modules" node_modules       (macOS/Linux)',
      );
    }
  } else {
    fail(`模块无法加载：${error.code ?? ''} ${error.message.split('\n')[0]}`);
  }
}

if (mod !== undefined) {
  if (typeof mod.apply === 'function') pass('apply 是可调用的函数');
  else fail(`apply 类型为 ${typeof mod.apply}，应为 function`);

  if (Array.isArray(mod.inject)) pass(`inject 是数组：${JSON.stringify(mod.inject)}`);
  else fail('inject 不是数组');

  if (typeof mod.name === 'string' && mod.name !== '') pass(`name = ${mod.name}`);
  else fail('name 为空');

  if (mod.default === undefined) pass('运行时无 default 导出');
  else fail('运行时存在 default 导出');

  // Config 的默认值就是文档承诺的默认值，这里直接对着文档断言。
  let resolved;
  try {
    resolved = mod.Config({});
    pass(`Config 可解析，默认值：${JSON.stringify(resolved)}`);
  } catch (error) {
    fail(`Config 解析失败：${error.message}`);
  }
  const expectedDefaults = {
    mutateTools: ['write', 'edit', 'present'],
    pathKeys: ['path', 'file_path', 'filePath', 'notebook_path', 'target_file'],
    defaultDays: 90,
    maxSessions: 40,
    sessionCacheSize: 200,
  };
  for (const [key, expected] of Object.entries(expectedDefaults)) {
    const actual = resolved?.[key];
    if (JSON.stringify(actual) === JSON.stringify(expected)) pass(`Config.${key} 默认 = ${JSON.stringify(expected)}`);
    else fail(`Config.${key} 默认是 ${JSON.stringify(actual)}，文档写的是 ${JSON.stringify(expected)}`);
  }

  // 用一个空语料的 ctx 走一遍真实注册 + 执行路径。
  // `get` 是可选服务的唯一正确取值方式：`fs` 故意不在 inject 里，所以这里
  // **不提供** fs —— 正好把「fs 缺失时降级返回原始路径」这条路径测到。
  let tool;
  try {
    mod.apply(
      {
        tools: { register: (definition) => { tool = definition; } },
        sessionQuery: {
          async listSessions() { return []; },
          async readSession() { throw new Error('no session'); },
          async readTitleSnapshots() { return []; },
        },
        get: (key) => (key === 'fs' ? undefined : undefined),
      },
      resolved ?? {},
    );
    pass('apply 执行无异常');
  } catch (error) {
    fail(`apply 抛错：${error.message}`);
  }

  if (tool === undefined) {
    fail('未注册任何工具');
  } else {
    pass(`工具已注册：${tool.name}`);

    // 参数 DSL 的顶层必须是**平铺的参数名**。写成 { type:'object', properties:{...} }
    // 包裹层不会报错，但模型看到的会是名叫 "type" / "properties" 的两个参数。
    const paramNames = Object.keys(tool.parameters?.properties ?? {});
    const expectedParams = ['query', 'pathPrefix', 'since', 'limit', 'groupBySession', 'checkExists'];
    if (paramNames.includes('type') || paramNames.includes('properties')) {
      fail(`parameters 顶层出现了 ${paramNames.filter((n) => n === 'type' || n === 'properties').join('/')} —— 多写了包裹层`);
    } else if (expectedParams.every((name) => paramNames.includes(name))) {
      pass(`parameters 平铺且完整：${paramNames.join(', ')}`);
    } else {
      fail(`parameters 缺少文档承诺的参数，现有：${paramNames.join(', ')}`);
    }
    if (tool.parameters?.type === 'object') pass('defineTool 已把参数规范化成 object JSON Schema');
    else fail('参数没有被规范化成 JSON Schema');

    const outProps = Object.keys(tool.output?.schema?.properties ?? {});
    if (outProps.length > 0) pass(`输出 schema 有 ${outProps.length} 个字段：${outProps.join(', ')}`);
    else fail('输出 schema 为空 —— 模型拿不到结构化结果');

    try {
      const empty = await tool.execute({}, { signal: undefined });
      if (empty?.count === 0 && Array.isArray(empty.files)) pass('空语料 execute 正常：count=0');
      else fail(`空语料 execute 返回异常：${JSON.stringify(empty)?.slice(0, 120)}`);

      const rendered = tool.output.render({}, empty);
      const text = rendered?.[0]?.text;
      if (typeof text === 'string' && text !== '') pass(`空结果 render 有明确文案：${text.split('\n')[0]}`);
      else fail('空结果 render 未返回文本');

      const bad = await tool.execute({ query: 'x' }, { signal: undefined });
      if (bad.count === 0) pass('带 query 的空语料 execute 正常');
      else fail('带 query 的空语料 execute 返回异常');
    } catch (error) {
      fail(`空数据 execute/render 抛错：${error.message}`);
    }

    try {
      await tool.execute({ since: '不是时间' }, { signal: undefined });
      fail('非法 since 没有报错 —— 应当明确拒绝');
    } catch (error) {
      pass(`非法 since 被拒绝：${error.message}`);
    }
  }
}

// ---- 4. 读取策略检查：since 剪枝 / 会话缓存 / 存在性检查 -------------------
//
// 这一段用可控语料把三个**成本开关**钉死。它们都是「看着能用但实际没生效」的高危区：
// 剪枝写错了会漏结果（比慢更糟），存在性检查默认开着会变成瓶颈，缓存不失效会给出
// 过期血统。所以这里对同一份语料连续查询，断言「结果不变、重放次数下降」。
if (mod !== undefined) {
  console.log('\n读取策略检查');

  const MIN = 60_000;
  const DAY = 86_400_000;
  const T0 = Date.parse('2026-01-01T00:00:00Z');
  const call = (seq, time, callId, filePath) => ({
    type: 'tool/call',
    seq,
    time,
    data: { turn: 1, step: 1, callId, name: 'write', arguments: JSON.stringify({ file_path: filePath, content: 'x' }) },
  });
  const result = (seq, time, callId) => ({
    type: 'tool/result',
    seq,
    time,
    data: { turn: 1, step: 1, message: { toolCallId: callId } },
  });

  /**
   * 造一个语料与全套服务替身。
   * @param options - `sessions` 语料；`revisions` 模拟持久层版本令牌（Map，缺省表示
   *   持久层服务不可用）；`fsAvailable` 是否提供 fs。
   * @returns 注册好的工具与调用计数器。
   */
  function harness(options) {
    const { sessions, revisions, fsAvailable = true } = options;
    const counters = { readSession: 0, statCalls: 0, statProbes: 0 };
    const readIds = [];
    let tool;
    const ctx = {
      tools: { register: (definition) => { tool = definition; } },
      sessionQuery: {
        async listSessions() {
          return sessions.map((s) => ({ header: s.header, live: s.live === true, persisted: true }));
        },
        async readSession(id) {
          counters.readSession += 1;
          readIds.push(String(id));
          const found = sessions.find((s) => s.header.id === id);
          if (found === undefined) throw new Error('SESSION_QUERY_SESSION_NOT_FOUND');
          return { session: {}, inheritedEventCount: 0, events: found.events };
        },
      },
      get: (key) => {
        if (key === 'fs') {
          if (!fsAvailable) return undefined;
          return {
            async resolve(p, opts = {}) {
              return { targetKey: resolvePath(opts.cwd ?? process.cwd(), p), displayPath: p };
            },
            processPath: (target) => String(target.targetKey),
            async stat() {
              counters.statCalls += 1;
              return { type: 'file', size: 1 };
            },
          };
        }
        if (key === 'sessionPersistence') {
          if (revisions === undefined) return undefined;
          return {
            async stat(id) {
              counters.statProbes += 1;
              const revision = revisions.get(String(id));
              return revision === undefined ? undefined : { header: { id }, revision, sizeBytes: 1 };
            },
          };
        }
        return undefined;
      },
    };
    mod.apply(ctx, { defaultDays: 3650, maxSessions: 40, sessionCacheSize: 200 });
    return { tool, counters, readIds };
  }

  // 会话 old：最后一次写入在 T0+4 天；会话 recent：T0+150 天。
  // 窗口下界取 T0+100 天 —— 正好卡在两者之间，用来区分「剪枝」与「复用」。
  const OLD_FILE = 'C:\\repo\\old.md';
  const RECENT_FILE = 'C:\\repo\\recent.md';
  const sessions = [
    { header: { id: 'sess-old', createdAt: T0, cwd: 'C:\\repo' }, events: [call(1, T0 + 4 * DAY, 'a1', OLD_FILE), result(2, T0 + 4 * DAY, 'a1')] },
    { header: { id: 'sess-recent', createdAt: T0, cwd: 'C:\\repo' }, events: [call(1, T0 + 150 * DAY, 'b1', RECENT_FILE), result(2, T0 + 150 * DAY, 'b1')] },
  ];
  const revisions = new Map([['sess-old', 'rev-old-1'], ['sess-recent', 'rev-recent-1']]);

  const h = harness({ sessions, revisions });
  const SINCE = new Date(T0 + 100 * DAY).toISOString();

  const r1 = await h.tool.execute({ since: SINCE }, {});
  check('冷启动：两个会话都要重放', r1.scanned.replayed === 2 && r1.scanned.reused === 0, `replayed=${r1.scanned.replayed} reused=${r1.scanned.reused}`);
  check('冷启动：结果只含窗口内的文件', r1.count === 1 && r1.files[0].path === RECENT_FILE, `count=${r1.count}`);

  const readsAfterFirst = h.counters.readSession;
  const r2 = await h.tool.execute({ since: SINCE }, {});
  check('同参数第二次：不再重放任何日志', h.counters.readSession === readsAfterFirst, `readSession=${h.counters.readSession}`);
  check('同参数第二次：旧会话被 since 剪枝', r2.scanned.pruned === 1, `pruned=${r2.scanned.pruned}`);
  check('同参数第二次：窗口内会话复用缓存', r2.scanned.reused === 1 && r2.scanned.replayed === 0, `reused=${r2.scanned.reused} replayed=${r2.scanned.replayed}`);
  check('剪枝不改变结果（与冷启动一致）', r2.count === r1.count && JSON.stringify(r2.files.map((f) => f.path)) === JSON.stringify(r1.files.map((f) => f.path)));

  const r3 = await h.tool.execute({ since: new Date(T0).toISOString() }, {});
  check('放宽窗口后剪枝的会话重新参与（缓存仍持有它）', r3.count === 2 && r3.scanned.replayed === 0, `count=${r3.count} replayed=${r3.scanned.replayed}`);

  // 版本令牌变了 = 日志长了 → 必须重放，不能复用过期结论。
  revisions.set('sess-recent', 'rev-recent-2');
  sessions[1].events.push(call(3, T0 + 180 * DAY, 'b2', 'C:\\repo\\recent2.md'), result(4, T0 + 180 * DAY, 'b2'));
  const r4 = await h.tool.execute({ since: SINCE }, {});
  check('日志版本变化后强制重放并看到新文件', r4.scanned.replayed === 1 && r4.count === 2, `replayed=${r4.scanned.replayed} count=${r4.count}`);
  check('版本未变的会话仍然复用缓存', r4.scanned.pruned === 1, `pruned=${r4.scanned.pruned}`);

  // 活动会话不进缓存路径：它的内存尾部未必落盘，版本令牌代表不了它。
  const live = harness({ sessions: [{ header: { id: 'sess-live', createdAt: T0, cwd: 'C:\\repo' }, live: true, events: [call(1, T0 + MIN, 'c1', 'C:\\repo\\live.md'), result(2, T0 + MIN, 'c1')] }], revisions: new Map([['sess-live', 'rev-live-1']]) });
  await live.tool.execute({ since: '2020-01-01' }, {});
  await live.tool.execute({ since: '2020-01-01' }, {});
  check('活动会话每次都重读，不走缓存', live.counters.readSession === 2, `readSession=${live.counters.readSession}`);

  // 持久层不可用：缓存无从判断变化 → 如实退化为每次重读，结果依然正确。
  const noPersist = harness({ sessions, revisions: undefined });
  await noPersist.tool.execute({ since: '2020-01-01' }, {});
  const np2 = await noPersist.tool.execute({ since: '2020-01-01' }, {});
  // 此时语料共 3 个文件：old.md + recent.md + recent2.md。
  check('无持久层时优雅退化：结果正确', np2.count === 3, `count=${np2.count}`);
  check('无持久层时不谎报复用', np2.scanned.reused === 0 && np2.scanned.replayed === 2, `reused=${np2.scanned.reused} replayed=${np2.scanned.replayed}`);

  // --- checkExists：默认关闭，开启后有预算上限 ---
  const existsCase = () => {
    const many = [];
    for (let i = 0; i < 60; i += 1) {
      many.push(call(1 + i * 2, T0 + i * MIN, `m${i}`, `C:\\repo\\f${i}.md`));
      many.push(result(2 + i * 2, T0 + i * MIN, `m${i}`));
    }
    return harness({ sessions: [{ header: { id: 'sess-many', createdAt: T0, cwd: 'C:\\repo' }, events: many }], revisions: new Map([['sess-many', 'rev-many-1']]) });
  };

  const off = existsCase();
  const offValue = await off.tool.execute({ since: '2020-01-01', limit: 100 }, {});
  check('checkExists 默认关闭：一次 stat 都不做', off.counters.statCalls === 0, `statCalls=${off.counters.statCalls}`);
  check('checkExists 默认关闭：结果里没有 exists 字段', offValue.files.length === 60 && offValue.files.every((f) => !('exists' in f)), `files=${offValue.files.length}`);
  check('checkExists 默认关闭：existsChecked = 0', offValue.scanned.existsChecked === 0);
  check('默认的 render 不声称检查过存在性', !off.tool.output.render({}, offValue)[0].text.includes('是否存在'));

  const on = existsCase();
  const onValue = await on.tool.execute({ since: '2020-01-01', limit: 100, checkExists: true }, {});
  check('checkExists 开启：做了 stat', on.counters.statCalls > 0, `statCalls=${on.counters.statCalls}`);
  check('checkExists 开启：探测次数封顶 50', onValue.scanned.existsChecked === 50, `existsChecked=${onValue.scanned.existsChecked}`);
  check('checkExists 开启：前 50 条带 exists', onValue.files.slice(0, 50).every((f) => f.exists === true));
  check('checkExists 开启：超出预算的条目不谎报', onValue.files.slice(50).every((f) => !('exists' in f)));
  const onText = on.tool.output.render({ checkExists: true }, onValue)[0].text;
  check('render 说明了只检查了前 50 个', onText.includes('只检查了前 50 个'), onText.split('\n').at(-1));

  // --- 扫描说明必须能让人判断完整性 ---
  const scanText = h.tool.output.render({ since: SINCE }, r2)[0].text;
  check('render 报出「重放/复用/跳过」明细', scanText.includes('会话扫描：语料 2 个') && scanText.includes('跳过 1'), scanText.split('\n').at(-2));
  check('render 给出完整性结论', scanText.includes('结果完整'), scanText.split('\n').at(-1));

  const capped = harness({ sessions: Array.from({ length: 45 }, (_, i) => ({ header: { id: `s-${i}`, createdAt: T0, cwd: 'C:\\repo' }, events: [] })), revisions: new Map() });
  const cappedValue = await capped.tool.execute({ since: '2020-01-01' }, {});
  const cappedText = capped.tool.output.render({}, cappedValue)[0].text;
  check('超过 maxSessions 时标记不完整', cappedValue.scanned.truncated === true && cappedValue.scanned.complete === false, `truncated=${cappedValue.scanned.truncated}`);
  check('截断时 render 明确说明', cappedText.includes('已按 maxSessions 截断') && cappedText.includes('可能不完整'), cappedText.split('\n').slice(-2).join(' | '));
  // 非活动会话 + 没有持久日志 → 确定没有事件，跳过而不是读。
  check('无日志的非活动会话被跳过而非重放', cappedValue.scanned.empty === 40 && cappedValue.scanned.replayed === 0, `empty=${cappedValue.scanned.empty} replayed=${cappedValue.scanned.replayed}`);
}

// ---- 结果 ----------------------------------------------------------------
const suffix = skips > 0 ? `（${skips} 项跳过）` : '';
console.log(failures === 0 ? `\n结果：全部通过${suffix}` : `\n结果：${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
