import { createHash, randomUUID } from 'node:crypto';
import { DomainError, estimateYear, monthOf, planSplitOf, reallocationCandidates, reallocationPolicyDefaults, reallocationPolicyOf, simulateReallocation, impactAssumptions, REALLOCATION_POLICY_DEFAULT_CODE, REALLOCATION_POLICY_RULE_TYPE } from '@machvon/kernel';
import type { CandidateInput, CandidateResult, ImpactMove, ImpactProject, ImpactResult, ProjectedInput, RateSums, ReallocationPolicy } from '@machvon/kernel';
import { DisForecastStore } from './dis-forecast-store.ts';
import type { ForecastProject } from './dis-forecast-store.ts';
import { DisPeriodStore } from './dis-period-store.ts';
import { DisSnapshotStore } from './dis-snapshot-store.ts';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export const REALLOCATION_IMPACT_RESOURCE = 'reallocation_impact';
const ADJUSTMENT_MONTH = 13;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A scope that sees every project: the evidence of an impact is made on the whole basis snapshot, and who may read it is judged by the proposal that owns it. */
export const wholeScope: ScopeBuilder = () => ({ sql: 'true', params: [] });

/** The policy as it was read for one decision: the parsed params and the version that gave them (0 for the built-in default). */
export interface ReadPolicy {
  policy: ReallocationPolicy;
  version: number;
  source: 'RULE' | 'DEFAULT';
  unverified: boolean;
  formula: string | null;
  sourceText: string | null;
  asOf: string | null;
}

/** What a simulation rests on and what it found, for a proposal that is a draft (live) or for the record of one that was handed in (frozen). */
export interface ImpactView {
  proposalId: string;
  basisSnapshotId: string;
  planYear: number;
  asOfDate: string;
  treasuryCutoffDate: string;
  moves: ImpactMove[];
  result: ImpactResult;
  assumptions: Record<string, unknown>;
  policyRuleVersion: number;
  policySource: 'RULE' | 'DEFAULT';
  /** True when the view is the frozen record of the version the proposal was handed in with. */
  frozen: boolean;
  record: { id: string; proposalVersion: number; payloadSha256: string; recordedBy: string; recordedAt: string } | null;
  units: Array<{ id: string; code: string; name: string }>;
  projects: Array<{ id: string; code: string; name: string }>;
}

interface Computed {
  basisSnapshotId: string;
  planYear: number;
  asOfDate: string;
  treasuryCutoffDate: string;
  moves: ImpactMove[];
  basisProjects: ImpactProject[];
  projections: ProjectedInput[];
  result: ImpactResult;
  assumptions: Record<string, unknown>;
  policy: ReadPolicy;
}

interface BasisRow {
  project_id: string;
  unit_id: string | null;
  bucket: string;
  plan_pm: string;
  plan_local: string;
  treasury: string | null;
  reported: string | null;
  ctmtqg: string | null;
  all_none: boolean;
  all_complete: boolean;
}

const EMPTY_SUMS: RateSums = { projects: 1, planPmVnd: '0', planLocalVnd: '0', treasuryVnd: null, reportedVnd: null, ctmtqgVnd: null, allNone: true, allComplete: false };

const hashOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The month of the cutoff in the plan year, as the year-end estimate reads it: the adjustment month for a cutoff after December, 0 for one before January. */
const cutoffMonthOf = (cutoffDate: string, planYear: number): number => {
  const year = Number(cutoffDate.slice(0, 4));
  return year > planYear ? ADJUSTMENT_MONTH : year < planYear ? 0 : monthOf(cutoffDate);
};

/**
 * The impact of a reallocation proposal on the disbursement rates (GOV-11a, G1-12). The basis is the frozen snapshot the proposal was drawn from; the figures are the sums its lines add up to, and the rates are
 * made from them by the same kernel function as DIS (`rateOfSums`), so the numbers an approver reads are the numbers DIS shows. A draft is simulated live; at submit the simulation is written once with the version
 * of the policy that decided its assumptions (`reallocation_impact`, append-only) and that record is what the approver reads from then on.
 */
export class CapReallocationImpactStore {
  private readonly port: GovernancePolicyPort;
  private readonly snapshots = new DisSnapshotStore();
  private readonly periods = new DisPeriodStore();
  private readonly forecasts = new DisForecastStore();

  constructor(port: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.port = port;
  }

