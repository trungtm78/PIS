import { randomUUID } from 'node:crypto';
import {
  DomainError,
  addDecimal,
  assertPromotable,
  assertRunnable,
  assumptionsJson,
  constraintsJson,
  infeasible,
  parseAssumptions,
  parseConstraints,
  promotionReason,
  proposalCodeOf,
  resultJson,
  simulate,
  versionConflict,
} from '@machvon/kernel';
import type { EffectiveAccess, LineBasis, ResolvedMove, ScenarioConstraints, ScenarioMove, ScenarioStatus } from '@machvon/kernel';
import type { PlanAuthorizer } from './cap-plan-approval-store.ts';
import { peekPlan, unitOf } from './cap-plan-locks.ts';
import { CapReallocationStore } from './cap-reallocation-store.ts';
import type { ReallocationChange } from './cap-reallocation-store.ts';
import { TIMESTAMP } from './ctr-contract-store.ts';
import { idOf, textOf } from './prj-accountability-support.ts';
import { invalid } from './prj-stage-support.ts';
import { scopePredicate } from './scope-version.ts';
import type { ScopeBuilder, ScopePredicate } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const SCENARIO_RESOURCE = 'allocation_scenario';

const UNIQUE_VIOLATION = '23505';
const CODE_INDEX = 'allocation_scenario_code_uq';
const SAVEPOINT = 'scenario_write';
const MAX_PAGE = 200;
const STATUSES: readonly string[] = ['DRAFT', 'RUN', 'PROMOTED', 'ARCHIVED'];

export interface ScenarioRow {
  id: string;
  code: string;
  planYear: number;
  baseCapitalPlanId: string;
  basePlanCode: string;
  scopeUnitId: string;
  scopeUnitName: string;
  scopeUnitPath: string;
  inputSnapshotId: string | null;
  constraints: Record<string, unknown>;
  assumptions: Record<string, unknown>;
  result: Record<string, unknown> | null;
  status: ScenarioStatus;
  promotedProposalId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface ScenarioChange {
  row: ScenarioRow;
  previousStatus: ScenarioStatus | null;
}

export interface PromoteResult extends ScenarioChange {
  proposal: ReallocationChange;
}

export interface CreateScenarioInput {
  code: string;
  planYear: number;
  baseCapitalPlanId: string;
  inputSnapshotId?: string | undefined;
  constraints: unknown;
  assumptions: unknown;
  actor: string;
  /** Judges the unit of the base plan against the grant that holds the permission. */
  authorize: PlanAuthorizer;
}

export interface StepInput {
  id: string;
  expectedVersion: number;
  actor: string;
  now: Date;
  authorize: PlanAuthorizer;
}

export interface ScenarioFilter {
  status?: string | undefined;
  planYear?: number | undefined;
  limit?: number | undefined;
  after?: { createdAt: string; id: string } | undefined;
}

interface ScenarioSql {
  id: string;
  code: string;
  plan_year: number;
  base_capital_plan_id: string;
  base_plan_code: string;
  scope_unit_id: string;
  scope_unit_name: string;
  scope_unit_path: string;
  input_snapshot_id: string | null;
  constraints_json: Record<string, unknown>;
  assumptions_json: Record<string, unknown>;
  result_json: Record<string, unknown> | null;
  status: ScenarioStatus;
  promoted_proposal_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  version: string;
}

const COLUMNS = `s.id, s.code, s.plan_year, s.base_capital_plan_id, cp.plan_code as base_plan_code, cp.scope_unit_id, u.name as scope_unit_name, u.path::text as scope_unit_path, s.input_snapshot_id, s.constraints_json,
  s.assumptions_json, s.result_json, s.status, s.promoted_proposal_id, s.created_by, ${TIMESTAMP('s.created_at')} as created_at, ${TIMESTAMP('s.updated_at')} as updated_at, s.version::text as version`;
const FROM = `machvon.allocation_scenario s
  join machvon.capital_plan cp on cp.tenant_id = s.tenant_id and cp.id = s.base_capital_plan_id
  join machvon.organization_unit u on u.tenant_id = cp.tenant_id and u.id = cp.scope_unit_id`;

const toRow = (row: ScenarioSql): ScenarioRow => ({
  id: row.id,
  code: row.code,
  planYear: row.plan_year,
  baseCapitalPlanId: row.base_capital_plan_id,
  basePlanCode: row.base_plan_code,
  scopeUnitId: row.scope_unit_id,
  scopeUnitName: row.scope_unit_name,
  scopeUnitPath: row.scope_unit_path,
  inputSnapshotId: row.input_snapshot_id,
  constraints: row.constraints_json,
  assumptions: row.assumptions_json,
  result: row.result_json,
  status: row.status,
  promotedProposalId: row.promoted_proposal_id,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  version: Number(row.version),
});

/**
 * The simulation of an allocation (ST-CAP-013, CAP 3.1 F8, CAP-09). A scenario states moves of capital between the projects of a plan (the assumptions) and the limits they must keep (the constraints); running it applies
 * the moves to a copy of the lines and keeps each line before and after, and a move that breaks a limit is 422 SCENARIO_CONSTRAINT_INFEASIBLE with nothing kept. It reads the plan and the balances and writes only the scenario:
 * never the ledger and never an allocation line. A scenario that has been run is promoted to a DRAFT reallocation proposal, which is submitted, decided and applied as any other.
 */
export class CapScenarioStore {
  private readonly reallocations = new CapReallocationStore();

