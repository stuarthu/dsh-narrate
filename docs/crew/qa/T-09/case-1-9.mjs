// T-09 的 QA 用例 1 到 9。跑法：node docs/crew/qa/T-09/case-1-9.mjs
// 计划见 docs/crew/qa/T-09-plan.md
//
// 这些用例是**从验收检查写的，不是从代码写的**。从代码出发写的检查只会证明
// "代码现在干了什么"，那永远通过。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const run = promisify(execFile);
const FFMPEG = process.env.DSH_FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.DSH_FFPROBE_PATH || 'ffprobe';

const { createJob, openJob, readJob } = await import(join(ROOT, 'src/flow/job.js'));
const { approveStop } = await import(join(ROOT, 'src/flow/run.js'));
const { speakScript, buildAudioOnly } = await import(join(ROOT, 'src/voice/speak.js'));
const { renderVideo, concatSegments } = await import(join(ROOT, 'src/render/concat.js'));
const { defaultEngineConfig } = await import(join(ROOT, 'src/voice/engines/default.js'));

let failures = 0;
let skips = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  通过    ${name}`);
  } catch (error) {
    if (error?.qaSkip) {
      skips += 1;
      console.log(`  跳过    ${name}\n          ${error.message}`);
      return;
    }
    failures += 1;
    console.log(`  失败    ${name}\n          ${error.message}`);
  }
};
const skip = (why) => { const e = new Error(why); e.qaSkip = true; throw e; };

const tmp = () => mkdtemp(join(tmpdir(), 'narrate-qa9-'));
const probe = async (path, entry) => {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', entry, '-of', 'csv=p=0', path]);
  return stdout.trim();
};
const duration = async (path) => Number(await probe(path, 'format=duration'));
/** 完整解码一遍。有任何输出就是有坏帧。 */
const decodeClean = async (path) => {
  const { stderr } = await run(FFMPEG, ['-v', 'error', '-i', path, '-f', 'null', '-'], { maxBuffer: 1 << 24 });
  assert.equal(String(stderr ?? '').trim(), '', `解码有坏帧：\n${stderr}`);
};
/** 一块区域的平均亮度。 */
const brightness = async (path, crop) => {
  const res = await run(FFMPEG, ['-hide_banner', '-nostats', '-loglevel', 'info', '-i', path,
    '-vf', `${crop},signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
    '-f', 'null', '/dev/null'], { maxBuffer: 1 << 24 }).catch((e) => e);
  const m = `${res.stdout ?? ''}${res.stderr ?? ''}`.match(/YAVG=([0-9.]+)/);
  assert.ok(m, '读不到 YAVG');
  return Number(m[1]);
};

