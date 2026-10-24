import { DomainError } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * Administrative succession (ST-MDM-009, MDM 3.1 F3): which entry took over from which, on what date and on what legal basis. This file
 * holds what the change request and the store share: the shape of a proposal, the rules that decide whether an edge may be written
 * (BR-MDM-07 and the cycle rule) and the SQL that writes the edges of an approved proposal.
 */
export type SuccessionKind = 'MERGE' | 'SPLIT' | 'RENAME' | 'RELEVEL' | 'ABOLISH_LEVEL';

export const SUCCESSION_KINDS: readonly SuccessionKind[] = ['MERGE', 'SPLIT', 'RENAME', 'RELEVEL', 'ABOLISH_LEVEL'];

const UNIQUE_VIOLATION = '23505';
const SHARE_PATTERN = /^(\d{1,3})(?:\.(\d{1,2}))?$/;
/** 100 percent in hundredths of a percent, the unit the shares are added in (no float is ever involved). */
export const WHOLE_SHARE = 10_000;
const MAX_LEGAL_BASIS = 2000;

/** One edge of a proposal: the entry that takes over, and for a split its share of the predecessor in percent with two decimals. */
export interface SuccessionEdge {
  successorRecordId: string;
  sharePct: string | null;
}

/** What a SUCCESSION change request proposes: one predecessor (the record of the request) handing over to one entry, or to several for a split. */
export interface SuccessionProposal {
  kind: SuccessionKind;
  effectiveDate: string;
  legalBasis: string;
  edges: SuccessionEdge[];
}

export const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export function isSuccessionKind(value: unknown): value is SuccessionKind {
  return typeof value === 'string' && (SUCCESSION_KINDS as readonly string[]).includes(value);
}

/** A share as hundredths of a percent: strictly between 0 and 100, at most two decimals. */
export function shareHundredths(text: string): number {
  const match = SHARE_PATTERN.exec(text.trim());
  if (match === null) throw invalid('share_pct');
  const hundredths = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (hundredths <= 0 || hundredths >= WHOLE_SHARE) throw invalid('share_pct');
  return hundredths;
}

