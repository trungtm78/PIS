import { randomUUID } from 'node:crypto';
import { DomainError, isIsoDate, periodsOverlap, shiftDays, vietnamDateOf } from '@machvon/kernel';
import { timestampKey } from './keyset.ts';
import { checkApplicability } from './pmt-permit-applicability.ts';
import { PERMIT_TYPE_WORKING_ASSUMPTIONS } from './pmt-permit-type-seed.ts';
import type { TenantTx } from './tenant-database.ts';

export const PERMIT_CATEGORIES = ['ENVIRONMENT', 'DESIGN_APPRAISAL', 'FIRE_SAFETY', 'CONSTRUCTION_PERMIT', 'LAND', 'TRAFFIC', 'WATER_RESOURCES', 'OTHER'] as const;
export type PermitCategory = (typeof PERMIT_CATEGORIES)[number];
export type PermitTypeStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';

/** The permits of a type that are still on their way: retiring the type must not strand them (PMT 4, `PERMIT_TYPE_IN_USE`). */
export const OPEN_PERMIT_STATUSES = ['PLANNED', 'SUBMITTED', 'IN_APPRAISAL', 'SUPPLEMENT_REQUESTED'] as const;

const MAX_NAME = 300;
const MAX_AUTHORITY = 500;
const MAX_LEGAL_BASIS = 2000;
const MAX_VALIDITY_MONTHS = 1200;
const MAX_PROCESSING_DAYS = 3650;
const CODE = /^[A-Z][A-Z0-9_]{0,59}$/;
const CXN_REF = /^CXN-[A-Z0-9]+(-[A-Z0-9]+)*$/;
const CATEGORIES: ReadonlySet<string> = new Set(PERMIT_CATEGORIES);
const UNIQUE_VIOLATION = '23505';
const EXCLUSION_VIOLATION = '23P01';

export interface PermitTypeRow {
  id: string;
  code: string;
  revision: number;
  name: string;
  category: PermitCategory;
  authorityText: string;
  legalBasis: string;
  /** The confirmation id this version waits for; null once the legal text has been confirmed. */
  cxnRef: string | null;
  effectiveFrom: string;
  /** The last day the version applies (inclusive); null while it is open-ended. */
  effectiveUntil: string | null;
  appliesToRule: Record<string, unknown>;
  defaultValidityMonths: number | null;
  defaultProcessingDays: number | null;
  exemptionAllowed: boolean;
  status: PermitTypeStatus;
  supersedesId: string | null;
  version: number;
  /** Creation time to the microsecond (UTC): the ordering key of the list and its cursor. */
  createdAtKey: string;
}

export interface PermitTypeInput {
  code: string;
  name: string;
  category: string;
  authorityText: string;
  legalBasis: string;
  cxnRef?: string | undefined;
  effectiveFrom: string;
  effectiveUntil?: string | undefined;
  appliesToRule: unknown;
  defaultValidityMonths?: number | undefined;
  defaultProcessingDays?: number | undefined;
  exemptionAllowed?: boolean | undefined;
}

export interface PermitTypeFilter {
  code?: string | undefined;
  category?: PermitCategory | undefined;
  status?: PermitTypeStatus | undefined;
}

export interface PermitTypeStoreOptions {
  /** The current Vietnam date; injectable so that the rules on retroactive dates are testable. */
  today?: () => string;
}

interface SqlRow {
  id: string;
  code: string;
  revision: number;
  name: string;
  category: PermitCategory;
  authority_text: string;
  legal_basis: string;
  cxn_ref: string | null;
  effective_from: string;
  effective_until: string | null;
  applies_to_rule: Record<string, unknown>;
  default_validity_months: number | null;
  default_processing_days: number | null;
  exemption_allowed: boolean;
  status: PermitTypeStatus;
  supersedes_id: string | null;
  version: string;
  created_at_key: string;
}

