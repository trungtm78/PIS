import { randomUUID } from 'node:crypto';
import { DomainError, REALLOCATION_DECISIONS, addDecimal, belowFloor, compareDecimal, decidedReallocation, netReductions, positiveVnd, subtractDecimal, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, LineHold, ReallocationDecision, ReallocationStatus } from '@machvon/kernel';
import { CapPlanApprovalStore } from './cap-plan-approval-store.ts';
import type { PlanAuthorizer } from './cap-plan-approval-store.ts';
import { peekPlan, unitOf } from './cap-plan-locks.ts';
import { CapPlanPublicationStore } from './cap-plan-publication-store.ts';
import type { PublishResult } from './cap-plan-publication-store.ts';
import { CapPlanRevisionStore } from './cap-plan-revision-store.ts';
import { idOf, textOf } from './prj-accountability-support.ts';
import { invalid, usableDocumentId } from './prj-stage-support.ts';
import { scopePredicate } from './scope-version.ts';
import type { ScopeBuilder, ScopePredicate } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const REALLOCATION_RESOURCE = 'reallocation_proposal';
export const REALLOCATION_APPLIED_EVENT = 'capital.reallocation_applied.v1';

const UNIQUE_VIOLATION = '23505';
const CODE_INDEX = 'reallocation_proposal_code_uq';
const SAVEPOINT = 'reallocation_write';
const MAX_LINES = 200;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const allow: PlanAuthorizer = () => undefined;

export interface ReallocationLineRow {
  id: string;
  fromAllocationLineId: string;
  fromProjectId: string;
  fromProjectCode: string;
  fromProjectName: string;
  toAllocationLineId: string | null;
  toProjectId: string;
  toProjectCode: string;
  toProjectName: string;
  amountVnd: string;
  /** What the two lines hold in the plan the proposal starts from: the screen shows each side before and after. */
  fromAllocatedVnd: string;
  toAllocatedVnd: string;
  appropriationId: string | null;
  rationale: Record<string, unknown>;
}

export interface ReallocationRow {
  id: string;
  code: string;
  planYear: number;
  scopeUnitId: string;
  scopeUnitName: string;
  basisSnapshotId: string;
  sourceCapitalPlanId: string;
  reason: string;
  status: ReallocationStatus;
  decisionDocumentId: string | null;
  resultingCapitalPlanId: string | null;
  submittedBy: string | null;
  approvedBy: string | null;
  decisionReason: string | null;
  createdBy: string;
  createdAt: string;
  appliedAt: string | null;
  version: number;
  totalVnd: string;
  lines: ReallocationLineRow[];
}

interface ProposalSql {
  id: string;
  code: string;
  plan_year: number;
  scope_unit_id: string;
  scope_unit_name: string;
  basis_snapshot_id: string;
  source_capital_plan_id: string;
  reason: string;
  status: ReallocationStatus;
  decision_document_id: string | null;
  resulting_capital_plan_id: string | null;
  submitted_by: string | null;
  approved_by: string | null;
  decision_reason: string | null;
  created_by: string;
  created_at: string;
  applied_at: string | null;
  version: string;
}

interface LineSql {
  id: string;
  proposal_id: string;
  from_allocation_line_id: string;
  from_project_id: string;
  from_project_code: string;
  from_project_name: string;
  to_allocation_line_id: string | null;
  to_project_id: string;
  to_project_code: string;
  to_project_name: string;
  amount_vnd: string;
  from_allocated_vnd: string;
  to_allocated_vnd: string | null;
  appropriation_id: string | null;
  rationale_json: Record<string, unknown>;
}

const PROPOSAL_COLUMNS = `rp.id, rp.code, rp.plan_year, rp.scope_unit_id, u.name as scope_unit_name, rp.basis_snapshot_id, rp.source_capital_plan_id, rp.reason, rp.status, rp.decision_document_id,
  rp.resulting_capital_plan_id, rp.submitted_by, rp.approved_by, rp.decision_reason, rp.created_by, ${ISO('rp.created_at')} as created_at, ${ISO('rp.applied_at')} as applied_at, rp.version::text as version`;
