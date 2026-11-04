import { randomUUID } from 'node:crypto';
import { LlmFinopsStore, LlmReconcileStore } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { periodStartOf, vietnamDateOf } from '@machvon/kernel';
import { contextFor } from '../../../../packages/db/test/support/authz-fixtures';
import { AI_ADMIN, FINOPS, LlmApp, NOBODY, READER, SCOPED, TENANT_A, TENANT_B, memberId } from './llm-app';
import { llmModule } from '../../src/modules/llm';
import { LlmReconcileController } from '../../src/modules/llm/reconcile.controller';
import { asList, asObjects } from '../support/json';

const app = new LlmApp();
const finops = new LlmFinopsStore();
const reconciler = new LlmReconcileStore();
jest.setTimeout(240_000);

beforeAll(() => app.start());
afterAll(() => app.stop());
beforeEach(() => app.reset());

const withTx = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(FINOPS)), work);
const dayAt = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/** A period that is over: from thirty days ago to yesterday (the days of Vietnam are not the days of UTC, so the attempts are put at noon of a day in the middle). */
const PERIOD = { from: dayAt(-30), to: dayAt(-2) };
const MIDDLE = `${dayAt(-10)}T05:00:00Z`;
const TODAY = vietnamDateOf(new Date());
const THIS_MONTH = periodStartOf('MONTH', TODAY);

interface Fixture {
  providerId: string;
  priceId: string;
  modelRefId: string;
}

/** A provider that is called VN1 with a model and a price of one dong for each input token, so that the cost of an attempt is its number of tokens. */
async function provider(code = 'VN1', tenantId = TENANT_A, member = AI_ADMIN): Promise<Fixture> {
  const made = await app.call('POST', '/ai-providers', {
    member,
    tenantId,
    body: { provider_code: code, name: 'Provider of VN', region_country: 'VN', route_class: 'DOMESTIC_HOSTED', max_classification: 'PUBLIC' },
  });
  expect(made.status).toBe(200);
  const model = await app.call('POST', '/ai-models', {
    member,
    tenantId,
    body: { provider_id: made.json.resource_id, model_id: `m-${randomUUID().slice(0, 6)}`, capabilities: {}, context_window: 8000, max_output: 1000, max_classification: 'PUBLIC' },
  });
  const modelId = (await app.rows<{ model_id: string }>('select model_id from machvon.ai_model where id = $1', [model.json.resource_id], tenantId))[0]!.model_id;
  const price = await app.call('POST', '/ai-pricing-versions', {
    member: FINOPS,
    tenantId,
    body: {
      provider: 'ProviderCo',
      model_id: modelId,
      model_ref_id: model.json.resource_id,
      currency: 'VND',
      effective_from: '2026-01-01T00:00:00.000Z',
      input_per_million: '1000000',
      cached_per_million: '0',
      output_per_million: '0',
      cached_semantics: 'INCLUDED_IN_INPUT',
      reasoning_in_output: true,
      source_url: 'https://provider.example/pricing',
      fx_rate_to_vnd: '1',
      fx_source: 'fixed',
    },
  });
  expect(price.status).toBe(200);
  return { providerId: made.json.resource_id as string, priceId: price.json.resource_id as string, modelRefId: model.json.resource_id as string };
}

