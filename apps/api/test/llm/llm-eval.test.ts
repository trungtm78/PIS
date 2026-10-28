import { randomUUID } from 'node:crypto';
import { sha256Of } from '@machvon/kernel';
import { AI_ADMIN, EVAL_BOTH, EXPERT, KEY_READER, LlmApp, NOBODY, PROMPT_APPROVER, PROMPT_AUTHOR, PUBLISHER, READER, SCOPED, SECURITY, TENANT_B, memberId } from './llm-app';
import type { Reply } from './llm-app';

const app = new LlmApp();
jest.setTimeout(240_000);

beforeAll(() => app.start());
afterAll(() => app.stop());

let since = new Date();
beforeEach(async () => {
  await app.reset();
  app.runner.clear();
  since = new Date();
});

const SCHEMA = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
const etag = (reply: Reply): string => `"${String(reply.json.resource_version)}"`;
const audits = (action: string) => app.rows<{ safe_diff: Record<string, any> }>('select safe_diff from machvon.audit_event where action = $1 and occurred_at >= $2 order by occurred_at', [action, since]); // eslint-disable-line @typescript-eslint/no-explicit-any
const events = (type: string) => app.rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where type = $1 and created_at >= $2 order by created_at', [type, since]);

// ---- the world of a tenant that has a domestic and an international provider, an approved prompt and a dataset ----------------------------------

async function provider(code: string, route: 'DOMESTIC_HOSTED' | 'INTERNATIONAL', activate = true): Promise<string> {
  const made = await app.call('POST', '/ai-providers', {
    member: AI_ADMIN,
    body: { provider_code: code, name: code, region_country: route === 'INTERNATIONAL' ? 'US' : 'VN', route_class: route, max_classification: 'PUBLIC' },
  });
  expect(made.status).toBe(200);
  if (activate) {
    const done = await app.call('POST', `/ai-providers/${made.json.resource_id as string}/activation`, { member: SECURITY, ifMatch: etag(made), body: route === 'INTERNATIONAL' ? { d07_approval_ref: 'D07-2026-01' } : {} });
    expect(done.status).toBe(200);
  }
  return made.json.resource_id as string;
}

async function model(providerId: string, code: string, options: { approve?: boolean; reasoning?: boolean } = {}): Promise<string> {
  const made = await app.call('POST', '/ai-models', {
    member: AI_ADMIN,
    body: { provider_id: providerId, model_id: code, capabilities: options.reasoning === true ? { reasoning: true } : {}, context_window: 8000, max_output: 1000, max_classification: 'PUBLIC' },
  });
  expect(made.status).toBe(200);
  if (options.approve !== false) expect((await app.call('POST', `/ai-models/${made.json.resource_id as string}/approval`, { member: SECURITY, ifMatch: etag(made), body: {} })).status).toBe(200);
  return made.json.resource_id as string;
}

const promptBody = (overrides: Record<string, unknown> = {}) => ({ task_type: 'SUMMARY', name: 'summary', template_object_key: 'tenants/t/prompts/summary-r1.txt', template_sha256: sha256Of('summary template'), input_schema: SCHEMA, output_schema: SCHEMA, ...overrides });
const draftPrompt = (overrides: Record<string, unknown> = {}, member = PROMPT_AUTHOR): Promise<Reply> => app.call('POST', '/ai-prompts', { member, body: promptBody(overrides) });
const approvePrompt = (id: string, version: string, member = PROMPT_APPROVER): Promise<Reply> => app.call('POST', `/ai-prompts/${id}/approval`, { member, ifMatch: version, body: {} });
async function approvedPrompt(overrides: Record<string, unknown> = {}): Promise<string> {
  const drafted = await draftPrompt(overrides);
  expect(drafted.status).toBe(200);
  const approved = await approvePrompt(drafted.json.resource_id as string, etag(drafted));
  expect(approved.status).toBe(200);
  return drafted.json.resource_id as string;
}

const kase = (code: string, extra: Record<string, unknown> = {}) => ({ case_code: code, input_ref: `inputs/${code}.txt`, expected: { answer: 'x' }, ...extra });
const dataset = (overrides: Record<string, unknown> = {}, member = PROMPT_AUTHOR): Promise<Reply> =>
  app.call('POST', '/ai-eval-datasets', { member, body: { dataset_code: 'EV-SUM', task_type: 'SUMMARY', source: 'SYNTHETIC', cases: [kase('c1', { classification: 'PUBLIC' }), kase('inj-1', { classification: 'PUBLIC', tags: ['injection'] })], ...overrides } });

const profileBody = (world: World, overrides: Record<string, unknown> = {}) => ({
  task_type: 'SUMMARY',
  model_id: 'dom-model',
  allowed_model_ids: [world.domestic, world.international],
  output_cap: 1000,
  max_input_tokens: 8000,
  timeout_ms: 30_000,
  concurrency_limit: 4,
  output_schema: SCHEMA,
  tool_allowlist: ['search_documents'],
  max_classification: 'PUBLIC',
  routing_policy: { routes: ['DOMESTIC_HOSTED', 'INTERNATIONAL'] },
  prompt_version_id: world.prompt,
  retention_days: 90,
  ...overrides,
});
const draftProfile = (world: World, overrides: Record<string, unknown> = {}, member = PROMPT_AUTHOR): Promise<Reply> => app.call('POST', '/model-profiles', { member, body: profileBody(world, overrides) });
const startRun = (profileId: string, datasetId: string, route: string, member = PROMPT_AUTHOR): Promise<Reply> => app.call('POST', '/ai-eval-runs', { member, body: { profile_version_id: profileId, dataset_version_id: datasetId, route_class: route } });
const sign = (id: string, version: string, decision: 'PASS' | 'FAIL', member = EXPERT, comment = 'Reviewed the cases and the metrics'): Promise<Reply> => app.call('POST', `/ai-eval-runs/${id}/signature`, { member, ifMatch: version, body: { decision, comment } });
const publish = (id: string, version: string, member = PUBLISHER, body: Record<string, unknown> = {}): Promise<Reply> =>
  app.call('POST', `/model-profiles/${id}/publish`, { member, ifMatch: version, body: { decision: 'approve', reason: 'Both routes were evaluated and signed', evidence_ids: [], ...body } });