const PROPOSAL_FROM = `machvon.reallocation_proposal rp join machvon.organization_unit u on u.tenant_id = rp.tenant_id and u.id = rp.scope_unit_id`;

const LINE_SQL = `select l.id, l.proposal_id, l.from_allocation_line_id, l.from_project_id, fp.code as from_project_code, fp.name as from_project_name, l.to_allocation_line_id, l.to_project_id, tp.code as to_project_code,
         tp.name as to_project_name, l.amount_vnd::text as amount_vnd, fa.amount_vnd::text as from_allocated_vnd, ta.amount_vnd::text as to_allocated_vnd, fa.appropriation_id, l.rationale_json
    from machvon.reallocation_line l
    join machvon.project fp on fp.tenant_id = l.tenant_id and fp.id = l.from_project_id
    join machvon.project tp on tp.tenant_id = l.tenant_id and tp.id = l.to_project_id
    join machvon.allocation_line fa on fa.tenant_id = l.tenant_id and fa.id = l.from_allocation_line_id
    left join machvon.allocation_line ta on ta.tenant_id = l.tenant_id and ta.id = l.to_allocation_line_id
   where l.proposal_id = any($1::uuid[])
   order by l.created_at, l.id`;

export interface DraftLineInput {
  fromAllocationLineId: string;
  toProjectId: string;
  amountVnd: string;
  rationale?: string | undefined;
}

export interface DraftInput {
  code: string;
  planYear: number;
  scopeUnitId: string;
  basisSnapshotId: string;
  sourceCapitalPlanId: string;
  reason: string;
  lines: readonly DraftLineInput[];
  actor: string;
  /** Judges the unit of the proposal against the grant that holds the permission. */
  authorize: PlanAuthorizer;
}

export interface StepInput {
  id: string;
  expectedVersion: number;
  actor: string;
  now: Date;
  authorize: PlanAuthorizer;
}

export interface DecideInput extends StepInput {
  decision: string;
  reason: string;
}

export interface ApplyInput extends StepInput {
  decisionDocumentId: string;
}

export interface ReallocationChange {
  row: ReallocationRow;
  previousStatus: ReallocationStatus | null;
}

export interface ApplyResult extends ReallocationChange {
  published: PublishResult;
  resultingPlanId: string;
  /** The ledger entries of the move: the same proposal is the source of all of them. */
  transferred: Array<{ entryType: string; projectId: string; allocationLineId: string; amountVnd: string }>;
}

interface SourceLine {
  id: string;
  project_id: string;
  appropriation_id: string;
  bucket: string;
  source_year: number;
  budget_level: string;
  origin: string;
  amount_vnd: string;
  ctmtqg_subset_vnd: string;
}

interface Resolved {
  fromLine: SourceLine;
  toLine: SourceLine;
  amountVnd: string;
  note: string;
}

/**
 * The reallocation of capital from slow to fast projects (ST-CAP-010, CAP 3.1 F5): a proposal drawn from a frozen disbursement snapshot moves whole amounts from lines of the plan in force to other projects that hold a
 * line of the same appropriation (anything else is 422 TRANSFER_UNBALANCED: the total of the appropriation never changes), keeping on every donor line at least what is reserved, committed and disbursed (422
 * REVISED_BELOW_COMMITTED). It is submitted, decided by someone who is neither its author nor its submitter, and applied with a decision document: in one transaction a new revision of the source plan is made, moved
 * through its approval with the people of the proposal, and published, the ledger gaining TRANSFER_OUT and TRANSFER_IN entries that name the proposal as their one source. A plan that has a newer revision than the one the
 * proposal started from is 409 PLAN_CHANGED_SINCE_PROPOSAL and nothing is applied.
 */
export class CapReallocationStore {
  private readonly revisions = new CapPlanRevisionStore();
  private readonly approvals = new CapPlanApprovalStore();
  private readonly publication = new CapPlanPublicationStore();

