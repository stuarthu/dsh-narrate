// T-09 的字幕测试。契约：docs/crew/api/flow-stages.md
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SUBTITLE_RULES,
  displayWidth,
  wrapSubtitle,
  escapeSubtitle,
  assDocument,
  assTime,
  stylePixels,
} from '../src/render/subtitle.js';

describe('T-09 字幕：横屏和竖屏两套规则', () => {
  test('竖屏一行放的字更少，字号（按画面宽算）更大，位置更高', () => {
    const wide = SUBTITLE_RULES.landscape;
    const tall = SUBTITLE_RULES.portrait;
    assert.ok(tall.maxWidth < wide.maxWidth, '竖屏一行该放更少');
    assert.ok(tall.fontRatio > wide.fontRatio, '竖屏字号占画面宽的比例该更大');
    assert.ok(tall.marginRatio > wide.marginRatio, '竖屏字幕该更高，别被手机的操作条压住');
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

describe('T-09 字幕：样式是比例，不是写死的像素', () => {
  test('同一个比例在两种分辨率下，字幕占画面的份额一样', () => {
    const big = stylePixels('landscape', 1920, 1080);
    const small = stylePixels('landscape', 960, 540);
    assert.ok(Math.abs(big.fontSize / 1920 - small.fontSize / 960) < 0.002,
      `字号占宽的比例该一致：${big.fontSize}/1920 对 ${small.fontSize}/960`);
    assert.ok(Math.abs(big.marginV / 1080 - small.marginV / 540) < 0.002,
      `边距占高的比例该一致：${big.marginV}/1080 对 ${small.marginV}/540`);
  });

  test('一行满字放得下：maxWidth 个显示宽度乘字号，不超过画面宽减两边留白', () => {
    for (const aspect of ['landscape', 'portrait']) {
      for (const [w, h] of [[1920, 1080], [1080, 1920], [960, 540], [540, 960]]) {
        const px = stylePixels(aspect, w, h);
        const chars = SUBTITLE_RULES[aspect].maxWidth / 2; // 显示宽度 2 算一个中文字
        assert.ok(chars * px.fontSize <= w - 2 * px.marginH,
          `${aspect} ${w}x${h}：一行 ${chars} 个字乘 ${px.fontSize} 超过了 ${w - 2 * px.marginH}`);
      }
    }
  });

  test('描边跟着字号走，字大了描边也大', () => {
    assert.ok(stylePixels('landscape', 1920, 1080).outline
      > stylePixels('landscape', 480, 270).outline);
    assert.ok(stylePixels('landscape', 480, 270).outline >= 2, '再小也要有描边');
  });

  test('竖直边距不会把字幕推出画面', () => {
    for (const aspect of ['landscape', 'portrait']) {
      for (const [w, h] of [[1920, 1080], [1080, 1920], [540, 960]]) {
        const px = stylePixels(aspect, w, h);
        assert.ok(px.marginV + px.fontSize * 2 < h,
          `${aspect} ${w}x${h}：边距 ${px.marginV} 加两行字放不下`);
      }
    }
  });
});

describe('T-09 字幕：生成 ASS', () => {
  test('时间写法是 ASS 的，精确到百分之一秒', () => {
    assert.equal(assTime(0), '0:00:00.00');
    assert.equal(assTime(2.48), '0:00:02.48');
    assert.equal(assTime(3725.5), '1:02:05.50');
  });

  test('PlayRes 钉成成片分辨率——这是让像素真的是像素的唯一办法', () => {
    const doc = assDocument({ cues: [{ startSec: 0, endSec: 2, text: '一句话。' }],
      aspect: 'portrait', width: 1080, height: 1920 });
    assert.match(doc, /^PlayResX: 1080$/m);
    assert.match(doc, /^PlayResY: 1920$/m);
    assert.match(doc, /^ScaledBorderAndShadow: yes$/m);
    // WrapStyle 2 是"只在我写的地方换行"。换行是我们按显示宽度算好的，
    // 不能让 libass 再自己折一次。
    assert.match(doc, /^WrapStyle: 2$/m);
  });

  test('一句话是一条 Dialogue，长句在正文里用 \\N 换行', () => {
    const doc = assDocument({
      cues: [{ startSec: 0, endSec: 6, text: '前半句在这里说完了，然后后半句才开始慢慢地说下去。' }],
      aspect: 'portrait', width: 1080, height: 1920,
    });
    const events = doc.split('\n').filter((line) => line.startsWith('Dialogue:'));
    assert.equal(events.length, 1, '一句话只该有一条 Dialogue');
    assert.ok(events[0].includes('\\N'), `长句该有硬换行：${events[0]}`);
  });

  test('多句就是多条 Dialogue，时间各自算', () => {
    const doc = assDocument({
      cues: [{ startSec: 0, endSec: 2, text: '第一句。' }, { startSec: 2, endSec: 5.5, text: '第二句。' }],
      aspect: 'landscape', width: 1920, height: 1080,
    });
    const events = doc.split('\n').filter((line) => line.startsWith('Dialogue:'));
    assert.equal(events.length, 2);
    assert.ok(events[1].includes('0:00:02.00,0:00:05.50'), events[1]);
  });

  test('花括号在正文里被转义，伪造不出覆盖标签', () => {
    const doc = assDocument({ cues: [{ startSec: 0, endSec: 2, text: '{\\pos(0,0)}偷偷挪位置' }],
      aspect: 'landscape', width: 1920, height: 1080 });
    const event = doc.split('\n').find((line) => line.startsWith('Dialogue:'));
    assert.ok(event.includes('\\{'), `花括号该转义：${event}`);
    assert.ok(event.includes('偷偷挪位置'), '被注入的字该作为普通文字留着');
  });

  test('正文里的换行伪造不出第二条 Dialogue', () => {
    const nasty = '第一句\nDialogue: 0,0:00:00.00,0:00:09.00,N,,0,0,0,,偷插的一条';
    const doc = assDocument({ cues: [{ startSec: 0, endSec: 2, text: nasty }],
      aspect: 'landscape', width: 1920, height: 1080 });
    const events = doc.split('\n').filter((line) => line.startsWith('Dialogue:'));
    assert.equal(events.length, 1, `只该有一条，实际 ${events.length}：${JSON.stringify(events)}`);
    assert.ok(events[0].includes('偷插的一条'), '被注入的字该作为普通文字留着');
  });

  test('一句都没有时也是一份合法的 ass，不是半个文件', () => {
    const doc = assDocument({ cues: [], aspect: 'landscape', width: 1920, height: 1080 });
    assert.match(doc, /^\[Events\]$/m);
    assert.equal(doc.split('\n').filter((line) => line.startsWith('Dialogue:')).length, 0);
  });
});
