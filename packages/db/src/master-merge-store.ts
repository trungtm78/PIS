import { randomUUID } from 'node:crypto';
import { DomainError, checkSurvivorshipRule, mergeRecords, unmergeSurvivor, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { AttributeDecision, MergeRecord, SurvivorshipRuleInput } from '@machvon/kernel';
import { WORKER_MEMBERSHIP_ID } from './consumer-inbox.ts';
import { cursorFor, cursorOf } from './dgv-keyset.ts';
import { MasterStore, contentHashOf } from './master-store.ts';
import type { MasterContent } from './master-store.ts';
import { entryOfRecord, isRuleType, tenantLookup, validateMasterContent } from './master-types.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The merge of master records and its undoing (ST-MDM-010, MDM 3.1 F5, BR-MDM-05, MDM-30, MDM-35, MDM-36): the rules of survivorship (versions, published by somebody other than who drafted them), the merge of two
 * entries of a type into one, attribute by attribute, and the undoing of it. A checker merges and unmerges; neither is done by the person who made either entry. History is not rewritten: the versions that were in force
 * end where the merge starts and the new ones start there; the references that are alive (the crosswalks that are ACTIVE, the contractors that point at the entry) are pointed again and listed so that they can be
 * pointed back; the references of the past (projects, reports, transactions) keep the version they were made against, and are read through the alias.
 */
export const SURVIVORSHIP_RULE_RESOURCE = 'survivorship_rule';
export const MASTER_MERGE_RESOURCE = 'master_merge';
const MAX_PAGE = 200;
const MAX_REASON = 2000;
const MIN_REASON = 10;

/** The alias a merge keeps (`alias_json`): what the merged entry and the survivor were, so that the past is read through it and an unmerge can put them back. */
export interface MergeAlias {
  merged: { business_key: string; label: string; version_id: string; source_system: string | null; valid_until: string | null };
  survivor: {
    version_before_id: string;
    version_after_id: string;
    label: string;
    attributes: Record<string, unknown>;
    source_system: string | null;
    recorded_at: string;
    label_after: string;
    attributes_after: Record<string, unknown>;
  };
  day: string;
}

interface Sql {
  [column: string]: unknown;
  id: string;
  master_type: string;
  attribute_name: string;
  strategy: string;
  status: "DRAFT" | "PUBLISHED" | "RETIRED" | "APPLIED" | "REVERTED";
  effective_from: string;
  approved_by: string | null;
  created_by: string;
  created_raw: string;
  survivor_record_id: string;
  survivor_key: string;
  merged_record_id: string;
  merged_key: string;
  alias_json: MergeAlias;
  repointed_refs_json: RepointedReference[];
  reason: string;
  change_request_id: string;
  applied_raw: string;
  reverted_by: string | null;
  reverted_raw: string | null;
  revert_reason: string | null;
  label: string;
  attributes: Record<string, unknown>;
  valid_from: string;
  valid_until: string | null;
  source_system: string | null;
  recorded_at: string;
  parent_id: string | null;
  legal_basis: string | null;
  source_priority: string[] | null;
}

export interface SurvivorshipRule {
  id: string;
  masterType: string;
  attributeName: string;
  strategy: string;
  sourcePriority: string[];
  revision: number;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  effectiveFrom: string;
  approvedBy: string | null;
  createdBy: string;
  createdAt: string;
  version: number;
}

export interface RepointedReference {
  table: 'master_crosswalk' | 'contractor';
  column: 'master_record_id';
  id: string;
}

export interface MasterMerge {
  id: string;
  survivorRecordId: string;
  survivorKey: string;
  mergedRecordId: string;
  mergedKey: string;
  masterType: string;
  survivorship: { decisions: AttributeDecision[]; overrides: Record<string, string> };
  alias: MergeAlias;
  repointed: RepointedReference[];
  reason: string;
  changeRequestId: string;
  status: 'APPLIED' | 'REVERTED';
  appliedAt: string;
  revertedBy: string | null;
  revertedAt: string | null;
  revertReason: string | null;
  createdBy: string;
  createdAt: string;
  version: number;
}

export interface Page<T> {
  items: T[];
  next: string | null;
}

export interface MasterMergeOutcome {
  merge: MasterMerge;
  survivorVersion: number;
  survivorVersionId: string;
}

export interface MasterUnmergeOutcome {
  merge: MasterMerge;
  reverted: string[];
  kept: string[];
  restored: RepointedReference[];
  notRestored: RepointedReference[];
}

interface RecordLock {
  id: string;
  namespace: string;
  master_type: string;
  business_key: string;
  status: string;
  current_version_id: string | null;
  merged_into_id: string | null;
  created_by: string;
  version: string;
}

interface VersionSnapshot {
  id: string;
  revision: number;
  label: string;
  attributes: Record<string, unknown>;
  validFrom: string;
  validUntil: string | null;
  sourceSystem: string | null;
  recordedAt: string;
  parentId: string | null;
  legalBasis: string | null;
}

const RULE_SELECT = `select r.id, r.master_type, r.attribute_name, r.strategy, r.source_priority, r.revision, r.status, r.effective_from::text as effective_from, r.approved_by, r.created_by, r.created_at::text as created_raw,
  r.version::text as version from machvon.survivorship_rule r`;

const MERGE_SELECT = `select m.id, m.survivor_record_id, sr.business_key as survivor_key, m.merged_record_id, mr.business_key as merged_key, sr.master_type, m.survivorship_json, m.alias_json, m.repointed_refs_json, m.reason,
  m.change_request_id, m.status, m.applied_at::text as applied_raw, m.reverted_by, m.reverted_at::text as reverted_raw, m.revert_reason, m.created_by, m.created_at::text as created_raw, m.version::text as version
  from machvon.master_merge m join machvon.master_record sr on sr.tenant_id = m.tenant_id and sr.id = m.survivor_record_id join machvon.master_record mr on mr.tenant_id = m.tenant_id and mr.id = m.merged_record_id`;

const ruleOf = (row: Sql): SurvivorshipRule => ({
  id: row.id,
  masterType: row.master_type,
  attributeName: row.attribute_name,
  strategy: row.strategy,
  sourcePriority: row.source_priority ?? [],
  revision: Number(row.revision),
  status: row.status as "DRAFT" | "PUBLISHED" | "RETIRED",
  effectiveFrom: row.effective_from,
  approvedBy: row.approved_by,
  createdBy: row.created_by,
  createdAt: row.created_raw,
  version: Number(row.version),
});

const mergeOf = (row: Sql): MasterMerge => ({
  id: row.id,
  survivorRecordId: row.survivor_record_id,
  survivorKey: row.survivor_key,
  mergedRecordId: row.merged_record_id,
  mergedKey: row.merged_key,
  masterType: row.master_type,
  survivorship: row.survivorship_json as { decisions: AttributeDecision[]; overrides: Record<string, string>; },
  alias: row.alias_json,
  repointed: row.repointed_refs_json,
  reason: row.reason,
  changeRequestId: row.change_request_id,
  status: row.status as "APPLIED" | "REVERTED",
  appliedAt: row.applied_raw,
  revertedBy: row.reverted_by,
  revertedAt: row.reverted_raw,
  revertReason: row.revert_reason,
  createdBy: row.created_by,
  createdAt: row.created_raw,
  version: Number(row.version),
});

const addDays = (day: string, days: number): string => {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
};
const latest = (...days: string[]): string => days.reduce((a, b) => (a >= b ? a : b));

function reasonOf(value: string): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < MIN_REASON || reason.length > MAX_REASON || reason.includes('\0')) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  return reason;
}

