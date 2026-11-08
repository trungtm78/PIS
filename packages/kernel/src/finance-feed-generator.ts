import { DomainError } from './errors.ts';
import { FEED_FUND_CODES, feedRecordOf } from './finance-feed-model.ts';
import type { FeedDisbursementRecord, FeedMilestoneRecord, FeedPlanRecord, FeedProjectRecord, FeedRecord } from './finance-feed-model.ts';
import { FEED_DISTRICTS, FEED_DISTRICT_INVESTOR_NAME, FEED_INVESTORS_PROVINCE, FEED_SECTORS, FEED_TEXT } from './messages/finance-feed-texts.ts';

/**
 * The data generator of the feed of the Finance Department (lane FEED-1): a producer of realistic records for a whole province of projects by sector, district and investor, with the annual plan by fund,
 * the monthly disbursement on a seasonal curve, projects that are late and projects that are ahead, units that report late or not at all, a few disagreements inside the data, cumulative figures and the
 * milestones of the contracts and the procurement. It is DETERMINISTIC: the same parameters give the same records byte for byte (a test proves it), it reads nothing and calls nothing. Its records are
 * judged by the layouts of the files (`validateFeedRecords`) and go through the same pipeline as a file.
 *
 * It is also STABLE ACROSS MONTHS: the figures of a month are a function of the seed alone, never of how far the data runs, so a run of the month after (a tick) repeats every record of the months before and adds
 * only what is new (the new month, and the catch-up reports of the units that were silent). Every random choice comes from a generator seeded by the seed and the thing it is about.
 */

export interface FeedAnchor {
  /** The code of one of our own projects: the generated project carries it as `our_project_code` so that the exact mapping and the reconciliation can be shown. */
  code: string;
  name: string;
  plan: string;
  /** The figure the generated cumulative disbursement is made to equal (before a deliberate disagreement), or null to leave the generated one. */
  disbursed: string | null;
  /** The month the figure is as of (1 to 12); the month the generator was started in when absent. A tick keeps it, so the earlier months never change. */
  month?: number | undefined;
}

export interface FeedGeneratorParams {
  seed: number;
  fiscalYear: number;
  /** The generated data runs up to the end of this month (1 to 12). */
  currentMonth: number;
  projectCount: number;
  /** How many investors report late or not at all in each month. */
  lateUnits: number;
  delayedPct: number;
  aheadPct: number;
  /** How many disagreements are planted inside the data (cumulative off, over the plan, restated). */
  discrepancies: number;
  anchors?: readonly FeedAnchor[];
}

export const FEED_GENERATOR_DEFAULTS = { seed: 57, projectCount: 120, lateUnits: 3, delayedPct: 22, aheadPct: 12, discrepancies: 6 } as const;
export const FEED_GENERATOR_LIMITS = { projectCount: [10, 1000], lateUnits: [0, 20], delayedPct: [0, 80], aheadPct: [0, 50], discrepancies: [0, 100] } as const;
/** How many of our own projects the generator may be anchored on. */
export const FEED_ANCHOR_LIMIT = 50;

/** The seasonal curve of the public investment disbursement of a year: slow after the new year holiday, heavy in the last months. The shares of the twelve months add up to one. */
export const FEED_SEASONAL_WEIGHTS: readonly number[] = [0.02, 0.03, 0.06, 0.065, 0.07, 0.08, 0.08, 0.08, 0.09, 0.11, 0.13, 0.185];
/** The cumulative share of the year at the end of each month. */
export const FEED_SEASONAL_CUMULATIVE: readonly number[] = FEED_SEASONAL_WEIGHTS.reduce<number[]>((all, weight) => [...all, Math.round(((all[all.length - 1] ?? 0) + weight) * 1e6) / 1e6], []);

