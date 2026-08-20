# dsh-narrate 任务分解

| 项目 | 值 |
| --- | --- |
| 版本 | 1 |
| 日期 | 2026-08-20 |
| 依据 | `docs/crew/prd.md` 版本 2、`docs/crew/hld.md` 版本 1 |

## 读这张表之前要知道的三条规则

1. **两个任务绝不拥有同一个文件。** 工程师同时开工，共用文件会互相覆盖。
2. **`T-01` 是走通骨架，单独跑，别的任务全部等它。** 它是唯一允许同时拥有边界两侧文件的任务。它做完之后，后面的任务**不准再改它拥有的文件**。
3. **测试命令只有一条。** `T-01` 在 `package.json` 的 `test` 脚本里把它定下来，之后每个任务都用同一条 `npm test`，不准自己另起一套。
4. **每个代码任务都是测试先行。** 先写一个失败的测试，确认它是因为功能缺失而失败，再写最小的代码让它通过。报告里必须有失败的那次输出，再有通过的那次。没有失败输出的报告不算完成。

## 任务表

| 任务 | 里程碑 | 做什么 | 拥有的文件 | 依赖 | 契约 | 怎么验收 |
| --- | --- | --- | --- | --- | --- | --- |
| `T-01` | M1 | **走通骨架。** 一句文本 → 调外部命令出一个音频 → 裁静音、量真实时长 → 把一段素材裁到这个时长 → 混进旁白 → 烧上这一句字幕 → 出一个能播的 `mp4`。同时实现工作文件的完整分节独占读写（七节都要，不只是 `voice` 和 `render`），因为后面每个任务都要用它，而且不准再改它。它还一次写完整个 `package.json`（含指向 `cordis.patch.yml` 的 `dsh.bundle` 字段），这样 `T-08` 不必回头改这个文件 | `package.json`<br>`src/flow/job.js`<br>`src/voice/engine.js`<br>`src/voice/engines/default.js`<br>`src/render/segment.js`<br>`test/t01-walk.test.js` | 无 | `flow-stages.md`（两侧）<br>`voice-engine.md`（两侧） | `A-10` `A-11` `A-13` `A-14`，加两个契约测试 |
| `T-02` | M2 | 索引文件的读、写、和"人的修改绝不能被机器盖掉"那张规则表。**只做文件逻辑，不调视频理解** | `src/assets-index/store.js`<br>`test/assets-index-store.test.js` | `T-01` | `assetsindex-shotplan.md`（被调侧） | `A-3`，加被调侧契约测试 |
| `T-03` | M2 | 扫素材文件夹，对新的或变过的素材调视频理解，把结果交给 `store.js` 写进索引。理解失败的那一条跳过并记下，不中断整次入库 | `src/assets-index/scan.js`<br>`test/assets-index-scan.test.js` | `T-02` | `assetsindex-shotplan.md` | `A-1` `A-2` |
| `T-04` | M3 | 停点 1：拿到想法先提至少 3 个问题，收到回答前不写文稿。停点 2：把想法和回答展开成按句编号的文稿，写进工作文件的 `script` 节 | `src/script/interview.js`<br>`src/script/write.js`<br>`test/script.test.js` | `T-01` | `flow-stages.md` | `A-4` `A-5` |
| `T-05` | M4 | 为每句挑一段素材，写出画面对应表。挑不到的句子进缺素材报告。`confidence` 是 `low` 的素材只在没有 `high` 可用时才用，用了要在报告里说明 | `src/shotplan/plan.js`<br>`test/shotplan.test.js` | `T-02` `T-04` | `assetsindex-shotplan.md`（调用侧）<br>`flow-stages.md` | `A-6` `A-7`，加调用侧契约测试 |
| `T-06` | M5 | 编排：决定下一步跑哪个阶段，在四个停点停住等回答，中途退出后能从原地续跑。跑完确认五样中间产物齐全 | `src/flow/run.js`<br>`test/flow-run.test.js` | `T-01` `T-03` `T-04` `T-05` | `flow-stages.md` | `A-5` `A-12` |
| `T-07` | M5 | 逐句配音循环、把逐句音频拼成一条纯音频给停点 4、分批拼接（单次上限 20 段）、横屏和竖屏两套字幕规则（竖屏字号更大、每行更少字、位置更高） | `src/voice/speak.js`<br>`src/render/concat.js`<br>`src/render/subtitle.js`<br>`test/render-concat.test.js`<br>`test/subtitle.test.js` | `T-01` | `flow-stages.md` | `A-8` `A-9` `A-16` `A-17` `A-18` |
| `T-08` | M5 | 装成 dsh 插件：挂载入口和 `cordis.patch.yml`，加英文和中文两份 README。**不碰 `package.json`**——`T-01` 已经写好了 `dsh.bundle` 字段 | `host/narrate.js`<br>`cordis.patch.yml`<br>`README.md`<br>`README-zh.md` | `T-06` | 无 | `A-15` |

## 每个验收检查由哪个任务交付

| 检查 | 任务 | 检查 | 任务 |
| --- | --- | --- | --- |
| `A-1` | `T-03` | `A-10` | `T-01` |
| `A-2` | `T-03` | `A-11` | `T-01` |
| `A-3` | `T-02` | `A-12` | `T-06` |
| `A-4` | `T-04` | `A-13` | `T-01` |
| `A-5` | `T-04` `T-06` | `A-14` | `T-01` |
| `A-6` | `T-05` | `A-15` | `T-08` |
| `A-7` | `T-05` | `A-16` | `T-07` |
| `A-8` | `T-07` | `A-17` | `T-07` |
| `A-9` | `T-07` | `A-18` | `T-07` |

18 条检查全部有任务交付，没有一条落空。

## 跑的顺序

```
M1:  T-01  （单独跑，全部等它）
M2:  T-02 → T-03
M3:  T-04              ← 可以和 M2 并行吗？不行。里程碑之间要停下来问用户
M4:  T-05
M5:  T-06 、 T-07  （两个可以同时跑，文件不重叠） → T-08
```

里程碑之间必须停下来等用户回答。就算文件不重叠也不准提前开工——停点的意义就是让用户早点看到方向。

## 我认为还弱的地方

1. **`T-01` 拥有 `src/flow/job.js`，而后面四个任务都要用它。** 如果 `T-01` 实现的分节读写不够完整，后面的任务会被卡住，而它们不准改这个文件。所以 `T-01` 的验收里必须包含"七节都能读、都能写、写别人的节会抛 `E_WRITE_FOREIGN_SECTION`"，不能只做 `voice` 和 `render` 两节。
2. **`T-05` 挑素材的质量没法用自动测试保证。** 测试只能证明"能配上的配上了、配不上的报出来"，不能证明"配得好看"。这一条只能靠停点 3 由用户判断。
3. **PRD 的 `Q-6` 没定**（素材不够长时循环、定格还是放慢），会卡住 `T-07` 的一部分。`T-01` 不受影响，因为骨架用一段足够长的素材。
