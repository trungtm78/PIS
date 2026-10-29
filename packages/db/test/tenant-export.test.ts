import { Client } from 'pg';
import type { ApprovalEffects } from '../src/approval-store';
import { TenantExportStore } from '../src/tenant-export-store';
import type { ExportJobRow } from '../src/tenant-export-store';
import type { TenantTx } from '../src/tenant-database';
import { generateKeyPairSync } from 'node:crypto';
import { AuthzHarness, TENANT_A, TENANT_B, memberId } from './support/authz-fixtures';

const store = new TenantExportStore();
const PLACEMENT = '00000000-0000-4000-8000-0000000000b1';
const OWNER = memberId(1);
const NOW = new Date('2026-10-30T03:00:00Z');
const hours = (n: number, from = NOW): Date => new Date(from.getTime() + n * 3_600_000);
const REASON = 'The province asked for its data at the end of the contract.';

interface Recorded {
  audits: Array<{ action: string; resourceId: string; diff: unknown }>;
  events: Array<{ type: string; eventKey: string }>;
}

function recorder(): ApprovalEffects & Recorded {
  const audits: Recorded['audits'] = [];
  const events: Recorded['events'] = [];
  return {
    actor: OWNER,
    audits,
    events,
    audit: async (entry) => void audits.push({ action: entry.action, resourceId: entry.resourceId, diff: entry.diff }),
    emit: async (event) => void events.push({ type: event.type, eventKey: event.eventKey }),
  };
}

