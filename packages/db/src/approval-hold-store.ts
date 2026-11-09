import { holdMoveOnReceipt } from '@machvon/kernel';
import type { HoldState } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

/** A hold of a step of the staged approval (ENT-3c, R22): the PUSH step made its decision and waits for the receiver. */
export interface HoldRecord {
  id: string;
  workflowInstanceId: string;
  taskId: string;
  stepKey: string;
  state: HoldState;
  heldBy: string;
  onBehalfOfId: string | null;
  delegationId: string | null;
  decisionReason: string | null;
  pushId: string | null;
  pushKey: string | null;
  pushStatus: string | null;
  resourceRevision: number | null;
  attempts: number;
  receiptBy: string | null;
  receiptAt: string | null;
  receiptReference: string | null;
  releasedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface HoldSql {
  id: string;
  workflow_instance_id: string;
  task_id: string;
  step_key: string;
  state: HoldState;
  held_by: string;
  on_behalf_of_id: string | null;
  delegation_id: string | null;
  decision_reason: string | null;
  push_id: string | null;
  push_key: string | null;
  push_status: string | null;
  resource_revision: number | null;
  attempts: number;
  receipt_by: string | null;
  receipt_at: string | null;
  receipt_reference: string | null;
  released_at: string | null;
  version: string;
  created_at: string;
  updated_at: string;
}

const SELECT = `select h.id, h.workflow_instance_id, h.task_id, h.step_key, h.state, h.held_by, h.on_behalf_of_id, h.delegation_id, h.decision_reason, h.push_id, h.push_key, h.push_status, h.resource_revision, h.attempts,
  h.receipt_by, to_char(h.receipt_at at time zone 'UTC', ${ISO}) as receipt_at, h.receipt_reference, to_char(h.released_at at time zone 'UTC', ${ISO}) as released_at, h.version::text as version,
  to_char(h.created_at at time zone 'UTC', ${ISO}) as created_at, to_char(h.updated_at at time zone 'UTC', ${ISO}) as updated_at from machvon.approval_step_hold h`;

const toHold = (row: HoldSql): HoldRecord => ({
  id: row.id,
  workflowInstanceId: row.workflow_instance_id,
  taskId: row.task_id,
  stepKey: row.step_key,
  state: row.state,
  heldBy: row.held_by,
  onBehalfOfId: row.on_behalf_of_id,
  delegationId: row.delegation_id,
  decisionReason: row.decision_reason,
  pushId: row.push_id,
  pushKey: row.push_key,
  pushStatus: row.push_status,
  resourceRevision: row.resource_revision,
  attempts: row.attempts,
  receiptBy: row.receipt_by,
  receiptAt: row.receipt_at,
  receiptReference: row.receipt_reference,
  releasedAt: row.released_at,
  version: Number(row.version),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** What a hold is made of when the PUSH step makes its decision. */
export interface HoldInput {
  workflowInstanceId: string;
  taskId: string;
  stepKey: string;
  state: HoldState;
  heldBy: string;
  onBehalfOfId: string | null;
  delegationId: string | null;
  reason: string | null;
  pushId: string | null;
  pushKey: string | null;
  pushStatus: string | null;
  resourceRevision: number | null;
  now: Date;
}

/**
 * The holds of the staged approval: one open hold for a task. The first try of the PUSH step opens it, a retry after a failed push moves the same row (the attempts count up), an acceptance of the receipt releases it,
 * a rejection ends it, and the end of the instance cancels what is still open. The database guard keeps the edges of the life of a hold.
 */
export class ApprovalHoldStore {
  async find(tx: TenantTx, id: string, lock = false): Promise<HoldRecord | undefined> {
    const rows = await tx.query<HoldSql>(`${SELECT} where h.id = $1::uuid${lock ? ' for update of h' : ''}`, [id]);
    return rows[0] === undefined ? undefined : toHold(rows[0]);
  }

  /** The open hold of a task (AWAITING_RECEIPT or PUSH_FAILED), if any. */
  async openFor(tx: TenantTx, taskId: string, lock = false): Promise<HoldRecord | undefined> {
    const rows = await tx.query<HoldSql>(`${SELECT} where h.task_id = $1::uuid and h.state in ('AWAITING_RECEIPT', 'PUSH_FAILED')${lock ? ' for update of h' : ''}`, [taskId]);
    return rows[0] === undefined ? undefined : toHold(rows[0]);
  }

  /** The hold a push belongs to (the newest, when a retry of the step opened more than one over time). */
  async forPush(tx: TenantTx, pushId: string, lock = false): Promise<HoldRecord | undefined> {
    const rows = await tx.query<HoldSql>(`${SELECT} where h.push_id = $1::uuid order by (h.state in ('AWAITING_RECEIPT', 'PUSH_FAILED')) desc, h.created_at desc, h.id limit 1${lock ? ' for update of h' : ''}`, [pushId]);
    return rows[0] === undefined ? undefined : toHold(rows[0]);
  }

  /** The holds of some instances, newest first, for the screens that show the steps. */
  async forInstances(tx: TenantTx, instanceIds: readonly string[]): Promise<HoldRecord[]> {
    if (instanceIds.length === 0) return [];
    const rows = await tx.query<HoldSql>(`${SELECT} where h.workflow_instance_id = any($1::uuid[]) order by h.created_at desc, h.id`, [instanceIds]);
    return rows.map(toHold);
  }

  /** Opens the hold of a task, or moves its open hold when the step is tried again (the same key, the next attempt). */
  async hold(tx: TenantTx, input: HoldInput): Promise<HoldRecord> {
    const open = await this.openFor(tx, input.taskId, true);
    const at = input.now.toISOString();
    if (open !== undefined) {
      await tx.query(
        `update machvon.approval_step_hold set state = $2, push_id = coalesce($3::uuid, push_id), push_key = coalesce($4, push_key), push_status = $5, resource_revision = coalesce($6::integer, resource_revision),
                attempts = attempts + 1, version = version + 1, updated_at = $7::timestamptz where id = $1::uuid`,
        [open.id, input.state, input.pushId, input.pushKey, input.pushStatus, input.resourceRevision, at],
      );
      return (await this.find(tx, open.id)) as HoldRecord;
    }
    const rows = await tx.query<HoldSql>(
      `with inserted as (
         insert into machvon.approval_step_hold (tenant_id, id, workflow_instance_id, task_id, step_key, state, held_by, on_behalf_of_id, delegation_id, decision_reason, push_id, push_key, push_status, resource_revision, created_at, updated_at, released_at)
         values (${TENANT}, gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7::uuid, $8, $9::uuid, $10, $11, $12::integer, $13::timestamptz, $13::timestamptz, case when $4 = 'PUSHED' then $13::timestamptz end)
         returning *)
       ${SELECT.replace('from machvon.approval_step_hold h', 'from inserted h')}`,
      [input.workflowInstanceId, input.taskId, input.stepKey, input.state, input.heldBy, input.onBehalfOfId, input.delegationId, input.reason, input.pushId, input.pushKey, input.pushStatus, input.resourceRevision, at],
    );
    return toHold(rows[0] as HoldSql);
  }

  /** The receiver answered: the rule of the kernel says what it does to the hold (409 `APPROVAL_HOLD_STATE_INVALID` when the hold is not waiting). */
  async answer(tx: TenantTx, hold: HoldRecord, receipt: { outcome: 'ACCEPTED' | 'REJECTED'; by: string; reference: string; at: Date }): Promise<{ hold: HoldRecord; release: boolean }> {
    const move = holdMoveOnReceipt(hold, receipt.outcome);
    const at = receipt.at.toISOString();
    await tx.query(
      `update machvon.approval_step_hold set state = $2, push_status = $3, receipt_by = $4::uuid, receipt_at = $5::timestamptz, receipt_reference = $6, released_at = case when $2 = 'PUSHED' then $5::timestamptz end,
              version = version + 1, updated_at = $5::timestamptz where id = $1::uuid`,
      [hold.id, move.to, receipt.outcome, receipt.by, at, receipt.reference],
    );
    return { hold: (await this.find(tx, hold.id)) as HoldRecord, release: move.release };
  }

  /** The instance ended or went back: whatever hold is still open is cancelled. Returns how many. */
  async cancelOpen(tx: TenantTx, instanceId: string, now: Date): Promise<number> {
    const rows = await tx.query<{ id: string }>(
      `update machvon.approval_step_hold set state = 'CANCELLED', version = version + 1, updated_at = $2::timestamptz where workflow_instance_id = $1::uuid and state in ('AWAITING_RECEIPT', 'PUSH_FAILED') returning id`,
      [instanceId, now.toISOString()],
    );
    return rows.length;
  }
}