  /** The policy in force on the day: the approved rule of the tenant, else the built-in default, judged again as it is read (a rule that cannot be understood is never half applied). */
  async policy(tx: TenantTx, asOf: string | Date): Promise<ReadPolicy> {
    const found = await this.port.get(tx, REALLOCATION_POLICY_RULE_TYPE, REALLOCATION_POLICY_DEFAULT_CODE, asOf);
    if (found === undefined) {
      return { policy: reallocationPolicyDefaults(), version: 0, source: 'DEFAULT', unverified: true, formula: null, sourceText: null, asOf: null };
    }
    return {
      policy: reallocationPolicyOf(found.params),
      version: found.version,
      source: found.source,
      unverified: found.unverified,
      formula: found.provenance?.formula ?? null,
      sourceText: found.provenance?.source ?? null,
      asOf: found.provenance?.asOf ?? null,
    };
  }

  /** The moves of a proposal resolved to the bucket and the denominator they reach. */
  async movesOf(tx: TenantTx, proposalId: string): Promise<ImpactMove[]> {
    const rows = await tx.query<{ from_project_id: string; to_project_id: string; amount: string; bucket: string; origin: string | null }>(
      `select l.from_project_id, l.to_project_id, l.amount_vnd::text as amount, fa.bucket, fa.origin
         from machvon.reallocation_line l join machvon.allocation_line fa on fa.tenant_id = l.tenant_id and fa.id = l.from_allocation_line_id
        where l.proposal_id = $1::uuid order by l.created_at, l.id`,
      [proposalId],
    );
    return rows.map((row) => ({ fromProjectId: row.from_project_id, toProjectId: row.to_project_id, amountVnd: row.amount, bucket: row.bucket, split: planSplitOf(row.origin) }));
  }

  /** What the lines of a frozen snapshot add up to for each project and each bucket (the sums the rates are made from), in the scope given. */
  async basis(tx: TenantTx, snapshotId: string, scope: ScopeBuilder): Promise<ImpactProject[]> {
    const visible = scope(2);
    const rows = await tx.query<BasisRow>(
      `select l.project_id, l.unit_id, l.bucket, coalesce(sum(l.plan_pm_assigned_vnd), 0)::text as plan_pm, coalesce(sum(l.plan_local_added_vnd), 0)::text as plan_local,
              sum(l.disbursed_treasury_vnd)::text as treasury, sum(l.disbursed_reported_vnd)::text as reported, sum(l.ctmtqg_subset_vnd)::text as ctmtqg,
              coalesce(bool_and(l.treasury_coverage = 'NONE'), true) as all_none, coalesce(bool_and(l.treasury_coverage = 'COMPLETE'), false) as all_complete
         from machvon.period_snapshot_line l join ${SCOPE_FROM} on p.tenant_id = l.tenant_id and p.id = l.project_id
        where l.snapshot_id = $1::uuid and ${visible.sql}
        group by l.project_id, l.unit_id, l.bucket
        order by l.project_id, l.bucket`,
      [snapshotId, ...visible.params],
    );
    const byProject = new Map<string, ImpactProject>();
    for (const row of rows) {
      let project = byProject.get(row.project_id);
      if (project === undefined) {
        project = { projectId: row.project_id, unitId: row.unit_id, sums: { CURRENT_YEAR: { ...EMPTY_SUMS }, CARRYOVER: { ...EMPTY_SUMS } } };
        byProject.set(row.project_id, project);
      }
      if (row.bucket !== 'CURRENT_YEAR' && row.bucket !== 'CARRYOVER') continue;
      (project.sums as Record<string, RateSums>)[row.bucket] = {
        projects: 1,
        planPmVnd: row.plan_pm,
        planLocalVnd: row.plan_local,
        treasuryVnd: row.treasury,
        reportedVnd: row.reported,
        ctmtqgVnd: row.ctmtqg,
        allNone: row.all_none,
        allComplete: row.all_complete,
      };
    }
    return [...byProject.values()];
  }

