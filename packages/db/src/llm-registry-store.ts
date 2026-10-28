import { randomUUID } from 'node:crypto';
import { DomainError, assertActivation, assertModelRegistration, assertPolicyDraft, assertProviderRegistration, assertPublishable } from '@machvon/kernel';
import type { Classification, Matrix, Route } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

export type ProviderStatus = 'PROPOSED' | 'ACTIVE' | 'SUSPENDED' | 'RETIRED';
export type PolicyStatus = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';

export interface ProviderRow {
  id: string;
  providerCode: string;
  name: string;
  regionCountry: string;
  routeClass: Route;
  maxClassification: Classification;
  dataAgreementDocumentId: string | null;
  d07ApprovalRef: string | null;
  adapterStatus: string;
  status: ProviderStatus;
  approvedBy: string | null;
  createdBy: string;
  createdAt: string;
  version: number;
}

export interface ModelRow {
  id: string;
  providerId: string;
  modelId: string;
  modelVersion: string | null;
  capabilities: Record<string, unknown>;
  contextWindow: number;
  maxOutput: number;
  maxClassification: Classification;
  status: string;
  createdBy: string;
  createdAt: string;
  version: number;
}

export interface PolicyVersionRow {
  id: string;
  revision: number;
  matrix: Matrix;
  internationalEnabled: boolean;
  d07ApprovalRef: string | null;
  legalBasis: string;
  effectiveFrom: string;
  status: PolicyStatus;
  approvedBy: string | null;
  createdBy: string;
  createdAt: string;
  version: number;
}

export interface ProviderInput {
  providerCode: string;
  name: string;
  regionCountry: string;
  routeClass: Route;
  maxClassification: Classification;
  dataAgreementDocumentId: string | null;
  actor: string;
}

export interface ModelInput {
  providerId: string;
  modelId: string;
  modelVersion: string | null;
  capabilities: unknown;
  contextWindow: number;
  maxOutput: number;
  maxClassification: Classification;
  actor: string;
}

export interface PolicyDraftInput {
  matrix: unknown;
  internationalEnabled: boolean;
  d07ApprovalRef: string | null;
  legalBasis: string;
  effectiveFrom: Date;
  actor: string;
}

