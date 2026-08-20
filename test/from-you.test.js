// T-03 的测试。契约：docs/crew/api/assetsindex-shotplan.md 版本 4
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectFromYou, loadCsvRows, PRIORITY } from '../src/assets-index/from-you.js';
import { writeYourSection, readClipFile } from '../src/assets-index/clip-file.js';

const tmp = () => mkdtemp(join(tmpdir(), 'narrate-you-'));

/** 造一个素材文件夹，返回 root 和 clip 的绝对路径。 */
async function scene(relClip, files = {}) {
  const root = await tmp();
  const clip = join(root, relClip);
  await mkdir(join(clip, '..'), { recursive: true });
  await writeFile(clip, 'v'.repeat(32), 'utf8');
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, body, 'utf8');
  }
  return { root, clip };
}

const collect = ({ root, clip }, chat) => collectFromYou({ clipPath: clip, assetsRoot: root, chat });

describe('T-03 六个来源各自能读到', () => {
  test('文件夹名变成标签，root 之上的文件夹不算', async () => {
    const s = await scene('机房/网络/bench.mp4');
    const got = await collect(s);
    // 文件名读取器也会贡献 bench，这是契约规定的行为
    assert.deepEqual(got.tags.sort(), ['机房', '网络', 'bench'].sort());
    assert.ok(!got.tags.some((t) => t.includes('narrate-you')), 'root 之上的临时目录名不该变成标签');
    assert.ok(got.sources.some((x) => x.startsWith('folder:')));
  });

  test('文件名按连字符、下划线、空格切成标签', async () => {
    const s = await scene('服务器机柜-特写_夜景 蓝光.mp4');
    const got = await collect(s);
    assert.deepEqual(got.tags.sort(), ['夜景', '特写', '蓝光', '服务器机柜'].sort());
  });

  test('文件名里的纯数字不当标签', async () => {
    const s = await scene('bench-001-4k.mp4');
    const got = await collect(s);
    assert.ok(!got.tags.includes('001'), `纯数字不该当标签：${got.tags}`);
    assert.ok(got.tags.includes('bench'));
  });

  test('同名文本：第一行描述，# 开头是标签，其余进 notes', async () => {
    const s = await scene('bench.mp4', {
      'bench.mp4.narrate.txt': '深圳某机房，我自己拍的\n#机房 #服务器\n版权干净，可以放心用\n客户不让露机柜编号\n',
    });
    const got = await collect(s);
    assert.equal(got.description, '深圳某机房，我自己拍的');
    assert.ok(got.tags.includes('机房') && got.tags.includes('服务器'));
    assert.equal(got.notes, '版权干净，可以放心用\n客户不让露机柜编号');
    assert.ok(got.sources.includes('sidecar:bench.mp4.narrate.txt'));
  });

  test('表格 clips.csv：按文件名匹配，标签用分号隔开', async () => {
    const s = await scene('bench.mp4', {
      'clips.csv': '文件名,描述,标签\nother.mp4,别的素材,别的\nbench.mp4,表格里写的描述,机房;服务器;特写\n',
    });
    const got = await collect(s);
    assert.equal(got.description, '表格里写的描述');
    assert.deepEqual(got.tags.sort(), ['机房', '服务器', '特写', 'bench'].sort());
    assert.ok(got.sources.includes('csv:clips.csv'));
  });

  test('表格里带引号的字段可以含逗号', async () => {
    const s = await scene('bench.mp4', {
      'clips.csv': '文件名,描述,标签\nbench.mp4,"机房，很暗，蓝光",机房\n',
    });
    const got = await collect(s);
    assert.equal(got.description, '机房，很暗，蓝光');
  });

  test('跟插件说的内容也进来', async () => {
    const s = await scene('bench.mp4');
    const got = await collect(s, { description: '这段是深圳拍的', tags: ['深圳'], notes: '版权干净', date: '2026-08-20' });
    assert.equal(got.description, '这段是深圳拍的');
    assert.equal(got.notes, '版权干净');
    assert.ok(got.sources.includes('chat:2026-08-20'));
  });

  test('什么来源都没有时，返回空的一节，不报错', async () => {
    const s = await scene('a.mp4');
    const got = await collect(s);
    assert.equal(got.description, '');
    assert.equal(got.notes, '');
    assert.deepEqual(got.segments, []);
    assert.deepEqual(got.tags, ['a']);
  });
});

