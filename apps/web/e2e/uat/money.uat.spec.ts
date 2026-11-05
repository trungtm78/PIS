import { createHmac, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { membershipOf, sql, stackInfo } from '../support/stack.ts';

/**
 * UAT of the money area (docs/uat/critical/uat.json, journey J-MONEY-01) against the real API and database of the e2e stack (apps/api/test/e2e-stack): the idempotency of a command
 * (the submission of a weekly report: the same key and body answers again without a second audit row or outbox event, the same key with another body is refused, a retry after a
 * timeout finds the first answer) and the allocation of the whole balance of an appropriation by two planners at the same moment (one wins, the balance never goes below zero).
 *
 * The cases TC-UAT-NFR-SECURITY-10, TC-TX03 and TC-NOT01 (the order and the duplication of the receipts of a provider) are not in this file: the stack has nothing that could take a
 * receipt (see not-executed.money.json).
 *
 * The tests call the API directly with the development token of the stack (the format the web session signs with), because a command is a request and not a screen.
 */

const TENANT_A = stackInfo().tenants.A;
const API = (): string => `http://127.0.0.1:${stackInfo().apiPort}`;

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

interface CallOptions {
  /** The Idempotency-Key: a fresh one by default, `null` sends none. */
  key?: string | null;
  /** The version the caller read, sent as If-Match. */
  ifMatch?: number;
  body?: unknown;
}

function tokenOf(user: string): string {
  const key = process.env.E2E_SESSION_KEY;
  if (key === undefined || key === '') throw new Error('E2E_SESSION_KEY is not set');
  const payload = Buffer.from(JSON.stringify({ tenantId: TENANT_A, membershipId: membershipOf(user), scopeVersion: 1, exp: Math.floor(Date.now() / 1000) + 300 }), 'utf8').toString('base64url');
  return `${payload}.${createHmac('sha256', Buffer.from(key, 'base64')).update(payload).digest('base64url')}`;
}

function headersOf(user: string, options: CallOptions): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${tokenOf(user)}`, 'content-type': 'application/json' };
  if (options.key !== null) headers['idempotency-key'] = options.key ?? `uat-${randomUUID()}`;
  if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
  return headers;
}

async function call(user: string, method: 'GET' | 'POST', path: string, options: CallOptions = {}): Promise<Reply> {
  const response = await fetch(`${API()}${path}`, { method, headers: headersOf(user, options), body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    json = { unparsed: text };
  }
  return { status: response.status, headers: response.headers, json };
}

/** A client that gives up: the request is written in full, then the connection is dropped before any answer is read (a timeout on the side of the caller). */
function abandon(path: string, user: string, options: CallOptions): Promise<void> {
  return new Promise((resolve) => {
    const url = new URL(`${API()}${path}`);
    const body = JSON.stringify(options.body ?? {});
    const req = httpRequest(url, { method: 'POST', headers: { ...headersOf(user, options), 'content-length': String(Buffer.byteLength(body)) } });
    req.on('error', () => resolve());
    req.end(body, () => {
      req.destroy();
      resolve();
    });
  });
}

const countOf = async (query: string, params: unknown[]): Promise<number> => (await sql<{ n: number }>(query, params))[0]?.n ?? 0;
const auditCount = (resourceId: string, action?: string): Promise<number> =>
  action === undefined
    ? countOf('select count(*)::int as n from machvon.audit_event where resource_id = $1', [resourceId])
    : countOf('select count(*)::int as n from machvon.audit_event where resource_id = $1 and action = $2', [resourceId, action]);
const outboxCount = (aggregateId: string, type?: string): Promise<number> =>
  type === undefined
    ? countOf('select count(*)::int as n from machvon.outbox_event where aggregate_id = $1', [aggregateId])
    : countOf('select count(*)::int as n from machvon.outbox_event where aggregate_id = $1 and type = $2', [aggregateId, type]);

// ---- the weekly report that is handed in --------------------------------------------------------------------------------------

const REPORT_YEAR = 2046;
const FUNDING_LINES = [
  { bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: '100000000', ctmtqg_subset_vnd: '40000000' },
  { bucket: 'CURRENT_YEAR', budget_level: 'LOCAL', cumulative_vnd: '200000000' },
  { bucket: 'CARRYOVER', budget_level: 'CENTRAL', cumulative_vnd: '30000000' },
  { bucket: 'CARRYOVER', budget_level: 'LOCAL', cumulative_vnd: '70000000' },
  { bucket: 'OTHER', budget_level: 'CENTRAL', cumulative_vnd: '0' },
  { bucket: 'OTHER', budget_level: 'LOCAL', cumulative_vnd: '20000000' },
];
const PROGRESS = { construction_vnd: '300000000', acceptance_vnd: '200000000', treasury_submitted_vnd: '150000000', preparing_dossier_vnd: '50000000', physical_progress_pct: '37.5' };

interface DraftReport {
  reportId: string;
  projectId: string;
  periodId: string;
  planId: string;
}

/** A project with a published plan that allocated 500 million, an open week of a calendar of its own, and the draft of the weekly report saved until it stands at version 4. */
async function seedDraftReport(label: string): Promise<DraftReport> {
  const owner = membershipOf('owner');
  const ownerUnit = stackInfo().units.A['CB-SKHDT-QLDA'];
  const projectId = randomUUID();
  const periodId = randomUUID();
  const planId = randomUUID();
  const [calendar] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'CALENDAR' limit 1", [TENANT_A]);
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [TENANT_A]);
  await sql(
    `insert into machvon.reporting_period
       (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
     values ($1, $2, $3, 1, date '${REPORT_YEAR}-01-04', date '${REPORT_YEAR}-01-10', timestamptz '${REPORT_YEAR}-01-10T03:00:00Z', $4, 'WEEK', ${REPORT_YEAR}, 'OPEN', $5, $6, $6)`,
    [TENANT_A, periodId, `UAT-${label}-${periodId.slice(0, 8)}`, `E2E-UAT-${label}-${periodId.slice(0, 8)}`, calendar?.id, owner],
  );
  await sql(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
     values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
    [TENANT_A, projectId, `UAT-${label}-${projectId.slice(0, 8)}`, `UAT weekly report ${label}`, ownerUnit, area?.id],
  );
  // The plan belongs to the capital module and the decision to DOC: the superuser seeds it with the foreign keys switched off, as the other flows of this stack do.
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into machvon.plan_version (tenant_id, id, project_id, fiscal_year, revision, decision_id, status, effective_at)
       values ($1, $2, $3, ${REPORT_YEAR}, 1, $4, 'PUBLISHED', timestamptz '${REPORT_YEAR - 1}-12-20T01:00:00Z')`,
      [TENANT_A, planId, projectId, randomUUID()],
    );
    await client.query(
      `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id, budget_level)
       values ($1, gen_random_uuid(), $2, $3, 'CURRENT_YEAR', ${REPORT_YEAR}, 500000000, 0, $4, 'CENTRAL')`,
      [TENANT_A, planId, area?.id, projectId],
    );
  } finally {
    await client.end();
  }
  const draft = { project_id: projectId, period_id: periodId, plan_version_id: planId, report_type: 'WEEKLY', measurement_basis: 'YTD', funding_lines: FUNDING_LINES, ...PROGRESS };
  const made = await call('owner', 'POST', '/reports', { body: draft });
  expect([made.status, made.json.status, made.json.resource_version]).toEqual([200, 'DRAFT', 1]);
  const reportId = made.json.resource_id as string;
  for (const version of [1, 2, 3]) {
    const saved = await call('owner', 'POST', `/reports/${reportId}/revisions`, { ifMatch: version, body: draft });
    expect([saved.status, saved.json.resource_version]).toEqual([200, version + 1]);
  }
  const [row] = await sql<{ status: string; version: string }>('select status, version::text as version from machvon.report_revision where id = $1', [reportId]);
  expect(row).toEqual({ status: 'DRAFT', version: '4' });
  return { reportId, projectId, periodId, planId };
}

