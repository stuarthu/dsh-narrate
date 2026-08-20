// T-04 的测试。契约：docs/crew/api/assetsindex-shotplan.md 版本 5
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, stat, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { scanAssets, VIDEO_EXTENSIONS } from '../src/assets-index/scan.js';
import { readClipFile, writeYourSection, SCHEMA } from '../src/assets-index/clip-file.js';

const tmp = () => mkdtemp(join(tmpdir(), 'narrate-scan-'));

async function put(root, rel, body = 'v'.repeat(64)) {
  const p = join(root, rel);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, body, 'utf8');
  return p;
}

/** 假的规格测量：测试里的"素材"是文本文件，ffprobe 量不了，所以注入一个。 */
function fakeMeasure(byName = {}) {
  return async (clipPath) => byName[basename(clipPath)] ?? { durationSec: 30 };
}

/** 假理解器：记下被问过哪些素材，按文件名返回结果。 */
function fakeUnderstander(byName = {}, { fail = [] } = {}) {
  const asked = [];
  const fn = async (clipPath) => {
    asked.push(clipPath);
    const name = basename(clipPath);
    if (fail.includes(name)) throw new Error(`装作理解不了 ${name}`);
    return byName[name] ?? {
      segments: [{ startSec: 0, endSec: 10, description: `${name} 的第一段`, tags: ['自动'], confidence: 'high' }],
      visualSearchDir: `/cache/${name}_avis`,
      engine: 'fake-l0',
    };
  };
  fn.asked = asked;
  return fn;
}

describe('T-04 扫描：找素材', () => {
  test('认得常见的视频扩展名，大小写都行', () => {
    for (const ext of ['.mp4', '.mov', '.mkv', '.webm']) assert.ok(VIDEO_EXTENSIONS.includes(ext));
  });

  test('递归找子文件夹里的素材，不把自己写的文件当素材', async () => {
    const root = await tmp();
    await put(root, 'a.mp4');
    await put(root, '机房/b.MOV');
    await put(root, '机房/网络/c.mkv');
    // 我们自己写的（必须带 schema 标记，否则会被正确判成别人的文件）
    await put(root, 'a.json', JSON.stringify({ schema: SCHEMA, clip: 'a.mp4' }));
    await put(root, 'a.mp4.narrate.txt', '描述\n');   // 人类输入源
    await put(root, 'clips.csv', '文件名,描述,标签\n');
    await put(root, 'readme.txt', 'not a video');
    await put(root, '.hidden/d.mp4');                 // 隐藏目录不进
    const understand = fakeUnderstander();
    const r = await scanAssets({ assetsRoot: root, understand, measure: fakeMeasure() });
    const names = r.clips.map((c) => basename(c.clipPath)).sort();
    assert.deepEqual(names, ['a.mp4', 'b.MOV', 'c.mkv']);
  });

  test('一个素材都没有时返回空结果，不报错', async () => {
    const root = await tmp();
    const r = await scanAssets({ assetsRoot: root, understand: fakeUnderstander(), measure: fakeMeasure() });
    assert.deepEqual(r.clips, []);
    assert.deepEqual(r.understood, []);
    assert.deepEqual(r.skipped, []);
  });
});

