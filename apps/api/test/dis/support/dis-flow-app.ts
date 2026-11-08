import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import type { Provider, Type } from '@nestjs/common';
import { Client } from 'pg';
import { BASELINE_PACK, DisPeriodStore, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, applyBaseline } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../../src/command.module';
import { ReportDecisionController } from '../../../src/modules/dis/report-decision.controller';
import { ReportImportController } from '../../../src/modules/dis/report-import.controller';
import { ReportLifecycleController } from '../../../src/modules/dis/report-lifecycle.controller';
import { ReportController, ReportReadsController } from '../../../src/modules/dis/report.controller';
import { ReportSubmitController } from '../../../src/modules/dis/report-submit.controller';
import { DIS_CLOCK, DIS_METRICS } from '../../../src/modules/dis/tokens';
import { FileService } from '../../../src/modules/files/file.service';
import { FsObjectStorage } from '../../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../../src/modules/files/mock-scan';
import { PolicyModule } from '../../../src/policy.module';
import { ProblemFilter } from '../../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../../isolation/test-app';
import type { RunningApp } from '../../isolation/test-app';

/**
 * The fixture the characterisation tests of the weekly report review and the tests of the staged approval (WF-1) share: a tenant with a department, a maker, reviewers, a project with a plan in force,
 * the weekly periods of 2027 and the DIS controllers over HTTP. It is the setup of `report-decision.test.ts`, kept here so that a second test can run the same journeys without copying them.
 */
export const SIGNING_KEY = randomBytes(32);
export const WORKER = '00000000-0000-4000-8000-000000000000';
/** Makes and hands in the reports; also holds report.review so that the maker-checker rule is what stops the self-approval. */
export const MAKER = 1;
/** report.review over the whole tenant. */
export const REVIEWER = 2;
/** report.read only. */
export const READER = 3;
/** report.review over another branch, where the projects are not. */
export const ELSEWHERE_REVIEWER = 4;
/** The maker rights over the whole tenant, without report.review. */
export const OTHER_MAKER = 5;
export const B_MAKER = 1;
export const ROOT = 1;
export const DEPARTMENT = 2;
export const ELSEWHERE = 3;
export const FAMILY = 0x9f;
export const AREA = id(FAMILY, 30);
const DECISION = id(FAMILY, 32);
const FUND_SOURCE = id(FAMILY, 31);
export const DUE = '2027-01-10T03:00:00.000Z';
export const NOW = new Date('2026-12-15T00:00:00Z');

export interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

export interface CallOptions {
  member: number;
  tenantId?: string;
  body?: unknown;
  ifMatch?: string;
  key?: string;
}

export const FX_DIS_001 = [
  { bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '100000000', ctmtqg_subset_vnd: '40000000' },
  { bucket: 'CURRENT_YEAR', budget_level: 'LOCAL', cumulative_vnd: '200000000' },
  { bucket: 'CARRYOVER', budget_level: 'CENTRAL', cumulative_vnd: '30000000' },
  { bucket: 'CARRYOVER', budget_level: 'LOCAL', cumulative_vnd: '70000000' },
  { bucket: 'OTHER', budget_level: 'CENTRAL', cumulative_vnd: '0' },
  { bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '20000000' },
];
export const PROGRESS = { construction_vnd: '300000000', acceptance_vnd: '200000000', treasury_submitted_vnd: '150000000', preparing_dossier_vnd: '50000000', physical_progress_pct: '37.5' };

export interface DisFlowOptions {
  /** Members besides the five above, as `{ n, role }`: membership, role (by number) and a whole-tenant grant are seeded for each. */
  extraMembers?: ReadonlyArray<{ n: number; roleNumber: number }>;
  extraRoles?: ReadonlyArray<{ n: number; code: string; permissions: readonly string[]; rank: number }>;
  controllers?: readonly Type[];
  providers?: readonly Provider[];
  /** Runs after the baseline and the periods are seeded, before the application starts (a test seeds its rules here). */
  afterSeed?(fixture: DisFlow): Promise<void>;
  tmpPrefix?: string;
}

export class DisFlow {
  readonly harness = new AuthzHarness();
  app!: RunningApp;
  clockNow = NOW;
  readonly counted: Array<{ name: string; labels: Record<string, string> | undefined }> = [];
  private counter = 0;
  private weeks: string[] = [];
  private nextWeek = 0;
  private root = '';

