import { randomUUID } from 'node:crypto';
import { DomainError, EXPLANATION_DUE_WORKING_DAYS, EXPLANATION_SUBJECTS, NOOP_METRICS, answeredStatus, becomesOverdue, concludedStatus, dueMomentOf, isAnswerLate, isWorkingDay, vietnamDateOf, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess, ExplanationDecision, ExplanationStatus, ExplanationSubject, MetricsSink } from '@machvon/kernel';
import { DisWarningStore } from './dis-warning-store.ts';
import type { WarningRow } from './dis-warning-store.ts';
import { idOf, memberStanding, textOf } from './prj-accountability-support.ts';
import { projectScope } from './prj-project-store.ts';
import { invalid, projectInScope, usableDocumentId } from './prj-stage-support.ts';
import { scopePredicate } from './scope-version.ts';
import type { ScopeBuilder, ScopePredicate } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { WorkCalendarStore } from './work-calendar-store.ts';
import type { AuditWriter } from './audit-writer.ts';

export const EXPLANATION_RESOURCE = 'explanation_request';
export const EXPLANATION_REQUESTED_EVENT = 'explanation.requested.v1';
export const EXPLANATION_RESPONDED_EVENT = 'explanation.responded.v1';
export const EXPLANATION_REVIEWED_EVENT = 'explanation.reviewed.v1';
export const EXPLANATION_OVERDUE_METRIC = 'prj_explanation_overdue_gauge';

const UNIQUE_VIOLATION = '23505';
const OPEN_INDEX = 'explanation_open_uq';
const WARNING_INDEX = 'explanation_warning_uq';
const SAVEPOINT = 'explanation_write';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_CALENDAR = 'DEFAULT';
const UNIT_FROM = 'left join machvon.organization_unit su on su.tenant_id = e.tenant_id and su.id = e.unit_id';

const FROM = `machvon.explanation_request e
  left join machvon.project p on p.tenant_id = e.tenant_id and p.id = e.project_id
  left join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
  ${UNIT_FROM}`;

const COLUMNS = `e.id, e.subject_kind, e.project_id, p.code as project_code, p.name as project_name, e.unit_id, su.name as unit_name, e.period_id, e.warning_id, e.trigger_code, e.question,
  e.requested_from_membership_id, to_char(e.due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as due_at, to_char(e.original_due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as original_due_at,
  e.response_text, e.response_document_id, e.responded_by, to_char(e.responded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as responded_at, e.is_late, e.reviewed_by, e.review_note, e.status,
  to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at, e.created_by, e.version::text as version`;

export interface ExplanationRow {
  id: string;
  subjectKind: ExplanationSubject;
  projectId: string | null;
  projectCode: string | null;
  projectName: string | null;
  unitId: string | null;
  unitName: string | null;
  periodId: string | null;
  warningId: string | null;
  triggerCode: string;
  question: string;
  requestedFromMembershipId: string;
  dueAt: string;
  originalDueAt: string;
  responseText: string | null;
  responseDocumentId: string | null;
  respondedBy: string | null;
  respondedAt: string | null;
  isLate: boolean;
  reviewedBy: string | null;
  reviewNote: string | null;
  status: ExplanationStatus;
  createdAt: string;
  createdBy: string;
  version: number;
}

interface ExplanationSql {
  id: string;
  subject_kind: ExplanationSubject;
  project_id: string | null;
  project_code: string | null;
  project_name: string | null;
  unit_id: string | null;
  unit_name: string | null;
  period_id: string | null;
  warning_id: string | null;
  trigger_code: string;
  question: string;
  requested_from_membership_id: string;
  due_at: string;
  original_due_at: string;
  response_text: string | null;
  response_document_id: string | null;
  responded_by: string | null;
  responded_at: string | null;
  is_late: boolean;
  reviewed_by: string | null;
  review_note: string | null;
  status: ExplanationStatus;
  created_at: string;
  created_by: string;
  version: string;
}

