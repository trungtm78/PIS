import type { PlanChangePreview, PlanChangeRow, PlanSummaryRow, SubscriptionRow } from '@machvon/db';
import type { Schemas } from '../../contract-types';

type Subscription = Schemas['Subscription'];

export const subscriptionView = (row: SubscriptionRow): Subscription => ({
  id: row.id,
  plan_version_id: row.planVersionId,
  cycle: row.cycle,
  billing_anchor: row.billingAnchor,
  status: row.status,
  started_at: row.startedAt.toISOString(),
  ...(row.trialEndsAt === null ? {} : { trial_ends_at: row.trialEndsAt.toISOString() }),
  current_period_start: row.currentPeriodStart,
  current_period_end: row.currentPeriodEnd,
  cancel_at_period_end: row.cancelAtPeriodEnd,
  ...(row.pendingPlanVersionId === null ? {} : { pending_plan_version_id: row.pendingPlanVersionId }),
  ...(row.pendingEffectiveAt === null ? {} : { pending_effective_at: row.pendingEffectiveAt.toISOString() }),
  ...(row.procurementContractRef === null ? {} : { procurement_contract_ref: row.procurementContractRef }),
  payment_terms: {
    ...(row.paymentTerms.dueDays === undefined ? {} : { due_days: row.paymentTerms.dueDays }),
    ...(row.paymentTerms.method === undefined ? {} : { method: row.paymentTerms.method }),
  },
  version: row.version,
});

export const planSummaryView = (row: PlanSummaryRow): Schemas['SubscriptionPlanSummary'] => ({
  id: row.id,
  plan_code: row.planCode,
  revision: row.revision,
  name: row.name,
  base_price_vnd: row.basePriceVnd,
});

export const changeView = (row: PlanChangeRow): Schemas['SubscriptionPlanChange'] => ({
  id: row.id,
  from_plan_version_id: row.fromPlanVersionId,
  to_plan_version_id: row.toPlanVersionId,
  effective: row.effective,
  effective_at: row.effectiveAt.toISOString(),
  proration_vnd: row.prorationVnd,
  reason: row.reason,
  requested_at: row.requestedAt.toISOString(),
  ...(row.appliedAt === null ? {} : { applied_at: row.appliedAt.toISOString() }),
  ...(row.supersededAt === null ? {} : { superseded_at: row.supersededAt.toISOString() }),
});

export const previewView = (preview: PlanChangePreview): Schemas['PlanChangePreview'] => ({
  preview_hash: preview.hash,
  proration_vnd: preview.prorationVnd,
  quota_violations: preview.violations.map((violation) => ({ feature_code: violation.featureCode, used: violation.used, new_limit: violation.newLimit })),
  effective_at: preview.effectiveAt.toISOString(),
});
