import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DisbursementExceptionStore, PayIntegrityStore, PayPaymentStore, TenantDatabase, contractScope } from '@machvon/db';
import type { ContractScopes, DisbursementException, ExceptionResult, IntegrityEvaluation } from '@machvon/db';
import { DomainError, asUuid, blockingCode, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import { commandResult } from '../../command-result';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { answer } from './payment-record';
import type { PaymentCommandResult } from './payment-record';
import { exceptionView, findingLineView, runView } from './payment-integrity-view';

const SUBMIT_PERMISSION = PERMISSIONS.post_payment_requests_id_submit;
const CHECK_PERMISSION = PERMISSIONS.checkPaymentIntegrity;
const READ_PERMISSION = PERMISSIONS.get_resources_payment_request;
const INTEGRITY_READ_PERMISSION = PERMISSIONS.getPaymentIntegrityChecks;
const AUDIT_PERMISSION = PERMISSIONS.listPaymentIntegrityFindings;
const REQUEST_PERMISSION = PERMISSIONS.requestDisbursementException;
const APPROVE_PERMISSION = PERMISSIONS.approveDisbursementException;
const REJECT_PERMISSION = PERMISSIONS.rejectDisbursementException;
const REVOKE_PERMISSION = PERMISSIONS.revokeDisbursementException;
const EXCEPTION_READ_PERMISSION = PERMISSIONS.listDisbursementExceptions;

const REQUEST_RESOURCE = 'payment_request';
const EXCEPTION_RESOURCE = 'disbursement_exception';
const CLASSIFICATION = 'CONFIDENTIAL';
/** How many days ahead an exception about to lapse is shown as expiring. */
export const EXCEPTION_EXPIRING_DAYS = 7;

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, READ_PERMISSION, now) });

/** What the audit row and the event of a run say: identifiers, counts, codes and the version of the rule; never the figures of another request. */
function runFacts(evaluation: IntegrityEvaluation): Record<string, unknown> {
  const { run, verdict } = evaluation;
  return {
    run_id: run.id,
    outcome: run.outcome,
    trigger: run.trigger,
    rule_version: run.ruleVersion,
    rule_source: run.ruleSource,
    invariant_count: run.invariantCount,
    signal_count: run.signalCount,
    excused_count: run.excusedCount,
    unavailable: run.unavailable,
    codes: [...new Set(verdict.findings.map((one) => one.code))],
    consumed_exception_ids: evaluation.consumedExceptionIds,
  };
}

