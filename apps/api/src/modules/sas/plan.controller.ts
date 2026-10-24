import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ControlDatabase, PLATFORM_TENANT_ID, PlanStore } from '@machvon/db';
import type { PlanFeatureRow, PlanVersionRow, PlanVersionStatus } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { PlanDraft, PlanFeatureDraft } from '@machvon/kernel';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';

const RESOURCE_TYPE = 'plan_version';
export const PLAN_PUBLISHED_EVENT = 'sas.plan.published.v1';
const STATUSES: ReadonlySet<string> = new Set<PlanVersionStatus>(['Draft', 'Published', 'Retired']);
const MAX_PLAN_CODE = 40;

type PlanVersion = Schemas['PlanVersion'];
type PlanVersionPage = Schemas['PlanVersionPage'];
type PlanVersionDraft = Schemas['PlanVersionDraft'];

const draftOf = (body: PlanVersionDraft): PlanDraft => ({
  planCode: body.plan_code,
  name: body.name,
  billingCycles: body.billing_cycles,
  basePriceVnd: body.base_price_vnd,
  vatCategory: body.vat_category,
  legalTermsRef: body.legal_terms_ref,
  features: body.features.map(
    (feature): PlanFeatureDraft => ({
      featureCode: feature.feature_code,
      limitKind: feature.limit_kind,
      limitValue: feature.limit_value,
      meter: feature.meter,
      graceBehavior: feature.grace_behavior,
      expiredBehavior: feature.expired_behavior,
    }),
  ),
});

const featureView = (feature: PlanFeatureRow): PlanVersion['features'][number] => ({
  feature_code: feature.featureCode,
  limit_kind: feature.limitKind,
  ...(feature.limitValue === null ? {} : { limit_value: feature.limitValue }),
  ...(feature.meter === null ? {} : { meter: feature.meter }),
  grace_behavior: feature.graceBehavior,
  expired_behavior: feature.expiredBehavior,
});

const planView = (plan: PlanVersionRow): PlanVersion => ({
  id: plan.id,
  plan_code: plan.planCode,
  revision: plan.revision,
  name: plan.name,
  status: plan.status,
  billing_cycles: plan.billingCycles,
  base_price_vnd: plan.basePriceVnd,
  vat_category: plan.vatCategory,
  legal_terms_ref: plan.legalTermsRef,
  ...(plan.publishedAt === null ? {} : { published_at: plan.publishedAt.toISOString() }),
  version: plan.version,
  features: plan.features.map(featureView),
});

/** What the audit row says of a plan version: the commercial terms and the features by code, nothing of a person. */
const auditOf = (plan: PlanVersionRow): Record<string, unknown> => ({
  plan_code: plan.planCode,
  revision: plan.revision,
  base_price_vnd: plan.basePriceVnd,
  vat_category: plan.vatCategory,
  billing_cycles: plan.billingCycles,
  feature_codes: plan.features.map((feature) => feature.featureCode),
});

/**
 * The plan catalogue (ST-SAS-007, SAS-06, BR-SAS-07): control plane only, permission `system.billing.manage`. A plan version is
 * written as a draft and published once; Published is immutable and a change is the next revision, so a subscription keeps the
 * price, limits and behaviours it was sold with. The plan catalogue is shared by all tenants: its audit rows and events
 * belong to the platform tenant.
 */
@Controller('system/plans')
export class PlanController {
  constructor(
    @Inject(PlanStore) private readonly store: PlanStore,
    @Inject(ControlDatabase) private readonly control: ControlDatabase,
  ) {}

  @Get()
  @OperationId('listPlanVersions')
  async list(@Query('plan_code') planCode?: unknown, @Query('status') status?: unknown, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<PlanVersionPage> {
    const page = parsePageRequest(limit, cursor);
    if (planCode !== undefined && (typeof planCode !== 'string' || planCode.length === 0 || planCode.length > MAX_PLAN_CODE)) throw new DomainError('VALIDATION_FAILED', 422, 'plan_code');
    if (status !== undefined && (typeof status !== 'string' || !STATUSES.has(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const rows = await this.control.withTenantOf(PLATFORM_TENANT_ID, (tx) =>
      this.store.list(tx, { planCode: planCode as string | undefined, status: status as PlanVersionStatus | undefined, limit: page.limit + 1, after: page.after?.id }),
    );
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    return { items: items.map(planView), next_cursor: rows.length > page.limit && last !== undefined ? encodeCursor({ code: last.planCode, id: last.id }) : null };
  }

  @Post()
  @HttpCode(201)
  @OperationId('createPlanVersion')
  @Command({ operation: 'createPlanVersion', plane: 'control' })
  async create(@Scope() scope: CommandScope, @Body() body: PlanVersionDraft): Promise<CommandResult> {
    const plan = await this.store.createDraft(scope.tx, draftOf(body));
    await scope.audit({ action: 'plan.draft_created', resourceType: RESOURCE_TYPE, resourceId: plan.id, diff: auditOf(plan) });
    return commandResult(scope, 'DRAFT', plan.version, plan.id);
  }

  @Post(':planVersionId/publish')
  @HttpCode(200)
  @OperationId('publishPlanVersion')
  @Command({ operation: 'publishPlanVersion', plane: 'control', versioned: true })
  async publish(@Scope() scope: CommandScope, @Param('planVersionId', ParseUUIDPipe) planVersionId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    const plan = await this.store.publish(scope.tx, { planVersionId, expectedVersion: scope.expectedVersion ?? 0, publishedBy: scope.tenant.membershipId });
    await scope.audit({ action: 'plan.published', resourceType: RESOURCE_TYPE, resourceId: plan.id, reason: body.reason, diff: auditOf(plan) });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: plan.id,
      aggregateVersion: plan.version,
      type: PLAN_PUBLISHED_EVENT,
      schemaVersion: 1,
      payload: { plan_version_id: plan.id, plan_code: plan.planCode, revision: plan.revision },
      eventKey: `${RESOURCE_TYPE}:${plan.id}:published`,
    });
    return commandResult(scope, 'PUBLISHED', plan.version, plan.id);
  }
}