const profileVersion = async (id: string): Promise<string> => `"${String((await app.call('GET', `/resources/model_profile_version/${id}`, { member: PUBLISHER })).json.version)}"`;

interface World {
  domestic: string;
  international: string;
  prompt: string;
  dataset: string;
}

const MATRIX = { PUBLIC: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], INTERNAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], CONFIDENTIAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], PERSONAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], IMPORTANT_CORE: ['SELF_HOSTED'] };

/** The policy of the tenant in force: the international route is on only when one is published that turns it on (with the approval of D07). */
async function publishPolicy(international: boolean): Promise<void> {
  const matrix = international ? { ...MATRIX, PUBLIC: [...MATRIX.PUBLIC, 'INTERNATIONAL'] } : MATRIX;
  const drafted = await app.call('POST', '/ai-classification-policies', {
    member: AI_ADMIN,
    body: { matrix, international_enabled: international, ...(international ? { d07_approval_ref: 'D07-2026-01' } : {}), legal_basis: 'Luat 2026', effective_from: '2026-01-01T00:00:00.000Z' },
  });
  expect(drafted.status).toBe(200);
  expect((await app.call('POST', `/ai-classification-policies/${drafted.json.resource_id as string}/publish`, { member: SECURITY, ifMatch: etag(drafted), body: {} })).status).toBe(200);
}

async function world(policy: 'international' | 'compliant' | 'none' = 'international'): Promise<World> {
  if (policy !== 'none') await publishPolicy(policy === 'international');
  const dom = await provider('VN-HOST', 'DOMESTIC_HOSTED');
  const intl = await provider('INTL-1', 'INTERNATIONAL');
  const domestic = await model(dom, 'dom-model');
  const international = await model(intl, 'intl-model');
  const prompt = await approvedPrompt();
  const made = await dataset();
  expect(made.status).toBe(200);
  return { domestic, international, prompt, dataset: made.json.resource_id as string };
}

/** Starts a run on a route, signs it and says what it came to. */
async function evaluated(profileId: string, datasetId: string, route: string, decision: 'PASS' | 'FAIL'): Promise<Reply> {
  const run = await startRun(profileId, datasetId, route);
  expect(run.status).toBe(200);
  const signed = await sign(run.json.resource_id as string, etag(run), decision);
  expect([signed.status, signed.json.status]).toEqual([200, decision === 'PASS' ? 'SIGNED_PASS' : 'SIGNED_FAIL']);
  return run;
}

describe('the approval of a model (ST-LLM-004, LLM-03)', () => {
  it('approves a model once, by someone other than who registered it, while its provider is active', async () => {
    const dom = await provider('VN-HOST', 'DOMESTIC_HOSTED');
    const made = await app.call('POST', '/ai-models', { member: AI_ADMIN, body: { provider_id: dom, model_id: 'dom-model', capabilities: {}, context_window: 8000, max_output: 1000, max_classification: 'PUBLIC' } });
    const id = made.json.resource_id as string;
    expect((await app.call('POST', `/ai-models/${id}/approval`, { member: SECURITY, ifMatch: '"9"', body: {} })).json.code).toBe('VERSION_CONFLICT');
    const done = await app.call('POST', `/ai-models/${id}/approval`, { member: SECURITY, ifMatch: etag(made), body: {} });
    expect([done.status, done.json.status]).toEqual([200, 'APPROVED']);
    expect((await app.call('POST', `/ai-models/${id}/approval`, { member: SECURITY, ifMatch: etag(done), body: {} })).json.code).toBe('STAGE_TRANSITION_DENIED');
    expect((await app.rows<{ approved_by: string }>('select approved_by from machvon.ai_model where id = $1', [id]))[0]?.approved_by).toBe(memberId(SECURITY));
    expect((await audits('llm.model_approved')).length).toBe(1);
    expect((await events('llm.model.approved.v1')).length).toBe(1);
    // A provider that is not active has no model to approve; and the one who registered it does not approve it.
    const idle = await provider('IDLE-1', 'DOMESTIC_HOSTED', false);
    const proposed = await app.call('POST', '/ai-models', { member: AI_ADMIN, body: { provider_id: idle, model_id: 'idle-model', capabilities: {}, context_window: 8000, max_output: 1000, max_classification: 'PUBLIC' } });
    const refused = await app.call('POST', `/ai-models/${proposed.json.resource_id as string}/approval`, { member: SECURITY, ifMatch: etag(proposed), body: {} });
    expect([refused.status, refused.json.code, refused.json.detail]).toEqual([409, 'STAGE_TRANSITION_DENIED', 'provider']);
    expect((await app.call('POST', `/ai-models/${randomUUID()}/approval`, { member: SECURITY, ifMatch: '"1"', body: {} })).status).toBe(404);
    await expect(app.rows('update machvon.ai_model set approved_by = created_by where id = $1', [id])).rejects.toThrow(/ai_model_sod_chk/);
  });
});

