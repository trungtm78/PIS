import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { AdmMigrationStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import type { MigrationBatch } from '@machvon/db';
import {
  MIGRATION_MAPPINGS,
  ORG_PACK_ENTITY,
  ORG_PACK_MAPPING_VERSION,
  effectivePermissions,
  judgeMigrationFile,
  loadErrorRegistry,
  orgPackCsv,
  readTabularFile,
  signTenantContext,
} from '@machvon/kernel';
import type { OrgPack } from '@machvon/kernel';
import { INPUT_POINT_CODES, PVFCCO_PACK_LABEL, pvfccoTemplatePack, registerEnterpriseOrgPack } from '@machvon/edition-enterprise/src/server.ts';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { orgPackModule } from '../../src/editions/enterprise';
import { OrgPackController } from '../../src/editions/enterprise/org-pack.controller';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

/**
 * The PVFCCo configuration pack through the application the enterprise edition mounts (ENT-3d, HT.02, HT.03, MD.03, QT.01): the file goes through the real batch import (register, dry run, apply by somebody other than
 * who registered it), the command turns the applied batch into units, roles and proposals, a second run changes nothing, and the roles of the pack keep a unit's people in their unit while the planning unit and the
 * leadership see everything. The name ends in `.enterprise.test.ts`: it is one of the few sources that may name the enterprise package.
 */
jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1; // approves the batch and runs the load: holds the rights of everything the pack becomes
const REGISTRAR = 2; // registers the file and asks for the dry run
const LIMITED = 3; // may approve a batch, nothing else
const B_ADMIN = 1;
const ROOT = 1;
const ALL = ['iam.*', 'adm.*', 'master.*', 'ind.*', 'funding.*', 'report.*', 'report_revision.*', 'project.*', 'home.*', 'approval.*', 'approval_task.*', 'workflow_instance.*', 'period.*', 'hpm.*', 'ebs.*', 'rpt.*', 'directive.*', 'capital.*', 'reporting_period.*', 'bi.*'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}
interface PlanItem {
  key: string;
  action: string;
}
interface ResultItem {
  key: string;
  result: string;
}

describe('the PVFCCo configuration pack (ENT-3d)', () => {
  const harness = new AuthzHarness();
  const store = new AdmMigrationStore();
  let app: RunningApp;
  let tenants: TenantDatabase;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const as = (member: number) => contextFor(TENANT_A, memberId(member));

  /** The file goes the whole way of the import: register (one person), dry run, apply (another person), the rows written in a lot, the control totals compared. */
  async function loadFile(pack: OrgPack, options: { registrar?: number; applier?: number } = {}): Promise<{ batch: MigrationBatch; passed: boolean }> {
    counter += 1;
    const bytes = new TextEncoder().encode(orgPackCsv(pack));
    const sha = createHash('sha256').update(bytes).update(String(counter)).digest('hex');
    const registrar = options.registrar ?? REGISTRAR;
    const batch = await tenants.withTenant(as(registrar), (tx) => store.register(tx, { sourceSystem: PVFCCO_PACK_LABEL, targetEntity: ORG_PACK_ENTITY, fileSha256: sha, fileStorageKey: `k-${sha}`, mappingVersion: ORG_PACK_MAPPING_VERSION }, memberId(registrar)));
    const asked = await tenants.withTenant(as(registrar), (tx) => store.requestDryRun(tx, batch.id, batch.version));
    const table = readTabularFile(bytes);
    const outcome = await tenants.withTenant(as(registrar), (tx) => store.recordDryRun(tx, asked.id, table));
    const judged = judgeMigrationFile(table, MIGRATION_MAPPINGS.get(ORG_PACK_MAPPING_VERSION) as never);
    if (outcome?.status !== 'DryRunPassed') return { batch: (await tenants.withTenant(as(registrar), (tx) => store.find(tx, batch.id))) as MigrationBatch, passed: false };
    const current = (await tenants.withTenant(as(registrar), (tx) => store.find(tx, batch.id))) as MigrationBatch;
    const applier = options.applier ?? ADMIN;
    await tenants.withTenant(as(applier), (tx) => store.requestApply(tx, current.id, current.version, memberId(applier)));
    await tenants.withTenant(as(applier), (tx) => store.writeLot(tx, current.id, judged.rows));
    await tenants.withTenant(as(applier), (tx) => store.finishApply(tx, current.id));
    return { batch: (await tenants.withTenant(as(applier), (tx) => store.find(tx, current.id))) as MigrationBatch, passed: true };
  }

  const materialise = (batchId: string, member = ADMIN): Promise<Reply> => call('POST', '/enterprise/org-pack/materialisations', { member, body: { batch_id: batchId } });
  const resultsOf = (reply: Reply): ResultItem[] => reply.json.items as ResultItem[];

  beforeAll(async () => {
    registerEnterpriseOrgPack();
    await harness.start();
    tenants = harness.tenants as TenantDatabase;
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const n of [ADMIN, REGISTRAR, LIMITED]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'PACK_ADMIN', ALL, 89);
    await harness.seedRole(TENANT_A, 2, 'PACK_REGISTRAR', ['adm.migration.read', 'adm.migration.manage'], 30);
    await harness.seedRole(TENANT_A, 3, 'PACK_APPROVER_ONLY', ['adm.migration.read', 'adm.migration.approve'], 30);
    await harness.seedRole(TENANT_B, 1, 'PACK_ADMIN', ALL, 89);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: REGISTRAR, role: 2, kind: 'TENANT' },
      { n: 3, member: LIMITED, role: 3, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' }]);
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [OrgPackController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is a module of the enterprise edition only, with its controller', () => {
    expect(orgPackModule.editions).toEqual(['enterprise']);
    expect(orgPackModule.controllers).toContain(OrgPackController);
  });

  describe('getEnterpriseOrgPack', () => {
    it('shows the template as it is, with the nine input points, the plan against an empty tenant and the file to register', async () => {
      const reply = await call('GET', '/enterprise/org-pack', { member: ADMIN });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ label: 'PVFCCO-TEMPLATE', source: 'TEMPLATE', batch_id: null, loader: { target_entity: 'ORG_PACK', mapping_version: 'ORG-PACK-1' }, structure_complete: false });
      const units = reply.json.units as Array<{ code: string; unit_function: string; present: boolean }>;
      expect(units.filter((unit) => unit.unit_function === 'INPUT_POINT')).toHaveLength(9);
      expect(units.find((unit) => unit.code === 'PVFCCO')?.present).toBe(true);
      expect(units.find((unit) => unit.code === 'KHDT')?.present).toBe(false);
      const plan = reply.json.plan as PlanItem[];
      expect(plan.find((item) => item.key === 'UNIT:PVFCCO')?.action).toBe('UNCHANGED');
      expect(plan.filter((item) => item.key !== 'UNIT:PVFCCO').every((item) => item.action === 'CREATE')).toBe(true);
      expect(reply.json.file_csv).toBe(orgPackCsv(pvfccoTemplatePack()));
      expect(reply.json.seat_counts).toMatchObject({ FILLED: 0 });
    });

    it('is refused to a member who cannot read the loader and never shows another tenant', async () => {
      expect((await call('GET', '/enterprise/org-pack', { member: 99 })).status).toBeGreaterThanOrEqual(401);
      expect((await call('GET', '/enterprise/org-pack', { member: B_ADMIN, tenantId: TENANT_B })).status).toBe(200);
      expect(await rows('select 1 from machvon.organization_unit where code = $1', ['KHDT'], TENANT_B)).toHaveLength(0);
    });
  });

  describe('the load through the real import path', () => {
    it('stops a pack that breaks a rule at the dry run, naming the row, and writes nothing to the tenant', async () => {
      const pack = pvfccoTemplatePack();
      const broken = { ...pack, seats: pack.seats.map((seat) => (seat.roleCode === 'ENT_DATA_ENTRY' && seat.unitCode === 'NM_DPM' ? { ...seat, scope: 'TENANT' as const } : seat)) };
      const { batch, passed } = await loadFile(broken);
      expect(passed).toBe(false);
      expect(batch.status).toBe('DryRunFailed');
      const errors = await tenants.withTenant(as(REGISTRAR), (tx) => store.errorsOf(tx, batch.id));
      expect(errors.map((error) => [error.code, error.field])).toEqual([['PACK_INVALID', 'data.scope']]);
      expect(errors[0]?.message).toContain('SEAT_SCOPE');
      expect(await rows("select 1 from machvon.migration_row where target_entity = 'ORG_PACK'")).toHaveLength(0);
    });

    it('stops an entry of a catalogue that does not meet the rules of its type, on its row', async () => {
      const pack = pvfccoTemplatePack();
      const wrong = { ...pack, entries: pack.entries.map((entry) => (entry.key === 'PVN' ? { ...entry, attributes: { ...entry.attributes, channel: 'PIGEON' } } : entry)) };
      const { batch, passed } = await loadFile(wrong);
      expect(passed).toBe(false);
      const errors = await tenants.withTenant(as(REGISTRAR), (tx) => store.errorsOf(tx, batch.id));
      expect(errors.map((error) => [error.code, error.field])).toEqual([['PACK_INVALID', 'attributes.channel']]);
    });

    it('refuses to apply a batch by the person who registered it', async () => {
      const bytes = new TextEncoder().encode(orgPackCsv(pvfccoTemplatePack()));
      const sha = createHash('sha256').update(bytes).update('self-approval').digest('hex');
      const batch = await tenants.withTenant(as(REGISTRAR), (tx) => store.register(tx, { sourceSystem: PVFCCO_PACK_LABEL, targetEntity: ORG_PACK_ENTITY, fileSha256: sha, fileStorageKey: 'k-self', mappingVersion: ORG_PACK_MAPPING_VERSION }, memberId(REGISTRAR)));
      const asked = await tenants.withTenant(as(REGISTRAR), (tx) => store.requestDryRun(tx, batch.id, batch.version));
      await tenants.withTenant(as(REGISTRAR), (tx) => store.recordDryRun(tx, asked.id, readTabularFile(bytes)));
      const passed = (await tenants.withTenant(as(REGISTRAR), (tx) => store.find(tx, batch.id))) as MigrationBatch;
      expect(passed.status).toBe('DryRunPassed');
      await expect(tenants.withTenant(as(REGISTRAR), (tx) => store.requestApply(tx, passed.id, passed.version, memberId(REGISTRAR)))).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
    });
  });

  describe('materialiseEnterpriseOrgPack', () => {
    let batchId = '';

    it('refuses a batch that was not applied, a caller without the rights of what the batch becomes, and a batch of another tenant', async () => {
      const sha = createHash('sha256').update('not-applied').digest('hex');
      const waiting = await tenants.withTenant(as(REGISTRAR), (tx) => store.register(tx, { sourceSystem: PVFCCO_PACK_LABEL, targetEntity: ORG_PACK_ENTITY, fileSha256: sha, fileStorageKey: 'k-wait', mappingVersion: ORG_PACK_MAPPING_VERSION }, memberId(REGISTRAR)));
      expect(await materialise(waiting.id)).toMatchObject({ status: 409, json: { code: 'MIGRATION_STATE_INVALID' } });
      expect((await materialise(waiting.id, LIMITED)).status).toBe(403);
      expect((await materialise(randomUUID(), B_ADMIN)).status).toBeGreaterThanOrEqual(400);
      expect((await call('POST', '/enterprise/org-pack/materialisations', { member: ADMIN, body: { batch_id: 'nope' } })).status).toBeGreaterThanOrEqual(400);
    });

    it('turns the applied batch into the units and the roles, and proposes the rules, the matrix rule and the catalogue entries for approval by somebody else', async () => {
      const loaded = await loadFile(pvfccoTemplatePack());
      expect(loaded.passed).toBe(true);
      expect(loaded.batch).toMatchObject({ status: 'Applied', createdBy: memberId(REGISTRAR), approvedBy: memberId(ADMIN) });
      batchId = loaded.batch.id;
      const reply = await materialise(batchId);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ label: 'PVFCCO-TEMPLATE', batch_id: batchId });
      const counts = reply.json.counts as Record<string, number>;
      expect(counts).toMatchObject({ DRIFT: 0, BLOCKED: 0, PENDING: 0 });
      expect(counts.CREATED).toBe(resultsOf(reply).filter((item) => item.result === 'CREATED').length);
      expect(resultsOf(reply).find((item) => item.key === 'UNIT:PVFCCO')?.result).toBe('UNCHANGED');

      const units = await rows<{ code: string; unit_type: string; legal_basis_ref: string; parent: string | null }>(
        'select u.code, u.unit_type, u.legal_basis_ref, p.code as parent from machvon.organization_unit u left join machvon.organization_unit p on p.id = u.parent_id where u.code = any($1::text[]) order by u.code',
        [['KHDT', 'CN_QLPTDA', 'NM_DPM', 'TM', 'KTAT', 'TH', 'TCKT', 'TT_NCUD', 'TDA_1', 'TDA_2', 'BTGD', 'HDQT', 'CDS_CNTT']],
      );
      expect(units).toHaveLength(13);
      expect(units.every((unit) => unit.parent === 'U1' && unit.legal_basis_ref === 'PVFCCO-TEMPLATE')).toBe(true);
      expect(units.find((unit) => unit.code === 'BTGD')?.unit_type).toBe('GOVERNING_BODY');

      const roles = await rows<{ code: string; rank: number; is_system: boolean; created_by: string }>("select code, rank, is_system, created_by from machvon.role_definition where code like 'ENT\\_%' order by code");
      expect(roles.map((role) => role.code)).toEqual(['ENT_DATA_ENTRY', 'ENT_EDITION_ADMIN', 'ENT_LEADERSHIP_VIEWER', 'ENT_PLANNING_REVIEWER', 'ENT_UNIT_APPROVER']);
      expect(roles.every((role) => !role.is_system && role.created_by === memberId(ADMIN))).toBe(true);

      // Policies are proposed, never in force: a rule version submitted by the loader, a matrix pending approval, entries in review.
      const rules = await rows<{ rule_type: string; code: string; status: string; created_by: string; approved_by: string | null }>(
        "select rule_type, code, status, created_by, approved_by from machvon.governance_rule where rule_type in ('APPROVAL_WORKFLOW_DEFINITION', 'ABSENCE_POLICY') order by rule_type",
      );
      expect(rules).toEqual([
        { rule_type: 'ABSENCE_POLICY', code: 'DEFAULT', status: 'SUBMITTED', created_by: memberId(ADMIN), approved_by: null },
        { rule_type: 'APPROVAL_WORKFLOW_DEFINITION', code: 'REPORT_ACCEPT', status: 'SUBMITTED', created_by: memberId(ADMIN), approved_by: null },
      ]);
      const workflow = await rows<{ params: { mode: string; steps: Array<{ kind: string; unit_id?: string }> } }>("select params from machvon.governance_rule where code = 'REPORT_ACCEPT'");
      expect(workflow[0]?.params.mode).toBe('STAGED');
      expect(workflow[0]?.params.steps.map((step) => step.kind)).toEqual(['UNIT_APPROVER', 'PLANNING_REVIEW', 'PERIOD_CLOSE', 'PUSH']);
      const khdt = await rows<{ id: string }>("select id from machvon.organization_unit where code = 'KHDT'");
      expect(workflow[0]?.params.steps[1]?.unit_id).toBe(khdt[0]?.id);
      const matrices = await rows<{ status: string; legal_basis_ref: string; approved_by: string | null }>('select status, legal_basis_ref, approved_by from machvon.doa_matrix_version');
      expect(matrices).toEqual([{ status: 'PendingApproval', legal_basis_ref: 'PVFCCO-TEMPLATE', approved_by: null }]);
      const entries = await rows<{ status: string; n: string }>("select status, count(*)::text as n from machvon.master_record where namespace = 'TENANT' and master_type = any($1::text[]) group by status", [['REPORTING_PERIOD_KIND', 'REPORT_TYPE', 'RECEIVING_AGENCY', 'CAPITAL_SOURCE', 'REPORT_UNIT', 'ISSUE_CATEGORY']]);
      expect(entries).toEqual([{ status: 'IN_REVIEW', n: String(pvfccoTemplatePack().entries.length) }]);
      const tree = await rows<{ key: string; parent: string | null }>(
        "select r.business_key as key, pr.business_key as parent from machvon.master_record r join machvon.master_record_version v on v.master_record_id = r.id left join machvon.master_record pr on pr.id = v.parent_id where r.master_type = 'ISSUE_CATEGORY' and r.business_key like 'DC\\_%'",
      );
      expect(tree.length).toBeGreaterThanOrEqual(8);
      expect(tree.every((row) => row.parent === 'DELAY_CAUSE')).toBe(true);

      const audit = await rows<{ safe_diff: { label: string; counts: Record<string, number> }; actor_id: string }>("select safe_diff, actor_id from machvon.audit_event where action = 'ent.org_pack.materialised'");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_id: memberId(ADMIN), safe_diff: { label: 'PVFCCO-TEMPLATE' } });
      const events = await rows<{ payload: { batch_id: string } }>("select payload from machvon.outbox_event where type = 'ent.org_pack.materialised.v1'");
      expect(events.map((event) => event.payload.batch_id)).toEqual([batchId]);
    });

    it('changes nothing the second time', async () => {
      const before = await rows<{ n: string }>('select (select count(*) from machvon.organization_unit) + (select count(*) from machvon.role_definition) + (select count(*) from machvon.governance_rule) + (select count(*) from machvon.doa_matrix_version) + (select count(*) from machvon.master_record) as n');
      const again = await materialise(batchId);
      expect(again.status).toBe(200);
      expect(again.json.counts).toMatchObject({ CREATED: 0, DRIFT: 0, BLOCKED: 0 });
      expect(resultsOf(again).filter((item) => item.key.startsWith('UNIT:') || item.key.startsWith('ROLE:')).every((item) => item.result === 'UNCHANGED')).toBe(true);
      expect(resultsOf(again).filter((item) => item.key.startsWith('RULE:') || item.key.startsWith('DOA:') || item.key.startsWith('ENTRY:')).every((item) => item.result === 'PENDING')).toBe(true);
      const after = await rows<{ n: string }>('select (select count(*) from machvon.organization_unit) + (select count(*) from machvon.role_definition) + (select count(*) from machvon.governance_rule) + (select count(*) from machvon.doa_matrix_version) + (select count(*) from machvon.master_record) as n');
      expect(after).toEqual(before);
    });

    it('reports a unit that was renamed as drift and does not overwrite it', async () => {
      await rows("update machvon.organization_unit set name = 'Renamed by the customer' where code = 'TM'");
      const reply = await materialise(batchId);
      expect(resultsOf(reply).find((item) => item.key === 'UNIT:TM')?.result).toBe('DRIFT');
      expect(reply.json.counts).toMatchObject({ CREATED: 0, DRIFT: 1 });
      expect((await rows<{ name: string }>("select name from machvon.organization_unit where code = 'TM'"))[0]?.name).toBe('Renamed by the customer');
    });

    it('counts who sits in each seat, and a role held outside its seat as stray', async () => {
      const overview = await call('GET', `/enterprise/org-pack?batch_id=${batchId}`, { member: ADMIN });
      expect(overview.json).toMatchObject({ source: 'BATCH', batch_id: batchId, stray_grants: 0, defects: [] });
      expect(overview.json.seat_counts).toMatchObject({ VACANT: pvfccoTemplatePack().seats.length, FILLED: 0, OVER: 0 });
      const entry = (await rows<{ id: string }>("select id from machvon.role_definition where code = 'ENT_DATA_ENTRY'"))[0]?.id;
      const nm = (await rows<{ id: string }>("select id from machvon.organization_unit where code = 'NM_DPM'"))[0]?.id;
      await harness.seedMembership(TENANT_A, 10, ROOT);
      const grant = (n: number, kind: string, refs: string[]) =>
        rows(
          `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
           values ($1, $2, $3, $4, $5::jsonb, '2026-01-01T00:00:00Z', $6, $7::uuid[], 'Active', $8, 'test')`,
          [TENANT_A, id(0x41, n), memberId(10), entry, JSON.stringify({ kind, ref_ids: refs }), kind, refs, memberId(ADMIN)],
        );
      await grant(1, 'UNIT_ONLY', [nm as string]);
      await grant(2, 'TENANT', []);
      const after = await call('GET', `/enterprise/org-pack?batch_id=${batchId}`, { member: ADMIN });
      const seats = after.json.seats as Array<{ key: string; holders: number; state: string }>;
      expect(seats.find((seat) => seat.key === 'SEAT:ENT_DATA_ENTRY@NM_DPM')).toMatchObject({ holders: 1, state: 'FILLED' });
      expect(after.json.stray_grants).toBe(1);
      expect(INPUT_POINT_CODES).toHaveLength(9);
    });
  });

  describe('what the roles of the pack let a person see (HT.02)', () => {
    it('keeps the person of an input point in the unit, and lets the planning unit and the leadership see all units', async () => {
      const access = new EffectiveAccessStore(tenants, new InMemoryAuthzCache());
      const unit = async (code: string) => {
        const row = (await rows<{ id: string; path: string }>('select id, path from machvon.organization_unit where code = $1', [code]))[0] as { id: string; path: string };
        return { ownerUnitId: row.id, ownerUnitPath: row.path };
      };
      const role = async (code: string) => (await rows<{ id: string }>('select id from machvon.role_definition where code = $1', [code]))[0]?.id as string;
      const hold = async (n: number, roleCode: string, kind: string, refs: string[]) => {
        await harness.seedMembership(TENANT_A, n, ROOT);
        await rows(
          `insert into machvon.role_grant (tenant_id, id, membership_id, role_id, scope_json, effective_from, scope_kind, scope_ref_ids, status, granted_by, grant_reason)
           values ($1, $2, $3, $4, $5::jsonb, '2026-01-01T00:00:00Z', $6, $7::uuid[], 'Active', $8, 'test')`,
          [TENANT_A, id(0x42, n), memberId(n), await role(roleCode), JSON.stringify({ kind, ref_ids: refs }), kind, refs, memberId(ADMIN)],
        );
        return access.load(contextFor(TENANT_A, memberId(n)));
      };
      const own = await unit('NM_DPM');
      const other = await unit('TM');
      const now = new Date();
      const entryUser = await hold(20, 'ENT_DATA_ENTRY', 'UNIT_ONLY', [own.ownerUnitId]);
      expect(effectivePermissions(entryUser, now, own).has('ind.entry')).toBe(true);
      expect(effectivePermissions(entryUser, now, other).has('ind.entry')).toBe(false);
      expect(effectivePermissions(entryUser, now, other).has('project.read')).toBe(false);
      expect(effectivePermissions(entryUser, now, own).has('project.read')).toBe(true);
      const approver = await hold(21, 'ENT_UNIT_APPROVER', 'UNIT_ONLY', [own.ownerUnitId]);
      expect(effectivePermissions(approver, now, own).has('approval.decide')).toBe(true);
      expect(effectivePermissions(approver, now, other).has('approval.decide')).toBe(false);
      for (const [n, roleCode] of [[22, 'ENT_PLANNING_REVIEWER'], [23, 'ENT_LEADERSHIP_VIEWER']] as const) {
        const wide = await hold(n, roleCode, 'TENANT', []);
        expect(effectivePermissions(wide, now, own).has('project.read')).toBe(true);
        expect(effectivePermissions(wide, now, other).has('project.read')).toBe(true);
      }
      // Leadership reads and never writes anywhere; the planning unit closes the period and the unit people cannot.
      const viewer = await hold(24, 'ENT_LEADERSHIP_VIEWER', 'TENANT', []);
      const held = effectivePermissions(viewer, now, other);
      expect([...held].every((name) => /\.(read|query)$/.test(name))).toBe(true);
      const planner = await hold(25, 'ENT_PLANNING_REVIEWER', 'TENANT', []);
      expect(effectivePermissions(planner, now, other).has('period.lock')).toBe(true);
      expect(effectivePermissions(entryUser, now, own).has('period.lock')).toBe(false);
      expect(effectivePermissions(approver, now, own).has('period.lock')).toBe(false);
    });
  });
});
