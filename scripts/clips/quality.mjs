// Quality check of a screen film: windows of frames that do not change (a frozen page, a recording that stalled), black windows, and what the recorder saw in the
// page (a spinner still turning, an error banner). The findings go to the make report so that a bad scene is retaken before the film is mixed.
//   node scripts/clips/quality.mjs <film.mp4> [--timeline <clip.cut.timeline.json>] [--report <clip.cut.make.json>] [--max-freeze 7] [--min-black 0.8]
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argument, positionals, readJson } from './common.mjs';
import { FFMPEG } from './mix.mjs';

/** Windows of identical frames from the log of ffmpeg freezedetect: [{ startSec, endSec, durationSec }]. */
export function parseFreezeDetect(log) {
  const found = [];
  let current = null;
  for (const line of log.split('\n')) {
    const start = /lavfi\.freezedetect\.freeze_start: ([\d.]+)/u.exec(line);
    const duration = /lavfi\.freezedetect\.freeze_duration: ([\d.]+)/u.exec(line);
    const end = /lavfi\.freezedetect\.freeze_end: ([\d.]+)/u.exec(line);
    if (start !== null) current = { startSec: Number(start[1]), endSec: null, durationSec: null };
    if (duration !== null && current !== null) current.durationSec = Number(duration[1]);
    if (end !== null && current !== null) {
      current.endSec = Number(end[1]);
      found.push(current);
      current = null;
    }
  }
  return found;
}

/** A freeze that is still going at the end of the film has no end line: it is closed at `totalSec`. */
export function closeFreezes(windows, openStartSec, totalSec) {
  return openStartSec === null ? windows : [...windows, { startSec: openStartSec, endSec: totalSec, durationSec: Math.max(0, totalSec - openStartSec) }];
}

/** The start of a freeze the log opened and never closed, or null. */
export function openFreeze(log) {
  const starts = [...log.matchAll(/lavfi\.freezedetect\.freeze_start: ([\d.]+)/gu)].map((match) => Number(match[1]));
  const ends = [...log.matchAll(/lavfi\.freezedetect\.freeze_end: ([\d.]+)/gu)].length;
  return starts.length > ends ? starts.at(-1) : null;
}

/** Black windows from blackdetect: [{ startSec, endSec, durationSec }]. */
export function parseBlackDetect(log) {
  return [...log.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/gu)].map((match) => ({ startSec: Number(match[1]), endSec: Number(match[2]), durationSec: Number(match[3]) }));
}

/** The length of a film from the `Duration:` line of ffmpeg; null when absent. */
export function parseDuration(log) {
  const match = /Duration: (\d+):(\d+):([\d.]+)/u.exec(log);
  return match === null ? null : Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** Runs ffmpeg once over the film with both detectors. */
export function analyzeVideo(file, { freezeNoise = '-58dB', freezeMinSec = 3, blackMinSec = 0.8, runner = (args) => spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 1 << 28 }) } = {}) {
  const done = runner(['-hide_banner', '-nostats', '-i', file, '-an', '-vf', `freezedetect=n=${freezeNoise}:d=${freezeMinSec},blackdetect=d=${blackMinSec}:pic_th=0.98`, '-f', 'null', '-']);
  const log = `${done.stderr ?? ''}`;
  if (done.status !== 0) throw new Error(`ffmpeg quality pass failed: ${log.split('\n').slice(-4).join(' ')}`);
  const totalSec = parseDuration(log);
  return { totalSec, freezes: closeFreezes(parseFreezeDetect(log), openFreeze(log), totalSec ?? 0), blacks: parseBlackDetect(log) };
}

const at = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** The scene of a timeline that holds a time, or null. */
export const sceneAt = (timeline, sec) => timeline?.scenes?.find((scene) => sec * 1000 >= scene.startMs && sec * 1000 < scene.endMs)?.id ?? null;

/**
 * Findings, worst first: a window of identical frames longer than `maxFreezeSec` (a stalled page), a black window, and the problems the recorder saw in the page
 * (`makeReport.scenes[].problems`, `steps` skipped). `timeline` names the scene of each window.
 */
export function findings({ freezes, blacks }, { timeline, makeReport, maxFreezeSec = 7, minBlackSec = 0.8 } = {}) {
  const list = [];
  for (const window of freezes) {
    if (window.durationSec > maxFreezeSec) list.push({ level: 'warn', kind: 'frozen', scene: sceneAt(timeline, window.startSec + 0.1), startSec: window.startSec, durationSec: window.durationSec, text: `frames do not change for ${window.durationSec.toFixed(1)} s from ${at(window.startSec)}` });
  }
  for (const window of blacks) {
    if (window.durationSec >= minBlackSec) list.push({ level: 'warn', kind: 'black', scene: sceneAt(timeline, window.startSec + 0.1), startSec: window.startSec, durationSec: window.durationSec, text: `black picture for ${window.durationSec.toFixed(1)} s from ${at(window.startSec)}` });
  }
  for (const scene of makeReport?.scenes ?? []) {
    for (const problem of scene.problems ?? []) list.push({ level: 'error', kind: 'page', scene: scene.id, text: `page problem: ${problem}` });
    const skipped = (scene.steps?.lines ?? []).filter((line) => line.status === 'skipped' && !/outside the screen|phone step/u.test(line.reason ?? '')).length;
    if (scene.steps !== undefined && scene.steps.total > 0 && skipped / scene.steps.total > 0.5) list.push({ level: 'info', kind: 'steps', scene: scene.id, text: `${skipped} of ${scene.steps.total} steps could not be replayed` });
  }
  const rank = { error: 0, warn: 1, info: 2 };
  return list.sort((a, b) => rank[a.level] - rank[b.level] || (a.startSec ?? 0) - (b.startSec ?? 0));
}

/** The make report with a `quality` section added (the file is rewritten). */
export function addQuality(reportPath, quality) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  writeFileSync(reportPath, `${JSON.stringify({ ...report, quality }, null, 2)}\n`);
}

function main(argv) {
  const [film] = positionals(argv, ['timeline', 'report', 'max-freeze', 'min-black']);
  if (film === undefined) {
    console.error('usage: node scripts/clips/quality.mjs <film.mp4> [--timeline timeline.json] [--report make.json] [--max-freeze 7] [--min-black 0.8]');
    return 2;
  }
  const timelinePath = argument(argv, 'timeline');
  const reportPath = argument(argv, 'report');
  const timeline = timelinePath === undefined ? undefined : readJson(resolve(timelinePath));
  const makeReport = reportPath === undefined ? undefined : readJson(resolve(reportPath));
  const analysis = analyzeVideo(film);
  const list = findings(analysis, { timeline, makeReport, maxFreezeSec: Number(argument(argv, 'max-freeze', '7')), minBlackSec: Number(argument(argv, 'min-black', '0.8')) });
  for (const item of list) console.log(`${item.level} ${item.scene ?? '-'}: ${item.text}`);
  console.log(`${list.length} findings in ${analysis.totalSec?.toFixed(0) ?? '?'} s of film (${analysis.freezes.length} still windows, ${analysis.blacks.length} black windows)`);
  if (reportPath !== undefined) addQuality(resolve(reportPath), { freezes: analysis.freezes, blacks: analysis.blacks, findings: list });
  return list.some((item) => item.level === 'error') ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
