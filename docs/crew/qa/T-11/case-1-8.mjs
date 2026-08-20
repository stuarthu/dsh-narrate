// T-11 的 QA 用例 1 到 8。跑法：node docs/crew/qa/T-11/case-1-8.mjs
// 计划见 docs/crew/qa/T-11-plan.md
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const { apply, TOOL_NAMES } = await import(join(ROOT, 'host/narrate.js'));
const { readClipFile } = await import(join(ROOT, 'src/assets-index/clip-file.js'));
const { readJob } = await import(join(ROOT, 'src/flow/job.js'));

let failures = 0;
const check = (name, fn) => {
  try {
    const out = fn();
    if (out instanceof Promise) return out.then(() => console.log(`  通过    ${name}`),
      (e) => { failures += 1; console.log(`  失败    ${name}\n          ${e.message}`); });
    console.log(`  通过    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  失败    ${name}\n          ${e.message}`);
  }
  return undefined;
};

function mount(config) {
  const registered = new Map();
  apply({ tools: { register: (d) => { registered.set(d.name, d); return () => {}; } }, on() {} }, config);
  return registered;
}
const tmp = () => mkdtemp(join(tmpdir(), 'qa-t11-'));

console.log('用例 1：装得进 dsh');
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
await check('dsh.bundle.patch 有声明', () => assert.ok(pkg.dsh?.bundle?.patch));
await check('它指的文件真的存在', () => access(join(ROOT, pkg.dsh.bundle.patch)));
await check('files 里带 host 和 cordis.patch.yml',
  () => { for (const n of ['host', 'cordis.patch.yml']) assert.ok(pkg.files.includes(n), n); });
const patchText = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8');
await check('插入行指向 dsh-narrate/host/narrate.js',
  () => assert.match(patchText, /dsh-narrate\/host\/narrate\.js/));

console.log('用例 2：注册的形状');
const tools = mount();
await check(`注册了 ${tools.size} 个工具，就是 TOOL_NAMES 那几个`,
  () => assert.deepEqual([...tools.keys()].sort(), [...TOOL_NAMES].sort()));
await check('每个都有 dsh 要求的那几样', () => {
  for (const [n, t] of tools) {
    assert.equal(typeof t.description, 'string', n);
    assert.equal(t.parameters?.type, 'object', n);
    assert.equal(typeof t.output?.render, 'function', n);
    assert.ok(t.output?.schema, n);
    assert.equal(typeof t.execute, 'function', n);
  }
});

console.log('用例 3 和 4：拿 dsh 自己的校验器验');
let dsh = null;
for (const spec of ['@deepseek-ai/dsh-tools',
  `${process.env.HOME}/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js`]) {
  try { dsh = await import(spec); break; } catch { /* 换下一个 */ }
}
if (!dsh?.assertSupportedJsonSchema) {
  console.log('  跳过    导入不到 @deepseek-ai/dsh-tools，用例 3 和 4 跳过（不是失败）');
} else {
  await check('每个 schema 都过得了 dsh 的 assertSupportedJsonSchema', () => {
    for (const [n, t] of tools) {
      dsh.assertSupportedJsonSchema(t.parameters);
      dsh.assertSupportedJsonSchema(t.output.schema);
    }
  });
  const reg = mount({ workdir: await tmp() });
  const started = await reg.get('narrate_start').execute({ idea: 'QA 用的一句想法' });
  await check('narrate_start 的返回值符合自己声明的 schema', () => {
    const v = dsh.validateJsonSchemaValue(started, reg.get('narrate_start').output.schema);
    assert.deepEqual(Array.isArray(v) ? v : [], []);
  });
}

console.log('用例 5：A-29 停点 1 拦得住');
const reg5 = mount({ workdir: await tmp() });
const s5 = await reg5.get('narrate_start').execute({ idea: 'x' });
await reg5.get('narrate_answer').execute({ jobDir: s5.jobDir, questionId: s5.questions[0].id, answer: '八分钟' });
await check('只答了一个就交文稿，报 E_INTERVIEW_INCOMPLETE', async () => {
  await assert.rejects(() => reg5.get('narrate_script').execute({ jobDir: s5.jobDir, sentences: ['偷跑'] }),
    (e) => /E_INTERVIEW_INCOMPLETE/.test(e.message));
});
await check('工作文件里没有文稿', async () => assert.equal((await readJob(s5.jobDir)).script, undefined));

console.log('用例 6 和 7：A-28 只报不做，时长要量不要信');
const assets = await tmp();
for (const [name, seconds] of [['a.mp4', 2], ['b.mp4', 3]]) {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `color=c=black:s=320x180:r=10:d=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    join(assets, name)]);
}
const reg6 = mount({ workdir: await tmp() });
const indexed = await reg6.get('narrate_index').execute({ assetsRoot: assets });
await check('两段都进 needsUnderstanding',
  () => assert.deepEqual(indexed.needsUnderstanding.map((p) => basename(p)).sort(), ['a.mp4', 'b.mp4']));
await check('时长已经量好，但理解那一节还是空的', async () => {
  const rec = await readClipFile(join(assets, 'b.mp4'));
  assert.ok(Math.abs(rec.measured.durationSec - 3) < 0.3, `量出来 ${rec.measured.durationSec}`);
  assert.deepEqual(rec.fromMachine, {});
});
const described = await reg6.get('narrate_describe').execute({
  clipPath: join(assets, 'b.mp4'), durationSec: 999,
  segments: [{ startSec: 0, endSec: 999, description: '一片黑' }],
});
await check('agent 瞎报的 999 秒被忽略，用的是量出来的时长',
  () => assert.ok(Math.abs(described.durationSec - 3) < 0.3, `实际 ${described.durationSec}`));
await check('存下来的时间段也被截到真实时长', async () => {
  const rec = await readClipFile(join(assets, 'b.mp4'));
  assert.ok(rec.fromMachine.segments[0].endSec <= 3.1, `实际 ${rec.fromMachine.segments[0].endSec}`);
});

console.log('用例 8：配置缺失不能让挂载崩');
for (const config of [undefined, null, {}, { workdir: 123 }]) {
  await check(`config = ${JSON.stringify(config)} 时照样加载`, () => { mount(config); });
}

console.log('');
console.log(failures === 0 ? 'T-11 QA：全部通过' : `T-11 QA：${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
