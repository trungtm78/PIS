import { DomainError } from './errors.ts';

/** The names, the typed records and the keys of the finance feed (lane FEED-1): shared by the adapters, the generator and the reader. Pure, no network. */

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Names.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The entry of the connection ledger (BID-22 shows its sibling `egp.muasamcong`). */
export const FEED_CONNECTOR_CODE = 'fin.sotaichinh';
/** The source system written on the rows of `master_crosswalk` for a project code of the feed. */
export const FEED_SOURCE_SYSTEM = 'FIN_SOTAICHINH';
export const FEED_EXTERNAL_TYPE = 'FIN_PROJECT';
export const FEED_LAYOUT_VERSION = 'WORKING-ASSUMPTION-FIN-2026.1';
export const FEED_LAYOUT_VERSIONS: readonly string[] = [FEED_LAYOUT_VERSION];
export const FEED_MAX_ROWS = 5000;
export const FEED_API_UNAVAILABLE_CODE = 'FEED_API_UNAVAILABLE';
/** The channel a record came in by (internal provenance, for audit and replay): a file a person handed over, a push of the Finance application, or the data generator. */
export const FEED_CHANNELS = ['FILE', 'API_PUSH', 'GENERATOR'] as const;
export type FeedChannel = (typeof FEED_CHANNELS)[number];
export const FEED_KINDS = ['PROJECT', 'PLAN', 'DISBURSEMENT', 'MILESTONE'] as const;
export type FeedKind = (typeof FEED_KINDS)[number];
export const FEED_FUND_CODES = ['NSTW', 'NSDP', 'ODA', 'TPCP', 'CTMTQG', 'OTHER'] as const;
export type FeedFundCode = (typeof FEED_FUND_CODES)[number];
export const FEED_MILESTONE_KINDS = ['PACKAGE_PUBLISHED', 'PACKAGE_AWARDED', 'CONTRACT_SIGNED', 'SITE_HANDOVER', 'ACCEPTANCE', 'SETTLEMENT'] as const;
export type FeedMilestoneKind = (typeof FEED_MILESTONE_KINDS)[number];
export const FEED_PROJECT_STATUSES = ['ACTIVE', 'SUSPENDED', 'COMPLETED', 'CANCELLED'] as const;

/** The connector code of the file import framework for each kind (the position of the connection). */
export const FEED_POSITIONS: Readonly<Record<FeedKind, string>> = {
  PROJECT: 'FIN_PROJECT_FILE',
  PLAN: 'FIN_PLAN_FILE',
  DISBURSEMENT: 'FIN_DISBURSEMENT_FILE',
  MILESTONE: 'FIN_MILESTONE_FILE',
};

export const isFeedKind = (value: unknown): value is FeedKind => typeof value === 'string' && (FEED_KINDS as readonly string[]).includes(value);
export const isFeedChannel = (value: unknown): value is FeedChannel => typeof value === 'string' && (FEED_CHANNELS as readonly string[]).includes(value);

/** The kind of a request, or 422 `VALIDATION_FAILED` naming `kind`. */
export function feedKindOf(value: unknown): FeedKind {
  if (!isFeedKind(value)) throw new DomainError('VALIDATION_FAILED', 422, 'kind');
  return value;
}

/** The kind a position of the file import stands for, or undefined for any other connector. */
export const feedKindOfPosition = (connectorCode: string): FeedKind | undefined => FEED_KINDS.find((kind) => FEED_POSITIONS[kind] === connectorCode);

/** What the acceptance of a deliverable that rests on the feed says: the layouts are a working assumption until the Finance Department publishes its own (PENDING_EXTERNAL, R18). */
export type FeedAcceptance = 'PENDING_EXTERNAL' | 'ACCEPTABLE';
export const isWorkingAssumptionFeedLayout = (version: string): boolean => version.startsWith('WORKING-ASSUMPTION');
export const feedAcceptance = (layoutVersion: string): FeedAcceptance => (isWorkingAssumptionFeedLayout(layoutVersion) ? 'PENDING_EXTERNAL' : 'ACCEPTABLE');

/** The inputs from outside the agency that this lane waits for (the register of external dependencies, R1). */
export interface FeedPendingExternalItem {
  code: string;
  what: string;
  owner: string;
  workingAssumption: string;
  switchesWhenItArrives: string;
}