  async draft(tx: TenantTx, input: DraftInput): Promise<ReallocationChange> {
    const code = textOf(input.code, 'code', { min: 1, max: 50 });
    const reason = textOf(input.reason, 'reason', { min: 20, max: 2000, multiline: true });
    const planYear = input.planYear;
    if (!Number.isInteger(planYear) || planYear < 1990 || planYear > 2100) throw invalid('plan_year');
    const scopeUnitId = idOf(input.scopeUnitId, 'scope_unit_id');
    const snapshotId = idOf(input.basisSnapshotId, 'basis_snapshot_id');
    const planId = idOf(input.sourceCapitalPlanId, 'source_capital_plan_id');
    if (input.lines.length === 0 || input.lines.length > MAX_LINES) throw invalid('lines');
    input.authorize(await unitOf(tx, scopeUnitId));
    const plan = await peekPlan(tx, planId);
    if (plan.status !== 'PUBLISHED') throw new DomainError('PLAN_NOT_PUBLISHED', 409, 'source_capital_plan_id');
    if (plan.planYear !== planYear) throw invalid('plan_year');
    if (plan.scopeUnitId !== scopeUnitId) throw invalid('scope_unit_id');
    const [snapshot] = await tx.query<{ status: string }>('select status from machvon.period_snapshot where id = $1::uuid', [snapshotId]);
    if (snapshot === undefined) throw invalid('basis_snapshot_id');
    if (snapshot.status !== 'FROZEN') throw new DomainError('SNAPSHOT_NOT_FROZEN', 422, 'basis_snapshot_id');
    const wanted = input.lines.map((line, index) => ({
      fromId: idOf(line.fromAllocationLineId, `lines[${index}].from_allocation_line_id`),
      toProjectId: idOf(line.toProjectId, `lines[${index}].to_project_id`),
      amountVnd: positiveVnd(line.amountVnd, `lines[${index}].amount_vnd`),
      note: line.rationale === undefined ? '' : textOf(line.rationale, `lines[${index}].rationale`, { min: 0, max: 2000, multiline: true }),
    }));
    const resolved = await this.resolve(tx, planId, wanted);
    await this.assertFloors(tx, resolved);
    const evidence = await this.evidence(tx, snapshotId, resolved);
    const id = randomUUID();
    await tx.query(`savepoint ${SAVEPOINT}`);
    try {
      await tx.query(
        `insert into machvon.reallocation_proposal (tenant_id, id, code, plan_year, scope_unit_id, basis_snapshot_id, source_capital_plan_id, reason, status, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::integer, $4::uuid, $5::uuid, $6::uuid, $7, 'DRAFT', $8::uuid, $8::uuid)`,
        [id, code, planYear, scopeUnitId, snapshotId, planId, reason, input.actor],
      );
      await tx.query(`release savepoint ${SAVEPOINT}`);
    } catch (error) {
      const failure = error as { code?: string; constraint?: string };
      if (failure.code !== UNIQUE_VIOLATION || failure.constraint !== CODE_INDEX) throw error;
      await tx.query(`rollback to savepoint ${SAVEPOINT}`);
      throw new DomainError('DUPLICATE_KEY', 409, 'code');
    }
    for (const line of resolved) {
      await tx.query(
        `insert into machvon.reallocation_line (tenant_id, id, proposal_id, from_allocation_line_id, to_allocation_line_id, from_project_id, to_project_id, amount_vnd, rationale_json, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::numeric, $7::jsonb, $8::uuid, $8::uuid)`,
        [id, line.fromLine.id, line.toLine.id, line.fromLine.project_id, line.toLine.project_id, line.amountVnd, JSON.stringify({ note: line.note, basis: evidence.get(line.fromLine.project_id) ?? null, recipient_basis: evidence.get(line.toLine.project_id) ?? null }), input.actor],
      );
    }
    return { row: await this.read(tx, id), previousStatus: null };
  }

