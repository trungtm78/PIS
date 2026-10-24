import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, signTreasuryCallback } from '@machvon/db';
import type { TreasuryCallbackFields } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';
import { payModule } from '../../src/modules/pay';
import { WEBHOOK_PAYLOADS, WEBHOOK_SECRETS, EnvironmentWebhookSecrets, ObjectWebhookPayloads } from '../../src/notifications/delivery/webhook-support';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedPayWorld } from '../../../../packages/db/test/support/pay-fixtures';
import type { PayWorld } from '../../../../packages/db/test/support/pay-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

export const SIGNING_KEY = randomBytes(32);
export const CALLBACK_SECRET = Buffer.from('treasury-mock-secret');
export const PROVIDER = 'KBNN_MOCK';
export const FAMILY = 0x95;

/** The people of the PAY tests; each holds one set of permissions, over the tenant unless the name says otherwise. */
export const MEMBERS = {
  IMPORTER: 1, // treasury.import, treasury.import.read, treasury_transaction.read
  CONFIRMER: 2, // treasury.confirm_manual, treasury_transaction.read
  BRANCH_IMPORTER: 3, // treasury.import and treasury.import.read over the branch of project A only
  SERVICE: 4, // treasury.callback.receive (the Treasury service principal)
  BRANCH_SERVICE: 5, // treasury.callback.receive over a branch only
  BRANCH_READER: 6, // treasury_transaction.read over the branch of project A
  NOBODY: 7,
  BRANCH_CONFIRMER: 8, // treasury.confirm_manual over the branch of project A
  MAKER: 9, // drafted and sent the payment requests; holds nothing here
  IMPORT_READER: 10, // treasury.import.read over the tenant
  OTHER_IMPORTER: 11, // of tenant B
} as const;
export const ROOT = 1;
export const BRANCH_A = 2;
export const BRANCH_B = 3;

export interface Reply {
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}

export interface CallOptions {
  member: number;
  tenantId?: string;
  body?: unknown;
  key?: string;
}

export const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The running world: embedded PostgreSQL with every migration, the PAY module's controllers, a private object store and the MOCK Treasury's key. */
export class PayApp {
  readonly harness = new AuthzHarness();
  app!: RunningApp;
  files!: FileService;
  worldA!: PayWorld;
  worldB!: PayWorld;
  private root = '';

  tokenOf(member: number, tenantId = TENANT_A): string {
    return signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  }

