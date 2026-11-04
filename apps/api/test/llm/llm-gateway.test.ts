import { createHash, randomUUID } from 'node:crypto';
import { GatewayFailure, sha256Of } from '@machvon/kernel';
import { AiDecisionStore } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { AI_ADMIN, AUDITOR, DECIDER, EMERGENCY, EMERGENCY_TWO, FINOPS, INVOKER, LlmApp, NOBODY, PROMPT_APPROVER, PROMPT_AUTHOR, READER, SCOPED, SECURITY, TENANT_A, TENANT_B, memberId } from './llm-app';
import type { Reply } from './llm-app';
import { contextFor } from '../../../../packages/db/test/support/authz-fixtures';

const app = new LlmApp();
jest.setTimeout(240_000);

beforeAll(() => app.start());
afterAll(() => app.stop());

let since = new Date();
beforeEach(async () => {
  await app.reset();
  await app.rows('delete from machvon.document_version');
  await app.rows('delete from machvon.document');
  app.gateway.clear();
  app.metrics.length = 0;
  since = new Date();
});

const etag = (reply: Reply): string => `"${String(reply.json.resource_version)}"`;
const audits = (action: string) => app.rows<{ safe_diff: Record<string, unknown> }>('select safe_diff from machvon.audit_event where action = $1 and occurred_at >= $2 order by occurred_at', [action, since]);
const events = (type: string) => app.rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where type = $1 and created_at >= $2 order by created_at', [type, since]);

const SCHEMA = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
const CITED = { type: 'object', properties: { summary: { type: 'string' }, citations: { type: 'array', items: { type: 'object' } } }, required: ['summary', 'citations'] };
const PLAIN = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };

type Class = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'PERSONAL' | 'IMPORTANT_CORE';
type Route = 'DOMESTIC_HOSTED' | 'SELF_HOSTED' | 'INTERNATIONAL';

const MATRIX = { PUBLIC: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], INTERNAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], CONFIDENTIAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], PERSONAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], IMPORTANT_CORE: ['SELF_HOSTED'] };

async function publishPolicy(international: boolean): Promise<string> {
  const matrix = international ? { ...MATRIX, PUBLIC: [...MATRIX.PUBLIC, 'INTERNATIONAL'] } : MATRIX;
  const drafted = await app.call('POST', '/ai-classification-policies', {
    member: AI_ADMIN,
    body: { matrix, international_enabled: international, ...(international ? { d07_approval_ref: 'D07-2026-01' } : {}), legal_basis: 'Luat 2026', effective_from: '2026-01-01T00:00:00.000Z' },
  });
  expect(drafted.status).toBe(200);
  const published = await app.call('POST', `/ai-classification-policies/${drafted.json.resource_id as string}/publish`, { member: SECURITY, ifMatch: etag(drafted), body: {} });
  expect(published.status).toBe(200);
  return drafted.json.resource_id as string;
}

async function provider(code: string, route: Route, max: Class): Promise<string> {
  // More than public data needs the data agreement, a document of the tenant.
  let agreement: string | undefined;
  if (max !== 'PUBLIC') {
    agreement = randomUUID();
    await app.rows(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'HD', 'DPA', 'INTERNAL', $3, $3)`, [TENANT_A, agreement, memberId(AI_ADMIN)]);
  }
  const made = await app.call('POST', '/ai-providers', {
    member: AI_ADMIN,
    body: { provider_code: code, name: code, region_country: route === 'INTERNATIONAL' ? 'US' : 'VN', route_class: route, max_classification: max, ...(agreement === undefined ? {} : { data_agreement_document_id: agreement }) },
  });
  expect(made.status).toBe(200);
  const done = await app.call('POST', `/ai-providers/${made.json.resource_id as string}/activation`, { member: SECURITY, ifMatch: etag(made), body: route === 'INTERNATIONAL' ? { d07_approval_ref: 'D07-2026-01' } : {} });
  expect(done.status).toBe(200);
  return made.json.resource_id as string;
}

async function model(providerId: string, code: string, max: Class): Promise<string> {
  const made = await app.call('POST', '/ai-models', { member: AI_ADMIN, body: { provider_id: providerId, model_id: code, capabilities: {}, context_window: 8000, max_output: 1000, max_classification: max } });
  expect(made.status).toBe(200);
  expect((await app.call('POST', `/ai-models/${made.json.resource_id as string}/approval`, { member: SECURITY, ifMatch: etag(made), body: {} })).status).toBe(200);
  const price = await app.call('POST', '/ai-pricing-versions', {
    member: FINOPS,
    body: {
      provider: 'ProviderCo',
      model_id: code,
      model_ref_id: made.json.resource_id,
      currency: 'USD',
      effective_from: '2026-01-01T00:00:00.000Z',
      input_per_million: '2.00',
      cached_per_million: '0.50',
      output_per_million: '8.00',
      cached_semantics: 'INCLUDED_IN_INPUT',
      reasoning_in_output: true,
      source_url: 'https://provider.example/pricing',
      fx_rate_to_vnd: '25400',
      fx_source: 'Vietcombank 2026-10-22',
    },
  });
  expect(price.status).toBe(200);
  return made.json.resource_id as string;
}

interface World {
  domestic: string;
  selfHosted: string | undefined;
  international: string | undefined;
  profile: string;
  prompt: string;
}

/** A tenant with a policy in force, the models it has, and a profile for SUMMARY that is PUBLISHED: its primary model is the domestic one, the others are its fallbacks. */
async function world(options: { policy?: 'international' | 'compliant' | 'none'; self?: boolean; international?: boolean; schema?: unknown; routes?: Route[]; max?: Class } = {}): Promise<World> {
  const policy = options.policy ?? 'international';
  if (policy !== 'none') await publishPolicy(policy === 'international');
  const domestic = await model(await provider('VN-HOST', 'DOMESTIC_HOSTED', 'PERSONAL'), 'dom-model', 'PERSONAL');
  const selfHosted = options.self === false ? undefined : await model(await provider('SELF-1', 'SELF_HOSTED', 'IMPORTANT_CORE'), 'self-model', 'IMPORTANT_CORE');
  const international = options.international === false ? undefined : await model(await provider('INTL-1', 'INTERNATIONAL', 'PUBLIC'), 'intl-model', 'PUBLIC');
  const drafted = await app.call('POST', '/ai-prompts', {
    member: PROMPT_AUTHOR,
    body: { task_type: 'SUMMARY', name: 'summary', template_object_key: 'tenants/t/prompts/summary-r1.txt', template_sha256: sha256Of('summary'), input_schema: SCHEMA, output_schema: SCHEMA },
  });
  expect(drafted.status).toBe(200);
  expect((await app.call('POST', `/ai-prompts/${drafted.json.resource_id as string}/approval`, { member: PROMPT_APPROVER, ifMatch: etag(drafted), body: {} })).status).toBe(200);
  const prompt = drafted.json.resource_id as string;
  const allowed = [domestic, selfHosted, international].filter((entry): entry is string => entry !== undefined);
  const routes = options.routes ?? (['DOMESTIC_HOSTED', ...(selfHosted === undefined ? [] : ['SELF_HOSTED']), ...(international === undefined ? [] : ['INTERNATIONAL'])] as Route[]);
  const profile = randomUUID();
  await app.rows(
    `insert into machvon.model_profile_version (tenant_id, id, task_type, revision, model_id, output_cap, routing_policy, status, allowed_model_ids, max_input_tokens, timeout_ms, concurrency_limit, output_schema, tool_allowlist,
       max_classification, prompt_version_id, retention_days, created_by)
     values ($1, $2, 'SUMMARY', 1, 'dom-model', 1000, $3::jsonb, 'PUBLISHED', $4::jsonb, 8000, 30000, 4, $5::jsonb, '["search_documents","read_document"]'::jsonb, $6, $7, 90, $8)`,
    [TENANT_A, profile, JSON.stringify({ routes, thresholds: {} }), JSON.stringify(allowed), JSON.stringify(options.schema ?? CITED), options.max ?? 'IMPORTANT_CORE', prompt, memberId(PROMPT_AUTHOR)],
  );
  return { domestic, selfHosted, international, profile, prompt };
}

async function doc(classification: Class, scan = 'CLEAN'): Promise<string> {
  const document = randomUUID();
  const version = randomUUID();
  await app.rows(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Source', 'INTERNAL', $3, $3)`, [TENANT_A, document, memberId(AI_ADMIN)]);
  await app.rows(
    `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
     values ($1, $2, $3, 1, $6, repeat('a', 64), 'application/pdf', 1, $4, $5, '{}'::jsonb, 'RENDERED_FINAL')`,
    [TENANT_A, version, document, classification, scan, `tenants/t/source-${version}.pdf`],
  );
  return version;
}