describe('the prompts (ST-LLM-004, LLM-10, LLM BR-LLM-10)', () => {
  it('AC-ST-LLM-004-2: UAT-AC463 refuses the author as the approver, approves by another as the PRODUCTION revision, and then no longer edits it: 409 PROMPT_IMMUTABLE with the hash unchanged', async () => {
    const drafted = await draftPrompt();
    expect([drafted.status, drafted.json.revision]).toEqual([200, 1]);
    const id = drafted.json.resource_id as string;
    // The author holds no right to approve, and one who held both would still be refused: both are tried.
    expect((await approvePrompt(id, etag(drafted), PROMPT_AUTHOR)).status).toBe(403);
    await app.rows("update machvon.ai_prompt_version set created_by = $2 where id = $1", [id, memberId(PROMPT_APPROVER)]);
    const own = await approvePrompt(id, etag(drafted));
    expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
    await app.rows("update machvon.ai_prompt_version set created_by = $2 where id = $1", [id, memberId(PROMPT_AUTHOR)]);
    const approved = await approvePrompt(id, etag(drafted));
    expect([approved.status, approved.json.status]).toEqual([200, 'APPROVED']);
    const stored = (await app.rows<{ label: string; status: string; template_sha256: string; approved_by: string }>('select label, status, template_sha256, approved_by from machvon.ai_prompt_version where id = $1', [id]))[0]!;
    expect(stored).toMatchObject({ label: 'PRODUCTION', status: 'APPROVED', template_sha256: sha256Of('summary template'), approved_by: memberId(PROMPT_APPROVER) });

    const edited = await app.call('PUT', `/ai-prompts/${id}`, { member: PROMPT_AUTHOR, ifMatch: etag(approved), body: promptBody({ template_sha256: sha256Of('another template') }) });
    expect([edited.status, edited.json.code]).toEqual([409, 'PROMPT_IMMUTABLE']);
    expect((await app.rows<{ template_sha256: string }>('select template_sha256 from machvon.ai_prompt_version where id = $1', [id]))[0]?.template_sha256).toBe(sha256Of('summary template'));
    // The database says the same to a write that skips the service.
    await expect(app.rows("update machvon.ai_prompt_version set template_sha256 = $2 where id = $1", [id, sha256Of('sneaky')])).rejects.toThrow(/approved is not edited/);
    await expect(app.rows("update machvon.ai_prompt_version set output_schema = '{}'::jsonb where id = $1", [id])).rejects.toThrow(/not edited/);

    // A new revision is made instead, and its approval retires the one that was in production.
    const next = await draftPrompt({ template_sha256: sha256Of('another template') });
    expect(next.json.revision).toBe(2);
    expect((await approvePrompt(next.json.resource_id as string, etag(next))).status).toBe(200);
    const states = await app.rows<{ revision: number; status: string; label: string | null }>('select revision, status, label from machvon.ai_prompt_version order by revision');
    expect(states).toEqual([
      { revision: 1, status: 'RETIRED', label: null },
      { revision: 2, status: 'APPROVED', label: 'PRODUCTION' },
    ]);
    expect((await audits('llm.prompt_approved')).length).toBe(2);
    expect((await events('llm.prompt.approved.v1')).length).toBe(2);
  });

  it('AC-ST-LLM-004-2: UAT-AC463 lets only the author change a draft, so that nobody approves text they changed themselves', async () => {
    const drafted = await draftPrompt();
    const id = drafted.json.resource_id as string;
    await app.rows('update machvon.ai_prompt_version set created_by = $2 where id = $1', [id, memberId(PROMPT_APPROVER)]);
    const revised = await app.call('PUT', `/ai-prompts/${id}`, { member: PROMPT_AUTHOR, ifMatch: etag(drafted), body: promptBody({ template_sha256: sha256Of('rewritten by someone else') }) });
    expect([revised.status, revised.json.code]).toEqual([403, 'SCOPE_DENIED']);
    expect((await app.rows<{ template_sha256: string }>('select template_sha256 from machvon.ai_prompt_version where id = $1', [id]))[0]?.template_sha256).toBe(sha256Of('summary template'));
  });

  it('edits a draft, keeps what names it, and refuses a stale version, schemas that are not schemas and a hash that is not one', async () => {
    const drafted = await draftPrompt();
    const id = drafted.json.resource_id as string;
    const revised = await app.call('PUT', `/ai-prompts/${id}`, { member: PROMPT_AUTHOR, ifMatch: etag(drafted), body: promptBody({ template_sha256: sha256Of('draft two') }) });
    expect([revised.status, revised.json.status]).toEqual([200, 'DRAFT']);
    expect((await app.rows<{ template_sha256: string }>('select template_sha256 from machvon.ai_prompt_version where id = $1', [id]))[0]?.template_sha256).toBe(sha256Of('draft two'));
    expect((await app.call('PUT', `/ai-prompts/${id}`, { member: PROMPT_AUTHOR, ifMatch: etag(drafted), body: promptBody() })).json.code).toBe('VERSION_CONFLICT');
    expect((await app.call('PUT', `/ai-prompts/${id}`, { member: PROMPT_AUTHOR, ifMatch: etag(revised), body: promptBody({ name: 'other' }) })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'name' });
    expect((await draftPrompt({ output_schema: { type: 'string' } })).json).toMatchObject({ code: 'PROMPT_SCHEMA_INVALID', detail: 'output_schema' });
    expect((await draftPrompt({ input_schema: { type: 'object', properties: {} } })).json.code).toBe('PROMPT_SCHEMA_INVALID');
    expect((await draftPrompt({ template_sha256: 'abc' })).status).toBeGreaterThanOrEqual(400);
    expect((await draftPrompt({ secret: 'x' } as never)).json.code).toBe('FIELD_NOT_ALLOWED');
    expect((await app.call('PUT', `/ai-prompts/${randomUUID()}`, { member: PROMPT_AUTHOR, ifMatch: '"1"', body: promptBody() })).status).toBe(404);
    const listed = await app.call('GET', '/ai-prompts', { member: PROMPT_AUTHOR });
    const item = (listed.json.items as Array<Record<string, unknown>>)[0]!;
    expect(item).toMatchObject({ name: 'summary', revision: 1, status: 'DRAFT', label: null });
    expect(JSON.stringify(item)).not.toContain('template_object_key');
  });
});

