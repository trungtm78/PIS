import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';

/** What the clip says and shows, one step at a time (scripts/hdsd/flows/<id>.json). */
export interface FlowStep {
  id: string;
  screens: string[];
  heading: string;
  text: string;
  note?: string;
}

export interface Flow {
  id: string;
  title: string;
  audience: string;
  outcome: string;
  persona: string;
  steps: FlowStep[];
}

export interface AudioIndex {
  steps: Record<string, { durationMs: number }>;
}

export interface TimelineEntry {
  id: string;
  heading: string;
  screens: string[];
  /** Milliseconds from the first frame of the recording. */
  startMs: number;
  endMs: number;
  /** When the voice of the step begins. */
  voiceMs: number;
  shot: string;
}

const CACHE = process.env.HDSD_CACHE ?? 'D:/tmp/hdsd-cache';
/** The voice starts a moment after the step does, so that the person sees the screen before hearing about it. */
const VOICE_DELAY_MS = 400;
/** A pause after the voice has finished, before the next step. */
const TAIL_MS = 700;

export const VIEWPORT = { width: 1280, height: 720 };

export function loadFlow(id: string): Flow {
  return JSON.parse(readFileSync(join(process.cwd(), '..', '..', 'scripts', 'hdsd', 'flows', `${id}.json`), 'utf8')) as Flow;
}

function loadAudio(id: string): AudioIndex {
  return JSON.parse(readFileSync(join(CACHE, `${id}.audio.json`), 'utf8')) as AudioIndex;
}

// The cursor the person follows: a ring that moves with the mouse and pulses on a click, drawn in the page itself so that it is in the recording.
const CURSOR_SCRIPT = `(() => {
  if (window.__hdsdCursor) return;
  window.__hdsdCursor = true;
  const install = () => {
    const style = document.createElement('style');
    style.textContent = '#hdsd-cursor{position:fixed;z-index:2147483647;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;border:3px solid #b3213e;background:rgba(179,33,62,.18);pointer-events:none;transition:transform .08s linear}#hdsd-cursor.down{transform:scale(.7);background:rgba(179,33,62,.45)}.hdsd-spot{position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #f2a900;border-radius:10px;box-shadow:0 0 0 6px rgba(242,169,0,.25);animation:hdsd-pulse 1.2s ease-in-out infinite}@keyframes hdsd-pulse{50%{box-shadow:0 0 0 12px rgba(242,169,0,.08)}}';
    document.head.appendChild(style);
    const ring = document.createElement('div');
    ring.id = 'hdsd-cursor';
    document.body.appendChild(ring);
    window.addEventListener('mousemove', (event) => { ring.style.left = event.clientX + 'px'; ring.style.top = event.clientY + 'px'; }, true);
    window.addEventListener('mousedown', () => ring.classList.add('down'), true);
    window.addEventListener('mouseup', () => ring.classList.remove('down'), true);
  };
  if (document.body) install(); else window.addEventListener('DOMContentLoaded', install);
})();`;

/** The things a person does in a clip, done the way a person does them: the pointer travels, the keys come one by one. */
export class Ui {
  constructor(readonly page: Page) {}

  async point(target: Locator): Promise<void> {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (box === null) throw new Error('the target has no box to point at');
    await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 22 });
  }

  async click(target: Locator, { pause = 350 }: { pause?: number } = {}): Promise<void> {
    await this.point(target);
    await this.page.waitForTimeout(pause);
    await target.click();
  }

  async type(target: Locator, text: string): Promise<void> {
    await this.click(target, { pause: 200 });
    await target.pressSequentially(text, { delay: 70 });
  }

  /** Draws a frame around a part of the screen for as long as `during` takes. */
  async spot<T>(target: Locator, during: () => Promise<T>): Promise<T> {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (box === null) throw new Error('the target has no box to frame');
    await this.page.evaluate((frame) => {
      const element = document.createElement('div');
      element.className = 'hdsd-spot';
      Object.assign(element.style, { left: `${frame.x - 4}px`, top: `${frame.y - 4}px`, width: `${frame.width + 8}px`, height: `${frame.height + 8}px` });
      document.body.appendChild(element);
    }, box);
    try {
      return await during();
    } finally {
      await this.page.evaluate(() => document.querySelectorAll('.hdsd-spot').forEach((element) => element.remove()));
    }
  }

  wait(ms: number): Promise<void> {
    return this.page.waitForTimeout(ms);
  }

  /** Scrolls the part of the screen that scrolls, slowly from its top to its end over `ms`, so that the person sees all of it while the voice speaks. */
  async scrollThrough(ms: number): Promise<void> {
    const steps = Math.max(1, Math.floor(ms / 250));
    const distance = await this.page.evaluate(() => {
      const candidates = [document.scrollingElement, ...Array.from(document.querySelectorAll('main, [data-screen-id], .workspace-main, .page-content'))].filter((element): element is Element => element !== null);
      const scroller = candidates.reduce((best, element) => (element.scrollHeight - element.clientHeight > best.scrollHeight - best.clientHeight ? element : best), candidates[0] as Element);
      (window as unknown as { __hdsdScroller: Element }).__hdsdScroller = scroller;
      scroller.scrollTop = 0;
      return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    });
    if (distance < 40) {
      await this.page.waitForTimeout(ms);
      return;
    }
    for (let index = 1; index <= steps; index += 1) {
      await this.page.evaluate((top) => ((window as unknown as { __hdsdScroller: Element }).__hdsdScroller.scrollTop = top), Math.round((distance * index) / steps));
      await this.page.waitForTimeout(250);
    }
  }
}

