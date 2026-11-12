import { createHash, randomUUID } from 'node:crypto';
import { LogCapacityJob, TenantDatabase } from '@machvon/db';
import type { LogArchiveSink } from '@machvon/db';
import type { MetricsSink } from '@machvon/kernel';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { assertRefusedForPermission, assertStatus, expectCheckFails } from './uat-kit';
import type { Reply } from './uat-kit';
import { ROOT_UNIT, UatWorld } from './uat-world';

/**
 * Design cases of the administration and the equipment procurement of the enterprise edition that no suite named yet (docs/uat/ent): the nightly capacity job of the log classes with the commands that set the caps
 * (UAT-ADM-ENT4E-2) and the line of the equipment procurement read by a full and a limited reader, linked, reused and cancelled (UAT-EQP-ENT4E-1, UAT-ENT-EQP-01). The world is the whole enterprise edition over a real database.
 * The chain of BID, CTR and PAY that the equipment view reads (package, award, contract, settled payment) is seeded as rows: the commands of those modules are proved by their own suites; this suite proves what the view
 * and the commands of the line do with them. The nightly job is run as the worker runs it (`LogCapacityJob`) over the database of the world, with an in-memory archive store behind the port of the object store.
 */
jest.setTimeout(600_000);

const WORKER = '00000000-0000-4000-8000-000000000000';
const FAMILY = 0xc6;
const PERSONAS = {
  'eqp-manager': ['bid.plan.manage', 'bid.read'],
  'eqp-full': ['bid.read', 'contract.read', 'payment_request.read'],
  'eqp-limited': ['bid.read'],
  'cap-admin': ['adm.log_capacity.manage', 'adm.log_capacity.read'],
  'cap-reader': ['adm.log_capacity.read'],
};

