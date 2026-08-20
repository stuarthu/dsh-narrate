[中文](README-zh.md)

# dsh-narrate

Version 0.1.0 in `package.json`, **nothing released yet**. What is described
below is what the code on `main` does.

A [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/DeepSeek-Harness) plugin.
You give it one idea. It stops four times to ask you first. Then it builds a video
from the clips in your own `assets` folder, with an AI voice reading your script
and the words burned onto the picture.

Landscape (16:9) for YouTube and bilibili. Portrait (9:16) for TikTok and Shorts.

## Status: it works end to end, and it is not released yet

Read this before you install.

**What works today**

- One idea becomes one finished video. Every sentence is spoken, matched to a clip
  from your own folder, cut to the length of its narration, subtitled, and joined
  into a single file — 1920x1080 for landscape, 1080x1920 for portrait.
- **All four stop points.** Nothing moves past one without a clear yes from you,
  and each is a hard check inside a tool rather than a line of instruction.
- Indexing your asset folder: it walks the folder (following symlinks, so clips on
  an external drive are found), reads your descriptions and tags from any of seven
  places, and only asks the understanding step about clips whose fingerprint
  changed. One bad clip never sinks the whole run.
- Matching a Chinese script against English clip metadata, through an English
  query the agent supplies. Rare words count for more than boilerplate tags.
- A bundled voice engine that needs no API key, and a command-line contract so you
  can swap in any other engine by changing configuration only.

**What is still missing**

