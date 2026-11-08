import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { TenantDatabase, VendorPerformanceStore } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { figureDto, performanceLineDto } from './vendor-risk-view';
import { policyDto, todayOf } from './vendor-view';
import type { Caller } from './vendor-view';

const CLASSIFICATION = 'INTERNAL';
const RESOURCE = 'vendor_performance_publication';
const STATES: readonly string[] = ['DUE', 'OVERDUE', 'POSTED', 'ALL'];

const need = (access: EffectiveAccess, permission: string): void => {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
};

/**
 * The command of the publication of the rating of the performance of a contractor (VND-12; docs/vendor-controls-risk-performance.md). The rating itself is proposed, told, answered and adopted by CA-3; this records
 * that it was posted on the national system, with the reference the network gave, by a person other than the one who adopted it. It runs in one transaction with its audit row and its outbox event (ids and codes only).
 */
@Controller()
export class VendorPerformanceController {
  private readonly performance = new VendorPerformanceStore();

  @Post('vendor/rating-proposals/:id/publication')
  @HttpCode(200)
  @OperationId('postVendorPerformance')
  @Command({ operation: 'postVendorPerformance' })
  async post(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['VendorPerformancePost']): Promise<CommandResult> {
    need(access, PERMISSIONS.postVendorPerformance);
    const now = new Date();
    const line = await this.performance.post(scope.tx, id, { kind: body.kind, receipt: body.receipt }, scope.tenant.membershipId, todayOf(now));
    const latest = line.updates[line.updates.length - 1] ?? line.publication;
    const publicationId = latest?.id ?? id;
    await scope.audit({ action: 'vnd.performance_published', resourceType: RESOURCE, resourceId: publicationId, classification: CLASSIFICATION, diff: { rating_proposal_id: id, contractor_id: line.contractorId, contract_id: line.contractId, kind: body.kind, clock: latest?.clock ?? null } });
    await scope.emit({
      aggregateType: RESOURCE,
      aggregateId: publicationId,
      aggregateVersion: 1,
      type: 'vnd.performance.published.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, resource_id: publicationId, version: 1, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), rating_proposal_id: id, contractor_id: line.contractorId, contract_id: line.contractId, kind: body.kind, clock: latest?.clock ?? null },
      eventKey: `${RESOURCE}:${publicationId}:1:posted`,
    });
    return commandResult(scope, 'POSTED', 1, publicationId);
  }
}

/** The reads of the performance of a contractor and of the publications to look after (VND-12). */
@Controller()
export class VendorPerformanceReadsController {
  private readonly performance = new VendorPerformanceStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private caller(tenant: TenantContext, access: EffectiveAccess): Caller {
    return { membershipId: tenant.membershipId, holds: (permission) => holdsOnWholeTenant(access, permission) };
  }

  @Get('vendor/contractors/:id/performance')
  @OperationId('getVendorPerformance')
  async history(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    need(access, PERMISSIONS.getVendorPerformance);
    const now = new Date();
    const caller = this.caller(tenant, access);
    return this.database.withTenant(tenant, async (tx) => {
      const [named] = await tx.query<{ legal_name: string }>('select legal_name from machvon.contractor where id = $1::uuid', [id]);
      if (named === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const history = await this.performance.history(tx, id, todayOf(now));
      return {
        contractor_id: id,
        contractor_name: named.legal_name,
        lines: history.lines.map((line) => performanceLineDto(line, caller)),
        streak: history.streak,
        suggestion: history.suggestion,
        retrospect_proposal_ids: history.retrospectProposalIds,
        policy: policyDto('VENDOR_PERFORMANCE', history.policy),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('vendor/performance-publications')
  @OperationId('listVendorPerformancePublications')
  async publications(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    need(access, PERMISSIONS.listVendorPerformancePublications);
    const now = new Date();
    const today = todayOf(now);
    const state = query.state === undefined ? 'ALL' : query.state;
    if (typeof state !== 'string' || !STATES.includes(state)) throw new DomainError('VALIDATION_FAILED', 422, 'state');
    const contractorId = query.contractor_id;
    if (contractorId !== undefined && (typeof contractorId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contractorId))) throw new DomainError('VALIDATION_FAILED', 422, 'contractor_id');
    const limitText = query.limit;
    if (limitText !== undefined && (typeof limitText !== 'string' || !/^\d{1,3}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 200)) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
    const caller = this.caller(tenant, access);
    return this.database.withTenant(tenant, async (tx) => {
      const list = await this.performance.worklist(tx, { state: state as 'DUE' | 'OVERDUE' | 'POSTED' | 'ALL', contractorId, limit: limitText === undefined ? 100 : Number(limitText) }, today);
      return {
        items: list.lines.map((line) => performanceLineDto(line, caller)),
        figures: (await this.performance.figures(tx, today)).map(figureDto),
        policy: policyDto('VENDOR_PERFORMANCE', list.policy),
        as_of: now.toISOString(),
      };
    });
  }
}