  async call(method: 'GET' | 'POST', url: string, options: CallOptions): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: this.tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    const response = await fetch(`${this.app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown>, headers: response.headers };
  }

  /** Sends a file to a multipart operation of the application, as a person's browser does. */
  async upload(url: string, member: number, bytes: Uint8Array, options: { name?: string; type?: string; tenantId?: string } = {}): Promise<Reply> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: options.type ?? 'text/csv' }), options.name ?? 'statement.csv');
    const response = await fetch(`${this.app.baseUrl}${url}`, {
      method: 'POST',
      headers: { [TENANT_HEADER]: this.tokenOf(member, options.tenantId), 'idempotency-key': `key-${randomUUID()}` },
      body: form,
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown>, headers: response.headers };
  }

  rows<R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> {
    return this.harness.owner<R>(tenant, [[sql, params]]);
  }

  async count(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<number> {
    return Number((await this.rows<{ n: string }>(sql, params, tenant))[0]?.n);
  }

  /** Stores a file the way the upload pipeline does (purpose `import`, scanned) and returns the id the import names and its SHA-256. */
  async store(bytes: Uint8Array, tenantId = TENANT_A): Promise<{ fileObjectId: string; sha256: string; scan: string }> {
    const stored = await this.files.upload({ tenantId, membershipId: memberId(MEMBERS.IMPORTER), scopeVersion: 1 }, { purpose: 'import', declaredType: 'text/csv', bytes });
    return { fileObjectId: stored.key.split('/').pop() ?? '', sha256: shaOf(bytes), scan: stored.scanStatus };
  }

  /** The body of a Treasury callback, signed by the MOCK Treasury. */
  signedCallback(fields: TreasuryCallbackFields, secret: Buffer = CALLBACK_SECRET): Record<string, unknown> {
    return {
      provider_event_id: fields.providerEventId,
      provider: fields.provider,
      document_no: fields.documentNo,
      document_date: fields.documentDate,
      project_code: fields.projectCode,
      amount_vnd: fields.amountVnd,
      direction: fields.direction,
      confirmed_at: fields.confirmedAt,
      signature: signTreasuryCallback(secret, fields),
    };
  }

  async start(): Promise<void> {
    const { harness } = this;
    await harness.start();
    this.root = await mkdtemp(join(tmpdir(), 'machvon-pay-test-'));
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: BRANCH_A, path: `/${unitId(ROOT)}/${unitId(BRANCH_A)}/`, parent: ROOT },
        { n: BRANCH_B, path: `/${unitId(ROOT)}/${unitId(BRANCH_B)}/`, parent: ROOT },
      ]);
    }
    for (const n of Object.values(MEMBERS)) if (n !== MEMBERS.OTHER_IMPORTER) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, MEMBERS.OTHER_IMPORTER, ROOT);
    const roles: Array<[number, string, string[]]> = [
      [1, 'TREASURY_IMPORTER', ['treasury.import', 'treasury.import.read', 'treasury_transaction.read']],
      [2, 'TREASURY_CONFIRMER', ['treasury.confirm_manual', 'treasury_transaction.read']],
      [3, 'TREASURY_SERVICE', ['treasury.callback.receive']],
      [4, 'TREASURY_READER', ['treasury_transaction.read']],
      [5, 'TREASURY_CONFIRMER_ONLY', ['treasury.confirm_manual']],
      [6, 'IMPORT_READER', ['treasury.import.read']],
    ];
    for (const [n, code, permissions] of roles) await harness.seedRole(TENANT_A, n, code, permissions, 30);
    await harness.seedRole(TENANT_B, 1, 'TREASURY_IMPORTER', ['treasury.import', 'treasury.import.read', 'treasury_transaction.read'], 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MEMBERS.IMPORTER, role: 1, kind: 'TENANT' },
      { n: 2, member: MEMBERS.CONFIRMER, role: 2, kind: 'TENANT' },
      { n: 3, member: MEMBERS.BRANCH_IMPORTER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(BRANCH_A)] },
      { n: 4, member: MEMBERS.SERVICE, role: 3, kind: 'TENANT' },
      { n: 5, member: MEMBERS.BRANCH_SERVICE, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(BRANCH_A)] },
      { n: 6, member: MEMBERS.BRANCH_READER, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(BRANCH_A)] },
      { n: 7, member: MEMBERS.BRANCH_CONFIRMER, role: 5, kind: 'UNIT_SUBTREE', refs: [unitId(BRANCH_A)] },
      { n: 8, member: MEMBERS.IMPORT_READER, role: 6, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: MEMBERS.OTHER_IMPORTER, role: 1, kind: 'TENANT' }]);
    this.worldA = await seedPayWorld(harness.database.adminUrl, TENANT_A, FAMILY, MEMBERS.MAKER, BRANCH_A, BRANCH_B);
    this.worldB = await seedPayWorld(harness.database.adminUrl, TENANT_B, FAMILY, MEMBERS.OTHER_IMPORTER, BRANCH_A, BRANCH_B);
    const tenants = harness.tenants as TenantDatabase;
    this.files = new FileService({ storage: new FsObjectStorage(this.root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    this.app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [...payModule.controllers],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: this.files },
        { provide: WEBHOOK_SECRETS, useValue: new EnvironmentWebhookSecrets({ MACHVON_SECRET_PAY_TREASURY_KBNN_MOCK: `mock-1:${CALLBACK_SECRET.toString('utf8')}` }) },
        { provide: WEBHOOK_PAYLOADS, useValue: new ObjectWebhookPayloads(new FsObjectStorage(this.root)) },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }

  async stop(): Promise<void> {
    if (this.app) await this.app.close();
    await this.harness.stop();
    if (this.root !== '') await rm(this.root, { recursive: true, force: true });
  }
}
