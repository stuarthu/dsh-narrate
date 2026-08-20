// T-09 的配音和拼接测试。契约：docs/crew/api/flow-stages.md、voice-engine.md
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, mkdir, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { speakScript, buildAudioOnly } from '../src/voice/speak.js';
import { createJob, openJob, readJob } from '../src/flow/job.js';
import { approveStop } from '../src/flow/run.js';

const run = promisify(execFile);
const FFMPEG = process.env.DSH_FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.DSH_FFPROBE_PATH || 'ffprobe';
const tmp = () => mkdtemp(join(tmpdir(), 'narrate-speak-'));

/** 造一段已知长度的音频，前后带静音（配音那一层会裁掉）。 */
async function makeWav(path, seconds) {
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    `aevalsrc='if(between(t,1,${1 + seconds}), 0.5*sin(440*2*PI*t), 0)':d=${seconds + 2}:s=44100`,
    '-c:a', 'pcm_s16le', path]);
}

/**
 * 一个假语音引擎：把一段已知长度的音频抄到输出路径，并记下被叫了几次。
 * `failFor` 里的文字会让它退出码非 0。
 */
async function fakeEngine(dir, { seconds = 2, failFor = [] } = {}) {
  const src = join(dir, 'src.wav');
  await makeWav(src, seconds);
  const log = join(dir, 'calls.log');
  const script = join(dir, 'engine.mjs');
  await writeFile(script, `
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
const text = readFileSync(process.argv[2], 'utf8');
appendFileSync(${JSON.stringify(log)}, text + '\\n');
if (${JSON.stringify(failFor)}.some((bad) => text.includes(bad))) {
  process.stderr.write('装作配不出来\\n');
  process.exit(3);
}
copyFileSync(${JSON.stringify(src)}, process.argv[3]);
`, 'utf8');
  await chmod(script, 0o755);
  return {
    config: { command: ['node', script, '%TEXT_FILE%', '%OUT_FILE%'] },
    async calls() {
      try {
        const { readFile } = await import('node:fs/promises');
        return (await readFile(log, 'utf8')).split('\n').filter((l) => l !== '');
      } catch {
        return [];
      }
    },
  };
}

/**
 * 一个真的走到"该配音了"的任务。
 *
 * 配音在**画面对应表之后**（停点 4 在停点 3 后面），所以前面每一步都要齐：
 * 问完、文稿写好、停点 2 点头、画面对应表做好、停点 3 点头。少一样守门就会拦住。
 */
async function readyJob(sentences = ['第一句。', '第二句。', '第三句。']) {
  const dir = await tmp();
  await createJob(dir, { slug: 'j', aspect: 'landscape', language: 'zh', idea: 'i' });
  const job = await openJob(dir, 'script');
  job.set('interview', { questions: [{ id: 'IQ-1', text: '问', suggestion: '答', answer: '答了' }] });
  job.set('script', { sentences: sentences.map((text, i) => ({ id: `S-00${i + 1}`, text })) });
  await job.save();
  await approveStop(dir, 2);
  const plan = await openJob(dir, 'shotplan');
  plan.set('shotplan', {
    shots: sentences.map((text, i) => ({ sentenceId: `S-00${i + 1}`, subtitle: text })),
    missing: [],
  });
  await plan.save();
  await approveStop(dir, 3);
  return dir;
}

describe('T-09 配音：守门', () => {
  test('文稿还没写就配音，报 E_OUT_OF_ORDER', async () => {
    const dir = await tmp();
    await createJob(dir, { slug: 'j', aspect: 'landscape', language: 'zh', idea: 'i' });
    const engine = await fakeEngine(dir);
    await assert.rejects(
      () => speakScript({ jobDir: dir, config: engine.config }),
      (e) => e.code === 'E_OUT_OF_ORDER',
    );
    assert.deepEqual(await engine.calls(), [], '拦住了就不该调引擎');
  });

  test('停点 2 没点头就配音，也要拦住', async () => {
    const dir = await tmp();
    await createJob(dir, { slug: 'j', aspect: 'landscape', language: 'zh', idea: 'i' });
    const job = await openJob(dir, 'script');
    job.set('interview', { questions: [{ id: 'IQ-1', text: '问', suggestion: '答', answer: '答了' }] });
    job.set('script', { sentences: [{ id: 'S-001', text: '一句。' }] });
    await job.save();
    const engine = await fakeEngine(dir);
    await assert.rejects(
      () => speakScript({ jobDir: dir, config: engine.config }),
      (e) => e.code === 'E_OUT_OF_ORDER' && /停点 2/.test(e.message),
    );
  });
});

