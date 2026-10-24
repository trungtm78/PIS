import { resolve } from 'node:path';
import type { PlanDraft, PlanFeatureDraft } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import { ControlDatabase, PLATFORM_TENANT_ID } from '../src/control-database';
import { startMigratedTestDatabase } from '../src/migrated-test-database';
import { PlanStore } from '../src/plan-store';
import type { PlanVersionRow } from '../src/plan-store';
import type { TenantTx } from '../src/tenant-database';
import type { TestDatabase } from '../src/test-database';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const OPERATOR = '00000000-0000-4000-8000-0000000000a1';
const SEEDED_STANDARD = '00000000-0000-4000-9000-000000000001';

const feature = (overrides: Partial<PlanFeatureDraft> = {}): PlanFeatureDraft => ({
  featureCode: 'reporting',
  limitKind: 'BOOLEAN',
  graceBehavior: 'ALLOW',
  expiredBehavior: 'READ_ONLY',
  ...overrides,
});

const SEATS = feature({ featureCode: 'member.seats', limitKind: 'QUOTA', limitValue: '50', graceBehavior: 'READ_ONLY', expiredBehavior: 'DENY' });

let counter = 0;
const draft = (overrides: Partial<PlanDraft> = {}): PlanDraft => {
  counter += 1;
  return {
    planCode: `plan-${counter}`,
    name: 'Plan under test',
    billingCycles: ['MONTHLY', 'ANNUAL'],
    basePriceVnd: '1500000',
    vatCategory: 'VAT_10',
    legalTermsRef: 'TERMS-1',
    features: [feature(), feature({ featureCode: 'export', graceBehavior: 'ALLOW', expiredBehavior: 'EXPORT_ONLY' }), SEATS],
    ...overrides,
  };
};

