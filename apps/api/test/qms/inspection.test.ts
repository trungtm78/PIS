import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { BASELINE_PACK, EffectiveAccessStore, InMemoryAuthzCache, PmtGateStore, TenantDatabase, applyBaseline } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { qmsModule } from '../../src/modules/qms';
import { InspectionController, InspectionReadsController } from '../../src/modules/qms/inspection.controller';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, contextFor, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xae;
const ROOT = 1;
const REQUESTER = 11; // inspection.request, inspection.read
const SUPERVISOR = 12; // inspection.manage, inspection.record, inspection.read
const RECORDER = 13; // inspection.record, inspection.read
const READER = 14; // inspection.read
const NOBODY = 15;
const ELSEWHERE = 16; // the rights of REQUESTER over another branch
const GUEST = 17; // the contractor of the contracts, invited to one
const SECOND_GUEST = 18;
const FIRST = 19; // a member who takes part in an inspection
const SECOND = 20;
const MEMBERS = [REQUESTER, SUPERVISOR, RECORDER, READER, NOBODY, ELSEWHERE, GUEST, SECOND_GUEST, FIRST, SECOND];
const OTHER_BRANCH = 5;
const PERMIT_TYPE = id(FAMILY, 60);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

describe('the inspections over HTTP (ST-QMS-004)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  const gates = new PmtGateStore();
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
  const audits = (resourceId: string, action: string) => rows<{ safe_diff: Record<string, unknown>; actor_id: string; reason: string | null }>('select safe_diff, actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at, id', [resourceId, action]);
  const events = (aggregateId: string, type: string) => rows<{ payload: Record<string, unknown>; aggregate_version: string }>('select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id', [aggregateId, type]);
  const stored = async (inspectionId: string) =>
    (await rows<{ status: string; version: string; result: string | null; required_roles: string[]; regime_awaiting_confirmation: boolean }>('select status, version::text, result, required_roles, regime_awaiting_confirmation from machvon.inspection where id = $1::uuid', [inspectionId]))[0];

  interface Contract {
    id: string;
    code: string;
    projectId: string;
    item: string;
  }

  async function contract(status = 'ACTIVE', category = 'CONSTRUCTION'): Promise<Contract> {
    counter += 1;
    const line = await world.publishedLine();
    const contractId = randomUUID();
    const item = randomUUID();
    const code = `HD-I-${String(counter).padStart(4, '0')}`;
    await seedAs(harness, [
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
            created_by, updated_by, signed_on, effective_from, status_reason, status_decision_document_version_id)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', $7, 1, 'Contract', $8, false, true, 1000000, $9, $9, date '2026-01-01', date '2026-01-02', $10, $11)`,
        [TENANT_A, contractId, line.projectId, randomUUID(), contractor, code, status, category, memberId(REQUESTER), status === 'SUSPENDED' ? 'Decided.' : null, status === 'SUSPENDED' ? id(FAMILY, 31) : null],
      ],
      [`insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by) values ($1, $2, $3, 'B01', 'Earthwork', 'M3', $4, $4)`, [TENANT_A, item, contractId, memberId(REQUESTER)]],
    ]);
    return { id: contractId, code, projectId: line.projectId, item };
  }

  const request = (member: number, target: Contract, overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', '/inspections', {
      member,
      ...(key === undefined ? {} : { key }),
      body: { contract_id: target.id, inspection_type: 'CONCEALED_WORK', title: 'Concealed work, footing F1', requested_for: '2026-12-31', ...overrides },
    });
  const schedule = (member: number, inspectionId: string, version: number | string = 1, overrides: Record<string, unknown> = {}) =>
    call('POST', `/inspections/${inspectionId}/schedule`, { member, ifMatch: `"${version}"`, body: { scheduled_at: inDays(3), participant_membership_ids: [memberId(FIRST), memberId(SECOND)], ...overrides } });
  const record = (member: number, inspectionId: string, version: number | string, overrides: Record<string, unknown> = {}) =>
    call('POST', `/inspections/${inspectionId}/result`, { member, ifMatch: `"${version}"`, body: { result: 'PASS', result_note: 'The work is right.', checklist: [], ...overrides } });
  const cancel = (member: number, inspectionId: string, version: number | string, reason = 'Moved to next week.') => call('POST', `/inspections/${inspectionId}/cancel`, { member, ifMatch: `"${version}"`, body: { reason } });
  const list = (member: number, query = '') => call('GET', `/inspections${query}`, { member });

  /** The first item of the checklist of the regime of 2026-12-31 under the working assumption: three items for a concealed work. */
  const passAll = [
    { code: 'DRAWING', outcome: 'PASS' },
    { code: 'QUALITY', outcome: 'PASS' },
    { code: 'RECORD', outcome: 'NA' },
  ];

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'QMS_REQUESTER', ['inspection.request', 'inspection.read'], 30],
      [2, 'QMS_SUPERVISOR', ['inspection.manage', 'inspection.record', 'inspection.read'], 40],
      [3, 'QMS_RECORDER', ['inspection.record', 'inspection.read'], 30],
      [4, 'QMS_READER', ['inspection.read'], 10],
      [5, 'QMS_GUEST', ['inspection.request', 'inspection.read'], 5],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 100 + n, code, permissions, rank);
    const grant = (n: number, member: number, role: number, extra: { kind?: 'TENANT' | 'UNIT_SUBTREE' | 'CONTRACT'; refs?: string[] } = {}) => ({ n, member, role: 100 + role, kind: extra.kind ?? 'TENANT', ...(extra.refs === undefined ? {} : { refs: extra.refs }) });
    await harness.seedGrants(TENANT_A, [
      grant(1, REQUESTER, 1),
      grant(2, SUPERVISOR, 2),
      grant(3, RECORDER, 3),
      grant(4, READER, 4),
      grant(5, ELSEWHERE, 1, { kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] }),
    ]);
    contractor = await seedContractor(harness);
    await seedAs(harness, [
      [
        `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, status, created_by, updated_by)
         values ($1, $2, 'GPXD', 'Building permit', 'OTHER', 'The authority', 'Fixture decree', '2025-01-01', '{}'::jsonb, 'PUBLISHED', $3, $3)`,
        [TENANT_A, PERMIT_TYPE, memberId(REQUESTER)],
      ],
    ]);
    // The regimes of the platform (the decree in force until the end of 2026 and the one that replaces it, both waiting for CXN-07) reach the tenant the way they do in a running system.
    await harness.tenants.withTenant(contextFor(TENANT_A, memberId(REQUESTER)), (tx) => applyBaseline(tx, BASELINE_PACK, memberId(REQUESTER), '2026-06-01'));
    for (const guest of [GUEST, SECOND_GUEST]) await world.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(guest), contractor]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [InspectionController, InspectionReadsController],
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

  beforeEach(async () => {
    await world.owner('delete from machvon.permit_gate_rule');
  });

  it('is registered in the module of QMS', () => {
    expect(qmsModule.controllers).toEqual(expect.arrayContaining([InspectionController, InspectionReadsController]));
  });

  describe('requestInspection (AC-ST-QMS-004-1, UAT-AC363)', () => {
    it('requests an inspection with the regime of its day, its audit row and its event, and answers the same key once', async () => {
      const target = await contract();
      const send = () => request(REQUESTER, target, { requested_for: '2026-12-31' }, 'request-once-for-this-key');
      const first = await send();
      expect(first).toMatchObject({ status: 200, json: { status: 'REQUESTED', resource_version: 1 } });
      expect(await send()).toEqual(first);
      const inspectionId = first.json.resource_id as string;
      expect(await rows('select id from machvon.inspection where contract_id = $1::uuid', [target.id])).toHaveLength(1);
      expect(await stored(inspectionId)).toMatchObject({ status: 'REQUESTED', required_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'], regime_awaiting_confirmation: true });
      const [audit] = await audits(inspectionId, 'inspection.requested');
      expect(audit).toMatchObject({
        actor_id: memberId(REQUESTER),
        safe_diff: { contract_id: target.id, inspection_no: 'KT-001', inspection_type: 'CONCEALED_WORK', required_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'], regime_awaiting_confirmation: true, from_status: null, to_status: 'REQUESTED' },
      });
      const [event] = await events(inspectionId, 'qms.inspection.requested.v1');
      expect(event?.payload).toMatchObject({ inspection_id: inspectionId, contract_id: target.id, project_id: target.projectId, status: 'REQUESTED', version: 1, actor_id: memberId(REQUESTER) });
      const read = await list(READER, `?contract_id=${target.id}`);
      expect((read.json.items as Array<Record<string, unknown>>)[0]).toMatchObject({
        id: inspectionId,
        inspection_no: 'KT-001',
        regime: { label: expect.any(String), awaiting_confirmation: true, cxn: 'CXN-07' },
        required_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'],
        status: 'REQUESTED',
      });
    });

    it('gives the day after the change of the regime the roles of the new one, the designer among them', async () => {
      const target = await contract();
      const later = await request(REQUESTER, target, { requested_for: '2027-01-01' });
      expect(later.status).toBe(200);
      expect((await stored(later.json.resource_id as string))?.required_roles).toEqual(['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER']);
      expect(await request(REQUESTER, target, { requested_for: '2024-05-01' })).toMatchObject({ status: 422, json: { code: 'REGIME_NOT_EFFECTIVE' } });
    });

    it('refuses a duplicate while one is open, a shape that is not one, a field that is not allowed and a contract not being performed', async () => {
      const target = await contract();
      expect((await request(REQUESTER, target, { boq_item_id: target.item })).status).toBe(200);
      expect(await request(REQUESTER, target, { boq_item_id: target.item })).toMatchObject({ status: 409, json: { code: 'INSPECTION_DUPLICATE' } });
      expect(await request(REQUESTER, target, { inspection_type: 'OTHER_KIND' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await request(REQUESTER, target, { title: '  ' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await request(REQUESTER, target, { requested_for: '2026-02-30' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await request(REQUESTER, target, { status: 'RESULT_RECORDED', required_roles: ['OWNER'] })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await request(REQUESTER, await contract('SUSPENDED'))).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID' } });
    });

    it('AC-ST-QMS-004-2, UAT-AC369: is blocked while the permits of the start of construction are missing, and names the gate', async () => {
      const target = await contract('ACTIVE', 'CONSTRUCTION');
      await harness.tenants.withTenant(contextFor(TENANT_A, memberId(REQUESTER)), (tx) =>
        gates.publish(tx, { gateCode: 'START_CONSTRUCTION', permitTypeId: PERMIT_TYPE, requirement: 'VALID_PERMIT', appliesToRule: {}, legalBasis: 'Fixture decree', effectiveFrom: '2025-01-01' }, memberId(REQUESTER)),
      );
      expect(await request(REQUESTER, target)).toMatchObject({ status: 422, json: { code: 'PERMIT_GATE_BLOCKED', gate_code: 'START_CONSTRUCTION', blocking: [expect.objectContaining({ permit_type_code: 'GPXD' })] } });
      expect(await rows('select id from machvon.inspection where contract_id = $1::uuid', [target.id])).toEqual([]);
      await world.owner('delete from machvon.permit_gate_rule');
      expect((await request(REQUESTER, target)).status).toBe(200);
    });

    it('is for whoever holds the permission over the contract, and a guest contractor requests only in the contract it was invited to', async () => {
      const target = await contract();
      const other = await contract();
      expect((await request(READER, target)).status).toBe(403);
      expect((await request(NOBODY, target)).status).toBe(403);
      expect((await request(ELSEWHERE, target)).status).toBe(404);
      expect((await request(REQUESTER, { ...target, id: randomUUID() })).status).toBe(404);
      await harness.seedGrants(TENANT_A, [{ n: 41, member: GUEST, role: 105, kind: 'CONTRACT', refs: [target.id] }]);
      const own = await request(GUEST, target);
      expect(own).toMatchObject({ status: 200, json: { status: 'REQUESTED' } });
      expect((await audits(own.json.resource_id as string, 'inspection.requested'))[0]).toMatchObject({ actor_id: memberId(GUEST) });
      expect((await request(GUEST, other)).status).toBe(404);
      expect(await rows('select id from machvon.inspection where contract_id = $1::uuid', [other.id])).toEqual([]);
    });
  });

  describe('scheduleInspection and recordInspectionResult (AC-ST-QMS-004-3, UAT-AC360)', () => {
    it('schedules a request and records its result against the checklist, with the audit rows and the events, and keeps it as it is afterwards', async () => {
      const target = await contract();
      const made = await request(REQUESTER, target, { boq_item_id: target.item });
      const inspectionId = made.json.resource_id as string;
      expect((await schedule(REQUESTER, inspectionId)).status).toBe(403);
      const scheduled = await schedule(SUPERVISOR, inspectionId);
      expect(scheduled).toMatchObject({ status: 200, json: { status: 'SCHEDULED', resource_version: 2 } });
      expect((await audits(inspectionId, 'inspection.scheduled'))[0]).toMatchObject({ actor_id: memberId(SUPERVISOR), safe_diff: { from_status: 'REQUESTED', to_status: 'SCHEDULED', participant_membership_ids: [memberId(FIRST), memberId(SECOND)] } });
      expect((await events(inspectionId, 'qms.inspection.scheduled.v1'))[0]?.payload).toMatchObject({ status: 'SCHEDULED', version: 2 });

      // The checklist must answer every item the inspection was given.
      expect(await record(RECORDER, inspectionId, 2, { checklist: [{ code: 'DRAWING', outcome: 'PASS' }] })).toMatchObject({ status: 422, json: { code: 'CHECKLIST_INCOMPLETE', reason: 'ITEMS_MISSING', codes: ['QUALITY', 'RECORD'] } });
      expect(await record(RECORDER, inspectionId, 2, { result: 'FAIL', checklist: passAll })).toMatchObject({ status: 422, json: { code: 'CHECKLIST_INCOMPLETE', reason: 'RESULT_CONTRADICTS' } });
      expect((await stored(inspectionId))?.status).toBe('SCHEDULED');
      const done = await record(RECORDER, inspectionId, 2, { checklist: passAll });
      expect(done).toMatchObject({ status: 200, json: { status: 'RESULT_RECORDED', resource_version: 3 } });
      expect(await stored(inspectionId)).toMatchObject({ status: 'RESULT_RECORDED', result: 'PASS', version: '3' });
      const [audit] = await audits(inspectionId, 'inspection.result_recorded');
      expect(audit).toMatchObject({ actor_id: memberId(RECORDER), reason: 'The work is right.', safe_diff: { from_status: 'SCHEDULED', to_status: 'RESULT_RECORDED', result: 'PASS', failed_item_codes: [] } });
      expect((await events(inspectionId, 'qms.inspection.result_recorded.v1'))[0]?.payload).toMatchObject({ result: 'PASS', status: 'RESULT_RECORDED' });
      expect(JSON.stringify((await events(inspectionId, 'qms.inspection.result_recorded.v1'))[0]?.payload)).not.toContain('The work is right.');
      expect(await record(RECORDER, inspectionId, 3, { checklist: passAll })).toMatchObject({ status: 409, json: { code: 'INSPECTION_STATE_INVALID', inspection_status: 'RESULT_RECORDED' } });
      expect(await cancel(SUPERVISOR, inspectionId, 3)).toMatchObject({ status: 409, json: { code: 'INSPECTION_STATE_INVALID' } });
    });

    it('records a failed result with the items that failed in the event, the next step starting from them', async () => {
      const target = await contract();
      const made = await request(REQUESTER, target);
      const inspectionId = made.json.resource_id as string;
      await schedule(SUPERVISOR, inspectionId);
      const done = await record(SUPERVISOR, inspectionId, 2, { result: 'FAIL', checklist: [{ code: 'DRAWING', outcome: 'FAIL' }, { code: 'QUALITY', outcome: 'PASS' }, { code: 'RECORD', outcome: 'PASS' }] });
      expect(done).toMatchObject({ status: 200, json: { status: 'RESULT_RECORDED' } });
      expect((await events(inspectionId, 'qms.inspection.result_recorded.v1'))[0]?.payload).toMatchObject({ result: 'FAIL', failed_item_codes: ['DRAWING'] });
    });

    it('refuses a schedule in the past or with people who are not members, a stale version, and the wrong state', async () => {
      const target = await contract();
      const inspectionId = (await request(REQUESTER, target)).json.resource_id as string;
      expect(await schedule(SUPERVISOR, inspectionId, 1, { scheduled_at: inDays(-2) })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await schedule(SUPERVISOR, inspectionId, 1, { participant_membership_ids: [randomUUID()] })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await schedule(SUPERVISOR, inspectionId, 5)).toMatchObject({ status: 409 });
      expect(await record(SUPERVISOR, inspectionId, 1)).toMatchObject({ status: 409, json: { code: 'INSPECTION_STATE_INVALID', inspection_status: 'REQUESTED' } });
      expect((await schedule(READER, inspectionId)).status).toBe(403);
      expect((await schedule(ELSEWHERE, inspectionId)).status).toBe(403);
      expect((await schedule(SUPERVISOR, randomUUID())).status).toBe(404);
      expect(await schedule(SUPERVISOR, inspectionId, 1)).toMatchObject({ status: 200 });
      expect(await schedule(SUPERVISOR, inspectionId, 2)).toMatchObject({ status: 409, json: { code: 'INSPECTION_STATE_INVALID', inspection_status: 'SCHEDULED' } });
    });
  });

  describe('cancelInspection', () => {
    it('cancels an inspection with the reason, audits it and tells the world', async () => {
      const target = await contract();
      const inspectionId = (await request(REQUESTER, target)).json.resource_id as string;
      expect((await cancel(REQUESTER, inspectionId, 1)).status).toBe(403);
      expect(await cancel(SUPERVISOR, inspectionId, 1, ' ')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await cancel(SUPERVISOR, inspectionId, 1)).toMatchObject({ status: 200, json: { status: 'CANCELLED', resource_version: 2 } });
      expect((await audits(inspectionId, 'inspection.cancelled'))[0]).toMatchObject({ actor_id: memberId(SUPERVISOR), reason: 'Moved to next week.', safe_diff: { from_status: 'REQUESTED', to_status: 'CANCELLED' } });
      expect((await events(inspectionId, 'qms.inspection.cancelled.v1'))[0]?.payload).toMatchObject({ status: 'CANCELLED' });
      expect(await cancel(SUPERVISOR, inspectionId, 2)).toMatchObject({ status: 409, json: { code: 'INSPECTION_STATE_INVALID' } });
      // A cancelled request frees the place for the next one.
      expect((await request(REQUESTER, target)).status).toBe(200);
    });
  });

  describe('the resource /inspections', () => {
    it('lists the inspections in the scope with what the caller may do, and reads one', async () => {
      const target = await contract();
      const made = (await request(REQUESTER, target, { requested_for: '2026-12-30' })).json.resource_id as string;
      const scheduled = (await request(REQUESTER, target, { requested_for: '2026-12-31' })).json.resource_id as string;
      await schedule(SUPERVISOR, scheduled);
      const seen = await list(SUPERVISOR, `?contract_id=${target.id}`);
      expect(seen.status).toBe(200);
      const items = seen.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id)).toEqual([scheduled, made]);
      expect(items[0]).toMatchObject({ status: 'SCHEDULED', participants: [{ membership_id: memberId(FIRST) }, { membership_id: memberId(SECOND) }], actions: { schedule: false, record: true, cancel: true } });
      expect(items[1]).toMatchObject({ status: 'REQUESTED', actions: { schedule: true, record: false, cancel: true } });
      const reader = (await list(READER, `?contract_id=${target.id}`)).json.items as Array<Record<string, Record<string, boolean>>>;
      expect(reader.every((item) => Object.values(item.actions ?? {}).every((value) => value === false))).toBe(true);
      const recorder = (await list(RECORDER, `?contract_id=${target.id}`)).json.items as Array<Record<string, Record<string, boolean>>>;
      expect(recorder.map((item) => item.actions?.record)).toEqual([true, false]);
      expect(Object.keys(items[0] ?? {}).sort()).toEqual(
        [
          'actions', 'boq_item', 'cancel_reason', 'checklist', 'contract', 'created_at', 'id', 'inspection_no', 'inspection_type', 'location_text', 'participants', 'project_id', 'regime', 'required_roles', 'requested_by', 'requested_for',
          'result', 'result_note', 'result_recorded_at', 'scheduled_at', 'site_diary_id', 'status', 'title', 'version',
        ].sort(),
      );
      const one = await call('GET', `/inspections/${scheduled}`, { member: READER });
      expect(one).toMatchObject({ status: 200, json: { id: scheduled, status: 'SCHEDULED' } });
      expect((await call('GET', `/inspections/${scheduled}`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/inspections/${randomUUID()}`, { member: READER })).status).toBe(404);
      expect(await list(READER, '?contract_id=nope')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect((await list(NOBODY)).status).toBe(403);
    });

    it('shows a guest contractor the inspections of its own contract and nothing of another', async () => {
      const target = await contract();
      const other = await contract();
      await request(REQUESTER, other);
      await harness.seedGrants(TENANT_A, [{ n: 42, member: SECOND_GUEST, role: 105, kind: 'CONTRACT', refs: [target.id] }]);
      const own = await request(SECOND_GUEST, target);
      const items = (await list(SECOND_GUEST)).json.items as Array<{ id: string; contract: { id: string } }>;
      expect(items.map((item) => item.id)).toEqual([own.json.resource_id]);
      expect(new Set(items.map((item) => item.contract.id))).toEqual(new Set([target.id]));
      const foreign = (await rows<{ id: string }>('select id from machvon.inspection where contract_id = $1::uuid', [other.id]))[0]?.id;
      expect((await call('GET', `/inspections/${foreign}`, { member: SECOND_GUEST })).status).toBe(404);
    });
  });
});
