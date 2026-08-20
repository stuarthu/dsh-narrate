// 分配和成表：哪一句用哪一段。契约：docs/crew/api/assetsindex-shotplan.md 版本 11
//
// 挑候选是查找，这一步是**分配**。100 句话、20 段素材，每段平均要用 5 次。如果每句
// 独立取"最像的一段"，很多句会挑到同一段，成片反复闪同一个画面。所以要统一分配。
//
// 算法故意做得最笨：用过一次就降权、只看前一句避免来回切。数字都是可调的默认值。
// 提前设计一个复杂的分配算法没有意义——要跑一条真视频看效果才知道该往哪调。
import { basename } from 'node:path';

export const DEFAULTS = Object.freeze({
  /** 一段素材每被用一次，下次的分数减掉多少。 */
  reusePenalty: 1.5,
  /** 一句话的最高分低于"全篇最高分中位数"的这个比例，就算没有合适素材。 */
  matchRatio: 0.5,
  /** 相邻两句撞同一段素材时，额外减多少分让它去挑别的。 */
  adjacentPenalty: 3,
  /**
   * 降权只在"差不多相关"的候选之间起作用：分数低于最高分这个比例的，不参与换花样。
   *
   * 这条是真实素材教的。海浪那两段被用过之后，降权把"下次去看看海"推到了一段完全
   * 不相关的素材上。换花样是为了成片不单调，不是为了配错画面——相关性优先。
   */
  varietyBand: 0.8,
});

const round = (n) => Math.round(n * 1000) / 1000;

