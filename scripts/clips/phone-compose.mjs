// The segment of a phone scene: the portrait footage of the emulator (scripts/clips/record/phone-film.mjs) placed in a phone frame on the left of the
// 16:9 canvas, a headline and the words of the scene on the right, on a branded gradient. It makes the same file as the other segments of make.mjs
// (1920x1080, 30 fps, exactly `seconds` long, captions burned in), so it can replace the card of a phone scene: `make.mjs --only <scene> --phone-footage <dir>`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG } from '../hdsd/tts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const FONTS = join(REPO_ROOT, 'apps', 'mobile', 'assets', 'fonts');
const W = 1920;
const H = 1080;
/** The phone: the screen of 720x1560 is shown 424 wide and 920 high, inside a body 14 px thick. */
export const PHONE = { screenWidth: 424, screenHeight: 920, bezel: 14, x: 230, y: 70 };
/** Faster than real time at most this much when the walk is longer than the voice (a slower walk is held on its last picture). */
export const MAX_SPEEDUP = 1.5;

const ffPath = (path) => `'${path.replace(/\\/gu, '/').replace(/:/gu, '\\:').replace(/'/gu, "'\\''")}'`;

/** The index of the footage written by phone-film.mjs, or undefined when there is none. */
export function loadFootage(dir) {
  const file = join(dir, 'index.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}

/** The film of a scene for an edition (the public one stands in for an edition that was not filmed). */
export function footageOf(index, sceneId, edition) {
  const own = index?.scenes?.[`${sceneId}.${edition}`];
  if (own !== undefined && existsSync(own.file)) return { ...own, standIn: false };
  const shared = index?.scenes?.[`${sceneId}.public`];
  return shared !== undefined && existsSync(shared.file) ? { ...shared, standIn: edition !== 'public' } : undefined;
}

/** How the walk is fitted to the length of the scene: sped up a little when it is longer, trimmed after that. */
export function fit(footageMs, seconds) {
  const speed = Math.min(Math.max(footageMs / 1000 / seconds, 1), MAX_SPEEDUP);
  return { speed, usedSec: Math.min(footageMs / 1000, seconds * speed) };
}

const roundAlpha = (radius) => `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(max(abs(X-W/2)-(W/2-${radius}),0),max(abs(Y-H/2)-(H/2-${radius}),0)),${radius}),255,0)'`;

/** Writes the text of the right side as files (UTF-8, no escaping problems) and returns the drawtext filters. */
function textFilters({ headline, bullets, dir, id }) {
  const bold = ffPath(join(FONTS, 'BeVietnamPro-Bold.ttf'));
  const regular = ffPath(join(FONTS, 'BeVietnamPro-Regular.ttf'));
  const filters = [];
  const wrap = (text, width) => {
    const lines = [];
    let line = '';
    for (const word of text.split(/\s+/u)) {
      if (`${line} ${word}`.trim().length > width && line !== '') {
        lines.push(line);
        line = word;
      } else line = `${line} ${word}`.trim();
    }
    return [...lines, line].join('\n');
  };
  mkdirSync(dir, { recursive: true });
  const headFile = join(dir, `${id}.headline.txt`);
  writeFileSync(headFile, wrap(headline, 22));
  filters.push(`drawbox=x=840:y=300:w=10:h=120:color=0x1fb5a8@1:t=fill`);
  filters.push(`drawtext=fontfile=${bold}:textfile=${ffPath(headFile)}:fontsize=64:fontcolor=white:x=880:y=290:line_spacing=12`);
  bullets.slice(0, 3).forEach((text, index) => {
    const file = join(dir, `${id}.bullet${index}.txt`);
    writeFileSync(file, wrap(text, 38));
    filters.push(`drawtext=fontfile=${regular}:textfile=${ffPath(file)}:fontsize=32:fontcolor=0xd6e6ea:x=880:y=${520 + index * 120}:line_spacing=8`);
    filters.push(`drawbox=x=850:y=${530 + index * 120}:w=12:h=12:color=0x1fb5a8@1:t=fill`);
  });
  return filters;
}

/**
 * One segment of exactly `seconds`: background, phone with the walk, headline and words. `ass` is the captions file (or null); `fontsDir` the font folder of the subtitles.
 * Returns what was done (speed, whether the footage came from the other edition).
 */
export function composePhoneSegment({ footage, seconds, headline, bullets = [], ass = null, out, fontsDir = FONTS, workDir }) {
  const { speed } = fit(footage.durationMs, seconds);
  const dir = workDir ?? dirname(out);
  const p = PHONE;
  const bodyW = p.screenWidth + 2 * p.bezel;
  const bodyH = p.screenHeight + 2 * p.bezel;
  const text = textFilters({ headline, bullets, dir, id: footage.scene });
  const graph = [
    `gradients=s=${W}x${H}:c0=0x0b2230:c1=0x0e5f66:x0=0:y0=0:x1=${W}:y1=${H}:speed=0:rate=30[bg]`,
    `[0:v]setpts=PTS/${speed.toFixed(4)},fps=30,scale=${p.screenWidth}:${p.screenHeight}:flags=lanczos,tpad=stop_mode=clone:stop_duration=${Math.ceil(seconds)},format=rgba,${roundAlpha(34)}[screen]`,
    `color=c=0x05090c:s=${bodyW}x${bodyH}:r=30,format=rgba,${roundAlpha(48)}[body]`,
    `[bg][body]overlay=${p.x - p.bezel}:${p.y - p.bezel}:shortest=1[a]`,
    `[a][screen]overlay=${p.x}:${p.y}:shortest=1[b]`,
    `[b]${[...text, ...(ass === null ? [] : [`subtitles=filename=${ffPath(ass)}:fontsdir=${ffPath(fontsDir)}`]), 'format=yuv420p'].join(',')}[v]`,
  ].join(';');
  const done = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', footage.file, '-filter_complex', graph, '-map', '[v]', '-t', seconds.toFixed(3), '-r', '30', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (done.status !== 0) throw new Error(`phone segment failed: ${(done.stderr ?? '').split('\n').slice(-5).join(' ')}`);
  return { speed, standIn: footage.standIn === true };
}
