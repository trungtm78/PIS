import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KPI_HOME_DEFAULTS } from '../src/analytics-rule-defaults.ts';
import { addSums, rateOfSums } from '../src/dis-rates.ts';
import { buildLines, groupRate, snapshotHash } from '../src/dis-snapshot.ts';
import type { SnapshotProject } from '../src/dis-snapshot.ts';
import { fundingRatioOf } from '../src/index.ts';
import { addPublicSums, buildPackLines, publicIndicatorsOf, publicRateFigures, publicRateSums } from '../src/fnd-public.ts';
import type { PublicLine, PublicProject } from '../src/fnd-public.ts';
import { snapshotHashFor } from '../src/fnd-snapshot.ts';
import { builtInPack } from '../src/fnd-taxonomy.ts';
import { homeTiles } from '../src/home.ts';

/**
 * The golden test of FND-1 (docs/fnd-funding-model.md section 9): the public edition does not change. The fixture was recorded from the public code BEFORE the figure engine existed (the recorder sits beside it) and the
 * engine of the PUBLIC pack must answer exactly what was recorded, which is also what the live public code answers. The two ratios of HOME-01 and HOME-03, the DIS snapshot rates, the hash and the text of the two
 * definitions are compared tile by tile and field by field.
 */

interface WireProject extends Omit<PublicProject, 'previous'> {
  previous: Array<[string, string]> | null;
}
interface Fixture {
  recordedFrom: string;
  cases: Array<{ id: string; note: string; cutoff: string; project: WireProject; lines: PublicLine[] }>;
  groups: Array<{ id: string; note: string; projects: string[]; result: Record<string, { sums: unknown; figures: unknown; tiles: unknown }> }>;
  hashes: Array<{ id: string; header: Parameters<typeof snapshotHash>[0]; lines: Parameters<typeof snapshotHash>[1]; hash: string }>;
  groupRates: Array<{ id: string; parts: Array<{ numeratorVnd: string; denominatorVnd: string }>; rate: string | null }>;
  kpiDefinitions: Record<string, { params: Record<string, unknown>; unverified: boolean }>;
}

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'fnd-public-golden.json'), 'utf8')) as Fixture;
const PACK = builtInPack('PUBLIC');
const projectOf = (wire: WireProject): PublicProject => ({ ...wire, previous: wire.previous === null ? null : new Map(wire.previous) });
const asLive = (project: PublicProject): SnapshotProject => project as unknown as SnapshotProject;
const STATUS = 'PROPOSED_PENDING_SIGNOFF';

