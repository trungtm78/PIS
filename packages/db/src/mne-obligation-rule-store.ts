import { randomUUID } from 'node:crypto';
import { DomainError, MNE_FREQUENCIES, assertFourEyes, isIsoDate, parseDueRule, versionConflict } from '@machvon/kernel';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import { MneRevisionTable } from './mne-revision-table.ts';
import type { ClosedRevision } from './mne-revision-table.ts';
import type { MneOrigin, MneRevisionStatus } from './mne-form-store.ts';
import type { TenantTx } from './tenant-database.ts';

export const MNE_REPORTING_ROLES = ['INVESTOR', 'PROJECT_OWNER_AGENCY', 'PROVINCIAL_PEOPLE_COMMITTEE', 'PLANNING_AGENCY'] as const;
export type MneReportingRole = (typeof MNE_REPORTING_ROLES)[number];

const RULE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/;
const MAX_RECIPIENT = 300;
const MIN_RECIPIENT = 2;
const MAX_LEGAL_BASIS = 2000;
const MIN_LEGAL_BASIS = 3;
const MAX_REFERENCE = 50;

/** One revision of an obligation rule: who files which form how often, and the formula of the deadline. */
export interface MneRuleRow {
  id: string;
  ruleCode: string;
  revision: number;
  /** The form revision the rule was written against; a report uses the revision in force on the last day of its period (BR-MNE-02). */
  formId: string;
  formCode: string;
  reportingRole: MneReportingRole;
  recipient: string;
  frequency: string;
  dueRuleJson: Record<string, unknown>;
  legalBasis: string;
  legalConfirmationRef: string | null;
  effectiveFrom: string;
  /** Exclusive: the first day the revision no longer applies. */
  effectiveUntil: string | null;
  status: MneRevisionStatus;
  origin: MneOrigin;
  packVersion: string | null;
  version: number;
  createdBy: string;
  approvedBy: string | null;
  /** Creation time to the microsecond (UTC): the ordering key of the list and its cursor. */
  createdAtKey: string;
}

export interface MneRuleFilter {
  reportingRole?: MneReportingRole | undefined;
  formCode?: string | undefined;
  status?: MneRevisionStatus | undefined;
}

export interface MneRulePage {
  limit: number;
  after?: { createdAtKey: string; id: string } | undefined;
}

export interface MneRuleInput {
  ruleCode: string;
  formId: string;
  reportingRole: string;
  recipient: string;
  frequency: string;
  dueRuleJson: unknown;
  legalBasis: string;
  legalConfirmationRef?: string | undefined;
  effectiveFrom: string;
  effectiveUntil?: string | undefined;
}

/** A rule of the platform pack names its form by code: the revision in force on the day the rule starts. */
export interface MneRulePackEntry extends Omit<MneRuleInput, 'formId'> {
  formCode: string;
}

export interface MneRulePackResult {
  inserted: string[];
  upgraded: string[];
  unchanged: string[];
  /** FORM_NOT_EFFECTIVE: the form of the rule is not in force on the day it starts (the form pack was not loaded or was skipped). */
  skipped: Array<{ ruleCode: string; reason: 'TENANT_REVISION' | 'NOT_SUPERSEDABLE' | 'FORM_NOT_EFFECTIVE' }>;
}

interface Sql {
  id: string;
  rule_code: string;
  revision: number;
  form_id: string;
  form_code: string;
  reporting_role: MneReportingRole;
  recipient: string;
  frequency: string;
  due_rule_json: Record<string, unknown>;
  legal_basis: string;
  legal_confirmation_ref: string | null;
  effective_from: string;
  effective_until: string | null;
  status: MneRevisionStatus;
  origin: MneOrigin;
  pack_version: string | null;
  version: string;
  created_by: string;
  approved_by: string | null;
  created_at_key: string;
}

