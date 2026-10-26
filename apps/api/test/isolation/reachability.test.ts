import { randomBytes } from 'node:crypto';
import { ControlDatabase, EffectiveAccessStore, EntitlementStore, InMemoryAuthzCache, InMemoryEntitlementCache, TenantDatabase } from '@machvon/db';
import type { TestDatabase } from '@machvon/db/src/test-database';
import { loadErrorRegistry } from '@machvon/kernel';
import { listOperations } from '@machvon/contracts';
import { Pool } from 'pg';
import { AppModule } from '../../src/app.module';
import { DOCUMENT_FILE_PORT } from '../../src/modules/doc/file-port';
import type { DocumentFilePort } from '../../src/modules/doc/file-port';
import { FileService } from '../../src/modules/files';
import type { ObjectStoragePort } from '@machvon/kernel';
import { FOREIGN_ATTEMPT_SPECS, attempt, createApiChannel, tokenFor } from './channels/api';
import type { ForeignAttemptSpec } from './channels/api';
import { DOCUMENT_FIXTURES, HOUSEHOLD_FIXTURES, MASTER_IMPORT_FIXTURES, PROJECT_FIXTURES, TENANT_IDS, TENANT_NAMES, UNIT_FIXTURES, runIsolationSuite } from './suite';
import type { ForeignAttempt, IsolationChannel } from './suite';
import { TENANT_HEADER } from './test-auth.guard';
import { ERROR_CODES_PATH, loadOpenApi, startIsolationDatabase, startTestApp } from './test-app';
import type { RunningApp } from './test-app';

const SIGNING_KEY = randomBytes(32);

/**
 * The isolation suite wants a 404 from every foreign-id case. A 404 proves nothing when the object the case names does not exist at
 * all (a fixture that was never seeded, an id of the wrong kind, a route that is not the one of the operation): the handler would
 * answer 404 whoever asks. This control sends the same request as the OWNER of the object. It must reach a handler that finds the
 * object, so the answer is anything but 404 (200, 409, 422, 403 on a rule are all fine) and never a server error.
 */