describe('T-04 入库和复用', () => {
  test('A-1：三个素材入库后，每个都有一条带文字描述的记录', async () => {
    const root = await tmp();
    for (const n of ['a.mp4', 'b.mp4', 'c.mp4']) await put(root, n);
    const understand = fakeUnderstander();
    const r = await scanAssets({ assetsRoot: root, understand, measure: fakeMeasure() });

    assert.equal(r.clips.length, 3);
    assert.equal(r.understood.length, 3);
    for (const n of ['a.mp4', 'b.mp4', 'c.mp4']) {
      const rec = await readClipFile(join(root, n));
      assert.ok(rec, `${n} 没有描述文件`);
      assert.equal(rec.measured.durationSec, 30);
      assert.deepEqual(Object.keys(rec.measured).sort(), ['durationSec', 'shape'], '只该存时长');
      assert.equal(rec.fromMachine.segments[0].description, `${n} 的第一段`);
      assert.equal(rec.fromMachine.visualSearchDir, `/cache/${n}_avis`);
      assert.ok(rec.fromYou.tags.length > 0, '文件名至少该给出一个标签');
    }
  });

  test('A-2：什么都没改再跑一次，理解次数为 0，文件字节不变', async () => {
    const root = await tmp();
    for (const n of ['a.mp4', 'b.mp4', 'c.mp4']) await put(root, n);
    await scanAssets({ assetsRoot: root, understand: fakeUnderstander(), measure: fakeMeasure() });
    const before = {};
    for (const n of ['a.json', 'b.json', 'c.json']) before[n] = await readFile(join(root, n), 'utf8');

    const understand = fakeUnderstander();
    const r = await scanAssets({ assetsRoot: root, understand, measure: fakeMeasure() });
    assert.equal(understand.asked.length, 0, `不该再问理解器，却问了 ${understand.asked.length} 次`);
    assert.equal(r.understood.length, 0);
    assert.equal(r.reused.length, 3);
    for (const n of ['a.json', 'b.json', 'c.json']) {
      assert.equal(await readFile(join(root, n), 'utf8'), before[n], `${n} 变了`);
    }
  });

  test('契约测试（被调侧）：只有指纹变了的那个被重算，而它手写的描述一字不变', async () => {
    const root = await tmp();
    for (const n of ['a.mp4', 'b.mp4', 'c.mp4']) await put(root, n);
    await scanAssets({ assetsRoot: root, understand: fakeUnderstander(), measure: fakeMeasure() });

    // 你手改 b 的描述
    const bClip = join(root, 'b.mp4');
    const rec = await readClipFile(bClip);
    await writeYourSection(bClip, { ...rec.fromYou, description: '这段是我在深圳拍的' });
    // 只有 b 的文件变了
    await utimes(bClip, new Date(0), new Date(0));

    const understand = fakeUnderstander({
      'b.mp4': { segments: [{ startSec: 0, endSec: 5, description: '重算出来的' }], engine: 'fake-l0' },
    });
    const r = await scanAssets({ assetsRoot: root, understand, measure: fakeMeasure() });

    assert.deepEqual(understand.asked.map((p) => basename(p)), ['b.mp4'], '只该问 b.mp4');
    assert.deepEqual(r.reused.map((p) => basename(p)).sort(), ['a.mp4', 'c.mp4']);
    const after = await readClipFile(bClip);
    assert.equal(after.fromMachine.segments[0].description, '重算出来的', 'b 的机器那节该被重算');
    assert.equal(after.fromYou.description, '这段是我在深圳拍的', '你手写的描述被冲掉了');
  });

  test('你跟插件说的话会落到对的素材上', async () => {
    const root = await tmp();
    await put(root, 'a.mp4');
    await put(root, 'b.mp4');
    await scanAssets({
      assetsRoot: root,
      understand: fakeUnderstander(),
      measure: fakeMeasure(),
      chatByClip: { 'b.mp4': { description: '这段是深圳拍的', tags: ['深圳'], date: '2026-08-20' } },
    });
    assert.equal((await readClipFile(join(root, 'a.mp4'))).fromYou.description, '');
    const b = await readClipFile(join(root, 'b.mp4'));
    assert.equal(b.fromYou.description, '这段是深圳拍的');
    assert.ok(b.fromYou.sources.includes('chat:2026-08-20'));
  });

  test('clips.csv 的描述会用到每一个对得上的素材', async () => {
    const root = await tmp();
    for (const n of ['a.mp4', 'b.mp4']) await put(root, n);
    await put(root, 'clips.csv', '文件名,描述,标签\na.mp4,表格给 a 的描述,机房\nb.mp4,表格给 b 的描述,机房\n');
    await scanAssets({ assetsRoot: root, understand: fakeUnderstander(), measure: fakeMeasure() });
    assert.equal((await readClipFile(join(root, 'a.mp4'))).fromYou.description, '表格给 a 的描述');
    assert.equal((await readClipFile(join(root, 'b.mp4'))).fromYou.description, '表格给 b 的描述');
  });
});

