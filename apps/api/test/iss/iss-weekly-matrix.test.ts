import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { issModule } from '../../src/modules/iss';
import { IssIssueReadsController, IssWeeklyMatrixController } from '../../src/modules/iss/iss-issue-reads.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const LEADER = 1; // issue.read on the whole tenant
const UNIT_1_READER = 2; // issue.read in unit 1 only
const NOTHING = 3;
const GUEST = 4; // a guest contractor
const OTHER_TENANT = 1;
const FAMILY = 0x7e;
const PROJECT = id(FAMILY, 1);
const CONTRACTOR = id(FAMILY, 2);
const UNIT_1 = unitId(1);
const UNIT_2 = unitId(2);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Totals {
  opening: number;
  opened: number;
  resolved: number;
  closing: number;
  overdue: number;
  by_status: Record<string, number>;
}

interface MatrixRow extends Totals {
  unit: { id: string; code: string; name: string };
  category: { version_id: string; code: string; label: string };
}

describe('the weekly matrix of the issues by unit and group (ST-ISS-006, ISS-06, ISS-08, BR-ISS-08, UAT-PLAN-25)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let category = '';
  let secondCategory = '';
  let thirdCategory = '';
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function get(url: string, member = LEADER, tenantId = TENANT_A): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}${url}`, { headers: { [TENANT_HEADER]: tokenOf(member, tenantId) } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function seedAdmin(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** An issue with the history it had: each step is the status it moved to and when (the first is the day it was raised). */
  async function issueOf(unit: string, steps: Array<[string, string, string] | [string, string, string, Record<string, unknown>]>, options: { due?: string; category?: string } = {}): Promise<string> {
    counter += 1;
    const issueId = randomUUID();
    const opened = steps[0]?.[1] as string;
    const last = steps[steps.length - 1]?.[0] as string;
    await seedAdmin([
      [
        `insert into machvon.issue
           (tenant_id, id, code, project_id, category_version_id, severity, title, description, owner_unit_id, sla_policy_id, status, version, reported_by, assignee_id, opened_at, response_due_at, due_at, closed_at, closed_by, verifier_id, created_by, updated_by)
         values ($1, $2, $3, $4, $5, 'HIGH', $6, 'Fixture', $7, $8, $9, 1, $10, case when $9 = 'OPEN' then null else $10::uuid end, $11::timestamptz, $11::timestamptz + interval '4 hours', $12::timestamptz,
                 case when $9 = 'CLOSED' then $11::timestamptz end, case when $9 = 'CLOSED' then $13::uuid end, case when $9 = 'CLOSED' then $13::uuid end, $10, $10)`,
        [TENANT_A, issueId, `VM-2026-${String(900_000 + counter)}`, PROJECT, options.category ?? category, `Issue ${counter}`, unit, id(FAMILY, 23), last, memberId(LEADER), opened, options.due ?? '2027-01-01T00:00:00+07:00', memberId(UNIT_1_READER)],
      ],
      ...steps.map(([status, at, kind, payload], index): [string, unknown[]] => [
        `insert into machvon.issue_event (tenant_id, id, issue_id, event_kind, from_status, to_status, payload, created_at, created_by)
         values ($1, gen_random_uuid(), $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8)`,
        [TENANT_A, issueId, kind, index === 0 ? null : steps[index - 1]?.[0], status, JSON.stringify(payload ?? {}), at, memberId(LEADER)],
      ]),
    ]);
    return issueId;
  }
  const at = (day: string, time = '10:00:00'): string => `${day}T${time}+07:00`;

  const cell = (reply: Reply, unit: string, categoryId = category): MatrixRow => {
    const found = (reply.json.rows as MatrixRow[]).find((row) => row.unit.id === unit && row.category.version_id === categoryId);
    if (found === undefined) throw new Error('no such cell');
    return found;
  };
  const unitRow = (reply: Reply, unit: string): Totals & { unit: { id: string } } => {
    const found = (reply.json.units as Array<Totals & { unit: { id: string } }>).find((row) => row.unit.id === unit);
    if (found === undefined) throw new Error('no such unit');
    return found;
  };
  const issuesOf = async (query: string, member = LEADER): Promise<string[]> => {
    const reply = await get(`/resources/issue?limit=200&${query}`, member);
    expect(reply.status).toBe(200);
    return (reply.json.items as Array<{ id: string }>).map((item) => item.id).sort();
  };

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }, { n: 2, path: `/${unitId(2)}/` }]);
    await seedAdmin([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, 'PRJ-WM-1', 'Bridge', $3, $4, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, PROJECT, UNIT_1, id(FAMILY, 20)],
      ],
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'CV', 'Profile', 'INTERNAL', $3, $3)`,
        [TENANT_A, id(FAMILY, 21), memberId(1)],
      ],
      [
        `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id) values ($1, $2, '0100000009', 'Lead Builders', 'VERIFIED', $3)`,
        [TENANT_A, CONTRACTOR, id(FAMILY, 21)],
      ],
    ]);
    const records: Array<[string, string, string, string]> = [
      [randomUUID(), randomUUID(), 'LAND', 'Land clearance'],
      [randomUUID(), randomUUID(), 'SAFETY', 'Site safety'],
      [randomUUID(), randomUUID(), 'DESIGN', 'Design changes'],
    ];
    category = records[0]?.[1] as string;
    secondCategory = records[1]?.[1] as string;
    thirdCategory = records[2]?.[1] as string;
    for (const [recordId, versionId, code, label] of records) {
      await harness.owner(TENANT_A, [
        [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'ISSUE_CATEGORY', $3, 'EFFECTIVE', $4, $4)`, [TENANT_A, recordId, code, memberId(1)]],
        [
          `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, created_by, updated_by)
           values ($1, $2, $3, 'ISSUE_CATEGORY', $4, 1, $5, '{}', '2024-01-01', 'EFFECTIVE', 'TENANT', $6, $6)`,
          [TENANT_A, versionId, recordId, code, label, memberId(1)],
        ],
      ]);
    }
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.issue_sla_policy (tenant_id, id, code, revision, category_version_id, category_record_id, severity, calendar_code, response_hours, resolve_hours, valid_from, status, created_by, updated_by)
         values ($1, $2, 'SLA-LAND-HIGH', 1, $3, $4, 'HIGH', 'WORKDAY_VN', 4, 16, '2026-01-01', 'ACTIVE', $5, $5)`,
        [TENANT_A, id(FAMILY, 23), category, records[0]?.[0], memberId(1)],
      ],
    ]);
    for (const n of [LEADER, UNIT_1_READER, NOTHING, GUEST]) await harness.seedMembership(TENANT_A, n, 1);
    await harness.seedMembership(TENANT_B, OTHER_TENANT, 1);
    await harness.owner(TENANT_A, [["update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2, valid_until = now() + interval '1 year' where id = $1", [memberId(GUEST), CONTRACTOR]]]);
    await harness.seedRole(TENANT_A, 1, 'READER', ['issue.read'], 10);
    await harness.seedRole(TENANT_A, 2, 'NOTHING', ['project.read'], 10);
    await harness.seedRole(TENANT_B, 1, 'READER', ['issue.read'], 10);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: LEADER, role: 1, kind: 'TENANT' },
      { n: 2, member: UNIT_1_READER, role: 1, kind: 'UNIT_SUBTREE', refs: [UNIT_1] },
      { n: 3, member: NOTHING, role: 2, kind: 'TENANT' },
      { n: 4, member: GUEST, role: 1, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [IssIssueReadsController, IssWeeklyMatrixController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of ISS', () => {
    expect(issModule.controllers).toEqual(expect.arrayContaining([IssWeeklyMatrixController]));
  });

  it('UAT-PLAN-25: every count of the matrix equals the count of the rows of the database, and the cell U1 / OPEN lists exactly the issues it counts', async () => {
    // 24 issues across two units, raised on a day of the week 2026-W23 (1 to 7 June), in the statuses OPEN 9, IN_PROGRESS 8 and CLOSED 7 at the end of it.
    const made: Array<{ id: string; unit: string; status: string }> = [];
    for (let n = 0; n < 24; n += 1) {
      const unit = n < 14 ? UNIT_1 : UNIT_2;
      const status = n % 24 < 9 ? 'OPEN' : n % 24 < 17 ? 'IN_PROGRESS' : 'CLOSED';
      const steps: Array<[string, string, string]> = [['OPEN', at('2026-06-02'), 'CREATED']];
      if (status !== 'OPEN') steps.push(['ASSIGNED', at('2026-06-02', '11:00:00'), 'ASSIGNED'], ['IN_PROGRESS', at('2026-06-03'), 'STARTED']);
      if (status === 'CLOSED') steps.push(['PENDING_VERIFICATION', at('2026-06-04'), 'VERIFICATION_REQUESTED'], ['CLOSED', at('2026-06-05'), 'CLOSED']);
      made.push({ id: await issueOf(unit, steps), unit, status });
    }
    const reply = await get('/issues/weekly-matrix?week=2026-W23');
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ week: '2026-W23', from: '2026-06-01', to: '2026-06-07' });
    for (const unit of [UNIT_1, UNIT_2]) {
      const counts = await rows<{ status: string; n: string }>("select status, count(*)::text as n from machvon.issue where owner_unit_id = $1::uuid and title like 'Issue %' and opened_at >= '2026-06-01T00:00:00+07:00' and opened_at < '2026-06-08T00:00:00+07:00' group by status", [unit]);
      const database = Object.fromEntries(counts.map((row) => [row.status, Number(row.n)]));
      const row = unitRow(reply, unit);
      for (const status of ['OPEN', 'IN_PROGRESS', 'CLOSED']) expect({ unit, status, n: row.by_status[status] }).toEqual({ unit, status, n: database[status] ?? 0 });
      expect(Object.values(row.by_status).reduce((sum, n) => sum + n, 0)).toBe(unit === UNIT_1 ? 14 : 10);
    }
    expect((reply.json.totals as Totals).by_status).toMatchObject({ OPEN: 9, IN_PROGRESS: 8, CLOSED: 7 });
    expect(Object.values((reply.json.totals as Totals).by_status).reduce((sum, n) => sum + n, 0)).toBe(24);
    // The drill-down returns exactly the issues the cell counts.
    const expected = made.filter((entry) => entry.unit === UNIT_1 && entry.status === 'OPEN').map((entry) => entry.id).sort();
    expect(expected.length).toBe(unitRow(reply, UNIT_1).by_status.OPEN);
    expect(await issuesOf(`owner_unit_id=${UNIT_1}&status=OPEN&week=2026-W23`)).toEqual(expected);
    expect((await issuesOf(`owner_unit_id=${UNIT_2}&status=CLOSED&week=2026-W23`)).length).toBe(unitRow(reply, UNIT_2).by_status.CLOSED);
    expect(await issuesOf('week=2026-W23')).toHaveLength(24);
  });

  it('BR-ISS-08: closing = opening + opened - resolved, and the opening of a week is the closing of the week before it', async () => {
    const quick = await get('/issues/weekly-matrix?week=2026-W20');
    expect(quick.status).toBe(200);
    // A week with the history written below (11 to 17 May 2026):
    const a = await issueOf(UNIT_1, [['OPEN', at('2026-05-05'), 'CREATED'], ['CLOSED', at('2026-05-13'), 'CLOSED']], { category });
    const b = await issueOf(UNIT_1, [['OPEN', at('2026-05-12'), 'CREATED']], { category });
    const c = await issueOf(UNIT_1, [['OPEN', at('2026-05-12'), 'CREATED'], ['IN_PROGRESS', at('2026-05-14'), 'STARTED']], { category, due: at('2026-05-14', '17:00:00') });
    const d = await issueOf(UNIT_2, [['OPEN', at('2026-05-01'), 'CREATED']], { category });
    const e = await issueOf(UNIT_2, [['OPEN', at('2026-05-02'), 'CREATED'], ['CLOSED', at('2026-05-08'), 'CLOSED'], ['REOPENED', at('2026-05-16'), 'REOPENED']], { category });
    const f = await issueOf(UNIT_2, [['OPEN', at('2026-05-20'), 'CREATED']], { category });
    const g = await issueOf(UNIT_1, [['OPEN', at('2026-05-12'), 'CREATED'], ['CLOSED', at('2026-05-15'), 'CLOSED']], { category });
    const other = await issueOf(UNIT_1, [['OPEN', at('2026-05-13'), 'CREATED']], { category: secondCategory });
    const week = await get('/issues/weekly-matrix?week=2026-W20');
    const u1 = cell(week, UNIT_1);
    expect([u1.opening, u1.opened, u1.resolved, u1.closing]).toEqual([1, 3, 2, 2]);
    expect(u1.by_status).toMatchObject({ OPEN: 1, IN_PROGRESS: 1, CLOSED: 2 });
    expect(u1.overdue).toBe(1);
    const u2 = cell(week, UNIT_2);
    expect([u2.opening, u2.opened, u2.resolved, u2.closing]).toEqual([1, 1, 0, 2]);
    expect(u2.by_status).toMatchObject({ OPEN: 1, REOPENED: 1 });
    // The issue raised in another group is a cell of its own, and the issue raised after the week is not in it.
    expect(cell(week, UNIT_1, secondCategory)).toMatchObject({ opening: 0, opened: 1, resolved: 0, closing: 1, category: { code: 'SAFETY', label: 'Site safety' } });
    expect((week.json.rows as MatrixRow[]).some((row) => (row.by_status.OPEN ?? 0) > 0 && row.unit.id === UNIT_2 && row.opened === 0 && row.opening === 0)).toBe(false);
    for (const row of week.json.rows as MatrixRow[]) expect(row.closing).toBe(row.opening + row.opened - row.resolved);
    // The units are the groups added up, and the total is the units.
    const totals = week.json.totals as Totals;
    expect(totals.closing).toBe((week.json.units as Totals[]).reduce((sum, row) => sum + row.closing, 0));
    expect(unitRow(week, UNIT_1).closing).toBe(u1.closing + cell(week, UNIT_1, secondCategory).closing);
    // The week after: its opening is the closing of this one, for every cell.
    const next = await get('/issues/weekly-matrix?week=2026-W21');
    for (const row of week.json.rows as MatrixRow[]) {
      const after = cell(next, row.unit.id, row.category.version_id);
      expect(after.opening).toBe(row.closing);
      expect(after.closing).toBe(after.opening + after.opened - after.resolved);
    }
    expect(cell(next, UNIT_2).opened).toBe(1);
    expect([a, b, c, d, e, f, g, other].length).toBe(8);
    // The week that ended is read from the history, so a later change of the issue does not change it.
    await seedAdmin([[`update machvon.issue set status = 'CLOSED', assignee_id = $3::uuid, closed_at = now(), closed_by = $2::uuid, verifier_id = $2::uuid where id = $1::uuid`, [b, memberId(UNIT_1_READER), memberId(LEADER)]]]);
    expect(cell(await get('/issues/weekly-matrix?week=2026-W20'), UNIT_1)).toEqual(u1);
    // The list of a cell shows the issues with the status they had then: the one that was closed since still reads as open in the week it was open.
    const listed = await get(`/resources/issue?limit=200&owner_unit_id=${UNIT_1}&category_version_id=${category}&week=2026-W20&status=OPEN`);
    const items = listed.json.items as Array<{ id: string; status: string }>;
    expect(items.map((item) => item.id)).toContain(b);
    expect(items.every((item) => item.status === 'OPEN')).toBe(true);
    expect((await rows<{ status: string }>('select status from machvon.issue where id = $1::uuid', [b]))[0]?.status).toBe('CLOSED');
  });

  it('counts an event at the very start of a week in that week only: the closing of one week is the opening of the next, with nothing counted twice', async () => {
    const first = await issueOf(UNIT_1, [['OPEN', at('2026-06-22', '00:00:00'), 'CREATED']], { category: thirdCategory });
    const second = await issueOf(UNIT_1, [['OPEN', at('2026-06-29', '00:00:00'), 'CREATED']], { category: thirdCategory });
    const before = cell(await get('/issues/weekly-matrix?week=2026-W26'), UNIT_1, thirdCategory);
    expect([before.opening, before.opened, before.resolved, before.closing]).toEqual([0, 1, 0, 1]);
    const after = cell(await get('/issues/weekly-matrix?week=2026-W27'), UNIT_1, thirdCategory);
    expect([after.opening, after.opened, after.resolved, after.closing]).toEqual([1, 1, 0, 2]);
    expect(await issuesOf('owner_unit_id=' + UNIT_1 + '&category_version_id=' + thirdCategory + '&week=2026-W26&open=true')).toEqual([first]);
    expect(await issuesOf('owner_unit_id=' + UNIT_1 + '&category_version_id=' + thirdCategory + '&week=2026-W27&open=true')).toEqual([first, second].sort());
  });

  it('counts an issue as overdue by the deadline it had when the week ended, not the one an extension gave it later, and keeps it overdue once it was late', async () => {
    const extended = { previous_due_at: '2026-07-08T00:00:00+07:00', new_due_at: '2026-07-30T00:00:00+07:00', extension_number: 1 };
    await issueOf(UNIT_2, [['OPEN', at('2026-07-06'), 'CREATED'], ['OPEN', at('2026-07-20'), 'EXTENDED', extended]], { due: '2026-07-30T00:00:00+07:00', category: thirdCategory });
    const overdueOf = async (week: string): Promise<number> => cell(await get('/issues/weekly-matrix?week=' + week), UNIT_2, thirdCategory).overdue;
    expect(await overdueOf('2026-W28')).toBe(1);
    expect(await overdueOf('2026-W29')).toBe(1);
    // Extended on the Monday of this week to a day after it: the deadline had passed before the extension, and a late issue stays late (BR-ISS-04).
    expect(await overdueOf('2026-W30')).toBe(1);
    expect(await overdueOf('2026-W32')).toBe(1);
  });

  it('keeps an issue that was late late when its deadline is moved past the end of the week (BR-ISS-04), and counts one that was extended before it was late as on time', async () => {
    const late = { previous_due_at: '2026-07-28T00:00:00+07:00', new_due_at: '2026-08-10T00:00:00+07:00', extension_number: 1 };
    const early = { previous_due_at: '2026-08-05T00:00:00+07:00', new_due_at: '2026-08-12T00:00:00+07:00', extension_number: 1 };
    // Raised on the 27th with a deadline of the 28th; extended on the 30th, after the deadline passed, to the 10th of August.
    await issueOf(UNIT_1, [['OPEN', at('2026-07-27'), 'CREATED'], ['OPEN', at('2026-07-30'), 'EXTENDED', late]], { due: '2026-08-10T00:00:00+07:00', category: thirdCategory });
    // Raised on the 27th with a deadline of the 5th of August; extended on the 29th, before it was late, to the 12th.
    await issueOf(UNIT_1, [['OPEN', at('2026-07-27'), 'CREATED'], ['OPEN', at('2026-07-29'), 'EXTENDED', early]], { due: '2026-08-12T00:00:00+07:00', category: thirdCategory });
    expect(cell(await get('/issues/weekly-matrix?week=2026-W31'), UNIT_1, thirdCategory).overdue).toBe(1);
  });

  it('keeps the closed issues out of the list of a closing, and takes only true as the flag', async () => {
    const cellIssues = await issuesOf('owner_unit_id=' + UNIT_1 + '&category_version_id=' + category + '&week=2026-W20&open=true');
    expect(cellIssues).toHaveLength(2);
    const all = await issuesOf('owner_unit_id=' + UNIT_1 + '&category_version_id=' + category + '&week=2026-W20');
    expect(all.length).toBe(4);
    expect(cellIssues.every((each) => all.includes(each))).toBe(true);
    const refused = await get('/resources/issue?open=false');
    expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    const now = await issuesOf('owner_unit_id=' + UNIT_1 + '&open=true');
    const dbOpen = await rows<{ id: string }>("select id from machvon.issue where owner_unit_id = $1::uuid and status <> 'CLOSED'", [UNIT_1]);
    expect(now).toEqual(dbOpen.map((row) => row.id).sort());
  });

  it('limits the matrix to a unit, to the scope of the caller, and to the caller who may read issues', async () => {
    const all = await get('/issues/weekly-matrix?week=2026-W20');
    const only = await get(`/issues/weekly-matrix?week=2026-W20&unit_id=${UNIT_2}`);
    expect([...new Set((only.json.rows as MatrixRow[]).map((row) => row.unit.id))]).toEqual([UNIT_2]);
    expect((only.json.rows as MatrixRow[]).length).toBeLessThan((all.json.rows as MatrixRow[]).length);
    const narrow = await get('/issues/weekly-matrix?week=2026-W20', UNIT_1_READER);
    expect([...new Set((narrow.json.rows as MatrixRow[]).map((row) => row.unit.id))]).toEqual([UNIT_1]);
    expect(await issuesOf(`owner_unit_id=${UNIT_2}`, UNIT_1_READER)).toEqual([]);
    expect((await get('/issues/weekly-matrix?week=2026-W20', NOTHING)).status).toBe(403);
    expect((await get('/issues/weekly-matrix?week=2026-W20', GUEST)).status).toBe(403);
    const foreign = await get('/issues/weekly-matrix?week=2026-W20', OTHER_TENANT, TENANT_B);
    expect([foreign.status, foreign.json.rows, foreign.json.totals]).toEqual([200, [], { opening: 0, opened: 0, resolved: 0, closing: 0, overdue: 0, by_status: expect.any(Object) }]);
  });

  it('reads the week that is running up to now, and a week to come as empty', async () => {
    const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
    const running = await get(`/issues/weekly-matrix?week=${weekOf(today)}`);
    expect(running.status).toBe(200);
    for (const row of running.json.rows as MatrixRow[]) expect(row.closing).toBe(row.opening + row.opened - row.resolved);
    // The week that has not begun has nothing in it, and the issues of today are not its opening: the matrix and the list of a cell agree.
    const future = await get('/issues/weekly-matrix?week=2099-W10');
    expect([future.status, future.json.rows, future.json.units]).toEqual([200, [], []]);
    expect(future.json.totals).toMatchObject({ opening: 0, opened: 0, resolved: 0, closing: 0, overdue: 0 });
    expect(await issuesOf('week=2099-W10')).toEqual([]);
    expect(await issuesOf(`owner_unit_id=${UNIT_1}&week=2099-W10&open=true`)).toEqual([]);
  });

  it('refuses a week that is not one, a unit that is not an id, and a status the list does not know', async () => {
    for (const url of ['/issues/weekly-matrix', '/issues/weekly-matrix?week=2026-42', '/issues/weekly-matrix?week=2027-W53', '/issues/weekly-matrix?week=2026-W20&unit_id=x']) {
      const refused = await get(url);
      expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    }
    for (const query of ['status=DONE', 'week=2026-W99', 'owner_unit_id=x', 'category_version_id=x']) {
      const refused = await get(`/resources/issue?${query}`);
      expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    }
  });

  it('narrows the list by group and by the status an issue has now, when no week is named', async () => {
    const safety = await issuesOf(`category_version_id=${secondCategory}`);
    expect(safety).toHaveLength(1);
    const closedNow = await issuesOf(`owner_unit_id=${UNIT_1}&status=CLOSED`);
    const dbClosed = await rows<{ id: string }>("select id from machvon.issue where owner_unit_id = $1::uuid and status = 'CLOSED'", [UNIT_1]);
    expect(closedNow).toEqual(dbClosed.map((row) => row.id).sort());
  });
});

/** The ISO week of a day, for the test of the running week. */
function weekOf(day: string): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7;
  const thursday = new Date(ms - weekday * 86_400_000 + 3 * 86_400_000);
  const year = thursday.getUTCFullYear();
  const first = Date.UTC(year, 0, 4);
  const firstMonday = first - ((new Date(first).getUTCDay() + 6) % 7) * 86_400_000;
  return `${year}-W${String(Math.floor((thursday.getTime() - firstMonday) / (7 * 86_400_000)) + 1).padStart(2, '0')}`;
}
