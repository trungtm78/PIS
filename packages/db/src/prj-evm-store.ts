import { randomUUID } from 'node:crypto';
import { DomainError, canonicalJson, computeEvm, eacAgainstTotal, evmRagOf, firstLevelRootOf, lineEvm, rollupLines, sCurve, sha256Hex } from '@machvon/kernel';
import type { AcceptanceFact, B1PolicyReader, EvmFigures, EvmLineFacts, EvmMissing, EvmPolicy, LineEvm, PaymentFact, SCurve } from '@machvon/kernel';
import { DEFAULT_B1_READER, b1PolicyOf } from './b1-policy-reader.ts';
import { idOf } from './prj-accountability-support.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import { lockProject } from './prj-stage-support.ts';
import type { LockedProject, StageScopes } from './prj-stage-support.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The earned value of a project, a work package and a contract (G1-4, G1-5; research F01, F02, F03): the planned value comes from the baseline (the current version, or version 0 when asked), the earned value only from
 * the quantities that were accepted on the contracts that carry the package, the actual cost only from the payments that were certified (a payment that was reversed by the day taking nothing). What cannot be known
 * is "chưa đủ dữ liệu" with the reason, never a zero. The result of a closed period is frozen with the snapshot of the period (`freezeForSnapshot`, called by the freezing of the snapshot) and read from there when
 * the day of the view is the day of a frozen snapshot; the live figures are never written back over a frozen one. The thresholds and the formula of the estimate at completion come from the governance rule `EVM_POLICY`.
 */

export const COMPONENT_CONTRACT_RESOURCE = 'project_component_contract';
const TZ = "'Asia/Ho_Chi_Minh'";
const FROZEN_STATUSES: readonly string[] = ['CLOSED', 'REJECTED', 'CANCELLED'];

export type EvmScope = 'PROJECT' | 'COMPONENT' | 'CONTRACT';
export type BaselineSelection = 'CURRENT' | 'V0';

export interface EvmQuery {
  projectId: string;
  asOf: string;
  scope: EvmScope;
  /** The first-level component (scope COMPONENT) or the contract (scope CONTRACT). */
  ref?: string | undefined;
  baseline: BaselineSelection;
  /** A frozen snapshot of the DIS to read the project-level result from. */
  snapshotId?: string | undefined;
}

export interface EvmRow {
  key: string;
  code: string;
  name: string;
  bacVnd: string;
  pvVnd: string;
  evVnd: string | null;
  acVnd: string | null;
  cpi: string | null;
  spi: string | null;
  ragCpi: string | null;
  ragSpi: string | null;
  missing: EvmMissing[];
  /** The contracts that carry the package. */
  contracts: Array<{ contractId: string; code: string; valueVnd: string }>;
}

export interface EvmPolicyView {
  version: string;
  source: 'RULE' | 'BUILT_IN';
  eacMethod: EvmPolicy['eacMethod'];
  amberBelow: number;
  redBelow: number;
}

export interface EvmView {
  projectId: string;
  projectCode: string;
  scope: EvmScope;
  ref: string | null;
  asOf: string;
  source: 'LIVE' | 'FROZEN';
  snapshotId: string | null;
  frozenAt: string | null;
  payloadSha256: string | null;
  baseline: { version: number | null; selection: BaselineSelection };
  figures: EvmFigures;
  eacAgainstTotal: { overVnd: string; overPct: string | null } | null;
  totalInvestmentVnd: string;
  rows: EvmRow[];
  policy: EvmPolicyView;
}

export interface SCurveView {
  projectId: string;
  projectCode: string;
  scope: EvmScope;
  ref: string | null;
  asOf: string;
  baseline: { version: number | null; selection: BaselineSelection };
  curve: SCurve;
  figures: EvmFigures;
  source: 'LIVE' | 'FROZEN';
  policy: EvmPolicyView;
}

export interface ComponentContractLink {
  id: string;
  projectId: string;
  projectCode: string;
  classification: LockedProject['classification'];
  componentId: string | null;
  contractId: string;
  endedLinkId: string | null;
}

