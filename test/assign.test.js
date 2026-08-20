// T-07 的测试。契约：docs/crew/api/assetsindex-shotplan.md 版本 11、flow-stages.md 版本 4
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { assignShots, DEFAULTS } from '../src/shotplan/assign.js';

/** 一句话加它的候选，手写。契约要求跑在桩上，不准调真的挑选器。 */
const pick = (id, text, candidates, needSeconds = 3) => ({
  sentence: { id, text },
  result: { sentenceId: id, needSeconds, candidates, dropped: [], layersUsed: [1, 2] },
});
const cand = (clipPath, score, { startSec = 0, needSeconds = 3, confidence = 'high', why = '文字重叠' } = {}) =>
  ({ clipPath, startSec, endSec: startSec + needSeconds, score, layer: 2, confidence, why });

/** 把上面那些拼成 assignShots 要的两个数组。 */
function inputs(picks) {
  return { sentences: picks.map((p) => p.sentence), candidates: picks.map((p) => p.result) };
}

describe('T-07 A-6：画面对应表每行该有什么', () => {
  test('每行有句子编号、素材、起秒、止秒、字幕文本', () => {
    const got = assignShots(inputs([
      pick('S-001', '第一句。', [cand('/a.mp4', 5, { startSec: 2 })]),
    ]));
    assert.equal(got.shots.length, 1);
    const row = got.shots[0];
    assert.equal(row.sentenceId, 'S-001');
    assert.equal(row.clipPath, '/a.mp4');
    assert.equal(row.startSec, 2);
    assert.equal(row.endSec, 5);
    assert.equal(row.subtitle, '第一句。', '字幕就是这句话本身');
  });

  test('每一句要么在对应表里，要么在缺素材报告里，不能都不在也不能都在', () => {
    const got = assignShots(inputs([
      pick('S-001', '有素材。', [cand('/a.mp4', 8)]),
      pick('S-002', '没素材。', []),
      pick('S-003', '也有素材。', [cand('/b.mp4', 7)]),
    ]));
    const planned = new Set(got.shots.map((s) => s.sentenceId));
    const missing = new Set(got.missing.map((m) => m.sentenceId));
    for (const id of ['S-001', 'S-002', 'S-003']) {
      assert.equal(planned.has(id) !== missing.has(id), true, `${id} 该恰好出现在一边`);
    }
    assert.equal(planned.size + missing.size, 3);
  });
});

describe('T-07 A-7：挑不到就报出来', () => {
  test('一个候选都没有的句子进缺素材报告，理由说得清', () => {
    const got = assignShots(inputs([pick('S-001', '没素材。', [])]));
    assert.deepEqual(got.shots, []);
    assert.equal(got.missing[0].sentenceId, 'S-001');
    assert.equal(got.missing[0].kind, 'too-short');
    assert.ok(got.missing[0].reason.includes('一段素材都没有'), got.missing[0].reason);
  });

  test('分数远低于全篇中位数的句子也算缺素材，不是只看大于 0', () => {
    // 这些数字来自真实素材上的实测：中位数约 9.4，那句没有对应素材的是 3.5
    const got = assignShots(inputs([
      pick('S-001', '海浪。', [cand('/ocean.mp4', 10.3)]),
      pick('S-002', '车流。', [cand('/city.mp4', 12.7)]),
      pick('S-003', '火。', [cand('/fire.mp4', 9.4)]),
      pick('S-004', '雪。', [cand('/snow.mp4', 5.8)]),
      pick('S-005', '编译器优化。', [cand('/random.mp4', 3.5)]),
    ]));
    const missing = got.missing.map((m) => m.sentenceId);
    assert.deepEqual(missing, ['S-005'], `只有那句该缺素材，实际 ${missing}`);
    assert.ok(got.missing[0].reason.includes('没有一段够相关'), got.missing[0].reason);
    assert.equal(got.shots.length, 4, '5.8 分那句该保留');
  });

  test('全篇都没有相关素材时，不会因为中位数低就假装都匹配上了', () => {
    const got = assignShots(inputs([
      pick('S-001', '一句。', [cand('/a.mp4', 0)]),
      pick('S-002', '两句。', [cand('/b.mp4', 0)]),
    ]));
    assert.deepEqual(got.shots, [], '0 分不该当成匹配');
    assert.equal(got.missing.length, 2);
  });

  test('用了把握不高的素材要在报告里说明', () => {
    const got = assignShots(inputs([
      pick('S-001', '一句。', [cand('/a.mp4', 8, { confidence: 'low' })]),
      pick('S-002', '两句。', [cand('/b.mp4', 8)]),
    ]));
    const row = got.shots.find((s) => s.sentenceId === 'S-001');
    assert.equal(row.confidence, 'low');
    const note = got.notes.find((n) => n.message.includes('把握不高'));
    assert.ok(note, '把握不高要提一句，别让用户自己去翻');
    assert.deepEqual(note.sentenceIds, ['S-001']);
  });
});