const rowOf = (row: ExplanationSql): ExplanationRow => ({
  id: row.id,
  subjectKind: row.subject_kind,
  projectId: row.project_id,
  projectCode: row.project_code,
  projectName: row.project_name,
  unitId: row.unit_id,
  unitName: row.unit_name,
  periodId: row.period_id,
  warningId: row.warning_id,
  triggerCode: row.trigger_code,
  question: row.question,
  requestedFromMembershipId: row.requested_from_membership_id,
  dueAt: row.due_at,
  originalDueAt: row.original_due_at,
  responseText: row.response_text,
  responseDocumentId: row.response_document_id,
  respondedBy: row.responded_by,
  respondedAt: row.responded_at,
  isLate: row.is_late,
  reviewedBy: row.reviewed_by,
  reviewNote: row.review_note,
  status: row.status,
  createdAt: row.created_at,
  createdBy: row.created_by,
  version: Number(row.version),
});

/** The units the caller holds a permission over (the alias `su` of the unit of a request). */
export function explanationUnitScope(access: EffectiveAccess, permission: string, now: Date): ScopeBuilder {
  return (first: number): ScopePredicate => scopePredicate(access, permission, now, { unitPath: 'su.path', unitId: 'su.id' }, first);
}

/**
 * The scope of an explanation request for a permission (the aliases of `FROM`): a request about a project is in scope when the project is, one about a unit when the unit lies in a subtree the caller
 * holds the permission over.
 */
export function explanationScope(access: EffectiveAccess, permission: string, now: Date): ScopeBuilder {
  return (first: number): ScopePredicate => {
    const projects = projectScope(access, permission, now)(first);
    const units = explanationUnitScope(access, permission, now)(first + projects.params.length);
    return { sql: `((e.subject_kind = 'PROJECT' and ${projects.sql}) or (e.subject_kind = 'UNIT' and ${units.sql}))`, params: [...projects.params, ...units.params] };
  };
}

export interface RequestInput {
  subjectKind: string;
  projectId?: string | undefined;
  unitId?: string | undefined;
  periodId?: string | undefined;
  warningId?: string | undefined;
  triggerCode: string;
  question: string;
  requestedFromMembershipId: string;
  dueAt: string;
  actor: string;
  now: Date;
  /** What the caller may ask an explanation about (the permission `explanation.request`): the projects, and the units. */
  scope: { project: ScopeBuilder; unit: ScopeBuilder };
}

export interface SubmitInput {
  id: string;
  expectedVersion: number;
  actor: string;
  now: Date;
  responseText: string;
  responseDocumentId?: string | undefined;
}

export interface ReviewInput {
  id: string;
  expectedVersion: number;
  actor: string;
  now: Date;
  decision: string;
  reviewNote: string;
  newDueAt?: string | undefined;
  /** What the caller may conclude (the permission `explanation.review`). */
  scope: ScopeBuilder;
}

export interface ExplanationChange {
  row: ExplanationRow;
  previousStatus: ExplanationStatus | null;
  /** The warning that the change moved (linked on a request, resolved on an acceptance). */
  warning: WarningRow | undefined;
}

export interface ListFilter {
  status?: string | undefined;
  projectId?: string | undefined;
  unitId?: string | undefined;
}

export interface AutoRequestResult {
  outcome: 'CREATED' | 'DUPLICATE' | 'SKIPPED';
  reason?: string;
  explanation?: ExplanationRow;
  calendar?: 'WORKING_CALENDAR' | 'WEEKDAYS_ASSUMED';
}

/**
 * The explanation requests (ST-PRJ-006, PRJ 3.1 F10, BR-PRJ-08): a leader asks the person who answers for a project or a unit to explain, optionally from a warning of the early-warning rules; the
 * person asked answers (late is taken, and told late against the date it was first asked for), and a different person accepts the answer or returns it with a note and, if they wish, a new date. An
 * acceptance resolves the warning that the request was for. One request is open at a time for a subject, a trigger and a period (409 EXPLANATION_ALREADY_OPEN).
 */
export class PrjExplanationStore {
  private readonly warnings = new DisWarningStore();
  private readonly calendars = new WorkCalendarStore();

