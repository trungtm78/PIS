import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { ASSIST_KINDS, ASSIST_TASK_TYPES, assistOutputSchema, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import type { AssistKind, TenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { FileService } from '../../src/modules/files/file.service';
import { FsObjectStorage } from '../../src/modules/files/fs-object-storage';
import { MockScanPort } from '../../src/modules/files/mock-scan';
import { AiAssistConfigController } from '../../src/modules/llm/assist-config.controller';
import { AiAssistController } from '../../src/modules/llm/assist.controller';
import { AiAssistService } from '../../src/modules/llm/assist.service';
import { LlmExternalExceptionController } from '../../src/modules/llm/external-exception.controller';
import { LlmGatewayService } from '../../src/modules/llm/gateway.service';
import { LLM_DOCUMENT_TEXT } from '../../src/modules/llm/knowledge-ports';
import type { DocumentTextPort } from '../../src/modules/llm/knowledge-ports';
import { MockAiGateway } from '../../src/modules/llm/mock-gateway';
import { LlmRegistryController } from '../../src/modules/llm/registry.controller';
import { LLM_GATEWAY, LLM_METRICS } from '../../src/modules/llm/tokens';
import { AuthzHarness, TENANT_A, TENANT_B, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAnalysisProfile } from '../../../../packages/db/test/support/bid-analysis-fixtures';
import { seedAs } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { seedCtrWorld } from '../../../../packages/db/test/support/ctr-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

export const SIGNING_KEY = randomBytes(32);

/** The people of the tests of the AI assistant: who reads everything, who reads one branch only, and who holds a single right. */
export const ASKER = 1; // asks, reviews, evaluates and decides; reads everything of the tenant
export const NARROW = 2; // the same rights over one branch that holds none of the records: reads nothing
export const USE_ONLY = 3; // ai.assist.use only (not review, not evaluate, not decide)
export const NOBODY = 4;
export const MAKER = 5; // drafts checklists and criteria
export const CHECKER = 6; // publishes them
export const PROVIDER_ADMIN = 7; // registers providers and records their attestation
export const PROVIDER_APPROVER = 8; // activates providers
export const EXCEPTION_ASKER = 9;
export const EXCEPTION_DECIDER = 10;
export const OTHER_ASKER = 11; // as ASKER: another person, to show a run is its asker's own
export const CONFIG_BOTH = 12; // drafts and publishes: the rule, not the guard, keeps the two apart
export const ROOT = 1;
export const DEPARTMENT = 2;
export const ELSEWHERE = 3;
const FAMILY = 0x9b;

export interface Reply {
  status: number;
  json: Record<string, unknown>;
}

export const sha256 = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');

/** The text of the pages of a document version, as the OCR of the document module would have recorded it. */
class StubTexts implements DocumentTextPort {
  readonly pagesOf = new Map<string, string[]>();
  async pages(_tx: TenantTx, _tenant: TenantContext, documentVersionId: string): Promise<string[]> {
    return this.pagesOf.get(documentVersionId) ?? [''];
  }
}

export interface Records {
  projectId: string;
  contractId: string;
  secondContractId: string;
  documentVersionId: string;
}

export const REPORT_PAGE_ONE = 'The total investment of the bridge project is 120 billion dong, financed by the state budget, and the contractor is Lead Builders.';
export const REPORT_PAGE_TWO = 'The contractor completed the foundation works two weeks late because of the rain in the second quarter.';

export class AssistWorld {
  readonly harness = new AuthzHarness();
  readonly gateway = new MockAiGateway();
  readonly texts = new StubTexts();
  readonly metrics: Array<{ name: string; labels: Record<string, string> }> = [];
  app!: RunningApp;
  files!: FileService;
  private root = '';
  profiles = new Map<AssistKind, string>();
  domesticModel = '';
  selfHostedModel = '';
  providers = { domestic: '', selfHosted: '' };

  async start(): Promise<void> {
    const { harness } = this;
    this.root = await mkdtemp(join(tmpdir(), 'machvon-ai-assist-'));
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: ROOT, path: `/${unitId(ROOT)}/` },
        { n: DEPARTMENT, path: `/${unitId(ROOT)}/${unitId(DEPARTMENT)}/`, parent: ROOT },
        { n: ELSEWHERE, path: `/${unitId(ROOT)}/${unitId(ELSEWHERE)}/`, parent: ROOT },
      ]);
    }
    for (const n of [ASKER, NARROW, USE_ONLY, NOBODY, MAKER, CHECKER, PROVIDER_ADMIN, PROVIDER_APPROVER, EXCEPTION_ASKER, EXCEPTION_DECIDER, OTHER_ASKER, CONFIG_BOTH]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, ASKER, ROOT);
    const reads = ['project.read', 'contract.read', 'document_version.read', 'project.fin.read'];
    const asker = ['ai.assist.use', 'ai.assist.review', 'ai.assist.evaluate', 'ai.assist.decide', ...reads];
    await harness.seedRole(TENANT_A, 1, 'AI_ASSISTANT_USER', asker, 30);
    await harness.seedRole(TENANT_A, 2, 'AI_ASSISTANT_BASIC', ['ai.assist.use', ...reads], 20);
    await harness.seedRole(TENANT_A, 3, 'AI_CONFIG_MAKER', ['ai.config.manage', 'ai.config.read'], 30);
    await harness.seedRole(TENANT_A, 4, 'AI_CONFIG_CHECKER', ['ai.config.approve', 'ai.config.read'], 40);
    await harness.seedRole(TENANT_A, 5, 'AI_PROVIDER_ADMIN', ['llm.provider.manage', 'llm.provider.read', 'llm.exception.read'], 40);
    await harness.seedRole(TENANT_A, 6, 'AI_PROVIDER_APPROVER', ['llm.provider.approve', 'llm.provider.read'], 50);
    await harness.seedRole(TENANT_A, 7, 'AI_EXCEPTION_ASKER', ['llm.exception.request', 'llm.exception.read', 'llm.provider.read'], 30);
    await harness.seedRole(TENANT_A, 8, 'AI_EXCEPTION_DECIDER', ['llm.exception.approve', 'llm.exception.read', 'llm.provider.read'], 50);
    await harness.seedRole(TENANT_A, 9, 'AI_CONFIG_BOTH', ['ai.config.manage', 'ai.config.approve', 'ai.config.read'], 45);
    await harness.seedRole(TENANT_B, 1, 'AI_ASSISTANT_USER', asker, 30);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ASKER, role: 1, kind: 'TENANT' },
      { n: 2, member: NARROW, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(ELSEWHERE)] },
      { n: 3, member: USE_ONLY, role: 2, kind: 'TENANT' },
      { n: 4, member: MAKER, role: 3, kind: 'TENANT' },
      { n: 5, member: CHECKER, role: 4, kind: 'TENANT' },
      { n: 6, member: PROVIDER_ADMIN, role: 5, kind: 'TENANT' },
      { n: 7, member: PROVIDER_APPROVER, role: 6, kind: 'TENANT' },
      { n: 8, member: EXCEPTION_ASKER, role: 7, kind: 'TENANT' },
      { n: 9, member: EXCEPTION_DECIDER, role: 8, kind: 'TENANT' },
      { n: 10, member: OTHER_ASKER, role: 1, kind: 'TENANT' },
      { n: 11, member: CONFIG_BOTH, role: 9, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: ASKER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    this.files = new FileService({ storage: new FsObjectStorage(this.root), scanner: new MockScanPort(), urlSecret: randomBytes(32) });
    this.app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [AiAssistController, AiAssistConfigController, LlmExternalExceptionController, LlmRegistryController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: FileService, useValue: this.files },
        { provide: LLM_GATEWAY, useValue: this.gateway },
        { provide: LLM_DOCUMENT_TEXT, useValue: this.texts },
        {
          provide: LLM_METRICS,
          useValue: {
            gauge: (name: string, value: number, labels: Record<string, string> = {}) => this.metrics.push({ name, labels: { ...labels, value: String(value) } }),
            increment: (name: string, labels: Record<string, string> = {}) => this.metrics.push({ name, labels }),
          },
        },
        LlmGatewayService,
        AiAssistService,
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }

  async stop(): Promise<void> {
    if (this.app) await this.app.close();
    await this.harness.stop();
    if (this.root !== '') await rm(this.root, { recursive: true, force: true });
  }

  async call(method: 'GET' | 'POST', url: string, options: { member: number; tenantId?: string; body?: unknown; key?: string; ifMatch?: string }): Promise<Reply> {
    const token = signTenantContext({ tenantId: options.tenantId ?? TENANT_A, membershipId: memberId(options.member), scopeVersion: 1 }, SIGNING_KEY);
    const headers: Record<string, string> = { [TENANT_HEADER]: token, 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${this.app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  rows<R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant: string = TENANT_A): Promise<R[]> {
    return this.harness.owner<R>(tenant, [[sql, params]]);
  }

  /** The providers, models, prices, the policy in force and one published profile for each kind of the assistant. */
  async seedRegistry(options: { withSelfHosted?: boolean; profileMax?: string } = {}): Promise<void> {
    const worker = memberId(ASKER);
    const policyId = randomUUID();
    await this.rows(
      `insert into machvon.ai_classification_policy_version (tenant_id, id, revision, matrix_json, international_enabled, legal_basis, effective_from, status, approved_by, created_by, updated_by)
       values ($1, $2, 1, $3::jsonb, false, 'Legal basis', '2026-01-01', 'PUBLISHED', $4, $5, $5)`,
      [
        TENANT_A,
        policyId,
        JSON.stringify({ PUBLIC: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], INTERNAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], CONFIDENTIAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], PERSONAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], IMPORTANT_CORE: ['SELF_HOSTED'] }),
        memberId(PROVIDER_APPROVER),
        worker,
      ],
    );
    const provider = async (code: string, route: string, max: string): Promise<string> => {
      const providerId = randomUUID();
      await this.rows(
        `insert into machvon.ai_provider (tenant_id, id, provider_code, name, region_country, route_class, max_classification, status, created_by, updated_by)
         values ($1, $2, $3, $3, 'VN', $4, $5, 'ACTIVE', $6, $6)`,
        [TENANT_A, providerId, code, route, max, worker],
      );
      return providerId;
    };
    const model = async (providerId: string, code: string, max: string): Promise<string> => {
      const modelId = randomUUID();
      await this.rows(
        `insert into machvon.ai_model (tenant_id, id, provider_id, model_id, capabilities, context_window, max_output, max_classification, status, created_by, updated_by)
         values ($1, $2, $3, $4, '{}'::jsonb, 8000, 1000, $5, 'APPROVED', $6, $6)`,
        [TENANT_A, modelId, providerId, code, max, worker],
      );
      await this.rows(
        `insert into machvon.pricing_version (tenant_id, id, provider, model_id, currency, effective_from, input_per_million, cached_per_million, output_per_million, source_url, model_ref_id, cached_semantics, reasoning_in_output, fx_rate_to_vnd, fx_source)
         values ($1, gen_random_uuid(), 'ProviderCo', $2, 'USD', '2026-01-01', 2, 0.5, 8, 'https://provider.example/pricing', $3, 'INCLUDED_IN_INPUT', true, 25400, 'Bank 2026-10-22')`,
        [TENANT_A, code, modelId],
      );
      return modelId;
    };
    this.providers.domestic = await provider('VN-HOST', 'DOMESTIC_HOSTED', 'PERSONAL');
    this.domesticModel = await model(this.providers.domestic, 'dom-model', 'PERSONAL');
    const allowed = [this.domesticModel];
    if (options.withSelfHosted === true) {
      this.providers.selfHosted = await provider('SELF-1', 'SELF_HOSTED', 'IMPORTANT_CORE');
      this.selfHostedModel = await model(this.providers.selfHosted, 'self-model', 'IMPORTANT_CORE');
      allowed.push(this.selfHostedModel);
    }
    for (const kind of ASSIST_KINDS) {
      const profile = await seedAnalysisProfile(this.harness, { taskType: ASSIST_TASK_TYPES[kind], maxInputTokens: 20_000, tools: [] });
      await this.rows(
        `update machvon.model_profile_version set routing_policy = $2::jsonb, allowed_model_ids = $3::jsonb, max_classification = $4, output_schema = $5::jsonb, output_cap = 1000 where id = $1`,
        [profile.id, JSON.stringify({ routes: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], thresholds: {} }), JSON.stringify(allowed), options.profileMax ?? 'IMPORTANT_CORE', JSON.stringify(assistOutputSchema(kind))],
      );
      this.profiles.set(kind, profile.id);
    }
  }

  /** A project, two contracts and a report with two pages, all in the branch DEPARTMENT: ASKER reads them, NARROW (who holds ELSEWHERE) does not. */
  async seedRecords(): Promise<Records> {
    const world = await seedCtrWorld(this.harness.database.adminUrl, TENANT_A, FAMILY, ASKER, DEPARTMENT, ROOT);
    const contractId = randomUUID();
    const secondContractId = randomUUID();
    const documentId = randomUUID();
    const documentVersionId = randomUUID();
    await seedAs(this.harness, [
      [
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, contract_value_vnd, title)
         values ($1, $2, $4, $5, $6, 'HD-001', 'LUMP_SUM', 'VND', 'DRAFT', 1, 900000000, 'Foundation works'), ($1, $3, $4, $5, $6, 'HD-002', 'LUMP_SUM', 'VND', 'DRAFT', 1, 100000000, 'Supervision')`,
        [TENANT_A, contractId, secondContractId, world.project, world.packageId, world.lead],
      ],
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, issuer_unit_id, created_by, updated_by)
         values ($1, $2, 'REFERENCE', 'BC', 'Progress report of the bridge', 'INTERNAL', $3, $4, $4)`,
        [TENANT_A, documentId, unitId(DEPARTMENT), memberId(ASKER)],
      ],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ai/report.pdf', repeat('a', 64), 'application/pdf', 2, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, documentVersionId, documentId],
      ],
    ]);
    this.texts.pagesOf.set(documentVersionId, [REPORT_PAGE_ONE, REPORT_PAGE_TWO]);
    return { projectId: world.project, contractId, secondContractId, documentVersionId };
  }

  /** Takes away what a test made, so that the next one starts from a tenant with no registry, no runs and no exceptions. */
  async reset(): Promise<void> {
    await this.harness.owner(TENANT_A, [
      ['alter table machvon.ai_assist_decision disable trigger ai_assist_decision_append_only'],
      ['delete from machvon.ai_assist_decision'],
      ['alter table machvon.ai_assist_decision enable trigger ai_assist_decision_append_only'],
      ['alter table machvon.ai_assist_run disable trigger ai_assist_run_immutable'],
      ['delete from machvon.ai_assist_run'],
      ['alter table machvon.ai_assist_run enable trigger ai_assist_run_immutable'],
      ['alter table machvon.ai_external_exception_use disable trigger ai_external_exception_use_append_only'],
      ['delete from machvon.ai_external_exception_use'],
      ['alter table machvon.ai_external_exception_use enable trigger ai_external_exception_use_append_only'],
      ['alter table machvon.ai_external_exception disable trigger ai_external_exception_guard'],
      ['delete from machvon.ai_external_exception'],
      ['alter table machvon.ai_external_exception enable trigger ai_external_exception_guard'],
      ['alter table machvon.ai_review_checklist_item disable trigger ai_review_checklist_item_guard'],
      ['delete from machvon.ai_review_checklist_item'],
      ['alter table machvon.ai_review_checklist_item enable trigger ai_review_checklist_item_guard'],
      ['alter table machvon.ai_review_checklist disable trigger ai_review_checklist_guard'],
      ['delete from machvon.ai_review_checklist'],
      ['alter table machvon.ai_review_checklist enable trigger ai_review_checklist_guard'],
      ['alter table machvon.ai_eval_criterion disable trigger ai_eval_criterion_guard'],
      ['delete from machvon.ai_eval_criterion'],
      ['alter table machvon.ai_eval_criterion enable trigger ai_eval_criterion_guard'],
      ['alter table machvon.ai_eval_criteria_set disable trigger ai_eval_criteria_set_guard'],
      ['delete from machvon.ai_eval_criteria_set'],
      ['alter table machvon.ai_eval_criteria_set enable trigger ai_eval_criteria_set_guard'],
      ['alter table machvon.ai_decision_record disable trigger ai_decision_record_guard'],
      ['delete from machvon.ai_decision_record'],
      ['alter table machvon.ai_decision_record enable trigger ai_decision_record_guard'],
      ['delete from machvon.llm_attempt'],
      ['update machvon.ai_request set budget_reservation_id = null'],
      ['delete from machvon.budget_reservation'],
      ['delete from machvon.ai_request'],
      ['delete from machvon.model_profile_version'],
      ['delete from machvon.ai_prompt_version'],
      ['delete from machvon.ai_budget_counter'],
      ['delete from machvon.ai_budget'],
      ['delete from machvon.pricing_version'],
      ['delete from machvon.ai_model'],
      ['delete from machvon.ai_provider'],
      ['delete from machvon.ai_classification_policy_version'],
    ]);
    this.gateway.clear();
    this.metrics.length = 0;
    this.profiles.clear();
  }
}

export { TENANT_A, TENANT_B, memberId, unitId };
