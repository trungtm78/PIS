import { IntegrationConnectorStore } from '../src/integration-connector-store';
import type { NewConnector } from '../src/integration-connector-store';
import { DEFAULT_CURSORS, IntegrationCursorStore } from '../src/integration-cursor-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const connectors = new IntegrationConnectorStore();
const ACTOR = 1;

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(ACTOR)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

let counter = 0;
const draft = (overrides: Partial<NewConnector> = {}): NewConnector => {
  counter += 1;
  return { connectorCode: `connector-${counter}`, mode: 'FILE_IMPORT', adapterStatus: 'PROPOSED', config: { directory: '/inbox' }, ...overrides };
};
const create = (overrides: Partial<NewConnector> = {}, tenant = TENANT_A) => as((tx) => connectors.create(tx, draft(overrides), memberId(ACTOR)), tenant);
/** `null` is an environment that is not named. */
const move = (id: string, version: number, status: 'Draft' | 'Active' | 'Disabled', environment: string | null = 'staging') =>
  as((tx) => connectors.update(tx, id, version, { status }, memberId(ACTOR), environment ?? undefined));

describe('IntegrationConnectorStore (connectors with an honest adapter status, ST-ADM-018)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      await harness.seedMembership(tenant, ACTOR, 1);
    }
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('declaring', () => {
    it('writes a draft at version 1 with its settings and the person who made it', async () => {
      const row = await create({ connectorCode: 'treasury-file', mode: 'FILE_EXPORT', adapterStatus: 'PROPOSED', config: { directory: '/outbox', encoding: 'UTF-8' }, credentialSecretRef: 'secret://production/connectors/treasury', mappingVersion: 'v1.0' });
      expect(row).toMatchObject({
        connectorCode: 'treasury-file',
        mode: 'FILE_EXPORT',
        adapterStatus: 'PROPOSED',
        config: { directory: '/outbox', encoding: 'UTF-8' },
        credentialSecretRef: 'secret://production/connectors/treasury',
        mappingVersion: 'v1.0',
        status: 'Draft',
        version: 1,
        createdBy: memberId(ACTOR),
        lastTestAt: null,
        lastTestResult: null,
      });
      expect(await as((tx) => connectors.find(tx, row.id))).toEqual(row);
    });

    it('refuses a second connector with the code of one the tenant has with 409 CONNECTOR_CODE_TAKEN, and lets another tenant use it', async () => {
      await create({ connectorCode: 'shared-code' });
      expect(await refusal(create({ connectorCode: 'shared-code', adapterStatus: 'MOCK' }))).toEqual({ code: 'CONNECTOR_CODE_TAKEN', status: 409 });
      expect((await create({ connectorCode: 'shared-code' }, TENANT_B)).connectorCode).toBe('shared-code');
      expect(await owner("select count(*)::int as n from machvon.integration_connector where connector_code = 'shared-code'")).toEqual([{ n: 1 }]);
    });

    it('refuses a configuration that holds a secret, a credential that is not a reference to the vault, a mapping version that is malformed (NFR-SECURITY-06)', async () => {
      expect(await refusal(create({ config: { auth: { password: 'hunter2' } } }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'config' });
      expect(await refusal(create({ credentialSecretRef: 'hunter2' }))).toMatchObject({ detail: 'credential_secret_ref' });
      expect(await refusal(create({ mappingVersion: 'has spaces' }))).toMatchObject({ detail: 'mapping_version' });
      expect(await owner("select 1 from machvon.integration_connector where config_json::text like '%hunter2%'")).toEqual([]);
    });

    it.each(['TREASURY', 'ab', 'has space'])('refuses the code %j in the database as well', async (code) => {
      await expect(
        owner("insert into machvon.integration_connector (tenant_id, id, connector_code, adapter_status, mode, config_json, status) values ($1, gen_random_uuid(), $2, 'PROPOSED', 'API', '{}', 'Draft')", [TENANT_A, code]),
      ).rejects.toMatchObject({ constraint: 'integration_connector_code_chk' });
    });

    it('reuses the cursor table: a connector cannot claim VERIFIED where the platform recorded the cursor of that connector as something else', async () => {
      await as((tx) => new IntegrationCursorStore().ensureDefaults(tx, memberId(ACTOR)));
      const code = DEFAULT_CURSORS[1]?.connectorCode.toLowerCase() as string;
      expect(await refusal(create({ connectorCode: code, adapterStatus: 'VERIFIED' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'adapter_status' });
      // The honest words are always welcome: the platform says PROPOSED and so does the connector; a mock is declared as a mock.
      expect((await create({ connectorCode: code, adapterStatus: 'PROPOSED' })).adapterStatus).toBe('PROPOSED');
      const mock = DEFAULT_CURSORS[2]?.connectorCode.toLowerCase() as string;
      expect((await create({ connectorCode: mock, adapterStatus: 'MOCK' })).adapterStatus).toBe('MOCK');
      // Once the platform records the cursor as VERIFIED the connector may claim it.
      const verified = DEFAULT_CURSORS[3]?.connectorCode as string;
      await owner("update machvon.integration_cursor set adapter_status = 'VERIFIED' where connector_code = $1", [verified]);
      expect((await create({ connectorCode: verified.toLowerCase(), adapterStatus: 'VERIFIED' })).adapterStatus).toBe('VERIFIED');
      expect(await as((tx) => connectors.cursorAdapter(tx, 'no-such-connector'))).toBeUndefined();
      expect((await create({ connectorCode: 'free-verified', adapterStatus: 'VERIFIED' })).adapterStatus).toBe('VERIFIED');
    });
  });

  describe('activating (BR-ADM-10)', () => {
    it('refuses a PROPOSED connector and a MISSING one with 422 CONNECTOR_NOT_ACTIVATABLE (AC-ST-ADM-018-1, UAT-AC137)', async () => {
      const proposed = await create({ adapterStatus: 'PROPOSED' });
      expect(await refusal(move(proposed.id, 1, 'Active'))).toEqual({ code: 'CONNECTOR_NOT_ACTIVATABLE', status: 422, detail: 'ADAPTER_NOT_VERIFIED' });
      const missing = await create({ adapterStatus: 'MISSING' });
      expect(await refusal(move(missing.id, 1, 'Active', 'local'))).toMatchObject({ code: 'CONNECTOR_NOT_ACTIVATABLE' });
      expect(await as((tx) => connectors.find(tx, proposed.id))).toMatchObject({ status: 'Draft', version: 1 });
    });

    it('refuses MOCK in production and in the recovery site, and lets it run elsewhere', async () => {
      const mock = await create({ adapterStatus: 'MOCK' });
      for (const environment of ['production', 'dr', null, 'surprise']) {
        expect(await refusal(move(mock.id, 1, 'Active', environment))).toEqual({ code: 'CONNECTOR_NOT_ACTIVATABLE', status: 422, detail: 'MOCK_IN_PRODUCTION' });
      }
      expect((await move(mock.id, 1, 'Active', 'staging')).row).toMatchObject({ status: 'Active', version: 2 });
    });

    it('lets a VERIFIED connector be Active in production and keeps the adapter status as it was declared', async () => {
      const verified = await create({ adapterStatus: 'VERIFIED' });
      const done = await move(verified.id, 1, 'Active', 'production');
      expect(done.before).toMatchObject({ status: 'Draft', version: 1 });
      expect(done.row).toMatchObject({ status: 'Active', adapterStatus: 'VERIFIED', version: 2 });
    });

    it('also asks the cursor that the platform recorded, at the time of activation', async () => {
      const code = 'activation-cursor';
      const verified = await create({ connectorCode: code, adapterStatus: 'VERIFIED' });
      await owner("insert into machvon.integration_cursor (tenant_id, id, connector_code, source_scope, cursor_json, schema_version, adapter_status, status) values ($1, gen_random_uuid(), $2, 'DEFAULT', '{}', '1', 'MISSING', 'ACTIVE')", [TENANT_A, code.toUpperCase()]);
      expect(await refusal(move(verified.id, 1, 'Active', 'production'))).toEqual({ code: 'CONNECTOR_NOT_ACTIVATABLE', status: 422, detail: 'ADAPTER_NOT_VERIFIED' });
    });

    it('is also a database rule: an Active connector with a PROPOSED adapter cannot be written past the code', async () => {
      const proposed = await create({ adapterStatus: 'PROPOSED' });
      await expect(owner("update machvon.integration_connector set status = 'Active' where id = $1", [proposed.id])).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('changing', () => {
    it('follows the moves of a connector: draft to Active or Disabled, Active only to Disabled, Disabled back to Active or to draft', async () => {
      const row = await create({ adapterStatus: 'VERIFIED' });
      expect(await refusal(move(row.id, 1, 'Draft'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'status' });
      const active = (await move(row.id, 1, 'Active')).row;
      expect(await refusal(move(row.id, active.version, 'Draft'))).toMatchObject({ detail: 'status' });
      const disabled = (await move(row.id, active.version, 'Disabled')).row;
      expect(disabled).toMatchObject({ status: 'Disabled', version: 3 });
      const again = (await move(row.id, disabled.version, 'Active')).row;
      expect(again.status).toBe('Active');
      const off = (await move(row.id, again.version, 'Disabled')).row;
      expect((await move(row.id, off.version, 'Draft')).row.status).toBe('Draft');
    });

    it('changes the settings of a connector, even an Active one, and checks them as at creation', async () => {
      const row = await create({ adapterStatus: 'VERIFIED' });
      const active = (await move(row.id, 1, 'Active')).row;
      const changed = await as((tx) => connectors.update(tx, row.id, active.version, { config: { directory: '/new' }, credentialSecretRef: 'secret://production/other', mappingVersion: 'v2' }, memberId(ACTOR), 'production'));
      expect(changed.row).toMatchObject({ status: 'Active', config: { directory: '/new' }, credentialSecretRef: 'secret://production/other', mappingVersion: 'v2', version: 3 });
      expect(changed.before.config).toEqual({ directory: '/inbox' });
      expect(await refusal(as((tx) => connectors.update(tx, row.id, 3, { config: { secret: 'x' } }, memberId(ACTOR), 'production')))).toMatchObject({ detail: 'config' });
      expect(await refusal(as((tx) => connectors.update(tx, row.id, 3, { credentialSecretRef: 'plain' }, memberId(ACTOR), 'production')))).toMatchObject({ detail: 'credential_secret_ref' });
    });

    it('does not let a MOCK connector that became Active in a test environment be re-saved as Active in production', async () => {
      const mock = await create({ adapterStatus: 'MOCK' });
      const active = (await move(mock.id, 1, 'Active', 'staging')).row;
      expect(await refusal(as((tx) => connectors.update(tx, mock.id, active.version, { mappingVersion: 'v9' }, memberId(ACTOR), 'production')))).toMatchObject({ code: 'CONNECTOR_NOT_ACTIVATABLE', detail: 'MOCK_IN_PRODUCTION' });
      expect((await move(mock.id, active.version, 'Disabled', 'production')).row.status).toBe('Disabled');
    });

    it('answers 404 to a connector that is not there, 409 VERSION_CONFLICT to a stale version, and 422 to a change that changes nothing', async () => {
      const row = await create();
      expect(await refusal(move('00000000-0000-4000-8000-0000000000ff', 1, 'Disabled'))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(move(row.id, 7, 'Disabled'))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(as((tx) => connectors.update(tx, row.id, 1, {}, memberId(ACTOR), 'staging')))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'status' });
      expect(await refusal(move(row.id, 1, 'Draft'))).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('keeps the code and the mode of a connector for good and never deletes it', async () => {
      const row = await create();
      await expect(owner("update machvon.integration_connector set connector_code = 'other-code' where id = $1", [row.id])).rejects.toMatchObject({ code: '23514' });
      await expect(owner("update machvon.integration_connector set mode = 'API' where id = $1", [row.id])).rejects.toMatchObject({ code: '23514' });
      await expect(as((tx) => tx.query('delete from machvon.integration_connector where id = $1', [row.id]))).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('reading', () => {
    it('pages the connectors of the tenant by code and shows none of another tenant', async () => {
      const everything = await as((tx) => connectors.list(tx, { limit: 500, after: undefined }));
      expect(everything.map((row) => row.connectorCode)).toEqual([...everything.map((row) => row.connectorCode)].sort());
      const seen: string[] = [];
      let after: { code: string; id: string } | undefined;
      for (let page = 0; page < 60; page += 1) {
        const rows = await as((tx) => connectors.list(tx, { limit: 4, after }));
        seen.push(...rows.map((row) => row.id));
        const last = rows[rows.length - 1];
        if (rows.length < 4 || last === undefined) break;
        after = { code: last.connectorCode, id: last.id };
      }
      expect(seen).toEqual(everything.map((row) => row.id));
      const other = await as((tx) => connectors.list(tx, { limit: 500, after: undefined }), TENANT_B);
      expect(other.map((row) => row.id)).not.toContain(everything[0]?.id);
      expect(await as((tx) => connectors.find(tx, everything[0]?.id as string), TENANT_B)).toBeUndefined();
    });
  });
});