describe('the datasets (ST-LLM-004, LLM-12)', () => {
  it('makes the next revision of a dataset of synthetic cases, counts its injection cases, and lists it', async () => {
    const first = await dataset();
    expect([first.status, first.json.revision]).toEqual([200, 1]);
    const second = await dataset();
    expect(second.json.revision).toBe(2);
    const listed = await app.call('GET', '/ai-eval-datasets', { member: PROMPT_AUTHOR });
    expect((listed.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ dataset_code: 'EV-SUM', revision: 2, source: 'SYNTHETIC', max_classification: 'PUBLIC', case_count: 2, injection_cases: 1, status: 'APPROVED' });
    expect((await app.rows('select 1 from machvon.ai_eval_case')).length).toBe(4);
    expect((await events('llm.eval_dataset.created.v1')).length).toBe(2);
    expect((await audits('llm.eval_dataset_created'))[0]?.safe_diff).toMatchObject({ dataset_code: 'EV-SUM', injection_cases: 1 });
  });

  it('refuses a case above internal as real data, naming the case, and a source that is real data, an empty set and a repeated case', async () => {
    const refused = await dataset({ cases: [kase('c1'), kase('c2', { classification: 'PERSONAL' })] });
    expect([refused.status, refused.json.code, refused.json.detail]).toEqual([409, 'EVAL_CASE_CLASSIFICATION_INVALID', 'c2']);
    expect((await app.rows('select 1 from machvon.ai_eval_dataset_version')).length).toBe(0);
    expect((await dataset({ source: 'PRODUCTION' })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'source' });
    expect((await dataset({ cases: [] })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'cases' });
    expect((await dataset({ cases: [kase('c1'), kase('c1')] })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'cases' });
    expect((await dataset({}, READER)).status).toBe(403);
  });
});

describe('the profiles (ST-LLM-004, LLM-04)', () => {
  it('drafts the next revision of a profile of a task, with the routes and the thresholds it keeps, and lists it', async () => {
    const w = await world();
    const first = await draftProfile(w);
    expect([first.status, first.json.status, first.json.revision]).toEqual([200, 'DRAFT', 1]);
    const second = await draftProfile(w, { routing_policy: { routes: ['DOMESTIC_HOSTED'], thresholds: { citation_precision_min: 0.98 } } });
    expect(second.json.revision).toBe(2);
    const view = (await app.call('GET', `/resources/model_profile_version/${second.json.resource_id as string}`, { member: PUBLISHER })).json;
    expect(view).toMatchObject({ task_type: 'SUMMARY', revision: 2, status: 'DRAFT', max_classification: 'PUBLIC', rollback_profile_id: null, routing_policy: { routes: ['DOMESTIC_HOSTED'], thresholds: { citation_precision_min: 0.98, unsupported_claim_rate_max: 0.02, injection_resistance_min: 1, schema_valid_rate_min: 0.99 } } });
    expect(((await app.call('GET', '/resources/model_profile_version', { member: PUBLISHER })).json.items as unknown[]).length).toBe(2);
    expect((await events('llm.profile.drafted.v1')).length).toBe(2);
    expect((await app.call('GET', `/resources/model_profile_version/${randomUUID()}`, { member: PUBLISHER })).status).toBe(404);
  });

  it('refuses a tool that writes, an effort a model does not take, an international route above public data, a route no model reaches, a prompt that is not approved and a threshold that is looser than the baseline', async () => {
    const w = await world();
    const field = async (overrides: Record<string, unknown>) => (await draftProfile(w, overrides)).json;
    // A schema that says more than the gateway checks is not accepted: no answer is taken as valid by a rule that was not applied.
    expect(await field({ output_schema: { type: 'object', oneOf: [] } })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'output_schema' });
    expect(await field({ tool_allowlist: ['search_documents', 'delete_document'] })).toMatchObject({ code: 'TOOL_NOT_READ_ONLY', detail: 'delete_document' });
    expect(await field({ effort: 'high' })).toMatchObject({ code: 'UNSUPPORTED_PARAMETER', detail: 'effort' });
    expect(await field({ max_classification: 'INTERNAL' })).toMatchObject({ code: 'AI_ROUTE_NOT_ALLOWED', detail: 'routing_policy' });
    expect(await field({ allowed_model_ids: [w.domestic] })).toMatchObject({ code: 'AI_ROUTE_NOT_ALLOWED', detail: 'INTERNATIONAL' });
    expect(await field({ prompt_version_id: (await draftPrompt({ name: 'unapproved' })).json.resource_id })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'prompt_version_id' });
    expect(await field({ routing_policy: { routes: ['DOMESTIC_HOSTED'], thresholds: { injection_resistance_min: 0.9 } } })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'routing_policy' });
    expect(await field({ model_id: 'another' })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'model_id' });
    expect(await field({ allowed_model_ids: [randomUUID()] })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'allowed_model_ids' });
    expect(await field({ rollback_profile_id: randomUUID() })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'rollback_profile_id' });
    expect(await field({ output_cap: 0 })).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'output_cap' });
    expect(await field({ secret: 'x' })).toMatchObject({ code: 'FIELD_NOT_ALLOWED' });
    await app.rows("update machvon.ai_model set status = 'SUSPENDED' where id = $1", [w.international]);
    expect(await field({})).toMatchObject({ code: 'MODEL_NOT_APPROVED' });
    expect((await app.rows('select 1 from machvon.model_profile_version')).length).toBe(0);
    // An effort is taken when every model takes it.
    const dom = await provider('REASON-1', 'DOMESTIC_HOSTED');
    const reasoning = await model(dom, 'reason-model', { reasoning: true });
    const ok = await draftProfile(w, { model_id: 'reason-model', allowed_model_ids: [reasoning], effort: 'high', routing_policy: { routes: ['DOMESTIC_HOSTED'] } });
    expect(ok.status).toBe(200);
  });
});

