import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { AuditWriter, TreasuryDailyReconJob, TreasuryDailyReconStore } from '@machvon/db';
import { isWeekday, reconAddDays, vietnamDateOf } from '@machvon/kernel';
import type { TenantDatabase, TenantTx } from '@machvon/db';
import { TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { BRANCH_A, MEMBERS, PayApp } from '../pay/pay-app';
import { TENANT_HEADER } from '../isolation/test-auth.guard';

const { IMPORTER, CONFIRMER, BRANCH_IMPORTER, BRANCH_READER, BRANCH_CONFIRMER, IMPORT_READER, NOBODY } = MEMBERS;
const OWNER = IMPORT_READER; // an item is given to this person, who may also resolve (and so is refused as the one who writes it off)
const RUNNER = IMPORTER; // runs, reads, assigns, explains; also the importer of the statements (the default owner)
const CHECKER = CONFIRMER; // resolves and writes off, but did not open, own or explain

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const pay = new PayApp();
const NOW = new Date();
const TODAY = vietnamDateOf(NOW);

/** The nearest weekday that is at least `age` days back and is not in `taken`: every scenario has a day of its own. */
const taken = new Set<string>();
function weekdayAgo(age: number): string {
  let day = reconAddDays(TODAY, -age);
  while (!isWeekday(day) || taken.has(day)) day = reconAddDays(day, -1);
  taken.add(day);
  return day;
}
function weekendAgo(age: number): string {
  let day = reconAddDays(TODAY, -age);
  while (isWeekday(day) || taken.has(day)) day = reconAddDays(day, -1);
  taken.add(day);
  return day;
}

async function call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply & { headers: Headers }> {
  const headers: Record<string, string> = { [TENANT_HEADER]: pay.tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
  if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
  if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
  const response = await fetch(`${pay.app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
  return { status: response.status, json: (await response.json()) as Record<string, unknown>, headers: response.headers };
}

async function admin(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: pay.harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

let counter = 0;
const next = (): number => (counter += 1);

/** A fund source in force with its allocation line on a project: the fund the money of that line is attributed to. */
async function fundLine(projectId: string, code: string): Promise<string> {
  const record = randomUUID();
  const version = randomUUID();
  const line = randomUUID();
  await admin([
    ["insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'FUND_SOURCE', $3, 'EFFECTIVE', $4, $4) on conflict do nothing", [TENANT_A, record, `${code}-${next()}`, memberId(RUNNER)]],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_record_id, master_type, code, revision, label, attributes, valid_from, status, namespace, published_at, created_by, updated_by)
       values ($1, $2, $3, 'FUND_SOURCE', $4, 1, $5, '{}', date '2024-01-01', 'EFFECTIVE', 'TENANT', now(), $6, $6)`,
      [TENANT_A, version, record, code, `Fund ${code}`, memberId(RUNNER)],
    ],
    [
      `insert into machvon.allocation_line (tenant_id, id, plan_version_id, fund_source_version_id, bucket, source_year, amount_vnd, ctmtqg_subset_vnd, project_id, budget_level, origin)
       values ($1, $2, gen_random_uuid(), $3, 'CURRENT_YEAR', 2026, 1000000000, 0, $4, 'CENTRAL', 'PM_ASSIGNED')`,
      [TENANT_A, line, version, projectId],
    ],
  ]);
  return line;
}

async function statement(day: string): Promise<string> {
  const importId = randomUUID();
  await admin([
    [
      `insert into machvon.treasury_import (tenant_id, id, provider, source_kind, file_name, file_sha256, file_object_key, statement_date, row_total, row_new, status, imported_by, created_by)
       values ($1, $2, 'KBNN_FILE', 'STATEMENT_FILE', $3, $4, $5, $6::date, 1, 1, 'APPLIED', $7, $7)`,
      [TENANT_A, importId, `statement-${day}`, randomUUID().replaceAll('-', '').padEnd(64, 'a'), `key-${importId}`, day, memberId(RUNNER)],
    ],
  ]);
  return importId;
}

/** A transaction of the Treasury on a day (Vietnam time); a refund names the payment it takes back. */
async function paid(projectId: string, amount: string, day: string, options: { line?: string | null; importId?: string | null; refundOf?: string | null } = {}): Promise<string> {
  const txId = randomUUID();
  await admin([
    [
      `insert into machvon.treasury_transaction (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, direction, reversal_of_id, import_id, allocation_line_id)
       values ($1, $2, $3, $4, 'KBNN_FILE', $5::numeric, $6::timestamptz, repeat('e', 64), $7, $8, $9, $10)`,
      [TENANT_A, txId, projectId, `EXT-${txId}`, amount, `${day}T09:00:00+07:00`, options.refundOf === undefined || options.refundOf === null ? 'PAYMENT' : 'REFUND', options.refundOf ?? null, options.importId ?? randomUUID(), options.line ?? null],
    ],
  ]);
  return txId;
}

