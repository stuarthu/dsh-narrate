// T-02 的测试。契约：docs/crew/api/assetsindex-shotplan.md 版本 4
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, stat, lstat, readdir, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SCHEMA,
  clipJsonPath,
  assertNoStemCollisions,
  readClipFile,
  writeMachineSection,
  writeYourSection,
  fingerprintOf,
  needsMachineRefresh,
} from '../src/assets-index/clip-file.js';

const tmp = () => mkdtemp(join(tmpdir(), 'narrate-clip-'));

/** 造一个假 clip 文件。内容无所谓，这一层不读视频。 */
async function fakeClip(dir, name, bytes = 'x'.repeat(64)) {
  const p = join(dir, name);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, bytes, 'utf8');
  return p;
}

const MACHINE = {
  durationSec: 63.2,
  segments: [
    { startSec: 0, endSec: 12.4, description: '远景，机柜走廊', tags: ['远景'], confidence: 'low' },
    { startSec: 12.4, endSec: 31, description: '特写，有人插网线', tags: ['特写'], confidence: 'high' },
  ],
  visualSearchDir: '/cache/bench_avis',
  engine: 'video-understand-l0',
};

const YOURS = {
  description: '深圳某机房，我自己拍的，版权干净',
  tags: ['机房', '服务器'],
  notes: '别用在商单视频里',
  segments: [],
  sources: ['folder:机房'],
};

describe('T-02 描述文件：路径和撞名', () => {
  test('bench.mp4 的描述文件是同一个文件夹里的 bench.json', async () => {
    assert.equal(clipJsonPath('/a/b/bench.mp4'), '/a/b/bench.json');
    assert.equal(clipJsonPath('/a/b/我的 素材.MP4'), '/a/b/我的 素材.json');
  });

  test('同一个文件夹里 a.mp4 和 a.mov 撞名，报 E_STEM_COLLISION 并列出两个文件名', async () => {
    const dir = await tmp();
    const one = await fakeClip(dir, 'a.mp4');
    const two = await fakeClip(dir, 'a.mov');
    await assert.rejects(
      () => assertNoStemCollisions([one, two]),
      (e) => e.code === 'E_STEM_COLLISION' && e.message.includes('a.mp4') && e.message.includes('a.mov'),
    );
  });

  test('不同文件夹里的同名 clip 不算撞名', async () => {
    const dir = await tmp();
    const one = await fakeClip(dir, 'x/a.mp4');
    const two = await fakeClip(dir, 'y/a.mp4');
    await assertNoStemCollisions([one, two]); // 不该抛错
  });
});

describe('T-02 描述文件：绝不碰别人的文件', () => {
  test('还没有描述文件时，读回 null，不是报错', async () => {
    const dir = await tmp();
    const clip = await fakeClip(dir, 'bench.mp4');
    assert.equal(await readClipFile(clip), null);
  });

  test('读到一个没有 schema 标记的 JSON，报 E_FOREIGN_JSON', async () => {
    const dir = await tmp();
    const clip = await fakeClip(dir, 'bench.mp4');
    await writeFile(join(dir, 'bench.json'), JSON.stringify({ hello: 'world' }), 'utf8');
    await assert.rejects(() => readClipFile(clip), (e) => e.code === 'E_FOREIGN_JSON');
  });

  test('写的时候遇到别人的 JSON，报错并且那个文件一个字节都不变', async () => {
    const dir = await tmp();
    const clip = await fakeClip(dir, 'bench.mp4');
    const foreign = join(dir, 'bench.json');
    const body = JSON.stringify({ someoneElse: '这是我自己的文件，别动' }, null, 2);
    await writeFile(foreign, body, 'utf8');
    const before = await stat(foreign);

    await assert.rejects(
      () => writeMachineSection(clip, { fingerprint: 'size:1|mtime:1', fromMachine: MACHINE }),
      (e) => e.code === 'E_FOREIGN_JSON',
    );
    const after = await stat(foreign);
    assert.equal(after.size, before.size, '别人的文件大小变了');
    assert.equal(await readFile(foreign, 'utf8'), body, '别人的文件内容变了');
  });

  test('我们的文件但 JSON 坏了，报 E_CLIP_JSON_UNREADABLE 且不覆盖', async () => {
    const dir = await tmp();
    const clip = await fakeClip(dir, 'bench.mp4');
    const broken = `{ "schema": "${SCHEMA}", "clip": "bench.mp4",`; // 缺右括号
    await writeFile(join(dir, 'bench.json'), broken, 'utf8');
    await assert.rejects(() => readClipFile(clip), (e) => e.code === 'E_CLIP_JSON_UNREADABLE');
    await assert.rejects(
      () => writeMachineSection(clip, { fingerprint: 'size:1|mtime:1', fromMachine: MACHINE }),
      (e) => e.code === 'E_CLIP_JSON_UNREADABLE',
    );
    assert.equal(await readFile(join(dir, 'bench.json'), 'utf8'), broken, '坏文件被覆盖了');
  });

  test('不认识的 schema 版本报 E_CLIP_SCHEMA_UNKNOWN', async () => {
    const dir = await tmp();
    const clip = await fakeClip(dir, 'bench.mp4');
    await writeFile(join(dir, 'bench.json'),
      JSON.stringify({ schema: 'dsh-narrate/clip@99', clip: 'bench.mp4' }), 'utf8');
    await assert.rejects(() => readClipFile(clip), (e) => e.code === 'E_CLIP_SCHEMA_UNKNOWN');
  });
});

