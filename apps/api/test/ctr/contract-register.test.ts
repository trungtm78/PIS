import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { ContractController, ContractReadsController, ContractRevisionReadsController } from '../../src/modules/ctr/contract.controller';
import { ProjectReadsController } from '../../src/modules/prj/project.controller';
import { ctrModule } from '../../src/modules/ctr';
import { MODULES } from '../../src/modules/registry';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const MAKER = 1; // contract.create, contract.update, contract.read over the tenant
const DEPARTMENT_MAKER = 2; // the same over the department
const ELSEWHERE_MAKER = 3; // the same over another branch
const UPDATE_ELSEWHERE = 4; // contract.update over another branch, contract.read over the tenant
const READER = 5; // contract.read
const LEDGER_READER = 6; // contract.read, ledger.read
const REVISION_READER = 7; // contract_revision.read
const NOBODY = 8;
const GUEST = 9; // contract.read, a guest of one contract
const B_MAKER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;
const FAMILY = 0x92;
const PROJECT = id(FAMILY, 1);
const PROJECT_NO_PLAN = id(FAMILY, 2);
const PACKAGE = id(FAMILY, 11);
const PACKAGE_NO_PLAN = id(FAMILY, 12);
const LEAD = id(FAMILY, 21);
const SECOND = id(FAMILY, 22);
const GUEST_CONTRACTOR = id(FAMILY, 23);
const DOCUMENT = id(FAMILY, 31);
const ABSENT = id(FAMILY, 99);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface CallOptions {
  member: number;
  tenantId?: string;
  body?: unknown;
  ifMatch?: string;
  key?: string;
}

