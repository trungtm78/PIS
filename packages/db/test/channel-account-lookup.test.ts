import { resolve } from 'node:path';
import { Client } from 'pg';
import { startMigratedTestDatabase } from '../src/migrated-test-database';
import type { TestDatabase } from '../src/test-database';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const PLACEMENT = '00000000-0000-4000-8000-0000000000b1';
const TENANT_ONE = '00000000-0000-4000-8000-0000000000a1';
const TENANT_TWO = '00000000-0000-4000-8000-0000000000a2';
const TENANT_THREE = '00000000-0000-4000-8000-0000000000a3';
const ACCOUNT_ONE = '00000000-0000-4000-8000-0000000000c1';
const ACCOUNT_TWO = '00000000-0000-4000-8000-0000000000c2';
const ACCOUNT_THREE = '00000000-0000-4000-8000-0000000000c3';

/**
 * machvon.channel_accounts_by_external_id (V1440) is how a provider callback, which carries no session, finds the tenant that owns the account it
 * names. The tenant it answers is the one that receives the callback and whose keys judge the signature, so only an account that can receive a
 * callback may be an answer: a second tenant that holds the same external id on an account that is not live must not make it ambiguous.
 */
describe('the cross-tenant lookup of a channel account by its external id (receiveChannelWebhook)', () => {
  let database: TestDatabase;
  let admin: Client;

  const control = async <T>(work: (client: Client) => Promise<T>, role: 'machvon_control' | 'machvon_app' = 'machvon_control'): Promise<T> => {
    const client = new Client({ connectionString: database.urlFor(role) });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    database = await startMigratedTestDatabase(REPO_ROOT, { tempPrefix: 'machvon-pg-chan-' });
    admin = new Client({ connectionString: database.adminUrl });
    await admin.connect();
    await admin.query("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ($1, 'POOL', 'vn-north', 'c-1', 'k-1', 'Active')", [PLACEMENT]);
    for (const [id, code] of [
      [TENANT_ONE, 'CHAN_ONE'],
      [TENANT_TWO, 'CHAN_TWO'],
      [TENANT_THREE, 'CHAN_THREE'],
    ]) {
      await admin.query("insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, $2, $2, 'Active', $3, 'vn-north')", [id, code, PLACEMENT]);
    }
    await admin.query(
      `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at, webhook_secret_ref)
       values ($1, $4, 'EMAIL', 'shared-sender', 'secret://t/one', 'v1', 'Active', now(), 'secret://t/one-hook'),
              ($2, $5, 'EMAIL', 'shared-sender', 'secret://t/two', 'v1', 'PendingVerification', null, 'secret://t/two-hook'),
              ($3, $6, 'EMAIL', 'other-sender', 'secret://t/three', 'v1', 'Active', now(), 'secret://t/three-hook')`,
      [TENANT_ONE, TENANT_TWO, TENANT_THREE, ACCOUNT_ONE, ACCOUNT_TWO, ACCOUNT_THREE],
    );
  }, 180_000);

  afterAll(async () => {
    await admin?.end();
    if (database) await database.stop();
  }, 60_000);

  it('finds the live account of the id across tenants, and not an account of another tenant that is only waiting to be verified', async () => {
    const rows = await control((client) => client.query('select tenant_id, channel_account_id, channel from machvon.channel_accounts_by_external_id($1)', ['shared-sender']));
    expect(rows.rows).toEqual([{ tenant_id: TENANT_ONE, channel_account_id: ACCOUNT_ONE, channel: 'EMAIL' }]);
    const other = await control((client) => client.query('select tenant_id from machvon.channel_accounts_by_external_id($1)', ['other-sender']));
    expect(other.rows).toEqual([{ tenant_id: TENANT_THREE }]);
    expect((await control((client) => client.query('select 1 from machvon.channel_accounts_by_external_id($1)', ['nobody']))).rows).toEqual([]);
  });

  it('still answers once the account is disabled elsewhere and live again: a disabled account is never an answer', async () => {
    await admin.query("update machvon.channel_account set status = 'Disabled' where id = $1", [ACCOUNT_ONE]);
    try {
      expect((await control((client) => client.query('select 1 from machvon.channel_accounts_by_external_id($1)', ['shared-sender']))).rows).toEqual([]);
    } finally {
      // Set-up of the test, not a move the application can make: a closed account does not come back, so the guard is off for this one statement.
      await admin.query('alter table machvon.channel_account disable trigger channel_account_guard');
      await admin.query("update machvon.channel_account set status = 'Active' where id = $1", [ACCOUNT_ONE]);
      await admin.query('alter table machvon.channel_account enable trigger channel_account_guard');
    }
  });

  it('puts the tenant setting of the caller back, whatever it was', async () => {
    const seen = await control(async (client) => {
      await client.query('begin');
      await client.query("select set_config('app.tenant_id', $1, true)", [TENANT_THREE]);
      await client.query('select * from machvon.channel_accounts_by_external_id($1)', ['shared-sender']);
      const kept = await client.query("select current_setting('app.tenant_id', true) as tenant");
      await client.query('rollback');
      return kept.rows[0].tenant;
    });
    expect(seen).toBe(TENANT_THREE);
  });

  it('is for the control role only: the runtime role of the tenant plane cannot run it', async () => {
    await expect(control((client) => client.query('select * from machvon.channel_accounts_by_external_id($1)', ['shared-sender']), 'machvon_app')).rejects.toThrow(/permission denied/i);
  });
});
