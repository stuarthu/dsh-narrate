[中文](README-zh.md)

# dsh-narrate

Version 0.1.0

A [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/DeepSeek-Harness) plugin.
You give it one idea. It stops four times to ask you first. Then it builds a video
from the clips in your own `assets` folder, with an AI voice reading your script
and the words burned onto the picture.

Landscape (16:9) for YouTube and bilibili. Portrait (9:16) for TikTok and Shorts.

## Status: early

Read this before you install. Version 0.1.0 is the **first milestone only**.

**What works today**

- Speak one sentence, trim the silence off both ends, and measure how long the
  audio really is.
- Cut a clip from one of your own video files to exactly that length, mix the
  narration in, and burn the sentence onto the picture as a subtitle.
- A job file that every stage reads and writes, where a stage can only write its
  own section. Writing another stage's section raises an error at once.
- A bundled voice engine that needs no API key, and a command-line contract so
  you can swap in any other engine by changing configuration only.

**What does not work yet**

- There is no command that takes an idea and gives you a video. You write the
  job file by hand for now.
- No asset indexing, no script writing, no shot planning, no review stops.
- The plugin does not mount into dsh yet.

If you want a finished tool today, use one of the projects in
[Prior art](#prior-art) instead. Come back when this reaches version 1.0.

## Privacy: read this first

The bundled voice engine **sends your narration text to a Microsoft server**.

| What | Where your data goes | How to avoid it |
| --- | --- | --- |
| Bundled voice engine (default) | Your narration text is sent to Microsoft's Edge read-aloud service, through [`node-edge-tts`](https://www.npmjs.com/package/node-edge-tts). It needs no account and no API key. | Configure a local engine instead — see [Swapping the voice engine](#swapping-the-voice-engine). |
| Your video clips | Never leave your machine. All cutting and encoding runs locally through `ffmpeg`. | Nothing to do. |
| Your finished video | Never uploaded anywhere. This plugin does not touch any platform account. | Nothing to do. |

The bundled engine is not an official public Microsoft API, so it can stop
working at any time. That is exactly why the engine is a swappable contract and
not built into the code.

## Requirements

- Node.js 20 or newer.
- `ffmpeg` and `ffprobe` on your `PATH`. Check with `ffmpeg -version`.
  Set `DSH_FFMPEG_PATH` and `DSH_FFPROBE_PATH` if they live somewhere else.
- At least one font that covers the language you write in. For Chinese, install
  `fonts-noto-cjk` or any other CJK font. Without one, every subtitle renders as
  empty boxes.

## Install

```sh
npm install dsh-narrate
```

**0.1.0 is a plain npm library, not yet a dsh bundle.** It deliberately does not
declare `dsh.bundle` in its `package.json`, because the mount is not built yet
and a bundle whose patch file is missing stops a dsh profile from booting at all.
The mount arrives with the milestone that finishes the plugin.

## How it will work

Five stages, four places where it stops and waits for you.

| Stop | When | What you see | What you do |
| --- | --- | --- | --- |
| 1 | Before the script is written | At least three questions: how long, who is watching, what tone, the one line you want remembered | Answer them |
| 2 | Script finished | The full script, one numbered sentence per line | Approve it, or change it |
| 3 | Before any audio is made | The shot list, plus a list of the sentences that have **no matching clip** | Add clips, edit the shot list, or say go ahead |
| 4 | Before rendering | An audio-only file: the narration with no picture | Listen to the pace, approve or redo a few lines |

Nothing moves past a stop without a clear yes from you. That is the point of the
plugin. Other tools do the whole job in one go and only show you the result.

Every stage reads a file and writes a file, so nothing is hidden and any single
step can be redone on its own. Picture length always follows the real length of
the audio, never the other way round — the voice keeps its natural pace.

## Swapping the voice engine

A voice engine is a **command**, not a plugin you have to write in JavaScript.
It reads a text file and writes an audio file. Any language can implement one.

Placeholders in the command template:

| Placeholder | Replaced with |
| --- | --- |
| `%TEXT_FILE%` | Absolute path of a UTF-8 file holding the one sentence to speak |
| `%OUT_FILE%` | Absolute path where the engine must write the audio |
| `%LANG%` | Language code, such as `zh` or `en` |
| `%VOICE%` | Voice name, passed straight through for the engine to interpret |

```yaml
voice:
  command: ["my-tts", "--in", "%TEXT_FILE%", "--out", "%OUT_FILE%", "--lang", "%LANG%"]
  timeoutMs: 60000
```

Your engine must:

1. Exit `0` on success, and really write `%OUT_FILE%`.
2. Exit non-zero on failure, with the reason on `stderr`.
3. Write only `%OUT_FILE%`, and never change the input file.
4. Never ask for interactive input.
5. Produce audio whose length `ffprobe` can read.

Text is passed in a file, never as a command-line argument, and every argument
goes to the process as its own item. A script is model-written text, so it must
never be able to reach a shell.

The full contract, including every error name, is in
[`docs/crew/api/voice-engine.md`](docs/crew/api/voice-engine.md).

## Tests

```sh
npm test
```

31 tests. Two of them reach the Microsoft speech endpoint; with no network they
skip out loud instead of failing. Everything else runs offline.

## Design documents

This plugin was built with [dsh-crew](https://github.com/stuarthu/dsh-crew), so
the reasoning is written down rather than lost:

| File | What it holds |
| --- | --- |
| [`docs/crew/prd.md`](docs/crew/prd.md) | What is being built and why, the acceptance checks, the milestones |
| [`docs/crew/hld.md`](docs/crew/hld.md) | The modules, where the boundaries fall, which one is riskiest |
| [`docs/crew/api/`](docs/crew/api) | The three boundary contracts, each with named errors and a test per side |
| [`docs/crew/adr/`](docs/crew/adr) | Five decisions, each with the options weighed and what it costs |
| [`docs/crew/tasks.md`](docs/crew/tasks.md) | Every task, the files it owns, and the check it delivers |

The documents are written in Chinese. The code, commands and file names are in
English.

## Prior art

Several projects already do the whole job today. None of them stop to ask you
first, which is the one thing this plugin is for.

- [OpenCut-AI](https://github.com/Ekaanth/OpenCut-AI) — matches script segments to
  your own media library by visual similarity, runs locally.
- [OpenMontage](https://github.com/Open-Montage/OpenMontage) — an agentic video
  production system with many pipelines and tools.
- [NarratoAI](https://github.com/linyqh/NarratoAI) — film and television narration,
  script to dubbing to subtitles.
- [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) — a topic or a
  keyword to a short video, mostly from stock footage.

This plugin reuses rather than rebuilds: [`dsh-ffmpeg`](https://github.com/STARDUSTLC666/dsh-ffmpeg)
for video work, [`dsh-video-understand`](https://github.com/ilps2/dsh-video-understand)
for turning clips into text locally, and `node-edge-tts` for the default voice.

## License

MIT