/** An AI request, a settled attempt of it that cost `cost` dong, put in as the gateway leaves them. */
async function settledAttempts(f: Fixture, costs: number[], at = MIDDLE): Promise<string[]> {
  const ids: string[] = [];
  const statements: Array<[string, unknown[]]> = [];
  for (const cost of costs) {
    const request = randomUUID();
    const attempt = randomUUID();
    ids.push(attempt);
    statements.push([
      `insert into machvon.ai_request (tenant_id, id, task_type, subject_module, requested_by, profile_version_id, data_classification, classification_basis, policy_version_id, input_sha256, created_by, updated_by)
       values ($1, $2, 'SUMMARY', 'BID', $3, $4, 'INTERNAL', '{}'::jsonb, $5, $6, $3, $3)`,
      [TENANT_A, request, memberId(FINOPS), randomUUID(), randomUUID(), 'a'.repeat(64)],
    ]);
    statements.push([
      `insert into machvon.llm_attempt (tenant_id, id, run_id, provider_request_id, actual_model, pricing_version_id, input_total, cached_input, output_total, reasoning_info, cost, currency, reconcile_status, ai_request_id,
         attempt_no, attempt_kind, route_class, provider_id, outcome, latency_ms, noncached_input, tool_fee, fx_rate_to_vnd, cost_vnd, created_at)
       values ($1, $2, null, $3, 'm', $4, $5::bigint, 0, 0, 0, $5::numeric, 'VND', 'SETTLED', $6, 1, 'PRIMARY', 'DOMESTIC_HOSTED', $7, 'SUCCESS', 100, $5::bigint, 0, 1, $5::numeric, $8::timestamptz)`,
      [TENANT_A, attempt, `req-${attempt}`, f.priceId, cost, request, f.providerId, at],
    ]);
  }
  await app.seedReplica(statements);
  return ids;
}

/** A request that timed out: an attempt that waits for its usage, and the reservation that is held for it. */
async function pendingAttempt(f: Fixture, scope: unknown[] = [], reserved = 20_000, at = MIDDLE): Promise<{ attemptId: string; requestId: string; reservationId: string }> {
  const request = randomUUID();
  const attempt = randomUUID();
  const reservation = randomUUID();
  await app.seedReplica([
    [
      `insert into machvon.ai_request (tenant_id, id, task_type, subject_module, requested_by, profile_version_id, data_classification, classification_basis, policy_version_id, input_sha256, created_by, updated_by)
       values ($1, $2, 'SUMMARY', 'BID', $3, $4, 'INTERNAL', '{}'::jsonb, $5, $6, $3, $3)`,
      [TENANT_A, request, memberId(FINOPS), randomUUID(), randomUUID(), 'a'.repeat(64)],
    ],
    [
      `insert into machvon.llm_attempt (tenant_id, id, run_id, provider_request_id, actual_model, pricing_version_id, input_total, cached_input, output_total, reasoning_info, cost, currency, reconcile_status, ai_request_id,
         attempt_no, attempt_kind, route_class, provider_id, outcome, latency_ms, noncached_input, tool_fee, fx_rate_to_vnd, cost_vnd, created_at)
       values ($1, $2, null, '', 'm', $3, 0, 0, 0, 0, 0, 'VND', 'PENDING', $4, 1, 'PRIMARY', 'DOMESTIC_HOSTED', $5, 'TIMEOUT', 30000, 0, 0, 1, 0, $6::timestamptz)`,
      [TENANT_A, attempt, f.priceId, request, f.providerId, at],
    ],
    [
      `insert into machvon.budget_reservation (tenant_id, id, request_id, scope_json, reserved_amount, currency, status, expires_at, budget_counter_ids, reconcile_note)
       values ($1, $2, $3, $4::jsonb, $5, 'VND', 'PENDING_RECONCILE', now() + interval '1 hour', '[]'::jsonb, 'TIMEOUT_NO_USAGE')`,
      [TENANT_A, reservation, request, JSON.stringify(scope), reserved],
    ],
  ]);
  return { attemptId: attempt, requestId: request, reservationId: reservation };
}

/** The usage that comes late for a timed-out attempt: settled against its reservation by the finops store, as the gateway does. */
const lateUsage = (f: Fixture, pending: { reservationId: string }, tokens: number) =>
  withTx((tx) =>
    finops.settle(tx, {
      reservationId: pending.reservationId,
      providerRequestId: `late-${randomUUID()}`,
      actualModel: 'm',
      pricingVersionId: f.priceId,
      usage: { inputTotal: tokens, cachedInput: 0, outputTotal: 0 },
      attemptNo: 1,
      providerId: f.providerId,
      actor: memberId(FINOPS),
    }),
  );

