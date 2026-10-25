import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { fileSha256 } from '@machvon/kernel';
import { BidLinkReads } from '../src/bid-link-reads';
import { BidMilestoneStore } from '../src/bid-milestone-store';
import { BidProcurementImport, ProcurementImportAdapter } from '../src/bid-procurement-import';
import { previewFileImport } from '../src/file-import-preview';
import { FileImportStore } from '../src/file-import-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, id, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const milestones = new BidMilestoneStore();
const batches = new BidProcurementImport();
const imports = new FileImportStore();
const links = new BidLinkReads();
const PLANNER = 1;
const OFFICER = 2;
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const FAMILY = 0x95;
const NOW = new Date('2026-10-25T03:00:00Z');

const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });
const as = <T>(work: (tx: TenantTx) => Promise<T>, member = PLANNER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const sqlState = async (work: Promise<unknown>): Promise<{ sqlstate: string; message: string }> => {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; message: string };
    return { sqlstate: e.code ?? '', message: e.message };
  }
  throw new Error('expected the database to refuse');
};

async function seedAs(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

let counter = 0;
const next = (prefix: string): string => `${prefix}-${String((counter += 1)).padStart(4, '0')}`;

interface Seeded {
  projectId: string;
  projectCode: string;
  packageId: string;
  packageCode: string;
}

/** A project with one package in the given status; its creator is the planner. */
async function seedPackage(options: { status?: string; unit?: number; projectId?: string; projectCode?: string; code?: string; createdBy?: string | null } = {}): Promise<Seeded> {
  const projectId = options.projectId ?? randomUUID();
  const projectCode = options.projectCode ?? next('PRJ');
  const packageId = randomUUID();
  const packageCode = options.code ?? next('GT');
  const statements: Array<[string, unknown[]]> = [];
  if (options.projectId === undefined) {
    statements.push([
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, 'Procurement project', $4, $5, $6, 'INTERNAL', 1000, 'IMPLEMENTATION', 1, 'B')`,
      [TENANT_A, projectId, projectCode, unitId(options.unit ?? DEPARTMENT), unitId(PROVINCE), id(FAMILY, 90)],
    ]);
  }
  statements.push([
    `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, title, created_by, version)
     values ($1, $2, $3, $4, 1000, 'OPEN_BIDDING', 1, $5, 'Construction package', $6, 1)`,
    [TENANT_A, packageId, projectId, packageCode, options.status ?? 'PLANNED', options.createdBy === undefined ? memberId(PLANNER) : options.createdBy],
  ]);
  await seedAs(statements);
  return { projectId, projectCode, packageId, packageCode };
}

const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));
const HEADER = 'package_code,external_code,milestone_kind,actual_at';
const PAST = '2026-09-01T03:00:00.000Z';

const record = (seeded: Seeded, version: number, body: { kind: string; plannedAt?: string; actualAt?: string }, scope: ScopeBuilder = everything, member = PLANNER) =>
  as((tx) => milestones.record(tx, { packageId: seeded.packageId, expectedVersion: version, kind: body.kind as never, plannedAt: body.plannedAt, actualAt: body.actualAt }, memberId(member), scope, NOW), member);

const adapterFor = (scope: ScopeBuilder = everything, batchId?: string) => new ProcurementImportAdapter({ scope, actor: memberId(OFFICER), now: NOW, batchId });

/** Applies a file the way the command does: the batch is opened, the rows are applied through the framework and the batch is closed with the counts. */
async function applyFile(bytes: Uint8Array, scope: ScopeBuilder = everything) {
  return as(async (tx) => {
    const batchId = await batches.begin(tx, { fileSha256: fileSha256(bytes), fileObjectKey: `tenants/${TENANT_A}/import/${randomUUID()}.csv`, actor: memberId(OFFICER) });
    const adapter = adapterFor(scope, batchId);
    const result = await imports.run(tx, { adapter, bytes, fileObjectKey: `tenants/${TENANT_A}/import/key.csv`, importedBy: memberId(OFFICER), fallbackOwnerId: memberId(OFFICER), correlationId: randomUUID(), now: NOW });
    if (result.outcome === 'APPLIED') {
      const refused = await imports.quarantined(tx, result.importId, 100);
      await batches.finish(tx, batchId, { rowsTotal: result.counts.total, rowsOk: result.counts.applied, rowsError: result.counts.quarantined, errors: refused.map((row) => ({ line: row.line, code: row.errorCode })) }, memberId(OFFICER));
    }
    return { result, adapter, batchId };
  }, OFFICER);
}

const milestoneRows = (packageId: string) =>
  owner<{ milestone_kind: string; planned_at: string | null; actual_at: string | null; source: string; import_batch_id: string | null; version: string }>(
    `select milestone_kind, to_char(planned_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as planned_at, to_char(actual_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as actual_at, source, import_batch_id, version::text as version
       from machvon.procurement_milestone where package_id = $1::uuid order by milestone_kind`,
    [packageId],
  );
const linkRow = async (packageId: string) =>
  (
    await owner<{ external_code: string; diff_status: string; diff_json: Record<string, unknown>; diff_owner_user_id: string | null; last_batch_id: string | null }>(
      'select external_code, diff_status, diff_json, diff_owner_user_id, last_batch_id from machvon.procurement_external_link where package_id = $1::uuid',
      [packageId],
    )
  )[0];
const packageVersion = async (packageId: string) => Number((await owner<{ version: string }>('select version::text as version from machvon.procurement_package where id = $1::uuid', [packageId]))[0]?.version);

describe('the milestones of a package and the file of the national bidding system (ST-BID-005)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [
      { n: PROVINCE, path: '/u1/' },
      { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
      { n: OTHER_BRANCH, path: '/u3/' },
    ]);
    await harness.seedMembership(TENANT_A, PLANNER, PROVINCE);
    await harness.seedMembership(TENANT_A, OFFICER, PROVINCE);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('recordProcurementMilestone', () => {
    it('records the planned and the actual date by hand, keeps the other date when one is left out, bumps the version of the package and stays MANUAL', async () => {
      const seeded = await seedPackage();
      const first = await record(seeded, 1, { kind: 'INVITATION_PUBLISHED', plannedAt: '2026-08-01T00:00:00Z' });
      expect(first).toMatchObject({ packageId: seeded.packageId, kind: 'INVITATION_PUBLISHED', plannedAt: '2026-08-01T00:00:00.000Z', actualAt: null, source: 'MANUAL', version: 2, created: true, previous: null });
      const second = await record(seeded, 2, { kind: 'INVITATION_PUBLISHED', actualAt: '2026-08-02T01:00:00+07:00' });
      expect(second).toMatchObject({ plannedAt: '2026-08-01T00:00:00.000Z', actualAt: '2026-08-01T18:00:00.000Z', version: 3, created: false, previous: { plannedAt: '2026-08-01T00:00:00.000Z', actualAt: null, source: 'MANUAL' } });
      expect(await milestoneRows(seeded.packageId)).toEqual([
        { milestone_kind: 'INVITATION_PUBLISHED', planned_at: '2026-08-01T00:00:00.000Z', actual_at: '2026-08-01T18:00:00.000Z', source: 'MANUAL', import_batch_id: null, version: '2' },
      ]);
      expect(await packageVersion(seeded.packageId)).toBe(3);
    });

    it('refuses a stale version with 409 VERSION_CONFLICT and writes nothing', async () => {
      const seeded = await seedPackage();
      expect(await refusal(record(seeded, 7, { kind: 'BID_CLOSING', actualAt: PAST }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await milestoneRows(seeded.packageId)).toEqual([]);
    });

    it('refuses a date that breaks the order of the milestones with 409 MILESTONE_ORDER_INVALID naming the two kinds (UAT-AC454 step order)', async () => {
      const seeded = await seedPackage();
      await record(seeded, 1, { kind: 'BID_OPENING', actualAt: '2026-09-10T03:00:00Z' });
      const closingAfterOpening = await refusal(record(seeded, 2, { kind: 'BID_CLOSING', actualAt: '2026-09-11T03:00:00Z' }));
      expect(closingAfterOpening).toEqual({ code: 'MILESTONE_ORDER_INVALID', status: 409, detail: 'actual_at', extensions: { field: 'actual_at', earlier_kind: 'BID_CLOSING', later_kind: 'BID_OPENING' } });
      const invitationAfterOpening = await refusal(record(seeded, 2, { kind: 'INVITATION_PUBLISHED', actualAt: '2026-09-20T03:00:00Z' }));
      expect(invitationAfterOpening).toMatchObject({ code: 'MILESTONE_ORDER_INVALID', extensions: { earlier_kind: 'INVITATION_PUBLISHED', later_kind: 'BID_OPENING' } });
      // The same moment is allowed, and the version did not move for the refusals.
      await expect(record(seeded, 2, { kind: 'BID_CLOSING', actualAt: '2026-09-10T03:00:00Z' })).resolves.toMatchObject({ version: 3 });
    });

    it('refuses a shape that is not a date-time, a milestone with no date, a kind that is not one and an actual date in the future with 422', async () => {
      const seeded = await seedPackage();
      for (const body of [
        { kind: 'BID_OPENING', actualAt: '2026-09-10' },
        { kind: 'BID_OPENING', actualAt: '10/09/2026' },
        { kind: 'BID_OPENING', actualAt: 'tomorrow' },
        { kind: 'BID_OPENING', plannedAt: '2026-09-10T10:00' },
        { kind: 'BID_OPENING' },
        { kind: 'SIGNING', actualAt: PAST },
        { kind: 'BID_OPENING', actualAt: '2026-10-26T03:00:00Z' },
      ]) {
        expect(await refusal(record(seeded, 1, body))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
      }
      expect(await milestoneRows(seeded.packageId)).toEqual([]);
    });

    it('refuses a package whose plan is not in force with 409 PACKAGE_STATE_INVALID, and one outside the scope or of nobody with 404', async () => {
      for (const status of ['DRAFT', 'IN_REVIEW', 'SUPERSEDED', 'CANCELLED']) {
        const seeded = await seedPackage({ status });
        expect(await refusal(record(seeded, 1, { kind: 'BID_OPENING', actualAt: PAST }))).toEqual({ code: 'PACKAGE_STATE_INVALID', status: 409, detail: 'package_id', extensions: { package_status: status } });
      }
      const live = await seedPackage();
      expect(await refusal(record(live, 1, { kind: 'BID_OPENING', actualAt: PAST }, nothing))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => milestones.record(tx, { packageId: randomUUID(), expectedVersion: 1, kind: 'BID_OPENING', actualAt: PAST }, memberId(PLANNER), everything, NOW)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('lists the milestones of the packages in the scope, by package code and the order of the milestones', async () => {
      const seeded = await seedPackage();
      await record(seeded, 1, { kind: 'BID_OPENING', actualAt: PAST });
      await record(seeded, 2, { kind: 'INVITATION_PUBLISHED', actualAt: '2026-08-01T00:00:00Z' });
      const lines = await as((tx) => milestones.list(tx, everything, { packageId: seeded.packageId }));
      expect(lines.map((line) => [line.kind, line.source, line.actualAt])).toEqual([
        ['INVITATION_PUBLISHED', 'MANUAL', '2026-08-01T00:00:00.000Z'],
        ['BID_OPENING', 'MANUAL', PAST],
      ]);
      expect(await as((tx) => milestones.list(tx, nothing, { packageId: seeded.packageId }))).toEqual([]);
      expect((await as((tx) => milestones.list(tx, everything, { projectId: seeded.projectId }))).length).toBe(2);
    });
  });

  describe('the file of the national bidding system', () => {
    it('AC-ST-BID-005-1, UAT-AC454: a dry run says rows_ok=2 and rows_error=1 PACKAGE_NOT_FOUND and writes nothing; the apply writes 2 IMPORT milestones with IN_SYNC links; the same file again is not applied', async () => {
      const one = await seedPackage();
      const two = await seedPackage();
      const bytes = csv(HEADER, `${one.packageCode},TBMT-${one.packageCode},BID_OPENING,2026-09-01`, `${two.packageCode},TBMT-${two.packageCode},RESULT_PUBLISHED,2026-09-15`, 'GT-NOT-THERE,TBMT-X,BID_OPENING,2026-09-01');

      const preview = await as((tx) => previewFileImport(tx, adapterFor(), bytes));
      expect(preview.counts).toMatchObject({ total: 3, valid: 2, errors: 1 });
      expect(preview.alreadyApplied).toBe(false);
      expect(preview.rows.map((row) => [row.line, row.status, row.code ?? row.outcome])).toEqual([
        [2, 'VALID', 'CREATE'],
        [3, 'VALID', 'CREATE'],
        [4, 'ERROR', 'PACKAGE_NOT_FOUND'],
      ]);
      // Nothing is written by a dry run: no batch, no milestone, no link, no claim of the file.
      expect((await owner('select 1 from machvon.procurement_import_batch where file_sha256 = $1', [fileSha256(bytes)])).length).toBe(0);
      expect(await milestoneRows(one.packageId)).toEqual([]);
      expect(await linkRow(one.packageId)).toBeUndefined();
      expect((await owner('select 1 from machvon.file_import where file_sha256 = $1', [fileSha256(bytes)])).length).toBe(0);

      const applied = await applyFile(bytes);
      expect(applied.result.outcome).toBe('APPLIED');
      expect(applied.result.counts).toMatchObject({ total: 3, applied: 2, quarantined: 1 });
      expect(applied.adapter.imported.map((entry) => [entry.packageCode, entry.kind, entry.action])).toEqual([
        [one.packageCode, 'BID_OPENING', 'CREATED'],
        [two.packageCode, 'RESULT_PUBLISHED', 'CREATED'],
      ]);
      expect(await milestoneRows(one.packageId)).toEqual([
        { milestone_kind: 'BID_OPENING', planned_at: null, actual_at: '2026-08-31T17:00:00.000Z', source: 'IMPORT', import_batch_id: applied.batchId, version: '1' },
      ]);
      expect(await milestoneRows(two.packageId)).toMatchObject([{ milestone_kind: 'RESULT_PUBLISHED', source: 'IMPORT', import_batch_id: applied.batchId }]);
      expect(await linkRow(one.packageId)).toEqual({ external_code: `TBMT-${one.packageCode}`, diff_status: 'IN_SYNC', diff_json: {}, diff_owner_user_id: null, last_batch_id: applied.batchId });
      expect(await packageVersion(one.packageId)).toBe(2);
      expect((await owner<{ external_package_code: string }>('select external_package_code from machvon.procurement_package where id = $1::uuid', [one.packageId]))[0]?.external_package_code).toBe(`TBMT-${one.packageCode}`);
      const [batch] = await owner<{ status: string; mode: string; adapter_status: string; source_system: string; rows_total: number; rows_ok: number; rows_error: number; errors_json: unknown[]; file_sha256: string }>(
        'select status, mode, adapter_status, source_system, rows_total, rows_ok, rows_error, errors_json, file_sha256 from machvon.procurement_import_batch where id = $1::uuid',
        [applied.batchId],
      );
      expect(batch).toEqual({ status: 'APPLIED', mode: 'APPLY', adapter_status: 'PROPOSED', source_system: 'MUASAMCONG', rows_total: 3, rows_ok: 2, rows_error: 1, errors_json: [{ line: 4, code: 'PACKAGE_NOT_FOUND' }], file_sha256: fileSha256(bytes) });

      // The same file again: the framework says it was taken, and the dry run says so too.
      const again = await applyFile(bytes);
      expect(again.result.outcome).toBe('ALREADY_IMPORTED');
      expect((await as((tx) => previewFileImport(tx, adapterFor(), bytes))).alreadyApplied).toBe(true);
    });

    it('leaves a date the register already has alone: the same day is in step, another day is a difference with the planner as owner, and settling it by hand puts the link in step again', async () => {
      const inStep = await seedPackage();
      await record(inStep, 1, { kind: 'BID_OPENING', actualAt: '2026-09-01T02:00:00Z' });
      const sameDay = await applyFile(csv(HEADER, `${inStep.packageCode},TBMT-${inStep.packageCode},BID_OPENING,2026-09-01`));
      expect(sameDay.result.counts).toMatchObject({ applied: 1, differencesOpened: 0 });
      expect(await linkRow(inStep.packageId)).toMatchObject({ diff_status: 'IN_SYNC', diff_json: {} });
      expect(sameDay.adapter.imported).toEqual([]);

      const seeded = await seedPackage();
      await record(seeded, 1, { kind: 'BID_OPENING', actualAt: '2026-09-01T02:00:00Z' });
      const other = await applyFile(csv(HEADER, `${seeded.packageCode},TBMT-${seeded.packageCode},BID_OPENING,05/09/2026`, `${seeded.packageCode},TBMT-${seeded.packageCode},BID_CLOSING,2026-08-30`));
      expect(other.result.counts).toMatchObject({ applied: 2, differencesOpened: 1 });
      // The register keeps its date; the file's is a difference on the link, owned by the planner who made the package.
      expect((await milestoneRows(seeded.packageId)).find((row) => row.milestone_kind === 'BID_OPENING')).toMatchObject({ actual_at: '2026-09-01T02:00:00.000Z', source: 'MANUAL' });
      expect((await milestoneRows(seeded.packageId)).find((row) => row.milestone_kind === 'BID_CLOSING')).toMatchObject({ source: 'IMPORT' });
      const link = await linkRow(seeded.packageId);
      expect(link).toMatchObject({ diff_status: 'DIFFERENT', diff_owner_user_id: memberId(PLANNER) });
      expect(link?.diff_json).toEqual({ milestones: { BID_OPENING: { register: '2026-09-01T02:00:00.000Z', file: '2026-09-04T17:00:00.000Z' } } });
      const [item] = await owner<{ code: string; expected: string; actual: string; owner_id: string; status: string }>(
        "select code, expected_value as expected, actual_value as actual, owner_membership_id as owner_id, status from machvon.file_import_reconciliation_item where import_id = $1::uuid and code = 'MILESTONE_DATE_MISMATCH'",
        [other.result.importId],
      );
      expect(item).toEqual({ code: 'MILESTONE_DATE_MISMATCH', expected: '2026-09-01', actual: '2026-09-05', owner_id: memberId(PLANNER), status: 'OPEN' });

      // The planner settles it: the register takes the day of the file and the link is in step.
      const version = await packageVersion(seeded.packageId);
      const settled = await record(seeded, version, { kind: 'BID_OPENING', actualAt: '2026-09-05T03:00:00Z' });
      expect(settled.settledDifference).toBe(true);
      expect(await linkRow(seeded.packageId)).toMatchObject({ diff_status: 'IN_SYNC', diff_json: {} });
    });

    it('keeps a difference that the planner has not settled: another day by hand still disagrees with the file, and the link follows the new date', async () => {
      const seeded = await seedPackage();
      await record(seeded, 1, { kind: 'BID_OPENING', actualAt: '2026-09-01T02:00:00Z' });
      await applyFile(csv(HEADER, `${seeded.packageCode},TBMT-${seeded.packageCode},BID_OPENING,2026-09-05`));
      const moved = await record(seeded, await packageVersion(seeded.packageId), { kind: 'BID_OPENING', actualAt: '2026-09-02T02:00:00Z' });
      expect(moved.settledDifference).toBe(false);
      const link = await linkRow(seeded.packageId);
      expect(link).toMatchObject({ diff_status: 'DIFFERENT' });
      expect(link?.diff_json).toEqual({ milestones: { BID_OPENING: { register: '2026-09-02T02:00:00.000Z', file: '2026-09-04T17:00:00.000Z' } } });
      // A milestone with no difference on the link settles nothing.
      const planned = await record(seeded, await packageVersion(seeded.packageId), { kind: 'BID_CLOSING', actualAt: '2026-09-01T02:00:00Z' });
      expect(planned.settledDifference).toBe(false);
    });

    it('fills the actual date of a milestone that only had a planned date, as IMPORT, and keeps the planned date', async () => {
      const seeded = await seedPackage();
      await record(seeded, 1, { kind: 'BID_CLOSING', plannedAt: '2026-08-30T03:00:00Z' });
      const done = await applyFile(csv(HEADER, `${seeded.packageCode},TBMT-${seeded.packageCode},BID_CLOSING,2026-08-31`));
      expect(done.adapter.imported.map((entry) => entry.action)).toEqual(['FILLED']);
      expect(await milestoneRows(seeded.packageId)).toEqual([
        { milestone_kind: 'BID_CLOSING', planned_at: '2026-08-30T03:00:00.000Z', actual_at: '2026-08-30T17:00:00.000Z', source: 'IMPORT', import_batch_id: done.batchId, version: '2' },
      ]);
    });

    it('does not apply a row about another tender on the network: the package keeps its code, nothing of the row is written, and the disagreement has an owner', async () => {
      const seeded = await seedPackage();
      await applyFile(csv(HEADER, `${seeded.packageCode},TBMT-FIRST,BID_CLOSING,2026-08-31`));
      const other = await applyFile(csv(HEADER, `${seeded.packageCode},TBMT-SECOND,BID_OPENING,2026-09-02`));
      expect(other.result.counts).toMatchObject({ applied: 1, differencesOpened: 1 });
      expect((await milestoneRows(seeded.packageId)).map((row) => row.milestone_kind)).toEqual(['BID_CLOSING']);
      expect(await linkRow(seeded.packageId)).toMatchObject({ external_code: 'TBMT-FIRST', diff_status: 'DIFFERENT', diff_json: { external_code: { register: 'TBMT-FIRST', file: 'TBMT-SECOND' } }, diff_owner_user_id: memberId(PLANNER) });
      const preview = await as((tx) => previewFileImport(tx, adapterFor(), csv(HEADER, `${seeded.packageCode},TBMT-SECOND,EVALUATION_DONE,2026-09-03`)));
      expect(preview.rows[0]).toMatchObject({ status: 'VALID', outcome: 'CODE_MISMATCH' });
    });

    it('refuses a row with its reason: a package that does not exist or is not live, a code on the network held by another package, a date in the future and a date out of the order', async () => {
      const held = await seedPackage();
      await applyFile(csv(HEADER, `${held.packageCode},TBMT-HELD,BID_CLOSING,2026-08-31`));
      const draft = await seedPackage({ status: 'DRAFT' });
      const plain = await seedPackage();
      await record(plain, 1, { kind: 'BID_OPENING', actualAt: '2026-09-10T03:00:00Z' });
      const bytes = csv(
        HEADER,
        `${draft.packageCode},TBMT-D,BID_OPENING,2026-09-01`,
        `${plain.packageCode},TBMT-HELD,BID_CLOSING,2026-09-01`,
        `${plain.packageCode},TBMT-P,BID_OPENING,2026-12-31`,
        `${plain.packageCode},TBMT-P,INVITATION_PUBLISHED,2026-09-20`,
        `${plain.packageCode},TBMT-P,RESULT_APPROVED,2026-09-05`,
      );
      const preview = await as((tx) => previewFileImport(tx, adapterFor(), bytes));
      expect(preview.rows.map((row) => [row.line, row.status, row.code ?? row.outcome])).toEqual([
        [2, 'ERROR', 'PACKAGE_STATE_INVALID'],
        [3, 'ERROR', 'EXTERNAL_CODE_TAKEN'],
        [4, 'ERROR', 'ACTUAL_AT_IN_FUTURE'],
        [5, 'ERROR', 'MILESTONE_ORDER_INVALID'],
        [6, 'ERROR', 'MILESTONE_ORDER_INVALID'],
      ]);
    });

    it('tells two live packages with one code apart by the project code of the file, and refuses the code alone as ambiguous', async () => {
      const code = next('GT');
      const a = await seedPackage({ code });
      const b = await seedPackage({ code });
      const bytes = csv('project_code,package_code,external_code,milestone_kind,actual_at', `${a.projectCode},${code},TBMT-A,BID_OPENING,2026-09-01`, `,${code},TBMT-B,BID_OPENING,2026-09-01`);
      const preview = await as((tx) => previewFileImport(tx, adapterFor(), bytes));
      expect(preview.rows.map((row) => [row.status, row.code ?? row.outcome])).toEqual([
        ['VALID', 'CREATE'],
        ['ERROR', 'PACKAGE_AMBIGUOUS'],
      ]);
      const done = await applyFile(csv('project_code,package_code,external_code,milestone_kind,actual_at', `${b.projectCode},${code},TBMT-B,BID_OPENING,2026-09-01`));
      expect(done.adapter.imported.map((entry) => entry.packageId)).toEqual([b.packageId]);
    });

    it('only meets the packages of the projects in the scope: outside it a package looks like one that does not exist, and a code held outside it is not revealed', async () => {
      const seeded = await seedPackage();
      const bytes = csv(HEADER, `${seeded.packageCode},TBMT-${seeded.packageCode},BID_OPENING,2026-09-01`);
      const blind = await as((tx) => previewFileImport(tx, adapterFor(nothing), bytes));
      expect(blind.rows[0]).toMatchObject({ status: 'ERROR', code: 'PACKAGE_NOT_FOUND' });
      const neighbour = await seedPackage();
      await applyFile(csv(HEADER, `${neighbour.packageCode},TBMT-SHARED,BID_OPENING,2026-09-01`));
      const only = (projectId: string): ScopeBuilder => (first) => ({ sql: `p.id = $${first}::uuid`, params: [projectId] });
      const scoped = await as((tx) => previewFileImport(tx, adapterFor(only(seeded.projectId)), csv(HEADER, `${seeded.packageCode},TBMT-SHARED,BID_OPENING,2026-09-01`)));
      expect(scoped.rows[0]).toMatchObject({ status: 'VALID' });
      const wide = await as((tx) => previewFileImport(tx, adapterFor(), csv(HEADER, `${seeded.packageCode},TBMT-SHARED,BID_OPENING,2026-09-01`)));
      expect(wide.rows[0]).toMatchObject({ status: 'ERROR', code: 'EXTERNAL_CODE_TAKEN' });
    });

    it('lists the links with their difference, the owner and the batch that looked at them, in the scope of the reader', async () => {
      const seeded = await seedPackage();
      await record(seeded, 1, { kind: 'BID_OPENING', actualAt: '2026-09-01T02:00:00Z' });
      const applied = await applyFile(csv(HEADER, `${seeded.packageCode},TBMT-${seeded.packageCode},BID_OPENING,2026-09-05`));
      const lines = await as((tx) => links.list(tx, everything, { projectId: seeded.projectId }));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        packageId: seeded.packageId,
        packageCode: seeded.packageCode,
        externalSystem: 'MUASAMCONG',
        externalCode: `TBMT-${seeded.packageCode}`,
        diffStatus: 'DIFFERENT',
        batch: { id: applied.batchId, adapterStatus: 'PROPOSED', rowsTotal: 1, rowsOk: 1, rowsError: 0, fileSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      });
      expect(lines[0]?.diffOwner?.membershipId).toBe(memberId(PLANNER));
      expect(await as((tx) => links.list(tx, everything, { projectId: seeded.projectId, diffStatus: 'IN_SYNC' }))).toEqual([]);
      expect(await as((tx) => links.list(tx, nothing, { projectId: seeded.projectId }))).toEqual([]);
    });
  });

  describe('the guards of the tables', () => {
    it('keeps source and batch together, a date on every milestone, and the package and kind of a milestone', async () => {
      const seeded = await seedPackage();
      const recorded = await record(seeded, 1, { kind: 'BID_OPENING', actualAt: PAST });
      expect(recorded.kind).toBe('BID_OPENING');
      const set = (assignments: string) => as((tx) => tx.query(`update machvon.procurement_milestone set ${assignments} where package_id = $1::uuid`, [seeded.packageId]));
      expect((await sqlState(set("source = 'IMPORT'"))).sqlstate).toBe('23514');
      expect((await sqlState(set('actual_at = null'))).sqlstate).toBe('23514');
      expect((await sqlState(set("milestone_kind = 'BID_CLOSING'"))).sqlstate).toBe('23514');
    });

    it('does not change an applied batch, nor the file of a batch, a dry run applied or a count that does not add up', async () => {
      const seeded = await seedPackage();
      const applied = await applyFile(csv(HEADER, `${seeded.packageCode},TBMT-${seeded.packageCode},BID_OPENING,2026-09-01`));
      const set = (assignments: string, batchId = applied.batchId) => as((tx) => tx.query(`update machvon.procurement_import_batch set ${assignments} where id = $1::uuid`, [batchId]));
      expect((await sqlState(set('rows_ok = 5'))).sqlstate).toBe('23514');
      const staged = await as((tx) => batches.begin(tx, { fileSha256: 'b'.repeat(64), fileObjectKey: 'tenants/x/import/b.csv', actor: memberId(OFFICER) }));
      expect((await sqlState(set("file_sha256 = repeat('c', 64)", staged))).sqlstate).toBe('23514');
      expect((await sqlState(set('rows_total = 1, rows_ok = 2', staged))).sqlstate).toBe('23514');
      expect((await sqlState(set("errors_json = '{}'::jsonb", staged))).sqlstate).toBe('23514');
      expect((await sqlState(as((tx) => tx.query("insert into machvon.procurement_import_batch (tenant_id, id, file_sha256, file_object_key, mode, status, created_by, updated_by) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, repeat('d', 64), 'k', 'DRY_RUN', 'APPLIED', $2::uuid, $2::uuid)", [randomUUID(), memberId(OFFICER)])))).sqlstate).toBe('23514');
    });

    it('asks a link for one code per package, a difference with an owner, and keeps its package and system', async () => {
      const seeded = await seedPackage();
      await applyFile(csv(HEADER, `${seeded.packageCode},TBMT-${seeded.packageCode},BID_OPENING,2026-09-01`));
      const set = (assignments: string) => as((tx) => tx.query(`update machvon.procurement_external_link set ${assignments} where package_id = $1::uuid`, [seeded.packageId]));
      expect((await sqlState(set("diff_status = 'DIFFERENT'"))).sqlstate).toBe('23514');
      expect((await sqlState(set("diff_json = '{\"milestones\":{}}'::jsonb"))).sqlstate).toBe('23514');
      expect((await sqlState(set("diff_status = 'DIFFERENT', diff_json = '{\"x\":1}'::jsonb"))).sqlstate).toBe('23514');
      expect((await sqlState(set("external_system = 'OTHER'"))).sqlstate).toBe('23514');
      expect((await sqlState(set("external_code = ' padded '"))).sqlstate).toBe('23514');
    });

    it('is never deleted by the runtime role', async () => {
      const seeded = await seedPackage();
      await record(seeded, 1, { kind: 'BID_OPENING', actualAt: PAST });
      await applyFile(csv(HEADER, `${seeded.packageCode},TBMT-${seeded.packageCode},BID_CLOSING,2026-09-01`));
      for (const table of ['procurement_milestone', 'procurement_import_batch', 'procurement_external_link']) {
        expect((await sqlState(as((tx) => tx.query(`delete from machvon.${table}`)))).sqlstate).toBe('42501');
      }
    });
  });
});
