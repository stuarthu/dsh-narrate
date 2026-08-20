// 自带的免费语音引擎。契约：docs/crew/api/voice-engine.md 版本 2
//
// 这个文件有两个身份：
//   1. 被 import 时，它给出默认引擎的命令配置。
//   2. 被当成脚本直接跑时，它就是那个引擎本身。
//
// 为什么要包一层。语音合成用的是 node-edge-tts（MIT，微软 Edge 的在线朗读服务，
// 不需要 API key）。但它自带的命令行只接受 --text 参数，没有"读文本文件"的选项，
// 而我们的契约规定文本必须通过文件传。所以这里只复用它的 EdgeTTS 类，
// 入口换成符合契约的形状。
//
// 它用的不是微软的官方公开接口，可能随时坏（PRD 的 R-4）。坏了就换一条命令，
// 产品代码不用动。
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { argv, execPath, exit, stderr } from 'node:process';

const HERE = fileURLToPath(import.meta.url);

/** 语言代码换成这个服务认识的音色。%LANG% 传 zh 或 en 就够了。 */
const VOICE_BY_LANG = Object.freeze({
  zh: 'zh-CN-XiaoyiNeural',
  en: 'en-US-AriaNeural',
  ja: 'ja-JP-NanamiNeural',
});

const LOCALE_BY_LANG = Object.freeze({
  zh: 'zh-CN',
  en: 'en-US',
  ja: 'ja-JP',
});

/**
 * 默认引擎的配置。直接放进 synthesize 的 config 就能用。
 * 和别的引擎一视同仁，没有走后门的特殊路径。
 */
export function defaultEngineConfig({ timeoutMs = 60000 } = {}) {
  return {
    command: [execPath, HERE, '%TEXT_FILE%', '%OUT_FILE%', '%LANG%', '%VOICE%'],
    timeoutMs,
  };
}

/** 真正去合成。被脚本入口调用。 */
async function speakToFile({ textFile, outFile, lang, voice }) {
  const require = createRequire(import.meta.url);
  const { EdgeTTS } = require('node-edge-tts');
  const text = await readFile(textFile, 'utf8');
  if (text.trim() === '') throw new Error('文本文件是空的，没有东西可念');
  const key = (lang || 'zh').split('-')[0].toLowerCase();
  const tts = new EdgeTTS({
    voice: voice || VOICE_BY_LANG[key] || VOICE_BY_LANG.zh,
    lang: LOCALE_BY_LANG[key] || LOCALE_BY_LANG.zh,
    outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    saveSubtitles: false,
  });
  await tts.ttsPromise(text, outFile);
}

// 脚本入口。契约要求：成功退出 0 并写出文件，失败退出非 0 并把说明写到 stderr。
if (argv[1] === HERE) {
  const [, , textFile, outFile, lang, voice] = argv;
  if (!textFile || !outFile) {
    stderr.write('用法：default.js <文本文件> <输出音频> [语言] [音色]\n');
    exit(2);
  }
  try {
    await speakToFile({ textFile, outFile, lang, voice });
    exit(0);
  } catch (error) {
    stderr.write(`${error?.message || error}\n`);
    exit(1);
  }
}
