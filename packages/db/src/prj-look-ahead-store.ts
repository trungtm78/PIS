import { randomUUID } from 'node:crypto';
import {
  DomainError,
  LOOK_AHEAD_RULE_CODE,
  LOOK_AHEAD_RULE_TYPE,
  assertConstraintKind,
  assertLookAheadItems,
  assertLookAheadOutcome,
  assertLookAheadWindow,
  daysBetweenCalendarDays,
  lookAheadDefaults,
  lookAheadItemState,
  lookAheadPlanOverdue,
  lookAheadPolicyOf,
  lookAheadWindowEnd,
  ppcOf,
  versionConflict,
  vietnamDateOf,
} from '@machvon/kernel';
import type { LookAheadItemDraft, LookAheadItemState, LookAheadPolicy, Ppc, Provenance } from '@machvon/kernel';
import { SCOPE_FROM } from './prj-project-store.ts';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const LOOK_AHEAD_RESOURCE = 'look_ahead_plan';
export const LOOK_AHEAD_ITEM_RESOURCE = 'look_ahead_item';
export const LOOK_AHEAD_CONSTRAINT_RESOURCE = 'look_ahead_constraint';
const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const MAX_WEEKS_BACK = 12;

export interface LookAheadPolicyReading {
  policy: LookAheadPolicy;
  version: number;
  source: 'RULE' | 'DEFAULT';
  unverified: boolean;
  provenance: Provenance | null;
}

export interface ConstraintView {
  id: string;
  itemId: string;
  kind: string;
  description: string;
  ownerMembershipId: string | null;
  dueOn: string | null;
  status: 'OPEN' | 'CLEARED';
  raisedBy: string;
  raisedAt: string;
  clearedBy: string | null;
  clearedAt: string | null;
  clearNote: string | null;
  version: number;
}

export interface ItemView {
  id: string;
  sequence: number;
  description: string;
  plannedStart: string;
  plannedFinish: string;
  responsible: string | null;
  outcome: 'PLANNED' | 'DONE' | 'NOT_DONE';
  varianceReasonCode: string | null;
  outcomeAt: string | null;
  state: LookAheadItemState;
  constraints: ConstraintView[];
  version: number;
}

export interface PlanView {
  id: string;
  projectId: string;
  weekStart: string;
  windowEnd: string;
  horizonWeeks: number;
  status: 'DRAFT' | 'PUBLISHED';
  policyVersion: number;
  publishedAt: string | null;
  items: ItemView[];
  ppc: Ppc;
  version: number;
}

export interface LookAheadView {
  project: { id: string; code: string; name: string; status: string };
  plan: PlanView | null;
  /** The plans of the weeks before, newest first, each with its PPC. */
  history: Array<{ id: string; weekStart: string; horizonWeeks: number; status: string; ppc: Ppc }>;
  overdue: boolean;
  rule: LookAheadPolicyReading;
}

interface PlanSql {
  id: string;
  project_id: string;
  week_start: string;
  horizon_weeks: number;
  status: 'DRAFT' | 'PUBLISHED';
  policy_version: number;
  published_at: string | null;
  version: string;
}
interface ItemSql {
  id: string;
  plan_id: string;
  sequence: number;
  description: string;
  planned_start: string;
  planned_finish: string;
  responsible: string | null;
  outcome: 'PLANNED' | 'DONE' | 'NOT_DONE';
  variance_reason_code: string | null;
  outcome_at: string | null;
  version: string;
}
interface ConstraintSql {
  id: string;
  item_id: string;
  kind: string;
  description: string;
  owner_membership_id: string | null;
  due_on: string | null;
  status: 'OPEN' | 'CLEARED';
  raised_by: string;
  raised_at: string;
  cleared_by: string | null;
  cleared_at: string | null;
  clear_note: string | null;
  version: string;
}

const PLAN_COLUMNS = `id, project_id, week_start::text as week_start, horizon_weeks, status, policy_version, ${ISO('published_at')} as published_at, version::text as version`;

export interface ProjectRef {
  id: string;
  code: string;
  name: string;
  status: string;
  ownerUnitId: string;
}

/**
 * The look-ahead plan of a project (G1-19): a draft is made with its items for a week (a Monday) and a window within the rule, published once, and then lived: constraints are raised and cleared, and each item is
 * recorded done or not done at the end of the week. The PPC of a week is read from the items that were recorded. A person sees only the projects in the scope of the grant that holds the permission.
 */
export class PrjLookAheadStore {
  private readonly port: GovernancePolicyPort;

  constructor(port: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.port = port;
  }

