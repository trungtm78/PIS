import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { ControlDatabase, EffectiveAccessStore, EntitlementStore, InMemoryAuthzCache, InMemoryEntitlementCache } from '@machvon/db';
import type { TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { AppModule } from '../../src/app.module';
import { LocalTenantTokenIssuer, issuerKeyFromPem } from '../../src/auth/tenant-token-issuer';
import { FileService } from '../../src/modules/files';
import { loadEditionManifest, loadEditionModules } from '../../src/editions/load-edition';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';
import { callerOf } from './uat-kit';
import type { CallOptions, Reply } from './uat-kit';

/**
 * The world a UAT suite of the enterprise areas runs in: the whole enterprise edition (the application the stack serves) over a real database, the test stand-in for authentication, and the people of
 * a persona table. Each persona holds one role with the permissions the suite names, over the whole tenant. A suite names its personas, starts the world once and ends it once.
 */
export const ROOT_UNIT = 1;

export interface PersonaTable {
  [persona: string]: readonly string[];
}

export class UatWorld {
  readonly harness = new AuthzHarness();
  readonly signingKey = randomBytes(32);
  app!: RunningApp;
  private controlPool!: Pool;
  private objectRoot = '';
  private outboxRoot = '';
  private readonly members = new Map<string, number>();
  private readonly call = callerOf(() => this.app.baseUrl, this.signingKey);
  private savedEnvironment: Record<string, string | undefined> = {};

  /** The membership number of a persona (the first persona is member 1). */
  member(persona: string): number {
    const found = this.members.get(persona);
    if (found === undefined) throw new Error(`no persona ${persona}`);
    return found;
  }

  /** `seed` runs after the people exist and before the application starts: the data a suite needs that no command of the area makes (a calendar, a project). */
  async start(personas: PersonaTable, tenantBPersonas: PersonaTable = {}, seed?: (world: UatWorld) => Promise<void>): Promise<void> {
    this.objectRoot = await mkdtemp(join(tmpdir(), 'machvon-uat-objects-'));
    this.outboxRoot = await mkdtemp(join(tmpdir(), 'machvon-uat-hpm-'));
    this.savedEnvironment = { MACHVON_OBJECT_ROOT: process.env.MACHVON_OBJECT_ROOT, MACHVON_HPM_OUTBOX_DIR: process.env.MACHVON_HPM_OUTBOX_DIR, MACHVON_EDITION: process.env.MACHVON_EDITION };
    // The edition the process serves: the funding pack of the controllers (the enterprise snapshot is a route of the enterprise pack only) is read from it, as the stack and the server read it.
    process.env.MACHVON_EDITION = 'enterprise';
    process.env.MACHVON_OBJECT_ROOT = this.objectRoot;
    process.env.MACHVON_HPM_OUTBOX_DIR = this.outboxRoot;
    await this.harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await this.harness.seedUnits(tenant, [{ n: ROOT_UNIT, path: `/${unitId(ROOT_UNIT)}/` }]);
    for (const [tenant, table] of [[TENANT_A, personas], [TENANT_B, tenantBPersonas]] as const) {
      const grants: Array<{ n: number; member: number; role: number; kind: 'TENANT' }> = [];
      let number = 0;
      for (const [persona, permissions] of Object.entries(table)) {
        number += 1;
        if (tenant === TENANT_A) this.members.set(persona, number);
        await this.harness.seedMembership(tenant, number, ROOT_UNIT);
        await this.harness.seedRole(tenant, number, persona.toUpperCase().replace(/[^A-Z0-9]+/g, '_'), permissions, 10 + (number % 80));
        grants.push({ n: number, member: number, role: number, kind: 'TENANT' });
      }
      await this.harness.seedGrants(tenant, grants);
    }
    if (seed !== undefined) await seed(this);
    this.controlPool = new Pool({ connectionString: this.harness.database.urlFor('machvon_control'), max: 2 });
    this.controlPool.on('error', () => undefined);
    const tenants = this.harness.tenants as TenantDatabase;
    this.app = await startTestApp({
      signingKey: this.signingKey,
      imports: [
        AppModule.register({
          database: tenants,
          registry: loadErrorRegistry(ERROR_CODES_PATH),
          policy: { database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) },
          // The control plane the machine accounts of the open API are looked up in.
          entitlements: { store: new EntitlementStore(tenants, new InMemoryEntitlementCache()), control: new ControlDatabase(this.controlPool) },
          // The token of the open API is signed by a key of this run, as the issuer of the application signs it.
          openApiSigner: new LocalTenantTokenIssuer({ issuer: 'https://api.test', signingKey: issuerKeyFromPem(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'uat-key') }),
          edition: await loadEditionManifest('enterprise'),
          editionModules: await loadEditionModules('enterprise'),
        }),
      ],
    });
  }

  async stop(): Promise<void> {
    if (this.app) await this.app.close();
    await this.controlPool?.end();
    await this.harness.stop();
    for (const [name, value] of Object.entries(this.savedEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const root of [this.objectRoot, this.outboxRoot]) if (root !== '') await rm(root, { recursive: true, force: true });
  }

  /** A request as a persona of tenant A makes it; `tenantId` makes it as the same number of tenant B. */
  as(persona: string, method: string, url: string, options: Omit<CallOptions, 'member'> = {}): Promise<Reply> {
    return this.call(method, url, { ...options, member: this.member(persona) });
  }

  /** A request as member `member` of tenant B. */
  asTenantB(member: number, method: string, url: string, options: Omit<CallOptions, 'member' | 'tenantId'> = {}): Promise<Reply> {
    return this.call(method, url, { ...options, member, tenantId: TENANT_B });
  }

  /** Rows of the database of tenant A, read as its owner with the tenant set. */
  rows<R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> {
    return this.harness.owner<R>(tenant, [[sql, params]]);
  }

  audits(resourceId: string, action: string): Promise<Array<{ actor_id: string; reason: string | null; safe_diff: Record<string, unknown> }>> {
    return this.rows('select actor_id, reason, safe_diff from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at', [resourceId, action]);
  }

  events(aggregateId: string, type: string): Promise<Array<{ payload: Record<string, unknown> }>> {
    return this.rows('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at', [aggregateId, type]);
  }

  /** Writes rows the commands of the area do not make, as a superuser with the triggers and foreign keys off (a project with its treasury payments, a calendar). */
  async seedAsAdmin(statements: ReadonlyArray<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: this.harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** A file through the shared upload pipeline, as the door of an import or an issued report leaves it: the key to name and the hash to state. */
  async store(bytes: Uint8Array, purpose: 'import' | 'report_export', declaredType: string, persona: string): Promise<{ key: string; sha: string }> {
    const stored = await this.get<FileService>(FileService).upload({ tenantId: TENANT_A, membershipId: this.idOf(persona), scopeVersion: 1 }, { purpose, declaredType, bytes });
    if (stored.scanStatus !== 'CLEAN') throw new Error('the file was not clean');
    return { key: stored.key, sha: createHash('sha256').update(bytes).digest('hex') };
  }

  /** The upload door of an import: a multipart request with the file, as the browser sends it. */
  async door(persona: string, path: string, bytes: Uint8Array, type: string, name: string): Promise<Reply> {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), name);
    const token = signTenantContext({ tenantId: TENANT_A, membershipId: this.idOf(persona), scopeVersion: 1 }, this.signingKey);
    const response = await fetch(`${this.app.baseUrl}${path}`, { method: 'POST', headers: { [TENANT_HEADER]: token, 'idempotency-key': `uat-${randomUUID()}` }, body: form });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  get<T>(token: unknown): T {
    return this.app.get<T>(token);
  }

  /** The id of a member of tenant A, for a column that names a person. */
  idOf(persona: string): string {
    return memberId(this.member(persona));
  }
}
