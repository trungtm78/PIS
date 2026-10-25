import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { qmsModule } from '../../src/modules/qms';
import { NonconformanceController, NonconformanceReadsController } from '../../src/modules/qms/nonconformance.controller';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xaf;
const ROOT = 1;
const RAISER = 11; // ncr.raise, ncr.manage, quality_nonconformance.read
const RESPONSIBLE = 12; // ncr.close, quality_nonconformance.read: the person responsible for the non-conformance
const FIXER = 13; // ncr.respond, ncr.verify, quality_nonconformance.read: carries an action out
const VERIFIER = 14; // ncr.verify, ncr.close, quality_nonconformance.read
const READER = 15; // quality_nonconformance.read
const NOBODY = 16;
const ELSEWHERE = 17; // the rights of RAISER over another branch
const GUEST = 18; // the contractor of the contracts, invited to one
const MEMBERS = [RAISER, RESPONSIBLE, FIXER, VERIFIER, READER, NOBODY, ELSEWHERE, GUEST];
const OTHER_BRANCH = 5;
const DOCUMENT = id(FAMILY, 30);
const CLEAN_VERSION = id(FAMILY, 31);
const DIRTY_VERSION = id(FAMILY, 32);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Line {
  id: string;
  ncr_no: string;
  status: string;
  root_cause: string | null;
  allowed: Record<string, boolean>;
  actions: Array<{ id: string; status: string; owner: { membership_id: string } }>;
  version: number;
  contract: { id: string };
}

const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();
/** One moment for every request that has to repeat byte for byte. */
const DUE_AT = inDays(7);

