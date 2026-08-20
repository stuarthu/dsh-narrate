// T-01 走通骨架的测试。契约：docs/crew/api/flow-stages.md、docs/crew/api/voice-engine.md
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJob, readJob, openJob } from '../src/flow/job.js';

const tmp = () => mkdtemp(join(tmpdir(), 'narrate-test-'));

describe('工作文件：分节独占的读写', () => {
  test('createJob 写出的文件能被 readJob 读回，schema 是 1', async () => {
    const dir = await tmp();
    await createJob(dir, { slug: 'why-rust', aspect: 'landscape', language: 'zh', idea: '讲清楚 Rust 为什么快' });
    const raw = await readJob(dir);
    assert.equal(raw.meta.schema, 1);
    assert.equal(raw.meta.slug, 'why-rust');
    assert.equal(raw.idea, '讲清楚 Rust 为什么快');
  });

  test('不认识的 schema 版本报 E_SCHEMA_UNKNOWN', async () => {
    const dir = await tmp();
    await writeFile(join(dir, 'job.json'), JSON.stringify({ meta: { schema: 99 } }), 'utf8');
    await assert.rejects(() => readJob(dir), (e) => e.code === 'E_SCHEMA_UNKNOWN');
  });

  test('阶段能写自己那一节', async () => {
    const dir = await tmp();
    await createJob(dir, { slug: 's', aspect: 'landscape', language: 'zh', idea: 'i' });
    const job = await openJob(dir, 'voice');
    job.set('voice', { engine: 'fake', clips: [{ sentenceId: 'S-001', audioPath: '/a.wav', durationSec: 2.48 }] });
    await job.save();
    const raw = await readJob(dir);
    assert.equal(raw.voice.clips[0].durationSec, 2.48);
  });

  test('阶段写别人那一节报 E_WRITE_FOREIGN_SECTION', async () => {
    const dir = await tmp();
    await createJob(dir, { slug: 's', aspect: 'landscape', language: 'zh', idea: 'i' });
    const job = await openJob(dir, 'voice');
    assert.throws(() => job.set('script', { sentences: [] }), (e) => e.code === 'E_WRITE_FOREIGN_SECTION');
  });

  test('该读的节不存在时 require 报 E_SECTION_MISSING', async () => {
    const dir = await tmp();
    await createJob(dir, { slug: 's', aspect: 'landscape', language: 'zh', idea: 'i' });
    const job = await openJob(dir, 'shotplan');
    assert.throws(() => job.require('script'), (e) => e.code === 'E_SECTION_MISSING');
  });

  test('save 是原子的：不留临时文件，文件始终是完整 JSON', async () => {
    const dir = await tmp();
    await createJob(dir, { slug: 's', aspect: 'landscape', language: 'zh', idea: 'i' });
    const job = await openJob(dir, 'render');
    job.set('render', { segments: [], output: '/out/final.mp4' });
    await job.save();
    const names = await readdir(dir);
    assert.deepEqual(names, ['job.json'], '目录里只应有 job.json，不应留下 .tmp');
    JSON.parse(await readFile(join(dir, 'job.json'), 'utf8'));
  });
});

// ---------------------------------------------------------------------------
// 语音引擎。契约：docs/crew/api/voice-engine.md 版本 2
// ---------------------------------------------------------------------------
import { chmod, stat, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { synthesize } from '../src/voice/engine.js';

const run = promisify(execFile);
const FFMPEG = process.env.DSH_FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.DSH_FFPROBE_PATH || 'ffprobe';

/** 造一段 4 秒音频：0-1 秒静音、1-3 秒有声、3-4 秒静音。 */
async function makePaddedWav(path) {
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    "aevalsrc='if(between(t,1,3), 0.5*sin(440*2*PI*t), 0)':d=4:s=44100",
    '-c:a', 'pcm_s16le', path]);
}

/** 写一个假引擎脚本，行为由 body 决定。返回它的路径。 */
async function fakeEngine(dir, name, body) {
  const p = join(dir, name);
  await writeFile(p, `#!/usr/bin/env node\n${body}\n`, 'utf8');
  await chmod(p, 0o755);
  return p;
}

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

