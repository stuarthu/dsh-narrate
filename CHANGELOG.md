# Changelog

Newest first. Each entry says what a user would notice.

## Unreleased

- **A whole video comes out the other end.** Every sentence is spoken, cut, subtitled and
  joined into one file, at 1920x1080 for landscape or 1080x1920 for portrait.
- A clip that is shorter than its narration no longer stops the render. If it is short by a
  fifth or less the picture slows down; more than that and it loops. The narration is never
  sped up or slowed — that is what makes narration sound fake.
- Clips of any size and frame rate can be mixed. Each one is fitted into the frame with black
  bars rather than stretched, and every part is encoded to one shape so joining them does not
  re-encode and does not lose quality. The finished file is checked by decoding all of it,
  because a join can break without ffmpeg reporting an error.
- **Subtitles are now placed where you would expect on a phone.** Sizes and margins used to be
  handed to ffmpeg as pixels, which libass silently rescaled: in portrait the subtitle landed
  at the *top* of the frame. Sizes are now ratios of the frame, so a subtitle looks the same
  at any resolution.
- The text file handed to the speech engine is deleted once the line is spoken. It is kept when
  the line fails, since that is when you need to see it.
- **It is a real dsh plugin now.** `dsh plugin --profile tui add dsh-narrate` registers six
  tools the agent can call: start a video, record an answer, hand in a script, index the asset
  folder, hand in what a clip contains, and ask where things stand.
- Stop point one works with no model and no network: the four questions are fixed. Stop point
  two refuses to store a script while a question is unanswered, and that is a check inside the
  tool rather than a line of instruction.
- Indexing now reports which clips still need understanding instead of trying to understand
  them itself, because the host cannot call a model. Durations are still measured on the spot.
- Tool results are rendered as content blocks, so the agent actually sees them. A bare
  string array serialises fine and shows as nothing at all.
- A clip's duration is always measured, never taken from what the agent claims.

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
  costs nothing. A description is written once and then left alone; clear the field and scan
  again if you want it filled fresh. Notes and tags merge, and the plugin says so when it
  replaces earlier output of its own.
- Tags hold keywords only. Resolution, frame rate, codec, container and words like `HD`
  never become tags: they do not help choose a clip, and in real stock footage they are
  often wrong. Each clip's duration is measured with `ffprobe`, because choosing and cutting
  both depend on it. Nothing else about the file is stored.
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