export const FEED_PENDING_EXTERNAL_ITEMS: readonly FeedPendingExternalItem[] = [
  { code: 'FEED_SAMPLE_PROJECT', what: 'Official sample and column specification of the project list of the Finance application', owner: 'Finance Department', workingAssumption: 'PROJECT layout of WORKING-ASSUMPTION-FIN-2026.1', switchesWhenItArrives: 'The PROJECT layout in finance-feed.ts' },
  { code: 'FEED_SAMPLE_PLAN', what: 'Official sample of the annual capital plan by project and fund', owner: 'Finance Department', workingAssumption: 'PLAN layout', switchesWhenItArrives: 'The PLAN layout' },
  { code: 'FEED_SAMPLE_DISBURSEMENT', what: 'Official sample of the monthly disbursement report', owner: 'Finance Department', workingAssumption: 'DISBURSEMENT layout', switchesWhenItArrives: 'The DISBURSEMENT layout' },
  { code: 'FEED_SAMPLE_MILESTONE', what: 'Official sample of contract and procurement milestones', owner: 'Finance Department', workingAssumption: 'MILESTONE layout', switchesWhenItArrives: 'The MILESTONE layout' },
  { code: 'FEED_API_SPECIFICATION', what: 'Push interface, credentials and test environment of the Finance application', owner: 'Finance Department', workingAssumption: 'None: FeedApiPushAdapter refuses with 503 FEED_API_UNAVAILABLE', switchesWhenItArrives: 'FeedApiPushAdapter is implemented over the machine account; the connection may become VERIFIED' },
  { code: 'FEED_MACHINE_ACCOUNT', what: 'The machine-account (client credentials) facility of the integration gateway (lane INT-1)', owner: 'Integration lane', workingAssumption: 'No machine account: the push endpoint refuses', switchesWhenItArrives: 'The push endpoint authenticates the Finance application and calls the adapter' },
  { code: 'FEED_LEGAL_THRESHOLDS', what: 'Confirmation of the tolerance, the large-difference line and the reporting deadline by the customer', owner: 'Customer finance staff', workingAssumption: 'Rule FINANCE_FEED_POLICY defaults, flagged UNVERIFIED', switchesWhenItArrives: 'The tenant approves its own rule and the flag clears' },
];

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The typed records.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface FeedProjectRecord {
  feedProjectCode: string;
  asOf: string;
  projectName: string;
  sectorCode: string;
  districtCode: string;
  investorCode: string;
  investorName: string | null;
  totalInvestment: string | null;
  startYear: number | null;
  endYear: number | null;
  projectStatus: string;
  ourProjectCode: string | null;
}

export interface FeedPlanRecord {
  feedProjectCode: string;
  fiscalYear: number;
  fundCode: string;
  planAmount: string;
  asOf: string;
  decisionNo: string | null;
}

export interface FeedDisbursementRecord {
  feedProjectCode: string;
  fiscalYear: number;
  month: number;
  fundCode: string;
  disbursedMonth: string;
  disbursedCumulative: string;
  reportedOn: string;
  asOf: string;
}

export interface FeedMilestoneRecord {
  feedProjectCode: string;
  milestoneKind: string;
  packageCode: string | null;
  plannedOn: string | null;
  actualOn: string | null;
  contractValue: string | null;
  asOf: string;
}

export interface FeedRecordByKind {
  PROJECT: FeedProjectRecord;
  PLAN: FeedPlanRecord;
  DISBURSEMENT: FeedDisbursementRecord;
  MILESTONE: FeedMilestoneRecord;
}
export type FeedRecordBody = FeedRecordByKind[FeedKind];

/** One record of the feed as every adapter hands it over and the store keeps it: the kind, the key of the thing (without the day) and the key of this statement of it (with the day it was true). */
export interface FeedRecord<K extends FeedKind = FeedKind> {
  kind: K;
  entityKey: string;
  businessKey: string;
  asOf: string;
  record: FeedRecordByKind[K];
}

/** The key of the thing a record is about (what a later statement replaces). */
export function feedEntityKeyOf(kind: FeedKind, record: FeedRecordBody): string {
  switch (kind) {
    case 'PROJECT':
      return (record as FeedProjectRecord).feedProjectCode;
    case 'PLAN': {
      const plan = record as FeedPlanRecord;
      return `${plan.feedProjectCode}|${plan.fiscalYear}|${plan.fundCode}`;
    }
    case 'DISBURSEMENT': {
      const row = record as FeedDisbursementRecord;
      return `${row.feedProjectCode}|${row.fiscalYear}|${row.month}|${row.fundCode}`;
    }
    case 'MILESTONE': {
      const milestone = record as FeedMilestoneRecord;
      return `${milestone.feedProjectCode}|${milestone.milestoneKind}|${milestone.packageCode ?? ''}`;
    }
  }
}

export function feedRecordOf<K extends FeedKind>(kind: K, record: FeedRecordByKind[K]): FeedRecord<K> {
  const entityKey = feedEntityKeyOf(kind, record);
  return { kind, entityKey, businessKey: `${entityKey}|${record.asOf}`, asOf: record.asOf, record };
}
