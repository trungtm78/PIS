import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { PayClaimStore, PayPaymentStore, PaySettlementStore } from '@machvon/db';
import type { ContractScopes, TenantTx } from '@machvon/db';
import { TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { AcceptanceWorld } from '../../../../packages/db/test/support/acceptance-fixtures';
import type { ApprovedAcceptance } from '../../../../packages/db/test/support/acceptance-fixtures';
import { expectCheckFails } from '../uat/uat-kit';

jest.setTimeout(900_000);

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const MAKER = 1;
const SENDER = 2;
const CHECKER = 3;
const MATCHER = 4;
const TODAY = '2026-07-25';
const NOW = new Date('2026-07-25T05:00:00Z');
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };

interface DatabaseRefusal {
  sqlstate: string;
  constraint: string;
  message: string;
}

/** What the database said to a statement it refused: the SQLSTATE and the constraint it names. */
async function databaseRefusal(work: Promise<unknown>): Promise<DatabaseRefusal> {
  try {
    await work;
  } catch (error) {
    const e = error as { message: string; code?: string; constraint?: string };
    return { sqlstate: e.code ?? '', constraint: e.constraint ?? '', message: e.message };
  }
  throw new Error('expected the database to refuse');
}

/** The check of a refusal: SQLSTATE and constraint, the way the case words them. Throws on a refusal that is anything else. */
function assertRefusedBy(refusal: DatabaseRefusal, sqlstate: string, constraint: string | RegExp): void {
  if (refusal.sqlstate !== sqlstate) throw new Error(`expected SQLSTATE ${sqlstate}, got ${refusal.sqlstate}: ${refusal.message}`);
  const named = typeof constraint === 'string' ? refusal.constraint === constraint : constraint.test(refusal.constraint);
  if (!named) throw new Error(`expected the constraint ${String(constraint)}, got "${refusal.constraint}": ${refusal.message}`);
}

/** The tables of the execution modules of the baseline schema and of the migrations of CTR, PAY, QMS, ISS, LND and PMT. */
function executionTables(): string[] {
  const created = (sql: string): string[] => [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(?:machvon\.)?(\w+)/gi)].map((match) => match[1] as string);
  const directory = join(REPO_ROOT, 'db', 'migrations');
  const added = readdirSync(directory)
    .filter((name) => /__(?:ctr|pay|qms|iss|lnd|pmt)\d+_/.test(name))
    .flatMap((name) => created(readFileSync(join(directory, name), 'utf8')));
  const baseline = created(readFileSync(join(directory, 'V002__schema.sql'), 'utf8')).filter((name) =>
    /^(contract|issue|payment|treasury|boq|measurement|acceptance|quality|inspection|ncr|punch|land|household|parcel|compensation|permit|retention|guarantee|advance|cumulative|settlement|disbursement)/.test(name),
  );
  return [...new Set([...baseline, ...added])].sort();
}

/** The tables of land clearance that hold the personal data of households: the guard of the units of the reader stands on each (V002). */
const PERSONAL_LAND_TABLES = ['affected_household', 'household_parcel', 'land_inventory_record', 'compensation_plan_item', 'compensation_payment', 'land_complaint', 'land_enforcement_case', 'resettlement_allocation'];

