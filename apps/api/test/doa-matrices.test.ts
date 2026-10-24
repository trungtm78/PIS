import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { DoaMatrixStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../src/command.module';
import { PolicyModule } from '../src/policy.module';
import { ProblemFilter } from '../src/problem.filter';
import { DoaMatricesController, DoaMatrixReadsController } from '../src/modules/adm/doa-matrix.controller';
import { AuthzHarness, TENANT_A, memberId, roleId, unitId } from '../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from './isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from './isolation/test-app';
import type { RunningApp } from './isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const path = (...ns: number[]): string => `/${ns.map(unitId).join('/')}/`;

// Members of tenant A.
const AUTHOR = 1; // adm.doa.manage on the whole tenant
const EDITOR = 2; // adm.doa.manage on the whole tenant (a colleague who edits the draft of the author)
const APPROVER = 3; // adm.doa.approve on the whole tenant (the second person)
const OWNER = 4; // adm.doa.manage and adm.doa.approve on the whole tenant (the tenant owner holds both)
const UNIT_ADMIN = 5; // manage and approve on the subtree of unit 2 only
const NOBODY = 6; // holds a role without the permissions
const READER = 7; // adm.doa.read on the whole tenant
const UNIT_READER = 8; // adm.doa.read on the subtree of unit 2 only

const PROVINCE = unitId(1);
const LEADER_BQLGT = roleId(1);
const LEADER_STC = roleId(2);
const LEADER_UBND = roleId(3);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const rule = (min: string, max: string | null, role: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  document_type: 'FX',
  unit_id: PROVINCE,
  amount_min_vnd: min,
  ...(max === null ? {} : { amount_max_vnd: max }),
  approver_role_id: role,
  ...extra,
});
const THREE_BANDS = [rule('0', '5000000000', LEADER_BQLGT), rule('5000000000', '25000000000', LEADER_STC), rule('25000000000', null, LEADER_UBND, { approval_levels: 2 })];
const matrix = (rules: unknown[] = THREE_BANDS, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  effective_from: '2026-01-01',
  legal_basis_ref: 'Internal regulation 12/QD-2026',
  rules,
  ...extra,
});

