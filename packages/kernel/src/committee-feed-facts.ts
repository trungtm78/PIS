import type { ProvinceFacts, ProvinceFundLine, ProvinceProjectFact, ProvinceUnitReport } from './committee-facts.ts';
import type { FeedProjectFact } from './finance-feed-facts.ts';
import { FEED_DISTRICTS, FEED_FUND_NAMES, FEED_SECTORS } from './messages/finance-feed-texts.ts';

/**
 * The link between the feed of the Finance Department app (FEED-1) and the committee workspace (BAN-1). The workspace reads a `ProvinceFacts`; its usual source is the latest frozen
 * snapshot of the Disbursement module. Where no snapshot exists yet the province is not blind: the folded facts of the feed (plan and disbursement by project and fund, the investor,
 * sector and district the feed names) are turned into the same contract here, by a pure function. A project the feed maps to one of ours takes our id, name, status, investor and
 * total; a project we do not know keeps a stable id made from its feed code (the caller makes it) and the figures the feed states. Money is whole dong text (the feed counts hundredths).
 * Unknown stays unknown: no estimate at completion, no delay and no stalled step are invented, and the figures of the year before are not stated by the feed.
 */

export interface OurProjectRef {
  id: string;
  name: string;
  status: string;
  investorUnitId: string;
  investorName: string;
  totalInvestmentVnd: string;
}

export interface FeedToFactsInput {
  facts: readonly FeedProjectFact[];
  /** Our projects by code (the code the feed maps to). */
  ours: ReadonlyMap<string, OurProjectRef>;
  /** The day the workspace is asked for. */
  asOf: string;
  fiscalYear: number;
  /** What the figures were taken from, for the note of the workspace (for example the fiscal year of the feed). */
  reference: string;
  lastDeliveredAt: string | null;
  /** A stable identifier for something the feed names and we do not have (the same text gives the same id). */
  idOf: (key: string) => string;
}

const wholeDong = (hundredths: bigint): string => (hundredths / 100n).toString();
const nameOf = (list: ReadonlyArray<{ code: string; name: string }>, code: string): string => list.find((entry) => entry.code === code)?.name ?? code;

export function feedFactsToProvinceFacts(input: FeedToFactsInput): ProvinceFacts {
  const known = input.facts.filter((fact) => fact.known);
  const newest = known.reduce((day, fact) => (fact.asOf !== null && fact.asOf > day ? fact.asOf : day), '');
  const latestMonth = known.reduce((month, fact) => Math.max(month, fact.latestMonth), 0);
  const projects: ProvinceProjectFact[] = [];
  const lines: ProvinceFundLine[] = [];
  const units = new Map<string, { name: string; expected: number; received: number; last: string | null }>();
  for (const fact of known) {
    const own = fact.ourProjectCode === null ? undefined : input.ours.get(fact.ourProjectCode);
    const projectId = own?.id ?? input.idOf(`feed-project:${fact.feedProjectCode}`);
    const funds = [...new Set([...Object.keys(fact.planByFund), ...Object.keys(fact.disbursedByFund)])].sort();
    const plan = Object.values(fact.planByFund).reduce((sum, value) => sum + value, 0n);
    const unitId = own?.investorUnitId ?? input.idOf(`feed-investor:${fact.investorCode}`);
    const unitName = own?.investorName ?? fact.investorName ?? fact.investorCode;
    projects.push({
      projectId,
      code: fact.ourProjectCode ?? fact.feedProjectCode,
      name: own?.name ?? fact.projectName ?? fact.feedProjectCode,
      status: own?.status ?? fact.projectStatus,
      investorUnitId: unitId,
      investorName: unitName,
      sectorCode: fact.sectorCode,
      sectorName: nameOf(FEED_SECTORS, fact.sectorCode),
      districtCode: fact.districtCode,
      districtName: nameOf(FEED_DISTRICTS, fact.districtCode),
      totalInvestmentVnd: own?.totalInvestmentVnd ?? wholeDong(plan),
      eacVnd: null,
      delayDays: null,
      stalledDays: null,
      stalledStep: null,
      lastReportedOn: fact.latestMonth > 0 ? fact.asOf : null,
    });
    for (const fund of funds) {
      lines.push({
        projectId,
        fundSourceCode: fund,
        fundSourceName: FEED_FUND_NAMES[fund] ?? fund,
        planVnd: wholeDong(fact.planByFund[fund] ?? 0n),
        // A figure stated for THIS fund is a figure; a fund the feed stated nothing about stays unknown, even when another fund of the project reported (never a measured zero).
        disbursedVnd: fact.disbursedByFund[fund] === undefined ? null : wholeDong(fact.disbursedByFund[fund]),
        lastYearSamePeriodVnd: null,
        lastYearFullYearVnd: null,
      });
    }
    const unit = units.get(unitId) ?? { name: unitName, expected: 0, received: 0, last: null };
    unit.expected += 1;
    // A unit has reported on a project when the feed states the latest month the whole feed reached.
    if (latestMonth > 0 && fact.latestMonth >= latestMonth) unit.received += 1;
    if (fact.latestMonth > 0 && fact.asOf !== null && (unit.last === null || fact.asOf > unit.last)) unit.last = fact.asOf;
    units.set(unitId, unit);
  }
  const unitReports: ProvinceUnitReport[] = [...units.entries()].map(([unitId, one]) => ({ unitId, unitName: one.name, expected: one.expected, received: one.received, lastReportedOn: one.last }));
  const cutoff = newest === '' || newest > input.asOf ? input.asOf : newest;
  return {
    asOf: cutoff,
    evaluatedOn: input.asOf,
    fiscalYear: input.fiscalYear,
    projects,
    lines,
    units: unitReports,
    feed: { basis: 'CORE_LIVE', reference: input.reference, lastDeliveredAt: input.lastDeliveredAt },
  };
}
