// One-off recorder of the golden fixture of FND-1 (docs/fnd-funding-model.md section 9).
//
// It runs the public funding code AS IT IS (packages/kernel/src/dis-snapshot.ts, dis-rates.ts, home.ts, which are unmodified since commit 71e23a06) over fixed and seeded cases and writes what that code answers
// to fnd-public-golden.json. The fixture is recorded BEFORE the figure engine exists and is never regenerated without a written reason: the test packages/kernel/test/fnd-public-golden.test.ts proves that the
// new engine in the PUBLIC pack answers exactly what is recorded here (and what the live public code answers).
//
// Run from the repository root:  node packages/kernel/test/fixtures/fnd-public-golden.record.mjs

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeTiles } from '../../src/home.ts';
import { addSums, rateOfSums } from '../../src/dis-rates.ts';
import { buildLines, groupRate, snapshotHash } from '../../src/dis-snapshot.ts';
import { KPI_HOME_DEFAULTS } from '../../src/analytics-rule-defaults.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDED_FROM = '71e23a06';
const BUCKETS = ['CURRENT_YEAR', 'CARRYOVER', 'OTHER'];
const LEVELS = ['CENTRAL', 'LOCAL'];
const ORIGINS = ['PM_ASSIGNED', 'LOCAL_ADDED', 'CARRYOVER', 'CENTRAL_SUPPORT', 'REVENUE_INCREASE'];
const M = 1_000_000n;
const mil = (n) => (BigInt(n) * M).toString();

/** A small seeded generator (mulberry32): the same seed gives the same cases on every machine. */
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const toWire = (project) => ({ ...project, previous: project.previous === null ? null : [...project.previous.entries()] });

function plan(bucket, budgetLevel, amount, origin, fundSourceVersionId = null) {
  return { bucket, budgetLevel, amountVnd: amount, origin, fundSourceVersionId };
}
function reported(bucket, budgetLevel, cumulative, ctmtqg = null, nextMonth = '0') {
  return { bucket, budgetLevel, cumulativeVnd: cumulative, ctmtqgVnd: ctmtqg, nextMonthVnd: nextMonth };
}

const base = (over) => ({ projectId: 'p', unitId: 'u', planVersionId: null, plans: [], reported: null, previous: null, treasury: [], treasuryFrom: null, ...over });
const paid = (amount, paidOn, reversal = false) => ({ amountVnd: amount, reversal, paidOn });

