import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { LlmEvalStore, TenantDatabase } from '@machvon/db';
import type { EvalDatasetRow, EvalRunRow, ProfileRow, PromptRow } from '@machvon/db';
import { DomainError, asUuid, scrubSecrets } from '@machvon/kernel';
import type { EffectiveAccess, EvalRunnerPort, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { LLM_EVAL_RUNNER } from './tokens';

const PROMPT = 'ai_prompt_version';
const DATASET = 'ai_eval_dataset_version';
const PROFILE = 'model_profile_version';
const RUN = 'ai_eval_run';

export function promptView(row: PromptRow): Record<string, unknown> {
  return {
    id: row.id,
    task_type: row.taskType,
    name: row.name,
    revision: row.revision,
    template_sha256: row.templateSha256,
    input_schema: row.inputSchema,
    output_schema: row.outputSchema,
    label: row.label,
    status: row.status,
    approved_by: row.approvedBy,
    created_by: row.createdBy,
    created_at: row.createdAt,
    version: row.version,
  };
}

export function datasetView(row: EvalDatasetRow): Record<string, unknown> {
  return {
    id: row.id,
    dataset_code: row.datasetCode,
    revision: row.revision,
    task_type: row.taskType,
    source: row.source,
    max_classification: row.maxClassification,
    case_count: row.caseCount,
    injection_cases: row.injectionCases,
    status: row.status,
    created_by: row.createdBy,
    created_at: row.createdAt,
    version: row.version,
  };
}

export function profileView(row: ProfileRow): Record<string, unknown> {
  return {
    id: row.id,
    task_type: row.taskType,
    revision: row.revision,
    model_id: row.modelId,
    effort: row.effort,
    output_cap: row.outputCap,
    routing_policy: row.routingPolicy,
    status: row.status,
    allowed_model_ids: row.allowedModelIds,
    max_input_tokens: row.maxInputTokens,
    timeout_ms: row.timeoutMs,
    concurrency_limit: row.concurrencyLimit,
    tool_allowlist: row.toolAllowlist,
    max_classification: row.maxClassification,
    prompt_version_id: row.promptVersionId,
    rollback_profile_id: row.rollbackProfileId,
    retention_days: row.retentionDays,
    approved_by: row.approvedBy,
    created_by: row.createdBy,
    effective_at: row.effectiveAt,
    created_at: row.createdAt,
    version: row.version,
  };
}

export function runView(row: EvalRunRow): Record<string, unknown> {
  const { signature } = row.results as { signature?: { decision?: string; comment?: string } };
  return {
    id: row.id,
    profile_version_id: row.profileVersionId,
    dataset_version_id: row.datasetVersionId,
    route_class: row.route,
    model_ref_id: row.modelRefId,
    metrics: row.metrics,
    thresholds: row.thresholds,
    passed: row.passed,
    failures: (row.results as { failures?: string[] }).failures ?? [],
    review_status: row.status,
    cost_vnd: row.costVnd,
    started_by: row.startedBy,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
    signed_by: row.signedBy,
    signed_at: row.signedAt,
    signature_decision: signature?.decision ?? null,
    signature_comment: signature?.comment ?? null,
    version: row.version,
  };
}

type Page = { items: Array<Record<string, unknown>>; next_cursor: null; as_of: string };
const page = (items: Array<Record<string, unknown>>): Page => ({ items, next_cursor: null, as_of: new Date().toISOString() });

/**
 * The evaluation gate of the AI gateway (ST-LLM-004, LLM F4, LLM-04, LLM-10, LLM-12, LLM-17): prompts that are approved by another person and then do not change, datasets of synthetic or anonymised cases, model profiles,
 * the run of a dataset on one route of a profile and its signature by an expert, and the publication of a profile once every route it may use has a signed passing evaluation. All of it is the tenant's.
 */
@Controller()
export class LlmEvalController {
  private readonly evals = new LlmEvalStore();

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(LLM_EVAL_RUNNER) private readonly runner: EvalRunnerPort,
  ) {}

  private whole(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  // ---- prompts -----------------------------------------------------------------------------------------------------------------------------

  @Post('ai-prompts')
  @HttpCode(200)
  @OperationId('createAiPromptVersion')
  @Command({ operation: 'createAiPromptVersion' })
  async createPrompt(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LlmPromptDraft']): Promise<CommandResult & { revision: number }> {
    this.whole(access, PERMISSIONS.createAiPromptVersion);
    const created = await this.evals.createPrompt(
      scope.tx,
      { taskType: body.task_type.trim(), name: body.name.trim(), templateObjectKey: body.template_object_key.trim(), templateSha256: body.template_sha256, inputSchema: body.input_schema, outputSchema: body.output_schema },
      scope.tenant.membershipId,
    );
    await scope.audit({ action: 'llm.prompt_drafted', resourceType: PROMPT, resourceId: created.id, diff: { task_type: created.taskType, name: created.name, revision: created.revision, template_sha256: created.templateSha256 } });
    await scope.emit({
      aggregateType: PROMPT,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'llm.prompt.drafted.v1',
      schemaVersion: 1,
      payload: { prompt_version_id: created.id, task_type: created.taskType, name: created.name, revision: created.revision },
      eventKey: `${PROMPT}:${created.id}:${created.version}`,
    });
    return { ...commandResult(scope, 'DRAFT', created.version, created.id), revision: created.revision };
  }

  @Put('ai-prompts/:id')
  @HttpCode(200)
  @OperationId('reviseAiPromptVersion')
  @Command({ operation: 'reviseAiPromptVersion', versioned: true })
  async revisePrompt(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['LlmPromptDraft']): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.reviseAiPromptVersion);
    const before = await this.evals.findPrompt(scope.tx, id);
    const revised = await this.evals.revisePrompt(
      scope.tx,
      id,
      { taskType: body.task_type.trim(), name: body.name.trim(), templateObjectKey: body.template_object_key.trim(), templateSha256: body.template_sha256, inputSchema: body.input_schema, outputSchema: body.output_schema },
      scope.expectedVersion ?? 0,
      scope.tenant.membershipId,
    );
    await scope.audit({ action: 'llm.prompt_revised', resourceType: PROMPT, resourceId: id, diff: { revision: revised.revision, from_sha256: before?.templateSha256 ?? null, to_sha256: revised.templateSha256 } });
    await scope.emit({
      aggregateType: PROMPT,
      aggregateId: id,
      aggregateVersion: revised.version,
      type: 'llm.prompt.revised.v1',
      schemaVersion: 1,
      payload: { prompt_version_id: id, revision: revised.revision },
      eventKey: `${PROMPT}:${id}:${revised.version}`,
    });
    return commandResult(scope, 'DRAFT', revised.version, id);
  }

  @Post('ai-prompts/:id/approval')
  @HttpCode(200)
  @OperationId('approveAiPromptVersion')
  @Command({ operation: 'approveAiPromptVersion', versioned: true })
  async approvePrompt(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.approveAiPromptVersion);
    const { prompt, retired } = await this.evals.approvePrompt(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    await scope.audit({ action: 'llm.prompt_approved', resourceType: PROMPT, resourceId: id, diff: { revision: prompt.revision, template_sha256: prompt.templateSha256, label: prompt.label, retired_prompt_id: retired?.id ?? null } });
    await scope.emit({
      aggregateType: PROMPT,
      aggregateId: id,
      aggregateVersion: prompt.version,
      type: 'llm.prompt.approved.v1',
      schemaVersion: 1,
      payload: { prompt_version_id: id, revision: prompt.revision, template_sha256: prompt.templateSha256, label: prompt.label },
      eventKey: `${PROMPT}:${id}:${prompt.version}`,
    });
    return commandResult(scope, 'APPROVED', prompt.version, id);
  }

  @Get('ai-prompts')
  @OperationId('listAiPrompts')
  async prompts(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Page> {
    this.whole(access, PERMISSIONS.listAiPrompts);
    return page((await this.database.withTenant(tenant, (tx) => this.evals.prompts(tx))).map(promptView));
  }

  // ---- datasets ----------------------------------------------------------------------------------------------------------------------------

  @Post('ai-eval-datasets')
  @HttpCode(200)
  @OperationId('createAiEvalDataset')
  @Command({ operation: 'createAiEvalDataset' })
  async createDataset(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LlmEvalDatasetDraft']): Promise<CommandResult & { revision: number }> {
    this.whole(access, PERMISSIONS.createAiEvalDataset);
    const created = await this.evals.createDataset(scope.tx, { datasetCode: body.dataset_code.trim(), taskType: body.task_type.trim(), source: body.source, cases: body.cases }, scope.tenant.membershipId);
    await scope.audit({ action: 'llm.eval_dataset_created', resourceType: DATASET, resourceId: created.id, diff: { dataset_code: created.datasetCode, revision: created.revision, source: created.source, case_count: created.caseCount, injection_cases: created.injectionCases } });
    await scope.emit({
      aggregateType: DATASET,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'llm.eval_dataset.created.v1',
      schemaVersion: 1,
      payload: { dataset_version_id: created.id, dataset_code: created.datasetCode, revision: created.revision, case_count: created.caseCount },
      eventKey: `${DATASET}:${created.id}:${created.version}`,
    });
    return { ...commandResult(scope, 'APPROVED', created.version, created.id), revision: created.revision };
  }

  @Get('ai-eval-datasets')
  @OperationId('listAiEvalDatasets')
  async datasets(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Page> {
    this.whole(access, PERMISSIONS.listAiEvalDatasets);
    return page((await this.database.withTenant(tenant, (tx) => this.evals.datasets(tx))).map(datasetView));
  }

  // ---- profiles ----------------------------------------------------------------------------------------------------------------------------

  @Post('model-profiles')
  @HttpCode(200)
  @OperationId('createModelProfileVersion')
  @Command({ operation: 'createModelProfileVersion' })
  async draftProfile(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LlmProfileDraft']): Promise<CommandResult & { revision: number }> {
    this.whole(access, PERMISSIONS.createModelProfileVersion);
    const ids = body.allowed_model_ids.map((id) => asUuid(id));
    const prompt = asUuid(body.prompt_version_id);
    const rollback = body.rollback_profile_id === undefined ? null : (asUuid(body.rollback_profile_id) ?? null);
    if (ids.some((id) => id === undefined)) throw new DomainError('VALIDATION_FAILED', 422, 'allowed_model_ids');
    if (prompt === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'prompt_version_id');
    if (body.rollback_profile_id !== undefined && rollback === null) throw new DomainError('VALIDATION_FAILED', 422, 'rollback_profile_id');
    const effort = body.effort === undefined || body.effort === '' ? null : body.effort;
    const created = await this.evals.draftProfile(scope.tx, {
      taskType: body.task_type.trim(),
      modelId: body.model_id.trim(),
      allowedModelIds: ids as string[],
      effort,
      outputCap: body.output_cap,
      maxInputTokens: body.max_input_tokens,
      timeoutMs: body.timeout_ms,
      concurrencyLimit: body.concurrency_limit,
      outputSchema: body.output_schema,
      toolAllowlist: body.tool_allowlist,
      maxClassification: body.max_classification,
      routingPolicy: body.routing_policy,
      promptVersionId: prompt,
      rollbackProfileId: rollback,
      retentionDays: body.retention_days,
      actor: scope.tenant.membershipId,
    });
    await scope.audit({ action: 'llm.profile_drafted', resourceType: PROFILE, resourceId: created.id, diff: { task_type: created.taskType, revision: created.revision, routes: created.routingPolicy.routes, max_classification: created.maxClassification, prompt_version_id: created.promptVersionId } });
    await scope.emit({
      aggregateType: PROFILE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'llm.profile.drafted.v1',
      schemaVersion: 1,
      payload: { profile_version_id: created.id, task_type: created.taskType, revision: created.revision, routes: created.routingPolicy.routes },
      eventKey: `${PROFILE}:${created.id}:${created.version}`,
    });
    return { ...commandResult(scope, 'DRAFT', created.version, created.id), revision: created.revision };
  }

  @Post('model-profiles/:id/publish')
  @HttpCode(200)
  @OperationId('post_model_profiles_id_publish')
  @Command({ operation: 'post_model_profiles_id_publish', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['Decision']): Promise<CommandResult & { evidence_run_ids: string[] }> {
    this.whole(access, PERMISSIONS.post_model_profiles_id_publish);
    const reason = body.reason.trim();
    if (reason === '') throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const evidence = body.evidence_ids.map((entry) => asUuid(entry));
    if (evidence.some((entry) => entry === undefined)) throw new DomainError('VALIDATION_FAILED', 422, 'evidence_ids');
    // Only publishing and sending back are decisions of this step; a profile that is not wanted is left as a draft, and going back from a published one is a step of its own.
    if (body.decision === 'reject') throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    if (body.decision === 'return') {
      const returned = await this.evals.returnProfile(scope.tx, id, scope.expectedVersion ?? 0);
      await scope.audit({ action: 'llm.profile_returned', resourceType: PROFILE, resourceId: id, diff: { revision: returned.revision, reason: scrubSecrets(reason) } });
      await scope.emit({
        aggregateType: PROFILE,
        aggregateId: id,
        aggregateVersion: returned.version,
        type: 'llm.profile.returned.v1',
        schemaVersion: 1,
        payload: { profile_version_id: id, revision: returned.revision },
        eventKey: `${PROFILE}:${id}:${returned.version}`,
      });
      return { ...commandResult(scope, 'DRAFT', returned.version, id), evidence_run_ids: [] };
    }
    const published = await this.evals.publish(scope.tx, id, { actor: scope.tenant.membershipId, expectedVersion: scope.expectedVersion ?? 0, evidenceIds: evidence as string[], now: new Date() });
    await scope.audit({
      action: 'llm.profile_published',
      resourceType: PROFILE,
      resourceId: id,
      diff: {
        task_type: published.profile.taskType,
        revision: published.profile.revision,
        routes: published.profile.routingPolicy.routes,
        eval_run_ids: published.evidence,
        superseded_profile_id: published.superseded?.id ?? null,
        rollback_profile_id: published.profile.rollbackProfileId,
        reason: scrubSecrets(reason),
      },
    });
    await scope.emit({
      aggregateType: PROFILE,
      aggregateId: id,
      aggregateVersion: published.profile.version,
      type: 'llm.profile.published.v1',
      schemaVersion: 1,
      payload: { profile_version_id: id, task_type: published.profile.taskType, revision: published.profile.revision, eval_run_ids: published.evidence, superseded_profile_id: published.superseded?.id ?? null },
      eventKey: `${PROFILE}:${id}:${published.profile.version}`,
    });
    return { ...commandResult(scope, 'PUBLISHED', published.profile.version, id), evidence_run_ids: published.evidence };
  }

  @Get('resources/model_profile_version')
  @OperationId('get_resources_model_profile_version')
  async profiles(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Page> {
    this.whole(access, PERMISSIONS.get_resources_model_profile_version);
    return page((await this.database.withTenant(tenant, (tx) => this.evals.profiles(tx))).map(profileView));
  }

  @Get('resources/model_profile_version/:id')
  @OperationId('get_resources_model_profile_version_id')
  async profile(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.get_resources_model_profile_version_id);
    const row = await this.database.withTenant(tenant, (tx) => this.evals.findProfile(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return profileView(row);
  }

  // ---- runs --------------------------------------------------------------------------------------------------------------------------------

  @Post('ai-eval-runs')
  @HttpCode(200)
  @OperationId('startAiEvalRun')
  @Command({ operation: 'startAiEvalRun' })
  async startRun(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LlmEvalStart']): Promise<CommandResult & { passed: boolean | null; failures: string[] }> {
    this.whole(access, PERMISSIONS.startAiEvalRun);
    const profileId = asUuid(body.profile_version_id);
    const datasetId = asUuid(body.dataset_version_id);
    if (profileId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'profile_version_id');
    if (datasetId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'dataset_version_id');
    const plan = await this.evals.planRun(scope.tx, { profileId, datasetId, route: body.route_class });
    const startedAt = new Date();
    let outcome: Awaited<ReturnType<EvalRunnerPort['run']>> | { failed: true };
    try {
      outcome = await this.runner.run({ route: plan.route, providerModelId: plan.providerModelId, promptTemplateKey: plan.promptTemplateKey, cases: plan.cases });
    } catch (error) {
      // The failure of the runner is kept as a run that did not finish (it cannot be signed); what the service said is not, because it can carry a key.
      outcome = { failed: true };
      process.stderr.write(`${scrubSecrets(`llm eval: the runner failed with ${error instanceof Error ? error.constructor.name : 'UnknownError'} for profile ${plan.profile.id}`)}\n`);
    }
    const run = await this.evals.recordRun(scope.tx, plan, outcome, scope.tenant.membershipId, startedAt);
    await scope.audit({
      action: 'llm.eval_run_started',
      resourceType: RUN,
      resourceId: run.id,
      diff: { profile_version_id: profileId, dataset_version_id: datasetId, route_class: plan.route, passed: run.passed, failures: (run.results as { failures?: string[] }).failures ?? [], status: run.status },
    });
    await scope.emit({
      aggregateType: RUN,
      aggregateId: run.id,
      aggregateVersion: run.version,
      type: 'llm.eval_run.started.v1',
      schemaVersion: 1,
      payload: { eval_run_id: run.id, profile_version_id: profileId, route_class: plan.route, passed: run.passed },
      eventKey: `${RUN}:${run.id}:${run.version}`,
    });
    return { ...commandResult(scope, run.status, run.version, run.id), passed: run.passed, failures: (run.results as { failures?: string[] }).failures ?? [] };
  }

  @Post('ai-eval-runs/:id/signature')
  @HttpCode(200)
  @OperationId('signAiEvalRun')
  @Command({ operation: 'signAiEvalRun', versioned: true })
  async signRun(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['LlmEvalSign']): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.signAiEvalRun);
    const comment = body.comment.trim();
    if (comment.length < 10) throw new DomainError('VALIDATION_FAILED', 422, 'comment');
    const run = await this.evals.signRun(scope.tx, id, { decision: body.decision, comment: scrubSecrets(comment), actor: scope.tenant.membershipId, expectedVersion: scope.expectedVersion ?? 0 });
    await scope.audit({ action: 'llm.eval_run_signed', resourceType: RUN, resourceId: id, diff: { profile_version_id: run.profileVersionId, route_class: run.route, decision: body.decision, passed: run.passed } });
    await scope.emit({
      aggregateType: RUN,
      aggregateId: id,
      aggregateVersion: run.version,
      type: 'llm.eval_run.signed.v1',
      schemaVersion: 1,
      payload: { eval_run_id: id, profile_version_id: run.profileVersionId, route_class: run.route, decision: body.decision },
      eventKey: `${RUN}:${id}:${run.version}`,
    });
    return commandResult(scope, run.status, run.version, id);
  }

  @Get('resources/ai_eval_run')
  @OperationId('get_resources_ai_eval_run')
  async runs(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('profile_version_id') profileId?: unknown): Promise<Page> {
    this.whole(access, PERMISSIONS.get_resources_ai_eval_run);
    const profile = profileId === undefined ? undefined : asUuid(String(profileId));
    if (profileId !== undefined && profile === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'profile_version_id');
    return page((await this.database.withTenant(tenant, (tx) => this.evals.runs(tx, { profileId: profile }))).map(runView));
  }

  @Get('resources/ai_eval_run/:id')
  @OperationId('get_resources_ai_eval_run_id')
  async run(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.get_resources_ai_eval_run_id);
    const row = await this.database.withTenant(tenant, (tx) => this.evals.findRun(tx, id));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return runView(row);
  }
}
