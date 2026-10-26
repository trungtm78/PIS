import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { disModule } from '../../src/modules/dis';
import { EarlyWarningController } from '../../src/modules/dis/early-warning.controller';
import { DIS_CLOCK, DIS_METRICS } from '../../src/modules/dis/tokens';
import { WarningEvaluateConsumer } from '../../src/modules/dis/warning-evaluate.consumer';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const AUTHOR = 1; // manages the rules
const APPROVER = 2; // publishes them
const LEAD = 3; // manages and publishes, so the one person can try to publish their own rule
const HANDLER = 4; // handles the warnings of the whole tenant
const ELSEWHERE_HANDLER = 5; // handles the warnings of another branch
const READER = 6; // reads
const NOBODY = 7;
const ELSEWHERE_READER = 8; // reads the warnings of another branch
const B_AUTHOR = 1;
const ROOT = 1;
const HERE = 2;
const ELSEWHERE = 3;
const FAMILY = 0xa2;
const NOW = new Date('2027-06-15T03:00:00Z');
const CUTOFF = '2027-06-13';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const ruleBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  rule_code: 'EW-01',
  name: 'Disbursement below the expected curve',
  metric_code: 'YTD_RATE_GAP',
  comparator: 'GTE',
  threshold_json: { points: 10 },
  severity: 'WARNING',
  scope_kind: 'PROJECT',
  legal_basis: 'DIS BR-DIS-13 [assumption until the finance office signs]',
  effective_from: '2027-01-01',
  ...over,
});
const lateBody = (): Record<string, unknown> =>
  ruleBody({ rule_code: 'EW-02', name: 'No report after the deadline', metric_code: 'REPORT_OVERDUE', comparator: 'MISSING', threshold_json: { explanation_due_days: 3 }, severity: 'CRITICAL', auto_explanation: true });

