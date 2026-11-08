import { randomUUID } from 'node:crypto';
import {
  DomainError,
  FEED_EXTERNAL_TYPE,
  FEED_SOURCE_SYSTEM,
  diffFeedFigures,
  feedAmountText,
  feedMappingMove,
  foldFeedFacts,
  openFeedDifferences,
  pickFeedDifferenceOwner,
  resolveFeedDifference,
  versionConflict,
  vietnamDateOf,
} from '@machvon/kernel';
import type {
  FeedDifferenceField,
  FeedDifferenceItem,
  FeedFieldDifference,
  FeedMappingMove,
  FeedMappingRequest,
  FeedMappingStatus,
  FeedOwnFigures,
  FeedPolicy,
  FeedResolutionKind,
} from '@machvon/kernel';
import { resolveEgpSubject } from './egp-store.ts';
import type { EgpSubject } from './egp-store.ts';
import { FeedRecordStore } from './finance-feed-store.ts';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const UNIQUE_VIOLATION = '23505';
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The mapping of a project code of the feed to one of our projects, on `master_crosswalk`.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface FeedMappingRow {
  id: string;
  subjectId: string;
  ourCode: string | null;
  ourName: string | null;
  externalCode: string;
  matchMethod: 'MANUAL' | 'IMPORT' | 'RULE';
  validFrom: string;
  validUntil: string | null;
  status: FeedMappingStatus;
  proposedBy: string;
  proposalReason: string | null;
  importId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  decisionReason: string | null;
  retiredBy: string | null;
  retiredAt: string | null;
  retireReason: string | null;
  version: number;
  createdAt: string;
  createdAtKey: string;
}

interface MappingSql {
  id: string;
  subject_id: string;
  our_code: string | null;
  our_name: string | null;
  external_code: string;
  match_method: FeedMappingRow['matchMethod'];
  valid_from: string;
  valid_until: string | null;
  status: FeedMappingStatus;
  created_by: string;
  proposal_reason: string | null;
  import_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  decision_reason: string | null;
  retired_by: string | null;
  retired_at: string | null;
  retire_reason: string | null;
  version: string;
  created_at: string;
  created_at_key: string;
}

const MAPPING_SELECT = `select x.id, x.subject_id, p.code as our_code, p.name as our_name, x.external_code, x.match_method, x.valid_from::text as valid_from, x.valid_until::text as valid_until, x.status, x.created_by,
  x.proposal_reason, x.import_id, x.approved_by, to_char(x.approved_at at time zone 'UTC', ${ISO}) as approved_at, x.decision_reason, x.retired_by, to_char(x.retired_at at time zone 'UTC', ${ISO}) as retired_at,
  x.retire_reason, x.version::text as version, to_char(x.created_at at time zone 'UTC', ${ISO}) as created_at, ${timestampKey('x.created_at')} as created_at_key
  from machvon.master_crosswalk x left join machvon.project p on p.tenant_id = x.tenant_id and p.id = x.subject_id
  where x.subject_type = 'PROJECT' and x.source_system = '${FEED_SOURCE_SYSTEM}'`;

const mappingOf = (row: MappingSql): FeedMappingRow => ({
  id: row.id,
  subjectId: row.subject_id,
  ourCode: row.our_code,
  ourName: row.our_name,
  externalCode: row.external_code,
  matchMethod: row.match_method,
  validFrom: row.valid_from,
  validUntil: row.valid_until,
  status: row.status,
  proposedBy: row.created_by,
  proposalReason: row.proposal_reason,
  importId: row.import_id,
  approvedBy: row.approved_by,
  approvedAt: row.approved_at,
  decisionReason: row.decision_reason,
  retiredBy: row.retired_by,
  retiredAt: row.retired_at,
  retireReason: row.retire_reason,
  version: Number(row.version),
  createdAt: row.created_at,
  createdAtKey: row.created_at_key,
});

export interface FeedMappingCounts {
  PROPOSED: number;
  ACTIVE: number;
  REJECTED: number;
  RETIRED: number;
}

export interface FeedUnmapped {
  feedProjectCode: string;
  projectName: string | null;
  investorCode: string | null;
  ourCodeHint: string | null;
  asOf: string;
}

