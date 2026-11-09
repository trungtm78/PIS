// Pure planning of the clip datasets: a dataset fixture (scripts/fixtures/clip-data/<name>.json) plus its seed give one deterministic plan.
// The plan is plain data. The seed groups of apps/web/e2e/hdsd/seed/clip read it and call the real commands of the product; `verify` checks the
// readings of the real read operations against the expectations of the dataset. Nothing here touches the network or the clock.

import { createHash } from 'node:crypto';

export const DATASETS = ['public', 'enterprise'];

/** The groups of the enterprise dataset, in order: portfolio, capital of the year (lines for the packages), funding, directives, accounting file, report forms, documents, procurement, contracts, process tree, disbursement, the frozen enterprise snapshot, BI. */
export const ENTERPRISE_GROUPS = ['clip-ent-projects', 'clip-ent-capital', 'clip-ent-funding', 'clip-ent-directives', 'clip-ent-ebs', 'clip-ent-reports', 'clip-ent-documents', 'clip-ent-procurement', 'clip-ent-contracts', 'clip-ent-workflow', 'clip-ent-disbursement', 'clip-ent-snapshot', 'clip-ent-bi'];

/** The groups of the seed layer each dataset runs, in order (the registry of apps/web/e2e/hdsd/seed/index.ts keeps the order of dependencies). */
export const DATASET_GROUPS = {
  public: ['base', 'capital', 'clip-public-documents', 'clip-public-procurement', 'clip-public-contracts', 'clip-public-payments', 'clip-public-workflow', 'clip-public-alerts', 'clip-public-egp', 'clip-public-disbursement', 'clip-public-feed', 'clip-public-bi', 'clip-public-directives', 'clip-public-committee', 'clip-public-extras'],
  enterprise: ENTERPRISE_GROUPS,
};

/**
 * The phases of an apply: the clock of the stack is set to `clockDays` (relative to the real day) before the groups of the phase run. The clip data of the public
 * dataset is made in the past (the packages enter their steps, the plan is published) and the clock is then brought back, so steps and clocks really are late.
 * A stack that has no clock route ignores the offset.
 */
/** The clocks (days from the real day) at which the workflows of the packages are driven; the plan gives each package one of them. */
export const PAYMENT_SEND_CLOCK = -40;
export const WORKFLOW_CLOCKS = [-70, -45, -25, -12, -6, -3, -1];

export const DATASET_PHASES = {
  public: [
    // The capital plan is published in the past, so the snapshots of the closed months find the plan in force.
    { clockDays: -80, groups: ['base', 'capital'] },
    { clockDays: 0, groups: ['clip-public-documents', 'clip-public-procurement', 'clip-public-contracts'] },
    // The payments are sent in the past (the payment clock and the recovery of the advance then run out), and the Treasury confirms the first one on the real day.
    { clockDays: PAYMENT_SEND_CLOCK, groups: ['clip-public-payments'], env: { CLIP_PAY_STAGE: 'SEND' } },
    ...WORKFLOW_CLOCKS.map((clockDays) => ({ clockDays, groups: ['clip-public-workflow'], env: { CLIP_WORKFLOW_CLOCK: String(clockDays) } })),
    { clockDays: 0, groups: ['clip-public-payments'], env: { CLIP_PAY_STAGE: 'CLOSE' } },
    { clockDays: 0, groups: ['clip-public-alerts', 'clip-public-egp', 'clip-public-disbursement', 'clip-public-feed', 'clip-public-bi', 'clip-public-directives', 'clip-public-committee', 'clip-public-extras'] },
  ],
  enterprise: [
    { clockDays: 0, groups: ['clip-ent-projects', 'clip-ent-capital', 'clip-ent-funding', 'clip-ent-directives', 'clip-ent-ebs', 'clip-ent-reports', 'clip-ent-documents', 'clip-ent-procurement', 'clip-ent-contracts'] },
    // The package workflows are driven at seven clocks (each package has its own), so the process tree shows late steps beside the ones on time.
    ...WORKFLOW_CLOCKS.map((clockDays) => ({ clockDays, groups: ['clip-ent-workflow'], env: { CLIP_WORKFLOW_CLOCK: String(clockDays) } })),
    { clockDays: 0, groups: ['clip-ent-disbursement', 'clip-ent-snapshot', 'clip-ent-bi'] },
  ],
};

/** The phases cut down to the groups asked for (all when none is asked), dropping the empty ones. */
export function phasesFor(dataset, groups) {
  const wanted = groups === undefined ? undefined : new Set(groups);
  return DATASET_PHASES[dataset].map((phase) => ({ clockDays: phase.clockDays, env: phase.env, groups: phase.groups.filter((group) => wanted === undefined || wanted.has(group)) })).filter((phase) => phase.groups.length > 0);
}

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