describe('T-02 描述文件：两节分工', () => {
  test('写进去的 fromMachine 能读回来', async () => {
    const dir = await tmp();
    const clip = await fakeClip(dir, 'bench.mp4');
    await writeMachineSection(clip, { fingerprint: 'size:64|mtime:100', fromMachine: MACHINE });
    const rec = await readClipFile(clip);
    assert.equal(rec.schema, SCHEMA);
    assert.equal(rec.clip, 'bench.mp4');
    assert.equal(rec.fromMachine.segments[1].description, '特写，有人插网线');
    assert.deepEqual(rec.fromYou, { description: '', tags: [], notes: '', segments: [], sources: [] });
  });

  test('机器重算两次，你写的那一节一字不变', async () => {
    const dir = await tmp();
    const clip = await fakeClip(dir, 'bench.mp4');
    await writeYourSection(clip, YOURS);
    await writeMachineSection(clip, { fingerprint: 'size:64|mtime:100', fromMachine: MACHINE });
    await writeMachineSection(clip, {
      fingerprint: 'size:99|mtime:200',
      fromMachine: { ...MACHINE, durationSec: 1.5, segments: [] },
    });
    const rec = await readClipFile(clip);
    assert.deepEqual(rec.fromYou, YOURS, '你写的那一节被机器改了');
    assert.equal(rec.fromMachine.durationSec, 1.5, '机器那一节应该被重写');
    assert.equal(rec.fingerprint, 'size:99|mtime:200');
  });

  test('写你那一节的时候，机器那一节一字不变', async () => {
    const dir = await tmp();
    const clip = await fakeClip(dir, 'bench.mp4');
    await writeMachineSection(clip, { fingerprint: 'size:64|mtime:100', fromMachine: MACHINE });
    await writeYourSection(clip, YOURS);
    const rec = await readClipFile(clip);
    assert.deepEqual(rec.fromMachine, MACHINE, '机器那一节被写你的步骤改了');
    assert.equal(rec.fromYou.notes, '别用在商单视频里');
  });

  test('没有写整个文件的入口：模块只导出两个窄的写函数', async () => {
    const mod = await import('../src/assets-index/clip-file.js');
    const writers = Object.keys(mod).filter((k) => /^write/.test(k));
    assert.deepEqual(writers.sort(), ['writeMachineSection', 'writeYourSection']);
  });

  test('写是原子的：不留临时文件', async () => {
    const dir = await tmp();
    const clip = await fakeClip(dir, 'bench.mp4');
    await writeMachineSection(clip, { fingerprint: 'size:64|mtime:100', fromMachine: MACHINE });
    const names = (await readdir(dir)).sort();
    assert.deepEqual(names, ['bench.json', 'bench.mp4'], `目录里多了东西：${names}`);
  });
});

describe('T-02 描述文件：指纹决定要不要重算', () => {
  test('指纹形状是 size:<字节>|mtime:<秒>，且不含路径', async () => {
    const dir = await tmp();
    const clip = await fakeClip(dir, 'bench.mp4', 'y'.repeat(123));
    const fp = await fingerprintOf(clip);
    assert.match(fp, /^size:123\|mtime:\d+$/);
    assert.ok(!fp.includes(dir), '指纹不该含路径，否则搬文件夹就全部失效');
  });

  test('指纹一样就不用重算，变了才要', async () => {
    const dir = await tmp();
    const clip = await fakeClip(dir, 'bench.mp4');
    const fp = await fingerprintOf(clip);
    await writeMachineSection(clip, { fingerprint: fp, fromMachine: MACHINE });

    let rec = await readClipFile(clip);
    assert.equal(needsMachineRefresh(rec, fp), false, '指纹没变，不该重算');

    // 只改修改时间，内容不动
    await utimes(clip, new Date(0), new Date(0));
    const fp2 = await fingerprintOf(clip);
    assert.notEqual(fp2, fp);
    assert.equal(needsMachineRefresh(rec, fp2), true, '指纹变了，必须重算');
  });

  test('还没有描述文件时，一定要重算', () => {
    assert.equal(needsMachineRefresh(null, 'size:1|mtime:1'), true);
  });

  test('有文件但 fromMachine 是空的，也要重算', async () => {
    const dir = await tmp();
    const clip = await fakeClip(dir, 'bench.mp4');
    await writeYourSection(clip, YOURS); // 只有你写的，机器还没跑
    const rec = await readClipFile(clip);
    assert.equal(needsMachineRefresh(rec, rec.fingerprint), true);
  });
});