- **It is not on npm yet.** `npm install dsh-narrate` does not work. Install from a
  local checkout — see [Install](#install).
- The understanding step is a plug-in point. The plugin tells the agent which clips
  need looking at; how well it answers is up to the agent and its tools. With no
  understanding at all, matching still works from your own descriptions and tags,
  just less well.
- A landscape clip in a portrait video gets wide black bars above and below. The
  picture keeps its shape rather than being stretched, which is honest but is not
  what TikTok and Shorts usually look like. Cropping to fill is not implemented.
- Nothing is uploaded anywhere. There is no platform account, no scheduling, no
  thumbnail. This plugin makes a file.

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

## Files this plugin writes into your asset folder

Next to every clip it writes `<clip name without its extension>.json`. For `bench.mp4`
that is `bench.json`, in the same folder.

**If a file with that name already exists, this plugin updates it.** Stock footage sites
often ship a metadata json beside each clip, and that metadata is worth having: the plugin
reads its `title`, `description`, `tags` and `search_term` and uses them. It then adds its
own keys to the same file — `schema`, `clip`, `fingerprint`, `fromYou`, `fromMachine`.
**Every key it did not create is left exactly as it was.**

Before it touches a file it did not write, it saves a copy as `<name>.json.bak`, once. So
you can always get the original back.

One caveat worth knowing. If the tool that produced that json rewrites the file later, it
may drop the plugin's keys. Machine-derived data is simply recomputed, so nothing is really
lost. But anything **you** typed into that file would be gone. Put writing you want to keep
in a `.narrate.txt` file instead — see the next section.

Nothing is written anywhere else in your asset folder, and no clip is ever modified.

### Where the video itself is written

Everything the plugin makes for one video lives in one folder, by default
`.narrate/<short name>/` under the directory you started dsh in:

```
.narrate/clouds/
  job.json          every stage reads and writes this, one section each
  audio/S-001.wav   one recording per sentence
  preview.wav       the audio-only file you listen to at stop point 4
  segments/S-001.mp4  one cut, subtitled piece per sentence
  out/clouds.mp4    the finished video
```

Nothing is deleted between runs, so a redo only remakes what changed: a sentence
you did not edit keeps its recording rather than being spoken again.

## How to describe a clip

Use whichever of these suits you. The plugin folds them all into one shape. For the
description the most explicit source wins; tags from every source are merged.

| Precedence | Where you write it | How |
| --- | --- | --- |
| 1 (highest) | Tell the plugin in conversation | "that server rack clip is mine, the rights are clear" |
| 2 | Edit `bench.json` by hand | Change `fromYou` in the file |
| 3 | A text file beside the clip | `bench.mp4.narrate.txt` — first line is the description, lines starting with `#` are tags, the rest becomes notes |
| 4 | A spreadsheet | `clips.csv` in the asset folder root: filename, description, tags separated by `;` |
| 5 | The json already beside the clip | Whatever the download source put there |
| 6 | The filename | `server-rack_close-up.mp4` is split on `-`, `_` and spaces into tags |
| 7 (lowest) | The folder name | `assets/datacentre/bench.mp4` gives the tag `datacentre` |

Two things worth knowing:

- **Notes are never parsed.** Write "do not use this in a paid piece, the client will not
  allow that rack number to show" and the plugin keeps it word for word, and shows it to the
  model when writing the script and choosing shots. It never tries to interpret it.
- **A description is written once.** The plugin fills it only when it is empty. After that
  the line is yours and the plugin never touches it again — not even a line it wrote itself.
  If a description is wrong, clear that field and scan again to have it filled fresh.
- **Tags are keywords only.** Resolution, frame rate, codec and container never become tags,
  and neither do words like `HD` or `High Definition`. They do not help decide which clip
  suits which sentence, and in real stock footage they are often simply wrong: four clips
  all tagged `1080p` and `H.264` turned out to include a 640x360 one, a 532x300 one, and a
  `vp8` one.
- **Notes and tags still merge.** For those two the plugin remembers what it derived last
  time, so it can tell your writing apart from its own earlier output. It rewrites its own
  and keeps yours, and says so when it replaces something of its own.
- **Only the length is measured.** `ffprobe` reads each clip's duration, because choosing a
  clip for a sentence depends on whether it is long enough, and cutting it depends on the
  same number. Nothing else about the file is stored.


## Requirements

- Node.js 22 or newer. The test runner needs a newer Node for the glob it uses, and
  relying on the shell to expand it instead would break on Windows.
- `ffmpeg` and `ffprobe` on your `PATH`. Check with `ffmpeg -version`.
  Set `DSH_FFMPEG_PATH` and `DSH_FFPROBE_PATH` if they live somewhere else.
- At least one font that covers the language you write in. For Chinese, install
  `fonts-noto-cjk` or any other CJK font. Without one, every subtitle renders as
  empty boxes.

## Install

The package is not on npm yet, so install it from a checkout:

```sh
git clone https://github.com/stuarthu/dsh-narrate
dsh plugin --profile tui add link:/path/to/dsh-narrate
```

Once it is released, `dsh plugin --profile tui add dsh-narrate` will be enough.

That registers ten tools the agent can call:

| Tool | What it does |
| --- | --- |
| `narrate_start` | Take your one idea, and hand back the questions to ask you first |
| `narrate_answer` | Record one of your answers |
| `narrate_script` | Store the script the agent wrote, numbered. **Refuses while a question is unanswered** |
| `narrate_index` | Walk your asset folder and say which clips still need understanding |
| `narrate_describe` | Store what the agent understood about one clip |
| `narrate_shotplan` | Choose a clip for every sentence, and list the sentences with no match |
| `narrate_voice` | Speak every sentence, and build the audio-only file for stop point four |
| `narrate_render` | Cut, mix, subtitle and join. **Refuses until stop point four is approved** |
| `narrate_approve` | Record that you said go ahead at one stop point |
| `narrate_status` | Where this video is, what it is waiting for, what comes next |

The split is deliberate and it comes from how dsh works: the host cannot call a
model. So the plugin holds the rules and the memory, and the agent holds the
judgement — it writes the script, it calls `video_understand`, it talks to you.
Because of that, every "do not skip this" is a hard check inside a tool rather
than a line of instruction the agent could ignore.

## How it works

Five stages, four places where it stops and waits for you.

| Stop | When | What you see | What you do |
| --- | --- | --- | --- |
| 1 | Before the script is written | Four questions: how long, who is watching, what tone, the one line you want remembered | Answer them. Answering *is* the yes — there is nothing else to approve |
| 2 | Script finished | The full script, one numbered sentence per line | Approve it, or change it |
| 3 | Before any audio is made | The shot list, plus a list of the sentences that have **no matching clip** | Add clips, edit the shot list, or say go ahead |
| 4 | Before rendering | An audio-only file: the narration with no picture | Listen to the pace, approve or redo a few lines |

Nothing moves past a stop without a clear yes from you. That is the point of the
plugin. Other tools do the whole job in one go and only show you the result.

Stop point four is the one people skip and regret. Listen to the narration with no
picture: the picture is distracting, and if the pace is wrong the whole video has
to be made again.

Every stage reads a file and writes a file, so nothing is hidden and any single
step can be redone on its own. If a session is interrupted, `narrate_status` reads
the file and says exactly where things stand.

### What a session looks like

You say one line. The agent does the rest, stopping four times:

```
you     "make me something about how fast clouds move"
agent   narrate_start   → four questions, asked in your language
you     answers                                                      ← stop 1
agent   narrate_script  → the script, one sentence per line
you     "the third line is too long, cut it"                         ← stop 2
agent   narrate_index   → 36 clips found, 4 need looking at
        narrate_describe × 4
        narrate_shotplan → 8 sentences matched, 1 has no clip
you     "drop that sentence"                                         ← stop 3
agent   narrate_voice   → preview.wav, 41 seconds
you     listen, "a bit fast but fine"                                ← stop 4
agent   narrate_render  → out/clouds.mp4, 41 seconds, 1920x1080
```

### Picture length follows audio length

The narration keeps its natural pace, always. Changing the speaking rate to fit a
shot is what makes narration sound fake. So the picture is what bends:

| The clip is | What happens |
| --- | --- |
| Longer than the narration | Cut to the narration's length |
| Short by 20% or less | Slowed down. At this much it does not show |
| Short by more than 20% | Looped from the start of the chosen window |
| Missing a picture at that point | Reported to you as a problem, not filled in with something else |

### Clips of any size and frame rate

Each clip is fitted into the target frame with black bars rather than stretched,
then the subtitle is burned on top at the final resolution — so subtitles are the
same size whatever the source was. Every part is encoded to one shape, so joining
them needs no re-encoding and loses no quality, and the finished file is checked by
decoding all of it. A join can break without ffmpeg reporting an error.

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

303 tests. Two of them reach the Microsoft speech endpoint; with no network they
skip out loud instead of failing. Everything else runs offline.

The tests cut real video and real audio, so `ffmpeg` and `ffprobe` must be on your
`PATH` and a font for your language must be installed.

There is a second, separate set of checks written from the acceptance criteria
rather than from the code:

```sh
sh docs/crew/qa/run-all.sh
```

## Design documents

This plugin was built with [dsh-crew](https://github.com/stuarthu/dsh-crew), so
the reasoning is written down rather than lost:

| File | What it holds |
| --- | --- |
| [`docs/crew/prd.md`](docs/crew/prd.md) | What is being built and why, the acceptance checks, the milestones |
| [`docs/crew/hld.md`](docs/crew/hld.md) | The modules, where the boundaries fall, which one is riskiest |
| [`docs/crew/api/`](docs/crew/api) | The three boundary contracts, each with named errors and a test per side |
| [`docs/crew/adr/`](docs/crew/adr) | Five decisions, each with the options weighed and what it costs |
| [`docs/crew/crd/`](docs/crew/crd) | Change requests: a decision that had to be revisited, and why |
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
