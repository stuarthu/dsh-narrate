# Changelog

Newest first. Each entry says what a user would notice.

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
