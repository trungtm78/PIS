import type { Classification, Route } from './llm-model';
import { BASELINE, CLASSIFICATIONS, ROUTES } from './llm-model';

export const PROMPT_MANAGE = 'llm.prompt.manage';
export const PROMPT_APPROVE = 'llm.prompt.approve';
export const EVAL_MANAGE = 'llm.eval.manage';
export const EVAL_SIGN = 'llm.eval.sign';
export const PROFILE_MANAGE = 'llm.profile.manage';
export const PROFILE_PUBLISH = 'llm.publish';

export const RELEASE_PATH = '/llm/llm-17';
export const PROFILES_PATH = '/llm/llm-04';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => (typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : undefined);

/** What a model may be allowed to call on its own: tools that only read (the same list as the server's). */
export const READ_ONLY_TOOLS = ['search_documents', 'read_document', 'lookup_master_data', 'read_project_summary', 'read_contract_summary'] as const;
export const EFFORTS = ['low', 'medium', 'high'] as const;
export const PROFILE_STATUSES = ['DRAFT', 'EVAL_PENDING', 'PUBLISHED', 'SUPERSEDED', 'ROLLED_BACK'] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];
export const RUN_STATUSES = ['PENDING_SIGNATURE', 'SIGNED_PASS', 'SIGNED_FAIL', 'FAILED', 'SUPERSEDED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const PROMPT_STATUSES = ['DRAFT', 'APPROVED', 'RETIRED'] as const;
export type PromptStatus = (typeof PROMPT_STATUSES)[number];
export const DATASET_SOURCES = ['SYNTHETIC', 'ANONYMISED'] as const;
export type DatasetSource = (typeof DATASET_SOURCES)[number];
export const METRICS = ['citation_precision', 'unsupported_claim_rate', 'injection_resistance', 'schema_valid_rate'] as const;
export type MetricName = (typeof METRICS)[number];

// ---- prompts --------------------------------------------------------------------------------------------------------------------------------

export interface PromptEntry {
  id: string;
  taskType: string;
  name: string;
  revision: number;
  sha256: string;
  inputSchema: string;
  outputSchema: string;
  label: string | null;
  status: PromptStatus;
  approvedBy: string | null;
  createdBy: string;
  version: number;
}

export function toPrompt(raw: unknown): PromptEntry | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const taskType = text(row?.task_type);
  const name = text(row?.name);
  const status = oneOf(PROMPT_STATUSES, row?.status);
  const revision = whole(row?.revision);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || taskType === undefined || name === undefined || status === undefined || revision === undefined || version === undefined) return undefined;
  return {
    id,
    taskType,
    name,
    revision,
    sha256: text(row.template_sha256) ?? '',
    inputSchema: JSON.stringify(row.input_schema ?? {}),
    outputSchema: JSON.stringify(row.output_schema ?? {}),
    label: nullableText(row.label),
    status,
    approvedBy: nullableText(row.approved_by),
    createdBy: text(row.created_by) ?? '',
    version,
  };
}

export interface PromptValues {
  taskType: string;
  name: string;
  templateObjectKey: string;
  templateSha256: string;
  inputSchema: string;
  outputSchema: string;
}
export const EMPTY_PROMPT: PromptValues = { taskType: '', name: '', templateObjectKey: '', templateSha256: '', inputSchema: '', outputSchema: '' };
export type PromptProblem = 'required' | 'invalidHash' | 'invalidKey' | 'invalidJson' | 'invalidSchema';
export type PromptErrors = Partial<Record<'taskType' | 'name' | 'templateObjectKey' | 'templateSha256' | 'inputSchema' | 'outputSchema', PromptProblem>>;

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

/** A schema of a prompt is an object schema that names its properties (the server judges the rest). */
function schemaProblem(value: string): PromptProblem | undefined {
  if (value.trim() === '') return 'required';
  const parsed = asRecord(parseJson(value));
  if (parsed === undefined) return 'invalidJson';
  return parsed.type === 'object' && asRecord(parsed.properties) !== undefined && Object.keys(parsed.properties as Raw).length > 0 ? undefined : 'invalidSchema';
}

