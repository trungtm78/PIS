import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { astModule } from '../../src/modules/ast';
import { AssetController, AssetReadsController } from '../../src/modules/ast/asset.controller';
import { CapWorld } from '../../../../packages/db/test/support/cap-fixtures';
import { TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs, seedContractor } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { asSuperuser } from '../../../../packages/db/test/support/ncr-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(480_000);

const SIGNING_KEY = randomBytes(32);
const FAMILY = 0xb5;
const ROOT = 1;
const ACCOUNTANT = 11; // asset.manage, asset_record.read: registers the assets and sees their value
const OPERATOR = 12; // asset.transfer, asset_record.read over the unit that receives the work, and nothing else
const READER = 13; // asset_record.read
const NOBODY = 14;
const ELSEWHERE = 15; // the rights of ACCOUNTANT over another branch
const GUEST = 16; // the contractor of the contract, reading what is of its contract
const FOREIGN = 17; // a member of another tenant with every right over the assets of that tenant
const MEMBERS = [ACCOUNTANT, OPERATOR, READER, NOBODY, ELSEWHERE, GUEST];
const OTHER_BRANCH = 5;
const RECEIVING_UNIT = 7;
const DOCUMENT = id(FAMILY, 30);
const CLEAN = id(FAMILY, 31);
const PENDING = id(FAMILY, 32);
const CONTRACT_VALUE = '10000000000';

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const vietnamToday = (): string => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

