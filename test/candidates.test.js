// T-06 的测试。契约：docs/crew/api/assetsindex-shotplan.md 版本 11（调用侧）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { estimateSpeechSeconds, termWeights, pickCandidates } from '../src/shotplan/candidates.js';

/** 造一条 clip 描述记录的桩。契约测试要求跑在手写桩上，不准调真的 assets-index。 */
function clip(clipPath, { durationSec = 60, segments = [], description = '', tags = [], notes = '' } = {}) {
  return {
    clipPath,
    schema: 'dsh-narrate/clip@1',
    clip: clipPath.split('/').pop(),
    measured: { shape: 2, durationSec },
    fromYou: { description, tags, notes, segments: [], sources: [] },
    fromMachine: { segments, engine: 'stub', visualSearchDir: '' },
  };
}
const seg = (startSec, endSec, description, { tags = [], confidence = 'high' } = {}) =>
  ({ startSec, endSec, description, tags, confidence });

describe('T-06 第 1 层：旁白多长是估出来的', () => {
  test('句子越长，估出来越长', () => {
    const short = estimateSpeechSeconds('很短。');
    const long = estimateSpeechSeconds('这是一句明显长得多的话，里面有更多的字要念出来。');
    assert.ok(long > short * 2, `长句 ${long} 秒该明显大于短句 ${short} 秒`);
  });

  test('估算偏保守：宁可估长，因为估短了要到渲染才发现', () => {
    // 中文正常朗读大约每秒 4 到 5 个字。保守就是**低于**这个速度。
    const text = '一'.repeat(45);
    const seconds = estimateSpeechSeconds(text);
    assert.ok(seconds >= 45 / 4.5, `45 个字估 ${seconds} 秒，比正常语速还快，那就是估短了`);
    assert.ok(seconds <= 45 / 2, `45 个字估 ${seconds} 秒，估得太夸张了也没用`);
  });

  test('标点算一次停顿', () => {
    const withPause = estimateSpeechSeconds('前半句，后半句。');
    const without = estimateSpeechSeconds('前半句后半句');
    assert.ok(withPause > without, '有标点该估得更长');
  });

  test('英文按词算，不按字母算；语速看字符类别，不用告诉它语言', () => {
    const seconds = estimateSpeechSeconds('This is a short English sentence.');
    assert.ok(seconds > 1 && seconds < 8, `六个词估了 ${seconds} 秒，不合理`);
  });

  test('空句子估 0 秒，不报错', () => {
    assert.equal(estimateSpeechSeconds(''), 0);
    assert.equal(estimateSpeechSeconds('   '), 0);
  });

  test('A-24：描述覆盖的时间窗盖不住估算长度的候选，第 1 层就排除', async () => {
    const need = estimateSpeechSeconds('这句话需要大概四五秒才能念完，不算短。');
    const clips = [
      // 窗口够长
      clip('/a.mp4', { durationSec: 60, segments: [seg(0, 30, '机房走廊')] }),
      // 素材很长，但这一段描述只覆盖 1 秒——盖不住
      clip('/b.mp4', { durationSec: 60, segments: [seg(0, 1, '机房走廊')] }),
    ];
    const got = await pickCandidates({ sentence: { id: 'S-001', text: '这句话需要大概四五秒才能念完，不算短。' }, clips });
    assert.ok(got.needSeconds >= need - 0.01);
    assert.deepEqual(got.candidates.map((c) => c.clipPath), ['/a.mp4']);
    const dropped = got.dropped.find((d) => d.clipPath === '/b.mp4');
    assert.ok(dropped, 'b 该出现在 dropped 里，并说明原因');
    assert.equal(dropped.layer, 1);
    assert.ok(dropped.why.includes('盖不住'), `原因要说清楚：${dropped.why}`);
  });

  test('一个候选都没有时返回空，不报错', async () => {
    const got = await pickCandidates({ sentence: { id: 'S-001', text: '一句很长的话' }, clips: [] });
    assert.deepEqual(got.candidates, []);
    assert.deepEqual(got.dropped, []);
  });
});

