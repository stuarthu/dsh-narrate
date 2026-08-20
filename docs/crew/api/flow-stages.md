# 边界契约：工作文件（`flow` ↔ 五个阶段）

| 项目 | 值 |
| --- | --- |
| 版本 | 7 |
| 版本 7 改了什么 | `render` 节写全了：多了 `durationSec`、`width`、`height`、每段的 `fill`、`skippedSentences`、`failures`。`shotplan.shots[]` 的素材路径字段名**确定是 `assetPath`**（挑素材那一侧内部叫 `clipPath`，写进这个文件时要换名）。字幕从 `.srt` 加 `force_style` 换成自己写的 `.ass`，因为 `force_style` 里的像素不是像素（见下）。补上 `E_NOTHING_TO_CONCAT`、`E_SEGMENT_MISSING`、`E_CONCAT_MISMATCH`、`E_NOTHING_TO_RENDER`、`E_RENDER_INTERNAL`。`E_ASSET_TOO_SHORT` 的含义**改了**：素材比旁白短不再是错误（按 `Q-6` 补长），只有"那个起点后面根本没有画面"才报。**这一条是破坏性改动** |
| 版本 6 改了什么 | `voice.clips` 每条多一个 `text`：配这一句的时候文稿上写的是什么。有了它才能看出句子改没改——改了就重配那一句，没改就复用，配音要花钱不能白花。补上 `E_SPEAK_INTERNAL`、`E_NOTHING_TO_PLAY`、`E_CONCAT_FAILED`。**加法改动** |
| 版本 5 改了什么 | `meta` 多一个 `approvedStops`：用户在哪几个停点点过头。**停点 1 不在里面**——它的点头就是回答问题本身，没有额外的确认动作；停点 2、3、4 各要一次明确的"继续"。补上 `E_OUT_OF_ORDER`、`E_STOP_NOT_REACHED`、`E_NO_SUCH_STOP`、`E_NO_SUCH_STEP` 四个错误名。**加法改动** |
| 版本 4 改了什么 | 补上写文稿那一步的五个错误名：`E_EMPTY_ANSWER`、`E_NO_SUCH_QUESTION`、`E_INTERVIEW_INCOMPLETE`、`E_COMPOSE_FAILED`、`E_SCRIPT_UNUSABLE`。**加法改动** |
| 版本 3 改了什么 | 加两个错误名：`E_JOB_MISSING`（工作文件本身不在）和 `E_RENDER_OUTPUT_UNREADABLE`（成片读不出）。原来这两种情况借用了 `E_SECTION_MISSING` 和 `E_AUDIO_MISSING`，名字说的是错事。**这是加法改动**，另一侧不用重跑 |
| 版本 2 改了什么 | 裁静音的规则从“裁到不超过 0.15 秒”改成“完全裁掉”，并写明阈值。原来的写法和本文件里的契约测试自相矛盾（`T-01` 实测发现）。这是**破坏性改动**，两侧都要重读——当时只有 `T-01` 在跑，它同时拿两侧文件，代价为零 |
| 拥有者 | `flow` 模块拥有这个格式 |
| 涉及任务 | `T-01`（`voice` 节和 `render` 节，走通骨架）、`T-04`（`script` 节）、`T-05`（`shotplan` 节）、`T-06`（`meta` 节和续跑） |

## 风格

**文件交接。** 一个 JSON 文件，路径 `<工作目录>/job.json`。工作目录由 `flow` 决定，形状是 `<用户当前目录>/.narrate/<任务名>/`。

阶段之间不互相调用，不共享内存，不用消息队列。一个阶段启动时读整个文件，结束时只改自己那一节，然后整文件原子写回（先写临时文件再改名）。

## 格式

JSON，UTF-8，缩进 2 空格。所有时间单位是**秒**，浮点数，保留 3 位小数。所有路径是**绝对路径**。

