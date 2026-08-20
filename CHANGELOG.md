# Changelog

Newest first. Each entry says what a user would notice.

## Unreleased

- Indexes your asset folder. It walks it recursively, follows symlinks so clips on an
  external drive are found, and writes one `<clip name>.json` beside each clip.
- **An existing json of that name is updated, not refused.** Stock footage sites ship
  metadata beside each clip; the plugin reads its title, description, tags and search term
  and uses them. Keys it did not create are left untouched, and a `.bak` copy is saved once
  before the first time it touches a file it did not write.
- Seven ways to describe a clip, folded into one shape: conversation, a hand edit, a
  `.narrate.txt` beside the clip, `clips.csv`, the json already there, the filename, the
  folder name. Notes are kept word for word and never parsed.
- Only clips whose fingerprint changed are sent to the understanding step, so a second run
  costs nothing. Your own writing is never overwritten by the machine, and when the plugin
  does replace its own earlier output it says so.
- One bad clip no longer sinks the whole run, and a file with an extension the plugin does
  not know is reported rather than silently skipped.

## 0.1.0

First release. This is an early version: the pieces that turn one sentence into
a finished clip work and are tested, but the parts that turn one *idea* into a
whole video are not built yet.

What works:

- Speak one sentence with a text-to-speech engine, trim the silence off both
  ends, and measure the real length of the audio.
- Cut a clip from one of your own video files to exactly that length, mix the
  narration in, and burn the sentence onto the picture as a subtitle.
- A job file (`job.json`) that every stage reads and writes, where each stage
  can only write its own section. Writing another stage's section raises an
  error straight away instead of corrupting the video.
- A bundled voice engine that needs no API key, and a command-line contract so
  you can swap in any other engine by changing configuration only.

What does not work yet:

- There is no command that takes an idea and gives you a video. You write
  `job.json` by hand for now.
- No asset folder indexing, no script writing, no shot planning, no review
  stops. Those are the next four milestones.
- The plugin does not mount into dsh yet. 0.1.0 deliberately declares no
  `dsh.bundle`: dsh throws when a bundle's patch file is missing, so declaring
  the mount early would stop a whole profile from booting.

Please read the **Privacy** section of the README before you use the bundled
voice engine. It sends your narration text to a Microsoft server.
