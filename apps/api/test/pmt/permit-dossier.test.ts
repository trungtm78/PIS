import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { PermitDossierController } from '../../src/modules/pmt/permit-dossier.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
// Members of tenant A. Roles: 1 = the project legal officer (manage, record, read), 2 = a manager who cannot record, 3 = a reader.
const OFFICER = 1; // all three permissions on the subtree of the department (unit 2)
const MANAGER_ONLY = 2; // permit.manage and permit.read on the whole tenant
const READER = 3; // permit.read only
const NOBODY = 4;
const OTHER_BRANCH_OFFICER = 5; // all three permissions on another branch (unit 3)
const PROJECT_OFFICER = 6; // all three permissions on one project only
const OTHER_TENANT_OFFICER = 1; // of tenant B
const DAY_MS = 86_400_000;
const FAMILY = 0x94;
const DOCUMENT = id(FAMILY, 31);
const SECOND_DOCUMENT = id(FAMILY, 32);
const DOCUMENT_ROW = id(FAMILY, 34);
const GRANTED_PROJECT = id(FAMILY, 80);
const FOREIGN_PROJECT = id(FAMILY, 90);
const FOREIGN_DOSSIER = id(FAMILY, 91);
const FOREIGN_PERMIT = id(FAMILY, 92);
const TODAY = vietnamDateOf(new Date());
const inDays = (days: number): string => vietnamDateOf(new Date(Date.now() + days * DAY_MS));

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('permit dossier commands (ST-PMT-002)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let projects = 0;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function post(url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = {
      [TENANT_HEADER]: tokenOf(options.member, options.tenantId),
      'content-type': 'application/json',
      'idempotency-key': options.key ?? `key-${randomUUID()}`,
    };
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method: 'POST', headers, body: JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const versionOf = (reply: Reply): string => `"${reply.json.resource_version as number}"`;
  const freshNo = (): string => {
    counter += 1;
    return `API-GP-${String(counter).padStart(4, '0')}`;
  };

  /** A project of unit 2 (invested by unit 1) of its own, so that each test owns its dossier. */
  async function freshProject(options: { unit?: number; group?: string; tenant?: string } = {}): Promise<string> {
    projects += 1;
    const projectId = id(FAMILY, 100 + projects);
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      await admin.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $4, $5, $6, $7, 'INTERNAL', 1000000, 'IMPLEMENTATION', 1, $8)`,
        [options.tenant ?? TENANT_A, projectId, `PRJ-API-${projects}`, `API project ${projects}`, unitId(options.unit ?? 2), unitId(1), id(FAMILY, 42), options.group ?? 'B'],
      );
    } finally {
      await admin.end();
    }
    return projectId;
  }

  const openDossier = (member: number, projectId: string, body: Record<string, unknown> = {}, tenantId?: string): Promise<Reply> =>
    post(`/projects/${projectId}/permit-dossiers`, { member, body: { owner_unit_id: unitId(2), ...body }, ...(tenantId === undefined ? {} : { tenantId }) });
  const permitsOf = (dossierId: string) =>
    rows<{ id: string; permit_type_code: string; status: string; version: string; is_required: boolean }>(
      'select id, permit_type_code, status, version::text as version, is_required from machvon.permit where dossier_id = $1::uuid order by permit_type_code',
      [dossierId],
    );
  const permitIn = async (dossierId: string, code: string) => {
    const permit = (await permitsOf(dossierId)).find((candidate) => candidate.permit_type_code === code);
    if (permit === undefined) throw new Error(`no ${code} permit`);
    return permit;
  };
  const milestone = (member: number, permitId: string, version: number | string, body: Record<string, unknown>): Promise<Reply> =>
    post(`/permits/${permitId}/milestones`, { member, body, ifMatch: typeof version === 'number' ? `"${version}"` : version });
  const decide = (member: number, permitId: string, version: number | string, body: Record<string, unknown>): Promise<Reply> =>
    post(`/permits/${permitId}/decision`, { member, body, ifMatch: typeof version === 'number' ? `"${version}"` : version });
  const issueTerms = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    outcome: 'ISSUED',
    permit_no: freshNo(),
    issued_on: TODAY,
    valid_from: TODAY,
    valid_until: inDays(365),
    document_version_id: DOCUMENT,
    ...extra,
  });

  /** Walks a PLANNED permit to IN_APPRAISAL through the milestones of the API; returns its version. */
  async function toAppraisal(permitId: string): Promise<number> {
    const submitted = await milestone(OFFICER, permitId, 1, { step_code: 'SUBMITTED', actual_on: TODAY });
    expect(submitted.status).toBe(200);
    const acknowledged = await milestone(OFFICER, permitId, versionOf(submitted), { step_code: 'ACKNOWLEDGED', actual_on: TODAY });
    expect(acknowledged.status).toBe(200);
    return acknowledged.json.resource_version as number;
  }

  async function issueFresh(): Promise<{ dossier: string; permit: string; version: number; project: string }> {
    const project = await freshProject();
    const opened = await openDossier(OFFICER, project);
    const dossier = idOf(opened);
    const permit = (await permitIn(dossier, 'API_EVERY')).id;
    const issued = await decide(OFFICER, permit, await toAppraisal(permit), issueTerms());
    expect(issued.status).toBe(200);
    return { dossier, permit, version: issued.json.resource_version as number, project };
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
    for (const n of [OFFICER, MANAGER_ONLY, READER, NOBODY, OTHER_BRANCH_OFFICER, PROJECT_OFFICER]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_OFFICER, 1);
    const all = ['permit.manage', 'permit.record', 'permit.read'];
    await harness.seedRole(TENANT_A, 1, 'PROJECT_LEGAL', all, 40);
    await harness.seedRole(TENANT_A, 2, 'PERMIT_MANAGER', ['permit.manage', 'permit.read'], 30);
    await harness.seedRole(TENANT_A, 3, 'PERMIT_READER', ['permit.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'PROJECT_LEGAL', all, 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: OFFICER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 2, member: MANAGER_ONLY, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: OTHER_BRANCH_OFFICER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(3)] },
      { n: 5, member: PROJECT_OFFICER, role: 1, kind: 'PROJECT', refs: [GRANTED_PROJECT] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_OFFICER, role: 1, kind: 'TENANT' }]);
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      for (const tenant of [TENANT_A, TENANT_B]) {
        await admin.query(
          `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by)
           values ($1, $2, 'REFERENCE', 'GP', 'Permit scan', 'INTERNAL', $3, $3)`,
          [tenant, DOCUMENT_ROW, memberId(OFFICER)],
        );
        await admin.query(
          `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
           values ($1, $2, $4, 1, 'tenants/pmt/a.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                  ($1, $3, $4, 2, 'tenants/pmt/b.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
          [tenant, DOCUMENT, SECOND_DOCUMENT, DOCUMENT_ROW],
        );
        // The permit types in force: one that every project needs, one that only a project of group C needs (added by hand to the others).
        for (const [typeId, code, rule, months] of [
          [id(FAMILY, 51), 'API_EVERY', {}, 12],
          [id(FAMILY, 52), 'API_OPTIONAL', { project_group_keys: ['C'] }, 6],
        ] as const) {
          await admin.query(
            `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, default_validity_months, exemption_allowed, status, created_by, updated_by)
             values ($1, $2, $3, $3, 'OTHER', 'The authority', 'API fixture legal basis', date '2026-01-01', $4::jsonb, $5, false, 'PUBLISHED', $6, $6)`,
            [tenant, typeId, code, JSON.stringify(rule), months, memberId(OFFICER)],
          );
        }
      }
      // A project of the other branch that only the officer with a grant on that project reaches.
      await admin.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-GRANTED', 'Project of the project officer', $3, $3, $4, 'INTERNAL', 1000000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, GRANTED_PROJECT, unitId(3), id(FAMILY, 42)],
      );
      // Something of tenant B that tenant A's officer names by id.
      await admin.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-FOREIGN', 'Foreign project', $3, $4, 'INTERNAL', 1, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_B, FOREIGN_PROJECT, unitId(2), id(FAMILY, 42)],
      );
      await admin.query('insert into machvon.permit_dossier (tenant_id, id, project_id, owner_unit_id, created_by, updated_by) values ($1, $2, $3, $4, $5, $5)', [
        TENANT_B,
        FOREIGN_DOSSIER,
        FOREIGN_PROJECT,
        unitId(2),
        memberId(OTHER_TENANT_OFFICER),
      ]);
      await admin.query("insert into machvon.permit (tenant_id, id, dossier_id, permit_type_id, status, created_by, updated_by) values ($1, $2, $3, $4, 'IN_APPRAISAL', $5, $5)", [
        TENANT_B,
        FOREIGN_PERMIT,
        FOREIGN_DOSSIER,
        id(FAMILY, 51),
        memberId(OTHER_TENANT_OFFICER),
      ]);
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
      controllers: [PermitDossierController],
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

  describe('createPermitDossier', () => {
    it('opens the dossier with the permits the rules of the day require, audited and announced in the same transaction (UC-PMT-01)', async () => {
      const project = await freshProject();
      const reply = await openDossier(OFFICER, project, { owner_membership_id: memberId(MANAGER_ONLY) });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ status: 'OPEN', resource_version: 1 });
      const dossier = idOf(reply);
      expect(await rows('select project_id, owner_unit_id, owner_membership_id, status, readiness_pct::text as readiness_pct, created_by from machvon.permit_dossier where id = $1::uuid', [dossier])).toEqual([
        { project_id: project, owner_unit_id: unitId(2), owner_membership_id: memberId(MANAGER_ONLY), status: 'OPEN', readiness_pct: '0.00', created_by: memberId(OFFICER) },
      ]);
      expect(await permitsOf(dossier)).toEqual([expect.objectContaining({ permit_type_code: 'API_EVERY', status: 'PLANNED', is_required: true, version: '1' })]);
      const audit = await rows<{ action: string; safe_diff: { planned: Array<{ permit_type_code: string }> } }>(
        "select action, safe_diff from machvon.audit_event where resource_id = $1::uuid and action = 'pmt.dossier_opened'",
        [dossier],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.safe_diff.planned.map((permit) => permit.permit_type_code)).toEqual(['API_EVERY']);
      expect(await rows('select type from machvon.outbox_event where aggregate_id = $1::uuid and type = $2', [dossier, 'pmt.dossier.opened.v1'])).toHaveLength(1);
      expect(await rows('select type from machvon.outbox_event where type = $1 and payload->>$2 = $3', ['pmt.permit.planned.v1', 'dossier_id', dossier])).toHaveLength(1);
    });

    it('refuses a second dossier of the project with 409 DOSSIER_EXISTS, answers a retry with the first answer, and writes once', async () => {
      const project = await freshProject();
      const key = `key-${randomUUID()}`;
      const first = await post(`/projects/${project}/permit-dossiers`, { member: OFFICER, body: { owner_unit_id: unitId(2) }, key });
      const retry = await post(`/projects/${project}/permit-dossiers`, { member: OFFICER, body: { owner_unit_id: unitId(2) }, key });
      expect([first.status, retry.status, retry.json.resource_id]).toEqual([200, 200, idOf(first)]);
      const second = await openDossier(OFFICER, project);
      expect([second.status, second.json.code]).toEqual([409, 'DOSSIER_EXISTS']);
      expect(await rows('select id from machvon.permit_dossier where project_id = $1::uuid', [project])).toHaveLength(1);
    });

    it('refuses what the contract does not allow and what the rules do not allow, naming the field', async () => {
      const project = await freshProject();
      const unknown = await openDossier(OFFICER, project, { status: 'COMPLETE' });
      expect([unknown.status, unknown.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      const missing = await post(`/projects/${project}/permit-dossiers`, { member: OFFICER, body: {} });
      expect([missing.status, missing.json.code]).toEqual([400, 'INVALID_REQUEST']);
      const badUnit = await openDossier(OFFICER, project, { owner_unit_id: randomUUID() });
      expect([badUnit.status, badUnit.json.code, badUnit.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'owner_unit_id']);
      const badComponent = await openDossier(OFFICER, project, { project_component_id: randomUUID() });
      expect([badComponent.status, badComponent.json.code, badComponent.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'project_component_id']);
      expect(await rows('select id from machvon.permit_dossier where project_id = $1::uuid', [project])).toEqual([]);
    });

    it('is permitted by the permission within its scope only: a reader and a stranger are refused, a grant on another branch is SCOPE_DENIED, a grant on the project itself opens that project and no other', async () => {
      const project = await freshProject();
      expect((await openDossier(READER, project)).status).toBe(403);
      expect((await openDossier(NOBODY, project)).status).toBe(403);
      const elsewhere = await openDossier(OTHER_BRANCH_OFFICER, project);
      expect([elsewhere.status, elsewhere.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const projectOnly = await openDossier(PROJECT_OFFICER, project);
      expect([projectOnly.status, projectOnly.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await rows('select id from machvon.permit_dossier where project_id = $1::uuid', [project])).toEqual([]);
      const granted = await openDossier(PROJECT_OFFICER, GRANTED_PROJECT);
      expect([granted.status, granted.json.status]).toEqual([200, 'OPEN']);
      const manager = await openDossier(MANAGER_ONLY, project);
      expect(manager.status).toBe(200);
    });

    it('does not open a dossier on the project of another tenant: 404 and no dossier (AC-ST-PMT-002-2)', async () => {
      const reply = await openDossier(OFFICER, FOREIGN_PROJECT);
      expect([reply.status, reply.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect(await rows('select id from machvon.permit_dossier where project_id = $1::uuid', [FOREIGN_PROJECT], TENANT_B)).toHaveLength(1);
      expect(await rows('select id from machvon.permit_dossier where project_id = $1::uuid', [FOREIGN_PROJECT])).toEqual([]);
    });
  });

  describe('addPermit', () => {
    it('adds an optional permit written under the type version in force, and refuses a second of the type (UAT-AC375, AC-ST-PMT-002-1)', async () => {
      const dossier = idOf(await openDossier(OFFICER, await freshProject()));
      const added = await post(`/permit-dossiers/${dossier}/permits`, { member: OFFICER, body: { permit_type_id: id(FAMILY, 52), authority_name: 'Department of Construction', expected_decision_on: inDays(60) } });
      expect(added.status).toBe(200);
      expect(added.json).toMatchObject({ status: 'PLANNED', resource_version: 1 });
      expect(await rows('select permit_type_id, permit_type_code, is_required, authority_name from machvon.permit where id = $1::uuid', [idOf(added)])).toEqual([
        { permit_type_id: id(FAMILY, 52), permit_type_code: 'API_OPTIONAL', is_required: false, authority_name: 'Department of Construction' },
      ]);
      expect(await rows("select id from machvon.audit_event where resource_id = $1::uuid and action = 'pmt.permit_planned'", [idOf(added)])).toHaveLength(1);
      expect(await rows("select id from machvon.outbox_event where aggregate_id = $1::uuid and type = 'pmt.permit.planned.v1'", [idOf(added)])).toHaveLength(1);
      const again = await post(`/permit-dossiers/${dossier}/permits`, { member: OFFICER, body: { permit_type_id: id(FAMILY, 52) } });
      expect([again.status, again.json.code]).toEqual([409, 'PERMIT_ALREADY_CURRENT']);
      const required = await post(`/permit-dossiers/${dossier}/permits`, { member: OFFICER, body: { permit_type_id: id(FAMILY, 51) } });
      expect([required.status, required.json.code]).toEqual([409, 'PERMIT_ALREADY_CURRENT']);
    });

    it('refuses a type that is not of the tenant (422 naming the field), one that does not apply today, a stranger and another tenant', async () => {
      const dossier = idOf(await openDossier(OFFICER, await freshProject()));
      const unknown = await post(`/permit-dossiers/${dossier}/permits`, { member: OFFICER, body: { permit_type_id: randomUUID() } });
      expect([unknown.status, unknown.json.code, unknown.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'permit_type_id']);
      const future = id(FAMILY, 53);
      await rows(
        `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, status, created_by, updated_by)
         values ($1, $2, 'API_FUTURE', 'API_FUTURE', 'OTHER', 'The authority', 'API fixture legal basis', $3::date, '{}'::jsonb, 'PUBLISHED', $4, $4) returning id`,
        [TENANT_A, future, inDays(100), memberId(OFFICER)],
      );
      const notYet = await post(`/permit-dossiers/${dossier}/permits`, { member: OFFICER, body: { permit_type_id: future } });
      expect([notYet.status, notYet.json.code]).toEqual([422, 'PERMIT_TYPE_NOT_EFFECTIVE']);
      expect((await post(`/permit-dossiers/${dossier}/permits`, { member: READER, body: { permit_type_id: id(FAMILY, 52) } })).status).toBe(403);
      const elsewhere = await post(`/permit-dossiers/${dossier}/permits`, { member: OTHER_BRANCH_OFFICER, body: { permit_type_id: id(FAMILY, 52) } });
      expect([elsewhere.status, elsewhere.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect(await rows('select id from machvon.permit where dossier_id = $1::uuid', [dossier])).toHaveLength(1);
    });

    it('does not reach the dossier of another tenant: 404 for the id of the other tenant and for one that does not exist, and no permit is created there (AC-ST-PMT-002-2, UAT-AC374)', async () => {
      const foreign = await post(`/permit-dossiers/${FOREIGN_DOSSIER}/permits`, { member: OFFICER, body: { permit_type_id: id(FAMILY, 52) } });
      const absent = await post(`/permit-dossiers/${randomUUID()}/permits`, { member: OFFICER, body: { permit_type_id: id(FAMILY, 52) } });
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect([absent.status, absent.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      // The other tenant's dossier is told apart from a dossier that does not exist by nothing in the answer.
      const shape = (reply: Reply) => ({ status: reply.status, code: reply.json.code, title: reply.json.title, type: reply.json.type, detail: reply.json.detail });
      expect(shape(foreign)).toEqual(shape(absent));
      expect(await rows('select id from machvon.permit where dossier_id = $1::uuid', [FOREIGN_DOSSIER], TENANT_B)).toHaveLength(1);
    });
  });

  describe('the milestones and the decision', () => {
    it('moves a permit along its milestones with If-Match and records them as a record, without the note in the audit trail (UC-PMT-01)', async () => {
      const dossier = idOf(await openDossier(OFFICER, await freshProject()));
      const permit = (await permitIn(dossier, 'API_EVERY')).id;
      const submitted = await milestone(OFFICER, permit, 1, { step_code: 'SUBMITTED', actual_on: TODAY, note: 'Filed by Nguyen Van A at the office', document_version_id: DOCUMENT });
      expect(submitted.status).toBe(200);
      expect(submitted.json).toMatchObject({ status: 'SUBMITTED', resource_version: 2, resource_id: permit });
      expect(await rows('select status, submitted_on::text as submitted_on, version::text as version from machvon.permit where id = $1::uuid', [permit])).toEqual([{ status: 'SUBMITTED', submitted_on: TODAY, version: '2' }]);
      const audit = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where resource_id = $1::uuid and action = 'pmt.permit_milestone_recorded'", [permit]);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.safe_diff).toMatchObject({ step_code: 'SUBMITTED', has_note: true, from_status: 'PLANNED', to_status: 'SUBMITTED' });
      expect(JSON.stringify(audit[0]?.safe_diff)).not.toContain('Nguyen');
      expect(await rows("select id from machvon.outbox_event where aggregate_id = $1::uuid and type = 'pmt.permit.milestone_recorded.v1'", [permit])).toHaveLength(1);
      const acknowledged = await milestone(OFFICER, permit, versionOf(submitted), { step_code: 'ACKNOWLEDGED', actual_on: TODAY });
      expect(acknowledged.json).toMatchObject({ status: 'IN_APPRAISAL', resource_version: 3 });
    });

    it('needs the version the caller saw: no If-Match is 428, a stale one is 409 VERSION_CONFLICT, a step the status does not allow is 409 PERMIT_STATE_INVALID', async () => {
      const dossier = idOf(await openDossier(OFFICER, await freshProject()));
      const permit = (await permitIn(dossier, 'API_EVERY')).id;
      const none = await post(`/permits/${permit}/milestones`, { member: OFFICER, body: { step_code: 'SUBMITTED', actual_on: TODAY } });
      expect(none.status).toBe(428);
      const stale = await milestone(OFFICER, permit, 5, { step_code: 'SUBMITTED', actual_on: TODAY });
      expect([stale.status, stale.json.code, stale.json.current_version]).toEqual([409, 'VERSION_CONFLICT', 1]);
      const wrongStep = await milestone(OFFICER, permit, 1, { step_code: 'ACKNOWLEDGED', actual_on: TODAY });
      expect([wrongStep.status, wrongStep.json.code]).toEqual([409, 'PERMIT_STATE_INVALID']);
      const future = await milestone(OFFICER, permit, 1, { step_code: 'SUBMITTED', actual_on: inDays(3) });
      expect([future.status, future.json.code, future.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'actual_on']);
      expect(await rows('select id from machvon.permit_milestone where permit_id = $1::uuid', [permit])).toEqual([]);
    });

    it('issues a permit with its number, days and scan; the permit keeps the type version; the issue is audited and announced (UAT-AC375, AC-ST-PMT-002-1)', async () => {
      const dossier = idOf(await openDossier(OFFICER, await freshProject()));
      const permit = (await permitIn(dossier, 'API_EVERY')).id;
      const version = await toAppraisal(permit);
      const no = freshNo();
      const issued = await decide(OFFICER, permit, version, issueTerms({ permit_no: no }));
      expect(issued.status).toBe(200);
      expect(issued.json).toMatchObject({ status: 'ISSUED', resource_version: version + 1 });
      expect(await rows('select permit_no, permit_type_id, document_version_id, valid_until::text as valid_until, no_expiry from machvon.permit where id = $1::uuid', [permit])).toEqual([
        { permit_no: no, permit_type_id: id(FAMILY, 51), document_version_id: DOCUMENT, valid_until: inDays(365), no_expiry: false },
      ]);
      expect(await rows('select readiness_pct::text as readiness_pct, status from machvon.permit_dossier where id = $1::uuid', [dossier])).toEqual([{ readiness_pct: '100.00', status: 'COMPLETE' }]);
      const audit = await rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where resource_id = $1::uuid and action = 'pmt.permit_issued'", [permit]);
      expect(audit[0]?.safe_diff).toMatchObject({ permit_no: no, permit_type_code: 'API_EVERY', permit_type_revision: 1, to_status: 'ISSUED', readiness_pct: '100.00' });
      const events = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1::uuid and type = 'pmt.permit.issued.v1'", [permit]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ permit_id: permit, permit_type_code: 'API_EVERY', status: 'ISSUED', valid_until: inDays(365), tenant_id: TENANT_A });
    });

    it('refuses an issue without its scan with 422 PERMIT_DOCUMENT_REQUIRED, and a rejection without a reason', async () => {
      const dossier = idOf(await openDossier(OFFICER, await freshProject()));
      const permit = (await permitIn(dossier, 'API_EVERY')).id;
      const version = await toAppraisal(permit);
      const terms = issueTerms();
      delete terms.document_version_id;
      const noScan = await decide(OFFICER, permit, version, terms);
      expect([noScan.status, noScan.json.code]).toEqual([422, 'PERMIT_DOCUMENT_REQUIRED']);
      const noReason = await decide(OFFICER, permit, version, { outcome: 'REJECTED' });
      expect([noReason.status, noReason.json.code, noReason.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'reason']);
      expect(await rows('select status from machvon.permit where id = $1::uuid', [permit])).toEqual([{ status: 'IN_APPRAISAL' }]);
      const rejected = await decide(OFFICER, permit, version, { outcome: 'REJECTED', reason: 'The file is incomplete' });
      expect(rejected.json).toMatchObject({ status: 'REJECTED' });
      expect(await rows("select id from machvon.outbox_event where aggregate_id = $1::uuid and type = 'pmt.permit.rejected.v1'", [permit])).toHaveLength(1);
      expect((await rows<{ action: string }>("select action from machvon.audit_event where resource_id = $1::uuid and action = 'pmt.permit_rejected'", [permit]))).toHaveLength(1);
    });

    it('refuses a number the type already uses, in the same tenant, with 409 PERMIT_NO_DUPLICATE, and allows it for another type (UAT-AC375, AC-ST-PMT-002-1)', async () => {
      const first = await issueFresh();
      const no = (await rows<{ permit_no: string }>('select permit_no from machvon.permit where id = $1::uuid', [first.permit]))[0]?.permit_no as string;
      const other = idOf(await openDossier(OFFICER, await freshProject()));
      const permit = (await permitIn(other, 'API_EVERY')).id;
      const version = await toAppraisal(permit);
      const duplicate = await decide(OFFICER, permit, version, issueTerms({ permit_no: no }));
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'PERMIT_NO_DUPLICATE']);
      const optional = await post(`/permit-dossiers/${other}/permits`, { member: OFFICER, body: { permit_type_id: id(FAMILY, 52) } });
      const optionalVersion = await toAppraisal(idOf(optional));
      const sameNumber = await decide(OFFICER, idOf(optional), optionalVersion, issueTerms({ permit_no: no }));
      expect([sameNumber.status, sameNumber.json.status]).toEqual([200, 'ISSUED']);
    });

    it('refuses a second current permit of a type in the dossier with 409 PERMIT_ALREADY_CURRENT (UAT-AC375, AC-ST-PMT-002-1)', async () => {
      const issued = await issueFresh();
      const again = await post(`/permit-dossiers/${issued.dossier}/permits`, { member: OFFICER, body: { permit_type_id: id(FAMILY, 51) } });
      expect([again.status, again.json.code]).toEqual([409, 'PERMIT_ALREADY_CURRENT']);
      expect(await rows("select id from machvon.permit where dossier_id = $1::uuid and permit_type_code = 'API_EVERY' and status = 'ISSUED'", [issued.dossier])).toHaveLength(1);
    });

    it('separates the permissions: the manager moves the milestones but cannot decide, renew or revoke; the officer of another branch cannot act on the permit', async () => {
      const dossier = idOf(await openDossier(OFFICER, await freshProject()));
      const permit = (await permitIn(dossier, 'API_EVERY')).id;
      expect((await milestone(MANAGER_ONLY, permit, 1, { step_code: 'SUBMITTED', actual_on: TODAY })).status).toBe(200);
      const version = (await permitIn(dossier, 'API_EVERY')).version;
      expect((await milestone(MANAGER_ONLY, permit, version, { step_code: 'ACKNOWLEDGED', actual_on: TODAY })).status).toBe(200);
      expect((await decide(MANAGER_ONLY, permit, 3, issueTerms())).status).toBe(403);
      expect((await post(`/permits/${permit}/renew`, { member: MANAGER_ONLY, ifMatch: '"3"', body: { new_permit_no: 'X', new_valid_until: inDays(900), document_version_id: DOCUMENT } })).status).toBe(403);
      expect((await post(`/permits/${permit}/revoke`, { member: MANAGER_ONLY, ifMatch: '"3"', body: { reason: 'x', decision_document_version_id: DOCUMENT } })).status).toBe(403);
      const elsewhere = await decide(OTHER_BRANCH_OFFICER, permit, 3, issueTerms());
      expect([elsewhere.status, elsewhere.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await milestone(READER, permit, 3, { step_code: 'APPRAISAL_MEETING', planned_on: inDays(3) })).status).toBe(403);
      expect(await rows('select status from machvon.permit where id = $1::uuid', [permit])).toEqual([{ status: 'IN_APPRAISAL' }]);
    });
  });

  describe('renewPermit and revokePermit', () => {
    it('renews an issued permit by a replacement: the old one is SUPERSEDED, there is one current permit, and the renewal is audited and announced (UAT-AC370, AC-ST-PMT-002-1)', async () => {
      const issued = await issueFresh();
      const renewed = await post(`/permits/${issued.permit}/renew`, {
        member: OFFICER,
        ifMatch: `"${issued.version}"`,
        body: { new_permit_no: 'API-RENEWED-1', new_valid_until: inDays(900), document_version_id: SECOND_DOCUMENT },
      });
      expect(renewed.status).toBe(200);
      expect(renewed.json).toMatchObject({ status: 'ISSUED', resource_version: 1 });
      expect(idOf(renewed)).not.toBe(issued.permit);
      const stored = await rows<{ id: string; status: string; permit_no: string; supersedes_id: string | null; valid_until: string }>(
        'select id, status, permit_no, supersedes_id, valid_until::text as valid_until from machvon.permit where dossier_id = $1::uuid order by created_at',
        [issued.dossier],
      );
      expect(stored).toEqual([
        expect.objectContaining({ id: issued.permit, status: 'SUPERSEDED', supersedes_id: null }),
        { id: idOf(renewed), status: 'ISSUED', permit_no: 'API-RENEWED-1', supersedes_id: issued.permit, valid_until: inDays(900) },
      ]);
      expect(await rows("select safe_diff from machvon.audit_event where resource_id = $1::uuid and action = 'pmt.permit_renewed'", [idOf(renewed)])).toEqual([
        { safe_diff: expect.objectContaining({ superseded_permit_id: issued.permit, permit_no: 'API-RENEWED-1' }) },
      ]);
      const events = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1::uuid and type = 'pmt.permit.renewed.v1'", [idOf(renewed)]);
      expect(events[0]?.payload).toMatchObject({ superseded_permit_id: issued.permit, status: 'ISSUED' });
      const again = await post(`/permits/${issued.permit}/renew`, {
        member: OFFICER,
        ifMatch: `"${issued.version + 1}"`,
        body: { new_permit_no: 'API-RENEWED-2', new_valid_until: inDays(1200), document_version_id: DOCUMENT },
      });
      expect([again.status, again.json.code]).toEqual([409, 'PERMIT_STATE_INVALID']);
    });

    it('refuses a renewal whose last day is not later, whose number is in use, or whose scan is not readable, and changes nothing', async () => {
      const issued = await issueFresh();
      const send = (body: Record<string, unknown>) => post(`/permits/${issued.permit}/renew`, { member: OFFICER, ifMatch: `"${issued.version}"`, body: { new_permit_no: freshNo(), new_valid_until: inDays(900), document_version_id: DOCUMENT, ...body } });
      const early = await send({ new_valid_until: inDays(100) });
      expect([early.status, early.json.code, early.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'new_valid_until']);
      const own = (await rows<{ permit_no: string }>('select permit_no from machvon.permit where id = $1::uuid', [issued.permit]))[0]?.permit_no as string;
      const used = await send({ new_permit_no: own });
      expect([used.status, used.json.code]).toEqual([409, 'PERMIT_NO_DUPLICATE']);
      const unknown = await send({ document_version_id: randomUUID() });
      expect([unknown.status, unknown.json.code, unknown.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'document_version_id']);
      expect(await rows('select status from machvon.permit where id = $1::uuid', [issued.permit])).toEqual([{ status: 'ISSUED' }]);
    });

    it('revokes an issued permit with its reason and the decision, and the dossier is no longer ready', async () => {
      const issued = await issueFresh();
      const revoked = await post(`/permits/${issued.permit}/revoke`, {
        member: OFFICER,
        ifMatch: `"${issued.version}"`,
        body: { reason: 'Issued by mistake', decision_document_version_id: SECOND_DOCUMENT },
      });
      expect(revoked.status).toBe(200);
      expect(revoked.json).toMatchObject({ status: 'REVOKED', resource_version: issued.version + 1 });
      expect(await rows('select status, revoke_reason, revocation_document_version_id from machvon.permit where id = $1::uuid', [issued.permit])).toEqual([
        { status: 'REVOKED', revoke_reason: 'Issued by mistake', revocation_document_version_id: SECOND_DOCUMENT },
      ]);
      expect(await rows('select readiness_pct::text as readiness_pct, status from machvon.permit_dossier where id = $1::uuid', [issued.dossier])).toEqual([{ readiness_pct: '0.00', status: 'OPEN' }]);
      expect(await rows("select id from machvon.audit_event where resource_id = $1::uuid and action = 'pmt.permit_revoked'", [issued.permit])).toHaveLength(1);
      expect(await rows("select id from machvon.outbox_event where aggregate_id = $1::uuid and type = 'pmt.permit.revoked.v1'", [issued.permit])).toHaveLength(1);
      const again = await post(`/permits/${issued.permit}/revoke`, { member: OFFICER, ifMatch: `"${issued.version + 1}"`, body: { reason: 'Again', decision_document_version_id: DOCUMENT } });
      expect([again.status, again.json.code]).toEqual([409, 'PERMIT_STATE_INVALID']);
    });
  });

  describe('tenants stay apart (AC-ST-PMT-002-2, UAT-AC374)', () => {
    it('answers 404 RESOURCE_NOT_FOUND to every command that names a dossier or a permit of another tenant, and changes nothing there', async () => {
      const send = (url: string, body: Record<string, unknown>, ifMatch?: string) => post(url, { member: OFFICER, body, ...(ifMatch === undefined ? {} : { ifMatch }) });
      const replies = [
        await openDossier(OFFICER, FOREIGN_PROJECT),
        await send(`/permit-dossiers/${FOREIGN_DOSSIER}/permits`, { permit_type_id: id(FAMILY, 52) }),
        await send(`/permits/${FOREIGN_PERMIT}/milestones`, { step_code: 'APPRAISAL_MEETING', planned_on: inDays(3) }, '"1"'),
        await send(`/permits/${FOREIGN_PERMIT}/decision`, { outcome: 'REJECTED', reason: 'foreign' }, '"1"'),
        await send(`/permits/${FOREIGN_PERMIT}/renew`, { new_permit_no: 'F-1', new_valid_until: inDays(900), document_version_id: DOCUMENT }, '"1"'),
        await send(`/permits/${FOREIGN_PERMIT}/revoke`, { reason: 'foreign', decision_document_version_id: DOCUMENT }, '"1"'),
      ];
      expect(replies.map((reply) => [reply.status, reply.json.code])).toEqual(replies.map(() => [404, 'RESOURCE_NOT_FOUND']));
      expect(await rows('select status, version::text as version from machvon.permit where id = $1::uuid', [FOREIGN_PERMIT], TENANT_B)).toEqual([{ status: 'IN_APPRAISAL', version: '1' }]);
      expect(await rows('select id from machvon.permit_milestone where permit_id = $1::uuid', [FOREIGN_PERMIT], TENANT_B)).toEqual([]);
      // Without a tenant set the tables show no row at all.
      const bare = await harness.appPool.query('select (select count(*) from machvon.permit_dossier) as dossiers, (select count(*) from machvon.permit) as permits');
      expect(bare.rows[0]).toEqual({ dossiers: '0', permits: '0' });
    });

    it('lets the officer of the other tenant act on its own dossier with the same ids of types and documents', async () => {
      const project = await freshProject({ tenant: TENANT_B });
      const opened = await openDossier(OTHER_TENANT_OFFICER, project, {}, TENANT_B);
      expect([opened.status, opened.json.status]).toEqual([200, 'OPEN']);
      expect(await rows('select permit_type_code from machvon.permit where dossier_id = $1::uuid', [idOf(opened)], TENANT_B)).toEqual([{ permit_type_code: 'API_EVERY' }]);
    });
  });
});
