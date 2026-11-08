import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, HomeWorkClockStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { assertPushPayloadSafe, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import type { PushPayload } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { AlertCoverController } from '../../src/modules/home/alert-cover.controller';
import { runAlertCoverage } from '../../src/modules/home/alert-coverage.job';
import { AlertEscalationController } from '../../src/modules/home/alert-escalation.controller';
import { runAlertEscalation } from '../../src/modules/home/alert-escalation.job';
import { AlertHealthController } from '../../src/modules/home/alert-health.controller';
import { AlertProfileController } from '../../src/modules/home/alert-profile.controller';
import { MyWorkController } from '../../src/modules/home/my-work.controller';
import { HOME_CLOCK } from '../../src/modules/home/tokens';
import { WorkActionController } from '../../src/modules/home/work-action.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(300_000);

const SIGNING_KEY = randomBytes(32);
const LEADER = 1; // leadership of the whole tenant, manages covers and reads the health
const OFFICER = 2; // a member of the north who owns the alerts
const DEPUTY = 3; // a peer of the officer
const NORTH_LEADER = 4; // leadership of the north, manages covers of the north
const AUDITOR = 5; // the function that the second level of an urgent alert names
const AWAY = 6; // another member of the north
const NOBODY = 7; // a member who holds no right at all
const ROOT = 1;
const NORTH = 2;
const SOUTH = 3;
// Friday 2027-10-15, 10:00 in Vietnam.
const NOW = new Date('2027-10-15T03:00:00Z');
const THURSDAY_08 = new Date('2027-10-14T01:00:00Z');

/** The body of an answer as `JSON.parse` types it (loosely): the checks below read it by the names of the contract and prove each value with an assertion. */
type Json = ReturnType<typeof JSON.parse>;

interface Reply {
  status: number;
  json: Json;
}

/** The governance of the alert system over HTTP and through the two jobs: the chain of escalation, the cover of an absent person, the profile of a person, the health page (roadmap G2-3, G2-5, G2-7, G2-10). */
describe('the governance of the alert system', () => {
  const harness = new AuthzHarness();
  const clocks = new HomeWorkClockStore();
  let app: RunningApp;
  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST' | 'PUT', url: string, options: { member: number; body?: unknown; key?: string; version?: number }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.version !== undefined) headers['if-match'] = `"${options.version}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Json };
  }
  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
  async function admin(work: (client: Client) => Promise<void>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await work(client);
    } finally {
      await client.end();
    }
  }
  const wipe = (): Promise<void> =>
    admin(async (client) => {
      for (const table of ['outbox_event', 'audit_event', 'alert_notification_log', 'alert_notification_profile', 'alert_routing_gap', 'alert_escalation', 'alert_item_trace', 'alert_absence_cover', 'alert_absence', 'work_reminder', 'work_action', 'work_clock']) {
        await client.query(`delete from machvon.${table}`);
      }
    });
  const tenants = (): TenantDatabase => harness.tenants as TenantDatabase;
  const jobContext = { tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 1 };
  const runEscalation = (now = NOW): ReturnType<typeof runAlertEscalation> => runAlertEscalation(tenants(), jobContext, now);
  const runCoverage = (now = NOW): ReturnType<typeof runAlertCoverage> => runAlertCoverage(tenants(), jobContext, now);

  /** A native clock of the officer: past its time (urgent, nobody took it up) when started Thursday morning, or due within the day (to be acted on) when started this morning. */
  const clock = (owner: number, over: Record<string, unknown> = {}): Promise<string> =>
    tenants().withTenant({ tenantId: TENANT_A, membershipId: memberId(LEADER), scopeVersion: 1 }, async (tx) => {
      const { clock: started } = await clocks.start(tx, {
        clockType: 'EGP_POSTING',
        subjectType: 'procurement_package',
        subjectId: randomUUID(),
        title: 'Post the invitation to bid',
        subtitle: 'Package 05',
        ownerMembershipId: memberId(owner),
        severity: 'ACTION',
        expectedAction: 'Post the notice on the national bidding network.',
        consequence: 'A package whose notice is not posted in time cannot open the bidding.',
        startedAt: THURSDAY_08,
        workingMinutes: 480,
        targetScreen: 'BID-02',
        targetId: 'pkg-5',
        createdBy: memberId(LEADER),
        ...over,
      });
      return started.id;
    });
  const dueToday = (owner: number): Promise<string> => clock(owner, { startedAt: new Date('2027-10-15T01:30:00Z'), workingMinutes: 120 });
  const list = (member: number, query = ''): Promise<Reply> => call('GET', `/home/my-work${query}`, { member });
  const items = (reply: Reply): Json[] => reply.json.items as Json[];

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: NORTH, path: `/${unitId(ROOT)}/${unitId(NORTH)}/`, parent: ROOT },
      { n: SOUTH, path: `/${unitId(ROOT)}/${unitId(SOUTH)}/`, parent: ROOT },
    ]);
    await harness.seedMembership(TENANT_A, LEADER, ROOT);
    await harness.seedMembership(TENANT_A, OFFICER, NORTH);
    await harness.seedMembership(TENANT_A, DEPUTY, NORTH);
    await harness.seedMembership(TENANT_A, NORTH_LEADER, NORTH);
    await harness.seedMembership(TENANT_A, AUDITOR, ROOT);
    await harness.seedMembership(TENANT_A, AWAY, NORTH);
    await harness.seedMembership(TENANT_A, NOBODY, SOUTH);
    await harness.seedRole(TENANT_A, 1, 'LEADER', ['home.read', 'home.alert.health.read', 'home.alert.cover.manage'], 60);
    await harness.seedRole(TENANT_A, 2, 'HOME_READER', ['home.read'], 40);
    await harness.seedRole(TENANT_A, 3, 'AUDITOR', ['home.read'], 25);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: LEADER, role: 1, kind: 'TENANT' },
      { n: 2, member: OFFICER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(NORTH)] },
      { n: 3, member: DEPUTY, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(NORTH)] },
      { n: 4, member: NORTH_LEADER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(NORTH)] },
      { n: 5, member: AUDITOR, role: 3, kind: 'TENANT' },
      { n: 6, member: AWAY, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(NORTH)] },
    ]);
    // The published working calendars of the years the clocks pass through.
    for (const year of [2026, 2027, 2028]) {
      await admin(async (client) => {
        await client.query(
          `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
           values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019, Article 112', 'Published', $3, $3, $4)`,
          [TENANT_A, year, memberId(LEADER), NOW.toISOString()],
        );
      });
    }
    const database = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database }), PolicyModule.register({ database, access: new EffectiveAccessStore(database, new InMemoryAuthzCache()) })],
      controllers: [MyWorkController, WorkActionController, AlertHealthController, AlertEscalationController, AlertProfileController, AlertCoverController],
      providers: [
        { provide: TenantDatabase, useValue: database },
        { provide: HOME_CLOCK, useValue: () => NOW },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  });

  beforeEach(wipe);

  describe('the chain of escalation (G2-3)', () => {
    it('sends an urgent item that nobody took up along its levels, to the leadership of the owner and then to the function, once each', async () => {
      const item = await clock(OFFICER);
      const first = await runEscalation();
      expect(first).toMatchObject({ escalations: 2, failed: 0 });
      const levels = await rows<{ level: number; kind: string; trigger: string; recipient_membership_id: string; owner_membership_id: string; routed_via: string; status: string; item_title: string }>(
        'select level, kind, trigger, recipient_membership_id, owner_membership_id, routed_via, status, item_title from machvon.alert_escalation order by level',
      );
      // Level 1: the leadership of the north (the nearest tier above the officer); level 2: the holder of the function AUDITOR, four working hours after.
      expect(levels).toEqual([
        { level: 1, kind: 'HIERARCHICAL', trigger: 'NOT_CLAIMED', recipient_membership_id: memberId(NORTH_LEADER), owner_membership_id: memberId(OFFICER), routed_via: 'PRIMARY', status: 'OPEN', item_title: 'Post the invitation to bid' },
        { level: 2, kind: 'FUNCTIONAL', trigger: 'NOT_CLAIMED', recipient_membership_id: memberId(AUDITOR), owner_membership_id: memberId(OFFICER), routed_via: 'PRIMARY', status: 'OPEN', item_title: 'Post the invitation to bid' },
      ]);
      // Idempotent: the pass again records nothing, and no event is written twice.
      expect(await runEscalation()).toMatchObject({ escalations: 0 });
      expect(await rows('select 1 from machvon.alert_escalation')).toHaveLength(2);
      const events = await rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where type = 'home.alert_escalated.v1' order by created_at");
      expect(events).toHaveLength(2);
      // No event carries a word of anybody: ids and codes only.
      for (const event of events) expect(JSON.stringify(event.payload)).not.toContain('Post the invitation');
      expect(events[0]?.payload).toMatchObject({ source: 'CLOCK', source_id: item, level: 1, kind: 'HIERARCHICAL', trigger: 'NOT_CLAIMED', severity: 'URGENT', recipient_membership_id: memberId(NORTH_LEADER) });
    });

    it('shows the chain on the card of the item and the level that was sent up as an item of the alert centre of its recipient, and of nobody else', async () => {
      const item = await clock(OFFICER);
      await runEscalation();
      const card = items(await list(OFFICER)).find((row) => row.id === item);
      expect(card).toMatchObject({ source: 'CLOCK', severity: 'URGENT', escalation: { level: 3, of: 4, next_at: '2027-10-15T08:00:00.000Z' } });
      expect(card?.escalation.chain).toHaveLength(4);
      expect(card?.escalation.chain[2]).toContain('AUDITOR');
      const received = items(await list(NORTH_LEADER)).find((row) => row.source === 'ESCALATION');
      expect(received).toMatchObject({ kind: 'ESCALATED_ITEM', severity: 'URGENT', lifecycle: 'NEW', target: { screen: 'BID-02', id: 'pkg-5' } });
      expect(received?.title).toContain('Post the invitation to bid');
      expect(received?.consequence).toBeTruthy();
      expect(items(await list(OFFICER)).some((row) => row.source === 'ESCALATION')).toBe(false);
      expect(items(await list(AUDITOR)).some((row) => row.source === 'ESCALATION')).toBe(true);
    });

    it('lets the recipient acknowledge once, refuses another person, and keeps the audit row and the event', async () => {
      await clock(OFFICER);
      await runEscalation();
      const [level1] = await rows<{ id: string }>('select id from machvon.alert_escalation where level = 1');
      const id = (level1 as { id: string }).id;
      expect((await call('POST', `/home/alert-escalations/${id}/acknowledge`, { member: OFFICER })).status).toBe(404);
      expect((await call('POST', '/home/alert-escalations/not-an-id/acknowledge', { member: NORTH_LEADER })).status).toBe(404);
      const key = `ack-${randomUUID()}`;
      const done = await call('POST', `/home/alert-escalations/${id}/acknowledge`, { member: NORTH_LEADER, key });
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'ACKNOWLEDGED', resource_id: id });
      expect((await call('POST', `/home/alert-escalations/${id}/acknowledge`, { member: NORTH_LEADER, key })).json).toEqual(done.json);
      const again = await call('POST', `/home/alert-escalations/${id}/acknowledge`, { member: NORTH_LEADER });
      expect([again.status, again.json.code]).toEqual([409, 'ALERT_ESCALATION_STATE_INVALID']);
      expect(await rows("select 1 from machvon.audit_event where action = 'home.alert_escalation_acknowledged'")).toHaveLength(1);
      expect(await rows("select 1 from machvon.outbox_event where type = 'home.alert_escalation_acknowledged.v1'")).toHaveLength(1);
      // The acknowledged level shows in the item of the recipient as taken up.
      expect(items(await list(NORTH_LEADER)).find((row) => row.source === 'ESCALATION')).toMatchObject({ lifecycle: 'CLAIMED' });
    });

    it('lists the monitor for the people who read the health in the units they may read, and refuses the others', async () => {
      await clock(OFFICER);
      await runEscalation();
      const all = await call('GET', '/home/alert-escalations', { member: LEADER });
      expect(all.status).toBe(200);
      expect(all.json.items).toHaveLength(2);
      expect(all.json.items.map((row: { level: number; kind: string }) => `${row.level}:${row.kind}`).sort()).toEqual(['1:HIERARCHICAL', '2:FUNCTIONAL']);
      expect(all.json.rule).toMatchObject({ code: 'DEFAULT', version: 'builtin', unverified: true });
      expect(all.json.rule.params.steps.URGENT).toHaveLength(3);
      expect((await call('GET', '/home/alert-escalations', { member: NORTH_LEADER })).json.items).toHaveLength(2);
      expect((await call('GET', '/home/alert-escalations', { member: OFFICER })).status).toBe(403);
      expect((await call('GET', '/home/alert-escalations?status=closed', { member: LEADER })).status).toBe(422);
    });

    it('does not send up an item that was taken up, one that is only to be watched, or one that was resolved; and closes the levels when the item is gone', async () => {
      // Time left (two days), so the only thing that can send it up is that nobody took it up; the claim is stamped at the moment of the test.
      const taken = await clock(OFFICER, { workingMinutes: 960 + 480 });
      const watched = await clock(OFFICER, { severity: 'WATCH', startedAt: new Date('2027-10-15T02:00:00Z'), workingMinutes: 2400 });
      const claim = await call('POST', '/home/work-actions/claim', { member: OFFICER, body: { source: 'CLOCK', source_id: taken } });
      expect(claim.status).toBe(200);
      await admin(async (client) => void (await client.query("update machvon.work_action set created_at = '2027-10-15T02:30:00Z'")));
      expect(await runEscalation()).toMatchObject({ escalations: 0 });
      expect(await rows('select 1 from machvon.alert_escalation')).toHaveLength(0);
      expect(watched).not.toBe(taken);
      // The item that nobody takes up goes up (its claim time of 8 working hours ran out on Thursday); once its clock is ended in its module the levels close with it.
      const lone = await clock(OFFICER, { workingMinutes: 960 + 480 });
      await runEscalation();
      expect(await rows("select 1 from machvon.alert_escalation where status = 'OPEN'")).toHaveLength(1);
      await admin(async (client) => void (await client.query("update machvon.work_clock set status = 'MET', ended_at = now(), end_reason = 'Posted', ended_by_membership_id = $2 where id = $1", [lone, memberId(OFFICER)])));
      await runEscalation(new Date(NOW.getTime() + 15 * 60_000));
      expect(await rows("select close_reason from machvon.alert_escalation where status = 'CLOSED'")).toEqual([{ close_reason: 'SOURCE_CLEARED' }]);
    });

    it('raises an item that was only to be watched and aged untouched, with the reason, once', async () => {
      const item = await clock(OFFICER, { severity: 'WATCH', startedAt: new Date('2027-09-15T01:00:00Z'), workingMinutes: 144000 });
      await runEscalation();
      const [promotion] = await rows<{ kind: string; trigger: string; severity: string; from_severity: string; level: number }>("select kind, trigger, severity, from_severity, level from machvon.alert_escalation where kind = 'PROMOTION'");
      expect(promotion).toEqual({ kind: 'PROMOTION', trigger: 'WATCH_AGED', severity: 'ACTION', from_severity: 'WATCH', level: 0 });
      await runEscalation();
      expect(await rows("select 1 from machvon.alert_escalation where kind = 'PROMOTION'")).toHaveLength(1);
      expect(items(await list(OFFICER)).find((row) => row.id === item)).toMatchObject({ severity: 'ACTION', promoted_from: 'WATCH' });
    });
  });

  describe('absences and covers (G2-7)', () => {
    const declare = (member: number, over: Record<string, unknown> = {}, actor = member): Promise<Reply> =>
      call('POST', '/home/alert-absences', { member: actor, body: { ...(actor === member ? {} : { membership_id: memberId(member) }), kind: 'LEAVE', valid_from: NOW.toISOString(), valid_until: new Date(NOW.getTime() + 5 * 86_400_000).toISOString(), reason: 'Annual leave', ...over } });
    const propose = (absenceId: string, deputy: number, actor: number, over: Record<string, unknown> = {}): Promise<Reply> =>
      call('POST', `/home/alert-absences/${absenceId}/covers`, { member: actor, body: { deputy_id: memberId(deputy), valid_from: NOW.toISOString(), valid_until: new Date(NOW.getTime() + 5 * 86_400_000).toISOString(), scope_kind: 'ALL', ...over } });

    it('declares an absence, refuses what is not valid with the field, and keeps others out of the absences of people they do not manage', async () => {
      const mine = await declare(OFFICER);
      expect(mine.status).toBe(200);
      expect(mine.json).toMatchObject({ status: 'Declared', resource_version: 1 });
      const overlap = await declare(OFFICER, { valid_from: new Date(NOW.getTime() + 86_400_000).toISOString() });
      expect([overlap.status, overlap.json.code]).toEqual([409, 'ALERT_ABSENCE_OVERLAP']);
      const bad = await declare(DEPUTY, { valid_until: new Date(NOW.getTime() - 86_400_000).toISOString() });
      expect([bad.status, bad.json.code, bad.json.field ?? bad.json.detail]).toEqual([422, 'ALERT_ABSENCE_INVALID', 'valid_until']);
      // A kind that is not in the contract does not reach the rules at all.
      expect((await declare(DEPUTY, { kind: 'HOLIDAY' })).status).toBe(422);
      // Somebody who does not manage covers cannot declare for another person; a manager of the unit can, and one of another unit cannot.
      expect((await declare(AWAY, {}, OFFICER)).status).toBe(403);
      expect((await declare(AWAY, {}, NORTH_LEADER)).status).toBe(200);
      expect((await declare(NOBODY, {}, NORTH_LEADER)).status).toBe(403);
      // The absences of others are for the people who manage covers, in the units they may read.
      expect((await call('GET', '/home/alert-absences', { member: OFFICER })).status).toBe(403);
      const managed = await call('GET', '/home/alert-absences', { member: NORTH_LEADER });
      expect(managed.json.items.map((absence: { membership_id: string }) => absence.membership_id).sort()).toEqual([memberId(AWAY), memberId(OFFICER)].sort());
      expect((await call('GET', '/home/alert-absences?mine=true', { member: OFFICER })).json.items).toHaveLength(1);
      expect(await rows("select 1 from machvon.audit_event where action = 'home.alert_absence_declared'")).toHaveLength(2);
    });

    it('proposes a cover that waits, allowed by a third person only, and routes the alerts of the absent person to the deputy once it is in force', async () => {
      const absence = (await declare(OFFICER)).json.resource_id as string;
      const proposed = await propose(absence, DEPUTY, OFFICER);
      expect(proposed.status).toBe(200);
      const cover = proposed.json.resource_id as string;
      // The deputy is not yet the receiver: the cover waits for its allowance.
      const item = await dueToday(OFFICER);
      await runEscalation();
      expect(await rows("select 1 from machvon.alert_notification_log where recipient_membership_id = $1 and channel = 'PUSH'", [memberId(DEPUTY)])).toHaveLength(0);
      expect(items(await list(DEPUTY)).some((row) => row.id === item)).toBe(false);
      // The proposer cannot allow it (he has no right to), a manager who is not the proposer can; a manager cannot allow a cover that he proposed himself.
      expect((await call('POST', `/home/alert-covers/${cover}/decision`, { member: OFFICER, version: 1, body: { decision: 'APPROVE' } })).status).toBe(403);
      const second = await propose(absence, LEADER, NORTH_LEADER, { scope_kind: 'SOURCES', sources: ['ISSUE'] });
      expect(second.status).toBe(200);
      const own = await call('POST', `/home/alert-covers/${second.json.resource_id}/decision`, { member: NORTH_LEADER, version: 1, body: { decision: 'APPROVE' } });
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      const stale = await call('POST', `/home/alert-covers/${cover}/decision`, { member: NORTH_LEADER, version: 9, body: { decision: 'APPROVE' } });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const allowed = await call('POST', `/home/alert-covers/${cover}/decision`, { member: NORTH_LEADER, version: 1, body: { decision: 'APPROVE', note: 'Agreed' } });
      expect(allowed.status).toBe(200);
      expect(allowed.json).toMatchObject({ status: 'APPROVED', resource_version: 2 });
      expect((await call('POST', `/home/alert-covers/${cover}/decision`, { member: NORTH_LEADER, version: 2, body: { decision: 'REJECT' } })).json.code).toBe('ALERT_COVER_STATE_INVALID');

      // In force: the next pass tells the deputy, not the absent person, and the item is on the list of the deputy with whose it is.
      const newer = await dueToday(OFFICER);
      await runEscalation();
      const notices = await rows<{ recipient_membership_id: string; channel: string; decision: string; severity: string }>("select recipient_membership_id, channel, decision, severity from machvon.alert_notification_log where source_id = $1", [newer]);
      expect(notices).toEqual([{ recipient_membership_id: memberId(DEPUTY), channel: 'PUSH', decision: 'SEND_NOW', severity: 'ACTION' }]);
      const covered = items(await list(DEPUTY)).find((row) => row.id === newer);
      expect(covered).toMatchObject({ source: 'CLOCK', on_behalf_of: { id: memberId(OFFICER) } });
      // The deputy takes it up, and the item shows it was taken up on the list of the absent person too.
      expect((await call('POST', '/home/work-actions/claim', { member: DEPUTY, body: { source: 'CLOCK', source_id: newer } })).status).toBe(200);
      expect(items(await list(OFFICER)).find((row) => row.id === newer)).toMatchObject({ lifecycle: 'CLAIMED' });
      // The digest of the deputy holds it in the section of what they stand in for.
      const digest = await call('GET', '/me/alert-digest', { member: DEPUTY });
      expect(digest.status).toBe(200);
      expect(digest.json.sections.find((section: { code: string }) => section.code === 'ON_BEHALF').lines.map((line: { id: string }) => line.id)).toContain(newer);
      // The listing of the person shows the cover and how well it covers.
      const mine = (await call('GET', '/home/alert-absences?mine=true', { member: OFFICER })).json;
      expect(mine.items[0]).toMatchObject({ phase: 'ACTIVE', coverage: 'COVERED' });
      expect(mine.items[0].covers.find((one: { id: string }) => one.id === cover)).toMatchObject({ status: 'APPROVED', in_force: true });
      // The absent person is back: the cover is revoked and the item goes back to its owner.
      const revoked = await call('POST', `/home/alert-covers/${cover}/revoke`, { member: OFFICER, version: 2, body: { reason: 'Back at work' } });
      expect(revoked.status).toBe(200);
      // What the deputy took up stays theirs (the one who took an item up keeps it), but it is no longer held on behalf of the absent person.
      expect(items(await list(DEPUTY)).find((row) => row.id === newer)).toMatchObject({ on_behalf_of: null });
      expect(await rows("select 1 from machvon.audit_event where action in ('home.alert_cover_proposed', 'home.alert_cover_decided', 'home.alert_cover_revoked')")).toHaveLength(4);
    });

    it('refuses a cover that loops, goes to oneself or to a deputy of lower rank, and one that lies outside the absence', async () => {
      const absence = (await declare(NORTH_LEADER, {}, NORTH_LEADER)).json.resource_id as string;
      const codes = async (reply: Reply): Promise<[number, string, string]> => [reply.status, reply.json.code, reply.json.field ?? reply.json.detail];
      expect(await codes(await propose(absence, NORTH_LEADER, NORTH_LEADER))).toEqual([422, 'ALERT_COVER_INVALID', 'deputy_id']);
      // A leader cannot be covered by a deputy of lower rank.
      expect(await codes(await propose(absence, OFFICER, NORTH_LEADER))).toEqual([422, 'ALERT_COVER_INVALID', 'deputy_id']);
      expect(await codes(await propose(absence, LEADER, NORTH_LEADER, { valid_until: new Date(NOW.getTime() + 30 * 86_400_000).toISOString() }))).toEqual([422, 'ALERT_COVER_INVALID', 'valid_until']);
      expect(await codes(await propose(absence, LEADER, NORTH_LEADER, { scope_kind: 'SOURCES', sources: ['LUNCH'] }))).toEqual([422, 'ALERT_COVER_INVALID', 'sources']);
      const fine = await propose(absence, LEADER, NORTH_LEADER);
      expect(fine.status).toBe(200);
      // The leader of the tenant is away too and names the leader of the north: the two would cover each other.
      const away = (await declare(LEADER, {}, LEADER)).json.resource_id as string;
      expect(await codes(await propose(away, NORTH_LEADER, LEADER))).toEqual([422, 'ALERT_COVER_INVALID', 'deputy_id']);
      // Not found for somebody who may not act for the person.
      expect((await propose(absence, LEADER, OFFICER)).status).toBe(404);
      expect((await propose(randomUUID(), LEADER, LEADER)).status).toBe(404);
    });

    it('ends an absence early, which revokes the covers that are still live, and refuses it twice', async () => {
      const absence = await declare(OFFICER);
      const cover = (await propose(absence.json.resource_id, DEPUTY, OFFICER)).json.resource_id as string;
      const done = await call('POST', `/home/alert-absences/${absence.json.resource_id}/end`, { member: OFFICER, version: 1, body: { status: 'ENDED', reason: 'Back early' } });
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'ENDED', resource_version: 2 });
      expect(await rows('select status from machvon.alert_absence_cover where id = $1', [cover])).toEqual([{ status: 'REVOKED' }]);
      const again = await call('POST', `/home/alert-absences/${absence.json.resource_id}/end`, { member: OFFICER, version: 2, body: { status: 'ENDED', reason: 'Back early' } });
      expect([again.status, again.json.code]).toEqual([409, 'ALERT_ABSENCE_STATE_INVALID']);
      expect((await call('POST', `/home/alert-absences/${absence.json.resource_id}/end`, { member: NOBODY, version: 2, body: { status: 'ENDED', reason: 'Not mine' } })).status).toBe(403);
    });

    it('sends the alerts of an absent person with no cover up at once, opens a gap after the allowance, shows it to the managers, and closes it when somebody covers', async () => {
      const away = await declare(AWAY, { valid_from: new Date(NOW.getTime() - 24 * 3_600_000).toISOString() }, LEADER);
      expect(away.status).toBe(200);
      const item = await dueToday(AWAY);
      await runEscalation();
      // The item goes up by the orphan step, at once: the leadership of the north receives it, saying why.
      const [row] = await rows<{ level: number; trigger: string; recipient_membership_id: string }>("select level, trigger, recipient_membership_id from machvon.alert_escalation where source_id = $1", [item]);
      expect(row).toEqual({ level: 1, trigger: 'ORPHANED', recipient_membership_id: memberId(NORTH_LEADER) });
      const later = NOW;
      expect(await runCoverage(later)).toMatchObject({ opened: 1, closed: 0 });
      const [gap] = await rows<{ kind: string; item_count: number; membership_id: string; closed_at: Date | null }>('select kind, item_count, membership_id, closed_at from machvon.alert_routing_gap');
      expect(gap).toMatchObject({ kind: 'ABSENT_NO_COVER', item_count: 1, membership_id: memberId(AWAY), closed_at: null });
      expect(await runCoverage(later)).toMatchObject({ opened: 0 });
      // The managers see it as an alert of the alert centre and in the coverage report, and the health page counts it as orphaned.
      expect(items(await list(NORTH_LEADER)).find((one) => one.source === 'COVERAGE')).toMatchObject({ kind: 'COVERAGE_GAP', severity: 'ACTION', target: { screen: 'ADM-28' } });
      expect(items(await list(OFFICER)).some((one) => one.source === 'COVERAGE')).toBe(false);
      const report = await call('GET', '/home/alert-coverage', { member: LEADER });
      expect(report.status).toBe(200);
      expect(report.json.gaps).toMatchObject([{ kind: 'ABSENT_NO_COVER', item_count: 1, closed_at: null }]);
      const health = await call('GET', '/home/alert-health', { member: LEADER });
      expect(health.json.kpis.find((kpi: { code: string }) => kpi.code === 'ORPHAN')).toMatchObject({ value: 1, status: 'BREACH' });
      // A cover that is allowed closes the gap at the next pass.
      const proposed = await propose(away.json.resource_id, DEPUTY, LEADER, { valid_from: new Date(NOW.getTime() - 24 * 3_600_000).toISOString(), valid_until: new Date(NOW.getTime() + 86_400_000).toISOString() });
      expect(proposed.status).toBe(200);
      expect((await call('POST', `/home/alert-covers/${proposed.json.resource_id}/decision`, { member: NORTH_LEADER, version: 1, body: { decision: 'APPROVE' } })).status).toBe(200);
      expect(await runCoverage(later)).toMatchObject({ opened: 0, closed: 1 });
      expect(await rows("select close_reason from machvon.alert_routing_gap where closed_at is not null")).toEqual([{ close_reason: 'COVERED' }]);
    });
  });

  describe('the profile of a person (G2-5)', () => {
    it('reads the policy values for a person who saved none, and replaces the whole profile under its version', async () => {
      const fresh = await call('GET', '/me/alert-profile', { member: OFFICER });
      expect(fresh.status).toBe(200);
      expect(fresh.json).toMatchObject({ version: 0, effective: { push_cap_per_day: 5, digest_at: '07:30', push_min_severity: 'ACTION', quiet: { from: '21:00', to: '06:30', weekends: true } }, rule: { unverified: true, version: 'builtin' } });
      expect(fresh.json.effective.own.quiet).toBe(false);
      const body = { channels: { URGENT: ['IN_APP', 'PUSH', 'EMAIL'] }, quiet: { from: '22:00', to: '06:00', weekends: false, time_zone: 'Asia/Ho_Chi_Minh' }, digest_enabled: true, digest_at: '08:00', push_min_severity: 'URGENT', push_cap_per_day: 3, group_same_root: false };
      const saved = await call('PUT', '/me/alert-profile', { member: OFFICER, version: 0, body });
      expect(saved.status).toBe(200);
      expect(saved.json).toMatchObject({ resource_version: 1 });
      const stale = await call('PUT', '/me/alert-profile', { member: OFFICER, version: 0, body });
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const read = await call('GET', '/me/alert-profile', { member: OFFICER });
      expect(read.json).toMatchObject({ version: 1, effective: { push_cap_per_day: 3, digest_at: '08:00', push_min_severity: 'URGENT', own: { quiet: true, push_cap_per_day: true } } });
      expect(read.json.effective.channels.URGENT).toEqual(['IN_APP', 'PUSH', 'EMAIL']);
      const [audit] = await rows<{ diff: Record<string, unknown> }>("select safe_diff as diff from machvon.audit_event where action = 'home.alert_profile_updated'");
      expect(audit?.diff).toMatchObject({ channels_chosen: 3, quiet_hours: 'OWN', push_cap_per_day: 3, policy_version: 'builtin' });
      // Another person's profile is their own: the deputy still has the policy.
      expect((await call('GET', '/me/alert-profile', { member: DEPUTY })).json.version).toBe(0);
    });

    it('refuses a profile that takes the bell out, pushes an item to be watched, raises the cap above the policy or names a wrong hour, with every defect', async () => {
      const put = (body: Record<string, unknown>): Promise<Reply> => call('PUT', '/me/alert-profile', { member: OFFICER, version: 0, body: { digest_enabled: true, ...body } });
      const refusal = async (body: Record<string, unknown>): Promise<[number, string, string]> => {
        const reply = await put(body);
        return [reply.status, reply.json.code, reply.json.field ?? reply.json.detail];
      };
      expect(await refusal({ channels: { URGENT: ['PUSH'] } })).toEqual([422, 'ALERT_PROFILE_INVALID', 'channels.URGENT']);
      expect(await refusal({ channels: { WATCH: ['IN_APP', 'PUSH'] } })).toEqual([422, 'ALERT_PROFILE_INVALID', 'channels.WATCH']);
      expect(await refusal({ push_cap_per_day: 6 })).toEqual([422, 'ALERT_PROFILE_INVALID', 'push_cap_per_day']);
      expect(await refusal({ quiet: { from: '25:00', to: '06:00', weekends: true, time_zone: 'Asia/Ho_Chi_Minh' } })).toEqual([422, 'ALERT_PROFILE_INVALID', 'quiet.from']);
      expect(await refusal({ digest_at: '7:30' })).toEqual([422, 'ALERT_PROFILE_INVALID', 'digest_at']);
      const many = await put({ channels: { URGENT: ['PUSH'], WATCH: ['IN_APP', 'SMS'] }, push_cap_per_day: 9 });
      expect(many.json.defects.map((defect: { field: string }) => defect.field)).toEqual(['channels.URGENT', 'channels.WATCH', 'push_cap_per_day']);
      expect(await rows('select 1 from machvon.alert_notification_profile')).toHaveLength(0);
    });

    it('decides how each person is told: the bell is the list, a push goes only where the profile and the hour allow, and no push carries a word of the item', async () => {
      // The officer asks for pushes for urgent items only; the deputy keeps the policy.
      expect((await call('PUT', '/me/alert-profile', { member: OFFICER, version: 0, body: { digest_enabled: true, push_min_severity: 'URGENT' } })).status).toBe(200);
      const itemOfOfficer = await dueToday(OFFICER);
      const itemOfDeputy = await dueToday(DEPUTY);
      await runEscalation();
      const log = await rows<{ recipient_membership_id: string; source_id: string; channel: string; decision: string }>('select recipient_membership_id, source_id, channel, decision from machvon.alert_notification_log order by created_at, id');
      const of = (member: number, item: string): string[] => log.filter((row) => row.recipient_membership_id === memberId(member) && row.source_id === item).map((row) => `${row.channel}:${row.decision}`);
      expect(of(OFFICER, itemOfOfficer).sort()).toEqual(['DIGEST:DIGEST', 'PUSH:SKIP_THRESHOLD']);
      expect(of(DEPUTY, itemOfDeputy)).toEqual(['PUSH:SEND_NOW']);
      // The bell tells the truth whatever was decided: both items are on the lists.
      expect(items(await list(OFFICER)).some((row) => row.id === itemOfOfficer)).toBe(true);
      expect(items(await list(DEPUTY)).some((row) => row.id === itemOfDeputy)).toBe(true);
      // The one push that was sent is an event with a fixed sentence, a count and a path, and no word of the item.
      const events = await rows<{ payload: { push: PushPayload; recipient_membership_id: string } }>("select payload from machvon.outbox_event where type = 'home.alert_notice.v1' and payload->'push'->>'kind' = 'ITEM'");
      expect(events).toHaveLength(1);
      const push = events[0]?.payload.push as PushPayload;
      assertPushPayloadSafe(push);
      expect(JSON.stringify(events[0]?.payload.push)).not.toContain('Post the invitation');
      expect(push).toMatchObject({ kind: 'ITEM', severity: 'ACTION', count: 1, link: '/home/my-work' });
      // The pass again decides nothing twice.
      await runEscalation();
      expect(await rows('select 1 from machvon.alert_notification_log')).toHaveLength(log.length);
      expect(await rows("select 1 from machvon.outbox_event where type = 'home.alert_notice.v1' and payload->>'recipient_membership_id' = $1 and payload->'push'->>'kind' = 'ITEM'", [memberId(DEPUTY)])).toHaveLength(1);
    });

    it('holds a push for the quiet hours of the person and sends it once they are over; the urgent item that nobody took up in time is held too unless its type allows it', async () => {
      await dueToday(DEPUTY);
      // 22:30 in Vietnam on Friday is evening: held until the quiet ends (Monday, the weekend is quiet too), not sent.
      const evening = new Date('2027-10-15T15:30:00Z');
      await runEscalation(evening);
      const held = await rows<{ decision: string; hold_until: Date }>("select decision, hold_until from machvon.alert_notification_log where channel = 'PUSH' and occasion = 'NEW_ITEM' and recipient_membership_id = $1", [memberId(DEPUTY)]);
      expect(held.map((row) => row.decision)).toEqual(['HOLD_QUIET']);
      expect(held[0]?.hold_until.toISOString()).toBe('2027-10-17T23:30:00.000Z');
      expect(await rows("select 1 from machvon.outbox_event where type = 'home.alert_notice.v1' and payload->>'recipient_membership_id' = $1 and payload->'push'->>'kind' = 'ITEM'", [memberId(DEPUTY)])).toHaveLength(0);
      // Still quiet on Saturday: nothing is released; when Monday morning comes, the held notice goes, once.
      await runEscalation(new Date('2027-10-16T03:00:00Z'));
      expect(await rows("select 1 from machvon.outbox_event where type = 'home.alert_notice.v1' and payload->>'recipient_membership_id' = $1 and payload->'push'->>'kind' = 'ITEM'", [memberId(DEPUTY)])).toHaveLength(0);
      await runEscalation(new Date('2027-10-18T01:00:00Z'));
      expect(await rows("select 1 from machvon.outbox_event where type = 'home.alert_notice.v1' and payload->>'recipient_membership_id' = $1 and payload->'push'->>'kind' = 'ITEM'", [memberId(DEPUTY)])).toHaveLength(1);
      await runEscalation(new Date('2027-10-18T02:00:00Z'));
      expect(await rows("select 1 from machvon.outbox_event where type = 'home.alert_notice.v1' and payload->>'recipient_membership_id' = $1 and payload->'push'->>'kind' = 'ITEM'", [memberId(DEPUTY)])).toHaveLength(1);
    });

    it('composes the digest card of the person with the consequence of each line and where to act, and sends one digest a day at the hour of the person', async () => {
      const item = await clock(OFFICER);
      const digest = await call('GET', '/me/alert-digest', { member: OFFICER });
      expect(digest.status).toBe(200);
      const overdue = digest.json.sections.find((section: { code: string }) => section.code === 'OVERDUE');
      expect(overdue.lines.find((line: { id: string }) => line.id === item)).toMatchObject({ severity: 'URGENT', action: { screen: 'BID-02', id: 'pkg-5' } });
      expect(overdue.lines[0].consequence).toBeTruthy();
      expect(digest.json.digest_at).toBe('07:30');
      // Before the hour of the person nothing is sent; after it, one digest, and not a second one the same day.
      await runEscalation(new Date('2027-10-14T23:00:00Z'));
      expect(await rows("select 1 from machvon.alert_notification_log where occasion = 'DIGEST'")).toHaveLength(0);
      await runEscalation(new Date('2027-10-15T01:00:00Z'));
      await runEscalation(new Date('2027-10-15T02:00:00Z'));
      expect((await rows("select 1 from machvon.alert_notification_log where occasion = 'DIGEST' and recipient_membership_id = $1", [memberId(OFFICER)])).length).toBe(1);
    });
  });

  describe('the health of the alert system (G2-10)', () => {
    it('gives fourteen indicators with their formula, source and status, never zero for what has no data, and says when the recording job is old', async () => {
      const before = await call('GET', '/home/alert-health', { member: LEADER });
      expect(before.status).toBe(200);
      expect(before.json.kpis).toHaveLength(14);
      expect(before.json.stale).toBe(true);
      expect(before.json.last_pass_at).toBeNull();
      expect(before.json.kpis.find((kpi: { code: string }) => kpi.code === 'MTTA')).toMatchObject({ value: null, status: 'NO_DATA' });
      await clock(OFFICER);
      await dueToday(OFFICER);
      await runEscalation();
      const health = await call('GET', '/home/alert-health', { member: LEADER });
      expect(health.json.stale).toBe(false);
      expect(health.json.items).toMatchObject({ in_window: 2, open: 2 });
      expect(health.json.rule).toMatchObject({ code: 'DEFAULT', unverified: true, version: 'builtin' });
      const byCode = (code: string): Json => health.json.kpis.find((kpi: { code: string }) => kpi.code === code);
      expect(byCode('ESCALATED')).toMatchObject({ value: 50, sample: 2, unit: 'PERCENT', target: 20, status: 'BREACH' });
      expect(byCode('URGENT_DELIVERY')).toMatchObject({ value: null, status: 'NO_SOURCE', note: 'NO_DELIVERY_RECEIPTS' });
      expect(byCode('TOP10_SHARE')).toMatchObject({ value: 100 });
      expect(byCode('ALERTS_PER_PERSON').value).toBe(2);
      for (const kpi of health.json.kpis) {
        expect(kpi.formula.length).toBeGreaterThan(20);
        expect(kpi.source.length).toBeGreaterThan(10);
      }
      expect(health.json.top_types).toEqual([expect.objectContaining({ type_code: 'CLOCK', count: 2 })]);
      // The window is a number of days between 7 and 90.
      expect((await call('GET', '/home/alert-health?days=3', { member: LEADER })).status).toBe(422);
      expect((await call('GET', '/home/alert-health?days=30', { member: LEADER })).status).toBe(200);
    });

    it('follows the units the reader may read: the leader of the north sees the north, a unit outside is refused, and a reader without the permission is refused', async () => {
      await clock(OFFICER);
      await runEscalation();
      expect((await call('GET', '/home/alert-health', { member: NORTH_LEADER })).json.items.open).toBe(1);
      expect((await call('GET', `/home/alert-health?unit_id=${unitId(NORTH)}`, { member: NORTH_LEADER })).status).toBe(200);
      expect((await call('GET', `/home/alert-health?unit_id=${unitId(SOUTH)}`, { member: NORTH_LEADER })).status).toBe(403);
      expect((await call('GET', `/home/alert-health?unit_id=${unitId(SOUTH)}`, { member: LEADER })).json.items.open).toBe(0);
      expect((await call('GET', '/home/alert-health', { member: OFFICER })).status).toBe(403);
      expect((await call('GET', '/home/alert-coverage', { member: OFFICER })).status).toBe(403);
      expect((await call('GET', '/home/alert-health?unit_id=nope', { member: LEADER })).status).toBe(422);
    });
  });
});
