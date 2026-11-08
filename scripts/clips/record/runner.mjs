// Runs the steps of a scene one after the other and writes down when each began, when its voice begins and when it ended.
// Nothing here starts a browser: the page, the clock and the picture-taking are handed in, so that the whole of it can be tested.
import { MIN_STEP_MS, makeEntry, scaleMs, stepSchedule, waitUntil } from './timeline.mjs';
import { selectSteps } from './scene.mjs';
import { runAction } from './ui.mjs';

export class StepFailure extends Error {
  constructor(stepId, cause, timeline) {
    super(`the step ${stepId} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'StepFailure';
    this.stepId = stepId;
    this.timeline = timeline;
  }
}

/** How long the voice of a step lasts, from an audio index (`{ steps: { <id>: { durationMs } } }`, the shape the guide writes); 0 when there is none. */
export function budgetOf(audio, stepId) {
  const entry = audio?.steps?.[stepId];
  if (entry === undefined) return 0;
  if (!(entry.durationMs > 0)) throw new Error(`the audio of the step ${stepId} has no duration`);
  return entry.durationMs;
}

/**
 * Runs the scene (a parsed one: scene.mjs parseScene).
 *  ui     what the steps act with (ui.mjs)
 *  clock  { now(): ms since the first frame of the film, wait(ms) }
 *  shot   async (stepId) => path of a picture of the screen, or null
 * Returns the timeline. A step that fails is written down with its error and stops the run with a StepFailure that carries the timeline so far.
 */
export async function runScene(scene, { ui, clock, audio, slowMo = 1, only, shot = async () => null, log = () => undefined }) {
  const timeline = [];
  for (const step of selectSteps(scene, only)) {
    const startMs = clock.now();
    const budgetMs = budgetOf(audio, step.id);
    log(`step ${step.id}: start at ${startMs} ms${budgetMs > 0 ? `, voice ${budgetMs} ms` : ''}`);
    let failure = null;
    try {
      if (typeof step.run === 'function') await step.run(ui, { budgetMs, slowMo });
      else for (const action of step.actions) await runAction(ui, action);
    } catch (error) {
      failure = error;
    }
    const { voiceMs, wantedEndMs } = stepSchedule({ startMs, budgetMs, minMs: scaleMs(step.minMs ?? MIN_STEP_MS, slowMo) });
    if (failure === null) await clock.wait(waitUntil(wantedEndMs, clock.now()));
    const picture = failure === null ? await shot(step.id) : null;
    const endMs = Math.max(clock.now(), startMs + 1);
    timeline.push(makeEntry({ id: step.id, heading: step.heading, screens: step.screens, startMs, endMs, voiceMs: Math.min(voiceMs, endMs), shot: picture, error: failure === null ? null : String(failure.message ?? failure) }));
    if (failure !== null) throw new StepFailure(step.id, failure, timeline);
  }
  return timeline;
}