describe('the evaluation of a route and its signature (ST-LLM-004, LLM-13, LLM-17)', () => {
  it('runs a dataset on a route, judges its metrics against the thresholds, and keeps the failures; a new run replaces the one before it', async () => {
    const w = await world();
    const profile = await draftProfile(w);
    const id = profile.json.resource_id as string;
    app.runner.set('INTERNATIONAL', { injectionResistance: 0.9 });
    const run = await startRun(id, w.dataset, 'INTERNATIONAL');
    expect([run.status, run.json.status, run.json.passed, run.json.failures]).toEqual([200, 'PENDING_SIGNATURE', false, ['injection_resistance']]);
    const view = (await app.call('GET', `/resources/ai_eval_run/${run.json.resource_id as string}`, { member: EXPERT })).json;
    expect(view).toMatchObject({ route_class: 'INTERNATIONAL', passed: false, review_status: 'PENDING_SIGNATURE', cost_vnd: '2000', metrics: { injection_resistance: 0.9 }, thresholds: { injection_resistance_min: 1 }, started_by: memberId(PROMPT_AUTHOR) });
    expect(app.runner.calls.at(-1)).toMatchObject({ route: 'INTERNATIONAL', providerModelId: 'intl-model', cases: 2 });
    expect((await app.rows<{ status: string }>('select status from machvon.model_profile_version where id = $1', [id]))[0]?.status).toBe('EVAL_PENDING');
    // Run again: the first is set aside, and there is one current run for the route.
    app.runner.set('INTERNATIONAL', {});
    const again = await startRun(id, w.dataset, 'INTERNATIONAL');
    expect(again.json.passed).toBe(true);
    const states = await app.rows<{ review_status: string }>('select review_status from machvon.ai_eval_run where route_class = $1 order by started_at, id', ['INTERNATIONAL']);
    expect(states.map((row) => row.review_status).sort()).toEqual(['PENDING_SIGNATURE', 'SUPERSEDED']);
    expect(((await app.call('GET', `/resources/ai_eval_run?profile_version_id=${id}`, { member: EXPERT })).json.items as unknown[]).length).toBe(2);
    expect((await app.call('GET', '/resources/ai_eval_run?profile_version_id=x', { member: EXPERT })).status).toBe(422);
    expect((await events('llm.eval_run.started.v1')).length).toBe(2);
  });

  it('does not start where the run cannot be made: a route the profile does not have, a dataset of another task or without an injection case, a route no active provider reaches', async () => {
    const w = await world();
    const profile = await draftProfile(w, { routing_policy: { routes: ['DOMESTIC_HOSTED'] }, allowed_model_ids: [w.domestic] });
    const id = profile.json.resource_id as string;
    expect((await startRun(id, w.dataset, 'INTERNATIONAL')).json).toMatchObject({ code: 'AI_ROUTE_NOT_ALLOWED', detail: 'INTERNATIONAL' });
    const other = await dataset({ dataset_code: 'EV-OTHER', task_type: 'OTHER' });
    expect((await startRun(id, other.json.resource_id as string, 'DOMESTIC_HOSTED')).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'dataset_version_id' });
    const bare = await dataset({ dataset_code: 'EV-BARE', cases: [kase('c1')] });
    expect((await startRun(id, bare.json.resource_id as string, 'DOMESTIC_HOSTED')).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'dataset_version_id' });
    expect((await startRun(id, randomUUID(), 'DOMESTIC_HOSTED')).json.code).toBe('VALIDATION_FAILED');
    expect((await startRun(randomUUID(), w.dataset, 'DOMESTIC_HOSTED')).status).toBe(404);
    await app.rows("update machvon.ai_provider set status = 'SUSPENDED' where provider_code = 'VN-HOST'");
    expect((await startRun(id, w.dataset, 'DOMESTIC_HOSTED')).json.code).toBe('AI_ROUTE_NOT_ALLOWED');
    await app.rows("update machvon.ai_provider set status = 'ACTIVE' where provider_code = 'VN-HOST'");
    expect((await startRun(id, w.dataset, 'DOMESTIC_HOSTED', EXPERT)).status).toBe(403);
    expect(app.runner.calls.length).toBe(0);
  });

  it('keeps a run whose runner failed as one that did not finish, which cannot be signed, and logs nothing of the message of the failure', async () => {
    const w = await world();
    const profile = await draftProfile(w, { routing_policy: { routes: ['DOMESTIC_HOSTED'] }, allowed_model_ids: [w.domestic] });
    const lines: string[] = [];
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as never);
    let run: Reply;
    try {
      app.runner.failNext('upstream refused sk-live-1234567890abcdefghijklmnopqrstuv');
      run = await startRun(profile.json.resource_id as string, w.dataset, 'DOMESTIC_HOSTED');
    } finally {
      write.mockRestore();
    }
    expect([run.status, run.json.status, run.json.passed]).toEqual([200, 'FAILED', null]);
    expect(lines.join('\n')).toContain('the runner failed with Error');
    expect(lines.join('\n')).not.toMatch(/sk-live|1234567890abcdef/);
    const signed = await sign(run.json.resource_id as string, etag(run), 'PASS');
    expect([signed.status, signed.json.code]).toEqual([422, 'EVAL_NOT_FINISHED']);
  });

  it('AC-ST-LLM-004-1: UAT-AC459 lets an expert sign a pass only over metrics that passed, refuses the person who started the run, and refuses a stale version and a second signature', async () => {
    const w = await world();
    const profile = await draftProfile(w);
    const id = profile.json.resource_id as string;
    app.runner.set('INTERNATIONAL', { injectionResistance: 0.9 });
    const failing = await startRun(id, w.dataset, 'INTERNATIONAL');
    const refused = await sign(failing.json.resource_id as string, etag(failing), 'PASS');
    expect([refused.status, refused.json.code]).toEqual([422, 'EVAL_NOT_PASSED']);
    expect((await sign(failing.json.resource_id as string, '"9"', 'FAIL')).json.code).toBe('VERSION_CONFLICT');
    const failed = await sign(failing.json.resource_id as string, etag(failing), 'FAIL');
    expect([failed.status, failed.json.status]).toEqual([200, 'SIGNED_FAIL']);
    expect((await sign(failing.json.resource_id as string, etag(failed), 'FAIL')).json.code).toBe('STAGE_TRANSITION_DENIED');
    expect((await app.call('GET', `/resources/ai_eval_run/${failing.json.resource_id as string}`, { member: EXPERT })).json).toMatchObject({ signature_decision: 'FAIL', signature_comment: 'Reviewed the cases and the metrics', signed_by: memberId(EXPERT) });
    // The person who started a run cannot sign it, whatever the rights they hold.
    const own = await startRun(id, w.dataset, 'DOMESTIC_HOSTED', EVAL_BOTH);
    const self = await sign(own.json.resource_id as string, etag(own), 'PASS', EVAL_BOTH);
    expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
    expect((await sign(own.json.resource_id as string, etag(own), 'PASS', EXPERT, 'short')).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'comment' });
    expect((await sign(own.json.resource_id as string, etag(own), 'PASS', PROMPT_AUTHOR)).status).toBe(403);
    await expect(app.rows('update machvon.ai_eval_run set signed_by = started_by where id = $1', [own.json.resource_id])).rejects.toThrow(/ai_eval_run_sod_chk/);
    expect((await audits('llm.eval_run_signed')).length).toBe(1);
  });
});

