// M6 里程碑验收，在 dsh 之外做。
//
// `prd.md` 给 M6 定的验收方法是"在 dsh 里真做一条视频"。这个脚本在 dsh 之外
// 尽可能地做到同一件事，办法是：**顺序不写死在脚本里，由插件自己说。**
//
// 每一步只做一件事：读上一步返回的 `tool` 字段，调那个工具。脚本不知道
// narrate_script 之后该干什么——插件知道。如果只照插件的指示走就能走到成片，
// 那就证明它的引导是完整、自洽的，而那正是真会话里 agent 会走的那条路。
//
// 诚实地说清楚这个脚本**不能**验什么：模型的判断。真会话里 agent 贡献三样东西——
// 文稿的字、每句的英文查询、素材的理解。这里三样都由人手写并**标明是替身**。
// 所以这个脚本证明的是"机械上走得通、引导完整"，不是"agent 会做对判断"。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const run = promisify(execFile);
const FFMPEG = process.env.DSH_FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.DSH_FFPROBE_PATH || 'ffprobe';

const { apply, inject, TOOL_NAMES } = await import(join(ROOT, 'host/narrate.js'));
const { readJob } = await import(join(ROOT, 'src/flow/job.js'));
const { readClipFile } = await import(join(ROOT, 'src/assets-index/clip-file.js'));
const { defaultEngineConfig } = await import(join(ROOT, 'src/voice/engines/default.js'));

let failures = 0;
let skips = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  通过    ${name}`);
  } catch (error) {
    if (error?.qaSkip) { skips += 1; console.log(`  跳过    ${name}\n          ${error.message}`); return; }
    failures += 1;
    console.log(`  失败    ${name}\n          ${error.message}`);
  }
};
const skip = (why) => { const e = new Error(why); e.qaSkip = true; throw e; };

const probe = async (path, entry) => {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', entry, '-of', 'csv=p=0', path]);
  return stdout.trim();
};
/** 完整解码一遍。有任何输出就是有坏帧。 */
const decodeClean = async (path) => {
  const { stderr } = await run(FFMPEG, ['-v', 'error', '-i', path, '-f', 'null', '-'], { maxBuffer: 1 << 24 });
  assert.equal(String(stderr ?? '').trim(), '', `解码有坏帧：\n${stderr}`);
};
const brightness = async (path, crop) => {
  const res = await run(FFMPEG, ['-hide_banner', '-nostats', '-loglevel', 'info', '-i', path,
    '-vf', `${crop},signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
    '-f', 'null', '/dev/null'], { maxBuffer: 1 << 24 }).catch((e) => e);
  const m = `${res.stdout ?? ''}${res.stderr ?? ''}`.match(/YAVG=([0-9.]+)/);
  assert.ok(m, '读不到 YAVG');
  return Number(m[1]);
};

/** 挂载插件，拿到工具表。走的是 dsh 调的同一个入口。 */
function mount(config) {
  const registered = new Map();
  apply({ tools: { register: (d) => { registered.set(d.name, d); return () => {}; } }, on() {} }, config);
  assert.ok(inject.includes('tools'), 'inject 里要声明 tools');
  assert.equal(registered.size, TOOL_NAMES.length, `该注册 ${TOOL_NAMES.length} 个工具`);
  return registered;
}

/** 真素材文件夹。没有就跳过——这个验收的意义就在于用真东西。 */
async function realAssets() {
  const root = process.env.NARRATE_ASSETS || join(process.env.HOME ?? '', 'assets');
  try {
    await access(root);
  } catch {
    skip(`找不到素材文件夹 ${root}。设 NARRATE_ASSETS 指过去，或者把素材放在 ~/assets`);
  }
  return root;
}

/** 语音引擎：能联网就用自带的真引擎，不能就用本地假引擎并**出声说明**。 */
async function voiceEngine(dir) {
  let reachable = false;
  try {
    await fetch('https://speech.platform.bing.com/', { signal: AbortSignal.timeout(5000) });
    reachable = true;
  } catch { reachable = false; }
  if (reachable) return { config: defaultEngineConfig(), real: true };

  const { writeFile } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  const src = join(dir, 'tone.wav');
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'sine=f=440:d=2.5', '-c:a', 'pcm_s16le', src]);
  const script = join(dir, 'engine.mjs');
  await writeFile(script, `import { copyFileSync } from 'node:fs';\n`
    + `copyFileSync(${JSON.stringify(src)}, process.argv[3]);\n`, 'utf8');
  return { config: { command: [process.execPath, script, '%TEXT_FILE%', '%OUT_FILE%'] }, real: false };
}