describe('T-02 代码评审补的测试', () => {
  test('写你那一节时遇到别人的 JSON，也报错且那个文件不变', async () => {
    const dir = await tmp();
    const clip = await fakeClip(dir, 'bench.mp4');
    const foreign = join(dir, 'bench.json');
    const body = JSON.stringify({ someoneElse: '别动' }, null, 2);
    await writeFile(foreign, body, 'utf8');
    await assert.rejects(() => writeYourSection(clip, YOURS), (e) => e.code === 'E_FOREIGN_JSON');
    assert.equal(await readFile(foreign, 'utf8'), body);
  });

  test('就算没人调 assertNoStemCollisions，写的时候也会挡住撞名', async () => {
    const dir = await tmp();
    const mov = await fakeClip(dir, 'bench.mov');
    const mp4 = await fakeClip(dir, 'bench.mp4');
    await writeMachineSection(mov, { fingerprint: 'size:1|mtime:1', fromMachine: MACHINE });
    // 故意不调 assertNoStemCollisions，直接写另一个
    await assert.rejects(
      () => writeMachineSection(mp4, { fingerprint: 'size:2|mtime:2', fromMachine: MACHINE }),
      (e) => e.code === 'E_STEM_COLLISION' && e.message.includes('bench.mov'),
    );
    await assert.rejects(() => writeYourSection(mp4, YOURS), (e) => e.code === 'E_STEM_COLLISION');
    // 先来的那个一点没坏
    const rec = await readClipFile(mov);
    assert.equal(rec.clip, 'bench.mov');
    assert.equal(rec.fingerprint, 'size:1|mtime:1');
  });

  test('同一个 clip 反复写不会被当成撞名', async () => {
    const dir = await tmp();
    const clip = await fakeClip(dir, 'bench.mp4');
    await writeMachineSection(clip, { fingerprint: 'size:1|mtime:1', fromMachine: MACHINE });
    await writeMachineSection(clip, { fingerprint: 'size:2|mtime:2', fromMachine: MACHINE });
    await writeYourSection(clip, YOURS);
    const rec = await readClipFile(clip);
    assert.equal(rec.fingerprint, 'size:2|mtime:2');
    assert.equal(rec.fromYou.description, YOURS.description);
  });
});

describe('T-02 安全评审：软链接不能被写穿', () => {
  test('bench.json 是指向别处的软链接时，那个目标文件一个字节都不变', async () => {
    const dir = await tmp();
    const clip = await fakeClip(dir, 'bench.mp4');
    const secret = join(dir, 'important.conf');
    const body = 'password = hunter2\n';
    await writeFile(secret, body, 'utf8');
    await symlink(secret, join(dir, 'bench.json'));

    // 读：跟着链接读到目标，目标没有我们的标记，所以判成别人的文件
    await assert.rejects(() => readClipFile(clip), (e) => e.code === 'E_FOREIGN_JSON');
    // 写：也被拦住
    await assert.rejects(
      () => writeMachineSection(clip, { fingerprint: 'size:1|mtime:1', fromMachine: MACHINE }),
      (e) => e.code === 'E_FOREIGN_JSON',
    );
    assert.equal(await readFile(secret, 'utf8'), body, '软链接的目标被改了');
  });

  test('就算写下去了，rename 换掉的也是软链接本身，不是它的目标', async () => {
    const dir = await tmp();
    const clip = await fakeClip(dir, 'bench.mp4');
    const target = join(dir, 'target.json');
    const body = JSON.stringify({ schema: SCHEMA, clip: 'bench.mp4' }, null, 2);
    await writeFile(target, body, 'utf8'); // 有我们的标记，所以写得下去
    await symlink(target, join(dir, 'bench.json'));

    await writeMachineSection(clip, { fingerprint: 'size:9|mtime:9', fromMachine: MACHINE });

    assert.equal(await readFile(target, 'utf8'), body, '目标文件被写穿了');
    const info = await lstat(join(dir, 'bench.json'));
    assert.equal(info.isSymbolicLink(), false, 'bench.json 应该已经是普通文件，不再是软链接');
    const rec = await readClipFile(clip);
    assert.equal(rec.fingerprint, 'size:9|mtime:9');
  });
});

describe('防护：源码文件必须是纯文本', () => {
  // 这条是从一次真实失败来的。分隔符本来该用 NUL（POSIX 文件名里唯一禁止的字节），
  // 但它被写成了字面字节，而不是转义序列。结果 git 把整个源文件判成二进制，
  // 这个文件的 diff 就再也看不了，代码评审直接失效。
  test('src 下每个 .js 文件都不含 NUL 字节', async () => {
    const { readdir } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const walk = async (d) => {
      const out = [];
      for (const entry of await readdir(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(p)));
        else if (entry.name.endsWith('.js')) out.push(p);
      }
      return out;
    };
    const files = await walk(root);
    assert.ok(files.length >= 5, `应该找到多个源文件，只找到 ${files.length} 个`);
    for (const f of files) {
      const buf = await readFile(f);
      assert.equal(buf.includes(0), false, `${f} 里有 NUL 字节，git 会把它当二进制`);
    }
  });
});
