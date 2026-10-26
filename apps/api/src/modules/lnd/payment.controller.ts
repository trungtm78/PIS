import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { LndDeadlineStore, LndLandSource, LndPaymentStore, LndPlanStore, TenantDatabase, contractScope, householdScopeUnits, projectScope } from '@machvon/db';
import type { ContractScopes, PaymentLine, SettledPayment, UpcomingDeadline } from '@machvon/db';
import { DomainError, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, FieldCipher, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { recordAdvanceTrail } from '../pay/advance.controller';
import { mayActOnPlan } from './plan.controller';
import { FIELD_CIPHER } from './tokens';

const PAY_PERMISSION = PERMISSIONS.scheduleCompensationPayments;
const READ_PERMISSION = PERMISSIONS.listCompensationPayments;
const DEADLINES_PERMISSION = PERMISSIONS.listUpcomingLandDeadlines;
const RESOURCE_TYPE = 'compensation_payment';
const PLAN_TYPE = 'compensation_plan';
/** The amount that a household is paid is personal, so the trail of a payment is classified so; it carries the id of the payment and the amount, never the household. */
const CLASSIFICATION = 'PERSONAL';
const DEFAULT_WITHIN_DAYS = 14;
const MAX_WITHIN_DAYS = 180;

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** A payment as the screen reads it: an allowlist of what a payment is; the account only masked. */
export function paymentLineView(line: PaymentLine): Record<string, unknown> {
  return {
    id: line.id,
    plan_id: line.planId,
    household_id: line.householdId,
    household_code: line.householdCode,
    owner_unit_id: line.ownerUnitId,
    payment_no: line.paymentNo,
    amount_vnd: line.amountVnd,
    due_on: line.dueOn,
    paid_on: line.paidOn,
    method: line.method,
    bank_account_masked: line.bankAccountMasked,
    treasury_transaction_id: line.treasuryTransactionId,
    advance_id: line.advanceId,
    voucher_document_version_id: line.voucherDocumentVersionId,
    deposit_reason: line.depositReason,
    late_reason: line.lateReason,
    status: line.status,
    version: line.version,
  };
}

/** A timer that is coming up as the list reads it: what it counts is named by its code only. */
export function deadlineView(line: UpcomingDeadline): Record<string, unknown> {
  return {
    id: line.id,
    project_id: line.projectId,
    subject_kind: line.subjectKind,
    subject_id: line.subjectId,
    subject_label: line.subjectLabel,
    timer_code: line.timerCode,
    days_applied: line.daysApplied,
    started_on: line.startedOn,
    due_on: line.dueOn,
    remaining_days: line.remainingDays,
    status: line.status,
    alert_level_sent: line.alertLevelSent,
    legal_basis: line.legalBasis,
    awaiting_confirmation: line.awaitingConfirmation,
    cxn: line.cxn,
  };
}

const contractScopesFor = (access: EffectiveAccess, now: Date): ContractScopes => ({ update: contractScope(access, PAY_PERMISSION, now), read: contractScope(access, READ_PERMISSION, now) });

/**
 * The payments of an approved plan to its households (ST-LND-007, LND 3.2, BR-LND-03, UAT-AC378, UAT-AC383, UAT-AC397). The right to schedule, confirm and deposit is `land.payment.write` over the project of the
 * plan, and a payment is written and read inside the units of its household (a grant on a project reaches no household). The trail and the events carry the id of the payment, of the plan and of the advance,
 * the amount and the dates, never the household or an account; a payment that settles an advance of the project recovers it through the command of PAY in the same transaction and leaves PAY's own trail.
 */
@Controller()
export class CompensationPaymentController {
  private readonly source = new LndLandSource();
  private readonly plans = new LndPlanStore(this.source);
  private readonly payments: LndPaymentStore;

  constructor(@Inject(FIELD_CIPHER) cipher: FieldCipher) {
    this.payments = new LndPaymentStore(cipher);
  }

  @Post('compensation-plans/:id/payments')
  @HttpCode(200)
  @OperationId('scheduleCompensationPayments')
  @Command({ operation: 'scheduleCompensationPayments', versioned: true })
  async schedule(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['LndScheduleCompensationPayments'],
  ): Promise<CommandResult> {
    const now = new Date();
    await mayActOnPlan(scope.tx, this.plans, this.source, access, id, PAY_PERMISSION, now);
    const units = await householdScopeUnits(scope.tx, access, PAY_PERMISSION, now);
    const list = (Array.isArray(body.payments) ? body.payments : []).map((entry) => {
      const payment = record(entry);
      return { householdId: payment.household_id, amountVnd: payment.amount_vnd, dueOn: payment.due_on, bankAccount: payment.bank_account, unknownKeys: Object.keys(payment) };
    });
    const done = await this.payments.schedule(scope.tx, { planId: id, expectedVersion: scope.expectedVersion ?? 0, payments: list }, scope.tenant.membershipId, units);
    await scope.audit({
      action: 'lnd.payments_scheduled',
      resourceType: PLAN_TYPE,
      resourceId: done.planId,
      classification: CLASSIFICATION,
      diff: {
        project_id: done.projectId,
        payment_ids: done.payments.map((entry) => entry.id),
        payment_count: done.payments.length,
        scheduled_vnd: done.scheduledVnd,
        remaining_vnd: done.remainingVnd,
        rule_version_id: done.ruleVersionId,
      },
    });
    for (const payment of done.payments) {
      await scope.emit({
        aggregateType: RESOURCE_TYPE,
        aggregateId: payment.id,
        aggregateVersion: 1,
        type: 'lnd.payment.scheduled.v1',
        schemaVersion: 1,
        payload: {
          tenant_id: scope.tenant.tenantId,
          payment_id: payment.id,
          plan_id: done.planId,
          project_id: done.projectId,
          amount_vnd: payment.amountVnd,
          due_on: payment.dueOn,
          deadline_id: payment.deadlineId,
          actor_id: scope.tenant.membershipId,
          occurred_at: now.toISOString(),
        },
        eventKey: `${RESOURCE_TYPE}:${payment.id}:1`,
      });
    }
    return commandResult(scope, done.status, done.version, done.planId);
  }

  @Post('compensation-payments/:id/confirm')
  @HttpCode(200)
  @OperationId('confirmCompensationPayment')
  @Command({ operation: 'confirmCompensationPayment', versioned: true })
  async confirm(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['LndConfirmCompensationPayment'],
  ): Promise<CommandResult> {
    const now = new Date();
    const units = await this.reach(scope, access, id, now);
    const done = await this.payments.confirm(
      scope.tx,
      {
        paymentId: id,
        expectedVersion: scope.expectedVersion ?? 0,
        paidOn: body.paid_on,
        method: body.method,
        voucherDocumentVersionId: body.voucher_document_version_id,
        treasuryTransactionId: body.treasury_transaction_id,
        advanceId: body.advance_id,
        lateReason: body.late_reason,
        requestId: scope.requestId,
      },
      scope.tenant.membershipId,
      units,
      vietnamDateOf(now),
      contractScopesFor(access, now),
    );
    await this.trail(scope, done, 'lnd.payment_confirmed', 'lnd.payment.paid.v1', 'PAID', now, { method: body.method, treasury_transaction_id: body.treasury_transaction_id?.toLowerCase() ?? null });
    if (done.recovery !== null) await recordAdvanceTrail(scope, done.recovery, 'advance.recovered', 'pay.advance.recovered.v1', now, { recovery: { recovery_amount_vnd: done.amountVnd, basis: 'COMPENSATION_PAYMENT', source_ref_id: done.id, evidence_document_version_id: body.voucher_document_version_id.toLowerCase() } });
    return commandResult(scope, 'PAID', done.version, done.id);
  }

  @Post('compensation-payments/:id/deposit')
  @HttpCode(200)
  @OperationId('depositCompensationPayment')
  @Command({ operation: 'depositCompensationPayment', versioned: true })
  async deposit(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['LndDepositCompensationPayment'],
  ): Promise<CommandResult> {
    const now = new Date();
    const units = await this.reach(scope, access, id, now);
    const done = await this.payments.deposit(
      scope.tx,
      { paymentId: id, expectedVersion: scope.expectedVersion ?? 0, paidOn: body.paid_on, depositReason: body.deposit_reason, voucherDocumentVersionId: body.voucher_document_version_id },
      scope.tenant.membershipId,
      units,
      vietnamDateOf(now),
    );
    await this.trail(scope, done, 'lnd.payment_deposited', 'lnd.payment.deposited.v1', 'DEPOSITED', now, {});
    return commandResult(scope, 'DEPOSITED', done.version, done.id);
  }

  /** A payment in another unit than the caller reaches does not exist for them; one they find and may not pay is a refusal. Returns the units the caller writes in. */
  private async reach(scope: CommandScope, access: EffectiveAccess, paymentId: string, now: Date): Promise<string> {
    const units = await householdScopeUnits(scope.tx, access, PAY_PERMISSION, now);
    const place = await this.payments.place(scope.tx, paymentId, units);
    if (place === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await mayActOnPlan(scope.tx, this.plans, this.source, access, place.planId, PAY_PERMISSION, now);
    return units;
  }

  private async trail(scope: CommandScope, done: SettledPayment, action: string, type: string, status: string, now: Date, extra: Record<string, unknown>): Promise<void> {
    await scope.audit({
      action,
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      diff: {
        plan_id: done.planId,
        project_id: done.projectId,
        amount_vnd: done.amountVnd,
        advance_id: done.advanceId,
        paid_on: done.paidOn,
        due_on: done.dueOn,
        late_days: done.lateDays,
        plan_completed: done.planCompleted,
        households_moved: done.householdsMoved,
        parcels_moved: done.parcelsMoved,
        ...extra,
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        payment_id: done.id,
        plan_id: done.planId,
        project_id: done.projectId,
        amount_vnd: done.amountVnd,
        ...(done.advanceId === null ? {} : { advance_id: done.advanceId }),
        status,
        paid_on: done.paidOn,
        late_days: done.lateDays,
        plan_completed: done.planCompleted,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}`,
    });
  }
}

/** The payments of a plan (LND-07) inside the units of the reader, and the timers that are coming up (LND-07, LND-11) in the projects the reader reaches. */
@Controller()
export class CompensationPaymentReadsController {
  private readonly source = new LndLandSource();
  private readonly plans = new LndPlanStore(this.source);
  private readonly payments: LndPaymentStore;
  private readonly deadlines = new LndDeadlineStore();

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(FIELD_CIPHER) cipher: FieldCipher,
  ) {
    this.payments = new LndPaymentStore(cipher);
  }

  @Get('compensation-plans/:id/payments')
  @OperationId('listCompensationPayments')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('status') status?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const now = new Date();
    const rows = await this.database.withTenant(tenant, async (tx) => {
      // A plan the caller cannot see is as if it did not exist.
      await mayActOnPlan(tx, this.plans, this.source, access, id, READ_PERMISSION, now);
      return this.payments.list(tx, id, await householdScopeUnits(tx, access, READ_PERMISSION, now), typeof status === 'string' ? status : undefined);
    });
    return { items: rows.map(paymentLineView), next_cursor: null, as_of: now.toISOString() };
  }

  @Get('land-deadlines/upcoming')
  @OperationId('listUpcomingLandDeadlines')
  async upcoming(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('within_days') withinDays?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const within = withinDays === undefined ? DEFAULT_WITHIN_DAYS : typeof withinDays === 'string' && /^\d{1,3}$/.test(withinDays) ? Number(withinDays) : -1;
    if (within < 0 || within > MAX_WITHIN_DAYS) throw new DomainError('VALIDATION_FAILED', 422, 'within_days');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, async (tx) =>
      this.deadlines.upcoming(tx, projectScope(access, DEADLINES_PERMISSION, now), await householdScopeUnits(tx, access, DEADLINES_PERMISSION, now), {
        withinDays: within,
        today: vietnamDateOf(now),
        limit: request.limit + 1,
        after: request.after === undefined ? undefined : { dueOn: request.after.code, id: request.after.id },
      }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(deadlineView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.dueOn, id: last.id }) : null, as_of: now.toISOString() };
  }
}
