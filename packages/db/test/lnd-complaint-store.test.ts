import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { FieldCipher, addCalendarDays, staticKeyProvider } from '@machvon/kernel';
import { readIntake } from '../src/iss-intake';
import { LndComplaintStore, complaintFiledPayload, linkComplaintIssue } from '../src/lnd-complaint-store';
import { LndHouseholdStore } from '../src/lnd-household-store';
import { LndParcelStore } from '../src/lnd-parcel-store';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';
import { seedLndWorld } from './support/lnd-fixtures';
import type { LndWorld } from './support/lnd-fixtures';

const harness = new AuthzHarness();
const cipher = new FieldCipher(staticKeyProvider(new Map([[1, randomBytes(32)]])));
const households = new LndHouseholdStore(cipher);
const parcels = new LndParcelStore();
const complaints = new LndComplaintStore();
const OFFICER = 1;
const FAMILY = 0xbb;
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const TODAY = '2026-10-26';
const FILED = '2026-09-15';
const DUE = '2026-10-15';
const EVERYWHERE = '*';
const NOWHERE = '';
const BASIS = 'Luật Đất đai 2024, Điều 87';

let world: LndWorld;
let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = OFFICER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
/** The statement as the owner of the tables sees it: the policy of the scope applies to the owner too, so the scope is put first. */
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], units: string | null = EVERYWHERE): Promise<R[]> =>
  harness.owner<R>(
    TENANT_A,
    units === null
      ? [[sql, params]]
      : [
          ["select set_config('app.scope_units', $1, false)", [units]],
          [sql, params],
        ],
  );

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

/** Statements as the administrator of the database, with the foreign keys to the modules that land clearance only reads switched off (as the seed of the world does). */
async function asAdmin(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const [text, params] of statements) await client.query(text, params);
  } finally {
    await client.end();
  }
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

interface Target {
  householdId: string;
  parcelIds: string[];
}
/** A household of the unit asked for, with one parcel (or as many as asked) it holds a right on. */
async function target(options: { unit?: number; project?: string; parcels?: number } = {}): Promise<Target> {
  counter += 1;
  const unit = options.unit ?? DEPARTMENT;
  const project = options.project ?? world.project;
  const registered = await as((tx) =>
    households.register(
      tx,
      { projectId: project, ownerUnitId: unitId(unit), headName: 'Nguyễn Văn A', nationalId: String(900000000000 + counter * 41), legalBasis: 'PUBLIC_TASK_LAND_LAW', legalBasisRef: BASIS, retentionUntil: '2036-12-31' },
      memberId(OFFICER),
      EVERYWHERE,
      TODAY,
    ),
  );
  const parcelIds: string[] = [];
  for (let index = 0; index < (options.parcels ?? 1); index += 1) {
    const parcel = await as((tx) =>
      parcels.create(tx, { projectId: project, ownerUnitId: unitId(unit), parcelCode: `LP-C-${String(counter).padStart(3, '0')}-${index}`, landUseGroup: 'AGRICULTURAL', areaTotalM2: '1000', areaAffectedM2: '500' }, memberId(OFFICER), TODAY),
    );
    await as((tx) => households.link(tx, registered.id, { parcelId: parcel.id, rightKind: 'OWNER' }, memberId(OFFICER), EVERYWHERE));
    parcelIds.push(parcel.id);
  }
  return { householdId: registered.id, parcelIds };
}

const file = (aim: Target, extra: Record<string, unknown> = {}, units = EVERYWHERE, today = TODAY) =>
  as((tx) =>
    complaints.file(
      tx,
      { projectId: world.project, householdId: aim.householdId, ownerUnitId: unitId(DEPARTMENT), channel: 'MEETING', subject: 'PRICE', description: 'The price of the house is too low', filedOn: FILED, ...extra } as Parameters<LndComplaintStore['file']>[1],
      memberId(OFFICER),
      units,
      today,
    ),
  );
