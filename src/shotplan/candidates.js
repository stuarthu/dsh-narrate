// 三层漏斗：为一句话挑出候选画面。契约：docs/crew/api/assetsindex-shotplan.md 版本 11
//
// 三层从便宜到贵：
//   1. 时长——描述覆盖的时间窗盖不住这句旁白的，直接排除。只读 JSON。
//   2. 文字——`description`、`tags`、`notes` 的词重叠，标签按稀有度加权。只读 JSON。
//   3. 画面——拿 agent 给的英文查询去画面搜索，把起点定到某一秒。**可选。**
//
// 这里**只挑候选，不做分配**。哪一句最后用哪一段，是下一步的事：100 句话、20 段
// 素材，逐句取最优会让很多句挑到同一段，成片反复闪同一个画面。那是分配问题。
import { basename } from 'node:path';

/**
 * 一句话大概要念多少秒。
 *
 * **挑画面在配音之前**（停点 3 在停点 4 前面），所以这里没有真实音频，只能估。
 * 而且必须**偏保守，宁可估长**：估短了会挑中一段其实盖不住的素材，等到渲染才发现，
 * 那时候用户已经在停点 3 点过头了。估长了只是候选少一点。
 *
 * 中文正常朗读每秒 4 到 5 个字，这里按每秒 3 个字算。
 *
 * 语速是按**字符类别**算的（中日韩字、拉丁词、标点各一个费率），所以不需要告诉它
 * 语言——中英混排的句子会自动按混排算。
 */
const CJK_SECONDS = 1 / 3; // 每个中日韩字
const WORD_SECONDS = 0.42; // 每个拉丁词
const PAUSE_SECONDS = 0.25; // 每个标点

const CJK = /[㐀-䶿一-鿿぀-ヿ가-힯]/;
const PUNCT = /[，。！？；：、,.!?;:—…]/;

export function estimateSpeechSeconds(text) {
  const source = String(text ?? '').trim();
  if (source === '') return 0;
  let seconds = 0;
  let inWord = false;
  for (const ch of source) {
    if (CJK.test(ch)) {
      seconds += CJK_SECONDS;
      inWord = false;
    } else if (PUNCT.test(ch)) {
      seconds += PAUSE_SECONDS;
      inWord = false;
    } else if (/[\s]/.test(ch)) {
      inWord = false;
    } else {
      // 连续的拉丁字母算一个词，不是一个字母一份时间。
      if (!inWord) seconds += WORD_SECONDS;
      inWord = true;
    }
  }
  return Math.round(seconds * 1000) / 1000;
}

/**
 * 把一段文字切成可比较的词。
 *
 * 中文没有分词器，所以用**字符二元组**：「服务器」切成「服务」「务器」。句子和描述
 * 里都出现的话就能对上。这是不上分词器时的标准做法，也是它的上限——单字的词对不上。
 * 拉丁文按空白切词。
 */
export function tokenize(text) {
  const source = String(text ?? '').toLowerCase();
  const terms = new Set();
  for (const piece of source.split(/[^\p{L}\p{N}]+/u)) {
    if (piece === '') continue;
    if (CJK.test(piece)) {
      if ([...piece].length === 1) terms.add(piece);
      const chars = [...piece];
      for (let i = 0; i < chars.length - 1; i += 1) terms.add(chars[i] + chars[i + 1]);
    } else {
      terms.add(piece);
    }
  }
  return terms;
}

/** 一段素材的全部文字证据：机器写的描述、你写的描述、标签、备注。 */
function clipText(record) {
  const machine = (record.fromMachine?.segments ?? []).map((s) => `${s.description} ${(s.tags ?? []).join(' ')}`);
  const yours = record.fromYou ?? {};
  return [...machine, yours.description, (yours.tags ?? []).join(' '), yours.notes]
    .filter((x) => typeof x === 'string' && x !== '')
    .join(' ');
}

/**
 * 每个词值多少分，按它在**整个素材集里**的稀有度算。
 *
 * 一个所有素材都有的词携带零信息量。真实素材里这类样板词占大半（`Fair Use`、
 * `Public Domain`、`Royalty Free`、`Stock Footage`、`Broll`），不加权的话第二层会把
 * 每段素材都算成"匹配"，等于白做。
 *
 * 权重必须在**整批**上算，不能逐句算——稀有度是素材集的性质，不是句子的性质。
 */
export function termWeights(clips) {
  const total = clips.length;
  const seenIn = new Map();
  for (const record of clips) {
    // 先收成这一段素材的词集合，再每个词只加一次。
    // 数的是"多少段素材含这个词"，不是"出现几次"——同一段里数两次会把稀有词
    // 算成常见词，稀有度加权就失效了。整条标签（含空格）也当一个词参与。
    const terms = tokenize(clipText(record));
    for (const tag of record.fromYou?.tags ?? []) {
      const key = String(tag).toLowerCase().trim();
      if (key !== '') terms.add(key);
    }
    for (const term of terms) seenIn.set(term, (seenIn.get(term) ?? 0) + 1);
  }
  const weights = new Map();
  for (const [term, count] of seenIn) {
    // 每段都有 → 接近 0。只有一两段有 → 明显大于 0。
    weights.set(term, Math.log((total + 1) / (count + 1)));
  }
  return weights;
}

/** 一句话和一段描述的文字重叠分。 */
function overlapScore(sentenceTerms, text, tags, weights) {
  let score = 0;
  const counted = new Set();
  for (const term of tokenize(text)) {
    if (!sentenceTerms.has(term) || counted.has(term)) continue;
    counted.add(term);
    score += weights.get(term) ?? 0;
  }
  for (const tag of tags ?? []) {
    const key = String(tag).toLowerCase().trim();
    if (key === '' || counted.has(key)) continue;
    // 整条标签直接出现在句子里，或者它的二元组和句子有交集
    const hit = sentenceTerms.has(key) || [...tokenize(key)].some((t) => sentenceTerms.has(t));
    if (!hit) continue;
    counted.add(key);
    score += weights.get(key) ?? 0;
  }
  return Math.round(score * 1000) / 1000;
}

