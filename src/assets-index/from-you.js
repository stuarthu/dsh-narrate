// 把你的输入翻译成 `fromYou` 那一节。契约：docs/crew/api/assetsindex-shotplan.md 版本 10
//
// 你可以用任何顺手的方式写素材的描述和标签。这个模块负责把它们收拢成一种格式。
// "任何方式"的真实含义是下面这组读取器，可以一个个加。
//
// 两条规则最要紧：
//   1. **可重跑。** 输入源一个字没改，重跑一遍结果必须一字不差。否则你会发现
//      自己写的描述莫名变了，然后再也不敢信这个工具。
//   2. **手改不能丢。** 手改只存在于输出文件里，不存在于任何输入源。
//      但"推导不出来就是手改"这个判断不够——**我们自己上一个版本的输出也推导不
//      出来**。真实数据撞出过这个 bug：读取器改成用 title 之后，上一次存下的
//      长 description 被当成手改，永远压着新的推导结果。
//      所以每次都记下**我们上次推导出来的值**当基准（`origin.derived`）。
//      存着的值等于那个基准，就是我们的旧输出，放心覆盖；不等于，说明你在我们
//      写完之后改过它，那才是手改，粘住。这就是标准的三方合并。
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, parse, relative, sep } from 'node:path';

import { foreignKeysOf, readClipFile } from './clip-file.js';

/** 越明确的越优先，数字越小赢。 */
export const PRIORITY = Object.freeze({
  chat: 1,
  manual: 2,
  sidecar: 3,
  csv: 4,
  clipjson: 5,
  filename: 6,
  folder: 7,
});

const CSV_NAME = 'clips.csv';
const SIDECAR_SUFFIX = '.narrate.txt';

export class FromYouError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FromYouError';
    this.code = code;
  }
}

const clean = (s) => String(s ?? '').trim();
const nonEmpty = (list) => list.map(clean).filter((x) => x !== '');

/**
 * 标签只放**关键词**，不放技术规格。
 *
 * 这不是嫌它们啰嗦，是因为它们会**主动误导**。实测四个 archive.org 素材：三个的
 * 标签都写 `1920x1080` / `1080p` / `HD`，其中两个实际是 `640x360` 和 `532x300`；
 * 一个写 `H.264` / `MP4`，实际是 `vp8` / `webm`。
 *
 * 这些东西的真值在 `measured` 里，是 ffprobe 量出来的。原则是：量，不要信。
 */
const SPEC_TAG = new RegExp(
  [
    '^\\d+$',                                 // 纯数字：1080、720
    '^\\d{3,4}\\s*[x\u00d7]\\s*\\d{3,4}$',        // 1920x1080
    '^\\d{3,4}[pi]$',                          // 1080p、720i
    '^[48]k$',                                  // 4k、8k
    '^\\d{1,3}\\s*fps$',                        // 30fps
    '^(hd|uhd|fhd|sd|hi-?def|full\\s*hd|high\\s+definition|high\\s+quality|low\\s+quality)$',
    '^(h\\.?26[45]|hevc|avc|x26[45]|mpeg-?4|mp4|m4v|webm|mkv|mov|avi|flv|wmv|ogv|ogg)$',
    '^(vp[89]|av1|theora|xvid|divx|prores|dnxhd|aac|mp3|opus|vorbis|pcm|flac)$',
  ].join('|'),
  'i',
);

/** 是不是一个能当关键词用的标签。 */
const usefulTag = (t) => t !== '' && !SPEC_TAG.test(t.trim());

// ── 读取器。每个返回 { kind, source, description, tags, notes } 或 null ────

/** 文件夹名。只取 assets 根目录**以下**的部分，否则每个素材都会背上 home、你的用户名。 */
function readFolder(clipPath, assetsRoot) {
  const rel = relative(assetsRoot, dirname(clipPath));
  if (rel === '' || rel.startsWith('..')) return null;
  const tags = rel.split(sep).map(clean).filter(usefulTag);
  if (tags.length === 0) return null;
  return { kind: 'folder', source: `folder:${rel}`, description: '', tags, notes: '' };
}

/** 文件名。按连字符、下划线、空格切词。中文不分词，这是真实限制。 */
function readFilename(clipPath) {
  const tags = parse(clipPath).name.split(/[-_\s]+/).map(clean).filter(usefulTag);
  if (tags.length === 0) return null;
  return { kind: 'filename', source: `filename:${basename(clipPath)}`, description: '', tags, notes: '' };
}

