// Draws the composition layers with Chromium (Playwright) and ffmpeg: the background loop, the frame layer of a scene, cards, callout chips, the subtitle bar strip.
// Pages are written as files and opened from disk because a page set from a string cannot load the font files.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../common.mjs';
import { FFMPEG } from '../mix.mjs';
import { LOOP_SEC, backgroundHtml, barHtml, cardHtml, chipHtml, fontCss, overlayHtml } from './design.mjs';

export const FONT_DIR = resolve(REPO_ROOT, 'apps', 'mobile', 'assets', 'fonts');
const toSlash = (path) => path.split('\\').join('/');
export const BRAND_DIR = process.env.CLIPS_BRAND_DIR ?? 'D:/PIS-clips-out/brand';

/** brand.json of the logo lane when it exists (read at render time), else undefined. */
export function readBrand(dir = BRAND_DIR) {
  const file = join(dir, 'brand.json');
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return { raw, dir };
  } catch {
    return undefined;
  }
}

/** A path from brand.json made absolute against the folder of brand.json. */
export const brandFile = (brand, name) => (name === null || name === undefined ? null : resolve(brand?.dir ?? BRAND_DIR, name));

export class Painter {
  constructor(workDir) {
    this.dir = resolve(workDir);
    mkdirSync(this.dir, { recursive: true });
    this.fonts = fontCss(FONT_DIR);
    this.count = 0;
  }

  async open() {
    if (freemem() < 1.5 * 1024 ** 3) throw new Error('less than 1.5 GB of memory is free: wait before the compositor starts');
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({ headless: true });
    this.page = await this.browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    return this;
  }

  async close() {
    await this.browser?.close();
  }

  async load(html) {
    this.count += 1;
    const file = join(this.dir, `page-${this.count % 4}.html`);
    writeFileSync(file, html);
    await this.page.goto(pathToFileURL(file).href);
    await this.page.evaluate(() => globalThis.document.fonts.ready);
  }

  /** A transparent PNG of a page (the whole canvas, or a strip). */
  async still(html, out, clip) {
    await this.load(html);
    await this.page.screenshot({ path: out, omitBackground: true, ...(clip === undefined ? {} : { clip }) });
    return out;
  }

  overlay(options, out) {
    return this.still(overlayHtml({ ...options, fonts: this.fonts }), out);
  }

  card(options, out) {
    return this.still(cardHtml({ ...options, fonts: this.fonts }), out);
  }

  chip(options, out) {
    return this.still(chipHtml({ ...options, fonts: this.fonts }), out);
  }

  /** The background loop (LOOP_SEC seconds, seamless): frames go to ffmpeg through a pipe. */
  async background(out, fps = 30) {
    if (existsSync(out)) return out;
    await this.load(backgroundHtml(this.fonts));
    const encoder = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'ignore', 'pipe'] });
    let errors = '';
    encoder.stderr.on('data', (chunk) => {
      errors += String(chunk);
    });
    encoder.stdin.on('error', () => undefined);
    const finished = new Promise((done) => encoder.on('close', done));
    for (let index = 0; index < LOOP_SEC * fps; index += 1) {
      await this.page.evaluate((t) => globalThis.__setT(t), index / fps);
      const png = await this.page.screenshot({ type: 'png' });
      if (!encoder.stdin.write(png)) await new Promise((drain) => encoder.stdin.once('drain', drain));
    }
    encoder.stdin.end();
    if ((await finished) !== 0) throw new Error(`background encoder failed: ${errors.slice(-300)}`);
    return out;
  }

  /** One transparent strip for each cue plus a blank one, and the concat list ffmpeg reads (`file`/`duration` lines). */
  async subtitleBar(cues, totalMs, out, accent) {
    const dir = join(this.dir, 'bar');
    mkdirSync(dir, { recursive: true });
    const strip = { x: 0, y: 0, width: 1920, height: 190 };
    await this.page.setViewportSize({ width: 1920, height: 190 });
    const blank = await this.still(barHtml('', { fonts: this.fonts, accent }).replace(/<div class="bar">.*?<\/div>/u, ''), join(dir, 'blank.png'), strip);
    const lines = [];
    let at = 0;
    const entry = (file, ms) => lines.push(`file '${toSlash(file)}'`,`duration ${(Math.max(1, ms) / 1000).toFixed(3)}`);
    for (const [index, cue] of cues.entries()) {
      if (cue.startMs > at) entry(blank, cue.startMs - at);
      const png = await this.still(barHtml(cue.text, { fonts: this.fonts, accent }), join(dir, `cue-${index}.png`), strip);
      entry(png, cue.endMs - cue.startMs);
      at = cue.endMs;
    }
    if (totalMs > at) entry(blank, totalMs - at);
    lines.push(`file '${toSlash(blank)}'`);
    writeFileSync(out, `${lines.join('\n')}\n`);
    await this.page.setViewportSize({ width: 1920, height: 1080 });
    return out;
  }
}
