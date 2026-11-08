import { randomUUID } from 'node:crypto';
import { datasetGate, generateBiPassword, generateClientCredentials, hashClientSecret, scramVerifierOf, verifyClientSecret } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import { BiReaderStore } from '../src/int-bi-reader-store';
import { AccessLogStore, AccessOverviewReads, ExportDatasetStore, MachineAccountStore, OpenReads, liveAccount, lookupClient } from '../src/int-open-api-store';
import { ProjectCodeStore, SourceSystemStore } from '../src/int-project-code-store';
import { runInTransaction } from '../src/tenant-database';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';
import { dropSnapshotFixtureKeys, seedSnapshot } from './support/dgv-quality-fixtures';

const harness = new AuthzHarness();
const systems = new SourceSystemStore();
const codes = new ProjectCodeStore();
const accounts = new MachineAccountStore();
const accessLog = new AccessLogStore();
const datasets = new ExportDatasetStore();
const readers = new BiReaderStore();
const reads = new OpenReads();
const hubReads = new AccessOverviewReads();
const MAKER = 1;
const CHECKER = 2;
const NOW = new Date('2026-11-08T03:00:00Z');
const REASON = 'A reason of ten characters';

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

interface Refusal {
  code: string;
  status: number;
  detail?: string;
  extensions?: Record<string, unknown>;
}

async function refusal(work: Promise<unknown>): Promise<Refusal> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

async function databaseRefusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return String((error as { message?: string }).message);
  }
  throw new Error('expected the database to refuse');
}

async function seedProject(tenant: string, code: string): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, created_by, updated_by)
     values ($1, $2, $3, $3, $4, $5, 'INTERNAL', 1000, 'CONCEPT', 1, $6, $6)`,
    [tenant, id, code, unitId(1), randomUUID(), memberId(MAKER)],
    tenant,
  );
  return id;
}

async function seedProduct(tenant: string, code: string, status: 'CERTIFIED' | 'PROVISIONAL' = 'CERTIFIED', expires = '2027-12-31'): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.data_product (tenant_id, id, code, title, dataset_ids, owner_user_id, certification_status, certified_by, certified_at, certification_expires_on, evidence_refs, created_by, updated_by)
     values ($1, $2, $3, $3, $4::jsonb, $5, $6, $7, now(), $8::date, '["evidence-1"]', $5, $5)`,
    [tenant, id, code, JSON.stringify([randomUUID()]), memberId(MAKER), status, status === 'CERTIFIED' ? memberId(CHECKER) : null, status === 'CERTIFIED' ? expires : null],
    tenant,
  );
  return id;
}

