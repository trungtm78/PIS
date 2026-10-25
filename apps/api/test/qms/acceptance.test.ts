import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { BASELINE_PACK, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, applyBaseline } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { qmsModule } from '../../src/modules/qms';
import { AcceptanceController, AcceptanceReadsController } from '../../src/modules/qms/acceptance.controller';
import { InspectionController, InspectionReadsController } from '../../src/modules/qms/inspection.controller';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, contextFor, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xaf;
const ROOT = 1;
const DRAFTER = 21; // drafts the minutes, signs as the supervisor, requests, schedules and records inspections
const OWNER = 22; // signs as the owner, approves and revokes
const READER = 23; // qacceptance.read
const NOBODY = 25;
const ELSEWHERE = 26; // the rights of DRAFTER over another branch
const FIRST = 27; // a member who takes part in an inspection
const OTHER_BRANCH = 5;
const DOCUMENT = id(FAMILY, 30);
const VERSION = id(FAMILY, 31);
const MEMBERS = [DRAFTER, OWNER, READER, NOBODY, ELSEWHERE, FIRST];
/** The guests of the contractor, one for each contract they are invited to (the access of a member is cached by the token, so a new invitation is a new member). */
const FIRST_GUEST = 40;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();
const PASS_ALL = [
  { code: 'DRAWING', outcome: 'PASS' },
  { code: 'QUALITY', outcome: 'PASS' },
  { code: 'RECORD', outcome: 'NA' },
];