describe('T-04 一个坏素材不能拖垮整次入库', () => {
  test('理解失败的那个跳过并记下，别的照样做完，而你写的东西不会丢', async () => {
    const root = await tmp();
    for (const n of ['a.mp4', 'bad.mp4', 'c.mp4']) await put(root, n);
    const understand = fakeUnderstander({}, { fail: ['bad.mp4'] });
    const r = await scanAssets({ assetsRoot: root, understand, measure: fakeMeasure() });

    assert.equal(r.understood.length, 2, '好的两个该做完');
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].code, 'E_UNDERSTAND_FAILED');
    assert.equal(basename(r.skipped[0].clipPath), 'bad.mp4');
    assert.ok(r.skipped[0].message.includes('bad.mp4'));
    assert.ok(await readClipFile(join(root, 'a.mp4')));
    // 理解失败不代表要扔掉你写的东西。fromYou 留着，fromMachine 空着，下次重试。
    const bad = await readClipFile(join(root, 'bad.mp4'));
    assert.deepEqual(bad.fromMachine, {}, '机器那节该是空的');
    assert.ok(bad.fromYou.sources.includes('filename:bad.mp4'), '你的输入该留着');
  });

  test('别人的 JSON 是可用的输入源：入库成功，他们的键保住，还留了备份', async () => {
    const root = await tmp();
    for (const n of ['a.mp4', 'b.mp4']) await put(root, n);
    const target = join(root, 'b.json');
    const body = JSON.stringify({ source: 'archive.org', title: 'Mountain Fog', tags: ['Fog'] }, null, 2);
    await writeFile(target, body, 'utf8');

    const r = await scanAssets({ assetsRoot: root, understand: fakeUnderstander(), measure: fakeMeasure() });
    assert.equal(r.skipped.length, 0, `不该再跳过：${JSON.stringify(r.skipped)}`);
    assert.equal(r.understood.length, 2);

    const rec = await readClipFile(join(root, 'b.mp4'));
    assert.equal(rec.source, 'archive.org', '他们的键该保住');
    assert.equal(rec.title, 'Mountain Fog');
    // 他们的 title 和 tags 成了第七个读取器的输入
    assert.equal(rec.fromYou.description, 'Mountain Fog');
    assert.ok(rec.fromYou.tags.includes('Fog'));
    assert.ok(rec.fromYou.sources.some((x) => x.startsWith('clipjson:')));
    assert.equal(await readFile(`${target}.bak`, 'utf8'), body, '该留一份动手前的备份');
  });

  test('认不出扩展名的文件要报出来，不静默跳过', async () => {
    const root = await tmp();
    await put(root, 'a.mp4');
    await put(root, 'b.ogv');            // 现在认了
    await put(root, 'c.weirdformat');    // 不认识
    await put(root, 'readme.txt');       // 明确不是素材，安静跳过
    await put(root, 'cover.jpg');        // 同上
    const r = await scanAssets({ assetsRoot: root, understand: fakeUnderstander(), measure: fakeMeasure() });
    assert.deepEqual(r.clips.map((c) => basename(c.clipPath)).sort(), ['a.mp4', 'b.ogv']);
    assert.deepEqual(r.skipped.map((s) => basename(s.clipPath)), ['c.weirdformat']);
    assert.equal(r.skipped[0].code, 'E_UNKNOWN_MEDIA');
  });

  test('撞名是整个文件夹的问题，所以整次入库停下，什么都不写', async () => {
    const root = await tmp();
    await put(root, 'a.mp4');
    await put(root, 'a.mov');
    const understand = fakeUnderstander();
    await assert.rejects(
      () => scanAssets({ assetsRoot: root, understand, measure: fakeMeasure() }),
      (e) => e.code === 'E_STEM_COLLISION',
    );
    assert.equal(understand.asked.length, 0, '停下之前不该问任何理解');
    assert.equal(await readClipFile(join(root, 'a.mp4')), null, '不该写出任何描述文件');
  });
});

