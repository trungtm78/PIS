import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { astModule } from '../../src/modules/ast';
import { HandoverController, HandoverReadsController } from '../../src/modules/ast/handover.controller';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { asSuperuser } from '../../../../packages/db/test/support/ncr-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xb3;
const ROOT = 1;
const DRAFTER = 11; // handover.manage, handover.approve, handover.waive, handover.read: draws the handover up and so cannot accept it or waive its own items
const VERIFIER = 12; // handover.verify, handover.waive, handover.read
const RECEIVER = 13; // handover.approve, handover.read over the unit that receives the work, and nothing else
const READER = 14; // handover.read
const NOBODY = 15;
const FOREIGN = 19; // a member of another tenant with every right over the handovers of that tenant
const ELSEWHERE = 16; // the rights of DRAFTER over another branch
const GUEST = 17; // the contractor of the contracts, answering for the items of its contract
const OTHER_GUEST = 18; // the contractor of another contract
const MEMBERS = [DRAFTER, VERIFIER, RECEIVER, READER, NOBODY, ELSEWHERE, GUEST, OTHER_GUEST];
const OTHER_BRANCH = 5;
const RECEIVING_UNIT = 7;
const DOCUMENT = id(FAMILY, 30);
const CLEAN = id(FAMILY, 31);
const AS_BUILT = id(FAMILY, 33);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

interface Trace {
  handover: { id: string; status: string; version: number; open_critical_punch_count: number; allowed: Record<string, boolean> };
  items: Array<{ id: string; item_no: number; status: string; allowed: Record<string, boolean> }>;
  receiving_unit: { id: string };
  assets: unknown[];
}

