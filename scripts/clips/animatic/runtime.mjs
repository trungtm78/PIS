// The page side of the renderer: it holds one scene and draws the frame of any time that the renderer asks for.
import { frameOf, sceneProblems } from './scenes/index.mjs';

const root = globalThis.document.getElementById('stage');

globalThis.__animatic = {
  data: null,
  /** Takes the data of a scene; it refuses a scene that has problems (the renderer shows them). */
  load(data) {
    const problems = sceneProblems(data);
    if (problems.length > 0) throw new Error(problems.join('; '));
    this.data = data;
    return data.durationMs;
  },
  /** Draws the frame at `t` milliseconds; calling it twice with the same time draws the same picture. */
  render(t) {
    root.innerHTML = frameOf(this.data, t);
  },
};
globalThis.__animaticReady = true;
