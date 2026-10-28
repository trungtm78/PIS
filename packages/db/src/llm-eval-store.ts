import { randomUUID } from 'node:crypto';
import {
  CLASSIFICATIONS,
  DomainError,
  assertDatasetDraft,
  assertProfileDraft,
  assertPromptDraft,
  assertSignable,
  judgeMetrics,
  metricsJson,
  parseRoutingPolicy,
  releaseGate,
  routesFor,
  thresholdsJson,
} from '@machvon/kernel';
import type { Classification, EvalCase, EvalMetrics, EvalStatus, Route, RunView, Thresholds } from '@machvon/kernel';
import { LlmRegistryStore } from './llm-registry-store.ts';
import type { TenantTx } from './tenant-database.ts';

interface Sql {
  [column: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ---- views --------------------------------------------------------------------------------------------------------------------------------

export interface PromptRow {
  id: string;
  taskType: string;
  name: string;
  revision: number;
  templateObjectKey: string;
  templateSha256: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  label: string | null;
  status: string;
  approvedBy: string | null;
  createdBy: string;
  createdAt: string;
  version: number;
}

export interface EvalDatasetRow {
  id: string;
  datasetCode: string;
  revision: number;
  taskType: string;
  source: string;
  maxClassification: Classification;
  caseCount: number;
  injectionCases: number;
  status: string;
  createdBy: string;
  createdAt: string;
  version: number;
}

export interface ProfileRow {
  id: string;
  taskType: string;
  revision: number;
  modelId: string;
  effort: string | null;
  outputCap: number;
  routingPolicy: { routes: Route[]; thresholds: Record<string, number> };
  status: string;
  allowedModelIds: string[];
  maxInputTokens: number | null;
  timeoutMs: number | null;
  concurrencyLimit: number | null;
  outputSchema: Record<string, unknown> | null;
  toolAllowlist: string[];
  maxClassification: Classification | null;
  promptVersionId: string | null;
  rollbackProfileId: string | null;
  retentionDays: number | null;
  approvedBy: string | null;
  createdBy: string | null;
  effectiveAt: string | null;
  createdAt: string;
  version: number;
}

export interface EvalRunRow {
  id: string;
  profileVersionId: string;
  datasetVersionId: string;
  route: Route | null;
  modelRefId: string | null;
  metrics: Record<string, number> | null;
  thresholds: Record<string, number> | null;
  passed: boolean | null;
  status: EvalStatus;
  costVnd: string;
  startedBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  signedBy: string | null;
  signedAt: string | null;
  results: Record<string, unknown>;
  version: number;
}

const PROMPT = `select id, task_type, name, revision, template_object_key, template_sha256, input_schema, output_schema, label, status, approved_by, created_by, created_at, version::text as version from machvon.ai_prompt_version`;
const DATASET = `select d.id, d.dataset_code, d.revision, d.task_type, d.source, d.max_classification, d.case_count, d.status, d.created_by, d.created_at, d.version::text as version,
    (select count(*) from machvon.ai_eval_case c where c.dataset_version_id = d.id and c.tags @> '["injection"]'::jsonb)::int as injection_cases from machvon.ai_eval_dataset_version d`;
const PROFILE = `select id, task_type, revision, model_id, effort, output_cap, routing_policy, status, allowed_model_ids, max_input_tokens, timeout_ms, concurrency_limit, output_schema, tool_allowlist, max_classification,
    prompt_version_id, rollback_profile_id, retention_days, approved_by, created_by, effective_at, created_at, version::text as version from machvon.model_profile_version`;
const RUN = `select id, profile_version_id, dataset_version_id, route_class, model_ref_id, metrics_json, thresholds_json, passed, review_status, cost::text as cost, started_by, started_at, finished_at, signed_by, signed_at, results_json,
    version::text as version from machvon.ai_eval_run`;

const iso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string).toISOString());
const promptOf = (row: Sql): PromptRow => ({
  id: row.id,
  taskType: row.task_type,
  name: row.name,
  revision: row.revision,
  templateObjectKey: row.template_object_key,
  templateSha256: row.template_sha256,
  inputSchema: row.input_schema,
  outputSchema: row.output_schema,
  label: row.label,
  status: row.status,
  approvedBy: row.approved_by,
  createdBy: row.created_by,
  createdAt: iso(row.created_at) as string,
  version: Number(row.version),
});
const datasetOf = (row: Sql): EvalDatasetRow => ({
  id: row.id,
  datasetCode: row.dataset_code,
  revision: row.revision,
  taskType: row.task_type,
  source: row.source,
  maxClassification: row.max_classification,
  caseCount: row.case_count,
  injectionCases: row.injection_cases,
  status: row.status,
  createdBy: row.created_by,
  createdAt: iso(row.created_at) as string,
  version: Number(row.version),
});
const profileOf = (row: Sql): ProfileRow => ({
  id: row.id,
  taskType: row.task_type,
  revision: row.revision,
  modelId: row.model_id,
  effort: row.effort,
  outputCap: row.output_cap,
  routingPolicy: row.routing_policy,
  status: row.status,
  allowedModelIds: row.allowed_model_ids ?? [],
  maxInputTokens: row.max_input_tokens,
  timeoutMs: row.timeout_ms,
  concurrencyLimit: row.concurrency_limit,
  outputSchema: row.output_schema,
  toolAllowlist: row.tool_allowlist ?? [],
  maxClassification: row.max_classification,
  promptVersionId: row.prompt_version_id,
  rollbackProfileId: row.rollback_profile_id,
  retentionDays: row.retention_days,
  approvedBy: row.approved_by,
  createdBy: row.created_by,
  effectiveAt: iso(row.effective_at),
  createdAt: iso(row.created_at) as string,
  version: Number(row.version),
});
const runOf = (row: Sql): EvalRunRow => ({
  id: row.id,
  profileVersionId: row.profile_version_id,
  datasetVersionId: row.dataset_version_id,
  route: row.route_class,
  modelRefId: row.model_ref_id,
  metrics: row.metrics_json,
  thresholds: row.thresholds_json,
  passed: row.passed,
  status: row.review_status,
  costVnd: String(row.cost).replace(/\.0+$/, ''),
  startedBy: row.started_by,
  startedAt: iso(row.started_at),
  finishedAt: iso(row.finished_at),
  signedBy: row.signed_by,
  signedAt: iso(row.signed_at),
  results: row.results_json ?? {},
  version: Number(row.version),
});

