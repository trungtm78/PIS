import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, readTabularFile, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { AnalyticsCertificationController } from '../../src/modules/bi/certification.controller';
import { CommandCenterController } from '../../src/modules/home/command-center.controller';
import { HomeChangesController } from '../../src/modules/home/changes.controller';
import { HomeDrillController } from '../../src/modules/home/drill.controller';
import { KpiRegisterController } from '../../src/modules/home/kpi-register.controller';
import { RagController } from '../../src/modules/home/rag.controller';
import { HOME_CLOCK, HOME_CONTEXT_KEY } from '../../src/modules/home/tokens';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const CONTEXT_KEY = randomBytes(32);
const LEADER = 1; // holds every right of the lane over the whole tenant
const CERTIFIER = 2; // a second pair of eyes
const BRANCH = 3; // reads and overrides in the north only
const NOBODY = 4; // holds no right
const B_LEADER = 1;
const ROOT = 1;
const NORTH = 2;
const SOUTH = 3;
const FAMILY = 0xa7;
const NOW = new Date('2027-10-15T03:00:00Z');
const BEFORE = new Date('2027-10-06T03:00:00Z');
const ALL = ['home.read', 'bi.admin.read', 'analytics.certify', 'home.rag.override', 'home.rag.score'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}
type Tile = {
  metric_code: string;
  value: string | null;
  display_value: string | null;
  numerator: string | null;
  null_reason: string | null;
  flags: string[];
  certification: { status: string; version: number; origin: string } | null;
  kpi: { code: string; name: string; formula: string; source: string; owner: string; version: number; asOf: string; unverified: boolean } | null;
  context_token: string;
};
type Unit = { unit_id: string; code: string; band: string; rule_band: string; overridden: boolean; override: { reason: string; band: string } | null; score: number | null; coverage_pct: number; reasons: Array<{ code: string; points: number }>; previous: { score: number | null; band: string } | null };