describe('T-03 优先级和合并', () => {
  test('优先级顺序写死在模块里，越明确数字越小', () => {
    assert.deepEqual(PRIORITY, { chat: 1, manual: 2, sidecar: 3, csv: 4, clipjson: 5, filename: 6, folder: 7 });
  });

  test('同名文本的描述赢过表格的描述', async () => {
    const s = await scene('bench.mp4', {
      'bench.mp4.narrate.txt': '同名文本写的\n',
      'clips.csv': '文件名,描述,标签\nbench.mp4,表格写的,机房\n',
    });
    const got = await collect(s);
    assert.equal(got.description, '同名文本写的');
  });

  test('跟插件说的赢过所有文件里的', async () => {
    const s = await scene('机房/bench.mp4', {
      'bench.mp4.narrate.txt': '同名文本写的\n',
      'clips.csv': '文件名,描述,标签\nbench.mp4,表格写的,csv标签\n',
    });
    const got = await collect(s, { description: '对话里说的', date: '2026-08-20' });
    assert.equal(got.description, '对话里说的');
  });

  test('标签是所有来源取并集去重，描述是取优先级最高的', async () => {
    const s = await scene('机房/服务器-特写.mp4', {
      '机房/服务器-特写.mp4.narrate.txt': '同名文本写的\n#夜景 #机房\n',
      'clips.csv': '文件名,描述,标签\n服务器-特写.mp4,表格写的,蓝光;机房\n',
    });
    const got = await collect(s, { tags: ['深圳'] });
    assert.equal(got.description, '同名文本写的');
    assert.deepEqual(got.tags.sort(), ['夜景', '机房', '深圳', '特写', '服务器', '蓝光'].sort());
    assert.equal(got.tags.length, new Set(got.tags).size, '标签有重复');
  });

  test('notes 一字不动，插件不去解析它', async () => {
    const nasty = '别用在商单里；{这不是标签} #也不是标签\n第二行也要留着';
    const s = await scene('bench.mp4', { 'bench.mp4.narrate.txt': `描述\n${nasty}\n` });
    const got = await collect(s);
    assert.equal(got.notes, nasty);
  });

  test('同一个来源内部冲突时报 E_SOURCE_CONFLICT', async () => {
    const s = await scene('bench.mp4', {
      'clips.csv': '文件名,描述,标签\nbench.mp4,第一行说的,a\nbench.mp4,第二行说的,b\n',
    });
    await assert.rejects(
      () => collect(s),
      (e) => e.code === 'E_SOURCE_CONFLICT' && e.message.includes('第一行说的') && e.message.includes('第二行说的'),
    );
  });
});

describe('T-03 可重跑，而且手改不会丢', () => {
  test('输入源一字没改，连跑两次结果完全相同', async () => {
    const s = await scene('机房/bench.mp4', {
      '机房/bench.mp4.narrate.txt': '深圳机房\n#机房\n备注一行\n',
      'clips.csv': '文件名,描述,标签\nbench.mp4,表格写的,蓝光\n',
    });
    const first = await collect(s, { tags: ['深圳'] });
    await writeYourSection(s.clip, first);
    const second = await collect(s, { tags: ['深圳'] });
    assert.deepEqual(second, first, '两次结果不一样，不是可重跑的');
  });

  test('你手改 bench.json 的描述，重跑之后还在，并被标成 manual', async () => {
    const s = await scene('bench.mp4', { 'bench.mp4.narrate.txt': '同名文本写的\n' });
    await writeYourSection(s.clip, await collect(s));
    // 你打开 bench.json 手改了描述
    const rec = await readClipFile(s.clip);
    await writeYourSection(s.clip, { ...rec.fromYou, description: '我自己改的这一句' });

    const got = await collect(s);
    assert.equal(got.description, '我自己改的这一句', '手改的描述被推导值盖掉了');
    assert.ok(got.sources.includes('manual'), `应该标成 manual：${got.sources}`);

    // 再跑一次还是一样（手改标记本身也要可重跑）
    await writeYourSection(s.clip, got);
    assert.deepEqual(await collect(s), got);
  });

  test('手改的标签也保住，推导不出来的标签算你加的', async () => {
    const s = await scene('bench.mp4', { 'bench.mp4.narrate.txt': '描述\n#机房\n' });
    await writeYourSection(s.clip, await collect(s));
    const rec = await readClipFile(s.clip);
    await writeYourSection(s.clip, { ...rec.fromYou, tags: [...rec.fromYou.tags, '我加的标签'] });

    const got = await collect(s);
    assert.ok(got.tags.includes('我加的标签'), `手加的标签丢了：${got.tags}`);
    assert.ok(got.tags.includes('机房'), '推导出来的标签也该在');
  });

  test('跟插件说的能盖掉手改的', async () => {
    const s = await scene('bench.mp4');
    await writeYourSection(s.clip, { description: '手改的' , tags: [], notes: '', segments: [], sources: ['manual'] });
    const got = await collect(s, { description: '后来跟你说的', date: '2026-08-21' });
    assert.equal(got.description, '后来跟你说的');
  });

  test('你自己写的时间段在重跑后保住', async () => {
    const s = await scene('bench.mp4', { 'bench.mp4.narrate.txt': '描述\n' });
    const mine = [{ startSec: 12.4, endSec: 31, description: '这段是我最满意的镜头' }];
    await writeYourSection(s.clip, { ...(await collect(s)), segments: mine });
    const got = await collect(s);
    assert.deepEqual(got.segments, mine, '你写的时间段被冲掉了');
  });
});

