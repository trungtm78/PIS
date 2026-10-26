import { randomUUID } from 'node:crypto';
import { DomainError, daysBetween, versionConflict } from '@machvon/kernel';
import type { LandTimerCode } from '@machvon/kernel';
import { enterScope } from './lnd-household-store.ts';
import type { ScopeUnits } from './lnd-household-store.ts';
import { LndLandSource } from './lnd-land-source.ts';
import { LndTimerRules } from './lnd-timer-rules.ts';
import { dateOf, lowerId, textOf } from './lnd-values.ts';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

const MAX_TEXT = 2000;
const MAX_PAGE = 200;
const MIN_FILED_DATE = '1990-01-01';
const COMPLAINT_TIMER: LandTimerCode = 'COMPLAINT_RESOLUTION';
const RUNNING_CONSTRAINT = 'land_deadline_running_uq';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The type of the event that asks ISS for an issue about a complaint (the common contract of the issue intake, ISS-11). */
export const COMPLAINT_FILED_EVENT = 'lnd.complaint.filed.v1';

export const COMPLAINT_CHANNELS = ['IN_PERSON', 'LETTER', 'PORTAL', 'MEETING'] as const;
export type ComplaintChannel = (typeof COMPLAINT_CHANNELS)[number];
export const COMPLAINT_SUBJECTS = ['PRICE', 'AREA', 'ELIGIBILITY', 'RESETTLEMENT', 'PROCEDURE', 'OTHER'] as const;
export type ComplaintSubject = (typeof COMPLAINT_SUBJECTS)[number];
export const COMPLAINT_STATUSES = ['RECEIVED', 'UNDER_REVIEW', 'RESOLVED_ACCEPTED', 'RESOLVED_REJECTED', 'ESCALATED', 'CLOSED'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];
export const COMPLAINT_OUTCOMES = ['RESOLVED_ACCEPTED', 'RESOLVED_REJECTED', 'ESCALATED'] as const;
export type ComplaintOutcome = (typeof COMPLAINT_OUTCOMES)[number];
/** The statuses a complaint is answered from: it was received, is under review, or was escalated and the answer of the higher level is recorded. */
const ANSWERABLE: readonly ComplaintStatus[] = ['RECEIVED', 'UNDER_REVIEW', 'ESCALATED'];
/** The parcels that a complaint holds: those that are not yet paid (a paid parcel is not disputed any more, LND 4). */
const HOLDABLE = ['SURVEYED', 'INVENTORIED', 'PLAN_DRAFTED', 'PLAN_POSTED', 'PLAN_APPROVED'];

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

const idText = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !UUID.test(value.trim())) throw invalid(field);
  return lowerId(value.trim());
};

export interface FiledComplaint {
  id: string;
  projectId: string;
  complaintNo: string;
  ownerUnitId: string;
  subject: ComplaintSubject;
  channel: ComplaintChannel;
  filedOn: string;
  dueOn: string;
  daysApplied: number;
  deadlineId: string;
  ruleVersionId: string;
  ruleRevision: number;
  parcelsHeld: number;
  version: number;
}

export interface AnsweredComplaint {
  id: string;
  projectId: string;
  complaintNo: string;
  status: ComplaintOutcome;
  fromStatus: ComplaintStatus;
  resolvedOn: string;
  dueOn: string;
  lateDays: number;
  resolutionDocumentVersionId: string | null;
  parcelsReleased: number;
  version: number;
}

/** A complaint as the board reads it: the words of the complainant are read only inside the unit of the household. */
export interface ComplaintLine {
  id: string;
  projectId: string;
  householdId: string;
  householdCode: string;
  planId: string | null;
  ownerUnitId: string;
  complaintNo: string;
  filedOn: string;
  channel: ComplaintChannel;
  subject: ComplaintSubject;
  description: string;
  status: ComplaintStatus;
  dueOn: string;
  resolvedOn: string | null;
  resolutionNote: string | null;
  resolutionDocumentVersionId: string | null;
  issueId: string | null;
  version: number;
}

export interface ComplaintFilter {
  projectId: string;
  status?: string | undefined;
  limit: number;
  after?: { code: string; id: string } | undefined;
}