export function validatePrompt(values: PromptValues): PromptErrors {
  const errors: PromptErrors = {};
  if (values.taskType.trim().length < 2) errors.taskType = 'required';
  if (values.name.trim().length < 2) errors.name = 'required';
  if (values.templateObjectKey.trim().length < 10) errors.templateObjectKey = 'invalidKey';
  if (!/^[0-9a-f]{64}$/.test(values.templateSha256.trim())) errors.templateSha256 = 'invalidHash';
  const input = schemaProblem(values.inputSchema);
  if (input !== undefined) errors.inputSchema = input;
  const output = schemaProblem(values.outputSchema);
  if (output !== undefined) errors.outputSchema = output;
  return errors;
}

export function promptBody(values: PromptValues) {
  return {
    task_type: values.taskType.trim(),
    name: values.name.trim(),
    template_object_key: values.templateObjectKey.trim(),
    template_sha256: values.templateSha256.trim(),
    input_schema: parseJson(values.inputSchema) as Record<string, never>,
    output_schema: parseJson(values.outputSchema) as Record<string, never>,
  };
}

// ---- datasets -------------------------------------------------------------------------------------------------------------------------------

export interface DatasetEntry {
  id: string;
  code: string;
  revision: number;
  taskType: string;
  source: DatasetSource;
  maxClassification: Classification;
  caseCount: number;
  injectionCases: number;
  status: string;
}

export function toDataset(raw: unknown): DatasetEntry | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.dataset_code);
  const taskType = text(row?.task_type);
  const source = oneOf(DATASET_SOURCES, row?.source);
  const max = oneOf(CLASSIFICATIONS, row?.max_classification);
  const revision = whole(row?.revision);
  if (row === undefined || id === undefined || code === undefined || taskType === undefined || source === undefined || max === undefined || revision === undefined) return undefined;
  return { id, code, revision, taskType, source, maxClassification: max, caseCount: whole(row.case_count) ?? 0, injectionCases: whole(row.injection_cases) ?? 0, status: text(row.status) ?? '' };
}

export interface DatasetValues {
  code: string;
  taskType: string;
  source: DatasetSource;
  cases: string;
}
export const EMPTY_DATASET: DatasetValues = { code: '', taskType: '', source: 'SYNTHETIC', cases: '' };
export type DatasetProblem = 'required' | 'invalidJson' | 'needsCases' | 'tooManyCases' | 'invalidCase' | 'caseTooHigh';
export type DatasetErrors = Partial<Record<'code' | 'taskType' | 'cases', DatasetProblem>>;
export const MAX_CASES = 500;

export function validateDataset(values: DatasetValues): DatasetErrors {
  const errors: DatasetErrors = {};
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,59}$/.test(values.code.trim())) errors.code = 'required';
  if (values.taskType.trim().length < 2) errors.taskType = 'required';
  const parsed = parseJson(values.cases);
  if (values.cases.trim() === '') errors.cases = 'required';
  else if (!Array.isArray(parsed)) errors.cases = 'invalidJson';
  else if (parsed.length === 0) errors.cases = 'needsCases';
  else if (parsed.length > MAX_CASES) errors.cases = 'tooManyCases';
  else if (!parsed.every((entry) => asRecord(entry) !== undefined && typeof (entry as Raw).case_code === 'string' && typeof (entry as Raw).input_ref === 'string' && asRecord((entry as Raw).expected) !== undefined)) errors.cases = 'invalidCase';
  // A case above internal is real data that was not made harmless: it is not sent.
  else if (parsed.some((entry) => (entry as Raw).classification !== undefined && !['PUBLIC', 'INTERNAL'].includes(String((entry as Raw).classification)))) errors.cases = 'caseTooHigh';
  return errors;
}

export function datasetBody(values: DatasetValues) {
  return { dataset_code: values.code.trim(), task_type: values.taskType.trim(), source: values.source, cases: parseJson(values.cases) as Array<Record<string, never>> };
}

// ---- profiles and runs ----------------------------------------------------------------------------------------------------------------------

export interface ProfileEntry {
  id: string;
  taskType: string;
  revision: number;
  modelId: string;
  effort: string | null;
  routes: Route[];
  thresholds: Record<string, number>;
  status: ProfileStatus;
  allowedModelIds: string[];
  maxClassification: Classification | null;
  promptVersionId: string | null;
  rollbackProfileId: string | null;
  toolAllowlist: string[];
  createdBy: string | null;
  effectiveAt: string | null;
  version: number;
}

