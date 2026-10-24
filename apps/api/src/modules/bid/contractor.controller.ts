import { Body, Controller, Get, HttpCode, Inject, Logger, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidContractorStore, TenantDatabase, maskTaxIdentifier } from '@machvon/db';
import type { ContractorRow, LookupRecord, RestrictionRow } from '@machvon/db';
import { DomainError, activeGrants, holdsPermission } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { contractorDetailView, contractorLineView } from './contractor-view';
import type { ContractorIdentityPort } from './identity-port';
import { CONTRACTOR_IDENTITY_PORT } from './tokens';

const MANAGE_PERMISSION = PERMISSIONS.registerContractor;
const VERIFY_PERMISSION = PERMISSIONS.verifyContractor;
/** The right to read contractors in full (the tax id, the people and the documents behind a decision): the permission of the history read. */
const FULL_READ_PERMISSION = PERMISSIONS.getContractorHistory;
const RESOURCE_TYPE = 'contractor';

/**
 * Whether a grant of the caller that carries the permission covers the whole tenant. The registry is not owned by a unit or a project: a
 * right on a branch of the tree does not reach it, so it decides nothing here.
 */
function holdsTenantWide(access: EffectiveAccess, permission: string, now: Date): boolean {
  return activeGrants(access, now).some((grant) => grant.scope.kind === 'TENANT' && holdsPermission(new Set(grant.permissions), permission));
}

function requireTenantWide(access: EffectiveAccess, permission: string, now: Date): void {
  if (!holdsTenantWide(access, permission, now)) throw new DomainError('SCOPE_DENIED', 403);
}

/** What the audit trail and the event say about a restriction: its kind, its dates and its decision, never the note. */
const restrictionDiff = (row: { kind: string; effectiveFrom: string; effectiveUntil: string | null | undefined; decisionDocumentId: string }): Record<string, unknown> => ({
  kind: row.kind,
  effective_from: row.effectiveFrom,
  effective_until: row.effectiveUntil ?? null,
  decision_document_id: row.decisionDocumentId,
});

/**
 * The contractor registry (ST-BID-002, BID 3 F2): a contractor is registered by tax id and linked to master data by that id, never by name;
 * a person other than the registrant verifies it on evidence (an official lookup only adds to that when its adapter says it is VERIFIED);
 * a tax id that a verified contractor holds cannot be verified again and the duplicate is sent to the merge in master data; restrictions
 * are recorded on a decision in force and block proposals and results. Personal data is kept to the minimum: the tax id, the legal name
 * and the registration documents, no representative and no staff.
 */
@Controller('contractors')
export class ContractorController {
  private readonly contractors = new BidContractorStore();
  private readonly logger = new Logger(ContractorController.name);

  constructor(@Inject(CONTRACTOR_IDENTITY_PORT) private readonly identity: ContractorIdentityPort) {}

