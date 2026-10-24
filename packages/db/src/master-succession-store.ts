import { DomainError } from '@machvon/kernel';
import { MasterStore } from './master-store.ts';
import type { MasterVersionRow } from './master-store.ts';
import {
  WHOLE_SHARE,
  assertEdgeAllowed,
  invalid,
  isSuccessionKind,
  legalBasisOf,
  lockSuccessionGraph,
  proposalOf,
  proposedJsonOf,
  shareHundredths,
  shareText,
  shareTotal,
} from './master-succession.ts';
import type { SuccessionKind, SuccessionProposal } from './master-succession.ts';
import type { TenantTx } from './tenant-database.ts';

const MAX_REASON = 2000;
const MIN_REASON = 5;
const MAX_DEPTH = 64;
/** Shares are multiplied along a chain of edges in this unit (100 percent), so that a chain of splits loses nothing visible. */
const UNIT = 10n ** 12n;

export interface NewSuccession {
  predecessorRecordId: string;
  successorRecordId: string;
  kind: SuccessionKind;
  effectiveDate: string;
  /** Percent of the predecessor that goes to this successor: required for a split, refused for every other kind. */
  sharePct?: string | undefined;
  legalBasis: string;
  reason: string;
}

/** An edge of the graph with the keys of the two entries it joins. */
export interface SuccessionEdgeRow {
  id: string;
  predecessorRecordId: string;
  predecessorKey: string;
  /** The name the predecessor had when it handed over: its last published version before the date. */
  predecessorLabel: string | null;
  successorRecordId: string;
  successorKey: string;
  /** The name the successor has on the date of the succession. */
  successorLabel: string | null;
  masterType: string;
  kind: SuccessionKind;
  effectiveDate: string;
  sharePct: string | null;
  legalBasis: string;
  changeRequestId: string;
}

/** Where an entry stood on a date: its own version, or the entries that took over from it. */
export type StructureState = 'IN_FORCE' | 'SUCCEEDED' | 'NOT_STARTED' | 'ENDED';

/** An entry of the structure that the reading converts to, with the part of the starting entry that went to it. */
export interface SuccessionTarget {
  recordId: string;
  masterType: string;
  businessKey: string;
  /** The last edge that led to it; null when the entry is the starting entry itself. */
  kind: SuccessionKind | null;
  effectiveDate: string | null;
  /** Percent of the starting entry, two decimals; chains of splits are multiplied and paths that meet are added. */
  sharePct: string;
  version: MasterVersionRow | null;
}

export interface StructureReading {
  recordId: string;
  masterType: string;
  businessKey: string;
  namespace: 'PLATFORM' | 'TENANT';
  asOf: string;
  state: StructureState;
  version: MasterVersionRow | null;
  /** The latest date of the structure that the entry belongs to on `asOf`: its version's start or the date of a succession it took part in. */
  structureDate: string | null;
  /** Edges that ended at this entry (what it took over), on or before `asOf`. */
  predecessors: SuccessionEdgeRow[];
  /** Edges that leave this entry, on or before `asOf`. */
  successors: SuccessionEdgeRow[];
  targets: SuccessionTarget[];
}

interface EdgeSql {
  id: string;
  predecessor_record_id: string;
  predecessor_key: string;
  predecessor_label: string | null;
  successor_record_id: string;
  successor_key: string;
  successor_label: string | null;
  master_type: string;
  succession_kind: SuccessionKind;
  effective_date: string;
  share_pct: string | null;
  legal_basis: string;
  change_request_id: string;
}

