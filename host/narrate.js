// dsh 挂载：把插件的能力做成 agent 能调的工具。
// 契约：docs/crew/api/flow-stages.md、docs/crew/api/assetsindex-shotplan.md
// 设计依据：docs/crew/hld.md 第 4.1 节、docs/crew/crd/0001-mount-now.md
//
// **宿主不能调模型。** 工具的 execute 在宿主进程里跑，把值返回给 agent。所以职责是：
//
//   插件（这里）   记规则、校验、编号、存盘、说"下一步该调什么"
//   agent          写文稿、补问、调 video_understand、跟用户说话
//
// 这条约束有一个后果必须时刻记着：**插件没法强迫 agent 按顺序走。** 所以每一条
// "不能跳过"都必须是工具自己的硬检查。写在 description 里的规矩，agent 可以无视；
// execute 里抛的错，它绕不过去。停点 1 的 E_INTERVIEW_INCOMPLETE 就是这个道理。
//
// dsh 对工具定义的要求（读自 @deepseek-ai/dsh-tools）：
//   - output 必需，且 output.render 必须是函数
//   - output.schema 只能用一个很窄的关键字子集：type / oneOf / properties /
//     required / additionalProperties / items / enum / const，加 description /
//     title / default / examples。**minLength、pattern、format 一律被拒**
//   - execute 的返回值会先按 schema 校验再交给 render
// 写错 schema 的后果是启动时抛异常，等于弄坏用户整个 dsh profile。
import { mkdir } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { createJob, readJob } from '../src/flow/job.js';
import { buildQuestions, recordAnswer, interviewComplete } from '../src/script/interview.js';
import { writeScript } from '../src/script/write.js';
import { measureClip, normalizeMachine, scanAssets } from '../src/assets-index/scan.js';
import { fingerprintOf, writeMachineSection } from '../src/assets-index/clip-file.js';

/** cordis 服务注入：apply 里要用 ctx.tools，必须显式声明。 */
export const inject = ['tools'];

export const TOOL_NAMES = Object.freeze([
  'narrate_start',
  'narrate_answer',
  'narrate_script',
  'narrate_index',
  'narrate_describe',
  'narrate_status',
]);

const DEFAULT_WORKDIR = '.narrate';

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });
const arr = (items, description) => ({ type: 'array', items, description });
const obj = (properties, required, description) => ({
  type: 'object',
  properties,
  ...(required?.length ? { required } : {}),
  ...(description ? { description } : {}),
});

const QUESTION = obj({ id: str('问题编号，形如 IQ-1'), text: str('问题本身'), suggestion: str('推荐答案') },
  ['id', 'text', 'suggestion']);
const SENTENCE = obj({ id: str('句子编号，形如 S-001'), text: str('这一句的文字') }, ['id', 'text']);
const SEGMENT = obj({
  startSec: num('这一段从第几秒开始'),
  endSec: num('到第几秒结束'),
  description: str('这一段画面里有什么'),
  tags: arr(str('关键词'), '这一段的关键词'),
  confidence: str('high 或 low'),
}, ['startSec', 'endSec', 'description']);

/** 把内部错误码原样带给 agent。它看得见码才知道该怎么办。 */
function surface(error) {
  const code = error?.code;
  return new Error(code ? `${code}: ${error.message}` : String(error?.message ?? error));
}

const asRecord = (value) => (typeof value === 'object' && value !== null ? value : {});

function requireString(args, key) {
  const value = asRecord(args)[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`E_BAD_ARGUMENT: ${key} 是必填的字符串`);
  }
  return value.trim();
}

