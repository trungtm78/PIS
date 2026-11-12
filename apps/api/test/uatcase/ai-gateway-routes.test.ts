import { randomUUID } from 'node:crypto';
import { sha256Of } from '@machvon/kernel';
import { AI_ADMIN, FINOPS, INVOKER, LlmApp, PROMPT_APPROVER, PROMPT_AUTHOR, SECURITY, TENANT_A, memberId } from '../llm/llm-app';
import type { Reply } from '../llm/llm-app';
import { assertStatus, expectCheckFails } from '../uat/uat-kit';

jest.setTimeout(240_000);

/**
 * UAT-NFR-AI-01 (NFR-AI-01): the class of a request is the highest class of its sources, never the one the client says, and it decides the route. A dossier of a bidder (CONFIDENTIAL) goes to the self-hosted model only; a press release (PUBLIC)
 * may go to the international model of the profile; when the domestic route is turned off the dossier is refused with 422 AI_ROUTE_NOT_ALLOWED and the international model is never called. The records of the gateway say the same.
 */
const app = new LlmApp();
type Class = 'PUBLIC' | 'CONFIDENTIAL' | 'IMPORTANT_CORE';
type Route = 'SELF_HOSTED' | 'INTERNATIONAL';
const SCHEMA = { type: 'object', properties: { summary: { type: 'string' }, citations: { type: 'array', items: { type: 'object' } } }, required: ['summary', 'citations'] };
const etag = (reply: Reply): string => `"${String(reply.json.resource_version)}"`;

async function publishPolicy(): Promise<void> {
  const matrix = { PUBLIC: ['DOMESTIC_HOSTED', 'SELF_HOSTED', 'INTERNATIONAL'], INTERNAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], CONFIDENTIAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], PERSONAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], IMPORTANT_CORE: ['SELF_HOSTED'] };
  const drafted = await app.call('POST', '/ai-classification-policies', { member: AI_ADMIN, body: { matrix, international_enabled: true, d07_approval_ref: 'D07-2026-01', legal_basis: 'Luat 2026', effective_from: '2026-01-01T00:00:00.000Z' } });
  assertStatus(drafted, 200);
  assertStatus(await app.call('POST', `/ai-classification-policies/${drafted.json.resource_id as string}/publish`, { member: SECURITY, ifMatch: etag(drafted), body: {} }), 200);
}

