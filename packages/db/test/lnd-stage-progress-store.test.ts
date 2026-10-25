import { AuditWriter } from '../src/audit-writer';
import { LndParcelStore } from '../src/lnd-parcel-store';
import { LndSectionStore } from '../src/lnd-section-store';
import { LndStageLateJob, LndStageProgressStore, STAGE_LATE_EVENT } from '../src/lnd-stage-progress-store';
import type { StageReport } from '../src/lnd-stage-progress-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';
import { seedLndWorld } from './support/lnd-fixtures';
import type { LndWorld } from './support/lnd-fixtures';

const harness = new AuthzHarness();
const sections = new LndSectionStore();
const parcels = new LndParcelStore();
const stages = new LndStageProgressStore();
const audit = new AuditWriter(harness.tenants);
const lateJob = new LndStageLateJob(audit);
const ACTOR = 1;
const TODAY = '2026-10-24';
const PROVINCE = 1;
const DEPARTMENT = 2;
const CENTRE = 3;
const FAMILY = 0xb4;

let world: LndWorld;
let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(ACTOR)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

const sqlState = async (work: Promise<unknown>): Promise<{ sqlstate: string; message: string }> => {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; message: string };
    return { sqlstate: e.code ?? '', message: e.message };
  }
  throw new Error('expected the database to refuse');
};

/** A fresh section of the project: a stage is unique by section, stage code and plan, so every test takes its own. */
const makeSection = async (projectId = world.project): Promise<string> => {
  counter += 1;
  return (await as((tx) => sections.create(tx, { projectId, code: `ST-${String(counter).padStart(3, '0')}`, name: 'Km 0 to km 3', requiredAreaM2: '30000' }, memberId(ACTOR)))).id;
};

const input = (sectionId: string, extra: Partial<StageReport> = {}): StageReport => ({
  projectId: world.project,
  sectionId,
  stageCode: 'SURVEY',
  executorKind: 'LAND_FUND_CENTRE',
  executorUnitId: unitId(CENTRE),
  mode: 'TRACKED_EXTERNAL',
  parcelsTotal: 20,
  parcelsDone: 5,
  evidenceDocumentVersionId: world.cleanDocument,
  ...extra,
});

const report = (sectionId: string, extra: Partial<StageReport> = {}, options: { today?: string; assignedOnly?: boolean } = {}) =>
  as((tx) => stages.report(tx, input(sectionId, extra), memberId(ACTOR), { today: options.today ?? TODAY, assignedOnly: options.assignedOnly ?? false }));

const stageRows = (sectionId: string) =>
  owner<{
    id: string;
    stage_code: string;
    mode: string;
    status: string;
    parcels_total: number;
    parcels_done: number;
    progress_pct: string;
    executor_unit_id: string;
    evidence_document_version_id: string | null;
    last_reported_by: string | null;
    blocker_note: string | null;
    actual_end: string | null;
    version: string;
  }>(
    `select id, stage_code, mode, status, parcels_total, parcels_done, progress_pct::text as progress_pct, executor_unit_id, evidence_document_version_id, last_reported_by, blocker_note,
            actual_end::text as actual_end, version::text as version from machvon.land_stage_progress where section_id = $1::uuid order by stage_code`,
    [sectionId],
  );

const events = (stageId: string, type: string) =>
  owner<{ payload: Record<string, unknown>; event_key: string }>('select payload, event_key from machvon.outbox_event where aggregate_id = $1::uuid and type = $2 order by created_at', [stageId, type]);