/** 同名文本：第一行是描述，`#` 开头的行是标签，其余的行原样进 notes。 */
async function readSidecar(clipPath) {
  const path = `${clipPath}${SIDECAR_SUFFIX}`;
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new FromYouError('E_SOURCE_UNREADABLE', `读不到 ${path}：${error.code}`);
  }
  let description = '';
  const tags = [];
  const noteLines = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (clean(line) === '') continue;
    if (line.trimStart().startsWith('#')) {
      // 只有整行以 # 开头才算标签行。句子中间的 # 是普通文字。
      for (const m of line.matchAll(/#(\S+)/g)) if (usefulTag(m[1])) tags.push(m[1]);
      continue;
    }
    if (description === '') description = clean(line);
    else noteLines.push(line);
  }
  return {
    kind: 'sidecar',
    source: `sidecar:${basename(path)}`,
    description,
    tags,
    notes: noteLines.join('\n'),
  };
}

/** 引号感知的极简 CSV 解析。引号里的逗号和换行都算内容。 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i += 1; }
      else inQuotes = false;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * 把 `clips.csv` 解析成行。一个文件夹几百个素材，每个都重解析一遍是白做的功，
 * 所以调用方（扫描那一步）可以先调这个，把结果传给每次翻译。
 * 没有这个文件就返回空数组，不是错误。
 */
