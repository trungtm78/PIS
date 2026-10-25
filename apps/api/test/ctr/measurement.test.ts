import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, PmtGateStore, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { ctrModule } from '../../src/modules/ctr';
import { BoqLineReadsController } from '../../src/modules/ctr/boq.controller';
import { MeasurementController, MeasurementReadsController } from '../../src/modules/ctr/measurement.controller';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, contextFor, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xaa;
const ROOT = 1;
const RECORDER = 11; // measurement.record, measurement.submit, measurement.read
const APPROVER = 12; // measurement.approve, measurement.read
const CORRECTOR = 13; // measurement.correct, measurement.read
const READER = 14; // measurement.read
const NOBODY = 15;
const ELSEWHERE = 16; // the rights of RECORDER over another branch
const GUEST = 17; // the contractor of the contracts, invited to one
const ALL = 18; // every right over measurements
const SECOND_GUEST = 19; // a guest of the same contractor, invited to the contract the sending test uses
const THIRD_GUEST = 20; // a guest of the same contractor, invited to the contract the reading test uses
const GUESTS = [GUEST, SECOND_GUEST, THIRD_GUEST];
const MEMBERS = [RECORDER, APPROVER, CORRECTOR, READER, NOBODY, ELSEWHERE, ALL, ...GUESTS];
const OTHER_BRANCH = 5;
const PERIODS = 8;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the measurements over HTTP (ST-CTR-008)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  const gates = new PmtGateStore();
  let app: RunningApp;
  let counter = 0;
  let contractor = '';
  let cleanVersion = '';
  const periods: string[] = [];

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
    rows<{ safe_diff: Record<string, unknown>; actor_id: string; reason: string | null }>('select safe_diff, actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at, id', [resourceId, action]);
  const events = (aggregateId: string, type: string) =>
    rows<{ payload: Record<string, unknown>; aggregate_version: string }>('select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id', [aggregateId, type]);
  const measurementRow = async (measurementId: string) =>
    (await rows<{ status: string; version: string; quantity_period: string; quantity_cumulative: string; revision: number }>('select status, version::text, quantity_period::text, quantity_cumulative::text, revision from machvon.measurement where id = $1::uuid', [measurementId]))[0];

  interface Contract {
    id: string;
    code: string;
    revisionId: string;
    projectId: string;
    items: [string, string];
  }

  /** A contract of a project with capital in force, its first revision in force, B01 (8,000 m3) and B02 (500 m3). */
  async function contract(status = 'ACTIVE', category = 'CONSTRUCTION'): Promise<Contract> {
    counter += 1;
    const line = await world.publishedLine();
    const contractId = randomUUID();
    const revisionId = randomUUID();
    const code = `HD-Q-${String(counter).padStart(4, '0')}`;
    const items: [string, string] = [randomUUID(), randomUUID()];
    const boqLine = (n: number, key: string, quantity: string, price: string, amount: string): [string, unknown[]] => [
      `insert into machvon.boq_line (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, retention_pct, created_by)
       values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, 'M3', $8::numeric, $9::numeric, 'HALF_UP', $10::numeric, 5, $11)`,
      [TENANT_A, revisionId, contractId, items[n - 1], n, key, `Item ${key}`, quantity, price, amount, memberId(RECORDER)],
    ];
    await seedAs(harness, [
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
            created_by, updated_by, signed_on, effective_from, status_reason, status_decision_document_version_id)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', $7, 1, 'Contract', $8, false, true, 9000000000, $9, $9, date '2026-01-01', date '2026-01-02', $10, $11)`,
        [TENANT_A, contractId, line.projectId, randomUUID(), contractor, code, status, category, memberId(RECORDER), status === 'SUSPENDED' ? 'Decided.' : null, status === 'SUSPENDED' ? cleanVersion : null],
      ],
      [
        `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
         values ($1, $2, $3, 1, 9000000000, $4, date '2026-01-02', 'EFFECTIVE', 'BASE', 1, $5, $5, $5, now())`,
        [TENANT_A, revisionId, contractId, cleanVersion, memberId(RECORDER)],
      ],
      [
        `insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by)
         values ($1, $2, $4, 'B01', 'Item B01', 'M3', $5, $5), ($1, $3, $4, 'B02', 'Item B02', 'M3', $5, $5)`,
        [TENANT_A, items[0], items[1], contractId, memberId(RECORDER)],
      ],
      boqLine(1, 'B01', '8000', '1000000', '8000000000'),
      boqLine(2, 'B02', '500', '2000000', '1000000000'),
      [`update machvon.contract set current_revision_id = $2 where id = $1::uuid`, [contractId, revisionId]],
    ]);
    return { id: contractId, code, revisionId, projectId: line.projectId, items };
  }

  const reference = (): string => {
    counter += 1;
    return `NK-${String(counter).padStart(5, '0')}`;
  };
  const evidence = (): Array<{ document_version_id: string }> => [{ document_version_id: cleanVersion }];
  const recordBody = (target: Contract, overrides: Record<string, unknown> = {}) => ({
    contract_revision_id: target.revisionId,
    boq_item_id: target.items[0],
    period_id: periods[0],
    quantity_period: '3500',
    reference_no: reference(),
    evidence_refs: evidence(),
    ...overrides,
  });
  const record = (member: number, target: Contract, overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', `/contracts/${target.id}/measurements`, { member, body: recordBody(target, overrides), ...(key === undefined ? {} : { key }) });
  const submit = (member: number, measurementId: string, version: number | string = 1, body: Record<string, unknown> = {}) =>
    call('POST', `/measurements/${measurementId}/submit`, { member, ifMatch: `"${version}"`, body });
  const decide = (member: number, measurementId: string, version: number | string, decision = 'approve', body: Record<string, unknown> = {}) =>
    call('POST', `/measurements/${measurementId}/decision`, { member, ifMatch: `"${version}"`, body: { decision, reason: 'Checked on site.', evidence_ids: [], ...body } });
  const correct = (member: number, measurementId: string, version: number | string, body: Record<string, unknown> = {}) =>
    call('POST', `/measurements/${measurementId}/correct`, { member, ifMatch: `"${version}"`, body: { quantity_period: '3000', correction_reason: 'Re-measured on site.', evidence_refs: evidence(), ...body } });

  /** A measurement that was recorded, sent and approved by the roles that hold the right to each. */
  async function approved(target: Contract, overrides: Record<string, unknown> = {}): Promise<{ id: string; version: number }> {
    const made = await record(RECORDER, target, overrides);
    expect(made.status).toBe(200);
    const measurementId = made.json.resource_id as string;
    const sent = await submit(RECORDER, measurementId);
    expect(sent.status).toBe(200);
    const done = await decide(APPROVER, measurementId, sent.json.resource_version as number);
    expect(done.status).toBe(200);
    return { id: measurementId, version: done.json.resource_version as number };
  }

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'MSR_RECORDER', ['measurement.record', 'measurement.submit', 'measurement.read'], 30],
      [2, 'MSR_APPROVER', ['measurement.approve', 'measurement.read'], 40],
      [3, 'MSR_CORRECTOR', ['measurement.correct', 'measurement.read'], 40],
      [4, 'MSR_READER', ['measurement.read'], 10],
      [5, 'MSR_ALL', ['measurement.record', 'measurement.submit', 'measurement.approve', 'measurement.correct', 'measurement.read'], 50],
      [6, 'MSR_GUEST', ['measurement.record', 'measurement.submit', 'measurement.read', 'boq_line.read'], 5],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 90 + n, code, permissions, rank);
    const grant = (n: number, member: number, role: number, extra: { kind?: 'TENANT' | 'UNIT_SUBTREE' | 'CONTRACT'; refs?: string[] } = {}) => ({ n, member, role: 90 + role, kind: extra.kind ?? 'TENANT', ...(extra.refs === undefined ? {} : { refs: extra.refs }) });
    await harness.seedGrants(TENANT_A, [
      grant(1, RECORDER, 1),
      grant(2, APPROVER, 2),
      grant(3, CORRECTOR, 3),
      grant(4, READER, 4),
      grant(5, ALL, 5),
      grant(6, ELSEWHERE, 1, { kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] }),
    ]);
    contractor = await seedContractor(harness);
    cleanVersion = id(FAMILY, 10);
    await seedAs(harness, [
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'HD', 'Contract', 'INTERNAL', $3, $3)`, [TENANT_A, id(FAMILY, 11), memberId(RECORDER)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/contract.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, cleanVersion, id(FAMILY, 11)],
      ],
      [
        `insert into machvon.permit_type (tenant_id, id, code, name, category, authority_text, legal_basis, effective_from, applies_to_rule, status, created_by, updated_by)
         values ($1, $2, 'GPXD', 'Building permit', 'OTHER', 'The authority', 'Fixture decree', '2025-01-01', '{}'::jsonb, 'PUBLISHED', $3, $3)`,
        [TENANT_A, id(FAMILY, 60), memberId(RECORDER)],
      ],
    ]);
    for (let n = 0; n < PERIODS; n += 1) {
      const periodId = randomUUID();
      periods.push(periodId);
      const month = String(n + 1).padStart(2, '0');
      await seedAs(harness, [
        [
          `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
           values ($1, $2, $3, 1, $4::date, $5::date, $5::date + interval '3 hours', 'CAL-M', 'MONTH', 2026, 'OPEN', gen_random_uuid(), $6, $6)`,
          [TENANT_A, periodId, `2026-${month}`, `2026-${month}-01`, `2026-${month}-28`, memberId(RECORDER)],
        ],
      ]);
    }
    for (const guest of GUESTS) await world.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(guest), contractor]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [MeasurementController, MeasurementReadsController, BoqLineReadsController],
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

  it('is registered in the module of CTR', () => {
    expect(ctrModule.controllers).toEqual(expect.arrayContaining([MeasurementController, MeasurementReadsController]));
  });

  describe('recordMeasurement (AC-ST-CTR-008-1, UAT-AC311)', () => {
    it('records a draft with its audit row and its event, and answers the same key once', async () => {
      const target = await contract();
      const body = recordBody(target, { reference_no: 'NK-HTTP-1' });
      const send = () => call('POST', `/contracts/${target.id}/measurements`, { member: RECORDER, key: 'record-once-for-this-key', body });
      const first = await send();
      expect(first).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1 } });
      expect(await send()).toEqual(first);
      const measurementId = first.json.resource_id as string;
      expect(await rows('select id from machvon.measurement where contract_id = $1::uuid', [target.id])).toHaveLength(1);
      expect(await measurementRow(measurementId)).toMatchObject({ status: 'DRAFT', quantity_period: '3500.000000', quantity_cumulative: '3500.000000', revision: 1 });
      const [audit] = await audits(measurementId, 'measurement.recorded');
      expect(audit).toMatchObject({
        actor_id: memberId(RECORDER),
        safe_diff: { contract_id: target.id, boq_item_key: 'B01', quantity_period: '3500.000000', quantity_cumulative: '3500.000000', remaining_quantity: '4500.000000', revision: 1, reference_no: 'NK-HTTP-1', from_status: null, to_status: 'DRAFT' },
      });
      const [event] = await events(measurementId, 'ctr.measurement.recorded.v1');
      expect(event?.payload).toMatchObject({ measurement_id: measurementId, contract_id: target.id, project_id: target.projectId, status: 'DRAFT', version: 1, actor_id: memberId(RECORDER), contract_revision_id: target.revisionId });
    });

    it('refuses a negative period, a zero or malformed quantity, a quantity above the item, and says what is left', async () => {
      const target = await contract();
      expect(await record(RECORDER, target, { quantity_period: '-500' })).toMatchObject({ status: 422, json: { code: 'CUMULATIVE_DECREASE_WITHOUT_CORRECTION' } });
      expect(await record(RECORDER, target, { quantity_period: '0' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await record(RECORDER, target, { quantity_period: '1.1234567' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await record(RECORDER, target, { quantity_period: '8000.000001' })).toMatchObject({ status: 422, json: { code: 'QUANTITY_EXCEEDS_BOQ', remaining_quantity: '8000.000000', boq_quantity: '8000.000000' } });
      expect(await record(RECORDER, target, { status: 'APPROVED' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await record(RECORDER, target, { evidence_refs: [{ document_version_id: 'nope' }] })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await record(RECORDER, target, { reference_no: '   ' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await rows('select id from machvon.measurement where contract_id = $1::uuid', [target.id])).toEqual([]);
    });

    it('refuses a number of record that is used, a period already measured, a revision not in force and a contract not being performed', async () => {
      const target = await contract();
      const first = await record(RECORDER, target, { reference_no: 'NK-DUP-1' });
      expect(first.status).toBe(200);
      expect(await record(RECORDER, target, { reference_no: 'NK-DUP-1', period_id: periods[1] })).toMatchObject({ status: 409, json: { code: 'MEASUREMENT_REFERENCE_DUPLICATE' } });
      expect(await record(RECORDER, target, { reference_no: 'NK-DUP-1', period_id: periods[1], duplicate_override_reason: 'One form covers two periods.' })).toMatchObject({ status: 200 });
      expect(await record(RECORDER, target, { period_id: periods[0] })).toMatchObject({ status: 409, json: { code: 'MEASUREMENT_STATE_INVALID', reason: 'PERIOD_ALREADY_MEASURED' } });
      const elsewhere = await contract();
      expect(await record(RECORDER, target, { contract_revision_id: elsewhere.revisionId, period_id: periods[2] })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      const suspended = await contract('SUSPENDED');
      expect(await record(RECORDER, suspended)).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID', contract_status: 'SUSPENDED' } });
    });

    it('AC-ST-CTR-008-3, UAT-AC369: is blocked while the permits of the start of construction are missing, and names the gate', async () => {
      const target = await contract();
      await harness.tenants.withTenant(contextFor(TENANT_A, memberId(RECORDER)), (tx) =>
        gates.publish(tx, { gateCode: 'START_CONSTRUCTION', permitTypeId: id(FAMILY, 60), requirement: 'VALID_PERMIT', appliesToRule: {}, legalBasis: 'Fixture decree', effectiveFrom: '2025-01-01' }, memberId(RECORDER)),
      );
      const blocked = await record(RECORDER, target);
      expect(blocked).toMatchObject({ status: 422, json: { code: 'PERMIT_GATE_BLOCKED', gate_code: 'START_CONSTRUCTION', blocking: [expect.objectContaining({ permit_type_code: 'GPXD' })] } });
      expect(await rows('select id from machvon.measurement where contract_id = $1::uuid', [target.id])).toEqual([]);
      await world.owner('delete from machvon.permit_gate_rule');
      expect((await record(RECORDER, target)).status).toBe(200);
    });

    it('is for whoever holds the permission over the contract, and a guest contractor records only in the contract it was invited to', async () => {
      const target = await contract();
      const other = await contract();
      expect((await record(READER, target)).status).toBe(403);
      expect((await record(NOBODY, target)).status).toBe(403);
      expect((await record(ELSEWHERE, target)).status).toBe(404);
      expect((await record(RECORDER, { ...target, id: randomUUID() })).status).toBe(404);
      await harness.seedGrants(TENANT_A, [{ n: 41, member: GUEST, role: 96, kind: 'CONTRACT', refs: [target.id] }]);
      const own = await record(GUEST, target, { reference_no: 'NK-GUEST-1' });
      expect(own).toMatchObject({ status: 200, json: { status: 'DRAFT' } });
      expect((await audits(own.json.resource_id as string, 'measurement.recorded'))[0]).toMatchObject({ actor_id: memberId(GUEST) });
      expect((await record(GUEST, other)).status).toBe(404);
      expect(await rows('select id from machvon.measurement where contract_id = $1::uuid', [other.id])).toEqual([]);
      // The command names the stable item, so a guest who records is shown it in the BOQ of its own contract (a guest who only reads the BOQ is not: see the tests of the import).
      const boq = await call('GET', `/resources/boq_line?contract_id=${target.id}&limit=200`, { member: GUEST });
      expect((boq.json.items as Array<Record<string, unknown>>).map((item) => item.boq_item_id)).toEqual(target.items);
      const one = await rows<{ id: string }>('select id from machvon.boq_line where contract_id = $1::uuid and business_key = $2', [target.id, 'B02']);
      expect((await call('GET', `/resources/boq_line/${one[0]?.id}`, { member: GUEST })).json).toMatchObject({ boq_item_id: target.items[1] });
    });
  });

  describe('submitMeasurement and post_measurements_id_decision', () => {
    it('sends a draft with its evidence, and it is approved by someone else, with the audit rows and the events', async () => {
      const target = await contract();
      const made = await record(RECORDER, target);
      const measurementId = made.json.resource_id as string;
      expect(await submit(RECORDER, measurementId, 5)).toMatchObject({ status: 409 });
      const sent = await submit(RECORDER, measurementId, 1, { note: 'Ready for the supervisor.' });
      expect(sent).toMatchObject({ status: 200, json: { status: 'SUBMITTED', resource_version: 2 } });
      expect((await audits(measurementId, 'measurement.submitted'))[0]).toMatchObject({ reason: 'Ready for the supervisor.', safe_diff: { from_status: 'DRAFT', to_status: 'SUBMITTED' } });
      expect((await events(measurementId, 'ctr.measurement.submitted.v1'))[0]?.payload).toMatchObject({ measurement_id: measurementId, status: 'SUBMITTED', version: 2 });
      expect(await submit(RECORDER, measurementId, 2)).toMatchObject({ status: 409, json: { code: 'MEASUREMENT_STATE_INVALID' } });

      expect(await decide(RECORDER, measurementId, 2)).toMatchObject({ status: 403 });
      expect(await decide(ALL, measurementId, 2)).toMatchObject({ status: 200, json: { status: 'APPROVED' } });
      expect(await measurementRow(measurementId)).toMatchObject({ status: 'APPROVED', version: '3', quantity_cumulative: '3500.000000' });
      expect((await audits(measurementId, 'measurement.approved'))[0]).toMatchObject({ actor_id: memberId(ALL), reason: 'Checked on site.', safe_diff: { decision: 'approve', from_status: 'SUBMITTED', to_status: 'APPROVED', quantity_cumulative: '3500.000000' } });
      expect((await events(measurementId, 'ctr.measurement.approved.v1'))[0]?.payload).toMatchObject({ status: 'APPROVED', from_status: 'SUBMITTED', decision: 'approve', version: 3, actor_id: memberId(ALL) });
    });

    it('does not let whoever recorded or sent a measurement approve it, even holding every right', async () => {
      const target = await contract();
      const made = await record(ALL, target);
      const measurementId = made.json.resource_id as string;
      expect((await submit(RECORDER, measurementId)).status).toBe(200);
      expect(await decide(ALL, measurementId, 2)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect(await decide(RECORDER, measurementId, 2)).toMatchObject({ status: 403 });
      expect(await measurementRow(measurementId)).toMatchObject({ status: 'SUBMITTED' });
      expect((await decide(APPROVER, measurementId, 2)).status).toBe(200);
    });

    it('refuses to send a draft without evidence, and gives a returned measurement back and a rejected one up', async () => {
      const target = await contract();
      const bare = await record(RECORDER, target, { evidence_refs: [] });
      expect(await submit(RECORDER, bare.json.resource_id as string)).toMatchObject({ status: 422, json: { code: 'EVIDENCE_REQUIRED' } });

      const made = await record(RECORDER, target, { period_id: periods[1] });
      const measurementId = made.json.resource_id as string;
      await submit(RECORDER, measurementId);
      expect(await decide(APPROVER, measurementId, 2, 'maybe')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await decide(APPROVER, measurementId, 2, 'return')).toMatchObject({ status: 200, json: { status: 'DRAFT' } });
      expect((await events(measurementId, 'ctr.measurement.returned.v1'))[0]?.payload).toMatchObject({ decision: 'return', status: 'DRAFT' });
      await submit(RECORDER, measurementId, 3);
      expect(await decide(APPROVER, measurementId, 4, 'reject', { reason: 'The quantity is not what was done.' })).toMatchObject({ status: 200, json: { status: 'REJECTED' } });
      expect((await audits(measurementId, 'measurement.rejected'))[0]).toMatchObject({ reason: 'The quantity is not what was done.' });
      expect(await decide(APPROVER, measurementId, 5)).toMatchObject({ status: 409, json: { code: 'MEASUREMENT_STATE_INVALID' } });
    });

    it('is for whoever holds the right over the contract: a guest contractor sends but never approves', async () => {
      const target = await contract();
      await harness.seedGrants(TENANT_A, [{ n: 42, member: SECOND_GUEST, role: 96, kind: 'CONTRACT', refs: [target.id] }]);
      const made = await record(SECOND_GUEST, target);
      const measurementId = made.json.resource_id as string;
      expect((await submit(READER, measurementId)).status).toBe(403);
      expect((await submit(ELSEWHERE, measurementId)).status).toBe(404);
      expect((await submit(SECOND_GUEST, measurementId)).status).toBe(200);
      expect((await decide(SECOND_GUEST, measurementId, 2)).status).toBe(403);
      expect((await decide(READER, measurementId, 2)).status).toBe(403);
      expect((await decide(ELSEWHERE, measurementId, 2)).status).toBe(403);
      expect((await submit(RECORDER, randomUUID())).status).toBe(404);
    });
  });

  describe('correctMeasurement (AC-ST-CTR-008-1, UAT-AC311)', () => {
    it('supersedes an approved measurement and writes the next revision as a draft, with its audit row and its event', async () => {
      const target = await contract();
      const first = await approved(target, { quantity_period: '3500' });
      const second = await approved(target, { quantity_period: '1000', period_id: periods[1] });
      expect(await correct(READER, first.id, first.version)).toMatchObject({ status: 403 });
      const done = await correct(CORRECTOR, first.id, first.version);
      expect(done).toMatchObject({ status: 200, json: { status: 'DRAFT', resource_version: 1 } });
      const newId = done.json.resource_id as string;
      expect(newId).not.toBe(first.id);
      expect(await measurementRow(first.id)).toMatchObject({ status: 'SUPERSEDED' });
      expect(await measurementRow(newId)).toMatchObject({ status: 'DRAFT', revision: 2, quantity_period: '3000.000000', quantity_cumulative: '4000.000000' });
      expect(await measurementRow(second.id)).toMatchObject({ status: 'APPROVED' });
      const [audit] = await audits(newId, 'measurement.corrected');
      expect(audit).toMatchObject({ actor_id: memberId(CORRECTOR), reason: 'Re-measured on site.', safe_diff: { correction_of_id: first.id, superseded_id: first.id, quantity_period: '3000.000000', revision: 2 } });
      expect((await events(newId, 'ctr.measurement.corrected.v1'))[0]?.payload).toMatchObject({ measurement_id: newId, correction_of_id: first.id, status: 'DRAFT' });
      expect(await correct(CORRECTOR, first.id, first.version)).toMatchObject({ status: 409 });
    });

    it('refuses a measurement that is not approved, a negative quantity, and one that an active acceptance holds', async () => {
      const target = await contract();
      const made = await record(RECORDER, target);
      const measurementId = made.json.resource_id as string;
      expect(await correct(CORRECTOR, measurementId, 1)).toMatchObject({ status: 409, json: { code: 'MEASUREMENT_STATE_INVALID' } });
      const done = await approved(target, { period_id: periods[1], quantity_period: '100' });
      expect(await correct(CORRECTOR, done.id, done.version, { quantity_period: '-1' })).toMatchObject({ status: 422 });
      const acceptanceId = randomUUID();
      await seedAs(harness, [
        [
          `insert into machvon.acceptance (tenant_id, id, contract_id, measurement_ids, document_version_id, signer_refs, status, version, acceptance_no, accepted_amount_vnd, created_by, updated_by)
           values ($1, $2, $3, '[]'::jsonb, $4, '[]'::jsonb, 'DRAFT', 1, 'NT-Q1', 100000000, $5, $5)`,
          [TENANT_A, acceptanceId, target.id, cleanVersion, memberId(RECORDER)],
        ],
        [
          `insert into machvon.acceptance_line (tenant_id, id, acceptance_id, measurement_id, boq_item_id, contract_revision_id, quantity, unit_price_snapshot, amount_vnd, created_by, updated_by)
           values ($1, gen_random_uuid(), $2, $3, $4, $5, 100, 1000000, 100000000, $6, $6)`,
          [TENANT_A, acceptanceId, done.id, target.items[0], target.revisionId, memberId(RECORDER)],
        ],
      ]);
      expect(await correct(CORRECTOR, done.id, done.version)).toMatchObject({ status: 409, json: { code: 'MEASUREMENT_IN_ACTIVE_ACCEPTANCE' } });
      expect(await measurementRow(done.id)).toMatchObject({ status: 'APPROVED' });
    });
  });

  describe('the resource /resources/measurement', () => {
    it('lists the measurements in the scope of the caller a page at a time with what each may do, and reads one', async () => {
      const target = await contract();
      const first = await approved(target, { period_id: periods[0], quantity_period: '10' });
      const second = await record(RECORDER, target, { period_id: periods[1], quantity_period: '20' });
      const secondId = second.json.resource_id as string;
      const page = await call('GET', `/resources/measurement?contract_id=${target.id}&limit=1`, { member: RECORDER });
      expect(page.status).toBe(200);
      const items = page.json.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: first.id,
        contract: { id: target.id, code: target.code, status: 'ACTIVE' },
        boq_item: { business_key: 'B01', description: 'Item B01', unit_code: 'M3' },
        boq_quantity: '8000.000000',
        remaining_quantity: '7970.000000',
        period: { id: periods[0], code: '2026-01' },
        quantity_period: '10.000000',
        quantity_cumulative: '10.000000',
        revision: 1,
        status: 'APPROVED',
        actions: { submit: false, decide: false, correct: false },
        version: 3,
      });
      expect(page.json.next_cursor).toEqual(expect.any(String));
      const next = await call('GET', `/resources/measurement?contract_id=${target.id}&limit=1&cursor=${encodeURIComponent(page.json.next_cursor as string)}`, { member: RECORDER });
      const nextItems = next.json.items as Array<Record<string, unknown>>;
      expect(nextItems.map((item) => item.id)).toEqual([secondId]);
      expect(nextItems[0]).toMatchObject({ status: 'DRAFT', actions: { submit: true, decide: false, correct: false } });
      expect(next.json.next_cursor).toBeNull();

      const one = await call('GET', `/resources/measurement/${first.id}`, { member: CORRECTOR });
      expect(one).toMatchObject({ status: 200, json: { id: first.id, status: 'APPROVED', actions: { submit: false, decide: false, correct: true } } });
      expect(await call('GET', '/resources/measurement?contract_id=nope', { member: RECORDER })).toMatchObject({ status: 422 });
    });

    it('offers the decision to someone who did not record or send the measurement', async () => {
      const target = await contract();
      const made = await record(RECORDER, target);
      const measurementId = made.json.resource_id as string;
      await submit(RECORDER, measurementId);
      const forApprover = await call('GET', `/resources/measurement/${measurementId}`, { member: APPROVER });
      expect(forApprover.json).toMatchObject({ status: 'SUBMITTED', actions: { submit: false, decide: true, correct: false } });
      const forMaker = await call('GET', `/resources/measurement/${measurementId}`, { member: RECORDER });
      expect(forMaker.json).toMatchObject({ actions: { decide: false } });
    });

    it('keeps a draft to whoever recorded it, and a guest contractor to the measurements of its own contract', async () => {
      const target = await contract();
      const other = await contract();
      const draft = await record(RECORDER, target, { period_id: periods[0] });
      const draftId = draft.json.resource_id as string;
      const sent = await record(RECORDER, target, { period_id: periods[1] });
      await submit(RECORDER, sent.json.resource_id as string);
      await record(RECORDER, other, { period_id: periods[0] });
      const seen = (member: number, contractId: string) => call('GET', `/resources/measurement?contract_id=${contractId}`, { member }).then((reply) => (reply.json.items as Array<{ id: string }>).map((item) => item.id));
      expect(await seen(RECORDER, target.id)).toEqual([draftId, sent.json.resource_id]);
      expect(await seen(READER, target.id)).toEqual([sent.json.resource_id]);
      expect((await call('GET', `/resources/measurement/${draftId}`, { member: READER })).status).toBe(404);
      expect((await call('GET', `/resources/measurement/${draftId}`, { member: RECORDER })).status).toBe(200);

      await harness.seedGrants(TENANT_A, [{ n: 43, member: THIRD_GUEST, role: 96, kind: 'CONTRACT', refs: [target.id] }]);
      expect(await seen(THIRD_GUEST, target.id)).toEqual([sent.json.resource_id]);
      expect(await seen(THIRD_GUEST, other.id)).toEqual([]);
      const everyone = (await call('GET', '/resources/measurement?limit=200', { member: THIRD_GUEST })).json.items as Array<{ contract: { id: string } }>;
      expect(new Set(everyone.map((item) => item.contract.id))).toEqual(new Set([target.id]));
      expect((await call('GET', `/resources/measurement/${draftId}`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/resources/measurement/${randomUUID()}`, { member: RECORDER })).status).toBe(404);
      expect((await call('GET', `/resources/measurement/${draftId}`, { member: ELSEWHERE })).status).toBe(404);
    });
  });
});
