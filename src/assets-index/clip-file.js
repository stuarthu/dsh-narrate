// 一个 clip 一个描述文件。契约：docs/crew/api/assetsindex-shotplan.md 版本 4
//
// 本模块只做一件事：安全地读写 `<clip 去掉扩展名>.json`。
//
// 两条规则贯穿全文：
//   1. 文件里 `fromYou` 和 `fromMachine` 是分开的两节。所以这里**没有**写整个
//      文件的函数，只有两个窄的写函数，各自只动自己那一节。机器重算永远不会
//      顺手把用户写的东西冲掉。
//   2. 不是我们的文件，一个字节都不写。`bench.json` 是个很普通的名字，用户
//      文件夹里可能本来就有一个别的。覆盖别人的文件是最不可原谅的一种 bug。
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, parse } from 'node:path';

export const SCHEMA = 'dsh-narrate/clip@1';

export class ClipFileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClipFileError';
    this.code = code;
  }
}

/** 一个 clip 的描述文件路径：同一个文件夹，去掉扩展名，加 .json。 */
export function clipJsonPath(clipPath) {
  const { dir, name } = parse(clipPath);
  return join(dir, `${name}.json`);
}

/**
 * 同一个文件夹里两个 clip 去掉扩展名后同名，就会撞成同一个 .json。
 * 这不是理论问题：下载的 .webm 加一个转好的 .mp4 就是这种情况。
 * 响亮报错，绝不把两段不同素材的描述混进一个文件。
 *
 * 注意：这里按大小写敏感分组，因为 Linux 上 A.json 和 a.json 是两个文件。
 * 在大小写不敏感的文件系统上，只差大小写的两个 clip 仍会撞，那要另外处理。
 */
export async function assertNoStemCollisions(clipPaths) {
  const groups = new Map();
  for (const clipPath of clipPaths) {
    const { dir, name } = parse(clipPath);
    const key = `${dir}\u0000${name}`;
    // 分隔符用 NUL：它是 POSIX 文件名里唯一禁止出现的字节，所以两段拼起来
    // 绝不会歧义。但必须写成转义序列。写成字面字节会让 git 把整个源文件
    // 判成二进制，这个文件的 diff 就再也看不了，代码评审直接失效。
    const list = groups.get(key) ?? [];
    list.push(clipPath);
    groups.set(key, list);
  }
  const clashes = [...groups.values()].filter((list) => list.length > 1);
  if (clashes.length > 0) {
    const detail = clashes
      .map((list) => `${dirname(list[0])} 里：${list.map((p) => basename(p)).join(' 和 ')}`)
      .join('；');
    throw new ClipFileError(
      'E_STEM_COLLISION',
      `这些素材去掉扩展名后同名，会撞成同一个 .json，请先改名：${detail}`,
    );
  }
}

function emptyRecord(clipPath) {
  return {
    schema: SCHEMA,
    clip: basename(clipPath),
    fingerprint: '',
    fromYou: { description: '', tags: [], notes: '', segments: [], sources: [] },
    fromMachine: {},
  };
}

/** 读一个 clip 的描述文件。还没有就返回 null——那不是错误，是还没入库。 */
export async function readClipFile(clipPath) {
  const jsonPath = clipJsonPath(clipPath);
  let text;
  try {
    text = await readFile(jsonPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new ClipFileError('E_CLIP_JSON_UNREADABLE', `读不到 ${jsonPath}：${error.code}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    // 解析不了就没法看 schema 字段，只能看原文里有没有我们的标记。
    // 没有标记就当成别人的文件，报 E_FOREIGN_JSON 而不是 E_CLIP_JSON_UNREADABLE，
    // 因为后者会让调用方以为可以覆盖重建。
    if (!text.includes(SCHEMA)) {
      throw new ClipFileError('E_FOREIGN_JSON', `${jsonPath} 不是合法 JSON，也没有我们的标记，不动它`);
    }
    throw new ClipFileError('E_CLIP_JSON_UNREADABLE', `${jsonPath} 是我们的文件但 JSON 坏了：${error.message}`);
  }

  if (data?.schema === undefined) {
    throw new ClipFileError('E_FOREIGN_JSON', `${jsonPath} 没有 schema 标记，不是本插件写的，不动它`);
  }
  if (data.schema !== SCHEMA) {
    throw new ClipFileError(
      'E_CLIP_SCHEMA_UNKNOWN',
      `${jsonPath} 的 schema 是 ${data.schema}，本模块只认 ${SCHEMA}`,
    );
  }

  const base = emptyRecord(clipPath);
  return {
    ...base,
    ...data,
    fromYou: { ...base.fromYou, ...(data.fromYou ?? {}) },
    fromMachine: { ...(data.fromMachine ?? {}) },
  };
}

/**
 * 先写临时文件，fsync，再改名。半个文件比没有文件更糟。
 *
 * 和 src/flow/job.js 里的写法一样。第三个地方要用的时候就该抽出来，
 * 现在两处各自留一份，抽早了反而多一层。
 */
async function writeAtomic(jsonPath, record) {
  const tmpPath = `${jsonPath}.tmp`;
  const handle = await open(tmpPath, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmpPath, jsonPath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

/**
 * 读出现有内容当底子。读不出来的原因（别人的文件、坏文件）会原样抛出，写不下去。
 *
 * 这里还兜住第二道撞名检查。`assertNoStemCollisions` 要看整个文件夹才能查，
 * 万一调用方忘了调，两段素材就会悄悄共用一个 json，谁后写谁赢，还不报错。
 * 而文件里记着 `clip`，所以逐文件也能查：文件说自己属于 bench.mov，
 * 现在却要为 bench.mp4 写，那就是撞名。防护不能靠调用方自觉。
 */
async function baseFor(clipPath) {
  const existing = await readClipFile(clipPath);
  if (existing === null) return emptyRecord(clipPath);
  const mine = basename(clipPath);
  if (existing.clip && existing.clip !== mine) {
    throw new ClipFileError(
      'E_STEM_COLLISION',
      `${clipJsonPath(clipPath)} 已经属于 ${existing.clip}，不能再给 ${mine} 用。` +
        '这两个素材去掉扩展名后同名，请先改名。',
    );
  }
  return existing;
}

/** 只写机器算的那一节。`fromYou` 原样带过去。 */
export async function writeMachineSection(clipPath, { fingerprint, fromMachine }) {
  const base = await baseFor(clipPath);
  const record = { ...base, fingerprint, fromMachine: { ...fromMachine } };
  await writeAtomic(clipJsonPath(clipPath), record);
  return record;
}

/** 只写你给的那一节。`fromMachine` 和 `fingerprint` 原样带过去。 */
export async function writeYourSection(clipPath, fromYou) {
  const base = await baseFor(clipPath);
  const record = { ...base, fromYou: { ...base.fromYou, ...fromYou } };
  await writeAtomic(clipJsonPath(clipPath), record);
  return record;
}

/**
 * 判断素材变没变的指纹。**不含路径**，所以你把整个素材文件夹搬到别的硬盘，
 * 机器算过的东西依然有效，不用重算。
 */
export async function fingerprintOf(clipPath) {
  const info = await stat(clipPath);
  return `size:${info.size}|mtime:${Math.floor(info.mtimeMs / 1000)}`;
}

/** 要不要重新理解这段素材。三种情况都要：还没入库、机器那节是空的、指纹变了。 */
export function needsMachineRefresh(record, fingerprint) {
  if (!record) return true;
  if (!(record.fromMachine?.durationSec > 0)) return true;
  return record.fingerprint !== fingerprint;
}
