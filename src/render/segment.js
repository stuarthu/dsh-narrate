// 渲染一句话的片段。契约：docs/crew/api/flow-stages.md 版本 2
//
// 这里实现的是 ADR 0005：画面时长服从音频，不是反过来调语速。
// 所以顺序是：先信 job.json 里的 durationSec，再把素材裁成那个长度。
import { execFile } from 'node:child_process';
import { mkdir, writeFile, stat, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';

import { openJob } from '../flow/job.js';
import { assDocument } from './subtitle.js';

const run = promisify(execFile);

const FFMPEG = () => process.env.DSH_FFMPEG_PATH || 'ffmpeg';
const FFPROBE = () => process.env.DSH_FFPROBE_PATH || 'ffprobe';

/** 量出来的时长和 job.json 里写的差多少算不符。契约写死 0.05 秒。 */
const DURATION_TOLERANCE_SEC = 0.05;
const round = (n) => Math.round(n * 1000) / 1000;

/**
 * 目标分辨率。**字幕在缩放之后才烧**，所以 `FontSize` 和 `MarginV` 那些绝对像素
 * 才有一致的含义。烧在素材原始分辨率上的话，640x360 的素材字会占满画面，
 * 之后再缩放又会模糊。
 */
export const TARGET = Object.freeze({
  landscape: Object.freeze({ width: 1920, height: 1080 }),
  portrait: Object.freeze({ width: 1080, height: 1920 }),
});

/** 素材盖不住旁白时怎么补。见 PRD 的 `Q-6`。 */
export const FILL = Object.freeze({ none: 'none', slow: 'slow', loop: 'loop' });

/** 缺口在这个比例以内就放慢（看不出来），超过就循环重放。 */
const SLOW_LIMIT = 0.2;

/**
 * 每一段都按这套参数出，一个字节都不商量。
 *
 * 为什么定死：拼接那一步靠**直接拷流**（`-c copy`），不用重新编码。拷流要求所有段落
 * 的编码参数完全一样——分辨率、帧率、编码档次、音频采样率和声道数。素材来自四面八方
 * （实测过 25fps、10fps、单声道、`vp8` 混在一个文件夹里），不在这里统一，拼出来的片子
 * 会画面卡顿、声音走调，而且**常常不报错，只是坏掉**。
 */
export const SEGMENT_FORMAT = Object.freeze({
  fps: 30, sampleRate: 44100, channels: 2, profile: 'high', level: '4.0',
});

export class RenderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
  }
}

async function probeDuration(path, code, what) {
  let stdout;
  try {
    ({ stdout } = await run(FFPROBE(), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path,
    ]));
  } catch (error) {
    throw new RenderError(code, `${what} 读不出时长：${path}（${error.message}）`);
  }
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new RenderError(code, `${what} 的时长不是一个大于 0 的数：${path}`);
  }
  return seconds;
}

async function mustExist(path, code, what) {
  try {
    return await stat(path);
  } catch {
    throw new RenderError(code, `${what} 不存在：${path}`);
  }
}

/**
 * 渲染一句话的片段：裁素材、混进旁白、烧上这一句字幕。
 *
 * 每一步失败都有名字，见契约的"错误名字"那一节。
 */
