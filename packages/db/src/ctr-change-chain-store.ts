import { randomUUID } from 'node:crypto';
import {
  CHANGEABLE_CONTRACT_STATUSES,
  CHANGE_EVENT_KINDS,
  CHANGE_STAGES,
  DomainError,
  EVALUATED_STAGES,
  OPEN_CHANGE_STATUSES,
  changeCode,
  compareDecimal,
  nextStageOf,
  scheduleDays,
  signedVnd,
  startStageOf,
  tierCountOf,
  versionConflict,
} from '@machvon/kernel';
import type { ChangeEventKind, ChangeStage, ChangeStatus, TierCount } from '@machvon/kernel';
import { CtrContractSource } from './ctr-contract-source.ts';
import { CtrContractStore, SCOPE_FROM as CONTRACT_SCOPE_FROM, TIMESTAMP, textOf } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes, LockedContract } from './ctr-contract-store.ts';
import { SCOPE_FROM as PROJECT_SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const MAX_TEXT = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const stageNotAllowed = (extensions: Record<string, unknown>): DomainError => new DomainError('CHANGE_STAGE_NOT_ALLOWED', 422, 'stage', { extensions });
const stateInvalid = (status: string): DomainError => new DomainError('CHANGE_STATE_INVALID', 409, 'status', { extensions: { change_status: status } });
const contractStateInvalid = (status: string): DomainError => new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: status } });

/** The configuration of the tiers of a project as the commands and the screens see it. */
export interface TierConfig {
  id: string;
  projectId: string;
  tierCount: TierCount;
  lockedAt: string | null;
  lockedByChangeId: string | null;
  lockedByCode: string | null;
  setBy: string;
  version: number;
}

export interface SetTiersResult {
  id: string;
  projectId: string;
  tierCount: TierCount;
  previousTierCount: TierCount | null;
  version: number;
}

export interface NewChangeInput {
  stage: string;
  baselineRevisionId: string;
  eventKind?: string | undefined;
  reason: string;
  estimatedDeltaVnd?: string | undefined;
  scheduleImpactDays?: number | undefined;
}

export interface EvaluateInput {
  evaluatedDeltaVnd: string;
  scheduleImpactDays: number;
  fundingImpactNote: string;
  scopeImpactNote?: string | undefined;
  allocationLineId?: string | undefined;
}

/** The refusal of the capital for an increase: the store asks it of CAP through this port and takes whatever it throws (422 `ALLOCATION_UNAVAILABLE`). */
export interface ChangeHooks {
  available(allocationLineId: string, amountVnd: string): Promise<void>;
}

/** A request as the commands answer it, for the audit row, the event and the answer. */
export interface ChangeResult {
  id: string;
  code: string;
  stage: ChangeStage;
  status: ChangeStatus;
  fromStatus: ChangeStatus | null;
  version: number;
  contractId: string;
  contractCode: string;
  projectId: string;
  parentId: string | null;
  eventKind: ChangeEventKind | null;
  estimatedDeltaVnd: string | null;
  evaluatedDeltaVnd: string | null;
  scheduleImpactDays: number;
  allocationLineId: string | null;
  tierCount: TierCount;
  /** Set by the first request of a project: the number of tiers is fixed from now on. */
  lockedTiers: boolean;
  reason: string;
  reach: { projectId: string };
}

/** One request as the chain and the register show it. */
export interface ChangeLine {
  id: string;
  code: string | null;
  stage: ChangeStage;
  status: ChangeStatus;
  contract: { id: string; code: string; status: string };
  projectId: string;
  parentId: string | null;
  eventKind: ChangeEventKind | null;
  baselineRevisionId: string;
  reason: string;
  statusReason: string | null;
  estimatedDeltaVnd: string | null;
  evaluatedDeltaVnd: string | null;
  approvedDeltaVnd: string | null;
  scheduleImpactDays: number;
  fundingImpactNote: string | null;
  scopeImpactNote: string | null;
  allocationLineId: string | null;
  effectiveOn: string | null;
  submittedBy: string | null;
  evaluatedBy: string | null;
  decidedBy: string | null;
  createdAt: string;
  evaluatedAt: string | null;
  decidedAt: string | null;
  version: number;
  /** Where the contract lies, so the caller's permissions can be judged for it. */
  reach: ContractPlace;
}