  async policy(tx: TenantTx, asOf: string | Date): Promise<LookAheadPolicyReading> {
    const found = await this.port.get(tx, LOOK_AHEAD_RULE_TYPE, LOOK_AHEAD_RULE_CODE, asOf);
    if (found === undefined) return { policy: lookAheadPolicyOf(lookAheadDefaults()), version: 0, source: 'DEFAULT', unverified: true, provenance: null };
    return { policy: lookAheadPolicyOf(found.params), version: found.version, source: found.source, unverified: found.unverified, provenance: found.provenance };
  }

  async project(tx: TenantTx, scope: ScopeBuilder, projectId: string, lock = false): Promise<ProjectRef> {
    const visible = scope(2);
    const rows = await tx.query<{ id: string; code: string; name: string; status: string; owner_unit_id: string }>(
      `select p.id, p.code, p.name, p.status, p.owner_unit_id from ${SCOPE_FROM} where p.id = $1::uuid and ${visible.sql} ${lock ? 'for update of p' : ''}`,
      [projectId, ...visible.params],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { id: row.id, code: row.code, name: row.name, status: row.status, ownerUnitId: row.owner_unit_id };
  }

  /** Makes a draft plan with its items. A second plan for the same project and week is refused (409 `LOOK_AHEAD_PLAN_EXISTS`). */
  async create(tx: TenantTx, scope: ScopeBuilder, input: { projectId: string; weekStart: string; horizonWeeks: number; items: readonly LookAheadItemDraft[]; actor: string; now: Date }): Promise<PlanView> {
    const project = await this.project(tx, scope, input.projectId, true);
    const rule = await this.policy(tx, input.now);
    assertLookAheadWindow(input.weekStart, input.horizonWeeks, rule.policy);
    assertLookAheadItems(input.items, input.weekStart, input.horizonWeeks);
    const existing = await tx.query<{ id: string }>('select id from machvon.look_ahead_plan where project_id = $1::uuid and week_start = $2::date', [project.id, input.weekStart]);
    if (existing[0] !== undefined) throw new DomainError('LOOK_AHEAD_PLAN_EXISTS', 409, 'week_start', { extensions: { plan_id: existing[0].id } });
    const id = randomUUID();
    await tx.query(
      `insert into machvon.look_ahead_plan (tenant_id, id, project_id, owner_unit_id, week_start, horizon_weeks, policy_version, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6, $7::uuid, $7::uuid)`,
      [id, project.id, project.ownerUnitId, input.weekStart, input.horizonWeeks, rule.version, input.actor],
    );
    let sequence = 1;
    for (const item of input.items) {
      await tx.query(
        `insert into machvon.look_ahead_item (tenant_id, id, plan_id, project_id, sequence, description, planned_start, planned_finish, responsible, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, $7::date, $8, $9::uuid, $9::uuid)`,
        [randomUUID(), id, project.id, sequence, item.description.trim(), item.plannedStart, item.plannedFinish, item.responsible, input.actor],
      );
      sequence += 1;
    }
    return this.plan(tx, id, vietnamDateOf(input.now), rule.policy);
  }

  /** Publishes a draft once; whoever publishes is the owner of the plan, and a published plan no longer changes what it plans. */
  async publish(tx: TenantTx, scope: ScopeBuilder, input: { planId: string; expectedVersion: number; actor: string; now: Date }): Promise<PlanView> {
    const held = await this.lockPlan(tx, scope, input.planId);
    if (Number(held.version) !== input.expectedVersion) throw versionConflict(Number(held.version));
    if (held.status !== 'DRAFT') throw new DomainError('LOOK_AHEAD_STATE_INVALID', 409, 'id', { extensions: { status: held.status } });
    await tx.query("update machvon.look_ahead_plan set status = 'PUBLISHED', published_by = $2::uuid, published_at = $3::timestamptz, updated_at = $3::timestamptz, updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [held.id, input.actor, input.now.toISOString()]);
    const rule = await this.policy(tx, input.now);
    return this.plan(tx, held.id, vietnamDateOf(input.now), rule.policy);
  }

  async raiseConstraint(tx: TenantTx, scope: ScopeBuilder, input: { itemId: string; kind: string; description: string; ownerMembershipId?: string | undefined; dueOn?: string | undefined; actor: string; now: Date }): Promise<{ constraintId: string; itemId: string; projectId: string; planId: string }> {
    const item = await this.lockItem(tx, scope, input.itemId);
    const rule = await this.policy(tx, input.now);
    assertConstraintKind(input.kind, rule.policy);
    if (input.description.trim().length < 3 || input.description.length > 500) throw new DomainError('VALIDATION_FAILED', 422, 'description');
    if (item.outcome !== 'PLANNED') throw new DomainError('LOOK_AHEAD_STATE_INVALID', 409, 'id', { extensions: { outcome: item.outcome } });
    const id = randomUUID();
    await tx.query(
      `insert into machvon.look_ahead_constraint (tenant_id, id, item_id, plan_id, project_id, kind, description, owner_membership_id, due_on, raised_by, raised_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid, $8::date, $9::uuid, $10::timestamptz)`,
      [id, item.id, item.plan_id, item.project_id, input.kind, input.description.trim(), input.ownerMembershipId ?? null, input.dueOn ?? null, input.actor, input.now.toISOString()],
    );
    return { constraintId: id, itemId: item.id, projectId: item.project_id, planId: item.plan_id };
  }

  async clearConstraint(tx: TenantTx, scope: ScopeBuilder, input: { constraintId: string; expectedVersion: number; note: string | undefined; actor: string; now: Date }): Promise<{ constraintId: string; itemId: string; projectId: string; planId: string }> {
    const visible = scope(2);
    const rows = await tx.query<{ id: string; item_id: string; plan_id: string; project_id: string; status: string; version: string }>(
      `select k.id, k.item_id, k.plan_id, k.project_id, k.status, k.version::text as version
         from machvon.look_ahead_constraint k join ${SCOPE_FROM} on p.tenant_id = k.tenant_id and p.id = k.project_id
        where k.id = $1::uuid and ${visible.sql} for update of k`,
      [input.constraintId, ...visible.params],
    );
    const held = rows[0];
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(held.version) !== input.expectedVersion) throw versionConflict(Number(held.version));
    if (held.status !== 'OPEN') throw new DomainError('LOOK_AHEAD_STATE_INVALID', 409, 'id', { extensions: { status: held.status } });
    await tx.query("update machvon.look_ahead_constraint set status = 'CLEARED', cleared_by = $2::uuid, cleared_at = $3::timestamptz, clear_note = $4, version = version + 1 where id = $1::uuid", [held.id, input.actor, input.now.toISOString(), input.note?.trim() ?? null]);
    return { constraintId: held.id, itemId: held.item_id, projectId: held.project_id, planId: held.plan_id };
  }

  async recordOutcome(tx: TenantTx, scope: ScopeBuilder, input: { itemId: string; expectedVersion: number; outcome: string; reasonCode: string | undefined; actor: string; now: Date }): Promise<{ itemId: string; projectId: string; planId: string; outcome: 'DONE' | 'NOT_DONE' }> {
    const item = await this.lockItem(tx, scope, input.itemId);
    if (Number(item.version) !== input.expectedVersion) throw versionConflict(Number(item.version));
    const plan = await tx.query<{ status: string }>('select status from machvon.look_ahead_plan where id = $1::uuid', [item.plan_id]);
    if (plan[0]?.status !== 'PUBLISHED' || item.outcome !== 'PLANNED') throw new DomainError('LOOK_AHEAD_STATE_INVALID', 409, 'id', { extensions: { plan_status: plan[0]?.status ?? null, outcome: item.outcome } });
    const rule = await this.policy(tx, input.now);
    const outcome = assertLookAheadOutcome(input.outcome, input.reasonCode, rule.policy);
    await tx.query(
      'update machvon.look_ahead_item set outcome = $2, variance_reason_code = $3, outcome_by = $4::uuid, outcome_at = $5::timestamptz, updated_at = $5::timestamptz, updated_by = $4::uuid, version = version + 1 where id = $1::uuid',
      [item.id, outcome, input.reasonCode ?? null, input.actor, input.now.toISOString()],
    );
    return { itemId: item.id, projectId: item.project_id, planId: item.plan_id, outcome };
  }

  private async lockPlan(tx: TenantTx, scope: ScopeBuilder, planId: string): Promise<PlanSql> {
    const visible = scope(2);
    const rows = await tx.query<PlanSql>(
      `select l.id, l.project_id, l.week_start::text as week_start, l.horizon_weeks, l.status, l.policy_version, to_char(l.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as published_at, l.version::text as version
         from machvon.look_ahead_plan l join ${SCOPE_FROM} on p.tenant_id = l.tenant_id and p.id = l.project_id
        where l.id = $1::uuid and ${visible.sql} for update of l`,
      [planId, ...visible.params],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }

  private async lockItem(tx: TenantTx, scope: ScopeBuilder, itemId: string): Promise<{ id: string; plan_id: string; project_id: string; outcome: string; version: string }> {
    const visible = scope(2);
    const rows = await tx.query<{ id: string; plan_id: string; project_id: string; outcome: string; version: string }>(
      `select i.id, i.plan_id, i.project_id, i.outcome, i.version::text as version
         from machvon.look_ahead_item i join ${SCOPE_FROM} on p.tenant_id = i.tenant_id and p.id = i.project_id
        where i.id = $1::uuid and ${visible.sql} for update of i`,
      [itemId, ...visible.params],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }

  /** The plan with its items, their constraints and the state of each item on the day. */
  async plan(tx: TenantTx, planId: string, today: string, policy: LookAheadPolicy): Promise<PlanView> {
    const plans = await tx.query<PlanSql>(`select ${PLAN_COLUMNS} from machvon.look_ahead_plan where id = $1::uuid`, [planId]);
    const plan = plans[0];
    if (plan === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const items = await tx.query<ItemSql>(
      `select id, plan_id, sequence, description, planned_start::text as planned_start, planned_finish::text as planned_finish, responsible, outcome, variance_reason_code, ${ISO('outcome_at')} as outcome_at, version::text as version
         from machvon.look_ahead_item where plan_id = $1::uuid order by sequence`,
      [planId],
    );
    const constraints = await tx.query<ConstraintSql>(
      `select id, item_id, kind, description, owner_membership_id, due_on::text as due_on, status, raised_by, ${ISO('raised_at')} as raised_at, cleared_by, ${ISO('cleared_at')} as cleared_at, clear_note, version::text as version
         from machvon.look_ahead_constraint where plan_id = $1::uuid order by raised_at, id`,
      [planId],
    );
    const byItem = new Map<string, ConstraintView[]>();
    for (const row of constraints) {
      byItem.set(row.item_id, [
        ...(byItem.get(row.item_id) ?? []),
        { id: row.id, itemId: row.item_id, kind: row.kind, description: row.description, ownerMembershipId: row.owner_membership_id, dueOn: row.due_on, status: row.status, raisedBy: row.raised_by, raisedAt: row.raised_at, clearedBy: row.cleared_by, clearedAt: row.cleared_at, clearNote: row.clear_note, version: Number(row.version) },
      ]);
    }
    const views: ItemView[] = items.map((item) => {
      const own = byItem.get(item.id) ?? [];
      return {
        id: item.id,
        sequence: item.sequence,
        description: item.description,
        plannedStart: item.planned_start,
        plannedFinish: item.planned_finish,
        responsible: item.responsible,
        outcome: item.outcome,
        varianceReasonCode: item.variance_reason_code,
        outcomeAt: item.outcome_at,
        state: lookAheadItemState({ plannedStart: item.planned_start, outcome: item.outcome, openConstraints: own.filter((one) => one.status === 'OPEN').length }, today, policy),
        constraints: own,
        version: Number(item.version),
      };
    });
    return {
      id: plan.id,
      projectId: plan.project_id,
      weekStart: plan.week_start,
      windowEnd: lookAheadWindowEnd(plan.week_start, plan.horizon_weeks),
      horizonWeeks: plan.horizon_weeks,
      status: plan.status,
      policyVersion: plan.policy_version,
      publishedAt: plan.published_at,
      items: views,
      ppc: ppcOf(items.map((item) => item.outcome), policy),
      version: Number(plan.version),
    };
  }

  /** The look-ahead of a project: the plan of the current week (or the newest one), the plans before it with their PPC, and whether a new plan is overdue. */
  async view(tx: TenantTx, scope: ScopeBuilder, projectId: string, now: Date): Promise<LookAheadView> {
    const project = await this.project(tx, scope, projectId);
    const rule = await this.policy(tx, now);
    const today = vietnamDateOf(now);
    const plans = await tx.query<{ id: string; week_start: string; horizon_weeks: number; status: string }>(
      `select id, week_start::text as week_start, horizon_weeks, status from machvon.look_ahead_plan where project_id = $1::uuid order by week_start desc limit ${MAX_WEEKS_BACK}`,
      [project.id],
    );
    const current = plans.find((plan) => plan.week_start <= today) ?? plans[0];
    const history: LookAheadView['history'] = [];
    for (const plan of plans) {
      const outcomes = await tx.query<{ outcome: 'PLANNED' | 'DONE' | 'NOT_DONE' }>('select outcome from machvon.look_ahead_item where plan_id = $1::uuid', [plan.id]);
      history.push({ id: plan.id, weekStart: plan.week_start, horizonWeeks: plan.horizon_weeks, status: plan.status, ppc: ppcOf(outcomes.map((row) => row.outcome), rule.policy) });
    }
    const latestPublished = plans.find((plan) => plan.status === 'PUBLISHED');
    const since = project.status === 'IMPLEMENTATION' ? await this.implementingSince(tx, project.id) : null;
    return {
      project: { id: project.id, code: project.code, name: project.name, status: project.status },
      plan: current === undefined ? null : await this.plan(tx, current.id, today, rule.policy),
      history,
      overdue: project.status === 'IMPLEMENTATION' && lookAheadPlanOverdue(latestPublished?.week_start ?? null, today, rule.policy, since),
      rule,
    };
  }

  private async implementingSince(tx: TenantTx, projectId: string): Promise<string | null> {
    const rows = await tx.query<{ since: string | null }>("select min((occurred_at at time zone 'Asia/Ho_Chi_Minh')::date)::text as since from machvon.project_stage_change where project_id = $1::uuid and to_stage = 'IMPLEMENTATION'", [projectId]).catch(() => []);
    return rows[0]?.since ?? null;
  }

  /** The items that start within the lead days of the rule with a constraint still open (or should have started), in the scope of the caller: what the alert centre lists. */
  async notReady(tx: TenantTx, scope: ScopeBuilder, now: Date, limit = 200): Promise<Array<{ itemId: string; planId: string; projectId: string; projectCode: string; description: string; plannedStart: string; openConstraints: number }>> {
    const rule = await this.policy(tx, now);
    const today = vietnamDateOf(now);
    const visible = scope(3);
    const rows = await tx.query<{ item_id: string; plan_id: string; project_id: string; project_code: string; description: string; planned_start: string; open: string }>(
      `select i.id as item_id, i.plan_id, p.id as project_id, p.code as project_code, i.description, i.planned_start::text as planned_start, count(k.id)::text as open
         from machvon.look_ahead_item i
         join machvon.look_ahead_plan l on l.tenant_id = i.tenant_id and l.id = i.plan_id and l.status = 'PUBLISHED'
         join ${SCOPE_FROM} on p.tenant_id = i.tenant_id and p.id = i.project_id
         join machvon.look_ahead_constraint k on k.tenant_id = i.tenant_id and k.item_id = i.id and k.status = 'OPEN'
        where i.outcome = 'PLANNED' and i.planned_start <= ($1::date + $2::int) and ${visible.sql}
        group by i.id, i.plan_id, p.id, p.code, i.description, i.planned_start
        order by i.planned_start, i.id
        limit ${Math.trunc(limit)}`,
      [today, rule.policy.readyLeadDays, ...visible.params],
    );
    return rows.map((row) => ({ itemId: row.item_id, planId: row.plan_id, projectId: row.project_id, projectCode: row.project_code, description: row.description, plannedStart: row.planned_start, openConstraints: Number(row.open) }));
  }

  /** The projects in implementation whose newest published plan is older than the cadence of the rule (or that have none), in the scope of the caller. */
  async missing(tx: TenantTx, scope: ScopeBuilder, now: Date, limit = 200): Promise<Array<{ projectId: string; projectCode: string; since: string | null }>> {
    const rule = await this.policy(tx, now);
    const today = vietnamDateOf(now);
    const visible = scope(1);
    const rows = await tx.query<{ project_id: string; project_code: string; latest: string | null }>(
      `select p.id as project_id, p.code as project_code,
              (select max(l.week_start)::text from machvon.look_ahead_plan l where l.tenant_id = p.tenant_id and l.project_id = p.id and l.status = 'PUBLISHED') as latest
         from ${SCOPE_FROM}
        where p.status = 'IMPLEMENTATION' and ${visible.sql}
        order by p.code, p.id
        limit ${Math.trunc(limit) * 5}`,
      [...visible.params],
    );
    const found: Array<{ projectId: string; projectCode: string; since: string | null }> = [];
    for (const row of rows) {
      if (found.length >= limit) break;
      // A project in implementation that never had a plan is counted from the day it started implementing.
      const since = row.latest === null ? await this.implementingSince(tx, row.project_id) : null;
      if (lookAheadPlanOverdue(row.latest, today, rule.policy, since)) found.push({ projectId: row.project_id, projectCode: row.project_code, since: row.latest ?? since });
    }
    return found;
  }
}

export const daysSince = (from: string, to: string): number => daysBetweenCalendarDays(from, to);

export function lookAheadRecord(action: string, resource: string, resourceId: string, diff: Record<string, unknown>) {
  return { action, resourceType: resource, resourceId, diff };
}
