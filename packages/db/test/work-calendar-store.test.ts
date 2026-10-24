import { randomUUID } from 'node:crypto';
import { addWorkingTime } from '@machvon/kernel';
import type { WorkCalendarContent } from '@machvon/kernel';
import { WorkCalendarStore, calendarCursorKey } from '../src/work-calendar-store';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const AUTHOR = memberId(1);
const PUBLISHER = memberId(2);
const STD_2026: WorkCalendarContent = {
  calendar_code: 'VN-STD',
  year: 2026,
  working_days: [1, 2, 3, 4, 5],
  holidays: [
    { date: '2026-04-30', name: 'Reunification Day' },
    { date: '2026-05-01', name: 'Labour Day' },
  ],
  compensated_workdays: [],
  legal_basis_ref: 'Labour Code 2019 art. 112',
};
const STD_2027: WorkCalendarContent = { ...STD_2026, year: 2027, holidays: [{ date: '2027-01-01', name: 'New Year' }] };

describe('WorkCalendarStore (ST-ADM-010)', () => {
  const harness = new AuthzHarness();
  const store = new WorkCalendarStore();
  const asA = <T>(work: Parameters<typeof harness.tenants.withTenant<T>>[1]): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, AUTHOR), work);
  const asB = <T>(work: Parameters<typeof harness.tenants.withTenant<T>>[1]): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_B, AUTHOR), work);

  const draft = (content: WorkCalendarContent = STD_2026): Promise<{ id: string; revision: number; version: number }> => asA((tx) => store.createDraft(tx, content, AUTHOR));
  const publish = (id: string, publisher = PUBLISHER): Promise<{ version: number; supersededId: string | undefined }> =>
    asA(async (tx) => store.publish(tx, await store.lockDraft(tx, id, 1), publisher));
  const publishedCount = async (): Promise<string | undefined> =>
    (await harness.owner<{ n: string }>(TENANT_A, [["select count(*) as n from machvon.work_calendar_version where status = 'Published'", []]]))[0]?.n;

  beforeAll(async () => {
    await harness.start();
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  afterEach(async () => {
    await harness.owner(TENANT_A, [['delete from machvon.work_calendar_version', []]]);
    await harness.owner(TENANT_B, [['delete from machvon.work_calendar_version', []]]);
  });

  it('numbers the drafts of a calendar year 1, 2, 3 without gaps, even when created in parallel, and each year on its own', async () => {
    const created = await Promise.all([draft(), draft(), draft()]);
    expect(created.map((row) => row.revision).sort()).toEqual([1, 2, 3]);
    expect((await draft(STD_2027)).revision).toBe(1);
    expect((await draft({ ...STD_2026, calendar_code: 'OTHER' })).revision).toBe(1);
    expect((await draft()).revision).toBe(4);
  });

  it('stores a draft as Draft at version 1 with its content, and a draft is never the calendar in force', async () => {
    const { id } = await draft();
    expect(await asA((tx) => store.find(tx, id))).toMatchObject({ status: 'Draft', version: 1, revision: 1, content: STD_2026, createdBy: AUTHOR, publishedBy: null, publishedAt: null });
    expect(await asA((tx) => store.published(tx, 'VN-STD', 2026))).toBeUndefined();
  });

  it('keeps a list of compensated days that was left out as an empty list', async () => {
    const withoutCompensated: WorkCalendarContent = { calendar_code: 'VN-STD', year: 2026, working_days: [1, 2, 3, 4, 5], holidays: [], legal_basis_ref: 'Labour Code 2019 art. 112' };
    const { id } = await draft(withoutCompensated);
    expect((await asA((tx) => store.find(tx, id)))?.content.compensated_workdays).toEqual([]);
  });

  it('publishes a draft with the publisher and the time, and makes it the calendar in force for its year only', async () => {
    const { id } = await draft();
    expect((await publish(id)).version).toBe(2);
    const row = await asA((tx) => store.find(tx, id));
    expect(row).toMatchObject({ status: 'Published', publishedBy: PUBLISHER, version: 2 });
    expect(row?.publishedAt).not.toBeNull();
    expect((await asA((tx) => store.published(tx, 'VN-STD', 2026)))?.id).toBe(id);
    expect(await asA((tx) => store.published(tx, 'VN-STD', 2027))).toBeUndefined();
  });

  it('supersedes the version in force for the same calendar year when the next one is published, and leaves the other years alone', async () => {
    const first = await draft();
    await publish(first.id);
    const other = await draft(STD_2027);
    await publish(other.id);
    const second = await draft({ ...STD_2026, holidays: [{ date: '2026-05-01', name: 'Labour Day' }] });
    expect((await publish(second.id)).supersededId).toBe(first.id);
    expect((await asA((tx) => store.find(tx, first.id)))?.status).toBe('Superseded');
    expect((await asA((tx) => store.published(tx, 'VN-STD', 2026)))?.id).toBe(second.id);
    expect((await asA((tx) => store.published(tx, 'VN-STD', 2027)))?.id).toBe(other.id);
    expect(await publishedCount()).toBe('2');
  });

  it('serialises two publications at the same time: both succeed and exactly one version of the year stays Published', async () => {
    const first = await draft();
    const second = await draft();
    await Promise.all([publish(first.id), publish(second.id)]);
    expect(await publishedCount()).toBe('1');
    const statuses = await Promise.all([first, second].map(async ({ id }) => (await asA((tx) => store.find(tx, id)))?.status));
    expect(statuses.sort()).toEqual(['Published', 'Superseded']);
  });

  it('answers 404 for a missing calendar, 409 VERSION_CONFLICT for a stale version and 409 STAGE_TRANSITION_DENIED for one already published', async () => {
    await expect(asA((tx) => store.lockDraft(tx, randomUUID(), 1))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    const { id } = await draft();
    await expect(asA((tx) => store.lockDraft(tx, id, 9))).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
    await publish(id);
    await expect(asA((tx) => store.lockDraft(tx, id, 2))).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
  });

  describe('the calendars in force as a set for addWorkingTime (XM-ADM-01)', () => {
    it('counts a deadline across two published years, and holds no year further than three years from the first', async () => {
      await publish((await draft({ ...STD_2026, holidays: [] })).id);
      await publish((await draft(STD_2027)).id);
      const start = new Date('2026-12-31T16:00:00+07:00');
      const both = await asA((tx) => store.source(tx, 'VN-STD', 2026));
      expect(addWorkingTime(both, start, { hours: 2 }).toISOString()).toBe(new Date('2027-01-04T09:00:00+07:00').toISOString());
      await publish((await draft({ ...STD_2026, holidays: [], year: 2030 })).id);
      const window = await asA((tx) => store.source(tx, 'VN-STD', 2026));
      expect(window.forYear(2028)).toBeUndefined();
      expect(window.forYear(2030)).toBeUndefined();
    });

    it('holds only the published versions of the calendar asked for: a draft, a superseded version and another calendar are not in it', async () => {
      const first = await draft();
      await publish(first.id);
      const second = await draft({ ...STD_2026, working_days: [1, 2, 3, 4] });
      await publish(second.id);
      await draft({ ...STD_2026, working_days: [1] });
      await publish((await draft({ ...STD_2026, calendar_code: 'OTHER' })).id);
      const source = await asA((tx) => store.source(tx, 'VN-STD', 2026));
      expect(source.forYear(2026)?.working_days).toEqual([1, 2, 3, 4]);
    });

    it('counts a deadline by the version published when it is counted: the next publication changes later deadlines only', async () => {
      await publish((await draft()).id);
      const start = new Date('2026-04-29T15:00:00+07:00');
      const before = addWorkingTime(await asA((tx) => store.source(tx, 'VN-STD', 2026)), start, { hours: 8 });
      expect(before.toISOString()).toBe(new Date('2026-05-04T15:00:00+07:00').toISOString());
      await publish((await draft({ ...STD_2026, holidays: [] })).id);
      const after = addWorkingTime(await asA((tx) => store.source(tx, 'VN-STD', 2026)), start, { hours: 8 });
      expect(after.toISOString()).toBe(new Date('2026-04-30T15:00:00+07:00').toISOString());
      expect(before.toISOString()).toBe(new Date('2026-05-04T15:00:00+07:00').toISOString());
    });
  });

  it('lists the newest year first, then the calendar code and the revision, and pages by that key', async () => {
    const ids = [
      (await draft(STD_2026)).id,
      (await draft(STD_2027)).id,
      (await draft({ ...STD_2026, calendar_code: 'OTHER' })).id,
      (await draft(STD_2026)).id,
    ];
    const all = await asA((tx) => store.list(tx, { limit: 10, after: undefined }));
    expect(all.map((row) => [row.content.year, row.content.calendar_code, row.revision])).toEqual([
      [2027, 'VN-STD', 1],
      [2026, 'VN-STD', 2],
      [2026, 'VN-STD', 1],
      [2026, 'OTHER', 1],
    ]);
    const first = await asA((tx) => store.list(tx, { limit: 2, after: undefined }));
    const last = first[1] as (typeof all)[number];
    const rest = await asA((tx) => store.list(tx, { limit: 10, after: { code: calendarCursorKey(last), id: last.id } }));
    expect(rest.map((row) => row.id)).toEqual(all.slice(2).map((row) => row.id));
    expect(ids).toHaveLength(4);
    await expect(asA((tx) => store.list(tx, { limit: 2, after: { code: 'x', id: randomUUID() } }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'cursor' });
  });

  it('keeps tenants apart', async () => {
    expect(await asB((tx) => store.list(tx, { limit: 10, after: undefined }))).toEqual([]);
    const { id } = await draft();
    await publish(id);
    expect(await asB((tx) => store.find(tx, id))).toBeUndefined();
    expect(await asB((tx) => store.published(tx, 'VN-STD', 2026))).toBeUndefined();
    expect((await asB((tx) => store.source(tx, 'VN-STD', 2026))).forYear(2026)).toBeUndefined();
    await expect(asB((tx) => store.lockDraft(tx, id, 1))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect((await asB((tx) => store.createDraft(tx, STD_2026, AUTHOR))).revision).toBe(1);
  });

  describe('database guards', () => {
    it('keeps a version immutable: content, identity and author cannot change, even for the owner role', async () => {
      const { id } = await draft();
      for (const [sql, params] of [
        ["update machvon.work_calendar_version set holidays = '[]'::jsonb where id = $1", [id]],
        ["update machvon.work_calendar_version set working_days = '[1]'::jsonb where id = $1", [id]],
        ["update machvon.work_calendar_version set compensated_workdays = '[\"2026-05-09\"]'::jsonb where id = $1", [id]],
        ["update machvon.work_calendar_version set legal_basis_ref = 'x' where id = $1", [id]],
        ["update machvon.work_calendar_version set calendar_code = 'X' where id = $1", [id]],
        ['update machvon.work_calendar_version set year = 2027 where id = $1', [id]],
        ['update machvon.work_calendar_version set revision = revision + 10 where id = $1', [id]],
        ['update machvon.work_calendar_version set created_by = $2 where id = $1', [id, PUBLISHER]],
      ] as Array<[string, unknown[]]>) {
        await expect(harness.owner(TENANT_A, [[sql, params]])).rejects.toMatchObject({ code: '23514' });
      }
    });

    it('lets a Published version only become Superseded, and a Superseded one never change again', async () => {
      const { id } = await draft();
      await publish(id);
      await expect(harness.owner(TENANT_A, [["update machvon.work_calendar_version set status = 'Draft' where id = $1", [id]]])).rejects.toMatchObject({ code: '23514' });
      await expect(harness.owner(TENANT_A, [['update machvon.work_calendar_version set published_by = $2 where id = $1', [id, AUTHOR]]])).rejects.toMatchObject({ code: '23514' });
      await harness.owner(TENANT_A, [["update machvon.work_calendar_version set status = 'Superseded' where id = $1", [id]]]);
      await expect(harness.owner(TENANT_A, [["update machvon.work_calendar_version set status = 'Published' where id = $1", [id]]])).rejects.toMatchObject({ code: '23514' });
    });

    it('never lets a draft be superseded, or published without a publisher', async () => {
      const { id } = await draft();
      await expect(harness.owner(TENANT_A, [["update machvon.work_calendar_version set status = 'Superseded' where id = $1", [id]]])).rejects.toMatchObject({ code: '23514' });
      await expect(harness.owner(TENANT_A, [["update machvon.work_calendar_version set status = 'Published' where id = $1", [id]]])).rejects.toMatchObject({ code: '23514' });
    });

    it('refuses a second Published version of a calendar year', async () => {
      const first = await draft();
      const second = await draft();
      await publish(first.id);
      await expect(
        harness.owner(TENANT_A, [["update machvon.work_calendar_version set status = 'Published', published_by = $2, published_at = now() where id = $1", [second.id, PUBLISHER]]]),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('refuses content that is not a list', async () => {
      await expect(
        harness.owner(TENANT_A, [
          [
            `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by)
             values (current_setting('app.tenant_id')::uuid, $1, 'BAD', 2026, 1, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'x', 'Draft', $2)`,
            [randomUUID(), AUTHOR],
          ],
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('does not let the application role delete a version', async () => {
      const { id } = await draft();
      await expect(asA((tx) => tx.query('delete from machvon.work_calendar_version where id = $1::uuid', [id]))).rejects.toMatchObject({ code: '42501' });
    });
  });
});