/**
 * The procurement plans of the first funded projects of the portfolio (stage in implementation or budgeted): each with its packages (budgets inside the biggest line of
 * capital of the project) and the step of the package workflow the clip wants it to stand at, so the process tree shows a spread of states.
 */
export function buildProcurement(dataset, projects, lines) {
  const config = dataset.procurement;
  const rng = createRng(streamSeed(dataset.seed, 'procurement'));
  const targets = rng.shuffle(config.workflowTargets);
  const clocks = rng.shuffle(config.workflowClockDays ?? [0]);
  const chosen = projects.filter((project) => project.target === 'IMPLEMENTATION' || project.target === 'BUDGETED').slice(0, config.projectsWithPlans);
  let counter = 0;
  return chosen.map((project) => {
    const own = lines.filter((line) => line.project === project.code).sort((a, b) => b.billions - a.billions);
    const room = Math.floor((own[0]?.billions ?? 0) * 1000 * 0.8);
    return {
      project: project.code,
      title: config.planTitle.replace('{project}', project.name),
      packages: config.packages.map((template) => {
        const target = targets[counter % targets.length];
        counter += 1;
        return {
          code: `${project.code.replace('DA-', '')}-${template.suffix}`,
          title: template.title.replace('{project}', project.name),
          millions: Math.max(50, Math.floor(room * template.share)),
          method: template.method,
          category: template.category,
          period: template.period,
          days: template.days,
          target,
          // The clock of the stack (days from the real day) at which the workflow of this package is driven: steps entered long ago are late now.
          clockDays: clocks[(counter - 1) % clocks.length],
        };
      }),
    };
  });
}

/**
 * The statement of the Treasury: for each project that is under way (or done, or stopped) two to four payments in the months up to the last closed month,
 * adding up to a share of its plan of the year that differs from project to project (some are far behind, some ahead), so the rates, the ranking and the
 * warnings of the leader's screens have a spread to show.
 */
