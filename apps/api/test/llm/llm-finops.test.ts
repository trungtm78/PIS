import { randomUUID } from 'node:crypto';
import { LlmFinopsStore } from '@machvon/db';
import type { ReserveResult, TenantTx } from '@machvon/db';
import { periodStartOf, vietnamDateOf } from '@machvon/kernel';
import { contextFor } from '../../../../packages/db/test/support/authz-fixtures';
import { encodeCursor } from '../../src/pagination';
import { AI_ADMIN, BRANCH, FINOPS, LlmApp, NOBODY, READER, ROOT, SCOPED, TENANT_A, TENANT_B, memberId, unitId } from './llm-app';
import type { Reply } from './llm-app';

const app = new LlmApp();
const store = new LlmFinopsStore();
jest.setTimeout(240_000);

beforeAll(() => app.start());
afterAll(() => app.stop());

let since = new Date();
beforeEach(async () => {
  await app.reset();
  since = new Date();
});

const TODAY = vietnamDateOf(new Date());
const THIS_MONTH = periodStartOf('MONTH', TODAY);
const withTx = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(FINOPS)), work);
const events = (type: string) => app.rows<{ payload: Record<string, unknown>; event_key: string }>('select payload, event_key from machvon.outbox_event where type = $1 and created_at >= $2 order by created_at', [type, since]);

/** An AI request, put in as the gateway will (ST-LLM-005); the rows it points at are not what is tested here. */
async function request(): Promise<string> {
  const id = randomUUID();
  await app.seedReplica([
    [
      `insert into machvon.ai_request (tenant_id, id, task_type, subject_module, requested_by, profile_version_id, data_classification, classification_basis, policy_version_id, input_sha256, created_by, updated_by)
       values ($1, $2, 'SUMMARY', 'BID', $3, $4, 'INTERNAL', '{}'::jsonb, $5, $6, $3, $3)`,
      [TENANT_A, id, memberId(FINOPS), randomUUID(), randomUUID(), 'a'.repeat(64)],
    ],
  ]);
  return id;
}

async function project(): Promise<string> {
  const id = randomUUID();
  await app.seedReplica([
    [
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
      [TENANT_A, id, `PRJ-${id.slice(0, 8)}`, unitId(ROOT), randomUUID()],
    ],
  ]);
  return id;
}

async function model(code = 'llm-priced'): Promise<string> {
  const provider = await app.call('POST', '/ai-providers', { member: AI_ADMIN, body: { provider_code: `P-${randomUUID().slice(0, 8)}`, name: 'Provider', region_country: 'VN', route_class: 'DOMESTIC_HOSTED', max_classification: 'PUBLIC' } });
  const made = await app.call('POST', '/ai-models', { member: AI_ADMIN, body: { provider_id: provider.json.resource_id, model_id: code, capabilities: {}, context_window: 8000, max_output: 1000, max_classification: 'PUBLIC' } });
  return made.json.resource_id as string;
}

const price = (modelRef: string, modelId: string, overrides: Record<string, unknown> = {}) => ({
  provider: 'ProviderCo',
  model_id: modelId,
  model_ref_id: modelRef,
  currency: 'USD',
  effective_from: '2026-01-01T00:00:00.000Z',
  input_per_million: '2.00',
  cached_per_million: '0.50',
  output_per_million: '8.00',
  cached_semantics: 'INCLUDED_IN_INPUT',
  reasoning_in_output: true,
  source_url: 'https://provider.example/pricing',
  fx_rate_to_vnd: '25400',
  fx_source: 'Vietcombank 2026-10-22',
  ...overrides,
});
const registerPrice = (body: Record<string, unknown>, member = FINOPS, tenantId?: string): Promise<Reply> => app.call('POST', '/ai-pricing-versions', { member, body, ...(tenantId === undefined ? {} : { tenantId }) });

/** A price of one dong for each input token, so that the cost of an attempt is its number of tokens. */
async function dongPrice(): Promise<string> {
  const ref = await model(`dong-${randomUUID().slice(0, 6)}`);
  const modelId = (await app.rows<{ model_id: string }>('select model_id from machvon.ai_model where id = $1', [ref]))[0]!.model_id;
  const made = await registerPrice(price(ref, modelId, { currency: 'VND', input_per_million: '1000000', cached_per_million: '0', output_per_million: '0', fx_rate_to_vnd: '1' }));
  expect(made.status).toBe(200);
  return made.json.resource_id as string;
}

const createBudget = (body: Record<string, unknown>, member = FINOPS, tenantId?: string): Promise<Reply> =>
  app.call('POST', '/ai-budgets', { member, body: { period: 'MONTH', hard_stop: true, effective_from: '2026-01-01', ...body }, ...(tenantId === undefined ? {} : { tenantId }) });

/** A budget made through the store, with the counter of this month already holding what was settled. */
async function budget(input: { scopeKind: 'TENANT' | 'UNIT' | 'PROJECT' | 'USER'; scopeRefId?: string | null; limit: number; settled?: number; hardStop?: boolean; soft?: number }): Promise<{ id: string; counterId: string }> {
  const created = await withTx((tx) =>
    store.createBudget(tx, {
      scopeKind: input.scopeKind,
      scopeRefId: input.scopeRefId ?? null,
      period: 'MONTH',
      limitVnd: String(input.limit),
      softThresholdPct: input.soft ?? 80,
      hardStop: input.hardStop ?? true,
      maxRequestsPerDay: null,
      maxConcurrent: null,
      effectiveFrom: '2026-01-01',
      actor: memberId(FINOPS),
    }),
  );
  const counterId = randomUUID();
  await app.rows(
    'insert into machvon.ai_budget_counter (tenant_id, id, budget_id, period_start, limit_vnd, settled_vnd) values ($1, $2, $3, $4::date, $5::numeric, $6::numeric)',
    [TENANT_A, counterId, created.id, THIS_MONTH, String(input.limit), String(input.settled ?? 0)],
  );
  return { id: created.id, counterId };
}

const counter = async (id: string) => (await app.rows<{ settled: string; reserved: string; exceptions: number; blocked: boolean }>('select settled_vnd::text as settled, reserved_open_vnd::text as reserved, exception_count as exceptions, blocked from machvon.ai_budget_counter where id = $1', [id]))[0]!;
const hold = async (scopes: Array<{ kind: 'TENANT' | 'UNIT' | 'PROJECT' | 'USER'; ref: string | null }>, estimate: number, requestId?: string, expiresInMs = 600_000): Promise<ReserveResult> => {
  const request_ = requestId ?? (await request());
  return withTx((tx) => store.reserve(tx, { requestId: request_, scopes, estimateVnd: String(estimate), day: TODAY, expiresAt: new Date(Date.now() + expiresInMs) }));
};
const TENANT_SCOPE = [{ kind: 'TENANT' as const, ref: null }];

