import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, vietnamDateOf } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { PermitDossierController } from '../../src/modules/pmt/permit-dossier.controller';
import { PermitGateController } from '../../src/modules/pmt/gate.controller';
import { PermitGateWaiverController } from '../../src/modules/pmt/gate-waiver.controller';
import { AuthzHarness, TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { assertStatus, callerOf, expectCheckFails } from '../uat/uat-kit';
import type { Reply } from '../uat/uat-kit';

jest.setTimeout(480_000);

/**
 * The permit gates of the design cases of PMT (docs/uat/pmt): the evaluation of the gate START_CONSTRUCTION over a permit that is missing, issued, expired and exempted
 * (UAT-AC368), and the waiver of a gate (UAT-AC373). The gate answers with its status and, for each rule it judged, the permit type, the outcome, the revision of the rule and
 * the legal basis; the list of the permits that block is the rules whose outcome is BLOCKING.
 */
const SIGNING_KEY = randomBytes(32);
const OFFICER = 1; // u.cv.hd: draws the dossier and the decision documents up (permit.manage, permit.record, permit.read) and also holds permit.gate.waive
const LEADER = 2; // u.lanhdao: permit.gate.waive, permit.exempt, permit.read
const GATE_ADMIN = 3; // permit.gate.manage on the whole tenant
const FAMILY = 0x9b;
const DAY_MS = 86_400_000;
const TODAY = vietnamDateOf(new Date());
const inDays = (days: number): string => vietnamDateOf(new Date(Date.now() + days * DAY_MS));
const BASIS = 'Luật Xây dựng 135/2025 [CXN-EXE-02]';
const EXEMPTION_BASIS = 'Exempt from a construction permit under article 89 of the Construction Law';
const REASON = 'The authority allowed the work to begin while the permit is being finished';

const TYPE_GPXD = id(FAMILY, 31);
const DOCUMENT_ROW = id(FAMILY, 41);
const DOCUMENT = id(FAMILY, 42);

describe('the permit gates over HTTP, cases of PMT', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let projects = 0;
  const call = callerOf(() => app.baseUrl, SIGNING_KEY);

  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const versionOf = (reply: Reply): number => reply.json.resource_version as number;

  /** A project of the department (unit 2) of its own, so that every case owns its dossier and its waivers. */
  async function freshProject(): Promise<string> {
    projects += 1;
    const projectId = id(FAMILY, 100 + projects);
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      await admin.query(
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $4, $5, $6, $7, 'INTERNAL', 1000000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, `PRJ-A-00${projects}`, `Project ${projects}`, unitId(2), unitId(1), id(FAMILY, 90)],
      );
    } finally {
      await admin.end();
    }
    return projectId;
  }

  /** A decision document version drawn up by `creator`. */
  async function decision(creator: number): Promise<string> {
    const documentId = randomUUID();
    const versionId = randomUUID();
    await rows(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Decision', 'INTERNAL', $3, $3)`, [TENANT_A, documentId, memberId(creator)]);
    await rows(
      `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
       values ($1, $2, $3, 1, $4, repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
      [TENANT_A, versionId, documentId, `tenants/pmt/${versionId}.pdf`],
    );
    return versionId;
  }

  const gateOf = async (project: string, asOf?: string): Promise<{ status: string; rules: Array<Record<string, unknown>>; asOf: unknown }> => {
    const reply = await call('GET', `/projects/${project}/permit-gates?gate_code=START_CONSTRUCTION${asOf === undefined ? '' : `&as_of=${asOf}`}`, { member: LEADER });
    assertStatus(reply, 200);
    const [gate] = reply.json.gates as Array<{ status: string; rules: Array<Record<string, unknown>> }>;
    if (gate === undefined) throw new Error('the answer holds no gate');
    return { status: gate.status, rules: gate.rules, asOf: reply.json.as_of };
  };
  /** The permits that hold a gate shut: the types of the rules that judged BLOCKING. */
  const blockingPermits = (rules: Array<Record<string, unknown>>): unknown[] => rules.filter((rule) => rule.outcome === 'BLOCKING').map((rule) => rule.permit_type_code);

  async function openDossier(project: string): Promise<{ dossier: string; permit: string }> {
    const opened = await call('POST', `/projects/${project}/permit-dossiers`, { member: OFFICER, body: { owner_unit_id: unitId(2) } });
    assertStatus(opened, 200);
    const [permit] = await rows<{ id: string }>('select id from machvon.permit where dossier_id = $1::uuid and permit_type_code = $2', [idOf(opened), 'GPXD']);
    if (permit === undefined) throw new Error('the dossier holds no GPXD permit');
    return { dossier: idOf(opened), permit: permit.id };
  }

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: 1, path: '/u1/' },
      { n: 2, path: '/u1/u2/', parent: 1 },
    ]);
    for (const n of [OFFICER, LEADER, GATE_ADMIN]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedRole(TENANT_A, 1, 'PROJECT_LEGAL', ['permit.manage', 'permit.record', 'permit.read', 'permit.gate.waive'], 40);
    await harness.seedRole(TENANT_A, 2, 'PERMIT_LEADER', ['permit.gate.waive', 'permit.exempt', 'permit.read'], 50);
    await harness.seedRole(TENANT_A, 3, 'GATE_MANAGER', ['permit.gate.manage', 'permit.read'], 40);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: OFFICER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 2, member: LEADER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 3, member: GATE_ADMIN, role: 3, kind: 'TENANT' },
    ]);
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      await admin.query(
        `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, default_validity_months, exemption_allowed, status, created_by, updated_by)
         values ($1, $2, 'GPXD', 'Construction permit', 'OTHER', 'The authority', $3, date '2025-01-01', '{}'::jsonb, 12, true, 'PUBLISHED', $4, $4)`,
        [TENANT_A, TYPE_GPXD, BASIS, memberId(OFFICER)],
      );
      await admin.query(
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'GP', 'Permit scan', 'INTERNAL', $3, $3)`,
        [TENANT_A, DOCUMENT_ROW, memberId(OFFICER)],
      );
      await admin.query(
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/pmt/gp.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, DOCUMENT, DOCUMENT_ROW],
      );
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
      controllers: [PermitDossierController, PermitGateController, PermitGateWaiverController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
    // The rule GR-1 of the case: the gate START_CONSTRUCTION asks for a valid GPXD or an exemption, from 2026-01-01, on a legal basis that is still to be confirmed.
    const published = await call('POST', '/permit-gate-rules', {
      member: GATE_ADMIN,
      body: {
        gate_code: 'START_CONSTRUCTION',
        project_milestone_code: 'START_CONSTRUCTION',
        permit_type_id: TYPE_GPXD,
        requirement: 'VALID_OR_EXEMPT',
        applies_to_rule: {},
        legal_basis: BASIS,
        effective_from: '2026-01-01',
      },
    });
    assertStatus(published, 200);
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('the checks of this suite go red on a wrong answer (negative control)', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 422, 'WAIVER_TOO_LONG'));
    expectCheckFails(() => assertStatus({ status: 422, json: { code: 'VALIDATION_FAILED' } }, 422, 'WAIVER_TOO_LONG'));
  });

  it('UAT-AC368: the gate START_CONSTRUCTION is BLOCKED by the missing GPXD, PASSED with the permit, BLOCKED again once it expired, and PASSED for an exempted project, always with the revision and the legal basis of the rule', async () => {
    const project = await freshProject();
    const { permit } = await openDossier(project);
    const auditsBefore = await rows('select 1 from machvon.audit_event');

    // Step 1: no permit yet.
    const blocked = await gateOf(project, inDays(-30));
    expect(blocked.status).toBe('BLOCKED');
    expect(blockingPermits(blocked.rules)).toEqual(['GPXD']);
    expect(blocked.rules[0]).toMatchObject({ outcome: 'BLOCKING', permit: null, waiver: null, requirement: 'VALID_OR_EXEMPT', revision: 1, legal_basis: BASIS, effective_from: '2026-01-01', effective_until: null });
    expect((await gateOf(project)).status).toBe('BLOCKED');

    // Step 2: the permit is issued, valid until a day ahead.
    const submitted = await call('POST', `/permits/${permit}/milestones`, { member: OFFICER, ifMatch: 1, body: { step_code: 'SUBMITTED', actual_on: TODAY } });
    assertStatus(submitted, 200);
    const acknowledged = await call('POST', `/permits/${permit}/milestones`, { member: OFFICER, ifMatch: versionOf(submitted), body: { step_code: 'ACKNOWLEDGED', actual_on: TODAY } });
    assertStatus(acknowledged, 200);
    const issued = await call('POST', `/permits/${permit}/decision`, {
      member: OFFICER,
      ifMatch: versionOf(acknowledged),
      body: { outcome: 'ISSUED', permit_no: 'GP-0001', issued_on: TODAY, valid_from: TODAY, valid_until: inDays(30), document_version_id: DOCUMENT },
    });
    assertStatus(issued, 200);
    const passed = await gateOf(project, TODAY);
    expect(passed.status).toBe('PASSED');
    expect(blockingPermits(passed.rules)).toEqual([]);
    expect(passed.rules[0]).toMatchObject({ outcome: 'SATISFIED', permit: { permit_no: 'GP-0001', status: 'ISSUED', valid_until: inDays(30) }, revision: 1, legal_basis: BASIS });

    // Step 3: the day after the permit ended.
    const expired = await gateOf(project, inDays(31));
    expect(expired.status).toBe('BLOCKED');
    expect(blockingPermits(expired.rules)).toEqual(['GPXD']);
    expect(expired.rules[0]).toMatchObject({ outcome: 'BLOCKING', permit: null, revision: 1, legal_basis: BASIS });

    // Step 4: another project, whose permit is exempted by someone other than its proposer, on a basis and a decision.
    const other = await freshProject();
    const exemptable = await openDossier(other);
    expect((await gateOf(other)).status).toBe('BLOCKED');
    const exempted = await call('POST', `/permits/${exemptable.permit}/exempt`, { member: LEADER, ifMatch: 1, body: { exemption_basis: EXEMPTION_BASIS, exemption_decision_document_version_id: DOCUMENT } });
    assertStatus(exempted, 200);
    const exemptedGate = await gateOf(other);
    expect(exemptedGate.status).toBe('PASSED');
    expect(exemptedGate.rules[0]).toMatchObject({ outcome: 'SATISFIED', permit: { id: exemptable.permit, status: 'EXEMPTED' }, revision: 1, legal_basis: BASIS });
    expect((await rows<{ status: string; exemption_basis: string }>('select status, exemption_basis from machvon.permit where id = $1::uuid', [exemptable.permit]))[0]).toEqual({ status: 'EXEMPTED', exemption_basis: EXEMPTION_BASIS });

    // Reading the gate writes nothing: the audit rows of the whole run are the ones of the commands above (two milestones, one decision, one exemption, two dossiers).
    expect((await rows('select 1 from machvon.audit_event')).length - auditsBefore.length).toBe(5);
  });

  it('UAT-AC373: a waiver of 120 days is 422 WAIVER_TOO_LONG, the proposer approving it is refused by permit_gate_waiver_maker_chk, 60 days from the leader passes the gate with the waiver and its end, and revoking blocks it again', async () => {
    const project = await freshProject();
    const waivers = async (): Promise<number> => (await rows('select 1 from machvon.permit_gate_waiver where project_id = $1::uuid', [project])).length;
    const grant = async (creator: number, days: number, member: number): Promise<Reply> =>
      call('POST', '/permit-gate-waivers', {
        member,
        body: { project_id: project, gate_code: 'START_CONSTRUCTION', permit_type_id: TYPE_GPXD, reason: REASON, decision_document_version_id: await decision(creator), valid_until: inDays(days) },
      });
    expect((await gateOf(project)).status).toBe('BLOCKED');

    // Step 1: 120 days is above the longest a waiver may run.
    const tooLong = await grant(OFFICER, 120, LEADER);
    expect([tooLong.status, tooLong.json.code]).toEqual([422, 'WAIVER_TOO_LONG']);
    expect(tooLong.json).toMatchObject({ max_days: 90, requested_days: 121, latest_day: inDays(89) });
    expect(await waivers()).toBe(0);

    // Step 2: the one who drew the decision up does not approve it.
    const own = await grant(OFFICER, 60, OFFICER);
    expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
    expect(await waivers()).toBe(0);
    const direct = await rows<{ id: string }>('select id from machvon.permit_gate_waiver limit 1');
    expect(direct).toEqual([]);
    const admin = new Client({ connectionString: harness.database.adminUrl });
    await admin.connect();
    try {
      await admin.query('set session_replication_role = replica');
      await expect(
        admin.query(
          `insert into machvon.permit_gate_waiver (tenant_id, id, project_id, gate_code, permit_type_id, reason, decision_document_version_id, valid_until, approved_by, status, created_by, updated_by, version)
           values ($1, gen_random_uuid(), $2, 'START_CONSTRUCTION', $3, $4, $5, $6::date, $7, 'ACTIVE', $7, $7, 1)`,
          [TENANT_A, project, TYPE_GPXD, REASON, DOCUMENT, inDays(60), memberId(OFFICER)],
        ),
      ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('permit_gate_waiver_maker_chk') });
    } finally {
      await admin.end();
    }
    expect(await waivers()).toBe(0);

    // Step 3: the leader approves 60 days; the gate passes with the waiver, its id and its end.
    const granted = await grant(OFFICER, 60, LEADER);
    assertStatus(granted, 200);
    expect(granted.json).toMatchObject({ status: 'ACTIVE' });
    const waiverId = idOf(granted);
    const waived = await gateOf(project);
    expect(waived.status).toBe('PASSED_WITH_WAIVER');
    expect(waived.rules[0]).toMatchObject({ outcome: 'WAIVED', permit: null, waiver: { id: waiverId, valid_until: inDays(60) }, revision: 1, legal_basis: BASIS });
    expect(await rows('select status, approved_by, created_by from machvon.permit_gate_waiver where id = $1::uuid', [waiverId])).toEqual([{ status: 'ACTIVE', approved_by: memberId(LEADER), created_by: memberId(OFFICER) }]);

    // Step 4: revoked, the gate is blocked at once.
    const revoked = await call('POST', `/permit-gate-waivers/${waiverId}/revoke`, { member: LEADER, body: { reason: 'The permit was issued' } });
    assertStatus(revoked, 200);
    expect(revoked.json).toMatchObject({ status: 'REVOKED' });
    const blocked = await gateOf(project);
    expect(blocked.status).toBe('BLOCKED');
    expect(blockingPermits(blocked.rules)).toEqual(['GPXD']);
    expect(await rows('select status from machvon.permit_gate_waiver where id = $1::uuid', [waiverId])).toEqual([{ status: 'REVOKED' }]);
    expect(await waivers()).toBe(1);
  });
});
