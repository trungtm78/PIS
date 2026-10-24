import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidContractorStore, CtrGuaranteeStore, TenantDatabase, contractScope } from '@machvon/db';
import type { ContractPlace, ContractScopes, GuaranteeMove } from '@machvon/db';
import { DomainError, vietnamDateOf } from '@machvon/kernel';
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
import { LEDGER_PERMISSION, placeRefs, reaches } from './contract.controller';
import { expiringView, guaranteeView } from './guarantee-view';
import type { GuaranteeRights } from './guarantee-view';

const MANAGE_PERMISSION = PERMISSIONS.registerGuarantee;
const EXTEND_PERMISSION = PERMISSIONS.extendGuarantee;
const VERIFY_PERMISSION = PERMISSIONS.verifyGuarantee;
const RELEASE_PERMISSION = PERMISSIONS.releaseGuarantee;
const READ_PERMISSION = PERMISSIONS.get_resources_guarantee;
const EXPIRING_PERMISSION = PERMISSIONS.listExpiringGuarantees;
const RESOURCE_TYPE = 'guarantee';
const CLASSIFICATION = 'INTERNAL';
const DEFAULT_WITHIN_DAYS = 30;
const MAX_WITHIN_DAYS = 365;
const WITHIN_DAYS = /^(?:0|[1-9]\d{0,2})$/;

/** The scope a command is judged by (its own permission) and the one that tells a refusal from a miss (the right to read). */
const scopesOf = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, READ_PERMISSION, now) });

/** What the caller may see of a guarantee of `place`: the staff see how it was checked, a guest contractor does not, and the ledger follows `ledger.read`. */
function rightsFor(access: EffectiveAccess, guest: boolean, place: ContractPlace, now: Date): GuaranteeRights {
  return { internal: !guest, ledger: reaches(access, LEDGER_PERMISSION, placeRefs(place), now) };
}

/** The common part of the audit row and of the event of a command on a guarantee: the figures, never the number or the issuer. */
function figuresOf(move: GuaranteeMove): Record<string, unknown> {
  return { contract_id: move.contractId, kind: move.kind, amount_vnd: move.amountVnd, expires_at: move.expiresAt, status: move.status };
}

/**
 * The guarantees of a contract (ST-CTR-003, CTR 3.5): registered by the contract officer, verified with the issuer by another person,
 * extended by a replacement that is verified again, and released by the chief accountant against evidence. Status, expiry and the amount
 * of a guarantee have no write path here other than these four commands (CTR section 7). Each acts on a guarantee inside the scope of its own
 * permission over the contract: one the caller cannot see does not exist for them.
 */
@Controller()
export class GuaranteeController {
  private readonly guarantees = new CtrGuaranteeStore();