const lock = (tx: TenantTx, key: string): Promise<unknown> =>
  tx.query("select pg_advisory_xact_lock(hashtextextended('llm_eval:' || current_setting('app.tenant_id', true) || ':' || $1, 0))", [key]);

export interface PromptInput {
  taskType: string;
  name: string;
  templateObjectKey: string;
  templateSha256: string;
  inputSchema: unknown;
  outputSchema: unknown;
}

export interface ProfileInput {
  taskType: string;
  modelId: string;
  allowedModelIds: string[];
  effort: string | null;
  outputCap: number;
  maxInputTokens: number;
  timeoutMs: number;
  concurrencyLimit: number;
  outputSchema: unknown;
  toolAllowlist: string[];
  maxClassification: string;
  routingPolicy: unknown;
  promptVersionId: string;
  rollbackProfileId: string | null;
  retentionDays: number;
  actor: string;
}

/** What the run of a route needs before it starts: the profile, the dataset, its cases and the model the route reaches. */
export interface RunPlan {
  profile: ProfileRow;
  dataset: EvalDatasetRow;
  cases: EvalCase[];
  route: Route;
  modelRefId: string;
  providerModelId: string;
  promptTemplateKey: string;
  thresholds: Thresholds;
}

/**
 * The evaluation gate of the AI gateway (ST-LLM-004, LLM F4): prompts that are approved by another person and then never change, evaluation datasets of synthetic or anonymised cases, model profiles, the run of a
 * dataset on one route of a profile and its signature by an expert, and the publication of a profile only when every route it may use has a signed passing evaluation (BR-LLM-08).
 */
