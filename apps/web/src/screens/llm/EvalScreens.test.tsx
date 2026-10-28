import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import DatasetsScreen from './DatasetsScreen';
import ModelsScreen from './ModelsScreen';
import ProfilesScreen from './ProfilesScreen';
import PromptsScreen from './PromptsScreen';
import ReleaseScreen from './ReleaseScreen';
import { evalCost, EMPTY_DATASET, EMPTY_PROFILE, EMPTY_PROMPT, datasetBody, gateOfRoute, profileBody, promptBody, releasable, toDataset, toProfile, toPrompt, toRun, validateDataset, validateProfile, validatePrompt } from './eval-model';
import { describeLlmProblem } from './llm-model';

const PROMPTS = routeOf('LLM-10', 'FR-LLM-10');
const DATASETS = routeOf('LLM-12', 'FR-LLM-12');
const PROFILES = routeOf('LLM-04', 'FR-LLM-04');
const RELEASE = routeOf('LLM-17', 'FR-LLM-17');
const MODELS = routeOf('LLM-03', 'FR-LLM-03');
const AUTHOR = ['llm.prompt.manage', 'llm.eval.manage', 'llm.profile.manage', 'llm.prompt.read', 'llm.eval.read'];
const APPROVER = ['llm.prompt.approve', 'llm.prompt.read'];
const EXPERT = ['llm.eval.sign', 'llm.eval.read'];
const PUBLISHER = ['llm.publish', 'llm.eval.read'];
const READER = ['llm.prompt.read', 'llm.eval.read'];
const failure = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const HASH = 'a'.repeat(64);
const OBJECT = { type: 'object', properties: { text: { type: 'string' } } };
const rawPrompt = (overrides: Record<string, unknown> = {}) => ({
  id: id(1),
  task_type: 'summarise',
  name: 'Tom tat van ban',
  revision: 1,
  template_sha256: HASH,
  input_schema: OBJECT,
  output_schema: OBJECT,
  label: null,
  status: 'DRAFT',
  approved_by: null,
  created_by: id(900),
  created_at: '2026-10-20T00:00:00.000Z',
  version: 2,
  ...overrides,
});
const rawDataset = (overrides: Record<string, unknown> = {}) => ({
  id: id(2),
  dataset_code: 'sum-core',
  revision: 1,
  task_type: 'summarise',
  source: 'SYNTHETIC',
  max_classification: 'INTERNAL',
  case_count: 12,
  injection_cases: 3,
  status: 'APPROVED',
  created_by: id(900),
  created_at: '2026-10-20T00:00:00.000Z',
  version: 1,
  ...overrides,
});
const THRESHOLDS = { citation_precision_min: 0.95, unsupported_claim_rate_max: 0.02, injection_resistance_min: 1, schema_valid_rate_min: 0.99 };
const MODEL_A = id(10);
const MODEL_B = id(11);
const rawProfile = (overrides: Record<string, unknown> = {}) => ({
  id: id(3),
  task_type: 'summarise',
  revision: 2,
  model_id: 'llm-small',
  effort: 'medium',
  output_cap: 1000,
  routing_policy: { routes: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], thresholds: THRESHOLDS },
  status: 'EVAL_PENDING',
  allowed_model_ids: [MODEL_A],
  max_input_tokens: 8000,
  timeout_ms: 30000,
  concurrency_limit: 4,
  tool_allowlist: ['search_documents'],
  max_classification: 'INTERNAL',
  prompt_version_id: id(1),
  rollback_profile_id: id(4),
  retention_days: 90,
  approved_by: null,
  created_by: id(900),
  effective_at: null,
  created_at: '2026-10-21T00:00:00.000Z',
  version: 5,
  ...overrides,
});
const METRICS = { citation_precision: 0.97, unsupported_claim_rate: 0.01, injection_resistance: 1, schema_valid_rate: 1 };
const rawRun = (overrides: Record<string, unknown> = {}) => ({
  id: id(20),
  profile_version_id: id(3),
  dataset_version_id: id(2),
  route_class: 'DOMESTIC_HOSTED',
  model_ref_id: MODEL_A,
  metrics: METRICS,
  thresholds: THRESHOLDS,
  passed: true,
  failures: [],
  review_status: 'PENDING_SIGNATURE',
  cost_vnd: '15000',
  started_by: id(900),
  started_at: '2026-10-22T00:00:00.000Z',
  finished_at: '2026-10-22T00:01:00.000Z',
  signed_by: null,
  signed_at: null,
  signature_decision: null,
  signature_comment: null,
  version: 1,
  ...overrides,
});
const rawModel = (overrides: Record<string, unknown> = {}) => ({
  id: MODEL_A,
  provider_id: id(30),
  model_id: 'llm-small',
  model_version: '1',
  capabilities: { json_schema: true },
  context_window: 8000,
  max_output: 1000,
  max_classification: 'INTERNAL',
  status: 'APPROVED',
  created_by: id(900),
  created_at: '2026-10-01T00:00:00.000Z',
  version: 4,
  ...overrides,
});
const rawProvider = () => ({
  id: id(30),
  provider_code: 'VN-HOST',
  name: 'Nha cung cap',
  region_country: 'VN',
  route_class: 'DOMESTIC_HOSTED',
  max_classification: 'CONFIDENTIAL',
  data_agreement_document_id: id(31),
  d07_approval_ref: null,
  adapter_status: 'ACTIVE',
  status: 'ACTIVE',
  approved_by: id(901),
  created_by: id(900),
  created_at: '2026-10-01T00:00:00.000Z',
  version: 3,
});

interface World {
  prompts: unknown[] | Error;
  datasets: unknown[] | Error;
  profiles: unknown[] | Error;
  runs: unknown[] | Error;
  models: unknown[] | Error;
}
const normal = (): World => ({
  prompts: [rawPrompt(), rawPrompt({ id: id(5), revision: 1, name: 'Da duyet', status: 'APPROVED', label: 'PRODUCTION', approved_by: id(901), version: 3 })],
  datasets: [rawDataset()],
  profiles: [rawProfile()],
  runs: [],
  models: [rawModel(), rawModel({ id: MODEL_B, model_id: 'llm-draft', status: 'PROPOSED' })],
});

