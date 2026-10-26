import { randomUUID } from 'node:crypto';
import { DomainError, MAX_ITEMS_PER_COMMAND, daysBetween, maskTail, normalizeAmount, versionConflict } from '@machvon/kernel';
import type { FieldCipher, LandTimerCode } from '@machvon/kernel';
import type { ContractScopes } from './ctr-contract-store.ts';
import { enterScope } from './lnd-household-store.ts';
import type { ScopeUnits } from './lnd-household-store.ts';
import { LndTimerRules } from './lnd-timer-rules.ts';
import { dateOf, lowerId, textOf } from './lnd-values.ts';
import { PayAdvanceStore } from './pay-advance-store.ts';
import type { AdvanceResult } from './pay-advance-store.ts';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

const TABLE = 'compensation_payment';
const MAX_TEXT = 2000;
const PAYMENT_TIMER: LandTimerCode = 'PAYMENT_30';
const RUNNING_CONSTRAINT = 'land_deadline_running_uq';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9 -]{2,38}[A-Za-z0-9]$/;
const PAYMENT_KEYS: ReadonlySet<string> = new Set(['household_id', 'amount_vnd', 'due_on', 'bank_account']);

export const COMPENSATION_PAYMENT_METHODS = ['BANK_TRANSFER', 'CASH_VOUCHER', 'TREASURY'] as const;
export type CompensationPaymentMethod = (typeof COMPENSATION_PAYMENT_METHODS)[number];
export const COMPENSATION_PAYMENT_STATUSES = ['PENDING', 'PAID', 'DEPOSITED', 'CANCELLED'] as const;
export type CompensationPaymentStatus = (typeof COMPENSATION_PAYMENT_STATUSES)[number];

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

const idText = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !UUID.test(value.trim())) throw invalid(field);
  return lowerId(value.trim());
};

/** A payment of the plan as the caller states it; the store judges it, finds what it rests on and writes the rest. */
export interface NewPayment {
  householdId: unknown;
  amountVnd: unknown;
  dueOn?: unknown;
  bankAccount?: unknown;
  /** The keys of the entry that the store does not know: an entry carries what a payment is and nothing else. */
  unknownKeys?: readonly string[];
}

export interface ScheduledPayment {
  id: string;
  householdId: string;
  paymentNo: number;
  amountVnd: string;
  dueOn: string;
  deadlineId: string;
}

export interface ScheduledPayments {
  planId: string;
  projectId: string;
  version: number;
  status: 'PAYING';
  payments: ScheduledPayment[];
  scheduledVnd: string;
  remainingVnd: string;
  ruleVersionId: string;
}

/** What paying or depositing a payment did: ids, the amount of the payment, the dates, and how the plan and its subjects moved; never a household. */
export interface SettledPayment {
  id: string;
  planId: string;
  projectId: string;
  amountVnd: string;
  advanceId: string | null;
  paidOn: string;
  dueOn: string;
  lateDays: number;
  version: number;
  planVersion: number;
  planCompleted: boolean;
  householdsMoved: number;
  parcelsMoved: number;
  /** What the command of PAY answered when the payment settled an advance (for the trail of PAY), or none. */
  recovery: AdvanceResult | null;
}

/** A payment as the screen reads it; the account is seen masked and the household by its code. */
export interface PaymentLine {
  id: string;
  planId: string;
  householdId: string;
  householdCode: string;
  ownerUnitId: string;
  paymentNo: number;
  amountVnd: string;
  dueOn: string;
  paidOn: string | null;
  method: CompensationPaymentMethod | 'DEPOSITED' | null;
  bankAccountMasked: string | null;
  treasuryTransactionId: string | null;
  advanceId: string | null;
  voucherDocumentVersionId: string | null;
  depositReason: string | null;
  lateReason: string | null;
  status: CompensationPaymentStatus;
  version: number;
}

interface PlanLock {
  id: string;
  projectId: string;
  status: string;
  version: number;
  approvedOn: string | null;
  paymentDueOn: string | null;
  grandTotal: string;
}

interface PaymentLock {
  id: string;
  planId: string;
  status: CompensationPaymentStatus;
  version: number;
  amountVnd: string;
  dueOn: string;
  householdId: string;
}

