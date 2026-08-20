# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## What this repository is

`dsh-narrate` is a **plugin for DeepSeek Harness (dsh)**. You give it one idea, it stops four
times to ask you first, and it builds a video from the clips in your own asset folder with an
AI voice reading your script and the words burned onto the picture.

**Only the orchestration is written here.** Asset understanding, video work and speech are
reused, not rebuilt:

| Layer | Comes from |
| --- | --- |
| Understanding a clip | `dsh-video-understand` (L0 runs locally: speech recognition, scene and motion, into text) |
| Video work | `dsh-ffmpeg` (`probe` / `cut` / `concat` / `encode` / `subtitle` / `extract`), plus direct `ffmpeg` for the two things it lacks |
| Speech | A command-line contract. Any engine in any language can implement it |
| **The four stop points, the shot list, the missing-asset report, the clip index** | **This repository** |

Several projects already do the whole job end to end — OpenCut-AI, OpenMontage, NarratoAI,
MoneyPrinterTurbo. None of them stop to ask the user first. That is the one thing this plugin
is for, so keep the stop points at the centre of any change.

There is no build step and no bundler. Plain ES modules (`"type": "module"`), one runtime
dependency.

## Commands

```sh
npm test        # every test; there is only one test command, on purpose
node --test 'test/clip-file.test.js'    # one file — this is the "single test" here
```

The tests cut real video and real audio, so `ffmpeg` and `ffprobe` must be on `PATH`, and a
font covering the language under test must be installed (`fonts-noto-cjk` for Chinese).

QA is separate and runnable: `sh docs/crew/qa/run-all.sh`.

**Neither replaces one real dsh session.** Two bugs in this repository passed every unit test
and only showed up when the thing actually ran: a relative path resolved against a changed
working directory, and a tool that returned the wrong content shape and rendered nothing. When
you touch the mount, boot it:

```sh
dsh plugin --profile headless add link:/path/to/dsh-narrate
cd /tmp/scratch && dsh --profile headless "call narrate_start with the idea …"
```

Two tests reach the Microsoft speech endpoint used by the bundled voice engine. **With no
network they skip out loud** — they print why and are marked skipped, never failed. Keep that
property when adding a test that needs the network: a red build must mean our code is wrong.

## The method this repository was built with