/** A model is sent nothing above the class it takes: every model of a profile takes the class the profile takes. */
function assertCeilings(models: ReadonlyArray<{ id: string; maxClassification: Classification }>, level: Classification): void {
  const low = models.find((model) => CLASSIFICATIONS.indexOf(model.maxClassification) < CLASSIFICATIONS.indexOf(level));
  if (low !== undefined) throw new DomainError('CLASSIFICATION_ABOVE_PROVIDER', 422, low.id);
}

interface RouteModel {
  id: string;
  modelId: string;
  status: string;
  route: Route;
  providerStatus: string;
  maxClassification: Classification;
}

/** The model that serves a route of a profile: one that can be used on an active provider, the primary one of the profile when it reaches the route and else the first of the models the profile lists. The same on every call. */
function modelForRoute(profile: { modelId: string; allowedModelIds: readonly string[] }, models: readonly RouteModel[], route: Route): RouteModel | undefined {
  const usable = models.filter((candidate) => candidate.route === route && candidate.providerStatus === 'ACTIVE' && candidate.status !== 'SUSPENDED' && candidate.status !== 'RETIRED');
  // Two entries of the registry can share the identifier of the primary model (another provider, another version): the one listed first is the primary, and the order of the list, then the id, settle every other tie.
  const place = (model: RouteModel): number => profile.allowedModelIds.indexOf(model.id);
  const order = (left: RouteModel, right: RouteModel): number =>
    Number(right.modelId === profile.modelId) - Number(left.modelId === profile.modelId) || place(left) - place(right) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return [...usable].sort(order)[0];
}

export class LlmEvalStore {
  // ---- prompts -----------------------------------------------------------------------------------------------------------------------------

  async prompts(tx: TenantTx): Promise<PromptRow[]> {
    return (await tx.query<Sql>(`${PROMPT} order by task_type, name, revision desc`)).map(promptOf);
  }

  async findPrompt(tx: TenantTx, id: string, forUpdate = false): Promise<PromptRow | undefined> {
    const rows = await tx.query<Sql>(`${PROMPT} where id = $1::uuid${forUpdate ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : promptOf(rows[0]);
  }

  async createPrompt(tx: TenantTx, input: PromptInput, actor: string): Promise<PromptRow> {
    assertPromptDraft(input);
    await lock(tx, `prompt:${input.taskType}:${input.name}`);
    const last = await tx.query<{ revision: number | null }>('select max(revision) as revision from machvon.ai_prompt_version where task_type = $1 and name = $2', [input.taskType, input.name]);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.ai_prompt_version (tenant_id, id, task_type, name, revision, template_object_key, template_sha256, input_schema, output_schema, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::int, $5, $6, $7::jsonb, $8::jsonb, 'DRAFT', $9::uuid, $9::uuid)`,
      [id, input.taskType, input.name, (last[0]?.revision ?? 0) + 1, input.templateObjectKey, input.templateSha256, JSON.stringify(input.inputSchema), JSON.stringify(input.outputSchema), actor],
    );
    return (await this.findPrompt(tx, id)) as PromptRow;
  }

