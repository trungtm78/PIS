import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { capModule } from '../../src/modules/cap';
import { CapitalLedgerController } from '../../src/modules/cap/ledger.controller';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(180_000);

const SIGNING_KEY = randomBytes(32);
const AUDITOR = 1; // capital.ledger.read on the whole tenant
const SCOPED_AUDITOR = 2; // capital.ledger.read on the department only
const NOTHING = 3; // no right over the ledger
const B_AUDITOR = 21; // of tenant B
const ROOT = 1;
const DEPARTMENT = 2;
const ELSEWHERE = 3;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Entry {
  id: string;
  entry_type: string;
  amount_vnd: string;
  allocation_line_id: string | null;
  project: { id: string; code: string; name: string } | null;
  reversal_of_id: string | null;
  posted_at: string;
  posted_by: { membership_id: string; display_name: string | null };
}

const id = (n: number): string => `00000000-0000-4000-8000-${(0x7b0000000000 + n).toString(16).padStart(12, '0')}`;
const APPROPRIATION = id(1);
const PROJECT_HERE = id(2);
const PROJECT_THERE = id(3);
const LINE_HERE = id(4);
const LINE_THERE = id(5);
const AREA = id(6);
const RESERVATION = id(7);
const at = (minute: number): string => `2026-06-01T08:${String(minute).padStart(2, '0')}:00.000Z`;

