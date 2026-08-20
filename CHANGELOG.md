# Changelog

Newest first. Each entry says what a user would notice.

## 0.1.0 — 2026-08-20

First release. One idea becomes one narrated video, and it stops four times to
ask you first.

An earlier draft of this section described only the first milestone. It was
never released, so it has been replaced rather than kept — what follows is what
this version actually does.

**The four stop points**

Nothing moves past one without a clear yes from you, and each is a check inside
a tool rather than a line of instruction an agent could ignore.

1. Four fixed questions before the script is written — no model and no network
   needed. Answering them *is* the yes.
2. The script, one numbered sentence per line. Handing in a script while a
   question is unanswered is refused.
3. The shot list, plus the sentences that have **no matching clip**, said plainly
   instead of filled with something that nearly fits.
4. An audio-only file. You listen to the pace before any picture is made,
   because if the pace is wrong the whole video has to be made again.

**Making the video**

- Every sentence is spoken, cut, subtitled and joined into one file — 1920x1080
  for landscape, 1080x1920 for portrait.
- Picture length follows audio length, never the other way round. A clip short
  by a fifth or less is slowed; more than that and it loops. The narration is
  never sped up or slowed, which is what makes narration sound fake.
- Clips of any size and frame rate can be mixed. Each is fitted into the frame
  with black bars rather than stretched, and every part is encoded to one shape,
  so joining them needs no re-encoding and loses no quality. The finished file
  is checked by decoding all of it, because a join can break without ffmpeg
  reporting an error.
- Subtitles are sized as ratios of the frame, so they look the same at any
  resolution, and they are burned after scaling rather than before.
- A bundled voice engine that needs no API key, and a command-line contract so
  you can swap in any other engine by changing configuration only. A sentence
  you did not edit keeps its recording rather than being spoken again.

**Your asset folder**

- Indexed recursively, following symlinks so clips on an external drive are
  found, writing one `<clip name>.json` beside each clip.
- **An existing json of that name is updated, not refused.** Stock footage sites
  ship metadata beside each clip; the plugin reads its title, description, tags
  and search term and uses them. Keys it did not create are left untouched, and
  a `.bak` copy is saved once before the first time it touches a file it did not
  write.
- Seven ways to describe a clip, folded into one shape: conversation, a hand
  edit, a `.narrate.txt` beside the clip, `clips.csv`, the json already there,
  the filename, the folder name. Notes are kept word for word and never parsed.
- Tags hold keywords only. Resolution, frame rate, codec, container and words
  like `HD` never become tags: they do not help choose a clip, and in real stock
  footage they are often wrong. Each clip's duration is measured with `ffprobe`,
  never taken from a metadata field. Nothing else about the file is stored.
- Only clips whose fingerprint changed are sent to the understanding step, so a
  second run costs nothing. A description is written once and then left alone;
  clear the field and scan again to have it filled fresh.
- One bad clip never sinks the whole run, and a file with an extension the
  plugin does not know is reported rather than silently skipped.

**In dsh**

Ten tools: start a video, record an answer, hand in a script, index the asset
folder, hand in what a clip contains, plan the shots, speak the script, render
the video, record that you said go ahead, and ask where things stand.

The split comes from how dsh works: the host cannot call a model. The plugin
holds the rules and the memory; the agent holds the judgement.

**What is not there yet**

- A landscape clip in a portrait video gets wide black bars above and below.
  Keeping the shape is honest but is not what TikTok and Shorts look like.
  Cropping to fill is not implemented.
- The understanding step is a plug-in point. How well a clip is understood is up
  to the agent and its tools. With no understanding at all, matching still works
  from your own descriptions and tags, just less well.
- Nothing is uploaded anywhere. No platform account, no scheduling, no
  thumbnail. This plugin makes a file.

**Privacy.** The bundled voice engine sends your narration text to a Microsoft
endpoint. Your clips and your finished video never leave your machine. Both
READMEs carry the full table.
