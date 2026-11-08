// Pure planning of the clip datasets: a dataset fixture (scripts/fixtures/clip-data/<name>.json) plus its seed give one deterministic plan.
// The plan is plain data. The seed groups of apps/web/e2e/hdsd/seed/clip read it and call the real commands of the product; `verify` checks the
// readings of the real read operations against the expectations of the dataset. Nothing here touches the network or the clock.

import { createHash } from 'node:crypto';

export const DATASETS = ['public', 'enterprise'];

/** The groups of the seed layer each dataset runs, in order (the registry of apps/web/e2e/hdsd/seed/index.ts keeps the order of dependencies). */
export const DATASET_GROUPS = {
  public: ['base', 'capital'],
  enterprise: [],
};

/** A small deterministic generator (mulberry32): the same seed always gives the same sequence. */
export function createRng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** An integer in [low, high]. */
    int: (low, high) => low + Math.floor(next() * (high - low + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    /** A copy of the items in a shuffled order (Fisher-Yates). */
    shuffle(items) {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const other = Math.floor(next() * (index + 1));
        [copy[index], copy[other]] = [copy[other], copy[index]];
      }
      return copy;
    },
  };
}

/** A stable seed for a named stream of a dataset, so adding a stream never changes the others. */
export function streamSeed(seed, name) {
  return createHash('sha256').update(`${seed}:${name}`).digest().readUInt32BE(0);
}

/** The stages of the portfolio, in the order they are generated. */
export const STAGES = ['IMPLEMENTATION', 'BUDGETED', 'COMPLETED', 'SUSPENDED', 'APPRAISAL', 'PIPELINE', 'REJECTED', 'CONCEPT'];
/** The stages that carry capital of the annual plan (and so a national code). */
export const FUNDED = new Set(['IMPLEMENTATION', 'BUDGETED', 'COMPLETED', 'SUSPENDED']);

function groupOf(totalBillions) {
  if (totalBillions >= 2300) return 'A';
  if (totalBillions >= 120) return 'B';
  return 'C';
}

/** Splits `total` into whole billions over the sources, by share, never above the room each has left. Returns lines and the rest that did not fit. */
function spread(total, order, room, shares) {
  const lines = [];
  let rest = total;
  for (const key of order) {
    if (rest <= 0) break;
    const wanted = Math.max(1, Math.round(total * (shares[key] ?? 0)));
    const part = Math.min(wanted, rest, room[key] ?? 0);
    if (part > 0) {
      lines.push({ appropriation: key, billions: part });
      room[key] -= part;
      rest -= part;
    }
  }
  return { lines, rest };
}

/**
 * The extra projects of a portfolio (the dataset says how many, in which stage and in which sectors), the lines of capital that fund them and the
 * appropriations those lines draw on. Every funded project gets a national code and lines that fit the room of the appropriations.
 */
