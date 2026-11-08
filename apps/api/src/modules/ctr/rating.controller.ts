import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import {
  BidContractorStore,
  CtrRatingStore,
  GovernancePolicyPort,
  HomeWorkCalendars,
  RATING_NOTIFY_PERMISSION,
  RATING_PROPOSE_PERMISSION,
  RATING_READ_PERMISSION,
  RATING_RESPOND_PERMISSION,
  SCORECARD_EVALUATE_PERMISSION,
  TenantDatabase,
  WORK_CALENDAR_CODE,
  contractScope,
  engagementScope,
} from '@machvon/db';
import type { ContractScopes, FactQuery, RatingProposalRow, RatingRule } from '@machvon/db';
import {
  DomainError,
  RATING_CRITERIA,
  assertRatingAdoption,
  assertRatingNotify,
  assertRatingProposal,
  assertRatingResponse,
  ratingDefaults,
  ratingParams,
  ratingResponseClock,
  vietnamDateOf,
} from '@machvon/kernel';
import type { EffectiveAccess, RatingState, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { placeRefs, reaches } from './contract.controller';

const RESOURCE = 'contract_rating_proposal';
const CLASSIFICATION = 'INTERNAL';
const LIST_DEFAULT = 50;
const LIST_MAX = 200;
const STATES: readonly string[] = ['PROPOSED', 'NOTIFIED', 'RESPONDED', 'ADOPTED', 'WITHDRAWN'];

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, RATING_READ_PERMISSION, now) });

/**
 * The proposals of a rating of the performance of a contractor (CA-3, CPARS in manner): the score is proposed from the data, a second person tells the contractor (which opens the posting duty CONTRACTOR_RESPONSE), the
 * contractor answers inside the window, and a person other than the proposer adopts it into the evaluation of CTR-23. Each command acts on a contract inside the scope of its own permission: a contract the caller reads
 * but may not act on is 403 `SCOPE_DENIED`, one they cannot read is 404. The trail and the events carry ids, the contract, the state and the figures; the words of the people stay in the table.
 */
@Controller()
export class RatingController {
  private readonly ratings = new CtrRatingStore();
  private readonly policy = new GovernancePolicyPort();

  private async ruleOf(scope: CommandScope, now: Date): Promise<RatingRule> {
    const rule = await this.policy.get(scope.tx, 'CONTRACT_PERFORMANCE_RATING', 'DEFAULT', vietnamDateOf(now));
    return { params: rule === undefined ? ratingDefaults() : ratingParams(rule.params), version: rule?.version ?? 0, source: rule === undefined ? 'DEFAULT' : 'RULE' };
  }

  @Post('contracts/:id/rating-proposals')
  @HttpCode(200)
  @OperationId('proposeContractRating')
  @Command({ operation: 'proposeContractRating' })
  async propose(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrProposeContractRating']): Promise<CommandResult> {
    const now = new Date();
    const input = assertRatingProposal(body);
    const base: FactQuery = { asOf: vietnamDateOf(now), scope: contractScope(access, 'contract.read', now), ledgerScope: contractScope(access, 'ledger.read', now), filters: {} };
    const row = await this.ratings.propose(scope.tx, id.toLowerCase(), input, scope.tenant.membershipId, scopesFor(access, RATING_PROPOSE_PERMISSION, now), base, { engagements: engagementScope(access, PERMISSIONS.listAuditEngagements, now) }, await this.ruleOf(scope, now));
    await this.write(scope, row, 'proposed', 'ctr.contract_rating.proposed.v1');
    return commandResult(scope, row.state, row.version, row.id);
  }

  @Post('contract-rating-proposals/:id/notify')
  @HttpCode(200)
  @OperationId('notifyContractRating')
  @Command({ operation: 'notifyContractRating', versioned: true })
  async notify(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrNotifyContractRating']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.ratings.notify(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, assertRatingNotify(body), scope.tenant.membershipId, now, scopesFor(access, RATING_NOTIFY_PERMISSION, now));
    await this.write(scope, done.row, 'notified', 'ctr.contract_rating.notified.v1', { egp_obligation_id: done.obligationId, egp_fact: 'CONTRACTOR_NOTIFIED' });
    return commandResult(scope, done.row.state, done.row.version, done.row.id);
  }