```json
{
  "meta": {
    "schema": 1,
    "slug": "why-rust-is-fast",
    "aspect": "landscape",
    "language": "zh",
    "stage": "voice",
    "stopPoint": 4,
    "waitingForUser": true,
    "approvedStops": [2]
  },
  "idea": "讲清楚 Rust 为什么快",
  "interview": {
    "questions": [ { "id": "IQ-1", "text": "视频多长？", "answer": "8 分钟" } ]
  },
  "script": {
    "sentences": [ { "id": "S-001", "text": "Rust 快，不是因为它新。" } ]
  },
  "shotplan": {
    "shots": [
      { "sentenceId": "S-001", "assetPath": "/home/you/assets/bench.mp4",
        "startSec": 12.400, "endSec": 18.900, "subtitle": "Rust 快，不是因为它新。" }
    ],
    "missing": [ { "sentenceId": "S-014", "reason": "索引里没有讲编译过程的画面" } ]
  },
  "voice": {
    "engine": "edge",
    "clips": [ { "sentenceId": "S-001", "text": "Rust 快，不是因为它新。", "audioPath": "/…/audio/S-001.wav", "durationSec": 2.480 } ]
  },
  "render": {
    "segments": [ { "sentenceId": "S-001", "path": "/…/seg/S-001.mp4", "durationSec": 2.480, "fill": "none" } ],
    "output": "/…/out/final.mp4",
    "durationSec": 6.723, "width": 1920, "height": 1080,
    "skippedSentences": [], "failures": []
  }
}
```

## 谁拥有哪一节

**一节只有一个写入者。** 两个阶段写同一节不是边界，是拆分错了。

| 节 | 唯一写入者 | 谁会读它 |
| --- | --- | --- |
| `meta` | `flow` | 所有阶段 |
| `idea` | `flow`（从用户输入抄进来） | `script` |
| `interview` | `script` | `script` |
| `script` | `script` | `shotplan`、`voice` |
| `shotplan` | `shotplan` | `voice`、`render` |
| `voice` | `voice` | `render` |
| `render` | `render` | `flow` |

一个阶段读别人的节是允许的，写别人的节是**阻塞级错误**。

## 数据和一致性

- **文件是唯一真相。** 没有第二份状态，没有缓存，没有内存里的副本。
- **写入是原子的。** 先写 `job.json.tmp`，`fsync`，再改名成 `job.json`。半个文件比没有文件更糟。
- **答案立刻为真。** 一个阶段写完并改名之后，下一个阶段读到的一定是新内容。没有延迟。
- **一个阶段一次只有一个进程在跑。** `flow` 保证这一点。阶段自己不需要加锁。
- `meta.schema` 是格式版本。读到不认识的版本要报 `E_SCHEMA_UNKNOWN` 并停下，不要猜。

## 最要紧的一节：`voice`

这是全项目最容易出错的地方，所以规则写死：

1. `durationSec` 是**唯一权威**。`render` 必须用它排画面，**不准自己再量一遍**去排。（可以量一遍做校验，见下面的错误。）
2. `voice` 用 `ffprobe` 读 `format=duration` 得到这个数，保留 3 位小数。
3. `voice` 写进文件之前，**必须**把音频开头和结尾的静音**完全裁掉**：阈值 `-50 dB`，峰值检测。理由：不裁的话，画面和声音的起点会差开，而且每一句都差一点，越往后越歪。实测一段 4.000 秒的音频（前后各 1 秒静音、中间 2 秒有声）裁完是 1.999977 秒，所以这一步的精度足够。
4. `audioPath` 指向的文件必须真的存在，且必须是 `voice` 已经裁过静音的那一个。`durationSec` 必须是**裁完之后**量的。
5. `render` 校验：如果自己量出来的时长和 `durationSec` 差超过 0.05 秒，报 `E_DURATION_MISMATCH`，不要自己修正后继续。

## 每个阶段的入口和出口