const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe('the handover and its punch list over HTTP (ST-AST-001)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let counter = 0;
  let contractor = '';
  let otherContractor = '';

  const tokenOf = (member: number, tenantId: string = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: string; key?: string; tenant?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenant), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);
  const stage = (sql: string, params: unknown[] = []): Promise<void> => asSuperuser(harness.database.adminUrl, sql, params);
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
  const stored = async (handoverId: string) =>
    (
      await rows<{ status: string; version: string; open_critical_punch_count: number; accepted_by: string | null }>(
        'select status, version::text, open_critical_punch_count, accepted_by from machvon.handover where id = $1::uuid',
        [handoverId],
      )
    )[0];

  interface Contract {
    id: string;
    projectId: string;
    completion: string;
    photo: string;
  }

  async function contract(contractorId = contractor): Promise<Contract> {
    counter += 1;
    const line = await world.publishedLine();
    const contractId = randomUUID();
    const completion = randomUUID();
    const photo = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
            created_by, updated_by, signed_on, effective_from)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'Contract', 'CONSTRUCTION', false, true, 1000000, $7, $7, date '2026-01-02', date '2026-01-03')`,
        [TENANT_A, contractId, line.projectId, randomUUID(), contractorId, `HD-A-${String(counter).padStart(4, '0')}`, memberId(ROOT)],
      ],
      [
        `insert into machvon.site_photo (tenant_id, id, project_id, contract_id, client_operation_id, object_key, file_sha256, scan_status, uploaded_by, created_by)
         values ($1, $2, $3, $4, gen_random_uuid(), 'tenants/ast/photo-' || $2::uuid::text || '.jpg', repeat('a', 64), 'CLEAN', $5, $5)`,
        [TENANT_A, photo, line.projectId, contractId, memberId(GUEST)],
      ],
    ]);
    await stage(
      `insert into machvon.quality_acceptance
         (tenant_id, id, project_id, contract_id, inspection_id, record_no, acceptance_scope, document_version_id, status, required_roles, content_hash, created_by, updated_by, version, approved_at, approved_by, decision_note)
       values ($1, $2, $3, $4, $5, $6, 'COMPLETION', $7, 'APPROVED', '["CONTRACTOR","SUPERVISOR","OWNER"]'::jsonb, repeat('a', 64), $8, $8, 1, timestamptz '2026-01-10T03:00:00Z', $9, 'Approved for the test.')`,
      [TENANT_A, completion, line.projectId, contractId, randomUUID(), `QA-A-${completion.slice(0, 8)}`, CLEAN, memberId(ROOT), memberId(VERIFIER)],
    );
    // A guest contractor answers for the items of the contract it was invited to.
    const guest = contractorId === contractor ? GUEST : OTHER_GUEST;
    await harness.seedGrants(TENANT_A, [{ n: 1000 + counter, member: guest, role: 105, kind: 'CONTRACT', refs: [contractId] }]);
    // The access of a member is cached by the scope version of its membership: a member given a new grant moves to the next version.
    await world.owner('update machvon.membership set scope_version = scope_version + 1 where id = $1::uuid', [memberId(guest)]);
    return { id: contractId, projectId: line.projectId, completion, photo };
  }

  const draft = (member: number, target: Contract, overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', '/handovers', {
      member,
      ...(key === undefined ? {} : { key }),
      body: {
        project_id: target.projectId,
        contract_id: target.id,
        recipient_unit_id: unitId(RECEIVING_UNIT),
        handover_kind: 'COMPLETION',
        handover_no: `BG-${++counter}`,
        quality_acceptance_id: target.completion,
        planned_on: inDays(7),
        document_version_id: CLEAN,
        ...overrides,
      },
    });
  const addItem = (member: number, handoverId: string, version: number | string, overrides: Record<string, unknown> = {}) =>
    call('POST', `/handovers/${handoverId}/punch-items`, {
      member,
      ifMatch: `"${version}"`,
      body: { description: 'The railing of the stair is loose.', severity: 'CRITICAL', due_on: inDays(5), ...overrides },
    });
  const fixed = (member: number, itemId: string, overrides: Record<string, unknown> = {}) =>
    call('POST', `/punch-items/${itemId}/fixed`, { member, body: { note: 'Fastened and tested.', ...overrides } });
  const verify = (member: number, itemId: string, outcome = 'VERIFIED') => call('POST', `/punch-items/${itemId}/verify`, { member, body: { outcome, note: 'Checked on site.' } });
  const waive = (member: number, itemId: string) => call('POST', `/punch-items/${itemId}/waive`, { member, body: { waiver_reason: 'Cosmetic, accepted by the receiving unit.' } });
  const decide = (member: number, handoverId: string, version: number | string, overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', `/handovers/${handoverId}/decision`, {
      member,
      ifMatch: `"${version}"`,
      ...(key === undefined ? {} : { key }),
      body: { decision: 'approve', reason: 'Accepted.', evidence_ids: [], as_built_document_version_id: AS_BUILT, ...overrides },
    });
  const trace = async (member: number, handoverId: string): Promise<Trace> => (await call('GET', `/handovers/${handoverId}/trace`, { member })).json as unknown as Trace;
  /** The item the command added is found on the list by its number (the command answers with the handover, which is the resource that has a version). */
  const itemIdOf = async (handoverId: string, itemNo: number): Promise<string> =>
    (await rows<{ id: string }>('select id from machvon.handover_punch_item where handover_id = $1::uuid and item_no = $2', [handoverId, itemNo]))[0]?.id ?? '';
  const versionOf = async (handoverId: string): Promise<number> => Number((await stored(handoverId))?.version);

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [
      { n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` },
      { n: RECEIVING_UNIT, path: `/${unitId(RECEIVING_UNIT)}/` },
    ]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedUnits(TENANT_B, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    await harness.seedMembership(TENANT_B, FOREIGN, ROOT);
    await harness.seedRole(TENANT_B, 601, 'AST_ALL', ['handover.manage', 'handover.respond', 'handover.verify', 'handover.waive', 'handover.approve', 'handover.read'], 60);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: FOREIGN, role: 601, kind: 'TENANT' }]);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'AST_DRAFTER', ['handover.manage', 'handover.approve', 'handover.waive', 'handover.read'], 40],
      [2, 'AST_VERIFIER', ['handover.verify', 'handover.waive', 'handover.read'], 40],
      [3, 'AST_RECEIVER', ['handover.approve', 'handover.read'], 40],
      [4, 'AST_READER', ['handover.read'], 10],
      [5, 'AST_CONTRACTOR', ['handover.respond', 'handover.read'], 5],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 100 + n, code, permissions, rank);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: DRAFTER, role: 101, kind: 'TENANT' },
      { n: 2, member: VERIFIER, role: 102, kind: 'TENANT' },
      { n: 3, member: RECEIVER, role: 103, kind: 'UNIT_SUBTREE', refs: [unitId(RECEIVING_UNIT)] },
      { n: 4, member: READER, role: 104, kind: 'TENANT' },
      { n: 5, member: ELSEWHERE, role: 101, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
    ]);
    contractor = await seedContractor(harness);
    otherContractor = await seedContractor(harness);
    await world.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [
      memberId(GUEST),
      contractor,
    ]);
    await world.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [
      memberId(OTHER_GUEST),
      otherContractor,
    ]);
    await seedAs(harness, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3)`,
        [TENANT_A, DOCUMENT, memberId(ROOT)],
      ],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ast/minutes.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $4, $3, 2, 'tenants/ast/as-built.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, CLEAN, DOCUMENT, AS_BUILT],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [HandoverController, HandoverReadsController],
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

  it('is registered in the module of AST', () => {
    expect(astModule.controllers).toEqual(expect.arrayContaining([HandoverController, HandoverReadsController]));
  });

  describe('createHandover', () => {
    it('drafts a handover with its audit row and its event, answers the same key once, and refuses what does not serve', async () => {
      const target = await contract();
      const send = () => draft(DRAFTER, target, { handover_no: 'BG-ONCE', planned_on: inDays(9) }, 'draft-once-for-this-key');
      const first = await send();
      expect(first).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1 } });
      expect(await send()).toEqual(first);
      const handoverId = first.json.resource_id as string;
      expect(await rows('select id from machvon.handover where contract_id = $1::uuid', [target.id])).toHaveLength(1);
      const [audit] = await audits(handoverId, 'handover.drafted');
      expect(audit).toMatchObject({
        actor_id: memberId(DRAFTER),
        safe_diff: { contract_id: target.id, handover_no: 'BG-ONCE', handover_kind: 'COMPLETION', recipient_unit_id: unitId(RECEIVING_UNIT), from_status: null, to_status: 'DRAFT' },
      });
      expect((await events(handoverId, 'ast.handover.drafted.v1'))[0]?.payload).toMatchObject({
        handover_id: handoverId,
        contract_id: target.id,
        project_id: target.projectId,
        recipient_unit_id: unitId(RECEIVING_UNIT),
        status: 'DRAFT',
        version: 1,
        actor_id: memberId(DRAFTER),
      });

      expect(await draft(DRAFTER, target, { handover_kind: 'WHOLE' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await draft(DRAFTER, target, { quality_acceptance_id: undefined })).toMatchObject({ status: 422, json: { code: 'QUALITY_ACCEPTANCE_REQUIRED', reason: 'MISSING' } });
      expect(await draft(DRAFTER, target, { status: 'ACCEPTED' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await draft(DRAFTER, target, { handover_no: 'BG-ONCE' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect((await draft(READER, target)).status).toBe(403);
      expect((await draft(NOBODY, target)).status).toBe(403);
      expect((await draft(ELSEWHERE, target)).status).toBe(404);
    });
  });

  describe('the punch list and the decision (AC-ST-AST-001-1, UAT-AC388)', () => {
    it('AC-ST-AST-001-1, UAT-AC388: refuses to accept while a critical item is open and never waives it, then accepts once the contractor has put it right and somebody else verified it', async () => {
      const target = await contract();
      // The contractor of another contract holds the right to answer, over that contract only.
      await contract(otherContractor);
      const handoverId = (await draft(DRAFTER, target)).json.resource_id as string;
      const added = await addItem(DRAFTER, handoverId, 1);
      expect(added).toMatchObject({ status: 200, json: { status: 'PUNCH_PENDING', resource_version: 2 } });
      const itemId = await itemIdOf(handoverId, 1);
      expect((await audits(handoverId, 'punch_item.added'))[0]).toMatchObject({
        safe_diff: { punch_item_id: itemId, punch_item_no: 1, punch_item_severity: 'CRITICAL', open_critical_punch_count: 1 },
      });
      expect((await events(handoverId, 'ast.punch_item.added.v1'))[0]?.payload).toMatchObject({ handover_id: handoverId, punch_item_id: itemId, open_critical_punch_count: 1 });

      // A critical item is not waived, and the handover is not accepted while it is open (by the receiving unit, or by the drafter who may not accept at all).
      expect(await waive(VERIFIER, itemId)).toMatchObject({ status: 422, json: { code: 'CRITICAL_CANNOT_BE_WAIVED' } });
      expect(await decide(RECEIVER, handoverId, 2)).toMatchObject({ status: 422, json: { code: 'OPEN_CRITICAL_PUNCH', open_critical_punch_count: 1 } });
      expect(await decide(DRAFTER, handoverId, 2)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });

      // The contractor answers with evidence; the answer is not verified by the one who gave it, nor by someone without the right.
      expect(await fixed(GUEST, itemId)).toMatchObject({ status: 422, json: { code: 'EVIDENCE_REQUIRED' } });
      expect(await fixed(OTHER_GUEST, itemId, { evidence_photo_id: target.photo })).toMatchObject({ status: 404 });
      const answered = await fixed(GUEST, itemId, { evidence_photo_id: target.photo });
      expect(answered).toMatchObject({ status: 200, json: { status: 'FIXED', resource_id: itemId } });
      expect((await audits(handoverId, 'punch_item.fixed'))[0]).toMatchObject({ actor_id: memberId(GUEST), safe_diff: { punch_item_status: 'FIXED' } });
      expect((await events(handoverId, 'ast.punch_item.fixed.v1')).length).toBe(1);
      expect((await verify(GUEST, itemId)).status).toBe(403);
      expect((await verify(READER, itemId)).status).toBe(403);
      expect(await verify(VERIFIER, itemId, 'REOPEN')).toMatchObject({ status: 200, json: { status: 'OPEN' } });
      expect((await stored(handoverId))?.open_critical_punch_count).toBe(1);
      await fixed(GUEST, itemId, { evidence_photo_id: target.photo });
      expect(await verify(VERIFIER, itemId)).toMatchObject({ status: 200, json: { status: 'VERIFIED' } });
      expect((await events(handoverId, 'ast.punch_item.verified.v1')).map((event) => event.payload.punch_item_status)).toEqual(['OPEN', 'VERIFIED']);
      expect((await stored(handoverId))?.open_critical_punch_count).toBe(0);

      const version = await versionOf(handoverId);
      expect(await decide(RECEIVER, handoverId, version, { as_built_document_version_id: undefined })).toMatchObject({ status: 422, json: { code: 'AS_BUILT_REQUIRED' } });
      expect(await decide(RECEIVER, handoverId, version + 1)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect((await decide(READER, handoverId, version)).status).toBe(403);
      expect((await decide(ELSEWHERE, handoverId, version)).status).toBe(404);
      const send = () => decide(RECEIVER, handoverId, version, { evidence_ids: [CLEAN] }, 'accept-once-for-this-key');
      const accepted = await send();
      expect(accepted).toMatchObject({ status: 200, json: { status: 'ACCEPTED', resource_version: version + 1, resource_id: handoverId } });
      expect(await send()).toEqual(accepted);
      expect(await stored(handoverId)).toMatchObject({ status: 'ACCEPTED', accepted_by: memberId(RECEIVER), open_critical_punch_count: 0 });
      expect((await audits(handoverId, 'handover.accepted'))[0]).toMatchObject({
        actor_id: memberId(RECEIVER),
        reason: 'Accepted.',
        safe_diff: { from_status: 'PUNCH_PENDING', to_status: 'ACCEPTED', decision: 'approve' },
      });
      const told = await events(handoverId, 'ast.handover.accepted.v1');
      expect(told).toHaveLength(1);
      expect(told[0]?.payload).toMatchObject({
        handover_id: handoverId,
        contract_id: target.id,
        recipient_unit_id: unitId(RECEIVING_UNIT),
        status: 'ACCEPTED',
        version: version + 1,
        actor_id: memberId(RECEIVER),
      });
      expect(typeof told[0]?.payload.accepted_at).toBe('string');
      expect(await decide(RECEIVER, handoverId, version + 1)).toMatchObject({ status: 409, json: { code: 'HANDOVER_STATE_INVALID' } });
    });

    it('waives an item that is not critical by somebody who did not put it on the list, and gives a handover back or rejects it without telling the other modules', async () => {
      const target = await contract();
      const handoverId = (await draft(DRAFTER, target)).json.resource_id as string;
      const minor = await addItem(DRAFTER, handoverId, 1, { severity: 'MINOR', description: 'A tile is chipped.' });
      expect(minor.status).toBe(200);
      const itemId = await itemIdOf(handoverId, 1);
      expect(await waive(DRAFTER, itemId)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await waive(VERIFIER, itemId)).toMatchObject({ status: 200, json: { status: 'WAIVED' } });
      expect((await audits(handoverId, 'punch_item.waived'))[0]).toMatchObject({ actor_id: memberId(VERIFIER), reason: 'Cosmetic, accepted by the receiving unit.' });
      expect((await events(handoverId, 'ast.punch_item.waived.v1')).length).toBe(1);
      expect(await waive(VERIFIER, itemId)).toMatchObject({ status: 409, json: { code: 'PUNCH_STATE_INVALID' } });

      const version = await versionOf(handoverId);
      const returned = await decide(RECEIVER, handoverId, version, { decision: 'return', reason: 'Add the remaining defects.' });
      expect(returned).toMatchObject({ status: 200, json: { status: 'PUNCH_PENDING' } });
      expect((await audits(handoverId, 'handover.returned')).length).toBe(1);
      const rejected = await decide(RECEIVER, handoverId, version + 1, { decision: 'reject', reason: 'The work is not ready.' });
      expect(rejected).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
      expect((await audits(handoverId, 'handover.rejected'))[0]).toMatchObject({ reason: 'The work is not ready.' });
      expect(await events(handoverId, 'ast.handover.accepted.v1')).toEqual([]);
      expect(await addItem(DRAFTER, handoverId, version + 2)).toMatchObject({ status: 409, json: { code: 'HANDOVER_STATE_INVALID' } });
    });
  });

  describe('another tenant (AC-ST-AST-001-3, UAT-AC395)', () => {
    it('AC-ST-AST-001-3, UAT-AC395: does not see, change or decide a handover of the first tenant, whatever its rights in its own', async () => {
      const target = await contract();
      const handoverId = (await draft(DRAFTER, target)).json.resource_id as string;
      await addItem(DRAFTER, handoverId, 1);
      const itemId = await itemIdOf(handoverId, 1);
      const as = (method: string, url: string, body?: unknown, ifMatch?: string) =>
        call(method, url, { member: FOREIGN, tenant: TENANT_B, ...(body === undefined ? {} : { body }), ...(ifMatch === undefined ? {} : { ifMatch }) });
      expect(await as('GET', `/handovers/${handoverId}/trace`)).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect((await as('GET', `/resources/handover/${handoverId}`)).status).toBe(404);
      expect(((await as('GET', '/resources/handover')).json.items as unknown[]).length).toBe(0);
      expect((await as('POST', `/handovers/${handoverId}/punch-items`, { description: 'x', severity: 'MINOR', due_on: inDays(5) }, '"2"')).status).toBe(404);
      expect((await as('POST', `/punch-items/${itemId}/fixed`, { note: 'x', evidence_photo_id: target.photo })).status).toBe(404);
      expect((await as('POST', `/punch-items/${itemId}/verify`, { outcome: 'VERIFIED', note: 'x' })).status).toBe(404);
      expect((await as('POST', `/punch-items/${itemId}/waive`, { waiver_reason: 'x' })).status).toBe(404);
      expect((await as('POST', `/handovers/${handoverId}/decision`, { decision: 'reject', reason: 'x', evidence_ids: [] }, '"2"')).status).toBe(404);
      expect(await stored(handoverId)).toMatchObject({ status: 'PUNCH_PENDING', version: '2' });
    });
  });

  describe('reading (AC-ST-AST-001-2, UAT-AC65)', () => {
    it('AC-ST-AST-001-2, UAT-AC65: traces a handover, its items, assets, minutes and receiving unit, and shows each person what they may do', async () => {
      const target = await contract();
      await contract(otherContractor);
      const handoverId = (await draft(DRAFTER, target)).json.resource_id as string;
      await addItem(DRAFTER, handoverId, 1, { responsible_contractor_id: contractor });
      await addItem(DRAFTER, handoverId, 2, { severity: 'MAJOR', description: 'The paint peels.', responsible_contractor_id: contractor });
      const major = await itemIdOf(handoverId, 2);
      expect(await fixed(GUEST, major, { evidence_photo_id: target.photo })).toMatchObject({ status: 200 });
      await stage(
        `insert into machvon.asset_record (tenant_id, id, project_id, handover_id, asset_code, value_vnd, recipient_unit_id, name, source_contract_id, created_by, updated_by)
         values ($1, gen_random_uuid(), $2::uuid, $3::uuid, 'AS-001', 3200000000, $4::uuid, 'Pump house', $5::uuid, $6::uuid, $6::uuid)`,
        [TENANT_A, target.projectId, handoverId, unitId(RECEIVING_UNIT), target.id, memberId(ROOT)],
      );
      const read = await call('GET', `/handovers/${handoverId}/trace`, { member: RECEIVER });
      expect(read.status).toBe(200);
      const found = read.json as unknown as Trace & { documents: Array<{ role: string }>; quality_acceptance: { id: string; scope: string } };
      expect(found.handover).toMatchObject({ id: handoverId, status: 'PUNCH_PENDING', open_critical_punch_count: 1, allowed: { approve: true, return: true, reject: true, add_item: false } });
      expect(found.receiving_unit.id).toBe(unitId(RECEIVING_UNIT));
      expect(found.items.map((item) => [item.item_no, item.status])).toEqual([
        [1, 'OPEN'],
        [2, 'FIXED'],
      ]);
      expect(found.assets).toEqual([expect.objectContaining({ asset_code: 'AS-001', value_vnd: '3200000000', status: 'DRAFT' })]);
      expect(found.documents).toEqual([{ role: 'MINUTES', document_version_id: CLEAN }]);
      expect(found.quality_acceptance).toMatchObject({ id: target.completion, scope: 'COMPLETION' });

      // Each person sees the buttons of what they may do.
      expect((await trace(DRAFTER, handoverId)).handover.allowed).toMatchObject({ add_item: true, approve: false, reject: true });
      expect((await trace(DRAFTER, handoverId)).items.map((item) => item.allowed)).toEqual([
        { fix: false, verify: false, waive: false },
        { fix: false, verify: false, waive: false },
      ]);
      expect((await trace(VERIFIER, handoverId)).items.map((item) => item.allowed)).toEqual([
        { fix: false, verify: false, waive: false },
        { fix: false, verify: true, waive: true },
      ]);
      expect((await trace(GUEST, handoverId)).items.map((item) => item.allowed)).toEqual([
        { fix: true, verify: false, waive: false },
        { fix: false, verify: false, waive: false },
      ]);
      expect((await trace(READER, handoverId)).handover.allowed).toEqual({ add_item: false, approve: false, return: false, reject: false });

      // What is outside the scope is not there.
      expect((await call('GET', `/handovers/${handoverId}/trace`, { member: OTHER_GUEST })).status).toBe(404);
      expect((await call('GET', `/handovers/${handoverId}/trace`, { member: ELSEWHERE })).status).toBe(404);
      expect((await call('GET', `/handovers/${handoverId}/trace`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/handovers/${randomUUID()}/trace`, { member: READER })).status).toBe(404);
      expect((await call('GET', `/resources/handover/${handoverId}`, { member: OTHER_GUEST })).status).toBe(404);
    });

    it('lists the handovers of the scope, the newest first and paged, with their counts', async () => {
      const target = await contract();
      const first = (await draft(DRAFTER, target)).json.resource_id as string;
      await addItem(DRAFTER, first, 1);
      const second = (await draft(DRAFTER, target)).json.resource_id as string;
      const all = await call('GET', `/resources/handover?contract_id=${target.id}`, { member: READER });
      expect((all.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([second, first]);
      expect((all.json.items as Array<Record<string, unknown>>)[1]).toMatchObject({
        status: 'PUNCH_PENDING',
        open_critical_punch_count: 1,
        punch_item_count: 1,
        recipient_unit: { id: unitId(RECEIVING_UNIT) },
      });
      const page = await call('GET', `/resources/handover?contract_id=${target.id}&limit=1`, { member: READER });
      expect((page.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([second]);
      const next = await call('GET', `/resources/handover?contract_id=${target.id}&limit=1&cursor=${page.json.next_cursor as string}`, { member: READER });
      expect((next.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([first]);
      expect(next.json.next_cursor).toBeNull();
      expect((await call('GET', `/resources/handover?contract_id=${target.id}&status=DRAFT`, { member: READER })).json.items).toHaveLength(1);
      expect((await call('GET', '/resources/handover?contract_id=nope', { member: READER })).status).toBe(422);
      expect((await call('GET', '/resources/handover?status=1', { member: READER })).status).toBe(422);
      expect((await call('GET', '/resources/handover?limit=0', { member: READER })).status).toBe(422);
      expect((await call('GET', '/resources/handover', { member: NOBODY })).status).toBe(403);
      // The receiving unit sees the handover although it holds no right over the contract; another branch sees nothing of it.
      expect(((await call('GET', `/resources/handover?contract_id=${target.id}`, { member: RECEIVER })).json.items as unknown[]).length).toBe(2);
      expect((await call('GET', `/resources/handover?contract_id=${target.id}`, { member: ELSEWHERE })).json.items).toEqual([]);
    });
  });
});
