// 停点 1：写文稿之前先反问。契约：docs/crew/api/flow-stages.md
//
// 这四个问题是**确定的，不问模型**。理由有两层。
//
// 表面理由：这四件事每条视频都要知道，模型也只会问出同样的四个。
// 更要紧的理由：停点 1 是整个插件存在的意义——别的工具一口气做完，只把结果给
// 你看。所以这一步必须在任何情况下都能工作，包括模型不可用、没有网络的时候。
// 把它做成确定的，它就永远不会坏。
//
// 想问针对某个想法的额外问题，注入 `extraQuestions`。那一步坏了不影响核心问题。
import { openJob, readJob } from '../flow/job.js';

/** 每条视频都要知道的四件事。 */
export const CORE_QUESTIONS = Object.freeze([
  {
    text: '这条视频你想做多长？',
    suggestion: '八到十分钟。知识类视频这个长度最常见，也够讲清一件事。',
  },
  {
    text: '给谁看？他们已经知道多少？',
    suggestion: '给听说过这个词、但没真正搞懂的人看。不用从零讲起，但别假设他们看过文档。',
  },
  {
    text: '语气要什么样？',
    suggestion: '平实、直接，像跟一个懂行的朋友解释。不端着，也不硬凑段子。',
  },
  {
    text: '看完之后，你最想让人记住哪一句话？',
    suggestion: '一句话就好。整条视频会围着它走，所以这一句值得多想一会儿。',
  },
]);

export const CORE_QUESTION_COUNT = CORE_QUESTIONS.length;

export class InterviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InterviewError';
    this.code = code;
  }
}

const clean = (s) => String(s ?? '').trim();
const questionId = (index) => `IQ-${index + 1}`;

/**
 * 拿出这一轮要问的问题，并写进工作文件的 `interview` 节。
 *
 * 可以重复调用：已经回答过的问题，答案按**题目原文**认领回来，不会被冲掉。
 * 按 id 认领会出错——额外问题换了内容，id 还是同一个。
 */
export async function buildQuestions({ jobDir, extraQuestions }) {
  const job = await openJob(jobDir, 'script');
  const idea = job.data.idea ?? '';
  const { aspect, language } = job.data.meta ?? {};

  const drafts = CORE_QUESTIONS.map((q) => ({ ...q }));
  if (extraQuestions) {
    try {
      const extra = await extraQuestions({ idea, aspect, language });
      for (const q of Array.isArray(extra) ? extra : []) {
        const text = clean(q?.text);
        if (text !== '') drafts.push({ text, suggestion: clean(q?.suggestion) || '（没有推荐答案）' });
      }
    } catch {
      // 额外问题是加分项。它坏了不该拖着核心问题一起坏。
    }
  }

  const existing = job.data.interview?.questions ?? [];
  const answered = new Map(existing.map((q) => [clean(q.text), q.answer ?? null]));

  // 已经回答过、但这一轮没再问出来的问题要留着。额外问题是模型给的，第二轮不传
  // extraQuestions 就问不出来了——直接覆盖会把用户的回答一起弄丢。
  // 没回答的旧问题不留，免得越攒越多。
  const draftTexts = new Set(drafts.map((q) => clean(q.text)));
  const keep = existing.filter(
    (q) => clean(q.answer) !== '' && !draftTexts.has(clean(q.text)),
  );

  const questions = [...drafts, ...keep.map((q) => ({ text: q.text, suggestion: q.suggestion ?? '' }))]
    .map((q, i) => ({
      id: questionId(i),
      text: q.text,
      suggestion: q.suggestion,
      answer: answered.get(clean(q.text)) ?? null,
    }));

  job.set('interview', { questions });
  await job.save();
  return questions;
}

/** 记下一个回答。空白不算回答——那只会让下一步以为问完了。 */
export async function recordAnswer({ jobDir, id, answer }) {
  const text = clean(answer);
  if (text === '') {
    throw new InterviewError('E_EMPTY_ANSWER', `${id} 的回答是空白，空白不算回答`);
  }
  const job = await openJob(jobDir, 'script');
  const questions = (job.data.interview?.questions ?? []).map((q) => ({ ...q }));
  const found = questions.find((q) => q.id === id);
  if (!found) {
    throw new InterviewError(
      'E_NO_SUCH_QUESTION',
      `没有编号 ${id} 的问题。现在有的是：${questions.map((q) => q.id).join('、') || '（还没提问）'}`,
    );
  }
  found.answer = text;
  job.set('interview', { ...job.data.interview, questions });
  await job.save();
  return found;
}

/** 问完了没有。一个问题都还没提，也算没问完。 */
export async function interviewComplete(jobDir) {
  const questions = (await readJob(jobDir)).interview?.questions ?? [];
  if (questions.length === 0) return false;
  return questions.every((q) => clean(q.answer) !== '');
}