  /** Edits the draft of a prompt; one that was approved is not edited (PROMPT_IMMUTABLE), a new revision is made. */
  async revisePrompt(tx: TenantTx, id: string, input: PromptInput, expectedVersion: number, actor: string): Promise<PromptRow> {
    const prompt = await this.findPrompt(tx, id, true);
    if (prompt === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (prompt.status !== 'DRAFT') throw new DomainError('PROMPT_IMMUTABLE', 409, 'status');
    if (prompt.version !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409);
    // A draft is its author's: someone else who changed it could then approve their own text, so another person makes a draft of their own.
    if (prompt.createdBy !== actor) throw new DomainError('SCOPE_DENIED', 403, 'created_by');
    // A draft keeps what names it: the task, the name and the number of its revision.
    if (input.taskType !== prompt.taskType || input.name !== prompt.name) throw new DomainError('VALIDATION_FAILED', 422, 'name');
    assertPromptDraft(input);
    await tx.query(
      'update machvon.ai_prompt_version set template_object_key = $2, template_sha256 = $3, input_schema = $4::jsonb, output_schema = $5::jsonb, updated_at = now(), updated_by = $6::uuid, version = version + 1 where id = $1::uuid',
      [id, input.templateObjectKey, input.templateSha256, JSON.stringify(input.inputSchema), JSON.stringify(input.outputSchema), actor],
    );
    return (await this.findPrompt(tx, id)) as PromptRow;
  }

  /** Approves a draft by someone other than its author: it becomes the PRODUCTION revision of its name, and the one that was becomes RETIRED. */
  async approvePrompt(tx: TenantTx, id: string, expectedVersion: number, actor: string): Promise<{ prompt: PromptRow; retired: PromptRow | undefined }> {
    const prompt = await this.findPrompt(tx, id, true);
    if (prompt === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (prompt.version !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409);
    if (prompt.status !== 'DRAFT') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    if (prompt.createdBy === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    await lock(tx, `prompt:${prompt.taskType}:${prompt.name}`);
    const before = await tx.query<Sql>(`${PROMPT} where task_type = $1 and name = $2 and label = 'PRODUCTION' and id <> $3::uuid for update`, [prompt.taskType, prompt.name, id]);
    for (const row of before) await tx.query("update machvon.ai_prompt_version set status = 'RETIRED', label = null, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [row.id, actor]);
    await tx.query("update machvon.ai_prompt_version set status = 'APPROVED', label = 'PRODUCTION', approved_by = $2::uuid, updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = $1::uuid", [id, actor]);
    return { prompt: (await this.findPrompt(tx, id)) as PromptRow, retired: before[0] === undefined ? undefined : promptOf(before[0]) };
  }

  // ---- datasets ----------------------------------------------------------------------------------------------------------------------------

  async datasets(tx: TenantTx): Promise<EvalDatasetRow[]> {
    return (await tx.query<Sql>(`${DATASET} order by d.dataset_code, d.revision desc`)).map(datasetOf);
  }

  async findDataset(tx: TenantTx, id: string): Promise<EvalDatasetRow | undefined> {
    const rows = await tx.query<Sql>(`${DATASET} where d.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : datasetOf(rows[0]);
  }

  async casesOf(tx: TenantTx, datasetId: string): Promise<EvalCase[]> {
    const rows = await tx.query<Sql>('select case_code, input_ref, expected_json, classification, tags from machvon.ai_eval_case where dataset_version_id = $1::uuid order by case_code', [datasetId]);
    return rows.map((row) => ({ caseCode: row.case_code, inputRef: row.input_ref, expected: row.expected_json, classification: row.classification, tags: row.tags }));
  }

  /** Makes the next revision of a dataset from its cases. It is made from synthetic or anonymised cases only; it needs no approval of its own, the evaluation that uses it is signed. */
  async createDataset(tx: TenantTx, input: { datasetCode: string; taskType: string; source: string; cases: readonly unknown[] }, actor: string): Promise<EvalDatasetRow> {
    const made = assertDatasetDraft(input);
    await lock(tx, `dataset:${input.datasetCode}`);
    const last = await tx.query<{ revision: number | null }>('select max(revision) as revision from machvon.ai_eval_dataset_version where dataset_code = $1', [input.datasetCode]);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.ai_eval_dataset_version (tenant_id, id, dataset_code, revision, task_type, source, max_classification, case_count, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::int, $4, $5, $6, $7::int, 'APPROVED', $8::uuid, $8::uuid)`,
      [id, input.datasetCode, (last[0]?.revision ?? 0) + 1, input.taskType, input.source, made.maxClassification, made.cases.length, actor],
    );
    for (const entry of made.cases) {
      await tx.query(
        `insert into machvon.ai_eval_case (tenant_id, id, dataset_version_id, case_code, input_ref, expected_json, classification, tags)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3, $4::jsonb, $5, $6::jsonb)`,
        [id, entry.caseCode, entry.inputRef, JSON.stringify(entry.expected), entry.classification, JSON.stringify(entry.tags)],
      );
    }
    return (await this.findDataset(tx, id)) as EvalDatasetRow;
  }

  // ---- profiles ----------------------------------------------------------------------------------------------------------------------------

  async profiles(tx: TenantTx): Promise<ProfileRow[]> {
    return (await tx.query<Sql>(`${PROFILE} order by task_type, revision desc`)).map(profileOf);
  }

  /** The routes of the profile are routes of the policy in force for the class of data it takes. */
  private async assertRoutesInForce(tx: TenantTx, level: Classification, routes: readonly Route[]): Promise<void> {
    const inForce = await new LlmRegistryStore().published(tx);
    const allowed = routesFor(level, inForce === undefined ? undefined : { matrix: inForce.matrix, internationalEnabled: inForce.internationalEnabled });
    const refused = routes.find((route) => !allowed.includes(route));
    if (refused !== undefined) throw new DomainError('AI_ROUTE_NOT_ALLOWED', 422, refused);
  }

  async findProfile(tx: TenantTx, id: string, forUpdate = false): Promise<ProfileRow | undefined> {
    const rows = await tx.query<Sql>(`${PROFILE} where id = $1::uuid${forUpdate ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : profileOf(rows[0]);
  }

  /** The models a profile may use with the route of the provider of each and what each takes. */
  private async modelsOf(tx: TenantTx, ids: readonly string[]): Promise<Array<{ id: string; modelId: string; status: string; route: Route; providerStatus: string; supportsEffort: boolean; maxClassification: Classification }>> {
    if (ids.length === 0) return [];
    const rows = await tx.query<Sql>(
      `select m.id, m.model_id, m.status, m.max_classification, p.route_class, p.status as provider_status, m.capabilities from machvon.ai_model m join machvon.ai_provider p on p.id = m.provider_id where m.id = any($1::uuid[])`,
      [[...ids]],
    );
    return rows.map((row) => ({ id: row.id, modelId: row.model_id, status: row.status, route: row.route_class, providerStatus: row.provider_status, supportsEffort: row.capabilities?.reasoning === true, maxClassification: row.max_classification }));
  }

  /**
   * Drafts the next revision of a profile of a task. The models must exist and not be suspended or retired (they are approved by the time it is published), each route of the policy must be reachable through one of them,
   * the prompt must be an approved one, an effort only when every model takes it, and the tools only read. A draft is not served: it waits for an evaluation of each route.
   */
  async draftProfile(tx: TenantTx, input: ProfileInput): Promise<ProfileRow> {
    assertProfileDraft({
      effort: input.effort,
      outputCap: input.outputCap,
      maxInputTokens: input.maxInputTokens,
      timeoutMs: input.timeoutMs,
      concurrencyLimit: input.concurrencyLimit,
      retentionDays: input.retentionDays,
      toolAllowlist: input.toolAllowlist,
      outputSchema: input.outputSchema,
      allowedModelIds: input.allowedModelIds,
      maxClassification: input.maxClassification,
    });
    const policy = parseRoutingPolicy(input.routingPolicy, input.maxClassification);
    const models = await this.modelsOf(tx, input.allowedModelIds);
    if (models.length !== input.allowedModelIds.length) throw new DomainError('VALIDATION_FAILED', 422, 'allowed_model_ids');
    const unusable = models.find((model) => model.status === 'SUSPENDED' || model.status === 'RETIRED');
    if (unusable !== undefined) throw new DomainError('MODEL_NOT_APPROVED', 422, unusable.id);
    if (!models.some((model) => model.modelId === input.modelId)) throw new DomainError('VALIDATION_FAILED', 422, 'model_id');
    assertCeilings(models, input.maxClassification as Classification);
    if (input.effort !== null && models.some((model) => !model.supportsEffort)) throw new DomainError('UNSUPPORTED_PARAMETER', 422, 'effort');
    const unreachable = policy.routes.find((route) => !models.some((model) => model.route === route));
    if (unreachable !== undefined) throw new DomainError('AI_ROUTE_NOT_ALLOWED', 422, unreachable);
    const prompt = await this.findPrompt(tx, input.promptVersionId);
    if (prompt === undefined || prompt.status !== 'APPROVED' || prompt.taskType !== input.taskType) throw new DomainError('VALIDATION_FAILED', 422, 'prompt_version_id');
    if (input.rollbackProfileId !== null) {
      const target = await this.findProfile(tx, input.rollbackProfileId);
      if (target === undefined || target.taskType !== input.taskType) throw new DomainError('VALIDATION_FAILED', 422, 'rollback_profile_id');
    }
    await lock(tx, `profile:${input.taskType}`);
    const last = await tx.query<{ revision: number | null }>('select max(revision) as revision from machvon.model_profile_version where task_type = $1', [input.taskType]);
    const id = randomUUID();
    await tx.query(
      `insert into machvon.model_profile_version (tenant_id, id, task_type, revision, model_id, effort, output_cap, routing_policy, status, allowed_model_ids, max_input_tokens, timeout_ms, concurrency_limit, output_schema, tool_allowlist,
         max_classification, prompt_version_id, rollback_profile_id, retention_days, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::int, $4, $5, $6::int, $7::jsonb, 'DRAFT', $8::jsonb, $9::int, $10::int, $11::int, $12::jsonb, $13::jsonb, $14, $15::uuid, $16::uuid, $17::int, $18::uuid)`,
      [
        id,
        input.taskType,
        (last[0]?.revision ?? 0) + 1,
        input.modelId,
        input.effort,
        input.outputCap,
        JSON.stringify({ routes: policy.routes, thresholds: thresholdsJson(policy.thresholds) }),
        JSON.stringify(input.allowedModelIds),
        input.maxInputTokens,
        input.timeoutMs,
        input.concurrencyLimit,
        JSON.stringify(input.outputSchema),
        JSON.stringify(input.toolAllowlist),
        input.maxClassification,
        input.promptVersionId,
        input.rollbackProfileId,
        input.retentionDays,
        input.actor,
      ],
    );
    return (await this.findProfile(tx, id)) as ProfileRow;
  }

  // ---- runs --------------------------------------------------------------------------------------------------------------------------------

  async runs(tx: TenantTx, filter: { profileId?: string | undefined } = {}): Promise<EvalRunRow[]> {
    return (await tx.query<Sql>(`${RUN} where ($1::uuid is null or profile_version_id = $1::uuid) order by started_at desc nulls last, id`, [filter.profileId ?? null])).map(runOf);
  }

  async findRun(tx: TenantTx, id: string, forUpdate = false): Promise<EvalRunRow | undefined> {
    const rows = await tx.query<Sql>(`${RUN} where id = $1::uuid${forUpdate ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : runOf(rows[0]);
  }

  /** What a run of a route needs, and whether it may begin: the route is one of the profile, a model of the profile on an active provider reaches it, and the dataset is one of its task with an injection case. */
  async planRun(tx: TenantTx, input: { profileId: string; datasetId: string; route: Route }): Promise<RunPlan> {
    const profile = await this.findProfile(tx, input.profileId, true);
    if (profile === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (profile.status !== 'DRAFT' && profile.status !== 'EVAL_PENDING') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    if (!profile.routingPolicy.routes.includes(input.route)) throw new DomainError('AI_ROUTE_NOT_ALLOWED', 422, input.route);
    const dataset = await this.findDataset(tx, input.datasetId);
    if (dataset === undefined || dataset.status !== 'APPROVED' || dataset.taskType !== profile.taskType) throw new DomainError('VALIDATION_FAILED', 422, 'dataset_version_id');
    // The international route sees public cases only; an evaluation set of the tenant has none of a higher class (EVAL_CASE_CLASSIFICATION_INVALID), but the rule is kept where the route is chosen.
    if (input.route === 'INTERNATIONAL' && dataset.maxClassification !== 'PUBLIC') throw new DomainError('AI_ROUTE_NOT_ALLOWED', 422, 'dataset_version_id');
    if (dataset.injectionCases < 1) throw new DomainError('VALIDATION_FAILED', 422, 'dataset_version_id');
    const models = await this.modelsOf(tx, profile.allowedModelIds);
    const model = modelForRoute(profile, models, input.route);
    if (model === undefined) throw new DomainError('AI_ROUTE_NOT_ALLOWED', 422, input.route);
    // The tenant's published policy decides which routes the class of data of the profile may take (no policy: the baseline with the international route off), and a model is sent nothing above what it takes.
    await this.assertRoutesInForce(tx, profile.maxClassification ?? 'PUBLIC', [input.route]);
    if (CLASSIFICATIONS.indexOf(dataset.maxClassification) > CLASSIFICATIONS.indexOf(model.maxClassification)) throw new DomainError('CLASSIFICATION_ABOVE_PROVIDER', 422, 'dataset_version_id');
    assertCeilings([model], profile.maxClassification ?? 'PUBLIC');
    const prompt = profile.promptVersionId === null ? undefined : await this.findPrompt(tx, profile.promptVersionId);
    if (prompt === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'prompt_version_id');
    const policy = parseRoutingPolicy({ routes: profile.routingPolicy.routes, thresholds: profile.routingPolicy.thresholds }, profile.maxClassification ?? 'PUBLIC');
    return { profile, dataset, cases: await this.casesOf(tx, dataset.id), route: input.route, modelRefId: model.id, providerModelId: model.modelId, promptTemplateKey: prompt.templateObjectKey, thresholds: policy.thresholds };
  }

  /** Records a run that was made, with its metrics judged against the thresholds; the run it replaces for the same profile, dataset and route is set aside. */
  async recordRun(tx: TenantTx, plan: RunPlan, result: { metrics: EvalMetrics; costVnd: string } | { failed: true }, actor: string, startedAt: Date): Promise<EvalRunRow> {
    await lock(tx, `run:${plan.profile.id}:${plan.dataset.id}:${plan.route}`);
    await tx.query("update machvon.ai_eval_run set review_status = 'SUPERSEDED', version = version + 1 where profile_version_id = $1::uuid and dataset_version_id = $2::uuid and route_class = $3 and review_status <> 'SUPERSEDED'", [plan.profile.id, plan.dataset.id, plan.route]);
    const id = randomUUID();
    const failed = 'failed' in result;
    const judged = failed ? undefined : judgeMetrics(result.metrics, plan.thresholds);
    await tx.query(
      `insert into machvon.ai_eval_run (tenant_id, id, profile_version_id, dataset_version_id, results_json, cost, review_status, route_class, model_ref_id, metrics_json, thresholds_json, passed, started_by, started_at, finished_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::numeric, $6, $7, $8::uuid, $9::jsonb, $10::jsonb, $11, $12::uuid, $13::timestamptz, $14::timestamptz)`,
      [
        id,
        plan.profile.id,
        plan.dataset.id,
        JSON.stringify({ case_count: plan.cases.length, injection_cases: plan.dataset.injectionCases, failures: judged?.failures ?? [], run_failed: failed }),
        failed ? '0' : result.costVnd,
        failed ? 'FAILED' : 'PENDING_SIGNATURE',
        plan.route,
        plan.modelRefId,
        failed ? null : JSON.stringify(metricsJson(result.metrics)),
        JSON.stringify(thresholdsJson(plan.thresholds)),
        judged?.passed ?? null,
        actor,
        startedAt.toISOString(),
        failed ? null : new Date().toISOString(),
      ],
    );
    if (plan.profile.status === 'DRAFT') await tx.query("update machvon.model_profile_version set status = 'EVAL_PENDING', version = version + 1 where id = $1::uuid", [plan.profile.id]);
    return (await this.findRun(tx, id)) as EvalRunRow;
  }

  /** Signs a finished run as a pass or a fail by someone other than the person who started it; a pass is signed only over metrics that met the thresholds. */
  async signRun(tx: TenantTx, id: string, input: { decision: 'PASS' | 'FAIL'; comment: string; actor: string; expectedVersion: number }): Promise<EvalRunRow> {
    const run = await this.findRun(tx, id, true);
    if (run === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (run.version !== input.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409);
    assertSignable({ status: run.status, passed: run.passed, finished: run.finishedAt !== null }, input.decision, run.startedBy, input.actor);
    await tx.query(
      "update machvon.ai_eval_run set review_status = $2, signed_by = $3::uuid, signed_at = now(), results_json = results_json || $4::jsonb, version = version + 1 where id = $1::uuid",
      [id, input.decision === 'PASS' ? 'SIGNED_PASS' : 'SIGNED_FAIL', input.actor, JSON.stringify({ signature: { decision: input.decision, comment: input.comment } })],
    );
    return (await this.findRun(tx, id)) as EvalRunRow;
  }

  // ---- the release ---------------------------------------------------------------------------------------------------------------------------

  /**
   * Publishes a profile in place of the one in force for its task: the gate is the kernel's (models approved and taking what is sent, an evaluation run, a signed pass for every route), the person who publishes is not
   * the one who drafted it, and the profile that was PUBLISHED becomes SUPERSEDED and the target of the rollback of the new one. The ids of the runs that were relied on come back so that they are audited.
   */
  async publish(tx: TenantTx, id: string, input: { actor: string; expectedVersion: number; evidenceIds: readonly string[]; now: Date }): Promise<{ profile: ProfileRow; evidence: string[]; superseded: ProfileRow | undefined }> {
    const profile = await this.findProfile(tx, id, true);
    if (profile === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await lock(tx, `profile:${profile.taskType}`);
    if (profile.version !== input.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409);
    if (profile.status !== 'DRAFT' && profile.status !== 'EVAL_PENDING') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    const runs = await this.runs(tx, { profileId: id });
    const models = await this.modelsOf(tx, profile.allowedModelIds);
    // What was true when the profile was drafted and evaluated is judged again: the policy of the tenant may have changed since.
    assertCeilings(models, profile.maxClassification ?? 'PUBLIC');
    await this.assertRoutesInForce(tx, profile.maxClassification ?? 'PUBLIC', profile.routingPolicy.routes);
    // A route stands on the evaluation of the model that serves it (the primary one when it reaches the route, else the first of the models the profile lists): a pass of another model is not evidence.
    const served = (route: Route): string | undefined => modelForRoute(profile, models, route)?.id;
    const views: RunView[] = runs.filter((run) => run.route !== null && run.modelRefId !== null && run.modelRefId === served(run.route as Route)).map((run) => ({ id: run.id, route: run.route as Route, status: run.status, passed: run.passed }));
    const gate = releaseGate({
      routes: profile.routingPolicy.routes,
      runs: views,
      modelStatuses: models.map((model) => ({ id: model.id, status: model.status, supportsEffort: model.supportsEffort })),
      effort: profile.effort,
      createdBy: profile.createdBy ?? '',
      actor: input.actor,
    });
    if (!gate.ok) throw new DomainError(gate.code, gate.code === 'SELF_APPROVAL_DENIED' ? 403 : 422, gate.detail);
    // What the person says they rely on is among the runs the gate used: nothing else is audited as evidence.
    if (input.evidenceIds.some((evidence) => !gate.evidence.includes(evidence))) throw new DomainError('VALIDATION_FAILED', 422, 'evidence_ids');
    const inForce = await tx.query<Sql>(`${PROFILE} where task_type = $1 and status = 'PUBLISHED' for update`, [profile.taskType]);
    const superseded = inForce[0] === undefined ? undefined : profileOf(inForce[0]);
    if (superseded !== undefined) await tx.query("update machvon.model_profile_version set status = 'SUPERSEDED', version = version + 1 where id = $1::uuid", [superseded.id]);
    // A profile goes back to the one it replaced unless a target was named when it was drafted.
    const rollback = profile.rollbackProfileId ?? superseded?.id ?? null;
    await tx.query("update machvon.model_profile_version set status = 'PUBLISHED', approved_by = $2::uuid, effective_at = $3::timestamptz, rollback_profile_id = $4::uuid, version = version + 1 where id = $1::uuid", [id, input.actor, input.now.toISOString(), rollback]);
    return { profile: (await this.findProfile(tx, id)) as ProfileRow, evidence: gate.evidence, superseded };
  }

  /** Sends a profile back to its drafter with a reason: the evaluations stay, the profile is not served. */
  async returnProfile(tx: TenantTx, id: string, expectedVersion: number): Promise<ProfileRow> {
    const profile = await this.findProfile(tx, id, true);
    if (profile === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (profile.version !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409);
    if (profile.status !== 'DRAFT' && profile.status !== 'EVAL_PENDING') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    await tx.query("update machvon.model_profile_version set status = 'DRAFT', version = version + 1 where id = $1::uuid", [id]);
    return (await this.findProfile(tx, id)) as ProfileRow;
  }
}