const round = (n) => Math.round(n * 1000) / 1000;

/**
 * 为一句话挑候选。
 *
 * `sentence`：`{ id, text, englishQuery? }`。`englishQuery` 由 **agent** 给，而且它
 *   **同时供第 2 层和第 3 层用**。真实素材证明这不是可选的：36 段 archive.org 素材
 *   的标题和标签全是英文，中文句子和它们的字符二元组交集是空的——第 2 层会给每段
 *   素材打 0 分，等于瞎的。给了英文查询，第 2 层就能跨语言匹配，而且不用装任何东西。
 * `clips`：clip 描述记录，每条要带 `clipPath`。
 * `visualSearch`：可选，`({ clipPath, visualSearchDir, query, topK }) => [{ timestamp, score }]`。
 * `weights`：可选，`termWeights(clips)` 的结果。整批算一次传进来更省。
 */
export async function pickCandidates({ sentence, clips, visualSearch, weights, limit = 5 }) {
  const needSeconds = estimateSpeechSeconds(sentence?.text);
  const scale = weights ?? termWeights(clips ?? []);
  // 第 2 层的词 = 句子本身 + agent 给的英文查询。跨语言只能靠后者。
  const sentenceTerms = tokenize(sentence?.text);
  for (const term of tokenize(sentence?.englishQuery)) sentenceTerms.add(term);
  const query = typeof sentence?.englishQuery === 'string' ? sentence.englishQuery.trim() : '';

  const candidates = [];
  const dropped = [];
  const layersUsed = new Set([1, 2]);

  for (const record of clips ?? []) {
    const clipPath = record.clipPath;
    const segments = record.fromMachine?.segments ?? [];
    const dir = record.fromMachine?.visualSearchDir ?? '';
    // 素材级的文字分（你写的描述、标签、备注）每段素材只算一次。
    // 原来每个时间段都重算一遍：36 段素材乘句子数，白做很多。
    const clipScore = overlapScore(
      sentenceTerms,
      clipText({ fromYou: record.fromYou, fromMachine: {} }),
      record.fromYou?.tags,
      scale,
    );
    if (segments.length === 0) {
      dropped.push({ clipPath, layer: 1, why: '还没有任何时间段描述，等入库理解完再说' });
      continue;
    }

    let anyFits = false;
    for (const segment of segments) {
      const window = segment.endSec - segment.startSec;
      if (window + 0.001 < needSeconds) continue; // 第 1 层
      anyFits = true;
      candidates.push({
        clipPath,
        startSec: round(segment.startSec),
        endSec: round(segment.startSec + needSeconds),
        score: round(overlapScore(sentenceTerms, segment.description, segment.tags, scale) + clipScore),
        layer: 2,
        confidence: segment.confidence === 'high' ? 'high' : 'low',
        why: `文字重叠；这一段描述覆盖 ${round(segment.startSec)} 到 ${round(segment.endSec)} 秒`
          + (segment.confidence === 'high' ? '' : '；用的是把握不高的描述'),
        visualSearchDir: dir,
      });
    }
    if (!anyFits) {
      const longest = Math.max(...segments.map((s) => s.endSec - s.startSec));
      dropped.push({
        clipPath,
        layer: 1,
        why: `最长的一段描述只覆盖 ${round(longest)} 秒，盖不住这句约 ${needSeconds} 秒的旁白`,
      });
    }
  }

  // 第 3 层：可选。缺任何一样都退回前两层，绝不让这一句没有候选。
  if (visualSearch && query !== '') {
    for (const candidate of candidates) {
      if (!candidate.visualSearchDir) continue;
      let hits;
      try {
        hits = await visualSearch({
          clipPath: candidate.clipPath,
          visualSearchDir: candidate.visualSearchDir,
          query,
          topK: 5,
        });
      } catch {
        continue; // 画面搜索坏了不该拖垮这一句
      }
      const segment = (clips.find((c) => c.clipPath === candidate.clipPath)?.fromMachine?.segments ?? [])
        .find((s) => s.startSec === candidate.startSec);
      const upper = segment ? segment.endSec : Number.POSITIVE_INFINITY;
      const usable = (Array.isArray(hits) ? hits : [])
        .filter((h) => Number.isFinite(h?.timestamp))
        // 搜出来的时间点也要过第 1 层：从那一秒起，描述覆盖的部分要够长
        .filter((h) => h.timestamp >= candidate.startSec && upper - h.timestamp + 0.001 >= needSeconds)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      if (usable.length === 0) continue;
      const best = usable[0];
      candidate.startSec = round(best.timestamp);
      candidate.endSec = round(best.timestamp + needSeconds);
      candidate.score = round(candidate.score + (Number(best.score) || 0) * 10);
      candidate.layer = 3;
      candidate.why += `；画面搜索把起点定在 ${round(best.timestamp)} 秒`;
      layersUsed.add(3);
    }
  }

  // 把握高的先用。同样把握的按分数，再按文件名，好让结果稳定可重跑。
  candidates.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === 'high' ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return basename(a.clipPath).localeCompare(basename(b.clipPath));
  });

  for (const candidate of candidates) delete candidate.visualSearchDir;

  return {
    sentenceId: sentence?.id ?? '',
    needSeconds,
    candidates: candidates.slice(0, limit),
    dropped,
    layersUsed: [...layersUsed].sort(),
  };
}