  async create(tx: TenantTx, input: CreateScenarioInput): Promise<ScenarioChange> {
    const code = textOf(input.code, 'code', { min: 1, max: 50 });
    if (!Number.isInteger(input.planYear) || input.planYear < 1990 || input.planYear > 2100) throw invalid('plan_year');
    const planId = idOf(input.baseCapitalPlanId, 'base_capital_plan_id');
    const snapshotId = input.inputSnapshotId === undefined ? null : idOf(input.inputSnapshotId, 'input_snapshot_id');
    const constraints = constraintsJson(parseConstraints(input.constraints));
    const assumptions = assumptionsJson(parseAssumptions(input.assumptions));
    const plan = await peekPlan(tx, planId);
    input.authorize(await unitOf(tx, plan.scopeUnitId));
    // Only a plan in force is simulated: the lines of a plan still being drawn up or approved are seen by those who draw it up and approve it, not by every reader of the scenarios.
    if (plan.status !== 'PUBLISHED') throw new DomainError('PLAN_NOT_PUBLISHED', 409, 'base_capital_plan_id');
    if (plan.planYear !== input.planYear) throw invalid('plan_year');
    if (snapshotId !== null) {
      const [snapshot] = await tx.query<{ id: string }>('select id from machvon.period_snapshot where id = $1::uuid', [snapshotId]);
      if (snapshot === undefined) throw invalid('input_snapshot_id');
    }
    const id = randomUUID();
    await tx.query(`savepoint ${SAVEPOINT}`);
    try {
      await tx.query(
        `insert into machvon.allocation_scenario (tenant_id, id, code, plan_year, input_snapshot_id, base_capital_plan_id, constraints_json, assumptions_json, status, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::integer, $4::uuid, $5::uuid, $6::jsonb, $7::jsonb, 'DRAFT', $8::uuid, $8::uuid)`,
        [id, code, input.planYear, snapshotId, planId, JSON.stringify(constraints), JSON.stringify(assumptions), input.actor],
      );
      await tx.query(`release savepoint ${SAVEPOINT}`);
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code !== UNIQUE_VIOLATION || failure.constraint !== CODE_INDEX) throw error;
      await tx.query(`rollback to savepoint ${SAVEPOINT}`);
      throw new DomainError('DUPLICATE_KEY', 409, 'code');
    }
    return { row: await this.read(tx, id), previousStatus: null };
  }