describe('contract register commands and reads (ST-CTR-001)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: CallOptions): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;

  async function seedAs(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      // Foreign keys to the modules this story only reads are out of scope here, so the superuser seeds with them switched off.
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  const contractBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
    counter += 1;
    return {
      project_id: PROJECT,
      package_id: PACKAGE,
      contractor_id: LEAD,
      code: `HD-A-${String(counter).padStart(3, '0')}`,
      title: 'Construction of the bridge',
      type: 'LUMP_SUM',
      advance_category: 'CONSTRUCTION',
      contract_value_vnd: '10200000000',
      document_version_id: DOCUMENT,
      ...extra,
    };
  };
  const create = (member: number, extra: Record<string, unknown> = {}, options: Partial<CallOptions> = {}): Promise<Reply> => call('POST', '/contracts', { member, body: contractBody(extra), ...options });
  const revise = (member: number, contractId: string, version: number | string, body: Record<string, unknown>): Promise<Reply> => call('POST', `/contracts/${contractId}/draft`, { member, ifMatch: `"${version}"`, body });
  const setParties = (member: number, contractId: string, version: number | string, parties: unknown[]): Promise<Reply> => call('POST', `/contracts/${contractId}/parties`, { member, ifMatch: `"${version}"`, body: { parties } });
  const cancel = (member: number, contractId: string, version: number | string, reason = 'Awarded to the wrong lot'): Promise<Reply> => call('POST', `/contracts/${contractId}/cancel`, { member, ifMatch: `"${version}"`, body: { reason } });
  const venture = (extra: Record<string, unknown> = {}): Promise<Reply> => create(MAKER, { is_joint_venture: true, contract_value_vnd: '10000000000', ...extra });
  const member = (contractorId: string, role: string, share: string, work: string): Record<string, unknown> => ({ contractor_id: contractorId, role, share_pct: share, work_value_vnd: work });
  const events = async (contractId: string): Promise<string[]> => (await rows<{ type: string }>('select type from machvon.outbox_event where aggregate_id = $1 order by created_at, id', [contractId])).map((event) => event.type);
  const auditActions = async (contractId: string): Promise<string[]> => (await rows<{ action: string }>('select action from machvon.audit_event where resource_id = $1 order by occurred_at, id', [contractId])).map((event) => event.action);

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [MAKER, DEPARTMENT_MAKER, ELSEWHERE_MAKER, UPDATE_ELSEWHERE, READER, LEDGER_READER, REVISION_READER, NOBODY, GUEST]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_MAKER, ROOT);
    const all = ['contract.create', 'contract.update', 'contract.read'];
    await harness.seedRole(TENANT_A, 1, 'CONTRACT_MAKER', all, 40);
    await harness.seedRole(TENANT_A, 2, 'CONTRACT_UPDATER', ['contract.update'], 30);
    await harness.seedRole(TENANT_A, 3, 'CONTRACT_READER', ['contract.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'LEDGER_READER', ['contract.read', 'ledger.read'], 25);
    await harness.seedRole(TENANT_A, 5, 'REVISION_READER', ['contract_revision.read'], 20);
    await harness.seedRole(TENANT_A, 6, 'GUEST_READER', ['contract.read'], 10);
    await harness.seedRole(TENANT_A, 8, 'PROJECT_READER', ['project.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'CONTRACT_MAKER', [...all, 'contract_revision.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 1, kind: 'TENANT' },
      { n: 2, member: DEPARTMENT_MAKER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 3, member: ELSEWHERE_MAKER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 4, member: UPDATE_ELSEWHERE, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 5, member: UPDATE_ELSEWHERE, role: 3, kind: 'TENANT' },
      { n: 6, member: READER, role: 3, kind: 'TENANT' },
      { n: 7, member: LEDGER_READER, role: 4, kind: 'TENANT' },
      { n: 8, member: REVISION_READER, role: 5, kind: 'TENANT' },
      { n: 9, member: MAKER, role: 8, kind: 'TENANT' },
      { n: 10, member: DEPARTMENT_MAKER, role: 8, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 11, member: ELSEWHERE_MAKER, role: 8, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MAKER, role: 1, kind: 'TENANT' }]);
    await seedAs([
      [
        `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id)
         values ($1, $2, '0100000001', 'Lead Builders', 'VERIFIED', $4), ($1, $3, '0100000002', 'Second Builders', 'VERIFIED', $4), ($1, $5, '0100000555', 'Guest Builders', 'VERIFIED', $4)
         on conflict do nothing`,
        [TENANT_A, LEAD, SECOND, id(FAMILY, 40), GUEST_CONTRACTOR],
      ],
      ["update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2, valid_until = now() + interval '1 year' where id = $1 and tenant_id = $3", [memberId(GUEST), GUEST_CONTRACTOR, TENANT_A]],
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-A-001', 'Project with a plan', $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B'),
                ($1, $3, 'PRJ-A-002', 'Project without a plan', $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, PROJECT, PROJECT_NO_PLAN, unitId(DEPARTMENT), unitId(ROOT), id(FAMILY, 42)],
      ],
      [
        `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at)
         values ($1, $2, $3, 2026, 1, $4, 'APPROVED', now()), ($1, $5, $6, 2026, 1, $4, 'DRAFT', now())`,
        [TENANT_A, id(FAMILY, 43), PROJECT, id(FAMILY, 44), id(FAMILY, 45), PROJECT_NO_PLAN],
      ],
      [
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status)
         values ($1, $2, $3, 'PKG-A-020', 10200000000, 'OPEN', 1, 'AWARDED'), ($1, $4, $5, 'PKG-A-021', 5000000000, 'OPEN', 1, 'AWARDED')`,
        [TENANT_A, PACKAGE, PROJECT, PACKAGE_NO_PLAN, PROJECT_NO_PLAN],
      ],
      [
        `insert into machvon.procurement_result (tenant_id, id, package_id, winner_contractor_id, award_price_vnd, outcome, status, decision_document_id, submitted_by, approved_by, approved_at, created_by, updated_by)
         values ($1, $2, $3, $4, 1000, 'AWARDED', 'APPROVED', $5, $6, $7, now(), $6, $6), ($1, $8, $9, $4, 1000, 'AWARDED', 'APPROVED', $5, $6, $7, now(), $6, $6)`,
        [TENANT_A, id(FAMILY, 51), PACKAGE, LEAD, id(FAMILY, 47), memberId(MAKER), memberId(DEPARTMENT_MAKER), id(FAMILY, 52), PACKAGE_NO_PLAN],
      ],
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'HD', 'Contract draft', 'INTERNAL', $3, $3)`, [TENANT_A, id(FAMILY, 47), memberId(MAKER)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/draft.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, DOCUMENT, id(FAMILY, 47)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [ContractController, ContractReadsController, ContractRevisionReadsController, ProjectReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered once in the module registry with the controllers of the register', () => {
    expect(ctrModule.code).toBe('CTR');
    expect(ctrModule.controllers).toEqual(expect.arrayContaining([ContractController, ContractReadsController, ContractRevisionReadsController]));
    expect(MODULES).toContain(ctrModule);
    expect(MODULES.filter((module) => module.code === 'CTR')).toHaveLength(1);
  });

  describe('createContract', () => {
    it('UAT-AC57: refuses a value above the price of the package naming the ceiling, creates the DRAFT at the price, and refuses a project whose plan is not approved without creating a row (AC-ST-CTR-001-1)', async () => {
      const above = await create(MAKER, { code: 'HD-CEIL-1', contract_value_vnd: '10300000000' });
      expect([above.status, above.json.code, above.json.ceiling_vnd]).toEqual([422, 'CONTRACT_VALUE_EXCEEDS_CEILING', '10200000000']);
      expect(await rows('select 1 from machvon.contract where code = $1', ['HD-CEIL-1'])).toEqual([]);

      const made = await create(MAKER, { code: 'HD-CEIL-2', contract_value_vnd: '10200000000' });
      expect(made.status).toBe(200);
      expect(made.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      expect(await rows('select status, contract_value_vnd::text as value, estimate_ceiling_vnd::text as ceiling, version::text as version from machvon.contract where id = $1', [idOf(made)])).toEqual([
        { status: 'DRAFT', value: '10200000000', ceiling: '10200000000', version: '1' },
      ]);

      const unplanned = await create(MAKER, { code: 'HD-PLAN-1', project_id: PROJECT_NO_PLAN, package_id: PACKAGE_NO_PLAN, contract_value_vnd: '5000000000' });
      expect([unplanned.status, unplanned.json.code]).toEqual([422, 'CAPITAL_PLAN_NOT_APPROVED']);
      expect(await rows('select 1 from machvon.contract where code = $1', ['HD-PLAN-1'])).toEqual([]);
    });

    it('UAT-AC316: answers a replay with the first body, refuses the same key with another body and a new key with the same code, and leaves one contract and one event (AC-ST-CTR-001-2)', async () => {
      const body = contractBody({ code: 'HD-A-300' });
      const first = await call('POST', '/contracts', { member: MAKER, body, key: 'K-AC316-A-0123456789' });
      const second = await call('POST', '/contracts', { member: MAKER, body, key: 'K-AC316-A-0123456789' });
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(second.json).toEqual(first.json);
      const changed = await call('POST', '/contracts', { member: MAKER, body: { ...body, contract_value_vnd: '10100000000' }, key: 'K-AC316-A-0123456789' });
      expect([changed.status, changed.json.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
      const duplicate = await call('POST', '/contracts', { member: MAKER, body, key: 'K-AC316-B-0123456789' });
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'CONTRACT_CODE_DUPLICATE']);
      expect(await rows('select id from machvon.contract where code = $1', ['HD-A-300'])).toEqual([{ id: idOf(first) }]);
      expect(await events(idOf(first))).toEqual(['ctr.contract.created.v1']);
      expect(await auditActions(idOf(first))).toEqual(['contract.created']);
      const event = await rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1', [idOf(first)]);
      expect(event[0]?.payload).toMatchObject({ contract_id: idOf(first), code: 'HD-A-300', status: 'DRAFT', contract_value_vnd: '10200000000', estimate_ceiling_vnd: '10200000000', actor_id: memberId(MAKER) });
    });

    it('takes only the fields of the contract: a status, a tenant, a ledger total or any other field is refused, and no generic write exists', async () => {
      for (const extra of [{ status: 'ACTIVE' }, { tenant_id: TENANT_B }, { accepted_total_vnd: '1' }, { created_by: memberId(MAKER) }, { current_revision_id: randomUUID() }]) {
        const reply = await create(MAKER, extra);
        expect([reply.status, reply.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      }
      expect((await create(MAKER, { contract_value_vnd: '10.5' })).status).toBe(422);
      expect((await create(MAKER, { type: 'GIFT' })).status).toBe(422);
      expect((await call('POST', '/contracts', { member: MAKER, body: { code: 'only-code' } })).status).toBe(400);
      for (const method of ['PATCH', 'PUT', 'DELETE']) {
        const response = await fetch(`${app.baseUrl}/contracts/${randomUUID()}`, { method, headers: { [TENANT_HEADER]: tokenOf(MAKER), 'content-type': 'application/json' }, body: '{}' });
        expect(response.status).toBe(404);
      }
      const generic = await fetch(`${app.baseUrl}/resources/contract/${randomUUID()}`, { method: 'PUT', headers: { [TENANT_HEADER]: tokenOf(MAKER), 'content-type': 'application/json' }, body: '{}' });
      expect(generic.status).toBe(404);
    });

    it('judges the scope of the project: the department and the whole tenant create, another branch and a reader do not, and nobody creates in another tenant', async () => {
      expect((await create(DEPARTMENT_MAKER)).status).toBe(200);
      expect((await create(MAKER)).status).toBe(200);
      expect(await create(ELSEWHERE_MAKER)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect((await create(READER)).status).toBe(403);
      expect((await create(NOBODY)).status).toBe(403);
      const foreign = await create(B_MAKER, {}, { tenantId: TENANT_B });
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await create(MAKER, { project_id: ABSENT })).status).toBe(404);
    });

    it('reads an identifier in capitals as the identifier it is: the package, the project and the winner are matched as uuids, not as strings', async () => {
      // Identifiers with letters in them, so that capitals differ from the way the database writes them.
      const [project, pack, contractor] = [id(FAMILY, 0xa1), id(FAMILY, 0xa2), id(FAMILY, 0xa3)];
      await seedAs([
        [`insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id) values ($1, $2, '0100000777', 'Capital Builders', 'VERIFIED', $3)`, [TENANT_A, contractor, id(FAMILY, 40)]],
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, 'PRJ-A-0A1', 'Project in capitals', $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, project, unitId(DEPARTMENT), unitId(ROOT), id(FAMILY, 42)],
        ],
        [`insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at) values ($1, $2, $3, 2026, 1, $4, 'APPROVED', now())`, [TENANT_A, id(FAMILY, 0xa4), project, id(FAMILY, 44)]],
        [`insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status) values ($1, $2, $3, 'PKG-A-0A2', 2000000000, 'OPEN', 1, 'AWARDED')`, [TENANT_A, pack, project]],
        [
          `insert into machvon.procurement_result (tenant_id, id, package_id, winner_contractor_id, award_price_vnd, outcome, status, decision_document_id, submitted_by, approved_by, approved_at, created_by, updated_by)
           values ($1, $2, $3, $4, 1000, 'AWARDED', 'APPROVED', $5, $6, $7, now(), $6, $6)`,
          [TENANT_A, id(FAMILY, 0xa5), pack, contractor, id(FAMILY, 47), memberId(MAKER), memberId(DEPARTMENT_MAKER)],
        ],
      ]);
      const made = await create(MAKER, { code: 'HD-UPPER-1', project_id: project.toUpperCase(), package_id: pack.toUpperCase(), contractor_id: contractor.toUpperCase(), contract_value_vnd: '2000000000', document_version_id: DOCUMENT.toUpperCase() });
      expect(made.status).toBe(200);
      expect(await rows('select project_id, package_id, contractor_id from machvon.contract where id = $1', [idOf(made)])).toEqual([{ project_id: project, package_id: pack, contractor_id: contractor }]);
      // The document of the draft is already that version: naming it again in capitals changes nothing and costs no version.
      const same = await revise(MAKER, idOf(made), 1, { document_version_id: DOCUMENT.toUpperCase() });
      expect(same.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      expect(await auditActions(idOf(made))).toEqual(['contract.created', 'contract.draft_unchanged']);
    });

    it('tells the audit trail and the other modules what was stored, not what was typed: the code trimmed, the money without leading zeros', async () => {
      const made = await create(MAKER, { code: '  HD-STORED-1  ', contract_value_vnd: '010200000000' });
      expect(made.status).toBe(200);
      expect(await rows('select code, contract_value_vnd::text as value from machvon.contract where id = $1', [idOf(made)])).toEqual([{ code: 'HD-STORED-1', value: '10200000000' }]);
      const event = await rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1', [idOf(made)]);
      expect(event[0]?.payload).toMatchObject({ code: 'HD-STORED-1', contract_value_vnd: '10200000000', estimate_ceiling_vnd: '10200000000' });
      const audit = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where resource_id = $1 and action = 'contract.created'", [idOf(made)]);
      expect(audit[0]?.safe_diff).toMatchObject({ code: 'HD-STORED-1', contract_value_vnd: '10200000000' });
    });

    it('names the field of a refusal that is a fault of the request', async () => {
      const refused = async (extra: Record<string, unknown>) => (await create(MAKER, extra)).json;
      expect(await refused({ package_id: PACKAGE_NO_PLAN })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'package_id' });
      expect(await refused({ contractor_id: SECOND })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contractor_id' });
      expect(await refused({ document_version_id: ABSENT })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'document_version_id' });
      expect(await refused({ estimate_ceiling_vnd: '10200000001' })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'estimate_ceiling_vnd' });
      expect(await refused({ contract_value_vnd: '0' })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'contract_value_vnd' });
    });
  });

  describe('reviseContractDraft and cancelContractDraft', () => {
    it('revises the allowlist under If-Match, audits it, emits one event, and writes nothing for a request that changes nothing', async () => {
      const made = await create(MAKER, { code: 'HD-REV-1' });
      const done = await revise(MAKER, idOf(made), 1, { title: 'New title', contract_value_vnd: '9000000000', completion_due: '2028-01-31' });
      expect(done.json).toMatchObject({ status: 'DRAFT', resource_version: 2 });
      expect(await rows('select title, contract_value_vnd::text as value, version::text as version from machvon.contract where id = $1', [idOf(made)])).toEqual([{ title: 'New title', value: '9000000000', version: '2' }]);
      expect(await rows('select amount_vnd::text as amount from machvon.contract_revision where contract_id = $1', [idOf(made)])).toEqual([{ amount: '9000000000' }]);
      const unchanged = await revise(MAKER, idOf(made), 2, { title: 'New title' });
      expect(unchanged.json).toMatchObject({ status: 'DRAFT', resource_version: 2 });
      expect(await events(idOf(made))).toEqual(['ctr.contract.created.v1', 'ctr.contract.drafted.v1']);
      expect(await auditActions(idOf(made))).toEqual(['contract.created', 'contract.draft_revised', 'contract.draft_unchanged']);
    });

    it('refuses a value above the ceiling, a stale version, a missing If-Match, a field that is not in the allowlist and a contract that is not a draft', async () => {
      const made = await create(MAKER, { code: 'HD-REV-2' });
      const above = await revise(MAKER, idOf(made), 1, { contract_value_vnd: '10200000001' });
      expect([above.status, above.json.code, above.json.ceiling_vnd]).toEqual([422, 'CONTRACT_VALUE_EXCEEDS_CEILING', '10200000000']);
      expect(await revise(MAKER, idOf(made), 5, { title: 'x' })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect((await call('POST', `/contracts/${idOf(made)}/draft`, { member: MAKER, body: { title: 'x' } })).status).toBeGreaterThanOrEqual(400);
      for (const extra of [{ status: 'ACTIVE' }, { code: 'HD-OTHER' }, { contractor_id: SECOND }, { tenant_id: TENANT_B }, { is_joint_venture: true }]) {
        expect(await revise(MAKER, idOf(made), 1, extra)).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      }
      await rows("update machvon.contract set status = 'IN_REVIEW' where id = $1", [idOf(made)]);
      expect(await revise(MAKER, idOf(made), 1, { title: 'Late' })).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID' } });
    });

    it('cancels a draft with a reason, once, and keeps the history', async () => {
      const made = await create(MAKER, { code: 'HD-CAN-1' });
      const done = await cancel(MAKER, idOf(made), 1);
      expect(done.json).toMatchObject({ status: 'CANCELLED', resource_version: 2 });
      expect(await rows('select status, status_reason from machvon.contract where id = $1', [idOf(made)])).toEqual([{ status: 'CANCELLED', status_reason: 'Awarded to the wrong lot' }]);
      expect(await rows('select from_status, to_status, command from machvon.contract_status_change where contract_id = $1', [idOf(made)])).toEqual([
        { from_status: 'DRAFT', to_status: 'CANCELLED', command: 'cancelContractDraft' },
      ]);
      expect(await events(idOf(made))).toEqual(['ctr.contract.created.v1', 'ctr.contract.cancelled.v1']);
      expect(await cancel(MAKER, idOf(made), 2)).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID' } });
      expect((await cancel(MAKER, idOf(await create(MAKER, { code: 'HD-CAN-2' })), 1, '')).status).toBe(422);
    });

    it('tells a contract the caller cannot update (403) from one that is out of sight (404), and refuses the tenant of another', async () => {
      const made = await create(MAKER, { code: 'HD-SCOPE-1' });
      expect(await revise(UPDATE_ELSEWHERE, idOf(made), 1, { title: 'No' })).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await revise(ELSEWHERE_MAKER, idOf(made), 1, { title: 'No' })).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect((await revise(READER, idOf(made), 1, { title: 'No' })).status).toBe(403);
      expect(await call('POST', `/contracts/${idOf(made)}/cancel`, { member: B_MAKER, tenantId: TENANT_B, ifMatch: '"1"', body: { reason: 'No' } })).toMatchObject({ status: 404 });
      expect(await revise(DEPARTMENT_MAKER, idOf(made), 1, { title: 'The department may' })).toMatchObject({ status: 200 });
    });
  });

  describe('replaceContractParties', () => {
    it('refuses 60 and 30, accepts 60 and 40 with the work adding up to the value of the contract, and the database refuses a dropped share after the contract is signed (AC-ST-CTR-001-3)', async () => {
      const made = await venture({ code: 'HD-JV-1' });
      const short = await setParties(MAKER, idOf(made), 1, [member(LEAD, 'LEAD', '60', '6000000000'), member(SECOND, 'MEMBER', '30', '4000000000')]);
      expect([short.status, short.json.code, short.json.share_total]).toEqual([422, 'JV_SHARE_NOT_100', '90.0000']);
      expect(await rows('select 1 from machvon.contract_party where contract_id = $1', [idOf(made)])).toEqual([]);

      const done = await setParties(MAKER, idOf(made), 1, [member(LEAD, 'LEAD', '60', '6000000000'), member(SECOND, 'MEMBER', '40', '4000000000')]);
      expect(done.json).toMatchObject({ status: 'DRAFT', resource_version: 2 });
      expect(await rows('select sum(work_value_vnd)::text as work, sum(share_pct)::text as share from machvon.contract_party where contract_id = $1', [idOf(made)])).toEqual([{ work: '10000000000', share: '100.0000' }]);
      expect(await events(idOf(made))).toEqual(['ctr.contract.created.v1', 'ctr.contract.parties_replaced.v1']);

      await rows("update machvon.contract set status = 'IN_REVIEW' where id = $1", [idOf(made)]);
      await rows("update machvon.contract set status = 'SIGNED', signed_on = date '2026-10-25' where id = $1", [idOf(made)]);
      await expect(rows('update machvon.contract_party set share_pct = 50 where contract_id = $1 and contractor_id = $2', [idOf(made), SECOND])).rejects.toMatchObject({ code: '23514' });
    });

    it('refuses work that does not add up to the value, a contract of one contractor, a field outside the six, and a contract that is no longer a draft', async () => {
      const made = await venture({ code: 'HD-JV-2' });
      const heavy = await setParties(MAKER, idOf(made), 1, [member(LEAD, 'LEAD', '60', '6000000001'), member(SECOND, 'MEMBER', '40', '4000000000')]);
      expect([heavy.status, heavy.json.code, heavy.json.work_value_total_vnd, heavy.json.contract_value_vnd]).toEqual([422, 'BOQ_TOTAL_MISMATCH', '10000000001', '10000000000']);
      const single = await create(MAKER, { code: 'HD-JV-3' });
      expect((await setParties(MAKER, idOf(single), 1, [member(LEAD, 'LEAD', '60', '6'), member(SECOND, 'MEMBER', '40', '4')])).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'parties' });
      const extra = await setParties(MAKER, idOf(made), 1, [{ ...member(LEAD, 'LEAD', '60', '6000000000'), status: 'ACTIVE' }, member(SECOND, 'MEMBER', '40', '4000000000')]);
      expect([extra.status, extra.json.code, extra.json.detail]).toEqual([400, 'FIELD_NOT_ALLOWED', 'parties.0.status']);
      expect((await call('POST', `/contracts/${idOf(made)}/parties`, { member: MAKER, ifMatch: '"1"', body: { parties: 'nope' } })).status).toBe(400);
      expect((await call('POST', `/contracts/${idOf(made)}/parties`, { member: MAKER, ifMatch: '"1"', body: { parties: [], note: 'x' } })).status).toBe(400);
      await cancel(MAKER, idOf(made), 1);
      expect(await setParties(MAKER, idOf(made), 2, [member(LEAD, 'LEAD', '60', '6000000000'), member(SECOND, 'MEMBER', '40', '4000000000')])).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID' } });
    });

    it('writes nothing for the same members and keeps the version', async () => {
      const made = await venture({ code: 'HD-JV-4' });
      const list = [member(LEAD, 'LEAD', '60', '6000000000'), member(SECOND, 'MEMBER', '40', '4000000000')];
      await setParties(MAKER, idOf(made), 1, list);
      const again = await setParties(MAKER, idOf(made), 2, list);
      expect(again.json).toMatchObject({ resource_version: 2 });
      expect(await events(idOf(made))).toEqual(['ctr.contract.created.v1', 'ctr.contract.parties_replaced.v1']);
      expect(await auditActions(idOf(made))).toEqual(['contract.created', 'contract.parties_replaced', 'contract.parties_unchanged']);
    });
  });

  describe('reads', () => {
    let guestContract = '';
    let otherContract = '';

    beforeAll(async () => {
      guestContract = idOf(await create(MAKER, { code: 'HD-A-001', contractor_id: LEAD }));
      otherContract = idOf(await create(MAKER, { code: 'HD-A-002' }));
      await harness.seedRole(TENANT_A, 7, 'GUEST_ON_CONTRACT', ['contract.read'], 10);
      await harness.seedGrants(TENANT_A, [{ n: 20, member: GUEST, role: 7, kind: 'CONTRACT', refs: [guestContract] }]);
    });

    it('shows a guest contractor one contract, the others as absent and never as forbidden, and nothing of the ledger or the ceiling (AC-ST-CTR-001-4)', async () => {
      const list = await call('GET', '/resources/contract', { member: GUEST });
      expect(list.status).toBe(200);
      const items = list.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.code)).toEqual(['HD-A-001']);
      expect(items[0]).not.toHaveProperty('estimate_ceiling_vnd');
      expect(items[0]).not.toHaveProperty('accepted_total_vnd');
      const own = await call('GET', `/resources/contract/${guestContract}`, { member: GUEST });
      expect(own.status).toBe(200);
      for (const hidden of ['accepted_total_vnd', 'requested_total_vnd', 'paid_total_vnd', 'advance_paid_vnd', 'advance_outstanding_vnd', 'retention_held_vnd', 'estimate_ceiling_vnd', 'status_changes', 'created_by']) {
        expect(own.json).not.toHaveProperty(hidden);
      }
      const other = await call('GET', `/resources/contract/${otherContract}`, { member: GUEST });
      expect([other.status, other.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      const foreign = await call('GET', `/resources/contract/${guestContract}`, { member: B_MAKER, tenantId: TENANT_B });
      expect(foreign.status).toBe(404);
      expect((await call('GET', `/resources/contract/${randomUUID()}`, { member: GUEST })).status).toBe(404);
      expect((await call('GET', '/resources/contract_revision', { member: GUEST })).status).toBe(403);
      expect((await create(GUEST)).status).toBe(403);
    });

    it('AC-ST-KERNEL-026-2 / UAT-NFR-TENANCY-09: a department user, a user of another branch and a contractor guest each list only their own projects and contracts, and every out-of-scope id is 404', async () => {
      const elsewhereProject = id(FAMILY, 61);
      const elsewhereContract = id(FAMILY, 62);
      await seedAs([
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, 'PRJ-A-003', 'Project of another branch', $3, $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, elsewhereProject, unitId(ELSEWHERE), id(FAMILY, 42)],
        ],
        [
          `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, contract_value_vnd, signed_on, effective_from, completion_due)
           values ($1, $2, $3, $4, $5, 'HD-A-900', 'LUMP_SUM', 'VND', 'ACTIVE', 1, 1000, '2026-01-01', '2026-01-01', '2027-03-31')`,
          [TENANT_A, elsewhereContract, elsewhereProject, id(FAMILY, 63), LEAD],
        ],
      ]);
      try {
        const codes = async (member: number, path: string): Promise<string[]> => {
          const reply = await call('GET', path, { member });
          expect(reply.status).toBe(200);
          return (reply.json.items as Array<{ code: string }>).map((item) => item.code).sort();
        };
        // The department user: the projects and contracts of the department, nothing of the other branch.
        expect(await codes(DEPARTMENT_MAKER, '/resources/project?limit=200')).toEqual(expect.arrayContaining(['PRJ-A-001', 'PRJ-A-002']));
        expect(await codes(DEPARTMENT_MAKER, '/resources/project?limit=200')).not.toContain('PRJ-A-003');
        const departmentContracts = await codes(DEPARTMENT_MAKER, '/resources/contract?limit=200');
        expect(departmentContracts).toContain('HD-A-001');
        expect(departmentContracts).not.toContain('HD-A-900');
        expect([(await call('GET', `/resources/contract/${elsewhereContract}`, { member: DEPARTMENT_MAKER })).status, (await call('GET', `/resources/project/${elsewhereProject}`, { member: DEPARTMENT_MAKER })).status]).toEqual([404, 404]);
        // The user of the other branch sees that branch only, and the contracts of the department are out of sight for them.
        expect(await codes(ELSEWHERE_MAKER, '/resources/project?limit=200')).toEqual(['PRJ-A-003']);
        expect(await codes(ELSEWHERE_MAKER, '/resources/contract?limit=200')).toEqual(['HD-A-900']);
        for (const contract of [guestContract, otherContract]) expect((await call('GET', `/resources/contract/${contract}`, { member: ELSEWHERE_MAKER })).status).toBe(404);
        // The guest: the one contract they were invited to, no project at all, and the others are absent, not forbidden.
        expect(await codes(GUEST, '/resources/contract?limit=200')).toEqual(['HD-A-001']);
        expect((await call('GET', '/resources/project?limit=200', { member: GUEST })).status).toBe(403);
        for (const hidden of [otherContract, elsewhereContract]) expect((await call('GET', `/resources/contract/${hidden}`, { member: GUEST })).status).toBe(404);
        // The whole-tenant user sees all of it: it is the scope, not the data, that hid it above.
        expect(await codes(MAKER, '/resources/project?limit=200')).toEqual(expect.arrayContaining(['PRJ-A-001', 'PRJ-A-002', 'PRJ-A-003']));
      } finally {
        // The other tests of this file count the contracts of the other branch: leave it as it was found.
        await seedAs([
          ['delete from machvon.contract where id = $1', [elsewhereContract]],
          ['delete from machvon.project where id = $1', [elsewhereProject]],
        ]);
      }
    });

    it('gives the staff the line the guest picker reads and, with the right, the ceiling; the totals of the ledger only with ledger.read', async () => {
      const list = await call('GET', '/resources/contract?limit=200', { member: MAKER });
      const line = (list.json.items as Array<Record<string, unknown>>).find((item) => item.id === guestContract);
      expect(line).toMatchObject({
        id: guestContract,
        code: 'HD-A-001',
        status: 'DRAFT',
        contractor_id: LEAD,
        contractor_name: 'Lead Builders',
        project_id: PROJECT,
        owner_unit_id: unitId(DEPARTMENT),
        completion_due: null,
        contract_value_vnd: '10200000000',
        estimate_ceiling_vnd: '10200000000',
      });
      const plain = await call('GET', `/resources/contract/${guestContract}`, { member: MAKER });
      expect(plain.json).not.toHaveProperty('accepted_total_vnd');
      expect(plain.json).toMatchObject({ parties: [], parties_check: { shares_complete: false }, revisions: [expect.objectContaining({ revision: 1, status: 'DRAFT', kind: 'BASE' })], status_changes: [] });
      const ledger = await call('GET', `/resources/contract/${guestContract}`, { member: LEDGER_READER });
      expect(ledger.json).toMatchObject({ accepted_total_vnd: '0', requested_total_vnd: '0', paid_total_vnd: '0', advance_outstanding_vnd: '0', retention_held_vnd: '0', retention_released_vnd: '0' });
      expect(ledger.json).toMatchObject({ estimate_ceiling_vnd: '10200000000' });
      expect((await call('GET', '/resources/contract', { member: NOBODY })).status).toBe(403);
    });

    it('shows the members with their sums and the history of the status to the staff (CTR-25)', async () => {
      const made = await venture({ code: 'HD-JV-READ' });
      await setParties(MAKER, idOf(made), 1, [member(LEAD, 'LEAD', '60', '6000000000'), member(SECOND, 'MEMBER', '40', '4000000000')]);
      await cancel(MAKER, idOf(made), 2, 'Closed down');
      const detail = await call('GET', `/resources/contract/${idOf(made)}`, { member: MAKER });
      expect(detail.json).toMatchObject({
        status: 'CANCELLED',
        status_reason: 'Closed down',
        is_joint_venture: true,
        parties_check: { share_total: '100.0000', work_value_total_vnd: '10000000000', shares_complete: true, work_matches_value: true },
        status_changes: [expect.objectContaining({ from_status: 'DRAFT', to_status: 'CANCELLED', reason: 'Closed down', command: 'cancelContractDraft' })],
      });
      expect((detail.json.parties as Array<Record<string, unknown>>).map((party) => [party.contractor_name, party.role, party.share_pct, party.work_value_vnd])).toEqual([
        ['Lead Builders', 'LEAD', '60.0000', '6000000000'],
        ['Second Builders', 'MEMBER', '40.0000', '4000000000'],
      ]);
    });

    it('limits the staff to the contracts of their units and pages by code', async () => {
      const elsewhere = await call('GET', '/resources/contract?limit=200', { member: ELSEWHERE_MAKER });
      expect(elsewhere.json.items).toEqual([]);
      const department = await call('GET', '/resources/contract?limit=200', { member: DEPARTMENT_MAKER });
      expect((department.json.items as unknown[]).length).toBeGreaterThan(2);
      const first = await call('GET', '/resources/contract?limit=2', { member: MAKER });
      const next = await call('GET', `/resources/contract?limit=2&cursor=${first.json.next_cursor as string}`, { member: MAKER });
      const codes = [...(first.json.items as Array<{ code: string }>), ...(next.json.items as Array<{ code: string }>)].map((item) => item.code);
      expect(codes).toEqual([...codes].sort());
      expect(new Set(codes).size).toBe(4);
      expect((await call('GET', '/resources/contract?cursor=nope', { member: MAKER })).status).toBe(422);
    });

    it('reads the revisions under their own right, in the scope of the contract', async () => {
      const list = await call('GET', '/resources/contract_revision?limit=200', { member: REVISION_READER });
      const items = list.json.items as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThan(2);
      const mine = items.find((item) => item.contract_id === guestContract);
      expect(mine).toMatchObject({ contract_code: 'HD-A-001', revision: 1, kind: 'BASE', status: 'DRAFT', amount_vnd: '10200000000', retroactive: false, document_version_id: DOCUMENT });
      const page = await call('GET', '/resources/contract_revision?limit=1', { member: REVISION_READER });
      const next = await call('GET', `/resources/contract_revision?limit=1&cursor=${page.json.next_cursor as string}`, { member: REVISION_READER });
      expect((next.json.items as Array<{ id: string }>)[0]?.id).not.toBe((page.json.items as Array<{ id: string }>)[0]?.id);
      const one = await call('GET', `/resources/contract_revision/${mine?.id as string}`, { member: REVISION_READER });
      expect(one.json).toMatchObject({ id: mine?.id, contract_id: guestContract });
      expect((await call('GET', `/resources/contract_revision/${mine?.id as string}`, { member: B_MAKER, tenantId: TENANT_B })).status).toBe(404);
      expect((await call('GET', `/resources/contract_revision/${randomUUID()}`, { member: REVISION_READER })).status).toBe(404);
      expect((await call('GET', '/resources/contract_revision', { member: MAKER })).status).toBe(403);
    });

    it('keeps the reason a draft was cancelled for from the guest contractor, as it keeps the history (CTR section 7: no reasons behind the status for a guest)', async () => {
      // Last of the reads: it changes the contract the guest holds.
      const cancelled = await cancel(MAKER, guestContract, 1, 'Contractor under review for collusion');
      expect(cancelled.status).toBe(200);
      const staff = await call('GET', `/resources/contract/${guestContract}`, { member: MAKER });
      expect(staff.json).toMatchObject({ status: 'CANCELLED', status_reason: 'Contractor under review for collusion' });
      const guest = await call('GET', `/resources/contract/${guestContract}`, { member: GUEST });
      expect(guest.status).toBe(200);
      expect(guest.json).toMatchObject({ status: 'CANCELLED' });
      expect(guest.json).not.toHaveProperty('status_reason');
      expect(JSON.stringify(guest.json)).not.toContain('collusion');
    });
  });
});
