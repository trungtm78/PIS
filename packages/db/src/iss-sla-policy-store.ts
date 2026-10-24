import { randomUUID } from 'node:crypto';
import { DomainError, vietnamDateOf } from '@machvon/kernel';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';
import { WorkCalendarStore } from './work-calendar-store.ts';

export const SLA_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type SlaSeverity = (typeof SLA_SEVERITIES)[number];
export type SlaPolicyStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';

/** The category entry (ISSUE_CATEGORY, MDM-17) that SLA policies are written for. */
export const ISSUE_CATEGORY_TYPE = 'ISSUE_CATEGORY';

/** The longest SLA the module counts, in working hours: it bounds the years of the working calendar that a deadline needs. */
export const MAX_SLA_HOURS = 2400;
export const MAX_ESCALATE_PCT = 1000;
const DEFAULT_ESCALATE_L2_PCT = 100;
const DEFAULT_ESCALATE_L3_PCT = 150;
const MAX_CODE = 100;
const MAX_CALENDAR_CODE = 40;
const NO_UNIT = '00000000-0000-0000-0000-000000000000';
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SEVERITIES: ReadonlySet<string> = new Set(SLA_SEVERITIES);

export interface SlaPolicyRow {
  id: string;
  code: string;
  revision: number;
  categoryVersionId: string;
  categoryRecordId: string;
  /** The business key and the label of the category version the policy was written against. */
  categoryKey: string;
  categoryLabel: string;
  severity: SlaSeverity;
  ownerUnitId: string | null;
  calendarCode: string;
  responseHours: number;
  resolveHours: number;
  escalateL2Pct: number;
  escalateL3Pct: number;
  requireIndependentVerifier: boolean;
  requireEvidence: boolean;
  validFrom: string;
  /** The first day the policy no longer applies; null while it is open-ended. */
  validUntil: string | null;
  status: SlaPolicyStatus;
  version: number;
  /** Creation time to the microsecond (UTC): the ordering key of the list and its cursor. */
  createdAtKey: string;
}

export interface SlaPolicyInput {
  code: string;
  categoryVersionId: string;
  severity: string;
  ownerUnitId?: string | null | undefined;
  calendarCode: string;
  responseHours: number;
  resolveHours: number;
  escalateL2Pct?: number | undefined;
  escalateL3Pct?: number | undefined;
  requireIndependentVerifier?: boolean | undefined;
  requireEvidence?: boolean | undefined;
  validFrom: string;
}

export interface SlaPolicyFilter {
  categoryRecordId?: string | undefined;
  code?: string | undefined;
  severity?: SlaSeverity | undefined;
  ownerUnitId?: string | undefined;
  status?: SlaPolicyStatus | undefined;
}

/** What identifies the policy that applies to an issue about to be created. */
export interface SlaPolicyLookup {
  categoryVersionId: string;
  severity: string;
  ownerUnitId: string | null;
  /** The Vietnam date on which the issue is created. */
  on: string;
}

export interface SlaPolicyStoreOptions {
  /** The current Vietnam date; injectable so that the rule on retroactive dates is testable. */
  today?: () => string;
}

interface SqlRow {
  id: string;
  code: string;
  revision: number;
  category_version_id: string;
  category_record_id: string;
  category_key: string;
  category_label: string;
  severity: SlaSeverity;
  owner_unit_id: string | null;
  calendar_code: string;
  response_hours: number;
  resolve_hours: number;
  escalate_l2_pct: number;
  escalate_l3_pct: number;
  require_independent_verifier: boolean;
  require_evidence: boolean;
  valid_from: string;
  valid_until: string | null;
  status: SlaPolicyStatus;
  version: string;
  created_at_key: string;
}

const SELECT = `select p.id, p.code, p.revision, p.category_version_id, p.category_record_id, r.business_key as category_key, v.label as category_label,
  p.severity, p.owner_unit_id, p.calendar_code, p.response_hours, p.resolve_hours, p.escalate_l2_pct, p.escalate_l3_pct,
  p.require_independent_verifier, p.require_evidence, p.valid_from::text as valid_from, p.valid_until::text as valid_until, p.status,
  p.version::text as version, ${timestampKey('p.created_at')} as created_at_key
  from machvon.issue_sla_policy p
  join machvon.master_record_version v on v.tenant_id = p.tenant_id and v.id = p.category_version_id
  join machvon.master_record r on r.tenant_id = p.tenant_id and r.id = p.category_record_id`;