  /** A request about a project or a unit in the scope of the caller, to a member of the staff, with a due moment in the future. */
  async request(tx: TenantTx, input: RequestInput): Promise<ExplanationChange> {
    if (!(EXPLANATION_SUBJECTS as readonly string[]).includes(input.subjectKind)) throw invalid('subject_kind');
    const subject = input.subjectKind as ExplanationSubject;
    const projectId = input.projectId === undefined ? null : idOf(input.projectId, 'project_id');
    const unitId = input.unitId === undefined ? null : idOf(input.unitId, 'unit_id');
    if (subject === 'PROJECT' ? projectId === null || unitId !== null : unitId === null || projectId !== null) throw invalid(subject === 'PROJECT' ? 'project_id' : 'unit_id');
    const triggerCode = textOf(input.triggerCode, 'trigger_code', { min: 1, max: 50 });
    const question = textOf(input.question, 'question', { min: 10, max: 2000, multiline: true });
    const dueAt = new Date(input.dueAt);
    if (Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= input.now.getTime()) throw invalid('due_at');
    const askedId = idOf(input.requestedFromMembershipId, 'requested_from_membership_id');
    const periodId = input.periodId === undefined ? null : idOf(input.periodId, 'period_id');
    const warningId = input.warningId === undefined ? null : idOf(input.warningId, 'warning_id');
    await this.assertInScope(tx, subject, subject === 'PROJECT' ? (projectId as string) : (unitId as string), input.scope);
    const asked = await memberStanding(tx, askedId);
    if (!asked.active || !asked.staff) throw invalid('requested_from_membership_id');
    if (periodId !== null) {
      const [period] = await tx.query<{ id: string }>('select id from machvon.reporting_period where id = $1::uuid', [periodId]);
      if (period === undefined) throw invalid('period_id');
    }
    // The warning is judged before anything is written, so a warning that is not there is 404 and not a foreign key that fails.
    if (warningId !== null) await this.warnings.assertLinkable(tx, warningId, { projectId, unitId });
    const id = await this.insert(tx, { id: randomUUID(), subject, projectId, unitId, periodId, warningId, triggerCode, question, askedId, dueAt, actor: input.actor });
    const warning = warningId === null ? undefined : await this.warnings.linkExplanation(tx, warningId, id, { projectId, unitId }, input.actor);
    return { row: await this.read(tx, id), previousStatus: null, warning };
  }

  /**
   * The request that an early warning asks for by itself (the job `prj.explanation-auto`, the rule has `auto_explanation`): to the leader in charge of the project, due in three working days. The same
   * warning gives the same request however often its event is delivered; a project with no leader in charge, or a warning that is no longer open, is skipped and says why.
   */
  async requestForWarning(tx: TenantTx, warningId: string, actor: string, now: Date, options: { eventAt?: Date | undefined; dueWorkingDays?: number | undefined } = {}): Promise<AutoRequestResult> {
    const dueWorkingDays = options.dueWorkingDays ?? EXPLANATION_DUE_WORKING_DAYS;
    // The days are counted from the day the warning was opened, not from the day the event happens to be read: a delayed delivery does not give more time.
    const countedFrom = vietnamDateOf(options.eventAt !== undefined && options.eventAt.getTime() < now.getTime() ? options.eventAt : now);
    const warning = await this.warnings.find(tx, warningId, undefined, true);
    if (warning === undefined) return { outcome: 'SKIPPED', reason: 'WARNING_NOT_FOUND' };
    const [existing] = await tx.query<{ id: string }>(`select id from machvon.explanation_request where warning_id = $1::uuid and status <> 'CANCELLED'`, [warningId]);
    if (existing !== undefined) return { outcome: 'DUPLICATE', explanation: await this.read(tx, existing.id) };
    if (warning.status !== 'OPEN' && warning.status !== 'ACKNOWLEDGED') return { outcome: 'SKIPPED', reason: 'WARNING_NOT_OPEN' };
    if (warning.projectId === null) return { outcome: 'SKIPPED', reason: 'NO_PROJECT' };
    const today = vietnamDateOf(now);
    const [leader] = await tx.query<{ leader_membership_id: string }>(
      `select a.leader_membership_id from machvon.project_accountability a
         join machvon.membership m on m.tenant_id = a.tenant_id and m.id = a.leader_membership_id and m.status = 'Active' and m.valid_from <= now() and (m.valid_until is null or m.valid_until > now())
        where a.project_id = $1::uuid and a.accountability_role = 'LEADER_IN_CHARGE' and a.status = 'ACTIVE' and a.valid_from <= $2::date and (a.valid_until is null or a.valid_until >= $2::date)`,
      [warning.projectId, today],
    );
    if (leader === undefined) return { outcome: 'SKIPPED', reason: 'NO_LEADER_IN_CHARGE' };
    const { date, calendar } = await this.dueDate(tx, warning.periodId, countedFrom, dueWorkingDays);
    const question = `Đề nghị giải trình về cảnh báo ${warning.ruleCode} (${warning.ruleName}) của dự án ${warning.projectCode ?? ''}: nêu nguyên nhân và biện pháp khắc phục.`;
    let id: string;
    try {
      id = await this.insert(tx, {
      id: randomUUID(),
      subject: 'PROJECT',
      projectId: warning.projectId,
      unitId: null,
      periodId: warning.periodId,
      warningId,
      triggerCode: warning.ruleCode,
      question,
      askedId: leader.leader_membership_id,
      dueAt: dueMomentOf(date),
      actor,
    });
    } catch (error) {
      // A request of a person is already open for this project, trigger and period: the question is being asked, and the warning is left for the people to link or handle. It is not a failure of the event.
      if (error instanceof DomainError && error.code === 'EXPLANATION_ALREADY_OPEN') return { outcome: 'SKIPPED', reason: 'OPEN_REQUEST_EXISTS' };
      throw error;
    }
    await this.warnings.linkExplanation(tx, warningId, id, { projectId: warning.projectId, unitId: null }, actor);
    return { outcome: 'CREATED', explanation: await this.read(tx, id), calendar };
  }