const SELECT = `select o.id, o.rule_code, o.revision, o.form_id, f.form_code, o.reporting_role, o.recipient, o.frequency, o.due_rule_json, o.legal_basis,
  o.legal_confirmation_ref, o.effective_from::text as effective_from, o.effective_until::text as effective_until, o.status, o.origin, o.pack_version,
  o.version::text as version, o.created_by, o.approved_by, ${timestampKey('o.created_at')} as created_at_key
  from machvon.mne_obligation_rule o join machvon.mne_report_form f on f.tenant_id = o.tenant_id and f.id = o.form_id`;

const toRow = (row: Sql): MneRuleRow => ({
  id: row.id,
  ruleCode: row.rule_code,
  revision: row.revision,
  formId: row.form_id,
  formCode: row.form_code,
  reportingRole: row.reporting_role,
  recipient: row.recipient,
  frequency: row.frequency,
  dueRuleJson: row.due_rule_json,
  legalBasis: row.legal_basis,
  legalConfirmationRef: row.legal_confirmation_ref,
  effectiveFrom: row.effective_from,
  effectiveUntil: row.effective_until,
  status: row.status,
  origin: row.origin,
  packVersion: row.pack_version,
  version: Number(row.version),
  createdBy: row.created_by,
  approvedBy: row.approved_by,
  createdAtKey: row.created_at_key,
});

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const rangeOverlap = (): DomainError => new DomainError('EFFECTIVE_RANGE_OVERLAP', 409, 'effective_from');
const formNotEffective = (): DomainError => new DomainError('FORM_NOT_EFFECTIVE', 422, 'form_id');

