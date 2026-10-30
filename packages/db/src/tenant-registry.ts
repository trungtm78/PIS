import { DomainError, isReserved, reservedUntil } from '@machvon/kernel';
import type { ControlDatabase } from './control-database.ts';
import type { TenantTx } from './tenant-database.ts';

export const TENANT_STATUSES = ['Requested', 'Provisioning', 'Active', 'Failed', 'Suspended', 'Offboarding', 'Archived'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

/** The tenant lifecycle of SAS section 4: every pair not listed here is refused with 409 TENANT_STATE_INVALID. */
const TRANSITIONS: ReadonlyArray<readonly [TenantStatus, TenantStatus]> = [
  ['Requested', 'Provisioning'],
  ['Provisioning', 'Active'],
  ['Provisioning', 'Failed'],
  ['Failed', 'Provisioning'],
  ['Failed', 'Archived'],
  ['Active', 'Suspended'],
  ['Suspended', 'Active'],
  ['Active', 'Offboarding'],
  ['Suspended', 'Offboarding'],
  ['Offboarding', 'Archived'],
  ['Offboarding', 'Active'],
];

export function isTenantTransition(from: TenantStatus, to: TenantStatus): boolean {
  return TRANSITIONS.some(([source, target]) => source === from && target === to);
}

export function assertTenantTransition(from: TenantStatus, to: TenantStatus): void {
  if (!isTenantTransition(from, to)) throw new DomainError('TENANT_STATE_INVALID', 409, `${from}->${to}`);
}

/** The eleven provisioning steps of SAS section 3.1, in order. */
export const PROVISIONING_STEPS = [
  'IDP_ORG',
  'DNS_SUBDOMAIN',
  'STORAGE_PREFIX',
  'DB_PLACEMENT',
  'RLS_SEED',
  'ENTITLEMENT_V1',
  'LICENSE_PILOT',
  'ROLE_SEED',
  'ROOT_UNIT',
  'THEME_V1',
  'OWNER_INVITE',
] as const;
export type ProvisioningStep = (typeof PROVISIONING_STEPS)[number];

/** The infrastructure steps (1 to 5) that this saga runs; steps 6 to 11 belong to ST-SAS-006. */
export const INFRASTRUCTURE_STEPS: readonly ProvisioningStep[] = PROVISIONING_STEPS.slice(0, 5);

export type StepStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'COMPENSATED';

export interface StepState {
  status: StepStatus;
  attempts: number;
  error_code?: string | null;
  started_at?: string;
  finished_at?: string;
}

export type StepStates = Record<ProvisioningStep, StepState>;

/** What the request carried that later steps need; kept beside the steps in `steps_json._request`. */
export interface RequestMeta {
  plan_version_id: string;
  platform_subdomain: string;
  root_unit_name: string;
  initial_owner_email: string;
  procurement_contract_ref?: string;
}

export interface TenantRequestInput {
  code: string;
  name: string;
  governingBodyType: string;
  administrativeCode?: string;
  region: string;
  isolationMode: 'POOL' | 'SILO';
  planVersionId: string;
  rootUnitName: string;
  initialOwnerEmail: string;
  platformSubdomain: string;
  procurementContractRef?: string;
  requestedBy: string;
}

export interface TenantRow {
  id: string;
  code: string;
  name: string;
  status: TenantStatus;
  placementId: string;
  region: string;
  governingBodyType: string;
  isolationMode: string;
  version: number;
}

export interface RunRow {
  id: string;
  tenantId: string;
  attempt: number;
  status: string;
  currentStep: string;
  steps: StepStates;
  request: RequestMeta;
  errorCode: string | undefined;
  requestedBy: string;
  version: number;
}

export interface TenantRequested {
  tenantId: string;
  runId: string;
  placementId: string;
  version: number;
}

export interface TenantPage {
  items: Array<{ id: string; code: string; name: string; status: TenantStatus; isolation_mode: string }>;
  /** The (code, id) of the last item when another page follows. */
  next: { code: string; id: string } | null;
}

export const PLATFORM_DOMAIN = 'machvon.vn';

/** Raised by the isolation probe when row-level security does not confine the tenant. */
export class IsolationProbeError extends Error {
  readonly code = 'RLS_PROBE_FAILED';

  constructor(reason: string) {
    super(`RLS_PROBE_FAILED: ${reason}`);
    this.name = 'IsolationProbeError';
  }
}

interface TenantDbRow {
  id: string;
  code: string;
  name: string;
  status: TenantStatus;
  placement_id: string;
  region: string;
  governing_body_type: string;
  isolation_mode: string;
  version: string;
}

interface RunDbRow {
  id: string;
  tenant_id: string;
  attempt: number;
  status: string;
  current_step: string;
  steps_json: Record<string, unknown>;
  error_code: string | null;
  requested_by: string;
  version: string;
}

const TENANT_COLUMNS = 'id, code, name, status, placement_id, region, governing_body_type, isolation_mode, version::text as version';
const RUN_COLUMNS = 'id, tenant_id, attempt, status, current_step, steps_json, error_code, requested_by, version::text as version';

function toTenant(row: TenantDbRow): TenantRow {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    placementId: row.placement_id,
    region: row.region,
    governingBodyType: row.governing_body_type,
    isolationMode: row.isolation_mode,
    version: Number(row.version),
  };
}