interface ParsedPayment {
  householdId: string;
  amount: bigint;
  dueOn: string | undefined;
  bankAccount: string | undefined;
}

/**
 * The payments of an approved plan to its households (ST-LND-007, LND 3.2, BR-LND-03, UAT-AC378, UAT-AC383, UAT-AC397). A payment is scheduled for a household that has an amount in the plan, within the days that
 * follow the approval, and the payments of a household add up to no more than the plan holds for it (422 `PAYMENT_EXCEEDS_PLAN`), so that all of them add up to no more than the plan holds. A payment is confirmed with its
 * voucher; one made after its day says why (422 `PAYMENT_LATE_REASON_REQUIRED`); one that settles a GPMB advance recovers it through the command of PAY in the same transaction, so that a recovery beyond what is
 * owed (422 `ADVANCE_RECOVERY_EXCEEDED`) leaves the payment unpaid. Money a household does not take is deposited with the record of the deposit. A plan is completed when everything it holds was paid or deposited.
 */
export class LndPaymentStore {
  private readonly cipher: FieldCipher;
  private readonly timers: LndTimerRules;
  private readonly advances: PayAdvanceStore;

  constructor(cipher: FieldCipher, timers: LndTimerRules = new LndTimerRules(), advances: PayAdvanceStore = new PayAdvanceStore()) {
    this.cipher = cipher;
    this.timers = timers;
    this.advances = advances;
  }

  /** The place of a sealed column of a payment, which the sealing is bound to. */
  private async tenantOf(tx: TenantTx): Promise<string> {
    const rows = await tx.query<{ tenant: string }>("select nullif(current_setting('app.tenant_id', true), '')::text as tenant");
    return (rows[0] as { tenant: string }).tenant;
  }

