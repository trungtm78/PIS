import { randomBytes, randomUUID } from 'node:crypto';
import { EffectiveAccessStore, InMemoryAuthzCache, PLATFORM_TENANT_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { AppModule } from '../src/app.module';
import { CLAIMS_HEADER, TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';
import { CONTROL_OPERATIONS, controlCasesFor } from './authz/control-matrix';
import { ProvisioningHarness } from './provisioning/provisioning-fixtures';

const SIGNING_KEY = randomBytes(32);
const CONTROL_MEMBER = '00000000-0000-4000-8000-0000000000c9';
const REASON = 'The price list of the agency was approved.';
const SEEDED_STANDARD = '00000000-0000-4000-9000-000000000001';

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

interface PlanItem {
  id: string;
  plan_code: string;
  revision: number;
  status: string;
  version: number;
  published_at?: string;
  features: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

describe('plan catalogue over HTTP (ST-SAS-007)', () => {
  const harness = new ProvisioningHarness();
  let app: RunningApp;
  let counter = 0;

  const feature = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    feature_code: 'reporting',
    limit_kind: 'BOOLEAN',
    grace_behavior: 'ALLOW',
    expired_behavior: 'READ_ONLY',
    ...overrides,
  });

  const draftBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    counter += 1;
    return {
      plan_code: `http-plan-${counter}`,
      name: 'Plan over HTTP',
      billing_cycles: ['MONTHLY', 'ANNUAL'],
      base_price_vnd: '1500000',
      vat_category: 'VAT_10',
      legal_terms_ref: 'TERMS-1',
      features: [feature(), feature({ feature_code: 'member.seats', limit_kind: 'QUOTA', limit_value: '50', grace_behavior: 'READ_ONLY', expired_behavior: 'DENY' })],
      ...overrides,
    };
  };

  async function call(
    method: string,
    path: string,
    options: { roles?: string[]; audience?: string; payload?: unknown; key?: string; ifMatch?: string } = {},
  ): Promise<Reply> {
    const token = signTenantContext({ tenantId: PLATFORM_TENANT_ID, membershipId: CONTROL_MEMBER, scopeVersion: 0 }, SIGNING_KEY);
    const headers: Record<string, string> = {
      [TENANT_HEADER]: token,
      [CLAIMS_HEADER]: JSON.stringify({ aud: options.audience ?? 'control', roles: options.roles ?? ['BillingOperator'] }),
      'content-type': 'application/json',
    };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.payload ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  const create = (overrides: Record<string, unknown> = {}, options: { roles?: string[]; audience?: string; key?: string } = {}): Promise<Reply> =>
    call('POST', '/system/plans', { ...options, payload: draftBody(overrides) });

  const publish = (id: string, options: { ifMatch?: string; roles?: string[]; audience?: string; key?: string; payload?: unknown } = {}): Promise<Reply> =>
    call('POST', `/system/plans/${id}/publish`, { payload: { reason: REASON }, ...options });

  const list = async (query = '', options: { roles?: string[]; audience?: string } = {}): Promise<{ status: number; items: PlanItem[]; next: string | null; json: Record<string, unknown> }> => {
    const reply = await call('GET', `/system/plans${query}`, options);
    return { status: reply.status, items: (reply.json.items ?? []) as PlanItem[], next: (reply.json.next_cursor ?? null) as string | null, json: reply.json };
  };

  const planRow = async (id: string): Promise<{ status: string; version: string; base_price_vnd: string; published_by: string | null } | undefined> =>
    (await harness.admin((client) => client.query('select status, version::text as version, base_price_vnd::text as base_price_vnd, published_by from machvon.product_plan_version where id = $1', [id]))).rows[0];

  const planCount = (): Promise<number> => harness.count('select count(*) as n from machvon.product_plan_version');

  const auditRows = async (action: string, id: string): Promise<Array<{ tenant_id: string; safe_diff: Record<string, unknown>; reason: string | null }>> =>
    (
      await harness.admin((client) =>
        client.query("select tenant_id, safe_diff, reason from machvon.audit_event where action = $1 and resource_id = $2 and outcome = 'SUCCESS'", [action, id]),
      )
    ).rows as Array<{ tenant_id: string; safe_diff: Record<string, unknown>; reason: string | null }>;

  beforeAll(async () => {
    await harness.start();
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        AppModule.register({
          database: harness.tenants,
          registry: loadErrorRegistry(ERROR_CODES_PATH),
          policy: { database: harness.tenants, access: new EffectiveAccessStore(harness.tenants, new InMemoryAuthzCache()) },
          control: { database: harness.control, registry: harness.registry },
        }),
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  describe('createPlanVersion', () => {
    it('answers 201 with the CommandResult and stores revision 1 as a draft with its features', async () => {
      const reply = await create({ plan_code: 'first-plan' });
      expect(reply.status).toBe(201);
      expect(reply.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      const id = reply.json.resource_id as string;
      expect(await planRow(id)).toMatchObject({ status: 'Draft', version: '1', base_price_vnd: '1500000', published_by: null });
      const found = (await list('?plan_code=first-plan')).items;
      expect(found).toHaveLength(1);
      expect(found[0]).toEqual({
        id,
        plan_code: 'first-plan',
        revision: 1,
        name: 'Plan over HTTP',
        status: 'Draft',
        billing_cycles: ['MONTHLY', 'ANNUAL'],
        base_price_vnd: '1500000',
        vat_category: 'VAT_10',
        legal_terms_ref: 'TERMS-1',
        version: 1,
        features: [
          { feature_code: 'member.seats', limit_kind: 'QUOTA', limit_value: '50', grace_behavior: 'READ_ONLY', expired_behavior: 'DENY' },
          { feature_code: 'reporting', limit_kind: 'BOOLEAN', grace_behavior: 'ALLOW', expired_behavior: 'READ_ONLY' },
        ],
      });
    });

    it('numbers the next revision of a plan whatever the case of its code, and keeps the code of the seeded plan', async () => {
      const second = await create({ plan_code: 'standard' });
      expect(second.status).toBe(201);
      const stored = (await list('?plan_code=STANDARD')).items.find((item) => item.id === second.json.resource_id);
      expect(stored).toMatchObject({ plan_code: 'STANDARD', revision: 2, status: 'Draft' });
    });

    it('writes an audit row on the platform tenant with the terms and the feature codes, and nothing of a person', async () => {
      const reply = await create({ plan_code: 'audited-plan' });
      const id = reply.json.resource_id as string;
      const rows = await auditRows('plan.draft_created', id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tenant_id).toBe(PLATFORM_TENANT_ID);
      expect(rows[0]?.safe_diff).toEqual({
        plan_code: 'audited-plan',
        revision: 1,
        base_price_vnd: '1500000',
        vat_category: 'VAT_10',
        billing_cycles: ['MONTHLY', 'ANNUAL'],
        feature_codes: ['member.seats', 'reporting'],
      });
    });

    it('replays the answer of the same key and body without writing a second plan', async () => {
      const key = `plan-${randomUUID()}`;
      const body = draftBody({ plan_code: 'replayed-plan' });
      const first = await call('POST', '/system/plans', { payload: body, key });
      const before = await planCount();
      const again = await call('POST', '/system/plans', { payload: body, key });
      expect([again.status, again.json.resource_id]).toEqual([201, first.json.resource_id]);
      expect(await planCount()).toBe(before);
    });

    it('refuses a plan that is not fit to be sold with 422 PLAN_INVALID naming the fields, and writes nothing', async () => {
      const before = await planCount();
      const reply = await create({ plan_code: 'bad-plan', base_price_vnd: '-5', features: [feature({ feature_code: 'nope' })] });
      expect([reply.status, reply.json.code]).toEqual([422, 'PLAN_INVALID']);
      expect(reply.json).toMatchObject({
        reason: 'PRICE_INVALID',
        issues: [
          { field: 'base_price_vnd', reason: 'PRICE_INVALID' },
          { field: 'features[0].feature_code', reason: 'FEATURE_UNKNOWN' },
        ],
      });
      expect(await planCount()).toBe(before);
    });

    it.each([
      ['a quota without a limit', [feature({ feature_code: 'member.seats', limit_kind: 'QUOTA', grace_behavior: 'READ_ONLY', expired_behavior: 'DENY' })], 'features[0].limit_value'],
      ['a metered feature without a meter', [feature({ feature_code: 'ai.analysis', limit_kind: 'METERED', grace_behavior: 'DENY', expired_behavior: 'DENY' })], 'features[0].meter'],
      ['a feature wider after the end than in grace', [feature({ grace_behavior: 'DENY', expired_behavior: 'READ_ONLY' })], 'features[0].expired_behavior'],
      ['a feature named twice', [feature(), feature()], 'features[1].feature_code'],
      ['no features at all', [], 'features'],
    ])('refuses %s', async (_name, features, field) => {
      const reply = await create({ features });
      expect([reply.status, reply.json.code]).toEqual([422, 'PLAN_INVALID']);
      expect(reply.json.detail).toBe(field);
    });

    it.each([
      ['a plan code with capitals', { plan_code: 'Plan_Code' }],
      ['a billing cycle nobody sells', { billing_cycles: ['WEEKLY'] }],
      ['a price that is not an integer', { base_price_vnd: '10.5' }],
      ['a VAT category that does not exist', { vat_category: 'VAT_20' }],
    ])('refuses %s as a malformed request', async (_name, overrides) => {
      const before = await planCount();
      const reply = await create(overrides);
      expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect(await planCount()).toBe(before);
    });
  });

  it('refuses a member the contract does not have with 400 FIELD_NOT_ALLOWED', async () => {
    const before = await planCount();
    const reply = await create({ surprise: true });
    expect([reply.status, reply.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
    expect(await planCount()).toBe(before);
  });

  describe('publishPlanVersion (UAT-AC154)', () => {
    it('publishes a draft: 200 PUBLISHED at version 2, who published it recorded, audit with the reason and the event of the platform', async () => {
      const created = await create({ plan_code: 'publishing-plan' });
      const id = created.json.resource_id as string;
      const reply = await publish(id, { ifMatch: '"1"' });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'PUBLISHED', resource_version: 2, resource_id: id });
      expect(await planRow(id)).toMatchObject({ status: 'Published', version: '2', published_by: CONTROL_MEMBER });
      const item = (await list('?plan_code=publishing-plan')).items[0];
      expect(item?.status).toBe('Published');
      expect(typeof item?.published_at).toBe('string');
      const audit = await auditRows('plan.published', id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ tenant_id: PLATFORM_TENANT_ID, reason: REASON });
      expect(audit[0]?.safe_diff).toMatchObject({ plan_code: 'publishing-plan', revision: 1 });
      const events = await harness.admin((client) =>
        client.query<{ tenant_id: string; payload: Record<string, unknown> }>("select tenant_id, payload from machvon.outbox_event where aggregate_id = $1 and type = 'sas.plan.published.v1'", [id]),
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]).toMatchObject({ tenant_id: PLATFORM_TENANT_ID, payload: { plan_version_id: id, plan_code: 'publishing-plan', revision: 1 } });
    });

    it('answers 409 PLAN_VERSION_IMMUTABLE to a second publication, then creates revision 2 as a draft and leaves revision 1 as it was (AC-ST-SAS-007-1)', async () => {
      const created = await create({ plan_code: 'sold-plan' });
      const v1 = created.json.resource_id as string;
      expect((await publish(v1, { ifMatch: '"1"' })).status).toBe(200);
      const before = await planRow(v1);
      for (const ifMatch of ['"2"', '"1"']) {
        const again = await publish(v1, { ifMatch });
        expect([again.status, again.json.code]).toEqual([409, 'PLAN_VERSION_IMMUTABLE']);
      }
      expect(await planRow(v1)).toEqual(before);
      const next = await create({ plan_code: 'sold-plan', base_price_vnd: '2000000' });
      expect([next.status, next.json.status, next.json.resource_version]).toEqual([201, 'DRAFT', 1]);
      const plans = (await list('?plan_code=sold-plan')).items;
      expect(plans.map((plan) => [plan.revision, plan.status])).toEqual([
        [2, 'Draft'],
        [1, 'Published'],
      ]);
      expect(await planRow(v1)).toEqual(before);
    });

    it('answers 409 VERSION_CONFLICT to a stale If-Match and 428 to a missing one, and publishes nothing', async () => {
      const created = await create();
      const id = created.json.resource_id as string;
      const stale = await publish(id, { ifMatch: '"9"' });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const missing = await publish(id);
      expect([missing.status, missing.json.code]).toEqual([428, 'PRECONDITION_REQUIRED']);
      expect((await planRow(id))?.status).toBe('Draft');
    });

    it('answers 404 for a plan version that does not exist and 422 for an id that is not one', async () => {
      const unknown = await publish(randomUUID(), { ifMatch: '"1"' });
      expect([unknown.status, unknown.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const malformed = await call('POST', '/system/plans/not-a-uuid/publish', { payload: { reason: REASON }, ifMatch: '"1"' });
      expect([malformed.status, malformed.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });

    it('refuses a reason that is too short', async () => {
      const created = await create();
      const reply = await publish(created.json.resource_id as string, { ifMatch: '"1"', payload: { reason: 'short' } });
      expect([reply.status, reply.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });

    it('refuses to publish a draft that is not fit to be sold with 422 PLAN_INVALID and leaves it a draft', async () => {
      const id = randomUUID();
      await harness.admin((client) =>
        client.query(
          `insert into machvon.product_plan_version (id, plan_code, revision, name, status, billing_cycles, base_price_vnd, vat_category, legal_terms_ref)
           values ($1, 'hollow-plan', 1, 'Hollow', 'Draft', '{MONTHLY}', 0, 'NOT_SUBJECT', 'TERMS-1')`,
          [id],
        ),
      );
      const reply = await publish(id, { ifMatch: '"1"' });
      expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, 'PLAN_INVALID', 'features']);
      expect((await planRow(id))?.status).toBe('Draft');
    });

    it('lets exactly one of two concurrent publications through', async () => {
      const created = await create();
      const id = created.json.resource_id as string;
      const replies = await Promise.all([publish(id, { ifMatch: '"1"' }), publish(id, { ifMatch: '"1"' })]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect(replies.find((reply) => reply.status === 409)?.json.code).toBe('PLAN_VERSION_IMMUTABLE');
    });

    it('does not publish the seeded plan again', async () => {
      const reply = await publish(SEEDED_STANDARD, { ifMatch: '"1"' });
      expect([reply.status, reply.json.code]).toEqual([409, 'PLAN_VERSION_IMMUTABLE']);
    });
  });

  describe('listPlanVersions', () => {
    it('lists the seeded plan with the features of the STANDARD defaults', async () => {
      const { items } = await list('?plan_code=standard&status=Published');
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ id: SEEDED_STANDARD, plan_code: 'STANDARD', revision: 1, status: 'Published', base_price_vnd: '0', vat_category: 'NOT_SUBJECT', billing_cycles: ['ANNUAL'] });
      expect(items[0]?.features.map((entry) => entry.feature_code)).toEqual(['ai.analysis', 'export', 'member.invite', 'member.seats', 'notification.campaign', 'reporting']);
      expect(items[0]?.features.find((entry) => entry.feature_code === 'member.seats')).toEqual({ feature_code: 'member.seats', limit_kind: 'QUOTA', limit_value: '50', grace_behavior: 'READ_ONLY', expired_behavior: 'DENY' });
    });

    it('pages with a cursor, newest revision first, without repeating or skipping a plan version', async () => {
      for (let n = 0; n < 5; n += 1) await create({ plan_code: 'long-plan' });
      const seen: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Awaited<ReturnType<typeof list>> = await list(`?plan_code=long-plan&limit=2${cursor === null ? '' : `&cursor=${cursor}`}`);
        seen.push(...page.items.map((item) => item.revision));
        cursor = page.next;
        pages += 1;
      } while (cursor !== null);
      expect(seen).toEqual([5, 4, 3, 2, 1]);
      expect(pages).toBe(3);
    });

    it('refuses a status that does not exist, a plan code that is too long, a bad cursor and a bad limit', async () => {
      for (const [query, field] of [
        ['?status=Archived', 'status'],
        [`?plan_code=${'x'.repeat(41)}`, 'plan_code'],
        ['?cursor=not-a-cursor', 'cursor'],
        ['?limit=0', 'limit'],
      ] as const) {
        const reply = await call('GET', `/system/plans${query}`);
        expect([reply.status, reply.json.code, reply.json.detail]).toEqual([422, 'VALIDATION_FAILED', field]);
      }
    });

    it('answers an empty page for a plan nobody wrote', async () => {
      const page = await list('?plan_code=never-written');
      expect([page.status, page.items, page.next]).toEqual([200, [], null]);
    });
  });

  describe('who may reach the catalogue', () => {
    it('refuses a tenant token whatever its roles, for the read and for both commands, and writes no plan', async () => {
      const created = await create();
      const id = created.json.resource_id as string;
      const before = await planCount();
      const options = { audience: 'tenant', roles: ['TENANT_ADMIN', 'SystemAdmin'] };
      const replies = [await call('GET', '/system/plans', options), await call('POST', '/system/plans', { ...options, payload: draftBody() }), await publish(id, { ...options, ifMatch: '"1"' })];
      expect(replies.map((reply) => [reply.status, reply.json.code])).toEqual([
        [403, 'SCOPE_DENIED'],
        [403, 'SCOPE_DENIED'],
        [403, 'SCOPE_DENIED'],
      ]);
      expect(await planCount()).toBe(before);
      expect((await planRow(id))?.status).toBe('Draft');
    });

    describe('generated matrix: every plan operation against every realm role', () => {
      const operations = CONTROL_OPERATIONS.filter((operation) => operation.path.startsWith('/system/plans'));
      const cases = controlCasesFor(operations);

      it('lists the three plan operations of the registry', () => {
        expect(operations.map((operation) => operation.operationId).sort()).toEqual(['createPlanVersion', 'listPlanVersions', 'publishPlanVersion']);
      });

      it.each(cases.map((matrixCase) => [matrixCase.id, matrixCase] as const))('%s', async (_id, matrixCase) => {
        const operation = operations.find((candidate) => candidate.operationId === matrixCase.operationId);
        if (operation === undefined) throw new Error('operation of the case is not listed');
        const existing = operation.operationId === 'publishPlanVersion' ? ((await create()).json.resource_id as string) : undefined;
        const deniedBefore = await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and outcome = 'DENIED' and action = $2", [PLATFORM_TENANT_ID, `authz.denied:${operation.operationId}`]);
        const plansBefore = await planCount();
        const roles = [matrixCase.role];
        const reply =
          operation.operationId === 'listPlanVersions'
            ? await call('GET', '/system/plans', { roles })
            : operation.operationId === 'createPlanVersion'
              ? await create({}, { roles })
              : await publish(existing ?? '', { ifMatch: '"1"', roles });
        if (matrixCase.expected === 'allow') {
          expect(reply.status).toBeLessThan(300);
          return;
        }
        expect([reply.status, reply.json.code]).toEqual([403, 'SCOPE_DENIED']);
        expect(await planCount()).toBe(plansBefore);
        if (existing !== undefined) expect((await planRow(existing))?.status).toBe('Draft');
        if (operation.method === 'POST') {
          expect(await harness.count("select count(*) as n from machvon.audit_event where tenant_id = $1 and outcome = 'DENIED' and action = $2", [PLATFORM_TENANT_ID, `authz.denied:${operation.operationId}`])).toBe(deniedBefore + 1);
        }
      });
    });
  });
});
