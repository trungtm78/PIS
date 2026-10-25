import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { lndModule } from '../../src/modules/lnd';
import { AffectedHouseholdController, AffectedHouseholdReadsController } from '../../src/modules/lnd/household.controller';
import { LandParcelController } from '../../src/modules/lnd/parcel.controller';
import { LandParcelImportController } from '../../src/modules/lnd/parcel-import.controller';
import { LandReadsController } from '../../src/modules/lnd/read.controller';
import { LandSectionController } from '../../src/modules/lnd/section.controller';
import { LandStageProgressController } from '../../src/modules/lnd/stage-progress.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedLndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import type { LndWorld } from '../../../../packages/db/test/support/lnd-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const OFFICER = 1; // land.progress.report and land.read on the whole tenant
const CENTRE_STAFF = 2; // land.progress.report on the unit tree of the land fund centre only
const DEPARTMENT_OFFICER = 3; // the same as the officer on the unit tree of the department, which owns the project
const READER = 4; // land.read on the whole tenant
const OTHER_PROJECT_READER = 5; // land.read on the other project only
const NOBODY = 6;
const B_OFFICER = 1; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const CENTRE = 3;
const FAMILY = 0xb6;
const FAMILY_B = 0xb7;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the progress of land clearance by stage, tracked from outside (ST-LND-010)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let world: LndWorld;
  let worldB: LndWorld;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; outcome: string; actor_id: string }>('select safe_diff, outcome, actor_id from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown>; aggregate_version: string }>('select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2 order by aggregate_version', [aggregateId, type]);

  /** A section of the project made straight in the table: the stage is unique by section, so each test takes its own. */
  const makeSection = async (projectId = world.project, tenant = TENANT_A, owner = OFFICER): Promise<string> => {
    counter += 1;
    const sectionId = randomUUID();
    await rows(
      `insert into machvon.land_handover_section (tenant_id, id, project_id, code, name, required_area_m2, status, version, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, 'Km 0 to km 3', 30000, 'NOT_READY', 1, $4::uuid, $4::uuid)`,
      [sectionId, projectId, `API-${String(counter).padStart(4, '0')}`, memberId(owner)],
      tenant,
    );
    return sectionId;
  };

  const report = (member: number, sectionId: string, extra: Record<string, unknown> = {}, options: { key?: string; tenantId?: string; projectId?: string } = {}): Promise<Reply> =>
    call('POST', '/land-stage-progress/report', {
      member,
      ...(options.key === undefined ? {} : { key: options.key }),
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      body: {
        project_id: options.projectId ?? world.project,
        section_id: sectionId,
        stage_code: 'SURVEY',
        executor_kind: 'LAND_FUND_CENTRE',
        executor_unit_id: unitId(CENTRE),
        mode: 'TRACKED_EXTERNAL',
        parcels_total: 20,
        parcels_done: 5,
        evidence_document_version_id: world.cleanDocument,
        ...extra,
      },
    });

  const progress = (member: number, projectId: string, query = '', tenantId?: string): Promise<Reply> =>
    call('GET', `/projects/${projectId}/land-progress${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });

  const stageRow = async (stageId: string) =>
    (
      await rows<Record<string, unknown>>(
        `select mode, status, parcels_total, parcels_done, progress_pct::text as progress_pct, executor_unit_id, evidence_document_version_id, last_reported_by, version::text as version
           from machvon.land_stage_progress where id = $1::uuid`,
        [stageId],
      )
    )[0];

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: CENTRE, path: `/${unitId(CENTRE)}/` },
      ]);
    }
    for (const n of [OFFICER, CENTRE_STAFF, DEPARTMENT_OFFICER, READER, OTHER_PROJECT_READER, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_OFFICER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'LAND_PROGRESS_OFFICER', ['land.progress.report', 'land.read'], 40);
    await harness.seedRole(TENANT_A, 2, 'LAND_PROGRESS_REPORTER', ['land.progress.report'], 30);
    await harness.seedRole(TENANT_A, 3, 'LAND_READER', ['land.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'LAND_PROGRESS_OFFICER', ['land.progress.report', 'land.read'], 40);
    world = await seedLndWorld(harness.database.adminUrl, TENANT_A, FAMILY, OFFICER, DEPARTMENT, ROOT);
    worldB = await seedLndWorld(harness.database.adminUrl, TENANT_B, FAMILY_B, B_OFFICER, DEPARTMENT, ROOT);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: OFFICER, role: 1, kind: 'TENANT' },
      { n: 2, member: CENTRE_STAFF, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(CENTRE)] },
      { n: 3, member: DEPARTMENT_OFFICER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
      { n: 4, member: READER, role: 3, kind: 'TENANT' },
      { n: 5, member: OTHER_PROJECT_READER, role: 3, kind: 'PROJECT', refs: [world.otherProject] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_OFFICER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [LandStageProgressController],
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

  it('is registered in the module of LND', () => {
    expect(lndModule.controllers).toEqual([LandSectionController, LandParcelController, LandParcelImportController, LandReadsController, LandStageProgressController, AffectedHouseholdController, AffectedHouseholdReadsController]);
  });

  describe('reportLandStageProgress (AC-ST-LND-010-1, UAT-AC387)', () => {
    it('lets the project give a stage to the external centre, and the centre report on it with evidence: stored, audited and told with ids only', async () => {
      const sectionId = await makeSection();
      // Nobody gave the stage to the centre: its staff cannot create it.
      const early = await report(CENTRE_STAFF, sectionId);
      expect([early.status, early.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const assigned = await report(OFFICER, sectionId, { parcels_done: 0, evidence_document_version_id: undefined, planned_end: '2099-12-31' });
      expect(assigned.status).toBe(200);
      expect(assigned.json).toMatchObject({ status: 'NOT_STARTED', resource_version: 1 });
      const stageId = assigned.json.resource_id as string;

      const reported = await report(CENTRE_STAFF, sectionId, { parcels_total: 30, parcels_done: 12, actual_start: '2026-09-01', planned_end: '2099-12-31' });
      expect(reported.status).toBe(200);
      expect(reported.json).toMatchObject({ resource_id: stageId, status: 'IN_PROGRESS', resource_version: 2 });
      expect(await stageRow(stageId)).toEqual({
        mode: 'TRACKED_EXTERNAL',
        status: 'IN_PROGRESS',
        parcels_total: 30,
        parcels_done: 12,
        progress_pct: '40.00',
        executor_unit_id: unitId(CENTRE),
        evidence_document_version_id: world.cleanDocument,
        last_reported_by: memberId(CENTRE_STAFF),
        version: '2',
      });
      const [audit] = await audits(stageId, 'land.stage_progress_reported');
      expect(audit?.outcome).toBe('SUCCESS');
      const centreAudits = (await audits(stageId, 'land.stage_progress_reported')).filter((entry) => entry.actor_id === memberId(CENTRE_STAFF));
      expect(centreAudits).toHaveLength(1);
      expect(centreAudits[0]?.safe_diff).toMatchObject({ project_id: world.project, stage_code: 'SURVEY', from_status: 'NOT_STARTED', to_status: 'IN_PROGRESS', parcels_done: 12, evidence_document_version_id: world.cleanDocument, created: false });
      const told = await events(stageId, 'lnd.stage_progress.reported.v1');
      expect(told.map((event) => event.aggregate_version)).toEqual(['1', '2']);
      expect(told[1]?.payload).toMatchObject({ tenant_id: TENANT_A, stage_id: stageId, project_id: world.project, mode: 'TRACKED_EXTERNAL', status: 'IN_PROGRESS', parcels_done: 12, progress_pct: '40.00', actor_id: memberId(CENTRE_STAFF) });
      expect(JSON.stringify(told)).not.toContain('blocker_note');
    });

    it('answers a repeated request with the first answer and keeps one version', async () => {
      const sectionId = await makeSection();
      const key = `key-${randomUUID()}`;
      const first = await report(OFFICER, sectionId, {}, { key });
      const second = await report(OFFICER, sectionId, {}, { key });
      expect(second.status).toBe(200);
      expect(second.json).toEqual(first.json);
      expect((await stageRow(first.json.resource_id as string))?.version).toBe('1');
    });

    it('takes a stage that is behind its planned end into LATE and asks ISS for one issue, once', async () => {
      const sectionId = await makeSection();
      const first = await report(OFFICER, sectionId, { parcels_done: 3, planned_end: '2026-01-31' });
      expect(first.json).toMatchObject({ status: 'LATE', resource_version: 1 });
      const stageId = first.json.resource_id as string;
      const late = await events(stageId, 'lnd.stage.late.v1');
      expect(late).toHaveLength(1);
      expect(late[0]?.payload).toMatchObject({ source_ref_id: stageId, project_id: world.project, stage_code: 'SURVEY', status: 'LATE', source_module: 'LND', tenant_id: TENANT_A });
      const next = await report(CENTRE_STAFF, sectionId, { parcels_done: 6, planned_end: '2026-01-31' });
      expect(next.json).toMatchObject({ status: 'LATE', resource_version: 2 });
      expect(await events(stageId, 'lnd.stage.late.v1')).toHaveLength(1);
    });

    it('does not take the report of a stage that LND counts itself: 422 NATIVE_STAGE_READONLY', async () => {
      const refused = await report(OFFICER, await makeSection(), { mode: 'NATIVE' });
      expect([refused.status, refused.json.code]).toEqual([422, 'NATIVE_STAGE_READONLY']);
    });

    it('refuses more parcels done than the total with 422 PARCELS_DONE_EXCEEDS_TOTAL, and an unproven report', async () => {
      const sectionId = await makeSection();
      const exceeds = await report(OFFICER, sectionId, { parcels_total: 5, parcels_done: 6 });
      expect([exceeds.status, exceeds.json.code]).toEqual([422, 'PARCELS_DONE_EXCEEDS_TOTAL']);
      const unproven = await report(OFFICER, sectionId, { evidence_document_version_id: undefined });
      expect([unproven.status, unproven.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const pending = await report(OFFICER, sectionId, { evidence_document_version_id: world.pendingDocument });
      expect([pending.status, pending.json.code]).toEqual([422, 'DOCUMENT_NOT_CLEAN']);
      const foreign = await report(OFFICER, sectionId, { evidence_document_version_id: worldB.cleanDocument });
      expect([foreign.status, foreign.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect(await rows('select 1 from machvon.land_stage_progress where section_id = $1::uuid', [sectionId])).toEqual([]);
    });

    it('turns away with 403 the caller who reaches neither the project nor the executing unit, and the unit that is not named', async () => {
      const sectionId = await makeSection();
      for (const member of [READER, NOBODY, OTHER_PROJECT_READER]) {
        const refused = await report(member, sectionId);
        expect(refused.status).toBe(403);
      }
      await report(OFFICER, sectionId);
      // The centre's staff cannot name the department as the executor: they do not reach it.
      const notTheirUnit = await report(CENTRE_STAFF, sectionId, { executor_kind: 'DISTRICT_BOARD', executor_unit_id: unitId(DEPARTMENT) });
      expect([notTheirUnit.status, notTheirUnit.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await rows<{ executor_unit_id: string }>('select executor_unit_id from machvon.land_stage_progress where section_id = $1::uuid', [sectionId]))[0]?.executor_unit_id).toBe(unitId(CENTRE));
      // The unit tree of the department owns the project: its officer is the project office and may reassign.
      const moved = await report(DEPARTMENT_OFFICER, sectionId, { executor_kind: 'DISTRICT_BOARD', executor_unit_id: unitId(DEPARTMENT) });
      expect(moved.status).toBe(200);
    });

    it('does not find a project of another tenant, nor one that does not exist', async () => {
      const sectionId = await makeSection();
      expect((await report(OFFICER, sectionId, {}, { projectId: worldB.project })).status).toBe(404);
      expect((await report(OFFICER, sectionId, {}, { projectId: randomUUID() })).status).toBe(404);
      expect((await report(B_OFFICER, sectionId, {}, { tenantId: TENANT_B, projectId: world.project })).status).toBe(404);
    });

    it('refuses a body with a member that is not in the contract, and a request with no key', async () => {
      const sectionId = await makeSection();
      const extra = await report(OFFICER, sectionId, { owner_name: 'Nguyen Van A' });
      expect([extra.status, extra.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      const headers = { [TENANT_HEADER]: tokenOf(OFFICER), 'content-type': 'application/json' };
      const response = await fetch(`${app.baseUrl}/land-stage-progress/report`, { method: 'POST', headers, body: '{}' });
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('getLandProgress (LND-01, LND-11)', () => {
    it('counts the overview from the rows of LND: the sections, the parcels, the stages and the late ones equal the underlying rows (AC-ST-LND-010-1, UAT-AC387)', async () => {
      const sectionId = await makeSection();
      await report(OFFICER, sectionId, { stage_code: 'SURVEY', parcels_total: 4, parcels_done: 4, actual_start: '2026-09-01', actual_end: '2026-09-20' });
      await report(OFFICER, sectionId, { stage_code: 'NOTICE', parcels_total: 4, parcels_done: 1, planned_end: '2026-02-01' });
      const read = await progress(READER, world.project);
      expect(read.status).toBe(200);
      const totals = read.json.totals as Record<string, number | string>;
      const [counts] = await rows<{ sections: string; late: string; stages: string }>(
        `select (select count(*) from machvon.land_handover_section where project_id = $1::uuid)::text as sections,
                (select count(*) from machvon.land_stage_progress where project_id = $1::uuid and status = 'LATE')::text as late,
                (select count(*) from machvon.land_stage_progress where project_id = $1::uuid)::text as stages`,
        [world.project],
      );
      expect(totals.sections).toBe(Number(counts?.sections));
      expect(totals.late_stages).toBe(Number(counts?.late));
      expect((read.json.stages as unknown[]).length).toBe(Number(counts?.stages));
      expect(read.json.project_id).toBe(world.project);
      expect(typeof read.json.as_of).toBe('string');

      const one = await progress(READER, world.project, `?section_id=${sectionId}`);
      expect(one.status).toBe(200);
      expect((one.json.totals as Record<string, number>).sections).toBe(1);
      const stages = one.json.stages as Array<Record<string, unknown>>;
      expect(stages.map((stage) => [stage.stage_code, stage.status, stage.progress_pct])).toEqual([
        ['SURVEY', 'DONE', '100.00'],
        ['NOTICE', 'LATE', '25.00'],
      ]);
      expect(stages[1]).toMatchObject({ executor_kind: 'LAND_FUND_CENTRE', executor_unit_id: unitId(CENTRE), mode: 'TRACKED_EXTERNAL', evidence_document_version_id: world.cleanDocument, blocker_issue_id: null, planned_end: '2026-02-01' });
      expect(typeof stages[1]?.executor_unit_name).toBe('string');
      // A stage names a unit and a document, never a person.
      expect(JSON.stringify(one.json)).not.toMatch(/last_reported_by|created_by|national_id|head_name|household_code/);
    });

    it('does not find a project outside the scope of the caller, a section of another project, a project of another tenant, and refuses ids that are not ids', async () => {
      const sectionId = await makeSection();
      expect((await progress(OTHER_PROJECT_READER, world.project)).status).toBe(404);
      expect((await progress(OTHER_PROJECT_READER, world.otherProject)).status).toBe(200);
      expect((await progress(NOBODY, world.project)).status).toBe(403);
      expect((await progress(READER, world.project, `?section_id=${randomUUID()}`)).status).toBe(404);
      expect((await progress(READER, world.otherProject, `?section_id=${sectionId}`)).status).toBe(404);
      expect((await progress(READER, worldB.project)).status).toBe(404);
      expect((await progress(B_OFFICER, world.project, '', TENANT_B)).status).toBe(404);
      const bad = await progress(READER, 'not-an-id');
      expect([bad.status, bad.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const badSection = await progress(READER, world.project, '?section_id=nope');
      expect([badSection.status, badSection.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });
  });
});