// The names come from the versions around the date: the predecessor as it was when it handed over, the successor as it is on that date.
const EDGE_SELECT = `select s.id, s.predecessor_record_id, p.business_key as predecessor_key, pv.label as predecessor_label, s.successor_record_id,
    q.business_key as successor_key, sv.label as successor_label, p.master_type, s.succession_kind, s.effective_date::text as effective_date,
    s.share_pct::text as share_pct, s.legal_basis, s.change_request_id
  from machvon.master_succession s
  join machvon.master_record p on p.tenant_id = s.tenant_id and p.id = s.predecessor_record_id
  join machvon.master_record q on q.tenant_id = s.tenant_id and q.id = s.successor_record_id
  left join lateral (
    select v.label from machvon.master_record_version v
     where v.master_record_id = s.predecessor_record_id and v.published_at is not null and v.status in ('APPROVED', 'EFFECTIVE', 'RETIRED') and v.valid_from < s.effective_date
     order by v.revision desc limit 1
  ) pv on true
  left join lateral (
    select v.label from machvon.master_record_version v
     where v.master_record_id = s.successor_record_id and v.published_at is not null and v.status in ('APPROVED', 'EFFECTIVE', 'RETIRED')
       and v.valid_from <= s.effective_date and (v.valid_until is null or v.valid_until > s.effective_date)
     order by v.revision desc limit 1
  ) sv on true`;

const toEdge = (row: EdgeSql): SuccessionEdgeRow => ({
  id: row.id,
  predecessorRecordId: row.predecessor_record_id,
  predecessorKey: row.predecessor_key,
  predecessorLabel: row.predecessor_label,
  successorRecordId: row.successor_record_id,
  successorKey: row.successor_key,
  successorLabel: row.successor_label,
  masterType: row.master_type,
  kind: row.succession_kind,
  effectiveDate: row.effective_date,
  sharePct: row.share_pct,
  legalBasis: row.legal_basis,
  changeRequestId: row.change_request_id,
});

const EDGE_ORDER = 'order by s.effective_date, p.business_key, q.business_key, s.id';

interface OpenChange {
  id: string;
  change_kind: string;
  status: string;
  proposed_json: Record<string, unknown>;
  version: string;
  created_by: string;
}

/**
 * Administrative succession (ST-MDM-009, MDM 3.1 F3). `record` opens (or, for a split, extends) a SUCCESSION change request that goes
 * through the same review as every other master data change; the edges become facts when it is published. Reads answer how an entry stood
 * on a date and which entries of the structure on that date took over from it. Nothing here changes a version: a project that points at
 * the revision of a commune keeps pointing at it after the commune is merged away.
 */
export class MasterSuccessionStore {
  private readonly masters: MasterStore;

  constructor(masters: MasterStore = new MasterStore()) {
    this.masters = masters;
  }

  // ---- command ---------------------------------------------------------------------------------------------------------------------