  @Post('contract-rating-proposals/:id/response')
  @HttpCode(200)
  @OperationId('recordContractRatingResponse')
  @Command({ operation: 'recordContractRatingResponse', versioned: true })
  async respond(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrRecordContractRatingResponse']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.ratings.respond(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, assertRatingResponse(body, vietnamDateOf(now)), scope.tenant.membershipId, now, scopesFor(access, RATING_RESPOND_PERMISSION, now));
    await this.write(scope, done.row, 'responded', 'ctr.contract_rating.responded.v1', { response_kind: done.row.responseKind, late: done.row.responseDueAt !== null && done.row.responseReceivedOn !== null && done.row.responseReceivedOn > vietnamDateOf(new Date(done.row.responseDueAt)) });
    return commandResult(scope, done.row.state, done.row.version, done.row.id);
  }

  @Post('contract-rating-proposals/:id/adopt')
  @HttpCode(200)
  @OperationId('adoptContractRating')
  @Command({ operation: 'adoptContractRating', versioned: true })
  async adopt(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrAdoptContractRating']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.ratings.adopt(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, assertRatingAdoption(body), scope.tenant.membershipId, now, scopesFor(access, SCORECARD_EVALUATE_PERMISSION, now));
    await this.write(scope, done.row, 'adopted', 'ctr.contract_rating.adopted.v1', { evaluation_id: done.evaluationId });
    return commandResult(scope, done.row.state, done.row.version, done.row.id);
  }

  @Post('contract-rating-proposals/:id/withdraw')
  @HttpCode(200)
  @OperationId('withdrawContractRating')
  @Command({ operation: 'withdrawContractRating', versioned: true })
  async withdraw(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrWithdrawContractRating']): Promise<CommandResult> {
    const now = new Date();
    const reason = typeof body.reason === 'string' ? body.reason.normalize('NFC').trim() : '';
    if (reason.length < 10 || reason.length > 2000) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const done = await this.ratings.withdraw(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, reason, scope.tenant.membershipId, now, scopesFor(access, RATING_PROPOSE_PERMISSION, now));
    await this.write(scope, done.row, 'withdrawn', 'ctr.contract_rating.withdrawn.v1');
    return commandResult(scope, done.row.state, done.row.version, done.row.id);
  }

  private async write(scope: CommandScope, row: RatingProposalRow, action: string, type: string, extra: Record<string, unknown> = {}): Promise<void> {
    const facts = {
      contract_id: row.contractId,
      contract_code: row.contractCode,
      project_id: row.projectId,
      contractor_id: row.contractorId,
      evaluation_kind: row.kind,
      period_label: row.periodLabel,
      overall_score: row.proposal.overall,
      rating: row.proposal.rating,
      rule_version: row.ruleVersion,
      inputs_sha256: row.inputsSha256,
      ...extra,
    };
    await scope.audit({ action: `ctr.contract_rating.${action}`, resourceType: RESOURCE, resourceId: row.id, classification: CLASSIFICATION, diff: { state: row.state, ...facts } });
    await scope.emit({
      aggregateType: RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, proposal_id: row.id, state: row.state, ...facts },
      eventKey: `${RESOURCE}:${row.id}:${row.version}`,
    });
  }
}