async function removeReport(seed: DraftReport): Promise<void> {
  // What the test wrote leaves nothing behind for the other flows (the calendar of DIS-14, the register of PRJ-01); the audit rows and the events are append-only and stay.
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query('delete from machvon.report_revision where project_id = $1', [seed.projectId]);
    await client.query('delete from machvon.allocation_line where plan_version_id = $1', [seed.planId]);
    await client.query('delete from machvon.plan_version where id = $1', [seed.planId]);
    await client.query('delete from machvon.reporting_period where id = $1', [seed.periodId]);
    await client.query('delete from machvon.project where id = $1', [seed.projectId]);
  } finally {
    await client.end();
  }
}

const submittedRow = async (reportId: string) =>
  (await sql<{ status: string; version: string; payload_hash: string; submitted_by: string | null; submitted_at: string | null }>(
    'select status, version::text as version, payload_hash, submitted_by, submitted_at::text as submitted_at from machvon.report_revision where id = $1',
    [reportId],
  ))[0];

const SUBMITTED_ACTION = 'dis.report_submitted';
const SUBMITTED_EVENT = 'report.submitted.v1';
const REPLAYED = 'idempotency-replayed';

test.describe('J-MONEY-01 a command is idempotent', () => {
  test('TC-UAT-NFR-SECURITY-04: the same Idempotency-Key and body answers the first answer again, another body is 409, no key is 400, and the report has one audit row and one event', { tag: ['@P0', '@S1', '@money'] }, async () => {
    const seed = await seedDraftReport('SEC04');
    try {
      const { reportId } = seed;
      const auditBefore = await auditCount(reportId);
      const outboxBefore = await outboxCount(reportId);
      const key = `uat-sec04-k001-${randomUUID()}`;
      const path = `/reports/${reportId}/submit`;

      // Step 1: the first send, with the version of the draft the caller read.
      const first = await call('owner', 'POST', path, { key, ifMatch: 4, body: { comment: 'gửi' } });
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ status: 'SUBMITTED', resource_version: 5, resource_id: reportId });
      expect(first.headers.get(REPLAYED)).toBeNull();
      const afterFirst = { audit: await auditCount(reportId, SUBMITTED_ACTION), events: await outboxCount(reportId, SUBMITTED_EVENT) };
      expect(afterFirst).toEqual({ audit: 1, events: 1 });

      // Step 2: the same key and body again: the same answer, marked as a replay, and nothing new is written.
      const again = await call('owner', 'POST', path, { key, ifMatch: 4, body: { comment: 'gửi' } });
      expect(again.status).toBe(200);
      expect(again.json).toEqual(first.json);
      expect(again.headers.get(REPLAYED)).toBe('true');
      expect(await auditCount(reportId, SUBMITTED_ACTION)).toBe(1);
      expect(await outboxCount(reportId, SUBMITTED_EVENT)).toBe(1);

      // Step 3: the same key with another body is a conflict, and the report is as the first send left it.
      const other = await call('owner', 'POST', path, { key, ifMatch: 4, body: { comment: 'khác' } });
      expect(other.status).toBe(409);
      expect(other.json.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await submittedRow(reportId)).toMatchObject({ status: 'SUBMITTED', version: '5' });

      // Step 4: no Idempotency-Key at all is a malformed request, whatever else is right.
      const keyless = await call('owner', 'POST', path, { key: null, ifMatch: 4, body: { comment: 'gửi' } });
      expect(keyless.status).toBe(400);
      expect(keyless.json.code).toBe('INVALID_REQUEST');

      // Step 5: the count of the trail. One submission is one audit row and one event, however often it was sent.
      expect(await auditCount(reportId, SUBMITTED_ACTION)).toBe(1);
      expect(await outboxCount(reportId, SUBMITTED_EVENT)).toBe(1);
      expect(await auditCount(reportId)).toBe(auditBefore + 1);
      expect(await outboxCount(reportId)).toBe(outboxBefore + 1);
    } finally {
      await removeReport(seed);
    }
  });

  test('TC-TX02: a retry after a timeout, a repeat of the same key and body, and the same key with another body leave one business audit row and one logical event', { tag: ['@P0', '@S1', '@money'] }, async () => {
    const seed = await seedDraftReport('TX02');
    try {
      const { reportId } = seed;
      const auditBefore = await auditCount(reportId);
      const outboxBefore = await outboxCount(reportId);
      const key = `uat-tx02-retry-${randomUUID()}`;
      const path = `/reports/${reportId}/submit`;
      const options: CallOptions = { key, ifMatch: 4, body: { comment: 'gửi' } };

      // The caller sends the command and gives up before it reads any answer (a timeout); the server finishes the command all the same.
      // A caller whose request never reached the server sends it again until the work is committed: the key is the same each time.
      for (let attempt = 1; attempt <= 3 && (await outboxCount(reportId, SUBMITTED_EVENT)) === 0; attempt += 1) {
        await abandon(path, 'owner', options);
        await expect.poll(() => outboxCount(reportId, SUBMITTED_EVENT), { timeout: 5_000 }).toBe(1).catch(() => undefined);
      }
      await expect.poll(() => outboxCount(reportId, SUBMITTED_EVENT), { timeout: 15_000 }).toBe(1);
      const committed = await submittedRow(reportId);
      expect(committed).toMatchObject({ status: 'SUBMITTED', version: '5', submitted_by: membershipOf('owner') });

      // The retry with the same key and body gets the answer of the first execution, marked as a replay. A retry that meets the command still running is told to wait (409 with Retry-After) and asks again.
      let retried = await call('owner', 'POST', path, options);
      for (let waits = 0; waits < 10 && retried.json.code === 'IDEMPOTENCY_IN_PROGRESS'; waits += 1) retried = await call('owner', 'POST', path, options);
      expect(retried.status).toBe(200);
      expect(retried.headers.get(REPLAYED)).toBe('true');
      expect(retried.json).toMatchObject({ status: 'SUBMITTED', resource_version: 5, resource_id: reportId, payload_hash: committed?.payload_hash });
      expect(await auditCount(reportId, SUBMITTED_ACTION)).toBe(1);
      expect(await outboxCount(reportId, SUBMITTED_EVENT)).toBe(1);

      // A second repeat of the same key and body answers the same again.
      const repeated = await call('owner', 'POST', path, options);
      expect(repeated.status).toBe(200);
      expect(repeated.headers.get(REPLAYED)).toBe('true');
      expect(repeated.json).toEqual(retried.json);

      // The same key with another body is refused and changes nothing.
      const other = await call('owner', 'POST', path, { key, ifMatch: 4, body: { comment: 'khác' } });
      expect(other.status).toBe(409);
      expect(other.json.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await submittedRow(reportId)).toEqual(committed);

      // At most one business audit row and one logical event in all.
      expect(await auditCount(reportId, SUBMITTED_ACTION)).toBe(1);
      expect(await outboxCount(reportId, SUBMITTED_EVENT)).toBe(1);
      expect(await auditCount(reportId)).toBe(auditBefore + 1);
      expect(await outboxCount(reportId)).toBe(outboxBefore + 1);
    } finally {
      await removeReport(seed);
    }
  });
});