// ---------------------------------------------------------------------------
// 由插件带路，走完整条流程
// ---------------------------------------------------------------------------

/**
 * 一条视频，从一句想法到成片。
 *
 * **脚本不决定顺序。** 每一轮都读上一步给的 `tool`，调它，直到插件说做完了。
 * 人手提供的只有三样，每一样都在日志里标明是替身。
 */
async function driveOneVideo({ aspect, idea, sentences, queries, assetsRoot, tools, jobDirOut, target }) {
  const said = [];
  const log = (line) => { said.push(line); };

  const started = await tools.get('narrate_start').execute({ idea, aspect });
  const jobDir = started.jobDir;
  jobDirOut.push(jobDir);
  log(`narrate_start → ${basename(jobDir)}，反问 ${started.questions.length} 个问题`);

  // 从这里开始，下一步该调什么由插件说。
  let guard = 0;
  for (;;) {
    guard += 1;
    assert.ok(guard < 40, '走了 40 步还没完，可能在原地打转');

    const status = await tools.get('narrate_status').execute({ jobDir });
    const next = status.tool;
    if (status.stage === 'done') { log(`narrate_status → done`); break; }
    assert.ok(TOOL_NAMES.includes(next),
      `插件说下一步调 ${next}，但那不是一个已注册的工具`);

    if (next === 'narrate_answer') {
      // 替身 1/3：回答由人给。真会话里是用户自己说的。
      const job = await readJob(jobDir);
      const unanswered = (job.interview?.questions ?? []).filter((q) => String(q.answer ?? '').trim() === '');
      for (const q of unanswered) {
        await tools.get('narrate_answer').execute({
          jobDir, questionId: q.id, answer: `（替身回答）${q.suggestion || '普通观众'}`,
        });
      }
      log(`narrate_answer × ${unanswered.length}（替身：真会话里是用户自己答）`);
      continue;
    }

    if (next === 'narrate_script') {
      // 替身 2/3：文稿的字由人写。真会话里是 agent 写的。
      const got = await tools.get('narrate_script').execute({ jobDir, sentences });
      log(`narrate_script → ${got.sentences.length} 句（替身：真会话里 agent 写）`);
      continue;
    }

    if (next === 'narrate_index') {
      const indexed = await tools.get('narrate_index').execute({ assetsRoot, jobDir });
      log(`narrate_index → ${indexed.needsUnderstanding.length} 段待理解，`
        + `${indexed.reused.length} 段复用，${indexed.skipped.length} 段跳过`);
      // 插件让我们对 needsUnderstanding 里的每一段调 narrate_describe。照做。
      // 替身 3/3：理解结果由人给——dsh 之外没有模型。用素材自己带的描述当替身，
      // 并在返回里标明它是替身，不冒充真的理解。
      for (const clipPath of indexed.needsUnderstanding) {
        const record = await readClipFile(clipPath);
        const text = record?.fromYou?.description ?? '';
        const tags = record?.fromYou?.tags ?? [];
        const duration = record?.measured?.durationSec ?? 0;
        if (duration <= 0) continue;
        await tools.get('narrate_describe').execute({
          clipPath,
          segments: [{ startSec: 0, endSec: duration, description: text, tags, confidence: 'low' }],
          engine: 'stand-in-no-model (M6 acceptance outside dsh)',
        });
      }
      log(`narrate_describe × ${indexed.needsUnderstanding.length}`
        + `（替身：dsh 之外没有模型，用素材自带描述顶替，confidence 记 low）`);
      continue;
    }

    if (next === 'narrate_shotplan') {
      // 英文查询也是替身：真会话里 agent 写，规则写在工具的 description 里
      const got = await tools.get('narrate_shotplan').execute({ jobDir, assetsRoot, queries });
      log(`narrate_shotplan → ${got.shots.length} 句配上画面，${got.missing.length} 句缺素材`
        + `（英文查询是替身：真会话里 agent 写）`);
      for (const m of got.missing) log(`    缺素材 ${m.sentenceId}：${m.reason}`);
      continue;
    }

    if (next === 'narrate_voice') {
      const got = await tools.get('narrate_voice').execute({ jobDir });
      log(`narrate_voice → 新配 ${got.spoken.length} 句，复用 ${got.reused.length} 句，`
        + `纯音频 ${got.durationSec} 秒`);
      assert.equal(got.skipped.length, 0, `有句子配不出来：${JSON.stringify(got.skipped)}`);
      continue;
    }

    if (next === 'narrate_render') {
      const got = await tools.get('narrate_render').execute({ jobDir, ...(target ? {} : {}) });
      log(`narrate_render → ${got.output}（${got.durationSec} 秒，${got.width}x${got.height}）`);
      continue;
    }

    if (next === 'narrate_approve') {
      // **这就是这个插件存在的意义。** 真会话里这里必须等用户说"继续"。
      assert.ok(status.waitingForUser, `插件说该调 narrate_approve，却没说在等用户`);
      const got = await tools.get('narrate_approve').execute({ jobDir, stop: status.stopPoint });
      log(`停点 ${status.stopPoint} ← 用户说继续（已点头：${got.approved.join('、')}）`);
      continue;
    }

    assert.fail(`不知道怎么调 ${next}`);
  }

  return { jobDir, log: said };
}

