import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, InboxHandlerRegistry, IntegrationInboxProcessor, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { IntegrationConnectorsController } from '../../src/modules/adm/integration-connector.controller';
import { IntegrationInboxController } from '../../src/modules/adm/integration-inbox.controller';
import { ADM_ENVIRONMENT, ADM_INBOX_PROCESSOR } from '../../src/modules/adm/tokens';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const MANAGER = 1; // adm.integration.manage
const OPERATOR = 2; // adm.integration.operate
const SUBTREE_MANAGER = 3; // adm.integration.manage and operate on the subtree of unit 2 only
const NOBODY = 4;
const OTHER_TENANT_OWNER = 1; // of tenant B

interface Reply {
  status: number;
  json: Record<string, unknown>;
  text: string;
}

describe('integration connectors and the replay of the inbox (ST-ADM-018, ADM-09, ADM-10)', () => {
  const harness = new AuthzHarness();
  const registry = new InboxHandlerRegistry();
  const handled: string[] = [];
  let production: RunningApp;
  let staging: RunningApp;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function send(app: RunningApp, method: 'POST' | 'PUT', url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json', 'idempotency-key': options.key ?? `key-${randomUUID()}` };
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
  }

  const connectorBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    counter += 1;
    return { connector_code: `treasury-${counter}`, mode: 'FILE_IMPORT', adapter_status: 'PROPOSED', config: { directory: '/inbox' }, ...overrides };
  };
  const create = (member: number, overrides: Record<string, unknown> = {}, app = production, extra: { tenantId?: string; key?: string } = {}): Promise<Reply> =>
    send(app, 'POST', '/integration-connectors', { member, body: connectorBody(overrides), ...extra });
  const update = (member: number, connectorId: string, version: number, body: Record<string, unknown>, app = production, tenantId?: string): Promise<Reply> =>
    send(app, 'PUT', `/integration-connectors/${connectorId}`, { member, ifMatch: `"${version}"`, body: { reason: 'Changed by the integration administrator', ...body }, ...(tenantId === undefined ? {} : { tenantId }) });
  const replay = (member: number, eventId: string, version: number, extra: { key?: string; tenantId?: string } = {}): Promise<Reply> =>
    send(production, 'POST', `/integration-inbox/${eventId}/replay`, { member, ifMatch: `"${version}"`, body: { reason: 'The provider has fixed its endpoint' }, ...extra });
  const rows = async <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
  const idOf = (reply: Reply): string => reply.json.resource_id as string;
  const versionOf = (reply: Reply): number => reply.json.resource_version as number;

  async function inboxEvent(overrides: { provider?: string; status?: string; attempts?: number; tenant?: string; reference?: string | null } = {}): Promise<string> {
    counter += 1;
    const tenant = overrides.tenant ?? TENANT_A;
    const result = await rows<{ id: string }>(
      `insert into machvon.integration_event_inbox
         (tenant_id, id, provider, event_key, payload_hash, payload_reference, received_at, status, signature_key_id, attempts, error_code, payload_purged_at)
       values ($1, gen_random_uuid(), $2, $3, repeat('b', 64), $4, now() - interval '1 hour', $5, 'k1', $6, 'PROVIDER_DOWN', case when $4::text is null then now() end) returning id`,
      [tenant, overrides.provider ?? 'API_TEST', `evt-${counter}`, overrides.reference === undefined ? `tenants/${tenant}/webhook/RAW-PAYLOAD-${counter}` : overrides.reference, overrides.status ?? 'FAILED', overrides.attempts ?? 3],
      tenant,
    );
    return (result[0] as { id: string }).id;
  }

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }, { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 }]);
    for (const [member, unit] of [[MANAGER, 1], [OPERATOR, 1], [SUBTREE_MANAGER, 2], [NOBODY, 1]] as const) await harness.seedMembership(TENANT_A, member, unit);
    await harness.seedMembership(TENANT_B, OTHER_TENANT_OWNER, 1);
    await harness.seedRole(TENANT_A, 1, 'INTEGRATION_MANAGER', ['adm.integration.manage'], 40);
    await harness.seedRole(TENANT_A, 2, 'INTEGRATION_OPERATOR', ['adm.integration.operate'], 40);
    await harness.seedRole(TENANT_A, 3, 'INTEGRATION_BOTH', ['adm.integration.manage', 'adm.integration.operate'], 50);
    await harness.seedRole(TENANT_B, 1, 'INTEGRATION_BOTH', ['adm.integration.manage', 'adm.integration.operate'], 50);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 1, kind: 'TENANT' },
      { n: 2, member: OPERATOR, role: 2, kind: 'TENANT' },
      { n: 3, member: SUBTREE_MANAGER, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_OWNER, role: 1, kind: 'TENANT' }]);
    registry.register('API_TEST', async (delivery) => {
      handled.push(delivery.eventKey);
    });
    registry.register('API_FAILING', () => Promise.reject(new Error('provider still down')));
    const tenants = harness.tenants as TenantDatabase;
    const start = (environment: string): Promise<RunningApp> =>
      startTestApp({
        signingKey: SIGNING_KEY,
        imports: [
          CommandModule.register({ database: tenants }),
          PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
        ],
        controllers: [IntegrationConnectorsController, IntegrationInboxController],
        providers: [
          { provide: TenantDatabase, useValue: tenants },
          { provide: ADM_ENVIRONMENT, useValue: environment },
          { provide: ADM_INBOX_PROCESSOR, useValue: new IntegrationInboxProcessor(tenants, registry) },
          { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
        ],
      });
    production = await start('production');
    staging = await start('staging');
  }, 180_000);

  afterAll(async () => {
    await Promise.all([production?.close(), staging?.close()]);
    await harness.stop();
  }, 60_000);

  describe('createIntegrationConnector and updateIntegrationConnector', () => {
    it('declares a connector as a draft, audits it without the values of its configuration, and refuses a second one with the same code (409 CONNECTOR_CODE_TAKEN)', async () => {
      const body = connectorBody({ connector_code: 'lgsp-gateway', mode: 'LGSP', config: { endpoint: 'https://lgsp.example.invalid', retries: 3 }, credential_secret_ref: 'secret://production/connectors/lgsp', mapping_version: 'v1' });
      const first = await send(production, 'POST', '/integration-connectors', { member: MANAGER, body });
      expect(first.status).toBe(201);
      expect(first.json).toMatchObject({ status: 'Draft', resource_version: 1 });
      const [audit] = await rows<{ classification: string; safe_diff: Record<string, unknown> }>("select classification, safe_diff from machvon.audit_event where action = 'integration.connector_created' and resource_id = $1", [idOf(first)]);
      expect(audit).toMatchObject({ classification: 'INTERNAL', safe_diff: { connector_code: 'lgsp-gateway', mode: 'LGSP', adapter_status: 'PROPOSED', config_keys: ['endpoint', 'retries'], has_credential: true, mapping_version: 'v1' } });
      expect(JSON.stringify(audit)).not.toContain('lgsp.example.invalid');
      expect(JSON.stringify(audit)).not.toContain('secret://');
      const again = await send(production, 'POST', '/integration-connectors', { member: MANAGER, body });
      expect([again.status, again.json.code]).toEqual([409, 'CONNECTOR_CODE_TAKEN']);
    });

    it('refuses a PROPOSED connector set to Active with 422 CONNECTOR_NOT_ACTIVATABLE, and a MISSING one (AC-ST-ADM-018-1, UAT-AC137)', async () => {
      const proposed = await create(MANAGER, { adapter_status: 'PROPOSED' });
      const refused = await update(MANAGER, idOf(proposed), versionOf(proposed), { status: 'Active' });
      expect([refused.status, refused.json.code]).toEqual([422, 'CONNECTOR_NOT_ACTIVATABLE']);
      expect(await rows('select status, version from machvon.integration_connector where id = $1', [idOf(proposed)])).toEqual([{ status: 'Draft', version: '1' }]);
      const missing = await create(MANAGER, { adapter_status: 'MISSING' });
      expect((await update(MANAGER, idOf(missing), versionOf(missing), { status: 'Active' }, staging)).json.code).toBe('CONNECTOR_NOT_ACTIVATABLE');
      expect(await rows("select 1 from machvon.audit_event where action = 'integration.connector_updated' and resource_id = $1", [idOf(proposed)])).toEqual([]);
    });

    it('refuses MOCK in the production configuration and lets it be Active where the configuration is not production (AC-ST-ADM-018-1)', async () => {
      const mock = await create(MANAGER, { adapter_status: 'MOCK' });
      const refused = await update(MANAGER, idOf(mock), versionOf(mock), { status: 'Active' }, production);
      expect([refused.status, refused.json.code]).toEqual([422, 'CONNECTOR_NOT_ACTIVATABLE']);
      const allowed = await update(MANAGER, idOf(mock), versionOf(mock), { status: 'Active' }, staging);
      expect(allowed.status).toBe(200);
      expect(allowed.json).toMatchObject({ status: 'Active', resource_version: 2 });
    });

    it('lets a VERIFIED connector be Active in production, and audits the change with its reason', async () => {
      const verified = await create(MANAGER, { adapter_status: 'VERIFIED' });
      const active = await update(MANAGER, idOf(verified), versionOf(verified), { status: 'Active', mapping_version: 'v2' });
      expect(active.status).toBe(200);
      expect(active.json).toMatchObject({ status: 'Active', resource_version: 2 });
      const [audit] = await rows<{ reason: string; safe_diff: Record<string, unknown> }>("select reason, safe_diff from machvon.audit_event where action = 'integration.connector_updated' and resource_id = $1", [idOf(verified)]);
      expect(audit).toMatchObject({ reason: 'Changed by the integration administrator', safe_diff: { status_before: 'Draft', status_after: 'Active', adapter_status: 'VERIFIED', changed: ['mapping_version'] } });
      const off = await update(MANAGER, idOf(verified), versionOf(active), { status: 'Disabled' });
      expect(off.json).toMatchObject({ status: 'Disabled', resource_version: 3 });
    });

    it('answers 409 VERSION_CONFLICT to a stale version, 428 without If-Match, 404 to an unknown connector and 422 to a move the connector cannot make', async () => {
      const row = await create(MANAGER, { adapter_status: 'VERIFIED' });
      expect((await update(MANAGER, idOf(row), 9, { status: 'Active' })).json.code).toBe('VERSION_CONFLICT');
      const noMatch = await send(production, 'PUT', `/integration-connectors/${idOf(row)}`, { member: MANAGER, body: { reason: 'Changed by the integration administrator', status: 'Active' } });
      expect(noMatch.status).toBe(428);
      expect((await update(MANAGER, id(0x98, 1), 1, { status: 'Active' })).status).toBe(404);
      const active = await update(MANAGER, idOf(row), versionOf(row), { status: 'Active' });
      expect((await update(MANAGER, idOf(row), versionOf(active), { status: 'Draft' })).json.code).toBe('VALIDATION_FAILED');
    });

    it('never takes a secret in the configuration or a credential that is not a reference to the vault (NFR-SECURITY-06)', async () => {
      const secret = await create(MANAGER, { config: { auth: { password: 'hunter2' } } });
      expect([secret.status, secret.json.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect(secret.text).not.toContain('hunter2');
      expect((await create(MANAGER, { credential_secret_ref: 'hunter2' })).status).toBe(422);
      const row = await create(MANAGER);
      expect((await update(MANAGER, idOf(row), versionOf(row), { config: { token: 'x' } })).status).toBe(422);
      expect(await rows("select 1 from machvon.integration_connector where config_json::text like '%hunter2%'")).toEqual([]);
    });

    it('refuses what the contract refuses: an unknown adapter status, a code with capitals, a member it does not list, an update of the adapter status', async () => {
      expect((await create(MANAGER, { adapter_status: 'LIVE' })).status).toBe(422);
      expect((await create(MANAGER, { connector_code: 'Treasury' })).status).toBe(422);
      // A member the contract does not list is refused by the allowlist before the handler (400); a connector never has its adapter status changed by an update.
      expect((await create(MANAGER, { surprise: true })).status).toBe(400);
      const row = await create(MANAGER);
      expect((await update(MANAGER, idOf(row), versionOf(row), { adapter_status: 'VERIFIED' })).status).toBe(400);
    });

    it('is for a manager on the whole tenant: an operator, a subtree grant and a member with no grant are refused', async () => {
      expect((await create(OPERATOR)).status).toBe(403);
      expect((await create(NOBODY)).status).toBe(403);
      const subtree = await create(SUBTREE_MANAGER);
      expect([subtree.status, subtree.json.code]).toEqual([403, 'SCOPE_DENIED']);
      const row = await create(MANAGER);
      expect((await update(OPERATOR, idOf(row), versionOf(row), { status: 'Disabled' })).status).toBe(403);
      expect((await update(SUBTREE_MANAGER, idOf(row), versionOf(row), { status: 'Disabled' })).status).toBe(403);
    });

    it('does not find a connector of another tenant, and the same code is free there', async () => {
      const own = await create(MANAGER, { connector_code: 'isolated-code' });
      const foreign = await update(OTHER_TENANT_OWNER, idOf(own), 1, { status: 'Disabled' }, production, TENANT_B);
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect((await create(OTHER_TENANT_OWNER, { connector_code: 'isolated-code' }, production, { tenantId: TENANT_B })).status).toBe(201);
    });
  });

  describe('replayInboxEvent', () => {
    it('takes a failed event up again: the first replay ends with the event PROCESSED, the second is refused with 409 INBOX_STATE_INVALID (AC-ST-ADM-018-2, UAT-AC138)', async () => {
      const event = await inboxEvent({ provider: 'API_TEST', status: 'FAILED', attempts: 4 });
      const first = await replay(OPERATOR, event, 1);
      expect(first.status).toBe(202);
      expect(first.json).toMatchObject({ status: 'RECEIVED', resource_id: event, resource_version: 2 });
      expect(await rows('select status, attempts, error_code, replay_count, last_replayed_by from machvon.integration_event_inbox where id = $1', [event])).toEqual([
        { status: 'PROCESSED', attempts: 0, error_code: null, replay_count: 1, last_replayed_by: memberId(OPERATOR) },
      ]);
      expect(handled).toHaveLength(1);
      const second = await replay(OPERATOR, event, 2);
      expect([second.status, second.json.code]).toEqual([409, 'INBOX_STATE_INVALID']);
      const stale = await replay(OPERATOR, event, 1);
      expect([stale.status, stale.json.code]).toEqual([409, 'INBOX_STATE_INVALID']);
      expect(handled).toHaveLength(1);
    });

    it('audits the replay with the reason and the state before, and shows no payload anywhere', async () => {
      const event = await inboxEvent({ provider: 'API_TEST', status: 'DEAD', attempts: 10 });
      const done = await replay(OPERATOR, event, 1);
      expect(done.text).not.toContain('RAW-PAYLOAD');
      const [audit] = await rows<{ reason: string; safe_diff: Record<string, unknown> }>("select reason, safe_diff from machvon.audit_event where action = 'integration.inbox_replayed' and resource_id = $1", [event]);
      expect(audit).toMatchObject({ reason: 'The provider has fixed its endpoint', safe_diff: { provider: 'API_TEST', status_before: 'DEAD', attempts_before: 10, error_code_before: 'PROVIDER_DOWN', replay_count: 1 } });
      expect(JSON.stringify(audit)).not.toContain('RAW-PAYLOAD');
    });

    it('leaves an event that fails again FAILED with one attempt, and one whose provider has no adapter RECEIVED, and still answers 202', async () => {
      const failing = await inboxEvent({ provider: 'API_FAILING', status: 'DEAD', attempts: 10 });
      expect((await replay(OPERATOR, failing, 1)).status).toBe(202);
      expect(await rows('select status, attempts, error_code from machvon.integration_event_inbox where id = $1', [failing])).toEqual([{ status: 'FAILED', attempts: 1, error_code: 'HANDLER_FAILED' }]);
      const orphan = await inboxEvent({ provider: 'API_NO_ADAPTER', status: 'FAILED', attempts: 2 });
      expect((await replay(OPERATOR, orphan, 1)).status).toBe(202);
      expect(await rows('select status, attempts from machvon.integration_event_inbox where id = $1', [orphan])).toEqual([{ status: 'RECEIVED', attempts: 0 }]);
    });

    it('replays once for one Idempotency-Key', async () => {
      const event = await inboxEvent({ provider: 'API_TEST', status: 'FAILED' });
      const key = `key-${randomUUID()}`;
      const first = await replay(OPERATOR, event, 1, { key });
      const again = await replay(OPERATOR, event, 1, { key });
      expect([first.status, again.status]).toEqual([202, 202]);
      expect(await rows('select replay_count from machvon.integration_event_inbox where id = $1', [event])).toEqual([{ replay_count: 1 }]);
    });

    it('refuses an event whose payload was purged, one that is processed, and answers 409 VERSION_CONFLICT to a stale version', async () => {
      const gone = await inboxEvent({ status: 'DEAD', reference: null });
      expect((await replay(OPERATOR, gone, 1)).json.code).toBe('INBOX_STATE_INVALID');
      const processed = await inboxEvent({ status: 'PROCESSED', attempts: 0 });
      expect((await replay(OPERATOR, processed, 1)).json.code).toBe('INBOX_STATE_INVALID');
      const moved = await inboxEvent({ provider: 'API_NO_ADAPTER', status: 'FAILED' });
      await rows("update machvon.integration_event_inbox set error_code = 'CHANGED' where id = $1", [moved]);
      expect((await replay(OPERATOR, moved, 1)).json.code).toBe('VERSION_CONFLICT');
    });

    it('is for an operator on the whole tenant, and finds only an event of the own tenant', async () => {
      const event = await inboxEvent({ provider: 'API_NO_ADAPTER', status: 'FAILED' });
      expect((await replay(MANAGER, event, 1)).status).toBe(403);
      expect((await replay(NOBODY, event, 1)).status).toBe(403);
      expect((await replay(SUBTREE_MANAGER, event, 1)).json.code).toBe('SCOPE_DENIED');
      const foreign = await replay(OTHER_TENANT_OWNER, event, 1, { tenantId: TENANT_B });
      expect([foreign.status, foreign.json.code]).toEqual([404, 'RESOURCE_NOT_FOUND']);
      expect(await rows('select status from machvon.integration_event_inbox where id = $1', [event])).toEqual([{ status: 'FAILED' }]);
    });
  });
});
