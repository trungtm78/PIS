import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIPS_DIR, clock, flag, positionals, loadNumerals, loadPhonetics, loadSpec, loadVoices, readJson, REPO_ROOT } from './common.mjs';
import { LAYOUT_NAMES } from './compose/design.mjs';
import { FIGURE_KINDS, figureIds } from './figures.mjs';
import { uncoveredTerms } from './phonetics.mjs';
import { displayText, estimateVoiceMs, sceneMsFromVoice, speechText } from './text.mjs';

export const SCENARIO_DIR = join(CLIPS_DIR, 'scenarios');
export const PLATFORMS = ['web', 'phone', 'pwa', 'animatic', 'title'];
export const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u;

/** The verbs of a step list and the fields each one needs. A later recorder implements each verb once (Playwright for web and pwa, the emulator driver for phone). */
export const STEP_VERBS = {
  open: ['screen'],
  as: ['persona'],
  choose: ['ref', 'option'],
  point: ['ref'],
  click: ['ref'],
  type: ['ref', 'textKey'],
  spot: ['ref'],
  scroll: ['through'],
  wait: [],
  expect: ['ref'],
  command: ['operation'],
  upload: ['operation', 'fixture'],
  'phone-open': ['screen'],
  'phone-tap': ['ref'],
  'phone-scroll': ['through'],
  animatic: ['id'],
  still: ['id'],
};

const OPERATION_FIELDS = ['operation'];

/** Reads a scenario file and expands the `include` entries of its scenes. The origin of every scene is kept so that `stamp` can write back where it came from. */
export function loadScenario(clip, dir = SCENARIO_DIR) {
  const file = join(dir, `${clip}.json`);
  if (!existsSync(file)) throw new Error(`no scenario file ${file}`);
  const raw = readJson(file);
  const files = new Map([[file, raw]]);
  const scenes = [];
  const origin = new Map();
  const chapters = [...(raw.chapters ?? [])];
  const figures = { ...(raw.figures ?? {}) };
  const literalNumbers = { ...(raw.literalNumbers ?? {}) };
  const animatics = { ...(raw.animatics ?? {}) };
  const typed = { ...(raw.typed ?? {}) };
  const problems = [];
  const merge = (target, source, label, from) => {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (key in target && JSON.stringify(target[key]) !== JSON.stringify(value)) problems.push(`${label} ${key} is defined twice with different content (second one in ${from})`);
      else target[key] = value;
    }
  };
  for (const entry of raw.scenes ?? []) {
    if (entry.include === undefined) {
      scenes.push(entry);
      origin.set(entry.id, file);
      continue;
    }
    const part = join(dir, entry.include);
    const content = readJson(part);
    files.set(part, content);
    if (content.schema !== 'clip-chapter/1') problems.push(`${entry.include}: schema must be clip-chapter/1`);
    if (!chapters.some((chapter) => chapter.id === content.id)) chapters.push({ id: content.id, title: content.title, summary: content.summary, ...(content.mainOptional === true ? { mainOptional: true } : {}), ...(content.standalone === false ? { standalone: false } : {}) });
    merge(figures, content.figures, 'figure', entry.include);
    merge(literalNumbers, content.literalNumbers, 'literal number', entry.include);
    merge(animatics, content.animatics, 'animatic', entry.include);
    merge(typed, content.typed, 'typed text', entry.include);
    for (const scene of content.scenes ?? []) {
      scenes.push({ ...scene, chapter: scene.chapter ?? content.id });
      origin.set(scene.id, part);
    }
  }
  const firstAt = (chapter) => scenes.findIndex((scene) => scene.chapter === chapter.id);
  chapters.sort((a, b) => firstAt(a) - firstAt(b));
  return { ...raw, chapters, figures, literalNumbers, animatics, typed, scenes, _files: files, _origin: origin, _loadProblems: problems, _dir: dir };
}

export function listClips(dir = SCENARIO_DIR) {
  return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort();
}

/** The scenes of one cut in play order: `main` is the main video, a chapter id is that chapter cut on its own. */
export function selectScenes(scenario, selector) {
  if (selector === 'main') return scenario.scenes.filter((scene) => scene.main === true && (scene.mainFor === undefined || scene.mainFor.includes(scenario.edition)));
  const cut = scenario.scenes.filter((scene) => scene.chapter === selector);
  if (cut.length === 0) throw new Error(`no chapter ${selector} in ${scenario.clip}`);
  return cut;
}

