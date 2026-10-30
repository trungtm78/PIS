import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  BidContractorStore,
  CtrScorecardStore,
  SCORECARD_APPROVE_PERMISSION,
  SCORECARD_EVALUATE_PERMISSION,
  SCORECARD_READ_PERMISSION,
  TenantDatabase,
  VIOLATION_CONFIRM_PERMISSION,
  VIOLATION_RECORD_PERMISSION,
  contractScope,
} from '@machvon/db';
import type { ContractScopes, ContractorScorecard, ScorecardEvaluationResult, ScorecardViolationResult } from '@machvon/db';
import { DomainError, SCORECARD_RULE, assertConfirmation, assertEvaluation, assertViolation, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { placeRefs, reaches } from './contract.controller';

const EVALUATION_RESOURCE = 'contractor_performance';
const VIOLATION_RESOURCE = 'contractor_violation';
const CLASSIFICATION = 'INTERNAL';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, SCORECARD_READ_PERMISSION, now) });

/**
 * The scorecard of a contractor and the log of its violations (ST-CTR-014, CTR 3.6, BR-CTR-11). Evaluating, approving, recording and confirming each act on a contract inside the scope of their own permission: a contract the
 * caller reads but may not act on is 403 `SCOPE_DENIED`, one they cannot read is 404. Whoever evaluated an evaluation or recorded a violation does not approve or confirm it (403 `SELF_APPROVAL_DENIED`). The trail and the events
 * carry ids, the contract, the period and the figures; the remarks, the notes and the description of a violation are the people's words and stay in the table.
 */
@Controller()
export class ScorecardController {
  private readonly scorecards = new CtrScorecardStore();

  @Post('contracts/:id/performance-evaluations')
  @HttpCode(200)
  @OperationId('evaluateContractor')
  @Command({ operation: 'evaluateContractor' })
  async evaluate(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrEvaluateContractor']): Promise<CommandResult> {
    const input = assertEvaluation(body);
    const done = await this.scorecards.evaluate(scope.tx, id.toLowerCase(), input, scope.tenant.membershipId, scopesFor(access, SCORECARD_EVALUATE_PERMISSION, new Date()));
    await this.writeEvaluation(scope, done, 'contractor_evaluation.submitted', 'ctr.contractor_evaluation.submitted.v1');
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('performance-evaluations/:id/approve')
  @HttpCode(200)
  @OperationId('approveContractorEvaluation')
  @Command({ operation: 'approveContractorEvaluation', versioned: true })
  async approve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrApproveContractorEvaluation']): Promise<CommandResult> {
    const note = body.note === undefined ? undefined : body.note.normalize('NFC').trim();
    if (note === '') throw new DomainError('VALIDATION_FAILED', 422, 'note');
    const done = await this.scorecards.approve(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, note, scope.tenant.membershipId, scopesFor(access, SCORECARD_APPROVE_PERMISSION, new Date()));
    await this.writeEvaluation(scope, done, 'contractor_evaluation.approved', 'ctr.contractor_evaluation.approved.v1');
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('contracts/:id/violations')
  @HttpCode(200)
  @OperationId('recordContractorViolation')
  @Command({ operation: 'recordContractorViolation' })
  async record(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrRecordContractorViolation']): Promise<CommandResult> {
    const now = new Date();
    const input = assertViolation(body, vietnamDateOf(now));
    const done = await this.scorecards.record(scope.tx, id.toLowerCase(), input, scope.tenant.membershipId, scopesFor(access, VIOLATION_RECORD_PERMISSION, now));
    await this.writeViolation(scope, done, 'violation.recorded', 'ctr.violation.recorded.v1');
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('violations/:id/confirm')
  @HttpCode(200)
  @OperationId('confirmContractorViolation')
  @Command({ operation: 'confirmContractorViolation', versioned: true })
  async confirm(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrConfirmContractorViolation']): Promise<CommandResult> {
    const input = assertConfirmation(body);
    const done = await this.scorecards.confirm(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, input, scope.tenant.membershipId, scopesFor(access, VIOLATION_CONFIRM_PERMISSION, new Date()));
    await this.writeViolation(scope, done, 'violation.confirmed', 'ctr.violation.confirmed.v1');
    return commandResult(scope, done.status, done.version, done.id);
  }

  private async writeEvaluation(scope: CommandScope, done: ScorecardEvaluationResult, action: string, type: string): Promise<void> {
    const facts = {
      contract_id: done.contractId,
      contract_code: done.contractCode,
      project_id: done.projectId,
      contractor_id: done.contractorId,
      evaluation_kind: done.kind,
      period_label: done.periodLabel,
      revision: done.revision,
      overall_score: done.overallScore,
      rating: done.rating,
      superseded_id: done.supersededId,
    };
    await scope.audit({ action: `ctr.${action}`, resourceType: EVALUATION_RESOURCE, resourceId: done.id, classification: CLASSIFICATION, diff: { status: done.status, ...facts } });
    await scope.emit({
      aggregateType: EVALUATION_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, evaluation_id: done.id, status: done.status, ...facts },
      eventKey: `${EVALUATION_RESOURCE}:${done.id}:${done.version}`,
    });
  }

  private async writeViolation(scope: CommandScope, done: ScorecardViolationResult, action: string, type: string): Promise<void> {
    const facts = {
      contract_id: done.contractId,
      contract_code: done.contractCode,
      project_id: done.projectId,
      contractor_id: done.contractorId,
      violation_kind: done.kind,
      severity: done.severity,
      source_module: done.sourceModule,
      penalty_kind: done.penaltyKind,
      penalty_amount_vnd: done.penaltyAmountVnd,
      decision_document_version_id: done.decisionDocumentVersionId,
    };
    await scope.audit({ action: `ctr.${action}`, resourceType: VIOLATION_RESOURCE, resourceId: done.id, classification: CLASSIFICATION, diff: { status: done.status, ...facts } });
    await scope.emit({
      aggregateType: VIOLATION_RESOURCE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, violation_id: done.id, status: done.status, ...facts },
      eventKey: `${VIOLATION_RESOURCE}:${done.id}:${done.version}`,
    });
  }
}