async function recordRun(scope: CommandScope, evaluation: IntegrityEvaluation, action: string, type: string, now: Date): Promise<void> {
  const { run } = evaluation;
  const facts = runFacts(evaluation);
  await scope.audit({ action, resourceType: REQUEST_RESOURCE, resourceId: run.paymentRequestId, classification: CLASSIFICATION, diff: facts });
  await scope.emit({
    aggregateType: REQUEST_RESOURCE,
    aggregateId: run.paymentRequestId,
    aggregateVersion: evaluation.requestVersion,
    type,
    schemaVersion: 1,
    payload: { tenant_id: scope.tenant.tenantId, payment_request_id: run.paymentRequestId, contract_id: run.contractId, ...facts, as_of: run.asOf, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
    eventKey: `${REQUEST_RESOURCE}:${run.paymentRequestId}:integrity:${run.id}`,
  });
}

/** What a refusal says about the findings that block: the code and the figures that decide it (over by how much, which attributes matched), never the other request. */
function blockingDetail(evaluation: IntegrityEvaluation): Array<Record<string, unknown>> {
  return evaluation.verdict.findings
    .filter((one) => one.kind === 'INVARIANT' && one.excusedBy === null)
    .map((one) => ({ code: one.code, over_by_vnd: one.params.over_by_vnd ?? null, matched: one.params.matched ?? null, basis: one.params.basis ?? null }));
}

/**
 * The check that sits inside sending a payment request (G4-2): it runs in the transaction of the command, before the request is sent. A request that an invariant blocks (a duplicate, or an amount above the plan line, the price
 * of the contract or the accepted value, with no approved exception that covers it) is refused 422 with the code of the invariant, and the run and its findings are committed all the same (`refuseAfterCommit`) so the
 * auditor finds what stopped the money; nothing else is written and the request stays a draft. Signals do not stop it: they are stored for the approver. A used exception rides on `planWaiverVnd` to the check of the plan line.
 */
export class PaymentIntegrityGuard {
  private readonly checks = new PayIntegrityStore();
  private readonly payments = new PayPaymentStore();

  async beforeSubmit(scope: CommandScope, access: EffectiveAccess, id: string, now: Date): Promise<{ blocked?: PaymentCommandResult; planWaiverVnd?: string; signals: number; outcome?: string }> {
    const evaluation = await this.checks.evaluate(scope.tx, id, {
      trigger: 'SUBMIT',
      actor: scope.tenant.membershipId,
      today: vietnamDateOf(now),
      scopes: scopesFor(access, SUBMIT_PERMISSION, now),
      expectedVersion: scope.expectedVersion ?? 0,
    });
    // A request that is not a draft at the version that was seen is left to the command that sends it, which refuses in its own words.
    if (evaluation === undefined) return { signals: 0 };
    const code = blockingCode(evaluation.verdict);
    if (evaluation.verdict.outcome === 'BLOCKED' && code !== undefined) {
      await recordRun(scope, evaluation, 'payment_request.integrity_blocked', 'pay.payment_request.integrity_blocked.v1', now);
      scope.refuseAfterCommit(new DomainError(code, 422, 'payment_request_id', { extensions: { run_id: evaluation.run.id, findings: blockingDetail(evaluation) } }));
      return { blocked: answer(scope, await this.payments.resultOf(scope.tx, id, 'DRAFT', [])), signals: evaluation.run.signalCount, outcome: 'BLOCKED' };
    }
    if (evaluation.run.outcome !== 'PASSED') await recordRun(scope, evaluation, 'payment_request.integrity_signals', 'pay.payment_request.integrity_signals.v1', now);
    return { ...(evaluation.planWaiverVnd === undefined ? {} : { planWaiverVnd: evaluation.planWaiverVnd }), signals: evaluation.run.signalCount, outcome: evaluation.run.outcome };
  }
}

/** The checks on demand and the exceptions to the ceilings of disbursement (G4-2, G4-5). */
@Controller()
export class PaymentIntegrityController {
  private readonly checks = new PayIntegrityStore();
  private readonly exceptions = new DisbursementExceptionStore();

  @Post('payment-requests/:id/integrity-checks')
  @HttpCode(200)
  @OperationId('checkPaymentIntegrity')
  @Command({ operation: 'checkPaymentIntegrity' })
  async check(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PayCheckPaymentIntegrity']): Promise<Schemas['PayIntegrityCheckResult']> {
    // The body is an empty object by schema: the check takes no input.
    void body;
    const now = new Date();
    const evaluation = await this.checks.evaluate(scope.tx, id, { trigger: 'PREVIEW', actor: scope.tenant.membershipId, today: vietnamDateOf(now), scopes: scopesFor(access, CHECK_PERMISSION, now) });
    if (evaluation === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await recordRun(scope, evaluation, 'payment_request.integrity_checked', 'pay.payment_request.integrity_checked.v1', now);
    const { run } = evaluation;
    return {
      ...commandResult(scope, run.outcome, evaluation.requestVersion, run.paymentRequestId),
      run_id: run.id,
      outcome: run.outcome,
      invariant_count: run.invariantCount,
      signal_count: run.signalCount,
      excused_count: run.excusedCount,
      unavailable: run.unavailable as Schemas['PayIntegrityCheckResult']['unavailable'],
    } as Schemas['PayIntegrityCheckResult'];
  }

  @Post('payment-requests/:id/disbursement-exceptions')
  @HttpCode(200)
  @OperationId('requestDisbursementException')
  @Command({ operation: 'requestDisbursementException' })
  async request(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PayRequestDisbursementException']): Promise<Schemas['CommandResult']> {
    const now = new Date();
    const done = await this.exceptions.request(
      scope.tx,
      id,
      { ceiling: body.ceiling, allowedAmountVnd: body.allowed_amount_vnd, validTo: body.valid_to, reason: body.reason },
      scope.tenant.membershipId,
      scopesFor(access, REQUEST_PERMISSION, now),
      vietnamDateOf(now),
    );
    await recordException(scope, done, 'disbursement_exception.requested', 'pay.disbursement_exception.requested.v1', now, body.reason.trim());
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('disbursement-exceptions/:id/approve')
  @HttpCode(200)
  @OperationId('approveDisbursementException')
  @Command({ operation: 'approveDisbursementException', versioned: true })
  async approve(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PayApproveDisbursementException']): Promise<Schemas['CommandResult']> {
    const now = new Date();
    const done = await this.exceptions.approve(scope.tx, id, scope.expectedVersion ?? 0, body.note, scope.tenant.membershipId, scopesFor(access, APPROVE_PERMISSION, now), vietnamDateOf(now));
    await recordException(scope, done, 'disbursement_exception.approved', 'pay.disbursement_exception.approved.v1', now, body.note?.trim());
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('disbursement-exceptions/:id/reject')
  @HttpCode(200)
  @OperationId('rejectDisbursementException')
  @Command({ operation: 'rejectDisbursementException', versioned: true })
  async reject(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PayRejectDisbursementException']): Promise<Schemas['CommandResult']> {
    const now = new Date();
    const done = await this.exceptions.reject(scope.tx, id, scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId, scopesFor(access, REJECT_PERMISSION, now), vietnamDateOf(now));
    await recordException(scope, done, 'disbursement_exception.rejected', 'pay.disbursement_exception.rejected.v1', now, body.reason.trim());
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('disbursement-exceptions/:id/revoke')
  @HttpCode(200)
  @OperationId('revokeDisbursementException')
  @Command({ operation: 'revokeDisbursementException', versioned: true })
  async revoke(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PayRevokeDisbursementException']): Promise<Schemas['CommandResult']> {
    const now = new Date();
    const done = await this.exceptions.revoke(scope.tx, id, scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId, scopesFor(access, REVOKE_PERMISSION, now), vietnamDateOf(now));
    await recordException(scope, done, 'disbursement_exception.revoked', 'pay.disbursement_exception.revoked.v1', now, body.reason.trim());
    return commandResult(scope, done.status, done.version, done.id);
  }
}

async function recordException(scope: CommandScope, done: ExceptionResult, action: string, type: string, now: Date, reason?: string): Promise<void> {
  const facts = { payment_request_id: done.paymentRequestId, contract_id: done.contractId, project_id: done.projectId, ceiling: done.ceiling, allowed_amount_vnd: done.allowedAmountVnd, valid_to: done.validTo };
  await scope.audit({
    action,
    resourceType: EXCEPTION_RESOURCE,
    resourceId: done.id,
    classification: CLASSIFICATION,
    ...(reason === undefined ? {} : { reason }),
    diff: { from_status: done.fromStatus, to_status: done.status, ...facts },
  });
  await scope.emit({
    aggregateType: EXCEPTION_RESOURCE,
    aggregateId: done.id,
    aggregateVersion: done.version,
    type,
    schemaVersion: 1,
    payload: { tenant_id: scope.tenant.tenantId, exception_id: done.id, ...facts, status: done.status, from_status: done.fromStatus, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
    eventKey: `${EXCEPTION_RESOURCE}:${done.id}:${done.version}`,
  });
}

const dayOf = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
};
const oneOf = <T extends string>(value: unknown, field: string, allowed: readonly T[]): T | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value as T;
};
const uuidOf = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  const uuid = typeof value === 'string' ? asUuid(value) : undefined;
  if (uuid === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return uuid.toLowerCase();
};

/** The checks as the approver reads them, the register of exceptions and the findings for the auditor; every read stays inside the scope of the reader. */
@Controller()
export class PaymentIntegrityReadsController {
  private readonly checks = new PayIntegrityStore();
  private readonly exceptions = new DisbursementExceptionStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('payment-requests/:id/integrity-checks')
  @OperationId('getPaymentIntegrityChecks')
  async latest(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const today = vietnamDateOf(now);
    const found = await this.database.withTenant(tenant, async (tx) => {
      const latest = await this.checks.latestRun(tx, id, contractScope(access, INTEGRITY_READ_PERMISSION, now));
      const exceptions = await this.exceptions.list(tx, contractScope(access, EXCEPTION_READ_PERMISSION, now), { paymentRequestId: id.toLowerCase() }, today, 20, undefined);
      return { latest, exceptions };
    });
    return {
      payment_request_id: id.toLowerCase(),
      request_status: found.latest.requestStatus,
      run: found.latest.run === undefined ? null : runView(found.latest.run),
      exceptions: found.exceptions.map(exceptionView),
      as_of: now.toISOString(),
    };
  }

  @Get('payment-integrity/findings')
  @OperationId('listPaymentIntegrityFindings')
  async findings(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('code') code?: unknown,
    @Query('kind') kind?: unknown,
    @Query('contract_id') contractId?: unknown,
    @Query('from') from?: unknown,
    @Query('to') to?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const filter = {
      code: oneOf(code, 'code', ['DUPLICATE_CLAIM', 'UNIT_PRICE_OUTLIER', 'QUANTITY_VS_DIARY', 'EXCEEDS_CONTRACT', 'EXCEEDS_PLAN', 'EXCEEDS_ACCEPTED']),
      kind: oneOf(kind, 'kind', ['INVARIANT', 'SIGNAL']),
      contractId: uuidOf(contractId, 'contract_id'),
      from: dayOf(from, 'from'),
      to: dayOf(to, 'to'),
    };
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.checks.listFindings(tx, contractScope(access, AUDIT_PERMISSION, now), filter, request.limit + 1, request.after === undefined ? undefined : { createdAt: request.after.code, id: request.after.id }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(findingLineView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null, as_of: now.toISOString() };
  }

  @Get('disbursement-exceptions')
  @OperationId('listDisbursementExceptions')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('contract_id') contractId?: unknown,
    @Query('payment_request_id') paymentRequestId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string; expiring_within_days: number }> {
    const filter = {
      status: oneOf(status, 'status', ['REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED', 'USED', 'EXPIRED'] as const),
      contractId: uuidOf(contractId, 'contract_id'),
      paymentRequestId: uuidOf(paymentRequestId, 'payment_request_id'),
    };
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows: DisbursementException[] = await this.database.withTenant(tenant, (tx) =>
      this.exceptions.list(tx, contractScope(access, EXCEPTION_READ_PERMISSION, now), filter, vietnamDateOf(now), request.limit + 1, request.after === undefined ? undefined : { requestedAt: request.after.code, id: request.after.id }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(exceptionView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.requestedAt, id: last.id }) : null,
      as_of: now.toISOString(),
      expiring_within_days: EXCEPTION_EXPIRING_DAYS,
    };
  }
}