describe('语音引擎：命令行契约', () => {
  test('配置里没有 command 报 E_ENGINE_NOT_CONFIGURED', async () => {
    const dir = await tmp();
    await assert.rejects(
      () => synthesize({ text: '你好', outPath: join(dir, 'a.wav'), lang: 'zh', config: {} }),
      (e) => e.code === 'E_ENGINE_NOT_CONFIGURED');
  });

  test('模板里缺 %OUT_FILE% 也报 E_ENGINE_NOT_CONFIGURED', async () => {
    const dir = await tmp();
    await assert.rejects(
      () => synthesize({ text: '你好', outPath: join(dir, 'a.wav'), lang: 'zh',
        config: { command: ['node', '-e', 'process.exit(0)', '%TEXT_FILE%'] } }),
      (e) => e.code === 'E_ENGINE_NOT_CONFIGURED');
  });

  test('引擎正常写文件退出 0 时成功，并把静音裁掉后量出时长', async () => {
    const dir = await tmp();
    const src = join(dir, 'src.wav');
    await makePaddedWav(src);
    const eng = await fakeEngine(dir, 'ok.mjs',
      `import {copyFileSync} from 'node:fs'; copyFileSync(${JSON.stringify(src)}, process.argv[3]); process.exit(0);`);
    const out = join(dir, 'out', 'S-001.wav');
    const result = await synthesize({ text: '你好', outPath: out, lang: 'zh',
      config: { command: ['node', eng, '%TEXT_FILE%', '%OUT_FILE%'] } });
    assert.equal(result.audioPath, out);
    assert.ok(Math.abs(result.durationSec - 2.0) < 0.05,
      `裁完应约 2.000 秒，实际 ${result.durationSec}`);
    const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]);
    assert.ok(Math.abs(Number(stdout.trim()) - 2.0) < 0.05, '磁盘上的文件也要是同一个数');
  });

  test('退出 0 但不写文件报 E_ENGINE_NO_OUTPUT', async () => {
    const dir = await tmp();
    const eng = await fakeEngine(dir, 'silent.mjs', 'process.exit(0);');
    await assert.rejects(
      () => synthesize({ text: '你好', outPath: join(dir, 'a.wav'), lang: 'zh',
        config: { command: ['node', eng, '%TEXT_FILE%', '%OUT_FILE%'] } }),
      (e) => e.code === 'E_ENGINE_NO_OUTPUT');
  });

  test('退出码非 0 报 E_ENGINE_FAILED，消息里带上 stderr', async () => {
    const dir = await tmp();
    const eng = await fakeEngine(dir, 'boom.mjs',
      "process.stderr.write('音色 nonesuch 不存在\\n'); process.exit(3);");
    await assert.rejects(
      () => synthesize({ text: '你好', outPath: join(dir, 'a.wav'), lang: 'zh',
        config: { command: ['node', eng, '%TEXT_FILE%', '%OUT_FILE%'] } }),
      (e) => e.code === 'E_ENGINE_FAILED' && e.message.includes('nonesuch'));
  });

  test('跑太久报 E_ENGINE_TIMEOUT', async () => {
    const dir = await tmp();
    const eng = await fakeEngine(dir, 'slow.mjs', 'setTimeout(() => {}, 60000);');
    await assert.rejects(
      () => synthesize({ text: '你好', outPath: join(dir, 'a.wav'), lang: 'zh',
        config: { command: ['node', eng, '%TEXT_FILE%', '%OUT_FILE%'], timeoutMs: 400 } }),
      (e) => e.code === 'E_ENGINE_TIMEOUT');
  });

  test('文稿里的危险字符只是文字，不会有命令被执行', async () => {
    const dir = await tmp();
    const sentinel = join(dir, 'PWNED');
    const src = join(dir, 'src.wav');
    await makePaddedWav(src);
    // 假引擎把收到的文本原样抄出来，方便断言它是文字而不是命令
    const eng = await fakeEngine(dir, 'echo.mjs',
      `import {copyFileSync, readFileSync, writeFileSync} from 'node:fs';
       writeFileSync(${JSON.stringify(join(dir, 'seen.txt'))}, readFileSync(process.argv[2], 'utf8'));
       copyFileSync(${JSON.stringify(src)}, process.argv[3]); process.exit(0);`);
    const nasty = `你好; touch ${sentinel} && echo $(whoami) \`id\` | tee /dev/null`;
    await synthesize({ text: nasty, outPath: join(dir, 'out.wav'), lang: 'zh',
      config: { command: ['node', eng, '%TEXT_FILE%', '%OUT_FILE%'] } });
    assert.equal(await exists(sentinel), false, '哨兵文件被建出来了，说明文本被当成命令执行过');
    assert.equal(await readFile(join(dir, 'seen.txt'), 'utf8'), nasty, '引擎收到的文本必须和原文一字不差');
  });
});

