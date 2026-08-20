# QA 测试计划：T-11（dsh 挂载）

计划**先按验收检查写，再读代码**。顺序反了就只会测出"代码现在干了什么"，那永远通过。

依据：`docs/crew/prd.md` 版本 4 的 `A-15`、`A-28`、`A-29`、`A-30`。

## 用例

| 编号 | 做什么 | 必须发生什么 | 对应检查 |
| --- | --- | --- | --- |
| 1 | 读 `package.json` 和 `cordis.patch.yml` | `dsh.bundle.patch` 有声明，它指的文件真的存在，`files` 里带 `host` 和 `cordis.patch.yml`，插入行指向 `dsh-narrate/host/narrate.js` | `A-15` |
| 2 | 用一个假的宿主上下文挂载 | 注册 6 个 `narrate_*` 工具，每个都有 `description`、`parameters`、`output.schema`、`output.render`、`execute` | `A-15` |
| 3 | 拿 dsh 自己的 `assertSupportedJsonSchema` 校验每个 schema | 全部通过。导不到 dsh 就**出声跳过**，并改用抄写的子集规则 | `A-30` |
| 4 | 调每个工具，把返回值交给 dsh 的 `validateJsonSchemaValue` | 全部符合自己声明的 schema | `A-30` |
| 5 | 建任务、只答一个问题、直接调 `narrate_script` | 报 `E_INTERVIEW_INCOMPLETE`，而且**工作文件里没有文稿** | `A-29` |
| 6 | 造两段真视频，调 `narrate_index` | 两段都进 `needsUnderstanding`；时长已经量好；`fromMachine` 还是空的 | `A-28` |
| 7 | 调 `narrate_describe` 并瞎报一个 999 秒的时长 | 存下来的是**量出来的**真实时长，`999` 被忽略 | `A-28` |
| 8 | 配置传 `undefined`、`null`、`{}`、`{workdir:123}` | 都不抛异常。挂载崩掉会让用户整个 profile 起不来 | `A-15` |

## 跑不了的用例

**在真的 dsh 会话里 `dsh plugin add` 然后看到工具出现**——这里跑不了，需要一个活的
dsh。用例 1 到 4 是它的替身：形状对、schema 过得了 dsh 自己的校验器、返回值符合
声明。真正在 dsh 里跑一遍仍然要人做一次。
