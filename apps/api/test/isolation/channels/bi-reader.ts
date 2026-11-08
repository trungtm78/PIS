import { generateBiPassword, scramVerifierOf } from '@machvon/kernel';
import { Client } from 'pg';
import { INT_FIXTURES, TENANT_IDS, UNIT_FIXTURES } from '../suite';
import type { ForeignAttempt, IsolationChannel, TenantName } from '../suite';

export interface BiReaderChannelOptions {
  /** A privileged connection: it makes the logins through the function of the database (as the application does) and writes the frozen rows without the foreign keys the fixtures do not need. */
  adminUrl: string;
  /** The connection string of a login: the host, the port and the database of the test server with the login and its password. */
  loginUrl(login: string, password: string): string;
}

/** The tables the BI group role may read (with some column) and the view of the dataset; none may show a row of another tenant. */
const READS = [
  'select tenant_id, snapshot_id, line_id, unit_id from machvon_bi.v_disbursement_lines',
  'select tenant_id, snapshot_id, contract_id from machvon_bi.v_contract_lines',
  'select tenant_id, id, unit_id from machvon.period_snapshot_line',
  'select tenant_id, id from machvon.period_snapshot',
  'select tenant_id, snapshot_id from machvon.contract_fact_snapshot_line',
  'select tenant_id, id from machvon.contract_fact_snapshot',
];

const INSERT_SNAPSHOT = `insert into machvon.period_snapshot (tenant_id, id, period_id, snapshot_kind, as_of_at, as_of_date, treasury_cutoff_date, status, metric_set_version, definition_status, row_count, created_by, updated_by)
  values ($1, $2, $3, 'PERIOD_CLOSE', now(), current_date, current_date, 'BUILDING', 'v1', 'PROPOSED_PENDING_SIGNOFF', 1, $4, $4)`;
const INSERT_LINE = `insert into machvon.period_snapshot_line (tenant_id, id, snapshot_id, project_id, unit_id, bucket, budget_level, plan_pm_assigned_vnd, plan_local_added_vnd, plan_total_vnd, treasury_coverage)
  values ($1, $2, $3, $4, $5, 'CURRENT_YEAR', 'CENTRAL', 1000, 0, 1000, 'COMPLETE')`;
const FREEZE_SNAPSHOT = "update machvon.period_snapshot set status = 'FROZEN', payload_sha256 = repeat('c', 64), frozen_by = $2, frozen_at = now() where id = $1";
const INSERT_PRODUCT = `insert into machvon.data_product (tenant_id, id, code, title, dataset_ids, owner_user_id, certification_status, certified_by, certified_at, certification_expires_on, evidence_refs, created_by, updated_by)
  values ($1, $2, $3, $3, $4::jsonb, $5, 'CERTIFIED', $6, now(), date '2099-01-01', '["evidence-1"]', $5, $5)`;
const INSERT_DATASET = `insert into machvon.int_export_dataset (tenant_id, id, dataset_code, product_id, enabled, state_changed_by, created_by, updated_by) values ($1, gen_random_uuid(), 'DS-DISB', $2, true, $3, $3, $3)`;

const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const CHECKER = '00000000-0000-4000-8000-0000000000f1';

/**
 * The database path of the open interface as a way to read another tenant's data (INT-1, eng-review R6 and R13). Each tenant has a BI login made the way the application makes it. The login of TNT-A is
 * pointed at TNT-B in the one way it can: it sets `app.tenant_id` to TNT-B. Every read of the certified views and of the granted tables must then be empty, and every table it was never granted must stay closed.
 * The login must first read its OWN rows, so an empty answer cannot be an empty fixture.
 */