interface LineSql {
  id: string;
  code: string | null;
  stage: ChangeStage;
  status: ChangeStatus;
  contract_id: string;
  contract_code: string;
  contract_status: string;
  project_id: string;
  parent_id: string | null;
  event_kind: ChangeEventKind | null;
  baseline_revision_id: string;
  reason: string;
  status_reason: string | null;
  estimated_delta_vnd: string | null;
  evaluated_delta_vnd: string | null;
  approved_delta_vnd: string | null;
  schedule_impact_days: number;
  funding_impact_note: string | null;
  scope_impact_note: string | null;
  evaluation_allocation_line_id: string | null;
  effective_on: string | null;
  submitted_by: string | null;
  evaluated_by: string | null;
  decided_by: string | null;
  created_at: string;
  evaluated_at: string | null;
  decided_at: string | null;
  version: string;
}

const COLUMNS = `r.id, r.code, r.stage, r.status, r.contract_id, c.code as contract_code, c.status as contract_status, c.project_id, r.parent_id, r.event_kind, r.baseline_revision_id, r.reason,
  r.status_reason, r.estimated_delta_vnd::text as estimated_delta_vnd, r.evaluated_delta_vnd::text as evaluated_delta_vnd, r.approved_delta_vnd::text as approved_delta_vnd,
  r.schedule_impact_days, r.funding_impact_note, r.scope_impact_note, r.evaluation_allocation_line_id, r.effective_on::text as effective_on, r.submitted_by, r.evaluated_by, r.decided_by,
  ${TIMESTAMP('r.created_at')} as created_at, ${TIMESTAMP('r.evaluated_at')} as evaluated_at, ${TIMESTAMP('r.decided_at')} as decided_at, r.version::text as version`;

/** Where the contract lies: the units of its project, which the permissions of a caller are judged against. */
const REACH_COLUMNS = 'ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path';

interface ReachSql extends LineSql {
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

/** The contract with its project and units (the aliases of the scope builders: `c`, `p`, `ou`, `iu`) and its change requests. */
const FROM = `${CONTRACT_SCOPE_FROM}
  join machvon.change_request r on r.tenant_id = c.tenant_id and r.contract_id = c.id`;

const toLine = (row: ReachSql): ChangeLine => ({
  id: row.id,
  code: row.code,
  stage: row.stage,
  status: row.status,
  contract: { id: row.contract_id, code: row.contract_code, status: row.contract_status },
  projectId: row.project_id,
  parentId: row.parent_id,
  eventKind: row.event_kind,
  baselineRevisionId: row.baseline_revision_id,
  reason: row.reason,
  statusReason: row.status_reason,
  estimatedDeltaVnd: row.estimated_delta_vnd,
  evaluatedDeltaVnd: row.evaluated_delta_vnd,
  approvedDeltaVnd: row.approved_delta_vnd,
  scheduleImpactDays: row.schedule_impact_days,
  fundingImpactNote: row.funding_impact_note,
  scopeImpactNote: row.scope_impact_note,
  allocationLineId: row.evaluation_allocation_line_id,
  effectiveOn: row.effective_on,
  submittedBy: row.submitted_by,
  evaluatedBy: row.evaluated_by,
  decidedBy: row.decided_by,
  createdAt: row.created_at,
  evaluatedAt: row.evaluated_at,
  decidedAt: row.decided_at,
  version: Number(row.version),
  reach: {
    contractId: row.contract_id,
    projectId: row.project_id,
    ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
    investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
  },
});

interface ConfigSql {
  id: string;
  project_id: string;
  tier_count: number;
  locked_at: string | null;
  locked_by_change_id: string | null;
  locked_by_code: string | null;
  created_by: string;
  version: string;
}

/**
 * The chain of changes of a contract (ST-CTR-006, CTR 3.3, BR-CTR-07). The business owner sets how many tiers a project uses (1, 2 or 3); the first request of the project fixes the
 * number for good (409 `CHANGE_TIERS_LOCKED`, and the database refuses a statement that bypasses the command). A request starts at the first tier of the chain (422
 * `CHANGE_STAGE_NOT_ALLOWED` at any other), is promoted from tier to tier (the earlier request becomes PROMOTED and a new one is raised under it) and, at a PCO or a CO, is evaluated for
 * its cost, its schedule, its scope and its funding; an increase has to fit the line of capital it is paid from. The decision of a CO and the revision it makes of the contract are
 * another story.
 */
export class CtrChangeChainStore {
  private readonly contracts: CtrContractStore;

