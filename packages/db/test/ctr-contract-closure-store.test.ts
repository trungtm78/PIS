import { randomUUID } from 'node:crypto';
import { CtrContractLifecycleStore } from '../src/ctr-contract-lifecycle-store';
import type { ContractCloseInput } from '../src/ctr-contract-lifecycle-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, contextFor, id, memberId } from './support/authz-fixtures';
import { seedAs } from './support/bid-proposal-fixtures';
import { CapWorld } from './support/cap-fixtures';
import { asSuperuser } from './support/ncr-fixtures';

const world = new CapWorld();
const harness = world.harness;
const lifecycle = new CtrContractLifecycleStore();
const FAMILY = 0xb1;
const LEADER = 1; // closes the contract, and drew the settlement up
const SENDER = 2; // sent the settlement
const VERIFIER = 3; // verified it
const CLOSER = 4; // closed it, approved its exception
const CONTRACTOR = id(FAMILY, 10);
const DOCUMENT = id(FAMILY, 30);
const VERSION = id(FAMILY, 31);
const TODAY = '2027-10-20';
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

/** A contract that was completed (or terminated) on a project with capital in force. */
async function seedContract(status: 'COMPLETED' | 'TERMINATED' | 'ACTIVE' = 'COMPLETED'): Promise<Seeded> {
  counter += 1;
  const contractId = randomUUID();
  const line = await world.publishedLine();
  await seedAs(harness, [
    [
      `insert into machvon.contract
         (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
          created_by, updated_by, signed_on, effective_from)
       values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 3, 'Contract', 'CONSTRUCTION', false, true, 10000000000, $7, $7, date '2026-01-02', date '2026-01-03')`,
      [TENANT_A, contractId, line.projectId, randomUUID(), CONTRACTOR, `HD-K-${String(counter).padStart(4, '0')}`, memberId(LEADER)],
    ],
  ]);
  if (status === 'COMPLETED') {
    await stage(
      "update machvon.contract set status = 'COMPLETED', completed_on = date '2027-08-01', completion_quality_acceptance_id = gen_random_uuid(), completed_by = $2::uuid where id = $1::uuid",
      [contractId, memberId(LEADER)],
    );
  } else if (status === 'TERMINATED') {
    await stage("update machvon.contract set status = 'TERMINATED', status_reason = 'Ended by decision.', status_decision_document_version_id = $2::uuid where id = $1::uuid", [contractId, VERSION]);
  }
  return { contractId, projectId: line.projectId };
}

/** What was paid out as advance and not recovered. */
const owesAdvance = (target: Seeded, vnd: string) => stage('update machvon.contract set advance_paid_vnd = $2::numeric where id = $1::uuid', [target.contractId, vnd]);

/** A settlement of the contract (or of its whole project), closed or only verified, with or without the exception approved for what is owed. */
async function settlement(target: Seeded, options: { scope?: 'CONTRACT' | 'PROJECT'; status?: 'CLOSED' | 'VERIFIED'; excepted?: boolean; contractId?: string; year?: number } = {}): Promise<string> {
  const settlementId = randomUUID();
  const closed = (options.status ?? 'CLOSED') === 'CLOSED';
  const scope = options.scope ?? 'CONTRACT';
  const excepted = options.excepted === true;
  await stage(
    `insert into machvon.settlement_revision
       (tenant_id, id, project_id, contract_id, revision, settled_amount_vnd, outstanding_vnd, unrecovered_advance_vnd, audit_finding_refs, status, settlement_scope, project_group,
        submitted_by, submitted_at, submitted_on, deadline_rule_version_id, deadline_days, verification_due_on, verified_by, verified_at, verified_on,
        closed_by, closed_at, close_reason, decision_document_version_id, exception_reason, exception_approved_by, exception_approved_at, exception_approval_document_version_id,
        created_by, updated_by, version)
     values ($1, $2, $3, $4, $5, 9000000000, 0, $6::numeric, '[]'::jsonb, $7, $8, 'B',
             $9, now(), date '2027-09-01', gen_random_uuid(), 120, date '2027-12-30', $10, now(), date '2027-09-20',
             $11, $12::timestamptz, $13, $14, $15, $16, $17::timestamptz, $18,
             $19, $19, 1)`,
    [
      TENANT_A,
      settlementId,
      target.projectId,
      scope === 'CONTRACT' ? (options.contractId ?? target.contractId) : null,
      (options.year ?? ++counter) % 1000,
      excepted ? '1250000000' : '0',
      closed ? 'CLOSED' : 'VERIFIED',
      scope,
      memberId(SENDER),
      memberId(VERIFIER),
      closed ? memberId(CLOSER) : null,
      closed ? '2027-10-01T03:00:00Z' : null,
      closed ? 'Closed after the verification.' : null,
      closed ? VERSION : null,
      excepted ? 'The advance is carried to the next year.' : null,
      excepted ? memberId(CLOSER) : null,
      excepted ? '2027-09-30T03:00:00Z' : null,
      excepted ? VERSION : null,
      memberId(LEADER),
    ],
  );
  return settlementId;
}

