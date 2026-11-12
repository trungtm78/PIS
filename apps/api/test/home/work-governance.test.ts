import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, HomeWorkClockStore, HomeWorkReminderStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID, reminderSeriesKey } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { MyWorkController } from '../../src/modules/home/my-work.controller';
import { HOME_CLOCK } from '../../src/modules/home/tokens';
import { WorkActionClockController } from '../../src/modules/home/work-action-clock.controller';
import { WorkActionController } from '../../src/modules/home/work-action.controller';
import { runWorkReminders } from '../../src/modules/home/work-reminder.job';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const LEADER = 1; // reads the whole tenant
const MAKER = 2; // a member of the north
const OTHER = 3; // a member of the south
const NOBODY = 4; // holds no right to read HOME
const ROOT = 1;
const NORTH = 2;
const SOUTH = 3;
// Friday 2027-10-15, 10:00 in Vietnam.
const NOW = new Date('2027-10-15T03:00:00Z');
const TODAY = '2027-10-15';
const WHY = { reason_code: 'WAITING_INFORMATION' };

interface Reply {
  status: number;
  json: Record<string, unknown>;
}
interface Clock {
  state: string;
  started_at: string | null;
  due_at: string;
  met_at: string | null;
}
interface Item {
  id: string;
  kind: string;
  source: string;
  severity: string;
  lifecycle: string;
  consequence: string | null;
  expected_action: string | null;
  needs_reclaim: boolean;
  clocks: { basis: string; claim: Clock | null; resolve: Clock | null; paused: { reason_code: string; allowed_by: { id: string } | null } | null; needs_reclaim: { since: string } | null } | null;
  snooze: { reason_code: string | null; ordinal: number | null; of: number | null; final: boolean; policy_version: string | null; by: { id: string }; note: string | null } | null;
  snooze_count: number;
  pause: { reason_code: string; until: string } | null;
  reminders: { sent: number; due: boolean; next_at: string | null; exhausted: boolean } | null;
  notices: Array<{ kind: string }>;
  existing_clock: { code: string; migrated: boolean } | null;
  policy_version: string | null;
}

const day = (offset: number): string => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const at = (offset: number, time = '05:00:00'): string => `${day(offset)}T${time}.000Z`;

