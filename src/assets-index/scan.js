// 扫素材文件夹，把每段素材入库。契约：docs/crew/api/assetsindex-shotplan.md 版本 6
//
// 理解视频这一步是**注入**进来的，不是这里直接调的。原因很实在：`video_understand`
// 是一个 dsh 的工具，只在 agent 的工具列表里存在，Node 代码调不到它。所以扫描
// 收一个"理解器"函数，真正的接线在 dsh 挂载那一步。副作用是测试能传一个假的
// 并数它被问了几次，而"没变的素材一次都不该问"正是本模块最要紧的保证。
//
// 另一条贯穿全文的规则：**一个坏素材不能拖垮整次入库。** 几百个素材扫到第 30 个
// 出错就全盘失败，用户会不知道前 29 个到底存下来没有。所以逐个素材兜错，
// 最后一起报。唯一例外是撞名——那是整个文件夹的问题，在动手之前就该停。
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import {
  assertNoStemCollisions,
  fingerprintOf,
  needsMachineRefresh,
  readClipFile,
  writeMachineSection,
  writeYourSection,
} from './clip-file.js';
import { collectFromYou, loadCsvRows } from './from-you.js';

/** 认得的视频扩展名。比较时统一转小写，所以 .MOV 也认。 */
export const VIDEO_EXTENSIONS = Object.freeze([
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.flv', '.ts', '.wmv', '.mpg', '.mpeg',
]);

/** 我们自己写的和人类输入源，都不是素材。 */
const NOT_A_CLIP = /(\.narrate\.txt|\.json|\.tmp)$/i;

export class ScanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScanError';
    this.code = code;
  }
}

/**
 * 递归找素材。点开头的文件和文件夹一律跳过。
 *
 * **软链接要跟进去。** 把素材放在外置硬盘、用一个软链接接进 `assets`，是很常见
 * 的做法。只看目录项本身的话，软链接的目录 `isDirectory()` 返回 false，整个
 * 外置盘会被静默跳过，用户完全不知道发生了什么。所以用 stat 判断类型。
 *
 * 跟进去就要防环：`assets/loop -> assets` 会让递归停不下来。所以记住走过的
 * 真实路径。
 */
async function findClips(dir, seen = new Set()) {
  const here = await realpath(dir);
  if (seen.has(here)) return [];
  seen.add(here);

  const found = [];
  for (const entry of await readdir(dir)) {
    if (entry.startsWith('.')) continue;
    const path = join(dir, entry);
    let info;
    try {
      info = await stat(path); // stat 跟随软链接，lstat 不跟
    } catch {
      continue; // 断掉的软链接，跳过
    }
    if (info.isDirectory()) {
      found.push(...(await findClips(path, seen)));
      continue;
    }
    if (!info.isFile()) continue;
    if (NOT_A_CLIP.test(entry)) continue;
    if (VIDEO_EXTENSIONS.includes(extname(entry).toLowerCase())) found.push(path);
  }
  return found;
}

/**
 * 把理解器给的结果规整成契约要的形状。
 *
 * 理解器可能只给一句整体描述（本地理解的 L0 层就是这样），那就补成覆盖全长的
 * 一个时间段，把握标 low——一句话代表不了十分钟里的几十个画面，说自己没把握
 * 才是诚实的。
 */
function normalizeMachine(raw, clipPath) {
  const durationSec = Number(raw?.durationSec);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new ScanError('E_UNDERSTAND_FAILED', `${basename(clipPath)} 的理解结果没有可用的时长`);
  }
  const round = (n) => Math.round(n * 1000) / 1000;

  const given = Array.isArray(raw.segments) && raw.segments.length > 0
    ? raw.segments
    : [{ startSec: 0, endSec: durationSec, description: raw.description ?? '', confidence: 'low' }];

  const segments = given
    .map((s) => ({
      startSec: round(Math.max(0, Number(s.startSec) || 0)),
      endSec: round(Math.min(durationSec, Number(s.endSec) || 0)),
      description: String(s.description ?? ''),
      tags: Array.isArray(s.tags) ? s.tags.map(String) : [],
      confidence: s.confidence === 'high' ? 'high' : 'low',
    }))
    .filter((s) => s.endSec > s.startSec)
    .sort((a, b) => a.startSec - b.startSec);

  if (segments.length === 0) {
    throw new ScanError('E_UNDERSTAND_FAILED', `${basename(clipPath)} 的理解结果里没有一个有长度的时间段`);
  }
  return {
    durationSec: round(durationSec),
    segments,
    visualSearchDir: raw.visualSearchDir ?? '',
    engine: String(raw.engine ?? 'unknown'),
  };
}

/**
 * 扫一遍素材文件夹。
 *
 * `understand` 是异步函数 `(clipPath) => { durationSec, segments?, description?,
 * visualSearchDir?, engine? }`。
 * `chatByClip` 按文件名给出你跟插件说过的话。
 * `onEvent` 可选，每个素材处理完叫一次，方便报进度。
 */
export async function scanAssets({ assetsRoot, understand, chatByClip = {}, onEvent }) {
  let clipPaths;
  try {
    clipPaths = (await findClips(assetsRoot)).sort();
  } catch (error) {
    throw new ScanError('E_ASSETS_ROOT_UNREADABLE', `读不到素材文件夹 ${assetsRoot}：${error.code}`);
  }

  // 撞名是整个文件夹的问题。在写任何东西、问任何理解之前就停下。
  await assertNoStemCollisions(clipPaths);

  // 表格只解析一次。几百个素材各解析一遍是白做的功。
  const csvRows = await loadCsvRows(assetsRoot);

  const clips = [];
  const understood = [];
  const reused = [];
  const skipped = [];

  for (const clipPath of clipPaths) {
    try {
      const fingerprint = await fingerprintOf(clipPath);

      // 你给的那一节每次都重新翻译：输入源可能变了，而翻译是可重跑的。
      const fromYou = await collectFromYou({
        clipPath,
        assetsRoot,
        chat: chatByClip[basename(clipPath)],
        csvRows,
      });
      // 没变就不写。几百个素材每次扫描都重写一遍是白做的写盘加 fsync。
      const before = await readClipFile(clipPath);
      const changed = JSON.stringify(before?.fromYou) !== JSON.stringify(fromYou);
      const existing = changed ? await writeYourSection(clipPath, fromYou) : before;
      if (!needsMachineRefresh(existing, fingerprint)) {
        reused.push(clipPath);
        clips.push({ clipPath, record: existing });
        onEvent?.({ kind: 'reused', clipPath });
        continue;
      }

      let raw;
      try {
        raw = await understand(clipPath);
      } catch (error) {
        throw new ScanError(
          'E_UNDERSTAND_FAILED',
          `理解不了 ${basename(clipPath)}：${error?.message ?? error}`,
        );
      }
      const record = await writeMachineSection(clipPath, {
        fingerprint,
        fromMachine: normalizeMachine(raw, clipPath),
      });
      understood.push(clipPath);
      clips.push({ clipPath, record });
      onEvent?.({ kind: 'understood', clipPath });
    } catch (error) {
      // 没有错误码说明是意外错误（程序 bug）。绝不能贴成 E_UNDERSTAND_FAILED，
      // 那会把 bug 伪装成"这个视频不好理解"，永远没人去查。
      const code = error?.code ?? 'E_SCAN_INTERNAL';
      const message = error?.message ?? String(error);
      skipped.push({ clipPath, code, message });
      onEvent?.({ kind: 'skipped', clipPath, code, message });
    }
  }

  return { clips, understood, reused, skipped };
}