describe('T-09 配音：一句一个文件', () => {
  test('每句配一个音频，文件名对得回句子编号', async () => {
    const dir = await readyJob();
    const engine = await fakeEngine(dir);
    const got = await speakScript({ jobDir: dir, config: engine.config });

    assert.equal(got.clips.length, 3);
    assert.deepEqual(got.spoken, ['S-001', 'S-002', 'S-003']);
    for (const clip of got.clips) {
      assert.ok(basename(clip.audioPath).startsWith(clip.sentenceId),
        `文件名该带上句子编号：${clip.audioPath}`);
      assert.ok(clip.audioPath.endsWith('.wav'), '配音那一层返回的一定是 .wav');
      assert.ok(Math.abs(clip.durationSec - 2) < 0.1, `时长该约 2 秒，实际 ${clip.durationSec}`);
    }
    const raw = await readJob(dir);
    assert.equal(raw.voice.clips.length, 3);
  });

  test('音频文件都放在任务目录的 audio 子目录里', async () => {
    const dir = await readyJob(['一句。']);
    const engine = await fakeEngine(dir);
    await speakScript({ jobDir: dir, config: engine.config });
    const names = await readdir(join(dir, 'audio'));
    assert.ok(names.some((n) => n.startsWith('S-001') && n.endsWith('.wav')), names.join(', '));
  });

  test('记下当时的文字，这样以后能看出句子改没改', async () => {
    const dir = await readyJob(['一句。']);
    const engine = await fakeEngine(dir);
    const got = await speakScript({ jobDir: dir, config: engine.config });
    assert.equal(got.clips[0].text, '一句。');
  });
});

describe('T-09 配音：能续跑，不重复花钱', () => {
  test('第二次跑，一句都不重配', async () => {
    const dir = await readyJob();
    const engine = await fakeEngine(dir);
    await speakScript({ jobDir: dir, config: engine.config });
    const first = (await engine.calls()).length;
    assert.equal(first, 3);

    const again = await speakScript({ jobDir: dir, config: engine.config });
    assert.equal((await engine.calls()).length, 3, '第二次不该再调引擎');
    assert.deepEqual(again.spoken, []);
    assert.deepEqual(again.reused, ['S-001', 'S-002', 'S-003']);
  });

  test('只有改过的那一句会重配', async () => {
    const dir = await readyJob();
    const engine = await fakeEngine(dir);
    await speakScript({ jobDir: dir, config: engine.config });

    const job = await openJob(dir, 'script');
    job.set('script', {
      sentences: [{ id: 'S-001', text: '第一句。' }, { id: 'S-002', text: '第二句改过了。' },
        { id: 'S-003', text: '第三句。' }],
    });
    await job.save();

    const again = await speakScript({ jobDir: dir, config: engine.config });
    assert.deepEqual(again.spoken, ['S-002'], '只该重配改过的那一句');
    assert.deepEqual(again.reused, ['S-001', 'S-003']);
    const calls = await engine.calls();
    assert.equal(calls.length, 4);
    assert.equal(calls.at(-1), '第二句改过了。');
  });

  test('文稿里删掉的句子，它的配音记录也要清掉', async () => {
    const dir = await readyJob();
    const engine = await fakeEngine(dir);
    await speakScript({ jobDir: dir, config: engine.config });
    const job = await openJob(dir, 'script');
    job.set('script', { sentences: [{ id: 'S-001', text: '第一句。' }] });
    await job.save();
    const again = await speakScript({ jobDir: dir, config: engine.config });
    assert.equal(again.clips.length, 1);
    assert.deepEqual((await readJob(dir)).voice.clips.map((c) => c.sentenceId), ['S-001']);
  });
});

