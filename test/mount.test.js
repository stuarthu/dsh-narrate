// T-11 的测试。契约：docs/crew/api/flow-stages.md、docs/crew/api/assetsindex-shotplan.md
//
// 这个文件里最要紧的一条是「schema 只用 dsh 允许的关键字」。dsh 的
// `tools.register` 会用一个**很窄的** JSON Schema 子集校验 output.schema，写错了
// 挂载在启动时就抛异常——等于把用户的整个 dsh profile 弄坏。所以这里照抄那套规则
// 自己查一遍，不指望在别人的机器上能 import 到 dsh。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { apply, inject, TOOL_NAMES } from '../host/narrate.js';
import { readClipFile } from '../src/assets-index/clip-file.js';
import { readJob } from '../src/flow/job.js';

const tmp = () => mkdtemp(join(tmpdir(), 'narrate-mount-'));

/** dsh-tools 允许的关键字子集，抄自 dsh-tools/lib/index.js 的两个集合。 */
const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
]);
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/** 照 dsh 的规则查一个 schema，返回违规说明。 */
function schemaViolations(node, path = 'schema', out = []) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    out.push(`${path} 必须是一个 schema 对象`);
    return out;
  }
  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue;
    out.push(`${path}.${key} 不是允许的关键字`);
  }
  if (node.type !== undefined && !SCHEMA_TYPES.has(node.type)) out.push(`${path}.type 不认识：${node.type}`);
  for (const [k, v] of Object.entries(node.properties ?? {})) schemaViolations(v, `${path}.properties.${k}`, out);
  if (node.items !== undefined) schemaViolations(node.items, `${path}.items`, out);
  for (const [i, arm] of (node.oneOf ?? []).entries()) schemaViolations(arm, `${path}.oneOf[${i}]`, out);
  return out;
}

/** 值符合 schema 吗。只支持我们自己用到的那些关键字。 */
function valueViolations(value, schema, path = 'value', out = []) {
  const t = schema.type;
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (t !== undefined) {
    const okType = t === 'integer' ? Number.isInteger(value) : kind === t;
    if (!okType) { out.push(`${path} 应该是 ${t}，实际是 ${kind}`); return out; }
  }
  if (t === 'object') {
    for (const req of schema.required ?? []) {
      if (!Object.hasOwn(value, req)) out.push(`${path}.${req} 是必填的但不在返回值里`);
    }
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (sub === undefined) {
        if (schema.additionalProperties === false) out.push(`${path}.${k} 不在 schema 里`);
        continue;
      }
      valueViolations(v, sub, `${path}.${k}`, out);
    }
  }
  if (t === 'array' && schema.items) {
    for (const [i, item] of value.entries()) valueViolations(item, schema.items, `${path}[${i}]`, out);
  }
  return out;
}

/** 假的宿主上下文，记下注册了什么。 */
function fakeCtx() {
  const registered = new Map();
  const disposed = [];
  return {
    tools: {
      register(definition) {
        registered.set(definition.name, definition);
        return () => disposed.push(definition.name);
      },
    },
    on() {},
    registered,
    disposed,
  };
}

function mount(config) {
  const ctx = fakeCtx();
  apply(ctx, config);
  return ctx;
}

/** 调一个工具，并顺手校验它的返回值符合自己声明的 schema。 */
async function call(ctx, name, args) {
  const tool = ctx.registered.get(name);
  assert.ok(tool, `没有注册 ${name}`);
  const value = await tool.execute(args);
  const bad = valueViolations(value, tool.output.schema);
  assert.deepEqual(bad, [], `${name} 的返回值不符合自己声明的 schema：${bad.join('；')}`);
  return value;
}

