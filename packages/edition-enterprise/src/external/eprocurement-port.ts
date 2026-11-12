import { DomainError } from '@machvon/kernel';
import { EXTERNAL_ADAPTER_STATUS, externalAcceptance, isInstant, isKey, isLine, isVnd, pageOf, pageRequestOf } from './external-rules.ts';
import type { ExternalAcceptance, Page } from './external-rules.ts';

/**
 * The port to the eProcurement system of the customer (CN.02, TH.03, PX-06): the packages of equipment procurement of the investment projects with their stage, selection result and contract number. The customer has not
 * said how the data can be taken (an interface, a file, a database), so the layout below is a WORKING ASSUMPTION and everything read through it is PENDING-EXTERNAL; until then the data of the screen of the Ban Thuong
 * mai comes from the national network's file import (BID) and from what a person enters. A real adapter implements `EProcurementPort` and passes `test/support/port-contract.ts`.
 */

export const EPROCUREMENT_LAYOUT = 'EPROCUREMENT-WORKING-ASSUMPTION-2026.1';
export const EPROCUREMENT_STAGES = ['PLANNED', 'TENDERING', 'AWARDED', 'CONTRACTED', 'CANCELLED'] as const;
export type EProcurementStage = (typeof EPROCUREMENT_STAGES)[number];

/** One package as the system names it. The project is named by the code the system knows it by (resolved to a project through the crosswalk of ENT-3e, never by a guess); money is whole dong as text. */
export interface EProcurementRecord {
  externalCode: string;
  projectCode: string;
  title: string;
  stage: EProcurementStage;
  plannedValueVnd: string;
  /** Set from the award on. */
  awardPriceVnd: string | null;
  winnerName: string | null;
  /** Set when the contract is signed. */
  contractNo: string | null;
  updatedAt: string;
}

export interface EProcurementQuery {
  projectCode?: string | undefined;
  /** Only packages changed at or after this instant. */
  updatedSince?: string | undefined;
  after?: string | undefined;
  limit?: number | undefined;
}

export interface EProcurementPage extends Page<EProcurementRecord> {
  layout: string;
  acceptance: ExternalAcceptance;
  /** Says every record is read through a layout nobody has confirmed. */
  workingAssumption: boolean;
  /** The instant of the data, as the source gave it. */
  asOf: string;
}

export interface EProcurementPort {
  readonly adapterStatus: typeof EXTERNAL_ADAPTER_STATUS;
  readonly layoutVersion: string;
  fetchPackages(query: EProcurementQuery): Promise<EProcurementPage>;
}

/** The first field that is wrong in a record, or none; the stage decides which of the award and contract fields are required (an award has a price and a winner, a contract also has a number). */
export function eprocurementRecordProblems(record: EProcurementRecord): string[] {
  const problems: string[] = [];
  if (!isKey(record.externalCode)) problems.push('external_code');
  if (!isKey(record.projectCode)) problems.push('project_code');
  if (!isLine(record.title, 300)) problems.push('title');
  if (!(EPROCUREMENT_STAGES as readonly string[]).includes(record.stage)) problems.push('stage');
  if (!isVnd(record.plannedValueVnd)) problems.push('planned_value_vnd');
  if (!isInstant(record.updatedAt)) problems.push('updated_at');
  const awarded = record.stage === 'AWARDED' || record.stage === 'CONTRACTED';
  if (awarded && !isVnd(record.awardPriceVnd)) problems.push('award_price_vnd');
  if (awarded && !isLine(record.winnerName, 300)) problems.push('winner_name');
  if (record.stage === 'CONTRACTED' && !isKey(record.contractNo)) problems.push('contract_no');
  if (!awarded && (record.awardPriceVnd !== null || record.winnerName !== null)) problems.push('stage');
  if (record.stage !== 'CONTRACTED' && record.contractNo !== null) problems.push('contract_no');
  return problems;
}

/** The query as the adapters take it: the common page rules, a key for the project code, an instant for the change time. */
export function eprocurementQueryOf(query: EProcurementQuery): { projectCode: string | undefined; updatedSince: string | undefined; after: string | undefined; limit: number } {
  const page = pageRequestOf({ after: query.after, limit: query.limit });
  if (query.projectCode !== undefined && !isKey(query.projectCode)) throw new DomainError('VALIDATION_FAILED', 422, 'project_code');
  if (query.updatedSince !== undefined && !isInstant(query.updatedSince)) throw new DomainError('VALIDATION_FAILED', 422, 'updated_since');
  return { projectCode: query.projectCode, updatedSince: query.updatedSince, ...page };
}

/**
 * The fake adapter: serves a fixed list from memory. It stands in for the real system in tests and in a demo; its pages say `workingAssumption` and `PENDING_EXTERNAL` like the real ones will until the customer
 * confirms the layout. A record that breaks the layout is refused when the fake is built, so a test cannot feed the readers data a real adapter would never hand over.
 */
export class FakeEProcurementPort implements EProcurementPort {
  readonly adapterStatus = EXTERNAL_ADAPTER_STATUS;
  readonly layoutVersion = EPROCUREMENT_LAYOUT;
  private readonly records: readonly EProcurementRecord[];
  private readonly asOf: string;

  constructor(records: readonly EProcurementRecord[], asOf: string) {
    if (!isInstant(asOf)) throw new DomainError('VALIDATION_FAILED', 422, 'as_of');
    this.asOf = asOf;
    for (const record of records) {
      const problems = eprocurementRecordProblems(record);
      if (problems.length > 0) throw new DomainError('VALIDATION_FAILED', 422, problems[0] as string);
    }
    if (new Set(records.map((record) => record.externalCode)).size !== records.length) throw new DomainError('VALIDATION_FAILED', 422, 'external_code');
    this.records = [...records].sort((left, right) => (left.externalCode < right.externalCode ? -1 : left.externalCode > right.externalCode ? 1 : 0));
  }

  fetchPackages(query: EProcurementQuery): Promise<EProcurementPage> {
    const asked = eprocurementQueryOf(query);
    const matching = this.records.filter((record) => (asked.projectCode === undefined || record.projectCode === asked.projectCode) && (asked.updatedSince === undefined || Date.parse(record.updatedAt) >= Date.parse(asked.updatedSince)));
    const page = pageOf(matching, (record) => record.externalCode, asked);
    return Promise.resolve({ ...page, layout: this.layoutVersion, acceptance: externalAcceptance(this.layoutVersion), workingAssumption: true, asOf: this.asOf });
  }
}
