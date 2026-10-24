import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidContractorStore, CtrContractPartyStore, CtrContractSource, CtrContractStore, TenantDatabase, contractScope, readParties } from '@machvon/db';
import type { ContractPlace, ContractScopes, ProjectRef } from '@machvon/db';
import { DomainError, effectivePermissions, holdsPermission, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, ResourceRef, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { contractDetailView, contractLineView, revisionView } from './contract-view';
import type { ContractRights } from './contract-view';

const CREATE_PERMISSION = PERMISSIONS.createContract;
const UPDATE_PERMISSION = PERMISSIONS.reviseContractDraft;
const READ_PERMISSION = PERMISSIONS.get_resources_contract;
const REVISION_READ_PERMISSION = PERMISSIONS.get_resources_contract_revision;
/** The right to the totals of the ledger kept on a contract: without it a reader sees no total at all. */
const LEDGER_PERMISSION = 'ledger.read';
const RESOURCE_TYPE = 'contract';
const CLASSIFICATION = 'INTERNAL';

/** The places a contract lies in for the permission test: the units that own and invest in its project, each with the project and the contract. */
function refsOf(project: { ownerUnit: { id: string; path: string }; investorUnit: { id: string; path: string } | null }, projectId: string, contractId?: string): ResourceRef[] {
  const units = project.investorUnit === null ? [project.ownerUnit] : [project.ownerUnit, project.investorUnit];
  return units.map((unit) => ({ ownerUnitPath: unit.path, ownerUnitId: unit.id, projectId, ...(contractId === undefined ? {} : { contractId }) }));
}

/** Whether a grant that carries the permission has a scope that contains the contract, or the project it lies in. */
function reaches(access: EffectiveAccess, permission: string, refs: readonly ResourceRef[], now: Date): boolean {
  return refs.some((ref) => holdsPermission(effectivePermissions(access, now, ref), permission));
}

function scopesOf(access: EffectiveAccess, now: Date): ContractScopes {
  return { update: contractScope(access, UPDATE_PERMISSION, now), read: contractScope(access, READ_PERMISSION, now) };
}

const placeRefs = (place: ContractPlace): ResourceRef[] => refsOf(place, place.projectId, place.contractId);

/** What the caller may see of the contracts in `places`: the staff see the internal fields, a guest contractor does not, and the ledger totals follow `ledger.read`. */
function rightsFor(access: EffectiveAccess, guest: boolean, place: ContractPlace, now: Date): ContractRights {
  return { internal: !guest, ledger: reaches(access, LEDGER_PERMISSION, placeRefs(place), now) };
}

/**
 * The contract register (ST-CTR-001, CTR 3.1 steps 1 and 2): a contract is drafted under an awarded package, its terms and joint-venture
 * members are kept within an allowlist while it is a draft, and a draft is cancelled with a reason. Status, code, tenant, project,
 * contractor and the ledger totals have no write path here and no generic one exists (CTR section 7). A command acts on a contract inside
 * the scope of its permission: a contract the caller cannot see does not exist for them.
 */
@Controller()
export class ContractController {
  private readonly source = new CtrContractSource();
  private readonly contracts = new CtrContractStore(this.source);
  private readonly parties = new CtrContractPartyStore(this.contracts);

  @Post('contracts')
  @HttpCode(200)
  @OperationId('createContract')
  @Command({ operation: 'createContract' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['CtrCreateContract']): Promise<CommandResult> {
    const now = new Date();
    // Identifiers travel on as the lower-case text the database writes: the audit row and the event of this command are matched against ids as strings.
    const [projectId, packageId, contractorId] = [body.project_id.toLowerCase(), body.package_id.toLowerCase(), body.contractor_id.toLowerCase()];
    const project: ProjectRef | undefined = await this.source.projectRef(scope.tx, projectId);
    // A project of another tenant is indistinguishable from one that does not exist.
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!reaches(access, CREATE_PERMISSION, refsOf(project, project.id), now)) throw new DomainError('SCOPE_DENIED', 403);
    const created = await this.contracts.create(
      scope.tx,
      {
        projectId,
        packageId,
        contractorId,
        code: body.code,
        title: body.title,
        type: body.type,
        advanceCategory: body.advance_category,
        isJointVenture: body.is_joint_venture,
        requiresQualityAcceptance: body.requires_quality_acceptance,
        contractValueVnd: body.contract_value_vnd,
        estimateCeilingVnd: body.estimate_ceiling_vnd,
        completionDue: body.completion_due,
        documentVersionId: body.document_version_id,
      },
      scope.tenant.membershipId,
      vietnamDateOf(now),
    );
    await scope.audit({
      action: 'contract.created',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      classification: CLASSIFICATION,
      diff: {
        code: created.code,
        project_id: projectId,
        package_id: packageId,
        contractor_id: contractorId,
        contract_value_vnd: created.contractValueVnd,
        estimate_ceiling_vnd: created.estimateCeilingVnd,
        status: created.status,
      },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'ctr.contract.created.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        contract_id: created.id,
        revision_id: created.revisionId,
        version: created.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        code: created.code,
        status: created.status,
        project_id: projectId,
        package_id: packageId,
        contractor_id: contractorId,
        contract_value_vnd: created.contractValueVnd,
        estimate_ceiling_vnd: created.estimateCeilingVnd,
      },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return commandResult(scope, created.status, created.version, created.id);
  }

  @Post('contracts/:id/draft')
  @HttpCode(200)
  @OperationId('reviseContractDraft')
  @Command({ operation: 'reviseContractDraft', versioned: true })
  async revise(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['CtrReviseContractDraft'],
  ): Promise<CommandResult> {
    const now = new Date();
    const done = await this.contracts.reviseDraft(
      scope.tx,
      id,
      scope.expectedVersion ?? 0,
      {
        title: body.title,
        completionDue: body.completion_due,
        contractValueVnd: body.contract_value_vnd,
        estimateCeilingVnd: body.estimate_ceiling_vnd,
        requiresQualityAcceptance: body.requires_quality_acceptance,
        documentVersionId: body.document_version_id,
      },
      scope.tenant.membershipId,
      scopesOf(access, now),
    );
    // A request that changes nothing is recorded as such and leaves the version and the event stream as they were.
    await scope.audit({
      action: done.changes.length === 0 ? 'contract.draft_unchanged' : 'contract.draft_revised',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      classification: CLASSIFICATION,
      diff: { changes: done.changes },
    });
    if (done.changes.length === 0) return commandResult(scope, done.status, done.version, id);
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: done.version,
      type: 'ctr.contract.drafted.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        contract_id: id,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        changed_fields: done.changes.map((change) => change.field),
      },
      eventKey: `${RESOURCE_TYPE}:${id}:${done.version}`,
    });
    return commandResult(scope, done.status, done.version, id);
  }

  @Post('contracts/:id/parties')
  @HttpCode(200)
  @OperationId('replaceContractParties')
  @Command({ operation: 'replaceContractParties', versioned: true })
  async replaceParties(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['CtrReplaceContractParties'],
  ): Promise<CommandResult> {
    const now = new Date();
    const done = await this.parties.replace(scope.tx, id, scope.expectedVersion ?? 0, readParties(body.parties), scope.tenant.membershipId, scopesOf(access, now), vietnamDateOf(now));
    const members = done.parties.map((party) => ({ contractor_id: party.contractorId, role: party.role, share_pct: party.sharePct, work_value_vnd: party.workValueVnd }));
    await scope.audit({
      action: done.changed ? 'contract.parties_replaced' : 'contract.parties_unchanged',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      classification: CLASSIFICATION,
      diff: { parties: members },
    });
    if (!done.changed) return commandResult(scope, done.status, done.version, id);
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: done.version,
      type: 'ctr.contract.parties_replaced.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        contract_id: id,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        parties: members,
      },
      eventKey: `${RESOURCE_TYPE}:${id}:${done.version}`,
    });
    return commandResult(scope, done.status, done.version, id);
  }

  @Post('contracts/:id/cancel')
  @HttpCode(200)
  @OperationId('cancelContractDraft')
  @Command({ operation: 'cancelContractDraft', versioned: true })
  async cancel(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['CtrCancelContractDraft'],
  ): Promise<CommandResult> {
    const now = new Date();
    const done = await this.contracts.cancelDraft(scope.tx, id, scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId, scopesOf(access, now), vietnamDateOf(now));
    await scope.audit({
      action: 'contract.cancelled',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      classification: CLASSIFICATION,
      diff: { from_status: done.fromStatus, to_status: done.status, reason: body.reason.trim() },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: done.version,
      type: 'ctr.contract.cancelled.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        contract_id: id,
        version: done.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        from_status: done.fromStatus,
        status: done.status,
      },
      eventKey: `${RESOURCE_TYPE}:${id}:${done.version}`,
    });
    return commandResult(scope, done.status, done.version, id);
  }
}

