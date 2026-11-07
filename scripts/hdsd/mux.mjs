import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheDir, formatVtt, REPO_ROOT, shiftCues } from './lib.mjs';
import { FFMPEG } from './tts.mjs';

/** The ffmpeg graph that lays the voice of each step on one track, each starting at its own moment of the video. */
export function audioGraph(delaysMs) {
  const delayed = delaysMs.map((ms, index) => `[${index + 1}:a]adelay=${Math.round(ms)}|${Math.round(ms)}[v${index}]`);
  const inputs = delaysMs.map((_, index) => `[v${index}]`).join('');
  return `${delayed.join(';')};${inputs}amix=inputs=${delaysMs.length}:normalize=0:dropout_transition=0[a]`;
}

/** The captions of a clip: the sentences of each voice, moved to the moment the voice begins in the video. */
export function captionsOf(timeline, audio) {
  return formatVtt(timeline.flatMap((entry) => shiftCues(audio.steps[entry.id].cues, entry.voiceMs)));
}

function run(args) {
  const done = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`ffmpeg failed: ${done.stderr}`);
}

/** Cuts the recording of a flow into the files of the guide: the film with its voice, the captions, a picture of each step. */
export function mux(flowId, { cache = cacheDir(), root = REPO_ROOT } = {}) {
  const rec = join(cache, 'rec', flowId);
  const { timeline } = JSON.parse(readFileSync(join(rec, 'timeline.json'), 'utf8'));
  const audio = JSON.parse(readFileSync(join(cache, `${flowId}.audio.json`), 'utf8'));
  const out = join(root, 'docs', 'hdsd', 'machvon');
  const clips = join(out, 'clips');
  const images = join(out, 'img', flowId);
  mkdirSync(clips, { recursive: true });
  mkdirSync(images, { recursive: true });

  const mp3s = timeline.map((entry) => audio.steps[entry.id].mp3);
  const mp4 = join(clips, `${flowId}.mp4`);
  run([
    '-i', join(rec, 'video.webm'),
    ...mp3s.flatMap((file) => ['-i', file]),
    '-filter_complex', audioGraph(timeline.map((entry) => entry.voiceMs)),
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-preset', 'medium',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart',
    mp4,
  ]);
  writeFileSync(join(clips, `${flowId}.vi.vtt`), captionsOf(timeline, audio));
  for (const entry of timeline) copyFileSync(entry.shot, join(images, `${entry.id}.png`));
  run(['-ss', '0.2', '-i', join(rec, 'video.webm'), '-frames:v', '1', '-q:v', '4', join(images, 'poster.jpg')]);
  writeFileSync(join(out, `${flowId}.timeline.json`), `${JSON.stringify({ flow: flowId, timeline: timeline.map((entry) => ({ id: entry.id, heading: entry.heading, screens: entry.screens, startMs: entry.startMs, endMs: entry.endMs, voiceMs: entry.voiceMs })) }, null, 2)}\n`);
  return { mp4, steps: timeline.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error('usage: node scripts/hdsd/mux.mjs <flow id>...');
    process.exitCode = 1;
  }
  for (const id of ids) {
    if (!existsSync(join(cacheDir(), 'rec', id, 'timeline.json'))) throw new Error(`no recording of ${id}: record it first`);
    const done = mux(id);
    console.log(`${id}: ${done.mp4} (${done.steps} steps)`);
  }
}
