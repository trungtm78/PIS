import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { LlmRegistryController } from '../../src/modules/llm/registry.controller';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, roleId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

export const SIGNING_KEY = randomBytes(32);

/** Members of tenant A: who registers providers and drafts policies, two who approve, a reader, and two who hold less. */
export const AI_ADMIN = 1; // llm.provider.manage, llm.policy.manage and the reads
export const SECURITY = 2; // activates providers and publishes policies, drafts policies, reads
export const SECURITY_TWO = 3; // the same, another person
export const READER = 4; // reads the registry only
export const NOBODY = 5; // no grant
export const SCOPED = 6; // holds the rights over one unit only: the registry is the tenant's, so it is refused
export const DUAL = 7; // holds the right to register and the right to approve: the rule, not the guard, keeps them apart
export const ROOT = 1;
export const BRANCH = 2;

export interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

export class LlmApp {
  readonly harness = new AuthzHarness();
  app!: RunningApp;

  async start(): Promise<void> {
    const { harness } = this;
    await harness.start();
    const units = [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: BRANCH, path: `/${unitId(BRANCH)}/`, parent: ROOT },
    ];
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, units);
    for (const n of [AI_ADMIN, SECURITY, SECURITY_TWO, READER, NOBODY, SCOPED, DUAL]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, AI_ADMIN, ROOT);
    const MANAGE = ['llm.provider.manage', 'llm.policy.manage', 'llm.provider.read', 'llm.policy.read'];
    const APPROVE = ['llm.provider.approve', 'llm.policy.approve', 'llm.policy.manage', 'llm.provider.read', 'llm.policy.read'];
    await harness.seedRole(TENANT_A, 1, 'AI_ADMIN', MANAGE, 50);
    await harness.seedRole(TENANT_A, 2, 'SECURITY_DPO', APPROVE, 60);
    await harness.seedRole(TENANT_A, 3, 'AI_READER', ['llm.provider.read', 'llm.policy.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'AI_SCOPED', [...MANAGE, ...APPROVE], 40);
    await harness.seedRole(TENANT_A, 5, 'AI_DUAL', [...MANAGE, ...APPROVE], 55);
    await harness.seedRole(TENANT_B, 1, 'AI_ADMIN', MANAGE, 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: AI_ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: SECURITY, role: 2, kind: 'TENANT' },
      { n: 3, member: SECURITY_TWO, role: 2, kind: 'TENANT' },
      { n: 4, member: READER, role: 3, kind: 'TENANT' },
      { n: 5, member: SCOPED, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(BRANCH)] },
      { n: 6, member: DUAL, role: 5, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: AI_ADMIN, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    this.app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [LlmRegistryController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }

  async stop(): Promise<void> {
    if (this.app) await this.app.close();
    await this.harness.stop();
  }

  async call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string; ifMatch?: string }): Promise<Reply> {
    const token = signTenantContext({ tenantId: options.tenantId ?? TENANT_A, membershipId: memberId(options.member), scopeVersion: 1 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${this.app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    return { status: response.status, headers: response.headers, json: (await response.json()) as Record<string, unknown> };
  }

  async rows<T extends Record<string, unknown>>(sql: string, params: unknown[] = [], tenantId: string = TENANT_A): Promise<T[]> {
    return this.harness.owner<T>(tenantId, [[sql, params]]);
  }

  /** Runs statements with the foreign keys and the triggers off, as the fixtures of other modules do. */
  async seedReplica(statements: Array<[string, unknown[]]>): Promise<void> {
    const client = new Client({ connectionString: this.harness.database.adminUrl });
    await client.connect();
    try {
      await client.query('set session_replication_role = replica');
      for (const [sql, params] of statements) await client.query(sql, params);
    } finally {
      await client.end();
    }
  }

  /** Removes the registry of a tenant so that a test starts from nothing. */
  reset(tenantId: string = TENANT_A): Promise<unknown[]> {
    return this.harness.owner(tenantId, [['delete from machvon.ai_model'], ['delete from machvon.ai_provider'], ['delete from machvon.ai_classification_policy_version']]);
  }
}

export { TENANT_A, TENANT_B, memberId, roleId, unitId };