/** Hundredths of a percent as the text the table stores and the reads answer: `33.30`. */
export function shareText(hundredths: number): string {
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`;
}

/** The legal basis as it is stored: trimmed, at least three characters. */
export function legalBasisOf(value: string): string {
  const text = value.trim();
  if (text.length < 3 || text.length > MAX_LEGAL_BASIS) throw invalid('legal_basis');
  return text;
}

export function proposedJsonOf(proposal: SuccessionProposal): Record<string, unknown> {
  return {
    succession_kind: proposal.kind,
    effective_date: proposal.effectiveDate,
    legal_basis: proposal.legalBasis,
    edges: proposal.edges.map((edge) => ({ successor_record_id: edge.successorRecordId, share_pct: edge.sharePct })),
  };
}

/** The proposal a SUCCESSION change request stores; a request written by anything else than this code is refused, never guessed at. */
export function proposalOf(json: Record<string, unknown>): SuccessionProposal {
  const edges = json.edges;
  if (!isSuccessionKind(json.succession_kind) || typeof json.effective_date !== 'string' || typeof json.legal_basis !== 'string' || !Array.isArray(edges)) throw invalid('proposed');
  return {
    kind: json.succession_kind,
    effectiveDate: json.effective_date,
    legalBasis: json.legal_basis,
    edges: edges.map((edge: unknown) => {
      const row = edge as { successor_record_id?: unknown; share_pct?: unknown };
      if (typeof row.successor_record_id !== 'string' || (row.share_pct !== null && typeof row.share_pct !== 'string')) throw invalid('proposed');
      return { successorRecordId: row.successor_record_id, sharePct: row.share_pct };
    }),
  };
}

/** The sum of the shares of the edges, in hundredths of a percent. */
export function shareTotal(edges: readonly SuccessionEdge[]): number {
  return edges.reduce((total, edge) => total + (edge.sharePct === null ? 0 : shareHundredths(edge.sharePct)), 0);
}

/**
 * A proposal is complete when it can be put in force: a split names at least two successors whose shares add up to exactly 100 (BR-MDM-07,
 * 422 `share_pct` otherwise); any other kind names exactly one successor and no share (MERGE: the share stays null).
 */
export function assertComplete(proposal: SuccessionProposal): void {
  if (proposal.kind !== 'SPLIT') {
    if (proposal.edges.length !== 1 || proposal.edges.some((edge) => edge.sharePct !== null)) throw invalid('share_pct');
    return;
  }
  const successors = new Set(proposal.edges.map((edge) => edge.successorRecordId));
  if (proposal.edges.length < 2 || successors.size !== proposal.edges.length || proposal.edges.some((edge) => edge.sharePct === null)) throw invalid('share_pct');
  if (shareTotal(proposal.edges) !== WHOLE_SHARE) throw invalid('share_pct');
}

// ---- what the database is asked --------------------------------------------------------------------------------------------------

export interface PredecessorRef {
  id: string;
  masterType: string;
  namespace: 'PLATFORM' | 'TENANT';
  status: string;
  currentVersionId: string | null;
}

/** The reads of the master store that the rules need; the store passes itself, so this file does not depend on it. */
export interface SuccessionLookups {
  findRecord(tx: TenantTx, id: string): Promise<{ id: string; masterType: string; status: string } | undefined>;
  findVersion(tx: TenantTx, id: string): Promise<{ id: string; revision: number; validFrom: string; validUntil: string | null } | undefined>;
  versionInForce(tx: TenantTx, recordId: string, asOf: string): Promise<{ id: string } | undefined>;
}

/** One writer at a time changes the graph of a tenant: the cycle rule and the unique edges are judged against a graph that does not move. */
export async function lockSuccessionGraph(tx: TenantTx): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtextextended('master_succession:' || coalesce(nullif(current_setting('app.tenant_id', true), ''), ''), 0))");
}

/** True when `successorId` already leads back to `predecessorId` through the edges in force and the ones waiting for approval. */
export async function leadsBack(tx: TenantTx, predecessorId: string, successorId: string): Promise<boolean> {
  const rows = await tx.query(
    `with recursive edges(predecessor_id, successor_id) as (
       select predecessor_record_id, successor_record_id from machvon.master_succession
       union
       select c.master_record_id, (edge ->> 'successor_record_id')::uuid
         from machvon.master_change_request c cross join lateral jsonb_array_elements(c.proposed_json -> 'edges') edge
        where c.change_kind = 'SUCCESSION' and c.status in ('DRAFT', 'IN_REVIEW', 'APPROVED')
     ), walk(record_id) as (
       select $1::uuid
       union
       select e.successor_id from walk w join edges e on e.predecessor_id = w.record_id
     )
     select 1 from walk where record_id = $2::uuid limit 1`,
    [successorId, predecessorId],
  );
  return rows.length > 0;
}

/**
 * Judges one edge against the graph and the two entries: the predecessor is the tenant's own and was in force until the date, the
 * successor is of the same type and in force on the date, the date does not precede the arrival of the predecessor itself, and the edge
 * closes no cycle (422 SUCCESSION_CYCLE).
 */
export async function assertEdgeAllowed(
  tx: TenantTx,
  lookups: SuccessionLookups,
  predecessor: PredecessorRef,
  successorRecordId: string,
  effectiveDate: string,
): Promise<void> {
  if (predecessor.namespace !== 'TENANT') throw new DomainError('POLICY_LOCKED', 403);
  if (predecessor.status !== 'EFFECTIVE' && predecessor.status !== 'RETIRED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, `${predecessor.status}->SUCCESSION`);
  const current = predecessor.currentVersionId === null ? undefined : await lookups.findVersion(tx, predecessor.currentVersionId);
  if (current === undefined) throw new DomainError('STAGE_TRANSITION_DENIED', 409, `${predecessor.status}->SUCCESSION`);
  // The version in force is closed on the date: the date comes after it began, and not after it ended by itself.
  if (effectiveDate <= current.validFrom || (current.validUntil !== null && current.validUntil < effectiveDate)) throw invalid('effective_date');
  const later = await tx.query('select 1 from machvon.master_record_version where master_record_id = $1::uuid and revision > $2', [predecessor.id, current.revision]);
  if (later.length > 0) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'a published change is waiting for its date');

  const successor = await lookups.findRecord(tx, successorRecordId);
  if (successor === undefined) throw invalid('successor_record_id');
  // A ring is told apart from a mere mistake: an entry that already handed over to the predecessor (or is the predecessor) cannot take over from it.
  if (await leadsBack(tx, predecessor.id, successor.id)) throw new DomainError('SUCCESSION_CYCLE', 422);
  // The predecessor may itself have arrived by an earlier succession; it cannot hand over before it arrived.
  const arrival = await tx.query('select 1 from machvon.master_succession where successor_record_id = $1::uuid and effective_date > $2::date limit 1', [predecessor.id, effectiveDate]);
  if (arrival.length > 0) throw invalid('effective_date');
  if (successor.masterType !== predecessor.masterType || (successor.status !== 'EFFECTIVE' && successor.status !== 'APPROVED')) throw invalid('successor_record_id');
  if ((await lookups.versionInForce(tx, successor.id, effectiveDate)) === undefined) throw invalid('successor_record_id');
}

/** Writes the edges of an approved proposal; a repeated edge (same predecessor, successor and date) is 409 DUPLICATE_KEY. */
export async function insertEdges(
  tx: TenantTx,
  change: { id: string; createdBy: string },
  predecessorId: string,
  proposal: SuccessionProposal,
  publisher: string,
): Promise<void> {
  for (const edge of proposal.edges) {
    try {
      await tx.query(
        `insert into machvon.master_succession
           (tenant_id, id, predecessor_record_id, successor_record_id, succession_kind, effective_date, share_pct, legal_basis, change_request_id, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3, $4::date, $5::numeric, $6, $7::uuid, $8::uuid, $9::uuid)`,
        [predecessorId, edge.successorRecordId, proposal.kind, proposal.effectiveDate, edge.sharePct, proposal.legalBasis, change.id, change.createdBy, publisher],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('DUPLICATE_KEY', 409);
      throw error;
    }
  }
}