describe('PlanStore on a migrated database', () => {
  let database: TestDatabase;
  let pool: Pool;
  let control: ControlDatabase;
  const store = new PlanStore();

  const inTx = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => control.withTenantOf(PLATFORM_TENANT_ID, work);

  async function asAdmin<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: database.adminUrl });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  const sqlState = async (client: Client, text: string, params: unknown[] = []): Promise<string | undefined> => {
    try {
      await client.query(text, params);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  };

  const planById = async (id: string): Promise<PlanVersionRow | undefined> => (await inTx((tx) => store.list(tx, { limit: 200 }))).find((plan) => plan.id === id);

  const create = (overrides: Partial<PlanDraft> = {}): Promise<PlanVersionRow> => inTx((tx) => store.createDraft(tx, draft(overrides)));
  const publish = (planVersionId: string, expectedVersion: number): Promise<PlanVersionRow> =>
    inTx((tx) => store.publish(tx, { planVersionId, expectedVersion, publishedBy: OPERATOR }));

  beforeAll(async () => {
    database = await startMigratedTestDatabase(REPO_ROOT);
    pool = new Pool({ connectionString: database.urlFor('machvon_control'), max: 6 });
    pool.on('error', () => undefined);
    control = new ControlDatabase(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    if (database) await database.stop();
  }, 60_000);

  describe('createDraft', () => {
    it('writes revision 1 as a draft with its features and a version of 1', async () => {
      const created = await create({ planCode: 'first-plan' });
      expect(created).toMatchObject({
        planCode: 'first-plan',
        revision: 1,
        name: 'Plan under test',
        status: 'Draft',
        billingCycles: ['MONTHLY', 'ANNUAL'],
        basePriceVnd: '1500000',
        vatCategory: 'VAT_10',
        legalTermsRef: 'TERMS-1',
        publishedBy: null,
        publishedAt: null,
        version: 1,
      });
      expect(created.features.map((entry) => entry.featureCode)).toEqual(['export', 'member.seats', 'reporting']);
      expect(created.features.find((entry) => entry.featureCode === 'member.seats')).toEqual({
        featureCode: 'member.seats',
        limitKind: 'QUOTA',
        limitValue: '50',
        meter: null,
        graceBehavior: 'READ_ONLY',
        expiredBehavior: 'DENY',
      });
    });

    it('numbers the next revision of the same plan, whatever the case of the code, and keeps the spelling that exists', async () => {
      const seeded = await planById(SEEDED_STANDARD);
      expect(seeded).toMatchObject({ planCode: 'STANDARD', revision: 1, status: 'Published' });
      const second = await create({ planCode: 'standard' });
      expect(second).toMatchObject({ planCode: 'STANDARD', revision: 2, status: 'Draft' });
      const third = await create({ planCode: 'Standard' });
      expect(third).toMatchObject({ planCode: 'STANDARD', revision: 3 });
      expect(seeded?.status).toBe('Published');
    });

    it('keeps the published revision as it was when a newer one is written', async () => {
      const seeded = await planById(SEEDED_STANDARD);
      expect(seeded).toMatchObject({ revision: 1, status: 'Published', basePriceVnd: '0', version: 1 });
      expect(seeded?.features).toHaveLength(6);
      expect(seeded?.features.find((entry) => entry.featureCode === 'member.seats')).toMatchObject({ limitKind: 'QUOTA', limitValue: '50' });
    });

    it('gives distinct, gapless revisions to creations that run at the same time', async () => {
      const made = await Promise.all(Array.from({ length: 5 }, () => create({ planCode: 'racing-plan' })));
      expect(made.map((plan) => plan.revision).sort()).toEqual([1, 2, 3, 4, 5]);
    });

    it('refuses a plan that is not fit to be sold with 422 PLAN_INVALID, naming every problem, and writes nothing', async () => {
      const before = await asAdmin(async (client) => Number((await client.query<{ n: string }>('select count(*) as n from machvon.product_plan_version')).rows[0]?.n));
      await expect(create({ planCode: 'bad-plan', basePriceVnd: '-5', features: [feature({ featureCode: 'nope' })] })).rejects.toMatchObject({
        code: 'PLAN_INVALID',
        status: 422,
        detail: 'base_price_vnd',
        extensions: {
          reason: 'PRICE_INVALID',
          issues: [
            { field: 'base_price_vnd', reason: 'PRICE_INVALID' },
            { field: 'features[0].feature_code', reason: 'FEATURE_UNKNOWN' },
          ],
        },
      });
      const after = await asAdmin(async (client) => Number((await client.query<{ n: string }>('select count(*) as n from machvon.product_plan_version')).rows[0]?.n));
      expect(after).toBe(before);
    });

    it('rolls the whole plan back when a feature cannot be written', async () => {
      const plan = draft({ planCode: 'half-plan', features: [feature(), feature({ featureCode: 'export', expiredBehavior: 'EXPORT_ONLY' })] });
      await expect(
        inTx(async (tx) => {
          await store.createDraft(tx, plan);
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await asAdmin(async (client) => (await client.query("select 1 from machvon.product_plan_version where plan_code = 'half-plan'")).rowCount)).toBe(0);
    });

    it('stores a metered feature with its meter and a cap, and a decimal limit without trailing zeros', async () => {
      const created = await create({
        features: [
          feature({ featureCode: 'ai.analysis', limitKind: 'METERED', meter: 'ai.tokens', limitValue: '100000.5', graceBehavior: 'DENY', expiredBehavior: 'DENY' }),
        ],
      });
      expect(created.features).toEqual([
        { featureCode: 'ai.analysis', limitKind: 'METERED', limitValue: '100000.5', meter: 'ai.tokens', graceBehavior: 'DENY', expiredBehavior: 'DENY' },
      ]);
    });
  });

  describe('publish', () => {
    it('publishes a draft once: Published, who and when, version 2', async () => {
      const created = await create();
      const published = await publish(created.id, 1);
      expect(published).toMatchObject({ id: created.id, status: 'Published', publishedBy: OPERATOR, version: 2, revision: 1 });
      expect(published.publishedAt).toBeInstanceOf(Date);
      expect(published.features).toEqual(created.features);
    });

    it('refuses to publish again with 409 PLAN_VERSION_IMMUTABLE, whichever version the caller holds, and leaves the plan as it was', async () => {
      const created = await create();
      const published = await publish(created.id, 1);
      await expect(publish(created.id, 2)).rejects.toMatchObject({ code: 'PLAN_VERSION_IMMUTABLE', status: 409 });
      await expect(publish(created.id, 1)).rejects.toMatchObject({ code: 'PLAN_VERSION_IMMUTABLE', status: 409 });
      expect(await planById(created.id)).toEqual(published);
    });

    it('allows the next revision of a published plan, and leaves the published one alone', async () => {
      const first = await create({ planCode: 'sold-plan' });
      const published = await publish(first.id, 1);
      const next = await create({ planCode: 'sold-plan', basePriceVnd: '2000000' });
      expect(next).toMatchObject({ revision: 2, status: 'Draft', basePriceVnd: '2000000' });
      expect(await planById(first.id)).toEqual(published);
    });

    it('refuses a stale version with 409 VERSION_CONFLICT naming the current one', async () => {
      const created = await create();
      await expect(publish(created.id, 7)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 1 } });
      expect((await planById(created.id))?.status).toBe('Draft');
    });

    it('answers 404 for a plan version that does not exist', async () => {
      await expect(publish('00000000-0000-4000-8000-00000000dead', 1)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('lets exactly one of two concurrent publications through', async () => {
      const created = await create();
      const outcomes = await Promise.allSettled([publish(created.id, 1), publish(created.id, 1)]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      expect(failed?.reason).toMatchObject({ code: 'PLAN_VERSION_IMMUTABLE', status: 409 });
    });

    it('refuses to publish a draft that is not fit to be sold with 422 PLAN_INVALID, and keeps it a draft', async () => {
      const empty = '00000000-0000-4000-9500-0000000000e1';
      await asAdmin((client) =>
        client.query(
          `insert into machvon.product_plan_version (id, plan_code, revision, name, status, billing_cycles, base_price_vnd, vat_category, legal_terms_ref)
           values ($1, 'empty-plan', 1, 'Empty', 'Draft', '{MONTHLY}', 0, 'NOT_SUBJECT', 'TERMS-1')`,
          [empty],
        ),
      );
      await expect(publish(empty, 1)).rejects.toMatchObject({ code: 'PLAN_INVALID', status: 422, detail: 'features', extensions: { reason: 'REQUIRED' } });
      expect((await planById(empty))?.status).toBe('Draft');
    });
  });

  describe('list', () => {
    it('lists plans by code and newest revision first, each with its features', async () => {
      await create({ planCode: 'zz-list' });
      const second = await create({ planCode: 'zz-list' });
      const page = await inTx((tx) => store.list(tx, { planCode: 'ZZ-LIST', limit: 10 }));
      expect(page.map((plan) => plan.revision)).toEqual([2, 1]);
      expect(page[0]).toEqual(second);
    });

    it('filters by status', async () => {
      const created = await create({ planCode: 'status-list' });
      await publish(created.id, 1);
      await create({ planCode: 'status-list' });
      const published = await inTx((tx) => store.list(tx, { planCode: 'status-list', status: 'Published', limit: 10 }));
      expect(published.map((plan) => [plan.revision, plan.status])).toEqual([[1, 'Published']]);
      const drafts = await inTx((tx) => store.list(tx, { planCode: 'status-list', status: 'Draft', limit: 10 }));
      expect(drafts.map((plan) => [plan.revision, plan.status])).toEqual([[2, 'Draft']]);
    });

    it('pages with a keyset that continues after the last plan version of a page', async () => {
      for (let n = 0; n < 4; n += 1) await create({ planCode: 'paged-plan' });
      const seen: number[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await inTx((tx) => store.list(tx, { planCode: 'paged-plan', limit: 3, after }));
        seen.push(...page.map((plan) => plan.revision));
        if (page.length < 3) break;
        after = page[page.length - 1]?.id;
      }
      expect(seen).toEqual([4, 3, 2, 1]);
    });

    it('continues from one plan code into the next', async () => {
      const everything = await inTx((tx) => store.list(tx, { limit: 200 }));
      const codes = everything.map((plan) => plan.planCode);
      expect(codes).toEqual([...codes].sort());
      const [first, ...rest] = everything;
      const next = await inTx((tx) => store.list(tx, { limit: 200, after: first?.id }));
      expect(next.map((plan) => plan.id)).toEqual(rest.map((plan) => plan.id));
    });

    it('returns an empty page for a code nobody wrote', async () => {
      expect(await inTx((tx) => store.list(tx, { planCode: 'never-written', limit: 10 }))).toEqual([]);
    });
  });

  describe('what the database guards (V1480)', () => {
    it('refuses to change a published plan version, to take it back to a draft, or to delete it', async () => {
      const created = await create();
      await publish(created.id, 1);
      await asAdmin(async (client) => {
        expect(await sqlState(client, 'update machvon.product_plan_version set base_price_vnd = 1 where id = $1', [created.id])).toBe('23514');
        expect(await sqlState(client, "update machvon.product_plan_version set name = 'other' where id = $1", [created.id])).toBe('23514');
        expect(await sqlState(client, "update machvon.product_plan_version set billing_cycles = '{ANNUAL}' where id = $1", [created.id])).toBe('23514');
        expect(await sqlState(client, "update machvon.product_plan_version set status = 'Draft' where id = $1", [created.id])).toBe('23514');
        expect(await sqlState(client, 'update machvon.product_plan_version set published_by = null where id = $1', [created.id])).toBe('23514');
        expect(await sqlState(client, 'delete from machvon.product_plan_version where id = $1', [created.id])).toBe('23514');
      });
    });

    it('lets a published plan version be retired once, and nothing else after that', async () => {
      const created = await create();
      await publish(created.id, 1);
      await asAdmin(async (client) => {
        expect(await sqlState(client, "update machvon.product_plan_version set status = 'Retired', version = version + 1 where id = $1", [created.id])).toBeUndefined();
        expect(await sqlState(client, "update machvon.product_plan_version set status = 'Published' where id = $1", [created.id])).toBe('23514');
        expect(await sqlState(client, "update machvon.product_plan_version set name = 'x' where id = $1", [created.id])).toBe('23514');
      });
    });

    it('does not retire a draft, and does not publish one that records no one', async () => {
      const created = await create();
      await asAdmin(async (client) => {
        expect(await sqlState(client, "update machvon.product_plan_version set status = 'Retired' where id = $1", [created.id])).toBe('23514');
        expect(await sqlState(client, "update machvon.product_plan_version set status = 'Published' where id = $1", [created.id])).toBe('23514');
        expect(await sqlState(client, 'delete from machvon.product_plan_version where id = $1', [created.id])).toBe('23514');
      });
    });

    it('writes features while the plan is a draft and never after it is published', async () => {
      const created = await create({ features: [feature()] });
      await asAdmin(async (client) => {
        const insert = (code: string): Promise<string | undefined> =>
          sqlState(
            client,
            `insert into machvon.plan_feature (id, plan_version_id, feature_code, limit_kind, grace_behavior, expired_behavior)
             values (gen_random_uuid(), $1, $2, 'BOOLEAN', 'ALLOW', 'READ_ONLY')`,
            [created.id, code],
          );
        expect(await insert('export')).toBeUndefined();
      });
      await publish(created.id, 1);
      await asAdmin(async (client) => {
        expect(
          await sqlState(
            client,
            `insert into machvon.plan_feature (id, plan_version_id, feature_code, limit_kind, grace_behavior, expired_behavior)
             values (gen_random_uuid(), $1, 'member.invite', 'BOOLEAN', 'ALLOW', 'READ_ONLY')`,
            [created.id],
          ),
        ).toBe('23514');
        expect(await sqlState(client, "update machvon.plan_feature set limit_kind = 'QUOTA' where plan_version_id = $1", [created.id])).toBe('23514');
        expect(await sqlState(client, 'delete from machvon.plan_feature where plan_version_id = $1', [created.id])).toBe('23514');
      });
    });

    it('guards the seeded plan like any other', async () => {
      await asAdmin(async (client) => {
        expect(await sqlState(client, 'update machvon.product_plan_version set base_price_vnd = 99 where id = $1', [SEEDED_STANDARD])).toBe('23514');
        expect(await sqlState(client, "update machvon.plan_feature set limit_value = 99 where plan_version_id = $1 and feature_code = 'member.seats'", [SEEDED_STANDARD])).toBe('23514');
      });
    });

    it('keeps the control role from deleting or truncating the catalogue', async () => {
      const client = new Client({ connectionString: database.urlFor('machvon_control') });
      await client.connect();
      try {
        expect(await sqlState(client, 'delete from machvon.product_plan_version')).toBe('42501');
        expect(await sqlState(client, 'delete from machvon.plan_feature')).toBe('42501');
        expect(await sqlState(client, 'truncate machvon.product_plan_version cascade')).toBe('42501');
        expect(await sqlState(client, 'truncate machvon.plan_feature')).toBe('42501');
      } finally {
        await client.end();
      }
    });
  });
});
