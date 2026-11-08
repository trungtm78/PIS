import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidWorkflowReads, TenantDatabase, VendorRiskStore } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, RiskTier, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { figureDto, riskDto } from './vendor-risk-view';
import { policyDto, todayOf } from './vendor-view';
import type { Caller } from './vendor-view';

const CLASSIFICATION = 'CONFIDENTIAL';
const RESOURCE = 'vendor_risk_assessment';
const TIERS: readonly string[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const need = (access: EffectiveAccess, permission: string): void => {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
};

const flag = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') throw new DomainError('VALIDATION_FAILED', 422, field);
  return value === 'true';
};

const text = (value: unknown, field: string, max: number): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
};

/**
 * The commands of the risk grade of a contractor (VND-11; docs/vendor-controls-risk-performance.md). Assessing computes the grade from what the other controls found and stores it as a proposal; deciding confirms or
 * rejects it, by a person other than the assessor when the grade needs a dual check (the rule says from which tier). Each runs in one transaction with its audit row and its outbox event (ids and codes only); the
 * register belongs to the whole tenant, so each needs its permission through a grant on the whole tenant. The grade never decides whether a contractor may bid.
 */
@Controller()
export class VendorRiskController {
  private readonly risk = new VendorRiskStore();

  @Post('vendor/contractors/:id/risk-assessments')
  @HttpCode(200)
  @OperationId('assessVendorRisk')
  @Command({ operation: 'assessVendorRisk' })
  async assess(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    need(access, PERMISSIONS.assessVendorRisk);
    const now = new Date();
    const row = await this.risk.assess(scope.tx, id, todayOf(now), scope.tenant.membershipId);
    await scope.audit({ action: 'vnd.risk_assessed', resourceType: RESOURCE, resourceId: row.id, classification: CLASSIFICATION, diff: { contractor_id: id, tier: row.tier, score: row.score, dual_check: row.dualCheck, rule_version: row.ruleVersion } });
    await scope.emit({
      aggregateType: RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type: 'vnd.risk.assessed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, resource_id: row.id, version: row.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), contractor_id: id, tier: row.tier, score: row.score, dual_check: row.dualCheck },
      eventKey: `${RESOURCE}:${row.id}:${row.version}:assessed`,
    });
    return commandResult(scope, 'PROPOSED', row.version, row.id);
  }

  @Post('vendor/risk-assessments/:id/decide')
  @HttpCode(200)
  @OperationId('decideVendorRiskGrade')
  @Command({ operation: 'decideVendorRiskGrade', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorRiskDecision']): Promise<CommandResult> {
    need(access, PERMISSIONS.decideVendorRiskGrade);
    const now = new Date();
    const row = await this.risk.decide(scope.tx, id, scope.expectedVersion ?? 0, body.decision, body.reason, scope.tenant.membershipId, todayOf(now));
    await scope.audit({
      action: body.decision === 'CONFIRM' ? 'vnd.risk_confirmed' : 'vnd.risk_rejected',
      resourceType: RESOURCE,
      resourceId: id,
      classification: CLASSIFICATION,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
      diff: { contractor_id: row.contractorId, tier: row.tier, score: row.score, state: row.state },
    });
    await scope.emit({
      aggregateType: RESOURCE,
      aggregateId: id,
      aggregateVersion: row.version,
      type: 'vnd.risk.decided.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, resource_id: id, version: row.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), contractor_id: row.contractorId, decision: body.decision, tier: row.tier, state: row.state, next_review_on: row.nextReviewOn },
      eventKey: `${RESOURCE}:${id}:${row.version}:decided`,
    });
    return commandResult(scope, row.state, row.version, id);
  }
}

/** The reads of the risk grade (VND-11). A read never writes: the grade shown as "live" is computed and not stored. */
@Controller()
export class VendorRiskReadsController {
  private readonly risk = new VendorRiskStore();
  private readonly people = new BidWorkflowReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private caller(tenant: TenantContext, access: EffectiveAccess): Caller {
    return { membershipId: tenant.membershipId, holds: (permission) => holdsOnWholeTenant(access, permission) };
  }

  @Get('vendor/contractors/:id/risk')
  @OperationId('getVendorRiskGrade')
  async grade(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    need(access, PERMISSIONS.getVendorRiskGrade);
    const now = new Date();
    const today = todayOf(now);
    const caller = this.caller(tenant, access);
    return this.database.withTenant(tenant, async (tx) => {
      const [named] = await tx.query<{ legal_name: string; risk_tier: RiskTier | null }>('select legal_name, risk_tier from machvon.contractor where id = $1::uuid', [id]);
      if (named === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const live = await this.risk.liveProposal(tx, id, today);
      const history = await this.risk.history(tx, id, 50);
      const names = await this.people.names(tx, history.flatMap((row) => [row.assessedBy, row.decidedBy].filter((one): one is string => one !== null)));
      const confirmed = history.find((row) => row.state === 'CONFIRMED');
      const pending = history.find((row) => row.state === 'PROPOSED');
      return {
        contractor_id: id,
        contractor_name: named.legal_name,
        tier: named.risk_tier,
        confirmed: confirmed === undefined ? null : riskDto(confirmed, names, caller),
        pending: pending === undefined ? null : riskDto(pending, names, caller),
        live: {
          score: live.grade.score,
          tier: live.grade.tier,
          score_tier: live.grade.scoreTier,
          floored: live.grade.floored,
          factors: live.grade.factors.map((one) => ({ factor: one.factor, points: one.points, max: one.max, reading: one.reading })),
          reasons: live.grade.reasons,
          review_months: live.grade.reviewMonths,
          next_review_on: live.nextReviewOn,
          dual_check: live.grade.dualCheck,
          inputs: live.inputs as unknown as Record<string, unknown>,
        },
        history: history.map((row) => riskDto(row, names, caller)),
        policy: policyDto('VENDOR_RISK', live.policy),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/risk-grades')
  @OperationId('listVendorRiskGrades')
  async register(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    need(access, PERMISSIONS.listVendorRiskGrades);
    const now = new Date();
    const today = todayOf(now);
    const tier = text(query.tier, 'tier', 20);
    if (tier !== undefined && !TIERS.includes(tier)) throw new DomainError('VALIDATION_FAILED', 422, 'tier');
    const request = parsePageRequest(query.limit, query.cursor);
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.risk.register(tx, { q: text(query.q, 'q', 100), tier: tier as RiskTier | undefined, reviewDue: flag(query.review_due, 'review_due'), pending: flag(query.pending, 'pending'), limit: request.limit, after: request.after === undefined ? undefined : { name: request.after.code, id: request.after.id } }, today);
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      const policy = await this.risk.policyOf(tx, today);
      return {
        items: shown.map((row) => ({
          contractor_id: row.contractorId,
          legal_name: row.name,
          tax_identifier: row.taxIdentifier,
          tier: row.tier,
          score: row.score,
          next_review_on: row.nextReviewOn,
          review_overdue: row.reviewOverdue,
          assessment_id: row.assessmentId,
          pending_assessment_id: row.pendingAssessmentId,
          pending_tier: row.pendingTier,
          cursor: encodeCursor({ code: row.name, id: row.contractorId }),
        })),
        next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.name, id: last.contractorId }) : null,
        policy: policyDto('VENDOR_RISK', policy),
        figures: (await this.risk.figures(tx, today)).map(figureDto),
        as_of: now.toISOString(),
      };
    });
  }
}