export async function loadCsvRows(assetsRoot) {
  const path = join(assetsRoot, CSV_NAME);
  try {
    return parseCsv(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new FromYouError('E_SOURCE_UNREADABLE', `读不到 ${path}：${error.code}`);
  }
}

/** 表格：三列，文件名、描述、标签（分号隔开）。表头对不上任何文件名，所以会自动跳过。 */
async function readCsv(clipPath, assetsRoot, csvRows) {
  const rows = csvRows ?? (await loadCsvRows(assetsRoot));
  if (rows.length === 0) return null;
  const me = basename(clipPath);
  const mine = rows.filter((row) => clean(row[0]) === me);
  if (mine.length === 0) return null;

  const descriptions = [...new Set(nonEmpty(mine.map((row) => row[1])))];
  if (descriptions.length > 1) {
    throw new FromYouError(
      'E_SOURCE_CONFLICT',
      `${CSV_NAME} 里 ${me} 有 ${mine.length} 行，描述不一致：${descriptions.map((d) => `「${d}」`).join(' 和 ')}。` +
        '请删掉多余的行。',
    );
  }
  const tags = mine.flatMap((row) => String(row[2] ?? '').split(/[;；]/)).map(clean).filter(usefulTag);
  return { kind: 'csv', source: `csv:${CSV_NAME}`, description: descriptions[0] ?? '', tags, notes: '' };
}

/**
 * 同名 json 里别人写的键。
 *
 * 从 archive.org 这类地方下载的素材，旁边自带一个同名 json，里面有 title、
 * description、tags。那是**人写的、准确的**，比本地 AI 去理解一段没人说话的
 * 风景素材靠得多。所以它是一个正经的输入源，不是障碍。
 *
 * 排在同名文本和表格之后：那两个是你特意为这个插件写的，更能代表你现在的意图。
 */
function readClipJson(record, clipPath) {
  const theirs = foreignKeysOf(record);
  if (Object.keys(theirs).length === 0) return null;

  // 拿 title 当描述，不拿 description。这是被真实数据教的：archive.org 的
  // description 常常是推广文案（"Please visit my blog to see all of my stock
  // video footage..."），而 title 短、可靠、总在说画面。
  // 他们那段长 description 有用但不该当描述，所以放进 notes——notes 是自由文本，
  // 我们不解析，只在写文稿和挑素材时交给模型看。
  const description = clean(theirs.title) || clean(theirs.description);
  const notes = clean(theirs.title) ? clean(theirs.description) : '';

  // search_term 是这类文件里最有用的一个词：干净、单个、高信息量。
  // 而 tags 里大半是 HD / 1920x1080 / H.264 这种每个素材都有的格式噪音。
  const listed = Array.isArray(theirs.tags) ? theirs.tags.map(String) : [];
  const tags = nonEmpty([clean(theirs.search_term), ...listed]).filter(usefulTag);

  if (description === '' && notes === '' && tags.length === 0) return null;
  return {
    kind: 'clipjson',
    source: `clipjson:${basename(clipPath).replace(/\.[^.]*$/, '')}.json`,
    description,
    tags,
    notes,
  };
}

/** 你跟插件说的话。 */
function readChat(chat) {
  if (!chat) return null;
  const tags = nonEmpty(chat.tags ?? []).filter(usefulTag);
  const description = clean(chat.description);
  const notes = clean(chat.notes);
  if (description === '' && notes === '' && tags.length === 0) return null;
  return {
    kind: 'chat',
    source: chat.date ? `chat:${chat.date}` : 'chat',
    description,
    tags,
    notes,
  };
}

// ── 合并 ──────────────────────────────────────────────────────────────

/**
 * 收拢一段素材的 `fromYou`。
 *
 * `sources` 列出**每个找到了东西的读取器**，不管它有没有赢。这样你能看出插件
 * 去哪些地方看过、看到了什么，而且这个列表是确定的，重跑不会变。
 *
 * 已知限制：出处是整节级别的，不是逐字段的。如果描述来自对话、而你手改了一个
 * 标签，`sources` 可能把两者都记成 `chat:<日期>`。要逐字段精确，得在契约里加
 * 逐字段出处，现在不值得。
 *
 * `csvRows` 是可选的：传进来就复用，不传就自己读一次 `clips.csv`。
 */
export async function collectFromYou({ clipPath, assetsRoot, chat, csvRows }) {
  const record = await readClipFile(clipPath);
  const derived = [
    readChat(chat),
    await readSidecar(clipPath),
    await readCsv(clipPath, assetsRoot, csvRows),
    readClipJson(record, clipPath),
    readFilename(clipPath),
    readFolder(clipPath, assetsRoot),
  ].filter(Boolean);

  const previous = record?.fromYou;
  const candidates = [...derived];
  const replaced = [];

  // 手改检测。一个存着的值推导不出来，有两种可能：你手写的，或者我们自己
  // 上一个版本的输出。靠 origin 分辨。
  if (previous) {
    const derivedOf = (field) => new Set(nonEmpty(derived.map((d) => d[field])));
    const derivedTags = new Set(derived.flatMap((d) => d.tags));
    const base = previous.origin?.derived; // 上次我们推导出来的东西，当合并基准
    const stick = { description: '', notes: '' };
    // 描述只在空的时候填。一旦有了值就是你的，插件再也不碰它——包括它自己
    // 上一版填进去的值。想让它重新填，把那个字段清空再扫一次。
    // 这条规则简单到不会出错，代价是插件不会自动纠正一个填错的描述。
    if (clean(previous.description) !== '') {
      candidates.push({
        kind: 'manual',
        // 沿用原来的出处标签，不发明一个新的。发明新标签会让第二次运行的结果
        // 和第一次不一样，可重跑就断了。
        source: clean(previous.origin?.description) || 'manual',
        description: clean(previous.description),
        notes: '',
        tags: [],
      });
    }
    for (const field of ['notes']) {
      const held = clean(previous[field]);
      if (held === '' || derivedOf(field).has(held)) continue;
      if (base === undefined) {
        // 老文件没有基准（这个机制之前写的）。分不出来就让新推导赢，但要说出来，
        // 免得用户以为自己写的东西不声不响没了。原文还在 .bak 和输入源里。
        replaced.push({ field, was: held, reason: '没有合并基准，按我们的旧输出处理' });
      } else if (held === clean(base[field])) {
        // 和上次推导的一模一样，就是我们的旧输出。
        replaced.push({ field, was: held, reason: '是上一版推导出来的值' });
      } else {
        stick[field] = held; // 我们写完之后被改过，这才是你的手改
      }
    }
    // 标签同理：上次推导出来有、现在推导不出来的，是旧输出；从来没推导出来过的，
    // 是你自己加的。
    const baseTags = new Set(nonEmpty(base?.tags ?? []));
    const stickyTags = nonEmpty(previous.tags ?? []).filter(
      (t) => !derivedTags.has(t) && !baseTags.has(t),
    );

    if (stick.description !== '' || stick.notes !== '' || stickyTags.length > 0) {
      const priorChat = (previous.sources ?? []).find((x) => x.startsWith('chat:'));
      const fromChat = priorChat !== undefined && !chat;
      candidates.push({
        kind: fromChat ? 'chat' : 'manual',
        source: fromChat ? priorChat : 'manual',
        description: stick.description,
        notes: stick.notes,
        tags: stickyTags,
      });
    }
  }

  const byPriority = [...candidates].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
  const winner = (field) => byPriority.find((c) => clean(c[field]) !== '');

  // 标签按优先级顺序合并去重，所以顺序也是确定的。
  const tags = [];
  for (const c of byPriority) for (const t of c.tags) if (!tags.includes(t)) tags.push(t);

  // 把这一次推导出来的东西记下来，当下一次的合并基准。只记推导来源，
  // 不含手改和对话——那两个本来就该粘住。
  const derivedOnly = derived.filter((c) => c.kind !== 'chat');
  const derivedTagList = [];
  for (const c of derivedOnly) for (const t of c.tags) if (!derivedTagList.includes(t)) derivedTagList.push(t);
  const pickDerived = (field) => clean(
    [...derivedOnly].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind])
      .find((c) => clean(c[field]) !== '')?.[field],
  );
  const origin = {
    description: winner('description')?.source ?? '',
    notes: winner('notes')?.source ?? '',
    derived: { description: pickDerived('description'), notes: pickDerived('notes'), tags: derivedTagList },
  };

  return {
    description: clean(winner('description')?.description),
    tags,
    notes: clean(winner('notes')?.notes),
    segments: previous?.segments ?? [],
    sources: [...new Set(candidates.map((c) => c.source))].sort(),
    origin,
    ...(replaced.length > 0 ? { replaced } : {}),
  };
}
