import { randomUUID } from 'node:crypto';
import { DomainError, assertFourEyes, asUuid, isIsoDate, shiftDays, vietnamDateOf, versionConflict } from '@machvon/kernel';
import { DEFAULT_BLOCK_PCT, DEFAULT_WARN_PCT, assertThresholds, evaluateAvc } from './cap-avc.ts';
import type { AvcThresholds } from './cap-avc.ts';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import { PROJECT_GROUPS } from './prj-stage-store.ts';
import type { TenantTx } from './tenant-database.ts';

export const AVC_SCOPE_KINDS = ['TENANT', 'FUND_SOURCE', 'UNIT', 'PROJECT_GROUP'] as const;
export type AvcScopeKind = (typeof AVC_SCOPE_KINDS)[number];
export const AVC_CONTROL_OBJECTS = ['ALLOCATION_LINE', 'APPROPRIATION'] as const;
export type AvcControlObject = (typeof AVC_CONTROL_OBJECTS)[number];
export const AVC_STATUSES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const;
export type AvcPolicyStatus = (typeof AVC_STATUSES)[number];

/** The more specific the scope, the earlier it wins (CAP.md F4): a project group before a unit before a fund source before the tenant. */
const SPECIFICITY: Readonly<Record<AvcScopeKind, number>> = { PROJECT_GROUP: 4, UNIT: 3, FUND_SOURCE: 2, TENANT: 1 };
const MAX_LEGAL_BASIS = 2000;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/;
const FUND_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/;

export interface NewAvcPolicy {
  policyCode: string;
  scopeKind: AvcScopeKind;
  scopeRefId?: string | undefined;
  scopeValue?: string | undefined;
  controlObject: AvcControlObject;
  warnPct: string;
  blockPct: string;
  includeReservations?: boolean | undefined;
  legalBasis: string;
  effectiveFrom: string;
  effectiveUntil?: string | undefined;
}

export interface AvcPolicyRecord {
  id: string;
  policyCode: string;
  revision: number;
  scopeKind: AvcScopeKind;
  scopeRefId: string | null;
  scopeValue: string | null;
  controlObject: AvcControlObject;
  warnPct: string;
  blockPct: string;
  includeReservations: boolean;
  legalBasis: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  status: AvcPolicyStatus;
  approvedBy: string | null;
  createdBy: string;
  createdAt: Date;
  version: number;
  createdAtKey: string;
}

interface Row {
  id: string;
  policy_code: string;
  revision: number;
  scope_kind: AvcScopeKind;
  scope_ref_id: string | null;
  scope_value: string | null;
  control_object: AvcControlObject;
  warn_pct: string;
  block_pct: string;
  include_reservations: boolean;
  legal_basis: string;
  effective_from: string;
  effective_until: string | null;
  status: AvcPolicyStatus;
  approved_by: string | null;
  created_by: string;
  created_at: Date;
  version: string;
  created_at_key: string;
}

const COLUMNS = `p.id, p.policy_code, p.revision, p.scope_kind, p.scope_ref_id, p.scope_value, p.control_object, p.warn_pct::text as warn_pct, p.block_pct::text as block_pct,
  p.include_reservations, p.legal_basis, p.effective_from::text as effective_from, p.effective_until::text as effective_until, p.status, p.approved_by, p.created_by,
  p.created_at, p.version::text as version, ${timestampKey('p.created_at')} as created_at_key`;

const toRecord = (row: Row): AvcPolicyRecord => ({
  id: row.id,
  policyCode: row.policy_code,
  revision: row.revision,
  scopeKind: row.scope_kind,
  scopeRefId: row.scope_ref_id,
  scopeValue: row.scope_value,
  controlObject: row.control_object,
  warnPct: row.warn_pct,
  blockPct: row.block_pct,
  includeReservations: row.include_reservations,
  legalBasis: row.legal_basis,
  effectiveFrom: row.effective_from,
  effectiveUntil: row.effective_until,
  status: row.status,
  approvedBy: row.approved_by,
  createdBy: row.created_by,
  createdAt: row.created_at,
  version: Number(row.version),
  createdAtKey: row.created_at_key,
});

export interface AvcPolicyFilter {
  status?: AvcPolicyStatus | undefined;
  controlObject?: AvcControlObject | undefined;
}