const SELECT = `select id, code, revision, name, category, authority_text, legal_basis, cxn_ref, effective_from::text as effective_from,
  effective_until::text as effective_until, applies_to_rule, default_validity_months, default_processing_days, exemption_allowed, status,
  supersedes_id, version::text as version, ${timestampKey('created_at')} as created_at_key
  from machvon.permit_type`;

const toRow = (row: SqlRow): PermitTypeRow => ({
  id: row.id,
  code: row.code,
  revision: row.revision,
  name: row.name,
  category: row.category,
  authorityText: row.authority_text,
  legalBasis: row.legal_basis,
  cxnRef: row.cxn_ref,
  effectiveFrom: row.effective_from,
  effectiveUntil: row.effective_until,
  appliesToRule: row.applies_to_rule,
  defaultValidityMonths: row.default_validity_months,
  defaultProcessingDays: row.default_processing_days,
  exemptionAllowed: row.exemption_allowed,
  status: row.status,
  supersedesId: row.supersedes_id,
  version: Number(row.version),
  createdAtKey: row.created_at_key,
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const overlap = (): DomainError => new DomainError('PERMIT_TYPE_OVERLAP', 409);

/** A name or a text as it is stored: trimmed, not empty, without control characters, within its length. */
function textOf(value: string, field: string, max: number): string {
  const text = value.trim();
  // eslint-disable-next-line no-control-regex
  if (text === '' || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw invalid(field);
  return text;
}

function dateOf(value: string, field: string): string {
  if (!isIsoDate(value)) throw invalid(field);
  return value;
}

function countOf(value: number | undefined, field: string, max: number): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > max) throw invalid(field);
  return value;
}

/** The content of a version as it is stored, every rule of the table checked before the database is touched. */
interface CheckedType {
  code: string;
  name: string;
  category: PermitCategory;
  authorityText: string;
  legalBasis: string;
  cxnRef: string | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
  appliesToRule: Record<string, unknown>;
  defaultValidityMonths: number | null;
  defaultProcessingDays: number | null;
  exemptionAllowed: boolean;
}

function checked(input: PermitTypeInput): CheckedType {
  const code = input.code.trim();
  if (!CODE.test(code)) throw invalid('code');
  if (!CATEGORIES.has(input.category)) throw invalid('category');
  // The legal basis is the point of the catalogue (BR-PMT-03): a version without one is not law, and has a code of its own.
  if (input.legalBasis.trim() === '') throw new DomainError('LEGAL_BASIS_REQUIRED', 422, 'legal_basis');
  const cxnRef = input.cxnRef === undefined ? null : input.cxnRef.trim();
  if (cxnRef !== null && !CXN_REF.test(cxnRef)) throw invalid('cxn_ref');
  const effectiveFrom = dateOf(input.effectiveFrom, 'effective_from');
  const effectiveUntil = input.effectiveUntil === undefined ? null : dateOf(input.effectiveUntil, 'effective_until');
  if (effectiveUntil !== null && effectiveUntil <= effectiveFrom) throw invalid('effective_until');
  return {
    code,
    name: textOf(input.name, 'name', MAX_NAME),
    category: input.category as PermitCategory,
    authorityText: textOf(input.authorityText, 'authority_text', MAX_AUTHORITY),
    legalBasis: textOf(input.legalBasis, 'legal_basis', MAX_LEGAL_BASIS),
    cxnRef,
    effectiveFrom,
    effectiveUntil,
    appliesToRule: checkApplicability(input.appliesToRule),
    defaultValidityMonths: countOf(input.defaultValidityMonths, 'default_validity_months', MAX_VALIDITY_MONTHS),
    defaultProcessingDays: countOf(input.defaultProcessingDays, 'default_processing_days', MAX_PROCESSING_DAYS),
    exemptionAllowed: input.exemptionAllowed ?? false,
  };
}

/**
 * The permit type catalogue (ST-PMT-001, PMT 3.1 and BR-PMT-03): a regulation is data with a legal basis and the days it applies, and a
 * change of the regulation is a new revision of the same code, never an edit. A revision takes over from its first day and ends the one
 * before it the day before; a permit keeps the id of the version it was written under, so what already exists never moves. The exclusion
 * constraint and the immutability trigger of the table have the last word on overlaps and on edits; this store tells them apart first.
 */
export class PmtPermitTypeStore {
  private readonly today: () => string;

  constructor(options: PermitTypeStoreOptions = {}) {
    this.today = options.today ?? (() => vietnamDateOf(new Date()));
  }

  async find(tx: TenantTx, id: string, lock = false): Promise<PermitTypeRow | undefined> {
    const rows = await tx.query<SqlRow>(`${SELECT} where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** The versions of the tenant, the newest first, by code, category and status. */
  async list(tx: TenantTx, filter: PermitTypeFilter, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<PermitTypeRow[]> {
    const rows = await tx.query<SqlRow>(
      `${SELECT}
        where ($1::text is null or code = $1) and ($2::text is null or category = $2) and ($3::text is null or status = $3)
          and ($4::text is null or (${timestampKey('created_at')}, id) < ($4::text, $5::uuid))
        order by created_at desc, id desc limit $6`,
      [filter.code ?? null, filter.category ?? null, filter.status ?? null, request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(toRow);
  }

  /** The version of a code that applies on a Vietnam date, a retired one included while its last day has not passed; undefined when none does. */
  async inForce(tx: TenantTx, code: string, on: string): Promise<PermitTypeRow | undefined> {
    const rows = await tx.query<SqlRow>(
      `${SELECT} where code = $1 and status <> 'DRAFT' and effective_from <= $2::date and (effective_until is null or effective_until >= $2::date) limit 1`,
      [code, on],
    );
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /**
   * Publishes a version. A code seen for the first time starts at revision 1, which may begin on any day (the regulation may be in force
   * already). A code that exists gets the next revision, which takes over on its first day: the revision before it must not apply on or
   * after that day (otherwise 409 PERMIT_TYPE_OVERLAP), an open-ended one is ended the day before, and the new revision may not begin on a
   * day that is gone, because that would change which version applied on it.
   */
  async publish(tx: TenantTx, input: PermitTypeInput, actor: string): Promise<{ id: string; revision: number; version: number; supersededId: string | null }> {
    const type = checked(input);
    // One publication at a time per code: the checks below read what the other one is about to write.
    await tx.query("select pg_advisory_xact_lock(hashtextextended(coalesce(current_setting('app.tenant_id', true), '') || ':pmt-type:' || $1::text, 0))", [type.code]);
    const latestRow = (await tx.query<SqlRow>(`${SELECT} where code = $1 order by revision desc limit 1 for update`, [type.code]))[0];
    const latest = latestRow === undefined ? undefined : toRow(latestRow);
    const proposed = { from: type.effectiveFrom, until: type.effectiveUntil };
    let supersededId: string | null = null;
    if (latest !== undefined) {
      // An open-ended predecessor is ended the day before the new one begins; a closed one keeps its end.
      const endsBefore = latest.effectiveUntil ?? shiftDays(proposed.from, -1);
      // Revisions follow each other: the new one begins after the last one began and leaves it more than a day (a version spans more than a day).
      const notAfter = proposed.from <= latest.effectiveFrom || endsBefore <= latest.effectiveFrom;
      if (notAfter || periodsOverlap({ from: latest.effectiveFrom, until: endsBefore }, proposed)) throw overlap();
      if (proposed.from < this.today()) throw invalid('effective_from');
      await tx.query(
        `update machvon.permit_type set status = 'RETIRED', effective_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
        [latest.id, endsBefore, actor],
      );
      supersededId = latest.id;
    }
    const id = randomUUID();
    const revision = (latest?.revision ?? 0) + 1;
    try {
      await tx.query(
        `insert into machvon.permit_type
           (tenant_id, id, code, revision, name, category, authority_text, legal_basis, cxn_ref, effective_from, effective_until, applies_to_rule,
            default_validity_months, default_processing_days, exemption_allowed, status, supersedes_id, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11::jsonb, $12, $13, $14, 'PUBLISHED', $15::uuid, $16::uuid, $16::uuid)`,
        [
          id,
          type.code,
          revision,
          type.name,
          type.category,
          type.authorityText,
          type.legalBasis,
          type.cxnRef,
          type.effectiveFrom,
          type.effectiveUntil,
          JSON.stringify(type.appliesToRule),
          type.defaultValidityMonths,
          type.defaultProcessingDays,
          type.exemptionAllowed,
          supersededId,
          actor,
        ],
      );
    } catch (error) {
      // The exclusion constraint and the one-published index are the last word when two publications raced past the checks above.
      const { code, constraint } = error as { code?: string; constraint?: string };
      if (code === EXCLUSION_VIOLATION || (code === UNIQUE_VIOLATION && (constraint === 'permit_type_published_uq' || constraint === 'permit_type_rev_uq'))) throw overlap();
      throw error;
    }
    return { id, revision, version: 1, supersededId };
  }

  /**
   * Ends a version: the last day it applies. An end may only move earlier (the days after it were never promised), not into days that are
   * gone, and not past a permit still on its way that the version was written for: those permits would be left on a type that no longer
   * applies (422 PERMIT_TYPE_IN_USE). Issued permits and everything else that names the version are untouched; the row stays. Asking for
   * the end the version already has changes nothing.
   */
  async retire(tx: TenantTx, id: string, effectiveUntil: string, actor: string): Promise<{ row: PermitTypeRow; version: number; changed: boolean }> {
    const until = dateOf(effectiveUntil, 'effective_until');
    const row = await this.find(tx, id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.status === 'DRAFT') throw invalid('status');
    if (until <= row.effectiveFrom) throw invalid('effective_until');
    const unchanged = row.status === 'RETIRED' && row.effectiveUntil === until;
    if (row.effectiveUntil !== null && until > row.effectiveUntil) throw invalid('effective_until');
    if (!unchanged && until < this.today()) throw invalid('effective_until');
    if (await this.hasOpenPermitsPast(tx, id, until)) throw new DomainError('PERMIT_TYPE_IN_USE', 422);
    if (unchanged) return { row, version: row.version, changed: false };
    await tx.query(
      `update machvon.permit_type set status = 'RETIRED', effective_until = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [id, until, actor],
    );
    return { row, version: row.version + 1, changed: true };
  }

  /**
   * Publishes the starting catalogue of working assumptions for the codes the tenant has no version of yet (a code that exists in any
   * status is left alone, so a tenant that confirmed or retired a type is never given the assumption back). Returns the codes it added.
   */
  async seedWorkingAssumptions(tx: TenantTx, actor: string): Promise<string[]> {
    const present = new Set((await tx.query<{ code: string }>('select distinct code from machvon.permit_type')).map((row) => row.code));
    const added: string[] = [];
    for (const type of PERMIT_TYPE_WORKING_ASSUMPTIONS) {
      if (present.has(type.code)) continue;
      await this.publish(tx, type, actor);
      added.push(type.code);
    }
    return added;
  }

  /** Whether a permit written under the version is still on its way and could be decided after the version's last day. */
  private async hasOpenPermitsPast(tx: TenantTx, typeId: string, lastDay: string): Promise<boolean> {
    const rows = await tx.query<{ id: string }>(
      `select id from machvon.permit
        where permit_type_id = $1::uuid and status = any($2::text[]) and (expected_decision_on is null or expected_decision_on > $3::date) limit 1`,
      [typeId, [...OPEN_PERMIT_STATUSES], lastDay],
    );
    return rows.length > 0;
  }
}
