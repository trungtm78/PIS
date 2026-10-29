import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { BillingStore } from '../src/billing-store';
import type { InvoiceRow } from '../src/billing-store';
import type { ApprovalEffects } from '../src/approval-store';
import { ControlDatabase } from '../src/control-database';
import { MockEInvoiceProvider, numberOf } from '../src/einvoice-provider';
import { SubscriptionStore } from '../src/subscription-store';
import type { CreateSubscriptionInput } from '../src/subscription-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, memberId } from './support/authz-fixtures';

const store = new BillingStore();
const subscriptions = new SubscriptionStore();
const OPERATOR = '00000000-0000-4000-8000-0000000000a1';
const TENANT_C = '00000000-0000-4000-8000-00000000000c';
const PLACEMENT = '00000000-0000-4000-8000-0000000000b1';
const NOW = new Date('2026-03-05T03:00:00Z');
const TODAY = '2026-03-05';
const FEBRUARY = { start: '2026-02-01', end: '2026-02-28' };
const REASON = 'The customer asked for the larger plan.';

interface Recorded {
  audits: Array<{ action: string; resourceId: string; diff: unknown }>;
  events: Array<{ type: string; eventKey: string }>;
}

function recorder(): ApprovalEffects & Recorded {
  const audits: Recorded['audits'] = [];
  const events: Recorded['events'] = [];
  return {
    actor: memberId(1),
    audits,
    events,
    audit: async (entry) => void audits.push({ action: entry.action, resourceId: entry.resourceId, diff: entry.diff }),
    emit: async (event) => void events.push({ type: event.type, eventKey: event.eventKey }),
  };
}