export async function renderSegment({ jobDir, sentenceId, outPath: rawOutPath, target }) {
  // 下面跑 ffmpeg 时会把工作目录换成输出目录（为了避开字幕路径的转义问题）。
  // 所以这里必须先把每个路径变成绝对路径，否则换了工作目录之后相对路径就指到别处了。
  const outPath = resolve(rawOutPath);
  const job = await openJob(jobDir, 'render');
  // 横屏和竖屏两套字幕样式，规则在 subtitle.js 里
  const aspect = job.data.meta?.aspect ?? 'landscape';
  const shotplan = job.require('shotplan');
  const voice = job.require('voice');

  const shot = shotplan.shots?.find((s) => s.sentenceId === sentenceId);
  if (!shot) {
    const inMissing = shotplan.missing?.some((m) => m.sentenceId === sentenceId);
    throw new RenderError(
      'E_SENTENCE_UNPLANNED',
      inMissing
        ? `${sentenceId} 在 shotplan.missing 里（缺素材），没有画面可渲染。这一句要先补素材`
        : `${sentenceId} 既不在 shotplan.shots 里，也不在 shotplan.missing 里`,
    );
  }
  const clip = voice.clips?.find((c) => c.sentenceId === sentenceId);
  if (!clip) {
    throw new RenderError('E_AUDIO_MISSING', `${sentenceId} 不在 voice.clips 里`);
  }
  if (!(clip.durationSec > 0)) {
    throw new RenderError('E_AUDIO_ZERO_DURATION', `${sentenceId} 的 durationSec 不大于 0`);
  }

  const audioPath = resolve(clip.audioPath);
  const assetPath = resolve(shot.assetPath);

  await mustExist(audioPath, 'E_AUDIO_MISSING', '旁白音频');
  // 只校验，不修正。对不上就停，不能自己挑一个数继续，否则越往后越歪。
  const realAudio = await probeDuration(audioPath, 'E_AUDIO_MISSING', '旁白音频');
  if (Math.abs(realAudio - clip.durationSec) > DURATION_TOLERANCE_SEC) {
    throw new RenderError(
      'E_DURATION_MISMATCH',
      `${sentenceId} 的音频实际 ${realAudio.toFixed(3)} 秒，但 job.json 写的是 ${clip.durationSec} 秒`,
    );
  }

  await mustExist(assetPath, 'E_ASSET_MISSING', '素材');
  const assetDuration = await probeDuration(assetPath, 'E_ASSET_MISSING', '素材');
  const startSec = shot.startSec ?? 0;
  // 能用的窗口是「这一段描述覆盖的时间」和「素材实际剩下的长度」里较短的那个。
  // 描述只说了 0 到 12 秒有什么，那第 13 秒的画面就不该拿来配这句话。
  const described = Number.isFinite(shot.endSec) ? shot.endSec - startSec : Number.POSITIVE_INFINITY;
  const available = Math.max(0, Math.min(described, assetDuration - startSec));
  if (available <= 0) {
    throw new RenderError(
      'E_ASSET_TOO_SHORT',
      `素材 ${basename(assetPath)} 从第 ${startSec} 秒起没有可用画面了`,
    );
  }

  // Q-6：缺口 20% 以内放慢（看不出来），超过就循环。放慢的只有画面——旁白是基准，
  // 动了旁白语速就假了。
  const needed = clip.durationSec;
  const gap = (needed - available) / needed;
  let fill = FILL.none;
  if (available < needed - DURATION_TOLERANCE_SEC) fill = gap <= SLOW_LIMIT ? FILL.slow : FILL.loop;

  const outDir = dirname(outPath);
  await mkdir(outDir, { recursive: true });

  const size = target ?? TARGET[aspect] ?? TARGET.landscape;

  // 字幕文件放在输出目录里，跑 ffmpeg 时把工作目录设成那里，滤镜只写文件名。
  // 这样彻底避开 ass 滤镜对路径里冒号和逗号的转义问题。
  const assName = `${basename(outPath)}.ass`;
  await writeFile(
    join(outDir, assName),
    assDocument({
      cues: [{ startSec: 0, endSec: needed, text: shot.subtitle }],
      aspect,
      width: size.width,
      height: size.height,
    }),
    'utf8',
  );
  // 顺序要紧：先缩放加黑边到目标尺寸，**再**烧字幕。反过来字号就跟着素材分辨率变。
  // 加黑边而不是拉伸：真实素材尺寸五花八门（640x360、532x300、1920x1080 混着）。
  const videoFilters = [
    ...(fill === FILL.slow ? [`setpts=PTS*${round(needed / available)}`] : []),
    `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease`,
    `pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2`,
    // 字号和边距写在这份 .ass 里，而且 PlayRes 钉成了 size，所以它们就是像素。
    `ass=${assName}`,
  ].join(',');

  // 循环那条要先把窗口抽成一个临时文件——`-stream_loop` 只能作用于整个输入。
  let videoInput = ['-ss', String(startSec), '-t', String(Math.min(available, needed)), '-i', assetPath];
  let windowPath = '';
  if (fill === FILL.loop) {
    windowPath = join(outDir, `${basename(outPath)}.window.mp4`);
    await run(FFMPEG(), ['-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(startSec), '-t', String(available), '-i', assetPath,
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', windowPath]);
    videoInput = ['-stream_loop', '-1', '-t', String(needed), '-i', windowPath];
  }

  try {
    await run(
      FFMPEG(),
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        ...videoInput,
        '-i', audioPath,
        '-vf', videoFilters,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-r', String(SEGMENT_FORMAT.fps),
        '-profile:v', SEGMENT_FORMAT.profile, '-level', SEGMENT_FORMAT.level,
        '-c:a', 'aac', '-ar', String(SEGMENT_FORMAT.sampleRate), '-ac', String(SEGMENT_FORMAT.channels),
        '-t', String(needed), outPath,
      ],
      { cwd: outDir },
    );
  } finally {
    if (windowPath !== '') await unlink(windowPath).catch(() => {});
  }

  const durationSec = await probeDuration(outPath, 'E_RENDER_OUTPUT_UNREADABLE', '成片片段');
  return { path: outPath, durationSec: round(durationSec), fill, width: size.width, height: size.height };
}