describe('T-03 评审补的测试', () => {
  test('表格可以只解析一次传进来，结果和自己读一样', async () => {
    const s = await scene('bench.mp4', {
      'clips.csv': '文件名,描述,标签\nbench.mp4,"表格，带逗号",机房;蓝光\n',
    });
    const own = await collect(s);
    const rows = await loadCsvRows(s.root);
    const shared = await collectFromYou({ clipPath: s.clip, assetsRoot: s.root, csvRows: rows });
    assert.deepEqual(shared, own, '传进来的表格和自己读的结果必须一样');
    assert.equal(shared.description, '表格，带逗号');
  });

  test('没有 clips.csv 时 loadCsvRows 返回空数组，不报错', async () => {
    const s = await scene('bench.mp4');
    assert.deepEqual(await loadCsvRows(s.root), []);
  });

  test('安全：表格第一列写路径穿越也不会让插件去读那个文件', async () => {
    const s = await scene('bench.mp4', {
      'clips.csv': '文件名,描述,标签\n../../etc/passwd,想骗你去读这个,x\n/etc/shadow,也是,y\nbench.mp4,正常的描述,机房\n',
    });
    const got = await collect(s);
    // 第一列只做字符串相等比较，从不当路径用，所以那两行根本匹配不上
    assert.equal(got.description, '正常的描述');
    assert.ok(!got.tags.includes('x') && !got.tags.includes('y'), `不该拿到别的行的标签：${got.tags}`);
  });

  test('素材在 assets 根目录之外时，不会把根目录之上的文件夹当标签', async () => {
    const s = await scene('bench.mp4');
    const got = await collectFromYou({ clipPath: s.clip, assetsRoot: join(s.root, '不存在的子目录') });
    assert.ok(!got.sources.some((x) => x.startsWith('folder:')), `不该有 folder 来源：${got.sources}`);
  });
});

describe('T-03 同名 json 里别人写的键（第七个读取器）', () => {
  test('拿 title 当描述，他们那段长 description 进 notes', async () => {
    const s = await scene('MountainFog.mp4', {
      'MountainFog.json': JSON.stringify({
        source: 'archive.org',
        title: 'Mountain Fog',
        description: 'Please visit my blog to see all of my stock video footage offered for Free use',
        search_term: 'mountain',
        tags: ['HD', '1920x1080', 'Fog'],
      }),
    });
    const got = await collect(s);
    assert.equal(got.description, 'Mountain Fog', 'title 才是在说画面的那个');
    assert.ok(got.notes.includes('Please visit my blog'), '他们的长文该进 notes 而不是丢掉');
    assert.ok(got.tags.includes('mountain'), 'search_term 是最有用的一个词，必须进标签');
    assert.ok(got.tags.includes('Fog') && got.tags.includes('HD'), '他们的标签也全都留着');
    assert.ok(got.sources.some((x) => x.startsWith('clipjson:')));
  });

  test('只有 description 没有 title 时，退回用 description', async () => {
    const s = await scene('a.mp4', {
      'a.json': JSON.stringify({ description: '一段海浪的特写', tags: ['ocean'] }),
    });
    const got = await collect(s);
    assert.equal(got.description, '一段海浪的特写');
    assert.equal(got.notes, '', '没有 title 时不该把同一段文字同时放两处');
  });

  test('你特意写的同名文本赢过下载来源的 json', async () => {
    const s = await scene('a.mp4', {
      'a.json': JSON.stringify({ title: '下载来源写的' }),
      'a.mp4.narrate.txt': '我自己写的\n',
    });
    const got = await collect(s);
    assert.equal(got.description, '我自己写的');
    assert.ok(got.sources.includes('clipjson:a.json'), '输赢不影响它出现在来源清单里');
  });

  test('同名 json 只有我们自己的键时，这个读取器不出声', async () => {
    const s = await scene('a.mp4');
    await writeYourSection(s.clip, { description: '', tags: [], notes: '', segments: [], sources: [] });
    const got = await collect(s);
    assert.ok(!got.sources.some((x) => x.startsWith('clipjson:')), `不该有 clipjson 来源：${got.sources}`);
  });
});