describe('T-11 挂载的形状（写错就把用户的 dsh 弄坏）', () => {
  test('inject 里声明了 tools，否则宿主会抛 cannot get property without inject', () => {
    assert.ok(inject.includes('tools'));
  });

  test('注册的工具就是 TOOL_NAMES 那几个，全部以 narrate_ 开头', () => {
    const ctx = mount();
    assert.deepEqual([...ctx.registered.keys()].sort(), [...TOOL_NAMES].sort());
    for (const name of TOOL_NAMES) assert.match(name, /^narrate_[a-z_]+$/);
    assert.ok(!TOOL_NAMES.includes('run_code'), 'run_code 是 dsh 保留名');
  });

  test('每个工具都有 dsh 要求的那几样：description、parameters、output.schema、output.render、execute', () => {
    const ctx = mount();
    for (const [name, tool] of ctx.registered) {
      assert.equal(typeof tool.description, 'string', `${name} 缺 description`);
      assert.ok(tool.description.length > 20, `${name} 的 description 太短，agent 看不懂什么时候该用它`);
      assert.equal(tool.parameters?.type, 'object', `${name} 的 parameters 根必须是 object`);
      assert.equal(typeof tool.output?.render, 'function', `${name} 缺 output.render`);
      assert.ok(tool.output?.schema, `${name} 缺 output.schema`);
      assert.equal(typeof tool.execute, 'function', `${name} 缺 execute`);
      if (tool.timeoutMs !== undefined) assert.ok(tool.timeoutMs > 0, `${name} 的 timeoutMs 必须是正数`);
    }
  });

  test('A-30：每个 schema 只用 dsh 允许的关键字子集', () => {
    const ctx = mount();
    for (const [name, tool] of ctx.registered) {
      assert.deepEqual(schemaViolations(tool.parameters), [], `${name} 的 parameters 有不允许的关键字`);
      assert.deepEqual(schemaViolations(tool.output.schema), [], `${name} 的 output.schema 有不允许的关键字`);
    }
  });

  test('配置缺失时插件照样加载，不抛异常', () => {
    for (const config of [undefined, null, {}, { workdir: 123 }]) {
      assert.doesNotThrow(() => mount(config), `config = ${JSON.stringify(config)} 时不该抛`);
    }
  });

  test('dispose 会把注册的工具全部注销', () => {
    const registered = new Map();
    const disposed = [];
    let onDispose;
    apply({
      tools: { register(d) { registered.set(d.name, d); return () => disposed.push(d.name); } },
      on(event, fn) { if (event === 'dispose') onDispose = fn; },
    });
    onDispose();
    assert.deepEqual(disposed.sort(), [...TOOL_NAMES].sort());
  });

  test('render 返回的是内容块，不是裸字符串数组', async () => {
    // 这条是真跑一次才补上的。原来只断言"可 JSON 化"，六个工具全绿，
    // 但在真的 dsh 会话里 agent 看到的是 `(no output)`——工具是哑的。
    // dsh 要的形状是 [{ type: 'text', text: '…' }]（见 dsh-ffmpeg 的 buildTextRenderer）。
    const ctx = mount();
    for (const [name, tool] of ctx.registered) {
      const rendered = tool.output.render({}, {});
      assert.ok(Array.isArray(rendered), `${name} 的 render 必须返回数组`);
      assert.ok(rendered.length > 0, `${name} 的 render 不能返回空数组，那就是 (no output)`);
      for (const block of rendered) {
        assert.equal(typeof block, 'object', `${name} 的 render 返回了裸字符串，agent 会看到 (no output)`);
        assert.equal(block.type, 'text', `${name} 的内容块缺 type: 'text'`);
        assert.equal(typeof block.text, 'string', `${name} 的内容块缺 text`);
      }
      assert.doesNotThrow(() => JSON.parse(JSON.stringify(rendered)), `${name} 的 render 返回了不可 JSON 化的东西`);
    }
  });

  test('render 对真实返回值也给出看得见的文字', async () => {
    const ctx = mount({ workdir: await tmp() });
    const tool = ctx.registered.get('narrate_start');
    const value = await tool.execute({ idea: '一句想法' });
    const [block] = tool.output.render({}, value);
    assert.ok(block.text.includes(value.jobDir), '渲染出来的文字里该看得到任务目录');
    assert.ok(block.text.includes('IQ-1'), '渲染出来的文字里该看得到问题，否则 agent 还得自己翻返回值');
    assert.ok(block.text.length > 40, `渲染出来只有 ${block.text.length} 个字，太少`);
  });
});