describe('T-07 A-27：一段素材用了几次要看得见', () => {
  test('用量清单按次数排，用两次以上的看得到次数', () => {
    const got = assignShots(inputs([
      pick('S-001', '一。', [cand('/a.mp4', 9)]),
      pick('S-002', '二。', [cand('/a.mp4', 9)]),
      pick('S-003', '三。', [cand('/a.mp4', 9)]),
      pick('S-004', '四。', [cand('/b.mp4', 9)]),
    ]));
    const a = got.usage.find((u) => u.clipPath === '/a.mp4');
    assert.ok(a, '用量清单里该有 a');
    assert.equal(a.count, 3);
    assert.deepEqual(a.sentenceIds, ['S-001', 'S-002', 'S-003']);
    assert.equal(got.usage[0].clipPath, '/a.mp4', '用得最多的排最前');
  });
});

describe('T-07 分配：用过的降权，相邻不来回切', () => {
  test('两段分数一样的素材，两句话会分到不同的那段', () => {
    const got = assignShots(inputs([
      pick('S-001', '一。', [cand('/a.mp4', 9), cand('/b.mp4', 9)]),
      pick('S-002', '二。', [cand('/a.mp4', 9), cand('/b.mp4', 9)]),
    ]));
    const used = got.shots.map((s) => s.clipPath);
    assert.equal(new Set(used).size, 2, `两句该用不同的素材，实际 ${used}`);
  });

  test('降权不会强到把明显更相关的那段挤掉', () => {
    const got = assignShots(inputs([
      pick('S-001', '一。', [cand('/good.mp4', 20), cand('/meh.mp4', 1)]),
      pick('S-002', '二。', [cand('/good.mp4', 20), cand('/meh.mp4', 1)]),
    ]));
    assert.deepEqual(got.shots.map((s) => s.clipPath), ['/good.mp4', '/good.mp4'],
      '差 19 分的时候，降权不该让它去用那段几乎不相关的');
  });

  test('相邻两句不在同两段素材之间来回切', () => {
    // 三句，都能用 a 或 b。不加约束会出 a b a，看起来像在闪
    const three = [
      pick('S-001', '一。', [cand('/a.mp4', 9), cand('/b.mp4', 9), cand('/c.mp4', 9)]),
      pick('S-002', '二。', [cand('/a.mp4', 9), cand('/b.mp4', 9), cand('/c.mp4', 9)]),
      pick('S-003', '三。', [cand('/a.mp4', 9), cand('/b.mp4', 9), cand('/c.mp4', 9)]),
    ];
    const got = assignShots(inputs(three));
    const used = got.shots.map((s) => s.clipPath);
    assert.notEqual(used[0], used[1], '相邻两句不该同一段');
    assert.notEqual(used[1], used[2], '相邻两句不该同一段');
    assert.notEqual(used[0], used[2], '有第三段可用时，不该 a b a 地闪');
  });

  test('只有一段素材时，只能一直用它，而且不当错误', () => {
    const got = assignShots(inputs([
      pick('S-001', '一。', [cand('/only.mp4', 9)]),
      pick('S-002', '二。', [cand('/only.mp4', 9)]),
    ]));
    assert.deepEqual(got.shots.map((s) => s.clipPath), ['/only.mp4', '/only.mp4']);
    assert.equal(got.missing.length, 0);
    const note = got.notes.find((n) => n.message.includes('同一段'));
    assert.ok(note, '一直用同一段该提醒一句，让用户知道成片会单调');
  });

  test('降权和门槛都可以调，默认值写在模块里', () => {
    assert.ok(DEFAULTS.reusePenalty > 0);
    assert.ok(DEFAULTS.matchRatio > 0 && DEFAULTS.matchRatio < 1);
    const got = assignShots({
      ...inputs([pick('S-001', '一。', [cand('/a.mp4', 3.5)]), pick('S-002', '二。', [cand('/b.mp4', 9.4)])]),
      matchRatio: 0.1, // 门槛放得很松
    });
    assert.equal(got.missing.length, 0, '门槛放松之后 3.5 分那句该保住');
  });
});

describe('T-07 结果必须可重跑', () => {
  test('同样的输入跑两次，结果一字不差', () => {
    const build = () => inputs([
      pick('S-001', '一。', [cand('/a.mp4', 9), cand('/b.mp4', 9)]),
      pick('S-002', '二。', [cand('/b.mp4', 9), cand('/a.mp4', 9)]),
      pick('S-003', '三。', []),
    ]);
    assert.deepEqual(assignShots(build()), assignShots(build()));
  });

  test('候选顺序不同但内容相同时，结果也相同', () => {
    const a = assignShots(inputs([pick('S-001', '一。', [cand('/x.mp4', 9), cand('/y.mp4', 9)])]));
    const b = assignShots(inputs([pick('S-001', '一。', [cand('/y.mp4', 9), cand('/x.mp4', 9)])]));
    assert.deepEqual(a.shots, b.shots, '同分时要有稳定的排序依据，不能看谁先来');
  });

  test('一句话都没有时返回空，不报错', () => {
    const got = assignShots({ sentences: [], candidates: [] });
    assert.deepEqual(got.shots, []);
    assert.deepEqual(got.missing, []);
    assert.deepEqual(got.usage, []);
  });
});

