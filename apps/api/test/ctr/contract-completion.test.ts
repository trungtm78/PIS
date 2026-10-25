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
const FAMILY = 0xb1;
const ROOT = 1;
const LEADER = 11; // contract.complete, contract.read
const READER = 12; // contract.read
const NOBODY = 13;
const ELSEWHERE = 14; // the rights of LEADER over another branch
const GUEST = 15; // the contractor of the contracts, reading the one it was invited to
const MEMBERS = [LEADER, READER, NOBODY, ELSEWHERE, GUEST];
const OTHER_BRANCH = 5;
const DOCUMENT = id(FAMILY, 30);
const VERSION = id(FAMILY, 31);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

/** The Vietnam day of today: a contract is completed on a day that is not in the future. */
const vietnamToday = (): string => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

describe('the completion of a contract over HTTP (ST-CTR-011)', () => {
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
    rows<{ safe_diff: Record<string, unknown>; actor_id: string; reason: string | null }>(
      'select safe_diff, actor_id, reason from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at, id',
      [resourceId, action],
    );
  const events = (aggregateId: string, type: string) =>
    rows<{ payload: Record<string, unknown>; aggregate_version: string }>(
      'select payload, aggregate_version::text as aggregate_version from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id',
      [aggregateId, type],
    );
  const stored = async (contractId: string) =>
    (
      await rows<{ status: string; version: string; completed_on: string | null; completion_quality_acceptance_id: string | null }>(
        'select status, version::text, completed_on::text, completion_quality_acceptance_id from machvon.contract where id = $1::uuid',
        [contractId],
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
    await seedAs(harness, [
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
            created_by, updated_by, signed_on, effective_from, status_reason, status_decision_document_version_id)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', $7, 1, 'Contract', 'CONSTRUCTION', false, true, 1000000, $8, $8, date '2026-01-02', date '2026-01-03', $9, $10)`,
        [
          TENANT_A,
          contractId,
          line.projectId,
          randomUUID(),
          contractor,
          `HD-Z-${String(counter).padStart(4, '0')}`,
          status,
          memberId(ROOT),
          status === 'SUSPENDED' ? 'Stopped.' : null,
          status === 'SUSPENDED' ? VERSION : null,
        ],
      ],
    ]);
    return { id: contractId, projectId: line.projectId };
  }

  async function minutes(target: Contract, scope = 'COMPLETION'): Promise<string> {
    const minutesId = randomUUID();
    await stage(
      `insert into machvon.quality_acceptance
         (tenant_id, id, project_id, contract_id, inspection_id, record_no, acceptance_scope, document_version_id, status, required_roles, content_hash, created_by, updated_by, version, approved_at, approved_by, decision_note)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'APPROVED', '["CONTRACTOR","SUPERVISOR","OWNER"]'::jsonb, repeat('a', 64), $9, $9, 1, timestamptz '2026-01-10T03:00:00Z', $10, 'Approved for the test.')`,
      [TENANT_A, minutesId, target.projectId, target.id, randomUUID(), `QA-Z-${minutesId.slice(0, 8)}`, scope, VERSION, memberId(ROOT), memberId(LEADER)],
    );
    return minutesId;
  }

  const complete = (member: number, target: Contract, minutesId: string, version: number | string = 1, overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', `/contracts/${target.id}/complete`, {
      member,
      ifMatch: `"${version}"`,
      ...(key === undefined ? {} : { key }),
      body: { completion_quality_acceptance_id: minutesId, completed_on: vietnamToday(), ...overrides },
    });
  const summary = (member: number, target: Contract) => call('GET', `/contracts/${target.id}/summary`, { member });

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [{ n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` }]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'CTR_COMPLETER', ['contract.complete', 'contract.read'], 50],
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
         values ($1, $2, $3, 1, 'tenants/ctr/minutes.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
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

  describe('completeContract (AC-ST-CTR-011-1, UAT-AC305)', () => {
    it('refuses while a serious non-conformance is open and while a measurement waits, then completes with its audit row and its event, and answers the same key once', async () => {
      const target = await contract();
      const approved = await minutes(target);
      const ncrId = randomUUID();
      await stage(
        `insert into machvon.quality_nonconformance (tenant_id, id, project_id, contract_id, severity, action_owner_id, due_at, status, closure_evidence, blocks_acceptance, created_by, updated_by)
         values ($1, $2, $3, $4, 'CRITICAL', $5, now() + interval '7 days', 'OPEN', '{}'::jsonb, true, $5, $5)`,
        [TENANT_A, ncrId, target.projectId, target.id, memberId(ROOT)],
      );
      const measurementId = randomUUID();
      await stage(
        `insert into machvon.measurement
           (tenant_id, id, contract_id, contract_revision_id, boq_line_id, boq_item_id, period_id, quantity_period, quantity_cumulative, revision, status, evidence_refs, reference_no, submitted_by, submitted_at, created_by, updated_by, version)
         values ($1, $2, $3, $4, $5, $6, $7, 1, 1, 1, 'SUBMITTED', jsonb_build_array(jsonb_build_object('document_version_id', $8::text)), 'M-Z-1', $9, now(), $9, $9, 1)`,
        [TENANT_A, measurementId, target.id, randomUUID(), randomUUID(), randomUUID(), randomUUID(), VERSION, memberId(ROOT)],
      );
      expect(await complete(LEADER, target, approved)).toMatchObject({ status: 422, json: { code: 'OPEN_CRITICAL_NCR', nonconformance_ids: [ncrId] } });
      await stage(
        "update machvon.quality_nonconformance set status = 'CLOSED', verified_by = $2::uuid, closed_by = $2::uuid, closed_at = now(), closure_note = 'closed for the test' where id = $1::uuid",
        [ncrId, memberId(LEADER)],
      );
      expect(await complete(LEADER, target, approved)).toMatchObject({ status: 422, json: { code: 'MEASUREMENT_PENDING', measurement_ids: [measurementId] } });
      expect(await stored(target.id)).toMatchObject({ status: 'ACTIVE', version: '1' });
      await stage("update machvon.measurement set status = 'APPROVED', decided_by = $2::uuid, decided_at = now() where id = $1::uuid", [measurementId, memberId(LEADER)]);

      const send = () => complete(LEADER, target, approved, 1, {}, 'complete-once-for-this-key');
      const done = await send();
      expect(done).toMatchObject({ status: 200, json: { status: 'COMPLETED', resource_version: 2, resource_id: target.id } });
      expect(await send()).toEqual(done);
      expect(await stored(target.id)).toMatchObject({ status: 'COMPLETED', version: '2', completed_on: vietnamToday(), completion_quality_acceptance_id: approved });
      const [audit] = await audits(target.id, 'contract.completed');
      expect(audit).toMatchObject({
        actor_id: memberId(LEADER),
        safe_diff: { from_status: 'ACTIVE', to_status: 'COMPLETED', completed_on: vietnamToday(), completion_quality_acceptance_id: approved },
      });
      const completed = await events(target.id, 'ctr.contract.completed.v1');
      expect(completed).toHaveLength(1);
      expect(completed[0]?.payload).toMatchObject({
        contract_id: target.id,
        project_id: target.projectId,
        status: 'COMPLETED',
        from_status: 'ACTIVE',
        version: 2,
        completed_on: vietnamToday(),
        completion_quality_acceptance_id: approved,
        actor_id: memberId(LEADER),
      });
    });

    it('refuses what is badly formed, minutes that do not serve, a contract in another state, a stale version, and a caller without the right or outside its scope', async () => {
      const target = await contract();
      const approved = await minutes(target);
      expect(await complete(LEADER, target, '')).toMatchObject({ status: 422, json: { code: 'COMPLETION_ACCEPTANCE_REQUIRED' } });
      expect(await call('POST', `/contracts/${target.id}/complete`, { member: LEADER, ifMatch: '"1"', body: { completed_on: vietnamToday() } })).toMatchObject({
        status: 422,
        json: { code: 'COMPLETION_ACCEPTANCE_REQUIRED' },
      });
      expect(await complete(LEADER, target, approved, 1, { completed_on: 'tomorrow' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await complete(LEADER, target, approved, 1, { completed_on: '2999-01-01' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await complete(LEADER, target, approved, 1, { status: 'CLOSED' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await complete(LEADER, target, randomUUID())).toMatchObject({ status: 422, json: { code: 'COMPLETION_ACCEPTANCE_REQUIRED', reason: 'MISSING' } });
      expect(await complete(LEADER, target, await minutes(target, 'STAGE'))).toMatchObject({ status: 422, json: { code: 'COMPLETION_ACCEPTANCE_REQUIRED', reason: 'NOT_COMPLETION' } });
      expect(await complete(LEADER, target, approved, 9)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await complete(LEADER, await contract('SUSPENDED'), approved)).toMatchObject({ status: 409, json: { code: 'CONTRACT_STATE_INVALID' } });
      expect((await complete(READER, target, approved)).status).toBe(403);
      expect((await complete(NOBODY, target, approved)).status).toBe(403);
      expect((await complete(ELSEWHERE, target, approved)).status).toBe(404);
      expect(await stored(target.id)).toMatchObject({ status: 'ACTIVE', version: '1' });
    });
  });

  describe('the summary of an active contract', () => {
    it('shows who may complete it, and what stands in the way: the approved completion minutes, the open serious non-conformances and the measurements to be decided', async () => {
      const target = await contract();
      const approved = await minutes(target);
      const leader = await summary(LEADER, target);
      expect(leader).toMatchObject({
        status: 200,
        json: { status: 'ACTIVE', actions: { complete: true }, completion: { acceptances: [{ id: approved, approved_on: '2026-01-10' }], open_critical_ncr_ids: [], pending_measurement_ids: [] } },
      });
      expect(((leader.json.completion as { acceptances: Array<{ record_no: string }> }).acceptances[0] ?? { record_no: '' }).record_no).toBe(`QA-Z-${approved.slice(0, 8)}`);
      // A reader sees the contract and the way to completion, with no button.
      expect(await summary(READER, target)).toMatchObject({ status: 200, json: { actions: { complete: false }, completion: { acceptances: [{ id: approved }] } } });
      // A contract that is not being performed has no way to completion to show, and nothing to complete.
      const draft = await contract('DRAFT');
      const drafted = await summary(LEADER, draft);
      expect(drafted.json).not.toHaveProperty('completion');
      expect(drafted.json).toMatchObject({ actions: { complete: false } });
      // A guest contractor reads the contract and nothing of the way to completion.
      await harness.seedGrants(TENANT_A, [{ n: 41, member: GUEST, role: 102, kind: 'CONTRACT', refs: [target.id] }]);
      const guest = await summary(GUEST, target);
      expect(guest.status).toBe(200);
      expect(guest.json).not.toHaveProperty('completion');
      expect(guest.json).not.toHaveProperty('actions');
    });
  });
});