/** What a step is told: how long the voice of the step lasts, so that the action can be paced to it. */
export interface StepContext {
  budgetMs: number;
}

/** One recording: a browser context that films, the steps of the flow in order, and the timeline the clip is cut and captioned from. */
export class Clip {
  readonly timeline: TimelineEntry[] = [];
  private readonly audio: AudioIndex;
  private readonly dir: string;
  private startedAt = 0;
  private page: Page | undefined;
  private context: BrowserContext | undefined;

  /** `recording` false is a replay: the actions run (so that the data they make exists) without film, voice, pauses or pictures. */
  constructor(readonly flow: Flow, private readonly browser: Browser, audio?: AudioIndex, private readonly recording = true) {
    this.audio = audio ?? (recording ? loadAudio(flow.id) : { steps: {} });
    this.dir = join(CACHE, 'rec', flow.id);
    if (recording) mkdirSync(join(this.dir, 'shots'), { recursive: true });
  }

  async open(): Promise<Ui> {
    this.context = await this.browser.newContext({
      viewport: VIEWPORT,
      locale: 'vi-VN',
      ...(this.recording ? { recordVideo: { dir: join(this.dir, 'raw'), size: VIEWPORT } } : {}),
    });
    await this.context.addInitScript(CURSOR_SCRIPT);
    this.startedAt = Date.now();
    this.page = await this.context.newPage();
    return new Ui(this.page);
  }

  get currentPage(): Page {
    if (this.page === undefined) throw new Error('the clip is not open');
    return this.page;
  }

  /** Runs one step: the action, then waiting until the voice has said everything the step says. */
  async step(id: string, act: (ui: Ui, context: StepContext) => Promise<void>): Promise<void> {
    if (!this.recording) {
      await act(new Ui(this.currentPage), { budgetMs: 0 });
      return;
    }
    const step = this.flow.steps.find((candidate) => candidate.id === id);
    const audio = this.audio.steps[id];
    if (step === undefined || audio === undefined) throw new Error(`the step ${id} is not in the flow or has no voice: run scripts/hdsd/tts.mjs first`);
    const startMs = Date.now() - this.startedAt;
    await act(new Ui(this.currentPage), { budgetMs: audio.durationMs + VOICE_DELAY_MS });
    const voiceMs = startMs + VOICE_DELAY_MS;
    const wanted = voiceMs + audio.durationMs + TAIL_MS;
    const now = Date.now() - this.startedAt;
    if (wanted > now) await this.currentPage.waitForTimeout(wanted - now);
    const shot = join(this.dir, 'shots', `${id}.png`);
    await this.currentPage.screenshot({ path: shot });
    this.timeline.push({ id, heading: step.heading, screens: step.screens, startMs, endMs: Date.now() - this.startedAt, voiceMs, shot });
  }

  /** Closes the recording and keeps the video and the timeline where the next stage finds them. */
  async finish(): Promise<void> {
    if (!this.recording) {
      await this.context?.close();
      return;
    }
    const video = this.currentPage.video();
    await this.context?.close();
    if (video === null) throw new Error('the page was not recorded');
    await video.saveAs(join(this.dir, 'video.webm'));
    writeFileSync(join(this.dir, 'timeline.json'), `${JSON.stringify({ flow: this.flow.id, timeline: this.timeline }, null, 2)}\n`);
  }
}
