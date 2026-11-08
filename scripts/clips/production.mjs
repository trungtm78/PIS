import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DATASET_PHASES } from '../clip-seed-lib.mjs';
import { CLIPS_DIR, clock, loadPhonetics, loadSpec, readJson, REPO_ROOT } from './common.mjs';
import { figureIds } from './figures.mjs';
import { applyPhonetics } from './phonetics.mjs';
import { cutNames, cutSeconds, estimateScene, listClips, loadContext, loadScenario, selectScenes, speedOf, validateScenario } from './scenario.mjs';
import { checkCues, cuesForScene } from './subtitles.mjs';
import { displayText, sentencesOf } from './text.mjs';

export const PRODUCTION_DIR = join(CLIPS_DIR, 'production');
export const BOOK_DIR = join(REPO_ROOT, 'docs', 'clips');
export const bookPath = (clip) => join(BOOK_DIR, `${clip}.script.md`);

/** The mark of a Vietnamese letter (accents and the letters d-bar, a-breve, o-horn, u-horn), written with escapes so that this file holds no Vietnamese. */
const VIET_MARKS = /[\u00c0-\u00ff\u0102\u0103\u0110\u0111\u0128\u0129\u0168\u0169\u01a0\u01a1\u01af\u01b0\u1ea0-\u1ef9]/u;
const FIGURE_TOKEN = '{n}';

export function loadProduction() {
  const read = (name) => readJson(join(PRODUCTION_DIR, name));
  return { rules: read('rules.json'), texts: read('texts.json'), shots: read('shots.json'), music: read('music.json'), readiness: read('readiness.json') };
}

const fill = (template, params) => template.replace(/\{(\w+)\}/gu, (_, key) => String(params[key]));