function median(numbers) {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * 把候选分配给句子，写出画面对应表和缺素材报告。
 *
 * `sentences`：`[{ id, text }]`，按念的顺序。
 * `candidates`：和 `sentences` 一一对应的 `pickCandidates` 结果。
 *
 * 判断"缺素材"用的是**相对门槛**，不是"分数大于 0"。真实素材上量过：七个句子的
 * 最高分是 10.3 / 12.7 / 9.4 / 5.8 / 7.7 / 9.6 / 3.5，中位数约 9.4。那句真的没有
 * 对应素材的是 3.5——不是 0，但明显低于中位数的一半。用绝对零当门槛会把它当成
 * 匹配上了，缺素材报告就废了。
 */
export function assignShots({
  sentences = [],
  candidates = [],
  reusePenalty = DEFAULTS.reusePenalty,
  matchRatio = DEFAULTS.matchRatio,
  adjacentPenalty = DEFAULTS.adjacentPenalty,
  varietyBand = DEFAULTS.varietyBand,
} = {}) {
  const byId = new Map(candidates.map((c) => [c.sentenceId, c]));

  // 门槛先算：拿每一句自己的最高分，取中位数，再按比例缩。
  const bests = sentences
    .map((s) => byId.get(s.id)?.candidates ?? [])
    .map((list) => Math.max(0, ...list.map((c) => c.score)));
  const threshold = median(bests.filter((b) => b > 0)) * matchRatio;

  const shots = [];
  const missing = [];
  const notes = [];
  const timesUsed = new Map();
  const lowConfidence = [];
  let previousClip = null;

  for (const sentence of sentences) {
    const found = byId.get(sentence.id);
    const list = found?.candidates ?? [];

    // 「太短」和「不相关」是两个完全不同的问题，处置也完全不同：一个要把句子改短
    // 或者补长素材，一个要补相关的素材。所以报告必须分清，不能都说成"没有合适素材"。
    const tooShort = (found?.dropped ?? []).filter((d) => d.layer === 1);
    const needText = `这句约 ${round(found?.needSeconds ?? 0)} 秒`;

    if (list.length === 0) {
      missing.push({
        sentenceId: sentence.id,
        text: sentence.text,
        kind: 'too-short',
        reason: tooShort.length > 0
          ? `${needText}，但 ${tooShort.length} 段素材的描述时间窗都盖不住它。`
            + '把这句改短，或者补一段更长的素材。'
          : `${needText}，一段素材都没有。`,
        droppedForLength: tooShort.length,
      });
      continue;
    }
    const best = Math.max(...list.map((c) => c.score));
    if (best <= 0 || best < threshold) {
      const hint = tooShort.length > 0
        ? `另外还有 ${tooShort.length} 段素材长度盖不住这句（${needText}），把这句改短也许就有得挑了。`
        : '';
      missing.push({
        sentenceId: sentence.id,
        text: sentence.text,
        kind: 'not-relevant',
        reason: (best <= 0
          ? '有素材够长，但没有一段文字上对得上。'
          : `有素材够长，但没有一段够相关：最高分 ${round(best)}，全篇门槛 ${round(threshold)}。`) + hint,
        bestScore: round(best),
        threshold: round(threshold),
        droppedForLength: tooShort.length,
      });
      continue;
    }

    // 换花样只在"差不多相关"的候选里做。相关性优先——降权是为了不单调，
    // 不是为了配错画面。
    const band = list.filter((c) => c.score >= best * varietyBand);
    const pool = band.length > 0 ? band : list;

    // 排序稳定，所以结果可重跑：先看调整后的分，再看文件名。
    const ranked = [...pool].sort((a, b) => {
      const adjust = (c) => c.score
        - reusePenalty * (timesUsed.get(c.clipPath) ?? 0)
        - (c.clipPath === previousClip ? adjacentPenalty : 0);
      const diff = adjust(b) - adjust(a);
      if (Math.abs(diff) > 1e-9) return diff;
      return basename(a.clipPath).localeCompare(basename(b.clipPath));
    });
    const chosen = ranked[0];

    shots.push({
      sentenceId: sentence.id,
      // 契约里叫 assetPath（见 flow-stages.md）。挑素材那一侧内部叫 clipPath，
      // 写进工作文件时要换成契约的名字——渲染那一侧读的就是 assetPath。
      assetPath: chosen.clipPath,
      startSec: chosen.startSec,
      endSec: chosen.endSec,
      subtitle: sentence.text,
      confidence: chosen.confidence,
      score: round(chosen.score),
      why: chosen.why,
    });
    if (chosen.confidence !== 'high') lowConfidence.push(sentence.id);
    timesUsed.set(chosen.clipPath, (timesUsed.get(chosen.clipPath) ?? 0) + 1);
    previousClip = chosen.clipPath;
  }

  // 把握不高的句子合成**一条**提醒。八句各报一次是噪音，不是信息。
  if (lowConfidence.length > 0) {
    notes.push({
      sentenceId: lowConfidence.length === 1 ? lowConfidence[0] : '',
      count: lowConfidence.length,
      sentenceIds: lowConfidence,
      message: lowConfidence.length === shots.length
        ? `全部 ${lowConfidence.length} 句用的都是把握不高的素材描述，画面可能对不上。`
          + '装上画面向量层，或者自己给素材写几句描述，会明显好转。'
        : `有 ${lowConfidence.length} 句用的是把握不高的素材描述（${lowConfidence.join('、')}），`
          + '画面可能对不上，请在停点 3 看一眼。',
    });
  }

  const usage = [...timesUsed.entries()]
    .map(([clipPath, count]) => ({
      clipPath,
      count,
      sentenceIds: shots.filter((s) => s.assetPath === clipPath).map((s) => s.sentenceId),
    }))
    .sort((a, b) => b.count - a.count || basename(a.clipPath).localeCompare(basename(b.clipPath)));

  // 整条片子只用了一段素材，成片会很单调。用户有权提前知道，而不是看完才发现。
  if (usage.length === 1 && shots.length > 1) {
    notes.push({
      sentenceId: '',
      message: `整条片子 ${shots.length} 句都用同一段素材（${basename(usage[0].clipPath)}），`
        + '画面会很单调。补几段素材会好很多。',
    });
  }

  return { shots, missing, notes, usage, threshold: round(threshold) };
}