describe('T-04 把理解结果规整成时间段', () => {
  test('只给了一句整体描述时，补成覆盖全长的一个时间段，把握标 low', async () => {
    const root = await tmp();
    await put(root, 'a.mp4');
    await scanAssets({
      assetsRoot: root,
      measure: fakeMeasure({ 'a.mp4': { durationSec: 42 } }),
      understand: async () => ({ description: '一台服务器机柜', engine: 'fake-l0' }),
    });
    const rec = await readClipFile(join(root, 'a.mp4'));
    assert.deepEqual(rec.fromMachine.segments, [
      { startSec: 0, endSec: 42, description: '一台服务器机柜', tags: [], confidence: 'low' },
    ]);
    assert.equal(rec.measured.durationSec, 42, '时长归 measured，不归 fromMachine');
  });

  test('时间段乱序会排好，超出总长会截断，起止相等的丢掉', async () => {
    const root = await tmp();
    await put(root, 'a.mp4');
    await scanAssets({
      assetsRoot: root,
      measure: fakeMeasure({ 'a.mp4': { durationSec: 20 } }),
      understand: async () => ({
        segments: [
          { startSec: 10, endSec: 15, description: '第二段' },
          { startSec: 0, endSec: 5, description: '第一段' },
          { startSec: 18, endSec: 99, description: '超出总长' },
          { startSec: 7, endSec: 7, description: '零长度' },
        ],
        engine: 'fake-l0',
      }),
    });
    const segs = (await readClipFile(join(root, 'a.mp4'))).fromMachine.segments;
    assert.deepEqual(segs.map((s) => s.description), ['第一段', '第二段', '超出总长']);
    assert.equal(segs[2].endSec, 20, '超出总长的该截断到 20');
    assert.equal(segs.every((s) => s.confidence === 'low' || s.confidence === 'high'), true);
  });

  test('理解器不用报时长了：时长归 ffprobe 量的那一节', async () => {
    const root = await tmp();
    await put(root, 'a.mp4');
    const understand = fakeUnderstander();
    const r = await scanAssets({
      assetsRoot: root,
      measure: fakeMeasure({ 'a.mp4': { durationSec: 77.5 } }),
      understand,
    });
    assert.equal(r.understood.length, 1);
    const rec = await readClipFile(join(root, 'a.mp4'));
    assert.equal(rec.measured.durationSec, 77.5);
    assert.equal(rec.fromMachine.durationSec, undefined, 'fromMachine 里不该再有时长');
    assert.ok(rec.fromMachine.segments.length > 0);
  });

  test('一个时间段都规整不出来时，也算理解失败', async () => {
    const root = await tmp();
    await put(root, 'a.mp4');
    const r = await scanAssets({
      assetsRoot: root,
      measure: fakeMeasure(),
      understand: async () => ({ segments: [{ startSec: 5, endSec: 5, description: 'x' }] }),
    });
    assert.equal(r.skipped[0].code, 'E_UNDERSTAND_FAILED');
  });
});