describe('T-11 停点 1 和 2 真的接上了', () => {
  test('narrate_start 建任务，返回反问和下一步', async () => {
    const ctx = mount({ workdir: await tmp() });
    const started = await call(ctx, 'narrate_start', { idea: '讲清楚 Rust 为什么快' });
    assert.ok(started.jobDir.length > 0);
    assert.ok(started.questions.length >= 3);
    assert.ok(started.questions.every((q) => q.id && q.text && q.suggestion));
    assert.ok(started.nextStep.includes('narrate_answer'), '要告诉 agent 下一步调什么');
    assert.equal((await readJob(started.jobDir)).idea, '讲清楚 Rust 为什么快');
  });

  test('narrate_answer 记下回答，并说还差几个', async () => {
    const ctx = mount({ workdir: await tmp() });
    const { jobDir, questions } = await call(ctx, 'narrate_start', { idea: 'x' });
    const one = await call(ctx, 'narrate_answer', { jobDir, questionId: questions[0].id, answer: '八分钟' });
    assert.equal(one.complete, false);
    assert.equal(one.remaining.length, questions.length - 1);
    for (const q of questions.slice(1)) {
      await call(ctx, 'narrate_answer', { jobDir, questionId: q.id, answer: '随便' });
    }
    const done = await call(ctx, 'narrate_answer', { jobDir, questionId: questions[0].id, answer: '八分钟' });
    assert.equal(done.complete, true);
    assert.ok(done.nextStep.includes('narrate_script'));
  });

  test('A-29：问题没答完时，narrate_script 自己报错', async () => {
    const ctx = mount({ workdir: await tmp() });
    const { jobDir } = await call(ctx, 'narrate_start', { idea: 'x' });
    await assert.rejects(
      () => ctx.registered.get('narrate_script').execute({ jobDir, sentences: ['偷跑'] }),
      (e) => /E_INTERVIEW_INCOMPLETE/.test(e.message),
      '必须是工具自己硬拦，不能只写在说明里',
    );
    assert.equal((await readJob(jobDir)).script, undefined);
  });

  test('agent 交上来的文稿被编号、校验、存盘', async () => {
    const ctx = mount({ workdir: await tmp() });
    const { jobDir, questions } = await call(ctx, 'narrate_start', { idea: 'x' });
    for (const q of questions) await call(ctx, 'narrate_answer', { jobDir, questionId: q.id, answer: 'x' });
    const written = await call(ctx, 'narrate_script', {
      jobDir,
      sentences: ['第一句。', '  第二句。  ', ''],
    });
    assert.deepEqual(written.sentences.map((s) => s.id), ['S-001', 'S-002']);
    assert.equal(written.sentences[1].text, '第二句。');
    assert.equal((await readJob(jobDir)).script.sentences.length, 2);
  });

  test('narrate_status 在每个阶段都说得出下一步', async () => {
    const ctx = mount({ workdir: await tmp() });
    const { jobDir, questions } = await call(ctx, 'narrate_start', { idea: 'x' });
    const atOne = await call(ctx, 'narrate_status', { jobDir });
    assert.equal(atOne.stopPoint, 1);
    assert.ok(atOne.nextStep.includes('narrate_answer'));

    for (const q of questions) await call(ctx, 'narrate_answer', { jobDir, questionId: q.id, answer: 'x' });
    assert.ok((await call(ctx, 'narrate_status', { jobDir })).nextStep.includes('narrate_script'));

    await call(ctx, 'narrate_script', { jobDir, sentences: ['一句话'] });
    const atTwo = await call(ctx, 'narrate_status', { jobDir });
    assert.equal(atTwo.stopPoint, 2);
    assert.ok(atTwo.waitingForUser, '停点 2 要等用户点头');
  });
});

describe('T-11 素材那一埋：只报不做', () => {
  async function assets() {
    const root = await tmp();
    await mkdir(root, { recursive: true });
    return root;
  }

  test('A-28：不带理解器扫素材，列出需要理解的，而且一次理解都没调', async () => {
    const root = await assets();
    // 造两个真的能被 ffprobe 读出时长的小视频
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    for (const name of ['a.mp4', 'b.mp4']) {
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'color=c=black:s=320x180:r=10:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(root, name)]);
    }
    const ctx = mount({ workdir: await tmp() });
    const indexed = await call(ctx, 'narrate_index', { assetsRoot: root });
    assert.deepEqual(indexed.needsUnderstanding.map((p) => basename(p)).sort(), ['a.mp4', 'b.mp4']);
    assert.ok(indexed.nextStep.includes('narrate_describe'), '要告诉 agent 拿这份清单去调 video_understand');
    // 时长这类便宜的东西已经量好了，贵的理解还没做
    const rec = await readClipFile(join(root, 'a.mp4'));
    assert.ok(rec.measured.durationSec > 0, '时长该已经量好');
    assert.deepEqual(rec.fromMachine, {}, '理解那一节该还是空的');
  });

  test('narrate_describe 用我们量的时长，不信 agent 报的', async () => {
    const root = await assets();
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const clip = join(root, 'a.mp4');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'color=c=black:s=320x180:r=10:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
    const ctx = mount({ workdir: await tmp() });
    await call(ctx, 'narrate_index', { assetsRoot: root });

    const described = await call(ctx, 'narrate_describe', {
      clipPath: clip,
      durationSec: 999,            // agent 瞎报的时长
      segments: [{ startSec: 0, endSec: 999, description: '一片黑' }],
    });
    assert.ok(Math.abs(described.durationSec - 3) < 0.3, `该用我们量的 3 秒，实际 ${described.durationSec}`);
    const rec = await readClipFile(clip);
    assert.ok(rec.fromMachine.segments.length > 0);
    assert.ok(rec.fromMachine.segments[0].endSec <= 3.1, 'agent 报的 999 秒该被截到真实时长');
  });

  test('只给一句整体描述也行，会补成覆盖全长的一段', async () => {
    const root = await assets();
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const clip = join(root, 'a.mp4');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'color=c=black:s=320x180:r=10:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
    const ctx = mount({ workdir: await tmp() });
    await call(ctx, 'narrate_index', { assetsRoot: root });
    await call(ctx, 'narrate_describe', { clipPath: clip, description: '一片黑，什么都没有' });
    const rec = await readClipFile(clip);
    assert.equal(rec.fromMachine.segments.length, 1);
    assert.equal(rec.fromMachine.segments[0].description, '一片黑，什么都没有');
    assert.equal(rec.fromMachine.segments[0].confidence, 'low');
  });
});

