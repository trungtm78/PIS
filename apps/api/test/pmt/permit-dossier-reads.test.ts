import { randomBytes } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { PermitDossierReadsController, PermitReadsController } from '../../src/modules/pmt/permit-dossier-reads.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const READER = 1; // permit.read on the department (unit 2)
const TENANT_READER = 2; // permit.read on the whole tenant
const OTHER_BRANCH_READER = 3; // permit.read on another branch (unit 3)
const MANAGER_ONLY = 4; // permit.manage, no permit.read
const NOBODY = 5;
const OTHER_TENANT_READER = 1; // of tenant B
const FAMILY = 0x95;
const DAY_MS = 86_400_000;
const inDays = (days: number): string => new Date(Date.now() + 7 * 3_600_000 + days * DAY_MS).toISOString().slice(0, 10);

const PROJECT = id(FAMILY, 1);
const PROJECT_BRANCH = id(FAMILY, 2);
const FOREIGN_PROJECT = id(FAMILY, 3);
const DOSSIER = id(FAMILY, 11);
const DOSSIER_BRANCH = id(FAMILY, 12);
const FOREIGN_DOSSIER = id(FAMILY, 13);
const ISSUED = id(FAMILY, 21);
const PLANNED = id(FAMILY, 22);
const FOREIGN_PERMIT = id(FAMILY, 23);
const TYPE_ENV = id(FAMILY, 31);
const TYPE_FIRE = id(FAMILY, 32);
const DOCUMENT = id(FAMILY, 41);
const DOCUMENT_ROW = id(FAMILY, 42);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the reads of the permit dossier and the permit (ST-PMT-002, PMT-01 and PMT-02)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function get(url: string, options: { member: number; tenantId?: string }): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}${url}`, { headers: { [TENANT_HEADER]: tokenOf(options.member, options.tenantId) } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: 1, path: '/u1/' },
        { n: 2, path: '/u1/u2/', parent: 1 },
        { n: 3, path: '/u3/' },
      ]);
    }
    for (const n of [READER, TENANT_READER, OTHER_BRANCH_READER, MANAGER_ONLY, NOBODY]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_READER, 1);
    await harness.seedRole(TENANT_A, 1, 'PERMIT_READER', ['permit.read'], 20);
    await harness.seedRole(TENANT_A, 2, 'PERMIT_MANAGER', ['permit.manage'], 30);
    await harness.seedRole(TENANT_B, 1, 'PERMIT_READER', ['permit.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: READER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 2, member: TENANT_READER, role: 1, kind: 'TENANT' },
      { n: 3, member: OTHER_BRANCH_READER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(3)] },
      { n: 4, member: MANAGER_ONLY, role: 2, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_READER, role: 1, kind: 'TENANT' }]);
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      const project = (tenant: string, projectId: string, code: string, owner: number) =>
        admin.query(
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, $3, $4, $5, $6, $7, 'INTERNAL', 1000000, 'IMPLEMENTATION', 1, 'B')`,
          [tenant, projectId, code, `Name of ${code}`, unitId(owner), unitId(1), id(FAMILY, 90)],
        );
      await project(TENANT_A, PROJECT, 'PRJ-R-001', 2);
      await project(TENANT_A, PROJECT_BRANCH, 'PRJ-R-002', 3);
      await project(TENANT_B, FOREIGN_PROJECT, 'PRJ-R-FOREIGN', 2);
      for (const tenant of [TENANT_A, TENANT_B]) {
        await admin.query(
          `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'GP', 'Permit scan', 'INTERNAL', $3, $3)`,
          [tenant, DOCUMENT_ROW, memberId(READER)],
        );
        await admin.query(
          `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
           values ($1, $2, $3, 1, 'tenants/pmt/a.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
          [tenant, DOCUMENT, DOCUMENT_ROW],
        );
        for (const [typeId, code, cxn] of [[TYPE_ENV, 'READ_ENV', null], [TYPE_FIRE, 'READ_FIRE', 'CXN-EXE-03']] as const) {
          await admin.query(
            `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, cxn_ref, effective_from, applies_to_rule, status, created_by, updated_by)
             values ($1, $2, $3, $4, 'OTHER', 'The authority', 'Read fixture legal basis', $5, date '2026-01-01', '{}'::jsonb, 'PUBLISHED', $6, $6)`,
            [tenant, typeId, code, `Name of ${code}`, cxn, memberId(READER)],
          );
        }
      }
      const dossier = (tenant: string, dossierId: string, projectId: string, owner: number, readiness: string) =>
        admin.query(
          `insert into machvon.permit_dossier (tenant_id, id, project_id, owner_unit_id, owner_membership_id, readiness_pct, created_by, updated_by) values ($1, $2, $3, $4, $5, $6::numeric, $5, $5)`,
          [tenant, dossierId, projectId, unitId(owner), memberId(tenant === TENANT_A ? READER : OTHER_TENANT_READER), readiness],
        );
      await dossier(TENANT_A, DOSSIER, PROJECT, 2, '50.00');
      await dossier(TENANT_A, DOSSIER_BRANCH, PROJECT_BRANCH, 3, '0.00');
      await dossier(TENANT_B, FOREIGN_DOSSIER, FOREIGN_PROJECT, 2, '0.00');
      // The issued permit ends inside the window of the first alert; the planned one still waits for its confirmation (REQUIRED).
      await admin.query(
        `insert into machvon.permit (tenant_id, id, dossier_id, permit_type_id, permit_type_code, status, permit_no, authority_name, issued_on, valid_from, valid_until, document_version_id, is_required, responsible_membership_id, created_by, updated_by)
         values ($1, $2, $3, $4, 'READ_ENV', 'ISSUED', 'GP-READ-1', 'Department of Environment', $5::date, $5::date, $6::date, $7, true, $8, $8, $8)`,
        [TENANT_A, ISSUED, DOSSIER, TYPE_ENV, inDays(-30), inDays(20), DOCUMENT, memberId(READER)],
      );
      await admin.query(
        `insert into machvon.permit (tenant_id, id, dossier_id, permit_type_id, permit_type_code, status, is_required, created_by, updated_by) values ($1, $2, $3, $4, 'READ_FIRE', 'PLANNED', true, $5, $5)`,
        [TENANT_A, PLANNED, DOSSIER, TYPE_FIRE, memberId(READER)],
      );
      await admin.query(
        `insert into machvon.permit (tenant_id, id, dossier_id, permit_type_id, permit_type_code, status, permit_no, created_by, updated_by) values ($1, $2, $3, $4, 'READ_ENV', 'PLANNED', 'FOREIGN-1', $5, $5)`,
        [TENANT_B, FOREIGN_PERMIT, FOREIGN_DOSSIER, TYPE_ENV, memberId(OTHER_TENANT_READER)],
      );
      const step = (stepCode: string, planned: string | null, actual: string | null, note: string | null, offset: number) =>
        admin.query(
          `insert into machvon.permit_milestone (tenant_id, id, permit_id, step_code, planned_on, actual_on, note, document_version_id, created_by, created_at)
           values ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, now() + ($10::int * interval '1 second'))`,
          [TENANT_A, id(FAMILY, 50 + offset), ISSUED, stepCode, planned, actual, note, stepCode === 'DECISION' ? DOCUMENT : null, memberId(READER), offset],
        );
      await step('SUBMITTED', null, inDays(-40), 'Filed at the one-stop office', 1);
      await step('ACKNOWLEDGED', null, inDays(-38), null, 2);
      await step('DECISION', null, inDays(-30), null, 3);
    } finally {
      await admin.end();
    }
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [PermitDossierReadsController, PermitReadsController],
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

  describe('get_resources_permit_dossier', () => {
    it('lists the dossiers in the scope of the caller with the counts of the day, in the shape of the read model (PMT-01, AC-ST-PMT-002-2)', async () => {
      const reply = await get('/resources/permit_dossier', { member: READER });
      expect(reply.status).toBe(200);
      expect(typeof reply.json.as_of).toBe('string');
      expect(reply.json.items).toEqual([
        {
          id: DOSSIER,
          project_id: PROJECT,
          project_code: 'PRJ-R-001',
          project_name: 'Name of PRJ-R-001',
          project_component_id: null,
          project_component_code: null,
          owner_unit_id: unitId(2),
          owner_unit_name: 'Unit 2',
          owner_membership: { membership_id: memberId(READER), display_name: 'User 1' },
          status: 'OPEN',
          readiness_pct: '50.00',
          required_count: 2,
          satisfied_count: 1,
          issued_count: 1,
          expiring_count: 1,
          unconfirmed_count: 1,
          version: 1,
        },
      ]);
      expect(reply.json.next_cursor).toBeNull();
    });

    it('shows each caller the dossiers of its units: the branch reader sees the branch, the tenant reader sees both, and a caller without permit.read is refused', async () => {
      const codes = async (member: number) => ((await get('/resources/permit_dossier', { member })).json.items as Array<{ project_code: string }>).map((item) => item.project_code);
      expect(await codes(OTHER_BRANCH_READER)).toEqual(['PRJ-R-002']);
      expect(await codes(TENANT_READER)).toEqual(['PRJ-R-001', 'PRJ-R-002']);
      expect((await get('/resources/permit_dossier', { member: MANAGER_ONLY })).status).toBe(403);
      expect((await get('/resources/permit_dossier', { member: NOBODY })).status).toBe(403);
    });

    it('filters by project, pages by keyset, and refuses a project that is not an id or a bad page', async () => {
      const filtered = await get(`/resources/permit_dossier?project_id=${PROJECT_BRANCH.toUpperCase()}`, { member: TENANT_READER });
      expect((filtered.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([DOSSIER_BRANCH]);
      const page = await get('/resources/permit_dossier?limit=1', { member: TENANT_READER });
      expect((page.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([DOSSIER]);
      expect(typeof page.json.next_cursor).toBe('string');
      const next = await get(`/resources/permit_dossier?limit=1&cursor=${page.json.next_cursor as string}`, { member: TENANT_READER });
      expect((next.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([DOSSIER_BRANCH]);
      expect(next.json.next_cursor).toBeNull();
      const bad = await get('/resources/permit_dossier?project_id=not-an-id', { member: TENANT_READER });
      expect([bad.status, bad.json.code, bad.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'project_id']);
      expect((await get('/resources/permit_dossier?cursor=garbage', { member: TENANT_READER })).status).toBe(422);
    });

    it('lists nothing of another tenant, in either direction', async () => {
      expect(((await get('/resources/permit_dossier', { member: OTHER_TENANT_READER, tenantId: TENANT_B })).json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([FOREIGN_DOSSIER]);
      const mine = (await get('/resources/permit_dossier', { member: TENANT_READER })).json.items as Array<{ id: string }>;
      expect(mine.map((item) => item.id)).not.toContain(FOREIGN_DOSSIER);
    });
  });

  describe('get_resources_permit_dossier_id', () => {
    it('reads one dossier with its permits: the type version of each, the flag of the one that waits for its confirmation, the days, the person in charge (PMT-01)', async () => {
      const reply = await get(`/resources/permit_dossier/${DOSSIER}`, { member: READER });
      expect(reply.status).toBe(200);
      const permits = reply.json.permits as Array<Record<string, unknown>>;
      expect(permits.map((permit) => [permit.permit_type_code, permit.status])).toEqual([
        ['READ_ENV', 'ISSUED'],
        ['READ_FIRE', 'PLANNED'],
      ]);
      expect(permits[0]).toEqual({
        id: ISSUED,
        permit_type_id: TYPE_ENV,
        permit_type_code: 'READ_ENV',
        permit_type_revision: 1,
        permit_type_name: 'Name of READ_ENV',
        cxn_ref: null,
        exemption_allowed: false,
        is_required: true,
        status: 'ISSUED',
        permit_no: 'GP-READ-1',
        authority_name: 'Department of Environment',
        submitted_on: null,
        expected_decision_on: null,
        issued_on: inDays(-30),
        valid_from: inDays(-30),
        valid_until: inDays(20),
        no_expiry: false,
        supersedes_id: null,
        responsible_membership: { membership_id: memberId(READER), display_name: 'User 1' },
        version: 1,
      });
      expect(permits[1]).toMatchObject({ cxn_ref: 'CXN-EXE-03', permit_no: null, valid_until: null, responsible_membership: null });
      expect(reply.json).toMatchObject({ id: DOSSIER, project_code: 'PRJ-R-001', required_count: 2 });
    });

    it('answers 404 for a dossier of another tenant, one outside the scope of the grant, and one that does not exist, alike (AC-ST-PMT-002-2, UAT-AC374)', async () => {
      const foreign = await get(`/resources/permit_dossier/${FOREIGN_DOSSIER}`, { member: TENANT_READER });
      const outside = await get(`/resources/permit_dossier/${DOSSIER_BRANCH}`, { member: READER });
      const absent = await get(`/resources/permit_dossier/${id(FAMILY, 99)}`, { member: READER });
      expect([foreign.status, outside.status, absent.status]).toEqual([404, 404, 404]);
      expect([foreign.json.code, outside.json.code, absent.json.code]).toEqual(['RESOURCE_NOT_FOUND', 'RESOURCE_NOT_FOUND', 'RESOURCE_NOT_FOUND']);
      expect((await get('/resources/permit_dossier/not-an-id', { member: READER })).status).toBe(422);
    });
  });

  describe('get_resources_permit_id', () => {
    it('reads one permit with the milestones in the order they were recorded (PMT-02)', async () => {
      const reply = await get(`/resources/permit/${ISSUED}`, { member: READER });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({
        id: ISSUED,
        dossier_id: DOSSIER,
        project_id: PROJECT,
        project_code: 'PRJ-R-001',
        project_name: 'Name of PRJ-R-001',
        status: 'ISSUED',
        permit_no: 'GP-READ-1',
        document_version_id: DOCUMENT,
        exemption_basis: null,
        revoke_reason: null,
        revocation_document_version_id: null,
        permit_type_revision: 1,
      });
      const milestones = reply.json.milestones as Array<Record<string, unknown>>;
      expect(milestones.map((step) => step.step_code)).toEqual(['SUBMITTED', 'ACKNOWLEDGED', 'DECISION']);
      expect(milestones[0]).toMatchObject({ planned_on: null, actual_on: inDays(-40), note: 'Filed at the one-stop office', document_version_id: null });
      expect(milestones[2]).toMatchObject({ document_version_id: DOCUMENT });
      expect(typeof milestones[0]?.created_at).toBe('string');
      expect(Object.keys(milestones[0] ?? {}).sort()).toEqual(['actual_on', 'created_at', 'document_version_id', 'id', 'note', 'planned_on', 'step_code']);
    });

    it('answers 404 for a permit of another tenant, one outside the scope of the grant, and one that does not exist; and 403 without permit.read (AC-ST-PMT-002-2)', async () => {
      expect((await get(`/resources/permit/${FOREIGN_PERMIT}`, { member: TENANT_READER })).status).toBe(404);
      expect((await get(`/resources/permit/${ISSUED}`, { member: OTHER_BRANCH_READER })).status).toBe(404);
      expect((await get(`/resources/permit/${id(FAMILY, 98)}`, { member: READER })).json.code).toBe('RESOURCE_NOT_FOUND');
      expect((await get(`/resources/permit/${ISSUED}`, { member: MANAGER_ONLY })).status).toBe(403);
      expect((await get(`/resources/permit/${ISSUED}`, { member: OTHER_TENANT_READER, tenantId: TENANT_B })).status).toBe(404);
    });

    it('keeps the day of the read honest: the permit that ended is no longer counted as valid on the dossier line', async () => {
      await harness.owner(TENANT_A, [[`update machvon.permit set status = 'EXPIRED' where id = $1::uuid`, [ISSUED]]]);
      const reply = await get('/resources/permit_dossier', { member: READER });
      expect((reply.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ issued_count: 0, expiring_count: 0, satisfied_count: 0 });
    });
  });
});
