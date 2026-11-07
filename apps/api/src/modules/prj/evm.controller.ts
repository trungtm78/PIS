import { createHash } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { COMPONENT_CONTRACT_RESOURCE, PrjEvmStore, TenantDatabase, projectScope } from '@machvon/db';
import type { EvmQuery, EvmScope, EvmView, SCurveView } from '@machvon/db';
import { DomainError, asUuid, buildSCurveExport, isCalendarDate, vietnamDateOf, xlsxOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const READ_PERMISSION = PERMISSIONS.getProjectEvm;
const LINK_PERMISSION = PERMISSIONS.linkContractComponent;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const badQuery = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** The query of the reads of PRJ-27, judged: a day not after today, a scope with the thing it is about, the baseline and the frozen snapshot that may be named. */
export function evmQueryOf(projectId: string, raw: { as_of: unknown; scope: unknown; ref: unknown; baseline: unknown; snapshot_id: unknown }, today: string): EvmQuery {
  const asOf = raw.as_of === undefined ? today : raw.as_of;
  if (typeof asOf !== 'string' || !isCalendarDate(asOf) || asOf > today) throw badQuery('as_of');
  const scope = raw.scope === undefined ? 'PROJECT' : raw.scope;
  if (scope !== 'PROJECT' && scope !== 'COMPONENT' && scope !== 'CONTRACT') throw badQuery('scope');
  const ref = raw.ref === undefined ? undefined : asUuid(raw.ref);
  if (raw.ref !== undefined && ref === undefined) throw badQuery('ref');
  if (scope !== 'PROJECT' && ref === undefined) throw badQuery('ref');
  if (scope === 'PROJECT' && ref !== undefined) throw badQuery('ref');
  const baseline = raw.baseline === undefined ? 'CURRENT' : raw.baseline;
  if (baseline !== 'CURRENT' && baseline !== 'V0') throw badQuery('baseline');
  const snapshot = raw.snapshot_id === undefined ? undefined : asUuid(raw.snapshot_id);
  if (raw.snapshot_id !== undefined && snapshot === undefined) throw badQuery('snapshot_id');
  return { projectId, asOf, scope: scope as EvmScope, ref, baseline, snapshotId: snapshot };
}

const rowView = (row: EvmView['rows'][number]): Record<string, unknown> => ({
  key: row.key,
  code: row.code,
  name: row.name,
  bac_vnd: row.bacVnd,
  pv_vnd: row.pvVnd,
  ev_vnd: row.evVnd,
  ac_vnd: row.acVnd,
  cpi: row.cpi,
  spi: row.spi,
  rag_cpi: row.ragCpi,
  rag_spi: row.ragSpi,
  missing: row.missing,
  contracts: row.contracts.map((contract) => ({ contract_id: contract.contractId, code: contract.code, value_vnd: contract.valueVnd })),
});

const figuresView = (figures: EvmView['figures']): Record<string, unknown> => ({
  status: figures.status,
  as_of: figures.asOf,
  eac_method: figures.eacMethod,
  bac_vnd: figures.bacVnd,
  pv_vnd: figures.pvVnd,
  ev_vnd: figures.evVnd,
  ac_vnd: figures.acVnd,
  cpi: figures.cpi,
  spi: figures.spi,
  eac_vnd: figures.eacVnd,
  etc_vnd: figures.etcVnd,
  vac_vnd: figures.vacVnd,
  tcpi: figures.tcpi,
  unavailable: figures.unavailable,
  missing: figures.missing,
  rag_cpi: figures.ragCpi,
  rag_spi: figures.ragSpi,
});

const policyView = (policy: EvmView['policy']): Record<string, unknown> => ({ version: policy.version, source: policy.source, eac_method: policy.eacMethod, amber_below: policy.amberBelow, red_below: policy.redBelow });

/** The earned value as openapi.json exposes it (x-exposure dto): an allowlist. */
export function evmView(view: EvmView): Record<string, unknown> {
  return {
    project_id: view.projectId,
    project_code: view.projectCode,
    scope: view.scope,
    ref: view.ref,
    as_of: view.asOf,
    source: view.source,
    snapshot_id: view.snapshotId,
    frozen_at: view.frozenAt,
    payload_sha256: view.payloadSha256,
    baseline: view.baseline,
    figures: figuresView(view.figures),
    eac_against_total: view.eacAgainstTotal === null ? null : { over_vnd: view.eacAgainstTotal.overVnd, over_pct: view.eacAgainstTotal.overPct },
    total_investment_vnd: view.totalInvestmentVnd,
    rows: view.rows.map(rowView),
    policy: policyView(view.policy),
  };
}

export function sCurveView(view: SCurveView): Record<string, unknown> {
  return {
    project_id: view.projectId,
    project_code: view.projectCode,
    scope: view.scope,
    ref: view.ref,
    as_of: view.asOf,
    baseline: view.baseline,
    points: view.curve.points.map((point) => ({ day: point.day, pv_v0_vnd: point.pvV0Vnd, pv_current_vnd: point.pvCurrentVnd, ev_vnd: point.evVnd, ac_vnd: point.acVnd })),
    figures: figuresView(view.figures),
    missing: [...new Set([...view.curve.missing, ...view.figures.missing])],
    source: view.source,
    policy: policyView(view.policy),
  };
}

/**
 * The earned value of a project (governance deepening G1-4, G1-5, PRJ-27): which contract carries which first-level work package, the figures PV, EV, AC, CPI, SPI and EAC of the project, a package or a contract on a
 * day, the S-curve and its Excel file. Earned value comes only from accepted quantities and actual cost only from certified payments; what cannot be known is said with its reason, never written as zero; the figures of
 * a closed period are read from the result frozen with its snapshot. Reads are in the scope of `project.evm.read`; linking is a command over the project.
 */
@Controller()
export class ProjectEvmController {
  private readonly evm = new PrjEvmStore();

  @Post('projects/:id/component-contracts')
  @HttpCode(200)
  @OperationId('linkContractComponent')
  @Command({ operation: 'linkContractComponent' })
  async link(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PrjComponentContractLink']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const done = await this.evm.link(scope.tx, {
      projectId: id.toLowerCase(),
      contractId: body.contract_id,
      componentId: body.component_id ?? null,
      actor: scope.tenant.membershipId,
      scopes: { act: projectScope(access, LINK_PERMISSION, now), read: projectScope(access, READ_PERMISSION, now) },
    });
    await scope.audit({
      action: done.componentId === null ? 'project.component_contract_unlinked' : 'project.component_contract_linked',
      resourceType: COMPONENT_CONTRACT_RESOURCE,
      resourceId: done.id,
      classification: done.classification,
      diff: { project_id: done.projectId, code: done.projectCode, contract_id: done.contractId, component_id: done.componentId, ended_link_id: done.endedLinkId },
    });
    await scope.emit({
      aggregateType: COMPONENT_CONTRACT_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: 1,
      type: 'project.component_contract_linked.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, project_id: done.projectId, link_id: done.id, contract_id: done.contractId, component_id: done.componentId, ended_link_id: done.endedLinkId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${COMPONENT_CONTRACT_RESOURCE}:${done.id}:${done.componentId === null ? 'ended' : 'linked'}`,
    });
    return { ...commandResult(scope, done.componentId === null ? 'ENDED' : 'LINKED', 1, done.id), project_id: done.projectId };
  }
}