/** The days after the end of a month by which a unit must have reported (the default of the rule; the generator reports on time within it, and a late unit after it). */
export const FEED_GEN_DUE_DAYS = 5;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The parameters of a request as numbers in their limits; what is missing takes its default (the year and the month from `today`, the previous month being the one that is reported). 422 `VALIDATION_FAILED` naming the field. */
export function feedGeneratorParamsOf(body: Readonly<Record<string, unknown>>, today: string): FeedGeneratorParams {
  const integer = (value: unknown, field: string, fallback: number, min: number, max: number): number => {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field);
    return value;
  };
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const defaultYear = month === 1 ? year - 1 : year;
  const defaultMonth = month === 1 ? 12 : month - 1;
  const params: FeedGeneratorParams = {
    seed: integer(body.seed, 'seed', FEED_GENERATOR_DEFAULTS.seed, 0, 2_147_483_647),
    fiscalYear: integer(body.fiscal_year, 'fiscal_year', defaultYear, 2000, 2100),
    currentMonth: integer(body.current_month, 'current_month', defaultMonth, 1, 12),
    projectCount: integer(body.project_count, 'project_count', FEED_GENERATOR_DEFAULTS.projectCount, FEED_GENERATOR_LIMITS.projectCount[0], FEED_GENERATOR_LIMITS.projectCount[1]),
    lateUnits: integer(body.late_units, 'late_units', FEED_GENERATOR_DEFAULTS.lateUnits, FEED_GENERATOR_LIMITS.lateUnits[0], FEED_GENERATOR_LIMITS.lateUnits[1]),
    delayedPct: integer(body.delayed_pct, 'delayed_pct', FEED_GENERATOR_DEFAULTS.delayedPct, FEED_GENERATOR_LIMITS.delayedPct[0], FEED_GENERATOR_LIMITS.delayedPct[1]),
    aheadPct: integer(body.ahead_pct, 'ahead_pct', FEED_GENERATOR_DEFAULTS.aheadPct, FEED_GENERATOR_LIMITS.aheadPct[0], FEED_GENERATOR_LIMITS.aheadPct[1]),
    discrepancies: integer(body.discrepancies, 'discrepancies', FEED_GENERATOR_DEFAULTS.discrepancies, FEED_GENERATOR_LIMITS.discrepancies[0], FEED_GENERATOR_LIMITS.discrepancies[1]),
  };
  if (params.delayedPct + params.aheadPct > 90) throw invalid('ahead_pct');
  return params;
}

