import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { ControlDatabase } from '../src/control-database';
import { MemberStore } from '../src/member-store';
import { SubscriptionStore } from '../src/subscription-store';
import type { ApplyPlanChangeInput, CreateSubscriptionInput } from '../src/subscription-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const store = new SubscriptionStore();
const members = new MemberStore();
const CTX_A = contextFor(TENANT_A, memberId(1));
const OPERATOR = '00000000-0000-4000-8000-0000000000a1';
const NOW = new Date('2026-02-15T06:00:00Z');
const REASON = 'The customer asked for the larger plan.';

interface PlanSeed {
  code: string;
  price: string;
  cycles?: string[];
  status?: 'Published' | 'Draft';
  seats?: number;
}

describe('SubscriptionStore', () => {
  const harness = new AuthzHarness();
  let counter = 0;
  // The plans are control-plane tables, so the subscription is judged by the control role acting as the tenant, as the commands and the cycle job do.
  let control: ControlDatabase;
  let controlPool: Pool;
  const inA = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => control.withTenantOf(TENANT_A, work);
  const inB = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => control.withTenantOf(TENANT_B, work);
  /** The tenant plane of tenant A: where a member is invited, accepted and counted. */
  const asMember = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant(CTX_A, work);

  const admin = async <T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(text, params)).rows as T[];
    } finally {
      await client.end();
    }
  };
  const sqlState = async (text: string, params: unknown[] = []): Promise<string | undefined> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query(text, params);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    } finally {
      await client.end();
    }
  };

  /** A plan with the features a plan change looks at: a seat quota and a switch. Published, or left a draft. */
  async function plan(seed: PlanSeed): Promise<string> {
    counter += 1;
    const id = randomUUID();
    await admin(
      `insert into machvon.product_plan_version (id, plan_code, revision, name, status, billing_cycles, base_price_vnd, vat_category, legal_terms_ref)
       values ($1, $2, 1, $3, 'Draft', $4::text[], $5::numeric, 'NOT_SUBJECT', 'TERMS-1')`,
      [id, `${seed.code}-${counter}`, seed.code, seed.cycles ?? ['ANNUAL', 'MONTHLY'], seed.price],
    );
    await admin(
      `insert into machvon.plan_feature (id, plan_version_id, feature_code, limit_kind, limit_value, grace_behavior, expired_behavior) values
         (gen_random_uuid(), $1, 'reporting', 'BOOLEAN', null, 'ALLOW', 'READ_ONLY'),
         (gen_random_uuid(), $1, 'member.seats', 'QUOTA', $2::numeric, 'READ_ONLY', 'DENY')`,
      [id, seed.seats ?? 50],
    );
    if (seed.status !== 'Draft') await admin("update machvon.product_plan_version set status = 'Published', published_by = $2, published_at = now() where id = $1", [id, OPERATOR]);
    return id;
  }

  const input = (planVersionId: string, overrides: Partial<CreateSubscriptionInput> = {}): CreateSubscriptionInput => ({
    planVersionId,
    cycle: 'ANNUAL',
    billingAnchor: '2026-01-01',
    trialDays: 0,
    paymentTerms: { dueDays: 30, method: 'BANK_TRANSFER' },
    now: NOW,
    ...overrides,
  });

  const entitlementVersions = (tenantId: string): Promise<Array<{ version_no: string; plan_version_id: string; cause: string; features: Array<{ featureCode: string; limitValue?: number }> }>> =>
    admin('select version_no::text as version_no, plan_version_id, cause, features_json as features from machvon.entitlement_version where tenant_id = $1 order by machvon.entitlement_version.version_no', [tenantId]);
  const outboxCount = async (tenantId: string): Promise<number> =>
    Number((await admin<{ n: string }>("select count(*) as n from machvon.outbox_event where tenant_id = $1 and type = 'sas.entitlement.changed.v1'", [tenantId]))[0]?.n);

  beforeAll(async () => {
    await harness.start();
    controlPool = new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 4 });
    controlPool.on('error', () => undefined);
    control = new ControlDatabase(controlPool);
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/u1/' }]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: '/u1/' }]);
    for (let n = 1; n <= 5; n += 1) await harness.seedMembership(TENANT_A, n, 1);
  }, 180_000);
  afterAll(async () => {
    await controlPool?.end();
    await harness.stop();
  }, 60_000);

  // Each test works on a tenant of its own, because a tenant has one live subscription: the two tenants of the harness are cleared between tests.
  beforeEach(async () => {
    for (const tenant of [TENANT_A, TENANT_B]) {
      await admin("update machvon.subscription set status = 'Cancelled' where tenant_id = $1", [tenant]);
    }
  });

  describe('create', () => {
    it('starts an Active subscription on a published plan, with the period of its anchor, and records the entitlements of the plan', async () => {
      const planId = await plan({ code: 'create-active', price: '365000000' });
      const created = await inA((tx) => store.create(tx, input(planId, { procurementContractRef: 'HD-2026/001' })));
      expect(created).toMatchObject({
        planVersionId: planId,
        cycle: 'ANNUAL',
        billingAnchor: '2026-01-01',
        status: 'Active',
        currentPeriodStart: '2026-01-01',
        currentPeriodEnd: '2026-12-31',
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        pendingPlanVersionId: null,
        procurementContractRef: 'HD-2026/001',
        paymentTerms: { dueDays: 30, method: 'BANK_TRANSFER' },
        version: 1,
      });
      const versions = await entitlementVersions(TENANT_A);
      const last = versions[versions.length - 1];
      expect(last).toMatchObject({ plan_version_id: planId, cause: 'SUBSCRIPTION_CHANGE' });
      expect(last?.features.map((feature) => feature.featureCode)).toEqual(['member.seats', 'reporting']);
      expect(await outboxCount(TENANT_A)).toBeGreaterThanOrEqual(versions.length);
    });

    it('starts a trial when the days are above zero, ending that many days after the anchor', async () => {
      const planId = await plan({ code: 'create-trial', price: '0' });
      const created = await inA((tx) => store.create(tx, input(planId, { trialDays: 30, billingAnchor: '2026-02-01' })));
      expect(created.status).toBe('Trialing');
      expect(created.trialEndsAt).toEqual(new Date('2026-03-03T00:00:00Z'));
      expect(created.currentPeriodStart).toBe('2026-02-01');
    });

    it('takes the period of the first cycle when the anchor is still ahead', async () => {
      const planId = await plan({ code: 'create-future', price: '1', cycles: ['MONTHLY'] });
      const created = await inA((tx) => store.create(tx, input(planId, { cycle: 'MONTHLY', billingAnchor: '2026-04-15' })));
      expect([created.currentPeriodStart, created.currentPeriodEnd]).toEqual(['2026-04-15', '2026-05-14']);
    });

    it('finds the period of today when the anchor is in the past', async () => {
      const planId = await plan({ code: 'create-past', price: '1', cycles: ['MONTHLY'] });
      const created = await inA((tx) => store.create(tx, input(planId, { cycle: 'MONTHLY', billingAnchor: '2025-11-20' })));
      expect([created.currentPeriodStart, created.currentPeriodEnd]).toEqual(['2026-01-20', '2026-02-19']);
    });

    it('refuses a second live subscription with 409 SUBSCRIPTION_EXISTS, and allows one once the first is cancelled', async () => {
      const planId = await plan({ code: 'create-twice', price: '1' });
      await inA((tx) => store.create(tx, input(planId)));
      await expect(inA((tx) => store.create(tx, input(planId)))).rejects.toMatchObject({ code: 'SUBSCRIPTION_EXISTS', status: 409 });
      await admin("update machvon.subscription set status = 'Cancelled' where tenant_id = $1", [TENANT_A]);
      await expect(inA((tx) => store.create(tx, input(planId)))).resolves.toMatchObject({ status: 'Active' });
    });

    it('lets only one of two concurrent creations through', async () => {
      const planId = await plan({ code: 'create-race', price: '1' });
      const outcomes = await Promise.allSettled([inB((tx) => store.create(tx, input(planId))), inB((tx) => store.create(tx, input(planId)))]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect((outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')?.reason as { code: string }).code).toBe('SUBSCRIPTION_EXISTS');
    });

    it('refuses a plan that is a draft with 409 PLAN_NOT_PUBLISHED, an unknown plan and a cycle the plan does not sell, and writes nothing', async () => {
      const draft = await plan({ code: 'create-draft', price: '1', status: 'Draft' });
      const annualOnly = await plan({ code: 'create-annual', price: '1', cycles: ['ANNUAL'] });
      const before = await entitlementVersions(TENANT_A);
      await expect(inA((tx) => store.create(tx, input(draft)))).rejects.toMatchObject({ code: 'PLAN_NOT_PUBLISHED', status: 409 });
      await expect(inA((tx) => store.create(tx, input(randomUUID())))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'plan_version_id' });
      await expect(inA((tx) => store.create(tx, input(annualOnly, { cycle: 'MONTHLY' })))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'cycle' });
      expect(await inA((tx) => store.live(tx))).toBeUndefined();
      expect(await entitlementVersions(TENANT_A)).toHaveLength(before.length);
    });
  });

  describe('preview (UAT-AC155)', () => {
    let from: string;
    let to: string;
    beforeEach(async () => {
      from = await plan({ code: 'from', price: '365000000', seats: 50 });
      to = await plan({ code: 'to', price: '730000000', seats: 100 });
      await inA((tx) => store.create(tx, input(from)));
    });

    it('charges 320,000,000 VND for the upgrade of a 365-day year on day 46, effective today', async () => {
      const live = await inA((tx) => store.live(tx));
      const preview = await inA((tx) => store.preview(tx, { subscriptionId: live?.id ?? '', targetPlanVersionId: to, effective: 'NOW', now: NOW }));
      expect(preview).toMatchObject({ prorationVnd: '320000000', fromPriceVnd: '365000000', toPriceVnd: '730000000', violations: [], effectiveAt: new Date('2026-02-15T00:00:00Z') });
      expect(preview.facts).toMatchObject({ periodStart: '2026-01-01', periodEnd: '2026-12-31', today: '2026-02-15', prorationVnd: '320000000' });
      expect(preview.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is the same preview, with the same token, when asked again on the same day', async () => {
      const live = await inA((tx) => store.live(tx));
      const request = { subscriptionId: live?.id ?? '', targetPlanVersionId: to, effective: 'NOW' as const, now: NOW };
      const [first, second] = [await inA((tx) => store.preview(tx, request)), await inA((tx) => store.preview(tx, { ...request, now: new Date('2026-02-15T23:59:00Z') }))];
      expect(second.hash).toBe(first.hash);
      const tomorrow = await inA((tx) => store.preview(tx, { ...request, now: new Date('2026-02-16T00:01:00Z') }));
      expect(tomorrow.hash).not.toBe(first.hash);
      expect(BigInt(tomorrow.prorationVnd)).toBeLessThan(BigInt(first.prorationVnd));
    });

    it('charges nothing for a change at the next cycle, which takes effect the day after the period ends', async () => {
      const live = await inA((tx) => store.live(tx));
      const preview = await inA((tx) => store.preview(tx, { subscriptionId: live?.id ?? '', targetPlanVersionId: to, effective: 'NEXT_CYCLE', now: NOW }));
      expect([preview.prorationVnd, preview.effectiveAt]).toEqual(['0', new Date('2027-01-01T00:00:00Z')]);
    });

    it('lists the quota of the new plan that the tenant is already over (AC-ST-SAS-008-2)', async () => {
      const smaller = await plan({ code: 'smaller', price: '100000000', seats: 3 });
      const live = await inA((tx) => store.live(tx));
      const preview = await inA((tx) => store.preview(tx, { subscriptionId: live?.id ?? '', targetPlanVersionId: smaller, effective: 'NEXT_CYCLE', now: NOW }));
      expect(preview.violations).toEqual([{ featureCode: 'member.seats', used: '5', newLimit: '3' }]);
      expect(preview.prorationVnd).toBe('0');
    });

    it('refuses a change now that is not an upgrade, a plan that is the one it is on, and a plan that does not sell the cycle', async () => {
      const cheaper = await plan({ code: 'cheaper', price: '100' });
      const equal = await plan({ code: 'equal', price: '365000000' });
      const monthly = await plan({ code: 'monthly-only', price: '999999999', cycles: ['MONTHLY'] });
      const live = await inA((tx) => store.live(tx));
      const ask = (target: string, effective: 'NOW' | 'NEXT_CYCLE') => inA((tx) => store.preview(tx, { subscriptionId: live?.id ?? '', targetPlanVersionId: target, effective, now: NOW }));
      await expect(ask(cheaper, 'NOW')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'effective' });
      await expect(ask(equal, 'NOW')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'effective' });
      await expect(ask(cheaper, 'NEXT_CYCLE')).resolves.toMatchObject({ prorationVnd: '0' });
      await expect(ask(from, 'NEXT_CYCLE')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'target_plan_version_id' });
      await expect(ask(monthly, 'NEXT_CYCLE')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'target_plan_version_id' });
    });

    it('refuses a plan that is a draft, a subscription that does not exist, and one that is over', async () => {
      const draft = await plan({ code: 'draft-target', price: '999', status: 'Draft' });
      const live = await inA((tx) => store.live(tx));
      await expect(inA((tx) => store.preview(tx, { subscriptionId: live?.id ?? '', targetPlanVersionId: draft, effective: 'NOW', now: NOW }))).rejects.toMatchObject({ code: 'PLAN_NOT_PUBLISHED', status: 409 });
      await expect(inA((tx) => store.preview(tx, { subscriptionId: randomUUID(), targetPlanVersionId: to, effective: 'NOW', now: NOW }))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      await admin("update machvon.subscription set status = 'Cancelled' where id = $1", [live?.id]);
      await expect(inA((tx) => store.preview(tx, { subscriptionId: live?.id ?? '', targetPlanVersionId: to, effective: 'NOW', now: NOW }))).rejects.toMatchObject({ code: 'SUBSCRIPTION_STATE_INVALID', status: 409 });
    });

    it('does not preview the subscription of another tenant', async () => {
      const live = await inA((tx) => store.live(tx));
      await expect(inB((tx) => store.preview(tx, { subscriptionId: live?.id ?? '', targetPlanVersionId: to, effective: 'NOW', now: NOW }))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('is no state change: the preview writes no row and no entitlement version', async () => {
      const live = await inA((tx) => store.live(tx));
      const versions = (await entitlementVersions(TENANT_A)).length;
      await inA((tx) => store.preview(tx, { subscriptionId: live?.id ?? '', targetPlanVersionId: to, effective: 'NOW', now: NOW }));
      expect(await inA((tx) => store.changes(tx, live?.id ?? '', 10))).toEqual([]);
      expect((await entitlementVersions(TENANT_A)).length).toBe(versions);
      expect(await inA((tx) => store.find(tx, live?.id ?? ''))).toMatchObject({ version: 1 });
    });
  });

  describe('applyChange', () => {
    let from: string;
    let to: string;
    let subscriptionId: string;

    const apply = async (overrides: Partial<ApplyPlanChangeInput> & { target?: string } = {}) => {
      const target = overrides.target ?? to;
      const live = await inA((tx) => store.live(tx));
      const effective = overrides.effective ?? 'NOW';
      const preview = await inA((tx) => store.preview(tx, { subscriptionId, targetPlanVersionId: target, effective, now: overrides.now ?? NOW }));
      return inA((tx) =>
        store.applyChange(tx, {
          subscriptionId,
          targetPlanVersionId: target,
          effective,
          now: NOW,
          previewHash: preview.hash,
          reason: REASON,
          expectedVersion: live?.version ?? 0,
          requestedBy: OPERATOR,
          ...overrides,
        }),
      );
    };

    beforeEach(async () => {
      from = await plan({ code: 'apply-from', price: '365000000', seats: 50 });
      to = await plan({ code: 'apply-to', price: '730000000', seats: 100 });
      subscriptionId = (await inA((tx) => store.create(tx, input(from, { trialDays: 60, billingAnchor: '2026-01-01' })))).id;
    });

    it('moves the subscription to the plan now, takes it out of the trial, records the proration and the entitlements of the plan (UAT-AC155)', async () => {
      const before = await entitlementVersions(TENANT_A);
      const outbox = await outboxCount(TENANT_A);
      const result = await apply();
      expect(result.prorationVnd).toBe('320000000');
      expect(result.subscription).toMatchObject({ planVersionId: to, status: 'Active', pendingPlanVersionId: null, version: 2 });
      const after = await entitlementVersions(TENANT_A);
      expect(after).toHaveLength(before.length + 1);
      expect(after[after.length - 1]).toMatchObject({ plan_version_id: to, cause: 'SUBSCRIPTION_CHANGE' });
      expect(await outboxCount(TENANT_A)).toBe(outbox + 1);
      const [change] = await inA((tx) => store.changes(tx, subscriptionId, 10));
      expect(change).toMatchObject({ fromPlanVersionId: from, toPlanVersionId: to, effective: 'NOW', prorationVnd: '320000000', reason: REASON, supersededAt: null });
      expect(change?.appliedAt).toEqual(NOW);
    });

    it('answers 409 PREVIEW_STALE to a token that no longer matches (the entitlements changed) and changes nothing (UAT-AC155)', async () => {
      const live = await inA((tx) => store.live(tx));
      const preview = await inA((tx) => store.preview(tx, { subscriptionId, targetPlanVersionId: to, effective: 'NOW', now: NOW }));
      // An override of the tenant changes its entitlements: here a new version is recorded, as the decision of an override does.
      await admin(
        `insert into machvon.entitlement_version (tenant_id, id, version_no, plan_version_id, features_json, entitlements_hash, cause, effective_from)
         values ($1, $2, (select coalesce(max(version_no), 0) + 1 from machvon.entitlement_version where tenant_id = $1), $3, '[]'::jsonb, repeat('f', 64), 'OVERRIDE', now())`,
        [TENANT_A, randomUUID(), from],
      );
      const versions = (await entitlementVersions(TENANT_A)).length;
      await expect(
        inA((tx) => store.applyChange(tx, { subscriptionId, targetPlanVersionId: to, effective: 'NOW', now: NOW, previewHash: preview.hash, reason: REASON, expectedVersion: live?.version ?? 0, requestedBy: OPERATOR })),
      ).rejects.toMatchObject({ code: 'PREVIEW_STALE', status: 409 });
      expect(await inA((tx) => store.find(tx, subscriptionId))).toMatchObject({ planVersionId: from, version: 1 });
      expect(await inA((tx) => store.changes(tx, subscriptionId, 10))).toEqual([]);
      expect((await entitlementVersions(TENANT_A)).length).toBe(versions);
      // The preview made again is current, and the change goes through.
      expect((await apply()).subscription.planVersionId).toBe(to);
    });

    it('answers PREVIEW_STALE the next day: the proration is another', async () => {
      const live = await inA((tx) => store.live(tx));
      const preview = await inA((tx) => store.preview(tx, { subscriptionId, targetPlanVersionId: to, effective: 'NOW', now: NOW }));
      await expect(
        inA((tx) => store.applyChange(tx, { subscriptionId, targetPlanVersionId: to, effective: 'NOW', now: new Date('2026-02-16T06:00:00Z'), previewHash: preview.hash, reason: REASON, expectedVersion: live?.version ?? 0, requestedBy: OPERATOR })),
      ).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    });

    it('answers a token for another plan or another effect as stale, never as applied', async () => {
      const other = await plan({ code: 'apply-other', price: '900000000' });
      const live = await inA((tx) => store.live(tx));
      const preview = await inA((tx) => store.preview(tx, { subscriptionId, targetPlanVersionId: to, effective: 'NOW', now: NOW }));
      const base = { subscriptionId, now: NOW, previewHash: preview.hash, reason: REASON, expectedVersion: live?.version ?? 0, requestedBy: OPERATOR };
      await expect(inA((tx) => store.applyChange(tx, { ...base, targetPlanVersionId: other, effective: 'NOW' }))).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
      await expect(inA((tx) => store.applyChange(tx, { ...base, targetPlanVersionId: to, effective: 'NEXT_CYCLE' }))).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
      await expect(inA((tx) => store.applyChange(tx, { ...base, previewHash: 'a'.repeat(64), targetPlanVersionId: to, effective: 'NOW' }))).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    });

    it('answers 409 VERSION_CONFLICT when the version the caller saw is not current', async () => {
      await expect(apply({ expectedVersion: 99 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 1 } });
    });

    it('lets exactly one of two concurrent applications through', async () => {
      const live = await inA((tx) => store.live(tx));
      const preview = await inA((tx) => store.preview(tx, { subscriptionId, targetPlanVersionId: to, effective: 'NOW', now: NOW }));
      const again = () =>
        inA((tx) => store.applyChange(tx, { subscriptionId, targetPlanVersionId: to, effective: 'NOW', now: NOW, previewHash: preview.hash, reason: REASON, expectedVersion: live?.version ?? 0, requestedBy: OPERATOR }));
      const outcomes = await Promise.allSettled([again(), again()]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect((outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')?.reason as { code: string }).code).toBe('VERSION_CONFLICT');
      expect(await inA((tx) => store.changes(tx, subscriptionId, 10))).toHaveLength(1);
    });

    it('sets a change at the next cycle as pending, without touching the entitlements or the plan, and says what it will be', async () => {
      const smaller = await plan({ code: 'apply-smaller', price: '100000000', seats: 3 });
      const versions = (await entitlementVersions(TENANT_A)).length;
      const result = await apply({ target: smaller, effective: 'NEXT_CYCLE' });
      expect(result.prorationVnd).toBe('0');
      expect(result.subscription).toMatchObject({ planVersionId: from, pendingPlanVersionId: smaller, pendingEffectiveAt: new Date('2027-01-01T00:00:00Z'), status: 'Trialing', version: 2 });
      expect((await entitlementVersions(TENANT_A)).length).toBe(versions);
      const [change] = await inA((tx) => store.changes(tx, subscriptionId, 10));
      expect(change).toMatchObject({ effective: 'NEXT_CYCLE', toPlanVersionId: smaller, appliedAt: null, supersededAt: null });
    });

    it('replaces a pending change by a later one, and a change now by none that waited', async () => {
      const a = await plan({ code: 'pending-a', price: '100000000', seats: 3 });
      const b = await plan({ code: 'pending-b', price: '200000000', seats: 4 });
      await apply({ target: a, effective: 'NEXT_CYCLE' });
      await apply({ target: b, effective: 'NEXT_CYCLE' });
      const afterTwo = await inA((tx) => store.changes(tx, subscriptionId, 10));
      expect(afterTwo.map((change) => [change.toPlanVersionId === a ? 'a' : 'b', change.supersededAt !== null])).toEqual([['b', false], ['a', true]]);
      expect(await inA((tx) => store.find(tx, subscriptionId))).toMatchObject({ pendingPlanVersionId: b });
      // A change now supersedes what was waiting and clears the pending plan.
      await apply({ target: to, effective: 'NOW' });
      const afterNow = await inA((tx) => store.changes(tx, subscriptionId, 10));
      expect(afterNow.map((change) => change.supersededAt !== null)).toEqual([false, true, true]);
      expect(await inA((tx) => store.find(tx, subscriptionId))).toMatchObject({ planVersionId: to, pendingPlanVersionId: null, pendingEffectiveAt: null });
    });

    it('does not change the subscription of another tenant', async () => {
      const live = await inA((tx) => store.live(tx));
      await expect(
        inB((tx) => store.applyChange(tx, { subscriptionId, targetPlanVersionId: to, effective: 'NOW', now: NOW, previewHash: 'a'.repeat(64), reason: REASON, expectedVersion: live?.version ?? 0, requestedBy: OPERATOR })),
      ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });
  });

  describe('cancel', () => {
    it('ends a trial at once', async () => {
      const planId = await plan({ code: 'cancel-trial', price: '0' });
      const created = await inA((tx) => store.create(tx, input(planId, { trialDays: 30 })));
      const cancelled = await inA((tx) => store.cancel(tx, created.id, 1));
      expect(cancelled).toMatchObject({ status: 'Cancelled', cancelAtPeriodEnd: false, version: 2 });
      expect(await inA((tx) => store.live(tx))).toBeUndefined();
    });

    it('lets an Active subscription run to the end of its period, and refuses to cancel it twice', async () => {
      const planId = await plan({ code: 'cancel-active', price: '1' });
      const created = await inA((tx) => store.create(tx, input(planId)));
      const cancelled = await inA((tx) => store.cancel(tx, created.id, 1));
      expect(cancelled).toMatchObject({ status: 'Active', cancelAtPeriodEnd: true, version: 2 });
      await expect(inA((tx) => store.cancel(tx, created.id, 2))).rejects.toMatchObject({ code: 'SUBSCRIPTION_STATE_INVALID', status: 409 });
    });

    it('answers 409 VERSION_CONFLICT for a stale version, 409 SUBSCRIPTION_STATE_INVALID for one that is over, and 404 for none', async () => {
      const planId = await plan({ code: 'cancel-errors', price: '1' });
      const created = await inA((tx) => store.create(tx, input(planId)));
      await expect(inA((tx) => store.cancel(tx, created.id, 7))).rejects.toMatchObject({ code: 'VERSION_CONFLICT', extensions: { current_version: 1 } });
      await admin("update machvon.subscription set status = 'Expired' where id = $1", [created.id]);
      await expect(inA((tx) => store.cancel(tx, created.id, 1))).rejects.toMatchObject({ code: 'SUBSCRIPTION_STATE_INVALID' });
      await expect(inA((tx) => store.cancel(tx, randomUUID(), 1))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });
  });

  describe('runCycle: the clock (AC-ST-SAS-008-2)', () => {
    it('does nothing when nothing is due, and repeats safely', async () => {
      const planId = await plan({ code: 'cycle-idle', price: '1' });
      await inA((tx) => store.create(tx, input(planId, { billingAnchor: '2026-01-01' })));
      expect(await inA((tx) => store.runCycle(tx, NOW))).toEqual({ trialsEnded: 0, plansApplied: 0, periodsRolled: 0, cancelled: 0 });
    });

    it('turns a trial that has ended into an Active subscription once', async () => {
      const planId = await plan({ code: 'cycle-trial', price: '0' });
      const created = await inA((tx) => store.create(tx, input(planId, { trialDays: 10, billingAnchor: '2026-02-01' })));
      expect(await inA((tx) => store.runCycle(tx, new Date('2026-02-10T23:59:59Z')))).toMatchObject({ trialsEnded: 0 });
      expect(await inA((tx) => store.runCycle(tx, new Date('2026-02-11T00:00:00Z')))).toMatchObject({ trialsEnded: 1 });
      expect(await inA((tx) => store.find(tx, created.id))).toMatchObject({ status: 'Active', version: 2 });
      expect(await inA((tx) => store.runCycle(tx, new Date('2026-02-12T00:00:00Z')))).toMatchObject({ trialsEnded: 0 });
    });

    it('applies the plan that waited for its day, with its entitlements, deleting nothing and blocking the next member (UAT-AC156)', async () => {
      const big = await plan({ code: 'cycle-big', price: '200000000', seats: 50 });
      const small = await plan({ code: 'cycle-small', price: '100000000', seats: 3 });
      const created = await inA((tx) => store.create(tx, input(big, { billingAnchor: '2026-01-01' })));
      const seatsBefore = await asMember((tx) => members.seatsInUse(tx));
      expect(seatsBefore.staff).toBe(5);
      const preview = await inA((tx) => store.preview(tx, { subscriptionId: created.id, targetPlanVersionId: small, effective: 'NEXT_CYCLE', now: NOW }));
      expect(preview.violations).toEqual([{ featureCode: 'member.seats', used: '5', newLimit: '3' }]);
      await inA((tx) => store.applyChange(tx, { subscriptionId: created.id, targetPlanVersionId: small, effective: 'NEXT_CYCLE', now: NOW, previewHash: preview.hash, reason: REASON, expectedVersion: 1, requestedBy: OPERATOR }));
      // Before the new cycle the plan is still the old one and a seat is free.
      await expect(asMember((tx) => members.assertSeatFree(tx, 'STAFF'))).resolves.toBeUndefined();
      expect(await inA((tx) => store.runCycle(tx, new Date('2026-12-31T23:59:59Z')))).toMatchObject({ plansApplied: 0 });
      const versions = (await entitlementVersions(TENANT_A)).length;
      // The clock passes the end of the period.
      const outcome = await inA((tx) => store.runCycle(tx, new Date('2027-01-01T00:00:01Z')));
      expect(outcome).toMatchObject({ plansApplied: 1, periodsRolled: 1 });
      expect(await inA((tx) => store.find(tx, created.id))).toMatchObject({ planVersionId: small, pendingPlanVersionId: null, currentPeriodStart: '2027-01-01', currentPeriodEnd: '2027-12-31' });
      expect((await entitlementVersions(TENANT_A)).length).toBe(versions + 1);
      const [change] = await inA((tx) => store.changes(tx, created.id, 10));
      expect(change?.appliedAt).toEqual(new Date('2027-01-01T00:00:01Z'));
      // 5 people are in a plan of 3: nobody is taken away, and the next one is refused.
      expect((await asMember((tx) => members.seatsInUse(tx))).staff).toBe(5);
      await expect(asMember((tx) => members.assertSeatFree(tx, 'STAFF'))).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', status: 403 });
      expect(await inA((tx) => store.runCycle(tx, new Date('2027-01-02T00:00:00Z')))).toEqual({ trialsEnded: 0, plansApplied: 0, periodsRolled: 0, cancelled: 0 });
    });

    it('rolls the period forward from the anchor, over several periods that passed, never overlapping', async () => {
      const planId = await plan({ code: 'cycle-roll', price: '1', cycles: ['MONTHLY'] });
      const created = await inA((tx) => store.create(tx, input(planId, { cycle: 'MONTHLY', billingAnchor: '2026-01-31' })));
      expect([created.currentPeriodStart, created.currentPeriodEnd]).toEqual(['2026-01-31', '2026-02-27']);
      await inA((tx) => store.runCycle(tx, new Date('2026-05-10T00:00:00Z')));
      expect(await inA((tx) => store.find(tx, created.id))).toMatchObject({ currentPeriodStart: '2026-04-30', currentPeriodEnd: '2026-05-30' });
    });

    it('ends a subscription that was set to end, with its period', async () => {
      const planId = await plan({ code: 'cycle-cancel', price: '1' });
      const created = await inA((tx) => store.create(tx, input(planId, { billingAnchor: '2026-01-01' })));
      await inA((tx) => store.cancel(tx, created.id, 1));
      expect(await inA((tx) => store.runCycle(tx, new Date('2026-12-31T00:00:00Z')))).toMatchObject({ cancelled: 0 });
      expect(await inA((tx) => store.runCycle(tx, new Date('2027-01-01T00:00:00Z')))).toMatchObject({ cancelled: 1 });
      expect(await inA((tx) => store.find(tx, created.id))).toMatchObject({ status: 'Cancelled' });
      expect(await inA((tx) => store.live(tx))).toBeUndefined();
    });
  });

  describe('reads', () => {
    it('lists the subscriptions of the tenant, the latest started first, with a keyset, and only its own', async () => {
      const planId = await plan({ code: 'reads', price: '1' });
      const first = await inA((tx) => store.create(tx, input(planId, { now: new Date('2026-02-10T00:00:00Z') })));
      await admin("update machvon.subscription set status = 'Cancelled' where id = $1", [first.id]);
      const second = await inA((tx) => store.create(tx, input(planId, { now: new Date('2026-02-11T00:00:00Z') })));
      const all = await inA((tx) => store.list(tx, { limit: 50 }));
      const ids = all.map((row) => row.id);
      expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
      const page = await inA((tx) => store.list(tx, { limit: 50, after: second.id }));
      expect(page.map((row) => row.id)).toEqual(ids.slice(ids.indexOf(second.id) + 1));
      expect(await inB((tx) => store.find(tx, second.id))).toBeUndefined();
      expect((await inB((tx) => store.list(tx, { limit: 50 }))).map((row) => row.id)).not.toContain(second.id);
    });
  });

  describe('what the database guards (V1483)', () => {
    let changeId: string;
    beforeAll(async () => {
      const from = await plan({ code: 'guard-from', price: '100' });
      const to = await plan({ code: 'guard-to', price: '200' });
      await admin("update machvon.subscription set status = 'Cancelled' where tenant_id = $1", [TENANT_A]);
      const created = await inA((tx) => store.create(tx, input(from)));
      const preview = await inA((tx) => store.preview(tx, { subscriptionId: created.id, targetPlanVersionId: to, effective: 'NEXT_CYCLE', now: NOW }));
      await inA((tx) => store.applyChange(tx, { subscriptionId: created.id, targetPlanVersionId: to, effective: 'NEXT_CYCLE', now: NOW, previewHash: preview.hash, reason: REASON, expectedVersion: 1, requestedBy: OPERATOR }));
      changeId = (await inA((tx) => store.changes(tx, created.id, 1)))[0]?.id ?? '';
    });

    it('never edits what a plan change says, and never deletes one', async () => {
      expect(await sqlState('update machvon.subscription_plan_change set proration_vnd = 5 where id = $1', [changeId])).toBe('23514');
      expect(await sqlState("update machvon.subscription_plan_change set reason = 'a different reason entirely' where id = $1", [changeId])).toBe('23514');
      expect(await sqlState('delete from machvon.subscription_plan_change where id = $1', [changeId])).toBe('23514');
    });

    it('records the application once, and that billing took the proration once', async () => {
      expect(await sqlState('update machvon.subscription_plan_change set applied_at = now() where id = $1', [changeId])).toBeUndefined();
      expect(await sqlState("update machvon.subscription_plan_change set applied_at = now() + interval '1 day' where id = $1", [changeId])).toBe('23514');
      expect(await sqlState('update machvon.subscription_plan_change set invoiced_invoice_id = gen_random_uuid() where id = $1', [changeId])).toBeUndefined();
      expect(await sqlState('update machvon.subscription_plan_change set invoiced_invoice_id = gen_random_uuid() where id = $1', [changeId])).toBe('23514');
    });

    it('keeps a pending plan from lacking the day it takes effect', async () => {
      expect(await sqlState('update machvon.subscription set pending_plan_version_id = gen_random_uuid() where tenant_id = $1', [TENANT_A])).toBe('23514');
      expect(await sqlState('update machvon.subscription set pending_effective_at = now() where tenant_id = $1 and pending_plan_version_id is null', [TENANT_A])).toBe('23514');
    });

    it('lets the application role read the history and the control role write it, and neither delete it', async () => {
      const client = new Client({ connectionString: harness.database.urlFor('machvon_app') });
      await client.connect();
      try {
        await client.query("select set_config('app.tenant_id', $1, false)", [TENANT_A]);
        expect((await client.query('select id from machvon.subscription_plan_change')).rowCount).toBeGreaterThan(0);
        await expect(client.query('delete from machvon.subscription_plan_change')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.end();
      }
    });
  });
});