/** G-1 .. G-10 of the spec, then seeded random projects. */
function fixedCases() {
  return [
    {
      id: 'G-1',
      note: 'FX-DIS-004: plan given 1,000 million, added 250 million, D 600 million gives 60.0000 and 48.0000',
      cutoff: '2026-09-30',
      project: base({
        plans: [plan('CURRENT_YEAR', 'CENTRAL', mil(1000), 'PM_ASSIGNED'), plan('CURRENT_YEAR', 'LOCAL', mil(250), 'LOCAL_ADDED')],
        reported: { reportRevisionId: 'r1', cells: [reported('CURRENT_YEAR', 'CENTRAL', mil(600))] },
        treasury: [paid(mil(600), '2026-08-15')],
        treasuryFrom: '2026-01-01',
      }),
    },
    {
      id: 'G-2a',
      note: 'FX-DIS-003, first project: 50 of 100 million',
      cutoff: '2026-09-30',
      project: base({ projectId: 'g2a', plans: [plan('CURRENT_YEAR', 'CENTRAL', mil(100), 'PM_ASSIGNED')], reported: { reportRevisionId: 'x', cells: [reported('CURRENT_YEAR', 'CENTRAL', mil(50))] }, treasury: [paid(mil(50), '2026-03-01')], treasuryFrom: '2026-01-01' }),
    },
    {
      id: 'G-2b',
      note: 'FX-DIS-003, second project: 90 of 900 million',
      cutoff: '2026-09-30',
      project: base({ projectId: 'g2b', plans: [plan('CURRENT_YEAR', 'CENTRAL', mil(900), 'PM_ASSIGNED')], reported: { reportRevisionId: 'y', cells: [reported('CURRENT_YEAR', 'CENTRAL', mil(90))] }, treasury: [paid(mil(90), '2026-03-01')], treasuryFrom: '2026-01-01' }),
    },
    {
      id: 'G-3',
      note: 'no plan of either kind: ZERO_DENOMINATOR whatever else is missing',
      cutoff: '2026-09-30',
      project: base({ reported: { reportRevisionId: 'r3', cells: [reported('CURRENT_YEAR', 'CENTRAL', mil(10))] }, treasury: [paid(mil(5), '2026-03-01')], treasuryFrom: '2026-01-01' }),
    },
    {
      id: 'G-4',
      note: 'PM plan 0 and added 250 million with D 100 million: ratePmPct null, rateTotalPct 40.0000, reason ZERO_DENOMINATOR',
      cutoff: '2026-09-30',
      project: base({ plans: [plan('CURRENT_YEAR', 'LOCAL', mil(250), 'LOCAL_ADDED')], reported: { reportRevisionId: 'r4', cells: [reported('CURRENT_YEAR', 'LOCAL', mil(100))] }, treasury: [paid(mil(100), '2026-05-05')], treasuryFrom: '2026-01-01' }),
    },
    {
      id: 'G-5a',
      note: 'Treasury booked nothing, coverage NONE: TREASURY_COVERAGE_NONE',
      cutoff: '2026-09-30',
      project: base({ plans: [plan('CURRENT_YEAR', 'CENTRAL', mil(100), 'PM_ASSIGNED')], reported: { reportRevisionId: 'r5', cells: [reported('CURRENT_YEAR', 'CENTRAL', mil(10))] }, treasuryFrom: '2026-01-01' }),
    },
    {
      id: 'G-5b',
      note: 'Treasury booked something outside the window of the year: no figure in the window, still NONE',
      cutoff: '2026-09-30',
      project: base({ plans: [plan('CURRENT_YEAR', 'CENTRAL', mil(100), 'PM_ASSIGNED')], treasury: [paid(mil(20), '2025-12-31')], treasuryFrom: '2026-01-01' }),
    },
    {
      id: 'G-6',
      note: 'Treasury net below zero: NO_DATA, coverage PARTIAL',
      cutoff: '2026-09-30',
      project: base({
        plans: [plan('CURRENT_YEAR', 'CENTRAL', mil(100), 'PM_ASSIGNED')],
        reported: { reportRevisionId: 'r6', cells: [reported('CURRENT_YEAR', 'CENTRAL', mil(10))] },
        treasury: [paid(mil(30), '2026-02-02'), paid(mil(50), '2026-02-03', true)],
        treasuryFrom: '2026-01-01',
      }),
    },
    {
      id: 'G-7',
      note: 'rounding half up: 1 over 128 is 0.7813',
      cutoff: '2026-09-30',
      project: base({ plans: [plan('CURRENT_YEAR', 'CENTRAL', '128', 'PM_ASSIGNED')], reported: { reportRevisionId: 'r7', cells: [reported('CURRENT_YEAR', 'CENTRAL', '1')] }, treasury: [paid('1', '2026-02-02')], treasuryFrom: '2026-01-01' }),
    },
    {
      id: 'G-8',
      note: 'the carried-over rate is over the reported cells; the year rate over the Treasury',
      cutoff: '2026-09-30',
      project: base({
        plans: [plan('CURRENT_YEAR', 'CENTRAL', mil(400), 'PM_ASSIGNED'), plan('CARRYOVER', 'CENTRAL', mil(200), 'CARRYOVER'), plan('CARRYOVER', 'LOCAL', mil(50), 'LOCAL_ADDED')],
        reported: { reportRevisionId: 'r8', cells: [reported('CURRENT_YEAR', 'CENTRAL', mil(100)), reported('CARRYOVER', 'CENTRAL', mil(50), mil(5)), reported('CARRYOVER', 'LOCAL', mil(25))] },
        previous: new Map([['CARRYOVER/CENTRAL', mil(40)], ['CURRENT_YEAR/CENTRAL', mil(120)]]),
        treasury: [paid(mil(100), '2026-04-01')],
        treasuryFrom: '2026-01-01',
      }),
    },
    {
      id: 'G-9',
      note: 'FX-DIS-005: cutoff on 30/09, paid 30/09 counts, 01/10 does not, a refund takes off on its own day',
      cutoff: '2026-09-30',
      project: base({
        plans: [plan('CURRENT_YEAR', 'CENTRAL', mil(1000), 'PM_ASSIGNED')],
        reported: { reportRevisionId: 'r9', cells: [reported('CURRENT_YEAR', 'CENTRAL', mil(500))] },
        treasury: [paid(mil(500), '2026-09-30'), paid(mil(300), '2026-10-01'), paid(mil(100), '2026-10-01', true)],
        treasuryFrom: '2026-01-01',
      }),
    },
    {
      id: 'G-10',
      note: 'FX-DIS-001: six cells 100+200+30+70+0+20 give 420 million and CTMTQG 40 million stays out',
      cutoff: '2026-12-31',
      project: base({
        plans: BUCKETS.flatMap((bucket) => LEVELS.map((level) => plan(bucket, level, mil(500), bucket === 'CURRENT_YEAR' ? 'PM_ASSIGNED' : 'CARRYOVER'))),
        reported: {
          reportRevisionId: 'r10',
          cells: [reported('CURRENT_YEAR', 'CENTRAL', mil(100), mil(10)), reported('CURRENT_YEAR', 'LOCAL', mil(200), mil(20)), reported('CARRYOVER', 'CENTRAL', mil(30), mil(5)), reported('CARRYOVER', 'LOCAL', mil(70), mil(5)), reported('OTHER', 'CENTRAL', '0'), reported('OTHER', 'LOCAL', mil(20))],
        },
        treasury: [paid(mil(410), '2026-11-30')],
        treasuryFrom: '2026-01-01',
      }),
    },
    {
      id: 'G-11',
      note: 'a cell nobody reported is null; a fall against the earlier period is kept as a fall; a plan cell with no origin counts on the PM side',
      cutoff: '2026-06-30',
      project: base({
        planVersionId: 'pv-11',
        plans: [plan('CURRENT_YEAR', 'CENTRAL', mil(10), null, 'fs-1'), plan('OTHER', 'LOCAL', mil(5), 'REVENUE_INCREASE', 'fs-2')],
        reported: { reportRevisionId: 'r11', cells: [reported('CURRENT_YEAR', 'CENTRAL', mil(7))] },
        previous: new Map([['CURRENT_YEAR/CENTRAL', mil(9)]]),
        treasury: [paid(mil(7), '2026-06-15')],
        treasuryFrom: '2026-01-01',
      }),
    },
  ];
}