/**
 * The members of the issue intake's common contract for a complaint that was filed: the complaint, the code that names it, the project, the unit that answers and the kind of subject. Nothing the complainant said
 * and nothing that names the household (the intake reads only ids and a reference code, and refuses the members that carry a person).
 */
export function complaintFiledPayload(complaint: Pick<FiledComplaint, 'id' | 'projectId' | 'complaintNo' | 'ownerUnitId' | 'subject' | 'dueOn'>, tenantId: string, now: Date): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    source_ref_id: complaint.id,
    reference_code: complaint.complaintNo,
    project_id: complaint.projectId,
    owner_unit_id: complaint.ownerUnitId,
    complaint_id: complaint.id,
    subject: complaint.subject,
    due_on: complaint.dueOn,
    status: 'RECEIVED',
    occurred_at: now.toISOString(),
    source_module: 'LND',
  };
}

/**
 * The complaint remembers the issue that was opened for it (the intake calls this in the transaction that opens the issue). The intake acts for the system and reaches every unit, so the scope of the complaints is
 * widened for this one statement and put back.
 */
export async function linkComplaintIssue(tx: TenantTx, complaintId: string, issueId: string): Promise<void> {
  const previous = ((await tx.query<{ scope: string | null }>("select current_setting('app.scope_units', true) as scope"))[0] as { scope: string | null }).scope ?? '';
  await enterScope(tx, '*');
  await tx.query('update machvon.land_complaint set issue_id = $2::uuid where id = $1::uuid', [complaintId, issueId]);
  await enterScope(tx, previous);
}

/**
 * The complaints of the households about the clearance of their land (ST-LND-008, LND 3.3, BR-LND-01, UAT-AC384). A complaint is filed for a household inside the units of the caller with the way it reached the
 * officer, what it is about and what it says; it gets the number that follows the last one of the project, the days it is to be answered in (the rule COMPLAINT_RESOLUTION in force on the day it was filed,
 * 422 `TIMER_RULE_UNCONFIRMED` when there is none) with a timer, and it holds the parcels of the household that are not yet paid as disputed. It is answered with an outcome, a note and, when it is
 * accepted or rejected, a reply document that was scanned clean (422 `DECISION_DOCUMENT_REQUIRED`); the parcels it held then go back to where they were. The issue that ISS opens for it holds the number and nothing
 * the complainant said.
 */
export class LndComplaintStore {
  private readonly timers: LndTimerRules;
  private readonly source: LndLandSource;

  constructor(timers: LndTimerRules = new LndTimerRules(), source: LndLandSource = new LndLandSource()) {
    this.timers = timers;
    this.source = source;
  }