/** The lanes a scene waits for: the ones of its `requires` that `planned.json` does not list as merged. A scene with none is ready to record. */
export function pendingLanes(scene, planned = readJson('planned.json')) {
  return (scene.requires ?? []).filter((lane) => planned.lanes?.[lane]?.status !== 'merged');
}

export const isPending = (scene, planned) => pendingLanes(scene, planned).length > 0;

/** The scenes of one cut that a recording can make today: the ones that wait for a lane that is not merged are left out (all of them with `includePending`). */
export function recordableScenes(scenario, selector, { includePending = false, planned = readJson('planned.json'), log = (line) => console.log(line) } = {}) {
  const scenes = selectScenes(scenario, selector);
  if (includePending) return scenes;
  const skipped = scenes.filter((scene) => isPending(scene, planned));
  if (skipped.length > 0) log(`skipping ${skipped.length} scene(s) that wait for a lane: ${skipped.map((scene) => `${scene.id} (${pendingLanes(scene, planned).join(', ')})`).join('; ')}`);
  const ready = scenes.filter((scene) => !isPending(scene, planned));
  if (ready.length === 0) throw new Error(`all ${scenes.length} scene(s) of ${selector} wait for lanes (${skipped.flatMap((scene) => pendingLanes(scene, planned)).filter((lane, index, list) => list.indexOf(lane) === index).join(', ')}); use --include-pending to make them anyway`);
  return ready;
}

export const cutNames = (scenario) => ['main', ...scenario.chapters.map((chapter) => chapter.id)];

/** Voice speed of the scenario (the recommended speed of its voice). */
export function speedOf(scenario, voices = loadVoices()) {
  const id = scenario.voice ?? voices.defaultVoice;
  const voice = voices.voices.find((candidate) => candidate.id === id);
  if (voice === undefined) throw new Error(`unknown voice ${id}`);
  return voice.speed;
}

/** The estimated length of one scene, in milliseconds, from its narration with the nominal samples of its figures. */
export function estimateScene(scene, scenario, { speed, spec = loadSpec(), phonetics = loadPhonetics(), numerals = loadNumerals() } = {}) {
  const spoken = speechText(scene.narration, { figures: scenario.figures, mode: 'sample', phonetics, numerals });
  const voiceMs = estimateVoiceMs(spoken, speed ?? speedOf(scenario), spec);
  return { spoken, voiceMs, sceneMs: sceneMsFromVoice(voiceMs, spec) };
}

export function cutSeconds(scenario, selector, options = {}) {
  return selectScenes(scenario, selector).reduce((sum, scene) => sum + (scene.expectedSec ?? estimateScene(scene, scenario, options).sceneMs / 1000), 0);
}

const NUMBER_TOKEN = /(?<![\p{L}\p{N}-])\d+(?:,\d+)?(?![\p{L}\p{N}-])/gu;
const withoutFigures = (text) => text.replace(/\{\{figure:[a-z0-9-]+\}\}/gu, '');

function stepProblems(step, where, context, scenario, used) {
  const problems = [];
  const required = STEP_VERBS[step.do];
  if (required === undefined) return [`${where}: unknown step verb "${step.do}"`];
  for (const key of required) if (step[key] === undefined || step[key] === '') problems.push(`${where}: step ${step.do} needs ${key}`);
  if (step.do === 'wait' && step.for !== 'voice' && !(Number.isInteger(step.ms) && step.ms > 0)) problems.push(`${where}: wait needs for:"voice" or a positive ms`);
  if (step.do === 'scroll' || step.do === 'phone-scroll') if (step.through !== 'voice' && !(Number.isInteger(step.through) && step.through > 0)) problems.push(`${where}: scroll through must be "voice" or ms`);
  if (step.ref !== undefined) {
    used.refs.add(step.ref);
    if (context.refs[step.ref] === undefined) problems.push(`${where}: ref ${step.ref} is not in refs.json`);
  }
  const persona = step.persona ?? step.as;
  if (persona !== undefined && !context.spec.personas.includes(persona)) problems.push(`${where}: persona ${persona} is not in clip-spec.json`);
  for (const key of OPERATION_FIELDS) {
    if (step[key] === undefined) continue;
    used.operations.add(step[key]);
    const known = context.operationIds.has(step[key]);
    const planned = context.planned.operations?.[step[key]];
    if (!known && planned === undefined) problems.push(`${where}: operation ${step[key]} is not in the contract and not in planned.json`);
    if (!known && planned !== undefined && context.strict && !context.pending) problems.push(`${where}: operation ${step[key]} is still planned (lane ${planned.lane}), not in the contract`);
  }
  if (step.fixture !== undefined && scenario.data?.fixtures?.[step.fixture] === undefined) problems.push(`${where}: fixture ${step.fixture} is not declared in data.fixtures`);
  if (step.textKey !== undefined && scenario.typed?.[step.textKey] === undefined) problems.push(`${where}: textKey ${step.textKey} is not in typed`);
  if (step.do === 'animatic' || step.do === 'still') {
    used.animatics.add(step.id);
    if (scenario.animatics?.[step.id] === undefined) problems.push(`${where}: ${step.do} ${step.id} is not declared in animatics`);
  }
  if (step.screen !== undefined) problems.push(...screenProblems([step.screen], where, context));
  return problems;
}