export function buildPortfolio(dataset, baseRoom) {
  const rng = createRng(streamSeed(dataset.seed, 'portfolio'));
  const places = [...dataset.existingAreas, ...dataset.extraAreas];
  const reserved = new Set(dataset.reservedProjectCodes);
  const stages = [];
  for (const stage of STAGES) for (let index = 0; index < (dataset.stageMix[stage] ?? 0); index += 1) stages.push(stage);
  const total = stages.length;
  if (total !== dataset.extraProjects) throw new Error(`stageMix adds up to ${total}, extraProjects says ${dataset.extraProjects}`);
  // Sectors by weight: a flat list the generator walks through (shuffled), so every sector appears at least once when the weights allow.
  const sectorPool = rng.shuffle(dataset.sectors.flatMap((sector) => Array.from({ length: sector.weight }, () => sector)));
  while (sectorPool.length < total) sectorPool.push(...rng.shuffle(dataset.sectors));
  const usedNames = new Set();
  const usedCodes = new Set(reserved);
  const room = { ...baseRoom };
  const order = Object.keys(dataset.funding.shares);
  const projects = [];
  const lines = [];
  let national = 7_892_000;
  for (const [index, stage] of stages.entries()) {
    const sector = sectorPool[index];
    const place = places[(index * 5 + rng.int(0, places.length - 1)) % places.length];
    let name = '';
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const template = rng.pick(sector.templates);
      const candidate = template.replace('{place}', rng.pick(places).name);
      if (!usedNames.has(candidate)) {
        name = candidate;
        break;
      }
    }
    if (name === '') name = `${sector.templates[0].replace('{place}', place.name)} (${index + 1})`;
    usedNames.add(name);
    let code = '';
    for (let attempt = 0; attempt < 200 && code === ''; attempt += 1) {
      const candidate = `DA-${sector.prefix}${String(rng.int(100, 899))}`;
      if (!usedCodes.has(candidate)) code = candidate;
    }
    usedCodes.add(code);
    const [low, high] = sector.sizeBillions;
    const totalBillions = stage === 'PIPELINE' && index % 3 === 0 ? rng.int(high, high * 2) : rng.int(low, high);
    const startYear = stage === 'COMPLETED' ? 2025 : stage === 'IMPLEMENTATION' || stage === 'BUDGETED' ? 2026 : 2027;
    const spec = {
      code,
      name,
      area: place.key,
      sector: sector.code,
      type: rng.pick(sector.type),
      totalBillions,
      startYear,
      endYear: startYear + (totalBillions > 100 ? 3 : 2),
      target: stage,
      group: groupOf(totalBillions),
    };
    if (FUNDED.has(stage)) {
      national += 1;
      spec.national = String(national);
      const [shareLow, shareHigh] = dataset.funding.planShareOfTotal;
      const want = Math.max(2, Math.round(totalBillions * (shareLow + rng.next() * (shareHigh - shareLow))));
      const { lines: made, rest } = spread(want, rng.shuffle(order), room, dataset.funding.shares);
      let plan = want - rest;
      if (plan <= 0) throw new Error(`the appropriations have no room left for ${code}`);
      // The last project of the loop may only fit part of its wish: the plan is what the lines add up to.
      for (const line of made) lines.push({ project: code, appropriation: line.appropriation, billions: line.billions });
      spec.planBillions = made.reduce((sum, line) => sum + line.billions, 0);
      plan = spec.planBillions;
      spec.leader = index % 3 === 0 ? 'capApprover' : 'projectManager';
    }
    projects.push(spec);
  }
  return { projects, lines, room };
}

/** The room the appropriations of the seed layer have for the extra projects: the amounts (after the overrides) less what its own lines draw. */
export function baseRoomOf(dataset, base) {
  const room = {};
  for (const [key, billions] of Object.entries(base.appropriations)) room[key] = billions;
  for (const [key, billions] of Object.entries(dataset.funding.appropriationOverrides)) room[key] = billions;
  for (const extra of dataset.funding.extraAppropriations) room[extra.key] = extra.billions;
  for (const line of base.lines) room[line.appropriation] -= line.billions;
  return room;
}

/** The numbers the base groups of the seed layer already use (apps/web/e2e/hdsd/seed/capital-plan.ts), mirrored here so the plan can fit around them. */
export const PUBLIC_BASE = {
  appropriations: { NSTW: 120, NSDP: 180, NTM: 60, CARRY: 25, SUPPORT: 30, REVENUE: 20 },
  lines: [
    { appropriation: 'NSTW', billions: 70 },
    { appropriation: 'NSDP', billions: 20 },
    { appropriation: 'NSDP', billions: 30 },
    { appropriation: 'NSDP', billions: 8 },
    { appropriation: 'NTM', billions: 40 },
    { appropriation: 'CARRY', billions: 25 },
    { appropriation: 'SUPPORT', billions: 30 },
    { appropriation: 'NSDP', billions: 8 },
    { appropriation: 'NSDP', billions: 20 },
  ],
  projectCount: 13,
};