describe('the release of a profile (ST-LLM-004, LLM-17, LLM BR-LLM-08)', () => {
  it('AC-ST-LLM-004-1: UAT-AC459 refuses to publish without an evaluation of the international route, then after a failing one, and publishes the revision that drops that route with the profile in force as its rollback', async () => {
    const w = await world();
    // r1 is in force: one route, evaluated and signed.
    const first = await draftProfile(w, { routing_policy: { routes: ['DOMESTIC_HOSTED'] }, allowed_model_ids: [w.domestic] });
    const firstId = first.json.resource_id as string;
    await evaluated(firstId, w.dataset, 'DOMESTIC_HOSTED', 'PASS');
    const inForce = await publish(firstId, await profileVersion(firstId));
    expect([inForce.status, inForce.json.status]).toEqual([200, 'PUBLISHED']);

    // r3 asks for both routes.
    const third = await draftProfile(w);
    const thirdId = third.json.resource_id as string;
    expect((await publish(thirdId, await profileVersion(thirdId))).json).toMatchObject({ status: 422, code: 'EVAL_REQUIRED' }.code === undefined ? {} : { code: 'EVAL_REQUIRED' });
    await evaluated(thirdId, w.dataset, 'DOMESTIC_HOSTED', 'PASS');
    const missing = await publish(thirdId, await profileVersion(thirdId));
    expect([missing.status, missing.json.code, missing.json.detail]).toEqual([422, 'EVAL_MISSING_FOR_ROUTE', 'INTERNATIONAL']);
    // The international run is made and not signed yet: the route still has no signed evaluation.
    app.runner.set('INTERNATIONAL', { injectionResistance: 0.9 });
    const intl = await startRun(thirdId, w.dataset, 'INTERNATIONAL');
    expect((await publish(thirdId, await profileVersion(thirdId))).json.code).toBe('EVAL_MISSING_FOR_ROUTE');
    expect((await sign(intl.json.resource_id as string, etag(intl), 'FAIL')).status).toBe(200);
    const failed = await publish(thirdId, await profileVersion(thirdId));
    expect([failed.status, failed.json.code, failed.json.detail]).toEqual([422, 'EVAL_NOT_PASSED', 'INTERNATIONAL']);
    expect((await app.rows<{ status: string }>('select status from machvon.model_profile_version where id = $1', [firstId]))[0]?.status).toBe('PUBLISHED');

    // r4 drops that route and has its own signed domestic evaluation.
    const fourth = await draftProfile(w, { routing_policy: { routes: ['DOMESTIC_HOSTED'] }, allowed_model_ids: [w.domestic] });
    const fourthId = fourth.json.resource_id as string;
    const domestic = await evaluated(fourthId, w.dataset, 'DOMESTIC_HOSTED', 'PASS');
    const done = await publish(fourthId, await profileVersion(fourthId), PUBLISHER, { evidence_ids: [domestic.json.resource_id] });
    expect([done.status, done.json.status, done.json.evidence_run_ids]).toEqual([200, 'PUBLISHED', [domestic.json.resource_id]]);
    const stored = await app.rows<{ id: string; status: string; rollback_profile_id: string | null; approved_by: string | null }>('select id, status, rollback_profile_id, approved_by from machvon.model_profile_version order by revision');
    expect(stored.map((row) => [row.status, row.rollback_profile_id])).toEqual([
      ['SUPERSEDED', null],
      ['EVAL_PENDING', null],
      ['PUBLISHED', firstId],
    ]);
    expect(stored[2]?.approved_by).toBe(memberId(PUBLISHER));
    // One profile of the task is in force, in the database too.
    await expect(app.rows("update machvon.model_profile_version set status = 'PUBLISHED' where id = $1", [thirdId])).rejects.toThrow(/model_profile_version_published_uq/);
    // The audit and the event name the runs the release relied on.
    const trail = (await audits('llm.profile_published')).at(-1)!.safe_diff;
    expect(trail).toMatchObject({ revision: 3, eval_run_ids: [domestic.json.resource_id], superseded_profile_id: firstId, rollback_profile_id: firstId });
    expect((await events('llm.profile.published.v1')).at(-1)?.payload).toMatchObject({ profile_version_id: fourthId, eval_run_ids: [domestic.json.resource_id] });
  });

  it('AC-ST-LLM-004-1: UAT-AC459 evaluates the primary model of a route, and a pass of another model of the profile is not evidence for it', async () => {
    const w = await world();
    const dom = (await app.rows<{ provider_id: string }>('select provider_id from machvon.ai_model where id = $1', [w.domestic]))[0]?.provider_id as string;
    const other = await model(dom, 'dom-other');
    // The primary model is listed second: it is still the one that is evaluated.
    const profile = await draftProfile(w, { routing_policy: { routes: ['DOMESTIC_HOSTED'] }, allowed_model_ids: [other, w.domestic] });
    const id = profile.json.resource_id as string;
    const run = await evaluated(id, w.dataset, 'DOMESTIC_HOSTED', 'PASS');
    expect((await app.rows<{ model_ref_id: string }>('select model_ref_id from machvon.ai_eval_run where id = $1', [run.json.resource_id]))[0]?.model_ref_id).toBe(w.domestic);
    // A run that was made for the other model does not release the route.
    await app.rows('update machvon.ai_eval_run set model_ref_id = $2 where id = $1', [run.json.resource_id, other]);
    const refused = await publish(id, await profileVersion(id));
    expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'EVAL_REQUIRED', 'eval_run']);
    await app.rows('update machvon.ai_eval_run set model_ref_id = $2 where id = $1', [run.json.resource_id, w.domestic]);
    expect((await publish(id, await profileVersion(id))).status).toBe(200);
  });

  it('AC-ST-LLM-004-1: UAT-AC459 evaluates a route only when the policy in force of the tenant takes the class of the profile over it: none or one without the international route keeps it off', async () => {
    for (const policy of ['none', 'compliant'] as const) {
      const w = await world(policy);
      const id = (await draftProfile(w)).json.resource_id as string;
      const refused = await startRun(id, w.dataset, 'INTERNATIONAL');
      expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'AI_ROUTE_NOT_ALLOWED', 'INTERNATIONAL']);
      expect((await app.rows('select 1 from machvon.ai_eval_run')).length).toBe(0);
      expect((await startRun(id, w.dataset, 'DOMESTIC_HOSTED')).status).toBe(200);
      await app.reset();
      app.runner.clear();
    }
  });

  it('AC-ST-LLM-004-1: UAT-AC459 does not release a route when the policy changed since it was evaluated, and refuses a model that takes less than the profile does', async () => {
    const w = await world();
    const id = (await draftProfile(w)).json.resource_id as string;
    await evaluated(id, w.dataset, 'DOMESTIC_HOSTED', 'PASS');
    await evaluated(id, w.dataset, 'INTERNATIONAL', 'PASS');
    await publishPolicy(false);
    const withdrawn = await publish(id, await profileVersion(id));
    expect([withdrawn.status, withdrawn.json.code, withdrawn.json.detail]).toEqual([422, 'AI_ROUTE_NOT_ALLOWED', 'INTERNATIONAL']);
    // The models take public data only here: a profile that takes internal data is refused for them.
    const low = await draftProfile(w, { routing_policy: { routes: ['DOMESTIC_HOSTED'] }, allowed_model_ids: [w.domestic], max_classification: 'INTERNAL' });
    expect([low.status, low.json.code, low.json.detail]).toEqual([422, 'CLASSIFICATION_ABOVE_PROVIDER', w.domestic]);
  });

  it('AC-ST-LLM-004-1: UAT-AC459 takes the first listed of two registry entries that share the identifier of the primary model, whatever order the database returns them in', async () => {
    const w = await world();
    const second = await model(await provider('VN-HOST-2', 'DOMESTIC_HOSTED'), 'dom-model');
    for (const order of [[second, w.domestic], [w.domestic, second]]) {
      const id = (await draftProfile(w, { routing_policy: { routes: ['DOMESTIC_HOSTED'] }, allowed_model_ids: order })).json.resource_id as string;
      const run = await startRun(id, w.dataset, 'DOMESTIC_HOSTED');
      expect((await app.rows<{ model_ref_id: string }>('select model_ref_id from machvon.ai_eval_run where id = $1', [run.json.resource_id]))[0]?.model_ref_id).toBe(order[0]);
    }
  });

  it('AC-ST-LLM-004-3: UAT-NFR-AI-04 asks for an evaluation when there is none, and publishes after one, with the id of the run in the audit', async () => {
    const w = await world();
    const profile = await draftProfile(w, { routing_policy: { routes: ['DOMESTIC_HOSTED'] }, allowed_model_ids: [w.domestic] });
    const id = profile.json.resource_id as string;
    const none = await publish(id, await profileVersion(id));
    expect([none.status, none.json.code]).toEqual([422, 'EVAL_REQUIRED']);
    expect((await app.rows<{ status: string }>('select status from machvon.model_profile_version where id = $1', [id]))[0]?.status).toBe('DRAFT');
    const run = await evaluated(id, w.dataset, 'DOMESTIC_HOSTED', 'PASS');
    const done = await publish(id, await profileVersion(id));
    expect(done.status).toBe(200);
    expect((await audits('llm.profile_published'))[0]?.safe_diff.eval_run_ids).toEqual([run.json.resource_id]);
  });

  it('refuses the drafter as the publisher, a model that is not approved, a stale version, evidence that is not of this profile and a decision that is not one of the step', async () => {
    const w = await world();
    const profile = await draftProfile(w, { routing_policy: { routes: ['DOMESTIC_HOSTED'] }, allowed_model_ids: [w.domestic] });
    const id = profile.json.resource_id as string;
    const run = await evaluated(id, w.dataset, 'DOMESTIC_HOSTED', 'PASS');
    // The drafter holds the right to publish here (the rule keeps them apart, not the guard).
    await app.rows("update machvon.model_profile_version set created_by = $2 where id = $1", [id, memberId(PUBLISHER)]);
    const own = await publish(id, await profileVersion(id));
    expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
    await app.rows("update machvon.model_profile_version set created_by = $2 where id = $1", [id, memberId(PROMPT_AUTHOR)]);
    expect((await publish(id, '"99"')).json.code).toBe('VERSION_CONFLICT');
    expect((await publish(id, await profileVersion(id), PUBLISHER, { evidence_ids: [randomUUID()] })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'evidence_ids' });
    expect((await publish(id, await profileVersion(id), PUBLISHER, { evidence_ids: ['x'] })).status).toBeGreaterThanOrEqual(400);
    expect((await publish(id, await profileVersion(id), PUBLISHER, { decision: 'reject' })).json).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision' });
    expect((await publish(id, await profileVersion(id), PUBLISHER, { reason: '' })).status).toBeGreaterThanOrEqual(400);
    await app.rows("update machvon.ai_model set status = 'SUSPENDED' where id = $1", [w.domestic]);
    expect((await publish(id, await profileVersion(id))).json).toMatchObject({ code: 'MODEL_NOT_APPROVED', detail: w.domestic });
    await app.rows("update machvon.ai_model set status = 'APPROVED' where id = $1", [w.domestic]);
    expect((await publish(id, await profileVersion(id), EXPERT)).status).toBe(403);
    const done = await publish(id, await profileVersion(id), PUBLISHER, { evidence_ids: [run.json.resource_id] });
    expect(done.status).toBe(200);
    expect((await publish(id, await profileVersion(id))).json.code).toBe('STAGE_TRANSITION_DENIED');
  });

  it('sends a profile back to its drafter with a reason, leaving its evaluations, and an effort the model does not take is refused at the release too', async () => {
    const w = await world();
    const profile = await draftProfile(w, { routing_policy: { routes: ['DOMESTIC_HOSTED'] }, allowed_model_ids: [w.domestic] });
    const id = profile.json.resource_id as string;
    const run = await evaluated(id, w.dataset, 'DOMESTIC_HOSTED', 'PASS');
    const back = await publish(id, await profileVersion(id), PUBLISHER, { decision: 'return', reason: 'The thresholds must be tighter for this task' });
    expect([back.status, back.json.status]).toEqual([200, 'DRAFT']);
    expect((await app.rows('select 1 from machvon.ai_eval_run where id = $1', [run.json.resource_id])).length).toBe(1);
    expect((await audits('llm.profile_returned'))[0]?.safe_diff).toMatchObject({ reason: 'The thresholds must be tighter for this task' });
    // The effort that was drafted while the model took it is refused when the model no longer does.
    const dom = await provider('REASON-1', 'DOMESTIC_HOSTED');
    const reasoning = await model(dom, 'reason-model', { reasoning: true });
    const second = await draftProfile(w, { model_id: 'reason-model', allowed_model_ids: [reasoning], effort: 'high', routing_policy: { routes: ['DOMESTIC_HOSTED'] } });
    const secondId = second.json.resource_id as string;
    await evaluated(secondId, w.dataset, 'DOMESTIC_HOSTED', 'PASS');
    await app.rows(`update machvon.ai_model set capabilities = '{}'::jsonb where id = $1`, [reasoning]);
    expect((await publish(secondId, await profileVersion(secondId))).json).toMatchObject({ code: 'UNSUPPORTED_PARAMETER', detail: 'effort' });
  });
});

