// 工作文件的读写。契约：docs/crew/api/flow-stages.md
//
// 一节只有一个写入者。写别人的节在这里当场抛错，不等到成片才发现。
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const SCHEMA = 1;

/** 每一节的唯一写入者。契约里的归属表就是这张表。 */
const OWNER = Object.freeze({
  meta: 'flow',
  idea: 'flow',
  interview: 'script',
  script: 'script',
  shotplan: 'shotplan',
  voice: 'voice',
  render: 'render',
});

export class JobError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JobError';
    this.code = code;
  }
}

const filePath = (dir) => join(dir, 'job.json');
const tempPath = (dir) => join(dir, 'job.json.tmp');

/** 冻住一份拷贝再交出去。别人的节只读，这是契约承诺的，靠类型和自觉都不够。 */
function frozenCopy(value) {
  const copy = structuredClone(value);
  const freeze = (node) => {
    if (node && typeof node === 'object' && !Object.isFrozen(node)) {
      Object.freeze(node);
      for (const child of Object.values(node)) freeze(child);
    }
    return node;
  };
  return freeze(copy);
}

/** 空的节和不存在的节一样，都不能被下一个阶段当输入。 */
function isEmpty(value) {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** 先写临时文件，fsync，再改名。半个文件比没有文件更糟。 */
async function writeAtomic(dir, data) {
  const tmp = tempPath(dir);
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, filePath(dir));
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

export async function createJob(dir, { slug, aspect, language, idea }) {
  const data = {
    meta: { schema: SCHEMA, slug, aspect, language, stage: 'script', stopPoint: 1, waitingForUser: true },
    idea,
  };
  await writeAtomic(dir, data);
  return data;
}

export async function readJob(dir) {
  let text;
  try {
    text = await readFile(filePath(dir), 'utf8');
  } catch (error) {
    throw new JobError('E_JOB_MISSING', `读不到工作文件：${filePath(dir)}（${error.code}）`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new JobError('E_SCHEMA_UNKNOWN', `工作文件不是合法 JSON：${error.message}`);
  }
  const schema = data?.meta?.schema;
  if (schema !== SCHEMA) {
    throw new JobError('E_SCHEMA_UNKNOWN', `不认识的工作文件版本 ${schema}，本模块只认 ${SCHEMA}`);
  }
  return data;
}

/**
 * 打开工作文件给一个阶段用。
 * `set` 只接受这个阶段拥有的节，`require` 保证该读的节真的有内容。
 */
export async function openJob(dir, stage) {
  const data = await readJob(dir);
  return {
    // 交出去的是冻住的拷贝。想改自己的节要走 set，改别人的节在严格模式下直接抛 TypeError。
    get data() {
      return frozenCopy(data);
    },
    require(section) {
      if (!(section in OWNER)) throw new JobError('E_SECTION_UNKNOWN', `没有这一节：${section}`);
      if (isEmpty(data[section])) throw new JobError('E_SECTION_MISSING', `该读的 ${section} 节不存在或为空`);
      return frozenCopy(data[section]);
    },
    set(section, value) {
      if (!(section in OWNER)) throw new JobError('E_SECTION_UNKNOWN', `没有这一节：${section}`);
      if (OWNER[section] !== stage) {
        throw new JobError(
          'E_WRITE_FOREIGN_SECTION',
          `阶段 ${stage} 不能写 ${section} 节，那是 ${OWNER[section]} 的`,
        );
      }
      data[section] = value;
      return this;
    },
    save() {
      return writeAtomic(dir, data);
    },
  };
}