describe('the billing run and the e-invoice (ST-SAS-011, SAS.md BR-SAS-13 and BR-SAS-14, 3.7)', () => {
  const harness = new AuthzHarness();
  let control: ControlDatabase;
  let controlPool: Pool;
  let counter = 0;
  const inTenant = <T>(tenant: string, work: (tx: TenantTx) => Promise<T>): Promise<T> => control.withTenantOf(tenant, work);

  const admin = async <T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(text, params)).rows as T[];
    } finally {
      await client.end();
    }
  };
  const sqlError = async (text: string, params: unknown[] = []): Promise<{ code: string | undefined; message: string } | undefined> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query(text, params);
      return undefined;
    } catch (error) {
      return { code: (error as { code?: string }).code, message: (error as Error).message };
    } finally {
      await client.end();
    }
  };

  interface PlanSeed {
    price: string;
    vat?: string;
    /** A metered feature: its limit and the price of a unit beyond it. */
    metered?: { limit: string; price: string };
    cycles?: string[];
  }

  async function plan(seed: PlanSeed): Promise<string> {
    counter += 1;
    const id = randomUUID();
    await admin(
      `insert into machvon.product_plan_version (id, plan_code, revision, name, status, billing_cycles, base_price_vnd, vat_category, legal_terms_ref)
       values ($1, $2, 1, $3, 'Draft', $4::text[], $5::numeric, $6, 'TERMS-1')`,
      [id, `bill-${counter}`, `Plan ${counter}`, seed.cycles ?? ['ANNUAL', 'MONTHLY'], seed.price, seed.vat ?? 'NOT_SUBJECT'],
    );
    await admin("insert into machvon.plan_feature (id, plan_version_id, feature_code, limit_kind, limit_value, grace_behavior, expired_behavior) values (gen_random_uuid(), $1, 'member.seats', 'QUOTA', 50, 'READ_ONLY', 'DENY')", [id]);
    if (seed.metered !== undefined) {
      await admin(
        "insert into machvon.plan_feature (id, plan_version_id, feature_code, limit_kind, limit_value, meter, overage_price_vnd, grace_behavior, expired_behavior) values (gen_random_uuid(), $1, 'ai_calls', 'METERED', $2::numeric, 'ai_call', $3::numeric, 'ALLOW', 'READ_ONLY')",
        [id, seed.metered.limit, seed.metered.price],
      );
    }
    await admin("update machvon.product_plan_version set status = 'Published', published_by = $2, published_at = now() where id = $1", [id, OPERATOR]);
    return id;
  }

  const input = (planVersionId: string, overrides: Partial<CreateSubscriptionInput> = {}): CreateSubscriptionInput => ({
    planVersionId,
    cycle: 'MONTHLY',
    billingAnchor: '2026-01-01',
    trialDays: 0,
    paymentTerms: { dueDays: 15, method: 'BANK_TRANSFER' },
    now: new Date('2026-01-01T03:00:00Z'),
    ...overrides,
  });

  /** A live subscription of a tenant on a new plan, the older one of the tenant cancelled first (a tenant has one live subscription). */
  async function subscribe(tenant: string, planSeed: PlanSeed, overrides: Partial<CreateSubscriptionInput> = {}): Promise<{ subscriptionId: string; planId: string }> {
    await admin("update machvon.subscription set status = 'Cancelled' where tenant_id = $1 and status <> 'Cancelled'", [tenant]);
    const planId = await plan(planSeed);
    const created = await inTenant(tenant, (tx) => subscriptions.create(tx, input(planId, overrides)));
    return { subscriptionId: created.id, planId };
  }

  /** A provider of its own for each test: what it has issued is what it remembers. */
  const newProvider = (): MockEInvoiceProvider => new MockEInvoiceProvider();

  const run = (tenant: string, period = FEBRUARY, effects = recorder()) => inTenant(tenant, (tx) => store.runPeriod(tx, effects, period, TODAY));

  beforeAll(async () => {
    await harness.start();
    controlPool = new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 4 });
    controlPool.on('error', () => undefined);
    control = new ControlDatabase(controlPool);
    await admin("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ($1, 'POOL', 'vn-north', 'cluster-1', 'kms-1', 'Active') on conflict do nothing", [PLACEMENT]);
    for (const [tenant, code] of [[TENANT_A, 'tenant-a'], [TENANT_B, 'tenant-b'], [TENANT_C, 'tenant-c']] as const) {
      await admin("insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, $2, $2, 'Active', $3, 'vn-north') on conflict (id) do nothing", [tenant, code, PLACEMENT]);
    }
    for (const tenant of [TENANT_A, TENANT_B, TENANT_C]) await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
  }, 180_000);

  afterAll(async () => {
    await controlPool?.end();
    await harness.stop();
  }, 60_000);

  describe('the run', () => {
    it('makes the original invoice of each subscription due for the period, once: a second run finds the three and makes none', async () => {
      for (const tenant of [TENANT_A, TENANT_B, TENANT_C]) await subscribe(tenant, { price: '1000000' });
      const first = await Promise.all([TENANT_A, TENANT_B, TENANT_C].map((tenant) => run(tenant)));
      expect(first.map((result) => result.created.length)).toEqual([1, 1, 1]);
      const second = await Promise.all([TENANT_A, TENANT_B, TENANT_C].map((tenant) => run(tenant)));
      expect(second.map((result) => [result.created.length, result.existing.length])).toEqual([[0, 1], [0, 1], [0, 1]]);
      expect(second.flatMap((result) => result.existing.map((invoice) => invoice.id)).sort()).toEqual(first.flatMap((result) => result.created.map((invoice) => invoice.id)).sort());
      const originals = await admin<{ n: string }>("select count(*)::text as n from machvon.invoice where kind = 'ORIGINAL' and period_start = '2026-02-01' and status = 'Draft' and tenant_id = any($1::uuid[])", [[TENANT_A, TENANT_B, TENANT_C]]);
      expect(originals[0]?.n).toBe('3');
    });

    it('holds one original per period in the table, whatever the application does', async () => {
      const { subscriptionId } = await subscribe(TENANT_A, { price: '500000' });
      const [made] = (await run(TENANT_A)).created;
      expect(made?.subscriptionId).toBe(subscriptionId);
      const duplicate = await sqlError(
        `insert into machvon.invoice (tenant_id, id, subscription_id, invoice_code, period_start, period_end, kind, status, subtotal_vnd, vat_vnd, total_vnd, buyer_snapshot, due_at)
         values ($1, gen_random_uuid(), $2, 'INV-OTHER', '2026-02-01', '2026-02-28', 'ORIGINAL', 'Draft', 1, 0, 1, '{}', '2026-03-15')`,
        [TENANT_A, subscriptionId],
      );
      expect(duplicate?.code).toBe('23505');
    });

    it('makes the lines of the plan, of the use beyond the limit and of the proration of a change of plan, with the VAT of each line rounded half up', async () => {
      const { subscriptionId } = await subscribe(TENANT_A, { price: '1000007', vat: 'VAT_8', metered: { limit: '100', price: '15' } });
      const bigger = await plan({ price: '2000000', vat: 'VAT_10' });
      // The cycle job has rolled the period to February by the day of the change; otherwise there is no period left to prorate.
      await inTenant(TENANT_A, (tx) => subscriptions.runCycle(tx, new Date('2026-02-10T03:00:00Z')));
      const preview = await inTenant(TENANT_A, (tx) => subscriptions.preview(tx, { subscriptionId, targetPlanVersionId: bigger, effective: 'NOW', now: new Date('2026-02-10T03:00:00Z') }));
      await inTenant(TENANT_A, (tx) => subscriptions.applyChange(tx, { subscriptionId, targetPlanVersionId: bigger, effective: 'NOW', now: new Date('2026-02-10T03:00:00Z'), previewHash: preview.hash, reason: REASON, expectedVersion: preview.subscription.version, requestedBy: OPERATOR }));
      // February began on the plan of 1,000,007 and the change took effect on the 10th: the plan line is the price of the plan the period began on, and the proration is the charge for the rest.
      const [made] = (await run(TENANT_A)).created;
      const lines = await inTenant(TENANT_A, (tx) => store.linesOf(tx, [made?.id as string]));
      expect(lines.map((line) => [line.lineNo, line.kind])).toEqual([[1, 'SUBSCRIPTION'], [2, 'ADJUSTMENT']]);
      expect(lines[0]).toMatchObject({ amountVnd: '1000007', vatCategory: 'VAT_8', vatVnd: '80001' });
      expect(lines[1]).toMatchObject({ vatCategory: 'VAT_10' });
      expect(BigInt(lines[1]?.amountVnd as string)).toBeGreaterThan(0n);
      expect(made).toMatchObject({ subtotalVnd: (BigInt(lines[0]?.amountVnd as string) + BigInt(lines[1]?.amountVnd as string)).toString(), kind: 'ORIGINAL', status: 'Draft', dueAt: '2026-03-15', buyer: { code: 'tenant-a' } });
      expect(BigInt(made?.totalVnd as string)).toBe(BigInt(made?.subtotalVnd as string) + BigInt(made?.vatVnd as string));
      // The proration is charged once: the change records the invoice it went onto.
      const charged = await admin<{ invoiced_invoice_id: string }>('select invoiced_invoice_id from machvon.subscription_plan_change where subscription_id = $1', [subscriptionId]);
      expect(charged[0]?.invoiced_invoice_id).toBe(made?.id);
    });

    it('bills the use beyond the limit of a metered feature, by the days of Vietnam, and nothing within it', async () => {
      const { subscriptionId } = await subscribe(TENANT_B, { price: '1000007', vat: 'VAT_8', metered: { limit: '100', price: '15' } });
      const events: Array<[string, string]> = [['2026-01-31T17:00:00Z', '50'], ['2026-02-28T16:59:00Z', '80'], ['2026-02-28T17:00:00Z', '40']];
      for (const [at, quantity] of events) {
        await admin("insert into machvon.usage_meter_event (tenant_id, id, meter, external_event_key, quantity, occurred_at, source_reference) values ($1, gen_random_uuid(), 'ai_call', $2, $3::numeric, $4::timestamptz, 'test')", [TENANT_B, randomUUID(), quantity, at]);
      }
      const [made] = (await run(TENANT_B)).created;
      const lines = await inTenant(TENANT_B, (tx) => store.linesOf(tx, [made?.id as string]));
      // 50 + 80 = 130 in February by the clock of Vietnam: 30 beyond the limit at 15 each. The 40 of the evening of the 28th UTC belong to March.
      expect(lines.map((line) => [line.kind, line.amountVnd, line.vatVnd, line.quantity])).toEqual([
        ['SUBSCRIPTION', '1000007', '80001', null],
        ['USAGE', '450', '36', '30'],
      ]);
      expect(made).toMatchObject({ subtotalVnd: '1000457', vatVnd: '80037', totalVnd: '1080494' });
      expect(subscriptionId).toBe(made?.subscriptionId);
    });

    it('bills nothing for a plan that costs nothing and was not used beyond its limits, and the next run asks again', async () => {
      await subscribe(TENANT_C, { price: '0' });
      expect(await run(TENANT_C)).toMatchObject({ created: [], existing: [], nothingToBill: 1 });
    });

    it('bills only the subscriptions whose billing period is the one asked for', async () => {
      await subscribe(TENANT_A, { price: '10', cycles: ['QUARTERLY'] }, { cycle: 'QUARTERLY' });
      // A quarterly subscription anchored on 1 January has no period of February.
      expect(await run(TENANT_A)).toMatchObject({ created: [], existing: [], nothingToBill: 0 });
      const quarter = await run(TENANT_A, { start: '2026-01-01', end: '2026-03-31' });
      expect(quarter.created).toHaveLength(1);
    });

    it('refuses a period that is backwards, has not begun, or runs longer than a year', async () => {
      await subscribe(TENANT_A, { price: '10' });
      for (const period of [{ start: '2026-02-28', end: '2026-02-01' }, { start: '2026-03-06', end: '2026-03-31' }, { start: '2025-01-01', end: '2026-03-01' }]) {
        await expect(run(TENANT_A, period)).rejects.toMatchObject({ code: 'BILLING_PERIOD_INVALID', status: 422 });
      }
    });

    it('does not bill a period that ended inside the trial', async () => {
      await subscribe(TENANT_B, { price: '10' }, { trialDays: 60, billingAnchor: '2026-01-01', now: new Date('2026-01-01T03:00:00Z') });
      await admin("update machvon.subscription set status = 'Active' where tenant_id = $1 and status = 'Trialing'", [TENANT_B]);
      // The trial ran to 2 March: January and February were free; the pass of the days bills the one that closed last, and February is inside.
      expect((await run(TENANT_B, { start: '2026-01-01', end: '2026-01-31' })).nothingToBill).toBe(1);
      expect((await inTenant(TENANT_B, (tx) => store.runClosedPeriods(tx, recorder(), TODAY))).nothingToBill).toBe(1);
    });

    it('bills a period that the trial ended in from the day the trial ended: the plan for those days and the use from that day', async () => {
      await subscribe(TENANT_A, { price: '3100000', metered: { limit: '100', price: '10' } }, { trialDays: 14, billingAnchor: '2026-01-01', now: new Date('2026-01-01T03:00:00Z') });
      await admin("update machvon.subscription set status = 'Active' where tenant_id = $1 and status = 'Trialing'", [TENANT_A]);
      // 150 calls on 5 January (in the trial) and 130 on 20 January.
      for (const [at, quantity] of [['2026-01-05T05:00:00Z', '150'], ['2026-01-20T05:00:00Z', '130']] as const) {
        await admin("insert into machvon.usage_meter_event (tenant_id, id, meter, external_event_key, quantity, occurred_at, source_reference) values ($1, gen_random_uuid(), 'ai_call', $2, $3::numeric, $4::timestamptz, 'test')", [TENANT_A, randomUUID(), quantity, at]);
      }
      const [made] = (await run(TENANT_A, { start: '2026-01-01', end: '2026-01-31' })).created;
      const lines = await inTenant(TENANT_A, (tx) => store.linesOf(tx, [made?.id as string]));
      // The trial ran to 15 January: 17 of the 31 days are sold, and the use is the 130 of the 20th beyond 100.
      expect(lines.map((line) => [line.kind, line.amountVnd, line.quantity])).toEqual([['SUBSCRIPTION', '1700000', null], ['USAGE', '300', '30']]);
    });

    it('charges only the days after the trial of a proration worked out from a change made during it', async () => {
      const { subscriptionId } = await subscribe(TENANT_B, { price: '1000000' }, { trialDays: 14, billingAnchor: '2026-01-01', now: new Date('2026-01-01T03:00:00Z') });
      const bigger = await plan({ price: '2000000' });
      const day = new Date('2026-01-05T03:00:00Z');
      const preview = await inTenant(TENANT_B, (tx) => subscriptions.preview(tx, { subscriptionId, targetPlanVersionId: bigger, effective: 'NOW', now: day }));
      await inTenant(TENANT_B, (tx) => subscriptions.applyChange(tx, { subscriptionId, targetPlanVersionId: bigger, effective: 'NOW', now: day, previewHash: preview.hash, reason: REASON, expectedVersion: preview.subscription.version, requestedBy: OPERATOR }));
      const stored = (await admin<{ proration_vnd: string }>('select proration_vnd::text from machvon.subscription_plan_change where subscription_id = $1', [subscriptionId]))[0]?.proration_vnd as string;
      const [made] = (await run(TENANT_B, { start: '2026-01-01', end: '2026-01-31' })).created;
      const lines = await inTenant(TENANT_B, (tx) => store.linesOf(tx, [made?.id as string]));
      // From 5 January there are 27 days left in the period; the trial ran to 15 January, so 17 of them are paid.
      expect(lines.map((line) => line.kind)).toEqual(['SUBSCRIPTION', 'ADJUSTMENT']);
      expect(lines[1]?.amountVnd).toBe(((BigInt(stored) * 17n) / 27n).toString());
      expect(BigInt(lines[1]?.amountVnd as string)).toBeLessThan(BigInt(stored));
    });

    it('bills the period that closed last in the daily pass, once', async () => {
      await subscribe(TENANT_A, { price: '10' });
      const first = await inTenant(TENANT_A, (tx) => store.runClosedPeriods(tx, recorder(), TODAY));
      expect(first.created.map((invoice) => [invoice.periodStart, invoice.periodEnd])).toEqual([['2026-02-01', '2026-02-28']]);
      const second = await inTenant(TENANT_A, (tx) => store.runClosedPeriods(tx, recorder(), TODAY));
      expect([second.created.length, second.existing.length]).toEqual([0, 1]);
    });

    it('leaves a trail: an audit row and an event for each invoice made, none for a run that made nothing', async () => {
      await subscribe(TENANT_C, { price: '10' });
      const effects = recorder();
      const made = await run(TENANT_C, FEBRUARY, effects);
      expect(effects.audits.map((entry) => entry.action)).toEqual(['invoice.drafted']);
      expect(effects.events).toEqual([{ type: 'sas.invoice.drafted.v1', eventKey: `invoice:${made.created[0]?.id}:drafted` }]);
      const again = recorder();
      await run(TENANT_C, FEBRUARY, again);
      expect([again.audits.length, again.events.length]).toEqual([0, 0]);
    });
  });

  describe('the plan of the period and the subscriptions that ended', () => {
    it('prices a period on the plan it began on: a downgrade that took effect afterwards does not make the closed period cheaper', async () => {
      const { subscriptionId, planId } = await subscribe(TENANT_A, { price: '1000000' });
      const cheaper = await plan({ price: '400000' });
      // The period of February is current on the 10th; the change waits for the next cycle and takes effect on 1 March.
      await inTenant(TENANT_A, (tx) => subscriptions.runCycle(tx, new Date('2026-02-10T03:00:00Z')));
      const preview = await inTenant(TENANT_A, (tx) => subscriptions.preview(tx, { subscriptionId, targetPlanVersionId: cheaper, effective: 'NEXT_CYCLE', now: new Date('2026-02-10T03:00:00Z') }));
      await inTenant(TENANT_A, (tx) => subscriptions.applyChange(tx, { subscriptionId, targetPlanVersionId: cheaper, effective: 'NEXT_CYCLE', now: new Date('2026-02-10T03:00:00Z'), previewHash: preview.hash, reason: REASON, expectedVersion: preview.subscription.version, requestedBy: OPERATOR }));
      await inTenant(TENANT_A, (tx) => subscriptions.runCycle(tx, new Date('2026-03-02T03:00:00Z')));
      expect((await admin<{ plan_version_id: string }>('select plan_version_id from machvon.subscription where id = $1', [subscriptionId]))[0]?.plan_version_id).toBe(cheaper);
      const february = (await run(TENANT_A)).created[0] as InvoiceRow;
      expect((await inTenant(TENANT_A, (tx) => store.linesOf(tx, [february.id]))).map((line) => line.amountVnd)).toEqual(['1000000']);
      // March, which began on the cheaper plan, is billed on it.
      const march = await inTenant(TENANT_A, (tx) => store.runPeriod(tx, recorder(), { start: '2026-03-01', end: '2026-03-31' }, TODAY));
      expect((await inTenant(TENANT_A, (tx) => store.linesOf(tx, [march.created[0]?.id as string]))).map((line) => line.amountVnd)).toEqual(['400000']);
      expect(planId).not.toBe(cheaper);
    });

    it('bills the last period of a subscription that ended at the end of its period, even when the cycle job ended it before the billing ran, and not one that was ended at once', async () => {
      const { subscriptionId } = await subscribe(TENANT_B, { price: '700000' });
      await admin("update machvon.subscription set status = 'Cancelled', cancel_at_period_end = true, current_period_start = '2026-02-01', current_period_end = '2026-02-28' where id = $1", [subscriptionId]);
      const daily = await inTenant(TENANT_B, (tx) => store.runClosedPeriods(tx, recorder(), TODAY));
      expect(daily.created.map((invoice) => [invoice.periodStart, invoice.periodEnd, invoice.totalVnd])).toEqual([['2026-02-01', '2026-02-28', '700000']]);
      // A second pass, and a manual run of the same period, find it.
      expect((await inTenant(TENANT_B, (tx) => store.runClosedPeriods(tx, recorder(), TODAY))).existing).toHaveLength(1);
      expect((await run(TENANT_B)).existing).toHaveLength(1);
      // The period after the last one is nobody's: nothing is billed for it.
      expect((await run(TENANT_B, { start: '2026-03-01', end: '2026-03-31' })).created).toEqual([]);
      // A subscription cancelled at once (a trial given up) has no last period to bill.
      const second = await subscribe(TENANT_C, { price: '700000' });
      await admin("update machvon.subscription set status = 'Cancelled', cancel_at_period_end = false, current_period_start = '2026-02-01', current_period_end = '2026-02-28' where id = $1", [second.subscriptionId]);
      expect((await inTenant(TENANT_C, (tx) => store.runClosedPeriods(tx, recorder(), TODAY))).created).toEqual([]);
      expect((await run(TENANT_C)).created).toEqual([]);
    });

    it('takes the days to pay from the payment terms of the subscription, as they are stored', async () => {
      await subscribe(TENANT_C, { price: '50000' }, { paymentTerms: { dueDays: 30, method: 'BANK_TRANSFER' } });
      const made = (await run(TENANT_C)).created[0] as InvoiceRow;
      expect(made.dueAt).toBe('2026-03-30');
    });

    it('charges an immediate upgrade of the first day of the period once: the plan the period began on, and the whole difference as the proration', async () => {
      const { subscriptionId } = await subscribe(TENANT_A, { price: '1000000' });
      const bigger = await plan({ price: '2000000' });
      const day = new Date('2026-02-01T03:00:00Z');
      await inTenant(TENANT_A, (tx) => subscriptions.runCycle(tx, day));
      const preview = await inTenant(TENANT_A, (tx) => subscriptions.preview(tx, { subscriptionId, targetPlanVersionId: bigger, effective: 'NOW', now: day }));
      await inTenant(TENANT_A, (tx) => subscriptions.applyChange(tx, { subscriptionId, targetPlanVersionId: bigger, effective: 'NOW', now: day, previewHash: preview.hash, reason: REASON, expectedVersion: preview.subscription.version, requestedBy: OPERATOR }));
      const made = (await run(TENANT_A)).created[0] as InvoiceRow;
      const lines = await inTenant(TENANT_A, (tx) => store.linesOf(tx, [made.id]));
      expect(lines.map((line) => [line.kind, line.amountVnd])).toEqual([['SUBSCRIPTION', '1000000'], ['ADJUSTMENT', '1000000']]);
    });

    it('charges the proration of a discarded draft again on the invoice that takes its place', async () => {
      const { subscriptionId } = await subscribe(TENANT_B, { price: '1000000' });
      const bigger = await plan({ price: '2000000' });
      const day = new Date('2026-02-10T03:00:00Z');
      await inTenant(TENANT_B, (tx) => subscriptions.runCycle(tx, day));
      const preview = await inTenant(TENANT_B, (tx) => subscriptions.preview(tx, { subscriptionId, targetPlanVersionId: bigger, effective: 'NOW', now: day }));
      await inTenant(TENANT_B, (tx) => subscriptions.applyChange(tx, { subscriptionId, targetPlanVersionId: bigger, effective: 'NOW', now: day, previewHash: preview.hash, reason: REASON, expectedVersion: preview.subscription.version, requestedBy: OPERATOR }));
      const first = (await run(TENANT_B)).created[0] as InvoiceRow;
      await admin("update machvon.invoice set status = 'Discarded', version = version + 1 where id = $1", [first.id]);
      const second = (await run(TENANT_B)).created[0] as InvoiceRow;
      const lines = await inTenant(TENANT_B, (tx) => store.linesOf(tx, [second.id]));
      expect(lines.map((line) => line.kind)).toEqual(['SUBSCRIPTION', 'ADJUSTMENT']);
      expect(second.totalVnd).toBe(first.totalVnd);
      const charged = await admin<{ invoiced_invoice_id: string }>('select invoiced_invoice_id from machvon.subscription_plan_change where subscription_id = $1', [subscriptionId]);
      expect(charged[0]?.invoiced_invoice_id).toBe(second.id);
      // Once an invoice that was not discarded holds it, the proration does not move again.
      expect((await sqlError('update machvon.subscription_plan_change set invoiced_invoice_id = $2 where subscription_id = $1', [subscriptionId, first.id]))?.code).toBe('23514');
    });

    it('gives the invoice that takes the place of a discarded draft its own code', async () => {
      await subscribe(TENANT_A, { price: '50000' });
      const first = (await run(TENANT_A)).created[0] as InvoiceRow;
      await admin("update machvon.invoice set status = 'Discarded', version = version + 1 where id = $1", [first.id]);
      const second = (await run(TENANT_A)).created[0] as InvoiceRow;
      expect(second.id).not.toBe(first.id);
      expect([first.invoiceCode, second.invoiceCode]).toEqual([first.invoiceCode, `${first.invoiceCode}-2`]);
      // And it is the one original of the period: another run finds it.
      expect((await run(TENANT_A)).existing.map((invoice) => invoice.id)).toEqual([second.id]);
    });
  });

  describe('the list of invoices', () => {
    it('pages by the period, the latest first, and finds the older invoices on the next page', async () => {
      const { subscriptionId } = await subscribe(TENANT_C, { price: '10' });
      for (const [start, end] of [['2026-01-01', '2026-01-31'], ['2026-02-01', '2026-02-28'], ['2026-03-01', '2026-03-31']] as const) {
        await inTenant(TENANT_C, (tx) => store.runPeriod(tx, recorder(), { start, end }, TODAY));
      }
      const all = await inTenant(TENANT_C, (tx) => store.list(tx, { subscriptionId, limit: 10 }));
      expect(all.map((invoice) => invoice.periodStart)).toEqual(['2026-03-01', '2026-02-01', '2026-01-01']);
      const first = await inTenant(TENANT_C, (tx) => store.list(tx, { subscriptionId, limit: 2 }));
      const last = first[first.length - 1] as InvoiceRow;
      const second = await inTenant(TENANT_C, (tx) => store.list(tx, { subscriptionId, limit: 2, after: { periodStart: last.periodStart, id: last.id } }));
      expect([...first, ...second].map((invoice) => invoice.periodStart)).toEqual(['2026-03-01', '2026-02-01', '2026-01-01']);
    });
  });

  describe('the issue through the provider', () => {
    async function draft(tenant = TENANT_A): Promise<InvoiceRow> {
      await subscribe(tenant, { price: '1000000', vat: 'VAT_10' });
      return (await run(tenant)).created[0] as InvoiceRow;
    }
    const issue = (provider: MockEInvoiceProvider, invoice: InvoiceRow, effects = recorder(), at = NOW, tenant = TENANT_A) =>
      inTenant(tenant, (tx) => store.issue(tx, effects, provider, invoice.id, invoice.version, at));

    it('issues a Draft once: it becomes Issued with the number, template, series and codes of the provider, and a second issue is 409 EINVOICE_STATE_INVALID', async () => {
      const provider = newProvider();
      const invoice = await draft();
      const effects = recorder();
      const first = await issue(provider, invoice, effects);
      expect(first.outcome).toBe('ISSUED');
      expect(first.invoice).toMatchObject({ status: 'Issued', provider: 'MOCK', templateCode: '1', series: 'C26TMV', number: numberOf(invoice.id), issueAttempts: 1, version: invoice.version + 2 });
      expect(first.invoice.taxAuthorityCode).toMatch(/^CQT/);
      expect(first.invoice.lookupCode).toHaveLength(12);
      expect(effects.audits.map((entry) => entry.action)).toEqual(['invoice.issued']);
      expect(effects.events.map((event) => event.type)).toEqual(['sas.invoice.issued.v1']);
      await expect(issue(provider, first.invoice)).rejects.toMatchObject({ code: 'EINVOICE_STATE_INVALID', status: 409 });
      expect(provider.issuedCount).toBe(1);
    });

    it('refuses the issue of an invoice that changed since the command was prepared, and one that does not exist', async () => {
      const provider = newProvider();
      const invoice = await draft(TENANT_B);
      await expect(inTenant(TENANT_B, (tx) => store.issue(tx, recorder(), provider, invoice.id, invoice.version + 5, NOW))).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await expect(inTenant(TENANT_B, (tx) => store.issue(tx, recorder(), provider, randomUUID(), undefined, NOW))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(provider.calls).toBe(0);
    });

    it('keeps the invoice PendingIssue when the provider answers 503, asks again on the schedule, and ends with one invoice at the provider', async () => {
      const provider = newProvider();
      const invoice = await draft();
      provider.failNext(2);
      const first = await issue(provider, invoice);
      expect(first.outcome).toBe('PENDING');
      expect(first.invoice).toMatchObject({ status: 'PendingIssue', issueAttempts: 1, issueError: 'EINVOICE_PROVIDER_UNAVAILABLE' });
      expect(first.invoice.nextAttemptAt).toEqual(new Date(NOW.getTime() + 10 * 60_000));
      // Not yet time: nothing is asked.
      expect(await inTenant(TENANT_A, (tx) => store.retryDue(tx, recorder(), provider, new Date(NOW.getTime() + 5 * 60_000)))).toEqual([]);
      const second = await inTenant(TENANT_A, (tx) => store.retryDue(tx, recorder(), provider, new Date(NOW.getTime() + 11 * 60_000)));
      expect(second.map((entry) => [entry.outcome, entry.invoice.issueAttempts])).toEqual([['PENDING', 2]]);
      const third = await inTenant(TENANT_A, (tx) => store.retryDue(tx, recorder(), provider, new Date(NOW.getTime() + 2 * 3_600_000)));
      expect(third.map((entry) => [entry.outcome, entry.invoice.status, entry.invoice.issueAttempts])).toEqual([['ISSUED', 'Issued', 3]]);
      expect(provider.calls).toBe(3);
      expect(provider.issuedCount).toBe(1);
    });

    it('ends in IssueFailed after five attempts, tells so once, and issues again with the same reference key without a second invoice at the provider', async () => {
      const provider = newProvider();
      const invoice = await draft();
      provider.failNext(5);
      let current = (await issue(provider, invoice)).invoice;
      const effects = recorder();
      for (let step = 1; step <= 4; step += 1) {
        const at = new Date(Math.max(NOW.getTime(), (current.nextAttemptAt as Date).getTime()));
        const [outcome] = await inTenant(TENANT_A, (tx) => store.retryDue(tx, effects, provider, at));
        current = (outcome as { invoice: InvoiceRow }).invoice;
      }
      expect(current).toMatchObject({ status: 'IssueFailed', issueAttempts: 5, nextAttemptAt: null });
      expect(effects.audits.map((entry) => entry.action)).toEqual(['invoice.issue_failed']);
      expect(await inTenant(TENANT_A, (tx) => store.failedCount(tx))).toBe(1);
      // Nothing is asked of a failed invoice by the clock.
      expect(await inTenant(TENANT_A, (tx) => store.retryDue(tx, recorder(), provider, new Date(NOW.getTime() + 48 * 3_600_000)))).toEqual([]);
      const again = await inTenant(TENANT_A, (tx) => store.issue(tx, recorder(), provider, current.id, current.version, new Date(NOW.getTime() + 49 * 3_600_000)));
      expect(again.outcome).toBe('ISSUED');
      expect(provider.issuedCount).toBe(1);
      expect(await inTenant(TENANT_A, (tx) => store.failedCount(tx))).toBe(0);
    });

    it('does not ask the provider once the 24 hours are over: a worker that comes back late ends the tries without a call, even if the provider would answer', async () => {
      const provider = newProvider();
      const invoice = await draft();
      provider.failNext(1);
      expect((await issue(provider, invoice)).outcome).toBe('PENDING');
      const calls = provider.calls;
      const effects = recorder();
      const [late] = await inTenant(TENANT_A, (tx) => store.retryDue(tx, effects, provider, new Date(NOW.getTime() + 25 * 3_600_000)));
      expect(late?.outcome).toBe('FAILED');
      expect(late?.invoice).toMatchObject({ status: 'IssueFailed', issueAttempts: 1 });
      expect(provider.calls).toBe(calls);
      expect(provider.issuedCount).toBe(0);
      expect(effects.audits.map((entry) => entry.action)).toEqual(['invoice.issue_failed']);
    });

    it('freezes what the invoice says from the first attempt to issue it: a retry finds the invoice that was asked about, and only the bookkeeping of the attempts moves', async () => {
      const provider = newProvider();
      const invoice = await draft();
      provider.failNext(1);
      const waiting = (await issue(provider, invoice)).invoice;
      expect(waiting.status).toBe('PendingIssue');
      for (const statement of ['update machvon.invoice set subtotal_vnd = 1, total_vnd = 1 + vat_vnd where id = $1', "update machvon.invoice set buyer_snapshot = '{}' where id = $1", "update machvon.invoice set period_end = '2026-03-31' where id = $1", "update machvon.invoice set due_at = '2030-01-01' where id = $1"]) {
        const error = await sqlError(statement, [invoice.id]);
        expect([error?.code, error?.message.includes('EINVOICE_IMMUTABLE')]).toEqual(['23514', true]);
      }
      expect(await sqlError("update machvon.invoice set issue_attempts = 2, issue_error = 'x', version = version + 1 where id = $1", [invoice.id])).toBeUndefined();
      // Left as a failed invoice, so that the passes of the tests after it do not find it waiting.
      await admin("update machvon.invoice set status = 'IssueFailed', next_attempt_at = null, version = version + 1 where id = $1", [invoice.id]);
    });

    it('stops asking when the next attempt would fall after 24 hours from the first', async () => {
      const provider = newProvider();
      const invoice = await draft();
      provider.failNext(3);
      let current = (await issue(provider, invoice)).invoice;
      // The second and third attempts are made late (a stopped worker): the fourth would be more than a day after the first.
      for (const hours of [1, 21]) {
        const [outcome] = await inTenant(TENANT_A, (tx) => store.retryDue(tx, recorder(), provider, new Date(NOW.getTime() + hours * 3_600_000)));
        current = (outcome as { invoice: InvoiceRow }).invoice;
      }
      expect(current.status).toBe('IssueFailed');
      expect(current.issueAttempts).toBe(3);
    });
  });

  describe('the invoice that was issued', () => {
    let issued: InvoiceRow;
    beforeAll(async () => {
      await subscribe(TENANT_B, { price: '2000000', vat: 'VAT_10' });
      const made = (await run(TENANT_B)).created[0] as InvoiceRow;
      issued = (await inTenant(TENANT_B, (tx) => store.issue(tx, recorder(), newProvider(), made.id, made.version, NOW))).invoice;
    });

    it('is never edited: not its totals, its lines, its buyer or its number', async () => {
      for (const statement of ['update machvon.invoice set total_vnd = 1, subtotal_vnd = 1, vat_vnd = 0 where id = $1', "update machvon.invoice set buyer_snapshot = '{}' where id = $1", "update machvon.invoice set einvoice_number = 'X' where id = $1", "update machvon.invoice set due_at = '2030-01-01' where id = $1"]) {
        const error = await sqlError(statement, [issued.id]);
        expect(error?.code).toBe('23514');
        expect(error?.message).toContain('EINVOICE_IMMUTABLE');
      }
      // A line of a draft of the same tenant cannot be moved onto the issued invoice either.
      const moved = await sqlError('update machvon.invoice_line set invoice_id = $1, line_no = 99 where id = (select l.id from machvon.invoice_line l join machvon.invoice i on i.tenant_id = l.tenant_id and i.id = l.invoice_id where i.status = \'Draft\' and l.tenant_id = (select tenant_id from machvon.invoice where id = $1) limit 1)', [issued.id]);
      expect(moved?.code).toBe('23514');
      for (const statement of ['update machvon.invoice_line set amount_vnd = 1 where invoice_id = $1', 'delete from machvon.invoice_line where invoice_id = $1', "insert into machvon.invoice_line (tenant_id, id, invoice_id, line_no, line_kind, description, amount_vnd, vat_category, vat_vnd) select tenant_id, gen_random_uuid(), id, 9, 'SUBSCRIPTION', 'x', 1, 'NOT_SUBJECT', 0 from machvon.invoice where id = $1"]) {
        expect((await sqlError(statement, [issued.id]))?.code).toBe('23514');
      }
    });

    it('is never deleted, and has no state to be cancelled in', async () => {
      expect((await sqlError('delete from machvon.invoice where id = $1', [issued.id]))?.code).toMatch(/^(23514|42501)$/);
      expect((await sqlError("update machvon.invoice set status = 'Cancelled' where id = $1", [issued.id]))?.code).toBe('23514');
      const names = await admin<{ name: string }>(
        `select column_name as name from information_schema.columns where table_schema = 'machvon' and table_name in ('invoice', 'invoice_line') and column_name ilike '%cancel%'
         union all select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'machvon' and proname ilike '%invoice%' and proname ilike '%cancel%'`,
      );
      expect(names).toEqual([]);
      const states = await admin<{ definition: string }>("select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'machvon.invoice'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%PendingIssue%' and pg_get_constraintdef(oid) like '%Draft%'");
      expect(states.some((row) => /cancel/i.test(row.definition))).toBe(false);
    });

    it('moves only along the chain of statuses: it can be paid, not drafted again', async () => {
      expect((await sqlError("update machvon.invoice set status = 'Draft' where id = $1", [issued.id]))?.message).toContain('EINVOICE_STATE_INVALID');
      expect((await sqlError("update machvon.invoice set status = 'PendingIssue' where id = $1", [issued.id]))?.code).toBe('23514');
      expect(await sqlError("update machvon.invoice set status = 'Sent', version = version + 1 where id = $1", [issued.id])).toBeUndefined();
      expect(await sqlError("update machvon.invoice set status = 'Paid', version = version + 1 where id = $1", [issued.id])).toBeUndefined();
    });

    it('holds the invoice while a line is being written, so that it cannot go out for issue between the look at its status and the commit of the line', async () => {
      await subscribe(TENANT_A, { price: '3000' });
      const made = (await run(TENANT_A)).created[0] as InvoiceRow;
      const writer = new Client({ connectionString: harness.database.adminUrl });
      const issuer = new Client({ connectionString: harness.database.adminUrl });
      await Promise.all([writer.connect(), issuer.connect()]);
      try {
        await writer.query('begin');
        await writer.query("update machvon.invoice_line set description = 'edited' where invoice_id = $1", [made.id]);
        await issuer.query("set statement_timeout = '600ms'");
        // The invoice cannot go out until the line is committed.
        await expect(issuer.query("update machvon.invoice set status = 'PendingIssue', issue_started_at = now() where id = $1", [made.id])).rejects.toMatchObject({ code: '57014' });
        await writer.query('commit');
        await issuer.query("update machvon.invoice set status = 'PendingIssue', issue_started_at = now() where id = $1", [made.id]);
        // And a line is refused once it has.
        expect((await sqlError("update machvon.invoice_line set description = 'late' where invoice_id = $1", [made.id]))?.code).toBe('23514');
      } finally {
        await writer.query('rollback').catch(() => undefined);
        await Promise.all([writer.end(), issuer.end()]);
      }
    });

    it('does not go out for issue unless its lines add up to its totals', async () => {
      await subscribe(TENANT_C, { price: '3000' });
      const made = (await run(TENANT_C)).created[0] as InvoiceRow;
      expect((await sqlError("update machvon.invoice set subtotal_vnd = 4000, total_vnd = 4000, status = 'PendingIssue', issue_started_at = now() where id = $1", [made.id]))?.message).toContain('do not add up');
    });
  });

  describe('the days that pass', () => {
    async function issuedDue(tenant: string, dueAt: string): Promise<InvoiceRow> {
      await subscribe(tenant, { price: '100000' });
      const made = (await run(tenant)).created[0] as InvoiceRow;
      const done = (await inTenant(tenant, (tx) => store.issue(tx, recorder(), newProvider(), made.id, made.version, NOW))).invoice;
      // The due day is part of what was issued; a test that wants another day moves the clock of the invoice with the table owner and its guard out of the way.
      await admin('alter table machvon.invoice disable trigger invoice_guard');
      await admin('update machvon.invoice set due_at = $2::date where id = $1', [done.id, dueAt]);
      await admin('alter table machvon.invoice enable trigger invoice_guard');
      return done;
    }

    it('marks an issued invoice Overdue the day after its due day and the subscription PastDue, and changes nothing of the tenant or its license', async () => {
      const invoice = await issuedDue(TENANT_A, '2026-03-05');
      const tenantBefore = await admin("select status from machvon.tenant where id = $1", [TENANT_A]);
      const licensesBefore = await admin('select id, status from machvon.license_revision where tenant_id = $1 order by id', [TENANT_A]);
      // The due day itself is not late.
      const onTheDay = await inTenant(TENANT_A, (tx) => store.sweepOverdue(tx, recorder(), '2026-03-05', NOW));
      expect(onTheDay.overdue).toEqual([]);
      const effects = recorder();
      const next = new Date('2026-03-06T03:00:00Z');
      const swept = await inTenant(TENANT_A, (tx) => store.sweepOverdue(tx, effects, '2026-03-06', next));
      expect(swept.overdue.map((entry) => [entry.id, entry.status])).toEqual([[invoice.id, 'Overdue']]);
      expect(swept.pastDue).toHaveLength(1);
      expect(effects.audits.map((entry) => entry.action)).toEqual(['invoice.overdue', 'subscription.past_due']);
      const subscription = await admin<{ status: string; past_due_since: Date }>('select status, past_due_since from machvon.subscription where id = $1', [invoice.subscriptionId]);
      expect(subscription[0]?.status).toBe('PastDue');
      expect(subscription[0]?.past_due_since).toEqual(next);
      expect(await admin('select status from machvon.tenant where id = $1', [TENANT_A])).toEqual(tenantBefore);
      expect(await admin('select id, status from machvon.license_revision where tenant_id = $1 order by id', [TENANT_A])).toEqual(licensesBefore);
      // A second pass of the same day changes nothing.
      expect(await inTenant(TENANT_A, (tx) => store.sweepOverdue(tx, recorder(), '2026-03-06', next))).toEqual({ overdue: [], pastDue: [], suspensionProposed: [] });
    });

    it('proposes a suspension after thirty days past due, once, and suspends nothing', async () => {
      await issuedDue(TENANT_B, '2026-03-05');
      await inTenant(TENANT_B, (tx) => store.sweepOverdue(tx, recorder(), '2026-03-06', new Date('2026-03-06T03:00:00Z')));
      const early = await inTenant(TENANT_B, (tx) => store.sweepOverdue(tx, recorder(), '2026-04-04', new Date('2026-04-04T03:00:00Z')));
      expect(early.suspensionProposed).toEqual([]);
      const effects = recorder();
      const late = await inTenant(TENANT_B, (tx) => store.sweepOverdue(tx, effects, '2026-04-05', new Date('2026-04-05T03:00:00Z')));
      expect(late.suspensionProposed).toHaveLength(1);
      expect(effects.audits.map((entry) => entry.action)).toEqual(['billing.suspension_proposed']);
      expect(effects.events.map((event) => event.type)).toEqual(['sas.billing.suspension_proposed.v1']);
      const again = await inTenant(TENANT_B, (tx) => store.sweepOverdue(tx, recorder(), '2026-04-06', new Date('2026-04-06T03:00:00Z')));
      expect(again.suspensionProposed).toEqual([]);
      expect((await admin<{ status: string }>('select status from machvon.tenant where id = $1', [TENANT_B]))[0]?.status).toBe('Active');
      expect((await admin<{ status: string }>("select status from machvon.subscription where tenant_id = $1 and status <> 'Cancelled'", [TENANT_B]))[0]?.status).toBe('PastDue');
    });
  });
});