describe('rights and tenants of the evaluation gate (ST-LLM-004)', () => {
  it('is the tenant\'s: the holder over one unit, the person with no grant and one with another right are refused, and one tenant sees nothing of another', async () => {
    const w = await world();
    const profile = await draftProfile(w);
    for (const member of [SCOPED, NOBODY, KEY_READER]) {
      expect((await draftPrompt({}, member)).status).toBe(403);
      expect((await dataset({}, member)).status).toBe(403);
      expect((await draftProfile(w, {}, member)).status).toBe(403);
      for (const url of ['/ai-prompts', '/ai-eval-datasets', '/resources/model_profile_version', '/resources/ai_eval_run']) expect((await app.call('GET', url, { member })).status).toBe(403);
    }
    expect((await app.call('POST', `/ai-prompts/${w.prompt}/approval`, { member: PROMPT_AUTHOR, ifMatch: '"1"', body: {} })).status).toBe(403);
    expect((await app.call('POST', `/model-profiles/${profile.json.resource_id as string}/publish`, { member: PROMPT_AUTHOR, ifMatch: '"1"', body: { decision: 'approve', reason: 'x', evidence_ids: [] } })).status).toBe(403);
    for (const url of ['/ai-prompts', '/ai-eval-datasets', '/resources/model_profile_version', '/resources/ai_eval_run']) {
      const other = await app.call('GET', url, { member: AI_ADMIN, tenantId: TENANT_B });
      expect(other.status === 403 || (other.json.items as unknown[]).length === 0).toBe(true);
    }
    expect((await app.call('GET', `/resources/model_profile_version/${profile.json.resource_id as string}`, { member: AI_ADMIN, tenantId: TENANT_B })).status).toBeGreaterThanOrEqual(403);
  });

  it('makes a draft once under one idempotency key', async () => {
    const key = `prompt-${randomUUID()}`;
    const [a, b] = [await app.call('POST', '/ai-prompts', { member: PROMPT_AUTHOR, key, body: promptBody() }), await app.call('POST', '/ai-prompts', { member: PROMPT_AUTHOR, key, body: promptBody() })];
    expect([a.status, b.status, a.json.resource_id === b.json.resource_id]).toEqual([200, 200, true]);
    expect((await app.rows('select 1 from machvon.ai_prompt_version')).length).toBe(1);
    expect((await audits('llm.prompt_drafted')).length).toBe(1);
  });
});
