import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CtrContractSource, DoaMatrixStore, PrjReserveStore, TenantDatabase, projectScope } from '@machvon/db';
import type { ProjectReserveView, ReserveCommandResult } from '@machvon/db';
import { DomainError, RESERVE_DOA_DOCUMENT_TYPE, RESERVE_MGMT_DOA_DOCUMENT_TYPE, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { assertWithinDelegation } from '../../doa-delegation';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { reaches, refsOf } from '../ctr/contract.controller';

const READ_PERMISSION = PERMISSIONS.getProjectReserve;
const FUND_PERMISSION = PERMISSIONS.fundProjectReserve;
const REQUEST_PERMISSION = PERMISSIONS.requestReserveDrawdown;
const DECIDE_PERMISSION = PERMISSIONS.decideReserveDrawdown;
const EXPOSURE_PERMISSION = PERMISSIONS.setRiskExposure;
const FUND_RESOURCE = 'reserve_fund';
const DRAWDOWN_RESOURCE = 'reserve_drawdown';
const EXPOSURE_RESOURCE = 'risk_exposure';
const CLASSIFICATION = 'CONFIDENTIAL';

function coverView(cover: NonNullable<ProjectReserveView['contingencyCover']> | null): Record<string, unknown> | null {
  return cover === null ? null : { balance_vnd: cover.balanceVnd, expected_value_vnd: cover.expectedValueVnd, shortfall_vnd: cover.shortfallVnd, covered: cover.covered, cover_pct: cover.coverPct };
}

/** The reserve of a project as openapi.json exposes it (x-exposure dto): an allowlist, so a column added later is not shown until it is listed here. */
export function projectReserveView(view: ProjectReserveView, actions: Record<string, boolean>): Record<string, unknown> {
  return {
    project_id: view.projectId,
    project_code: view.projectCode,
    funds: view.funds.map((fund) => ({
      id: fund.id,
      kind: fund.kind,
      balance_vnd: fund.balanceVnd,
      version: fund.version,
      entries: fund.entries.map((entry) => ({
        id: entry.id,
        entry_kind: entry.entryKind,
        amount_vnd: entry.amountVnd,
        balance_after_vnd: entry.balanceAfterVnd,
        risk_id: entry.riskId,
        change_request_id: entry.changeRequestId,
        drawdown_id: entry.drawdownId,
        reason: entry.reason,
        requested_by: entry.requestedBy,
        approved_by: entry.approvedBy,
        posted_at: entry.postedAt,
      })),
      open_drawdowns: fund.openDrawdowns.map((drawdown) => ({
        id: drawdown.id,
        amount_vnd: drawdown.amountVnd,
        risk_id: drawdown.riskId,
        change_request_id: drawdown.changeRequestId,
        reason: drawdown.reason,
        requested_by: drawdown.requestedBy,
        requested_at: drawdown.requestedAt,
        version: drawdown.version,
      })),
    })),
    risks: view.risks.map((risk) => ({ id: risk.riskId, code: risk.code, title: risk.title, status: risk.status, probability_pct: risk.probabilityPct, cost_impact_vnd: risk.costImpactVnd, expected_value_vnd: risk.expectedValueVnd })),
    expected_value_vnd: view.expectedValueVnd,
    unassessed_risk_count: view.unassessedRiskCount,
    contingency_cover: coverView(view.contingencyCover),
    policy: { version: view.policy.version, source: view.policy.source, cover_alert_below_pct: view.policy.coverAlertBelowPct },
    actions,
    as_of: view.asOf,
  };
}

/**
 * The contingency and the management reserve of a project (governance deepening G1-7, PRJ F04, PRJ-22): two funds that are never mixed, filled on the document that allots them, drawn only for one risk or one
 * change order by a request that someone else decides, with an append-only ledger whose balance the database keeps. The management reserve is the level above's: it is drawn only within a band of the delegation of
 * authority of ADM that the tenant configured for it, and never when none is configured. Every command is audited and idempotent; the money in the ledger is whole dong.
 */
@Controller()
export class ProjectReserveController {
  private readonly reserves = new PrjReserveStore();
  private readonly source = new CtrContractSource();
  private readonly doa = new DoaMatrixStore();

  @Post('projects/:id/reserve-funds')
  @HttpCode(200)
  @OperationId('fundProjectReserve')
  @Command({ operation: 'fundProjectReserve' })
  async fund(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjReserveFund']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.reserves.fund(
      scope.tx,
      id.toLowerCase(),
      { kind: body.kind, amountVnd: body.amount_vnd, authorityDocumentVersionId: body.authority_document_version_id, reason: body.reason },
      scope.tenant.membershipId,
      projectScope(access, FUND_PERMISSION, now),
    );
    await this.record(scope, done, 'project.reserve_funded', 'project.reserve_funded.v1', FUND_RESOURCE, done.fundId, now, body.reason, { authority_document_version_id: body.authority_document_version_id });
    return { ...commandResult(scope, done.status, done.version, done.fundId), balance_vnd: done.balanceVnd, ledger_entry_id: done.ledgerEntryId };
  }

  @Post('projects/:id/reserve-drawdowns')
  @HttpCode(200)
  @OperationId('requestReserveDrawdown')
  @Command({ operation: 'requestReserveDrawdown' })
  async request(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjReserveDrawdownRequest']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.reserves.requestDrawdown(
      scope.tx,
      id.toLowerCase(),
      { kind: body.kind, amountVnd: body.amount_vnd, riskId: body.risk_id, changeRequestId: body.change_request_id, reason: body.reason },
      scope.tenant.membershipId,
      projectScope(access, REQUEST_PERMISSION, now),
    );
    await this.record(scope, done, 'project.reserve_drawdown_requested', 'project.reserve_drawdown_requested.v1', DRAWDOWN_RESOURCE, done.id, now, body.reason, {});
    return { ...commandResult(scope, done.status, done.version, done.id), fund_id: done.fundId };
  }

  @Post('reserve-drawdowns/:id/decision')
  @HttpCode(200)
  @OperationId('decideReserveDrawdown')
  @Command({ operation: 'decideReserveDrawdown', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjReserveDrawdownDecision']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.reserves.decideDrawdown(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { decision: body.decision, reason: body.reason },
      scope.tenant.membershipId,
      projectScope(access, DECIDE_PERMISSION, now),
      async (facts) => {
        const project = await this.source.projectRef(scope.tx, facts.projectId);
        if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
        // The contingency is limited only where the tenant configured bands; the management reserve is the level above's and is never open by default.
        await assertWithinDelegation(this.doa, scope, access, {
          documentType: facts.kind === 'MGMT_RESERVE' ? RESERVE_MGMT_DOA_DOCUMENT_TYPE : RESERVE_DOA_DOCUMENT_TYPE,
          permission: DECIDE_PERMISSION,
          amountVnd: facts.amountVnd,
          unitId: project.ownerUnit.id,
          place: { ownerUnitPath: project.ownerUnit.path, ownerUnitId: project.ownerUnit.id, projectId: facts.projectId },
          now,
          unconfigured: facts.kind === 'MGMT_RESERVE' ? 'REFUSE' : 'ALLOW',
        });
      },
    );
    await this.record(scope, done, `project.reserve_drawdown_${body.decision === 'approve' ? 'approved' : 'rejected'}`, 'project.reserve_drawdown_decided.v1', DRAWDOWN_RESOURCE, done.id, now, body.reason, { decision: body.decision, ledger_entry_id: done.ledgerEntryId });
    return { ...commandResult(scope, done.status, done.version, done.id), balance_vnd: done.balanceVnd, ledger_entry_id: done.ledgerEntryId };
  }

  @Post('project-risks/:id/exposure')
  @HttpCode(200)
  @OperationId('setRiskExposure')
  @Command({ operation: 'setRiskExposure' })
  async exposure(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjRiskExposure']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.reserves.setExposure(scope.tx, id.toLowerCase(), { probabilityPct: body.probability_pct, costImpactVnd: body.cost_impact_vnd }, scope.expectedVersion, scope.tenant.membershipId, projectScope(access, EXPOSURE_PERMISSION, now));
    await scope.audit({ action: 'project.risk_exposure_set', resourceType: EXPOSURE_RESOURCE, resourceId: done.riskId, classification: CLASSIFICATION, diff: { project_id: done.projectId, probability_pct: body.probability_pct, cost_impact_vnd: body.cost_impact_vnd, version: done.version } });
    await scope.emit({
      aggregateType: EXPOSURE_RESOURCE,
      aggregateId: done.riskId,
      aggregateVersion: done.version,
      type: 'project.risk_exposure_set.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, project_id: done.projectId, risk_id: done.riskId, probability_pct: body.probability_pct, cost_impact_vnd: body.cost_impact_vnd, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${EXPOSURE_RESOURCE}:${done.riskId}:${done.version}`,
    });
    return commandResult(scope, 'SET', done.version, done.riskId);
  }

  /** The audit row and the event of a command on the reserve: ids, kinds, amounts and statuses, never the words of the reason beyond the row that keeps them. */
  private async record(scope: CommandScope, done: ReserveCommandResult, action: string, type: string, resource: string, resourceId: string, now: Date, reason: string, extra: Record<string, unknown>): Promise<void> {
    const facts = { project_id: done.projectId, fund_id: done.fundId, kind: done.kind, amount_vnd: done.amountVnd, risk_id: done.riskId, change_request_id: done.changeRequestId, balance_vnd: done.balanceVnd, status: done.status, ...extra };
    await scope.audit({ action, resourceType: resource, resourceId, classification: CLASSIFICATION, reason, diff: facts });
    await scope.emit({
      aggregateType: resource,
      aggregateId: resourceId,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, ...facts, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${resource}:${resourceId}:${done.version}:${action}`,
    });
  }
}

/** The reserve of a project in the scope of the caller (PRJ-22): what each fund holds, the ledger, the open risks and the cover; the buttons are the commands the caller may give over the project. */
@Controller()
export class ProjectReserveReadsController {
  private readonly reserves = new PrjReserveStore();
  private readonly source = new CtrContractSource();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('projects/:id/reserve')
  @OperationId('getProjectReserve')
  async reserve(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const projectId = id.toLowerCase();
    const found = await this.database.withTenant(tenant, async (tx) => {
      const view = await this.reserves.view(tx, projectId, projectScope(access, READ_PERMISSION, now), vietnamDateOf(now));
      if (view === undefined) return undefined;
      const project = await this.source.projectRef(tx, projectId);
      return { view, project };
    });
    // A project in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const refs = found.project === undefined ? [] : refsOf(found.project, projectId);
    return projectReserveView(found.view, {
      fund: reaches(access, FUND_PERMISSION, refs, now),
      request_drawdown: reaches(access, REQUEST_PERMISSION, refs, now),
      decide_drawdown: reaches(access, DECIDE_PERMISSION, refs, now),
      set_exposure: reaches(access, EXPOSURE_PERMISSION, refs, now),
    });
  }
}
