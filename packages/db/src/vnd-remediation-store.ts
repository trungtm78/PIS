import { randomUUID } from 'node:crypto';
import { DomainError, hasControlChar, nextRemediationStatus, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { RemediationActionStatus, RemediationStatus } from '@machvon/kernel';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';
import { VendorPortalPolicyReader } from './vnd3-portal-policy.ts';
import type { PortalCaller } from './vnd-portal-store.ts';
import { VendorPortalStore } from './vnd-portal-store.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const TRIGGERS = ['POOR_EVALUATION', 'NON_CONFORMANCE', 'SCREENING', 'DISPUTE', 'MANUAL'] as const;
type Trigger = (typeof TRIGGERS)[number];

export interface RemediationPlanRow {
  id: string;
  contractorId: string;
  contractorName: string;
  contractId: string | null;
  triggerKind: Trigger;
  triggerRef: string | null;
  title: string;
  objective: string;
  status: RemediationStatus;
  proposedBy: string;
  proposedAt: string;
  agreedBy: string | null;
  agreedAt: string | null;
  startedAt: string | null;
  closedAt: string | null;
  closedReason: string | null;
  version: number;
  actionCount: number;
  verifiedCount: number;
  overdueCount: number;
}

export interface RemediationActionRow {
  id: string;
  planId: string;
  contractorId: string;
  seq: number;
  description: string;
  dueOn: string;
  status: RemediationActionStatus;
  overdue: boolean;
  doneBy: string | null;
  doneAt: string | null;
  doneNote: string | null;
  evidenceDocumentId: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  verifyNote: string | null;
  version: number;
}

export interface NewRemediationPlan {
  title: string;
  objective: string;
  contractId?: string | undefined;
  triggerKind: Trigger;
  triggerRef?: string | undefined;
  actions: ReadonlyArray<{ description: string; dueOn: string }>;
}

export interface RemediationEventRow {
  id: string;
  move: string;
  fromStatus: string | null;
  toStatus: string;
  actorId: string;
  note: string | null;
  at: string;
}

interface PlanSql {
  id: string;
  contractor_id: string;
  contractor_name: string;
  contract_id: string | null;
  trigger_kind: Trigger;
  trigger_ref: string | null;
  title: string;
  objective: string;
  status: RemediationStatus;
  proposed_by: string;
  proposed_at: string;
  agreed_by: string | null;
  agreed_at: string | null;
  started_at: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  version: string;
  action_count: number;
  verified_count: number;
  overdue_count: number;
}

interface ActionSql {
  id: string;
  plan_id: string;
  contractor_id: string;
  seq: number;
  description: string;
  due_on: string;
  status: RemediationActionStatus;
  overdue: boolean;
  done_by: string | null;
  done_at: string | null;
  done_note: string | null;
  evidence_document_id: string | null;
  verified_by: string | null;
  verified_at: string | null;
  verify_note: string | null;
  version: string;
}

const PLAN_SELECT = (today: string): string => `select p.id, p.contractor_id, c.legal_name as contractor_name, p.contract_id, p.trigger_kind, p.trigger_ref, p.title, p.objective, p.status, p.proposed_by, ${timestampKey('p.proposed_at')} as proposed_at,
  p.agreed_by, ${timestampKey('p.agreed_at')} as agreed_at, ${timestampKey('p.started_at')} as started_at, ${timestampKey('p.closed_at')} as closed_at, p.closed_reason, p.version::text as version,
  (select count(*) from machvon.contractor_remediation_action a where a.plan_id = p.id)::int as action_count,
  (select count(*) from machvon.contractor_remediation_action a where a.plan_id = p.id and a.status = 'VERIFIED')::int as verified_count,
  (select count(*) from machvon.contractor_remediation_action a where a.plan_id = p.id and a.status <> 'VERIFIED' and a.due_on < '${today}'::date)::int as overdue_count
  from machvon.contractor_remediation_plan p join machvon.contractor c on c.tenant_id = p.tenant_id and c.id = p.contractor_id`;

const ACTION_SELECT = (today: string): string => `select a.id, a.plan_id, a.contractor_id, a.seq, a.description, a.due_on::text as due_on, a.status, (a.status <> 'VERIFIED' and a.due_on < '${today}'::date) as overdue, a.done_by, ${timestampKey('a.done_at')} as done_at, a.done_note,
  a.evidence_document_id, a.verified_by, ${timestampKey('a.verified_at')} as verified_at, a.verify_note, a.version::text as version from machvon.contractor_remediation_action a`;

const planOf = (row: PlanSql): RemediationPlanRow => ({
  id: row.id,
  contractorId: row.contractor_id,
  contractorName: row.contractor_name,
  contractId: row.contract_id,
  triggerKind: row.trigger_kind,
  triggerRef: row.trigger_ref,
  title: row.title,
  objective: row.objective,
  status: row.status,
  proposedBy: row.proposed_by,
  proposedAt: row.proposed_at,
  agreedBy: row.agreed_by,
  agreedAt: row.agreed_at,
  startedAt: row.started_at,
  closedAt: row.closed_at,
  closedReason: row.closed_reason,
  version: Number(row.version),
  actionCount: row.action_count,
  verifiedCount: row.verified_count,
  overdueCount: row.overdue_count,
});

const actionOf = (row: ActionSql): RemediationActionRow => ({
  id: row.id,
  planId: row.plan_id,
  contractorId: row.contractor_id,
  seq: row.seq,
  description: row.description,
  dueOn: row.due_on,
  status: row.status,
  overdue: row.overdue,
  doneBy: row.done_by,
  doneAt: row.done_at,
  doneNote: row.done_note,
  evidenceDocumentId: row.evidence_document_id,
  verifiedBy: row.verified_by,
  verifiedAt: row.verified_at,
  verifyNote: row.verify_note,
  version: Number(row.version),
});

const textOf = (value: string, field: string, min: number, max: number): string => {
  const text = value.trim();
  if (text.length < min || text.length > max || hasControlChar(text)) throw invalid(field);
  return text;
};

const isDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/**
 * The plan of remediation of a contractor (VND-3, V17; docs/vendor-investigation.md section 7). After a poor evaluation, a non-conformance, a clarification or a dispute, staff propose a plan of actions with a due day each
 * (never further than `max_plan_days` of the rule `VENDOR_REMEDIATION`); the contractor agrees to it on the portal; staff start it; the contractor marks each action done with a note and a paper; staff verify each one (never
 * the person who marked it) or open it again; the plan is completed only when every action is verified (the kernel `nextRemediationStatus`), and fails or is cancelled with a reason. Every move is in
 * `contractor_remediation_event`, append-only; nothing is deleted.
 */
export class VendorRemediationStore {
  private readonly policies: VendorPortalPolicyReader;
  private readonly portal = new VendorPortalStore();

  constructor(policies: VendorPortalPolicyReader = new VendorPortalPolicyReader()) {
    this.policies = policies;
  }

  async findPlan(tx: TenantTx, id: string, today: string, lock = false): Promise<RemediationPlanRow | undefined> {
    const rows = await tx.query<PlanSql>(`${PLAN_SELECT(today)} where p.id = $1::uuid${lock ? ' for update of p' : ''}`, [id]);
    return rows[0] === undefined ? undefined : planOf(rows[0]);
  }

  async listPlans(tx: TenantTx, filter: { contractorId?: string | undefined; status?: string | undefined; limit?: number | undefined }, today: string): Promise<RemediationPlanRow[]> {
    const rows = await tx.query<PlanSql>(`${PLAN_SELECT(today)} where ($1::uuid is null or p.contractor_id = $1::uuid) and ($2::text is null or p.status = $2) order by p.proposed_at desc, p.id limit $3`, [filter.contractorId ?? null, filter.status ?? null, filter.limit ?? 200]);
    return rows.map(planOf);
  }

  async actions(tx: TenantTx, planId: string, today: string): Promise<RemediationActionRow[]> {
    const rows = await tx.query<ActionSql>(`${ACTION_SELECT(today)} where a.plan_id = $1::uuid order by a.seq`, [planId]);
    return rows.map(actionOf);
  }

  async findAction(tx: TenantTx, id: string, today: string, lock = false): Promise<RemediationActionRow | undefined> {
    const rows = await tx.query<ActionSql>(`${ACTION_SELECT(today)} where a.id = $1::uuid${lock ? ' for update of a' : ''}`, [id]);
    return rows[0] === undefined ? undefined : actionOf(rows[0]);
  }

  async events(tx: TenantTx, planId: string): Promise<RemediationEventRow[]> {
    const rows = await tx.query<{ id: string; move: string; from_status: string | null; to_status: string; actor_id: string; note: string | null; at: string }>(
      `select id, move, from_status, to_status, actor_id, note, ${timestampKey('at')} as at from machvon.contractor_remediation_event where plan_id = $1::uuid order by at, id`,
      [planId],
    );
    return rows.map((row) => ({ id: row.id, move: row.move, fromStatus: row.from_status, toStatus: row.to_status, actorId: row.actor_id, note: row.note, at: row.at }));
  }

  private async event(tx: TenantTx, plan: { id: string; contractorId: string }, actionId: string | null, move: string, from: string | null, to: string, actor: string, note: string | null): Promise<void> {
    await tx.query(
      `insert into machvon.contractor_remediation_event (tenant_id, id, plan_id, contractor_id, action_id, move, from_status, to_status, actor_id, note, at) values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::uuid, $9, clock_timestamp())`,
      [randomUUID(), plan.id, plan.contractorId, actionId, move, from, to, actor, note],
    );
  }

  /** Staff propose a plan with its actions. The contractor must have an account on the portal to agree to it. */
  async create(tx: TenantTx, contractorId: string, input: NewRemediationPlan, actor: string, now: Date): Promise<RemediationPlanRow> {
    const today = vietnamDateOf(now);
    if ((await tx.query('select 1 from machvon.contractor where id = $1::uuid', [contractorId])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.portal.assertBound(tx, contractorId, now);
    const policy = (await this.policies.remediation(tx, today)).value;
    const title = textOf(input.title, 'title', 3, 200);
    const objective = textOf(input.objective, 'objective', 10, 2000);
    if (!TRIGGERS.includes(input.triggerKind)) throw invalid('trigger_kind');
    if (input.contractId !== undefined && (await tx.query('select 1 from machvon.contract where id = $1::uuid and contractor_id = $2::uuid', [input.contractId, contractorId])).length === 0) throw invalid('contract_id');
    if (input.actions.length < 1 || input.actions.length > 50) throw invalid('actions');
    const last = addDays(today, policy.max_plan_days);
    const actions = input.actions.map((action) => {
      if (!isDay(action.dueOn) || action.dueOn < today || action.dueOn > last) throw invalid('due_on');
      return { description: textOf(action.description, 'description', 5, 1000), dueOn: action.dueOn };
    });
    const id = randomUUID();
    await tx.query(
      `insert into machvon.contractor_remediation_plan (tenant_id, id, contractor_id, contract_id, trigger_kind, trigger_ref, title, objective, proposed_by, proposed_at) values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8::uuid, $9::timestamptz)`,
      [id, contractorId, input.contractId ?? null, input.triggerKind, input.triggerRef ?? null, title, objective, actor, now.toISOString()],
    );
    await this.event(tx, { id, contractorId }, null, 'PROPOSE', null, 'PROPOSED', actor, null);
    let seq = 0;
    for (const action of actions) {
      seq += 1;
      const actionId = randomUUID();
      await tx.query(`insert into machvon.contractor_remediation_action (tenant_id, id, plan_id, contractor_id, seq, description, due_on) values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date)`, [actionId, id, contractorId, seq, action.description, action.dueOn]);
      await this.event(tx, { id, contractorId }, actionId, 'ADD_ACTION', 'PROPOSED', 'PROPOSED', actor, null);
    }
    return (await this.findPlan(tx, id, today)) as RemediationPlanRow;
  }

  private async lockedPlan(tx: TenantTx, id: string, expectedVersion: number, today: string, contractorId?: string): Promise<RemediationPlanRow> {
    const plan = await this.findPlan(tx, id, today, true);
    if (plan === undefined || (contractorId !== undefined && plan.contractorId !== contractorId)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (plan.version !== expectedVersion) throw versionConflict(plan.version);
    return plan;
  }

  private async statuses(tx: TenantTx, planId: string, today: string): Promise<RemediationActionStatus[]> {
    return (await this.actions(tx, planId, today)).map((action) => action.status);
  }

  /** The contractor agrees to the plan: the commitment is its own, so it is the contractor and nobody else. */
  async agree(tx: TenantTx, caller: PortalCaller, id: string, expectedVersion: number, now: Date): Promise<RemediationPlanRow> {
    const today = vietnamDateOf(now);
    const plan = await this.lockedPlan(tx, id, expectedVersion, today, caller.contractorId);
    const next = nextRemediationStatus(plan.status, 'AGREE', { actions: await this.statuses(tx, id, today) });
    await tx.query('update machvon.contractor_remediation_plan set status = $2, agreed_by = $3::uuid, agreed_at = $4::timestamptz, version = version + 1 where id = $1::uuid', [id, next, caller.membershipId, now.toISOString()]);
    await this.event(tx, plan, null, 'AGREE', plan.status, next, caller.membershipId, null);
    return (await this.findPlan(tx, id, today)) as RemediationPlanRow;
  }

  async start(tx: TenantTx, id: string, expectedVersion: number, actor: string, now: Date): Promise<RemediationPlanRow> {
    const today = vietnamDateOf(now);
    const plan = await this.lockedPlan(tx, id, expectedVersion, today);
    const next = nextRemediationStatus(plan.status, 'START', { actions: await this.statuses(tx, id, today) });
    await tx.query('update machvon.contractor_remediation_plan set status = $2, started_at = $3::timestamptz, version = version + 1 where id = $1::uuid', [id, next, now.toISOString()]);
    await this.event(tx, plan, null, 'START', plan.status, next, actor, null);
    return (await this.findPlan(tx, id, today)) as RemediationPlanRow;
  }

  /** The contractor reports an action done, with a note and optionally a paper; only while the plan is in progress. */
  async markDone(tx: TenantTx, caller: PortalCaller, actionId: string, expectedVersion: number, input: { note: string; documentId?: string | undefined }, now: Date): Promise<RemediationActionRow> {
    const today = vietnamDateOf(now);
    const action = await this.findAction(tx, actionId, today, true);
    if (action === undefined || action.contractorId !== caller.contractorId) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (action.version !== expectedVersion) throw versionConflict(action.version);
    const plan = (await this.findPlan(tx, action.planId, today)) as RemediationPlanRow;
    if (plan.status !== 'IN_PROGRESS' || action.status !== 'OPEN') throw new DomainError('REMEDIATION_STATE_INVALID', 409, 'status');
    const note = textOf(input.note, 'note', 1, 2000);
    if (input.documentId !== undefined && (await tx.query('select 1 from machvon.document where id = $1::uuid', [input.documentId])).length === 0) throw invalid('document_id');
    await tx.query(
      "update machvon.contractor_remediation_action set status = 'DONE', done_by = $2::uuid, done_at = $3::timestamptz, done_note = $4, evidence_document_id = $5::uuid, version = version + 1 where id = $1::uuid",
      [actionId, caller.membershipId, now.toISOString(), note, input.documentId ?? null],
    );
    await this.event(tx, plan, actionId, 'MARK_DONE', 'OPEN', 'DONE', caller.membershipId, null);
    return (await this.findAction(tx, actionId, today)) as RemediationActionRow;
  }

  /** Staff verify an action that was done (never the person who marked it: 403 `SELF_APPROVAL_DENIED`), or open it again with a note for the contractor. */
  async verify(tx: TenantTx, actionId: string, expectedVersion: number, outcome: 'VERIFIED' | 'REOPEN', note: string | undefined, actor: string, now: Date): Promise<RemediationActionRow> {
    const today = vietnamDateOf(now);
    const action = await this.findAction(tx, actionId, today, true);
    if (action === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (action.version !== expectedVersion) throw versionConflict(action.version);
    if (action.status !== 'DONE') throw new DomainError('REMEDIATION_STATE_INVALID', 409, 'status');
    if (action.doneBy === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    const plan = (await this.findPlan(tx, action.planId, today)) as RemediationPlanRow;
    const text = note === undefined ? null : textOf(note, 'note', 1, 2000);
    if (outcome === 'REOPEN' && text === null) throw invalid('note');
    if (outcome === 'VERIFIED') {
      await tx.query("update machvon.contractor_remediation_action set status = 'VERIFIED', verified_by = $2::uuid, verified_at = $3::timestamptz, verify_note = $4, version = version + 1 where id = $1::uuid", [actionId, actor, now.toISOString(), text]);
    } else {
      await tx.query("update machvon.contractor_remediation_action set status = 'OPEN', done_by = null, done_at = null, done_note = null, evidence_document_id = null, verify_note = $2, version = version + 1 where id = $1::uuid", [actionId, text]);
    }
    await this.event(tx, plan, actionId, outcome === 'VERIFIED' ? 'VERIFY' : 'REOPEN_ACTION', 'DONE', outcome === 'VERIFIED' ? 'VERIFIED' : 'OPEN', actor, text);
    return (await this.findAction(tx, actionId, today)) as RemediationActionRow;
  }

  /** The plan is completed only when every action is verified. */
  async complete(tx: TenantTx, id: string, expectedVersion: number, actor: string, now: Date): Promise<RemediationPlanRow> {
    const today = vietnamDateOf(now);
    const plan = await this.lockedPlan(tx, id, expectedVersion, today);
    const next = nextRemediationStatus(plan.status, 'COMPLETE', { actions: await this.statuses(tx, id, today) });
    await tx.query('update machvon.contractor_remediation_plan set status = $2, closed_at = $3::timestamptz, version = version + 1 where id = $1::uuid', [id, next, now.toISOString()]);
    await this.event(tx, plan, null, 'COMPLETE', plan.status, next, actor, null);
    return (await this.findPlan(tx, id, today)) as RemediationPlanRow;
  }

  /** The plan fails (the contractor did not do what it agreed to) or is cancelled, with a reason. */
  async close(tx: TenantTx, id: string, expectedVersion: number, outcome: 'FAILED' | 'CANCELLED', reason: string, actor: string, now: Date): Promise<RemediationPlanRow> {
    const today = vietnamDateOf(now);
    const plan = await this.lockedPlan(tx, id, expectedVersion, today);
    const move = outcome === 'FAILED' ? 'FAIL' : 'CANCEL';
    const next = nextRemediationStatus(plan.status, move, { actions: await this.statuses(tx, id, today), reason });
    const text = textOf(reason, 'reason', 5, 2000);
    await tx.query('update machvon.contractor_remediation_plan set status = $2, closed_at = $3::timestamptz, closed_reason = $4, version = version + 1 where id = $1::uuid', [id, next, now.toISOString(), text]);
    await this.event(tx, plan, null, move, plan.status, next, actor, text);
    return (await this.findPlan(tx, id, today)) as RemediationPlanRow;
  }

  /** The plans of the contractor with their actions (the portal path limits the rows to its own; the caller is checked again here). */
  async ownPlans(tx: TenantTx, caller: PortalCaller, today: string): Promise<Array<{ plan: RemediationPlanRow; actions: RemediationActionRow[] }>> {
    const plans = await this.listPlans(tx, { contractorId: caller.contractorId, limit: 100 }, today);
    const out: Array<{ plan: RemediationPlanRow; actions: RemediationActionRow[] }> = [];
    for (const plan of plans) out.push({ plan, actions: await this.actions(tx, plan.id, today) });
    return out;
  }

  /** The actions that raise an alert now: not verified, in a plan that was agreed, due within the reminder window or past. */
  async alertable(tx: TenantTx, today: string): Promise<Array<RemediationActionRow & { contractorName: string; facet: 'REMEDIATION_DUE' | 'REMEDIATION_OVERDUE' }>> {
    const policy = (await this.policies.remediation(tx, today)).value;
    const horizon = addDays(today, policy.remind_before_days);
    const rows = await tx.query<ActionSql & { contractor_name: string }>(
      `${ACTION_SELECT(today).replace('from machvon.contractor_remediation_action a', ', c.legal_name as contractor_name from machvon.contractor_remediation_action a')}
        join machvon.contractor_remediation_plan p on p.tenant_id = a.tenant_id and p.id = a.plan_id join machvon.contractor c on c.tenant_id = a.tenant_id and c.id = a.contractor_id
       where a.status <> 'VERIFIED' and p.status in ('AGREED', 'IN_PROGRESS') and a.due_on <= $1::date order by a.due_on, a.id limit 500`,
      [horizon],
    );
    return rows.map((row) => ({ ...actionOf(row), contractorName: row.contractor_name, facet: row.overdue ? ('REMEDIATION_OVERDUE' as const) : ('REMEDIATION_DUE' as const) }));
  }
}

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
