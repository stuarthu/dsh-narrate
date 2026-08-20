// T-08 的测试。契约：docs/crew/api/flow-stages.md
//
// 这个文件守的是整个产品的立命之处：**没有你点头，一步都不许往下走。**
// 数据齐了不代表可以继续——别的工具都是数据齐了就做，那正是它们和这个插件的区别。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nextStep, assertReady, approveStop, STEPS, STOP_POINTS } from '../src/flow/run.js';
import { createJob, openJob, readJob } from '../src/flow/job.js';

const tmp = () => mkdtemp(join(tmpdir(), 'narrate-flow-'));

async function fresh(idea = '讲清楚一件事') {
  const dir = await tmp();
  await createJob(dir, { slug: 'j', aspect: 'landscape', language: 'zh', idea });
  return dir;
}
/** 直接往某一节写内容，跳过真正的阶段，方便造出各种局面。 */
async function put(dir, stage, section, value) {
  const job = await openJob(dir, stage);
  job.set(section, value);
  await job.save();
}
const answered = (n = 4) => ({
  questions: Array.from({ length: n }, (_, i) => ({ id: `IQ-${i + 1}`, text: '问', suggestion: '答', answer: '答了' })),
});
const script = (n = 3) => ({
  sentences: Array.from({ length: n }, (_, i) => ({ id: `S-00${i + 1}`, text: `第 ${i + 1} 句。` })),
});

describe('T-08 次序：一步一步，缺什么说什么', () => {
  test('步骤和停点是写死的，agent 只能照这个走', () => {
    assert.deepEqual(STEPS, ['interview', 'script', 'index', 'shotplan', 'voice', 'render', 'done']);
    assert.deepEqual(STOP_POINTS, { interview: 1, script: 2, shotplan: 3, voice: 4 });
  });

  test('新任务的第一步是反问', async () => {
    const step = nextStep(await readJob(await fresh()));
    assert.equal(step.step, 'interview');
    assert.ok(step.why.includes('反问') || step.why.includes('问'), step.why);
  });

  test('问题没答完，还是停在反问', async () => {
    const dir = await fresh();
    await put(dir, 'script', 'interview', {
      questions: [{ id: 'IQ-1', text: '问', suggestion: '答', answer: '答了' },
        { id: 'IQ-2', text: '问', suggestion: '答', answer: null }],
    });
    const step = nextStep(await readJob(dir));
    assert.equal(step.step, 'interview');
    assert.ok(step.why.includes('IQ-2'), '要说出还差哪一个：' + step.why);
  });

  test('答完了，下一步是写文稿', async () => {
    const dir = await fresh();
    await put(dir, 'script', 'interview', answered());
    assert.equal(nextStep(await readJob(dir)).step, 'script');
  });
});

describe('T-08 停点：数据齐了也不许走，要你点头', () => {
  test('文稿写好但停点 2 没点头，就停在那里等你', async () => {
    const dir = await fresh();
    await put(dir, 'script', 'interview', answered());
    await put(dir, 'script', 'script', script());
    const step = nextStep(await readJob(dir));
    assert.equal(step.waitingForUser, true, '数据齐了也要等点头');
    assert.equal(step.stopPoint, 2);
    assert.notEqual(step.step, 'index', '没点头不许往下走');
    assert.ok(step.why.includes('点头') || step.why.includes('确认'), step.why);
  });

  test('点了头才继续，下一步是素材入库', async () => {
    const dir = await fresh();
    await put(dir, 'script', 'interview', answered());
    await put(dir, 'script', 'script', script());
    await approveStop(dir, 2);
    const step = nextStep(await readJob(dir));
    assert.equal(step.waitingForUser, false);
    assert.equal(step.step, 'index');
  });

  test('画面对应表写好但停点 3 没点头，停住等你', async () => {
    const dir = await fresh();
    await put(dir, 'script', 'interview', answered());
    await put(dir, 'script', 'script', script());
    await approveStop(dir, 2);
    await put(dir, 'shotplan', 'shotplan', { shots: [{ sentenceId: 'S-001' }], missing: [] });
    const step = nextStep(await readJob(dir));
    assert.equal(step.stopPoint, 3);
    assert.equal(step.waitingForUser, true);
    assert.notEqual(step.step, 'voice');
  });

  test('缺素材不影响你点头继续——那是你的决定，不是错误', async () => {
    const dir = await fresh();
    await put(dir, 'script', 'interview', answered());
    await put(dir, 'script', 'script', script());
    await approveStop(dir, 2);
    await put(dir, 'shotplan', 'shotplan', {
      shots: [{ sentenceId: 'S-001' }],
      missing: [{ sentenceId: 'S-002', reason: '没有合适素材' }],
    });
    await approveStop(dir, 3);
    const step = nextStep(await readJob(dir));
    assert.equal(step.step, 'voice', '你点了头就该继续，缺素材是你已经知道的事');
  });

  test('配音做完但停点 4 没点头，停住让你先只听声音', async () => {
    const dir = await fresh();
    await put(dir, 'script', 'interview', answered());
    await put(dir, 'script', 'script', script());
    await approveStop(dir, 2);
    await put(dir, 'shotplan', 'shotplan', { shots: [{ sentenceId: 'S-001' }], missing: [] });
    await approveStop(dir, 3);
    await put(dir, 'voice', 'voice', { engine: 'x', clips: [{ sentenceId: 'S-001', audioPath: '/a.wav', durationSec: 1 }] });
    const step = nextStep(await readJob(dir));
    assert.equal(step.stopPoint, 4);
    assert.equal(step.waitingForUser, true);
    assert.notEqual(step.step, 'render');
  });

  test('四个停点都点了头才渲染，渲染完就是 done', async () => {
    const dir = await fresh();
    await put(dir, 'script', 'interview', answered());
    await put(dir, 'script', 'script', script());
    await approveStop(dir, 2);
    await put(dir, 'shotplan', 'shotplan', { shots: [{ sentenceId: 'S-001' }], missing: [] });
    await approveStop(dir, 3);
    await put(dir, 'voice', 'voice', { engine: 'x', clips: [{ sentenceId: 'S-001', audioPath: '/a.wav', durationSec: 1 }] });
    await approveStop(dir, 4);
    assert.equal(nextStep(await readJob(dir)).step, 'render');
    await put(dir, 'render', 'render', { segments: [], output: '/out/final.mp4' });
    const done = nextStep(await readJob(dir));
    assert.equal(done.step, 'done');
    assert.equal(done.waitingForUser, false);
  });
});