  /** The person asked answers, under the version they saw: late is taken and kept as late against the due moment of the request. */
  async submit(tx: TenantTx, input: SubmitInput): Promise<ExplanationChange> {
    const id = idOf(input.id, 'id');
    const current = await this.lock(tx, id);
    if (current.requestedFromMembershipId !== input.actor) throw new DomainError('SCOPE_DENIED', 403);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    const status = answeredStatus(current.status);
    const text = textOf(input.responseText, 'response_text', { min: 20, max: 2000, multiline: true });
    const document = input.responseDocumentId === undefined ? null : await usableDocumentId(tx, input.responseDocumentId, 'response_document_id');
    const late = isAnswerLate(input.now, new Date(current.dueAt));
    await tx.query(
      `update machvon.explanation_request set status = $2, response_text = $3, response_document_id = $4::uuid, responded_by = $5::uuid, responded_at = $6::timestamptz, is_late = $7, reviewed_by = null, review_note = null,
              updated_at = now(), updated_by = $5::uuid, version = version + 1 where id = $1::uuid`,
      [id, status, text, document, input.actor, input.now.toISOString(), late],
    );
    return { row: await this.read(tx, id), previousStatus: current.status, warning: undefined };
  }

  /**
   * Someone other than the one who answered accepts the answer or returns it with a note (a returned request may be given a new due moment). The person who answered cannot conclude their own answer
   * (403 SELF_APPROVAL_DENIED); an answer that was accepted resolves the warning the request was for.
   */
  async review(tx: TenantTx, input: ReviewInput): Promise<ExplanationChange> {
    const id = idOf(input.id, 'id');
    const current = await this.lock(tx, id);
    const predicate = input.scope(2);
    const [visible] = await tx.query<{ id: string }>(`select e.id from ${FROM} where e.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    if (visible === undefined) throw new DomainError('SCOPE_DENIED', 403);
    if (current.respondedBy !== null && current.respondedBy === input.actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    if (input.decision !== 'ACCEPTED' && input.decision !== 'RETURNED') throw invalid('decision');
    const decision: ExplanationDecision = input.decision;
    const status = concludedStatus(current.status, decision);
    const note = textOf(input.reviewNote, 'review_note', { min: 5, max: 2000, multiline: true });
    let dueAt: Date | null = null;
    if (input.newDueAt !== undefined) {
      dueAt = new Date(input.newDueAt);
      if (decision !== 'RETURNED' || Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= input.now.getTime()) throw invalid('new_due_at');
    }
    await tx.query(
      `update machvon.explanation_request set status = $2, reviewed_by = $3::uuid, review_note = $4, due_at = coalesce($5::timestamptz, due_at), updated_at = now(), updated_by = $3::uuid, version = version + 1
        where id = $1::uuid`,
      [id, status, input.actor, note, dueAt?.toISOString() ?? null],
    );
    const warning = decision === 'ACCEPTED' ? await this.warnings.resolveByExplanation(tx, id, input.actor) : undefined;
    return { row: await this.read(tx, id), previousStatus: current.status, warning };
  }

  async find(tx: TenantTx, id: string): Promise<ExplanationRow | undefined> {
    const rows = await tx.query<ExplanationSql>(`select ${COLUMNS} from ${FROM} where e.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : rowOf(rows[0]);
  }

  /**
   * The requests in the scope of the caller, or addressed to them, the newest first, one page after the anchor (`createdAt|id`); the person asked sees their own requests whatever the scope of their grant.
   */
  async list(
    tx: TenantTx,
    filter: ListFilter,
    access: { scope: ScopeBuilder; membershipId: string },
    page: { limit: number; after?: { createdAt: string; id: string } | undefined },
  ): Promise<ExplanationRow[]> {
    const predicate = access.scope(7);
    const rows = await tx.query<ExplanationSql>(
      `select ${COLUMNS} from ${FROM}
        where ($1::text is null or e.status = $1) and ($2::uuid is null or e.project_id = $2::uuid) and ($3::uuid is null or e.unit_id = $3::uuid)
          and ($4::timestamptz is null or (e.created_at, e.id) < ($4::timestamptz, $5::uuid))
          and (e.requested_from_membership_id = $6::uuid or ${predicate.sql})
        order by e.created_at desc, e.id desc limit ${Math.trunc(page.limit) + 1}`,
      [filter.status ?? null, filter.projectId ?? null, filter.unitId ?? null, page.after?.createdAt ?? null, page.after?.id ?? NIL_UUID, access.membershipId, ...predicate.params],
    );
    return rows.map(rowOf);
  }

  /** The requests that wait for an answer and are past their moment become OVERDUE; each one is returned, with the status it had. */
  async markOverdue(tx: TenantTx, actor: string, now: Date): Promise<Array<{ row: ExplanationRow; previousStatus: ExplanationStatus }>> {
    const due = await tx.query<{ id: string; status: ExplanationStatus; due_at: string }>(
      `select id, status, to_char(due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as due_at from machvon.explanation_request where status in ('REQUESTED', 'RETURNED') and due_at < $1::timestamptz order by due_at, id for update skip locked`,
      [now.toISOString()],
    );
    const changed: Array<{ row: ExplanationRow; previousStatus: ExplanationStatus }> = [];
    for (const item of due) {
      if (!becomesOverdue(item.status, new Date(item.due_at), now)) continue;
      await tx.query(`update machvon.explanation_request set status = 'OVERDUE', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`, [item.id, actor]);
      changed.push({ row: await this.read(tx, item.id), previousStatus: item.status });
    }
    return changed;
  }

  /** How many requests are overdue now: the gauge the operations dashboard reads. */
  async overdueCount(tx: TenantTx): Promise<number> {
    const [row] = await tx.query<{ n: string }>(`select count(*)::text as n from machvon.explanation_request where status = 'OVERDUE'`);
    return Number(row?.n ?? 0);
  }

  private async read(tx: TenantTx, id: string): Promise<ExplanationRow> {
    const row = await this.find(tx, id);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }

  private async lock(tx: TenantTx, id: string): Promise<ExplanationRow> {
    const rows = await tx.query<{ id: string }>('select id from machvon.explanation_request where id = $1::uuid for update', [id]);
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return this.read(tx, id);
  }

  /** The subject exists (404 otherwise) and the caller may act on it (403 SCOPE_DENIED otherwise). */
  private async assertInScope(tx: TenantTx, subject: ExplanationSubject, subjectId: string, scope: RequestInput['scope']): Promise<void> {
    const table = subject === 'PROJECT' ? 'machvon.project' : 'machvon.organization_unit';
    const [exists] = await tx.query<{ id: string }>(`select id from ${table} where id = $1::uuid`, [subjectId]);
    if (exists === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, subject === 'PROJECT' ? 'project_id' : 'unit_id');
    if (subject === 'PROJECT') {
      if (!(await projectInScope(tx, subjectId, scope.project))) throw new DomainError('SCOPE_DENIED', 403);
      return;
    }
    const predicate = scope.unit(2);
    const [seen] = await tx.query<{ id: string }>(`select su.id from machvon.organization_unit su where su.id = $1::uuid and ${predicate.sql}`, [subjectId, ...predicate.params]);
    if (seen === undefined) throw new DomainError('SCOPE_DENIED', 403);
  }

  private async insert(
    tx: TenantTx,
    row: { id: string; subject: ExplanationSubject; projectId: string | null; unitId: string | null; periodId: string | null; warningId: string | null; triggerCode: string; question: string; askedId: string; dueAt: Date; actor: string },
  ): Promise<string> {
    await tx.query(`savepoint ${SAVEPOINT}`);
    try {
      await tx.query(
        `insert into machvon.explanation_request
           (tenant_id, id, subject_kind, project_id, unit_id, period_id, warning_id, trigger_code, question, requested_from_membership_id, due_at, original_due_at, status, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9::uuid, $10::timestamptz, $10::timestamptz, 'REQUESTED', $11::uuid, $11::uuid)`,
        [row.id, row.subject, row.projectId, row.unitId, row.periodId, row.warningId, row.triggerCode, row.question, row.askedId, row.dueAt.toISOString(), row.actor],
      );
      await tx.query(`release savepoint ${SAVEPOINT}`);
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code !== UNIQUE_VIOLATION || (failure.constraint !== OPEN_INDEX && failure.constraint !== WARNING_INDEX)) throw error;
      await tx.query(`rollback to savepoint ${SAVEPOINT}`);
      throw new DomainError('EXPLANATION_ALREADY_OPEN', 409, failure.constraint === WARNING_INDEX ? 'warning_id' : 'trigger_code');
    }
    return row.id;
  }