describe('the capital ledger (ST-CAP-014, CAP 3.4, CAP-21)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function get(url: string, options: { member: number; tenantId?: string }): Promise<Reply> {
    const response = await fetch(`${app.baseUrl}${url}`, { headers: { [TENANT_HEADER]: tokenOf(options.member, options.tenantId) } });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  async function seed(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  const items = (reply: Reply): Entry[] => reply.json.items as Entry[];
  const balance = (reply: Reply): Record<string, string> => reply.json.balance as Record<string, string>;

  const entry = (tenant: string, type: string, amount: string, minute: number, options: { project?: string | null; line?: string | null; reversalOf?: string; entryId?: string; reason?: string } = {}): [string, unknown[]] => {
    const project = options.project === undefined ? PROJECT_HERE : options.project;
    const line = options.line === undefined ? (project === null ? null : project === PROJECT_HERE ? LINE_HERE : LINE_THERE) : options.line;
    return [
      `insert into machvon.capital_ledger_entry (tenant_id, id, appropriation_id, allocation_line_id, project_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, reversal_of_id, reason, posted_at, posted_by)
       values ($1, $2, $3, $4, $5, $6, $7, 2026, 'CAPITAL_PLAN', $8, $9, $10, $11::timestamptz, $12)`,
      [tenant, options.entryId ?? randomUUID(), APPROPRIATION, line, project, type, amount, randomUUID(), options.reversalOf ?? null, options.reason ?? null, at(minute), memberId(1)],
    ];
  };
  const DISBURSE_ID = randomUUID();

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ELSEWHERE)}/` },
      ]);
    }
    for (const n of [AUDITOR, SCOPED_AUDITOR, NOTHING]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_AUDITOR, ROOT);
    await harness.seedRole(TENANT_A, 1, 'LEDGER_AUDITOR', ['capital.ledger.read'], 30);
    await harness.seedRole(TENANT_B, 1, 'LEDGER_AUDITOR', ['capital.ledger.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: AUDITOR, role: 1, kind: 'TENANT' },
      { n: 2, member: SCOPED_AUDITOR, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(DEPARTMENT)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_AUDITOR, role: 1, kind: 'TENANT' }]);
    const project = (projectId: string, code: string, unit: number): [string, unknown[]] => [
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
      [TENANT_A, projectId, code, unitId(unit), AREA],
    ];
    await seed([
      project(PROJECT_HERE, 'LG-HERE', DEPARTMENT),
      project(PROJECT_THERE, 'LG-THERE', ELSEWHERE),
      entry(TENANT_A, 'APPROPRIATE', '100000000000', 0, { project: null, line: null }),
      entry(TENANT_A, 'ALLOCATE', '40000000000', 1),
      entry(TENANT_A, 'RESERVE', '5000000000', 2),
      entry(TENANT_A, 'RELEASE', '5000000000', 5, { reason: `reservation ${RESERVATION} expired` }),
      entry(TENANT_A, 'COMMIT', '30000000000', 6),
      entry(TENANT_A, 'DISBURSE', '12000000000', 7, { entryId: DISBURSE_ID }),
      entry(TENANT_A, 'REVERSAL', '2000000000', 8, { reversalOf: DISBURSE_ID, reason: 'A payment was reversed' }),
      entry(TENANT_A, 'ALLOCATE', '10000000000', 3, { project: PROJECT_THERE }),
      [
        `insert into machvon.capital_ledger_entry (tenant_id, id, appropriation_id, entry_type, amount_vnd, plan_year, source_ref_kind, source_ref_id, posted_by) values ($1, $2, $3, 'APPROPRIATE', 777, 2026, 'APPROPRIATION', $4, $5)`,
        [TENANT_B, randomUUID(), randomUUID(), randomUUID(), memberId(21)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [CapitalLedgerController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the module of CAP', () => {
    expect(capModule.controllers).toEqual(expect.arrayContaining([CapitalLedgerController]));
  });

  it('UAT-AC227: filtered by the line, one RELEASE entry appears and the balance at the chosen moment equals the sum of the entries', async () => {
    const reply = await get(`/capital-ledger?allocation_line_id=${LINE_HERE}`, { member: AUDITOR });
    expect(reply.status).toBe(200);
    const lines = items(reply);
    expect(lines.filter((line) => line.entry_type === 'RELEASE')).toHaveLength(1);
    expect(lines.map((line) => line.entry_type)).toEqual(['REVERSAL', 'DISBURSE', 'COMMIT', 'RELEASE', 'RESERVE', 'ALLOCATE']);
    expect(balance(reply)).toEqual({ appropriated_vnd: '0', allocated_vnd: '40000000000', reserved_vnd: '0', committed_vnd: '30000000000', disbursed_vnd: '10000000000' });
    expect(reply.json.entry_count).toBe(6);
    // The balance is the sum of the entries, entry by entry.
    const signed: Record<string, number> = { ALLOCATE: 1, RESERVE: 1, RELEASE: -1, COMMIT: 1, DISBURSE: 1, REVERSAL: -1 };
    const column: Record<string, string> = { ALLOCATE: 'allocated_vnd', RESERVE: 'reserved_vnd', RELEASE: 'reserved_vnd', COMMIT: 'committed_vnd', DISBURSE: 'disbursed_vnd', REVERSAL: 'disbursed_vnd' };
    const sum: Record<string, number> = { allocated_vnd: 0, reserved_vnd: 0, committed_vnd: 0, disbursed_vnd: 0 };
    for (const line of lines) sum[column[line.entry_type] as string] = (sum[column[line.entry_type] as string] ?? 0) + (signed[line.entry_type] as number) * Number(line.amount_vnd);
    expect(Object.fromEntries(Object.entries(sum).map(([key, value]) => [key, String(value)]))).toEqual({ allocated_vnd: '40000000000', reserved_vnd: '0', committed_vnd: '30000000000', disbursed_vnd: '10000000000' });
    // Between the reservation and its release the five billion are reserved.
    const midway = await get(`/capital-ledger?allocation_line_id=${LINE_HERE}&at=${encodeURIComponent(at(3))}`, { member: AUDITOR });
    expect(balance(midway)).toEqual({ appropriated_vnd: '0', allocated_vnd: '40000000000', reserved_vnd: '5000000000', committed_vnd: '0', disbursed_vnd: '0' });
    expect(items(midway).map((line) => line.entry_type)).toEqual(['RESERVE', 'ALLOCATE']);
    expect(midway.json).toMatchObject({ entry_count: 2, as_of: at(3).replace('.000Z', '.000000Z') });
  });

  it('reads the entries newest first with the project, the reason and who posted them, and the reversal names the entry it undoes', async () => {
    const reply = await get('/capital-ledger?project_id=' + PROJECT_HERE, { member: AUDITOR });
    const lines = items(reply);
    expect(lines.map((line) => line.posted_at)).toEqual([...lines.map((line) => line.posted_at)].sort().reverse());
    expect(lines[0]).toMatchObject({ entry_type: 'REVERSAL', amount_vnd: '2000000000', reversal_of_id: DISBURSE_ID, project: { id: PROJECT_HERE, code: 'LG-HERE', name: 'LG-HERE' }, posted_by: { membership_id: memberId(1), display_name: expect.any(String) } });
    expect(lines.find((line) => line.entry_type === 'RELEASE')).toMatchObject({ reason: `reservation ${RESERVATION} expired`, allocation_line_id: LINE_HERE });
  });

  it('takes a day for the moment (up to the end of it in Vietnam) and an instant with its zone; the whole ledger without one', async () => {
    const whole = await get('/capital-ledger?limit=200', { member: AUDITOR });
    expect(whole.json.entry_count).toBe(8);
    expect(balance(whole)).toEqual({ appropriated_vnd: '100000000000', allocated_vnd: '50000000000', reserved_vnd: '0', committed_vnd: '30000000000', disbursed_vnd: '10000000000' });
    // 2026-06-01T08:xx UTC is the afternoon of the first of June in Vietnam; the day before ends before it.
    const day = await get('/capital-ledger?at=2026-06-01', { member: AUDITOR });
    expect(day.json.entry_count).toBe(8);
    // The moment the balance is for keeps the microsecond the database cut at, so asking for it again gives the same balance.
    expect(day.json.as_of).toBe('2026-06-01T16:59:59.999999Z');
    expect(balance(await get(`/capital-ledger?at=${encodeURIComponent(day.json.as_of as string)}`, { member: AUDITOR }))).toEqual(balance(day));
    expect((await get('/capital-ledger?at=2026-05-31', { member: AUDITOR })).json.entry_count).toBe(0);
    expect((await get('/capital-ledger?at=2026-06-01T15:00:00%2B07:00', { member: AUDITOR })).json.entry_count).toBe(1);
    expect((await get(`/capital-ledger?at=${encodeURIComponent('2026-06-01T08:00:00.000Z')}`, { member: AUDITOR })).json.entry_count).toBe(1);
  });

  it('cuts pages with a cursor that gives each entry once, whatever the page size, and keeps the balance whole', async () => {
    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 10; page += 1) {
      const reply = await get(`/capital-ledger?limit=3${cursor === '' ? '' : `&cursor=${cursor}`}`, { member: AUDITOR });
      expect(reply.json.entry_count).toBe(8);
      seen.push(...items(reply).map((line) => line.id));
      if (reply.json.next_cursor === null) break;
      cursor = encodeURIComponent(reply.json.next_cursor as string);
    }
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
  });

  it('AC-ST-CAP-014-2, UI-CAP-21: an auditor with a limited scope reads only the entries of the projects in it, and the balance follows; the entries of no project need the whole tenant', async () => {
    const scoped = await get('/capital-ledger?limit=200', { member: SCOPED_AUDITOR });
    expect(scoped.status).toBe(200);
    expect(items(scoped).every((line) => line.project?.id === PROJECT_HERE)).toBe(true);
    expect(items(scoped)).toHaveLength(6);
    expect(scoped.json.entry_count).toBe(6);
    expect(balance(scoped)).toEqual({ appropriated_vnd: '0', allocated_vnd: '40000000000', reserved_vnd: '0', committed_vnd: '30000000000', disbursed_vnd: '10000000000' });
    const foreign = await get(`/capital-ledger?project_id=${PROJECT_THERE}`, { member: SCOPED_AUDITOR });
    expect(items(foreign)).toEqual([]);
    expect(foreign.json.entry_count).toBe(0);
    const everything = await get('/capital-ledger?project_id=' + PROJECT_THERE, { member: AUDITOR });
    expect(items(everything)).toHaveLength(1);
  });

  it('shows nothing of another tenant and is refused to a caller with no right over the ledger', async () => {
    const other = await get('/capital-ledger', { member: B_AUDITOR, tenantId: TENANT_B });
    expect(other.json.entry_count).toBe(1);
    expect(balance(other).appropriated_vnd).toBe('777');
    expect(items(other).every((line) => line.amount_vnd === '777')).toBe(true);
    const denied = await get('/capital-ledger', { member: NOTHING });
    expect(denied.status).toBe(403);
  });

  it('refuses what is not a filter: an id, a moment, a page size or a cursor that is not one (422)', async () => {
    for (const query of ['project_id=x', 'allocation_line_id=1', 'appropriation_id=%20', 'at=yesterday', 'at=2026-02-30', 'at=2026-06-01T08:00:00', 'at=2026-02-30T08:00:00Z', 'limit=0', 'cursor=!!!', `cursor=${Buffer.from(JSON.stringify(['not a time', randomUUID()])).toString('base64url')}`, `cursor=${Buffer.from(JSON.stringify(['2026-02-30T08:00:00.000000Z', randomUUID()])).toString('base64url')}`]) {
      const reply = await get(`/capital-ledger?${query}`, { member: AUDITOR });
      expect([query, reply.status, reply.json.code]).toEqual([query, 422, 'VALIDATION_FAILED']);
    }
  });

  it('offers no way to write: the ledger answers no command', async () => {
    const response = await fetch(`${app.baseUrl}/capital-ledger`, { method: 'POST', headers: { [TENANT_HEADER]: tokenOf(AUDITOR), 'content-type': 'application/json', 'idempotency-key': `key-${randomUUID()}` }, body: '{}' });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