describe('the quality acceptance minutes over HTTP (ST-QMS-005)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let counter = 0;
  let grants = 60;
  let guests = FIRST_GUEST;
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
  const stored = async (minutesId: string) => (await rows<{ status: string; version: string; required_roles: string[]; approved_by: string | null }>('select status, version::text, required_roles, approved_by from machvon.quality_acceptance where id = $1::uuid', [minutesId]))[0];

  interface Contract {
    id: string;
    code: string;
    projectId: string;
    item: string;
  }

  async function contract(status = 'ACTIVE'): Promise<Contract> {
    counter += 1;
    const line = await world.publishedLine();
    const contractId = randomUUID();
    const item = randomUUID();
    const code = `HD-Q-${String(counter).padStart(4, '0')}`;
    await seedAs(harness, [
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
            created_by, updated_by, signed_on, effective_from, status_reason, status_decision_document_version_id)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', $7, 1, 'Contract', 'OTHER', false, true, 1000000, $8, $8, date '2026-01-01', date '2026-01-02', $9, $10)`,
        [TENANT_A, contractId, line.projectId, randomUUID(), contractor, code, status, memberId(DRAFTER), status === 'SUSPENDED' ? 'Decided.' : null, status === 'SUSPENDED' ? VERSION : null],
      ],
      [`insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by) values ($1, $2, $3, 'B01', 'Earthwork', 'M3', $4, $4)`, [TENANT_A, item, contractId, memberId(DRAFTER)]],
    ]);
    return { id: contractId, code, projectId: line.projectId, item };
  }

  /** An inspection of the contract that was asked for, scheduled and recorded, with the result given. */
  async function inspected(target: Contract, result = 'PASS'): Promise<string> {
    const made = await call('POST', '/inspections', { member: DRAFTER, body: { contract_id: target.id, boq_item_id: target.item, inspection_type: 'CONCEALED_WORK', title: `Footing ${counter}`, requested_for: '2026-12-31' } });
    const inspectionId = made.json.resource_id as string;
    await call('POST', `/inspections/${inspectionId}/schedule`, { member: DRAFTER, ifMatch: '"1"', body: { scheduled_at: inDays(3), participant_membership_ids: [memberId(FIRST)] } });
    const checklist = result === 'PASS' ? PASS_ALL : [{ code: 'DRAWING', outcome: 'FAIL' }, PASS_ALL[1], PASS_ALL[2]];
    const recorded = await call('POST', `/inspections/${inspectionId}/result`, { member: DRAFTER, ifMatch: '"2"', body: { result, result_note: 'Result recorded.', checklist } });
    expect(recorded.status).toBe(200);
    return inspectionId;
  }

  const draft = (member: number, inspectionId: string, overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', `/inspections/${inspectionId}/quality-acceptances`, { member, ...(key === undefined ? {} : { key }), body: { acceptance_scope: 'WORK_ITEM', record_no: `QA-W-${String(++counter).padStart(3, '0')}`, document_version_id: VERSION, ...overrides } });
  const sign = (member: number, minutesId: string, version: number | string, role: string, overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', `/quality-acceptances/${minutesId}/sign`, { member, ifMatch: `"${version}"`, ...(key === undefined ? {} : { key }), body: { signer_role: role, signature_method: 'IN_APP_OTP', client_operation_id: randomUUID(), ...overrides } });
  const decide = (member: number, minutesId: string, version: number | string, decision = 'approve', reason = 'Every role has signed.', key?: string) =>
    call('POST', `/quality-acceptances/${minutesId}/decision`, { member, ifMatch: `"${version}"`, ...(key === undefined ? {} : { key }), body: { decision, reason } });
  const revoke = (member: number, minutesId: string, version: number | string, reason = 'The work was found to be defective.') => call('POST', `/quality-acceptances/${minutesId}/revoke`, { member, ifMatch: `"${version}"`, body: { reason } });
  const list = (member: number, query = '') => call('GET', `/quality-acceptances${query}`, { member });

  /** A guest of the contractor, invited to one contract: the member number. */
  async function guestOf(target: Contract): Promise<number> {
    guests += 1;
    grants += 1;
    await harness.seedMembership(TENANT_A, guests, ROOT);
    await world.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(guests), contractor]);
    await harness.seedGrants(TENANT_A, [{ n: grants, member: guests, role: 104, kind: 'CONTRACT', refs: [target.id] }]);
    return guests;
  }

  /** Minutes signed by the contractor (the guest), the supervisor (the drafter) and the owner. */
  async function signedByAll(target: Contract): Promise<{ id: string; version: number; inspectionId: string; guest: number }> {
    const guest = await guestOf(target);
    const inspectionId = await inspected(target);
    const minutesId = (await draft(DRAFTER, inspectionId)).json.resource_id as string;
    const first = await sign(guest, minutesId, 1, 'CONTRACTOR');
    const second = await sign(DRAFTER, minutesId, first.json.resource_version as number, 'SUPERVISOR');
    const third = await sign(OWNER, minutesId, second.json.resource_version as number, 'OWNER');
    expect(third.status).toBe(200);
    return { id: minutesId, version: third.json.resource_version as number, inspectionId, guest };
  }

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'QMS_DRAFTER', ['qacceptance.manage', 'qacceptance.sign', 'qacceptance.read', 'inspection.request', 'inspection.manage', 'inspection.record', 'inspection.read'], 40],
      [2, 'QMS_OWNER', ['qacceptance.sign', 'qacceptance.approve', 'qacceptance.revoke', 'qacceptance.read'], 40],
      [3, 'QMS_READER', ['qacceptance.read'], 10],
      [4, 'QMS_GUEST', ['qacceptance.sign', 'qacceptance.read', 'inspection.read'], 5],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 100 + n, code, permissions, rank);
    const grant = (n: number, member: number, role: number, extra: { kind?: 'TENANT' | 'UNIT_SUBTREE'; refs?: string[] } = {}) => ({ n, member, role: 100 + role, kind: extra.kind ?? 'TENANT', ...(extra.refs === undefined ? {} : { refs: extra.refs }) });
    await harness.seedGrants(TENANT_A, [grant(1, DRAFTER, 1), grant(2, OWNER, 2), grant(3, READER, 3), grant(4, ELSEWHERE, 1, { kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] })]);
    contractor = await seedContractor(harness);
    await seedAs(harness, [
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Minutes', 'INTERNAL', $3, $3)`, [TENANT_A, DOCUMENT, memberId(DRAFTER)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/qms/minutes.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, VERSION, DOCUMENT],
      ],
    ]);
    await harness.tenants.withTenant(contextFor(TENANT_A, memberId(DRAFTER)), (tx) => applyBaseline(tx, BASELINE_PACK, memberId(DRAFTER), '2026-06-01'));
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [InspectionController, InspectionReadsController, AcceptanceController, AcceptanceReadsController],
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
    expect(qmsModule.controllers).toEqual(expect.arrayContaining([AcceptanceController, AcceptanceReadsController]));
  });

  it('AC-ST-QMS-005-1, UAT-AC360: is refused with two signatures, and with all three the owner approves it and CTR receives one event', async () => {
    const target = await contract();
    const guest = await guestOf(target);
    const inspectionId = await inspected(target);
    const drafted = await draft(DRAFTER, inspectionId, { record_no: 'QA-W-001' }, 'draft-once-for-this-key');
    expect(drafted).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1 } });
    expect(await draft(DRAFTER, inspectionId, { record_no: 'QA-W-001' }, 'draft-once-for-this-key')).toEqual(drafted);
    const minutesId = drafted.json.resource_id as string;
    expect(await rows('select id from machvon.quality_acceptance where contract_id = $1::uuid', [target.id])).toHaveLength(1);
    expect(await stored(minutesId)).toMatchObject({ status: 'DRAFT', required_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'] });
    expect((await audits(minutesId, 'quality_acceptance.drafted'))[0]).toMatchObject({ actor_id: memberId(DRAFTER), safe_diff: { record_no: 'QA-W-001', acceptance_scope: 'WORK_ITEM', inspection_id: inspectionId, boq_item_id: target.item, from_status: null, to_status: 'DRAFT' } });
    expect((await events(minutesId, 'qms.quality_acceptance.drafted.v1'))[0]?.payload).toMatchObject({ quality_acceptance_id: minutesId, contract_id: target.id, status: 'DRAFT' });

    const first = await sign(guest, minutesId, 1, 'CONTRACTOR');
    expect(first).toMatchObject({ status: 200, json: { status: 'SIGNING', resource_version: 2 } });
    const second = await sign(DRAFTER, minutesId, 2, 'SUPERVISOR', { signature_method: 'DIGITAL_CERT', cert_serial: 'SN-0099' });
    expect(second).toMatchObject({ status: 200, json: { status: 'SIGNING', resource_version: 3 } });
    expect((await audits(minutesId, 'quality_acceptance.signed')).map((audit) => audit.safe_diff)).toEqual([
      expect.objectContaining({ signer_role: 'CONTRACTOR', signature_method: 'IN_APP_OTP', legal_effect: 'INTERNAL_RECORD', missing_roles: ['SUPERVISOR', 'OWNER'] }),
      expect.objectContaining({ signer_role: 'SUPERVISOR', signature_method: 'DIGITAL_CERT', legal_effect: 'LEGAL_E_SIGNATURE', missing_roles: ['OWNER'] }),
    ]);

    // Two signatures are not enough: the owner is told that the owner is missing.
    expect(await decide(OWNER, minutesId, 3)).toMatchObject({ status: 422, json: { code: 'SIGNATURES_INCOMPLETE', missing_roles: ['OWNER'] } });
    expect((await stored(minutesId))?.status).toBe('SIGNING');
    expect(await events(minutesId, 'qms.quality_acceptance.approved.v1')).toEqual([]);

    // The same role over the same hash cannot sign twice.
    expect(await sign(READER, minutesId, 3, 'SUPERVISOR')).toMatchObject({ status: 403 });
    expect(await sign(OWNER, minutesId, 3, 'SUPERVISOR')).toMatchObject({ status: 409, json: { code: 'ALREADY_SIGNED' } });
    const third = await sign(OWNER, minutesId, 3, 'OWNER');
    expect(third).toMatchObject({ status: 200, json: { resource_version: 4 } });

    // The one who drafted the minutes does not approve them; the owner does.
    expect(await decide(DRAFTER, minutesId, 4)).toMatchObject({ status: 403 });
    const approved = await decide(OWNER, minutesId, 4, 'approve', 'Reviewed on site.', 'approve-once-for-this-key');
    expect(approved).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_version: 5 } });
    expect(await decide(OWNER, minutesId, 4, 'approve', 'Reviewed on site.', 'approve-once-for-this-key')).toEqual(approved);
    expect(await stored(minutesId)).toMatchObject({ status: 'APPROVED', approved_by: memberId(OWNER), version: '5' });
    const sent = await events(minutesId, 'qms.quality_acceptance.approved.v1');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({ quality_acceptance_id: minutesId, contract_id: target.id, inspection_id: inspectionId, boq_item_id: target.item, acceptance_scope: 'WORK_ITEM', status: 'APPROVED', version: 5, actor_id: memberId(OWNER) });
    expect(JSON.stringify(sent[0]?.payload)).not.toContain('Reviewed on site.');
    expect((await audits(minutesId, 'quality_acceptance.approved'))[0]).toMatchObject({ actor_id: memberId(OWNER), reason: 'Reviewed on site.', safe_diff: { from_status: 'SIGNING', to_status: 'APPROVED' } });
    expect(await decide(OWNER, minutesId, 5)).toMatchObject({ status: 409, json: { code: 'QUALITY_ACCEPTANCE_STATE_INVALID', acceptance_status: 'APPROVED' } });
  });

  it('AC-ST-QMS-005-2, UAT-PLAN-27: revoking approved minutes emits the event once, and is refused while an approved acceptance holds them', async () => {
    const target = await contract();
    const all = await signedByAll(target);
    const approved = await decide(OWNER, all.id, all.version);
    const version = approved.json.resource_version as number;
    expect((await revoke(DRAFTER, all.id, version)).status).toBe(403);
    expect(await revoke(OWNER, all.id, version, '  ')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });

    const acceptanceId = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.acceptance (tenant_id, id, contract_id, measurement_ids, document_version_id, approved_at, signer_refs, status, version, accepted_amount_vnd, quality_acceptance_id, decided_by, submitted_by, submitted_at, decision_reason)
         values ($1, $2, $3, jsonb_build_array(gen_random_uuid()::text), $4, now(), '[]'::jsonb, 'APPROVED', 1, 100, $5, $6, $7, now(), 'ok')`,
        [TENANT_A, acceptanceId, target.id, VERSION, all.id, memberId(FIRST), memberId(DRAFTER)],
      ],
    ]);
    expect(await revoke(OWNER, all.id, version)).toMatchObject({ status: 409, json: { code: 'ACCEPTANCE_ALREADY_USED', acceptance_id: acceptanceId } });
    expect(await events(all.id, 'qms.quality_acceptance.revoked.v1')).toEqual([]);
    await seedAs(harness, [["update machvon.acceptance set status = 'REVOKED', revoked_at = now(), revoked_by = $2::uuid, revoke_reason = 'Withdrawn.', revoke_approval_document_version_id = $3::uuid where id = $1::uuid", [acceptanceId, memberId(READER), VERSION]]]);

    const revoked = await revoke(OWNER, all.id, version);
    expect(revoked).toMatchObject({ status: 200, json: { status: 'REVOKED', resource_version: version + 1 } });
    const sent = await events(all.id, 'qms.quality_acceptance.revoked.v1');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({ quality_acceptance_id: all.id, contract_id: target.id, boq_item_id: target.item, acceptance_scope: 'WORK_ITEM', status: 'REVOKED', from_status: 'APPROVED' });
    expect((await audits(all.id, 'quality_acceptance.revoked'))[0]).toMatchObject({ actor_id: memberId(OWNER), reason: 'The work was found to be defective.' });
    expect(await revoke(OWNER, all.id, version + 1)).toMatchObject({ status: 409, json: { code: 'QUALITY_ACCEPTANCE_STATE_INVALID' } });
    // The inspection can be drafted anew once the minutes are revoked.
    expect((await draft(DRAFTER, all.inspectionId)).status).toBe(200);
  });

  it('rejects minutes with the reason: audited, kept, and no approval event', async () => {
    const target = await contract();
    const guest = await guestOf(target);
    const minutesId = (await draft(DRAFTER, await inspected(target))).json.resource_id as string;
    const signed = await sign(guest, minutesId, 1, 'CONTRACTOR');
    expect(await decide(OWNER, minutesId, signed.json.resource_version as number, 'reject', ' ')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await decide(OWNER, minutesId, signed.json.resource_version as number, 'maybe')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    const rejected = await decide(OWNER, minutesId, signed.json.resource_version as number, 'reject', 'The paper is the wrong one.');
    expect(rejected).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
    expect((await audits(minutesId, 'quality_acceptance.rejected'))[0]).toMatchObject({ actor_id: memberId(OWNER), reason: 'The paper is the wrong one.', safe_diff: { from_status: 'SIGNING', to_status: 'REJECTED' } });
    expect(await events(minutesId, 'qms.quality_acceptance.approved.v1')).toEqual([]);
    expect(await sign(OWNER, minutesId, rejected.json.resource_version as number, 'OWNER')).toMatchObject({ status: 409, json: { code: 'QUALITY_ACCEPTANCE_STATE_INVALID' } });
  });

  describe('drafting', () => {
    it('refuses an inspection that did not pass, a serious non-conformance that is open, a field that is not allowed, and a contract not being performed', async () => {
      const target = await contract();
      expect(await draft(DRAFTER, await inspected(target, 'FAIL'))).toMatchObject({ status: 422, json: { code: 'INSPECTION_NOT_PASSED' } });
      const inspectionId = await inspected(target);
      const nid = randomUUID();
      await seedAs(harness, [
        [
          `insert into machvon.quality_nonconformance (tenant_id, id, project_id, contract_id, severity, action_owner_id, due_at, status, closure_evidence, blocks_acceptance)
           values ($1, $2, $3, $4, 'CRITICAL', $5, now() + interval '7 days', 'OPEN', '[]'::jsonb, true)`,
          [TENANT_A, nid, target.projectId, target.id, memberId(DRAFTER)],
        ],
      ]);
      expect(await draft(DRAFTER, inspectionId)).toMatchObject({ status: 422, json: { code: 'OPEN_CRITICAL_NCR', nonconformance_ids: [nid] } });
      await world.owner("update machvon.quality_nonconformance set status = 'CLOSED', verified_by = $2::uuid, closed_by = $2::uuid, closed_at = now() where id = $1::uuid", [nid, memberId(FIRST)]);
      expect(await draft(DRAFTER, inspectionId, { status: 'APPROVED', required_roles: ['OWNER'] })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await draft(DRAFTER, inspectionId, { acceptance_scope: 'COMPLETION' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await draft(DRAFTER, inspectionId, { document_version_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect((await draft(DRAFTER, inspectionId)).status).toBe(200);
      expect(await draft(DRAFTER, inspectionId)).toMatchObject({ status: 409, json: { code: 'QUALITY_ACCEPTANCE_STATE_INVALID', reason: 'ALREADY_DRAFTED' } });
      const stopped = await contract();
      const stoppedInspection = await inspected(stopped);
      await world.owner("update machvon.contract set status = 'SUSPENDED', status_reason = 'Decided.', status_decision_document_version_id = $2::uuid where id = $1::uuid", [stopped.id, VERSION]);
      expect(await draft(DRAFTER, stoppedInspection)).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID' } });
    });

    it('is for whoever holds the permission over the contract', async () => {
      const target = await contract();
      const inspectionId = await inspected(target);
      expect((await draft(READER, inspectionId)).status).toBe(403);
      expect((await draft(NOBODY, inspectionId)).status).toBe(403);
      expect((await draft(ELSEWHERE, inspectionId)).status).toBe(404);
      expect((await draft(DRAFTER, randomUUID())).status).toBe(404);
      expect(await rows('select id from machvon.quality_acceptance where contract_id = $1::uuid', [target.id])).toEqual([]);
    });
  });

  describe('signing', () => {
    it('signs only as a role of the minutes and only for the side of the signer, with a method that is accepted, once per role and once per person', async () => {
      const target = await contract();
      const guest = await guestOf(target);
      const minutesId = (await draft(DRAFTER, await inspected(target))).json.resource_id as string;
      expect(await sign(DRAFTER, minutesId, 1, 'DESIGNER')).toMatchObject({ status: 422, json: { code: 'ROLE_NOT_REQUIRED', required_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'] } });
      // The staff does not sign for the contractor, and the contractor does not sign for the owner.
      expect(await sign(DRAFTER, minutesId, 1, 'CONTRACTOR')).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await sign(guest, minutesId, 1, 'OWNER')).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await sign(DRAFTER, minutesId, 1, 'SUPERVISOR', { signature_method: 'DIGITAL_CERT' })).toMatchObject({ status: 422, json: { code: 'SIGNATURE_METHOD_NOT_ACCEPTED' } });
      expect(await sign(DRAFTER, minutesId, 1, 'SUPERVISOR', { signature_method: 'IN_APP_OTP', cert_serial: 'SN-0099' })).toMatchObject({ status: 422, json: { code: 'SIGNATURE_METHOD_NOT_ACCEPTED' } });
      expect(await sign(DRAFTER, minutesId, 1, 'SUPERVISOR', { signature_method: 'FAX' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await sign(DRAFTER, minutesId, 9, 'SUPERVISOR')).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect((await sign(DRAFTER, minutesId, 1, 'SUPERVISOR')).status).toBe(200);
      expect(await sign(DRAFTER, minutesId, 2, 'OWNER')).toMatchObject({ status: 409, json: { code: 'ALREADY_SIGNED' } });
      expect(await sign(NOBODY, minutesId, 2, 'OWNER')).toMatchObject({ status: 403 });
      expect(await sign(ELSEWHERE, minutesId, 2, 'OWNER')).toMatchObject({ status: 404 });
      expect(await sign(DRAFTER, randomUUID(), 1, 'SUPERVISOR')).toMatchObject({ status: 404 });
      expect(await rows('select id from machvon.qms_signature where subject_id = $1::uuid', [minutesId])).toHaveLength(1);
    });
  });

  describe('the resource /quality-acceptances', () => {
    it('lists the minutes in the scope with the signatures and what the caller may do, and reads one', async () => {
      const target = await contract();
      const guest = await guestOf(target);
      const inspectionId = await inspected(target);
      const minutesId = (await draft(DRAFTER, inspectionId)).json.resource_id as string;
      await sign(guest, minutesId, 1, 'CONTRACTOR');
      await sign(DRAFTER, minutesId, 2, 'SUPERVISOR');

      const seen = await list(OWNER, `?contract_id=${target.id}`);
      expect(seen.status).toBe(200);
      const [line] = seen.json.items as Array<Record<string, unknown>>;
      expect(line).toMatchObject({
        id: minutesId,
        contract: { id: target.id, code: target.code, status: 'ACTIVE' },
        inspection: { id: inspectionId, inspection_type: 'CONCEALED_WORK', result: 'PASS' },
        boq_item: { id: target.item, business_key: 'B01' },
        acceptance_scope: 'WORK_ITEM',
        status: 'SIGNING',
        required_roles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'],
        missing_roles: ['OWNER'],
        open_critical_ncr: 0,
        regime: { awaiting_confirmation: true, cxn: 'CXN-07' },
        signable_roles: ['OWNER'],
        actions: { sign: true, approve: true, reject: true, revoke: false },
        created_by: { membership_id: memberId(DRAFTER) },
        version: 3,
      });
      expect((line?.signatures as Array<Record<string, unknown>>).map((signature) => [signature.role, signature.valid, signature.legal_effect])).toEqual([
        ['CONTRACTOR', true, 'INTERNAL_RECORD'],
        ['SUPERVISOR', true, 'INTERNAL_RECORD'],
      ]);
      expect(Object.keys(line ?? {}).sort()).toEqual(
        [
          'actions', 'approved_at', 'approved_by', 'acceptance_scope', 'boq_item', 'contract', 'created_at', 'created_by', 'decision_note', 'document_version_id', 'id', 'inspection', 'missing_roles', 'open_critical_ncr', 'project_id', 'record_no',
          'regime', 'required_roles', 'revoke_reason', 'revoked_at', 'signable_roles', 'signatures', 'status', 'version',
        ].sort(),
      );
      // The drafter does not approve; whoever signed does not sign again; a reader has no button; the guest sees its own contract only.
      expect(((await list(DRAFTER, `?inspection_id=${inspectionId}`)).json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ signable_roles: [], actions: { sign: false, approve: false, reject: false, revoke: false } });
      expect(((await list(READER)).json.items as Array<Record<string, unknown>>).every((item) => Object.values(item.actions as Record<string, boolean>).every((value) => value === false))).toBe(true);
      expect(((await list(guest)).json.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([minutesId]);
      expect(((await list(guest)).json.items as Array<Record<string, unknown>>)[0]).toMatchObject({ signable_roles: [], actions: { sign: false } });
      expect((await list(ELSEWHERE)).json.items).toEqual([]);
      expect((await list(NOBODY)).status).toBe(403);
      expect(await list(OWNER, '?contract_id=nope')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await list(OWNER, '?inspection_id=nope')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect((await list(OWNER, `?inspection_id=${randomUUID()}`)).json.items).toEqual([]);

      const one = await call('GET', `/quality-acceptances/${minutesId}`, { member: OWNER });
      expect(one).toMatchObject({ status: 200, json: { id: minutesId, status: 'SIGNING' } });
      expect((await call('GET', `/quality-acceptances/${randomUUID()}`, { member: OWNER })).status).toBe(404);
      expect((await call('GET', `/quality-acceptances/${minutesId}`, { member: ELSEWHERE })).status).toBe(404);
    });

    it('offers the contractor the role it can sign, and the approval to someone other than the drafter once every role has signed', async () => {
      const target = await contract();
      const guest = await guestOf(target);
      const minutesId = (await draft(DRAFTER, await inspected(target))).json.resource_id as string;
      const asGuest = ((await list(guest)).json.items as Array<Record<string, unknown>>)[0];
      expect(asGuest).toMatchObject({ signable_roles: ['CONTRACTOR'], actions: { sign: true, approve: false } });
      await sign(guest, minutesId, 1, 'CONTRACTOR');
      await sign(DRAFTER, minutesId, 2, 'SUPERVISOR');
      await sign(OWNER, minutesId, 3, 'OWNER');
      const approved = await decide(OWNER, minutesId, 4);
      expect(approved.status).toBe(200);
      const after = ((await list(OWNER)).json.items as Array<Record<string, unknown>>).find((item) => item.id === minutesId);
      expect(after).toMatchObject({ status: 'APPROVED', missing_roles: [], decision_note: 'Every role has signed.', approved_by: { membership_id: memberId(OWNER) }, actions: { sign: false, approve: false, reject: false, revoke: true } });
    });
  });
});