console.log('M6 验收（在 dsh 之外）：');
console.log('  顺序不写死在脚本里——每一步都读插件给的 tool 字段。');
console.log('  人手替身三处：回答、文稿的字、素材理解和英文查询。日志里都标了。\n');

const assetsRoot = await realAssets().catch((e) => { if (e.qaSkip) { console.log(`  跳过全部：${e.message}`); process.exit(0); } throw e; });
const engineDir = await mkdtemp(join(tmpdir(), 'narrate-m6-engine-'));
const engine = await voiceEngine(engineDir);
console.log(`  素材文件夹：${assetsRoot}`);
console.log(`  语音引擎：${engine.real ? '自带的真引擎（联网）' : '本地假引擎（连不上语音服务，出声说明）'}\n`);

const SENTENCES = ['云在天上跑得比你想的快。', '城市的车流一整天都不停。', '海浪在太阳落下的时候最好看。'];
const QUERIES = [
  { sentenceId: 'S-001', englishQuery: 'clouds bright sky' },
  { sentenceId: 'S-002', englishQuery: 'city traffic cars street' },
  { sentenceId: 'S-003', englishQuery: 'sunset waves ocean beach' },
];

const made = {};
for (const aspect of ['landscape', 'portrait']) {
  await check(`${aspect}：一句想法跑到成片，全程由插件带路`, async () => {
    const workdir = await mkdtemp(join(tmpdir(), `narrate-m6-${aspect}-`));
    const tools = mount({ workdir, voice: engine.config });
    const jobDirOut = [];
    const { jobDir, log } = await driveOneVideo({
      aspect, idea: '云、车流和海浪的延时摄影', sentences: SENTENCES, queries: QUERIES,
      assetsRoot, tools, jobDirOut,
    });
    for (const line of log) console.log(`          ${line}`);

    const job = await readJob(jobDir);
    // 四个停点都点过头，一个都没绕过
    assert.deepEqual(job.meta.approvedStops, [2, 3, 4],
      `停点 2、3、4 都该点过头，实际 ${JSON.stringify(job.meta.approvedStops)}`);
    assert.ok(job.render?.output, 'render 节里该有成片路径');
    made[aspect] = { jobDir, output: job.render.output, job };
  });
}

/**
 * 后面每一条检查都先确认两条片子都做出来了。
 *
 * 不加这一句的话，前面失败时 `made` 是空的，`Object.entries({})` 是空循环，
 * 断言一次都不跑——**检查会空转当成通过**。那比失败糟得多。
 */
const bothMade = () => {
  for (const aspect of ['landscape', 'portrait']) {
    assert.ok(made[aspect], `${aspect} 那条没做出来，这项检查无从谈起（不算通过）`);
  }
  return Object.entries(made);
};

await check('两条成片都能播，解码没有坏帧，画面和声音都在', async () => {
  for (const [aspect, m] of bothMade()) {
    await access(m.output);
    await decodeClean(m.output);
    const kinds = (await probe(m.output, 'stream=codec_type')).split('\n').sort();
    assert.deepEqual(kinds, ['audio', 'video'], `${aspect}：成片必须同时有画面和声音`);
  }
});

await check('横屏是 1920x1080，竖屏是 1080x1920', async () => {
  const want = { landscape: ['1920', '1080'], portrait: ['1080', '1920'] };
  for (const [aspect, m] of bothMade()) {
    assert.equal(await probe(m.output, 'stream=width'), want[aspect][0], `${aspect} 宽不对`);
    assert.equal(await probe(m.output, 'stream=height'), want[aspect][1], `${aspect} 高不对`);
  }
});

await check('每一句的画面时长跟着它自己那句旁白，差不超过 0.2 秒', async () => {
  for (const [aspect, m] of bothMade()) {
    const audio = new Map(m.job.voice.clips.map((c) => [c.sentenceId, c.durationSec]));
    for (const seg of m.job.render.segments) {
      const want = audio.get(seg.sentenceId);
      assert.ok(Math.abs(seg.durationSec - want) <= 0.2,
        `${aspect} ${seg.sentenceId}：画面 ${seg.durationSec} 秒，旁白 ${want} 秒`);
    }
  }
});