export function toProfile(raw: unknown): ProfileEntry | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const taskType = text(row?.task_type);
  const status = oneOf(PROFILE_STATUSES, row?.status);
  const revision = whole(row?.revision);
  const version = whole(row?.version);
  const policy = asRecord(row?.routing_policy);
  if (row === undefined || id === undefined || taskType === undefined || status === undefined || revision === undefined || version === undefined || policy === undefined) return undefined;
  const routes = Array.isArray(policy.routes) ? policy.routes.flatMap((route) => oneOf(ROUTES, route) ?? []) : [];
  const thresholds = Object.fromEntries(Object.entries(asRecord(policy.thresholds) ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  return {
    id,
    taskType,
    revision,
    modelId: text(row.model_id) ?? '',
    effort: nullableText(row.effort),
    routes,
    thresholds,
    status,
    allowedModelIds: Array.isArray(row.allowed_model_ids) ? row.allowed_model_ids.filter((entry): entry is string => typeof entry === 'string') : [],
    maxClassification: oneOf(CLASSIFICATIONS, row.max_classification) ?? null,
    promptVersionId: nullableText(row.prompt_version_id),
    rollbackProfileId: nullableText(row.rollback_profile_id),
    toolAllowlist: Array.isArray(row.tool_allowlist) ? row.tool_allowlist.filter((entry): entry is string => typeof entry === 'string') : [],
    createdBy: nullableText(row.created_by),
    effectiveAt: nullableText(row.effective_at),
    version,
  };
}

export interface RunEntry {
  id: string;
  profileId: string;
  datasetId: string;
  route: Route;
  metrics: Record<string, number> | null;
  thresholds: Record<string, number> | null;
  passed: boolean | null;
  failures: string[];
  status: RunStatus;
  costVnd: string;
  startedBy: string | null;
  signedBy: string | null;
  signatureComment: string | null;
  version: number;
}

const numbers = (value: unknown): Record<string, number> | null => {
  const row = asRecord(value);
  return row === undefined ? null : Object.fromEntries(Object.entries(row).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
};

export function toRun(raw: unknown): RunEntry | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const profileId = text(row?.profile_version_id);
  const datasetId = text(row?.dataset_version_id);
  const route = oneOf(ROUTES, row?.route_class);
  const status = oneOf(RUN_STATUSES, row?.review_status);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || profileId === undefined || datasetId === undefined || route === undefined || status === undefined || version === undefined) return undefined;
  return {
    id,
    profileId,
    datasetId,
    route,
    metrics: numbers(row.metrics),
    thresholds: numbers(row.thresholds),
    passed: typeof row.passed === 'boolean' ? row.passed : null,
    failures: Array.isArray(row.failures) ? row.failures.filter((entry): entry is string => typeof entry === 'string') : [],
    status,
    costVnd: text(row.cost_vnd) ?? '0',
    startedBy: nullableText(row.started_by),
    signedBy: nullableText(row.signed_by),
    signatureComment: nullableText(row.signature_comment),
    version,
  };
}

/** An amount of dong as the server keeps it (a decimal string of up to eight places): the whole part is grouped, the places that are not zero are kept, and what is not a decimal number is shown as it came. */
export function evalCost(value: string): string {
  const match = /^(-?[0-9]+)(?:.([0-9]+))?$/.exec(value);
  if (match === null) return value;
  const places = (match[2] ?? '').replace(/0+$/, '');
  return `${BigInt(match[1] as string).toLocaleString('en-US')}${places === '' ? '' : `.${places}`}`;
}

/** What each route of a profile stands at, from the runs that are current (not set aside): the page of the release reads it. */
export type RouteGate = 'NONE' | 'UNSIGNED' | 'FAILED_RUN' | 'SIGNED_PASS' | 'SIGNED_FAIL' | 'PASS_OVER_FAILED_METRICS';

export function gateOfRoute(route: Route, runs: readonly RunEntry[]): { gate: RouteGate; run: RunEntry | undefined } {
  const current = runs.filter((run) => run.route === route && run.status !== 'SUPERSEDED');
  const run = current[0];
  if (run === undefined) return { gate: 'NONE', run };
  if (run.status === 'SIGNED_PASS') return { gate: run.passed === true ? 'SIGNED_PASS' : 'PASS_OVER_FAILED_METRICS', run };
  if (run.status === 'SIGNED_FAIL') return { gate: 'SIGNED_FAIL', run };
  if (run.status === 'FAILED') return { gate: 'FAILED_RUN', run };
  return { gate: 'UNSIGNED', run };
}