/** The analytics governance of HOME and BI over HTTP: the register behind every number, certification before a leader sees it, explainable colours with overrides, the weekly score, and "what changed since last week" (G0-4, G3-1 to G3-4). */
describe('the analytics governance over HTTP (G0-4, G3-1, G3-2, G3-3, G3-4)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let clock = NOW;
  let counter = 0;
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member?: number; tenantId?: string; body?: unknown; key?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? LEADER, options.tenantId), 'content-type': 'application/json' };
    if (method === 'POST') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const get = (url: string, member?: number, tenantId?: string): Promise<Reply> => call('GET', url, { ...(member === undefined ? {} : { member }), ...(tenantId === undefined ? {} : { tenantId }) });
  const post = (url: string, body: unknown, member?: number, key?: string): Promise<Reply> => call('POST', url, { body, ...(member === undefined ? {} : { member }), ...(key === undefined ? {} : { key }) });
  const center = (query = '', member = LEADER): Promise<Reply> => get(`/home/command-center${query}`, member);
  const tiles = (reply: Reply): Tile[] => reply.json.tiles as Tile[];
  const tile = (reply: Reply, code: string): Tile => [...tiles(reply), ...(reply.json.count_tiles as Tile[])].find((candidate) => candidate.metric_code === code) as Tile;
  const certify = (key: string, version: number, to: string, member: number, note?: string): Promise<Reply> => post('/bi/certifications/transitions', { subject: 'KPI', key, version, to, ...(note === undefined ? {} : { note }) }, member);
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

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
  async function insert(table: string, values: Record<string, unknown>, tenant = TENANT_A): Promise<string> {
    const rowId = (values.id as string | undefined) ?? randomUUID();
    await admin(async (client) => {
      const columns = (
        await client.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null; is_generated: string }>(
          `select column_name, data_type, is_nullable, column_default, is_generated from information_schema.columns where table_schema = 'machvon' and table_name = $1`,
          [table],
        )
      ).rows;
      const all: Record<string, unknown> = { tenant_id: tenant, id: rowId, ...values };
      const json = new Set(columns.filter((column) => column.data_type === 'jsonb').map((column) => column.column_name));
      for (const column of columns) {
        if (column.column_name in all || column.is_generated === 'ALWAYS' || column.is_nullable === 'YES' || column.column_default !== null) continue;
        all[column.column_name] = column.data_type === 'uuid' ? randomUUID() : ['integer', 'smallint', 'bigint', 'numeric'].includes(column.data_type) ? 1 : column.data_type === 'boolean' ? false : column.data_type === 'date' ? '2027-10-15' : column.data_type.startsWith('timestamp') ? NOW.toISOString() : column.data_type === 'jsonb' ? {} : column.data_type === 'ARRAY' ? [] : 'text-value';
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
  const day = (offset: number): string => new Date(Date.UTC(2046, 0, 2) + offset * 86_400_000).toISOString().slice(0, 10);

  /** A project of a unit with a line in a snapshot: 1000 from the Prime Minister, 250 added, `paid` paid by the Treasury (null: the Treasury booked nothing). */
  async function project(snapshotId: string, unit: number, paid: string | null, projectId?: string): Promise<string> {
    counter += 1;
    const pid = projectId ?? id(FAMILY, 500 + counter);
    if (projectId === undefined) await insert('project', { id: pid, code: `AG-${counter}`, name: `AG-${counter}`, owner_unit_id: unitId(unit), classification: 'INTERNAL', total_investment_vnd: 1000, status: 'IMPLEMENTATION', version: 1, project_group: 'B' });
    await admin(async (client) => {
      await client.query(
        `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, disbursed_treasury_vnd, treasury_coverage)
         values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', 1000000000000, 250000000000, 1250000000000, $5::numeric, $6)`,
        [TENANT_A, snapshotId, pid, unitId(unit), paid, paid === null ? 'NONE' : 'COMPLETE'],
      );
    });
    return pid;
  }
  async function snapshot(options: { asOf: string; frozenAt: string }): Promise<string> {
    counter += 1;
    const periodId = id(FAMILY, 2000 + counter);
    const snapshotId = randomUUID();
    await admin(async (client) => {
      await client.query(
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, $3, 1, $4::date, $4::date + 6, now(), 'DEFAULT', 'WEEK', 2027, 'OPEN', $5, $6, $6)`,
        [TENANT_A, periodId, `AGP-${counter}`, day(counter * 7), id(FAMILY, 40), WORKER_MEMBERSHIP_ID],
      );
      await client.query(
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, payload_sha256, frozen_by, frozen_at, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', $4::timestamptz, $5::date, $5::date, 'FROZEN', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', 1, repeat('a', 64), $6::uuid, $7::timestamptz, $6, $6)`,
        [TENANT_A, snapshotId, periodId, options.frozenAt, options.asOf, WORKER_MEMBERSHIP_ID, options.frozenAt],
      );
    });
    return snapshotId;
  }
  async function criticalWarning(projectId: string): Promise<void> {
    const ruleId = await insert('early_warning_rule', { rule_code: `EW-${randomUUID().slice(0, 6).toUpperCase()}`, name: 'Rule', metric_code: 'YTD_RATE_GAP', comparator: 'GTE', threshold_json: { points: 10 }, severity: 'CRITICAL', scope_kind: 'PROJECT', status: 'PUBLISHED', revision: 1, effective_from: '2027-01-01', approved_by: memberId(CERTIFIER), created_by: memberId(LEADER), version: 1 });
    await insert('early_warning', { rule_id: ruleId, project_id: projectId, severity: 'CRITICAL', observed_json: {}, dedupe_key: `k-${randomUUID()}`, status: 'OPEN', opened_at: NOW.toISOString(), version: 1 });
  }
  /** A version a tenant approved for the definition of the first rate: it governs from the start of the year and says the same words under a new name. */
  const approvedVersion = (code: string, version: number): Promise<string> =>
    insert('governance_rule', {
      rule_type: 'KPI_DEFINITION',
      code,
      version,
      status: 'APPROVED',
      params: { name: 'Tỷ lệ giải ngân (bản của tỉnh)', formula: 'Số Kho bạc đã chi chia kế hoạch Thủ tướng giao', source: 'DIS', unit: 'PERCENT', owner: 'CAPITAL_PLANNER', decimals: 1, refresh_hours: 24, allowed_lag_days: 8 },
      effective_from: '2027-01-01',
      reason: 'The province keeps its own wording',
      created_by: memberId(LEADER),
      submitted_by: memberId(LEADER),
      submitted_at: NOW.toISOString(),
      approved_by: memberId(CERTIFIER),
      approved_at: NOW.toISOString(),
    });
  const wipe = (): Promise<void> =>
    admin(async (client) => {
      for (const table of ['analytics_certification', 'early_warning_score', 'rag_override', 'governance_rule', 'bi_dataset', 'early_warning', 'early_warning_rule', 'explanation_request', 'reallocation_proposal', 'period_snapshot_line', 'period_snapshot', 'project']) {
        await client.query(`delete from machvon.${table}`);
      }
    });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: NORTH, path: `/${unitId(ROOT)}/${unitId(NORTH)}/`, parent: ROOT },
        { n: SOUTH, path: `/${unitId(ROOT)}/${unitId(SOUTH)}/`, parent: ROOT },
      ]);
    }
    for (const n of [LEADER, CERTIFIER, BRANCH, NOBODY]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_LEADER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'ANALYTICS_ALL', ALL, 20);
    await harness.seedRole(TENANT_A, 2, 'ANALYTICS_BRANCH', ['home.read', 'home.rag.override'], 20);
    await harness.seedRole(TENANT_B, 1, 'ANALYTICS_ALL', ALL, 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: LEADER, role: 1, kind: 'TENANT' },
      { n: 2, member: CERTIFIER, role: 1, kind: 'TENANT' },
      { n: 3, member: BRANCH, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(NORTH)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_LEADER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [CommandCenterController, KpiRegisterController, RagController, HomeChangesController, HomeDrillController, AnalyticsCertificationController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: HOME_CLOCK, useValue: () => clock },
        { provide: HOME_CONTEXT_KEY, useValue: CONTEXT_KEY },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  beforeEach(async () => {
    clock = NOW;
    await wipe();
  });

  /** Two units with a week of figures: the north on pace, the south not. */
  async function twoWeeks(): Promise<{ first: string; second: string; southProject: string }> {
    const first = await snapshot({ asOf: '2027-10-05', frozenAt: '2027-10-06T03:00:00Z' });
    await project(first, NORTH, '800000000000');
    const southProject = await project(first, SOUTH, '800000000000');
    clock = BEFORE;
    expect((await post('/home/rag/scores', {})).json).toMatchObject({ status: 'SCORED', resource_version: 2 });
    clock = NOW;
    const second = await snapshot({ asOf: '2027-10-12', frozenAt: '2027-10-13T03:00:00Z' });
    await project(second, NORTH, '800000000000', (await rows<{ id: string }>(`select id from machvon.project where owner_unit_id = $1`, [unitId(NORTH)]))[0]?.id);
    await project(second, SOUTH, '400000000000', southProject);
    for (let n = 0; n < 3; n += 1) await criticalWarning(southProject);
    return { first, second, southProject };
  }

  describe('the register behind every number (G0-4)', () => {
    it('gives every tile its one definition, certification and flags, and the counts as figures of the register too', async () => {
      const frozen = await snapshot({ asOf: '2027-10-12', frozenAt: NOW.toISOString() });
      await project(frozen, NORTH, '600000000000');
      await project(frozen, SOUTH, '600000000000');
      const reply = await center();
      expect(reply.status).toBe(200);
      const pm = tile(reply, 'DISBURSEMENT_RATE_PM');
      // The raw text keeps four places (the old reading); the text every channel writes is the register's: two places.
      expect([pm.value, pm.display_value]).toEqual(['60.0000', '60.00']);
      expect(pm.kpi).toMatchObject({ code: 'DISBURSEMENT_RATE_PM', version: 0, owner: 'CAPITAL_PLANNER', asOf: '2027-10-12', unverified: true });
      expect(pm.kpi?.formula).toContain('Kho bạc');
      expect(pm.kpi?.source).toContain('giải ngân');
      expect(pm.certification).toMatchObject({ status: 'CERTIFIED', version: 0, origin: 'PLATFORM' });
      expect(pm.flags).toContain('UNVERIFIED_DEFINITION');
      expect(pm.flags).not.toContain('NO_DATA');
      const counts = reply.json.count_tiles as Tile[];
      expect(counts.map((each) => each.metric_code)).toEqual(['OPEN_WARNINGS', 'OVERDUE_EXPLANATIONS', 'PENDING_REALLOCATIONS']);
      expect(counts.map((each) => each.display_value)).toEqual(['0', '0', '0']);
      expect(reply.json.open_warnings).toBe(0);
    });

    it('lists the register with each definition, its version and its certification, to a reader of HOME', async () => {
      const reply = await get('/home/kpi-register');
      expect(reply.status).toBe(200);
      const codes = (reply.json.definitions as Array<{ code: string }>).map((each) => each.code);
      expect(codes).toEqual(['DISBURSED_TREASURY', 'DISBURSEMENT_RATE', 'DISBURSEMENT_RATE_PM', 'DISBURSEMENT_RATE_TOTAL', 'OPEN_WARNINGS', 'OVERDUE_EXPLANATIONS', 'PENDING_REALLOCATIONS', 'PHYSICAL_PROGRESS', 'PLAN_PM_ASSIGNED', 'PLAN_TOTAL']);
      const rate = (reply.json.definitions as Array<Record<string, unknown>>).find((each) => each.code === 'DISBURSEMENT_RATE_PM') as Record<string, unknown>;
      expect(rate).toMatchObject({ unit: 'PERCENT', decimals: 2, version: 0, origin: 'DEFAULT', unverified: true, allowed_lag_days: 8, rag_code: 'DISBURSEMENT_RATIO' });
      expect(rate.numerator).toEqual(expect.any(String));
      expect(rate.exclusions).toEqual(expect.any(Array));
      expect((await get('/home/kpi-register?as_of=not-a-day')).status).toBe(422);
      expect((await get('/home/kpi-register', NOBODY)).status).toBe(403);
    });

    it('gives the same text on the screen, in the file as CSV and as Excel, and the phone reads the same field (no last digit apart)', async () => {
      const frozen = await snapshot({ asOf: '2027-10-12', frozenAt: NOW.toISOString() });
      await project(frozen, NORTH, '333333333333');
      await project(frozen, SOUTH, null);
      const screen = await center();
      const figures = [...tiles(screen), ...(screen.json.count_tiles as Tile[])];
      for (const format of ['CSV', 'XLSX']) {
        const exported = await get(`/home/command-center/export?format=${format}`);
        expect(exported.status).toBe(200);
        expect(exported.json).toMatchObject({ format, snapshot_id: frozen, rows: figures.length });
        const bytes = new Uint8Array(Buffer.from(exported.json.content_base64 as string, 'base64'));
        expect(exported.json.sha256).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
        const file = readTabularFile(bytes);
        expect(file.format).toBe(format);
        // The columns read are the code, the name and the text of the value: what the screen and the phone show of each figure.
        for (const figure of figures) {
          const line = file.rows.find((row) => row[0] === figure.metric_code);
          expect(line).toBeDefined();
          expect(line?.[2]).toBe(figure.display_value ?? '');
        }
      }
      // The Treasury booked nothing for one of two projects: the rate is made from what is there, and a missing figure is an empty cell with its reason, never 0.
      expect(tile(screen, 'DISBURSED_TREASURY').display_value).toBe('333333333333');
      expect((await get('/home/command-center/export?format=PDF')).status).toBe(422);
      expect((await get('/home/command-center/export', NOBODY)).status).toBe(403);
      const audited = await rows<{ n: string }>(`select count(*)::text as n from machvon.audit_event where action = 'home.figures_exported'`);
      expect(Number(audited[0]?.n)).toBe(2);
    });

    it('writes an empty cell and its reason when there is no figure, never a zero', async () => {
      const frozen = await snapshot({ asOf: '2027-10-12', frozenAt: NOW.toISOString() });
      await project(frozen, NORTH, null);
      const screen = await center();
      const pm = tile(screen, 'DISBURSEMENT_RATE_PM');
      expect(pm.value).toBeNull();
      expect(pm.display_value).toBeNull();
      expect(pm.flags).toContain('NO_DATA');
      const file = readTabularFile(new Uint8Array(Buffer.from(((await get('/home/command-center/export?format=CSV')).json.content_base64 as string), 'base64')));
      expect(file.rows.find((row) => row[0] === 'DISBURSEMENT_RATE_PM')?.[2]).toBe('');
    });
  });

  describe('certification before a leader sees a figure (G3-1)', () => {
    it('holds back a figure whose definition is not certified, as no value with its reason (never 0), until a second person certifies it', async () => {
      const frozen = await snapshot({ asOf: '2027-10-12', frozenAt: NOW.toISOString() });
      await project(frozen, NORTH, '600000000000');
      await approvedVersion('DISBURSEMENT_RATE_PM', 1);
      const held = tile(await center(), 'DISBURSEMENT_RATE_PM');
      expect(held).toMatchObject({ value: null, display_value: null, numerator: null, null_reason: 'NOT_CERTIFIED' });
      expect(held.certification).toMatchObject({ status: 'DRAFT', version: 1, origin: 'TENANT' });
      expect(held.flags).toEqual(expect.arrayContaining(['NOT_CERTIFIED']));
      expect(held.flags).not.toContain('NO_DATA');
      expect(held.kpi?.version).toBe(1);
      // The other figures are not held.
      expect(tile(await center(), 'DISBURSEMENT_RATE_TOTAL').value).not.toBeNull();

      expect(await certify('DISBURSEMENT_RATE_PM', 1, 'CERTIFIED', LEADER)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      const confirmed = await certify('DISBURSEMENT_RATE_PM', 1, 'CONFIRMED', LEADER);
      expect(confirmed).toMatchObject({ status: 200, json: { status: 'CONFIRMED' } });
      expect(tile(await center(), 'DISBURSEMENT_RATE_PM').null_reason).toBe('NOT_CERTIFIED');
      // The one who confirmed does not certify.
      expect(await certify('DISBURSEMENT_RATE_PM', 1, 'CERTIFIED', LEADER)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await certify('DISBURSEMENT_RATE_PM', 1, 'CERTIFIED', CERTIFIER)).toMatchObject({ status: 200, json: { status: 'CERTIFIED' } });
      const shown = tile(await center(), 'DISBURSEMENT_RATE_PM');
      expect(shown).toMatchObject({ value: '60.0000', display_value: '60.0' });
      expect(shown.certification).toMatchObject({ status: 'CERTIFIED', version: 1 });
      expect(shown.flags).not.toContain('NOT_CERTIFIED');
      // Making it obsolete needs words, and then it is held back again.
      expect(await certify('DISBURSEMENT_RATE_PM', 1, 'OBSOLETE', CERTIFIER)).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await certify('DISBURSEMENT_RATE_PM', 1, 'OBSOLETE', CERTIFIER, 'The wording was replaced by the circular')).toMatchObject({ status: 200, json: { status: 'OBSOLETE' } });
      expect(tile(await center(), 'DISBURSEMENT_RATE_PM')).toMatchObject({ value: null, null_reason: 'OBSOLETE' });
      // The log tells the whole life, once for each move.
      const log = await get('/bi/certifications/KPI/DISBURSEMENT_RATE_PM/log');
      expect((log.json.lines as Array<{ status: string }>).map((line) => line.status)).toEqual(['CONFIRMED', 'CERTIFIED', 'OBSOLETE']);
      const audited = await rows<{ n: string }>(`select count(*)::text as n from machvon.audit_event where action = 'bi.certification_moved'`);
      expect(Number(audited[0]?.n)).toBe(3);
    });

    it('refuses what is not in force: the built-in version, a version nobody approved, an unknown code, a word that is not a move, a missing right', async () => {
      expect(await certify('DISBURSEMENT_RATE_PM', 0, 'CONFIRMED', LEADER)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      await approvedVersion('DISBURSEMENT_RATE_PM', 1);
      expect(await certify('DISBURSEMENT_RATE_PM', 2, 'CONFIRMED', LEADER)).toMatchObject({ status: 409 });
      expect(await certify('NO_SUCH_KPI', 1, 'CONFIRMED', LEADER)).toMatchObject({ status: 404 });
      expect(await certify('DISBURSEMENT_RATE_PM', 1, 'FINISHED', LEADER)).toMatchObject({ status: 422 });
      expect(await certify('DISBURSEMENT_RATE_PM', 1, 'CONFIRMED', BRANCH)).toMatchObject({ status: 403 });
      expect(await certify('DISBURSEMENT_RATE_PM', 1, 'CONFIRMED', NOBODY)).toMatchObject({ status: 403 });
      expect(await certify('DISBURSEMENT_RATE_PM', 1, 'DRAFT', LEADER, 'x')).toMatchObject({ status: 409 });
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.analytics_certification'))[0]?.n).toBe('0');
    });

    it('is idempotent: the same key and the same move are one line', async () => {
      await approvedVersion('DISBURSEMENT_RATE_PM', 1);
      const key = `replay-${randomUUID()}`;
      const first = await post('/bi/certifications/transitions', { subject: 'KPI', key: 'DISBURSEMENT_RATE_PM', version: 1, to: 'CONFIRMED' }, LEADER, key);
      const second = await post('/bi/certifications/transitions', { subject: 'KPI', key: 'DISBURSEMENT_RATE_PM', version: 1, to: 'CONFIRMED' }, LEADER, key);
      expect(second.status).toBe(200);
      expect(second.json).toEqual(first.json);
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.analytics_certification'))[0]?.n).toBe('1');
    });

    it('cannot be rewritten by the application: a line is never changed or removed', async () => {
      await approvedVersion('DISBURSEMENT_RATE_PM', 1);
      await certify('DISBURSEMENT_RATE_PM', 1, 'CONFIRMED', LEADER);
      const client = new Client({ connectionString: harness.database.urlFor('machvon_app') });
      await client.connect();
      try {
        await client.query("select set_config('app.tenant_id', $1, false)", [TENANT_A]);
        await expect(client.query(`update machvon.analytics_certification set status = 'CERTIFIED'`)).rejects.toThrow(/permission denied/);
        await expect(client.query('delete from machvon.analytics_certification')).rejects.toThrow(/permission denied/);
      } finally {
        await client.end();
      }
    });

    it('certifies a dataset the same way, for the version in force, and a changed dataset must be certified again', async () => {
      const datasetId = await insert('bi_dataset', { dataset_code: 'ds_project_snapshot', title: 'Ảnh chụp dự án', source_kind: 'PERIOD_SNAPSHOT', grain: 'project', join_paths: {}, owner_user_id: memberId(LEADER), version: 1 });
      const move = (to: string, member: number, version = 1): Promise<Reply> => post('/bi/certifications/transitions', { subject: 'DATASET', key: datasetId, version, to }, member);
      const before = (await get('/bi/certifications')).json as { datasets: Array<Record<string, unknown>>; kpis: Array<Record<string, unknown>>; metrics: unknown[] };
      expect(before.datasets).toHaveLength(1);
      expect(before.datasets[0]).toMatchObject({ code: 'ds_project_snapshot', status: 'DRAFT', version: 1, last_certified_version: null });
      expect(before.kpis).toHaveLength(10);
      expect(before.kpis.every((each) => each.status === 'CERTIFIED' && each.origin === 'PLATFORM')).toBe(true);
      expect(before.metrics).toEqual(expect.any(Array));
      expect(await move('CONFIRMED', LEADER)).toMatchObject({ status: 200 });
      expect(await move('CERTIFIED', LEADER)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await move('CERTIFIED', CERTIFIER, 2)).toMatchObject({ status: 409 });
      expect(await move('CERTIFIED', CERTIFIER)).toMatchObject({ status: 200, json: { status: 'CERTIFIED' } });
      expect(((await get('/bi/certifications')).json as { datasets: Array<Record<string, unknown>> }).datasets[0]).toMatchObject({ status: 'CERTIFIED', version: 1 });
      // The definition of the dataset moves on: the certificate of the old one is named and not carried over.
      await admin(async (client) => void (await client.query('update machvon.bi_dataset set version = 2')));
      expect(((await get('/bi/certifications')).json as { datasets: Array<Record<string, unknown>> }).datasets[0]).toMatchObject({ status: 'DRAFT', version: 2, last_certified_version: 1 });
      expect((await post('/bi/certifications/transitions', { subject: 'DATASET', key: randomUUID(), version: 1, to: 'CONFIRMED' }, LEADER)).status).toBe(404);
      expect((await post('/bi/certifications/transitions', { subject: 'DATASET', key: 'not-a-uuid', version: 1, to: 'CONFIRMED' }, LEADER)).status).toBe(422);
    });

    it('keeps tenants apart: another tenant reads no log and certifies nothing of this one', async () => {
      await approvedVersion('DISBURSEMENT_RATE_PM', 1);
      await certify('DISBURSEMENT_RATE_PM', 1, 'CONFIRMED', LEADER);
      const other = await get('/bi/certifications/KPI/DISBURSEMENT_RATE_PM/log', B_LEADER, TENANT_B);
      expect(other.json.lines).toEqual([]);
      const listing = (await get('/bi/certifications', B_LEADER, TENANT_B)).json as { datasets: unknown[]; kpis: Array<{ status: string }> };
      expect(listing.datasets).toEqual([]);
      expect(listing.kpis.every((each) => each.status === 'CERTIFIED')).toBe(true);
    });
  });

  describe('the colour that can be explained (G3-2) and what changed since last week (G3-4)', () => {
    it('writes the score of each unit once for the week, with its breakdown and the versions of the rules', async () => {
      const first = await snapshot({ asOf: '2027-10-05', frozenAt: '2027-10-06T03:00:00Z' });
      await project(first, NORTH, '800000000000');
      await project(first, SOUTH, '100000000000');
      clock = BEFORE;
      const done = await post('/home/rag/scores', {});
      expect(done).toMatchObject({ status: 200, json: { status: 'SCORED', resource_version: 2, resource_id: '2027-10-04' } });
      expect(await post('/home/rag/scores', {})).toMatchObject({ status: 200, json: { status: 'ALREADY_SCORED', resource_version: 1 } });
      const stored = await rows<{ week_start: string; band: string; score: string | null; rule_versions: Record<string, number>; breakdown: { factors: unknown[]; reasons: string[] }; snapshot_id: string }>(
        `select week_start::text as week_start, band, score::text as score, rule_versions, breakdown, snapshot_id from machvon.early_warning_score order by unit_id`,
      );
      expect(stored).toHaveLength(2);
      expect(stored.every((row) => row.week_start === '2027-10-04' && row.snapshot_id === first)).toBe(true);
      expect(stored.every((row) => row.breakdown.factors.length === 4 && Object.values(row.rule_versions).every((version) => version === 0))).toBe(true);
      expect(stored.map((row) => row.band).sort()).toEqual(['AMBER', 'GREEN']);
      expect((await rows<{ n: string }>(`select count(*)::text as n from machvon.audit_event where action = 'home.early_warning_scored'`))[0]?.n).toBe('1');
      expect((await post('/home/rag/scores', {}, BRANCH)).status).toBe(403);
    });

    it('says why a unit is red: the one to three factors with their lines, the share of data, the week before, and never green for what it cannot read', async () => {
      await twoWeeks();
      const reply = await get('/home/rag');
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ as_of_date: '2027-10-12', week_start: '2027-10-11', summary: { RED: 1, GREEN: 1, AMBER: 0, NO_DATA: 0 } });
      expect(reply.json.model).toMatchObject({ unverified: true, min_coverage_pct: 60, score_green: 25, score_amber: 45 });
      const units = reply.json.units as Unit[];
      // Red first.
      expect(units.map((unit) => unit.band)).toEqual(['RED', 'GREEN']);
      const south = units[0] as Unit;
      expect(south.unit_id).toBe(unitId(SOUTH));
      expect(south).toMatchObject({ rule_band: 'RED', overridden: false, override: null, coverage_pct: 100 });
      expect(south.score).toBe(70);
      expect(south.reasons.map((reason) => reason.code)).toEqual(['EWS_RATE_VS_PACE', 'EWS_CRITICAL_WARNINGS']);
      expect(south.reasons.reduce((sum, reason) => sum + reason.points, 0)).toBe(70);
      expect(south.previous).toMatchObject({ score: 0, band: 'GREEN' });
      expect((units[1] as Unit).reasons).toEqual([]);
      // The branch leader reads the north only: the south is not told, by name or by colour.
      const branch = (await get('/home/rag', BRANCH)).json.units as Unit[];
      expect(branch.map((unit) => unit.unit_id)).toEqual([unitId(NORTH)]);
      expect((await get(`/home/rag?unit_id=${unitId(SOUTH)}`, BRANCH)).status).toBe(403);
      expect((await get('/home/rag?unit_id=nope')).status).toBe(422);
      expect((await get('/home/rag', NOBODY)).status).toBe(403);
      expect((await get('/home/rag', B_LEADER, TENANT_B)).status).toBe(404);
    });

    it('lets a person put a colour over the rules for a time with a reason, shows both, and takes it back', async () => {
      await twoWeeks();
      const override = (body: Record<string, unknown>, member = LEADER): Promise<Reply> => post('/home/rag/overrides', { unit_id: unitId(SOUTH), band: 'GREEN', reason: 'The Treasury file of the week is late; checked by phone', until: '2027-11-20', ...body }, member);
      // Refusals first: a reason of words, the colour the rules did not give, a last day within ninety days, a unit of the person's own scope.
      expect(await override({ reason: 'short' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await override({ band: 'RED' })).toMatchObject({ status: 422 });
      expect(await override({ until: '2028-06-30' })).toMatchObject({ status: 422 });
      expect(await override({ until: '2027-10-14' })).toMatchObject({ status: 422 });
      expect(await override({}, BRANCH)).toMatchObject({ status: 403 });
      expect(await override({}, NOBODY)).toMatchObject({ status: 403 });
      expect(await override({ unit_id: randomUUID() })).toMatchObject({ status: 403 });
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.rag_override'))[0]?.n).toBe('0');

      const key = `override-${randomUUID()}`;
      const first = await post('/home/rag/overrides', { unit_id: unitId(SOUTH), band: 'GREEN', reason: 'The Treasury file of the week is late; checked by phone', until: '2027-11-20' }, LEADER, key);
      expect(first).toMatchObject({ status: 200, json: { status: 'OVERRIDDEN' } });
      expect((await post('/home/rag/overrides', { unit_id: unitId(SOUTH), band: 'GREEN', reason: 'The Treasury file of the week is late; checked by phone', until: '2027-11-20' }, LEADER, key)).json).toEqual(first.json);
      expect((await rows<{ n: string }>('select count(*)::text as n from machvon.rag_override'))[0]?.n).toBe('1');
      const south = ((await get('/home/rag')).json.units as Unit[]).find((unit) => unit.unit_id === unitId(SOUTH)) as Unit;
      // The override is shown beside the colour of the rules, never in place of it, and the reasons are still the rules'.
      expect(south).toMatchObject({ band: 'GREEN', rule_band: 'RED', overridden: true });
      expect(south.override).toMatchObject({ band: 'GREEN', reason: expect.stringContaining('Treasury') });
      expect(south.reasons.length).toBeGreaterThan(0);
      const audited = await rows<{ action: string; reason: string | null }>(`select action, reason from machvon.audit_event where action = 'home.rag_overridden'`);
      expect(audited).toHaveLength(1);
      expect(audited[0]?.reason).toContain('Treasury');
      // Taking it back needs words too, and there is one to take back once.
      expect(await post('/home/rag/overrides/revoke', { unit_id: unitId(SOUTH), reason: 'short' })).toMatchObject({ status: 422 });
      expect(await post('/home/rag/overrides/revoke', { unit_id: unitId(SOUTH), reason: 'The file arrived and the rules now agree' })).toMatchObject({ status: 200, json: { status: 'REVOKED' } });
      expect(await post('/home/rag/overrides/revoke', { unit_id: unitId(SOUTH), reason: 'The file arrived and the rules now agree' })).toMatchObject({ status: 404 });
      const after = ((await get('/home/rag')).json.units as Unit[]).find((unit) => unit.unit_id === unitId(SOUTH)) as Unit;
      expect(after).toMatchObject({ band: 'RED', overridden: false, override: null });
    });

    it('lets an override lapse on its last day', async () => {
      await twoWeeks();
      await post('/home/rag/overrides', { unit_id: unitId(SOUTH), band: 'AMBER', reason: 'Waiting for the report of the contractor', until: '2027-10-20' });
      const read = async (): Promise<Unit> => ((await get('/home/rag')).json.units as Unit[]).find((unit) => unit.unit_id === unitId(SOUTH)) as Unit;
      expect((await read()).overridden).toBe(true);
      clock = new Date('2027-10-21T03:00:00Z');
      expect(await read()).toMatchObject({ band: 'RED', overridden: false });
    });

    it('writes at most five lines, by rules from two weeks of figures, each with a link and no name', async () => {
      await twoWeeks();
      const reply = await get('/home/changes');
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ as_of_date: '2027-10-12', previous_as_of_date: '2027-10-05', reason: null, max_lines: 5 });
      const lines = reply.json.lines as Array<{ kind: string; direction: string; params: Record<string, string | number>; link: string; metric_code: string | null; context_token: string | null }>;
      expect(lines.length).toBeLessThanOrEqual(5);
      expect(lines.map((line) => line.kind)).toEqual(['UNITS_TO_RED', 'RATE_CHANGE', 'WARNINGS_DELTA']);
      expect(lines[0]).toMatchObject({ direction: 'UP', params: { count: 1 }, link: 'RAG', context_token: null });
      expect(lines[1]).toMatchObject({ direction: 'DOWN', params: { from: '80.00', to: '60.00', delta: '20.00' }, link: 'DRILL', metric_code: 'DISBURSEMENT_RATE_PM' });
      expect(lines[2]).toMatchObject({ direction: 'UP', params: { from: 0, to: 3, delta: 3 }, link: 'WARNINGS' });
      // The link of a drill is a token the drill takes back.
      expect(lines[1]?.context_token).toMatch(/^[\w-]+\.[\w-]+$/);
      expect((await get(`/home/drill?context_token=${lines[1]?.context_token}`)).status).toBe(200);
      // No name of a unit or a project is in a line.
      expect(JSON.stringify(lines)).not.toMatch(/AG-\d|North|South/);
      // The branch leader's lines are the branch's own.
      const branch = (await get('/home/changes', BRANCH)).json as { lines: Array<{ kind: string }> };
      expect(branch.lines.map((line) => line.kind)).not.toContain('UNITS_TO_RED');
      expect((await get(`/home/changes?unit_id=${unitId(SOUTH)}`, BRANCH)).status).toBe(403);
    });

    it('says there is no week before, and writes no line, when there is none', async () => {
      const only = await snapshot({ asOf: '2027-10-12', frozenAt: NOW.toISOString() });
      await project(only, NORTH, '800000000000');
      const reply = await get('/home/changes');
      expect(reply.json).toMatchObject({ reason: 'NO_PREVIOUS_WEEK', previous_as_of_date: null, lines: [] });
      await wipe();
      expect((await get('/home/changes')).status).toBe(404);
    });

    it('writes no line from a figure that a leader is not given because it is not certified', async () => {
      await twoWeeks();
      await approvedVersion('DISBURSEMENT_RATE_PM', 1);
      const kinds = ((await get('/home/changes')).json.lines as Array<{ kind: string }>).map((line) => line.kind);
      expect(kinds).not.toContain('RATE_CHANGE');
      expect(kinds).toContain('WARNINGS_DELTA');
    });
  });

  describe('the drill in three steps (G3-3)', () => {
    it('keeps the order of the codes by default and puts the part that drags a ratio down most first on request, with its pull in points', async () => {
      const { southProject } = await twoWeeks();
      const pm = tile(await center(), 'DISBURSEMENT_RATE_PM');
      const byCode = (await get(`/home/drill?context_token=${pm.context_token}`)).json as { step: number; steps_total: number; order: string; level: string; children: Array<{ id: string; drag_points: string | null; value: string | null }> };
      expect(byCode).toMatchObject({ step: 1, steps_total: 3, order: 'code', level: 'SCOPE' });
      expect(byCode.children).toHaveLength(2);
      const byDrag = (await get(`/home/drill?context_token=${pm.context_token}&order=drag`)).json as typeof byCode;
      expect(byDrag.order).toBe('drag');
      // The south pays 400 of 1000 against 1200 of 2000 in all: it pulls the whole down, the north up, by the same amount in points.
      expect(byDrag.children[0]?.id).toBe(unitId(SOUTH));
      const [south, north] = byDrag.children as unknown as [{ drag_points: string }, { drag_points: string }];
      expect(south.drag_points).toBe('-10.0000');
      expect(north.drag_points).toBe('10.0000');
      expect((await get(`/home/drill?context_token=${pm.context_token}&order=sideways`)).status).toBe(422);

      // Step two: the unit by project; step three: the records, with the alerts open on the project.
      const unitToken = (byDrag.children[0] as unknown as { context_token: string }).context_token;
      const units = (await get(`/home/drill?context_token=${unitToken}`)).json as { step: number; children: Array<{ id: string; context_token: string }> };
      expect(units.step).toBe(2);
      expect(units.children.map((child) => child.id)).toEqual([southProject]);
      const records = (await get(`/home/drill?context_token=${units.children[0]?.context_token}`)).json as { step: number; alerts: Array<{ kind: string; severity: string; status: string }> };
      expect(records.step).toBe(3);
      expect(records.alerts).toHaveLength(3);
      expect(records.alerts.every((alert) => alert.kind === 'EARLY_WARNING' && alert.severity === 'CRITICAL' && alert.status === 'OPEN')).toBe(true);
    });

    it('tells a reader nothing of a project outside their scope: the alerts of the south are not in the way of the north', async () => {
      const { southProject } = await twoWeeks();
      const pm = tile(await center('', BRANCH), 'DISBURSEMENT_RATE_PM');
      const read = (await get(`/home/drill?context_token=${pm.context_token}`, BRANCH)).json as { children: Array<{ id: string; context_token: string }> };
      expect(read.children.map((child) => child.id)).toEqual([unitId(NORTH)]);
      // A token minted for the south is not good for a reader who may not read it.
      const southToken = ((await get(`/home/drill?context_token=${tile(await center(), 'DISBURSEMENT_RATE_PM').context_token}`)).json as { children: Array<{ id: string; context_token: string }> }).children.find((child) => child.id === unitId(SOUTH))?.context_token;
      expect(southToken).toBeDefined();
      const wrongReader = await get(`/home/drill?context_token=${southToken}`, BRANCH);
      expect(wrongReader.status).toBe(400);
      expect(JSON.stringify(wrongReader.json)).not.toContain(southProject);
    });
  });
});
