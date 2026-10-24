import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PrjProjectStore, TenantDatabase, projectScope } from '@machvon/db';
import type { ProfileChange } from '@machvon/db';
import { DomainError, NOOP_METRICS, effectivePermissions, holdsPermission, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { projectDetailView, projectLineView } from './project-view';
import { PRJ_METRICS } from './tokens';

const CREATE_PERMISSION = PERMISSIONS.createProject;
const UPDATE_PERMISSION = PERMISSIONS.updateProjectProfile;
const READ_PERMISSION = PERMISSIONS.get_resources_project;
const RESOURCE_TYPE = 'project';
const MISSING_CODE_GAUGE = 'prj_national_code_missing_gauge';

/** Whether a grant that carries the permission has a scope that contains the unit. */
function reaches(access: EffectiveAccess, permission: string, unit: { id: string; path: string }, now: Date): boolean {
  return holdsPermission(effectivePermissions(access, now, { ownerUnitPath: unit.path, ownerUnitId: unit.id }), permission);
}

/** The allowlist of the contract in the shape the store takes (no code, no status, no tenant, no money, no rights: BR-PRJ-13). */
function profileChangeOf(body: Schemas['PrjProfileChange']): ProfileChange {
  return {
    name: body.name,
    investorUnitId: body.investor_unit_id,
    areaMasterVersionId: body.area_master_version_id,
    sectorMasterVersionId: body.sector_master_version_id,
    projectTypeMasterVersionId: body.project_type_master_version_id,
    programMasterVersionId: body.program_master_version_id,
    startYear: body.start_year,
    endYear: body.end_year,
    classification: body.classification,
  };
}

/**
 * The project register (ST-PRJ-001, PRJ 3.1 F1): a project is created in CONCEPT and its profile is kept within an allowlist. Status,
 * code, tenant, rights and money are not written here and no generic write exists for them (BR-PRJ-13). A command acts on a project
 * inside the scope of its permission: a project the caller cannot see does not exist for them.
 */
@Controller()
export class ProjectController {
  private readonly projects = new PrjProjectStore();

  @Post('projects')
  @HttpCode(200)
  @OperationId('createProject')
  @Command({ operation: 'createProject' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['PrjProjectCreate']): Promise<CommandResult> {
    const now = new Date();
    const unit = await this.projects.unitRef(scope.tx, body.owner_unit_id);
    // A unit of another tenant is indistinguishable from one that does not exist.
    if (unit === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!reaches(access, CREATE_PERMISSION, unit, now)) throw new DomainError('SCOPE_DENIED', 403);
    const created = await this.projects.create(
      scope.tx,
      {
        code: body.code,
        name: body.name,
        ownerUnitId: body.owner_unit_id,
        investorUnitId: body.investor_unit_id,
        decisionAuthorityUnitId: body.decision_authority_unit_id,
        areaMasterVersionId: body.area_master_version_id,
        sectorMasterVersionId: body.sector_master_version_id,
        projectTypeMasterVersionId: body.project_type_master_version_id,
        programMasterVersionId: body.program_master_version_id,
        totalInvestmentVnd: body.total_investment_vnd,
        startYear: body.start_year,
        endYear: body.end_year,
        classification: body.classification,
      },
      scope.tenant.membershipId,
      vietnamDateOf(now),
    );
    await scope.audit({
      action: 'project.created',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      classification: created.classification,
      diff: { code: body.code, owner_unit_id: body.owner_unit_id, status: created.status, group_suggestion: created.groupSuggestion?.groupKey ?? null },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'project.created.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        project_id: created.id,
        version: created.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        code: body.code,
        status: created.status,
        owner_unit_id: body.owner_unit_id,
      },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return commandResult(scope, created.status, created.version, created.id);
  }

  @Post('projects/:id/profile')
  @HttpCode(200)
  @OperationId('updateProjectProfile')
  @Command({ operation: 'updateProjectProfile', versioned: true })
  async updateProfile(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['PrjProfileChange'],
  ): Promise<CommandResult> {
    const now = new Date();
    const done = await this.projects.updateProfile(
      scope.tx,
      id,
      scope.expectedVersion ?? 0,
      profileChangeOf(body),
      scope.tenant.membershipId,
      { update: projectScope(access, UPDATE_PERMISSION, now), read: projectScope(access, READ_PERMISSION, now) },
      vietnamDateOf(now),
    );
    // A request that changes nothing is recorded as such and leaves the version and the event stream as they were.
    await scope.audit({
      action: done.changes.length === 0 ? 'project.profile_unchanged' : 'project.profile_changed',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      classification: done.classification,
      diff: { changes: done.changes },
    });
    if (done.changes.length === 0) return commandResult(scope, done.status, done.version, id);
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: done.version,
      type: 'project.profile_changed.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        project_id: id,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        changed_fields: done.changes.map((change) => change.field),
      },
      eventKey: `${RESOURCE_TYPE}:${id}:${done.version}`,
    });
    return commandResult(scope, done.status, done.version, id);
  }
}

/** The register in the scope of the caller (PRJ-01) and the workspace of one project (PRJ-03): a DTO allowlist filtered by the unit tree. */
@Controller('resources/project')
export class ProjectReadsController {
  private readonly projects = new PrjProjectStore();
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(PRJ_METRICS) metrics?: MetricsSink,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
  }

  @Get()
  @OperationId('get_resources_project')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const { rows, missing } = await this.database.withTenant(tenant, async (tx) => ({
      rows: await this.projects.list(tx, projectScope(access, READ_PERMISSION, now), { limit: request.limit + 1, after: request.after }),
      // The gauge is the state of the tenant, not of one page or of one caller: it is read once, with the first page.
      missing: request.after === undefined ? await this.projects.countMissingNationalCode(tx) : undefined,
    }));
    if (missing !== undefined) this.metrics.gauge(MISSING_CODE_GAUGE, missing, { tenant: tenant.tenantId });
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(projectLineView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.codeKey, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_project_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const view = await this.database.withTenant(tenant, async (tx) => {
      const detail = await this.projects.find(tx, id, projectScope(access, READ_PERMISSION, now));
      if (detail === undefined) return undefined;
      // The group is judged by the rules of the day the project was proposed on, with the amount it has now.
      const suggestion = await this.projects.suggestGroup(tx, detail.sector, detail.totalInvestmentVnd, detail.proposedOn);
      return projectDetailView(detail, suggestion);
    });
    // A project in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (view === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return view;
  }
}