describe('the foreign-id cases of the isolation suite reach an object that exists (ST-KERNEL-026 control)', () => {
  const doc = loadOpenApi();
  const registry = loadErrorRegistry(ERROR_CODES_PATH);
  const pools: Pool[] = [];
  let database: TestDatabase;
  let app: RunningApp;
  let ownerUrl: string;

  beforeAll(async () => {
    database = await startIsolationDatabase();
    ownerUrl = database.urlFor('machvon_owner');
    const pool = (url: string): Pool => {
      const created = new Pool({ connectionString: url, max: 3 });
      pools.push(created);
      return created;
    };
    const tenantDatabase = new TenantDatabase(pool(database.urlFor('machvon_app')));
    const entitlements = {
      store: new EntitlementStore(tenantDatabase, new InMemoryEntitlementCache()),
      control: new ControlDatabase(pool(database.urlFor('machvon_control'))),
    };
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        AppModule.register({
          database: tenantDatabase,
          registry,
          policy: { database: tenantDatabase, access: new EffectiveAccessStore(tenantDatabase, new InMemoryAuthzCache()) },
          entitlements,
        }),
      ],
    });
    const channel = createApiChannel({ baseUrl: app.baseUrl, signingKey: SIGNING_KEY, ownerUrl, doc });
    for (const tenant of TENANT_NAMES) await channel.seed(tenant);
    // The fixture rows name stored files; the commands that read the file after finding the row answer 404 to anyone while the file is missing.
    await app.get<DocumentFilePort>(DOCUMENT_FILE_PORT).put(DOCUMENT_FIXTURES['TNT-B'].objectKey, Buffer.from('%PDF-1.4\n%%EOF\n'), 'application/pdf');
    const files = app.get<FileService>(FileService);
    const storage = (files as unknown as { storage: ObjectStoragePort }).storage;
    const owner = { tenantId: TENANT_IDS['TNT-B'], membershipId: '00000000-0000-4000-8000-000000000001', scopeVersion: 1 };
    await storage.put(owner, MASTER_IMPORT_FIXTURES['TNT-B'].fileObjectKey, Buffer.from('code,name\nB1,Beta\n'), { contentType: 'text/csv' });
    await files.scan(owner, MASTER_IMPORT_FIXTURES['TNT-B'].fileObjectKey);
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    await Promise.all(pools.map((pool) => pool.end()));
    if (database) await database.stop();
  }, 60_000);

  // The case aims at TNT-B, and names a unit of TNT-A as the new parent (which is what makes it a real attempt for the TNT-A user). Its owner moves it under its own unit.
  const ownersVersion = (spec: ForeignAttemptSpec): ForeignAttemptSpec =>
    spec.operation === 'moveOrganizationUnit'
      ? { ...spec, body: { ...(spec.body as Record<string, unknown>), new_parent_id: UNIT_FIXTURES['TNT-B'][1]?.id } }
      : spec;

  // A case that expects 403 or 404 for a control-plane operation is refused by plane whoever asks: it has nothing to reach.
  const reachable = FOREIGN_ATTEMPT_SPECS.filter((spec) => spec.expectedStatuses === undefined);

  it('has cases to run', () => {
    expect(reachable.length).toBeGreaterThan(50);
  });

  // Reads that are not a list of rows of the tenant: the published theme answers 403 to a tenant that has none, and the global search needs a text (its own channel
  // of the isolation suite reads it).
  // The reads of the caller's own access, entitlements and notification preferences answer one object, not a page of rows: they are read for leaks like the others. The preferences hold an `items` list that is empty for a person who never saved.
  const LISTS_WITHOUT_ROWS: string[] = ['getAuditOverview', 'getMyEffectiveAccess', 'getMyEntitlements', 'getMyNotificationPreferences', 'getMyUsage'];
  // The capital available on a line or an appropriation names what it reads in its query (the line or the appropriation): it is not a list.
  const NOT_PLAIN_LISTS: ReadonlySet<string> = new Set(['getMyPublishedTheme', 'searchGlobal', 'getCapitalAvailability', 'getPaymentChain']);

  // The isolation suite reads one list (the organization units) as the other tenant. Every other list read is a place where a missing tenant
  // predicate would show the rows of another tenant, so each one is read here as TNT-A, and what comes back is judged by the markers of TNT-B.
  const listReads = (): string[] => {
    const plain = listOperations(doc).filter((entry) => entry.method === 'get' && !entry.path.includes('{') && app.implementedOperations.has(entry.id) && !NOT_PLAIN_LISTS.has(entry.id));
    return plain.map((entry) => entry.id).sort();
  };
  const pathOf = (operationId: string): string => listOperations(doc).find((entry) => entry.id === operationId)?.path ?? '';
  // The lists of a project name the project they read: both tenants read the project of TNT-B, so TNT-A must meet none of its rows and TNT-B all of them.
  const PROJECT_LISTS: ReadonlySet<string> = new Set(['listLandParcels', 'listLandSections', 'listAffectedHouseholds', 'listCompensationPlans', 'listUpcomingLandDeadlines', 'listLandComplaints']);
  // The list of the records of a household names the household it reads.
  const HOUSEHOLD_LISTS: ReadonlySet<string> = new Set(['listInventoryRecords']);
  const readAs = async (tenant: 'TNT-A' | 'TNT-B', operationId: string): Promise<{ status: number; body: string }> => {
    const project = PROJECT_LISTS.has(operationId) ? `&project_id=${PROJECT_FIXTURES['TNT-B'].id}` : HOUSEHOLD_LISTS.has(operationId) ? `&household_id=${HOUSEHOLD_FIXTURES['TNT-B'].id}` : '';
    const response = await fetch(`${app.baseUrl}${pathOf(operationId)}?limit=200${project}`, { headers: { [TENANT_HEADER]: tokenFor(tenant, SIGNING_KEY) } });
    return { status: response.status, body: await response.text() };
  };

  it('reads every list of the application as the other tenant without meeting a row of TNT-B (and the lists have rows to meet)', async () => {
    const operations = listReads();
    expect(operations.length).toBeGreaterThan(30);
    const foreignAttempts = async (): Promise<ForeignAttempt[]> =>
      Promise.all(operations.map(async (operation) => ({ operation, ...(await readAs('TNT-A', operation)), expectedStatuses: [200] })));
    const channel: IsolationChannel = {
      name: 'lists',
      seed: () => Promise.resolve(),
      readAs: () => Promise.resolve({ status: 404, body: '{}' }),
      foreignAttempts,
    };
    const report = await runIsolationSuite({ channels: [channel], idBearingOperations: [], foreignIdCases: new Set() });
    expect(report).toEqual({ ok: true, leaks: [], uncoveredOperations: [] });

    // The same reads as the owner of the rows: a list that is empty for everyone proves nothing, so the lists that answer rows are counted
    // and must be most of them (the rest are lists of things the fixtures do not hold, named here so that a new one is noticed).
    const empty: string[] = [];
    for (const operation of operations) {
      const answer = await readAs('TNT-B', operation);
      expect([operation, answer.status]).toEqual([operation, 200]);
      const items = (JSON.parse(answer.body) as { items?: unknown[] }).items;
      if (!Array.isArray(items) || items.length === 0) empty.push(operation);
    }
    expect(empty).toEqual(LISTS_WITHOUT_ROWS);
  }, 120_000);

  // These cases find a row and then read a stored file. The isolation suite seeds the rows only: with no file behind them the answer is 404
  // whoever asks, so a lookup that leaked would go unseen. With the files in place the 404 can only come from the lookup.
  const FILE_BACKED = ['getDocumentVersionDownload', 'verifyDocumentSignatures', 'getDocumentSignatureReport', 'applyMasterImport'];

  it('still answers 404 to another tenant for the cases that read a stored file, when the file of the object exists', async () => {
    const options = { baseUrl: app.baseUrl, signingKey: SIGNING_KEY, ownerUrl, doc };
    const specs = FOREIGN_ATTEMPT_SPECS.filter((spec) => FILE_BACKED.includes(spec.operation));
    expect(specs.map((spec) => spec.operation).sort()).toEqual([...FILE_BACKED].sort());
    for (const spec of specs) {
      const answer = await attempt(options, spec, 'TNT-A');
      expect({ operation: spec.operation, status: answer.status }).toEqual({ operation: spec.operation, status: 404 });
      expect(answer.body).not.toContain(DOCUMENT_FIXTURES['TNT-B'].objectKey);
    }
  }, 60_000);

  it('finds, for the owner of the object, the object that every foreign-id case names', async () => {
    const options = { baseUrl: app.baseUrl, signingKey: SIGNING_KEY, ownerUrl, doc };
    const unreachable: string[] = [];
    // One after the other: a command of the owner may change the object the next case names.
    for (const spec of reachable) {
      const answer = await attempt(options, ownersVersion(spec), 'TNT-B');
      if (answer.status === 404) unreachable.push(`${spec.operation} answered ${answer.status} to the owner of ${spec.id}: ${answer.body.slice(0, 160)}`);
    }
    expect(unreachable).toEqual([]);
  }, 120_000);
});