async function providerWithModel(code: string, route: Route, max: Class, modelCode: string): Promise<string> {
  let agreement: string | undefined;
  if (max !== 'PUBLIC') {
    agreement = randomUUID();
    await app.rows(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'HD', 'DPA', 'INTERNAL', $3, $3)`, [TENANT_A, agreement, memberId(AI_ADMIN)]);
  }
  const made = await app.call('POST', '/ai-providers', {
    member: AI_ADMIN,
    body: { provider_code: code, name: code, region_country: route === 'INTERNATIONAL' ? 'US' : 'VN', route_class: route, max_classification: max, ...(agreement === undefined ? {} : { data_agreement_document_id: agreement }) },
  });
  assertStatus(made, 200);
  assertStatus(await app.call('POST', `/ai-providers/${made.json.resource_id as string}/activation`, { member: SECURITY, ifMatch: etag(made), body: route === 'INTERNATIONAL' ? { d07_approval_ref: 'D07-2026-01' } : {} }), 200);
  const model = await app.call('POST', '/ai-models', { member: AI_ADMIN, body: { provider_id: made.json.resource_id, model_id: modelCode, capabilities: {}, context_window: 8000, max_output: 1000, max_classification: max } });
  assertStatus(model, 200);
  assertStatus(await app.call('POST', `/ai-models/${model.json.resource_id as string}/approval`, { member: SECURITY, ifMatch: etag(model), body: {} }), 200);
  assertStatus(
    await app.call('POST', '/ai-pricing-versions', {
      member: FINOPS,
      body: {
        provider: 'ProviderCo',
        model_id: modelCode,
        model_ref_id: model.json.resource_id,
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
    }),
    200,
  );
  return made.json.resource_id as string;
}

/** The profile of the summaries: the self-hosted and the international models, the international one first (the press releases are public). */
async function world(): Promise<{ self: string; international: string }> {
  await publishPolicy();
  const self = await providerWithModel('VN-SELFHOST', 'SELF_HOSTED', 'IMPORTANT_CORE', 'self-model');
  const international = await providerWithModel('INTL-MOCK', 'INTERNATIONAL', 'PUBLIC', 'intl-model');
  const drafted = await app.call('POST', '/ai-prompts', {
    member: PROMPT_AUTHOR,
    body: { task_type: 'SUMMARY', name: 'summary', template_object_key: 'tenants/t/prompts/summary-r1.txt', template_sha256: sha256Of('summary'), input_schema: SCHEMA, output_schema: SCHEMA },
  });
  assertStatus(drafted, 200);
  assertStatus(await app.call('POST', `/ai-prompts/${drafted.json.resource_id as string}/approval`, { member: PROMPT_APPROVER, ifMatch: etag(drafted), body: {} }), 200);
  const models = await app.rows<{ id: string }>('select id from machvon.ai_model order by model_id');
  await app.rows(
    `insert into machvon.model_profile_version (tenant_id, id, task_type, revision, model_id, output_cap, routing_policy, status, allowed_model_ids, max_input_tokens, timeout_ms, concurrency_limit, output_schema, tool_allowlist,
       max_classification, prompt_version_id, retention_days, created_by)
     values ($1, $2, 'SUMMARY', 1, 'intl-model', 1000, $3::jsonb, 'PUBLISHED', $4::jsonb, 8000, 30000, 4, $5::jsonb, '["search_documents","read_document"]'::jsonb, 'IMPORTANT_CORE', $6, 90, $7)`,
    [TENANT_A, randomUUID(), JSON.stringify({ routes: ['SELF_HOSTED', 'INTERNATIONAL'], thresholds: {} }), JSON.stringify(models.map((row) => row.id)), JSON.stringify(SCHEMA), drafted.json.resource_id, memberId(PROMPT_AUTHOR)],
  );
  return { self, international };
}

async function doc(classification: Class, title: string): Promise<string> {
  const document = randomUUID();
  const version = randomUUID();
  await app.rows(`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', $4, 'INTERNAL', $3, $3)`, [TENANT_A, document, memberId(AI_ADMIN), title]);
  await app.rows(
    `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
     values ($1, $2, $3, 1, $5, repeat('a', 64), 'application/pdf', 1, $4, 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
    [TENANT_A, version, document, classification, `tenants/t/source-${version}.pdf`],
  );
  return version;
}

let keyCounter = 0;
const ask = (source: string, overrides: Record<string, unknown> = {}): Promise<Reply> =>
  app.call('POST', '/ai/requests', {
    member: INVOKER,
    key: `route-key-${(keyCounter += 1)}-${randomUUID()}`,
    body: { task_type: 'SUMMARY', subject_module: 'BID', source_refs: [{ document_version_id: source }], input_ref: 'tenants/t/inputs/summary-1', input_sha256: sha256Of('the input'), ...overrides },
  });

describe('UAT-NFR-AI-01: the class of the data decides the route of the request', () => {
  beforeAll(() => app.start());
  afterAll(() => app.stop());

  it('goes red on a wrong answer (negative control)', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 422, 'AI_ROUTE_NOT_ALLOWED'));
  });

  it('UAT-NFR-AI-01: the dossier is CONFIDENTIAL whatever the client says and goes to the self-hosted model, the press release goes to the international model, and with the self-hosted route off the dossier is refused 422 AI_ROUTE_NOT_ALLOWED without a call to the international model', async () => {
    const { self } = await world();
    const dossier = await doc('CONFIDENTIAL', 'Proposal of the bidder');
    const release = await doc('PUBLIC', 'Press release');

    // The client says PUBLIC: the field is not part of the request, and nothing is written or sent for it.
    const forged = await ask(dossier, { data_classification: 'PUBLIC' });
    assertStatus(forged, 400, 'FIELD_NOT_ALLOWED');
    expect(app.gateway.calls).toHaveLength(0);
    expect(await app.rows('select 1 from machvon.ai_request')).toEqual([]);

    // Step 1: the dossier alone is CONFIDENTIAL, on the self-hosted route.
    const first = await ask(dossier);
    assertStatus(first, 202);
    expect(first.json).toMatchObject({ status: 'COMPLETED', data_classification: 'CONFIDENTIAL', route_class: 'SELF_HOSTED' });
    expect(app.gateway.calls.map((call) => [call.route, call.providerCode])).toEqual([['SELF_HOSTED', 'VN-SELFHOST']]);

    // Step 2: the press release is PUBLIC, and goes to the international model of the profile.
    const second = await ask(release);
    assertStatus(second, 202);
    expect(second.json).toMatchObject({ status: 'COMPLETED', data_classification: 'PUBLIC', route_class: 'INTERNATIONAL' });
    expect(app.gateway.calls.map((call) => [call.route, call.providerCode])).toEqual([['SELF_HOSTED', 'VN-SELFHOST'], ['INTERNATIONAL', 'INTL-MOCK']]);

    // Step 3: the self-hosted route is turned off, and the dossier is asked for again.
    await app.rows("update machvon.ai_provider set status = 'SUSPENDED' where id = $1", [self]);
    const third = await ask(dossier);
    assertStatus(third, 422, 'AI_ROUTE_NOT_ALLOWED');
    expect(app.gateway.calls).toHaveLength(2);

    // Step 4: the records of the gateway.
    expect(await app.rows('select status, data_classification, route_class, reject_code from machvon.ai_request order by created_at')).toEqual([
      { status: 'COMPLETED', data_classification: 'CONFIDENTIAL', route_class: 'SELF_HOSTED', reject_code: null },
      { status: 'COMPLETED', data_classification: 'PUBLIC', route_class: 'INTERNATIONAL', reject_code: null },
      { status: 'REJECTED_POLICY', data_classification: 'CONFIDENTIAL', route_class: null, reject_code: 'AI_ROUTE_NOT_ALLOWED' },
    ]);
    const rejected = await app.rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'llm.request_rejected'");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.safe_diff).toMatchObject({ reject_code: 'AI_ROUTE_NOT_ALLOWED', data_classification: 'CONFIDENTIAL' });
  });
});
