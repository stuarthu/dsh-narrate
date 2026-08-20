// T-06 的 QA 用例 1 到 9。跑法：node docs/crew/qa/T-06/case-1-9.mjs
// 计划见 docs/crew/qa/T-06-plan.md
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const { estimateSpeechSeconds, termWeights, pickCandidates } =
  await import(join(ROOT, 'src/shotplan/candidates.js'));

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  通过    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  失败    ${name}\n          ${error.message}`);
  }
};

const clip = (clipPath, { durationSec = 60, segments = [], description = '', tags = [], notes = '' } = {}) => ({
  clipPath,
  measured: { shape: 2, durationSec },
  fromYou: { description, tags, notes, segments: [], sources: [] },
  fromMachine: { segments, engine: 'stub', visualSearchDir: '' },
});
const seg = (startSec, endSec, description, confidence = 'high') =>
  ({ startSec, endSec, description, tags: [], confidence });
const withDir = (record, dir) => ({ ...record, fromMachine: { ...record.fromMachine, visualSearchDir: dir } });

console.log('用例 1：时长盖不住的候选，第 1 层就排除');
const long = '这句话需要大概四五秒才能念完，不算短。';
await check('只有窗口够长的那段是候选，短的进 dropped 并说明原因', async () => {
  const got = await pickCandidates({
    sentence: { id: 'S-001', text: long },
    clips: [clip('/ok.mp4', { segments: [seg(0, 30, '机房走廊')] }),
      clip('/short.mp4', { segments: [seg(0, 1, '机房走廊')] })],
  });
  assert.deepEqual(got.candidates.map((c) => c.clipPath), ['/ok.mp4']);
  const dropped = got.dropped.find((d) => d.clipPath === '/short.mp4');
  assert.ok(dropped && dropped.layer === 1 && dropped.why.includes('盖不住'), JSON.stringify(dropped));
  assert.ok(got.needSeconds >= estimateSpeechSeconds(long) - 0.01);
});

console.log('用例 2：标签按稀有度加权');
await check('每段都有的标签几乎不加分，独有的明显更重', () => {
  const weights = termWeights([
    clip('/a.mp4', { tags: ['Fair Use', '机房'] }),
    clip('/b.mp4', { tags: ['Fair Use', '街景'] }),
    clip('/c.mp4', { tags: ['Fair Use', '海边'] }),
  ]);
  // 判的是倍数，不是绝对值。权重故意永远不到 0——到 0 的话，只放了一段素材的
  // 文件夹里每个词都是 0 分，每一句都算没配上。素材越多，样板词越接近 0。
  const boiler = weights.get('fair use') ?? 0;
  assert.ok(weights.get('机房') > boiler * 5, `机房 = ${weights.get('机房')}，fair use = ${boiler}`);
  assert.ok(weights.get('机房') > 0.5, `机房 = ${weights.get('机房')}`);
});

await check('只有一段素材时，权重也不是 0（不然一句都配不上）', () => {
  const weights = termWeights([clip('/only.mp4', { tags: ['天空', '云'] })]);
  for (const [term, w] of weights) assert.ok(w > 0, `词「${term}」权重是 ${w}`);
});

console.log('用例 3：稀有词让相关的排前面');
await check('相关的那段排第一', async () => {
  const got = await pickCandidates({
    sentence: { id: 'S-001', text: '先看一眼机房里的服务器机柜。' },
    clips: [clip('/rack.mp4', { tags: ['Fair Use', '机房'], segments: [seg(0, 30, '服务器机柜特写')] }),
      clip('/street.mp4', { tags: ['Fair Use', '街景'], segments: [seg(0, 30, '夜里的商业街')] })],
  });
  assert.equal(got.candidates[0].clipPath, '/rack.mp4');
});

console.log('用例 4 到 6：第 3 层缺任何一样都要退回，不报错');
const dirClips = () => [withDir(clip('/a.mp4', { segments: [seg(0, 50, '机房')] }), '/cache/a_avis')];
await check('没给 visualSearch 就退回第 2 层', async () => {
  const got = await pickCandidates({
    sentence: { id: 'S-001', text: '看一眼机房。', englishQuery: 'a server room' },
    clips: dirClips(),
  });
  assert.ok(got.candidates.length > 0 && got.candidates[0].layer === 2);
});
await check('visualSearchDir 是空的就一次都不调', async () => {
  let called = 0;
  const got = await pickCandidates({
    sentence: { id: 'S-001', text: '看一眼机房。', englishQuery: 'a server room' },
    clips: [clip('/a.mp4', { segments: [seg(0, 50, '机房')] })],
    visualSearch: async () => { called += 1; return []; },
  });
  assert.equal(called, 0);
  assert.ok(got.candidates.length > 0);
});
await check('visualSearch 抛异常也退回，这一句仍有候选', async () => {
  const got = await pickCandidates({
    sentence: { id: 'S-001', text: '看一眼机房。', englishQuery: 'a server room' },
    clips: dirClips(),
    visualSearch: async () => { throw new Error('venv 没装'); },
  });
  assert.ok(got.candidates.length > 0 && got.candidates[0].layer === 2);
});

console.log('用例 7 和 8：画面搜索');
await check('起点被定到搜出来的秒数，layer 是 3', async () => {
  const asked = [];
  const got = await pickCandidates({
    sentence: { id: 'S-001', text: '看一眼机房。', englishQuery: 'a server room, blue light' },
    clips: dirClips(),
    visualSearch: async (input) => { asked.push(input); return [{ timestamp: 21.5, score: 0.42 }]; },
  });
  assert.equal(asked[0].query, 'a server room, blue light');
  assert.equal(got.candidates[0].startSec, 21.5);
  assert.equal(got.candidates[0].layer, 3);
});
await check('搜出来的时间点盖不住旁白时不被采用', async () => {
  const got = await pickCandidates({
    sentence: { id: 'S-001', text: '这句话要念上好一会儿，大概五六秒。', englishQuery: 'a server room' },
    clips: dirClips(),
    visualSearch: async () => [{ timestamp: 49.5, score: 0.9 }],
  });
  assert.ok(got.candidates.every((c) => c.startSec !== 49.5));
});

console.log('用例 9：跨语言只能靠 agent 给的英文查询');
const crossClips = () => [
  clip('/ocean.mp4', { description: 'Sunset Waves Wide Shot', tags: ['ocean'], segments: [seg(0, 30, '')] }),
  clip('/city.mp4', { description: 'Nyc Traffic Time Lapse', tags: ['traffic'], segments: [seg(0, 30, '')] }),
];
await check('纯中文对英文元数据全是 0 分（字符二元组的上限）', async () => {
  const got = await pickCandidates({ sentence: { id: 'S-001', text: '海浪拍上来。' }, clips: crossClips() });
  assert.ok(got.candidates.every((c) => c.score === 0));
});
await check('给了英文查询，相关的那段有分并排第一', async () => {
  const got = await pickCandidates({
    sentence: { id: 'S-001', text: '海浪拍上来。', englishQuery: 'ocean waves at sunset' },
    clips: crossClips(),
  });
  assert.equal(got.candidates[0].clipPath, '/ocean.mp4');
  assert.ok(got.candidates[0].score > 0);
});

console.log('');
console.log(failures === 0 ? 'T-06 QA：全部通过' : `T-06 QA：${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