const resolve = (complaintId: string, version: number, extra: Record<string, unknown> = {}, units = EVERYWHERE, today = TODAY) =>
  as((tx) =>
    complaints.resolve(
      tx,
      { complaintId, expectedVersion: version, outcome: 'RESOLVED_ACCEPTED', resolutionDocumentVersionId: world.cleanDocument, resolvedOn: '2026-10-10', note: 'The price was checked again', ...extra } as Parameters<LndComplaintStore['resolve']>[1],
      memberId(OFFICER),
      units,
      today,
    ),
  );
const rowOf = async (id: string) =>
  (
    await owner<Record<string, unknown>>(
      `select status, version::text as version, resolved_on::text as resolved_on, resolution_note, resolution_document_version_id, issue_id, complaint_no, due_on::text as due_on, owner_unit_id
         from machvon.land_complaint where id = $1::uuid`,
      [id],
    )
  )[0];
const deadlineOf = async (id: string) =>
  (await owner<{ status: string; due_on: string; days_applied: number; satisfied_on: string | null; rule_version_id: string }>("select status, due_on::text as due_on, days_applied, satisfied_on::text as satisfied_on, rule_version_id from machvon.land_deadline where subject_kind = 'COMPLAINT' and subject_id = $1::uuid", [id]))[0];
const parcelStatus = async (id: string): Promise<string> => ((await owner<{ status: string }>('select status from machvon.land_parcel where id = $1::uuid', [id]))[0] as { status: string }).status;
const holdsOf = (complaintId: string) => owner<{ parcel_id: string; previous_status: string; released: boolean }>('select parcel_id, previous_status, released_at is not null as released from machvon.land_complaint_hold where complaint_id = $1::uuid order by parcel_id', [complaintId]);
const withoutRule = async (code: string, work: () => Promise<void>): Promise<void> => {
  await owner("update machvon.master_record_version set published_at = null where master_type = 'LND_TIMER' and code = $1", [code]);
  try {
    await work();
  } finally {
    await owner("update machvon.master_record_version set published_at = now() where master_type = 'LND_TIMER' and code = $1", [code]);
  }
};