@Controller()
export class ProjectEvmReadsController {
  private readonly evm = new PrjEvmStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('projects/:id/component-contracts')
  @OperationId('listProjectComponentContracts')
  async links(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const items = await this.database.withTenant(tenant, (tx) => this.evm.links(tx, projectScope(access, READ_PERMISSION, now), id.toLowerCase()));
    return {
      items: items.map((link) => ({ id: link.id, component_id: link.componentId, component_code: link.componentCode, contract_id: link.contractId, contract_code: link.contractCode, contract_value_vnd: link.contractValueVnd, linked_at: link.linkedAt })),
      as_of: vietnamDateOf(now),
    };
  }

  @Get('projects/:id/evm')
  @OperationId('getProjectEvm')
  async figures(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('as_of') asOf: unknown,
    @Query('scope') scopeName: unknown,
    @Query('ref') ref: unknown,
    @Query('baseline') baseline: unknown,
    @Query('snapshot_id') snapshotId: unknown,
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    const query = evmQueryOf(id.toLowerCase(), { as_of: asOf, scope: scopeName, ref, baseline, snapshot_id: snapshotId }, vietnamDateOf(now));
    const view = await this.database.withTenant(tenant, (tx) => this.evm.evm(tx, projectScope(access, READ_PERMISSION, now), query));
    return evmView(view);
  }

  @Get('projects/:id/s-curve')
  @OperationId('getProjectSCurve')
  async curve(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('as_of') asOf: unknown,
    @Query('scope') scopeName: unknown,
    @Query('ref') ref: unknown,
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    const query = evmQueryOf(id.toLowerCase(), { as_of: asOf, scope: scopeName, ref, baseline: undefined, snapshot_id: undefined }, vietnamDateOf(now));
    const view = await this.database.withTenant(tenant, (tx) => this.evm.sCurve(tx, projectScope(access, READ_PERMISSION, now), query));
    return sCurveView(view);
  }

  /** The workbook of the S-curve: the same figures, the day of the view, the baseline and the formula, as a file the web saves (the bytes travel as base64 in the answer, nothing is stored). */
  @Get('projects/:id/s-curve/export')
  @OperationId('exportProjectSCurve')
  async export(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('as_of') asOf: unknown,
    @Query('scope') scopeName: unknown,
    @Query('ref') ref: unknown,
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    const query = evmQueryOf(id.toLowerCase(), { as_of: asOf, scope: scopeName, ref, baseline: undefined, snapshot_id: undefined }, vietnamDateOf(now));
    const view = await this.database.withTenant(tenant, (tx) => this.evm.sCurve(tx, projectScope(access, READ_PERMISSION, now), query));
    const bytes = Buffer.from(xlsxOf(buildSCurveExport({ projectCode: view.projectCode, curve: view.curve, figures: view.figures, baselineVersion: view.baseline.version, source: view.source })));
    return {
      file_name: `duong-s-${view.projectCode.replace(/[^A-Za-z0-9._-]/g, "_")}-${view.asOf}.xlsx`,
      content_type: XLSX_TYPE,
      size_bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      content_base64: bytes.toString('base64'),
      as_of: view.asOf,
    };
  }
}