export function createBiReaderChannel(options: BiReaderChannelOptions): IsolationChannel {
  const passwords = new Map<TenantName, string>();

  async function admin<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: options.adminUrl });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  async function seed(tenant: TenantName): Promise<void> {
    if (passwords.has(tenant)) return;
    const tenantId = TENANT_IDS[tenant];
    const fixture = INT_FIXTURES[tenant];
    const unit = UNIT_FIXTURES[tenant][0]?.id ?? ACTOR;
    const password = generateBiPassword();
    await admin(async (client) => {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query(INSERT_SNAPSHOT, [tenantId, fixture.snapshotId, fixture.periodId, ACTOR]);
      await client.query(INSERT_LINE, [tenantId, fixture.lineId, fixture.snapshotId, fixture.productId, unit]);
      await client.query(FREEZE_SNAPSHOT, [fixture.snapshotId, ACTOR]);
      await client.query(INSERT_PRODUCT, [tenantId, fixture.productId, `ISO-${tenant}`, JSON.stringify([fixture.productId]), ACTOR, CHECKER]);
      await client.query(INSERT_DATASET, [tenantId, fixture.productId, ACTOR]);
      await client.query('select machvon_bi.provision_reader($1::uuid, $2::uuid, $3, $4, 3)', [tenantId, fixture.readerId, fixture.loginName, scramVerifierOf(password)]);
      await client.query('commit');
    });
    passwords.set(tenant, password);
  }

  async function asLogin<T>(user: TenantName, work: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: options.loginUrl(INT_FIXTURES[user].loginName, passwords.get(user) as string) });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  /** What the login reads when it names `target` as its tenant. */
  async function readsAfterNaming(user: TenantName, target: TenantName, queries: readonly string[] = READS): Promise<{ status: number; body: string }> {
    return asLogin(user, async (client) => {
      await client.query("select set_config('app.tenant_id', $1, false)", [TENANT_IDS[target]]);
      const items: unknown[] = [];
      for (const sql of queries) items.push(...(await client.query(sql)).rows);
      return { status: 200, body: JSON.stringify({ items }) };
    });
  }

  async function refused(user: TenantName, sql: string): Promise<{ status: number; body: string }> {
    return asLogin(user, async (client) => {
      try {
        await client.query(sql);
        return { status: 200, body: JSON.stringify({ items: [{ answered: true }] }) };
      } catch (error) {
        const code = (error as { code?: string }).code;
        // 42501 is "permission denied": the login was never granted it; 25006 is the read-only transaction every BI login runs in, which refuses a write before it asks for a right.
        return { status: code === '42501' || code === '25006' ? 403 : 500, body: JSON.stringify({ code }) };
      }
    });
  }

  return {
    name: 'bi-reader',
    foreignReadOutcome: 'empty',
    seed,
    async readAs(user, target) {
      // The sanity of the fixture: with its own tenant set, the login reads its own rows.
      const own = await readsAfterNaming(user, user);
      if ((JSON.parse(own.body) as { items: unknown[] }).items.length < 3) throw new Error('the BI login of the channel reads none of its own rows: the fixture is empty');
      return readsAfterNaming(user, target);
    },
    async foreignAttempts(user): Promise<ForeignAttempt[]> {
      const other = INT_FIXTURES['TNT-B'];
      const attempts: ForeignAttempt[] = [];
      for (const [index, sql] of READS.entries()) attempts.push({ operation: `bi-reader:read:${index}`, ...(await readsAfterNaming(user, 'TNT-B', [sql])), expectedStatuses: [200], mustBeEmpty: true });
      for (const [name, sql] of [
        ['binding', 'select * from machvon_bi.reader_binding'],
        ['project', 'select * from machvon.project'],
        ['credentials', 'select * from machvon.int_machine_credential'],
        ['write', 'update machvon.period_snapshot_line set plan_total_vnd = 0'],
        ['provision', `select machvon_bi.provision_reader('${TENANT_IDS['TNT-B']}', gen_random_uuid(), 'machvon_bi_ffffffffffff', 'x', 1)`],
      ] as const) {
        attempts.push({ operation: `bi-reader:closed:${name}`, ...(await refused(user, sql)), expectedStatuses: [403] });
      }
      // Asking about the login of the other tenant tells nothing: no tenant, and the dataset is closed.
      attempts.push({
        operation: 'bi-reader:other-login',
        ...(await asLogin(user, async (client) => {
          const rows = (await client.query(`select machvon_bi.tenant_of('${other.loginName}') as tenant_id`)).rows.filter((row: { tenant_id: string | null }) => row.tenant_id !== null);
          const state = (await client.query(`select tenant_id from machvon_bi.dataset_state('${other.loginName}', 'DS-DISB') where tenant_id is not null`)).rows;
          return { status: 200, body: JSON.stringify({ items: [...rows, ...state] }) };
        })),
        expectedStatuses: [200],
        mustBeEmpty: true,
      });
      return attempts;
    },
  };
}
