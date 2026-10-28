import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { LlmRegistryStore, TenantDatabase } from '@machvon/db';
import type { ModelRow, PolicyVersionRow, ProviderRow } from '@machvon/db';
import { BASELINE_MATRIX, DomainError, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';

const PROVIDER = 'ai_provider';
const MODEL = 'ai_model';
const POLICY = 'ai_classification_policy_version';

export function providerView(row: ProviderRow): Record<string, unknown> {
  return {
    id: row.id,
    provider_code: row.providerCode,
    name: row.name,
    region_country: row.regionCountry,
    route_class: row.routeClass,
    max_classification: row.maxClassification,
    data_agreement_document_id: row.dataAgreementDocumentId,
    d07_approval_ref: row.d07ApprovalRef,
    adapter_status: row.adapterStatus,
    status: row.status,
    approved_by: row.approvedBy,
    created_by: row.createdBy,
    created_at: row.createdAt,
    version: row.version,
  };
}

export function modelView(row: ModelRow): Record<string, unknown> {
  return {
    id: row.id,
    provider_id: row.providerId,
    model_id: row.modelId,
    model_version: row.modelVersion,
    capabilities: row.capabilities,
    context_window: row.contextWindow,
    max_output: row.maxOutput,
    max_classification: row.maxClassification,
    status: row.status,
    created_by: row.createdBy,
    created_at: row.createdAt,
    version: row.version,
  };
}

export function policyView(row: PolicyVersionRow): Record<string, unknown> {
  return {
    id: row.id,
    revision: row.revision,
    matrix: row.matrix,
    international_enabled: row.internationalEnabled,
    d07_approval_ref: row.d07ApprovalRef,
    legal_basis: row.legalBasis,
    effective_from: row.effectiveFrom,
    status: row.status,
    approved_by: row.approvedBy,
    created_by: row.createdBy,
    created_at: row.createdAt,
    version: row.version,
  };
}

/**
 * The registry of the AI gateway (ST-LLM-001, LLM F2): the providers a tenant may send data to, the models they serve and the classification matrix that says which route each class of data may take. All of it is the
 * tenant's, not a unit's: who holds a right on a subtree only is refused. A provider is registered by one person and activated by another, with the approval of D07 when it is international; a policy is drafted
 * by one and published by another, and a policy that weakens the baseline (the international route for anything above public data, or the line of important data) is never published.
 */
@Controller()
export class LlmRegistryController {
  private readonly registry = new LlmRegistryStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private whole(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  // ---- providers ---------------------------------------------------------------------------------------------------------------------------

  @Post('ai-providers')
  @HttpCode(200)
  @OperationId('registerAiProvider')
  @Command({ operation: 'registerAiProvider' })
  async registerProvider(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LlmProviderRegister']): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.registerAiProvider);
    const agreement = body.data_agreement_document_id === undefined ? null : (asUuid(body.data_agreement_document_id) ?? null);
    if (body.data_agreement_document_id !== undefined && agreement === null) throw new DomainError('VALIDATION_FAILED', 422, 'data_agreement_document_id');
    const created = await this.registry.registerProvider(scope.tx, {
      providerCode: body.provider_code.trim(),
      name: body.name.trim(),
      regionCountry: body.region_country.toUpperCase(),
      routeClass: body.route_class,
      maxClassification: body.max_classification,
      dataAgreementDocumentId: agreement,
      actor: scope.tenant.membershipId,
    });
    await scope.audit({ action: 'llm.provider_registered', resourceType: PROVIDER, resourceId: created.id, diff: { provider_code: created.providerCode, route_class: created.routeClass, region_country: created.regionCountry, max_classification: created.maxClassification } });
    await scope.emit({
      aggregateType: PROVIDER,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'llm.provider.registered.v1',
      schemaVersion: 1,
      payload: { provider_id: created.id, provider_code: created.providerCode, route_class: created.routeClass, max_classification: created.maxClassification },
      eventKey: `${PROVIDER}:${created.id}:${created.version}`,
    });
    return commandResult(scope, 'PROPOSED', created.version, created.id);
  }

  @Post('ai-providers/:id/activation')
  @HttpCode(200)
  @OperationId('activateAiProvider')
  @Command({ operation: 'activateAiProvider', versioned: true })
  async activateProvider(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body?: Schemas['LlmProviderActivate'],
  ): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.activateAiProvider);
    const d07 = body?.d07_approval_ref?.trim();
    const activated = await this.registry.activateProvider(scope.tx, id, { d07ApprovalRef: d07 === undefined || d07 === '' ? null : d07, actor: scope.tenant.membershipId, expectedVersion: scope.expectedVersion ?? 0 });
    await scope.audit({ action: 'llm.provider_activated', resourceType: PROVIDER, resourceId: id, diff: { provider_code: activated.providerCode, route_class: activated.routeClass, d07_approval_ref: activated.d07ApprovalRef } });
    await scope.emit({
      aggregateType: PROVIDER,
      aggregateId: id,
      aggregateVersion: activated.version,
      type: 'llm.provider.activated.v1',
      schemaVersion: 1,
      payload: { provider_id: id, provider_code: activated.providerCode, route_class: activated.routeClass, max_classification: activated.maxClassification },
      eventKey: `${PROVIDER}:${id}:${activated.version}`,
    });
    return commandResult(scope, 'ACTIVE', activated.version, id);
  }

  @Get('ai-providers')
  @OperationId('listAiProviders')
  async providers(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<{ items: Array<Record<string, unknown>>; next_cursor: null; as_of: string }> {
    this.whole(access, PERMISSIONS.listAiProviders);
    const rows = await this.database.withTenant(tenant, (tx) => this.registry.providers(tx));
    return { items: rows.map(providerView), next_cursor: null, as_of: new Date().toISOString() };
  }

  // ---- models ------------------------------------------------------------------------------------------------------------------------------

  @Post('ai-models')
  @HttpCode(200)
  @OperationId('registerAiModel')
  @Command({ operation: 'registerAiModel' })
  async registerModel(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LlmModelRegister']): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.registerAiModel);
    const providerId = asUuid(body.provider_id);
    if (providerId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'provider_id');
    const version = body.model_version?.trim();
    const created = await this.registry.registerModel(scope.tx, {
      providerId,
      modelId: body.model_id.trim(),
      modelVersion: version === undefined || version === '' ? null : version,
      capabilities: body.capabilities,
      contextWindow: body.context_window,
      maxOutput: body.max_output,
      maxClassification: body.max_classification,
      actor: scope.tenant.membershipId,
    });
    await scope.audit({ action: 'llm.model_registered', resourceType: MODEL, resourceId: created.id, diff: { provider_id: providerId, model_id: created.modelId, model_version: created.modelVersion, max_classification: created.maxClassification } });
    await scope.emit({
      aggregateType: MODEL,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'llm.model.registered.v1',
      schemaVersion: 1,
      payload: { model_ref_id: created.id, provider_id: providerId, model_id: created.modelId, max_classification: created.maxClassification },
      eventKey: `${MODEL}:${created.id}:${created.version}`,
    });
    return commandResult(scope, 'PROPOSED', created.version, created.id);
  }

  @Get('ai-models')
  @OperationId('listAiModels')
  async models(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('provider_id') providerId?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: null; as_of: string }> {
    this.whole(access, PERMISSIONS.listAiModels);
    const provider = providerId === undefined ? undefined : asUuid(String(providerId));
    if (providerId !== undefined && provider === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'provider_id');
    const rows = await this.database.withTenant(tenant, (tx) => this.registry.models(tx, provider));
    return { items: rows.map(modelView), next_cursor: null, as_of: new Date().toISOString() };
  }

  // ---- classification policies -------------------------------------------------------------------------------------------------------------

  @Post('ai-classification-policies')
  @HttpCode(200)
  @OperationId('createAiClassificationPolicy')
  @Command({ operation: 'createAiClassificationPolicy' })
  async draftPolicy(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LlmPolicyDraft']): Promise<CommandResult & { revision: number }> {
    this.whole(access, PERMISSIONS.createAiClassificationPolicy);
    const effectiveFrom = new Date(body.effective_from);
    if (Number.isNaN(effectiveFrom.getTime())) throw new DomainError('VALIDATION_FAILED', 422, 'effective_from');
    const d07 = body.d07_approval_ref?.trim();
    const created = await this.registry.draftPolicy(scope.tx, {
      matrix: body.matrix,
      internationalEnabled: body.international_enabled,
      d07ApprovalRef: d07 === undefined || d07 === '' ? null : d07,
      legalBasis: body.legal_basis.trim(),
      effectiveFrom,
      actor: scope.tenant.membershipId,
    });
    await scope.audit({ action: 'llm.policy_drafted', resourceType: POLICY, resourceId: created.id, diff: { revision: created.revision, international_enabled: created.internationalEnabled, d07_approval_ref: created.d07ApprovalRef, legal_basis: created.legalBasis } });
    await scope.emit({
      aggregateType: POLICY,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'llm.policy.drafted.v1',
      schemaVersion: 1,
      payload: { policy_version_id: created.id, revision: created.revision, international_enabled: created.internationalEnabled },
      eventKey: `${POLICY}:${created.id}:${created.version}`,
    });
    return { ...commandResult(scope, 'DRAFT', created.version, created.id), revision: created.revision };
  }

  @Post('ai-classification-policies/:id/publish')
  @HttpCode(200)
  @OperationId('publishAiClassificationPolicy')
  @Command({ operation: 'publishAiClassificationPolicy', versioned: true })
  async publishPolicy(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.publishAiClassificationPolicy);
    const { policy: published, superseded } = await this.registry.publishPolicy(scope.tx, id, { actor: scope.tenant.membershipId, expectedVersion: scope.expectedVersion ?? 0, now: new Date() });
    await scope.audit({
      action: 'llm.policy_published',
      resourceType: POLICY,
      resourceId: id,
      diff: { revision: published.revision, international_enabled: published.internationalEnabled, superseded_policy_id: superseded?.id ?? null },
    });
    await scope.emit({
      aggregateType: POLICY,
      aggregateId: id,
      aggregateVersion: published.version,
      type: 'llm.policy.published.v1',
      schemaVersion: 1,
      payload: { policy_version_id: id, revision: published.revision, international_enabled: published.internationalEnabled, superseded_policy_id: superseded?.id ?? null },
      eventKey: `${POLICY}:${id}:${published.version}`,
    });
    return commandResult(scope, 'PUBLISHED', published.version, id);
  }

  @Get('ai-classification-policies')
  @OperationId('listAiClassificationPolicies')
  async policies(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: null; as_of: string; baseline_matrix: Record<string, readonly string[]>; in_force_policy_id: string | null }> {
    this.whole(access, PERMISSIONS.listAiClassificationPolicies);
    const rows = await this.database.withTenant(tenant, (tx) => this.registry.policies(tx));
    // The baseline is told with the list: what is in force when no policy was published, and what no policy may widen.
    return { items: rows.map(policyView), next_cursor: null, as_of: new Date().toISOString(), baseline_matrix: BASELINE_MATRIX, in_force_policy_id: rows.find((row) => row.status === 'PUBLISHED')?.id ?? null };
  }
}
