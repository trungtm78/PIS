import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { disModule } from '../../src/modules/dis';
import { DIS_CLOCK } from '../../src/modules/dis/tokens';
import { SubmissionProgressController } from '../../src/modules/dis/submission-progress.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const READER = 1; // reads the board over the whole tenant
const ELSEWHERE_READER = 2; // reads the board of another branch
const NOBODY = 3;
const B_READER = 1;
const ROOT = 1;
const ELSEWHERE = 2;
const FAMILY = 0xa6;
const NOW = new Date('2027-10-15T03:00:00Z');
const PAST = '2027-10-10T03:00:00Z'; // the deadline has passed
const FUTURE = '2027-10-20T03:00:00Z'; // the deadline is still to come

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

type Kind = 'ACCEPTED' | 'SUBMITTED' | 'UNDER_REVIEW' | 'LATE' | 'DRAFT' | 'RETURNED' | 'NONE';

/** The board of the submission progress of a period over HTTP (ST-DIS-015, DIS-15, PRJ-13). */
describe('the submission progress board over HTTP (ST-DIS-015)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  async function get(periodId: string, query = '', member = READER, tenantId?: string): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}/reporting-periods/${periodId}/submission-progress${query}`, { headers: { [TENANT_HEADER]: tokenOf(member, tenantId) } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  async function seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }
  const day = (offset: number): string => new Date(Date.UTC(2041, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);

  /** A unit of its own (so that the numbers of a test are its own), a period of the type with the deadline, and a project for each of the kinds. */
  async function world(kinds: Kind[], options: { deadline?: string; periodType?: 'WEEK' | 'MONTH'; status?: string } = {}) {
    counter += 1;
    const unit = 10 + counter;
    await harness.seedUnits(TENANT_A, [{ n: unit, path: `/${unitId(ROOT)}/${unitId(unit)}/`, parent: ROOT }]);
    const periodId = id(FAMILY, 2000 + counter);
    const periodType = options.periodType ?? 'WEEK';
    const statements: Array<[string, unknown[]]> = [
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $5::date, $6::timestamptz, 'DEFAULT', $7, 2027, 'OPEN', $8, $9, $9)`,
        [TENANT_A, periodId, `P-${counter}`, day(counter * 40), day(counter * 40 + 6), options.deadline ?? PAST, periodType, id(FAMILY, 40), WORKER_MEMBERSHIP_ID],
      ],
    ];
    const projects: Array<{ id: string; code: string; kind: Kind; reportId: string | null }> = [];
    kinds.forEach((kind, n) => {
      const projectId = id(FAMILY, 100 + counter * 20 + n);
      const code = `PB-${String(counter).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
      const reportId = kind === 'NONE' ? null : randomUUID();
      projects.push({ id: projectId, code, kind, reportId });
      statements.push([
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, $6, 1, 'B')`,
        [TENANT_A, projectId, code, unitId(unit), id(FAMILY, 30), options.status ?? 'IMPLEMENTATION'],
      ]);
      if (reportId === null) return;
      const handedIn = kind === 'ACCEPTED' || kind === 'SUBMITTED' || kind === 'UNDER_REVIEW' || kind === 'LATE' || kind === 'RETURNED';
      const status = kind === 'LATE' ? 'SUBMITTED' : kind;
      statements.push([
        `insert into machvon.report_revision
           (tenant_id, id, project_id, period_id, plan_version_id, revision, status, is_current, version, payload_hash, report_type, measurement_basis, is_late, submitted_by, submitted_at, accepted_by, accepted_at, returned_reason, created_by, updated_by)
         values ($1, $2, $3, $4, $5, 1, $6, $7, 1, repeat('a', 64), $8, 'YTD', $9, $10, $11::timestamptz, $12, $13::timestamptz, $14, $15, $15)`,
        [
          TENANT_A,
          reportId,
          projectId,
          periodId,
          id(FAMILY, 31),
          status,
          kind === 'ACCEPTED',
          periodType === 'MONTH' ? 'MONTHLY' : 'WEEKLY',
          kind === 'LATE',
          handedIn ? WORKER_MEMBERSHIP_ID : null,
          handedIn ? (kind === 'LATE' ? '2027-10-11T03:00:01Z' : '2027-10-09T03:00:00Z') : null,
          kind === 'ACCEPTED' ? memberId(READER) : null,
          kind === 'ACCEPTED' ? '2027-10-09T04:00:00Z' : null,
          kind === 'RETURNED' ? 'Thiếu số liệu giải ngân' : null,
          WORKER_MEMBERSHIP_ID,
        ],
      ]);
    });
    await seedReplica(statements);
    return { unit, unitId: unitId(unit), periodId, projects };
  }
  const unitRow = (reply: Reply, unit: string): Record<string, unknown> | undefined => (reply.json.units as Array<{ unit: { id: string } }>).find((row) => row.unit.id === unit) as Record<string, unknown> | undefined;
  const codes = (reply: Reply): string[] => (reply.json.projects as Array<{ project: { code: string } }>).map((row) => row.project.code);
  const COUNTS = ['must_report', 'submitted', 'submitted_late', 'draft', 'not_started', 'overdue'];
  const counts = (row: Record<string, unknown> | undefined): number[] => COUNTS.map((name) => row?.[name] as number);

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [READER, ELSEWHERE_READER, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_READER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'REPORT_READER', ['report.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'REPORT_READER', ['report.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: READER, role: 1, kind: 'TENANT' },
      { n: 2, member: ELSEWHERE_READER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_READER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [SubmissionProgressController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: DIS_CLOCK, useValue: () => NOW },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  const TEN: Kind[] = ['ACCEPTED', 'ACCEPTED', 'SUBMITTED', 'SUBMITTED', 'UNDER_REVIEW', 'UNDER_REVIEW', 'LATE', 'DRAFT', 'RETURNED', 'NONE'];

  it('serves the controller of the board in the module of DIS', () => {
    expect(disModule.controllers).toContain(SubmissionProgressController);
  });

  it('AC-ST-DIS-015-1 / UAT-AC263: shows 10 that must report, 7 submitted (1 of them late), 2 drafts, 1 not started and 3 overdue after the deadline, and every number drills to its exact projects', async () => {
    const w = await world(TEN);
    const reply = await get(w.periodId, `?unit_id=${w.unitId}`);
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({ deadline_passed: true, period: { id: w.periodId, period_type: 'WEEK' }, as_of: NOW.toISOString() });
    expect(counts(unitRow(reply, w.unitId))).toEqual([10, 7, 1, 2, 1, 3]);
    expect(counts(reply.json.total as Record<string, unknown>)).toEqual([10, 7, 1, 2, 1, 3]);
    const by = Object.fromEntries(w.projects.map((project, n) => [n, project.code]));
    const drill = async (state: string): Promise<string[]> => codes(await get(w.periodId, `?unit_id=${w.unitId}&state=${state}&limit=200`));
    expect(await drill('MUST_REPORT')).toEqual(Object.values(by));
    expect(await drill('SUBMITTED')).toEqual([0, 1, 2, 3, 4, 5, 6].map((n) => by[n]));
    expect(await drill('LATE_SUBMITTED')).toEqual([by[6]]);
    expect(await drill('DRAFT')).toEqual([by[7], by[8]]);
    expect(await drill('NOT_STARTED')).toEqual([by[9]]);
    expect(await drill('OVERDUE')).toEqual([by[7], by[8], by[9]]);
    const overdue = await get(w.periodId, `?unit_id=${w.unitId}&state=OVERDUE`);
    expect((overdue.json.projects as Array<Record<string, unknown>>)[0]).toMatchObject({ state: 'DRAFT', overdue: true, report: { status: 'DRAFT' } });
  });

  it('has nothing overdue while the deadline is still to come, whatever is left to do', async () => {
    const w = await world(TEN, { deadline: FUTURE });
    const reply = await get(w.periodId, `?unit_id=${w.unitId}`);
    expect(reply.json.deadline_passed).toBe(false);
    expect(counts(unitRow(reply, w.unitId))).toEqual([10, 7, 1, 2, 1, 0]);
  });

  it('AC-ST-DIS-015-3 / UAT-AC07: counts the lateness that was stored when the report came in (03:00:01 after a 03:00:00 deadline), and a report that came in on time is not late', async () => {
    const w = await world(['LATE', 'SUBMITTED']);
    const reply = await get(w.periodId, `?unit_id=${w.unitId}&state=SUBMITTED`);
    expect((reply.json.projects as Array<{ project: { code: string }; is_late: boolean; overdue: boolean }>).map((row) => [row.project.code, row.is_late, row.overdue])).toEqual([
      [w.projects[0]?.code, true, false],
      [w.projects[1]?.code, false, false],
    ]);
    expect(counts(unitRow(reply, w.unitId))).toEqual([2, 2, 1, 0, 0, 0]);
  });

  it('counts only the projects at a stage that reports: a project still in the pipeline has nothing to report', async () => {
    const w = await world(['NONE', 'NONE'], { status: 'PIPELINE' });
    expect(unitRow(await get(w.periodId, `?unit_id=${w.unitId}`), w.unitId)).toBeUndefined();
    const reply = await get(w.periodId, `?unit_id=${w.unitId}`);
    expect(counts(reply.json.total as Record<string, unknown>)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('reads only the projects in the scope of the caller, and a person of another tenant finds no such period', async () => {
    const w = await world(['SUBMITTED', 'NONE']);
    expect(counts(unitRow(await get(w.periodId, '', READER), w.unitId))).toEqual([2, 1, 0, 0, 1, 1]);
    const elsewhere = await get(w.periodId, '', ELSEWHERE_READER);
    expect(elsewhere.status).toBe(200);
    expect(unitRow(elsewhere, w.unitId)).toBeUndefined();
    expect(await get(w.periodId, '', NOBODY)).toMatchObject({ status: 403 });
    const other = await get(w.periodId, '', B_READER, TENANT_B);
    expect(other.status).toBe(404);
    expect(JSON.stringify(other.json)).not.toContain(w.periodId);
    expect(await get(randomUUID())).toMatchObject({ status: 404 });
  });

  it('PRJ-13: gives the narrative of the report that stands for each project when it is asked for, and none otherwise', async () => {
    const w = await world(['ACCEPTED', 'DRAFT'], { periodType: 'MONTH' });
    const first = w.projects[0]?.reportId as string;
    await seedReplica([
      [
        `insert into machvon.report_narrative (tenant_id, id, report_revision_id, results_text, causes_text, solutions_text, proposals_text, linked_issue_ids, created_by, updated_by)
         values ($1, gen_random_uuid(), $2, 'Đạt 60% khối lượng', 'Chờ phê duyệt thiết kế', null, null, '{}', $3, $3)`,
        [TENANT_A, first, WORKER_MEMBERSHIP_ID],
      ],
    ]);
    const plain = await get(w.periodId, `?unit_id=${w.unitId}&state=MUST_REPORT`);
    expect((plain.json.projects as Array<Record<string, unknown>>).every((row) => !('narrative' in row))).toBe(true);
    const withNarrative = await get(w.periodId, `?unit_id=${w.unitId}&state=MUST_REPORT&with_narrative=true`);
    expect((withNarrative.json.projects as Array<Record<string, unknown>>).map((row) => row.narrative)).toEqual([{ results: 'Đạt 60% khối lượng', causes: 'Chờ phê duyệt thiết kế', solutions: null, proposals: null }, null]);
    expect(withNarrative.json.period).toMatchObject({ period_type: 'MONTH' });
  });

  it('pages the drill by cursor in the order of project code, and judges the query: the unit, the state, the narrative flag, the limit and the cursor', async () => {
    const w = await world(['SUBMITTED', 'SUBMITTED', 'SUBMITTED']);
    const first = await get(w.periodId, `?unit_id=${w.unitId}&state=SUBMITTED&limit=2`);
    expect(codes(first)).toEqual([w.projects[0]?.code, w.projects[1]?.code]);
    expect(typeof first.json.next_cursor).toBe('string');
    const rest = await get(w.periodId, `?unit_id=${w.unitId}&state=SUBMITTED&limit=2&cursor=${first.json.next_cursor as string}`);
    expect(codes(rest)).toEqual([w.projects[2]?.code]);
    expect(rest.json.next_cursor).toBeNull();
    for (const [query, detail] of [['?unit_id=nope', 'unit_id'], ['?state=NOPE', 'state'], ['?with_narrative=true', 'with_narrative'], ['?state=DRAFT&with_narrative=maybe', 'with_narrative'], ['?state=DRAFT&limit=0', 'limit'], ['?state=DRAFT&cursor=nope', 'cursor']] as const) {
      expect(await get(w.periodId, query)).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail } });
    }
  });
});
