// T-09 的字幕测试。契约：docs/crew/api/flow-stages.md
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SUBTITLE_RULES,
  displayWidth,
  wrapSubtitle,
  escapeSubtitle,
  srtBlock,
  forceStyle,
} from '../src/render/subtitle.js';

describe('T-09 字幕：横屏和竖屏两套规则', () => {
  test('竖屏一行放的字更少，字号更大，位置更高', () => {
    const wide = SUBTITLE_RULES.landscape;
    const tall = SUBTITLE_RULES.portrait;
    assert.ok(tall.maxWidth < wide.maxWidth, '竖屏一行该放更少');
    assert.ok(tall.fontSize > wide.fontSize, '竖屏字号该更大');
    assert.ok(tall.marginV > wide.marginV, '竖屏字幕该更高，别被手机的操作条压住');
  });

  test('宽度按显示宽度算：一个中文字顶两个拉丁字符', () => {
    assert.equal(displayWidth('中文'), 4);
    assert.equal(displayWidth('abcd'), 4);
    assert.equal(displayWidth('中a'), 3);
    assert.equal(displayWidth(''), 0);
  });

  test('短句不换行', () => {
    const got = wrapSubtitle('很短的一句。', 'portrait');
    assert.equal(got.lines.length, 1);
    assert.equal(got.lines[0], '很短的一句。');
    assert.equal(got.overflow, false);
  });

  test('长句会换行，而且竖屏比横屏早换', () => {
    const text = '这是一句故意写得比较长的话，好让它必须换行才放得下。';
    const tall = wrapSubtitle(text, 'portrait');
    const wide = wrapSubtitle(text, 'landscape');
    assert.ok(tall.lines.length >= wide.lines.length, '竖屏该换更多行');
    for (const line of tall.lines) {
      assert.ok(displayWidth(line) <= SUBTITLE_RULES.portrait.maxWidth,
        `这一行超宽了：「${line}」宽 ${displayWidth(line)}`);
    }
  });

  test('能在标点处断就在标点处断，不硬切', () => {
    // 这句宽度超过竖屏上限，必须换行；逗号在上限之前，所以该断在逗号后面
    const got = wrapSubtitle('前半句在这里说完了，然后后半句才开始慢慢地说下去。', 'portrait');
    assert.ok(got.lines.length >= 2, `该换行，实际 ${JSON.stringify(got.lines)}`);
    assert.ok(got.lines[0].endsWith('，'), `第一行该断在逗号后，实际「${got.lines[0]}」`);
  });

  test('刚好等于上限的一行不换行', () => {
    const exact = '前半句说完了，后半句才开始说。'; // 显示宽度正好 30
    assert.equal(displayWidth(exact), SUBTITLE_RULES.portrait.maxWidth);
    assert.equal(wrapSubtitle(exact, 'portrait').lines.length, 1);
  });

  test('英文在空格处断，绝不切断一个词', () => {
    const got = wrapSubtitle('This sentence is deliberately long enough that it has to wrap somewhere.', 'portrait');
    assert.ok(got.lines.length >= 2);
    for (const line of got.lines) {
      assert.ok(!line.startsWith(' ') && !line.endsWith(' '), `行首尾不该有空格：「${line}」`);
      for (const word of line.split(' ')) {
        assert.ok(word.length > 0);
      }
    }
    // 把行拼回去，词一个都不能少
    assert.equal(got.lines.join(' ').replace(/\s+/g, ' '),
      'This sentence is deliberately long enough that it has to wrap somewhere.');
  });

  test('超过最大行数时照样把字全留着，但标出来', () => {
    const text = '一二三四五六七八九十'.repeat(5);
    const got = wrapSubtitle(text, 'portrait');
    assert.ok(got.lines.length > SUBTITLE_RULES.portrait.maxLines);
    assert.equal(got.overflow, true, '放不下要标出来，不能悄悄截掉');
    assert.equal(got.lines.join(''), text, '一个字都不许丢');
  });

  test('空文本返回空行数组，不报错', () => {
    const got = wrapSubtitle('', 'portrait');
    assert.deepEqual(got.lines, []);
    assert.equal(got.overflow, false);
  });

  test('不认识的比例退回横屏规则，不报错', () => {
    const got = wrapSubtitle('一句话。', 'square');
    assert.equal(got.lines.length, 1);
  });
});

describe('T-09 字幕：文本是数据，不是指令', () => {
  test('花括号被转义，不会被 libass 当标签吃掉', () => {
    assert.equal(escapeSubtitle('{备注}一句话'), '\\{备注\\}一句话');
  });

  test('空行被去掉，伪造不出第二条字幕', () => {
    const nasty = '第一句\n\n2\n00:00:00,000 --> 00:00:02,000\n偷插的第二句';
    const escaped = escapeSubtitle(nasty);
    const blocks = escaped.split(/\n\s*\n/).filter((b) => b.trim() !== '');
    assert.equal(blocks.length, 1);
    assert.ok(escaped.includes('偷插的第二句'), '被注入的字该作为普通文字留着');
  });

  test('反斜杠被转义', () => {
    assert.equal(escapeSubtitle('路径 C:\\temp 里'), '路径 C:\\\\temp 里');
  });

  test('普通中文一个字都不动', () => {
    assert.equal(escapeSubtitle('这是正常的一句话。'), '这是正常的一句话。');
  });
});

describe('T-09 字幕：生成 SRT', () => {
  test('时间写法和换行都对', () => {
    const block = srtBlock(1, 0, 2.48, '很短的一句。', 'landscape');
    const lines = block.trim().split('\n');
    assert.equal(lines[0], '1');
    assert.equal(lines[1], '00:00:00,000 --> 00:00:02,480');
    assert.equal(lines[2], '很短的一句。');
  });

  test('长句在 SRT 里就是多行，而且已经转义过', () => {
    const block = srtBlock(2, 1, 6, '{注}这是一句故意写得比较长的话，好让它必须换行。', 'portrait');
    const body = block.trim().split('\n').slice(2);
    assert.ok(body.length >= 2, '该有多行');
    assert.ok(block.includes('\\{注\\}'), '该转义过');
  });

  test('超过一小时也写得对', () => {
    const block = srtBlock(1, 3725.5, 3728, '一句话。', 'landscape');
    assert.ok(block.includes('01:02:05,500'), block);
  });

  test('空文本也给出一个合法的块，不产生半个 SRT', () => {
    const block = srtBlock(1, 0, 1, '', 'landscape');
    assert.match(block, /^1\n00:00:00,000 --> 00:00:01,000\n\n\n$/);
  });
});

describe('T-09 字幕：给 ffmpeg 的样式', () => {
  test('竖屏的字号和边距都比横屏大', () => {
    const wide = forceStyle('landscape');
    const tall = forceStyle('portrait');
    const size = (s) => Number(/FontSize=(\d+)/.exec(s)[1]);
    const margin = (s) => Number(/MarginV=(\d+)/.exec(s)[1]);
    assert.ok(size(tall) > size(wide));
    assert.ok(margin(tall) > margin(wide));
  });

  test('样式串里没有会把 ffmpeg 滤镜切断的字符', () => {
    for (const aspect of ['landscape', 'portrait']) {
      const style = forceStyle(aspect);
      assert.ok(!style.includes("'"), `不能有单引号：${style}`);
      assert.ok(!style.includes(':'), `不能有冒号，那会切断 subtitles 滤镜：${style}`);
    }
  });

  test('描边和阴影都开着，否则亮画面上看不见白字', () => {
    const style = forceStyle('landscape');
    assert.match(style, /Outline=[1-9]/);
    assert.match(style, /BorderStyle=/);
  });
});
