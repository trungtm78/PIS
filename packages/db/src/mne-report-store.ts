import { randomUUID } from 'node:crypto';
import {
  DomainError,
  addSums,
  assertReportState,
  fitsKind,
  isIsoDate,
  missingFields,
  narrativeFaults,
  parseReportSchema,
  periodEndOfLabel,
  rateOfSums,
  versionConflict,
} from '@machvon/kernel';
import type { MneReportSchema, MneReportStatus } from '@machvon/kernel';
import { DisSnapshotStore } from './dis-snapshot-store.ts';
import { MasterRules } from './master-rules.ts';
import { MneFormStore } from './mne-form-store.ts';
import { MneObligationStore } from './mne-obligation-store.ts';
import type { MneFormRow } from './mne-form-store.ts';
import { idOf } from './prj-accountability-support.ts';
import { invalid, usableDocumentId } from './prj-stage-support.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const MNE_REPORT_RESOURCE = 'mne_report';
const SNAPSHOT_KINDS: readonly string[] = ['PERIOD_CLOSE', 'MNE'];
const OPEN_WARNING = ['OPEN', 'ACKNOWLEDGED', 'EXPLANATION_REQUESTED'];
const UNIQUE_VIOLATION = '23505';
const KEY_INDEX = 'mne_report_rev_uq';
const SAVEPOINT = 'mne_report_write';
/** The figures of a report are the figures of its unit: who may prepare the report for the unit was judged before they are read. */
const WHOLE_UNIT: ScopeBuilder = () => ({ sql: 'true', params: [] });

export interface MnePayload {
  /** What the system filled from its sources: locked. */
  values: Record<string, unknown>;
  /** What a person wrote. */
  narrative: Record<string, unknown>;
  attachments: string[];
  meta: Record<string, unknown>;
}

export interface MneReportRow {
  id: string;
  formId: string;
  formCode: string;
  formRevision: number;
  formTitle: string;
  formLegalConfirmationRef: string | null;
  watermarkText: string | null;
  schema: MneReportSchema;
  reportYear: number;
  periodLabel: string;
  periodId: string | null;
  scopeUnitId: string;
  unitCode: string;
  unitName: string;
  projectId: string | null;
  snapshotId: string | null;
  dueDate: string;
  revision: number;
  status: MneReportStatus;
  isLate: boolean;
  payload: MnePayload;
  payloadSha256: string | null;
  docDocumentId: string | null;
  supersedesId: string | null;
  correctionReason: string | null;
  submittedBy: string | null;
  approvedBy: string | null;
  createdBy: string;
  version: number;
}

interface ReportSql {
  id: string;
  form_id: string;
  form_code: string;
  form_revision: number;
  form_title: string;
  form_legal_confirmation_ref: string | null;
  watermark_text: string | null;
  schema_json: Record<string, unknown>;
  report_year: number;
  period_label: string;
  period_id: string | null;
  scope_unit_id: string;
  unit_code: string;
  unit_name: string;
  project_id: string | null;
  snapshot_id: string | null;
  due_date: string;
  revision: number;
  status: MneReportStatus;
  is_late: boolean;
  payload_json: Record<string, unknown>;
  payload_sha256: string | null;
  doc_document_id: string | null;
  supersedes_id: string | null;
  correction_reason: string | null;
  submitted_by: string | null;
  approved_by: string | null;
  created_by: string;
  version: string;
}

const COLUMNS = `r.id, r.form_id, f.form_code, f.revision as form_revision, f.title as form_title, f.legal_confirmation_ref as form_legal_confirmation_ref, f.watermark_text, f.schema_json, r.report_year,
  r.period_label, r.period_id, r.scope_unit_id, u.code as unit_code, u.name as unit_name, r.project_id, r.snapshot_id, r.due_date::text as due_date, r.revision, r.status, r.is_late, r.payload_json, r.payload_sha256,
  r.doc_document_id, r.supersedes_id, r.correction_reason, r.submitted_by, r.approved_by, r.created_by, r.version::text as version`;
const FROM = `machvon.mne_report r join machvon.mne_report_form f on f.tenant_id = r.tenant_id and f.id = r.form_id join machvon.organization_unit u on u.tenant_id = r.tenant_id and u.id = r.scope_unit_id`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function payloadOf(raw: Record<string, unknown>): MnePayload {
  return {
    values: isRecord(raw.values) ? raw.values : {},
    narrative: isRecord(raw.narrative) ? raw.narrative : {},
    attachments: Array.isArray(raw.attachments) ? raw.attachments.filter((item): item is string => typeof item === 'string') : [],
    meta: isRecord(raw.meta) ? raw.meta : {},
  };
}

