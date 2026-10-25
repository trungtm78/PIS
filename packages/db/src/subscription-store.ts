import { DomainError, addDays, billingPeriod, billingPeriodAt, planChangeHash, prorationOf, quotaViolations, versionConflict } from '@machvon/kernel';
import type { PlanBillingCycle, PlanChangeEffective, PlanChangeFacts, QuotaViolation } from '@machvon/kernel';
import { recordEntitlementVersion } from './entitlement-store.ts';
import { MemberStore } from './member-store.ts';
import { TenantBootstrapStore } from './tenant-bootstrap-store.ts';
import type { TenantTx } from './tenant-database.ts';

export type SubscriptionStatus = 'Trialing' | 'Active' | 'PastDue' | 'Paused' | 'Cancelled' | 'Expired';
/** The states in which a tenant has a subscription (the unique key of V002 allows one such row per tenant). */
export const LIVE_STATUSES: readonly SubscriptionStatus[] = ['Trialing', 'Active', 'PastDue', 'Paused'];

export type PaymentMethod = 'BANK_TRANSFER' | 'TREASURY_TRANSFER' | 'GATEWAY';

export interface SubscriptionRow {
  id: string;
  planVersionId: string;
  cycle: PlanBillingCycle;
  billingAnchor: string;
  status: SubscriptionStatus;
  startedAt: Date;
  trialEndsAt: Date | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  pendingPlanVersionId: string | null;
  pendingEffectiveAt: Date | null;
  procurementContractRef: string | null;
  paymentTerms: { dueDays?: number; method?: PaymentMethod };
  version: number;
}

export interface PlanChangeRow {
  id: string;
  subscriptionId: string;
  fromPlanVersionId: string;
  toPlanVersionId: string;
  effective: PlanChangeEffective;
  effectiveAt: Date;
  prorationVnd: string;
  reason: string;
  requestedAt: Date;
  appliedAt: Date | null;
  supersededAt: Date | null;
}

/** What the control plane shows of a plan next to a subscription. */
export interface PlanSummaryRow {
  id: string;
  planCode: string;
  revision: number;
  name: string;
  basePriceVnd: string;
}

export interface CreateSubscriptionInput {
  planVersionId: string;
  cycle: PlanBillingCycle;
  /** The first day of the first period, `YYYY-MM-DD`. */
  billingAnchor: string;
  trialDays: number;
  procurementContractRef?: string | undefined;
  paymentTerms: { dueDays: number; method: PaymentMethod };
  now: Date;
}

export interface PlanChangeRequest {
  subscriptionId: string;
  targetPlanVersionId: string;
  effective: PlanChangeEffective;
  now: Date;
}

export interface PlanChangePreview {
  subscription: SubscriptionRow;
  facts: PlanChangeFacts;
  hash: string;
  prorationVnd: string;
  violations: QuotaViolation[];
  effectiveAt: Date;
  /** The prices of the plan the subscription is on and of the one it would move to, in whole VND. */
  fromPriceVnd: string;
  toPriceVnd: string;
}

export interface ApplyPlanChangeInput extends PlanChangeRequest {
  previewHash: string;
  reason: string;
  expectedVersion: number;
  requestedBy: string;
}

export interface CycleOutcome {
  trialsEnded: number;
  plansApplied: number;
  periodsRolled: number;
  cancelled: number;
}

interface SubscriptionDbRow {
  id: string;
  plan_version_id: string;
  cycle: PlanBillingCycle;
  billing_anchor: string;
  status: SubscriptionStatus;
  started_at: Date;
  trial_ends_at: Date | null;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  pending_plan_version_id: string | null;
  pending_effective_at: Date | null;
  procurement_contract_ref: string | null;
  payment_terms: { due_days?: number; method?: PaymentMethod };
  version: string;
}

interface PlanDbRow {
  id: string;
  status: string;
  billing_cycles: PlanBillingCycle[];
  base_price_vnd: string;
}