/** The whole plan of a dataset. */
export function buildPlan(dataset) {
  if (dataset.dataset === 'public') {
    const portfolio = buildPortfolio(dataset, baseRoomOf(dataset, PUBLIC_BASE));
    return {
      schema: 'clip-plan/1',
      dataset: dataset.dataset,
      edition: dataset.edition,
      seed: dataset.seed,
      areas: dataset.extraAreas,
      areaDecision: { symbol: dataset.texts.areaDecisionSymbol, title: dataset.texts.areaDecisionTitle },
      appropriationOverrides: dataset.funding.appropriationOverrides,
      extraAppropriations: dataset.funding.extraAppropriations,
      projects: portfolio.projects,
      lines: portfolio.lines,
      expect: summarise(dataset, portfolio),
    };
  }
  throw new Error(`no planner for the dataset ${dataset.dataset}`);
}

/** What the plan promises, in the terms `verify` can read back. */
function summarise(dataset, portfolio) {
  const stageCounts = {};
  for (const project of portfolio.projects) stageCounts[project.target] = (stageCounts[project.target] ?? 0) + 1;
  return {
    projectsTotal: PUBLIC_BASE.projectCount + portfolio.projects.length,
    extraProjects: portfolio.projects.length,
    extraStageCounts: stageCounts,
    sectors: [...new Set(portfolio.projects.map((project) => project.sector))].length,
    linesTotalBillions: portfolio.lines.reduce((sum, line) => sum + line.billions, 0),
  };
}

/** A short digest of a plan: two runs of the same dataset must print the same digest. */
export function planDigest(plan) {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 16);
}

/** Checks a plan for the faults that would only show half way through a run. Returns a list of messages (empty when sound). */
export function checkPlan(plan) {
  const problems = [];
  const codes = new Set();
  for (const project of plan.projects) {
    if (codes.has(project.code)) problems.push(`duplicate project code ${project.code}`);
    codes.add(project.code);
    if (FUNDED.has(project.target) && (project.national === undefined || project.planBillions === undefined)) problems.push(`${project.code} is funded but has no national code or plan`);
    if (project.endYear <= project.startYear) problems.push(`${project.code} ends before it starts`);
  }
  const drawn = {};
  for (const line of plan.lines) {
    if (!codes.has(line.project)) problems.push(`line for an unknown project ${line.project}`);
    drawn[line.appropriation] = (drawn[line.appropriation] ?? 0) + line.billions;
  }
  for (const [key, billions] of Object.entries(drawn)) {
    const base = PUBLIC_BASE.lines.filter((line) => line.appropriation === key).reduce((sum, line) => sum + line.billions, 0);
    const amount = plan.appropriationOverrides[key] ?? plan.extraAppropriations.find((extra) => extra.key === key)?.billions ?? PUBLIC_BASE.appropriations[key];
    if (amount === undefined || billions + base > amount) problems.push(`appropriation ${key} is over-drawn: ${billions + base} of ${amount ?? 'unknown'}`);
  }
  return problems;
}

// ---- verify -------------------------------------------------------------------------------------------------------------------------

/**
 * One check of `verify`: a name, the value read back, and the rule it must meet (`min`, `max`, `equals`, `atLeastOneOf`). `value` undefined means the
 * read did not give the figure, which always fails (a number is never invented).
 */
export function judge(check) {
  const { name, value, min, max, equals } = check;
  if (value === undefined || value === null || Number.isNaN(value)) return { name, ok: false, detail: 'no value read back' };
  if (min !== undefined && value < min) return { name, ok: false, detail: `${value} is below ${min}` };
  if (max !== undefined && value > max) return { name, ok: false, detail: `${value} is above ${max}` };
  if (equals !== undefined && value !== equals) return { name, ok: false, detail: `${value} differs from ${equals}` };
  return { name, ok: true, detail: String(value) };
}

/** Judges all the checks; `ok` is true only when every one passes. */
export function judgeAll(checks) {
  const results = checks.map(judge);
  return { ok: results.every((result) => result.ok), results };
}

// ---- command line -------------------------------------------------------------------------------------------------------------------

/** `clip-seed <command> [--flag value]...` into `{ command, flags }`; a flag without a value is `true`. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${token}`);
    const name = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) flags[name] = true;
    else {
      flags[name] = next;
      index += 1;
    }
  }
  return { command, flags };
}
