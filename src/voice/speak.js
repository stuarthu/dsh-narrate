// 逐句配音，以及停点 4 要的那条纯音频。契约：docs/crew/api/flow-stages.md
//
// 两条规则决定了这个模块的形状：
//
//   1. **配过而且文字没变的句子绝不重配。** 配音要花钱、花时间、可能联网。所以每条
//      记录里存下当时的文字，一比就知道改没改。改文稿再配音，只重配改过的那几句。
//   2. **一句坏了不拖垮整批。** 一百句配到第 30 句出错就全盘失败，用户会不知道前
//      29 句到底存下来没有。所以逐句兜错，最后一起报，下次自动重试。
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';

import { openJob, readJob } from '../flow/job.js';
import { assertReady } from '../flow/run.js';
import { synthesize } from './engine.js';

const run = promisify(execFile);
const FFMPEG = () => process.env.DSH_FFMPEG_PATH || 'ffmpeg';
const FFPROBE = () => process.env.DSH_FFPROBE_PATH || 'ffprobe';

export class SpeakError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SpeakError';
    this.code = code;
  }
}

const clean = (s) => String(s ?? '').trim();
const round = (n) => Math.round(n * 1000) / 1000;

/**
 * 为文稿里的每一句配音。
 *
 * `config` 是语音引擎的配置（见 `voice-engine.md`）。`onEvent` 可选，每句一次。
 */
export async function speakScript({ jobDir, config, voice, onEvent }) {
  const before = await readJob(jobDir);
  assertReady(before, 'voice');

  const sentences = before.script?.sentences ?? [];
  const existing = new Map((before.voice?.clips ?? []).map((c) => [c.sentenceId, c]));
  const language = before.meta?.language ?? 'zh';
  const audioDir = join(jobDir, 'audio');
  await mkdir(audioDir, { recursive: true });

  const clips = [];
  const spoken = [];
  const reused = [];
  const skipped = [];

  for (const sentence of sentences) {
    const had = existing.get(sentence.id);
    // 文字没变就复用。存下来的 text 就是为了能做这个比较。
    if (had && clean(had.text) === clean(sentence.text) && had.durationSec > 0) {
      clips.push(had);
      reused.push(sentence.id);
      onEvent?.({ kind: 'reused', sentenceId: sentence.id });
      continue;
    }
    try {
      const result = await synthesize({
        text: sentence.text,
        outPath: join(audioDir, `${sentence.id}.wav`),
        lang: language,
        voice,
        config,
      });
      clips.push({
        sentenceId: sentence.id,
        text: sentence.text,
        audioPath: result.audioPath,
        durationSec: result.durationSec,
      });
      spoken.push(sentence.id);
      onEvent?.({ kind: 'spoken', sentenceId: sentence.id, durationSec: result.durationSec });
    } catch (error) {
      // 没有错误码说明是意外错误（程序 bug）。不能贴成引擎失败，那会把 bug 藏起来。
      const code = error?.code ?? 'E_SPEAK_INTERNAL';
      const message = error?.message ?? String(error);
      skipped.push({ sentenceId: sentence.id, code, message });
      onEvent?.({ kind: 'skipped', sentenceId: sentence.id, code, message });
    }
  }

  // 文稿里删掉的句子，配音记录也跟着走——留着会让下一步对不上。
  const job = await openJob(jobDir, 'voice');
  job.set('voice', { engine: config?.command?.[0] ?? 'unknown', clips });
  await job.save();

  return { clips, spoken, reused, skipped };
}

/** concat 清单里的一行。单引号要按 ffmpeg 的规矩转义，否则带引号的路径会拼错。 */
const concatLine = (path) => `file '${path.replace(/'/g, "'\\''")}'`;

/**
 * 把逐句音频拼成一条只有声音的文件，给停点 4 用。
 *
 * 停点 4 的意义是**先听语速和断句，别看画面**。画面会分散注意力，而语速错了
 * 整条片子都要重做。
 */
export async function buildAudioOnly({ jobDir, outPath }) {
  const job = await readJob(jobDir);
  const clips = job.voice?.clips ?? [];
  if (clips.length === 0) {
    throw new SpeakError('E_NOTHING_TO_PLAY', '还没有任何一句配音，拼不出纯音频。先跑配音那一步。');
  }

  await mkdir(dirname(outPath), { recursive: true });
  const listPath = `${outPath}.concat.txt`;
  const handle = await open(listPath, 'w');
  try {
    await handle.writeFile(`${clips.map((c) => concatLine(c.audioPath)).join('\n')}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  const tmpPath = `${outPath}.tmp.wav`;
  try {
    await run(FFMPEG(), ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c:a', 'pcm_s16le', tmpPath]);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw new SpeakError('E_CONCAT_FAILED', `拼纯音频失败：${error.message}`);
  }

  const { stdout } = await run(FFPROBE(), ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', tmpPath]);
  const durationSec = Number(stdout.trim());
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    await unlink(tmpPath).catch(() => {});
    throw new SpeakError('E_CONCAT_FAILED', '拼出来的纯音频读不出时长');
  }
  await rename(tmpPath, outPath);

  return { path: outPath, durationSec: round(durationSec), count: clips.length };
}