const dayOf = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
};

/**
 * The scorecard of a contractor over the contracts the caller reads (CTR-23): its evaluations, the log of its violations and what is approved and confirmed. Never for a contractor of the contract (403 `SCOPE_DENIED`): what the owner thinks of
 * a contractor is the owner's. Each line says whether the caller may approve or confirm it now, and each contract whether they may evaluate it or record a violation on it.
 */
@Controller()
export class ScorecardReadsController {
  private readonly scorecards = new CtrScorecardStore();
  private readonly contractors = new BidContractorStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('contractor-scorecards')
  @OperationId('listScorecardContractors')
  async contractorsInScope(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Schemas['ScorecardContractors']> {
    const now = new Date();
    const items = await this.database.withTenant(tenant, async (tx) => {
      if ((await this.contractors.callerOf(tx, tenant.membershipId)).guest) throw new DomainError('SCOPE_DENIED', 403);
      return this.scorecards.contractorsInScope(tx, contractScope(access, SCORECARD_READ_PERMISSION, now));
    });
    return { items: items.map((item) => ({ id: item.id, legal_name: item.legalName, contract_count: item.contractCount })), as_of: now.toISOString() };
  }

  @Get('contractors/:id/scorecard')
  @OperationId('getContractorScorecard')
  async read(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from?: unknown,
    @Query('to') to?: unknown,
  ): Promise<Schemas['ContractorScorecard']> {
    const range = { from: dayOf(from, 'from'), to: dayOf(to, 'to') };
    if (range.from !== undefined && range.to !== undefined && range.from > range.to) throw new DomainError('VALIDATION_FAILED', 422, 'to');
    const now = new Date();
    const card = await this.database.withTenant(tenant, async (tx) => {
      if ((await this.contractors.callerOf(tx, tenant.membershipId)).guest) throw new DomainError('SCOPE_DENIED', 403);
      return this.scorecards.scorecard(tx, id.toLowerCase(), range, contractScope(access, SCORECARD_READ_PERMISSION, now));
    });
    return view(card, tenant.membershipId, access, now);
  }
}

function view(card: ContractorScorecard, caller: string, access: EffectiveAccess, now: Date): Schemas['ContractorScorecard'] {
  const may = (permission: string, place: ContractorScorecard['evaluations'][number]['place']): boolean => reaches(access, permission, placeRefs(place), now);
  return {
    contractor: { id: card.contractor.id, legal_name: card.contractor.legalName },
    contracts: card.contracts.map((contract) => ({
      id: contract.id,
      code: contract.code,
      status: contract.status,
      allowed: { evaluate: may(SCORECARD_EVALUATE_PERMISSION, contract.place), record_violation: may(VIOLATION_RECORD_PERMISSION, contract.place) },
    })),
    evaluations: card.evaluations.map((line) => ({
      id: line.id,
      contract_id: line.contractId,
      contract_code: line.contractCode,
      evaluation_kind: line.kind,
      period_label: line.periodLabel,
      revision: line.revision,
      scores: { quality: line.scores.quality, schedule: line.scores.schedule, safety_env: line.scores.safetyEnv, cooperation: line.scores.cooperation, financial: line.scores.financial },
      overall_score: line.overallScore,
      rating: line.rating,
      status: line.status as Schemas['ContractorScorecard']['evaluations'][number]['status'],
      evaluated_by: line.evaluatedBy,
      approved_by: line.approvedBy,
      approved_at: line.approvedAt,
      supersedes_id: line.supersedesId,
      remarks: line.remarks,
      approval_note: line.approvalNote,
      created_at: line.createdAt,
      allowed: { approve: line.status === 'SUBMITTED' && line.evaluatedBy !== caller && may(SCORECARD_APPROVE_PERMISSION, line.place) },
      version: line.version,
    })),
    violations: card.violations.map((line) => ({
      id: line.id,
      contract_id: line.contractId,
      contract_code: line.contractCode,
      violation_kind: line.kind,
      severity: line.severity,
      occurred_on: line.occurredOn,
      description: line.description,
      evidence_document_version_id: line.evidenceDocumentVersionId,
      penalty_kind: line.penaltyKind,
      penalty_amount_vnd: line.penaltyAmountVnd,
      decision_document_version_id: line.decisionDocumentVersionId,
      source_module: line.sourceModule,
      source_ref_id: line.sourceRefId,
      status: line.status,
      recorded_by: line.recordedBy,
      confirmed_at: line.confirmedAt,
      created_at: line.createdAt,
      allowed: { confirm: line.status === 'RECORDED' && line.recordedBy !== caller && may(VIOLATION_CONFIRM_PERMISSION, line.place) },
      version: line.version,
    })),
    summary: {
      approved_count: card.summary.approvedCount,
      average_overall_score: card.summary.averageOverallScore,
      confirmed_violations: card.summary.confirmedViolations,
      evaluation_count: card.summary.evaluationCount,
      violation_count: card.summary.violationCount,
    },
    rule: {
      key: SCORECARD_RULE.key,
      weights_pct: {
        quality: SCORECARD_RULE.weightsPct.quality,
        schedule: SCORECARD_RULE.weightsPct.schedule,
        safety_env: SCORECARD_RULE.weightsPct.safetyEnv,
        cooperation: SCORECARD_RULE.weightsPct.cooperation,
        financial: SCORECARD_RULE.weightsPct.financial,
      },
      thresholds: SCORECARD_RULE.thresholds.map((threshold) => ({ min: threshold.min, rating: threshold.rating })),
      awaiting_confirmation: SCORECARD_RULE.awaitingConfirmation,
    },
    as_of: now.toISOString(),
  };
}