let keyCounter = 0;
const ask = (sources: string[], overrides: Record<string, unknown> = {}, member = INVOKER, key = `gateway-key-${(keyCounter += 1)}-${randomUUID()}`): Promise<Reply> =>
  app.call('POST', '/ai/requests', {
    member,
    key,
    body: { task_type: 'SUMMARY', subject_module: 'BID', source_refs: sources.map((id) => ({ document_version_id: id })), input_ref: 'tenants/t/inputs/summary-1', input_sha256: sha256Of('the input'), ...overrides },
  });

const request = async (id: string) => (await app.rows<Record<string, unknown>>('select * from machvon.ai_request where id = $1', [id]))[0] as Record<string, unknown>;
const attempts = (id: string) =>
  app.rows<{ attempt_no: number; attempt_kind: string; route_class: string; actual_model: string; outcome: string; cost_vnd: string }>(
    'select attempt_no, attempt_kind, route_class, actual_model, outcome, cost_vnd::text as cost_vnd from machvon.llm_attempt where ai_request_id = $1 order by attempt_no',
    [id],
  );

describe('the classification and the route of a request (ST-LLM-005, LLM F1)', () => {
  it('AC-ST-LLM-005-1: UAT-AC458 gives a request the highest class of its sources and sends it only over the routes of that class: public may use any route that is on, internal and personal only the domestic and the self-hosted', async () => {
    await world();
    // Public: the domestic model is the primary and answers; the others are still allowed fallbacks, the international one included.
    const publicSource = await doc('PUBLIC');
    app.gateway.script('dom-model', [{ fail: 'PROVIDER_ERROR' }]);
    app.gateway.script('self-model', [{ fail: 'PROVIDER_ERROR' }]);
    const open = await ask([publicSource]);
    expect([open.status, open.json.status, open.json.data_classification]).toEqual([202, 'COMPLETED', 'PUBLIC']);
    expect((await attempts(open.json.resource_id as string)).map((attempt) => [attempt.attempt_kind, attempt.route_class, attempt.outcome])).toEqual([
      ['PRIMARY', 'DOMESTIC_HOSTED', 'PROVIDER_ERROR'],
      ['FALLBACK', 'SELF_HOSTED', 'PROVIDER_ERROR'],
      ['FALLBACK', 'INTERNATIONAL', 'SUCCESS'],
    ]);

    // Internal: the international model is not tried, even when the two others fail.
    app.gateway.clear();
    app.gateway.script('dom-model', [{ fail: 'PROVIDER_ERROR' }]);
    app.gateway.script('self-model', [{ fail: 'PROVIDER_ERROR' }]);
    const internal = await ask([await doc('INTERNAL')]);
    expect([internal.json.status, internal.json.data_classification, internal.json.reject_code]).toEqual(['FAILED', 'INTERNAL', 'AI_ROUTE_EXHAUSTED']);
    expect(app.gateway.calls.map((call) => call.route)).toEqual(['DOMESTIC_HOSTED', 'SELF_HOSTED']);

    // Mixed public and personal: personal, on the domestic and self-hosted routes.
    app.gateway.clear();
    const mixed = await ask([await doc('PUBLIC'), await doc('PERSONAL')]);
    expect([mixed.json.status, mixed.json.data_classification, mixed.json.route_class]).toEqual(['COMPLETED', 'PERSONAL', 'DOMESTIC_HOSTED']);
    expect((await request(mixed.json.resource_id as string)).classification_basis).toHaveLength(2);
    expect(app.metrics.filter((metric) => metric.name === 'llm_international_non_public_total')).toEqual([]);
  });

  it('AC-ST-LLM-005-1: UAT-AC458 refuses important data when no self-hosted model is allowed (422 AI_ROUTE_NOT_ALLOWED, kept as a rejected request) and a class said by the caller (400 FIELD_NOT_ALLOWED)', async () => {
    await world({ self: false });
    const source = await doc('IMPORTANT_CORE');
    const refused = await ask([source]);
    expect([refused.status, refused.json.code]).toEqual([422, 'AI_ROUTE_NOT_ALLOWED']);
    expect(app.gateway.calls).toHaveLength(0);
    const rows = await app.rows<{ status: string; reject_code: string; data_classification: string; route_class: string | null }>('select status, reject_code, data_classification, route_class from machvon.ai_request');
    expect(rows).toEqual([{ status: 'REJECTED_POLICY', reject_code: 'AI_ROUTE_NOT_ALLOWED', data_classification: 'IMPORTANT_CORE', route_class: null }]);
    expect((await audits('llm.request_rejected'))[0]?.safe_diff).toMatchObject({ reject_code: 'AI_ROUTE_NOT_ALLOWED', data_classification: 'IMPORTANT_CORE', detail: 'route' });
    expect((await events('llm.request.rejected.v1')).length).toBe(1);

    const said = await ask([await doc('PUBLIC')], { data_classification: 'PUBLIC' });
    expect([said.status, said.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
    expect((await app.rows('select 1 from machvon.ai_request')).length).toBe(1);
  });

  it('keeps the international route off when no policy turns it on, and refuses a class the profile does not take or a model that takes less', async () => {
    await world({ policy: 'compliant' });
    app.gateway.script('dom-model', [{ fail: 'PROVIDER_ERROR' }]);
    app.gateway.script('self-model', [{ fail: 'PROVIDER_ERROR' }]);
    const off = await ask([await doc('PUBLIC')]);
    expect([off.json.status, off.json.reject_code]).toEqual(['FAILED', 'AI_ROUTE_EXHAUSTED']);
    expect(app.gateway.calls.map((call) => call.route)).toEqual(['DOMESTIC_HOSTED', 'SELF_HOSTED']);

    // No policy at all: the baseline, which keeps the international route off too, and the decision names no policy.
    await app.reset();
    app.gateway.clear();
    await world({ policy: 'none' });
    app.gateway.script('dom-model', [{ fail: 'PROVIDER_ERROR' }]);
    app.gateway.script('self-model', [{ fail: 'PROVIDER_ERROR' }]);
    const baseline = await ask([await doc('PUBLIC')]);
    expect(baseline.json.status).toBe('FAILED');
    expect(app.gateway.calls.map((call) => call.route)).toEqual(['DOMESTIC_HOSTED', 'SELF_HOSTED']);
    const route = await app.call('GET', `/ai/requests/${baseline.json.resource_id as string}/route`, { member: AUDITOR });
    expect(route.json.policy_version_id).toBe('00000000-0000-0000-0000-000000000000');

    // A class above what the profile takes.
    await app.reset();
    app.gateway.clear();
    await world({ max: 'INTERNAL' });
    const above = await ask([await doc('CONFIDENTIAL')]);
    expect([above.status, above.json.code]).toEqual([422, 'AI_ROUTE_NOT_ALLOWED']);
    expect((await audits('llm.request_rejected'))[0]?.safe_diff.detail).toBe('max_classification');

    // A model that takes less than the data is not asked: only the self-hosted one (which takes it) answers.
    await app.reset();
    app.gateway.clear();
    await world({ policy: 'compliant', international: false });
    await app.rows("update machvon.ai_model set max_classification = 'INTERNAL' where model_id = 'dom-model'");
    const less = await ask([await doc('CONFIDENTIAL')]);
    expect([less.json.status, less.json.route_class]).toEqual(['COMPLETED', 'SELF_HOSTED']);
    expect(app.gateway.calls.map((call) => call.providerModelId)).toEqual(['self-model']);
  });

  it('refuses a source that is not in the tenant or whose file is not clean, and a task with no profile in force, without recording anything', async () => {
    await world();
    const unscanned = await ask([await doc('PUBLIC', 'PENDING')]);
    expect([unscanned.status, unscanned.json.code, unscanned.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'source_refs']);
    expect((await ask([randomUUID()])).json.code).toBe('VALIDATION_FAILED');
    expect((await ask([])).json.code).toBe('VALIDATION_FAILED');
    expect((await ask([await doc('PUBLIC')], { task_type: 'NO-SUCH-TASK' })).json.code).toBe('AI_ROUTE_NOT_ALLOWED');
    expect((await app.rows('select 1 from machvon.ai_request')).length).toBe(0);
    expect(app.gateway.calls).toHaveLength(0);
  });
});

describe('the fallback of a request (ST-LLM-005)', () => {
  it('AC-ST-LLM-005-2: UAT-AC19 makes two attempts only for a confidential file whose domestic and self-hosted models fail, ends FAILED with AI_ROUTE_EXHAUSTED, calls no international model, and explains the class and the policy', async () => {
    const policyId = (await world().then(async () => app.rows<{ id: string }>("select id from machvon.ai_classification_policy_version where status = 'PUBLISHED'")))[0]?.id as string;
    app.gateway.script('dom-model', [{ fail: 'PROVIDER_ERROR' }]);
    app.gateway.script('self-model', [{ fail: 'REFUSAL' }]);
    const source = await doc('CONFIDENTIAL');
    const reply = await ask([source]);
    expect([reply.status, reply.json.status, reply.json.reject_code]).toEqual([202, 'FAILED', 'AI_ROUTE_EXHAUSTED']);
    expect(app.gateway.calls.map((call) => call.route)).toEqual(['DOMESTIC_HOSTED', 'SELF_HOSTED']);
    const id = reply.json.resource_id as string;
    expect((await attempts(id)).map((attempt) => [attempt.attempt_no, attempt.attempt_kind, attempt.route_class, attempt.outcome])).toEqual([
      [1, 'PRIMARY', 'DOMESTIC_HOSTED', 'PROVIDER_ERROR'],
      [2, 'FALLBACK', 'SELF_HOSTED', 'REFUSAL'],
    ]);
    const route = await app.call('GET', `/ai/requests/${id}/route`, { member: AUDITOR });
    expect(route.status).toBe(200);
    expect(route.json).toMatchObject({ ai_request_id: id, data_classification: 'CONFIDENTIAL', policy_version_id: policyId, status: 'FAILED', reject_code: 'AI_ROUTE_EXHAUSTED' });
    expect(route.json.classification_basis).toEqual([{ document_version_id: source, classification: 'CONFIDENTIAL' }]);
    expect((route.json.attempts as unknown[]).length).toBe(2);
    // Nothing was paid for, so the hold is released and nothing is settled.
    expect((await app.rows<{ status: string; released_amount: string }>('select status, released_amount::text from machvon.budget_reservation'))[0]).toMatchObject({ status: 'RELEASED' });
  });

  it('keeps the hold of a request whose model did not answer in time until the usage is known (PENDING_RECONCILE), and settles the answer of a fallback that did', async () => {
    await world();
    app.gateway.script('dom-model', [{ fail: 'TIMEOUT' }]);
    app.gateway.script('self-model', [{ fail: 'TIMEOUT' }]);
    app.gateway.script('intl-model', [{ fail: 'PROVIDER_ERROR' }]);
    const stuck = await ask([await doc('PUBLIC')]);
    expect([stuck.json.status, stuck.json.reject_code]).toEqual(['PENDING_RECONCILE', 'AI_ROUTE_EXHAUSTED']);
    expect((await app.rows<{ status: string }>('select status from machvon.budget_reservation'))[0]?.status).toBe('PENDING_RECONCILE');
    expect((await attempts(stuck.json.resource_id as string)).map((attempt) => attempt.outcome)).toEqual(['TIMEOUT', 'TIMEOUT', 'PROVIDER_ERROR']);

    app.gateway.clear();
    app.gateway.script('dom-model', [{ fail: 'TIMEOUT' }]);
    const recovered = await ask([await doc('INTERNAL')]);
    expect([recovered.json.status, recovered.json.route_class]).toEqual(['COMPLETED', 'SELF_HOSTED']);
    // The answer of the fallback is used and settled; what the call that timed out may have cost is not known, so the rest of the hold waits for the reconciliation.
    expect((await app.rows<{ status: string }>('select status from machvon.budget_reservation where request_id = $1', [recovered.json.resource_id]))[0]?.status).toBe('PENDING_RECONCILE');
    expect(Number((await request(recovered.json.resource_id as string)).cost_vnd)).toBeGreaterThan(0);
  });
});

describe('what is kept and what is not (ST-LLM-005)', () => {
  it('AC-ST-LLM-005-3: UAT-AC465 keeps only the hash of the input and of the answer: a national id and a phone number that a model repeats are in no table, no audit row, no event and no log', async () => {
    await world();
    const pii = 'CCCD 079203001234, điện thoại 0912 345 678';
    const output = JSON.stringify({ summary: pii, citations: [] });
    const source = await doc('PERSONAL');
    const spy = jest.spyOn(process.stderr, 'write');
    const out = jest.spyOn(process.stdout, 'write');
    app.gateway.script('dom-model', [
      (call) => ({ providerRequestId: 'pii-1', output: JSON.stringify({ summary: pii, citations: [{ document_version_id: call.sourceIds[0] }] }), usage: { inputTotal: 900, cachedInput: 0, outputTotal: 200 }, latencyMs: 80 }),
    ]);
    const reply = await ask([source], { input_ref: 'tenants/t/inputs/pii-source' });
    expect(reply.json.status).toBe('COMPLETED');
    const id = reply.json.resource_id as string;
    const answered = JSON.stringify({ summary: pii, citations: [{ document_version_id: source }] });
    expect((await request(id)).output_sha256).toBe(createHash('sha256').update(answered).digest('hex'));
    expect((await request(id)).input_sha256).toBe(sha256Of('the input'));
    const dump = JSON.stringify([
      await app.rows('select * from machvon.ai_request'),
      await app.rows('select * from machvon.llm_attempt'),
      await app.rows('select * from machvon.budget_reservation'),
      await app.rows('select safe_diff from machvon.audit_event'),
      await app.rows('select payload from machvon.outbox_event'),
      reply.json,
      spy.mock.calls,
      out.mock.calls,
    ]);
    spy.mockRestore();
    out.mockRestore();
    expect(dump).not.toMatch(/079203001234|0912 345 678|0912345678/);
    // An answer is never kept, whole or in part.
    expect(JSON.stringify(await app.rows('select column_name from information_schema.columns where table_name = $1', ['ai_request']))).not.toMatch(/"(output|answer|prompt|completion|reasoning|chain_of_thought)"/);
    expect(output).toContain('CCCD');
  });

  it('settles the cost of an answer attempt by attempt and gives the request its cost, with the audit and the event of the routing and no content in either', async () => {
    await world();
    const reply = await ask([await doc('INTERNAL')]);
    expect(reply.json.status).toBe('COMPLETED');
    const id = reply.json.resource_id as string;
    const [row] = await attempts(id);
    expect(row).toMatchObject({ attempt_kind: 'PRIMARY', route_class: 'DOMESTIC_HOSTED', actual_model: 'dom-model', outcome: 'SUCCESS' });
    expect(Number(row?.cost_vnd)).toBeGreaterThan(0);
    const stored = await request(id);
    expect(stored.cost_vnd).toBe(row?.cost_vnd);
    expect(stored.citations_count).toBe(1);
    expect((await app.rows<{ status: string }>('select status from machvon.budget_reservation'))[0]?.status).toBe('SETTLED');
    expect((await audits('llm.request_routed'))[0]?.safe_diff).toMatchObject({ status: 'COMPLETED', data_classification: 'INTERNAL', route_class: 'DOMESTIC_HOSTED' });
    expect((await events('llm.request.completed.v1'))[0]?.payload).toMatchObject({ ai_request_id: id, status: 'COMPLETED', route_class: 'DOMESTIC_HOSTED' });
    expect(app.metrics.filter((metric) => metric.name === 'llm_requests_total').map((metric) => metric.labels)).toEqual([expect.objectContaining({ route: 'DOMESTIC_HOSTED', classification: 'INTERNAL', status: 'COMPLETED' })]);
  });
});

describe('the checks after the answer (ST-LLM-005)', () => {
  it('AC-ST-LLM-005-4: UAT-AC466 does not use an answer that cites nothing or is not JSON: it asks the same model once more, then ends REJECTED_NO_CITATION or FAILED INVALID_JSON, and gives the model only tools that read', async () => {
    const w = await world();
    const source = await doc('INTERNAL');
    app.gateway.script('dom-model', [{ output: JSON.stringify({ summary: 'no sources', citations: [] }) }, { output: JSON.stringify({ summary: 'still none', citations: [] }) }]);
    const none = await ask([source]);
    expect([none.json.status, none.json.reject_code]).toEqual(['REJECTED_NO_CITATION', 'NO_CITATION']);
    expect(app.gateway.calls.map((call) => call.providerModelId)).toEqual(['dom-model', 'dom-model']);
    expect((await attempts(none.json.resource_id as string)).map((attempt) => [attempt.attempt_kind, attempt.outcome])).toEqual([
      ['PRIMARY', 'NO_CITATION'],
      ['RETRY', 'NO_CITATION'],
    ]);

    app.gateway.clear();
    app.gateway.script('dom-model', [{ output: 'this is not json' }, { output: JSON.stringify({ summary: 5, citations: [{ document_version_id: source }] }) }]);
    const broken = await ask([source]);
    expect([broken.json.status, broken.json.reject_code]).toEqual(['FAILED', 'INVALID_JSON']);
    expect((await attempts(broken.json.resource_id as string)).map((attempt) => attempt.outcome)).toEqual(['INVALID_JSON', 'INVALID_JSON']);

    // A citation of something that is not among the sources of the request does not exist.
    app.gateway.clear();
    app.gateway.script('dom-model', [{ output: JSON.stringify({ summary: 'x', citations: [{ document_version_id: randomUUID() }] }) }, { output: JSON.stringify({ summary: 'x', citations: [{ document_version_id: source }] }) }]);
    const later = await ask([source]);
    expect(later.json.status).toBe('COMPLETED');
    expect((await attempts(later.json.resource_id as string)).map((attempt) => attempt.attempt_kind)).toEqual(['PRIMARY', 'RETRY']);

    // The model is given the tools of the profile, which only read, and the template of the prompt that was approved.
    for (const call of app.gateway.calls) expect(call.tools).toEqual(['search_documents', 'read_document']);
    for (const call of app.gateway.calls) expect([call.promptTemplateKey, call.promptSha256]).toEqual(['tenants/t/prompts/summary-r1.txt', sha256Of('summary')]);
    expect(w.profile).toBeTruthy();
  });

  it('AC-ST-LLM-005-4: UAT-AC466 ends a request on the failure of the checks when the retry of the same model gets no answer, and does not send it to another model', async () => {
    await world();
    app.gateway.script('dom-model', [{ output: JSON.stringify({ summary: 'none', citations: [] }) }, { fail: 'PROVIDER_ERROR' }]);
    const reply = await ask([await doc('INTERNAL')]);
    expect([reply.json.status, reply.json.reject_code]).toEqual(['REJECTED_NO_CITATION', 'NO_CITATION']);
    expect(app.gateway.calls.map((call) => call.providerModelId)).toEqual(['dom-model', 'dom-model']);
    expect((await attempts(reply.json.resource_id as string)).map((attempt) => [attempt.attempt_kind, attempt.outcome])).toEqual([
      ['PRIMARY', 'NO_CITATION'],
      ['RETRY', 'PROVIDER_ERROR'],
    ]);
  });

  it('AC-ST-LLM-005-4: UAT-AC466 keeps the hold of a request whose retry did not answer in time, and ends it on the failure of the checks', async () => {
    await world();
    app.gateway.script('dom-model', [{ output: JSON.stringify({ summary: 'none', citations: [] }) }, { fail: 'TIMEOUT' }]);
    const reply = await ask([await doc('INTERNAL')]);
    expect([reply.json.status, reply.json.reject_code]).toEqual(['REJECTED_NO_CITATION', 'NO_CITATION']);
    expect(app.gateway.calls.map((call) => call.providerModelId)).toEqual(['dom-model', 'dom-model']);
    // What was paid for is settled, what the timed out call may have cost is not known: the hold waits for the reconciliation.
    expect((await app.rows<{ status: string }>('select status from machvon.budget_reservation'))[0]?.status).toBe('PENDING_RECONCILE');
    expect((await attempts(reply.json.resource_id as string)).map((attempt) => attempt.outcome)).toEqual(['NO_CITATION', 'TIMEOUT']);
  });

  it('does not serve a profile whose schema says more than the gateway checks, and keeps an exception of the budget when the retry that follows it times out', async () => {
    await world({ schema: { type: 'object', oneOf: [{ type: 'object' }] } });
    const refused = await ask([await doc('INTERNAL')]);
    expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'AI_ROUTE_NOT_ALLOWED', 'output_schema']);
    expect(app.gateway.calls).toHaveLength(0);
    expect((await app.rows('select 1 from machvon.ai_request')).length).toBe(0);

    await app.reset();
    app.gateway.clear();
    await world();
    // The first answer costs more than the hold (a usage the estimate did not foresee): the settlement is an exception, and the timeout of the retry does not undo it.
    app.gateway.script('dom-model', [{ output: JSON.stringify({ summary: 'none', citations: [] }), usage: { inputTotal: 9_000_000, cachedInput: 0, outputTotal: 9_000_000 } }, { fail: 'TIMEOUT' }]);
    const reply = await ask([await doc('INTERNAL')]);
    expect([reply.status, reply.json.status]).toEqual([202, 'REJECTED_NO_CITATION']);
    expect((await app.rows<{ status: string }>('select status from machvon.budget_reservation'))[0]?.status).toBe('EXCEPTION');
    expect((await attempts(reply.json.resource_id as string)).map((attempt) => attempt.outcome)).toEqual(['NO_CITATION', 'TIMEOUT']);
  });

  it('asks for citations only when the profile requires them', async () => {
    await world({ schema: PLAIN });
    app.gateway.script('dom-model', [{ output: JSON.stringify({ summary: 'fine' }) }]);
    const reply = await ask([await doc('PUBLIC')]);
    expect([reply.json.status, (await request(reply.json.resource_id as string)).citations_count]).toEqual(['COMPLETED', 0]);
  });
});

