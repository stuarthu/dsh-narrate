// 停点 2：把想法和回答展开成按句编号的文稿。契约：docs/crew/api/flow-stages.md
//
// 写稿要靠模型，所以 `compose` 是**注入**进来的。这个模块负责的是模型之外的那些
// 事：拒绝在问题没答完时开工、把句子规整成契约要的形状、把太长的句子标出来。
//
// 一条规则值得单独说：**太长的句子只标出来，绝不自己切开。** 切句子就是改写用户
// 的稿子，而断句在哪里是内容判断，不是长度判断。标出来，让停点 2 由人决定。
import { interviewComplete } from './interview.js';
import { openJob } from '../flow/job.js';

/**
 * 一句话最多多少个字。超了只是提醒，不是错误。
 *
 * 竖屏严得多：一行放不下多少字（中文约 12 到 15 个），两行就到顶了。横屏一行能
 * 放的字数是竖屏的两倍以上。
 */
export const LENGTH_LIMIT = Object.freeze({ landscape: 50, portrait: 30 });

const ASPECT_NAME = Object.freeze({ landscape: '横屏', portrait: '竖屏' });

export class ScriptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScriptError';
    this.code = code;
  }
}

const clean = (s) => String(s ?? '').trim();

/** 句子编号补到三位：一条十分钟的视频会超过一百句。 */
const sentenceId = (index) => `S-${String(index + 1).padStart(3, '0')}`;

/**
 * 写文稿。
 *
 * `compose` 是异步函数，收到 `{ idea, answers, aspect, language, maxSentenceLength }`，
 * 返回一个句子字符串数组。
 */
export async function writeScript({ jobDir, compose }) {
  if (!(await interviewComplete(jobDir))) {
    throw new ScriptError(
      'E_INTERVIEW_INCOMPLETE',
      '还有问题没回答，所以不写文稿。停点 1 存在的意义就是不让它被跳过。',
    );
  }

  const job = await openJob(jobDir, 'script');
  const idea = job.data.idea ?? '';
  const aspect = job.data.meta?.aspect ?? 'landscape';
  const language = job.data.meta?.language ?? 'zh';
  const maxSentenceLength = LENGTH_LIMIT[aspect] ?? LENGTH_LIMIT.landscape;
  const answers = (job.data.interview?.questions ?? []).map((q) => ({
    question: q.text,
    answer: clean(q.answer),
  }));

  let drafted;
  try {
    drafted = await compose({ idea, answers, aspect, language, maxSentenceLength });
  } catch (error) {
    // 模型失败要和程序 bug 分得开。没有码的错误冒出去，两者就再也分不清了。
    throw new ScriptError('E_COMPOSE_FAILED', `写稿那一步失败了：${error?.message ?? error}`);
  }

  // 只接受字符串。对象经过 String() 会变成 "[object Object]"，非空，于是会被
  // 当成一句台词写进文稿——安静地把垃圾变成内容，比报错糟得多。
  const texts = (Array.isArray(drafted) ? drafted : [])
    .filter((t) => typeof t === 'string')
    .map(clean)
    .filter((t) => t !== '');
  if (texts.length === 0) {
    throw new ScriptError(
      'E_SCRIPT_UNUSABLE',
      '写稿那一步没给出一句能用的话，所以不写半个文稿。',
    );
  }

  const sentences = texts.map((text, i) => ({ id: sentenceId(i), text }));

  // 只标，不切。断句在哪里是内容判断，不是长度判断。
  const warnings = sentences
    .filter((s) => [...s.text].length > maxSentenceLength)
    .map((s) => ({
      sentenceId: s.id,
      message:
        `这句 ${[...s.text].length} 个字，${ASPECT_NAME[aspect] ?? aspect}` +
        `一句最好不超过 ${maxSentenceLength} 个字，字幕会放不下。要不要拆成两句由你决定。`,
    }));

  job.set('script', { sentences });
  await job.save();
  return { sentences, warnings };
}