const toRow = (row: SqlRow): SlaPolicyRow => ({
  id: row.id,
  code: row.code,
  revision: row.revision,
  categoryVersionId: row.category_version_id,
  categoryRecordId: row.category_record_id,
  categoryKey: row.category_key,
  categoryLabel: row.category_label,
  severity: row.severity,
  ownerUnitId: row.owner_unit_id,
  calendarCode: row.calendar_code,
  responseHours: row.response_hours,
  resolveHours: row.resolve_hours,
  escalateL2Pct: row.escalate_l2_pct,
  escalateL3Pct: row.escalate_l3_pct,
  requireIndependentVerifier: row.require_independent_verifier,
  requireEvidence: row.require_evidence,
  validFrom: row.valid_from,
  validUntil: row.valid_until,
  status: row.status,
  version: Number(row.version),
  createdAtKey: row.created_at_key,
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const overlap = (): DomainError => new DomainError('SLA_POLICY_OVERLAP', 409);

const isRealDate = (value: string): boolean => {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return DATE.test(value) && !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
};

function dateOf(value: string, field: string): string {
  if (!isRealDate(value)) throw invalid(field);
  return value;
}

function hoursOf(value: number, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(field);
  return value;
}

/** The content of a policy as it is stored, every rule of the table checked before the database is touched. */
interface CheckedPolicy {
  code: string;
  severity: SlaSeverity;
  ownerUnitId: string | null;
  calendarCode: string;
  responseHours: number;
  resolveHours: number;
  escalateL2Pct: number;
  escalateL3Pct: number;
  requireIndependentVerifier: boolean;
  requireEvidence: boolean;
  validFrom: string;
}

function checked(input: SlaPolicyInput): CheckedPolicy {
  const code = input.code.trim();
  if (code.length > MAX_CODE || !CODE.test(code)) throw invalid('code');
  const calendarCode = input.calendarCode.trim();
  if (calendarCode.length > MAX_CALENDAR_CODE || !CODE.test(calendarCode)) throw invalid('calendar_code');
  if (!SEVERITIES.has(input.severity)) throw invalid('severity');
  const responseHours = hoursOf(input.responseHours, 'response_hours', 1, MAX_SLA_HOURS);
  const resolveHours = hoursOf(input.resolveHours, 'resolve_hours', responseHours, MAX_SLA_HOURS);
  const escalateL2Pct = hoursOf(input.escalateL2Pct ?? DEFAULT_ESCALATE_L2_PCT, 'escalate_l2_pct', 1, MAX_ESCALATE_PCT - 1);
  const escalateL3Pct = hoursOf(input.escalateL3Pct ?? DEFAULT_ESCALATE_L3_PCT, 'escalate_l3_pct', escalateL2Pct + 1, MAX_ESCALATE_PCT);
  return {
    code,
    severity: input.severity as SlaSeverity,
    ownerUnitId: input.ownerUnitId ?? null,
    calendarCode,
    responseHours,
    resolveHours,
    escalateL2Pct,
    escalateL3Pct,
    requireIndependentVerifier: input.requireIndependentVerifier ?? true,
    requireEvidence: input.requireEvidence ?? true,
    validFrom: dateOf(input.validFrom, 'valid_from'),
  };
}

/**
 * The SLA policy versions of the issue module (ST-ISS-001, BR-ISS-02). A policy is written for a category entry, a severity and
 * optionally a unit; it applies from a date and never changes afterwards. A change is a new revision of the same code that takes over
 * on its date, and an issue keeps the version it was created under. Two policies never apply to the same category, severity and unit
 * on the same day: the store tells the two apart (a second revision of a policy replaces it, a policy of another code is an overlap),
 * and the exclusion constraint of the table has the last word.
 */
export class IssSlaPolicyStore {
  private readonly today: () => string;
  private readonly calendars = new WorkCalendarStore();

  constructor(options: SlaPolicyStoreOptions = {}) {
    this.today = options.today ?? (() => vietnamDateOf(new Date()));
  }

  async find(tx: TenantTx, id: string, lock = false): Promise<SlaPolicyRow | undefined> {
    const rows = await tx.query<SqlRow>(`${SELECT} where p.id = $1::uuid${lock ? ' for update of p' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** The versions of the tenant, the newest first, by category entry, code, severity, unit and status. */
  async list(tx: TenantTx, filter: SlaPolicyFilter, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<SlaPolicyRow[]> {
    const rows = await tx.query<SqlRow>(
      `${SELECT}
        where ($1::uuid is null or p.category_record_id = $1::uuid) and ($2::text is null or p.code = $2) and ($3::text is null or p.severity = $3)
          and ($4::uuid is null or p.owner_unit_id = $4::uuid) and ($5::text is null or p.status = $5)
          and ($6::text is null or (${timestampKey('p.created_at')}, p.id) < ($6::text, $7::uuid))
        order by p.created_at desc, p.id desc limit $8`,
      [
        filter.categoryRecordId ?? null,
        filter.code ?? null,
        filter.severity ?? null,
        filter.ownerUnitId ?? null,
        filter.status ?? null,
        request.after?.code ?? null,
        request.after?.id ?? null,
        request.limit,
      ],
    );
    return rows.map(toRow);
  }

  /**
   * The policy that applies to an issue of this category and severity created on a date: the one written for its unit when there is
   * one, the default of the tenant otherwise (BR-ISS-02). A retired version still applies until its end date. Undefined when none does.
   */
  async inForce(tx: TenantTx, lookup: SlaPolicyLookup): Promise<SlaPolicyRow | undefined> {
    const rows = await tx.query<SqlRow>(
      `${SELECT}
        where p.category_record_id = (select master_record_id from machvon.master_record_version where id = $1::uuid)
          and p.severity = $2 and p.status <> 'DRAFT' and p.valid_from <= $4::date and (p.valid_until is null or p.valid_until > $4::date)
          and (p.owner_unit_id = $3::uuid or p.owner_unit_id is null)
        order by (p.owner_unit_id is null), p.revision desc limit 1`,
      [lookup.categoryVersionId, lookup.severity, lookup.ownerUnitId, lookup.on],
    );
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /**
   * Publishes a policy. A code seen for the first time starts at revision 1; a code that exists gets the next revision, which ends the
   * revision in force on its own date (it must begin after that revision began). A date in the past is refused: a published version is
   * never put in force for days that are gone.
   */
  async publish(tx: TenantTx, input: SlaPolicyInput, actor: string): Promise<{ id: string; revision: number; version: number; supersededId: string | null }> {
    const policy = checked(input);
    if (policy.validFrom < this.today()) throw invalid('valid_from');
    const category = await this.categoryOf(tx, input.categoryVersionId);
    await this.assertUnit(tx, policy.ownerUnitId);
    await this.assertCalendar(tx, policy.calendarCode, Number(policy.validFrom.slice(0, 4)));
    // One publication at a time per category, severity and unit: the checks below read what the other one is about to write.
    await tx.query("select pg_advisory_xact_lock(hashtextextended(coalesce(current_setting('app.tenant_id', true), '') || ':iss-sla:' || $1::text || $2::text || $3::text, 0))", [
      category.recordId,
      policy.severity,
      policy.ownerUnitId ?? NO_UNIT,
    ]);
    const latest = (await tx.query<SqlRow>(`${SELECT} where p.code = $1 order by p.revision desc limit 1 for update of p`, [policy.code]))[0];
    const previous = latest === undefined ? undefined : toRow(latest);
    if (previous !== undefined && (previous.categoryRecordId !== category.recordId || previous.severity !== policy.severity || previous.ownerUnitId !== policy.ownerUnitId)) {
      // A code names one policy: it cannot move to another category, severity or unit.
      throw invalid('code');
    }
    const clash = await tx.query<{ id: string }>(
      `select id from machvon.issue_sla_policy
        where category_record_id = $1::uuid and severity = $2 and coalesce(owner_unit_id, $3::uuid) = $4::uuid and code <> $5 and status <> 'DRAFT'
          and (valid_until is null or valid_until > $6::date) limit 1`,
      [category.recordId, policy.severity, NO_UNIT, policy.ownerUnitId ?? NO_UNIT, policy.code, policy.validFrom],
    );
    if (clash.length > 0) throw overlap();
    let supersededId: string | null = null;
    if (previous !== undefined) {
      if (previous.validUntil === null) {
        if (policy.validFrom <= previous.validFrom) throw invalid('valid_from');
        await tx.query(
          `update machvon.issue_sla_policy set status = 'RETIRED', valid_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
          [previous.id, policy.validFrom, actor],
        );
        supersededId = previous.id;
      } else if (policy.validFrom < previous.validUntil) {
        throw overlap();
      }
    }
    const id = randomUUID();
    const revision = (previous?.revision ?? 0) + 1;
    try {
      await tx.query(
        `insert into machvon.issue_sla_policy
           (tenant_id, id, code, revision, category_version_id, category_record_id, severity, owner_unit_id, calendar_code, response_hours, resolve_hours,
            escalate_l2_pct, escalate_l3_pct, require_independent_verifier, require_evidence, valid_from, status, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::uuid, $5::uuid, $6, $7::uuid, $8, $9, $10, $11, $12, $13, $14, $15::date, 'ACTIVE', $16::uuid, $16::uuid)`,
        [
          id,
          policy.code,
          revision,
          input.categoryVersionId,
          category.recordId,
          policy.severity,
          policy.ownerUnitId,
          policy.calendarCode,
          policy.responseHours,
          policy.resolveHours,
          policy.escalateL2Pct,
          policy.escalateL3Pct,
          policy.requireIndependentVerifier,
          policy.requireEvidence,
          policy.validFrom,
          actor,
        ],
      );
    } catch (error) {
      // The exclusion constraint and the one-active index are the last word when two publications raced past the checks above.
      const { code, constraint } = error as { code?: string; constraint?: string };
      if (code === '23P01' || (code === '23505' && constraint === 'issue_sla_policy_active_uq')) throw overlap();
      throw error;
    }
    return { id, revision, version: 1, supersededId };
  }

  /**
   * Ends the open-ended version in force from a date: the first day it no longer applies. The row stays, so an issue created under it
   * keeps pointing at it; only a version that is still open-ended can be ended.
   */
  async retire(tx: TenantTx, id: string, validUntil: string, actor: string): Promise<{ row: SlaPolicyRow; version: number }> {
    const until = dateOf(validUntil, 'valid_until');
    const row = await this.find(tx, id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.status !== 'ACTIVE' || row.validUntil !== null) throw new DomainError('SLA_POLICY_STATE_INVALID', 409, 'status');
    // The end comes after the start, and not in days that are gone: it would change which version applied on them.
    if (until <= row.validFrom || until < this.today()) throw invalid('valid_until');
    await tx.query(
      `update machvon.issue_sla_policy set status = 'RETIRED', valid_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [id, until, actor],
    );
    return { row, version: row.version + 1 };
  }

  /** The category entry behind a version, when the version is the one in force of an issue category that is in use. */
  private async categoryOf(tx: TenantTx, categoryVersionId: string): Promise<{ recordId: string }> {
    const rows = await tx.query<{ master_record_id: string }>(
      `select v.master_record_id
         from machvon.master_record_version v join machvon.master_record r on r.tenant_id = v.tenant_id and r.id = v.master_record_id
        where v.id = $1::uuid and v.master_type = $2 and r.current_version_id = v.id and r.status = 'EFFECTIVE'`,
      [categoryVersionId, ISSUE_CATEGORY_TYPE],
    );
    // A version of another tenant is indistinguishable from one that does not exist.
    if (rows[0] === undefined) throw invalid('category_version_id');
    return { recordId: rows[0].master_record_id };
  }

  private async assertUnit(tx: TenantTx, unitId: string | null): Promise<void> {
    if (unitId === null) return;
    const rows = await tx.query<{ id: string }>('select id from machvon.organization_unit where id = $1::uuid', [unitId]);
    if (rows.length === 0) throw invalid('owner_unit_id');
  }

  /** A policy counts time on a working calendar that the tenant has published for the year it begins; a name nobody published would never yield a deadline. */
  private async assertCalendar(tx: TenantTx, calendarCode: string, year: number): Promise<void> {
    if ((await this.calendars.published(tx, calendarCode, year)) === undefined) throw invalid('calendar_code');
  }

}
