import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, vietnamDateOf } from '@machvon/kernel';
import { BASELINE_PACK, applyBaseline, sealPack } from '../../../../packages/db/src/master-baseline';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { GlossaryController, GlossaryReadsController } from '../../src/modules/mdm/glossary.controller';
import { MasterCrosswalkController, MasterCrosswalkReadsController } from '../../src/modules/mdm/master-crosswalk.controller';
import { MasterDataController, MasterDataReadsController } from '../../src/modules/mdm/master-data.controller';
import { PRJ_METRICS } from '../../src/modules/prj/tokens';
import { ProjectController, ProjectReadsController } from '../../src/modules/prj/project.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { asObjects } from '../support/json';
import { assertStatus, callerOf, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';

/**
 * The cases of the master data and the glossary that the UAT run found without a script (UAT-AC45, UAT-AC276, UAT-AC279, UAT-AC281, UAT-AC284, UAT-PLAN-54): the real controllers of MDM and PRJ over a real database,
 * the baseline of the platform applied as a tenant gets it, and the people of the cases. Tenant A is the tenant of the case; tenant B holds what must not be seen from A (and the seeded disbursement terms).
 */
const SIGNING_KEY = randomBytes(32);
const DECISION_DOCUMENT = id(0x74, 1);
const WORKER = '00000000-0000-4000-8000-000000000000';
const TODAY = vietnamDateOf(new Date());

// Members of tenant A.
const STEWARD = 1; // master.propose, master.read
const CHECKER = 2;
const PUBLISHER = 3;
const READER = 4;
const ALIAS_ADMIN = 5;
const OPERATOR = 6; // integration.cursor.reset
const CURSOR_READER = 7; // integration_cursor.read only
const GL_STEWARD = 8; // glossary.propose, glossary.approve, glossary.read: proposes, and would approve its own term
const GL_OWNER = 9; // the tenant owner: owns the glossary domains
const GL_OUTSIDER = 10; // glossary.approve and glossary.read, owner of nothing
const PROJECT_MAKER = 11;
// Members of tenant B.
const B_STEWARD = 1;

describe('master data, glossary and rule data: the cases of the UAT run without a script', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  const call = callerOf(() => app.baseUrl, SIGNING_KEY);

  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const versionOf = (reply: Reply): number => reply.json.resource_version as number;
  const items = (reply: Reply): Array<Record<string, unknown>> => asObjects(reply.json.items);

  async function asAdmin(statements: ReadonlyArray<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  const proposal = (key: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    namespace: 'TENANT',
    master_type: 'FUND_SOURCE',
    business_key: key,
    label: 'Nguồn vốn thử nghiệm',
    attributes: { category: 'NSDP', relation: 'ADDITIVE' },
    valid_from: '2024-01-01',
    reason: 'Entry of the case',
    ...overrides,
  });
  const propose = (member: number, body: Record<string, unknown>, tenantId?: string): Promise<Reply> => call('POST', '/master-records', { member, body, ...(tenantId === undefined ? {} : { tenantId }) });
  const changeOf = async (recordId: string): Promise<{ id: string; version: number; kind: string }> => {
    const [found] = await rows<{ id: string; version: string; change_kind: string }>('select id, version::text as version, change_kind from machvon.master_change_request where master_record_id = $1 order by created_at desc limit 1', [recordId]);
    return { id: found?.id ?? '', version: Number(found?.version), kind: found?.change_kind ?? '' };
  };

  /** A record of tenant A in force, taken the whole way of the change request: proposed, submitted, approved, published. */
  async function inForce(body: Record<string, unknown>): Promise<string> {
    const proposed = await propose(STEWARD, body);
    assertStatus(proposed, 200);
    const recordId = idOf(proposed);
    const change = await changeOf(recordId);
    const submitted = await call('POST', `/master-change-requests/${change.id}/submit`, { member: STEWARD, ifMatch: change.version });
    assertStatus(submitted, 200);
    assertStatus(await call('POST', `/master-change-requests/${change.id}/decision`, { member: CHECKER, ifMatch: versionOf(submitted), body: { decision: 'approve', reason: 'Checked against the decision' } }), 200);
    const [record] = await rows<{ version: string }>('select version::text as version from machvon.master_record where id = $1', [recordId]);
    assertStatus(await call('POST', `/master-records/${recordId}/publish`, { member: PUBLISHER, ifMatch: Number(record?.version), body: { decision_document_id: DECISION_DOCUMENT } }), 200);
    return recordId;
  }

  async function seedVersion(masterType: string, key: string): Promise<string> {
    const recordId = randomUUID();
    const versionId = randomUUID();
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', $3, $4, 'EFFECTIVE', $5, $5)`, [TENANT_A, recordId, masterType, key, memberId(1)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, $3, $4, 1, $4, '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $5, now(), $6, $6)`,
        [TENANT_A, versionId, masterType, key, recordId, memberId(1)],
      ],
    ]);
    return versionId;
  }

  const world: { area: string; sector: string } = { area: '', sector: '' };

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: 1, path: `/${unitId(1)}/` },
        { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 },
      ]);
      await harness.owner(tenant, [
        [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'INCOMING', 'CV', 'Decision', 'INTERNAL', $3, $3)`, [tenant, DECISION_DOCUMENT, memberId(1)]],
        // The funding sources are the platform's alone by baseline; the control plane gives each tenant of the case its own list as well (a row of master_type_policy replaces the baseline).
        ["insert into machvon.master_type_policy (tenant_id, master_type, scope, updated_by) values ($1, 'FUND_SOURCE', 'TENANT_ONLY', $2)", [tenant, memberId(1)]],
      ]);
    }
    const tenants = harness.tenants as TenantDatabase;
    // The baseline reaches a tenant as its provisioning applies it. Tenant A has no owner yet, so no glossary term is seeded there; tenant B has its owner first (below), and gets the five terms of the disbursement figures in review.
    await tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER, TODAY));
    for (const n of [STEWARD, CHECKER, PUBLISHER, READER, ALIAS_ADMIN, OPERATOR, CURSOR_READER, GL_STEWARD, GL_OWNER, GL_OUTSIDER, PROJECT_MAKER]) await harness.seedMembership(TENANT_A, n, 1);
    for (const n of [B_STEWARD, GL_OWNER, GL_OUTSIDER]) await harness.seedMembership(TENANT_B, n, 1);
    const glossaryOwner = ['glossary.approve', 'glossary.propose', 'glossary.read'];
    await harness.seedRole(TENANT_A, 1, 'DATA_STEWARD', ['master.propose', 'master.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'DATA_CHECKER', ['master.review', 'master.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'DATA_PUBLISHER', ['master.publish', 'master.read'], 50);
    await harness.seedRole(TENANT_A, 4, 'DATA_READER', ['master.read'], 20);
    await harness.seedRole(TENANT_A, 5, 'ALIAS_ADMIN', ['master.crosswalk.manage', 'master.read'], 40);
    await harness.seedRole(TENANT_A, 6, 'INTEGRATION_OPERATOR', ['integration.cursor.reset', 'integration_cursor.read'], 50);
    await harness.seedRole(TENANT_A, 7, 'INTEGRATION_READER', ['integration_cursor.read'], 20);
    await harness.seedRole(TENANT_A, 8, 'GLOSSARY_STEWARD', ['glossary.propose', 'glossary.approve', 'glossary.read'], 40);
    await harness.seedRole(TENANT_A, 9, 'TENANT_OWNER', glossaryOwner, 80);
    await harness.seedRole(TENANT_A, 10, 'GLOSSARY_APPROVER', ['glossary.approve', 'glossary.read'], 40);
    await harness.seedRole(TENANT_A, 11, 'PROJECT_MAKER', ['project.create', 'project.update', 'project.read'], 40);
    await harness.seedRole(TENANT_B, 1, 'DATA_STEWARD', ['master.propose', 'master.read'], 40);
    await harness.seedRole(TENANT_B, 9, 'TENANT_OWNER', glossaryOwner, 80);
    await harness.seedRole(TENANT_B, 10, 'GLOSSARY_APPROVER', ['glossary.approve', 'glossary.read'], 40);
    const grant = (n: number, member: number, role: number) => ({ n, member, role, kind: 'TENANT' as const });
    await harness.seedGrants(TENANT_A, [
      grant(1, STEWARD, 1),
      grant(2, CHECKER, 2),
      grant(3, PUBLISHER, 3),
      grant(4, READER, 4),
      grant(5, ALIAS_ADMIN, 5),
      grant(6, OPERATOR, 6),
      grant(7, CURSOR_READER, 7),
      grant(8, GL_STEWARD, 8),
      grant(9, GL_OWNER, 9),
      grant(10, GL_OUTSIDER, 10),
      grant(11, PROJECT_MAKER, 11),
    ]);
    await harness.seedGrants(TENANT_B, [grant(1, B_STEWARD, 1), grant(2, GL_OWNER, 9), grant(3, GL_OUTSIDER, 10)]);
    await tenants.withTenant({ tenantId: TENANT_B, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER, TODAY));
    world.area = await seedVersion('AREA', 'TINH-P');
    world.sector = await seedVersion('SECTOR', 'GT');
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [MasterDataController, MasterDataReadsController, MasterCrosswalkController, MasterCrosswalkReadsController, GlossaryController, GlossaryReadsController, ProjectController, ProjectReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: PRJ_METRICS, useValue: { increment: () => undefined, gauge: () => undefined } },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('goes red on a wrong answer (negative control)', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 409, 'DUPLICATE_KEY'));
    expectCheckFails(() => assertStatus({ status: 403, json: { code: 'SCOPE_DENIED' } }, 403, 'POLICY_LOCKED'));
  });

  it('UAT-AC45: a key that tenant A holds is DUPLICATE_KEY for A without the id of the record, and a plain proposal for tenant B, whose lookup shows its own record and nothing of A', async () => {
    const key = 'NSDP-XS';
    const recordOfA = await inForce(proposal(key));

    // Step 1: the steward of A proposes the key again.
    const again = await propose(STEWARD, proposal(key));
    assertStatus(again, 409, 'DUPLICATE_KEY');
    expect(JSON.stringify(again.json)).not.toContain(recordOfA);
    expect(await rows('select id from machvon.master_record where tenant_id = $1 and business_key = $2', [TENANT_A, key])).toHaveLength(1);

    // Step 2: the steward of B proposes the same key: 200 and a change request that creates it, in B.
    const first = await propose(B_STEWARD, proposal(key), TENANT_B);
    assertStatus(first, 200);
    const [bChange] = await rows<{ change_kind: string; status: string }>('select change_kind, status from machvon.master_change_request where master_record_id = $1', [idOf(first)], TENANT_B);
    expect(bChange).toEqual({ change_kind: 'CREATE', status: 'DRAFT' });

    // Step 3: B looks the key up and sees B's record only, with nothing of A's (no id, no count, no status).
    const found = await call('GET', `/master-records?master_type=FUND_SOURCE&business_key=${key}`, { member: B_STEWARD, tenantId: TENANT_B });
    assertStatus(found, 200);
    expect(items(found).map((item) => item.id)).toEqual([idOf(first)]);
    expect(JSON.stringify(found.json)).not.toContain(recordOfA);
    expect(items(found)[0]).toMatchObject({ namespace: 'TENANT', status: 'DRAFT' });
    // A still holds its own record in force, untouched.
    const seenByA = await call('GET', `/master-records?master_type=FUND_SOURCE&business_key=${key}`, { member: READER });
    expect(items(seenByA).map((item) => [item.id, item.status])).toEqual([[recordOfA, 'EFFECTIVE']]);
  });

  it('UAT-AC276: the author cannot approve the term (403 SELF_APPROVAL_DENIED), the owner publishes revision 1, and revision 2 published deprecates it; the definitions the screen reads link to revision 2', async () => {
    const termBody = (definition: string): Record<string, unknown> => ({
      term_code: 'GIAI_NGAN_YTD',
      term_vi: 'Giải ngân lũy kế từ đầu năm',
      definition,
      formula_ref: 'ytd = SUM(paid)',
      domain: 'DISBURSEMENT',
      owner_membership_id: memberId(GL_OWNER),
    });
    const draft = await call('POST', '/glossary-terms', { member: GL_STEWARD, body: termBody('Giải ngân lũy kế từ đầu năm kế hoạch tới cuối kỳ báo cáo.') });
    assertStatus(draft, 200);
    expect(draft.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
    const submitted = await call('POST', `/glossary-terms/${idOf(draft)}/submit`, { member: GL_STEWARD, ifMatch: 1 });
    expect(submitted.json).toMatchObject({ status: 'IN_REVIEW', resource_version: 2 });
    const selfApproval = await call('POST', `/glossary-terms/${idOf(draft)}/decision`, { member: GL_STEWARD, ifMatch: 2, body: { decision: 'approve', reason: 'My own wording is right' } });
    assertStatus(selfApproval, 403, 'SELF_APPROVAL_DENIED');
    expect(await rows('select status from machvon.glossary_term where id = $1', [idOf(draft)])).toEqual([{ status: 'IN_REVIEW' }]);
    assertStatus(await call('POST', `/glossary-terms/${idOf(draft)}/decision`, { member: GL_OWNER, ifMatch: 2, body: { decision: 'approve', reason: 'Signed by the capital business owner' } }), 200);
    const first = await call('POST', `/glossary-terms/${idOf(draft)}/publish`, { member: GL_OWNER, ifMatch: 3 });
    expect(first.json).toMatchObject({ status: 'PUBLISHED' });

    // Revision 2 is made and published: revision 1 is DEPRECATED, and the unique index of published terms stands.
    const second = await call('POST', '/glossary-terms', { member: GL_STEWARD, body: termBody('Giải ngân lũy kế từ đầu năm kế hoạch, bản sửa theo quyết định mới.') });
    assertStatus(second, 200);
    await call('POST', `/glossary-terms/${idOf(second)}/submit`, { member: GL_STEWARD, ifMatch: 1 });
    assertStatus(await call('POST', `/glossary-terms/${idOf(second)}/decision`, { member: GL_OWNER, ifMatch: 2, body: { decision: 'approve', reason: 'Signed by the capital business owner' } }), 200);
    assertStatus(await call('POST', `/glossary-terms/${idOf(second)}/publish`, { member: GL_OWNER, ifMatch: 3 }), 200);
    expect(await rows('select revision, status, supersedes_id from machvon.glossary_term where term_code = $1 order by revision', ['GIAI_NGAN_YTD'])).toEqual([
      { revision: 1, status: 'DEPRECATED', supersedes_id: null },
      { revision: 2, status: 'PUBLISHED', supersedes_id: idOf(draft) },
    ]);
    // A second published revision of the term cannot exist: the index says so, not the command.
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await expect(client.query("update machvon.glossary_term set status = 'PUBLISHED' where id = $1", [idOf(draft)])).rejects.toMatchObject({ constraint: 'glossary_term_published_uq' });
    } finally {
      await client.end();
    }
    // What DIS-25 reads (the definitions of the domain): the published revision of the term is revision 2.
    const definitions = await call('GET', '/glossary-terms?domain=DISBURSEMENT&status=PUBLISHED', { member: GL_OWNER });
    assertStatus(definitions, 200);
    expect(items(definitions).filter((item) => item.term_code === 'GIAI_NGAN_YTD').map((item) => [item.id, item.revision, item.status])).toEqual([[idOf(second), 2, 'PUBLISHED']]);
  });

  it('UAT-PLAN-54: a holder of glossary.approve outside the owner of the domain is refused 403 SCOPE_DENIED, the term stays IN_REVIEW, and the refusal is audited once', async () => {
    const seeded = await rows<{ id: string; status: string; version: string }>("select id, status, version::text as version from machvon.glossary_term where term_code = 'GIAI_NGAN_YTD' and domain = 'DISBURSEMENT'", [], TENANT_B);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.status).toBe('IN_REVIEW');
    expect(await rows<{ status: string }>("select status from machvon.glossary_term where domain = 'DISBURSEMENT'", [], TENANT_B)).toHaveLength(5);
    const target = seeded[0] as (typeof seeded)[number];
    const denied = await call('POST', `/glossary-terms/${target.id}/decision`, { member: GL_OUTSIDER, tenantId: TENANT_B, ifMatch: target.version, body: { decision: 'approve', reason: 'Reviewed by someone who does not own the domain' } });
    assertStatus(denied, 403, 'SCOPE_DENIED');
    expect(await rows('select status, version::text as version from machvon.glossary_term where id = $1', [target.id], TENANT_B)).toEqual([{ status: 'IN_REVIEW', version: target.version }]);
    const trail = await rows<{ outcome: string; actor_id: string; safe_diff: Record<string, unknown> }>("select outcome, actor_id, safe_diff from machvon.audit_event where action = 'command.denied:decideGlossaryTerm' and actor_id = $1", [memberId(GL_OUTSIDER)], TENANT_B);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ outcome: 'DENIED', actor_id: memberId(GL_OUTSIDER), safe_diff: { operation: 'decideGlossaryTerm', code: 'SCOPE_DENIED' } });
  });

  it('UAT-AC279: the funding source of the platform refuses the change request of a tenant (403 POLICY_LOCKED) and takes only the alias of the tenant, and the standard code stays', async () => {
    const found = await call('GET', '/master-records?master_type=FUND_SOURCE&business_key=NSTW', { member: READER });
    const platform = items(found).find((item) => item.namespace === 'PLATFORM');
    expect(platform).toBeDefined();
    const platformId = platform?.id as string;
    const before = await rows<{ code: string; label: string }>('select code, label from machvon.master_record_version where master_record_id = $1 order by revision', [platformId]);

    // First time: the tenant asks to change the label of NSTW.
    const refused = await call('POST', '/master-change-requests', {
      member: STEWARD,
      body: { change_kind: 'UPDATE', master_type: 'FUND_SOURCE', master_record_id: platformId, proposed: { label: 'Vốn ngân sách Trung ương (tỉnh)' }, effective_from: TODAY, reason: 'The province names it in its own way' },
    });
    assertStatus(refused, 403, 'POLICY_LOCKED');
    expect(await rows('select id from machvon.master_change_request where master_record_id = $1', [platformId])).toEqual([]);

    // Second time: the tenant gives it an alias that points at the record of the platform.
    const alias = await call('POST', '/master-crosswalks', {
      member: ALIAS_ADMIN,
      body: { master_record_id: platformId, source_system: 'TENANT_ALIAS', external_type: 'LABEL', external_code: 'Vốn ngân sách Trung ương (tỉnh)', valid_from: '2024-01-01', match_method: 'MANUAL' },
    });
    assertStatus(alias, 200);
    expect(await rows('select master_record_id, source_system, external_type, status from machvon.master_crosswalk where id = $1', [idOf(alias)])).toEqual([{ master_record_id: platformId, source_system: 'TENANT_ALIAS', external_type: 'LABEL', status: 'ACTIVE' }]);
    const seen = await call('GET', '/master-records?master_type=FUND_SOURCE&business_key=NSTW', { member: READER });
    expect(items(seen).find((item) => item.id === platformId)).toMatchObject({ namespace: 'PLATFORM', business_key: 'NSTW', alias_label: 'Vốn ngân sách Trung ương (tỉnh)', display_label: 'Vốn ngân sách Trung ương (tỉnh)' });
    expect(await rows<{ code: string; label: string }>('select code, label from machvon.master_record_version where master_record_id = $1 order by revision', [platformId])).toEqual(before);
  });

  it('UAT-AC281: the connector NATIONAL_PIM_FILE (adapter PROPOSED) is reset only by who holds the permission (403 otherwise), with a reason (422 on the field reason otherwise), and the position and the reason are kept and audited', async () => {
    const [cursor] = await rows<{ id: string; version: string; adapter_status: string }>("select id, version::text as version, adapter_status from machvon.integration_cursor where connector_code = 'NATIONAL_PIM_FILE'");
    expect(cursor?.adapter_status).toBe('PROPOSED');
    const target = cursor as NonNullable<typeof cursor>;
    const position = { file: 'pim-2026-10.csv', offset: 120 };
    const reset = (member: number, body: Record<string, unknown>): Promise<Reply> => call('POST', `/integration-cursors/${target.id}/reset`, { member, ifMatch: target.version, body });

    // Step 1: a person without integration.cursor.reset.
    assertStatus(await reset(CURSOR_READER, { cursor_json: position, reason: 'Read the file again from the chosen point' }), 403);
    // Step 2: the person who holds the permission, with no reason.
    const noReason = await reset(OPERATOR, { cursor_json: position });
    assertStatus(noReason, 422, 'VALIDATION_FAILED');
    expect(noReason.json.detail).toBe('reason');
    expect(await rows('select cursor_json, reset_reason, version::text as version from machvon.integration_cursor where id = $1', [target.id])).toEqual([{ cursor_json: {}, reset_reason: null, version: target.version }]);
    // Step 3: with the reason.
    const done = await reset(OPERATOR, { cursor_json: position, reason: 'Read the file again from the chosen point' });
    assertStatus(done, 200);
    expect(await rows('select cursor_json, reset_reason, adapter_status from machvon.integration_cursor where id = $1', [target.id])).toEqual([{ cursor_json: position, reset_reason: 'Read the file again from the chosen point', adapter_status: 'PROPOSED' }]);
    const audit = await rows<{ action: string; reason: string; actor_id: string }>('select action, reason, actor_id from machvon.audit_event where resource_id = $1 and outcome = $2', [target.id, 'SUCCESS']);
    expect(audit).toEqual([{ action: 'integration.cursor_reset', reason: 'Read the file again from the chosen point', actor_id: memberId(OPERATOR) }]);
    // MDM-24 shows the badge of a connector from this column: the screen test names the same case (CrosswalkScreen.test.tsx).
    const listed = await call('GET', '/resources/integration_cursor', { member: CURSOR_READER });
    expect(items(listed).find((item) => item.connector_code === 'NATIONAL_PIM_FILE')).toMatchObject({ adapter_status: 'PROPOSED' });
  });

  it('UAT-AC284: the group of a project is judged by the rule in force on the day it was proposed: the old project keeps the group of revision 1, the new one gets revision 2, and no threshold is in the code', async () => {
    const create = (code: string): Promise<Reply> =>
      call('POST', '/projects', { member: PROJECT_MAKER, body: { code, name: 'Dự án đường tỉnh lộ lĩnh vực giao thông', owner_unit_id: unitId(2), area_master_version_id: world.area, sector_master_version_id: world.sector, total_investment_vnd: '2500000000000' } });
    const groupOf = async (projectId: string): Promise<Record<string, unknown>> => {
      const read = await call('GET', `/resources/project/${projectId}`, { member: PROJECT_MAKER });
      assertStatus(read, 200);
      return read.json.group_suggestion as Record<string, unknown>;
    };
    const stored = (projectId: string): Promise<Array<{ group: Record<string, unknown> }>> =>
      rows('select after_json -> $2 as "group" from machvon.project_revision where project_id = $1 and revision = 1', [projectId, 'group_suggestion']);

    // The rule r1 of the platform (legal basis Luat DTC [CXN-32]) is in force; 2500 billion dong of transport is group A.
    const old = await create('DA-UAT-AC284-OLD');
    assertStatus(old, 200);
    expect(await groupOf(idOf(old))).toMatchObject({ group_key: 'A', cxn: 'CXN-32' });
    expect((await stored(idOf(old)))[0]?.group).toMatchObject({ group_key: 'A', rule_revision: 1 });
    // The project was proposed before the change.
    await asAdmin([["update machvon.project set created_at = now() - interval '3 days' where id = $1", [idOf(old)]]]);

    // The platform publishes revision 2 of the thresholds from today: the same amount is group B.
    const bands = [
      { sector_key: null, group_key: 'C', min_amount: '0', max_amount: '120000000000' },
      { sector_key: null, group_key: 'B', min_amount: '120000000000', max_amount: '3000000000000' },
      { sector_key: null, group_key: 'A', min_amount: '3000000000000', max_amount: '30000000000000' },
      { sector_key: null, group_key: 'QTQG', min_amount: '30000000000000', max_amount: null },
    ];
    const next = sealPack('UAT-AC284-R2', [
      { masterType: 'PROJECT_GROUP_THRESHOLDS', businessKey: 'DEFAULT', label: 'Ngưỡng phân nhóm dự án, bản 2', attributes: { owner_module: 'PRJ', awaiting_confirmation: true, cxn: 'CXN-32', bands }, validFrom: TODAY, legalBasis: 'Luật Đầu tư công 58/2024 sửa đổi 90/2025 [CXN-32]' },
    ]);
    await (harness.tenants as TenantDatabase).withTenant({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, next, WORKER, TODAY));
    expect(await rows('select revision, valid_from::text as valid_from, valid_until::text as valid_until from machvon.master_record_version where master_type = $1 order by revision', ['PROJECT_GROUP_THRESHOLDS'])).toEqual([
      { revision: 1, valid_from: '2025-01-01', valid_until: TODAY },
      { revision: 2, valid_from: TODAY, valid_until: null },
    ]);

    const fresh = await create('DA-UAT-AC284-NEW');
    assertStatus(fresh, 200);
    expect(await groupOf(idOf(fresh))).toMatchObject({ group_key: 'B', as_of: TODAY });
    expect((await stored(idOf(fresh)))[0]?.group).toMatchObject({ group_key: 'B', rule_revision: 2 });
    // The old project keeps the group of the rule of its day, and what it stored at the proposal is as it was.
    expect(await groupOf(idOf(old))).toMatchObject({ group_key: 'A' });
    expect((await stored(idOf(old)))[0]?.group).toMatchObject({ group_key: 'A', rule_revision: 1 });
  });
});
