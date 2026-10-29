import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { AuditWriter, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import type { ReorganizationProjectPort } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { APP_FILTER } from '@nestjs/core';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { UnitReorganizationCommandsController, UnitReorganizationReadsController } from '../../src/modules/adm/unit-reorganization.controller';
import { UnitReorganizationJob } from '../../src/modules/adm/unit-reorganization.job';
import { UnboundProjectTransferPort } from '../../src/modules/adm/unit-reorganization.port';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { CLAIMS_HEADER, TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const PROPOSER = 1;
const OWNER = 2;
const NOBODY = 3;
const UNIT_ADMIN = 4; // the same rights, on a unit subtree only
const OTHER_TENANT = 5;
const M1 = 11;
const M2 = 12;
const M3 = 13;
const ROOT = 1;
const SKHDT = 2;
const SKKH = 3;
const STC = 4;
const DISTRICT = 5;
const WARD_A = 6;
const WARD_B = 7;
const projectId = (n: number): string => id(0x50, n);
const WORKER = { tenantId: TENANT_A, membershipId: memberId(OWNER), scopeVersion: 0 };

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the reorganisation of organisation units over HTTP (ST-ADM-015)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let tenants: TenantDatabase;
  const moved: Array<{ projectId: string; toUnitId: string }> = [];
  const port: ReorganizationProjectPort & { failOn: string | undefined } = {
    failOn: undefined,
    transfer: async (tx, call) => {
      if (port.failOn === call.projectId) throw new Error('PRJ is down');
      moved.push({ projectId: call.projectId, toUnitId: call.toUnitId });
      await tx.query('update machvon.project set owner_unit_id = $2::uuid where id = $1::uuid', [call.projectId, call.toUnitId]);
    },
  };

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json', [CLAIMS_HEADER]: '{}' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
  const outbox = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2', [aggregateId, type]);
  const job = () => new UnitReorganizationJob(tenants, new AuditWriter(tenants), port);
  /** The job as it runs every minute, until it has nothing more to do. */
  const runJob = async (now = new Date()) => {
    let total = await job().run(WORKER, now);
    let last = total;
    for (let pass = 0; pass < 5 && last.steps > 0; pass += 1) {
      last = await job().run(WORKER, now);
      total = { ...last, applied: total.applied + last.applied, failed: total.failed + last.failed, steps: total.steps + last.steps };
    }
    return total;
  };

  const merge = (overrides: Record<string, unknown> = {}) => ({
    kind: 'MERGE',
    effective_from: '2026-01-15',
    legal_basis_ref: 'Nghị quyết 12/NQ-UBND ngày 01/10/2026',
    predecessor_unit_ids: [unitId(SKHDT), unitId(SKKH)],
    successors: [{ existing_unit_id: unitId(STC) }],
    mapping: {},
    ...overrides,
  });
  const propose = (member: number, body: unknown, key?: string) => call('POST', '/unit-reorganizations', { member, body, ...(key === undefined ? {} : { key }) });
  const decide = (member: number, reorgId: string, version: number, body: Record<string, unknown> = {}) =>
    call('POST', `/unit-reorganizations/${reorgId}/decision`, { member, ifMatch: `"${version}"`, body: { decision: 'approve', reason: 'Đúng nghị quyết của Ủy ban.', evidence_ids: [], ...body } });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    await harness.seedUnits(TENANT_A, [SKHDT, SKKH, STC, DISTRICT, WARD_A, WARD_B].map((n) => ({ n, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(n)}/` })));
    for (const [member, unit] of [[PROPOSER, ROOT], [OWNER, ROOT], [NOBODY, ROOT], [UNIT_ADMIN, ROOT], [M1, SKHDT], [M2, SKHDT], [M3, SKKH]] as const) await harness.seedMembership(TENANT_A, member, unit);
    await harness.seedMembership(TENANT_B, OTHER_TENANT, ROOT);
    await harness.seedRole(TENANT_A, 1, 'REORG_PROPOSER', ['iam.unit.reorganize', 'iam.unit.reorganize.approve', 'iam.unit.reorganize.read'], 50);
    await harness.seedRole(TENANT_A, 2, 'REORG_OWNER', ['iam.unit.reorganize.approve', 'iam.unit.reorganize.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'LEADER', ['approval.decide'], 60);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: PROPOSER, role: 1, kind: 'TENANT' },
      { n: 2, member: OWNER, role: 2, kind: 'TENANT' },
      { n: 3, member: UNIT_ADMIN, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(SKHDT)] },
      { n: 10, member: M1, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(SKHDT)] },
      { n: 11, member: M2, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(SKHDT)] },
      { n: 12, member: M3, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(SKKH)] },
    ]);
    await harness.seedRole(TENANT_B, 1, 'REORG_PROPOSER', ['iam.unit.reorganize', 'iam.unit.reorganize.approve', 'iam.unit.reorganize.read'], 50);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT, role: 1, kind: 'TENANT' }]);
    // The projects are the module PRJ's, seeded with the foreign keys to the other modules switched off.
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [n, unit] of [[1, SKHDT], [2, SKHDT], [3, SKKH], [11, DISTRICT], [12, DISTRICT], [13, DISTRICT], [14, DISTRICT], [15, DISTRICT], [16, DISTRICT]] as const) {
        await client.query(
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, $3, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, projectId(n), `P-${n}`, unitId(unit), unitId(ROOT), id(0x50, 90)],
        );
      }
    } finally {
      await client.end();
    }
    await new Promise((resolve) => setTimeout(resolve, 1100));
    tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [UnitReorganizationCommandsController, UnitReorganizationReadsController],
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

  it('AC-ST-ADM-015-1, UAT-AC111: proposed, the proposer cannot approve (403 SELF_APPROVAL_DENIED); the owner approves (202), the job applies it: members and grants on the successor, old grants Expired, projects moved, names kept', async () => {
    const proposed = await propose(PROPOSER, merge());
    expect(proposed).toMatchObject({ status: 201, json: { status: 'PENDING_APPROVAL', resource_version: 1 } });
    const reorgId = proposed.json.resource_id as string;
    expect(await decide(PROPOSER, reorgId, 1)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect(await decide(NOBODY, reorgId, 1)).toMatchObject({ status: 403 });
    expect(await decide(UNIT_ADMIN, reorgId, 1)).toMatchObject({ status: 403 });
    const approved = await decide(OWNER, reorgId, 1);
    expect(approved).toMatchObject({ status: 202, json: { status: 'APPLYING', resource_version: 2 } });
    expect((await outbox(reorgId, 'iam.org_unit.reorganization_approved.v1'))[0]?.payload).toMatchObject({ reorganization_id: reorgId, kind: 'MERGE' });
    // Nothing moved by the approval: the job does it.
    expect((await rows<{ organization_id: string }>('select organization_id from machvon.membership where id = $1', [memberId(M1)]))[0]?.organization_id).toBe(unitId(SKHDT));
    const pass = await runJob();
    expect(pass).toMatchObject({ applied: 1, failed: 0, stopped: 0 });
    expect((await rows<{ organization_id: string }>('select organization_id from machvon.membership where id = any($1::uuid[])', [[memberId(M1), memberId(M2), memberId(M3)]])).every((row) => row.organization_id === unitId(STC))).toBe(true);
    expect((await rows<{ status: string }>("select status from machvon.role_grant where membership_id = any($1::uuid[]) and reorganization_id is null", [[memberId(M1), memberId(M2), memberId(M3)]])).every((row) => row.status === 'Expired')).toBe(true);
    expect((await rows<{ n: string }>("select count(*)::text as n from machvon.role_grant where reorganization_id = $1 and status = 'Active' and scope_ref_ids = $2::uuid[]", [reorgId, [unitId(STC)]]))[0]?.n).toBe('4');
    expect(moved.map((entry) => entry.projectId).sort()).toEqual([projectId(1), projectId(2), projectId(3)].sort());
    expect((await rows<{ id: string; name: string; status: string }>('select id, name, status from machvon.organization_unit where id = any($1::uuid[]) order by id', [[unitId(SKHDT), unitId(SKKH)]])).map((row) => [row.name, row.status])).toEqual([['Unit 2', 'Superseded'], ['Unit 3', 'Superseded']]);
    expect(await outbox(reorgId, 'iam.org_unit.reorganization_applied.v1')).toHaveLength(1);
    // The read: the proposal with its units by the names they have, the steps done and the result.
    const detail = await call('GET', `/resources/unit_reorganization/${reorgId}`, { member: OWNER });
    expect(detail).toMatchObject({ status: 200, json: { id: reorgId, kind: 'MERGE', status: 'Applied', actions: { decide: false } } });
    expect((detail.json.predecessors as Array<{ name: string }>).map((unit) => unit.name)).toEqual(['Unit 2', 'Unit 3']);
    expect((detail.json.successors as Array<{ name: string }>).map((unit) => unit.name)).toEqual(['Unit 4']);
    expect((detail.json.steps as unknown[]).length).toBeGreaterThan(6);
    expect(detail.json.result_summary).toMatchObject({ memberships: 3, grants: 4, projects: 3 });
  });

  it('AC-ST-ADM-015-2, UAT-AC112: a district with 6 projects and a mapping that covers 5 is 422 REORG_MAPPING_INCOMPLETE listing the missing project; nothing is stored', async () => {
    const before = (await rows<{ n: string }>('select count(*)::text as n from machvon.unit_reorganization'))[0]?.n;
    const body = {
      kind: 'SPLIT',
      effective_from: '2026-01-15',
      legal_basis_ref: 'Nghị quyết 13/NQ-UBND ngày 01/10/2026',
      predecessor_unit_ids: [unitId(DISTRICT)],
      successors: [{ existing_unit_id: unitId(WARD_A) }, { existing_unit_id: unitId(WARD_B) }],
      mapping: { projects: [11, 12, 13, 14, 15].map((n) => ({ project_id: projectId(n), successor_unit_id: unitId(WARD_A) })) },
    };
    const refused = await propose(PROPOSER, body);
    expect(refused).toMatchObject({ status: 422, json: { code: 'REORG_MAPPING_INCOMPLETE', missing_project_ids: [projectId(16)], missing_membership_ids: [] } });
    expect(refused.json.errors).toEqual([{ field: 'mapping.projects', id: projectId(16) }]);
    expect((await rows<{ n: string }>('select count(*)::text as n from machvon.unit_reorganization'))[0]?.n).toBe(before);
    // A mapping names only what the old units hold.
    expect(await propose(PROPOSER, { ...body, mapping: { projects: [{ project_id: projectId(1), successor_unit_id: unitId(WARD_A) }], default_successor_unit_id: unitId(WARD_B) } })).toMatchObject({ status: 422, json: { detail: 'mapping.projects[0]' } });
    // With a default successor the same mapping is complete.
    const complete = await propose(PROPOSER, { ...body, mapping: { ...body.mapping, default_successor_unit_id: unitId(WARD_B) } });
    expect(complete).toMatchObject({ status: 201 });
  });

  it('refuses what is not a reorganisation: a kind that is a move, the shape of the kind, units that are gone or have children left behind or are held by another reorganisation', async () => {
    expect(await propose(PROPOSER, merge({ kind: 'TRANSFER' }))).toMatchObject({ status: 422, json: { detail: 'kind' } });
    expect(await propose(PROPOSER, merge({ predecessor_unit_ids: [unitId(SKHDT)] }))).toMatchObject({ status: 422, json: { detail: 'predecessor_unit_ids' } });
    expect(await propose(PROPOSER, merge({ successors: [{ existing_unit_id: unitId(SKHDT) }] }))).toMatchObject({ status: 422 });
    expect(await propose(PROPOSER, merge({ legal_basis_ref: 'x' }))).toMatchObject({ status: 422 });
    await harness.seedUnits(TENANT_A, [70, 71].map((n) => ({ n, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(n)}/` })));
    await harness.seedUnits(TENANT_A, [{ n: 72, parent: 70, path: `/${unitId(ROOT)}/${unitId(70)}/${unitId(72)}/` }]);
    const pair = [unitId(70), unitId(71)];
    // A unit under an old unit that is not reorganised would be left under a unit that stops existing.
    expect(await propose(PROPOSER, merge({ predecessor_unit_ids: pair }))).toMatchObject({ status: 422, json: { code: 'UNIT_VALIDITY_INVALID', detail: 'predecessor_unit_ids' } });
    // The units that are gone are not there to reorganise again.
    expect(await propose(PROPOSER, merge())).toMatchObject({ status: 422, json: { detail: 'predecessor_unit_ids' } });
    await rows("update machvon.organization_unit set status = 'Dissolved', valid_until = date '2026-06-01' where id = $1", [unitId(72)]);
    expect(await propose(PROPOSER, merge({ predecessor_unit_ids: pair, effective_from: '2025-12-31' }))).toMatchObject({ status: 422, json: { code: 'UNIT_VALIDITY_INVALID', detail: 'effective_from' } });
    // An old unit ends the day the reorganisation takes effect: that day has to be after the one it began.
    expect(await propose(PROPOSER, merge({ predecessor_unit_ids: pair, effective_from: '2026-01-01' }))).toMatchObject({ status: 422, json: { code: 'UNIT_VALIDITY_INVALID', detail: 'effective_from' } });
    // A new unit does not go under an old unit (which ends the day it begins).
    const under = { code: 'SO-X', name: 'Sở X', parent_id: unitId(71), unit_type: 'DEPARTMENT', valid_from: '2026-02-01' };
    expect(await propose(PROPOSER, { kind: 'RENAME', effective_from: '2026-02-01', legal_basis_ref: 'Nghị quyết 20/NQ-UBND', predecessor_unit_ids: [unitId(71)], successors: [{ new_unit: under }], mapping: {} })).toMatchObject({ status: 422, json: { code: 'UNIT_VALIDITY_INVALID', detail: 'successors' } });
    // A new unit under a parent that begins after it, or that has an end, could never be created: refused now, not after the approval.
    await harness.seedUnits(TENANT_A, [{ n: 77, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(77)}/` }]);
    await rows("update machvon.organization_unit set valid_from = date '2027-01-01' where id = $1", [unitId(77)]);
    expect(await propose(PROPOSER, { kind: 'RENAME', effective_from: '2026-02-01', legal_basis_ref: 'Nghị quyết 23/NQ-UBND', predecessor_unit_ids: [unitId(71)], successors: [{ new_unit: { ...under, parent_id: unitId(77) } }], mapping: {} })).toMatchObject({ status: 422, json: { code: 'UNIT_VALIDITY_INVALID', detail: 'successors' } });
    await rows("update machvon.organization_unit set valid_from = date '2026-01-01', valid_until = date '2027-12-31' where id = $1", [unitId(77)]);
    expect(await propose(PROPOSER, { kind: 'RENAME', effective_from: '2026-02-01', legal_basis_ref: 'Nghị quyết 23/NQ-UBND', predecessor_unit_ids: [unitId(71)], successors: [{ new_unit: { ...under, parent_id: unitId(77) } }], mapping: {} })).toMatchObject({ status: 422, json: { code: 'UNIT_VALIDITY_INVALID', detail: 'successors' } });
    // A successor that begins after the reorganisation takes effect cannot take over before it begins.
    await harness.seedUnits(TENANT_A, [{ n: 75, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(75)}/` }]);
    await harness.seedUnits(TENANT_A, [{ n: 76, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(76)}/` }]);
    await rows("update machvon.organization_unit set valid_until = date '2026-01-10' where id = $1", [unitId(76)]);
    // A successor that has ended by the day cannot take over on it.
    expect(await propose(PROPOSER, { kind: 'DISSOLVE', effective_from: '2026-02-01', legal_basis_ref: 'Nghị quyết 22/NQ-UBND', predecessor_unit_ids: [unitId(71)], successors: [{ existing_unit_id: unitId(76) }], mapping: {} })).toMatchObject({ status: 422, json: { code: 'UNIT_VALIDITY_INVALID', detail: 'successors' } });
    await rows("update machvon.organization_unit set status = 'Planned', valid_from = date '2027-01-01' where id = $1", [unitId(75)]);
    expect(await propose(PROPOSER, { kind: 'DISSOLVE', effective_from: '2026-02-01', legal_basis_ref: 'Nghị quyết 21/NQ-UBND', predecessor_unit_ids: [unitId(71)], successors: [{ existing_unit_id: unitId(75) }], mapping: {} })).toMatchObject({ status: 422, json: { code: 'UNIT_VALIDITY_INVALID', detail: 'successors' } });
    expect(await propose(PROPOSER, merge({ predecessor_unit_ids: [unitId(SKHDT), randomUUID()] }))).toMatchObject({ status: 404 });
    // The units named by a proposal that waits are held: a second one on them is a conflict.
    await harness.seedUnits(TENANT_A, [90, 91].map((n) => ({ n, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(n)}/` })));
    const first = await propose(PROPOSER, { kind: 'DISSOLVE', effective_from: '2026-01-15', legal_basis_ref: 'Nghị quyết 14/NQ-UBND', predecessor_unit_ids: [unitId(90)], successors: [{ existing_unit_id: unitId(91) }], mapping: {} });
    expect(first.status).toBe(201);
    expect(await propose(PROPOSER, { kind: 'DISSOLVE', effective_from: '2026-01-15', legal_basis_ref: 'Nghị quyết 15/NQ-UBND', predecessor_unit_ids: [unitId(90)], successors: [{ existing_unit_id: unitId(STC) }], mapping: {} })).toMatchObject({ status: 409, json: { code: 'REORG_STATE_INVALID' } });
    // Cancelled, it holds nothing.
    expect(await decide(OWNER, first.json.resource_id as string, 1, { decision: 'reject', reason: 'Chưa đủ căn cứ pháp lý.' })).toMatchObject({ status: 202, json: { status: 'CANCELLED' } });
    expect(await propose(PROPOSER, { kind: 'DISSOLVE', effective_from: '2026-01-15', legal_basis_ref: 'Nghị quyết 15/NQ-UBND', predecessor_unit_ids: [unitId(90)], successors: [{ existing_unit_id: unitId(STC) }], mapping: {} })).toMatchObject({ status: 201 });
  });

  it('checks who may: propose and approve and read on the whole tenant, not on a subtree; across tenants a unit is not there; a stale or missing If-Match, a second decision', async () => {
    expect(await propose(NOBODY, merge())).toMatchObject({ status: 403 });
    expect(await propose(UNIT_ADMIN, merge())).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    expect(await call('POST', '/unit-reorganizations', { member: OTHER_TENANT, tenantId: TENANT_B, body: merge() })).toMatchObject({ status: 404 });
    await harness.seedUnits(TENANT_A, [92].map((n) => ({ n, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(n)}/` })));
    const proposed = await propose(PROPOSER, { kind: 'DISSOLVE', effective_from: '2026-01-15', legal_basis_ref: 'Nghị quyết 16/NQ-UBND', predecessor_unit_ids: [unitId(92)], successors: [{ existing_unit_id: unitId(STC) }], mapping: {} });
    const reorgId = proposed.json.resource_id as string;
    expect(await call('POST', `/unit-reorganizations/${reorgId}/decision`, { member: OWNER, body: { decision: 'approve', reason: 'Đúng.', evidence_ids: [] } })).toMatchObject({ status: 428 });
    expect(await decide(OWNER, reorgId, 9)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await call('POST', `/unit-reorganizations/${reorgId}/decision`, { member: OTHER_TENANT, tenantId: TENANT_B, ifMatch: '"1"', body: { decision: 'approve', reason: 'Đúng.', evidence_ids: [] } })).toMatchObject({ status: 404 });
    // The proposer may withdraw what waits but not approve it; the owner can send it back, and a returned one is still the owner's and the proposer's to withdraw.
    expect((await call('GET', `/resources/unit_reorganization/${reorgId}`, { member: PROPOSER })).json).toMatchObject({ status: 'PendingApproval', actions: { decide: true } });
    expect(await decide(OWNER, reorgId, 1, { decision: 'return', reason: 'Bổ sung căn cứ pháp lý.' })).toMatchObject({ status: 202, json: { status: 'DRAFT' } });
    expect(await decide(OWNER, reorgId, 2)).toMatchObject({ status: 409, json: { code: 'REORG_STATE_INVALID' } });
    expect((await call('GET', `/resources/unit_reorganization/${reorgId}`, { member: OWNER })).json).toMatchObject({ status: 'Draft', actions: { decide: true } });
    expect(await decide(PROPOSER, reorgId, 2, { decision: 'return', reason: 'Tự trả lại đề xuất.' })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect(await decide(PROPOSER, reorgId, 2, { decision: 'reject', reason: 'Rút lại đề xuất này.' })).toMatchObject({ status: 202, json: { status: 'CANCELLED' } });
    expect(await call('GET', '/resources/unit_reorganization', { member: NOBODY })).toMatchObject({ status: 403 });
    expect(await call('GET', '/resources/unit_reorganization', { member: UNIT_ADMIN })).toMatchObject({ status: 403 });
    expect(await call('GET', `/resources/unit_reorganization/${reorgId}`, { member: OTHER_TENANT, tenantId: TENANT_B })).toMatchObject({ status: 404 });
  });

  it('refuses people who would hold two memberships in one unit, and a proposal that meets another that is not over (by its old units or its successors)', async () => {
    await harness.seedUnits(TENANT_A, [80, 81, 82, 83].map((n) => ({ n, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(n)}/` })));
    await harness.seedMembership(TENANT_A, 80, 80);
    await rows("insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) select tenant_id, gen_random_uuid(), user_id, $2::uuid, 'Active', valid_from from machvon.membership where id = $1", [memberId(80), unitId(81)]);
    const body = (preds: number[], succ: number) => ({ kind: 'DISSOLVE', effective_from: '2026-01-15', legal_basis_ref: 'Nghị quyết 30/NQ-UBND', predecessor_unit_ids: preds.map(unitId), successors: [{ existing_unit_id: unitId(succ) }], mapping: {} });
    // Merged into one unit, the same person would be twice in it.
    const twice = await propose(PROPOSER, { ...body([80, 81], 82), kind: 'MERGE' });
    expect(twice).toMatchObject({ status: 422, json: { detail: 'mapping.memberships' } });
    expect((twice.json.duplicate_user_ids as string[]).length).toBe(1);
    // One of the two alone is fine; then another that takes it as a successor, or that uses it as an old unit of a successor of the first, is held.
    expect(await propose(PROPOSER, body([80], 82))).toMatchObject({ status: 201 });
    expect(await propose(PROPOSER, body([83], 80))).toMatchObject({ status: 409, json: { code: 'REORG_STATE_INVALID' } });
    // An old unit of ours that another takes over from is held; two into the same successor are not.
    expect(await propose(PROPOSER, body([82], 83))).toMatchObject({ status: 409, json: { code: 'REORG_STATE_INVALID' } });
    expect(await propose(PROPOSER, body([83], 82))).toMatchObject({ status: 201 });
  });

  it('a request re-sent with the same key replays the first answer and stores one proposal', async () => {
    await harness.seedUnits(TENANT_A, [{ n: 40, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(40)}/` }]);
    const body = { kind: 'DISSOLVE', effective_from: '2026-01-15', legal_basis_ref: 'Nghị quyết 17/NQ-UBND', predecessor_unit_ids: [unitId(40)], successors: [{ existing_unit_id: unitId(STC) }], mapping: {} };
    const first = await propose(PROPOSER, body, 'propose-reorg-key-0001');
    const again = await propose(PROPOSER, body, 'propose-reorg-key-0001');
    expect(first.status).toBe(201);
    expect(again).toEqual(first);
    expect((await rows<{ n: string }>("select count(*)::text as n from machvon.unit_reorganization where mapping_json->'predecessor_unit_ids' ? $1", [unitId(40)]))[0]?.n).toBe('1');
  });

  it('a saga that stops on a project is Failed with the step and code, the alert gauge counts it, and deciding it again carries it on from there', async () => {
    await harness.seedUnits(TENANT_A, [{ n: 50, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(50)}/` }, { n: 51, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(51)}/` }]);
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const n of [21, 22]) {
        await client.query(
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, $3, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, projectId(n), `P-${n}`, unitId(50), unitId(ROOT), id(0x50, 90)],
        );
      }
    } finally {
      await client.end();
    }
    const proposed = await propose(PROPOSER, { kind: 'DISSOLVE', effective_from: '2026-01-15', legal_basis_ref: 'Nghị quyết 18/NQ-UBND', predecessor_unit_ids: [unitId(50)], successors: [{ existing_unit_id: unitId(51) }], mapping: {} });
    const reorgId = proposed.json.resource_id as string;
    await decide(OWNER, reorgId, 1);
    port.failOn = projectId(22);
    const stopped = await runJob();
    expect(stopped).toMatchObject({ failed: 1, stopped: 1 });
    const failed = await call('GET', `/resources/unit_reorganization/${reorgId}`, { member: OWNER });
    expect(failed.json).toMatchObject({ status: 'Failed', actions: { decide: true } });
    expect(failed.json.result_summary).toMatchObject({ failed: { step: `reorg:${reorgId}:project:${projectId(22)}`, code: 'STEP_FAILED' } });
    const movedBefore = moved.filter((entry) => entry.projectId === projectId(21)).length;
    port.failOn = undefined;
    expect(await decide(PROPOSER, reorgId, failed.json.version as number)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
    expect(await decide(OWNER, reorgId, failed.json.version as number)).toMatchObject({ status: 202, json: { status: 'APPLYING' } });
    expect(await runJob()).toMatchObject({ applied: 1, stopped: 0 });
    expect(moved.filter((entry) => entry.projectId === projectId(21))).toHaveLength(movedBefore);
    expect(moved.filter((entry) => entry.projectId === projectId(22))).toHaveLength(1);
    expect((await call('GET', `/resources/unit_reorganization/${reorgId}`, { member: OWNER })).json).toMatchObject({ status: 'Applied' });
  });

  it('with the module that owns projects not bound, the saga stops at the first project with PROJECT_TRANSFER_UNAVAILABLE', async () => {
    await harness.seedUnits(TENANT_A, [{ n: 60, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(60)}/` }, { n: 61, parent: ROOT, path: `/${unitId(ROOT)}/${unitId(61)}/` }]);
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'P-31', 'P-31', $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId(31), unitId(60), unitId(ROOT), id(0x50, 90)],
      );
    } finally {
      await client.end();
    }
    const proposed = await propose(PROPOSER, { kind: 'DISSOLVE', effective_from: '2026-01-15', legal_basis_ref: 'Nghị quyết 19/NQ-UBND', predecessor_unit_ids: [unitId(60)], successors: [{ existing_unit_id: unitId(61) }], mapping: {} });
    await decide(OWNER, proposed.json.resource_id as string, 1);
    const unbound = new UnitReorganizationJob(tenants, new AuditWriter(tenants), new UnboundProjectTransferPort());
    expect(await unbound.run(WORKER, new Date())).toMatchObject({ failed: 1 });
    expect((await call('GET', `/resources/unit_reorganization/${proposed.json.resource_id as string}`, { member: OWNER })).json.result_summary).toMatchObject({ failed: { code: 'PROJECT_TRANSFER_UNAVAILABLE' } });
  });

  it('lists the proposals newest first, by state, with a page', async () => {
    const all = await call('GET', '/resources/unit_reorganization?limit=200', { member: OWNER });
    expect(all.status).toBe(200);
    const items = all.json.items as Array<{ status: string; kind: string; requested_by: { name: string | null } }>;
    expect(items.length).toBeGreaterThan(4);
    expect(items.every((item) => item.requested_by.name !== null)).toBe(true);
    const applied = await call('GET', '/resources/unit_reorganization?status=Applied', { member: OWNER });
    expect((applied.json.items as Array<{ status: string }>).every((item) => item.status === 'Applied')).toBe(true);
    const page = await call('GET', '/resources/unit_reorganization?limit=2', { member: OWNER });
    expect(page.json.next_cursor).not.toBeNull();
    expect(await call('GET', '/resources/unit_reorganization?status=Gone', { member: OWNER })).toMatchObject({ status: 422 });
  });
});
