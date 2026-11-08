import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argument, flag, loadSpec, readJson, REPO_ROOT } from './common.mjs';
import { cuesOf, formatSrt, formatVtt } from './subtitles.mjs';

/** The ffmpeg of the guide tooling (scripts/hdsd/tts.mjs): the same variable and the same default. */
export const FFMPEG = process.env.HDSD_FFMPEG ?? 'D:/Python312/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe';

/** An ASS colour (`&HAABBGGRR`) from `#RRGGBB`; `opacity` 1 is solid (ASS alpha 00 is opaque). */
export function assColour(hex, opacity = 1) {
  const match = /^#([0-9a-f]{6})$/iu.exec(hex);
  if (match === null) throw new Error(`not a #RRGGBB colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((at) => match[1].slice(at, at + 2).toUpperCase());
  const alpha = Math.round((1 - opacity) * 255).toString(16).toUpperCase().padStart(2, '0');
  return `&H${alpha}${b}${g}${r}`;
}

/** The subtitle style of the clips: Be Vietnam Pro, white on a box of the dark workspace colour of the design tokens. */
export function subtitleStyle(spec = loadSpec(), tokens = readJson(join(REPO_ROOT, 'Design', 'MACHVON_Design', '04_Design_Assets', 'design_tokens.json'))) {
  const s = spec.subtitles;
  const background = tokens.color[s.backgroundToken];
  if (background === undefined) throw new Error(`design token ${s.backgroundToken} not found`);
  return [
    `FontName=${s.fontName}`,
    `FontSize=${s.fontSize}`,
    `PrimaryColour=${assColour(s.textColour)}`,
    `OutlineColour=${assColour(background, s.backgroundAlpha)}`,
    `BackColour=${assColour(background, s.backgroundAlpha)}`,
    'BorderStyle=3',
    'Outline=5',
    'Shadow=0',
    'Alignment=2',
    `MarginV=${s.marginBottom}`,
  ].join(',');
}

/** A path inside an ffmpeg filter option: slashes forward, the colon of a drive letter escaped, the whole in single quotes. */
export function filterPath(path) {
  return `'${path.replace(/\\/gu, '/').replace(/:/gu, '\\:').replace(/'/gu, "'\\''")}'`;
}

/** The loudness (LUFS) of a file from the summary that ffmpeg ebur128 prints; null when there is none. */
export function parseEbur128(log) {
  const summary = log.slice(log.lastIndexOf('Summary:'));
  const match = /I:\s+(-?[\d.]+) LUFS/u.exec(summary);
  return match === null ? null : Number(match[1]);
}

/** The gain (dB) that brings music of a measured loudness to the loudness it has before it is ducked under the voice; limited to a sane range. */
export function musicGainFor(measuredLufs, targetLufs, fallbackDb) {
  if (measuredLufs === null || measuredLufs === undefined || !Number.isFinite(measuredLufs)) return fallbackDb;
  return Math.max(-40, Math.min(6, Number((targetLufs - measuredLufs).toFixed(1))));
}

/** The loudness filter; with the numbers of a first pass it is the exact (linear) second pass. */
export function loudnormFilter(spec, measured) {
  const target = `loudnorm=I=${spec.audio.integratedLufs}:TP=${spec.audio.truePeakMaxDb - 0.5}:LRA=11`;
  if (measured === undefined) return `${target}:print_format=json`;
  return `${target}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`;
}