/** The early-warning rules and the warnings over HTTP, and the job that evaluates them after a snapshot is frozen (ST-DIS-012, DIS-20). */
describe('the early-warning rules and warnings over HTTP (ST-DIS-012)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;
  const gauges: Array<{ name: string; value: number; labels: Record<string, string> | undefined }> = [];
  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
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

  const create = (body: Record<string, unknown>, member = AUTHOR, options: { key?: string; tenantId?: string } = {}): Promise<Reply> => call('POST', '/early-warning-rules', { member, body, ...options });
  const publish = (ruleId: string, version: number, member = APPROVER): Promise<Reply> => call('POST', `/early-warning-rules/${ruleId}/publish`, { member, ifMatch: `"${version}"`, body: {} });
  const rules = (member = READER): Promise<Reply> => call('GET', '/early-warning-rules', { member });
  const listed = (query = '', member = READER, tenantId?: string): Promise<Reply> => call('GET', `/early-warnings${query}`, { member, ...(tenantId === undefined ? {} : { tenantId }) });
  const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;
  const handle = (warningId: string, action: 'acknowledge' | 'dismiss', version: number, member = HANDLER, body: Record<string, unknown> = { reason: 'Seen by the unit head.' }): Promise<Reply> =>
    call('POST', `/early-warnings/${warningId}/${action}`, { member, ifMatch: `"${version}"`, body });
  const trail = (resourceId: string) => rows<{ action: string; safe_diff: Record<string, unknown>; actor_id: string }>('select action, safe_diff, actor_id from machvon.audit_event where resource_id::text = $1 order by occurred_at, id', [resourceId]);
  const events = (aggregateId: string, type?: string) =>
    rows<{ type: string; payload: Record<string, unknown> }>('select type, payload from machvon.outbox_event where aggregate_id = $1 and ($2::text is null or type = $2) order by created_at, id', [aggregateId, type ?? null]);
  /** A rule of the code, written by the author and published by the approver. */
  async function inForce(body: Record<string, unknown>): Promise<string> {
    const made = await create(body);
    expect(made.status).toBe(200);
    expect((await publish(idOf(made), 1)).status).toBe(200);
    return idOf(made);
  }
  const reset = (): Promise<void> =>
    seedReplica([
      ['delete from machvon.early_warning', []],
      ["update machvon.early_warning_rule set status = 'RETIRED' where status = 'PUBLISHED'", []],
    ]);

  const projects = new Map<string, string>();
  async function projectOf(name: string, unit = HERE): Promise<string> {
    const known = projects.get(name);
    if (known !== undefined) return known;
    counter += 1;
    const projectId = id(FAMILY, 100 + counter);
    projects.set(name, projectId);
    await seedReplica([
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
        [TENANT_A, projectId, `${name}-${counter}`, unitId(unit), id(FAMILY, 30)],
      ],
    ]);
    return projectId;
  }
  /** A frozen close snapshot of a period (a new one, or the period given: the one frozen before is superseded) with a carrier line for each project at its rate. */
  async function frozen(lines: Array<{ project: string; rate: string | null; unit?: number }>, period?: string): Promise<{ periodId: string; snapshotId: string }> {
    counter += 1;
    const periodId = period ?? id(FAMILY, 1000 + counter);
    if (period === undefined) {
      await seedReplica([
        [
          `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
           values ($1, $2, $3, 1, $4::date, $4::date + 6, timestamptz '2027-06-14T03:00:00Z', 'DEFAULT', 'WEEK', 2027, 'OPEN', $5, $6, $6)`,
          [TENANT_A, periodId, `WH-${counter}`, new Date(Date.UTC(2040, 0, 2) + counter * 7 * 86_400_000).toISOString().slice(0, 10), id(FAMILY, 40), memberId(AUTHOR)],
        ],
      ]);
    }
    const snapshotId = randomUUID();
    await seedReplica([
      [
        `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, created_by, updated_by)
         values ($1, $2, $3, 'PERIOD_CLOSE', $4::timestamptz, $5::date, $5::date, 'BUILDING', 'DIS-METRICS-R1-PROPOSED', 'PROPOSED_PENDING_SIGNOFF', $6, $7, $7)`,
        [TENANT_A, snapshotId, periodId, NOW.toISOString(), CUTOFF, lines.length, WORKER_MEMBERSHIP_ID],
      ],
    ]);
    for (const line of lines) {
      const projectId = await projectOf(line.project, line.unit);
      await seedReplica([
        [
          `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_total_vnd, rate_total_pct, rate_null_reason, treasury_coverage)
           values ($1, gen_random_uuid(), $2, $3, $4, 'CURRENT_YEAR', 'CENTRAL', 1000000000, 1000000000, $5::numeric, $6, 'COMPLETE')`,
          [TENANT_A, snapshotId, projectId, unitId(line.unit ?? HERE), line.rate, line.rate === null ? 'NO_DATA' : null],
        ],
      ]);
    }
    await seedReplica([
      [`update machvon.period_snapshot set status = 'SUPERSEDED' where tenant_id = $1 and period_id = $2 and status = 'FROZEN' and id <> $3`, [TENANT_A, periodId, snapshotId]],
      [`update machvon.period_snapshot set status = 'FROZEN', payload_sha256 = repeat('a', 64), frozen_by = $2, frozen_at = $3::timestamptz where id = $1`, [snapshotId, WORKER_MEMBERSHIP_ID, NOW.toISOString()]],
    ]);
    return { periodId, snapshotId };
  }

  let consumer: WarningEvaluateConsumer;
  const delivery = (snapshotId: string, eventId = randomUUID(), type = 'snapshot.frozen.v1') => ({
    id: eventId,
    tenantId: TENANT_A,
    tenantContext: signTenantContext({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, SIGNING_KEY),
    type,
    payload: { snapshot_id: snapshotId },
  });

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: HERE, path: `/${unitId(ROOT)}/${unitId(HERE)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [AUTHOR, APPROVER, LEAD, HANDLER, ELSEWHERE_HANDLER, READER, NOBODY, ELSEWHERE_READER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_AUTHOR, ROOT);
    await harness.seedRole(TENANT_A, 1, 'WARNING_AUTHOR', ['warning.rule.manage', 'warning.read'], 30);
    await harness.seedRole(TENANT_A, 2, 'WARNING_APPROVER', ['warning.rule.approve', 'warning.read'], 40);
    await harness.seedRole(TENANT_A, 3, 'WARNING_LEAD', ['warning.rule.manage', 'warning.rule.approve', 'warning.read'], 50);
    await harness.seedRole(TENANT_A, 4, 'WARNING_HANDLER', ['warning.handle', 'warning.read'], 30);
    await harness.seedRole(TENANT_A, 5, 'WARNING_READER', ['warning.read'], 20);
    await harness.seedRole(TENANT_B, 1, 'WARNING_AUTHOR', ['warning.rule.manage', 'warning.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: AUTHOR, role: 1, kind: 'TENANT' },
      { n: 2, member: APPROVER, role: 2, kind: 'TENANT' },
      { n: 3, member: LEAD, role: 3, kind: 'TENANT' },
      { n: 4, member: HANDLER, role: 4, kind: 'TENANT' },
      { n: 5, member: ELSEWHERE_HANDLER, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 6, member: READER, role: 5, kind: 'TENANT' },
      { n: 7, member: ELSEWHERE_READER, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_AUTHOR, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [EarlyWarningController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: DIS_CLOCK, useValue: () => NOW },
        { provide: DIS_METRICS, useValue: { increment: () => undefined, gauge: (name: string, value: number, labels?: Record<string, string>) => void gauges.push({ name, value, labels }) } },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
    consumer = new WarningEvaluateConsumer({
      database: tenants,
      security: { signingKey: SIGNING_KEY },
      clock: () => NOW,
      metrics: { increment: () => undefined, gauge: (name: string, value: number, labels?: Record<string, string>) => void gauges.push({ name, value, labels }) },
    });
  }, 300_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('serves the controller of the warnings in the module of DIS', () => {
    expect(disModule.controllers).toContain(EarlyWarningController);
  });

  describe('the rules', () => {
    it('makes a rule as a draft with its legal basis, keeps one audit row and no event, and answers the same key with the same answer', async () => {
      const key = `key-${randomUUID()}`;
      const made = await create(ruleBody({ rule_code: 'EW-H1' }), AUTHOR, { key });
      expect(made).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1 } });
      expect((await create(ruleBody({ rule_code: 'EW-H1' }), AUTHOR, { key })).json).toEqual(made.json);
      expect(await rows('select count(*)::int as n from machvon.early_warning_rule where rule_code = $1', ['EW-H1'])).toEqual([{ n: 1 }]);
      const entry = (await trail(idOf(made))).find((row) => row.action === 'dis.warning_rule_created');
      expect(entry?.safe_diff).toMatchObject({ rule_code: 'EW-H1', revision: 1, metric_code: 'YTD_RATE_GAP', severity: 'WARNING' });
      expect(await events(idOf(made))).toEqual([]);
      const second = await create(ruleBody({ rule_code: 'EW-H1', threshold_json: { points: 12 } }));
      expect(second.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
      expect(await rows<{ revision: number; status: string }>('select revision, status from machvon.early_warning_rule where rule_code = $1 order by revision', ['EW-H1'])).toEqual([
        { revision: 1, status: 'DRAFT' },
        { revision: 2, status: 'DRAFT' },
      ]);
    });

    it('AC-ST-DIS-012-3 / UAT-PLAN-70: a metric nobody computes is 422 METRIC_UNKNOWN and every other fault is 422 on its field; a person without warning.rule.manage is 403; another tenant has its own rules', async () => {
      expect(await create(ruleBody({ metric_code: 'VIBES' }))).toMatchObject({ status: 422, json: { code: 'METRIC_UNKNOWN', detail: 'metric_code' } });
      expect(await create(ruleBody({ threshold_json: { points: 0 } }))).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'threshold_json.points' } });
      expect(await create(ruleBody({ scope_kind: 'TENANT' }))).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'scope_kind' } });
      expect(await create(ruleBody({ rule_code: 'EW-H2' }), READER)).toMatchObject({ status: 403 });
      expect(await create(ruleBody({ rule_code: 'EW-H2' }), NOBODY)).toMatchObject({ status: 403 });
      expect((await create(ruleBody({ rule_code: 'EW-H2' }), B_AUTHOR, { tenantId: TENANT_B })).status).toBe(200);
      expect(await rows('select count(*)::int as n from machvon.early_warning_rule where rule_code = $1', ['EW-H2'], TENANT_A)).toEqual([{ n: 0 }]);
    });

    it('AC-ST-DIS-012-3: the author cannot publish their own rule (403 SELF_APPROVAL_DENIED, the rule stays a draft); another person publishes it once, with an event, and a published rule is versioned and never edited', async () => {
      const made = await create(ruleBody({ rule_code: 'EW-H3' }), LEAD);
      const own = await publish(idOf(made), 1, LEAD);
      expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect(await rows<{ status: string }>('select status from machvon.early_warning_rule where id = $1', [idOf(made)])).toEqual([{ status: 'DRAFT' }]);
      expect(await rows("select count(*)::int as n from machvon.audit_event where action = 'command.denied:publishEarlyWarningRule' and outcome = 'DENIED'")).toEqual([{ n: expect.any(Number) }]);
      expect((await publish(idOf(made), 1, AUTHOR)).status).toBe(403);
      expect(await publish(idOf(made), 9)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      const done = await publish(idOf(made), 1);
      expect(done).toMatchObject({ status: 200, json: { status: 'PUBLISHED', resource_version: 2 } });
      const raised = await events(idOf(made), 'warning.rule_published.v1');
      expect(raised).toHaveLength(1);
      expect(raised[0]?.payload).toMatchObject({ rule_code: 'EW-H3', revision: 1, metric_code: 'YTD_RATE_GAP', severity: 'WARNING', retired_rule_id: null, actor_id: memberId(APPROVER) });
      expect(await publish(idOf(made), 2)).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
      const next = await create(ruleBody({ rule_code: 'EW-H3', threshold_json: { points: 15 } }));
      expect(next.json).toMatchObject({ status: 'DRAFT' });
      expect((await publish(idOf(next), 1)).json).toMatchObject({ status: 'PUBLISHED' });
      expect(await rows<{ revision: number; status: string }>('select revision, status from machvon.early_warning_rule where rule_code = $1 order by revision', ['EW-H3'])).toEqual([
        { revision: 1, status: 'RETIRED' },
        { revision: 2, status: 'PUBLISHED' },
      ]);
      expect((await events(idOf(next), 'warning.rule_published.v1'))[0]?.payload).toMatchObject({ retired_rule_id: idOf(made) });
    });

    it('lists every revision of every rule with its status and who approved it, and says for a draft how many warnings it would open on the latest frozen close snapshot', async () => {
      await reset();
      await frozen([{ project: 'P-PV1', rate: '5.0000' }, { project: 'P-PV2', rate: '50.0000' }]);
      await inForce(ruleBody({ rule_code: 'EW-H5' }));
      const draft = await create(ruleBody({ rule_code: 'EW-H4', threshold_json: { points: 10 } }));
      const reply = await rules();
      expect(reply.status).toBe(200);
      const mine = items(reply).filter((item) => item.rule_code === 'EW-H4');
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ id: idOf(draft), status: 'DRAFT', approved_by: null, revision: 1, threshold_json: { points: '10' }, preview: { would_open: 1 } });
      expect(items(reply).find((item) => item.status === 'PUBLISHED')).toMatchObject({ approved_by: expect.any(String) });
      expect(items(reply).filter((item) => item.status !== 'DRAFT').every((item) => item.preview === undefined)).toBe(true);
      // What a draft would open is told for the projects the caller may read: a reader of another branch is told none.
      const part = (await rules(ELSEWHERE_READER)).json.items as Array<Record<string, unknown>>;
      expect(part.find((item) => item.id === idOf(draft))).toMatchObject({ preview: { would_open: 0 } });
      expect(await rules(NOBODY)).toMatchObject({ status: 403 });
    });
  });

  describe('the evaluation after a snapshot is frozen', () => {
    beforeEach(reset);

    it('AC-ST-DIS-012-1 / UAT-AC252: opens one warning for a slow project with its rule, severity, project and the figures seen and expected, tells it by an event, and the second snapshot updates it without a second warning or a second event', async () => {
      await inForce(ruleBody({ rule_code: 'EW-01' }));
      const a = await projectOf('P-A-002');
      const first = await frozen([{ project: 'P-A-002', rate: '20.0000' }]);
      const eventId = randomUUID();
      expect(await consumer.handle(delivery(first.snapshotId, eventId))).toBe('processed');
      expect(await consumer.handle(delivery(first.snapshotId, eventId))).toBe('duplicate');
      const one = await listed(`?project_id=${a}`);
      expect(items(one)).toHaveLength(1);
      expect(items(one)[0]).toMatchObject({
        rule_code: 'EW-01',
        status: 'OPEN',
        severity: 'WARNING',
        dedupe_key: `EW-01|${a}|2027`,
        project: { id: a, code: expect.stringContaining('P-A-002') },
        snapshot_id: first.snapshotId,
        observed: { metric: 'YTD_RATE_GAP', observed_pct: '20.0000', expected_pct: '44.9315', gap_points: '24.9315' },
      });
      const warningId = items(one)[0]?.id as string;
      const opened = await events(warningId, 'warning.opened.v1');
      expect(opened).toHaveLength(1);
      expect(opened[0]?.payload).toMatchObject({ warning_id: warningId, rule_code: 'EW-01', severity: 'WARNING', subject: { project_id: a, unit_id: unitId(HERE) }, auto_explanation: false, dedupe_key: `EW-01|${a}|2027` });
      const second = await frozen([{ project: 'P-A-002', rate: '22.0000' }], first.periodId);
      expect(await consumer.handle(delivery(second.snapshotId))).toBe('processed');
      const again = await listed(`?project_id=${a}`);
      expect(items(again)).toHaveLength(1);
      expect(items(again)[0]).toMatchObject({ id: warningId, snapshot_id: second.snapshotId, observed: { observed_pct: '22.0000' } });
      expect(await events(warningId, 'warning.opened.v1')).toHaveLength(1);
      expect((await trail(warningId)).map((row) => row.action)).toEqual(['dis.warning_opened']);
      expect((await trail(warningId))[0]?.actor_id).toBe(WORKER_MEMBERSHIP_ID);
      expect(gauges.filter((item) => item.name === 'dis_warning_open_gauge' && item.labels?.severity === 'WARNING').pop()?.value).toBe(1);
    });

    it('AC-ST-DIS-012-2 / UAT-AC253: a CRITICAL warning opens when the deadline has passed without a report, and warning.opened.v1 carries auto_explanation and the days to explain, so that PRJ asks for the explanation', async () => {
      await inForce(lateBody());
      const late = await projectOf('P-LATE');
      const world = await frozen([{ project: 'P-LATE', rate: '50.0000' }]);
      expect(await consumer.handle(delivery(world.snapshotId))).toBe('processed');
      const [warning] = items(await listed(`?project_id=${late}&rule_code=EW-02`));
      expect(warning).toMatchObject({ severity: 'CRITICAL', status: 'OPEN', dedupe_key: `EW-02|${late}|2027|${world.periodId}`, observed: { metric: 'REPORT_OVERDUE', days_past_deadline: 1 } });
      const [opened] = await events(warning?.id as string, 'warning.opened.v1');
      expect(opened?.payload).toMatchObject({ rule_code: 'EW-02', severity: 'CRITICAL', auto_explanation: true, explanation_due_days: 3, subject: { project_id: late } });
    });

    it('closes the warning as AUTO_CLEARED when the next snapshot no longer violates, with a warning.resolved.v1 and the gauge down; and leaves what is not ours alone: another event, another tenant, no snapshot, a forged context', async () => {
      await inForce(ruleBody({ rule_code: 'EW-01' }));
      const a = await projectOf('P-CLEARS');
      const first = await frozen([{ project: 'P-CLEARS', rate: '5.0000' }]);
      await consumer.handle(delivery(first.snapshotId));
      const [warning] = items(await listed(`?project_id=${a}`));
      const second = await frozen([{ project: 'P-CLEARS', rate: '70.0000' }], first.periodId);
      await consumer.handle(delivery(second.snapshotId));
      const [closed] = items(await listed(`?project_id=${a}&status=RESOLVED`));
      expect(closed).toMatchObject({ id: warning?.id, status: 'RESOLVED', resolution_reason: 'AUTO_CLEARED', closed_by: null });
      expect(closed?.closed_at).not.toBeNull();
      const resolved = await events(warning?.id as string, 'warning.resolved.v1');
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.payload).toMatchObject({ rule_code: 'EW-01', resolution: 'AUTO_CLEARED', project_id: a });
      expect((await trail(warning?.id as string)).map((row) => row.action)).toEqual(['dis.warning_opened', 'dis.warning_auto_cleared']);
      expect(gauges.filter((item) => item.name === 'dis_warning_open_gauge' && item.labels?.severity === 'WARNING').pop()?.value).toBe(0);
      expect(await consumer.handle(delivery(second.snapshotId, randomUUID(), 'report.accepted.v1'))).toBe('ignored');
      expect(await consumer.handle({ ...delivery(second.snapshotId), payload: { snapshot_id: second.snapshotId, tenant_id: TENANT_B } })).toBe('ignored');
      await expect(consumer.handle({ ...delivery(second.snapshotId), payload: { snapshot_id: 'nope' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(consumer.handle({ ...delivery(second.snapshotId), tenantContext: 'forged' })).rejects.toMatchObject({ code: 'TENANT_CONTEXT_INVALID' });
      await expect(consumer.handle(delivery(randomUUID()))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });
  });

  describe('handling a warning', () => {
    beforeEach(reset);
    const open = async (name: string, unit = HERE): Promise<{ id: string; version: number }> => {
      await inForce(ruleBody({ rule_code: 'EW-01' }));
      const projectId = await projectOf(name, unit);
      const world = await frozen([{ project: name, rate: '1.0000', unit }]);
      await consumer.handle(delivery(world.snapshotId));
      const [warning] = items(await listed(`?project_id=${projectId}`));
      return { id: warning?.id as string, version: warning?.version as number };
    };

    it('acknowledges a warning with a note and the owner who will handle it, then dismisses it with a reason: each once, with who and when, an audit row without the words and an event for the dismissal', async () => {
      const warning = await open('P-H1');
      const ack = await handle(warning.id, 'acknowledge', warning.version, HANDLER, { reason: 'Seen by the unit head.', owner_membership_id: memberId(APPROVER) });
      expect(ack).toMatchObject({ status: 200, json: { status: 'ACKNOWLEDGED', resource_version: warning.version + 1 } });
      const [row] = await rows<{ status: string; acknowledged_by: string; owner_membership_id: string; acknowledgement_note: string }>('select status, acknowledged_by, owner_membership_id, acknowledgement_note from machvon.early_warning where id = $1', [warning.id]);
      expect(row).toMatchObject({ status: 'ACKNOWLEDGED', acknowledged_by: memberId(HANDLER), owner_membership_id: memberId(APPROVER), acknowledgement_note: 'Seen by the unit head.' });
      expect(await handle(warning.id, 'acknowledge', warning.version + 1)).toMatchObject({ status: 409, json: { code: 'WARNING_STATE_INVALID', warning_status: 'ACKNOWLEDGED' } });
      const dismissed = await handle(warning.id, 'dismiss', warning.version + 1, HANDLER, { reason: 'The project is on the plan of the next quarter.' });
      expect(dismissed).toMatchObject({ status: 200, json: { status: 'DISMISSED' } });
      const trailRows = await trail(warning.id);
      expect(trailRows.map((entry) => entry.action)).toEqual(['dis.warning_opened', 'dis.warning_acknowledged', 'dis.warning_dismissed']);
      expect(JSON.stringify(trailRows)).not.toContain('plan of the next quarter');
      expect((await events(warning.id, 'warning.resolved.v1'))[0]?.payload).toMatchObject({ resolution: 'DISMISSED', warning_id: warning.id });
      expect(await handle(warning.id, 'dismiss', warning.version + 2)).toMatchObject({ status: 409, json: { code: 'WARNING_STATE_INVALID', warning_status: 'DISMISSED' } });
      expect(items(await listed('?status=DISMISSED')).map((item) => item.id)).toContain(warning.id);
    });

    it('is 422 on the reason and the owner, 409 on a version that moved, 404 for a warning that is not there, 403 for a person who may only read', async () => {
      const warning = await open('P-H2');
      expect(await handle(warning.id, 'dismiss', warning.version, HANDLER, { reason: 'no' })).toMatchObject({ status: 422, json: { detail: 'reason' } });
      expect(await handle(warning.id, 'acknowledge', warning.version, HANDLER, { reason: 'Seen by the unit head.', owner_membership_id: randomUUID() })).toMatchObject({ status: 422, json: { detail: 'owner_membership_id' } });
      expect(await handle(warning.id, 'acknowledge', 99)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await handle(randomUUID(), 'acknowledge', 1)).toMatchObject({ status: 404 });
      expect(await handle(warning.id, 'acknowledge', warning.version, READER)).toMatchObject({ status: 403 });
      expect(await handle(warning.id, 'acknowledge', warning.version, NOBODY)).toMatchObject({ status: 403 });
      expect(await rows<{ status: string }>('select status from machvon.early_warning where id = $1', [warning.id])).toEqual([{ status: 'OPEN' }]);
    });

    it('is for the projects in the scope of the handler: the warning of another branch is neither listed nor handled (404), and another tenant sees none', async () => {
      const warning = await open('P-H3');
      expect(await handle(warning.id, 'acknowledge', warning.version, ELSEWHERE_HANDLER)).toMatchObject({ status: 404 });
      expect(items(await listed('', ELSEWHERE_HANDLER))).toEqual([]);
      expect(items(await listed('', HANDLER)).map((item) => item.id)).toContain(warning.id);
      expect(items(await listed('', B_AUTHOR, TENANT_B))).toEqual([]);
      expect(await rows<{ status: string }>('select status from machvon.early_warning where id = $1', [warning.id])).toEqual([{ status: 'OPEN' }]);
    });

    it('lists the warnings newest first, narrowed by status, severity, rule, project and unit, a page at a time; a filter that does not exist is 422 on its field', async () => {
      await inForce(ruleBody({ rule_code: 'EW-01', threshold_json: { points: 10, critical_points: 30 } }));
      const world = await frozen([{ project: 'P-L1', rate: '30.0000' }, { project: 'P-L2', rate: '2.0000' }, { project: 'P-L3', rate: '1.0000' }]);
      await consumer.handle(delivery(world.snapshotId));
      const all = await listed('?limit=200');
      expect(items(all)).toHaveLength(3);
      expect(items(await listed('?severity=CRITICAL'))).toHaveLength(2);
      expect(items(await listed('?status=OPEN&rule_code=EW-01'))).toHaveLength(3);
      expect(items(await listed(`?unit_id=${unitId(HERE)}`))).toHaveLength(3);
      expect(items(await listed(`?unit_id=${unitId(ELSEWHERE)}`))).toHaveLength(0);
      const seen: unknown[] = [];
      let cursor: string | null = null;
      do {
        const page: Reply = await listed(`?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`);
        seen.push(...items(page).map((item) => item.id));
        cursor = page.json.next_cursor as string | null;
      } while (cursor !== null);
      expect(seen).toEqual(items(all).map((item) => item.id));
      for (const [query, detail] of [['?status=GONE', 'status'], ['?severity=LOUD', 'severity'], ['?rule_code=nope', 'rule_code'], ['?project_id=nope', 'project_id'], ['?unit_id=nope', 'unit_id'], ['?cursor=nope', 'cursor']] as const) {
        expect(await listed(query)).toMatchObject({ status: 422, json: { detail } });
      }
      expect(await listed('', NOBODY)).toMatchObject({ status: 403 });
    });
  });
});