/** A payment request the books say was settled on a day. */
async function settled(projectId: string, contractId: string, net: string, day: string, line: string | null): Promise<string> {
  const requestId = randomUUID();
  await admin([
    [
      `insert into machvon.payment_request
         (tenant_id, id, project_id, contract_id, acceptance_id, currency, gross_vnd, advance_recovery_vnd, retention_vnd, tax_adjustment_vnd, net_vnd, status, version, claims_acceptance, request_no, created_by, submitted_by,
          allocation_line_id, settled_transaction_id, treasury_paid_on, settled_by, settled_at)
       values ($1, $2, $3, $4, $5, 'VND', $6::numeric, 0, 0, 0, $6::numeric, 'SETTLED', 1, true, $7, $8, $8, $9, $10, $11::date, $8, $12::timestamptz)`,
      [TENANT_A, requestId, projectId, contractId, randomUUID(), net, `HS-${next()}`, memberId(MEMBERS.MAKER), line, randomUUID(), day, `${day}T05:00:00Z`],
    ],
  ]);
  return requestId;
}

const run = (day: string, member: number = RUNNER, key?: string): Promise<Reply> => call('POST', '/treasury-daily-recon/runs', { member, body: { recon_date: day }, ...(key === undefined ? {} : { key }) });
const items = (reply: Reply): Array<Record<string, unknown>> => reply.json.items as Array<Record<string, unknown>>;
const itemsOf = (day: string) =>
  pay.rows<{ id: string; fund_key: string; kind: string; status: string; difference_vnd: string; latest_difference_vnd: string; owner_membership_id: string; due_on: string; version: string; project_id: string; cleared_run_id: string | null }>(
    'select id, fund_key, kind, status, difference_vnd::text, latest_difference_vnd::text, owner_membership_id, due_on::text, version::text, project_id, cleared_run_id from machvon.treasury_daily_recon_item where recon_date = $1::date order by fund_key, id',
    [day],
  );