/** The numbers a first loudnorm pass prints at the end of its log. */
export function parseLoudnorm(log) {
  const end = log.lastIndexOf('}');
  const start = log.lastIndexOf('{', end);
  if (start < 0 || end < 0) throw new Error('the loudness pass printed no measurement');
  const data = JSON.parse(log.slice(start, end + 1));
  for (const key of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']) if (data[key] === undefined) throw new Error(`the loudness measurement has no ${key}`);
  return data;
}

/**
 * The audio graph: every scene voice placed at its time, the music looped under it, ducked by the voice (sidechain compressor), faded at both ends,
 * and the sum normalised to the loudness target. Inputs: 0 video, 1..N narration files, N+1 the music (when there is one).
 * `video` false makes an audio-only graph (the first pass that measures the loudness).
 */
export function buildFilterGraph({ narration, totalMs, music, spec = loadSpec(), measured, subtitlesFile, fontsDir, barInput, barY = 890, musicGainDb }) {
  const sr = spec.audio.sampleRate;
  const lines = [];
  narration.forEach((item, index) => lines.push(`[${index + 1}:a]aformat=sample_rates=${sr}:channel_layouts=stereo,adelay=${Math.round(item.startMs)}:all=1[v${index}]`));
  const inputs = narration.map((_, index) => `[v${index}]`).join('');
  lines.push(narration.length === 1 ? '[v0]anull[voice]' : `${inputs}amix=inputs=${narration.length}:normalize=0:duration=longest[voice]`);
  const seconds = totalMs / 1000;
  const last = narration.length + 1;
  if (music) {
    const a = spec.audio;
    lines.push(`[${last}:a]aformat=sample_rates=${sr}:channel_layouts=stereo,atrim=duration=${seconds.toFixed(3)},asetpts=PTS-STARTPTS,volume=${musicGainDb ?? a.musicGainDb}dB,afade=t=in:st=0:d=${a.musicFadeInSec},afade=t=out:st=${Math.max(0, seconds - a.musicFadeOutSec).toFixed(3)}:d=${a.musicFadeOutSec}[music]`);
    lines.push('[voice]asplit=2[vmix][vside]');
    lines.push(`[music][vside]sidechaincompress=threshold=${a.duck.threshold}:ratio=${a.duck.ratio}:attack=${a.duck.attackMs}:release=${a.duck.releaseMs}:makeup=1[ducked]`);
    lines.push('[vmix][ducked]amix=inputs=2:normalize=0:duration=longest[premix]');
  } else {
    lines.push('[voice]anull[premix]');
  }
  lines.push(`[premix]${loudnormFilter(spec, measured)},aresample=${sr}[aout]`);
  if (barInput !== undefined) {
    // The subtitle bar: pictures of dark rounded bars (compose/render.mjs) laid over the film at the time of each cue; the soft subtitle track stays.
    lines.push(`[0:v]fps=${spec.video.fps},scale=${spec.video.width}:${spec.video.height}:force_original_aspect_ratio=decrease,pad=${spec.video.width}:${spec.video.height}:(ow-iw)/2:(oh-ih)/2[base]`);
    lines.push(`[${barInput}:v]fps=${spec.video.fps},format=rgba[bar]`);
    lines.push(`[base][bar]overlay=0:${barY}:format=auto:eof_action=pass[vout]`);
  } else if (subtitlesFile !== undefined) {
    const v = spec.video;
    const parts = [`fps=${v.fps}`, `scale=${v.width}:${v.height}:force_original_aspect_ratio=decrease`, `pad=${v.width}:${v.height}:(ow-iw)/2:(oh-ih)/2`, `subtitles=filename=${filterPath(subtitlesFile)}:fontsdir=${filterPath(fontsDir)}:force_style='${subtitleStyle(spec)}'`];
    lines.push(`[0:v]${parts.join(',')}[vout]`);
  }
  return lines.join(';\n');
}

/** The ffmpeg arguments of the final mix (video with burned-in subtitles, mixed audio, a soft subtitle track too). `graphFile` holds the filter graph. */
export function buildMixArgs({ video, narration, music, bar, subtitlesSrt, graphFile, out, totalMs, spec = loadSpec(), passOne = false }) {
  const args = ['-hide_banner', '-loglevel', passOne ? 'info' : 'error', '-y', '-i', video];
  for (const item of narration) args.push('-i', item.file);
  if (music) args.push('-stream_loop', '-1', '-i', music);
  if (bar && !passOne) args.push('-f', 'concat', '-safe', '0', '-i', bar);
  if (!passOne) args.push('-i', subtitlesSrt);
  args.push('-/filter_complex', graphFile, '-t', (totalMs / 1000).toFixed(3));
  if (passOne) return [...args, '-map', '[aout]', '-vn', '-f', 'null', '-'];
  const subtitleInput = 1 + narration.length + (music ? 1 : 0) + (bar ? 1 : 0);
  const a = spec.audio;
  const v = spec.video;
  return [
    ...args,
    '-map', '[vout]', '-map', '[aout]', '-map', `${subtitleInput}:0`,
    '-c:v', 'libx264', '-preset', process.env.CLIPS_X264_PRESET ?? v.preset, '-crf', String(v.crf), '-pix_fmt', v.pixelFormat, '-r', String(v.fps),
    '-c:a', 'aac', '-b:a', `${a.bitrateKbps}k`, '-ar', String(a.sampleRate),
    '-c:s', 'mov_text', '-metadata:s:s:0', 'language=vie', '-metadata:s:s:0', 'title=Tieng Viet',
    '-movflags', '+faststart', out,
  ];
}

/** The proposed track of a clip (production/music.json) when its file is on this machine: { id, file } or undefined. */
export function defaultMusic(clip, music = readJson('production/music.json'), exists = existsSync) {
  const wanted = music.clips?.[clip]?.track;
  const tracks = music.tracks ?? [];
  const track = tracks.find((candidate) => candidate.id === wanted && candidate.file !== undefined) ?? tracks.find((candidate) => candidate.file !== undefined);
  return track !== undefined && exists(track.file) ? { id: track.id, file: track.file, status: track.approval?.status } : undefined;
}

const run = (args) => spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 1 << 28 });

