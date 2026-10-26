import { randomUUID } from 'node:crypto';
import { DomainError, FEEDBACK_CHANNELS, acceptsFeedback, acceptsFeedbackHandling, assertFourEyes, canPost, versionConflict } from '@machvon/kernel';
import type { FeedbackChannel, FeedbackStatus, LandTimerCode, PlanStatus } from '@machvon/kernel';
import { enterScope, unitInScope } from './lnd-household-store.ts';
import type { ScopeUnits } from './lnd-household-store.ts';
import { LndTimerRules } from './lnd-timer-rules.ts';
import { dateOf, lowerId, textOf } from './lnd-values.ts';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

const MAX_TEXT = 2000;
const RUNNING_CONSTRAINT = 'land_deadline_running_uq';
const POSTING_TIMER: LandTimerCode = 'PLAN_POSTING_30';
const PAYMENT_TIMER: LandTimerCode = 'PAYMENT_30';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** What posting a plan did: the days it is posted for, the timer that counts them and the rule that decided the days, and how many parcels and households were moved on with it. */
export interface PostedPlan {
  planId: string;
  projectId: string;
  version: number;
  postingStartedOn: string;
  postingEndsOn: string;
  daysApplied: number;
  deadlineId: string;
  ruleVersionId: string;
  ruleRevision: number;
  parcelsMoved: number;
  householdsMoved: number;
}

export interface RecordedFeedback {
  id: string;
  planId: string;
  projectId: string;
  householdId: string | null;
  channel: FeedbackChannel;
}

export interface HandledFeedback {
  id: string;
  planId: string;
  projectId: string;
  handledOn: string;
  openRemaining: number;
}

export interface ClosedPosting {
  planId: string;
  projectId: string;
  version: number;
  closedOn: string;
  postingEndsOn: string;
  openFeedback: number;
  handledFeedback: number;
  deadlineId: string;
}

export interface ApprovedPlan {
  planId: string;
  projectId: string;
  version: number;
  approvedOn: string;
  paymentDueOn: string;
  decisionDocumentVersionId: string;
  paymentDays: number;
  ruleVersionId: string;
  parcelsMoved: number;
}

/** An opinion as the screen reads it; the words are read only inside the unit they came from. */
export interface PlanFeedbackLine {
  id: string;
  planId: string;
  householdId: string | null;
  householdCode: string | null;
  ownerUnitId: string;
  channel: FeedbackChannel;
  summary: string;
  status: FeedbackStatus;
  recordedOn: string;
  handledOn: string | null;
  handlingNote: string | null;
  version: number;
}

/** A timer of the plan with the rule that counted it and what is left of it on the day asked about. */
export interface PlanTimerLine {
  id: string;
  timerCode: LandTimerCode;
  daysApplied: number;
  startedOn: string;
  dueOn: string;
  satisfiedOn: string | null;
  status: 'RUNNING' | 'SATISFIED' | 'BREACHED' | 'CANCELLED';
  legalBasis: string | null;
  awaitingConfirmation: boolean;
  cxn: string | null;
}

/** The timers of a plan and the opinions on it, counted; the numbers are the same for everyone who reads the plan, the words of the opinions are not. */
export interface PlanTimers {
  planId: string;
  projectId: string;
  status: PlanStatus;
  postingStartedOn: string | null;
  postingEndsOn: string | null;
  approvedOn: string | null;
  paymentDueOn: string | null;
  openFeedback: number;
  handledFeedback: number;
  deadlines: PlanTimerLine[];
}

interface LockedPlan {
  id: string;
  projectId: string;
  executorUnitId: string;
  status: PlanStatus;
  version: number;
  createdBy: string;
  createdOn: string;
  grandTotal: string;
  postingEndsOn: string | null;
}

const idText = (value: string, field: string): string => {
  if (typeof value !== 'string' || !UUID.test(value.trim())) throw invalid(field);
  return lowerId(value.trim());
};