function screenProblems(ids, where, context) {
  const problems = [];
  for (const id of ids) {
    const inCatalogue = context.catalogue.has(id);
    const planned = context.planned.screens?.[id];
    if (!inCatalogue && planned === undefined) problems.push(`${where}: screen ${id} is not in the catalogue and not in planned.json`);
    else if (!inCatalogue && context.strict && planned.status !== 'built' && !context.pending) problems.push(`${where}: screen ${id} is still planned (lane ${planned.lane})`);
  }
  return problems;
}

/** Everything wrong with a scenario, as a list of messages (empty when it is sound). `context` carries the repo facts: catalogue ids, operation ids, refs, planned items, spec. */
export function validateScenario(scenario, context) {
  const problems = [...(scenario._loadProblems ?? [])];
  const { spec } = context;
  const speed = speedOf(scenario, context.voices);
  const fail = (message) => problems.push(message);
  if (scenario.schema !== 'clip-scenario/1') fail('schema must be clip-scenario/1');
  if (!['public', 'enterprise'].includes(scenario.edition)) fail('edition must be public or enterprise');
  for (const key of ['clip', 'title', 'summary']) if (typeof scenario[key] !== 'string' || scenario[key].trim() === '') fail(`${key} is missing`);
  if (scenario.voice !== undefined && !context.voices.voices.some((voice) => voice.id === scenario.voice)) fail(`unknown voice ${scenario.voice}`);

  const chapterIds = new Set();
  for (const chapter of scenario.chapters) {
    if (!KEBAB.test(chapter.id ?? '')) fail(`chapter id ${chapter.id} is not kebab-case`);
    if (chapterIds.has(chapter.id)) fail(`chapter ${chapter.id} is twice`);
    chapterIds.add(chapter.id);
    if (typeof chapter.title !== 'string' || chapter.title.trim() === '') fail(`chapter ${chapter.id} has no title`);
    if (!scenario.scenes.some((scene) => scene.chapter === chapter.id)) fail(`chapter ${chapter.id} has no scene`);
    if (chapter.mainOptional !== true && !scenario.scenes.some((scene) => scene.chapter === chapter.id && scene.main === true)) fail(`chapter ${chapter.id} has no scene in the main video`);
  }

  for (const [id, declaration] of Object.entries(scenario.figures)) {
    if (!KEBAB.test(id)) fail(`figure id ${id} is not kebab-case`);
    if (!FIGURE_KINDS.includes(declaration.kind)) fail(`figure ${id}: unknown kind ${declaration.kind}`);
    if (declaration.kind !== 'text' && typeof declaration.sample !== 'number') fail(`figure ${id}: needs a numeric sample (used only to estimate durations)`);
    if (typeof declaration.description !== 'string') fail(`figure ${id}: needs a description`);
    const operation = declaration.source?.operation;
    if (typeof operation !== 'string' || typeof declaration.source?.select !== 'string') fail(`figure ${id}: needs source.operation and source.select`);
    else if (!context.operationIds.has(operation) && context.planned.operations?.[operation] === undefined) fail(`figure ${id}: operation ${operation} is not in the contract and not in planned.json`);
    else if (!context.operationIds.has(operation) && context.strict) fail(`figure ${id}: operation ${operation} is still planned`);
  }

  const used = { refs: new Set(), operations: new Set(), animatics: new Set(), figures: new Set(), literals: new Set() };
  const seen = new Set();
  for (const scene of scenario.scenes) {
    const where = `scene ${scene.id}`;
    if (!KEBAB.test(scene.id ?? '')) fail(`${where}: id is not kebab-case`);
    if (seen.has(scene.id)) fail(`${where}: id is twice`);
    seen.add(scene.id);
    if (!chapterIds.has(scene.chapter)) fail(`${where}: chapter ${scene.chapter} is not defined`);
    if (typeof scene.main !== 'boolean') fail(`${where}: main must be true or false`);
    if (scene.mainFor !== undefined && (scene.main !== true || !scene.mainFor.every((edition) => ['public', 'enterprise'].includes(edition)))) fail(`${where}: mainFor lists editions and needs main true`);
    if (typeof scene.narration !== 'string' || scene.narration.trim() === '') {
      fail(`${where}: narration is missing`);
      continue;
    }
    for (const word of spec.forbiddenInNarration) {
      const inScene = JSON.stringify([scene.narration, scene.captions ?? []]);
      if (inScene.toUpperCase().includes(word.toUpperCase())) fail(`${where}: the internal name ${word} must never be shown or read`);
    }
    for (const id of figureIds(scene.narration)) used.figures.add(id);
    for (const caption of scene.captions ?? []) for (const id of figureIds(caption.text ?? '')) used.figures.add(id);
    for (const id of figureIds(JSON.stringify(scene))) if (scenario.figures[id] === undefined) fail(`${where}: figure ${id} is not declared`);
    const literals = [scene.narration, ...(scene.captions ?? []).map((caption) => caption.text ?? '')].flatMap((text) => withoutFigures(text).match(NUMBER_TOKEN) ?? []);
    for (const literal of literals) {
      used.literals.add(literal);
      if (scenario.literalNumbers[literal] === undefined) fail(`${where}: the number ${literal} is a literal; figures come from placeholders, structural counts must be listed in literalNumbers`);
    }

    const screen = scene.screen ?? {};
    if (scene.requires !== undefined && (!Array.isArray(scene.requires) || scene.requires.length === 0 || !scene.requires.every((lane) => typeof lane === 'string'))) fail(`${where}: requires is a list of lane ids`);
    for (const lane of Array.isArray(scene.requires) ? scene.requires : []) if (context.planned.lanes?.[lane] === undefined) fail(`${where}: requires lane ${lane}, which is not in planned.json lanes`);
    for (const id of screen.screens ?? []) {
      const lane = context.planned.screens?.[id]?.lane;
      if (lane !== undefined && context.planned.lanes?.[lane] !== undefined && context.catalogue.has(id) === false && !(scene.requires ?? []).includes(lane)) fail(`${where}: planned screen ${id} belongs to lane ${lane}; the scene must list it in requires`);
    }
    const sceneContext = isPending(scene, context.planned) ? { ...context, pending: true } : context;
    if (scene.layout !== undefined && !LAYOUT_NAMES.includes(scene.layout)) fail(`${where}: layout ${scene.layout} is not one of ${LAYOUT_NAMES.join(', ')}`);
    for (const [index, callout] of (scene.callouts ?? []).entries()) if (typeof callout.text !== 'string' || !(callout.atSec >= 0) || !(callout.forSec > 0)) fail(`${where}: callout ${index + 1} needs text, atSec and forSec`);
    if (!PLATFORMS.includes(screen.platform)) fail(`${where}: screen.platform must be one of ${PLATFORMS.join(', ')}`);
    problems.push(...screenProblems(screen.screens ?? [], where, sceneContext));
    for (const id of screen.screens ?? []) {
      const entry = context.catalogueEntries?.get(id);
      if (entry !== undefined && screen.platform === 'phone' && entry.platform !== 'mobile') fail(`${where}: screen ${id} is not a phone screen`);
      if (entry !== undefined && screen.platform === 'web' && entry.platform === 'mobile') fail(`${where}: screen ${id} is a phone screen on a web scene`);
    }
    if (screen.animatic !== undefined) {
      used.animatics.add(screen.animatic);
      if (scenario.animatics[screen.animatic] === undefined) fail(`${where}: animatic ${screen.animatic} is not declared`);
    }
    if (['animatic', 'title'].includes(screen.platform) && screen.animatic === undefined) fail(`${where}: an ${screen.platform} scene names its animatic`);
    if (!Array.isArray(scene.steps) || scene.steps.length === 0) fail(`${where}: steps are missing`);
    for (const [index, step] of (scene.steps ?? []).entries()) problems.push(...stepProblems(step, `${where} step ${index + 1}`, sceneContext, scenario, used));

    let estimate;
    try {
      estimate = estimateScene(scene, scenario, { speed, spec, phonetics: context.phonetics, numerals: context.numerals });
    } catch (error) {
      fail(`${where}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (typeof scene.expectedSec !== 'number') fail(`${where}: expectedSec is missing (run: node scripts/clips/scenario.mjs stamp)`);
    else if (Math.abs(scene.expectedSec - estimate.sceneMs / 1000) > spec.narration.estimateToleranceSec) fail(`${where}: expectedSec ${scene.expectedSec} differs from the estimate ${(estimate.sceneMs / 1000).toFixed(1)} (run: stamp)`);
    for (const term of uncoveredTerms(estimate.spoken, context.phonetics)) fail(`${where}: "${term}" would be read as written; add it to phonetics.json`);

    for (const caption of scene.captions ?? []) {
      if (typeof caption.text !== 'string' || caption.text.trim() === '') fail(`${where}: a caption has no text`);
      if (!(caption.atSec >= 0) || !(caption.forSec > 0)) fail(`${where}: a caption needs atSec and forSec`);
      else if (typeof scene.expectedSec === 'number' && caption.atSec + caption.forSec > scene.expectedSec + 0.05) fail(`${where}: caption "${caption.text.slice(0, 30)}" runs past the scene`);
    }
    for (const name of scene.stamps ?? []) {
      const stamp = spec.stamps[name];
      if (stamp === undefined) fail(`${where}: unknown stamp ${name}`);
      else {
        if (!(scene.captions ?? []).some((caption) => (caption.text ?? '').includes(stamp.caption))) fail(`${where}: stamp ${name} needs a caption with "${stamp.caption}"`);
        if (!scene.narration.toLowerCase().includes(stamp.narrationContains.toLowerCase())) fail(`${where}: stamp ${name} needs the narration to say "${stamp.narrationContains}"`);
      }
    }
  }

  for (const id of Object.keys(scenario.figures)) if (!used.figures.has(id)) fail(`figure ${id} is declared and never used`);
  for (const id of Object.keys(scenario.literalNumbers)) if (!used.literals.has(id)) fail(`literal number ${id} is listed and never used`);
  for (const id of Object.keys(scenario.animatics)) if (!used.animatics.has(id)) fail(`animatic ${id} is declared and never used`);

  const main = cutSeconds(scenario, 'main', { speed, spec, phonetics: context.phonetics, numerals: context.numerals });
  if (main < spec.mainVideo.minSec || main > spec.mainVideo.maxSec) fail(`the main video is ${clock(main)} (${main.toFixed(0)} s), outside ${spec.mainVideo.minSec}-${spec.mainVideo.maxSec} s`);
  for (const chapter of scenario.chapters.filter((candidate) => candidate.standalone !== false)) {
    const seconds = cutSeconds(scenario, chapter.id, { speed, spec, phonetics: context.phonetics, numerals: context.numerals });
    if (seconds < spec.chapterCut.minSec || seconds > spec.chapterCut.maxSec) fail(`chapter cut ${chapter.id} is ${seconds.toFixed(0)} s, outside ${spec.chapterCut.minSec}-${spec.chapterCut.maxSec} s`);
  }
  return { problems, used };
}

/** The repo facts a scenario is checked against. */
export function loadContext({ strict = false } = {}) {
  const catalogueRows = readJson(join(REPO_ROOT, 'Design', 'MACHVON_Design', '03_Engineering', 'screen_catalog.json'));
  const openapi = readJson(join(REPO_ROOT, 'Design', 'MACHVON_Design', '03_Engineering', 'openapi.json'));
  const operationIds = new Set();
  for (const methods of Object.values(openapi.paths)) for (const operation of Object.values(methods)) if (operation?.operationId !== undefined) operationIds.add(operation.operationId);
  return {
    spec: loadSpec(),
    voices: loadVoices(),
    phonetics: loadPhonetics(),
    numerals: loadNumerals(),
    refs: readJson('refs.json').refs,
    planned: readJson('planned.json'),
    catalogue: new Set(catalogueRows.map((row) => row.id)),
    catalogueEntries: new Map(catalogueRows.map((row) => [row.id, row])),
    operationIds,
    strict,
  };
}

/** Refs that no scenario uses (a registry entry nobody needs is clutter). */
export function unusedRefs(usedByClip, refs) {
  return Object.keys(refs).filter((ref) => !usedByClip.some((used) => used.has(ref)));
}

/** Writes the estimated length into every scene (the origin file of each scene is rewritten). */
export function stampScenario(scenario, options = {}) {
  const speed = speedOf(scenario);
  for (const scene of scenario.scenes) {
    const estimate = estimateScene(scene, scenario, { speed, ...options });
    const target = scenario._files.get(scenario._origin.get(scene.id)).scenes.find((candidate) => candidate.id === scene.id);
    target.expectedSec = Math.round(estimate.sceneMs / 100) / 10;
  }
  for (const [file, content] of scenario._files) writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
}

/** A readable summary of a scenario: the length of each cut, words, and what is still planned. */
export function reportScenario(scenario, context) {
  const speed = speedOf(scenario, context.voices);
  const lines = [`${scenario.clip} (${scenario.edition}): ${scenario.scenes.length} scenes, voice ${scenario.voice ?? context.voices.defaultVoice} at speed ${speed}`];
  for (const name of cutNames(scenario)) {
    const scenes = selectScenes(scenario, name);
    const seconds = cutSeconds(scenario, name, { speed, spec: context.spec, phonetics: context.phonetics, numerals: context.numerals });
    const words = scenes.reduce((sum, scene) => sum + displayText(scene.narration, { figures: scenario.figures, mode: 'sample' }).split(/\s+/u).length, 0);
    lines.push(`  ${name.padEnd(18)} ${String(scenes.length).padStart(3)} scenes  ${clock(seconds).padStart(5)}  ${String(words).padStart(5)} words`);
  }
  const planned = new Set();
  for (const scene of scenario.scenes) {
    for (const id of scene.screen?.screens ?? []) if (!context.catalogue.has(id) && context.planned.screens?.[id]?.status !== 'built') planned.add(`screen ${id}`);
    for (const step of scene.steps ?? []) if (step.operation !== undefined && !context.operationIds.has(step.operation)) planned.add(`operation ${step.operation}`);
  }
  for (const declaration of Object.values(scenario.figures)) if (!context.operationIds.has(declaration.source?.operation)) planned.add(`operation ${declaration.source?.operation}`);
  lines.push(`  still planned (other lanes): ${planned.size === 0 ? 'none' : [...planned].sort().join(', ')}`);
  return lines.join('\n');
}

function main(argv) {
  const [command = 'check', ...rest] = argv;
  const strict = flag(argv, 'strict');
  const context = loadContext({ strict });
  const wanted = positionals(rest);
  const clips = wanted.length > 0 ? wanted : listClips();
  if (command === 'stamp') {
    for (const clip of clips) stampScenario(loadScenario(clip), { phonetics: context.phonetics, numerals: context.numerals });
    console.log(`stamped ${clips.join(', ')}`);
    return 0;
  }
  if (command === 'report') {
    for (const clip of clips) console.log(reportScenario(loadScenario(clip), context));
    return 0;
  }
  if (command !== 'check') {
    console.error('usage: node scripts/clips/scenario.mjs <check|stamp|report> [clip ...] [--strict]');
    return 2;
  }
  let failures = 0;
  const usedRefs = [];
  for (const clip of clips) {
    const scenario = loadScenario(clip);
    const { problems, used } = validateScenario(scenario, context);
    usedRefs.push(used.refs);
    if (scenario.clip !== clip) problems.push(`clip is ${scenario.clip}, the file is ${clip}`);
    console.log(`${clip}: ${problems.length === 0 ? 'ok' : `${problems.length} problem(s)`}`);
    for (const problem of problems) console.log(`  ${problem}`);
    failures += problems.length;
  }
  if (wanted.length === 0) {
    for (const ref of unusedRefs(usedRefs, context.refs)) {
      console.log(`  refs.json: ${ref} is used by no scenario`);
      failures += 1;
    }
  }
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}