interface LinkSql {
  contract_id: string;
  contract_code: string;
  component_id: string;
  value_vnd: string;
}

interface ProjectSql {
  id: string;
  code: string;
  total: string;
}

interface FactsOf {
  project: ProjectSql;
  versions: Array<{ version: number; lines: EvmLineFacts[] }>;
  links: LinkSql[];
  components: Map<string, string | null>;
  acceptances: AcceptanceFact[];
  payments: PaymentFact[];
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

const roundDiv = (numerator: bigint, denominator: bigint): bigint => (denominator === 0n ? 0n : (numerator * 2n + denominator) / (2n * denominator));

const stringOrNull = (value: bigint | null): string | null => (value === null ? null : value.toString());

export class PrjEvmStore {
  private readonly policy: B1PolicyReader<TenantTx>;

  constructor(policy: B1PolicyReader<TenantTx> = DEFAULT_B1_READER) {
    this.policy = policy;
  }

  /**
   * Links a contract to a first-level work package of its project, or to a lower one (read as its first-level root), or ends the link when `componentId` is null. A contract carries one package at a time: the link
   * before it is ended, not deleted. A contract of another project, a package that has ended or one of another project is 422 `VALIDATION_FAILED`.
   */
  async link(tx: TenantTx, request: { projectId: string; contractId: string; componentId: string | null; actor: string; scopes: StageScopes }): Promise<ComponentContractLink> {
    const project = await lockProject(tx, idOf(request.projectId, 'id'), request.scopes);
    if (FROZEN_STATUSES.includes(project.status)) throw new DomainError('PROJECT_STAGE_INVALID', 422, 'id', { extensions: { project_status: project.status } });
    const contractId = idOf(request.contractId, 'contract_id');
    const [contract] = await tx.query<{ project_id: string | null }>('select project_id from machvon.contract where id = $1::uuid', [contractId]);
    if (contract === undefined || contract.project_id !== project.id) throw invalid('contract_id');
    let componentId: string | null = null;
    if (request.componentId !== null) {
      componentId = idOf(request.componentId, 'component_id');
      const [component] = await tx.query<{ valid_until: string | null }>('select valid_until::text as valid_until from machvon.project_component where id = $1::uuid and project_id = $2::uuid', [componentId, project.id]);
      if (component === undefined || component.valid_until !== null) throw invalid('component_id');
    }
    const [current] = await tx.query<{ id: string; component_id: string }>('select id, component_id from machvon.project_component_contract where contract_id = $1::uuid and ended_at is null for update', [contractId]);
    if (current !== undefined && current.component_id === componentId) throw new DomainError('COMPONENT_CONTRACT_UNCHANGED', 409, 'component_id', { extensions: { link_id: current.id } });
    if (current !== undefined) await tx.query('update machvon.project_component_contract set ended_at = now(), ended_by = $2::uuid where id = $1::uuid', [current.id, request.actor]);
    let id = current?.id ?? '';
    if (componentId !== null) {
      id = randomUUID();
      await tx.query(
        `insert into machvon.project_component_contract (tenant_id, id, project_id, component_id, contract_id, linked_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`,
        [id, project.id, componentId, contractId, request.actor],
      );
    } else if (current === undefined) {
      throw new DomainError('COMPONENT_CONTRACT_UNCHANGED', 409, 'component_id');
    }
    return { id, projectId: project.id, projectCode: project.code, classification: project.classification, componentId, contractId, endedLinkId: current?.id ?? null };
  }

