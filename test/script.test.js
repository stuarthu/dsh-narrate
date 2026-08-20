// T-05 的测试。契约：docs/crew/api/flow-stages.md
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildQuestions, recordAnswer, interviewComplete, CORE_QUESTION_COUNT } from '../src/script/interview.js';
import { writeScript, LENGTH_LIMIT } from '../src/script/write.js';
import { createJob, readJob, openJob } from '../src/flow/job.js';

const tmp = () => mkdtemp(join(tmpdir(), 'narrate-script-'));

async function job(idea = '讲清楚 Rust 为什么快', aspect = 'landscape') {
  const dir = await tmp();
  await createJob(dir, { slug: 'why-rust', aspect, language: 'zh', idea });
  return dir;
}

/** 全部答完，方便测写文稿那一步。 */
async function answerAll(dir) {
  const questions = await buildQuestions({ jobDir: dir });
  for (const q of questions) await recordAnswer({ jobDir: dir, id: q.id, answer: `${q.id} 的回答` });
  return questions;
}

describe('T-05 停点 1：先反问', () => {
  test('A-4：至少提出 3 个问题，每个都有 id 和推荐答案', async () => {
    const dir = await job();
    const questions = await buildQuestions({ jobDir: dir });
    assert.ok(questions.length >= 3, `至少 3 个问题，实际 ${questions.length}`);
    assert.equal(questions.length, CORE_QUESTION_COUNT);
    for (const q of questions) {
      assert.match(q.id, /^IQ-\d+$/);
      assert.ok(q.text.length > 0);
      assert.ok(q.suggestion.length > 0, `${q.id} 该带一个推荐答案`);
      assert.equal(q.answer, null);
    }
    assert.equal(new Set(questions.map((q) => q.id)).size, questions.length, 'id 有重复');
  });

  test('问题写进工作文件的 interview 节，别的节不动', async () => {
    const dir = await job();
    await buildQuestions({ jobDir: dir });
    const raw = await readJob(dir);
    assert.equal(raw.interview.questions.length, CORE_QUESTION_COUNT);
    assert.equal(raw.script, undefined, '这一步不该产生文稿');
    assert.equal(raw.shotplan, undefined);
  });

  test('四个核心问题问的是时长、观众、语气、最想让人记住哪句', async () => {
    const dir = await job();
    const text = (await buildQuestions({ jobDir: dir })).map((q) => q.text).join(' ');
    for (const topic of ['多长', '给谁看', '语气', '记住']) {
      assert.ok(text.includes(topic), `核心问题里少了「${topic}」`);
    }
  });

  test('可以注入针对这个想法的额外问题，接在核心问题后面', async () => {
    const dir = await job();
    const questions = await buildQuestions({
      jobDir: dir,
      extraQuestions: async ({ idea }) => [
        { text: `${idea} 里你最想比较的是哪两门语言？`, suggestion: 'Rust 和 C++' },
      ],
    });
    assert.equal(questions.length, CORE_QUESTION_COUNT + 1);
    const last = questions.at(-1);
    assert.equal(last.id, `IQ-${CORE_QUESTION_COUNT + 1}`);
    assert.ok(last.text.includes('Rust'), '额外问题该看得到那句想法');
  });

  test('额外问题那一步坏了不影响核心问题', async () => {
    const dir = await job();
    const questions = await buildQuestions({
      jobDir: dir,
      extraQuestions: async () => { throw new Error('模型不可用'); },
    });
    assert.equal(questions.length, CORE_QUESTION_COUNT, '核心问题必须照样出来');
  });

  test('重复调用不会把已有的答案冲掉', async () => {
    const dir = await job();
    const questions = await buildQuestions({ jobDir: dir });
    await recordAnswer({ jobDir: dir, id: questions[0].id, answer: '八分钟' });
    const again = await buildQuestions({ jobDir: dir });
    assert.equal(again[0].answer, '八分钟', '答案被冲掉了');
    assert.equal(again.length, questions.length);
  });

  test('记下答案；不认识的 id 报 E_NO_SUCH_QUESTION', async () => {
    const dir = await job();
    await buildQuestions({ jobDir: dir });
    await recordAnswer({ jobDir: dir, id: 'IQ-1', answer: '八分钟' });
    assert.equal((await readJob(dir)).interview.questions[0].answer, '八分钟');
    await assert.rejects(
      () => recordAnswer({ jobDir: dir, id: 'IQ-99', answer: 'x' }),
      (e) => e.code === 'E_NO_SUCH_QUESTION',
    );
  });

  test('空白的回答不算回答', async () => {
    const dir = await job();
    await buildQuestions({ jobDir: dir });
    await assert.rejects(
      () => recordAnswer({ jobDir: dir, id: 'IQ-1', answer: '   ' }),
      (e) => e.code === 'E_EMPTY_ANSWER',
    );
  });

  test('全部答完才算问完', async () => {
    const dir = await job();
    const questions = await buildQuestions({ jobDir: dir });
    assert.equal(await interviewComplete(dir), false);
    for (const q of questions.slice(0, -1)) {
      await recordAnswer({ jobDir: dir, id: q.id, answer: 'x' });
      assert.equal(await interviewComplete(dir), false, '还差一个就不算完');
    }
    await recordAnswer({ jobDir: dir, id: questions.at(-1).id, answer: 'x' });
    assert.equal(await interviewComplete(dir), true);
  });
});