describe('T-06 第 2 层：文字重叠，标签按稀有度加权', () => {
  test('每段素材都有的标签几乎不加分，比只有一段有的低得多', () => {
    const clips = [
      clip('/a.mp4', { tags: ['Fair Use', '机房'] }),
      clip('/b.mp4', { tags: ['Fair Use', '街景'] }),
      clip('/c.mp4', { tags: ['Fair Use', '海边'] }),
    ];
    const weights = termWeights(clips);
    // 这里断言的是**倍数**，不是绝对值。权重故意不会到 0：到 0 的话，只有一段素材的
    // 文件夹里每个词都是 0 分，每一句都算没配上。素材越多，样板词越接近 0。
    const boiler = weights.get('fair use') ?? 0;
    const rare = weights.get('机房') ?? 0;
    assert.ok(rare > boiler * 5,
      `只有一段有的标签该重得多：机房 ${rare} 对 fair use ${boiler}`);
    assert.ok(weights.get('机房') > 0.5, `只有一段有的标签该值钱，实际 ${weights.get('机房')}`);
  });

  test('稀有的词让相关的素材排前面', async () => {
    const clips = [
      clip('/rack.mp4', { durationSec: 60, tags: ['Fair Use', '机房'], segments: [seg(0, 30, '服务器机柜特写')] }),
      clip('/street.mp4', { durationSec: 60, tags: ['Fair Use', '街景'], segments: [seg(0, 30, '夜里的商业街')] }),
    ];
    const got = await pickCandidates({ sentence: { id: 'S-001', text: '先看一眼机房里的服务器机柜。' }, clips });
    assert.equal(got.candidates[0].clipPath, '/rack.mp4', `排序不对：${got.candidates.map((c) => c.clipPath)}`);
    assert.ok(got.candidates[0].score > 0);
  });

  test('中文靠字符二元组匹配，不靠分词', async () => {
    // 「服务器」这个词在句子和描述里都出现，即使没有分词器也该匹配上
    const clips = [
      clip('/a.mp4', { durationSec: 60, segments: [seg(0, 30, '一排服务器在机柜里')] }),
      clip('/b.mp4', { durationSec: 60, segments: [seg(0, 30, '海浪拍在礁石上')] }),
    ];
    const got = await pickCandidates({ sentence: { id: 'S-001', text: '服务器是怎么放的。' }, clips });
    assert.equal(got.candidates[0].clipPath, '/a.mp4');
  });

  test('notes 也算证据，因为那是你特意写的', async () => {
    const clips = [
      clip('/a.mp4', { durationSec: 60, notes: '这段是深圳的机房，客户不让露编号', segments: [seg(0, 30, '一片模糊')] }),
      clip('/b.mp4', { durationSec: 60, segments: [seg(0, 30, '一片模糊')] }),
    ];
    const got = await pickCandidates({ sentence: { id: 'S-001', text: '深圳的机房长这样。' }, clips });
    assert.equal(got.candidates[0].clipPath, '/a.mp4');
  });

  test('完全不相关的素材分数为 0，但仍然是候选（留给分配那一步决定）', async () => {
    const clips = [clip('/a.mp4', { durationSec: 60, segments: [seg(0, 30, '海浪拍在礁石上')] })];
    const got = await pickCandidates({ sentence: { id: 'S-001', text: '编译器怎么做优化。' }, clips });
    assert.equal(got.candidates.length, 1);
    assert.equal(got.candidates[0].score, 0);
  });

  test('把握不高的时间段，只在没有把握高的可用时才用，而且标出来', async () => {
    const clips = [
      clip('/low.mp4', { durationSec: 60, segments: [seg(0, 30, '机房走廊', { confidence: 'low' })] }),
      clip('/high.mp4', { durationSec: 60, segments: [seg(0, 30, '机房走廊', { confidence: 'high' })] }),
    ];
    const both = await pickCandidates({ sentence: { id: 'S-001', text: '机房走廊。' }, clips });
    assert.equal(both.candidates[0].confidence, 'high', '有 high 就该先用 high');

    const onlyLow = await pickCandidates({ sentence: { id: 'S-001', text: '机房走廊。' }, clips: [clips[0]] });
    assert.equal(onlyLow.candidates.length, 1);
    assert.equal(onlyLow.candidates[0].confidence, 'low');
    assert.ok(onlyLow.candidates[0].why.includes('把握不高'), '用了弱证据要说出来');
  });

  test('limit 限制返回多少个候选', async () => {
    const clips = Array.from({ length: 8 }, (_, i) =>
      clip(`/c${i}.mp4`, { durationSec: 60, segments: [seg(0, 30, '机房走廊')] }));
    const got = await pickCandidates({ sentence: { id: 'S-001', text: '机房走廊。' }, clips, limit: 3 });
    assert.equal(got.candidates.length, 3);
  });
});