const COLUMNS = `id, plan_version_id, cycle, billing_anchor::text as billing_anchor, status, started_at, trial_ends_at, current_period_start::text as current_period_start,
  current_period_end::text as current_period_end, cancel_at_period_end, pending_plan_version_id, pending_effective_at, procurement_contract_ref, payment_terms, version::text as version`;
const LIVE_SQL = `select ${COLUMNS} from machvon.subscription where status = any($1::text[]) order by started_at desc, id limit 1`;
const ONE_SQL = `select ${COLUMNS} from machvon.subscription where id = $1::uuid`;
const LOCK_ONE_SQL = `${ONE_SQL} for update`;
const LIST_SQL = `select ${COLUMNS} from machvon.subscription s
  where ($1::uuid is null or (s.started_at, s.id) < (select a.started_at, a.id from machvon.subscription a where a.id = $1::uuid))
  order by s.started_at desc, s.id desc limit $2`;
const LOCK_TENANT_SQL = "select pg_advisory_xact_lock(hashtextextended('subscription:' || current_setting('app.tenant_id'), 0))";
const PLAN_SQL = 'select id, status, billing_cycles, base_price_vnd::text as base_price_vnd from machvon.product_plan_version where id = $1::uuid';
const INSERT_SQL = `insert into machvon.subscription
    (tenant_id, id, plan_version_id, cycle, billing_anchor, status, payment_terms, started_at, trial_ends_at, current_period_start, current_period_end, procurement_contract_ref)
  values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3::date, $4, $5::jsonb, $6, $7, $8::date, $9::date, $10)
  returning ${COLUMNS}`;
const SUMMARIES_SQL = 'select id, plan_code, revision, name, base_price_vnd::text as base_price_vnd from machvon.product_plan_version where id = any($1::uuid[])';
const LATEST_HASH_SQL = 'select entitlements_hash from machvon.entitlement_version order by version_no desc limit 1';
const SET_PLAN_SQL = `update machvon.subscription
  set plan_version_id = $2::uuid, status = case when status = 'Trialing' then 'Active' else status end, pending_plan_version_id = null, pending_effective_at = null, version = version + 1
  where id = $1::uuid returning ${COLUMNS}`;
const SET_PENDING_SQL = `update machvon.subscription set pending_plan_version_id = $2::uuid, pending_effective_at = $3, version = version + 1 where id = $1::uuid returning ${COLUMNS}`;
const SUPERSEDE_SQL = 'update machvon.subscription_plan_change set superseded_at = $2 where subscription_id = $1::uuid and applied_at is null and superseded_at is null';
const INSERT_CHANGE_SQL = `insert into machvon.subscription_plan_change
    (tenant_id, id, subscription_id, from_plan_version_id, to_plan_version_id, effective, effective_at, proration_vnd, preview_hash, reason, requested_by, applied_at)
  values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7, $8, $9::uuid, $10)`;
const CHANGE_COLUMNS = `id, subscription_id, from_plan_version_id, to_plan_version_id, effective, effective_at, trim_scale(proration_vnd)::text as proration_vnd, reason, requested_at, applied_at, superseded_at`;
const CHANGES_SQL = `select ${CHANGE_COLUMNS} from machvon.subscription_plan_change where subscription_id = $1::uuid order by requested_at desc, id desc limit $2`;
const MARK_APPLIED_SQL = `update machvon.subscription_plan_change set applied_at = $3 where subscription_id = $1::uuid and to_plan_version_id = $2::uuid and effective = 'NEXT_CYCLE' and applied_at is null and superseded_at is null`;
const CANCEL_NOW_SQL = `update machvon.subscription set status = 'Cancelled', cancel_at_period_end = false, version = version + 1 where id = $1::uuid returning ${COLUMNS}`;
const CANCEL_AT_END_SQL = `update machvon.subscription set cancel_at_period_end = true, version = version + 1 where id = $1::uuid returning ${COLUMNS}`;
const DUE_SQL = `select ${COLUMNS} from machvon.subscription where status = any($1::text[]) order by id for update`;
const SET_ACTIVE_SQL = `update machvon.subscription set status = 'Active', version = version + 1 where id = $1::uuid`;
const SET_PERIOD_SQL = 'update machvon.subscription set current_period_start = $2::date, current_period_end = $3::date, version = version + 1 where id = $1::uuid';
const SET_CANCELLED_SQL = `update machvon.subscription set status = 'Cancelled', version = version + 1 where id = $1::uuid`;