describe('delegation-of-authority matrix commands (ST-ADM-011)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  async function call(method: 'POST' | 'PUT', url: string, options: { member: number; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const token = signTenantContext({ tenantId: TENANT_A, membershipId: memberId(options.member), scopeVersion: 1 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json', 'idempotency-key': options.key ?? `key-${randomUUID()}` };
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  async function read(url: string, member: number): Promise<Reply> {
    const token = signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
    const response = await fetch(`${app.baseUrl}${url}`, { headers: { [TENANT_HEADER]: token } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const draft = (member: number, body: Record<string, unknown> = matrix()): Promise<Reply> => call('POST', '/doa-matrices', { member, body });
  const update = (member: number, id: string, body: Record<string, unknown>, ifMatch = '"1"'): Promise<Reply> => call('PUT', `/doa-matrices/${id}`, { member, body, ifMatch });
  const submit = (member: number, id: string, ifMatch = '"1"'): Promise<Reply> => call('POST', `/doa-matrices/${id}/submit`, { member, ifMatch, body: { reason: 'Ready for the second person' } });
  const decide = (member: number, id: string, decision: string, ifMatch = '"2"'): Promise<Reply> =>
    call('POST', `/doa-matrices/${id}/decision`, { member, ifMatch, body: { decision, reason: 'Checked against the regulation', evidence_ids: [] } });
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const countOf = async (sql: string, params: unknown[] = []): Promise<number> => Number((await harness.owner<{ n: string }>(TENANT_A, [[sql, params]]))[0]?.n);
  const findings = (reply: Reply): string[] => (reply.json.errors as Array<{ field: string; code: string }> | undefined ?? []).map((entry) => `${entry.field}:${entry.code}`);
  const pending = async (body: Record<string, unknown> = matrix()): Promise<string> => {
    const id = idOf(await draft(AUTHOR, body));
    await submit(AUTHOR, id);
    return id;
  };

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: path(1) },
      { n: 2, path: path(1, 2), parent: 1 },
    ]);
    for (const n of [AUTHOR, EDITOR, APPROVER, OWNER, UNIT_ADMIN, NOBODY, READER, UNIT_READER]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedRole(TENANT_A, 15, 'DOA_READER', ['adm.doa.read'], 20);
    await harness.seedRole(TENANT_A, 1, 'LEADER_BQLGT', [], 60);
    await harness.seedRole(TENANT_A, 2, 'LEADER_STC', [], 60);
    await harness.seedRole(TENANT_A, 3, 'LEADER_UBND', [], 60);
    await harness.seedRole(TENANT_A, 11, 'DOA_AUTHOR', ['adm.doa.manage'], 60);
    await harness.seedRole(TENANT_A, 12, 'DOA_APPROVER', ['adm.doa.approve'], 60);
    await harness.seedRole(TENANT_A, 13, 'DOA_BOTH', ['adm.doa.manage', 'adm.doa.approve'], 60);
    await harness.seedRole(TENANT_A, 14, 'UNRELATED', ['adm.security.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: AUTHOR, role: 11, kind: 'TENANT' },
      { n: 2, member: EDITOR, role: 11, kind: 'TENANT' },
      { n: 3, member: APPROVER, role: 12, kind: 'TENANT' },
      { n: 4, member: OWNER, role: 13, kind: 'TENANT' },
      { n: 5, member: UNIT_ADMIN, role: 13, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 6, member: NOBODY, role: 14, kind: 'TENANT' },
      { n: 7, member: READER, role: 15, kind: 'TENANT' },
      { n: 8, member: UNIT_READER, role: 15, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [DoaMatricesController, DoaMatrixReadsController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  afterEach(async () => {
    await harness.owner(TENANT_A, [
      ['alter table machvon.doa_rule disable trigger doa_rule_guard', []],
      ['delete from machvon.doa_rule', []],
      ['alter table machvon.doa_rule enable trigger doa_rule_guard', []],
      ['delete from machvon.doa_matrix_version', []],
      ["delete from machvon.audit_event where resource_type = 'doa_matrix_version'", []],
    ]);
  });

  describe('createDoaMatrixDraft', () => {
    it('creates a draft revision 1 with its rules and audits it', async () => {
      const reply = await draft(AUTHOR);
      expect(reply.status).toBe(201);
      expect(reply.json).toMatchObject({ status: 'DRAFTED', resource_version: 1 });
      expect(await countOf("select count(*) as n from machvon.doa_matrix_version where id = $1 and status = 'Draft' and revision = 1 and created_by = $2 and last_edited_by = $2", [idOf(reply), memberId(AUTHOR)])).toBe(1);
      expect(await countOf('select count(*) as n from machvon.doa_rule where matrix_version_id = $1', [idOf(reply)])).toBe(3);
      expect(await countOf("select count(*) as n from machvon.audit_event where action = 'doa.drafted' and resource_id = $1", [idOf(reply)])).toBe(1);
    });

    it('allows a gap in a draft and refuses an overlap with 422 DOA_MATRIX_INVALID naming the field, storing nothing', async () => {
      expect((await draft(AUTHOR, matrix([rule('0', '5', LEADER_BQLGT), rule('9', null, LEADER_UBND)]))).status).toBe(201);
      const overlap = await draft(AUTHOR, matrix([rule('0', '9', LEADER_BQLGT), rule('5', null, LEADER_UBND)]));
      expect(overlap.status).toBe(422);
      expect(overlap.json.code).toBe('DOA_MATRIX_INVALID');
      expect(findings(overlap)).toEqual(['rules[1].amount_min_vnd:OVERLAP']);
      expect(await countOf('select count(*) as n from machvon.doa_matrix_version')).toBe(1);
    });

    it('refuses a unit or a role the tenant does not have and a band that does not end above its start', async () => {
      const unknown = await draft(AUTHOR, matrix([rule('0', null, randomUUID(), { unit_id: randomUUID() })]));
      expect(unknown.status).toBe(422);
      expect(findings(unknown)).toEqual(['rules[0].unit_id:UNIT_UNKNOWN', 'rules[0].approver_role_id:ROLE_UNKNOWN']);
      const backwards = await draft(AUTHOR, matrix([rule('9', '9', LEADER_BQLGT)]));
      expect(findings(backwards)).toEqual(['rules[0].amount_max_vnd:RANGE_INVALID']);
      const endsBefore = await draft(AUTHOR, matrix(THREE_BANDS, { effective_until: '2025-12-31' }));
      expect(findings(endsBefore)).toEqual(['effective_until:RANGE_INVALID']);
      expect(await countOf('select count(*) as n from machvon.doa_matrix_version')).toBe(0);
    });

    it('refuses a body the schema rejects: no rule, an amount that is not whole VND, an unknown field', async () => {
      expect((await draft(AUTHOR, matrix([]))).status).toBeGreaterThanOrEqual(400);
      expect((await draft(AUTHOR, matrix([rule('1.5', null, LEADER_BQLGT)]))).status).toBe(422);
      expect((await draft(AUTHOR, matrix(THREE_BANDS, { surprise: true }))).status).toBe(400);
      expect(await countOf('select count(*) as n from machvon.doa_matrix_version')).toBe(0);
    });

    it('refuses a caller without the permission, a caller who only approves and a caller who holds it only on a subtree (403, audited as DENIED)', async () => {
      for (const member of [NOBODY, APPROVER]) expect((await draft(member)).status).toBe(403);
      const unitAdmin = await draft(UNIT_ADMIN);
      expect(unitAdmin.status).toBe(403);
      expect(unitAdmin.json.code).toBe('SCOPE_DENIED');
      expect(await countOf("select count(*) as n from machvon.audit_event where outcome = 'DENIED' and action like '%createDoaMatrixDraft%'")).toBeGreaterThanOrEqual(1);
      expect(await countOf('select count(*) as n from machvon.doa_matrix_version')).toBe(0);
    });

    it('replays the answer of the same idempotency key without a second draft', async () => {
      const key = `key-${randomUUID()}`;
      const first = await call('POST', '/doa-matrices', { member: AUTHOR, body: matrix(), key });
      const again = await call('POST', '/doa-matrices', { member: AUTHOR, body: matrix(), key });
      expect(again.status).toBe(201);
      expect(idOf(again)).toBe(idOf(first));
      expect(await countOf('select count(*) as n from machvon.doa_matrix_version')).toBe(1);
    });
  });

  describe('updateDoaMatrixDraft', () => {
    it('replaces the draft, bumps its version and records the editor', async () => {
      const id = idOf(await draft(AUTHOR));
      const updated = await update(EDITOR, id, matrix([rule('0', null, LEADER_STC)], { effective_from: '2026-02-01' }));
      expect(updated.status).toBe(200);
      expect(updated.json).toMatchObject({ status: 'UPDATED', resource_version: 2 });
      expect(await countOf('select count(*) as n from machvon.doa_matrix_version where id = $1 and last_edited_by = $2 and effective_from = $3::date', [id, memberId(EDITOR), '2026-02-01'])).toBe(1);
      expect(await countOf('select count(*) as n from machvon.doa_rule where matrix_version_id = $1', [id])).toBe(1);
    });

    it('answers 404 for an unknown draft, 409 for a stale version, 409 DOA_MATRIX_NOT_DRAFT after submission and 428 without a version', async () => {
      const id = idOf(await draft(AUTHOR));
      expect((await update(AUTHOR, randomUUID(), matrix())).status).toBe(404);
      const stale = await update(AUTHOR, id, matrix(), '"7"');
      expect(stale.status).toBe(409);
      expect(stale.json.code).toBe('VERSION_CONFLICT');
      expect((await call('PUT', `/doa-matrices/${id}`, { member: AUTHOR, body: matrix() })).status).toBe(428);
      await submit(AUTHOR, id);
      const submitted = await update(AUTHOR, id, matrix(), '"2"');
      expect(submitted.status).toBe(409);
      expect(submitted.json.code).toBe('DOA_MATRIX_NOT_DRAFT');
    });

    it('refuses an overlap and leaves the draft as it was', async () => {
      const id = idOf(await draft(AUTHOR));
      const reply = await update(AUTHOR, id, matrix([rule('0', '9', LEADER_BQLGT), rule('5', null, LEADER_UBND)]));
      expect(reply.status).toBe(422);
      expect(await countOf('select count(*) as n from machvon.doa_matrix_version where id = $1 and version = 1', [id])).toBe(1);
      expect(await countOf('select count(*) as n from machvon.doa_rule where matrix_version_id = $1', [id])).toBe(3);
    });

    it('refuses a caller who only approves', async () => {
      const id = idOf(await draft(AUTHOR));
      expect((await update(APPROVER, id, matrix())).status).toBe(403);
    });
  });

  describe('submitDoaMatrix and decideDoaMatrix', () => {
    it('refuses a gap at submission with 422 GAP and an overlap with 422 OVERLAP, then the self-publish with 403 SELF_APPROVAL_DENIED, then lets a second person publish it (AC-ST-ADM-011-2)', async () => {
      // The owner holds both permissions, so only the maker rule stops them approving what they wrote.
      const id = idOf(await draft(OWNER, matrix([rule('0', '5000000000', LEADER_BQLGT), rule('6000000000', null, LEADER_UBND)])));
      const gap = await submit(OWNER, id);
      expect(gap.status).toBe(422);
      expect(gap.json.code).toBe('DOA_MATRIX_INVALID');
      expect(findings(gap)).toEqual(['rules[1].amount_min_vnd:GAP']);
      const overlap = await update(OWNER, id, matrix([rule('0', '6000000000', LEADER_BQLGT), rule('5000000000', null, LEADER_UBND)]));
      expect(overlap.status).toBe(422);
      expect(overlap.json.code).toBe('DOA_MATRIX_INVALID');
      expect(findings(overlap)).toEqual(['rules[1].amount_min_vnd:OVERLAP']);
      expect((await update(OWNER, id, matrix())).json).toMatchObject({ status: 'UPDATED', resource_version: 2 });
      expect((await submit(OWNER, id, '"2"')).json).toMatchObject({ status: 'SUBMITTED', resource_version: 3 });

      const self = await decide(OWNER, id, 'approve', '"3"');
      expect(self.status).toBe(403);
      expect(self.json.code).toBe('SELF_APPROVAL_DENIED');
      expect(await countOf("select count(*) as n from machvon.doa_matrix_version where status = 'Published'")).toBe(0);

      const published = await decide(APPROVER, id, 'approve', '"3"');
      expect(published.status).toBe(200);
      expect(published.json).toMatchObject({ status: 'PUBLISHED', resource_version: 4 });
    });

    it('refuses whoever last edited the draft as well as its author: a colleague who changed it cannot approve it', async () => {
      const id = idOf(await draft(AUTHOR));
      expect((await update(OWNER, id, matrix())).status).toBe(200);
      await submit(OWNER, id, '"2"');
      const edited = await decide(OWNER, id, 'approve', '"3"');
      expect(edited.status).toBe(403);
      expect(edited.json.code).toBe('SELF_APPROVAL_DENIED');
      expect(await countOf("select count(*) as n from machvon.doa_matrix_version where status = 'Published'")).toBe(0);
      expect((await decide(APPROVER, id, 'approve', '"3"')).status).toBe(200);
    });

    it('publishes the matrix on the approval of a second person: the approver and the time are kept, the event goes out, the old matrix ends on the new first day', async () => {
      const first = await pending();
      const approved = await decide(APPROVER, first, 'approve');
      expect(approved.status).toBe(200);
      expect(approved.json).toMatchObject({ status: 'PUBLISHED', resource_version: 3 });
      expect(await countOf("select count(*) as n from machvon.doa_matrix_version where id = $1 and status = 'Published' and approved_by = $2 and published_at is not null", [first, memberId(APPROVER)])).toBe(1);
      expect(await countOf("select count(*) as n from machvon.outbox_event where type = 'adm.doa_matrix.published.v1' and aggregate_id = $1", [first])).toBe(1);
      expect(await countOf("select count(*) as n from machvon.audit_event where action = 'doa.decided' and resource_id = $1", [first])).toBe(1);

      const second = await pending(matrix([rule('0', null, LEADER_UBND)], { effective_from: '2026-07-01' }));
      expect((await decide(APPROVER, second, 'approve')).status).toBe(200);
      expect(await countOf("select count(*) as n from machvon.doa_matrix_version where id = $1 and status = 'Superseded' and effective_until = date '2026-07-01'", [first])).toBe(1);
      expect(await countOf("select count(*) as n from machvon.doa_matrix_version where status = 'Published'")).toBe(1);
    });

    it('resolves who approves from the published matrix: the bands at their edges (AC-ST-ADM-011-1)', async () => {
      const id = await pending();
      await decide(APPROVER, id, 'approve');
      const tenants = harness.tenants as TenantDatabase;
      const resolve = (amountVnd: string) =>
        tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(AUTHOR), scopeVersion: 1 }, (tx) =>
          new DoaMatrixStore().resolve(tx, { documentType: 'FX', amountVnd, unitId: unitId(2), businessDate: '2026-03-01' }),
        );
      expect(await resolve('4999999999')).toMatchObject({ matrixVersionId: id, approverRoleId: LEADER_BQLGT });
      expect(await resolve('5000000000')).toMatchObject({ approverRoleId: LEADER_STC });
      expect(await resolve('25000000000')).toMatchObject({ approverRoleId: LEADER_UBND, approvalLevels: 2, requiresDistinctApprovers: true });
    });

    it('sends a version back to Draft on return and ends it on reject, each audited', async () => {
      const id = await pending();
      expect((await decide(APPROVER, id, 'return')).json).toMatchObject({ status: 'RETURNED', resource_version: 3 });
      expect(await countOf("select count(*) as n from machvon.doa_matrix_version where id = $1 and status = 'Draft'", [id])).toBe(1);
      await submit(AUTHOR, id, '"3"');
      expect((await decide(APPROVER, id, 'reject', '"4"')).json).toMatchObject({ status: 'REJECTED', resource_version: 5 });
      expect(await countOf("select count(*) as n from machvon.doa_matrix_version where id = $1 and status = 'Rejected' and approved_by is null", [id])).toBe(1);
      expect(await countOf("select count(*) as n from machvon.audit_event where action = 'doa.decided' and resource_id = $1", [id])).toBe(2);
      expect(await countOf("select count(*) as n from machvon.outbox_event where type = 'adm.doa_matrix.published.v1' and aggregate_id = $1", [id])).toBe(0);
    });

    it('answers 409 for a stale version and for a version that is not waiting, 422 NOT_AFTER_CURRENT for a start before the one in force, 404 for an unknown version', async () => {
      const id = await pending();
      const stale = await decide(APPROVER, id, 'approve', '"9"');
      expect(stale.status).toBe(409);
      expect(stale.json.code).toBe('VERSION_CONFLICT');
      const unknown = await decide(APPROVER, randomUUID(), 'approve');
      expect(unknown.status).toBe(404);
      await decide(APPROVER, id, 'approve');
      const again = await decide(APPROVER, id, 'approve', '"3"');
      expect(again.status).toBe(409);
      expect(again.json.code).toBe('DOA_STATE_INVALID');
      const earlier = await pending(matrix(THREE_BANDS, { effective_from: '2025-06-01' }));
      const late = await decide(APPROVER, earlier, 'approve');
      expect(late.status).toBe(422);
      expect(findings(late)).toEqual(['effective_from:NOT_AFTER_CURRENT']);
    });

    it('refuses a submission by a caller who cannot manage and a decision by one who cannot approve, whole-tenant only', async () => {
      const id = idOf(await draft(AUTHOR));
      expect((await submit(APPROVER, id)).status).toBe(403);
      expect((await submit(UNIT_ADMIN, id)).status).toBe(403);
      await submit(AUTHOR, id);
      for (const member of [NOBODY, AUTHOR, EDITOR, UNIT_ADMIN]) expect((await decide(member, id, 'approve')).status).toBe(403);
      expect(await countOf("select count(*) as n from machvon.doa_matrix_version where id = $1 and status = 'PendingApproval'", [id])).toBe(1);
    });
  });

  describe('the reads', () => {
    it('lists the versions newest revision first with their rules in the order written, and reads one by its id', async () => {
      const first = idOf(await draft(AUTHOR));
      await submit(AUTHOR, first);
      await decide(APPROVER, first, 'approve');
      const second = idOf(await draft(AUTHOR, matrix([rule('5', null, LEADER_STC), rule('0', '5', LEADER_BQLGT)], { effective_from: '2026-07-01', effective_until: '2027-07-01' })));
      const page = await read('/resources/doa_matrix_version', READER);
      expect(page.status).toBe(200);
      const items = page.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id)).toEqual([second, first]);
      expect(items[0]).toMatchObject({ revision: 2, status: 'Draft', effective_from: '2026-07-01', effective_until: '2027-07-01', created_by: memberId(AUTHOR), last_edited_by: memberId(AUTHOR), approved_by: null, published_at: null, version: 1 });
      expect((items[0]?.rules as Array<Record<string, unknown>>).map((entry) => entry.amount_min_vnd)).toEqual(['5', '0']);
      expect(items[1]).toMatchObject({ revision: 1, status: 'Published', approved_by: memberId(APPROVER), version: 3 });
      expect((items[1]?.rules as Array<Record<string, unknown>>)[2]).toMatchObject({
        id: expect.any(String),
        document_type: 'FX',
        unit_id: PROVINCE,
        include_subtree: true,
        amount_min_vnd: '25000000000',
        amount_max_vnd: null,
        approver_role_id: LEADER_UBND,
        approval_levels: 2,
        requires_distinct_approvers: true,
      });
      expect((await read(`/resources/doa_matrix_version/${first}`, READER)).json).toMatchObject({ id: first, status: 'Published' });
    });

    it('pages with a cursor on the revision', async () => {
      const ids = [idOf(await draft(AUTHOR)), idOf(await draft(AUTHOR)), idOf(await draft(AUTHOR))];
      const page = await read('/resources/doa_matrix_version?limit=2', READER);
      expect((page.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([ids[2], ids[1]]);
      const rest = await read(`/resources/doa_matrix_version?limit=2&cursor=${encodeURIComponent(page.json.next_cursor as string)}`, READER);
      expect((rest.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([ids[0]]);
      expect(rest.json.next_cursor).toBeNull();
      expect((await read('/resources/doa_matrix_version?cursor=nonsense', READER)).status).toBe(422);
    });

    it('shows nothing to a reader of a subtree only, 404 for one version, and refuses a caller without the permission', async () => {
      const id = idOf(await draft(AUTHOR));
      expect((await read('/resources/doa_matrix_version', UNIT_READER)).json.items).toEqual([]);
      expect((await read(`/resources/doa_matrix_version/${id}`, UNIT_READER)).status).toBe(404);
      expect((await read(`/resources/doa_matrix_version/${randomUUID()}`, READER)).status).toBe(404);
      expect((await read('/resources/doa_matrix_version', NOBODY)).status).toBe(403);
      expect((await read(`/resources/doa_matrix_version/${id}`, AUTHOR)).status).toBe(403);
    });
  });
});
