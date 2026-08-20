// 渲染一句话的片段。契约：docs/crew/api/flow-stages.md 版本 2
//
// 这里实现的是 ADR 0005：画面时长服从音频，不是反过来调语速。
// 所以顺序是：先信 job.json 里的 durationSec，再把素材裁成那个长度。
import { execFile } from 'node:child_process';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';

import { openJob } from '../flow/job.js';
import { escapeSubtitle, forceStyle, srtTime } from './subtitle.js';

const run = promisify(execFile);

const FFMPEG = () => process.env.DSH_FFMPEG_PATH || 'ffmpeg';
const FFPROBE = () => process.env.DSH_FFPROBE_PATH || 'ffprobe';

/** 量出来的时长和 job.json 里写的差多少算不符。契约写死 0.05 秒。 */
const DURATION_TOLERANCE_SEC = 0.05;

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
export async function renderSegment({ jobDir, sentenceId, outPath: rawOutPath }) {
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
  const available = assetDuration - startSec;
  if (available < clip.durationSec - DURATION_TOLERANCE_SEC) {
    throw new RenderError(
      'E_ASSET_TOO_SHORT',
      `素材 ${basename(assetPath)} 从第 ${startSec} 秒起只剩 ${available.toFixed(3)} 秒，` +
        `盖不住 ${clip.durationSec} 秒的旁白`,
    );
  }

  const outDir = dirname(outPath);
  await mkdir(outDir, { recursive: true });

  // 字幕文件放在输出目录里，跑 ffmpeg 时把工作目录设成那里，滤镜只写文件名。
  // 这样彻底避开 subtitles 滤镜对路径里冒号和逗号的转义问题。
  const srtName = `${basename(outPath)}.srt`;
  await writeFile(
    join(outDir, srtName),
    `1\n${srtTime(0)} --> ${srtTime(clip.durationSec)}\n${escapeSubtitle(shot.subtitle)}\n\n`,
    'utf8',
  );

  await run(
    FFMPEG(),
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(startSec), '-t', String(clip.durationSec), '-i', assetPath,
      '-i', audioPath,
      // force_style 的值里有逗号，而逗号也是滤镜的分隔符，所以要用单引号裹住。
      // 参数是逐项传给进程的，不经过 shell，所以这里的单引号是给 ffmpeg 的滤镜
      // 解析器看的，不是 shell 的引号。
      '-vf', `subtitles=${srtName}:force_style='${forceStyle(aspect)}'`,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-shortest', outPath,
    ],
    { cwd: outDir },
  );

  const durationSec = await probeDuration(outPath, 'E_RENDER_OUTPUT_UNREADABLE', '成片片段');
  return { path: outPath, durationSec: Math.round(durationSec * 1000) / 1000 };
}