describe('T-04 评审补的测试', () => {
  test('素材文件夹本身不存在时报 E_ASSETS_ROOT_UNREADABLE', async () => {
    const root = await tmp();
    await assert.rejects(
      () => scanAssets({ assetsRoot: join(root, '没有这个目录'), understand: fakeUnderstander() }),
      (e) => e.code === 'E_ASSETS_ROOT_UNREADABLE',
    );
  });

  test('软链接接进来的目录要跟进去扫（素材放外置硬盘的常见做法）', async () => {
    const root = await tmp();
    const elsewhere = await tmp();
    await put(elsewhere, 'onDrive.mp4');
    await put(root, 'here.mp4');
    await symlink(elsewhere, join(root, '外置硬盘'));

    const r = await scanAssets({ assetsRoot: root, understand: fakeUnderstander(), measure: fakeMeasure() });
    const names = r.clips.map((c) => basename(c.clipPath)).sort();
    assert.deepEqual(names, ['here.mp4', 'onDrive.mp4'], '软链接目录里的素材该被扫到');
  });

  test('软链接成环不会把扫描卡死', async () => {
    const root = await tmp();
    await put(root, 'a.mp4');
    await symlink(root, join(root, 'loop'));      // 指回自己
    await symlink(join(root, 'loop'), join(root, 'loop2'));
    const r = await scanAssets({ assetsRoot: root, understand: fakeUnderstander(), measure: fakeMeasure() });
    assert.deepEqual(r.clips.map((c) => basename(c.clipPath)), ['a.mp4']);
  });

  test('断掉的软链接跳过，不影响别的素材', async () => {
    const root = await tmp();
    await put(root, 'a.mp4');
    await symlink(join(root, '不存在的目标.mp4'), join(root, 'broken.mp4'));
    const r = await scanAssets({ assetsRoot: root, understand: fakeUnderstander(), measure: fakeMeasure() });
    assert.deepEqual(r.clips.map((c) => basename(c.clipPath)), ['a.mp4']);
  });

  test('你那一节没变时不重写文件（不做无谓的写盘）', async () => {
    const root = await tmp();
    await put(root, 'a.mp4');
    await scanAssets({ assetsRoot: root, understand: fakeUnderstander(), measure: fakeMeasure() });
    const jsonPath = join(root, 'a.json');
    // 把修改时间设成一个很久以前的固定值，再扫一次，看它有没有被动过
    const old = new Date(1000000);
    await utimes(jsonPath, old, old);
    await scanAssets({ assetsRoot: root, understand: fakeUnderstander(), measure: fakeMeasure() });
    const after = await stat(jsonPath);
    assert.equal(Math.floor(after.mtimeMs / 1000), 1000, '文件被无谓地重写了');
  });

  test('你那一节变了就要写（上一条不能变成永不更新）', async () => {
    const root = await tmp();
    await put(root, 'a.mp4');
    await scanAssets({ assetsRoot: root, understand: fakeUnderstander(), measure: fakeMeasure() });
    const jsonPath = join(root, 'a.json');
    const old = new Date(1000000);
    await utimes(jsonPath, old, old);
    // 新加一个同名文本，你那一节就变了
    await put(root, 'a.mp4.narrate.txt', '后来补的描述\n');
    await scanAssets({ assetsRoot: root, understand: fakeUnderstander(), measure: fakeMeasure() });
    assert.notEqual(Math.floor((await stat(jsonPath)).mtimeMs / 1000), 1000, '变了却没写');
    assert.equal((await readClipFile(join(root, 'a.mp4'))).fromYou.description, '后来补的描述');
  });

  test('意外错误报 E_SCAN_INTERNAL，不伪装成理解失败', async () => {
    const root = await tmp();
    await put(root, 'a.mp4');
    await put(root, 'b.mp4');
    const r = await scanAssets({
      assetsRoot: root,
      understand: fakeUnderstander(),
      measure: fakeMeasure(),
      // tags 给成字符串会在翻译里炸出一个没有错误码的 TypeError
      chatByClip: { 'b.mp4': { tags: '这不是数组' } },
    });
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].code, 'E_SCAN_INTERNAL', '意外错误被贴成了别的码，bug 会被藏起来');
    assert.equal(r.understood.length, 1, 'a 该照样做完');
  });
});
