import { randomUUID } from 'node:crypto';
import { AstAssetStore } from '../src/ast-asset-store';
import type { RegisterInput, TransferInput } from '../src/ast-asset-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import type { HandoverScopes } from '../src/ast-handover-store';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, contextFor, id, memberId, unitId } from './support/authz-fixtures';
import { seedAs } from './support/bid-proposal-fixtures';
import { CapWorld } from './support/cap-fixtures';
import { asSuperuser } from './support/ncr-fixtures';

const world = new CapWorld();
const harness = world.harness;
const assets = new AstAssetStore();
const FAMILY = 0xb4;
const ACCOUNTANT = 1; // registers the assets
const OPERATOR = 2; // transfers them
const RECEIVER = 7;
const OTHER_UNIT = 8;
const DOCUMENT = id(FAMILY, 30);
const CLEAN = id(FAMILY, 31);
const PENDING = id(FAMILY, 32);
const NOW = new Date('2026-12-20T03:00:00Z');
const CONTRACT_VALUE = '10000000000';
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const all: HandoverScopes = everything;
const readOnly: HandoverScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const invisible: HandoverScopes = { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'false', params: [] }) };
const allRows = () => ({ sql: 'true', params: [] as unknown[] });
const noRows = () => ({ sql: 'false', params: [] as unknown[] });

let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = ACCOUNTANT): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
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
  handoverId: string;
}