await check('成片总长约等于各句旁白之和', async () => {
  for (const [aspect, m] of bothMade()) {
    const want = m.job.voice.clips.reduce((a, c) => a + c.durationSec, 0);
    const real = Number(await probe(m.output, 'format=duration'));
    assert.ok(Math.abs(real - want) < 0.5, `${aspect}：成片 ${real} 秒，旁白之和 ${want} 秒`);
  }
});

await check('字幕真的烧在画面下部，上半干净（横屏和竖屏都要）', async () => {
  for (const [aspect, m] of bothMade()) {
    const bottom = await brightness(m.output, 'crop=iw:ih/4:0:ih*3/4');
    const top = await brightness(m.output, 'crop=iw:ih/3:0:0');
    assert.ok(bottom > top, `${aspect}：字幕该在下面 25%（下 ${bottom}，上 ${top}）`);
    const ass = await readFile(`${m.job.render.segments[0].path}.ass`, 'utf8');
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    assert.equal(events.length, 1, `${aspect}：一段该只有一条字幕`);
    assert.ok(events[0].includes(SENTENCES[0].slice(0, 4)),
      `${aspect}：字幕内容该和文稿一致，实际 ${events[0]}`);
  }
});

await check('中间产物齐全：索引、文稿、对应表、逐句音频、字幕', async () => {
  bothMade();
  const m = made.landscape;
  assert.ok((m.job.script?.sentences ?? []).length > 0, '文稿不在');
  assert.ok((m.job.shotplan?.shots ?? []).length > 0, '对应表不在');
  for (const clip of m.job.voice.clips) await access(clip.audioPath);
  await access(`${m.job.render.segments[0].path}.ass`);
  // 索引在素材旁边
  const first = m.job.shotplan.shots[0].assetPath;
  await access(first.replace(/\.[^./\\]+$/, '.json'));
});

// ---------------------------------------------------------------------------
// 停点绕不过去。这是产品的全部意义，所以单独逐个试一遍。
// ---------------------------------------------------------------------------
await check('四个停点每一个都绕不过去', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'narrate-m6-gate-'));
  const tools = mount({ workdir, voice: engine.config });
  const refuses = async (tool, args, why) => {
    let threw = false;
    try { await tools.get(tool).execute(args); } catch (e) { threw = true; assert.match(e.message, /E_/, `${why}：错误里该带错误码，实际 ${e.message}`); }
    assert.ok(threw, `${why}：本该报错，却做成了`);
  };

  const started = await tools.get('narrate_start').execute({ idea: '守门测试' });
  const jobDir = started.jobDir;

  // 停点 1：问题没答完不许交文稿
  await refuses('narrate_script', { jobDir, sentences: ['抢跑的一句。'] }, '停点 1');
  for (const q of started.questions) {
    await tools.get('narrate_answer').execute({ jobDir, questionId: q.id, answer: '答了' });
  }
  await tools.get('narrate_script').execute({ jobDir, sentences: SENTENCES });

  // 停点 2 没点头就不许做对应表
  await refuses('narrate_shotplan', { jobDir, assetsRoot }, '停点 2');
  // 也不许提前给还没走到的停点点头
  await refuses('narrate_approve', { jobDir, stop: 4 }, '提前点停点 4');
  await tools.get('narrate_approve').execute({ jobDir, stop: 2 });
  await tools.get('narrate_shotplan').execute({ jobDir, assetsRoot, queries: QUERIES });

  // 停点 3 没点头就不许配音
  await refuses('narrate_voice', { jobDir }, '停点 3');
  await tools.get('narrate_approve').execute({ jobDir, stop: 3 });
  await tools.get('narrate_voice').execute({ jobDir });

  // 停点 4 没点头就不许渲染
  await refuses('narrate_render', { jobDir }, '停点 4');
  await tools.get('narrate_approve').execute({ jobDir, stop: 4 });
  const got = await tools.get('narrate_render').execute({ jobDir });
  await access(got.output);
});

console.log('');
if (failures === 0) {
  console.log(`M6 验收通过${skips > 0 ? `（跳过 ${skips} 项）` : ''}`);
  console.log('这个脚本验的是：机械上走得通、插件的引导完整、四个停点绕不过去、');
  console.log('两种比例都出得来。**它没有验**模型的判断——文稿的字、英文查询、素材理解');
  console.log('三样都是人手替身。那一部分要真会话。');
} else {
  console.log(`M6 验收有 ${failures} 项失败`);
}
process.exit(failures === 0 ? 0 : 1);