/** The whole mix: measures the loudness, mixes with the exact normalisation, writes the sidecar subtitles and a small record of what was done. */
export function mix({ video, timeline, audio, music, bar, out, spec = loadSpec(), runner = run, log = console.log }) {
  const totalMs = timeline.totalMs;
  const narration = timeline.scenes.map((scene) => {
    const file = audio[scene.id]?.wav;
    if (file === undefined || !existsSync(file)) throw new Error(`no audio file for scene ${scene.id}`);
    return { file, startMs: scene.voiceStartMs };
  });
  if (music !== undefined && !existsSync(music)) throw new Error(`music file not found: ${music}`);
  mkdirSync(dirname(out), { recursive: true });
  const stem = out.replace(/\.[^.]+$/u, '');
  const cues = cuesOf(timeline);
  writeFileSync(`${stem}.srt`, formatSrt(cues));
  writeFileSync(`${stem}.vtt`, formatVtt(cues));
  const fontsDir = isAbsolute(spec.subtitles.fontDir) ? spec.subtitles.fontDir : join(REPO_ROOT, spec.subtitles.fontDir);
  const barInput = bar === undefined ? undefined : 1 + narration.length + (music ? 1 : 0);
  // The music is brought to a fixed loudness of its own before the voice ducks it, so that any track sits at the same place under the voice.
  const measuredMusic = music === undefined ? null : parseEbur128(runner(['-hide_banner', '-nostats', '-i', music, '-af', 'ebur128=peak=none', '-f', 'null', '-']).stderr ?? '');
  const musicGainDb = music === undefined ? undefined : musicGainFor(measuredMusic, spec.audio.musicTargetLufs, spec.audio.musicGainDb);
  if (music !== undefined) log(`music: ${measuredMusic ?? 'unmeasured'} LUFS, gain ${musicGainDb} dB (target ${spec.audio.musicTargetLufs} LUFS before ducking)`);
  const graphInput = { narration, totalMs, music, spec, subtitlesFile: `${stem}.srt`, fontsDir, barInput, musicGainDb };
  const graphOne = `${stem}.pass1.graph`;
  writeFileSync(graphOne, buildFilterGraph({ ...graphInput, subtitlesFile: undefined, barInput: undefined }));
  log('loudness pass');
  const first = runner(buildMixArgs({ video, narration, music, graphFile: graphOne, out, totalMs, spec, passOne: true }));
  if (first.status !== 0) throw new Error(`ffmpeg failed in the loudness pass: ${(first.stderr ?? '').split('\n').slice(-6).join(' ')}`);
  const measured = parseLoudnorm(first.stderr ?? '');
  const graphTwo = `${stem}.graph`;
  writeFileSync(graphTwo, buildFilterGraph({ ...graphInput, measured }));
  log('mix pass');
  const second = runner(buildMixArgs({ video, narration, music, bar, subtitlesSrt: `${stem}.srt`, graphFile: graphTwo, out, totalMs, spec }));
  if (second.status !== 0) throw new Error(`ffmpeg failed in the mix pass: ${(second.stderr ?? '').split('\n').slice(-6).join(' ')}`);
  writeFileSync(`${stem}.clip.json`, `${JSON.stringify({ file: basename(out), burnedInSubtitles: true, softSubtitleTrack: true, sidecars: [basename(`${stem}.srt`), basename(`${stem}.vtt`)], music: music === undefined ? null : basename(music), musicLufs: measuredMusic, musicGainDb: musicGainDb ?? null, measuredBefore: measured, durationSec: totalMs / 1000 }, null, 2)}\n`);
  return { out, measured };
}

function main(argv) {
  const video = argument(argv, 'video');
  const timelinePath = argument(argv, 'timeline');
  const audioPath = argument(argv, 'audio');
  const out = argument(argv, 'out');
  if (flag(argv, 'version')) {
    const done = run(['-version']);
    console.log((done.stdout ?? '').split('\n')[0] ?? done.stderr);
    return done.status ?? 1;
  }
  if (video === undefined || timelinePath === undefined || audioPath === undefined || out === undefined) {
    console.error('usage: node scripts/clips/mix.mjs --video <screen-video.mp4> --timeline <clip.cut.timeline.json> --audio <clip.audio.json> [--music <any audio file> | --no-music] [--clip <id>] [--bar <subtitle bar concat list>] --out <final.mp4>');
    return 2;
  }
  try {
    const bar = argument(argv, 'bar');
    const clip = argument(argv, 'clip') ?? readJson(timelinePath).clip;
    let music = argument(argv, 'music');
    if (music === undefined && !flag(argv, 'no-music')) {
      const found = defaultMusic(clip);
      if (found !== undefined) {
        console.log(`music: default track ${found.id} (${found.status}) ${found.file}`);
        music = found.file;
      }
    }
    const result = mix({ video, timeline: readJson(timelinePath), audio: JSON.parse(readFileSync(audioPath, 'utf8')).scenes, music, bar: bar !== undefined && existsSync(bar) ? bar : undefined, out });
    console.log(`written ${result.out}`);
    return 0;
  } catch (error) {
    console.error(`mix: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