/** Routes of the web app, the registered screen modules, the routes of the phone app and of the installed application. */
export function loadRepoFacts() {
  const webRoutes = new Map(readJson(join(REPO_ROOT, 'apps', 'web', 'src', 'routes', 'routes.generated.json')).routes.map((route) => [route.id, route.path]));
  const registry = readFileSync(join(REPO_ROOT, 'apps', 'web', 'src', 'routes', 'screens', 'index.ts'), 'utf8');
  const implemented = new Set([...registry.matchAll(/'([A-Z]+-\d+)':/gu)].map((match) => match[1]));
  const dart = readFileSync(join(REPO_ROOT, 'apps', 'mobile', 'lib', 'core', 'navigation', 'mobile_routes.generated.dart'), 'utf8');
  const mobileRoutes = new Map([...dart.matchAll(/MobileRoute\(id: '([A-Z]+-\d+)'(?:[^)]*?tab: AppTab\.(\w+))?/gu)].map((match) => [match[1], match[2] ?? 'stack']));
  const pwaText = readFileSync(join(REPO_ROOT, 'docs', 'pwa.md'), 'utf8');
  const pwaRoutes = new Map([...pwaText.matchAll(/^\|\s*(PWA-\d+)\s*\|\s*`([^`]+)`/gmu)].map((match) => [match[1], match[2]]));
  return { webRoutes, implemented, mobileRoutes, pwaRoutes };
}

/** What a screen id of a scene resolves to: its title, the route a recorder opens, and whether the screen has a module in this build. */
export function screenFact(id, context, facts) {
  const entry = context.catalogueEntries.get(id);
  if (/^PWA-\d+$/u.test(id)) {
    const route = facts.pwaRoutes.get(id);
    return { id, title: id, kind: 'pwa', route: route ?? null, found: route !== undefined, implemented: context.planned.screens?.[id]?.status === 'built' };
  }
  if (entry === undefined) return { id, title: id, kind: 'unknown', route: null, found: false, implemented: false };
  if (entry.platform === 'mobile') {
    const tab = facts.mobileRoutes.get(id);
    return { id, title: entry.title, kind: 'phone', route: tab === undefined ? null : `tab ${tab}`, found: tab !== undefined, implemented: tab !== undefined };
  }
  const route = facts.webRoutes.get(id);
  return { id, title: entry.title, kind: 'web', route: route ?? null, found: route !== undefined, implemented: facts.implemented.has(id) };
}

const sceneScreenIds = (scene) => [...new Set([...(scene.screen?.screens ?? []), ...(scene.steps ?? []).flatMap((step) => (step.screen === undefined ? [] : [step.screen]))])];

/** A sentence in English only: no Vietnamese letter at all and English function words in it. */
export function isEnglishOnly(sentence, english) {
  const text = sentence.normalize('NFC');
  if (VIET_MARKS.test(text)) return false;
  const words = text.toLowerCase().match(/[a-z]+/gu) ?? [];
  if (words.length < 3) return false;
  const stop = new Set(english.stopwords);
  const hits = words.filter((word) => stop.has(word)).length;
  return hits >= english.minHits || hits / words.length >= english.minRatio;
}

/** The names of the secret patterns that a text matches (the text itself is never returned). */
export function secretHits(text, patterns) {
  return patterns.filter((pattern) => new RegExp(pattern.source, pattern.flags).test(text)).map((pattern) => pattern.name);
}

/** The files that hold the words and data of the clips, for the secret scan. */
export function scanFiles() {
  const out = [];
  const walk = (dir, accept) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, accept);
      else if (accept(entry.name)) out.push(full);
    }
  };
  walk(join(CLIPS_DIR, 'scenarios'), (name) => name.endsWith('.json'));
  walk(PRODUCTION_DIR, (name) => name.endsWith('.json'));
  for (const name of readdirSync(CLIPS_DIR)) if (/\.(json|md)$/u.test(name)) out.push(join(CLIPS_DIR, name));
  walk(BOOK_DIR, (name) => name.endsWith('.md'));
  return out;
}

const voiceOf = (scene, scenario, context) => estimateScene(scene, scenario, { speed: speedOf(scenario, context.voices), spec: context.spec, phonetics: context.phonetics, numerals: context.numerals });

/** The subtitle cues of one scene as they would be cut at authoring time (the figures at their nominal samples, only for the lengths). */
export function subtitleCues(scene, scenario, context, { figureToken = false } = {}) {
  const estimate = voiceOf(scene, scenario, context);
  const raw = figureToken ? scene.narration.replace(/\{\{figure:[a-z0-9-]+\}\}/gu, FIGURE_TOKEN) : displayText(scene.narration, { figures: scenario.figures, mode: 'sample' });
  return cuesForScene(raw, 0, estimate.voiceMs, context.spec.subtitles);
}

/** The checklist of one scene: the derived items in the order a person films them, then the curated extras. */
export function shotChecklist(scene, scenario, context, facts, production) {
  const { shot } = production.texts;
  const items = [];
  const platform = scene.screen?.platform;
  for (const id of scene.screen?.screens ?? []) {
    const fact = screenFact(id, context, facts);
    const route = fact.route ?? '-';
    if (fact.kind === 'web') items.push({ kind: 'screen', text: fill(shot.web, { id, title: fact.title, route }) });
    else if (fact.kind === 'pwa') items.push({ kind: 'screen', text: fill(shot.pwa, { id, route }) });
    else if (fact.kind === 'phone') items.push({ kind: 'screen', text: fill(shot.phone, { id, title: fact.title, route }) });
  }
  if (platform === 'animatic') items.push({ kind: 'animatic', text: fill(shot.animatic, { id: scene.screen.animatic }) });
  if (platform === 'title') items.push({ kind: 'animatic', text: fill(shot.title, { id: scene.screen.animatic }) });
  for (const step of scene.steps ?? []) {
    if (step.do === 'as') items.push({ kind: 'persona', text: fill(shot.persona, { persona: step.persona }) });
    if (step.do === 'spot' || step.do === 'click' || step.do === 'point') items.push({ kind: 'spot', text: fill(shot.spot, { ref: step.ref }) });
    if (step.do === 'command') items.push({ kind: 'command', text: fill(shot.command, { operation: step.operation, persona: step.as ?? 'owner' }) });
    if (step.do === 'upload') items.push({ kind: 'command', text: fill(shot.upload, { operation: step.operation, fixture: step.fixture }) });
  }
  for (const caption of scene.captions ?? []) items.push({ kind: 'caption', text: fill(shot.caption, { text: caption.text, at: caption.atSec, for: caption.forSec }) });
  for (const name of scene.stamps ?? []) items.push({ kind: 'stamp', text: fill(shot.stamp, { caption: context.spec.stamps[name].caption }) });
  const used = new Set([...figureIds(scene.narration), ...(scene.captions ?? []).flatMap((caption) => figureIds(caption.text ?? ''))]);
  for (const id of used) {
    const source = scenario.figures[id]?.source ?? {};
    items.push({ kind: 'figure', text: fill(shot.figure, { id, operation: source.operation, select: source.select }) });
  }
  for (const text of production.shots.scenes[scene.id] ?? []) items.push({ kind: 'extra', text });
  items.push({ kind: 'global', text: shot.global });
  return items;
}

/** For each cue of a clip, the second of the main video where it starts (the first main scene of its first chapter). */
export function musicTimeline(clip, scenario, production, context) {
  const { cues } = production.music.clips[clip];
  const main = selectScenes(scenario, 'main');
  let cursor = 0;
  const starts = new Map();
  for (const scene of main) {
    if (!starts.has(scene.chapter)) starts.set(scene.chapter, cursor);
    cursor += scene.expectedSec ?? voiceOf(scene, scenario, context).sceneMs / 1000;
  }
  return cues.map((cue) => ({ ...cue, startSec: Math.min(...cue.chapters.filter((chapter) => starts.has(chapter)).map((chapter) => starts.get(chapter))) }));
}

/** Chapters whose data groups are not all run and verified, and the gaps recorded for them. */
export function dataRisks(scenario, production) {
  const dataset = production.readiness.datasets[scenario.data?.dataset];
  const risks = new Map();
  if (dataset === undefined) return risks;
  for (const chapter of scenario.chapters) {
    const entry = dataset.chapters[chapter.id];
    if (entry === undefined) continue;
    const pending = entry.groups.filter((group) => dataset.groups[group]?.proof !== 'RUN_VERIFIED');
    if (pending.length > 0 || (entry.gaps ?? []).length > 0) risks.set(chapter.id, { pending, gaps: entry.gaps ?? [] });
  }
  return risks;
}

/** Everything wrong with the production script of one clip (`problems`) and what is only worth knowing (`warnings`). */
export function checkClip(clip, { context, facts, production, strict = false, strictData = false, scenario = loadScenario(clip) }) {
  const problems = [];
  const warnings = [];
  const fail = (message) => problems.push(`${clip}: ${message}`);
  const { rules } = production;
  const edition = scenario.edition;
  for (const message of validateScenario(scenario, { ...context, strict }).problems) fail(message);

  // Screens and routes: every id of a scene resolves to a route, and (strict) to a screen that exists in this build.
  const seenScreens = new Set();
  for (const scene of scenario.scenes) {
    for (const id of sceneScreenIds(scene)) {
      if (seenScreens.has(id)) continue;
      seenScreens.add(id);
      const fact = screenFact(id, context, facts);
      if (fact.kind === 'unknown') fail(`screen ${id} is not in the catalogue`);
      else if (!fact.found) fail(`screen ${id} has no route in the ${fact.kind} route table`);
      else if (!fact.implemented) (strict ? problems : warnings).push(`${clip}: screen ${id} (${fact.route}) has a route but no module in this build yet`);
    }
  }

  // Durations: the cuts add up and sit inside their budgets.
  const options = { speed: speedOf(scenario, context.voices), spec: context.spec, phonetics: context.phonetics, numerals: context.numerals };
  const main = selectScenes(scenario, 'main');
  const mainSum = main.reduce((sum, scene) => sum + scene.expectedSec, 0);
  const mainEstimate = main.reduce((sum, scene) => sum + estimateScene(scene, scenario, options).sceneMs / 1000, 0);
  if (Math.abs(mainSum - mainEstimate) > rules.sumDriftPerSceneSec * main.length) fail(`the main video sums to ${mainSum.toFixed(1)} s but its estimate is ${mainEstimate.toFixed(1)} s (run: node scripts/clips/scenario.mjs stamp)`);
  for (const chapter of scenario.chapters) {
    const sum = selectScenes(scenario, chapter.id).reduce((total, scene) => total + scene.expectedSec, 0);
    const budget = rules.chapterBudgetSec[edition]?.[chapter.id];
    if (budget !== undefined && (sum < budget[0] || sum > budget[1])) fail(`chapter ${chapter.id} is ${sum.toFixed(0)} s, outside its budget ${budget[0]}-${budget[1]} s`);
    const inMain = main.filter((scene) => scene.chapter === chapter.id).reduce((total, scene) => total + scene.expectedSec, 0);
    if (inMain > sum + 0.001) fail(`chapter ${chapter.id}: the part in the main video is longer than the chapter`);
  }
  const chaptersTotal = scenario.chapters.reduce((sum, chapter) => sum + selectScenes(scenario, chapter.id).reduce((total, scene) => total + scene.expectedSec, 0), 0);
  const scenesTotal = scenario.scenes.reduce((sum, scene) => sum + scene.expectedSec, 0);
  if (Math.abs(chaptersTotal - scenesTotal) > 0.001) fail(`the chapters add up to ${chaptersTotal.toFixed(1)} s but the scenes to ${scenesTotal.toFixed(1)} s`);

  // Owner scope: the chapters and platforms the brief names, and the stamps that some screens always need.
  const chapterIds = scenario.chapters.map((chapter) => chapter.id);
  for (const id of rules.requiredChapters[edition]) if (!chapterIds.includes(id)) fail(`the required chapter ${id} is missing`);
  for (const platform of rules.requiredPlatforms[edition]) if (!scenario.scenes.some((scene) => scene.screen?.platform === platform)) fail(`no scene on the platform ${platform}`);
  for (const [stamp, screens] of Object.entries(rules.stampRequiredFor[edition] ?? {})) {
    for (const scene of scenario.scenes) {
      if ((scene.screen?.screens ?? []).some((id) => screens.includes(id)) && !(scene.stamps ?? []).includes(stamp)) fail(`scene ${scene.id} shows ${screens.filter((id) => (scene.screen.screens ?? []).includes(id)).join(', ')} and needs the stamp ${stamp}`);
    }
  }

  // Words: Vietnamese only, short sentences, no label that the owner removed.
  for (const scene of scenario.scenes) {
    const where = `scene ${scene.id}`;
    const texts = [['narration', scene.narration], ...(scene.captions ?? []).map((caption, index) => [`caption ${index + 1}`, caption.text ?? ''])];
    for (const [label, raw] of texts) {
      const shown = displayText(raw, { figures: scenario.figures, mode: 'sample' });
      for (const sentence of sentencesOf(shown)) {
        if (isEnglishOnly(sentence, rules.english)) fail(`${where}: the ${label} has an English-only sentence`);
      }
      for (const phrase of rules.forbiddenLabels) if (shown.includes(phrase)) fail(`${where}: the ${label} shows the forbidden label ${phrase}`);
    }
    const spoken = displayText(scene.narration, { figures: scenario.figures, mode: 'sample' });
    for (const phrase of rules.forbiddenPhrases) if (spoken.toLowerCase().includes(phrase.toLowerCase())) fail(`${where}: the narration says "${phrase}"`);
    for (const sentence of sentencesOf(spoken)) {
      const words = sentence.split(/\s+/u).length;
      if (words > rules.maxSentenceWords) fail(`${where}: a sentence of ${words} words (max ${rules.maxSentenceWords}) is too long for the voice`);
      if (sentence.length > rules.maxSentenceChars) fail(`${where}: a sentence of ${sentence.length} characters (max ${rules.maxSentenceChars}) is too long for the voice`);
    }
    for (const caption of scene.captions ?? []) if ((caption.text ?? '').length > rules.maxCaptionChars) fail(`${where}: a caption of ${caption.text.length} characters (max ${rules.maxCaptionChars})`);
    // Subtitles derived from the narration obey the line rules of the film.
    for (const message of checkCues(subtitleCues(scene, scenario, context), context.spec.subtitles)) fail(`${where}: subtitles: ${message}`);
  }

  // Shots: every scene has a checklist, curated entries belong to a scene of some clip, every figure is named.
  for (const scene of scenario.scenes) {
    const items = shotChecklist(scene, scenario, context, facts, production);
    if (items.filter((item) => item.kind !== 'global').length === 0) fail(`scene ${scene.id} has no shot to check`);
    for (const id of figureIds(scene.narration)) if (!items.some((item) => item.kind === 'figure' && item.text.includes(id))) fail(`scene ${scene.id}: figure ${id} is not in the checklist`);
  }

  // Music cue sheet.
  const sheet = production.music.clips[clip];
  if (sheet === undefined) fail('no music cue sheet');
  else {
    const track = production.music.tracks.find((candidate) => candidate.id === sheet.track);
    if (track === undefined) fail(`music track ${sheet.track} is not in the track list`);
    for (const candidate of production.music.tracks) {
      if (candidate.licence !== 'CC0') fail(`music track ${candidate.id} is under ${candidate.licence}; only CC0 is allowed`);
      if (candidate.approval.status === 'APPROVED' && (candidate.approval.licenceReadOn === null || candidate.approval.licenceReadOn === undefined)) fail(`music track ${candidate.id} is approved without the date the licence was read`);
    }
    const covered = new Map();
    for (const cue of sheet.cues) {
      if (production.music.levels[cue.level] === undefined) fail(`music cue ${cue.id}: unknown level ${cue.level}`);
      else if (context.spec.audio.musicGainDb + production.music.levels[cue.level].relativeDb > -17) fail(`music cue ${cue.id}: the music would be louder than -17 dB under the voice`);
      for (const chapter of cue.chapters) {
        if (!chapterIds.includes(chapter)) fail(`music cue ${cue.id}: chapter ${chapter} is not in the clip`);
        covered.set(chapter, (covered.get(chapter) ?? 0) + 1);
      }
    }
    for (const id of chapterIds) if ((covered.get(id) ?? 0) !== 1) fail(`chapter ${id} is covered by ${covered.get(id) ?? 0} music cues (it needs exactly one)`);
    if ((sheet.cues[0]?.fadeInSec ?? 0) < context.spec.audio.musicFadeInSec) fail('the first music cue fades in too briefly');
    if ((sheet.cues[sheet.cues.length - 1]?.fadeOutSec ?? 0) < context.spec.audio.musicFadeOutSec) fail('the last music cue fades out too briefly');
    if (sheet.cues[0]?.chapters[0] !== chapterIds[0] || sheet.cues[sheet.cues.length - 1]?.chapters.slice(-1)[0] !== chapterIds[chapterIds.length - 1]) fail('the music cues do not run in the order of the chapters');
  }

  // Seed readiness: the groups exist in the dataset phases, every chapter has an entry.
  const dataset = scenario.data?.dataset;
  const readiness = production.readiness.datasets[dataset];
  if (readiness === undefined) fail(`no readiness entry for the dataset ${dataset}`);
  else {
    const known = new Set(DATASET_PHASES[dataset].flatMap((phase) => phase.groups));
    for (const group of Object.keys(readiness.groups)) if (!known.has(group)) fail(`readiness group ${group} is not a group of the ${dataset} dataset`);
    for (const group of known) if (readiness.groups[group] === undefined) fail(`the group ${group} of the ${dataset} dataset has no proof state`);
    for (const state of Object.values(readiness.groups)) if (!['RUN_VERIFIED', 'WRITTEN_NOT_RUN', 'NOT_DONE'].includes(state.proof)) fail(`unknown proof state ${state.proof}`);
    for (const id of chapterIds) {
      const entry = readiness.chapters[id];
      if (entry === undefined) fail(`chapter ${id} has no readiness entry`);
      else for (const group of entry.groups) if (readiness.groups[group] === undefined) fail(`chapter ${id} needs the group ${group}, which is not in the dataset`);
    }
    for (const [id, risk] of dataRisks(scenario, production)) {
      const text = `chapter ${id}: ${risk.pending.length > 0 ? `groups not run and verified: ${risk.pending.join(', ')}` : ''}${risk.gaps.length > 0 ? `${risk.pending.length > 0 ? '; ' : ''}${risk.gaps.length} data gap(s) recorded` : ''}`;
      (strictData ? problems : warnings).push(`${clip}: ${text}`);
    }
  }
  return { problems, warnings, scenario };
}

/** The checks that look at the files rather than at one clip: orphan curated shots, secrets, the committed shooting scripts. */
export function checkFiles({ production, scenarios, files = scanFiles() }) {
  const problems = [];
  const sceneIds = new Set(scenarios.flatMap((scenario) => scenario.scenes.map((scene) => scene.id)));
  for (const id of Object.keys(production.shots.scenes)) if (!sceneIds.has(id)) problems.push(`shots.json: scene ${id} is in no clip`);
  for (const file of files) {
    const hits = secretHits(readFileSync(file, 'utf8'), production.rules.secretPatterns);
    for (const hit of hits) problems.push(`${relative(REPO_ROOT, file)}: looks like a secret (${hit})`);
  }
  return problems;
}

const mmss = (sec) => clock(sec);

/** The shooting script of a clip as markdown: everything a recording and mixing session needs, in Vietnamese, derived from the data files. */
export function buildBook(clip, { context, facts, production }) {
  const scenario = loadScenario(clip);
  const { book } = production.texts;
  const options = { speed: speedOf(scenario, context.voices), spec: context.spec, phonetics: context.phonetics, numerals: context.numerals };
  const lines = [`# ${fill(book.title, { title: scenario.title })}`, '', book.intro, '', `- ${book.clip}: \`${scenario.clip}\``, `- ${book.edition}: ${scenario.edition}`, `- ${book.main}: ${mmss(cutSeconds(scenario, 'main', options))} (${selectScenes(scenario, 'main').length} ${book.sceneUnit})`, '', book.estimateNote, ''];
  lines.push(`## ${book.cuts}`, '', `| ${book.chapter} | ${book.scenes} | ${book.length} |`, '|---|---|---|');
  for (const name of cutNames(scenario)) {
    const title = name === 'main' ? book.main : (scenario.chapters.find((chapter) => chapter.id === name)?.title ?? name);
    lines.push(`| ${title} (\`${name}\`) | ${selectScenes(scenario, name).length} | ${mmss(cutSeconds(scenario, name, options))} |`);
  }
  const readiness = production.readiness.datasets[scenario.data.dataset];
  lines.push('', `## ${book.data}`, '', `${book.dataset}: \`${scenario.data.dataset}\` (docs/clip-data.md)`, '', `| ${book.group} | ${book.proof} |`, '|---|---|');
  for (const [group, state] of Object.entries(readiness.groups)) lines.push(`| \`${group}\` | ${state.proof} |`);
  lines.push('', `| ${book.chapter} | ${book.chapterData} | ${book.gaps} |`, '|---|---|---|');
  for (const chapter of scenario.chapters) {
    const entry = readiness.chapters[chapter.id];
    lines.push(`| \`${chapter.id}\` | ${entry.groups.length === 0 ? '-' : entry.groups.map((group) => `\`${group}\``).join(', ')} | ${(entry.gaps ?? []).join(' ') || '-'} |`);
  }
  const risks = dataRisks(scenario, production);
  lines.push('', `**${book.atRisk}:** ${risks.size === 0 ? '-' : [...risks.keys()].map((id) => `\`${id}\``).join(', ')}`);
  const sheet = production.music.clips[clip];
  lines.push('', `## ${book.music}`, '', book.musicNote, '', `| ${book.track} | ${book.licence} | ${book.approval} |`, '|---|---|---|');
  for (const track of production.music.tracks) lines.push(`| ${track.id}: ${track.title} (${track.author})${track.id === sheet.track ? ' *' : ''} | ${track.licence}, ${track.page} | ${track.approval.status} |`);
  lines.push('', `| ${book.cue} | ${book.chapter} | ${book.start} | ${book.level} | ${book.mood} |`, '|---|---|---|---|---|');
  for (const cue of musicTimeline(clip, scenario, production, context)) {
    const level = production.music.levels[cue.level];
    lines.push(`| \`${cue.id}\` | ${cue.chapters.map((chapter) => `\`${chapter}\``).join(', ')} | ${mmss(cue.startSec)} | ${level.relativeDb} dB | ${cue.note} |`);
  }
  for (const chapter of scenario.chapters) {
    lines.push('', `## ${chapter.title} (\`${chapter.id}\`)`, '');
    for (const scene of selectScenes(scenario, chapter.id)) {
      const platform = scene.screen?.platform;
      const spoken = applyPhonetics(scene.narration, context.phonetics);
      lines.push(`### \`${scene.id}\``, '', `${book.platform}: ${platform}; ${scene.expectedSec} ${book.seconds}; ${scene.main ? book.inMain : book.chapterOnly}`, '');
      const screens = (scene.screen?.screens ?? []).map((id) => screenFact(id, context, facts));
      if (screens.length > 0) lines.push(`${book.screens}: ${screens.map((fact) => `\`${fact.id}\` ${fact.title} (${fact.route ?? '-'})`).join('; ')}`, '');
      lines.push(`**${book.narration}**`, '', `> ${scene.narration}`, '', `**${book.voice}**`, '', `> ${spoken}`, '', `**${book.subtitles}**`, '');
      for (const cue of subtitleCues(scene, scenario, context, { figureToken: true })) lines.push(`- ${cue.text.replace(/\n/gu, ' / ')}`);
      lines.push('', `**${book.steps}**`, '');
      for (const step of scene.steps ?? []) lines.push(`- \`${Object.entries(step).map(([key, value]) => `${key}=${value}`).join(' ')}\``);
      lines.push('', `**${book.shots}**`, '');
      for (const item of shotChecklist(scene, scenario, context, facts, production)) lines.push(`- [ ] ${item.text}`);
      lines.push('');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`;
}

export function loadAll({ strict = false } = {}) {
  return { context: loadContext({ strict }), facts: loadRepoFacts(), production: loadProduction(), spec: loadSpec(), phonetics: loadPhonetics(), clips: listClips() };
}