export interface AvcPolicyPage {
  limit: number;
  after?: { code: string; id: string } | undefined;
}

/** What a check needs to know to find the policy that governs it: the project group, the unit and the fund source of the line, or the fund source of the appropriation. */
export interface AvcContext {
  controlObject: AvcControlObject;
  projectGroup?: string | null | undefined;
  unitId?: string | null | undefined;
  fundSourceKey?: string | null | undefined;
}

export interface AvcPreview {
  policyId: string;
  controlObject: AvcControlObject;
  total: number;
  ok: number;
  warn: number;
  block: number;
  asOf: string;
}

const invalid = (field: string, extensions: Record<string, unknown> = {}): DomainError => new DomainError('VALIDATION_FAILED', 422, field, { extensions });
const stateInvalid = (status: string): DomainError => new DomainError('AVC_POLICY_STATE_INVALID', 409, 'status', { extensions: { policy_status: status } });

/**
 * The availability control policies (ST-CAP-005, CAP.md F4, BR-CAP-06). A policy is drafted by one person with its thresholds, its scope, the object it controls and its legal
 * basis, and published by another; what it says never changes (the database says so too), a different threshold is the next revision of the same code and an earlier revision
 * ends the day before the later one starts. Two published policies of the same scope never overlap in time. What governs a check is the most specific policy in force on the day.
 */
export class CapAvcPolicyStore {
  /**
   * Drafts the next revision of a policy code. Refusals in order: the thresholds (422 AVC_THRESHOLD_INVALID), the shape of the code, the scope, the legal basis and the period
   * (422 VALIDATION_FAILED, naming the field), a code that already belongs to another scope or object (422), a unit or a fund source that is not the tenant's (422).
   */
  async create(tx: TenantTx, input: NewAvcPolicy, actor: string): Promise<AvcPolicyRecord> {
    assertThresholds(input.warnPct, input.blockPct);
    if (!CODE.test(input.policyCode)) throw invalid('policy_code');
    const legalBasis = input.legalBasis.normalize('NFC').trim();
    if (legalBasis.length < 3 || legalBasis.length > MAX_LEGAL_BASIS) throw invalid('legal_basis');
    if (!isIsoDate(input.effectiveFrom)) throw invalid('effective_from');
    if (input.effectiveUntil !== undefined && (!isIsoDate(input.effectiveUntil) || input.effectiveUntil < input.effectiveFrom)) throw invalid('effective_until');
    const scope = await this.checkedScope(tx, input);
    // The code is one policy over time: its revisions share the scope and the object, so "what governs this scope" never depends on which code was typed.
    const earlier = await tx.query<Row>(`select ${COLUMNS} from machvon.avc_policy p where p.policy_code = $1 order by p.revision desc for update`, [input.policyCode]);
    const latest = earlier[0];
    if (latest !== undefined && (latest.scope_kind !== input.scopeKind || latest.scope_ref_id !== scope.refId || latest.scope_value !== scope.value || latest.control_object !== input.controlObject)) {
      throw invalid('policy_code', { reason: 'CODE_HAS_OTHER_SCOPE' });
    }
    const id = randomUUID();
    const revision = (latest?.revision ?? 0) + 1;
    await tx.query(
      `insert into machvon.avc_policy
         (tenant_id, id, policy_code, scope_kind, scope_ref_id, scope_value, control_object, warn_pct, block_pct, include_reservations, legal_basis, effective_from, effective_until,
          revision, status, created_by, updated_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::uuid, $5, $6, $7::numeric, $8::numeric, $9::boolean, $10, $11::date, $12::date,
          $13::integer, 'DRAFT', $14::uuid, $14::uuid, 1)`,
      [id, input.policyCode, input.scopeKind, scope.refId, scope.value, input.controlObject, input.warnPct, input.blockPct, input.includeReservations ?? true, legalBasis, input.effectiveFrom, input.effectiveUntil ?? null, revision, actor],
    );
    const created = await this.find(tx, id);
    if (created === undefined) throw new Error('a policy that was just written is missing');
    return created;
  }