  /** Schedules payments on an approved plan, under the version the caller saw (409 `PLAN_STATE_INVALID`, 409 `VERSION_CONFLICT`); all of them or none. The first one moves the plan to PAYING. */
  async schedule(tx: TenantTx, input: { planId: string; expectedVersion: number; payments: readonly NewPayment[] }, actor: string, units: ScopeUnits): Promise<ScheduledPayments> {
    if (!Array.isArray(input.payments) || input.payments.length < 1 || input.payments.length > MAX_ITEMS_PER_COMMAND) throw invalid('payments');
    const parsed = input.payments.map((payment, index) => this.parse(payment, index));
    await enterScope(tx, units);
    const plan = await this.lockPlan(tx, input.planId);
    if (plan.version !== input.expectedVersion) throw versionConflict(plan.version);
    if (plan.status !== 'APPROVED' && plan.status !== 'PAYING') throw new DomainError('PLAN_STATE_INVALID', 409, 'status', { extensions: { status: plan.status } });
    const approvedOn = plan.approvedOn as string;
    const planDueOn = plan.paymentDueOn as string;
    const households = await this.households(tx, parsed.map((payment) => payment.householdId));
    const entitled = await this.entitlements(tx, plan.id, [...households.keys()]);
    const running = new Map<string, bigint>();
    const dues: string[] = [];
    parsed.forEach((payment, index) => {
      const household = households.get(payment.householdId);
      const share = entitled.get(payment.householdId);
      // A household outside the units of the caller, or of another project, or with nothing in this plan, is as if it was not on the list.
      if (household === undefined || household.projectId !== plan.projectId || share === undefined) throw invalid(`payments[${index}].household_id`);
      const due = payment.dueOn ?? planDueOn;
      if (due <= approvedOn || due > planDueOn) throw invalid(`payments[${index}].due_on`);
      dues.push(due);
      const used = (running.get(payment.householdId) ?? BigInt(share.scheduled)) + payment.amount;
      if (used > BigInt(share.entitled)) throw new DomainError('PAYMENT_EXCEEDS_PLAN', 422, `payments[${index}].amount_vnd`, { extensions: { scope: 'HOUSEHOLD', remaining_vnd: (BigInt(share.entitled) - (used - payment.amount)).toString() } });
      running.set(payment.householdId, used);
    });
    const timer = await this.timers.resolve(tx, PAYMENT_TIMER, approvedOn);
    const tenantId = await this.tenantOf(tx);
    const next = new Map<string, number>();
    const created: ScheduledPayment[] = [];
    for (const [index, payment] of parsed.entries()) {
      const household = households.get(payment.householdId) as { ownerUnitId: string; projectId: string };
      const due = dues[index] as string;
      if (!next.has(payment.householdId)) {
        const [last] = await tx.query<{ last: number | null }>('select max(payment_no)::int as last from machvon.compensation_payment where plan_id = $1::uuid and household_id = $2::uuid', [plan.id, payment.householdId]);
        next.set(payment.householdId, (last?.last ?? 0) + 1);
      }
      const paymentNo = next.get(payment.householdId) as number;
      next.set(payment.householdId, paymentNo + 1);
      const id = randomUUID();
      const place = { tenantId, table: TABLE, column: 'bank_account_enc', rowId: id };
      await tx.query(
        `insert into machvon.compensation_payment
           (tenant_id, id, plan_id, household_id, owner_unit_id, payment_no, amount_vnd, due_on, bank_account_enc, bank_account_masked, status, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::numeric, $7::date, $8, $9, 'PENDING', $10::uuid, $10::uuid, 1)`,
        [id, plan.id, payment.householdId, household.ownerUnitId, paymentNo, payment.amount.toString(), due, payment.bankAccount === undefined ? null : this.cipher.seal(place, payment.bankAccount), payment.bankAccount === undefined ? null : maskTail(payment.bankAccount, 4), actor],
      );
      const deadlineId = randomUUID();
      await withUniqueClaim(tx, { constraint: RUNNING_CONSTRAINT, code: 'PAYMENT_STATE_INVALID' }, () =>
        tx.query(
          `insert into machvon.land_deadline
             (tenant_id, id, project_id, subject_kind, subject_id, timer_code, days_applied, started_on, due_on, status, rule_version_id, version, created_by, updated_by)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, 'PAYMENT', $3::uuid, $4, $5, $6::date, $7::date, 'RUNNING', $8::uuid, 1, $9::uuid, $9::uuid)`,
          [deadlineId, plan.projectId, id, PAYMENT_TIMER, daysBetween(approvedOn, due), approvedOn, due, timer.reading.versionId, actor],
        ),
      );
      created.push({ id, householdId: payment.householdId, paymentNo, amountVnd: payment.amount.toString(), dueOn: due, deadlineId });
    }
    const version = plan.version + 1;
    await tx.query("update machvon.compensation_plan set status = 'PAYING', updated_at = now(), updated_by = $2::uuid, version = $3 where id = $1::uuid", [plan.id, actor, version]);
    // Everything the plan has scheduled, by every caller: the database refuses a payment that takes the sum over the plan (the check that the households' amounts imply, kept for any other writer).
    const scheduled = (await this.totals(tx, plan.id)).scheduled;
    return { planId: plan.id, projectId: plan.projectId, version, status: 'PAYING', payments: created, scheduledVnd: scheduled, remainingVnd: (BigInt(plan.grandTotal) - BigInt(scheduled)).toString(), ruleVersionId: timer.reading.versionId };
  }