/** The parameters as the snake case object the screen and the stored row use (the anchors are kept beside them by the store). */
export function feedGeneratorParamsJson(params: FeedGeneratorParams): Record<string, number> {
  return { seed: params.seed, fiscal_year: params.fiscalYear, current_month: params.currentMonth, project_count: params.projectCount, late_units: params.lateUnits, delayed_pct: params.delayedPct, ahead_pct: params.aheadPct, discrepancies: params.discrepancies };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The generator.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Mulberry32: a small generator with a 32-bit state; the same seed gives the same sequence on every machine. */
function generatorOf(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a text: turns the seed and the thing a choice is about into the seed of its own generator. */
function hashOf(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const sub = (seed: number, ...parts: Array<string | number>): (() => number) => generatorOf(hashOf(`${seed}|${parts.join('|')}`));

const pad2 = (value: number): string => String(value).padStart(2, '0');
const dayText = (date: Date): string => `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
const addDays = (day: string, days: number): string => dayText(new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000));
const monthEnd = (year: number, month: number): string => dayText(new Date(Date.UTC(year, month, 0)));
/** Rounds an amount to a whole million dong (the unit the figures of a report are kept in). */
const million = (value: number): number => Math.round(value / 1_000_000) * 1_000_000;
const text = (value: number): string => String(value);

type Profile = 'DELAYED' | 'AHEAD' | 'NORMAL';

interface Investor {
  code: string;
  name: string;
  sector: string | null;
  district: string | null;
}

/** The investors of the province: the units of the sectors and a project management board for each district. */
export function feedGeneratorInvestors(): Investor[] {
  return [
    ...FEED_INVESTORS_PROVINCE.map((investor) => ({ code: investor.code, name: investor.name, sector: investor.sector, district: null })),
    ...FEED_DISTRICTS.map((district) => ({ code: `CDT-BQL-${district.code}`, name: FEED_DISTRICT_INVESTOR_NAME.replace('{district}', district.name), sector: null, district: district.code })),
  ];
}

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.min(items.length - 1, Math.floor(random() * items.length))] as T;

function sectorOf(random: () => number): (typeof FEED_SECTORS)[number] {
  const total = FEED_SECTORS.reduce((sum, sector) => sum + sector.weight, 0);
  let point = random() * total;
  for (const sector of FEED_SECTORS) {
    point -= sector.weight;
    if (point < 0) return sector;
  }
  return FEED_SECTORS[0] as (typeof FEED_SECTORS)[number];
}

interface FundSeries {
  fund: string;
  plan: number;
  /** Cumulative disbursement at the end of each month 1..12 (index 0 is January). */
  cumulative: number[];
}

/** The units that do not report on time in a month: half do not report at all (until a later catch-up), half report after the due day. */
function lateUnitsOf(seed: number, month: number, count: number, investors: readonly Investor[]): { silent: Set<string>; tardy: Set<string> } {
  const random = sub(seed, 'late', month);
  const order = investors.map((investor) => ({ code: investor.code, key: random() })).sort((a, b) => a.key - b.key).map((one) => one.code).slice(0, Math.min(count, investors.length));
  return { silent: new Set(order.filter((_code, index) => index % 2 === 0)), tardy: new Set(order.filter((_code, index) => index % 2 === 1)) };
}

/**
 * The whole province as typed records. The kinds come in this order for each project (PROJECT, PLAN, DISBURSEMENT, MILESTONE), then the restatements. No two records share a business key.
 * A unit that is silent in the latest month has no row for it; in a later run it has one, reported late (the catch-up). A unit that is tardy reports after the due day.
 */
export function generateFeedRecords(params: FeedGeneratorParams): FeedRecord[] {
  const { seed, fiscalYear: year, currentMonth: last } = params;
  const simToday = addDays(monthEnd(year, last), 7);
  const projectAsOf = `${year}-01-10`;
  const planAsOf = `${year}-01-20`;
  const investors = feedGeneratorInvestors();
  const districtBoards = investors.filter((investor) => investor.district !== null);
  const lateByMonth = Array.from({ length: 12 }, (_none, index) => lateUnitsOf(seed, index + 1, params.lateUnits, investors));

  /** The day a unit reported a month, or undefined while it has not (silent in the latest month). */
  const reportedOn = (unit: string, month: number): string | undefined => {
    const end = monthEnd(year, month);
    const late = lateByMonth[month - 1] as { silent: Set<string>; tardy: Set<string> };
    const random = sub(seed, 'lag', unit, month);
    if (late.silent.has(unit)) return month === last ? undefined : addDays(end, FEED_GEN_DUE_DAYS + 4 + Math.floor(random() * 8));
    if (late.tardy.has(unit)) return addDays(end, FEED_GEN_DUE_DAYS + 1 + Math.floor(random() * 2));
    return addDays(end, 1 + Math.floor(random() * FEED_GEN_DUE_DAYS));
  };

  // The planted disagreements: where each goes is chosen from the seed alone, and one only takes effect once its month has been reached.
  const slots = Array.from({ length: params.discrepancies }, (_none, slot) => {
    const random = sub(seed, 'plant', slot);
    const projectIndex = Math.floor(random() * params.projectCount);
    const month = 1 + Math.floor(random() * 12);
    const kind = slot % 3 === 1 && month < 6 ? 0 : slot % 3;
    return { projectIndex, month, kind };
  });

  const records: FeedRecord[] = [];
  const restatements: FeedRecord[] = [];
  const anchors = params.anchors ?? [];

  for (let index = 0; index < params.projectCount; index += 1) {
    const anchor = anchors[index];
    const random = sub(seed, 'project', index);
    const sector = sectorOf(random);
    const district = pick(random, FEED_DISTRICTS);
    const provincial = FEED_INVESTORS_PROVINCE.filter((investor) => investor.sector === sector.code);
    const useProvincial = random() < 0.5 && provincial.length > 0;
    const chosen = pick(random, provincial.length > 0 ? provincial : FEED_INVESTORS_PROVINCE);
    const investor: Investor = useProvincial ? { code: chosen.code, name: chosen.name, sector: chosen.sector, district: null } : (districtBoards.find((board) => board.district === district.code) as Investor);
    const code = `DA-${sector.code}-${String(year).slice(2)}-${String(index + 1).padStart(3, '0')}`;
    const unitRoll = random();
    const profile: Profile = unitRoll < params.delayedPct / 100 ? 'DELAYED' : unitRoll < (params.delayedPct + params.aheadPct) / 100 ? 'AHEAD' : 'NORMAL';
    const factor = profile === 'DELAYED' ? 0.3 + random() * 0.4 : profile === 'AHEAD' ? 1.2 + random() * 0.35 : 0.88 + random() * 0.22;
    const noun = pick(random, sector.nouns);
    const name = anchor?.name ?? `${noun} ${district.name} ${FEED_TEXT.number_word} ${String(index + 1).padStart(3, '0')}`;
    const generatedPlan = million(10_000_000_000 + random() ** 2.2 * 490_000_000_000);
    const planTotal = anchor === undefined ? generatedPlan : Math.round(Number(anchor.plan));
    const startYear = year - Math.floor(random() * 4);
    const endYear = year + Math.floor(random() * 4);
    const investment = million(planTotal * (2.5 + random() * 5.5));

    const project: FeedProjectRecord = {
      feedProjectCode: code,
      asOf: projectAsOf,
      projectName: name,
      sectorCode: sector.code,
      districtCode: district.code,
      investorCode: investor.code,
      investorName: investor.name,
      totalInvestment: text(investment),
      startYear,
      endYear,
      projectStatus: 'ACTIVE',
      ourProjectCode: anchor?.code ?? null,
    };
    records.push(feedRecordOf('PROJECT', project));

    // The funds: one fund for most, two or three for the large projects.
    const fundRoll = random();
    const fundCount = fundRoll < 0.6 ? 1 : fundRoll < 0.9 ? 2 : 3;
    const first = investor.district === null && random() < 0.7 ? 'NSTW' : 'NSDP';
    const others = FEED_FUND_CODES.filter((fund) => fund !== first && fund !== 'OTHER');
    const funds = [first, ...[...others].map((fund) => ({ fund, key: random() })).sort((a, b) => a.key - b.key).slice(0, fundCount - 1).map((one) => one.fund)];
    const shares = funds.map(() => 0.4 + random());
    const shareTotal = shares.reduce((sum, share) => sum + share, 0);
    const series: FundSeries[] = funds.map((fund, position) => ({ fund, plan: position === funds.length - 1 ? 0 : million((planTotal * (shares[position] as number)) / shareTotal), cumulative: [] }));
    const allocated = series.reduce((sum, one) => sum + one.plan, 0);
    (series[series.length - 1] as FundSeries).plan = Math.max(1_000_000, planTotal - allocated);

    series.forEach((one, position) => {
      let previous = 0;
      for (let month = 1; month <= 12; month += 1) {
        const noise = 1 + (sub(seed, 'noise', index, position, month)() - 0.5) * 0.3;
        const target = Math.min(one.plan, million(one.plan * (FEED_SEASONAL_CUMULATIVE[month - 1] as number) * factor * noise));
        previous = Math.max(previous, target);
        one.cumulative.push(previous);
      }
    });

    // An anchored project is made to equal our figure (as of the month it was anchored); one in four is then deliberately off by a few percent so that the reconciliation has something to find.
    if (anchor !== undefined && anchor.disbursed !== null) {
      const at = (anchor.month ?? last) - 1;
      const latest = series.reduce((sum, one) => sum + (one.cumulative[at] as number), 0);
      const wanted = Number(anchor.disbursed) * (index % 4 === 3 ? 1.06 : 1);
      if (latest > 0) {
        for (const one of series) {
          let previous = 0;
          one.cumulative = one.cumulative.map((value) => {
            previous = Math.max(previous, Math.min(one.plan, Math.round((value * wanted) / latest)));
            return previous;
          });
        }
      }
    }

    for (const [position, one] of series.entries()) {
      const plan: FeedPlanRecord = { feedProjectCode: code, fiscalYear: year, fundCode: one.fund, planAmount: text(one.plan), asOf: planAsOf, decisionNo: `QD-${year}-${String(index + 1).padStart(3, '0')}` };
      records.push(feedRecordOf('PLAN', plan));
      // From July a tenth of the plans are adjusted: a later statement of the same plan.
      if (last >= 7 && sub(seed, 'adjust', index, position)() < 0.1) {
        const adjusted: FeedPlanRecord = { ...plan, planAmount: text(Math.max(1_000_000, million(one.plan * (0.9 + sub(seed, 'adjusted', index, position)() * 0.2)))), asOf: `${year}-06-30` };
        restatements.push(feedRecordOf('PLAN', adjusted));
      }
    }

    const target = series[0] as FundSeries;
    const planted = slots.filter((slot) => slot.projectIndex === index && slot.month <= last);
    for (const one of series) {
      for (let month = 1; month <= last; month += 1) {
        const reported = reportedOn(investor.code, month);
        if (reported === undefined) continue;
        const cumulative = one.cumulative[month - 1] as number;
        const before = month === 1 ? 0 : (one.cumulative[month - 2] as number);
        let row: FeedDisbursementRecord = { feedProjectCode: code, fiscalYear: year, month, fundCode: one.fund, disbursedMonth: text(cumulative - before), disbursedCumulative: text(cumulative), reportedOn: reported, asOf: reported };
        for (const slot of planted) {
          if (slot.month !== month || one !== target) continue;
          if (slot.kind === 0) row = { ...row, disbursedCumulative: text(cumulative + Math.max(1_000_000, million(one.plan * 0.05))) };
          else if (slot.kind === 1) row = { ...row, disbursedMonth: text(cumulative - before + Math.max(1_000_000, million(one.plan * 0.04))), disbursedCumulative: text(million(one.plan * 1.03)) };
          else if (reported <= addDays(monthEnd(year, month), FEED_GEN_DUE_DAYS)) {
            // The month is stated again, later, with other figures.
            const shift = Math.max(1_000_000, million((cumulative - before) * 0.12));
            const again = addDays(monthEnd(year, month), FEED_GEN_DUE_DAYS + 1);
            restatements.push(feedRecordOf('DISBURSEMENT', { ...row, disbursedMonth: text(cumulative - before + shift), disbursedCumulative: text(cumulative + shift), reportedOn: again, asOf: again }));
          }
        }
        records.push(feedRecordOf('DISBURSEMENT', row));
      }
    }

    // The milestones of the procurement and the contract: a delayed project is late on them.
    const spread = profile === 'DELAYED' ? [30, 90] : profile === 'AHEAD' ? [-20, 0] : [-5, 10];
    const milestoneRandom = sub(seed, 'milestone', index);
    let planned = addDays(`${year}-01-20`, Math.floor(milestoneRandom() * 60));
    const steps: Array<[string, number]> = [['PACKAGE_PUBLISHED', 0], ['PACKAGE_AWARDED', 45], ['CONTRACT_SIGNED', 20], ['SITE_HANDOVER', 15]];
    for (const [kind, gap] of steps) {
      planned = addDays(planned, gap);
      const lateBy = Math.round((spread[0] as number) + milestoneRandom() * ((spread[1] as number) - (spread[0] as number)));
      const actual = addDays(planned, lateBy);
      const contract = million(planTotal * (0.85 + milestoneRandom() * 0.12));
      const milestone: FeedMilestoneRecord = {
        feedProjectCode: code,
        milestoneKind: kind,
        packageCode: `PK-${code}-01`,
        plannedOn: planned,
        actualOn: actual <= simToday ? actual : null,
        contractValue: kind === 'CONTRACT_SIGNED' ? text(contract) : null,
        asOf: simToday,
      };
      records.push(feedRecordOf('MILESTONE', milestone));
    }
    if (endYear === year) {
      const finished = series.reduce((sum, one) => sum + (one.cumulative[last - 1] as number), 0) >= planTotal * 0.98;
      const acceptance: FeedMilestoneRecord = { feedProjectCode: code, milestoneKind: 'ACCEPTANCE', packageCode: null, plannedOn: `${year}-11-30`, actualOn: finished && `${year}-11-30` <= simToday ? `${year}-11-30` : null, contractValue: null, asOf: simToday };
      records.push(feedRecordOf('MILESTONE', acceptance));
    }
  }
  return [...records, ...restatements];
}
