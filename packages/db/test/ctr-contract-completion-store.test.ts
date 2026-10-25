import { randomUUID } from 'node:crypto';
import { CtrContractLifecycleStore } from '../src/ctr-contract-lifecycle-store';
import type { ContractCompleteInput } from '../src/ctr-contract-lifecycle-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, contextFor, id, memberId } from './support/authz-fixtures';
import { seedAs } from './support/bid-proposal-fixtures';
import { CapWorld } from './support/cap-fixtures';
import { asSuperuser, closeNcr } from './support/ncr-fixtures';

const world = new CapWorld();
const harness = world.harness;
const lifecycle = new CtrContractLifecycleStore();
const FAMILY = 0xb0;
const LEADER = 1;
const OTHER = 4;
const CONTRACTOR = id(FAMILY, 10);
const DOCUMENT = id(FAMILY, 30);
const VERSION = id(FAMILY, 31);
const TODAY = '2026-12-20';
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const readOnly: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const invisible: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'false', params: [] }) };

let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = LEADER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);
const stage = (sql: string, params: unknown[] = []): Promise<void> => asSuperuser(harness.database.adminUrl, sql, params);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const databaseRefusal = async (work: Promise<unknown>): Promise<{ message: string; sqlstate: string }> => {
  try {
    await work;
  } catch (error) {
    const e = error as { message: string; code?: string };
    return { message: e.message, sqlstate: e.code ?? '' };
  }
  throw new Error('expected the database to refuse');
};

interface Seeded {
  contractId: string;
  projectId: string;
}

/** A contract being performed (in force from 2026-01-03) of a project with capital in force. */
async function seedContract(status = 'ACTIVE'): Promise<Seeded> {
  counter += 1;
  const contractId = randomUUID();
  const line = await world.publishedLine();
  await seedAs(harness, [
    [
      `insert into machvon.contract
         (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
          created_by, updated_by, signed_on, effective_from, status_reason, status_decision_document_version_id)
       values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', $7, 3, 'Contract', 'CONSTRUCTION', false, true, 1000000, $8, $8, date '2026-01-02', date '2026-01-03', $9, $10)`,
      [
        TENANT_A,
        contractId,
        line.projectId,
        randomUUID(),
        CONTRACTOR,
        `HD-C-${String(counter).padStart(4, '0')}`,
        status,
        memberId(LEADER),
        status === 'SUSPENDED' ? 'Stopped.' : null,
        status === 'SUSPENDED' ? VERSION : null,
      ],
    ],
  ]);
  return { contractId, projectId: line.projectId };
}

/** Minutes of the contract with the scope and the status, approved on the day (Vietnam) when they are approved. */
async function minutes(target: Seeded, options: { scope?: string; status?: string; approvedOn?: string } = {}): Promise<string> {
  const minutesId = randomUUID();
  const status = options.status ?? 'APPROVED';
  await stage(
    `insert into machvon.quality_acceptance
       (tenant_id, id, project_id, contract_id, inspection_id, record_no, acceptance_scope, document_version_id, status, required_roles, content_hash, created_by, updated_by, version, approved_at, approved_by, decision_note)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, '["CONTRACTOR","SUPERVISOR","OWNER"]'::jsonb, repeat('a', 64), $10, $10, 1, $11::timestamptz, $12, $13)`,
    [
      TENANT_A,
      minutesId,
      target.projectId,
      target.contractId,
      randomUUID(),
      `QA-C-${minutesId.slice(0, 8)}`,
      options.scope ?? 'COMPLETION',
      VERSION,
      status,
      memberId(LEADER),
      status === 'APPROVED' ? `${options.approvedOn ?? '2026-12-10'}T03:00:00Z` : null,
      status === 'APPROVED' ? memberId(OTHER) : null,
      status === 'APPROVED' ? 'Approved for the test.' : null,
    ],
  );
  return minutesId;
}

const criticalNcr = async (target: Seeded, status = 'OPEN'): Promise<string> => {
  const ncrId = randomUUID();
  await stage(
    `insert into machvon.quality_nonconformance (tenant_id, id, project_id, contract_id, severity, action_owner_id, due_at, status, closure_evidence, blocks_acceptance, created_by, updated_by)
     values ($1, $2, $3, $4, 'CRITICAL', $5, now() + interval '7 days', $6, '{}'::jsonb, true, $5, $5)`,
    [TENANT_A, ncrId, target.projectId, target.contractId, memberId(OTHER), status === 'CLOSED' ? 'OPEN' : status],
  );
  if (status === 'CLOSED') await closeNcr(harness.database.adminUrl, ncrId, memberId(LEADER));
  return ncrId;
};