/** The clocks, the snooze policy, the reminders and the pause of the alert centre over HTTP, and the job that reminds (HOME, roadmap G0-2, G2-1, G2-2, G2-4). */
describe('the governance of the clocks of the alert centre', () => {
  const harness = new AuthzHarness();
  const clocks = new HomeWorkClockStore();
  let app: RunningApp;
  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; body?: unknown; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method === 'POST') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const list = (query = '?view=scope', member = LEADER): Promise<Reply> => call('GET', `/home/my-work${query}`, { member });
  const items = (reply: Reply): Item[] => reply.json.items as Item[];
  const itemOf = (reply: Reply, id: string): Item => {
    const found = items(reply).find((item) => item.id === id);
    if (found === undefined) throw new Error(`item ${id} is not in the list: ${JSON.stringify(items(reply).map((item) => item.id))}`);
    return found;
  };
  const act = (action: 'claim' | 'assign' | 'snooze' | 'pause' | 'resume', body: Record<string, unknown>, member = LEADER, key?: string): Promise<Reply> =>
    call('POST', `/home/work-actions/${action}`, { member, body, ...(key === undefined ? {} : { key }) });
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
  async function insert(table: string, values: Record<string, unknown>): Promise<string> {
    const rowId = (values.id as string | undefined) ?? randomUUID();
    await admin(async (client) => {
      const columns = (
        await client.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null; is_generated: string }>(
          `select column_name, data_type, is_nullable, column_default, is_generated from information_schema.columns where table_schema = 'machvon' and table_name = $1`,
          [table],
        )
      ).rows;
      const all: Record<string, unknown> = { tenant_id: TENANT_A, id: rowId, ...values };
      const json = new Set(columns.filter((column) => column.data_type === 'jsonb').map((column) => column.column_name));
      for (const column of columns) {
        if (column.column_name in all || column.is_generated === 'ALWAYS' || column.is_nullable === 'YES' || column.column_default !== null) continue;
        all[column.column_name] =
          column.data_type === 'uuid' ? randomUUID() : ['integer', 'smallint', 'bigint', 'numeric'].includes(column.data_type) ? 1 : column.data_type === 'boolean' ? false : column.data_type === 'date' ? TODAY : column.data_type.startsWith('timestamp') ? NOW.toISOString() : column.data_type === 'jsonb' ? {} : column.data_type === 'ARRAY' ? [] : column.data_type === 'character' ? 'VND' : 'text-value';
      }
      const names = Object.keys(all);
      const params = names.map((name) => {
        const value = all[name];
        return json.has(name) || (typeof value === 'object' && value !== null && !Array.isArray(value)) ? JSON.stringify(value) : value;
      });
      await client.query(`insert into machvon.${table} (${names.map((name) => `"${name}"`).join(', ')}) values (${names.map((_, index) => `$${index + 1}`).join(', ')})`, params);
    });
    return rowId;
  }
  const wipe = (): Promise<void> =>
    admin(async (client) => {
      for (const table of ['outbox_event', 'audit_event', 'work_reminder', 'work_clock', 'work_action', 'early_warning', 'early_warning_rule', 'guarantee', 'contract', 'project_accountability', 'governance_rule', 'work_calendar_version', 'project']) {
        await client.query(`delete from machvon.${table}`);
      }
    });
  const project = (unit: number, code: string): Promise<string> => insert('project', { code, name: code, owner_unit_id: unitId(unit), classification: 'INTERNAL', total_investment_vnd: 1000, status: 'IMPLEMENTATION', version: 1, project_group: 'B' });
  const contract = (projectId: string, code: string): Promise<string> => insert('contract', { code, project_id: projectId, status: 'ACTIVE', signed_on: day(-200), effective_from: day(-200), type: 'LUMP_SUM', contract_value_vnd: 1000 });
  async function warning(projectId: string, severity: string, openedAt = NOW.toISOString()): Promise<string> {
    const ruleId = await insert('early_warning_rule', { rule_code: `EW-${randomUUID().slice(0, 6).toUpperCase()}`, name: 'Rule', metric_code: 'YTD_RATE_GAP', comparator: 'GTE', threshold_json: { points: 10 }, severity, scope_kind: 'PROJECT', status: 'PUBLISHED', revision: 1, effective_from: '2027-01-01', approved_by: memberId(MAKER), created_by: memberId(LEADER), version: 1 });
    return insert('early_warning', { rule_id: ruleId, project_id: projectId, severity, observed_json: {}, dedupe_key: `k-${randomUUID()}`, status: 'OPEN', opened_at: openedAt, version: 1 });
  }
  const guarantee = (contractId: string, daysLeft: number): Promise<string> =>
    insert('guarantee', { contract_id: contractId, kind: 'PERFORMANCE', issuer: 'Bank', amount_vnd: 100, expires_at: at(daysLeft, '12:00:00'), valid_from: day(-100), verification_status: 'VERIFIED', verified_by: memberId(MAKER), verified_at: NOW.toISOString(), verification_method: 'ORIGINAL', verification_evidence_id: randomUUID(), created_by: memberId(LEADER), status: 'ACTIVE', version: 1 });
  async function calendars(): Promise<void> {
    for (const year of [2026, 2027, 2028]) {
      await insert('work_calendar_version', { calendar_code: 'WORKDAY_VN', year, revision: 1, working_days: [1, 2, 3, 4, 5], holidays: [], compensated_workdays: [], legal_basis_ref: 'Labour Code 2019, Article 112', status: 'Published', created_by: memberId(LEADER), published_by: memberId(LEADER), published_at: NOW.toISOString() });
    }
  }
  const accountable = (projectId: string, member: number): Promise<string> => insert('project_accountability', { project_id: projectId, leader_membership_id: memberId(member), accountability_role: 'LEADER_IN_CHARGE', valid_from: '2027-01-01', status: 'ACTIVE', created_by: memberId(LEADER), updated_by: memberId(LEADER) });
  /** Moves a decision to the moment the test needs it: the rows are stamped by the clock of the database, the commands by the clock of the test. */
  const stamp = (action: string, when: string, actor?: number): Promise<void> =>
    admin(async (client) => void (await client.query('update machvon.work_action set created_at = $2::timestamptz where action = $1 and ($3::uuid is null or actor_membership_id = $3::uuid)', [action, when, actor === undefined ? null : memberId(actor)])));

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: NORTH, path: `/${unitId(ROOT)}/${unitId(NORTH)}/`, parent: ROOT },
      { n: SOUTH, path: `/${unitId(ROOT)}/${unitId(SOUTH)}/`, parent: ROOT },
    ]);
    await harness.seedMembership(TENANT_A, LEADER, ROOT);
    await harness.seedMembership(TENANT_A, MAKER, NORTH);
    await harness.seedMembership(TENANT_A, OTHER, SOUTH);
    await harness.seedMembership(TENANT_A, NOBODY, NORTH);
    await harness.seedRole(TENANT_A, 1, 'HOME_LEADER', ['home.read', 'warning.handle', 'advance.alert.ack', 'advance.read'], 20);
    await harness.seedRole(TENANT_A, 2, 'HOME_READER', ['home.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: LEADER, role: 1, kind: 'TENANT' },
      { n: 2, member: MAKER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(NORTH)] },
      { n: 3, member: OTHER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(SOUTH)] },
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [MyWorkController, WorkActionController, WorkActionClockController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: HOME_CLOCK, useValue: () => NOW },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  beforeEach(wipe);

  describe('snoozing is governed by the policy (G2-1)', () => {
    it('needs a reason from the policy, and words when the reason is "other"', async () => {
      const g = await guarantee(await contract(await project(NORTH, 'P-G1'), 'C-G1'), 20);
      const base = { source: 'GUARANTEE', source_id: g, snooze_until: at(1) };
      const missing = await act('snooze', base);
      expect([missing.status, missing.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect((await act('snooze', { ...base, reason_code: 'BECAUSE' })).status).toBe(422);
      expect((await act('snooze', { ...base, reason_code: 'OTHER' })).status).toBe(422);
      expect((await act('snooze', { ...base, reason_code: 'OTHER', reason: 'abc' })).status).toBe(422);
      expect((await act('snooze', { ...base, reason_code: 'OTHER', reason: 'Waiting for the letter of the bank' })).status).toBe(200);
      const [saved] = await rows<{ reason_code: string; reason: string; snooze_ordinal: number; snooze_final: boolean; policy_version: string }>('select reason_code, reason, snooze_ordinal, snooze_final, policy_version from machvon.work_action');
      expect(saved).toMatchObject({ reason_code: 'OTHER', reason: 'Waiting for the letter of the bank', snooze_ordinal: 1, snooze_final: false, policy_version: 'builtin' });
      // The command does not take a reason code that belongs to snoozing.
      expect((await act('claim', { source: 'GUARANTEE', source_id: g, ...WHY })).status).toBe(422);
    });

    it('allows two in a row, tells the next level at the last one, refuses a third, and counts again after a claim', async () => {
      const g = await guarantee(await contract(await project(NORTH, 'P-G2'), 'C-G2'), 20);
      const target = { source: 'GUARANTEE', source_id: g, ...WHY };
      // A guarantee 20 days from its end is to be watched: up to 14 days.
      const first = await act('snooze', { ...target, snooze_until: at(5), reason: 'Waiting for the bank.' });
      expect(first.status).toBe(200);
      let seen = itemOf(await list('?view=scope', MAKER), g);
      expect(seen.snooze).toMatchObject({ reason_code: 'WAITING_INFORMATION', ordinal: 1, of: 2, final: false, policy_version: 'builtin', by: { id: memberId(LEADER) }, note: 'Waiting for the bank.' });
      expect(await rows('select 1 from machvon.work_reminder')).toHaveLength(0);

      const second = await act('snooze', { ...target, snooze_until: at(9) });
      expect(second.status).toBe(200);
      seen = itemOf(await list('?view=scope', MAKER), g);
      expect(seen.snooze).toMatchObject({ ordinal: 2, final: true });
      expect(seen.snooze_count).toBe(2);
      // The last one allowed is noticed to the next level, in a row of its own and by an event, written once.
      const notices = await rows<{ kind: string; audience: string; recipient_membership_id: string; ordinal: number; series_key: string }>('select kind, audience, recipient_membership_id, ordinal, series_key from machvon.work_reminder');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ kind: 'SNOOZE_FINAL_NOTICE', audience: 'NEXT_LEVEL', recipient_membership_id: memberId(LEADER), ordinal: 2 });
      expect((await rows<{ type: string }>("select type from machvon.outbox_event where type = 'home.work_snooze_final.v1'")).length).toBe(1);

      const third = await act('snooze', { ...target, snooze_until: at(10) });
      expect([third.status, third.json.code]).toEqual([422, 'WORK_SNOOZE_LIMIT']);
      expect(await rows('select 1 from machvon.work_action where action = \'SNOOZE\'')).toHaveLength(2);

      // Taking the item up starts the count again.
      expect((await act('claim', { source: 'GUARANTEE', source_id: g }, MAKER)).status).toBe(200);
      expect((await act('snooze', { ...target, snooze_until: at(6) }, MAKER)).status).toBe(200);
      // The one who put it off is not shown it until it comes back; the list of what is put off shows the latest postponement, which is the first of the new count.
      const listed = (await call('GET', '/home/work-actions/snoozed', { member: LEADER })).json.items as Array<{ source_id: string; snooze: { ordinal: number; final: boolean; by: { id: string } }; snooze_count: number }>;
      expect(listed.find((entry) => entry.source_id === g)).toMatchObject({ snooze: { ordinal: 1, final: false, by: { id: memberId(MAKER) } }, snooze_count: 1 });
    });

    it('replays the same Idempotency-Key as the same answer and writes the decision, the notice and the event once', async () => {
      const g = await guarantee(await contract(await project(NORTH, 'P-G3'), 'C-G3'), 20);
      const target = { source: 'GUARANTEE', source_id: g, ...WHY };
      expect((await act('snooze', { ...target, snooze_until: at(4) })).status).toBe(200);
      const body = { ...target, snooze_until: at(8) };
      const key = `idem-${randomUUID()}`;
      const one = await act('snooze', body, LEADER, key);
      const again = await act('snooze', body, LEADER, key);
      expect([one.status, again.status]).toEqual([200, 200]);
      expect(again.json).toEqual(one.json);
      expect(await rows('select 1 from machvon.work_action where action = \'SNOOZE\'')).toHaveLength(2);
      expect(await rows('select 1 from machvon.work_reminder')).toHaveLength(1);
      expect(await rows("select 1 from machvon.outbox_event where type = 'home.work_snooze_final.v1'")).toHaveLength(1);
    });

    it('keeps the words of the person out of the audit trail and the events: they name the item, the reason code and the length only', async () => {
      const g = await guarantee(await contract(await project(NORTH, 'P-G4'), 'C-G4'), 20);
      expect((await act('snooze', { source: 'GUARANTEE', source_id: g, reason_code: 'OTHER', reason: 'Secret words of the officer', snooze_until: at(3) })).status).toBe(200);
      const trail = await rows<{ safe_diff: unknown }>("select safe_diff from machvon.audit_event where action = 'home.work_snoozed'");
      expect(JSON.stringify(trail)).toContain('OTHER');
      expect(JSON.stringify(trail)).not.toContain('Secret');
      const events = await rows<{ payload: unknown }>("select payload from machvon.outbox_event where type = 'home.work_snoozed.v1'");
      expect(JSON.stringify(events)).not.toContain('Secret');
    });

    it('reads the caps from the approved rule in force, and says which version decided', async () => {
      const g = await guarantee(await contract(await project(NORTH, 'P-G5'), 'C-G5'), 20);
      const params = { reasons: ['WAITING_INFORMATION', 'OTHER'], note_required_for: ['OTHER'], max_days_by_severity: { URGENT: 0, ACTION: 1, WATCH: 2 }, max_consecutive: 1, final_notifies_next_level: true };
      await insert('governance_rule', { rule_type: 'SNOOZE_POLICY', code: 'DEFAULT', version: 1, status: 'APPROVED', params, effective_from: '2027-01-01', reason: 'Tighter snoozing for the audit', created_by: memberId(LEADER), submitted_by: memberId(LEADER), approved_by: memberId(MAKER), approved_at: NOW.toISOString(), submitted_at: NOW.toISOString() });
      const target = { source: 'GUARANTEE', source_id: g, ...WHY };
      expect((await act('snooze', { ...target, snooze_until: at(3) })).json.code).toBe('WORK_SNOOZE_TOO_LONG');
      expect((await act('snooze', { ...target, snooze_until: at(1, '02:00:00') })).status).toBe(200);
      // One in a row is all this rule allows, and it is the last one.
      expect(itemOf(await list('?view=scope', MAKER), g).snooze).toMatchObject({ ordinal: 1, of: 1, final: true, policy_version: 'v1' });
      expect((await act('snooze', { ...target, snooze_until: at(1, '02:30:00') })).json.code).toBe('WORK_SNOOZE_LIMIT');
    });

    it('lists what is put off now for a reader with a scope, inside that scope, and not for one without a right to read', async () => {
      const north = await guarantee(await contract(await project(NORTH, 'P-G6'), 'C-G6'), 20);
      const south = await guarantee(await contract(await project(SOUTH, 'P-G7'), 'C-G7'), 20);
      expect((await act('snooze', { source: 'GUARANTEE', source_id: north, ...WHY, snooze_until: at(4), reason: 'Waiting for the bank.' })).status).toBe(200);
      expect((await act('snooze', { source: 'GUARANTEE', source_id: south, reason_code: 'ON_LEAVE', snooze_until: at(2) })).status).toBe(200);
      const all = await call('GET', '/home/work-actions/snoozed', { member: LEADER });
      expect(all.status).toBe(200);
      const listed = (all.json.items as Array<{ source_id: string; snooze: { reason_code: string; ordinal: number; of: number; by: { id: string }; until: string } }>).map((entry) => [entry.source_id, entry.snooze.reason_code, entry.snooze.ordinal, entry.snooze.of, entry.snooze.by.id]);
      expect(listed).toEqual([
        [south, 'ON_LEAVE', 1, 2, memberId(LEADER)],
        [north, 'WAITING_INFORMATION', 1, 2, memberId(LEADER)],
      ]);
      expect(all.json).toMatchObject({ count: 2, policy_version: 'builtin' });
      // The reader of the north sees only the north; the one of the south, only the south.
      expect(((await call('GET', '/home/work-actions/snoozed', { member: MAKER })).json.items as Array<{ source_id: string }>).map((entry) => entry.source_id)).toEqual([north]);
      expect(((await call('GET', '/home/work-actions/snoozed', { member: OTHER })).json.items as Array<{ source_id: string }>).map((entry) => entry.source_id)).toEqual([south]);
      expect((await call('GET', '/home/work-actions/snoozed', { member: NOBODY })).status).toBe(403);
      // When the time comes the item is no longer listed as put off.
      await admin(async (client) => void (await client.query("update machvon.work_action set snooze_until = now() - interval '1 hour' where action = 'SNOOZE'")));
      expect((await call('GET', '/home/work-actions/snoozed', { member: LEADER })).json).toMatchObject({ count: 0, items: [] });
    });
  });

  describe('the two clocks and the pause (G2-2)', () => {
    it('counts the time to take an item up and the time to resolve it in working hours from its start, on the published calendar', async () => {
      await calendars();
      // Opened Thursday 11:00 in Vietnam: a warning to be acted on is to be taken up within 8 working hours, which ends Friday 11:00.
      const w = await warning(await project(NORTH, 'P-C1'), 'WARNING', at(-1, '04:00:00'));
      const item = itemOf(await list(), w);
      expect(item.clocks).toMatchObject({
        basis: 'WORKING_TIME',
        claim: { state: 'RUNNING', started_at: at(-1, '04:00:00'), due_at: at(0, '04:00:00') },
        // 40 working hours for the whole item: Thursday 11:00 plus a working week of five days ends the Thursday after.
        resolve: { state: 'RUNNING', due_at: at(6, '04:00:00') },
      });
      expect(item.existing_clock).toMatchObject({ code: 'DIS-20', migrated: false });
      expect(item.policy_version).toBe('builtin');
      // Past the end and not taken up: breached.
      const late = await warning(await project(NORTH, 'P-C2'), 'WARNING', at(-5, '04:00:00'));
      expect(itemOf(await list(), late).clocks?.claim).toMatchObject({ state: 'BREACHED' });
    });

    it('says the clocks are not available when the year has no published calendar, and invents none', async () => {
      const w = await warning(await project(NORTH, 'P-C3'), 'WARNING', at(-1, '04:00:00'));
      const item = itemOf(await list(), w);
      expect(item.clocks).toMatchObject({ basis: 'CALENDAR_UNAVAILABLE', claim: null });
      expect(item.reminders).toMatchObject({ due: false, next_at: null });
    });

    it('wraps the clock the module already keeps, as it is, for each source', async () => {
      const g = await guarantee(await contract(await project(NORTH, 'P-C4'), 'C-C4'), 20);
      expect(itemOf(await list(), g).existing_clock).toMatchObject({ code: 'CTR-05', migrated: false });
    });

    it('pauses the clocks with a reason, an end and a person who allowed it, moves the end by the working time paused, and ends the pause on request', async () => {
      await calendars();
      const w = await warning(await project(NORTH, 'P-C5'), 'WARNING', at(-1, '04:00:00'));
      const body = { source: 'EARLY_WARNING', source_id: w, reason_code: 'WAITING_EXTERNAL_PARTY', reason: 'Waiting for the answer of the investor', allowed_by_id: memberId(MAKER), paused_until: at(1, '03:00:00') };
      const paused = await act('pause', body);
      expect(paused.status).toBe(200);
      expect(paused.json).toMatchObject({ status: 'PAUSED' });
      // The pause is stamped by the clock of the test: it began Thursday 12:00 in Vietnam.
      await stamp('PAUSE_CLOCK', at(-1, '05:00:00'));
      const item = itemOf(await list(), w);
      expect(item.pause).toMatchObject({ reason_code: 'WAITING_EXTERNAL_PARTY' });
      expect(item.clocks?.paused).toMatchObject({ allowed_by: { id: memberId(MAKER) } });
      // Paused from Thursday 12:00 to Friday 10:00 is 6 working hours (13:00 to 17:00 and 08:00 to 10:00): the end of the claim clock moves from Friday 11:00 to Monday 09:00.
      expect(item.clocks?.claim).toMatchObject({ state: 'PAUSED', due_at: at(3, '02:00:00') });
      expect(item.reminders).toMatchObject({ due: false, next_at: null });
      // It cannot be paused twice.
      const twice = await act('pause', body);
      expect([twice.status, twice.json.code]).toEqual([409, 'WORK_CLOCK_ALREADY_PAUSED']);
      // Resumed, the clocks run again and the working time that was paused stays added to the end.
      const resumed = await act('resume', { source: 'EARLY_WARNING', source_id: w, reason: 'The investor answered.' });
      expect(resumed.status).toBe(200);
      await stamp('RESUME_CLOCK', at(0, '03:00:00'));
      const running = itemOf(await list(), w);
      expect(running.pause).toBeNull();
      expect(running.clocks?.claim).toMatchObject({ state: 'RUNNING', due_at: at(3, '02:00:00') });
      const [pause, resume] = await rows<{ action: string; reason_code: string; allowed_by_membership_id: string | null; paused_until: string | null }>('select action, reason_code, allowed_by_membership_id, paused_until from machvon.work_action order by action desc');
      expect(pause).toMatchObject({ action: 'RESUME_CLOCK', allowed_by_membership_id: null, paused_until: null });
      expect(resume).toMatchObject({ action: 'PAUSE_CLOCK', reason_code: 'WAITING_EXTERNAL_PARTY', allowed_by_membership_id: memberId(MAKER) });
      const again = await act('resume', { source: 'EARLY_WARNING', source_id: w });
      expect([again.status, again.json.code]).toEqual([409, 'WORK_CLOCK_NOT_PAUSED']);
      expect((await rows('select 1 from machvon.audit_event where action in (\'home.work_clock_paused\', \'home.work_clock_resumed\')')).length).toBe(2);
    });

    it('refuses a pause without a reason code, without words, without an end inside the policy, or allowed by nobody who may: the person who pauses, a person outside the scope, one who does not exist', async () => {
      const w = await warning(await project(NORTH, 'P-C6'), 'WARNING');
      const ok = { source: 'EARLY_WARNING', source_id: w, reason_code: 'FORCE_MAJEURE', reason: 'The office was closed by the storm', allowed_by_id: memberId(MAKER), paused_until: at(2, '03:00:00') };
      const code = async (change: Record<string, unknown>, member = LEADER): Promise<[number, unknown]> => {
        const reply = await act('pause', { ...ok, ...change }, member);
        return [reply.status, reply.json.code];
      };
      expect(await code({ reason_code: 'BECAUSE' })).toEqual([422, 'VALIDATION_FAILED']);
      expect(await code({ reason: '  ab  ' }, LEADER)).toEqual([422, 'VALIDATION_FAILED']);
      expect(await code({ paused_until: at(-1) })).toEqual([422, 'VALIDATION_FAILED']);
      expect(await code({ paused_until: at(31, '03:00:00') })).toEqual([422, 'WORK_CLOCK_PAUSE_TOO_LONG']);
      expect(await code({ allowed_by_id: memberId(LEADER) })).toEqual([422, 'WORK_CLOCK_ALLOWER_INVALID']);
      expect(await code({ allowed_by_id: randomUUID() })).toEqual([422, 'WORK_CLOCK_ALLOWER_INVALID']);
      // MAKER reads the north only: the south is not theirs to name.
      expect(await code({ allowed_by_id: memberId(OTHER) }, MAKER)).toEqual([422, 'WORK_CLOCK_ALLOWER_INVALID']);
      expect((await act('pause', { ...ok, reason_code: undefined })).status).toBe(400);
      expect(await rows('select 1 from machvon.work_action')).toHaveLength(0);
      // The item has to be one the person sees: the south reader does not see a warning of the north.
      expect((await act('pause', ok, OTHER)).json.code).toBe('WORK_ITEM_GONE');
      expect((await act('pause', ok, NOBODY)).status).toBe(403);
    });

    it('is refused by the table itself when a pause names its own author as the one who allowed it', async () => {
      await expect(
        admin(async (client) => {
          await client.query(
            `insert into machvon.work_action (tenant_id, source, source_id, action, actor_membership_id, allowed_by_membership_id, paused_until, reason_code, reason) values ($1, 'GUARANTEE', 'x', 'PAUSE_CLOCK', $2, $2, now() + interval '1 day', 'OTHER', 'Self allowed')`,
            [TENANT_A, memberId(LEADER)],
          );
        }),
      ).rejects.toThrow(/work_action_shape_chk/);
    });
  });

  describe('taking an item up again (G2-2)', () => {
    it('shows an item that was taken up and went silent as "cần nhận lại", and a re-claim tells the next level and starts the count again', async () => {
      await calendars();
      const g = await guarantee(await contract(await project(NORTH, 'P-R1'), 'C-R1'), 5);
      expect((await act('claim', { source: 'GUARANTEE', source_id: g })).status).toBe(200);
      // Not silent yet: it was taken up a moment ago (the row is stamped by the clock of the test).
      await stamp('CLAIM', at(0, '03:00:00'));
      expect(itemOf(await list(), g)).toMatchObject({ lifecycle: 'CLAIMED', needs_reclaim: false });
      // Taken up Tuesday 09:00; an item to be acted on shows no sign of work after 24 working hours: since Friday 09:00 it needs to be taken up again.
      await stamp('CLAIM', at(-3, '02:00:00'));
      const silent = itemOf(await list(), g);
      expect(silent.needs_reclaim).toBe(true);
      expect(silent.clocks?.needs_reclaim).toMatchObject({ since: at(0, '02:00:00') });
      expect((await call('GET', '/home/my-work?view=scope', { member: LEADER })).json).toMatchObject({ counts: { needs_reclaim: 1 } });
      // Somebody takes it up again: the next level hears of it, once, and the item is no longer silent.
      const key = `reclaim-${randomUUID()}`;
      const claimed = await act('claim', { source: 'GUARANTEE', source_id: g }, MAKER, key);
      expect(claimed.status).toBe(200);
      expect((await act('claim', { source: 'GUARANTEE', source_id: g }, MAKER, key)).json).toEqual(claimed.json);
      await stamp('CLAIM', at(0, '03:00:00'), MAKER);
      expect(itemOf(await list(), g).needs_reclaim).toBe(false);
      const notices = await rows<{ kind: string; audience: string }>('select kind, audience from machvon.work_reminder');
      expect(notices).toEqual([{ kind: 'RECLAIM_NOTICE', audience: 'NEXT_LEVEL' }]);
      const events = await rows<{ payload: { reclaim?: boolean; previous_claimed_by?: string } }>("select payload from machvon.outbox_event where type = 'home.work_claimed.v1' order by created_at");
      expect(events.map((event) => event.payload.reclaim ?? false)).toEqual([false, true]);
      expect(events[1]?.payload.previous_claimed_by).toBe(memberId(LEADER));
    });
  });

  describe('the reminders (G2-4)', () => {
    const run = (): ReturnType<typeof runWorkReminders> => runWorkReminders(harness.tenants as TenantDatabase, { tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 1 }, NOW);
    /** The rows are stamped by the clock of the database; the cadence counts from the moment a reminder was made, so the test puts them at the moment of the pass. */
    const stampReminders = (): Promise<void> => admin(async (client) => void (await client.query('update machvon.work_reminder set created_at = $1::timestamptz', [NOW.toISOString()])));

    it('records each reminder that is due, with its event, once, and the next one only when the cadence comes round', async () => {
      await calendars();
      const p = await project(NORTH, 'P-M1');
      await accountable(p, LEADER);
      // A warning to be acted on opened a week ago: reminded every 8 working hours.
      const w = await warning(p, 'WARNING', at(-7, '03:00:00'));
      const first = await run();
      expect(first).toMatchObject({ reminders: 1, reclaimNotices: 0, failed: 0 });
      const made = await rows<{ source_id: string; kind: string; audience: string; recipient_membership_id: string; ordinal: number; severity: string; cadence_working_hours: number; policy_version: string; series_key: string }>('select * from machvon.work_reminder');
      expect(made).toHaveLength(1);
      expect(made[0]).toMatchObject({ source_id: w, kind: 'REMINDER', audience: 'OWNER', recipient_membership_id: memberId(LEADER), ordinal: 1, severity: 'ACTION', cadence_working_hours: 8, policy_version: 'builtin' });
      const events = await rows<{ type: string; payload: { recipient_membership_id: string; source_id: string } }>("select type, payload from machvon.outbox_event where type = 'home.work_reminder.v1'");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ recipient_membership_id: memberId(LEADER), source_id: w });
      // The pass that runs again at the same moment records nothing: the next reminder is not due for another 8 working hours.
      await stampReminders();
      expect(await run()).toMatchObject({ reminders: 0 });
      expect(await rows('select 1 from machvon.work_reminder')).toHaveLength(1);
      const item = itemOf(await list('?view=mine'), w);
      expect(item.reminders).toMatchObject({ sent: 1, due: false, exhausted: false });
      // Friday 10:00 plus 8 working hours (the lunch break is not worked): Monday 10:00.
      expect(item.reminders?.next_at).toBe(at(3, '03:00:00'));
    });

    it('records one reminder when two transactions record the same reminder at the same time', async () => {
      await calendars();
      const p = await project(NORTH, 'P-M2');
      await accountable(p, LEADER);
      const w = await warning(p, 'WARNING', at(-7, '03:00:00'));
      const store = new HomeWorkReminderStore();
      const input = {
        source: 'EARLY_WARNING',
        sourceId: w,
        kind: 'REMINDER' as const,
        audience: 'OWNER' as const,
        recipient: memberId(LEADER),
        severity: 'ACTION' as const,
        ordinal: 1,
        seriesKey: reminderSeriesKey('EARLY_WARNING', w, memberId(LEADER), 1),
        dueAt: NOW,
        cadenceWorkingHours: 8,
        policyVersion: 'builtin',
      };
      const tenant = { tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 1 };
      // The first transaction has written its row and holds it open; the second one meets the same series key, waits for the first and then records nothing.
      // The interleaving is forced by the test (a gate), not left to the speed of the machine: two whole passes started together may or may not overlap.
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      let written!: () => void;
      const hasWritten = new Promise<void>((resolve) => (written = resolve));
      const first = harness.tenants.withTenant(tenant, async (tx) => {
        const recorded = await store.record(tx, input);
        written();
        await gate;
        return recorded;
      });
      await hasWritten;
      const second = harness.tenants.withTenant(tenant, (tx) => store.record(tx, input));
      setTimeout(open, 300);
      const [one, two] = await Promise.all([first, second]);
      expect([one.created, two.created]).toEqual([true, false]);
      expect(two.id).toBe(one.id);
      expect(await rows('select 1 from machvon.work_reminder')).toHaveLength(1);
    });

    it('never records the same reminder of a series twice when two whole passes run together', async () => {
      await calendars();
      const p = await project(NORTH, 'P-M2B');
      await accountable(p, LEADER);
      await warning(p, 'WARNING', at(-7, '03:00:00'));
      // Whether the second pass starts before or after the first one commits depends on the speed of the machine: if it starts after, the first reminder is already counted and the next
      // one is the second of the series. What may never happen is one reminder of a series recorded twice, or a pass that counts a reminder it did not record.
      const [one, two] = await Promise.all([run(), run()]);
      const made = await rows<{ series_key: string }>('select series_key from machvon.work_reminder');
      expect(new Set(made.map((row) => row.series_key)).size).toBe(made.length);
      expect(one.reminders + two.reminders).toBe(made.length);
      expect(made.length).toBeGreaterThanOrEqual(1);
    });

    it('does not remind an item that is snoozed or paused, and invents nothing in a year without a calendar', async () => {
      const p = await project(NORTH, 'P-M3');
      await accountable(p, LEADER);
      const w = await warning(p, 'WARNING', at(-7, '03:00:00'));
      // No published calendar: nothing is due, nothing is made.
      expect(await run()).toMatchObject({ reminders: 0, failed: 0 });
      await calendars();
      expect((await act('snooze', { source: 'EARLY_WARNING', source_id: w, ...WHY, snooze_until: at(2) })).status).toBe(200);
      expect(await run()).toMatchObject({ reminders: 0 });
      await admin(async (client) => void (await client.query("update machvon.work_action set snooze_until = now() - interval '1 hour' where action = 'SNOOZE'")));
      expect((await act('pause', { source: 'EARLY_WARNING', source_id: w, reason_code: 'FORCE_MAJEURE', reason: 'The office was closed by the storm', allowed_by_id: memberId(MAKER), paused_until: at(2, '03:00:00') })).status).toBe(200);
      expect(await run()).toMatchObject({ reminders: 0 });
      expect(await rows('select 1 from machvon.work_reminder')).toHaveLength(0);
    });

    it('notices the next level once for an item that was taken up and went silent', async () => {
      await calendars();
      const g = await guarantee(await contract(await project(NORTH, 'P-M4'), 'C-M4'), 5);
      expect((await act('claim', { source: 'GUARANTEE', source_id: g })).status).toBe(200);
      await stamp('CLAIM', at(-3, '02:00:00'));
      const first = await run();
      expect(first.reclaimNotices).toBe(1);
      expect(await run()).toMatchObject({ reclaimNotices: 0 });
      const notices = await rows<{ kind: string; audience: string; source_id: string }>("select kind, audience, source_id from machvon.work_reminder where kind = 'RECLAIM_NOTICE'");
      expect(notices).toEqual([{ kind: 'RECLAIM_NOTICE', audience: 'NEXT_LEVEL', source_id: g }]);
      expect(itemOf(await list(), g).notices).toEqual([{ kind: 'RECLAIM_NOTICE', at: expect.any(String) }]);
      expect(await rows("select 1 from machvon.outbox_event where type = 'home.work_reclaim_notice.v1'")).toHaveLength(1);
    });
  });

  describe('the clocks that modules start (G0-2)', () => {
    const start = (over: Record<string, unknown> = {}): Promise<{ id: string; created: boolean }> =>
      (harness.tenants as TenantDatabase).withTenant({ tenantId: TENANT_A, membershipId: memberId(LEADER), scopeVersion: 1 }, async (tx) => {
        const { clock, created } = await clocks.start(tx, {
          clockType: 'EGP_POSTING',
          subjectType: 'procurement_package',
          subjectId: randomUUID(),
          title: 'Đăng tải thông báo mời thầu',
          subtitle: 'Gói 05',
          ownerMembershipId: memberId(MAKER),
          severity: 'WATCH',
          expectedAction: 'Đăng tải thông báo lên hệ thống mạng đấu thầu quốc gia.',
          consequence: 'Gói thầu chưa đăng tải đúng hạn thì không được bắt đầu đấu thầu.',
          startedAt: new Date(at(-1, '01:00:00')),
          workingMinutes: 660,
          targetScreen: 'BID-02',
          targetId: 'pkg-1',
          createdBy: memberId(LEADER),
          ...over,
        });
        return { id: clock.id, created };
      });

    it('lists a running clock to its owner with its end, its expected action and its consequence, urgent once it is past', async () => {
      await calendars();
      const near = await start();
      // Thursday 08:00 plus 11 working hours ends Friday 11:00: within the cadence of its severity, so it is to be acted on.
      const mine = await list('?view=mine', MAKER);
      const item = itemOf(mine, near.id);
      expect(item).toMatchObject({ source: 'CLOCK', kind: 'CLOCK_DEADLINE', severity: 'ACTION', consequence: expect.stringContaining('không được bắt đầu đấu thầu'), expected_action: expect.stringContaining('Đăng tải') });
      expect(item.clocks?.resolve).toMatchObject({ state: 'RUNNING', due_at: at(0, '04:00:00') });
      // The same clock past its end is urgent.
      const past = await start({ workingMinutes: 300 });
      expect(itemOf(await list('?view=mine', MAKER), past.id)).toMatchObject({ severity: 'URGENT', clocks: { resolve: { state: 'BREACHED', due_at: at(-1, '07:00:00') } } });
      // Somebody who does not own it and does not read its place does not see it.
      expect(items(await list('?view=mine', OTHER)).map((entry) => entry.id)).toEqual([]);
      // It is taken up like any item.
      expect((await act('claim', { source: 'CLOCK', source_id: near.id }, MAKER)).status).toBe(200);
      expect(itemOf(await list('?view=mine', MAKER), near.id).lifecycle).toBe('CLAIMED');
    });

    it('is paused like any item, and the end moves by the working time paused', async () => {
      await calendars();
      const clock = await start({ workingMinutes: 600 });
      // Thursday 08:00 plus 10 working hours ends Friday 10:00, which is the moment of the test: still running, to the minute.
      const body = { source: 'CLOCK', source_id: clock.id, reason_code: 'LEGAL_OR_AUDIT_HOLD', reason: 'The package is under review by the auditor', allowed_by_id: memberId(NOBODY), paused_until: at(1, '03:00:00') };
      expect((await act('pause', body, MAKER)).status).toBe(200);
      await stamp('PAUSE_CLOCK', at(-1, '05:00:00'));
      // Paused from Thursday 12:00 to Friday 10:00 is six working hours: the end moves from Friday 10:00 to Friday 17:00.
      expect(itemOf(await list('?view=mine', MAKER), clock.id).clocks?.resolve).toMatchObject({ state: 'PAUSED', due_at: at(0, '10:00:00') });
    });

    it('starts the same clock once, refuses one nobody answers for, and ends a clock only once', async () => {
      await calendars();
      const subjectId = randomUUID();
      const one = await start({ subjectId });
      const two = await start({ subjectId });
      expect([one.created, two.created, two.id]).toEqual([true, false, one.id]);
      await expect(start({ ownerMembershipId: undefined })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(start({ expectedAction: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await (harness.tenants as TenantDatabase).withTenant({ tenantId: TENANT_A, membershipId: memberId(LEADER), scopeVersion: 1 }, async (tx) => {
        expect((await clocks.end(tx, one.id, 'MET', memberId(MAKER), 'Posted on the portal.')).status).toBe('MET');
        await expect(clocks.end(tx, one.id, 'CANCELLED', memberId(MAKER), 'Again')).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED' });
      });
      // An ended clock is not on anybody's list.
      expect(items(await list('?view=mine', MAKER)).map((entry) => entry.id)).not.toContain(one.id);
    });

    it('names a source that cannot be read, and never turns it into "no work"', async () => {
      await calendars();
      const clock = await start();
      await admin(async (client) => void (await client.query('alter table machvon.work_clock rename to work_clock_away')));
      try {
        const reply = await list('?view=mine', MAKER);
        expect(reply.status).toBe(200);
        expect(reply.json.unavailable_sources).toContain('CLOCK');
        const claim = await act('claim', { source: 'CLOCK', source_id: clock.id }, MAKER);
        expect([claim.status, claim.json.code]).toEqual([503, 'PROVIDER_UNAVAILABLE']);
      } finally {
        await admin(async (client) => void (await client.query('alter table machvon.work_clock_away rename to work_clock')));
      }
    });
  });

  describe('the policies that judge the clocks', () => {
    it('shows the three policies with their version, source and whether they are confirmed, the clocks the modules keep and the calendar years', async () => {
      await calendars();
      const reply = await call('GET', '/home/work-clocks/policies', { member: MAKER });
      expect(reply.status).toBe(200);
      const policies = reply.json.policies as Array<{ type: string; version: string; unverified: boolean; formula?: string; source?: string; params: Record<string, unknown> }>;
      expect(policies.map((entry) => [entry.type, entry.version, entry.unverified])).toEqual([
        ['SNOOZE_POLICY', 'builtin', true],
        ['CLOCK_POLICY', 'builtin', true],
        ['REMINDER_POLICY', 'builtin', true],
      ]);
      expect(policies[0]).toMatchObject({ params: { max_consecutive: 2, max_days_by_severity: { URGENT: 0, ACTION: 3, WATCH: 14 } } });
      expect(String(policies[0]?.formula).length).toBeGreaterThan(10);
      expect(String(policies[0]?.source).length).toBeGreaterThan(10);
      expect((reply.json.existing_clocks as Array<{ code: string; migrated: boolean }>).map((clock) => [clock.code, clock.migrated])).toEqual([['DIS-20', false], ['PAY-12', false], ['PMT-05', false], ['ISS-09', false], ['CTR-05', false]]);
      expect(reply.json.calendar).toEqual({ code: 'WORKDAY_VN', years: [{ year: 2026, published: true }, { year: 2027, published: true }, { year: 2028, published: true }, { year: 2029, published: false }] });
      expect((await call('GET', '/home/work-clocks/policies', { member: NOBODY })).status).toBe(403);
    });
  });
});
