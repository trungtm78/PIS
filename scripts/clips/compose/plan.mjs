// Puts a scene together with ffmpeg: the animated background, the footage in its frame (slow zoom, fade in and out), the transparent frame layer,
// the callout chips that appear while the figure is narrated. Pure: it returns the ffmpeg arguments, plan tests read them; render.mjs and make.mjs run them.
import { frames } from './design.mjs';

export const FPS = 30;
export const FADE_SEC = 0.4;
/** How much the footage grows over the scene (a few per cent: enough to feel alive, not enough to cut off the sides). */
export const ZOOM = 0.035;

const num = (value) => Number(value).toFixed(3);
const even = (value) => Math.round(value / 2) * 2;

/** The filter chain that puts footage into a hole: cover the hole, optional slow zoom, fade in and out. */
function holeChain({ input, hole, seconds, zoom, label }) {
  const width = even(hole.width);
  const height = even(hole.height);
  const chain = [`[${input}:v]fps=${FPS}`, `tpad=stop_mode=clone:stop_duration=${Math.ceil(seconds)}`, `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=bicubic`, `crop=${width}:${height}`];
  if (zoom) chain.push(`scale=w='trunc(${width}*(1+${ZOOM}*t/${num(seconds)})/2)*2':h='trunc(${height}*(1+${ZOOM}*t/${num(seconds)})/2)*2':eval=frame`, `crop=${width}:${height}`);
  chain.push('setsar=1', 'format=yuva420p', `fade=t=in:st=0:d=${FADE_SEC}:alpha=1`, `fade=t=out:st=${num(Math.max(0, seconds - FADE_SEC))}:d=${FADE_SEC}:alpha=1[${label}]`);
  return chain.join(',');
}

/**
 * The arguments of one composed segment.
 *   layout   name of a layout (design.mjs)
 *   bg       { file, offsetSec }   the background loop and where in it this scene starts (so that the rings do not jump between scenes)
 *   web      { file, startSec }    footage of the web scene (optional when the layout has no window)
 *   phone    { file, startSec }    footage of the phone (optional)
 *   overlay  path of the transparent frame layer (png)
 *   chips    [{ png, fromSec, toSec }]
 *   assFilter  the already-quoted `subtitles=...` filter for the stamps (optional)
 */
export function segmentArgs({ layout, bg, web, phone, overlay, chips = [], seconds, assFilter, out, preset = 'veryfast', spec }) {
  const geometry = frames(layout, spec);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '-1', '-ss', num(bg.offsetSec), '-i', bg.file];
  const filters = [`[0:v]fps=${FPS},scale=1920:1080,setsar=1,format=yuv420p[bg]`];
  let next = 1;
  let steps = 0;
  let last = 'bg';
  const place = (label, hole) => {
    steps += 1;
    const target = `s${steps}`;
    filters.push(`[${last}][${label}]overlay=x=${hole.x}:y=${hole.y}:format=auto[${target}]`);
    last = target;
  };
  if (geometry.web !== undefined && web !== undefined) {
    args.push('-ss', num(web.startSec), '-i', web.file);
    filters.push(holeChain({ input: next, hole: geometry.web.hole, seconds, zoom: true, label: 'web' }));
    next += 1;
    place('web', geometry.web.hole);
  }
  if (geometry.phone !== undefined && phone !== undefined) {
    args.push('-ss', num(phone.startSec ?? 0), '-i', phone.file);
    filters.push(holeChain({ input: next, hole: geometry.phone.hole, seconds, zoom: false, label: 'phone' }));
    next += 1;
    place('phone', geometry.phone.hole);
  }
  args.push('-loop', '1', '-framerate', String(FPS), '-i', overlay);
  filters.push(`[${next}:v]format=rgba,fade=t=in:st=0:d=${FADE_SEC}:alpha=1,fade=t=out:st=${num(Math.max(0, seconds - FADE_SEC))}:d=${FADE_SEC}:alpha=1[frame]`);
  next += 1;
  filters.push(`[${last}][frame]overlay=0:0:format=auto[withframe]`);
  last = 'withframe';
  chips.forEach((chip, index) => {
    args.push('-loop', '1', '-framerate', String(FPS), '-i', chip.png);
    filters.push(`[${next}:v]format=rgba,fade=t=in:st=${num(chip.fromSec)}:d=0.35:alpha=1,fade=t=out:st=${num(Math.max(chip.fromSec, chip.toSec - 0.35))}:d=0.35:alpha=1[chip${index}]`);
    filters.push(`[${last}][chip${index}]overlay=0:0:format=auto[c${index}]`);
    last = `c${index}`;
    next += 1;
  });
  filters.push(assFilter === undefined ? `[${last}]format=yuv420p[vout]` : `[${last}]${assFilter},format=yuv420p[vout]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-t', num(seconds), '-r', String(FPS), '-an', '-c:v', 'libx264', '-preset', preset, '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
  return args;
}

/** A card (title, chapter, outro): background plus the card layer, fading in and out. */
export function cardArgs({ bg, overlay, seconds, assFilter, out, preset = 'veryfast' }) {
  const filters = [
    `[0:v]fps=${FPS},scale=1920:1080,setsar=1,format=yuv420p[bg]`,
    `[1:v]format=rgba,fade=t=in:st=0.2:d=0.7:alpha=1,fade=t=out:st=${num(Math.max(0, seconds - 0.5))}:d=0.4:alpha=1[card]`,
    '[bg][card]overlay=0:0:format=auto[mixed]',
    assFilter === undefined ? '[mixed]format=yuv420p[vout]' : `[mixed]${assFilter},format=yuv420p[vout]`,
  ];
  return ['-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '-1', '-ss', num(bg.offsetSec), '-i', bg.file, '-loop', '1', '-framerate', String(FPS), '-i', overlay,
    '-filter_complex', filters.join(';'), '-map', '[vout]', '-t', num(seconds), '-r', String(FPS), '-an', '-c:v', 'libx264', '-preset', preset, '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];
}

/** Callout chips for a scene from the spots the recorder framed: each chip points at its spot while the matching sentence is narrated. */
export function chipsFor({ spots, labels, hole, seconds }) {
  if (spots.length === 0 || labels.length === 0) return [];
  const chips = [];
  spots.slice(0, 4).forEach((spot, index) => {
    const label = labels[Math.min(index, labels.length - 1)];
    if (label === '' || label === undefined) return;
    const fromSec = Math.max(0.6, spot.atSec);
    const toSec = Math.min(seconds - 0.2, fromSec + Math.max(2.2, spot.holdSec));
    if (toSec - fromSec < 0.8) return;
    chips.push({ label, fromSec, toSec, x: Math.round(hole.x + spot.box.x + Math.min(spot.box.width * 0.5, 160)), y: Math.round(hole.y + spot.box.y + spot.box.height * 0.5) });
  });
  return chips;
}