describe('the export of the data of a tenant (ST-SAS-016, SAS.md 3.10)', () => {
  const harness = new AuthzHarness();
  const asTenant = <T>(tenant: string, work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant({ tenantId: tenant, membershipId: OWNER, scopeVersion: 0 }, work);
  const snapshotOf = <T>(tenant: string, work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withSnapshot({ tenantId: tenant, membershipId: OWNER, scopeVersion: 0 }, work);

  const admin = async <T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(text, params)).rows as T[];
    } finally {
      await client.end();
    }
  };
  const sqlError = async (text: string, params: unknown[] = []): Promise<{ code: string | undefined; message: string } | undefined> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query(text, params);
      return undefined;
    } catch (error) {
      return { code: (error as { code?: string }).code, message: (error as Error).message };
    } finally {
      await client.end();
    }
  };

  /** Every row of a table of a tenant, read through the cursor of the store in one snapshot. */
  const allRows = (tenantId: string, table: string, columns: string[]) =>
    snapshotOf(tenantId, async (tx) => {
      await store.openRows(tx, table, columns);
      const rows = await store.nextRows(tx, 1000);
      await store.closeRows(tx);
      return rows;
    });

  /** Each test gets a tenant of its own: only one export runs at a time for a tenant. */
  let counter = 0;
  async function tenant(status = 'Active', reason: string | null = null): Promise<string> {
    counter += 1;
    const id = `00000000-0000-4000-8000-${(0xe000 + counter).toString(16).padStart(12, '0')}`;
    await admin("insert into machvon.tenant (id, code, name, status, placement_id, region, lifecycle_reason) values ($1, $2, $2, $3, $4, 'vn-north', $5)", [id, `export-${counter}`, status, PLACEMENT, reason]);
    await harness.seedUnits(id, [{ n: 1, path: '/u1/' }]);
    return id;
  }

  const ask = (tenantId: string, overrides: Partial<Parameters<TenantExportStore['request']>[2]> = {}, effects = recorder()) =>
    asTenant(tenantId, (tx) => store.request(tx, effects, { requestedBy: OWNER, scope: 'FULL', reason: REASON, ...overrides }, NOW));

  const ready = (tenantId: string, job: ExportJobRow, at = NOW) =>
    asTenant(tenantId, async (tx) => {
      const claimed = await store.claim(tx);
      expect(claimed?.id).toBe(job.id);
      return store.ready(tx, recorder(), job.id, { manifestStorageKey: 'tenants/x/tenant_export/m', manifestSha256: 'a'.repeat(64), fileCount: 2, totalBytes: 40, rowCounts: { project: 2 }, snapshotAt: at, tenantStatus: 'Active' }, at);
    });

  beforeAll(async () => {
    await harness.start();
    await admin("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ($1, 'POOL', 'vn-north', 'cluster-1', 'kms-1', 'Active') on conflict do nothing", [PLACEMENT]);
    for (const [id, code] of [[TENANT_A, 'tenant-a'], [TENANT_B, 'tenant-b']] as const) {
      await admin("insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, $2, $2, 'Active', $3, 'vn-north') on conflict (id) do nothing", [id, code, PLACEMENT]);
    }
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/u1/' }, { n: 2, path: '/u2/' }]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: '/u1/' }]);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the request', () => {
    it('waits for the worker, audits, and refuses a second one while it waits or runs', async () => {
      const tenantId = await tenant();
      const effects = recorder();
      const job = await ask(tenantId, {}, effects);
      expect(job).toMatchObject({ status: 'Requested', scope: 'FULL', requestedBy: OWNER, version: 1, publicKeyPem: null, encryptionKeyFingerprint: null });
      expect(effects.audits.map((entry) => entry.action)).toEqual(['tenant.export_requested']);
      await expect(ask(tenantId)).rejects.toMatchObject({ code: 'EXPORT_ALREADY_RUNNING', status: 409 });
      await asTenant(tenantId, (tx) => store.claim(tx));
      await expect(ask(tenantId)).rejects.toMatchObject({ code: 'EXPORT_ALREADY_RUNNING', status: 409 });
    });

    it('is made in a tenant that is Active, Suspended with read and export, or Offboarding, and in no other state', async () => {
      for (const [status, reason] of [['Active', null], ['Suspended', 'NON_PAYMENT'], ['Offboarding', null]] as const) {
        expect((await ask(await tenant(status, reason))).status).toBe('Requested');
      }
      for (const [status, reason] of [['Suspended', 'SECURITY_INCIDENT'], ['Archived', null], ['Provisioning', null]] as const) {
        await expect(ask(await tenant(status, reason))).rejects.toMatchObject({ code: 'TENANT_STATE_INVALID', status: 409 });
      }
    });

    it('keeps the public key of the customer and its fingerprint, and refuses a key that is not an RSA key of 2048 bits, and a reason that is too short', async () => {
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
      const job = await ask(await tenant(), { publicKeyPem: pair.publicKey });
      expect(job.publicKeyPem).toBe(pair.publicKey);
      expect(job.encryptionKeyFingerprint).toMatch(/^[0-9a-f]{64}$/);
      await expect(ask(await tenant(), { publicKeyPem: 'not a key' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'encryption_public_key_pem' });
      await expect(ask(await tenant(), { reason: 'short' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
    });

    it('is the tenant\'s own: another tenant does not see it', async () => {
      const mine = await ask(await tenant());
      expect(await asTenant(TENANT_B, (tx) => store.find(tx, mine.id))).toBeUndefined();
      expect((await asTenant(TENANT_B, (tx) => store.list(tx, { limit: 100 }))).map((job) => job.id)).not.toContain(mine.id);
    });
  });

  describe('the snapshot', () => {
    it('lists the tables of the tenant plane, not the platform ones, and reads only the rows of the tenant', async () => {
      const tables = await snapshotOf(TENANT_A, (tx) => store.tablesOf(tx));
      expect(tables).toEqual(expect.arrayContaining(['organization_unit', 'tenant_export_job', 'support_access_grant', 'audit_event']));
      expect(tables).not.toContain('tenant');
      const columns = await snapshotOf(TENANT_A, (tx) => store.columnsOf(tx, 'organization_unit'));
      expect(columns).toEqual(expect.arrayContaining(['tenant_id', 'id', 'code']));
      expect((await allRows(TENANT_A, 'organization_unit', ['tenant_id', 'code'])).map((row) => row.tenant_id)).toEqual([TENANT_A, TENANT_A]);
      expect((await allRows(TENANT_B, 'organization_unit', ['tenant_id', 'code'])).map((row) => row.tenant_id)).toEqual([TENANT_B]);
    });

    it('pages the rows in a stable order, and shows one picture of the tenant while rows are written meanwhile', async () => {
      // A page of one row at a time: the cursor gives each row once, in the order of the table.
      const paged = await snapshotOf(TENANT_A, async (tx) => {
        await store.openRows(tx, 'organization_unit', ['code']);
        const rows: string[] = [];
        for (;;) {
          const page = await store.nextRows(tx, 1);
          rows.push(...page.map((row) => row.code as string));
          if (page.length < 1) break;
        }
        await store.closeRows(tx);
        return rows;
      });
      expect([...paged].sort()).toEqual(['U1', 'U2']);
      const seen = await snapshotOf(TENANT_A, async (tx) => {
        const read = async (): Promise<number> => {
          await store.openRows(tx, 'organization_unit', ['code']);
          const rows = await store.nextRows(tx, 100);
          await store.closeRows(tx);
          return rows.length;
        };
        const before = await read();
        await harness.seedUnits(TENANT_A, [{ n: 9, path: '/u9/' }]);
        return [before, await read()];
      });
      expect(seen[0]).toBe(seen[1]);
      expect((await allRows(TENANT_A, 'organization_unit', ['code'])).length).toBe((seen[0] ?? 0) + 1);
    });

    it('names the tables of the tenant plane that the worker cannot read instead of reading them as empty', async () => {
      const readable = await snapshotOf(TENANT_A, (tx) => store.tablesOf(tx));
      const unreadable = await snapshotOf(TENANT_A, (tx) => store.unreadableTablesOf(tx));
      expect(unreadable).toEqual(expect.arrayContaining(['tenant_theme_draft', 'tenant_theme_review', 'tenant_theme_asset']));
      expect(readable.filter((table) => unreadable.includes(table))).toEqual([]);
      expect(readable).toContain('organization_unit');
      // Their columns are invisible to the role too: reading them would have given an empty file.
      expect(await snapshotOf(TENANT_A, (tx) => store.columnsOf(tx, 'tenant_theme_draft'))).toEqual([]);
    });

    it('cannot write: the snapshot is read-only', async () => {
      await expect(snapshotOf(TENANT_A, (tx) => tx.query("update machvon.organization_unit set name = 'x'"))).rejects.toMatchObject({ code: '25006' });
    });
  });

  describe('making it', () => {
    it('is claimed once, becomes Ready with a link of 72 hours, and says so', async () => {
      const tenantId = await tenant();
      const job = await ask(tenantId);
      expect((await asTenant(tenantId, (tx) => store.claim(tx)))?.status).toBe('Running');
      expect(await asTenant(tenantId, (tx) => store.claim(tx))).toBeUndefined();
      const effects = recorder();
      const done = await asTenant(tenantId, (tx) => store.ready(tx, effects, job.id, { manifestStorageKey: 'tenants/x/tenant_export/m', manifestSha256: 'b'.repeat(64), fileCount: 3, totalBytes: 99, rowCounts: { project: 1 }, snapshotAt: NOW, tenantStatus: 'Active' }, hours(1)));
      expect(done).toMatchObject({ status: 'Ready', fileCount: 3, totalBytes: '99', rowCounts: { project: 1 }, manifestSha256: 'b'.repeat(64) });
      expect(done.expiresAt).toEqual(hours(73));
      expect(done.snapshotAt).toEqual(NOW);
      expect(effects.audits.map((entry) => entry.action)).toEqual(['tenant.export_ready']);
      expect(effects.events.map((event) => event.type)).toEqual(['sas.tenant_export.ready.v1']);
      await expect(ask(tenantId)).resolves.toMatchObject({ status: 'Requested' });
    });

    it('ends as Failed with the class of the failure when it cannot be made, and a new one can be asked for', async () => {
      const tenantId = await tenant();
      const job = await ask(tenantId);
      await asTenant(tenantId, (tx) => store.claim(tx));
      const effects = recorder();
      await asTenant(tenantId, (tx) => store.fail(tx, effects, job.id, 'StorageError'));
      expect(await asTenant(tenantId, (tx) => store.find(tx, job.id))).toMatchObject({ status: 'Failed', errorCode: 'StorageError' });
      expect(effects.audits.map((entry) => entry.action)).toEqual(['tenant.export_failed']);
      await expect(ask(tenantId)).resolves.toMatchObject({ status: 'Requested' });
    });

    it('is held by the table: what was asked for and what was made do not change, a job only moves forward and nothing deletes one', async () => {
      const tenantId = await tenant();
      const job = await ask(tenantId);
      await ready(tenantId, job);
      for (const statement of [
        "update machvon.tenant_export_job set reason = 'another reason entirely' where id = $1",
        "update machvon.tenant_export_job set manifest_sha256 = repeat('c', 64) where id = $1",
        "update machvon.tenant_export_job set status = 'Running' where id = $1",
        "update machvon.tenant_export_job set expires_at = expires_at + interval '1 day' where id = $1",
        'delete from machvon.tenant_export_job where id = $1',
      ]) {
        expect((await sqlError(statement, [job.id]))?.code).toBe('23514');
      }
      expect((await sqlError("update machvon.tenant_export_job set status = 'Ready', manifest_sha256 = null where id = $1", [job.id]))?.code).toBeDefined();
    });
  });

  describe('the downloads', () => {
    const PATHS = ['manifest.json', 'tables/project.jsonl', 'tables/unit.jsonl'];
    const download = (tenantId: string, id: string, path: string, at: Date, effects = recorder()) => asTenant(tenantId, (tx) => store.recordDownload(tx, effects, id, path, PATHS, at));

    it('delivers the export once every file of the manifest was downloaded, and not before, whatever the order and however many times', async () => {
      const tenantId = await tenant();
      const job = await ask(tenantId);
      await ready(tenantId, job);
      expect((await download(tenantId, job.id, PATHS[1] as string, hours(1))).status).toBe('Ready');
      expect((await download(tenantId, job.id, PATHS[1] as string, hours(2))).filesDownloaded).toEqual([PATHS[1]]);
      expect((await download(tenantId, job.id, PATHS[2] as string, hours(3))).status).toBe('Ready');
      const effects = recorder();
      const delivered = await download(tenantId, job.id, PATHS[0] as string, hours(4), effects);
      expect(delivered).toMatchObject({ status: 'Delivered' });
      expect(delivered.deliveredAt).toEqual(hours(4));
      expect(effects.audits.map((entry) => entry.action)).toEqual(['tenant.export_delivered']);
      expect(effects.events.map((event) => event.type)).toEqual(['sas.tenant_export.delivered.v1']);
      expect((await download(tenantId, job.id, PATHS[0] as string, hours(5))).status).toBe('Delivered');
      expect((await harness.owner<{ delivered: boolean }>(tenantId, [['select machvon.tenant_export_delivered($1::uuid, null) as delivered', [tenantId]]]))[0]?.delivered).toBe(true);
    });

    it('refuses a path the manifest does not list, an export that is not Ready, and one whose link has ended', async () => {
      const tenantId = await tenant();
      const job = await ask(tenantId);
      await expect(download(tenantId, job.id, PATHS[0] as string, NOW)).rejects.toMatchObject({ code: 'EXPORT_STATE_INVALID', status: 409 });
      await ready(tenantId, job);
      await expect(download(tenantId, job.id, 'tables/other.jsonl', hours(1))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      await expect(download(tenantId, job.id, PATHS[0] as string, hours(71))).resolves.toMatchObject({ status: 'Ready' });
      await expect(download(tenantId, job.id, PATHS[0] as string, hours(72))).rejects.toMatchObject({ code: 'EXPORT_EXPIRED', status: 422 });
      await expect(download(TENANT_B, job.id, PATHS[0] as string, hours(1))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('ends the link of an export nobody delivered: the pass makes it Expired, once, and the tenant is not archivable by it', async () => {
      const tenantId = await tenant();
      const job = await ask(tenantId);
      await ready(tenantId, job);
      const effects = recorder();
      expect(await asTenant(tenantId, (tx) => store.sweep(tx, effects, hours(71)))).toEqual({ expired: [], pending: 0 });
      expect(await asTenant(tenantId, (tx) => store.sweep(tx, effects, hours(72)))).toEqual({ expired: [job.id], pending: 0 });
      expect(await asTenant(tenantId, (tx) => store.sweep(tx, effects, hours(74)))).toEqual({ expired: [], pending: 0 });
      expect(effects.audits.map((entry) => entry.action)).toEqual(['tenant.export_expired']);
      expect((await harness.owner<{ delivered: boolean }>(tenantId, [['select machvon.tenant_export_delivered($1::uuid, null) as delivered', [tenantId]]]))[0]?.delivered).toBe(false);
      const waiting = await ask(tenantId);
      expect((await asTenant(tenantId, (tx) => store.sweep(tx, recorder(), hours(75)))).pending).toBe(1);
      expect(waiting.status).toBe('Requested');
    });
  });

  it('ends as Failed an export that has been running for hours (its process is gone), and the owner can ask again', async () => {
    const tenantId = await tenant();
    const job = await ask(tenantId);
    await asTenant(tenantId, (tx) => store.claim(tx));
    expect((await asTenant(tenantId, (tx) => store.sweep(tx, recorder(), hours(1)))).pending).toBe(1);
    const effects = recorder();
    expect(await asTenant(tenantId, (tx) => store.sweep(tx, effects, hours(3)))).toEqual({ expired: [], pending: 0 });
    expect(await asTenant(tenantId, (tx) => store.find(tx, job.id))).toMatchObject({ status: 'Failed', errorCode: 'Stalled' });
    expect(effects.audits.map((entry) => entry.action)).toEqual(['tenant.export_failed']);
    expect(await asTenant(tenantId, (tx) => store.count(tx))).toBe(1);
    await expect(ask(tenantId)).resolves.toMatchObject({ status: 'Requested' });
    expect(await asTenant(tenantId, (tx) => store.count(tx))).toBe(2);
  });

  it('lists the exports of the tenant, the newest first, a page at a time', async () => {
    const tenantId = await tenant();
    const ids: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const job = await asTenant(tenantId, (tx) => store.request(tx, recorder(), { requestedBy: OWNER, scope: 'FULL', reason: REASON }, hours(n)));
      ids.push(job.id);
      await asTenant(tenantId, (tx) => store.fail(tx, recorder(), job.id, 'Stopped'));
    }
    const first = await asTenant(tenantId, (tx) => store.list(tx, { limit: 2 }));
    expect(first.map((job) => job.id)).toEqual([ids[2], ids[1]]);
    const last = first[1] as ExportJobRow;
    const next = await asTenant(tenantId, (tx) => store.list(tx, { limit: 2, after: { requestedAt: last.requestedAt.toISOString(), id: last.id } }));
    expect(next.map((job) => job.id)).toEqual([ids[0]]);
  });
});