export class MasterMergeStore {
  private readonly masters = new MasterStore();

  // --- the rules of survivorship ---------------------------------------------------------------------------------------------------------------

  /** Drafts the next revision of the rule for an attribute of a type. */
  async createRule(
    tx: TenantTx,
    input: { masterType: string; attributeName: string; strategy: string; sourcePriority: readonly string[] | undefined; effectiveFrom: string },
    actor: string,
  ): Promise<SurvivorshipRule> {
    const checked = checkSurvivorshipRule(input);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom) || Number.isNaN(Date.parse(input.effectiveFrom))) throw new DomainError('VALIDATION_FAILED', 422, 'effective_from');
    await tx.query("select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id', true) || ':survivorship:' || $1 || ':' || $2, 0))", [checked.masterType, checked.attributeName]);
    const next = await tx.query<{ revision: number }>('select coalesce(max(revision), 0) + 1 as revision from machvon.survivorship_rule where master_type = $1 and attribute_name = $2', [
      checked.masterType,
      checked.attributeName,
    ]);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.survivorship_rule (tenant_id, id, master_type, attribute_name, strategy, source_priority, revision, status, effective_from, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5::text[], $6::int, 'DRAFT', $7::date, $8::uuid, $8::uuid)`,
      [id, checked.masterType, checked.attributeName, checked.strategy, checked.sourcePriority, Number(next[0]?.revision ?? 1), input.effectiveFrom, actor],
    );
    return (await this.findRule(tx, id)) as SurvivorshipRule;
  }

  async findRule(tx: TenantTx, id: string): Promise<SurvivorshipRule | undefined> {
    const rows = await tx.query<Sql>(`${RULE_SELECT} where r.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : ruleOf(rows[0]);
  }

  async listRules(tx: TenantTx, filter: { masterType?: string | undefined; status?: string | undefined; cursor?: string | undefined; limit: number }): Promise<Page<SurvivorshipRule>> {
    if (filter.status !== undefined && !['DRAFT', 'PUBLISHED', 'RETIRED'].includes(filter.status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const limit = Math.min(filter.limit, MAX_PAGE);
    const after = cursorOf(filter.cursor);
    const rows = await tx.query<Sql>(
      `${RULE_SELECT} where ($1::text is null or r.master_type = $1) and ($2::text is null or r.status = $2) and ($3::timestamptz is null or (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
        order by r.created_at desc, r.id desc limit $5::int`,
      [filter.masterType ?? null, filter.status ?? null, after?.at ?? null, after?.id ?? null, limit + 1],
    );
    const page = rows.slice(0, limit).map(ruleOf);
    const last = page[page.length - 1];
    return { items: page, next: rows.length > limit && last !== undefined ? cursorFor(last.createdAt, last.id) : null };
  }

  /**
   * Publishes a draft against the version the caller read (404, 409 `VERSION_CONFLICT`, 409 `STAGE_TRANSITION_DENIED`, 403 `SELF_APPROVAL_DENIED`). The older revisions it replaces are RETIRED, but only those it replaces
   * on every day they would decide: a revision published for a later day leaves the one in force deciding until that day. A draft that a later revision already overrides from its own day is refused (409 `STAGE_TRANSITION_DENIED`).
   */
  async publishRule(tx: TenantTx, id: string, expected: number, actor: string): Promise<{ rule: SurvivorshipRule; retiredIds: string[] }> {
    const named = await tx.query<{ master_type: string; attribute_name: string }>('select master_type, attribute_name from machvon.survivorship_rule where id = $1::uuid', [id]);
    if (named[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await tx.query("select pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id', true) || ':survivorship:' || $1 || ':' || $2, 0))", [named[0].master_type, named[0].attribute_name]);
    const rows = await tx.query<Sql>(
      'select status, created_by, revision, effective_from::text as effective_from, version::text as version from machvon.survivorship_rule where id = $1::uuid for update',
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expected) throw versionConflict(Number(row.version));
    if (row.status !== 'DRAFT') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    if (row.created_by === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    const overridden = await tx.query(
      "select 1 from machvon.survivorship_rule where master_type = $1 and attribute_name = $2 and status = 'PUBLISHED' and revision > $3::int and effective_from <= $4::date",
      [named[0].master_type, named[0].attribute_name, row.revision, row.effective_from],
    );
    if (overridden.length > 0) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'overridden');
    const before = await tx.query<{ id: string }>(
      `update machvon.survivorship_rule set status = 'RETIRED', updated_at = now(), updated_by = $3::uuid, version = version + 1
        where master_type = $1 and attribute_name = $2 and status = 'PUBLISHED' and revision < $4::int and (effective_from >= $5::date or $5::date <= $6::date) returning id`,
      [named[0].master_type, named[0].attribute_name, actor, row.revision, row.effective_from, vietnamDateOf(new Date())],
    );
    await tx.query("update machvon.survivorship_rule set status = 'PUBLISHED', approved_by = $2::uuid, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [
      id,
      actor,
    ]);
    return { rule: (await this.findRule(tx, id)) as SurvivorshipRule, retiredIds: before.map((retired) => retired.id) };
  }

  /** The rules in force for a type on a day: for each attribute, the latest published revision whose day has come. */
  private async rulesInForce(tx: TenantTx, masterType: string, day: string): Promise<Map<string, SurvivorshipRuleInput>> {
    const rows = await tx.query<{ attribute_name: string; strategy: string; source_priority: string[] | null }>(
      `select distinct on (attribute_name) attribute_name, strategy, source_priority from machvon.survivorship_rule
        where master_type = $1 and status = 'PUBLISHED' and effective_from <= $2::date order by attribute_name, revision desc`,
      [masterType, day],
    );
    return new Map(rows.map((row) => [row.attribute_name, { strategy: row.strategy as SurvivorshipRuleInput['strategy'], sourcePriority: row.source_priority ?? [] }]));
  }

  // --- the merge -------------------------------------------------------------------------------------------------------------------------------

  private async lockRecords(tx: TenantTx, ids: readonly string[]): Promise<Map<string, RecordLock>> {
    const rows = await tx.query<RecordLock>(
      `select id, namespace, master_type, business_key, status, current_version_id, merged_into_id, created_by, version::text as version
         from machvon.master_record where id = any($1::uuid[]) order by id for update`,
      [[...ids]],
    );
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async snapshotOf(tx: TenantTx, versionId: string): Promise<VersionSnapshot> {
    const rows = await tx.query<Sql>(
      `select id, revision, label, attributes, valid_from::text as valid_from, valid_until::text as valid_until, source_system, coalesce(published_at, created_at)::text as recorded_at, parent_id, legal_basis
         from machvon.master_record_version where id = $1::uuid`,
      [versionId],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'no version in force');
    return {
      id: row.id,
      revision: Number(row.revision),
      label: row.label,
      attributes: row.attributes,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      sourceSystem: row.source_system,
      recordedAt: row.recorded_at,
      parentId: row.parent_id,
      legalBasis: row.legal_basis,
    };
  }

  private asMergeRecord(snapshot: VersionSnapshot): MergeRecord {
    return { label: snapshot.label, attributes: snapshot.attributes, sourceSystem: snapshot.sourceSystem, recordedAt: snapshot.recordedAt };
  }

  /**
   * A change request that the merge or the unmerge stands on. There is no maker: the platform proposes it (the system member made it) and the checker who does the work decided it, so it is APPLIED at once without a decision document (the table allows that for a merge and an
   * unmerge alone), and the table's rule that who decides did not make holds.
   */
  private async recordChange(
    tx: TenantTx,
    kind: 'MERGE' | 'UNMERGE',
    masterType: string,
    recordId: string,
    input: { reason: string; proposed: unknown; before: unknown; impact: unknown; day: string },
    actor: string,
  ): Promise<string> {
    const id = randomUUID();
    await tx.query(
      `insert into machvon.master_change_request (tenant_id, id, change_kind, master_type, master_record_id, proposed_json, before_json, reason, impact_json, effective_from, status, reviewed_by, decided_at, published_by, published_at, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::uuid, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9::date, 'APPLIED', $10::uuid, now(), $10::uuid, now(), $11::uuid, $11::uuid)`,
      [id, kind, masterType, recordId, JSON.stringify(input.proposed), JSON.stringify(input.before), input.reason, JSON.stringify(input.impact), input.day, actor, WORKER_MEMBERSHIP_ID],
    );
    return id;
  }

  /**
   * Ends the version in force at `day` and starts the next one there, as a publication does; returns the id of the new version. The new version keeps the end date it is given (the lifetime the entry was approved for), which has to come after `day`
   * (409 `STAGE_TRANSITION_DENIED` otherwise: the entry has run out), and meets the rules of its type like any version (422 naming the field).
   */
  private async succeed(
    tx: TenantTx,
    record: { id: string; masterType: string; businessKey: string },
    current: VersionSnapshot,
    content: { label: string; attributes: Record<string, unknown>; sourceSystem: string | null; validUntil: string | null },
    day: string,
    changeRequestId: string,
    actor: string,
  ): Promise<string> {
    if (content.validUntil !== null && content.validUntil <= day) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'valid_until');
    const body: MasterContent = {
      label: content.label,
      attributes: content.attributes,
      parentRecordId: current.parentId,
      validFrom: day,
      validUntil: content.validUntil,
      legalBasis: current.legalBasis,
    };
    const parent = body.parentRecordId === null ? undefined : await entryOfRecord(tx, body.parentRecordId);
    await validateMasterContent({ masterType: record.masterType, businessKey: record.businessKey, content: body, parent, lookup: tenantLookup(tx) });
    if (current.validUntil === null || current.validUntil > day) {
      await tx.query('update machvon.master_record_version set valid_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [current.id, day, actor]);
    }
    const created = await tx.query<{ id: string }>(
      `insert into machvon.master_record_version
         (tenant_id, id, master_record_id, master_type, code, revision, label, parent_id, attributes, valid_from, valid_until, status, namespace, supersedes_id, change_request_id, legal_basis, content_sha256,
          published_at, approved_by, source_system, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6::uuid, $7::jsonb, $8::date, $15::date, 'EFFECTIVE', 'TENANT', $9::uuid, $10::uuid, $11, $12,
          now(), $13::uuid, $14, $13::uuid, $13::uuid) returning id`,
      [
        record.id,
        record.masterType,
        record.businessKey,
        current.revision + 1,
        body.label,
        body.parentRecordId,
        JSON.stringify(body.attributes),
        day,
        current.id,
        changeRequestId,
        body.legalBasis,
        contentHashOf(record.masterType, record.businessKey, body),
        actor,
        content.sourceSystem,
        content.validUntil,
      ],
    );
    return (created[0] as { id: string }).id;
  }

  private async assertMergeable(tx: TenantTx, record: RecordLock, actor: string): Promise<void> {
    if (record.namespace !== 'TENANT') throw new DomainError('POLICY_LOCKED', 403);
    const policy = await this.masters.policyOf(tx, record.master_type);
    if (policy.scope === 'PLATFORM_ONLY') throw new DomainError('POLICY_LOCKED', 403);
    // Rule data is decided by the owner of the module that applies it (BR-MDM-09): merging it is no way round that.
    if (isRuleType(record.master_type) && (await tx.query('select 1 from machvon.master_type_approver where master_type = $1 and membership_id = $2::uuid', [record.master_type, actor])).length === 0)
      throw new DomainError('SCOPE_DENIED', 403, 'master_type');
    if (record.created_by === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  }

  /** A record with a change that is open, or a published one that waits for its day, is not merged: the merge would end the version in force under it (409 `STAGE_TRANSITION_DENIED`). */
  private async assertNothingWaiting(tx: TenantTx, recordId: string, currentRevision: number, today: string): Promise<void> {
    const waiting = await tx.query(
      `select 1 from machvon.master_record_version where master_record_id = $1::uuid and revision > $2::int
        union all select 1 from machvon.master_change_request where master_record_id = $1::uuid
          and (status in ('DRAFT', 'IN_REVIEW', 'APPROVED') or (change_kind in ('RETIRE', 'SUCCESSION') and status = 'APPLIED' and effective_from > $3::date))`,
      [recordId, currentRevision, today],
    );
    if (waiting.length > 0) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'a change is waiting');
  }

  /**
   * Merges `mergedId` into the survivor against the version of the survivor the caller read. The order of the refusals: 404, 409 `VERSION_CONFLICT`, 422 on the merged record (itself, another type), 403 `POLICY_LOCKED`
   * (an entry of the platform, or a type the tenant does not own), 403 `SELF_APPROVAL_DENIED` (the person who made either entry), 409 `STAGE_TRANSITION_DENIED` (an entry that is not in force), 409 `MERGE_CONFLICT` (an attribute
   * no rule settles and no override does).
   */
  async merge(tx: TenantTx, survivorId: string, expected: number, input: { mergedRecordId: string; reason: string; overrides: Record<string, unknown> }, actor: string): Promise<MasterMergeOutcome> {
    if (input.mergedRecordId === survivorId) throw new DomainError('VALIDATION_FAILED', 422, 'merged_record_id');
    const locked = await this.lockRecords(tx, [survivorId, input.mergedRecordId]);
    const survivor = locked.get(survivorId);
    if (survivor === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(survivor.version) !== expected) throw versionConflict(Number(survivor.version));
    const merged = locked.get(input.mergedRecordId);
    if (merged === undefined || merged.master_type !== survivor.master_type) throw new DomainError('VALIDATION_FAILED', 422, 'merged_record_id');
    const reason = reasonOf(input.reason);
    await this.assertMergeable(tx, survivor, actor);
    await this.assertMergeable(tx, merged, actor);
    if (survivor.status !== 'EFFECTIVE' || merged.status !== 'EFFECTIVE' || survivor.current_version_id === null || merged.current_version_id === null)
      throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    const today = vietnamDateOf(new Date());
    const survivorBefore = await this.snapshotOf(tx, survivor.current_version_id);
    const mergedBefore = await this.snapshotOf(tx, merged.current_version_id);
    await this.assertNothingWaiting(tx, survivor.id, survivorBefore.revision, today);
    await this.assertNothingWaiting(tx, merged.id, mergedBefore.revision, today);
    // The day the merge takes effect decides which rules apply and whether both entries are still alive.
    const day = latest(today, addDays(survivorBefore.validFrom, 1), addDays(mergedBefore.validFrom, 1));
    // A version cannot end the day it starts, so an entry whose version began today is merged from tomorrow on: the merge is not made today, and nothing is half done.
    if (day > today) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'the entry began today');
    if (mergedBefore.validUntil !== null && mergedBefore.validUntil <= day) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'valid_until');
    const rules = await this.rulesInForce(tx, survivor.master_type, day);
    const result = mergeRecords(this.asMergeRecord(survivorBefore), this.asMergeRecord(mergedBefore), rules, input.overrides);
    const repointed = await this.repoint(tx, merged.id, survivor.id, actor);
    const changeRequestId = await this.recordChange(
      tx,
      'MERGE',
      survivor.master_type,
      survivor.id,
      {
        reason,
        proposed: { merged_record_id: merged.id, label: result.label, attributes: result.attributes },
        before: { survivor: { label: survivorBefore.label, attributes: survivorBefore.attributes }, merged: { label: mergedBefore.label, attributes: mergedBefore.attributes } },
        impact: { repointed: repointed.length },
        day,
      },
      actor,
    );
    const versionId = await this.succeed(
      tx,
      { id: survivor.id, masterType: survivor.master_type, businessKey: survivor.business_key },
      survivorBefore,
      { label: result.label, attributes: result.attributes, sourceSystem: survivorBefore.sourceSystem, validUntil: survivorBefore.validUntil },
      day,
      changeRequestId,
      actor,
    );
    await tx.query('update machvon.master_record set current_version_id = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [
      survivor.id,
      versionId,
      actor,
    ]);
    // The entry that was merged away ends where the merge starts; it stays what it was in the past and is read through the alias.
    await tx.query(
      "update machvon.master_record_version set status = 'RETIRED', valid_until = case when valid_until is null or valid_until > $2::date then $2::date else valid_until end, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid",
      [mergedBefore.id, day, actor],
    );
    await tx.query("update machvon.master_record set status = 'MERGED', merged_into_id = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid", [
      merged.id,
      survivor.id,
      actor,
    ]);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.master_merge (tenant_id, id, survivor_record_id, merged_record_id, survivorship_json, alias_json, repointed_refs_json, reason, change_request_id, status, applied_at, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8::uuid, 'APPLIED', now(), $9::uuid, $9::uuid)`,
      [
        id,
        survivor.id,
        merged.id,
        JSON.stringify({ decisions: result.decisions, overrides: input.overrides }),
        JSON.stringify({
          merged: {
            business_key: merged.business_key,
            label: mergedBefore.label,
            version_id: mergedBefore.id,
            source_system: mergedBefore.sourceSystem,
            valid_until: mergedBefore.validUntil,
          },
          survivor: {
            version_before_id: survivorBefore.id,
            version_after_id: versionId,
            label: survivorBefore.label,
            attributes: survivorBefore.attributes,
            source_system: survivorBefore.sourceSystem,
            recorded_at: survivorBefore.recordedAt,
            label_after: result.label,
            attributes_after: result.attributes,
          },
          day,
        }),
        JSON.stringify(repointed),
        reason,
        changeRequestId,
        actor,
      ],
    );
    const stored = (await this.findMerge(tx, id)) as MasterMerge;
    return { merge: stored, survivorVersion: Number(survivor.version) + 1, survivorVersionId: versionId };
  }

  /** The references that are alive and point at the entry that was merged away are pointed at the survivor, and listed. */
  private async repoint(tx: TenantTx, fromId: string, toId: string, actor: string): Promise<RepointedReference[]> {
    const crosswalks = await tx.query<{ id: string }>(
      "update machvon.master_crosswalk set master_record_id = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where master_record_id = $1::uuid and status = 'ACTIVE' returning id",
      [fromId, toId, actor],
    );
    const contractors = await tx.query<{ id: string }>(
      'update machvon.contractor set master_record_id = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where master_record_id = $1::uuid returning id',
      [fromId, toId, actor],
    );
    return [
      ...crosswalks.map((row): RepointedReference => ({ table: 'master_crosswalk', column: 'master_record_id', id: row.id })),
      ...contractors.map((row): RepointedReference => ({ table: 'contractor', column: 'master_record_id', id: row.id })),
    ].sort((a, b) => a.id.localeCompare(b.id));
  }

  async findMerge(tx: TenantTx, id: string): Promise<MasterMerge | undefined> {
    const rows = await tx.query<Sql>(`${MERGE_SELECT} where m.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : mergeOf(rows[0]);
  }

  async listMerges(tx: TenantTx, filter: { recordId?: string | undefined; status?: string | undefined; cursor?: string | undefined; limit: number }): Promise<Page<MasterMerge>> {
    if (filter.status !== undefined && !['APPLIED', 'REVERTED'].includes(filter.status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const limit = Math.min(filter.limit, MAX_PAGE);
    const after = cursorOf(filter.cursor);
    const rows = await tx.query<Sql>(
      `${MERGE_SELECT} where ($1::uuid is null or m.survivor_record_id = $1 or m.merged_record_id = $1) and ($2::text is null or m.status = $2)
          and ($3::timestamptz is null or (m.created_at, m.id) < ($3::timestamptz, $4::uuid)) order by m.created_at desc, m.id desc limit $5::int`,
      [filter.recordId ?? null, filter.status ?? null, after?.at ?? null, after?.id ?? null, limit + 1],
    );
    const page = rows.slice(0, limit).map(mergeOf);
    const last = page[page.length - 1];
    return { items: page, next: rows.length > limit && last !== undefined ? cursorFor(last.createdAt, last.id) : null };
  }

  /**
   * Undoes a merge against the version of the merge the caller read. 404, 409 `VERSION_CONFLICT`, 409 `MERGE_ALREADY_REVERTED`, 403 `POLICY_LOCKED`/`SELF_APPROVAL_DENIED` as for a merge, 409 `STAGE_TRANSITION_DENIED`
   * (the survivor is no longer in force, or was merged away itself: that merge is undone first), 409 `UNMERGE_CONFLICT` when the survivor edited an attribute it took from the merged entry and the steward has not said what to
   * do with it. The survivor gets back what the merge took from the merged entry (and keeps the rest), the merged entry comes back as it was, and the references that were pointed again and still stand are pointed back.
   */
  async unmerge(tx: TenantTx, id: string, expected: number, input: { reason: string; stewardDecisions: Record<string, unknown> }, actor: string): Promise<MasterUnmergeOutcome> {
    const rows = await tx.query<Sql>(
      'select survivor_record_id, merged_record_id, status, alias_json, survivorship_json, repointed_refs_json, version::text as version from machvon.master_merge where id = $1::uuid for update',
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expected) throw versionConflict(Number(row.version));
    if (row.status !== 'APPLIED') throw new DomainError('MERGE_ALREADY_REVERTED', 409);
    const reason = reasonOf(input.reason);
    const locked = await this.lockRecords(tx, [row.survivor_record_id, row.merged_record_id]);
    const survivor = locked.get(row.survivor_record_id) as RecordLock;
    const merged = locked.get(row.merged_record_id) as RecordLock;
    await this.assertMergeable(tx, survivor, actor);
    await this.assertMergeable(tx, merged, actor);
    if (survivor.status !== 'EFFECTIVE' || survivor.current_version_id === null || merged.status !== 'MERGED' || merged.merged_into_id !== survivor.id || merged.current_version_id === null)
      throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    const alias = row.alias_json;
    const survivorNow = await this.snapshotOf(tx, survivor.current_version_id);
    const mergedRetired = await this.snapshotOf(tx, merged.current_version_id);
    await this.assertNothingWaiting(tx, survivor.id, survivorNow.revision, vietnamDateOf(new Date()));
    await this.assertNothingWaiting(tx, merged.id, mergedRetired.revision, vietnamDateOf(new Date()));
    const decisions = (row.survivorship_json as { decisions: AttributeDecision[] }).decisions;
    const undone = unmergeSurvivor({
      decisions,
      atMerge: alias.survivor.attributes_after,
      atMergeLabel: alias.survivor.label_after,
      now: survivorNow.attributes,
      nowLabel: survivorNow.label,
      before: { label: alias.survivor.label, attributes: alias.survivor.attributes, sourceSystem: alias.survivor.source_system, recordedAt: alias.survivor.recorded_at },
      stewardDecisions: input.stewardDecisions,
    });
    const today = vietnamDateOf(new Date());
    // The two entries come back together: a survivor that cannot take its attributes back before tomorrow (its version began today) keeps the merge as it is until then.
    if (undone.reverted.length > 0 && addDays(survivorNow.validFrom, 1) > today) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'the merge took effect today');
    const preMerge = await this.snapshotOf(tx, alias.merged.version_id);
    const changeRequestId = await this.recordChange(
      tx,
      'UNMERGE',
      survivor.master_type,
      survivor.id,
      {
        reason,
        proposed: { merged_record_id: merged.id, label: undone.label, attributes: undone.attributes, reverted: undone.reverted, kept: undone.kept },
        before: { label: survivorNow.label, attributes: survivorNow.attributes },
        impact: { references: (row.repointed_refs_json as unknown[]).length },
        day: today,
      },
      actor,
    );
    if (undone.reverted.length > 0) {
      const versionId = await this.succeed(
        tx,
        { id: survivor.id, masterType: survivor.master_type, businessKey: survivor.business_key },
        survivorNow,
        { label: undone.label, attributes: undone.attributes, sourceSystem: survivorNow.sourceSystem, validUntil: survivorNow.validUntil },
        today,
        changeRequestId,
        actor,
      );
      await tx.query('update machvon.master_record set current_version_id = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [
        survivor.id,
        versionId,
        actor,
      ]);
    }
    // The entry that was merged away comes back as it was before the merge, as a new version that starts today.
    const restoredVersion = await this.succeed(
      tx,
      { id: merged.id, masterType: merged.master_type, businessKey: merged.business_key },
      mergedRetired,
      { label: preMerge.label, attributes: preMerge.attributes, sourceSystem: preMerge.sourceSystem, validUntil: alias.merged.valid_until ?? null },
      today,
      changeRequestId,
      actor,
    );
    await tx.query(
      "update machvon.master_record set status = 'EFFECTIVE', merged_into_id = null, current_version_id = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid",
      [merged.id, restoredVersion, actor],
    );
    const refs = row.repointed_refs_json as RepointedReference[];
    const restored: RepointedReference[] = [];
    const notRestored: RepointedReference[] = [];
    for (const ref of refs) {
      const back =
        ref.table === 'master_crosswalk'
          ? await tx.query(
              "update machvon.master_crosswalk set master_record_id = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid and master_record_id = $4::uuid and status = 'ACTIVE' returning id",
              [ref.id, merged.id, actor, survivor.id],
            )
          : await tx.query(
              'update machvon.contractor set master_record_id = $2::uuid, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid and master_record_id = $3::uuid returning id',
              [ref.id, merged.id, survivor.id, actor],
            );
      (back.length > 0 ? restored : notRestored).push(ref);
    }
    await tx.query(
      "update machvon.master_merge set status = 'REVERTED', reverted_by = $2::uuid, reverted_at = now(), revert_reason = $3, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid",
      [id, actor, reason],
    );
    return { merge: (await this.findMerge(tx, id)) as MasterMerge, reverted: undone.reverted, kept: undone.kept, restored, notRestored };
  }
}
