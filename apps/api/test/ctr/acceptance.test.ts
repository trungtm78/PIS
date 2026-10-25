import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { ctrModule } from '../../src/modules/ctr';
import { AcceptanceController, AcceptanceReadsController } from '../../src/modules/ctr/acceptance.controller';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xb1;
const ROOT = 1;
const CREATOR = 11; // acceptance.create, acceptance.submit, acceptance.read
const APPROVER = 12; // acceptance.approve, acceptance.read
const SECOND_APPROVER = 13; // the same
const REVOKER = 14; // acceptance.revoke, acceptance.read
const READER = 15; // acceptance.read
const NOBODY = 16;
const ELSEWHERE = 17; // the rights of CREATOR over another branch
const MEMBERS = [CREATOR, APPROVER, SECOND_APPROVER, REVOKER, READER, NOBODY, ELSEWHERE];
const OTHER_BRANCH = 5;
const DOCUMENT = id(FAMILY, 30);
const VERSION = id(FAMILY, 31);
const SIGNERS = [{ name: 'Representative of the owner', role: 'OWNER' }];

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the acceptance of work over HTTP (ST-CTR-009)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let counter = 0;
  let contractor = '';
  let period = '';

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
  const stored = async (acceptanceId: string) => (await rows<{ status: string; version: string; accepted_amount_vnd: string; quality_acceptance_id: string | null; decided_by: string | null }>('select status, version::text, accepted_amount_vnd::text, quality_acceptance_id, decided_by from machvon.acceptance where id = $1::uuid', [acceptanceId]))[0];
  const total = async (contractId: string) => (await rows<{ total: string }>('select accepted_total_vnd::text as total from machvon.contract where id = $1::uuid', [contractId]))[0]?.total;

  interface Contract {
    id: string;
    code: string;
    revisionId: string;
    projectId: string;
    items: [string, string];
  }

  /** A contract of a project with capital in force, its first revision in force, B01 (8,000 m3 at 1,000,000) and B02 (500 m3 at 2,000,000); nine billion. */
  async function contract(options: { requiresQuality?: boolean; value?: string } = {}): Promise<Contract> {
    counter += 1;
    const line = await world.publishedLine();
    const contractId = randomUUID();
    const revisionId = randomUUID();
    const code = `HD-A-${String(counter).padStart(4, '0')}`;
    const items: [string, string] = [randomUUID(), randomUUID()];
    const boqLine = (n: number, key: string, quantity: string, price: string, amount: string): [string, unknown[]] => [
      `insert into machvon.boq_line (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, retention_pct, created_by)
       values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, 'M3', $8::numeric, $9::numeric, 'HALF_UP', $10::numeric, 5, $11)`,
      [TENANT_A, revisionId, contractId, items[n - 1], n, key, `Item ${key}`, quantity, price, amount, memberId(CREATOR)],
    ];
    await seedAs(harness, [
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
            created_by, updated_by, signed_on, effective_from)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'Contract', 'OTHER', false, $8, $9::numeric, $7, $7, date '2026-01-01', date '2026-01-02')`,
        [TENANT_A, contractId, line.projectId, randomUUID(), contractor, code, memberId(CREATOR), options.requiresQuality === true, options.value ?? '9000000000'],
      ],
      [
        `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
         values ($1, $2, $3, 1, 9000000000, $4, date '2026-01-02', 'EFFECTIVE', 'BASE', 1, $5, $5, $5, now())`,
        [TENANT_A, revisionId, contractId, VERSION, memberId(CREATOR)],
      ],
      [
        `insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by)
         values ($1, $2, $4, 'B01', 'Item B01', 'M3', $5, $5), ($1, $3, $4, 'B02', 'Item B02', 'M3', $5, $5)`,
        [TENANT_A, items[0], items[1], contractId, memberId(CREATOR)],
      ],
      boqLine(1, 'B01', '8000', '1000000', '8000000000'),
      boqLine(2, 'B02', '500', '2000000', '1000000000'),
      [`update machvon.contract set current_revision_id = $2 where id = $1::uuid`, [contractId, revisionId]],
    ]);
    return { id: contractId, code, revisionId, projectId: line.projectId, items };
  }

  /** A measurement of an item in the period, written in the status given (approved by default). */
  async function measured(target: Contract, item: 0 | 1, quantity: string, options: { status?: string; inspectionId?: string } = {}): Promise<string> {
    counter += 1;
    const measurementId = randomUUID();
    const status = options.status ?? 'APPROVED';
    const lineId = (await rows<{ id: string }>('select id from machvon.boq_line where contract_id = $1::uuid and boq_item_id = $2::uuid', [target.id, target.items[item]]))[0]?.id;
    await seedAs(harness, [
      [
        `insert into machvon.measurement
           (tenant_id, id, contract_id, contract_revision_id, boq_line_id, boq_item_id, period_id, quantity_period, quantity_cumulative, revision, status, evidence_refs, reference_no, inspection_id,
            created_by, updated_by, submitted_by, submitted_at, decided_by, decided_at, version)
         values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $8::numeric, $12, $9, jsonb_build_array(jsonb_build_object('document_version_id', $10::text)), $11, $13, $14, $14, $14, now(), $15, now(), 1)`,
        [TENANT_A, measurementId, target.id, target.revisionId, lineId, target.items[item], period, quantity, status, VERSION, `NK-${String(counter).padStart(5, '0')}`, counter, options.inspectionId ?? null, memberId(CREATOR), status === 'APPROVED' ? memberId(APPROVER) : null],
      ],
    ]);
    return measurementId;
  }

  const create = (member: number, target: Contract, measurementIds: string[], overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', `/contracts/${target.id}/acceptances`, { member, ...(key === undefined ? {} : { key }), body: { measurement_ids: measurementIds, period_id: period, document_version_id: VERSION, ...overrides } });
  const submit = (member: number, acceptanceId: string, version: number | string = 1, body: Record<string, unknown> = { signer_refs: SIGNERS }) => call('POST', `/acceptances/${acceptanceId}/submit`, { member, ifMatch: `"${version}"`, body });
  const decide = (member: number, acceptanceId: string, version: number | string, decision = 'approve', body: Record<string, unknown> = {}, key?: string) =>
    call('POST', `/acceptances/${acceptanceId}/decision`, { member, ifMatch: `"${version}"`, ...(key === undefined ? {} : { key }), body: { decision, reason: 'Checked against the measurements.', evidence_ids: [], ...body } });
  const revoke = (member: number, acceptanceId: string, version: number | string, body: Record<string, unknown> = {}) =>
    call('POST', `/acceptances/${acceptanceId}/revoke`, { member, ifMatch: `"${version}"`, body: { reason: 'The measurements were found wrong.', approval_document_version_id: VERSION, ...body } });
  const list = (member: number, query = '') => call('GET', `/resources/acceptance${query}`, { member });

  /** An acceptance drafted by the creator and sent by the creator, ready to be decided. */
  async function sent(target: Contract, measurementIds: string[]): Promise<{ id: string; version: number }> {
    const made = await create(CREATOR, target, measurementIds);
    expect(made.status).toBe(200);
    const done = await submit(CREATOR, made.json.resource_id as string, 1);
    expect(done.status).toBe(200);
    return { id: made.json.resource_id as string, version: done.json.resource_version as number };
  }

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'ACC_CREATOR', ['acceptance.create', 'acceptance.submit', 'acceptance.read'], 30],
      [2, 'ACC_APPROVER', ['acceptance.approve', 'acceptance.read'], 40],
      [3, 'ACC_REVOKER', ['acceptance.revoke', 'acceptance.read'], 40],
      [4, 'ACC_READER', ['acceptance.read'], 10],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 100 + n, code, permissions, rank);
    const grant = (n: number, member: number, role: number, extra: { kind?: 'TENANT' | 'UNIT_SUBTREE'; refs?: string[] } = {}) => ({ n, member, role: 100 + role, kind: extra.kind ?? 'TENANT', ...(extra.refs === undefined ? {} : { refs: extra.refs }) });
    await harness.seedGrants(TENANT_A, [
      grant(1, CREATOR, 1),
      grant(2, APPROVER, 2),
      grant(3, SECOND_APPROVER, 2),
      grant(4, REVOKER, 3),
      grant(5, READER, 4),
      grant(6, ELSEWHERE, 1, { kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] }),
    ]);
    contractor = await seedContractor(harness);
    period = randomUUID();
    await seedAs(harness, [
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3)`, [TENANT_A, DOCUMENT, memberId(CREATOR)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/record.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, VERSION, DOCUMENT],
      ],
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, '2026-07', 1, date '2026-07-01', date '2026-07-28', date '2026-07-28' + interval '3 hours', 'CAL-N', 'MONTH', 2026, 'OPEN', gen_random_uuid(), $3, $3)`,
        [TENANT_A, period, memberId(CREATOR)],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [AcceptanceController, AcceptanceReadsController],
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

  it('is registered in the module of CTR', () => {
    expect(ctrModule.controllers).toEqual(expect.arrayContaining([AcceptanceController, AcceptanceReadsController]));
  });

  it('AC-ST-CTR-009-1, UAT-AC63: refuses measurements that are not approved by name, drafts the rest priced from the revision, and tells PAY nothing until it is approved', async () => {
    const target = await contract();
    const submitted = await measured(target, 0, '1000', { status: 'SUBMITTED' });
    const approved = await measured(target, 1, '200');
    const draft = await measured(target, 0, '10', { status: 'DRAFT' });
    expect(await create(CREATOR, target, [submitted])).toMatchObject({ status: 422, json: { code: 'MEASUREMENT_NOT_APPROVED', measurement_ids: [submitted] } });
    expect(await create(CREATOR, target, [approved, draft])).toMatchObject({ status: 422, json: { code: 'MEASUREMENT_NOT_APPROVED', measurement_ids: [draft] } });
    const first = await create(CREATOR, target, [approved], {}, 'draft-once-for-this-key');
    expect(first).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1 } });
    expect(await create(CREATOR, target, [approved], {}, 'draft-once-for-this-key')).toEqual(first);
    const acceptanceId = first.json.resource_id as string;
    expect(await rows('select id from machvon.acceptance where contract_id = $1::uuid', [target.id])).toHaveLength(1);
    expect(await stored(acceptanceId)).toMatchObject({ status: 'DRAFT', accepted_amount_vnd: '400000000' });
    const [audit] = await audits(acceptanceId, 'acceptance.drafted');
    expect(audit).toMatchObject({
      actor_id: memberId(CREATOR),
      safe_diff: { acceptance_no: 'NT-001', contract_id: target.id, accepted_amount_vnd: '400000000', from_status: null, to_status: 'DRAFT', lines: [expect.objectContaining({ measurement_id: approved, amount_vnd: '400000000', unit_price_snapshot: '2000000.000000' })] },
    });
    expect((await events(acceptanceId, 'ctr.acceptance.drafted.v1'))[0]?.payload).toMatchObject({ acceptance_id: acceptanceId, accepted_total_vnd: '0', status: 'DRAFT' });
    expect(await events(acceptanceId, 'ctr.acceptance.approved.v1')).toEqual([]);
  });

  it('sends an acceptance and approves it by another person: PAY is told once, with a line for each measurement, and the contract has accepted that much', async () => {
    const target = await contract();
    const one = await measured(target, 0, '10');
    const two = await measured(target, 1, '20');
    const made = await create(CREATOR, target, [one, two]);
    const acceptanceId = made.json.resource_id as string;
    expect(await submit(CREATOR, acceptanceId, 1, { signer_refs: [] })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await submit(READER, acceptanceId)).toMatchObject({ status: 403 });
    const sentOne = await submit(CREATOR, acceptanceId);
    expect(sentOne).toMatchObject({ status: 200, json: { status: 'SUBMITTED', resource_version: 2 } });
    expect((await events(acceptanceId, 'ctr.acceptance.submitted.v1'))[0]?.payload).toMatchObject({ status: 'SUBMITTED', signer_count: 1 });
    expect(await decide(CREATOR, acceptanceId, 2)).toMatchObject({ status: 403 });
    expect(await decide(READER, acceptanceId, 2)).toMatchObject({ status: 403 });
    expect(await decide(APPROVER, acceptanceId, 7)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    const approved = await decide(APPROVER, acceptanceId, 2, 'approve', {}, 'approve-once-for-this-key');
    expect(approved).toMatchObject({ status: 200, json: { status: 'APPROVED', resource_version: 3 } });
    expect(await decide(APPROVER, acceptanceId, 2, 'approve', {}, 'approve-once-for-this-key')).toEqual(approved);
    expect(await stored(acceptanceId)).toMatchObject({ status: 'APPROVED', decided_by: memberId(APPROVER) });
    expect(await total(target.id)).toBe('50000000');
    const sentToPay = await events(acceptanceId, 'ctr.acceptance.approved.v1');
    expect(sentToPay).toHaveLength(1);
    expect(sentToPay[0]?.payload).toMatchObject({ acceptance_id: acceptanceId, contract_id: target.id, accepted_amount_vnd: '50000000', accepted_total_vnd: '50000000', status: 'APPROVED', version: 3, actor_id: memberId(APPROVER) });
    expect((sentToPay[0]?.payload.lines as Array<Record<string, unknown>>).map((line) => [line.measurement_id, line.amount_vnd, line.boq_item_id]).sort()).toEqual(
      [
        [one, '10000000', target.items[0]],
        [two, '40000000', target.items[1]],
      ].sort(),
    );
    expect((await audits(acceptanceId, 'acceptance.approved'))[0]).toMatchObject({ actor_id: memberId(APPROVER), reason: 'Checked against the measurements.', safe_diff: { from_status: 'SUBMITTED', to_status: 'APPROVED' } });
    expect(await decide(SECOND_APPROVER, acceptanceId, 3)).toMatchObject({ status: 409, json: { code: 'ACCEPTANCE_STATE_INVALID', acceptance_status: 'APPROVED' } });
  });

  it('rejects an acceptance, and gives one back to the draft, with the reason: audited, no event to PAY', async () => {
    const target = await contract();
    const made = (await create(CREATOR, target, [await measured(target, 0, '1')])).json.resource_id as string;
    await submit(CREATOR, made);
    expect(await decide(APPROVER, made, 2, 'maybe')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    const returned = await decide(APPROVER, made, 2, 'return');
    expect(returned).toMatchObject({ status: 200, json: { status: 'DRAFT' } });
    const again = await submit(CREATOR, made, 3);
    const rejected = await decide(APPROVER, made, again.json.resource_version as number, 'reject', { reason: 'The paper is the wrong one.' });
    expect(rejected).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
    expect((await audits(made, 'acceptance.rejected'))[0]).toMatchObject({ reason: 'The paper is the wrong one.', safe_diff: { from_status: 'SUBMITTED', to_status: 'REJECTED' } });
    expect((await audits(made, 'acceptance.returned'))).toHaveLength(1);
    expect(await events(made, 'ctr.acceptance.approved.v1')).toEqual([]);
    expect(await total(target.id)).toBe('0');
  });

  it('AC-ST-CTR-009-2, UAT-AC313: waits for approved minutes of quality and for the serious non-conformance on the work to be closed', async () => {
    const target = await contract({ requiresQuality: true });
    const inspectionId = randomUUID();
    const measurement = await measured(target, 1, '50', { inspectionId });
    const waiting = await sent(target, [measurement]);
    expect(await decide(APPROVER, waiting.id, waiting.version)).toMatchObject({ status: 422, json: { code: 'QUALITY_ACCEPTANCE_REQUIRED' } });
    const minutes = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.inspection (tenant_id, id, project_id, contract_id, boq_item_id, inspection_no, inspection_type, title, requested_by, requested_for, status, created_by, updated_by, version)
         values ($1, $2, $3, $4, $5, 'KT-001', 'CONCEALED_WORK', 'Inspection', $6, date '2026-07-20', 'REQUESTED', $6, $6, 1)`,
        [TENANT_A, inspectionId, target.projectId, target.id, target.items[1], memberId(CREATOR)],
      ],
      [
        `insert into machvon.quality_acceptance (tenant_id, id, project_id, contract_id, inspection_id, record_no, acceptance_scope, document_version_id, status, required_roles, content_hash, created_by, updated_by, version)
         values ($1, $2, $3, $4, $5, 'QA-W-060', 'WORK_ITEM', $6, 'DRAFT', '["CONTRACTOR","SUPERVISOR","OWNER"]'::jsonb, repeat('a', 64), $7, $7, 1)`,
        [TENANT_A, minutes, target.projectId, target.id, inspectionId, VERSION, memberId(CREATOR)],
      ],
    ]);
    await world.owner("update machvon.quality_acceptance set status = 'SIGNING' where id = $1::uuid", [minutes]);
    await world.owner("update machvon.quality_acceptance set status = 'APPROVED', decision_note = 'ok', approved_at = now(), approved_by = $2::uuid where id = $1::uuid", [minutes, memberId(APPROVER)]);
    const blocking = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.quality_nonconformance (tenant_id, id, project_id, contract_id, measurement_id, severity, action_owner_id, due_at, status, closure_evidence, blocks_acceptance)
         values ($1, $2, $3, $4, $5, 'CRITICAL', $6, now() + interval '7 days', 'OPEN', '[]'::jsonb, true)`,
        [TENANT_A, blocking, target.projectId, target.id, measurement, memberId(CREATOR)],
      ],
    ]);
    expect(await decide(APPROVER, waiting.id, waiting.version)).toMatchObject({ status: 422, json: { code: 'OPEN_CRITICAL_NCR', nonconformance_ids: [blocking] } });
    expect(await total(target.id)).toBe('0');
    await world.owner("update machvon.quality_nonconformance set status = 'CLOSED', verified_by = $2::uuid, closed_by = $2::uuid, closed_at = now() where id = $1::uuid", [blocking, memberId(SECOND_APPROVER)]);
    const done = await decide(APPROVER, waiting.id, waiting.version);
    expect(done).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
    expect(await stored(waiting.id)).toMatchObject({ status: 'APPROVED', quality_acceptance_id: minutes });
    expect((await events(waiting.id, 'ctr.acceptance.approved.v1'))[0]?.payload).toMatchObject({ quality_acceptance_id: minutes });
  });

  it('refuses to accept above the value of the contract with the figures', async () => {
    const target = await contract({ value: '100000000' });
    const waiting = await sent(target, [await measured(target, 1, '51')]);
    expect(await decide(APPROVER, waiting.id, waiting.version)).toMatchObject({
      status: 422,
      json: { code: 'ACCEPTANCE_VALUE_EXCEEDS_CONTRACT', accepted_total_vnd: '0', amount_vnd: '102000000', contract_value_vnd: '100000000', remaining_vnd: '100000000' },
    });
    expect((await stored(waiting.id))?.status).toBe('SUBMITTED');
  });

  it('AC-ST-CTR-009-3, UAT-AC314: approves exactly one of two acceptances of the same measurement approved at the same moment, over thirty rounds', async () => {
    const target = await contract({ value: '100000000000' });
    let expected = 0n;
    for (let round = 1; round <= 30; round += 1) {
      const contested = await measured(target, 1, '1');
      const left = await sent(target, [contested]);
      const right = await sent(target, [contested]);
      const [one, two] = await Promise.all([decide(APPROVER, left.id, left.version), decide(SECOND_APPROVER, right.id, right.version)]);
      const statuses = [one.status, two.status].sort();
      expect({ round, statuses }).toEqual({ round, statuses: [200, 409] });
      const lost = one.status === 409 ? one : two;
      expect(lost.json).toMatchObject({ code: 'MEASUREMENT_ALREADY_ACCEPTED' });
      const loser = one.status === 409 ? left : right;
      expect((await stored(loser.id))?.status).toBe('SUBMITTED');
      expect(await rows('select id from machvon.acceptance_line where measurement_id = $1::uuid and active', [contested])).toHaveLength(1);
      expected += 2000000n;
      expect(await total(target.id)).toBe(expected.toString());
      expect(await events(loser.id, 'ctr.acceptance.approved.v1')).toEqual([]);
    }
  });

  it('revokes an approved acceptance by someone who did not send or approve it, tells PAY once, and is refused while a payment request holds it', async () => {
    const target = await contract();
    const waiting = await sent(target, [await measured(target, 1, '200')]);
    const approved = await decide(APPROVER, waiting.id, waiting.version);
    const version = approved.json.resource_version as number;
    expect(await revoke(APPROVER, waiting.id, version)).toMatchObject({ status: 403 });
    expect(await revoke(REVOKER, waiting.id, version, { reason: '  ' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await revoke(REVOKER, waiting.id, version, { approval_document_version_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    const claim = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.payment_request (tenant_id, id, project_id, contract_id, acceptance_id, currency, gross_vnd, advance_recovery_vnd, retention_vnd, tax_adjustment_vnd, net_vnd, status, version, claims_acceptance, request_no)
         values ($1, $2, $3, $4, $5, 'VND', 400000000, 0, 0, 0, 400000000, 'SUBMITTED', 1, true, 'DNTT-CLAIM')`,
        [TENANT_A, claim, target.projectId, target.id, waiting.id],
      ],
    ]);
    expect(await revoke(REVOKER, waiting.id, version)).toMatchObject({ status: 409, json: { code: 'ACCEPTANCE_ALREADY_CLAIMED', payment_request_id: claim } });
    expect(await events(waiting.id, 'ctr.acceptance.revoked.v1')).toEqual([]);
    await world.owner("update machvon.payment_request set status = 'RETURNED', claims_acceptance = false, return_reason = 'Withdrawn.', returned_by = gen_random_uuid(), returned_at = now() where id = $1::uuid", [claim]);
    const revoked = await revoke(REVOKER, waiting.id, version);
    expect(revoked).toMatchObject({ status: 200, json: { status: 'REVOKED', resource_version: version + 1 } });
    expect(await total(target.id)).toBe('0');
    const sentToPay = await events(waiting.id, 'ctr.acceptance.revoked.v1');
    expect(sentToPay).toHaveLength(1);
    expect(sentToPay[0]?.payload).toMatchObject({ acceptance_id: waiting.id, status: 'REVOKED', from_status: 'APPROVED', accepted_total_vnd: '0', actor_id: memberId(REVOKER) });
    expect((await audits(waiting.id, 'acceptance.revoked'))[0]).toMatchObject({ actor_id: memberId(REVOKER), reason: 'The measurements were found wrong.' });
    expect(await revoke(REVOKER, waiting.id, version + 1)).toMatchObject({ status: 409, json: { code: 'ACCEPTANCE_STATE_INVALID' } });
  });

  it('is for whoever holds the permission over the contract', async () => {
    const target = await contract();
    const measurement = await measured(target, 0, '1');
    expect((await create(READER, target, [measurement])).status).toBe(403);
    expect((await create(NOBODY, target, [measurement])).status).toBe(403);
    expect((await create(ELSEWHERE, target, [measurement])).status).toBe(404);
    expect((await create(CREATOR, { ...target, id: randomUUID() }, [measurement])).status).toBe(404);
    expect(await create(CREATOR, target, [measurement], { status: 'APPROVED', accepted_amount_vnd: '1' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
    expect(await create(CREATOR, target, [measurement], { document_version_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    const made = (await create(CREATOR, target, [measurement])).json.resource_id as string;
    expect((await submit(ELSEWHERE, made)).status).toBe(404);
    expect((await submit(NOBODY, made)).status).toBe(403);
    expect((await decide(ELSEWHERE, made, 1)).status).toBe(403);
  });

  describe('the resource /resources/acceptance', () => {
    it('lists the acceptances in the scope with their lines and what the caller may do, and reads one', async () => {
      const target = await contract();
      const first = (await create(CREATOR, target, [await measured(target, 0, '2')])).json.resource_id as string;
      const waiting = await sent(target, [await measured(target, 1, '3')]);
      const approvedWaiting = await sent(target, [await measured(target, 1, '4')]);
      await decide(APPROVER, approvedWaiting.id, approvedWaiting.version);

      const seen = await list(CREATOR, `?contract_id=${target.id}`);
      expect(seen.status).toBe(200);
      const items = seen.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id)).toEqual([approvedWaiting.id, waiting.id, first]);
      expect(items[2]).toMatchObject({
        acceptance_no: 'NT-001',
        contract: { id: target.id, code: target.code, status: 'ACTIVE', requires_quality_acceptance: false, contract_value_vnd: '9000000000' },
        status: 'DRAFT',
        accepted_amount_vnd: '2000000',
        lines: [expect.objectContaining({ boq_item: expect.objectContaining({ business_key: 'B01', unit_code: 'M3' }), quantity: '2.000000', unit_price_snapshot: '1000000.000000', amount_vnd: '2000000', active: false })],
        actions: { submit: true, decide: false, revoke: false },
        quality_acceptance: null,
        open_critical_ncr: 0,
        version: 1,
      });
      expect(items[1]).toMatchObject({ status: 'SUBMITTED', actions: { submit: false, decide: false, revoke: false } });
      expect(items[0]).toMatchObject({ status: 'APPROVED', actions: { revoke: false }, lines: [expect.objectContaining({ active: true })] });
      const approver = (await list(APPROVER, `?contract_id=${target.id}`)).json.items as Array<Record<string, Record<string, boolean>>>;
      expect(approver.map((item) => item.actions?.decide)).toEqual([false, true, false]);
      const revoker = (await list(REVOKER, `?contract_id=${target.id}`)).json.items as Array<Record<string, Record<string, boolean>>>;
      expect(revoker.map((item) => item.actions?.revoke)).toEqual([true, false, false]);
      const reader = (await list(READER, `?contract_id=${target.id}`)).json.items as Array<Record<string, Record<string, boolean>>>;
      expect(reader.every((item) => Object.values(item.actions ?? {}).every((value) => value === false))).toBe(true);
      expect(Object.keys(items[2] ?? {}).sort()).toEqual(
        [
          'acceptance_no', 'accepted_amount_vnd', 'accepted_on', 'actions', 'approved_at', 'contract', 'created_at', 'created_by', 'decided_by', 'decision_reason', 'document_version_id', 'id', 'lines', 'open_critical_ncr', 'period', 'project_id',
          'quality_acceptance', 'revoke_reason', 'revoked_at', 'signer_refs', 'status', 'submitted_at', 'submitted_by', 'version',
        ].sort(),
      );
      const one = await call('GET', `/resources/acceptance/${first}`, { member: CREATOR });
      expect(one).toMatchObject({ status: 200, json: { id: first, status: 'DRAFT' } });
      expect((await call('GET', `/resources/acceptance/${randomUUID()}`, { member: CREATOR })).status).toBe(404);
      expect((await call('GET', `/resources/acceptance/${first}`, { member: ELSEWHERE })).status).toBe(404);
      expect((await list(ELSEWHERE)).json.items).toEqual([]);
      expect((await list(NOBODY)).status).toBe(403);
      expect(await list(CREATOR, '?contract_id=nope')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    });

    it('pages by the creation time and the id', async () => {
      const target = await contract();
      const made: string[] = [];
      for (let n = 0; n < 3; n += 1) made.push((await create(CREATOR, target, [await measured(target, 0, '1')])).json.resource_id as string);
      const page = await list(CREATOR, `?contract_id=${target.id}&limit=2`);
      expect((page.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([made[2], made[1]]);
      expect(typeof page.json.next_cursor).toBe('string');
      const rest = await list(CREATOR, `?contract_id=${target.id}&limit=2&cursor=${encodeURIComponent(page.json.next_cursor as string)}`);
      expect((rest.json.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([made[0]]);
      expect(rest.json.next_cursor).toBeNull();
    });
  });
});