  private async forecastOf(tx: TenantTx, snapshot: { id: string; periodId: string; treasuryCutoffDate: string }, scope: ScopeBuilder): Promise<{ planYear: number; cutoffMonth: number; projects: ForecastProject[] }> {
    const period = await this.periods.find(tx, snapshot.periodId);
    if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'basis_snapshot_id');
    const data = await this.forecasts.read(tx, scope, { snapshotId: snapshot.id, planYear: period.fiscalYear, cutoffDate: snapshot.treasuryCutoffDate });
    return { planYear: period.fiscalYear, cutoffMonth: cutoffMonthOf(snapshot.treasuryCutoffDate, period.fiscalYear), projects: data.projects };
  }

  private async frozenSnapshot(tx: TenantTx, snapshotId: string): Promise<{ id: string; periodId: string; treasuryCutoffDate: string; asOfDate: string }> {
    const snapshot = await this.snapshots.find(tx, snapshotId);
    if (snapshot === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'basis_snapshot_id');
    if (snapshot.status !== 'FROZEN' && snapshot.status !== 'SUPERSEDED') throw new DomainError('SNAPSHOT_NOT_FROZEN', 422, 'basis_snapshot_id');
    return { id: snapshot.id, periodId: snapshot.periodId, treasuryCutoffDate: snapshot.treasuryCutoffDate, asOfDate: snapshot.asOfDate };
  }

  private async compute(tx: TenantTx, proposal: { id: string; basisSnapshotId: string }, now: Date): Promise<Computed> {
    const snapshot = await this.frozenSnapshot(tx, proposal.basisSnapshotId);
    const policy = await this.policy(tx, now);
    const moves = await this.movesOf(tx, proposal.id);
    const basisProjects = await this.basis(tx, snapshot.id, wholeScope);
    const forecast = await this.forecastOf(tx, snapshot, wholeScope);
    const projections: ProjectedInput[] = forecast.projects.map((project) => {
      const estimate = estimateYear({ disbursedVnd: project.disbursedVnd, cutoffMonth: forecast.cutoffMonth, forecasts: project.forecasts, registered: project.registered, planTotalVnd: project.planTotalVnd });
      return { projectId: project.projectId, planTotalVnd: project.planTotalVnd, eacVnd: estimate.eacVnd };
    });
    const result = simulateReallocation({ projects: basisProjects, moves, projections, policy: policy.policy });
    return {
      basisSnapshotId: snapshot.id,
      planYear: forecast.planYear,
      asOfDate: snapshot.asOfDate,
      treasuryCutoffDate: snapshot.treasuryCutoffDate,
      moves,
      basisProjects,
      projections,
      result,
      assumptions: impactAssumptions(policy.policy, policy.version, policy.source),
      policy,
    };
  }

  private async names(tx: TenantTx, moves: readonly ImpactMove[], basis: readonly ImpactProject[]): Promise<Pick<ImpactView, 'units' | 'projects'>> {
    const unitIds = [...new Set(basis.map((project) => project.unitId).filter((id): id is string => id !== null))];
    const projectIds = [...new Set(moves.flatMap((move) => [move.fromProjectId, move.toProjectId]))];
    const units = unitIds.length === 0 ? [] : await tx.query<{ id: string; code: string; name: string }>('select id, code, name from machvon.organization_unit where id = any($1::uuid[]) order by code, id', [unitIds]);
    const projects = projectIds.length === 0 ? [] : await tx.query<{ id: string; code: string; name: string }>('select id, code, name from machvon.project where id = any($1::uuid[]) order by code, id', [projectIds]);
    return { units, projects };
  }

  /** The simulation of a proposal as it stands now (a draft), without writing anything. */
  async simulate(tx: TenantTx, proposal: { id: string; basisSnapshotId: string }, now: Date): Promise<ImpactView> {
    const done = await this.compute(tx, proposal, now);
    return this.view(tx, proposal.id, done, null);
  }

  private async view(tx: TenantTx, proposalId: string, done: Computed, record: ImpactView['record']): Promise<ImpactView> {
    return {
      proposalId,
      basisSnapshotId: done.basisSnapshotId,
      planYear: done.planYear,
      asOfDate: done.asOfDate,
      treasuryCutoffDate: done.treasuryCutoffDate,
      moves: done.moves,
      result: done.result,
      assumptions: done.assumptions,
      policyRuleVersion: done.policy.version,
      policySource: done.policy.source,
      frozen: record !== null,
      record,
      ...(await this.names(tx, done.moves, done.basisProjects)),
    };
  }

  /**
   * Writes the impact of a proposal that was just handed in, once for the version it has now (a second call for the same version changes nothing and returns what was written). The record holds the basis the
   * simulation started from, the result, the assumptions and the version of the policy, with the digest of all of it.
   */
  async record(tx: TenantTx, proposal: { id: string; version: number; basisSnapshotId: string }, actor: string, now: Date): Promise<ImpactView> {
    const existing = await this.frozen(tx, proposal.id, proposal.version);
    if (existing !== undefined) return existing;
    const done = await this.compute(tx, proposal, now);
    const before = { moves: done.moves, basis_projects: done.basisProjects, projections: done.projections };
    const digest = hashOf({ before, result: done.result, assumptions: done.assumptions });
    const id = randomUUID();
    await tx.query(
      `insert into machvon.reallocation_impact
         (tenant_id, id, proposal_id, proposal_version, basis_snapshot_id, plan_year, policy_rule_version, policy_source, assumptions_json, before_json, after_json, warnings_json, payload_sha256, recorded_by, recorded_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::bigint, $4::uuid, $5::integer, $6::integer, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::uuid, $14::timestamptz)`,
      [id, proposal.id, proposal.version, done.basisSnapshotId, done.planYear, done.policy.version, done.policy.source, JSON.stringify(done.assumptions), JSON.stringify(before), JSON.stringify(done.result), JSON.stringify(done.result.warnings), digest, actor, now.toISOString()],
    );
    return this.view(tx, proposal.id, done, { id, proposalVersion: proposal.version, payloadSha256: digest, recordedBy: actor, recordedAt: now.toISOString() });
  }

  /** Whether an impact was recorded for the version of the proposal: the approver may decide only on a recorded impact when the policy says so. */
  async isRecorded(tx: TenantTx, proposalId: string, proposalVersion: number): Promise<boolean> {
    const rows = await tx.query<{ found: boolean }>('select exists (select 1 from machvon.reallocation_impact where proposal_id = $1::uuid and proposal_version = $2::bigint) as found', [proposalId, proposalVersion]);
    return rows[0]?.found === true;
  }

  private async frozen(tx: TenantTx, proposalId: string, proposalVersion?: number): Promise<ImpactView | undefined> {
    const rows = await tx.query<{
      id: string;
      proposal_version: string;
      basis_snapshot_id: string;
      plan_year: number;
      policy_rule_version: number;
      policy_source: 'RULE' | 'DEFAULT';
      assumptions_json: Record<string, unknown>;
      before_json: { moves: ImpactMove[]; basis_projects: ImpactProject[] };
      after_json: ImpactResult;
      payload_sha256: string;
      recorded_by: string;
      recorded_at: string;
    }>(
      `select id, proposal_version::text as proposal_version, basis_snapshot_id, plan_year, policy_rule_version, policy_source, assumptions_json, before_json, after_json, payload_sha256, recorded_by,
              to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at
         from machvon.reallocation_impact where proposal_id = $1::uuid and ($2::bigint is null or proposal_version = $2::bigint)
        order by proposal_version desc limit 1`,
      [proposalId, proposalVersion ?? null],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const snapshot = await this.snapshots.find(tx, row.basis_snapshot_id);
    const names = await this.names(tx, row.before_json.moves, row.before_json.basis_projects);
    return {
      proposalId,
      basisSnapshotId: row.basis_snapshot_id,
      planYear: row.plan_year,
      asOfDate: snapshot?.asOfDate ?? '',
      treasuryCutoffDate: snapshot?.treasuryCutoffDate ?? '',
      moves: row.before_json.moves,
      result: row.after_json,
      assumptions: row.assumptions_json,
      policyRuleVersion: row.policy_rule_version,
      policySource: row.policy_source,
      frozen: true,
      record: { id: row.id, proposalVersion: Number(row.proposal_version), payloadSha256: row.payload_sha256, recordedBy: row.recorded_by, recordedAt: row.recorded_at },
      ...names,
    };
  }

  /** The impact a reader sees: the record of the proposal once it was handed in (the newest version recorded), the live simulation while it is a draft that was never handed in. */
  async read(tx: TenantTx, proposal: { id: string; basisSnapshotId: string; status: string }, now: Date): Promise<ImpactView> {
    const recorded = await this.frozen(tx, proposal.id);
    if (recorded !== undefined && proposal.status !== 'DRAFT') return recorded;
    return this.simulate(tx, proposal, now);
  }

  /**
   * The candidates by performance on a frozen snapshot (the latest close when none is named) in the scope of the caller: donors and recipients with the policy that picked them, and for each donor the lines of the
   * plan in force that may give (their release is within what is not spoken for), and for each recipient the appropriations it holds a line of (a move is within one appropriation).
   */
  async candidates(tx: TenantTx, input: { snapshotId?: string | undefined; unitId?: string | undefined; scope: ScopeBuilder; now: Date }): Promise<CandidatesView> {
    if (input.snapshotId !== undefined && !UUID.test(input.snapshotId)) throw new DomainError('VALIDATION_FAILED', 422, 'snapshot_id');
    const found = input.snapshotId === undefined ? await this.snapshots.latestFrozen(tx) : await this.snapshots.find(tx, input.snapshotId);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
    const snapshot = await this.frozenSnapshot(tx, found.id);
    const policy = await this.policy(tx, input.now);
    const forecast = await this.forecastOf(tx, snapshot, input.scope);
    const unitOf = new Map((await this.basis(tx, snapshot.id, input.scope)).map((project) => [project.projectId, project.unitId]));
    const projects = input.unitId === undefined ? forecast.projects : forecast.projects.filter((project) => unitOf.get(project.projectId) === input.unitId);
    const ids = projects.map((project) => project.projectId);
    const lines = ids.length === 0 ? [] : await this.planLines(tx, forecast.planYear, ids);
    const floorOf = new Map<string, bigint>();
    for (const line of lines) if (line.bucket === 'CURRENT_YEAR') floorOf.set(line.projectId, (floorOf.get(line.projectId) ?? 0n) + BigInt(line.floorVnd));
    const inputs: CandidateInput[] = projects.map((project) => {
      const estimate = estimateYear({ disbursedVnd: project.disbursedVnd, cutoffMonth: forecast.cutoffMonth, forecasts: project.forecasts, registered: project.registered, planTotalVnd: project.planTotalVnd });
      return { projectId: project.projectId, unitId: unitOf.get(project.projectId) ?? null, planTotalVnd: project.planTotalVnd, eacVnd: estimate.eacVnd, floorVnd: (floorOf.get(project.projectId) ?? 0n).toString() };
    });
    const result = reallocationCandidates(inputs, policy.policy);
    const labels = ids.length === 0 ? [] : await tx.query<{ id: string; code: string; name: string }>('select id, code, name from machvon.project where id = any($1::uuid[])', [ids]);
    const unitIds = [...new Set([...result.donors, ...result.recipients].map((entry) => entry.unitId).filter((id): id is string => id !== null))];
    const units = unitIds.length === 0 ? [] : await tx.query<{ id: string; code: string; name: string }>('select id, code, name from machvon.organization_unit where id = any($1::uuid[]) order by code, id', [unitIds]);
    return { snapshotId: snapshot.id, asOfDate: snapshot.asOfDate, treasuryCutoffDate: snapshot.treasuryCutoffDate, planYear: forecast.planYear, policy, result, lines, projects: labels, units };
  }

  private async planLines(tx: TenantTx, planYear: number, projectIds: readonly string[]): Promise<PlanLine[]> {
    const rows = await tx.query<{ project_id: string; id: string; capital_plan_id: string; appropriation_id: string; bucket: string; amount: string; floor: string }>(
      `select al.project_id, al.id, cp.id as capital_plan_id, al.appropriation_id, al.bucket, al.amount_vnd::text as amount,
              (coalesce(b.reserved_vnd, 0) + coalesce(b.committed_vnd, 0) + coalesce(b.disbursed_vnd, 0))::text as floor
         from machvon.allocation_line al
         join machvon.plan_version pv on pv.tenant_id = al.tenant_id and pv.id = al.plan_version_id
         join machvon.capital_plan cp on cp.tenant_id = pv.tenant_id and cp.id = pv.capital_plan_id
         left join machvon.allocation_balance b on b.tenant_id = al.tenant_id and b.allocation_line_id = al.id
        where cp.status = 'PUBLISHED' and cp.plan_year = $1::integer and al.project_id = any($2::uuid[]) and al.appropriation_id is not null
        order by al.project_id, al.id`,
      [planYear, [...projectIds]],
    );
    return rows.map((row) => ({ projectId: row.project_id, allocationLineId: row.id, capitalPlanId: row.capital_plan_id, appropriationId: row.appropriation_id, bucket: row.bucket, amountVnd: row.amount, floorVnd: row.floor }));
  }
}