const rowOf = (row: ReportSql): MneReportRow => ({
  id: row.id,
  formId: row.form_id,
  formCode: row.form_code,
  formRevision: row.form_revision,
  formTitle: row.form_title,
  formLegalConfirmationRef: row.form_legal_confirmation_ref,
  watermarkText: row.watermark_text,
  schema: parseReportSchema(row.schema_json),
  reportYear: row.report_year,
  periodLabel: row.period_label,
  periodId: row.period_id,
  scopeUnitId: row.scope_unit_id,
  unitCode: row.unit_code,
  unitName: row.unit_name,
  projectId: row.project_id,
  snapshotId: row.snapshot_id,
  dueDate: row.due_date,
  revision: row.revision,
  status: row.status,
  isLate: row.is_late,
  payload: payloadOf(row.payload_json),
  payloadSha256: row.payload_sha256,
  docDocumentId: row.doc_document_id,
  supersedesId: row.supersedes_id,
  correctionReason: row.correction_reason,
  submittedBy: row.submitted_by,
  approvedBy: row.approved_by,
  createdBy: row.created_by,
  version: Number(row.version),
});

export interface CreateInput {
  formId: string;
  reportYear: number;
  periodLabel: string;
  periodId?: string | undefined;
  scopeUnitId: string;
  projectId?: string | undefined;
  snapshotId?: string | undefined;
  actor: string;
  obligationRuleId?: string | undefined;
  /** Today in Vietnam: a weekly rule is read from the calendar in force today. */
  today: string;
  /** The units the caller may prepare reports for (the alias `u` of the unit table). */
  unitScope: ScopeBuilder;
}

export interface EditInput {
  id: string;
  /** Today in Vietnam: a weekly report is read from the calendar in force today. */
  today: string;
  expectedVersion: number;
  narrative?: Record<string, unknown> | undefined;
  attachments?: readonly string[] | undefined;
  snapshotId?: string | undefined;
  actor: string;
  unitScope: ScopeBuilder;
}

export interface SubmitInput {
  id: string;
  expectedVersion: number;
  actor: string;
  now: Date;
  unitScope: ScopeBuilder;
}

export interface MneReportChange {
  row: MneReportRow;
  previousStatus: MneReportStatus | null;
  /** The snapshot attached or replaced by the command, when it was. */
  snapshotAttached: string | null;
}

/**
 * The periodic report of monitoring and evaluation (ST-MNE-002, MNE 3.1 F3, BR-MNE-02): made on the form revision in force on the last day of its period (422 FORM_NOT_EFFECTIVE, naming the day the nearest revision
 * takes effect), from a FROZEN snapshot (422 SNAPSHOT_REQUIRED, 422 SNAPSHOT_NOT_FROZEN) whose figures fill the cells that have a source; those cells are locked (422 FIELD_SOURCE_LOCKED when a narrative names one),
 * the text cells are written by hand while the report is a DRAFT. A shell made by the filing calendar is opened by an edit; another report with the same key is 409 REPORT_EXISTS. Handing a report in needs the
 * snapshot and every cell the form requires. A report that left DRAFT keeps its figures for good.
 */
export class MneReportStore {
  private readonly forms = new MneFormStore();
  private readonly snapshots = new DisSnapshotStore();
  private readonly obligations = new MneObligationStore();
  private readonly calendars = new MasterRules();

