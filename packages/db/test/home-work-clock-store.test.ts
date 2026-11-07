import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { HomeWorkActionStore } from '../src/home-work-action-store';
import { HomeWorkClockStore } from '../src/home-work-clock-store';
import { WorkPolicyReader } from '../src/home-work-policy';
import { HomeWorkReminderStore, reminderSeriesKey } from '../src/home-work-reminder-store';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const clocks = new HomeWorkClockStore();
const actions = new HomeWorkActionStore();
const reminders = new HomeWorkReminderStore();
const policies = new WorkPolicyReader();

const ROOT = 1;
const NORTH = 2;
const LEADER = 1;
const OFFICER = 2;
// Thursday 2027-10-14, 08:00 in Vietnam.
const START = new Date('2027-10-14T01:00:00Z');
const NOW = new Date('2027-10-15T03:00:00Z');

const as = <T>(work: (tx: Parameters<Parameters<typeof harness.tenants.withTenant>[1]>[0]) => Promise<T>, tenant = TENANT_A, member = LEADER): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);

async function admin(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

const calendar = (tenant: string, year: number): [string, unknown[]] => [
  `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
   values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`,
  [tenant, year, memberId(LEADER)],
];

const input = (over: Record<string, unknown> = {}) => ({
  clockType: 'EGP_POSTING',
  subjectType: 'procurement_package',
  subjectId: randomUUID(),
  title: 'Post the invitation to bid',
  ownerMembershipId: memberId(OFFICER),
  severity: 'ACTION' as const,
  expectedAction: 'Post the notice on the national bidding network.',
  consequence: 'A package whose notice is not posted in time cannot open the bidding.',
  startedAt: START,
  workingMinutes: 660,
  targetScreen: 'BID-02',
  targetId: 'pkg-1',
  createdBy: memberId(LEADER),
  ...over,
});

/** The stores behind the clocks of the alert centre: the policies through the governance port, the native clocks, the decisions about an item, the reminders (lane GOV-2). */
describe('the stores of the clocks of the alert centre', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: NORTH, path: `/${unitId(ROOT)}/${unitId(NORTH)}/`, parent: ROOT },
      ]);
      await harness.seedMembership(tenant, LEADER, ROOT);
      await harness.seedMembership(tenant, OFFICER, NORTH);
    }
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the policies', () => {
    it('are the default of the platform with the version builtin, flagged as not confirmed, until a rule is approved', async () => {
      const read = await as((tx) => policies.read(tx, '2027-10-15'));
      expect(read.versions).toEqual({ snooze: 'builtin', clock: 'builtin', reminder: 'builtin' });
      expect(read.unverified).toEqual({ snooze: true, clock: true, reminder: true });
      expect(read.snooze).toMatchObject({ max_consecutive: 2, max_days_by_severity: { URGENT: 0, ACTION: 3, WATCH: 14 } });
      expect(read.clock).toMatchObject({ max_pause_days: 30, claim_within_working_hours: { URGENT: 2, ACTION: 8, WATCH: 24 } });
      expect(read.reminder).toMatchObject({ every_working_hours: { URGENT: 4, ACTION: 8, WATCH: 40 } });
    });

    it('come from the approved rule in force on the day, with its version, and only from the tenant that approved it', async () => {
      const params = { reasons: ['WAITING_INFORMATION', 'OTHER'], note_required_for: ['OTHER'], max_days_by_severity: { URGENT: 0, ACTION: 1, WATCH: 2 }, max_consecutive: 1, final_notifies_next_level: false };
      await admin([
        [
          `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
           values ($1, 'SNOOZE_POLICY', 'DEFAULT', 3, 'APPROVED', $2::jsonb, '2027-10-01', 'Tighter snoozing', $3, $3, now(), $4, now())`,
          [TENANT_A, JSON.stringify(params), memberId(LEADER), memberId(OFFICER)],
        ],
      ]);
      expect((await as((tx) => policies.read(tx, '2027-10-15'))).snooze).toMatchObject({ max_consecutive: 1, final_notifies_next_level: false });
      expect((await as((tx) => policies.read(tx, '2027-10-15'))).versions.snooze).toBe('v3');
      expect((await as((tx) => policies.read(tx, '2027-09-30'))).versions.snooze).toBe('builtin');
      expect((await as((tx) => policies.read(tx, '2027-10-15'), TENANT_B)).versions.snooze).toBe('builtin');
    });
  });

  describe('a native clock', () => {
    beforeAll(() => admin([calendar(TENANT_A, 2027), calendar(TENANT_A, 2028), calendar(TENANT_A, 2029), calendar(TENANT_A, 2030)]));

    it('ends where the working time counted on the published calendar ends, and keeps the versions it read', async () => {
      const { clock, created } = await as((tx) => clocks.start(tx, input()));
      expect(created).toBe(true);
      // Thursday 08:00 plus 11 working hours (08:00-12:00 and 13:00-17:00): Friday 11:00.
      expect(clock).toMatchObject({ status: 'RUNNING', dueAt: '2027-10-15T04:00:00.000Z', startedAt: START.toISOString(), workingMinutes: 660, calendarCode: 'WORKDAY_VN', policyVersion: 'builtin', severity: 'ACTION' });
      expect(clock.calendarVersionIds.length).toBeGreaterThanOrEqual(1);
    });

    it('is started once for a subject: starting it again gives the clock that runs', async () => {
      const subjectId = randomUUID();
      const one = await as((tx) => clocks.start(tx, input({ subjectId })));
      const two = await as((tx) => clocks.start(tx, input({ subjectId, workingMinutes: 60 })));
      expect([one.created, two.created, two.clock.id, two.clock.workingMinutes]).toEqual([true, false, one.clock.id, 660]);
      const [a, b] = await Promise.all([as((tx) => clocks.start(tx, input({ subjectId: 'same' }))), as((tx) => clocks.start(tx, input({ subjectId: 'same' })))]);
      expect(a.clock.id).toBe(b.clock.id);
      expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    });

    it('refuses a clock nobody answers for, without an expected action or a consequence, and one whose year has no published calendar', async () => {
      await expect(as((tx) => clocks.start(tx, input({ ownerMembershipId: undefined })))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(as((tx) => clocks.start(tx, input({ expectedAction: 'x' })))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(as((tx) => clocks.start(tx, input({ consequence: '' })))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(as((tx) => clocks.start(tx, input({ workingMinutes: 0 })))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      // Tenant B published no calendar: the clock cannot be counted, so it is not started.
      await expect(as((tx) => clocks.start(tx, input()), TENANT_B)).rejects.toMatchObject({ code: 'CALENDAR_NOT_EFFECTIVE' });
      // A start in 2031 needs the calendar of 2031, which is not published: refused, never guessed.
      await expect(as((tx) => clocks.start(tx, input({ startedAt: new Date('2031-03-03T01:00:00Z') })))).rejects.toMatchObject({ code: 'CALENDAR_NOT_EFFECTIVE' });
    });

    it('is ended once as MET or CANCELLED with who and why, never deleted, and is another tenant’s business to read none of', async () => {
      const { clock } = await as((tx) => clocks.start(tx, input()));
      expect(await as((tx) => clocks.find(tx, clock.id), TENANT_B)).toBeUndefined();
      const ended = await as((tx) => clocks.end(tx, clock.id, 'MET', memberId(OFFICER), 'Posted on the portal.'));
      expect(ended).toMatchObject({ status: 'MET', endReason: 'Posted on the portal.', version: 2 });
      expect(ended.endedAt).not.toBeNull();
      await expect(as((tx) => clocks.end(tx, clock.id, 'CANCELLED', memberId(OFFICER), 'Again'))).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED' });
      await expect(as((tx) => clocks.end(tx, randomUUID(), 'MET', memberId(OFFICER), 'Nothing'))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      await expect(as((tx) => tx.query('delete from machvon.work_clock where id = $1', [clock.id]))).rejects.toThrow(/permission denied/);
      await expect(as((tx) => tx.query('update machvon.work_clock set due_at = now() where id = $1', [clock.id]))).rejects.toThrow(/permission denied/);
      // The same subject can start a new clock once the old one ended.
      const again = await as((tx) => clocks.start(tx, input({ subjectId: clock.subjectId })));
      expect(again.created).toBe(true);
      const byKey = await as((tx) => clocks.endBySubject(tx, { clockType: 'EGP_POSTING', subjectType: 'procurement_package', subjectId: clock.subjectId }, 'CANCELLED', memberId(LEADER), 'The package was withdrawn.'));
      expect(byKey).toMatchObject({ id: again.clock.id, status: 'CANCELLED' });
      expect(await as((tx) => clocks.endBySubject(tx, { clockType: 'EGP_POSTING', subjectType: 'procurement_package', subjectId: 'nothing' }, 'MET', memberId(LEADER), 'None'))).toBeUndefined();
    });
  });

  describe('the decisions about an item', () => {
    const itemId = `item-${randomUUID()}`;
    const record = (action: 'CLAIM' | 'ASSIGN' | 'SNOOZE' | 'PAUSE_CLOCK' | 'RESUME_CLOCK', over: Record<string, unknown> = {}, member = LEADER) =>
      as((tx) =>
        actions.record(tx, {
          source: 'EARLY_WARNING',
          sourceId: itemId,
          action,
          actor: memberId(member),
          ...(action === 'SNOOZE' ? { reasonCode: 'WAITING_INFORMATION', snoozeOrdinal: 1, snoozeFinal: false, policyVersion: 'builtin' } : {}),
          ...over,
        }),
      );
    const state = async (reader = LEADER) => (await as((tx) => actions.stateOf(tx, [{ source: 'EARLY_WARNING', sourceId: itemId }], memberId(reader), NOW))).get(`EARLY_WARNING:${itemId}`);

    it('counts the postponements in a row, by anyone, until a claim or a handover starts the count again', async () => {
      await record('SNOOZE', { snoozeUntil: '2027-10-16T05:00:00.000Z', reason: 'Waiting for the bank.' });
      await record('SNOOZE', { snoozeUntil: '2027-10-17T05:00:00.000Z', snoozeOrdinal: 2, snoozeFinal: true }, OFFICER);
      expect(await state()).toMatchObject({ consecutiveSnoozes: 2, snooze: { by: { id: memberId(OFFICER) }, ordinal: 2, final: true, reasonCode: 'WAITING_INFORMATION', policyVersion: 'builtin' } });
      await record('CLAIM', {}, OFFICER);
      expect(await state()).toMatchObject({ consecutiveSnoozes: 0, claimedBy: { id: memberId(OFFICER) } });
      await record('SNOOZE', { snoozeUntil: '2027-10-18T05:00:00.000Z' });
      await record('ASSIGN', { assignee: memberId(OFFICER), dueOn: '2027-10-20' });
      expect(await state()).toMatchObject({ consecutiveSnoozes: 0 });
    });

    it('keeps the first and the latest claim, so that a claim again moves the latest only', async () => {
      const first = (await state())?.firstClaimAt;
      const claim = await record('CLAIM');
      const after = await state();
      expect(after?.firstClaimAt).toBe(first);
      expect(after?.lastClaimAt).toBe(claim.createdAt);
    });

    it('holds a pause with who allowed it and why, and a resume ends the latest pause that still holds', async () => {
      await record('PAUSE_CLOCK', { pausedUntil: '2999-01-01T00:00:00.000Z', reasonCode: 'FORCE_MAJEURE', reason: 'The office was closed by the storm', allowedBy: memberId(OFFICER) });
      let held = await state();
      expect(held?.pauses).toHaveLength(1);
      expect(held?.pauses[0]).toMatchObject({ reasonCode: 'FORCE_MAJEURE', reason: 'The office was closed by the storm', allowedBy: { id: memberId(OFFICER), name: 'User 2' }, by: { id: memberId(LEADER) }, resumedAt: null, until: '2999-01-01T00:00:00.000Z' });
      const resume = await record('RESUME_CLOCK');
      held = await state();
      expect(held?.pauses[0]?.resumedAt).toBe(resume.createdAt);
    });

    it('refuses by the table a pause that names its author as the one who allowed it, one with no reason, and a postponement without its series', async () => {
      await expect(record('PAUSE_CLOCK', { pausedUntil: '2999-01-01T00:00:00.000Z', reasonCode: 'OTHER', reason: 'Self allowed', allowedBy: memberId(LEADER) })).rejects.toThrow(/work_action_shape_chk/);
      await expect(record('PAUSE_CLOCK', { pausedUntil: '2999-01-01T00:00:00.000Z', allowedBy: memberId(OFFICER) })).rejects.toThrow(/work_action_shape_chk/);
      await expect(record('RESUME_CLOCK', { allowedBy: memberId(OFFICER) })).rejects.toThrow(/work_action_shape_chk/);
      await expect(record('SNOOZE', { snoozeUntil: '2027-10-16T05:00:00.000Z', reasonCode: undefined })).rejects.toThrow(/work_action_snooze_governed_chk/);
      await expect(record('SNOOZE', { snoozeUntil: '2027-10-16T05:00:00.000Z', reasonCode: 'not a code' })).rejects.toThrow(/reason_code/);
      await expect(record('CLAIM', { snoozeOrdinal: 1 })).rejects.toThrow(/work_action_governed_only_chk/);
    });
  });

  describe('the reminders', () => {
    const subject = `item-${randomUUID()}`;
    const make = (ordinal: number, over: Record<string, unknown> = {}) =>
      as((tx) =>
        reminders.record(tx, {
          source: 'EARLY_WARNING',
          sourceId: subject,
          kind: 'REMINDER',
          audience: 'OWNER',
          recipient: memberId(LEADER),
          severity: 'ACTION',
          ordinal,
          seriesKey: reminderSeriesKey('EARLY_WARNING', subject, memberId(LEADER), ordinal),
          dueAt: NOW,
          cadenceWorkingHours: 8,
          policyVersion: 'builtin',
          ...over,
        }),
      );

    it('records each reminder once for a series, counts them for the person, and keeps the notices to the next level apart', async () => {
      const one = await make(1);
      const again = await make(1);
      expect([one.created, again.created, again.id]).toEqual([true, false, one.id]);
      await make(2);
      await make(1, { kind: 'RECLAIM_NOTICE', audience: 'NEXT_LEVEL', seriesKey: `RECLAIM:EARLY_WARNING:${subject}:x`, ordinal: 1 });
      const keys = [{ source: 'EARLY_WARNING', sourceId: subject }];
      const sent = await as((tx) => reminders.summary(tx, keys, memberId(LEADER)));
      expect(sent.get(`EARLY_WARNING:${subject}`)).toMatchObject({ sent: 2 });
      expect((await as((tx) => reminders.summary(tx, keys, memberId(OFFICER)))).size).toBe(0);
      const notices = await as((tx) => reminders.notices(tx, keys));
      expect(notices.get(`EARLY_WARNING:${subject}`)).toEqual([{ kind: 'RECLAIM_NOTICE', at: expect.any(String) }]);
    });

    it('is appended and never changed, tells the owner reminder from the notice, and is one tenant’s business', async () => {
      await expect(as((tx) => tx.query("update machvon.work_reminder set severity = 'WATCH'"))).rejects.toThrow(/permission denied/);
      await expect(as((tx) => tx.query('delete from machvon.work_reminder'))).rejects.toThrow(/permission denied/);
      await expect(make(9, { kind: 'REMINDER', audience: 'NEXT_LEVEL', seriesKey: 'bad-audience' })).rejects.toThrow(/work_reminder_audience_chk/);
      await expect(make(9, { kind: 'SNOOZE_FINAL_NOTICE', audience: 'OWNER', seriesKey: 'bad-audience-2' })).rejects.toThrow(/work_reminder_audience_chk/);
      expect(await as((tx) => tx.query('select 1 from machvon.work_reminder'), TENANT_B)).toHaveLength(0);
    });
  });
});