export function buildDisbursement(dataset, projects) {
  const config = dataset.disbursement;
  const rng = createRng(streamSeed(dataset.seed, 'disbursement'));
  const rows = [];
  const shares = {};
  for (const project of projects.filter((item) => config.projectStages.includes(item.target) && item.planBillions !== undefined)) {
    const rate = rng.int(config.rateRange[0], config.rateRange[1]);
    const total = Math.max(1, Math.round((project.planBillions * 1000 * rate) / 100));
    const count = rng.int(config.paymentsPerProject[0], config.paymentsPerProject[1]);
    shares[project.code] = rate;
    let left = total;
    for (let index = 0; index < count; index += 1) {
      const millions = index === count - 1 ? left : Math.max(1, Math.floor(left / (count - index)));
      left -= millions;
      const month = rng.int(2, config.lastMonth);
      const day = rng.int(3, 26);
      rows.push({ project: project.code, no: `KB-${project.code.replace('DA-', '')}-${index + 1}`, date: `${config.fiscalYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, millions });
    }
  }
  return { office: config.office, decision: config.decision, reason: config.reason, fiscalYear: config.fiscalYear, lastMonth: config.lastMonth, rows, shares };
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

/**
 * The enterprise portfolio: investment and equipment-purchase projects, each with a year plan split into equity and loan, and the file of the accounting
 * system that the reconciliation reads (some figures differ on purpose, so the differences have something to say).
 */
export function buildEnterprise(dataset) {
  const rng = createRng(streamSeed(dataset.seed, 'enterprise'));
  const projects = [];
  let number = 100;
  for (const [kind, config] of Object.entries(dataset.kinds)) {
    const templates = rng.shuffle(config.templates);
    for (let index = 0; index < dataset.projectsPerKind; index += 1) {
      number += rng.int(3, 17);
      const [low, high] = config.sizeBillions;
      const totalBillions = rng.int(low, high);
      const planBillions = Math.max(4, Math.round(totalBillions * (0.25 + rng.next() * 0.25)));
      const [shareLow, shareHigh] = dataset.funding.equitySharePercent;
      const equityBillions = Math.max(1, Math.round((planBillions * rng.int(shareLow, shareHigh)) / 100));
      projects.push({
        code: `DA-PM${kind === 'INVESTMENT' ? 'DT' : 'TB'}${number}`,
        name: templates[index % templates.length].replace('{n}', `(${index + 1})`),
        kind,
        area: rng.pick(dataset.areas).key,
        sector: config.sector,
        type: config.type,
        totalBillions,
        startYear: dataset.planYear,
        endYear: dataset.planYear + (kind === 'INVESTMENT' ? 3 : 1),
        target: 'CONCEPT',
        group: groupOf(totalBillions),
        planBillions,
        equityBillions,
        loanBillions: planBillions - equityBillions,
      });
    }
  }
  const [diffLow, diffHigh] = dataset.ebs.differencePercent;
  const ebsRows = [];
  for (const period of dataset.ebs.periods) {
    for (const project of projects.slice(0, dataset.ebs.projectsInFile)) {
      const disbursed = Math.max(1, Math.round((project.planBillions * 1000) * (0.08 + rng.next() * 0.1)));
      ebsRows.push({ project: project.code, period, disbursedMillions: disbursed + Math.round((disbursed * rng.int(diffLow, diffHigh)) / 100), committedMillions: Math.round(project.totalBillions * 1000 * 0.4) });
    }
  }
  // The stages come last: the accounting file is made from the year plans of all the projects.
  assignStages(dataset, projects);
  return { projects, ebsRows };
}

/**
 * The stage each enterprise project is taken to (the dataset gives the stages of the projects of a kind in order): the funded ones get a national code and
 * the capital of the year they were planned with, the others stay at the stage the list says.
 */
export function assignStages(dataset, projects) {
  const stages = dataset.stagesPerKind ?? [];
  let national = 7_893_000;
  const seen = {};
  for (const project of projects) {
    const index = seen[project.kind] ?? 0;
    seen[project.kind] = index + 1;
    project.target = stages[index] ?? 'CONCEPT';
    project.leader = index % 3 === 0 ? 'capApprover' : 'projectManager';
    if (FUNDED.has(project.target)) {
      national += 1;
      project.national = String(national);
    } else {
      delete project.planBillions;
    }
  }
}

/** The class of the enterprise pack (EQUITY, LOAN, OTHER) a line drawn on the appropriation falls in: the register refuses a line of a bucket the pack does not list. */
function bucketOf(dataset, key) {
  const item = dataset.capital.appropriations.find((one) => one.key === key);
  if (item === undefined || typeof item.bucket !== 'string') throw new Error(`the appropriation ${key} of the enterprise dataset names no bucket`);
  return item.bucket;
}

/** The appropriations and lines of capital of the enterprise plan: equity and loan, each wide enough for the lines drawn on it. */
export function buildEnterpriseCapital(dataset, projects) {
  const funded = projects.filter((project) => FUNDED.has(project.target) && project.planBillions !== undefined);
  const lines = [];
  for (const project of funded) {
    lines.push({ project: project.code, appropriation: 'VCSH', billions: project.equityBillions, bucket: bucketOf(dataset, 'VCSH') });
    lines.push({ project: project.code, appropriation: 'VAY', billions: project.loanBillions, bucket: bucketOf(dataset, 'VAY') });
  }
  const sum = (key) => lines.filter((line) => line.appropriation === key).reduce((total, line) => total + line.billions, 0);
  const appropriations = dataset.capital.appropriations.map((item) => ({ ...item, billions: sum(item.key) + dataset.capital.margin }));
  return { lines, appropriations };
}

/**
 * The tenders of the enterprise plan (shape of the PLANS of the guide seed): the first projects of each kind carry the packages of the templates, each sized as a
 * share of the line of capital it draws on; a bidder number is a contractor of the table. Budgets never pass the line (checked by the tests).
 */
export function buildEnterpriseTenders(dataset, projects, lines) {
  const out = [];
  for (const spec of dataset.tenders) {
    const picked = projects.filter((project) => project.kind === spec.kind && FUNDED.has(project.target)).slice(0, spec.projects);
    for (const project of picked) {
      const own = lines.filter((line) => line.project === project.code).sort((a, b) => b.billions - a.billions);
      const code = project.code.replace('DA-', '');
      out.push({
        project: project.code,
        title: spec.planTitle.replace('{project}', project.name),
        fate: 'APPROVED',
        packages: spec.packages.map((template) => {
          const room = (own[template.line]?.billions ?? own[0].billions) * 1000;
          const millions = Math.max(50, Math.floor(room * template.share));
          return {
            code: `${code}-${template.suffix}`,
            title: template.title.replace('{project}', project.name),
            millions,
            method: template.method,
            line: template.line,
            period: template.period,
            days: template.days,
            category: template.category,
            fate: template.fate,
            ...(template.bidders === undefined ? {} : { bidders: template.bidders }),
            ...(template.awardShare === undefined ? {} : { awardMillions: Math.floor(millions * template.awardShare) }),
            ...(template.contract === undefined ? {} : { contract: template.contract }),
            ...(template.awardedDaysAgo === undefined ? {} : { awardedDaysAgo: template.awardedDaysAgo }),
          };
        }),
      });
    }
  }
  return out;
}

/** The enterprise packages that go through the process tree: the funded projects without tenders, with the workflow targets of the dataset spread over them. */
export function buildEnterpriseWorkflow(dataset, projects, lines, tenderProjects) {
  const config = dataset.procurement;
  const rng = createRng(streamSeed(dataset.seed, 'enterprise-procurement'));
  const targets = rng.shuffle(config.workflowTargets);
  const clocks = rng.shuffle(config.workflowClockDays);
  const taken = new Set(tenderProjects);
  const chosen = projects.filter((project) => FUNDED.has(project.target) && !taken.has(project.code) && project.planBillions !== undefined);
  let counter = 0;
  return chosen.map((project) => {
    const own = lines.filter((line) => line.project === project.code).sort((a, b) => b.billions - a.billions);
    const room = Math.floor((own[0]?.billions ?? 0) * 1000 * 0.8);
    return {
      project: project.code,
      title: config.planTitle.replace('{project}', project.name),
      packages: config.packages.map((template) => {
        const target = targets[counter % targets.length];
        counter += 1;
        return {
          code: `${project.code.replace('DA-', '')}-${template.suffix}`,
          title: template.title.replace('{project}', project.name),
          millions: Math.max(50, Math.floor(room * template.share)),
          method: template.method,
          category: template.category,
          period: template.period,
          days: template.days,
          target,
          clockDays: clocks[(counter - 1) % clocks.length],
        };
      }),
    };
  });
}

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
      texts: dataset.texts,
      egp: dataset.egp,
      payments: dataset.payments,
      bi: dataset.bi,
      alerts: dataset.alerts,
      meetings: dataset.meetings,
      disbursement: buildDisbursement(dataset, portfolio.projects),
      committee: dataset.committee,
      procurement: { legalBasis: dataset.procurement.legalBasis, note: dataset.procurement.note, decisionLetter: dataset.procurement.decisionLetter, plans: buildProcurement(dataset, portfolio.projects, portfolio.lines) },
      expect: summarise(dataset, portfolio),
    };
  }
  if (dataset.dataset === 'enterprise') {
    const built = buildEnterprise(dataset);
    const capital = buildEnterpriseCapital(dataset, built.projects);
    const tenders = buildEnterpriseTenders(dataset, built.projects, capital.lines);
    const workflowPlans = buildEnterpriseWorkflow(dataset, built.projects, capital.lines, tenders.map((plan) => plan.project));
    return {
      schema: 'clip-plan/1',
      dataset: dataset.dataset,
      edition: dataset.edition,
      seed: dataset.seed,
      planYear: dataset.planYear,
      areas: dataset.areas,
      areaDecision: dataset.areaDecision,
      decisionType: dataset.decisionType,
      projects: built.projects,
      funding: dataset.funding,
      meetings: dataset.meetings,
      reports: dataset.reports,
      ebs: { note: dataset.ebs.layoutNote, rows: built.ebsRows },
      texts: dataset.texts,
      capital: { appropriations: capital.appropriations, lines: capital.lines, planTitle: dataset.capital.planTitle, decision: dataset.capital.decision },
      contractors: dataset.contractors,
      tenders,
      procurement: { legalBasis: dataset.procurement.legalBasis, note: dataset.procurement.note, decisionLetter: dataset.procurement.decisionLetter, plans: workflowPlans },
      bi: dataset.bi,
      disbursement: buildDisbursement(dataset, built.projects),
      expect: {
        packages: tenders.reduce((sum, plan) => sum + plan.packages.length, 0) + workflowPlans.reduce((sum, plan) => sum + plan.packages.length, 0),
        contractors: dataset.contractors.length,
        dashboards: dataset.bi.dashboards.length,
        fundedProjects: built.projects.filter((project) => FUNDED.has(project.target)).length,
        projectsTotal: built.projects.length,
        fundingBatches: built.projects.length * 2,
        directives: dataset.meetings.reduce((sum, meeting) => sum + meeting.directives.length, 0),
        ebsRows: built.ebsRows.length,
        reportIssues: dataset.reports.reports.length,
      },
    };
  }
  throw new Error(`no planner for the dataset ${dataset.dataset}`);
}

/** What the plan promises, in the terms `verify` can read back. */
function summarise(dataset, portfolio) {
  const packages = buildProcurement(dataset, portfolio.projects, portfolio.lines).reduce((sum, plan) => sum + plan.packages.length, 0);
  const stageCounts = {};
  for (const project of portfolio.projects) stageCounts[project.target] = (stageCounts[project.target] ?? 0) + 1;
  return {
    projectsTotal: PUBLIC_BASE.projectCount + portfolio.projects.length,
    extraProjects: portfolio.projects.length,
    extraStageCounts: stageCounts,
    sectors: [...new Set(portfolio.projects.map((project) => project.sector))].length,
    packages,
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
  if (plan.dataset !== 'public') return problems;
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
  // A verdict over no check proves nothing: it fails.
  return { ok: results.length > 0 && results.every((result) => result.ok), results };
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