describe('T-06 第 3 层：画面搜索，可选', () => {
  const clipsWithDir = () => [{
    ...clip('/a.mp4', { durationSec: 60, segments: [seg(0, 50, '机房')] }),
    fromMachine: { segments: [seg(0, 50, '机房')], engine: 'stub', visualSearchDir: '/cache/a_avis' },
  }];

  test('A-26：agent 给了英文查询就用画面搜索，把起点定到搜出来的秒数', async () => {
    const asked = [];
    const visualSearch = async (input) => {
      asked.push(input);
      return [{ timestamp: 21.5, score: 0.42 }];
    };
    const got = await pickCandidates({
      sentence: { id: 'S-001', text: '看一眼机房。', englishQuery: 'a server room, blue light' },
      clips: clipsWithDir(),
      visualSearch,
    });
    assert.equal(asked.length, 1, '该调一次画面搜索');
    assert.equal(asked[0].query, 'a server room, blue light', '用的必须是英文查询');
    assert.equal(asked[0].visualSearchDir, '/cache/a_avis');
    assert.equal(got.candidates[0].startSec, 21.5, '起点该被定到搜出来的那一秒');
    assert.equal(got.candidates[0].layer, 3);
    assert.ok(got.layersUsed.includes(3));
  });

  test('A-25：没给 visualSearch 就退回前两层，不报错', async () => {
    const got = await pickCandidates({
      sentence: { id: 'S-001', text: '看一眼机房。', englishQuery: 'a server room' },
      clips: clipsWithDir(),
    });
    assert.ok(got.candidates.length > 0);
    assert.equal(got.candidates[0].layer, 2);
    assert.ok(!got.layersUsed.includes(3));
  });

  test('agent 没给英文查询也退回，不报错', async () => {
    let called = 0;
    const got = await pickCandidates({
      sentence: { id: 'S-001', text: '看一眼机房。' },
      clips: clipsWithDir(),
      visualSearch: async () => { called += 1; return []; },
    });
    assert.equal(called, 0, '没有英文查询就不该调画面搜索');
    assert.ok(got.candidates.length > 0);
  });

  test('visualSearchDir 是空的就跳过这一层，不报错', async () => {
    let called = 0;
    const got = await pickCandidates({
      sentence: { id: 'S-001', text: '看一眼机房。', englishQuery: 'a server room' },
      clips: [clip('/a.mp4', { durationSec: 60, segments: [seg(0, 50, '机房')] })], // visualSearchDir 是 ''
      visualSearch: async () => { called += 1; return []; },
    });
    assert.equal(called, 0);
    assert.ok(got.candidates.length > 0);
  });

  test('画面搜索自己坏了也退回前两层，不让整句失败', async () => {
    const got = await pickCandidates({
      sentence: { id: 'S-001', text: '看一眼机房。', englishQuery: 'a server room' },
      clips: clipsWithDir(),
      visualSearch: async () => { throw new Error('venv 没装'); },
    });
    assert.ok(got.candidates.length > 0, '画面搜索坏了不该让这一句没有候选');
    assert.equal(got.candidates[0].layer, 2);
  });

  test('画面搜出来的时间点如果盖不住旁白，仍然要被第 1 层的规则挡住', async () => {
    const got = await pickCandidates({
      sentence: { id: 'S-001', text: '这句话要念上好一会儿，大概五六秒。', englishQuery: 'a server room' },
      clips: clipsWithDir(), // 描述覆盖 0 到 50 秒
      visualSearch: async () => [{ timestamp: 49.5, score: 0.9 }], // 只剩 0.5 秒
    });
    assert.ok(got.candidates.every((c) => c.startSec !== 49.5),
      `49.5 秒起只剩 0.5 秒，盖不住，不该当候选：${JSON.stringify(got.candidates)}`);
  });
});