  /**
   * Confirms a payment with its voucher (409 `PAYMENT_STATE_INVALID`, 409 `VERSION_CONFLICT`, 422 `PAYMENT_LATE_REASON_REQUIRED`, 422 `ADVANCE_RECOVERY_EXCEEDED`). A payment made after its day says why; one on time does
   * not. A payment that settles a GPMB advance of the project recovers it through the command of PAY in the same transaction, and the timer of the payment is satisfied or breached by the day it was paid.
   */
  async confirm(
    tx: TenantTx,
    input: { paymentId: string; expectedVersion: number; paidOn: string; method: string; voucherDocumentVersionId: string; treasuryTransactionId?: string | undefined; advanceId?: string | undefined; lateReason?: string | undefined; requestId: string },
    actor: string,
    units: ScopeUnits,
    today: string,
    scopes: ContractScopes,
  ): Promise<SettledPayment> {
    const paidOn = dateOf(input.paidOn, 'paid_on');
    const method = COMPENSATION_PAYMENT_METHODS.find((candidate) => candidate === input.method);
    if (method === undefined) throw invalid('method');
    const voucher = idText(input.voucherDocumentVersionId, 'voucher_document_version_id');
    const treasuryId = input.treasuryTransactionId === undefined ? null : idText(input.treasuryTransactionId, 'treasury_transaction_id');
    const advanceId = input.advanceId === undefined ? null : idText(input.advanceId, 'advance_id');
    const lateReason = input.lateReason === undefined ? null : textOf(input.lateReason, 'late_reason', 1, MAX_TEXT);
    await enterScope(tx, units);
    const { plan, payment } = await this.lockBoth(tx, input.paymentId, input.expectedVersion);
    this.assertPayable(plan, payment, paidOn, today);
    const late = paidOn > payment.dueOn;
    if (late && lateReason === null) throw new DomainError('PAYMENT_LATE_REASON_REQUIRED', 422, 'late_reason', { extensions: { due_on: payment.dueOn } });
    if (!late && lateReason !== null) throw invalid('late_reason');
    await this.assertVoucher(tx, voucher);
    if (treasuryId !== null) await this.assertTreasury(tx, treasuryId, plan.projectId);
    let recovery: AdvanceResult | null = null;
    if (advanceId !== null) {
      const advance = await this.advanceOf(tx, advanceId, plan.projectId);
      recovery = await this.advances.recordRecovery(
        tx,
        advanceId,
        advance.version,
        { amountVnd: payment.amountVnd, basis: 'COMPENSATION_PAYMENT', sourceRefId: payment.id, evidenceDocumentVersionId: voucher, requestId: input.requestId },
        actor,
        scopes,
      );
    }
    await tx.query(
      `update machvon.compensation_payment
          set status = 'PAID', paid_on = $2::date, method = $3, voucher_document_version_id = $4::uuid, treasury_transaction_id = $5::uuid, advance_id = $6::uuid, late_reason = $7,
              updated_at = now(), updated_by = $8::uuid, version = version + 1
        where id = $1::uuid`,
      [payment.id, paidOn, method, voucher, treasuryId, advanceId, lateReason, actor],
    );
    return this.settled(tx, plan, payment, paidOn, advanceId, actor, recovery);
  }

  /** Deposits the money of a payment that the household did not take, with the reason and the record of the deposit (409 `PAYMENT_STATE_INVALID`, 409 `VERSION_CONFLICT`). */
  async deposit(
    tx: TenantTx,
    input: { paymentId: string; expectedVersion: number; paidOn: string; depositReason: string; voucherDocumentVersionId: string },
    actor: string,
    units: ScopeUnits,
    today: string,
  ): Promise<SettledPayment> {
    const paidOn = dateOf(input.paidOn, 'paid_on');
    const reason = textOf(input.depositReason, 'deposit_reason', 1, MAX_TEXT);
    const voucher = idText(input.voucherDocumentVersionId, 'voucher_document_version_id');
    await enterScope(tx, units);
    const { plan, payment } = await this.lockBoth(tx, input.paymentId, input.expectedVersion);
    this.assertPayable(plan, payment, paidOn, today);
    await this.assertVoucher(tx, voucher);
    await tx.query(
      `update machvon.compensation_payment
          set status = 'DEPOSITED', paid_on = $2::date, method = 'DEPOSITED', voucher_document_version_id = $3::uuid, deposit_reason = $4, updated_at = now(), updated_by = $5::uuid, version = version + 1
        where id = $1::uuid`,
      [payment.id, paidOn, voucher, reason, actor],
    );
    return this.settled(tx, plan, payment, paidOn, null, actor, null);
  }

