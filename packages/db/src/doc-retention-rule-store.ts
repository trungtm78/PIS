import { randomUUID } from 'node:crypto';
import { DomainError, assertFourEyes, versionConflict } from '@machvon/kernel';
import type { RetentionClass, RetentionRuleSet, RetentionStartBasis } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const EXCLUSION_VIOLATION = '23P01';
const UNIQUE_VIOLATION = '23505';
const SAVEPOINT = 'retention_rule_write';
const RULE_SETS: readonly string[] = ['TT74_2025_BTC', 'TT10_2022_BNV', 'TENANT_CUSTOM'];
const CLASSES: readonly string[] = ['PERMANENT', 'Y70', 'Y20', 'Y10', 'Y5'];
const START_BASES: readonly string[] = ['FROM_CLOSED', 'FROM_SETTLEMENT', 'FROM_ISSUED'];
/** The years a class stands for: the years of a rule are those of its class (a permanent class has none). */
const CLASS_YEARS: Readonly<Record<string, number | null>> = { PERMANENT: null, Y70: 70, Y20: 20, Y10: 10, Y5: 5 };
const CATEGORY = /^[A-Z][A-Z0-9_]{1,59}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_LEGAL_BASIS = 2000;
const MAX_REF = 50;
const MIN_REF = 3;
const MAX_NOTE = 1000;
const MAX_HANDOVER_MONTHS = 240;

export type RuleStatus = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';

export interface RetentionRuleDetail {
  id: string;
  ruleSet: RetentionRuleSet;
  categoryCode: string;
  classCode: RetentionClass;
  retentionYears: number | null;
  startBasis: RetentionStartBasis;
  handoverMonths: number;
  endAction: string;
  legalBasis: string;
  legalConfirmationRef: string | null;
  confirmationStatus: 'CONFIRMED' | 'PENDING_CONFIRMATION';
  precedence: number;
  effectiveFrom: string;
  /** Exclusive: the first day the rule no longer applies. */
  effectiveUntil: string | null;
  status: RuleStatus;
  createdBy: string;
  approvedBy: string | null;
  legalConfirmedBy: string | null;
  legalConfirmedByName: string | null;
  createdByName: string | null;
  approvedByName: string | null;
  version: number;
}

export interface NewRetentionRule {
  ruleSet: string;
  categoryCode: string;
  classCode: string;
  retentionYears?: number | undefined;
  startBasis: string;
  handoverMonths?: number | undefined;
  legalBasis: string;
  precedence?: number | undefined;
  effectiveFrom: string;
  effectiveUntil?: string | undefined;
  actor: string;
}

export interface RuleConfirmation {
  reference: string;
  evidenceDocumentId: string;
  note?: string | undefined;
}

interface RuleSql {
  id: string;
  rule_set: RetentionRuleSet;
  category_code: string;
  class_code: RetentionClass;
  retention_years: number | null;
  start_basis: RetentionStartBasis;
  handover_months: number;
  end_action: string;
  legal_basis: string;
  legal_confirmation_ref: string | null;
  confirmation_status: 'CONFIRMED' | 'PENDING_CONFIRMATION';
  precedence: number;
  effective_from: string;
  effective_until: string | null;
  status: RuleStatus;
  created_by: string;
  approved_by: string | null;
  legal_confirmed_by: string | null;
  created_by_name: string | null;
  approved_by_name: string | null;
  legal_confirmed_by_name: string | null;
  version: string;
}

const name = (column: string): string => `(select d.display_name from machvon.tenant_user_directory d where d.tenant_id = r.tenant_id and d.membership_id = r.${column})`;
const COLUMNS = `r.id, r.rule_set, r.category_code, r.class_code, r.retention_years, r.start_basis, r.handover_months, r.end_action, r.legal_basis, r.legal_confirmation_ref, r.confirmation_status, r.precedence,
  r.effective_from::text as effective_from, r.effective_until::text as effective_until, r.status, r.created_by, r.approved_by, r.legal_confirmed_by, ${name('created_by')} as created_by_name,
  ${name('approved_by')} as approved_by_name, ${name('legal_confirmed_by')} as legal_confirmed_by_name, r.version::text as version`;

