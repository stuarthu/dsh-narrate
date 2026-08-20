// 扫素材文件夹，把每段素材入库。契约：docs/crew/api/assetsindex-shotplan.md 版本 10
//
// 理解视频这一步是**注入**进来的，不是这里直接调的。原因很实在：`video_understand`
// 是一个 dsh 的工具，只在 agent 的工具列表里存在，Node 代码调不到它。所以扫描
// 收一个"理解器"函数，真正的接线在 dsh 挂载那一步。副作用是测试能传一个假的
// 并数它被问了几次，而"没变的素材一次都不该问"正是本模块最要紧的保证。
//
// 另一条贯穿全文的规则：**一个坏素材不能拖垮整次入库。** 几百个素材扫到第 30 个
// 出错就全盘失败，用户会不知道前 29 个到底存下来没有。所以逐个素材兜错，
// 最后一起报。唯一例外是撞名——那是整个文件夹的问题，在动手之前就该停。
import { execFile } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, extname, join } from 'node:path';

import {
  MEASURED_SHAPE,
  assertNoStemCollisions,
  needsRemeasure,
  writeMeasuredSection,
  fingerprintOf,
  needsMachineRefresh,
  readClipFile,
  writeMachineSection,
  writeYourSection,
} from './clip-file.js';
import { collectFromYou, loadCsvRows } from './from-you.js';

const run = promisify(execFile);
const FFPROBE = () => process.env.DSH_FFPROBE_PATH || 'ffprobe';

/**
 * 认得的视频扩展名。比较时统一转小写，所以 .MOV 也认。
 *
 * 这个清单是被真实素材打过脸才补齐的：第一次拿真文件夹测试，一个 .ogv 就
 * 被静默跳过了。真实素材来源五花八门，所以宁可列长一点。
 */
export const VIDEO_EXTENSIONS = Object.freeze([
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.flv', '.f4v', '.wmv', '.asf',
  '.mpg', '.mpeg', '.mpe', '.m2v', '.ts', '.mts', '.m2ts', '.vob', '.mxf',
  '.ogv', '.ogg', '.3gp', '.3g2', '.divx', '.rm', '.rmvb',
]);

/**
 * 明确不是素材的扩展名。落在这里的文件安静跳过，其余认不出来的要**报出来**——
 * 静默跳过会让用户以为素材入库了，其实根本没读到。
 */
const NOT_MEDIA_EXTENSIONS = Object.freeze([
  '.txt', '.json', '.csv', '.tsv', '.md', '.log', '.yml', '.yaml', '.ini', '.cfg',
  '.srt', '.ass', '.ssa', '.vtt', '.sub', '.nfo', '.url', '.html', '.htm', '.xml',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.svg', '.ico',
  '.pdf', '.zip', '.7z', '.rar', '.gz', '.tar', '.tmp', '.part', '.crdownload', '.bak', '.orig',
]);

/** 我们自己写的和人类输入源，都不是素材。 */
const NOT_A_CLIP = /(\.narrate\.txt|\.json|\.tmp|\.bak)$/i;

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
async function findClips(dir, seen = new Set(), unknown = []) {
  const here = await realpath(dir);
  if (seen.has(here)) return { found: [], unknown };
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
      found.push(...(await findClips(path, seen, unknown)).found);
      continue;
    }
    if (!info.isFile()) continue;
    if (NOT_A_CLIP.test(entry)) continue;
    const ext = extname(entry).toLowerCase();
    if (VIDEO_EXTENSIONS.includes(ext)) found.push(path);
    else if (!NOT_MEDIA_EXTENSIONS.includes(ext)) unknown.push(path);
  }
  return { found, unknown };
}

/**
 * 量一段素材的时长。
 *
 * 只量时长。分辨率、帧率、编码、容器都不存——它们不影响"哪段素材配哪句话"，
 * 存了也没人读。
 *
 * 但时长是承重的：挑素材的第一层漏斗就是"从起点算剩余长度盖不住这句旁白的
 * 直接排除"，渲染时也要按它裁。而且它必须**量**，不能信别人写的：真实素材里
 * 下载来源自己写的 `duration_seconds` 就和实际有出入。
 *
 * 这一步很便宜（一个素材约 30 毫秒），所以每次入库都重量，不一致就重写。
 */
export async function measureClip(clipPath) {
  let out;
  try {
    ({ stdout: out } = await run(FFPROBE(), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clipPath,
    ]));
  } catch (error) {
    throw new ScanError('E_ASSET_UNREADABLE', `ffprobe 读不出 ${basename(clipPath)} 的时长：${error.message}`);
  }
  const durationSec = Number(String(out).trim());
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new ScanError('E_ASSET_UNREADABLE', `${basename(clipPath)} 量不出时长`);
  }
  return { durationSec: Math.round(durationSec * 1000) / 1000 };
}

/**
 * 把理解器给的结果规整成契约要的形状。
 *
 * 理解器可能只给一句整体描述（本地理解的 L0 层就是这样），那就补成覆盖全长的
 * 一个时间段，把握标 low——一句话代表不了十分钟里的几十个画面，说自己没把握
 * 才是诚实的。
 */
function normalizeMachine(raw, clipPath, durationSec) {
  const round = (n) => Math.round(n * 1000) / 1000;

  const given = Array.isArray(raw?.segments) && raw.segments.length > 0
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
    segments,
    visualSearchDir: raw?.visualSearchDir ?? '',
    engine: String(raw?.engine ?? 'unknown'),
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
export async function scanAssets({ assetsRoot, understand, measure = measureClip, chatByClip = {}, onEvent }) {
  let clipPaths;
  let unknownPaths;
  try {
    const walked = await findClips(assetsRoot);
    clipPaths = walked.found.sort();
    unknownPaths = walked.unknown.sort();
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
  // 认不出扩展名的文件先记下来。它们可能就是用户想用的素材，
  // 静默跳过等于骗人。
  const skipped = unknownPaths.map((clipPath) => ({
    clipPath,
    code: 'E_UNKNOWN_MEDIA',
    message: `不认识的扩展名 ${extname(clipPath) || '（没有扩展名）'}。如果它是素材，告诉我这个扩展名，我加进清单`,
  }));

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
      // 规格每次都量，便宜，而且这是"存的和实际不一致就重写"的落实办法。
      let existing = changed ? await writeYourSection(clipPath, fromYou) : before;
      if (needsRemeasure(existing, fingerprint)) {
        const measured = await measure(clipPath);
        if (JSON.stringify(existing?.measured ?? {}) !== JSON.stringify({ shape: MEASURED_SHAPE, ...measured })) {
          existing = await writeMeasuredSection(clipPath, measured);
        }
      }

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
        fromMachine: normalizeMachine(raw, clipPath, existing.measured.durationSec),
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
