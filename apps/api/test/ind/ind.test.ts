import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { loadErrorRegistry, signTenantContext, validateRuleParams } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { enforceProjectEntry, enforceReportEntry } from '../../src/ind-entry-guard';
import type { CommandScope } from '../../src/command-scope';
import { indModule } from '../../src/modules/ind';
import { IndEntryController } from '../../src/modules/ind/entry.controller';
import { IndImportController } from '../../src/modules/ind/import.controller';
import { IndReadsController } from '../../src/modules/ind/reads.controller';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(240_000);

const SIGNING_KEY = randomBytes(32);
const ADMIN = 1; // every IND permission over the tenant
const READER = 2; // ind.read
const UNIT_ADMIN = 3; // every IND permission over the department subtree only
const NOBODY = 4;
const CHECKER = 5; // approves the rules (a member who makes none)
const B_ADMIN = 1;
const ROOT = 1;
const DEPARTMENT = 2;
const OTHER = 3;
const FAMILY = 0x98;
const IND_ALL = ['ind.read', 'ind.entry', 'ind.import.preview', 'ind.import'];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));
const list = (reply: Reply, key = 'items'): Array<Record<string, unknown>> => reply.json[key] as Array<Record<string, unknown>>;

describe('the indicator dictionary, the entry rules, the figures and the import of forms (IND-1)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let root: string;
  let files: FileService;
  let counter = 0;
  const versions = new Map<string, number>();

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const audits = (action: string) => rows<{ safe_diff: Record<string, unknown>; resource_id: string }>('select safe_diff, resource_id from machvon.audit_event where action = $1 order by occurred_at', [action]);

  async function seedAsAdmin(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  async function seedProject(unit = DEPARTMENT): Promise<{ projectId: string; code: string }> {
    counter += 1;
    const projectId = randomUUID();
    const code = `PRJ-I${counter}-${projectId.slice(0, 4)}`;
    await seedAsAdmin([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Indicator project', $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, code, unitId(unit), unitId(ROOT), id(FAMILY, 90)],
      ],
    ]);
    return { projectId, code };
  }

  async function seedPeriod(code: string, status: 'OPEN' | 'LOCKED' = 'OPEN'): Promise<string> {
    const periodId = randomUUID();
    await seedAsAdmin([
      [
        status === 'OPEN'
          ? `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
             values ($1, $2, $3, 1, date '2026-10-01', date '2026-10-31', date '2026-11-05' + interval '3 hours', $4, 'MONTH', 2026, 'OPEN', gen_random_uuid(), $5, $5)`
          : `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by, soft_closed_at, locked_at, locked_by)
             values ($1, $2, $3, 1, date '2026-09-01', date '2026-09-30', date '2026-10-05' + interval '3 hours', $4, 'MONTH', 2026, 'LOCKED', gen_random_uuid(), $5, $5, now(), now(), $5)`,
        [TENANT_A, periodId, code, `CAL-${code}`, memberId(ADMIN)],
      ],
    ]);
    return periodId;
  }

  async function approveRule(type: string, code: string, params: Record<string, unknown>): Promise<void> {
    const version = (versions.get(`${type}/${code}`) ?? 0) + 1;
    versions.set(`${type}/${code}`, version);
    await rows(
      `insert into machvon.governance_rule (tenant_id, id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
       values ($1, $2, $3, $4, $5, 'APPROVED', $6::jsonb, date '2026-01-01', 'Test approval of the rule', $7, $7, now(), $8, now())`,
      [TENANT_A, randomUUID(), type, code, version, JSON.stringify(validateRuleParams(type, params)), memberId(ADMIN), memberId(CHECKER)],
    );
  }

  async function upload(bytes: Uint8Array): Promise<{ key: string; sha: string }> {
    const stored = await files.upload({ tenantId: TENANT_A, membershipId: memberId(ADMIN), scopeVersion: 1 }, { purpose: 'import', declaredType: 'text/csv', bytes });
    expect(stored.scanStatus).toBe('CLEAN');
    return { key: stored.key, sha: shaOf(bytes) };
  }

  const enter = (member: number, projectId: string, periodId: string, figures: Array<Record<string, unknown>>): Promise<Reply> => call('POST', '/indicator-figures', { member, body: { project_id: projectId, period_id: periodId, figures } });
  const importBody = (file: { key: string; sha: string }, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ mapping_code: 'MONTHLY_FORM', file_object_key: file.key, file_sha256: file.sha, ...extra });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'machvon-ind-'));
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: OTHER, path: `/${unitId(ROOT)}/${unitId(OTHER)}/`, parent: ROOT },
      ]);
    }
    for (const n of [ADMIN, READER, UNIT_ADMIN, NOBODY, CHECKER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_ADMIN, ROOT);
    await harness.seedRole(TENANT_A, 1, 'IND_ADMIN', IND_ALL, 50);
    await harness.seedRole(TENANT_A, 2, 'IND_READER', ['ind.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'IND_ADMIN', IND_ALL, 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: READER, role: 2, kind: 'TENANT' },
      { n: 3, member: UNIT_ADMIN, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_ADMIN, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    files = new FileService({ storage: new FsObjectStorage(root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [IndReadsController, IndEntryController, IndImportController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('is registered in the module of IND', () => {
    for (const controller of [IndReadsController, IndEntryController, IndImportController]) expect(indModule.controllers).toContain(controller);
  });

  describe('the dictionary and the catalogues', () => {
    it('lists the starting indicators with how each is obtained, filters them, and reads one with its usage', async () => {
      const all = await call('GET', '/indicators', { member: READER });
      expect(all.status).toBe(200);
      expect(list(all).map((one) => one.code)).toEqual(expect.arrayContaining(['TOTAL_INVESTMENT', 'RATE_YEAR_IN_FORCE', 'CUMULATIVE_YTD']));
      expect(all.json.findings).toEqual([]);
      const entered = await call('GET', '/indicators?enterable=true&category=FUNDING', { member: READER });
      expect(list(entered).map((one) => one.code)).toEqual(['EQUITY_CAPITAL', 'LOAN_CAPITAL', 'TOTAL_FUNDING', 'TOTAL_INVESTMENT']);
      expect(list(entered).every((one) => one.enterable === true && one.origin === 'DEFAULT' && one.unverified === true)).toBe(true);
      expect(list(await call('GET', '/indicators?q=tmđt', { member: READER })).map((one) => one.code)).toEqual(['TOTAL_INVESTMENT']);
      const detail = await call('GET', '/indicators/detail?code=LOAN_CAPITAL', { member: READER });
      expect(detail.status).toBe(200);
      expect(detail.json.indicator).toMatchObject({ code: 'LOAN_CAPITAL', unit: 'VND', entry_field: 'DEBT', value_kind: 'ENTERED' });
      expect(detail.json.usage).toMatchObject({ rules: expect.arrayContaining([{ code: 'EQUITY_PLUS_DEBT_EQUALS_TOTAL', check: 'PARTS_EQUAL_TOTAL', active: false }]) });
      expect(detail.json.versions).toEqual([]);
    });

    it('refuses a bad filter and a code that is not a code, finds nothing for an unknown one, and keeps the dictionary from a caller with no right', async () => {
      expect((await call('GET', '/indicators?category=NOPE', { member: READER })).json).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await call('GET', '/indicators?enterable=maybe', { member: READER })).status).toBe(422);
      expect((await call('GET', '/indicators/detail?code=lower', { member: READER })).status).toBe(422);
      expect((await call('GET', '/indicators/detail', { member: READER })).status).toBe(422);
      expect((await call('GET', '/indicators/detail?code=NO_SUCH_CODE', { member: READER })).status).toBe(404);
      expect((await call('GET', '/indicators', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/indicators', { member: B_ADMIN, tenantId: TENANT_B })).status).toBe(200);
    });

    it('lists the entry rules as templates until the tenant approves its own, and the mappings the same way', async () => {
      const rules = await call('GET', '/indicator-entry-rules', { member: READER });
      expect(rules.status).toBe(200);
      expect(list(rules).every((rule) => rule.active === false && rule.origin === 'DEFAULT' && rule.unverified === true)).toBe(true);
      expect(rules.json.surfaces).toEqual(['DIS_REPORT', 'PRJ_PROJECT', 'INDICATOR_ENTRY', 'INDICATOR_IMPORT']);
      expect(list(rules).map((rule) => rule.code)).toEqual(expect.arrayContaining(['CUMULATIVE_NOT_ABOVE_TOTAL', 'EQUITY_PLUS_DEBT_EQUALS_TOTAL', 'PROGRESS_PERCENT_IN_RANGE']));
      const mappings = await call('GET', '/indicator-import-mappings', { member: READER });
      expect(list(mappings).map((mapping) => [mapping.code, mapping.active, mapping.problems])).toEqual([
        ['SAMPLE_COLUMNS_FORM', false, []],
        ['SAMPLE_ROWS_FORM', false, []],
      ]);
      const sample = await call('GET', '/indicator-import-mappings/detail?code=SAMPLE_ROWS_FORM', { member: READER });
      expect(sample.json.mapping).toMatchObject({ layout: 'ROWS', origin: 'DEFAULT', version: 0 });
      expect((await call('GET', '/indicator-import-mappings/detail?code=NO_SUCH_FORM', { member: READER })).status).toBe(404);
    });
  });

  describe('evaluateIndicatorEntry: a dry run of the entry rules', () => {
    it('allows everything when no rule is approved, and shows what the starting rules would do when asked', async () => {
      const none = await call('POST', '/indicator-entry-rules/evaluate', { member: ADMIN, body: { surface: 'DIS_REPORT', values: { CUMULATIVE: '9', TOTAL_INVESTMENT: '1' } } });
      expect(none.status).toBe(200);
      expect(none.json).toMatchObject({ status: 'EVALUATED', allowed: true, violations: [], evaluated: [] });
      const template = await call('POST', '/indicator-entry-rules/evaluate', { member: ADMIN, body: { surface: 'DIS_REPORT', values: { CUMULATIVE: '9', TOTAL_INVESTMENT: '1' }, include_templates: true } });
      expect(template.json).toMatchObject({ allowed: false });
      expect(list(template, 'violations').map((one) => one.rule_code)).toEqual(['CUMULATIVE_NOT_ABOVE_TOTAL']);
      expect((await call('POST', '/indicator-entry-rules/evaluate', { member: READER, body: { surface: 'DIS_REPORT', values: {} } })).status).toBe(403);
      expect((await call('POST', '/indicator-entry-rules/evaluate', { member: ADMIN, body: { surface: 'NOWHERE', values: {} } })).status).toBe(422);
    });
  });

  describe('enterIndicatorFigures', () => {
    it('writes revision 1, changes nothing for the same number, asks a reason for a correction and keeps every revision with its trail', async () => {
      const { projectId, code } = await seedProject();
      const period = await seedPeriod('2026-10-A');
      const first = await enter(ADMIN, projectId, period, [{ indicator_code: 'PLAN_YEAR', value: '1000' }, { indicator_code: 'PHYSICAL_PROGRESS_REPORTED', value: '12.5' }]);
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'ENTERED', created: 2, revised: 0, unchanged: 0, warnings: [] });
      expect(list(first, 'figures').map((figure) => [figure.indicator_code, figure.value, figure.revision, figure.unit, figure.source])).toEqual([
        ['PLAN_YEAR', '1000', 1, 'VND', 'ENTRY'],
        ['PHYSICAL_PROGRESS_REPORTED', '12.5', 1, 'PERCENT', 'ENTRY'],
      ]);
      const same = await enter(ADMIN, projectId, period, [{ indicator_code: 'PLAN_YEAR', value: '1000' }]);
      expect(same.json).toMatchObject({ created: 0, revised: 0, unchanged: 1 });
      const bare = await enter(ADMIN, projectId, period, [{ indicator_code: 'PLAN_YEAR', value: '1200' }]);
      expect(bare.status).toBe(422);
      expect(bare.json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      const revised = await enter(ADMIN, projectId, period, [{ indicator_code: 'PLAN_YEAR', value: '1200', reason: 'The adjusted plan was published' }]);
      expect(revised.json).toMatchObject({ created: 0, revised: 1 });
      const history = await call('GET', `/indicator-figures/history?project_id=${projectId}&period_id=${period}&indicator_code=PLAN_YEAR`, { member: READER });
      expect(list(history).map((figure) => [figure.revision, figure.value])).toEqual([[2, '1200'], [1, '1000']]);
      const current = await call('GET', `/indicator-figures?project_id=${projectId}&period_id=${period}`, { member: READER });
      expect(list(current).map((figure) => [figure.indicator_code, figure.revision])).toEqual([['PHYSICAL_PROGRESS_REPORTED', 1], ['PLAN_YEAR', 2]]);
      const trail = (await audits('ind.figure_revised')).find((row) => row.safe_diff.project_code === code);
      expect(trail?.safe_diff).toMatchObject({ indicator_code: 'PLAN_YEAR', revision: 2, value: '1200', with_reason: true });
      expect(JSON.stringify(trail?.safe_diff)).not.toContain('adjusted plan');
      const events = await rows<{ aggregate_version: string }>("select aggregate_version::text from machvon.outbox_event where type = 'ind.figure.entered.v1' and payload->>'project_id' = $1 order by aggregate_version", [projectId]);
      expect(events.map((row) => row.aggregate_version)).toEqual(['1', '1', '2']);
    });

    it('refuses an indicator that is derived, unknown or repeated and a number that does not fit its unit', async () => {
      const { projectId } = await seedProject();
      const period = await seedPeriod('2026-10-B');
      for (const [figures, detail] of [
        [[{ indicator_code: 'RATE_YEAR_IN_FORCE', value: '5' }], 'figures[0].indicator_code'],
        [[{ indicator_code: 'NO_SUCH_CODE', value: '5' }], 'figures[0].indicator_code'],
        [[{ indicator_code: 'PLAN_YEAR', value: '5' }, { indicator_code: 'PLAN_YEAR', value: '6' }], 'figures[1].indicator_code'],
        [[{ indicator_code: 'PLAN_YEAR', value: '5.5' }], 'figures[0].value'],
      ] as const) {
        const reply = await enter(ADMIN, projectId, period, figures as unknown as Array<Record<string, unknown>>);
        expect(reply.status).toBe(422);
        expect(reply.json).toMatchObject({ code: 'VALIDATION_FAILED', detail });
      }
      expect((await enter(ADMIN, projectId, period, [{ indicator_code: 'PLAN_YEAR', value: '1,5' }])).status).toBe(422);
      expect((await enter(ADMIN, projectId, period, [])).status).toBe(422);
    });

    it('is closed to a locked period, a project outside the scope, a caller without the right and another tenant', async () => {
      const { projectId } = await seedProject();
      const other = await seedProject(OTHER);
      const period = await seedPeriod('2026-10-C');
      const locked = await seedPeriod('2026-09-C', 'LOCKED');
      const figure = [{ indicator_code: 'PLAN_YEAR', value: '1' }];
      expect((await enter(ADMIN, projectId, locked, figure)).json).toMatchObject({ code: 'PERIOD_LOCKED', status: 409 });
      expect((await enter(UNIT_ADMIN, other.projectId, period, figure)).status).toBe(404);
      expect((await enter(UNIT_ADMIN, projectId, period, figure)).status).toBe(200);
      expect((await enter(READER, projectId, period, figure)).status).toBe(403);
      expect((await call('POST', '/indicator-figures', { member: B_ADMIN, tenantId: TENANT_B, body: { project_id: projectId, period_id: period, figures: figure } })).status).toBe(404);
      expect((await call('GET', `/indicator-figures?project_id=${projectId}`, { member: UNIT_ADMIN })).status).toBe(200);
      expect(list(await call('GET', `/indicator-figures?project_id=${other.projectId}`, { member: UNIT_ADMIN }))).toEqual([]);
      expect((await call('GET', `/indicator-figures/history?project_id=${other.projectId}&period_id=${period}&indicator_code=PLAN_YEAR`, { member: UNIT_ADMIN })).status).toBe(404);
    });

    it('holds the figures to the approved rules: a block is a 422 that lists the rules, a warning passes and is in the trail, rules of another surface are not asked', async () => {
      const { projectId, code } = await seedProject();
      const period = await seedPeriod('2026-10-D');
      await approveRule('DATA_ENTRY_RULE', 'EQUITY_PLUS_DEBT_EQUALS_TOTAL', { check: 'PARTS_EQUAL_TOTAL', severity: 'BLOCK', fields: ['EQUITY', 'DEBT'], total_field: 'TOTAL', tolerance: 0, message: 'Equity plus loan must equal the total', surfaces: ['INDICATOR_ENTRY'] });
      await approveRule('DATA_ENTRY_RULE', 'PROGRESS_WARNING', { check: 'VALUE_IN_RANGE', severity: 'WARN', fields: ['PHYSICAL_PROGRESS'], min: '0', max: '90', message: 'Progress above 90 percent: check it', surfaces: ['INDICATOR_ENTRY'] });
      await approveRule('DATA_ENTRY_RULE', 'ONLY_REPORT', { check: 'VALUE_IN_RANGE', severity: 'BLOCK', fields: ['PLAN_YEAR'], max: '1', message: 'Applies to the report only', surfaces: ['DIS_REPORT'] });
      const blocked = await enter(ADMIN, projectId, period, [{ indicator_code: 'EQUITY_CAPITAL', value: '400' }, { indicator_code: 'LOAN_CAPITAL', value: '500' }, { indicator_code: 'TOTAL_FUNDING', value: '1000' }]);
      expect(blocked.status).toBe(422);
      expect(blocked.json).toMatchObject({ code: 'IND_ENTRY_RULE_VIOLATED', detail: 'EQUITY_PLUS_DEBT_EQUALS_TOTAL' });
      expect(JSON.stringify(blocked.json)).toContain('Equity plus loan must equal the total');
      expect(list(await call('GET', `/indicator-figures?project_id=${projectId}&period_id=${period}`, { member: ADMIN }))).toEqual([]);
      const ok = await enter(ADMIN, projectId, period, [{ indicator_code: 'EQUITY_CAPITAL', value: '400' }, { indicator_code: 'LOAN_CAPITAL', value: '600' }, { indicator_code: 'TOTAL_FUNDING', value: '1000' }, { indicator_code: 'PHYSICAL_PROGRESS_REPORTED', value: '95' }, { indicator_code: 'PLAN_YEAR', value: '50' }]);
      expect(ok.status).toBe(200);
      expect(list(ok, 'warnings').map((one) => one.rule_code)).toEqual(['PROGRESS_WARNING']);
      const trail = (await audits('ind.entry_warned')).find((row) => row.safe_diff.project_code === code);
      expect(trail?.safe_diff).toMatchObject({ surface: 'INDICATOR_ENTRY', warned: [{ rule_code: 'PROGRESS_WARNING', check: 'VALUE_IN_RANGE', fields: ['PHYSICAL_PROGRESS'] }] });
      const evaluated = await call('POST', '/indicator-entry-rules/evaluate', { member: ADMIN, body: { surface: 'INDICATOR_ENTRY', values: { EQUITY: '1', DEBT: '1', TOTAL: '5' } } });
      expect(evaluated.json).toMatchObject({ allowed: false, evaluated: ['EQUITY_PLUS_DEBT_EQUALS_TOTAL'] });
      const rules = await call('GET', '/indicator-entry-rules', { member: READER });
      expect(list(rules).filter((rule) => rule.active === true).map((rule) => rule.code)).toEqual(['EQUITY_PLUS_DEBT_EQUALS_TOTAL', 'ONLY_REPORT', 'PROGRESS_WARNING']);
    });
  });

  describe('the entry guard of the other places of entry', () => {
    const scopeOf = (tx: TenantTx, trail: Array<Record<string, unknown>>): CommandScope =>
      ({ tx, tenant: { tenantId: TENANT_A, membershipId: memberId(ADMIN), scopeVersion: 1 }, audit: async (entry: Record<string, unknown>) => (trail.push(entry), 'audit-id') }) as unknown as CommandScope;
    const NOW = new Date('2026-11-08T03:00:00Z');
    const totals = (cumulative: string) => ({ cumulativeVnd: cumulative, ctmtqgVnd: '0', nextMonthVnd: '0' });

    it('holds the weekly report to the approved rules of its surface and the project to the rules of the register, and leaves a tenant with no rule on a surface alone', async () => {
      const { projectId } = await seedProject();
      await approveRule('DATA_ENTRY_RULE', 'CUMULATIVE_NOT_ABOVE_TOTAL', { check: 'CUMULATIVE_NOT_ABOVE_TOTAL', severity: 'BLOCK', fields: ['CUMULATIVE'], total_field: 'TOTAL_INVESTMENT', message: 'Cumulative above the total', surfaces: ['DIS_REPORT'] });
      await approveRule('DATA_ENTRY_RULE', 'PROJECT_TOTAL_RANGE', { check: 'VALUE_IN_RANGE', severity: 'BLOCK', fields: ['TOTAL_INVESTMENT'], min: '1', message: 'The total investment must be positive', surfaces: ['PRJ_PROJECT'] });
      const trail: Array<Record<string, unknown>> = [];
      const run = (work: (scope: CommandScope) => Promise<void>): Promise<void> => harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(ADMIN), scopeVersion: 1 }, async (tx) => work(scopeOf(tx, trail)));
      await expect(run((scope) => enforceReportEntry(scope, { projectId, totals: totals('1001'), progress: null, periodStatus: 'OPEN', now: NOW }))).rejects.toMatchObject({ code: 'IND_ENTRY_RULE_VIOLATED', status: 422, detail: 'CUMULATIVE_NOT_ABOVE_TOTAL' });
      await expect(run((scope) => enforceReportEntry(scope, { projectId, totals: totals('1000'), progress: null, periodStatus: 'OPEN', now: NOW }))).resolves.toBeUndefined();
      await expect(run((scope) => enforceProjectEntry(scope, { totalInvestmentVnd: '0', now: NOW }))).rejects.toMatchObject({ code: 'IND_ENTRY_RULE_VIOLATED', detail: 'PROJECT_TOTAL_RANGE' });
      await expect(run((scope) => enforceProjectEntry(scope, { totalInvestmentVnd: '5000', now: NOW }))).resolves.toBeUndefined();
      expect(trail).toEqual([]);
    });
  });

  describe('the import of a form', () => {
    const HEADER = 'Project,Period,Total investment,Equity,Loan,Cumulative';
    const MAPPING = {
      name: 'Form with a row for each project',
      layout: 'COLUMNS',
      number_format: 'VN',
      project_column: 'Project',
      period_column: 'Period',
      lines: [
        { indicator: 'TOTAL_INVESTMENT', source: 'Total investment', scale: 'ONE' },
        { indicator: 'EQUITY_CAPITAL', source: 'Equity', scale: 'ONE' },
        { indicator: 'LOAN_CAPITAL', source: 'Loan', scale: 'ONE' },
        { indicator: 'CUMULATIVE_YTD', source: 'Cumulative', scale: 'ONE' },
      ],
    };

    async function uploadDoor(member: number, bytes: Uint8Array): Promise<Reply> {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'text/csv' }), 'form.csv');
      const response = await fetch(`${app.baseUrl}/indicator-imports/files`, { method: 'POST', headers: { [TENANT_HEADER]: tokenOf(member), 'idempotency-key': `key-${randomUUID()}` }, body: form });
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    }

    it('refuses a file while no mapping is approved, then reads it through the approved one: upload, dry run, apply once', async () => {
      const { projectId, code } = await seedProject();
      const period = await seedPeriod('2026-10-E');
      const file = csv(HEADER, `${code},2026-10-E,"1.000","400","600","250"`);
      const stored = await upload(file);
      const sample = await call('POST', '/indicator-imports/preview', { member: ADMIN, body: importBody(stored, { mapping_code: 'SAMPLE_COLUMNS_FORM' }) });
      expect(sample.json).toMatchObject({ code: 'IND_MAPPING_NOT_APPROVED', status: 409 });
      expect((await call('POST', '/indicator-imports/preview', { member: ADMIN, body: importBody(stored, { mapping_code: 'NO_SUCH_FORM' }) })).status).toBe(404);
      expect((await uploadDoor(ADMIN, file)).json).toMatchObject({ fitting_mappings: [], row_count: 1, format: 'CSV' });
      await approveRule('INDICATOR_IMPORT_MAPPING', 'MONTHLY_FORM', MAPPING);
      const door = await uploadDoor(ADMIN, file);
      expect(door.status).toBe(200);
      expect(door.json).toMatchObject({ fitting_mappings: ['MONTHLY_FORM'], columns: HEADER.split(','), file_sha256: shaOf(file) });
      const preview = await call('POST', '/indicator-imports/preview', { member: ADMIN, body: importBody(stored) });
      expect(preview.status).toBe(200);
      expect(preview.json).toMatchObject({ mode: 'DRY_RUN', mapping_code: 'MONTHLY_FORM', mapping_version: 1, format_version: 'MONTHLY_FORM.v1', already_applied: false, counts: { total: 1, valid: 1, errors: 0 } });
      expect(list(preview, 'rows')[0]).toMatchObject({ status: 'VALID', outcome: 'CREATE', business_key: `${code}|2026-10-E` });
      expect(list(await call('GET', `/indicator-figures?project_id=${projectId}&period_id=${period}`, { member: ADMIN }))).toEqual([]);
      const applied = await call('POST', '/indicator-imports', { member: ADMIN, body: importBody(stored) });
      expect(applied.status).toBe(200);
      expect(applied.json).toMatchObject({ status: 'APPLIED', mapping_version: 1, counts: { total: 1, applied: 1, quarantined: 0, differences_opened: 0 }, figures_written: 4, figures_unchanged: 0, figures_differing: 0 });
      const figures = await call('GET', `/indicator-figures?project_id=${projectId}&period_id=${period}`, { member: ADMIN });
      expect(list(figures).map((figure) => [figure.indicator_code, figure.value, figure.source, figure.mapping_code, figure.mapping_version])).toEqual([
        ['CUMULATIVE_YTD', '250', 'IMPORT', 'MONTHLY_FORM', 1],
        ['EQUITY_CAPITAL', '400', 'IMPORT', 'MONTHLY_FORM', 1],
        ['LOAN_CAPITAL', '600', 'IMPORT', 'MONTHLY_FORM', 1],
        ['TOTAL_INVESTMENT', '1000', 'IMPORT', 'MONTHLY_FORM', 1],
      ]);
      expect(list(figures)[0]).toMatchObject({ import_id: applied.json.resource_id, import_line: 2 });
      expect((await call('POST', '/indicator-imports', { member: ADMIN, body: importBody(stored) })).json).toMatchObject({ code: 'IMPORT_FILE_ALREADY_APPLIED', status: 409 });
      const trail = (await audits('ind.import_applied')).find((row) => row.resource_id === applied.json.resource_id);
      expect(trail?.safe_diff).toMatchObject({ mapping_code: 'MONTHLY_FORM', mapping_version: 1, figures_written: 4 });
      const history = await call('GET', '/indicator-imports', { member: READER });
      expect(list(history)[0]).toMatchObject({ id: applied.json.resource_id, format_version: 'MONTHLY_FORM.v1', status: 'APPLIED', open_differences: 0, counts: { applied: 1 } });
      const detail = await call('GET', `/indicator-imports/rows?import_id=${String(applied.json.resource_id)}`, { member: READER });
      expect(detail.json).toMatchObject({ errors: [], differences: [] });
      expect((await call('GET', `/indicator-imports/rows?import_id=${randomUUID()}`, { member: READER })).status).toBe(404);
    });

    it('opens a difference for a number the register holds with another value, refuses rows the register or the rules refuse, and keeps a project out of scope as unknown', async () => {
      const mine = await seedProject();
      const other = await seedProject(OTHER);
      const period = await seedPeriod('2026-10-F');
      await enter(ADMIN, mine.projectId, period, [{ indicator_code: 'EQUITY_CAPITAL', value: '300' }]);
      const file = csv(HEADER, `${mine.code},2026-10-F,"1.000","400","600","250"`, `${other.code},2026-10-F,"1.000","400","600","250"`, `NO-SUCH,2026-10-F,"1.000","400","600","250"`, `${mine.code},2026-12-X,"1.000","400","600","250"`);
      const stored = await upload(file);
      const applied = await call('POST', '/indicator-imports', { member: UNIT_ADMIN, body: importBody(stored) });
      expect(applied.status).toBe(200);
      expect(applied.json).toMatchObject({ counts: { total: 4, applied: 1, quarantined: 3, differences_opened: 1 }, figures_written: 3, figures_differing: 1 });
      expect(list(applied, 'errors').map((row) => `${row.line}:${row.code}:${row.field}`)).toEqual(['3:PROJECT_UNKNOWN:project', '4:PROJECT_UNKNOWN:project', '5:PERIOD_UNKNOWN:period']);
      const detail = await call('GET', `/indicator-imports/rows?import_id=${String(applied.json.resource_id)}`, { member: READER });
      expect(list(detail, 'differences')).toEqual([expect.objectContaining({ code: 'IND_FIGURE_DIFFERS', expected: '300', actual: '400', status: 'OPEN', line: 2 })]);
      // A caller who reaches only the department reads the rows of the projects in their scope, not those of the other projects of the same file (Codex review).
      const scoped = await call('GET', `/indicator-imports/rows?import_id=${String(applied.json.resource_id)}`, { member: UNIT_ADMIN });
      expect(list(scoped, 'errors').map((row) => `${row.line}:${row.code}`)).toEqual(['5:PERIOD_UNKNOWN']);
      expect(list(scoped, 'differences')).toHaveLength(1);
      const whole = await call('GET', `/indicator-imports/rows?import_id=${String(applied.json.resource_id)}`, { member: ADMIN });
      expect(list(whole, 'errors').map((row) => `${row.line}:${row.code}`)).toEqual(['3:PROJECT_UNKNOWN', '4:PROJECT_UNKNOWN', '5:PERIOD_UNKNOWN']);
      const held = await call('GET', `/indicator-figures?project_id=${mine.projectId}&period_id=${period}&indicator_code=EQUITY_CAPITAL`, { member: ADMIN });
      expect(list(held)[0]).toMatchObject({ value: '300', source: 'ENTRY', revision: 1 });
      await approveRule('DATA_ENTRY_RULE', 'IMPORT_EQUITY_DEBT', { check: 'PARTS_EQUAL_TOTAL', severity: 'BLOCK', fields: ['EQUITY', 'DEBT'], total_field: 'TOTAL_INVESTMENT', tolerance: 0, message: 'Equity plus loan must equal the total', surfaces: ['INDICATOR_IMPORT'] });
      const blind = await call('POST', '/indicator-imports', { member: ADMIN, body: importBody(await upload(csv(HEADER, `${other.code},2026-10-F,"1.000","400","500","250"`))) });
      expect(blind.json).toMatchObject({ code: 'IMPORT_HAS_ERRORS', status: 422 });
      expect((blind.json.errors as Array<Record<string, unknown>>)[0]).toMatchObject({ line: 2, code: 'ENTRY_RULE_BLOCKED', field: 'IMPORT_EQUITY_DEBT' });
    });

    it('is closed to a caller without the right and reads another tenant as nothing', async () => {
      const stored = await upload(csv(HEADER, 'X,2026-10-F,1,2,3,4'));
      expect((await call('POST', '/indicator-imports/preview', { member: READER, body: importBody(stored) })).status).toBe(403);
      expect((await call('POST', '/indicator-imports', { member: READER, body: importBody(stored) })).status).toBe(403);
      expect((await uploadDoor(READER, csv(HEADER))).status).toBe(403);
      expect((await call('POST', '/indicator-imports/preview', { member: B_ADMIN, tenantId: TENANT_B, body: importBody(stored) })).status).toBe(404);
      expect(list(await call('GET', '/indicator-imports', { member: B_ADMIN, tenantId: TENANT_B }))).toEqual([]);
      expect((await call('POST', '/indicator-imports/preview', { member: ADMIN, body: importBody({ key: stored.key, sha: 'b'.repeat(64) }) })).json).toMatchObject({ code: 'HASH_MISMATCH' });
    });
  });
});
