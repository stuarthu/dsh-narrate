// 调用外部语音引擎。契约：docs/crew/api/voice-engine.md 版本 2
//
// 两条安全规则写在契约里，这里是它们的实现：
//   1. 参数逐项传给进程，绝不拼 shell 字符串。文稿是模型生成的内容，拼进 shell
//      就等于让它能执行命令。
//   2. 要念的文本通过文件传，不通过命令行参数传。句子可能很长，而且文件传递
//      彻底绕开引号和转义。
import { spawn, execFile } from 'node:child_process';
import { mkdir, writeFile, rename, stat, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname } from 'node:path';

const run = promisify(execFile);

const FFMPEG = () => process.env.DSH_FFMPEG_PATH || 'ffmpeg';
const FFPROBE = () => process.env.DSH_FFPROBE_PATH || 'ffprobe';

const DEFAULT_TIMEOUT_MS = 60000;

/** 前后静音完全裁掉。阈值和检测方式由契约版本 2 写死。 */
const TRIM_FILTER = [
  'silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB:detection=peak',
  'areverse',
  'silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB:detection=peak',
  'areverse',
].join(',');

export class VoiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VoiceError';
    this.code = code;
  }
}

function resolveCommand(config, values) {
  const template = config?.command;
  if (!Array.isArray(template) || template.length === 0) {
    throw new VoiceError('E_ENGINE_NOT_CONFIGURED', '配置里没有 command，或者它不是一个非空数组');
  }
  const joined = template.join(' ');
  for (const required of ['%TEXT_FILE%', '%OUT_FILE%']) {
    if (!joined.includes(required)) {
      throw new VoiceError('E_ENGINE_NOT_CONFIGURED', `command 模板里缺 ${required}`);
    }
  }
  return template.map((part) =>
    part
      .replaceAll('%TEXT_FILE%', values.textFile)
      .replaceAll('%OUT_FILE%', values.outFile)
      .replaceAll('%LANG%', values.lang ?? '')
      .replaceAll('%VOICE%', values.voice ?? ''),
  );
}

/** 跑引擎进程。逐项传参，不经过 shell；超时连子进程一起杀掉。 */
function runEngine(argv, timeoutMs) {
  return new Promise((resolve) => {
    // detached 让子进程自己成一个进程组，这样超时能连它的子进程一起杀
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += String(chunk);
    });
    child.stdout.resume();
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      // 进程根本没启动起来（可执行文件不存在、没有执行权限）是配置问题，
      // 不是引擎跑失败。名字要说对，否则用户会去查引擎而不是查自己的配置。
      resolve({ code: -1, stderr, timedOut, spawnError: error });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, timedOut });
    });
  });
}

async function probeDuration(path) {
  let stdout;
  try {
    ({ stdout } = await run(FFPROBE(), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path,
    ]));
  } catch (error) {
    throw new VoiceError('E_ENGINE_BAD_AUDIO', `ffprobe 读不出 ${path} 的时长：${error.message}`);
  }
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new VoiceError('E_ENGINE_BAD_AUDIO', `${path} 的时长不是一个大于 0 的数：${stdout.trim()}`);
  }
  return Math.round(seconds * 1000) / 1000;
}

/**
 * 念一句话，出一个音频文件。
 *
 * 顺序是固定的，不能反：跑引擎 → 查文件 → 裁静音 → 量时长。
 * 先裁再量，否则时长会把静音算进去，画面就会比声音长。
 */
export async function synthesize({ text, outPath, lang, voice, config }) {
  const textFile = `${outPath}.txt`;
  const argv = resolveCommand(config, { textFile, outFile: outPath, lang, voice });

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(textFile, text, 'utf8');

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = await runEngine(argv, timeoutMs);

  if (result.timedOut) {
    throw new VoiceError('E_ENGINE_TIMEOUT', `引擎超过 ${timeoutMs} 毫秒还没结束，已被杀掉`);
  }
  if (result.spawnError) {
    throw new VoiceError(
      'E_ENGINE_NOT_CONFIGURED',
      `启动不了引擎命令 ${argv[0]}：${result.spawnError.message}`,
    );
  }
  if (result.code !== 0) {
    const tail = result.stderr.trim().split('\n').slice(0, 5).join(' / ');
    throw new VoiceError('E_ENGINE_FAILED', `引擎退出码 ${result.code}。stderr：${tail}`);
  }

  // 不相信退出码，只相信文件。成功了却忘了写文件是最常见的引擎错误。
  let size = 0;
  try {
    ({ size } = await stat(outPath));
  } catch {
    throw new VoiceError('E_ENGINE_NO_OUTPUT', `引擎退出码 0，但 ${outPath} 不存在`);
  }
  if (size === 0) {
    throw new VoiceError('E_ENGINE_NO_OUTPUT', `引擎退出码 0，但 ${outPath} 是 0 字节`);
  }

  // 裁完静音写出来的是 PCM WAV 数据，所以最终文件名必须是 .wav。
  // 引擎给的可能是 .mp3，那份原始文件留着当中间产物（PRD 的 F-12），
  // 但 audioPath 指向的一定是 .wav，扩展名和内容必须对得上。
  const finalPath = outPath.replace(/\.[^./\\]*$/, '') + '.wav';
  const trimmed = `${finalPath}.tmp.wav`;
  try {
    await run(FFMPEG(), ['-hide_banner', '-loglevel', 'error', '-y',
      '-i', outPath, '-af', TRIM_FILTER, '-c:a', 'pcm_s16le', trimmed]);
  } catch (error) {
    await unlink(trimmed).catch(() => {});
    throw new VoiceError('E_ENGINE_BAD_AUDIO', `裁静音失败：${error.message}`);
  }
  const durationSec = await probeDuration(trimmed);
  await rename(trimmed, finalPath);

  // 成功了就把交给引擎的文字文件删掉：它只是临时输入，留着等于把旁白文字在磁盘上
  // 又存了一份，而且会让"每句一个音频文件"变成每句两个文件。
  // **失败时故意不删**——那时候它是查错要看的东西。
  await unlink(textFile).catch(() => {});

  return { audioPath: finalPath, durationSec };
}