  /**
   * The last day to answer, counted day by day: a day of a year that has a published work calendar is judged by it (holidays, compensated days), a day of a year that has none by the week (Saturday and
   * Sunday are not working days), and the result says so when any day was counted by the week, never silently.
   */
  private async dueDate(tx: TenantTx, periodId: string, from: string, days: number): Promise<{ date: string; calendar: 'WORKING_CALENDAR' | 'WEEKDAYS_ASSUMED' }> {
    const [period] = await tx.query<{ calendar_code: string }>('select calendar_code from machvon.reporting_period where id = $1::uuid', [periodId]);
    const source = await this.calendars.source(tx, period?.calendar_code ?? DEFAULT_CALENDAR, Number(from.slice(0, 4)));
    let date = from;
    let left = days;
    let assumed = false;
    while (left > 0) {
      const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000);
      date = next.toISOString().slice(0, 10);
      const calendar = source.forYear(Number(date.slice(0, 4)));
      if (calendar === undefined) {
        assumed = true;
        if (next.getUTCDay() !== 0 && next.getUTCDay() !== 6) left -= 1;
      } else if (isWorkingDay(calendar, date)) {
        left -= 1;
      }
    }
    return { date, calendar: assumed ? 'WEEKDAYS_ASSUMED' : 'WORKING_CALENDAR' };
  }
}