describe('UAT of the log capacity and the equipment procurement of the enterprise edition (cases of docs/uat/ent)', () => {
  const world = new UatWorld();

  beforeAll(async () => {
    await world.start(PERSONAS);
  }, 600_000);

  afterAll(() => world.stop(), 60_000);

  it('UAT-ADM-ENT4E-2 the nightly job archives only the oldest rows beyond the retention to a hashed file and then deletes exactly those, young rows and rows under legal hold stay, the audit trail is measured and alerts but loses no row, the second run deletes nothing; a reader may not set a cap (403) and a cap needs a reason (422)', async () => {
    const tenants = world.get<TenantDatabase>(TenantDatabase);
    const ctx = { tenantId: TENANT_A, membershipId: WORKER, scopeVersion: 0 };
    const files = new Map<string, Uint8Array>();
    const sink: LogArchiveSink = {
      storeGenerated: async (_tenant, kind, fileId, bytes) => {
        const key = `${kind}/${fileId}`;
        files.set(key, bytes);
        return key;
      },
    };
    const gauges: Array<{ name: string; value: number; labels: Record<string, string> }> = [];
    const metrics: MetricsSink = { increment: () => undefined, gauge: (name, value, labels) => void gauges.push({ name, value, labels: labels ?? {} }) };
    // The events of the outbox: eight published 400 to 407 days ago (beyond the 30 days of the platform), three published 600 days ago whose aggregates a legal hold contains, four published yesterday.
    const publish = (eventId: string, aggregateId: string, daysAgo: number, n: number): [string, unknown[]] => [
      `insert into machvon.outbox_event (tenant_id, id, aggregate_id, type, schema_version, payload, created_at, published_at, aggregate_type, aggregate_version, event_key, correlation_id, status)
       values ($1, $2, $3, 'uat.case.v1', 1, '{}', now(), now() - make_interval(days => $4::int), 'widget', 1, $5, gen_random_uuid(), 'PUBLISHED')`,
      [TENANT_A, eventId, aggregateId, daysAgo, `uat-e2-${n}`],
    ];
    const old = Array.from({ length: 8 }, (_, n) => ({ event: randomUUID(), aggregate: randomUUID(), days: 400 + n }));
    const held = Array.from({ length: 3 }, () => ({ event: randomUUID(), aggregate: randomUUID(), days: 600 }));
    const young = Array.from({ length: 4 }, () => ({ event: randomUUID(), aggregate: randomUUID(), days: 1 }));
    await world.seedAsAdmin([
      ...[...old, ...held, ...young].map((one, n) => publish(one.event, one.aggregate, one.days, n)),
      [
        `insert into machvon.legal_hold (tenant_id, id, resource_scope, authority_reference, reason, effective_at, hold_kind, status, placed_by, version)
         values ($1, $2, $3::jsonb, 'Inspection decision 12/2026', 'A hold for the capacity case', '2026-01-01T00:00:00Z', 'AUDIT', 'Active', $4, 1)`,
        [TENANT_A, randomUUID(), JSON.stringify({ kind: 'RESOURCE', ids: held.map((one) => one.aggregate) }), memberId(1)],
      ],
    ]);
    const count = async (table: string, where = 'true', params: unknown[] = []): Promise<number> => Number((await world.rows<{ n: string }>(`select count(*)::text as n from machvon.${table} where ${where}`, params))[0]?.n);
    const present = async (ids: string[]): Promise<number> => count('outbox_event', 'id = any($1::uuid[])', [ids]);
    const total = await count('outbox_event');
    // A cap whose low-water mark (90 percent of it) leaves five rows to archive: the eight old rows are eligible, so the five oldest go (the commands below add no row to the outbox; the count is read again before the run).
    const cap = Array.from({ length: total }, (_, n) => n + 1).filter((candidate) => candidate < total && Math.floor((candidate * 90) / 100) === total - 5).pop() as number;
    expect(cap).toBeGreaterThan(0);
    const body = { record_class: 'outbox_event', max_rows: cap, max_bytes: null, warn_pct: 80, active: true, reason: 'The outbox grows by a million rows a week', expected_version: 0 };
    // A reader may not set a cap (403), a cap needs a reason (422 VALIDATION_FAILED), and nothing is stored by either.
    assertRefusedForPermission(await world.as('cap-reader', 'POST', '/log-capacity', { body }));
    assertStatus(await world.as('cap-admin', 'POST', '/log-capacity', { body: { ...body, reason: '' } }), 422, 'VALIDATION_FAILED');
    expect(await count('log_capacity_policy')).toBe(0);
    const saved = await world.as('cap-admin', 'POST', '/log-capacity', { body });
    assertStatus(saved, 200);
    expect(saved.json).toMatchObject({ resource_version: 1 });
    expect((await world.audits(saved.json.resource_id as string, 'adm.log_capacity_policy_saved'))[0]).toMatchObject({ reason: body.reason, safe_diff: { record_class: 'outbox_event', to_max_rows: cap } });
    // The audit trail has a cap of its own, far below its size: it is a class that is measured and alerted, never emptied.
    const auditCap = await world.as('cap-admin', 'POST', '/log-capacity', { body: { record_class: 'audit_event', max_rows: 1, max_bytes: null, warn_pct: 80, active: true, reason: 'The audit trail is measured against one row', expected_version: 0 } });
    assertStatus(auditCap, 200);
    const auditBefore = await count('audit_event');
    expect(await count('outbox_event')).toBe(total);
    // The first night: the five oldest eligible rows, in one hashed file, and exactly those are deleted.
    const first = await new LogCapacityJob(tenants, { archives: sink, metrics }).run(ctx, new Date());
    expect(first.archived.outbox_event).toBe(5);
    const doomed = old.slice(3).map((one) => one.event);
    expect(await present(doomed)).toBe(0);
    expect(await present(old.slice(0, 3).map((one) => one.event))).toBe(3);
    expect(await present(held.map((one) => one.event))).toBe(3);
    expect(await present(young.map((one) => one.event))).toBe(4);
    expect(await count('outbox_event')).toBe(total - 5);
    const [batch] = await world.rows<{ status: string; row_count: string; file_key: string; file_sha256: string; record_class: string }>('select status, row_count::text, file_key, file_sha256, record_class from machvon.log_archive_batch');
    expect(batch).toMatchObject({ status: 'PURGED', row_count: '5', record_class: 'outbox_event' });
    const file = files.get(batch?.file_key ?? '') as Uint8Array;
    expect(createHash('sha256').update(file).digest('hex')).toBe(batch?.file_sha256);
    const archived = Buffer.from(file).toString('utf8').trim().split('\n').map((line) => (JSON.parse(line) as { id: string }).id);
    expect(archived.sort()).toEqual([...doomed].sort());
    // The audit trail lost no row, is over its cap and says so (state OVER, exceeded, and the gauge of the alert is 1).
    expect(first.states.audit_event).toBe('OVER');
    expect(first.exceeded).toContain('audit_event');
    expect(first.archived.audit_event).toBeUndefined();
    expect(await count('audit_event')).toBeGreaterThanOrEqual(auditBefore);
    expect(gauges.find((one) => one.name === 'log_capacity_exceeded' && one.labels.record_class === 'audit_event')?.value).toBe(1);
    // The second night deletes nothing: the class is back under its cap.
    const second = await new LogCapacityJob(tenants, { archives: sink, metrics }).run(ctx, new Date());
    expect(second.archived.outbox_event).toBeUndefined();
    expect(await count('outbox_event')).toBe(total - 5);
    expect(await count('log_archive_batch')).toBe(1);
    // The screen reads the same: the cap, the reading of each class and the batch with its hash.
    const overview = await world.as('cap-reader', 'GET', '/log-capacity');
    assertStatus(overview, 200);
    expect((overview.json.batches as Array<Record<string, unknown>>)[0]).toMatchObject({ record_class: 'outbox_event', status: 'PURGED', rows: 5, file_sha256: batch?.file_sha256 });
    expect((overview.json.readings as Array<Record<string, unknown>>).find((one) => one.record_class === 'audit_event')).toMatchObject({ kind: 'MONITOR_ONLY', state: 'OVER' });
    expect((overview.json.policies as Array<Record<string, unknown>>).find((one) => one.record_class === 'outbox_event')).toMatchObject({ max_rows: cap, active: true, version: 1 });
  });

  it('UAT-EQP-ENT4E-1 / UAT-ENT-EQP-01 a full reader sees the stage DISBURSING and the share paid, a limited reader sees the contract and payment figures masked and never 0; a package of another project is 422 EQUIPMENT_LINK_INVALID, a reused code 409 EQUIPMENT_LINE_CODE_TAKEN, a cancelled line 409 EQUIPMENT_LINE_STATE_INVALID, a cancel without a reason 422 VALIDATION_FAILED', async () => {
    // The projects and the chain behind the line: a package with an approved award, a contract of 1,000 dong and a settled payment of 400 (project one); a package of project two.
    const project = async (label: string): Promise<string> => {
      const projectId = randomUUID();
      await world.seedAsAdmin([
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
           values ($1, $2, $3, $3, $4, $4, $5, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
          [TENANT_A, projectId, `UAT-C6-${label}`, unitId(ROOT_UNIT), id(FAMILY, 90)],
        ],
      ]);
      return projectId;
    };
    const [one, two] = [await project('ONE'), await project('TWO')];
    const [packageOne, packageTwo, contractor, contract, revision] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await world.seedAsAdmin([
      [`insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id) values ($1, $2, '0100000666', 'The supplier of the equipment', 'VERIFIED', $3)`, [TENANT_A, contractor, randomUUID()]],
      ...[[packageOne, one, 'PKG-C6-ONE'], [packageTwo, two, 'PKG-C6-TWO']].map(
        ([packageId, projectId, code]): [string, unknown[]] => [
          `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by, version) values ($1, $2, $3, $4, 1200, 'OPEN_BIDDING', 1, 'AWARDED', $5, $6, 1)`,
          [TENANT_A, packageId, projectId, code, `Equipment ${code}`, memberId(1)],
        ],
      ),
      [
        `insert into machvon.procurement_result (tenant_id, id, package_id, winner_contractor_id, award_price_vnd, decision_document_id, outcome, status, submitted_by, approved_by, approved_at, created_by, updated_by)
         values ($1, $2, $3, $4, 1000, $5, 'AWARDED', 'APPROVED', $6, $7, now() - interval '10 days', $6, $6)`,
        [TENANT_A, randomUUID(), packageOne, contractor, randomUUID(), memberId(1), memberId(2)],
      ],
      [
        `insert into machvon.contract (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, contract_value_vnd, signed_on, effective_from)
         values ($1, $2, $3, $4, $5, 'HD-C6-ONE', 'LUMP_SUM', 'VND', 'ACTIVE', 1, 1000, date '2026-01-01', date '2026-01-01')`,
        [TENANT_A, contract, one, packageOne, contractor],
      ],
      [
        `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by, decided_by, decided_at)
         values ($1, $2, $3, 1, 1000, $4, date '2026-01-02', 'EFFECTIVE', 'BASE', 1, $5, $5, $5, now())`,
        [TENANT_A, revision, contract, randomUUID(), memberId(1)],
      ],
      [
        `insert into machvon.payment_request (tenant_id, id, project_id, contract_id, acceptance_id, currency, gross_vnd, advance_recovery_vnd, retention_vnd, tax_adjustment_vnd, net_vnd, status, version, claims_acceptance, request_no, created_by, submitted_by,
            treasury_paid_on, settled_transaction_id, settled_by, settled_at)
         values ($1, $2, $3, $4, $5, 'VND', 400, 0, 0, 0, 400, 'SETTLED', 1, true, 'DNTT-C6-1', $6, $6, date '2026-03-20', $7, $6, now())`,
        [TENANT_A, randomUUID(), one, contract, randomUUID(), memberId(1), randomUUID()],
      ],
    ]);
    const create = (projectId: string, code: string, value = '1200'): Promise<Reply> =>
      world.as('eqp-manager', 'POST', '/equipment-procurement', { body: { project_id: projectId, code, name: `Equipment ${code}`, planned_value_vnd: value } });
    const patch = (lineId: string, version: number, body: Record<string, unknown>): Promise<Reply> => world.as('eqp-manager', 'PATCH', `/equipment-procurement/${lineId}`, { ifMatch: version, body });
    const line = async (persona: string, lineId: string): Promise<Record<string, unknown>> => {
      const read = await world.as(persona, 'GET', `/equipment-procurement/${lineId}`);
      assertStatus(read, 200);
      return read.json.line as Record<string, unknown>;
    };
    // The line of project one is linked to its package and its contract (each once) and shows the whole chain to the reader who may see it.
    const made = await create(one, 'EQ-001');
    assertStatus(made, 200);
    const lineId = made.json.resource_id as string;
    expect((await world.audits(lineId, 'bid.equipment_line_created'))[0]?.safe_diff).toMatchObject({ code: 'EQ-001', planned_value_vnd: '1200' });
    expect(await line('eqp-full', lineId)).toMatchObject({ stage: 'PLANNED', package: null, contract: null, paid_vnd: null });
    const packaged = await patch(lineId, 1, { package_id: packageOne });
    assertStatus(packaged, 200);
    assertStatus(await patch(lineId, 2, { contract_id: contract }), 200);
    const full = await line('eqp-full', lineId);
    expect(full).toMatchObject({
      stage: 'DISBURSING',
      status: 'ACTIVE',
      planned_value_vnd: '1200',
      contract_value_vnd: '1000',
      plan_variance_vnd: '-200',
      paid_vnd: '400',
      disbursement_percent: '40.0',
      masked: [],
      package: { code: 'PKG-C6-ONE', status: 'AWARDED' },
      selection: { outcome: 'AWARDED', status: 'APPROVED', award_price_vnd: '1000', winner_name: 'The supplier of the equipment' },
      contract: { code: 'HD-C6-ONE' },
    });
    // The limited reader sees the line and its stage, and the figures of the contract and the payments are masked and named: null, never 0.
    const limited = await line('eqp-limited', lineId);
    expect(limited).toMatchObject({ stage: 'DISBURSING', contract_value_vnd: null, plan_variance_vnd: null, paid_vnd: null, disbursement_percent: null, contract: null, masked: ['CONTRACT', 'PAYMENT'], planned_value_vnd: '1200' });
    expect(JSON.stringify(limited)).not.toMatch(/"(contract_value_vnd|paid_vnd|disbursement_percent)":(0|"0")/);
    const listed = await world.as('eqp-limited', 'GET', `/equipment-procurement?project_id=${one}`);
    expect((listed.json.items as Array<Record<string, unknown>>).map((item) => [item.code, item.paid_vnd, item.masked])).toEqual([['EQ-001', null, ['CONTRACT', 'PAYMENT']]]);
    // A line of project one linked to the package of project two is refused by the database guard (422 EQUIPMENT_LINK_INVALID) and stays as it was.
    const other = await create(one, 'EQ-002', '500');
    const otherId = other.json.resource_id as string;
    assertStatus(await patch(otherId, 1, { package_id: packageTwo }), 422, 'EQUIPMENT_LINK_INVALID');
    expect(await line('eqp-full', otherId)).toMatchObject({ stage: 'PLANNED', package: null, version: 1 });
    // A code that the project already has is 409 EQUIPMENT_LINE_CODE_TAKEN, and the other project may use it.
    assertStatus(await create(one, 'EQ-001'), 409, 'EQUIPMENT_LINE_CODE_TAKEN');
    assertStatus(await create(two, 'EQ-001'), 200);
    // A cancel without a reason is 422 VALIDATION_FAILED and changes nothing; with a reason it ends the line, which no command can change again (409 EQUIPMENT_LINE_STATE_INVALID).
    assertStatus(await patch(otherId, 1, { cancel_reason: '' }), 422, 'VALIDATION_FAILED');
    expect(await line('eqp-full', otherId)).toMatchObject({ status: 'ACTIVE', version: 1 });
    const cancelled = await patch(otherId, 1, { cancel_reason: 'The item left the plan of the year' });
    assertStatus(cancelled, 200);
    expect((await world.audits(otherId, 'bid.equipment_line_updated'))[0]).toMatchObject({ reason: 'The item left the plan of the year', safe_diff: { cancelled: true } });
    expect(await line('eqp-full', otherId)).toMatchObject({ stage: 'CANCELLED', status: 'CANCELLED' });
    assertStatus(await patch(otherId, 2, { name: 'Renamed after the cancel' }), 409, 'EQUIPMENT_LINE_STATE_INVALID');
    expect(((await world.as('eqp-full', 'GET', `/equipment-procurement?project_id=${one}`)).json.items as Array<{ code: string }>).map((item) => item.code)).toEqual(['EQ-001']);
    // Only the holder of bid.plan.manage changes a line; a reader is refused.
    assertRefusedForPermission(await world.as('eqp-full', 'PATCH', `/equipment-procurement/${lineId}`, { ifMatch: 3, body: { name: 'A reader renames it' } }));
  });

  it('negative control: the checks of this suite go red on an answer that is wrong on purpose', () => {
    expectCheckFails(() => assertStatus({ status: 200, json: {} }, 422, 'EQUIPMENT_LINK_INVALID'));
    expectCheckFails(() => assertStatus({ status: 422, json: { code: 'VALIDATION_FAILED' } }, 422, 'EQUIPMENT_LINK_INVALID'));
    expectCheckFails(() => assertRefusedForPermission({ status: 200, json: {} }));
  });
});