  /** The earned value of the project (or a package, or a contract) on a day, in the scope of the caller. A frozen result is read when the day is the day of a frozen snapshot, or when a snapshot is named. */
  async evm(tx: TenantTx, scope: ScopeBuilder, query: EvmQuery): Promise<EvmView> {
    const project = await this.visible(tx, scope, query.projectId);
    const policy = await b1PolicyOf(this.policy, tx, 'EVM_POLICY', query.asOf);
    const policyView = policyViewOf(policy.version, policy.params);
    if (query.scope === 'PROJECT' && query.baseline === 'CURRENT') {
      const frozen = await this.frozenOf(tx, project.id, query.snapshotId, query.snapshotId === undefined ? query.asOf : undefined);
      if (frozen !== undefined) return { ...frozen, projectCode: project.code, eacAgainstTotal: eacAgainstTotal(frozen.figures.eacVnd, frozen.totalInvestmentVnd), policy: policyView };
    } else if (query.snapshotId !== undefined) {
      throw invalid('snapshot_id');
    }
    const facts = await this.factsOf(tx, project, query.asOf);
    const picked = this.pick(facts, query);
    const view = this.compute(facts, picked, query, policy.params);
    return { ...view, projectCode: project.code, totalInvestmentVnd: project.total, policy: policyView };
  }

  /** The curves of the project on a day: planned by version 0 and by the current baseline, earned and cost up to the day. 422 `BASELINE_MISSING` when version 0 was never taken. */
  async sCurve(tx: TenantTx, scope: ScopeBuilder, query: EvmQuery): Promise<SCurveView> {
    const project = await this.visible(tx, scope, query.projectId);
    const policy = await b1PolicyOf(this.policy, tx, 'EVM_POLICY', query.asOf);
    const facts = await this.factsOf(tx, project, query.asOf);
    const picked = this.pick(facts, { ...query, baseline: 'CURRENT' });
    if (facts.versions.length === 0) throw new DomainError('BASELINE_MISSING', 422, 'baseline');
    const curve = sCurve({ v0: picked.v0, current: picked.current, asOf: query.asOf, acceptances: facts.acceptances, payments: facts.payments });
    const computed = this.compute(facts, picked, { ...query, baseline: 'CURRENT' }, policy.params);
    return { projectId: project.id, projectCode: project.code, scope: query.scope, ref: query.ref ?? null, asOf: query.asOf, baseline: computed.baseline, curve, figures: computed.figures, source: 'LIVE', policy: policyViewOf(policy.version, policy.params) };
  }

  /**
   * Freezes the earned value of every project of a snapshot of a closed period, with the snapshot (called inside the transaction that freezes it): the result of a project that has no baseline is frozen too, as
   * "chưa đủ dữ liệu" with the reason, so the closed period says what it did not know. Written once with its own hash; never changed afterwards.
   */
  async freezeForSnapshot(tx: TenantTx, snapshot: { id: string; asOfDate: string }, actor: string, at: Date): Promise<number> {
    const projects = await tx.query<{ project_id: string; code: string; total: string }>(
      `select distinct l.project_id, p.code, p.total_investment_vnd::text as total
         from machvon.period_snapshot_line l join machvon.project p on p.tenant_id = l.tenant_id and p.id = l.project_id where l.snapshot_id = $1::uuid order by p.code`,
      [snapshot.id],
    );
    const policy = await b1PolicyOf(this.policy, tx, 'EVM_POLICY', snapshot.asOfDate);
    for (const row of projects) {
      const facts = await this.factsOf(tx, { id: row.project_id, code: row.code, total: row.total }, snapshot.asOfDate);
      const query: EvmQuery = { projectId: row.project_id, asOf: snapshot.asOfDate, scope: 'PROJECT', baseline: 'CURRENT' };
      const picked = this.pick(facts, query);
      const computed = this.compute(facts, picked, query, policy.params);
      const figures = { ...computed.figures, rows: computed.rows, totalInvestmentVnd: row.total };
      const payload = { project_id: row.project_id, as_of: snapshot.asOfDate, baseline_version: computed.baseline.version, eac_method: policy.params.eacMethod, policy_version: policy.version, status: computed.figures.status, figures };
      await tx.query(
        `insert into machvon.evm_frozen_result (tenant_id, id, snapshot_id, project_id, as_of_date, baseline_version, eac_method, policy_version, status, figures, payload_sha256, frozen_by, frozen_at)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::date, $5::int, $6, $7, $8, $9::jsonb, $10, $11::uuid, $12::timestamptz)`,
        [randomUUID(), snapshot.id, row.project_id, snapshot.asOfDate, computed.baseline.version, policy.params.eacMethod, policy.version, computed.figures.status, JSON.stringify(figures), sha256Hex(canonicalJson(payload)), actor, at.toISOString()],
      );
    }
    return projects.length;
  }