const todayOf = (now: Date): string => now.toISOString().slice(0, 10);
const startOfDay = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

const subscriptionOf = (row: SubscriptionDbRow): SubscriptionRow => ({
  id: row.id,
  planVersionId: row.plan_version_id,
  cycle: row.cycle,
  billingAnchor: row.billing_anchor,
  status: row.status,
  startedAt: row.started_at,
  trialEndsAt: row.trial_ends_at,
  currentPeriodStart: row.current_period_start,
  currentPeriodEnd: row.current_period_end,
  cancelAtPeriodEnd: row.cancel_at_period_end,
  pendingPlanVersionId: row.pending_plan_version_id,
  pendingEffectiveAt: row.pending_effective_at,
  procurementContractRef: row.procurement_contract_ref,
  paymentTerms: {
    ...(row.payment_terms.due_days === undefined ? {} : { dueDays: row.payment_terms.due_days }),
    ...(row.payment_terms.method === undefined ? {} : { method: row.payment_terms.method }),
  },
  version: Number(row.version),
});

const isLive = (row: SubscriptionRow): boolean => LIVE_STATUSES.includes(row.status);
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/**
 * The subscription of a tenant and its plan changes (ST-SAS-008, SAS.md BR-SAS-08). Every method runs in the transaction it is given, which acts as the
 * tenant (the control plane acts as the tenant of the subscription; the cycle job runs as the tenant). A tenant has one live subscription; its period is
 * counted from the billing anchor; a change of plan is previewed first and applied only against that preview, which is kept as the record of what the
 * customer was charged and why.
 */
export class SubscriptionStore {
  private readonly bootstrap = new TenantBootstrapStore();
  private readonly members = new MemberStore();

  /** The live subscription of the tenant, or undefined. */
  async live(tx: TenantTx): Promise<SubscriptionRow | undefined> {
    const [row] = await tx.query<SubscriptionDbRow>(LIVE_SQL, [[...LIVE_STATUSES]]);
    return row === undefined ? undefined : subscriptionOf(row);
  }

  async find(tx: TenantTx, id: string): Promise<SubscriptionRow | undefined> {
    const [row] = await tx.query<SubscriptionDbRow>(ONE_SQL, [id]);
    return row === undefined ? undefined : subscriptionOf(row);
  }

  /** The subscriptions of the tenant, the latest started first; keyset by the last one of the page before. */
  async list(tx: TenantTx, input: { limit: number; after?: string | undefined }): Promise<SubscriptionRow[]> {
    return (await tx.query<SubscriptionDbRow>(LIST_SQL, [input.after ?? null, input.limit])).map(subscriptionOf);
  }

  /** The plans by id, for what shows a subscription next to the plan it is on (the plan catalogue is a control-plane table). */
  async plans(tx: TenantTx, ids: readonly string[]): Promise<Map<string, PlanSummaryRow>> {
    const rows = await tx.query<{ id: string; plan_code: string; revision: number; name: string; base_price_vnd: string }>(SUMMARIES_SQL, [[...new Set(ids)]]);
    return new Map(rows.map((row) => [row.id, { id: row.id, planCode: row.plan_code, revision: row.revision, name: row.name, basePriceVnd: row.base_price_vnd }]));
  }