function pendingSteps(): StepStates {
  return Object.fromEntries(PROVISIONING_STEPS.map((step) => [step, { status: 'PENDING', attempts: 0 }])) as StepStates;
}

function toRun(row: RunDbRow): RunRow {
  const steps = pendingSteps();
  for (const step of PROVISIONING_STEPS) {
    const stored = row.steps_json[step];
    if (typeof stored === 'object' && stored !== null) steps[step] = stored as StepState;
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    attempt: row.attempt,
    status: row.status,
    currentStep: row.current_step,
    steps,
    request: row.steps_json._request as RequestMeta,
    errorCode: row.error_code ?? undefined,
    requestedBy: row.requested_by,
    version: Number(row.version),
  };
}

function workflowIdOf(tenantId: string, attempt: number): string {
  return `prov:${tenantId}:${attempt}`;
}

async function actAs(tx: TenantTx, tenantId: string): Promise<void> {
  await tx.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
}

// One lock for every request that picks a placement: the count of tenants on a placement is only true once the earlier
// request has committed its tenant row, so two requests must not choose at the same time (max_tenants would be exceeded).
const PLACEMENT_LOCK_SQL = "select pg_advisory_xact_lock(hashtextextended('tenant-placement', 0))";

const PLACEMENT_SQL = `select p.id from machvon.placement p
  where p.status = 'Active' and p.region = $1 and p.kind = $2
    and (p.max_tenants is null or (select count(*) from machvon.tenant t where t.placement_id = p.id and t.status <> 'Archived') < p.max_tenants)
  order by (select count(*) from machvon.tenant t where t.placement_id = p.id and t.status <> 'Archived'), p.id
  limit 1`;

/**
 * The tenant registry of the control plane (ST-SAS-001): the tenant row, its provisioning runs and the lifecycle
 * that guards them. Commands pass the transaction of the command pipeline; the saga uses the control database
 * directly, one short transaction per state change, so every step is durable before and after its port call.
 */
export class TenantRegistry {
  private readonly control: ControlDatabase;
  private readonly now: () => Date;
  private readonly platformDomain: string;

  constructor(control: ControlDatabase, options: { now?: () => Date; platformDomain?: string } = {}) {
    this.control = control;
    this.now = options.now ?? (() => new Date());
    this.platformDomain = options.platformDomain ?? PLATFORM_DOMAIN;
  }

  hostnameOf(subdomain: string): string {
    return `${subdomain}.${this.platformDomain}`;
  }

