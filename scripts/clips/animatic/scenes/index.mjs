import * as alertLadder from './alert-ladder.mjs';
import * as chapter from './chapter.mjs';
import * as governanceChain from './governance-chain.mjs';
import * as platform from './platform.mjs';
import * as progressTree from './progress-tree.mjs';
import * as serviceFlow from './service-flow.mjs';
import * as title from './title.mjs';

/** Every kind of animatic: its name, the check of its data (a list of problems) and its frame function. */
export const SCENES = new Map([title, chapter, platform, serviceFlow, progressTree, alertLadder, governanceChain].map((scene) => [scene.kind, scene]));

export function sceneOf(kind) {
  const scene = SCENES.get(kind);
  if (scene === undefined) throw new Error(`unknown animatic kind "${kind}" (known: ${[...SCENES.keys()].join(', ')})`);
  return scene;
}

/** One frame of one scene at `t` milliseconds. */
export function frameOf(data, t) {
  return sceneOf(data.kind).render(data, t);
}

/** The problems found in the data of a scene (an empty list when it can be rendered). */
export function sceneProblems(data) {
  if (typeof data !== 'object' || data === null || typeof data.kind !== 'string') return ['the scene has no "kind"'];
  if (!SCENES.has(data.kind)) return [`unknown animatic kind "${data.kind}"`];
  const found = SCENES.get(data.kind).problems(data);
  if (typeof data.durationMs === 'number' && !(data.durationMs > 0)) found.push(`${data.kind}: durationMs must be positive`);
  return found;
}
