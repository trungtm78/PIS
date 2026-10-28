import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { LlmEvalController } from '../../src/modules/llm/eval.controller';
import { LlmFinopsController } from '../../src/modules/llm/finops.controller';
import { LlmGatewayController } from '../../src/modules/llm/gateway.controller';
import { LlmGatewayService } from '../../src/modules/llm/gateway.service';
import { MockAiGateway } from '../../src/modules/llm/mock-gateway';
import { LlmKeyController } from '../../src/modules/llm/key.controller';
import { MockEvalRunner } from '../../src/modules/llm/mock-eval-runner';
import { InMemoryVault, MockLiteLlm } from '../../src/modules/llm/mock-key-ports';
import { LlmRegistryController } from '../../src/modules/llm/registry.controller';
import { LLM_ADMIN, LLM_EVAL_RUNNER, LLM_GATEWAY, LLM_METRICS, LLM_VAULT } from '../../src/modules/llm/tokens';
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
export const KEY_ADMIN = 8; // makes, rotates and revokes the virtual keys, and lists them
export const KEY_READER = 9; // lists the keys only
export const FINOPS = 10; // sets the budgets and the prices, reads the spend and the reservations
export const PROMPT_AUTHOR = 11; // drafts prompts, datasets and profiles, and starts evaluations
export const PROMPT_APPROVER = 12; // approves prompts
export const EXPERT = 13; // signs evaluations
export const PUBLISHER = 14; // publishes profiles
export const EVAL_BOTH = 15; // starts and signs evaluations: the rule, not the guard, keeps the two apart
export const INVOKER = 16; // asks the gateway for an answer
export const AUDITOR = 17; // reads how requests were routed and the attempts
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
  readonly litellm = new MockLiteLlm();
  readonly vault = new InMemoryVault();
  readonly runner = new MockEvalRunner();
  readonly gateway = new MockAiGateway();
  readonly metrics: Array<{ name: string; labels: Record<string, string> }> = [];

  async start(): Promise<void> {
    const { harness } = this;
    await harness.start();
    const units = [
      { n: ROOT, path: `/${unitId(ROOT)}/` },
      { n: BRANCH, path: `/${unitId(BRANCH)}/`, parent: ROOT },
    ];
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, units);
    for (const n of [AI_ADMIN, SECURITY, SECURITY_TWO, READER, NOBODY, SCOPED, DUAL, KEY_ADMIN, KEY_READER, FINOPS, PROMPT_AUTHOR, PROMPT_APPROVER, EXPERT, PUBLISHER, EVAL_BOTH, INVOKER, AUDITOR]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, AI_ADMIN, ROOT);
    const MANAGE = ['llm.provider.manage', 'llm.policy.manage', 'llm.provider.read', 'llm.policy.read'];
    const APPROVE = ['llm.provider.approve', 'llm.policy.approve', 'llm.policy.manage', 'llm.provider.read', 'llm.policy.read'];
    await harness.seedRole(TENANT_A, 1, 'AI_ADMIN', MANAGE, 50);
    await harness.seedRole(TENANT_A, 2, 'SECURITY_DPO', APPROVE, 60);
    await harness.seedRole(TENANT_A, 3, 'AI_READER', ['llm.provider.read', 'llm.policy.read'], 20);
    await harness.seedRole(TENANT_A, 4, 'AI_SCOPED', [...MANAGE, ...APPROVE], 40);
    await harness.seedRole(TENANT_A, 5, 'AI_DUAL', [...MANAGE, ...APPROVE], 55);
    await harness.seedRole(TENANT_A, 6, 'AI_KEY_ADMIN', ['llm.key.manage', 'llm.key.read'], 50);
    await harness.seedRole(TENANT_A, 7, 'AI_KEY_READER', ['llm.key.read'], 20);
    await harness.seedRole(TENANT_A, 8, 'AI_FINOPS', ['llm.finops', 'budget_reservation.read', 'llm.provider.read'], 50);
    const EVAL_READS = ['llm.prompt.read', 'llm.eval.read', 'model_profile_version.read', 'ai_eval_run.read', 'llm.provider.read'];
    await harness.seedRole(TENANT_A, 9, 'AI_PROMPT_AUTHOR', ['llm.prompt.manage', 'llm.eval.manage', 'llm.profile.manage', ...EVAL_READS], 50);
    await harness.seedRole(TENANT_A, 10, 'AI_PROMPT_APPROVER', ['llm.prompt.approve', ...EVAL_READS], 50);
    await harness.seedRole(TENANT_A, 11, 'AI_EXPERT', ['llm.eval.sign', ...EVAL_READS], 50);
    await harness.seedRole(TENANT_A, 12, 'AI_PUBLISHER', ['llm.publish', ...EVAL_READS], 50);
    await harness.seedRole(TENANT_A, 14, 'AI_INVOKER', ['ai.invoke'], 30);
    await harness.seedRole(TENANT_A, 15, 'AI_AUDITOR', ['llm.audit.read', 'llm_attempt.read'], 30);
    await harness.seedRole(TENANT_A, 13, 'AI_EVAL_BOTH', ['llm.eval.manage', 'llm.eval.sign', ...EVAL_READS], 50);
    await harness.seedRole(TENANT_B, 1, 'AI_ADMIN', [...MANAGE, 'llm.key.manage', 'llm.key.read', 'llm.finops', 'budget_reservation.read'], 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: AI_ADMIN, role: 1, kind: 'TENANT' },
      { n: 2, member: SECURITY, role: 2, kind: 'TENANT' },
      { n: 3, member: SECURITY_TWO, role: 2, kind: 'TENANT' },
      { n: 4, member: READER, role: 3, kind: 'TENANT' },
      { n: 5, member: SCOPED, role: 4, kind: 'UNIT_SUBTREE', refs: [unitId(BRANCH)] },
      { n: 6, member: DUAL, role: 5, kind: 'TENANT' },
      { n: 7, member: KEY_ADMIN, role: 6, kind: 'TENANT' },
      { n: 8, member: KEY_READER, role: 7, kind: 'TENANT' },
      { n: 9, member: FINOPS, role: 8, kind: 'TENANT' },
      { n: 10, member: PROMPT_AUTHOR, role: 9, kind: 'TENANT' },
      { n: 11, member: PROMPT_APPROVER, role: 10, kind: 'TENANT' },
      { n: 12, member: EXPERT, role: 11, kind: 'TENANT' },
      { n: 13, member: PUBLISHER, role: 12, kind: 'TENANT' },
      { n: 14, member: EVAL_BOTH, role: 13, kind: 'TENANT' },
      { n: 15, member: INVOKER, role: 14, kind: 'TENANT' },
      { n: 16, member: AUDITOR, role: 15, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: AI_ADMIN, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    this.app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [LlmRegistryController, LlmKeyController, LlmFinopsController, LlmEvalController, LlmGatewayController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: LLM_ADMIN, useValue: this.litellm },
        { provide: LLM_VAULT, useValue: this.vault },
        { provide: LLM_EVAL_RUNNER, useValue: this.runner },
        { provide: LLM_GATEWAY, useValue: this.gateway },
        { provide: LLM_METRICS, useValue: { gauge: () => undefined, increment: (name: string, labels: Record<string, string> = {}) => this.metrics.push({ name, labels }) } },
        LlmGatewayService,
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }

  async stop(): Promise<void> {
    if (this.app) await this.app.close();
    await this.harness.stop();
  }

  async call(method: 'GET' | 'POST' | 'PUT', url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string; ifMatch?: string }): Promise<Reply> {
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
    return this.harness.owner(tenantId, [['delete from machvon.llm_attempt'], ['update machvon.ai_request set budget_reservation_id = null'], ['delete from machvon.budget_reservation'], ['delete from machvon.ai_request'], ['delete from machvon.ai_eval_run'], ['delete from machvon.model_profile_version'], ['delete from machvon.ai_eval_case'], ['delete from machvon.ai_eval_dataset_version'], ['delete from machvon.ai_prompt_version'], ['delete from machvon.ai_virtual_key'], ['delete from machvon.ai_budget_counter'], ['delete from machvon.ai_budget'], ['delete from machvon.pricing_version'], ['delete from machvon.ai_model'], ['delete from machvon.ai_provider'], ['delete from machvon.ai_classification_policy_version']]);
  }
}

export { TENANT_A, TENANT_B, memberId, roleId, unitId };