  /**
   * Publishes a draft. The person who drafted it never does (403 SELF_APPROVAL_DENIED, judged before the state), the version must be the one the caller read (409), and only a
   * draft can be published (409 AVC_POLICY_STATE_INVALID). An earlier revision of the same code that is still in force when this one starts ends the day before; a published
   * policy of the same scope and object that overlaps and is not such a predecessor is 409 AVC_POLICY_OVERLAP, naming it.
   */
  async publish(tx: TenantTx, id: string, expectedVersion: number, approver: string): Promise<{ policy: AvcPolicyRecord; endedPolicyIds: string[] }> {
    const [locked] = await tx.query<Row>(`select ${COLUMNS} from machvon.avc_policy p where p.id = $1::uuid for update`, [id]);
    if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const draft = toRecord(locked);
    if (draft.version !== expectedVersion) throw versionConflict(draft.version);
    assertFourEyes(draft.createdBy, approver);
    if (draft.status !== 'DRAFT') throw stateInvalid(draft.status);
    const sameScope = await tx.query<Row>(
      `select ${COLUMNS} from machvon.avc_policy p
        where p.id <> $1::uuid and p.status = 'PUBLISHED' and p.control_object = $2 and p.scope_kind = $3 and p.scope_ref_id is not distinct from $4::uuid and p.scope_value is not distinct from $5
        order by p.effective_from, p.id for update`,
      [id, draft.controlObject, draft.scopeKind, draft.scopeRefId, draft.scopeValue],
    );
    const ended: string[] = [];
    for (const other of sameScope.map(toRecord)) {
      if (!overlaps(draft, other)) continue;
      // Only an earlier revision of the same code that starts before this one is taken over: its last day becomes the day before this one starts.
      if (other.policyCode === draft.policyCode && other.effectiveFrom < draft.effectiveFrom) {
        await tx.query('update machvon.avc_policy set effective_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [other.id, shiftDays(draft.effectiveFrom, -1), approver]);
        ended.push(other.id);
        continue;
      }
      throw new DomainError('AVC_POLICY_OVERLAP', 409, 'effective_from', { extensions: { conflicting_policy_id: other.id, conflicting_policy_code: other.policyCode } });
    }
    await tx.query("update machvon.avc_policy set status = 'PUBLISHED', approved_by = $2::uuid, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [id, approver]);
    const policy = await this.find(tx, id);
    if (policy === undefined) throw new Error('a policy that was just published is missing');
    return { policy, endedPolicyIds: ended };
  }

  async find(tx: TenantTx, id: string): Promise<AvcPolicyRecord | undefined> {
    const [row] = await tx.query<Row>(`select ${COLUMNS} from machvon.avc_policy p where p.id = $1::uuid`, [id]);
    return row === undefined ? undefined : toRecord(row);
  }

  /** The policies, newest first, in keyset pages. */
  async list(tx: TenantTx, filter: AvcPolicyFilter, page: AvcPolicyPage): Promise<AvcPolicyRecord[]> {
    assertTimestampCursor(page.after?.code);
    if (page.after !== undefined && asUuid(page.after.id) === undefined) throw invalid('cursor');
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from machvon.avc_policy p
        where ($1::text is null or p.status = $1) and ($2::text is null or p.control_object = $2)
          and ($3::text is null or (p.created_at, p.id) < ($3::timestamptz, $4::uuid))
        order by p.created_at desc, p.id desc limit $5`,
      [filter.status ?? null, filter.controlObject ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toRecord);
  }

  /**
   * The thresholds that govern a check on `date` (a Vietnam calendar day): the published policy in force of the object that is most specific for the context, or undefined
   * when none is in force.
   */
  async governing(tx: TenantTx, context: AvcContext, date: string = vietnamDateOf(new Date())): Promise<AvcThresholds | undefined> {
    const rows = await tx.query<Row>(
      `select ${COLUMNS} from machvon.avc_policy p
        where p.status = 'PUBLISHED' and p.control_object = $1 and p.effective_from <= $2::date and (p.effective_until is null or p.effective_until >= $2::date)
          and (p.scope_kind = 'TENANT'
               or (p.scope_kind = 'PROJECT_GROUP' and p.scope_value = $3)
               or (p.scope_kind = 'UNIT' and p.scope_ref_id = $4::uuid)
               or (p.scope_kind = 'FUND_SOURCE' and p.scope_value = $5))`,
      [context.controlObject, date, context.projectGroup ?? null, context.unitId ?? null, context.fundSourceKey ?? null],
    );
    const best = rows.map(toRecord).sort((left, right) => SPECIFICITY[right.scopeKind] - SPECIFICITY[left.scopeKind] || right.effectiveFrom.localeCompare(left.effectiveFrom))[0];
    return best === undefined ? undefined : { policyId: best.id, warnPct: best.warnPct, blockPct: best.blockPct, includeReservations: best.includeReservations };
  }

  /** The thresholds of a line: the policy in force, or without one the tenant default of 90 and 100 (BR-CAP-06, a working assumption), naming no policy. */
  async governingLine(tx: TenantTx, context: Omit<AvcContext, 'controlObject'>, date: string = vietnamDateOf(new Date())): Promise<AvcThresholds> {
    return (await this.governing(tx, { ...context, controlObject: 'ALLOCATION_LINE' }, date)) ?? { policyId: null, warnPct: DEFAULT_WARN_PCT, blockPct: DEFAULT_BLOCK_PCT, includeReservations: true };
  }

  /**
   * How many of the things the policy would control are OK, WARN and BLOCK if it governed them now: the lines in force (published plans) of its scope for ALLOCATION_LINE, the
   * published appropriations of its scope for APPROPRIATION. The count is the whole tenant: the caller of a preview holds the policy authority on the whole tenant.
   */
  async preview(tx: TenantTx, policy: AvcPolicyRecord): Promise<AvcPreview> {
    const thresholds: AvcThresholds = { policyId: policy.id, warnPct: policy.warnPct, blockPct: policy.blockPct, includeReservations: policy.includeReservations };
    const figures = policy.controlObject === 'ALLOCATION_LINE' ? await this.lineFigures(tx, policy) : await this.appropriationFigures(tx, policy);
    const tally = { ok: 0, warn: 0, block: 0 };
    for (const figure of figures) {
      const verdict = evaluateAvc(figure, thresholds);
      if (verdict.state === 'OK') tally.ok += 1;
      else if (verdict.state === 'WARN') tally.warn += 1;
      else tally.block += 1;
    }
    return { policyId: policy.id, controlObject: policy.controlObject, total: figures.length, ...tally, asOf: new Date().toISOString() };
  }

  private async lineFigures(tx: TenantTx, policy: AvcPolicyRecord): Promise<Array<{ allocatedVnd: string; reservedVnd: string; committedVnd: string; disbursedVnd: string }>> {
    const rows = await tx.query<{ allocated: string; reserved: string; committed: string; disbursed: string }>(
      `select ab.allocated_vnd::text as allocated, ab.reserved_vnd::text as reserved, ab.committed_vnd::text as committed, ab.disbursed_vnd::text as disbursed
         from machvon.allocation_balance ab
         join machvon.allocation_line al on al.tenant_id = ab.tenant_id and al.id = ab.allocation_line_id
         join machvon.plan_version pv on pv.tenant_id = al.tenant_id and pv.id = al.plan_version_id
         join machvon.capital_plan cp on cp.tenant_id = pv.tenant_id and cp.id = pv.capital_plan_id and cp.status = 'PUBLISHED'
         join machvon.project p on p.tenant_id = al.tenant_id and p.id = al.project_id
         join machvon.master_record_version fv on fv.tenant_id = al.tenant_id and fv.id = al.fund_source_version_id
         join machvon.master_record fr on fr.tenant_id = fv.tenant_id and fr.id = fv.master_record_id
        where ${this.scopeSql(policy, 'p.project_group', 'p.owner_unit_id', 'fr.business_key')}`,
      this.scopeParams(policy),
    );
    return rows.map((row) => ({ allocatedVnd: row.allocated, reservedVnd: row.reserved, committedVnd: row.committed, disbursedVnd: row.disbursed }));
  }

  private async appropriationFigures(tx: TenantTx, policy: AvcPolicyRecord): Promise<Array<{ allocatedVnd: string; reservedVnd: string; committedVnd: string; disbursedVnd: string }>> {
    // A project group or a unit is a property of a line's project, not of an appropriation: such a policy controls nothing at this level.
    if (policy.scopeKind === 'PROJECT_GROUP' || policy.scopeKind === 'UNIT') return [];
    const rows = await tx.query<{ allocated: string; reserved: string; committed: string; disbursed: string }>(
      `select a.amount_vnd::text as allocated, coalesce(sum(ab.reserved_vnd), 0)::text as reserved, coalesce(sum(ab.committed_vnd), 0)::text as committed,
              coalesce(sum(ab.disbursed_vnd), 0)::text as disbursed
         from machvon.appropriation a
         join machvon.master_record_version fv on fv.tenant_id = a.tenant_id and fv.id = a.fund_source_version_id
         join machvon.master_record fr on fr.tenant_id = fv.tenant_id and fr.id = fv.master_record_id
         left join machvon.allocation_line al on al.tenant_id = a.tenant_id and al.appropriation_id = a.id
         left join machvon.allocation_balance ab on ab.tenant_id = al.tenant_id and ab.allocation_line_id = al.id
        where a.status = 'PUBLISHED' and ($1::text <> 'FUND_SOURCE' or fr.business_key = $2)
        group by a.tenant_id, a.id`,
      [policy.scopeKind, policy.scopeValue],
    );
    return rows.map((row) => ({ allocatedVnd: row.allocated, reservedVnd: row.reserved, committedVnd: row.committed, disbursedVnd: row.disbursed }));
  }

  private scopeSql(policy: AvcPolicyRecord, group: string, unit: string, fund: string): string {
    switch (policy.scopeKind) {
      case 'TENANT':
        return 'true';
      case 'PROJECT_GROUP':
        return `${group} = $1`;
      case 'UNIT':
        return `${unit} = $1::uuid`;
      case 'FUND_SOURCE':
        return `${fund} = $1`;
    }
  }

  private scopeParams(policy: AvcPolicyRecord): unknown[] {
    return policy.scopeKind === 'TENANT' ? [] : [policy.scopeKind === 'UNIT' ? policy.scopeRefId : policy.scopeValue];
  }

  /** The scope as it is kept, with the unit or the fund source checked to be the tenant's own (a project group is one of the four of the law). */
  private async checkedScope(tx: TenantTx, input: NewAvcPolicy): Promise<{ refId: string | null; value: string | null }> {
    switch (input.scopeKind) {
      case 'TENANT':
        if (input.scopeRefId !== undefined) throw invalid('scope_ref_id');
        if (input.scopeValue !== undefined && input.scopeValue !== '') throw invalid('scope_value');
        return { refId: null, value: null };
      case 'UNIT': {
        if (input.scopeRefId === undefined || asUuid(input.scopeRefId) === undefined) throw invalid('scope_ref_id');
        if (input.scopeValue !== undefined && input.scopeValue !== '') throw invalid('scope_value');
        const units = await tx.query('select 1 from machvon.organization_unit where id = $1::uuid', [input.scopeRefId]);
        if (units.length === 0) throw invalid('scope_ref_id', { reason: 'UNIT_NOT_FOUND' });
        return { refId: input.scopeRefId.toLowerCase(), value: null };
      }
      case 'FUND_SOURCE': {
        if (input.scopeRefId !== undefined) throw invalid('scope_ref_id');
        const value = input.scopeValue;
        if (value === undefined || !FUND_KEY.test(value)) throw invalid('scope_value');
        const funds = await tx.query("select 1 from machvon.master_record where master_type = 'FUND_SOURCE' and business_key = $1", [value]);
        if (funds.length === 0) throw invalid('scope_value', { reason: 'FUND_SOURCE_NOT_FOUND' });
        return { refId: null, value };
      }
      case 'PROJECT_GROUP': {
        if (input.scopeRefId !== undefined) throw invalid('scope_ref_id');
        const value = input.scopeValue;
        if (value === undefined || !PROJECT_GROUPS.some((group) => group === value)) throw invalid('scope_value');
        return { refId: null, value };
      }
    }
  }
}

/** Two periods overlap when each starts on or before the other ends (an open end is the end of time). */
function overlaps(left: AvcPolicyRecord, right: AvcPolicyRecord): boolean {
  return left.effectiveFrom <= (right.effectiveUntil ?? '9999-12-31') && right.effectiveFrom <= (left.effectiveUntil ?? '9999-12-31');
}