/**
 * The register (CTR-01) and the contract with its terms, revisions and members (CTR-02, CTR-25): a DTO allowlist filtered by the unit tree,
 * the project and the contract grants. A contract outside the scope of the caller is indistinguishable from one that does not exist; a guest
 * contractor sees no ceiling, no history of reasons and no ledger total.
 */
@Controller('resources/contract')
export class ContractReadsController {
  private readonly contracts = new CtrContractStore();
  private readonly contractors = new BidContractorStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_contract')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const { rows, guest } = await this.database.withTenant(tenant, async (tx) => ({
      rows: await this.contracts.list(tx, contractScope(access, READ_PERMISSION, now), { limit: request.limit + 1, after: request.after }),
      guest: (await this.contractors.callerOf(tx, tenant.membershipId)).guest,
    }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((line) => contractLineView(line, rightsFor(access, guest, line.reach, now))),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.code, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_contract_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const view = await this.database.withTenant(tenant, async (tx) => {
      const detail = await this.contracts.find(tx, id, contractScope(access, READ_PERMISSION, now));
      if (detail === undefined) return undefined;
      const guest = (await this.contractors.callerOf(tx, tenant.membershipId)).guest;
      return contractDetailView(detail, rightsFor(access, guest, detail.reach, now));
    });
    // A contract in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (view === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return view;
  }
}

/** The revisions of the contracts in the scope of the caller (the right to read a revision is its own, `contract_revision.read`). */
@Controller('resources/contract_revision')
export class ContractRevisionReadsController {
  private readonly contracts = new CtrContractStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_contract_revision')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.contracts.listRevisions(tx, contractScope(access, REVISION_READ_PERMISSION, now), { limit: request.limit + 1, after: request.after }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(revisionView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.key, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_contract_revision_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const row = await this.database.withTenant(tenant, (tx) => this.contracts.findRevision(tx, id, contractScope(access, REVISION_READ_PERMISSION, now)));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return revisionView(row);
  }
}