function textOf(value: string, field: string, min: number, max: number): string {
  const text = value.trim();
  // eslint-disable-next-line no-control-regex
  if (text.length < min || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw invalid(field);
  return text;
}

interface CheckedRule {
  ruleCode: string;
  reportingRole: MneReportingRole;
  recipient: string;
  frequency: string;
  dueRuleJson: Record<string, unknown>;
  legalBasis: string;
  legalConfirmationRef: string | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
}

function checked(input: MneRuleInput): CheckedRule {
  const ruleCode = input.ruleCode.trim();
  if (!RULE_CODE.test(ruleCode)) throw invalid('rule_code');
  if (!(MNE_REPORTING_ROLES as readonly string[]).includes(input.reportingRole)) throw invalid('reporting_role');
  if (!(MNE_FREQUENCIES as readonly string[]).includes(input.frequency)) throw invalid('frequency');
  if (!isIsoDate(input.effectiveFrom)) throw invalid('effective_from');
  if (input.effectiveUntil !== undefined && (!isIsoDate(input.effectiveUntil) || input.effectiveUntil <= input.effectiveFrom)) throw invalid('effective_until');
  // The formula is read once here so that a rule nobody can evaluate is never stored (BR-MNE-03).
  parseDueRule(input.frequency, input.dueRuleJson);
  const reference = input.legalConfirmationRef === undefined || input.legalConfirmationRef.trim() === '' ? null : textOf(input.legalConfirmationRef, 'legal_confirmation_ref', 1, MAX_REFERENCE);
  return {
    ruleCode,
    reportingRole: input.reportingRole as MneReportingRole,
    recipient: textOf(input.recipient, 'recipient', MIN_RECIPIENT, MAX_RECIPIENT),
    frequency: input.frequency,
    dueRuleJson: input.dueRuleJson as Record<string, unknown>,
    legalBasis: textOf(input.legalBasis, 'legal_basis', MIN_LEGAL_BASIS, MAX_LEGAL_BASIS),
    legalConfirmationRef: reference,
    effectiveFrom: input.effectiveFrom,
    effectiveUntil: input.effectiveUntil ?? null,
  };
}

/**
 * The obligation rules of the monitoring module (ST-MNE-001, MNE F1, BR-MNE-01, BR-MNE-03): who files which form, how often, to whom, and
 * the formula of the deadline, as data with a legal basis and an effective period. A rule is drafted by one person and published by
 * another, and a revision never changes: a change is a new revision that takes over from a date. The form it names must be published and
 * in force on the day the rule starts.
 */
export class MneObligationRuleStore {
  private readonly table = new MneRevisionTable('mne_obligation_rule', 'rule_code', rangeOverlap);

  async find(tx: TenantTx, id: string, lock = false): Promise<MneRuleRow | undefined> {
    const rows = await tx.query<Sql>(`${SELECT} where o.id = $1::uuid${lock ? ' for update of o' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toRow(rows[0]);
  }

  /** The revisions of the tenant, the newest first, narrowed by reporting role, form code and status (MNE F1). */
  async list(tx: TenantTx, filter: MneRuleFilter, page: MneRulePage): Promise<MneRuleRow[]> {
    assertTimestampCursor(page.after?.createdAtKey);
    const rows = await tx.query<Sql>(
      `${SELECT}
        where ($1::text is null or o.reporting_role = $1) and ($2::text is null or f.form_code = $2) and ($3::text is null or o.status = $3)
          and ($4::text is null or (${timestampKey('o.created_at')}, o.id) < ($4::text, $5::uuid))
        order by o.created_at desc, o.id desc limit $6`,
      [filter.reportingRole ?? null, filter.formCode ?? null, filter.status ?? null, page.after?.createdAtKey ?? null, page.after?.id ?? null, page.limit],
    );
    return rows.map(toRow);
  }

  /** The published rules, retired ones included, whose period meets the window `[from, until)`: what the generation of a year reads. */
  async inWindow(tx: TenantTx, window: { from: string; until: string }): Promise<MneRuleRow[]> {
    const rows = await tx.query<Sql>(
      `${SELECT}
        where o.status <> 'DRAFT' and o.effective_from < $2::date and (o.effective_until is null or o.effective_until > $1::date)
        order by o.rule_code, o.revision`,
      [window.from, window.until],
    );
    return rows.map(toRow);
  }

  /** Drafts the next revision of a code against a form that is published and in force on the day the rule starts. */
  async create(tx: TenantTx, input: MneRuleInput, actor: string): Promise<MneRuleRow> {
    const rule = checked(input);
    await this.assertForm(tx, input.formId, rule.effectiveFrom);
    await this.table.lockCode(tx, rule.ruleCode);
    await this.table.predecessors(tx, rule.ruleCode, null, { from: rule.effectiveFrom, until: rule.effectiveUntil });
    const id = await this.insert(tx, input.formId, rule, { status: 'DRAFT', origin: 'TENANT', packVersion: null, actor });
    return this.reread(tx, id);
  }

  /** The approval of a draft by someone other than its maker; an open-ended revision takes over from the one in force, as a form does. */
  async publish(tx: TenantTx, id: string, expectedVersion: number, publisher: string): Promise<{ record: MneRuleRow; closed: ClosedRevision[] }> {
    const head = await this.find(tx, id);
    if (head === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.table.lockCode(tx, head.ruleCode);
    const row = await this.find(tx, id, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    assertFourEyes(row.createdBy, publisher);
    if (row.status !== 'DRAFT') throw new DomainError('REPORT_STATE_INVALID', 409, 'status');
    await this.assertForm(tx, row.formId, row.effectiveFrom);
    const earlier = await this.table.predecessors(tx, row.ruleCode, row.id, { from: row.effectiveFrom, until: row.effectiveUntil });
    const closed = await this.table.retire(tx, earlier, row.effectiveFrom, publisher);
    try {
      await tx.query(
        `update machvon.mne_obligation_rule set status = 'PUBLISHED', approved_by = $2::uuid, published_at = now(), updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
        [id, publisher],
      );
    } catch (error) {
      throw this.table.asOverlap(error);
    }
    return { record: await this.reread(tx, id), closed };
  }

  /** Loads the rules of the platform pack, published and waiting for their legal confirmation; the form of each is read by its code. */
  async loadPack(tx: TenantTx, packVersion: string, entries: readonly MneRulePackEntry[], actor: string): Promise<MneRulePackResult> {
    const result: MneRulePackResult = { inserted: [], upgraded: [], unchanged: [], skipped: [] };
    for (const entry of entries) {
      const rule = checked({ ...entry, formId: '' });
      await this.table.lockCode(tx, rule.ruleCode);
      const existing = await tx.query<{ origin: MneOrigin; pack_version: string | null; status: MneRevisionStatus; effective_from: string; effective_until: string | null }>(
        'select origin, pack_version, status, effective_from::text as effective_from, effective_until::text as effective_until from machvon.mne_obligation_rule where rule_code = $1 order by revision desc',
        [rule.ruleCode],
      );
      if (existing.some((row) => row.origin === 'TENANT')) {
        result.skipped.push({ ruleCode: rule.ruleCode, reason: 'TENANT_REVISION' });
        continue;
      }
      if (existing.some((row) => row.pack_version === packVersion)) {
        result.unchanged.push(rule.ruleCode);
        continue;
      }
      const current = existing.find((row) => row.status === 'PUBLISHED' && row.effective_until === null);
      if (current !== undefined && current.effective_from >= rule.effectiveFrom) {
        result.skipped.push({ ruleCode: rule.ruleCode, reason: 'NOT_SUPERSEDABLE' });
        continue;
      }
      const form = await tx.query<{ id: string }>(
        `select id from machvon.mne_report_form where form_code = $1 and status <> 'DRAFT' and effective_from <= $2::date and (effective_until is null or $2::date < effective_until)`,
        [entry.formCode, rule.effectiveFrom],
      );
      if (form[0] === undefined) {
        result.skipped.push({ ruleCode: rule.ruleCode, reason: 'FORM_NOT_EFFECTIVE' });
        continue;
      }
      const earlier = await this.table.predecessors(tx, rule.ruleCode, null, { from: rule.effectiveFrom, until: rule.effectiveUntil });
      await this.table.retire(tx, earlier, rule.effectiveFrom, actor);
      await this.insert(tx, form[0].id, rule, { status: 'PUBLISHED', origin: 'PLATFORM_PACK', packVersion, actor });
      (existing.length === 0 ? result.inserted : result.upgraded).push(rule.ruleCode);
    }
    return result;
  }

  /** FORM_NOT_EFFECTIVE unless the form is a published revision (retired ones count) that is in force on the day the rule starts. */
  private async assertForm(tx: TenantTx, formId: string, on: string): Promise<void> {
    const rows = await tx.query<{ id: string }>(
      `select id from machvon.mne_report_form where id = $1::uuid and status <> 'DRAFT' and effective_from <= $2::date and (effective_until is null or $2::date < effective_until)`,
      [formId, on],
    );
    if (rows[0] === undefined) {
      // A form of another tenant is indistinguishable from one that does not exist.
      const known = await tx.query('select 1 from machvon.mne_report_form where id = $1::uuid', [formId]);
      throw known.length === 0 ? invalid('form_id') : formNotEffective();
    }
  }

  private async insert(tx: TenantTx, formId: string, rule: CheckedRule, how: { status: 'DRAFT' | 'PUBLISHED'; origin: MneOrigin; packVersion: string | null; actor: string }): Promise<string> {
    const id = randomUUID();
    const revision = await this.table.nextRevision(tx, rule.ruleCode);
    try {
      await tx.query(
        `insert into machvon.mne_obligation_rule
           (tenant_id, id, rule_code, form_id, reporting_role, recipient, frequency, due_rule_json, legal_basis, legal_confirmation_ref, effective_from, effective_until,
            revision, status, origin, pack_version, published_at, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb, $8, $9, $10::date, $11::date, $12, $13, $14, $15,
                 case when $13 = 'PUBLISHED' then now() end, $16::uuid, $16::uuid)`,
        [
          id,
          rule.ruleCode,
          formId,
          rule.reportingRole,
          rule.recipient,
          rule.frequency,
          JSON.stringify(rule.dueRuleJson),
          rule.legalBasis,
          rule.legalConfirmationRef,
          rule.effectiveFrom,
          rule.effectiveUntil,
          revision,
          how.status,
          how.origin,
          how.packVersion,
          how.actor,
        ],
      );
    } catch (error) {
      throw this.table.asOverlap(error);
    }
    return id;
  }

  private async reread(tx: TenantTx, id: string): Promise<MneRuleRow> {
    const row = await this.find(tx, id);
    if (row === undefined) throw new Error('the rule vanished after its write');
    return row;
  }
}