describe('the progress of the stages of land clearance, tracked from outside (ST-LND-010)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: CENTRE, path: '/u3/' },
      ]);
      await harness.seedMembership(tenant, ACTOR, PROVINCE);
    }
    world = await seedLndWorld(harness.database.adminUrl, TENANT_A, FAMILY, ACTOR, DEPARTMENT, PROVINCE);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('reportLandStageProgress', () => {
    it('stores the report of an external centre with its evidence, counts the progress exactly and updates the same stage on the next report (AC-ST-LND-010-1, UAT-AC387)', async () => {
      const sectionId = await makeSection();
      const first = await report(sectionId, { parcelsTotal: 30, parcelsDone: 7, plannedStart: '2026-09-01', plannedEnd: '2026-12-31', actualStart: '2026-09-05' });
      expect(first).toMatchObject({ created: true, version: 1, status: 'IN_PROGRESS', previousStatus: null, previousExecutorUnitId: null, progressPct: '23.33', lateEvent: null, evidenceDocumentVersionId: world.cleanDocument });
      const second = await report(sectionId, { parcelsTotal: 30, parcelsDone: 15, plannedEnd: '2026-12-31', actualStart: '2026-09-05' });
      expect(second).toMatchObject({ id: first.id, created: false, version: 2, status: 'IN_PROGRESS', previousStatus: 'IN_PROGRESS', progressPct: '50.00' });
      const rows = await stageRows(sectionId);
      expect(rows).toEqual([
        {
          id: first.id,
          stage_code: 'SURVEY',
          mode: 'TRACKED_EXTERNAL',
          status: 'IN_PROGRESS',
          parcels_total: 30,
          parcels_done: 15,
          progress_pct: '50.00',
          executor_unit_id: unitId(CENTRE),
          evidence_document_version_id: world.cleanDocument,
          last_reported_by: memberId(ACTOR),
          blocker_note: null,
          actual_end: null,
          version: '2',
        },
      ]);
    });

    it('finishes a stage when every parcel is done and it has an end, and keeps the stage DONE when a later report only corrects its evidence', async () => {
      const sectionId = await makeSection();
      const done = await report(sectionId, { parcelsTotal: 12, parcelsDone: 12, actualStart: '2026-09-01', actualEnd: '2026-10-20', plannedEnd: '2026-10-01' });
      expect(done).toMatchObject({ status: 'DONE', progressPct: '100.00' });
      const again = await report(sectionId, { parcelsTotal: 12, parcelsDone: 12, actualStart: '2026-09-01', actualEnd: '2026-10-20', plannedEnd: '2026-10-01', evidenceDocumentVersionId: world.cleanDocument });
      expect(again).toMatchObject({ status: 'DONE', previousStatus: 'DONE', version: 2, lateEvent: null });
    });

    it('takes a stage that is behind its planned end into LATE once and hands the event of the issue intake to the caller, and not again on the next report (AC-ST-LND-010-1, UAT-AC387)', async () => {
      const sectionId = await makeSection();
      const first = await report(sectionId, { parcelsDone: 3, plannedEnd: '2026-10-01' });
      expect(first.status).toBe('LATE');
      expect(first.lateEvent).toMatchObject({
        aggregateType: 'land_stage_progress',
        aggregateId: first.id,
        aggregateVersion: 1,
        type: STAGE_LATE_EVENT,
        schemaVersion: 1,
        eventKey: `land_stage_progress:${first.id}:late:1`,
      });
      const payload = first.lateEvent?.payload as Record<string, unknown>;
      expect(payload).toMatchObject({ source_ref_id: first.id, project_id: world.project, owner_unit_id: unitId(DEPARTMENT), stage_code: 'SURVEY', executor_kind: 'LAND_FUND_CENTRE', planned_end: '2026-10-01', source_module: 'LND' });
      expect(String(payload.reference_code)).toMatch(/^ST-\d{3}-SURVEY$/);
      // The payload carries ids and codes and nothing a person said.
      for (const member of ['blocker_note', 'name', 'description', 'address']) expect(payload).not.toHaveProperty(member);
      const next = await report(sectionId, { parcelsDone: 6, plannedEnd: '2026-10-01' });
      expect(next).toMatchObject({ status: 'LATE', previousStatus: 'LATE', lateEvent: null });
    });

    it('says a stage is not late on its planned day and is late the day after', async () => {
      const sectionId = await makeSection();
      expect((await report(sectionId, { plannedEnd: TODAY })).status).toBe('IN_PROGRESS');
      expect((await report(sectionId, { plannedEnd: '2026-10-23' })).status).toBe('LATE');
    });

    it('records what holds a stage back as BLOCKED, trimmed, and clears it when the report no longer carries it', async () => {
      const sectionId = await makeSection();
      const blocked = await report(sectionId, { parcelsDone: 0, evidenceDocumentVersionId: undefined, plannedEnd: '2027-03-01', blockerNote: '  Waiting for the decision of the district  ' });
      expect(blocked.status).toBe('BLOCKED');
      expect((await stageRows(sectionId))[0]?.blocker_note).toBe('Waiting for the decision of the district');
      const freed = await report(sectionId, { parcelsDone: 0, evidenceDocumentVersionId: undefined, plannedEnd: '2027-03-01' });
      expect(freed.status).toBe('NOT_STARTED');
      expect((await stageRows(sectionId))[0]?.blocker_note).toBeNull();
    });

    it('lets the people of the project reassign the executor, and keeps the stage the same row', async () => {
      const sectionId = await makeSection();
      const first = await report(sectionId);
      const moved = await report(sectionId, { executorKind: 'DISTRICT_BOARD', executorUnitId: unitId(DEPARTMENT) });
      expect(moved).toMatchObject({ id: first.id, previousExecutorUnitId: unitId(CENTRE), executorUnitId: unitId(DEPARTMENT) });
    });

    it('does not take the report of a stage that LND counts itself: 422 NATIVE_STAGE_READONLY for the mode and for a stored stage in that mode', async () => {
      const sectionId = await makeSection();
      expect(await refusal(report(sectionId, { mode: 'NATIVE' }))).toEqual({ code: 'NATIVE_STAGE_READONLY', status: 422, detail: 'mode' });
      await owner(
        `insert into machvon.land_stage_progress (tenant_id, id, project_id, section_id, stage_code, executor_kind, executor_unit_id, mode, created_by, updated_by)
         values ($1, $2, $3, $4, 'NOTICE', 'PROJECT_OWNER', $5, 'NATIVE', $6, $6)`,
        [TENANT_A, id(FAMILY, 0x71), world.project, sectionId, unitId(DEPARTMENT), memberId(ACTOR)],
      );
      expect(await refusal(report(sectionId, { stageCode: 'NOTICE', parcelsDone: 0, evidenceDocumentVersionId: undefined }))).toEqual({ code: 'NATIVE_STAGE_READONLY', status: 422, detail: 'stage_code' });
    });

    it('refuses more parcels done than the total with 422 PARCELS_DONE_EXCEEDS_TOTAL, and counts that are not whole numbers', async () => {
      const sectionId = await makeSection();
      expect(await refusal(report(sectionId, { parcelsTotal: 5, parcelsDone: 6 }))).toEqual({ code: 'PARCELS_DONE_EXCEEDS_TOTAL', status: 422, detail: 'parcels_done' });
      expect(await refusal(report(sectionId, { parcelsDone: -1 }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'parcels_done' });
      expect(await refusal(report(sectionId, { parcelsTotal: 1.5 }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'parcels_total' });
      expect(await stageRows(sectionId)).toEqual([]);
    });

    it('asks the evidence of a tracked stage that reports progress, and takes only a clean document of the tenant', async () => {
      const sectionId = await makeSection();
      expect(await refusal(report(sectionId, { evidenceDocumentVersionId: undefined }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'evidence_document_version_id' });
      expect(await refusal(report(sectionId, { evidenceDocumentVersionId: world.pendingDocument }))).toEqual({ code: 'DOCUMENT_NOT_CLEAN', status: 422, detail: 'evidence_document_version_id' });
      expect(await refusal(report(sectionId, { evidenceDocumentVersionId: id(FAMILY, 0x99) }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'evidence_document_version_id' });
      expect(await refusal(as((tx) => stages.report(tx, input(sectionId), memberId(ACTOR), { today: TODAY, assignedOnly: false }), TENANT_B))).toMatchObject({ status: 422 });
      expect(await stageRows(sectionId)).toEqual([]);
      // No progress, no evidence needed: a stage that has not begun is reported as planned.
      await expect(report(sectionId, { parcelsDone: 0, evidenceDocumentVersionId: undefined, plannedStart: '2026-11-01', plannedEnd: '2027-01-31' })).resolves.toMatchObject({ status: 'NOT_STARTED' });
    });

    it('refuses dates out of order, actual dates in the future and an end before every parcel is done', async () => {
      const sectionId = await makeSection();
      expect(await refusal(report(sectionId, { plannedStart: '2026-12-01', plannedEnd: '2026-11-01' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'planned_end' });
      expect(await refusal(report(sectionId, { actualStart: '2026-10-25' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'actual_start' });
      expect(await refusal(report(sectionId, { actualEnd: '2026-10-20' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'actual_end' });
      expect(await refusal(report(sectionId, { plannedEnd: '2026-02-30' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'planned_end' });
      expect(await refusal(report(sectionId, { blockerNote: '   ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'blocker_note' });
    });

    it('takes only the stages and the executors of the table', async () => {
      const sectionId = await makeSection();
      expect(await refusal(report(sectionId, { stageCode: 'DEMOLITION' as never }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'stage_code' });
      expect(await refusal(report(sectionId, { executorKind: 'CONTRACTOR' as never }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'executor_kind' });
    });

    it('takes only a section of the project, a plan of the project and an active unit', async () => {
      const otherSection = await makeSection(world.otherProject);
      expect(await refusal(report(otherSection))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'section_id' });
      const sectionId = await makeSection();
      expect(await refusal(report(sectionId, { planId: id(FAMILY, 0x98) }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'plan_id' });
      expect(await refusal(report(sectionId, { executorUnitId: id(FAMILY, 0x97) }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'executor_unit_id' });
    });

    it('lets the unit that executes a stage report only on a stage that the project gave it', async () => {
      const sectionId = await makeSection();
      // Nobody gave the stage to the centre yet.
      expect(await refusal(report(sectionId, {}, { assignedOnly: true }))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      await report(sectionId);
      await expect(report(sectionId, { parcelsDone: 9 }, { assignedOnly: true })).resolves.toMatchObject({ version: 2, parcelsDone: 9 });
      // What it names is judged after its right: a section, a plan or a document that does not exist is 403 for it, and tells it nothing.
      expect(await refusal(report(sectionId, { sectionId: id(FAMILY, 0x96) }, { assignedOnly: true }))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(report(sectionId, { planId: id(FAMILY, 0x95) }, { assignedOnly: true }))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      // On the stage it was given, a document that is not clean is the answer it is owed.
      expect(await refusal(report(sectionId, { evidenceDocumentVersionId: world.pendingDocument }, { assignedOnly: true }))).toMatchObject({ code: 'DOCUMENT_NOT_CLEAN' });
      // It cannot hand the stage to another unit.
      expect(await refusal(report(sectionId, { executorKind: 'DISTRICT_BOARD', executorUnitId: unitId(DEPARTMENT) }, { assignedOnly: true }))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      expect((await stageRows(sectionId))[0]).toMatchObject({ executor_unit_id: unitId(CENTRE), parcels_done: 9 });
    });
  });

  describe('the guards of the table', () => {
    it('keeps the arithmetic, the order of the dates, the evidence of a tracked stage and the notes, whoever writes', async () => {
      const sectionId = await makeSection();
      const created = await report(sectionId);
      const set = (assignments: string, params: unknown[] = []) => as((tx) => tx.query(`update machvon.land_stage_progress set ${assignments} where id = $1::uuid`, [created.id, ...params]));
      expect((await sqlState(set("status = 'DONE', actual_end = date '2026-10-01', parcels_done = 5"))).sqlstate).toBe('23514');
      expect((await sqlState(set("planned_start = date '2026-12-01', planned_end = date '2026-11-01'"))).sqlstate).toBe('23514');
      expect((await sqlState(set('evidence_document_version_id = null'))).sqlstate).toBe('23514');
      expect((await sqlState(set("blocker_note = '  padded  '"))).sqlstate).toBe('23514');
      expect((await sqlState(set('last_reported_at = null'))).sqlstate).toBe('23514');
    });

    it('keeps the place of a stage: its project, section, plan, code and mode never change, and a stage lies in a section of its own project', async () => {
      const sectionId = await makeSection();
      const created = await report(sectionId);
      const other = await makeSection();
      const set = (assignments: string, params: unknown[] = []) => as((tx) => tx.query(`update machvon.land_stage_progress set ${assignments} where id = $1::uuid`, [created.id, ...params]));
      expect((await sqlState(set('section_id = $2::uuid', [other]))).sqlstate).toBe('23514');
      expect((await sqlState(set("stage_code = 'NOTICE'"))).sqlstate).toBe('23514');
      expect((await sqlState(set("mode = 'NATIVE'"))).sqlstate).toBe('23514');
      const foreign = await makeSection(world.otherProject);
      const insert = await sqlState(
        owner(
          `insert into machvon.land_stage_progress (tenant_id, id, project_id, section_id, stage_code, executor_kind, executor_unit_id, mode, created_by, updated_by)
           values ($1, $2, $3, $4, 'SURVEY', 'PROJECT_OWNER', $5, 'TRACKED_EXTERNAL', $6, $6)`,
          [TENANT_A, id(FAMILY, 0x72), world.project, foreign, unitId(DEPARTMENT), memberId(ACTOR)],
        ),
      );
      expect(insert.sqlstate).toBe('23514');
      expect(insert.message).toContain('section of its own project');
    });

    it('is never deleted by the runtime role', async () => {
      const sectionId = await makeSection();
      const created = await report(sectionId);
      expect((await sqlState(as((tx) => tx.query('delete from machvon.land_stage_progress where id = $1::uuid', [created.id])))).sqlstate).toBe('42501');
      expect((await sqlState(as((tx) => tx.query('delete from machvon.land_stage_progress')))).sqlstate).toBe('42501');
    });
  });

  describe('the job land-stage-late', () => {
    const run = (now: Date) => as((tx) => lateJob.run(tx, memberId(ACTOR), now));

    it('takes the stages that are behind their planned end into LATE, once, with the audit row and the event, and leaves the others alone (AC-ST-LND-010-1, UAT-AC387)', async () => {
      const behind = await report(await makeSection(), { stageCode: 'PAYMENT', parcelsDone: 4, plannedEnd: '2026-11-05' });
      const blocked = await report(await makeSection(), { stageCode: 'PAYMENT', parcelsDone: 0, evidenceDocumentVersionId: undefined, plannedEnd: '2026-11-05', blockerNote: 'Waiting for the funds' });
      const finished = await report(await makeSection(), { stageCode: 'PAYMENT', parcelsTotal: 4, parcelsDone: 4, plannedEnd: '2026-11-05', actualStart: '2026-10-01', actualEnd: '2026-10-20' });
      const early = await report(await makeSection(), { stageCode: 'PAYMENT', parcelsDone: 4, plannedEnd: '2026-11-30' });
      for (const stage of [behind, blocked, finished, early]) expect(stage.lateEvent).toBeNull();

      // The planned day itself is not late; the day after is.
      expect(await run(new Date('2026-11-05T10:00:00Z'))).toEqual({ late: 0 });
      const result = await run(new Date('2026-11-06T10:00:00Z'));
      expect(result.late).toBeGreaterThanOrEqual(2);
      const status = async (stageId: string) => (await owner<{ status: string; version: string }>('select status, version::text as version from machvon.land_stage_progress where id = $1::uuid', [stageId]))[0];
      expect(await status(behind.id)).toEqual({ status: 'LATE', version: '2' });
      expect(await status(blocked.id)).toEqual({ status: 'LATE', version: '2' });
      expect(await status(finished.id)).toEqual({ status: 'DONE', version: '1' });
      expect(await status(early.id)).toEqual({ status: 'IN_PROGRESS', version: '1' });

      const late = await events(behind.id, STAGE_LATE_EVENT);
      expect(late).toHaveLength(1);
      expect(late[0]?.event_key).toBe(`land_stage_progress:${behind.id}:late:2`);
      expect(late[0]?.payload).toMatchObject({ source_ref_id: behind.id, project_id: world.project, stage_code: 'PAYMENT', status: 'LATE', source_module: 'LND' });
      const audited = await owner<{ diff: Record<string, unknown>; actor_id: string }>("select safe_diff as diff, actor_id from machvon.audit_event where resource_id = $1::uuid and action = 'lnd.stage_late'", [behind.id]);
      expect(audited).toHaveLength(1);
      expect(audited[0]?.actor_id).toBe(memberId(ACTOR));
      expect(audited[0]?.diff).toMatchObject({ from_status: 'IN_PROGRESS', to_status: 'LATE', stage_code: 'PAYMENT', planned_end: '2026-11-05' });
      expect(await events(early.id, STAGE_LATE_EVENT)).toEqual([]);

      // A second pass the same day does nothing: the stage is LATE already.
      expect(await run(new Date('2026-11-06T18:00:00Z'))).toEqual({ late: 0 });
      expect(await events(behind.id, STAGE_LATE_EVENT)).toHaveLength(1);
    });

    it('judges the day by the date in Vietnam, not by the clock of the machine', async () => {
      const stage = await report(await makeSection(), { stageCode: 'HANDOVER', parcelsDone: 4, plannedEnd: '2026-12-10' });
      // 2026-12-10T20:00Z is already 2026-12-11 in Vietnam.
      const status = async () => (await owner<{ status: string }>('select status from machvon.land_stage_progress where id = $1::uuid', [stage.id]))[0]?.status;
      await run(new Date('2026-12-10T16:59:00Z'));
      expect(await status()).toBe('IN_PROGRESS');
      await run(new Date('2026-12-10T17:00:00Z'));
      expect(await status()).toBe('LATE');
    });
  });

  describe('the overview of a project', () => {
    it('counts from the rows of LND: sections, areas, parcels by status, the parcels with a notice, and the stages that were reported (AC-ST-LND-010-1, UAT-AC387)', async () => {
      const projectOnly = await makeSection(world.otherProject);
      expect(await as((tx) => stages.overview(tx, world.otherProject, projectOnly))).toMatchObject({
        projectId: world.otherProject,
        totals: { sections: 1, parcels: 0, households: 0, lateStages: 0, requiredAreaM2: '30000.00', handedAreaM2: '0.00' },
        parcelsByStatus: {},
        stages: [],
      });

      const sectionId = await makeSection();
      const made = [];
      for (let n = 0; n < 3; n += 1) {
        counter += 1;
        made.push(await as((tx) => parcels.create(tx, { projectId: world.project, sectionId, ownerUnitId: unitId(DEPARTMENT), parcelCode: `LP-S-${String(counter).padStart(3, '0')}`, landUseGroup: 'AGRICULTURAL', areaTotalM2: '100', areaAffectedM2: '50' }, memberId(ACTOR), TODAY)));
      }
      await owner("update machvon.land_parcel set recovery_notice_on = date '2026-09-01', notice_days_applied = 90, notice_document_version_id = $2::uuid where id = $1::uuid", [made[0]?.id, world.cleanDocument]);
      await owner("update machvon.land_parcel set status = 'PAID' where id = $1::uuid", [made[1]?.id]);
      await report(sectionId, { stageCode: 'SURVEY', parcelsTotal: 3, parcelsDone: 3, actualStart: '2026-09-01', actualEnd: '2026-09-20' });
      await report(sectionId, { stageCode: 'NOTICE', parcelsTotal: 3, parcelsDone: 1, plannedEnd: '2026-10-01' });

      const overview = await as((tx) => stages.overview(tx, world.project, sectionId));
      expect(overview.totals).toMatchObject({ sections: 1, parcels: 3, parcelsNoticed: 1, parcelsPaid: 1, parcelsHandedOver: 0, households: expect.any(Number), plansPosted: 0, paymentsPaid: 0, paymentsTotal: 0, lateStages: 1 });
      expect(overview.parcelsByStatus).toEqual({ PAID: 1, SURVEYED: 2 });
      expect(overview.sections).toHaveLength(1);
      expect(overview.sections[0]).toMatchObject({ id: sectionId, parcels: 3, parcelsNoticed: 1, parcelsPaid: 1 });
      // The stages come in the order of the stages of clearance, with the name of the unit that executes them and the evidence they were reported with.
      expect(overview.stages.map((stage) => [stage.stageCode, stage.status, stage.progressPct])).toEqual([
        ['SURVEY', 'DONE', '100.00'],
        ['NOTICE', 'LATE', '33.33'],
      ]);
      expect(overview.stages[1]).toMatchObject({ executorKind: 'LAND_FUND_CENTRE', executorUnitId: unitId(CENTRE), mode: 'TRACKED_EXTERNAL', evidenceDocumentVersionId: world.cleanDocument, blockerIssueId: null });
      expect(typeof overview.stages[1]?.executorUnitName).toBe('string');

      // The overview of the whole project sums the sections; the counts equal the underlying rows.
      const whole = await as((tx) => stages.overview(tx, world.project, undefined));
      const [rows] = await owner<{ n: string; late: string }>(
        `select (select count(*) from machvon.land_parcel where project_id = $1::uuid)::text as n, (select count(*) from machvon.land_stage_progress where project_id = $1::uuid and status = 'LATE')::text as late`,
        [world.project],
      );
      expect(whole.totals.parcels).toBe(Number(rows?.n));
      expect(whole.totals.lateStages).toBe(Number(rows?.late));
      expect(Object.values(whole.parcelsByStatus).reduce((sum, n) => sum + n, 0)).toBe(Number(rows?.n));
      expect(whole.totals.sections).toBe(whole.sections.length);
    });

    it('does not show the stages of another tenant', async () => {
      const foreign = await as((tx) => stages.overview(tx, world.project, undefined), TENANT_B);
      expect(foreign.totals).toMatchObject({ sections: 0, parcels: 0, lateStages: 0 });
      expect(foreign.stages).toEqual([]);
    });
  });
});