interface Sql {
  [column: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const PROVIDER = `select id, provider_code, name, region_country, route_class, max_classification, data_agreement_document_id, d07_approval_ref, adapter_status, status, approved_by, created_by, created_at, version::text as version
  from machvon.ai_provider`;
const MODEL = `select id, provider_id, model_id, model_version, capabilities, context_window, max_output, max_classification, status, created_by, created_at, version::text as version from machvon.ai_model`;
const POLICY = `select id, revision, matrix_json, international_enabled, d07_approval_ref, legal_basis, effective_from, status, approved_by, created_by, created_at, version::text as version
  from machvon.ai_classification_policy_version`;

const provider = (row: Sql): ProviderRow => ({
  id: row.id,
  providerCode: row.provider_code,
  name: row.name,
  regionCountry: row.region_country,
  routeClass: row.route_class,
  maxClassification: row.max_classification,
  dataAgreementDocumentId: row.data_agreement_document_id,
  d07ApprovalRef: row.d07_approval_ref,
  adapterStatus: row.adapter_status,
  status: row.status,
  approvedBy: row.approved_by,
  createdBy: row.created_by,
  createdAt: new Date(row.created_at).toISOString(),
  version: Number(row.version),
});
const model = (row: Sql): ModelRow => ({
  id: row.id,
  providerId: row.provider_id,
  modelId: row.model_id,
  modelVersion: row.model_version,
  capabilities: row.capabilities,
  contextWindow: row.context_window,
  maxOutput: row.max_output,
  maxClassification: row.max_classification,
  status: row.status,
  createdBy: row.created_by,
  createdAt: new Date(row.created_at).toISOString(),
  version: Number(row.version),
});
const policy = (row: Sql): PolicyVersionRow => ({
  id: row.id,
  revision: row.revision,
  matrix: row.matrix_json,
  internationalEnabled: row.international_enabled,
  d07ApprovalRef: row.d07_approval_ref,
  legalBasis: row.legal_basis,
  effectiveFrom: new Date(row.effective_from).toISOString(),
  status: row.status,
  approvedBy: row.approved_by,
  createdBy: row.created_by,
  createdAt: new Date(row.created_at).toISOString(),
  version: Number(row.version),
});

/**
 * The providers, the models and the classification policies of the AI gateway (ST-LLM-001, LLM F2): who the tenant may send data to, what they serve, and the matrix of the routes each class of data may take. The rules
 * are the kernel's; the database holds the same ones (ai_provider_intl_chk, ai_provider_vn_chk, the baseline check of a PUBLISHED policy), so a write that skips the service is refused as well.
 */
export class LlmRegistryStore {
  // ---- providers ---------------------------------------------------------------------------------------------------------------------------

  async providers(tx: TenantTx): Promise<ProviderRow[]> {
    return (await tx.query<Sql>(`${PROVIDER} order by provider_code`)).map(provider);
  }

  async findProvider(tx: TenantTx, id: string, lock = false): Promise<ProviderRow | undefined> {
    const rows = await tx.query<Sql>(`${PROVIDER} where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : provider(rows[0]);
  }

  /** Registers a provider as PROPOSED: nothing is sent to it until another person activates it. */
  async registerProvider(tx: TenantTx, input: ProviderInput): Promise<ProviderRow> {
    assertProviderRegistration(input);
    // Two registrations of one code at once are taken in turn, so the second one is told it is a duplicate (and is not left to the unique index as a server error).
    await tx.query("select pg_advisory_xact_lock(hashtextextended('llm_provider:' || current_setting('app.tenant_id', true) || ':' || $1, 0))", [input.providerCode]);
    const code = await tx.query('select 1 from machvon.ai_provider where provider_code = $1', [input.providerCode]);
    if (code.length > 0) throw new DomainError('PROVIDER_CODE_DUPLICATE', 409, 'provider_code');
    if (input.dataAgreementDocumentId !== null) {
      const document = await tx.query('select 1 from machvon.document where id = $1::uuid', [input.dataAgreementDocumentId]);
      if (document.length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'data_agreement_document_id');
    }
    const id = randomUUID();
    await tx.query(
      `insert into machvon.ai_provider (tenant_id, id, provider_code, name, region_country, route_class, max_classification, data_agreement_document_id, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5, $6, $7::uuid, 'PROPOSED', $8::uuid, $8::uuid)`,
      [id, input.providerCode, input.name, input.regionCountry, input.routeClass, input.maxClassification, input.dataAgreementDocumentId, input.actor],
    );
    return (await this.findProvider(tx, id)) as ProviderRow;
  }

  /** Makes a PROPOSED provider ACTIVE: the paper it needs, then another person than the one who registered it (the kernel judges both). */
  async activateProvider(tx: TenantTx, id: string, input: { d07ApprovalRef: string | null; actor: string; expectedVersion: number }): Promise<ProviderRow> {
    const named = await this.findProvider(tx, id, true);
    if (named === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (named.version !== input.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409);
    if (named.status !== 'PROPOSED' && named.status !== 'SUSPENDED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    const d07 = input.d07ApprovalRef ?? named.d07ApprovalRef;
    assertActivation({ routeClass: named.routeClass, maxClassification: named.maxClassification, d07ApprovalRef: d07, dataAgreementDocumentId: named.dataAgreementDocumentId, registeredBy: named.createdBy, actor: input.actor });
    await tx.query("update machvon.ai_provider set status = 'ACTIVE', d07_approval_ref = $2, approved_by = $3::uuid, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid", [id, d07, input.actor]);
    return (await this.findProvider(tx, id)) as ProviderRow;
  }

  // ---- models ------------------------------------------------------------------------------------------------------------------------------

  async models(tx: TenantTx, providerId?: string): Promise<ModelRow[]> {
    return (await tx.query<Sql>(`${MODEL} where ($1::uuid is null or provider_id = $1::uuid) order by provider_id, model_id, model_version nulls first`, [providerId ?? null])).map(model);
  }

  /** Registers a model of a provider as PROPOSED: it is used only once it is APPROVED, with an evaluation that passed on its route (LLM-004). */
  async registerModel(tx: TenantTx, input: ModelInput): Promise<ModelRow> {
    const owner = await this.findProvider(tx, input.providerId, true);
    if (owner === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (owner.status === 'RETIRED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    assertModelRegistration({ providerMax: owner.maxClassification, maxClassification: input.maxClassification, contextWindow: input.contextWindow, maxOutput: input.maxOutput, capabilities: input.capabilities });
    const same = await tx.query('select 1 from machvon.ai_model where provider_id = $1::uuid and model_id = $2 and model_version is not distinct from $3', [input.providerId, input.modelId, input.modelVersion]);
    if (same.length > 0) throw new DomainError('MODEL_DUPLICATE', 409, 'model_id');
    const id = randomUUID();
    await tx.query(
      `insert into machvon.ai_model (tenant_id, id, provider_id, model_id, model_version, capabilities, context_window, max_output, max_classification, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::int, $7::int, $8, 'PROPOSED', $9::uuid, $9::uuid)`,
      [id, input.providerId, input.modelId, input.modelVersion, JSON.stringify(input.capabilities), input.contextWindow, input.maxOutput, input.maxClassification, input.actor],
    );
    return (await tx.query<Sql>(`${MODEL} where id = $1::uuid`, [id])).map(model)[0] as ModelRow;
  }

  // ---- classification policies -------------------------------------------------------------------------------------------------------------

  async policies(tx: TenantTx): Promise<PolicyVersionRow[]> {
    return (await tx.query<Sql>(`${POLICY} order by revision desc`)).map(policy);
  }

  async findPolicy(tx: TenantTx, id: string, lock = false): Promise<PolicyVersionRow | undefined> {
    const rows = await tx.query<Sql>(`${POLICY} where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : policy(rows[0]);
  }

  /** The policy in force: the one that is PUBLISHED; none means the baseline (the international route off). */
  async published(tx: TenantTx): Promise<PolicyVersionRow | undefined> {
    const rows = await tx.query<Sql>(`${POLICY} where status = 'PUBLISHED'`);
    return rows[0] === undefined ? undefined : policy(rows[0]);
  }

  /** Drafts the next revision of the matrix. A draft routes nothing; it can be wider than the baseline on paper, and is refused only when it is published. */
  async draftPolicy(tx: TenantTx, input: PolicyDraftInput): Promise<PolicyVersionRow> {
    const matrix = assertPolicyDraft({ matrix: input.matrix, internationalEnabled: input.internationalEnabled, d07ApprovalRef: input.d07ApprovalRef });
    await tx.query("select pg_advisory_xact_lock(hashtextextended('llm_policy:' || current_setting('app.tenant_id', true), 0))");
    const last = await tx.query<{ revision: number }>('select max(revision) as revision from machvon.ai_classification_policy_version');
    const id = randomUUID();
    await tx.query(
      `insert into machvon.ai_classification_policy_version (tenant_id, id, revision, matrix_json, international_enabled, d07_approval_ref, legal_basis, effective_from, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::int, $3::jsonb, $4, $5, $6, $7::timestamptz, 'DRAFT', $8::uuid, $8::uuid)`,
      [id, (last[0]?.revision ?? 0) + 1, JSON.stringify(matrix), input.internationalEnabled, input.d07ApprovalRef, input.legalBasis, input.effectiveFrom.toISOString(), input.actor],
    );
    return (await this.findPolicy(tx, id)) as PolicyVersionRow;
  }

  /** Publishes a draft in place of the policy in force: the baseline is judged first, then the person; the one that was PUBLISHED is SUPERSEDED in the same moment, so exactly one stays. */
  async publishPolicy(tx: TenantTx, id: string, input: { actor: string; expectedVersion: number; now: Date }): Promise<{ policy: PolicyVersionRow; superseded: PolicyVersionRow | undefined }> {
    await tx.query("select pg_advisory_xact_lock(hashtextextended('llm_policy:' || current_setting('app.tenant_id', true), 0))");
    const draft = await this.findPolicy(tx, id, true);
    if (draft === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (draft.version !== input.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409);
    if (draft.status !== 'DRAFT') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    assertPublishable({ matrix: draft.matrix, internationalEnabled: draft.internationalEnabled, createdBy: draft.createdBy, effectiveFrom: new Date(draft.effectiveFrom), actor: input.actor, now: input.now });
    // The predecessor is read under the lock, so that the record of the change names the policy that really gave way.
    const superseded = await this.published(tx);
    await tx.query("update machvon.ai_classification_policy_version set status = 'SUPERSEDED', updated_at = now(), updated_by = $1::uuid, version = version + 1 where status = 'PUBLISHED'", [input.actor]);
    await tx.query("update machvon.ai_classification_policy_version set status = 'PUBLISHED', approved_by = $2::uuid, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [id, input.actor]);
    return { policy: (await this.findPolicy(tx, id)) as PolicyVersionRow, superseded };
  }
}