// ---------------------------------------------------------------------------
// 渲染一段。契约：docs/crew/api/flow-stages.md 版本 2 的 render 侧
// 必须跑在手写的 job.json 桩上，不准调真的 voice。
// ---------------------------------------------------------------------------
import { renderSegment } from '../src/render/segment.js';

/** 造一段纯黑素材，只有画面没有音轨。纯黑让字幕的墨量可以量。 */
async function makeBlackAsset(path, seconds) {
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    `color=c=black:s=640x360:r=30:d=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path]);
}

/** 造一段有声音频，长度精确。 */
async function makeTone(path, seconds) {
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    `sine=frequency=440:duration=${seconds}:sample_rate=44100`, '-c:a', 'pcm_s16le', path]);
}

const probe = async (path, entry) => {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', entry, '-of', 'csv=p=0', path]);
  return stdout.trim();
};

/** 量底部 25% 的平均亮度。纯黑是 16，画了字就会高于 16。 */
async function bottomBrightness(path) {
  const { stderr } = await run(FFMPEG, ['-hide_banner', '-nostats', '-loglevel', 'info', '-i', path,
    '-vf', 'crop=640:90:0:270,signalstats,metadata=print:key=lavfi.signalstats.YAVG',
    '-f', 'null', '/dev/null']).catch((e) => e);
  const match = String(stderr).match(/YAVG=([0-9.]+)/);
  assert.ok(match, '读不到 YAVG');
  return Number(match[1]);
}

/** 写一个手写的 job.json 桩。 */
async function stubJob(dir, { assetPath, audioPath, durationSec, startSec = 0, subtitle = '测试字幕在这里' }) {
  await createJob(dir, { slug: 'stub', aspect: 'landscape', language: 'zh', idea: 'i' });
  const plan = await openJob(dir, 'shotplan');
  plan.set('shotplan', { shots: [{ sentenceId: 'S-001', assetPath, startSec,
    endSec: startSec + durationSec, subtitle }], missing: [] });
  await plan.save();
  const v = await openJob(dir, 'voice');
  v.set('voice', { engine: 'stub', clips: [{ sentenceId: 'S-001', audioPath, durationSec }] });
  await v.save();
}

describe('渲染一段：画面时长服从音频', () => {
  test('契约测试：2.000 秒音频 + 6.000 秒素材，出 2.000 秒的片段，画面和声音都在', async () => {
    const dir = await tmp();
    const asset = join(dir, 'asset.mp4');
    const audio = join(dir, 'S-001.wav');
    await makeBlackAsset(asset, 6);
    await makeTone(audio, 2);
    await stubJob(dir, { assetPath: asset, audioPath: audio, durationSec: 2.0, startSec: 1 });
    const out = join(dir, 'seg', 'S-001.mp4');
    const result = await renderSegment({ jobDir: dir, sentenceId: 'S-001', outPath: out });
    const real = Number(await probe(out, 'format=duration'));
    assert.ok(Math.abs(real - 2.0) < 0.05, `片段应约 2.000 秒，实际 ${real}`);
    assert.ok(Math.abs(result.durationSec - 2.0) < 0.05);
    const kinds = (await probe(out, 'stream=codec_type')).split('\n').sort();
    assert.deepEqual(kinds, ['audio', 'video'], '成片必须同时有画面和声音');
  });

  test('字幕真的烧进了画面', async () => {
    const dir = await tmp();
    const asset = join(dir, 'asset.mp4');
    const audio = join(dir, 'a.wav');
    await makeBlackAsset(asset, 6);
    await makeTone(audio, 2);
    await stubJob(dir, { assetPath: asset, audioPath: audio, durationSec: 2.0, subtitle: '测试字幕在这里' });
    const out = join(dir, 'withsub.mp4');
    await renderSegment({ jobDir: dir, sentenceId: 'S-001', outPath: out });
    const drawn = await bottomBrightness(out);
    assert.ok(drawn > 16.2, `底部亮度 ${drawn} 太接近纯黑 16，字幕没画上去`);
  });

  test('中文不是方块：笔画多的字墨量明显多于笔画少的字', async () => {
    const dir = await tmp();
    const asset = join(dir, 'asset.mp4');
    const audio = join(dir, 'a.wav');
    await makeBlackAsset(asset, 6);
    await makeTone(audio, 2);
    const inkOf = async (subtitle, name) => {
      const d = await mkdtemp(join(tmpdir(), 'narrate-ink-'));
      await stubJob(d, { assetPath: asset, audioPath: audio, durationSec: 2.0, subtitle });
      const out = join(d, `${name}.mp4`);
      await renderSegment({ jobDir: d, sentenceId: 'S-001', outPath: out });
      return bottomBrightness(out);
    };
    const thin = await inkOf('一一一一一一一', 'thin');
    const thick = await inkOf('测试字幕在这里', 'thick');
    assert.ok(thin > 16.05, `笔画少的字也该画出来，亮度 ${thin}`);
    assert.ok(thick - 16 > (thin - 16) * 2,
      `笔画多(${thick})和笔画少(${thin})的墨量应差很多。差不多就说明渲染成了方块`);
  });

  test('job.json 里的时长和音频实际不符时报 E_DURATION_MISMATCH', async () => {
    const dir = await tmp();
    const asset = join(dir, 'asset.mp4');
    const audio = join(dir, 'a.wav');
    await makeBlackAsset(asset, 6);
    await makeTone(audio, 5);
    await stubJob(dir, { assetPath: asset, audioPath: audio, durationSec: 2.0 });
    await assert.rejects(
      () => renderSegment({ jobDir: dir, sentenceId: 'S-001', outPath: join(dir, 'o.mp4') }),
      (e) => e.code === 'E_DURATION_MISMATCH');
  });

  test('素材文件不存在时报 E_ASSET_MISSING', async () => {
    const dir = await tmp();
    const audio = join(dir, 'a.wav');
    await makeTone(audio, 2);
    await stubJob(dir, { assetPath: join(dir, 'gone.mp4'), audioPath: audio, durationSec: 2.0 });
    await assert.rejects(
      () => renderSegment({ jobDir: dir, sentenceId: 'S-001', outPath: join(dir, 'o.mp4') }),
      (e) => e.code === 'E_ASSET_MISSING');
  });

  test('素材从起点开始不够长时报 E_ASSET_TOO_SHORT', async () => {
    const dir = await tmp();
    const asset = join(dir, 'asset.mp4');
    const audio = join(dir, 'a.wav');
    await makeBlackAsset(asset, 3);
    await makeTone(audio, 2);
    // 素材 3 秒，从第 2 秒起只剩 1 秒，盖不住 2 秒旁白
    await stubJob(dir, { assetPath: asset, audioPath: audio, durationSec: 2.0, startSec: 2 });
    await assert.rejects(
      () => renderSegment({ jobDir: dir, sentenceId: 'S-001', outPath: join(dir, 'o.mp4') }),
      (e) => e.code === 'E_ASSET_TOO_SHORT');
  });
});

// ---------------------------------------------------------------------------
// 自带默认引擎的契约测试，以及 M1 的端到端走通。
// 这两个要联网。没有网络时出声跳过，不算失败——理由见 voice-engine.md 版本 2。
// ---------------------------------------------------------------------------
import { defaultEngineConfig } from '../src/voice/engines/default.js';

/** 探一下语音服务通不通。400 也算通（裸 GET 本来就该 400）。 */
async function ttsReachable() {
  try {
    await fetch('https://speech.platform.bing.com/', { signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

describe('自带默认引擎（要联网）', () => {
  test('契约测试：给一个文本文件和输出路径，退出 0 并写出能读时长的音频', async (t) => {
    if (!(await ttsReachable())) {
      t.skip('跳过：连不上语音服务。这台机器没有网络，或者服务坏了。这不是代码的问题');
      return;
    }
    const dir = await tmp();
    const out = join(dir, 'audio', 'S-001.mp3');
    const result = await synthesize({
      text: '你好，这是一句测试。', outPath: out, lang: 'zh', config: defaultEngineConfig(),
    });
    assert.equal(result.audioPath, join(dir, 'audio', 'S-001.wav'), 'audioPath 必须是 .wav');
    assert.ok(result.durationSec > 0.5, `念一句话应超过 0.5 秒，实际 ${result.durationSec}`);
    assert.ok(result.durationSec < 10, `念一句话不该超过 10 秒，实际 ${result.durationSec}`);
  });

  test('M1 走通：一句话变成一个能播的 mp4，画面时长等于旁白时长', async (t) => {
    if (!(await ttsReachable())) {
      t.skip('跳过：连不上语音服务，无法做端到端走通');
      return;
    }
    const dir = await tmp();
    const sentence = '这条视频要讲清楚一件事。';

    // 1. 真的配音
    const audio = join(dir, 'audio', 'S-001.mp3');
    const spoken = await synthesize({ text: sentence, outPath: audio, lang: 'zh', config: defaultEngineConfig() });

    // 2. 一段够长的素材
    const asset = join(dir, 'asset.mp4');
    await makeBlackAsset(asset, Math.ceil(spoken.durationSec) + 3);

    // 3. 手写工作文件的两节
    await createJob(dir, { slug: 'walk', aspect: 'landscape', language: 'zh', idea: sentence });
    const plan = await openJob(dir, 'shotplan');
    plan.set('shotplan', { shots: [{ sentenceId: 'S-001', assetPath: asset, startSec: 0,
      endSec: spoken.durationSec, subtitle: sentence }], missing: [] });
    await plan.save();
    const v = await openJob(dir, 'voice');
    v.set('voice', { engine: 'default', clips: [{ sentenceId: 'S-001',
      audioPath: spoken.audioPath, durationSec: spoken.durationSec }] });
    await v.save();

    // 4. 出片
    const out = join(dir, 'out', 'final.mp4');
    const seg = await renderSegment({ jobDir: dir, sentenceId: 'S-001', outPath: out });

    const real = Number(await probe(out, 'format=duration'));
    assert.ok(Math.abs(real - spoken.durationSec) < 0.2,
      `成片 ${real} 秒应和旁白 ${spoken.durationSec} 秒对齐，误差不超过 0.2 秒`);
    const kinds = (await probe(out, 'stream=codec_type')).split('\n').sort();
    assert.deepEqual(kinds, ['audio', 'video']);
    const drawn = await bottomBrightness(out);
    assert.ok(drawn > 16.2, `字幕没烧上去，底部亮度只有 ${drawn}`);
    console.log(`    M1 成片：${seg.path}（${seg.durationSec} 秒）`);
  });
});

describe('渲染一段：路径的回归测试', () => {
  test('outPath 是相对路径时也能出片（ffmpeg 的工作目录被换过）', async () => {
    const dir = await tmp();
    const asset = join(dir, 'asset.mp4');
    const audio = join(dir, 'a.wav');
    await makeBlackAsset(asset, 6);
    await makeTone(audio, 2);
    await stubJob(dir, { assetPath: asset, audioPath: audio, durationSec: 2.0 });
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const result = await renderSegment({ jobDir: dir, sentenceId: 'S-001', outPath: 'sub/rel.mp4' });
      const real = Number(await probe(result.path, 'format=duration'));
      assert.ok(Math.abs(real - 2.0) < 0.05, `相对路径也该出 2.000 秒的片，实际 ${real}`);
    } finally {
      process.chdir(cwd);
    }
  });

  test('素材和音频写成相对路径时也能出片', async () => {
    const dir = await tmp();
    await makeBlackAsset(join(dir, 'asset.mp4'), 6);
    await makeTone(join(dir, 'a.wav'), 2);
    await stubJob(dir, { assetPath: 'asset.mp4', audioPath: 'a.wav', durationSec: 2.0 });
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const result = await renderSegment({ jobDir: dir, sentenceId: 'S-001', outPath: join(dir, 'rel2.mp4') });
      assert.ok(Math.abs(result.durationSec - 2.0) < 0.05);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('工作文件：评审补的测试', () => {
  test('工作文件本身不存在时报 E_JOB_MISSING，不是 E_SECTION_MISSING', async () => {
    const dir = await tmp();
    await assert.rejects(() => readJob(dir), (e) => e.code === 'E_JOB_MISSING');
  });

  test('交出去的数据是冻住的：改别人的节会抛错，不是悄悄改掉', async () => {
    const dir = await tmp();
    await createJob(dir, { slug: 's', aspect: 'landscape', language: 'zh', idea: 'i' });
    const writer = await openJob(dir, 'script');
    writer.set('script', { sentences: [{ id: 'S-001', text: '原来的句子' }] });
    await writer.save();

    const job = await openJob(dir, 'voice');
    assert.throws(() => { job.data.script.sentences[0].text = '被偷偷改了'; }, TypeError);
    assert.throws(() => { job.require('script').sentences.push({ id: 'S-002', text: '插一句' }); }, TypeError);
    // 真文件一个字都没变
    const raw = await readJob(dir);
    assert.equal(raw.script.sentences.length, 1);
    assert.equal(raw.script.sentences[0].text, '原来的句子');
  });
});

describe('评审补的测试', () => {
  test('引擎给 .mp3，返回的 audioPath 也必须是 .wav，且内容真是 wav', async () => {
    const dir = await tmp();
    const src = join(dir, 'src.wav');
    await makePaddedWav(src);
    const eng = await fakeEngine(dir, 'mp3ish.mjs',
      `import {copyFileSync} from 'node:fs'; copyFileSync(${JSON.stringify(src)}, process.argv[3]); process.exit(0);`);
    const asked = join(dir, 'S-001.mp3');
    const result = await synthesize({ text: '你好', outPath: asked, lang: 'zh',
      config: { command: ['node', eng, '%TEXT_FILE%', '%OUT_FILE%'] } });
    assert.equal(result.audioPath, join(dir, 'S-001.wav'));
    const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=format_name',
      '-of', 'csv=p=0', result.audioPath]);
    assert.ok(stdout.trim().includes('wav'), `扩展名说 wav，内容也必须是 wav，实际 ${stdout.trim()}`);
  });

  test('命令根本启动不起来时报 E_ENGINE_NOT_CONFIGURED', async () => {
    const dir = await tmp();
    await assert.rejects(
      () => synthesize({ text: '你好', outPath: join(dir, 'a.wav'), lang: 'zh',
        config: { command: [join(dir, 'nope-does-not-exist'), '%TEXT_FILE%', '%OUT_FILE%'] } }),
      (e) => e.code === 'E_ENGINE_NOT_CONFIGURED');
  });

  test('长 GOP 素材：从非关键帧位置起裁，时长仍然准', async () => {
    const dir = await tmp();
    const asset = join(dir, 'longgop.mp4');
    // 关键帧每 250 帧一个（30fps 约 8.3 秒），20 秒长
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      'testsrc2=s=640x360:r=30:d=20', '-c:v', 'libx264', '-g', '250', '-pix_fmt', 'yuv420p', asset]);
    const audio = join(dir, 'a.wav');
    await makeTone(audio, 2);
    // 从第 7.3 秒起，肯定不在关键帧上
    await stubJob(dir, { assetPath: asset, audioPath: audio, durationSec: 2.0, startSec: 7.3 });
    const out = join(dir, 'gop.mp4');
    await renderSegment({ jobDir: dir, sentenceId: 'S-001', outPath: out });
    const real = Number(await probe(out, 'format=duration'));
    assert.ok(Math.abs(real - 2.0) < 0.05, `长 GOP 素材也要准，实际 ${real} 秒`);
  });

  test('句子在 missing 里时，错误消息说清楚是缺素材', async () => {
    const dir = await tmp();
    await createJob(dir, { slug: 's', aspect: 'landscape', language: 'zh', idea: 'i' });
    const plan = await openJob(dir, 'shotplan');
    plan.set('shotplan', { shots: [], missing: [{ sentenceId: 'S-001', reason: '索引里没有合适画面' }] });
    await plan.save();
    const v = await openJob(dir, 'voice');
    v.set('voice', { engine: 'stub', clips: [{ sentenceId: 'S-001', audioPath: '/x.wav', durationSec: 1 }] });
    await v.save();
    await assert.rejects(
      () => renderSegment({ jobDir: dir, sentenceId: 'S-001', outPath: join(dir, 'o.mp4') }),
      (e) => e.code === 'E_SENTENCE_UNPLANNED' && e.message.includes('缺素材'));
  });
});

describe('安全评审补的测试：字幕文本是数据，不是指令', () => {
  test('花括号里的字要被画出来，不能被 libass 当标签吃掉', async () => {
    const dir = await tmp();
    const asset = join(dir, 'asset.mp4');
    const audio = join(dir, 'a.wav');
    await makeBlackAsset(asset, 6);
    await makeTone(audio, 2);
    const inkOf = async (subtitle, name) => {
      const d = await mkdtemp(join(tmpdir(), 'narrate-brace-'));
      await stubJob(d, { assetPath: asset, audioPath: audio, durationSec: 2.0, subtitle });
      const out = join(d, `${name}.mp4`);
      await renderSegment({ jobDir: d, sentenceId: 'S-001', outPath: out });
      return bottomBrightness(out);
    };
    const plain = await inkOf('一句话', 'plain');
    const braced = await inkOf('{备注}一句话', 'braced');
    assert.ok(braced > plain + 0.02,
      `带花括号(${braced})的墨量应多于不带的(${plain})。一样就说明那几个字被吃掉了`);
  });

  test('文稿里的空行不能伪造出第二条字幕', async () => {
    const dir = await tmp();
    const asset = join(dir, 'asset.mp4');
    const audio = join(dir, 'a.wav');
    await makeBlackAsset(asset, 6);
    await makeTone(audio, 2);
    const nasty = '第一句\n\n2\n00:00:00,000 --> 00:00:02,000\n偷偷插进来的第二句';
    await stubJob(dir, { assetPath: asset, audioPath: audio, durationSec: 2.0, subtitle: nasty });
    const out = join(dir, 'inject.mp4');
    await renderSegment({ jobDir: dir, sentenceId: 'S-001', outPath: out });
    const srt = await readFile(join(dir, 'inject.mp4.srt'), 'utf8');
    // SRT 里一条字幕是一个"空行隔开的块"。数块，不能数 -->：
    // 被注入的文字本身就含 --> 这个字符串，它现在只是普通字幕文字，正确地显示出来了。
    const blocks = srt.split(/\n\s*\n/).filter((b) => b.trim() !== '');
    assert.equal(blocks.length, 1,
      `SRT 里只应有一个字幕块，实际 ${blocks.length} 个。多于 1 个就是被注入了。文件内容：\n${srt}`);
    assert.ok(srt.includes('偷偷插进来的第二句'), '被注入的文字应该作为普通字幕文字显示出来，不是消失');
  });
});