| 阶段 | 必须先读到什么 | 写完之后什么必须为真 |
| --- | --- | --- |
| `script` | `idea` 非空 | `interview.questions` 每条都有 `answer`；`script.sentences` 至少一条，`id` 形如 `S-001` 且不重复 |
| `shotplan` | `script.sentences` 非空 | 每个 `sentenceId` 要么在 `shots` 里，要么在 `missing` 里，**不能都不在，也不能都在** |
| `voice` | `script.sentences` 非空 | 每句一条 `clips` 记录，`durationSec` 大于 0 |
| `render` | `shotplan.shots` 和 `voice.clips` 都齐 | `render.output` 指向一个真能播的文件 |

## 错误名字

"可能会失败"不是契约。会发生的失败必须有名字：

| 错误名 | 什么时候 |
| --- | --- |
| `E_SCHEMA_UNKNOWN` | `meta.schema` 不是本模块认识的版本 |
| `E_JOB_MISSING` | 工作文件 `job.json` 本身读不到 |
| `E_SECTION_MISSING` | 该读的节不存在或为空 |
| `E_AUDIO_MISSING` | `audioPath` 指的文件不存在 |
| `E_AUDIO_ZERO_DURATION` | `durationSec` 小于等于 0 |
| `E_DURATION_MISMATCH` | `render` 量出的时长与 `durationSec` 差超过 0.05 秒 |
| `E_ASSET_MISSING` | `assetPath` 指的素材文件不存在 |
| `E_ASSET_TOO_SHORT` | 素材可用长度短于该句音频，需要按补长规则处理 |
| `E_SENTENCE_UNPLANNED` | 有句子既不在 `shots` 也不在 `missing` 里 |
| `E_WRITE_FOREIGN_SECTION` | 一个阶段试图写不属于它的节 |
| `E_EMPTY_ANSWER` | 反问的回答是空白。空白不算回答，否则下一步会以为问完了 |
| `E_NO_SUCH_QUESTION` | 回答的编号没有对应的问题 |
| `E_INTERVIEW_INCOMPLETE` | 还有问题没回答就想写文稿。停点 1 不能被跳过 |
| `E_COMPOSE_FAILED` | 写稿那一步（模型）自己失败了。**必须用这个码**，不能让一个没有码的错误冒出去——那样模型失败和程序 bug 就分不开了 |
| `E_SCRIPT_UNUSABLE` | 写稿那一步没给出一句能用的话。不写半个文稿 |
| `E_OUT_OF_ORDER` | 想做的这一步，前面还有没做完的、或者有停点没得到用户的"继续" |
| `E_STOP_NOT_REACHED` | 想给一个还没走到的停点点头。那等于把停点绕掉了 |
| `E_NO_SUCH_STOP` | 停点编号不是 1 到 4 |
| `E_NO_SUCH_STEP` | 步骤名不认识 |
| `E_SPEAK_INTERNAL` | 配某一句时出了没有错误码的意外错误。**必须用这个码**，不能贴成引擎失败，否则程序 bug 会被当成"这句配不出来" |
| `E_NOTHING_TO_PLAY` | 一句配音都还没有，拼不出停点 4 要的纯音频 |
| `E_CONCAT_FAILED` | 拼接失败 |
| `E_RENDER_OUTPUT_UNREADABLE` | 渲染跑完了，但输出文件读不出时长 |
| `E_ASSET_TOO_SHORT` | `startSec` 后面根本没有画面。**素材比旁白短不算错**——按 `Q-6` 补长 |
| `E_NOTHING_TO_CONCAT` | 没有任何片段可拼 |
| `E_SEGMENT_MISSING` | 要拼的片段文件不见了 |
| `E_CONCAT_MISMATCH` | 拼出来的片子时长不对，或者解码有坏帧。拷流和重编都试过了 |
| `E_NOTHING_TO_RENDER` | 一句都没渲染出来（全都缺画面、缺配音，或者渲染出错） |
| `E_RENDER_INTERNAL` | 渲染某一句时出了没有错误码的意外错误。和 `E_SPEAK_INTERNAL` 一个道理：不能让 bug 伪装成"这一句难渲染" |