Built with [`dsh-crew`](https://github.com/stuarthu/dsh-crew), so the reasoning is written
down rather than lost. Read before changing anything:

| File | What it holds |
| --- | --- |
| `docs/crew/prd.md` | What is being built and why, the acceptance checks, the milestones |
| `docs/crew/hld.md` | The modules, where each boundary falls, which one is riskiest |
| `docs/crew/api/*.md` | Three boundary contracts, each with named errors and one test per side |
| `docs/crew/adr/*.md` | Five decisions, each with the options weighed and what it costs |
| `docs/crew/tasks.md` | Every task, the files it owns, the check it delivers, and the known weak spots |

These documents are in **Chinese**. Code, comments, commit messages, CI files and
`README.md` are in **English**. `README-zh.md` mirrors `README.md` and the two must be
changed together.

Job state lives outside the repository, in `~/.dsh/crew/jobs/dsh-narrate/state.json`, so
`git status` stays clean.

**A task owns its files.** `docs/crew/tasks.md` lists which task owns which file, and two
tasks never own the same one. There is exactly one documented exception, and the reason is
written in the task row. When a contract in `docs/crew/api/` changes, raise its version at
the top of the file and say what changed and whether it breaks the other side.

## Rules a change must not break

Each of these exists because the weaker version was tried and failed. Most were found by
running against real data, not by thinking.

1. **A section has one writer, and there is no whole-file writer.** `clip-file.js` exports
   `writeMeasuredSection`, `writeYourSection`, `writeMachineSection` and nothing wider. The
   mistake being prevented is recomputing the machine section and wiping the user's writing
   on the way past. A test asserts the exported writer names.

2. **Never change a key we did not create.** A clip's `bench.json` often already exists —
   stock footage sites ship metadata beside each clip. Use it, add only our own keys, and
   copy the file to `bench.json.bak` once before the first time we touch it. The first real
   asset folder tested was entirely archive.org metadata; refusing it indexed nothing at all.

3. **A description is written once.** Fill it only when empty; after that never touch it, not
   even a line we wrote ourselves. Clearing the field is how a user asks for it again.

4. **Tags are keywords only.** No resolution, frame rate, codec, container, or `HD`-style
   filler. They do not help choose a clip and they are often wrong: four clips all tagged
   `1080p` and `H.264` included a 640x360 one, a 532x300 one and a `vp8` one.

5. **Measure, do not believe.** Only the duration is stored, read with `ffprobe` every scan,
   because choosing a clip and cutting it both depend on it. Never take a length from a
   metadata field or from the understanding step.

6. **Picture length follows audio length, never the reverse.** See `adr/0005`. Changing the
   speaking rate to fit a fixed shot length is what makes narration sound fake.

7. **One bad clip never sinks a scan.** Each clip catches its own error and the scan reports
   them all at the end. A stem collision is the one exception: it is a folder-level problem,
   found before any work starts, so it stops everything. An error with no code becomes
   `E_SCAN_INTERNAL`, never `E_UNDERSTAND_FAILED` — a bug must not hide as "this video was
   hard to understand".

8. **Model-written text is data, never instructions.** Two places enforce this:
   - Subtitle text is escaped before it reaches a `.srt`. libass eats `{...}` as an override
     block, so `{note}sentence` silently loses those characters, and a blank line inside the
     text forges a second cue. Both were measured, both have tests.
   - A voice engine is run with an argv array and never a shell string, and the text is
     passed in a file rather than as an argument. A script is model output; it must never be
     able to reach a shell.

9. **Source files must be text.** A literal NUL byte once made git treat a source file as
   binary, which silently kills every future diff and with it code review. Write it as the escape
   sequence `\u0000`, never as the byte itself. A test scans `src/` for NUL bytes.

10. **Test first, and the report shows the failing run.** Write a failing test, check it
    fails because the behaviour is missing and not because the runner could not start, then
    write the smallest code that passes. A change without the red run is not finished.

11. **A tool's schema uses only the keywords dsh allows.** `tools.register` validates
    `output.schema` against a narrow subset — `type`, `oneOf`, `properties`, `required`,
    `additionalProperties`, `items`, `enum`, `const`, plus `description`, `title`, `default`,
    `examples`. `minLength`, `pattern` and `format` are rejected, and a rejection throws at
    mount time, which breaks the user's whole profile. `output` itself is required and
    `output.render` must be a function. `test/mount.test.js` checks every schema against a
    copy of that rule, and against dsh's own validator when it can be imported.

12. **`output.render` must return content blocks**, `[{ type: 'text', text: '…' }]`. Returning a
    bare array of strings throws nothing — dsh accepts it as lossless JSON — but the agent sees
    `(no output)` and the tool is silently mute. Found by running a real session after every
    unit test passed; the old test only asserted "serialises to JSON". `test/mount.test.js` now
    asserts the block shape and that a real return value renders visible text.

13. **The agent cannot be forced into an order.** The host has no way to make the agent call
    tools in sequence, so every rule that matters is a check inside `execute`. A rule that
    lives only in a tool's `description` is a suggestion.

14. **Report what happened.** A skipped test says it skipped. A placeholder says it is a
    placeholder. When the plugin replaces output of its own, it says so rather than letting
    the line vanish.

## CI

Two workflows, and the split is deliberate:

| Workflow | Fires on | Why |
| --- | --- | --- |
| `test.yml` | every branch push and every pull request | a broken commit on `main` is found the day it lands, not when someone cuts a release |
| `publish.yml` | `v*` tags only | work in progress cannot ship by accident |

`test.yml` names `branches`, which turns tag pushes off, so a release does not run the same
checks twice. It runs a Node matrix of 22 and 24 — the versions `engines` claims — because
`node --test` only takes glob patterns on newer Node, and letting the shell expand them
instead would break on Windows. Both workflows install `ffmpeg` and a CJK font first, and
`test.yml` also runs the QA scripts.

## Releases

`.github/workflows/publish.yml` fires on `v*` **tags only**. A push to `main` never
publishes, so work in progress cannot ship by accident.

**The first release is different.** npm trusted publishing (OIDC) can only be configured on a
package that already exists, so `v0.1.0` has to be published by hand from a machine holding
an npm token. After that one publish, set the trusted publisher on npmjs.com (user
`stuarthu`, repo `dsh-narrate`, workflow `publish.yml`, no environment) and every later tag
goes through the workflow with no secret stored anywhere.

Release flow: bump `version` in `package.json`, add the `CHANGELOG.md` section, commit, push
`main`, then push the matching `v*` tag. The workflow fails loudly if the tag and
`package.json` disagree.

**`dsh.bundle` and `cordis.patch.yml` must ship together.** `dsh-app-boot` throws when a
bundle's patch file cannot be read (`dsh-app-boot/lib/index.js`), so a declared mount whose
patch file is missing stops a user's whole dsh profile from booting. `0.1.0` shipped with the
field deliberately absent for exactly that reason; it went back in with the mount. If you
ever remove `cordis.patch.yml` from `files`, remove the `dsh` block in the same commit.

## Privacy

The bundled voice engine sends the narration text to a Microsoft endpoint through
`node-edge-tts`. That is the only thing in this plugin that leaves the machine: clips are cut
locally and nothing is ever uploaded to a platform. Both READMEs carry a data-flow table
saying so, and it must not be removed. It is not an official public API, so it can stop
working at any time — which is exactly why the engine is a swappable contract.