describe('the budget of a request (ST-LLM-005, LLM F3)', () => {
  it('holds the estimate before a model is called and refuses with 429 BUDGET_EXCEEDED, kept as a rejected request, when it does not fit; and refuses a limit of the caller that the estimate is above', async () => {
    await world();
    const budget = await app.call('POST', '/ai-budgets', { member: FINOPS, body: { scope_kind: 'TENANT', period: 'MONTH', limit_vnd: '10', hard_stop: true, effective_from: '2026-01-01' } });
    expect(budget.status).toBe(200);
    const source = await doc('INTERNAL');
    const refused = await ask([source]);
    expect([refused.status, refused.json.code, refused.json.detail]).toEqual([429, 'BUDGET_EXCEEDED', 'TENANT']);
    expect(app.gateway.calls).toHaveLength(0);
    expect((await app.rows<{ status: string; reject_code: string }>('select status, reject_code from machvon.ai_request'))[0]).toEqual({ status: 'REJECTED_POLICY', reject_code: 'BUDGET_EXCEEDED' });
    expect((await app.rows('select 1 from machvon.budget_reservation')).length).toBe(0);

    await app.rows('delete from machvon.ai_budget_counter');
    await app.rows('delete from machvon.ai_budget');
    const capped = await ask([source], { max_cost_vnd: '1' });
    expect([capped.status, capped.json.code, capped.json.detail]).toEqual([429, 'BUDGET_EXCEEDED', 'max_cost_vnd']);
    expect(app.gateway.calls).toHaveLength(0);
    expect((await ask([source], { max_cost_vnd: '99999999999' })).json.status).toBe('COMPLETED');
  });

  it('holds the budget of the person who asks as well, and names the scope that cannot take the hold', async () => {
    await world();
    const own = await app.call('POST', '/ai-budgets', { member: FINOPS, body: { scope_kind: 'USER', scope_ref_id: memberId(INVOKER), period: 'MONTH', limit_vnd: '10', hard_stop: true, effective_from: '2026-01-01' } });
    expect(own.status).toBe(200);
    const source = await doc('INTERNAL');
    const refused = await ask([source]);
    expect([refused.status, refused.json.code, refused.json.detail]).toEqual([429, 'BUDGET_EXCEEDED', 'USER']);
    expect(app.gateway.calls).toHaveLength(0);
    // Someone else is not held by it.
    await app.rows('delete from machvon.ai_request');
    await app.rows('update machvon.ai_budget set scope_ref_id = $1', [randomUUID()]);
    expect((await ask([source])).json.status).toBe('COMPLETED');
  });

  it('holds the budget for every answer that may be paid for: the first and the one asked again after a failed check', async () => {
    await world();
    const source = await doc('INTERNAL');
    // One answer of the dearest model is 610 dong (8,000 tokens in and 1,000 out at 2.00 and 8.00 dollars a million, 25,400 dong to the dollar): the hold is two of them.
    const budget = await app.call('POST', '/ai-budgets', { member: FINOPS, body: { scope_kind: 'TENANT', period: 'MONTH', limit_vnd: '1000', hard_stop: true, effective_from: '2026-01-01' } });
    expect(budget.status).toBe(200);
    const refused = await ask([source]);
    expect([refused.status, refused.json.code]).toEqual([429, 'BUDGET_EXCEEDED']);
    await app.rows('delete from machvon.ai_request');
    await app.rows("update machvon.ai_budget set limit_vnd = 1220");
    await app.rows('update machvon.ai_budget_counter set limit_vnd = 1220');
    const held = await ask([source]);
    expect(held.json.status).toBe('COMPLETED');
    expect(Number((await app.rows<{ reserved_amount: string }>('select reserved_amount::text from machvon.budget_reservation'))[0]?.reserved_amount)).toBe(1220);
  });

  it('repeats the same answer for the same key and does not call a model twice', async () => {
    await world();
    const source = await doc('INTERNAL');
    const key = `gateway-repeat-${randomUUID()}`;
    const first = await ask([source], {}, INVOKER, key);
    const again = await ask([source], {}, INVOKER, key);
    expect([first.status, again.status, again.json.resource_id]).toEqual([202, 202, first.json.resource_id]);
    expect(app.gateway.calls).toHaveLength(1);
    expect((await app.rows('select 1 from machvon.ai_request')).length).toBe(1);
  });
});