describe('the non-conformances over HTTP (ST-QMS-006)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let counter = 0;
  let contractor = '';

  const tokenOf = (member: number): string => signTenantContext({ tenantId: TENANT_A, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: string; key?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);
  const audits = (resourceId: string, action: string) =>
    rows<{ safe_diff: Record<string, unknown>; actor_id: string; reason: string | null }>(
      'select safe_diff, actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at, id',
      [resourceId, action],
    );
  const events = (aggregateId: string, type: string) =>
    rows<{ payload: Record<string, unknown>; aggregate_version: string }>(
      'select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id',
      [aggregateId, type],
    );
  const stored = async (ncrId: string) =>
    (
      await rows<{ status: string; version: string; ncr_no: string; blocks_acceptance: boolean }>(
        'select status, version::text, ncr_no, blocks_acceptance from machvon.quality_nonconformance where id = $1::uuid',
        [ncrId],
      )
    )[0];

  interface Contract {
    id: string;
    projectId: string;
  }

  async function contract(status = 'ACTIVE'): Promise<Contract> {
    counter += 1;
    const line = await world.publishedLine();
    const contractId = randomUUID();
    const code = `HD-Q-${String(counter).padStart(4, '0')}`;
    await seedAs(harness, [
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
            created_by, updated_by, signed_on, effective_from, status_reason, status_decision_document_version_id)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', $7, 1, 'Contract', 'CONSTRUCTION', false, true, 1000000, $8, $8, date '2026-01-01', date '2026-01-02', $9, $10)`,
        [TENANT_A, contractId, line.projectId, randomUUID(), contractor, code, status, memberId(RAISER), status === 'SUSPENDED' ? 'Decided.' : null, status === 'SUSPENDED' ? CLEAN_VERSION : null],
      ],
    ]);
    return { id: contractId, projectId: line.projectId };
  }

  const raise = (member: number, target: Contract, overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', '/nonconformances', {
      member,
      ...(key === undefined ? {} : { key }),
      body: {
        contract_id: target.id,
        severity: 'CRITICAL',
        title: 'Concrete cover below the drawing',
        description: 'The cover of footing F1 measures 30 mm where the drawing says 50 mm.',
        source_kind: 'SUPERVISOR_REMARK',
        action_owner_id: memberId(RESPONSIBLE),
        due_at: DUE_AT,
        ...overrides,
      },
    });
  const assign = (member: number, ncrId: string, version: number | string, overrides: Record<string, unknown> = {}) =>
    call('POST', `/nonconformances/${ncrId}/corrective-actions`, {
      member,
      ifMatch: `"${version}"`,
      body: { description: 'Break out and recast the cover', owner_membership_id: memberId(FIXER), due_at: inDays(5), ...overrides },
    });
  const evidence = (member: number, actionId: string, overrides: Record<string, unknown> = {}) =>
    call('POST', `/corrective-actions/${actionId}/evidence`, { member, body: { evidence_document_version_id: CLEAN_VERSION, note: 'Recast, cover measured at 52 mm.', ...overrides } });
  const verify = (member: number, actionId: string, overrides: Record<string, unknown> = {}) =>
    call('POST', `/corrective-actions/${actionId}/verify`, { member, body: { outcome: 'VERIFIED', verification_note: 'Measured on site, cover is right.', ...overrides } });
  const close = (member: number, ncrId: string, version: number | string, note = 'Every action was verified.') =>
    call('POST', `/nonconformances/${ncrId}/close`, { member, ifMatch: `"${version}"`, body: { closure_note: note } });
  const reopen = (member: number, ncrId: string, version: number | string, reason = 'The cover cracked again.') =>
    call('POST', `/nonconformances/${ncrId}/reopen`, { member, ifMatch: `"${version}"`, body: { reason } });
  const list = (member: number, query = '') => call('GET', `/resources/quality_nonconformance${query}`, { member });
  const read = (member: number, ncrId: string) => call('GET', `/resources/quality_nonconformance/${ncrId}`, { member });
  const lineOf = async (member: number, ncrId: string) => (await read(member, ncrId)).json as unknown as Line;

  /** A non-conformance with one action assigned to the fixer. */
  async function withAction(target: Contract, overrides: Record<string, unknown> = {}) {
    const raised = await raise(RAISER, target, overrides);
    const ncrId = raised.json.resource_id as string;
    const assigned = await assign(RAISER, ncrId, 1);
    const actionId = (await lineOf(RAISER, ncrId)).actions[0]?.id ?? '';
    return { ncrId, actionId, version: assigned.json.resource_version as number };
  }

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    const READ = 'quality_nonconformance.read';
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'NCR_RAISER', ['ncr.raise', 'ncr.manage', READ], 40],
      [2, 'NCR_RESPONSIBLE', ['ncr.close', READ], 30],
      [3, 'NCR_FIXER', ['ncr.respond', 'ncr.verify', READ], 30],
      [4, 'NCR_VERIFIER', ['ncr.verify', 'ncr.close', READ], 40],
      [5, 'NCR_READER', [READ], 10],
      [6, 'NCR_GUEST', ['ncr.respond', READ], 5],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 100 + n, code, permissions, rank);
    const grant = (n: number, member: number, role: number, extra: { kind?: 'TENANT' | 'UNIT_SUBTREE' | 'CONTRACT'; refs?: string[] } = {}) => ({
      n,
      member,
      role: 100 + role,
      kind: extra.kind ?? 'TENANT',
      ...(extra.refs === undefined ? {} : { refs: extra.refs }),
    });
    await harness.seedGrants(TENANT_A, [
      grant(1, RAISER, 1),
      grant(2, RESPONSIBLE, 2),
      grant(3, FIXER, 3),
      grant(4, VERIFIER, 4),
      grant(5, READER, 5),
      grant(6, ELSEWHERE, 1, { kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] }),
    ]);
    contractor = await seedContractor(harness);
    await seedAs(harness, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3)`,
        [TENANT_A, DOCUMENT, memberId(RAISER)],
      ],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/qms/record.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $4, $3, 2, 'tenants/qms/unscanned.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'PENDING', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, CLEAN_VERSION, DOCUMENT, DIRTY_VERSION],
      ],
    ]);
    await world.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [
      memberId(GUEST),
      contractor,
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [NonconformanceController, NonconformanceReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await world.stop();
  }, 60_000);

  it('is registered in the module of QMS', () => {
    expect(qmsModule.controllers).toEqual(expect.arrayContaining([NonconformanceController, NonconformanceReadsController]));
  });

  describe('raiseNonconformance (AC-ST-QMS-006-1, UAT-AC361)', () => {
    it('raises a non-conformance with its audit row and its event, answers the same key once, and holds the acceptance back when it is critical', async () => {
      const target = await contract();
      const send = () => raise(RAISER, target, {}, 'raise-once-for-this-key');
      const first = await send();
      expect(first).toMatchObject({ status: 200, json: { status: 'OPEN', resource_version: 1 } });
      expect(await send()).toEqual(first);
      const ncrId = first.json.resource_id as string;
      expect(await rows('select id from machvon.quality_nonconformance where contract_id = $1::uuid', [target.id])).toHaveLength(1);
      expect(await stored(ncrId)).toMatchObject({ status: 'OPEN', ncr_no: 'NCR-001', blocks_acceptance: true });
      const [audit] = await audits(ncrId, 'nonconformance.raised');
      expect(audit).toMatchObject({
        actor_id: memberId(RAISER),
        safe_diff: { contract_id: target.id, ncr_no: 'NCR-001', severity: 'CRITICAL', blocks_acceptance: true, from_status: null, to_status: 'OPEN' },
      });
      const [event] = await events(ncrId, 'qms.ncr.raised.v1');
      expect(event?.payload).toMatchObject({
        nonconformance_id: ncrId,
        contract_id: target.id,
        project_id: target.projectId,
        severity: 'CRITICAL',
        blocks_acceptance: true,
        status: 'OPEN',
        version: 1,
        actor_id: memberId(RAISER),
      });
      // The words of the non-conformance do not leave in the event.
      expect(JSON.stringify(event?.payload)).not.toContain('footing F1');
      const minor = await raise(RAISER, target, { severity: 'MINOR' });
      expect(await stored(minor.json.resource_id as string)).toMatchObject({ ncr_no: 'NCR-002', blocks_acceptance: false });
    });

    it('refuses what is badly formed, a contract that is not being performed, and a caller without the right or outside its scope', async () => {
      const target = await contract();
      expect(await raise(RAISER, target, { severity: 'SEVERE' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await raise(RAISER, target, { due_at: '2020-01-01T00:00:00Z' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await raise(RAISER, target, { status: 'CLOSED' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await raise(RAISER, await contract('SUSPENDED'))).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID' } });
      expect((await raise(READER, target)).status).toBe(403);
      expect((await raise(NOBODY, target)).status).toBe(403);
      expect((await raise(ELSEWHERE, target)).status).toBe(404);
      expect(await rows('select id from machvon.quality_nonconformance where contract_id = $1::uuid', [target.id])).toEqual([]);
    });
  });

  describe('the actions, the evidence and the verification', () => {
    it('AC-ST-QMS-006-1, UAT-AC361: assigns an action, takes the evidence of the person given it, and verifies it by someone else, each with its audit row and event', async () => {
      const target = await contract();
      const raised = await raise(RAISER, target);
      const ncrId = raised.json.resource_id as string;

      expect(await assign(RAISER, ncrId, 1, { description: '' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await assign(RAISER, ncrId, 9)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect((await assign(READER, ncrId, 1)).status).toBe(403);
      const assigned = await assign(RAISER, ncrId, 1);
      expect(assigned).toMatchObject({ status: 200, json: { status: 'ACTION_ASSIGNED', resource_version: 2, resource_id: ncrId } });
      const [assignAudit] = await audits(ncrId, 'corrective_action.assigned');
      expect(assignAudit).toMatchObject({ actor_id: memberId(RAISER), safe_diff: { from_status: 'OPEN', to_status: 'ACTION_ASSIGNED', open_actions: 1, corrective_action_status: 'ASSIGNED' } });
      expect((await events(ncrId, 'qms.corrective_action.assigned.v1'))[0]?.payload).toMatchObject({ nonconformance_id: ncrId, status: 'ACTION_ASSIGNED', version: 2 });
      const actionId = (await lineOf(RAISER, ncrId)).actions[0]?.id ?? '';

      // Only the person given the action answers it, with evidence that is clean.
      expect(await evidence(RESPONSIBLE, actionId)).toMatchObject({ status: 403 });
      expect(await evidence(FIXER, actionId, { evidence_document_version_id: undefined })).toMatchObject({ status: 422, json: { code: 'EVIDENCE_REQUIRED' } });
      expect(await evidence(FIXER, actionId, { evidence_document_version_id: DIRTY_VERSION })).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_CLEAN' } });
      const answered = await evidence(FIXER, actionId);
      expect(answered).toMatchObject({ status: 200, json: { status: 'SUBMITTED', resource_id: actionId, resource_version: 2 } });
      const [answerAudit] = await audits(ncrId, 'corrective_action.submitted');
      expect(answerAudit).toMatchObject({ actor_id: memberId(FIXER), safe_diff: { corrective_action_id: actionId, from_status: 'ACTION_ASSIGNED', to_status: 'ACTION_SUBMITTED' } });
      expect((await events(ncrId, 'qms.corrective_action.submitted.v1'))[0]?.payload).toMatchObject({ corrective_action_id: actionId, status: 'ACTION_SUBMITTED' });
      expect(await evidence(FIXER, actionId)).toMatchObject({ status: 409, json: { code: 'CORRECTIVE_ACTION_STATE_INVALID' } });

      // Whoever carried the action out, and whoever is responsible for the non-conformance, does not verify it.
      expect(await verify(FIXER, actionId)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect((await verify(READER, actionId)).status).toBe(403);
      const rejected = await verify(VERIFIER, actionId, { outcome: 'REJECTED', verification_note: 'Still 40 mm.' });
      expect(rejected).toMatchObject({ status: 200, json: { status: 'REJECTED', resource_id: actionId, resource_version: 3 } });
      expect((await audits(ncrId, 'corrective_action.verified'))[0]).toMatchObject({ reason: 'Still 40 mm.', safe_diff: { corrective_action_status: 'REJECTED', to_status: 'ACTION_ASSIGNED' } });
      expect(await evidence(FIXER, actionId)).toMatchObject({ status: 200, json: { status: 'SUBMITTED' } });
      const verified = await verify(VERIFIER, actionId);
      expect(verified).toMatchObject({ status: 200, json: { status: 'VERIFIED' } });
      expect(await stored(ncrId)).toMatchObject({ status: 'VERIFIED' });
      expect((await events(ncrId, 'qms.corrective_action.verified.v1')).map((event) => event.payload.corrective_action_status)).toEqual(['REJECTED', 'VERIFIED']);
    });
  });

  describe('closeNonconformance and reopenNonconformance', () => {
    it('AC-ST-QMS-006-1, UAT-AC361: closes a verified non-conformance by someone who is none of the people who put it right, and reopens it', async () => {
      const target = await contract();
      const { ncrId, actionId } = await withAction(target);
      const stuck = await lineOf(RAISER, ncrId);
      // Nothing is closed while an action is open.
      expect(await close(VERIFIER, ncrId, stuck.version)).toMatchObject({ status: 422, json: { code: 'CORRECTIVE_ACTION_OPEN' } });
      await evidence(FIXER, actionId);
      await verify(VERIFIER, actionId);
      const ready = await lineOf(RAISER, ncrId);
      expect(ready.status).toBe('VERIFIED');
      expect(await close(RESPONSIBLE, ncrId, ready.version)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect((await close(READER, ncrId, ready.version)).status).toBe(403);
      expect(await close(VERIFIER, ncrId, ready.version + 1)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      const closed = await close(VERIFIER, ncrId, ready.version);
      expect(closed).toMatchObject({ status: 200, json: { status: 'CLOSED', resource_version: ready.version + 1 } });
      expect((await audits(ncrId, 'nonconformance.closed'))[0]).toMatchObject({
        actor_id: memberId(VERIFIER),
        reason: 'Every action was verified.',
        safe_diff: { from_status: 'VERIFIED', to_status: 'CLOSED' },
      });
      expect((await events(ncrId, 'qms.ncr.closed.v1'))[0]?.payload).toMatchObject({ nonconformance_id: ncrId, status: 'CLOSED', blocks_acceptance: true });
      expect(await close(VERIFIER, ncrId, ready.version + 1)).toMatchObject({ status: 409, json: { code: 'NCR_STATE_INVALID' } });

      const reopened = await reopen(VERIFIER, ncrId, ready.version + 1);
      expect(reopened).toMatchObject({ status: 200, json: { status: 'REOPENED' } });
      expect((await audits(ncrId, 'nonconformance.reopened'))[0]).toMatchObject({ reason: 'The cover cracked again.' });
      expect((await events(ncrId, 'qms.ncr.reopened.v1'))[0]?.payload).toMatchObject({ status: 'REOPENED', from_status: 'CLOSED' });
      expect(await reopen(VERIFIER, ncrId, ready.version + 2)).toMatchObject({ status: 409, json: { code: 'NCR_STATE_INVALID' } });
    });
  });

  describe('reading', () => {
    it('shows what the caller may do with each non-conformance, and pages the list newest first', async () => {
      const target = await contract();
      const one = await withAction(target, { title: 'First' });
      await evidence(FIXER, one.actionId);
      const two = await raise(RAISER, target, { title: 'Second', severity: 'MINOR' });
      const three = await raise(RAISER, target, { title: 'Third', severity: 'MAJOR' });
      const all = await list(READER, `?contract_id=${target.id}`);
      const items = all.json.items as Line[];
      expect(items.map((item) => item.id)).toEqual([three.json.resource_id, two.json.resource_id, one.ncrId]);
      expect(items[2]).toMatchObject({ status: 'ACTION_SUBMITTED', ncr_no: 'NCR-001' });
      expect(items[2]?.allowed).toEqual({ assign: false, respond: false, verify: false, close: false, reopen: false });

      // A person sees the buttons of what they may do: the raiser assigns, the verifier verifies, the person given the action has nothing left to answer.
      expect((await lineOf(RAISER, one.ncrId)).allowed).toMatchObject({ assign: true, verify: false });
      expect((await lineOf(VERIFIER, one.ncrId)).allowed).toMatchObject({ assign: false, verify: true, close: false });
      expect((await lineOf(FIXER, one.ncrId)).allowed).toMatchObject({ respond: false, verify: false });
      expect((await lineOf(FIXER, three.json.resource_id as string)).allowed).toMatchObject({ respond: false });

      const page = await list(READER, `?contract_id=${target.id}&limit=2`);
      expect((page.json.items as Line[]).map((item) => item.id)).toEqual([three.json.resource_id, two.json.resource_id]);
      const next = await list(READER, `?contract_id=${target.id}&limit=2&cursor=${page.json.next_cursor as string}`);
      expect((next.json.items as Line[]).map((item) => item.id)).toEqual([one.ncrId]);
      expect(next.json.next_cursor).toBeNull();
      expect((await list(READER, `?contract_id=${target.id}&status=OPEN`)).json.items).toHaveLength(2);
      expect((await list(READER, `?contract_id=${target.id}&severity=CRITICAL`)).json.items).toHaveLength(1);
      expect((await list(READER, '?contract_id=nope')).status).toBe(422);
      expect((await list(READER, '?limit=0')).status).toBe(422);
      expect((await list(NOBODY)).status).toBe(403);
      expect((await list(ELSEWHERE, `?contract_id=${target.id}`)).json.items).toEqual([]);
      expect((await read(ELSEWHERE, one.ncrId)).status).toBe(404);
      expect((await read(READER, randomUUID())).status).toBe(404);
    });

    it('shows the person given an action the button to answer it, and hides the root cause from a guest contractor', async () => {
      const target = await contract();
      await harness.seedGrants(TENANT_A, [{ n: 50, member: GUEST, role: 106, kind: 'CONTRACT', refs: [target.id] }]);
      const raised = await raise(RAISER, target);
      const ncrId = raised.json.resource_id as string;
      await assign(RAISER, ncrId, 1, { owner_membership_id: memberId(GUEST) });
      await world.owner("update machvon.quality_nonconformance set root_cause = 'Formwork moved during the pour.' where id = $1::uuid", [ncrId]);
      const own = await lineOf(GUEST, ncrId);
      expect(own).toMatchObject({ status: 'ACTION_ASSIGNED', root_cause: null, allowed: { respond: true, assign: false } });
      expect((await lineOf(RAISER, ncrId)).root_cause).toBe('Formwork moved during the pour.');
      const actionId = own.actions[0]?.id ?? '';
      expect(await evidence(GUEST, actionId)).toMatchObject({ status: 200, json: { status: 'SUBMITTED' } });
      const other = await contract();
      await raise(RAISER, other);
      const seen = (await list(GUEST)).json.items as Line[];
      expect(new Set(seen.map((item) => item.contract.id))).toEqual(new Set([target.id]));
    });
  });
});
