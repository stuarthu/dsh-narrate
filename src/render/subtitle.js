// 字幕：转义、换行、样式。契约：docs/crew/api/flow-stages.md
//
// 竖屏和横屏是两套规则，不是一套加个参数。竖屏一行放不下多少字（中文十几个），
// 字号要大得多（手机上看），位置要高得多（别被操作条压住）。
//
// 转义放在这里而不是渲染那一步，因为它是字幕的事。实测过两件事，都有测试守着：
//   - libass 把 `{...}` 当覆盖标签，`{备注}一句话` 会把那几个字整段吃掉；
//   - 文本里的空行会结束当前字幕，后面的内容能伪造成第二条。
//
// **为什么写 `.ass` 而不是 `.srt` 加 `force_style`。** 原来是后者，字号和边距写的是像素，
// 但 libass 会把这些数字按 `画面高 / 脚本高` 缩放，而脚本高在没写的时候默认是 288。
// 实测：1920x1080 上 `MarginV=60` 画出来离底 248 像素；1080x1920 上 `MarginV=220`
// 画出来离底 **1525** 像素——字幕跑到了画面顶部，而当时所有测试都是绿的。写成 `.ass`
// 并把 `PlayResX/PlayResY` 钉成目标分辨率，这些数字才真的是像素。

/**
 * 两套规则。`maxWidth` 用的是**显示宽度**：一个中文字算 2，一个拉丁字符算 1。
 * 所以竖屏 30 约等于 15 个中文字，横屏 56 约等于 28 个。
 */
export const SUBTITLE_RULES = Object.freeze({
  landscape: Object.freeze({
    maxWidth: 56, maxLines: 2, fontRatio: 0.0333, marginRatio: 0.074, fontName: 'Sans',
  }),
  portrait: Object.freeze({
    // 竖直边距大得多：手机下面那条操作栏会压住画面底部。
    maxWidth: 30, maxLines: 2, fontRatio: 0.070, marginRatio: 0.208, fontName: 'Sans',
  }),
});

/**
 * 把比例换成这个分辨率下的像素。
 *
 * **字号按画面宽算，竖直边距按画面高算。** 这不是随手定的：一行放多少字（`maxWidth`）
 * 受画面宽限制，所以字号必须跟着宽走，不然 1080 宽的竖屏上一行字会溢出去；而"别被手机
 * 操作栏压住"是画面高的百分比。
 *
 * 用比例而不是像素，是因为绝对像素在不同分辨率下含义不一样：同一套预设，1080p 和 720p
 * 出来的字幕大小会差一截。写成比例，任何分辨率看起来都一样。
 */
export function stylePixels(aspect, width, height) {
  const { fontRatio, marginRatio, fontName, maxWidth } = rulesFor(aspect);
  const marginH = Math.max(8, Math.round(width * 0.025));
  // 一行满字必须放得下。比例算出来的字号如果太大就夹住——别指望调用方总把竖屏
  // 配竖屏尺寸；给个 1920x1080 的目标配竖屏样式，一行字就会溢出画面。
  const fits = Math.floor((width - 2 * marginH) / (maxWidth / 2));
  const fontSize = Math.max(12, Math.min(Math.round(width * fontRatio), fits));
  return {
    fontName,
    fontSize,
    // 描边跟着字号走。字大了描边不跟着大，亮画面上就压不住。
    outline: Math.max(2, Math.round(fontSize / 16)),
    marginH,
    marginV: Math.max(8, Math.round(height * marginRatio)),
  };
}

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

/** 秒变成 ASS 的时间写法，例如 3725.5 变成 1:02:05.50。ASS 只精确到百分之一秒。 */
export function assTime(seconds) {
  const cs = Math.max(0, Math.round(Number(seconds) * 100));
  const pad = (n) => String(n).padStart(2, '0');
  return `${Math.floor(cs / 360000)}:${pad(Math.floor((cs % 360000) / 6000))}`
    + `:${pad(Math.floor((cs % 6000) / 100))}.${pad(cs % 100)}`;
}

/** ASS 的颜色是 &HAABBGGRR，A 是"透明度"——0 是全不透明。 */
const WHITE = '&H00FFFFFF';
const OUTLINE = '&H80000000';

/**
 * 一整份 `.ass` 字幕文件。
 *
 * `cues`：`[{ startSec, endSec, text }]`。`width`/`height` 是**成片的**分辨率，会写进
 * `PlayResX/PlayResY`——这是让字号和边距真的等于像素的唯一办法。
 *
 * `WrapStyle: 2` 是"只在我写的地方换行"。换行是 `wrapSubtitle` 按显示宽度算好的，
 * 不能让 libass 再自己折一次。
 */
export function assDocument({ cues = [], aspect, width, height }) {
  const { fontName, fontSize, outline, marginH, marginV } = stylePixels(aspect, width, height);
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${Math.round(width)}`,
    `PlayResY: ${Math.round(height)}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour,'
      + ' BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle,'
      + ' BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Alignment=2 是底部居中。描边一定要开：亮画面上没有描边的白字看不见。
    `Style: N,${fontName},${fontSize},${WHITE},${WHITE},${OUTLINE},${OUTLINE},`
      + `0,0,0,0,100,100,0,0,1,${outline},0,2,${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = cues.map((cue) => {
    // ASS 里 `\N` 是硬换行。Text 是最后一个字段，所以正文里的逗号不用管。
    const body = wrapSubtitle(cue.text, aspect).lines
      .map((line) => escapeSubtitle(line)).filter((line) => line !== '')
      .join('\\N')
      // 剩下的真换行也要变成 `\N`。**真的换行会结束这一条事件**，不换的话一段带换行
      // 的文本能伪造出第二条 Dialogue。实测过：一句里塞一行 `Dialogue: ...` 就成了。
      .replace(/\r?\n/g, '\\N');
    return `Dialogue: 0,${assTime(cue.startSec)},${assTime(cue.endSec)},N,,0,0,0,,${body}`;
  });
  return `${[...head, ...events].join('\n')}\n`;
}
