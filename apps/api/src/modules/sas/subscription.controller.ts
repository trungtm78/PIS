import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ControlDatabase, SubscriptionStore, actingAsTenant, tenantOfSubscription } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { changeView, planSummaryView, previewView, subscriptionView } from './subscription-view';

const RESOURCE_TYPE = 'subscription';
/** How many of the latest plan changes the control plane shows beside the subscription. */
export const RECENT_CHANGES = 10;

/**
 * The subscription of a tenant on the control plane (ST-SAS-008, SAS-07 and SAS-08, SAS.md BR-SAS-08): a Billing Operator or a System Admin starts it, previews a
 * change of plan, applies the change against that preview and cancels. The commands act as the tenant of the subscription while they write, audit and emit, so every
 * row belongs to that tenant; the plan catalogue they read is a control-plane table. Money is whole VND and the proration rounds down.
 */
@Controller('system')
export class SubscriptionController {
  constructor(
    @Inject(SubscriptionStore) private readonly store: SubscriptionStore,
    @Inject(ControlDatabase) private readonly control: ControlDatabase,
  ) {}

  @Get('tenants/:tenantId/subscription')
  @OperationId('getTenantSubscription')
  async ofTenant(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<Schemas['TenantSubscription']> {
    const known = await this.control.withControl((tx) => tx.query<{ id: string }>('select id from machvon.tenant where id = $1::uuid', [tenantId]));
    if (known.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return this.control.withTenantOf(tenantId, async (tx) => {
      const live = await this.store.live(tx);
      if (live === undefined) return { changes: [] };
      const [plans, changes] = [await this.store.plans(tx, [live.planVersionId, ...(live.pendingPlanVersionId === null ? [] : [live.pendingPlanVersionId])]), await this.store.changes(tx, live.id, RECENT_CHANGES)];
      const [plan, pending] = [plans.get(live.planVersionId), live.pendingPlanVersionId === null ? undefined : plans.get(live.pendingPlanVersionId)];
      return {
        subscription: subscriptionView(live),
        ...(plan === undefined ? {} : { plan: planSummaryView(plan) }),
        ...(pending === undefined ? {} : { pending_plan: planSummaryView(pending) }),
        changes: changes.map(changeView),
      };
    });
  }

  @Post('tenants/:tenantId/subscriptions')
  @HttpCode(201)
  @OperationId('createSubscription')
  @Command({ operation: 'createSubscription', plane: 'control' })
  async create(@Scope() scope: CommandScope, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() body: Schemas['SubscriptionCreate']): Promise<CommandResult> {
    return actingAsTenant(scope.tx, tenantId, scope.tenant.tenantId, async () => {
      await assertTenantActive(scope.tx, tenantId);
      const created = await this.store.create(scope.tx, {
        planVersionId: body.plan_version_id,
        cycle: body.cycle,
        billingAnchor: body.billing_anchor,
        trialDays: body.trial_days ?? 0,
        procurementContractRef: body.procurement_contract_ref,
        paymentTerms: { dueDays: body.payment_terms.due_days, method: body.payment_terms.method },
        now: new Date(),
      });
      await scope.audit({
        action: 'subscription.created',
        resourceType: RESOURCE_TYPE,
        resourceId: created.id,
        diff: { plan_version_id: created.planVersionId, cycle: created.cycle, status: created.status, billing_anchor: created.billingAnchor, trial_days: body.trial_days ?? 0 },
      });
      return commandResult(scope, created.status === 'Trialing' ? 'TRIALING' : 'ACTIVE', created.version, created.id);
    });
  }

  @Post('subscriptions/:subscriptionId/plan-change-previews')
  @HttpCode(200)
  @OperationId('previewPlanChange')
  @Command({ operation: 'previewPlanChange', plane: 'control' })
  async preview(@Scope() scope: CommandScope, @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string, @Body() body: Schemas['PlanChange']): Promise<Schemas['PlanChangePreview']> {
    return this.inTenantOf(scope, subscriptionId, async () => {
      const preview = await this.store.preview(scope.tx, { subscriptionId, targetPlanVersionId: body.target_plan_version_id, effective: body.effective, now: new Date() });
      await scope.audit({
        action: 'subscription.plan_change_previewed',
        resourceType: RESOURCE_TYPE,
        resourceId: subscriptionId,
        diff: { target_plan_version_id: body.target_plan_version_id, effective: body.effective, proration_vnd: preview.prorationVnd, quota_violations: preview.violations.length },
      });
      return previewView(preview);
    });
  }

  @Post('subscriptions/:subscriptionId/plan-change')
  @HttpCode(200)
  @OperationId('changeSubscriptionPlan')
  @Command({ operation: 'changeSubscriptionPlan', plane: 'control', versioned: true })
  async change(@Scope() scope: CommandScope, @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string, @Body() body: Schemas['PlanChangeApply']): Promise<CommandResult> {
    return this.inTenantOf(scope, subscriptionId, async () => {
      const changed = await this.store.applyChange(scope.tx, {
        subscriptionId,
        targetPlanVersionId: body.target_plan_version_id,
        effective: body.effective,
        previewHash: body.preview_hash,
        reason: body.reason,
        expectedVersion: scope.expectedVersion ?? 0,
        requestedBy: scope.tenant.membershipId,
        now: new Date(),
      });
      await scope.audit({
        action: 'subscription.plan_changed',
        resourceType: RESOURCE_TYPE,
        resourceId: subscriptionId,
        reason: body.reason,
        diff: { target_plan_version_id: body.target_plan_version_id, effective: body.effective, proration_vnd: changed.prorationVnd, preview_hash: body.preview_hash },
      });
      return commandResult(scope, body.effective === 'NOW' ? 'CHANGED' : 'CHANGE_SCHEDULED', changed.subscription.version, subscriptionId);
    });
  }

  @Post('subscriptions/:subscriptionId/cancel')
  @HttpCode(200)
  @OperationId('cancelSubscription')
  @Command({ operation: 'cancelSubscription', plane: 'control', versioned: true })
  async cancel(@Scope() scope: CommandScope, @Param('subscriptionId', ParseUUIDPipe) subscriptionId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    return this.inTenantOf(scope, subscriptionId, async () => {
      const cancelled = await this.store.cancel(scope.tx, subscriptionId, scope.expectedVersion ?? 0);
      await scope.audit({
        action: 'subscription.cancelled',
        resourceType: RESOURCE_TYPE,
        resourceId: subscriptionId,
        reason: body.reason,
        diff: { status: cancelled.status, cancel_at_period_end: cancelled.cancelAtPeriodEnd },
      });
      return commandResult(scope, cancelled.status === 'Cancelled' ? 'CANCELLED' : 'CANCEL_AT_PERIOD_END', cancelled.version, subscriptionId);
    });
  }

  // The path names only the subscription: its tenant is found first, and the work runs as that tenant (404 when no tenant has the subscription).
  private async inTenantOf<T>(scope: CommandScope, subscriptionId: string, work: () => Promise<T>): Promise<T> {
    const tenantId = await tenantOfSubscription(scope.tx, subscriptionId);
    if (tenantId === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return actingAsTenant(scope.tx, tenantId, scope.tenant.tenantId, work);
  }
}

/** A subscription is started for a tenant that is working: not one still being provisioned, suspended, offboarding or archived. */
async function assertTenantActive(tx: TenantTx, tenantId: string): Promise<void> {
  const [tenant] = await tx.query<{ status: string }>('select status from machvon.tenant where id = $1::uuid', [tenantId]);
  if (tenant?.status !== 'Active') throw new DomainError('TENANT_STATE_INVALID', 409);
}
