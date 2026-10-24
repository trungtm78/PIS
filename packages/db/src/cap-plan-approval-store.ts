import { DomainError, addDecimal, assertFourEyes, compareDecimal, subtractDecimal, versionConflict } from '@machvon/kernel';
import { DRAFTABLE_PROJECT_STATUSES } from './cap-plan-store.ts';
import {
  appropriationIdsOf,
  assertYearsOpen,
  contributionOf,
  flowLines,
  lockAppropriationRows,
  lockPlans,
  peekPlan,
  setVersionStatus,
  unitOf,
  writeAllocatedTotals,
  yearsOf,
} from './cap-plan-locks.ts';
import type { AllocatedMove, FlowLine, PlanRow } from './cap-plan-locks.ts';
import type { TenantTx } from './tenant-database.ts';

export type CapPlanDecision = 'approve' | 'reject' | 'return';
export const CAP_PLAN_DECISIONS: readonly CapPlanDecision[] = ['approve', 'reject', 'return'];
const REASON_MIN = 5;
const REASON_MAX = 2000;

/** Whether the caller's grants reach the unit the plan belongs to; throws 403 SCOPE_DENIED when they do not. */
export type PlanAuthorizer = (unit: { id: string; path: string }) => void;

export interface SubmitResult {
  planId: string;
  status: 'IN_REVIEW';
  version: number;
  revision: number;
  planYear: number | null;
  lineCount: number;
  projectCount: number;
  totalVnd: string;
}

