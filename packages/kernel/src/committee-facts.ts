/**
 * The facts the committee workspace stands on (lane BAN-1, docs/committee-workspace.md): the contract of the port `ProvinceFactsReader` that the real core tables (and the feed of the Finance Department app that lane FEED-1
 * writes into the same core) implement. Money is whole dong written as decimal text. Unknown is never zero: a number the source does not have is null. The provenance of a record is kept by the core for audit and is not
 * part of this contract: a figure of the workspace is a figure of the core.
 */

export interface ProvinceProjectFact {
  projectId: string;
  code: string;
  name: string;
  status: string;
  /** The unit that implements the project: the unit whose report is expected. */
  investorUnitId: string;
  investorName: string;
  sectorCode: string;
  sectorName: string;
  districtCode: string;
  districtName: string;
  totalInvestmentVnd: string;
  /** The forecast cost at completion, or null when nobody forecast it. */
  eacVnd: string | null;
  /** Days past the planned finish of the baseline in force (0 or more), or null when there is no baseline or the project is not under way. */
  delayDays: number | null;
  /** Days an open step of the procurement or other procedure has been without activity, or null when none is open. */
  stalledDays: number | null;
  stalledStep: string | null;
  /** The day the unit last reported on this project, or null when it never did. */
  lastReportedOn: string | null;
}

export interface ProvinceFundLine {
  projectId: string;
  fundSourceCode: string;
  fundSourceName: string;
  planVnd: string;
  /** What was disbursed this year up to the day, or null when the source holds no figure (not the same as zero). */
  disbursedVnd: string | null;
  /** What was disbursed by the same day of the year before, or null when the source cannot say. */
  lastYearSamePeriodVnd: string | null;
  /** What was disbursed in the whole of the year before, or null. */
  lastYearFullYearVnd: string | null;
}

export interface ProvinceUnitReport {
  unitId: string;
  unitName: string;
  /** How many reports the unit owes for the current period, and how many arrived. */
  expected: number;
  received: number;
  lastReportedOn: string | null;
}

export interface FeedNote {
  /** What the figures stand on: the latest frozen snapshot of the Disbursement module, or the live core tables on the day. */
  basis: 'DIS_SNAPSHOT' | 'CORE_LIVE';
  /** The reference of the batch or snapshot the figures were taken from, or null. */
  reference: string | null;
  /** When the feed last delivered, or null when it never did. */
  lastDeliveredAt: string | null;
}

export interface ProvinceFacts {
  /** The financial cut-off: the day of the snapshot the amounts stand on. */
  asOf: string;
  /** The day the operational facts (the age of reports) are judged on, when it is later than the cut-off; the cut-off itself when absent. */
  evaluatedOn?: string | undefined;
  fiscalYear: number;
  projects: readonly ProvinceProjectFact[];
  lines: readonly ProvinceFundLine[];
  units: readonly ProvinceUnitReport[];
  feed: FeedNote;
}

/** The port a source of the committee facts implements. The tenant and the transaction belong to the adapter (the database one takes a `TenantTx`); the kernel only fixes the shape of the answer. */
export interface ProvinceFactsRequest {
  asOf: string;
}

export interface FeedStatus extends FeedNote {
  /** The source holds no record at all. */
  empty: boolean;
  projects: number;
  lines: number;
}

export function feedStatusOf(facts: ProvinceFacts): FeedStatus {
  return { ...facts.feed, empty: facts.projects.length === 0 && facts.lines.length === 0, projects: facts.projects.length, lines: facts.lines.length };
}

/** The check a feed implementation must pass: ids unique, every line names a known project, money is whole dong text. The port refuses a batch that fails it rather than show a wrong figure. */
export function factsDefects(facts: ProvinceFacts): string[] {
  const defects: string[] = [];
  const ids = new Set<string>();
  const money = /^(0|[1-9]\d{0,23})$/;
  for (const project of facts.projects) {
    if (ids.has(project.projectId)) defects.push(`duplicate project ${project.projectId}`);
    ids.add(project.projectId);
    if (!money.test(project.totalInvestmentVnd)) defects.push(`project ${project.code} total investment`);
    if (project.eacVnd !== null && !money.test(project.eacVnd)) defects.push(`project ${project.code} estimate at completion`);
  }
  const cells = new Set<string>();
  for (const line of facts.lines) {
    if (!ids.has(line.projectId)) defects.push(`line of an unknown project ${line.projectId}`);
    const cell = `${line.projectId}|${line.fundSourceCode}`;
    if (cells.has(cell)) defects.push(`duplicate line ${cell}`);
    cells.add(cell);
    for (const value of [line.planVnd, line.disbursedVnd, line.lastYearSamePeriodVnd, line.lastYearFullYearVnd]) if (value !== null && !money.test(value)) defects.push(`line ${cell} money`);
  }
  for (const unit of facts.units) {
    if (unit.received > unit.expected || unit.expected < 0 || unit.received < 0) defects.push(`unit ${unit.unitId} reports`);
  }
  return defects;
}