/** A hold of retention of the contract; a released one has its author, its day and its reason. */
async function hold(target: Seeded, options: { condition?: string; held?: string; released?: string } = {}): Promise<string> {
  const holdId = randomUUID();
  const held = options.held ?? '100000000';
  const released = options.released ?? '0';
  const status = released === '0' ? 'HELD' : released === held ? 'RELEASED' : 'PARTIALLY_RELEASED';
  await stage(
    `insert into machvon.retention_hold
       (tenant_id, id, contract_id, boq_item_id, acceptance_id, payment_request_id, held_vnd, released_vnd, release_condition, status, released_by, released_at, release_reason, created_by, updated_by)
     values ($1, $2, $3, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $4::numeric, $5::numeric, $6, $7, $8, $9::timestamptz, $10, $11, $11)`,
    [
      TENANT_A,
      holdId,
      target.contractId,
      held,
      released,
      options.condition ?? 'COMPLETION',
      status,
      released === '0' ? null : memberId(CLOSER),
      released === '0' ? null : '2027-10-02T03:00:00Z',
      released === '0' ? null : 'Released.',
      memberId(SENDER),
    ],
  );
  return holdId;
}

const warranty = (target: Seeded, status: 'ACTIVE' | 'CLOSED') =>
  stage(
    `insert into machvon.warranty_obligation
       (tenant_id, id, project_id, contract_id, handover_id, scope_description, starts_on, ends_on, period_months, retention_amount_vnd, status, created_by, updated_by, closed_by, closed_at)
     values ($1, gen_random_uuid(), $2, $3, gen_random_uuid(), 'Whole work', date '2026-01-01', date '2027-01-01', 12, 1, $4, $5, $5, case when $4 = 'CLOSED' then $5::uuid end, case when $4 = 'CLOSED' then now() end)`,
    [TENANT_A, target.projectId, target.contractId, status, memberId(LEADER)],
  );

const contractRow = async (contractId: string) => (await owner<{ status: string; version: string }>('select status, version::text from machvon.contract where id = $1::uuid', [contractId]))[0];
const changesOf = (contractId: string) =>
  owner<{ from_status: string; to_status: string; reason: string; command: string; created_by: string; effective_on: string }>(
    "select from_status, to_status, reason, command, created_by, effective_on::text from machvon.contract_status_change where contract_id = $1::uuid and to_status = 'CLOSED'",
    [contractId],
  );

const close = (target: Seeded, settlementId: string, options: { version?: number; scopes?: ContractScopes; note?: string } = {}, actor = LEADER) =>
  as(
    (tx) =>
      lifecycle.close(
        tx,
        target.contractId,
        options.version ?? 3,
        { settlementRevisionId: settlementId, ...(options.note === undefined ? {} : { note: options.note }) } satisfies ContractCloseInput,
        memberId(actor),
        options.scopes ?? everything,
        TODAY,
      ),
    actor,
  );

