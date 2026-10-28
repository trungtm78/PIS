import { randomUUID } from 'node:crypto';
import { AI_ADMIN, DUAL, LlmApp, NOBODY, READER, SCOPED, SECURITY, SECURITY_TWO, TENANT_A, TENANT_B, memberId } from './llm-app';
import type { Reply } from './llm-app';

const app = new LlmApp();
jest.setTimeout(240_000);

beforeAll(() => app.start());
afterAll(() => app.stop());
let since = new Date();
beforeEach(async () => {
  await app.reset();
  since = new Date();
});

const COMPLIANT = { PUBLIC: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], INTERNAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], CONFIDENTIAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], PERSONAL: ['DOMESTIC_HOSTED', 'SELF_HOSTED'], IMPORTANT_CORE: ['SELF_HOSTED'] };
const WITH_INTERNATIONAL = { ...COMPLIANT, PUBLIC: ['DOMESTIC_HOSTED', 'SELF_HOSTED', 'INTERNATIONAL'] };
const LONG_AGO = '2026-01-01T00:00:00.000Z';

const etag = (reply: Reply): string => `"${String(reply.json.resource_version ?? reply.json.version)}"`;
const registerProvider = (body: Record<string, unknown>, member = AI_ADMIN, tenantId?: string): Promise<Reply> =>
  app.call('POST', '/ai-providers', { member, body: { name: 'Provider', region_country: 'VN', route_class: 'DOMESTIC_HOSTED', max_classification: 'INTERNAL', ...body }, ...(tenantId === undefined ? {} : { tenantId }) });
const activate = (id: string, version: string, body: Record<string, unknown> = {}, member = SECURITY): Promise<Reply> =>
  app.call('POST', `/ai-providers/${id}/activation`, { member, ifMatch: version, body });
const draftPolicy = (body: Record<string, unknown> = {}, member = AI_ADMIN): Promise<Reply> =>
  app.call('POST', '/ai-classification-policies', { member, body: { matrix: COMPLIANT, international_enabled: false, legal_basis: 'Luat 2026', effective_from: LONG_AGO, ...body } });
const publish = (id: string, version: string, member = SECURITY): Promise<Reply> => app.call('POST', `/ai-classification-policies/${id}/publish`, { member, ifMatch: version, body: {} });
const audits = (action: string) => app.rows<{ outcome: string; safe_diff: Record<string, unknown> }>('select outcome, safe_diff from machvon.audit_event where action = $1 and occurred_at >= $2 order by occurred_at', [action, since]);
const events = (type: string) => app.rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where type = $1 and created_at >= $2 order by created_at', [type, since]);