  static tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async call(method: 'GET' | 'POST', url: string, options: CallOptions): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: DisFlow.tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${this.app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => this.harness.owner<R>(tenant, [[sql, params]]);
  idOf = (reply: Reply): string => reply.json.resource_id as string;

  async seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: this.harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** A project of the department with a plan version of 2027 in force from December 2026 that allocated 500,000,000 to the year plan of the central budget. */
  async seedProject(): Promise<{ projectId: string; planId: string }> {
    this.counter += 1;
    const projectId = randomUUID();
    const planId = randomUUID();
    await this.seedReplica([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, `WF-${this.counter}`, `Project WF-${this.counter}`, unitId(DEPARTMENT), AREA],
      ],
      [`insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at) values ($1, $2, $3, 2027, 1, $4, 'PUBLISHED', timestamptz '2026-12-20T01:00:00Z')`, [TENANT_A, planId, projectId, DECISION]],
      [
        `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id, budget_level)
         values ($1, gen_random_uuid(), $2, $3, 'CURRENT_YEAR', 2027, 500000000, 0, $4, 'CENTRAL')`,
        [TENANT_A, planId, FUND_SOURCE, projectId],
      ],
    ]);
    return { projectId, planId };
  }

  week(): string {
    const found = this.weeks[this.nextWeek];
    this.nextWeek += 1;
    if (found === undefined) throw new Error('the calendar of 2027 ran out of weeks');
    return found;
  }

  draft = (projectId: string, periodId: string, planId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    project_id: projectId,
    period_id: periodId,
    plan_version_id: planId,
    report_type: 'WEEKLY',
    measurement_basis: 'YTD',
    funding_lines: FX_DIS_001,
    ...PROGRESS,
    ...extra,
  });
  create = (body: Record<string, unknown>, member = MAKER): Promise<Reply> => this.call('POST', '/reports', { member, body });
  save = (reportId: string, body: Record<string, unknown>, version: number, member = MAKER): Promise<Reply> => this.call('POST', `/reports/${reportId}/revisions`, { member, body, ifMatch: `"${version}"` });
  submit = (reportId: string, version: number, member = MAKER): Promise<Reply> => this.call('POST', `/reports/${reportId}/submit`, { member, ifMatch: `"${version}"`, body: {} });
  read = (reportId: string, member = READER, tenantId?: string): Promise<Reply> => this.call('GET', `/reports/${reportId}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  decide = (reportId: string, version: number, body: Record<string, unknown>, member = REVIEWER, options: Partial<CallOptions> = {}): Promise<Reply> =>
    this.call('POST', `/reports/${reportId}/decision`, { member, body, ifMatch: `"${version}"`, ...options });
  correct = (reportId: string, version: number, body: Record<string, unknown>, member = MAKER, options: Partial<CallOptions> = {}): Promise<Reply> =>
    this.call('POST', `/reports/${reportId}/corrections`, { member, body, ifMatch: `"${version}"`, ...options });
  approve = (reportId: string, version: number, member = REVIEWER): Promise<Reply> => this.decide(reportId, version, { decision: 'approve', reason: 'The figures agree with the Treasury.', evidence_ids: [] }, member);
  giveBack = (reportId: string, version: number, extra: Record<string, unknown> = {}, member = REVIEWER): Promise<Reply> =>
    this.decide(reportId, version, { decision: 'return', reason: 'The CTMTQG cell is wrong.', evidence_ids: [], return_items: ['Fix the CTMTQG cell', 'Explain the fall'], due_at: DUE, ...extra }, member);
  trail = (resourceId: string) => this.rows<{ action: string; safe_diff: Record<string, unknown> }>('select action, safe_diff from machvon.audit_event where resource_id::text = $1 order by occurred_at, id', [resourceId]);
  events = (reportId: string, type: string) => this.rows<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1 and type = $2', [reportId, type]);
  state = async (reportId: string) =>
    (
      await this.rows<{ status: string; version: string; revision: number; is_current: boolean; payload_hash: string; supersedes_id: string | null; amendment_reason: string | null; accepted_by: string | null; submitted_by: string | null }>(
        'select status, version::text as version, revision, is_current, payload_hash, supersedes_id, amendment_reason, accepted_by, submitted_by from machvon.report_revision where id = $1',
        [reportId],
      )
    )[0];
  lockPeriod = async (periodId: string): Promise<void> => {
    await this.rows("update machvon.reporting_period set status = 'SOFT_CLOSED', soft_closed_at = now(), version = version + 1 where id = $1", [periodId]);
    await this.rows("update machvon.reporting_period set status = 'LOCKED', locked_at = now(), locked_by = $2, version = version + 1 where id = $1", [periodId, memberId(MAKER)]);
  };

  /** A report of a project in a week of its own, handed in by the maker: SUBMITTED at version 2. */
  async submitted(options: { project?: { projectId: string; planId: string }; period?: string; extra?: Record<string, unknown> } = {}): Promise<{ reportId: string; projectId: string; planId: string; period: string }> {
    const { projectId, planId } = options.project ?? (await this.seedProject());
    const period = options.period ?? this.week();
    const made = await this.create(this.draft(projectId, period, planId, options.extra));
    if (made.status !== 200) throw new Error(`the draft was not created: ${JSON.stringify(made.json)}`);
    const sent = await this.submit(this.idOf(made), 1);
    if (sent.status !== 200 || sent.json.status !== 'SUBMITTED') throw new Error(`the report was not handed in: ${JSON.stringify(sent.json)}`);
    return { reportId: this.idOf(made), projectId, planId, period };
  }

  async start(options: DisFlowOptions = {}): Promise<void> {
    const { harness } = this;
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [MAKER, REVIEWER, READER, ELSEWHERE_REVIEWER, OTHER_MAKER, ...(options.extraMembers ?? []).map((member) => member.n)]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_MAKER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'DIS_MAKER_REVIEWER', ['report.create', 'report.edit', 'report.submit', 'report.correct', 'report.review', 'report.withdraw', 'report.import', 'report.read', 'report_revision.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'DIS_REVIEWER', ['report.review', 'report.read', 'report_revision.read'], 25);
    await harness.seedRole(TENANT_A, 3, 'DIS_READER', ['report.read', 'report_revision.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'DIS_MAKER', ['report.create', 'report.edit', 'report.submit', 'report.correct', 'report.withdraw', 'report.read', 'report_revision.read'], 30);
    for (const role of options.extraRoles ?? []) await harness.seedRole(TENANT_A, role.n, role.code, role.permissions, role.rank);
    await harness.seedRole(TENANT_B, 1, 'DIS_MAKER_REVIEWER', ['report.create', 'report.edit', 'report.submit', 'report.correct', 'report.review', 'report.withdraw', 'report.import', 'report.read', 'report_revision.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 1, kind: 'TENANT' },
      { n: 2, member: REVIEWER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
      { n: 4, member: ELSEWHERE_REVIEWER, role: 2, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 5, member: OTHER_MAKER, role: 4, kind: 'TENANT' },
      ...(options.extraMembers ?? []).map((member, index) => ({ n: 10 + index, member: member.n, role: member.roleNumber, kind: 'TENANT' as const })),
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MAKER, role: 1, kind: 'TENANT' }]);
    await this.seedReplica([
      ["insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'FUND_SOURCE', 'NSTW', 'EFFECTIVE', $3, $3)", [TENANT_A, id(FAMILY, 33), memberId(MAKER)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
         values ($1, $2, $3, 'FUND_SOURCE', 'NSTW', 1, 'Central budget', '{}', date '2024-01-01', 'EFFECTIVE', 'TENANT', now(), $4, $4)`,
        [TENANT_A, FUND_SOURCE, id(FAMILY, 33), memberId(MAKER)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    await tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 }, async (tx) => {
      await applyBaseline(tx, BASELINE_PACK, WORKER);
      await new DisPeriodStore().generate(tx, { calendarCode: 'DEFAULT', fiscalYear: 2027, periodType: 'WEEK' }, WORKER, NOW);
    });
    await this.rows(
      `insert into machvon.reporting_period
         (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
       select tenant_id, gen_random_uuid(), 'X-' || code, calendar_version, start_date, end_date, deadline_at, 'EXTRA', period_type, fiscal_year, 'OPEN', calendar_version_id, created_by, updated_by
         from machvon.reporting_period where fiscal_year = 2027 and period_type = 'WEEK' and calendar_code = 'DEFAULT'`,
    );
    this.weeks = (await this.rows<{ id: string }>("select id from machvon.reporting_period where fiscal_year = 2027 and period_type = 'WEEK' order by calendar_code, start_date")).map((row) => row.id);
    if (options.afterSeed !== undefined) await options.afterSeed(this);
    this.root = await mkdtemp(join(tmpdir(), options.tmpPrefix ?? 'machvon-dis-flow-'));
    const files = new FileService({ storage: new FsObjectStorage(this.root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    this.app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ReportController, ReportReadsController, ReportSubmitController, ReportDecisionController, ReportLifecycleController, ReportImportController, ...(options.controllers ?? [])],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: files },
        { provide: DIS_CLOCK, useValue: () => this.clockNow },
        { provide: DIS_METRICS, useValue: { increment: (name: string, labels?: Record<string, string>) => void this.counted.push({ name, labels }), gauge: () => undefined } },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
        ...(options.providers ?? []),
      ],
    });
  }

  async stop(): Promise<void> {
    if (this.app) await this.app.close();
    await this.harness.stop();
    await rm(this.root, { recursive: true, force: true });
  }
}

export { TENANT_A, TENANT_B, memberId, unitId, id };