const toDetail = (row: RuleSql): RetentionRuleDetail => ({
  id: row.id,
  ruleSet: row.rule_set,
  categoryCode: row.category_code,
  classCode: row.class_code,
  retentionYears: row.retention_years,
  startBasis: row.start_basis,
  handoverMonths: row.handover_months,
  endAction: row.end_action,
  legalBasis: row.legal_basis,
  legalConfirmationRef: row.legal_confirmation_ref,
  confirmationStatus: row.confirmation_status,
  precedence: row.precedence,
  effectiveFrom: row.effective_from,
  effectiveUntil: row.effective_until,
  status: row.status,
  createdBy: row.created_by,
  approvedBy: row.approved_by,
  legalConfirmedBy: row.legal_confirmed_by,
  legalConfirmedByName: row.legal_confirmed_by_name,
  createdByName: row.created_by_name,
  approvedByName: row.approved_by_name,
  version: Number(row.version),
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const overlap = (): DomainError => new DomainError('RETENTION_RANGE_OVERLAP', 409, 'effective_from');
const stateInvalid = (): DomainError => new DomainError('RETENTION_STATE_INVALID', 409, 'status');

function dayOf(value: string, field: string): string {
  const match = DATE.exec(value);
  const date = match === null ? undefined : new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (match === null || date === undefined || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) throw invalid(field);
  return value;
}

const wholeNumber = (value: number | undefined, field: string, min: number, max: number): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(field);
  return value;
};

/**
 * The retention rules of a tenant (ST-DOC-017, DOC.md F11, BR-DOC-22): a rule is drafted by one person, published by another and its legal basis confirmed by a third (the confirmation is what lets a dossier closed under
 * it stop being provisional). The rules of one rule set and category never overlap in time (409 RETENTION_RANGE_OVERLAP, at drafting against the published ones and at publishing against all of them); the end of a rule
 * is the first day of the next. A dossier keeps the rule it was closed under, whatever is published later. The database holds the same order (V1229).
 */
export class DocRetentionRuleStore {
  async find(tx: TenantTx, id: string, lock = false): Promise<RetentionRuleDetail | undefined> {
    const [row] = await tx.query<RuleSql>(`select ${COLUMNS} from machvon.doc_retention_rule r where r.id = $1::uuid${lock ? ' for update of r' : ''}`, [id]);
    return row === undefined ? undefined : toDetail(row);
  }

  /** A rule is drafted: every member is judged (the years are those of the class; a permanent class has none) and a period that overlaps a published rule of the same set and category is refused. */
  async create(tx: TenantTx, input: NewRetentionRule): Promise<RetentionRuleDetail> {
    if (!RULE_SETS.includes(input.ruleSet)) throw invalid('rule_set');
    if (!CATEGORY.test(input.categoryCode)) throw invalid('category_code');
    if (!CLASSES.includes(input.classCode)) throw invalid('class_code');
    const years = wholeNumber(input.retentionYears, 'retention_years', 1, 200);
    const expected = CLASS_YEARS[input.classCode] ?? null;
    if (expected === null ? years !== undefined : years !== undefined && years !== expected) throw invalid('retention_years');
    if (!START_BASES.includes(input.startBasis)) throw invalid('start_basis');
    const handoverMonths = wholeNumber(input.handoverMonths, 'handover_months', 0, MAX_HANDOVER_MONTHS) ?? 12;
    const precedence = wholeNumber(input.precedence, 'precedence', 1, 1000) ?? 100;
    const legalBasis = input.legalBasis.trim();
    if (legalBasis === '') throw new DomainError('LEGAL_BASIS_REQUIRED', 422, 'legal_basis');
    if (legalBasis.length < 3 || legalBasis.length > MAX_LEGAL_BASIS) throw invalid('legal_basis');
    const from = dayOf(input.effectiveFrom, 'effective_from');
    const until = input.effectiveUntil === undefined ? null : dayOf(input.effectiveUntil, 'effective_until');
    if (until !== null && until <= from) throw invalid('effective_until');
    const taken = await tx.query(
      `select 1 from machvon.doc_retention_rule
        where rule_set = $1 and category_code = $2 and status = 'PUBLISHED' and daterange(effective_from, effective_until, '[)') && daterange($3::date, $4::date, '[)') limit 1`,
      [input.ruleSet, input.categoryCode, from, until],
    );
    if (taken.length > 0) throw overlap();
    const id = randomUUID();
    await tx.query(`savepoint ${SAVEPOINT}`);
    try {
      await tx.query(
        `insert into machvon.doc_retention_rule
           (tenant_id, id, rule_set, category_code, class_code, retention_years, start_basis, handover_months, legal_basis, precedence, effective_from, effective_until, status, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5::int, $6, $7::int, $8, $9::int, $10::date, $11::date, 'DRAFT', $12::uuid, $12::uuid)`,
        [id, input.ruleSet, input.categoryCode, input.classCode, expected === null ? null : (years ?? expected), input.startBasis, handoverMonths, legalBasis, precedence, from, until, input.actor],
      );
      await tx.query(`release savepoint ${SAVEPOINT}`);
    } catch (error) {
      // A rule of the same set and category that starts the same day is an overlap too (the unique index of V002).
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      await tx.query(`rollback to savepoint ${SAVEPOINT}`);
      throw overlap();
    }
    return this.reread(tx, id);
  }

  /** The approval of a draft by someone other than its drafter (403 SELF_APPROVAL_DENIED); an overlap with a published rule is 409 RETENTION_RANGE_OVERLAP, a rule that is not a draft 409 RETENTION_STATE_INVALID. */
  async publish(tx: TenantTx, id: string, expectedVersion: number, publisher: string): Promise<RetentionRuleDetail> {
    const row = await this.locked(tx, id, expectedVersion);
    assertFourEyes(row.createdBy, publisher);
    if (row.status !== 'DRAFT') throw stateInvalid();
    try {
      await tx.query("update machvon.doc_retention_rule set status = 'PUBLISHED', approved_by = $2::uuid, published_at = now(), updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [id, publisher]);
    } catch (error) {
      if ((error as { code?: string }).code === EXCLUSION_VIOLATION) throw overlap();
      throw error;
    }
    return this.reread(tx, id);
  }

  /**
   * The legal confirmation of a published rule, by someone who neither drafted nor published it, with the reference of the confirmation and the document that proves it (422 CONFIRMATION_REF_REQUIRED without a reference).
   * From then on a dossier closed under the rule is no longer provisional.
   */
  async confirm(tx: TenantTx, id: string, expectedVersion: number, input: RuleConfirmation, confirmer: string): Promise<RetentionRuleDetail> {
    const row = await this.locked(tx, id, expectedVersion);
    if (row.status !== 'PUBLISHED' || row.confirmationStatus !== 'PENDING_CONFIRMATION') throw stateInvalid();
    const reference = input.reference.trim();
    if (reference.length < MIN_REF || reference.length > MAX_REF) throw new DomainError('CONFIRMATION_REF_REQUIRED', 422, 'legal_confirmation_ref');
    assertFourEyes(row.createdBy, confirmer);
    if (row.approvedBy !== null) assertFourEyes(row.approvedBy, confirmer);
    const note = input.note === undefined || input.note.trim() === '' ? null : input.note.trim();
    if (note !== null && note.length > MAX_NOTE) throw invalid('note');
    const evidence = await tx.query('select 1 from machvon.document where id = $1::uuid', [input.evidenceDocumentId]);
    if (evidence.length === 0) throw invalid('evidence_document_id');
    await tx.query(
      `update machvon.doc_retention_rule
          set confirmation_status = 'CONFIRMED', legal_confirmation_ref = $2, legal_confirmed_by = $3::uuid, legal_confirmed_at = now(), legal_evidence_document_id = $4::uuid, legal_confirmation_note = $5,
              updated_at = now(), updated_by = $3::uuid, version = version + 1
        where id = $1::uuid`,
      [id, reference, confirmer, input.evidenceDocumentId, note],
    );
    return this.reread(tx, id);
  }

  private async locked(tx: TenantTx, id: string, expectedVersion: number): Promise<RetentionRuleDetail> {
    const row = await this.find(tx, id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    return row;
  }

  private async reread(tx: TenantTx, id: string): Promise<RetentionRuleDetail> {
    const row = await this.find(tx, id);
    if (row === undefined) throw new Error('the retention rule vanished after its write');
    return row;
  }
}