function randomCase(index, random) {
  const pick = (n) => Math.floor(random() * n);
  const wholeAmount = (n) => BigInt(n).toString();
  const plans = [];
  for (const bucket of BUCKETS) {
    for (const level of LEVELS) {
      const lines = pick(3);
      for (let i = 0; i < lines; i += 1) plans.push(plan(bucket, level, wholeAmount(BigInt(pick(2000)) * M + BigInt(pick(1_000_000))), random() < 0.1 ? null : ORIGINS[pick(ORIGINS.length)], random() < 0.3 ? `fs-${pick(3)}` : null));
    }
  }
  const cells = [];
  for (const bucket of BUCKETS) {
    for (const level of LEVELS) {
      if (random() < 0.35) continue;
      const cumulative = BigInt(pick(1500)) * M + BigInt(pick(1_000_000));
      cells.push(reported(bucket, level, cumulative.toString(), bucket !== 'OTHER' && random() < 0.3 ? (cumulative / 4n).toString() : null, wholeAmount(BigInt(pick(100)) * M)));
    }
  }
  const treasury = [];
  const count = pick(5);
  for (let i = 0; i < count; i += 1) {
    const month = String(1 + pick(12)).padStart(2, '0');
    const day = String(1 + pick(28)).padStart(2, '0');
    treasury.push(paid(wholeAmount(BigInt(pick(900)) * M + BigInt(pick(1000))), `2026-${month}-${day}`, random() < 0.2));
  }
  const previous = random() < 0.6 ? new Map(cells.filter(() => random() < 0.7).map((cell) => [`${cell.bucket}/${cell.budgetLevel}`, (BigInt(cell.cumulativeVnd) - BigInt(pick(300)) * M).toString()])) : null;
  return {
    id: `R-${String(index).padStart(2, '0')}`,
    note: 'seeded random project',
    cutoff: `2026-${String(1 + pick(12)).padStart(2, '0')}-${String(1 + pick(28)).padStart(2, '0')}`,
    project: base({ projectId: `p-${index}`, unitId: `u-${pick(4)}`, planVersionId: random() < 0.8 ? `pv-${index}` : null, plans, reported: cells.length === 0 && random() < 0.5 ? null : { reportRevisionId: `rr-${index}`, cells }, previous, treasury, treasuryFrom: random() < 0.8 ? '2026-01-01' : null }),
  };
}