describe('the assets of a work over HTTP (ST-AST-002)', () => {
  const world = new CapWorld();
  const harness = world.harness;
  let app: RunningApp;
  let counter = 0;
  let contractor = '';

  const tokenOf = (member: number, tenantId: string = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; body?: unknown; ifMatch?: string; key?: string; tenant?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenant), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = options.key ?? `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
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
  const stored = async (assetId: string) =>
    (await rows<{ status: string; version: string; transferred_on: string | null; external_asset_id: string | null }>('select status, version::text, transferred_on::text, external_asset_id from machvon.asset_record where id = $1::uuid', [assetId]))[0];

  interface Target {
    contractId: string;
    projectId: string;
    handoverId: string;
  }

  /** A contract worth ten billion with a handover of the status asked for; a guest contractor is invited to it. */
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
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'Contract', 'CONSTRUCTION', false, true, $7::numeric, $8, $8, date '2026-01-02', date '2026-01-03')`,
        [TENANT_A, contractId, line.projectId, randomUUID(), contractor, `HD-C-${String(counter).padStart(4, '0')}`, CONTRACT_VALUE, memberId(ROOT)],
      ],
    ]);
    await stage(
      `insert into machvon.handover
         (tenant_id, id, project_id, contract_id, recipient_unit_id, document_version_id, punch_list, status, handover_no, handover_kind, created_by, updated_by, version, accepted_at, accepted_by, as_built_document_version_id)
       values ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7, $8, 'COMPLETION', $9, $9, 1, $10::timestamptz, $11, $12)`,
      [TENANT_A, handoverId, line.projectId, contractId, unitId(RECEIVING_UNIT), CLEAN, status, `BG-${counter}`, memberId(ROOT), status === 'ACCEPTED' ? '2026-12-10T03:00:00Z' : null, status === 'ACCEPTED' ? memberId(ROOT) : null, status === 'ACCEPTED' ? CLEAN : null],
    );
    await harness.seedGrants(TENANT_A, [{ n: 2000 + counter, member: GUEST, role: 105, kind: 'CONTRACT', refs: [contractId] }]);
    // The access of a member is cached by the scope version of its membership: a member given a new grant moves to the next version.
    await world.owner('update machvon.membership set scope_version = scope_version + 1 where id = $1::uuid', [memberId(GUEST)]);
    return { contractId, projectId: line.projectId, handoverId };
  }

  const register = (member: number, subject: Target, overrides: Record<string, unknown> = {}, key?: string) =>
    call('POST', '/asset-records', {
      member,
      ...(key === undefined ? {} : { key }),
      body: { project_id: subject.projectId, handover_id: subject.handoverId, asset_code: `AS-${++counter}`, name: 'Pump house', recipient_unit_id: unitId(RECEIVING_UNIT), value_vnd: '5000000000', value_basis: 'CONTRACT_VALUE', ...overrides },
    });
  const transfer = (member: number, assetId: string, version: number | string = 1, overrides: Record<string, unknown> = {}) =>
    call('POST', `/asset-records/${assetId}/transfer`, { member, ifMatch: `"${version}"`, body: { transferred_on: vietnamToday(), commissioning_document_version_id: CLEAN, ...overrides } });
  const read = async (member: number, assetId: string): Promise<Record<string, unknown>> => (await call('GET', `/resources/asset_record/${assetId}`, { member })).json;

  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [
      { n: OTHER_BRANCH, path: `/${unitId(OTHER_BRANCH)}/` },
      { n: RECEIVING_UNIT, path: `/${unitId(RECEIVING_UNIT)}/` },
    ]);
    for (const n of MEMBERS) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedUnits(TENANT_B, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    await harness.seedMembership(TENANT_B, FOREIGN, ROOT);
    await harness.seedRole(TENANT_B, 601, 'AST_ASSETS', ['asset.manage', 'asset.transfer', 'asset_record.read'], 60);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: FOREIGN, role: 601, kind: 'TENANT' }]);
    const roles: Array<[number, string, readonly string[], number]> = [
      [1, 'AST_ACCOUNTANT', ['asset.manage', 'asset_record.read'], 40],
      [2, 'AST_OPERATOR', ['asset.transfer', 'asset_record.read'], 40],
      [3, 'AST_READER', ['asset_record.read'], 10],
      [5, 'AST_CONTRACTOR', ['asset_record.read'], 5],
    ];
    for (const [n, code, permissions, rank] of roles) await harness.seedRole(TENANT_A, 100 + n, code, permissions, rank);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: ACCOUNTANT, role: 101, kind: 'TENANT' },
      { n: 2, member: OPERATOR, role: 102, kind: 'UNIT_SUBTREE', refs: [unitId(RECEIVING_UNIT)] },
      { n: 3, member: READER, role: 103, kind: 'TENANT' },
      { n: 4, member: ELSEWHERE, role: 101, kind: 'UNIT_SUBTREE', refs: [unitId(OTHER_BRANCH)] },
    ]);
    contractor = await seedContractor(harness);
    await seedAs(harness, [
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3)`, [TENANT_A, DOCUMENT, memberId(ROOT)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ast/commissioning.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $4, $3, 2, 'tenants/ast/unscanned.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'PENDING', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, CLEAN, DOCUMENT, PENDING],
      ],
    ]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [
        CommandModule.register({ database: tenants }),
        PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) }),
      ],
      controllers: [AssetController, AssetReadsController],
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
    expect(astModule.controllers).toEqual(expect.arrayContaining([AssetController, AssetReadsController]));
  });

  describe('registerAsset (AC-ST-AST-002-1, UAT-AC389)', () => {
    it('AC-ST-AST-002-1, UAT-AC389: registers an asset of an accepted handover with its audit row and its event, answers the same key once, and refuses a value above the contract and a code that is used', async () => {
      const subject = await target();
      const waiting = await target('PUNCH_PENDING');
      expect(await register(ACCOUNTANT, waiting)).toMatchObject({ status: 409, json: { code: 'HANDOVER_STATE_INVALID' } });

      const send = () => register(ACCOUNTANT, subject, { asset_code: 'AS-ONCE' }, 'register-once-for-this-key');
      const first = await send();
      expect(first).toMatchObject({ status: 200, json: { status: 'REGISTERED', resource_version: 1 } });
      expect(await send()).toEqual(first);
      const assetId = first.json.resource_id as string;
      expect(await rows('select id from machvon.asset_record where handover_id = $1::uuid', [subject.handoverId])).toHaveLength(1);
      expect((await audits(assetId, 'asset.registered'))[0]).toMatchObject({
        actor_id: memberId(ACCOUNTANT),
        safe_diff: { asset_code: 'AS-ONCE', contract_id: subject.contractId, value_vnd: '5000000000', contract_value_vnd: CONTRACT_VALUE, registered_total_vnd: '5000000000', from_status: null, to_status: 'REGISTERED' },
      });
      expect((await events(assetId, 'ast.asset.registered.v1'))[0]?.payload).toMatchObject({ asset_id: assetId, handover_id: subject.handoverId, contract_id: subject.contractId, project_id: subject.projectId, recipient_unit_id: unitId(RECEIVING_UNIT), status: 'REGISTERED', version: 1, actor_id: memberId(ACCOUNTANT) });

      expect(await register(ACCOUNTANT, subject, { value_vnd: '5000000001' })).toMatchObject({ status: 422, json: { code: 'VALUE_EXCEEDS_CONTRACT', total_vnd: '10000000001' } });
      expect(await register(ACCOUNTANT, subject, { asset_code: 'AS-ONCE', value_vnd: '1' })).toMatchObject({ status: 409, json: { code: 'ASSET_CODE_DUPLICATE' } });
      expect(await register(ACCOUNTANT, subject, { value_vnd: '5000000000' })).toMatchObject({ status: 200, json: { status: 'REGISTERED' } });
    });

    it('refuses what is badly formed, an asset of a handover that does not exist, and a caller without the right or outside its scope', async () => {
      const subject = await target();
      expect(await register(ACCOUNTANT, subject, { value_vnd: '12.5' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await register(ACCOUNTANT, subject, { value_basis: 'GUESS' })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await register(ACCOUNTANT, subject, { status: 'TRANSFERRED' })).toMatchObject({ status: 400, json: { code: 'FIELD_NOT_ALLOWED' } });
      expect(await register(ACCOUNTANT, { ...subject, handoverId: randomUUID() })).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect((await register(READER, subject)).status).toBe(403);
      expect((await register(OPERATOR, subject)).status).toBe(403);
      expect((await register(NOBODY, subject)).status).toBe(403);
      expect((await register(ELSEWHERE, subject)).status).toBe(404);
      expect(await rows('select id from machvon.asset_record where handover_id = $1::uuid', [subject.handoverId])).toEqual([]);
    });
  });

  describe('transferAsset (AC-ST-AST-002-1, UAT-AC389)', () => {
    it('AC-ST-AST-002-1, UAT-AC389: lets the receiving unit transfer a registered asset with the dossier of the commissioning, and refuses the rest', async () => {
      const subject = await target();
      const assetId = (await register(ACCOUNTANT, subject)).json.resource_id as string;
      expect(await transfer(OPERATOR, assetId, 1, { commissioning_document_version_id: undefined })).toMatchObject({ status: 422, json: { code: 'VALIDATION_FAILED' } });
      expect(await transfer(OPERATOR, assetId, 1, { commissioning_document_version_id: PENDING })).toMatchObject({ status: 422, json: { code: 'DOCUMENT_NOT_CLEAN' } });
      expect(await transfer(OPERATOR, assetId, 9)).toMatchObject({ status: 409, json: { code: 'VERSION_CONFLICT' } });
      expect((await transfer(ACCOUNTANT, assetId)).status).toBe(403);
      expect((await transfer(READER, assetId)).status).toBe(403);
      expect((await transfer(ELSEWHERE, assetId)).status).toBe(403);
      expect(await stored(assetId)).toMatchObject({ status: 'REGISTERED', version: '1' });

      const done = await transfer(OPERATOR, assetId, 1, { external_asset_id: 'TS-2027-009' });
      expect(done).toMatchObject({ status: 200, json: { status: 'TRANSFERRED', resource_version: 2, resource_id: assetId } });
      expect(await stored(assetId)).toMatchObject({ status: 'TRANSFERRED', version: '2', transferred_on: vietnamToday(), external_asset_id: 'TS-2027-009' });
      expect((await audits(assetId, 'asset.transferred'))[0]).toMatchObject({ actor_id: memberId(OPERATOR), safe_diff: { from_status: 'REGISTERED', to_status: 'TRANSFERRED', transferred_on: vietnamToday(), external_asset_id: 'TS-2027-009' } });
      expect((await events(assetId, 'ast.asset.transferred.v1'))[0]?.payload).toMatchObject({ asset_id: assetId, status: 'TRANSFERRED', from_status: 'REGISTERED', version: 2, actor_id: memberId(OPERATOR) });
      expect(await transfer(OPERATOR, assetId, 2)).toMatchObject({ status: 409, json: { code: 'ASSET_STATE_INVALID' } });
    });
  });

  describe('linkOmPlan (AC-ST-AST-005-1, UAT-AC393)', () => {
    const OPERATING_UNIT = 8;
    const linkOm = (member: number, assetId: string, overrides: Record<string, unknown> = {}) =>
      call('POST', `/asset-records/${assetId}/om-link`, { member, body: { operator_unit_id: unitId(OPERATING_UNIT), maintenance_cycle_months: 6, next_maintenance_due: '2027-03-01', ...overrides } });
    const linksOf = (assetId: string) =>
      rows<{ id: string; status: string; operator_unit_id: string; maintenance_cycle_months: number | null; next_maintenance_due: string | null; external_system_ref: string | null }>(
        'select id, status, operator_unit_id, maintenance_cycle_months, next_maintenance_due::text as next_maintenance_due, external_system_ref from machvon.om_link where asset_id = $1::uuid',
        [assetId],
      );
    /** A contract of a project, to be the O&M contract of an asset. */
    async function omContract(projectId: string): Promise<string> {
      const contractId = randomUUID();
      counter += 1;
      await seedAs(harness, [
        [
          `insert into machvon.contract
             (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd, created_by, updated_by, signed_on, effective_from)
           values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'O&M', 'OTHER', false, false, 1000000, $7, $7, date '2026-01-02', date '2026-01-03')`,
          [TENANT_A, contractId, projectId, randomUUID(), contractor, `OM-${String(counter).padStart(4, '0')}`, memberId(ROOT)],
        ],
      ]);
      return contractId;
    }

    beforeAll(async () => {
      await harness.seedUnits(TENANT_A, [{ n: OPERATING_UNIT, path: `/${unitId(OPERATING_UNIT)}/` }]);
    });

    it('AC-ST-AST-005-1 UAT-AC393: an asset that was not transferred is 422 ASSET_NOT_TRANSFERRED, a transferred one is linked, and a second link is 409 OM_LINK_EXISTS', async () => {
      const subject = await target();
      const registered = (await register(ACCOUNTANT, subject)).json.resource_id as string;
      const refused = await linkOm(ACCOUNTANT, registered);
      expect([refused.status, refused.json.code]).toEqual([422, 'ASSET_NOT_TRANSFERRED']);
      expect(await linksOf(registered)).toEqual([]);
      const assetId = (await register(ACCOUNTANT, subject)).json.resource_id as string;
      expect((await transfer(OPERATOR, assetId, 1, { external_asset_id: 'TS-2027-009' })).status).toBe(200);
      const done = await linkOm(ACCOUNTANT, assetId, { external_system_ref: '  CMMS-77  ' });
      expect(done).toMatchObject({ status: 200, json: { status: 'LINKED', resource_version: 1 } });
      expect(await linksOf(assetId)).toEqual([expect.objectContaining({ status: 'LINKED', operator_unit_id: unitId(OPERATING_UNIT), maintenance_cycle_months: 6, next_maintenance_due: '2027-03-01', external_system_ref: 'CMMS-77' })]);
      const second = await linkOm(ACCOUNTANT, assetId, { maintenance_cycle_months: 12 });
      expect([second.status, second.json.code]).toEqual([409, 'OM_LINK_EXISTS']);
      expect(await linksOf(assetId)).toHaveLength(1);
      // The asset shows the link, and says it takes no other.
      const shown = await read(ACCOUNTANT, assetId);
      expect(shown).toMatchObject({ om_link: { status: 'LINKED', maintenance_cycle_months: 6, next_maintenance_due: '2027-03-01', external_system_ref: 'CMMS-77', operator_unit: { id: unitId(OPERATING_UNIT) } }, allowed: { link_om: false }, external_asset_id: 'TS-2027-009' });
      expect((await read(ACCOUNTANT, registered)).om_link).toBeNull();
      const trail = await audits(done.json.resource_id as string, 'asset.om_linked');
      expect(trail).toHaveLength(1);
      expect(trail[0]?.safe_diff).toMatchObject({ asset_id: assetId, operator_unit_id: unitId(OPERATING_UNIT), maintenance_cycle_months: 6, next_maintenance_due: '2027-03-01' });
      expect(JSON.stringify(trail)).not.toContain('CMMS-77');
      expect((await events(done.json.resource_id as string, 'ast.om_link.linked.v1')).length).toBe(1);
    });

    it('offers the link to whoever may make it while the asset has none, and answers the same key once', async () => {
      const subject = await target();
      const assetId = (await register(ACCOUNTANT, subject)).json.resource_id as string;
      expect((await read(ACCOUNTANT, assetId)).allowed).toEqual({ transfer: false, link_om: false });
      await transfer(OPERATOR, assetId, 1);
      expect((await read(ACCOUNTANT, assetId)).allowed).toEqual({ transfer: false, link_om: true });
      expect((await read(READER, assetId)).allowed).toEqual({ transfer: false, link_om: false });
      const key = `key-${randomUUID()}`;
      const body = { operator_unit_id: unitId(OPERATING_UNIT) };
      const first = await call('POST', `/asset-records/${assetId}/om-link`, { member: ACCOUNTANT, key, body });
      const replay = await call('POST', `/asset-records/${assetId}/om-link`, { member: ACCOUNTANT, key, body });
      expect(replay).toEqual(first);
      expect(await linksOf(assetId)).toHaveLength(1);
    });

    it('takes a plan that is a clean file and a contract of the same project, a cycle of 1 to 120 months and a real day, and a unit of the tenant', async () => {
      const subject = await target();
      const assetId = (await register(ACCOUNTANT, subject)).json.resource_id as string;
      await transfer(OPERATOR, assetId, 1);
      const other = await target();
      const sameProject = await omContract(subject.projectId);
      const elsewhere = await omContract(other.projectId);
      for (const [overrides, code, detail] of [
        [{ operator_unit_id: 'x' }, 'VALIDATION_FAILED', 'operator_unit_id'],
        [{ operator_unit_id: randomUUID() }, 'VALIDATION_FAILED', 'operator_unit_id'],
        [{ om_plan_document_version_id: randomUUID() }, 'VALIDATION_FAILED', 'om_plan_document_version_id'],
        [{ om_plan_document_version_id: PENDING }, 'DOCUMENT_NOT_CLEAN', 'om_plan_document_version_id'],
        [{ om_contract_id: randomUUID() }, 'VALIDATION_FAILED', 'om_contract_id'],
        [{ om_contract_id: elsewhere }, 'VALIDATION_FAILED', 'om_contract_id'],
        [{ maintenance_cycle_months: 0 }, 'VALIDATION_FAILED', 'maintenance_cycle_months'],
        [{ maintenance_cycle_months: 121 }, 'VALIDATION_FAILED', 'maintenance_cycle_months'],
        [{ next_maintenance_due: '2027-02-30' }, 'VALIDATION_FAILED', 'next_maintenance_due'],
        [{ external_system_ref: '' }, 'VALIDATION_FAILED', 'external_system_ref'],
      ] as const) {
        const refused = await linkOm(ACCOUNTANT, assetId, overrides);
        expect([refused.status, refused.json.code, refused.json.detail]).toEqual([422, code, detail]);
      }
      // A cycle that is not a whole number is turned back by the shape of the request.
      expect((await linkOm(ACCOUNTANT, assetId, { maintenance_cycle_months: 6.5 })).status).toBe(400);
      expect(await linksOf(assetId)).toEqual([]);
      const done = await linkOm(ACCOUNTANT, assetId, { om_plan_document_version_id: CLEAN, om_contract_id: sameProject, maintenance_cycle_months: 120 });
      expect(done.status).toBe(200);
      expect((await read(ACCOUNTANT, assetId)).om_link).toMatchObject({ om_plan_document_version_id: CLEAN, om_contract_id: sameProject, maintenance_cycle_months: 120 });
    });

    it('is for whoever holds the right over the asset: a caller without it is 403, one outside its scope 404, and another tenant\'s caller 404', async () => {
      const subject = await target();
      const assetId = (await register(ACCOUNTANT, subject)).json.resource_id as string;
      await transfer(OPERATOR, assetId, 1);
      expect((await linkOm(NOBODY, assetId)).status).toBe(403);
      expect((await linkOm(READER, assetId)).status).toBe(403);
      expect((await linkOm(OPERATOR, assetId)).status).toBe(403);
      expect((await linkOm(ELSEWHERE, assetId)).status).toBe(404);
      expect((await linkOm(ACCOUNTANT, randomUUID())).status).toBe(404);
      expect((await call('POST', `/asset-records/${assetId}/om-link`, { member: FOREIGN, tenant: TENANT_B, body: { operator_unit_id: unitId(OPERATING_UNIT) } })).status).toBe(404);
      expect(await linksOf(assetId)).toEqual([]);
    });

    it('does not let a link change what it says, or be deleted: it is suspended, and then the asset takes another', async () => {
      const subject = await target();
      const assetId = (await register(ACCOUNTANT, subject)).json.resource_id as string;
      await transfer(OPERATOR, assetId, 1);
      await linkOm(ACCOUNTANT, assetId);
      const [link] = await linksOf(assetId);
      await expect(rows("update machvon.om_link set maintenance_cycle_months = 24 where id = $1::uuid", [link?.id])).rejects.toThrow('what an operation link says never changes');
      await expect(rows("update machvon.om_link set status = 'DRAFT' where id = $1::uuid", [link?.id])).rejects.toThrow();
      await rows("update machvon.om_link set status = 'SUSPENDED' where id = $1::uuid", [link?.id]);
      expect((await linkOm(ACCOUNTANT, assetId, { maintenance_cycle_months: 12 })).status).toBe(200);
      expect((await linksOf(assetId)).map((each) => each.status).sort()).toEqual(['LINKED', 'SUSPENDED']);
      expect((await rows<{ privilege: string }>("select privilege_type as privilege from information_schema.role_table_grants where grantee = 'machvon_app' and table_name = 'om_link' and privilege_type in ('DELETE', 'TRUNCATE')")).length).toBe(0);
    });
  });

  describe('reading', () => {
    it('shows the value and the code in the other system only to whoever may see them, and what each person may do', async () => {
      const subject = await target();
      const first = (await register(ACCOUNTANT, subject, { asset_code: 'AS-A', value_vnd: '3200000000' })).json.resource_id as string;
      const second = (await register(ACCOUNTANT, subject, { asset_code: 'AS-B', value_vnd: '1800000000' })).json.resource_id as string;
      await transfer(OPERATOR, first, 1, { external_asset_id: 'TS-1' });

      const accountant = await read(ACCOUNTANT, first);
      expect(accountant).toMatchObject({
        asset_code: 'AS-A',
        status: 'TRANSFERRED',
        value_vnd: '3200000000',
        value_basis: 'CONTRACT_VALUE',
        contract_assets_vnd: '5000000000',
        contract: { id: subject.contractId, value_vnd: CONTRACT_VALUE },
        handover: { id: subject.handoverId, status: 'ACCEPTED' },
        recipient_unit: { id: unitId(RECEIVING_UNIT) },
        external_asset_id: 'TS-1',
        transferred_on: vietnamToday(),
        allowed: { transfer: false },
      });
      // The operator moves the asset, the accountant who registers it does not, and a reader sees the asset and no figure.
      expect(await read(OPERATOR, second)).toMatchObject({ value_vnd: '1800000000', external_asset_id: null, allowed: { transfer: true } });
      expect(await read(ACCOUNTANT, second)).toMatchObject({ allowed: { transfer: false } });
      const reader = await read(READER, second);
      expect(reader).toMatchObject({ asset_code: 'AS-B', value_vnd: null, value_basis: null, contract_assets_vnd: null, allowed: { transfer: false } });
      expect(reader.contract).toEqual({ id: subject.contractId, code: expect.any(String) });
      // The guest contractor sees the asset of its contract and no figure.
      expect(await read(GUEST, first)).toMatchObject({ asset_code: 'AS-A', value_vnd: null, contract_assets_vnd: null });
      expect((await call('GET', `/resources/asset_record/${first}`, { member: ELSEWHERE })).status).toBe(404);
      expect((await call('GET', `/resources/asset_record/${first}`, { member: NOBODY })).status).toBe(403);
      expect((await call('GET', `/resources/asset_record/${randomUUID()}`, { member: READER })).status).toBe(404);
    });

    it('lists the assets of the scope, the newest first and paged, with the filters, and the receiving unit sees what it receives', async () => {
      const subject = await target();
      const first = (await register(ACCOUNTANT, subject, { asset_code: 'AS-L1', value_vnd: '1' })).json.resource_id as string;
      const second = (await register(ACCOUNTANT, subject, { asset_code: 'AS-L2', value_vnd: '2' })).json.resource_id as string;
      const all = await call('GET', `/resources/asset_record?contract_id=${subject.contractId}`, { member: READER });
      expect((all.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([second, first]);
      const page = await call('GET', `/resources/asset_record?handover_id=${subject.handoverId}&limit=1`, { member: READER });
      expect((page.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([second]);
      const next = await call('GET', `/resources/asset_record?handover_id=${subject.handoverId}&limit=1&cursor=${page.json.next_cursor as string}`, { member: READER });
      expect((next.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual([first]);
      expect(next.json.next_cursor).toBeNull();
      expect((await call('GET', `/resources/asset_record?contract_id=${subject.contractId}&status=TRANSFERRED`, { member: READER })).json.items).toEqual([]);
      expect((await call('GET', '/resources/asset_record?contract_id=nope', { member: READER })).status).toBe(422);
      expect((await call('GET', '/resources/asset_record?status=1', { member: READER })).status).toBe(422);
      expect((await call('GET', '/resources/asset_record?limit=0', { member: READER })).status).toBe(422);
      expect((await call('GET', '/resources/asset_record', { member: NOBODY })).status).toBe(403);
      expect(((await call('GET', `/resources/asset_record?contract_id=${subject.contractId}`, { member: OPERATOR })).json.items as unknown[]).length).toBe(2);
      expect((await call('GET', `/resources/asset_record?contract_id=${subject.contractId}`, { member: ELSEWHERE })).json.items).toEqual([]);
    });
  });

  describe('another tenant (UAT-AC395)', () => {
    it('does not see or transfer an asset of the first tenant, whatever its rights in its own', async () => {
      const subject = await target();
      const assetId = (await register(ACCOUNTANT, subject)).json.resource_id as string;
      const foreign = (method: string, url: string, body?: unknown, ifMatch?: string) => call(method, url, { member: FOREIGN, tenant: TENANT_B, ...(body === undefined ? {} : { body }), ...(ifMatch === undefined ? {} : { ifMatch }) });
      expect(await foreign('GET', `/resources/asset_record/${assetId}`)).toMatchObject({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      expect(((await foreign('GET', '/resources/asset_record')).json.items as unknown[]).length).toBe(0);
      expect((await foreign('POST', `/asset-records/${assetId}/transfer`, { transferred_on: vietnamToday(), commissioning_document_version_id: CLEAN }, '"1"')).status).toBe(404);
      expect((await foreign('POST', '/asset-records', { project_id: subject.projectId, handover_id: subject.handoverId, asset_code: 'AS-X', name: 'x', recipient_unit_id: unitId(RECEIVING_UNIT), value_vnd: '1', value_basis: 'CONTRACT_VALUE' })).status).toBe(404);
      expect(await stored(assetId)).toMatchObject({ status: 'REGISTERED', version: '1' });
    });
  });
});
