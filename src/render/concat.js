// 拼成片。契约：docs/crew/api/flow-stages.md
//
// 两件事值得先说清楚：
//
//   1. **不分批。** 计划里原来写着「单次上限 20 段」，那个 20 是 `dsh-ffmpeg` 那个
//      `concat` 工具的上限。这里直接调 ffmpeg 的 **concat 分离器**，要拼哪些段是写在
//      一个文本清单里的，所以根本没有段数上限。为一个我们不走的限制去分批，代价是中间
//      段要多编一次，白掉一代画质。
//   2. **先比参数再决定，拼完还要验。** 每一段都是 `segment.js` 按 `SEGMENT_FORMAT`
//      出的，参数一致，所以 `-c copy` 就够，不用重新编码。参数不一致就直接重编，不试
//      拷流——实测过一次：把 h264/320x180/30fps 和 mpeg4/640x360/10fps 拷流拼起来，
//      ffmpeg **退出码是 0**，时长也只差 0.02 秒，但帧数少了四分之一，后半段解码全是
//      `no frame!`。这就是为什么光看退出码和时长不算验过：还要**把成片完整解码一遍**。
import { mkdir, open, rename, unlink, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';

import { openJob, readJob } from '../flow/job.js';
import { assertReady } from '../flow/run.js';
import { renderSegment, TARGET, SEGMENT_FORMAT } from './segment.js';

const run = promisify(execFile);
const FFMPEG = () => process.env.DSH_FFMPEG_PATH || 'ffmpeg';
const FFPROBE = () => process.env.DSH_FFPROBE_PATH || 'ffprobe';

export class ConcatError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConcatError';
    this.code = code;
  }
}

const round = (n) => Math.round(n * 1000) / 1000;

/** concat 清单里的一行。单引号要按 ffmpeg 的规矩转义，否则带引号的路径会拼错。 */
const concatLine = (path) => `file '${path.replace(/'/g, "'\\''")}'`;