export interface PlanLine {
  projectId: string;
  allocationLineId: string;
  capitalPlanId: string;
  appropriationId: string;
  bucket: string;
  amountVnd: string;
  /** What is reserved, committed and disbursed on the line: it keeps at least this much. */
  floorVnd: string;
}

export interface CandidatesView {
  snapshotId: string;
  asOfDate: string;
  treasuryCutoffDate: string;
  planYear: number;
  policy: ReadPolicy;
  result: CandidateResult;
  lines: PlanLine[];
  projects: Array<{ id: string; code: string; name: string }>;
  units: Array<{ id: string; code: string; name: string }>;
}

/** The audit row of the record of an impact: ids, the version of the policy and the digest, never the figures. */
export function reallocationImpactRecord(view: ImpactView, actionedBy: string) {
  return {
    action: 'capital.reallocation_impact_recorded',
    resourceType: REALLOCATION_IMPACT_RESOURCE,
    resourceId: view.record?.id ?? view.proposalId,
    diff: { proposal_id: view.proposalId, proposal_version: view.record?.proposalVersion ?? null, basis_snapshot_id: view.basisSnapshotId, policy_rule_version: view.policyRuleVersion, policy_source: view.policySource, payload_sha256: view.record?.payloadSha256 ?? null, recorded_by: actionedBy },
  };
}