/** A contract worth ten billion with a handover of the status asked for (an accepted one has its dossier). */
async function seed(status = 'ACCEPTED'): Promise<Seeded> {
  counter += 1;
  const contractId = randomUUID();
  const handoverId = randomUUID();
  const line = await world.publishedLine();
  await seedAs(harness, [
    [
      `insert into machvon.contract
         (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
          created_by, updated_by, signed_on, effective_from)
       values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'Contract', 'CONSTRUCTION', false, true, $7::numeric, $8, $8, date '2026-01-02', date '2026-01-03')`,
      [TENANT_A, contractId, line.projectId, randomUUID(), randomUUID(), `HD-T-${String(counter).padStart(4, '0')}`, CONTRACT_VALUE, memberId(ACCOUNTANT)],
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
      unitId(RECEIVER),
      CLEAN,
      status,
      `BG-${counter}`,
      memberId(ACCOUNTANT),
      status === 'ACCEPTED' ? '2026-12-10T03:00:00Z' : null,
      status === 'ACCEPTED' ? memberId(OPERATOR) : null,
      status === 'ACCEPTED' ? CLEAN : null,
    ],
  );
  return { contractId, projectId: line.projectId, handoverId };
}

const input = (target: Seeded, overrides: Partial<RegisterInput> = {}): RegisterInput => ({
  projectId: target.projectId,
  handoverId: target.handoverId,
  assetCode: `AS-${++counter}`,
  name: 'Pump house',
  recipientUnitId: unitId(RECEIVER),
  valueVnd: '5000000000',
  valueBasis: 'CONTRACT_VALUE',
  ...overrides,
});
const register = (target: Seeded, overrides: Partial<RegisterInput> = {}, scopes: ContractScopes = everything) => as((tx) => assets.register(tx, input(target, overrides), memberId(ACCOUNTANT), scopes, NOW));
const transfer = (assetId: string, version: number, overrides: Partial<TransferInput> = {}, scopes: HandoverScopes = all) =>
  as((tx) => assets.transfer(tx, assetId, version, { transferredOn: '2026-12-20', commissioningDocumentVersionId: CLEAN, ...overrides }, memberId(OPERATOR), scopes, NOW), OPERATOR);

const rowOf = async (assetId: string) =>
  (
    await owner<{ status: string; version: string; value_vnd: string; registered_on: string | null; transferred_on: string | null; transferred_by: string | null; external_asset_id: string | null; source_contract_id: string | null }>(
      'select status, version::text, value_vnd::text, registered_on::text, transferred_on::text, transferred_by, external_asset_id, source_contract_id from machvon.asset_record where id = $1::uuid',
      [assetId],
    )
  )[0];

describe('the assets of a work (ST-AST-002)', () => {
  beforeAll(async () => {
    await world.start();
    await harness.seedUnits(TENANT_A, [
      { n: RECEIVER, path: `/${unitId(RECEIVER)}/` },
      { n: OTHER_UNIT, path: `/${unitId(OTHER_UNIT)}/` },
    ]);
    await seedAs(harness, [
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3)`, [TENANT_A, DOCUMENT, memberId(ACCOUNTANT)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/ast/commissioning.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL'),
                ($1, $4, $3, 2, 'tenants/ast/unscanned.pdf', repeat('b', 64), 'application/pdf', 1, 'INTERNAL', 'PENDING', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, CLEAN, DOCUMENT, PENDING],
      ],
    ]);
  }, 240_000);

  afterAll(async () => {
    await world.stop();
  }, 60_000);

  describe('registering', () => {
    it('AC-ST-AST-002-1, UAT-AC389: registers an asset only of an accepted handover, never above the value of the contract, and with a code that is not used', async () => {
      const waiting = await seed('PUNCH_PENDING');
      expect(await refusal(register(waiting))).toMatchObject({ code: 'HANDOVER_STATE_INVALID', status: 409, extensions: { status: 'PUNCH_PENDING' } });

      const target = await seed();
      const first = await register(target, { assetCode: 'AS-FIRST', valueVnd: '5000000000' });
      expect(first).toMatchObject({ assetCode: 'AS-FIRST', status: 'REGISTERED', fromStatus: null, version: 1, valueVnd: '5000000000', registeredTotalVnd: '5000000000', contractValueVnd: CONTRACT_VALUE, contractId: target.contractId, handoverId: target.handoverId });
      expect(await rowOf(first.id)).toMatchObject({ status: 'REGISTERED', version: '1', value_vnd: '5000000000', registered_on: '2026-12-20', source_contract_id: target.contractId });
      expect(await refusal(register(target, { valueVnd: '5000000001' }))).toMatchObject({
        code: 'VALUE_EXCEEDS_CONTRACT',
        status: 422,
        extensions: { contract_value_vnd: CONTRACT_VALUE, registered_vnd: '5000000000', value_vnd: '5000000001', total_vnd: '10000000001' },
      });
      const second = await register(target, { assetCode: 'AS-SECOND', valueVnd: '5000000000' });
      expect(second.registeredTotalVnd).toBe(CONTRACT_VALUE);
      expect(await refusal(register(target, { assetCode: 'AS-FIRST', valueVnd: '0' }))).toMatchObject({ code: 'ASSET_CODE_DUPLICATE', status: 409, detail: 'asset_code' });
      // The same code is free in another project.
      const other = await seed();
      expect((await register(other, { assetCode: 'AS-FIRST', valueVnd: '1' })).status).toBe('REGISTERED');
    });

    it('refuses what is badly formed, an asset that is not of the handover, a unit or a class that is not there, and a caller without the right or outside its scope', async () => {
      const target = await seed();
      expect(await refusal(register(target, { assetCode: ' ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'asset_code' });
      expect(await refusal(register(target, { name: '' }))).toMatchObject({ detail: 'name' });
      expect(await refusal(register(target, { valueVnd: '12.5' }))).toMatchObject({ detail: 'value_vnd' });
      expect(await refusal(register(target, { valueVnd: '-1' }))).toMatchObject({ detail: 'value_vnd' });
      expect(await refusal(register(target, { valueBasis: 'GUESS' }))).toMatchObject({ detail: 'value_basis' });
      expect(await refusal(register(target, { warrantyUntil: '2026-02-30' }))).toMatchObject({ detail: 'warranty_until' });
      expect(await refusal(register(target, { fundingOrigin: '' }))).toMatchObject({ detail: 'funding_origin' });
      expect(await refusal(register(target, { handoverId: 'nope' }))).toMatchObject({ detail: 'handover_id' });
      expect(await refusal(register(target, { projectId: (await seed()).projectId }))).toMatchObject({ detail: 'project_id', extensions: { reason: 'NOT_THE_PROJECT_OF_THE_HANDOVER' } });
      expect(await refusal(register(target, { sourceContractId: (await seed()).contractId }))).toMatchObject({ detail: 'source_contract_id', extensions: { reason: 'NOT_THE_CONTRACT_OF_THE_HANDOVER' } });
      expect(await refusal(register(target, { recipientUnitId: unitId(99) }))).toMatchObject({ detail: 'recipient_unit_id', extensions: { reason: 'NOT_FOUND' } });
      expect(await refusal(register(target, { assetClassMasterVersionId: randomUUID() }))).toMatchObject({ detail: 'asset_class_master_version_id', extensions: { reason: 'NOT_FOUND' } });
      expect(await refusal(register(target, { handoverId: randomUUID() }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect((await refusal(register(target, {}, { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'true', params: [] }) }))).status).toBe(403);
      expect(await refusal(register(target, {}, { update: () => ({ sql: 'false', params: [] }), read: () => ({ sql: 'false', params: [] }) }))).toMatchObject({ status: 404 });
      expect(await owner('select id from machvon.asset_record where handover_id = $1::uuid', [target.handoverId])).toEqual([]);
      const full = await register(target, { assetCode: 'AS-FULL', sourceContractId: target.contractId, fundingOrigin: 'State budget', warrantyUntil: '2027-12-20', valueBasis: 'APPRAISED_VALUE', valueVnd: '000100' });
      expect(full).toMatchObject({ valueVnd: '100', valueBasis: 'APPRAISED_VALUE' });
    });
  });

  describe('transferring', () => {
    it('AC-ST-AST-002-1, UAT-AC389: transfers a registered asset with the dossier of the commissioning, and keeps the code it has elsewhere as it was typed', async () => {
      const target = await seed();
      const registered = await register(target);
      expect(await refusal(transfer(registered.id, 1, { commissioningDocumentVersionId: 'nope' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'commissioning_document_version_id' });
      expect(await refusal(transfer(registered.id, 1, { commissioningDocumentVersionId: PENDING }))).toMatchObject({ code: 'DOCUMENT_NOT_CLEAN', status: 422 });
      expect(await refusal(transfer(registered.id, 1, { commissioningDocumentVersionId: randomUUID() }))).toMatchObject({ detail: 'commissioning_document_version_id', extensions: { reason: 'NOT_FOUND' } });
      expect(await refusal(transfer(registered.id, 1, { transferredOn: '2026-12-19' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'transferred_on', extensions: { earliest: '2026-12-20', latest: '2026-12-20' } });
      expect(await refusal(transfer(registered.id, 1, { transferredOn: '2026-12-21' }))).toMatchObject({ detail: 'transferred_on' });
      expect(await refusal(transfer(registered.id, 1, { externalAssetId: ' ' }))).toMatchObject({ detail: 'external_asset_id' });
      expect(await refusal(transfer(registered.id, 9))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect((await refusal(transfer(registered.id, 1, {}, readOnly))).status).toBe(403);
      expect(await refusal(transfer(registered.id, 1, {}, invisible))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(transfer(randomUUID(), 1))).toMatchObject({ status: 404 });
      expect((await rowOf(registered.id))?.status).toBe('REGISTERED');

      const done = await transfer(registered.id, 1, { externalAssetId: 'TS-2027-009' });
      expect(done).toMatchObject({ fromStatus: 'REGISTERED', status: 'TRANSFERRED', version: 2, transferredOn: '2026-12-20', externalAssetId: 'TS-2027-009', registeredTotalVnd: '5000000000' });
      expect(await rowOf(registered.id)).toMatchObject({ status: 'TRANSFERRED', version: '2', transferred_on: '2026-12-20', transferred_by: memberId(OPERATOR), external_asset_id: 'TS-2027-009' });
      expect(await refusal(transfer(registered.id, 2))).toMatchObject({ code: 'ASSET_STATE_INVALID', status: 409, extensions: { status: 'TRANSFERRED' } });
    });

    it('does not transfer an asset whose handover is not accepted', async () => {
      const target = await seed();
      const registered = await register(target);
      await stage("update machvon.handover set status = 'REJECTED', rejection_reason = 'x', accepted_at = null, accepted_by = null where id = $1::uuid", [target.handoverId]);
      expect(await refusal(transfer(registered.id, 1))).toMatchObject({ code: 'HANDOVER_NOT_ACCEPTED', status: 422 });
    });
  });

  describe('what the database keeps', () => {
    it('lets the status move along the edges only, never deletes, and never changes what an asset is or how it was transferred', async () => {
      const target = await seed();
      const registered = await register(target, { assetCode: 'AS-KEPT' });
      const app = (sql: string) => as((tx) => tx.query(sql.replace('$a', `'${registered.id}'`)));
      expect((await databaseRefusal(app('delete from machvon.asset_record where id = $a::uuid'))).sqlstate).toBe('42501');
      expect(await databaseRefusal(app("update machvon.asset_record set asset_code = 'OTHER' where id = $a::uuid"))).toMatchObject({ sqlstate: '23514', message: expect.stringContaining('never changes') });
      expect(await databaseRefusal(app("update machvon.asset_record set status = 'IN_OPERATION' where id = $a::uuid"))).toMatchObject({ sqlstate: '23514', message: expect.stringContaining('ASSET_STATE_INVALID') });
      expect((await databaseRefusal(app("update machvon.asset_record set status = 'TRANSFERRED', transferred_on = date '2026-12-20' where id = $a::uuid"))).message).toContain('asset_record_transferred_chk');
      expect(await databaseRefusal(owner(`insert into machvon.asset_record (tenant_id, id, project_id, handover_id, asset_code, value_vnd, recipient_unit_id, status) values ($1, gen_random_uuid(), $2::uuid, $3::uuid, 'AS-DRAFT', 1, $4::uuid, 'DRAFT')`, [TENANT_A, target.projectId, target.handoverId, unitId(RECEIVER)]))).toMatchObject({
        message: expect.stringContaining('an asset is registered first'),
      });
      await transfer(registered.id, 1);
      expect(await databaseRefusal(app("update machvon.asset_record set transferred_on = date '2026-12-19' where id = $a::uuid"))).toMatchObject({ message: expect.stringContaining('does not change') });
      expect(await databaseRefusal(app("update machvon.asset_record set status = 'REGISTERED' where id = $a::uuid"))).toMatchObject({ sqlstate: '23514' });
    });
  });

  describe('reading', () => {
    it('lists the assets of the scope with what the assets of the contract come to, the newest first, and finds one by its id', async () => {
      const target = await seed();
      const first = await register(target, { assetCode: 'AS-R1', valueVnd: '3200000000' });
      const second = await register(target, { assetCode: 'AS-R2', valueVnd: '1800000000', recipientUnitId: unitId(OTHER_UNIT) });
      await transfer(first.id, 1, { externalAssetId: 'TS-1' });
      const lines = await as((tx) => assets.list(tx, allRows, { contractId: target.contractId, limit: 50 }));
      expect(lines.map((line) => line.assetCode)).toEqual(['AS-R2', 'AS-R1']);
      expect(lines[1]).toMatchObject({
        id: first.id,
        status: 'TRANSFERRED',
        valueVnd: '3200000000',
        contractAssetsVnd: '5000000000',
        contract: { id: target.contractId, valueVnd: CONTRACT_VALUE },
        handover: { id: target.handoverId, status: 'ACCEPTED' },
        recipientUnit: { id: unitId(RECEIVER), name: `Unit ${RECEIVER}` },
        externalAssetId: 'TS-1',
        transferredOn: '2026-12-20',
        reach: { contractId: target.contractId, recipientUnit: { id: unitId(RECEIVER), path: `/${unitId(RECEIVER)}/` } },
      });
      expect(lines[0]).toMatchObject({ id: second.id, status: 'REGISTERED', externalAssetId: null, recipientUnit: { id: unitId(OTHER_UNIT) } });
      const page = await as((tx) => assets.list(tx, allRows, { handoverId: target.handoverId, limit: 1 }));
      expect(page.map((line) => line.assetCode)).toEqual(['AS-R2']);
      const next = await as((tx) => assets.list(tx, allRows, { handoverId: target.handoverId, limit: 5, after: { code: page[0]?.createdAt ?? '', id: page[0]?.id ?? '' } }));
      expect(next.map((line) => line.assetCode)).toEqual(['AS-R1']);
      expect((await as((tx) => assets.list(tx, allRows, { contractId: target.contractId, status: 'REGISTERED', limit: 50 }))).map((line) => line.assetCode)).toEqual(['AS-R2']);
      expect(await as((tx) => assets.list(tx, noRows, { limit: 50 }))).toEqual([]);
      expect(await refusal(as((tx) => assets.list(tx, allRows, { status: 'BROKEN', limit: 5 })))).toMatchObject({ detail: 'status' });
      expect(await refusal(as((tx) => assets.list(tx, allRows, { limit: 0 })))).toMatchObject({ detail: 'limit' });
      expect(await refusal(as((tx) => assets.list(tx, allRows, { contractId: 'nope', limit: 5 })))).toMatchObject({ detail: 'contract_id' });
      expect(await refusal(as((tx) => assets.list(tx, allRows, { handoverId: 'nope', limit: 5 })))).toMatchObject({ detail: 'handover_id' });
      expect(await refusal(as((tx) => assets.list(tx, allRows, { limit: 5, after: { code: 'not a time', id: first.id } })))).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await as((tx) => assets.find(tx, first.id, allRows)))?.assetCode).toBe('AS-R1');
      expect(await as((tx) => assets.find(tx, first.id, noRows))).toBeUndefined();
      expect(await as((tx) => assets.find(tx, randomUUID(), allRows))).toBeUndefined();
    });
  });
});