describe('T-03 三方合并：分清"你改的"和"我们上一版的输出"', () => {
  test('读取器改了输出，旧输出会被新推导覆盖，而且会说出来', async () => {
    const s = await scene('a.mp4', {
      'a.json': JSON.stringify({ title: '新的短标题', description: '很长的一段推广文案' }),
    });
    // 装成上一版读取器的结果：描述取了长文案，基准也记着长文案
    await writeYourSection(s.clip, {
      description: '很长的一段推广文案',
      tags: [], notes: '', segments: [], sources: ['clipjson:a.json'],
      origin: { description: 'clipjson:a.json', derived: { description: '很长的一段推广文案', notes: '', tags: [] } },
    });
    const got = await collect(s);
    assert.equal(got.description, '新的短标题', '旧输出该让位给新推导');
    assert.ok(got.replaced?.some((r) => r.field === 'description'), '覆盖了就要说出来');
    assert.ok(got.replaced[0].was.includes('推广文案'));
  });

  test('你在我们写完之后改的，和基准不一样，所以粘住', async () => {
    const s = await scene('a.mp4', { 'a.json': JSON.stringify({ title: '来源写的标题' }) });
    await writeYourSection(s.clip, {
      description: '我自己改的这一句',
      tags: [], notes: '', segments: [], sources: ['clipjson:a.json'],
      origin: { description: 'clipjson:a.json', derived: { description: '来源写的标题', notes: '', tags: [] } },
    });
    const got = await collect(s);
    assert.equal(got.description, '我自己改的这一句', '手改被冲掉了');
    assert.ok(got.sources.includes('manual'));
    assert.equal(got.replaced, undefined, '这不是覆盖，不该报');
  });

  test('老文件没有合并基准时，让新推导赢，但一定要说出来', async () => {
    const s = await scene('a.mp4', { 'a.json': JSON.stringify({ title: '来源写的标题' }) });
    // 没有 origin，就是这个机制之前写下的文件
    await writeYourSection(s.clip, {
      description: '不知道是谁写的', tags: [], notes: '', segments: [], sources: ['clipjson:a.json'],
    });
    const got = await collect(s);
    assert.equal(got.description, '来源写的标题');
    assert.ok(got.replaced?.[0].reason.includes('没有合并基准'));
  });

  test('基准里有过、现在推导不出来的标签算旧输出；从没推导过的算你加的', async () => {
    const s = await scene('a.mp4', { 'a.json': JSON.stringify({ tags: ['现在还有'] }) });
    await writeYourSection(s.clip, {
      description: '', tags: ['现在还有', '上一版有过', '我自己加的'], notes: '', segments: [],
      sources: ['clipjson:a.json'],
      origin: { derived: { description: '', notes: '', tags: ['现在还有', '上一版有过'] } },
    });
    const got = await collect(s);
    assert.ok(got.tags.includes('现在还有'), '还能推导出来的该在');
    assert.ok(got.tags.includes('我自己加的'), '你加的标签该粘住');
    assert.ok(!got.tags.includes('上一版有过'), `上一版推导出来的该消失：${got.tags}`);
  });

  test('这套机制本身也是可重跑的', async () => {
    const s = await scene('a.mp4', {
      'a.json': JSON.stringify({ title: '标题', description: '长文' }),
      'a.mp4.narrate.txt': '我特意写的\n#我的标签\n',
    });
    const first = await collect(s);
    await writeYourSection(s.clip, first);
    const second = await collect(s);
    assert.deepEqual(second, first, '两次结果不一样');
    await writeYourSection(s.clip, second);
    assert.deepEqual(await collect(s), first, '第三次也该一样');
  });
});
