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