describe('T-09 配音：一句坏了不拖垮整批', () => {
  test('配不出来的那一句跳过并记下，别的照样做完', async () => {
    const dir = await readyJob(['好的一句。', '坏的一句。', '也好的一句。']);
    const engine = await fakeEngine(dir, { failFor: ['坏的'] });
    const got = await speakScript({ jobDir: dir, config: engine.config });

    assert.deepEqual(got.spoken, ['S-001', 'S-003']);
    assert.equal(got.skipped.length, 1);
    assert.equal(got.skipped[0].sentenceId, 'S-002');
    assert.equal(got.skipped[0].code, 'E_ENGINE_FAILED');
    assert.ok(got.skipped[0].message.includes('装作配不出来'), got.skipped[0].message);
    assert.equal((await readJob(dir)).voice.clips.length, 2, '好的两句该存下来');
  });

  test('下一次跑会重试失败的那一句', async () => {
    const dir = await readyJob(['好的一句。', '坏的一句。']);
    const bad = await fakeEngine(dir, { failFor: ['坏的'] });
    await speakScript({ jobDir: dir, config: bad.config });
    await mkdir(join(dir, 'good'), { recursive: true });
    const good = await fakeEngine(join(dir, 'good'), {});
    const again = await speakScript({ jobDir: dir, config: good.config });
    assert.deepEqual(again.spoken, ['S-002'], '该重试失败的那一句');
    assert.deepEqual(again.reused, ['S-001']);
  });
});

describe('T-09 停点 4：一条只有声音的文件', () => {
  test('按句子顺序拼成一条，时长约等于各句之和', async () => {
    const dir = await readyJob();
    const engine = await fakeEngine(dir);
    const spoken = await speakScript({ jobDir: dir, config: engine.config });
    const out = join(dir, 'audio-only.wav');
    const got = await buildAudioOnly({ jobDir: dir, outPath: out });

    assert.equal(got.count, 3);
    const expected = spoken.clips.reduce((sum, c) => sum + c.durationSec, 0);
    const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'csv=p=0', got.path]);
    const real = Number(stdout.trim());
    assert.ok(Math.abs(real - expected) < 0.3, `拼出来 ${real} 秒，各句之和 ${expected} 秒`);
    assert.ok(Math.abs(got.durationSec - real) < 0.05, '报的时长要和文件真实时长一致');
  });

  test('一句配音都没有时报 E_NOTHING_TO_PLAY，不产生半个文件', async () => {
    const dir = await readyJob();
    await assert.rejects(
      () => buildAudioOnly({ jobDir: dir, outPath: join(dir, 'x.wav') }),
      (e) => e.code === 'E_NOTHING_TO_PLAY',
    );
  });

  test('路径里有空格和单引号也拼得出来', async () => {
    const dir = await readyJob(["带 空格 和 ' 引号 的一句。"]);
    const engine = await fakeEngine(dir);
    await speakScript({ jobDir: dir, config: engine.config });
    const out = join(dir, "音频 只有声音'的.wav");
    const got = await buildAudioOnly({ jobDir: dir, outPath: out });
    assert.ok(got.durationSec > 0);
  });
});

// ---------------------------------------------------------------------------
// 缩放、补长、分批拼接
// ---------------------------------------------------------------------------
import { renderSegment, FILL, TARGET } from '../src/render/segment.js';
import { renderVideo, concatSegments } from '../src/render/concat.js';