## 画面比旁白短怎么办（`Q-6`）

画面时长服从音频（`adr/0005`），所以素材盖不住旁白时**不能改语速**，只能动画面：

| 缺口 | 做法 | 为什么 |
| --- | --- | --- |
| ≤ 20% | 放慢画面（`setpts`） | 慢一点看不出来，比跳一下自然 |
| > 20% | 从这一段的起点循环重放 | 放慢到 1.25 倍以上就明显不自然了 |
| 起点后面没有画面 | 报 `E_ASSET_TOO_SHORT` | 补不出来 |

放慢只动画面，**旁白一秒都不动**——旁白是基准。

## 字幕为什么写 `.ass` 而不是 `.srt`

原来用 `subtitles=x.srt:force_style='FontSize=…,MarginV=…'`，那些数字写的是像素，但 libass
会按 `画面高 / 脚本高` 缩放它们，而脚本高在没写的时候默认是 **288**。实测：

| 目标 | 想要 | 实际画出来 |
| --- | --- | --- |
| 1920x1080 | 离底 60px | 离底 248px |
| 1080x1920 | 离底 220px | 离底 **1525px**——字幕在画面顶部 |

而当时每个单元测试都是绿的。改法是自己写一份 `.ass`，把 `PlayResX/PlayResY` 钉成成片
分辨率，数字才真的是像素。样式值本身也从写死的像素改成**比例**：字号按画面宽算（一行
满字要放得下），竖直边距按画面高算——绝对像素在不同分辨率下含义不一样。

## 拼接：一次过，先比参数

`concat` 分离器读的是清单文件，**没有段数上限**（`dsh-ffmpeg` 那个 `concat` 工具的 20
段上限不适用）。每一段都按同一套参数出（分辨率、30fps、`high` 档、44100/双声道），
所以能直接 `-c copy`，不重编、不掉画质。

参数不一致时**不试拷流**，直接重编。实测过：h264/320x180/30fps 和 mpeg4/640x360/10fps
拷流拼起来，ffmpeg **退出码是 0**、时长只差 0.02 秒，但帧数少了四分之一，后半段解码
全是 `no frame!`。所以验收要两道：量总时长，**再把成片完整解码一遍**。

## 好不好用

一个阶段最容易犯的错，是"顺手"把别人的节改了。防住它的办法不是靠自觉：每个阶段读文件时拿到的是一个只暴露"我的节可写、别人的节只读"的对象。写别人的节在运行时就抛 `E_WRITE_FOREIGN_SECTION`，不等到成片才发现。

## 契约测试

| 侧 | 测试证明什么 |
| --- | --- |
| `voice` 侧 | 喂一段总长 4.000 秒的音频：前 1 秒静音、中间 2 秒有声、后 1 秒静音。测试证明：写回的 `durationSec` 是 2.000 ± 0.05，且 `audioPath` 指的文件量出来也是同一个数 |
| `render` 侧 | 手写一个 `job.json` 桩：一条 2.000 秒的音频、一段 6.000 秒的素材。测试证明：产出的片段时长 2.000 ± 0.05 秒，且画面里有那句字幕。**必须跑在这个手写桩上，不准调真的 `voice`** |

两个测试都必须先失败再通过，失败的输出要留在报告里。

## 改这个文件的规矩

契约在任何一侧的任务开工之后就**冻结**。工程师发现它错了，报给 PM，PM 交给架构师。**只有架构师能改这个文件。** 改完 PM 通知两侧重读新版本。

必须改的时候，优先**只加不改**：加一个新字段、且不设为必填。已经做好的部分继续能用，只有一侧要动。

这四种改法会弄坏另一侧，做了就要说清楚，而且两侧都要重跑：改字段名、删字段、把可选字段变必填、改一个错误名的含义。