const measurement = async (target: Seeded, status = 'SUBMITTED'): Promise<string> => {
  const measurementId = randomUUID();
  await stage(
    `insert into machvon.measurement
       (tenant_id, id, contract_id, contract_revision_id, boq_line_id, boq_item_id, period_id, quantity_period, quantity_cumulative, revision, status, evidence_refs, reference_no, submitted_by, submitted_at, created_by, updated_by, version,
        decided_by, decided_at)
     values ($1, $2, $3, $4, $5, $6, $7, 1, 1, 1, $8, jsonb_build_array(jsonb_build_object('document_version_id', $9::text)), $10, $11, now(), $11, $11, 1, $12, $13)`,
    [
      TENANT_A,
      measurementId,
      target.contractId,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      status,
      VERSION,
      `M-${measurementId.slice(0, 8)}`,
      memberId(OTHER),
      status === 'APPROVED' ? memberId(LEADER) : null,
      status === 'APPROVED' ? new Date().toISOString() : null,
    ],
  );
  return measurementId;
};

const complete = (target: Seeded, minutesId: string, overrides: Partial<ContractCompleteInput> = {}, options: { version?: number; scopes?: ContractScopes; today?: string } = {}) =>
  as((tx) =>
    lifecycle.complete(
      tx,
      target.contractId,
      options.version ?? 3,
      { completionQualityAcceptanceId: minutesId, completedOn: '2026-12-15', ...overrides },
      memberId(LEADER),
      options.scopes ?? everything,
      options.today ?? TODAY,
    ),
  );

const rowOf = async (contractId: string) =>
  (
    await owner<{ status: string; version: string; completed_on: string | null; completion_quality_acceptance_id: string | null; completed_by: string | null }>(
      'select status, version::text, completed_on::text, completion_quality_acceptance_id, completed_by from machvon.contract where id = $1::uuid',
      [contractId],
    )
  )[0];
const historyOf = (contractId: string) =>
  owner<{ from_status: string; to_status: string; reason: string; effective_on: string; command: string; decision_document_version_id: string | null; created_by: string }>(
    'select from_status, to_status, reason, effective_on::text, command, decision_document_version_id, created_by from machvon.contract_status_change where contract_id = $1::uuid order by created_at, id',
    [contractId],
  );