/** The reads of the proposals (CTR-32 and the rating report): inside the scope of `contractor.performance.read`; never for a contractor of the contract, whose standing is the owner's to judge. */
@Controller()
export class RatingReadsController {
  private readonly ratings = new CtrRatingStore();
  private readonly contractors = new BidContractorStore();
  private readonly calendars = new HomeWorkCalendars();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('contract-rating-proposals/:id')
  @OperationId('getContractRatingProposal')
  async read(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Schemas['CtrContractRatingProposal']> {
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      if ((await this.contractors.callerOf(tx, tenant.membershipId)).guest) throw new DomainError('SCOPE_DENIED', 403);
      const row = await this.ratings.get(tx, id.toLowerCase(), contractScope(access, RATING_READ_PERMISSION, now));
      return this.view(tx, row, tenant.membershipId, access, now);
    });
  }

  @Get('contract-rating-proposals')
  @OperationId('listContractRatingProposals')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('contract_id') contractId?: unknown,
    @Query('contractor_id') contractorId?: unknown,
    @Query('state') state?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<Schemas['CtrContractRatingProposals']> {
    const uuid = (value: unknown, field: string): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
      return value.toLowerCase();
    };
    if (state !== undefined && (typeof state !== 'string' || !STATES.includes(state))) throw new DomainError('VALIDATION_FAILED', 422, 'state');
    let size = LIST_DEFAULT;
    if (limit !== undefined) {
      if (typeof limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > LIST_MAX) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
      size = Number(limit);
    }
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      if ((await this.contractors.callerOf(tx, tenant.membershipId)).guest) throw new DomainError('SCOPE_DENIED', 403);
      const rows = await this.ratings.list(tx, { contractId: uuid(contractId, 'contract_id'), contractorId: uuid(contractorId, 'contractor_id'), state: state as RatingState | undefined }, contractScope(access, RATING_READ_PERMISSION, now), size);
      const items: Schemas['CtrContractRatingProposal'][] = [];
      for (const row of rows) items.push(await this.view(tx, row, tenant.membershipId, access, now));
      return { items, as_of: now.toISOString() };
    });
  }

  private async view(tx: Parameters<CtrRatingStore['placeOf']>[0], row: RatingProposalRow, caller: string, access: EffectiveAccess, now: Date): Promise<Schemas['CtrContractRatingProposal']> {
    const place = await this.ratings.placeOf(tx, row.contractId);
    const may = (permission: string): boolean => reaches(access, permission, placeRefs(place), now);
    let clock: Schemas['CtrContractRatingProposal']['response_clock'] = null;
    if (row.notifiedAt !== null && row.responseDueAt !== null) {
      const calendars = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
      const found = ratingResponseClock({ notifiedAt: new Date(row.notifiedAt), dueAt: new Date(row.responseDueAt), receivedOn: row.responseReceivedOn, now, calendars });
      clock = { status: found.status, due_at: found.dueAt, basis: found.basis };
    }
    const lapsed = clock?.status === 'LAPSED';
    const criteria: Record<string, { score: number | null; reason: string | null; readings: Record<string, number | string> }> = {};
    for (const criterion of RATING_CRITERIA) criteria[criterion] = { score: row.proposal.criteria[criterion].score, reason: row.proposal.criteria[criterion].reason, readings: row.proposal.criteria[criterion].readings };
    // The financial criterion, the overall score and the rating are made of the ledger: a reader without `ledger.read` over the contract is shown none of them, as in the report.
    const ledger = reaches(access, 'ledger.read', placeRefs(place), now);
    if (!ledger) criteria.financial = { score: null, reason: 'LEDGER_DENIED', readings: {} };
    return {
      id: row.id,
      contract_id: row.contractId,
      contract_code: row.contractCode,
      contractor_id: row.contractorId,
      evaluation_kind: row.kind,
      period_label: row.periodLabel,
      as_of_date: row.asOf,
      state: row.state,
      rule: { version: row.ruleVersion, source: row.ruleSource },
      criteria,
      covered: row.proposal.covered,
      overall_score: ledger ? row.proposal.overall : null,
      rating: ledger ? row.proposal.rating : null,
      inputs_sha256: row.inputsSha256,
      proposed_by: row.proposedBy,
      proposed_note: row.proposedNote,
      notified: row.notifiedAt === null ? null : { by: row.notifiedBy as string, at: row.notifiedAt, note: row.notifyNote, letter_document_version_id: row.letterDocumentVersionId },
      response_due_at: row.responseDueAt,
      response_clock: clock,
      response: row.respondedAt === null ? null : { kind: row.responseKind as string, text: row.responseText, received_on: row.responseReceivedOn as string, at: row.respondedAt, by: row.respondedBy as string, evidence_document_version_id: row.responseEvidenceDocumentVersionId },
      adopted: row.adoptedAt === null ? null : { by: row.adoptedBy as string, at: row.adoptedAt, note: row.adoptNote, evaluation_id: row.evaluationId as string, overrides: row.overrides as never },
      withdrawn: row.withdrawnAt === null ? null : { by: row.withdrawnBy as string, at: row.withdrawnAt, reason: row.withdrawReason as string },
      allowed: {
        notify: row.state === 'PROPOSED' && row.proposedBy !== caller && may(RATING_NOTIFY_PERMISSION),
        respond: row.state === 'NOTIFIED' && may(RATING_RESPOND_PERMISSION),
        adopt: (row.state === 'RESPONDED' || (row.state === 'NOTIFIED' && lapsed)) && row.proposedBy !== caller && may(SCORECARD_EVALUATE_PERMISSION),
        withdraw: row.state === 'PROPOSED' && may(RATING_PROPOSE_PERMISSION),
      },
      version: row.version,
      created_at: row.createdAt,
    };
  }
}
