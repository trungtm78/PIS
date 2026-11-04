import { randomUUID } from 'node:crypto';
import { BUDGET_SCOPE_ORDER, DomainError, assertBudgetDraft, assertPriceDraft, costOf, crossesThreshold, decideReservation, periodStartOf, settlementOf } from '@machvon/kernel';
import type { BudgetPeriod, BudgetScope, CachedSemantics, Price, Usage } from '@machvon/kernel';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

export interface BudgetRow {
  id: string;
  scopeKind: BudgetScope;
  scopeRefId: string | null;
  period: BudgetPeriod;
  limitVnd: string;
  softThresholdPct: number;
  hardStop: boolean;
  maxRequestsPerDay: number | null;
  maxConcurrent: number | null;
  effectiveFrom: string;
  status: string;
  createdBy: string;
  createdAt: string;
  version: number;
}

export interface CounterRow {
  id: string;
  budgetId: string;
  periodStart: string;
  limitVnd: string;
  settledVnd: string;
  reservedOpenVnd: string;
  requestCount: number;
  exceptionCount: number;
  blocked: boolean;
}

export interface BudgetWithCounter extends BudgetRow {
  counter: CounterRow | null;
}

export interface ReservationRow {
  id: string;
  requestId: string;
  scope: Array<{ kind: BudgetScope; ref: string | null; budgetId: string; counterId: string }>;
  reservedAmount: string;
  currency: string;
  status: string;
  expiresAt: string;
  settledAmount: string | null;
  releasedAmount: string | null;
  settledAt: string | null;
  reconcileNote: string | null;
  createdAt: string;
  version: number;
  /** Where the row stands in the list (the time it was made, to the microsecond): the cursor of the page is built from it. */
  pageKey: string;
}

export interface PriceRow {
  id: string;
  provider: string;
  modelId: string;
  modelRefId: string | null;
  currency: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  inputPerMillion: string;
  cachedPerMillion: string;
  outputPerMillion: string;
  cachedSemantics: CachedSemantics | null;
  reasoningInOutput: boolean | null;
  fxRateToVnd: string | null;
  fxSource: string | null;
  sourceUrl: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
}

export type ReserveResult =
  | { kind: 'RESERVED'; reservation: ReservationRow }
  | { kind: 'DENIED'; scope: BudgetScope; reason: 'EXCEEDED' | 'BLOCKED'; shortByVnd: string }
  | { kind: 'APPROVAL_REQUIRED'; scope: BudgetScope; budgetId: string; shortByVnd: string };

export interface SettleInput {
  reservationId: string;
  providerRequestId: string;
  actualModel: string;
  pricingVersionId: string;
  usage: Usage;
  attemptKind?: 'PRIMARY' | 'RETRY' | 'FALLBACK';
  attemptNo?: number;
  routeClass?: string | null;
  providerId?: string | null;
  latencyMs?: number | null;
  /** True (the default) for the attempt that ends the request: what is left of the hold is released. False for an attempt that is followed by a retry or a fallback: its cost is taken out of the hold, which stays open for the next. */
  final?: boolean;
  actor: string;
}

export interface SettleResult {
  /** True when the provider request had been settled already: nothing changed and the answer is the one given then. */
  replayed: boolean;
  attemptId: string;
  reservationId: string;
  costVnd: string;
  releasedVnd: string;
  exception: boolean;
  thresholdCrossed: boolean;
}

interface Sql {
  [column: string]: unknown;
  id: string;
  scope_kind: "USER" | "UNIT" | "TENANT" | "PROJECT";
  scope_ref_id: string | null;
  period: "MONTH" | "QUARTER" | "YEAR";
  limit_vnd: string;
  soft_threshold_pct: number;
  hard_stop: boolean;
  max_requests_per_day: number | null;
  max_concurrent: number | null;
  effective_from: string | number | Date;
  status: string;
  created_by: string;
  created_at: string | number | Date;
  budget_id: string;
  period_start: string;
  settled_vnd: string;
  reserved_open_vnd: string;
  request_count: number;
  exception_count: number;
  blocked: boolean;
  request_id: string;
  reserved_amount: string;
  currency: string;
  expires_at: string | number | Date;
  settled_amount: string;
  released_amount: string;
  settled_at: string | number | Date;
  reconcile_note: string | null;
  page_key: string;
  provider: string;
  model_id: string;
  model_ref_id: string | null;
  effective_until: string | number | Date;
  input_per_million: string;
  cached_per_million: string;
  output_per_million: string;
  cached_semantics: CachedSemantics | null;
  reasoning_in_output: boolean | null;
  fx_rate_to_vnd: string | null;
  fx_source: string | null;
  source_url: string;
  verified_by: string | null;
  verified_at: string | number | Date;
  cost_vnd: string;
  input_total: string;
  cached_input: string;
  noncached_input: string;
  output_total: string;
}