describe('T-11 A-15：装得进 dsh', () => {
  test('package.json 声明了 dsh.bundle，而它指的文件真的存在', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const patch = pkg.dsh?.bundle?.patch;
    assert.ok(patch, 'dsh.bundle.patch 没声明，dsh plugin add 不会把它当 bundle');
    const path = new URL(`../${patch.replace(/^\.\//, '')}`, import.meta.url);
    await access(path); // 读不到就抛——dsh-app-boot 也是这么抛的，会弄坏整个 profile
  });

  test('发布清单里带上 host 和 cordis.patch.yml，否则装了也没有挂载入口', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    for (const needed of ['host', 'cordis.patch.yml', 'src']) {
      assert.ok(pkg.files.includes(needed), `files 里少了 ${needed}`);
    }
  });

  test('cordis.patch.yml 里插入的行指向本包', async () => {
    const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
    assert.match(text, /-\s*insert:/);
    assert.match(text, /dsh-narrate\/host\/narrate\.js/);
  });
});

describe('T-11 用 dsh 自己的校验器验一遍（导不到就出声跳过）', () => {
  /** 先按包名找，找不到就找 dsh profile 里那份。都没有就跳过。 */
  async function loadDshTools() {
    for (const spec of [
      '@deepseek-ai/dsh-tools',
      `${process.env.HOME}/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js`,
    ]) {
      try {
        return await import(spec);
      } catch { /* 换下一个 */ }
    }
    return null;
  }

  test('每个 parameters 和 output.schema 都能过 dsh 真正的 assertSupportedJsonSchema', async (t) => {
    const dsh = await loadDshTools();
    if (!dsh?.assertSupportedJsonSchema) {
      t.skip('跳过：这台机器上导入不到 @deepseek-ai/dsh-tools。上面那条抄写的子集规则仍然在查');
      return;
    }
    const ctx = mount();
    for (const [name, tool] of ctx.registered) {
      assert.doesNotThrow(() => dsh.assertSupportedJsonSchema(tool.parameters),
        `${name} 的 parameters 过不了 dsh 的校验，挂载会在启动时抛异常`);
      assert.doesNotThrow(() => dsh.assertSupportedJsonSchema(tool.output.schema),
        `${name} 的 output.schema 过不了 dsh 的校验`);
    }
  });

  test('每个工具的真实返回值都能过 dsh 的 validateJsonSchemaValue', async (t) => {
    const dsh = await loadDshTools();
    if (!dsh?.validateJsonSchemaValue) {
      t.skip('跳过：导入不到 dsh-tools 的值校验器。上面每次 call() 都在用抄写的那份查');
      return;
    }
    const ctx = mount({ workdir: await tmp() });
    const started = await ctx.registered.get('narrate_start').execute({ idea: '一句想法' });
    const checks = [['narrate_start', started]];

    for (const q of started.questions) {
      const answered = await ctx.registered.get('narrate_answer')
        .execute({ jobDir: started.jobDir, questionId: q.id, answer: '随便' });
      checks.push(['narrate_answer', answered]);
    }
    checks.push(['narrate_script', await ctx.registered.get('narrate_script')
      .execute({ jobDir: started.jobDir, sentences: ['一句话'] })]);
    checks.push(['narrate_status', await ctx.registered.get('narrate_status')
      .execute({ jobDir: started.jobDir })]);

    for (const [name, value] of checks) {
      const schema = ctx.registered.get(name).output.schema;
      const violations = dsh.validateJsonSchemaValue(value, schema);
      const bad = Array.isArray(violations) ? violations : [];
      assert.deepEqual(bad, [], `${name} 的返回值过不了自己声明的 schema：${bad.join('；')}`);
    }
  });
});
