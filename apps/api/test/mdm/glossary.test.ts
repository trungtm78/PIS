import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, GlossaryStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { GlossaryController, GlossaryReadsController } from '../../src/modules/mdm/glossary.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const STEWARD = 1; // glossary.propose, glossary.approve and glossary.read: proposes, and would approve its own term
const OWNER = 2; // glossary.approve, glossary.propose and glossary.read: the owner of the domains (and the tenant owner)
const OUTSIDER = 3; // glossary.approve and glossary.read, but owner of no domain
const READER = 4; // glossary.read
const NOBODY = 5;
const WORKER = 9; // the actor of the baseline job

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('glossary commands and reads (ST-MDM-008)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const codeOf = (): string => {
    counter += 1;
    return `HTTP_TERM_${counter}_${randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
  };
  const body = (termCode: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    term_code: termCode,
    term_vi: 'Giải ngân lũy kế',
    definition: 'Giải ngân lũy kế từ đầu năm kế hoạch tới cuối kỳ báo cáo.',
    formula_ref: 'ytd = SUM(paid)',
    domain: 'HTTP_TESTING',
    owner_membership_id: memberId(OWNER),
    ...extra,
  });
  const propose = (member: number, payload: Record<string, unknown>, tenantId?: string): Promise<Reply> =>
    call('POST', '/glossary-terms', { member, body: payload, ...(tenantId === undefined ? {} : { tenantId }) });
  const submit = (member: number, id: string, version: number): Promise<Reply> => call('POST', `/glossary-terms/${id}/submit`, { member, ifMatch: `"${version}"` });
  const decide = (member: number, id: string, version: number, decision = 'approve', reason = 'Reviewed by the owner'): Promise<Reply> =>
    call('POST', `/glossary-terms/${id}/decision`, { member, ifMatch: `"${version}"`, body: { decision, reason } });
  const publish = (member: number, id: string, version: number): Promise<Reply> => call('POST', `/glossary-terms/${id}/publish`, { member, ifMatch: `"${version}"` });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
    for (const n of [STEWARD, OWNER, OUTSIDER, READER, NOBODY]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, STEWARD, 1);
    await harness.seedMembership(TENANT_B, OWNER, 1);
    await harness.seedRole(TENANT_A, 1, 'GLOSSARY_STEWARD', ['glossary.propose', 'glossary.approve', 'glossary.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'TENANT_OWNER', ['glossary.approve', 'glossary.propose', 'glossary.read'], 80);
    await harness.seedRole(TENANT_A, 3, 'GLOSSARY_APPROVER', ['glossary.approve', 'glossary.read'], 40);
    await harness.seedRole(TENANT_A, 4, 'GLOSSARY_READER', ['glossary.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'GLOSSARY_STEWARD', ['glossary.propose', 'glossary.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: STEWARD, role: 1, kind: 'TENANT' },
      { n: 2, member: OWNER, role: 2, kind: 'TENANT' },
      { n: 3, member: OUTSIDER, role: 3, kind: 'TENANT' },
      { n: 4, member: READER, role: 4, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: STEWARD, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [GlossaryController, GlossaryReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  describe('the approval workflow', () => {
    it('refuses the steward who made the term, then publishes revision 2 by the domain owner and deprecates revision 1 (AC-ST-MDM-008-1)', async () => {
      const termCode = 'GIAI_NGAN_YTD_HTTP';
      const first = await propose(STEWARD, body(termCode));
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      expect((await submit(STEWARD, idOf(first), 1)).json).toMatchObject({ status: 'IN_REVIEW', resource_version: 2 });
      expect((await decide(OWNER, idOf(first), 2)).json).toMatchObject({ status: 'APPROVED', resource_version: 3 });
      expect((await publish(OWNER, idOf(first), 3)).json).toMatchObject({ status: 'PUBLISHED', resource_version: 4 });

      const second = await propose(STEWARD, body(termCode, { definition: 'Giải ngân lũy kế từ đầu năm kế hoạch, phiên bản hai.' }));
      expect(second.status).toBe(200);
      await submit(STEWARD, idOf(second), 1);
      const self = await decide(STEWARD, idOf(second), 2);
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await decide(OWNER, idOf(second), 2)).status).toBe(200);
      const selfPublish = await publish(STEWARD, idOf(second), 3);
      expect([selfPublish.status, selfPublish.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect((await publish(OWNER, idOf(second), 3)).json).toMatchObject({ status: 'PUBLISHED', resource_version: 4 });

      const stored = await rows<{ revision: number; status: string; supersedes_id: string | null }>('select revision, status, supersedes_id from machvon.glossary_term where term_code = $1 order by revision', [termCode]);
      expect(stored).toEqual([
        { revision: 1, status: 'DEPRECATED', supersedes_id: null },
        { revision: 2, status: 'PUBLISHED', supersedes_id: idOf(first) },
      ]);
      const events = await rows<{ payload: unknown; aggregate_id: string }>("select payload, aggregate_id from machvon.outbox_event where type = 'glossary.published.v1' and aggregate_id = any($1::uuid[]) order by created_at", [[idOf(first), idOf(second)]]);
      expect(events).toEqual([
        { aggregate_id: idOf(first), payload: { term_code: termCode, revision: 1, domain: 'HTTP_TESTING' } },
        { aggregate_id: idOf(second), payload: { term_code: termCode, revision: 2, domain: 'HTTP_TESTING' } },
      ]);
      const actions = await rows<{ action: string }>('select action from machvon.audit_event where resource_id = $1 order by occurred_at, id', [idOf(second)]);
      expect(actions.map((row) => row.action)).toEqual(['glossary.proposed', 'glossary.submitted', 'glossary.approved', 'glossary.published']);
    });

    it('audits a rejection and a return with their reason', async () => {
      const rejected = await propose(STEWARD, body(codeOf()));
      await submit(STEWARD, idOf(rejected), 1);
      expect((await decide(OWNER, idOf(rejected), 2, 'reject', 'Not the wording of the decision')).json).toMatchObject({ status: 'REJECTED' });
      const returned = await propose(STEWARD, body(codeOf()));
      await submit(STEWARD, idOf(returned), 1);
      expect((await decide(OWNER, idOf(returned), 2, 'return', 'Add the legal basis')).json).toMatchObject({ status: 'DRAFT', resource_version: 3 });
      const audit = await rows<{ action: string; reason: string }>('select action, reason from machvon.audit_event where resource_id = any($1::uuid[]) and reason is not null order by occurred_at, id', [[idOf(rejected), idOf(returned)]]);
      expect(audit).toEqual([
        { action: 'glossary.rejected', reason: 'Not the wording of the decision' },
        { action: 'glossary.returned', reason: 'Add the legal basis' },
      ]);
    });

    it('refuses a holder of glossary.approve who is not the owner of the term with 403 SCOPE_DENIED, and the term stays IN_REVIEW (AC-ST-MDM-008-2)', async () => {
      // The baseline job seeds the disbursement terms in review for the tenant owner.
      const created = await harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(WORKER), scopeVersion: 1 }, (tx) => new GlossaryStore().ensureDisbursementTerms(tx, memberId(WORKER)));
      expect(created).toBe(5);
      const seeded = await rows<{ id: string; status: string; version: string }>("select id, status, version::text as version from machvon.glossary_term where domain = 'DISBURSEMENT' order by term_code");
      expect(seeded.map((row) => row.status)).toEqual(Array(5).fill('IN_REVIEW'));

      const target = seeded[0] as (typeof seeded)[number];
      const outside = await decide(OUTSIDER, target.id, Number(target.version));
      expect([outside.status, outside.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const after = await rows<{ status: string; version: string }>('select status, version::text as version from machvon.glossary_term where id = $1', [target.id]);
      expect(after).toEqual([{ status: 'IN_REVIEW', version: target.version }]);
      const denied = await publish(OUTSIDER, target.id, Number(target.version));
      expect([denied.status, denied.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await decide(OWNER, target.id, Number(target.version))).json).toMatchObject({ status: 'APPROVED' });
    });
  });

  describe('what the contract and the rules refuse', () => {
    it('refuses a duplicate proposal, a body that is not allowed and an owner who cannot decide', async () => {
      const termCode = codeOf();
      expect((await propose(STEWARD, body(termCode))).status).toBe(200);
      const duplicate = await propose(STEWARD, body(termCode));
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'GLOSSARY_TERM_DUPLICATE']);
      expect((await propose(STEWARD, body(codeOf(), { definition: 'too short' }))).json).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
      expect((await propose(STEWARD, body(codeOf(), { surprise: true }))).status).toBe(400);
      expect((await propose(STEWARD, body(codeOf(), { owner_membership_id: memberId(STEWARD) }))).json).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
      expect((await propose(STEWARD, body(codeOf(), { owner_membership_id: 'not-a-uuid' }))).status).toBe(422);
      expect((await propose(STEWARD, body(codeOf(), { supersedes_id: 'not-a-uuid' }))).status).toBe(422);
      expect((await propose(STEWARD, body(codeOf(), { term_code: 'lower_case' }))).status).toBe(422);
      expect((await propose(STEWARD, body(codeOf(), { owner_membership_id: memberId(READER) }), TENANT_B)).json).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('needs glossary.propose to propose and submit, glossary.approve to decide and publish, and the current version', async () => {
      expect((await propose(READER, body(codeOf()))).status).toBe(403);
      expect((await propose(NOBODY, body(codeOf()))).status).toBe(403);
      const made = await propose(STEWARD, body(codeOf()));
      expect((await submit(READER, idOf(made), 1)).status).toBe(403);
      expect((await submit(STEWARD, idOf(made), 9)).json.code).toBe('VERSION_CONFLICT');
      expect((await submit(STEWARD, randomUUID(), 1)).json.code).toBe('RESOURCE_NOT_FOUND');
      expect((await submit(STEWARD, idOf(made), 1)).status).toBe(200);
      expect((await submit(STEWARD, idOf(made), 2)).json.code).toBe('STAGE_TRANSITION_DENIED');
      expect((await decide(READER, idOf(made), 2)).status).toBe(403);
      expect((await decide(OWNER, idOf(made), 2, 'maybe')).status).toBe(422);
      expect((await decide(OWNER, idOf(made), 2, 'approve', 'no')).status).toBe(422);
      expect((await decide(OWNER, idOf(made), 9)).json.code).toBe('VERSION_CONFLICT');
      expect((await publish(OWNER, idOf(made), 2)).json.code).toBe('STAGE_TRANSITION_DENIED');
      expect((await publish(READER, idOf(made), 2)).status).toBe(403);
      expect((await decide(OWNER, idOf(made), 2)).status).toBe(200);
    });
  });

  describe('listGlossaryTerms', () => {
    it('lists the terms by domain and status, newest first, in pages, to those who may read the glossary', async () => {
      const domain = `HTTP_LIST_${randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
      const made: Reply[] = [];
      for (let n = 0; n < 3; n += 1) made.push(await propose(STEWARD, body(codeOf(), { domain })));
      await submit(STEWARD, idOf(made[0] as Reply), 1);

      const all = await call('GET', `/glossary-terms?domain=${domain}`, { member: READER });
      expect(all.status).toBe(200);
      const items = all.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id)).toEqual(made.map(idOf).reverse());
      expect(items[0]).toMatchObject({ domain, status: 'DRAFT', revision: 1, owner_membership_id: memberId(OWNER), created_by: memberId(STEWARD), formula_ref: 'ytd = SUM(paid)', version: 1 });
      expect(((await call('GET', `/glossary-terms?domain=${domain}&status=IN_REVIEW`, { member: READER })).json.items as unknown[]).length).toBe(1);
      expect(((await call('GET', `/glossary-terms?term_code=${items[1]?.term_code as string}`, { member: READER })).json.items as unknown[]).length).toBe(1);
      const page = await call('GET', `/glossary-terms?domain=${domain}&limit=2`, { member: READER });
      expect((page.json.items as unknown[]).length).toBe(2);
      const next = await call('GET', `/glossary-terms?domain=${domain}&limit=2&cursor=${page.json.next_cursor as string}`, { member: READER });
      expect((next.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([idOf(made[0] as Reply)]);
      expect(next.json.next_cursor).toBeNull();
      expect(((await call('GET', `/glossary-terms?domain=${domain}`, { member: STEWARD, tenantId: TENANT_B })).json.items as unknown[]).length).toBe(0);
    });

    it('refuses a filter that is not well formed and a caller without glossary.read', async () => {
      expect((await call('GET', '/glossary-terms?status=GONE', { member: READER })).status).toBe(422);
      expect((await call('GET', '/glossary-terms?domain=', { member: READER })).status).toBe(422);
      expect((await call('GET', '/glossary-terms?cursor=zzz', { member: READER })).status).toBe(422);
      expect((await call('GET', '/glossary-terms', { member: NOBODY })).status).toBe(403);
    });
  });
});