  async create(tx: TenantTx, input: CreateInput): Promise<MneReportChange> {
    const asked = await this.forms.find(tx, idOf(input.formId, 'form_id'));
    if (asked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'form_id');
    if (!Number.isInteger(input.reportYear) || input.reportYear < 2000 || input.reportYear > 2999) throw invalid('report_year');
    const label = input.periodLabel.trim();
    if (label === '' || label.length > 20) throw invalid('period_label');
    const periodId = input.periodId === undefined ? null : idOf(input.periodId, 'period_id');
    const periodEnd = await this.periodEnd(tx, label, input.reportYear, periodId, input.today);
    const form = await this.formInForce(tx, asked, periodEnd);
    const unitId = idOf(input.scopeUnitId, 'scope_unit_id');
    await this.assertUnitInScope(tx, unitId, input.unitScope);
    const projectId = input.projectId === undefined ? null : idOf(input.projectId, 'project_id');
    const projectLevel = form.reportKind.startsWith('PROJECT_');
    if (projectLevel !== (projectId !== null)) throw invalid('project_id');
    if (projectId !== null) await this.assertProjectInUnit(tx, projectId, unitId);
    const existing = await tx.query<{ id: string }>(
      'select id from machvon.mne_report where form_id = $1::uuid and scope_unit_id = $2::uuid and project_id is not distinct from $3::uuid and report_year = $4::int and period_label = $5 and revision = 1',
      [form.id, unitId, projectId, input.reportYear, label],
    );
    if (existing[0] !== undefined) throw new DomainError('REPORT_EXISTS', 409, 'period_label', { extensions: { report_id: existing[0].id } });
    // A report made outside the calendar rests on a snapshot from the start.
    if (input.snapshotId === undefined) throw new DomainError('SNAPSHOT_REQUIRED', 422, 'snapshot_id');
    const snapshotId = idOf(input.snapshotId, 'snapshot_id');
    const snapshot = await this.snapshot(tx, snapshotId, periodEnd);
    // A report made for a rule has the deadline that rule gives (the one the calendar would have written), not the end of the period.
    const ruled = input.obligationRuleId === undefined ? undefined : await this.rule(tx, input.obligationRuleId, { label, year: input.reportYear, today: input.today, formCode: form.formCode });
    const dueDate = ruled?.dueDate ?? periodEnd;
    const schema = parseReportSchema(form.schemaJson);
    const values = await this.fill(tx, schema, { snapshotId, unitId, projectId, periodEnd });
    const payload: MnePayload = { values, narrative: {}, attachments: [], meta: { snapshot_id: snapshotId, as_of_date: snapshot.asOfDate, form_revision: form.revision, rate_basis: 'CURRENT_YEAR' } };
    const id = randomUUID();
    await tx.query(`savepoint ${SAVEPOINT}`);
    try {
      await tx.query(
        `insert into machvon.mne_report (tenant_id, id, form_id, obligation_rule_id, report_year, period_label, period_id, scope_unit_id, project_id, snapshot_id, due_date, revision, status, payload_json, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $12::uuid, $3::int, $4, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::date, 1, 'DRAFT', $10::jsonb, $11::uuid, $11::uuid)`,
        [id, form.id, input.reportYear, label, periodId, unitId, projectId, snapshotId, dueDate, JSON.stringify(payload), input.actor, ruled?.id ?? null],
      );
      await tx.query(`release savepoint ${SAVEPOINT}`);
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code !== UNIQUE_VIOLATION || failure.constraint !== KEY_INDEX) throw error;
      await tx.query(`rollback to savepoint ${SAVEPOINT}`);
      const raced = await tx.query<{ id: string }>('select id from machvon.mne_report where form_id = $1::uuid and scope_unit_id = $2::uuid and project_id is not distinct from $5::uuid and report_year = $3::int and period_label = $4 and revision = 1', [form.id, unitId, input.reportYear, label, projectId]);
      throw new DomainError('REPORT_EXISTS', 409, 'period_label', { extensions: { report_id: raced[0]?.id ?? null } });
    }
    return { row: await this.read(tx, id), previousStatus: null, snapshotAttached: snapshotId };
  }

  /**
   * Writes the text cells, the attachments and, when it is named, the snapshot of a DRAFT: the figures are filled again from a snapshot that is attached or replaced. A cell that has a source cannot be written (422
   * FIELD_SOURCE_LOCKED, every one listed); a cell the form does not have, or a value of the wrong kind, is a fault of the request.
   */
  async edit(tx: TenantTx, input: EditInput): Promise<MneReportChange> {
    const current = await this.lock(tx, input.id);
    await this.assertUnitInScope(tx, current.scopeUnitId, input.unitScope);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    assertReportState(current.status, ['DRAFT']);
    const narrative = { ...current.payload.narrative };
    if (input.narrative !== undefined) {
      const faults = narrativeFaults(current.schema, input.narrative);
      if (faults.locked.length > 0) throw new DomainError('FIELD_SOURCE_LOCKED', 422, `narrative.${faults.locked[0]}`, { extensions: { fields: faults.locked } });
      if (faults.unknown.length > 0) throw invalid(`narrative.${faults.unknown[0]}`);
      const kinds = new Map(current.schema.fields.map((field) => [field.key, field.kind]));
      for (const [key, value] of Object.entries(input.narrative)) {
        if (value !== null && !fitsKind(kinds.get(key) ?? 'TEXT', value)) throw invalid(`narrative.${key}`);
        if (value === null) delete narrative[key];
        else narrative[key] = value;
      }
    }
    const attachments = input.attachments === undefined ? current.payload.attachments : await this.attachmentsOf(tx, input.attachments);
    let snapshotId = current.snapshotId;
    let values = current.payload.values;
    let meta = current.payload.meta;
    let attached: string | null = null;
    if (input.snapshotId !== undefined) {
      snapshotId = idOf(input.snapshotId, 'snapshot_id');
      const periodEnd = await this.periodEnd(tx, current.periodLabel, current.reportYear, current.periodId, input.today);
      const snapshot = await this.snapshot(tx, snapshotId, periodEnd);
      values = await this.fill(tx, current.schema, { snapshotId, unitId: current.scopeUnitId, projectId: current.projectId, periodEnd });
      meta = { ...meta, snapshot_id: snapshotId, as_of_date: snapshot.asOfDate, form_revision: current.formRevision, rate_basis: 'CURRENT_YEAR' };
      attached = snapshotId;
    }
    const payload: MnePayload = { values, narrative, attachments, meta };
    await tx.query(`update machvon.mne_report set snapshot_id = $2::uuid, payload_json = $3::jsonb, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid`, [current.id, snapshotId, JSON.stringify(payload), input.actor]);
    return { row: await this.read(tx, current.id), previousStatus: current.status, snapshotAttached: attached };
  }

  /** Hands a DRAFT in for review: it needs its snapshot (422 SNAPSHOT_REQUIRED) and every cell the form requires (422 VALIDATION_FAILED, the cells listed). */
  async submit(tx: TenantTx, input: SubmitInput): Promise<MneReportChange> {
    const current = await this.lock(tx, input.id);
    await this.assertUnitInScope(tx, current.scopeUnitId, input.unitScope);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    assertReportState(current.status, ['DRAFT']);
    if (current.snapshotId === null) throw new DomainError('SNAPSHOT_REQUIRED', 422, 'snapshot_id');
    const missing = missingFields(current.schema, current.payload.values, current.payload.narrative);
    if (missing.length > 0) throw new DomainError('VALIDATION_FAILED', 422, 'payload', { extensions: { missing_fields: missing } });
    await tx.query(
      `update machvon.mne_report set status = 'IN_REVIEW', submitted_by = $2::uuid, submitted_at = $3::timestamptz, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
      [current.id, input.actor, input.now.toISOString()],
    );
    return { row: await this.read(tx, current.id), previousStatus: current.status, snapshotAttached: null };
  }

  /** One report, in the units the reader may read; a report that is not there for them does not exist. */
  async find(tx: TenantTx, id: string, scope?: ScopeBuilder): Promise<MneReportRow | undefined> {
    const predicate = scope === undefined ? undefined : scope(2);
    const rows = await tx.query<ReportSql>(`select ${COLUMNS} from ${FROM} where r.id = $1::uuid${predicate === undefined ? '' : ` and ${predicate.sql}`}`, [id, ...(predicate?.params ?? [])]);
    return rows[0] === undefined ? undefined : rowOf(rows[0]);
  }

  /**
   * The frozen snapshots a draft may be attached to (a close or an MNE snapshot of a day not after the end of its period), newest first: what the preparer chooses from, without the right to read the whole
   * disbursement module. Nothing for a report that is not a draft.
   */
  async snapshotOptions(tx: TenantTx, report: MneReportRow, today: string): Promise<Array<{ id: string; asOfDate: string }>> {
    if (report.status !== 'DRAFT') return [];
    let periodEnd: string;
    try {
      periodEnd = await this.periodEnd(tx, report.periodLabel, report.reportYear, report.periodId, today);
    } catch (error) {
      if (error instanceof DomainError) return [];
      throw error;
    }
    const rows = await tx.query<{ id: string; as_of_date: string }>(
      `select id, as_of_date::text as as_of_date from machvon.period_snapshot where status = 'FROZEN' and snapshot_kind = any($1::text[]) and as_of_date <= $2::date order by as_of_date desc, frozen_at desc, id limit 50`,
      [SNAPSHOT_KINDS, periodEnd],
    );
    return rows.map((row) => ({ id: row.id, asOfDate: row.as_of_date }));
  }

  private async read(tx: TenantTx, id: string): Promise<MneReportRow> {
    const row = await this.find(tx, id);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }

  private async lock(tx: TenantTx, id: string): Promise<MneReportRow> {
    const found = await tx.query<{ id: string }>('select id from machvon.mne_report where id = $1::uuid for update', [idOf(id, 'id')]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return this.read(tx, id);
  }

  /** The last day of the period: the label of a half year or a year, or the end of the reporting period named for a weekly report. */
  private async periodEnd(tx: TenantTx, label: string, year: number, periodId: string | null, today: string): Promise<string> {
    const fixed = periodEndOfLabel(label, year);
    // A half year or a year is not a period of the reporting calendar: a period named beside it would only mislead the deadline and the form.
    if (fixed !== null) {
      if (periodId !== null) throw invalid('period_id');
      return fixed;
    }
    if (periodId === null) {
      // A weekly shell of the calendar names its week by the code of the reporting calendar in force; it has no period row to point to.
      const calendar = await this.calendars.calendarPeriods(tx, year, today);
      const week = calendar?.periods.find((period) => period.code === label);
      if (week === undefined) throw invalid('period_label');
      return week.endsOn;
    }
    // The period named is the one the label is the code of, in the year of the report.
    const [period] = await tx.query<{ end_date: string }>('select end_date::text as end_date from machvon.reporting_period where id = $1::uuid and code = $2 and fiscal_year = $3::int', [periodId, label, year]);
    if (period === undefined || !isIsoDate(period.end_date)) throw invalid('period_id');
    return period.end_date;
  }

  /** The revision of the form in force on the last day of the period (BR-MNE-02), or 422 FORM_NOT_EFFECTIVE naming the day the nearest revision takes effect. */
  private async formInForce(tx: TenantTx, asked: MneFormRow, periodEnd: string): Promise<MneFormRow> {
    const form = await this.forms.inForce(tx, asked.formCode, periodEnd);
    if (form !== undefined) return form;
    const [next] = await tx.query<{ effective_from: string | null }>(
      `select min(effective_from)::text as effective_from from machvon.mne_report_form where form_code = $1 and status <> 'DRAFT' and effective_from > $2::date`,
      [asked.formCode, periodEnd],
    );
    throw new DomainError('FORM_NOT_EFFECTIVE', 422, 'form_id', { extensions: { form_code: asked.formCode, period_end: periodEnd, effective_from: next?.effective_from ?? null } });
  }

  private async assertUnitInScope(tx: TenantTx, unitId: string, scope: ScopeBuilder): Promise<void> {
    const [exists] = await tx.query<{ id: string }>('select id from machvon.organization_unit where id = $1::uuid', [unitId]);
    if (exists === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'scope_unit_id');
    const predicate = scope(2);
    const [seen] = await tx.query<{ id: string }>(`select u.id from machvon.organization_unit u where u.id = $1::uuid and ${predicate.sql}`, [unitId, ...predicate.params]);
    if (seen === undefined) throw new DomainError('SCOPE_DENIED', 403);
  }

  private async assertProjectInUnit(tx: TenantTx, projectId: string, unitId: string): Promise<void> {
    const [row] = await tx.query<{ id: string }>(
      `select p.id from machvon.project p join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id join machvon.organization_unit su on su.tenant_id = p.tenant_id and su.id = $2::uuid
        where p.id = $1::uuid and starts_with(ou.path, su.path)`,
      [projectId, unitId],
    );
    if (row === undefined) throw invalid('project_id');
  }

  /** A snapshot that can ground a report: frozen (422 SNAPSHOT_NOT_FROZEN), a close or an MNE snapshot, and of a day not after the end of the period. */
  private async snapshot(tx: TenantTx, snapshotId: string, periodEnd: string): Promise<{ asOfDate: string }> {
    const [row] = await tx.query<{ status: string; snapshot_kind: string; as_of_date: string }>('select status, snapshot_kind, as_of_date::text as as_of_date from machvon.period_snapshot where id = $1::uuid', [snapshotId]);
    if (row === undefined) throw invalid('snapshot_id');
    if (row.status !== 'FROZEN') throw new DomainError('SNAPSHOT_NOT_FROZEN', 422, 'snapshot_id');
    if (!SNAPSHOT_KINDS.includes(row.snapshot_kind) || row.as_of_date > periodEnd) throw invalid('snapshot_id');
    return { asOfDate: row.as_of_date };
  }

  /** The rule a report is made for: it must be a rule of the form, in force for the period, and gives the deadline of the report. */
  private async rule(tx: TenantTx, given: string, period: { label: string; year: number; today: string; formCode: string }): Promise<{ id: string; dueDate: string }> {
    const id = idOf(given, 'obligation_rule_id');
    const due = await this.obligations.dueDateFor(tx, id, period.label, period.year, period.today);
    if (due === undefined || due.formCode !== period.formCode) throw invalid('obligation_rule_id');
    return { id, dueDate: due.dueDate };
  }

  private async attachmentsOf(tx: TenantTx, ids: readonly string[]): Promise<string[]> {
    if (ids.length > 50) throw invalid('attachments');
    const found: string[] = [];
    for (const [index, id] of ids.entries()) found.push(await usableDocumentId(tx, id, `attachments[${index}]`));
    return [...new Set(found)];
  }

  /** The cells that have a source, filled from it (null where the source has nothing to say, so that a required cell without a figure is told missing and not zero). */
  private async fill(
    tx: TenantTx,
    schema: MneReportSchema,
    context: { snapshotId: string; unitId: string; projectId: string | null; periodEnd: string },
  ): Promise<Record<string, unknown>> {
    const values: Record<string, unknown> = {};
    const sourced = schema.fields.filter((field) => field.source !== null);
    if (sourced.length === 0) return values;
    const sums = addSums(
      (await this.snapshots.rateSums(tx, context.snapshotId, WHOLE_UNIT, { basis: 'CURRENT_YEAR', groupBy: 'NONE', projectId: context.projectId ?? undefined, underUnitId: context.projectId === null ? context.unitId : undefined })).map((row) => row.sums),
    );
    const figures = rateOfSums(sums, 'CURRENT_YEAR');
    for (const field of sourced) {
      const source = field.source;
      if (source === null) continue;
      switch (source.kind) {
        case 'SNAPSHOT_METRIC':
          values[field.key] = {
            plan_total_vnd: figures.planTotalVnd,
            plan_pm_assigned_vnd: figures.planPmVnd,
            disbursed_treasury_vnd: figures.numeratorVnd,
            rate_pm_pct: figures.ratePmPct,
            rate_total_pct: figures.rateTotalPct,
            project_count: figures.projects,
          }[source.metric];
          break;
        case 'PROJECT_COUNT':
          values[field.key] = await this.countProjects(tx, context, source.stage);
          break;
        case 'WARNING_COUNT':
          values[field.key] = await this.countWarnings(tx, context, source.severity);
          break;
        case 'APPROPRIATION_TOTAL':
          values[field.key] = await this.appropriationTotal(tx, source.planYear);
          break;
      }
    }
    return values;
  }

  private async countProjects(tx: TenantTx, context: { unitId: string; projectId: string | null }, stage: string | null): Promise<number> {
    const [row] = await tx.query<{ n: string }>(
      `select count(*)::text as n from machvon.project p join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
        where ($1::uuid is null or p.id = $1::uuid) and ($1::uuid is not null or exists (select 1 from machvon.organization_unit su where su.id = $2::uuid and starts_with(ou.path, su.path)))
          and ($3::text is null or p.status = $3)`,
      [context.projectId, context.unitId, stage],
    );
    return Number(row?.n ?? 0);
  }

  private async countWarnings(tx: TenantTx, context: { unitId: string; projectId: string | null }, severity: string | null): Promise<number> {
    const [row] = await tx.query<{ n: string }>(
      `select count(*)::text as n from machvon.early_warning w join machvon.project p on p.tenant_id = w.tenant_id and p.id = w.project_id
         join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
        where w.status = any($4::text[]) and ($1::uuid is null or p.id = $1::uuid) and ($1::uuid is not null or exists (select 1 from machvon.organization_unit su where su.id = $2::uuid and starts_with(ou.path, su.path)))
          and ($3::text is null or w.severity = $3)`,
      [context.projectId, context.unitId, severity, OPEN_WARNING],
    );
    return Number(row?.n ?? 0);
  }

  private async appropriationTotal(tx: TenantTx, planYear: number): Promise<string> {
    const [row] = await tx.query<{ total: string }>(`select coalesce(sum(amount_vnd), 0)::text as total from machvon.appropriation where plan_year = $1::int and status = 'PUBLISHED'`, [planYear]);
    return row?.total ?? '0';
  }
}
