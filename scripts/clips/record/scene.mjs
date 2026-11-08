// A scene of a clip as the recorder runs it: named steps, each a list of actions (data) or a function (code).
//   { id, platform: 'web' | 'phone', edition: 'public' | 'enterprise', persona, steps: [{ id, heading, screens, minMs, actions: [...] }] }
// A phone scene names a chapter of the phone guide instead of actions: { platform: 'phone', phoneChapter: '<id in scripts/hdsd/mobile-chapters.json>' }.

export const PLATFORMS = ['web', 'phone'];
export const EDITIONS = ['public', 'enterprise'];

/** The actions a step may hold, with the fields each one needs. */
export const ACTIONS = {
  goto: { required: ['path'] },
  click: { required: ['target'] },
  hover: { required: ['target'] },
  type: { required: ['target', 'text'] },
  press: { required: ['key'] },
  select: { required: ['target', 'option'] },
  scroll: { required: ['ms'] },
  spot: { required: ['target', 'ms'] },
  expect: { required: ['target'] },
  wait: { required: ['ms'] },
};

const TARGET_KINDS = ['role', 'label', 'text', 'testid', 'placeholder', 'css'];

/**
 * A place on the screen written as one word: `role:button:Save`, `label:Name`, `text:Total`, `testid:save`, `placeholder:Search`, `css:main table`.
 * It is turned into the fields a Playwright locator is made from.
 */
export function parseTarget(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') throw new Error('a target is a non-empty text such as role:button:Save');
  const colon = spec.indexOf(':');
  const kind = colon < 0 ? '' : spec.slice(0, colon);
  if (!TARGET_KINDS.includes(kind)) throw new Error(`the target "${spec}" must start with one of ${TARGET_KINDS.join(', ')} and a colon`);
  const rest = spec.slice(colon + 1);
  if (kind === 'role') {
    const split = rest.indexOf(':');
    const role = split < 0 ? rest : rest.slice(0, split);
    if (role === '') throw new Error(`the target "${spec}" has no role`);
    return split < 0 ? { kind, role } : { kind, role, name: rest.slice(split + 1) };
  }
  if (rest === '') throw new Error(`the target "${spec}" has nothing after the colon`);
  return { kind, value: rest };
}

/** One action, checked and normalised: `{ do, ...fields }`; a target is parsed. Throws with the reason. */
export function parseAction(raw) {
  if (typeof raw !== 'object' || raw === null || typeof raw.do !== 'string') throw new Error('an action is an object with a "do" field');
  const rule = ACTIONS[raw.do];
  if (rule === undefined) throw new Error(`unknown action "${raw.do}" (known: ${Object.keys(ACTIONS).join(', ')})`);
  const missing = rule.required.filter((field) => raw[field] === undefined);
  if (missing.length > 0) throw new Error(`the action "${raw.do}" needs ${missing.join(', ')}`);
  for (const field of ['ms']) if (raw[field] !== undefined && !(Number.isFinite(raw[field]) && raw[field] >= 0)) throw new Error(`the action "${raw.do}": ${field} must be a number of milliseconds`);
  if (raw.do === 'goto' && !(typeof raw.path === 'string' && raw.path.startsWith('/'))) throw new Error('the action "goto" needs a path that starts with /');
  const action = { ...raw };
  if (raw.target !== undefined) action.target = parseTarget(raw.target);
  return action;
}

/** What is wrong with a scene (an empty list when it can be recorded). */
export function sceneProblems(raw) {
  const found = [];
  if (typeof raw !== 'object' || raw === null) return ['the scene is not an object'];
  if (typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(raw.id)) found.push('the scene needs an id of lower-case letters, digits and dashes');
  if (!PLATFORMS.includes(raw.platform)) found.push(`the platform must be one of ${PLATFORMS.join(', ')}`);
  if (raw.edition !== undefined && !EDITIONS.includes(raw.edition)) found.push(`the edition must be one of ${EDITIONS.join(', ')}`);
  if (raw.platform === 'phone') {
    if (typeof raw.phoneChapter !== 'string' || raw.phoneChapter === '') found.push('a phone scene names its chapter of the phone guide in "phoneChapter"');
    return found;
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    found.push('the scene has no steps');
    return found;
  }
  const seen = new Set();
  for (const step of raw.steps) {
    const name = typeof step?.id === 'string' ? step.id : '(no id)';
    if (typeof step?.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(step.id)) found.push(`step ${name}: the id is missing or has other characters than lower-case letters, digits and dashes`);
    else if (seen.has(step.id)) found.push(`step ${step.id} is twice`);
    else seen.add(step.id);
    const hasActions = Array.isArray(step?.actions) && step.actions.length > 0;
    const hasCode = typeof step?.run === 'function';
    if (hasActions === hasCode) found.push(`step ${name}: give either a list of actions or a run function`);
    if (hasActions) {
      for (const [index, action] of step.actions.entries()) {
        try {
          parseAction(action);
        } catch (error) {
          found.push(`step ${name}, action ${index + 1}: ${error.message}`);
        }
      }
    }
    if (step?.minMs !== undefined && !(step.minMs >= 0)) found.push(`step ${name}: minMs must be a number of milliseconds`);
  }
  return found;
}

/** A scene checked and normalised (every action parsed). Throws with every problem at once. */
export function parseScene(raw) {
  const found = sceneProblems(raw);
  if (found.length > 0) throw new Error(`scene ${raw?.id ?? '(no id)'}: ${found.join('; ')}`);
  if (raw.platform === 'phone') return { ...raw, steps: [] };
  return {
    ...raw,
    steps: raw.steps.map((step) => ({ screens: [], heading: step.id, ...step, ...(step.actions === undefined ? {} : { actions: step.actions.map(parseAction) }) })),
  };
}

/** The steps to run: all of them, or only the named ones (a retake of one step), in the order of the scene. */
export function selectSteps(scene, only) {
  if (only === undefined || only.length === 0) return scene.steps;
  const known = new Set(scene.steps.map((step) => step.id));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`the scene ${scene.id} has no step ${unknown.join(', ')}`);
  return scene.steps.filter((step) => only.includes(step.id));
}

/** The address of a path of the web app for a person of the dev session (the stack of the clips signs in with `devUser`). */
export function withPersona(path, persona) {
  if (persona === undefined || persona === '') return path;
  return `${path}${path.includes('?') ? '&' : '?'}devUser=${encodeURIComponent(persona)}`;
}