describe('T-07 真实素材教的两件事', () => {
  test('降权绝不把明显更相关的挤掉——只在差不多相关的候选之间换花样', () => {
    // 这一组数字来自真实素材：海浪那段 9 分，一段完全不相关的 4.7 分。
    // 海浪被用过一次之后，如果降权照样生效，就会挑那段 4.7 分的。
    const got = assignShots(inputs([
      pick('S-001', '先看海。', [cand('/ocean.mp4', 9), cand('/random.mp4', 4.7)]),
      pick('S-002', '再去看看海。', [cand('/ocean.mp4', 9), cand('/random.mp4', 4.7)]),
    ]));
    assert.deepEqual(got.shots.map((s) => s.clipPath), ['/ocean.mp4', '/ocean.mp4'],
      '宁可重复用对的那段，也不能配一段不相关的');
  });

  test('分数接近的候选之间照样换花样', () => {
    const got = assignShots(inputs([
      pick('S-001', '一。', [cand('/a.mp4', 9), cand('/b.mp4', 8.5)]),
      pick('S-002', '二。', [cand('/a.mp4', 9), cand('/b.mp4', 8.5)]),
    ]));
    assert.equal(new Set(got.shots.map((s) => s.clipPath)).size, 2,
      '8.5 和 9 差不多相关，该换一段');
  });

  test('多句都用把握不高的素材时，只提醒一条，不是每句一条', () => {
    const got = assignShots(inputs([
      pick('S-001', '一。', [cand('/a.mp4', 9, { confidence: 'low' })]),
      pick('S-002', '二。', [cand('/b.mp4', 9, { confidence: 'low' })]),
      pick('S-003', '三。', [cand('/c.mp4', 9, { confidence: 'low' })]),
    ]));
    const lowNotes = got.notes.filter((n) => n.message.includes('把握不高'));
    assert.equal(lowNotes.length, 1, `该只有一条，实际 ${lowNotes.length} 条`);
    assert.equal(lowNotes[0].count, 3);
    assert.ok(lowNotes[0].message.includes('全部 3 句'), lowNotes[0].message);
  });

  test('只有一部分句子把握不高时，提醒里点出是哪几句', () => {
    const got = assignShots(inputs([
      pick('S-001', '一。', [cand('/a.mp4', 9, { confidence: 'low' })]),
      pick('S-002', '二。', [cand('/b.mp4', 9)]),
    ]));
    const note = got.notes.find((n) => n.message.includes('把握不高'));
    assert.ok(note.message.includes('S-001'), note.message);
    assert.ok(!note.message.includes('全部'), '不是全部就别说全部');
  });
});

describe('T-07 缺素材的理由要分清「太短」和「不相关」', () => {
  /** 带 dropped 的候选结果：那些是第 1 层按长度排除掉的。 */
  const pickWithDropped = (id, text, candidates, droppedCount, needSeconds = 6) => ({
    sentence: { id, text },
    result: {
      sentenceId: id,
      needSeconds,
      candidates,
      dropped: Array.from({ length: droppedCount }, (_, i) => ({ clipPath: `/short${i}.mp4`, layer: 1, why: '盖不住' })),
      layersUsed: [1, 2],
    },
  });

  test('一个候选都没有、而且有素材因为太短被排除时，说的是长度问题', () => {
    const got = assignShots(inputs([pickWithDropped('S-001', '一句很长的话。', [], 5)]));
    const m = got.missing[0];
    assert.equal(m.kind, 'too-short');
    assert.equal(m.droppedForLength, 5);
    assert.ok(m.reason.includes('5 段'), m.reason);
    assert.ok(m.reason.includes('改短'), '要告诉用户能怎么办');
  });

  test('有够长的素材但都不相关时，说的是相关性问题', () => {
    const got = assignShots(inputs([
      pickWithDropped('S-001', '一。', [cand('/a.mp4', 0)], 0),
      pickWithDropped('S-002', '二。', [cand('/b.mp4', 9)], 0),
    ]));
    const m = got.missing.find((x) => x.sentenceId === 'S-001');
    assert.equal(m.kind, 'not-relevant');
    assert.ok(m.reason.includes('对得上'), m.reason);
  });

  test('两个原因同时存在时，两件事都说出来', () => {
    const got = assignShots(inputs([
      pickWithDropped('S-001', '一。', [cand('/a.mp4', 1)], 4),
      pickWithDropped('S-002', '二。', [cand('/b.mp4', 12)], 0),
    ]));
    const m = got.missing.find((x) => x.sentenceId === 'S-001');
    assert.equal(m.kind, 'not-relevant');
    assert.ok(m.reason.includes('够相关'), m.reason);
    assert.ok(m.reason.includes('4 段素材长度盖不住'), '长度那一半也要说：' + m.reason);
  });

  test('理由里带上这句话大概多少秒，用户才知道要改多短', () => {
    const got = assignShots(inputs([pickWithDropped('S-001', '一句很长的话。', [], 3, 6.3)]));
    assert.ok(got.missing[0].reason.includes('6.3 秒'), got.missing[0].reason);
  });
});