/** 一段纯色素材。 */
const makeClip = (path, { width = 1280, height = 720, seconds = 8 } = {}) =>
  run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `color=c=black:s=${width}x${height}:r=25:d=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path]);

/** 一个假语音引擎：每句都给一段固定长度的音频。用它跑不联网的用例。 */
async function fakeEngine(dir, seconds = 2) {
  const src = join(dir, 'tone.wav');
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `sine=f=440:d=${seconds}`, '-c:a', 'pcm_s16le', src]);
  const script = join(dir, 'engine.mjs');
  await writeFile(script, `import { copyFileSync } from 'node:fs';\n`
    + `copyFileSync(${JSON.stringify(src)}, process.argv[3]);\n`, 'utf8');
  return { command: [process.execPath, script, '%TEXT_FILE%', '%OUT_FILE%'] };
}

/**
 * 走到"可以配音"为止：问答答完、文稿写好、画面对应表做好，停点 2 和 3 都点过头。
 *
 * 少了画面对应表这一节，`assertReady` 会正确地拦住配音——次序是产品本身，不是摆设。
 */
async function readyToSpeak(dir, { sentences, asset, aspect = 'landscape', language = 'zh' }) {
  await createJob(dir, { slug: 'qa9', aspect, language, idea: 'qa' });
  const j = await openJob(dir, 'script');
  j.set('interview', { questions: [{ id: 'IQ-1', text: '给谁看', suggestion: '', answer: '普通观众' }] });
  j.set('script', { sentences });
  await j.save();
  const p = await openJob(dir, 'shotplan');
  p.set('shotplan', { shots: sentences.map((s) => ({
    sentenceId: s.id, assetPath: asset, startSec: 0, endSec: 8, subtitle: s.text,
  })), missing: [] });
  await p.save();
  await approveStop(dir, 2);
  await approveStop(dir, 3);
}

/** 一个走到"配音做完、四个停点都点过头"的任务。 */
async function readyJob(dir, { aspect = 'landscape', sentences, assets, config }) {
  await createJob(dir, { slug: 'qa9', aspect, language: 'zh', idea: 'qa' });
  const j = await openJob(dir, 'script');
  j.set('interview', { questions: [{ id: 'IQ-1', text: '给谁看', suggestion: '', answer: '普通观众' }] });
  j.set('script', { sentences });
  await j.save();
  const p = await openJob(dir, 'shotplan');
  p.set('shotplan', { shots: sentences.map((s, i) => ({
    sentenceId: s.id, assetPath: assets[i % assets.length],
    startSec: 0, endSec: 8, subtitle: s.text,
  })), missing: [] });
  await p.save();
  await approveStop(dir, 2);
  await approveStop(dir, 3);
  const said = await speakScript({ jobDir: dir, config });
  await approveStop(dir, 4);
  return said;
}

console.log('T-09 QA：');

// ---- 用例 1（A-8）：每句一个音频文件，名字对得回句子编号 ----
await check('1（A-8）配完音，每句一个音频文件，文件名带得回句子编号', async () => {
  const dir = await tmp();
  const config = await fakeEngine(dir);
  const asset = join(dir, 'a.mp4');
  await makeClip(asset);
  const sentences = [{ id: 'S-001', text: '第一句。' }, { id: 'S-002', text: '第二句。' }, { id: 'S-003', text: '第三句。' }];
  await readyToSpeak(dir, { sentences, asset });
  const said = await speakScript({ jobDir: dir, config });
  assert.equal(said.spoken.length, 3, `该配出 3 句，实际 ${said.spoken.length}`);
  const files = await readdir(join(dir, 'audio'));
  for (const s of sentences) {
    // 只数音频文件——A-8 说的是"每句一个音频文件"
    const mine = files.filter((f) => f.includes(s.id) && /\.(wav|mp3|m4a|ogg|opus|flac)$/i.test(f));
    assert.equal(mine.length, 1, `${s.id} 该有且只有一个音频文件，实际 ${JSON.stringify(mine)}`);
    assert.ok(await duration(join(dir, 'audio', mine[0])) > 0.5, `${s.id} 的音频读不出正常时长`);
  }
});

// ---- 用例 2（A-9）：停点 4 的纯音频能播，内容对得上 ----
await check('2（A-9）停点 4 的纯音频能解码，时长约等于各句之和', async () => {
  const dir = await tmp();
  const config = await fakeEngine(dir, 2);
  const sentences = [{ id: 'S-001', text: '第一句。' }, { id: 'S-002', text: '第二句。' }];
  const asset = join(dir, 'a.mp4');
  await makeClip(asset);
  await readyToSpeak(dir, { sentences, asset });
  await speakScript({ jobDir: dir, config });
  const out = join(dir, 'preview.wav');
  const got = await buildAudioOnly({ jobDir: dir, outPath: out });
  assert.equal(got.count, 2, `该是 2 句，实际 ${got.count}`);
  await decodeClean(out);
  const each = (await readJob(dir)).voice.clips.map((c) => c.durationSec);
  const want = each.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(await duration(out) - want) < 0.3, `纯音频该约 ${want} 秒，实际 ${await duration(out)}`);
});

// ---- 用例 3（A-16）：65 段能拼成一条 ----
await check('3（A-16）65 段拼成一条，时长对，完整解码无坏帧', async () => {
  const dir = await tmp();
  const one = join(dir, 'one.mp4');
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=0.4',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '0.4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-shortest', one]);
  const parts = [];
  for (let i = 0; i < 65; i += 1) {
    const p = join(dir, `p${String(i).padStart(3, '0')}.mp4`);
    await copyFile(one, p);
    parts.push(p);
  }
  const got = await concatSegments({ parts, outPath: join(dir, 'all.mp4') });
  const want = 65 * 0.4;
  assert.ok(Math.abs(got.durationSec - want) < 1.5, `该约 ${want} 秒，实际 ${got.durationSec}`);
  await decodeClean(got.path);
});

// ---- 用例 4（A-17）：竖屏 1080x1920，字幕不超出左右边 ----
await check('4（A-17）竖屏出片是 1080x1920，字幕没超出左右边', async () => {
  const dir = await tmp();
  const config = await fakeEngine(dir, 3);
  const asset = join(dir, 'a.mp4');
  await makeClip(asset, { width: 1280, height: 720, seconds: 8 });
  // 一句长得足够触发换行，用来看会不会顶到左右边
  await readyJob(dir, { aspect: 'portrait', config, assets: [asset],
    sentences: [{ id: 'S-001', text: '这是一句故意写得比较长的话，好让它必须换行才放得下。' }] });
  const got = await renderVideo({ jobDir: dir });
  assert.equal(await probe(got.output, 'stream=width'), '1080');
  assert.equal(await probe(got.output, 'stream=height'), '1920');
  // 最左和最右各 12 像素宽的竖条：素材是 16:9 放进 9:16，上下才有黑边，左右满幅，
  // 所以这里量的是"字有没有顶到边"。素材是纯黑，字是白的，顶到边就会亮起来。
  const left = await brightness(got.output, 'crop=12:ih:0:0');
  const right = await brightness(got.output, 'crop=12:ih:iw-12:0');
  assert.ok(left < 17, `字幕顶到左边了，左边亮度 ${left}`);
  assert.ok(right < 17, `字幕顶到右边了，右边亮度 ${right}`);
});

// ---- 用例 5（A-17 追加）：字幕在下部，上半干净 ----
await check('5（A-17 追加）竖屏字幕在画面下部，上半干净', async () => {
  const dir = await tmp();
  const config = await fakeEngine(dir, 3);
  const asset = join(dir, 'a.mp4');
  await makeClip(asset, { width: 1080, height: 1920, seconds: 8 });
  await readyJob(dir, { aspect: 'portrait', config, assets: [asset],
    sentences: [{ id: 'S-001', text: '字幕该在下面。' }] });
  const got = await renderVideo({ jobDir: dir });
  const bottom = await brightness(got.output, 'crop=iw:ih/4:0:ih*3/4');
  const top = await brightness(got.output, 'crop=iw:ih/2:0:0');
  assert.ok(bottom > top + 0.5, `字幕该在下面 25%：下 ${bottom}，上 ${top}`);
  assert.ok(top < 16.2, `上半该干净，亮度却有 ${top}——字幕画错位置了`);
});

// ---- 用例 6（A-18）：英文文稿 ----
await check('6（A-18）英文文稿：旁白是英文，字幕文件里是英文', async () => {
  let reachable = false;
  try {
    await fetch('https://speech.platform.bing.com/', { signal: AbortSignal.timeout(5000) });
    reachable = true;
  } catch { reachable = false; }
  if (!reachable) skip('连不上语音服务，没网。这不是代码的问题');

  const dir = await tmp();
  const asset = join(dir, 'a.mp4');
  await makeClip(asset, { width: 1280, height: 720, seconds: 12 });
  await createJob(dir, { slug: 'qa9en', aspect: 'landscape', language: 'en', idea: 'qa' });
  const sentences = [{ id: 'S-001', text: 'Rust is fast, and not because it is new.' }];
  const j = await openJob(dir, 'script');
  j.set('interview', { questions: [{ id: 'IQ-1', text: 'who', suggestion: '', answer: 'general' }] });
  j.set('script', { sentences });
  await j.save();
  const p = await openJob(dir, 'shotplan');
  p.set('shotplan', { shots: [{ sentenceId: 'S-001', assetPath: asset, startSec: 0, endSec: 12,
    subtitle: sentences[0].text }], missing: [] });
  await p.save();
  await approveStop(dir, 2);
  await approveStop(dir, 3);
  let said;
  try {
    said = await speakScript({ jobDir: dir, config: defaultEngineConfig() });
  } catch (error) {
    skip(`配音的时候网络断了：${error.message}`);
  }
  if (said.skipped.length > 0) {
    const why = said.skipped[0].message ?? '';
    if (/AggregateError|ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed/i.test(why)) skip(`网络断了：${why}`);
    assert.fail(`配音失败：${JSON.stringify(said.skipped)}`);
  }
  await approveStop(dir, 4);
  const got = await renderVideo({ jobDir: dir });
  await decodeClean(got.output);
  const ass = await readFile(`${got.segments[0].path}.ass`, 'utf8');
  const event = ass.split('\n').find((line) => line.startsWith('Dialogue:'));
  assert.ok(/Rust is fast/.test(event), `字幕该是英文，实际：${event}`);
  assert.ok(got.durationSec > 1, `英文旁白该有长度，实际 ${got.durationSec}`);
});

// ---- 用例 7（Q-6）：素材比旁白短 ----
await check('7（Q-6）素材比旁白短：缺口小的放慢、大的循环，时长都补齐', async () => {
  for (const [window, wantFill] of [[2.7, 'slow'], [1.0, 'loop']]) {
    const dir = await tmp();
    const config = await fakeEngine(dir, 3);
    const asset = join(dir, 'a.mp4');
    await makeClip(asset, { width: 640, height: 360, seconds: 8 });
    const sentences = [{ id: 'S-001', text: '一句话。' }];
    await readyToSpeak(dir, { sentences, asset });
    // 窗口要短于旁白，这才是这条用例要测的
    const p = await openJob(dir, 'shotplan');
    p.set('shotplan', { shots: [{ sentenceId: 'S-001', assetPath: asset, startSec: 0,
      endSec: window, subtitle: '一句话。' }], missing: [] });
    await p.save();
    await speakScript({ jobDir: dir, config });
    await approveStop(dir, 4);
    const got = await renderVideo({ jobDir: dir });
    const want = (await readJob(dir)).voice.clips[0].durationSec;
    assert.equal(got.segments[0].fill, wantFill,
      `窗口 ${window} 秒、旁白 ${want} 秒时该用 ${wantFill}，实际 ${got.segments[0].fill}`);
    assert.ok(Math.abs(got.durationSec - want) < 0.3,
      `${wantFill}：成片该约 ${want} 秒，实际 ${got.durationSec}`);
  }
});

// ---- 用例 8（A-12）：五样中间产物都在 ----
await check('8（A-12）中间产物齐全：索引、文稿、对应表、逐句音频、.ass 字幕', async () => {
  const dir = await tmp();
  const config = await fakeEngine(dir, 3);
  // 素材放在自己的文件夹里，好让入库扫得到它
  const assetsRoot = join(dir, 'assets');
  await mkdir(assetsRoot, { recursive: true });
  const asset = join(assetsRoot, 'a.mp4');
  await makeClip(asset, { width: 640, height: 360, seconds: 8 });
  const sentences = [{ id: 'S-001', text: '一句话。' }];
  await readyJob(dir, { config, assets: [asset], sentences });
  // 入库：这一步才写出索引
  const { scanAssets } = await import(join(ROOT, 'src/assets-index/scan.js'));
  await scanAssets({ assetsRoot });
  const got = await renderVideo({ jobDir: dir });

  const job = await readJob(dir);
  // 1 索引：素材旁边那个 json
  const { access } = await import('node:fs/promises');
  await access(asset.replace(/\.mp4$/, '.json'));
  // 2 文稿、3 对应表：工作文件里的两节
  assert.ok((job.script?.sentences ?? []).length > 0, '文稿不在');
  assert.ok((job.shotplan?.shots ?? []).length > 0, '画面对应表不在');
  // 4 逐句音频
  await access(job.voice.clips[0].audioPath);
  // 5 字幕文件。**原来这一条要的是 .srt**，改成 .ass 的理由写在 prd.md 的 A-12 里。
  await access(`${got.segments[0].path}.ass`);
});

// ---- 用例 9（A-10）：多句成片里，每一句的画面时长都跟着自己那句音频 ----
await check('9（A-10）每句的画面时长和该句音频相差不超过 0.2 秒', async () => {
  const dir = await tmp();
  // 每句给不同长度的音频，才验得出"跟着自己那句"而不是"都一样长"
  const lengths = [1.5, 3, 2.2];
  const engines = [];
  for (const [i, seconds] of lengths.entries()) {
    await mkdir(join(dir, `e${i}`), { recursive: true });
    engines.push(await fakeEngine(join(dir, `e${i}`), seconds));
  }
  const asset = join(dir, 'a.mp4');
  await makeClip(asset, { width: 640, height: 360, seconds: 12 });
  const sentences = lengths.map((_, i) => ({ id: `S-00${i + 1}`, text: `第 ${i + 1} 句。` }));
  await createJob(dir, { slug: 'qa9', aspect: 'landscape', language: 'zh', idea: 'qa' });
  const j = await openJob(dir, 'script');
  j.set('interview', { questions: [{ id: 'IQ-1', text: '问', suggestion: '', answer: '答' }] });
  j.set('script', { sentences });
  await j.save();
  const p2 = await openJob(dir, 'shotplan');
  p2.set('shotplan', { shots: sentences.map((s) => ({
    sentenceId: s.id, assetPath: asset, startSec: 0, endSec: 12, subtitle: s.text,
  })), missing: [] });
  await p2.save();
  await approveStop(dir, 2);
  await approveStop(dir, 3);
  // 一句一个引擎，好让三句真的长度不同
  for (const [i, sentence] of sentences.entries()) {
    const only = await openJob(dir, 'script');
    only.set('script', { sentences: [sentence] });
    await only.save();
    await speakScript({ jobDir: dir, config: engines[i] });
  }
  // 三句都放回去，逐句录音留着（文字没变就不重配）
  const all = await openJob(dir, 'script');
  all.set('script', { sentences });
  await all.save();
  await speakScript({ jobDir: dir, config: engines[0] });
  await approveStop(dir, 4);

  const got = await renderVideo({ jobDir: dir });
  const audio = new Map((await readJob(dir)).voice.clips.map((c) => [c.sentenceId, c.durationSec]));
  assert.equal(got.segments.length, 3, `该有 3 段，实际 ${got.segments.length}`);
  for (const seg of got.segments) {
    const want = audio.get(seg.sentenceId);
    assert.ok(Math.abs(seg.durationSec - want) <= 0.2,
      `${seg.sentenceId} 画面 ${seg.durationSec} 秒，音频 ${want} 秒，差得超过 0.2`);
  }
});

console.log(failures === 0 ? `T-09 QA 全部通过${skips > 0 ? `（跳过 ${skips} 个）` : ''}` : `T-09 QA 有 ${failures} 个失败`);
process.exit(failures === 0 ? 0 : 1);
