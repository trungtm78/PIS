import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argument, flag, loadSpec, positionals, readJson } from './common.mjs';
import { loadScenario, recordableScenes } from './scenario.mjs';
import { displayText, sentencesOf, sceneMsFromVoice } from './text.mjs';

const letters = (text) => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;

/** One text as at most `maxLines` lines of at most `maxChars`, broken at the space nearest the middle so that the lines are balanced. */
export function wrapLines(text, maxChars, maxLines) {
  const words = text.trim().split(/\s+/u);
  if (words.join(' ').length <= maxChars) return [words.join(' ')];
  if (maxLines < 2) return null;
  let best = null;
  for (let cut = 1; cut < words.length; cut += 1) {
    const left = words.slice(0, cut).join(' ');
    const right = words.slice(cut).join(' ');
    if (left.length > maxChars || right.length > maxChars) continue;
    const score = Math.abs(left.length - right.length);
    if (best === null || score < best.score) best = { score, lines: [left, right] };
  }
  return best === null ? null : best.lines;
}

/** The words cut into `count` pieces of about the same length, preferring a break after a comma when one is near. */
function balancedSplit(words, count) {
  const ends = [];
  let position = 0;
  for (const word of words) {
    position += word.length + 1;
    ends.push(position - 1);
  }
  const total = ends[ends.length - 1];
  const cuts = [];
  for (let piece = 1; piece < count; piece += 1) {
    const target = (total * piece) / count;
    let best = -1;
    let bestScore = Infinity;
    for (let at = (cuts[cuts.length - 1] ?? -1) + 1; at < words.length - 1; at += 1) {
      const distance = Math.abs(ends[at] - target);
      const score = distance - (/[,:;]$/u.test(words[at]) && distance <= 10 ? 12 : 0);
      if (score < bestScore) {
        best = at;
        bestScore = score;
      }
    }
    if (best >= 0) cuts.push(best);
  }
  const pieces = [];
  let from = 0;
  for (const cut of cuts) {
    pieces.push(words.slice(from, cut + 1).join(' '));
    from = cut + 1;
  }
  pieces.push(words.slice(from).join(' '));
  return pieces;
}

/** A sentence cut into the fewest balanced pieces that each fit in one cue (at most `maxLines` lines of `maxCharsPerLine`). */
export function chunkSentence(sentence, rules) {
  const limit = rules.maxCharsPerLine * rules.maxLines;
  if (sentence.length <= limit && wrapLines(sentence, rules.maxCharsPerLine, rules.maxLines) !== null) return [sentence];
  const words = sentence.split(/\s+/u);
  for (let count = Math.max(2, Math.ceil(sentence.length / limit)); count <= words.length; count += 1) {
    const pieces = balancedSplit(words, count);
    if (pieces.every((piece) => wrapLines(piece, rules.maxCharsPerLine, rules.maxLines) !== null)) return pieces;
  }
  return words;
}

/** A text in two halves of about the same number of words. */
function halve(text) {
  const words = text.split(/\s+/u);
  if (words.length < 2) return [text];
  const middle = Math.ceil(words.length / 2);
  return [words.slice(0, middle).join(' '), words.slice(middle).join(' ')];
}

/**
 * The cues of one scene: the displayed narration cut into pieces that fit the line rules, spread over the voice in proportion to their letters.
 * Short neighbours are merged until a cue lasts at least the minimum, a cue that lasts too long is cut again.
 */
