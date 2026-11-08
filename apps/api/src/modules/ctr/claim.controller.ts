import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidContractorStore, BidWorkflowReads, CtrClaimStore, CtrClaimTermStore, CtrRegisterPolicy, TenantDatabase, contractScope } from '@machvon/db';
import type { ClaimFilter, ClaimMove, ClaimTermMove, ContractScopes } from '@machvon/db';
import { CLAIM_SIDES, CONTRACT_CLAIM_STATUSES, DomainError, LIMITATION_STATUSES } from '@machvon/kernel';
import type { ClaimSide, ContractClaimStatus, EffectiveAccess, LimitationStatus, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { claimDto, claimLineDto, ruleBasisDto, templateDto, termDto, totalsDto } from './claim-view';
import { placeRefs, reaches } from './contract.controller';

const CLASSIFICATION = 'INTERNAL';
const CLAIM_RESOURCE = 'contract_claim';
const TERM_RESOURCE = 'contract_claim_term';

/** The scopes a command is judged by: the permission of the command decides, `claim.read` tells a refusal from a miss. */
const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, PERMISSIONS.getClaim, now) });

const people = new BidWorkflowReads();

function flag(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') throw new DomainError('VALIDATION_FAILED', 422, field);
  return value === 'true';
}

function word<T extends string>(value: unknown, field: string, allowed: readonly string[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value as T;
}

function uuidOf(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value.toLowerCase();
}

/**
 * The limitation terms of the claims of a contract (CTR-34, G1-9). A term is entered from the clauses of the signed contract and proposed by one person; a second person approves it (403 `SELF_APPROVAL_DENIED`).
 * Only an approved term gives the claims of a side a limitation clock; the register never assumes one.
 */
@Controller()
export class ClaimTermController {
  private readonly terms = new CtrClaimTermStore();

  @Post('contracts/:id/claim-terms')
  @HttpCode(200)
  @OperationId('proposeClaimTerm')
  @Command({ operation: 'proposeClaimTerm' })
  async propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrClaimTermPropose']): Promise<CommandResult> {
    const done = await this.terms.propose(
      scope.tx,
      id.toLowerCase(),
      {
        claimant_side: body.claimant_side,
        notice_days: body.notice_days,
        particulars_days: body.particulars_days,
        response_days: body.response_days,
        settlement_days: body.settlement_days,
        basis: body.basis,
        particulars_from: body.particulars_from,
        bar_effect: body.bar_effect,
        clause_reference: body.clause_reference,
        basisDocumentVersionId: body.basis_document_version_id,
        templateCode: body.template_code,
      },
      scope.tenant.membershipId,
      scopesFor(access, PERMISSIONS.proposeClaimTerm, new Date()),
    );
    await this.written(scope, done, 'ctr.claim_term.proposed.v1', 'claim_term.proposed');
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('claim-terms/:id/decision')
  @HttpCode(200)
  @OperationId('decideClaimTerm')
  @Command({ operation: 'decideClaimTerm', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrClaimTermDecision']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.terms.decide(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.decision, body.note, scope.tenant.membershipId, scopesFor(access, PERMISSIONS.decideClaimTerm, now), now);
    await this.written(scope, done, 'ctr.claim_term.decided.v1', 'claim_term.decided');
    return commandResult(scope, done.status, done.version, done.id);
  }

  private async written(scope: CommandScope, done: ClaimTermMove, type: string, action: string): Promise<void> {
    const facts = { contract_id: done.contractId, contract_code: done.contractCode, claimant_side: done.claimantSide, superseded_id: done.supersededId, bound_claims: done.boundClaimIds.length };
    await scope.audit({ action: `ctr.${action}`, resourceType: TERM_RESOURCE, resourceId: done.id, classification: CLASSIFICATION, diff: { from_status: done.fromStatus, to_status: done.status, ...facts, bound_claim_ids: done.boundClaimIds } });
    await scope.emit({
      aggregateType: TERM_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, term_id: done.id, status: done.status, from_status: done.fromStatus, ...facts, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: new Date().toISOString() },
      eventKey: `${TERM_RESOURCE}:${done.id}:${done.version}`,
    });
  }
}

/**
 * The commands on a claim (CTR-32, CTR-33, G1-9): registering it with the day the claimant became aware of the event, the steps of its timeline (each on the day it happened), the decision on a settlement
 * (somebody other than the proposer), the declaration that the claim is barred (only when a limitation day passed, the term says that bars the claim, and by somebody other than the person who registered it),
 * and the links to a change order and a payment request of the same contract.
 */
@Controller()
export class ClaimController {
  private readonly claims = new CtrClaimStore();

  @Post('contracts/:id/claims')
  @HttpCode(200)
  @OperationId('registerClaim')
  @Command({ operation: 'registerClaim' })
  async register(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrClaimRegister']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.claims.register(
      scope.tx,
      id.toLowerCase(),
      {
        claimantSide: body.claimant_side,
        kind: body.kind,
        title: body.title,
        eventDescription: body.event_description,
        eventOn: body.event_on,
        awarenessOn: body.awareness_on,
        claimedAmountVnd: body.claimed_amount_vnd,
        claimedDays: body.claimed_days,
        responsibleMembershipId: body.responsible_membership_id,
        evidenceDocumentVersionId: body.evidence_document_version_id,
      },
      scope.tenant.membershipId,
      scopesFor(access, PERMISSIONS.registerClaim, now),
      now,
    );
    await this.written(scope, done, 'ctr.claim.registered.v1', 'claim.registered', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('claims/:id/steps')
  @HttpCode(200)
  @OperationId('recordClaimStep')
  @Command({ operation: 'recordClaimStep', versioned: true })
  async step(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrClaimStepRecord']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.claims.recordStep(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      {
        kind: body.kind,
        occurredOn: body.occurred_on,
        note: body.note,
        decision: body.decision,
        claimedAmountVnd: body.claimed_amount_vnd,
        claimedDays: body.claimed_days,
        settledAmountVnd: body.settled_amount_vnd,
        grantedDays: body.granted_days,
        evidenceDocumentVersionId: body.evidence_document_version_id,
      },
      scope.tenant.membershipId,
      scopesFor(access, PERMISSIONS.recordClaimStep, now),
      now,
    );
    await this.written(scope, done, 'ctr.claim.updated.v1', 'claim.step_recorded', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('claims/:id/settlement-decision')
  @HttpCode(200)
  @OperationId('decideClaimSettlement')
  @Command({ operation: 'decideClaimSettlement', versioned: true })
  async decideSettlement(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrClaimSettlementDecision']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.claims.decideSettlement(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.decision, body.note, scope.tenant.membershipId, scopesFor(access, PERMISSIONS.decideClaimSettlement, now), now);
    await this.written(scope, done, 'ctr.claim.updated.v1', 'claim.settlement_decided', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('claims/:id/bar')
  @HttpCode(200)
  @OperationId('declareClaimBar')
  @Command({ operation: 'declareClaimBar', versioned: true })
  async bar(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrClaimBarDeclare']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.claims.declareBar(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.reason, body.evidence_document_version_id, scope.tenant.membershipId, scopesFor(access, PERMISSIONS.declareClaimBar, now), now);
    await this.written(scope, done, 'ctr.claim.updated.v1', 'claim.bar_declared', now);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('claims/:id/links')
  @HttpCode(200)
  @OperationId('linkClaim')
  @Command({ operation: 'linkClaim', versioned: true })
  async link(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrClaimLinks']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.claims.link(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, { changeRequestId: body.change_request_id, paymentRequestId: body.payment_request_id }, scopesFor(access, PERMISSIONS.linkClaim, now));
    await this.written(scope, done, 'ctr.claim.updated.v1', 'claim.linked', now, { change_request_id: body.change_request_id ?? null, payment_request_id: body.payment_request_id ?? null });
    return commandResult(scope, done.status, done.version, done.id);
  }

  /** The audit row and the event of a move: ids, states, the step and the figures; the words of the person stay in the timeline. */
  private async written(scope: CommandScope, done: ClaimMove, type: string, action: string, now: Date, extra: Record<string, unknown> = {}): Promise<void> {
    const facts = {
      contract_id: done.contractId,
      contract_code: done.contractCode,
      project_id: done.projectId,
      code: done.code,
      claimant_side: done.claimantSide,
      kind: done.kind,
      step: done.step,
      step_ordinal: done.stepOrdinal,
      term_id: done.termId,
      claimed_amount_vnd: done.claimedAmountVnd,
      settled_amount_vnd: done.settledAmountVnd,
      claimed_days: done.claimedDays,
      granted_days: done.grantedDays,
      ...extra,
    };
    await scope.audit({ action: `ctr.${action}`, resourceType: CLAIM_RESOURCE, resourceId: done.id, classification: CLASSIFICATION, diff: { from_status: done.fromStatus, to_status: done.status, ...facts } });
    await scope.emit({
      aggregateType: CLAIM_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, claim_id: done.id, status: done.status, from_status: done.fromStatus, ...facts, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${CLAIM_RESOURCE}:${done.id}:${done.version}`,
    });
  }
}

/**
 * The reads of the claim register: the terms of a contract with the templates, the register with its totals and the record of a claim. For the staff who hold `claim.read` over the contract; never for a contractor
 * of the contract (403 `SCOPE_DENIED`), and 404 for what is outside the scope of the caller. The deadlines and the limitation are computed on the day of the read, from the term and the dates of the timeline.
 */
@Controller()
export class ClaimReadsController {
  private readonly claims = new CtrClaimStore();
  private readonly terms = new CtrClaimTermStore();
  private readonly policy = new CtrRegisterPolicy();
  private readonly contractors = new BidContractorStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('contracts/:id/claim-terms')
  @OperationId('listClaimTerms')
  async listTerms(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const contractId = id.toLowerCase();
    const read = contractScope(access, PERMISSIONS.listClaimTerms, now);
    return this.database.withTenant(tenant, async (tx) => {
      if ((await this.contractors.callerOf(tx, tenant.membershipId)).guest) throw new DomainError('SCOPE_DENIED', 403);
      const items = await this.terms.list(tx, contractId, { read });
      const templates = await this.policy.templates(tx, now);
      const header = await tx.query<{ code: string }>('select code from machvon.contract where id = $1::uuid', [contractId]);
      const names = await people.names(tx, items.flatMap((row) => [row.proposedBy, row.decidedBy]));
      const place = (await this.claimsPlace(tx, contractId)) ?? undefined;
      const mayDecide = place !== undefined && reaches(access, PERMISSIONS.decideClaimTerm, place, now);
      const mayPropose = place !== undefined && reaches(access, PERMISSIONS.proposeClaimTerm, place, now);
      return {
        items: items.map((row) => termDto(row, names, mayDecide)),
        templates: templates.map(templateDto),
        contract: { id: contractId, code: header[0]?.code ?? '' },
        can_propose: mayPropose,
        as_of: now.toISOString(),
      };
    });
  }

  @Get('claims')
  @OperationId('listClaims')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('contract_id') contractId?: unknown,
    @Query('status') status?: unknown,
    @Query('claimant_side') side?: unknown,
    @Query('open') open?: unknown,
    @Query('limitation') limitation?: unknown,
    @Query('mine') mine?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, cursor);
    const filter: ClaimFilter = {
      contractId: uuidOf(contractId, 'contract_id'),
      status: word<ContractClaimStatus>(status, 'status', CONTRACT_CLAIM_STATUSES),
      claimantSide: word<ClaimSide>(side, 'claimant_side', CLAIM_SIDES),
      open: flag(open, 'open'),
      limitation: word<LimitationStatus>(limitation, 'limitation', LIMITATION_STATUSES),
      responsibleMembershipId: flag(mine, 'mine') === true ? tenant.membershipId : undefined,
    };
    const now = new Date();
    const read = contractScope(access, PERMISSIONS.listClaims, now);
    return this.database.withTenant(tenant, async (tx) => {
      if ((await this.contractors.callerOf(tx, tenant.membershipId)).guest) throw new DomainError('SCOPE_DENIED', 403);
      const page = await this.claims.list(tx, filter, read, { limit: request.limit, after: request.after?.id }, now);
      const names = await people.names(tx, page.rows.map((row) => row.claim.responsibleMembershipId));
      const last = page.rows[page.rows.length - 1];
      return {
        items: page.rows.map((row) => claimLineDto(row, names)),
        next_cursor: page.nextCursor === null || last === undefined ? null : encodeCursor({ code: 'claim', id: page.nextCursor }),
        totals: totalsDto(page.totals),
        truncated: page.truncated,
        calendar_published: page.calendarPublished,
        policy: ruleBasisDto(page.policy),
        as_of: page.asOf,
      };
    });
  }

  @Get('claims/:id')
  @OperationId('getClaim')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const read = contractScope(access, PERMISSIONS.getClaim, now);
    return this.database.withTenant(tenant, async (tx) => {
      if ((await this.contractors.callerOf(tx, tenant.membershipId)).guest) throw new DomainError('SCOPE_DENIED', 403);
      const detail = await this.claims.get(tx, id.toLowerCase(), read, now);
      const names = await people.names(tx, [detail.row.registeredBy, detail.row.responsibleMembershipId, detail.row.settlementProposedBy, detail.row.settlementApprovedBy, detail.term?.proposedBy, detail.term?.decidedBy, ...detail.steps.map((step) => step.actorId)]);
      const refs = placeRefs(detail.row.reach);
      const rights = {
        manage: reaches(access, PERMISSIONS.recordClaimStep, refs, now),
        settle: reaches(access, PERMISSIONS.decideClaimSettlement, refs, now),
        bar: reaches(access, PERMISSIONS.declareClaimBar, refs, now),
      };
      return claimDto(detail, names, rights, now.toISOString(), reaches(access, PERMISSIONS.decideClaimTerm, refs, now));
    });
  }

  /** The place of a contract (for the rights of the caller over it), or null when the contract is not in the tenant. */
  private async claimsPlace(tx: Parameters<Parameters<TenantDatabase['withTenant']>[1]>[0], contractId: string): Promise<ReturnType<typeof placeRefs> | null> {
    const rows = await tx.query<{ project_id: string; owner_unit_id: string; owner_unit_path: string; investor_unit_id: string | null; investor_unit_path: string | null }>(
      `select p.id as project_id, ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
         from machvon.contract c join machvon.project p on p.tenant_id = c.tenant_id and p.id = c.project_id
         join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id where c.id = $1::uuid`,
      [contractId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return placeRefs({ contractId, projectId: row.project_id, ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path }, investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path } });
  }
}