/**
 * The posting of a plan to the households and what follows it (ST-LND-006, LND 3.1 steps 5-6, BR-LND-02, UAT-AC377). A draft that has something in it, whose every compensation still rests on a confirmed record, is
 * posted from a day that has come: the days it is posted for are those of the rule PLAN_POSTING_30 in force that day (422 `TIMER_RULE_UNCONFIRMED` when none is), so it ends on the day the timer falls due. While it
 * is posted the households' opinions are recorded; an opinion is handled once, with a note. The posting is closed with a summary and not before it ends (422 `POSTING_PERIOD_NOT_ELAPSED`); a plan whose posting
 * is closed is approved by someone other than the person who drafted it, on a day that is not before the posting ended, with a decision document that was scanned clean, and only when no opinion is open (422
 * `UNRESOLVED_FEEDBACK`). The payment is due 30 days from the approval by the rule PAYMENT_30.
 */
export class LndPlanPostingStore {
  private readonly timers: LndTimerRules;

  constructor(timers: LndTimerRules = new LndTimerRules()) {
    this.timers = timers;
  }

  /** Posts a draft plan (409 `PLAN_STATE_INVALID`, 409 `VERSION_CONFLICT`, 422 `PLAN_HAS_NO_ITEMS`, 422 `INVENTORY_NOT_CONFIRMED`, 422 `TIMER_RULE_UNCONFIRMED`). */
  async post(tx: TenantTx, input: { planId: string; expectedVersion: number; postingStartedOn: string; postingPlaceText: string }, actor: string, today: string): Promise<PostedPlan> {
    const startedOn = dateOf(input.postingStartedOn, 'posting_started_on');
    const place = textOf(input.postingPlaceText, 'posting_place_text', 1, MAX_TEXT);
    const plan = await this.lock(tx, input.planId);
    if (plan.version !== input.expectedVersion) throw versionConflict(plan.version);
    if (!canPost(plan.status)) throw new DomainError('PLAN_STATE_INVALID', 409, 'status', { extensions: { status: plan.status } });
    // A plan is posted on a day that has come and not before the plan existed: a posting dated back would shorten what the households were given.
    if (startedOn > today || startedOn < plan.createdOn) throw invalid('posting_started_on');
    if (plan.grandTotal === '0') throw new DomainError('PLAN_HAS_NO_ITEMS', 422);
    await this.assertConfirmed(tx, plan.id);
    const timer = await this.timers.resolve(tx, POSTING_TIMER, startedOn);
    const endsOn = await this.timers.dueOn(tx, timer.rule, startedOn);
    const deadlineId = randomUUID();
    await withUniqueClaim(tx, { constraint: RUNNING_CONSTRAINT, code: 'PLAN_STATE_INVALID' }, () =>
      tx.query(
        `insert into machvon.land_deadline
           (tenant_id, id, project_id, subject_kind, subject_id, timer_code, days_applied, started_on, due_on, status, rule_version_id, version, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, 'PLAN', $3::uuid, $4, $5, $6::date, $7::date, 'RUNNING', $8::uuid, 1, $9::uuid, $9::uuid)`,
        [deadlineId, plan.projectId, plan.id, POSTING_TIMER, timer.rule.days, startedOn, endsOn, timer.reading.versionId, actor],
      ),
    );
    const version = plan.version + 1;
    await tx.query(
      `update machvon.compensation_plan
          set status = 'POSTING', posting_started_on = $2::date, posting_ends_on = $3::date, posting_place_text = $4, timer_rule_version_id = $5::uuid, updated_at = now(), updated_by = $6::uuid, version = $7
        where id = $1::uuid`,
      [plan.id, startedOn, endsOn, place, timer.reading.versionId, actor, version],
    );
    const moved = await this.advance(tx, plan.id, actor);
    return {
      planId: plan.id,
      projectId: plan.projectId,
      version,
      postingStartedOn: startedOn,
      postingEndsOn: endsOn,
      daysApplied: timer.rule.days,
      deadlineId,
      ruleVersionId: timer.reading.versionId,
      ruleRevision: timer.reading.revision,
      parcelsMoved: moved.parcels,
      householdsMoved: moved.households,
    };
  }