describe('T-05 停点 2：写文稿', () => {
  test('A-4：问题没答完就拒绝写文稿，而且不留半个文稿', async () => {
    const dir = await job();
    await buildQuestions({ jobDir: dir });
    await recordAnswer({ jobDir: dir, id: 'IQ-1', answer: '八分钟' });
    await assert.rejects(
      () => writeScript({ jobDir: dir, compose: async () => ['不该被调用'] }),
      (e) => e.code === 'E_INTERVIEW_INCOMPLETE',
    );
    assert.equal((await readJob(dir)).script, undefined);
  });

  test('还没提问就想写文稿，也要拒绝', async () => {
    const dir = await job();
    await assert.rejects(
      () => writeScript({ jobDir: dir, compose: async () => ['x'] }),
      (e) => e.code === 'E_INTERVIEW_INCOMPLETE',
    );
  });

  test('答完之后写出按句编号的文稿', async () => {
    const dir = await job();
    await answerAll(dir);
    const result = await writeScript({
      jobDir: dir,
      compose: async () => ['Rust 快，不是因为它新。', '它把检查放在了编译期。', '所以运行时不用还债。'],
    });
    assert.deepEqual(result.sentences.map((s) => s.id), ['S-001', 'S-002', 'S-003']);
    assert.equal(result.sentences[0].text, 'Rust 快，不是因为它新。');
    const raw = await readJob(dir);
    assert.equal(raw.script.sentences.length, 3);
    assert.equal(raw.shotplan, undefined, 'A-5：这一步不该往下做对应表');
  });

  test('句子会去掉首尾空白，空句子直接丢掉', async () => {
    const dir = await job();
    await answerAll(dir);
    const result = await writeScript({
      jobDir: dir,
      compose: async () => ['  第一句  ', '', '   ', '第二句'],
    });
    assert.deepEqual(result.sentences.map((s) => s.text), ['第一句', '第二句']);
    assert.deepEqual(result.sentences.map((s) => s.id), ['S-001', 'S-002']);
  });

  test('编号能过 9 句，写成三位数', async () => {
    const dir = await job();
    await answerAll(dir);
    const result = await writeScript({
      jobDir: dir,
      compose: async () => Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 句`),
    });
    assert.equal(result.sentences[9].id, 'S-010');
    assert.equal(result.sentences.at(-1).id, 'S-012');
  });

  test('一句都没写出来时报 E_SCRIPT_UNUSABLE，不留半个文稿', async () => {
    const dir = await job();
    await answerAll(dir);
    for (const bad of [[], ['', '  '], null, 'not an array']) {
      await assert.rejects(
        () => writeScript({ jobDir: dir, compose: async () => bad }),
        (e) => e.code === 'E_SCRIPT_UNUSABLE',
        `compose 返回 ${JSON.stringify(bad)} 时该报错`,
      );
    }
    assert.equal((await readJob(dir)).script, undefined);
  });

  test('写文稿的那一步看得到想法、每一个问答、比例和语言', async () => {
    const dir = await job('讲清楚 Rust 为什么快', 'portrait');
    await answerAll(dir);
    let seen;
    await writeScript({
      jobDir: dir,
      compose: async (input) => { seen = input; return ['一句话']; },
    });
    assert.equal(seen.idea, '讲清楚 Rust 为什么快');
    assert.equal(seen.aspect, 'portrait');
    assert.equal(seen.language, 'zh');
    assert.equal(seen.answers.length, CORE_QUESTION_COUNT);
    assert.ok(seen.answers[0].question.length > 0);
    assert.equal(seen.answers[0].answer, 'IQ-1 的回答');
    assert.equal(seen.maxSentenceLength, LENGTH_LIMIT.portrait);
  });

  test('太长的句子会被标出来，但绝不自己切开', async () => {
    const dir = await job('x', 'portrait');
    await answerAll(dir);
    const long = '这是一句故意写得很长的话'.repeat(4);
    const result = await writeScript({
      jobDir: dir,
      compose: async () => ['短句。', long],
    });
    assert.equal(result.sentences.length, 2, '句子不该被切开');
    assert.equal(result.sentences[1].text, long, '原文一字不动');
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].sentenceId, 'S-002');
    assert.ok(result.warnings[0].message.includes('竖屏'));
  });

  test('竖屏的长度上限比横屏严', async () => {
    assert.ok(LENGTH_LIMIT.portrait < LENGTH_LIMIT.landscape);
    const text = '一'.repeat(LENGTH_LIMIT.portrait + 1);
    const wide = await job('x', 'landscape');
    await answerAll(wide);
    const w = await writeScript({ jobDir: wide, compose: async () => [text] });
    assert.equal(w.warnings.length, 0, '横屏放得下，不该报');

    const tall = await job('x', 'portrait');
    await answerAll(tall);
    const t = await writeScript({ jobDir: tall, compose: async () => [text] });
    assert.equal(t.warnings.length, 1, '竖屏放不下，该报');
  });

  test('写文稿不碰 meta——那是 flow 的节', async () => {
    const dir = await job();
    await answerAll(dir);
    const before = (await readJob(dir)).meta;
    await writeScript({ jobDir: dir, compose: async () => ['一句话'] });
    assert.deepEqual((await readJob(dir)).meta, before, 'meta 被改了');
  });

  test('写文稿这一步只能写 script 节，写别人的节会当场抛错', async () => {
    const dir = await job();
    const handle = await openJob(dir, 'script');
    assert.throws(() => handle.set('shotplan', { shots: [] }), (e) => e.code === 'E_WRITE_FOREIGN_SECTION');
    assert.throws(() => handle.set('meta', {}), (e) => e.code === 'E_WRITE_FOREIGN_SECTION');
  });
});

describe('T-05 评审补的测试', () => {
  test('第二轮不传额外问题时，第一轮答过的额外问题和回答都要留着', async () => {
    const dir = await job();
    const extra = async () => [{ text: '你最想比较哪两门语言？', suggestion: 'Rust 和 C++' }];
    const first = await buildQuestions({ jobDir: dir, extraQuestions: extra });
    const extraId = first.at(-1).id;
    await recordAnswer({ jobDir: dir, id: extraId, answer: 'Rust 和 Go' });

    // 第二轮忘了传 extraQuestions
    const second = await buildQuestions({ jobDir: dir });
    const kept = second.find((q) => q.text === '你最想比较哪两门语言？');
    assert.ok(kept, '答过的额外问题不该消失');
    assert.equal(kept.answer, 'Rust 和 Go', '回答被弄丢了');
  });

  test('没回答的旧额外问题不会越攒越多', async () => {
    const dir = await job();
    await buildQuestions({ jobDir: dir, extraQuestions: async () => [{ text: '第一轮的问题' }] });
    const second = await buildQuestions({ jobDir: dir, extraQuestions: async () => [{ text: '第二轮的问题' }] });
    assert.equal(second.length, CORE_QUESTION_COUNT + 1);
    assert.ok(!second.some((q) => q.text === '第一轮的问题'), '没答过的旧问题该丢掉');
  });

  test('写稿那一步自己失败时报 E_COMPOSE_FAILED，不让裸错误冒出去', async () => {
    const dir = await job();
    await answerAll(dir);
    await assert.rejects(
      () => writeScript({ jobDir: dir, compose: async () => { throw new Error('模型超时'); } }),
      (e) => e.code === 'E_COMPOSE_FAILED' && e.message.includes('模型超时'),
    );
    assert.equal((await readJob(dir)).script, undefined);
  });

  test('不是字符串的东西不会被当成台词', async () => {
    const dir = await job();
    await answerAll(dir);
    const result = await writeScript({
      jobDir: dir,
      compose: async () => ['真的一句话', { text: '这是个对象' }, 42, null, '另一句'],
    });
    assert.deepEqual(result.sentences.map((s) => s.text), ['真的一句话', '另一句']);
    assert.ok(!JSON.stringify(result).includes('[object Object]'), '对象被当成台词了');
  });

  test('全是非字符串时报 E_SCRIPT_UNUSABLE', async () => {
    const dir = await job();
    await answerAll(dir);
    await assert.rejects(
      () => writeScript({ jobDir: dir, compose: async () => [{ a: 1 }, 2, null] }),
      (e) => e.code === 'E_SCRIPT_UNUSABLE',
    );
  });
});
