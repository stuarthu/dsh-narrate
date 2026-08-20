// 次序和守门。契约：docs/crew/api/flow-stages.md
//
// **编排者是 agent，不是宿主**（见 `hld.md` 第 4.1 节）。插件没法强迫 agent 按顺序
// 走，所以这个模块做两件事：
//
//   1. `nextStep(job)` —— 读工作文件，说出下一步该做什么、该调哪个工具、在等什么。
//      这也是续跑：中途断了，读一次文件就知道接哪里。
//   2. `assertReady(job, step)` —— 抢跑当场报错。写在工具说明里的规矩 agent 可以
//      无视，`execute` 里抛的错它绕不过去。
//
// 守的不只是"数据齐没齐"，更是"**用户点头了没有**"。别的工具都是数据齐了就往下做，
// 那正是它们和这个插件的区别：这里四个停点每一个都必须等一个明确的"继续"。
import { openJob } from './job.js';

/** 走的顺序。写死，因为它就是产品本身。 */
export const STEPS = Object.freeze(['interview', 'script', 'index', 'shotplan', 'voice', 'render', 'done']);

/** 每一步对应第几个停点。 */
export const STOP_POINTS = Object.freeze({ interview: 1, script: 2, shotplan: 3, voice: 4 });

/**
 * 哪几个停点需要一个**明确的"继续"**。
 *
 * 停点 1 不在里面：它的"点头"就是用户回答问题本身，没有额外的确认动作。
 * 停点 2、3、4 各要一次明确的点头——文稿、画面对应表、纯音频，每一样都要用户看过。
 */
const NEEDS_APPROVAL = Object.freeze(['script', 'shotplan', 'voice']);

/** 每一步该调哪个工具。说不出工具名的次序说明等于没说。 */
const TOOL_FOR = Object.freeze({
  interview: 'narrate_answer',
  script: 'narrate_script',
  index: 'narrate_index',
  shotplan: 'narrate_shotplan',
  voice: 'narrate_voice',
  render: 'narrate_render',
  done: 'narrate_status',
});

export class FlowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FlowError';
    this.code = code;
  }
}

const clean = (s) => String(s ?? '').trim();
const asRecord = (v) => (v && typeof v === 'object' ? v : {});

const questionsOf = (job) => asRecord(asRecord(job).interview).questions ?? [];
const sentencesOf = (job) => asRecord(asRecord(job).script).sentences ?? [];
const shotsOf = (job) => asRecord(asRecord(job).shotplan).shots ?? [];
const clipsOf = (job) => asRecord(asRecord(job).voice).clips ?? [];
const approvedOf = (job) => asRecord(asRecord(job).meta).approvedStops ?? [];

/** 这一步的内容做完了吗。只看数据，不看点头。 */
function done(job, step) {
  switch (step) {
    case 'interview': {
      const questions = questionsOf(job);
      return questions.length > 0 && questions.every((q) => clean(q.answer) !== '');
    }
    case 'script': return sentencesOf(job).length > 0;
    // 素材入库没有"做完"这回事——素材随时能加。有画面对应表就说明已经够用了。
    case 'index': return shotsOf(job).length > 0 || asRecord(job).shotplan !== undefined;
    case 'shotplan': return asRecord(job).shotplan !== undefined;
    case 'voice': return clipsOf(job).length > 0;
    case 'render': return clean(asRecord(asRecord(job).render).output) !== '';
    default: return false;
  }
}

/**
 * 下一步做什么。
 *
 * 顺序是：内容没做完 → 做它；做完了但有停点没点头 → **停住等用户**；都齐了 → 下一步。
 */