const reconcile = (body: Record<string, unknown>, member = FINOPS, tenantId?: string) =>
  app.call('POST', '/ai-invoices/reconciliations', {
    member,
    ...(tenantId === undefined ? {} : { tenantId }),
    body: { invoice_ref: 'VN1-2026-11', invoice_amount: '3180000', currency: 'VND', period_from: PERIOD.from, period_to: PERIOD.to, ...body },
  });

describe('the reconciliation of the invoice of a provider with the attempts (ST-LLM-008, LLM.md F3, UAT-AC462)', () => {
  it('is registered in the module of LLM', () => {
    expect(llmModule.controllers).toContain(LlmReconcileController);
  });

  it('UAT-AC462: a variance of 60,000 that lists the 3 attempts waiting for usage and edits no cost, then RECONCILED within the tolerance once the late usage of 52,000 arrived, with the 3 reservations settled', async () => {
    const f = await provider();
    // 1,247 attempts that cost 3,120,000 between them, and 3 that timed out: 1,250 in the month.
    await settledAttempts(f, [...Array.from({ length: 1246 }, () => 2500), 5000]);
    const pending = [await pendingAttempt(f), await pendingAttempt(f), await pendingAttempt(f)];
    const before = await app.rows<{ id: string; cost: string; reconcile_status: string }>('select id, cost::text as cost, reconcile_status from machvon.llm_attempt order by id');
    expect(before).toHaveLength(1250);

    const first = await reconcile({});
    expect([first.status, first.json.status]).toEqual([200, 'VARIANCE']);
    expect(first.json).toMatchObject({ variance: '60000', attempts_total: '3120000', reservations_settled: 0, resource_version: 1 });
    expect((first.json.pending_attempt_ids as string[]).sort()).toEqual(pending.map((one) => one.attemptId).sort());
    // Nothing was edited to make the figures agree.
    const after = await app.rows<{ id: string; cost: string; reconcile_status: string }>('select id, cost::text as cost, reconcile_status from machvon.llm_attempt order by id');
    expect(after).toEqual(before);
    expect(await app.rows<{ status: string }>("select status from machvon.budget_reservation where status = 'PENDING_RECONCILE'")).toHaveLength(3);

    // The usage that was late arrives: 17,000 + 17,000 + 18,000 = 52,000, settled against the reservations.
    for (const [index, tokens] of [17_000, 17_000, 18_000].entries()) await lateUsage(f, pending[index] as { reservationId: string }, tokens);
    expect(await app.rows("select 1 from machvon.budget_reservation where status = 'SETTLED'")).toHaveLength(3);

    const second = await reconcile({});
    expect([second.status, second.json.status]).toEqual([200, 'RECONCILED']);
    expect(second.json).toMatchObject({ variance: '8000', attempts_total: '3172000', reservations_settled: 3, pending_attempt_ids: [], resource_version: 2, resource_id: first.json.resource_id });
    const stored = await app.rows<Record<string, unknown>>(
      'select status, variance::text as variance, run_count, owner_id, reconciled_attempt_ids, tolerance_pct::text as tolerance from machvon.ai_invoice_reconciliation',
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ status: 'RECONCILED', variance: '8000.00000000', run_count: 2, owner_id: memberId(FINOPS), tolerance: '0.50' });
    expect((asList(stored[0]?.reconciled_attempt_ids) as string[]).sort()).toEqual(pending.map((one) => one.attemptId).sort());
    // The attempts that waited are marked, with the figures they had; the ones that paid for them say which invoice counted them.
    const marked = await app.rows<{ reconcile_status: string; cost: string }>('select reconcile_status, cost::text as cost from machvon.llm_attempt where id = any($1::uuid[])', [
      pending.map((one) => one.attemptId),
    ]);
    expect(marked).toEqual(pending.map(() => ({ reconcile_status: 'RECONCILED', cost: '0.00000000' })));
    expect((await app.rows<{ n: string }>("select count(*)::text as n from machvon.llm_attempt where invoice_ref = 'VN1-2026-11'"))[0]?.n).toBe('1253');

    // A reconciled invoice is final: running it again answers what it said and writes nothing.
    const third = await reconcile({});
    expect(third.json).toMatchObject({ status: 'RECONCILED', resource_id: first.json.resource_id, resource_version: 2 });
    expect((await app.rows<{ run_count: number }>('select run_count from machvon.ai_invoice_reconciliation'))[0]?.run_count).toBe(2);
    const told = await app.rows<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1 order by created_at', [first.json.resource_id]);
    expect(told.map((event) => event.type)).toEqual(['llm.invoice.variance.v1', 'llm.invoice.reconciled.v1']);
    expect(
      (await app.rows<{ action: string }>('select action from machvon.audit_event where resource_id = $1', [first.json.resource_id])).filter((entry) => entry.action === 'llm.invoice_reconciled'),
    ).toHaveLength(3);
  });

  it('keeps a variance that has not enough late usage as a variance, with the attempts that still wait, and the owner of the first run', async () => {
    const f = await provider();
    await settledAttempts(f, [1_000_000]);
    const one = await pendingAttempt(f, [], 100_000);
    const two = await pendingAttempt(f, [], 100_000);
    const first = await reconcile({ invoice_amount: '1100000' });
    expect(first.json).toMatchObject({ status: 'VARIANCE', variance: '100000' });
    await lateUsage(f, one, 40_000);
    const second = await reconcile({ invoice_amount: '1100000' }, FINOPS);
    expect(second.json).toMatchObject({ status: 'VARIANCE', variance: '60000', pending_attempt_ids: [two.attemptId], reservations_settled: 1, resource_version: 2 });
    const listed = await app.call('GET', '/ai-invoices/reconciliations?status=VARIANCE', { member: FINOPS });
    expect(listed.json.items).toEqual([
      expect.objectContaining({ id: first.json.resource_id, status: 'VARIANCE', owner_id: memberId(FINOPS), run_count: 2, provider_code: 'VN1', invoice_ref: 'VN1-2026-11', variance: '60000' }),
    ]);
  });

  it('judges the tolerance exactly: 0.5 percent of the invoice is inside it, one cent more is not, above and below the attempts', async () => {
    const f = await provider();
    const g = await provider('VN2');
    await settledAttempts(f, [995_000]);
    await settledAttempts(g, [1_005_000]);
    // 1,000,000 against 995,000 is 5,000 = 0.5 percent of 1,000,000 exactly; 1,000,000.01 against 995,000 is 5,000.01 = more than 0.5 percent of it.
    expect((await reconcile({ invoice_ref: 'VN1-A', invoice_amount: '1000000' })).json).toMatchObject({ status: 'RECONCILED', variance: '5000' });
    expect((await reconcile({ invoice_ref: 'VN1-B', invoice_amount: '1000000.01' })).json).toMatchObject({ status: 'VARIANCE', variance: '5000.01' });
    // An invoice for less than the attempts is a variance below zero, judged the same way.
    expect((await reconcile({ invoice_ref: 'VN2-C', invoice_amount: '1000000' })).json).toMatchObject({ status: 'RECONCILED', variance: '-5000' });
    expect((await reconcile({ invoice_ref: 'VN2-D', invoice_amount: '999999.99' })).json).toMatchObject({ status: 'VARIANCE', variance: '-5000.01' });
    // An invoice of nothing agrees with attempts of nothing only.
    expect((await reconcile({ invoice_ref: 'VN2-E', invoice_amount: '0' })).json).toMatchObject({ status: 'VARIANCE', variance: '-1005000' });
  });

  it('refuses a period that is not over (409 RECONCILE_PERIOD_OPEN), a currency that is not the attempts’ (422 CURRENCY_MISMATCH), an invoice of no provider, and figures that are not figures', async () => {
    const f = await provider();
    await settledAttempts(f, [1000]);
    expect(await reconcile({ period_to: TODAY })).toMatchObject({ status: 409, json: { code: 'RECONCILE_PERIOD_OPEN' } });
    expect(await reconcile({ period_to: dayAt(5) })).toMatchObject({ status: 409, json: { code: 'RECONCILE_PERIOD_OPEN' } });
    expect(await reconcile({ currency: 'USD' })).toMatchObject({ status: 422, json: { code: 'CURRENCY_MISMATCH' } });
    expect((await reconcile({ invoice_ref: 'NOBODY-2026-11' })).json.detail).toBe('invoice_ref');
    expect((await reconcile({ invoice_ref: 'VN10-2026-11' })).json.detail).toBe('invoice_ref');
    expect((await reconcile({ invoice_amount: '-5' })).json.detail).toBe('invoice_amount');
    expect((await reconcile({ currency: 'vnd' })).status).toBeGreaterThanOrEqual(400);
    expect((await reconcile({ period_from: dayAt(-10), period_to: dayAt(-20) })).json.detail).toBe('period_to');
    expect((await reconcile({ period_from: dayAt(-400), period_to: dayAt(-2) })).json.detail).toBe('period_to');
    expect((await reconcile({ period_from: '2026-02-30' })).json.detail).toBe('period_from');
    expect((await reconcile({ invoice_ref: ' ' })).json.detail).toBe('invoice_ref');
    // Nothing of these was kept.
    expect(await app.rows('select 1 from machvon.ai_invoice_reconciliation')).toEqual([]);
  });

  it('keeps an invoice to the figures it was first reconciled with (409 DUPLICATE_KEY), and takes the longest provider code the reference begins with', async () => {
    const f = await provider('VN1');
    const longer = await provider('VN1-LAB');
    await settledAttempts(f, [1000]);
    await settledAttempts(longer, [7000]);
    expect((await reconcile({ invoice_ref: 'VN1-2026-11', invoice_amount: '2000' })).json).toMatchObject({ status: 'VARIANCE', attempts_total: '1000' });
    expect(await reconcile({ invoice_ref: 'VN1-2026-11', invoice_amount: '2001' })).toMatchObject({ status: 409, json: { code: 'DUPLICATE_KEY' } });
    expect(await reconcile({ invoice_ref: 'VN1-2026-11', period_from: dayAt(-29) })).toMatchObject({ status: 409, json: { code: 'DUPLICATE_KEY' } });
    // The longer code wins, and the invoices of the two providers are not mixed.
    expect((await reconcile({ invoice_ref: 'vn1-lab-2026-11', invoice_amount: '7000' })).json).toMatchObject({ status: 'RECONCILED', attempts_total: '7000' });
    const providers = await app.rows<{ provider_code: string }>(
      'select p.provider_code from machvon.ai_invoice_reconciliation r join machvon.ai_provider p on p.id = r.provider_id order by p.provider_code',
    );
    expect(providers.map((row) => row.provider_code)).toEqual(['VN1', 'VN1-LAB']);
  });

  it('counts the attempts of the provider in the period, by the day of Vietnam: the ones before it, after it and of another provider are not in the sum', async () => {
    const f = await provider();
    const other = await provider('VN2');
    await settledAttempts(f, [1000]);
    await settledAttempts(f, [500], `${dayAt(-40)}T05:00:00Z`);
    await settledAttempts(f, [300], `${dayAt(-1)}T05:00:00Z`);
    await settledAttempts(other, [9000]);
    // The edge: 17:30 UTC of the day before the first day is already the first day in Vietnam, 17:30 UTC of the last day is already the day after.
    await settledAttempts(f, [11], `${dayAt(-31)}T17:30:00Z`);
    await settledAttempts(f, [22], `${dayAt(-2)}T17:30:00Z`);
    const done = await reconcile({ invoice_amount: '1011' });
    expect(done.json).toMatchObject({ attempts_total: '1011', status: 'RECONCILED' });
    expect((await app.rows<{ attempt_count: number }>('select attempt_count from machvon.ai_invoice_reconciliation'))[0]?.attempt_count).toBe(2);
  });

  it('counts the late usage of an attempt in the period of that attempt only: the invoice of the next period does not count it again nor take its reference', async () => {
    const f = await provider();
    const early = { from: dayAt(-30), to: dayAt(-15) };
    const later = { from: dayAt(-10), to: dayAt(-2) };
    await settledAttempts(f, [3000], `${dayAt(-5)}T05:00:00Z`);
    const timedOut = await pendingAttempt(f, [], 20_000, `${dayAt(-20)}T05:00:00Z`);
    await lateUsage(f, timedOut, 7000);
    // The usage was written when it came, in the later period.
    await app.seedReplica([[`update machvon.llm_attempt set created_at = $1::timestamptz where provider_request_id like 'late-%'`, [`${dayAt(-5)}T06:00:00Z`]]]);
    const january = await reconcile({ invoice_ref: 'VN1-EARLY', invoice_amount: '7000', period_from: early.from, period_to: early.to });
    expect(january.json).toMatchObject({ status: 'RECONCILED', attempts_total: '7000', pending_attempt_ids: [] });
    const february = await reconcile({ invoice_ref: 'VN1-LATER', invoice_amount: '3000', period_from: later.from, period_to: later.to });
    expect(february.json).toMatchObject({ status: 'RECONCILED', attempts_total: '3000', variance: '0' });
    expect((await app.rows<{ attempt_count: number }>("select attempt_count from machvon.ai_invoice_reconciliation where invoice_ref = 'VN1-LATER'"))[0]?.attempt_count).toBe(1);
    expect((await app.rows<{ invoice_ref: string }>("select invoice_ref from machvon.llm_attempt where provider_request_id like 'late-%'"))[0]?.invoice_ref).toBe('VN1-EARLY');
  });

  it('is for the finance of the whole tenant: reading and running need llm.finops, no grant on a subtree reaches it, and another tenant sees none of it', async () => {
    const f = await provider();
    await settledAttempts(f, [1000]);
    for (const member of [READER, NOBODY, SCOPED]) {
      expect((await reconcile({}, member)).status).toBe(403);
      expect((await app.call('GET', '/ai-invoices/reconciliations', { member })).status).toBe(403);
    }
    const made = await reconcile({ invoice_amount: '1000' });
    expect(made.status).toBe(200);
    const other = await app.call('GET', '/ai-invoices/reconciliations', { member: AI_ADMIN, tenantId: TENANT_B });
    expect(other.status === 403 || (other.json.items as unknown[]).length === 0).toBe(true);
    expect((await reconcile({ invoice_ref: 'VN1-2026-11' }, FINOPS, TENANT_B)).status).toBeGreaterThanOrEqual(400);
    expect((await app.call('GET', '/ai-invoices/reconciliations?status=Nope', { member: FINOPS })).status).toBe(422);
    expect((await app.call('GET', '/ai-invoices/reconciliations?limit=0', { member: FINOPS })).status).toBe(422);
  });

  it('lists the reconciliations newest first, a page at a time', async () => {
    const f = await provider();
    await settledAttempts(f, [1000]);
    const ids: string[] = [];
    for (const ref of ['VN1-A', 'VN1-B', 'VN1-C']) ids.push((await reconcile({ invoice_ref: ref, invoice_amount: '1000' })).json.resource_id as string);
    const firstPage = await app.call('GET', '/ai-invoices/reconciliations?limit=2', { member: FINOPS });
    expect(asObjects(firstPage.json.items).map((item) => item.id)).toEqual([ids[2], ids[1]]);
    const next = await app.call('GET', `/ai-invoices/reconciliations?limit=2&cursor=${firstPage.json.next_cursor}`, { member: FINOPS });
    expect(asObjects(next.json.items).map((item) => item.id)).toEqual([ids[0]]);
    expect(next.json.next_cursor).toBeNull();
    expect((await app.call('GET', '/ai-invoices/reconciliations?status=RECONCILED', { member: FINOPS })).json.items).toHaveLength(3);
  });

  it('is kept for good: the table refuses to change what the invoice said, to edit the figures of an attempt, to undo a reconciled invoice or to delete one', async () => {
    const f = await provider();
    const [attempt] = await settledAttempts(f, [1000]);
    const made = await reconcile({ invoice_amount: '1000' });
    const id = made.json.resource_id as string;
    const asApp = (sql: string, params: unknown[] = []) => withTx((tx) => tx.query(sql, params));
    await expect(asApp('update machvon.ai_invoice_reconciliation set invoice_amount = 5 where id = $1', [id])).rejects.toMatchObject({ code: '42501' });
    await expect(asApp("update machvon.ai_invoice_reconciliation set status = 'VARIANCE' where id = $1", [id])).rejects.toMatchObject({ code: '42501' });
    await expect(asApp('delete from machvon.ai_invoice_reconciliation where id = $1', [id])).rejects.toBeDefined();
    await expect(asApp('update machvon.llm_attempt set cost = 1, cost_vnd = 1 where id = $1', [attempt])).rejects.toMatchObject({ code: '42501' });
    await expect(asApp('update machvon.llm_attempt set pricing_version_id = gen_random_uuid() where id = $1', [attempt])).rejects.toMatchObject({ code: '42501' });
    await expect(asApp("update machvon.llm_attempt set outcome = 'NO_CITATION', invoice_ref = 'X' where id = $1", [attempt])).resolves.toBeDefined();
  });
});