/** The audit row and the event of a request that was made. */
export function explanationRequestedRecord(change: ExplanationChange, tenantId: string, actor: string, occurredAt: Date) {
  const { row } = change;
  return {
    audit: {
      action: 'prj.explanation_requested',
      resourceType: EXPLANATION_RESOURCE,
      resourceId: row.id,
      diff: { subject_kind: row.subjectKind, project_id: row.projectId, unit_id: row.unitId, trigger_code: row.triggerCode, warning_id: row.warningId, period_id: row.periodId, requested_from_membership_id: row.requestedFromMembershipId, due_at: row.dueAt },
    },
    event: eventOf(EXPLANATION_REQUESTED_EVENT, row, tenantId, actor, occurredAt, { requested_from_membership_id: row.requestedFromMembershipId, due_at: row.dueAt, trigger_code: row.triggerCode, warning_id: row.warningId }),
  };
}

/** The audit row and the event of an answer. The text of the answer is never copied into either. */
export function explanationRespondedRecord(change: ExplanationChange, tenantId: string, actor: string, occurredAt: Date) {
  const { row } = change;
  return {
    audit: { action: 'prj.explanation_responded', resourceType: EXPLANATION_RESOURCE, resourceId: row.id, diff: { is_late: row.isLate, due_at: row.dueAt, original_due_at: row.originalDueAt, response_document_id: row.responseDocumentId, from_status: change.previousStatus } },
    event: eventOf(EXPLANATION_RESPONDED_EVENT, row, tenantId, actor, occurredAt, { is_late: row.isLate, responded_at: row.respondedAt }),
  };
}

