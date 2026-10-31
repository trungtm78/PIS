import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { AstClaimOverdueJob, AuditWriter, EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase, WORKER_MEMBERSHIP_ID, readIntake } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { astModule } from '../../src/modules/ast';
import { ClaimController, ClaimReadsController } from '../../src/modules/ast/claim.controller';
import { WarrantyController, WarrantyReadsController } from '../../src/modules/ast/warranty.controller';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { asSuperuser } from '../../../../packages/db/test/support/ncr-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xb8;
const ROOT = 1;
const FILER = 11; // warranty.claim, warranty.verify, warranty.read over the tenant: reports a defect and may not verify its own report
const VERIFIER = 12; // warranty.verify, warranty.read over the tenant
const READER = 13; // warranty.read
const NOBODY = 14;
const NARROW = 15; // the rights of the office over another branch, warranty.read over the tenant: sees the claim and may not act on it
const ELSEWHERE = 16; // the rights of the office and of a reader over another branch and nothing else: does not see the claim
const GUEST = 17; // the contractor of the contract: warranty.respond, warranty.read over the contract
const GUEST_OTHER = 18; // another contractor with the same rights over the same contract
const FOREIGN = 19; // a member of another tenant with every right over the warranty of that tenant
const MEMBERS = [FILER, VERIFIER, READER, NOBODY, NARROW, ELSEWHERE, GUEST, GUEST_OTHER];
const OTHER_BRANCH = 5;
const RECEIVING_UNIT = 7;
const DOCUMENT = id(FAMILY, 30);
const CLEAN = id(FAMILY, 31);
const PENDING = id(FAMILY, 32);

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const vietnamToday = (): string => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const plusDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const yearEarlier = (day: string): string => (day.endsWith('-02-29') ? `${Number(day.slice(0, 4)) - 1}-02-28` : `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`);