  /**
   * Records an opinion while the plan is posted (409 `PLAN_STATE_INVALID` otherwise). An opinion names the household it came from when it came from one on the list, inside the units of the caller and in
   * the project of the plan (404 when the household is not there for the caller); an opinion of nobody on the list belongs to the unit that executes the plan.
   */
  async recordFeedback(tx: TenantTx, input: { planId: string; householdId?: string | undefined; summary: string; channel: string }, actor: string, today: string, units: ScopeUnits): Promise<RecordedFeedback> {
    const summary = textOf(input.summary, 'summary', 1, MAX_TEXT);
    const channel = FEEDBACK_CHANNELS.find((candidate) => candidate === input.channel);
    if (channel === undefined) throw invalid('channel');
    const householdId = input.householdId === undefined ? null : idText(input.householdId, 'household_id');
    await enterScope(tx, units);
    const plan = await this.lock(tx, input.planId, 'share');
    if (!acceptsFeedback(plan.status)) throw new DomainError('PLAN_STATE_INVALID', 409, 'status', { extensions: { status: plan.status } });
    let ownerUnitId = plan.executorUnitId;
    // An opinion of nobody on the list is kept by the unit that executes the plan, so only someone who acts for that unit records it (403 `SCOPE_DENIED`).
    if (householdId === null && !unitInScope(units, ownerUnitId)) throw new DomainError('SCOPE_DENIED', 403);
    if (householdId !== null) {
      const household = (await tx.query<{ owner_unit_id: string; project_id: string }>('select owner_unit_id, project_id from machvon.affected_household where id = $1::uuid', [householdId]))[0];
      // A household outside the units of the caller is as if it did not exist.
      if (household === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'household_id');
      if (household.project_id !== plan.projectId) throw invalid('household_id');
      ownerUnitId = household.owner_unit_id;
    }
    const id = randomUUID();
    await tx.query(
      `insert into machvon.compensation_plan_feedback
         (tenant_id, id, plan_id, household_id, owner_unit_id, channel, summary, status, recorded_on, created_by, updated_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'OPEN', $7::date, $8::uuid, $8::uuid, 1)`,
      [id, plan.id, householdId, ownerUnitId, channel, summary, today, actor],
    );
    return { id, planId: plan.id, projectId: plan.projectId, householdId, channel };
  }

  /**
   * Handles an opinion with a note (409 `FEEDBACK_ALREADY_HANDLED` for one that was handled, 409 `PLAN_STATE_INVALID` once the plan is past its posting, 404 for an opinion outside the units of the caller).
   * A handled opinion is final.
   */
  async handleFeedback(tx: TenantTx, input: { planId: string; feedbackId: string; handlingNote: string }, actor: string, today: string, units: ScopeUnits): Promise<HandledFeedback> {
    const note = textOf(input.handlingNote, 'handling_note', 1, MAX_TEXT);
    const feedbackId = idText(input.feedbackId, 'feedback_id');
    await enterScope(tx, units);
    const plan = await this.lock(tx, input.planId, 'share');
    const row = (
      await tx.query<{ id: string; status: FeedbackStatus; recorded_on: string }>('select id, status, recorded_on::text as recorded_on from machvon.compensation_plan_feedback where id = $1::uuid and plan_id = $2::uuid for update', [feedbackId, plan.id])
    )[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.status === 'HANDLED') throw new DomainError('FEEDBACK_ALREADY_HANDLED', 409);
    if (!acceptsFeedbackHandling(plan.status)) throw new DomainError('PLAN_STATE_INVALID', 409, 'status', { extensions: { status: plan.status } });
    // The day of the handling is not before the day the opinion was recorded (a clock that went back would be refused by the table; the day is kept as it was).
    const handledOn = today < row.recorded_on ? row.recorded_on : today;
    await tx.query(
      "update machvon.compensation_plan_feedback set status = 'HANDLED', handled_on = $2::date, handled_by = $3::uuid, handling_note = $4, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid",
      [feedbackId, handledOn, actor, note],
    );
    const counts = await this.counts(tx, plan.id);
    return { id: feedbackId, planId: plan.id, projectId: plan.projectId, handledOn, openRemaining: counts.open };
  }