  private async emitMove(scope: CommandScope, move: GuaranteeMove, type: string, now: Date, extra: Record<string, unknown> = {}): Promise<void> {
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: move.id,
      aggregateVersion: move.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, guarantee_id: move.id, version: move.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), ...figuresOf(move), ...extra },
      eventKey: `${RESOURCE_TYPE}:${move.id}:${move.version}`,
    });
  }

  @Post('contracts/:id/guarantees')
  @HttpCode(200)
  @OperationId('registerGuarantee')
  @Command({ operation: 'registerGuarantee' })
  async register(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) contractId: string,
    @Body() body: Schemas['CtrRegisterGuarantee'],
  ): Promise<CommandResult> {
    const now = new Date();
    const move = await this.guarantees.register(
      scope.tx,
      contractId,
      {
        kind: body.kind,
        partyId: body.party_id,
        issuer: body.issuer,
        guaranteeNo: body.guarantee_no,
        amountVnd: body.amount_vnd,
        validFrom: body.valid_from,
        expiresAt: body.expires_at,
        documentVersionId: body.document_version_id,
      },
      scope.tenant.membershipId,
      scopesOf(access, MANAGE_PERMISSION, now),
      now,
    );
    await scope.audit({ action: 'guarantee.registered', resourceType: RESOURCE_TYPE, resourceId: move.id, classification: CLASSIFICATION, diff: figuresOf(move) });
    await this.emitMove(scope, move, 'ctr.guarantee.registered.v1', now);
    return commandResult(scope, move.status, move.version, move.id);
  }

  @Post('guarantees/:id/verify')
  @HttpCode(200)
  @OperationId('verifyGuarantee')
  @Command({ operation: 'verifyGuarantee', versioned: true })
  async verify(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['CtrVerifyGuarantee'],
  ): Promise<CommandResult> {
    const now = new Date();
    const move = await this.guarantees.verify(
      scope.tx,
      id,
      scope.expectedVersion ?? 0,
      { outcome: body.outcome, method: body.method, evidenceDocumentVersionId: body.evidence_document_version_id },
      scope.tenant.membershipId,
      scopesOf(access, VERIFY_PERMISSION, now),
      now,
    );
    await scope.audit({
      action: 'guarantee.verified',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      classification: CLASSIFICATION,
      diff: { ...figuresOf(move), from_status: move.fromStatus, outcome: body.outcome, evidence_document_version_id: body.evidence_document_version_id.toLowerCase() },
    });
    await this.emitMove(scope, move, 'ctr.guarantee.verified.v1', now, { outcome: body.outcome });
    return commandResult(scope, move.status, move.version, id);
  }

  @Post('guarantees/:id/extend')
  @HttpCode(200)
  @OperationId('extendGuarantee')
  @Command({ operation: 'extendGuarantee', versioned: true })
  async extend(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['CtrExtendGuarantee'],
  ): Promise<CommandResult> {
    const now = new Date();
    const move = await this.guarantees.extend(
      scope.tx,
      id,
      scope.expectedVersion ?? 0,
      { newExpiresAt: body.new_expires_at, newGuaranteeNo: body.new_guarantee_no, documentVersionId: body.document_version_id },
      scope.tenant.membershipId,
      scopesOf(access, EXTEND_PERMISSION, now),
      now,
    );
    // The old guarantee is superseded and keeps its expiry; the answer is the replacement, which waits for its own verification.
    await scope.audit({ action: 'guarantee.extended', resourceType: RESOURCE_TYPE, resourceId: move.id, classification: CLASSIFICATION, diff: { ...figuresOf(move), superseded_id: move.supersededId } });
    await this.emitMove(scope, move, 'ctr.guarantee.extended.v1', now, { superseded_id: move.supersededId });
    return commandResult(scope, move.status, move.version, move.id);
  }

  @Post('guarantees/:id/release')
  @HttpCode(200)
  @OperationId('releaseGuarantee')
  @Command({ operation: 'releaseGuarantee', versioned: true })
  async release(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['CtrReleaseGuarantee'],
  ): Promise<CommandResult> {
    const now = new Date();
    const move = await this.guarantees.release(scope.tx, id, scope.expectedVersion ?? 0, { releaseEvidenceId: body.release_evidence_id, reason: body.reason }, scope.tenant.membershipId, scopesOf(access, RELEASE_PERMISSION, now), now);
    await scope.audit({
      action: 'guarantee.released',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      classification: CLASSIFICATION,
      reason: body.reason.trim(),
      diff: { ...figuresOf(move), from_status: move.fromStatus, release_evidence_id: body.release_evidence_id.toLowerCase() },
    });
    await this.emitMove(scope, move, 'ctr.guarantee.released.v1', now);
    return commandResult(scope, move.status, move.version, id);
  }
}

/**
 * The guarantees that expire soon (CTR-05, listExpiringGuarantees): the ACTIVE ones within `within_days` calendar days in Vietnam (30 by
 * default, at most 365), the soonest first. A read model of its own, filtered by the scope of `guarantee.read` like the register.
 */
@Controller('guarantees/expiring')
export class ExpiringGuaranteesController {
  private readonly guarantees = new CtrGuaranteeStore();
  private readonly contractors = new BidContractorStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('listExpiringGuarantees')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('within_days') withinDays?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string; within_days: number }> {
    if (withinDays !== undefined && (typeof withinDays !== 'string' || !WITHIN_DAYS.test(withinDays) || Number(withinDays) > MAX_WITHIN_DAYS)) throw new DomainError('VALIDATION_FAILED', 422, 'within_days');
    const days = withinDays === undefined ? DEFAULT_WITHIN_DAYS : Number(withinDays);
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const { rows, guest } = await this.database.withTenant(tenant, async (tx) => ({
      rows: await this.guarantees.expiring(tx, contractScope(access, EXPIRING_PERMISSION, now), vietnamDateOf(now), days, { limit: request.limit + 1, after: request.after }),
      guest: (await this.contractors.callerOf(tx, tenant.membershipId)).guest,
    }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((row) => expiringView(row, rightsFor(access, guest, row.reach, now))),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.key, id: last.id }) : null,
      as_of: now.toISOString(),
      within_days: days,
    };
  }
}

/** The register of guarantees (CTR-05): a DTO allowlist filtered by the unit tree, the project and the contract grants; one outside the scope does not exist for the caller. */
@Controller('resources/guarantee')
export class GuaranteeReadsController {
  private readonly guarantees = new CtrGuaranteeStore();
  private readonly contractors = new BidContractorStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_guarantee')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const { rows, guest } = await this.database.withTenant(tenant, async (tx) => ({
      rows: await this.guarantees.list(tx, contractScope(access, READ_PERMISSION, now), { limit: request.limit + 1, after: request.after }),
      guest: (await this.contractors.callerOf(tx, tenant.membershipId)).guest,
    }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((row) => guaranteeView(row, rightsFor(access, guest, row.reach, now))),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.key, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_guarantee_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const view = await this.database.withTenant(tenant, async (tx) => {
      const row = await this.guarantees.find(tx, id, contractScope(access, READ_PERMISSION, now));
      if (row === undefined) return undefined;
      const guest = (await this.contractors.callerOf(tx, tenant.membershipId)).guest;
      return guaranteeView(row, rightsFor(access, guest, row.reach, now));
    });
    // A guarantee in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (view === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return view;
  }
}