function groupCase(id, note, lineSets) {
  // The sums of a group are what the database adds up over the lines of a basis (dis-snapshot-store.ts, `sums`): reproduced here from the recorded lines.
  const parts = (basis) =>
    lineSets.map((one) => {
      const own = one.lines.filter((line) => line.bucket === basis);
      const sum = (key) => own.reduce((total, line) => total + BigInt(line[key]), 0n);
      const known = (key) => {
        const values = own.filter((line) => line[key] !== null);
        return values.length === 0 ? null : values.reduce((total, line) => total + BigInt(line[key]), 0n).toString();
      };
      return { projects: own.length === 0 ? 0 : 1, planPmVnd: sum('planPmAssignedVnd').toString(), planLocalVnd: sum('planLocalAddedVnd').toString(), treasuryVnd: known('disbursedTreasuryVnd'), reportedVnd: known('disbursedReportedVnd'), ctmtqgVnd: known('ctmtqgSubsetVnd'), allNone: own.every((line) => line.treasuryCoverage === 'NONE'), allComplete: own.length > 0 && own.every((line) => line.treasuryCoverage === 'COMPLETE') };
    });
  const result = {};
  for (const basis of ['CURRENT_YEAR', 'CARRYOVER']) {
    const sums = addSums(parts(basis));
    const figures = rateOfSums(sums, basis);
    result[basis] = { sums, figures, tiles: homeTiles(figures, 'PROPOSED_PENDING_SIGNOFF') };
  }
  return { id, note, projects: lineSets.map((one) => one.projectId), result };
}

// Every fixed case is its own project (the default id would make them one).
const cases = fixedCases().map((one) => ({ ...one, project: { ...one.project, projectId: one.project.projectId === 'p' ? `p-${one.id}` : one.project.projectId } }));
const random = generator(20261108);
for (let index = 1; index <= 40; index += 1) cases.push(randomCase(index, random));

const recorded = cases.map((one) => {
  const lines = buildLines(one.project, one.cutoff);
  return { id: one.id, note: one.note, cutoff: one.cutoff, project: toWire(one.project), lines };
});

const groups = [];
groups.push(groupCase('G-2', 'FX-DIS-003: 50/100 and 90/900 million group to 14.0000 (sum over sum, not the mean)', recorded.filter((one) => one.id === 'G-2a' || one.id === 'G-2b').map((one) => ({ projectId: one.project.projectId, lines: one.lines }))));
groups.push(groupCase('G-ALL', 'every recorded project as one group (HOME-01 and HOME-03 over the whole tenant)', recorded.map((one) => ({ projectId: one.project.projectId, lines: one.lines }))));
groups.push(groupCase('G-FIRST-TEN', 'the first ten random projects as one group', recorded.slice(11, 21).map((one) => ({ projectId: one.project.projectId, lines: one.lines }))));
groups.push(groupCase('G-EMPTY', 'a group with no project: no rate, coverage NONE', []));

const header = { periodId: 'period-1', snapshotKind: 'PERIOD_CLOSE', asOfDate: '2026-09-30', treasuryCutoffDate: '2026-09-30', metricSetVersion: 'DIS-METRICS-R1-PROPOSED', definitionStatus: 'PROPOSED_PENDING_SIGNOFF' };
const hashes = [
  { id: 'H-G1', header, lines: recorded.filter((one) => one.id === 'G-1').flatMap((one) => one.lines.map((line) => ({ ...line, projectId: one.project.projectId, unitId: one.project.unitId }))) },
  { id: 'H-MIXED', header, lines: recorded.slice(0, 14).flatMap((one) => one.lines.map((line) => ({ ...line, projectId: one.project.projectId, unitId: one.project.unitId }))) },
].map((one) => ({ ...one, hash: snapshotHash(one.header, one.lines) }));

const groupRates = [
  { id: 'GR-1', parts: [{ numeratorVnd: '50', denominatorVnd: '100' }, { numeratorVnd: '90', denominatorVnd: '900' }], rate: groupRate([{ numeratorVnd: '50', denominatorVnd: '100' }, { numeratorVnd: '90', denominatorVnd: '900' }]) },
  { id: 'GR-2', parts: [{ numeratorVnd: '0', denominatorVnd: '0' }], rate: groupRate([{ numeratorVnd: '0', denominatorVnd: '0' }]) },
  { id: 'GR-3', parts: [], rate: groupRate([]) },
];

// The two definitions of the command centre (HOME-01, HOME-03): their text is part of what must not change.
const kpiDefinitions = Object.fromEntries(['DISBURSEMENT_RATE_PM', 'DISBURSEMENT_RATE_TOTAL'].map((code) => [code, KPI_HOME_DEFAULTS[code]]));

writeFileSync(join(HERE, 'fnd-public-golden.json'), `${JSON.stringify({ recordedFrom: RECORDED_FROM, cases: recorded, groups, hashes, groupRates, kpiDefinitions }, null, 2)}\n`);
process.stdout.write(`recorded ${recorded.length} projects, ${groups.length} groups, ${hashes.length} hashes
`);