  /**
   * Records one edge. The change request is anchored on the predecessor; a split is made of several edges of the same predecessor, date and
   * legal basis, added to the open draft one at a time, and goes to review only when their shares add up to exactly 100 (BR-MDM-07).
   */
  async record(tx: TenantTx, input: NewSuccession, actor: string): Promise<{ changeRequestId: string; version: number; edges: number }> {
    const reason = input.reason.trim();
    if (reason.length < MIN_REASON || reason.length > MAX_REASON) throw invalid('reason');
    const legalBasis = legalBasisOf(input.legalBasis);
    if (!isSuccessionKind(input.kind)) throw invalid('succession_kind');
    const share = this.shareOf(input);

    await lockSuccessionGraph(tx);
    const predecessor = await this.masters.findRecord(tx, input.predecessorRecordId, true);
    // An entry of another tenant is indistinguishable from one that does not exist.
    if (predecessor === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await assertEdgeAllowed(tx, this.masters, predecessor, input.successorRecordId, input.effectiveDate);

    const open = await tx.query<OpenChange>(
      `select id, change_kind, status, proposed_json, version::text as version, created_by from machvon.master_change_request
        where master_record_id = $1::uuid and status in ('DRAFT', 'IN_REVIEW', 'APPROVED') for update`,
      [predecessor.id],
    );
    const impact = JSON.stringify(await this.masters.impactOf(tx, predecessor.id));
    const edge = { successorRecordId: input.successorRecordId, sharePct: share };
    const existing = open[0];
    if (existing === undefined) {
      const proposal: SuccessionProposal = { kind: input.kind, effectiveDate: input.effectiveDate, legalBasis, edges: [edge] };
      const rows = await tx.query<{ id: string }>(
        `insert into machvon.master_change_request
           (tenant_id, id, change_kind, master_type, master_record_id, proposed_json, reason, impact_json, effective_from, status, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), 'SUCCESSION', $1, $2::uuid, $3::jsonb, $4, $5::jsonb, $6::date, 'DRAFT', $7::uuid, $7::uuid)
         returning id`,
        [predecessor.masterType, predecessor.id, JSON.stringify(proposedJsonOf(proposal)), reason, impact, input.effectiveDate, actor],
      );
      return { changeRequestId: (rows[0] as { id: string }).id, version: 1, edges: 1 };
    }

    // Only a draft split takes another successor, and only from the one who opened it: a second person who wrote part of it could then review
    // it as "someone other than its author" (four-eyes judges the creator). Any other open request of the entry has to be decided first.
    const draft = existing.change_kind === 'SUCCESSION' && existing.status === 'DRAFT' ? proposalOf(existing.proposed_json) : undefined;
    if (draft === undefined || existing.created_by.toLowerCase() !== actor.toLowerCase() || draft.kind !== 'SPLIT' || input.kind !== 'SPLIT' || draft.effectiveDate !== input.effectiveDate) {
      throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'a change request is already open');
    }
    if (draft.legalBasis !== legalBasis) throw invalid('legal_basis');
    if (draft.edges.some((other) => other.successorRecordId === edge.successorRecordId)) throw new DomainError('DUPLICATE_KEY', 409);
    const edges = [...draft.edges, edge];
    if (shareTotal(edges) > WHOLE_SHARE) throw invalid('share_pct');
    const rows = await tx.query<{ version: string }>(
      `update machvon.master_change_request set proposed_json = $2::jsonb, impact_json = $3::jsonb, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid returning version::text as version`,
      [existing.id, JSON.stringify(proposedJsonOf({ ...draft, edges })), impact, actor],
    );
    return { changeRequestId: existing.id, version: Number((rows[0] as { version: string }).version), edges: edges.length };
  }

  /** The share of the edge in the form the table stores: required (and strictly between 0 and 100) for a split, refused for every other kind. */
  private shareOf(input: NewSuccession): string | null {
    if (input.kind !== 'SPLIT') {
      if (input.sharePct !== undefined) throw invalid('share_pct');
      return null;
    }
    if (input.sharePct === undefined) throw invalid('share_pct');
    return shareText(shareHundredths(input.sharePct));
  }

  // ---- reads -----------------------------------------------------------------------------------------------------------------------

  /** The edges that leave an entry on or before `on`, and everything they lead to, the oldest first. */
  async reachable(tx: TenantTx, recordId: string, on: string): Promise<SuccessionEdgeRow[]> {
    const rows = await tx.query<EdgeSql>(
      `with recursive walk(record_id, depth) as (
         select $1::uuid, 0
         union
         select e.successor_record_id, w.depth + 1
           from walk w join machvon.master_succession e on e.predecessor_record_id = w.record_id and e.effective_date <= $2::date
          where w.depth < ${MAX_DEPTH}
       )
       ${EDGE_SELECT}
        where s.predecessor_record_id in (select record_id from walk) and s.effective_date <= $2::date
        ${EDGE_ORDER}`,
      [recordId, on],
    );
    return rows.map(toEdge);
  }

  /** The edges that end at an entry on or before `on`: what it took over. */
  async incoming(tx: TenantTx, recordId: string, on: string): Promise<SuccessionEdgeRow[]> {
    const rows = await tx.query<EdgeSql>(`${EDGE_SELECT} where s.successor_record_id = $1::uuid and s.effective_date <= $2::date ${EDGE_ORDER}`, [recordId, on]);
    return rows.map(toEdge);
  }