  /** The payments of a plan inside the units of the caller, by household code and number; a payment of another unit is not there. */
  async list(tx: TenantTx, planId: string, units: ScopeUnits, status?: string): Promise<PaymentLine[]> {
    const id = idText(planId, 'plan_id');
    const wanted = status === undefined ? null : (COMPENSATION_PAYMENT_STATUSES.find((candidate) => candidate === status) ?? this.badStatus());
    await enterScope(tx, units);
    const rows = await tx.query<{
      id: string;
      plan_id: string;
      household_id: string;
      household_code: string;
      owner_unit_id: string;
      payment_no: number;
      amount_vnd: string;
      due_on: string;
      paid_on: string | null;
      method: PaymentLine['method'];
      bank_account_masked: string | null;
      treasury_transaction_id: string | null;
      advance_id: string | null;
      voucher_document_version_id: string | null;
      deposit_reason: string | null;
      late_reason: string | null;
      status: CompensationPaymentStatus;
      version: string;
    }>(
      `select p.id, p.plan_id, p.household_id, h.household_code, p.owner_unit_id, p.payment_no, p.amount_vnd::text as amount_vnd, p.due_on::text as due_on, p.paid_on::text as paid_on, p.method,
              p.bank_account_masked, p.treasury_transaction_id, p.advance_id, p.voucher_document_version_id, p.deposit_reason, p.late_reason, p.status, p.version::text as version
         from machvon.compensation_payment p join machvon.affected_household h on h.tenant_id = p.tenant_id and h.id = p.household_id
        where p.plan_id = $1::uuid and ($2::text is null or p.status = $2)
        order by h.household_code, p.payment_no, p.id`,
      [id, wanted],
    );
    return rows.map((row) => ({
      id: row.id,
      planId: row.plan_id,
      householdId: row.household_id,
      householdCode: row.household_code,
      ownerUnitId: row.owner_unit_id,
      paymentNo: row.payment_no,
      amountVnd: row.amount_vnd,
      dueOn: row.due_on,
      paidOn: row.paid_on,
      method: row.method,
      bankAccountMasked: row.bank_account_masked,
      treasuryTransactionId: row.treasury_transaction_id,
      advanceId: row.advance_id,
      voucherDocumentVersionId: row.voucher_document_version_id,
      depositReason: row.deposit_reason,
      lateReason: row.late_reason,
      status: row.status,
      version: Number(row.version),
    }));
  }

  /** Where a payment lies, without locking it, for the check of the reach of the caller; undefined when it is not in the units of the caller. */
  async place(tx: TenantTx, paymentId: string, units: ScopeUnits): Promise<{ planId: string; projectId: string } | undefined> {
    const id = idText(paymentId, 'id');
    await enterScope(tx, units);
    const rows = await tx.query<{ plan_id: string; project_id: string }>(
      'select p.plan_id, c.project_id from machvon.compensation_payment p join machvon.compensation_plan c on c.tenant_id = p.tenant_id and c.id = p.plan_id where p.id = $1::uuid',
      [id],
    );
    const row = rows[0];
    return row === undefined ? undefined : { planId: row.plan_id, projectId: row.project_id };
  }

  private badStatus(): never {
    throw invalid('status');
  }

  private parse(payment: NewPayment, index: number): ParsedPayment {
    const at = (field: string): string => `payments[${index}].${field}`;
    if (payment.unknownKeys !== undefined) {
      const unknown = payment.unknownKeys.find((key) => !PAYMENT_KEYS.has(key));
      if (unknown !== undefined) throw invalid(at(unknown));
    }
    const householdId = idText(payment.householdId, at('household_id'));
    if (typeof payment.amountVnd !== 'string') throw invalid(at('amount_vnd'));
    const amount = normalizeAmount(payment.amountVnd, at('amount_vnd'));
    if (BigInt(amount) <= 0n) throw invalid(at('amount_vnd'));
    const dueOn = payment.dueOn === undefined ? undefined : typeof payment.dueOn === 'string' ? dateOf(payment.dueOn, at('due_on')) : this.fail(at('due_on'));
    let bankAccount: string | undefined;
    if (payment.bankAccount !== undefined) {
      if (typeof payment.bankAccount !== 'string' || !ACCOUNT.test(payment.bankAccount.trim())) throw invalid(at('bank_account'));
      bankAccount = payment.bankAccount.trim();
    }
    return { householdId, amount: BigInt(amount), dueOn, bankAccount };
  }

  private fail(field: string): never {
    throw invalid(field);
  }