/** 想法变成一个能当文件夹名的短名字。中文没法切词，所以只去掉不能做文件名的字符。 */
function slugify(idea) {
  const cleaned = [...idea]
    .filter((ch) => !/[\\/:*?"<>|\s.]/.test(ch))
    .join('')
    .slice(0, 24);
  return cleaned === '' ? 'job' : cleaned;
}

/** 找一个还没被占的任务目录。绝不复用已有的——那会悄悄接上一个旧任务。 */
async function freeJobDir(workdir, slug) {
  for (let n = 1; n < 100; n += 1) {
    const dir = join(workdir, n === 1 ? slug : `${slug}-${n}`);
    try {
      await readJob(dir);
    } catch {
      return dir;
    }
  }
  throw new Error(`E_TOO_MANY_JOBS: ${workdir} 里已经有 99 个叫 ${slug} 的任务了`);
}

function buildTools(config) {
  const workdirSetting = typeof config?.workdir === 'string' ? config.workdir : DEFAULT_WORKDIR;
  const workdir = isAbsolute(workdirSetting) ? workdirSetting : resolve(process.cwd(), workdirSetting);

  return [
    {
      name: 'narrate_start',
      description:
        '开一条新视频：把用户的一句想法记下来，回一组要先问他的问题。' +
        '问完之前不要写文稿——写文稿的工具会自己拒绝。把问题连同推荐答案原样念给用户听。',
      parameters: obj({
        idea: str('用户那一句想法（必填）'),
        aspect: { type: 'string', enum: ['landscape', 'portrait'], description: '横屏或竖屏，默认横屏' },
        language: str('文稿语言，默认 zh'),
        slug: str('任务短名，默认从想法里取'),
      }, ['idea']),
      output: {
        schema: obj({
          jobDir: str('这条视频的工作目录'),
          questions: arr(QUESTION, '要先问用户的问题'),
          nextStep: str('下一步该调哪个工具'),
        }, ['jobDir', 'questions', 'nextStep']),
        render: (_args, value) => [
          `开了新任务：${asRecord(value).jobDir ?? ''}`,
          `先问用户这 ${asRecord(value).questions?.length ?? 0} 个问题，再写文稿。`,
        ],
      },
      async execute(args) {
        const idea = requireString(args, 'idea');
        const record = asRecord(args);
        const aspect = record.aspect === 'portrait' ? 'portrait' : 'landscape';
        const language = typeof record.language === 'string' && record.language.trim() !== ''
          ? record.language.trim() : 'zh';
        const slug = typeof record.slug === 'string' && record.slug.trim() !== ''
          ? slugify(record.slug) : slugify(idea);
        try {
          await mkdir(workdir, { recursive: true });
          const jobDir = await freeJobDir(workdir, slug);
          await mkdir(jobDir, { recursive: true });
          await createJob(jobDir, { slug: basename(jobDir), aspect, language, idea });
          const questions = await buildQuestions({ jobDir });
          return {
            jobDir,
            questions: questions.map((q) => ({ id: q.id, text: q.text, suggestion: q.suggestion })),
            nextStep: '把这些问题念给用户，拿到回答后每个都调一次 narrate_answer。',
          };
        } catch (error) {
          throw surface(error);
        }
      },
    },

    {
      name: 'narrate_answer',
      description:
        '记下用户对某一个反问的回答。回答必须是用户自己说的——不要替他编。' +
        '返回值会告诉你还差哪几个问题没答。',
      parameters: obj({
        jobDir: str('narrate_start 给的工作目录（必填）'),
        questionId: str('问题编号，形如 IQ-1（必填）'),
        answer: str('用户的回答，原话（必填）'),
      }, ['jobDir', 'questionId', 'answer']),
      output: {
        schema: obj({
          complete: bool('全部问题都答完了吗'),
          remaining: arr(str('还没回答的问题编号'), '还差哪几个'),
          nextStep: str('下一步该调哪个工具'),
        }, ['complete', 'remaining', 'nextStep']),
        render: (_args, value) => (asRecord(value).complete
          ? ['问完了，可以写文稿了。']
          : [`还差 ${asRecord(value).remaining?.length ?? 0} 个问题：${(asRecord(value).remaining ?? []).join('、')}`]),
      },
      async execute(args) {
        const jobDir = requireString(args, 'jobDir');
        const questionId = requireString(args, 'questionId');
        const answer = requireString(args, 'answer');
        try {
          await recordAnswer({ jobDir, id: questionId, answer });
          const questions = (await readJob(jobDir)).interview?.questions ?? [];
          const remaining = questions.filter((q) => String(q.answer ?? '').trim() === '').map((q) => q.id);
          const complete = remaining.length === 0;
          return {
            complete,
            remaining,
            nextStep: complete
              ? '问完了。自己写出按句分好的文稿，再调 narrate_script 交上来。'
              : `继续问剩下的：${remaining.join('、')}，每拿到一个回答就调一次 narrate_answer。`,
          };
        } catch (error) {
          throw surface(error);
        }
      },
    },

    {
      name: 'narrate_script',
      description:
        '把你写好的文稿交上来。你负责写，插件负责编号、存盘、并挑出太长的句子。' +
        '一句一条，按念的顺序。**问题没答完这个工具会拒绝**，这是硬规则。' +
        '交上来之后停下，把文稿念给用户，等他点头。',
      parameters: obj({
        jobDir: str('工作目录（必填）'),
        sentences: arr(str('一句话'), '按顺序排好的句子（必填）'),
      }, ['jobDir', 'sentences']),
      output: {
        schema: obj({
          sentences: arr(SENTENCE, '编好号的文稿'),
          warnings: arr(obj({ sentenceId: str('句子编号'), message: str('提醒') }, ['sentenceId', 'message']),
            '太长的句子'),
          nextStep: str('下一步'),
        }, ['sentences', 'warnings', 'nextStep']),
        render: (_args, value) => {
          const v = asRecord(value);
          const lines = (v.sentences ?? []).map((s) => `${s.id}  ${s.text}`);
          if ((v.warnings ?? []).length > 0) {
            lines.push('', '太长的句子：', ...(v.warnings ?? []).map((w) => `${w.sentenceId} ${w.message}`));
          }
          return lines;
        },
      },
      async execute(args) {
        const jobDir = requireString(args, 'jobDir');
        const sentences = asRecord(args).sentences;
        if (!Array.isArray(sentences)) throw new Error('E_BAD_ARGUMENT: sentences 必须是字符串数组');
        try {
          const result = await writeScript({ jobDir, compose: async () => sentences });
          return {
            sentences: result.sentences,
            warnings: result.warnings,
            nextStep: '停点 2：把文稿念给用户，等他点头再往下走。别自己继续。',
          };
        } catch (error) {
          throw surface(error);
        }
      },
    },

    {
      name: 'narrate_index',
      description:
        '扫一遍素材文件夹。便宜的事当场做完（读用户写的描述和标签、量时长），' +
        '贵的事交给你：返回值里的 needsUnderstanding 是需要你去理解的素材。' +
        '对每一个调 video_understand，再把结果用 narrate_describe 交回来。',
      parameters: obj({ assetsRoot: str('素材文件夹（必填）') }, ['assetsRoot']),
      output: {
        schema: obj({
          needsUnderstanding: arr(str('素材绝对路径'), '需要你去理解的素材'),
          reused: arr(str('素材绝对路径'), '已经理解过、这次直接复用的'),
          skipped: arr(obj({ clipPath: str('路径'), code: str('错误码'), message: str('说明') },
            ['clipPath', 'code', 'message']), '跳过的素材和原因'),
          nextStep: str('下一步'),
        }, ['needsUnderstanding', 'reused', 'skipped', 'nextStep']),
        render: (_args, value) => {
          const v = asRecord(value);
          const lines = [
            `需要理解 ${v.needsUnderstanding?.length ?? 0} 段，复用 ${v.reused?.length ?? 0} 段，` +
            `跳过 ${v.skipped?.length ?? 0} 段。`,
          ];
          for (const s of v.skipped ?? []) lines.push(`跳过 ${s.clipPath}：[${s.code}] ${s.message}`);
          return lines;
        },
      },
      async execute(args) {
        const assetsRoot = requireString(args, 'assetsRoot');
        try {
          // 不传 understand 就是只报不做——宿主调不到模型，理解只能由你来。
          const result = await scanAssets({ assetsRoot });
          return {
            needsUnderstanding: result.needsUnderstanding,
            reused: result.reused,
            skipped: result.skipped,
            nextStep: result.needsUnderstanding.length === 0
              ? '素材都理解过了，不用再做什么。'
              : '对 needsUnderstanding 里的每一段调 video_understand，再调 narrate_describe 把结果交回来。',
          };
        } catch (error) {
          throw surface(error);
        }
      },
    },

    {
      name: 'narrate_describe',
      description:
        '把你对一段素材的理解交回来。给按时间段分的描述最好（画面在第几秒到第几秒是什么），' +
        '只给一句整体描述也行。**时长不用你报**——插件自己量，你报的会被忽略，' +
        '因为挑素材和裁剪都靠这个数，它必须是量出来的。',
      parameters: obj({
        clipPath: str('素材绝对路径（必填）'),
        description: str('整体描述。给了 segments 就不用它'),
        segments: arr(SEGMENT, '按时间段分的描述，最好有'),
        engine: str('你用什么理解的，例如 video-understand-l0'),
        visualSearchDir: str('画面向量缓存目录，如果有'),
      }, ['clipPath']),
      output: {
        schema: obj({
          clip: str('素材文件名'),
          durationSec: num('插件量出来的真实时长'),
          segments: arr(SEGMENT, '存下来的时间段'),
        }, ['clip', 'durationSec', 'segments']),
        render: (_args, value) => {
          const v = asRecord(value);
          return [`${v.clip ?? ''}：${v.durationSec ?? 0} 秒，存了 ${v.segments?.length ?? 0} 个时间段。`];
        },
      },
      async execute(args) {
        const clipPath = requireString(args, 'clipPath');
        const record = asRecord(args);
        try {
          const { durationSec } = await measureClip(clipPath);
          const fromMachine = normalizeMachine(
            {
              segments: Array.isArray(record.segments) ? record.segments : undefined,
              description: typeof record.description === 'string' ? record.description : '',
              engine: typeof record.engine === 'string' ? record.engine : 'agent',
              visualSearchDir: typeof record.visualSearchDir === 'string' ? record.visualSearchDir : '',
            },
            clipPath,
            durationSec,
          );
          const written = await writeMachineSection(clipPath, {
            fingerprint: await fingerprintOf(clipPath),
            fromMachine,
          });
          return { clip: written.clip, durationSec, segments: written.fromMachine.segments };
        } catch (error) {
          throw surface(error);
        }
      },
    },

    {
      name: 'narrate_status',
      description:
        '这条视频做到哪了、在等什么、下一步该调什么。中途断了就先调这个，别猜。',
      parameters: obj({ jobDir: str('工作目录（必填）') }, ['jobDir']),
      output: {
        schema: obj({
          stage: str('现在在哪个阶段'),
          stopPoint: int('停在第几个停点，0 表示不在停点上'),
          waitingForUser: bool('在等用户点头吗'),
          nextStep: str('下一步'),
          counts: obj({
            questions: int('一共几个问题'),
            answered: int('答了几个'),
            sentences: int('文稿几句'),
          }, ['questions', 'answered', 'sentences']),
        }, ['stage', 'stopPoint', 'waitingForUser', 'nextStep', 'counts']),
        render: (_args, value) => {
          const v = asRecord(value);
          return [`阶段 ${v.stage ?? ''}，停点 ${v.stopPoint ?? 0}。下一步：${v.nextStep ?? ''}`];
        },
      },
      async execute(args) {
        const jobDir = requireString(args, 'jobDir');
        try {
          const job = await readJob(jobDir);
          const questions = job.interview?.questions ?? [];
          const answered = questions.filter((q) => String(q.answer ?? '').trim() !== '').length;
          const sentences = job.script?.sentences ?? [];
          const done = await interviewComplete(jobDir);

          let stage = 'script';
          let stopPoint = 1;
          let waitingForUser = true;
          let nextStep = '先调 narrate_start 建任务。';
          if (questions.length === 0) {
            nextStep = '还没提问。调 narrate_start，或者直接问用户那四件事。';
          } else if (!done) {
            nextStep = `还差 ${questions.length - answered} 个回答，继续调 narrate_answer。`;
          } else if (sentences.length === 0) {
            stopPoint = 1;
            waitingForUser = false;
            nextStep = '问完了。自己写文稿，再调 narrate_script 交上来。';
          } else {
            stopPoint = 2;
            nextStep = '停点 2：文稿写好了，念给用户等他点头。他点头之后的步骤还没做完。';
          }
          return {
            stage,
            stopPoint,
            waitingForUser,
            nextStep,
            counts: { questions: questions.length, answered, sentences: sentences.length },
          };
        } catch (error) {
          throw surface(error);
        }
      },
    },
  ];
}

/**
 * 插件入口。配置缺失时照样加载——工具在 execute 时才会因为具体问题报错，
 * 而不是让整个 profile 起不来。
 */
export function apply(ctx, config) {
  const disposers = [];
  for (const definition of buildTools(config)) {
    disposers.push(ctx.tools.register(definition));
  }
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      for (const dispose of disposers) dispose();
    });
  }
}