const BUDGET = `select id, scope_kind, scope_ref_id, period, limit_vnd::text as limit_vnd, soft_threshold_pct, hard_stop, max_requests_per_day, max_concurrent, effective_from::text as effective_from, status, created_by, created_at, version::text as version from machvon.ai_budget`;
const COUNTER = `select id, budget_id, period_start::text as period_start, limit_vnd::text as limit_vnd, settled_vnd::text as settled_vnd, reserved_open_vnd::text as reserved_open_vnd, request_count, exception_count, blocked, version::text as version from machvon.ai_budget_counter`;
const RESERVATION = `select id, request_id, scope_json, reserved_amount::text as reserved_amount, currency, status, expires_at, settled_amount::text as settled_amount, released_amount::text as released_amount, settled_at, reconcile_note, created_at,
    to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as page_key, version::text as version from machvon.budget_reservation`;
const PRICE = `select id, provider, model_id, model_ref_id, currency, effective_from, effective_until, input_per_million::text as input_per_million, cached_per_million::text as cached_per_million, output_per_million::text as output_per_million, cached_semantics, reasoning_in_output, fx_rate_to_vnd::text as fx_rate_to_vnd, fx_source, source_url, verified_by, verified_at from machvon.pricing_version`;

const budgetOf = (row: Sql): BudgetRow => ({
  id: row.id,
  scopeKind: row.scope_kind,
  scopeRefId: row.scope_ref_id,
  period: row.period,
  limitVnd: row.limit_vnd,
  softThresholdPct: row.soft_threshold_pct,
  hardStop: row.hard_stop,
  maxRequestsPerDay: row.max_requests_per_day,
  maxConcurrent: row.max_concurrent,
  effectiveFrom: row.effective_from as string,
  status: row.status,
  createdBy: row.created_by,
  createdAt: new Date(row.created_at).toISOString(),
  version: Number(row.version),
});
// The counters keep eight places; the amounts of the application are whole dong, shown without the fraction.
const dong = (value: string): string => value.replace(/\.0+$/, '');
// The amounts of a counter are whole dong held with eight places: read as they are, with all the digits of the column (a price rate has fewer).
const wholeDong = (value: string): bigint => BigInt(value.split('.')[0] ?? '0');
const counterOf = (row: Sql): CounterRow => ({
  id: row.id,
  budgetId: row.budget_id,
  periodStart: row.period_start,
  limitVnd: dong(row.limit_vnd),
  settledVnd: dong(row.settled_vnd),
  reservedOpenVnd: dong(row.reserved_open_vnd),
  requestCount: row.request_count,
  exceptionCount: row.exception_count,
  blocked: row.blocked,
});
const reservationOf = (row: Sql): ReservationRow => ({
  id: row.id,
  requestId: row.request_id,
  scope: row.scope_json as { kind: "USER" | "UNIT" | "TENANT" | "PROJECT"; ref: string | null; budgetId: string; counterId: string; }[],
  reservedAmount: dong(row.reserved_amount),
  currency: row.currency,
  status: row.status,
  expiresAt: new Date(row.expires_at).toISOString(),
  settledAmount: row.settled_amount === null ? null : dong(row.settled_amount),
  releasedAmount: row.released_amount === null ? null : dong(row.released_amount),
  settledAt: row.settled_at === null ? null : new Date(row.settled_at).toISOString(),
  reconcileNote: row.reconcile_note,
  createdAt: new Date(row.created_at).toISOString(),
  version: Number(row.version),
  pageKey: row.page_key,
});
const priceOf = (row: Sql): PriceRow => ({
  id: row.id,
  provider: row.provider,
  modelId: row.model_id,
  modelRefId: row.model_ref_id,
  currency: row.currency,
  effectiveFrom: new Date(row.effective_from).toISOString(),
  effectiveUntil: row.effective_until === null ? null : new Date(row.effective_until).toISOString(),
  inputPerMillion: row.input_per_million,
  cachedPerMillion: row.cached_per_million,
  outputPerMillion: row.output_per_million,
  cachedSemantics: row.cached_semantics,
  reasoningInOutput: row.reasoning_in_output,
  fxRateToVnd: row.fx_rate_to_vnd,
  fxSource: row.fx_source,
  sourceUrl: row.source_url,
  verifiedBy: row.verified_by,
  verifiedAt: row.verified_at === null ? null : new Date(row.verified_at).toISOString(),
});

const SCOPE_TABLE: Readonly<Record<Exclude<BudgetScope, 'TENANT'>, string>> = { UNIT: 'machvon.organization_unit', PROJECT: 'machvon.project', USER: 'machvon.membership' };
const rank = (kind: string): number => BUDGET_SCOPE_ORDER.indexOf(kind as BudgetScope);

export interface BudgetInput {
  scopeKind: BudgetScope;
  scopeRefId: string | null;
  period: BudgetPeriod;
  limitVnd: string;
  softThresholdPct: number;
  hardStop: boolean;
  maxRequestsPerDay: number | null;
  maxConcurrent: number | null;
  effectiveFrom: string;
  actor: string;
}