  private async households(tx: TenantTx, ids: readonly string[]): Promise<Map<string, { ownerUnitId: string; projectId: string }>> {
    const rows = await tx.query<{ id: string; owner_unit_id: string; project_id: string }>('select id, owner_unit_id, project_id from machvon.affected_household where id = any($1::uuid[])', [[...new Set(ids)]]);
    return new Map(rows.map((row) => [row.id, { ownerUnitId: row.owner_unit_id, projectId: row.project_id }]));
  }

  /** What the plan holds for each household and what has been scheduled for it already (the household and its payments are in the same unit, so both are seen together). */
  private async entitlements(tx: TenantTx, planId: string, householdIds: readonly string[]): Promise<Map<string, { entitled: string; scheduled: string }>> {
    const rows = await tx.query<{ household_id: string; entitled: string; scheduled: string }>(
      `select i.household_id, sum(i.amount_vnd)::text as entitled,
              (select coalesce(sum(p.amount_vnd), 0)::text from machvon.compensation_payment p where p.plan_id = i.plan_id and p.household_id = i.household_id and p.status <> 'CANCELLED') as scheduled
         from machvon.compensation_plan_item i
        where i.plan_id = $1::uuid and i.household_id = any($2::uuid[])
        group by i.household_id, i.plan_id`,
      [planId, [...householdIds]],
    );
    return new Map(rows.map((row) => [row.household_id, { entitled: row.entitled, scheduled: row.scheduled }]));
  }

  private async totals(tx: TenantTx, planId: string): Promise<{ scheduled: string; settled: string; pending: number }> {
    const rows = await tx.query<{ scheduled_vnd: string; settled_vnd: string; pending_count: number }>('select scheduled_vnd::text as scheduled_vnd, settled_vnd::text as settled_vnd, pending_count from machvon.plan_payment_totals($1::uuid)', [planId]);
    // The function always answers one row.
    const row = rows[0] as { scheduled_vnd: string; settled_vnd: string; pending_count: number };
    return { scheduled: row.scheduled_vnd, settled: row.settled_vnd, pending: row.pending_count };
  }