  /** The scenario is run on the plan as it stands now: the result replaces the one of an earlier run. A scenario that is promoted is final. */
  async run(tx: TenantTx, input: StepInput): Promise<ScenarioChange> {
    const current = await this.lock(tx, input.id);
    input.authorize(await unitOf(tx, current.scopeUnitId));
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    assertRunnable(current.status);
    if ((await peekPlan(tx, current.baseCapitalPlanId)).status !== 'PUBLISHED') throw new DomainError('PLAN_NOT_PUBLISHED', 409, 'base_capital_plan_id');
    const result = await this.simulateOn(tx, current);
    await tx.query(
      `update machvon.allocation_scenario set status = 'RUN', result_json = $2::jsonb, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [current.id, JSON.stringify(resultJson(result, input.now.toISOString())), input.actor],
    );
    return { row: await this.read(tx, current.id), previousStatus: current.status };
  }

  /**
   * The scenario that was run becomes a DRAFT reallocation proposal on its frozen snapshot, with the moves as its lines. What was true when it was run is judged again (the plan, the lines, the floors and the limits): a
   * plan that has changed since can make the scenario infeasible, and then nothing is promoted.
   */
  async promote(tx: TenantTx, input: StepInput): Promise<PromoteResult> {
    const current = await this.lock(tx, input.id);
    input.authorize(await unitOf(tx, current.scopeUnitId));
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    assertPromotable(current.status);
    if (current.inputSnapshotId === null) throw invalid('input_snapshot_id');
    const result = await this.simulateOn(tx, current);
    const proposal = await this.reallocations.draft(tx, {
      code: proposalCodeOf(current.code),
      planYear: current.planYear,
      scopeUnitId: current.scopeUnitId,
      basisSnapshotId: current.inputSnapshotId,
      sourceCapitalPlanId: current.baseCapitalPlanId,
      reason: promotionReason(current.code, result.moves.length, result.totalMovedVnd),
      lines: movesOf(current).map((move) => ({ fromAllocationLineId: move.fromAllocationLineId, toProjectId: move.toProjectId, amountVnd: move.amountVnd, rationale: move.rationale })),
      actor: input.actor,
      authorize: input.authorize,
    });
    await tx.query(
      `update machvon.allocation_scenario set status = 'PROMOTED', promoted_proposal_id = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
      [current.id, proposal.row.id, input.actor],
    );
    return { row: await this.read(tx, current.id), previousStatus: current.status, proposal };
  }

  async find(tx: TenantTx, id: string): Promise<ScenarioRow | undefined> {
    const [row] = await tx.query<ScenarioSql>(`select ${COLUMNS} from ${FROM} where s.id = $1::uuid`, [id]);
    return row === undefined ? undefined : toRow(row);
  }