/** The profile can be published when every route has a signed pass: the server judges it again and says what is missing. */
export const releasable = (routes: readonly Route[], runs: readonly RunEntry[]): boolean => routes.length > 0 && routes.every((route) => gateOfRoute(route, runs).gate === 'SIGNED_PASS');

export interface ProfileValues {
  taskType: string;
  modelId: string;
  allowedModelIds: string[];
  effort: string;
  outputCap: string;
  maxInputTokens: string;
  timeoutMs: string;
  concurrencyLimit: string;
  retentionDays: string;
  maxClassification: Classification;
  routes: Route[];
  promptVersionId: string;
  toolAllowlist: string[];
  outputSchema: string;
  rollbackProfileId: string;
}
export const EMPTY_PROFILE: ProfileValues = {
  taskType: '',
  modelId: '',
  allowedModelIds: [],
  effort: '',
  outputCap: '1000',
  maxInputTokens: '8000',
  timeoutMs: '30000',
  concurrencyLimit: '4',
  retentionDays: '90',
  maxClassification: 'PUBLIC',
  routes: [],
  promptVersionId: '',
  toolAllowlist: [],
  outputSchema: '{"type":"object"}',
  rollbackProfileId: '',
};
export type ProfileProblem = 'required' | 'invalidNumber' | 'invalidJson' | 'needsModel' | 'needsRoute' | 'internationalPublicOnly' | 'routeAboveBaseline';
export type ProfileErrors = Partial<Record<'taskType' | 'modelId' | 'allowedModelIds' | 'outputCap' | 'maxInputTokens' | 'timeoutMs' | 'concurrencyLimit' | 'retentionDays' | 'routes' | 'promptVersionId' | 'outputSchema', ProfileProblem>>;

const count = (value: string): boolean => /^[0-9]{1,10}$/.test(value.trim()) && Number(value) >= 1 && Number(value) <= 2_147_483_647;

export function validateProfile(values: ProfileValues): ProfileErrors {
  const errors: ProfileErrors = {};
  if (values.taskType.trim().length < 2) errors.taskType = 'required';
  if (values.allowedModelIds.length === 0) errors.allowedModelIds = 'needsModel';
  if (values.modelId === '') errors.modelId = 'required';
  for (const [field, value] of [
    ['outputCap', values.outputCap],
    ['maxInputTokens', values.maxInputTokens],
    ['timeoutMs', values.timeoutMs],
    ['concurrencyLimit', values.concurrencyLimit],
    ['retentionDays', values.retentionDays],
  ] as const) {
    if (!count(value)) errors[field] = 'invalidNumber';
  }
  if (values.routes.length === 0) errors.routes = 'needsRoute';
  else if (values.routes.includes('INTERNATIONAL') && values.maxClassification !== 'PUBLIC') errors.routes = 'internationalPublicOnly';
  // The baseline of the classification matrix holds for every route, not for the international one alone.
  else if (values.routes.some((route) => !BASELINE[values.maxClassification].includes(route))) errors.routes = 'routeAboveBaseline';
  if (values.promptVersionId === '') errors.promptVersionId = 'required';
  if (asRecord(parseJson(values.outputSchema)) === undefined) errors.outputSchema = 'invalidJson';
  return errors;
}

/** `model_id` of a profile is the identifier the provider knows the model by (`llm-small`); the models it may use (`allowed_model_ids`) are the ids of the registry. */
export function profileBody(values: ProfileValues, providerModelId: string) {
  return {
    task_type: values.taskType.trim(),
    model_id: providerModelId,
    // The primary model is listed first: when two entries of the registry have the same identifier, the first one is the primary.
    allowed_model_ids: [values.modelId, ...values.allowedModelIds.filter((entry) => entry !== values.modelId)].filter((entry) => entry !== ''),
    ...(values.effort === '' ? {} : { effort: values.effort }),
    output_cap: Number(values.outputCap),
    max_input_tokens: Number(values.maxInputTokens),
    timeout_ms: Number(values.timeoutMs),
    concurrency_limit: Number(values.concurrencyLimit),
    output_schema: parseJson(values.outputSchema) as Record<string, never>,
    tool_allowlist: values.toolAllowlist,
    max_classification: values.maxClassification,
    routing_policy: { routes: values.routes } as unknown as Record<string, never>,
    prompt_version_id: values.promptVersionId,
    ...(values.rollbackProfileId === '' ? {} : { rollback_profile_id: values.rollbackProfileId }),
    retention_days: Number(values.retentionDays),
  };
}