  /** Closes the posting with a summary of the opinions, not before it ends (422 `POSTING_PERIOD_NOT_ELAPSED`); the timer of the posting is satisfied on the day it is closed. */
  async closePosting(tx: TenantTx, input: { planId: string; expectedVersion: number; feedbackSummary: string }, actor: string, today: string): Promise<ClosedPosting> {
    const summary = textOf(input.feedbackSummary, 'feedback_summary', 1, MAX_TEXT);
    const plan = await this.lock(tx, input.planId);
    if (plan.version !== input.expectedVersion) throw versionConflict(plan.version);
    if (plan.status !== 'POSTING' || plan.postingEndsOn === null) throw new DomainError('PLAN_STATE_INVALID', 409, 'status', { extensions: { status: plan.status } });
    const running = (
      await tx.query<{ id: string }>("select id from machvon.land_deadline where subject_kind = 'PLAN' and subject_id = $1::uuid and status = 'RUNNING' for update", [plan.id])
    )[0];
    if (running === undefined) throw new DomainError('PLAN_STATE_INVALID', 409, 'status', { extensions: { status: plan.status } });
    if (today < plan.postingEndsOn) throw new DomainError('POSTING_PERIOD_NOT_ELAPSED', 422, 'posting_ends_on', { extensions: { posting_ends_on: plan.postingEndsOn } });
    const version = plan.version + 1;
    await tx.query("update machvon.compensation_plan set status = 'POSTING_CLOSED', feedback_summary = $2, updated_at = now(), updated_by = $3::uuid, version = $4 where id = $1::uuid", [plan.id, summary, actor, version]);
    await tx.query("update machvon.land_deadline set status = 'SATISFIED', satisfied_on = $2::date, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid", [running.id, today, actor]);
    const counts = await this.counts(tx, plan.id);
    return { planId: plan.id, projectId: plan.projectId, version, closedOn: today, postingEndsOn: plan.postingEndsOn, openFeedback: counts.open, handledFeedback: counts.handled, deadlineId: running.id };
  }

  /**
   * Approves a plan whose posting is closed (409 `PLAN_STATE_INVALID`, 409 `VERSION_CONFLICT`, 403 `SELF_APPROVAL_DENIED`, 422 `POSTING_PERIOD_NOT_ELAPSED` for a day before the posting ended, 422
   * `UNRESOLVED_FEEDBACK`, 422 `DECISION_DOCUMENT_REQUIRED`, 422 `INVENTORY_NOT_CONFIRMED`). The payment is due the days of the rule PAYMENT_30 after the day of the approval.
   */
  async approve(tx: TenantTx, input: { planId: string; expectedVersion: number; approvedOn: string; decisionDocumentVersionId: string }, actor: string, today: string): Promise<ApprovedPlan> {
    const approvedOn = dateOf(input.approvedOn, 'approved_on');
    const documentId = idText(input.decisionDocumentVersionId, 'decision_document_version_id');
    const plan = await this.lock(tx, input.planId);
    if (plan.version !== input.expectedVersion) throw versionConflict(plan.version);
    if (plan.status !== 'POSTING_CLOSED' || plan.postingEndsOn === null) throw new DomainError('PLAN_STATE_INVALID', 409, 'status', { extensions: { status: plan.status } });
    assertFourEyes(plan.createdBy, actor);
    if (approvedOn > today) throw invalid('approved_on');
    if (approvedOn < plan.postingEndsOn) throw new DomainError('POSTING_PERIOD_NOT_ELAPSED', 422, 'approved_on', { extensions: { posting_ends_on: plan.postingEndsOn } });
    const counts = await this.counts(tx, plan.id);
    if (counts.open > 0) throw new DomainError('UNRESOLVED_FEEDBACK', 422, 'feedback', { extensions: { open_count: counts.open } });
    await this.assertDecisionDocument(tx, documentId);
    await this.assertConfirmed(tx, plan.id);
    const timer = await this.timers.resolve(tx, PAYMENT_TIMER, approvedOn);
    const paymentDueOn = await this.timers.dueOn(tx, timer.rule, approvedOn);
    const version = plan.version + 1;
    await tx.query(
      `update machvon.compensation_plan
          set status = 'APPROVED', approved_on = $2::date, approved_by = $3::uuid, payment_due_on = $4::date, decision_document_version_id = $5::uuid, updated_at = now(), updated_by = $3::uuid, version = $6
        where id = $1::uuid`,
      [plan.id, approvedOn, actor, paymentDueOn, documentId, version],
    );
    const moved = await this.advance(tx, plan.id, actor);
    return { planId: plan.id, projectId: plan.projectId, version, approvedOn, paymentDueOn, decisionDocumentVersionId: documentId, paymentDays: timer.rule.days, ruleVersionId: timer.reading.versionId, parcelsMoved: moved.parcels };
  }

