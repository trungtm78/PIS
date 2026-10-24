import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { RetentionPoliciesController } from '../../src/modules/adm/retention-policy.controller';
import { ADM_CLOCK } from '../../src/modules/adm/tokens';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const MANAGER = 1; // adm.retention.manage
const APPROVER = 2; // adm.retention.approve
const BOTH = 3; // adm.retention.manage and adm.retention.approve
const SUBTREE_MANAGER = 4; // adm.retention.manage on the subtree of unit 2 only
const NOBODY = 5;
const OTHER_TENANT_MANAGER = 1; // of tenant B
const NOW = new Date('2026-10-24T08:00:00.000Z');

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('retention policy versions (ST-ADM-017, ADM-12)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function post(url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json', 'idempotency-key': options.key ?? `key-${randomUUID()}` };
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method: 'POST', headers, body: JSON.stringify(options.body ?? {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const draftBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    record_class: 'project_dossier',
    retention_years: 10,
    retention_basis: 'FROM_CLOSED',
    legal_basis_ref: 'TT 10/2022/TT-BNV [CXN-RET-03]',
    end_action: 'REVIEW_FOR_DESTRUCTION',
    effective_from: '2026-01-01',
    ...overrides,
  });
  const create = (member: number, overrides: Record<string, unknown> = {}, extra: { tenantId?: string; key?: string } = {}): Promise<Reply> =>
    post('/retention-policies', { member, body: draftBody(overrides), ...extra });
  const publish = (member: number, policyId: string, version: number, reason = 'Approved by the records council'): Promise<Reply> =>
    post(`/retention-policies/${policyId}/publish`, { member, ifMatch: `"${version}"`, body: { reason } });
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const versionOf = (reply: Reply): number => reply.json.resource_version as number;

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }, { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 }]);
    for (const [member, unit] of [[MANAGER, 1], [APPROVER, 1], [BOTH, 1], [SUBTREE_MANAGER, 2], [NOBODY, 1]] as const) await harness.seedMembership(TENANT_A, member, unit);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_MANAGER, 1);
    await harness.seedRole(TENANT_A, 1, 'RETENTION_MANAGER', ['adm.retention.manage'], 40);
    await harness.seedRole(TENANT_A, 2, 'RETENTION_APPROVER', ['adm.retention.approve'], 40);
    await harness.seedRole(TENANT_A, 3, 'RETENTION_BOTH', ['adm.retention.manage', 'adm.retention.approve'], 50);
    await harness.seedRole(TENANT_B, 1, 'RETENTION_BOTH', ['adm.retention.manage', 'adm.retention.approve'], 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: APPROVER, role: 2, kind: 'TENANT' },
      { n: 3, member: BOTH, role: 3, kind: 'TENANT' },
      { n: 4, member: SUBTREE_MANAGER, role: 1, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_MANAGER, role: 1, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [RetentionPoliciesController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: ADM_CLOCK, useValue: () => NOW },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  describe('createRetentionPolicyVersion', () => {
    it('rejects AUTO_PURGE_TECHNICAL for a business class and PERMANENT with ten years with 422 RETENTION_POLICY_INVALID, naming the field (AC-ST-ADM-017-1, UAT-AC142)', async () => {
      const purge = await create(MANAGER, { end_action: 'AUTO_PURGE_TECHNICAL' });
      expect([purge.status, purge.json.code]).toEqual([422, 'RETENTION_POLICY_INVALID']);
      expect(purge.json.errors).toEqual([{ field: 'end_action', code: 'END_ACTION_NOT_ALLOWED', message: 'adm.retention.error.endAction' }]);
      const permanent = await create(MANAGER, { retention_basis: 'PERMANENT', retention_years: 10 });
      expect([permanent.status, permanent.json.code]).toEqual([422, 'RETENTION_POLICY_INVALID']);
      expect(permanent.json.errors).toEqual([{ field: 'retention_years', code: 'YEARS_NOT_ALLOWED', message: 'adm.retention.error.yearsNotAllowed' }]);
      expect(await rows('select 1 from machvon.data_retention_policy')).toEqual([]);
      expect(await rows("select 1 from machvon.audit_event where action = 'retention.draft_created'")).toEqual([]);
    });

    it('writes the draft as revision 1 and audits it; the next draft of the class replaces it and the audit row says which', async () => {
      const first = await create(MANAGER, { record_class: 'payment_dossier' });
      expect(first.status).toBe(201);
      expect(first.json).toMatchObject({ status: 'DRAFTED', resource_version: 1 });
      const second = await create(MANAGER, { record_class: 'payment_dossier', retention_years: 15 });
      const audits = await rows<{ resource_id: string; classification: string; safe_diff: Record<string, unknown> }>(
        "select resource_id, classification, safe_diff from machvon.audit_event where action = 'retention.draft_created' and safe_diff->>'record_class' = 'payment_dossier' order by occurred_at",
      );
      expect(audits.map((audit) => audit.resource_id)).toEqual([idOf(first), idOf(second)]);
      expect(audits[0]).toMatchObject({ classification: 'PUBLIC', safe_diff: { revision: 1, retention_years: 10, replaced_draft_id: null, legal_basis_ref: 'TT 10/2022/TT-BNV [CXN-RET-03]' } });
      expect(audits[1]?.safe_diff).toMatchObject({ revision: 2, retention_years: 15, replaced_draft_id: idOf(first) });
      expect(await rows<{ status: string }>("select status from machvon.data_retention_policy where id = $1", [idOf(first)])).toEqual([{ status: 'Superseded' }]);
    });

    it('is idempotent: the same key and body answer with the first draft and write no second revision', async () => {
      const key = `key-${randomUUID()}`;
      const first = await create(MANAGER, { record_class: 'report_revision' }, { key });
      const again = await create(MANAGER, { record_class: 'report_revision' }, { key });
      expect(again.json.resource_id).toBe(first.json.resource_id);
      expect(await rows('select 1 from machvon.data_retention_policy where record_class = $1', ['report_revision'])).toHaveLength(1);
    });

    it('is for a manager on the whole tenant: a subtree grant and a member with no grant are refused', async () => {
      const subtree = await create(SUBTREE_MANAGER, { record_class: 'contract_dossier' });
      expect([subtree.status, subtree.json.code]).toEqual([403, 'SCOPE_DENIED']);
      expect((await create(NOBODY, { record_class: 'contract_dossier' })).status).toBe(403);
      expect((await create(APPROVER, { record_class: 'contract_dossier' })).status).toBe(403);
    });

    it('refuses what the schema of the contract refuses', async () => {
      expect((await create(MANAGER, { retention_years: 0 })).status).toBe(422);
      expect((await create(MANAGER, { retention_basis: 'WHENEVER' })).status).toBe(422);
      expect((await create(MANAGER, { effective_from: 'tomorrow' })).status).toBe(422);
      expect((await create(MANAGER, { legal_basis_ref: 'x' })).status).toBe(422);
    });
  });

  describe('publishRetentionPolicy', () => {
    it('is published by someone other than the author, supersedes the version in force, audits with the reason and emits the event', async () => {
      const first = await create(MANAGER, { record_class: 'audit_event', retention_years: 10, retention_basis: 'FROM_CREATED', end_action: 'ARCHIVE_TRANSFER' });
      const done = await publish(APPROVER, idOf(first), versionOf(first));
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'PUBLISHED', resource_version: 2, resource_id: idOf(first) });
      expect(await rows<{ status: string; approved_by: string }>('select status, approved_by from machvon.data_retention_policy where id = $1', [idOf(first)])).toEqual([{ status: 'Published', approved_by: memberId(APPROVER) }]);

      const second = await create(MANAGER, { record_class: 'audit_event', retention_years: 12, retention_basis: 'FROM_CREATED', end_action: 'ARCHIVE_TRANSFER' });
      const next = await publish(APPROVER, idOf(second), versionOf(second), 'Raised to twelve years by the council');
      expect(next.status).toBe(200);
      expect(await rows<{ status: string }>('select status from machvon.data_retention_policy where id = $1', [idOf(first)])).toEqual([{ status: 'Superseded' }]);
      const [audit] = await rows<{ reason: string; safe_diff: Record<string, unknown> }>("select reason, safe_diff from machvon.audit_event where action = 'retention.published' and resource_id = $1", [idOf(second)]);
      expect(audit).toMatchObject({ reason: 'Raised to twelve years by the council', safe_diff: { record_class: 'audit_event', revision: 2, superseded_id: idOf(first) } });
      const [event] = await rows<{ type: string; payload: Record<string, unknown> }>("select type, payload from machvon.outbox_event where aggregate_id = $1 and type = 'adm.retention_policy.published.v1'", [idOf(second)]);
      expect(event).toMatchObject({ type: 'adm.retention_policy.published.v1', payload: { id: idOf(second), record_class: 'audit_event', revision: 2, superseded_id: idOf(first) } });
    });

    it('refuses the author who also holds the approval permission with 403 SELF_APPROVAL_DENIED and changes nothing (BR-ADM-01)', async () => {
      const draft = await create(BOTH, { record_class: 'contract_dossier' });
      const refused = await publish(BOTH, idOf(draft), versionOf(draft));
      expect([refused.status, refused.json.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
      expect(await rows<{ status: string }>('select status from machvon.data_retention_policy where id = $1', [idOf(draft)])).toEqual([{ status: 'Draft' }]);
      expect((await publish(APPROVER, idOf(draft), versionOf(draft))).status).toBe(200);
    });

    it('answers 409 VERSION_CONFLICT to a stale version, to a version already published and to a draft that a newer one replaced', async () => {
      const draft = await create(MANAGER, { record_class: 'user_session', retention_basis: 'FROM_CREATED', retention_years: 1, end_action: 'AUTO_PURGE_TECHNICAL' });
      expect((await publish(APPROVER, idOf(draft), 7)).json.code).toBe('VERSION_CONFLICT');
      const replacement = await create(MANAGER, { record_class: 'user_session', retention_basis: 'FROM_CREATED', retention_years: 2, end_action: 'AUTO_PURGE_TECHNICAL' });
      expect(await publish(APPROVER, idOf(draft), versionOf(draft))).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect((await publish(APPROVER, idOf(replacement), versionOf(replacement))).status).toBe(200);
      expect(await publish(APPROVER, idOf(replacement), 2)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    });

    it('waits for the day the version starts with 422 RETENTION_POLICY_INVALID', async () => {
      const draft = await create(MANAGER, { record_class: 'delivery_attempt', retention_basis: 'FROM_CREATED', retention_years: 1, end_action: 'AUTO_PURGE_TECHNICAL', effective_from: '2026-11-01' });
      const early = await publish(APPROVER, idOf(draft), versionOf(draft));
      expect([early.status, early.json.code]).toEqual([422, 'RETENTION_POLICY_INVALID']);
      expect(early.json.errors).toEqual([{ field: 'effective_from', code: 'DATE_FUTURE', message: 'adm.retention.error.dateFuture' }]);
    });

    it('needs the approval permission, and finds only a version of the own tenant', async () => {
      const draft = await create(MANAGER, { record_class: 'payment_dossier', retention_years: 20 });
      expect((await publish(MANAGER, idOf(draft), versionOf(draft))).status).toBe(403);
      expect((await publish(NOBODY, idOf(draft), versionOf(draft))).status).toBe(403);
      const missing = await post(`/retention-policies/${id(0x99, 1)}/publish`, { member: APPROVER, ifMatch: '"1"', body: { reason: 'Approved by the records council' } });
      expect([missing.status, missing.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect(await rows<{ status: string }>('select status from machvon.data_retention_policy where id = $1', [idOf(draft)])).toEqual([{ status: 'Draft' }]);
    });

    it('does not let the other tenant publish a draft it can name: it is not found there', async () => {
      const draft = await create(MANAGER, { record_class: 'report_revision', retention_years: 8 });
      const own = await create(OTHER_TENANT_MANAGER, { record_class: 'report_revision' }, { tenantId: TENANT_B });
      expect(own.status).toBe(201);
      const foreign = await post(`/retention-policies/${idOf(draft)}/publish`, { member: OTHER_TENANT_MANAGER, tenantId: TENANT_B, ifMatch: '"1"', body: { reason: 'Approved by the records council' } });
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    });
  });
});
