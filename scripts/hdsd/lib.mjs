import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const VOICE = 'vi-VN-HoaiMyNeural';

/** Where the audio of the narration and the raw recordings are kept: a scratch directory that must stay on drive D (the temporary files of a recording are large). */
export function cacheDir(env = process.env) {
  return env.HDSD_CACHE ?? 'D:/tmp/hdsd-cache';
}

export function flowFile(id, root = REPO_ROOT) {
  return join(root, 'scripts', 'hdsd', 'flows', `${id}.json`);
}

/** A flow: what a person learns (title, audience, outcome) and the steps of the clip, each with the screens it shows and the words the voice says. */
export function loadFlow(id, root = REPO_ROOT) {
  const flow = JSON.parse(readFileSync(flowFile(id, root), 'utf8'));
  validateFlow(flow, id);
  return flow;
}

export function validateFlow(flow, id) {
  const problems = [];
  if (flow.id !== id) problems.push(`the id is ${flow.id}, the file is ${id}`);
  for (const key of ['title', 'audience', 'outcome']) if (typeof flow[key] !== 'string' || flow[key].trim() === '') problems.push(`${key} is missing`);
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) problems.push('the flow has no steps');
  const seen = new Set();
  for (const step of flow.steps ?? []) {
    if (typeof step.id !== 'string' || step.id === '') problems.push('a step has no id');
    else if (seen.has(step.id)) problems.push(`the step ${step.id} is twice`);
    else seen.add(step.id);
    for (const key of ['heading', 'text']) if (typeof step[key] !== 'string' || step[key].trim() === '') problems.push(`step ${step.id}: ${key} is missing`);
    if (!Array.isArray(step.screens)) problems.push(`step ${step.id}: screens is not a list`);
  }
  if (problems.length > 0) throw new Error(`flow ${id}: ${problems.join('; ')}`);
}

/** The key of one narration in the cache: the same words with the same voice are spoken once. */
export function hashOf(text, voice = VOICE) {
  return createHash('sha256').update(`${voice}\n${text}`).digest('hex').slice(0, 24);
}

/** The duration in milliseconds that `ffmpeg -i file` prints (`Duration: 00:00:09.17`). */
export function parseFfmpegDuration(output) {
  const found = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/u.exec(output);
  if (found === null) throw new Error('ffmpeg did not print a duration');
  const [, hours, minutes, seconds, fraction] = found;
  return Math.round((Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(`0.${fraction}`)) * 1000);
}

const stamp = /(\d+):(\d{2}):(\d{2})[,.](\d{3})/u;
const toMs = (text) => {
  const found = stamp.exec(text);
  if (found === null) throw new Error(`not a time stamp: ${text}`);
  return (Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3])) * 1000 + Number(found[4]);
};

/** The cues of a subtitle file that edge-tts writes (SRT with a comma or WebVTT with a dot). */
export function parseCues(text) {
  const cues = [];
  for (const block of text.replace(/\r/gu, '').split(/\n\n+/u)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '' && line.trim() !== 'WEBVTT');
    const at = lines.findIndex((line) => line.includes('-->'));
    if (at < 0) continue;
    const [from, to] = lines[at].split('-->');
    const words = lines.slice(at + 1).join(' ').trim();
    if (words !== '') cues.push({ from: toMs(from), to: toMs(to), text: words });
  }
  return cues;
}

export function shiftCues(cues, ms) {
  return cues.map((cue) => ({ ...cue, from: cue.from + ms, to: cue.to + ms }));
}

const clock = (ms) => {
  const total = Math.max(0, Math.round(ms));
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${pad(Math.floor(total / 3_600_000))}:${pad(Math.floor(total / 60_000) % 60)}:${pad(Math.floor(total / 1000) % 60)}.${pad(total % 1000, 3)}`;
};

export function formatVtt(cues) {
  return `WEBVTT\n\n${cues.map((cue, index) => `${index + 1}\n${clock(cue.from)} --> ${clock(cue.to)}\n${cue.text}\n`).join('\n')}`;
}

export const mmss = (ms) => `${String(Math.floor(ms / 60_000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