/** What writing a mapping would do against the ACTIVE mappings that exist. */
export type FeedMappingOutcome = 'CREATE' | 'ALREADY_ACTIVE' | 'EXTERNAL_CODE_TAKEN' | 'SUBJECT_HAS_OTHER_CODE';

/**
 * The project codes of the feed on `master_crosswalk` (source system FIN_SOTAICHINH, subject PROJECT, no new table of identities). A mapping is PROPOSED by one person, or by the import of a record that names one of
 * our codes, and becomes ACTIVE when ANOTHER person approves it (the database holds `approved_by <> created_by`). One feed code stands for one project at a time and one project holds one feed code at a time; a
 * mapping that was wrong is retired and replaced by a new proposal, so the rows are the history.
 */
export class FeedMappingStore {
  async find(tx: TenantTx, id: string, lock = false): Promise<FeedMappingRow | undefined> {
    const rows = await tx.query<MappingSql>(`${MAPPING_SELECT} and x.id = $1::uuid${lock ? ' for update of x' : ''}`, [id]);
    return rows[0] === undefined ? undefined : mappingOf(rows[0]);
  }

  async list(tx: TenantTx, filter: { status?: FeedMappingStatus | undefined; q?: string | undefined }, request: { limit: number; after: { key: string; id: string } | undefined }): Promise<FeedMappingRow[]> {
    const like = filter.q === undefined ? null : `%${filter.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const rows = await tx.query<MappingSql>(
      `select * from (${MAPPING_SELECT}) m
        where ($1::text is null or m.status = $1) and ($2::text is null or m.external_code ilike $2 escape '\\' or m.our_code ilike $2 escape '\\')
          and ($3::text is null or (m.created_at_key, m.id) < ($3::text, $4::uuid))
        order by m.created_at_key desc, m.id desc limit $5`,
      [filter.status ?? null, like, request.after?.key ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(mappingOf);
  }

  async counts(tx: TenantTx): Promise<FeedMappingCounts> {
    const rows = await tx.query<{ status: FeedMappingStatus; n: string }>(`select status, count(*)::text as n from machvon.master_crosswalk where subject_type = 'PROJECT' and source_system = '${FEED_SOURCE_SYSTEM}' group by status`);
    const counts: FeedMappingCounts = { PROPOSED: 0, ACTIVE: 0, REJECTED: 0, RETIRED: 0 };
    for (const row of rows) counts[row.status] = Number(row.n);
    return counts;
  }

  /** The project codes of the feed (latest statement of each) that no mapping holds or waits on: what a person maps next. */
  async unmapped(tx: TenantTx, generatorEpoch: number, limit: number): Promise<{ items: FeedUnmapped[]; total: number }> {
    const base = `from (select distinct on (r.channel, r.feed_project_code) r.feed_project_code, r.record ->> 'projectName' as name, r.record ->> 'investorCode' as investor, r.record ->> 'ourProjectCode' as hint, r.as_of::text as as_of
           from machvon.finance_feed_record r where r.kind = 'PROJECT' and (r.channel <> 'GENERATOR' or r.epoch = $1) order by r.channel, r.feed_project_code, r.as_of desc) u
        where not exists (select 1 from machvon.master_crosswalk x where x.source_system = '${FEED_SOURCE_SYSTEM}' and x.external_type = '${FEED_EXTERNAL_TYPE}' and x.external_code = u.feed_project_code and x.status in ('PROPOSED', 'ACTIVE'))`;
    const rows = await tx.query<{ feed_project_code: string; name: string | null; investor: string | null; hint: string | null; as_of: string }>(`select u.* ${base} order by u.feed_project_code limit $2`, [generatorEpoch, limit]);
    const total = await tx.query<{ n: string }>(`select count(*)::text as n ${base}`, [generatorEpoch]);
    return { items: rows.map((row) => ({ feedProjectCode: row.feed_project_code, projectName: row.name, investorCode: row.investor, ourCodeHint: row.hint, asOf: row.as_of })), total: Number(total[0]?.n ?? 0) };
  }

  /** What a mapping of this subject and code would do against the ACTIVE mappings. */
  async outcomeOf(tx: TenantTx, subjectId: string, externalCode: string): Promise<{ outcome: FeedMappingOutcome; heldCode: string | null }> {
    const rows = await tx.query<{ subject_id: string; external_code: string }>(
      `select subject_id, external_code from machvon.master_crosswalk where subject_type = 'PROJECT' and source_system = $1 and external_type = $2 and status = 'ACTIVE' and (external_code = $3 or subject_id = $4::uuid)`,
      [FEED_SOURCE_SYSTEM, FEED_EXTERNAL_TYPE, externalCode, subjectId],
    );
    const sameCode = rows.find((row) => row.external_code === externalCode);
    if (sameCode !== undefined) return { outcome: sameCode.subject_id === subjectId ? 'ALREADY_ACTIVE' : 'EXTERNAL_CODE_TAKEN', heldCode: null };
    const sameSubject = rows.find((row) => row.subject_id === subjectId);
    return sameSubject === undefined ? { outcome: 'CREATE', heldCode: null } : { outcome: 'SUBJECT_HAS_OTHER_CODE', heldCode: sameSubject.external_code };
  }

  /** Whether the same subject and code already wait for a decision. */
  async waiting(tx: TenantTx, subjectId: string, externalCode: string): Promise<boolean> {
    const rows = await tx.query<{ id: string }>(
      `select id from machvon.master_crosswalk where subject_type = 'PROJECT' and source_system = $1 and external_type = $2 and status = 'PROPOSED' and external_code = $3 and subject_id = $4::uuid`,
      [FEED_SOURCE_SYSTEM, FEED_EXTERNAL_TYPE, externalCode, subjectId],
    );
    return rows[0] !== undefined;
  }

  /** Inserts a PROPOSED mapping (the caller has judged it). Returns undefined when the same proposal already waits. */
  async insertProposed(
    tx: TenantTx,
    input: { subject: EgpSubject; externalCode: string; validFrom: string; validUntil: string | null; method: 'MANUAL' | 'EXACT_CODE'; reason: string; importId: string | null },
    actor: string,
  ): Promise<{ id: string } | undefined> {
    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.master_crosswalk
           (tenant_id, id, master_record_id, subject_type, subject_id, source_system, external_type, external_code, valid_from, valid_until, match_method, confidence, status, proposal_reason, import_id, created_by, updated_by)
         values (${TENANT}, $1::uuid, null, 'PROJECT', $2::uuid, $3, $4, $5, $6::date, $7::date, $8, null, 'PROPOSED', $9, $10::uuid, $11::uuid, $11::uuid)`,
        [id, input.subject.id, FEED_SOURCE_SYSTEM, FEED_EXTERNAL_TYPE, input.externalCode, input.validFrom, input.validUntil, input.method === 'EXACT_CODE' ? 'IMPORT' : 'MANUAL', input.reason, input.importId, actor],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) return undefined;
      throw error;
    }
    return { id };
  }

  /** Whether the feed has a project with this code (a mapping to a code nobody sent is not made). */
  async feedCodeExists(tx: TenantTx, externalCode: string): Promise<boolean> {
    const rows = await tx.query<{ n: string }>("select count(*)::text as n from machvon.finance_feed_record where kind = 'PROJECT' and feed_project_code = $1", [externalCode]);
    return Number(rows[0]?.n ?? 0) > 0;
  }

  /**
   * A person proposes a mapping by hand (FEED-03). Our code is resolved to the project it names (422 `our_code`), the feed code must be one the feed has sent (422 `external_code`), and what the mapping would do
   * against the ACTIVE mappings decides: another project holds the code, or the project holds another code, is 409 `CROSSWALK_DUPLICATE` (a mapping is replaced by retiring the old one first).
   */
  async propose(tx: TenantTx, request: FeedMappingRequest & { reason: string }, actor: string, now: Date): Promise<{ row: FeedMappingRow }> {
    const lookup = await resolveEgpSubject(tx, 'PROJECT', request.ourCode, null);
    if ('missing' in lookup) throw new DomainError('VALIDATION_FAILED', 422, 'our_code');
    if (!(await this.feedCodeExists(tx, request.externalCode))) throw new DomainError('VALIDATION_FAILED', 422, 'external_code');
    const validFrom = request.validFrom ?? vietnamDateOf(now);
    if (request.validUntil !== null && request.validUntil <= validFrom) throw new DomainError('VALIDATION_FAILED', 422, 'valid_until');
    const planned = await this.outcomeOf(tx, lookup.found.id, request.externalCode);
    if (planned.outcome !== 'CREATE') throw new DomainError('CROSSWALK_DUPLICATE', 409, 'external_code', { extensions: { reason: planned.outcome } });
    const inserted = await this.insertProposed(tx, { subject: lookup.found, externalCode: request.externalCode, validFrom, validUntil: request.validUntil, method: request.method, reason: request.reason, importId: null }, actor);
    if (inserted === undefined) throw new DomainError('CROSSWALK_DUPLICATE', 409, 'external_code', { extensions: { reason: 'ALREADY_PROPOSED' } });
    return { row: (await this.find(tx, inserted.id)) as FeedMappingRow };
  }

  /**
   * What the apply of a record of the feed that names one of our codes does: nothing when it names none or the mapping already exists or waits, a PROPOSED mapping (the loader is the maker) when it can be made, or a
   * difference for a person when it cannot (our code is not in the register, another project holds the feed code, the project holds another code).
   */
  async proposeFromRecord(tx: TenantTx, input: { feedProjectCode: string; ourCode: string | null; importId: string | null; reason: string; now: Date }, actor: string): Promise<{ outcome: 'NONE' | 'PROPOSED' | 'EXISTS' | FeedMappingOutcome | 'OUR_CODE_UNKNOWN'; heldCode: string | null }> {
    if (input.ourCode === null) return { outcome: 'NONE', heldCode: null };
    const lookup = await resolveEgpSubject(tx, 'PROJECT', input.ourCode, null);
    if ('missing' in lookup) return { outcome: 'OUR_CODE_UNKNOWN', heldCode: null };
    const planned = await this.outcomeOf(tx, lookup.found.id, input.feedProjectCode);
    if (planned.outcome === 'ALREADY_ACTIVE') return { outcome: 'EXISTS', heldCode: null };
    if (planned.outcome !== 'CREATE') return { outcome: planned.outcome, heldCode: planned.heldCode };
    if (await this.waiting(tx, lookup.found.id, input.feedProjectCode)) return { outcome: 'EXISTS', heldCode: null };
    const inserted = await this.insertProposed(tx, { subject: lookup.found, externalCode: input.feedProjectCode, validFrom: vietnamDateOf(input.now), validUntil: null, method: 'EXACT_CODE', reason: input.reason, importId: input.importId }, actor);
    return { outcome: inserted === undefined ? 'EXISTS' : 'PROPOSED', heldCode: null };
  }

  /** Approves, rejects or retires a mapping (a versioned command). The kernel decides the edge, the maker-checker rule and the reason; an approval is judged once more against the ACTIVE mappings. */
  async decide(tx: TenantTx, id: string, expectedVersion: number, step: { move: FeedMappingMove; reason: unknown }, actor: string, now: Date): Promise<{ before: FeedMappingRow; row: FeedMappingRow }> {
    const before = await this.find(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const decided = feedMappingMove({ status: before.status, proposedBy: before.proposedBy }, { move: step.move, actorId: actor, reason: step.reason });
    const today = vietnamDateOf(now);
    try {
      if (step.move === 'RETIRE') {
        await tx.query(
          `update machvon.master_crosswalk
              set status = 'RETIRED', valid_until = least(coalesce(valid_until, 'infinity'::date), greatest($2::date, valid_from + 1)), retired_by = $3::uuid, retired_at = $5::timestamptz, retire_reason = $4,
                  updated_at = now(), updated_by = $3::uuid, version = version + 1
            where id = $1::uuid`,
          [id, today, actor, decided.reason, now.toISOString()],
        );
      } else {
        if (step.move === 'APPROVE') {
          if (before.validUntil !== null && before.validUntil <= today) throw new DomainError('VALIDATION_FAILED', 422, 'valid_until');
          const planned = await this.outcomeOf(tx, before.subjectId, before.externalCode);
          if (planned.outcome !== 'CREATE') throw new DomainError('CROSSWALK_DUPLICATE', 409, 'external_code', { extensions: { reason: planned.outcome } });
        }
        await tx.query(
          `update machvon.master_crosswalk set status = $2, approved_by = $3::uuid, approved_at = $5::timestamptz, decision_reason = $4, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
          [id, decided.to, actor, decided.reason, now.toISOString()],
        );
      }
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('CROSSWALK_DUPLICATE', 409, 'external_code');
      throw error;
    }
    return { before, row: (await this.find(tx, id)) as FeedMappingRow };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The differences between the feed and our own figures.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface FeedDifferenceRow {
  id: string;
  feedProjectCode: string;
  projectId: string | null;
  ourCode: string | null;
  fiscalYear: number;
  field: FeedDifferenceField;
  kind: 'VALUE_MISMATCH' | 'MISSING_OURS';
  feed: string;
  ours: string | null;
  delta: string | null;
  deltaPct: string | null;
  large: boolean;
  state: 'OPEN' | 'RESOLVED';
  ownerId: string;
  makerIds: string[];
  openedBy: string;
  openedAt: string;
  openedAtKey: string;
  dueAt: string;
  resolutionKind: FeedResolutionKind | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  evidenceRef: string | null;
  reviewOn: string | null;
  version: number;
}

interface DifferenceSql {
  id: string;
  feed_project_code: string;
  project_id: string | null;
  our_code: string | null;
  fiscal_year: number;
  field: FeedDifferenceField;
  kind: FeedDifferenceRow['kind'];
  feed_value: string;
  our_value: string | null;
  delta: string | null;
  delta_pct: string | null;
  large: boolean;
  state: 'OPEN' | 'RESOLVED';
  owner_id: string;
  maker_ids: string[];
  opened_by: string;
  opened_at: string;
  opened_at_key: string;
  due_at: string;
  resolution_kind: FeedResolutionKind | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_reason: string | null;
  evidence_ref: string | null;
  review_on: string | null;
  version: string;
}

const DIFFERENCE_SELECT = `select d.id, d.feed_project_code, d.project_id, p.code as our_code, d.fiscal_year, d.field, d.kind, d.feed_value::text as feed_value, d.our_value::text as our_value, d.delta::text as delta, d.delta_pct::text as delta_pct,
  d.large, d.state, d.owner_id, d.maker_ids, d.opened_by, to_char(d.opened_at at time zone 'UTC', ${ISO}) as opened_at, ${timestampKey('d.opened_at')} as opened_at_key, to_char(d.due_at at time zone 'UTC', ${ISO}) as due_at,
  d.resolution_kind, d.resolved_by, to_char(d.resolved_at at time zone 'UTC', ${ISO}) as resolved_at, d.resolution_reason, d.evidence_ref, d.review_on::text as review_on, d.version::text as version
  from machvon.finance_feed_difference d left join machvon.project p on p.tenant_id = d.tenant_id and p.id = d.project_id`;

/** Exact decimal text of a numeric(30,2) without trailing zeros. */
const plain = (value: string | null): string | null => (value === null ? null : value.includes('.') ? value.replace(/\.?0+$/, '') : value);

const differenceOf = (row: DifferenceSql): FeedDifferenceRow => ({
  id: row.id,
  feedProjectCode: row.feed_project_code,
  projectId: row.project_id,
  ourCode: row.our_code,
  fiscalYear: row.fiscal_year,
  field: row.field,
  kind: row.kind,
  feed: plain(row.feed_value) as string,
  ours: plain(row.our_value),
  delta: plain(row.delta),
  deltaPct: row.delta_pct,
  large: row.large,
  state: row.state,
  ownerId: row.owner_id,
  makerIds: row.maker_ids,
  openedBy: row.opened_by,
  openedAt: row.opened_at,
  openedAtKey: row.opened_at_key,
  dueAt: row.due_at,
  resolutionKind: row.resolution_kind,
  resolvedBy: row.resolved_by,
  resolvedAt: row.resolved_at,
  resolutionReason: row.resolution_reason,
  evidenceRef: row.evidence_ref,
  reviewOn: row.review_on,
  version: Number(row.version),
});

/** The item as the pure rules judge it. */
export const feedItemOf = (row: FeedDifferenceRow): FeedDifferenceItem => ({
  feedProjectCode: row.feedProjectCode,
  fiscalYear: row.fiscalYear,
  field: row.field,
  kind: row.kind,
  feed: row.feed,
  ours: row.ours,
  delta: row.delta,
  deltaPct: row.deltaPct,
  large: row.large,
  state: row.state,
  ownerId: row.ownerId,
  makerIds: row.makerIds,
  openedAt: row.openedAt,
  dueAt: row.dueAt,
  resolution:
    row.resolutionKind === null || row.resolvedBy === null || row.resolvedAt === null
      ? null
      : { kind: row.resolutionKind, resolvedById: row.resolvedBy, resolvedAt: row.resolvedAt, reason: row.resolutionReason ?? '', evidenceRef: row.evidenceRef, reviewOn: row.reviewOn },
});

export interface FeedReconciliationResult {
  id: string;
  fiscalYear: number;
  projectsCompared: number;
  figuresCompared: number;
  opened: FeedDifferenceRow[];
  existing: number;
  skippedOwnerIsMaker: string[];
}

export interface FeedDifferenceCounts {
  open: number;
  openLarge: number;
  resolved: number;
  comparedLatest: number | null;
}

/**
 * Our own figures for a project of ours and a fiscal year: the plan and the disbursement reported in the latest frozen DIS snapshot of the year, and the disbursement confirmed by the Treasury statements in the
 * year (payments less refunds). A figure we do not hold is null. The people who made them (who froze the snapshot) are returned so that none of them settles a difference about them.
 */
export async function ownFigures(tx: TenantTx, projectId: string, fiscalYear: number): Promise<{ figures: FeedOwnFigures; makers: string[] }> {
  const snapshot = await tx.query<{ plan: string | null; disbursed: string | null; frozen_by: string | null; created_by: string }>(
    `select sum(l.plan_total_vnd)::text as plan, sum(l.disbursed_reported_vnd)::text as disbursed, s.frozen_by, s.created_by
       from machvon.period_snapshot s join machvon.period_snapshot_line l on l.tenant_id = s.tenant_id and l.snapshot_id = s.id
      where s.status = 'FROZEN' and l.project_id = $1::uuid and s.as_of_date between make_date($2::int, 1, 1) and make_date($2::int, 12, 31)
      group by s.id, s.as_of_date, s.frozen_by, s.created_by order by s.as_of_date desc, s.id limit 1`,
    [projectId, fiscalYear],
  );
  const treasury = await tx.query<{ total: string | null }>(
    `select sum(case t.direction when 'REFUND' then -t.amount_vnd else t.amount_vnd end)::text as total from machvon.treasury_transaction t
      where t.project_id = $1::uuid and (t.confirmed_at at time zone 'Asia/Ho_Chi_Minh')::date between make_date($2::int, 1, 1) and make_date($2::int, 12, 31)`,
    [projectId, fiscalYear],
  );
  const row = snapshot[0];
  const makers = row === undefined ? [] : [row.frozen_by, row.created_by].filter((id): id is string => id !== null);
  return { figures: { planDis: row?.plan ?? null, disbursedDis: row?.disbursed ?? null, disbursedTreasury: treasury[0]?.total ?? null }, makers: [...new Set(makers)] };
}

/**
 * The differences between the feed and our own figures (FEED-04). A reconciliation compares every ACTIVE-mapped project of the feed for a fiscal year with our figures and opens one item for each figure that differs by
 * more than the tolerance of the policy, with an OWNER (the person named by the command) and the MAKERS (who loaded the feed's records of the project and who froze our snapshot). A project whose makers include the owner
 * is not opened (it is listed, for the command to be repeated with another owner). An item is settled once, by a person who is not a maker, with one of four resolutions and a reason; the database holds the same rules.
 */
export class FeedDifferenceStore {
  private readonly records = new FeedRecordStore();

  async find(tx: TenantTx, id: string, lock = false): Promise<FeedDifferenceRow | undefined> {
    const rows = await tx.query<DifferenceSql>(`${DIFFERENCE_SELECT} where d.id = $1::uuid${lock ? ' for update of d' : ''}`, [id]);
    return rows[0] === undefined ? undefined : differenceOf(rows[0]);
  }

  async list(tx: TenantTx, filter: { state?: 'OPEN' | 'RESOLVED' | undefined; large?: boolean | undefined; q?: string | undefined; fiscalYear?: number | undefined }, request: { limit: number; after: { key: string; id: string } | undefined }): Promise<FeedDifferenceRow[]> {
    const like = filter.q === undefined ? null : `%${filter.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const rows = await tx.query<DifferenceSql>(
      `select * from (${DIFFERENCE_SELECT}) d
        where ($1::text is null or d.state = $1) and ($2::boolean is null or d.large = $2) and ($3::text is null or d.feed_project_code ilike $3 escape '\\' or d.our_code ilike $3 escape '\\')
          and ($4::int is null or d.fiscal_year = $4) and ($5::text is null or (d.opened_at_key, d.id) < ($5::text, $6::uuid))
        order by d.opened_at_key desc, d.id desc limit $7`,
      [filter.state ?? null, filter.large ?? null, like, filter.fiscalYear ?? null, request.after?.key ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(differenceOf);
  }

  async counts(tx: TenantTx, fiscalYear: number | undefined): Promise<FeedDifferenceCounts> {
    const rows = await tx.query<{ state: string; large: boolean; n: string }>('select state, large, count(*)::text as n from machvon.finance_feed_difference where ($1::int is null or fiscal_year = $1) group by state, large', [fiscalYear ?? null]);
    const counts: FeedDifferenceCounts = { open: 0, openLarge: 0, resolved: 0, comparedLatest: null };
    for (const row of rows) {
      if (row.state === 'OPEN') {
        counts.open += Number(row.n);
        if (row.large) counts.openLarge += Number(row.n);
      } else counts.resolved += Number(row.n);
    }
    if (fiscalYear !== undefined) {
      const last = await tx.query<{ figures_compared: number }>('select figures_compared from machvon.finance_feed_reconciliation where fiscal_year = $1 order by created_at desc, id desc limit 1', [fiscalYear]);
      counts.comparedLatest = last[0]?.figures_compared ?? null;
    }
    return counts;
  }

  /** The keys of the open differences above the large line: what the alert FEED_DISCREPANCY_LARGE is about. */
  async openLarge(tx: TenantTx, limit: number): Promise<FeedDifferenceRow[]> {
    const rows = await tx.query<DifferenceSql>(`${DIFFERENCE_SELECT} where d.state = 'OPEN' and d.large order by d.opened_at desc, d.id limit $1`, [limit]);
    return rows.map(differenceOf);
  }

  /**
   * Compares the feed with our own figures for a fiscal year and opens an item for each figure that differs. `epoch` is the current epoch of the generator. The owner must not be a maker of the project's figures
   * (the project is skipped and named otherwise). A difference that is already open is left as it is (the same piece of work); the run is recorded with what it covered.
   */
  async reconcile(tx: TenantTx, input: { fiscalYear: number; epoch: number; policy: FeedPolicy; ownerId: string; actor: string; now: Date }): Promise<FeedReconciliationResult> {
    const mappings = await tx.query<{ subject_id: string; external_code: string }>(
      `select subject_id, external_code from machvon.master_crosswalk where subject_type = 'PROJECT' and source_system = $1 and external_type = $2 and status = 'ACTIVE' order by external_code`,
      [FEED_SOURCE_SYSTEM, FEED_EXTERNAL_TYPE],
    );
    const records = await this.records.load(tx, { generatorEpoch: input.epoch, fiscalYear: input.fiscalYear, kinds: ['PROJECT', 'PLAN', 'DISBURSEMENT'] });
    const facts = foldFeedFacts(records, { fiscalYear: input.fiscalYear });
    const opened: FeedDifferenceRow[] = [];
    const skipped: string[] = [];
    let existing = 0;
    let projects = 0;
    let figures = 0;
    for (const mapping of mappings) {
      const matching = facts.filter((fact) => fact.feedProjectCode === mapping.external_code);
      if (matching.length === 0) continue;
      const plan = matching.reduce((sum, fact) => sum + Object.values(fact.planByFund).reduce((a, b) => a + b, 0n), 0n);
      const disbursed = matching.reduce((sum, fact) => sum + Object.values(fact.disbursedByFund).reduce((a, b) => a + b, 0n), 0n);
      const own = await ownFigures(tx, mapping.subject_id, input.fiscalYear);
      const { differences, compared } = diffFeedFigures({ feed: { plan: feedAmountText(plan), disbursed: feedAmountText(disbursed) }, ours: own.figures, policy: input.policy });
      projects += 1;
      figures += compared;
      if (differences.length === 0) continue;
      const loaders = await tx.query<{ applied_by: string }>('select distinct applied_by from machvon.finance_feed_record where feed_project_code = $1', [mapping.external_code]);
      const makers = [...new Set([...loaders.map((row) => row.applied_by), ...own.makers])];
      if (pickFeedDifferenceOwner([input.ownerId], makers) === undefined) {
        skipped.push(mapping.external_code);
        continue;
      }
      const dueAt = new Date(input.now.getTime() + input.policy.difference_due_days * 86_400_000);
      const items = openFeedDifferences({ feedProjectCode: mapping.external_code, fiscalYear: input.fiscalYear, differences, ownerId: input.ownerId, makerIds: makers, openedAt: input.now, dueAt });
      for (const item of items) {
        const done = await this.insertOpen(tx, item, mapping.subject_id, input.actor);
        if (done === undefined) existing += 1;
        else opened.push(done);
      }
    }
    const id = randomUUID();
    await tx.query(
      `insert into machvon.finance_feed_reconciliation (tenant_id, id, fiscal_year, projects_compared, figures_compared, differences_opened, differences_existing, skipped_owner_is_maker, owner_id, run_by)
       values (${TENANT}, $1::uuid, $2, $3, $4, $5, $6, $7, $8::uuid, $9::uuid)`,
      [id, input.fiscalYear, projects, figures, opened.length, existing, skipped.length, input.ownerId, input.actor],
    );
    return { id, fiscalYear: input.fiscalYear, projectsCompared: projects, figuresCompared: figures, opened, existing, skippedOwnerIsMaker: skipped };
  }

  private async insertOpen(tx: TenantTx, item: FeedDifferenceItem, projectId: string, actor: string): Promise<FeedDifferenceRow | undefined> {
    const rows = await tx.query<{ id: string }>(
      `insert into machvon.finance_feed_difference (tenant_id, id, feed_project_code, project_id, fiscal_year, field, kind, feed_value, our_value, delta, delta_pct, large, owner_id, maker_ids, opened_by, opened_at, due_at)
       values (${TENANT}, gen_random_uuid(), $1, $2::uuid, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9::numeric, $10, $11::uuid, $12::uuid[], $13::uuid, $14::timestamptz, $15::timestamptz)
       on conflict (tenant_id, feed_project_code, fiscal_year, field) where state = 'OPEN' do nothing returning id`,
      [item.feedProjectCode, projectId, item.fiscalYear, item.field, item.kind, item.feed, item.ours, item.delta, item.deltaPct, item.large, item.ownerId, item.makerIds, actor, item.openedAt, item.dueAt],
    );
    return rows[0] === undefined ? undefined : await this.find(tx, rows[0].id);
  }

  /** Settles an item (a versioned command). The kernel decides: already settled, a maker, the reason, the evidence and the review day. */
  async resolve(tx: TenantTx, id: string, expectedVersion: number, resolution: { kind: FeedResolutionKind; reason: string; evidenceRef?: string | null; reviewOn?: string | null }, actor: string, now: Date): Promise<{ before: FeedDifferenceRow; row: FeedDifferenceRow }> {
    const before = await this.find(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const settled = resolveFeedDifference(feedItemOf(before), { kind: resolution.kind, resolvedById: actor, at: now, reason: resolution.reason, evidenceRef: resolution.evidenceRef ?? null, reviewOn: resolution.reviewOn ?? null });
    const done = settled.resolution as NonNullable<FeedDifferenceItem['resolution']>;
    await tx.query(
      `update machvon.finance_feed_difference set state = 'RESOLVED', resolution_kind = $2, resolved_by = $3::uuid, resolved_at = $4::timestamptz, resolution_reason = $5, evidence_ref = $6, review_on = $7::date, version = version + 1 where id = $1::uuid`,
      [id, done.kind, actor, now.toISOString(), done.reason, done.evidenceRef, done.reviewOn],
    );
    return { before, row: (await this.find(tx, id)) as FeedDifferenceRow };
  }
}

export type { FeedFieldDifference };