export function cuesForScene(text, startMs, endMs, rules) {
  let pieces = sentencesOf(text).flatMap((sentence) => chunkSentence(sentence, rules));
  const total = Math.max(1, pieces.reduce((sum, piece) => sum + letters(piece), 0));
  const span = Math.max(1, endMs - startMs);
  const lengthOf = (piece) => (letters(piece) / total) * span;
  for (let again = 0; again < 8; again += 1) {
    const merged = [];
    for (const piece of pieces) {
      const last = merged[merged.length - 1];
      if (last !== undefined && (lengthOf(last) < rules.minCueMs || lengthOf(piece) < rules.minCueMs) && wrapLines(`${last} ${piece}`, rules.maxCharsPerLine, rules.maxLines) !== null) merged[merged.length - 1] = `${last} ${piece}`;
      else merged.push(piece);
    }
    pieces = merged.flatMap((piece) => (lengthOf(piece) > rules.maxCueMs && piece.split(/\s+/u).length > 1 ? halve(piece) : [piece]));
    if (pieces.every((piece) => lengthOf(piece) <= rules.maxCueMs)) break;
  }
  const cues = [];
  let cursor = startMs;
  pieces.forEach((piece, index) => {
    const end = index === pieces.length - 1 ? endMs : Math.round(cursor + lengthOf(piece));
    const lines = wrapLines(piece, rules.maxCharsPerLine, rules.maxLines) ?? [piece];
    cues.push({ startMs: Math.round(cursor), endMs: Math.max(Math.round(cursor) + 1, end - (index === pieces.length - 1 ? 0 : rules.gapMs)), text: lines.join('\n') });
    cursor = end;
  });
  return cues;
}

const pad = (value, size = 2) => String(value).padStart(size, '0');
export function timestamp(ms, separator) {
  const total = Math.max(0, Math.round(ms));
  return `${pad(Math.floor(total / 3_600_000))}:${pad(Math.floor(total / 60_000) % 60)}:${pad(Math.floor(total / 1000) % 60)}${separator}${pad(total % 1000, 3)}`;
}

export const formatSrt = (cues) => `${cues.map((cue, index) => `${index + 1}\n${timestamp(cue.startMs, ',')} --> ${timestamp(cue.endMs, ',')}\n${cue.text}\n`).join('\n')}`;
export const formatVtt = (cues) => `WEBVTT\n\n${cues.map((cue, index) => `${index + 1}\n${timestamp(cue.startMs, '.')} --> ${timestamp(cue.endMs, '.')}\n${cue.text}\n`).join('\n')}`;

const STAMP = /(\d+):(\d{2}):(\d{2})[,.](\d{3})/u;
const toMs = (text) => {
  const found = STAMP.exec(text);
  if (found === null) throw new Error(`not a time stamp: ${text}`);
  return (Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3])) * 1000 + Number(found[4]);
};

/** Cues of an SRT or WebVTT text. */
export function parseCues(text) {
  const cues = [];
  for (const block of text.replace(/\r/gu, '').split(/\n\n+/u)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '' && line.trim() !== 'WEBVTT');
    const at = lines.findIndex((line) => line.includes('-->'));
    if (at < 0) continue;
    const [from, to] = lines[at].split('-->');
    cues.push({ startMs: toMs(from), endMs: toMs(to), text: lines.slice(at + 1).join('\n') });
  }
  return cues;
}

/** Everything that breaks the rules of readable subtitles at 1080p (an empty list is a pass). */
export function checkCues(cues, rules = loadSpec().subtitles) {
  const problems = [];
  let previousEnd = -1;
  cues.forEach((cue, index) => {
    const where = `cue ${index + 1}`;
    const lines = cue.text.split('\n');
    const duration = cue.endMs - cue.startMs;
    if (lines.length > rules.maxLines) problems.push(`${where}: ${lines.length} lines (max ${rules.maxLines})`);
    for (const line of lines) if (line.length > rules.maxCharsPerLine) problems.push(`${where}: a line of ${line.length} characters (max ${rules.maxCharsPerLine})`);
    if (duration > rules.maxCueMs) problems.push(`${where}: lasts ${duration} ms (max ${rules.maxCueMs})`);
    if (duration < rules.minCueMs && index !== cues.length - 1) problems.push(`${where}: lasts ${duration} ms (min ${rules.minCueMs})`);
    const cps = letters(cue.text) / Math.max(0.001, duration / 1000);
    if (cps > rules.maxCharsPerSecond + 3) problems.push(`${where}: ${cps.toFixed(1)} characters per second (limit ${rules.maxCharsPerSecond})`);
    if (cue.startMs < previousEnd) problems.push(`${where}: starts before the previous cue ends`);
    previousEnd = cue.endMs;
  });
  return problems;
}