  /** The scenarios on plans of the units the caller holds the permission over, the newest first, one page after the anchor (`createdAt|id`). */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: ScenarioFilter): Promise<ScenarioRow[]> {
    if (filter.status !== undefined && !STATUSES.includes(filter.status)) throw invalid('status');
    const predicate: ScopePredicate = scope(5);
    const rows = await tx.query<ScenarioSql>(
      `select ${COLUMNS} from ${FROM}
        where ($1::text is null or s.status = $1) and ($2::integer is null or s.plan_year = $2::integer)
          and ($3::text is null or (${TIMESTAMP('s.created_at')}, s.id) < ($3::text, $4::uuid)) and (${predicate.sql})
        order by ${TIMESTAMP('s.created_at')} desc, s.id desc limit ${Math.min(Math.max(filter.limit ?? 50, 1), MAX_PAGE + 1)}`,
      [filter.status ?? null, filter.planYear ?? null, filter.after?.createdAt ?? null, filter.after?.id ?? null, ...predicate.params],
    );
    return rows.map(toRow);
  }

  /**
   * The moves on the lines of the plan as they are now, with the limits judged: the lines are resolved as a proposal resolves them, a move to a project that holds no line of the same appropriation is a move that
   * cannot be made (NO_RECIPIENT_LINE), and what each line holds comes from its balance.
   */
  private async simulateOn(tx: TenantTx, scenario: ScenarioRow) {
    const moves = movesOf(scenario);
    const constraints = constraintsOf(scenario);
    let resolved;
    try {
      resolved = await this.reallocations.resolve(
        tx,
        scenario.baseCapitalPlanId,
        moves.map((move) => ({ fromId: move.fromAllocationLineId, toProjectId: move.toProjectId, amountVnd: move.amountVnd, note: move.rationale })),
      );
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'TRANSFER_UNBALANCED') throw error;
      const index = Number(/^lines\[(\d+)\]/.exec(error.detail ?? '')?.[1] ?? 0);
      throw infeasible([{ kind: 'NO_RECIPIENT_LINE', move: index, toProjectId: moves[index]?.toProjectId ?? '' }]);
    }
    const steps: ResolvedMove[] = resolved.map((move) => ({
      fromLineId: move.fromLine.id,
      toLineId: move.toLine.id,
      fromProjectId: move.fromLine.project_id,
      toProjectId: move.toLine.project_id,
      amountVnd: move.amountVnd,
      rationale: move.note,
    }));
    // One read gives the lines the moves name and the lines they do not: the figures a line is judged by and the totals a project is shown with come from the same snapshot of the balances, however the year closes meanwhile.
    // A line counts as its balance holds it (capital carried over or lapsed is not in it), as the amount of the plan when it has no balance yet.
    const involved = [...new Set(steps.flatMap((step) => [step.fromProjectId, step.toProjectId]))];
    const held = await tx.query<{ id: string; project_id: string; allocated: string; reserved: string; committed: string; disbursed: string }>(
      `select al.id, al.project_id, coalesce(ab.allocated_vnd, al.amount_vnd)::text as allocated, coalesce(ab.reserved_vnd, 0)::text as reserved, coalesce(ab.committed_vnd, 0)::text as committed,
              coalesce(ab.disbursed_vnd, 0)::text as disbursed
         from machvon.allocation_line al join machvon.plan_version pv on pv.tenant_id = al.tenant_id and pv.id = al.plan_version_id
         left join machvon.allocation_balance ab on ab.tenant_id = al.tenant_id and ab.allocation_line_id = al.id
        where pv.capital_plan_id = $1::uuid and al.project_id = any($2::uuid[]) order by al.id`,
      [scenario.baseCapitalPlanId, involved],
    );
    const named = new Map<string, LineBasis>(held.map((line) => [line.id, { projectId: line.project_id, allocatedVnd: line.allocated, reservedVnd: line.reserved, committedVnd: line.committed, disbursedVnd: line.disbursed }]));
    const totals = new Map<string, string>();
    for (const line of held) totals.set(line.project_id, addDecimal(totals.get(line.project_id) ?? '0', line.allocated));
    return simulate(steps, named, constraints, totals);
  }

  private async lock(tx: TenantTx, id: string): Promise<ScenarioRow> {
    const found = await tx.query<{ id: string }>('select id from machvon.allocation_scenario where id = $1::uuid for update', [idOf(id, 'id')]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return this.read(tx, id);
  }

  private async read(tx: TenantTx, id: string): Promise<ScenarioRow> {
    const row = await this.find(tx, id);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }
}

/** The moves the scenario was made with, read from what was kept (it was validated when it was written and the database does not let it change). */
function movesOf(scenario: ScenarioRow): ScenarioMove[] {
  return parseAssumptions(scenario.assumptions);
}

function constraintsOf(scenario: ScenarioRow): ScenarioConstraints {
  return parseConstraints(scenario.constraints);
}

/** The scope of the list: the scenarios whose base plan lies in a unit in a subtree the caller holds the permission over (the alias `u` of the list query). */
export function scenarioScope(access: EffectiveAccess, permission: string, now: Date): ScopeBuilder {
  return (first: number): ScopePredicate => scopePredicate(access, permission, now, { unitPath: 'u.path', unitId: 'u.id' }, first);
}

/** The audit row of a step of a scenario: the ids and the figures, never the words of the rationale. */
export function scenarioRecord(action: string, change: ScenarioChange) {
  const { row } = change;
  return {
    action: `capital.scenario_${action}`,
    resourceType: SCENARIO_RESOURCE,
    resourceId: row.id,
    diff: { code: row.code, plan_year: row.planYear, from_status: change.previousStatus, status: row.status, base_capital_plan_id: row.baseCapitalPlanId, input_snapshot_id: row.inputSnapshotId, promoted_proposal_id: row.promotedProposalId },
  };
}
