// The pure side of the animatic renderer: frame scheduling, the ffmpeg arguments, the static files of the page, the data files.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const MIN_FREE_GB = 2.5;

const HERE = dirname(fileURLToPath(import.meta.url));
export const ANIMATIC_DIR = HERE;
export const DATA_DIR = join(HERE, 'data');
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const TOKENS_CSS = join(REPO_ROOT, 'packages', 'design-tokens', 'dist-css', 'tokens.css');
export const APP_CSS = join(REPO_ROOT, 'apps', 'web', 'src', 'styles', 'app.css');
export const FONT_DIR = join(REPO_ROOT, 'apps', 'web', 'public', 'fonts');

/** How many frames a scene of `durationMs` has: every frame lasts 1000/fps ms and the last one ends at the duration. */
export function frameCount(durationMs, fps = FPS) {
  if (!(durationMs > 0) || !(fps > 0)) throw new Error('the duration and the frame rate must be positive');
  return Math.round((durationMs * fps) / 1000);
}

/** The time of a frame in milliseconds, exact for any frame index (no accumulated rounding). */
export const frameTimeMs = (index, fps = FPS) => (index * 1000) / fps;

/** Every frame to capture: `{ index, tMs }`. `maxFrames` limits a smoke render. */
export function frameSchedule(durationMs, fps = FPS, maxFrames = Infinity) {
  const total = Math.min(frameCount(durationMs, fps), maxFrames);
  return Array.from({ length: total }, (_, index) => ({ index, tMs: frameTimeMs(index, fps) }));
}

/** The ffmpeg arguments that turn a pipe of PNG frames into an H.264 file of the given frame rate. */
export function encodeArgs({ fps = FPS, out, crf = 16, preset = 'medium' }) {
  if (typeof out !== 'string' || out === '') throw new Error('an output file is needed');
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-an',
    '-vf', `scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf),
    '-r', String(fps), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-movflags', '+faststart',
    out,
  ];
}

/** True when the free memory is enough to start a browser (the lane brief asks for 2.5 GB). */
export const enoughMemory = (freeBytes, minGb = MIN_FREE_GB) => freeBytes >= minGb * 1024 ** 3;

/** The @font-face rules of the web app (the same files and unicode ranges), so that the clip is set in the font of the product. */
export function fontFacesFrom(appCss) {
  const rules = appCss.match(/@font-face\s*\{[^}]*\}/gu) ?? [];
  return rules.filter((rule) => rule.includes('Be Vietnam Pro')).join('\n');
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };
export const contentTypeOf = (file) => TYPES[extname(file)] ?? 'application/octet-stream';

/**
 * The file a URL path names, or null: `roots` maps a URL prefix to a directory, and a path that climbs out of its directory is refused.
 * (The page is served from a local server because module scripts and fonts cannot be loaded from file: URLs.)
 */
export function resolveStatic(urlPath, roots) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  for (const [prefix, dir] of Object.entries(roots)) {
    if (!clean.startsWith(prefix)) continue;
    const target = normalize(join(dir, clean.slice(prefix.length)));
    const base = normalize(dir.endsWith(sep) ? dir : dir + sep);
    if (target.startsWith(base)) return target;
    return null;
  }
  return null;
}

/** The page the renderer opens: tokens, fonts and the stage, then the runtime that draws frames. */
export function pageHtml({ tokensCss, fontCss, stageCss }) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>animatic</title><style>${tokensCss}\n${fontCss}\n${stageCss}</style></head><body><div id="stage"></div><script type="module" src="/static/runtime.mjs"></script></body></html>`;
}

/** The files of a scene by name (`data/<id>.json`); a path to a JSON file works too. */
export function sceneFile(idOrPath, dataDir = DATA_DIR) {
  if (idOrPath.endsWith('.json') || isAbsolute(idOrPath) || idOrPath.includes('/') || idOrPath.includes('\\')) return resolve(idOrPath);
  return join(dataDir, `${idOrPath}.json`);
}

export function loadScene(idOrPath, { dataDir = DATA_DIR, fadeMs, hideCaptions } = {}) {
  const file = sceneFile(idOrPath, dataDir);
  if (!existsSync(file)) throw new Error(`no scene file ${file}`);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  return { ...data, ...(fadeMs === undefined ? {} : { fadeMs }), ...(hideCaptions === true ? { hideCaptions: true } : {}) };
}

export const listScenes = (dataDir = DATA_DIR) => readdirSync(dataDir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort();

/** The words of a flag list (`--out file --fps 30 --no-fade`) as an object; a flag without a value is `true`. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    if (!word.startsWith('--')) {
      positional.push(word);
      continue;
    }
    const name = word.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) flags[name] = true;
    else {
      flags[name] = next;
      index += 1;
    }
  }
  return { positional, flags };
}

/** What `ffmpeg -i file` prints about the first video stream (ffprobe is not installed on this machine, ffmpeg tells the same). */
export function parseVideoInfo(output) {
  const stream = /Stream #\d+:\d+[^\n]*?: Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})[^\n]*?, ([\d.]+) fps/u.exec(output);
  if (stream === null) throw new Error('no video stream in the ffmpeg output');
  const length = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/u.exec(output);
  const ms = length === null ? null : ((Number(length[1]) * 60 + Number(length[2])) * 60 + Number(length[3])) * 1000 + Math.round(Number(`0.${length[4]}`) * 1000);
  return { codec: stream[1], width: Number(stream[2]), height: Number(stream[3]), fps: Number(stream[4]), durationMs: ms, pixelFormat: /Video: [^\n]*?, (yuv\w+)/u.exec(output)?.[1] ?? null };
}