describe('the complaints of the households about the clearance of their land (ST-LND-008)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: OTHER_BRANCH, path: '/u3/' },
      ]);
      await harness.seedMembership(tenant, OFFICER, PROVINCE);
    }
    world = await seedLndWorld(harness.database.adminUrl, TENANT_A, FAMILY, OFFICER, DEPARTMENT, PROVINCE);
    await as((tx) => applyBaseline(tx, BASELINE_PACK, memberId(OFFICER)));
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('filing', () => {
    it('AC-ST-LND-008-1, UAT-AC384: files a complaint with the number that follows in the project, the days of the rule from the day it was filed and a timer, and holds the parcels of the household that are not yet paid', async () => {
      const aim = await target({ parcels: 2 });
      const done = await file(aim);
      expect(done).toMatchObject({ projectId: world.project, complaintNo: expect.stringMatching(/^LC-\d{6}$/), ownerUnitId: unitId(DEPARTMENT), subject: 'PRICE', channel: 'MEETING', filedOn: FILED, dueOn: DUE, daysApplied: 30, parcelsHeld: 2, version: 1 });
      expect(await rowOf(done.id)).toMatchObject({ status: 'RECEIVED', version: '1', complaint_no: done.complaintNo, due_on: DUE, resolved_on: null, issue_id: null });
      expect(await deadlineOf(done.id)).toEqual({ status: 'RUNNING', due_on: DUE, days_applied: 30, satisfied_on: null, rule_version_id: done.ruleVersionId });
      for (const parcel of aim.parcelIds) expect(await parcelStatus(parcel)).toBe('DISPUTED');
      expect((await holdsOf(done.id)).map((hold) => [hold.previous_status, hold.released])).toEqual([
        ['SURVEYED', false],
        ['SURVEYED', false],
      ]);
      const second = await file(await target());
      expect(Number(second.complaintNo.slice(3))).toBe(Number(done.complaintNo.slice(3)) + 1);
    });

    it('holds only the parcels that are not yet paid and leaves the others where they are', async () => {
      const aim = await target({ parcels: 3 });
      await owner("update machvon.land_parcel set status = 'PLAN_APPROVED' where id = $1::uuid", [aim.parcelIds[0]]);
      await owner("update machvon.land_parcel set status = 'PAID' where id = $1::uuid", [aim.parcelIds[1]]);
      const done = await file(aim);
      expect(done.parcelsHeld).toBe(2);
      expect(await parcelStatus(aim.parcelIds[0] as string)).toBe('DISPUTED');
      expect(await parcelStatus(aim.parcelIds[1] as string)).toBe('PAID');
      expect((await holdsOf(done.id)).map((hold) => hold.previous_status).sort()).toEqual(['PLAN_APPROVED', 'SURVEYED']);
    });

    it('wants a channel, a subject, words, a day that has come and a household of the project in the units of the caller that the unit named answers for', async () => {
      const aim = await target();
      expect(await refusal(file(aim, { channel: 'SMOKE' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'channel' });
      expect(await refusal(file(aim, { subject: 'WEATHER' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'subject' });
      for (const description of ['', '   ', 'x'.repeat(2001), 'a\u0007b']) expect(await refusal(file(aim, { description }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'description' });
      for (const filedOn of ['2026-10-27', '1980-01-01', '2026-02-30', 'soon']) expect(await refusal(file(aim, { filedOn }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'filed_on' });
      for (const [field, value] of [
        ['projectId', 'x'],
        ['householdId', 'x'],
        ['ownerUnitId', 'x'],
        ['planId', 'x'],
      ] as const) {
        expect(await refusal(file(aim, { [field]: value }))).toMatchObject({ code: 'VALIDATION_FAILED' });
      }
      expect(await refusal(file(aim, { projectId: randomUUID() }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(file(aim, { householdId: randomUUID() }))).toEqual({ code: 'HOUSEHOLD_NOT_FOUND', status: 422, detail: 'household_id' });
      expect(await refusal(file(aim, {}, unitId(OTHER_BRANCH)))).toEqual({ code: 'HOUSEHOLD_NOT_FOUND', status: 422, detail: 'household_id' });
      expect(await refusal(file(aim, {}, NOWHERE))).toEqual({ code: 'HOUSEHOLD_NOT_FOUND', status: 422, detail: 'household_id' });
      expect(await refusal(file(aim, { projectId: world.otherProject }))).toEqual({ code: 'HOUSEHOLD_NOT_FOUND', status: 422, detail: 'household_id' });
      expect(await refusal(file(aim, { ownerUnitId: unitId(OTHER_BRANCH) }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'owner_unit_id' });
      expect(await refusal(file(aim, { planId: randomUUID() }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'plan_id' });
      expect(await owner('select 1 from machvon.land_complaint where household_id = $1::uuid', [aim.householdId])).toEqual([]);
      expect(await parcelStatus(aim.parcelIds[0] as string)).toBe('SURVEYED');
    });

    it('names a plan of the project when it names one', async () => {
      const aim = await target();
      const plan = await as((tx) =>
        tx.query<{ id: string }>(
          `insert into machvon.compensation_plan (tenant_id, id, project_id, executor_unit_id, executor_kind, plan_code, status, created_by, updated_by, version)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, 'LAND_FUND_CENTRE', $3, 'DRAFT', $4::uuid, $4::uuid, 1) returning id`,
          [world.project, unitId(DEPARTMENT), `PC-${counter}`, memberId(OFFICER)],
        ),
      );
      const other = await as((tx) =>
        tx.query<{ id: string }>(
          `insert into machvon.compensation_plan (tenant_id, id, project_id, executor_unit_id, executor_kind, plan_code, status, created_by, updated_by, version)
           values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, 'LAND_FUND_CENTRE', $3, 'DRAFT', $4::uuid, $4::uuid, 1) returning id`,
          [world.otherProject, unitId(DEPARTMENT), `PC-O-${counter}`, memberId(OFFICER)],
        ),
      );
      expect(await refusal(file(aim, { planId: (other[0] as { id: string }).id }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'plan_id' });
      const done = await file(aim, { planId: (plan[0] as { id: string }).id });
      expect((await owner<{ plan_id: string }>('select plan_id from machvon.land_complaint where id = $1::uuid', [done.id]))[0]?.plan_id).toBe((plan[0] as { id: string }).id);
    });

    it('does not count a deadline from a number it made up: no rule in force is 422 TIMER_RULE_UNCONFIRMED and nothing is filed, held or numbered', async () => {
      const aim = await target();
      await withoutRule('COMPLAINT_RESOLUTION', async () => {
        expect(await refusal(file(aim))).toMatchObject({ code: 'TIMER_RULE_UNCONFIRMED', status: 422 });
      });
      expect(await owner('select 1 from machvon.land_complaint where household_id = $1::uuid', [aim.householdId])).toEqual([]);
      expect(await parcelStatus(aim.parcelIds[0] as string)).toBe('SURVEYED');
    });
  });

  describe('answering', () => {
    it('AC-ST-LND-008-1, UAT-AC384: refuses an acceptance or a rejection without a reply document, and with one records it, ends the timer inside its days and gives the parcels back', async () => {
      const aim = await target({ parcels: 2 });
      const done = await file(aim);
      expect(await refusal(resolve(done.id, 1, { resolutionDocumentVersionId: undefined }))).toEqual({ code: 'DECISION_DOCUMENT_REQUIRED', status: 422, detail: 'resolution_document_version_id' });
      expect(await refusal(resolve(done.id, 1, { resolutionDocumentVersionId: randomUUID() }))).toEqual({ code: 'DECISION_DOCUMENT_REQUIRED', status: 422, detail: 'resolution_document_version_id' });
      expect(await refusal(resolve(done.id, 1, { resolutionDocumentVersionId: world.pendingDocument }))).toEqual({ code: 'DOCUMENT_NOT_CLEAN', status: 422, detail: 'resolution_document_version_id' });
      expect(await refusal(resolve(done.id, 1, { outcome: 'RESOLVED_REJECTED', resolutionDocumentVersionId: undefined }))).toMatchObject({ code: 'DECISION_DOCUMENT_REQUIRED' });
      expect((await rowOf(done.id))?.status).toBe('RECEIVED');
      for (const parcel of aim.parcelIds) expect(await parcelStatus(parcel)).toBe('DISPUTED');
      const answered = await resolve(done.id, 1);
      expect(answered).toMatchObject({ id: done.id, projectId: world.project, complaintNo: done.complaintNo, status: 'RESOLVED_ACCEPTED', fromStatus: 'RECEIVED', resolvedOn: '2026-10-10', dueOn: DUE, lateDays: 0, resolutionDocumentVersionId: world.cleanDocument, parcelsReleased: 2, version: 2 });
      expect(await rowOf(done.id)).toMatchObject({ status: 'RESOLVED_ACCEPTED', resolved_on: '2026-10-10', resolution_note: 'The price was checked again', resolution_document_version_id: world.cleanDocument, version: '2' });
      expect(await deadlineOf(done.id)).toMatchObject({ status: 'SATISFIED', satisfied_on: '2026-10-10' });
      for (const parcel of aim.parcelIds) expect(await parcelStatus(parcel)).toBe('SURVEYED');
      expect((await holdsOf(done.id)).every((hold) => hold.released)).toBe(true);
      expect(await refusal(resolve(done.id, 2))).toEqual({ code: 'COMPLAINT_STATE_INVALID', status: 409, detail: 'status', extensions: { status: 'RESOLVED_ACCEPTED' } });
    });

    it('records a rejection after the days, breaching the timer and counting the days late', async () => {
      const aim = await target();
      const done = await file(aim);
      const answered = await resolve(done.id, 1, { outcome: 'RESOLVED_REJECTED', resolvedOn: '2026-10-18' });
      expect(answered).toMatchObject({ status: 'RESOLVED_REJECTED', lateDays: 3, parcelsReleased: 1 });
      expect(await deadlineOf(done.id)).toMatchObject({ status: 'BREACHED', satisfied_on: null });
    });

    it('escalates with a note and no document, keeps the parcels held, records the answer of the higher level later, and does not escalate an escalated complaint again', async () => {
      const aim = await target();
      const done = await file(aim);
      const escalated = await resolve(done.id, 1, { outcome: 'ESCALATED', resolutionDocumentVersionId: undefined, resolvedOn: '2026-10-12' });
      expect(escalated).toMatchObject({ status: 'ESCALATED', fromStatus: 'RECEIVED', resolutionDocumentVersionId: null, parcelsReleased: 0 });
      expect(await deadlineOf(done.id)).toMatchObject({ status: 'SATISFIED', satisfied_on: '2026-10-12' });
      expect(await parcelStatus(aim.parcelIds[0] as string)).toBe('DISPUTED');
      expect(await refusal(resolve(done.id, 2, { outcome: 'ESCALATED', resolutionDocumentVersionId: undefined }))).toMatchObject({ code: 'COMPLAINT_STATE_INVALID', status: 409, extensions: { status: 'ESCALATED' } });
      const decided = await resolve(done.id, 2, { outcome: 'RESOLVED_REJECTED', resolvedOn: '2026-10-20' });
      expect(decided).toMatchObject({ status: 'RESOLVED_REJECTED', fromStatus: 'ESCALATED', parcelsReleased: 1, lateDays: 5 });
      // The timer had ended when it was escalated: the later answer does not change it.
      expect(await deadlineOf(done.id)).toMatchObject({ status: 'SATISFIED', satisfied_on: '2026-10-12' });
      expect(await parcelStatus(aim.parcelIds[0] as string)).toBe('SURVEYED');
    });

    it('gives a parcel back only when the last complaint that holds it lets it go', async () => {
      const aim = await target();
      await owner("update machvon.land_parcel set status = 'PLAN_POSTED' where id = $1::uuid", [aim.parcelIds[0]]);
      const first = await file(aim);
      const second = await file(aim);
      // The second complaint holds the parcel that the first holds, with the state the first found it in.
      expect(second.parcelsHeld).toBe(1);
      expect((await holdsOf(second.id)).map((hold) => hold.previous_status)).toEqual(['PLAN_POSTED']);
      expect((await resolve(first.id, 1)).parcelsReleased).toBe(0);
      expect(await parcelStatus(aim.parcelIds[0] as string)).toBe('DISPUTED');
      expect((await resolve(second.id, 1)).parcelsReleased).toBe(1);
      expect(await parcelStatus(aim.parcelIds[0] as string)).toBe('PLAN_POSTED');
    });

    it('wants the complaint in the units of the caller, the version they saw, an outcome, a day that is not before it was filed or after today, and words', async () => {
      const aim = await target();
      const done = await file(aim);
      expect(await refusal(resolve(randomUUID(), 1))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(resolve('x', 1))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'id' });
      expect(await refusal(resolve(done.id, 1, {}, unitId(OTHER_BRANCH)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(resolve(done.id, 1, {}, NOWHERE))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(resolve(done.id, 7))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(resolve(done.id, 1, { outcome: 'CLOSED' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'outcome' });
      for (const resolvedOn of ['2026-10-27', '2026-09-14', '2026-02-30']) expect(await refusal(resolve(done.id, 1, { resolvedOn }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'resolved_on' });
      for (const note of ['', '  ', 'x'.repeat(2001), 'a\u0007b']) expect(await refusal(resolve(done.id, 1, { note }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'note' });
      expect(await refusal(resolve(done.id, 1, { resolutionDocumentVersionId: 'x' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'resolution_document_version_id' });
      expect((await rowOf(done.id))?.status).toBe('RECEIVED');
    });
  });

  describe('reading', () => {
    it('lists the complaints of a project inside the units of the caller, by number, with the words, the filters and the cursor', async () => {
      const mine = await target();
      const elsewhere = await target({ unit: OTHER_BRANCH });
      const first = await file(mine, { description: 'First words' });
      const second = await as((tx) =>
        complaints.file(tx, { projectId: world.project, householdId: elsewhere.householdId, ownerUnitId: unitId(OTHER_BRANCH), channel: 'LETTER', subject: 'AREA', description: 'Second words', filedOn: FILED }, memberId(OFFICER), EVERYWHERE, TODAY),
      );
      await resolve(first.id, 1);
      const all = await as((tx) => complaints.list(tx, { projectId: world.project, limit: 100 }, EVERYWHERE));
      const ids = all.map((line) => line.id);
      expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
      const line = all.find((entry) => entry.id === first.id);
      expect(line).toMatchObject({
        projectId: world.project,
        householdId: mine.householdId,
        ownerUnitId: unitId(DEPARTMENT),
        complaintNo: first.complaintNo,
        filedOn: FILED,
        channel: 'MEETING',
        subject: 'PRICE',
        description: 'First words',
        status: 'RESOLVED_ACCEPTED',
        dueOn: DUE,
        resolvedOn: '2026-10-10',
        resolutionNote: 'The price was checked again',
        resolutionDocumentVersionId: world.cleanDocument,
        issueId: null,
        version: 2,
      });
      expect(line?.householdCode).toMatch(/^HH-\d{6}$/);
      expect((await as((tx) => complaints.list(tx, { projectId: world.project, limit: 100 }, unitId(DEPARTMENT)))).map((entry) => entry.id)).not.toContain(second.id);
      expect(await as((tx) => complaints.list(tx, { projectId: world.project, limit: 100 }, NOWHERE))).toEqual([]);
      expect((await as((tx) => complaints.list(tx, { projectId: world.project, status: 'RECEIVED', limit: 100 }, EVERYWHERE))).map((entry) => entry.id)).toContain(second.id);
      expect((await as((tx) => complaints.list(tx, { projectId: world.project, status: 'RECEIVED', limit: 100 }, EVERYWHERE))).map((entry) => entry.id)).not.toContain(first.id);
      const page = await as((tx) => complaints.list(tx, { projectId: world.project, limit: 1 }, EVERYWHERE));
      expect(page).toHaveLength(1);
      const next = await as((tx) => complaints.list(tx, { projectId: world.project, limit: 1, after: { code: (page[0] as { complaintNo: string }).complaintNo, id: (page[0] as { id: string }).id } }, EVERYWHERE));
      expect(next[0]?.id).not.toBe(page[0]?.id);
      expect(await refusal(as((tx) => complaints.list(tx, { projectId: world.project, status: 'LOST', limit: 10 }, EVERYWHERE)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'status' });
      expect(await refusal(as((tx) => complaints.list(tx, { projectId: world.project, limit: 0 }, EVERYWHERE)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'limit' });
      expect(await refusal(as((tx) => complaints.list(tx, { projectId: 'x', limit: 10 }, EVERYWHERE)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'project_id' });
    });

    it('tells where a complaint lies for whoever reaches its unit and nobody else', async () => {
      const aim = await target();
      const done = await file(aim);
      expect(await as((tx) => complaints.place(tx, done.id, EVERYWHERE))).toEqual({ projectId: world.project });
      expect(await as((tx) => complaints.place(tx, done.id, unitId(OTHER_BRANCH)))).toBeUndefined();
      expect(await as((tx) => complaints.place(tx, randomUUID(), EVERYWHERE))).toBeUndefined();
      expect(await refusal(as((tx) => complaints.place(tx, 'x', EVERYWHERE)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'id' });
    });
  });

  describe('the issue of ISS', () => {
    it('AC-ST-LND-008-1, UAT-AC384: asks the intake for an issue with the number of the complaint and nothing the complainant said, and the complaint remembers the issue that is opened', async () => {
      const aim = await target();
      const done = await file(aim, { description: 'Nguyễn Văn A says that his house is too cheap' });
      const payload = complaintFiledPayload(done, TENANT_A, new Date('2026-10-26T01:00:00Z'));
      expect(payload).toEqual({
        tenant_id: TENANT_A,
        source_ref_id: done.id,
        reference_code: done.complaintNo,
        project_id: world.project,
        owner_unit_id: unitId(DEPARTMENT),
        complaint_id: done.id,
        subject: 'PRICE',
        due_on: DUE,
        status: 'RECEIVED',
        occurred_at: '2026-10-26T01:00:00.000Z',
        source_module: 'LND',
      });
      expect(JSON.stringify(payload)).not.toContain('Nguyễn');
      expect(JSON.stringify(payload)).not.toContain(aim.householdId);
      const reading = readIntake('lnd.complaint.filed.v1', payload);
      expect(reading).toMatchObject({ kind: 'REQUEST', request: { sourceRefId: done.id, projectId: world.project, ownerUnitId: unitId(DEPARTMENT), referenceCode: done.complaintNo, referenceReplaced: false } });
      // The intake acts for the system, in a transaction that reaches no unit until it says so: the link is still written.
      const issue = randomUUID();
      await asAdmin([
        [
          `insert into machvon.issue
             (tenant_id, id, code, project_id, category_version_id, severity, title, description, owner_unit_id, sla_policy_id, assignee_id, opened_at, response_due_at, due_at, reported_by, source_module, source_ref_id, status, version)
           values ($1::uuid, $2::uuid, 'VM-2026-000001', $3::uuid, $4::uuid, 'MEDIUM', 'Land complaint filed: LC-000001', 'Land complaint filed: LC-000001 (LND, LAND_CLEARANCE)', $6::uuid, gen_random_uuid(), $5::uuid, now(), now(), now() + interval '3 days', $5::uuid, 'LND', $7::uuid, 'OPEN', 1)`,
          [TENANT_A, issue, world.project, world.ward, memberId(OFFICER), unitId(DEPARTMENT), done.id],
        ],
      ]);
      await as((tx) => linkComplaintIssue(tx, done.id, issue));
      expect((await rowOf(done.id))?.issue_id).toBe(issue);
      await as(async (tx) => {
        await tx.query("select set_config('app.scope_units', 'u-before', true)");
        await linkComplaintIssue(tx, done.id, issue);
        expect((await tx.query<{ scope: string }>("select current_setting('app.scope_units') as scope"))[0]?.scope).toBe('u-before');
      });
    });
  });

  describe('what the database keeps whoever writes', () => {
    it('keeps what a complaint says, the moves of its status and the answer that was given, and never deletes it', async () => {
      const aim = await target();
      const done = await file(aim);
      const update = (assignment: string) => sqlState(owner(`update machvon.land_complaint set ${assignment} where id = $1::uuid`, [done.id]));
      expect((await update("description = 'Rewritten'")).message).toContain('what a complaint says is never changed');
      expect((await update(`due_on = date '${addCalendarDays(DUE, 5)}'`)).message).toContain('what a complaint says is never changed');
      expect((await update("subject = 'AREA'")).message).toContain('what a complaint says is never changed');
      expect((await update("status = 'CLOSED'")).message).toContain('this move of the status is not allowed');
      expect((await update("status = 'RESOLVED_ACCEPTED'")).sqlstate).toBe('23514');
      await owner("update machvon.land_complaint set status = 'UNDER_REVIEW' where id = $1::uuid", [done.id]);
      await resolve(done.id, 1);
      expect((await update("resolution_note = 'Rewritten'")).message).toContain('an answer is not rewritten');
      expect((await update("status = 'RECEIVED'")).message).toContain('this move of the status is not allowed');
      await owner("update machvon.land_complaint set status = 'CLOSED' where id = $1::uuid", [done.id]);
      expect((await rowOf(done.id))?.status).toBe('CLOSED');
      expect((await sqlState(as((tx) => tx.query('delete from machvon.land_complaint where id = $1::uuid', [done.id])))).message).toContain('permission denied');
      expect((await sqlState(as((tx) => tx.query('delete from machvon.land_complaint_hold where complaint_id = $1::uuid', [done.id])))).message).toContain('permission denied');
    });

    it('files a complaint only for a household of its project and unit, received, with a number in the form of one and a status that holds what it should', async () => {
      const aim = await target();
      const elsewhere = await target({ unit: OTHER_BRANCH });
      const insert = (household: string, unit: string, extra: { status?: string; no?: string; plan?: string | null; resolved?: boolean } = {}) =>
        sqlState(
          owner(
            `insert into machvon.land_complaint
               (tenant_id, id, project_id, household_id, plan_id, owner_unit_id, complaint_no, filed_on, channel, subject, description, status, due_on, resolved_on, resolved_by, resolution_note, created_by, updated_by)
             values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, date '2026-09-15', 'LETTER', 'PRICE', 'Words', $6, date '2026-10-15', $7::date, $8::uuid, $9, $10::uuid, $10::uuid)`,
            [
              world.project,
              household,
              extra.plan ?? null,
              unit,
              extra.no ?? 'LC-900001',
              extra.status ?? 'RECEIVED',
              extra.resolved === true ? '2026-10-10' : null,
              extra.resolved === true ? memberId(OFFICER) : null,
              extra.resolved === true ? 'Note' : null,
              memberId(OFFICER),
            ],
          ),
        );
      expect((await insert(aim.householdId, unitId(OTHER_BRANCH))).message).toContain('a complaint belongs to the unit and the project of its household');
      expect((await insert(elsewhere.householdId, unitId(DEPARTMENT))).message).toContain('a complaint belongs to the unit and the project of its household');
      expect((await insert(aim.householdId, unitId(DEPARTMENT), { status: 'UNDER_REVIEW' })).message).toContain('a complaint is received first');
      expect((await insert(aim.householdId, unitId(DEPARTMENT), { no: 'LC-1' })).message).toContain('land_complaint_text_chk');
      expect((await insert(aim.householdId, unitId(DEPARTMENT), { no: 'LC-900002', resolved: true })).message).toContain('land_complaint_status_chk');
      const mine = await target({ unit: DEPARTMENT });
      expect((await sqlState(owner('update machvon.land_complaint_counter set last_no = 0 where project_id = $1::uuid', [world.project]))).message).toContain('land_complaint_counter_last_no_check');
      expect(mine.householdId).not.toBe(aim.householdId);
    });

    it('shows a held parcel only inside the unit of the complaint and counts the complaints of a project without a view of the rows', async () => {
      const aim = await target();
      const done = await file(aim);
      expect(await owner('select 1 from machvon.land_complaint_hold where complaint_id = $1::uuid', [done.id], unitId(DEPARTMENT))).toHaveLength(1);
      expect(await owner('select 1 from machvon.land_complaint_hold where complaint_id = $1::uuid', [done.id], unitId(OTHER_BRANCH))).toHaveLength(0);
      expect(await owner('select 1 from machvon.land_complaint_hold where complaint_id = $1::uuid', [done.id], NOWHERE)).toHaveLength(0);
      expect(await owner('select machvon.parcel_held_by_another($1::uuid, $2::uuid) as held', [aim.parcelIds[0], randomUUID()], NOWHERE)).toEqual([{ held: true }]);
      expect(await owner('select machvon.parcel_held_by_another($1::uuid, $2::uuid) as held', [aim.parcelIds[0], done.id], NOWHERE)).toEqual([{ held: false }]);
      expect(await harness.owner(TENANT_B, [['select machvon.parcel_held_by_another($1::uuid, $2::uuid) as held', [aim.parcelIds[0], randomUUID()]]])).toEqual([{ held: false }]);
      expect(await owner('select last_no from machvon.land_complaint_counter where project_id = $1::uuid', [world.project], NOWHERE)).toHaveLength(1);
    });
  });
});
