import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { CapitalCommitments } from '../../src/modules/cap/commitment.port';
import { ContractController, ContractReadsController } from '../../src/modules/ctr/contract.controller';
import { ContractLifecycleController } from '../../src/modules/ctr/lifecycle.controller';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { asSuperuser } from '../../../../packages/db/test/support/ncr-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xb2;
const ROOT = 1;
const LEADER = 11; // contract.close, contract.read
const READER = 12; // contract.read
const NOBODY = 13;
const ELSEWHERE = 14; // the rights of LEADER over another branch
const GUEST = 15; // the contractor of the contracts
const SENDER = 16;
const VERIFIER = 17;
const CLOSER = 18; // closed the settlement, approved its exception
const MEMBERS = [LEADER, READER, NOBODY, ELSEWHERE, GUEST, SENDER, VERIFIER, CLOSER];
const OTHER_BRANCH = 5;
const DOCUMENT = id(FAMILY, 30);
const VERSION = id(FAMILY, 31);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the closure of a contract over HTTP (ST-CTR-012, AC-ST-CTR-012-1, UAT-AC300)', () => {
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
  const stage = (sql: string, params: unknown[] = []): Promise<void> => asSuperuser(harness.database.adminUrl, sql, params);
  const audits = (resourceId: string, action: string) =>
    rows<{ safe_diff: Record<string, unknown>; actor_id: string }>('select safe_diff, actor_id from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at, id', [
      resourceId,
      action,
    ]);
  const events = (aggregateId: string, type: string) =>
    rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id', [aggregateId, type]);
  const stored = async (contractId: string) => (await rows<{ status: string; version: string }>('select status, version::text from machvon.contract where id = $1::uuid', [contractId]))[0];

  interface Contract {
    id: string;
    projectId: string;
  }

  /** A contract that was completed (or terminated), worth ten billion, on a project with capital in force. */
  async function contract(status: 'COMPLETED' | 'TERMINATED' | 'ACTIVE' = 'COMPLETED'): Promise<Contract> {
    counter += 1;
    const line = await world.publishedLine();
    const contractId = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
            created_by, updated_by, signed_on, effective_from)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'Contract', 'CONSTRUCTION', false, true, 10000000000, $7, $7, date '2026-01-02', date '2026-01-03')`,
        [TENANT_A, contractId, line.projectId, randomUUID(), contractor, `HD-K-${String(counter).padStart(4, '0')}`, memberId(ROOT)],
      ],
    ]);
    if (status === 'COMPLETED') {
      await stage(
        "update machvon.contract set status = 'COMPLETED', completed_on = date '2027-08-01', completion_quality_acceptance_id = gen_random_uuid(), completed_by = $2::uuid where id = $1::uuid",
        [contractId, memberId(ROOT)],
      );
    } else if (status === 'TERMINATED') {
      await stage("update machvon.contract set status = 'TERMINATED', status_reason = 'Ended by decision.', status_decision_document_version_id = $2::uuid where id = $1::uuid", [contractId, VERSION]);
    }
    return { id: contractId, projectId: line.projectId };
  }

  const owesAdvance = (target: Contract, vnd: string) => stage('update machvon.contract set advance_paid_vnd = $2::numeric where id = $1::uuid', [target.id, vnd]);

  async function settlement(target: Contract, options: { status?: 'CLOSED' | 'VERIFIED'; excepted?: boolean } = {}): Promise<string> {
    const settlementId = randomUUID();
    const closed = (options.status ?? 'CLOSED') === 'CLOSED';
    const excepted = options.excepted === true;
    await stage(
      `insert into machvon.settlement_revision
         (tenant_id, id, project_id, contract_id, revision, settled_amount_vnd, outstanding_vnd, unrecovered_advance_vnd, audit_finding_refs, status, settlement_scope, project_group,
          submitted_by, submitted_at, submitted_on, deadline_rule_version_id, deadline_days, verification_due_on, verified_by, verified_at, verified_on,
          closed_by, closed_at, close_reason, decision_document_version_id, exception_reason, exception_approved_by, exception_approved_at, exception_approval_document_version_id,
          created_by, updated_by, version)
       values ($1, $2, $3, $4, $5, 9000000000, 0, $6::numeric, '[]'::jsonb, $7, 'CONTRACT', 'B',
               $8, now(), date '2027-09-01', gen_random_uuid(), 120, date '2027-12-30', $9, now(), date '2027-09-20',
               $10, $11::timestamptz, $12, $13, $14, $15, $16::timestamptz, $17,
               $18, $18, 1)`,
      [
        TENANT_A,
        settlementId,
        target.projectId,
        target.id,
        (counter += 1) % 1000,
        excepted ? '1250000000' : '0',
        closed ? 'CLOSED' : 'VERIFIED',
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
        memberId(ROOT),
      ],
    );
    return settlementId;
  }

  async function hold(target: Contract, released = '0'): Promise<string> {
    const holdId = randomUUID();
    await stage(
      `insert into machvon.retention_hold
         (tenant_id, id, contract_id, boq_item_id, acceptance_id, payment_request_id, held_vnd, released_vnd, release_condition, status, released_by, released_at, release_reason, created_by, updated_by)
       values ($1, $2, $3, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 150000000, $4::numeric, 'COMPLETION', $5, $6, $7::timestamptz, $8, $9, $9)`,
      [
        TENANT_A,
        holdId,
        target.id,
        released,
        released === '0' ? 'HELD' : 'RELEASED',
        released === '0' ? null : memberId(CLOSER),
        released === '0' ? null : '2027-10-02T03:00:00Z',
        released === '0' ? null : 'Released.',
        memberId(SENDER),
      ],
    );
    return holdId;
  }

  const close = (member: number, target: Contract, settlementId: string, version: number | string = 1, overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', `/contracts/${target.id}/close`, { member, ifMatch: `"${version}"`, ...(key === undefined ? {} : { key }), body: { settlement_revision_id: settlementId, ...overrides } });
  const summary = (member: number, target: Contract) => call('GET', `/contracts/${target.id}/summary`, { member });

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'CTR_CLOSER', ['contract.close', 'contract.read'], 50],
      [2, 'CTR_READER', ['contract.read'], 10],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 100 + n, code, permissions, rank);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: LEADER, role: 101, kind: 'TENANT' },
      { n: 2, member: READER, role: 102, kind: 'TENANT' },
      { n: 3, member: ELSEWHERE, role: 101, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
    ]);
    contractor = await seedContractor(harness);
    await seedAs(harness, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3)`,
        [TENANT_A, DOCUMENT, memberId(ROOT)],
      ],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ctr/closure.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, VERSION, DOCUMENT],
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
      controllers: [ContractController, ContractReadsController, ContractLifecycleController],
      providers: [{ provide: TenantDatabase, useValue: tenants }, { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) }, CapitalCommitments],
    });
  }, 480_000);

  afterAll(async () => {
    if (app) await app.close();
    await world.stop();
  }, 60_000);

  it('AC-ST-CTR-012-1, UAT-AC300: answers each guard that is not met with its code and keeps the status, then closes with its audit row and its event, and answers the same key once', async () => {
    const target = await contract();
    await owesAdvance(target, '1250000000');
    const holdId = await hold(target);
    const open = await settlement(target, { status: 'VERIFIED' });
    expect(await close(LEADER, target, open)).toMatchObject({
      status: 422,
      json: { code: 'SETTLEMENT_NOT_CLOSED', settlement_status: 'VERIFIED', unmet: ['SETTLEMENT_NOT_CLOSED', 'ADVANCE_OUTSTANDING', 'RETENTION_UNRESOLVED'] },
    });
    expect(await stored(target.id)).toEqual({ status: 'COMPLETED', version: '1' });
    const excepted = await settlement(target, { excepted: true });
    expect(await close(LEADER, target, excepted)).toMatchObject({
      status: 422,
      json: { code: 'RETENTION_UNRESOLVED', retention_holds: 1, retention_unresolved_vnd: '150000000', unmet: ['RETENTION_UNRESOLVED'] },
    });
    expect(await stored(target.id)).toEqual({ status: 'COMPLETED', version: '1' });

    await stage("update machvon.retention_hold set released_vnd = held_vnd, status = 'RELEASED', released_by = $2::uuid, released_at = now(), release_reason = 'Released.' where id = $1::uuid", [
      holdId,
      memberId(CLOSER),
    ]);
    const send = () => close(LEADER, target, excepted, 1, { note: 'Closed after the release.' }, 'close-once-for-this-key');
    const first = await send();
    expect(first).toMatchObject({ status: 200, json: { status: 'CLOSED', resource_version: 2, resource_id: target.id } });
    expect(await send()).toEqual(first);
    expect(await stored(target.id)).toEqual({ status: 'CLOSED', version: '2' });
    expect(await audits(target.id, 'contract.closed')).toHaveLength(1);
    expect((await audits(target.id, 'contract.closed'))[0]).toMatchObject({
      actor_id: memberId(LEADER),
      safe_diff: { from_status: 'COMPLETED', to_status: 'CLOSED', settlement_revision_id: excepted, advance_outstanding_vnd: '1250000000', settlement_excepted: true },
    });
    expect(await events(target.id, 'ctr.contract.closed.v1')).toHaveLength(1);
    expect((await events(target.id, 'ctr.contract.closed.v1'))[0]?.payload).toMatchObject({ contract_id: target.id, project_id: target.projectId, status: 'CLOSED', from_status: 'COMPLETED' });
    // A contract that is closed takes no further step.
    expect(await close(LEADER, target, excepted, 2)).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID' } });
  });

  it('closes a contract that was terminated, and refuses one that is still being performed', async () => {
    const ended = await contract('TERMINATED');
    expect(await close(LEADER, ended, await settlement(ended))).toMatchObject({ status: 200, json: { status: 'CLOSED' } });
    const active = await contract('ACTIVE');
    expect(await close(LEADER, active, await settlement(active))).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID' } });
  });

  it('refuses what is badly formed, a stale version and a settlement that is not there', async () => {
    const target = await contract();
    const settled = await settlement(target);
    expect(await close(LEADER, target, settled, 9)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
    expect(await close(LEADER, target, 'nope')).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await close(LEADER, target, randomUUID())).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await close(LEADER, target, settled, 1, { note: '   ' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
    expect(await close(LEADER, target, settled, 1, { status: 'CLOSED' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
    expect(await stored(target.id)).toEqual({ status: 'COMPLETED', version: '1' });
  });

  it('is for the people who hold the right over the contract', async () => {
    const target = await contract();
    const settled = await settlement(target);
    expect((await close(READER, target, settled)).status).toBe(403);
    expect((await close(NOBODY, target, settled)).status).toBe(403);
    expect((await close(GUEST, target, settled)).status).toBe(403);
    expect((await close(ELSEWHERE, target, settled)).status).toBe(404);
    expect((await close(LEADER, { ...target, id: randomUUID() }, settled)).status).toBe(404);
    expect(await stored(target.id)).toEqual({ status: 'COMPLETED', version: '1' });
  });

  it('shows the staff what stands before the closure and whether they may close, and shows it to no contractor', async () => {
    const target = await contract();
    await owesAdvance(target, '1250000000');
    await hold(target);
    const before = await summary(LEADER, target);
    expect(before.status).toBe(200);
    expect(before.json).toMatchObject({
      status: 'COMPLETED',
      closure: {
        settlements: [],
        advance_outstanding_vnd: '1250000000',
        retention: { holds: 1, unresolved_vnd: '150000000' },
        unmet: ['SETTLEMENT_NOT_CLOSED', 'ADVANCE_OUTSTANDING', 'RETENTION_UNRESOLVED'],
      },
      actions: { close: true },
    });
    const settled = await settlement(target, { excepted: true });
    const after = await summary(LEADER, target);
    expect(after.json.closure).toMatchObject({ settlements: [{ id: settled, scope: 'CONTRACT', excepted: true }], unmet: ['RETENTION_UNRESOLVED'] });
    expect(await summary(READER, target)).toMatchObject({ status: 200, json: { actions: { close: false } } });
    const guest = await summary(GUEST, target);
    expect(guest.json).not.toHaveProperty('closure');
    expect((await summary(LEADER, await contract('ACTIVE'))).json).not.toHaveProperty('closure');
  });
});