describe('the closure of a contract (ST-CTR-012)', () => {
  beforeAll(async () => {
    await world.start();
    await seedAs(harness, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3)`,
        [TENANT_A, DOCUMENT, memberId(LEADER)],
      ],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/closure.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, VERSION, DOCUMENT],
      ],
    ]);
  }, 240_000);

  afterAll(async () => {
    await world.stop();
  }, 60_000);

  it('AC-ST-CTR-012-1, UAT-AC300: refuses, guard by guard, while the settlement is open, the advance is owed and the retention is held, and closes once all are met', async () => {
    const target = await seedContract();
    await owesAdvance(target, '1250000000');
    const holdId = await hold(target, { held: '150000000' });
    const open = await settlement(target, { status: 'VERIFIED' });
    expect(await refusal(close(target, open))).toMatchObject({
      code: 'SETTLEMENT_NOT_CLOSED',
      status: 422,
      extensions: { settlement_status: 'VERIFIED', unmet: ['SETTLEMENT_NOT_CLOSED', 'ADVANCE_OUTSTANDING', 'RETENTION_UNRESOLVED'] },
    });
    expect(await contractRow(target.contractId)).toEqual({ status: 'COMPLETED', version: '3' });

    // The settlement closed with the exception approved for the advance: the retention is what is left.
    const excepted = await settlement(target, { excepted: true });
    expect(await refusal(close(target, excepted))).toMatchObject({
      code: 'RETENTION_UNRESOLVED',
      status: 422,
      extensions: { retention_holds: 1, retention_unresolved_vnd: '150000000', unmet: ['RETENTION_UNRESOLVED'] },
    });
    expect(await contractRow(target.contractId)).toEqual({ status: 'COMPLETED', version: '3' });

    // The retention is released: the contract closes, once, with its change of status written.
    await stage("update machvon.retention_hold set released_vnd = held_vnd, status = 'RELEASED', released_by = $2::uuid, released_at = now(), release_reason = 'Released.' where id = $1::uuid", [
      holdId,
      memberId(CLOSER),
    ]);
    const done = await close(target, excepted, { note: 'Closed after the settlement and the release.' });
    expect(done).toMatchObject({
      id: target.contractId,
      fromStatus: 'COMPLETED',
      status: 'CLOSED',
      version: 4,
      reason: 'Closed after the settlement and the release.',
      settlementRevisionId: excepted,
      advanceOutstandingVnd: '1250000000',
      settlementExcepted: true,
    });
    expect(await contractRow(target.contractId)).toEqual({ status: 'CLOSED', version: '4' });
    expect(await changesOf(target.contractId)).toEqual([
      { from_status: 'COMPLETED', to_status: 'CLOSED', reason: 'Closed after the settlement and the release.', command: 'closeContract', created_by: memberId(LEADER), effective_on: TODAY },
    ]);

    // A contract that is closed is closed: no command takes it on, and the database refuses the way back.
    expect(await refusal(close(target, excepted, { version: 4 }))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409 });
    expect((await databaseRefusal(owner("update machvon.contract set status = 'ACTIVE' where id = $1::uuid", [target.contractId]))).sqlstate).toBe('23514');
  });

  it('wants no advance owed unless the settlement that closed carries the exception approved for it', async () => {
    const target = await seedContract();
    await owesAdvance(target, '1250000000');
    const plain = await settlement(target);
    expect(await refusal(close(target, plain))).toMatchObject({ code: 'ADVANCE_OUTSTANDING', status: 422, extensions: { advance_outstanding_vnd: '1250000000', unmet: ['ADVANCE_OUTSTANDING'] } });
    expect(await close(target, await settlement(target, { excepted: true }))).toMatchObject({ status: 'CLOSED', settlementExcepted: true });
  });

  it('closes a contract with nothing owed and nothing held, whose reason is the default one when none is given', async () => {
    const target = await seedContract();
    expect(await close(target, await settlement(target))).toMatchObject({ status: 'CLOSED', reason: 'Closed after the settlement', advanceOutstandingVnd: '0', settlementExcepted: false });
  });

  it('closes a contract that was terminated, on the settlement of its whole project', async () => {
    const target = await seedContract('TERMINATED');
    expect(await close(target, await settlement(target, { scope: 'PROJECT' }))).toMatchObject({ fromStatus: 'TERMINATED', status: 'CLOSED' });
  });

  it('carries the retention that waits for the end of the warranty while a warranty obligation runs, and not once it has ended or when it waits for something else', async () => {
    const carried = await seedContract();
    await hold(carried, { condition: 'WARRANTY_END', held: '100000000', released: '40000000' });
    await warranty(carried, 'ACTIVE');
    const first = await settlement(carried);
    expect(await close(carried, first)).toMatchObject({ status: 'CLOSED' });

    const ended = await seedContract();
    await hold(ended, { condition: 'WARRANTY_END' });
    await warranty(ended, 'CLOSED');
    expect(await refusal(close(ended, await settlement(ended)))).toMatchObject({ code: 'RETENTION_UNRESOLVED', extensions: { retention_holds: 1, retention_unresolved_vnd: '100000000' } });

    const without = await seedContract();
    await hold(without, { condition: 'WARRANTY_END' });
    expect(await refusal(close(without, await settlement(without)))).toMatchObject({ code: 'RETENTION_UNRESOLVED' });

    const other = await seedContract();
    await hold(other, { condition: 'COMPLETION' });
    await warranty(other, 'ACTIVE');
    expect(await refusal(close(other, await settlement(other)))).toMatchObject({ code: 'RETENTION_UNRESOLVED' });

    const released = await seedContract();
    await hold(released, { condition: 'MANUAL_DECISION', released: '100000000' });
    expect(await close(released, await settlement(released))).toMatchObject({ status: 'CLOSED' });
  });

  it('refuses a settlement that is not there, is of another contract, or is not a settlement of the whole project or of the contract', async () => {
    const target = await seedContract();
    const other = await seedContract();
    const reason = (value: string) => ({ code: 'VALIDATION_FAILED', status: 422, detail: 'settlement_revision_id', extensions: { reason: value } });
    expect(await refusal(close(target, randomUUID()))).toMatchObject(reason('NOT_FOUND'));
    expect(await refusal(close(target, await settlement(other)))).toMatchObject(reason('NOT_A_SETTLEMENT_OF_THE_CONTRACT'));
    expect(await refusal(close(target, await settlement(other, { scope: 'PROJECT' })))).toMatchObject(reason('NOT_A_SETTLEMENT_OF_THE_CONTRACT'));
    expect(await refusal(close(target, 'nope'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'settlement_revision_id' });
    expect(await refusal(close(target, await settlement(target), { note: '   ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'note' });
    expect(await contractRow(target.contractId)).toEqual({ status: 'COMPLETED', version: '3' });
  });

  it('is for a contract that was completed or terminated, at the version the caller saw, inside its scope', async () => {
    const active = await seedContract('ACTIVE');
    expect(await refusal(close(active, await settlement(active)))).toMatchObject({ code: 'CONTRACT_STATE_INVALID', status: 409 });
    const target = await seedContract();
    const settled = await settlement(target);
    expect(await refusal(close(target, settled, { version: 9 }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 3 } });
    expect(await refusal(close(target, settled, { scopes: readOnly }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
    expect(await refusal(close(target, settled, { scopes: invisible }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(await contractRow(target.contractId)).toEqual({ status: 'COMPLETED', version: '3' });
  });

  describe('the readiness', () => {
    it('lists the settlements that could serve, the advance owed, the retention nothing carries and the guards not met', async () => {
      const target = await seedContract();
      await owesAdvance(target, '1250000000');
      await hold(target, { held: '150000000' });
      const none = await as((tx) => lifecycle.closureReadiness(tx, target.contractId));
      expect(none).toEqual({
        settlements: [],
        advanceOutstandingVnd: '1250000000',
        retention: { holds: 1, unresolvedVnd: '150000000' },
        unmet: ['SETTLEMENT_NOT_CLOSED', 'ADVANCE_OUTSTANDING', 'RETENTION_UNRESOLVED'],
      });
      await settlement(target, { status: 'VERIFIED' });
      expect((await as((tx) => lifecycle.closureReadiness(tx, target.contractId))).settlements).toEqual([]);
      const excepted = await settlement(target, { excepted: true });
      const project = await settlement(target, { scope: 'PROJECT' });
      const ready = await as((tx) => lifecycle.closureReadiness(tx, target.contractId));
      expect(ready.settlements.map((row) => row.id).sort()).toEqual([excepted, project].sort());
      expect(ready.settlements.find((row) => row.id === excepted)).toMatchObject({ scope: 'CONTRACT', excepted: true });
      expect(ready.unmet.length).toBeGreaterThan(0);
    });

    it('has nothing unmet for a contract that may be closed', async () => {
      const target = await seedContract();
      await settlement(target);
      expect(await as((tx) => lifecycle.closureReadiness(tx, target.contractId))).toMatchObject({ unmet: [], advanceOutstandingVnd: '0', retention: { holds: 0, unresolvedVnd: '0' } });
    });
  });
});