describe('the completion of a contract (ST-CTR-011)', () => {
  beforeAll(async () => {
    await world.start();
    await harness.seedMembership(TENANT_A, OTHER, 1);
    await seedAs(harness, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3)`,
        [TENANT_A, DOCUMENT, memberId(LEADER)],
      ],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/minutes.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, VERSION, DOCUMENT],
      ],
    ]);
  }, 240_000);

  afterAll(async () => {
    await world.stop();
  }, 60_000);

  it('AC-ST-CTR-011-1, UAT-AC305: refuses while a serious non-conformance is open, then while a measurement waits, and then completes on the approved completion minutes', async () => {
    const target = await seedContract();
    const approved = await minutes(target);
    const ncr = await criticalNcr(target);
    const pending = await measurement(target);
    expect(await refusal(complete(target, approved))).toMatchObject({ code: 'OPEN_CRITICAL_NCR', status: 422, extensions: { nonconformance_ids: [ncr] } });

    await stage(
      "update machvon.quality_nonconformance set status = 'CLOSED', verified_by = $2::uuid, closed_by = $2::uuid, closed_at = now(), closure_note = 'closed for the test' where id = $1::uuid",
      [ncr, memberId(LEADER)],
    );
    expect(await refusal(complete(target, approved))).toMatchObject({ code: 'MEASUREMENT_PENDING', status: 422, extensions: { measurement_ids: [pending] } });
    expect((await rowOf(target.contractId))?.status).toBe('ACTIVE');

    await stage("update machvon.measurement set status = 'APPROVED', decided_by = $2::uuid, decided_at = now() where id = $1::uuid", [pending, memberId(LEADER)]);
    const done = await complete(target, approved);
    expect(done).toMatchObject({
      id: target.contractId,
      fromStatus: 'ACTIVE',
      status: 'COMPLETED',
      version: 4,
      completedOn: '2026-12-15',
      completionQualityAcceptanceId: approved,
      projectId: target.projectId,
    });
    expect(done.completionRecordNo).toBe(`QA-C-${approved.slice(0, 8)}`);
    expect(await rowOf(target.contractId)).toMatchObject({ status: 'COMPLETED', version: '4', completed_on: '2026-12-15', completion_quality_acceptance_id: approved, completed_by: memberId(LEADER) });
    const [history] = await historyOf(target.contractId);
    expect(history).toMatchObject({
      from_status: 'ACTIVE',
      to_status: 'COMPLETED',
      command: 'completeContract',
      effective_on: '2026-12-15',
      created_by: memberId(LEADER),
      reason: `Completed on the acceptance ${done.completionRecordNo}`,
    });
    expect(history?.decision_document_version_id).toBe(VERSION);
    // A contract that is completed is not completed again.
    expect(await refusal(complete(target, approved, {}, { version: 4 }))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409, extensions: { contract_status: 'COMPLETED' } });
  });

  it('completes only on minutes of the contract, for the completion of the work, that are approved', async () => {
    const target = await seedContract();
    const other = await seedContract();
    const refuse = (minutesId: string) => refusal(complete(target, minutesId));
    expect(await refuse(randomUUID())).toMatchObject({ code: 'COMPLETION_ACCEPTANCE_REQUIRED', status: 422, detail: 'completion_quality_acceptance_id', extensions: { reason: 'MISSING' } });
    expect(await refuse(await minutes(other))).toMatchObject({ extensions: { reason: 'MISSING' } });
    expect(await refuse(await minutes(target, { scope: 'WORK_ITEM' }))).toMatchObject({ code: 'COMPLETION_ACCEPTANCE_REQUIRED', extensions: { reason: 'NOT_COMPLETION' } });
    expect(await refuse(await minutes(target, { status: 'SIGNING' }))).toMatchObject({ extensions: { reason: 'NOT_APPROVED' } });
    expect(await refusal(complete(target, 'not-an-id'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'completion_quality_acceptance_id' });
    expect((await rowOf(target.contractId))?.status).toBe('ACTIVE');
  });

  it('completes on a day that is not before the contract took effect nor before the minutes were approved, and not in the future', async () => {
    const target = await seedContract();
    const approved = await minutes(target, { approvedOn: '2026-12-10' });
    expect(await refusal(complete(target, approved, { completedOn: '2026-12-09' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'completed_on' });
    expect(await refusal(complete(target, approved, { completedOn: '2026-12-21' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'completed_on' });
    expect(await refusal(complete(target, approved, { completedOn: '2026-02-30' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'completed_on' });
    expect(await refusal(complete(target, approved, { completedOn: 'yesterday' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'completed_on' });
    expect(await complete(target, approved, { completedOn: '2026-12-10' })).toMatchObject({ status: 'COMPLETED', completedOn: '2026-12-10' });
  });

  it('is judged on the status, the version and the scope of the caller', async () => {
    const draft = await seedContract('DRAFT');
    const suspended = await seedContract('SUSPENDED');
    expect(await refusal(complete(draft, await minutes(draft)))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409, extensions: { contract_status: 'DRAFT' } });
    expect(await refusal(complete(suspended, await minutes(suspended)))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', extensions: { contract_status: 'SUSPENDED' } });
    const target = await seedContract();
    const approved = await minutes(target);
    expect(await refusal(complete(target, approved, {}, { version: 9 }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
    expect((await refusal(complete(target, approved, {}, { scopes: readOnly }))).status).toBeGreaterThanOrEqual(403);
    expect(await refusal(complete(target, approved, {}, { scopes: invisible }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(await refusal(complete({ ...target, contractId: randomUUID() }, approved))).toMatchObject({ status: 404 });
    expect((await rowOf(target.contractId))?.status).toBe('ACTIVE');
  });

  it('shows what stands in the way: the approved completion minutes, the serious non-conformances that are open and the measurements to be decided', async () => {
    const target = await seedContract();
    const nothing = await as((tx) => lifecycle.completionReadiness(tx, target.contractId));
    expect(nothing).toEqual({ acceptances: [], openCriticalNcrIds: [], pendingMeasurementIds: [] });
    const older = await minutes(target, { approvedOn: '2026-12-01' });
    const newer = await minutes(target, { approvedOn: '2026-12-12' });
    await minutes(target, { scope: 'STAGE' });
    await minutes(target, { status: 'SIGNING' });
    const open = await criticalNcr(target, 'ACTION_ASSIGNED');
    await criticalNcr(target, 'CLOSED');
    const submitted = await measurement(target);
    await measurement(target, 'APPROVED');
    const ready = await as((tx) => lifecycle.completionReadiness(tx, target.contractId));
    expect(ready.acceptances.map((item) => [item.id, item.approvedOn])).toEqual([
      [newer, '2026-12-12'],
      [older, '2026-12-01'],
    ]);
    expect(ready.openCriticalNcrIds).toEqual([open]);
    expect(ready.pendingMeasurementIds).toEqual([submitted]);
  });

  it('keeps the completion with the contract: it names the minutes and the person, and does not change once written', async () => {
    const target = await seedContract();
    const approved = await minutes(target);
    await complete(target, approved);
    expect(await databaseRefusal(owner("update machvon.contract set completed_on = date '2026-12-01' where id = $1::uuid", [target.contractId]))).toMatchObject({
      sqlstate: '23514',
      message: expect.stringContaining('does not change'),
    });
    expect((await databaseRefusal(owner('update machvon.contract set completed_by = null where id = $1::uuid', [target.contractId]))).sqlstate).toBe('23514');
    // A contract cannot be COMPLETED without its day, its minutes and its person.
    const bare = await seedContract();
    expect((await databaseRefusal(owner("update machvon.contract set status = 'COMPLETED' where id = $1::uuid", [bare.contractId]))).message).toContain('contract_completion_chk');
    expect((await databaseRefusal(owner("update machvon.contract set completed_on = date '2026-12-01' where id = $1::uuid", [bare.contractId]))).message).toContain('contract_completion_fields_chk');
  });
});
