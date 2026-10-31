import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { BASELINE_PACK, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, applyBaseline } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { astModule } from '../../src/modules/ast';
import { WarrantyController, WarrantyReadsController } from '../../src/modules/ast/warranty.controller';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { asSuperuser } from '../../../../packages/db/test/support/ncr-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xb6;
const ROOT = 1;
const MANAGER = 11; // warranty.manage, warranty.read: creates and closes the obligations
const READER = 12; // warranty.read
const NOBODY = 13;
const ELSEWHERE = 14; // the rights of MANAGER over another branch
const GUEST = 15; // the contractor of the contract, reading what is of its contract
const FOREIGN = 16; // a member of another tenant with every right over the warranty of that tenant
const MEMBERS = [MANAGER, READER, NOBODY, ELSEWHERE, GUEST];
const OTHER_BRANCH = 5;
const RECEIVING_UNIT = 7;
const DOCUMENT = id(FAMILY, 30);
const CLEAN = id(FAMILY, 31);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const vietnamToday = (): string => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

describe('the warranty of a work over HTTP (ST-AST-003)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let counter = 0;
  let contractor = '';

  const tokenOf = (member: number, tenantId: string = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; body?: unknown; key?: string; tenant?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenant), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
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
  const stored = async (obligationId: string) =>
    (
      await rows<{ status: string; version: string; ends_on: string; closed_by: string | null }>(
        'select status, version::text, ends_on::text, closed_by from machvon.warranty_obligation where id = $1::uuid',
        [obligationId],
      )
    )[0];

  interface Target {
    contractId: string;
    projectId: string;
    handoverId: string;
  }

  /** A contract with a handover of the status asked for; a guest contractor is invited to it. */
  async function target(status = 'ACCEPTED'): Promise<Target> {
    counter += 1;
    const line = await world.publishedLine();
    const contractId = randomUUID();
    const handoverId = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
            created_by, updated_by, signed_on, effective_from)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'Contract', 'CONSTRUCTION', false, true, 10000000000::numeric, $7, $7, date '2026-01-02', date '2026-01-03')`,
        [TENANT_A, contractId, line.projectId, randomUUID(), contractor, `HD-W-${String(counter).padStart(4, '0')}`, memberId(ROOT)],
      ],
    ]);
    await stage(
      `insert into machvon.handover
         (tenant_id, id, project_id, contract_id, recipient_unit_id, document_version_id, punch_list, status, handover_no, handover_kind, created_by, updated_by, version, accepted_at, accepted_by, as_built_document_version_id)
       values ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7, $8, 'COMPLETION', $9, $9, 1, $10::timestamptz, $11, $12)`,
      [
        TENANT_A,
        handoverId,
        line.projectId,
        contractId,
        unitId(RECEIVING_UNIT),
        CLEAN,
        status,
        `BG-W-${counter}`,
        memberId(ROOT),
        status === 'ACCEPTED' ? '2026-12-10T03:00:00Z' : null,
        status === 'ACCEPTED' ? memberId(ROOT) : null,
        status === 'ACCEPTED' ? CLEAN : null,
      ],
    );
    await harness.seedGrants(TENANT_A, [{ n: 2000 + counter, member: GUEST, role: 104, kind: 'CONTRACT', refs: [contractId] }]);
    // The access of a member is cached by the scope version of its membership: a member given a new grant moves to the next version.
    await world.owner('update machvon.membership set scope_version = scope_version + 1 where id = $1::uuid', [memberId(GUEST)]);
    return { contractId, projectId: line.projectId, handoverId };
  }

  /** An obligation that started long ago by default, so that its last day has come. */
  const create = (member: number, subject: Target, overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', '/warranty-obligations', {
      member,
      ...(key === undefined ? {} : { key }),
      body: {
        contract_id: subject.contractId,
        handover_id: subject.handoverId,
        scope_description: 'The whole pump house',
        starts_on: '2024-01-01',
        period_months: 12,
        construction_grade: 'II',
        retention_amount_vnd: '150000000',
        ...overrides,
      },
    });
  const close = (member: number, obligationId: string, body: Record<string, unknown> = {}) => call('POST', `/warranty-obligations/${obligationId}/close`, { member, body });
  const claim = (obligationId: string, claimNo: string, status = 'OPEN') =>
    rows(
      `insert into machvon.warranty_claim (tenant_id, id, obligation_id, claim_no, reported_on, reported_by, defect_description, severity, response_due_on, status, fixed_on, verified_by, verified_at, created_by, updated_by)
       values ($1, gen_random_uuid(), $2, $3, date '2024-06-20', $4, 'Crack in the wall', 'MAJOR', date '2024-06-27', $5,
               case when $5 in ('VERIFIED', 'CLOSED') then date '2024-06-25' end, case when $5 in ('VERIFIED', 'CLOSED') then $6::uuid end, case when $5 in ('VERIFIED', 'CLOSED') then now() end, $4, $4)`,
      [TENANT_A, obligationId, claimNo, memberId(ROOT), status, memberId(MANAGER)],
    );

  /** Takes the claims of an obligation through the answer to a verified repair, by the moves the lifecycle allows (the claim was reported by ROOT, who also says it is put right). */
  const resolve = async (obligationId: string): Promise<void> => {
    await rows("update machvon.warranty_claim set status = 'ACKNOWLEDGED', committed_fix_on = reported_on, acknowledged_by = $2::uuid, acknowledged_at = now() where obligation_id = $1::uuid and status = 'OPEN'", [obligationId, memberId(ROOT)]);
    await rows(
      "update machvon.warranty_claim set status = 'FIXED', fixed_on = reported_on + 1, fixed_by = $2::uuid, fix_note = 'Put right', fix_evidence_document_version_id = $3::uuid where obligation_id = $1::uuid and status = 'ACKNOWLEDGED'",
      [obligationId, memberId(ROOT), CLEAN],
    );
    await rows("update machvon.warranty_claim set status = 'VERIFIED', verified_by = $2::uuid, verified_at = now() where obligation_id = $1::uuid and status = 'FIXED'", [obligationId, memberId(MANAGER)]);
  };

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [
      { n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` },
      { n: RECEIVING_UNIT, path: `/${unitId(RECEIVING_UNIT)}/` },
    ]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedUnits(TENANT_B, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    await harness.seedMembership(TENANT_B, FOREIGN, ROOT);
    await harness.seedRole(TENANT_B, 601, 'AST_WARRANTY', ['warranty.manage', 'warranty.read'], 60);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: FOREIGN, role: 601, kind: 'TENANT' }]);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'AST_WARRANTY_MANAGER', ['warranty.manage', 'warranty.read'], 40],
      [2, 'AST_WARRANTY_READER', ['warranty.read'], 10],
      [4, 'AST_WARRANTY_CONTRACTOR', ['warranty.read'], 5],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 100 + n, code, permissions, rank);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MANAGER, role: 101, kind: 'TENANT' },
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
         values ($1, $2, $3, 1, 'tenants/ast/warranty.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, CLEAN, DOCUMENT],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    await tenants.withTenant(contextFor(TENANT_A, memberId(ROOT)), (tx) => applyBaseline(tx, BASELINE_PACK, memberId(ROOT), '2026-06-01'));
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [WarrantyController, WarrantyReadsController],
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
    expect(astModule.controllers).toEqual(expect.arrayContaining([WarrantyController, WarrantyReadsController]));
  });

  describe('createWarrantyObligation (AC-ST-AST-003-1, UAT-AC390)', () => {
    it('AC-ST-AST-003-1, UAT-AC390: refuses a term below the minimum of the grade and creates one at the minimum, with its audit row and its event, answering the same key once', async () => {
      const subject = await target();
      expect(await create(MANAGER, subject, { period_months: 6 })).toMatchObject({ status: 422, json: { code: 'WARRANTY_PERIOD_BELOW_MINIMUM', minimum_months: 12, period_months: 6 } });
      expect(await rows('select id from machvon.warranty_obligation where handover_id = $1::uuid', [subject.handoverId])).toEqual([]);

      const send = () => create(MANAGER, subject, { starts_on: '2026-09-01' }, 'create-once-for-this-key');
      const first = await send();
      expect(first).toMatchObject({ status: 200, json: { status: 'ACTIVE', resource_version: 1 } });
      expect(await send()).toEqual(first);
      const obligationId = first.json.resource_id as string;
      expect(await rows('select id from machvon.warranty_obligation where handover_id = $1::uuid', [subject.handoverId])).toHaveLength(1);
      expect(await stored(obligationId)).toMatchObject({ status: 'ACTIVE', version: '1', ends_on: '2027-09-01' });
      expect((await audits(obligationId, 'warranty.created'))[0]).toMatchObject({
        actor_id: memberId(MANAGER),
        safe_diff: {
          contract_id: subject.contractId,
          handover_id: subject.handoverId,
          starts_on: '2026-09-01',
          ends_on: '2027-09-01',
          period_months: 12,
          construction_grade: 'II',
          minimum_months: 12,
          retention_amount_vnd: '150000000',
          from_status: null,
          to_status: 'ACTIVE',
        },
      });
      expect((await events(obligationId, 'ast.warranty.created.v1'))[0]?.payload).toMatchObject({
        obligation_id: obligationId,
        contract_id: subject.contractId,
        handover_id: subject.handoverId,
        status: 'ACTIVE',
        version: 1,
        actor_id: memberId(MANAGER),
      });
    });

    it('holds a work of grade I to 24 months, and one whose grade is not stated to the longest minimum', async () => {
      const subject = await target();
      expect(await create(MANAGER, subject, { construction_grade: 'I', period_months: 12 })).toMatchObject({ status: 422, json: { code: 'WARRANTY_PERIOD_BELOW_MINIMUM', minimum_months: 24 } });
      expect(await create(MANAGER, subject, { construction_grade: undefined, period_months: 18 })).toMatchObject({ status: 422, json: { code: 'WARRANTY_PERIOD_BELOW_MINIMUM', minimum_months: 24 } });
      expect(await create(MANAGER, subject, { construction_grade: 'V' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await create(MANAGER, subject, { construction_grade: undefined, period_months: 24 })).toMatchObject({ status: 200, json: { status: 'ACTIVE' } });
    });

    it('needs a cover, an accepted handover and one obligation for the scope, and refuses what is badly formed', async () => {
      const subject = await target();
      expect(await create(MANAGER, subject, { retention_amount_vnd: undefined })).toMatchObject({ status: 422, json: { code: 'GUARANTEE_REQUIRED' } });
      expect(await create(MANAGER, await target('PUNCH_PENDING'))).toMatchObject({ status: 422, json: { code: 'HANDOVER_NOT_ACCEPTED' } });
      expect(await create(MANAGER, subject, { period_months: 0 })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await create(MANAGER, subject, { retention_amount_vnd: '12.5' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await create(MANAGER, subject, { status: 'CLOSED' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect((await create(MANAGER, subject)).status).toBe(200);
      expect(await create(MANAGER, subject)).toMatchObject({ status: 409, json: { code: 'WARRANTY_STATE_INVALID' } });
    });

    it('is for the people who hold the right over the contract or the receiving unit', async () => {
      const subject = await target();
      expect(await create(MANAGER, { ...subject, handoverId: randomUUID() })).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect((await create(READER, subject)).status).toBe(403);
      expect((await create(NOBODY, subject)).status).toBe(403);
      expect((await create(GUEST, subject)).status).toBe(403);
      expect((await create(ELSEWHERE, subject)).status).toBe(404);
      expect(await rows('select id from machvon.warranty_obligation where handover_id = $1::uuid', [subject.handoverId])).toEqual([]);
    });
  });

  describe('closeWarrantyObligation (AC-ST-AST-003-2, UAT-AC392)', () => {
    it('AC-ST-AST-003-2, UAT-AC392: refuses while a claim is open, then closes it and announces the closure that lets the retention be released', async () => {
      const subject = await target();
      const obligationId = (await create(MANAGER, subject)).json.resource_id as string;
      await claim(obligationId, 'WC-002');
      expect(await close(MANAGER, obligationId)).toMatchObject({ status: 422, json: { code: 'OPEN_WARRANTY_CLAIMS', open_claims: 1, claim_nos: ['WC-002'] } });
      expect(await stored(obligationId)).toMatchObject({ status: 'ACTIVE', version: '1' });
      expect(await events(obligationId, 'ast.warranty.closed.v1')).toEqual([]);

      await resolve(obligationId);
      const done = await close(MANAGER, obligationId, { note: 'No claim is open.' });
      expect(done).toMatchObject({ status: 200, json: { status: 'CLOSED', resource_version: 2, resource_id: obligationId } });
      expect(await stored(obligationId)).toMatchObject({ status: 'CLOSED', version: '2', closed_by: memberId(MANAGER) });
      expect((await audits(obligationId, 'warranty.closed'))[0]).toMatchObject({
        actor_id: memberId(MANAGER),
        safe_diff: { from_status: 'ACTIVE', to_status: 'CLOSED', handover_id: subject.handoverId },
      });
      expect((await events(obligationId, 'ast.warranty.closed.v1'))[0]?.payload).toMatchObject({
        obligation_id: obligationId,
        contract_id: subject.contractId,
        handover_id: subject.handoverId,
        status: 'CLOSED',
        from_status: 'ACTIVE',
        version: 2,
      });
      expect(await close(MANAGER, obligationId)).toMatchObject({ status: 409, json: { code: 'WARRANTY_STATE_INVALID' } });
      // A closed obligation is read as closed, with nothing left to do.
      expect(await call('GET', `/warranty-obligations?contract_id=${subject.contractId}`, { member: MANAGER })).toMatchObject({
        json: { items: [{ id: obligationId, status: 'CLOSED', allowed: { close: false } }] },
      });
    });

    it('refuses to close before the last day', async () => {
      const subject = await target();
      const obligationId = (await create(MANAGER, subject, { starts_on: vietnamToday() })).json.resource_id as string;
      expect(await close(MANAGER, obligationId)).toMatchObject({ status: 422, json: { code: 'WARRANTY_NOT_EXPIRED' } });
      expect(await stored(obligationId)).toMatchObject({ status: 'ACTIVE' });
    });

    it('is for the people who hold the right over the contract or the receiving unit', async () => {
      const subject = await target();
      const obligationId = (await create(MANAGER, subject)).json.resource_id as string;
      expect((await close(READER, obligationId)).status).toBe(403);
      expect((await close(NOBODY, obligationId)).status).toBe(403);
      expect((await close(ELSEWHERE, obligationId)).status).toBe(404);
      expect((await close(MANAGER, randomUUID())).status).toBe(404);
      expect(await close(MANAGER, obligationId, { note: '   ' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await stored(obligationId)).toMatchObject({ status: 'ACTIVE' });
    });
  });

  describe('listWarrantyObligations', () => {
    it('lists the obligations of the scope, the newest first and paged, with the status of the day and what each person may do', async () => {
      const subject = await target();
      const expired = (await create(MANAGER, subject, { scope_description: 'Pump house' })).json.resource_id as string;
      const second = await target();
      const active = (await create(MANAGER, second, { starts_on: vietnamToday(), scope_description: 'Roof' })).json.resource_id as string;
      await claim(expired, 'WC-1');

      const first = await call('GET', `/warranty-obligations?contract_id=${subject.contractId}`, { member: READER });
      expect(first.status).toBe(200);
      const [line] = first.json.items as Array<Record<string, unknown>>;
      expect(line).toMatchObject({
        id: expired,
        contract: { id: subject.contractId },
        handover: { id: subject.handoverId, status: 'ACCEPTED' },
        scope_description: 'Pump house',
        starts_on: '2024-01-01',
        ends_on: '2025-01-01',
        period_months: 12,
        construction_grade: 'II',
        minimum_months: 12,
        rule: { awaiting_confirmation: true, cxn: 'CXN-EXE-04' },
        guarantee: null,
        retention_amount_vnd: '150000000',
        status: 'EXPIRED',
        open_claims: 1,
        total_claims: 1,
        allowed: { close: false },
        version: 1,
      });
      expect(await call('GET', `/warranty-obligations?contract_id=${subject.contractId}`, { member: MANAGER })).toMatchObject({ json: { items: [{ id: expired, allowed: { close: true } }] } });
      // A guest contractor reads the warranty of its contract.
      expect(((await call('GET', `/warranty-obligations?contract_id=${subject.contractId}`, { member: GUEST })).json.items as unknown[]).length).toBe(1);

      expect(((await call('GET', `/warranty-obligations?status=ACTIVE&contract_id=${second.contractId}`, { member: READER })).json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([
        active,
      ]);
      expect((await call('GET', `/warranty-obligations?status=EXPIRED&contract_id=${second.contractId}`, { member: READER })).json.items).toEqual([]);
      const page = await call('GET', `/warranty-obligations?handover_id=${subject.handoverId}&limit=1`, { member: READER });
      expect(page.json.next_cursor).toBeNull();
    });

    it('pages with a cursor, refuses a filter that is not one, and shows nothing to whoever may not read it', async () => {
      const subject = await target();
      const handovers = [subject, await target()];
      const ids: string[] = [];
      for (const [index, handover] of handovers.entries())
        ids.unshift((await create(MANAGER, { ...handover, contractId: handover.contractId }, { scope_description: `Scope ${index}` })).json.resource_id as string);
      const all = ((await call('GET', '/warranty-obligations?limit=200', { member: READER })).json.items as Array<{ id: string }>).map((item) => item.id);
      expect(all.slice(0, 2)).toEqual(ids);
      const page = await call('GET', '/warranty-obligations?limit=1', { member: READER });
      expect((page.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([ids[0]]);
      const next = await call('GET', `/warranty-obligations?limit=1&cursor=${page.json.next_cursor as string}`, { member: READER });
      expect((next.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([ids[1]]);
      expect((await call('GET', '/warranty-obligations?contract_id=nope', { member: READER })).status).toBe(422);
      expect((await call('GET', '/warranty-obligations?status=1', { member: READER })).status).toBe(422);
      // A filter named twice is not a single value.
      expect((await call('GET', '/warranty-obligations?status=ACTIVE&status=EXPIRED', { member: READER })).status).toBe(422);
      expect((await call('GET', `/warranty-obligations?contract_id=${subject.contractId}&contract_id=${subject.contractId}`, { member: READER })).status).toBe(422);
      expect((await call('GET', '/warranty-obligations?status=GONE', { member: READER })).status).toBe(422);
      expect((await call('GET', '/warranty-obligations?limit=0', { member: READER })).status).toBe(422);
      expect((await call('GET', '/warranty-obligations', { member: NOBODY })).status).toBe(403);
      expect(((await call('GET', `/warranty-obligations?handover_id=${subject.handoverId}`, { member: ELSEWHERE })).json.items as unknown[]).length).toBe(0);
    });
  });

  describe('another tenant (UAT-AC395)', () => {
    it('does not see, create or close the warranty of the first tenant, whatever its rights in its own', async () => {
      const subject = await target();
      const obligationId = (await create(MANAGER, subject)).json.resource_id as string;
      const foreign = (method: string, url: string, body?: unknown) => call(method, url, { member: FOREIGN, tenant: TENANT_B, ...(body === undefined ? {} : { body }) });
      expect(((await foreign('GET', '/warranty-obligations')).json.items as unknown[]).length).toBe(0);
      expect((await foreign('POST', `/warranty-obligations/${obligationId}/close`, {})).status).toBe(404);
      expect(
        (
          await foreign('POST', '/warranty-obligations', {
            contract_id: subject.contractId,
            handover_id: subject.handoverId,
            scope_description: 'x',
            starts_on: '2024-01-01',
            period_months: 12,
            retention_amount_vnd: '1',
          })
        ).status,
      ).toBe(404);
      expect(await stored(obligationId)).toMatchObject({ status: 'ACTIVE', version: '1' });
    });
  });
});
