import { ApiError } from '@machvon/api-client';
import { businessToday } from '../../adm/org-tree/business-date';
import { RESTRICTION_KINDS, RESTRICTION_SOURCES } from '../model';
import type { RestrictionKind, RestrictionSource } from '../model';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export interface ScorecardView {
  id: string;
  contractId: string;
  contractCode: string;
  kind: string;
  periodLabel: string;
  revision: number;
  overallScore: string;
  rating: string;
  approvedAt: string | null;
}

export interface ContractLink {
  id: string;
  code: string;
  status: string;
}

export interface HistoryRestrictionView {
  id: string;
  kind: RestrictionKind;
  source: RestrictionSource;
  effectiveFrom: string;
  effectiveUntil: string | null;
  inForce: boolean;
}

export interface HistoryView {
  contractor: { id: string; legalName: string };
  scorecards: ScorecardView[];
  /** How many approved scorecards the caller reads: the list is bounded, the count and the average are not. */
  approvedCount: number;
  averageOverallScore: string | null;
  contracts: ContractLink[];
  restrictions: HistoryRestrictionView[];
  restrictionInForce: boolean;
}

function toScorecard(raw: unknown): ScorecardView[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const contractId = text(row?.contract_id);
  const overall = text(row?.overall_score);
  if (row === undefined || id === undefined || contractId === undefined || overall === undefined || typeof row.revision !== 'number') return [];
  return [
    {
      id,
      contractId,
      contractCode: text(row.contract_code) ?? '',
      kind: text(row.kind) ?? '',
      periodLabel: text(row.period_label) ?? '',
      revision: row.revision,
      overallScore: overall,
      rating: text(row.rating) ?? '',
      approvedAt: nullableText(row.approved_at),
    },
  ];
}

function toContract(raw: unknown): ContractLink[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.code);
  return row === undefined || id === undefined || code === undefined ? [] : [{ id, code, status: text(row.status) ?? '' }];
}

function toRestriction(raw: unknown): HistoryRestrictionView[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const kind = RESTRICTION_KINDS.find((known) => known === row?.kind);
  const source = RESTRICTION_SOURCES.find((known) => known === row?.source);
  const from = text(row?.effective_from);
  if (row === undefined || id === undefined || kind === undefined || source === undefined || from === undefined) return [];
  return [{ id, kind, source, effectiveFrom: from, effectiveUntil: nullableText(row.effective_until), inForce: row.in_force === true }];
}

export function toHistory(raw: unknown): HistoryView | undefined {
  const row = asRecord(raw);
  const contractor = asRecord(row?.contractor);
  const id = text(contractor?.id);
  if (row === undefined || id === undefined) return undefined;
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  return {
    contractor: { id, legalName: text(contractor?.legal_name) ?? '' },
    scorecards: list(row.scorecards).flatMap(toScorecard),
    approvedCount: typeof row.approved_count === 'number' && Number.isInteger(row.approved_count) && row.approved_count >= 0 ? row.approved_count : 0,
    averageOverallScore: nullableText(row.average_overall_score),
    contracts: list(row.contracts).flatMap(toContract),
    restrictions: list(row.restrictions).flatMap(toRestriction),
    restrictionInForce: row.restriction_in_force === true,
  };
}

export type Validity = 'inForce' | 'ended' | 'upcoming';

/** Whether a restriction applies now, has ended, or has not begun: the word the screen says, never a colour alone. The server says `in_force`; the other two are told apart by the first day. */
export function validityOf(restriction: HistoryRestrictionView, today: string = businessToday()): Validity {
  if (restriction.inForce) return 'inForce';
  return restriction.effectiveFrom > today ? 'upcoming' : 'ended';
}

// ---- what the server refuses ---------------------------------------------------------------------------------------------------

export type HistoryProblem = 'notFound' | 'denied' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, HistoryProblem>> = { RESOURCE_NOT_FOUND: 'notFound', SCOPE_DENIED: 'denied' };

export const describeHistory = (error: unknown): HistoryProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);