describe('the reservation, the settlement and the reconciliation of a budget (ST-LLM-003, LLM F3)', () => {
  it('AC-ST-LLM-003-1: UAT-AC18 lets exactly one of two concurrent 400,000 jobs through a limit of 1,000,000 with 300,000 settled, refuses a third of 350,000, settles the held one at 180,000 and keeps a timed out one pending', async () => {
    const tenant = await budget({ scopeKind: 'TENANT', limit: 1_000_000, settled: 300_000 });
    const [one, two] = await Promise.all([hold(TENANT_SCOPE, 400_000), hold(TENANT_SCOPE, 400_000)]);
    const kinds = [one.kind, two.kind].sort();
    expect(kinds).toEqual(['DENIED', 'RESERVED']);
    const held = (one.kind === 'RESERVED' ? one : two) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    const refused = (one.kind === 'DENIED' ? one : two) as Extract<ReserveResult, { kind: 'DENIED' }>;
    expect(refused).toMatchObject({ scope: 'TENANT', reason: 'EXCEEDED', shortByVnd: '100000' });
    expect(await counter(tenant.counterId)).toMatchObject({ settled: '300000.00000000', reserved: '400000.00000000' });

    const third = await hold(TENANT_SCOPE, 350_000);
    expect(third).toMatchObject({ kind: 'DENIED', scope: 'TENANT', shortByVnd: '50000' });

    // The held job comes back with 180,000 tokens at one dong each: 480,000 settled, 220,000 released.
    const pricing = await dongPrice();
    const settled = await withTx((tx) =>
      store.settle(tx, { reservationId: held.reservation.id, providerRequestId: 'prov-1', actualModel: 'dong', pricingVersionId: pricing, usage: { inputTotal: 180_000, cachedInput: 0, outputTotal: 0 }, actor: memberId(FINOPS) }),
    );
    expect(settled).toMatchObject({ replayed: false, costVnd: '180000', releasedVnd: '220000', exception: false });
    expect(await counter(tenant.counterId)).toMatchObject({ settled: '480000.00000000', reserved: '0.00000000' });
    expect(await withTx((tx) => store.findReservation(tx, held.reservation.id))).toMatchObject({ status: 'SETTLED', settledAmount: '180000', releasedAmount: '220000' });

    // Another job is held, and the provider times out without a figure: the reservation stays held, and is not assumed to have cost nothing.
    const lost = await hold(TENANT_SCOPE, 100_000);
    expect(lost.kind).toBe('RESERVED');
    const pending = await withTx((tx) => store.markPendingReconcile(tx, (lost as Extract<ReserveResult, { kind: 'RESERVED' }>).reservation.id, 'provider timeout'));
    expect(pending).toMatchObject({ status: 'PENDING_RECONCILE', reconcileNote: 'provider timeout', reservedAmount: '100000' });
    expect(await counter(tenant.counterId)).toMatchObject({ settled: '480000.00000000', reserved: '100000.00000000' });
    // The hold goes on counting: the next request sees 420,000 left.
    expect(await hold(TENANT_SCOPE, 420_001)).toMatchObject({ kind: 'DENIED' });
    expect((await hold(TENANT_SCOPE, 420_000)).kind).toBe('RESERVED');
  });

  it('AC-ST-LLM-003-2: UAT-AC460 holds one of 20 simultaneous 50,000 jobs against a unit with 80,000 available, refuses 19 naming the UNIT, and finishes without a deadlock', async () => {
    await budget({ scopeKind: 'TENANT', limit: 10_000_000 });
    await budget({ scopeKind: 'UNIT', scopeRefId: unitId(BRANCH), limit: 80_000 });
    const requests = await Promise.all(Array.from({ length: 20 }, () => request()));
    const scopes = [
      { kind: 'UNIT' as const, ref: unitId(BRANCH) },
      { kind: 'TENANT' as const, ref: null },
    ];
    const results = await Promise.all(requests.map((id) => hold(scopes, 50_000, id)));
    expect(results.filter((result) => result.kind === 'RESERVED').length).toBe(1);
    const denied = results.filter((result) => result.kind === 'DENIED') as Array<Extract<ReserveResult, { kind: 'DENIED' }>>;
    expect(denied.length).toBe(19);
    expect(denied.every((result) => result.scope === 'UNIT' && result.reason === 'EXCEEDED')).toBe(true);
    // The tenant and the unit hold the same 50,000 and no more.
    const held = await app.rows<{ reserved: string }>('select reserved_open_vnd::text as reserved from machvon.ai_budget_counter order by reserved_open_vnd');
    expect(held.map((row) => row.reserved)).toEqual(['50000.00000000', '50000.00000000']);
    expect((await app.rows('select 1 from machvon.budget_reservation')).length).toBe(1);
  });

  it('AC-ST-LLM-003-2: UAT-AC460 serves requests that need the same counters in opposite orders without a deadlock, and holds none above the limit', async () => {
    const user = memberId(AI_ADMIN);
    await budget({ scopeKind: 'TENANT', limit: 1_000_000 });
    await budget({ scopeKind: 'UNIT', scopeRefId: unitId(BRANCH), limit: 600_000 });
    await budget({ scopeKind: 'USER', scopeRefId: user, limit: 500_000 });
    const requests = await Promise.all(Array.from({ length: 16 }, () => request()));
    const forward = [{ kind: 'TENANT' as const, ref: null }, { kind: 'UNIT' as const, ref: unitId(BRANCH) }, { kind: 'USER' as const, ref: user }];
    const backward = [...forward].reverse();
    const results = await Promise.all(requests.map((id, index) => hold(index % 2 === 0 ? forward : backward, 100_000, id)));
    // The user may have 500,000: five of 100,000 are held and the rest are refused for that scope.
    expect(results.filter((result) => result.kind === 'RESERVED').length).toBe(5);
    expect((results.filter((result) => result.kind === 'DENIED') as Array<Extract<ReserveResult, { kind: 'DENIED' }>>).every((result) => result.scope === 'USER')).toBe(true);
    const rows = await app.rows<{ reserved: string }>('select reserved_open_vnd::text as reserved from machvon.ai_budget_counter');
    expect(rows.map((row) => row.reserved)).toEqual(['500000.00000000', '500000.00000000', '500000.00000000']);
  });

  it('AC-ST-LLM-003-4: UAT-AC470 settles a provider request once: a second delivery, also one at the same moment, changes nothing and gives the first answer', async () => {
    const tenant = await budget({ scopeKind: 'TENANT', limit: 1_000_000 });
    const held = (await hold(TENANT_SCOPE, 200_000)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    const pricing = await dongPrice();
    const input = { reservationId: held.reservation.id, providerRequestId: 'callback-1', actualModel: 'dong', pricingVersionId: pricing, usage: { inputTotal: 180_000, cachedInput: 0, outputTotal: 0 }, actor: memberId(FINOPS) };
    const results = await Promise.all([withTx((tx) => store.settle(tx, input)), withTx((tx) => store.settle(tx, input))]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(results[0]!.attemptId).toBe(results[1]!.attemptId);
    expect(await counter(tenant.counterId)).toMatchObject({ settled: '180000.00000000', reserved: '0.00000000' });
    const later = await withTx((tx) => store.settle(tx, input));
    expect(later).toMatchObject({ replayed: true, costVnd: '180000' });
    expect(await counter(tenant.counterId)).toMatchObject({ settled: '180000.00000000' });
    expect((await app.rows('select 1 from machvon.llm_attempt where provider_request_id = $1', ['callback-1'])).length).toBe(1);
    expect((await events('llm.usage.settled.v1')).length).toBe(1);
    // A provider request id that belongs to one request is not answered as a repeat for another.
    const other = (await hold(TENANT_SCOPE, 1_000)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    await expect(withTx((tx) => store.settle(tx, { ...input, reservationId: other.reservation.id }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    expect(await withTx((tx) => store.findReservation(tx, other.reservation.id))).toMatchObject({ status: 'RESERVED' });
    // A different provider request whose usage comes after the request ended is real cost with no hold: it is charged to the counters, once.
    const lateInput = { ...input, providerRequestId: 'callback-2', usage: { inputTotal: 1_000, cachedInput: 0, outputTotal: 0 } };
    expect(await withTx((tx) => store.settle(tx, lateInput))).toMatchObject({ replayed: false, costVnd: '1000', releasedVnd: '0', exception: false });
    expect(await withTx((tx) => store.settle(tx, lateInput))).toMatchObject({ replayed: true, costVnd: '1000' });
    expect(await counter(tenant.counterId)).toMatchObject({ settled: '181000.00000000', reserved: '1000.00000000' });
  });

  it('AC-ST-LLM-003-5: AI02 keeps a timed out request held, takes its late usage once, and never overspends by the race of two requests at the end of a budget', async () => {
    const tenant = await budget({ scopeKind: 'TENANT', limit: 100_000, settled: 40_000 });
    const [a, b] = await Promise.all([hold(TENANT_SCOPE, 60_000), hold(TENANT_SCOPE, 60_000)]);
    expect([a.kind, b.kind].sort()).toEqual(['DENIED', 'RESERVED']);
    const held = (a.kind === 'RESERVED' ? a : b) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    await withTx((tx) => store.markPendingReconcile(tx, held.reservation.id, 'provider timeout'));
    // Still held: nothing else fits while the figure is missing.
    expect((await hold(TENANT_SCOPE, 1)).kind).toBe('DENIED');
    // The late invoice brings the usage; it settles the reservation once.
    const pricing = await dongPrice();
    const late = { reservationId: held.reservation.id, providerRequestId: 'late-invoice-1', actualModel: 'dong', pricingVersionId: pricing, usage: { inputTotal: 55_000, cachedInput: 0, outputTotal: 0 }, actor: memberId(FINOPS) };
    expect(await withTx((tx) => store.settle(tx, late))).toMatchObject({ replayed: false, costVnd: '55000', releasedVnd: '5000' });
    expect(await withTx((tx) => store.settle(tx, late))).toMatchObject({ replayed: true });
    expect(await counter(tenant.counterId)).toMatchObject({ settled: '95000.00000000', reserved: '0.00000000' });
    expect((await app.rows('select 1 from machvon.llm_attempt')).length).toBe(1);
    const left = await hold(TENANT_SCOPE, 5_000);
    expect(left.kind).toBe('RESERVED');
    expect((await hold(TENANT_SCOPE, 1)).kind).toBe('DENIED');
  });

  it('AC-ST-LLM-003-6, AC-ST-KERNEL-046-3: UAT-AC469, UAT-NFR-AI-03 sends the event of the soft threshold once when a settlement crosses 80 percent, refuses a 250,000 estimate above 190,000, and asks for an approval when the budget does not stop', async () => {
    const projectId = await project();
    const tenant = await budget({ scopeKind: 'TENANT', limit: 5_000_000 });
    const scoped = await budget({ scopeKind: 'PROJECT', scopeRefId: projectId, limit: 1_000_000, settled: 790_000 });
    void tenant;
    const scopes = [{ kind: 'PROJECT' as const, ref: projectId }];
    const pricing = await dongPrice();
    const settle = async (estimate: number, tokens: number, key: string) => {
      const held = (await hold(scopes, estimate)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
      expect(held.kind).toBe('RESERVED');
      return withTx((tx) => store.settle(tx, { reservationId: held.reservation.id, providerRequestId: key, actualModel: 'dong', pricingVersionId: pricing, usage: { inputTotal: tokens, cachedInput: 0, outputTotal: 0 }, actor: memberId(FINOPS) }));
    };
    expect(await settle(20_000, 20_000, 'p-1')).toMatchObject({ thresholdCrossed: true });
    expect((await events('llm.budget.threshold_reached.v1')).length).toBe(1);
    expect((await events('llm.budget.threshold_reached.v1'))[0]?.payload).toMatchObject({ budget_id: scoped.id, scope_kind: 'PROJECT', threshold_pct: 80 });
    // Further settlements above the line do not send it again.
    expect(await settle(5_000, 5_000, 'p-2')).toMatchObject({ thresholdCrossed: false });
    expect((await events('llm.budget.threshold_reached.v1')).length).toBe(1);
    // 1,000,000 − 815,000 settled leaves 185,000: a 250,000 estimate does not fit.
    expect(await counter(scoped.counterId)).toMatchObject({ settled: '815000.00000000' });
    expect(await hold(scopes, 250_000)).toMatchObject({ kind: 'DENIED', scope: 'PROJECT', shortByVnd: '65000' });

    // A budget that does not stop asks for a decision of a person instead of the call.
    const user = memberId(AI_ADMIN);
    const soft = await budget({ scopeKind: 'USER', scopeRefId: user, limit: 100_000, hardStop: false });
    const asked = await hold([{ kind: 'USER' as const, ref: user }], 150_000);
    expect(asked).toEqual({ kind: 'APPROVAL_REQUIRED', scope: 'USER', budgetId: soft.id, shortByVnd: '50000' });
    expect((await app.rows('select 1 from machvon.budget_reservation where status = $1', ['RESERVED'])).length).toBe(0);
    expect(await counter(soft.counterId)).toMatchObject({ reserved: '0.00000000' });
  });

  it('holds a request once: a repeat of the admission, also at the same moment, finds the hold it made, and one that was released is not held again', async () => {
    const tenant = await budget({ scopeKind: 'TENANT', limit: 1_000_000 });
    const id = await request();
    const results = await Promise.all([hold(TENANT_SCOPE, 300_000, id), hold(TENANT_SCOPE, 300_000, id), hold(TENANT_SCOPE, 300_000, id)]);
    expect(results.every((result) => result.kind === 'RESERVED')).toBe(true);
    expect(new Set(results.map((result) => (result as Extract<ReserveResult, { kind: 'RESERVED' }>).reservation.id)).size).toBe(1);
    expect(await counter(tenant.counterId)).toMatchObject({ reserved: '300000.00000000' });
    expect((await app.rows('select 1 from machvon.budget_reservation')).length).toBe(1);
    const held = (results[0] as Extract<ReserveResult, { kind: 'RESERVED' }>).reservation;
    await withTx((tx) => store.release(tx, held.id, 'cancelled'));
    await expect(hold(TENANT_SCOPE, 300_000, id)).rejects.toMatchObject({ code: 'RESERVATION_NOT_ACTIVE' });
    expect(await counter(tenant.counterId)).toMatchObject({ reserved: '0.00000000' });
    await expect(app.rows("insert into machvon.budget_reservation (tenant_id, id, request_id, scope_json, reserved_amount, currency, status, expires_at) values ($1, $2, $3, '[]'::jsonb, 1, 'VND', 'RESERVED', now())", [TENANT_A, randomUUID(), id])).rejects.toThrow(/budget_reservation_request_uq/);
  });

  it('settles a request that needed a retry and a fallback attempt by attempt: each cost leaves the hold, which stays open until the last attempt, and then what is left is released', async () => {
    const tenant = await budget({ scopeKind: 'TENANT', limit: 1_000_000 });
    const held = (await hold(TENANT_SCOPE, 400_000)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    const pricing = await dongPrice();
    const attempt = (key: string, tokens: number, kind: 'PRIMARY' | 'RETRY' | 'FALLBACK', no: number, final: boolean) =>
      withTx((tx) => store.settle(tx, { reservationId: held.reservation.id, providerRequestId: key, actualModel: 'dong', pricingVersionId: pricing, usage: { inputTotal: tokens, cachedInput: 0, outputTotal: 0 }, attemptKind: kind, attemptNo: no, final, actor: memberId(FINOPS) }));
    expect(await attempt('a-1', 100_000, 'PRIMARY', 1, false)).toMatchObject({ costVnd: '100000', releasedVnd: '0', exception: false });
    expect(await counter(tenant.counterId)).toMatchObject({ settled: '100000.00000000', reserved: '300000.00000000' });
    expect(await withTx((tx) => store.findReservation(tx, held.reservation.id))).toMatchObject({ status: 'RESERVED', settledAmount: '100000', releasedAmount: null });
    expect(await attempt('a-2', 50_000, 'RETRY', 2, false)).toMatchObject({ costVnd: '50000', releasedVnd: '0' });
    // The retry arrives twice: it is not charged twice.
    expect(await attempt('a-2', 50_000, 'RETRY', 2, false)).toMatchObject({ replayed: true, costVnd: '50000', releasedVnd: '0', exception: false });
    expect(await counter(tenant.counterId)).toMatchObject({ settled: '150000.00000000', reserved: '250000.00000000' });
    expect(await attempt('a-3', 100_000, 'FALLBACK', 3, true)).toMatchObject({ costVnd: '100000', releasedVnd: '150000', exception: false });
    expect(await counter(tenant.counterId)).toMatchObject({ settled: '250000.00000000', reserved: '0.00000000' });
    expect(await withTx((tx) => store.findReservation(tx, held.reservation.id))).toMatchObject({ status: 'SETTLED', settledAmount: '250000', releasedAmount: '150000' });
    expect((await app.rows<{ attempt_kind: string; attempt_no: number }>('select attempt_kind, attempt_no from machvon.llm_attempt order by attempt_no')).map((row) => [row.attempt_kind, row.attempt_no])).toEqual([['PRIMARY', 1], ['RETRY', 2], ['FALLBACK', 3]]);
    // A delivery of an early attempt after the request has ended gives the answer it was given then, not the release of the last one, also when the events are gone.
    await app.rows("delete from machvon.outbox_event where type = 'llm.usage.settled.v1'");
    expect(await attempt('a-2', 50_000, 'RETRY', 2, false)).toMatchObject({ replayed: true, costVnd: '50000', releasedVnd: '0', exception: false });
    expect(await attempt('a-3', 100_000, 'FALLBACK', 3, true)).toMatchObject({ replayed: true, releasedVnd: '150000' });
    // The request has ended; the usage of an attempt that had timed out arrives now: it is real cost, charged without a hold, and nothing is released twice.
    expect(await attempt('a-4', 7_000, 'PRIMARY', 4, true)).toMatchObject({ costVnd: '7000', releasedVnd: '0', exception: false });
    expect(await counter(tenant.counterId)).toMatchObject({ settled: '257000.00000000', reserved: '0.00000000' });
    expect(await withTx((tx) => store.findReservation(tx, held.reservation.id))).toMatchObject({ status: 'SETTLED', settledAmount: '257000', releasedAmount: '150000' });
  });

  it('releases only what is left of a hold whose first attempts were settled, and gives the replay of the attempt that crossed the soft line its own answer', async () => {
    const tenant = await budget({ scopeKind: 'TENANT', limit: 1_000_000, settled: 790_000 });
    const other = (await hold(TENANT_SCOPE, 50_000)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    const held = (await hold(TENANT_SCOPE, 100)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    const pricing = await dongPrice();
    const crossing = { reservationId: other.reservation.id, providerRequestId: 'cross-1', actualModel: 'dong', pricingVersionId: pricing, usage: { inputTotal: 20_000, cachedInput: 0, outputTotal: 0 }, final: false, actor: memberId(FINOPS) };
    expect(await withTx((tx) => store.settle(tx, crossing))).toMatchObject({ thresholdCrossed: true });
    expect(await withTx((tx) => store.settle(tx, crossing))).toMatchObject({ replayed: true, thresholdCrossed: true });
    // 30 of a hold of 100 are used by an attempt; the request is then cancelled: the 70 that are left go back, not 100.
    await withTx((tx) => store.settle(tx, { reservationId: held.reservation.id, providerRequestId: 'part-1', actualModel: 'dong', pricingVersionId: pricing, usage: { inputTotal: 30, cachedInput: 0, outputTotal: 0 }, final: false, actor: memberId(FINOPS) }));
    expect(await counter(tenant.counterId)).toMatchObject({ settled: '810030.00000000', reserved: '30070.00000000' });
    const released = await withTx((tx) => store.release(tx, held.reservation.id, 'the request was cancelled after the first attempt'));
    expect(released).toMatchObject({ status: 'RELEASED', releasedAmount: '70' });
    // The hold of the other request is whole: 50,000 less the 20,000 its first attempt used.
    expect(await counter(tenant.counterId)).toMatchObject({ settled: '810030.00000000', reserved: '30000.00000000' });
  });

  it('blocks only the counter a late cost goes over, not the other budgets of the request, and keeps the exception a reservation already had when a small late cost comes', async () => {
    const month = await budget({ scopeKind: 'TENANT', limit: 1_000, settled: 800 });
    const yearly = await withTx((tx) => store.createBudget(tx, { scopeKind: 'TENANT', scopeRefId: null, period: 'YEAR', limitVnd: '1000000', softThresholdPct: 80, hardStop: true, maxRequestsPerDay: null, maxConcurrent: null, effectiveFrom: '2026-01-01', actor: memberId(FINOPS) }));
    const yearCounter = randomUUID();
    await app.rows('insert into machvon.ai_budget_counter (tenant_id, id, budget_id, period_start, limit_vnd, settled_vnd) values ($1, $2, $3, $4::date, 1000000, 0)', [TENANT_A, yearCounter, yearly.id, periodStartOf('YEAR', TODAY)]);
    const held = (await hold(TENANT_SCOPE, 100)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    const pricing = await dongPrice();
    const attempt = (key: string, tokens: number, final: boolean) =>
      withTx((tx) => store.settle(tx, { reservationId: held.reservation.id, providerRequestId: key, actualModel: 'dong', pricingVersionId: pricing, usage: { inputTotal: tokens, cachedInput: 0, outputTotal: 0 }, final, actor: memberId(FINOPS) }));
    // 150 against a hold of 100 under limits that are not reached: an exception of the reservation, whose counters are blocked as the design says.
    expect(await attempt('e-1', 150, true)).toMatchObject({ exception: true });
    expect(await withTx((tx) => store.findReservation(tx, held.reservation.id))).toMatchObject({ status: 'EXCEPTION' });
    // A late 10 is not an exception of its own and does not make the reservation look as if nothing had gone over.
    expect(await attempt('e-2', 10, true)).toMatchObject({ exception: false });
    expect(await withTx((tx) => store.findReservation(tx, held.reservation.id))).toMatchObject({ status: 'EXCEPTION', settledAmount: '160' });
    // A late 300 takes the month (960 + 300 of 1,000) over: it is counted there, and not again at the year, which it did not go over (its one exception is the first).
    expect(await attempt('e-3', 300, true)).toMatchObject({ exception: true });
    expect(await counter(month.counterId)).toMatchObject({ exceptions: 2, blocked: true });
    expect(await counter(yearCounter)).toMatchObject({ settled: '460.00000000' });
    expect(await counter(yearCounter)).toMatchObject({ exceptions: 1 });
  });

  it('calls a late cost that no longer fits in the limit an exception, and blocks the scope, but still charges it', async () => {
    const tenant = await budget({ scopeKind: 'TENANT', limit: 1_000, settled: 600 });
    const held = (await hold(TENANT_SCOPE, 300)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    const pricing = await dongPrice();
    const attempt = (key: string, tokens: number, final: boolean) =>
      withTx((tx) => store.settle(tx, { reservationId: held.reservation.id, providerRequestId: key, actualModel: 'dong', pricingVersionId: pricing, usage: { inputTotal: tokens, cachedInput: 0, outputTotal: 0 }, final, actor: memberId(FINOPS) }));
    await attempt('l-1', 100, true);
    // 700 settled, nothing held; a late 400 takes the total to 1,100 of 1,000.
    expect(await attempt('l-2', 400, true)).toMatchObject({ costVnd: '400', exception: true });
    expect(await counter(tenant.counterId)).toMatchObject({ settled: '1100.00000000', reserved: '0.00000000', exceptions: 1, blocked: true });
    expect(await hold(TENANT_SCOPE, 1)).toMatchObject({ kind: 'DENIED', reason: 'BLOCKED' });
  });

  it('calls the attempts of a request that together go over the hold an exception at the one that goes over, and blocks the scope', async () => {
    const tenant = await budget({ scopeKind: 'TENANT', limit: 1_000_000 });
    const held = (await hold(TENANT_SCOPE, 100)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    const pricing = await dongPrice();
    const attempt = (key: string, tokens: number, final: boolean) =>
      withTx((tx) => store.settle(tx, { reservationId: held.reservation.id, providerRequestId: key, actualModel: 'dong', pricingVersionId: pricing, usage: { inputTotal: tokens, cachedInput: 0, outputTotal: 0 }, final, actor: memberId(FINOPS) }));
    expect(await attempt('o-1', 60, false)).toMatchObject({ exception: false });
    expect(await attempt('o-2', 60, false)).toMatchObject({ exception: true, costVnd: '60' });
    expect(await counter(tenant.counterId)).toMatchObject({ settled: '120.00000000', reserved: '0.00000000', exceptions: 1, blocked: true });
    expect(await withTx((tx) => store.findReservation(tx, held.reservation.id))).toMatchObject({ status: 'EXCEPTION', settledAmount: '120' });
  });

  it('calls an actual cost above the reservation an exception: the numbers stand, the scope is blocked and the next request is refused for it', async () => {
    const tenant = await budget({ scopeKind: 'TENANT', limit: 1_000_000 });
    const held = (await hold(TENANT_SCOPE, 100)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    const pricing = await dongPrice();
    const done = await withTx((tx) => store.settle(tx, { reservationId: held.reservation.id, providerRequestId: 'over-1', actualModel: 'dong', pricingVersionId: pricing, usage: { inputTotal: 150, cachedInput: 0, outputTotal: 0 }, actor: memberId(FINOPS) }));
    expect(done).toMatchObject({ exception: true, costVnd: '150', releasedVnd: '0' });
    expect(await counter(tenant.counterId)).toMatchObject({ settled: '150.00000000', reserved: '0.00000000', exceptions: 1, blocked: true });
    expect(await withTx((tx) => store.findReservation(tx, held.reservation.id))).toMatchObject({ status: 'EXCEPTION', settledAmount: '150' });
    expect(await hold(TENANT_SCOPE, 1)).toMatchObject({ kind: 'DENIED', scope: 'TENANT', reason: 'BLOCKED' });
  });

  it('releases a reservation that will never be settled, on a reason, and not one that is settled', async () => {
    const tenant = await budget({ scopeKind: 'TENANT', limit: 1_000_000 });
    const held = (await hold(TENANT_SCOPE, 300_000)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    const released = await withTx((tx) => store.release(tx, held.reservation.id, 'the request was cancelled before it was sent'));
    expect(released).toMatchObject({ status: 'RELEASED', releasedAmount: '300000', reconcileNote: 'the request was cancelled before it was sent' });
    expect(await counter(tenant.counterId)).toMatchObject({ reserved: '0.00000000' });
    await expect(withTx((tx) => store.release(tx, held.reservation.id, 'again'))).rejects.toMatchObject({ code: 'RESERVATION_NOT_ACTIVE' });
  });

  it('puts a reservation past its end in PENDING_RECONCILE, keeps its hold, reports the age of the oldest, and finds nothing the second time', async () => {
    const tenant = await budget({ scopeKind: 'TENANT', limit: 1_000_000 });
    const lapsed = (await hold(TENANT_SCOPE, 100_000, undefined, -60_000)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    const open = (await hold(TENANT_SCOPE, 50_000)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    const first = await withTx((tx) => store.expireDue(tx, new Date()));
    expect(first.expired).toBe(1);
    expect(first.oldestAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(await withTx((tx) => store.findReservation(tx, lapsed.reservation.id))).toMatchObject({ status: 'PENDING_RECONCILE', reconcileNote: 'TIMEOUT_NO_USAGE' });
    expect((await withTx((tx) => store.findReservation(tx, open.reservation.id)))?.status).toBe('RESERVED');
    expect(await counter(tenant.counterId)).toMatchObject({ reserved: '150000.00000000' });
    expect((await withTx((tx) => store.expireDue(tx, new Date()))).expired).toBe(0);
  });

  it('holds a scope that is named twice once: the estimate is held, counted and settled one time', async () => {
    const tenant = await budget({ scopeKind: 'TENANT', limit: 1_000_000 });
    const held = await hold([...TENANT_SCOPE, ...TENANT_SCOPE, { kind: 'TENANT', ref: null }], 100_000);
    expect(held.kind).toBe('RESERVED');
    expect((held as Extract<ReserveResult, { kind: 'RESERVED' }>).reservation.scope.length).toBe(1);
    expect(await counter(tenant.counterId)).toMatchObject({ reserved: '100000.00000000' });
    expect((await app.rows<{ n: number }>('select request_count as n from machvon.ai_budget_counter'))[0]?.n).toBe(1);
  });

  it('holds a request against every budget of a scope, a month and a year alike, and settles into both', async () => {
    const month = await budget({ scopeKind: 'TENANT', limit: 1_000_000 });
    const yearly = await withTx((tx) =>
      store.createBudget(tx, { scopeKind: 'TENANT', scopeRefId: null, period: 'YEAR', limitVnd: '5000000', softThresholdPct: 80, hardStop: true, maxRequestsPerDay: null, maxConcurrent: null, effectiveFrom: '2026-01-01', actor: memberId(FINOPS) }),
    );
    const yearCounter = randomUUID();
    await app.rows('insert into machvon.ai_budget_counter (tenant_id, id, budget_id, period_start, limit_vnd, settled_vnd) values ($1, $2, $3, $4::date, 5000000, 4700000)', [TENANT_A, yearCounter, yearly.id, periodStartOf('YEAR', TODAY)]);
    // 300,000 are left for the year and 1,000,000 for the month: the year is the ceiling.
    expect(await hold(TENANT_SCOPE, 400_000)).toMatchObject({ kind: 'DENIED', scope: 'TENANT', shortByVnd: '100000' });
    const held = (await hold(TENANT_SCOPE, 250_000)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    expect(held.kind).toBe('RESERVED');
    expect(held.reservation.scope.map((entry) => entry.budgetId).sort()).toEqual([month.id, yearly.id].sort());
    expect(await counter(month.counterId)).toMatchObject({ reserved: '250000.00000000' });
    expect(await counter(yearCounter)).toMatchObject({ reserved: '250000.00000000' });
    const pricing = await dongPrice();
    await withTx((tx) => store.settle(tx, { reservationId: held.reservation.id, providerRequestId: 'both-1', actualModel: 'dong', pricingVersionId: pricing, usage: { inputTotal: 200_000, cachedInput: 0, outputTotal: 0 }, actor: memberId(FINOPS) }));
    expect(await counter(month.counterId)).toMatchObject({ settled: '200000.00000000', reserved: '0.00000000' });
    expect(await counter(yearCounter)).toMatchObject({ settled: '4900000.00000000', reserved: '0.00000000' });
    // 100,000 are left for the year: a month with room does not let a request through.
    expect(await hold(TENANT_SCOPE, 100_001)).toMatchObject({ kind: 'DENIED', scope: 'TENANT' });
  });

  it('holds and settles against a limit of the full width of the column, 24 digits, as it does against a small one', async () => {
    const huge = '999999999999999999999999';
    const made = await createBudget({ scope_kind: 'TENANT', limit_vnd: huge });
    expect(made.status).toBe(200);
    const held = await hold(TENANT_SCOPE, 1);
    expect(held.kind).toBe('RESERVED');
    const left = await app.call('GET', '/ai-budgets', { member: FINOPS });
    expect(((left.json.items as Array<Record<string, any>>)[0]?.counter as Record<string, string>).available_vnd).toBe('999999999999999999999998'); // eslint-disable-line @typescript-eslint/no-explicit-any
    // A hold of more than 16 digits is kept: the columns are as wide as the limit.
    const wide = await hold(TENANT_SCOPE, 10_000_000_000_000_000n as unknown as number);
    expect(wide.kind).toBe('RESERVED');
    const heldWide = (await app.rows<{ reserved: string }>('select reserved_open_vnd::text as reserved from machvon.ai_budget_counter'))[0]!;
    expect(heldWide.reserved).toBe('10000000000000001.00000000');
    // One more than there is left is refused by the number, not by a parser.
    expect(await hold(TENANT_SCOPE, 999_999_999_999_999_999_999_999n as unknown as number)).toMatchObject({ kind: 'DENIED', scope: 'TENANT' });
  });

  it('does not limit a request by a scope that has no budget, and counts the period of the day', async () => {
    const free = await hold([{ kind: 'UNIT', ref: unitId(BRANCH) }], 999_999_999);
    expect(free.kind).toBe('RESERVED');
    expect((await app.rows('select 1 from machvon.ai_budget_counter')).length).toBe(0);
    await budget({ scopeKind: 'TENANT', limit: 1_000 });
    const periods = await app.rows<{ period_start: string }>('select period_start::text from machvon.ai_budget_counter');
    expect(periods[0]?.period_start).toBe(THIS_MONTH);
  });
});

describe('the price versions of the models (ST-LLM-003, LLM BR-LLM-13)', () => {
  it('AC-ST-LLM-003-3: UAT-AC461 costs an attempt of 120,000 input of which 100,000 cached, and 10,000 output, at 2.00, 0.50 and 8.00 per million and 25,400 dong to the dollar, as 0.17 USD and 4,318 VND', async () => {
    const ref = await model('priced-model');
    const made = await registerPrice(price(ref, 'priced-model'));
    expect([made.status, made.json.status]).toEqual([200, 'IN_FORCE']);
    const tenant = await budget({ scopeKind: 'TENANT', limit: 1_000_000 });
    const held = (await hold(TENANT_SCOPE, 5_000)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    const settled = await withTx((tx) => store.settle(tx, { reservationId: held.reservation.id, providerRequestId: 'usd-1', actualModel: 'priced-model', pricingVersionId: made.json.resource_id as string, usage: { inputTotal: 120_000, cachedInput: 100_000, outputTotal: 10_000 }, actor: memberId(FINOPS) }));
    expect(settled).toMatchObject({ costVnd: '4318', releasedVnd: '682' });
    const attempt = (await app.rows<{ cost: string; cost_vnd: string; noncached_input: string; fx_rate_to_vnd: string; currency: string }>('select cost::text, cost_vnd::text, noncached_input::text, fx_rate_to_vnd::text, currency from machvon.llm_attempt'))[0]!;
    expect(attempt).toMatchObject({ cost: '0.17000000', cost_vnd: '4318', noncached_input: '20000', currency: 'USD' });
    expect(await counter(tenant.counterId)).toMatchObject({ settled: '4318.00000000' });

    // The same figure when the price counts the cached tokens apart and the attempt reports 20,000 + 100,000.
    const apartRef = await model('apart-model');
    const apart = await registerPrice(price(apartRef, 'apart-model', { cached_semantics: 'SEPARATE' }));
    const second = (await hold(TENANT_SCOPE, 5_000)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    const again = await withTx((tx) => store.settle(tx, { reservationId: second.reservation.id, providerRequestId: 'usd-2', actualModel: 'apart-model', pricingVersionId: apart.json.resource_id as string, usage: { inputTotal: 20_000, cachedInput: 100_000, outputTotal: 10_000 }, actor: memberId(FINOPS) }));
    expect(again.costVnd).toBe('4318');
  });

  it('AC-ST-LLM-003-3: UAT-AC461 refuses a price version that overlaps the one in force with 409 PRICING_RANGE_OVERLAP, and ends the one in force where the next begins', async () => {
    const ref = await model('priced-model');
    const first = await registerPrice(price(ref, 'priced-model'));
    expect(first.status).toBe(200);
    for (const from of ['2026-01-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z']) {
      const overlap = await registerPrice(price(ref, 'priced-model', { effective_from: from }));
      expect([overlap.status, overlap.json.code]).toEqual([409, 'PRICING_RANGE_OVERLAP']);
    }
    const next = await registerPrice(price(ref, 'priced-model', { effective_from: '2026-07-01T00:00:00.000Z', input_per_million: '3.00' }));
    expect(next.status).toBe(200);
    const rows = await app.rows<{ effective_from: Date; effective_until: Date | null }>('select effective_from, effective_until from machvon.pricing_version order by effective_from');
    expect(rows.map((row) => [row.effective_from.toISOString(), row.effective_until?.toISOString() ?? null])).toEqual([
      ['2026-01-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'],
      ['2026-07-01T00:00:00.000Z', null],
    ]);
    // The price of a moment is the one in force then.
    expect((await withTx((tx) => store.priceAt(tx, ref, new Date('2026-03-01T00:00:00Z'))))?.inputPerMillion).toBe('2.00000000');
    expect((await withTx((tx) => store.priceAt(tx, ref, new Date('2026-08-01T00:00:00Z'))))?.inputPerMillion).toBe('3.00000000');
    expect(await withTx((tx) => store.priceAt(tx, ref, new Date('2025-01-01T00:00:00Z')))).toBeUndefined();
    // The database says the same to a write that skips the service.
    await expect(app.rows(`insert into machvon.pricing_version (tenant_id, id, provider, model_id, currency, effective_from, input_per_million, cached_per_million, output_per_million, source_url, model_ref_id) values ($1, $2, 'p', 'priced-model', 'USD', now(), 1, 1, 1, 'https://x.example/p', $3)`, [TENANT_A, randomUUID(), ref])).rejects.toThrow(/pricing_version_open_uq/);
  });

  it('asks a price for its source, a model that is there with the name it has, rates that are numbers, and an exchange rate above zero; and says that nobody has verified it yet', async () => {
    const ref = await model('priced-model');
    expect((await registerPrice(price(ref, 'priced-model', { source_url: 'pricing page' }))).json.code).toBe('SOURCE_URL_REQUIRED');
    expect((await registerPrice(price(randomUUID(), 'priced-model'))).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'model_ref_id' });
    expect((await registerPrice(price(ref, 'another-name'))).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'model_ref_id' });
    expect((await registerPrice(price(ref, 'priced-model', { input_per_million: '-1.00' }))).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'input_per_million' });
    expect((await registerPrice(price(ref, 'priced-model', { fx_rate_to_vnd: '0' }))).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'fx_rate_to_vnd' });
    expect((await registerPrice(price(ref, 'priced-model', { currency: 'usd' }))).status).toBeGreaterThanOrEqual(400);
    expect((await registerPrice(price(ref, 'priced-model', { verified_by: randomUUID() }))).json.code).toBe('FIELD_NOT_ALLOWED');
    expect((await registerPrice(price(ref, 'priced-model'))).status).toBe(200);
    const listed = await app.call('GET', '/ai-pricing-versions', { member: FINOPS });
    expect((listed.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ model_id: 'priced-model', source_url: 'https://provider.example/pricing', cached_semantics: 'INCLUDED_IN_INPUT', verified: false, verified_by: null });
    expect((await events('llm.pricing.registered.v1')).length).toBe(1);
  });
});

describe('the budgets, the spend and the reservations over HTTP (ST-LLM-003, LLM-07, LLM-08, LLM-09)', () => {
  it('creates budgets by scope and period, refuses a second for the same scope and one above or below its parent, and lists them with their counters', async () => {
    const tenant = await createBudget({ scope_kind: 'TENANT', limit_vnd: '1000000' });
    expect([tenant.status, tenant.json.status]).toEqual([200, 'ACTIVE']);
    expect((await createBudget({ scope_kind: 'TENANT', limit_vnd: '5' })).json.code).toBe('BUDGET_SCOPE_DUPLICATE');
    const child = await createBudget({ scope_kind: 'UNIT', scope_ref_id: unitId(BRANCH), limit_vnd: '600000', soft_threshold_pct: 90, max_concurrent: 4 });
    expect(child.status).toBe(200);
    expect((await createBudget({ scope_kind: 'UNIT', scope_ref_id: unitId(BRANCH), limit_vnd: '1' })).json.code).toBe('BUDGET_SCOPE_DUPLICATE');
    expect((await createBudget({ scope_kind: 'UNIT', scope_ref_id: unitId(ROOT), limit_vnd: '1000001' })).json).toMatchObject({ code: 'CHILD_EXCEEDS_PARENT', detail: 'limit_vnd' });
    expect((await createBudget({ scope_kind: 'UNIT', scope_ref_id: unitId(ROOT), limit_vnd: '1000000' })).status).toBe(200);
    // A year budget has its own parent: a tenant budget for the year is not there, so nothing limits it.
    expect((await createBudget({ scope_kind: 'PROJECT', scope_ref_id: await project(), period: 'YEAR', limit_vnd: '99999999' })).status).toBe(200);
    // The parent cannot be set below what a child already may spend.
    await app.rows("update machvon.ai_budget set status = 'RETIRED' where scope_kind = 'TENANT'");
    expect((await createBudget({ scope_kind: 'TENANT', limit_vnd: '500000' })).json).toMatchObject({ code: 'CHILD_EXCEEDS_PARENT' });
    expect((await createBudget({ scope_kind: 'TENANT', limit_vnd: '1000000' })).status).toBe(200);

    const listed = await app.call('GET', '/ai-budgets', { member: FINOPS });
    const items = listed.json.items as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(items.map((item) => [item.scope_kind, item.period])).toEqual([['TENANT', 'MONTH'], ['TENANT', 'MONTH'], ['UNIT', 'MONTH'], ['UNIT', 'MONTH'], ['PROJECT', 'YEAR']]);
    expect(items.find((item) => item.max_concurrent === 4)).toMatchObject({ soft_threshold_pct: 90, hard_stop: true, counter: null });
    expect((await events('llm.budget.created.v1')).length).toBe(5);
  });

  it('refuses a scope that is not what its kind says, a reference that is not there, and limits that are not numbers', async () => {
    expect((await createBudget({ scope_kind: 'TENANT', scope_ref_id: unitId(ROOT), limit_vnd: '10' })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'scope_ref_id' });
    expect((await createBudget({ scope_kind: 'UNIT', limit_vnd: '10' })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'scope_ref_id' });
    expect((await createBudget({ scope_kind: 'UNIT', scope_ref_id: randomUUID(), limit_vnd: '10' })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'scope_ref_id' });
    expect((await createBudget({ scope_kind: 'TENANT', limit_vnd: '-10' })).status).toBeGreaterThanOrEqual(400);
    expect((await createBudget({ scope_kind: 'TENANT', limit_vnd: '10', soft_threshold_pct: 0 })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'soft_threshold_pct' });
    expect((await createBudget({ scope_kind: 'TENANT', limit_vnd: '10', settled_vnd: '5' })).json.code).toBe('FIELD_NOT_ALLOWED');
    await expect(app.rows(`insert into machvon.ai_budget (tenant_id, id, scope_kind, scope_ref_id, period, limit_vnd, effective_from, created_by, updated_by) values ($1, $2, 'TENANT', $3, 'MONTH', 1, now(), $4, $4)`, [TENANT_A, randomUUID(), unitId(ROOT), memberId(FINOPS)])).rejects.toThrow(/ai_budget_scope_chk/);
  });

  it('LLM-07 and LLM-09: lists the counter of this month with what is settled, held and left, and gives the spend of a budget with the cached and uncached input apart', async () => {
    const made = await createBudget({ scope_kind: 'TENANT', limit_vnd: '1000000' });
    const id = made.json.resource_id as string;
    const held = (await hold(TENANT_SCOPE, 50_000)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    const ref = await model('priced-model');
    const priced = await registerPrice(price(ref, 'priced-model'));
    await withTx((tx) => store.settle(tx, { reservationId: held.reservation.id, providerRequestId: 'usd-1', actualModel: 'priced-model', pricingVersionId: priced.json.resource_id as string, usage: { inputTotal: 120_000, cachedInput: 100_000, outputTotal: 10_000 }, actor: memberId(FINOPS) }));
    const pending = (await hold(TENANT_SCOPE, 30_000)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    await withTx((tx) => store.markPendingReconcile(tx, pending.reservation.id, 'provider timeout'));

    const listed = await app.call('GET', '/ai-budgets', { member: FINOPS });
    expect((listed.json.items as Array<Record<string, any>>)[0]?.counter).toMatchObject({ settled_vnd: '4318', reserved_open_vnd: '30000', available_vnd: '965682', request_count: 2, blocked: false }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const spend = await app.call('GET', `/ai-budgets/${id}/spend`, { member: FINOPS });
    expect(spend.status).toBe(200);
    expect(spend.json.current).toEqual({ attempts: 1, input_total: '120000', cached_input: '100000', noncached_input: '20000', output_total: '10000', cost_vnd: '4318', pending_reconcile: 1 });
    expect((spend.json.periods as unknown[]).length).toBe(1);
    expect((spend.json.budget as Record<string, any>).counter).toMatchObject({ settled_vnd: '4318' }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await app.call('GET', `/ai-budgets/${randomUUID()}/spend`, { member: FINOPS })).status).toBe(404);
    expect((await app.call('GET', '/ai-budgets/not-a-uuid/spend', { member: FINOPS })).status).toBeGreaterThanOrEqual(400);
  });

  it('reads the reservations: by status, by request and by id, without the counters they are held in', async () => {
    await createBudget({ scope_kind: 'TENANT', limit_vnd: '1000000' });
    const one = (await hold(TENANT_SCOPE, 10_000)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    const two = (await hold(TENANT_SCOPE, 20_000)) as Extract<ReserveResult, { kind: 'RESERVED' }>;
    await withTx((tx) => store.markPendingReconcile(tx, two.reservation.id, 'provider timeout'));
    const all = await app.call('GET', '/resources/budget_reservation', { member: FINOPS });
    expect((all.json.items as unknown[]).length).toBe(2);
    const pending = await app.call('GET', '/resources/budget_reservation?status=PENDING_RECONCILE', { member: FINOPS });
    expect((pending.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([two.reservation.id]);
    const byRequest = await app.call('GET', `/resources/budget_reservation?request_id=${one.reservation.requestId}`, { member: FINOPS });
    expect((byRequest.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([one.reservation.id]);
    expect((await app.call('GET', '/resources/budget_reservation?status=GONE', { member: FINOPS })).status).toBe(422);
    const view = await app.call('GET', `/resources/budget_reservation/${one.reservation.id}`, { member: FINOPS });
    expect(view.json).toMatchObject({ id: one.reservation.id, status: 'RESERVED', reserved_amount: '10000', currency: 'VND', scope: [{ kind: 'TENANT', ref: null }] });
    expect(JSON.stringify(view.json)).not.toContain('counter');
    expect((await app.call('GET', `/resources/budget_reservation/${randomUUID()}`, { member: FINOPS })).status).toBe(404);
  });

  it('gives the reservations a page at a time, newest first, with a cursor, so that no record is out of reach', async () => {
    await createBudget({ scope_kind: 'TENANT', limit_vnd: '100000000' });
    const made: string[] = [];
    for (let index = 0; index < 5; index += 1) made.push(((await hold(TENANT_SCOPE, 1_000 + index)) as Extract<ReserveResult, { kind: 'RESERVED' }>).reservation.id);
    const first = await app.call('GET', '/resources/budget_reservation?limit=2', { member: FINOPS });
    expect(first.status).toBe(200);
    const firstIds = (first.json.items as Array<{ id: string }>).map((item) => item.id);
    expect(firstIds).toEqual([made[4], made[3]]);
    expect(typeof first.json.next_cursor).toBe('string');
    const second = await app.call('GET', `/resources/budget_reservation?limit=2&cursor=${first.json.next_cursor as string}`, { member: FINOPS });
    expect((second.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([made[2], made[1]]);
    const third = await app.call('GET', `/resources/budget_reservation?limit=2&cursor=${second.json.next_cursor as string}`, { member: FINOPS });
    expect((third.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([made[0]]);
    expect(third.json.next_cursor).toBeNull();
    expect((await app.call('GET', '/resources/budget_reservation?cursor=not-a-cursor', { member: FINOPS })).status).toBe(422);
    // A well formed cursor whose key is not a moment is refused as a cursor, not left to the database.
    const forged = encodeCursor({ code: 'yesterday', id: made[0] as string });
    const refused = await app.call('GET', `/resources/budget_reservation?cursor=${forged}`, { member: FINOPS });
    expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'cursor']);
    expect((await app.call('GET', '/resources/budget_reservation?limit=0', { member: FINOPS })).status).toBe(422);
  });

  it('is the tenant\'s and the right of whoever manages the money: the holder over one unit, a reader of the registry and the person with no grant are refused, and a tenant sees nothing of another', async () => {
    const made = await createBudget({ scope_kind: 'TENANT', limit_vnd: '1000000' });
    const body = { scope_kind: 'TENANT', period: 'YEAR', limit_vnd: '10', hard_stop: true, effective_from: '2026-01-01' };
    for (const member of [SCOPED, READER, NOBODY]) {
      expect((await app.call('POST', '/ai-budgets', { member, body })).status).toBe(403);
      expect((await app.call('POST', '/ai-pricing-versions', { member, body: price(randomUUID(), 'x') })).status).toBe(403);
      for (const url of ['/ai-budgets', '/ai-pricing-versions', `/ai-budgets/${made.json.resource_id as string}/spend`, '/resources/budget_reservation']) expect((await app.call('GET', url, { member })).status).toBe(403);
    }
    expect((await app.call('GET', '/ai-budgets', { member: AI_ADMIN, tenantId: TENANT_B })).json.items).toEqual([]);
    expect((await app.call('GET', `/ai-budgets/${made.json.resource_id as string}/spend`, { member: AI_ADMIN, tenantId: TENANT_B })).status).toBe(404);
    expect((await createBudget({ scope_kind: 'TENANT', limit_vnd: '5' }, AI_ADMIN, TENANT_B)).status).toBe(200);
  });

  it('creates a budget once under one idempotency key', async () => {
    const key = `budget-${randomUUID()}`;
    const body = { scope_kind: 'TENANT', period: 'MONTH', limit_vnd: '1000', hard_stop: true, effective_from: '2026-01-01' };
    const [a, b] = [await app.call('POST', '/ai-budgets', { member: FINOPS, key, body }), await app.call('POST', '/ai-budgets', { member: FINOPS, key, body })];
    expect([a.status, b.status, a.json.resource_id === b.json.resource_id]).toEqual([200, 200, true]);
    expect((await app.rows('select 1 from machvon.ai_budget')).length).toBe(1);
  });
});