/**
 * The budgets of the AI gateway (ST-LLM-003, LLM F3): a budget is a limit for a scope (the tenant, a unit, a project, a person) and a period; its counter for the period holds what was settled and what is held for requests
 * in flight. A request is held against every budget it belongs to, the counters locked one by one in the order tenant, unit, project, user (and by id within a scope), so that two requests that need the same counters wait in
 * line and never for each other. What a counter holds is exact: `available = limit − settled − reserved_open`, and the database refuses `reserved_open > limit`.
 */
export class LlmFinopsStore {
  // ---- budgets -----------------------------------------------------------------------------------------------------------------------------

  async budgets(tx: TenantTx, day: string): Promise<BudgetWithCounter[]> {
    const budgets = (await tx.query<Sql>(`${BUDGET} order by array_position(array['TENANT','UNIT','PROJECT','USER'], scope_kind), scope_ref_id nulls first, period, effective_from`)).map(budgetOf);
    const out: BudgetWithCounter[] = [];
    for (const budget of budgets) {
      const rows = await tx.query<Sql>(`${COUNTER} where budget_id = $1::uuid and period_start = $2::date`, [budget.id, periodStartOf(budget.period, day)]);
      out.push({ ...budget, counter: rows[0] === undefined ? null : counterOf(rows[0]) });
    }
    return out;
  }