async function seedContractFact(tenant: string, periodSnapshotId: string, periodId: string): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.contract_fact_snapshot (tenant_id, id, period_snapshot_id, period_id, revision, cutoff_date, as_of_date, contract_count, row_count, payload_sha256, built_by)
     values ($1, $2, $3, $4, 1, date '2026-10-31', date '2026-10-31', 1, 1, repeat('b', 64), $5)`,
    [tenant, id, periodSnapshotId, periodId, memberId(MAKER)],
    tenant,
  );
  await owner(
    `insert into machvon.contract_fact_snapshot_line (tenant_id, snapshot_id, period_snapshot_id, contract_id, contractor_id, is_lead, share_pct, project_id, unit_id, contract_status, contract_type,
        contract_value_vnd, active_value_vnd, original_value_vnd, approved_change_delta_vnd, requested_vnd, accepted_vnd, paid_vnd)
     values ($1, $2, $3, $4, $5, true, 100, $6, $7, 'ACTIVE', 'CONSTRUCTION', 5000, 5000, 5000, 0, 100, 100, 100)`,
    [tenant, id, periodSnapshotId, randomUUID(), randomUUID(), randomUUID(), unitId(1)],
    tenant,
  );
  return id;
}

describe('the open interface: systems, codes, machine accounts, certified datasets and BI logins (INT-1)', () => {
  let control: Pool;
  let snapshotA: { id: string; projectIds: string[] };
  let snapshotB: { id: string; projectIds: string[] };
  let periodA: string;
  let periodB: string;
  let productA: string;
  let productB: string;

  beforeAll(async () => {
    await harness.start();
    control = new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 2 });
    control.on('error', () => undefined);
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
      for (const member of [MAKER, CHECKER]) await harness.seedMembership(tenant, member, 1);
    }
    await dropSnapshotFixtureKeys(harness, TENANT_A);
    snapshotA = await seedSnapshot(harness, TENANT_A, MAKER, { lines: [{}, {}] });
    snapshotB = await seedSnapshot(harness, TENANT_B, MAKER, { lines: [{}, {}, {}] });
    periodA = ((await owner<{ period_id: string }>('select period_id from machvon.period_snapshot where id = $1', [snapshotA.id]))[0] as { period_id: string }).period_id;
    periodB = ((await owner<{ period_id: string }>('select period_id from machvon.period_snapshot where id = $1', [snapshotB.id], TENANT_B))[0] as { period_id: string }).period_id;
    await seedContractFact(TENANT_A, snapshotA.id, periodA);
    await seedContractFact(TENANT_B, snapshotB.id, periodB);
    productA = await seedProduct(TENANT_A, 'DP-A');
    productB = await seedProduct(TENANT_B, 'DP-B');
  }, 240_000);

  afterAll(async () => {
    await control?.end();
    await harness.stop();
  }, 60_000);

  describe('the codes of our projects in other systems (on master_crosswalk, no table of external identities)', () => {
    let projectId: string;

    beforeAll(async () => {
      projectId = await seedProject(TENANT_A, 'PRJ-INT-1');
      await seedProject(TENANT_A, 'PRJ-INT-2');
      await as((tx) => systems.register(tx, { code: 'EBS', name: 'Oracle EBS', kind: 'ERP', codePattern: 'P-\\d{3}' }, memberId(MAKER)));
    });

    it('registers a system once and refuses the same code again', async () => {
      const again = await refusal(as((tx) => systems.register(tx, { code: 'EBS', name: 'Other', kind: 'ERP', codePattern: null }, memberId(MAKER))));
      expect([again.code, again.status]).toEqual(['INT_SOURCE_SYSTEM_TAKEN', 409]);
      const rows = await as((tx) => systems.list(tx));
      expect(rows.map((row) => [row.code, row.status, row.activeCodes])).toEqual([['EBS', 'ACTIVE', 0]]);
      // The other tenant sees none of it.
      expect(await as((tx) => systems.list(tx), MAKER, TENANT_B)).toEqual([]);
    });

    it('AC-ST-INT-001-3: proposes a code, refuses the maker as approver, activates it on another person, and keeps the history', async () => {
      const proposed = await as((tx) => codes.propose(tx, { sourceSystem: 'EBS', ourCode: 'PRJ-INT-1', externalCode: 'P-100', validFrom: null, validUntil: null, reason: REASON }, memberId(MAKER), NOW));
      expect(proposed).toMatchObject({ status: 'PROPOSED', projectCode: 'PRJ-INT-1', sourceSystem: 'EBS', externalCode: 'P-100', projectId, version: 1 });
      const self = await refusal(as((tx) => codes.decide(tx, proposed.id, 1, { move: 'APPROVE', reason: REASON }, memberId(MAKER), NOW)));
      expect([self.code, self.status]).toEqual(['SELF_APPROVAL_DENIED', 403]);
      const stale = await refusal(as((tx) => codes.decide(tx, proposed.id, 7, { move: 'APPROVE', reason: REASON }, memberId(CHECKER), NOW), CHECKER));
      expect(stale.code).toBe('VERSION_CONFLICT');
      const approved = await as((tx) => codes.decide(tx, proposed.id, 1, { move: 'APPROVE', reason: REASON }, memberId(CHECKER), NOW), CHECKER);
      expect(approved.row).toMatchObject({ status: 'ACTIVE', approvedBy: memberId(CHECKER), version: 2 });
      const counts = await as((tx) => codes.counts(tx));
      expect(counts).toMatchObject({ PROPOSED: 0, ACTIVE: 1 });
      // The same project cannot hold a second ACTIVE code in the system, and another project cannot take the code.
      const other = await refusal(as((tx) => codes.propose(tx, { sourceSystem: 'EBS', ourCode: 'PRJ-INT-1', externalCode: 'P-101', validFrom: null, validUntil: null, reason: REASON }, memberId(MAKER), NOW)));
      expect([other.code, other.extensions?.reason]).toEqual(['CROSSWALK_DUPLICATE', 'SUBJECT_HAS_OTHER_CODE']);
      const taken = await refusal(as((tx) => codes.propose(tx, { sourceSystem: 'EBS', ourCode: 'PRJ-INT-2', externalCode: 'P-100', validFrom: null, validUntil: null, reason: REASON }, memberId(MAKER), NOW)));
      expect([taken.code, taken.extensions?.reason]).toEqual(['CROSSWALK_DUPLICATE', 'EXTERNAL_CODE_TAKEN']);
      // Retiring ends the code today, and a retired code is final.
      const retired = await as((tx) => codes.decide(tx, proposed.id, 2, { move: 'RETIRE', reason: REASON }, memberId(CHECKER), NOW), CHECKER);
      expect(retired.row).toMatchObject({ status: 'RETIRED', retiredBy: memberId(CHECKER) });
      expect((await refusal(as((tx) => codes.decide(tx, proposed.id, 3, { move: 'APPROVE', reason: REASON }, memberId(CHECKER), NOW), CHECKER))).code).toBe('EGP_MAPPING_STATE_INVALID');
    });

    it('refuses a code that does not fit the system, an unknown system, an unknown project and a system that is retired', async () => {
      const bad = async (request: { sourceSystem: string; ourCode: string; externalCode: string }) =>
        refusal(as((tx) => codes.propose(tx, { ...request, validFrom: null, validUntil: null, reason: REASON }, memberId(MAKER), NOW)));
      expect((await bad({ sourceSystem: 'EBS', ourCode: 'PRJ-INT-2', externalCode: 'X-1' })).detail).toBe('external_code');
      expect((await bad({ sourceSystem: 'NOPE', ourCode: 'PRJ-INT-2', externalCode: 'P-200' })).detail).toBe('source_system');
      expect((await bad({ sourceSystem: 'EBS', ourCode: 'PRJ-NONE', externalCode: 'P-200' })).detail).toBe('our_code');
      const system = (await as((tx) => systems.byCode(tx, 'EBS'))) as { id: string; version: number };
      expect((await as((tx) => systems.retire(tx, system.id, system.version, REASON, memberId(MAKER), NOW))).row.status).toBe('RETIRED');
      expect((await bad({ sourceSystem: 'EBS', ourCode: 'PRJ-INT-2', externalCode: 'P-200' })).detail).toBe('source_system');
      expect((await refusal(as((tx) => systems.retire(tx, system.id, system.version + 1, REASON, memberId(MAKER), NOW)))).code).toBe('INT_SOURCE_SYSTEM_IN_USE');
    });

    it('holds the same rules in the database, whatever the application does', async () => {
      await as((tx) => systems.register(tx, { code: 'PMIS', name: 'PMIS', kind: 'PMIS', codePattern: null }, memberId(MAKER)));
      const insert = (system: string, subjectType: string, code: string): Promise<unknown> =>
        owner(
          `insert into machvon.master_crosswalk (tenant_id, id, master_record_id, subject_type, subject_id, source_system, external_type, external_code, valid_from, match_method, status, created_by, updated_by)
           values ($1, gen_random_uuid(), null, $2, $3, $4, 'PROJECT_CODE', $5, date '2026-11-01', 'MANUAL', 'PROPOSED', $6, $6)`,
          [TENANT_A, subjectType, projectId, system, code, memberId(MAKER)],
        );
      expect(await databaseRefusal(insert('UNREGISTERED', 'PROJECT', 'Z-1'))).toMatch(/not registered/);
      expect(await databaseRefusal(insert('PMIS', 'PACKAGE', 'Z-1'))).toMatch(/code of a project/);
      await insert('PMIS', 'PROJECT', 'FREE-FORM-1');
      expect(await databaseRefusal(owner(`insert into machvon.int_source_system (tenant_id, code, name, kind, created_by, updated_by) values ($1, 'MUASAMCONG', 'x', 'OTHER', $2, $2)`, [TENANT_A, memberId(MAKER)]))).toMatch(/int_source_system_code_chk/);
    });
  });

  describe('machine accounts and their credentials', () => {
    const request = { name: 'Power BI of the ministry', description: null, scopes: ['open.contracts.read', 'open.projects.read'], ratePerMinute: 120, expiresOn: null };
    let accountId: string;
    let firstClientId: string;
    let firstSecret: string;

    it('creates an account with a credential and keeps only the hash of the secret', async () => {
      const made = generateClientCredentials();
      firstClientId = made.clientId;
      firstSecret = made.clientSecret;
      const account = await as((tx) => accounts.create(tx, request, made, memberId(MAKER), NOW));
      accountId = account.id;
      expect(account).toMatchObject({ name: request.name, scopes: request.scopes, ratePerMinute: 120, status: 'ACTIVE', version: 1 });
      expect(account.credentials).toHaveLength(1);
      expect(account.credentials[0]).toMatchObject({ clientId: made.clientId, secretHint: made.secretHint, state: 'ACTIVE' });
      const stored = await owner<{ secret_hash: string }>('select secret_hash from machvon.int_machine_credential where account_id = $1', [accountId]);
      expect(stored[0]?.secret_hash).toBe(hashClientSecret(made.clientSecret));
      expect(JSON.stringify(await owner('select * from machvon.int_machine_credential where account_id = $1', [accountId]))).not.toContain(made.clientSecret);
      expect(JSON.stringify(await owner('select * from machvon.audit_event order by 1 desc limit 20'))).not.toContain(made.clientSecret);
      expect((await refusal(as((tx) => accounts.create(tx, { ...request, name: 'POWER BI of the ministry' }, generateClientCredentials(), memberId(MAKER), NOW)))).code).toBe('OPEN_ACCOUNT_NAME_TAKEN');
    });

    it('is found by its client id across tenants, and only by what the function answers', async () => {
      const found = await runInTransaction(control, undefined, (tx) => lookupClient(tx, firstClientId));
      expect(found).toMatchObject({ tenantId: TENANT_A, accountId, accountStatus: 'ACTIVE', scopes: request.scopes, ratePerMinute: 120, tenantStatus: null });
      expect(verifyClientSecret(firstSecret, found?.secretHash ?? '')).toBe(true);
      expect(verifyClientSecret(`${firstSecret.slice(0, -1)}${firstSecret.endsWith('A') ? 'B' : 'A'}`, found?.secretHash ?? '')).toBe(false);
      expect(await runInTransaction(control, undefined, (tx) => lookupClient(tx, 'mvc_aaaaaaaaaaaaaaaaaaaaaaaaaa'))).toBeUndefined();
      // The application role cannot read the directory or run the lookup: it is the control plane's.
      expect(await databaseRefusal(as((tx) => tx.query('select * from machvon.int_client_directory')))).toMatch(/permission denied/);
      expect(await databaseRefusal(as((tx) => tx.query('select * from machvon.int_client_lookup($1)', [firstClientId])))).toMatch(/permission denied/);
      // After the lookup the setting of the connection is as it was found: nothing leaks to the next user of the connection.
      const setting = await runInTransaction(control, undefined, async (tx) => {
        await lookupClient(tx, firstClientId);
        return tx.query<{ value: string | null }>("select nullif(current_setting('app.tenant_id', true), '') as value");
      });
      expect(setting[0]?.value).toBeNull();
    });

    it('judges the account live on every call: a suspension and a revocation reach a token that is still alive', async () => {
      const credential = (await as((tx) => accounts.find(tx, accountId, NOW)))?.credentials[0] as { id: string };
      expect(await as((tx) => liveAccount(tx, accountId, credential.id, NOW))).toMatchObject({ status: 'ACTIVE', credentialLive: true });
      const suspended = await as((tx) => accounts.decide(tx, accountId, 1, { move: 'SUSPEND', reason: REASON }, memberId(MAKER), NOW));
      expect(suspended.row).toMatchObject({ status: 'SUSPENDED', statusReason: REASON, version: 2 });
      expect(await as((tx) => liveAccount(tx, accountId, credential.id, NOW))).toMatchObject({ status: 'SUSPENDED' });
      expect((await refusal(as((tx) => accounts.rotate(tx, accountId, 2, generateClientCredentials(), 24, memberId(MAKER), NOW)))).code).toBe('OPEN_ACCOUNT_STATE_INVALID');
      await as((tx) => accounts.decide(tx, accountId, 2, { move: 'REACTIVATE', reason: REASON }, memberId(MAKER), NOW));
      expect(await as((tx) => liveAccount(tx, accountId, credential.id, NOW))).toMatchObject({ status: 'ACTIVE' });
    });

    it('rotates with an overlap, keeps at most two live secrets and ends the old one on time', async () => {
      const second = generateClientCredentials();
      const rotated = await as((tx) => accounts.rotate(tx, accountId, 3, second, 24, memberId(MAKER), NOW));
      expect(rotated.row.credentials.map((credential) => credential.state)).toEqual(['ACTIVE', 'RETIRING']);
      const old = rotated.row.credentials[1] as { id: string; expiresAt: string };
      expect(old.expiresAt).toBe('2026-11-09T03:00:00.000Z');
      expect(await as((tx) => liveAccount(tx, accountId, old.id, NOW))).toMatchObject({ credentialLive: true });
      expect(await as((tx) => liveAccount(tx, accountId, old.id, new Date('2026-11-09T03:00:01Z')))).toMatchObject({ credentialLive: false });
      // A second rotation revokes the credential that was still waiting out the first overlap.
      const third = await as((tx) => accounts.rotate(tx, accountId, 4, generateClientCredentials(), 0, memberId(MAKER), NOW));
      expect(third.row.credentials.map((credential) => credential.state).sort()).toEqual(['ACTIVE', 'EXPIRED', 'REVOKED'].sort());
      expect(await as((tx) => liveAccount(tx, accountId, old.id, NOW))).toMatchObject({ credentialLive: false });
      // What a credential is never changes.
      expect(await databaseRefusal(owner('update machvon.int_machine_credential set secret_hash = repeat($2, 64) where account_id = $1', [accountId, 'c']))).toMatch(/keeps its identifier/);
      expect(await databaseRefusal(owner('delete from machvon.int_machine_credential where account_id = $1', [accountId]))).toMatch(/revoked, never deleted/);
    });

    it('revokes for good: every credential ends with the account', async () => {
      const revoked = await as((tx) => accounts.decide(tx, accountId, 5, { move: 'REVOKE', reason: REASON }, memberId(MAKER), NOW));
      expect(revoked.row.status).toBe('REVOKED');
      expect(revoked.row.credentials.every((credential) => credential.state === 'REVOKED' || credential.state === 'EXPIRED')).toBe(true);
      expect((await refusal(as((tx) => accounts.decide(tx, accountId, 6, { move: 'REACTIVATE', reason: REASON }, memberId(MAKER), NOW)))).code).toBe('OPEN_ACCOUNT_STATE_INVALID');
      expect((await refusal(as((tx) => accounts.update(tx, accountId, 6, { ratePerMinute: 5 }, memberId(MAKER), NOW)))).code).toBe('OPEN_ACCOUNT_STATE_INVALID');
      // The name of a revoked account can be used again.
      await as((tx) => accounts.create(tx, request, generateClientCredentials(), memberId(MAKER), NOW));
    });

    it('lists the accounts of the tenant only, newest first, with the counts', async () => {
      const rows = await as((tx) => accounts.list(tx, {}, { limit: 10, after: undefined }, NOW));
      expect(rows).toHaveLength(2);
      expect(await as((tx) => accounts.list(tx, {}, { limit: 10, after: undefined }, NOW), MAKER, TENANT_B)).toEqual([]);
      expect(await as((tx) => accounts.counts(tx))).toEqual({ ACTIVE: 1, SUSPENDED: 0, REVOKED: 1 });
      expect(await as((tx) => accounts.find(tx, accountId, NOW), MAKER, TENANT_B)).toBeUndefined();
      expect(await as((tx) => accounts.list(tx, { status: 'REVOKED' }, { limit: 10, after: undefined }, NOW))).toHaveLength(1);
    });

    it('writes an access log that nobody can change and that names parameters, never values', async () => {
      const credential = ((await as((tx) => accounts.list(tx, { status: 'ACTIVE' }, { limit: 1, after: undefined }, NOW)))[0] as { id: string; credentials: Array<{ id: string }> });
      await as((tx) =>
        accessLog.append(tx, { accountId: credential.id, credentialId: (credential.credentials[0] as { id: string }).id, operation: 'listOpenProjects', scope: 'open.projects.read', path: '/open/v1/projects', queryKeys: ['limit'], outcome: 'OK', status: 200, rowCount: 3, correlationId: 'c-1' }),
      );
      const rows = await as((tx) => accessLog.list(tx, {}, { limit: 10, after: undefined }));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ operation: 'listOpenProjects', outcome: 'OK', status: 200, rowCount: 3, queryKeys: ['limit'], accountName: request.name });
      expect(await as((tx) => accessLog.list(tx, {}, { limit: 10, after: undefined }), MAKER, TENANT_B)).toEqual([]);
      expect(await databaseRefusal(owner("update machvon.int_access_log set outcome = 'OK'"))).toMatch(/append-only/);
      expect(await databaseRefusal(owner('delete from machvon.int_access_log'))).toMatch(/append-only/);
      expect(await databaseRefusal(as((tx) => tx.query("update machvon.int_access_log set status = 500")))).toMatch(/permission denied/);
      expect(await databaseRefusal(owner("insert into machvon.int_access_log (tenant_id, account_id, credential_id, operation, path, outcome, status, correlation_id) values ($1, $2, $3, 'x', '/a?b=1', 'OK', 200, 'c')", [TENANT_A, credential.id, (credential.credentials[0] as { id: string }).id]))).toMatch(/int_access_log_path_chk/);
    });

    it('gives the Integration Hub its read of the access side: accounts with scope, rate limit, last use, credential state, and nothing of another tenant', async () => {
      const view = await as((tx) => hubReads.view(tx, NOW));
      expect(view.connectorCode).toBe('access.open-api');
      expect(view.counts.machineAccounts).toEqual({ ACTIVE: 1, SUSPENDED: 0, REVOKED: 1 });
      const consumers = view.consumers.map((consumer) => [consumer.status, consumer.credentialState, consumer.scopes, consumer.rateLimitPerMinute]);
      expect(consumers).toEqual(expect.arrayContaining([['ACTIVE', 'ACTIVE', request.scopes, 120], ['REVOKED', 'REVOKED', request.scopes, 120]]));
      expect(JSON.stringify(view)).not.toMatch(/secret|mvs_/);
      // A refused call inside the window shows as a reason to look, and a revoked account is not nagged about.
      const active = (await as((tx) => accounts.list(tx, { status: 'ACTIVE' }, { limit: 1, after: undefined }, NOW)))[0] as { id: string; credentials: Array<{ id: string }> };
      await as((tx) => accessLog.append(tx, { accountId: active.id, credentialId: (active.credentials[0] as { id: string }).id, operation: 'listOpenProjects', scope: 'open.projects.read', path: '/open/v1/projects', queryKeys: [], outcome: 'RATE_LIMITED', status: 429, rowCount: null, correlationId: 'c-2' }));
      const later = await as((tx) => hubReads.view(tx, new Date()));
      expect(later.consumers.find((consumer) => consumer.id === active.id)?.attention).toContain('RATE_LIMITED_RECENTLY');
      expect(later.consumers.filter((consumer) => consumer.status === 'REVOKED').every((consumer) => consumer.attention.length === 0)).toBe(true);
      expect((await as((tx) => hubReads.view(tx, NOW), MAKER, TENANT_B)).status).toBe('NO_CONSUMERS');
    });
  });

  describe('the datasets switched on for external readers', () => {
    it('shows both datasets closed until configured, switches one on only for a certified product, and closes it when the certification goes', async () => {
      const first = await as((tx) => datasets.state(tx, NOW));
      expect(first.map((row) => [row.datasetCode, row.enabled, row.version, row.gate])).toEqual([
        ['DS-CTR', false, 1, { open: false, reason: 'DISABLED' }],
        ['DS-DISB', false, 1, { open: false, reason: 'DISABLED' }],
      ]);
      const weak = await seedProduct(TENANT_A, 'DP-WEAK', 'PROVISIONAL');
      const refused = await refusal(as((tx) => datasets.set(tx, 'DS-DISB', 1, { enabled: true, productId: weak, reason: REASON }, memberId(MAKER), NOW)));
      expect([refused.code, refused.status, refused.extensions]).toEqual(['OPEN_DATASET_NOT_CERTIFIED', 422, { reason: 'NOT_CERTIFIED' }]);
      expect((await refusal(as((tx) => datasets.set(tx, 'DS-DISB', 1, { enabled: true, productId: null, reason: REASON }, memberId(MAKER), NOW)))).detail).toBe('product_id');
      expect((await refusal(as((tx) => datasets.set(tx, 'DS-DISB', 1, { enabled: true, productId: randomUUID(), reason: REASON }, memberId(MAKER), NOW)))).detail).toBe('product_id');
      expect((await refusal(as((tx) => datasets.set(tx, 'DS-DISB', 9, { enabled: true, productId: productA, reason: REASON }, memberId(MAKER), NOW)))).code).toBe('VERSION_CONFLICT');
      const on = await as((tx) => datasets.set(tx, 'DS-DISB', 1, { enabled: true, productId: productA, reason: REASON }, memberId(MAKER), NOW));
      expect(on.row).toMatchObject({ enabled: true, version: 2, productCode: 'DP-A', certification: 'CERTIFIED', gate: { open: true } });
      // The state of the kernel gate and the state of the rows agree, also when the certification is revoked or runs out.
      await owner("update machvon.data_product set certification_status = 'REVOKED', revoke_reason = 'Revoked in the test for the gate' where id = $1", [productA]);
      expect((await as((tx) => datasets.state(tx, NOW))).find((row) => row.datasetCode === 'DS-DISB')?.gate).toEqual({ open: false, reason: 'NOT_CERTIFIED' });
      expect(datasetGate({ enabled: true, certification: 'REVOKED', expiresOn: null, today: '2026-11-08' })).toEqual({ open: false, reason: 'NOT_CERTIFIED' });
    });

    it('takes turns: two commands that carry the same version of a dataset do not both succeed', async () => {
      const first = await seedProduct(TENANT_A, 'DP-RACE-1');
      const attempt = (): Promise<{ ok: boolean; code?: string }> =>
        as((tx) => datasets.set(tx, 'DS-CTR', 1, { enabled: true, productId: first, reason: REASON }, memberId(MAKER), NOW)).then(
          () => ({ ok: true }),
          (error: { code?: string }) => ({ ok: false, ...(error.code === undefined ? {} : { code: error.code }) }),
        );
      const results = await Promise.all([attempt(), attempt()]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok).map((result) => result.code)).toEqual(['VERSION_CONFLICT']);
      // Version 1 is taken: the same version again is refused, now that the row exists.
      expect(await refusal(as((tx) => datasets.set(tx, 'DS-CTR', 1, { enabled: false, productId: null, reason: REASON }, memberId(MAKER), NOW)))).toMatchObject({ code: 'VERSION_CONFLICT' });
      await as((tx) => datasets.set(tx, 'DS-CTR', 2, { enabled: false, productId: null, reason: REASON }, memberId(MAKER), NOW));
    });
  });

  describe('the read-only logins of BI tools: one login per tenant, bound by its own name', () => {
    const passwords = new Map<string, string>();
    let readerA: Awaited<ReturnType<BiReaderStore['provision']>>;
    let readerB: Awaited<ReturnType<BiReaderStore['provision']>>;
    const clients: Client[] = [];

    const urlOf = (login: string, password: string): string => {
      const url = new URL(harness.database.urlFor('machvon_app'));
      url.username = login;
      url.password = password;
      return url.toString();
    };

    async function connect(reader: { loginName: string }, password = passwords.get(reader.loginName) as string): Promise<Client> {
      const client = new Client({ connectionString: urlOf(reader.loginName, password) });
      client.on('error', () => undefined);
      await client.connect();
      clients.push(client);
      return client;
    }

    async function provision(tenant: string, name: string): Promise<Awaited<ReturnType<BiReaderStore['provision']>>> {
      const password = generateBiPassword();
      const row = await as((tx) => readers.provision(tx, tenant, { name, tool: 'Power BI', connectionLimit: 5 }, scramVerifierOf(password), memberId(MAKER)), MAKER, tenant);
      passwords.set(row.loginName, password);
      return row;
    }

    beforeAll(async () => {
      // Tenant A switches the contract dataset on too; the product of A was revoked above, so it gets a fresh certified one.
      productA = await seedProduct(TENANT_A, 'DP-A2');
      await owner('delete from machvon.int_export_dataset', []).catch(() => undefined);
      readerA = await provision(TENANT_A, 'Power BI A');
      readerB = await provision(TENANT_B, 'Power BI B');
    });

    afterEach(async () => {
      await Promise.all(clients.splice(0).map((client) => client.end().catch(() => undefined)));
    });

    const rowsOf = async (client: Client, sql: string): Promise<Record<string, unknown>[]> => (await client.query(sql)).rows as Record<string, unknown>[];

    it('makes a login that is not a superuser, bypasses no row-level security and is bound to its tenant', async () => {
      const facts = await owner<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolcanlogin: boolean; rolconnlimit: number; member: boolean }>(
        `select r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin, r.rolconnlimit, pg_has_role(r.rolname, 'machvon_bi_reader', 'member') as member from pg_roles r where r.rolname = $1`,
        [readerA.loginName],
      );
      expect(facts[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: true, rolconnlimit: 5, member: true });
      const group = await owner<{ rolcanlogin: boolean; rolbypassrls: boolean; rolsuper: boolean }>("select rolcanlogin, rolbypassrls, rolsuper from pg_roles where rolname = 'machvon_bi_reader'");
      expect(group[0]).toEqual({ rolcanlogin: false, rolbypassrls: false, rolsuper: false });
      const binding = await owner<{ login_name: string; tenant_id: string; active: boolean }>('select login_name, tenant_id, active from machvon_bi.reader_binding order by login_name');
      expect(binding.map((row) => [row.tenant_id, row.active]).sort()).toEqual([[TENANT_A, true], [TENANT_B, true]].sort());
      expect(readerA.loginName).toMatch(/^machvon_bi_[0-9a-f]{12}$/);
      // The verifier is what PostgreSQL stores: the clear password is nowhere.
      const stored = await owner<{ rolpassword: string }>('select rolpassword from pg_authid where rolname = $1', [readerA.loginName]).catch(() => [{ rolpassword: '' }]);
      expect(JSON.stringify(stored)).not.toContain(passwords.get(readerA.loginName) as string);
    });

    it('lets the application role make logins only through the functions, and only for its own tenant', async () => {
      expect(await databaseRefusal(as((tx) => tx.query('create role machvon_bi_aaaaaaaaaaaa login')))).toMatch(/permission denied/);
      const verifier = scramVerifierOf('x'.repeat(20));
      const call = (tenant: string, login: string, v: string = verifier): Promise<unknown> => as((tx) => tx.query('select machvon_bi.provision_reader($1::uuid, $2::uuid, $3, $4, 3)', [tenant, randomUUID(), login, v]));
      expect(await databaseRefusal(call(TENANT_B, 'machvon_bi_aaaaaaaaaaaa'))).toMatch(/tenant of the transaction only/);
      expect(await databaseRefusal(call(TENANT_A, 'postgres'))).toMatch(/twelve hex characters/);
      expect(await databaseRefusal(call(TENANT_A, 'machvon_bi_aaaaaaaaaaaa', 'plain-password'))).toMatch(/SCRAM-SHA-256 verifier/);
      expect(await databaseRefusal(as((tx) => tx.query('select machvon_bi.retire_reader($1::uuid, $2)', [TENANT_B, readerB.loginName])))).toMatch(/tenant of the transaction only/);
      // Tenant A cannot touch the login of tenant B even with its own tenant named.
      expect(await databaseRefusal(as((tx) => tx.query('select machvon_bi.set_reader_active($1::uuid, $2, false)', [TENANT_A, readerB.loginName])))).toMatch(/no such BI login in this tenant/);
      expect(await databaseRefusal(as((tx) => tx.query('select machvon_bi.rotate_reader_password($1::uuid, $2, $3)', [TENANT_A, readerB.loginName, verifier])))).toMatch(/no such BI login in this tenant/);
    });

    it('reads nothing while the datasets are closed, and says why', async () => {
      const client = await connect(readerA);
      const catalogue = await rowsOf(client, 'select dataset_code, is_open, reason from v_dataset_catalogue order by dataset_code');
      expect(catalogue).toEqual([
        { dataset_code: 'DS-CTR', is_open: false, reason: 'DISABLED' },
        { dataset_code: 'DS-DISB', is_open: false, reason: 'DISABLED' },
      ]);
      expect(await rowsOf(client, 'select * from v_disbursement_lines')).toEqual([]);
      expect(await rowsOf(client, 'select * from v_contract_lines')).toEqual([]);
      // The granted columns of the tables are closed with the dataset: a closed gate is not a thing a login walks around by reading the tables.
      for (const sql of ['select tenant_id, id from machvon.period_snapshot_line', 'select tenant_id, id from machvon.period_snapshot', 'select tenant_id, snapshot_id from machvon.contract_fact_snapshot_line', 'select tenant_id, id from machvon.contract_fact_snapshot']) {
        expect([sql, await rowsOf(client, sql)]).toEqual([sql, []]);
      }
    });

    describe('with both datasets switched on', () => {
      beforeAll(async () => {
        for (const [tenant, product] of [[TENANT_A, productA], [TENANT_B, productB]] as const) {
          await as((tx) => datasets.set(tx, 'DS-DISB', 1, { enabled: true, productId: product, reason: REASON }, memberId(MAKER), NOW), MAKER, tenant);
          await as((tx) => datasets.set(tx, 'DS-CTR', 1, { enabled: true, productId: product, reason: REASON }, memberId(MAKER), NOW), MAKER, tenant);
        }
      });

      it('shows each login the rows of its own tenant and no other', async () => {
        const a = await connect(readerA);
        const b = await connect(readerB);
        const disbA = await rowsOf(a, 'select tenant_id, snapshot_id, line_id from v_disbursement_lines');
        const disbB = await rowsOf(b, 'select tenant_id, snapshot_id, line_id from v_disbursement_lines');
        expect(disbA).toHaveLength(2);
        expect(disbB).toHaveLength(3);
        expect(new Set(disbA.map((row) => row.tenant_id))).toEqual(new Set([TENANT_A]));
        expect(new Set(disbB.map((row) => row.tenant_id))).toEqual(new Set([TENANT_B]));
        expect(new Set(disbA.map((row) => row.snapshot_id))).toEqual(new Set([snapshotA.id]));
        expect(await rowsOf(a, 'select tenant_id from v_contract_lines')).toHaveLength(1);
        const open = await rowsOf(a, 'select dataset_code, is_open, reason from v_dataset_catalogue order by dataset_code');
        expect(open.map((row) => [row.dataset_code, row.is_open, row.reason])).toEqual([['DS-CTR', true, 'OPEN'], ['DS-DISB', true, 'OPEN']]);
      });

      it('AC-ST-INT-001-2 NEGATIVE (R13): a login that sets app.tenant_id to another tenant reads NOTHING, from the views and from the tables', async () => {
        const a = await connect(readerA);
        expect(await rowsOf(a, 'select 1 from v_disbursement_lines')).toHaveLength(2);
        await a.query("select set_config('app.tenant_id', $1, false)", [TENANT_B]);
        expect((await rowsOf(a, "select current_setting('app.tenant_id') as t"))[0]).toEqual({ t: TENANT_B });
        expect(await rowsOf(a, 'select * from v_disbursement_lines')).toEqual([]);
        expect(await rowsOf(a, 'select * from v_contract_lines')).toEqual([]);
        // The granted columns of the tables are bound by the same name: another tenant's rows are not there either.
        expect(await rowsOf(a, 'select tenant_id, id from machvon.period_snapshot_line')).toEqual([]);
        expect(await rowsOf(a, 'select tenant_id, id from machvon.period_snapshot')).toEqual([]);
        expect(await rowsOf(a, 'select tenant_id, snapshot_id from machvon.contract_fact_snapshot_line')).toEqual([]);
        expect(await rowsOf(a, 'select tenant_id, id from machvon.contract_fact_snapshot')).toEqual([]);
        // Unsetting it, or setting it to nonsense, gives nothing either.
        await a.query("select set_config('app.tenant_id', '', false)");
        expect(await rowsOf(a, 'select * from v_disbursement_lines')).toEqual([]);
        await a.query("select set_config('app.tenant_id', 'not-a-uuid', false)");
        expect(await databaseRefusal(a.query('select * from v_disbursement_lines'))).toMatch(/invalid input syntax for type uuid/);
        // Putting its own tenant back (as RESET does) restores its own rows, and still no one else's.
        await a.query('reset app.tenant_id');
        const own = await rowsOf(a, 'select distinct tenant_id from v_disbursement_lines');
        expect(own).toEqual([{ tenant_id: TENANT_A }]);
        // The same from the other side.
        const b = await connect(readerB);
        await b.query("select set_config('app.tenant_id', $1, false)", [TENANT_A]);
        expect(await rowsOf(b, 'select * from v_disbursement_lines')).toEqual([]);
        expect(await rowsOf(b, 'select tenant_id from machvon.period_snapshot_line')).toEqual([]);
      });

      it('reads only certified datasets, nothing else, and cannot write or reach the binding', async () => {
        const a = await connect(readerA);
        for (const sql of [
          'select * from machvon.project',
          'select * from machvon.contract',
          'select * from machvon.audit_event',
          'select * from machvon.int_machine_credential',
          'select * from machvon_bi.reader_binding',
          'select * from machvon.period_snapshot_line',
          'select ctmtqg_subset_vnd from machvon.period_snapshot_line',
          'select payload_sha256 from machvon.period_snapshot',
          'select fact from machvon.contract_fact_snapshot_contract',
        ]) {
          expect(await databaseRefusal(a.query(sql))).toMatch(/permission denied/);
        }
        for (const sql of [
          'insert into machvon_bi.reader_binding (login_name, tenant_id, reader_id) values (\'machvon_bi_000000000000\', gen_random_uuid(), gen_random_uuid())',
          "update machvon.period_snapshot_line set plan_total_vnd = 0",
          'delete from machvon.period_snapshot',
          'create table machvon_bi.mine (a int)',
          'create temp table t as select * from v_disbursement_lines',
          'set role machvon_owner',
          `select machvon_bi.provision_reader('${TENANT_A}', gen_random_uuid(), 'machvon_bi_aaaaaaaaaaaa', 'x', 1)`,
          `select machvon_bi.set_reader_active('${TENANT_A}', '${readerA.loginName}', false)`,
        ]) {
          expect(await databaseRefusal(a.query(sql))).toMatch(/permission denied|read-only|must be owner|cannot/);
        }
      });

      it('answers for its own login only: a login that asks about another one learns nothing', async () => {
        const a = await connect(readerA);
        expect(await rowsOf(a, `select machvon_bi.tenant_of('${readerB.loginName}') as tenant`)).toEqual([{ tenant: null }]);
        expect(await rowsOf(a, `select tenant_id, is_open, reason from machvon_bi.dataset_state('${readerB.loginName}', 'DS-DISB')`)).toEqual([{ tenant_id: null, is_open: false, reason: 'NO_BINDING' }]);
        expect(await rowsOf(a, `select machvon_bi.tenant_of('${readerA.loginName}') as tenant`)).toEqual([{ tenant: TENANT_A }]);
      });

      it('gives the API and the view the same rows for the same tenant', async () => {
        const a = await connect(readerA);
        const view = await rowsOf(a, 'select snapshot_id, line_id from v_disbursement_lines order by snapshot_id, line_id');
        const api = await as((tx) => reads.disbursementLines(tx, {}, { limit: 100, after: undefined }, '2027-12-31'));
        expect(api.items.map((row) => ({ snapshot_id: row.snapshot_id, line_id: row.line_id }))).toEqual(view);
        const viewContracts = await rowsOf(a, 'select snapshot_id, contract_id, contractor_id, paid_vnd::text from v_contract_lines order by 1, 2, 3');
        const apiContracts = await as((tx) => reads.contractLines(tx, {}, { limit: 100, after: undefined }, '2027-12-31'));
        expect(apiContracts.items.map((row) => ({ snapshot_id: row.snapshot_id, contract_id: row.contract_id, contractor_id: row.contractor_id, paid_vnd: row.paid_vnd }))).toEqual(viewContracts);
      });

      it('closes when the certification is revoked or runs out, and reopens when the product is certified again', async () => {
        const a = await connect(readerA);
        expect(await rowsOf(a, 'select 1 from v_disbursement_lines')).toHaveLength(2);
        const direct = 'select tenant_id, id from machvon.period_snapshot_line';
        expect(await rowsOf(a, direct)).toHaveLength(2);
        await owner("update machvon.data_product set certification_expires_on = (now() at time zone 'Asia/Ho_Chi_Minh')::date where id = $1", [productA]);
        expect(await rowsOf(a, 'select 1 from v_disbursement_lines')).toEqual([]);
        expect(await rowsOf(a, direct)).toEqual([]);
        expect((await rowsOf(a, "select reason from v_dataset_catalogue where dataset_code = 'DS-DISB'"))[0]).toEqual({ reason: 'EXPIRED' });
        await owner("update machvon.data_product set certification_expires_on = (now() at time zone 'Asia/Ho_Chi_Minh')::date + 30 where id = $1", [productA]);
        expect(await rowsOf(a, 'select 1 from v_disbursement_lines')).toHaveLength(2);
        expect(await rowsOf(a, direct)).toHaveLength(2);
        await owner("update machvon.data_product set certification_status = 'REVOKED', revoke_reason = 'Revoked in the test for the gate' where id = $1", [productA]);
        expect(await rowsOf(a, 'select 1 from v_disbursement_lines')).toEqual([]);
        expect(await rowsOf(a, direct)).toEqual([]);
        expect(await rowsOf(a, 'select tenant_id, snapshot_id from machvon.contract_fact_snapshot_line')).toEqual([]);
        expect((await rowsOf(a, "select reason from v_dataset_catalogue where dataset_code = 'DS-CTR'"))[0]).toEqual({ reason: 'NOT_CERTIFIED' });
        // The other tenant is not affected by the revocation of this tenant's product.
        expect(await rowsOf(await connect(readerB), 'select 1 from v_disbursement_lines')).toHaveLength(3);
      });

      it('shows only FROZEN snapshots: a superseded one is not read', async () => {
        const b = await connect(readerB);
        expect(await rowsOf(b, 'select 1 from v_disbursement_lines')).toHaveLength(3);
        // A close snapshot that DIS replaced, and a building one: neither leaves the platform.
        await seedSnapshot(harness, TENANT_B, MAKER, { lines: [{}, {}], status: 'SUPERSEDED' });
        await seedSnapshot(harness, TENANT_B, MAKER, { lines: [{}], status: 'BUILDING' });
        expect(await rowsOf(b, 'select 1 from v_disbursement_lines')).toHaveLength(3);
        expect(await rowsOf(b, 'select 1 from v_contract_lines')).toHaveLength(1);
        // The granted columns of the tables show the same frozen snapshots and no other.
        expect(await rowsOf(b, 'select id from machvon.period_snapshot')).toHaveLength(1);
        expect(await rowsOf(b, 'select id from machvon.period_snapshot_line')).toHaveLength(3);
      });
    });

    describe('the life of a login', () => {
      it('parks a login: a session already open reads nothing at once, a new connection is refused, and resuming restores it', async () => {
        const b = await connect(readerB);
        expect(await rowsOf(b, 'select 1 from v_disbursement_lines')).toHaveLength(3);
        const parked = await as((tx) => readers.decide(tx, TENANT_B, readerB.id, 1, { move: 'SUSPEND', reason: REASON }, memberId(MAKER), NOW), MAKER, TENANT_B);
        expect(parked.row).toMatchObject({ status: 'SUSPENDED', statusReason: REASON, version: 2 });
        await expect(connect(readerB)).rejects.toThrow();
        expect(await refusal(as((tx) => readers.decide(tx, TENANT_B, readerB.id, 2, { move: 'SUSPEND', reason: REASON }, memberId(MAKER), NOW), MAKER, TENANT_B))).toMatchObject({ code: 'BI_READER_STATE_INVALID' });
        await as((tx) => readers.decide(tx, TENANT_B, readerB.id, 2, { move: 'REACTIVATE', reason: REASON }, memberId(MAKER), NOW), MAKER, TENANT_B);
        expect(await rowsOf(await connect(readerB), 'select 1 from v_disbursement_lines')).toHaveLength(3);
      });

      it('rotates the password: the old one stops working and the open sessions are cut', async () => {
        const old = passwords.get(readerB.loginName) as string;
        const open = await connect(readerB);
        const next = generateBiPassword();
        const rotated = await as((tx) => readers.rotatePassword(tx, TENANT_B, readerB.id, 3, scramVerifierOf(next), REASON, memberId(MAKER)), MAKER, TENANT_B);
        expect(rotated.version).toBe(4);
        await expect(connect(readerB, old)).rejects.toThrow();
        await expect(open.query('select 1')).rejects.toThrow();
        passwords.set(readerB.loginName, next);
        expect(await rowsOf(await connect(readerB), 'select 1 from v_disbursement_lines')).toHaveLength(3);
        const events = await as((tx) => readers.events(tx, readerB.id, 10), MAKER, TENANT_B);
        expect(events.map((event) => event.action)).toEqual(['PASSWORD_ROTATED', 'REACTIVATED', 'SUSPENDED', 'PROVISIONED']);
        expect(JSON.stringify(events)).not.toContain(next);
      });

      it('retires a login for good: the login is dropped, the binding is gone, and the other tenant is untouched', async () => {
        const retired = await as((tx) => readers.decide(tx, TENANT_B, readerB.id, 4, { move: 'RETIRE', reason: REASON }, memberId(MAKER), NOW), MAKER, TENANT_B);
        expect(retired.row.status).toBe('RETIRED');
        await expect(connect(readerB)).rejects.toThrow();
        expect(await owner('select rolname from pg_roles where rolname = $1', [readerB.loginName])).toEqual([]);
        expect(await owner('select 1 from machvon_bi.reader_binding where login_name = $1', [readerB.loginName])).toEqual([]);
        expect((await refusal(as((tx) => readers.rotatePassword(tx, TENANT_B, readerB.id, 5, scramVerifierOf('y'.repeat(20)), REASON, memberId(MAKER)), MAKER, TENANT_B))).code).toBe('BI_READER_STATE_INVALID');
        expect(await as((tx) => readers.counts(tx), MAKER, TENANT_B)).toEqual({ ACTIVE: 0, SUSPENDED: 0, RETIRED: 1 });
        expect(await rowsOf(await connect(readerA), 'select 1 from v_dataset_catalogue')).toHaveLength(2);
        expect(await as((tx) => readers.list(tx, {}, { limit: 10, after: undefined }), MAKER, TENANT_A)).toHaveLength(1);
        expect(await as((tx) => readers.find(tx, readerB.id), MAKER, TENANT_A)).toBeUndefined();
      });

      it('refuses a verifier that is not one and keeps the history append-only', async () => {
        expect((await refusal(as((tx) => readers.provision(tx, TENANT_A, { name: 'x', tool: null, connectionLimit: 2 }, 'plain', memberId(MAKER))))).detail).toBe('password');
        expect(await databaseRefusal(owner('update machvon.int_bi_reader_event set action = $1', ['RETIRED']))).toMatch(/append-only/);
      });
    });
  });
});