/** 造一段纯色素材，尺寸和时长都指定。 */
async function makeClip(path, { width = 640, height = 360, seconds = 6, colour = 'black' } = {}) {
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    `color=c=${colour}:s=${width}x${height}:r=25:d=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path]);
}
const probe = async (path, entry) => {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', entry, '-of', 'csv=p=0', path]);
  return stdout.trim();
};
/** 一个只有一句、画面和配音都手写好的任务。 */
async function oneShotJob({ aspect = 'landscape', assetSeconds = 6, assetWidth = 640, assetHeight = 360,
  windowSeconds = 6, audioSeconds = 2 } = {}) {
  const dir = await tmp();
  const asset = join(dir, 'asset.mp4');
  const audio = join(dir, 'a.wav');
  await makeClip(asset, { width: assetWidth, height: assetHeight, seconds: assetSeconds });
  await makeWav(audio, audioSeconds);
  await createJob(dir, { slug: 'j', aspect, language: 'zh', idea: 'i' });
  const trimmed = join(dir, 'trimmed.wav');
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', audio,
    '-af', 'silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB:detection=peak,areverse,'
      + 'silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB:detection=peak,areverse',
    '-c:a', 'pcm_s16le', trimmed]);
  const realAudio = Number(await probe(trimmed, 'format=duration'));
  const plan = await openJob(dir, 'shotplan');
  plan.set('shotplan', {
    shots: [{ sentenceId: 'S-001', assetPath: asset, startSec: 0, endSec: windowSeconds, subtitle: '测试字幕' }],
    missing: [],
  });
  await plan.save();
  const v = await openJob(dir, 'voice');
  v.set('voice', { engine: 'x', clips: [{ sentenceId: 'S-001', text: '测试字幕', audioPath: trimmed, durationSec: realAudio }] });
  await v.save();
  return { dir, realAudio };
}

describe('T-09 先缩放到目标分辨率，再烧字幕', () => {
  test('横屏出 1920x1080，竖屏出 1080x1920', async () => {
    assert.deepEqual(TARGET.landscape, { width: 1920, height: 1080 });
    assert.deepEqual(TARGET.portrait, { width: 1080, height: 1920 });
  });

  test('片段的尺寸就是目标尺寸，不管素材原来多大', async () => {
    const { dir } = await oneShotJob({ assetWidth: 640, assetHeight: 360 });
    const out = join(dir, 'o.mp4');
    await renderSegment({ jobDir: dir, sentenceId: 'S-001', outPath: out, target: { width: 320, height: 180 } });
    assert.equal(await probe(out, 'stream=width'), '320');
    assert.equal(await probe(out, 'stream=height'), '180');
  });

  test('比例不同的素材加黑边，不拉伸', async () => {
    // 4:3 的素材放进 16:9 的框，左右该有黑边
    const { dir } = await oneShotJob({ assetWidth: 480, assetHeight: 360, colour: 'white' });
    const out = join(dir, 'o.mp4');
    await renderSegment({ jobDir: dir, sentenceId: 'S-001', outPath: out, target: { width: 320, height: 180 } });
    assert.equal(await probe(out, 'stream=width'), '320');
    // 左边 20 像素该是黑的（黑边），中间不是
    const edge = await run(FFMPEG, ['-hide_banner', '-nostats', '-loglevel', 'info', '-i', out,
      '-vf', 'crop=20:180:0:0,signalstats,metadata=print:file=-', '-f', 'null', '/dev/null'],
      { maxBuffer: 1 << 24 }).catch((e) => e);
    const y = Number(/YAVG=([0-9.]+)/.exec(`${edge.stdout ?? ''}${edge.stderr ?? ''}`)[1]);
    assert.ok(y < 20, `左边该是黑边，实际亮度 ${y}`);
  });
});

describe('T-09 Q-6：素材盖不住旁白时补长', () => {
  test('够长就正常裁，方法是 none', async () => {
    const { dir, realAudio } = await oneShotJob({ windowSeconds: 6, audioSeconds: 2 });
    const got = await renderSegment({ jobDir: dir, sentenceId: 'S-001', outPath: join(dir, 'o.mp4'),
      target: { width: 320, height: 180 } });
    assert.equal(got.fill, FILL.none);
    assert.ok(Math.abs(got.durationSec - realAudio) < 0.15, `${got.durationSec} vs ${realAudio}`);
  });

  test('缺口在 20% 以内就放慢，时长补齐，方法是 slow', async () => {
    // 窗口 1.8 秒，旁白 2 秒 → 缺 10%
    const { dir, realAudio } = await oneShotJob({ windowSeconds: 1.8, audioSeconds: 2, assetSeconds: 6 });
    const got = await renderSegment({ jobDir: dir, sentenceId: 'S-001', outPath: join(dir, 'o.mp4'),
      target: { width: 320, height: 180 } });
    assert.equal(got.fill, FILL.slow, `该放慢，实际 ${got.fill}`);
    assert.ok(Math.abs(got.durationSec - realAudio) < 0.2, `时长该补齐到 ${realAudio}，实际 ${got.durationSec}`);
  });

  test('缺口超过 20% 就循环重放，方法是 loop', async () => {
    // 窗口 0.6 秒，旁白 2 秒 → 缺 70%
    const { dir, realAudio } = await oneShotJob({ windowSeconds: 0.6, audioSeconds: 2, assetSeconds: 6 });
    const got = await renderSegment({ jobDir: dir, sentenceId: 'S-001', outPath: join(dir, 'o.mp4'),
      target: { width: 320, height: 180 } });
    assert.equal(got.fill, FILL.loop, `该循环，实际 ${got.fill}`);
    assert.ok(Math.abs(got.durationSec - realAudio) < 0.2, `时长该补齐到 ${realAudio}，实际 ${got.durationSec}`);
  });

  test('补长的门槛写在模块里，能看得到', () => {
    assert.deepEqual(Object.keys(FILL).sort(), ['loop', 'none', 'slow']);
  });
});

describe('T-09 拼接：一次过，不分批', () => {
  /** 造一段能拼的片段：参数和 renderSegment 出来的一致。 */
  const makePart = async (path, { seconds = 0.4, width = 320, height = 180, fps = 30, codec = 'libx264' } = {}) =>
    run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${seconds}`,
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(seconds),
      '-c:v', codec, '-pix_fmt', 'yuv420p', '-r', String(fps),
      '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-shortest', path]);

  test('三段拼成一条，时长约等于三段之和，而且是直接拷流', async () => {
    const dir = await tmp();
    const parts = [];
    for (let i = 0; i < 3; i += 1) {
      const p = join(dir, `p${i}.mp4`);
      await makePart(p, { seconds: 1 });
      parts.push(p);
    }
    const got = await concatSegments({ parts, outPath: join(dir, 'all.mp4') });
    assert.equal(got.method, 'copy', '参数一致就该拷流，不该重编');
    assert.ok(Math.abs(got.durationSec - 3) < 0.3, `该约 3 秒，实际 ${got.durationSec}`);
  });

  test('25 段也是一次拼完——concat 分离器读的是清单文件，没有 20 段那个上限', async () => {
    const dir = await tmp();
    const source = join(dir, 'src.mp4');
    await makePart(source, { seconds: 0.4 });
    const { copyFile } = await import('node:fs/promises');
    const parts = [];
    for (let i = 0; i < 25; i += 1) {
      const p = join(dir, `p${String(i).padStart(2, '0')}.mp4`);
      await copyFile(source, p);
      parts.push(p);
    }
    const got = await concatSegments({ parts, outPath: join(dir, 'all.mp4') });
    assert.equal(got.passes, 1, '25 段该一趟拼完');
    assert.ok(Math.abs(got.durationSec - 25 * 0.4) < 1, `该约 10 秒，实际 ${got.durationSec}`);
    await run(FFMPEG, ['-v', 'error', '-i', got.path, '-f', 'null', '-']); // 完整解码一遍
  });

  test('参数不一致时退回重编，时长照样是对的', async () => {
    // 拷流拼不同编码/尺寸的段落，最坏情况是悄悄坏掉而不是报错。所以要量。
    const dir = await tmp();
    const a = join(dir, 'a.mp4');
    const b = join(dir, 'b.mp4');
    await makePart(a, { seconds: 1, width: 320, height: 180, fps: 30 });
    await makePart(b, { seconds: 1, width: 640, height: 360, fps: 10, codec: 'mpeg4' });
    const got = await concatSegments({ parts: [a, b], outPath: join(dir, 'all.mp4') });
    assert.equal(got.method, 'reencode', `参数不一致该重编，实际 ${got.method}`);
    assert.ok(Math.abs(got.durationSec - 2) < 0.4, `该约 2 秒，实际 ${got.durationSec}`);
    await run(FFMPEG, ['-v', 'error', '-i', got.path, '-f', 'null', '-']);
  });

  test('一段都没有时报 E_NOTHING_TO_CONCAT', async () => {
    const dir = await tmp();
    await assert.rejects(
      () => concatSegments({ parts: [], outPath: join(dir, 'x.mp4') }),
      (e) => e.code === 'E_NOTHING_TO_CONCAT',
    );
  });

  test('路径里带单引号也拼得出来', async () => {
    const dir = await tmp();
    const odd = join(dir, "it's a clip.mp4");
    await makePart(odd, { seconds: 1 });
    const got = await concatSegments({ parts: [odd, odd], outPath: join(dir, 'all.mp4') });
    assert.ok(Math.abs(got.durationSec - 2) < 0.3);
  });
});