describe('T-06 评审补的测试', () => {
  test('中英混排的句子按混排估时长，不用告诉它语言', () => {
    const mixed = estimateSpeechSeconds('这个 API 的设计有问题。');
    const cjkOnly = estimateSpeechSeconds('这个接口的设计有问题。');
    assert.ok(mixed > 0 && cjkOnly > 0);
    // API 是一个拉丁词，比三个中日韩字便宜，所以混排的略短
    assert.ok(Math.abs(mixed - cjkOnly) < 1, `混排 ${mixed} 和纯中文 ${cjkOnly} 不该差太多`);
  });

  test('素材级的文字分只算一次，多个时间段不会重复累加', async () => {
    const many = clip('/a.mp4', {
      durationSec: 90,
      tags: ['机房'],
      segments: [seg(0, 30, ''), seg(30, 60, ''), seg(60, 90, '')],
    });
    const one = clip('/b.mp4', { durationSec: 90, tags: ['机房'], segments: [seg(0, 30, '')] });
    const got = await pickCandidates({ sentence: { id: 'S-001', text: '机房。' }, clips: [many, one] });
    const scores = new Set(got.candidates.map((c) => c.score));
    assert.equal(scores.size, 1,
      `同样的标签证据，三个时间段和一个时间段的分应该一样，实际有 ${scores.size} 种：${[...scores]}`);
  });

  test('agent 给的英文查询也参与第 2 层的匹配（跨语言只能靠它）', async () => {
    const clips = [
      clip('/ocean.mp4', { durationSec: 60, description: 'Sunset Waves Wide Shot', tags: ['ocean'], segments: [seg(0, 30, '')] }),
      clip('/city.mp4', { durationSec: 60, description: 'Nyc Traffic Time Lapse', tags: ['traffic'], segments: [seg(0, 30, '')] }),
    ];
    const zhOnly = await pickCandidates({ sentence: { id: 'S-001', text: '海浪拍上来。' }, clips });
    assert.equal(zhOnly.candidates.every((c) => c.score === 0), true,
      '纯中文对英文元数据本来就该 0 分，这是字符二元组的上限');

    const withEnglish = await pickCandidates({
      sentence: { id: 'S-001', text: '海浪拍上来。', englishQuery: 'ocean waves at sunset' },
      clips,
    });
    assert.equal(withEnglish.candidates[0].clipPath, '/ocean.mp4');
    assert.ok(withEnglish.candidates[0].score > 0, '给了英文查询就该有分');
  });
});

describe('T-06 稀有度权重永远不为零', () => {
  const clip = (name, description, tags) => ({
    clipPath: `/${name}.mp4`,
    fromYou: { description, tags },
    fromMachine: { segments: [{ startSec: 0, endSec: 30, description, tags, confidence: 'high' }] },
    measured: { durationSec: 30 },
  });

  test('只有一段素材时也能配上——权重不能是 0', async () => {
    // 真实场景：用户先放一两段素材试试。`log(N/df)` 在 N=df 时正好是 0，
    // 于是每一句都算"没配上"，插件看起来完全不工作。
    const clips = [clip('sky', '蓝天上白云慢慢飘', ['天空', '云'])];
    const weights = termWeights(clips);
    for (const [term, w] of weights) {
      assert.ok(w > 0, `词「${term}」的权重是 ${w}，不能是 0`);
    }
    const got = await pickCandidates({ sentence: { id: 'S-001', text: '云在天上飘。' }, clips });
    assert.ok(got.candidates.length > 0, '该有候选');
    assert.ok(got.candidates[0].score > 0, `分数该大于 0，实际 ${got.candidates[0].score}`);
  });

  test('两段素材都有的词也不是 0，但比只有一段有的词低得多', () => {
    const clips = [
      clip('a', '森林里的雾', ['fair use', '森林']),
      clip('b', '城市的车流', ['fair use', '车流']),
    ];
    const weights = termWeights(clips);
    const boiler = weights.get('fair use');
    const rare = weights.get('森林');
    assert.ok(boiler > 0, `每段都有的词也不能是 0，实际 ${boiler}`);
    assert.ok(rare > boiler * 3, `稀有词该明显更重：森林 ${rare} 对 fair use ${boiler}`);
  });

  test('素材多起来之后，样板词的权重接近 0', () => {
    const clips = Array.from({ length: 36 }, (_, i) =>
      clip(`c${i}`, `第 ${i} 段`, ['fair use', 'hd', i === 3 ? 'fire' : `t${i}`]));
    const weights = termWeights(clips);
    assert.ok(weights.get('fair use') < 0.1, `36 段都有的词该接近 0，实际 ${weights.get('fair use')}`);
    assert.ok(weights.get('fire') > 2.5, `只有一段有的词该很重，实际 ${weights.get('fire')}`);
  });
});