  /** The plan changes of a subscription, the latest first. */
  async changes(tx: TenantTx, subscriptionId: string, limit: number): Promise<PlanChangeRow[]> {
    const rows = await tx.query<{
      id: string;
      subscription_id: string;
      from_plan_version_id: string;
      to_plan_version_id: string;
      effective: PlanChangeEffective;
      effective_at: Date;
      proration_vnd: string;
      reason: string;
      requested_at: Date;
      applied_at: Date | null;
      superseded_at: Date | null;
    }>(CHANGES_SQL, [subscriptionId, limit]);
    return rows.map((row) => ({
      id: row.id,
      subscriptionId: row.subscription_id,
      fromPlanVersionId: row.from_plan_version_id,
      toPlanVersionId: row.to_plan_version_id,
      effective: row.effective,
      effectiveAt: row.effective_at,
      prorationVnd: row.proration_vnd,
      reason: row.reason,
      requestedAt: row.requested_at,
      appliedAt: row.applied_at,
      supersededAt: row.superseded_at,
    }));
  }

  /**
   * Starts a subscription on a published plan (SAS-07): a trial when `trialDays` is above zero, an Active subscription otherwise, and the entitlements of
   * the plan as a new version. 409 SUBSCRIPTION_EXISTS while the tenant has a live one, 409 PLAN_NOT_PUBLISHED for a plan that is not.
   */
  async create(tx: TenantTx, input: CreateSubscriptionInput): Promise<SubscriptionRow> {
    await tx.query(LOCK_TENANT_SQL);
    if ((await this.live(tx)) !== undefined) throw new DomainError('SUBSCRIPTION_EXISTS', 409);
    const plan = await this.planOf(tx, input.planVersionId, 'plan_version_id');
    if (!plan.billing_cycles.includes(input.cycle)) throw invalid('cycle');
    const today = todayOf(input.now);
    const period = billingPeriodAt(input.billingAnchor, input.cycle, today) ?? billingPeriod(input.billingAnchor, input.cycle, 0);
    const trialEnds = input.trialDays > 0 ? startOfDay(addDays(input.billingAnchor, input.trialDays)) : null;
    const [row] = await tx.query<SubscriptionDbRow>(INSERT_SQL, [
      input.planVersionId,
      input.cycle,
      input.billingAnchor,
      trialEnds === null ? 'Active' : 'Trialing',
      JSON.stringify({ due_days: input.paymentTerms.dueDays, method: input.paymentTerms.method }),
      input.now,
      trialEnds,
      period.start,
      period.end,
      input.procurementContractRef ?? null,
    ]);
    if (row === undefined) throw new Error('subscription insert returned no row');
    await recordEntitlementVersion(tx, { cause: 'SUBSCRIPTION_CHANGE', planVersionId: input.planVersionId, features: await this.bootstrap.planFeatures(tx, input.planVersionId), subscriptionId: row.id });
    return subscriptionOf(row);
  }