  /** The opinions on a plan inside the units of the caller, in the order they were recorded; an opinion of another unit is not there. */
  async feedback(tx: TenantTx, planId: string, units: ScopeUnits, status?: string): Promise<PlanFeedbackLine[]> {
    const id = idText(planId, 'plan_id');
    const wanted = status === undefined ? null : (['OPEN', 'HANDLED'].find((candidate) => candidate === status) ?? this.badStatus());
    await enterScope(tx, units);
    const rows = await tx.query<{
      id: string;
      plan_id: string;
      household_id: string | null;
      household_code: string | null;
      owner_unit_id: string;
      channel: FeedbackChannel;
      summary: string;
      status: FeedbackStatus;
      recorded_on: string;
      handled_on: string | null;
      handling_note: string | null;
      version: string;
    }>(
      `select f.id, f.plan_id, f.household_id, h.household_code, f.owner_unit_id, f.channel, f.summary, f.status, f.recorded_on::text as recorded_on, f.handled_on::text as handled_on, f.handling_note, f.version::text as version
         from machvon.compensation_plan_feedback f
         left join machvon.affected_household h on h.tenant_id = f.tenant_id and h.id = f.household_id
        where f.plan_id = $1::uuid and ($2::text is null or f.status = $2)
        order by f.recorded_on, f.created_at, f.id`,
      [id, wanted],
    );
    return rows.map((row) => ({
      id: row.id,
      planId: row.plan_id,
      householdId: row.household_id,
      householdCode: row.household_code,
      ownerUnitId: row.owner_unit_id,
      channel: row.channel,
      summary: row.summary,
      status: row.status,
      recordedOn: row.recorded_on,
      handledOn: row.handled_on,
      handlingNote: row.handling_note,
      version: Number(row.version),
    }));
  }