// ---- the allocation of the whole balance of a source of capital ---------------------------------------------------------------

const BALANCE_VND = '100000000';
const DOCUMENT_ID = '00000000-0000-4000-005d-000000000001';
const unitOf = (code: string): string => stackInfo().units.A[code] as string;

interface CapitalWorld {
  year: number;
  appropriationId: string;
  racers: Array<{ user: string; planId: string; projectId: string }>;
}

/** A published appropriation of 100,000,000 VND with nothing allocated, and two planners who each have a draft plan of the year and a project of their own. */
async function seedCapital(year: number): Promise<CapitalWorld> {
  const appropriationId = randomUUID();
  const [fund] = await sql<{ id: string }>(
    "select v.id from machvon.master_record_version v join machvon.master_record r on r.id = v.master_record_id where v.tenant_id = $1 and v.master_type = 'FUND_SOURCE' and r.business_key = 'NSTW' and v.status = 'EFFECTIVE' limit 1",
    [TENANT_A],
  );
  const [area] = await sql<{ id: string }>("select id from machvon.master_record_version where tenant_id = $1 and master_type = 'AREA' limit 1", [TENANT_A]);
  await sql(
    `insert into machvon.appropriation
       (tenant_id, id, fund_source_version_id, plan_year, origin, budget_level, amount_vnd, allocated_total_vnd, decision_document_id, issuing_authority, source_year, revision, status, approved_by, created_by, updated_by)
     values ($1, $2, $3, $4, 'PM_ASSIGNED', 'CENTRAL', $5::numeric, 0, $6, 'Thủ tướng Chính phủ', $4, 1, 'PUBLISHED', $7, $8, $8)`,
    [TENANT_A, appropriationId, fund?.id, year, BALANCE_VND, DOCUMENT_ID, membershipOf('capApprover'), membershipOf('owner')],
  );
  const racers: CapitalWorld['racers'] = [];
  for (const [index, user] of ['planPlanner', 'planSecond'].entries()) {
    const projectId = randomUUID();
    const planId = randomUUID();
    await sql(
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, project_group, national_project_code, version, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, 'INTERNAL', 1000, 'PIPELINE', 'B', $7, 1, $8, $8)`,
      [TENANT_A, projectId, `UAT-CAP-${projectId.slice(0, 8)}`, `UAT allocation project ${index + 1}`, unitOf('CB-SKHDT-QLDA'), area?.id, String(70000000 + Number.parseInt(projectId.slice(0, 6), 16)), membershipOf('owner')],
    );
    await sql(
      `insert into machvon.capital_plan (tenant_id, id, plan_code, plan_kind, plan_year, period_from_year, period_to_year, scope_unit_id, revision, status, created_by, updated_by)
       values ($1, $2, $3, 'ANNUAL', $4, $4, $4, $5, 1, 'DRAFT', $6, $6)`,
      [TENANT_A, planId, `UAT-CAP-${planId.slice(0, 8)}`, year, unitOf('CB-STC'), membershipOf(user)],
    );
    racers.push({ user, planId, projectId });
  }
  return { year, appropriationId, racers };
}

async function removeCapital(world: CapitalWorld): Promise<void> {
  const planIds = world.racers.map((racer) => racer.planId);
  const client = new Client({ connectionString: stackInfo().adminUrl });
  await client.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.cap_allocation_write', 'on', true)");
    await client.query('delete from machvon.allocation_line where plan_version_id in (select id from machvon.plan_version where capital_plan_id = any($1::uuid[]))', [planIds]);
    await client.query('delete from machvon.plan_version where capital_plan_id = any($1::uuid[])', [planIds]);
    await client.query('delete from machvon.capital_plan where id = any($1::uuid[])', [planIds]);
    await client.query('delete from machvon.appropriation where id = $1', [world.appropriationId]);
    await client.query('delete from machvon.project where id = any($1::uuid[])', [world.racers.map((racer) => racer.projectId)]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
}

interface Outcome {
  status: number;
  code: string | undefined;
  availableVnd: string | undefined;
}

interface Round {
  outcomes: Outcome[];
  allocatedVnd: string;
  remainingVnd: string;
  lines: number;
}

/** Puts the fixture back to its start: nothing allocated, both plans empty at version 1. */
async function resetRound(db: Client, world: CapitalWorld): Promise<void> {
  const planIds = world.racers.map((racer) => racer.planId);
  await db.query('begin');
  try {
    await db.query("select set_config('app.cap_allocation_write', 'on', true)");
    await db.query('update machvon.appropriation set allocated_total_vnd = 0 where id = $1', [world.appropriationId]);
    await db.query('delete from machvon.allocation_line where plan_version_id in (select id from machvon.plan_version where capital_plan_id = any($1::uuid[]))', [planIds]);
    await db.query('delete from machvon.plan_version where capital_plan_id = any($1::uuid[])', [planIds]);
    await db.query('update machvon.capital_plan set version = 1 where id = any($1::uuid[])', [planIds]);
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}

/** Both planners ask for the whole balance at the same moment: the requests are made ready, held at a barrier and released together. */
async function raceRound(db: Client, world: CapitalWorld): Promise<Round> {
  await resetRound(db, world);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = world.racers.map(async (racer) => {
    const options: CallOptions = {
      ifMatch: 1,
      body: { lines: [{ project_id: racer.projectId, appropriation_id: world.appropriationId, bucket: 'CURRENT_YEAR', source_year: world.year, amount_vnd: BALANCE_VND }] },
    };
    await barrier;
    const reply = await call(racer.user, 'POST', `/capital-plans/${racer.planId}/allocations`, options);
    return { status: reply.status, code: reply.json.code as string | undefined, availableVnd: reply.json.available_vnd as string | undefined };
  });
  release();
  const outcomes = await Promise.all(started);
  const planIds = world.racers.map((racer) => racer.planId);
  const balance = await db.query<{ allocated: string; remaining: string }>('select allocated_total_vnd::text as allocated, (amount_vnd - allocated_total_vnd)::text as remaining from machvon.appropriation where id = $1', [world.appropriationId]);
  const lines = await db.query<{ n: number }>('select count(*)::int as n from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = any($1::uuid[])', [planIds]);
  return { outcomes, allocatedVnd: balance.rows[0]?.allocated ?? '', remainingVnd: balance.rows[0]?.remaining ?? '', lines: lines.rows[0]?.n ?? -1 };
}

const label = (outcome: Outcome): string => (outcome.code === undefined ? String(outcome.status) : `${outcome.status} ${outcome.code}`);
const tally = (rounds: readonly Round[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const round of rounds) for (const outcome of round.outcomes) counts[label(outcome)] = (counts[label(outcome)] ?? 0) + 1;
  return counts;
};

const ROUNDS = 1000;
const TX01_ROUNDS = 25;

test.describe('J-MONEY-01 two allocations of the whole balance', () => {
  test('TC-UAT-NFR-SECURITY-09: in every round exactly one of two simultaneous allocations of 100,000,000 VND is 200, the other is refused (409 VERSION_CONFLICT, or 422 APPROPRIATION_EXCEEDED per CAP.md), and the balance ends at 0 and never below', { tag: ['@P0', '@S1', '@money'] }, async () => {
    test.setTimeout(30 * 60_000);
    const world = await seedCapital(2088);
    const db = new Client({ connectionString: stackInfo().adminUrl });
    await db.connect();
    const rounds: Round[] = [];
    const startedAt = Date.now();
    try {
      for (let round = 1; round <= ROUNDS; round += 1) rounds.push(await raceRound(db, world));
    } finally {
      await db.end();
      await removeCapital(world);
    }
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const counts = tally(rounds);
    test.info().annotations.push({ type: 'rounds', description: `${rounds.length} rounds in ${seconds} s; outcomes of the ${rounds.length * 2} commands: ${JSON.stringify(counts)}` });

    expect(rounds).toHaveLength(ROUNDS);
    // Exactly one command wins in each round.
    expect.soft(rounds.filter((round) => round.outcomes.filter((outcome) => outcome.status === 200).length !== 1).map((round) => rounds.indexOf(round) + 1)).toEqual([]);
    // The other one is a refusal. The cross-cutting case text names 409 BALANCE_INSUFFICIENT or VERSION_CONFLICT; the module specification outranks that restatement:
    // CAP.md (draftCapitalAllocation, BR-CAP-02) and the error registry (APPROPRIATION_EXCEEDED) say the loser of two planners on one appropriation gets
    // 422 APPROPRIATION_EXCEEDED, or 409 VERSION_CONFLICT when both use the same plan. The wording of the cross-cutting case is to be corrected (TODOS.md).
    const refusals = rounds.flatMap((round) => round.outcomes.filter((outcome) => outcome.status !== 200).map(label));
    expect.soft(refusals).toHaveLength(ROUNDS);
    expect.soft(refusals.filter((outcome) => !['409 BALANCE_INSUFFICIENT', '409 VERSION_CONFLICT', '422 APPROPRIATION_EXCEEDED'].includes(outcome))).toEqual([]);
    // The whole 100,000,000 is allocated once: the balance ends at 0 and one line exists, in every round.
    expect.soft(rounds.filter((round) => round.allocatedVnd !== BALANCE_VND).length).toBe(0);
    expect.soft(rounds.filter((round) => round.remainingVnd !== '0').length).toBe(0);
    expect.soft(rounds.filter((round) => round.lines !== 1).length).toBe(0);
    // No round ever left the balance below zero.
    expect.soft(rounds.filter((round) => round.remainingVnd.startsWith('-')).length).toBe(0);
  });

  test('TC-TX01: only one of two simultaneous allocations of the whole balance succeeds, the balance is 0, the other is refused as a conflict or insufficient and leaves no trace', { tag: ['@P0', '@S1', '@money'] }, async () => {
    test.setTimeout(10 * 60_000);
    const world = await seedCapital(2087);
    const db = new Client({ connectionString: stackInfo().adminUrl });
    await db.connect();
    const otherTenantAudit = async (): Promise<number> => countOf('select count(*)::int as n from machvon.audit_event where tenant_id = $1', [stackInfo().tenants.B]);
    const tenantBBefore = await otherTenantAudit();
    const rounds: Round[] = [];
    try {
      const planAudit = (planId: string): Promise<number> => countOf("select count(*)::int as n from machvon.audit_event where resource_id = $1 and action = 'capital.plan_allocation_drafted'", [planId]);
      const planVersion = async (planId: string): Promise<string | undefined> => (await sql<{ version: string }>('select version::text as version from machvon.capital_plan where id = $1', [planId]))[0]?.version;
      const planLines = (planId: string): Promise<number> =>
        countOf('select count(*)::int as n from machvon.allocation_line al join machvon.plan_version pv on pv.id = al.plan_version_id where pv.capital_plan_id = $1', [planId]);
      for (let round = 1; round < TX01_ROUNDS; round += 1) rounds.push(await raceRound(db, world));
      // The last round is looked at closely: the trail of each plan before and after it.
      const auditBefore = await Promise.all(world.racers.map((racer) => planAudit(racer.planId)));
      const last = await raceRound(db, world);
      rounds.push(last);
      const auditAfter = await Promise.all(world.racers.map((racer) => planAudit(racer.planId)));
      const winnerIndex = last.outcomes.findIndex((outcome) => outcome.status === 200);
      const winner = world.racers[winnerIndex];
      const loser = world.racers[winnerIndex === 0 ? 1 : 0];
      expect(winner).toBeDefined();
      expect(loser).toBeDefined();
      // The winner's plan was drafted once and audited once; the loser's plan has no line, no new audit row and its version is untouched.
      expect(await planLines(winner?.planId ?? '')).toBe(1);
      expect(await planVersion(winner?.planId ?? '')).toBe('2');
      expect(auditAfter[winnerIndex]).toBe((auditBefore[winnerIndex] ?? 0) + 1);
      expect(await planLines(loser?.planId ?? '')).toBe(0);
      expect(await planVersion(loser?.planId ?? '')).toBe('1');
      expect(auditAfter[winnerIndex === 0 ? 1 : 0]).toBe(auditBefore[winnerIndex === 0 ? 1 : 0]);
    } finally {
      await db.end();
      await removeCapital(world);
    }
    test.info().annotations.push({ type: 'rounds', description: `${rounds.length} rounds; outcomes: ${JSON.stringify(tally(rounds))}` });

    expect(rounds).toHaveLength(TX01_ROUNDS);
    // Only one succeeds in each round.
    expect.soft(rounds.filter((round) => round.outcomes.filter((outcome) => outcome.status === 200).length !== 1)).toEqual([]);
    // The balance is 0: all 100,000,000 allocated once, nothing more, never below zero.
    expect.soft(rounds.filter((round) => round.allocatedVnd !== BALANCE_VND || round.remainingVnd !== '0')).toEqual([]);
    expect.soft(rounds.filter((round) => round.lines !== 1)).toEqual([]);
    // The request that is left is a conflict or says that the balance does not take it: a refusal of the business, never a 5xx, and it names no balance it could have taken.
    const refused = rounds.flatMap((round) => round.outcomes.filter((outcome) => outcome.status !== 200));
    expect.soft(refused).toHaveLength(TX01_ROUNDS);
    expect.soft(refused.filter((outcome) => !['409 BALANCE_INSUFFICIENT', '409 VERSION_CONFLICT', '422 APPROPRIATION_EXCEEDED'].includes(label(outcome)))).toEqual([]);
    expect.soft(refused.filter((outcome) => outcome.code === 'APPROPRIATION_EXCEEDED' && outcome.availableVnd !== '0')).toEqual([]);
    // Nothing happened to another tenant.
    expect.soft(await otherTenantAudit()).toBe(tenantBBefore);
  });
});