  private async lockPlan(tx: TenantTx, planId: string): Promise<PlanLock> {
    const id = idText(planId, 'plan_id');
    const row = (
      await tx.query<{ id: string; project_id: string; status: string; version: string; approved_on: string | null; payment_due_on: string | null; grand_total: string }>(
        'select id, project_id, status, version::text as version, approved_on::text as approved_on, payment_due_on::text as payment_due_on, grand_total_vnd::text as grand_total from machvon.compensation_plan where id = $1::uuid for update',
        [id],
      )
    )[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { id: row.id, projectId: row.project_id, status: row.status, version: Number(row.version), approvedOn: row.approved_on, paymentDueOn: row.payment_due_on, grandTotal: row.grand_total };
  }

  /** The plan first and then the payment, as every command does, so that two payments of one plan never wait on each other in turn. */
  private async lockBoth(tx: TenantTx, paymentId: string, expectedVersion: number): Promise<{ plan: PlanLock; payment: PaymentLock }> {
    const id = idText(paymentId, 'id');
    const peek = (await tx.query<{ plan_id: string }>('select plan_id from machvon.compensation_payment where id = $1::uuid', [id]))[0];
    // A payment in another unit than the caller reaches is as if it did not exist.
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const plan = await this.lockPlan(tx, peek.plan_id);
    const row = (
      await tx.query<{ id: string; plan_id: string; status: CompensationPaymentStatus; version: string; amount_vnd: string; due_on: string; household_id: string }>(
        'select id, plan_id, status, version::text as version, amount_vnd::text as amount_vnd, due_on::text as due_on, household_id from machvon.compensation_payment where id = $1::uuid for update',
        [id],
      )
    )[0] as { id: string; plan_id: string; status: CompensationPaymentStatus; version: string; amount_vnd: string; due_on: string; household_id: string };
    // The peek found the payment and the lock of its plan keeps any other command from moving it, so the row is there.
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return { plan, payment: { id: row.id, planId: row.plan_id, status: row.status, version: Number(row.version), amountVnd: row.amount_vnd, dueOn: row.due_on, householdId: row.household_id } };
  }

  /** A payment of a plan is made while the plan is being paid: the database refuses any other (a payment exists only on a plan that was approved, and a plan is completed only when none waits). */
  private assertPayable(plan: PlanLock, payment: PaymentLock, paidOn: string, today: string): void {
    if (payment.status !== 'PENDING') throw new DomainError('PAYMENT_STATE_INVALID', 409, 'status', { extensions: { status: payment.status } });
    // The day of the payment has come, and is not before the plan was approved.
    if (paidOn > today || paidOn < (plan.approvedOn as string)) throw invalid('paid_on');
  }

  private async assertVoucher(tx: TenantTx, documentVersionId: string): Promise<void> {
    const rows = await tx.query<{ scan_status: string }>('select scan_status from machvon.document_version where id = $1::uuid', [documentVersionId]);
    if (rows[0] === undefined) throw invalid('voucher_document_version_id');
    if (rows[0].scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422, 'voucher_document_version_id');
  }

  /** A treasury transaction of the project of the plan, which a payment names as the transfer that made it. */
  private async assertTreasury(tx: TenantTx, treasuryId: string, projectId: string): Promise<void> {
    const rows = await tx.query<{ project_id: string }>('select project_id from machvon.treasury_transaction where id = $1::uuid', [treasuryId]);
    if (rows[0] === undefined || rows[0].project_id !== projectId) throw invalid('treasury_transaction_id');
  }

  /** The advance a payment settles: of a contract of the project of the plan, at the version it has now (the recovery is judged and written by PAY). */
  private async advanceOf(tx: TenantTx, advanceId: string, projectId: string): Promise<{ version: number }> {
    const rows = await tx.query<{ version: string; project_id: string }>(
      'select a.version::text as version, c.project_id from machvon.contract_advance a join machvon.contract c on c.tenant_id = a.tenant_id and c.id = a.contract_id where a.id = $1::uuid',
      [advanceId],
    );
    const row = rows[0];
    if (row === undefined || row.project_id !== projectId) throw invalid('advance_id');
    return { version: Number(row.version) };
  }

  /** What follows a payment: the timer of it ends (satisfied on the day when it was on time, breached when it was late), the households and parcels that are paid in full move, and a plan that was paid in full is completed. */
  private async settled(tx: TenantTx, plan: PlanLock, payment: PaymentLock, paidOn: string, advanceId: string | null, actor: string, recovery: AdvanceResult | null): Promise<SettledPayment> {
    const late = paidOn > payment.dueOn;
    await tx.query(
      `update machvon.land_deadline
          set status = $2, satisfied_on = $3::date, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where subject_kind = 'PAYMENT' and subject_id = $1::uuid and status = 'RUNNING'`,
      [payment.id, late ? 'BREACHED' : 'SATISFIED', late ? null : paidOn, actor],
    );
    const moved = (await tx.query<{ households_moved: number; parcels_moved: number }>('select households_moved, parcels_moved from machvon.advance_paid_subjects($1::uuid, $2::uuid)', [plan.id, actor]))[0] as {
      households_moved: number;
      parcels_moved: number;
    };
    const totals = await this.totals(tx, plan.id);
    const completed = totals.pending === 0 && BigInt(totals.settled) >= BigInt(plan.grandTotal);
    const planVersion = plan.version + 1;
    if (completed) await tx.query("update machvon.compensation_plan set status = 'COMPLETED', updated_at = now(), updated_by = $2::uuid, version = $3 where id = $1::uuid", [plan.id, actor, planVersion]);
    else await tx.query('update machvon.compensation_plan set updated_at = now(), updated_by = $2::uuid, version = $3 where id = $1::uuid', [plan.id, actor, planVersion]);
    return {
      id: payment.id,
      planId: plan.id,
      projectId: plan.projectId,
      amountVnd: payment.amountVnd,
      advanceId,
      paidOn,
      dueOn: payment.dueOn,
      lateDays: late ? daysBetween(payment.dueOn, paidOn) : 0,
      version: payment.version + 1,
      planVersion,
      planCompleted: completed,
      householdsMoved: moved.households_moved,
      parcelsMoved: moved.parcels_moved,
      recovery,
    };
  }
}