describe('the decision of the owner of a budget about the reservations that wait for usage (ST-LLM-008, post_budgets_id_reconcile)', () => {
  const decide = (budget: string, version: number, body: Record<string, unknown>, member = FINOPS) =>
    app.call('POST', `/budgets/${budget}/reconcile`, {
      member,
      ifMatch: `"${version}"`,
      body: { decision: 'approve', reason: 'Nothing was used: the provider never answered.', evidence_ids: [], ...body },
    });

  /** A budget of the tenant with its counter of this month, as the finops tests make it. */
  async function budget(): Promise<{ id: string; counterId: string; version: number }> {
    const created = await withTx((tx) =>
      finops.createBudget(tx, {
        scopeKind: 'TENANT',
        scopeRefId: null,
        period: 'MONTH',
        limitVnd: '1000000',
        softThresholdPct: 80,
        hardStop: true,
        maxRequestsPerDay: null,
        maxConcurrent: null,
        effectiveFrom: '2026-01-01',
        actor: memberId(FINOPS),
      }),
    );
    const counterId = randomUUID();
    await app.rows('insert into machvon.ai_budget_counter (tenant_id, id, budget_id, period_start, limit_vnd, settled_vnd, reserved_open_vnd) values ($1, $2, $3, $4::date, 1000000, 0, 60000)', [
      TENANT_A,
      counterId,
      created.id,
      THIS_MONTH,
    ]);
    return { id: created.id, counterId, version: created.version };
  }
  const waiting = (f: Fixture, b: { id: string; counterId: string }) => pendingAttempt(f, [{ kind: 'TENANT', ref: null, budgetId: b.id, counterId: b.counterId }], 20_000);
  const status = async (id: string) =>
    (
      await app.rows<{ status: string; released: string | null; note: string | null }>(
        'select status, released_amount::text as released, reconcile_note as note from machvon.budget_reservation where id = $1',
        [id],
      )
    )[0];

  it('approves: releases what nothing was used for, with the reason, and leaves alone what was paid for in part; against the version read, and counted once', async () => {
    const f = await provider();
    const b = await budget();
    const [none, partly, third] = [await waiting(f, b), await waiting(f, b), await waiting(f, b)];
    // One was paid for in part (a first attempt of its request settled, the hold was kept for the next).
    await withTx((tx) =>
      finops.settle(tx, {
        reservationId: partly.reservationId,
        providerRequestId: `p-${randomUUID()}`,
        actualModel: 'm',
        pricingVersionId: f.priceId,
        usage: { inputTotal: 5000, cachedInput: 0, outputTotal: 0 },
        attemptNo: 1,
        providerId: f.providerId,
        final: false,
        actor: memberId(FINOPS),
      }),
    );
    expect((await status(partly.reservationId))?.status).toBe('PENDING_RECONCILE');
    const done = await decide(b.id, b.version, { evidence_ids: [none.reservationId, partly.reservationId] });
    expect([done.status, done.json.status]).toEqual([200, 'RECONCILED']);
    expect(done.json).toMatchObject({ released: [none.reservationId], kept: [partly.reservationId], resource_version: b.version + 1 });
    expect(await status(none.reservationId)).toMatchObject({ status: 'RELEASED', released: '20000.00000000', note: 'Nothing was used: the provider never answered.' });
    expect((await status(partly.reservationId))?.status).toBe('PENDING_RECONCILE');
    expect((await status(third.reservationId))?.status).toBe('PENDING_RECONCILE');
    // The hold left the open amount once (the 5,000 of the part that was paid for left it when it was settled, the 20,000 released now).
    expect((await app.rows<{ reserved: string }>('select reserved_open_vnd::text as reserved from machvon.ai_budget_counter where id = $1', [b.counterId]))[0]?.reserved).toBe('35000.00000000');
    // The same version again is stale, and the next version names nothing that is not waiting any more.
    expect((await decide(b.id, b.version, {})).json.code).toBe('VERSION_CONFLICT');
    expect((await decide(b.id, b.version + 1, { evidence_ids: [none.reservationId] })).json.detail).toBe('evidence_ids');
    // Without names it is every one that waits and has no usage.
    const rest = await decide(b.id, b.version + 1, {});
    expect(rest.json).toMatchObject({ released: [third.reservationId], kept: [partly.reservationId] });
    expect((await app.rows<{ n: string }>("select count(*)::text as n from machvon.audit_event where action = 'llm.budget_reconciled' and resource_id = $1", [b.id]))[0]?.n).toBe('2');
  });

  it('reads the usage of a reservation under its lock: a part paid for while the decision waits is not released', async () => {
    const f = await provider();
    const b = await budget();
    const raced = await waiting(f, b);
    let decision: Promise<{ released: string[]; kept: string[] }> | undefined;
    await withTx(async (tx) => {
      await finops.settle(tx, {
        reservationId: raced.reservationId,
        providerRequestId: `p-${randomUUID()}`,
        actualModel: 'm',
        pricingVersionId: f.priceId,
        usage: { inputTotal: 5000, cachedInput: 0, outputTotal: 0 },
        attemptNo: 1,
        providerId: f.providerId,
        final: false,
        actor: memberId(FINOPS),
      });
      // The decision starts while the part is not yet committed; it has to wait for the reservation.
      decision = withTx((other) => reconciler.decideBudget(other, b.id, b.version, { decision: 'approve', reason: 'Nothing was used: the provider never answered.', reservationIds: [] }, memberId(FINOPS)));
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(await decision).toMatchObject({ released: [], kept: [raced.reservationId] });
    expect((await status(raced.reservationId))?.status).toBe('PENDING_RECONCILE');
  });

  it('returns or rejects: the reservations keep waiting and the decision is on record', async () => {
    const f = await provider();
    const b = await budget();
    const one = await waiting(f, b);
    const returned = await decide(b.id, b.version, { decision: 'return', reason: 'Ask the provider for the usage first.' });
    expect(returned.json).toMatchObject({ status: 'WAITING', released: [], kept: [one.reservationId] });
    expect((await decide(b.id, b.version + 1, { decision: 'reject', reason: 'The usage does not agree with the invoice.' })).json).toMatchObject({ status: 'WAITING', kept: [one.reservationId] });
    expect((await status(one.reservationId))?.status).toBe('PENDING_RECONCILE');
  });

  it('refuses a reason that is too short, a name that is not an id or a reservation of another budget, an unknown budget, and who may not', async () => {
    const b = await budget();
    expect((await decide(b.id, b.version, { reason: 'short' })).json.detail).toBe('reason');
    expect((await decide(b.id, b.version, { evidence_ids: ['nope'] })).status).toBeGreaterThanOrEqual(400);
    expect((await decide(b.id, b.version, { evidence_ids: [randomUUID()] })).json.detail).toBe('evidence_ids');
    expect((await decide(randomUUID(), 1, {})).status).toBe(404);
    for (const member of [READER, NOBODY, SCOPED]) expect((await decide(b.id, b.version, {}, member)).status).toBe(403);
  });
});
