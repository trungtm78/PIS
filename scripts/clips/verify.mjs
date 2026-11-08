import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argument, clock, loadSpec, positionals } from './common.mjs';
import { FFMPEG } from './mix.mjs';
import { checkCues, parseCues } from './subtitles.mjs';

/** Where ffprobe is: the variable CLIPS_FFPROBE, a binary next to the ffmpeg, or the PATH. The ffmpeg of the guide tooling ships without one, so there is a fallback that reads ffmpeg's own report. */
export function findFfprobe(env = process.env, exists = existsSync) {
  const beside = join(dirname(FFMPEG), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  for (const candidate of [env.CLIPS_FFPROBE, beside]) if (candidate !== undefined && candidate !== '' && exists(candidate)) return candidate;
  const probe = spawnSync(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe', ['-version'], { encoding: 'utf8' });
  return probe.status === 0 ? 'ffprobe' : undefined;
}

/** The facts of a file from the JSON of `ffprobe -show_streams -show_format -of json`. */
export function factsFromFfprobe(json) {
  const video = json.streams.find((stream) => stream.codec_type === 'video');
  const audio = json.streams.find((stream) => stream.codec_type === 'audio');
  const rate = (video?.avg_frame_rate ?? video?.r_frame_rate ?? '0/1').split('/').map(Number);
  return {
    width: video?.width,
    height: video?.height,
    fps: rate[1] ? rate[0] / rate[1] : rate[0],
    durationSec: Number(json.format?.duration ?? video?.duration ?? 0),
    hasAudio: audio !== undefined,
    subtitleStreams: json.streams.filter((stream) => stream.codec_type === 'subtitle').length,
  };
}

const STREAM = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: /u.source;

/** The same facts from the text `ffmpeg -i file` prints (used when there is no ffprobe). */
export function factsFromFfmpeg(report) {
  const duration = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/u.exec(report);
  const video = new RegExp(String.raw`${STREAM}Video: [^\n]*?, (\d{3,5})x(\d{3,5})[^\n]*?, ([\d.]+) fps`, 'u').exec(report);
  return {
    width: video === null ? undefined : Number(video[1]),
    height: video === null ? undefined : Number(video[2]),
    fps: video === null ? undefined : Number(video[3]),
    durationSec: duration === null ? 0 : Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) + Number(`0.${duration[4]}`),
    hasAudio: new RegExp(`${STREAM}Audio:`, 'u').test(report),
    subtitleStreams: (report.match(new RegExp(`${STREAM}Subtitle:`, 'gu')) ?? []).length,
  };
}

/** The integrated loudness and the true peak from the summary of ffmpeg's ebur128 filter. */
export function loudnessFromEbur128(report) {
  const summary = report.slice(report.lastIndexOf('Summary:'));
  const integrated = /I:\s+(-?[\d.]+) LUFS/u.exec(summary);
  const peak = /Peak:\s+(-?[\d.]+) dBFS/u.exec(summary);
  const range = /LRA:\s+(-?[\d.]+) LU/u.exec(summary);
  if (integrated === null) throw new Error('the loudness report has no integrated value');
  return { integratedLufs: Number(integrated[1]), truePeakDb: peak === null ? undefined : Number(peak[1]), rangeLu: range === null ? undefined : Number(range[1]) };
}

/** What is wrong with a clip (an empty list is a pass). `kind` is `main` or `chapter`. */
export function judge({ facts, loudness, cues, sidecars, kind, spec = loadSpec() }) {
  const problems = [];
  const { video } = spec;
  if (facts.width !== video.width || facts.height !== video.height) problems.push(`size is ${facts.width}x${facts.height}, expected ${video.width}x${video.height}`);
  if (facts.fps === undefined || Math.abs(facts.fps - video.fps) > 0.01) problems.push(`frame rate is ${facts.fps}, expected ${video.fps}`);
  const range = kind === 'main' ? spec.mainVideo : spec.chapterCut;
  if (facts.durationSec < range.minSec || facts.durationSec > range.maxSec) problems.push(`duration is ${clock(facts.durationSec)} (${facts.durationSec.toFixed(1)} s), expected ${range.minSec}-${range.maxSec} s for a ${kind}`);
  if (!facts.hasAudio) problems.push('no audio stream');
  if (loudness === undefined) problems.push('the loudness was not measured');
  else {
    if (Math.abs(loudness.integratedLufs - spec.audio.integratedLufs) > spec.audio.toleranceLu) problems.push(`loudness is ${loudness.integratedLufs} LUFS, expected ${spec.audio.integratedLufs} +/- ${spec.audio.toleranceLu}`);
    if (loudness.truePeakDb !== undefined && loudness.truePeakDb > spec.audio.truePeakMaxDb) problems.push(`true peak is ${loudness.truePeakDb} dBFS, above ${spec.audio.truePeakMaxDb}`);
  }
  if (sidecars.srt === undefined || sidecars.vtt === undefined) problems.push('the .srt and .vtt files are missing beside the video');
  if (sidecars.record?.burnedInSubtitles !== true) problems.push('the record of the mix does not say the subtitles are burned in');
  if (cues === undefined || cues.length === 0) problems.push('the subtitles have no cue');
  else {
    problems.push(...checkCues(cues, spec.subtitles).map((message) => `subtitles: ${message}`));
    const last = cues[cues.length - 1];
    if (last.endMs / 1000 > facts.durationSec + 1) problems.push('the subtitles run past the end of the video');
  }
  return problems;
}

function inspect(file) {
  const ffprobe = findFfprobe();
  let facts;
  if (ffprobe !== undefined) {
    const done = spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (done.status !== 0) throw new Error(`ffprobe failed: ${done.stderr}`);
    facts = factsFromFfprobe(JSON.parse(done.stdout));
  } else {
    const done = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8', maxBuffer: 1 << 26 });
    facts = factsFromFfmpeg(`${done.stderr}${done.stdout}`);
  }
  const loud = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-vn', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return { facts, loudness: loudnessFromEbur128(loud.stderr ?? ''), tool: ffprobe === undefined ? 'ffmpeg report (no ffprobe found)' : 'ffprobe' };
}

function main(argv) {
  const [file] = positionals(argv, ['kind']);
  const kind = argument(argv, 'kind', 'main');
  if (file === undefined || !['main', 'chapter'].includes(kind)) {
    console.error('usage: node scripts/clips/verify.mjs <final.mp4> [--kind main|chapter]');
    return 2;
  }
  const stem = file.replace(/\.[^.]+$/u, '');
  const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
  const srt = read(`${stem}.srt`);
  const vtt = read(`${stem}.vtt`);
  const record = read(`${stem}.clip.json`);
  try {
    const { facts, loudness, tool } = inspect(file);
    const problems = judge({ facts, loudness, cues: srt === undefined ? undefined : parseCues(srt), sidecars: { srt, vtt, record: record === undefined ? undefined : JSON.parse(record) }, kind });
    console.log(`${file} (${tool}): ${facts.width}x${facts.height} @ ${facts.fps} fps, ${clock(facts.durationSec)}, ${loudness.integratedLufs} LUFS, peak ${loudness.truePeakDb} dBFS, ${facts.subtitleStreams} soft subtitle track(s)`);
    for (const problem of problems) console.log(`  FAIL ${problem}`);
    console.log(problems.length === 0 ? '  PASS' : `  ${problems.length} problem(s)`);
    return problems.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(`verify: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
