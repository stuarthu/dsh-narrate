// 字幕：转义、换行、样式。契约：docs/crew/api/flow-stages.md
//
// 竖屏和横屏是两套规则，不是一套加个参数。竖屏一行放不下多少字（中文十几个），
// 字号要大得多（手机上看），位置要高得多（别被操作条压住）。
//
// 转义放在这里而不是渲染那一步，因为它是字幕的事。实测过两件事，都有测试守着：
//   - libass 把 `{...}` 当覆盖标签，`{备注}一句话` 会把那几个字整段吃掉；
//   - 文本里的空行会结束当前字幕，后面的内容能伪造成第二条。

/**
 * 两套规则。`maxWidth` 用的是**显示宽度**：一个中文字算 2，一个拉丁字符算 1。
 * 所以竖屏 30 约等于 15 个中文字，横屏 56 约等于 28 个。
 */
export const SUBTITLE_RULES = Object.freeze({
  landscape: Object.freeze({ maxWidth: 56, maxLines: 2, fontSize: 42, marginV: 60, outline: 3 }),
  portrait: Object.freeze({ maxWidth: 30, maxLines: 2, fontSize: 60, marginV: 220, outline: 4 }),
});

const rulesFor = (aspect) => SUBTITLE_RULES[aspect] ?? SUBTITLE_RULES.landscape;

/** 中日韩、以及全角标点，都算两格宽。 */
const WIDE = /[ᄀ-ᅟ⺀-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/;

/** 一段文字在屏幕上占几格。 */
export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text ?? '')) width += WIDE.test(ch) ? 2 : 1;
  return width;
}

/** 能断行的地方：中文标点后面，或者空格处。 */
const BREAK_AFTER = /[，。！？；：、,.!?;:—…）】」』]/;

/**
 * 把一句话折成几行。
 *
 * 优先在标点后面断，其次在空格处断（英文绝不切断一个词），都不行才按宽度硬断。
 * 超过最大行数时**照样把字全留着**，只是把 `overflow` 标成 true——悄悄截掉用户的
 * 字是最坏的做法。停点 2 已经就长句提醒过一次了。
 */
export function wrapSubtitle(text, aspect) {
  const source = String(text ?? '').trim();
  if (source === '') return { lines: [], overflow: false };
  const { maxWidth, maxLines } = rulesFor(aspect);

  const lines = [];
  let line = '';
  let lastBreak = -1; // line 里最后一个"可以断"的位置

  const flush = (upTo = line.length) => {
    const kept = line.slice(0, upTo).trim();
    if (kept !== '') lines.push(kept);
    line = line.slice(upTo).trim();
    lastBreak = -1;
  };

  for (const ch of source) {
    line += ch;
    if (BREAK_AFTER.test(ch) || ch === ' ') lastBreak = line.length;
    if (displayWidth(line) < maxWidth) continue;
    // 到宽度了。能在最近的可断点断就断，否则硬断。
    if (lastBreak > 0 && lastBreak < line.length) flush(lastBreak);
    else flush();
  }
  flush();

  return { lines, overflow: lines.length > maxLines };
}

/**
 * 把一句话整理成能安全放进 SRT 的样子。
 *
 * 花括号和反斜杠转义，空行去掉。单个换行留着——换行是这里自己加的。
 */
export function escapeSubtitle(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

/** 秒变成 SRT 的时间写法，例如 3725.5 变成 01:02:05,500。 */
export function srtTime(seconds) {
  const ms = Math.max(0, Math.round(Number(seconds) * 1000));
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}`
    + `:${pad(Math.floor((ms % 60000) / 1000))},${pad(ms % 1000, 3)}`;
}

/** 一条 SRT 字幕：编号、时间、折好行并转义过的正文。 */
export function srtBlock(index, startSec, endSec, text, aspect) {
  const { lines } = wrapSubtitle(text, aspect);
  const body = lines.map((line) => escapeSubtitle(line)).filter((line) => line !== '').join('\n');
  return `${index}\n${srtTime(startSec)} --> ${srtTime(endSec)}\n${body}\n\n`;
}

/**
 * 给 ffmpeg 的 `subtitles=...:force_style=` 用的样式串。
 *
 * 里面绝不能出现单引号或冒号——`subtitles` 滤镜会被它们切断，整条命令就废了。
 * 描边一定要开：亮画面上没有描边的白字看不见。
 */
export function forceStyle(aspect) {
  const { fontSize, marginV, outline } = rulesFor(aspect);
  return [
    `FontSize=${fontSize}`,
    'PrimaryColour=&H00FFFFFF',
    'OutlineColour=&H80000000',
    'BorderStyle=1',
    `Outline=${outline}`,
    'Shadow=0',
    'Alignment=2',
    `MarginV=${marginV}`,
  ].join(',');
}