describe('the public pack through the figure engine is the public edition as it was (FND-1 section 9)', () => {
  it('was recorded from the public code of commit 71e23a06 and holds the cases G-1 to G-11 and the seeded projects', () => {
    expect(fixture.recordedFrom).toBe('71e23a06');
    expect(fixture.cases.length).toBeGreaterThanOrEqual(50);
    for (const id of ['G-1', 'G-3', 'G-4', 'G-5a', 'G-6', 'G-7', 'G-8', 'G-9', 'G-10']) expect(fixture.cases.some((one) => one.id === id)).toBe(true);
  });

  it('1. engine equality: every line of every fixture project is what was recorded and what buildLines answers now, field by field', () => {
    for (const one of fixture.cases) {
      const project = projectOf(one.project);
      const lines = buildPackLines(PACK, project, one.cutoff);
      expect({ id: one.id, lines }).toEqual({ id: one.id, lines: one.lines });
      expect({ id: one.id, lines }).toEqual({ id: one.id, lines: buildLines(asLive(project), one.cutoff) });
    }
  });

  it('G-1 (FX-DIS-004): plan 1,000 million, added 250 million, D 600 million gives 60.0000 and 48.0000; G-4: no PM plan gives ZERO_DENOMINATOR with the total rate 40.0000', () => {
    const one = fixture.cases.find((entry) => entry.id === 'G-1');
    const carrier = buildPackLines(PACK, projectOf((one as Fixture['cases'][number]).project), '2026-09-30').find((line) => line.bucket === 'CURRENT_YEAR' && line.budgetLevel === 'CENTRAL');
    expect(carrier).toMatchObject({ ratePmPct: '60.0000', rateTotalPct: '48.0000', rateNullReason: null, treasuryCoverage: 'COMPLETE' });
    const four = fixture.cases.find((entry) => entry.id === 'G-4');
    const none = buildPackLines(PACK, projectOf((four as Fixture['cases'][number]).project), '2026-09-30').find((line) => line.bucket === 'CURRENT_YEAR' && line.budgetLevel === 'CENTRAL');
    expect(none).toMatchObject({ ratePmPct: null, rateTotalPct: '40.0000', rateNullReason: 'ZERO_DENOMINATOR' });
  });

  it('G-3, G-5, G-6, G-7: no plan is ZERO_DENOMINATOR whatever else is missing; nothing booked is TREASURY_COVERAGE_NONE; a negative net is NO_DATA; 1 over 128 is 0.7813', () => {
    const carrierOf = (id: string): PublicLine => {
      const one = fixture.cases.find((entry) => entry.id === id) as Fixture['cases'][number];
      return buildPackLines(PACK, projectOf(one.project), one.cutoff).find((line) => line.bucket === 'CURRENT_YEAR' && line.budgetLevel === 'CENTRAL') as PublicLine;
    };
    expect(carrierOf('G-3')).toMatchObject({ ratePmPct: null, rateTotalPct: null, rateNullReason: 'ZERO_DENOMINATOR' });
    expect(carrierOf('G-5a')).toMatchObject({ rateNullReason: 'TREASURY_COVERAGE_NONE', treasuryCoverage: 'NONE' });
    expect(carrierOf('G-6')).toMatchObject({ rateNullReason: 'NO_DATA', treasuryCoverage: 'PARTIAL' });
    expect(carrierOf('G-7')).toMatchObject({ ratePmPct: '0.7813' });
  });

  it('2. the two ratios of HOME-01 and HOME-03 (DISBURSEMENT_RATE_PM, DISBURSEMENT_RATE_TOTAL) are identical on every group, tile by tile, through the engine sums', () => {
    const byProject = new Map(fixture.cases.map((one) => [one.project.projectId, one.lines.map((line) => ({ ...line, projectId: one.project.projectId }))]));
    for (const group of fixture.groups) {
      for (const basis of ['CURRENT_YEAR', 'CARRYOVER'] as const) {
        const parts = group.projects.map((id) => publicRateSums(byProject.get(id) ?? [], basis));
        const sums = addPublicSums(parts);
        const figures = publicRateFigures(PACK, sums, basis);
        const recorded = group.result[basis] as { sums: unknown; figures: unknown; tiles: unknown };
        expect({ group: group.id, basis, sums }).toEqual({ group: group.id, basis, sums: recorded.sums });
        expect({ group: group.id, basis, figures }).toEqual({ group: group.id, basis, figures: recorded.figures });
        expect({ group: group.id, basis, figures }).toEqual({ group: group.id, basis, figures: rateOfSums(addSums(parts), basis) });
        expect({ group: group.id, basis, tiles: homeTiles(figures, STATUS) }).toEqual({ group: group.id, basis, tiles: recorded.tiles });
      }
    }
  });

  it('the pack ratios RATE_PM, RATE_TOTAL and RATE_CARRYOVER carry the same numbers as the figures of the group, with their numerator and denominator', () => {
    const lines = fixture.cases.flatMap((one) => one.lines.map((line) => ({ ...line, projectId: one.project.projectId })));
    const all = fixture.groups.find((group) => group.id === 'G-ALL') as Fixture['groups'][number];
    const year = all.result['CURRENT_YEAR'] as { figures: { ratePmPct: string | null; rateTotalPct: string | null; numeratorVnd: string | null; planPmVnd: string; planTotalVnd: string } };
    const found = publicIndicatorsOf(PACK, lines);
    expect(found.map((one) => one.code)).toEqual(['RATE_PM', 'RATE_TOTAL', 'RATE_CARRYOVER']);
    expect(found[0]).toMatchObject({ ratePct: year.figures.ratePmPct, numeratorVnd: year.figures.numeratorVnd, denominatorVnd: year.figures.planPmVnd, basis: 'TREASURY' });
    expect(found[1]).toMatchObject({ ratePct: year.figures.rateTotalPct, denominatorVnd: year.figures.planTotalVnd });
    expect(found[2]?.basis).toBe('REPORTED');
  });

  it('the formula text of the two KPI definitions of HOME-01 and HOME-03 is exactly what was recorded', () => {
    for (const code of ['DISBURSEMENT_RATE_PM', 'DISBURSEMENT_RATE_TOTAL']) {
      const live = KPI_HOME_DEFAULTS[code];
      const recorded = fixture.kpiDefinitions[code];
      expect(live).toBeDefined();
      expect(recorded).toBeDefined();
      expect(live).toEqual(recorded);
    }
  });

  it('3. hash equality: hash schema 1 of the recorded snapshots is the recorded hash (and snapshotHash); hash schema 2 of the same lines hashes differently', () => {
    for (const one of fixture.hashes) {
      expect(snapshotHashFor(1, one.header, one.lines as never)).toBe(one.hash);
      expect(snapshotHash(one.header, one.lines)).toBe(one.hash);
      const two = snapshotHashFor(2, one.header, one.lines as never, { taxonomyPack: 'PUBLIC', taxonomyVersion: 1, actualsPrecedence: 'TREASURY_HEADLINE', figures: [] });
      expect(two).not.toBe(one.hash);
      expect(two).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('BR-DIS-04: the rate of a group is the sum of the numerators over the sum of the denominators, never the mean of the rates (recorded GR-1 to GR-3)', () => {
    for (const one of fixture.groupRates) {
      expect(groupRate(one.parts)).toBe(one.rate);
      const numerator = one.parts.reduce((total, part) => total + BigInt(part.numeratorVnd), 0n).toString();
      const denominator = one.parts.reduce((total, part) => total + BigInt(part.denominatorVnd), 0n).toString();
      expect(fundingRatioOf(numerator, denominator).ratePct).toBe(one.rate);
    }
    expect(fundingRatioOf('50', '100').ratePct).toBe('50.0000');
  });
});

// A seeded generator of projects that never uses the fixture: a property test of the two implementations.
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('4. property: the engine and the public code agree on random projects, cells, plans and cutoffs (seeded)', () => {
  const BUCKETS = ['CURRENT_YEAR', 'CARRYOVER', 'OTHER'];
  const LEVELS = ['CENTRAL', 'LOCAL'];
  const ORIGINS = ['PM_ASSIGNED', 'LOCAL_ADDED', 'CARRYOVER', 'CENTRAL_SUPPORT', 'REVENUE_INCREASE', null];
  const random = generator(987654321);
  const pick = (n: number): number => Math.floor(random() * n);
  const money = (): string => (BigInt(pick(3000)) * 1_000_000n + BigInt(pick(1_000_000))).toString();

  const make = (index: number): PublicProject => {
    const plans = BUCKETS.flatMap((bucket) => LEVELS.flatMap((level) => Array.from({ length: pick(3) }, () => ({ bucket, budgetLevel: level, amountVnd: random() < 0.1 ? '0' : money(), origin: ORIGINS[pick(ORIGINS.length)] ?? null, fundSourceVersionId: random() < 0.3 ? `fs-${pick(4)}` : null }))));
    const cells = BUCKETS.flatMap((bucket) => LEVELS.filter(() => random() > 0.4).map((level) => ({ bucket, budgetLevel: level, cumulativeVnd: money(), ctmtqgVnd: bucket !== 'OTHER' && random() < 0.3 ? '1000' : null, nextMonthVnd: money() })));
    const treasury = Array.from({ length: pick(6) }, () => ({ amountVnd: money(), reversal: random() < 0.2, paidOn: `2026-${String(1 + pick(12)).padStart(2, '0')}-${String(1 + pick(28)).padStart(2, '0')}` }));
    return {
      projectId: `rp-${index}`,
      unitId: `ru-${pick(3)}`,
      planVersionId: random() < 0.7 ? `pv-${index}` : null,
      plans,
      reported: cells.length === 0 && random() < 0.5 ? null : { reportRevisionId: `rr-${index}`, cells },
      previous: random() < 0.5 ? new Map(cells.filter(() => random() < 0.6).map((cell) => [`${cell.bucket}/${cell.budgetLevel}`, money()])) : null,
      treasury,
      treasuryFrom: random() < 0.8 ? '2026-01-01' : null,
    };
  };

  it('returns the same lines as buildLines for 300 random projects', () => {
    for (let index = 0; index < 300; index += 1) {
      const project = make(index);
      const cutoff = `2026-${String(1 + pick(12)).padStart(2, '0')}-${String(1 + pick(28)).padStart(2, '0')}`;
      expect(buildPackLines(PACK, project, cutoff)).toEqual(buildLines(asLive(project), cutoff));
    }
  });

  it('returns the same group figures as rateOfSums for random groups, and the group rate is never the mean of the rates', () => {
    for (let round = 0; round < 60; round += 1) {
      const projects = Array.from({ length: 1 + pick(6) }, (_unused, index) => make(round * 10 + index));
      const lines = projects.flatMap((project) => buildPackLines(PACK, project, '2026-09-30').map((line) => ({ ...line, projectId: project.projectId })));
      for (const basis of ['CURRENT_YEAR', 'CARRYOVER'] as const) {
        const sums = addPublicSums(projects.map((project) => publicRateSums(lines.filter((line) => line.projectId === project.projectId), basis)));
        const live = rateOfSums(addSums(projects.map((project) => publicRateSums(lines.filter((line) => line.projectId === project.projectId), basis))), basis);
        expect(publicRateFigures(PACK, sums, basis)).toEqual(live);
        if (live.numeratorVnd !== null && BigInt(live.planPmVnd) > 0n && BigInt(live.numeratorVnd) >= 0n) {
          expect(live.ratePmPct).toBe(fundingRatioOf(live.numeratorVnd, live.planPmVnd).ratePct);
        }
      }
    }
  });
});