  /** The links of a project that carry its packages now. */
  async links(tx: TenantTx, scope: ScopeBuilder, projectId: string): Promise<Array<{ id: string; componentId: string; componentCode: string; contractId: string; contractCode: string; contractValueVnd: string; linkedAt: string }>> {
    await this.visible(tx, scope, projectId);
    const rows = await tx.query<{ id: string; component_id: string; component_code: string; contract_id: string; contract_code: string; value: string; linked_at: string }>(
      `select k.id, k.component_id, c.code as component_code, k.contract_id, ct.code as contract_code, ct.contract_value_vnd::text as value, to_char(k.linked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as linked_at
         from machvon.project_component_contract k
         join machvon.project_component c on c.tenant_id = k.tenant_id and c.id = k.component_id
         join machvon.contract ct on ct.tenant_id = k.tenant_id and ct.id = k.contract_id
        where k.project_id = $1::uuid and k.ended_at is null order by c.code, ct.code`,
      [projectId],
    );
    return rows.map((row) => ({ id: row.id, componentId: row.component_id, componentCode: row.component_code, contractId: row.contract_id, contractCode: row.contract_code, contractValueVnd: row.value, linkedAt: row.linked_at }));
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  private async visible(tx: TenantTx, scope: ScopeBuilder, projectId: string): Promise<ProjectSql> {
    const predicate = scope(2);
    const [project] = await tx.query<ProjectSql>(`select p.id, p.code, p.total_investment_vnd::text as total from ${SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql}`, [projectId, ...predicate.params]);
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return project;
  }

  private async frozenOf(tx: TenantTx, projectId: string, snapshotId: string | undefined, asOf: string | undefined): Promise<Omit<EvmView, 'projectCode' | 'eacAgainstTotal' | 'policy'> | undefined> {
    const [row] = await tx.query<{ snapshot_id: string; as_of_date: string; baseline_version: number | null; eac_method: string; figures: Record<string, unknown> & { rows?: EvmRow[]; totalInvestmentVnd?: string }; payload_sha256: string; frozen_at: string }>(
      `select r.snapshot_id, r.as_of_date::text as as_of_date, r.baseline_version, r.eac_method, r.figures, r.payload_sha256, to_char(r.frozen_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as frozen_at
         from machvon.evm_frozen_result r join machvon.period_snapshot s on s.tenant_id = r.tenant_id and s.id = r.snapshot_id
        where r.project_id = $1::uuid and s.status = 'FROZEN' and ($2::uuid is null or r.snapshot_id = $2::uuid) and ($3::date is null or r.as_of_date = $3::date)
        order by s.frozen_at desc limit 1`,
      [projectId, snapshotId ?? null, asOf ?? null],
    );
    if (row === undefined) {
      if (snapshotId !== undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
      return undefined;
    }
    const { rows, totalInvestmentVnd, ...figures } = row.figures;
    return {
      projectId,
      scope: 'PROJECT',
      ref: null,
      asOf: row.as_of_date,
      source: 'FROZEN',
      snapshotId: row.snapshot_id,
      frozenAt: row.frozen_at,
      payloadSha256: row.payload_sha256,
      baseline: { version: row.baseline_version, selection: 'CURRENT' },
      figures: figures as unknown as EvmFigures,
      totalInvestmentVnd: totalInvestmentVnd ?? '0',
      rows: rows ?? [],
    };
  }

  /** Everything the figures are made of, read once: the baseline versions as lines, the links that carry the packages, the accepted quantities and the certified payments. */
  private async factsOf(tx: TenantTx, project: ProjectSql, asOf: string): Promise<FactsOf> {
    void asOf;
    const components = await tx.query<{ id: string; parent_component_id: string | null }>('select id, parent_component_id from machvon.project_component where project_id = $1::uuid', [project.id]);
    const parents = new Map(components.map((row) => [row.id, row.parent_component_id]));
    const links = await tx.query<LinkSql>(
      `select k.contract_id, ct.code as contract_code, k.component_id, ct.contract_value_vnd::text as value_vnd
         from machvon.project_component_contract k join machvon.contract ct on ct.tenant_id = k.tenant_id and ct.id = k.contract_id
        where k.project_id = $1::uuid and k.ended_at is null`,
      [project.id],
    );
    const baselines = await tx.query<{ id: string; version: number }>('select id, version from machvon.project_baseline where project_id = $1::uuid order by version', [project.id]);
    const lines = await tx.query<{ baseline_id: string; component_id: string; code: string; name: string; bac_vnd: string; planned_start: string; planned_finish: string }>(
      `select baseline_id, component_id, code, name, bac_vnd::text as bac_vnd, planned_start::text as planned_start, planned_finish::text as planned_finish from machvon.project_baseline_line where project_id = $1::uuid order by code`,
      [project.id],
    );
    const carried = new Map<string, LinkSql[]>();
    for (const link of links) {
      const root = firstLevelRootOf(link.component_id, parents);
      if (root === undefined) continue;
      carried.set(root, [...(carried.get(root) ?? []), link]);
    }
    const versions = baselines.map((baseline) => ({
      version: baseline.version,
      lines: lines
        .filter((line) => line.baseline_id === baseline.id)
        .map((line): EvmLineFacts => ({
          key: line.component_id,
          code: line.code,
          name: line.name,
          bacVnd: line.bac_vnd,
          plannedStart: line.planned_start,
          plannedFinish: line.planned_finish,
          contracts: (carried.get(line.component_id) ?? []).map((link) => ({ contractId: link.contract_id, valueVnd: link.value_vnd })),
        })),
    }));
    const contractIds = [...new Set(links.map((link) => link.contract_id))];
    const acceptances = await tx.query<{ contract_id: string; day: string; amount: string }>(
      `select a.contract_id, (a.approved_at at time zone ${TZ})::date::text as day, a.accepted_amount_vnd::text as amount
         from machvon.acceptance a where a.contract_id = any($1::uuid[]) and a.status = 'APPROVED' and a.approved_at is not null`,
      [contractIds],
    );
    const payments = await tx.query<{ contract_id: string; day: string; reversed_day: string | null; gross: string }>(
      `select pr.contract_id, (pr.verified_at at time zone ${TZ})::date::text as day, (pr.reversed_at at time zone ${TZ})::date::text as reversed_day, pr.gross_vnd::text as gross
         from machvon.payment_request pr
        where pr.contract_id = any($1::uuid[]) and pr.status in ('VERIFIED', 'SENT_TREASURY', 'SETTLED', 'REVERSED') and pr.request_kind <> 'ADVANCE' and pr.verified_at is not null`,
      [contractIds],
    );
    return {
      project,
      versions,
      links,
      components: parents,
      acceptances: acceptances.map((row) => ({ contractId: row.contract_id, day: row.day, amountVnd: row.amount })),
      payments: payments.map((row) => ({ contractId: row.contract_id, day: row.day, reversedDay: row.reversed_day, grossVnd: row.gross })),
    };
  }

  /** The lines of the scope asked for: the whole project, one first-level package, or the share of a package that one contract carries. */
  private pick(facts: FactsOf, query: Pick<EvmQuery, 'scope' | 'ref' | 'baseline'>): { v0: EvmLineFacts[]; current: EvmLineFacts[]; baselineVersion: number | null; missing: EvmMissing[] } {
    const first = facts.versions[0];
    const last = facts.versions[facts.versions.length - 1];
    const v0 = first === undefined || first.version !== 0 ? [] : first.lines;
    const currentVersion = query.baseline === 'V0' ? first : last;
    const current = currentVersion?.lines ?? [];
    const baselineVersion = currentVersion?.version ?? null;
    if (query.scope === 'PROJECT') return { v0, current, baselineVersion, missing: [] };
    if (query.ref === undefined) throw invalid('ref');
    const ref = idOf(query.ref, 'ref');
    if (query.scope === 'COMPONENT') {
      const root = firstLevelRootOf(ref, facts.components);
      if (root === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'ref');
      return { v0: v0.filter((line) => line.key === root), current: current.filter((line) => line.key === root), baselineVersion, missing: [] };
    }
    const own = facts.links.find((link) => link.contract_id === ref);
    if (own === undefined) return { v0: [], current: [], baselineVersion, missing: ['NO_CONTRACT_LINK'] };
    const root = firstLevelRootOf(own.component_id, facts.components);
    const carriers = facts.links.filter((link) => root !== undefined && firstLevelRootOf(link.component_id, facts.components) === root);
    const total = carriers.reduce((sum, link) => sum + BigInt(link.value_vnd), 0n);
    const share = (lines: EvmLineFacts[]): EvmLineFacts[] =>
      lines
        .filter((line) => line.key === root)
        .map((line) => ({ ...line, bacVnd: roundDiv(BigInt(line.bacVnd) * BigInt(own.value_vnd), total).toString(), contracts: [{ contractId: own.contract_id, valueVnd: own.value_vnd }] }));
    return { v0: share(v0), current: share(current), baselineVersion, missing: [] };
  }

  private compute(
    facts: FactsOf,
    picked: { current: EvmLineFacts[]; baselineVersion: number | null; missing: EvmMissing[] },
    query: Pick<EvmQuery, 'projectId' | 'asOf' | 'scope' | 'ref' | 'baseline'>,
    policy: EvmPolicy,
  ): Omit<EvmView, 'projectCode' | 'totalInvestmentVnd' | 'policy'> {
    const lines: LineEvm[] = picked.current.map((line) => lineEvm(line, query.asOf, facts.acceptances, facts.payments));
    const rolled = rollupLines(lines);
    // A contract that carries no package has no lines at all: the reason is that, not that the project has no baseline.
    const carriesNothing = picked.missing.length > 0 && lines.length === 0;
    const missing = carriesNothing ? [...picked.missing] : [...new Set<EvmMissing>([...rolled.missing, ...picked.missing])];
    const inputs = carriesNothing ? { bac: null, pv: null, ev: null, ac: null, missing } : { ...rolled, missing };
    const figures = computeEvm(inputs, policy.eacMethod, policy, query.asOf);
    const rows = lines.map((line, index): EvmRow => {
      const source = picked.current[index] as EvmLineFacts;
      const own = computeEvm({ bac: line.bacVnd, pv: line.pvVnd, ev: line.evVnd, ac: line.acVnd, missing: line.missing }, policy.eacMethod, policy, query.asOf);
      return {
        key: line.key,
        code: line.code,
        name: line.name,
        bacVnd: line.bacVnd.toString(),
        pvVnd: line.pvVnd.toString(),
        evVnd: stringOrNull(line.evVnd),
        acVnd: stringOrNull(line.acVnd),
        cpi: own.cpi,
        spi: own.spi,
        ragCpi: evmRagOf(own.cpi, policy),
        ragSpi: evmRagOf(own.spi, policy),
        missing: line.missing,
        contracts: source.contracts.map((contract) => ({ contractId: contract.contractId, code: facts.links.find((link) => link.contract_id === contract.contractId)?.contract_code ?? '', valueVnd: contract.valueVnd })),
      };
    });
    return {
      projectId: query.projectId,
      scope: query.scope,
      ref: query.ref ?? null,
      asOf: query.asOf,
      source: 'LIVE',
      snapshotId: null,
      frozenAt: null,
      payloadSha256: null,
      baseline: { version: picked.baselineVersion, selection: query.baseline },
      figures,
      eacAgainstTotal: query.scope === 'PROJECT' ? eacAgainstTotal(figures.eacVnd, facts.project.total) : null,
      rows,
    };
  }
}

const policyViewOf = (version: string, params: EvmPolicy): EvmPolicyView => ({ version, source: version === 'built-in:1' ? 'BUILT_IN' : 'RULE', eacMethod: params.eacMethod, amberBelow: params.amberBelow, redBelow: params.redBelow });

