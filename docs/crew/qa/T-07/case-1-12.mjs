// T-07 的 QA 用例 1 到 12。跑法：node docs/crew/qa/T-07/case-1-12.mjs
// 计划见 docs/crew/qa/T-07-plan.md
//
// 这些用例是**从验收检查写的，不是从代码写的**。刻意和单元测试分开：
// 从代码出发写的检查只会证明"代码现在干了什么"，那永远通过。
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const { assignShots, DEFAULTS } = await import(join(ROOT, 'src/shotplan/assign.js'));

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  通过    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  失败    ${name}\n          ${error.message}`);
  }
};

/** 一句话加它的候选。dropped 里放第 1 层按长度排除掉的。 */
const one = (id, text, candidates, { needSeconds = 3, shortDrops = 0 } = {}) => ({
  sentence: { id, text },
  result: {
    sentenceId: id,
    needSeconds,
    candidates,
    dropped: Array.from({ length: shortDrops }, (_, i) => ({ clipPath: `/short${i}.mp4`, layer: 1, why: '盖不住' })),
    layersUsed: [1, 2],
  },
});
const c = (clipPath, score, confidence = 'high') =>
  ({ clipPath, startSec: 0, endSec: 3, score, layer: 2, confidence, why: '文字重叠' });
const run = (list, extra = {}) => assignShots({
  sentences: list.map((x) => x.sentence),
  candidates: list.map((x) => x.result),
  ...extra,
});

console.log('用例 1：对应表每行该有什么');
check('有句子编号、素材、起秒、止秒、字幕文本', () => {
  const row = run([one('S-001', '第一句。', [c('/a.mp4', 5)])]).shots[0];
  for (const key of ['sentenceId', 'clipPath', 'startSec', 'endSec', 'subtitle']) {
    assert.ok(row[key] !== undefined, `少了 ${key}`);
  }
  assert.equal(row.subtitle, '第一句。');
});

console.log('用例 2：每一句恰好在一边');
check('不重不漏', () => {
  const got = run([
    one('S-001', '有。', [c('/a.mp4', 8)]),
    one('S-002', '没有。', []),
    one('S-003', '也有。', [c('/b.mp4', 7)]),
  ]);
  const planned = got.shots.map((s) => s.sentenceId);
  const missing = got.missing.map((m) => m.sentenceId);
  assert.equal(planned.length + missing.length, 3);
  assert.equal(new Set([...planned, ...missing]).size, 3);
});

console.log('用例 3 和 4：门槛是相对的，不是绝对零');
check('只有明显偏低的那句算缺素材', () => {
  const got = run([
    one('S-001', '海。', [c('/ocean.mp4', 10.3)]),
    one('S-002', '车。', [c('/city.mp4', 12.7)]),
    one('S-003', '火。', [c('/fire.mp4', 9.4)]),
    one('S-004', '雪。', [c('/snow.mp4', 5.8)]),
    one('S-005', '编译器。', [c('/random.mp4', 3.5)]),
  ]);
  assert.deepEqual(got.missing.map((m) => m.sentenceId), ['S-005']);
  assert.equal(got.shots.length, 4);
});
check('全是 0 分时全部算缺素材', () => {
  const got = run([one('S-001', '一。', [c('/a.mp4', 0)]), one('S-002', '二。', [c('/b.mp4', 0)])]);
  assert.equal(got.shots.length, 0);
  assert.equal(got.missing.length, 2);
});

console.log('用例 5 和 6：理由要分清「太短」和「不相关」');
check('太短：说长度，带上秒数和"改短"的建议', () => {
  const m = run([one('S-001', '一句很长的话。', [], { needSeconds: 6.3, shortDrops: 5 })]).missing[0];
  assert.equal(m.kind, 'too-short');
  assert.ok(m.reason.includes('6.3 秒'), m.reason);
  assert.ok(m.reason.includes('5 段'), m.reason);
  assert.ok(m.reason.includes('改短'), m.reason);
});
check('不相关：说相关性', () => {
  const got = run([one('S-001', '一。', [c('/a.mp4', 0)]), one('S-002', '二。', [c('/b.mp4', 9)])]);
  const m = got.missing.find((x) => x.sentenceId === 'S-001');
  assert.equal(m.kind, 'not-relevant');
  assert.ok(m.reason.includes('对得上'), m.reason);
});

console.log('用例 7：用量看得见');
check('用了三次就显示三次，最多的排最前', () => {
  const got = run([
    one('S-001', '一。', [c('/a.mp4', 9)]),
    one('S-002', '二。', [c('/a.mp4', 9)]),
    one('S-003', '三。', [c('/a.mp4', 9)]),
    one('S-004', '四。', [c('/b.mp4', 9)]),
  ]);
  assert.equal(got.usage[0].clipPath, '/a.mp4');
  assert.equal(got.usage[0].count, 3);
  assert.deepEqual(got.usage[0].sentenceIds, ['S-001', 'S-002', 'S-003']);
});

console.log('用例 8 到 10：换花样，但不牺牲相关性');
check('同分的两段，两句话分到不同的那段', () => {
  const got = run([
    one('S-001', '一。', [c('/a.mp4', 9), c('/b.mp4', 9)]),
    one('S-002', '二。', [c('/a.mp4', 9), c('/b.mp4', 9)]),
  ]);
  assert.equal(new Set(got.shots.map((s) => s.clipPath)).size, 2);
});
check('9 分和 4.7 分之间，两句都用 9 分那段', () => {
  const got = run([
    one('S-001', '一。', [c('/ocean.mp4', 9), c('/random.mp4', 4.7)]),
    one('S-002', '二。', [c('/ocean.mp4', 9), c('/random.mp4', 4.7)]),
  ]);
  assert.deepEqual(got.shots.map((s) => s.clipPath), ['/ocean.mp4', '/ocean.mp4']);
});
check('三句三段，相邻不同段，也不 a b a 地闪', () => {
  const all = [c('/a.mp4', 9), c('/b.mp4', 9), c('/c.mp4', 9)];
  const got = run([one('S-001', '一。', all), one('S-002', '二。', all), one('S-003', '三。', all)]);
  const used = got.shots.map((s) => s.clipPath);
  assert.equal(new Set(used).size, 3, `该三段各用一次，实际 ${used}`);
});

console.log('用例 11：把握不高只提醒一条');
check('三句都把握不高，只出一条汇总', () => {
  const got = run([
    one('S-001', '一。', [c('/a.mp4', 9, 'low')]),
    one('S-002', '二。', [c('/b.mp4', 9, 'low')]),
    one('S-003', '三。', [c('/c.mp4', 9, 'low')]),
  ]);
  const low = got.notes.filter((n) => n.message.includes('把握不高'));
  assert.equal(low.length, 1, `该只有一条，实际 ${low.length}`);
  assert.equal(low[0].count, 3);
});

console.log('用例 12：可重跑');
check('同样输入跑两次结果一样；候选顺序打乱结果也一样', () => {
  const build = () => [
    one('S-001', '一。', [c('/a.mp4', 9), c('/b.mp4', 9)]),
    one('S-002', '二。', [c('/b.mp4', 9), c('/a.mp4', 9)]),
  ];
  assert.deepEqual(run(build()), run(build()));
  const x = run([one('S-001', '一。', [c('/x.mp4', 9), c('/y.mp4', 9)])]);
  const y = run([one('S-001', '一。', [c('/y.mp4', 9), c('/x.mp4', 9)])]);
  assert.deepEqual(x.shots, y.shots);
});

console.log('用例 13：默认值和可调项都在模块里');
check('降权、门槛、相关性带都有默认值', () => {
  for (const key of ['reusePenalty', 'matchRatio', 'adjacentPenalty', 'varietyBand']) {
    assert.ok(typeof DEFAULTS[key] === 'number', `少了默认值 ${key}`);
  }
  assert.ok(DEFAULTS.varietyBand > 0 && DEFAULTS.varietyBand < 1);
});

console.log('');
console.log(failures === 0 ? 'T-07 QA：全部通过' : `T-07 QA：${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