describe('the records of the gateway (ST-LLM-005, LLM-01, LLM-05)', () => {
  it('lists the requests with the filters and the month of the overview, newest first, in pages, and reads the route of one', async () => {
    await world();
    const source = await doc('INTERNAL');
    const done = await ask([source]);
    const open = await ask([await doc('PUBLIC')]);
    expect([done.json.status, open.json.status]).toEqual(['COMPLETED', 'COMPLETED']);
    const all = await app.call('GET', '/ai/requests', { member: AUDITOR });
    expect(all.status).toBe(200);
    expect((all.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([open.json.resource_id, done.json.resource_id]);
    expect(all.json.summary).toMatchObject({ total: 2, blocked: 0, by_route: { DOMESTIC_HOSTED: 2 } });
    expect(JSON.stringify(all.json)).not.toMatch(/input_sha256|output_sha256|classification_basis/);
    const first = await app.call('GET', '/ai/requests?limit=1', { member: AUDITOR });
    expect((first.json.items as unknown[]).length).toBe(1);
    const next = await app.call('GET', `/ai/requests?limit=1&cursor=${encodeURIComponent(first.json.next_cursor as string)}`, { member: AUDITOR });
    expect((next.json.items as Array<Record<string, unknown>>)[0]?.id).toBe(done.json.resource_id);
    expect(next.json.next_cursor).toBeNull();
    const filtered = await app.call('GET', '/ai/requests?data_classification=INTERNAL&status=COMPLETED&route_class=DOMESTIC_HOSTED&task_type=SUMMARY', { member: AUDITOR });
    expect((filtered.json.items as unknown[]).length).toBe(1);
    const forged = (key: string, id: string) => Buffer.from(`${key}|${id}`).toString('base64url');
    for (const bad of ['status=NOPE', 'route_class=MARS', 'data_classification=X', 'limit=0', 'limit=500', 'cursor=bad', `cursor=${forged('2026-99-01T00:00:00.000000', '00000000-0000-4000-8000-000000000001')}`, `cursor=${forged('2026-10-01T25:00:00.000000', '00000000-0000-4000-8000-000000000001')}`, `cursor=${forged('2026-10-01T00:00:00.000000', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')}`]) expect([bad, (await app.call('GET', `/ai/requests?${bad}`, { member: AUDITOR })).status]).toEqual([bad, 422]);
    expect((await app.call('GET', `/resources/llm_attempt?cursor=${forged('2026-99-01T00:00:00.000000', '00000000-0000-4000-8000-000000000001')}`, { member: AUDITOR })).status).toBe(422);
    const route = await app.call('GET', `/ai/requests/${done.json.resource_id as string}/route`, { member: AUDITOR });
    expect(route.json).toMatchObject({ provider_code: 'VN-HOST', model_id: 'dom-model', route_class: 'DOMESTIC_HOSTED' });
    expect((await app.call('GET', `/ai/requests/${randomUUID()}/route`, { member: AUDITOR })).status).toBe(404);
    const attemptList = await app.call('GET', '/resources/llm_attempt', { member: AUDITOR });
    expect((attemptList.json.items as unknown[]).length).toBe(2);
    const one = (attemptList.json.items as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect((await app.call('GET', `/resources/llm_attempt/${one.id as string}`, { member: AUDITOR })).json).toMatchObject({ id: one.id, model_id: one.model_id });
    expect((await app.call('GET', `/resources/llm_attempt/${randomUUID()}`, { member: AUDITOR })).status).toBe(404);
  });

  it('AC-ST-LLM-005-5: UAT-AC464 reads 50 of 1,000 requests as international and 30 as blocked for the month, and every international request is public', async () => {
    await world();
    const member = memberId(INVOKER);
    const profile = (await app.rows<{ id: string }>('select id from machvon.model_profile_version'))[0]?.id as string;
    const insert = (count: number, status: string, route: string | null, classification: string, reject: string | null) =>
      app.rows(
        `insert into machvon.ai_request (tenant_id, id, task_type, subject_module, requested_by, profile_version_id, data_classification, classification_basis, status, reject_code, route_class, input_sha256, created_by, updated_by)
         select $1::uuid, gen_random_uuid(), 'SUMMARY', 'BID', $2::uuid, $3::uuid, $4, '[]'::jsonb, $5, $6, $7, repeat('d', 64), $2::uuid, $2::uuid from generate_series(1, $8::int)`,
        [TENANT_A, member, profile, classification, status, reject, route, count],
      );
    await insert(700, 'COMPLETED', 'DOMESTIC_HOSTED', 'INTERNAL', null);
    await insert(220, 'COMPLETED', 'SELF_HOSTED', 'CONFIDENTIAL', null);
    await insert(50, 'COMPLETED', 'INTERNATIONAL', 'PUBLIC', null);
    await insert(30, 'REJECTED_POLICY', null, 'IMPORTANT_CORE', 'AI_ROUTE_NOT_ALLOWED');
    const overview = await app.call('GET', '/ai/requests?limit=1', { member: AUDITOR });
    expect(overview.json.summary).toMatchObject({ total: 1000, blocked: 30, by_route: { DOMESTIC_HOSTED: 700, SELF_HOSTED: 220, INTERNATIONAL: 50 } });
    // 50 / 1000 = 5.00 percent: the figures the screen divides.
    const summary = overview.json.summary as { total: number; by_route: Record<string, number> };
    expect(((summary.by_route.INTERNATIONAL as number) * 100) / summary.total).toBe(5);
    const international = await app.call('GET', '/ai/requests?route_class=INTERNATIONAL&limit=200', { member: AUDITOR });
    expect((international.json.items as Array<{ data_classification: string }>).every((item) => item.data_classification === 'PUBLIC')).toBe(true);
    // The database says the same: nothing but public data is on the international route.
    await expect(app.rows(`update machvon.ai_request set route_class = 'INTERNATIONAL' where status = 'REJECTED_POLICY' and id in (select id from machvon.ai_request where status = 'REJECTED_POLICY' limit 1)`)).rejects.toThrow(/ai_request_intl_chk/);
  });

  it('keeps the class, the sources and the input of a request as they were admitted, and refuses an attempt on the international route for data that is not public', async () => {
    await world();
    const reply = await ask([await doc('INTERNAL')]);
    const id = reply.json.resource_id as string;
    await expect(app.rows("update machvon.ai_request set data_classification = 'PUBLIC' where id = $1", [id])).rejects.toThrow(/ai_request_immutable_guard|the class, the sources/);
    await expect(app.rows("update machvon.ai_request set input_sha256 = repeat('e', 64) where id = $1", [id])).rejects.toThrow(/the class, the sources/);
    const price = (await app.rows<{ id: string }>('select id from machvon.pricing_version limit 1'))[0]?.id as string;
    await expect(
      app.rows(
        `insert into machvon.llm_attempt (tenant_id, id, provider_request_id, actual_model, pricing_version_id, input_total, cached_input, output_total, reasoning_info, cost, currency, reconcile_status, ai_request_id, attempt_no, attempt_kind, route_class, outcome)
         values ($1, gen_random_uuid(), 'x-1', 'intl-model', $2, 1, 0, 1, 0, 0, 'VND', 'SETTLED', $3, 9, 'FALLBACK', 'INTERNATIONAL', 'SUCCESS')`,
        [TENANT_A, price, id],
      ),
    ).rejects.toThrow(/only public data goes over the international route|llm_attempt_intl_chk/);
  });
});

describe('who may ask and who may read (ST-LLM-005)', () => {
  it('asks only with the right to invoke, reads the records only with the right to audit, and holds the tenant to its own', async () => {
    await world();
    const source = await doc('PUBLIC');
    for (const member of [READER, NOBODY, SCOPED, AUDITOR]) expect((await ask([source], {}, member)).status).toBe(403);
    expect((await app.call('GET', '/ai/requests', { member: INVOKER })).status).toBe(403);
    expect((await app.call('GET', '/ai/requests', { member: NOBODY })).status).toBe(403);
    expect((await app.call('GET', '/resources/llm_attempt', { member: INVOKER })).status).toBe(403);
    expect((await ask([source])).status).toBe(202);
    const foreign = await ask([source], {}, INVOKER, undefined);
    expect(foreign.status).toBe(202);
    const route = await app.call('GET', `/ai/requests/${foreign.json.resource_id as string}/route`, { member: AUDITOR, tenantId: TENANT_B });
    expect([401, 403, 404]).toContain(route.status);
  });
});

// ---- the emergency stop and the decisions of people (ST-LLM-006) ------------------------------------------------------------------------------

const withTx = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => app.harness.tenants.withTenant(contextFor(TENANT_A, memberId(DECIDER)), work);
const engage = (body: Record<string, unknown>, member = EMERGENCY): Promise<Reply> => app.call('POST', '/ai-kill-switches', { member, body: { reason: 'Suspected leak of data through the output', ...body } });
const release = (id: string, version: string, member = EMERGENCY_TWO, reason = 'The cause was found and fixed'): Promise<Reply> =>
  app.call('POST', `/ai-kill-switches/${id}/release`, { member, ifMatch: version, body: { release_reason: reason } });

/** A request that is in the state the gateway leaves it in while it waits or while a model is called: the rows it points at are the ones of the world. */
async function inFlight(status: 'ADMITTED' | 'RESERVED' | 'DISPATCHED', providerRequestId?: string, taskType = 'SUMMARY'): Promise<string> {
  const id = randomUUID();
  const profile = (await app.rows<{ id: string }>('select id from machvon.model_profile_version'))[0]?.id as string;
  const provider = (await app.rows<{ id: string }>("select id from machvon.ai_provider where provider_code = 'VN-HOST'"))[0]?.id as string;
  const model = (await app.rows<{ id: string }>("select id from machvon.ai_model where model_id = 'dom-model'"))[0]?.id as string;
  await app.rows(
    `insert into machvon.ai_request (tenant_id, id, task_type, subject_module, requested_by, profile_version_id, data_classification, classification_basis, status, route_class, provider_id, model_ref_id, input_sha256, created_by, updated_by)
     values ($1, $2, $6, 'BID', $3, $4, 'INTERNAL', '[]'::jsonb, $5, $7, $8, $9, repeat('f', 64), $3, $3)`,
    [TENANT_A, id, memberId(INVOKER), profile, status, taskType, status === 'ADMITTED' ? null : 'DOMESTIC_HOSTED', status === 'ADMITTED' ? null : provider, status === 'ADMITTED' ? null : model],
  );
  if (providerRequestId !== undefined) {
    const price = (await app.rows<{ id: string }>('select id from machvon.pricing_version limit 1'))[0]?.id as string;
    await app.rows(
      `insert into machvon.llm_attempt (tenant_id, id, provider_request_id, actual_model, pricing_version_id, input_total, cached_input, output_total, reasoning_info, cost, currency, reconcile_status, ai_request_id, attempt_no, attempt_kind, route_class, outcome)
       values ($1, gen_random_uuid(), $2, 'dom-model', $3, 0, 0, 0, 0, 0, 'VND', 'PENDING', $4, 1, 'PRIMARY', 'DOMESTIC_HOSTED', 'TIMEOUT')`,
      [TENANT_A, providerRequestId, price, id],
    );
  }
  return id;
}

describe('the emergency stop of the gateway (ST-LLM-006, LLM F7, LLM-18)', () => {
  it('AC-ST-LLM-006-1: UAT-AC21 stops a profile at once: new requests are refused, what waited is cancelled, a request that was sent is cancelled when the provider can and otherwise has its answer thrown away, and the one who engaged cannot release it', async () => {
    await world();
    const waiting = [await inFlight('ADMITTED'), await inFlight('ADMITTED'), await inFlight('RESERVED'), await inFlight('RESERVED'), await inFlight('RESERVED')];
    const sent = [await inFlight('DISPATCHED', 'prov-1'), await inFlight('DISPATCHED', 'prov-2'), await inFlight('DISPATCHED', 'prov-3')];
    app.gateway.cancelable.add('prov-1');
    app.gateway.cancelable.add('prov-2');
    // A hold that waited is given back.
    await app.rows(
      `insert into machvon.budget_reservation (tenant_id, id, request_id, scope_json, reserved_amount, currency, status, expires_at) values ($1, gen_random_uuid(), $2, '[]'::jsonb, 100, 'VND', 'RESERVED', now() + interval '10 minutes')`,
      [TENANT_A, waiting[2]],
    );

    const started = Date.now();
    const engaged = await engage({ scope_kind: 'PROFILE', scope_ref: 'SUMMARY' });
    expect([engaged.status, engaged.json.status, engaged.json.affected_requests, engaged.json.cancelled, engaged.json.dispatched]).toEqual([200, 'ENGAGED', 8, 5, 3]);
    const states = await app.rows<{ id: string; status: string; killed_pending: boolean; reject_code: string | null }>('select id, status, killed_pending, reject_code from machvon.ai_request');
    const of = (id: string) => states.find((row) => row.id === id) as { status: string; killed_pending: boolean; reject_code: string | null };
    for (const id of waiting) expect(of(id)).toMatchObject({ status: 'CANCELLED', reject_code: 'AI_KILL_SWITCH_ENGAGED' });
    expect([of(sent[0] as string).status, of(sent[1] as string).status]).toEqual(['CANCELLED', 'CANCELLED']);
    expect(of(sent[2] as string)).toMatchObject({ status: 'DISPATCHED', killed_pending: true });
    expect(app.gateway.cancelled.sort()).toEqual(['prov-1', 'prov-2']);
    // A request that its provider cancelled says when and why, like the others.
    const cancelledSent = await app.rows<{ completed_at: Date | null; reject_code: string | null }>('select completed_at, reject_code from machvon.ai_request where id = any($1::uuid[])', [[sent[0], sent[1]]]);
    expect(cancelledSent.every((row) => row.completed_at !== null && row.reject_code === 'AI_KILL_SWITCH_ENGAGED')).toBe(true);
    expect((await app.rows<{ status: string }>('select status from machvon.budget_reservation'))[0]?.status).toBe('RELEASED');

    // A new request is refused, and what is refused is kept.
    const refused = await ask([await doc('INTERNAL')]);
    expect(Date.now() - started).toBeLessThan(5000);
    expect([refused.status, refused.json.code, refused.json.detail]).toEqual([503, 'AI_KILL_SWITCH_ENGAGED', 'PROFILE']);
    expect(app.gateway.calls).toHaveLength(0);
    expect((await app.rows<{ status: string; reject_code: string }>("select status, reject_code from machvon.ai_request where id not in (select unnest($1::uuid[]))", [[...waiting, ...sent]]))[0]).toEqual({ status: 'REJECTED_POLICY', reject_code: 'AI_KILL_SWITCH_ENGAGED' });
    expect(app.metrics.find((metric) => metric.name === 'llm_requests_total')?.labels).toMatchObject({ status: 'REJECTED_POLICY' });

    // Another task is not stopped.
    expect((await ask([await doc('INTERNAL')], { task_type: 'OTHER' })).json.code).toBe('AI_ROUTE_NOT_ALLOWED');

    // The one who engaged it cannot release it, another person can, and then requests are served again.
    const id = engaged.json.resource_id as string;
    const own = await release(id, etag(engaged), EMERGENCY);
    expect([own.status, own.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
    expect((await release(id, '"9"')).json.code).toBe('VERSION_CONFLICT');
    expect((await release(id, etag(engaged), EMERGENCY_TWO, 'short')).status).toBe(422);
    const released = await release(id, etag(engaged));
    expect([released.status, released.json.status]).toEqual([200, 'RELEASED']);
    expect((await release(id, etag(released))).json.code).toBe('KILL_SWITCH_NOT_ENGAGED');
    expect((await ask([await doc('INTERNAL')])).json.status).toBe('COMPLETED');
    expect((await audits('llm.kill_switch_engaged'))[0]?.safe_diff).toMatchObject({ scope_kind: 'PROFILE', scope_ref: 'SUMMARY', affected_requests: 8, cancelled: 5, sent: 3 });
    expect((await audits('llm.kill_switch_released'))[0]?.safe_diff).toMatchObject({ engaged_by: memberId(EMERGENCY) });
    expect((await events('llm.kill_switch.engaged.v1')).length).toBe(1);
    expect(Number(app.metrics.find((metric) => metric.name === 'llm_kill_switch_latency_ms')?.labels.value)).toBeLessThan(5000);
  });

  it('refuses a scope that is not one, a second switch of the same scope, and every other way of engaging or releasing it that is not allowed', async () => {
    await world();
    expect((await engage({ scope_kind: 'TENANT', scope_ref: 'x' })).status).toBe(422);
    expect((await engage({ scope_kind: 'PROVIDER', scope_ref: randomUUID() })).status).toBe(422);
    expect((await engage({ scope_kind: 'MODEL', scope_ref: 'dom-model' })).status).toBe(422);
    expect((await engage({ scope_kind: 'TASK_TYPE' })).status).toBe(422);
    expect((await engage({ scope_kind: 'TENANT', reason: 'short' })).status).toBe(422);
    expect((await engage({ scope_kind: 'GALAXY' })).status).toBe(422);
    const first = await engage({ scope_kind: 'TENANT' });
    expect([first.status, first.json.affected_requests]).toEqual([200, 0]);
    const twice = await engage({ scope_kind: 'TENANT' }, EMERGENCY_TWO);
    expect([twice.status, twice.json.code]).toEqual([409, 'KILL_SWITCH_ALREADY_ENGAGED']);
    for (const member of [INVOKER, AUDITOR, READER, NOBODY, SCOPED]) expect((await engage({ scope_kind: 'TASK_TYPE', scope_ref: 'SUMMARY' }, member)).status).toBe(403);
    expect((await release(first.json.resource_id as string, etag(first), AUDITOR)).status).toBe(403);
    expect((await release(randomUUID(), '"1"')).status).toBe(404);
    // The database holds the same: a released switch does not engage again, and the scope and the reason do not change.
    await expect(app.rows("update machvon.ai_kill_switch set reason = 'something else than before'")).rejects.toThrow(/do not change/);
    await expect(app.rows("update machvon.ai_kill_switch set scope_ref = 'X', scope_kind = 'TASK_TYPE'")).rejects.toThrow(/do not change|ai_kill_switch_scope_chk/);
    await expect(app.rows("insert into machvon.ai_kill_switch (tenant_id, id, scope_kind, scope_ref, reason, state, engaged_by, created_by, updated_by) values ($1, gen_random_uuid(), 'TENANT', null, 'a second one of the tenant', 'ENGAGED', $2, $2, $2)", [TENANT_A, memberId(EMERGENCY)])).rejects.toThrow(/ai_kill_switch_engaged_uq/);
    const done = await release(first.json.resource_id as string, etag(first));
    expect(done.status).toBe(200);
    await expect(app.rows("update machvon.ai_kill_switch set state = 'ENGAGED'")).rejects.toThrow(/released|ai_kill_switch_release_chk/);
    const listed = await app.call('GET', '/ai-kill-switches?state=RELEASED', { member: AUDITOR });
    expect((listed.json.items as Array<Record<string, unknown>>).map((item) => [item.scope_kind, item.state, item.release_approved_by])).toEqual([['TENANT', 'RELEASED', memberId(EMERGENCY_TWO)]]);
    expect((await app.call('GET', '/ai-kill-switches?state=NOPE', { member: AUDITOR })).status).toBe(422);
    expect((await app.call('GET', '/ai-kill-switches', { member: INVOKER })).status).toBe(403);
  });

  it('stops a whole tenant at the door, and takes a provider or a model out of the candidates without stopping the others', async () => {
    const w = await world();
    const dom = (await app.rows<{ id: string }>("select id from machvon.ai_provider where provider_code = 'VN-HOST'"))[0]?.id as string;
    const tenant = await engage({ scope_kind: 'TENANT' });
    expect((await ask([await doc('INTERNAL')])).json.detail).toBe('TENANT');
    await release(tenant.json.resource_id as string, etag(tenant));

    // A provider that is stopped is not called; the request goes to the next route.
    const provider = await engage({ scope_kind: 'PROVIDER', scope_ref: dom });
    const around = await ask([await doc('INTERNAL')]);
    expect([around.json.status, around.json.route_class]).toEqual(['COMPLETED', 'SELF_HOSTED']);
    expect(app.gateway.calls.map((call) => call.providerModelId)).toEqual(['self-model']);
    await release(provider.json.resource_id as string, etag(provider));

    app.gateway.clear();
    const model = await engage({ scope_kind: 'MODEL', scope_ref: w.domestic });
    expect((await ask([await doc('INTERNAL')])).json.route_class).toBe('SELF_HOSTED');
    // When nothing is left that is not stopped, the caller is told that a switch is the reason.
    const second = await engage({ scope_kind: 'MODEL', scope_ref: w.selfHosted as string });
    const none = await ask([await doc('INTERNAL')]);
    expect([none.status, none.json.code]).toEqual([503, 'AI_KILL_SWITCH_ENGAGED']);
    expect((await release(model.json.resource_id as string, etag(model))).status).toBe(200);
    expect((await release(second.json.resource_id as string, etag(second))).status).toBe(200);
  });

  it('throws away the answer of a request whose provider or model was stopped while it answered, and not the one of a request that began after the stop was released', async () => {
    const w = await world();
    const dom = (await app.rows<{ id: string }>("select id from machvon.ai_provider where provider_code = 'VN-HOST'"))[0]?.id as string;
    app.gateway.script('dom-model', [
      async (call) => {
        await engage({ scope_kind: 'PROVIDER', scope_ref: dom });
        return { providerRequestId: 'late-p1', output: JSON.stringify({ summary: 'late', citations: call.sourceIds.slice(0, 1).map((id) => ({ document_version_id: id })) }), usage: { inputTotal: 900, cachedInput: 0, outputTotal: 100 }, latencyMs: 50 };
      },
    ]);
    const reply = await ask([await doc('INTERNAL')]);
    // The answer of the provider that was stopped is not used, and the request is not sent on to another model: it ends cancelled.
    expect([reply.json.status, reply.json.reject_code]).toEqual(['CANCELLED', 'AI_KILL_SWITCH_ENGAGED']);
    expect((await request(reply.json.resource_id as string)).output_sha256).toBeNull();
    // After the release the provider serves again, and a request that began after the stop is not touched by it.
    const listed = await app.call('GET', '/ai-kill-switches?state=ENGAGED', { member: AUDITOR });
    const item = (listed.json.items as Array<{ id: string; version: number }>)[0] as { id: string; version: number };
    expect((await release(item.id, `"${item.version}"`)).status).toBe(200);
    const later = await ask([await doc('INTERNAL')]);
    expect([later.json.status, later.json.route_class]).toEqual(['COMPLETED', 'DOMESTIC_HOSTED']);
    expect(w.domestic).toBeTruthy();
  });

  it('tells that a switch is the reason when it left the request with nothing, whether the switch came before the plan or while the request ran, and not when the plan had nothing anyway', async () => {
    const w = await world({ international: false });
    const self = w.selfHosted as string;
    // Before the plan: the domestic model is stopped and the self-hosted one is on a route that the class does not take (important data goes to self-hosted only, so use a profile that has the domestic route only).
    await app.rows("update machvon.model_profile_version set routing_policy = '{\"routes\":[\"DOMESTIC_HOSTED\"],\"thresholds\":{}}'::jsonb");
    const stop = await engage({ scope_kind: 'MODEL', scope_ref: w.domestic });
    const before = await ask([await doc('INTERNAL')]);
    expect([before.status, before.json.code]).toEqual([503, 'AI_KILL_SWITCH_ENGAGED']);
    await release(stop.json.resource_id as string, etag(stop));
    // A model that is stopped but would not have served the request anyway is not the reason.
    const other = await engage({ scope_kind: 'MODEL', scope_ref: self });
    const plain = await ask([await doc('IMPORTANT_CORE')]);
    expect([plain.status, plain.json.code]).toEqual([422, 'AI_ROUTE_NOT_ALLOWED']);
    await release(other.json.resource_id as string, etag(other));

    // While the request ran: the first model fails and the next is stopped meanwhile.
    await app.rows("update machvon.model_profile_version set routing_policy = '{\"routes\":[\"DOMESTIC_HOSTED\",\"SELF_HOSTED\"],\"thresholds\":{}}'::jsonb");
    app.gateway.script('dom-model', [
      async () => {
        await engage({ scope_kind: 'MODEL', scope_ref: self });
        throw new GatewayFailure('PROVIDER_ERROR');
      },
    ]);
    const during = await ask([await doc('INTERNAL')]);
    expect([during.json.status, during.json.reject_code]).toEqual(['CANCELLED', 'AI_KILL_SWITCH_ENGAGED']);

    // A call that fails while its own scope is stopped ends the request as stopped, with nothing left to try, and not as exhausted.
    await app.rows('delete from machvon.ai_kill_switch');
    await app.rows("update machvon.model_profile_version set routing_policy = '{\"routes\":[\"DOMESTIC_HOSTED\"],\"thresholds\":{}}'::jsonb");
    app.gateway.script('dom-model', [
      async () => {
        await engage({ scope_kind: 'MODEL', scope_ref: w.domestic });
        throw new GatewayFailure('TIMEOUT');
      },
    ]);
    const failing = await ask([await doc('INTERNAL')]);
    expect([failing.json.status, failing.json.reject_code]).toEqual(['CANCELLED', 'AI_KILL_SWITCH_ENGAGED']);
  });

  it('AC-ST-LLM-006-1: UAT-AC21 throws away the answer of a request whose scope was stopped while a model was called, and the request is cancelled; what was paid for is settled', async () => {
    await world();
    let stopped: Reply | undefined;
    app.gateway.script('dom-model', [
      async (call) => {
        // The security officer engages the switch while the model is answering.
        stopped = await engage({ scope_kind: 'TASK_TYPE', scope_ref: 'SUMMARY' });
        // ... and another person releases it before the model has answered: the request that it overlapped is stopped all the same.
        expect((await release(stopped.json.resource_id as string, etag(stopped))).status).toBe(200);
        return { providerRequestId: 'late-1', output: JSON.stringify({ summary: 'late', citations: call.sourceIds.slice(0, 1).map((id) => ({ document_version_id: id })) }), usage: { inputTotal: 900, cachedInput: 0, outputTotal: 100 }, latencyMs: 50 };
      },
    ]);
    const reply = await ask([await doc('INTERNAL')]);
    expect([reply.status, reply.json.status, reply.json.reject_code]).toEqual([202, 'CANCELLED', 'AI_KILL_SWITCH_ENGAGED']);
    expect(stopped?.status).toBe(200);
    const stored = await request(reply.json.resource_id as string);
    expect([stored.output_sha256, stored.citations_count]).toEqual([null, null]);
    expect(Number(stored.cost_vnd)).toBeGreaterThan(0);
    expect((await app.rows<{ status: string }>('select status from machvon.budget_reservation'))[0]?.status).toBe('SETTLED');
    expect(app.gateway.calls).toHaveLength(1);
  });
});

describe('the decisions of people about what an AI answered (ST-LLM-006, LLM F8, LLM-20)', () => {
  const decide = (body: Record<string, unknown>, member = DECIDER): Promise<Reply> =>
    app.call('POST', '/ai-decisions', {
      member,
      body: { subject_module: 'PAY', subject_kind: 'alert_amount', subject_id: randomUUID(), action_kind: 'MONEY', decision: 'ACCEPTED_WITH_CHANGE', rationale: 'The amount was checked against the ledger and corrected', ...body },
    });

  it('AC-ST-LLM-006-2: UAT-AC468 asks the command that uses an answer for a decision of a person: none is 422 AI_DECISION_REQUIRED, one about another answer 422 AI_OUTPUT_HASH_MISMATCH, then it succeeds and says what it did, once', async () => {
    await world();
    const answered = await ask([await doc('INTERNAL')]);
    const requestId = answered.json.resource_id as string;
    const hash = (await request(requestId)).output_sha256 as string;
    const subject = randomUUID();
    const store = new AiDecisionStore();
    const ask9 = (overrides: Record<string, unknown> = {}) => withTx((tx) => store.require(tx, { aiRequestId: requestId, aiOutputSha256: hash, subjectKind: 'alert_amount', subjectId: subject, actionKind: 'MONEY', ...overrides }));
    const code = async (run: () => Promise<unknown>): Promise<[string | undefined, string | undefined]> => {
      try {
        await run();
        return [undefined, undefined];
      } catch (error) {
        return [(error as { code?: string }).code, (error as { detail?: string }).detail];
      }
    };
    // 1. The command is called with no record.
    expect(await code(() => ask9())).toEqual(['AI_DECISION_REQUIRED', 'ai_decision_record']);
    // 2. A record about another answer is not made: the hash must be the one the request gave.
    const wrong = await decide({ ai_request_id: requestId, subject_id: subject, ai_output_sha256: 'b'.repeat(64) });
    expect([wrong.status, wrong.json.code]).toEqual([422, 'AI_OUTPUT_HASH_MISMATCH']);
    // ... and a command that holds another answer than the request gave is refused too.
    expect(await code(() => ask9({ aiOutputSha256: 'b'.repeat(64) }))).toEqual(['AI_OUTPUT_HASH_MISMATCH', 'ai_output_sha256']);
    // 3. The person decides, with a rationale of twenty characters, and the command goes through.
    expect((await decide({ ai_request_id: requestId, subject_id: subject, ai_output_sha256: hash, rationale: 'too short' })).status).toBe(422);
    const rejected = await decide({ ai_request_id: requestId, subject_id: subject, ai_output_sha256: hash, decision: 'REJECTED', rationale: 'The amount does not match the ledger at all' });
    expect(rejected.status).toBe(200);
    expect(await code(() => ask9())).toEqual(['AI_DECISION_REQUIRED', 'REJECTED']);
    const accepted = await decide({ ai_request_id: requestId, subject_id: subject, ai_output_sha256: hash });
    expect([accepted.status, accepted.json.status]).toEqual([200, 'ACCEPTED_WITH_CHANGE']);
    const found = await ask9();
    expect([found.id, found.decision, found.decidedBy]).toEqual([accepted.json.resource_id, 'ACCEPTED_WITH_CHANGE', memberId(DECIDER)]);
    await withTx((tx) => store.markApplied(tx, found.id, 'approvePaymentAlert', 7));
    const stored = (await app.rows<{ applied_operation_id: string; applied_resource_version: string }>('select applied_operation_id, applied_resource_version::text from machvon.ai_decision_record where id = $1', [found.id]))[0];
    expect(stored).toEqual({ applied_operation_id: 'approvePaymentAlert', applied_resource_version: '7' });
    expect(await code(() => withTx((tx) => store.markApplied(tx, found.id, 'again', 8)))).toEqual(['IDEMPOTENCY_CONFLICT', 'applied_operation_id']);
    // A decision of another subject, and of another kind of action, is not this one.
    expect(await code(() => ask9({ subjectId: randomUUID() }))).toEqual(['AI_DECISION_REQUIRED', 'ai_decision_record']);
    expect(await code(() => ask9({ actionKind: 'WRITE' }))).toEqual(['AI_DECISION_REQUIRED', 'ai_decision_record']);
    // The record is written once: no change but the one above, and no deletion, whoever asks.
    await expect(app.rows("update machvon.ai_decision_record set rationale = 'a rationale of another kind written later'")).rejects.toThrow(/not changed/);
    await expect(app.rows("update machvon.ai_decision_record set decision = 'REJECTED' where id = $1", [found.id])).rejects.toThrow(/not changed/);
    await expect(app.rows('delete from machvon.ai_decision_record')).rejects.toThrow(/not deleted/);
    expect((await audits('llm.decision_recorded')).length).toBe(2);
    expect(JSON.stringify((await audits('llm.decision_recorded')).map((row) => row.safe_diff))).not.toContain('ledger');
    expect((await events('llm.decision.recorded.v1')).length).toBe(2);
  });

  it('measures the rationale after what looks like a secret was taken out of it: a rationale that is only a token is a validation error, not a failure of the server', async () => {
    await world();
    const answered = await ask([await doc('INTERNAL')]);
    const requestId = answered.json.resource_id as string;
    const hash = (await request(requestId)).output_sha256 as string;
    const token = 'sk-live-1234567890abcdefghijklmnopqrstuvwx';
    const refused = await decide({ ai_request_id: requestId, ai_output_sha256: hash, rationale: token });
    expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, 'VALIDATION_FAILED', 'rationale']);
    const kept = await decide({ ai_request_id: requestId, ai_output_sha256: hash, rationale: `The ledger was checked, see ${token} for the note` });
    expect(kept.status).toBe(200);
    expect(JSON.stringify(await app.rows('select rationale from machvon.ai_decision_record'))).not.toContain(token);
    // The reason of a switch is kept without the secret too.
    const stop = await engage({ scope_kind: 'TENANT', reason: `Leak seen with ${token} in the output` });
    expect(stop.status).toBe(200);
    expect(JSON.stringify(await app.rows('select reason from machvon.ai_kill_switch'))).not.toContain(token);
  });

  it('records a decision only about an answer that was given, to who may decide, and lists the records with the filters', async () => {
    await world();
    const answered = await ask([await doc('INTERNAL')]);
    const requestId = answered.json.resource_id as string;
    const hash = (await request(requestId)).output_sha256 as string;
    expect((await decide({ ai_request_id: randomUUID(), ai_output_sha256: hash })).status).toBe(404);
    const refused = await ask([await doc('IMPORTANT_CORE')]);
    expect(refused.status).toBe(202);
    for (const bad of [{ decision: 'MAYBE' }, { action_kind: 'DELETE' }, { ai_output_sha256: 'xyz' }, { subject_id: 'not-a-uuid' }]) expect((await decide({ ai_request_id: requestId, ai_output_sha256: hash, ...bad })).status).toBe(422);
    for (const member of [INVOKER, AUDITOR, NOBODY, SCOPED]) expect((await decide({ ai_request_id: requestId, ai_output_sha256: hash }, member)).status).toBe(403);
    const mine = await decide({ ai_request_id: requestId, ai_output_sha256: hash, subject_module: 'pay' });
    const other = await decide({ ai_request_id: requestId, ai_output_sha256: hash, subject_module: 'BID', decision: 'REJECTED', rationale: 'The proposal does not follow the criteria' });
    expect([mine.status, other.status]).toEqual([200, 200]);
    const all = await app.call('GET', '/ai-decisions', { member: AUDITOR });
    expect((all.json.items as Array<Record<string, unknown>>).map((item) => [item.subject_module, item.decision])).toEqual([['BID', 'REJECTED'], ['PAY', 'ACCEPTED_WITH_CHANGE']]);
    expect(((all.json.items as Array<Record<string, unknown>>)[1] as Record<string, unknown>).decided_by).toBe(memberId(DECIDER));
    expect(((await app.call('GET', `/ai-decisions?ai_request_id=${requestId}&decision=REJECTED`, { member: AUDITOR })).json.items as unknown[]).length).toBe(1);
    expect(((await app.call('GET', '/ai-decisions?subject_module=pay', { member: AUDITOR })).json.items as unknown[]).length).toBe(1);
    const page = await app.call('GET', '/ai-decisions?limit=1', { member: AUDITOR });
    expect([(page.json.items as unknown[]).length, typeof page.json.next_cursor]).toEqual([1, 'string']);
    expect(((await app.call('GET', `/ai-decisions?limit=1&cursor=${encodeURIComponent(page.json.next_cursor as string)}`, { member: AUDITOR })).json.next_cursor)).toBeNull();
    for (const bad of ['decision=X', 'ai_request_id=nope', 'limit=0', 'cursor=bad']) expect((await app.call('GET', `/ai-decisions?${bad}`, { member: AUDITOR })).status).toBe(422);
    expect((await app.call('GET', '/ai-decisions', { member: INVOKER })).status).toBe(403);
  });
});