  /** The timers of a plan with the rule each was counted by, and how many opinions are open and handled (404 when the plan does not exist). */
  async timersOf(tx: TenantTx, planId: string): Promise<PlanTimers> {
    const id = idText(planId, 'plan_id');
    const plan = (
      await tx.query<{ project_id: string; status: PlanStatus; posting_started_on: string | null; posting_ends_on: string | null; approved_on: string | null; payment_due_on: string | null }>(
        'select project_id, status, posting_started_on::text as posting_started_on, posting_ends_on::text as posting_ends_on, approved_on::text as approved_on, payment_due_on::text as payment_due_on from machvon.compensation_plan where id = $1::uuid',
        [id],
      )
    )[0];
    if (plan === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const rows = await tx.query<{
      id: string;
      timer_code: LandTimerCode;
      days_applied: number;
      started_on: string;
      due_on: string;
      satisfied_on: string | null;
      status: PlanTimerLine['status'];
      legal_basis: string | null;
      awaiting: boolean;
      cxn: string | null;
    }>(
      `select dl.id, dl.timer_code, dl.days_applied, dl.started_on::text as started_on, dl.due_on::text as due_on, dl.satisfied_on::text as satisfied_on, dl.status, rv.legal_basis,
              coalesce((rv.attributes ->> 'awaiting_confirmation')::boolean, false) as awaiting, rv.attributes ->> 'cxn' as cxn
         from machvon.land_deadline dl
         left join machvon.master_record_version rv on rv.tenant_id = dl.tenant_id and rv.id = dl.rule_version_id
        where dl.subject_kind = 'PLAN' and dl.subject_id = $1::uuid
        order by dl.created_at, dl.id`,
      [id],
    );
    const counts = await this.counts(tx, id);
    return {
      planId: id,
      projectId: plan.project_id,
      status: plan.status,
      postingStartedOn: plan.posting_started_on,
      postingEndsOn: plan.posting_ends_on,
      approvedOn: plan.approved_on,
      paymentDueOn: plan.payment_due_on,
      openFeedback: counts.open,
      handledFeedback: counts.handled,
      deadlines: rows.map((row) => ({
        id: row.id,
        timerCode: row.timer_code,
        daysApplied: row.days_applied,
        startedOn: row.started_on,
        dueOn: row.due_on,
        satisfiedOn: row.satisfied_on,
        status: row.status,
        legalBasis: row.legal_basis,
        awaitingConfirmation: row.awaiting,
        cxn: row.cxn,
      })),
    };
  }

  private badStatus(): never {
    throw invalid('status');
  }

  /** How many opinions of the plan are open and handled, whoever asks: the function answers with counts for the tenant and reads no words. */
  private async counts(tx: TenantTx, planId: string): Promise<{ open: number; handled: number }> {
    const rows = await tx.query<{ open_count: number; handled_count: number }>('select open_count, handled_count from machvon.plan_feedback_counts($1::uuid)', [planId]);
    // The function always answers one row (a plan with no opinions has counts of zero).
    const row = rows[0] as { open_count: number; handled_count: number };
    return { open: row.open_count, handled: row.handled_count };
  }

  /** 422 `INVENTORY_NOT_CONFIRMED` when any item of the plan rests on a record that is not confirmed any more, whoever asks and whatever units they see. */
  private async assertConfirmed(tx: TenantTx, planId: string): Promise<void> {
    const rows = await tx.query<{ status: string | null }>('select machvon.plan_unconfirmed_inventory($1::uuid) as status', [planId]);
    const status = rows[0]?.status ?? null;
    if (status !== null) throw new DomainError('INVENTORY_NOT_CONFIRMED', 422, 'items', { extensions: { status } });
  }

  private async assertDecisionDocument(tx: TenantTx, documentVersionId: string): Promise<void> {
    const rows = await tx.query<{ scan_status: string }>('select scan_status from machvon.document_version where id = $1::uuid', [documentVersionId]);
    if (rows[0] === undefined) throw new DomainError('DECISION_DOCUMENT_REQUIRED', 422, 'decision_document_version_id');
    if (rows[0].scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422, 'decision_document_version_id');
  }

  /** Moves the parcels and the households of the plan to where its new status puts them (the function reads the items whoever asks). */
  private async advance(tx: TenantTx, planId: string, actor: string): Promise<{ parcels: number; households: number }> {
    const rows = await tx.query<{ parcels_moved: number; households_moved: number }>('select parcels_moved, households_moved from machvon.advance_plan_subjects($1::uuid, $2::uuid)', [planId, actor]);
    const row = rows[0] as { parcels_moved: number; households_moved: number };
    return { parcels: row.parcels_moved, households: row.households_moved };
  }

  private async lock(tx: TenantTx, planId: string, mode: 'update' | 'share' = 'update'): Promise<LockedPlan> {
    const id = idText(planId, 'plan_id');
    const row = (
      await tx.query<{
        id: string;
        project_id: string;
        executor_unit_id: string;
        status: PlanStatus;
        version: string;
        created_by: string;
        created_on: string;
        grand_total: string;
        posting_ends_on: string | null;
      }>(
        `select id, project_id, executor_unit_id, status, version::text as version, created_by, (created_at at time zone 'Asia/Ho_Chi_Minh')::date::text as created_on, grand_total_vnd::text as grand_total,
                posting_ends_on::text as posting_ends_on
           from machvon.compensation_plan where id = $1::uuid for ${mode}`,
        [id],
      )
    )[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return {
      id: row.id,
      projectId: row.project_id,
      executorUnitId: row.executor_unit_id,
      status: row.status,
      version: Number(row.version),
      createdBy: row.created_by,
      createdOn: row.created_on,
      grandTotal: row.grand_total,
      postingEndsOn: row.posting_ends_on,
    };
  }
}