describe('T-09 一句想法到成片：renderVideo', () => {
  test('守门：停点 4 没点头不许渲染', async () => {
    const { dir } = await oneShotJob();
    const job = await openJob(dir, 'script');
    job.set('interview', { questions: [{ id: 'IQ-1', text: '问', suggestion: '答', answer: '答了' }] });
    job.set('script', { sentences: [{ id: 'S-001', text: '测试字幕' }] });
    await job.save();
    await approveStop(dir, 2);
    await approveStop(dir, 3);
    await assert.rejects(
      () => renderVideo({ jobDir: dir, target: { width: 320, height: 180 } }),
      (e) => e.code === 'E_OUT_OF_ORDER' && /停点 4/.test(e.message),
    );
  });

  test('四个停点都点头之后，出一条能播的成片，并写进 render 节', async () => {
    const { dir, realAudio } = await oneShotJob();
    const job = await openJob(dir, 'script');
    job.set('interview', { questions: [{ id: 'IQ-1', text: '问', suggestion: '答', answer: '答了' }] });
    job.set('script', { sentences: [{ id: 'S-001', text: '测试字幕' }] });
    await job.save();
    await approveStop(dir, 2);
    await approveStop(dir, 3);
    await approveStop(dir, 4);

    const got = await renderVideo({ jobDir: dir, target: { width: 320, height: 180 } });
    assert.ok(got.output.endsWith('.mp4'));
    await run(FFMPEG, ['-v', 'error', '-i', got.output, '-f', 'null', '-']); // 完整解码一遍
    const kinds = (await probe(got.output, 'stream=codec_type')).split('\n').sort();
    assert.deepEqual(kinds, ['audio', 'video']);
    assert.ok(Math.abs(Number(await probe(got.output, 'format=duration')) - realAudio) < 0.3);
    const raw = await readJob(dir);
    assert.equal(raw.render.output, got.output);
    assert.equal(raw.render.segments.length, 1);
  });

  test('缺素材的句子不参与渲染，但要报出来', async () => {
    const { dir } = await oneShotJob();
    const job = await openJob(dir, 'script');
    job.set('interview', { questions: [{ id: 'IQ-1', text: '问', suggestion: '答', answer: '答了' }] });
    job.set('script', { sentences: [{ id: 'S-001', text: '测试字幕' }, { id: 'S-002', text: '没画面的一句' }] });
    await job.save();
    const plan = await openJob(dir, 'shotplan');
    plan.set('shotplan', {
      ...(await readJob(dir)).shotplan,
      missing: [{ sentenceId: 'S-002', reason: '没有合适素材' }],
    });
    await plan.save();
    await approveStop(dir, 2);
    await approveStop(dir, 3);
    await approveStop(dir, 4);
    const got = await renderVideo({ jobDir: dir, target: { width: 320, height: 180 } });
    assert.deepEqual(got.skippedSentences, ['S-002']);
    assert.equal(got.segments.length, 1);
  });
});