/**
 * The timeline of a cut: when each scene starts and its voice begins and ends. `audio` maps a scene id to the measured `voiceMs`; where it is missing
 * (authoring time) the estimate given by `estimate(scene)` is used and the entry says so. Subtitles and on-screen captions are placed on it.
 */
export function buildTimeline(scenes, audio, { spec = loadSpec(), estimate, figures = {}, manifest, mode = 'manifest' } = {}) {
  const entries = [];
  let cursor = 0;
  for (const scene of scenes) {
    const measured = audio?.[scene.id]?.voiceMs;
    const voiceMs = measured ?? estimate(scene);
    const sceneMs = Math.max(sceneMsFromVoice(voiceMs, spec), audio?.[scene.id]?.visualMs ?? 0);
    const voiceStartMs = cursor + spec.narration.leadInMs;
    const voiceEndMs = voiceStartMs + voiceMs;
    const text = displayText(scene.narration, { figures, manifest, mode });
    entries.push({
      id: scene.id,
      chapter: scene.chapter,
      startMs: cursor,
      endMs: cursor + sceneMs,
      voiceStartMs,
      voiceEndMs,
      measured: measured !== undefined,
      subtitles: cuesForScene(text, voiceStartMs, voiceEndMs, spec.subtitles),
      captions: (scene.captions ?? []).map((caption) => ({
        startMs: cursor + Math.round(caption.atSec * 1000),
        endMs: cursor + Math.round((caption.atSec + caption.forSec) * 1000),
        text: displayText(caption.text, { figures, manifest, mode }),
      })),
    });
    cursor += sceneMs;
  }
  return { totalMs: cursor, scenes: entries };
}

export const cuesOf = (timeline) => timeline.scenes.flatMap((scene) => scene.subtitles);

function main(argv) {
  const [clip, cut = 'main'] = positionals(argv, ['out', 'audio', 'manifest']);
  const out = argument(argv, 'out');
  const audioPath = argument(argv, 'audio');
  const manifestPath = argument(argv, 'manifest');
  if (clip === undefined || out === undefined || audioPath === undefined) {
    console.error('usage: node scripts/clips/subtitles.mjs <clip> [main|chapter-id] --audio <clip>.audio.json --manifest <data-manifest.json> --out <dir>');
    return 2;
  }
  const scenario = loadScenario(clip);
  const audio = JSON.parse(readFileSync(audioPath, 'utf8')).scenes;
  const manifest = manifestPath === undefined ? undefined : readJson(manifestPath);
  const scenes = recordableScenes(scenario, cut, { includePending: flag(argv, 'include-pending') });
  const missing = scenes.filter((scene) => audio[scene.id]?.voiceMs === undefined).map((scene) => scene.id);
  if (missing.length > 0) {
    console.error(`no measured voice for: ${missing.join(', ')} (run tts.mjs first)`);
    return 1;
  }
  const timeline = buildTimeline(scenes, audio, { figures: scenario.figures, manifest, estimate: () => 0 });
  mkdirSync(out, { recursive: true });
  const cues = cuesOf(timeline);
  const problems = checkCues(cues);
  writeFileSync(join(out, `${clip}.${cut}.timeline.json`), `${JSON.stringify(timeline, null, 2)}\n`);
  writeFileSync(join(out, `${clip}.${cut}.srt`), formatSrt(cues));
  writeFileSync(join(out, `${clip}.${cut}.vtt`), formatVtt(cues));
  console.log(`${clip}/${cut}: ${cues.length} cues, ${(timeline.totalMs / 1000).toFixed(1)} s${problems.length === 0 ? '' : `, ${problems.length} subtitle problem(s)`}`);
  for (const problem of problems) console.log(`  ${problem}`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