  constructor(source: CtrContractSource = new CtrContractSource()) {
    this.contracts = new CtrContractStore(source);
  }

  // ---- the configuration ------------------------------------------------------------------------------------------------

  /** Sets the number of tiers of a project, as often as it likes until its first request is raised. */
  async setTiers(tx: TenantTx, projectId: string, tierCount: unknown, actor: string, scope: ScopeBuilder): Promise<SetTiersResult> {
    const count = tierCountOf(tierCount);
    if (count === undefined) throw invalid('tier_count');
    const predicate = scope(2);
    const project = await tx.query<{ id: string }>(`select p.id from ${PROJECT_SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql} for update of p`, [projectId, ...predicate.params]);
    if (project[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const existing = (await tx.query<ConfigSql>(`${CONFIG_SELECT} where g.project_id = $1::uuid for update of g`, [projectId]))[0];
    if (existing?.locked_at !== undefined && existing.locked_at !== null) {
      throw new DomainError('CHANGE_TIERS_LOCKED', 409, 'tier_count', { extensions: { tier_count: existing.tier_count, locked_at: existing.locked_at, locked_by_change_id: existing.locked_by_change_id } });
    }
    if (existing === undefined) {
      const id = randomUUID();
      await tx.query(
        `insert into machvon.change_chain_config (tenant_id, id, project_id, tier_count, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::uuid, $4::uuid, 1)`,
        [id, projectId, count, actor],
      );
      return { id, projectId, tierCount: count, previousTierCount: null, version: 1 };
    }
    await tx.query('update machvon.change_chain_config set tier_count = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [existing.id, count, actor]);
    return { id: existing.id, projectId, tierCount: count, previousTierCount: existing.tier_count as TierCount, version: Number(existing.version) + 1 };
  }

  async config(tx: TenantTx, projectId: string, scope: ScopeBuilder): Promise<TierConfig | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<ConfigSql>(
      `${CONFIG_SELECT}
         join machvon.project p on p.tenant_id = g.tenant_id and p.id = g.project_id
         join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
        where g.project_id = $1::uuid and ${predicate.sql}`,
      [projectId, ...predicate.params],
    );
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          id: row.id,
          projectId: row.project_id,
          tierCount: row.tier_count as TierCount,
          lockedAt: row.locked_at,
          lockedByChangeId: row.locked_by_change_id,
          lockedByCode: row.locked_by_code,
          setBy: row.created_by,
          version: Number(row.version),
        };
  }

  // ---- the requests -----------------------------------------------------------------------------------------------------

  /**
   * Raises the first request of a chain on a contract that is being performed. Refusals in order: the shape (422), the contract (404 outside the scope, 403 where the caller may read it
   * and not change it, 409 `CONTRACT_STATE_INVALID` unless it is ACTIVE or SUSPENDED), the configuration (422 `CHANGE_STAGE_NOT_ALLOWED` when the project has none, or the tier is
   * not the first one of its chain) and the baseline (422: a revision of this contract that is in force). The first request of a project locks its tiers.
   */
  async create(tx: TenantTx, contractId: string, input: NewChangeInput, actor: string, scopes: ContractScopes): Promise<ChangeResult> {
    const stage = CHANGE_STAGES.find((candidate) => candidate === input.stage);
    if (stage === undefined) throw invalid('stage');
    const reason = textOf(input.reason, 'reason', MAX_TEXT);
    const eventKind = input.eventKind === undefined ? null : (CHANGE_EVENT_KINDS.find((candidate) => candidate === input.eventKind) ?? null);
    if (input.eventKind !== undefined && eventKind === null) throw invalid('event_kind');
    const estimated = input.estimatedDeltaVnd === undefined ? null : signedVnd(input.estimatedDeltaVnd, 'estimated_delta_vnd');
    const days = scheduleDays(input.scheduleImpactDays ?? 0, 'schedule_impact_days');
    if (!UUID.test(input.baselineRevisionId)) throw invalid('baseline_revision_id');
    const baseline = input.baselineRevisionId.toLowerCase();

    const contract = await this.contracts.lock(tx, contractId, scopes);
    if (!CHANGEABLE_CONTRACT_STATUSES.includes(contract.status)) throw contractStateInvalid(contract.status);
    const config = await this.configOf(tx, contract.projectId);
    if (config === undefined) throw stageNotAllowed({ reason: 'TIERS_NOT_CONFIGURED' });
    const start = startStageOf(config.tier_count as TierCount);
    if (stage !== start) throw stageNotAllowed({ allowed_stage: start, tier_count: config.tier_count });
    await this.assertBaseline(tx, contractId, baseline);

    const created = await this.insert(tx, contract, { stage, parentId: null, eventKind, reason, baseline, estimated, evaluated: null, days, actor });
    const locked = config.locked_at === null;
    if (locked) {
      await tx.query('update machvon.change_chain_config set locked_at = now(), locked_by_change_id = $2::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid', [config.id, created.id, actor]);
    }
    return this.result(created, contract, { from: null, tierCount: config.tier_count as TierCount, lockedTiers: locked });
  }

  /**
   * Promotes a request to the next tier of the chain of its project (CTR 3.3 step 3): the request becomes PROMOTED, with the reason, and a new one is raised at the next tier under it
   * for the same contract, baseline and kind of event. A CO has no next tier (422 `CHANGE_STAGE_NOT_ALLOWED`), a request that is over cannot be promoted (409 `CHANGE_STATE_INVALID`)
   * and neither can one of a contract that is no longer being performed (409 `CONTRACT_STATE_INVALID`).
   */
  async promote(tx: TenantTx, id: string, expectedVersion: number, reasonText: string, actor: string, scopes: ContractScopes): Promise<ChangeResult> {
    const reason = textOf(reasonText, 'reason', MAX_TEXT);
    const held = await this.hold(tx, id, expectedVersion, scopes);
    if (!OPEN_CHANGE_STATUSES.includes(held.row.status)) throw stateInvalid(held.row.status);
    if (!CHANGEABLE_CONTRACT_STATUSES.includes(held.contract.status)) throw contractStateInvalid(held.contract.status);
    const config = await this.configOf(tx, held.contract.projectId);
    const next = config === undefined ? undefined : nextStageOf(held.row.stage, config.tier_count as TierCount);
    if (config === undefined || next === undefined) throw stageNotAllowed({ stage: held.row.stage, tier_count: config?.tier_count ?? null, reason: 'LAST_TIER' });
    await tx.query("update machvon.change_request set status = 'PROMOTED', status_reason = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid", [id, reason, actor]);
    const child = await this.insert(tx, held.contract, {
      stage: next,
      parentId: id,
      eventKind: held.row.event_kind,
      reason: held.row.reason,
      baseline: held.row.baseline_revision_id,
      estimated: held.row.estimated_delta_vnd,
      evaluated: null,
      days: held.row.schedule_impact_days,
      actor,
      startingAmount: held.row.evaluated_delta_vnd ?? held.row.estimated_delta_vnd ?? '0',
    });
    return this.result(child, held.contract, { from: held.row.status, tierCount: config.tier_count as TierCount, lockedTiers: false });
  }

  /**
   * Evaluates a PCO or a CO (CTR 3.3 step 3): the cost, the schedule, the scope and the funding are recorded and the request is EVALUATED (again, if it already was). An increase has to
   * fit the line of capital it is paid from: the line is named and CAP is asked (422 `ALLOCATION_UNAVAILABLE`); a decrease or no change asks nothing, and names a line only if it likes.
   */
  async evaluate(tx: TenantTx, id: string, expectedVersion: number, input: EvaluateInput, actor: string, scopes: ContractScopes, hooks: ChangeHooks): Promise<ChangeResult> {
    const delta = signedVnd(input.evaluatedDeltaVnd, 'evaluated_delta_vnd');
    const days = scheduleDays(input.scheduleImpactDays, 'schedule_impact_days');
    const funding = textOf(input.fundingImpactNote, 'funding_impact_note', MAX_TEXT);
    const scopeNote = input.scopeImpactNote === undefined ? null : textOf(input.scopeImpactNote, 'scope_impact_note', MAX_TEXT);
    if (input.allocationLineId !== undefined && !UUID.test(input.allocationLineId)) throw invalid('allocation_line_id');
    const line = input.allocationLineId?.toLowerCase() ?? null;

    const held = await this.hold(tx, id, expectedVersion, scopes);
    if (!OPEN_CHANGE_STATUSES.includes(held.row.status)) throw stateInvalid(held.row.status);
    if (!EVALUATED_STAGES.includes(held.row.stage)) throw stageNotAllowed({ stage: held.row.stage, reason: 'STAGE_NOT_EVALUATED' });
    if (!CHANGEABLE_CONTRACT_STATUSES.includes(held.contract.status)) throw contractStateInvalid(held.contract.status);
    const increase = compareDecimal(delta, '0') > 0;
    if (increase && line === null) throw new DomainError('ALLOCATION_UNAVAILABLE', 422, 'allocation_line_id', { extensions: { reason: 'ALLOCATION_LINE_REQUIRED' } });
    if (line !== null) await hooks.available(line, increase ? delta : '0');
    const config = await this.configOf(tx, held.contract.projectId);
    await tx.query(
      `update machvon.change_request
          set status = 'EVALUATED', evaluated_delta_vnd = $2::numeric, amount_delta_vnd = $2::numeric, schedule_impact_days = $3, funding_impact_note = $4, scope_impact_note = $5,
              evaluation_allocation_line_id = $6::uuid, evaluated_by = $7::uuid, evaluated_at = now(), updated_at = now(), updated_by = $7::uuid, version = version + 1
        where id = $1::uuid`,
      [id, delta, days, funding, scopeNote, line, actor],
    );
    const row: LineSql = { ...held.row, status: 'EVALUATED', evaluated_delta_vnd: delta, schedule_impact_days: days, evaluation_allocation_line_id: line, version: String(Number(held.row.version) + 1) };
    return this.result(row, held.contract, { from: held.row.status, tierCount: (config?.tier_count ?? 1) as TierCount, lockedTiers: false });
  }

  /** Withdraws a request that is still open, with the reason; the requests above it in the chain are not touched. */
  async withdraw(tx: TenantTx, id: string, expectedVersion: number, reasonText: string, actor: string, scopes: ContractScopes): Promise<ChangeResult> {
    const reason = textOf(reasonText, 'reason', MAX_TEXT);
    const held = await this.hold(tx, id, expectedVersion, scopes);
    if (held.row.status !== 'DRAFT' && !OPEN_CHANGE_STATUSES.includes(held.row.status)) throw stateInvalid(held.row.status);
    const config = await this.configOf(tx, held.contract.projectId);
    await tx.query("update machvon.change_request set status = 'WITHDRAWN', status_reason = $2, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid", [id, reason, actor]);
    const row: LineSql = { ...held.row, status: 'WITHDRAWN', status_reason: reason, version: String(Number(held.row.version) + 1) };
    return this.result(row, held.contract, { from: held.row.status, tierCount: (config?.tier_count ?? 1) as TierCount, lockedTiers: false });
  }

  // ---- the reads ----------------------------------------------------------------------------------------------------------

  /** The requests of the contracts in the scope of the caller, the oldest first (a chain reads from its first tier on); one project or one contract when named. `after` is the creation time and the id of the last one read. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: { projectId?: string | undefined; contractId?: string | undefined; limit?: number | undefined; after?: { code: string; id: string } | undefined }): Promise<ChangeLine[]> {
    const predicate = scope(5);
    const rows = await tx.query<ReachSql>(
      `select ${COLUMNS}, ${REACH_COLUMNS} from ${FROM}
        where ${predicate.sql} and ($1::uuid is null or c.project_id = $1::uuid) and ($2::uuid is null or r.contract_id = $2::uuid)
          and ($3::text is null or (${TIMESTAMP('r.created_at')}, r.id) > ($3::text, $4::uuid))
        order by ${TIMESTAMP('r.created_at')}, r.id limit ${Math.min(Math.max(filter.limit ?? 200, 1), 1000)}`,
      [filter.projectId ?? null, filter.contractId ?? null, filter.after?.code ?? null, filter.after?.id ?? null, ...predicate.params],
    );
    return rows.map(toLine);
  }

  /** Whether the caller reaches any contract of the project: a guest contractor reads the chain of its own contract without reaching the project itself. */
  async contractVisible(tx: TenantTx, projectId: string, scope: ScopeBuilder): Promise<boolean> {
    const predicate = scope(2);
    const rows = await tx.query<{ id: string }>(`select c.id from ${CONTRACT_SCOPE_FROM} where c.project_id = $1::uuid and ${predicate.sql} limit 1`, [projectId, ...predicate.params]);
    return rows.length > 0;
  }

  async find(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<ChangeLine | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<ReachSql>(`select ${COLUMNS}, ${REACH_COLUMNS} from ${FROM} where r.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    return rows[0] === undefined ? undefined : toLine(rows[0]);
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  private async configOf(tx: TenantTx, projectId: string): Promise<ConfigSql | undefined> {
    return (await tx.query<ConfigSql>(`${CONFIG_SELECT} where g.project_id = $1::uuid for update of g`, [projectId]))[0];
  }

  private async assertBaseline(tx: TenantTx, contractId: string, revisionId: string): Promise<void> {
    const rows = await tx.query<{ status: string }>('select status from machvon.contract_revision where id = $1::uuid and contract_id = $2::uuid', [revisionId, contractId]);
    if (rows[0] === undefined || rows[0].status !== 'EFFECTIVE') throw invalid('baseline_revision_id');
  }

  /** The request held for update inside the scope of the command, with its contract held first and judged by the scope; a request the caller cannot see does not exist. */
  private async hold(tx: TenantTx, id: string, expectedVersion: number, scopes: ContractScopes): Promise<{ row: LineSql; contract: LockedContract }> {
    const peek = await tx.query<{ contract_id: string }>('select contract_id from machvon.change_request where id = $1::uuid', [id]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const contract = await this.contracts.lock(tx, peek[0].contract_id, scopes);
    const rows = await tx.query<LineSql>(`select ${COLUMNS} from ${FROM} where r.id = $1::uuid for update of r`, [id]);
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return { row, contract };
  }

  private async insert(
    tx: TenantTx,
    contract: LockedContract,
    values: {
      stage: ChangeStage;
      parentId: string | null;
      eventKind: ChangeEventKind | null;
      reason: string;
      baseline: string;
      estimated: string | null;
      evaluated: string | null;
      days: number;
      actor: string;
      startingAmount?: string;
    },
  ): Promise<LineSql> {
    const taken = await tx.query<{ n: string }>('select count(*)::text as n from machvon.change_request where contract_id = $1::uuid and stage = $2', [contract.id, values.stage]);
    const code = changeCode(values.stage, Number(taken[0]?.n ?? '0') + 1);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.change_request
         (tenant_id, id, contract_id, baseline_revision_id, amount_delta_vnd, schedule_impact_days, reason, status, version, code, stage, parent_id, event_kind, estimated_delta_vnd, submitted_by, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::numeric, $5, $6, 'SUBMITTED', 1, $7, $8, $9::uuid, $10, $11::numeric, $12::uuid, $12::uuid, $12::uuid)`,
      [id, contract.id, values.baseline, values.startingAmount ?? values.estimated ?? '0', values.days, values.reason, code, values.stage, values.parentId, values.eventKind, values.estimated, values.actor],
    );
    const rows = await tx.query<LineSql>(`select ${COLUMNS} from ${FROM} where r.id = $1::uuid`, [id]);
    return rows[0] as LineSql;
  }

  private result(row: LineSql, contract: LockedContract, extra: { from: ChangeStatus | null; tierCount: TierCount; lockedTiers: boolean }): ChangeResult {
    return {
      id: row.id,
      code: row.code ?? '',
      stage: row.stage,
      status: row.status,
      fromStatus: extra.from,
      version: Number(row.version),
      contractId: row.contract_id,
      contractCode: row.contract_code,
      projectId: contract.projectId,
      parentId: row.parent_id,
      eventKind: row.event_kind,
      estimatedDeltaVnd: row.estimated_delta_vnd,
      evaluatedDeltaVnd: row.evaluated_delta_vnd,
      scheduleImpactDays: row.schedule_impact_days,
      allocationLineId: row.evaluation_allocation_line_id,
      tierCount: extra.tierCount,
      lockedTiers: extra.lockedTiers,
      reason: row.reason,
      reach: { projectId: contract.projectId },
    };
  }
}

const CONFIG_SELECT = `select g.id, g.project_id, g.tier_count, ${TIMESTAMP('g.locked_at')} as locked_at, g.locked_by_change_id,
  (select r.code from machvon.change_request r where r.id = g.locked_by_change_id) as locked_by_code, g.created_by, g.version::text as version
  from machvon.change_chain_config g`;
