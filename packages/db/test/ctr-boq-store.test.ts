import { createHash, randomUUID } from 'node:crypto';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { CtrBoqStore } from '../src/ctr-boq-store';
import type { BoqImportResult } from '../src/ctr-boq-store';
import { CtrContractPartyStore } from '../src/ctr-contract-party-store';
import { CtrContractStore, contractScope } from '../src/ctr-contract-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';
import { seedCtrWorld } from './support/ctr-fixtures';
import type { CtrWorld } from './support/ctr-fixtures';

const harness = new AuthzHarness();
const contracts = new CtrContractStore();
const parties = new CtrContractPartyStore(contracts);
const boq = new CtrBoqStore();
const ACTOR = 1;
const TODAY = '2026-10-24';
const MANAGE = 'boq.manage';
const READ = 'boq_line.read';
// Units: 1 is the province (/u1/), 2 the department below it (/u1/u2/), 3 another branch (/u3/).
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const FAMILY = 0x93;
const NOW = new Date();

let world: CtrWorld;
let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(ACTOR)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

async function databaseRefusal(work: Promise<unknown>): Promise<{ sqlstate: string; message: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; message: string };
    return { sqlstate: e.code ?? '', message: e.message };
  }
  throw new Error('expected the database to refuse');
}

const grant = (permission: string, scope: Scope): EffectiveAccess => ({
  membershipId: memberId(ACTOR),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'TEST', rank: 10, permissions: [permission], scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const scopesOf = (manage: Scope, read: Scope): ContractScopes => ({ update: contractScope(grant(MANAGE, manage), MANAGE, NOW), read: contractScope(grant(READ, read), READ, NOW) });
const EVERYWHERE = scopesOf({ kind: 'TENANT' }, { kind: 'TENANT' });
const readEverywhere = contractScope(grant(READ, { kind: 'TENANT' }), READ, NOW);

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const line = (key: string, quantity = '3', unitPrice = '1234.5', extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  business_key: key,
  description: `Item ${key}`,
  unit_code: 'M3',
  quantity,
  unit_price: unitPrice,
  ...extra,
});

async function draft(value: string, extra: { isJointVenture?: boolean } = {}): Promise<{ id: string; revisionId: string }> {
  counter += 1;
  const created = await as((tx) =>
    contracts.create(
      tx,
      {
        projectId: world.project,
        packageId: world.packageId,
        contractorId: world.lead,
        code: `HD-B-${String(counter).padStart(3, '0')}`,
        title: 'Construction of the bridge',
        type: 'UNIT_PRICE',
        advanceCategory: 'CONSTRUCTION',
        contractValueVnd: value,
        documentVersionId: world.document,
        ...extra,
      },
      memberId(ACTOR),
      TODAY,
    ),
  );
  return { id: created.id, revisionId: created.revisionId };
}

const importInto = (
  revisionId: string,
  version: number,
  mode: string,
  lines: unknown,
  fileSha256?: string,
  scopes: ContractScopes = EVERYWHERE,
): Promise<BoqImportResult> => as((tx) => boq.importLines(tx, revisionId, version, { mode, lines, fileSha256 }, memberId(ACTOR), scopes));

const lineRows = (revisionId: string) =>
  owner<{ business_key: string; line_no: number; quantity: string; unit_price: string; amount_vnd: string; rounding_rule: string; retention_pct: string; boq_item_id: string }>(
    `select business_key, line_no, quantity::text as quantity, unit_price::text as unit_price, amount_vnd::text as amount_vnd, rounding_rule, retention_pct::text as retention_pct, boq_item_id
       from machvon.boq_line where contract_revision_id = $1::uuid order by line_no`,
    [revisionId],
  );
const items = (contractId: string) =>
  owner<{ id: string; business_key: string; unit_code: string; status: string; version: string }>('select id, business_key, unit_code, status, version::text as version from machvon.boq_item where contract_id = $1::uuid order by business_key', [contractId]);
const revisionVersion = async (revisionId: string): Promise<number> => Number((await owner<{ version: string }>('select version::text as version from machvon.contract_revision where id = $1::uuid', [revisionId]))[0]?.version);
const count = async (table: string, contractId: string): Promise<number> =>
  Number((await owner<{ n: number }>(`select count(*)::int as n from machvon.${table} where contract_id = $1::uuid`, [contractId]))[0]?.n);

describe('CtrBoqStore (stable BOQ items and versioned BOQ lines, ST-CTR-002)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: OTHER_BRANCH, path: '/u3/' },
      ]);
      await harness.seedMembership(tenant, ACTOR, PROVINCE);
      await harness.seedMembership(tenant, ACTOR + 1, PROVINCE);
    }
    world = await seedCtrWorld(harness.database.adminUrl, TENANT_A, FAMILY, ACTOR, DEPARTMENT, PROVINCE);
    await as((tx) => applyBaseline(tx, BASELINE_PACK, memberId(ACTOR)));
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the amount of a line and the total of a revision', () => {
    it('gives 3,704 half up and 3,703 down for 3 x 1,234.5, and the lines add up to the amount of the revision with a difference of 0 (AC-ST-CTR-002-1)', async () => {
      const contract = await draft('3704');
      const first = await importInto(contract.revisionId, 1, 'REPLACE', [line('B01', '3', '1234.5', { rounding_rule: 'HALF_UP' })]);
      expect(first).toMatchObject({ version: 2, mode: 'REPLACE', sourceKind: 'LINES', linesImported: 1, itemsCreated: 1, duplicate: false });
      expect(first.reconciliation).toEqual({ revisionAmountVnd: '3704', linesTotalVnd: '3704', differenceVnd: '0', lineCount: 1, matches: true });
      expect(await lineRows(contract.revisionId)).toEqual([expect.objectContaining({ business_key: 'B01', quantity: '3.000000', unit_price: '1234.500000', amount_vnd: '3704', rounding_rule: 'HALF_UP' })]);
      expect(await as((tx) => boq.assertBalanced(tx, contract.revisionId))).toMatchObject({ matches: true });

      const down = await importInto(contract.revisionId, 2, 'REPLACE', [line('B01', '3', '1234.5', { rounding_rule: 'DOWN' })]);
      expect(down.reconciliation).toEqual({ revisionAmountVnd: '3704', linesTotalVnd: '3703', differenceVnd: '-1', lineCount: 1, matches: false });
      expect(await lineRows(contract.revisionId)).toEqual([expect.objectContaining({ amount_vnd: '3703', rounding_rule: 'DOWN' })]);
      // The revision cannot leave the draft with a difference: the submit for review asks for the balance and is answered 422 BOQ_TOTAL_MISMATCH.
      expect(await refusal(as((tx) => boq.assertBalanced(tx, contract.revisionId)))).toEqual({
        code: 'BOQ_TOTAL_MISMATCH',
        status: 422,
        detail: 'lines',
        extensions: { lines_total_vnd: '3703', revision_amount_vnd: '3704', difference_vnd: '-1' },
      });
      await as((tx) => contracts.reviseDraft(tx, contract.id, 1, { contractValueVnd: '3703' }, memberId(ACTOR), EVERYWHERE));
      expect(await as((tx) => boq.assertBalanced(tx, contract.revisionId))).toMatchObject({ matches: true, differenceVnd: '0' });
    });

    it('does not accept a revision with no lines as balanced, and refuses lines that add up to more than the amount, writing nothing', async () => {
      const contract = await draft('1000');
      expect(await refusal(as((tx) => boq.assertBalanced(tx, contract.revisionId)))).toMatchObject({ code: 'BOQ_TOTAL_MISMATCH', extensions: { lines_total_vnd: '0', difference_vnd: '-1000' } });
      const over = await refusal(importInto(contract.revisionId, 1, 'REPLACE', [line('B01', '1', '600'), line('B02', '1', '401')]));
      expect(over).toMatchObject({ code: 'BOQ_TOTAL_MISMATCH', status: 422, extensions: { lines_total_vnd: '1001', revision_amount_vnd: '1000', difference_vnd: '1' } });
      expect(await count('boq_line', contract.id)).toBe(0);
      expect(await count('boq_item', contract.id)).toBe(0);
      expect(await count('boq_import', contract.id)).toBe(0);
      expect(await revisionVersion(contract.revisionId)).toBe(1);
      // An APPEND that would pass the amount is refused the same way, and the lines that are there stay.
      await importInto(contract.revisionId, 1, 'REPLACE', [line('B01', '1', '600')]);
      expect(await refusal(importInto(contract.revisionId, 2, 'APPEND', [line('B02', '1', '401')]))).toMatchObject({ code: 'BOQ_TOTAL_MISMATCH', extensions: { lines_total_vnd: '1001' } });
      expect((await lineRows(contract.revisionId)).map((row) => row.business_key)).toEqual(['B01']);
    });

    it('rounds every line by its own rule and keeps the retention of the line, the default being the labelled rule', async () => {
      const contract = await draft('16003');
      const result = await importInto(contract.revisionId, 1, 'REPLACE', [
        line('A', '2.5', '1', { rounding_rule: 'HALF_UP' }),
        line('B', '2.5', '1', { rounding_rule: 'DOWN', retention_pct: '10' }),
        line('C', '2.5', '1', { rounding_rule: 'UP', retention_pct: '0' }),
        line('D', '1', '15995', { retention_pct: '2.25' }),
      ]);
      expect(result.retentionDefaulted).toBe(1);
      expect(await lineRows(contract.revisionId)).toEqual([
        expect.objectContaining({ business_key: 'A', amount_vnd: '3', retention_pct: '5.0000', line_no: 1 }),
        expect.objectContaining({ business_key: 'B', amount_vnd: '2', retention_pct: '10.0000', line_no: 2 }),
        expect.objectContaining({ business_key: 'C', amount_vnd: '3', retention_pct: '0.0000', line_no: 3 }),
        expect.objectContaining({ business_key: 'D', amount_vnd: '15995', retention_pct: '2.2500', line_no: 4 }),
      ]);
      expect(result.reconciliation).toMatchObject({ linesTotalVnd: '16003', matches: true });
    });
  });

  describe('importing the same file twice (AC-ST-CTR-002-2)', () => {
    it('creates no second item or line for the same hash in APPEND mode and returns the first import', async () => {
      const contract = await draft('100000');
      const file = sha('boq-a.csv');
      const first = await importInto(contract.revisionId, 1, 'APPEND', [line('B01', '1', '1000'), line('B02', '2', '500')], file);
      expect(first).toMatchObject({ duplicate: false, sourceKind: 'FILE', sourceSha256: file, linesImported: 2, itemsCreated: 2, version: 2 });
      const second = await importInto(contract.revisionId, 2, 'APPEND', [line('B01', '1', '1000'), line('B02', '2', '500')], file);
      expect(second).toMatchObject({ duplicate: true, importId: first.importId, linesImported: 2, itemsCreated: 2, sourceSha256: file, version: 2 });
      expect(await count('boq_line', contract.id)).toBe(2);
      expect(await count('boq_item', contract.id)).toBe(2);
      expect(await count('boq_import', contract.id)).toBe(1);
      expect(await revisionVersion(contract.revisionId)).toBe(2);
    });

    it('recognises the same lines without a file by their hash, and a different file as a new import', async () => {
      const contract = await draft('100000');
      const first = await importInto(contract.revisionId, 1, 'APPEND', [line('B01', '1', '1000')]);
      expect(first).toMatchObject({ sourceKind: 'LINES', duplicate: false });
      const again = await importInto(contract.revisionId, 2, 'APPEND', [line('B01', '1.0', '1000.0')]);
      expect(again).toMatchObject({ duplicate: true, importId: first.importId, sourceSha256: first.sourceSha256 });
      const other = await importInto(contract.revisionId, 2, 'APPEND', [line('B02', '1', '1000')], sha('other.csv'));
      expect(other).toMatchObject({ duplicate: false, sourceKind: 'FILE', version: 3 });
      expect(await count('boq_line', contract.id)).toBe(2);
    });

    it('answers a repeated REPLACE only while nothing has changed since, and puts the lines back when something has', async () => {
      const contract = await draft('100000');
      const file = sha('replace.csv');
      const first = await importInto(contract.revisionId, 1, 'REPLACE', [line('B01', '1', '1000')], file);
      expect(await importInto(contract.revisionId, 2, 'REPLACE', [line('B01', '1', '1000')], file)).toMatchObject({ duplicate: true, importId: first.importId });
      await importInto(contract.revisionId, 2, 'APPEND', [line('B02', '1', '2000')], sha('more.csv'));
      expect((await lineRows(contract.revisionId)).map((row) => row.business_key)).toEqual(['B01', 'B02']);
      const again = await importInto(contract.revisionId, 3, 'REPLACE', [line('B01', '1', '1000')], file);
      expect(again).toMatchObject({ duplicate: false, linesImported: 1, version: 4 });
      expect((await lineRows(contract.revisionId)).map((row) => row.business_key)).toEqual(['B01']);
      // The file of an APPEND that was replaced away is not "in force" any more: it can be appended again.
      const back = await importInto(contract.revisionId, 4, 'APPEND', [line('B02', '1', '2000')], sha('more.csv'));
      expect(back.duplicate).toBe(false);
      expect(await count('boq_line', contract.id)).toBe(2);
    });

    it('refuses an APPEND that names a key the revision already has with BOQ_LINE_DUPLICATE and the rows, writing nothing', async () => {
      const contract = await draft('100000');
      await importInto(contract.revisionId, 1, 'REPLACE', [line('B01', '1', '1000'), line('B02', '1', '1000')]);
      expect(await refusal(importInto(contract.revisionId, 2, 'APPEND', [line('B03', '1', '1000'), line('B02', '2', '1000')], sha('x.csv')))).toEqual({
        code: 'BOQ_LINE_DUPLICATE',
        status: 409,
        detail: 'lines',
        extensions: { rows: [2] },
      });
      expect(await count('boq_line', contract.id)).toBe(2);
      expect(await count('boq_import', contract.id)).toBe(1);
    });
  });

  describe('stable items across the revisions', () => {
    async function activeWithAmendment(): Promise<{ id: string; revisionId: string; amendmentId: string }> {
      const contract = await draft('50000');
      await importInto(contract.revisionId, 1, 'REPLACE', [line('B01', '10', '3000'), line('B02', '10', '2000')]);
      await owner("update machvon.contract set status = 'IN_REVIEW' where id = $1::uuid", [contract.id]);
      await owner("update machvon.contract set status = 'SIGNED', signed_on = date '2026-10-25' where id = $1::uuid", [contract.id]);
      await owner("update machvon.contract set status = 'ACTIVE', effective_from = date '2026-10-26' where id = $1::uuid", [contract.id]);
      await owner("update machvon.contract_revision set status = 'EFFECTIVE', decided_by = $2::uuid, decided_at = now() where id = $1::uuid", [contract.revisionId, memberId(ACTOR)]);
      const amendmentId = randomUUID();
      await owner(
        `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, 2, 60000, $3::uuid, date '2026-11-01', 'DRAFT', 'AMENDMENT', 1, $4::uuid, $4::uuid)`,
        [amendmentId, contract.id, world.document, memberId(ACTOR)],
      );
      return { ...contract, amendmentId };
    }

    it('prices the same items again in an amendment: the items are the same rows, each revision has its own price', async () => {
      const contract = await activeWithAmendment();
      const before = await items(contract.id);
      expect(before.map((item) => item.business_key)).toEqual(['B01', 'B02']);
      const result = await importInto(contract.amendmentId, 1, 'REPLACE', [line('B01', '10', '3500'), line('B02', '10', '2000'), line('B03', '5', '1000')]);
      expect(result).toMatchObject({ itemsCreated: 1, linesImported: 3 });
      expect(result.reconciliation).toMatchObject({ linesTotalVnd: '60000', matches: true });
      const after = await items(contract.id);
      expect(after.map((item) => item.business_key)).toEqual(['B01', 'B02', 'B03']);
      expect(after.slice(0, 2).map((item) => item.id)).toEqual(before.map((item) => item.id));
      expect((await lineRows(contract.amendmentId)).map((row) => row.boq_item_id).slice(0, 2)).toEqual(before.map((item) => item.id));
      expect((await lineRows(contract.revisionId)).map((row) => row.amount_vnd)).toEqual(['30000', '20000']);
      expect((await lineRows(contract.amendmentId)).map((row) => row.amount_vnd)).toEqual(['35000', '20000', '5000']);
    });

    it('does not let a priced item change its unit: a different unit is a different item', async () => {
      const contract = await activeWithAmendment();
      const refused = await refusal(importInto(contract.amendmentId, 1, 'REPLACE', [line('B01', '10', '3000', { unit_code: 'M2' }), line('B02', '10', '2000')]));
      expect(refused).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'lines', extensions: { errors: [{ row: 1, field: 'unit_code', reason: 'unitChanged' }], error_rows: 1 } });
      expect(await count('boq_line', contract.id)).toBe(2);
      expect((await items(contract.id)).map((item) => item.unit_code)).toEqual(['M3', 'M3']);
    });

    it('lets a draft be put right: the unit of an item no other revision prices is corrected by a REPLACE, and an item left without a line is cancelled and comes back when named again', async () => {
      const contract = await draft('10000');
      await importInto(contract.revisionId, 1, 'REPLACE', [line('B01', '1', '4000', { unit_code: 'M2' }), line('B02', '1', '6000')]);
      const corrected = await importInto(contract.revisionId, 2, 'REPLACE', [line('B01', '1', '4000', { unit_code: 'M3' }), line('B03', '1', '6000')]);
      expect(corrected).toMatchObject({ itemsCreated: 1 });
      expect((await items(contract.id)).map((item) => `${item.business_key}:${item.unit_code}:${item.status}`)).toEqual(['B01:M3:ACTIVE', 'B02:M3:CANCELLED', 'B03:M3:ACTIVE']);
      await importInto(contract.revisionId, 3, 'REPLACE', [line('B01', '1', '4000'), line('B02', '1', '6000')]);
      expect((await items(contract.id)).map((item) => `${item.business_key}:${item.status}`)).toEqual(['B01:ACTIVE', 'B02:ACTIVE', 'B03:CANCELLED']);
    });
  });

  describe('the rows are judged against master data and the contract', () => {
    it('names the unit that master data does not know and keeps every other fault of the file with it', async () => {
      const contract = await draft('10000');
      const refused = await refusal(importInto(contract.revisionId, 1, 'REPLACE', [line('B01', '1', '1', { unit_code: 'PARSEC' }), line('B02', '1', '1', { unit_code: 'KG' })]));
      expect(refused).toMatchObject({ code: 'VALIDATION_FAILED', extensions: { errors: [{ row: 1, field: 'unit_code', reason: 'unitUnknown' }], error_rows: 1 } });
      expect(await count('boq_line', contract.id)).toBe(0);
      const syntax = await refusal(importInto(contract.revisionId, 1, 'REPLACE', [line('B01', 'x'), line('B01')]));
      expect(syntax).toMatchObject({ extensions: { errors: [{ row: 1, field: 'quantity', reason: 'invalidNumber' }, { row: 2, field: 'business_key', reason: 'duplicateKey' }], error_rows: 2 } });
    });

    it('assigns a line to a member of the joint venture and refuses one that is not a member', async () => {
      const contract = await draft('10000000000', { isJointVenture: true });
      await as((tx) =>
        parties.replace(
          tx,
          contract.id,
          1,
          [
            { contractorId: world.lead, role: 'LEAD', sharePct: '60', workValueVnd: '6000000000' },
            { contractorId: world.second, role: 'MEMBER', sharePct: '40', workValueVnd: '4000000000' },
          ],
          memberId(ACTOR),
          EVERYWHERE,
          TODAY,
        ),
      );
      const version = await revisionVersion(contract.revisionId);
      const stranger = '00000000-0000-4000-8000-000000000999';
      expect(await refusal(importInto(contract.revisionId, version, 'REPLACE', [line('B01', '1', '1000', { party_contractor_id: stranger })]))).toMatchObject({
        extensions: { errors: [{ row: 1, field: 'party_contractor_id', reason: 'partyUnknown' }] },
      });
      await importInto(contract.revisionId, version, 'REPLACE', [
        line('B01', '1', '6000000000', { party_contractor_id: world.lead.toUpperCase() }),
        line('B02', '1', '4000000000', { party_contractor_id: world.second }),
      ]);
      const rows = await owner<{ business_key: string; contractor_id: string }>(
        'select l.business_key, p.contractor_id from machvon.boq_line l join machvon.contract_party p on p.tenant_id = l.tenant_id and p.id = l.party_id where l.contract_revision_id = $1::uuid order by l.line_no',
        [contract.revisionId],
      );
      expect(rows).toEqual([
        { business_key: 'B01', contractor_id: world.lead },
        { business_key: 'B02', contractor_id: world.second },
      ]);
    });
  });

  describe('who may import into which revision, and when', () => {
    it('refuses a revision that is not a draft with REVISION_NOT_DRAFT, a contract in review, a stale version, a bad mode and a bad hash', async () => {
      const contract = await draft('10000');
      await importInto(contract.revisionId, 1, 'REPLACE', [line('B01', '1', '1000')]);
      expect(await refusal(importInto(contract.revisionId, 1, 'REPLACE', [line('B01', '1', '1000')]))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 2 } });
      expect(await refusal(importInto(contract.revisionId, 2, 'MERGE', [line('B01')]))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'mode' });
      expect(await refusal(importInto(contract.revisionId, 2, 'APPEND', [line('B02')], 'ABC'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'file_sha256' });
      await owner("update machvon.contract set status = 'IN_REVIEW' where id = $1::uuid", [contract.id]);
      expect(await refusal(importInto(contract.revisionId, 2, 'APPEND', [line('B02')]))).toEqual({ code: 'CONTRACT_STATE_INVALID', status: 409 });
      await owner("update machvon.contract set status = 'DRAFT' where id = $1::uuid", [contract.id]);
      await owner("update machvon.contract_revision set status = 'REJECTED' where id = $1::uuid", [contract.revisionId]);
      expect(await refusal(importInto(contract.revisionId, 2, 'APPEND', [line('B02')]))).toEqual({ code: 'REVISION_NOT_DRAFT', status: 422 });
      expect(await count('boq_line', contract.id)).toBe(1);
    });

    it('lets the change of a contract in force be drafted only on an ACTIVE or SUSPENDED contract, never the base revision of one that left the draft', async () => {
      const contract = await draft('10000');
      await owner("update machvon.contract set status = 'IN_REVIEW' where id = $1::uuid", [contract.id]);
      await owner("update machvon.contract set status = 'SIGNED', signed_on = date '2026-10-25' where id = $1::uuid", [contract.id]);
      expect(await refusal(importInto(contract.revisionId, 1, 'REPLACE', [line('B01', '1', '1000')]))).toEqual({ code: 'CONTRACT_STATE_INVALID', status: 409 });
    });

    it('answers 404 for a revision outside the read scope and 403 for one that can be read but not managed, and writes nothing', async () => {
      const contract = await draft('10000');
      const outside = scopesOf({ kind: 'UNIT_SUBTREE', refIds: [unitId(OTHER_BRANCH)] }, { kind: 'UNIT_SUBTREE', refIds: [unitId(OTHER_BRANCH)] });
      expect(await refusal(importInto(contract.revisionId, 1, 'REPLACE', [line('B01', '1', '1000')], undefined, outside))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const readOnly = scopesOf({ kind: 'UNIT_SUBTREE', refIds: [unitId(OTHER_BRANCH)] }, { kind: 'TENANT' });
      expect(await refusal(importInto(contract.revisionId, 1, 'REPLACE', [line('B01', '1', '1000')], undefined, readOnly))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(importInto('00000000-0000-4000-8000-000000000998', 1, 'REPLACE', [line('B01')]))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await count('boq_line', contract.id)).toBe(0);
    });

    it('does not see the revision of another tenant', async () => {
      const contract = await draft('10000');
      expect(await refusal(as((tx) => boq.importLines(tx, contract.revisionId, 1, { mode: 'REPLACE', lines: [line('B01')] }, memberId(ACTOR), EVERYWHERE), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => boq.reconcile(tx, contract.revisionId), TENANT_B))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('reading the lines', () => {
    it('lists the lines in the order of the contract, the revision and the line, with a cursor, a filter, the member and the reach', async () => {
      const contract = await draft('5000');
      await importInto(contract.revisionId, 1, 'REPLACE', [line('B01', '1', '1000'), line('B02', '2', '1000'), line('B03', '1', '2000')]);
      const all = await as((tx) => boq.list(tx, readEverywhere, { limit: 500, after: undefined }, { revisionId: contract.revisionId }));
      expect(all.map((row) => [row.businessKey, row.lineNo, row.amountVnd, row.quantity, row.unitPrice, row.revisionStatus])).toEqual([
        ['B01', 1, '1000', '1', '1000', 'DRAFT'],
        ['B02', 2, '2000', '2', '1000', 'DRAFT'],
        ['B03', 3, '2000', '1', '2000', 'DRAFT'],
      ]);
      expect(all[0]).toMatchObject({ contractId: contract.id, revisionId: contract.revisionId, revision: 1, unitCode: 'M3', roundingRule: 'HALF_UP', retentionPct: '5.0000', partyId: null, partyName: null });
      expect(all[0]?.reach).toMatchObject({ contractId: contract.id, ownerUnit: { path: '/u1/u2/' }, investorUnit: { path: '/u1/' } });
      const first = await as((tx) => boq.list(tx, readEverywhere, { limit: 2, after: undefined }, { contractId: contract.id }));
      expect(first).toHaveLength(2);
      const last = first[1];
      if (last === undefined) throw new Error('a second line was expected');
      const rest = await as((tx) => boq.list(tx, readEverywhere, { limit: 2, after: { code: last.key, id: last.id } }, { contractId: contract.id }));
      expect(rest.map((row) => row.businessKey)).toEqual(['B03']);
      expect(await as((tx) => boq.find(tx, last.id, readEverywhere))).toMatchObject({ id: last.id, businessKey: 'B02' });
      expect(await as((tx) => boq.list(tx, readEverywhere, { limit: 10, after: undefined }, { revisionId: '00000000-0000-4000-8000-000000000997' }))).toEqual([]);
    });

    it('hides the lines outside the scope and of another tenant', async () => {
      const contract = await draft('2000');
      await importInto(contract.revisionId, 1, 'REPLACE', [line('B01', '1', '2000')]);
      const elsewhere = contractScope(grant(READ, { kind: 'UNIT_SUBTREE', refIds: [unitId(OTHER_BRANCH)] }), READ, NOW);
      expect(await as((tx) => boq.list(tx, elsewhere, { limit: 50, after: undefined }, { contractId: contract.id }))).toEqual([]);
      const one = await as((tx) => boq.list(tx, readEverywhere, { limit: 1, after: undefined }, { contractId: contract.id }));
      const lineId = one[0]?.id ?? '';
      expect(await as((tx) => boq.find(tx, lineId, elsewhere))).toBeUndefined();
      expect(await as((tx) => boq.find(tx, lineId, readEverywhere), TENANT_B)).toBeUndefined();
      const asContract = contractScope(grant(READ, { kind: 'CONTRACT', refIds: [contract.id] }), READ, NOW);
      expect(await as((tx) => boq.find(tx, lineId, asContract))).toMatchObject({ id: lineId });
    });
  });

  describe('what the database holds whoever writes', () => {
    it('refuses an amount that is not the rounded product, a line in a revision that is not a draft, and a change of the revision or the item of a line', async () => {
      const contract = await draft('5000');
      await importInto(contract.revisionId, 1, 'REPLACE', [line('B01', '2', '2500')]);
      const lineId = (await owner<{ id: string }>('select id from machvon.boq_line where contract_revision_id = $1::uuid', [contract.revisionId]))[0]?.id ?? '';
      expect((await databaseRefusal(owner('update machvon.boq_line set amount_vnd = 4999 where id = $1::uuid', [lineId]))).message).toContain('boq_line_amount_chk');
      expect((await databaseRefusal(owner("update machvon.boq_line set unit_code = 'KG' where id = $1::uuid", [lineId]))).message).toContain('belongs to the contract, the key and the unit');
      expect(await databaseRefusal(owner('update machvon.boq_line set boq_item_id = gen_random_uuid() where id = $1::uuid', [lineId]))).toMatchObject({ sqlstate: '23514', message: 'a BOQ line keeps its revision and its item' });
      expect((await databaseRefusal(owner('update machvon.boq_line set contract_revision_id = gen_random_uuid() where id = $1::uuid', [lineId]))).sqlstate).toBe('23503');
      await owner("update machvon.contract_revision set status = 'REJECTED' where id = $1::uuid", [contract.revisionId]);
      expect(await databaseRefusal(owner('update machvon.boq_line set description = $2 where id = $1::uuid', [lineId, 'Changed']))).toMatchObject({ sqlstate: '23514', message: 'REVISION_NOT_DRAFT' });
      expect(await databaseRefusal(owner('delete from machvon.boq_line where id = $1::uuid', [lineId]))).toMatchObject({ sqlstate: '23514', message: 'REVISION_NOT_DRAFT' });
    });

    it('keeps the key and the contract of an item for good and its unit once a line prices it, and lets neither the item nor the record of an import be deleted by the runtime role', async () => {
      const contract = await draft('5000');
      const result = await importInto(contract.revisionId, 1, 'REPLACE', [line('B01', '2', '2500')]);
      const item = (await items(contract.id))[0];
      if (item === undefined) throw new Error('an item was expected');
      expect((await databaseRefusal(owner("update machvon.boq_item set business_key = 'B09' where id = $1::uuid", [item.id]))).message).toContain('keeps its key');
      expect((await databaseRefusal(owner("update machvon.boq_item set unit_code = 'KG' where id = $1::uuid", [item.id]))).message).toContain('keeps its unit');
      await owner("update machvon.boq_item set status = 'CANCELLED' where id = $1::uuid", [item.id]);
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.boq_item where id = $1::uuid', [item.id])))).sqlstate).toBe('42501');
      expect((await databaseRefusal(as((tx) => tx.query('update machvon.boq_import set lines_imported = 9 where id = $1::uuid', [result.importId])))).sqlstate).toBe('42501');
      expect((await databaseRefusal(as((tx) => tx.query('delete from machvon.boq_import where id = $1::uuid', [result.importId])))).sqlstate).toBe('42501');
    });

    it('refuses an item or a line with a text that is blank or not trimmed, a line number twice, and a line that is not of the contract of its revision', async () => {
      const first = await draft('5000');
      const second = await draft('5000');
      await importInto(first.revisionId, 1, 'REPLACE', [line('B01', '2', '2500')]);
      const lineId = (await owner<{ id: string }>('select id from machvon.boq_line where contract_revision_id = $1::uuid', [first.revisionId]))[0]?.id ?? '';
      expect((await databaseRefusal(owner("update machvon.boq_line set milestone_code = ' x' where id = $1::uuid", [lineId]))).message).toContain('boq_line_text_chk');
      expect((await databaseRefusal(owner("update machvon.boq_line set description = '' where id = $1::uuid", [lineId]))).message).toContain('boq_line_text_chk');
      expect((await databaseRefusal(owner("insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by) values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, ' B2', 'x', 'M3', $2::uuid, $2::uuid)", [first.id, memberId(ACTOR)]))).message).toContain('boq_item_text_chk');
      const foreignItem = (await owner<{ id: string }>('select id from machvon.boq_item where contract_id = $1::uuid', [first.id]))[0]?.id ?? '';
      const insert = `insert into machvon.boq_line (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, created_by)
                      values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4, 'B01', 'x', 'M3', 1, 1, 'HALF_UP', 1, $5::uuid)`;
      expect((await databaseRefusal(owner(insert, [second.revisionId, second.id, foreignItem, 1, memberId(ACTOR)]))).message).toContain('belongs to the contract, the key and the unit');
      expect((await databaseRefusal(owner(insert, [first.revisionId, first.id, foreignItem, 1, memberId(ACTOR)]))).sqlstate).toBe('23505');
    });
  });
});