  /**
   * What a plan change would do and the token that ties its application to that answer: the proration of an upgrade now (BR-SAS-08), nothing for a change at
   * the next cycle, the quotas of the new plan that the tenant is already over, and the day the plan takes effect. A change now is only an upgrade (a plan
   * that costs more); a downgrade or a change to a plan of the same price waits for the next cycle and gives no money back.
   */
  async preview(tx: TenantTx, request: PlanChangeRequest): Promise<PlanChangePreview> {
    const [row] = await tx.query<SubscriptionDbRow>(ONE_SQL, [request.subscriptionId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return this.previewOf(tx, subscriptionOf(row), request);
  }

  /**
   * Applies a plan change that was previewed. The subscription is locked, the version the caller saw must be current (409 VERSION_CONFLICT) and the preview
   * is made again on what is there now: if its token is not the one given the answer is 409 PREVIEW_STALE and nothing changes. A change now moves the
   * subscription to the plan and records the entitlements of the new plan; a change at the next cycle only sets the plan and the day it will take effect.
   */
  async applyChange(tx: TenantTx, input: ApplyPlanChangeInput): Promise<{ subscription: SubscriptionRow; prorationVnd: string }> {
    const [locked] = await tx.query<SubscriptionDbRow>(LOCK_ONE_SQL, [input.subscriptionId]);
    if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const current = subscriptionOf(locked);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    const preview = await this.previewOf(tx, current, input);
    if (preview.hash !== input.previewHash) throw new DomainError('PREVIEW_STALE', 409);
    const applied = input.effective === 'NOW';
    // A change that was waiting for its day is replaced by this one, whichever way this one takes effect.
    await tx.query(SUPERSEDE_SQL, [current.id, input.now]);
    await tx.query(INSERT_CHANGE_SQL, [
      current.id,
      current.planVersionId,
      input.targetPlanVersionId,
      input.effective,
      preview.effectiveAt,
      preview.prorationVnd,
      preview.hash,
      input.reason.trim(),
      input.requestedBy,
      applied ? input.now : null,
    ]);
    const [updated] = applied
      ? await tx.query<SubscriptionDbRow>(SET_PLAN_SQL, [current.id, input.targetPlanVersionId])
      : await tx.query<SubscriptionDbRow>(SET_PENDING_SQL, [current.id, input.targetPlanVersionId, preview.effectiveAt]);
    if (updated === undefined) throw new Error('subscription update returned no row');
    if (applied) {
      await recordEntitlementVersion(tx, { cause: 'SUBSCRIPTION_CHANGE', planVersionId: input.targetPlanVersionId, features: await this.bootstrap.planFeatures(tx, input.targetPlanVersionId), subscriptionId: current.id });
    }
    return { subscription: subscriptionOf(updated), prorationVnd: preview.prorationVnd };
  }

  /**
   * Cancels a subscription (SAS-07): one still on trial ends at once (nothing was paid for), any other stays until the end of the period that was paid for
   * and ends then (the cycle job). 409 SUBSCRIPTION_STATE_INVALID for one that is over or that already is set to end.
   */
  async cancel(tx: TenantTx, subscriptionId: string, expectedVersion: number): Promise<SubscriptionRow> {
    const [locked] = await tx.query<SubscriptionDbRow>(LOCK_ONE_SQL, [subscriptionId]);
    if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const current = subscriptionOf(locked);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    if (!isLive(current) || current.cancelAtPeriodEnd) throw new DomainError('SUBSCRIPTION_STATE_INVALID', 409);
    const [row] = await tx.query<SubscriptionDbRow>(current.status === 'Trialing' ? CANCEL_NOW_SQL : CANCEL_AT_END_SQL, [current.id]);
    if (row === undefined) throw new Error('subscription update returned no row');
    return subscriptionOf(row);
  }

  /**
   * What the clock does to the subscriptions of the tenant (the cycle job): a trial that has ended becomes Active, a plan that waited for its day takes
   * effect (with its entitlements), a period that has passed gives way to the next, and a subscription set to end ends with its period. Each step is
   * repeated safely: what was done once has nothing left to do.
   */
  async runCycle(tx: TenantTx, now: Date): Promise<CycleOutcome> {
    const outcome: CycleOutcome = { trialsEnded: 0, plansApplied: 0, periodsRolled: 0, cancelled: 0 };
    const today = todayOf(now);
    const rows = await tx.query<SubscriptionDbRow>(DUE_SQL, [[...LIVE_STATUSES]]);
    for (const raw of rows) {
      let current = subscriptionOf(raw);
      if (current.status === 'Trialing' && current.trialEndsAt !== null && current.trialEndsAt.getTime() <= now.getTime()) {
        await tx.query(SET_ACTIVE_SQL, [current.id]);
        outcome.trialsEnded += 1;
        current = { ...current, status: 'Active', version: current.version + 1 };
      }
      if (current.pendingPlanVersionId !== null && current.pendingEffectiveAt !== null && current.pendingEffectiveAt.getTime() <= now.getTime()) {
        await tx.query(SET_PLAN_SQL, [current.id, current.pendingPlanVersionId]);
        await tx.query(MARK_APPLIED_SQL, [current.id, current.pendingPlanVersionId, now]);
        await recordEntitlementVersion(tx, { cause: 'SUBSCRIPTION_CHANGE', planVersionId: current.pendingPlanVersionId, features: await this.bootstrap.planFeatures(tx, current.pendingPlanVersionId), subscriptionId: current.id });
        outcome.plansApplied += 1;
      }
      if (today > current.currentPeriodEnd) {
        if (current.cancelAtPeriodEnd) {
          await tx.query(SET_CANCELLED_SQL, [current.id]);
          outcome.cancelled += 1;
          continue;
        }
        const period = billingPeriodAt(current.billingAnchor, current.cycle, today);
        if (period !== undefined) {
          await tx.query(SET_PERIOD_SQL, [current.id, period.start, period.end]);
          outcome.periodsRolled += 1;
        }
      }
    }
    return outcome;
  }

  private async planOf(tx: TenantTx, planVersionId: string, field: string): Promise<PlanDbRow> {
    const [plan] = await tx.query<PlanDbRow>(PLAN_SQL, [planVersionId]);
    if (plan === undefined) throw invalid(field);
    if (plan.status !== 'Published') throw new DomainError('PLAN_NOT_PUBLISHED', 409);
    return plan;
  }

  private async previewOf(tx: TenantTx, subscription: SubscriptionRow, request: PlanChangeRequest): Promise<PlanChangePreview> {
    if (!isLive(subscription)) throw new DomainError('SUBSCRIPTION_STATE_INVALID', 409);
    const target = await this.planOf(tx, request.targetPlanVersionId, 'target_plan_version_id');
    if (target.id === subscription.planVersionId) throw invalid('target_plan_version_id');
    if (!target.billing_cycles.includes(subscription.cycle)) throw invalid('target_plan_version_id');
    const [from] = await tx.query<PlanDbRow>(PLAN_SQL, [subscription.planVersionId]);
    if (from === undefined) throw new Error('the plan of the subscription was not found');
    const upgrade = BigInt(target.base_price_vnd) > BigInt(from.base_price_vnd);
    if (request.effective === 'NOW' && !upgrade) throw invalid('effective');

    const today = todayOf(request.now);
    const period = { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd };
    const proration = request.effective === 'NOW' ? prorationOf({ oldPriceVnd: from.base_price_vnd, newPriceVnd: target.base_price_vnd, today, period }).amountVnd : '0';
    const effectiveAt = request.effective === 'NOW' ? startOfDay(today) : startOfDay(addDays(period.end, 1));
    const used = new Map<string, number>([['member.seats', (await this.members.seatsInUse(tx)).staff]]);
    const violations = quotaViolations(await this.bootstrap.planFeatures(tx, target.id), used);
    const [latest] = await tx.query<{ entitlements_hash: string }>(LATEST_HASH_SQL);
    const facts: PlanChangeFacts = {
      subscriptionId: subscription.id,
      subscriptionVersion: subscription.version,
      fromPlanVersionId: subscription.planVersionId,
      targetPlanVersionId: target.id,
      effective: request.effective,
      today,
      periodStart: period.start,
      periodEnd: period.end,
      prorationVnd: proration,
      effectiveAt: effectiveAt.toISOString(),
      violations,
      entitlementsHash: latest?.entitlements_hash ?? '',
    };
    return { subscription, facts, hash: planChangeHash(facts), prorationVnd: proration, violations, effectiveAt, fromPriceVnd: from.base_price_vnd, toPriceVnd: target.base_price_vnd };
  }
}