describe('T-09 字幕真的落在画面下部——横屏和竖屏都要', () => {
  /** 量一块区域的平均亮度。`crop` 用相对表达式，不写死尺寸。 */
  const brightness = async (path, crop) => {
    const res = await run(FFMPEG, ['-hide_banner', '-nostats', '-loglevel', 'info', '-i', path,
      '-vf', `${crop},signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
      '-f', 'null', '/dev/null'], { maxBuffer: 1 << 24 }).catch((e) => e);
    const m = `${res.stdout ?? ''}${res.stderr ?? ''}`.match(/YAVG=([0-9.]+)/);
    assert.ok(m, `读不到 YAVG：${path}`);
    return Number(m[1]);
  };

  for (const [aspect, size] of [['landscape', { width: 960, height: 540 }],
    ['portrait', { width: 540, height: 960 }]]) {
    test(`${aspect}：字幕在下面 25%，上面一半干干净净`, async () => {
      // 这条测试是为了抓一个真实的 bug：竖屏的字幕曾经被画在画面**顶部**。
      // 原因是 libass 把 force_style 里的像素按「画面高 / 脚本高（默认 288）」放大，
      // 1920 高时 MarginV=220 变成 1525。当时每个单元测试都是绿的。
      const { dir } = await oneShotJob({ aspect, assetWidth: 640, assetHeight: 360 });
      const out = join(dir, 'o.mp4');
      await renderSegment({ jobDir: dir, sentenceId: 'S-001', outPath: out, target: size });

      const bottom = await brightness(out, 'crop=iw:ih/4:0:ih*3/4');
      const top = await brightness(out, 'crop=iw:ih/2:0:0');
      // 比"下面 25%"和"上面一半"，不用绝对阈值：字幕在大画面里占的比例小，
      // 平均亮度抬得不多，写死阈值会误判。
      assert.ok(bottom > top + 0.5,
        `字幕该在下面 25%：下面亮度 ${bottom}，上面 ${top}，差得太少`);
      assert.ok(top < 16.2, `上面一半该是干净的，亮度却有 ${top}——字幕画错位置了`);
    });
  }

  test('字幕文件把 PlayRes 钉成成片分辨率——不钉，像素就不是像素', async () => {
    const { dir } = await oneShotJob({ aspect: 'portrait' });
    const out = join(dir, 'o.mp4');
    await renderSegment({ jobDir: dir, sentenceId: 'S-001', outPath: out, target: { width: 540, height: 960 } });
    const { readFile } = await import('node:fs/promises');
    const doc = await readFile(`${out}.ass`, 'utf8');
    assert.match(doc, /^PlayResX: 540$/m);
    assert.match(doc, /^PlayResY: 960$/m);
  });
});
