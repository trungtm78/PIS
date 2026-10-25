import type { PaymentResult } from '@machvon/db';
import { commandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';

export const RESOURCE_TYPE = 'payment_request';
export const CLASSIFICATION = 'CONFIDENTIAL';

export type PaymentCommandResult = Schemas['PayPaymentCommandResult'];

/** What a command answers: the usual result of a command, and the figures the server computed (the client never sends them), the year of the plan and what the caller should know. */
export function answer(scope: CommandScope, done: PaymentResult): PaymentCommandResult {
  return {
    ...commandResult(scope, done.status, done.version, done.id),
    gross_vnd: done.grossVnd,
    advance_recovery_vnd: done.advanceRecoveryVnd,
    retention_vnd: done.retentionVnd,
    tax_adjustment_vnd: done.taxAdjustmentVnd,
    net_vnd: done.netVnd,
    plan_year: done.planYear,
    warnings: done.warnings.map((warning) => ({ code: warning.code, detail: warning.detail })),
  };
}

/** The audit row and the event of a command on a payment request: identifiers, amounts, the year and the status; never the words of a reason beyond the row that keeps them. */
/** What a command adds to the audit row and the event beyond the figures of the request, and the key of the event when the version of the request did not move. */
export interface RecordExtra {
  facts?: Record<string, unknown>;
  eventKey?: string;
}

export async function recordPayment(scope: CommandScope, done: PaymentResult, action: string, type: string, now: Date, reason?: string, extra: RecordExtra = {}): Promise<void> {
  const facts = {
    contract_id: done.contractId,
    contract_code: done.contractCode,
    project_id: done.projectId,
    request_kind: done.requestKind,
    request_no: done.requestNo,
    acceptance_id: done.acceptanceId,
    allocation_line_id: done.allocationLineId,
    plan_year: done.planYear,
    gross_vnd: done.grossVnd,
    advance_recovery_vnd: done.advanceRecoveryVnd,
    retention_vnd: done.retentionVnd,
    tax_adjustment_vnd: done.taxAdjustmentVnd,
    net_vnd: done.netVnd,
    line_count: done.lineCount,
    ...(extra.facts ?? {}),
  };
  await scope.audit({
    action,
    resourceType: RESOURCE_TYPE,
    resourceId: done.id,
    classification: CLASSIFICATION,
    ...(reason === undefined ? {} : { reason }),
    diff: { from_status: done.fromStatus, to_status: done.status, ...facts, warnings: done.warnings.map((warning) => warning.code) },
  });
  await scope.emit({
    aggregateType: RESOURCE_TYPE,
    aggregateId: done.id,
    aggregateVersion: done.version,
    type,
    schemaVersion: 1,
    payload: { tenant_id: scope.tenant.tenantId, payment_request_id: done.id, ...facts, status: done.status, from_status: done.fromStatus, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
    eventKey: extra.eventKey ?? `${RESOURCE_TYPE}:${done.id}:${done.version}`,
  });
}