  /**
   * Writes the tenant (status Requested) and attempt 1 of its provisioning run inside the caller's control
   * transaction. `whileActingAsTenant` runs with the tenant named in the transaction (audit and outbox rows of
   * the tenant); afterwards the transaction is returned to `restoreTenantId`, the platform tenant of the command.
   */
  async requestTenant(
    tx: TenantTx,
    input: TenantRequestInput,
    restoreTenantId: string,
    whileActingAsTenant: (created: TenantRequested) => Promise<void>,
  ): Promise<TenantRequested> {
    const taken = await tx.query('select 1 from machvon.tenant where lower(code) = lower($1)', [input.code]);
    if (taken.length > 0) throw new DomainError('TENANT_CODE_TAKEN', 409);

    const plan = await tx.query<{ status: string }>('select status from machvon.product_plan_version where id = $1::uuid', [input.planVersionId]);
    if (plan[0]?.status !== 'Published') throw new DomainError('PLAN_NOT_PUBLISHED', 409);

    await tx.query(PLACEMENT_LOCK_SQL);
    const placements = await tx.query<{ id: string }>(PLACEMENT_SQL, [input.region, input.isolationMode]);
    const placementId = placements[0]?.id;
    if (placementId === undefined) throw new DomainError('PLACEMENT_UNAVAILABLE', 422);

    let tenant: { id: string; version: string };
    try {
      const inserted = await tx.query<{ id: string; version: string }>(
        `insert into machvon.tenant (id, code, name, status, placement_id, region, governing_body_type, administrative_code, isolation_mode, requested_at)
         values (gen_random_uuid(), $1, $2, 'Requested', $3::uuid, $4, $5, $6, $7, $8::timestamptz)
         returning id, version::text as version`,
        [input.code, input.name, placementId, input.region, input.governingBodyType, input.administrativeCode ?? null, input.isolationMode, this.now().toISOString()],
      );
      const row = inserted[0];
      if (row === undefined) throw new Error('tenant insert returned no row');
      tenant = row;
    } catch (error) {
      // A concurrent request for the same code lost the race on the unique index.
      if ((error as { code?: string }).code === '23505') throw new DomainError('TENANT_CODE_TAKEN', 409);
      throw error;
    }

    const request: RequestMeta = {
      plan_version_id: input.planVersionId,
      platform_subdomain: input.platformSubdomain,
      root_unit_name: input.rootUnitName,
      initial_owner_email: input.initialOwnerEmail,
      ...(input.procurementContractRef === undefined ? {} : { procurement_contract_ref: input.procurementContractRef }),
    };
    await actAs(tx, tenant.id);
    const run = await this.insertRun(tx, tenant.id, 1, pendingSteps(), request, input.requestedBy);
    const created: TenantRequested = { tenantId: tenant.id, runId: run, placementId, version: Number(tenant.version) };
    await whileActingAsTenant(created);
    await actAs(tx, restoreTenantId);
    return created;
  }