function client(world: World, command: (operation: string, input: unknown) => unknown = () => ({})) {
  const h = harness(() => new Error('unexpected read'), command);
  const answers: Record<string, unknown[] | Error> = {
    listAiPrompts: world.prompts,
    listAiEvalDatasets: world.datasets,
    get_resources_model_profile_version: world.profiles,
    get_resources_ai_eval_run: world.runs,
    listAiModels: world.models,
    listAiProviders: [rawProvider()],
  };
  const readAll = vi.fn((operation: string) => {
    const result = answers[operation] ?? new Error(`unexpected readAll ${operation}`);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}

afterEach(cleanup);

describe('the pure rules of the evaluation gate (ST-LLM-004)', () => {
  it('reads a prompt as it is shown, with its schemas as text, and refuses a row that is not one', () => {
    const prompt = toPrompt(rawPrompt({ template_object_key: 's3://secret/key' }));
    expect(prompt).toMatchObject({ taskType: 'summarise', name: 'Tom tat van ban', revision: 1, sha256: HASH, status: 'DRAFT', version: 2, label: null });
    expect(prompt?.inputSchema).toBe(JSON.stringify(OBJECT));
    expect(JSON.stringify(prompt)).not.toContain('s3://secret/key');
    expect(toPrompt(rawPrompt({ status: 'GONE' }))).toBeUndefined();
    expect(toPrompt(null)).toBeUndefined();
  });

  it('checks the key, the hash and both schemas of a prompt before sending, and builds the body with the schemas as objects', () => {
    const ok = { ...EMPTY_PROMPT, taskType: 'summarise', name: 'Tom tat', templateObjectKey: 'templates/summarise-v1.txt', templateSha256: HASH, inputSchema: JSON.stringify(OBJECT), outputSchema: JSON.stringify(OBJECT) };
    expect(validatePrompt(ok)).toEqual({});
    expect(validatePrompt({ ...ok, templateSha256: 'abc' })).toEqual({ templateSha256: 'invalidHash' });
    expect(validatePrompt({ ...ok, templateObjectKey: 'short' })).toEqual({ templateObjectKey: 'invalidKey' });
    expect(validatePrompt({ ...ok, inputSchema: '{' })).toEqual({ inputSchema: 'invalidJson' });
    expect(validatePrompt({ ...ok, outputSchema: '{"type":"object","properties":{}}' })).toEqual({ outputSchema: 'invalidSchema' });
    expect(validatePrompt({ ...ok, outputSchema: '' })).toEqual({ outputSchema: 'required' });
    expect(promptBody(ok)).toEqual({ task_type: 'summarise', name: 'Tom tat', template_object_key: 'templates/summarise-v1.txt', template_sha256: HASH, input_schema: OBJECT, output_schema: OBJECT });
  });

  it('refuses the cases of a dataset that are not made harmless or not well formed, and builds the body', () => {
    const cases = JSON.stringify([{ case_code: 'c1', input_ref: 'docs/1', expected: { cites: [] }, tags: ['injection'] }]);
    const ok = { ...EMPTY_DATASET, code: 'sum-core', taskType: 'summarise', cases };
    expect(validateDataset(ok)).toEqual({});
    expect(validateDataset({ ...ok, cases: '' })).toEqual({ cases: 'required' });
    expect(validateDataset({ ...ok, cases: '{}' })).toEqual({ cases: 'invalidJson' });
    expect(validateDataset({ ...ok, cases: '[]' })).toEqual({ cases: 'needsCases' });
    expect(validateDataset({ ...ok, cases: JSON.stringify([{ case_code: 'c1' }]) })).toEqual({ cases: 'invalidCase' });
    expect(validateDataset({ ...ok, cases: JSON.stringify([{ case_code: 'c1', input_ref: 'x', expected: {}, classification: 'PERSONAL' }]) })).toEqual({ cases: 'caseTooHigh' });
    expect(validateDataset({ ...ok, cases: JSON.stringify(Array.from({ length: 501 }, (_, n) => ({ case_code: `c${n}`, input_ref: 'x', expected: {} }))) })).toEqual({ cases: 'tooManyCases' });
    expect(validateDataset({ ...ok, code: '', taskType: '' })).toEqual({ code: 'required', taskType: 'required' });
    expect(datasetBody(ok)).toEqual({ dataset_code: 'sum-core', task_type: 'summarise', source: 'SYNTHETIC', cases: JSON.parse(cases) });
  });

  it('keeps the international route for public data when a profile is drafted, and builds its body', () => {
    const ok = { ...EMPTY_PROFILE, taskType: 'summarise', modelId: MODEL_A, allowedModelIds: [MODEL_A], routes: ['DOMESTIC_HOSTED' as const], promptVersionId: id(1), maxClassification: 'INTERNAL' as const, effort: 'high' };
    expect(validateProfile(ok)).toEqual({});
    expect(validateProfile({ ...ok, routes: ['INTERNATIONAL'] })).toEqual({ routes: 'internationalPublicOnly' });
    expect(validateProfile({ ...ok, routes: ['INTERNATIONAL'], maxClassification: 'PUBLIC' })).toEqual({});
    expect(validateProfile({ ...ok, routes: [] })).toEqual({ routes: 'needsRoute' });
    expect(validateProfile({ ...ok, maxClassification: 'IMPORTANT_CORE' })).toEqual({ routes: 'routeAboveBaseline' });
    expect(validateProfile({ ...ok, maxClassification: 'IMPORTANT_CORE', routes: ['SELF_HOSTED'] })).toEqual({});
    expect(validateProfile({ ...ok, allowedModelIds: [], modelId: '', promptVersionId: '', outputCap: '0', timeoutMs: 'x', outputSchema: '[' })).toEqual({
      allowedModelIds: 'needsModel',
      modelId: 'required',
      promptVersionId: 'required',
      outputCap: 'invalidNumber',
      timeoutMs: 'invalidNumber',
      outputSchema: 'invalidJson',
    });
    expect(profileBody({ ...ok, toolAllowlist: ['read_document'], rollbackProfileId: id(4) }, 'llm-small')).toEqual({
      task_type: 'summarise',
      model_id: 'llm-small',
      allowed_model_ids: [MODEL_A],
      effort: 'high',
      output_cap: 1000,
      max_input_tokens: 8000,
      timeout_ms: 30000,
      concurrency_limit: 4,
      output_schema: { type: 'object' },
      tool_allowlist: ['read_document'],
      max_classification: 'INTERNAL',
      routing_policy: { routes: ['DOMESTIC_HOSTED'] },
      prompt_version_id: id(1),
      rollback_profile_id: id(4),
      retention_days: 90,
    });
    expect(profileBody(ok, 'llm-small')).not.toHaveProperty('rollback_profile_id');
    // The primary model is listed first, wherever it was ticked.
    expect(profileBody({ ...ok, modelId: MODEL_B, allowedModelIds: [MODEL_A, MODEL_B] }, 'llm-draft').allowed_model_ids).toEqual([MODEL_B, MODEL_A]);
  });

  it('reads profiles, runs and datasets, and judges the gate of a route from the runs that stand', () => {
    expect(toProfile(rawProfile())).toMatchObject({ taskType: 'summarise', routes: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], status: 'EVAL_PENDING', allowedModelIds: [MODEL_A], version: 5, rollbackProfileId: id(4) });
    expect(toProfile(rawProfile({ routing_policy: null }))).toBeUndefined();
    expect(toDataset(rawDataset())).toMatchObject({ code: 'sum-core', caseCount: 12, injectionCases: 3, maxClassification: 'INTERNAL' });
    expect(toDataset(rawDataset({ source: 'REAL' }))).toBeUndefined();
    expect(toRun(rawRun())).toMatchObject({ route: 'DOMESTIC_HOSTED', status: 'PENDING_SIGNATURE', passed: true, costVnd: '15000' });
    expect(toRun(rawRun({ review_status: 'NOPE' }))).toBeUndefined();
    const run = (overrides: Record<string, unknown>) => toRun(rawRun(overrides)) as NonNullable<ReturnType<typeof toRun>>;
    const pending = run({});
    const pass = run({ id: id(21), review_status: 'SIGNED_PASS' });
    const fail = run({ id: id(22), route_class: 'SELF_HOSTED', review_status: 'SIGNED_FAIL', passed: false });
    const old = run({ id: id(23), review_status: 'SUPERSEDED' });
    expect(gateOfRoute('DOMESTIC_HOSTED', [])).toEqual({ gate: 'NONE', run: undefined });
    expect(gateOfRoute('DOMESTIC_HOSTED', [old]).gate).toBe('NONE');
    expect(gateOfRoute('DOMESTIC_HOSTED', [pending]).gate).toBe('UNSIGNED');
    expect(gateOfRoute('DOMESTIC_HOSTED', [pass]).gate).toBe('SIGNED_PASS');
    expect(gateOfRoute('SELF_HOSTED', [fail]).gate).toBe('SIGNED_FAIL');
    expect(gateOfRoute('DOMESTIC_HOSTED', [run({ review_status: 'FAILED', passed: null, metrics: null })]).gate).toBe('FAILED_RUN');
    // A signature of "passed" over metrics that did not pass is not a pass.
    expect(gateOfRoute('DOMESTIC_HOSTED', [run({ review_status: 'SIGNED_PASS', passed: false })]).gate).toBe('PASS_OVER_FAILED_METRICS');
    expect(releasable(['DOMESTIC_HOSTED'], [pass])).toBe(true);
    expect(releasable(['DOMESTIC_HOSTED', 'SELF_HOSTED'], [pass, fail])).toBe(false);
    expect(releasable([], [pass])).toBe(false);
  });

  it('shows the cost of an evaluation as the server keeps it, with the places that are not zero and without ever throwing', () => {
    expect(evalCost('15000')).toBe('15,000');
    expect(evalCost('15000.00000000')).toBe('15,000');
    expect(evalCost('12.50000000')).toBe('12.5');
    expect(evalCost('0.00000001')).toBe('0.00000001');
    expect(evalCost('x')).toBe('x');
  });

  it('puts the refusals of the gate in words', () => {
    expect(describeLlmProblem(failure(409, 'PROMPT_IMMUTABLE')).reason).toBe('promptImmutable');
    expect(describeLlmProblem(failure(409, 'EVAL_REQUIRED')).reason).toBe('evalRequired');
    expect(describeLlmProblem(failure(409, 'EVAL_MISSING_FOR_ROUTE')).reason).toBe('evalMissing');
    expect(describeLlmProblem(failure(409, 'EVAL_NOT_PASSED')).reason).toBe('evalNotPassed');
    expect(describeLlmProblem(failure(409, 'EVAL_NOT_FINISHED')).reason).toBe('evalNotFinished');
    expect(describeLlmProblem(failure(422, 'UNSUPPORTED_PARAMETER')).reason).toBe('unsupportedParameter');
    expect(describeLlmProblem(failure(422, 'AI_ROUTE_NOT_ALLOWED')).reason).toBe('routeNotAllowed');
    expect(describeLlmProblem(failure(422, 'TOOL_NOT_READ_ONLY')).reason).toBe('toolNotReadOnly');
    expect(describeLlmProblem(failure(409, 'EVAL_CASE_CLASSIFICATION_INVALID')).reason).toBe('invalid');
    expect(describeLlmProblem(failure(403, 'SELF_APPROVAL_DENIED')).reason).toBe('selfApproval');
  });
});

describe('LLM-10 prompts (ST-LLM-004, LLM F4)', () => {
  it('shows each version with its hash start and label, never the key of the template, and offers approval only on a draft', async () => {
    mount(<PromptsScreen route={PROMPTS} />, client({ ...normal(), prompts: [{ ...rawPrompt(), template_object_key: 's3://private/template-key' }, (normal().prompts as unknown[])[1]] }), { permissions: [...AUTHOR, ...APPROVER] });
    const table = await screen.findByTestId('prompt-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain('summarise');
    expect(rows[0]?.textContent).toContain(HASH.slice(0, 12));
    expect(rows[0]?.textContent).toContain(vi_['llm.promptStatus.draft']);
    expect(rows[1]?.textContent).toContain('PRODUCTION');
    expect(rows[1]?.textContent).toContain(vi_['llm.promptStatus.approved']);
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: vi_['llm.prompts.approve'] })).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryAllByRole('button').length).toBe(0);
    expect(screen.getByTestId('prompts-immutable-note').textContent).toBe(vi_['llm.prompts.immutableNote']);
    expect(document.body.textContent).not.toContain('s3://private');
  });

  it('AC-ST-LLM-004-2: UAT-AC463 approves a draft at the version it was read at, and says that the author cannot approve their own version', async () => {
    const user = userEvent.setup();
    const h = client(normal(), () => failure(403, 'SELF_APPROVAL_DENIED'));
    mount(<PromptsScreen route={PROMPTS} />, h, { permissions: APPROVER });
    const table = await screen.findByTestId('prompt-table');
    await user.click(within(table).getByRole('button', { name: vi_['llm.prompts.approve'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['approveAiPromptVersion', { path: { id: id(1) }, ifMatchVersion: 2 }]);
    expect((await screen.findByTestId('prompt-refused')).textContent).toBe(vi_['llm.reason.selfApproval']);
  });

  it('AC-ST-LLM-004-2: UAT-AC463 revises a draft from what is there, asks for the template again, and says that an approved version does not change', async () => {
    const user = userEvent.setup();
    const h = client(normal(), () => failure(409, 'PROMPT_IMMUTABLE'));
    mount(<PromptsScreen route={PROMPTS} />, h, { permissions: AUTHOR });
    const table = await screen.findByTestId('prompt-table');
    await user.click(within(table).getByRole('button', { name: vi_['llm.prompts.revise'] }));
    const form = await screen.findByRole('form', { name: fill(vi_['llm.prompts.revise.title'], { name: 'Tom tat van ban' }) });
    expect((within(form).getByLabelText(vi_['llm.prompts.form.name']) as HTMLInputElement).value).toBe('Tom tat van ban');
    expect((within(form).getByLabelText(vi_['llm.prompts.form.hash']) as HTMLInputElement).value).toBe(HASH);
    await user.click(within(form).getByRole('button', { name: vi_['llm.prompts.revise.submit'] }));
    expect(await within(form).findByText(vi_['llm.eval.problem.invalidKey'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['llm.prompts.form.key']), 'templates/summarise-v2.txt');
    await user.click(within(form).getByRole('button', { name: vi_['llm.prompts.revise.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['reviseAiPromptVersion', { path: { id: id(1) }, ifMatchVersion: 2, body: { template_object_key: 'templates/summarise-v2.txt', template_sha256: HASH, input_schema: OBJECT } }]);
    expect((await screen.findByTestId('prompt-revise-refused')).textContent).toBe(vi_['llm.reason.promptImmutable']);
  });

  it('checks the draft before sending and sends the schemas as objects', async () => {
    const user = userEvent.setup();
    const h = client({ ...normal(), prompts: [] }, () => ({ status: 'DRAFT', revision: 1 }));
    mount(<PromptsScreen route={PROMPTS} />, h, { permissions: AUTHOR });
    expect((await screen.findByTestId('prompts-none')).textContent).toBe(vi_['llm.prompts.none']);
    const form = screen.getByRole('form', { name: vi_['llm.prompts.form.title'] });
    await user.click(within(form).getByRole('button', { name: vi_['llm.prompts.form.submit'] }));
    expect((await within(form).findAllByText(vi_['llm.problem.required'])).length).toBeGreaterThan(0);
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['llm.prompts.form.task']), 'summarise');
    await user.type(within(form).getByLabelText(vi_['llm.prompts.form.name']), 'Tom tat');
    await user.type(within(form).getByLabelText(vi_['llm.prompts.form.key']), 'templates/summarise-v1.txt');
    await user.type(within(form).getByLabelText(vi_['llm.prompts.form.hash']), HASH);
    fireEvent.change(within(form).getByLabelText(vi_['llm.prompts.form.input']), { target: { value: JSON.stringify(OBJECT) } });
    fireEvent.change(within(form).getByLabelText(vi_['llm.prompts.form.output']), { target: { value: JSON.stringify(OBJECT) } });
    await user.click(within(form).getByRole('button', { name: vi_['llm.prompts.form.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['createAiPromptVersion', { body: { task_type: 'summarise', name: 'Tom tat', template_object_key: 'templates/summarise-v1.txt', template_sha256: HASH, input_schema: OBJECT, output_schema: OBJECT } }]);
    expect(await screen.findByTestId('prompt-saved')).toBeTruthy();
  });

  it('offers neither the form nor a button to who can only read, and in a read-only session', async () => {
    const { unmount } = mount(<PromptsScreen route={PROMPTS} />, client(normal()), { permissions: READER });
    const table = await screen.findByTestId('prompt-table');
    expect(within(table).queryAllByRole('button').length).toBe(0);
    expect(screen.queryByRole('form', { name: vi_['llm.prompts.form.title'] })).toBeNull();
    unmount();
    mount(<PromptsScreen route={PROMPTS} />, client(normal()), { permissions: [...AUTHOR, ...APPROVER], mode: 'READ_ONLY' });
    const again = await screen.findByTestId('prompt-table');
    expect(within(again).queryAllByRole('button').length).toBe(0);
    expect(screen.queryByRole('form', { name: vi_['llm.prompts.form.title'] })).toBeNull();
  });

  describe('the standard states', () => {
    it.each([
      ['denied', { ...normal(), prompts: failure(403, 'SCOPE_DENIED') }, vi_['states.denied.title']],
      ['offline', { ...normal(), prompts: new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }) }, vi_['states.offline.title']],
      ['error', { ...normal(), prompts: failure(500, 'INTERNAL_ERROR') }, vi_['states.error.title']],
      ['signed out', { ...normal(), prompts: failure(401, 'SESSION_EXPIRED') }, vi_['states.signedOut.title']],
    ] as Array<[string, World, string]>)('UI-LLM-10 shows the %s state', async (_name, world, text) => {
      mount(<PromptsScreen route={PROMPTS} />, client(world), { permissions: AUTHOR });
      expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    });

    it('UI-LLM-10 shows the loading state first and names the page', () => {
      const h = harness(() => new Error('unexpected'));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(<PromptsScreen route={PROMPTS} />, h, { permissions: AUTHOR });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['llm.prompts.page.title'] })).toBeTruthy();
    });
  });
});

describe('LLM-12 evaluation datasets (ST-LLM-004, LLM F4)', () => {
  it('shows the code, version, source, highest class and the number of cases and of injection cases', async () => {
    mount(<DatasetsScreen route={DATASETS} />, client(normal()), { permissions: AUTHOR });
    const table = await screen.findByTestId('dataset-table');
    const row = within(table).getAllByRole('row')[1] as HTMLElement;
    expect(row.textContent).toContain('sum-core');
    expect(row.textContent).toContain(vi_['llm.datasetSource.synthetic']);
    expect(row.textContent).toContain(vi_['llm.classification.internal']);
    expect(row.textContent).toContain('12');
    expect(row.textContent).toContain('3');
  });

  it('does not send a set with a case of real data above internal, or one that is not a list of cases, and sends a good one as it is', async () => {
    const user = userEvent.setup();
    const h = client({ ...normal(), datasets: [] }, () => ({ status: 'APPROVED', revision: 1 }));
    mount(<DatasetsScreen route={DATASETS} />, h, { permissions: AUTHOR });
    expect((await screen.findByTestId('datasets-none')).textContent).toBe(vi_['llm.datasets.none']);
    const form = screen.getByRole('form', { name: vi_['llm.datasets.form.title'] });
    await user.type(within(form).getByLabelText(vi_['llm.datasets.form.code']), 'sum-core');
    await user.type(within(form).getByLabelText(vi_['llm.datasets.form.task']), 'summarise');
    await user.selectOptions(within(form).getByLabelText(vi_['llm.datasets.form.source']), 'ANONYMISED');
    fireEvent.change(within(form).getByLabelText(vi_['llm.datasets.form.cases']), { target: { value: JSON.stringify([{ case_code: 'c1', input_ref: 'docs/1', expected: {}, classification: 'PERSONAL' }]) } });
    await user.click(within(form).getByRole('button', { name: vi_['llm.datasets.form.submit'] }));
    expect(await within(form).findByText(vi_['llm.eval.problem.caseTooHigh'])).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(vi_['llm.datasets.form.cases']), { target: { value: 'not json' } });
    await user.click(within(form).getByRole('button', { name: vi_['llm.datasets.form.submit'] }));
    expect(await within(form).findByText(vi_['llm.eval.problem.invalidJson'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    const cases = [{ case_code: 'c1', input_ref: 'docs/1', expected: { cites: [] }, tags: ['injection'] }];
    fireEvent.change(within(form).getByLabelText(vi_['llm.datasets.form.cases']), { target: { value: JSON.stringify(cases) } });
    await user.click(within(form).getByRole('button', { name: vi_['llm.datasets.form.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['createAiEvalDataset', { body: { dataset_code: 'sum-core', task_type: 'summarise', source: 'ANONYMISED', cases } }]);
    expect(await screen.findByTestId('dataset-saved')).toBeTruthy();
  });

  it('says what the server refused, and offers no form to who cannot manage evaluations', async () => {
    const user = userEvent.setup();
    const { unmount } = mount(
      <DatasetsScreen route={DATASETS} />,
      client(normal(), () => failure(409, 'EVAL_CASE_CLASSIFICATION_INVALID', 'c1')),
      { permissions: AUTHOR },
    );
    const form = await screen.findByRole('form', { name: vi_['llm.datasets.form.title'] });
    await user.type(within(form).getByLabelText(vi_['llm.datasets.form.code']), 'sum-core');
    await user.type(within(form).getByLabelText(vi_['llm.datasets.form.task']), 'summarise');
    fireEvent.change(within(form).getByLabelText(vi_['llm.datasets.form.cases']), { target: { value: JSON.stringify([{ case_code: 'c1', input_ref: 'docs/1', expected: {} }]) } });
    await user.click(within(form).getByRole('button', { name: vi_['llm.datasets.form.submit'] }));
    expect((await screen.findByTestId('dataset-refused')).textContent).toBe(vi_['llm.reason.invalid']);
    unmount();
    mount(<DatasetsScreen route={DATASETS} />, client(normal()), { permissions: READER });
    await screen.findByTestId('dataset-table');
    expect(screen.queryByRole('form', { name: vi_['llm.datasets.form.title'] })).toBeNull();
  });

  it.each([
    ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
    ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
  ] as const)('UI-LLM-12 shows the %s state', async (_name, error, text) => {
    mount(<DatasetsScreen route={DATASETS} />, client({ ...normal(), datasets: error }), { permissions: AUTHOR });
    expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
  });
});

describe('LLM-04 model profiles (ST-LLM-004, LLM F3)', () => {
  it('shows each profile with its model, routes, class, effort and state, and links it to its release', async () => {
    mount(<ProfilesScreen route={PROFILES} />, client(normal()), { permissions: AUTHOR });
    const table = await screen.findByTestId('profile-table');
    const row = within(table).getAllByRole('row')[1] as HTMLElement;
    expect(row.textContent).toContain('summarise');
    expect(row.textContent).toContain('llm-small');
    expect(row.textContent).toContain(`${vi_['llm.route.domestic']}, ${vi_['llm.route.selfHosted']}`);
    expect(row.textContent).toContain(vi_['llm.effort.medium']);
    expect(row.textContent).toContain(vi_['llm.profileStatus.evalPending']);
    expect(within(row).getByRole('link', { name: vi_['llm.profiles.release'] }).getAttribute('href')).toBe(`/llm/llm-17?profile=${id(3)}`);
  });

  it('offers only approved models and approved prompts, keeps the international route for public data, and drafts with what was chosen', async () => {
    const user = userEvent.setup();
    const h = client(normal(), () => ({ status: 'DRAFT', revision: 3 }));
    mount(<ProfilesScreen route={PROFILES} />, h, { permissions: AUTHOR });
    const form = await screen.findByRole('form', { name: vi_['llm.profiles.form.title'] });
    await waitFor(() => expect(within(form).getByLabelText('llm-small')).toBeTruthy());
    expect(within(form).queryByLabelText('llm-draft')).toBeNull();
    expect(within(form).queryByRole('option', { name: /Tom tat van ban/ })).toBeNull();
    expect(within(form).getByRole('option', { name: /Da duyet #1/ })).toBeTruthy();
    expect(within(form).queryByLabelText(/write|ghi|delete|xoá/i)).toBeNull();
    await user.click(within(form).getByRole('button', { name: vi_['llm.profiles.form.submit'] }));
    expect((await within(form).findAllByText(vi_['llm.problem.required'])).length).toBeGreaterThan(0);
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['llm.profiles.form.task']), 'summarise');
    await user.selectOptions(within(form).getByLabelText(vi_['llm.profiles.form.model']), MODEL_A);
    await user.selectOptions(within(form).getByLabelText(vi_['llm.profiles.form.prompt']), id(5));
    await user.selectOptions(within(form).getByLabelText(vi_['llm.profiles.form.max']), 'INTERNAL');
    await user.click(within(form).getByLabelText(vi_['llm.route.international']));
    await user.click(within(form).getByRole('button', { name: vi_['llm.profiles.form.submit'] }));
    expect(await within(form).findByText(vi_['llm.problem.internationalPublicOnly'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.click(within(form).getByLabelText(vi_['llm.route.international']));
    await user.click(within(form).getByLabelText(vi_['llm.route.domestic']));
    await user.click(within(form).getByLabelText(vi_['llm.tool.readDocument']));
    await user.click(within(form).getByRole('button', { name: vi_['llm.profiles.form.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject([
      'createModelProfileVersion',
      { body: { task_type: 'summarise', model_id: 'llm-small', allowed_model_ids: [MODEL_A], prompt_version_id: id(5), routing_policy: { routes: ['DOMESTIC_HOSTED'] }, tool_allowlist: ['read_document'], max_classification: 'INTERNAL' } },
    ]);
    expect(await screen.findByTestId('profile-saved')).toBeTruthy();
  });

  it('does not draft a profile while the models or the prompts could not be read, and says so', async () => {
    const user = userEvent.setup();
    const h = client({ ...normal(), models: failure(500, 'INTERNAL_ERROR') });
    mount(<ProfilesScreen route={PROFILES} />, h, { permissions: AUTHOR });
    const form = await screen.findByRole('form', { name: vi_['llm.profiles.form.title'] });
    expect((await within(form).findByTestId('profile-sources-failed')).textContent).toContain(vi_['llm.profiles.form.sourcesFailed']);
    expect((within(form).getByRole('button', { name: vi_['llm.profiles.form.submit'] }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(form).getByLabelText(vi_['llm.profiles.form.task']), 'summarise');
    fireEvent.submit(form);
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.getByTestId('profile-table')).toBeTruthy();
  });

  it('puts the refusal of a route that is not allowed in words, and offers no form to who cannot manage profiles', async () => {
    const user = userEvent.setup();
    const h = client(normal(), () => failure(422, 'AI_ROUTE_NOT_ALLOWED'));
    const { unmount } = mount(<ProfilesScreen route={PROFILES} />, h, { permissions: AUTHOR });
    const form = await screen.findByRole('form', { name: vi_['llm.profiles.form.title'] });
    await waitFor(() => expect(within(form).getByLabelText('llm-small')).toBeTruthy());
    await user.type(within(form).getByLabelText(vi_['llm.profiles.form.task']), 'summarise');
    await user.selectOptions(within(form).getByLabelText(vi_['llm.profiles.form.model']), MODEL_A);
    await user.selectOptions(within(form).getByLabelText(vi_['llm.profiles.form.prompt']), id(5));
    await user.click(within(form).getByLabelText(vi_['llm.route.selfHosted']));
    await user.click(within(form).getByRole('button', { name: vi_['llm.profiles.form.submit'] }));
    expect((await screen.findByTestId('profile-refused')).textContent).toBe(vi_['llm.reason.routeNotAllowed']);
    unmount();
    mount(<ProfilesScreen route={PROFILES} />, client(normal()), { permissions: READER });
    await screen.findByTestId('profile-table');
    expect(screen.queryByRole('form', { name: vi_['llm.profiles.form.title'] })).toBeNull();
  });

  it.each([
    ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
    ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
  ] as const)('UI-LLM-04 shows the %s state', async (_name, error, text) => {
    mount(<ProfilesScreen route={PROFILES} />, client({ ...normal(), profiles: error }), { permissions: AUTHOR });
    expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
  });

  it('UI-LLM-04 says that there is no profile', async () => {
    mount(<ProfilesScreen route={PROFILES} />, client({ ...normal(), profiles: [] }), { permissions: AUTHOR });
    expect((await screen.findByTestId('profiles-none')).textContent).toBe(vi_['llm.profiles.empty']);
  });
});

describe('LLM-17 the release of a profile (ST-LLM-004, LLM F4, BR-LLM-11)', () => {
  const at = `/?profile=${id(3)}`;
  const RUN_D = rawRun({ id: id(20), route_class: 'DOMESTIC_HOSTED', review_status: 'SIGNED_PASS', signed_by: id(901) });
  const RUN_S = rawRun({ id: id(21), route_class: 'SELF_HOSTED', review_status: 'SIGNED_PASS', signed_by: id(901), cost_vnd: '0' });

  it('asks for a profile first, and says so when the one in the address is not there', async () => {
    const { unmount } = mount(<ReleaseScreen route={RELEASE} />, client(normal()), { permissions: PUBLISHER });
    expect((await screen.findByTestId('release-pick')).textContent).toBe(vi_['llm.release.pick']);
    unmount();
    mount(<ReleaseScreen route={RELEASE} />, client(normal()), { permissions: PUBLISHER }, `/?profile=${id(99)}`);
    expect((await screen.findByTestId('release-unknown')).textContent).toBe(vi_['llm.release.unknown']);
  });

  it('AC-ST-LLM-004-1: UAT-AC459 shows, for each route the profile may use, where its evaluation stands, the metrics that did not pass, and what it cost', async () => {
    const failed = rawRun({ id: id(21), route_class: 'SELF_HOSTED', review_status: 'PENDING_SIGNATURE', passed: false, failures: ['injection_resistance'], metrics: { ...METRICS, injection_resistance: 0.5 } });
    const h = client({ ...normal(), runs: [RUN_D, failed] });
    mount(<ReleaseScreen route={RELEASE} />, h, { permissions: PUBLISHER }, at);
    const table = await screen.findByTestId('gate-table');
    const domestic = table.querySelector('[data-route="DOMESTIC_HOSTED"]') as HTMLElement;
    const self = table.querySelector('[data-route="SELF_HOSTED"]') as HTMLElement;
    expect(domestic.getAttribute('data-gate')).toBe('SIGNED_PASS');
    expect(domestic.textContent).toContain(vi_['llm.gate.signedPass']);
    expect(domestic.textContent).toContain('15,000 ₫');
    expect(self.textContent).not.toContain('NaN');
    expect(self.getAttribute('data-gate')).toBe('UNSIGNED');
    const metric = self.querySelector('[data-metric="injection_resistance"]') as HTMLElement;
    expect(metric.getAttribute('data-failed')).toBe('true');
    expect(metric.textContent).toContain(vi_['llm.release.metricFailed']);
    expect(h.readAll).toHaveBeenCalledWith('get_resources_ai_eval_run', { query: { profile_version_id: id(3) } });
    expect(screen.getByTestId('release-status').textContent).toBe(vi_['llm.profileStatus.evalPending']);
  });

  it('starts an evaluation on a route with a dataset of the same task that has an injection case, and not with one that has none', async () => {
    const user = userEvent.setup();
    const datasets = [rawDataset(), rawDataset({ id: id(6), dataset_code: 'no-attack', injection_cases: 0 }), rawDataset({ id: id(7), dataset_code: 'other-task', task_type: 'classify' })];
    const h = client({ ...normal(), datasets }, () => ({ status: 'PENDING_SIGNATURE', passed: true, failures: [] }));
    mount(<ReleaseScreen route={RELEASE} />, h, { permissions: AUTHOR }, at);
    const table = await screen.findByTestId('gate-table');
    const row = table.querySelector('[data-route="DOMESTIC_HOSTED"]') as HTMLElement;
    const form = await within(row).findByRole('form', { name: fill(vi_['llm.release.start.title'], { route: vi_['llm.route.domestic'] }) });
    await waitFor(() => expect(within(form).getByRole('option', { name: /sum-core #1/ })).toBeTruthy());
    expect(within(form).queryByRole('option', { name: /no-attack/ })).toBeNull();
    expect(within(form).queryByRole('option', { name: /other-task/ })).toBeNull();
    expect((within(form).getByRole('button', { name: vi_['llm.release.start.submit'] }) as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(within(form).getByLabelText(vi_['llm.release.start.dataset']), id(2));
    await user.click(within(form).getByRole('button', { name: vi_['llm.release.start.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['startAiEvalRun', { body: { profile_version_id: id(3), dataset_version_id: id(2), route_class: 'DOMESTIC_HOSTED' } }]);
  });

  it('keeps the international route to public datasets', async () => {
    const world = { ...normal(), profiles: [rawProfile({ routing_policy: { routes: ['INTERNATIONAL'], thresholds: THRESHOLDS }, max_classification: 'PUBLIC' })], datasets: [rawDataset(), rawDataset({ id: id(6), dataset_code: 'public-set', max_classification: 'PUBLIC' })] };
    mount(<ReleaseScreen route={RELEASE} />, client(world), { permissions: AUTHOR }, at);
    const table = await screen.findByTestId('gate-table');
    const form = await within(table).findByRole('form', { name: fill(vi_['llm.release.start.title'], { route: vi_['llm.route.international'] }) });
    await waitFor(() => expect(within(form).getByRole('option', { name: /public-set/ })).toBeTruthy());
    expect(within(form).queryByRole('option', { name: /sum-core/ })).toBeNull();
  });

  it('puts the refusal of an evaluation that cannot be planned in words', async () => {
    const user = userEvent.setup();
    const h = client(normal(), () => failure(422, 'AI_ROUTE_NOT_ALLOWED'));
    mount(<ReleaseScreen route={RELEASE} />, h, { permissions: AUTHOR }, at);
    const table = await screen.findByTestId('gate-table');
    const row = table.querySelector('[data-route="SELF_HOSTED"]') as HTMLElement;
    await waitFor(() => expect(within(row).getByRole('option', { name: /sum-core/ })).toBeTruthy());
    await user.selectOptions(within(row).getByLabelText(vi_['llm.release.start.dataset']), id(2));
    await user.click(within(row).getByRole('button', { name: vi_['llm.release.start.submit'] }));
    expect((await screen.findByTestId('start-refused')).textContent).toBe(vi_['llm.reason.routeNotAllowed']);
  });

  it('signs a result that waits for an expert, with a comment of ten characters, at the version it was read at', async () => {
    const user = userEvent.setup();
    const pending = rawRun({ id: id(22), route_class: 'DOMESTIC_HOSTED', version: 3 });
    const h = client({ ...normal(), runs: [pending] }, () => ({ status: 'SIGNED_PASS' }));
    mount(<ReleaseScreen route={RELEASE} />, h, { permissions: EXPERT }, at);
    const table = await screen.findByTestId('gate-table');
    const row = table.querySelector('[data-route="DOMESTIC_HOSTED"]') as HTMLElement;
    expect(within(row).queryByRole('form')).toBeNull();
    await user.click(within(row).getByRole('button', { name: vi_['llm.release.sign'] }));
    const form = await screen.findByRole('form', { name: vi_['llm.release.sign.title'] });
    expect((within(form).getByLabelText(vi_['llm.release.sign.decision']) as HTMLSelectElement).value).toBe('PASS');
    await user.type(within(form).getByLabelText(vi_['llm.release.sign.comment']), 'too short');
    await user.click(within(form).getByRole('button', { name: vi_['llm.release.sign.submit'] }));
    expect(await within(form).findByText(fill(vi_['llm.release.sign.short'], { count: 10 }))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['llm.release.sign.comment']), ' - checked the cases by hand');
    await user.click(within(form).getByRole('button', { name: vi_['llm.release.sign.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['signAiEvalRun', { path: { id: id(22) }, ifMatchVersion: 3, body: { decision: 'PASS', comment: 'too short - checked the cases by hand' } }]);
  });

  it.each([
    ['SELF_APPROVAL_DENIED', 403, 'llm.reason.selfApproval'],
    ['EVAL_NOT_FINISHED', 409, 'llm.reason.evalNotFinished'],
    ['VERSION_CONFLICT', 409, 'llm.reason.stale'],
  ] as const)('puts the refusal %s of a signature in words', async (code, status, key) => {
    const user = userEvent.setup();
    mount(
      <ReleaseScreen route={RELEASE} />,
      client({ ...normal(), runs: [rawRun()] }, () => failure(status, code)),
      { permissions: EXPERT },
      at,
    );
    const table = await screen.findByTestId('gate-table');
    await user.click(within(table).getByRole('button', { name: vi_['llm.release.sign'] }));
    const form = await screen.findByRole('form', { name: vi_['llm.release.sign.title'] });
    await user.type(within(form).getByLabelText(vi_['llm.release.sign.comment']), 'looked at all of the cases');
    await user.click(within(form).getByRole('button', { name: vi_['llm.release.sign.submit'] }));
    expect((await screen.findByTestId('sign-refused')).textContent).toBe(vi_[key]);
  });

  it('AC-ST-LLM-004-1: UAT-AC459 does not offer to release while a route has no signed pass, or a model is not approved, and says what stands in the way', async () => {
    const { unmount } = mount(<ReleaseScreen route={RELEASE} />, client({ ...normal(), runs: [RUN_D] }), { permissions: PUBLISHER }, at);
    const form = await screen.findByRole('form', { name: vi_['llm.release.decide.title'] });
    expect(within(form).getByTestId('release-blocked').textContent).toBe(vi_['llm.release.decide.blocked']);
    expect((within(form).getByRole('button', { name: vi_['llm.release.decide.publish'] }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    const world = { ...normal(), runs: [RUN_D, RUN_S], profiles: [rawProfile({ allowed_model_ids: [MODEL_A, MODEL_B] })] };
    mount(<ReleaseScreen route={RELEASE} />, client(world), { permissions: PUBLISHER }, at);
    const blocked = await screen.findByRole('form', { name: vi_['llm.release.decide.title'] });
    expect((await screen.findByTestId('release-unapproved')).textContent).toBe(fill(vi_['llm.release.unapproved'], { models: 'llm-draft' }));
    expect((within(blocked).getByRole('button', { name: vi_['llm.release.decide.publish'] }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('AC-ST-LLM-004-3: UAT-NFR-AI-04 releases with the signed passing run of each route as the evidence, at the version it was read at, and with a reason', async () => {
    const user = userEvent.setup();
    const h = client({ ...normal(), runs: [RUN_D, RUN_S] }, () => ({ status: 'PUBLISHED', evidence_run_ids: [id(20), id(21)] }));
    mount(<ReleaseScreen route={RELEASE} />, h, { permissions: PUBLISHER }, at);
    const form = await screen.findByRole('form', { name: vi_['llm.release.decide.title'] });
    expect(within(form).queryByTestId('release-blocked')).toBeNull();
    expect(within(form).queryByRole('button', { name: vi_['llm.release.decide.return'] })).not.toBeNull();
    await user.click(within(form).getByRole('button', { name: vi_['llm.release.decide.publish'] }));
    expect(await within(form).findByText(vi_['llm.problem.required'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['llm.release.decide.reason']), 'Both routes passed the evaluation');
    await user.click(within(form).getByRole('button', { name: vi_['llm.release.decide.publish'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['post_model_profiles_id_publish', { path: { id: id(3) }, ifMatchVersion: 5, body: { decision: 'approve', reason: 'Both routes passed the evaluation', evidence_ids: [id(20), id(21)] } }]);
    expect(await screen.findByTestId('release-done')).toBeTruthy();
  });

  it('sends a profile back to draft with a reason and no evidence, only while it waits for an evaluation', async () => {
    const user = userEvent.setup();
    const h = client({ ...normal(), runs: [RUN_D, RUN_S] }, () => ({ status: 'DRAFT', evidence_run_ids: [] }));
    const { unmount } = mount(<ReleaseScreen route={RELEASE} />, h, { permissions: PUBLISHER }, at);
    const form = await screen.findByRole('form', { name: vi_['llm.release.decide.title'] });
    await user.type(within(form).getByLabelText(vi_['llm.release.decide.reason']), 'The prompt must change first');
    await user.click(within(form).getByRole('button', { name: vi_['llm.release.decide.return'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['post_model_profiles_id_publish', { path: { id: id(3) }, ifMatchVersion: 5, body: { decision: 'return', reason: 'The prompt must change first', evidence_ids: [] } }]);
    unmount();
    mount(<ReleaseScreen route={RELEASE} />, client({ ...normal(), profiles: [rawProfile({ status: 'DRAFT' })], runs: [RUN_D, RUN_S] }), { permissions: PUBLISHER }, at);
    const draft = await screen.findByRole('form', { name: vi_['llm.release.decide.title'] });
    expect(within(draft).queryByRole('button', { name: vi_['llm.release.decide.return'] })).toBeNull();
  });

  it.each([
    ['EVAL_NOT_PASSED', 409, 'llm.reason.evalNotPassed'],
    ['EVAL_MISSING_FOR_ROUTE', 409, 'llm.reason.evalMissing'],
    ['EVAL_REQUIRED', 409, 'llm.reason.evalRequired'],
    ['MODEL_NOT_APPROVED', 422, 'llm.reason.modelNotApproved'],
    ['UNSUPPORTED_PARAMETER', 422, 'llm.reason.unsupportedParameter'],
    ['SELF_APPROVAL_DENIED', 403, 'llm.reason.selfApproval'],
  ] as const)('puts the refusal %s of a release in words, as the server judges it again', async (code, status, key) => {
    const user = userEvent.setup();
    mount(
      <ReleaseScreen route={RELEASE} />,
      client({ ...normal(), runs: [RUN_D, RUN_S] }, () => failure(status, code)),
      { permissions: PUBLISHER },
      at,
    );
    const form = await screen.findByRole('form', { name: vi_['llm.release.decide.title'] });
    await user.type(within(form).getByLabelText(vi_['llm.release.decide.reason']), 'Both routes passed the evaluation');
    await user.click(within(form).getByRole('button', { name: vi_['llm.release.decide.publish'] }));
    expect((await screen.findByTestId('release-refused')).textContent).toBe(vi_[key]);
  });

  it('shows a profile that is already in force or was replaced without any action, and nothing to who cannot act', async () => {
    const { unmount } = mount(<ReleaseScreen route={RELEASE} />, client({ ...normal(), profiles: [rawProfile({ status: 'PUBLISHED' })], runs: [RUN_D, RUN_S] }), { permissions: [...AUTHOR, ...EXPERT, ...PUBLISHER] }, at);
    const table = await screen.findByTestId('gate-table');
    expect(within(table).queryAllByRole('button').length).toBe(0);
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.getByTestId('release-status').textContent).toBe(vi_['llm.profileStatus.published']);
    unmount();
    mount(<ReleaseScreen route={RELEASE} />, client({ ...normal(), runs: [rawRun()] }), { permissions: READER }, at);
    const reader = await screen.findByTestId('gate-table');
    expect(within(reader).queryAllByRole('button').length).toBe(0);
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('offers nothing to act with in a read-only session', async () => {
    mount(<ReleaseScreen route={RELEASE} />, client({ ...normal(), runs: [rawRun()] }), { permissions: [...AUTHOR, ...EXPERT, ...PUBLISHER], mode: 'READ_ONLY' }, at);
    const table = await screen.findByTestId('gate-table');
    expect(within(table).queryAllByRole('button').length).toBe(0);
    expect(screen.queryByRole('form')).toBeNull();
  });

  it.each([
    ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
    ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
    ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
  ] as const)('UI-LLM-17 shows the %s state when the evaluations cannot be read', async (_name, error, text) => {
    mount(<ReleaseScreen route={RELEASE} />, client({ ...normal(), runs: error }), { permissions: PUBLISHER }, at);
    expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
  });

  it('UI-LLM-17 reads again what failed, the models and the datasets as well as the runs, and does not hide a datasets failure from who starts evaluations', async () => {
    const user = userEvent.setup();
    const world: World = { ...normal(), models: failure(500, 'INTERNAL_ERROR'), datasets: failure(500, 'INTERNAL_ERROR') };
    const h = client(world);
    mount(<ReleaseScreen route={RELEASE} />, h, { permissions: AUTHOR }, at);
    expect((await screen.findAllByText(vi_['states.error.title'])).length).toBeGreaterThan(0);
    const calls = () => h.readAll.mock.calls.map((call) => call[0]);
    const before = { models: calls().filter((name) => name === 'listAiModels').length, datasets: calls().filter((name) => name === 'listAiEvalDatasets').length };
    await user.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(calls().filter((name) => name === 'listAiModels').length).toBeGreaterThan(before.models));
    expect(calls().filter((name) => name === 'listAiEvalDatasets').length).toBeGreaterThan(before.datasets);
  });

  it('UI-LLM-17 shows the loading state first and names the page', () => {
    const h = harness(() => new Error('unexpected'));
    (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
    mount(<ReleaseScreen route={RELEASE} />, h, { permissions: PUBLISHER });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(screen.getByRole('region', { name: vi_['llm.release.page.title'] })).toBeTruthy();
  });
});

describe('LLM-03 approval of a model (ST-LLM-004)', () => {
  const SECURITY = ['llm.provider.approve', 'llm.provider.read'];

  it('offers approval on a model that is not approved yet, to who may approve, at the version it was read at', async () => {
    const user = userEvent.setup();
    const h = client(normal(), () => ({ status: 'APPROVED' }));
    mount(<ModelsScreen route={MODELS} />, h, { permissions: SECURITY });
    const table = await screen.findByTestId('model-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0] as HTMLElement).queryByRole('button', { name: vi_['llm.models.approve'] })).toBeNull();
    await user.click(within(rows[1] as HTMLElement).getByRole('button', { name: vi_['llm.models.approve'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['approveAiModel', { path: { id: MODEL_B }, ifMatchVersion: 4 }]);
  });

  it('says that the person who registered a model cannot approve it, and offers no approval to who may only manage', async () => {
    const user = userEvent.setup();
    const { unmount } = mount(
      <ModelsScreen route={MODELS} />,
      client(normal(), () => failure(403, 'SELF_APPROVAL_DENIED')),
      { permissions: SECURITY },
    );
    const table = await screen.findByTestId('model-table');
    await user.click(within(table).getByRole('button', { name: vi_['llm.models.approve'] }));
    expect((await screen.findByTestId('model-approve-refused')).textContent).toBe(vi_['llm.reason.selfApproval']);
    unmount();
    mount(<ModelsScreen route={MODELS} />, client(normal()), { permissions: ['llm.provider.manage', 'llm.provider.read'] });
    const again = await screen.findByTestId('model-table');
    expect(within(again).queryByRole('button', { name: vi_['llm.models.approve'] })).toBeNull();
  });
});