describe('the registry of providers and models and the classification policy (ST-LLM-001, LLM F2)', () => {
  describe('providers', () => {
    it('AC-ST-LLM-001-1: UAT-AC457 refuses an international provider that takes more than public data, the activation without D07, and the policy that turns international on without it', async () => {
      const refused = await registerProvider({ provider_code: 'INTL-1', region_country: 'US', route_class: 'INTERNATIONAL', max_classification: 'INTERNAL' });
      expect([refused.status, refused.json.code]).toEqual([422, 'INTERNATIONAL_CLASSIFICATION_NOT_ALLOWED']);
      expect((await app.rows('select 1 from machvon.ai_provider')).length).toBe(0);

      const declared = await registerProvider({ provider_code: 'INTL-1', region_country: 'US', route_class: 'INTERNATIONAL', max_classification: 'PUBLIC' });
      expect(declared.status).toBe(200);
      const id = declared.json.resource_id as string;
      const noApproval = await activate(id, etag(declared));
      expect([noApproval.status, noApproval.json.code]).toEqual([422, 'D07_APPROVAL_REQUIRED']);
      expect((await app.rows<{ status: string }>('select status from machvon.ai_provider where id = $1', [id]))[0]?.status).toBe('PROPOSED');

      const policy = await draftPolicy({ matrix: WITH_INTERNATIONAL, international_enabled: true });
      expect([policy.status, policy.json.code]).toEqual([422, 'D07_APPROVAL_REQUIRED']);
      expect((await app.rows('select 1 from machvon.ai_classification_policy_version')).length).toBe(0);

      // The database says the same to a write that skips the service.
      await expect(app.rows(`insert into machvon.ai_provider (tenant_id, id, provider_code, name, region_country, route_class, max_classification, status, created_by, updated_by) values ($1, $2, 'DIRECT', 'x', 'US', 'INTERNATIONAL', 'INTERNAL', 'PROPOSED', $3, $3)`, [TENANT_A, randomUUID(), memberId(AI_ADMIN)])).rejects.toThrow(/ai_provider_intl_chk/);
      await expect(app.rows(`insert into machvon.ai_provider (tenant_id, id, provider_code, name, region_country, route_class, max_classification, status, created_by, updated_by) values ($1, $2, 'DIRECT', 'x', 'US', 'INTERNATIONAL', 'PUBLIC', 'ACTIVE', $3, $3)`, [TENANT_A, randomUUID(), memberId(AI_ADMIN)])).rejects.toThrow(/ai_provider_intl_chk/);
      await expect(app.rows(`insert into machvon.ai_provider (tenant_id, id, provider_code, name, region_country, route_class, max_classification, status, created_by, updated_by) values ($1, $2, 'DIRECT', 'x', 'US', 'DOMESTIC_HOSTED', 'PUBLIC', 'PROPOSED', $3, $3)`, [TENANT_A, randomUUID(), memberId(AI_ADMIN)])).rejects.toThrow(/ai_provider_vn_chk/);
    });

    it('activates an international provider with D07 by another person, and a provider that takes more than public data with its data agreement, and not by the person who registered it', async () => {
      const intl = await registerProvider({ provider_code: 'INTL-1', region_country: 'US', route_class: 'INTERNATIONAL', max_classification: 'PUBLIC' });
      const own = await activate(intl.json.resource_id as string, etag(intl), { d07_approval_ref: 'D07-2026-01' }, AI_ADMIN);
      // The administrator holds no right to approve: the guard answers before the rule does.
      expect(own.status).toBe(403);
      const dual = await registerProvider({ provider_code: 'SEC-1', route_class: 'DOMESTIC_HOSTED', max_classification: 'PUBLIC' }, DUAL);
      const self = await activate(dual.json.resource_id as string, etag(dual), {}, DUAL);
      expect([self.status, self.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);

      const done = await activate(intl.json.resource_id as string, etag(intl), { d07_approval_ref: 'D07-2026-01' });
      expect([done.status, done.json.status]).toEqual([200, 'ACTIVE']);
      const stored = (await app.rows<{ status: string; d07_approval_ref: string; approved_by: string }>('select status, d07_approval_ref, approved_by from machvon.ai_provider where id = $1', [intl.json.resource_id]))[0];
      expect(stored).toMatchObject({ status: 'ACTIVE', d07_approval_ref: 'D07-2026-01', approved_by: memberId(SECURITY) });
      expect((await audits('llm.provider_activated')).length).toBe(1);
      expect((await events('llm.provider.activated.v1'))[0]?.payload).toMatchObject({ provider_code: 'INTL-1', route_class: 'INTERNATIONAL' });

      // More than public data needs the data agreement; one that is not a document of the tenant is not accepted.
      const confidential = await registerProvider({ provider_code: 'VN-1', route_class: 'DOMESTIC_HOSTED', max_classification: 'CONFIDENTIAL' });
      const missing = await activate(confidential.json.resource_id as string, etag(confidential));
      expect([missing.status, missing.json.code]).toEqual([422, 'DATA_AGREEMENT_REQUIRED']);
      const stranger = await registerProvider({ provider_code: 'VN-2', route_class: 'DOMESTIC_HOSTED', max_classification: 'CONFIDENTIAL', data_agreement_document_id: randomUUID() });
      expect([stranger.status, stranger.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const document = randomUUID();
      await app.seedReplica([[`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'HD', 'DPA', 'INTERNAL', $3, $3)`, [TENANT_A, document, memberId(AI_ADMIN)]]]);
      const agreed = await registerProvider({ provider_code: 'VN-3', route_class: 'DOMESTIC_HOSTED', max_classification: 'CONFIDENTIAL', data_agreement_document_id: document });
      expect((await activate(agreed.json.resource_id as string, etag(agreed))).status).toBe(200);
    });

    it('refuses a duplicate code, a stale version, an activation of what is not proposed, and a domestic provider outside Viet Nam', async () => {
      const first = await registerProvider({ provider_code: 'VN-1', max_classification: 'PUBLIC' });
      expect(first.status).toBe(200);
      const duplicate = await registerProvider({ provider_code: 'VN-1', max_classification: 'PUBLIC' });
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'PROVIDER_CODE_DUPLICATE']);
      const abroad = await registerProvider({ provider_code: 'VN-9', region_country: 'SG', max_classification: 'PUBLIC' });
      expect([abroad.status, abroad.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const id = first.json.resource_id as string;
      const stale = await activate(id, '"9"');
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const done = await activate(id, etag(first));
      expect(done.status).toBe(200);
      const again = await activate(id, etag(done));
      expect([again.status, again.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      const unknown = await activate(randomUUID(), '"1"');
      expect(unknown.status).toBe(404);
    });

    it('takes two registrations of one code at once in turn: one is registered and the other is told it is a duplicate, not a server error', async () => {
      const body = { provider_code: 'RACE-1', max_classification: 'PUBLIC' };
      const replies = await Promise.all([registerProvider(body), registerProvider(body), registerProvider(body)]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409, 409]);
      expect(replies.filter((reply) => reply.status === 409).every((reply) => reply.json.code === 'PROVIDER_CODE_DUPLICATE')).toBe(true);
      expect((await app.rows('select 1 from machvon.ai_provider where provider_code = $1', ['RACE-1'])).length).toBe(1);
    });

    it('registers once under one idempotency key and leaves a trail', async () => {
      const key = `provider-${randomUUID()}`;
      const body = { provider_code: 'VN-1', name: 'Provider', region_country: 'VN', route_class: 'DOMESTIC_HOSTED', max_classification: 'PUBLIC' };
      const before = [(await audits('llm.provider_registered')).length, (await events('llm.provider.registered.v1')).length];
      const [a, b] = [await app.call('POST', '/ai-providers', { member: AI_ADMIN, key, body }), await app.call('POST', '/ai-providers', { member: AI_ADMIN, key, body })];
      expect([a.status, b.status, a.json.resource_id === b.json.resource_id]).toEqual([200, 200, true]);
      expect((await app.rows('select 1 from machvon.ai_provider')).length).toBe(1);
      expect([(await audits('llm.provider_registered')).length - before[0]!, (await events('llm.provider.registered.v1')).length - before[1]!]).toEqual([1, 1]);
    });
  });

  describe('models', () => {
    const provider = async (code = 'VN-1', max = 'CONFIDENTIAL'): Promise<string> => (await registerProvider({ provider_code: code, max_classification: max })).json.resource_id as string;
    const model = (providerId: string, body: Record<string, unknown> = {}): Promise<Reply> =>
      app.call('POST', '/ai-models', { member: AI_ADMIN, body: { provider_id: providerId, model_id: 'llm-small', model_version: '1', capabilities: { json_schema: true }, context_window: 8000, max_output: 1000, max_classification: 'INTERNAL', ...body } });

    it('registers a model as PROPOSED, and refuses one above its provider, a duplicate (with or without a version) and a window that cannot hold the output', async () => {
      const providerId = await provider();
      const created = await model(providerId);
      expect([created.status, created.json.status]).toEqual([200, 'PROPOSED']);
      expect((await model(providerId, { max_classification: 'PERSONAL' })).json.code).toBe('CLASSIFICATION_ABOVE_PROVIDER');
      const duplicate = await model(providerId);
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'MODEL_DUPLICATE']);
      expect((await model(providerId, { model_version: '2' })).status).toBe(200);
      // A model with no version is one model, not as many as were sent.
      const bare = await model(providerId, { model_id: 'llm-bare', model_version: undefined });
      expect(bare.status).toBe(200);
      expect((await model(providerId, { model_id: 'llm-bare', model_version: undefined })).json.code).toBe('MODEL_DUPLICATE');
      await expect(app.rows(`insert into machvon.ai_model (tenant_id, id, provider_id, model_id, capabilities, context_window, max_output, max_classification, created_by, updated_by) values ($1, $2, $3, 'llm-bare', '{}'::jsonb, 10, 5, 'PUBLIC', $4, $4)`, [TENANT_A, randomUUID(), providerId, memberId(AI_ADMIN)])).rejects.toThrow(/ai_model_unversioned_uq/);
      expect((await model(providerId, { model_id: 'llm-big', max_output: 9000, context_window: 8000 })).json.code).toBe('VALIDATION_FAILED');
      expect((await model(randomUUID())).status).toBe(404);
      expect((await events('llm.model.registered.v1')).length).toBe(3);
    });

    it('lists the models of a provider and refuses a malformed filter', async () => {
      const [one, two] = [await provider('VN-1'), await provider('VN-2')];
      await model(one);
      await model(two, { model_id: 'llm-other' });
      const all = await app.call('GET', '/ai-models', { member: READER });
      expect((all.json.items as unknown[]).length).toBe(2);
      const mine = await app.call('GET', `/ai-models?provider_id=${one}`, { member: READER });
      expect((mine.json.items as Array<{ provider_id: string }>).map((item) => item.provider_id)).toEqual([one]);
      expect((await app.call('GET', '/ai-models?provider_id=x', { member: READER })).status).toBe(422);
    });
  });

  describe('the classification policy', () => {
    it('AC-ST-LLM-001-2: UAT-AC458 refuses to publish a draft that drops the line of important data or lets internal data go international, and publishes a compliant one so that exactly one stays PUBLISHED', async () => {
      const { IMPORTANT_CORE: dropped, ...withoutCore } = COMPLIANT;
      void dropped;
      const drafts = [
        await draftPolicy({ matrix: withoutCore }),
        await draftPolicy({ matrix: { ...COMPLIANT, IMPORTANT_CORE: ['DOMESTIC_HOSTED', 'SELF_HOSTED'] } }),
        await draftPolicy({ matrix: { ...WITH_INTERNATIONAL, INTERNAL: ['DOMESTIC_HOSTED', 'INTERNATIONAL'] }, international_enabled: true, d07_approval_ref: 'D07-1' }),
      ];
      expect(drafts.map((draft) => draft.status)).toEqual([200, 200, 200]);
      const weak = await publish(drafts[0]!.json.resource_id as string, etag(drafts[0]!));
      expect([weak.status, weak.json.code]).toEqual([422, 'POLICY_WEAKENS_BASELINE']);
      expect((await publish(drafts[1]!.json.resource_id as string, etag(drafts[1]!))).json.code).toBe('POLICY_WEAKENS_BASELINE');
      const intl = await publish(drafts[2]!.json.resource_id as string, etag(drafts[2]!));
      expect([intl.status, intl.json.code]).toEqual([422, 'POLICY_WEAKENS_BASELINE']);
      expect((await app.rows('select 1 from machvon.ai_classification_policy_version where status = $1', ['PUBLISHED'])).length).toBe(0);

      const good = await draftPolicy();
      const own = await publish(good.json.resource_id as string, etag(good), AI_ADMIN);
      expect(own.status).toBe(403);
      const ok = await publish(good.json.resource_id as string, etag(good));
      expect([ok.status, ok.json.status]).toEqual([200, 'PUBLISHED']);

      // The next one takes its place: the one that was PUBLISHED is SUPERSEDED, and there is one.
      const next = await draftPolicy({ matrix: WITH_INTERNATIONAL, international_enabled: true, d07_approval_ref: 'D07-2026-01' });
      expect((await publish(next.json.resource_id as string, etag(next))).status).toBe(200);
      const states = await app.rows<{ revision: number; status: string }>('select revision, status from machvon.ai_classification_policy_version where revision > 3 order by revision');
      expect(states).toEqual([
        { revision: 4, status: 'SUPERSEDED' },
        { revision: 5, status: 'PUBLISHED' },
      ]);
      expect((await app.rows('select 1 from machvon.ai_classification_policy_version where status = $1', ['PUBLISHED'])).length).toBe(1);
      const trail = await audits('llm.policy_published');
      expect(trail.map((entry) => entry.safe_diff.superseded_policy_id)).toEqual([null, good.json.resource_id]);
      expect((await events('llm.policy.published.v1')).length).toBe(2);
    });

    it('keeps the baseline in the database too: a published policy that is wider than it cannot be written by any path', async () => {
      const insert = (matrix: unknown, international: boolean, revision: number) =>
        app.rows(
          `insert into machvon.ai_classification_policy_version (tenant_id, id, revision, matrix_json, international_enabled, d07_approval_ref, legal_basis, effective_from, status, approved_by, created_by, updated_by)
           values ($1, $2, $3, $4::jsonb, $5, 'D07-1', 'x', now(), 'PUBLISHED', $6, $7, $7)`,
          [TENANT_A, randomUUID(), revision, JSON.stringify(matrix), international, memberId(SECURITY), memberId(AI_ADMIN)],
        );
      const { IMPORTANT_CORE: dropped, ...withoutCore } = COMPLIANT;
      void dropped;
      for (const [index, matrix] of [
        withoutCore,
        { ...COMPLIANT, INTERNAL: ['INTERNATIONAL'] },
        { ...COMPLIANT, IMPORTANT_CORE: ['DOMESTIC_HOSTED', 'SELF_HOSTED'] },
        { ...COMPLIANT, PERSONAL: 'INTERNATIONAL' },
      ].entries()) {
        await expect(insert(matrix, true, index + 1)).rejects.toThrow(/ai_classification_policy_version_baseline_chk/);
      }
      // The international route in the matrix needs the tenant to have it on.
      await expect(insert(WITH_INTERNATIONAL, false, 9)).rejects.toThrow(/ai_classification_policy_version_baseline_chk/);
      await expect(insert(COMPLIANT, false, 10)).resolves.toBeDefined();
      // A published policy does not approve itself, whatever wrote it.
      await expect(app.rows(`update machvon.ai_classification_policy_version set approved_by = created_by where revision = 10`)).rejects.toThrow(/sod_chk/);
    });

    it('refuses a matrix that is not one, an unknown level, a bad date, and a stale version, and publishes nothing before its date', async () => {
      for (const matrix of [{ ...COMPLIANT, SECRET: ['SELF_HOSTED'] }, { ...COMPLIANT, INTERNAL: ['MOON'] }, { ...COMPLIANT, INTERNAL: 'SELF_HOSTED' }, { ...COMPLIANT, INTERNAL: ['SELF_HOSTED', 'SELF_HOSTED'] }, { ...WITH_INTERNATIONAL }]) {
        const reply = await draftPolicy({ matrix });
        expect([reply.status, reply.json.code]).toEqual([422, 'POLICY_MATRIX_INVALID']);
      }
      expect((await draftPolicy({ effective_from: 'tomorrow' })).status).toBe(422);
      const later = await draftPolicy({ effective_from: '2999-01-01T00:00:00.000Z' });
      const early = await publish(later.json.resource_id as string, etag(later));
      expect([early.status, early.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      const good = await draftPolicy();
      const stale = await publish(good.json.resource_id as string, '"7"');
      expect([stale.status, stale.json.code]).toEqual([409, 'VERSION_CONFLICT']);
      const done = await publish(good.json.resource_id as string, etag(good));
      expect(done.status).toBe(200);
      const again = await publish(good.json.resource_id as string, etag(done));
      expect([again.status, again.json.code]).toEqual([409, 'STAGE_TRANSITION_DENIED']);
      expect((await publish(randomUUID(), '"1"')).status).toBe(404);
    });

    it('lists the revisions with the baseline and the policy in force', async () => {
      const empty = await app.call('GET', '/ai-classification-policies', { member: READER });
      expect(empty.json).toMatchObject({ items: [], in_force_policy_id: null, baseline_matrix: { IMPORTANT_CORE: ['SELF_HOSTED'] } });
      const draft = await draftPolicy();
      const published = await publish(draft.json.resource_id as string, etag(draft));
      const listed = await app.call('GET', '/ai-classification-policies', { member: READER });
      expect(listed.json.in_force_policy_id).toBe(published.json.resource_id);
      expect((listed.json.items as Array<{ revision: number; status: string }>).map((item) => [item.revision, item.status])).toEqual([[1, 'PUBLISHED']]);
    });

    it('takes two publications at once in turn: one policy stays PUBLISHED', async () => {
      const [a, b] = [await draftPolicy(), await draftPolicy()];
      const [first, second] = await Promise.all([publish(a.json.resource_id as string, etag(a)), publish(b.json.resource_id as string, etag(b), SECURITY_TWO)]);
      expect([first.status, second.status]).toEqual([200, 200]);
      expect((await app.rows('select 1 from machvon.ai_classification_policy_version where status = $1', ['PUBLISHED'])).length).toBe(1);
      expect((await app.rows('select 1 from machvon.ai_classification_policy_version where status = $1', ['SUPERSEDED'])).length).toBe(1);
      // The record of each change names the policy that really gave way, whichever got the lock first.
      const trail = await audits('llm.policy_published');
      const published = await app.rows<{ id: string }>("select id from machvon.ai_classification_policy_version where status = 'PUBLISHED'");
      const superseded = await app.rows<{ id: string }>("select id from machvon.ai_classification_policy_version where status = 'SUPERSEDED'");
      expect(trail.map((entry) => entry.safe_diff.superseded_policy_id)).toEqual([null, superseded[0]?.id]);
      expect(published[0]?.id).not.toBe(superseded[0]?.id);
      const sent = (await events('llm.policy.published.v1')).map((event) => event.payload.superseded_policy_id);
      expect(sent).toEqual([null, superseded[0]?.id]);
    });
  });

  describe('rights and tenants', () => {
    it('is the tenant\'s: the holder of the rights over one unit, the reader on a command and the person with no grant are refused, and one tenant sees nothing of another', async () => {
      const body = { provider_code: 'VN-1', name: 'Provider', region_country: 'VN', route_class: 'DOMESTIC_HOSTED', max_classification: 'PUBLIC' };
      for (const member of [SCOPED, READER, NOBODY]) {
        const reply = await app.call('POST', '/ai-providers', { member, body });
        expect([member, reply.status]).toEqual([member, 403]);
      }
      expect((await app.call('POST', '/ai-classification-policies', { member: SCOPED, body: { matrix: COMPLIANT, international_enabled: false, legal_basis: 'Luat 2026', effective_from: LONG_AGO } })).status).toBe(403);
      for (const url of ['/ai-providers', '/ai-models', '/ai-classification-policies']) {
        expect((await app.call('GET', url, { member: SCOPED })).status).toBe(403);
        expect((await app.call('GET', url, { member: NOBODY })).status).toBe(403);
      }
      const mine = await registerProvider({ provider_code: 'VN-1', max_classification: 'PUBLIC' });
      expect(mine.status).toBe(200);
      const theirs = await app.call('GET', '/ai-providers', { member: AI_ADMIN, tenantId: TENANT_B });
      expect(theirs.json.items).toEqual([]);
      // The same code in another tenant is another provider.
      expect((await registerProvider({ provider_code: 'VN-1', max_classification: 'PUBLIC' }, AI_ADMIN, TENANT_B)).status).toBe(200);
      const foreign = await activate(mine.json.resource_id as string, etag(mine));
      expect(foreign.status).toBe(200);
      const crossed = await app.call('POST', `/ai-providers/${mine.json.resource_id as string}/activation`, { member: AI_ADMIN, tenantId: TENANT_B, ifMatch: '"1"', body: {} });
      expect(crossed.status).toBe(403);
    });

    it('refuses a field the contract does not name, and lists providers for a reader', async () => {
      const extra = await registerProvider({ provider_code: 'VN-1', max_classification: 'PUBLIC', status: 'ACTIVE' });
      expect([extra.status, extra.json.code]).toEqual([400, 'FIELD_NOT_ALLOWED']);
      await registerProvider({ provider_code: 'VN-1', max_classification: 'PUBLIC' });
      const listed = await app.call('GET', '/ai-providers', { member: READER });
      expect((listed.json.items as Array<Record<string, unknown>>).map((item) => [item.provider_code, item.status])).toEqual([['VN-1', 'PROPOSED']]);
    });
  });
});