describe('the claims against a warranty over HTTP (ST-AST-004, UAT-AC390, UAT-AC391)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let counter = 0;
  let contractor = '';
  let otherContractor = '';

  const tokenOf = (member: number, tenantId: string = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; body?: unknown; key?: string; tenant?: string; version?: number }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenant), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.version !== undefined) headers['if-match'] = `"${options.version}"`;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => world.owner<R>(sql, params);
  const stage = (sql: string, params: unknown[] = []): Promise<void> => asSuperuser(harness.database.adminUrl, sql, params);
  const audits = (resourceId: string, action: string) =>
    rows<{ safe_diff: Record<string, unknown>; actor_id: string }>('select safe_diff, actor_id from machvon.audit_event where resource_id = $1 and action = $2 order by occurred_at, id', [resourceId, action]);
  const events = (aggregateId: string, type: string) =>
    rows<{ payload: Record<string, unknown> }>('select payload from machvon.outbox_event where aggregate_id = $1 and type = $2 order by created_at, id', [aggregateId, type]);
  const stored = async (claimId: string) =>
    (
      await rows<{
        status: string;
        version: string;
        response_due_on: string;
        committed_fix_on: string | null;
        fixed_on: string | null;
        cost_borne_by: string;
        verified_by: string | null;
        escalated_at: string | null;
        issue_id: string | null;
        acknowledged_by: string | null;
        fixed_by: string | null;
      }>(
        `select status, version::text, response_due_on::text, committed_fix_on::text, fixed_on::text, cost_borne_by, verified_by, escalated_at::text, issue_id, acknowledged_by, fixed_by
           from machvon.warranty_claim where id = $1::uuid`,
        [claimId],
      )
    )[0];

  /** The job of the day asked for: the clock is the argument, so that a day in 2027 can be run now. */
  const sweep = async (at: string): Promise<number> => {
    const tenants = harness.tenants as TenantDatabase;
    const summary = await tenants.withTenant({ tenantId: TENANT_A, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, (tx) => new AstClaimOverdueJob(new AuditWriter(tenants)).run(tx, WORKER_MEMBERSHIP_ID, new Date(at)));
    return summary.flagged;
  };

  interface Subject {
    projectId: string;
    contractId: string;
    handoverId: string;
    obligationId: string;
  }

  /** A contract of a contractor with an accepted handover and an active obligation (from 1 September 2026 to 1 September 2027 unless said otherwise); both guests may reach the contract. */
  async function subject(options: { startsOn?: string } = {}): Promise<Subject> {
    counter += 1;
    const line = await world.publishedLine();
    const contractId = randomUUID();
    const handoverId = randomUUID();
    const obligationId = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
            created_by, updated_by, signed_on, effective_from)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'Contract', 'CONSTRUCTION', false, true, 10000000000::numeric, $7, $7, date '2026-01-02', date '2026-01-03')`,
        [TENANT_A, contractId, line.projectId, randomUUID(), contractor, `HD-C-${String(counter).padStart(4, '0')}`, memberId(ROOT)],
      ],
    ]);
    await stage(
      `insert into machvon.handover
         (tenant_id, id, project_id, contract_id, recipient_unit_id, document_version_id, punch_list, status, handover_no, handover_kind, created_by, updated_by, version, accepted_at, accepted_by, as_built_document_version_id)
       values ($1, $2, $3, $4, $5, $6, '[]'::jsonb, 'ACCEPTED', $7, 'COMPLETION', $8, $8, 1, timestamptz '2026-09-01T03:00:00Z', $8, $6)`,
      [TENANT_A, handoverId, line.projectId, contractId, unitId(RECEIVING_UNIT), CLEAN, `BG-C-${counter}`, memberId(ROOT)],
    );
    await stage(
      `insert into machvon.warranty_obligation
         (tenant_id, id, project_id, contract_id, handover_id, scope_description, starts_on, ends_on, period_months, retention_amount_vnd, status, created_by, updated_by, version)
       values ($1, $2, $3, $4, $5, 'The whole pump house', $6::date, ($6::date + interval '12 months')::date, 12, 1000, 'ACTIVE', $7, $7, 1)`,
      [TENANT_A, obligationId, line.projectId, contractId, handoverId, options.startsOn ?? '2026-09-01', memberId(ROOT)],
    );
    await harness.seedGrants(TENANT_A, [
      { n: 3000 + counter * 2, member: GUEST, role: 105, kind: 'CONTRACT', refs: [contractId] },
      { n: 3001 + counter * 2, member: GUEST_OTHER, role: 105, kind: 'CONTRACT', refs: [contractId] },
    ]);
    await world.owner('update machvon.membership set scope_version = scope_version + 1 where id = any($1::uuid[])', [[memberId(GUEST), memberId(GUEST_OTHER)]]);
    return { projectId: line.projectId, contractId, handoverId, obligationId };
  }

  const file = (member: number, s: Subject, overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', `/warranty-obligations/${s.obligationId}/claims`, {
      member,
      ...(key === undefined ? {} : { key }),
      body: { claim_no: `WC-${randomUUID().slice(0, 8)}`, reported_on: '2027-01-10', defect_description: 'Crack in the wall of the pump house', severity: 'MAJOR', responder_contractor_id: contractor, ...overrides },
    });
  const claimIdOf = (reply: Reply): string => reply.json.resource_id as string;
  const acknowledge = (member: number, claimId: string, version: number, body: Record<string, unknown> = {}) =>
    call('POST', `/warranty-claims/${claimId}/acknowledge`, { member, version, body: { committed_fix_on: '2027-01-25', ...body } });
  const fix = (member: number, claimId: string, version: number, body: Record<string, unknown> = {}) =>
    call('POST', `/warranty-claims/${claimId}/fixed`, { member, version, body: { fixed_on: '2027-01-24', note: 'The wall was repaired and painted', evidence_document_version_id: CLEAN, ...body } });
  const verify = (member: number, claimId: string, version: number, body: Record<string, unknown> = {}) =>
    call('POST', `/warranty-claims/${claimId}/verify`, { member, version, body: { outcome: 'VERIFIED', cost_borne_by: 'CONTRACTOR', note: 'Checked on site', ...body } });
  /** A claim filed by FILER and taken to the status asked for by the contractor GUEST. */
  async function claimAt(s: Subject, status: 'OPEN' | 'ACKNOWLEDGED' | 'FIXED'): Promise<{ id: string; version: number }> {
    const filed = await file(FILER, s);
    const claimId = claimIdOf(filed);
    if (status === 'OPEN') return { id: claimId, version: 1 };
    expect((await acknowledge(GUEST, claimId, 1)).status).toBe(200);
    if (status === 'ACKNOWLEDGED') return { id: claimId, version: 2 };
    expect((await fix(GUEST, claimId, 2)).status).toBe(200);
    return { id: claimId, version: 3 };
  }

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [
      { n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` },
      { n: RECEIVING_UNIT, path: `/${unitId(RECEIVING_UNIT)}/` },
    ]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedUnits(TENANT_B, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    await harness.seedMembership(TENANT_B, FOREIGN, ROOT);
    await harness.seedRole(TENANT_B, 601, 'AST_CLAIMS', ['warranty.claim', 'warranty.respond', 'warranty.verify', 'warranty.read'], 60);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: FOREIGN, role: 601, kind: 'TENANT' }]);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'AST_CLAIM_FILER', ['warranty.claim', 'warranty.verify', 'warranty.read'], 40],
      [2, 'AST_CLAIM_VERIFIER', ['warranty.verify', 'warranty.read'], 40],
      [3, 'AST_CLAIM_READER', ['warranty.read'], 10],
      [4, 'AST_CLAIM_BRANCH', ['warranty.claim', 'warranty.respond', 'warranty.verify'], 30],
      [5, 'AST_CLAIM_CONTRACTOR', ['warranty.respond', 'warranty.read'], 5],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 100 + n, code, permissions, rank);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: FILER, role: 101, kind: 'TENANT' },
      { n: 2, member: VERIFIER, role: 102, kind: 'TENANT' },
      { n: 3, member: READER, role: 103, kind: 'TENANT' },
      { n: 4, member: NARROW, role: 104, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
      { n: 5, member: NARROW, role: 103, kind: 'TENANT' },
      { n: 6, member: ELSEWHERE, role: 104, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
      { n: 7, member: ELSEWHERE, role: 103, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
    ]);
    contractor = await seedContractor(harness);
    otherContractor = await seedContractor(harness);
    await world.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(GUEST), contractor]);
    await world.owner("update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(GUEST_OTHER), otherContractor]);
    await seedAs(harness, [
      [
        `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3)`,
        [TENANT_A, DOCUMENT, memberId(ROOT)],
      ],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $4, 1, 'tenants/ast/claim.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $3, $4, 2, 'tenants/ast/pending.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'PENDING', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, CLEAN, PENDING, DOCUMENT],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ClaimController, ClaimReadsController, WarrantyController, WarrantyReadsController],
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
    expect(astModule.controllers).toEqual(expect.arrayContaining([ClaimController, ClaimReadsController]));
  });

  describe('fileWarrantyClaim (AC-ST-AST-004-1, UAT-AC390)', () => {
    it('UAT-AC390: takes a claim reported the day before the warranty ends and refuses one from that day on, with its audit row and its event, answering the same key once', async () => {
      const s = await subject();
      const inside = () => file(FILER, s, { claim_no: 'WC-IN', reported_on: '2027-08-31' }, 'file-once-for-this-key');
      const first = await inside();
      expect(first).toMatchObject({ status: 200, json: { status: 'OPEN', resource_version: 1 } });
      expect(await inside()).toEqual(first);
      const claimId = claimIdOf(first);
      expect(await rows('select id from machvon.warranty_claim where obligation_id = $1::uuid', [s.obligationId])).toHaveLength(1);
      expect(await stored(claimId)).toMatchObject({ status: 'OPEN', version: '1', response_due_on: '2027-09-07', cost_borne_by: 'UNDETERMINED' });
      expect(await file(FILER, s, { claim_no: 'WC-ON', reported_on: '2027-09-01' })).toMatchObject({ status: 422, json: { code: 'WARRANTY_EXPIRED', ends_on: '2027-09-01' } });
      expect(await file(FILER, s, { claim_no: 'WC-AFTER', reported_on: '2027-09-02' })).toMatchObject({ status: 422, json: { code: 'WARRANTY_EXPIRED' } });
      expect(await rows('select id from machvon.warranty_claim where obligation_id = $1::uuid', [s.obligationId])).toHaveLength(1);
      expect((await audits(claimId, 'warranty_claim.filed'))[0]).toMatchObject({
        actor_id: memberId(FILER),
        safe_diff: { obligation_id: s.obligationId, claim_no: 'WC-IN', contract_id: s.contractId, project_id: s.projectId, severity: 'MAJOR', responder_contractor_id: contractor, reported_on: '2027-08-31', response_due_on: '2027-09-07', from_status: null, to_status: 'OPEN' },
      });
      expect(JSON.stringify((await audits(claimId, 'warranty_claim.filed'))[0])).not.toContain('Crack in the wall');
      expect((await events(claimId, 'ast.warranty_claim.filed.v1'))[0]?.payload).toMatchObject({ claim_id: claimId, claim_no: 'WC-IN', status: 'OPEN', version: 1, actor_id: memberId(FILER), response_due_on: '2027-09-07' });
    });

    it('counts the seven days across the end of a month and of a year', async () => {
      const s = await subject({ startsOn: '2026-09-01' });
      const filed = await file(FILER, s, { reported_on: '2027-01-28' });
      expect((await stored(claimIdOf(filed)))?.response_due_on).toBe('2027-02-04');
    });

    it('refuses a claim number used before in the obligation, a claim before the warranty began, a responder that is no party of the contract and a closed obligation', async () => {
      const s = await subject();
      expect((await file(FILER, s, { claim_no: 'WC-1' })).status).toBe(200);
      expect(await file(FILER, s, { claim_no: 'WC-1' })).toMatchObject({ status: 409, json: { code: 'CLAIM_NO_DUPLICATE' } });
      expect(await file(FILER, await subject(), { claim_no: 'WC-1' })).toMatchObject({ status: 200 });
      expect(await file(FILER, s, { reported_on: '2026-08-31' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'reported_on', reason: 'BEFORE_START' } });
      expect(await file(FILER, s, { responder_contractor_id: await seedContractor(harness) })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'responder_contractor_id', reason: 'NOT_A_PARTY' } });
      const closed = await subject();
      await stage("update machvon.warranty_obligation set status = 'CLOSED', closed_by = $2::uuid, closed_at = now() where id = $1::uuid", [closed.obligationId, memberId(ROOT)]);
      expect(await file(FILER, closed)).toMatchObject({ status: 409, json: { code: 'WARRANTY_STATE_INVALID' } });
    });

    it('takes a photo or a file of the evidence only when it is clean, and refuses what is badly formed', async () => {
      const s = await subject();
      expect(await file(FILER, s, { evidence_document_version_id: PENDING })).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_CLEAN' } });
      expect(await file(FILER, s, { evidence_document_version_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', reason: 'NOT_FOUND' } });
      expect(await file(FILER, s, { evidence_photo_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', reason: 'NOT_IN_CONTRACT' } });
      expect((await file(FILER, s, { evidence_document_version_id: CLEAN, location_text: 'North wall' })).status).toBe(200);
      for (const [field, extra] of [
        ['claim_no', { claim_no: '   ' }],
        ['reported_on', { reported_on: '2027-02-30' }],
      ] as const) {
        const reply = await file(FILER, s, extra);
        expect([reply.status, reply.json.code, reply.json.detail ?? reply.json.field]).toEqual([422, 'VALIDATION_FAILED', field]);
      }
      for (const extra of [{ defect_description: '' }, { severity: 'HUGE' }, { responder_contractor_id: 'not-a-uuid' }]) expect([400, 422]).toContain((await file(FILER, s, extra)).status);
      expect(await file(FILER, s, { status: 'FIXED' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
    });
  });

  describe('the answer to a claim (AC-ST-AST-004-1, UAT-AC391)', () => {
    it('UAT-AC391: nobody answers by the day, the job flags the claim once for ISS; the contractor acknowledges, fixes with evidence, and somebody else verifies', async () => {
      const s = await subject();
      const filed = await file(FILER, s, { claim_no: 'WC-001', reported_on: '2027-01-10' });
      const claimId = claimIdOf(filed);
      expect(await sweep('2027-01-17T09:00:00+07:00')).toBe(0);
      expect(await events(claimId, 'ast.warranty_claim.overdue.v1')).toHaveLength(0);
      expect(await sweep('2027-01-18T09:00:00+07:00')).toBeGreaterThanOrEqual(1);
      expect((await stored(claimId))?.escalated_at).not.toBeNull();
      const overdue = await events(claimId, 'ast.warranty_claim.overdue.v1');
      expect(overdue).toHaveLength(1);
      expect(overdue[0]?.payload).toMatchObject({ source_module: 'AST', source_ref_id: claimId, reference_code: 'WC-001', project_id: s.projectId, contract_id: s.contractId, severity: 'HIGH', response_due_on: '2027-01-17' });
      expect(readIntake('ast.warranty_claim.overdue.v1', overdue[0]?.payload ?? {})).toMatchObject({ kind: 'REQUEST', request: { sourceRefId: claimId, projectId: s.projectId, contractId: s.contractId, severity: 'HIGH', referenceCode: 'WC-001' } });
      expect(await sweep('2027-01-18T21:00:00+07:00')).toBe(0);
      expect(await sweep('2027-01-19T09:00:00+07:00')).toBe(0);
      expect(await events(claimId, 'ast.warranty_claim.overdue.v1')).toHaveLength(1);
      expect(await audits(claimId, 'ast.warranty_claim_escalated')).toHaveLength(1);
      // The flag is not a change of the claim: the contractor still answers at the version it read.
      expect((await stored(claimId))?.version).toBe('1');

      const ack = await acknowledge(GUEST, claimId, 1, { note: 'We start on Monday' });
      expect(ack).toMatchObject({ status: 200, json: { status: 'ACKNOWLEDGED', resource_version: 2 } });
      expect(await stored(claimId)).toMatchObject({ status: 'ACKNOWLEDGED', version: '2', committed_fix_on: '2027-01-25', acknowledged_by: memberId(GUEST) });
      expect((await audits(claimId, 'warranty_claim.acknowledged'))[0]).toMatchObject({ actor_id: memberId(GUEST), safe_diff: { from_status: 'OPEN', to_status: 'ACKNOWLEDGED', committed_fix_on: '2027-01-25' } });
      expect(JSON.stringify((await events(claimId, 'ast.warranty_claim.acknowledged.v1'))[0])).not.toContain('We start on Monday');
      const fixed = await fix(GUEST, claimId, 2);
      expect(fixed).toMatchObject({ status: 200, json: { status: 'FIXED', resource_version: 3 } });
      expect(await stored(claimId)).toMatchObject({ status: 'FIXED', fixed_on: '2027-01-24', fixed_by: memberId(GUEST) });
      expect((await events(claimId, 'ast.warranty_claim.fixed.v1'))[0]?.payload).toMatchObject({ claim_id: claimId, status: 'FIXED', fixed_on: '2027-01-24', version: 3 });

      // The person who reported the defect does not verify the repair, though they hold the right; somebody else does, and the cost is kept.
      expect(await verify(FILER, claimId, 3)).toMatchObject({ status: 403, json: { code: 'SELF_APPROVAL_DENIED' } });
      expect((await stored(claimId))?.status).toBe('FIXED');
      const done = await verify(VERIFIER, claimId, 3, { cost_borne_by: 'OWNER' });
      expect(done).toMatchObject({ status: 200, json: { status: 'VERIFIED', resource_version: 4 } });
      expect(await stored(claimId)).toMatchObject({ status: 'VERIFIED', version: '4', cost_borne_by: 'OWNER', verified_by: memberId(VERIFIER) });
      expect((await audits(claimId, 'warranty_claim.verified'))[0]).toMatchObject({ actor_id: memberId(VERIFIER), safe_diff: { from_status: 'FIXED', to_status: 'VERIFIED', cost_borne_by: 'OWNER' } });
    });

    it('disputes a repair, has it put right again, and verifies it the second time', async () => {
      const s = await subject();
      const claim = await claimAt(s, 'FIXED');
      const disputed = await verify(VERIFIER, claim.id, claim.version, { outcome: 'DISPUTED', cost_borne_by: 'UNDETERMINED', note: 'The crack is still there' });
      expect(disputed).toMatchObject({ status: 200, json: { status: 'DISPUTED', resource_version: 4 } });
      expect(await stored(claim.id)).toMatchObject({ status: 'DISPUTED', verified_by: null });
      expect(await verify(VERIFIER, claim.id, 4)).toMatchObject({ status: 409, json: { code: 'CLAIM_STATE_INVALID' } });
      expect((await fix(GUEST, claim.id, 4, { fixed_on: '2027-02-05', note: 'Repaired again with a sealant' })).status).toBe(200);
      expect((await verify(VERIFIER, claim.id, 5)).status).toBe(200);
      expect(await stored(claim.id)).toMatchObject({ status: 'VERIFIED', fixed_on: '2027-02-05' });
    });

    it('is told the status of a claim in the wrong state, a version that moved, and evidence that is missing or not clean', async () => {
      const s = await subject();
      const open = await claimAt(s, 'OPEN');
      expect(await fix(GUEST, open.id, 1)).toMatchObject({ status: 409, json: { code: 'CLAIM_STATE_INVALID' } });
      expect(await verify(VERIFIER, open.id, 1)).toMatchObject({ status: 409, json: { code: 'CLAIM_STATE_INVALID' } });
      expect(await acknowledge(GUEST, open.id, 7)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect(await acknowledge(GUEST, open.id, 1, { committed_fix_on: '2026-12-31' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'committed_fix_on', reason: 'BEFORE_REPORT' } });
      expect((await acknowledge(GUEST, open.id, 1)).status).toBe(200);
      expect(await acknowledge(GUEST, open.id, 2)).toMatchObject({ status: 409, json: { code: 'CLAIM_STATE_INVALID' } });
      expect(await fix(GUEST, open.id, 2, { evidence_document_version_id: undefined })).toMatchObject({ status: 422, json: { code: 'EVIDENCE_REQUIRED' } });
      expect(await fix(GUEST, open.id, 2, { evidence_document_version_id: PENDING })).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_CLEAN' } });
      expect(await fix(GUEST, open.id, 2, { evidence_photo_id: randomUUID() })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', reason: 'NOT_IN_CONTRACT' } });
      expect(await fix(GUEST, open.id, 2, { fixed_on: '2026-12-31' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'fixed_on', reason: 'BEFORE_REPORT' } });
      expect(await fix(GUEST, open.id, 2, { note: '  ' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED', detail: 'note' } });
      expect(await stored(open.id)).toMatchObject({ status: 'ACKNOWLEDGED', version: '2' });
      const fixed = await claimAt(s, 'FIXED');
      expect([400, 422]).toContain((await verify(VERIFIER, fixed.id, 3, { outcome: 'MAYBE' })).status);
      expect([400, 422]).toContain((await verify(VERIFIER, fixed.id, 3, { cost_borne_by: 'EVERYONE' })).status);
      expect(await stored(fixed.id)).toMatchObject({ status: 'FIXED' });
    });

    it('does not flag a claim that was answered, nor one on a day not yet past, and flags one claim of several', async () => {
      const s = await subject();
      const answered = await claimAt(s, 'ACKNOWLEDGED');
      const silent = await file(FILER, s, { claim_no: 'WC-SILENT', reported_on: '2027-03-01' });
      const early = await file(FILER, s, { claim_no: 'WC-EARLY', reported_on: '2027-04-01' });
      expect(await sweep('2027-03-09T09:00:00+07:00')).toBeGreaterThanOrEqual(1);
      expect((await stored(claimIdOf(silent)))?.escalated_at).not.toBeNull();
      expect((await stored(claimIdOf(early)))?.escalated_at).toBeNull();
      expect((await stored(answered.id))?.escalated_at).toBeNull();
      expect(await events(answered.id, 'ast.warranty_claim.overdue.v1')).toHaveLength(0);
    });
  });

  describe('who may', () => {
    it('files for the holders of the right over the contract or the receiving unit: a project seen and not served is 403, one not seen is 404', async () => {
      const s = await subject();
      expect((await file(NOBODY, s)).status).toBe(403);
      expect((await file(READER, s)).status).toBe(403);
      expect(await file(NARROW, s)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await file(ELSEWHERE, s)).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect(await file(FILER, { ...s, obligationId: randomUUID() })).toMatchObject({ status: 404 });
      expect(await rows('select id from machvon.warranty_claim where obligation_id = $1::uuid', [s.obligationId])).toEqual([]);
    });

    it('lets the contractor answer for its own claims only', async () => {
      const s = await subject();
      const claim = await claimAt(s, 'OPEN');
      expect(await acknowledge(GUEST_OTHER, claim.id, 1)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await acknowledge(NOBODY, claim.id, 1)).toMatchObject({ status: 403 });
      expect(await acknowledge(NARROW, claim.id, 1)).toMatchObject({ status: 403, json: { code: 'SCOPE_DENIED' } });
      expect(await acknowledge(ELSEWHERE, claim.id, 1)).toMatchObject({ status: 404 });
      expect(await acknowledge(GUEST, randomUUID(), 1)).toMatchObject({ status: 404 });
      expect((await stored(claim.id))?.status).toBe('OPEN');
      expect((await acknowledge(GUEST, claim.id, 1)).status).toBe(200);
    });

    it('does not reach the claims of another tenant', async () => {
      const s = await subject();
      const claim = await claimAt(s, 'OPEN');
      const other = { member: FOREIGN, tenant: TENANT_B };
      expect((await call('POST', `/warranty-obligations/${s.obligationId}/claims`, { ...other, body: { claim_no: 'X-1', reported_on: '2027-01-10', defect_description: 'Foreign', severity: 'MINOR', responder_contractor_id: contractor } })).status).toBe(404);
      expect((await call('POST', `/warranty-claims/${claim.id}/acknowledge`, { ...other, version: 1, body: { committed_fix_on: '2027-01-25' } })).status).toBe(404);
      expect((await call('GET', '/warranty-claims', other)).json.items).toEqual([]);
    });
  });

  describe('the reads', () => {
    it('lists the claims of an obligation newest first with what the caller may do, the lateness of the answer and the issue, a page at a time, and filters them by status', async () => {
      const s = await subject();
      // The first claim was reported in September 2026: its seven days have long gone.
      const first = { id: claimIdOf(await file(FILER, s, { reported_on: '2026-09-05' })), version: 1 };
      const second = await claimAt(s, 'FIXED');
      const third = await claimAt(s, 'ACKNOWLEDGED');
      const all = await call('GET', `/warranty-claims?obligation_id=${s.obligationId}`, { member: VERIFIER });
      expect(all.status).toBe(200);
      const items = all.json.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.id)).toEqual([third.id, second.id, first.id]);
      expect(items[1]).toMatchObject({
        status: 'FIXED',
        severity: 'MAJOR',
        response_due_on: '2027-01-17',
        committed_fix_on: '2027-01-25',
        fixed_on: '2027-01-24',
        cost_borne_by: 'UNDETERMINED',
        overdue: false,
        issue: null,
        responder: { id: contractor },
        obligation: { id: s.obligationId, ends_on: '2027-09-01' },
        contract: { id: s.contractId },
        allowed: { acknowledge: false, fix: false, verify: true },
        version: 3,
      });
      expect(items[2]).toMatchObject({ status: 'OPEN', overdue: true, allowed: { acknowledge: false, fix: false, verify: false } });
      expect(Object.keys(items[0] ?? {}).sort()).toEqual(
        [
          'allowed',
          'claim_no',
          'committed_fix_on',
          'contract',
          'cost_borne_by',
          'created_at',
          'defect_description',
          'evidence_document_version_id',
          'evidence_photo_id',
          'fix_evidence_document_version_id',
          'fix_evidence_photo_id',
          'fix_note',
          'fixed_on',
          'handover',
          'id',
          'issue',
          'location_text',
          'obligation',
          'overdue',
          'project_id',
          'reported_on',
          'responder',
          'response_due_on',
          'severity',
          'status',
          'verification_note',
          'version',
        ].sort(),
      );
      // The contractor sees what it may do, the filer does not see the verification as its own.
      const contractorView = (await call('GET', `/warranty-claims?obligation_id=${s.obligationId}`, { member: GUEST })).json.items as Array<Record<string, unknown>>;
      expect(contractorView.find((item) => item.id === third.id)).toMatchObject({ allowed: { acknowledge: false, fix: true, verify: false } });
      expect(contractorView.find((item) => item.id === first.id)).toMatchObject({ allowed: { acknowledge: true, fix: false, verify: false } });
      // A contractor with the same rights over the contract is not offered the claims addressed to another contractor.
      const strangerView = (await call('GET', `/warranty-claims?obligation_id=${s.obligationId}`, { member: GUEST_OTHER })).json.items as Array<Record<string, unknown>>;
      expect(strangerView.map((item) => item.allowed)).toEqual([
        { acknowledge: false, fix: false, verify: false },
        { acknowledge: false, fix: false, verify: false },
        { acknowledge: false, fix: false, verify: false },
      ]);
      const filerView = (await call('GET', `/warranty-claims?obligation_id=${s.obligationId}`, { member: FILER })).json.items as Array<Record<string, unknown>>;
      expect(filerView.find((item) => item.id === second.id)).toMatchObject({ allowed: { verify: false } });

      const seen: string[] = [];
      let cursor = '';
      for (let page = 0; page < 5; page += 1) {
        const reply = await call('GET', `/warranty-claims?obligation_id=${s.obligationId}&limit=2${cursor}`, { member: READER });
        seen.push(...(reply.json.items as Array<{ id: string }>).map((item) => item.id));
        if (reply.json.next_cursor === null) break;
        cursor = `&cursor=${encodeURIComponent(reply.json.next_cursor as string)}`;
      }
      expect(seen).toEqual([third.id, second.id, first.id]);
      const fixedOnly = await call('GET', `/warranty-claims?obligation_id=${s.obligationId}&status=FIXED`, { member: READER });
      expect((fixedOnly.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([second.id]);
    });

    it('shows nothing of a claim outside the scope, is for the holders of the right and refuses what is badly formed', async () => {
      const s = await subject();
      await claimAt(s, 'OPEN');
      expect((await call('GET', `/warranty-claims?obligation_id=${s.obligationId}`, { member: ELSEWHERE })).json.items).toEqual([]);
      expect((await call('GET', `/warranty-claims?obligation_id=${s.obligationId}`, { member: NOBODY })).status).toBe(403);
      for (const query of ['obligation_id=nope', 'status=NOPE', 'limit=0', 'limit=500', 'cursor=nope']) expect((await call('GET', `/warranty-claims?${query}`, { member: READER })).status).toBeGreaterThanOrEqual(400);
      expect((await call('GET', '/warranty-claims', { member: READER })).status).toBe(200);
    });

    it('lists the warranties that end within the days asked, the soonest first, and not the ones that ended, are closed or are further off', async () => {
      const today = vietnamToday();
      const near = await subject({ startsOn: yearEarlier(plusDays(today, 20)) });
      const nearer = await subject({ startsOn: yearEarlier(plusDays(today, 10)) });
      const far = await subject({ startsOn: yearEarlier(plusDays(today, 200)) });
      const ended = await subject({ startsOn: yearEarlier(plusDays(today, -5)) });
      const closed = await subject({ startsOn: yearEarlier(plusDays(today, 15)) });
      await stage("update machvon.warranty_obligation set status = 'CLOSED', closed_by = $2::uuid, closed_at = now() where id = $1::uuid", [closed.obligationId, memberId(ROOT)]);
      const idsOf = (reply: Reply): string[] => (reply.json.items as Array<{ id: string }>).map((item) => item.id);
      const ninety = await call('GET', '/warranty-obligations/expiring', { member: READER });
      expect(ninety.status).toBe(200);
      const found = idsOf(ninety);
      expect(found).toEqual(expect.arrayContaining([nearer.obligationId, near.obligationId]));
      expect(found.indexOf(nearer.obligationId)).toBeLessThan(found.indexOf(near.obligationId));
      for (const hidden of [far, ended, closed]) expect(found).not.toContain(hidden.obligationId);
      const fifteen = idsOf(await call('GET', '/warranty-obligations/expiring?within_days=15', { member: READER }));
      expect(fifteen).toContain(nearer.obligationId);
      expect(fifteen).not.toContain(near.obligationId);
      expect(idsOf(await call('GET', '/warranty-obligations/expiring?within_days=400', { member: READER }))).toContain(far.obligationId);
      const seen: string[] = [];
      let cursor = '';
      for (let page = 0; page < 10; page += 1) {
        const reply = await call('GET', `/warranty-obligations/expiring?limit=1${cursor}`, { member: READER });
        seen.push(...idsOf(reply));
        if (reply.json.next_cursor === null) break;
        cursor = `&cursor=${encodeURIComponent(reply.json.next_cursor as string)}`;
      }
      expect(seen).toEqual(found);
      expect((await call('GET', '/warranty-obligations/expiring', { member: NOBODY })).status).toBe(403);
      expect((await call('GET', '/warranty-obligations/expiring', { member: ELSEWHERE })).json.items).toEqual([]);
      for (const query of ['within_days=0', 'within_days=abc', 'within_days=99999', 'within_days=3651', 'limit=0', 'cursor=nope']) expect((await call('GET', `/warranty-obligations/expiring?${query}`, { member: READER })).status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('is kept by the database as well', () => {
    const edit = async (sql: string, params: unknown[] = []): Promise<string> => {
      const client = new Client({ connectionString: harness.database.adminUrl });
      await client.connect();
      try {
        await client.query(sql, params);
        return 'done';
      } catch (error) {
        return (error as Error).message;
      } finally {
        await client.end();
      }
    };

    it('does not let what a claim says change, its status skip a step, what the answer records change, nor the verifier be the reporter or the contractor', async () => {
      const s = await subject();
      const claim = await claimAt(s, 'FIXED');
      expect(await edit("update machvon.warranty_claim set defect_description = 'Something else' where id = $1::uuid", [claim.id])).toMatch(/never changes/);
      expect(await edit("update machvon.warranty_claim set response_due_on = date '2030-01-01' where id = $1::uuid", [claim.id])).toMatch(/never changes/);
      expect(await edit("update machvon.warranty_claim set status = 'OPEN' where id = $1::uuid", [claim.id])).toMatch(/not allowed/);
      expect(await edit("update machvon.warranty_claim set status = 'CLOSED' where id = $1::uuid", [claim.id])).toMatch(/not allowed/);
      expect(await edit("update machvon.warranty_claim set committed_fix_on = date '2027-03-01' where id = $1::uuid", [claim.id])).toMatch(/written once/);
      expect(await edit("update machvon.warranty_claim set status = 'VERIFIED', verified_by = reported_by, verified_at = now() where id = $1::uuid", [claim.id])).toMatch(/warranty_claim_verifier_chk/);
      expect(await edit("update machvon.warranty_claim set status = 'VERIFIED', verified_by = fixed_by, verified_at = now() where id = $1::uuid", [claim.id])).toMatch(/warranty_claim_verifier_chk/);
      const open = await claimAt(s, 'OPEN');
      expect(await edit("update machvon.warranty_claim set status = 'FIXED' where id = $1::uuid", [open.id])).toMatch(/not allowed/);
      expect(await edit("update machvon.warranty_claim set status = 'ACKNOWLEDGED' where id = $1::uuid", [open.id])).toMatch(/warranty_claim_answer_chk/);
      expect(await stored(claim.id)).toMatchObject({ status: 'FIXED' });
    });

    it('writes the issue opened for a late answer and the time it was escalated once, and is never deleted by the application', async () => {
      const s = await subject();
      const claim = await claimAt(s, 'OPEN');
      expect(await sweep('2027-02-01T09:00:00+07:00')).toBeGreaterThanOrEqual(1);
      expect(await edit("update machvon.warranty_claim set escalated_at = now() where id = $1::uuid", [claim.id])).toMatch(/written once/);
      const app = new Client({ connectionString: harness.database.urlFor('machvon_app') });
      await app.connect();
      try {
        await app.query('begin');
        await app.query("select set_config('app.tenant_id', $1, true)", [TENANT_A]);
        await expect(app.query('delete from machvon.warranty_claim where id = $1::uuid', [claim.id])).rejects.toThrow(/permission denied/);
      } finally {
        await app.end();
      }
      expect(await stored(claim.id)).toMatchObject({ status: 'OPEN' });
    });
  });
});