describe('the rules the ledger of PAY holds in the database, behind the checks of the application', () => {
  const fixtures = new AcceptanceWorld();
  const harness = fixtures.harness;
  const payments = new PayPaymentStore();
  const claims = new PayClaimStore();
  const treasury = new PaySettlementStore();
  let counter = 0;

  const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER): Promise<T> => fixtures.as(work, member);
  const owner = fixtures.owner.bind(fixtures);

  /** A session of the application role (machvon_app, no superuser, no BYPASSRLS), the tenant set unless `tenantId` is null. */
  async function appSession(tenantId: string | null = TENANT_A): Promise<Client> {
    const client = new Client({ connectionString: harness.database.urlFor('machvon_app') });
    await client.connect();
    if (tenantId !== null) await client.query("select set_config('app.tenant_id', $1, false)", [tenantId]);
    return client;
  }

  /** One statement as the application role, in a session of its own so that the refusal does not leave a transaction aborted. */
  async function asApp(sql: string, params: unknown[] = [], tenantId: string | null = TENANT_A): Promise<unknown> {
    const client = await appSession(tenantId);
    try {
      return await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** Runs a statement as the superuser with the triggers off, to write rows of a table only another module writes. */
  async function admin(sql: string, params: unknown[] = []): Promise<void> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** A draft of a request for an approved acceptance with the invoice attached, ready to send. */
  async function draftFor(approved: ApprovedAcceptance): Promise<{ id: string; version: number; gross: string; net: string }> {
    counter += 1;
    const made = await as((tx) =>
      payments.create(tx, { contractId: approved.contract.contractId, requestKind: 'INTERIM', acceptanceId: approved.acceptance.id, allocationLineId: fixtures.lineId, requestNo: `DNTT-L-${counter}-${randomUUID().slice(0, 6)}` }, memberId(MAKER), everything, TODAY),
    );
    const document = await fixtures.documentVersion();
    await as((tx) => payments.attachDocument(tx, made.id, { documentVersionId: document.id, docKind: 'INVOICE', invoiceNo: `HD-L-${counter}-${randomUUID().slice(0, 6)}`, invoiceDate: '2026-07-01' }, memberId(MAKER), everything, { mayOverride: () => false }));
    return { id: made.id, version: made.version, gross: made.grossVnd, net: made.netVnd };
  }

  const send = (draft: { id: string; version: number; gross: string; net: string }) =>
    as((tx) => claims.submit(tx, draft.id, draft.version, { expectedGrossVnd: draft.gross, expectedNetVnd: draft.net, requestId: randomUUID() }, memberId(SENDER), everything, TODAY), SENDER);

  /** The request sent, checked, with the Treasury and settled by a transaction of the net amount. */
  async function settle(draft: { id: string; version: number; gross: string; net: string }): Promise<void> {
    const sent = await send(draft);
    await as((tx) => claims.verify(tx, draft.id, sent.version, undefined, memberId(CHECKER), everything), CHECKER);
    await fixtures.sendToTreasury(draft.id);
    const transactionId = randomUUID();
    counter += 1;
    await owner(
      `insert into machvon.treasury_transaction
         (tenant_id, id, project_id, external_id, provider, amount_vnd, confirmed_at, source_hash, row_hash, direction, document_no, document_date, source_kind, provider_event_id, match_status)
       values ($1, $2::uuid, $3::uuid, $4, 'MOCKKB', $5::numeric, timestamptz '2026-07-24T18:30:00Z', repeat('a', 64), repeat('a', 64), 'PAYMENT', $4, date '2026-07-24', 'CALLBACK_MOCK', $6, 'UNMATCHED')`,
      [TENANT_A, transactionId, fixtures.projectId, `CT-L-${counter}`, draft.net, `EVT-L-${counter}`],
    );
    const done = await as((tx) => treasury.match(tx, { transactionId, paymentRequestId: draft.id, actor: memberId(MATCHER), requestId: randomUUID(), scopes: everything, now: NOW }), MATCHER);
    if (done.kind !== 'SETTLED') throw new Error('the fixture payment was not settled');
  }

  /** The rows a table holds, counted as the superuser, who is not held back by row-level security. */
  async function rowsOf(table: string): Promise<number> {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return Number((await client.query<{ n: string }>(`select count(*) as n from machvon.${table}`)).rows[0]?.n);
    } finally {
      await client.end();
    }
  }

  const contractFigures = async (contractId: string) =>
    (
      await owner<{ value: string; accepted: string; requested: string; paid: string }>(
        'select contract_value_vnd::text as value, accepted_total_vnd::text as accepted, requested_total_vnd::text as requested, paid_total_vnd::text as paid from machvon.contract where id = $1::uuid',
        [contractId],
      )
    )[0];
  const balances = (contractId: string) =>
    owner<{ item: string; accepted: string; requested: string; paid: string }>(
      'select i.business_key as item, l.accepted_vnd::text as accepted, l.requested_vnd::text as requested, l.paid_vnd::text as paid from machvon.cumulative_ledger l join machvon.boq_item i on i.id = l.boq_item_id where l.contract_id = $1::uuid order by i.business_key, l.acceptance_id',
      [contractId],
    );
  const entryCount = async (contractId: string): Promise<number> => (await owner('select 1 from machvon.cumulative_ledger_entry where contract_id = $1::uuid', [contractId])).length;
  const requestCount = async (contractId: string): Promise<number> => (await owner('select 1 from machvon.payment_request where contract_id = $1::uuid', [contractId])).length;

  beforeAll(async () => {
    await fixtures.start();
    await harness.seedMembership(TENANT_A, MATCHER, 1);
  }, 600_000);

  afterAll(async () => {
    await fixtures.stop();
  }, 120_000);

  it('UAT-AC321: the database refuses a second claim on an acceptance, a balance above what was accepted, a contract out of order, a changed or deleted entry and a claim flag that lies', async () => {
    const contract = await fixtures.seedContract();
    await owner('update machvon.contract_party set work_value_vnd = 10000000000 where contract_id = $1::uuid', [contract.contractId]);
    const approved = await fixtures.approve(contract, [
      { item: 0, quantity: '2000' },
      { item: 1, quantity: '500' },
    ]);
    const draft = await draftFor(approved);
    await send(draft);
    const sentRow = (await owner<{ status: string; claims_acceptance: boolean }>('select status, claims_acceptance from machvon.payment_request where id = $1::uuid', [draft.id]))[0];
    expect(sentRow).toEqual({ status: 'SUBMITTED', claims_acceptance: true });
    const [first] = await balances(contract.contractId);
    expect(first).toEqual({ item: 'B01', accepted: '2000000000', requested: '2000000000', paid: '0' });
    const figures = await contractFigures(contract.contractId);
    expect(figures).toMatchObject({ accepted: '3000000000', requested: '3000000000' });
    const ledgerId = (await owner<{ id: string }>('select l.id from machvon.cumulative_ledger l join machvon.boq_item i on i.id = l.boq_item_id where l.contract_id = $1::uuid and i.business_key = $2', [contract.contractId, 'B01']))[0]?.id;
    const entryId = (await owner<{ id: string }>('select id from machvon.cumulative_ledger_entry where contract_id = $1::uuid order by posted_at, id limit 1', [contract.contractId]))[0]?.id;
    const entriesBefore = await entryCount(contract.contractId);
    expect(entriesBefore).toBeGreaterThan(0);
    const requestsBefore = await requestCount(contract.contractId);
    const stateBefore = { balances: await balances(contract.contractId), figures: await contractFigures(contract.contractId) };

    // A copy of the request that holds the claim, under a number of its own, with the flag given.
    const copyOfRequest = (claims_acceptance: boolean) =>
      asApp(
        `insert into machvon.payment_request
         select (jsonb_populate_record(null::machvon.payment_request, to_jsonb(p) || jsonb_build_object('id', gen_random_uuid()::text, 'request_no', $2::text, 'claims_acceptance', $3::boolean))).*
           from machvon.payment_request p where p.id = $1::uuid`,
        [draft.id, `DNTT-DUP-${randomUUID().slice(0, 6)}`, claims_acceptance],
      );

    // Step 1: a second request that claims the same acceptance is refused by the unique index.
    assertRefusedBy(await databaseRefusal(copyOfRequest(true)), '23505', 'payment_request_active_acceptance_uq');
    // Step 2: a balance that has been asked for more than was accepted.
    assertRefusedBy(await databaseRefusal(asApp('update machvon.cumulative_ledger set requested_vnd = 2000000001 where id = $1::uuid', [ledgerId])), '23514', 'cumulative_ledger_requested_le_accepted_chk');
    // Step 3: a contract that has been asked for more than it accepted.
    assertRefusedBy(await databaseRefusal(asApp('update machvon.contract set requested_total_vnd = 3000000001 where id = $1::uuid', [contract.contractId])), '23514', 'contract_ledger_order_chk');
    // Step 4: the application role holds no right to delete or change an entry of the ledger.
    assertRefusedBy(await databaseRefusal(asApp('delete from machvon.cumulative_ledger_entry where id = $1::uuid', [entryId])), '42501', '');
    assertRefusedBy(await databaseRefusal(asApp('update machvon.cumulative_ledger_entry set requested_delta_vnd = 0 where id = $1::uuid', [entryId])), '42501', '');
    expect((await databaseRefusal(asApp('delete from machvon.cumulative_ledger_entry'))).message).toContain('permission denied');
    // Step 5: a request that is sent and says it does not claim the acceptance is refused by the check of the flag.
    assertRefusedBy(await databaseRefusal(copyOfRequest(false)), '23514', 'payment_request_claim_chk');

    // Not one row changed.
    expect({ balances: await balances(contract.contractId), figures: await contractFigures(contract.contractId) }).toEqual(stateBefore);
    expect(await entryCount(contract.contractId)).toBe(entriesBefore);
    expect(await requestCount(contract.contractId)).toBe(requestsBefore);
  });

  it('UAT-AC330: a payment that takes the paid total to the value of the contract is settled, the next one is 409 VALUE_EXCEEDED, and the value cannot go below what was paid', async () => {
    const contract = await fixtures.seedContract();
    // Three acceptances of an estimate-based contract: NT-A-009a (400m) and NT-A-009b (100m) go to payment, NT-A-009c (100,000,001) is the one the contract cannot take.
    const settledEarlier = await fixtures.approve(contract, [{ item: 0, quantity: '400' }]);
    const last = await fixtures.approve(contract, [{ item: 0, quantity: '100' }]);
    const over = await fixtures.approve(contract, [{ item: 0, quantity: '100.000001' }]);
    expect(over.amounts.get(contract.items[0])).toBe('100000001');
    // The contract is worth 500m, which is all it accepted; the fixture hands over the value and the accepted total in one statement, as an approved estimate would.
    await owner('update machvon.contract set contract_value_vnd = 500000000, accepted_total_vnd = 500000000 where id = $1::uuid', [contract.contractId]);
    await owner('update machvon.contract_party set work_value_vnd = 500000000 where contract_id = $1::uuid', [contract.contractId]);

    await settle(await draftFor(settledEarlier));
    expect(await contractFigures(contract.contractId)).toMatchObject({ value: '500000000', accepted: '500000000', requested: '400000000', paid: '400000000' });
    // Step 1: PR-A-009b, 100m, settled: the paid total is the value of the contract.
    await settle(await draftFor(last));
    expect(await contractFigures(contract.contractId)).toEqual({ value: '500000000', accepted: '500000000', requested: '500000000', paid: '500000000' });

    // Step 2: PR-A-009c, 100,000,001, is refused and the ledger stays as it was.
    const refused = await draftFor(over);
    const before = { balances: await balances(contract.contractId), figures: await contractFigures(contract.contractId), entries: await entryCount(contract.contractId) };
    const outcome = await send(refused).then(
      () => undefined,
      (error: unknown) => error as { code?: string; status?: number },
    );
    expect(outcome).toMatchObject({ code: 'VALUE_EXCEEDED', status: 409 });
    expect({ balances: await balances(contract.contractId), figures: await contractFigures(contract.contractId), entries: await entryCount(contract.contractId) }).toEqual(before);
    expect((await owner<{ status: string; claims_acceptance: boolean }>('select status, claims_acceptance from machvon.payment_request where id = $1::uuid', [refused.id]))[0]).toEqual({ status: 'DRAFT', claims_acceptance: false });

    // Step 3: the value cannot go below what the contract accepted and paid, whichever check meets it first.
    const lowered = await databaseRefusal(asApp('update machvon.contract set contract_value_vnd = 499999999 where id = $1::uuid', [contract.contractId]));
    assertRefusedBy(lowered, '23514', /^contract_(ledger_order|cash_out)_chk$/);
    // Step 4: the paid total is still 500m.
    expect((await contractFigures(contract.contractId))?.paid).toBe('500000000');
  });

  it('UAT-AC396: every table of the execution modules has forced row-level security with its two policies, and the application role sees nothing without a tenant and no household without a unit', async () => {
    // The tables the baseline names by prefix, those the migrations of the modules add, and the tables of personal data of land clearance, which carry no such prefix.
    const names = [...new Set([...executionTables(), ...PERSONAL_LAND_TABLES])].sort();
    expect(names.length).toBeGreaterThanOrEqual(67);
    // A row of each of the five tables the case reads, of tenant A and of tenant B, and a household of a unit of tenant A.
    const contract = await fixtures.seedContract();
    await owner('update machvon.contract_party set work_value_vnd = 10000000000 where contract_id = $1::uuid', [contract.contractId]);
    const approved = await fixtures.approve(contract, [{ item: 0, quantity: '100' }]);
    await send(await draftFor(approved));
    const issueRow = (tenant: string, project: string): [string, unknown[]] => [
      `insert into machvon.issue
         (tenant_id, id, project_id, category_version_id, severity, assignee_id, due_at, status, version, code, title, description, source_module, reported_by, opened_at, owner_unit_id, sla_policy_id, response_due_at)
       values ($1, gen_random_uuid(), $2, gen_random_uuid(), 'MEDIUM', $3, now() + interval '7 days', 'OPEN', 1, $4, 'An issue', 'It is an issue', 'MANUAL', $3, now(), $5, gen_random_uuid(), now() + interval '1 day')`,
      [tenant, project, memberId(MAKER), `VM-2026-${String(900000 + (counter += 1))}`, unitId(1)],
    ];
    await admin(...issueRow(TENANT_A, fixtures.projectId));
    await admin(
      `insert into machvon.affected_household (tenant_id, id, project_id, owner_unit_id, household_code, head_name, head_name_enc, legal_basis, legal_basis_ref, retention_until, created_by, updated_by)
       values ($1, gen_random_uuid(), $2, $3, 'HH-L-001', 'N.V.A', '\\x01', 'PUBLIC_TASK_LAND_LAW', 'Luat Dat dai', date '2099-01-01', $4, $4)`,
      [TENANT_A, fixtures.projectId, unitId(1), memberId(MAKER)],
    );

    const catalog = await appSession(null);
    try {
      // Step 1: no execution table is without forced row-level security.
      const unforced = await catalog.query<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'machvon' and c.relname = any($1::text[]) and not (c.relrowsecurity and c.relforcerowsecurity)`,
        [names],
      );
      expect(unforced.rows).toEqual([]);
      const present = await catalog.query<{ relname: string }>(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'machvon' and c.relname = any($1::text[])`, [names]);
      expect(present.rows).toHaveLength(names.length);
      // Step 2: each table has the restrictive policy of the tenant and the permissive one, and the tables of personal data of land clearance have the guard of the units besides.
      const policies = await catalog.query<{ tablename: string; policyname: string; permissive: string }>(
        `select tablename, policyname, permissive from pg_policies where schemaname = 'machvon' and tablename = any($1::text[]) order by tablename, policyname`,
        [names],
      );
      for (const name of names) {
        const own = policies.rows.filter((row) => row.tablename === name);
        expect({ name, boundary: own.filter((row) => row.policyname === 'tenant_boundary').map((row) => row.permissive) }).toEqual({ name, boundary: ['RESTRICTIVE'] });
        expect({ name, access: own.filter((row) => row.policyname === 'tenant_access').map((row) => row.permissive) }).toEqual({ name, access: ['PERMISSIVE'] });
      }
      for (const name of PERSONAL_LAND_TABLES) {
        expect({ name, guard: policies.rows.filter((row) => row.tablename === name && row.policyname === 'scope_units_guard').map((row) => row.permissive) }).toEqual({ name, guard: ['RESTRICTIVE'] });
      }
    } finally {
      await catalog.end();
    }

    // Step 3: the application role without a tenant counts nothing in the five tables, though each holds rows of tenant A.
    const sample = ['contract', 'payment_request', 'cumulative_ledger', 'affected_household', 'issue'];
    const noTenant = await appSession(null);
    const withTenant = await appSession(TENANT_A);
    const otherTenant = await appSession(TENANT_B);
    try {
      for (const table of sample) {
        const count = async (client: Client): Promise<number> => Number((await client.query<{ n: string }>(`select count(*) as n from machvon.${table}`)).rows[0]?.n);
        expect({ table, rows: await count(noTenant) }).toEqual({ table, rows: 0 });
        expect(await rowsOf(table)).toBeGreaterThan(0);
        // The tenant that owns the rows sees them (the household needs a unit, below), another tenant sees none of them.
        if (table !== 'affected_household') expect(await count(withTenant)).toBeGreaterThan(0);
        expect({ table, rows: await count(otherTenant) }).toEqual({ table, rows: 0 });
      }
      // Step 4: with the tenant set and no unit in scope the households are not seen (fail-closed); with the unit they are.
      expect(Number((await withTenant.query<{ n: string }>('select count(*) as n from machvon.affected_household')).rows[0]?.n)).toBe(0);
      await withTenant.query("select set_config('app.scope_units', $1, false)", [unitId(1)]);
      expect(Number((await withTenant.query<{ n: string }>('select count(*) as n from machvon.affected_household')).rows[0]?.n)).toBe(1);
      await otherTenant.query("select set_config('app.scope_units', '*', false)");
      expect(Number((await otherTenant.query<{ n: string }>('select count(*) as n from machvon.affected_household')).rows[0]?.n)).toBe(0);
    } finally {
      await noTenant.end();
      await withTenant.end();
      await otherTenant.end();
    }
  });

  it('a check of this suite goes red when it is fed a wrong answer (negative control)', () => {
    const refusal: DatabaseRefusal = { sqlstate: '23514', constraint: 'contract_ledger_order_chk', message: 'new row violates check constraint' };
    assertRefusedBy(refusal, '23514', 'contract_ledger_order_chk');
    expectCheckFails(() => assertRefusedBy(refusal, '23505', 'contract_ledger_order_chk'));
    expectCheckFails(() => assertRefusedBy(refusal, '23514', 'payment_request_claim_chk'));
    expectCheckFails(() => assertRefusedBy({ ...refusal, constraint: 'contract_value_chk' }, '23514', /^contract_(ledger_order|cash_out)_chk$/));
  });
});