export function nextStep(job) {
  for (const step of STEPS) {
    if (step === 'done') break;

    if (!done(job, step)) {
      let why = `还没做：${step}`;
      if (step === 'interview') {
        const questions = questionsOf(job);
        const missing = questions.filter((q) => clean(q.answer) === '').map((q) => q.id);
        why = questions.length === 0
          ? '先反问用户那几个问题，问完才写文稿。'
          : `还差这几个回答：${missing.join('、')}。`;
      } else if (step === 'script') {
        why = '问完了。自己写出按句分好的文稿，再交上来。';
      } else if (step === 'index') {
        why = '素材还没入库。扫一遍素材文件夹，需要理解的交给你去理解。';
      } else if (step === 'shotplan') {
        why = '为每句挑一段素材，做出画面对应表，挑不到的要列出来。';
      } else if (step === 'voice') {
        why = '为每句配音，一句一个音频文件。';
      } else if (step === 'render') {
        why = '裁画面、混旁白、烧字幕、拼成片。';
      }
      return { step, stopPoint: 0, waitingForUser: false, why, tool: TOOL_FOR[step] };
    }

    const stop = STOP_POINTS[step];
    if (NEEDS_APPROVAL.includes(step) && !approvedOf(job).includes(stop)) {
      return {
        step,
        stopPoint: stop,
        waitingForUser: true,
        why: `停点 ${stop}：${stopReason(step, job)}把它给用户看，等一个明确的"继续"。`
          + '没有点头就不许往下走——这是这个插件存在的意义。',
        tool: 'narrate_approve',
      };
    }
  }
  return { step: 'done', stopPoint: 0, waitingForUser: false, why: '做完了。', tool: TOOL_FOR.done };
}

function stopReason(step, job) {
  if (step === 'interview') return `${questionsOf(job).length} 个问题都答完了，`;
  if (step === 'script') return `文稿写好了，${sentencesOf(job).length} 句。`;
  if (step === 'shotplan') {
    const missing = asRecord(asRecord(job).shotplan).missing ?? [];
    return `画面对应表做好了，${shotsOf(job).length} 句配上画面`
      + (missing.length > 0 ? `，${missing.length} 句缺素材。` : '。');
  }
  if (step === 'voice') return `配音做好了，${clipsOf(job).length} 句。先只听声音，别看画面。`;
  return '';
}

/**
 * 抢跑就报错，并说清缺的是什么。
 *
 * 已经做过的那一步允许重做——改文稿、重挑素材、重配某几句，都是正常操作。
 */
export function assertReady(job, step) {
  const index = STEPS.indexOf(step);
  if (index < 0) throw new FlowError('E_NO_SUCH_STEP', `没有这一步：${step}`);

  for (const earlier of STEPS.slice(0, index)) {
    if (!done(job, earlier)) {
      throw new FlowError(
        'E_OUT_OF_ORDER',
        `${step} 不能现在做：前面的 ${earlier} 还没完成。`,
      );
    }
    const stop = STOP_POINTS[earlier];
    if (NEEDS_APPROVAL.includes(earlier) && !approvedOf(job).includes(stop)) {
      throw new FlowError(
        'E_OUT_OF_ORDER',
        `${step} 不能现在做：停点 ${stop}（${earlier}）还没得到用户的"继续"。`,
      );
    }
  }
}

/**
 * 记下用户在某个停点点了头。
 *
 * 只有**已经走到**的停点才能点——提前点头等于把停点绕掉了。
 */
export async function approveStop(jobDir, stop) {
  const number = Number(stop);
  if (!Object.values(STOP_POINTS).includes(number)) {
    throw new FlowError('E_NO_SUCH_STOP', `没有停点 ${stop}，只有 ${Object.values(STOP_POINTS).join('、')}`);
  }
  const job = await openJob(jobDir, 'flow');
  const step = Object.keys(STOP_POINTS).find((k) => STOP_POINTS[k] === number);
  if (!done(job.data, step)) {
    throw new FlowError(
      'E_STOP_NOT_REACHED',
      `还没走到停点 ${number}：${step} 那一步的内容还没做完，现在点头等于把这个停点绕掉了。`,
    );
  }
  const meta = asRecord(job.data.meta);
  const approved = [...new Set([...(meta.approvedStops ?? []), number])].sort((a, b) => a - b);
  job.set('meta', { ...meta, approvedStops: approved });
  await job.save();
  return approved;
}