  async file(
    tx: TenantTx,
    input: { projectId: string; householdId: string; planId?: string | undefined; ownerUnitId: string; channel: string; subject: string; description: string; filedOn: string },
    actor: string,
    units: ScopeUnits,
    today: string,
  ): Promise<FiledComplaint> {
    const projectId = idText(input.projectId, 'project_id');
    const householdId = idText(input.householdId, 'household_id');
    const ownerUnitId = idText(input.ownerUnitId, 'owner_unit_id');
    const planId = input.planId === undefined ? null : idText(input.planId, 'plan_id');
    const channel = COMPLAINT_CHANNELS.find((candidate) => candidate === input.channel);
    if (channel === undefined) throw invalid('channel');
    const subject = COMPLAINT_SUBJECTS.find((candidate) => candidate === input.subject);
    if (subject === undefined) throw invalid('subject');
    const description = textOf(input.description, 'description', 1, MAX_TEXT);
    const filedOn = dateOf(input.filedOn, 'filed_on');
    if (filedOn > today || filedOn < MIN_FILED_DATE) throw invalid('filed_on');
    await enterScope(tx, units);
    if ((await this.source.projectRef(tx, projectId)) === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // A household outside the units of the caller or of another project is as if it was not there.
    const household = (await tx.query<{ owner_unit_id: string; project_id: string }>('select owner_unit_id, project_id from machvon.affected_household where id = $1::uuid', [householdId]))[0];
    if (household === undefined || household.project_id !== projectId) throw new DomainError('HOUSEHOLD_NOT_FOUND', 422, 'household_id');
    // The unit that answers a complaint is the unit of the household: its words are read inside it and nowhere else.
    if (household.owner_unit_id !== ownerUnitId) throw invalid('owner_unit_id');
    if (planId !== null) {
      const plan = (await tx.query<{ project_id: string }>('select project_id from machvon.compensation_plan where id = $1::uuid', [planId]))[0];
      if (plan === undefined || plan.project_id !== projectId) throw invalid('plan_id');
    }
    const timer = await this.timers.resolve(tx, COMPLAINT_TIMER, filedOn);
    const dueOn = await this.timers.dueOn(tx, timer.rule, filedOn);
    const counter = (
      await tx.query<{ last_no: number }>(
        `insert into machvon.land_complaint_counter (tenant_id, project_id, last_no) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, 1)
         on conflict (tenant_id, project_id) do update set last_no = machvon.land_complaint_counter.last_no + 1 returning last_no`,
        [projectId],
      )
    )[0] as { last_no: number };
    const complaintNo = `LC-${String(counter.last_no).padStart(6, '0')}`;
    const id = randomUUID();
    await tx.query(
      `insert into machvon.land_complaint
         (tenant_id, id, project_id, household_id, plan_id, owner_unit_id, complaint_no, filed_on, channel, subject, description, status, due_on, created_by, updated_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::date, $8, $9, $10, 'RECEIVED', $11::date, $12::uuid, $12::uuid, 1)`,
      [id, projectId, householdId, planId, ownerUnitId, complaintNo, filedOn, channel, subject, description, dueOn, actor],
    );
    const deadlineId = randomUUID();
    await withUniqueClaim(tx, { constraint: RUNNING_CONSTRAINT, code: 'COMPLAINT_STATE_INVALID' }, () =>
      tx.query(
        `insert into machvon.land_deadline
           (tenant_id, id, project_id, subject_kind, subject_id, timer_code, days_applied, started_on, due_on, status, rule_version_id, version, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, 'COMPLAINT', $3::uuid, $4, $5, $6::date, $7::date, 'RUNNING', $8::uuid, 1, $9::uuid, $9::uuid)`,
        [deadlineId, projectId, id, COMPLAINT_TIMER, timer.rule.days, filedOn, dueOn, timer.reading.versionId, actor],
      ),
    );
    const held = await this.hold(tx, id, householdId, ownerUnitId, actor);
    return {
      id,
      projectId,
      complaintNo,
      ownerUnitId,
      subject,
      channel,
      filedOn,
      dueOn,
      daysApplied: timer.rule.days,
      deadlineId,
      ruleVersionId: timer.reading.versionId,
      ruleRevision: timer.reading.revision,
      parcelsHeld: held,
      version: 1,
    };
  }

  /**
   * Answers a complaint (409 `COMPLAINT_STATE_INVALID`, 409 `VERSION_CONFLICT`, 422 `DECISION_DOCUMENT_REQUIRED`): accepted or rejected with the reply document, or escalated to a higher level with a note. The
   * timer of the complaint ends by the day of the answer (satisfied inside its days, breached after), and an answer that is accepted or rejected gives the parcels that the complaint held back.
   */
  async resolve(
    tx: TenantTx,
    input: { complaintId: string; expectedVersion: number; outcome: string; resolutionDocumentVersionId?: string | undefined; resolvedOn: string; note: string },
    actor: string,
    units: ScopeUnits,
    today: string,
  ): Promise<AnsweredComplaint> {
    const outcome = COMPLAINT_OUTCOMES.find((candidate) => candidate === input.outcome);
    if (outcome === undefined) throw invalid('outcome');
    const resolvedOn = dateOf(input.resolvedOn, 'resolved_on');
    const note = textOf(input.note, 'note', 1, MAX_TEXT);
    const documentId = input.resolutionDocumentVersionId === undefined ? null : idText(input.resolutionDocumentVersionId, 'resolution_document_version_id');
    await enterScope(tx, units);
    const complaint = (
      await tx.query<{ id: string; project_id: string; complaint_no: string; status: ComplaintStatus; version: string; filed_on: string; due_on: string }>(
        'select id, project_id, complaint_no, status, version::text as version, filed_on::text as filed_on, due_on::text as due_on from machvon.land_complaint where id = $1::uuid for update',
        [idText(input.complaintId, 'id')],
      )
    )[0];
    // A complaint in another unit than the caller reaches does not exist for them.
    if (complaint === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(complaint.version) !== input.expectedVersion) throw versionConflict(Number(complaint.version));
    if (!ANSWERABLE.includes(complaint.status) || (complaint.status === 'ESCALATED' && outcome === 'ESCALATED')) throw new DomainError('COMPLAINT_STATE_INVALID', 409, 'status', { extensions: { status: complaint.status } });
    if (resolvedOn > today || resolvedOn < complaint.filed_on) throw invalid('resolved_on');
    if (outcome !== 'ESCALATED' && documentId === null) throw new DomainError('DECISION_DOCUMENT_REQUIRED', 422, 'resolution_document_version_id');
    if (documentId !== null) await this.assertDocument(tx, documentId);
    const version = Number(complaint.version) + 1;
    await tx.query(
      `update machvon.land_complaint
          set status = $2, resolved_on = $3::date, resolved_by = $4::uuid, resolution_note = $5, resolution_document_version_id = $6::uuid, updated_at = now(), updated_by = $4::uuid, version = $7
        where id = $1::uuid`,
      [complaint.id, outcome, resolvedOn, actor, note, documentId, version],
    );
    const late = resolvedOn > complaint.due_on;
    await tx.query(
      `update machvon.land_deadline
          set status = $2, satisfied_on = $3::date, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where subject_kind = 'COMPLAINT' and subject_id = $1::uuid and status = 'RUNNING'`,
      [complaint.id, late ? 'BREACHED' : 'SATISFIED', late ? null : resolvedOn, actor],
    );
    const released = outcome === 'ESCALATED' ? 0 : await this.release(tx, complaint.id, actor);
    return {
      id: complaint.id,
      projectId: complaint.project_id,
      complaintNo: complaint.complaint_no,
      status: outcome,
      fromStatus: complaint.status,
      resolvedOn,
      dueOn: complaint.due_on,
      lateDays: late ? daysBetween(complaint.due_on, resolvedOn) : 0,
      resolutionDocumentVersionId: documentId,
      parcelsReleased: released,
      version,
    };
  }

  /** The complaints of a project inside the units of the caller, by number; the cursor is the number and the id of the last line. */
  async list(tx: TenantTx, filter: ComplaintFilter, units: ScopeUnits): Promise<ComplaintLine[]> {
    const projectId = idText(filter.projectId, 'project_id');
    const status = filter.status === undefined ? null : (COMPLAINT_STATUSES.find((candidate) => candidate === filter.status) ?? this.badStatus());
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_PAGE + 1) throw invalid('limit');
    await enterScope(tx, units);
    const rows = await tx.query<{
      id: string;
      project_id: string;
      household_id: string;
      household_code: string;
      plan_id: string | null;
      owner_unit_id: string;
      complaint_no: string;
      filed_on: string;
      channel: ComplaintChannel;
      subject: ComplaintSubject;
      description: string;
      status: ComplaintStatus;
      due_on: string;
      resolved_on: string | null;
      resolution_note: string | null;
      resolution_document_version_id: string | null;
      issue_id: string | null;
      version: string;
    }>(
      `select c.id, c.project_id, c.household_id, h.household_code, c.plan_id, c.owner_unit_id, c.complaint_no, c.filed_on::text as filed_on, c.channel, c.subject, c.description, c.status, c.due_on::text as due_on,
              c.resolved_on::text as resolved_on, c.resolution_note, c.resolution_document_version_id, c.issue_id, c.version::text as version
         from machvon.land_complaint c join machvon.affected_household h on h.tenant_id = c.tenant_id and h.id = c.household_id
        where c.project_id = $1::uuid and ($2::text is null or c.status = $2) and ($3::text is null or (c.complaint_no, c.id) > ($3::text, $4::uuid))
        order by c.complaint_no, c.id limit ${filter.limit}`,
      [projectId, status, filter.after?.code ?? null, filter.after?.id ?? null],
    );
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      householdId: row.household_id,
      householdCode: row.household_code,
      planId: row.plan_id,
      ownerUnitId: row.owner_unit_id,
      complaintNo: row.complaint_no,
      filedOn: row.filed_on,
      channel: row.channel,
      subject: row.subject,
      description: row.description,
      status: row.status,
      dueOn: row.due_on,
      resolvedOn: row.resolved_on,
      resolutionNote: row.resolution_note,
      resolutionDocumentVersionId: row.resolution_document_version_id,
      issueId: row.issue_id,
      version: Number(row.version),
    }));
  }

  /** Where a complaint lies, for the check of the reach of the caller; undefined when it is not in the units of the caller. */
  async place(tx: TenantTx, complaintId: string, units: ScopeUnits): Promise<{ projectId: string } | undefined> {
    const id = idText(complaintId, 'id');
    await enterScope(tx, units);
    const row = (await tx.query<{ project_id: string }>('select project_id from machvon.land_complaint where id = $1::uuid', [id]))[0];
    return row === undefined ? undefined : { projectId: row.project_id };
  }

  private badStatus(): never {
    throw invalid('status');
  }

  private async assertDocument(tx: TenantTx, documentVersionId: string): Promise<void> {
    const rows = await tx.query<{ scan_status: string }>('select scan_status from machvon.document_version where id = $1::uuid', [documentVersionId]);
    if (rows[0] === undefined) throw new DomainError('DECISION_DOCUMENT_REQUIRED', 422, 'resolution_document_version_id');
    if (rows[0].scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422, 'resolution_document_version_id');
  }

  /**
   * The parcels of the household that are not yet paid are held as disputed by the complaint, each with the state it had. A parcel that another complaint of the household already holds is held by this one too,
   * with the state that the first complaint found it in, so that it goes back only when the last of them lets it go.
   */
  private async hold(tx: TenantTx, complaintId: string, householdId: string, ownerUnitId: string, actor: string): Promise<number> {
    const parcels = await tx.query<{ id: string; status: string; previous_status: string | null }>(
      `select p.id, p.status,
              (select h.previous_status from machvon.land_complaint_hold h where h.tenant_id = p.tenant_id and h.parcel_id = p.id and h.released_at is null order by h.held_at, h.id limit 1) as previous_status
         from machvon.household_parcel hp join machvon.land_parcel p on p.tenant_id = hp.tenant_id and p.id = hp.parcel_id
        where hp.household_id = $1::uuid and (p.status = any($2::text[]) or (p.status = 'DISPUTED' and exists (select 1 from machvon.land_complaint_hold h where h.tenant_id = p.tenant_id and h.parcel_id = p.id and h.released_at is null)))
        order by p.id for update of p`,
      [householdId, HOLDABLE],
    );
    for (const parcel of parcels) {
      await tx.query(
        `insert into machvon.land_complaint_hold (tenant_id, id, complaint_id, parcel_id, owner_unit_id, previous_status)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4)`,
        [complaintId, parcel.id, ownerUnitId, parcel.previous_status ?? parcel.status],
      );
      if (parcel.status !== 'DISPUTED') await tx.query("update machvon.land_parcel set status = 'DISPUTED', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [parcel.id, actor]);
    }
    return parcels.length;
  }

  /** The parcels that the complaint held go back to the state they had, unless another complaint still holds them. */
  private async release(tx: TenantTx, complaintId: string, actor: string): Promise<number> {
    const holds = await tx.query<{ id: string; parcel_id: string; previous_status: string }>(
      'select id, parcel_id, previous_status from machvon.land_complaint_hold where complaint_id = $1::uuid and released_at is null order by parcel_id for update',
      [complaintId],
    );
    let restored = 0;
    for (const hold of holds) {
      await tx.query('update machvon.land_complaint_hold set released_at = now() where id = $1::uuid', [hold.id]);
      const others = (await tx.query<{ held: boolean }>('select machvon.parcel_held_by_another($1::uuid, $2::uuid) as held', [hold.parcel_id, complaintId]))[0] as { held: boolean };
      if (others.held) continue;
      const moved = await tx.query("update machvon.land_parcel set status = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid and status = 'DISPUTED' returning id", [hold.parcel_id, hold.previous_status, actor]);
      restored += moved.length;
    }
    return restored;
  }
}
