import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, QmsDiaryCoverageJob, QmsDiaryCoverageReads, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { coverageRange, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { qmsModule } from '../../src/modules/qms';
import { DiaryCoverageController } from '../../src/modules/qms/coverage.controller';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const ROOT = 1;
const READER = 21; // diary.read over the whole tenant
const NOBODY = 22;
const ELSEWHERE = 23; // diary.read over another branch only
const OTHER_BRANCH = 5;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Day {
  date: string;
  state: string;
  diary_id: string | null;
  status: string | null;
  conflict: boolean;
  signed_on: string | null;
  working_days_to_sign: number | null;
  late_days: number;
}

class Gauges implements MetricsSink {
  readonly values: Array<{ name: string; value: number; labels: Record<string, string> | undefined }> = [];
  increment(): void {
    return undefined;
  }
  gauge(name: string, value: number, labels?: Record<string, string>): void {
    this.values.push({ name, value, labels });
  }
}

const june = (day: number): string => `2026-06-${String(day).padStart(2, '0')}`;
// June 2026: Monday the 1st to Tuesday the 30th, 22 working days.
const WORKING_JUNE = [1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 15, 16, 17, 18, 19, 22, 23, 24, 25, 26, 29, 30];
const MISSING = [11, 18, 25, 30];
const DRAFTS = [5, 12, 19];
const CONFLICTS = [9, 10];

describe('the coverage of the site diary of a contract over HTTP (ST-QMS-008, UAT-AC364)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let counter = 0;
  let operations = 0;
  let contractor = '';

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const operation = (): string => `00000000-0000-4000-8000-${String((operations += 1)).padStart(12, '0')}`;
  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);

  async function coverage(member: number, contractId: string, query = ''): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}/contracts/${contractId}/site-diaries/coverage${query}`, { headers: { [TENANT_HEADER]: tokenOf(member) } });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  interface Contract {
    id: string;
    projectId: string;
  }

  async function contract(status = 'ACTIVE'): Promise<Contract> {
    counter += 1;
    const line = await world.publishedLine();
    const id = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
            created_by, updated_by, signed_on, effective_from, status_reason, status_decision_document_version_id)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', $7, 1, 'Contract', 'OTHER', false, true, 1000000, $8, $8, date '2026-01-01', date '2026-01-02', null, null)`,
        [TENANT_A, id, line.projectId, randomUUID(), contractor, `HD-C-${String(counter).padStart(4, '0')}`, status, memberId(READER)],
      ],
    ]);
    return { id, projectId: line.projectId };
  }

  /** A diary of a day in the status given; a signed one carries the signature of the contractor at `signedAt` (an instant) when that is given. */
  async function diary(target: Contract, date: string, status: string, options: { signedAt?: string; conflictOf?: string; correctionOf?: string } = {}): Promise<string> {
    const id = randomUUID();
    counter += 1;
    await seedAs(harness, [
      [
        `insert into machvon.site_diary (tenant_id, id, project_id, contract_id, record_date, client_operation_id, content, author_id, version, diary_no, status, conflict_of_id, conflict_state, correction_of_id, correction_reason, content_hash, locked_at, locked_by, created_by, updated_by)
         values ($1, $2, $3, $4, $5::date, $6, '{"summary": "x"}'::jsonb, $7, 1, $8, $9, $10::uuid, $11, $12::uuid, case when $12::uuid is not null then 'The quantity was written wrong.' end, case when $9 <> 'DRAFT' then repeat('a', 64) end, case when $9 in ('SUPERSEDED', 'LOCKED') then now() end, case when $9 in ('SUPERSEDED', 'LOCKED') then $7::uuid end, $7, $7)`,
        [TENANT_A, id, target.projectId, target.id, date, operation(), memberId(READER), `NK-${counter}-${id.slice(0, 6)}`, status, options.conflictOf ?? null, options.conflictOf === undefined ? 'NONE' : 'CONFLICT_PENDING', options.correctionOf ?? null],
      ],
    ]);
    if (options.signedAt !== undefined) {
      await seedAs(harness, [
        [
          `insert into machvon.qms_signature (tenant_id, id, subject_kind, subject_id, signer_role, membership_id, signer_name_snapshot, method, legal_effect, cert_serial, signed_content_hash, signed_at, client_operation_id, created_by)
           values ($1, gen_random_uuid(), 'SITE_DIARY', $2, 'CONTRACTOR', $3, 'Contractor', 'IN_APP_OTP', 'INTERNAL_RECORD', null, repeat('a', 64), $4::timestamptz, $5, $3)`,
          [TENANT_A, id, memberId(READER), options.signedAt, operation()],
        ],
      ]);
    }
    return id;
  }

  /** The month of the UAT: 15 signed (one of them late, one replaced by a correction), 3 in DRAFT, 4 missing, 2 with a copy of a device that nobody settled, and a diary on a Saturday. */
  async function june2026(): Promise<{ target: Contract; byDay: Map<number, string> }> {
    const target = await contract();
    const byDay = new Map<number, string>();
    for (const day of WORKING_JUNE) {
      if (MISSING.includes(day)) continue;
      const date = june(day);
      if (DRAFTS.includes(day)) {
        byDay.set(day, await diary(target, date, 'DRAFT'));
      } else if (day === 4) {
        // Signed on the 10th: four working days after the day, three beyond the one that is allowed.
        byDay.set(day, await diary(target, date, 'CONTRACTOR_SIGNED', { signedAt: '2026-06-10T03:00:00Z' }));
      } else if (day === 8) {
        // The first diary was signed in time and replaced by a correction that was signed weeks later: the lateness is the first signature's.
        const original = await diary(target, date, 'SUPERSEDED', { signedAt: '2026-06-08T09:00:00Z' });
        byDay.set(day, await diary(target, date, 'LOCKED', { correctionOf: original, signedAt: '2026-06-30T03:00:00Z' }));
      } else {
        // 03:00 UTC is ten in the morning in Vietnam, on the day itself; a signature at 17:30 UTC is half past midnight of the next day there.
        byDay.set(day, await diary(target, date, day === 17 ? 'SUPERVISED' : 'CONTRACTOR_SIGNED', { signedAt: day === 3 ? '2026-06-03T17:30:00Z' : `${date}T03:00:00Z` }));
      }
    }
    for (const day of CONFLICTS) await diary(target, june(day), 'DRAFT', { conflictOf: byDay.get(day) ?? '' });
    await diary(target, june(6), 'CONTRACTOR_SIGNED', { signedAt: '2026-06-06T03:00:00Z' });
    return { target, byDay };
  }

  const days = (reply: Reply): Day[] => reply.json.days as Day[];

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of [READER, NOBODY, ELSEWHERE]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedRole(TENANT_A, 101, 'QMS_COVERAGE_READER', ['diary.read'], 10);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: READER, role: 101, kind: 'TENANT' },
      { n: 2, member: ELSEWHERE, role: 101, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
    ]);
    contractor = await seedContractor(harness);
    await world.owner(
      `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
       select $1, gen_random_uuid(), 'WORKDAY_VN', y, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019, Article 112', 'Published', $2, $2, now() from unnest(array[2026, 2027]) as y`,
      [TENANT_A, memberId(READER)],
    );
    // The year in which a diary of 2026 is signed late: the first Monday of it is a holiday.
    await world.owner(
      `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
       values ($1, gen_random_uuid(), 'WORKDAY_VN', 2028, 1, '[1,2,3,4,5]'::jsonb, '[{"date": "2028-01-03", "name": "Holiday"}]'::jsonb, '[]'::jsonb, 'Labour Code 2019, Article 112', 'Published', $2, $2, now())`,
      [TENANT_A, memberId(READER)],
    );
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [DiaryCoverageController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await world.stop();
  }, 60_000);

  it('is registered in the module of QMS', () => {
    expect(qmsModule.controllers).toContain(DiaryCoverageController);
  });

  it('AC-ST-QMS-008-1, UAT-AC364: the 22 working days of June split into 15 signed, 3 DRAFT and 4 missing, the 2 days with a copy are counted apart, and a late signature shows its late days', async () => {
    const { target, byDay } = await june2026();
    const reply = await coverage(READER, target.id, '?from=2026-06-01&to=2026-06-30');
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({
      contract_id: target.id,
      calendar_code: 'WORKDAY_VN',
      from: '2026-06-01',
      to: '2026-06-30',
      through: '2026-06-30',
      totals: { working_days: 22, with_diary: 18, signed: 15, draft: 3, missing: 4, late: 1, conflict: 2 },
      missing_dates: MISSING.map(june),
    });
    expect(days(reply)).toHaveLength(22);
    expect(days(reply).find((day) => day.date === june(4))).toMatchObject({ state: 'SIGNED', diary_id: byDay.get(4), signed_on: '2026-06-10', working_days_to_sign: 4, late_days: 3 });
    // The correction replaces the original on the 8th, and the first signature is the one that counts.
    expect(days(reply).find((day) => day.date === june(8))).toMatchObject({ diary_id: byDay.get(8), signed_on: '2026-06-08', working_days_to_sign: 0, late_days: 0 });
    expect(days(reply).filter((day) => day.conflict).map((day) => day.date)).toEqual(CONFLICTS.map(june));
    expect(days(reply).find((day) => day.date === june(5))).toMatchObject({ state: 'DRAFT', status: 'DRAFT', signed_on: null, working_days_to_sign: null, late_days: 0 });
    expect(days(reply).find((day) => day.date === june(11))).toMatchObject({ state: 'MISSING', diary_id: null, status: null });
    // The Saturday has a diary and no place among the working days.
    expect(days(reply).map((day) => day.date)).not.toContain(june(6));
    // A signature half past midnight of the next day in Vietnam is the next working day: in time.
    expect(days(reply).find((day) => day.date === june(3))).toMatchObject({ signed_on: june(4), working_days_to_sign: 1, late_days: 0 });
  });

  it('shows a diary signed afterwards on a missing day as signed and late, and one day fewer missing', async () => {
    const { target } = await june2026();
    await diary(target, june(11), 'CONTRACTOR_SIGNED', { signedAt: '2026-06-17T03:00:00Z' });
    const reply = await coverage(READER, target.id, '?from=2026-06-01&to=2026-06-30');
    expect(reply.json).toMatchObject({ totals: { missing: 3, signed: 16, late: 2 }, missing_dates: [18, 25, 30].map(june) });
    expect(days(reply).find((day) => day.date === june(11))).toMatchObject({ state: 'SIGNED', working_days_to_sign: 4, late_days: 3 });
  });

  it('keeps the diary that stands while its correction is still open: the correction takes its place when it is locked', async () => {
    const target = await contract();
    const original = await diary(target, june(2), 'LOCKED', { signedAt: `${june(2)}T03:00:00Z` });
    const open = await diary(target, june(2), 'SUPERVISED', { correctionOf: original, signedAt: '2026-06-09T03:00:00Z' });
    const before = await coverage(READER, target.id, '?from=2026-06-02&to=2026-06-02');
    expect(days(before)).toEqual([expect.objectContaining({ date: june(2), diary_id: original, status: 'LOCKED', signed_on: june(2), late_days: 0 })]);
    expect(before.json).toMatchObject({ totals: { signed: 1, draft: 0, missing: 0 } });
    // The correction is locked and the original is superseded in the same step: the day is the correction's, and the first signature still counts.
    await rows("update machvon.site_diary set status = 'SUPERSEDED' where id = $1", [original]);
    await rows("update machvon.site_diary set status = 'LOCKED', locked_at = now(), locked_by = author_id where id = $1", [open]);
    const after = await coverage(READER, target.id, '?from=2026-06-02&to=2026-06-02');
    expect(days(after)).toEqual([expect.objectContaining({ date: june(2), diary_id: open, status: 'LOCKED', signed_on: june(2), late_days: 0 })]);
  });

  it('judges a signature years afterwards by the calendars of the years it spans, and not by the weekdays', async () => {
    const target = await contract();
    await diary(target, june(30), 'CONTRACTOR_SIGNED', { signedAt: '2028-01-04T03:00:00Z' });
    const reply = await coverage(READER, target.id, '?from=2026-06-30&to=2026-06-30');
    // The weekdays after the 30th of June 2026 up to the 4th of January 2028, less the holiday of the 3rd.
    let weekdays = 0;
    for (let day = Date.UTC(2026, 5, 31); day <= Date.UTC(2028, 0, 4); day += 86_400_000) {
      const weekday = new Date(day).getUTCDay();
      if (weekday !== 0 && weekday !== 6) weekdays += 1;
    }
    expect(days(reply)).toEqual([expect.objectContaining({ date: june(30), signed_on: '2028-01-04', working_days_to_sign: weekdays - 1, late_days: weekdays - 2 })]);
  });

  it('counts a copy of a device that waits for the diary that was replaced by a correction', async () => {
    const target = await contract();
    const original = await diary(target, june(3), 'SUPERSEDED', { signedAt: '2026-06-03T03:00:00Z' });
    await diary(target, june(3), 'LOCKED', { correctionOf: original, signedAt: '2026-06-03T04:00:00Z' });
    await diary(target, june(3), 'DRAFT', { conflictOf: original });
    const reply = await coverage(READER, target.id, '?from=2026-06-03&to=2026-06-03');
    expect(reply.json).toMatchObject({ totals: { signed: 1, conflict: 1 } });
    expect(days(reply)[0]).toMatchObject({ conflict: true, status: 'LOCKED' });
  });

  it('counts the month up to today when no range is given, and nothing that lies ahead', async () => {
    const target = await contract();
    const reply = await coverage(READER, target.id);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    expect(reply.json).toMatchObject({ from: `${today.slice(0, 8)}01`, to: today, through: today });
    const ahead = await coverage(READER, target.id, '?from=2999-01-01&to=2999-01-31');
    expect(ahead.json).toMatchObject({ through: null, totals: { working_days: 0, missing: 0 }, days: [], missing_dates: [] });
  });

  it('refuses a range that is not one (422 naming the field) and a year with no published calendar (422 CALENDAR_NOT_EFFECTIVE)', async () => {
    const target = await contract();
    for (const [query, field] of [
      ['?from=2026-06-31', 'from'],
      ['?to=30/06/2026', 'to'],
      ['?from=2026-06-30&to=2026-06-01', 'from'],
      ['?from=2025-01-01&to=2026-06-30', 'to'],
    ] as const) {
      const reply = await coverage(READER, target.id, query);
      expect([reply.status, reply.json.code, reply.json.detail ?? reply.json.field]).toEqual([422, 'VALIDATION_FAILED', field]);
    }
    const noCalendar = await coverage(READER, target.id, '?from=2025-12-01&to=2025-12-31');
    expect([noCalendar.status, noCalendar.json.code]).toEqual([422, 'CALENDAR_NOT_EFFECTIVE']);
  });

  it('shows a contract only to those whose scope reaches it: the right is needed (403), a contract out of reach or unknown is 404', async () => {
    const target = await contract();
    expect((await coverage(NOBODY, target.id)).status).toBe(403);
    expect((await coverage(ELSEWHERE, target.id)).status).toBe(404);
    expect((await coverage(READER, randomUUID())).status).toBe(404);
    expect((await coverage(READER, 'not-a-uuid')).status).toBe(422);
  });

  describe('the morning count (the job diary-coverage)', () => {
    it('sets the gauge of the missing days of the month up to yesterday for the contracts in execution, and leaves a contract that is not in execution out', async () => {
      const { target } = await june2026();
      const idle = await contract('DRAFT');
      const gauges = new Gauges();
      const tenants = harness.tenants as TenantDatabase;
      const worker = { tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 };
      // 06:00 on the 1st of July in Vietnam is the evening before in UTC: the month counted is June, up to the 30th.
      const done = await tenants.withTenant(worker, (tx) => new QmsDiaryCoverageJob(gauges).run(tx, new Date('2026-06-30T23:00:00Z')));
      const active = (await rows<{ id: string }>("select id from machvon.contract where status = 'ACTIVE'")).map((row) => row.id);
      expect(active).toContain(target.id);
      expect(active).not.toContain(idle.id);
      let expected = 0;
      for (const id of active) expected += (await tenants.withTenant(worker, (tx) => new QmsDiaryCoverageReads().coverage(tx, id, coverageRange('2026-06-01', '2026-06-30', '2026-06-30')))).totals.missing;
      expect(done).toEqual({ contracts: active.length, missing: expected });
      expect(expected).toBeGreaterThanOrEqual(4);
      expect(gauges.values).toEqual([{ name: 'qms_diary_missing_days', value: expected, labels: { tenant_id: TENANT_A } }]);
    });
  });
});
