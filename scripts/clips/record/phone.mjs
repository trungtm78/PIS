// The phone scenes: the Android emulator is driven by the recorder of the phone guide (scripts/hdsd/mobile-run.mjs, mobile.mjs). It is wrapped here,
// not rewritten: a phone scene names a chapter of scripts/hdsd/mobile-chapters.json, the guide films it, and its film and timeline are
// copied next to the web scenes in the shape the assembly reads. The same data guard applies (the phone reads the same tenant).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timelineDocument } from './timeline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const CHAPTERS_FILE = join(REPO_ROOT, 'scripts', 'hdsd', 'mobile-chapters.json');

/** What is wrong with a phone scene: it must name a chapter that exists in the phone guide. `chapters` is the list read from mobile-chapters.json. */
export function phoneSceneProblems(scene, chapters) {
  if (scene.platform !== 'phone') return [`the scene ${scene.id} is a ${scene.platform} scene`];
  const chapter = chapters.find((candidate) => candidate.id === scene.phoneChapter);
  if (chapter === undefined) return [`the phone guide has no chapter ${scene.phoneChapter}`];
  return Array.isArray(chapter.steps) && chapter.steps.length > 0 ? [] : [`the chapter ${scene.phoneChapter} has no steps`];
}

export const loadChapters = (file = CHAPTERS_FILE) => JSON.parse(readFileSync(file, 'utf8'));

/** Where the phone guide leaves a film (its cache) and where the clip keeps it. */
export function phonePaths({ cache, outDir, sceneId, chapterId }) {
  const from = join(cache, 'rec', chapterId);
  return { from, video: join(from, 'video.mp4'), timeline: join(from, 'timeline.json'), to: resolve(outDir, sceneId) };
}

/** The timeline of the phone guide ({ flow, timeline: [...] }) turned into the one of the clips; the entries keep their times. */
export function convertPhoneTimeline(guideTimeline, { sceneId, only }) {
  const entries = guideTimeline.timeline.filter((entry) => only === undefined || only.length === 0 || only.includes(entry.id));
  return timelineDocument({ sceneId, platform: 'phone', slowMo: 1, entries });
}

/** Films a phone scene on the emulator `serial`. The guard has to be passed by the caller first (cli.mjs does it). */
export async function recordPhoneScene(scene, { serial, cache = process.env.HDSD_CACHE ?? 'D:/tmp/hdsd-cache', outDir, only, log = console.log }) {
  const problems = phoneSceneProblems(scene, loadChapters());
  if (problems.length > 0) throw new Error(problems.join('; '));
  if (typeof serial !== 'string' || serial === '') throw new Error('the adb serial of the emulator is needed (--serial)');
  const { recordMobile } = await import('../../hdsd/mobile-run.mjs');
  const done = await recordMobile(scene.phoneChapter, { serial, cache, log });
  const paths = phonePaths({ cache, outDir, sceneId: scene.id, chapterId: scene.phoneChapter });
  if (!existsSync(paths.video) || !existsSync(paths.timeline)) throw new Error(`the phone guide left no film for ${scene.phoneChapter} in ${paths.from}`);
  mkdirSync(paths.to, { recursive: true });
  copyFileSync(paths.video, join(paths.to, 'video.mp4'));
  const document = convertPhoneTimeline(JSON.parse(readFileSync(paths.timeline, 'utf8')), { sceneId: scene.id, only });
  writeFileSync(join(paths.to, 'timeline.json'), `${JSON.stringify(document, null, 2)}\n`);
  return { scene: scene.id, dir: paths.to, video: join(paths.to, 'video.mp4'), timeline: join(paths.to, 'timeline.json'), steps: document.timeline.length, pieces: done.pieces };
}