describe('T-08 点头这件事本身也要守', () => {
  test('还没走到的停点不许提前点头', async () => {
    const dir = await fresh();
    await assert.rejects(() => approveStop(dir, 2), (e) => e.code === 'E_STOP_NOT_REACHED');
  });

  test('不是停点的编号不许点', async () => {
    const dir = await fresh();
    await assert.rejects(() => approveStop(dir, 9), (e) => e.code === 'E_NO_SUCH_STOP');
  });

  test('重复点头不报错，也不出第二条记录', async () => {
    const dir = await fresh();
    await put(dir, 'script', 'interview', answered());
    await put(dir, 'script', 'script', script());
    await approveStop(dir, 2);
    await approveStop(dir, 2);
    assert.deepEqual((await readJob(dir)).meta.approvedStops, [2]);
  });

  test('点头记在 meta 里，那是 flow 的节', async () => {
    const dir = await fresh();
    await put(dir, 'script', 'interview', answered());
    await put(dir, 'script', 'script', script());
    await approveStop(dir, 2);
    const raw = await readJob(dir);
    assert.deepEqual(raw.meta.approvedStops, [2]);
    assert.equal(raw.script.sentences.length, 3, '别的节不该被动过');
  });
});

describe('T-08 守门：抢跑要当场报错', () => {
  test('问题没答完就想写文稿，报 E_OUT_OF_ORDER 并说缺什么', async () => {
    const dir = await fresh();
    const job = await readJob(dir);
    assert.throws(() => assertReady(job, 'script'), (e) => e.code === 'E_OUT_OF_ORDER');
    try {
      assertReady(job, 'script');
    } catch (error) {
      assert.ok(error.message.includes('interview'), '要说清缺的是哪一步：' + error.message);
    }
  });

  test('停点 2 没点头就想做画面对应表，也要报错', async () => {
    const dir = await fresh();
    await put(dir, 'script', 'interview', answered());
    await put(dir, 'script', 'script', script());
    const job = await readJob(dir);
    assert.throws(() => assertReady(job, 'shotplan'), (e) => e.code === 'E_OUT_OF_ORDER');
    try {
      assertReady(job, 'shotplan');
    } catch (error) {
      assert.ok(error.message.includes('停点 2'), error.message);
    }
  });

  test('该做的那一步不报错', async () => {
    const dir = await fresh();
    assert.doesNotThrow(() => assertReady(nextStep(null) && readJobSync(), 'interview'));
    function readJobSync() { return { meta: {}, idea: 'x' }; }
  });

  test('已经做过的那一步可以重做（改文稿、重挑素材都要允许）', async () => {
    const dir = await fresh();
    await put(dir, 'script', 'interview', answered());
    await put(dir, 'script', 'script', script());
    const job = await readJob(dir);
    assert.doesNotThrow(() => assertReady(job, 'script'), '重写文稿要允许');
    assert.doesNotThrow(() => assertReady(job, 'interview'), '补问也要允许');
  });
});

describe('T-08 续跑', () => {
  test('同一个工作文件问两次，答案一样', async () => {
    const dir = await fresh();
    await put(dir, 'script', 'interview', answered());
    await put(dir, 'script', 'script', script());
    await approveStop(dir, 2);
    const a = nextStep(await readJob(dir));
    const b = nextStep(await readJob(dir));
    assert.deepEqual(a, b);
  });

  test('每一步都说得出该调哪个工具', async () => {
    const dir = await fresh();
    assert.ok(nextStep(await readJob(dir)).tool.startsWith('narrate_'));
    await put(dir, 'script', 'interview', answered());
    assert.ok(nextStep(await readJob(dir)).tool.startsWith('narrate_'));
  });

  test('工作文件缺 meta 也不崩，退回第一步', () => {
    for (const broken of [null, undefined, {}, { meta: null }]) {
      const step = nextStep(broken);
      assert.equal(step.step, 'interview');
    }
  });
});