export interface DecideResult {
  planId: string;
  decision: CapPlanDecision;
  status: 'APPROVED' | 'REJECTED' | 'DRAFT';
  version: number;
  revision: number;
  planYear: number | null;
  lineCount: number;
  /** The ceilings given back to the appropriations when a plan is rejected; empty for the other decisions. */
  released: AllocatedMove[];
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** What the loser of a version conflict is told about the plan: its state and when it last changed, never a line. */
const conflictDiff = (plan: PlanRow): Record<string, unknown> => ({ status: plan.status, updated_at: plan.updatedAt });

interface ReviewRow {
  line_id: string;
  project_status: string | null;
  appropriation_status: string | null;
}

/**
 * The approval of the capital plan (ST-CAP-003, CAP 3.1 F2 steps 3 and 4): a planner submits a DRAFT revision for review, an approver who is
 * neither the person who created it nor the one who submitted it approves it, returns it to the planner with a reason or rejects it. The plan
 * row is locked first and the appropriation rows by their ids after it (the order of the drafting), so a decision never waits for a draft in a
 * cycle. A rejected plan gives back the ceiling it held: the allocated total of an appropriation counts the lines of the live plans only.
 */
export class CapPlanApprovalStore {
  /**
   * Moves a DRAFT revision to IN_REVIEW. The plan needs at least one line and every line must still be valid: its appropriation published and
   * its project in a stage that takes capital. From then on the lines are immutable: the versions of the plan leave DRAFT, which the guard of
   * the lines reads. The unit the plan belongs to must be inside the scope of the grant that holds the permission (`authorize`).
   */
  async submit(tx: TenantTx, planId: string, expectedVersion: number, actor: string, authorize: PlanAuthorizer): Promise<SubmitResult> {
    const peek = await peekPlan(tx, planId);
    authorize(await unitOf(tx, peek.scopeUnitId));
    const [plan] = await lockPlans(tx, [planId]);
    if (plan === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (plan.version !== expectedVersion) throw versionConflict(plan.version, conflictDiff(plan));
    if (plan.status !== 'DRAFT') throw new DomainError('PLAN_NOT_DRAFT', 409, 'status');
    const lines = await flowLines(tx, plan.id);
    if (lines.length === 0) throw invalid('lines');
    const appropriations = await lockAppropriationRows(tx, appropriationIdsOf(lines));
    await assertYearsOpen(tx, yearsOf(plan, appropriations));
    await this.assertLinesValid(tx, plan.id);
    await tx.query(
      `update machvon.capital_plan set status = 'IN_REVIEW', submitted_by = $2::uuid, submitted_at = now(), approved_by = null, decided_at = null, decision_reason = null,
              updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
      [plan.id, actor],
    );
    await setVersionStatus(tx, plan.id, 'IN_REVIEW', actor);
    const total = lines.reduce((sum, line) => addDecimal(sum, line.amountVnd), '0');
    return {
      planId: plan.id,
      status: 'IN_REVIEW',
      version: plan.version + 1,
      revision: plan.revision,
      planYear: plan.planYear,
      lineCount: lines.length,
      projectCount: new Set(lines.map((line) => line.projectId)).size,
      totalVnd: total,
    };
  }

  /**
   * The decision on a plan in review. The person who created the plan and the one who submitted it never decide (403 SELF_APPROVAL_DENIED, judged
   * first, whatever the state). An approval makes the plan APPROVED for publication; a return makes it a DRAFT again for the planner, who reads
   * the reason; a rejection ends the plan and gives its ceilings back.
   */
  async decide(tx: TenantTx, planId: string, expectedVersion: number, decision: CapPlanDecision, reason: string, decider: string, authorize: PlanAuthorizer): Promise<DecideResult> {
    if (!CAP_PLAN_DECISIONS.includes(decision)) throw invalid('decision');
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (text.length < REASON_MIN || text.length > REASON_MAX) throw invalid('reason');
    const peek = await peekPlan(tx, planId);
    authorize(await unitOf(tx, peek.scopeUnitId));
    const [plan] = await lockPlans(tx, [planId]);
    if (plan === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (plan.version !== expectedVersion) throw versionConflict(plan.version, conflictDiff(plan));
    assertFourEyes(plan.createdBy, decider);
    if (plan.submittedBy !== null) assertFourEyes(plan.submittedBy, decider);
    if (plan.status !== 'IN_REVIEW') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    const lines = await flowLines(tx, plan.id);
    const base = {
      planId: plan.id,
      decision,
      version: plan.version + 1,
      revision: plan.revision,
      planYear: plan.planYear,
      lineCount: lines.length,
    };
    if (decision === 'approve') {
      await tx.query(
        `update machvon.capital_plan set status = 'APPROVED', approved_by = $2::uuid, decided_at = now(), decision_reason = $3, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
        [plan.id, decider, text],
      );
      await setVersionStatus(tx, plan.id, 'APPROVED', decider);
      return { ...base, status: 'APPROVED', released: [] };
    }
    if (decision === 'return') {
      await tx.query(
        `update machvon.capital_plan set status = 'DRAFT', submitted_by = null, submitted_at = null, approved_by = null, decided_at = now(), decision_reason = $3,
                updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
        [plan.id, decider, text],
      );
      await setVersionStatus(tx, plan.id, 'DRAFT', decider);
      return { ...base, status: 'DRAFT', released: [] };
    }
    const released = await this.releaseCeilings(tx, plan, lines, decider);
    await tx.query(
      `update machvon.capital_plan set status = 'REJECTED', decided_at = now(), decision_reason = $3, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
      [plan.id, decider, text],
    );
    await setVersionStatus(tx, plan.id, 'REJECTED', decider);
    return { ...base, status: 'REJECTED', released };
  }

  /** The first line that can no longer be part of a plan in review, as the refusal that names why. */
  private async assertLinesValid(tx: TenantTx, planId: string): Promise<void> {
    const rows = await tx.query<ReviewRow>(
      `select al.id as line_id, p.status as project_status, a.status as appropriation_status
         from machvon.allocation_line al
         join machvon.plan_version pv on pv.tenant_id = al.tenant_id and pv.id = al.plan_version_id
         left join machvon.project p on p.tenant_id = al.tenant_id and p.id = al.project_id
         left join machvon.appropriation a on a.tenant_id = al.tenant_id and a.id = al.appropriation_id
        where pv.capital_plan_id = $1::uuid order by al.id`,
      [planId],
    );
    for (const row of rows) {
      if (row.appropriation_status === null) throw invalid('lines');
      if (row.appropriation_status !== 'PUBLISHED') throw new DomainError('APPROPRIATION_NOT_PUBLISHED', 422, 'lines', { extensions: { line_id: row.line_id } });
      if (!DRAFTABLE_PROJECT_STATUSES.includes(row.project_status ?? '')) throw new DomainError('PROJECT_STAGE_INVALID', 422, 'lines', { extensions: { line_id: row.line_id } });
    }
  }

  /**
   * Gives back the ceiling a plan held: what its lines added to the allocated total of each appropriation, less what the lines of the revision it
   * replaces added (a revision counts only the difference). The appropriations are locked in the order of their ids after the plan.
   */
  private async releaseCeilings(tx: TenantTx, plan: PlanRow, lines: readonly FlowLine[], actor: string): Promise<AllocatedMove[]> {
    const base: FlowLine[] = plan.supersedesId === null ? [] : await flowLines(tx, plan.supersedesId);
    const contribution = contributionOf(lines, base);
    const appropriations = await lockAppropriationRows(tx, [...new Set([...appropriationIdsOf(lines), ...appropriationIdsOf(base)])].sort());
    const moves: AllocatedMove[] = [];
    for (const [id, appropriation] of [...appropriations.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const give = contribution.get(id) ?? '0';
      if (compareDecimal(give, '0') === 0) continue;
      const after = subtractDecimal(appropriation.allocatedTotalVnd, give);
      // The allocated total is the sum of the live plans: giving back more than it holds, or more than the appropriation, means the books already disagree.
      if (compareDecimal(after, '0') < 0 || compareDecimal(after, appropriation.amountVnd) > 0 || appropriation.status !== 'PUBLISHED') {
        throw new Error(`the allocated total of appropriation ${id} cannot take back ${give}`);
      }
      moves.push({ id, amountVnd: appropriation.amountVnd, allocatedBeforeVnd: appropriation.allocatedTotalVnd, allocatedAfterVnd: after });
    }
    await writeAllocatedTotals(tx, moves, actor);
    return moves;
  }
}