  @Post()
  @HttpCode(200)
  @OperationId('registerContractor')
  @Command({ operation: 'registerContractor' })
  async register(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['BidContractorRegister']): Promise<CommandResult> {
    const now = new Date();
    requireTenantWide(access, MANAGE_PERMISSION, now);
    const created = await this.contractors.register(
      scope.tx,
      { taxIdentifier: body.tax_identifier, legalName: body.legal_name, legalForm: body.legal_form, profileDocumentId: body.profile_document_id, masterRecordId: body.master_record_id },
      scope.tenant.membershipId,
    );
    const row = (await this.contractors.find(scope.tx, created.id)) as ContractorRow;
    await scope.audit({
      action: 'contractor.registered',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      diff: { tax_identifier: maskTaxIdentifier(row.taxIdentifier), legal_form: row.legalForm, master_record_id: created.masterRecordId, profile_document_id: body.profile_document_id },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'bid.contractor.registered.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        contractor_id: created.id,
        version: created.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
        master_record_id: created.masterRecordId,
        verification_status: row.verificationStatus,
      },
      eventKey: `${RESOURCE_TYPE}:${created.id}:${created.version}`,
    });
    return commandResult(scope, row.verificationStatus, created.version, created.id);
  }

  @Post(':id/verification')
  @HttpCode(200)
  @OperationId('verifyContractor')
  @Command({ operation: 'verifyContractor', versioned: true })
  async verify(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['BidContractorVerify'],
  ): Promise<CommandResult> {
    const now = new Date();
    requireTenantWide(access, VERIFY_PERMISSION, now);
    const before = await this.contractors.find(scope.tx, id);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // The refusals that need no outside answer come first, so a decision that cannot be taken never asks the register.
    this.contractors.assertDecidable(before, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    const lookup = body.decision === 'VERIFIED' ? await this.lookup(before) : undefined;
    const done = await this.contractors.verify(
      scope.tx,
      id,
      scope.expectedVersion ?? 0,
      { decision: body.decision, evidenceDocumentId: body.verification_evidence_document_id, lookup },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: body.decision === 'VERIFIED' ? 'contractor.verified' : 'contractor.rejected',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      diff: {
        tax_identifier: maskTaxIdentifier(done.row.taxIdentifier),
        decision: body.decision,
        verification_basis: done.row.verificationBasis,
        verification_evidence_document_id: body.verification_evidence_document_id,
        identity_lookup: done.row.lookup === null ? null : { adapter_status: done.row.lookup.adapterStatus, outcome: done.row.lookup.outcome },
        master_record_id: done.row.masterRecordId,
      },
    });
    // The contract names one event for the registry's decision; a rejection is in the audit trail and tells no consumer anything.
    if (body.decision === 'VERIFIED') {
      await scope.emit({
        aggregateType: RESOURCE_TYPE,
        aggregateId: id,
        aggregateVersion: done.version,
        type: 'bid.contractor.verified.v1',
        schemaVersion: 1,
        payload: {
          tenant_id: scope.tenant.tenantId,
          contractor_id: id,
          version: done.version,
          actor_id: scope.tenant.membershipId,
          occurred_at: now.toISOString(),
          master_record_id: done.row.masterRecordId,
          verification_basis: done.row.verificationBasis,
        },
        eventKey: `${RESOURCE_TYPE}:${id}:${done.version}`,
      });
    }
    return commandResult(scope, done.row.verificationStatus, done.version, id);
  }

  @Post(':id/restrictions')
  @HttpCode(200)
  @OperationId('recordContractorRestriction')
  @Command({ operation: 'recordContractorRestriction' })
  async restrict(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['BidRestriction'],
  ): Promise<CommandResult> {
    const now = new Date();
    requireTenantWide(access, VERIFY_PERMISSION, now);
    const recorded = await this.contractors.recordRestriction(
      scope.tx,
      id,
      { kind: body.kind, effectiveFrom: body.effective_from, effectiveUntil: body.effective_until, decisionDocumentId: body.decision_document_id, note: body.note },
      scope.tenant.membershipId,
    );
    const diff = restrictionDiff({ kind: body.kind, effectiveFrom: body.effective_from, effectiveUntil: body.effective_until, decisionDocumentId: body.decision_document_id });
    await scope.audit({ action: 'contractor.restriction_recorded', resourceType: RESOURCE_TYPE, resourceId: id, diff: { restriction_id: recorded.id, ...diff } });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: recorded.version,
      type: 'bid.contractor.restricted.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, contractor_id: id, restriction_id: recorded.id, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), ...diff },
      // A restriction is its own record: the event key is the restriction, never the contractor's version.
      eventKey: `contractor-restriction:${recorded.id}`,
    });
    return commandResult(scope, 'RECORDED', recorded.version, recorded.id);
  }

  /**
   * What the official lookup says about the tax id, recorded as the adapter gave it. A failing or unbound register never stops a
   * verification on evidence: the outcome is UNAVAILABLE. An adapter whose own status is VERIFIED that says the tax id is unknown, or
   * registered under another name, does stop it: the evidence and the register contradict each other and a person must look again.
   */
  private async lookup(row: ContractorRow): Promise<LookupRecord> {
    let outcome: LookupRecord['outcome'];
    let checkedAt: Date;
    try {
      const answer = await this.identity.lookup(row.taxIdentifier, row.legalName);
      outcome = answer.outcome;
      checkedAt = answer.checkedAt;
    } catch (error) {
      this.logger.error(error);
      outcome = 'UNAVAILABLE';
      checkedAt = new Date();
    }
    if (this.identity.adapterStatus === 'VERIFIED' && (outcome === 'NOT_FOUND' || outcome === 'NAME_MISMATCH')) {
      throw new DomainError('TAX_ID_INVALID', 409, 'tax_identifier');
    }
    return { adapterStatus: this.identity.adapterStatus, outcome, checkedAt: checkedAt.toISOString() };
  }
}

/**
 * The registry for reading (BID-01, BID-02): staff see every contractor of the tenant, a guest contractor sees the one of their invitation.
 * The tax id is covered, and the people and the documents behind a decision are left out, unless the caller holds `bid.contractor.read`
 * over the whole tenant.
 */
@Controller('resources/contractor')
export class ContractorReadsController {
  private readonly contractors = new BidContractorStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_contractor')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const { rows, inForce, rights } = await this.database.withTenant(tenant, async (tx) => {
      const caller = await this.contractors.callerOf(tx, tenant.membershipId);
      const found = await this.contractors.list(tx, caller.guest ? caller.contractorId : null, { limit: request.limit + 1, after: request.after });
      return {
        rows: found,
        inForce: await this.contractors.restrictionsInForce(tx, found.slice(0, request.limit).map((row) => row.id)),
        rights: { full: !caller.guest && holdsTenantWide(access, FULL_READ_PERMISSION, now) },
      };
    });
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((row) => contractorLineView(row, inForce.get(row.id), rights)),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_contractor_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const view = await this.database.withTenant(tenant, async (tx) => {
      const caller = await this.contractors.callerOf(tx, tenant.membershipId);
      // A contractor another guest or another tenant holds is indistinguishable from one that does not exist.
      if (caller.guest && caller.contractorId !== id) return undefined;
      const row = await this.contractors.find(tx, id);
      if (row === undefined) return undefined;
      const restrictions: RestrictionRow[] = (await this.contractors.restrictionsOf(tx, [id])).get(id) ?? [];
      const inForce = (await this.contractors.restrictionsInForce(tx, [id])).get(id);
      return contractorDetailView(row, restrictions, inForce, { full: !caller.guest && holdsTenantWide(access, FULL_READ_PERMISSION, now) });
    });
    if (view === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return view;
  }
}