  async findBudget(tx: TenantTx, id: string): Promise<BudgetRow | undefined> {
    const rows = await tx.query<Sql>(`${BUDGET} where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : budgetOf(rows[0]);
  }

  /** Creates a budget: for one scope and period there is one ACTIVE budget, and what a unit, a project or a person may spend is not more than the tenant may (CHILD_EXCEEDS_PARENT either way). */
  async createBudget(tx: TenantTx, input: BudgetInput): Promise<BudgetRow> {
    assertBudgetDraft({ scopeKind: input.scopeKind, scopeRefId: input.scopeRefId, period: input.period, limitVnd: input.limitVnd, softThresholdPct: input.softThresholdPct, maxRequestsPerDay: input.maxRequestsPerDay, maxConcurrent: input.maxConcurrent });
    if (input.scopeKind !== 'TENANT') {
      const found = await tx.query(`select 1 from ${SCOPE_TABLE[input.scopeKind]} where id = $1::uuid`, [input.scopeRefId]);
      if (found.length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'scope_ref_id');
    }
    await tx.query("select pg_advisory_xact_lock(hashtextextended('llm_budget:' || current_setting('app.tenant_id', true), 0))");
    const same = await tx.query("select 1 from machvon.ai_budget where scope_kind = $1 and scope_ref_id is not distinct from $2::uuid and period = $3 and status = 'ACTIVE'", [input.scopeKind, input.scopeRefId, input.period]);
    if (same.length > 0) throw new DomainError('BUDGET_SCOPE_DUPLICATE', 409, 'scope_ref_id');
    const limit = BigInt(input.limitVnd);
    if (input.scopeKind === 'TENANT') {
      const above = await tx.query<{ limit_vnd: string }>("select max(limit_vnd)::text as limit_vnd from machvon.ai_budget where scope_kind <> 'TENANT' and period = $1 and status = 'ACTIVE'", [input.period]);
      if (above[0]?.limit_vnd != null && BigInt(above[0].limit_vnd) > limit) throw new DomainError('CHILD_EXCEEDS_PARENT', 422, 'limit_vnd');
    } else {
      const parent = await tx.query<{ limit_vnd: string }>("select limit_vnd::text as limit_vnd from machvon.ai_budget where scope_kind = 'TENANT' and period = $1 and status = 'ACTIVE'", [input.period]);
      if (parent[0] !== undefined && limit > BigInt(parent[0].limit_vnd)) throw new DomainError('CHILD_EXCEEDS_PARENT', 422, 'limit_vnd');
    }
    const id = randomUUID();
    await tx.query(
      `insert into machvon.ai_budget (tenant_id, id, scope_kind, scope_ref_id, period, limit_vnd, soft_threshold_pct, hard_stop, max_requests_per_day, max_concurrent, effective_from, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::uuid, $4, $5::numeric, $6::int, $7, $8::int, $9::int, $10::date, $11::uuid, $11::uuid)`,
      [id, input.scopeKind, input.scopeRefId, input.period, input.limitVnd, input.softThresholdPct, input.hardStop, input.maxRequestsPerDay, input.maxConcurrent, input.effectiveFrom, input.actor],
    );
    return (await this.findBudget(tx, id)) as BudgetRow;
  }

  /** The counter of a budget for the period that holds the day, made on first use. */
  private async counterFor(tx: TenantTx, budget: BudgetRow, day: string): Promise<string> {
    const start = periodStartOf(budget.period, day);
    await tx.query(
      `insert into machvon.ai_budget_counter (tenant_id, id, budget_id, period_start, limit_vnd)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::date, $3::numeric) on conflict (tenant_id, budget_id, period_start) do nothing`,
      [budget.id, start, budget.limitVnd],
    );
    const rows = await tx.query<{ id: string }>('select id from machvon.ai_budget_counter where budget_id = $1::uuid and period_start = $2::date', [budget.id, start]);
    return (rows[0] as { id: string }).id;
  }

  // ---- reservation -------------------------------------------------------------------------------------------------------------------------

  /**
   * Holds `estimateVnd` for a request against the budgets of the scopes it belongs to (a scope without a budget does not limit it). The counters are locked one at a time in a fixed order. A scope that cannot take the
   * estimate refuses the request: `DENIED` when its budget stops at the limit, `APPROVAL_REQUIRED` when it does not (a decision of a person raises the limit instead of the provider being called).
   */
  async reserve(tx: TenantTx, input: { requestId: string; scopes: ReadonlyArray<{ kind: BudgetScope; ref: string | null }>; estimateVnd: string; day: string; expiresAt: Date }): Promise<ReserveResult> {
    if (!/^[0-9]{1,24}$/.test(input.estimateVnd)) throw new DomainError('VALIDATION_FAILED', 422, 'estimate_vnd');
    const estimate = BigInt(input.estimateVnd);
    // A request is held once: a repeat of the admission (a retry of the call) finds the hold it made, and does not make another.
    await tx.query("select pg_advisory_xact_lock(hashtextextended('llm_reserve:' || current_setting('app.tenant_id', true) || ':' || $1, 0))", [input.requestId]);
    const held = await tx.query<Sql>(`${RESERVATION} where request_id = $1::uuid`, [input.requestId]);
    if (held[0] !== undefined) {
      const existing = reservationOf(held[0]);
      if (existing.status !== 'RESERVED' && existing.status !== 'PENDING_RECONCILE') throw new DomainError('RESERVATION_NOT_ACTIVE', 409, 'status');
      return { kind: 'RESERVED', reservation: existing };
    }
    // The budgets of the scopes, in lock order: scope kind, then the reference, then the id.
    // A scope named twice is one scope: it holds the estimate once.
    const unique = new Map(input.scopes.map((scope) => [`${scope.kind}:${scope.ref ?? ''}`, scope] as const));
    const wanted = [...unique.values()].sort((a, b) => rank(a.kind) - rank(b.kind) || (a.ref ?? '').localeCompare(b.ref ?? ''));
    const found: Array<{ kind: BudgetScope; ref: string | null; budget: BudgetRow; counterId: string }> = [];
    for (const scope of wanted) {
      // Every ACTIVE budget of the scope applies, whatever its period: a month and a year are two ceilings over the same request.
      const rows = await tx.query<Sql>(`${BUDGET} where scope_kind = $1 and scope_ref_id is not distinct from $2::uuid and status = 'ACTIVE' and effective_from <= $3::date order by period, effective_from desc, id`, [scope.kind, scope.ref, input.day]);
      for (const row of rows) {
        const budget = budgetOf(row);
        found.push({ kind: scope.kind, ref: scope.ref, budget, counterId: await this.counterFor(tx, budget, input.day) });
      }
    }
    found.sort((a, b) => rank(a.kind) - rank(b.kind) || (a.ref ?? '').localeCompare(b.ref ?? '') || a.counterId.localeCompare(b.counterId));
    const locked: Array<{ counter: Sql; entry: (typeof found)[number] }> = [];
    for (const entry of found) {
      const rows = await tx.query<Sql>(`${COUNTER} where id = $1::uuid for update`, [entry.counterId]);
      locked.push({ counter: rows[0] as Sql, entry });
    }
    // Each budget is judged in the order it was locked; the first that cannot take the estimate decides (and its own kind of stop says whether a person may raise it).
    for (const { counter, entry } of locked) {
      const decision = decideReservation(
        [{ kind: entry.kind, limitVnd: wholeDong(counter.limit_vnd), settledVnd: wholeDong(counter.settled_vnd), reservedOpenVnd: wholeDong(counter.reserved_open_vnd), blocked: counter.blocked as boolean }],
        estimate,
      );
      if (decision.ok) continue;
      if (!entry.budget.hardStop && decision.reason === 'EXCEEDED') return { kind: 'APPROVAL_REQUIRED', scope: decision.scope, budgetId: entry.budget.id, shortByVnd: decision.shortBy.toString() };
      return { kind: 'DENIED', scope: decision.scope, reason: decision.reason, shortByVnd: decision.shortBy.toString() };
    }
    for (const { entry } of locked) {
      await tx.query('update machvon.ai_budget_counter set reserved_open_vnd = reserved_open_vnd + $2::numeric, request_count = request_count + 1, version = version + 1, updated_at = now() where id = $1::uuid', [entry.counterId, input.estimateVnd]);
    }
    const id = randomUUID();
    const scope = locked.map(({ entry }) => ({ kind: entry.kind, ref: entry.ref, budgetId: entry.budget.id, counterId: entry.counterId }));
    await tx.query(
      `insert into machvon.budget_reservation (tenant_id, id, request_id, scope_json, reserved_amount, currency, status, expires_at, budget_counter_ids)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::jsonb, $4::numeric, 'VND', 'RESERVED', $5::timestamptz, $6::jsonb)`,
      [id, input.requestId, JSON.stringify(scope), input.estimateVnd, input.expiresAt.toISOString(), JSON.stringify(scope.map((entry) => entry.counterId))],
    );
    return { kind: 'RESERVED', reservation: (await this.findReservation(tx, id)) as ReservationRow };
  }

  async findReservation(tx: TenantTx, id: string, lock = false): Promise<ReservationRow | undefined> {
    const rows = await tx.query<Sql>(`${RESERVATION} where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : reservationOf(rows[0]);
  }

  /** The reservations, newest first, a page at a time: `after` is the key and id of the last row of the page before. One more than `limit` is read so that the caller knows whether another page follows. */
  async reservations(tx: TenantTx, filter: { status?: string | undefined; requestId?: string | undefined }, page: { limit: number; after?: { key: string; id: string } | undefined }): Promise<ReservationRow[]> {
    return (
      await tx.query<Sql>(
        `${RESERVATION} where ($1::text is null or status = $1) and ($2::uuid is null or request_id = $2::uuid)
            and ($3::timestamptz is null or (created_at, id) < ($3::timestamptz, $4::uuid))
          order by created_at desc, id desc limit $5::int`,
        [filter.status ?? null, filter.requestId ?? null, page.after?.key ?? null, page.after?.id ?? null, page.limit + 1],
      )
    ).map(reservationOf);
  }

  /** The counters of a reservation locked in the order they were held in (the order of the lock of a reservation). */
  private async lockCounters(tx: TenantTx, reservation: ReservationRow): Promise<Sql[]> {
    const ordered = [...reservation.scope].sort((a, b) => rank(a.kind) - rank(b.kind) || (a.ref ?? '').localeCompare(b.ref ?? '') || a.counterId.localeCompare(b.counterId));
    const rows: Sql[] = [];
    for (const entry of ordered) rows.push((await tx.query<Sql>(`${COUNTER} where id = $1::uuid for update`, [entry.counterId]))[0] as Sql);
    return rows;
  }

  // ---- settlement --------------------------------------------------------------------------------------------------------------------------

  /**
   * Settles an attempt against its reservation, once for each provider request: the actual cost, from the price version in force at the attempt, joins the settled amount, the reservation leaves the open amount and what was
   * not used is released. A second call with the same provider request id changes nothing and gives the answer of the first. An actual cost above the reservation is an exception: the numbers stand, the scopes are blocked
   * for the next requests and the exception is counted. The first settlement that takes a counter to its soft threshold leaves one event for the period.
   */
  async settle(tx: TenantTx, input: SettleInput): Promise<SettleResult> {
    // The reservation is locked first: a second delivery of the same provider request waits here for the first to finish, and then finds its attempt.
    const reservation = await this.findReservation(tx, input.reservationId, true);
    if (reservation === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const earlier = await tx.query<Sql>('select id, cost_vnd::text as cost_vnd, ai_request_id, settlement from machvon.llm_attempt where provider_request_id = $1', [input.providerRequestId]);
    if (earlier[0] !== undefined) {
      // A provider request id is one request's: another reservation that names it is not a repeat, and is refused instead of being answered as one.
      if (earlier[0].ai_request_id !== reservation.requestId) throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'provider_request_id');
      // The answer of the first delivery is the one of the attempt itself (what it released, whether it went over, whether it crossed the line), kept with it; not what the reservation says now.
      const first = earlier[0].settlement as { released_vnd?: string; exception?: boolean; threshold_crossed?: boolean } | null;
      return { replayed: true, attemptId: earlier[0].id, reservationId: reservation.id, costVnd: earlier[0].cost_vnd, releasedVnd: first?.released_vnd ?? '0', exception: first?.exception === true, thresholdCrossed: first?.threshold_crossed === true };
    }
    // An attempt whose usage comes after the request ended (a primary that timed out and is reconciled once a fallback had answered) is real cost with no hold left: it is charged to the counters as it is.
    const late = reservation.status === 'SETTLED' || reservation.status === 'EXCEPTION';
    if (!late && reservation.status !== 'RESERVED' && reservation.status !== 'PENDING_RECONCILE') throw new DomainError('RESERVATION_NOT_ACTIVE', 409, 'status');
    const price = await this.priceById(tx, input.pricingVersionId);
    if (price === undefined || price.cachedSemantics === null || price.fxRateToVnd === null) throw new DomainError('VALIDATION_FAILED', 422, 'pricing_version_id');
    const priced: Price = { inputPerMillion: price.inputPerMillion, cachedPerMillion: price.cachedPerMillion, outputPerMillion: price.outputPerMillion, cachedSemantics: price.cachedSemantics, fxRateToVnd: price.fxRateToVnd };
    const cost = costOf(input.usage, priced);
    const actual = BigInt(cost.costVnd);
    // What is still held is what was reserved less what the earlier attempts of the request have already used.
    const used = BigInt(reservation.settledAmount ?? '0');
    const remaining = late ? 0n : BigInt(reservation.reservedAmount) - used;
    const final = late || input.final !== false;
    const shape = late ? { released: 0n, exception: false } : settlementOf({ reserved: remaining, actual });
    const released = shape.released;
    // Whether the cost went over is judged for each counter, and the answer for the request is that any of them did.
    let exception = shape.exception;
    let lateOver = false;
    // The hold leaves the open amount all at once when the request ends (or goes over); between attempts only the cost of the attempt leaves it; a late attempt has no hold to leave it.
    const freed = late ? 0n : final || exception ? remaining : actual;
    const counters = await this.lockCounters(tx, reservation);
    let crossed = false;
    for (const counter of counters) {
      const budget = (await this.findBudget(tx, counter.budget_id)) as BudgetRow;
      const before = BigInt(dong(counter.settled_vnd));
      const after = before + actual;
      // A late cost is above the limit when what is settled and what is still held no longer fit in it: the scope is blocked, as for any cost that goes over.
      const over = late && after + BigInt(dong(counter.reserved_open_vnd)) > BigInt(dong(counter.limit_vnd));
      if (over) lateOver = true;
      if (crossesThreshold(before, after, BigInt(dong(counter.limit_vnd)), budget.softThresholdPct)) {
        crossed = true;
        await enqueueOutbox(tx, {
          aggregateType: 'ai_budget',
          aggregateId: budget.id,
          aggregateVersion: Number(counter.version),
          type: 'llm.budget.threshold_reached.v1',
          schemaVersion: 1,
          payload: { budget_id: budget.id, counter_id: counter.id, scope_kind: budget.scopeKind, period_start: counter.period_start, threshold_pct: budget.softThresholdPct },
          // One event for each counter, that is for each period of each budget.
          eventKey: `llm.budget.threshold_reached:${counter.id}`,
          correlationId: randomUUID(),
        });
      }
      await tx.query(
        'update machvon.ai_budget_counter set settled_vnd = settled_vnd + $2::numeric, reserved_open_vnd = reserved_open_vnd - $3::numeric, exception_count = exception_count + $4::int, blocked = blocked or $5::boolean, version = version + 1, updated_at = now() where id = $1::uuid',
        [counter.id, cost.costVnd, freed.toString(), shape.exception || over ? 1 : 0, shape.exception || over],
      );
    }
    if (lateOver) exception = true;
    const attemptId = randomUUID();
    await tx.query(
      `insert into machvon.llm_attempt (tenant_id, id, run_id, provider_request_id, actual_model, pricing_version_id, input_total, cached_input, output_total, reasoning_info, cost, currency, reconcile_status,
         ai_request_id, attempt_no, attempt_kind, route_class, provider_id, outcome, latency_ms, noncached_input, tool_fee, fx_rate_to_vnd, cost_vnd, settlement)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, null, $2, $3, $4::uuid, $5::bigint, $6::bigint, $7::bigint, 0, $8::numeric, $9, 'SETTLED',
         $10::uuid, $11::int, $12, $13, $14::uuid, 'SUCCESS', $15::int, $16::bigint, $17::numeric, $18::numeric, $19::numeric, $20::jsonb)`,
      [
        attemptId,
        input.providerRequestId,
        input.actualModel,
        input.pricingVersionId,
        input.usage.inputTotal,
        input.usage.cachedInput,
        input.usage.outputTotal,
        cost.cost,
        price.currency,
        reservation.requestId,
        input.attemptNo ?? 1,
        input.attemptKind ?? 'PRIMARY',
        input.routeClass ?? null,
        input.providerId ?? null,
        input.latencyMs ?? null,
        cost.noncachedInput,
        input.usage.toolFee ?? '0',
        price.fxRateToVnd,
        cost.costVnd,
        JSON.stringify({ released_vnd: !late && (final || exception) ? released.toString() : '0', exception, threshold_crossed: crossed, final, late }),
      ],
    );
    await tx.query(
      `update machvon.budget_reservation set status = $2, settled_amount = $3::numeric, released_amount = $4::numeric, settled_at = case when $5::boolean then now() else settled_at end, version = version + 1 where id = $1::uuid`,
      [reservation.id, exception ? 'EXCEPTION' : late ? reservation.status : final ? 'SETTLED' : reservation.status, (used + actual).toString(), late ? reservation.releasedAmount : final || exception ? released.toString() : null, !late && (final || exception)],
    );
    await enqueueOutbox(tx, {
      aggregateType: 'budget_reservation',
      aggregateId: reservation.id,
      aggregateVersion: reservation.version + 1,
      type: 'llm.usage.settled.v1',
      schemaVersion: 1,
      payload: { reservation_id: reservation.id, request_id: reservation.requestId, attempt_id: attemptId, cost_vnd: cost.costVnd, released_vnd: !late && (final || exception) ? released.toString() : '0', exception, final, late, threshold_crossed: crossed },
      eventKey: `llm.usage.settled:${input.providerRequestId}`,
      correlationId: randomUUID(),
    });
    return { replayed: false, attemptId, reservationId: reservation.id, costVnd: cost.costVnd, releasedVnd: !late && (final || exception) ? released.toString() : '0', exception, thresholdCrossed: crossed };
  }

  /** A request that timed out, or came back with no usage: the reservation stays as it is and waits for the reconciliation (BR-LLM-06); nothing is assumed to have cost nothing. */
  async markPendingReconcile(tx: TenantTx, reservationId: string, note: string): Promise<ReservationRow> {
    const reservation = await this.findReservation(tx, reservationId, true);
    if (reservation === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (reservation.status === 'PENDING_RECONCILE') return reservation;
    if (reservation.status !== 'RESERVED') throw new DomainError('RESERVATION_NOT_ACTIVE', 409, 'status');
    await tx.query("update machvon.budget_reservation set status = 'PENDING_RECONCILE', reconcile_note = $2, version = version + 1 where id = $1::uuid", [reservationId, note]);
    return (await this.findReservation(tx, reservationId)) as ReservationRow;
  }

  /** Releases a reservation that will never be settled (the request was cancelled before it was sent), on a decision with a reason: the open amount goes back to the counters. */
  async release(tx: TenantTx, reservationId: string, reason: string): Promise<ReservationRow> {
    const reservation = await this.findReservation(tx, reservationId, true);
    if (reservation === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (reservation.status !== 'RESERVED' && reservation.status !== 'PENDING_RECONCILE') throw new DomainError('RESERVATION_NOT_ACTIVE', 409, 'status');
    // Attempts that were settled before have already taken their cost out of the hold: only what is left of it goes back.
    const remaining = (BigInt(reservation.reservedAmount) - BigInt(reservation.settledAmount ?? '0')).toString();
    for (const counter of await this.lockCounters(tx, reservation)) {
      await tx.query('update machvon.ai_budget_counter set reserved_open_vnd = reserved_open_vnd - $2::numeric, version = version + 1, updated_at = now() where id = $1::uuid', [counter.id, remaining]);
    }
    await tx.query("update machvon.budget_reservation set status = 'RELEASED', released_amount = $3::numeric, reconcile_note = $2, settled_at = now(), version = version + 1 where id = $1::uuid", [reservationId, reason, remaining]);
    return (await this.findReservation(tx, reservationId)) as ReservationRow;
  }

  /** The reservations that were held for requests that never came back: past their end they wait for the reconciliation. The pass is idempotent. */
  async expireDue(tx: TenantTx, now: Date): Promise<{ expired: number; oldestAgeSeconds: number }> {
    const due = await tx.query<{ id: string }>("select id from machvon.budget_reservation where status = 'RESERVED' and expires_at <= $1::timestamptz order by expires_at, id for update skip locked", [now.toISOString()]);
    for (const row of due) {
      await tx.query("update machvon.budget_reservation set status = 'PENDING_RECONCILE', reconcile_note = 'TIMEOUT_NO_USAGE', version = version + 1 where id = $1::uuid", [row.id]);
    }
    const age = await tx.query<{ age: string | null }>("select extract(epoch from ($1::timestamptz - min(created_at)))::text as age from machvon.budget_reservation where status in ('RESERVED', 'PENDING_RECONCILE')", [now.toISOString()]);
    return { expired: due.length, oldestAgeSeconds: Math.max(0, Math.floor(Number(age[0]?.age ?? 0))) };
  }

  // ---- spend -------------------------------------------------------------------------------------------------------------------------------

  /** What a budget has spent: its counters by period, and for the period of the day the tokens and the cost of the attempts that settled against it, with the cached and the uncached input apart. */
  async spend(tx: TenantTx, budgetId: string, day: string): Promise<{ budget: BudgetRow; counters: CounterRow[]; current: { counter: CounterRow | null; attempts: number; inputTotal: string; cachedInput: string; noncachedInput: string; outputTotal: string; costVnd: string; pendingReconcile: number } } | undefined> {
    const budget = await this.findBudget(tx, budgetId);
    if (budget === undefined) return undefined;
    const counters = (await tx.query<Sql>(`${COUNTER} where budget_id = $1::uuid order by period_start desc limit 24`, [budgetId])).map(counterOf);
    const start = periodStartOf(budget.period, day);
    const counter = counters.find((candidate) => candidate.periodStart === start) ?? null;
    const sums = await tx.query<Sql>(
      `select count(a.id)::text as attempts, coalesce(sum(a.input_total), 0)::text as input_total, coalesce(sum(a.cached_input), 0)::text as cached_input, coalesce(sum(a.noncached_input), 0)::text as noncached_input,
              coalesce(sum(a.output_total), 0)::text as output_total, coalesce(sum(a.cost_vnd), 0)::text as cost_vnd
         from machvon.budget_reservation r join machvon.llm_attempt a on a.ai_request_id = r.request_id
        where $1::text is not null and r.budget_counter_ids @> jsonb_build_array($1::text)`,
      [counter?.id ?? null],
    );
    const pending = await tx.query<{ n: string }>("select count(*)::text as n from machvon.budget_reservation where status = 'PENDING_RECONCILE' and $1::text is not null and budget_counter_ids @> jsonb_build_array($1::text)", [counter?.id ?? null]);
    const sum = sums[0] as Sql;
    return {
      budget,
      counters,
      current: { counter, attempts: Number(sum.attempts), inputTotal: sum.input_total, cachedInput: sum.cached_input, noncachedInput: sum.noncached_input, outputTotal: sum.output_total, costVnd: sum.cost_vnd, pendingReconcile: Number(pending[0]?.n ?? 0) },
    };
  }

  // ---- prices ------------------------------------------------------------------------------------------------------------------------------

  async prices(tx: TenantTx): Promise<PriceRow[]> {
    return (await tx.query<Sql>(`${PRICE} order by provider, model_id, effective_from desc`)).map(priceOf);
  }

  async priceById(tx: TenantTx, id: string): Promise<PriceRow | undefined> {
    const rows = await tx.query<Sql>(`${PRICE} where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : priceOf(rows[0]);
  }

  /** The price version of a model in force at a moment: the one that began at or before it and had not ended. */
  async priceAt(tx: TenantTx, modelRefId: string, at: Date): Promise<PriceRow | undefined> {
    const rows = await tx.query<Sql>(`${PRICE} where model_ref_id = $1::uuid and effective_from <= $2::timestamptz and (effective_until is null or effective_until > $2::timestamptz) order by effective_from desc limit 1`, [modelRefId, at.toISOString()]);
    return rows[0] === undefined ? undefined : priceOf(rows[0]);
  }

  /**
   * Registers a price version of a model. It must begin after every version the model has (PRICING_RANGE_OVERLAP otherwise): the one in force ends where the new one begins, so the periods never overlap.
   * The price has its source (SOURCE_URL_REQUIRED); the verification by a second person is a step of its own (a price that is not verified says so).
   */
  async registerPrice(
    tx: TenantTx,
    input: { provider: string; modelId: string; modelRefId: string; currency: string; effectiveFrom: Date; inputPerMillion: string; cachedPerMillion: string; outputPerMillion: string; cachedSemantics: CachedSemantics; reasoningInOutput: boolean; sourceUrl: string; fxRateToVnd: string; fxSource: string },
  ): Promise<PriceRow> {
    assertPriceDraft({ provider: input.provider, currency: input.currency, inputPerMillion: input.inputPerMillion, cachedPerMillion: input.cachedPerMillion, outputPerMillion: input.outputPerMillion, fxRateToVnd: input.fxRateToVnd, sourceUrl: input.sourceUrl });
    const model = await tx.query<{ model_id: string }>('select model_id from machvon.ai_model where id = $1::uuid', [input.modelRefId]);
    if (model[0] === undefined || model[0].model_id !== input.modelId) throw new DomainError('VALIDATION_FAILED', 422, 'model_ref_id');
    await tx.query("select pg_advisory_xact_lock(hashtextextended('llm_price:' || current_setting('app.tenant_id', true) || ':' || $1, 0))", [input.modelRefId]);
    const latest = await tx.query<{ effective_from: Date }>('select max(effective_from) as effective_from from machvon.pricing_version where model_ref_id = $1::uuid', [input.modelRefId]);
    const last = latest[0]?.effective_from;
    if (last != null && input.effectiveFrom.getTime() <= new Date(last).getTime()) throw new DomainError('PRICING_RANGE_OVERLAP', 409, 'effective_from');
    await tx.query('update machvon.pricing_version set effective_until = $2::timestamptz where model_ref_id = $1::uuid and effective_until is null', [input.modelRefId, input.effectiveFrom.toISOString()]);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.pricing_version (tenant_id, id, provider, model_id, currency, effective_from, input_per_million, cached_per_million, output_per_million, source_url, model_ref_id, cached_semantics, reasoning_in_output, fx_rate_to_vnd, fx_source, fx_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5::timestamptz, $6::numeric, $7::numeric, $8::numeric, $9, $10::uuid, $11, $12, $13::numeric, $14, now())`,
      [id, input.provider, input.modelId, input.currency, input.effectiveFrom.toISOString(), input.inputPerMillion, input.cachedPerMillion, input.outputPerMillion, input.sourceUrl.trim(), input.modelRefId, input.cachedSemantics, input.reasoningInOutput, input.fxRateToVnd, input.fxSource],
    );
    return (await this.priceById(tx, id)) as PriceRow;
  }
}