/** The audit row and the event of a conclusion. The note is not copied into either. */
export function explanationReviewedRecord(change: ExplanationChange, tenantId: string, actor: string, occurredAt: Date) {
  const { row } = change;
  return {
    audit: {
      action: row.status === 'ACCEPTED' ? 'prj.explanation_accepted' : 'prj.explanation_returned',
      resourceType: EXPLANATION_RESOURCE,
      resourceId: row.id,
      diff: { decision: row.status, due_at: row.dueAt, warning_id: row.warningId, warning_status: change.warning?.status ?? null, from_status: change.previousStatus },
    },
    event: eventOf(EXPLANATION_REVIEWED_EVENT, row, tenantId, actor, occurredAt, { decision: row.status, warning_id: row.warningId, due_at: row.dueAt }),
  };
}

function eventOf(type: string, row: ExplanationRow, tenantId: string, actor: string, occurredAt: Date, own: Record<string, unknown>) {
  return {
    aggregateType: EXPLANATION_RESOURCE,
    aggregateId: row.id,
    aggregateVersion: row.version,
    type,
    schemaVersion: 1,
    payload: { tenant_id: tenantId, explanation_request_id: row.id, version: row.version, actor_id: actor, occurred_at: occurredAt.toISOString(), subject_kind: row.subjectKind, project_id: row.projectId, unit_id: row.unitId, status: row.status, ...own },
    eventKey: `${EXPLANATION_RESOURCE}:${row.id}:${row.version}`,
  };
}

/**
 * The job `prj.explanation-overdue` (ST-PRJ-006): a request that was asked or returned and is past its due moment becomes OVERDUE, once; an answer is still taken after that, and told late. One audit row
 * for each request (it names no person and no text), and the gauge of the overdue requests of the tenant. A second pass the same minute finds nothing to change.
 */
export class PrjExplanationOverdueJob {
  private readonly store = new PrjExplanationStore();

  private readonly audit: Pick<AuditWriter, 'recordInTx'>;
  private readonly metrics: MetricsSink;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>, metrics: MetricsSink = NOOP_METRICS) {
    this.audit = audit;
    this.metrics = metrics;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<{ overdue: number }> {
    const changed = await this.store.markOverdue(tx, actor, now);
    const correlationId = randomUUID();
    for (const item of changed) {
      await this.audit.recordInTx(tx, actor, {
        action: 'prj.explanation_overdue',
        resourceType: EXPLANATION_RESOURCE,
        resourceId: item.row.id,
        diff: { subject_kind: item.row.subjectKind, project_id: item.row.projectId, unit_id: item.row.unitId, from_status: item.previousStatus, due_at: item.row.dueAt, original_due_at: item.row.originalDueAt },
        correlationId,
        requestId: randomUUID(),
      });
    }
    this.metrics.gauge(EXPLANATION_OVERDUE_METRIC, await this.store.overdueCount(tx));
    return { overdue: changed.length };
  }
}