  /**
   * Opens attempt n+1 of a Failed tenant inside the caller's control transaction: steps already DONE stay
   * DONE, the failed one starts again, and the tenant returns to Provisioning. `If-Match` is the tenant version.
   */
  async startRetryRun(
    tx: TenantTx,
    tenantId: string,
    expectedVersion: number,
    requestedBy: string,
    restoreTenantId: string,
    whileActingAsTenant: (created: { runId: string; attempt: number; version: number }) => Promise<void>,
  ): Promise<{ runId: string; attempt: number; version: number }> {
    const tenants = await tx.query<TenantDbRow>(`select ${TENANT_COLUMNS} from machvon.tenant where id = $1::uuid for update`, [tenantId]);
    const tenant = tenants[0];
    if (tenant === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(tenant.version) !== expectedVersion) {
      throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: Number(tenant.version) } });
    }
    assertTenantTransition(tenant.status, 'Provisioning');
    if (tenant.status !== 'Failed') throw new DomainError('TENANT_STATE_INVALID', 409, `${tenant.status}->Provisioning`);

    await actAs(tx, tenantId);
    const previous = await tx.query<RunDbRow>(`select ${RUN_COLUMNS} from machvon.tenant_provisioning_run where tenant_id = $1::uuid order by attempt desc limit 1`, [tenantId]);
    const last = previous[0];
    if (last === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const lastRun = toRun(last);
    const steps = pendingSteps();
    for (const step of PROVISIONING_STEPS) {
      const before = lastRun.steps[step];
      steps[step] = before.status === 'DONE' ? before : { status: 'PENDING', attempts: 0 };
    }
    const attempt = lastRun.attempt + 1;
    const runId = await this.insertRun(tx, tenantId, attempt, steps, lastRun.request, requestedBy);
    const moved = await tx.query<{ version: string }>(
      "update machvon.tenant set status = 'Provisioning', version = version + 1 where id = $1::uuid and status = 'Failed' returning version::text as version",
      [tenantId],
    );
    const version = Number(moved[0]?.version);
    const created = { runId, attempt, version };
    await whileActingAsTenant(created);
    await actAs(tx, restoreTenantId);
    return created;
  }

  private async insertRun(tx: TenantTx, tenantId: string, attempt: number, steps: StepStates, request: RequestMeta, requestedBy: string): Promise<string> {
    const firstPending = PROVISIONING_STEPS.find((step) => steps[step].status !== 'DONE') ?? PROVISIONING_STEPS[0];
    const rows = await tx.query<{ id: string }>(
      `insert into machvon.tenant_provisioning_run (tenant_id, id, attempt, temporal_workflow_id, status, current_step, steps_json, requested_by)
       values ($1::uuid, gen_random_uuid(), $2, $3, 'Running', $4, $5::jsonb, $6::uuid) returning id`,
      [tenantId, attempt, workflowIdOf(tenantId, attempt), firstPending, JSON.stringify({ ...steps, _request: request }), requestedBy],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('provisioning run insert returned no row');
    return row.id;
  }

  async getTenant(tenantId: string): Promise<TenantRow | undefined> {
    const rows = await this.control.withControl((tx) => tx.query<TenantDbRow>(`select ${TENANT_COLUMNS} from machvon.tenant where id = $1::uuid`, [tenantId]));
    return rows[0] === undefined ? undefined : toTenant(rows[0]);
  }

  /** The tenant and its newest provisioning run, for the System Admin screens. */
  async getDetail(tenantId: string): Promise<{ tenant: TenantRow; run: RunRow | undefined } | undefined> {
    const tenant = await this.getTenant(tenantId);
    if (tenant === undefined) return undefined;
    const runs = await this.control.withTenantOf(tenantId, (tx) =>
      tx.query<RunDbRow>(`select ${RUN_COLUMNS} from machvon.tenant_provisioning_run where tenant_id = $1::uuid order by attempt desc limit 1`, [tenantId]),
    );
    return { tenant, run: runs[0] === undefined ? undefined : toRun(runs[0]) };
  }

  /** Keyset page ordered by (code, id): the next anchor is the last code and id. */
  async listTenants(limit: number, after?: { code: string; id: string }): Promise<TenantPage> {
    const rows = await this.control.withControl((tx) =>
      tx.query<TenantDbRow>(
        `select ${TENANT_COLUMNS} from machvon.tenant
         where ($1::text is null or (code, id) > ($1::text, $2::uuid))
         order by code, id limit $3`,
        [after?.code ?? null, after?.id ?? null, limit + 1],
      ),
    );
    const page = rows.slice(0, limit).map(toTenant);
    const last = page[page.length - 1];
    return {
      items: page.map((tenant) => ({ id: tenant.id, code: tenant.code, name: tenant.name, status: tenant.status, isolation_mode: tenant.isolationMode })),
      next: rows.length > limit && last !== undefined ? { code: last.code, id: last.id } : null,
    };
  }

  async loadRun(tenantId: string, attempt: number): Promise<RunRow | undefined> {
    const rows = await this.control.withTenantOf(tenantId, (tx) =>
      tx.query<RunDbRow>(`select ${RUN_COLUMNS} from machvon.tenant_provisioning_run where tenant_id = $1::uuid and attempt = $2`, [tenantId, attempt]),
    );
    return rows[0] === undefined ? undefined : toRun(rows[0]);
  }

  /** Runs that were started and not finished (their tenant is Requested or Provisioning): what a restarted runner resumes. */
  async unfinishedRuns(): Promise<RunRow[]> {
    const tenants = await this.control.withControl((tx) =>
      tx.query<{ id: string }>("select id from machvon.tenant where status in ('Requested', 'Provisioning') order by requested_at, id"),
    );
    const runs: RunRow[] = [];
    for (const tenant of tenants) {
      const found = await this.control.withTenantOf(tenant.id, (tx) =>
        tx.query<RunDbRow>(`select ${RUN_COLUMNS} from machvon.tenant_provisioning_run where tenant_id = $1::uuid and status = 'Running' order by attempt desc limit 1`, [tenant.id]),
      );
      if (found[0] !== undefined) runs.push(toRun(found[0]));
    }
    return runs;
  }

  /**
   * Moves the tenant along the lifecycle. The row is updated only from the stated state, so two racing moves
   * cannot both win; repeating a move that already happened is a no-op (the saga is restarted without fear).
   */
  async transition(tenantId: string, from: TenantStatus, to: TenantStatus): Promise<void> {
    assertTenantTransition(from, to);
    await this.control.withControl(async (tx) => {
      const moved = await tx.query(
        `update machvon.tenant set status = $3, version = version + 1,
           activated_at = case when $3 = 'Active' then $4::timestamptz else activated_at end
         where id = $1::uuid and status = $2 returning id`,
        [tenantId, from, to, this.now().toISOString()],
      );
      if (moved.length > 0) return;
      const current = await tx.query<{ status: TenantStatus }>('select status from machvon.tenant where id = $1::uuid', [tenantId]);
      if (current[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      if (current[0].status !== to) throw new DomainError('TENANT_STATE_INVALID', 409, `${current[0].status}->${to}`);
    });
  }

  /** Records the state of one step of a run (merged into steps_json) and optionally the current step. */
  async updateStep(tenantId: string, runId: string, step: ProvisioningStep, patch: Partial<StepState>, currentStep?: ProvisioningStep): Promise<void> {
    await this.control.withTenantOf(tenantId, (tx) =>
      tx.query(
        `update machvon.tenant_provisioning_run
           set steps_json = jsonb_set(steps_json, array[$3::text], coalesce(steps_json -> $3::text, '{}'::jsonb) || $4::jsonb),
               current_step = coalesce($5, current_step), version = version + 1
         where tenant_id = $1::uuid and id = $2::uuid`,
        [tenantId, runId, step, JSON.stringify(patch), currentStep ?? null],
      ),
    );
  }

  async finishRun(tenantId: string, runId: string, status: 'Succeeded' | 'Failed' | 'Abandoned', errorCode?: string, currentStep?: ProvisioningStep): Promise<void> {
    await this.control.withTenantOf(tenantId, (tx) =>
      tx.query(
        `update machvon.tenant_provisioning_run
           set status = $3, error_code = $4, current_step = coalesce($5, current_step), finished_at = $6::timestamptz, version = version + 1
         where tenant_id = $1::uuid and id = $2::uuid`,
        [tenantId, runId, status, errorCode ?? null, currentStep ?? null, this.now().toISOString()],
      ),
    );
  }

  /**
   * Ends a run as Failed and moves the tenant from Provisioning to Failed in ONE transaction, so a crash can never leave
   * a Failed run with a tenant that is still Provisioning (such a tenant could be neither resumed nor retried).
   */
  async failRun(tenantId: string, runId: string, errorCode: string, currentStep: ProvisioningStep): Promise<void> {
    assertTenantTransition('Provisioning', 'Failed');
    await this.control.withTenantOf(tenantId, async (tx) => {
      const moved = await tx.query(
        "update machvon.tenant set status = 'Failed', version = version + 1 where id = $1::uuid and status = 'Provisioning' returning id",
        [tenantId],
      );
      if (moved.length === 0) {
        const current = await tx.query<{ status: TenantStatus }>('select status from machvon.tenant where id = $1::uuid', [tenantId]);
        if (current[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
        // Failing twice is a no-op (the saga is restarted without fear); any other state cannot fail.
        if (current[0].status !== 'Failed') throw new DomainError('TENANT_STATE_INVALID', 409, `${current[0].status}->Failed`);
      }
      await tx.query(
        `update machvon.tenant_provisioning_run
           set status = 'Failed', error_code = $3, current_step = $4, finished_at = $5::timestamptz, version = version + 1
         where tenant_id = $1::uuid and id = $2::uuid`,
        [tenantId, runId, errorCode, currentStep, this.now().toISOString()],
      );
    });
  }

  /**
   * Ends a run as Succeeded and moves the tenant from Provisioning to Active in ONE transaction (SAS 3.1 step 4): the tenant
   * is Active only after the last step. `whileActing` runs in that transaction, acting as the tenant, when the move happened
   * now (audit row and events); finishing twice is a no-op.
   */
  async completeRun(tenantId: string, runId: string, whileActing?: (tx: TenantTx) => Promise<void>): Promise<void> {
    assertTenantTransition('Provisioning', 'Active');
    await this.control.withTenantOf(tenantId, async (tx) => {
      const moved = await tx.query(
        "update machvon.tenant set status = 'Active', version = version + 1, activated_at = $2::timestamptz where id = $1::uuid and status = 'Provisioning' returning id",
        [tenantId, this.now().toISOString()],
      );
      if (moved.length === 0) {
        const current = await tx.query<{ status: TenantStatus }>('select status from machvon.tenant where id = $1::uuid', [tenantId]);
        if (current[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
        if (current[0].status !== 'Active') throw new DomainError('TENANT_STATE_INVALID', 409, `${current[0].status}->Active`);
      }
      const finished = await tx.query(
        "update machvon.tenant_provisioning_run set status = 'Succeeded', error_code = null, finished_at = $3::timestamptz, version = version + 1 where tenant_id = $1::uuid and id = $2::uuid and status = 'Running' returning id",
        [tenantId, runId, this.now().toISOString()],
      );
      if (finished.length === 0) {
        // Only the running attempt may activate the tenant; the move above is rolled back by the throw. Repeating the completion
        // of a run that already succeeded (the tenant was Active before this call) stays a no-op.
        const run = await tx.query<{ status: string }>('select status from machvon.tenant_provisioning_run where tenant_id = $1::uuid and id = $2::uuid', [tenantId, runId]);
        if (run[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
        if (run[0].status !== 'Succeeded' || moved.length > 0) throw new DomainError('TENANT_STATE_INVALID', 409, `run ${run[0].status}`);
      }
      if (moved.length > 0 && whileActing !== undefined) await whileActing(tx);
    });
  }

  /** Points the run at the step that comes next without finishing it (steps 6 to 11 belong to a later story). */
  async setCurrentStep(tenantId: string, runId: string, step: ProvisioningStep): Promise<void> {
    await this.control.withTenantOf(tenantId, (tx) =>
      tx.query('update machvon.tenant_provisioning_run set current_step = $3, version = version + 1 where tenant_id = $1::uuid and id = $2::uuid', [tenantId, runId, step]),
    );
  }

  /** Registers the platform subdomain of the tenant; another tenant holding the hostname is 409 DOMAIN_TAKEN. */
  async ensureDomain(tenantId: string, hostname: string): Promise<void> {
    await this.control.withTenantOf(tenantId, async (tx) => {
      // A name that another tenant released less than 90 days ago is held, here as everywhere; the tenant that released it (a provisioning that is run again) may take it back.
      const [holder] = await tx.query<{ tenant_id: string; status: string; revoked_at: Date | null }>('select tenant_id, status, revoked_at from machvon.tenant_domain_holder($1)', [hostname.toLowerCase()]);
      if (holder !== undefined && holder.status === 'Revoked' && holder.tenant_id !== tenantId && holder.revoked_at !== null && isReserved(holder.revoked_at, this.now())) {
        throw new DomainError('DOMAIN_TAKEN', 409, undefined, { extensions: { reason: 'RESERVED', reserved_until: reservedUntil(holder.revoked_at).toISOString() } });
      }
      await tx.query(
        `insert into machvon.tenant_domain (tenant_id, id, hostname, kind, status, tls_status, verified_at)
         values ($1::uuid, gen_random_uuid(), $2, 'PLATFORM_SUBDOMAIN', 'Active', 'Issued', $3::timestamptz)
         on conflict do nothing`,
        [tenantId, hostname, this.now().toISOString()],
      );
      // Row-level security shows only this tenant's rows: nothing here means another tenant holds the hostname.
      const mine = await tx.query("select 1 from machvon.tenant_domain where lower(hostname) = lower($1) and status <> 'Revoked'", [hostname]);
      if (mine.length === 0) throw new DomainError('DOMAIN_TAKEN', 409);
    });
  }

  /**
   * Revokes the hostname of the tenant. The answer says whether the hostname belongs to this tenant (a row of its own
   * exists, also one that an earlier attempt already revoked): only then may the caller remove the DNS record, because
   * row-level security hides the rows of other tenants and a hostname another tenant owns looks like "not found" here.
   */
  async revokeDomain(tenantId: string, hostname: string): Promise<boolean> {
    return this.control.withTenantOf(tenantId, async (tx) => {
      const owned = await tx.query('select 1 from machvon.tenant_domain where lower(hostname) = lower($1)', [hostname]);
      await tx.query("update machvon.tenant_domain set status = 'Revoked', revoked_at = now(), version = version + 1 where lower(hostname) = lower($1) and status <> 'Revoked'", [hostname]);
      return owned.length > 0;
    });
  }

  /**
   * The isolation probe of step RLS_SEED, run for real: inside the tenant's own transaction no row of another
   * tenant is visible, and writing a row for another tenant is refused by row-level security.
   */
  async probeIsolation(tenantId: string): Promise<void> {
    await this.control.withTenantOf(tenantId, async (tx) => {
      const foreign = await tx.query<{ n: string }>('select count(*)::text as n from machvon.tenant_provisioning_run where tenant_id <> $1::uuid', [tenantId]);
      if (Number(foreign[0]?.n) !== 0) throw new IsolationProbeError('rows of another tenant are visible');
      await tx.query('savepoint isolation_probe');
      let refused = false;
      try {
        await tx.query(
          `insert into machvon.tenant_provisioning_run (tenant_id, id, attempt, temporal_workflow_id, status, current_step, steps_json, requested_by)
           values (gen_random_uuid(), gen_random_uuid(), 1, 'probe', 'Running', 'RLS_SEED', '{}'::jsonb, gen_random_uuid())`,
        );
      } catch (error) {
        refused = (error as { code?: string }).code === '42501';
        if (!refused) throw error;
      }
      await tx.query('rollback to savepoint isolation_probe');
      if (!refused) throw new IsolationProbeError('a row for another tenant was accepted');
    });
  }
}