async function probeDuration(path) {
  const { stdout } = await run(FFPROBE(), ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', path]);
  const seconds = Number(String(stdout).trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/**
 * 拷流拼接要求所有段落的这些参数完全一样。列出来的每一项都试过：任何一项不一致，
 * 拷流出来的片子后半段就是坏的，而 ffmpeg 不会报错。
 */
async function probeShape(path) {
  const { stdout } = await run(FFPROBE(), ['-v', 'error',
    '-show_entries', 'stream=codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels',
    '-of', 'json', path]);
  const streams = JSON.parse(stdout).streams ?? [];
  return streams.map((st) => [st.codec_name, st.width, st.height, st.pix_fmt,
    st.r_frame_rate, st.sample_rate, st.channels].join('/')).join('|');
}

/**
 * 把整条片子解码一遍，看有没有坏帧。
 *
 * 这是唯一靠得住的「这条片子好不好」的检查。退出码会骗人，时长也会。
 */
async function decodesClean(path) {
  try {
    const { stderr } = await run(FFMPEG(), ['-v', 'error', '-i', path, '-f', 'null', '-'],
      { maxBuffer: 1 << 24 });
    return String(stderr ?? '').trim() === '';
  } catch {
    return false;
  }
}

/** 量出来的总时长和各段之和差多少算拼坏了。取「半秒」和「百分之三」里较大的那个。 */
const tolerance = (expected) => Math.max(0.5, expected * 0.03);

/**
 * 把一串片段拼成一条。
 *
 * 先试 `-c copy`（不重编，快而且不掉画质），量总时长；不对就退回重新编码。两次都不对
 * 就报 `E_CONCAT_MISMATCH`——那说明输入本身有问题，闷着交一条坏片子比报错糟得多。
 */
export async function concatSegments({ parts, outPath }) {
  const list = (parts ?? []).filter((p) => typeof p === 'string' && p !== '');
  if (list.length === 0) {
    throw new ConcatError('E_NOTHING_TO_CONCAT', '没有任何片段可拼。先跑渲染那一步。');
  }
  for (const part of list) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await stat(part).then((s) => s.isFile(), () => false);
    if (!ok) throw new ConcatError('E_SEGMENT_MISSING', `片段不见了：${part}`);
  }

  let expected = 0;
  const shapes = new Set();
  for (const part of list) {
    expected += await probeDuration(part); // eslint-disable-line no-await-in-loop
    shapes.add(await probeShape(part)); // eslint-disable-line no-await-in-loop
  }
  // 参数一致才试拷流。不一致就别试了——那一趟会「成功」，只是片子是坏的。
  const sameShape = shapes.size === 1;

  await mkdir(dirname(outPath), { recursive: true });
  const listPath = `${outPath}.concat.txt`;
  const handle = await open(listPath, 'w');
  try {
    await handle.writeFile(`${list.map(concatLine).join('\n')}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  const tmpPath = `${outPath}.tmp.mp4`;
  const attempts = [
    ...(sameShape ? [{ method: 'copy', args: ['-c', 'copy'] }] : []),
    {
      method: 'reencode',
      args: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(SEGMENT_FORMAT.fps),
        '-c:a', 'aac', '-ar', String(SEGMENT_FORMAT.sampleRate), '-ac', String(SEGMENT_FORMAT.channels)],
    },
  ];

  let lastWhy = '';
  for (const attempt of attempts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await run(FFMPEG(), ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', listPath,
        ...attempt.args, '-movflags', '+faststart', tmpPath]);
    } catch (error) {
      lastWhy = `${attempt.method} 这一趟 ffmpeg 报错：${error.message}`;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const durationSec = await probeDuration(tmpPath);
    if (Math.abs(durationSec - expected) > tolerance(expected)) {
      lastWhy = `${attempt.method} 这一趟拼出来是 ${round(durationSec)} 秒，`
        + `各段加起来应该是 ${round(expected)} 秒`;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    if (await decodesClean(tmpPath)) {
      await rename(tmpPath, outPath);
      await unlink(listPath).catch(() => {});
      return {
        path: outPath, durationSec: round(durationSec), count: list.length,
        method: attempt.method, passes: 1,
      };
    }
    lastWhy = `${attempt.method} 这一趟拼出来能读出 ${round(durationSec)} 秒，但解码有坏帧`;
  }

  await unlink(tmpPath).catch(() => {});
  await unlink(listPath).catch(() => {});
  throw new ConcatError('E_CONCAT_MISMATCH',
    `拼接失败：${sameShape ? '拷流和重编都' : '重编'}没拼对。${lastWhy}。片段可能本身就是坏的。`);
}

/**
 * 从画面对应表和配音，做出成片。
 *
 * 守门是第一件事：停点 4（听纯音频）没点头就不许渲染。渲染是整条流程里最慢的一步，
 * 语速错了还要全部重来，所以这道门比别的更值钱。
 */
export async function renderVideo({ jobDir, outPath, target, onEvent }) {
  const job = await readJob(jobDir);
  assertReady(job, 'render');

  const sentences = job.script?.sentences ?? [];
  const shots = new Map((job.shotplan?.shots ?? []).map((s) => [s.sentenceId, s]));
  const clips = new Map((job.voice?.clips ?? []).map((c) => [c.sentenceId, c]));
  const aspect = job.meta?.aspect ?? 'landscape';
  const size = target ?? TARGET[aspect] ?? TARGET.landscape;

  const segmentDir = join(jobDir, 'segments');
  await mkdir(segmentDir, { recursive: true });

  const segments = [];
  const skippedSentences = [];
  const failures = [];

  for (const sentence of sentences) {
    // 缺画面或缺配音的句子跳过，但一定要报出来——句子悄悄消失是最难查的问题。
    if (!shots.has(sentence.id) || !clips.has(sentence.id)) {
      skippedSentences.push(sentence.id);
      onEvent?.({ kind: 'skipped', sentenceId: sentence.id });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const got = await renderSegment({
        jobDir,
        sentenceId: sentence.id,
        outPath: join(segmentDir, `${sentence.id}.mp4`),
        target: size,
      });
      segments.push({ sentenceId: sentence.id, path: got.path, durationSec: got.durationSec, fill: got.fill });
      onEvent?.({ kind: 'rendered', sentenceId: sentence.id, durationSec: got.durationSec, fill: got.fill });
    } catch (error) {
      // 一句渲染坏了不该把前面几十句的成果扔掉。逐句兜错，最后一起报。
      const code = error?.code ?? 'E_RENDER_INTERNAL';
      failures.push({ sentenceId: sentence.id, code, message: error?.message ?? String(error) });
      onEvent?.({ kind: 'failed', sentenceId: sentence.id, code, message: error?.message ?? String(error) });
    }
  }

  if (segments.length === 0) {
    throw new ConcatError('E_NOTHING_TO_RENDER',
      '一句都没渲染出来。'
      + (failures.length > 0 ? `出错的：${failures.map((f) => `${f.sentenceId}(${f.code})`).join('、')}` : '')
      + (skippedSentences.length > 0 ? `缺画面或缺配音的：${skippedSentences.join('、')}` : ''));
  }

  const slug = job.meta?.slug ?? 'video';
  const finalPath = outPath ?? join(jobDir, 'out', `${slug}.mp4`);
  const joined = await concatSegments({ parts: segments.map((s) => s.path), outPath: finalPath });

  const handle = await openJob(jobDir, 'render');
  handle.set('render', {
    output: joined.path,
    durationSec: joined.durationSec,
    width: size.width,
    height: size.height,
    segments,
    skippedSentences,
    failures,
  });
  await handle.save();

  return {
    output: joined.path,
    durationSec: joined.durationSec,
    width: size.width,
    height: size.height,
    segments,
    skippedSentences,
    failures,
    method: joined.method,
  };
}
