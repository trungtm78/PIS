import { addDaysTo } from './directive.ts';
import type { ProvinceFacts, ProvinceFundLine, ProvinceProjectFact, ProvinceUnitReport } from './committee-facts.ts';
import { COMMITTEE_SEED_TEXT as TEXT } from './messages/committee-texts.ts';

/**
 * A deterministic province for tests (lane BAN-1): the same `asOf` and `seed` give the same facts, so a test can name a figure. It is a generator of rows that a test writes through the real stores (or hands to the
 * pure rules directly); it is not a mode of the product and no screen has a switch for it.
 */

const SECTORS = Object.keys(TEXT.sectors) as Array<keyof typeof TEXT.sectors>;
const DISTRICTS = Object.keys(TEXT.districts) as Array<keyof typeof TEXT.districts>;
const INVESTORS = Object.keys(TEXT.investors) as Array<keyof typeof TEXT.investors>;
const FUNDS = Object.keys(TEXT.fundSources) as Array<keyof typeof TEXT.fundSources>;

export interface SeedOptions {
  seed?: number;
  projects?: number;
}

/** A small deterministic generator (the same sequence on every machine). */
function stream(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const hex = (value: number): string => value.toString(16).padStart(12, '0');
export const seedId = (kind: number, index: number): string => `00000000-0000-4000-8${kind.toString(16)}00-${hex(index)}`;

export const SEED_UNIT_IDS: readonly string[] = INVESTORS.map((_code, index) => seedId(1, index + 1));

export function seedProvinceFacts(asOf: string, options: SeedOptions = {}): ProvinceFacts {
  const next = stream(options.seed ?? 20_261_108);
  const year = Number(asOf.slice(0, 4));
  const count = options.projects ?? 48;
  const pace = Math.min(1, Math.max(0.05, (Date.parse(`${asOf}T00:00:00Z`) - Date.UTC(year, 0, 1)) / (365 * 86_400_000)));
  const projects: ProvinceProjectFact[] = [];
  const lines: ProvinceFundLine[] = [];
  for (let index = 0; index < count; index += 1) {
    const sector = SECTORS[index % SECTORS.length] as keyof typeof TEXT.sectors;
    const district = DISTRICTS[Math.floor(next() * DISTRICTS.length)] as keyof typeof TEXT.districts;
    const investor = INVESTORS[Math.floor(next() * INVESTORS.length)] as keyof typeof TEXT.investors;
    const total = (20 + Math.floor(next() * 480)) * 1_000_000_000;
    const troubled = next();
    const code = `MS-${String(index + 1).padStart(3, '0')}`;
    projects.push({
      projectId: seedId(2, index + 1),
      code,
      name: `${TEXT.projectName} ${index + 1}`,
      status: 'IMPLEMENTATION',
      investorUnitId: seedId(1, INVESTORS.indexOf(investor) + 1),
      investorName: TEXT.investors[investor],
      sectorCode: sector,
      sectorName: TEXT.sectors[sector],
      districtCode: district,
      districtName: TEXT.districts[district],
      totalInvestmentVnd: String(total),
      eacVnd: troubled > 0.9 ? String(Math.round(total * (1.06 + next() * 0.2))) : next() > 0.5 ? String(total) : null,
      delayDays: troubled > 0.75 ? 20 + Math.floor(next() * 150) : next() > 0.5 ? 0 : null,
      stalledDays: troubled < 0.12 ? 40 + Math.floor(next() * 100) : null,
      stalledStep: troubled < 0.12 ? (['TENDER', 'APPRAISAL', 'SITE_CLEARANCE'] as const)[Math.floor(next() * 3)] ?? 'TENDER' : null,
      lastReportedOn: addDaysTo(asOf, -Math.floor(next() * 12)),
    });
    const split = 1 + Math.floor(next() * 2);
    for (let part = 0; part < split; part += 1) {
      const fund = FUNDS[(index + part) % FUNDS.length] as keyof typeof TEXT.fundSources;
      const plan = Math.round((total * (0.25 + next() * 0.3)) / split / 1_000_000) * 1_000_000;
      const speed = troubled < 0.2 ? 0.25 : troubled > 0.8 ? 0.5 : 0.8 + next() * 0.4;
      const done = Math.round((plan * Math.min(1, pace * speed * (0.8 + next() * 0.4))) / 1_000_000) * 1_000_000;
      const lastYearFull = Math.round((plan * (0.7 + next() * 0.3)) / 1_000_000) * 1_000_000;
      lines.push({
        projectId: seedId(2, index + 1),
        fundSourceCode: fund,
        fundSourceName: TEXT.fundSources[fund],
        planVnd: String(plan),
        disbursedVnd: troubled > 0.97 ? null : String(done),
        lastYearSamePeriodVnd: index % 11 === 5 ? null : String(Math.round((lastYearFull * pace) / 1_000_000) * 1_000_000),
        lastYearFullYearVnd: index % 11 === 5 ? null : String(lastYearFull),
      });
    }
  }
  const units: ProvinceUnitReport[] = INVESTORS.map((code, index) => ({
    unitId: seedId(1, index + 1),
    unitName: TEXT.investors[code],
    expected: 6 + (index % 3) * 2,
    received: index === 2 ? 1 : index === 5 ? 0 : 6 + (index % 3) * 2 - (index % 2),
    lastReportedOn: index === 5 ? null : addDaysTo(asOf, index === 2 ? -30 : -(index % 6)),
  }));
  return { asOf, fiscalYear: year, projects, lines, units, feed: { basis: 'CORE_LIVE', reference: `seed:${options.seed ?? 20_261_108}`, lastDeliveredAt: `${asOf}T00:00:00.000Z` } };
}
