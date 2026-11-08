import { randomUUID } from 'node:crypto';
import { aiEditionPolicy, PUBLIC_AI_POLICY } from '@machvon/kernel';
import { clearEnterpriseAiPolicy, registerEnterpriseAiPolicy } from '@machvon/edition-enterprise/src/server.ts';
import { loadEnterpriseManifest } from '../../src/editions/load-enterprise';
import { asObjects } from '../support/json';
import { ASKER, EXCEPTION_ASKER, EXCEPTION_DECIDER, PROVIDER_ADMIN, PROVIDER_APPROVER, TENANT_A, AssistWorld } from './assist-world';
import type { Records, Reply } from './assist-world';

jest.setTimeout(300_000);

/**
 * KT.02 and eng-review R5 in the enterprise build: processing stays on the servers of the customer, an external provider is off by default, using one needs an approved exception that is logged, and a provider
 * is attested (data location, no training) before it is activated. The name of this file ends in `.enterprise.test.ts`: it is one of the few sources that may name the enterprise package.
 */
describe('the AI of the enterprise edition: external providers off by default, on only under an approved and logged exception (R5, KT.02)', () => {
  const world = new AssistWorld();
  let records: Records;

  beforeAll(async () => {
    await world.start();
    records = await world.seedRecords();
  }, 300_000);

  afterAll(async () => {
    clearEnterpriseAiPolicy();
    await world.stop();
  }, 60_000);

  beforeEach(async () => {
    await world.reset();
    await world.seedRegistry();
    registerEnterpriseAiPolicy();
  });

  afterEach(() => clearEnterpriseAiPolicy());

  const ask = (member = ASKER): Promise<Reply> => world.call('POST', '/ai/assist/runs', { member, body: { kind: 'QA', request_text: 'How is the project doing?', sources: [{ kind: 'PROJECT', id: records.projectId }] } });
  const answer = (model: string): void => world.gateway.script(model, [{ output: JSON.stringify({ statements: [{ id: 's1', text: 'Recorded.', basis: 'SOURCE', citations: [{ kind: 'PROJECT', id: records.projectId, locator: 'field:code' }] }] }) }]);
  const request = (providerId: string, extra: Record<string, unknown> = {}): Promise<Reply> =>
    world.call('POST', '/ai/external-exceptions', {
      member: EXCEPTION_ASKER,
      body: { provider_id: providerId, max_classification: 'INTERNAL', reason: 'The model of the customer is down for maintenance and the report is due tomorrow.', valid_days: 7, ...extra },
    });
  const decide = (id: string, version: number, body: Record<string, unknown>, member = EXCEPTION_DECIDER): Promise<Reply> => world.call('POST', `/ai/external-exceptions/${id}/decision`, { member, ifMatch: `"${version}"`, body });
  const approved = async (providerId: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const made = await request(providerId, extra);
    expect(made.status).toBe(200);
    const done = await decide(made.json.resource_id as string, 1, { decision: 'APPROVE', approval_ref: 'DEC-2026-114' });
    expect(done).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
    return made.json.resource_id as string;
  };

  it('registers its policy through the seam of the API and the public edition keeps the routing policy as it is', async () => {
    clearEnterpriseAiPolicy();
    expect(aiEditionPolicy()).toBe(PUBLIC_AI_POLICY);
    await loadEnterpriseManifest();
    expect(aiEditionPolicy()).toMatchObject({ externalRouting: 'EXCEPTION_REQUIRED', attestationRequired: true });
    expect((await world.call('GET', '/ai/edition-policy', { member: PROVIDER_ADMIN })).json).toEqual({ name: aiEditionPolicy().name, external_routing: 'EXCEPTION_REQUIRED', attestation_required: true });
    clearEnterpriseAiPolicy();
    expect((await world.call('GET', '/ai/edition-policy', { member: PROVIDER_ADMIN })).json).toMatchObject({ external_routing: 'ALLOWED', attestation_required: false });
    // With no policy of the edition a request goes to the domestic provider as the routing policy allows.
    answer('dom-model');
    expect((await ask()).json).toMatchObject({ status: 'COMPLETED', route_class: 'DOMESTIC_HOSTED' });
  });

  it('KT.02: refuses a request that the routes would send to an external provider while no exception stands, keeps it as a refused request, and calls no model', async () => {
    const reply = await ask();
    expect(reply).toMatchObject({ status: 422, json: { code: 'AI_EXTERNAL_EXCEPTION_REQUIRED' } });
    expect(world.gateway.calls).toHaveLength(0);
    expect(await world.rows<{ status: string; reject_code: string }>('select status, reject_code from machvon.ai_request')).toEqual([{ status: 'REJECTED_POLICY', reject_code: 'AI_EXTERNAL_EXCEPTION_REQUIRED' }]);
    expect(await world.rows<{ status: string; refusal_code: string }>('select status, refusal_code from machvon.ai_assist_run')).toEqual([{ status: 'REFUSED', refusal_code: 'AI_EXTERNAL_EXCEPTION_REQUIRED' }]);
    expect(await world.rows('select 1 from machvon.ai_external_exception_use')).toHaveLength(0);
  });

  it('serves the request on the self-hosted model without an exception, and prefers it to the external one', async () => {
    await world.reset();
    await world.seedRegistry({ withSelfHosted: true });
    answer('self-model');
    const reply = await ask();
    expect(reply.json).toMatchObject({ status: 'COMPLETED', route_class: 'SELF_HOSTED' });
    expect(world.gateway.calls.map((call) => [call.providerModelId, call.route])).toEqual([['self-model', 'SELF_HOSTED']]);
    // The external model is not a fallback either: a self-hosted model that fails ends the request, it is not sent on.
    world.gateway.clear();
    world.gateway.script('self-model', [{ fail: 'PROVIDER_ERROR' }]);
    expect(await ask()).toMatchObject({ status: 200, json: { status: 'FAILED' } });
    expect(world.gateway.calls.map((call) => call.providerModelId)).toEqual(['self-model']);
  });

  it('serves the request under an approved exception and logs the use: the exception, the request, the class and the route, and the trail', async () => {
    const exceptionId = await approved(world.providers.domestic);
    answer('dom-model');
    const reply = await ask();
    expect(reply.json).toMatchObject({ status: 'COMPLETED', route_class: 'DOMESTIC_HOSTED' });
    const uses = await world.rows<{ exception_id: string; data_classification: string; route_class: string; task_type: string }>('select exception_id, data_classification, route_class, task_type from machvon.ai_external_exception_use');
    expect(uses).toEqual([{ exception_id: exceptionId, data_classification: 'INTERNAL', route_class: 'DOMESTIC_HOSTED', task_type: 'AI_ASSIST_QA' }]);
    const audit = await world.rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'llm.external_exception_used'");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.safe_diff).toMatchObject({ provider_id: world.providers.domestic, route_class: 'DOMESTIC_HOSTED', data_classification: 'INTERNAL' });
    const shown = await world.call('GET', `/ai/external-exceptions/${exceptionId}`, { member: EXCEPTION_ASKER });
    expect(shown.json).toMatchObject({ status: 'APPROVED', in_force: true, use_count: 1, approval_ref: 'DEC-2026-114', requested_valid_days: 7 });
    expect(asObjects(shown.json.uses)).toHaveLength(1);
    // The log cannot be rewritten.
    await expect(world.rows('delete from machvon.ai_external_exception_use')).rejects.toThrow(/append-only/);
  });

  it.each([
    ['for another task', { task_type: 'AI_ASSIST_DOC_REVIEW' }],
    ['for a lower class of data than the request carries', { max_classification: 'PUBLIC' }],
  ])('does not take an exception %s', async (_name, extra) => {
    await approved(world.providers.domestic, extra);
    expect(await ask()).toMatchObject({ status: 422, json: { code: 'AI_EXTERNAL_EXCEPTION_REQUIRED' } });
    expect(world.gateway.calls).toHaveLength(0);
  });

  it('does not take an exception that was revoked or that has run out', async () => {
    const revoked = await approved(world.providers.domestic);
    const revocation = await world.call('POST', `/ai/external-exceptions/${revoked}/revocation`, { member: EXCEPTION_DECIDER, ifMatch: '"2"', body: { reason: 'The provider changed its terms of use.' } });
    expect(revocation).toMatchObject({ status: 200, json: { status: 'REVOKED' } });
    expect(await ask()).toMatchObject({ status: 422, json: { code: 'AI_EXTERNAL_EXCEPTION_REQUIRED' } });
    expect(await world.call('POST', `/ai/external-exceptions/${revoked}/revocation`, { member: EXCEPTION_DECIDER, ifMatch: '"3"', body: { reason: 'Revoked a second time.' } })).toMatchObject({ status: 409 });
    // An exception that ends by its date: the database moves its dates back as the owner of the data (nothing in the API can).
    const expired = await approved(world.providers.domestic);
    await world.harness.owner(TENANT_A, [['alter table machvon.ai_external_exception disable trigger ai_external_exception_guard'], ["update machvon.ai_external_exception set valid_from = now() - interval '10 days', valid_until = now() - interval '1 day' where id = $1::uuid", [expired]], ['alter table machvon.ai_external_exception enable trigger ai_external_exception_guard']]);
    expect(await ask()).toMatchObject({ status: 422, json: { code: 'AI_EXTERNAL_EXCEPTION_REQUIRED' } });
    expect(world.gateway.calls).toHaveLength(0);
  });

  it('asks two people, for a reason, for at most ninety days, and keeps the history', async () => {
    expect(await request(world.providers.domestic, { valid_days: 91 })).toMatchObject({ status: 400 });
    expect(await request(world.providers.domestic, { reason: 'Too short.' })).toMatchObject({ status: 400 });
    expect(await request(randomUUID())).toMatchObject({ status: 404 });
    const made = await request(world.providers.domestic);
    expect(made).toMatchObject({ status: 200, json: { status: 'REQUESTED', resource_version: 1 } });
    const id = made.json.resource_id as string;
    expect(await request(world.providers.domestic)).toMatchObject({ status: 409, json: { code: 'EXCEPTION_REQUEST_OPEN' } });
    // The person who asked is not the person who decides.
    expect(await decide(id, 1, { decision: 'APPROVE', approval_ref: 'DEC-1' }, EXCEPTION_ASKER)).toMatchObject({ status: 403 });
    expect(await decide(id, 1, { decision: 'APPROVE' })).toMatchObject({ status: 422 });
    expect(await decide(id, 1, { decision: 'REJECT', note: 'Use the model of the customer.' })).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
    expect(await decide(id, 2, { decision: 'APPROVE', approval_ref: 'DEC-2' })).toMatchObject({ status: 409, json: { code: 'STAGE_TRANSITION_DENIED' } });
    const listed = await world.call('GET', '/ai/external-exceptions?status=REJECTED', { member: EXCEPTION_ASKER });
    expect(asObjects(listed.json.items).map((item) => [item.id, item.status, item.in_force])).toEqual([[id, 'REJECTED', false]]);
    // A self-hosted provider needs no exception.
    await world.reset();
    await world.seedRegistry({ withSelfHosted: true });
    expect(await request(world.providers.selfHosted)).toMatchObject({ status: 422 });
    // The database holds the same rules: nobody can write an approval by the person who asked.
    await expect(world.harness.owner(TENANT_A, [["update machvon.ai_external_exception set status = 'APPROVED' where false"], ["insert into machvon.ai_external_exception (tenant_id, id, provider_id, max_classification, reason, requested_by, requested_valid_days, status, decided_by, decided_at, valid_from, valid_until, approval_ref) values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, 'PUBLIC', 'A reason that is long enough to pass.', $2::uuid, 5, 'APPROVED', $2::uuid, now(), now(), now() + interval '5 days', 'REF-1')", [world.providers.selfHosted, '00000000-0000-4000-8000-000000000020']]])).rejects.toThrow(/ai_external_exception_maker_checker_chk/);
  });

  it('records the attestation of a provider and activates an external one only after it is on record', async () => {
    const provider = randomUUID();
    await world.rows(
      `insert into machvon.ai_provider (tenant_id, id, provider_code, name, region_country, route_class, max_classification, status, created_by, updated_by)
       values ($1, $2, 'VN-NEW', 'VN-NEW', 'VN', 'DOMESTIC_HOSTED', 'INTERNAL', 'PROPOSED', $3, $3)`,
      [TENANT_A, provider, '00000000-0000-4000-8000-000000000f0f'],
    );
    const activate = (): Promise<Reply> => world.call('POST', `/ai-providers/${provider}/activation`, { member: PROVIDER_APPROVER, ifMatch: '"1"', body: {} });
    expect(await activate()).toMatchObject({ status: 409, json: { code: 'PROVIDER_ATTESTATION_REQUIRED' } });
    const attestation = { data_location_country: 'VN', data_location_detail: 'Data hall 2, Ho Chi Minh City', no_training_attested: true, attestation_ref: 'DPA-2026-07 clause 9' };
    expect(await world.call('POST', `/ai-providers/${provider}/attestation`, { member: PROVIDER_ADMIN, ifMatch: '"7"', body: attestation })).toMatchObject({ status: 409 });
    expect(await world.call('POST', `/ai-providers/${provider}/attestation`, { member: PROVIDER_ADMIN, ifMatch: '"1"', body: { ...attestation, data_location_country: 'vn' } })).toMatchObject({ status: 400 });
    expect(await world.call('POST', `/ai-providers/${provider}/attestation`, { member: PROVIDER_ADMIN, ifMatch: '"1"', body: attestation })).toMatchObject({ status: 200, json: { status: 'ATTESTED', resource_version: 2 } });
    const listed = await world.call('GET', '/ai-providers', { member: PROVIDER_ADMIN });
    expect(asObjects(listed.json.items).find((item) => item.id === provider)).toMatchObject({ data_location_country: 'VN', no_training_attested: true, attestation_ref: 'DPA-2026-07 clause 9', attested_by: expect.any(String) });
    expect(await world.call('POST', `/ai-providers/${provider}/activation`, { member: PROVIDER_APPROVER, ifMatch: '"2"', body: {} })).toMatchObject({ status: 200, json: { status: 'ACTIVE' } });
    // The database refuses a flag of no-training without the country, the paper and the person.
    await expect(world.rows('update machvon.ai_provider set no_training_attested = true, attestation_ref = null where id = $1::uuid', [provider])).rejects.toThrow(/ai_provider_no_training_chk/);
    const trail = await world.rows<{ safe_diff: Record<string, unknown> }>("select safe_diff from machvon.audit_event where action = 'llm.provider_attested'");
    expect(trail[0]?.safe_diff).toMatchObject({ to_data_location_country: 'VN', to_no_training_attested: true });
  });
});
