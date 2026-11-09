import { DomainError, pushPackageOf } from '@machvon/kernel';
import type { TenantTx } from '@machvon/db';
import { EntConnectionStore, HPM_CONNECTION, HpmAdjustmentStore, HpmPushStore, assertHpmPushAllowed, hpmAdjustmentLineOf, hpmKeyOf } from '@machvon/edition-enterprise/src/server.ts';
import type { HpmCopyRequest, HpmPort, PeriodReopenPort } from '@machvon/edition-enterprise/src/server.ts';
import type { ApprovalPushCall, ApprovalPushPort, ApprovalPushResult } from '../../modules/adm/approval-hold.service';

const PUSH_RESOURCE = 'hpm_push';
const CLASSIFICATION = 'INTERNAL';

/**
 * The receiver of the PUSH step of the staged approval (ENT-3c, eng-review R22): the package of the record is pushed to HPM under the key organisation | layout | period | revision (R8), so the same revision is one push
 * however often the step is tried; a revision older than the newest one is refused (R17), and so is a period the receiver already accepted unless a reopening and an approved correction allow the overwrite. The approved
 * adjustments of the period ride on the package (TH.01) and are used once. The push is written to the file sink (`HpmPort`); it is accepted only when somebody other than the pusher records the receipt of HPM, which is
 * what releases the step.
 */
export class HpmApprovalPush implements ApprovalPushPort {
  private readonly pushes = new HpmPushStore();
  private readonly adjustments = new HpmAdjustmentStore();
  private readonly connections = new EntConnectionStore(HPM_CONNECTION);

  constructor(
    private readonly port: HpmPort,
    private readonly reopen: PeriodReopenPort,
  ) {}

  async push(tx: TenantTx, call: ApprovalPushCall): Promise<ApprovalPushResult> {
    const { row: connection } = await this.connections.ensure(tx, call.actor);
    assertHpmPushAllowed(connection);
    const key = hpmKeyOf({ orgId: call.tenantId, layoutCode: call.layoutCode, period: call.period, revision: call.revision });
    const existing = await this.pushes.findByKey(tx, key, true);
    // A first push takes the adjustments approved for the period; a retry of the key carries exactly the ones its first try used, so the package is the same however their states moved.
    const lines = existing === undefined ? await this.adjustments.approvedFor(tx, call.layoutCode, call.period, true) : await this.adjustments.appliedBy(tx, existing.id);
    const made = pushPackageOf({ layoutCode: call.layoutCode, period: call.period, revision: call.revision, owner: call.owner, facts: call.facts, adjustments: lines.map(hpmAdjustmentLineOf) });
    const request: HpmCopyRequest = {
      orgId: call.tenantId,
      layoutCode: call.layoutCode,
      period: call.period,
      revision: call.revision,
      sha256: made.sha256,
      fileObjectKey: `approval:${call.owner}:${call.layoutCode}:${call.period}:r${call.revision}`,
      issueId: null,
      snapshot: null,
      marks: null,
      correctionId: null,
    };
    const done = await this.pushes.send(tx, request, existing?.status === 'FAILED' ? 'RETRY' : 'SUBMIT', {
      tenantId: call.tenantId,
      actor: call.actor,
      now: call.now,
      port: this.port,
      reopen: this.reopen,
      bytes: new TextEncoder().encode(made.text),
      fileName: made.fileName,
      issuedHeadRevision: call.headRevision,
    });
    if (existing === undefined && lines.length > 0) await this.adjustments.apply(tx, lines, done.row.id, call.actor, call.now);
    const row = done.row;
    await call.effects.audit({
      action: existing === undefined ? 'hpm.push_submitted' : 'hpm.push_retried',
      resourceType: PUSH_RESOURCE,
      resourceId: row.id,
      classification: CLASSIFICATION,
      diff: { key: row.key, layout_code: row.layoutCode, period: row.period, revision: row.revision, sha256: row.sha256, outcome: done.outcome, status: row.status, attempts: row.attempts, last_error_code: row.lastErrorCode, origin: 'APPROVAL_STEP', adjustments: lines.length },
    });
    if (done.outcome !== 'ALREADY_DELIVERED') {
      await call.effects.emit({
        aggregateType: PUSH_RESOURCE,
        aggregateId: row.id,
        aggregateVersion: row.version,
        type: 'hpm.push.sent.v1',
        schemaVersion: 1,
        payload: { tenant_id: call.tenantId, push_id: row.id, key: row.key, layout_code: row.layoutCode, period: row.period, revision: row.revision, sha256: row.sha256, outcome: done.outcome, status: row.status, attempts: row.attempts, error_code: row.lastErrorCode, overwrites: row.overwrites, actor_id: call.actor, occurred_at: call.now.toISOString() },
        eventKey: `${PUSH_RESOURCE}:${row.id}:attempt:${row.attempts}`,
      });
    }
    if (row.status === 'PENDING') throw new DomainError('HPM_PUSH_STATE_INVALID', 409, 'status');
    return { pushId: row.id, key: row.key, status: row.status, errorCode: row.lastErrorCode };
  }
}