  /** How an entry stood on a date, and into which entries of that day's structure it is converted; undefined when the entry does not exist. */
  async asOf(tx: TenantTx, recordId: string, on: string): Promise<StructureReading | undefined> {
    const record = await this.masters.findRecord(tx, recordId);
    if (record === undefined) return undefined;
    const version = (await this.masters.versionInForce(tx, recordId, on)) ?? null;
    const edges = await this.reachable(tx, recordId, on);
    const predecessors = await this.incoming(tx, recordId, on);
    const successors = edges.filter((edge) => edge.predecessorRecordId === recordId);
    const state = await this.stateOf(tx, recordId, on, version, successors.length > 0);
    const dates = [version?.validFrom, ...predecessors.map((edge) => edge.effectiveDate), ...successors.map((edge) => edge.effectiveDate)].filter((date): date is string => date !== undefined);
    return {
      recordId,
      masterType: record.masterType,
      businessKey: record.businessKey,
      namespace: record.namespace,
      asOf: on,
      state,
      version,
      structureDate: dates.length === 0 ? null : dates.reduce((latest, date) => (date > latest ? date : latest)),
      predecessors,
      successors,
      targets: await this.targetsOf(tx, { id: recordId, masterType: record.masterType, businessKey: record.businessKey }, edges, on),
    };
  }

  /** The conversion of an entry to the structure of `on`: the edges that lead from it, and the entries at their end. */
  async successors(tx: TenantTx, recordId: string, on: string): Promise<{ record: { id: string; masterType: string; businessKey: string }; edges: SuccessionEdgeRow[]; targets: SuccessionTarget[] } | undefined> {
    const found = await this.masters.findRecord(tx, recordId);
    if (found === undefined) return undefined;
    const record = { id: found.id, masterType: found.masterType, businessKey: found.businessKey };
    const edges = await this.reachable(tx, recordId, on);
    return { record, edges, targets: await this.targetsOf(tx, record, edges, on) };
  }

  private async stateOf(tx: TenantTx, recordId: string, on: string, version: MasterVersionRow | null, handedOver: boolean): Promise<StructureState> {
    if (version !== null) return 'IN_FORCE';
    if (handedOver) return 'SUCCEEDED';
    const first = await tx.query<{ valid_from: string | null }>(
      'select min(valid_from)::text as valid_from from machvon.master_record_version where master_record_id = $1::uuid and published_at is not null',
      [recordId],
    );
    const began = first[0]?.valid_from ?? null;
    return began === null || began > on ? 'NOT_STARTED' : 'ENDED';
  }

  /** The leaves of the edges below the entry (the entry itself when nothing leaves it), each with its share, and the version it had on `on`. */
  private async targetsOf(tx: TenantTx, start: { id: string; masterType: string; businessKey: string }, edges: readonly SuccessionEdgeRow[], on: string): Promise<SuccessionTarget[]> {
    const leaves = new Map<string, { edge: SuccessionEdgeRow | null; share: bigint; key: string; masterType: string }>();
    const visit = (recordId: string, share: bigint, last: SuccessionEdgeRow | null, depth: number): void => {
      const out = edges.filter((edge) => edge.predecessorRecordId === recordId);
      if (out.length === 0 || depth > MAX_DEPTH) {
        const known = leaves.get(recordId);
        const key = last?.successorKey ?? start.businessKey;
        leaves.set(recordId, { edge: known?.edge ?? last, share: (known?.share ?? 0n) + share, key, masterType: last?.masterType ?? start.masterType });
        return;
      }
      for (const edge of out) visit(edge.successorRecordId, edge.kind === 'SPLIT' && edge.sharePct !== null ? (share * BigInt(shareHundredths(edge.sharePct))) / BigInt(WHOLE_SHARE) : share, edge, depth + 1);
    };
    visit(start.id, 100n * UNIT, null, 0);
    const targets: SuccessionTarget[] = [];
    for (const [recordId, leaf] of leaves) {
      const hundredths = Number((leaf.share * BigInt(WHOLE_SHARE) + (100n * UNIT) / 2n) / (100n * UNIT));
      targets.push({
        recordId,
        masterType: leaf.masterType,
        businessKey: leaf.key,
        kind: leaf.edge?.kind ?? null,
        effectiveDate: leaf.edge?.effectiveDate ?? null,
        sharePct: shareText(hundredths),
        version: (await this.masters.versionInForce(tx, recordId, on)) ?? null,
      });
    }
    return targets.sort((left, right) => left.businessKey.localeCompare(right.businessKey));
  }
}