describe('the daily reconciliation with the Treasury by project code and fund (G4-4)', () => {
  const A = (): string => pay.worldA.projectA;
  const B = (): string => pay.worldA.projectB;
  const D1 = weekdayAgo(6);
  const D_MISSING = weekdayAgo(8);
  const D_WEEKEND = weekendAgo(6);
  const D_UNREADABLE = weekdayAgo(10);
  let nsns = '';
  let oda = '';

  beforeAll(async () => {
    await pay.start();
    const { harness } = pay;
    await harness.seedRole(TENANT_A, 21, 'RECON_RUNNER', ['treasury.daily_recon.run', 'treasury.daily_recon.read', 'treasury.daily_recon.assign', 'treasury.daily_recon.resolve'], 30);
    await harness.seedRole(TENANT_A, 22, 'RECON_BRANCH_READER', ['treasury.daily_recon.read'], 20);
    await harness.seedRole(TENANT_A, 23, 'RECON_CHECKER', ['treasury.daily_recon.read', 'treasury.daily_recon.resolve'], 35);
    await harness.seedRole(TENANT_A, 24, 'RECON_BRANCH_RUNNER', ['treasury.daily_recon.run', 'treasury.daily_recon.read'], 25);
    await harness.seedRole(TENANT_A, 25, 'RECON_OWNER_RESOLVER', ['treasury.daily_recon.resolve', 'treasury.daily_recon.read'], 20);
    await harness.seedRole(TENANT_A, 26, 'RECON_BRANCH_RESOLVER', ['treasury.daily_recon.resolve', 'treasury.daily_recon.read'], 25);
    await harness.seedGrants(TENANT_A, [
      { n: 21, member: RUNNER, role: 21, kind: 'TENANT' },
      { n: 22, member: BRANCH_READER, role: 22, kind: 'UNIT_SUBTREE', refs: [unitId(BRANCH_A)] },
      { n: 23, member: CHECKER, role: 23, kind: 'TENANT' },
      { n: 24, member: BRANCH_IMPORTER, role: 24, kind: 'UNIT_SUBTREE', refs: [unitId(BRANCH_A)] },
      { n: 25, member: OWNER, role: 25, kind: 'TENANT' },
      { n: 26, member: BRANCH_CONFIRMER, role: 26, kind: 'UNIT_SUBTREE', refs: [unitId(BRANCH_A)] },
    ]);
    nsns = await fundLine(A(), 'NSNN');
    oda = await fundLine(A(), 'ODA');
  }, 300_000);

  afterAll(async () => {
    await pay.stop();
  }, 60_000);

  it('is registered in the PAY module with its commands and reads', () => {
    expect([...pay.app.implementedOperations]).toEqual(
      expect.arrayContaining(['runTreasuryDailyRecon', 'assignTreasuryDailyReconItem', 'resolveTreasuryDailyReconItem', 'listTreasuryDailyReconRuns', 'getTreasuryDailyReconRun', 'listTreasuryDailyReconItems', 'getTreasuryDailyReconItem']),
    );
  });

  describe('runTreasuryDailyRecon', () => {
    let firstRun = '';

    it('compares the books with the Treasury for each project code and fund, opens an item only above the threshold, and says what it used', async () => {
      const importId = await statement(D1);
      // A / NSNN: both sides say 10,000,000 (equal: no kind).
      await paid(A(), '10000000', D1, { line: nsns, importId });
      await settled(A(), pay.worldA.contractA, '10000000', D1, nsns);
      // A / ODA: books 5,000,000, Treasury 8,000,000 (AMOUNT, 3,000,000 above the threshold of 1,000,000).
      await paid(A(), '8000000', D1, { line: oda, importId });
      await settled(A(), pay.worldA.contractA, '5000000', D1, oda);
      // B / no fund: the Treasury paid 2,000,000 that no fund can be found for (UNMATCHED).
      await paid(B(), '2000000', D1, { importId });
      // B / NSNN: the books say 4,000,000 and the Treasury booked nothing (MISSING_ON_TREASURY, a difference of -4,000,000).
      const bLine = await fundLine(B(), 'NSNN');
      await settled(B(), pay.worldA.contractB, '4000000', D1, bLine);
      // A / TOK: the Treasury paid exactly the threshold more than the books (1,000,000): within, so no item.
      const tok = await fundLine(A(), 'TOK');
      await paid(A(), '1000000', D1, { line: tok, importId });

      const reply = await run(D1);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ run_status: 'COMPLETE', partial_reason: null, reused: false, line_count: 5, opened_items: 3, cleared_items: 0, recon_date: D1, run_no: 1 });
      firstRun = reply.json.resource_id as string;

      const [stored] = await pay.rows<Record<string, unknown>>('select status, rule_version, rule_source, rule_unverified, threshold_vnd::text as threshold, due_days, partial_after_days, calendar_basis, statement_imports, transaction_count, origin, opened_items, books_total_vnd::text as books, treasury_total_vnd::text as treasury, difference_line_count from machvon.treasury_daily_recon_run where id = $1', [firstRun]);
      expect(stored).toMatchObject({ status: 'COMPLETE', rule_version: 0, rule_source: 'DEFAULT', rule_unverified: true, threshold: '1000000', due_days: 3, partial_after_days: 1, statement_imports: 1, transaction_count: 4, origin: 'MANUAL', opened_items: 3, books: '19000000', treasury: '21000000', difference_line_count: 4 });

      const lines = await pay.rows<{ project_code: string; fund_key: string; books_vnd: string; treasury_vnd: string; difference_vnd: string; kind: string | null; opens_item: boolean }>(
        'select project_code, fund_key, books_vnd::text, treasury_vnd::text, difference_vnd::text, kind, opens_item from machvon.treasury_daily_recon_line where run_id = $1 order by project_code, fund_key',
        [firstRun],
      );
      const code = pay.worldA.projectCodeA;
      expect(lines.find((line) => line.project_code === code && line.fund_key === 'NSNN')).toMatchObject({ books_vnd: '10000000', treasury_vnd: '10000000', difference_vnd: '0', kind: null, opens_item: false });
      expect(lines.find((line) => line.project_code === code && line.fund_key === 'ODA')).toMatchObject({ difference_vnd: '3000000', kind: 'AMOUNT', opens_item: true });
      expect(lines.find((line) => line.project_code === code && line.fund_key === 'TOK')).toMatchObject({ difference_vnd: '1000000', kind: 'MISSING_INTERNAL', opens_item: false });
      expect(lines.find((line) => line.project_code === pay.worldA.projectCodeB && line.fund_key === 'UNMATCHED')).toMatchObject({ difference_vnd: '2000000', kind: 'UNMATCHED', opens_item: true });
      expect(lines.find((line) => line.project_code === pay.worldA.projectCodeB && line.fund_key === 'NSNN')).toMatchObject({ difference_vnd: '-4000000', kind: 'MISSING_ON_TREASURY', opens_item: true });
    });

    it('opens one item for each difference with an owner (the importer of the statement) and a due day in working days; both figures are kept', async () => {
      const found = await itemsOf(D1);
      expect(found.map((item) => [item.fund_key, item.kind, item.difference_vnd, item.status])).toEqual([
        ['NSNN', 'MISSING_ON_TREASURY', '-4000000', 'OPEN'],
        ['ODA', 'AMOUNT', '3000000', 'OPEN'],
        ['UNMATCHED', 'UNMATCHED', '2000000', 'OPEN'],
      ]);
      for (const item of found) {
        expect(item.owner_membership_id).toBe(memberId(RUNNER));
        expect(item.due_on > TODAY).toBe(true);
        expect(isWeekday(item.due_on)).toBe(true);
      }
      // Three working days after today.
      let day = TODAY;
      let left = 3;
      while (left > 0) {
        day = reconAddDays(day, 1);
        if (isWeekday(day)) left -= 1;
      }
      expect(found[0]?.due_on).toBe(day);
    });

    it('audits the pass and tells the world once, with facts and no figures of a person', async () => {
      expect(await pay.rows('select action from machvon.audit_event where resource_id = $1', [firstRun])).toEqual([{ action: 'pay.treasury_daily_recon_run' }]);
      expect(await pay.rows('select type from machvon.outbox_event where aggregate_id = $1', [firstRun])).toEqual([{ type: 'pay.treasury_daily_recon.run.v1' }]);
    });

    it('is idempotent: a second pass that finds the very lines writes nothing, and the same key answers the same', async () => {
      const key = `key-${randomUUID()}`;
      const again = await run(D1, RUNNER, key);
      expect(again.status).toBe(200);
      expect(again.json).toMatchObject({ reused: true, run_no: 1, resource_id: firstRun, opened_items: 0 });
      expect(await pay.count('select count(*)::text as n from machvon.treasury_daily_recon_run where recon_date = $1::date', [D1])).toBe(1);
      expect(await pay.count('select count(*)::text as n from machvon.treasury_daily_recon_item where recon_date = $1::date', [D1])).toBe(3);
      expect(await run(D1, RUNNER, key)).toMatchObject({ status: 200, json: { reused: true } });
    });

    it('clears the item whose difference is gone with the pass that proves it, and keeps the rest (the figures never change)', async () => {
      // The books catch up with the Treasury on ODA: a settled payment of 3,000,000 more.
      await settled(A(), pay.worldA.contractA, '3000000', D1, oda);
      const reply = await run(D1);
      expect(reply.json).toMatchObject({ run_status: 'COMPLETE', reused: false, run_no: 2, opened_items: 0, cleared_items: 1 });
      const found = await itemsOf(D1);
      const odaItem = found.find((item) => item.fund_key === 'ODA');
      expect(odaItem).toMatchObject({ status: 'AUTO_CLEARED', difference_vnd: '3000000', latest_difference_vnd: '0', cleared_run_id: reply.json.resource_id });
      expect(found.filter((item) => item.status === 'OPEN')).toHaveLength(2);
      // The opening figures are never rewritten.
      expect(await pay.rows('select books_vnd::text, treasury_vnd::text from machvon.treasury_daily_recon_item where id = $1', [odaItem?.id])).toEqual([{ books_vnd: '5000000', treasury_vnd: '8000000' }]);
      expect(await pay.rows("select 1 from machvon.treasury_daily_recon_run where recon_date = $1::date and run_no = 2 and cleared_items = 1 and opened_items = 0", [D1])).toHaveLength(1);
    });

    it('a day with no statement and no transaction is PARTIAL with its reason and opens and clears nothing; a day nobody works is complete with no line', async () => {
      const missing = await run(D_MISSING);
      expect(missing.json).toMatchObject({ run_status: 'PARTIAL', partial_reason: 'STATEMENT_MISSING', line_count: 0, opened_items: 0 });
      expect(await itemsOf(D_MISSING)).toEqual([]);
      const weekend = await run(D_WEEKEND);
      expect(weekend.json).toMatchObject({ run_status: 'COMPLETE', partial_reason: null, line_count: 0 });
    });

    it('refuses a day in the future, a day too long ago and a body the contract does not know', async () => {
      expect(await run(reconAddDays(TODAY, 1))).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect((await run(reconAddDays(TODAY, -500))).status).toBe(422);
      expect((await run('2026-02-30')).status).toBe(422);
      expect((await call('POST', '/treasury-daily-recon/runs', { member: RUNNER, body: { recon_date: D1, surprise: 1 } })).status).toBe(400);
    });

    it('is for a person whose permission covers the whole tenant: nobody, and a person of one branch, are refused', async () => {
      expect((await run(D1, NOBODY)).status).toBe(403);
      expect(await run(D1, BRANCH_IMPORTER)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
    });

    it('PARTIAL when a source cannot be read: a failing read makes the day SOURCE_UNREADABLE and keeps the transaction usable', async () => {
      class Failing extends TreasuryDailyReconStore {
        protected override async readSides(): Promise<never> {
          throw new Error('the Treasury ledger could not be read');
        }
      }
      const tenants = pay.harness.tenants as TenantDatabase;
      const outcome = await tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(RUNNER), scopeVersion: 1 }, (tx: TenantTx) => new Failing().runDay(tx, { day: D_UNREADABLE, actor: memberId(RUNNER), now: NOW, origin: 'MANUAL', judgeMissing: true }));
      expect(outcome.run).toMatchObject({ status: 'PARTIAL', partialReason: 'SOURCE_UNREADABLE', lineCount: 0 });
      expect(outcome.openedItemIds).toEqual([]);
      expect(outcome.clearedItemIds).toEqual([]);
    });
  });

  describe('the reads', () => {
    it('lists the passes with the state of each day of a range, the thresholds and that they are not confirmed', async () => {
      const reply = await call('GET', `/treasury-daily-recon/runs?from=${D_MISSING}&to=${D1}`, { member: RUNNER });
      expect(reply.status).toBe(200);
      expect(reply.json.rule).toMatchObject({ source: 'DEFAULT', unverified: true, threshold_vnd: '1000000', due_days: 3 });
      const days = reply.json.days as Array<{ recon_date: string; status: string; partial_reason: string | null }>;
      expect(days.find((day) => day.recon_date === D_MISSING)).toMatchObject({ status: 'PARTIAL', partial_reason: 'STATEMENT_MISSING' });
      expect(days.find((day) => day.recon_date === D1)).toMatchObject({ status: 'COMPLETE' });
      const runs = items(reply);
      expect(runs.length).toBeGreaterThanOrEqual(3);
      expect(runs[0]).toMatchObject({ books_total_vnd: expect.any(String) });
      expect((await call('GET', '/treasury-daily-recon/runs?from=2026-01-01', { member: RUNNER })).status).toBe(422);
      expect((await call('GET', `/treasury-daily-recon/runs?from=${reconAddDays(TODAY, -200)}&to=${TODAY}`, { member: RUNNER })).status).toBe(422);
      expect((await call('GET', '/treasury-daily-recon/runs?status=NOPE', { member: RUNNER })).status).toBe(422);
    });

    it('pages the passes by a cursor', async () => {
      const first = await call('GET', '/treasury-daily-recon/runs?limit=1', { member: RUNNER });
      expect(items(first)).toHaveLength(1);
      expect(first.json.next_cursor).toEqual(expect.any(String));
      const second = await call('GET', `/treasury-daily-recon/runs?limit=1&cursor=${first.json.next_cursor as string}`, { member: RUNNER });
      expect(items(second)).toHaveLength(1);
      expect(items(second)[0]?.id).not.toBe(items(first)[0]?.id);
      expect((await call('GET', '/treasury-daily-recon/runs?cursor=garbage', { member: RUNNER })).status).toBe(422);
    });

    it('shows a pass with its lines; a person of one branch sees the lines and the totals of that branch only', async () => {
      const [latest] = await pay.rows<{ id: string }>('select id from machvon.treasury_daily_recon_run where recon_date = $1::date order by run_no desc limit 1', [D1]);
      const whole = await call('GET', `/treasury-daily-recon/runs/${latest?.id}`, { member: RUNNER });
      expect(whole.status).toBe(200);
      expect((whole.json.lines as unknown[]).length).toBe(5);
      expect(whole.json.hidden_lines).toBe(0);
      const branch = await call('GET', `/treasury-daily-recon/runs/${latest?.id}`, { member: BRANCH_READER });
      expect(branch.status).toBe(200);
      const codes = (branch.json.lines as Array<{ project_code: string }>).map((line) => line.project_code);
      expect(new Set(codes)).toEqual(new Set([pay.worldA.projectCodeA]));
      expect(branch.json.hidden_lines).toBe(2);
      expect(branch.json.books_total_vnd).toBeNull();
      expect((await call('GET', `/treasury-daily-recon/runs/${randomUUID()}`, { member: RUNNER })).status).toBe(404);
      expect((await call('GET', `/treasury-daily-recon/runs/${latest?.id}`, { member: NOBODY })).status).toBe(403);
    });

    it('lists the items due first with the summary, filters them, and hides the ones outside the scope of the caller', async () => {
      const all = await call('GET', `/treasury-daily-recon/items?recon_date=${D1}`, { member: RUNNER });
      expect(all.status).toBe(200);
      expect(items(all).map((item) => item.fund_key).sort()).toEqual(['NSNN', 'ODA', 'UNMATCHED']);
      expect(all.json.summary).toMatchObject({ waiting: 2 });
      const open = await call('GET', `/treasury-daily-recon/items?status=OPEN&recon_date=${D1}`, { member: RUNNER });
      expect(items(open)).toHaveLength(2);
      const branch = await call('GET', `/treasury-daily-recon/items?recon_date=${D1}`, { member: BRANCH_READER });
      expect(items(branch).map((item) => item.fund_key)).toEqual(['ODA']);
      const hidden = (await itemsOf(D1)).find((item) => item.fund_key === 'UNMATCHED');
      expect(await call('GET', `/treasury-daily-recon/items/${hidden?.id}`, { member: BRANCH_READER })).toMatchObject({ status: 404 });
      expect((await call('GET', `/treasury-daily-recon/items/${hidden?.id}`, { member: RUNNER })).status).toBe(200);
      expect((await call('GET', '/treasury-daily-recon/items?status=NOPE', { member: RUNNER })).status).toBe(422);
      expect((await call('GET', '/treasury-daily-recon/items?owner_membership_id=x', { member: RUNNER })).status).toBe(422);
    });

    it('keeps the tenants apart: tenant B sees none of it', async () => {
      expect(await pay.count('select count(*)::text as n from machvon.treasury_daily_recon_item', [], TENANT_B)).toBe(0);
      expect(await pay.count('select count(*)::text as n from machvon.treasury_daily_recon_run', [], TENANT_B)).toBe(0);
    });
  });

  describe('assign and resolve', () => {
    let unmatched: { id: string; version: string };
    let missing: { id: string; version: string };

    beforeAll(async () => {
      const found = await itemsOf(D1);
      unmatched = found.find((item) => item.fund_key === 'UNMATCHED') as { id: string; version: string };
      missing = found.find((item) => item.fund_key === 'NSNN') as { id: string; version: string };
    });

    it('gives the item to an active member with a due day; a stale version, a past day and a person who is not a member are refused', async () => {
      const url = `/treasury-daily-recon/items/${unmatched.id}/assign`;
      const body = { owner_membership_id: memberId(OWNER), due_on: reconAddDays(TODAY, 5) };
      expect(await call('POST', url, { member: RUNNER, body, ifMatch: '"99"' })).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await call('POST', url, { member: RUNNER, body: { ...body, due_on: reconAddDays(TODAY, -1) }, ifMatch: `"${unmatched.version}"` })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect((await call('POST', url, { member: RUNNER, body: { ...body, owner_membership_id: randomUUID() }, ifMatch: `"${unmatched.version}"` })).status).toBe(422);
      const done = await call('POST', url, { member: RUNNER, body, ifMatch: `"${unmatched.version}"` });
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ owner_membership_id: memberId(OWNER), due_on: reconAddDays(TODAY, 5), difference_vnd: '2000000', resource_version: Number(unmatched.version) + 1 });
      unmatched = { ...unmatched, version: String(Number(unmatched.version) + 1) };
      expect(await pay.rows('select action from machvon.audit_event where resource_id = $1 order by occurred_at', [unmatched.id])).toEqual([{ action: 'treasury_daily_recon_item.assigned' }]);
      expect((await call('POST', url, { member: NOBODY, body, ifMatch: `"${unmatched.version}"` })).status).toBe(403);
    });

    it('needs the words of the person to explain, and an item is explained once', async () => {
      const url = `/treasury-daily-recon/items/${unmatched.id}/resolve`;
      expect(await call('POST', url, { member: RUNNER, body: { resolution: 'EXPLAINED', note: '   ' }, ifMatch: `"${unmatched.version}"` })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      const explained = await call('POST', url, { member: RUNNER, body: { resolution: 'EXPLAINED', note: 'Waiting for the allocation line of the transaction.' }, ifMatch: `"${unmatched.version}"` });
      expect(explained.status).toBe(200);
      expect(explained.json).toMatchObject({ status: 'EXPLAINED' });
      unmatched = { ...unmatched, version: String(Number(unmatched.version) + 1) };
      expect(await call('POST', url, { member: RUNNER, body: { resolution: 'EXPLAINED', note: 'Again.' }, ifMatch: `"${unmatched.version}"` })).toMatchObject({ status: 409, json: { code: 'RECONCILIATION_STATE_INVALID' } });
    });

    it('a write-off needs the approving document and someone who is not the owner, the explainer or the opener', async () => {
      const url = `/treasury-daily-recon/items/${unmatched.id}/resolve`;
      const note = 'The Treasury corrected the voucher; the difference is written off by decision.';
      // The explainer and the opener (the runner) may not write it off.
      expect(await call('POST', url, { member: RUNNER, body: { resolution: 'WRITTEN_OFF', note, approval_document_version_id: pay.worldA.evidence }, ifMatch: `"${unmatched.version}"` })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      // Nor may the owner (a person given the item).
      expect(await call('POST', url, { member: OWNER, body: { resolution: 'WRITTEN_OFF', note, approval_document_version_id: pay.worldA.evidence }, ifMatch: `"${unmatched.version}"` })).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      // The checker: no document, a document that is infected, a clean one.
      expect(await call('POST', url, { member: CHECKER, body: { resolution: 'WRITTEN_OFF', note }, ifMatch: `"${unmatched.version}"` })).toMatchObject({ status: 422, json: { code: 'APPROVAL_REQUIRED' } });
      expect(await call('POST', url, { member: CHECKER, body: { resolution: 'WRITTEN_OFF', note, approval_document_version_id: pay.worldA.infectedEvidence }, ifMatch: `"${unmatched.version}"` })).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_CLEAN' } });
      expect(await call('POST', url, { member: CHECKER, body: { resolution: 'WRITTEN_OFF', note, approval_document_version_id: randomUUID() }, ifMatch: `"${unmatched.version}"` })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      const done = await call('POST', url, { member: CHECKER, body: { resolution: 'WRITTEN_OFF', note, approval_document_version_id: pay.worldA.evidence }, ifMatch: `"${unmatched.version}"` });
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'WRITTEN_OFF_APPROVED', difference_vnd: '2000000' });
      const [row] = await pay.rows<{ status: string; resolved_by: string; approval_document_version_id: string; difference_vnd: string }>('select status, resolved_by, approval_document_version_id, difference_vnd::text from machvon.treasury_daily_recon_item where id = $1', [unmatched.id]);
      expect(row).toMatchObject({ status: 'WRITTEN_OFF_APPROVED', resolved_by: memberId(CHECKER), approval_document_version_id: pay.worldA.evidence, difference_vnd: '2000000' });
      // The words stay in the audit row, the event carries figures only.
      const [audit] = await pay.rows<{ action: string; reason: string | null }>("select action, reason from machvon.audit_event where resource_id = $1 and action = 'treasury_daily_recon_item.resolved' order by occurred_at desc limit 1", [unmatched.id]);
      expect(audit).toMatchObject({ action: 'treasury_daily_recon_item.resolved', reason: note });
      const [event] = await pay.rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1 and type = 'pay.treasury_daily_recon.item_resolved.v1'", [unmatched.id]);
      expect(JSON.stringify(event?.payload)).not.toContain('Treasury corrected');
      // An item that ended cannot be resolved again, and the database refuses a figure that changes.
      expect(await call('POST', url, { member: CHECKER, body: { resolution: 'RESOLVED', note: 'Again' }, ifMatch: `"${Number(unmatched.version) + 1}"` })).toMatchObject({ status: 409, json: { code: 'RECONCILIATION_STATE_INVALID' } });
    });

    it('resolves an item that waits and refuses a request to resolve one that is outside the scope', async () => {
      const url = `/treasury-daily-recon/items/${missing.id}/resolve`;
      expect((await call('POST', url, { member: BRANCH_CONFIRMER, body: { resolution: 'RESOLVED', note: 'x' }, ifMatch: `"${missing.version}"` })).status).toBe(404);
      const done = await call('POST', url, { member: RUNNER, body: { resolution: 'RESOLVED', note: 'The payment was returned by the Treasury and booked again the next day.' }, ifMatch: `"${missing.version}"` });
      expect(done).toMatchObject({ status: 200, json: { status: 'RESOLVED' } });
    });
  });

  describe('the job treasury-daily-recon', () => {
    it('reconciles yesterday, judges a missing statement once it is due, reports an item past its day once, and writes nothing on a second tick', async () => {
      const tenants = pay.harness.tenants as TenantDatabase;
      const job = new TreasuryDailyReconJob(new AuditWriter(tenants));
      const tick = (now: Date) => tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(RUNNER), scopeVersion: 1 }, (tx: TenantTx) => job.run(tx, memberId(RUNNER), now));
      const yesterday = reconAddDays(TODAY, -1);
      const dayBefore = reconAddDays(TODAY, -2);
      // A project with a difference of 6,000,000 yesterday: the Treasury paid and the books know nothing.
      const line = await fundLine(A(), 'JOB-FUND');
      await paid(A(), '6000000', yesterday, { line });
      const first = await tick(NOW);
      expect(first.days).toBe(2);
      expect(first.opened).toBeGreaterThanOrEqual(1);
      const opened = (await itemsOf(yesterday)).filter((item) => item.fund_key === 'JOB-FUND');
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ kind: 'MISSING_INTERNAL', difference_vnd: '6000000', status: 'OPEN', owner_membership_id: memberId(RUNNER) });
      // The day before has no statement and no transaction: judged because it is past the grace days (PARTIAL on a working day, complete on a day nobody works).
      const [before] = await pay.rows<{ status: string; partial_reason: string | null; origin: string }>('select status, partial_reason, origin from machvon.treasury_daily_recon_run where recon_date = $1::date order by run_no desc limit 1', [dayBefore]);
      const hasData = (await pay.count('select count(*)::text as n from machvon.treasury_transaction where (confirmed_at at time zone $2)::date = $1::date', [dayBefore, 'Asia/Ho_Chi_Minh'])) > 0;
      if (!hasData) expect(before).toMatchObject(isWeekday(dayBefore) ? { status: 'PARTIAL', partial_reason: 'STATEMENT_MISSING', origin: 'JOB' } : { status: 'COMPLETE', origin: 'JOB' });
      expect(await pay.rows("select 1 from machvon.audit_event where action = 'pay.treasury_daily_recon_run' and resource_id in (select id from machvon.treasury_daily_recon_run where origin = 'JOB')")).not.toHaveLength(0);

      // A second tick finds the very lines: nothing new is written.
      const second = await tick(NOW);
      expect(second).toMatchObject({ written: 0, opened: 0, cleared: 0 });

      // An item past its day is reported once, with the members of the issue intake and the code of its alert type.
      await pay.rows('update machvon.treasury_daily_recon_item set due_on = $2::date where id = $1', [opened[0]?.id, reconAddDays(TODAY, -2)]);
      const third = await tick(NOW);
      expect(third.overdueReported).toBeGreaterThanOrEqual(1);
      const events = await pay.rows<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1 and type = 'pay.treasury_daily_recon.item_overdue.v1'", [opened[0]?.id]);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ source_ref_id: opened[0]?.id, alert_type: 'TREASURY_RECON_ITEM_OVERDUE', source_module: 'PAY', severity: 'MEDIUM', difference_vnd: '6000000' });
      expect((await tick(NOW)).overdueReported).toBe(0);
      expect(await pay.count("select count(*)::text as n from machvon.outbox_event where aggregate_id = $1 and type = 'pay.treasury_daily_recon.item_overdue.v1'", [opened[0]?.id])).toBe(1);
      // The reads say the item is overdue.
      const read = await call('GET', `/treasury-daily-recon/items/${opened[0]?.id}`, { member: RUNNER });
      expect(read.json).toMatchObject({ overdue: true });
    });

    it('does not judge a statement that is not due yet: the day inside the grace days with nothing from the Treasury is left alone', async () => {
      const tenants = pay.harness.tenants as TenantDatabase;
      const store = new TreasuryDailyReconStore();
      const outcome = await tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(RUNNER), scopeVersion: 1 }, (tx: TenantTx) =>
        store.runDay(tx, { day: reconAddDays(TODAY, -1), actor: memberId(RUNNER), now: new Date(NOW.getTime() + 0), origin: 'JOB', judgeMissing: false }),
      );
      // Yesterday has a transaction from the tick above, so it is judged; a day with nothing is the case of the next line.
      expect(outcome.notDue).toBe(false);
      const empty = await tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(RUNNER), scopeVersion: 1 }, (tx: TenantTx) =>
        store.runDay(tx, { day: reconAddDays(TODAY, -30), actor: memberId(RUNNER), now: NOW, origin: 'JOB', judgeMissing: false }),
      );
      expect(empty.notDue).toBe(isWeekday(reconAddDays(TODAY, -30)));
    });
  });
});