  /** The author hands the proposal in: what was true when it was drafted is judged again (the plan, the lines, the floors) and the proposal waits for a decision. */
  async submit(tx: TenantTx, input: StepInput): Promise<ReallocationChange> {
    const current = await this.lock(tx, input.id);
    input.authorize(await unitOf(tx, current.scopeUnitId));
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    if (current.status !== 'DRAFT') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status', { extensions: { reallocation_status: current.status } });
    await this.assertPlanUnchanged(tx, current);
    const resolved = await this.resolve(
      tx,
      current.sourceCapitalPlanId,
      current.lines.map((line) => ({ fromId: line.fromAllocationLineId, toProjectId: line.toProjectId, amountVnd: line.amountVnd, note: '' })),
    );
    await this.assertFloors(tx, resolved);
    await tx.query(
      `update machvon.reallocation_proposal set status = 'SUBMITTED', submitted_by = $2::uuid, submitted_at = $3::timestamptz, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
      [current.id, input.actor, input.now.toISOString()],
    );
    return { row: await this.read(tx, current.id), previousStatus: current.status };
  }

  /**
   * Someone who is neither the author nor the submitter decides: approve, reject, or return it to its author. The words are kept. The same rule is in the database, and it is why the plan revision that the application
   * makes can be approved by the same person without breaking the four-eyes of the plan.
   */
  async decide(tx: TenantTx, input: DecideInput): Promise<ReallocationChange> {
    const current = await this.lock(tx, input.id);
    input.authorize(await unitOf(tx, current.scopeUnitId));
    if (input.actor === current.createdBy || input.actor === current.submittedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    if (!(REALLOCATION_DECISIONS as readonly string[]).includes(input.decision)) throw invalid('decision');
    const decision = input.decision as ReallocationDecision;
    const status = decidedReallocation(current.status, decision);
    const reason = textOf(input.reason, 'reason', { min: 5, max: 2000, multiline: true });
    if (decision === 'return') {
      await tx.query(
        `update machvon.reallocation_proposal set status = 'DRAFT', submitted_by = null, submitted_at = null, approved_by = null, decided_by = null, decided_at = null, decision_reason = $2,
                updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid`,
        [current.id, reason, input.actor],
      );
    } else {
      await tx.query(
        `update machvon.reallocation_proposal set status = $2, approved_by = $3, decided_by = $4::uuid, decided_at = $5::timestamptz, decision_reason = $6, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid`,
        [current.id, status, decision === 'approve' ? input.actor : null, input.actor, input.now.toISOString(), reason],
      );
    }
    return { row: await this.read(tx, current.id), previousStatus: current.status };
  }

  /**
   * The application (CAP 3.1 F5): a revision of the plan is made, carrying the move, approved with the people of the proposal and published with the decision document, and the proposal is APPLIED, all in the
   * transaction of the command. The applier is neither the author nor the submitter (the four-eyes of the publication of the plan).
   */
  async apply(tx: TenantTx, input: ApplyInput): Promise<ApplyResult> {
    const current = await this.lock(tx, input.id);
    input.authorize(await unitOf(tx, current.scopeUnitId));
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    if (current.status !== 'APPROVED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status', { extensions: { reallocation_status: current.status } });
    if (current.submittedBy === null || current.approvedBy === null) throw new Error('an approved proposal names who submitted and who approved it');
    const documentId = await usableDocumentId(tx, input.decisionDocumentId, 'decision_document_id');
    await this.assertPlanUnchanged(tx, current);
    const resolved = await this.resolve(
      tx,
      current.sourceCapitalPlanId,
      current.lines.map((line) => ({ fromId: line.fromAllocationLineId, toProjectId: line.toProjectId, amountVnd: line.amountVnd, note: '' })),
    );
    await this.assertFloors(tx, resolved);

    const source = await peekPlan(tx, current.sourceCapitalPlanId);
    // The revision takes effect now, or when the plan it replaces does if that is later: a plan is never put in force before the one it replaces.
    const effectiveAt = source.effectiveAt !== null && new Date(source.effectiveAt).getTime() > input.now.getTime() ? source.effectiveAt : input.now.toISOString();
    // The revision is the author's, its submission the submitter's and its approval the approver's: the people of the proposal, so that the plan keeps its own four-eyes.
    const revision = await this.revisions.create(tx, current.sourceCapitalPlanId, source.version, current.createdBy, allow);
    await this.moveCapital(tx, revision.id, resolved, input.actor);
    const submitted = await this.approvals.submit(tx, revision.id, revision.version, current.submittedBy, allow);
    const decided = await this.approvals.decide(tx, revision.id, submitted.version, 'approve', current.decisionReason ?? 'Approved with the reallocation proposal', current.approvedBy, allow);
    const published = await this.publication.publish(
      tx,
      revision.id,
      decided.version,
      { decisionDocumentId: documentId, effectiveAt, transfer: { proposalId: current.id } },
      input.actor,
      allow,
      vietnamDateOf(input.now),
      input.now,
    );
    await tx.query(
      `update machvon.reallocation_proposal set status = 'APPLIED', decision_document_id = $2::uuid, resulting_capital_plan_id = $3::uuid, applied_at = $4::timestamptz, applied_by = $5::uuid,
              updated_at = now(), updated_by = $5::uuid, version = version + 1 where id = $1::uuid`,
      [current.id, documentId, revision.id, input.now.toISOString(), input.actor],
    );
    return {
      row: await this.read(tx, current.id),
      previousStatus: current.status,
      published,
      resultingPlanId: revision.id,
      transferred: published.ledger.map((entry) => ({ entryType: entry.entryType, projectId: entry.projectId, allocationLineId: entry.allocationLineId, amountVnd: entry.amountVnd })),
    };
  }

  async find(tx: TenantTx, id: string): Promise<ReallocationRow | undefined> {
    const [row] = await tx.query<ProposalSql>(`select ${PROPOSAL_COLUMNS} from ${PROPOSAL_FROM} where rp.id = $1::uuid`, [id]);
    if (row === undefined) return undefined;
    return (await this.withLines(tx, [row]))[0];
  }

  /** The proposals whose unit lies in a subtree the caller holds the permission over, the newest first, one page after the anchor (`createdAt|id`). */
  async list(tx: TenantTx, filter: { status?: string | undefined; planYear?: number | undefined }, scope: ScopeBuilder, page: { limit: number; after?: { createdAt: string; id: string } | undefined }): Promise<ReallocationRow[]> {
    const predicate: ScopePredicate = scope(5);
    const rows = await tx.query<ProposalSql>(
      `select ${PROPOSAL_COLUMNS} from ${PROPOSAL_FROM}
        where ($1::text is null or rp.status = $1) and ($2::integer is null or rp.plan_year = $2::integer) and ($3::timestamptz is null or (rp.created_at, rp.id) < ($3::timestamptz, $4::uuid)) and (${predicate.sql})
        order by rp.created_at desc, rp.id desc limit ${Math.trunc(page.limit) + 1}`,
      [filter.status ?? null, filter.planYear ?? null, page.after?.createdAt ?? null, page.after?.id ?? NIL_UUID, ...predicate.params],
    );
    return this.withLines(tx, rows);
  }

  private async lock(tx: TenantTx, id: string): Promise<ReallocationRow> {
    const found = await tx.query<{ id: string }>('select id from machvon.reallocation_proposal where id = $1::uuid for update', [idOf(id, 'id')]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return this.read(tx, id);
  }

  private async read(tx: TenantTx, id: string): Promise<ReallocationRow> {
    const row = await this.find(tx, id);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }

  private async withLines(tx: TenantTx, proposals: readonly ProposalSql[]): Promise<ReallocationRow[]> {
    if (proposals.length === 0) return [];
    const lines = await tx.query<LineSql>(LINE_SQL, [proposals.map((proposal) => proposal.id)]);
    return proposals.map((proposal) => {
      const own = lines.filter((line) => line.proposal_id === proposal.id).map(
        (line): ReallocationLineRow => ({
          id: line.id,
          fromAllocationLineId: line.from_allocation_line_id,
          fromProjectId: line.from_project_id,
          fromProjectCode: line.from_project_code,
          fromProjectName: line.from_project_name,
          toAllocationLineId: line.to_allocation_line_id,
          toProjectId: line.to_project_id,
          toProjectCode: line.to_project_code,
          toProjectName: line.to_project_name,
          amountVnd: line.amount_vnd,
          fromAllocatedVnd: line.from_allocated_vnd,
          toAllocatedVnd: line.to_allocated_vnd ?? '0',
          appropriationId: line.appropriation_id,
          rationale: line.rationale_json,
        }),
      );
      return {
        id: proposal.id,
        code: proposal.code,
        planYear: proposal.plan_year,
        scopeUnitId: proposal.scope_unit_id,
        scopeUnitName: proposal.scope_unit_name,
        basisSnapshotId: proposal.basis_snapshot_id,
        sourceCapitalPlanId: proposal.source_capital_plan_id,
        reason: proposal.reason,
        status: proposal.status,
        decisionDocumentId: proposal.decision_document_id,
        resultingCapitalPlanId: proposal.resulting_capital_plan_id,
        submittedBy: proposal.submitted_by,
        approvedBy: proposal.approved_by,
        decisionReason: proposal.decision_reason,
        createdBy: proposal.created_by,
        createdAt: proposal.created_at,
        appliedAt: proposal.applied_at,
        version: Number(proposal.version),
        totalVnd: own.reduce((total, line) => addDecimal(total, line.amountVnd), '0'),
        lines: own,
      };
    });
  }

  /**
   * The donor line and the recipient line of every line of the proposal, read in the plan the proposal starts from: the donor is a line of that plan; the recipient is the line of the receiving project in the same
   * appropriation, bucket, source year and budget level (the same origin when there are several). A project with no such line is a move to another appropriation: 422 TRANSFER_UNBALANCED.
   */
  private async resolve(tx: TenantTx, planId: string, wanted: ReadonlyArray<{ fromId: string; toProjectId: string; amountVnd: string; note: string }>): Promise<Resolved[]> {
    const lines = await tx.query<SourceLine>(
      `select al.id, al.project_id, al.appropriation_id, al.bucket, al.source_year, al.budget_level, al.origin, al.amount_vnd::text as amount_vnd, al.ctmtqg_subset_vnd::text as ctmtqg_subset_vnd
         from machvon.allocation_line al join machvon.plan_version pv on pv.tenant_id = al.tenant_id and pv.id = al.plan_version_id
        where pv.capital_plan_id = $1::uuid and al.appropriation_id is not null and al.project_id is not null order by al.id`,
      [planId],
    );
    const byId = new Map(lines.map((line) => [line.id, line]));
    const done: Resolved[] = [];
    const used = new Set<string>();
    wanted.forEach((line, index) => {
      const from = byId.get(line.fromId);
      if (from === undefined) throw invalid(`lines[${index}].from_allocation_line_id`);
      if (line.toProjectId === from.project_id) throw invalid(`lines[${index}].to_project_id`);
      const candidates = lines.filter(
        (candidate) => candidate.project_id === line.toProjectId && candidate.appropriation_id === from.appropriation_id && candidate.bucket === from.bucket && candidate.source_year === from.source_year && candidate.budget_level === from.budget_level,
      );
      const to = candidates.find((candidate) => candidate.origin === from.origin) ?? candidates[0];
      if (to === undefined) throw new DomainError('TRANSFER_UNBALANCED', 422, `lines[${index}].to_project_id`, { extensions: { from_line_id: from.id, to_project_id: line.toProjectId } });
      const key = `${from.id}|${to.id}`;
      if (used.has(key)) throw invalid(`lines[${index}].from_allocation_line_id`);
      used.add(key);
      done.push({ fromLine: from, toLine: to, amountVnd: line.amountVnd, note: line.note });
    });
    return done;
  }

  /** A donor line keeps at least what is reserved, committed and disbursed on it (BR-CAP-05): the lines that would end below it are listed. */
  private async assertFloors(tx: TenantTx, resolved: readonly Resolved[]): Promise<void> {
    // A line that gives and receives in the same proposal ends with the difference, and is judged by it.
    const reductions = netReductions(resolved.map((line) => ({ fromLineId: line.fromLine.id, toLineId: line.toLine.id, amountVnd: line.amountVnd })));
    const balances = await tx.query<{ allocation_line_id: string; allocated_vnd: string; reserved_vnd: string; committed_vnd: string; disbursed_vnd: string }>(
      'select allocation_line_id, allocated_vnd::text as allocated_vnd, reserved_vnd::text as reserved_vnd, committed_vnd::text as committed_vnd, disbursed_vnd::text as disbursed_vnd from machvon.allocation_balance where allocation_line_id = any($1::uuid[])',
      [[...reductions.keys()]],
    );
    const holds = new Map<string, LineHold>(balances.map((row) => [row.allocation_line_id, { allocatedVnd: row.allocated_vnd, reservedVnd: row.reserved_vnd, committedVnd: row.committed_vnd, disbursedVnd: row.disbursed_vnd }]));
    for (const line of resolved) {
      if (reductions.has(line.fromLine.id) && !holds.has(line.fromLine.id)) holds.set(line.fromLine.id, { allocatedVnd: line.fromLine.amount_vnd, reservedVnd: '0', committedVnd: '0', disbursedVnd: '0' });
    }
    const below = belowFloor(reductions, holds);
    if (below.length === 0) return;
    throw new DomainError('REVISED_BELOW_COMMITTED', 422, 'lines', {
      extensions: { lines: below.map((line) => ({ line_id: line.lineId, allocated_vnd: line.allocatedVnd, reduced_vnd: line.reducedVnd, minimum_vnd: line.floorVnd })) },
    });
  }

  /** The basis the proposal rests on, from the frozen snapshot: what the plan held and what the Treasury paid for each project that gives or receives. */
  private async evidence(tx: TenantTx, snapshotId: string, resolved: readonly Resolved[]): Promise<Map<string, Record<string, unknown>>> {
    const projects = [...new Set(resolved.flatMap((line) => [line.fromLine.project_id, line.toLine.project_id]))];
    const rows = await tx.query<{ project_id: string; plan_total_vnd: string; disbursed_vnd: string | null }>(
      `select project_id, sum(plan_total_vnd)::text as plan_total_vnd, sum(disbursed_treasury_vnd)::text as disbursed_vnd from machvon.period_snapshot_line where snapshot_id = $1::uuid and project_id = any($2::uuid[]) group by project_id`,
      [snapshotId, projects],
    );
    return new Map(rows.map((row) => [row.project_id, { snapshot_id: snapshotId, plan_total_vnd: row.plan_total_vnd, disbursed_treasury_vnd: row.disbursed_vnd }]));
  }

  /** The plan the proposal starts from is still the plan in force and has no newer revision: otherwise what was drafted is no longer a move on the plan that stands (409 PLAN_CHANGED_SINCE_PROPOSAL). */
  private async assertPlanUnchanged(tx: TenantTx, proposal: ReallocationRow): Promise<void> {
    const [plan] = await tx.query<{ status: string; newer: string }>(
      `select cp.status, (select count(*) from machvon.capital_plan other where other.plan_code = cp.plan_code and other.revision > cp.revision and other.status in ('PUBLISHED', 'SUPERSEDED'))::text as newer
         from machvon.capital_plan cp where cp.id = $1::uuid`,
      [proposal.sourceCapitalPlanId],
    );
    if (plan === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (plan.status !== 'PUBLISHED' || Number(plan.newer) > 0) throw new DomainError('PLAN_CHANGED_SINCE_PROPOSAL', 409, 'source_capital_plan_id');
  }

  /**
   * Makes the move on the lines of the new revision: each donor line is reduced and each recipient line increased by the amounts of the proposal, the copy of a line being the one that names it as its
   * `previous_line_id`. The subset of the central programme of a line stays within the line (422 SUBSET_EXCEEDS_PARENT otherwise).
   */
  private async moveCapital(tx: TenantTx, planId: string, resolved: readonly Resolved[], actor: string): Promise<void> {
    const copies = await tx.query<{ id: string; previous_line_id: string; amount_vnd: string; ctmtqg_subset_vnd: string }>(
      `select al.id, al.previous_line_id, al.amount_vnd::text as amount_vnd, al.ctmtqg_subset_vnd::text as ctmtqg_subset_vnd
         from machvon.allocation_line al join machvon.plan_version pv on pv.tenant_id = al.tenant_id and pv.id = al.plan_version_id where pv.capital_plan_id = $1::uuid and al.previous_line_id is not null`,
      [planId],
    );
    const copyOf = new Map(copies.map((copy) => [copy.previous_line_id, copy]));
    const change = new Map<string, string>();
    for (const line of resolved) {
      change.set(line.fromLine.id, subtractDecimal(change.get(line.fromLine.id) ?? '0', line.amountVnd));
      change.set(line.toLine.id, addDecimal(change.get(line.toLine.id) ?? '0', line.amountVnd));
    }
    for (const [sourceId, delta] of [...change].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const copy = copyOf.get(sourceId);
      if (copy === undefined) throw new Error('a line of the revision has no copy of the line it came from');
      const amount = addDecimal(copy.amount_vnd, delta);
      if (compareDecimal(amount, copy.ctmtqg_subset_vnd) < 0) throw new DomainError('SUBSET_EXCEEDS_PARENT', 422, 'lines', { extensions: { line_id: sourceId } });
      await tx.query('update machvon.allocation_line set amount_vnd = $2::numeric, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [copy.id, amount, actor]);
    }
  }
}

/** The scope of the list: the proposals whose unit lies in a subtree the caller holds the permission over (the alias `u` of the list query). */
export function reallocationScope(access: EffectiveAccess, permission: string, now: Date): ScopeBuilder {
  return (first: number): ScopePredicate => scopePredicate(access, permission, now, { unitPath: 'u.path', unitId: 'u.id' }, first);
}

/** The audit row of a step of a proposal. The words of the reason are never copied into it. */
export function reallocationRecord(action: string, change: ReallocationChange) {
  const { row } = change;
  return {
    action: `capital.reallocation_${action}`,
    resourceType: REALLOCATION_RESOURCE,
    resourceId: row.id,
    diff: { code: row.code, plan_year: row.planYear, from_status: change.previousStatus, status: row.status, line_count: row.lines.length, total_vnd: row.totalVnd, source_capital_plan_id: row.sourceCapitalPlanId, basis_snapshot_id: row.basisSnapshotId },
  };
}

/** The event `capital.reallocation_applied.v1`: the move, line by line, and the revision of the plan it made. */
export function reallocationAppliedEvent(result: ApplyResult, tenantId: string, actor: string, occurredAt: Date) {
  const { row } = result;
  return {
    aggregateType: REALLOCATION_RESOURCE,
    aggregateId: row.id,
    aggregateVersion: row.version,
    type: REALLOCATION_APPLIED_EVENT,
    schemaVersion: 1,
    payload: {
      tenant_id: tenantId,
      proposal_id: row.id,
      version: row.version,
      actor_id: actor,
      occurred_at: occurredAt.toISOString(),
      plan_year: row.planYear,
      source_capital_plan_id: row.sourceCapitalPlanId,
      resulting_capital_plan_id: result.resultingPlanId,
      decision_document_id: row.decisionDocumentId,
      total_vnd: row.totalVnd,
      lines: row.lines.map((line) => ({ from_project_id: line.fromProjectId, to_project_id: line.toProjectId, from_allocation_line_id: line.fromAllocationLineId, to_allocation_line_id: line.toAllocationLineId, amount_vnd: line.amountVnd })),
    },
    eventKey: `${REALLOCATION_RESOURCE}:${row.id}:applied`,
  };
}
