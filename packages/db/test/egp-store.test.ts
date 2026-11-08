import { randomUUID } from 'node:crypto';
import { fileSha256 } from '@machvon/kernel';
import { EgpImportAdapter } from '../src/egp-import';
import { HomeConnectorSources } from '../src/home-connector-sources';
import { DEFAULT_SEVERITY_RULES } from '../src/home-work-rules';
import type { SourceContext } from '../src/home-work-sources';
import { EgpConnectionStore, EgpMappingStore } from '../src/egp-store';
import { previewFileImport } from '../src/file-import-preview';
import { FileImportStore } from '../src/file-import-store';
import type { TenantTx } from '../src/tenant-database';
import { seedAs, seedBidPackage, next } from './support/bid-proposal-fixtures';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const connection = new EgpConnectionStore();
const mappings = new EgpMappingStore();
const imports = new FileImportStore();
const LOADER = 1;
const CHECKER = 2;
const THIRD = 3;
const NOW = new Date('2026-11-08T03:00:00Z');

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = LOADER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const bytes = (...lines: string[]): Uint8Array => new TextEncoder().encode(lines.join('\n'));

interface Refusal {
  code: string;
  status: number;
  detail?: string;
  extensions?: Record<string, unknown>;
}

async function refusal(work: Promise<unknown>): Promise<Refusal> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

async function databaseRefusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return String((error as { message?: string }).message);
  }
  throw new Error('expected the database to refuse');
}

let taxCounter = 0;
const taxId = (): string => String(1_100_000_000 + (taxCounter += 1));

async function seedContractorWithTax(tax: string): Promise<string> {
  const contractorId = randomUUID();
  await seedAs(harness, [
    [
      `insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id) values ($1, $2, $3, $4, 'VERIFIED', $5)`,
      [TENANT_A, contractorId, tax, next('Contractor'), randomUUID()],
    ],
  ]);
  return contractorId;
}

async function seedPlan(projectId: string): Promise<string> {
  const planId = randomUUID();
  await seedAs(harness, [
    [
      `insert into machvon.procurement_plan (tenant_id, id, project_id, revision, title, total_value_vnd, legal_basis, status, created_by, updated_by)
       values ($1, $2, $3, 1, 'Plan', 1000, 'Luat Dau thau', 'DRAFT', $4, $4)`,
      [TENANT_A, planId, projectId, memberId(LOADER)],
    ],
  ]);
  return planId;
}

const KHLCNT_HEADER = 'plan_code,package_external_code,package_name,estimated_price,selection_method,approved_on,decision_no,project_code,package_code';

const adapterFor = (kind: 'KHLCNT' | 'TBMT' | 'RESULT' | 'CONTRACTOR' | 'RESTRICTION', now: Date = NOW): EgpImportAdapter => new EgpImportAdapter(kind, { actor: memberId(LOADER), now });

async function apply(kind: 'KHLCNT' | 'TBMT' | 'RESULT' | 'CONTRACTOR' | 'RESTRICTION', file: Uint8Array, adapter: EgpImportAdapter = adapterFor(kind), member = LOADER) {
  return as(
    (tx) => imports.run(tx, { adapter, bytes: file, fileObjectKey: `tenants/${TENANT_A}/import/${randomUUID()}`, expectedSha256: fileSha256(file), importedBy: memberId(member), fallbackOwnerId: memberId(member), correlationId: randomUUID(), cursorScope: 'DEFAULT', now: NOW }),
    member,
  );
}

describe('the connection and the codes of the national procurement network (EGP-1 part 2)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: `/${unitId(1)}/` }]);
      for (const member of [LOADER, CHECKER, THIRD]) await harness.seedMembership(tenant, member, 1);
    }
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the connection: the registry entry, the five positions and the switch', () => {
    it('shows a tenant that never used it as on, under the working-assumption layout, never imported, and writes nothing to show it', async () => {
      const row = await as((tx) => connection.current(tx));
      expect(row).toMatchObject({ id: null, connectorCode: 'egp.muasamcong', enabled: true, layoutVersion: 'WORKING-ASSUMPTION-2026.2', version: 1 });
      const health = await as((tx) => connection.health(tx, NOW, row));
      expect(health.view.health).toMatchObject({ status: 'NEVER_IMPORTED', ageHours: null, alert: null, acceptance: 'PENDING_EXTERNAL', adapterStatus: 'PROPOSED' });
      expect(health.view.apiAdapter).toEqual({ status: 'MISSING', reason: 'OPERATOR_SPECIFICATION_PENDING' });
      expect(health.rule).toMatchObject({ source: 'DEFAULT', unverified: true, legalStatus: 'UNVERIFIED', params: { warnAfterHours: 120, maxAgeHours: 168, staleSeverity: 'WATCH', figuresBlockedWhenStale: false } });
      expect((await owner('select 1 from machvon.egp_connection')).length).toBe(0);
    });

    it('is given to the tenant once: the switch, the entry of the registry (Draft, PROPOSED, FILE_IMPORT) and five positions with an adapter that is only PROPOSED', async () => {
      const first = await as((tx) => connection.ensure(tx, memberId(LOADER)));
      expect(first.created).toBe(true);
      expect(first.row).toMatchObject({ enabled: true, version: 1 });
      const second = await as((tx) => connection.ensure(tx, memberId(THIRD)));
      expect(second.created).toBe(false);
      expect(second.row.id).toBe(first.row.id);
      expect(await as((tx) => connection.registryEntry(tx))).toEqual({ status: 'Draft', adapterStatus: 'PROPOSED', mode: 'FILE_IMPORT', mappingVersion: 'WORKING-ASSUMPTION-2026.2' });
      const positions = await as((tx) => connection.positions(tx));
      expect(positions.map((one) => [one.kind, one.connectorCode, one.cursorStatus, one.adapterStatus, one.lastSuccessAt])).toEqual([
        ['KHLCNT', 'EGP_KHLCNT_FILE', 'ACTIVE', 'PROPOSED', null],
        ['TBMT', 'EGP_TBMT_FILE', 'ACTIVE', 'PROPOSED', null],
        ['RESULT', 'EGP_RESULT_FILE', 'ACTIVE', 'PROPOSED', null],
        ['CONTRACTOR', 'EGP_CONTRACTOR_FILE', 'ACTIVE', 'PROPOSED', null],
        ['RESTRICTION', 'EGP_RESTRICTION_FILE', 'ACTIVE', 'PROPOSED', null],
      ]);
      expect((await as((tx) => connection.events(tx, 10))).map((event) => event.action)).toEqual(['CREATED']);
      expect(await as((tx) => connection.registryEntry(tx), LOADER, TENANT_B)).toBeUndefined();
    });

    it('is switched off and on with a reason, a version and a history; a stale version, a repeat and a short reason are refused', async () => {
      const current = await as((tx) => connection.current(tx));
      expect(await refusal(as((tx) => connection.setState(tx, current.version + 1, { enabled: false, reason: 'Chờ mẫu tệp chính thức của đơn vị vận hành' }, memberId(LOADER))))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(as((tx) => connection.setState(tx, current.version, { enabled: false, reason: 'ngắn' }, memberId(LOADER))))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      expect(await refusal(as((tx) => connection.setState(tx, current.version, { enabled: true, reason: 'Đã bật rồi nên không đổi gì' }, memberId(LOADER))))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'enabled' });
      const off = await as((tx) => connection.setState(tx, current.version, { enabled: false, reason: 'Chờ mẫu tệp chính thức của đơn vị vận hành' }, memberId(CHECKER)), CHECKER);
      expect(off.row).toMatchObject({ enabled: false, version: 2, stateReason: 'Chờ mẫu tệp chính thức của đơn vị vận hành', stateChangedBy: memberId(CHECKER) });
      const on = await as((tx) => connection.setState(tx, 2, { enabled: true, reason: 'Mẫu tệp đã được đơn vị vận hành xác nhận' }, memberId(CHECKER)), CHECKER);
      expect(on.row).toMatchObject({ enabled: true, version: 3 });
      expect((await as((tx) => connection.events(tx, 10))).map((event) => [event.action, event.version])).toEqual([['ENABLED', 3], ['DISABLED', 2], ['CREATED', 1]]);
    });

    it('holds the same rules in the database: no switch without a reason, a history nobody rewrites, a code that never changes', async () => {
      expect(await databaseRefusal(owner('update machvon.egp_connection set enabled = false, version = version + 1'))).toContain('with a reason');
      expect(await databaseRefusal(owner("update machvon.egp_connection set connector_code = 'other.code'"))).toContain('keeps its code');
      expect(await databaseRefusal(owner("update machvon.egp_connection_event set reason = 'changed the story'"))).toContain('append-only');
      expect(await databaseRefusal(owner('delete from machvon.egp_connection_event'))).toContain('append-only');
    });
  });

  describe('the mappings: proposed by one person, approved by another', () => {
    it('proposes by hand, refuses the maker as approver, activates on another person, and is audited by its own columns', async () => {
      const seeded = await seedBidPackage(harness);
      const proposed = await as((tx) => mappings.propose(tx, { subjectType: 'PACKAGE', ourCode: seeded.packageCode, ourProjectCode: seeded.projectCode, externalCode: 'PK-HAND-1', validFrom: null, validUntil: null, confidence: null, method: 'MANUAL', reason: 'Khớp theo quyết định phê duyệt kế hoạch' }, memberId(LOADER), NOW));
      expect(proposed.row).toMatchObject({ status: 'PROPOSED', subjectType: 'PACKAGE', subjectId: seeded.packageId, ourCode: seeded.packageCode, projectCode: seeded.projectCode, externalType: 'EGP_PACKAGE', externalCode: 'PK-HAND-1', matchMethod: 'MANUAL', validFrom: '2026-11-08', validUntil: null, proposedBy: memberId(LOADER), version: 1 });
      expect(await refusal(as((tx) => mappings.decide(tx, proposed.row.id, 1, { move: 'APPROVE', reason: 'Tôi tự duyệt đề xuất của mình' }, memberId(LOADER), NOW)))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(as((tx) => mappings.decide(tx, proposed.row.id, 7, { move: 'APPROVE', reason: 'Khớp theo quyết định phê duyệt kế hoạch' }, memberId(CHECKER), NOW), CHECKER))).toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await refusal(as((tx) => mappings.decide(tx, proposed.row.id, 1, { move: 'APPROVE', reason: 'ok' }, memberId(CHECKER), NOW), CHECKER))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      const approved = await as((tx) => mappings.decide(tx, proposed.row.id, 1, { move: 'APPROVE', reason: 'Đã đối chiếu với thông báo mời thầu' }, memberId(CHECKER), NOW), CHECKER);
      expect(approved.row).toMatchObject({ status: 'ACTIVE', approvedBy: memberId(CHECKER), decisionReason: 'Đã đối chiếu với thông báo mời thầu', version: 2 });
      expect(await refusal(as((tx) => mappings.decide(tx, proposed.row.id, 2, { move: 'REJECT', reason: 'Đã hoạt động rồi' }, memberId(CHECKER), NOW), CHECKER))).toMatchObject({ code: 'EGP_MAPPING_STATE_INVALID', status: 409 });
    });

    it('keeps one code for one subject at a time: another subject, another code for the subject and a repeated proposal are all 409 CROSSWALK_DUPLICATE', async () => {
      const one = await seedBidPackage(harness);
      const two = await seedBidPackage(harness);
      const make = (seeded: { packageCode: string; projectCode: string }, code: string) =>
        as((tx) => mappings.propose(tx, { subjectType: 'PACKAGE', ourCode: seeded.packageCode, ourProjectCode: seeded.projectCode, externalCode: code, validFrom: null, validUntil: null, confidence: null, method: 'MANUAL', reason: 'Khớp theo mã gói thầu trên mạng' }, memberId(LOADER), NOW));
      const first = await make(one, 'PK-ONE');
      await as((tx) => mappings.decide(tx, first.row.id, 1, { move: 'APPROVE', reason: 'Khớp theo mã gói thầu trên mạng' }, memberId(CHECKER), NOW), CHECKER);
      expect(await refusal(make(two, 'PK-ONE'))).toMatchObject({ code: 'CROSSWALK_DUPLICATE', status: 409, extensions: { reason: 'EXTERNAL_CODE_TAKEN' } });
      expect(await refusal(make(one, 'PK-ONE-OTHER'))).toMatchObject({ code: 'CROSSWALK_DUPLICATE', extensions: { reason: 'SUBJECT_HAS_OTHER_CODE' } });
      expect(await refusal(make(one, 'PK-ONE'))).toMatchObject({ code: 'CROSSWALK_DUPLICATE', extensions: { reason: 'UNCHANGED' } });
      const waiting = await make(two, 'PK-TWO');
      expect(await refusal(make(two, 'PK-TWO'))).toMatchObject({ code: 'CROSSWALK_DUPLICATE', extensions: { reason: 'ALREADY_PROPOSED' } });
      await as((tx) => mappings.decide(tx, waiting.row.id, 1, { move: 'APPROVE', reason: 'Khớp theo mã gói thầu trên mạng' }, memberId(CHECKER), NOW), CHECKER);
    });

    it('refuses a code of ours that names no row (our_code) or two rows (our_project_code), and judges the mapping like the kernel', async () => {
      const request = { subjectType: 'PACKAGE', ourCode: 'GT-NOT-HERE', ourProjectCode: null, externalCode: 'PK-X', validFrom: null, validUntil: null, confidence: null, method: 'MANUAL', reason: 'Khớp theo mã gói thầu trên mạng' } as const;
      expect(await refusal(as((tx) => mappings.propose(tx, request, memberId(LOADER), NOW)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'our_code' });
      const one = await seedBidPackage(harness);
      const other = await seedBidPackage(harness);
      await seedAs(harness, [['update machvon.procurement_package set code = $2 where id = $1', [other.packageId, one.packageCode]]]);
      expect(await refusal(as((tx) => mappings.propose(tx, { ...request, ourCode: one.packageCode }, memberId(LOADER), NOW)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'our_project_code' });
      expect(await refusal(as((tx) => mappings.propose(tx, { ...request, ourCode: one.packageCode, ourProjectCode: one.projectCode, validFrom: '2026-12-01', validUntil: '2026-11-01' }, memberId(LOADER), NOW)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'valid_until' });
    });

    it('maps a contractor by tax code, a contract by code, and refuses to retire what is not active', async () => {
      const tax = taxId();
      await seedContractorWithTax(tax);
      const proposed = await as((tx) => mappings.propose(tx, { subjectType: 'CONTRACTOR', ourCode: tax, ourProjectCode: null, externalCode: tax, validFrom: '2026-11-01', validUntil: '2027-11-01', confidence: null, method: 'MANUAL', reason: 'Nhà thầu khớp theo mã số thuế' }, memberId(LOADER), NOW));
      expect(proposed.row).toMatchObject({ subjectType: 'CONTRACTOR', ourCode: tax, externalType: 'EGP_CONTRACTOR', validFrom: '2026-11-01', validUntil: '2027-11-01' });
      expect(await refusal(as((tx) => mappings.decide(tx, proposed.row.id, 1, { move: 'RETIRE', reason: 'Chưa duyệt nên chưa thể ngừng' }, memberId(CHECKER), NOW), CHECKER))).toMatchObject({ code: 'EGP_MAPPING_STATE_INVALID' });
    });

    it('rejects a proposal with a reason and keeps it, and retires an active mapping (the code becomes free, the history stays)', async () => {
      const seeded = await seedBidPackage(harness);
      const propose = (code: string, member = LOADER) =>
        as((tx) => mappings.propose(tx, { subjectType: 'PACKAGE', ourCode: seeded.packageCode, ourProjectCode: seeded.projectCode, externalCode: code, validFrom: null, validUntil: null, confidence: null, method: 'MANUAL', reason: 'Khớp theo mã gói thầu trên mạng' }, memberId(member), NOW), member);
      const first = await propose('PK-REJECT');
      const rejected = await as((tx) => mappings.decide(tx, first.row.id, 1, { move: 'REJECT', reason: 'Mã này thuộc gói của kế hoạch khác' }, memberId(CHECKER), NOW), CHECKER);
      expect(rejected.row).toMatchObject({ status: 'REJECTED', decisionReason: 'Mã này thuộc gói của kế hoạch khác', approvedBy: memberId(CHECKER) });
      const second = await propose('PK-RETIRE');
      await as((tx) => mappings.decide(tx, second.row.id, 1, { move: 'APPROVE', reason: 'Khớp theo mã gói thầu trên mạng' }, memberId(CHECKER), NOW), CHECKER);
      const retired = await as((tx) => mappings.decide(tx, second.row.id, 2, { move: 'RETIRE', reason: 'Thông báo bị hủy trên hệ thống mạng' }, memberId(LOADER), new Date('2026-11-20T03:00:00Z')));
      expect(retired.row).toMatchObject({ status: 'RETIRED', retiredBy: memberId(LOADER), retireReason: 'Thông báo bị hủy trên hệ thống mạng', validUntil: '2026-11-20', version: 3 });
      // The subject now holds no active code: a new one may be proposed, approved and held, and the three old rows are all still there.
      const third = await propose('PK-NEW');
      await as((tx) => mappings.decide(tx, third.row.id, 1, { move: 'APPROVE', reason: 'Mã mới sau khi hủy mã cũ' }, memberId(CHECKER), NOW), CHECKER);
      const all = await as((tx) => mappings.list(tx, { q: seeded.packageCode }, { limit: 20, after: undefined }));
      expect(all.map((row) => [row.externalCode, row.status]).sort()).toEqual([['PK-NEW', 'ACTIVE'], ['PK-REJECT', 'REJECTED'], ['PK-RETIRE', 'RETIRED']]);
    });

    it('lists by subject, status and text with a cursor, counts by status, and never shows the codes of another tenant', async () => {
      const all = await as((tx) => mappings.list(tx, {}, { limit: 200, after: undefined }));
      expect(all.length).toBeGreaterThan(5);
      const page = await as((tx) => mappings.list(tx, {}, { limit: 2, after: undefined }));
      expect(page).toHaveLength(2);
      const last = page[1] as { createdAtKey: string; id: string };
      const next2 = await as((tx) => mappings.list(tx, {}, { limit: 2, after: { key: last.createdAtKey, id: last.id } }));
      expect(next2.every((row) => !page.some((seen) => seen.id === row.id))).toBe(true);
      expect((await as((tx) => mappings.list(tx, { status: 'ACTIVE' }, { limit: 200, after: undefined }))).every((row) => row.status === 'ACTIVE')).toBe(true);
      expect((await as((tx) => mappings.list(tx, { subjectType: 'CONTRACTOR' }, { limit: 200, after: undefined }))).every((row) => row.subjectType === 'CONTRACTOR')).toBe(true);
      expect(await as((tx) => mappings.list(tx, { q: 'zzz-no-such-code' }, { limit: 10, after: undefined }))).toEqual([]);
      const counts = await as((tx) => mappings.counts(tx));
      expect(counts.ACTIVE + counts.PROPOSED + counts.REJECTED + counts.RETIRED).toBe(all.length);
      expect(await as((tx) => mappings.list(tx, {}, { limit: 10, after: undefined }), LOADER, TENANT_B)).toEqual([]);
    });

    it('is held by the database as well: a subject or a master record, never both; the maker is not the checker; an identity that never changes; no state may skip', async () => {
      const seeded = await seedBidPackage(harness);
      const insert = (columns: string, values: string): Promise<unknown> =>
        owner(`insert into machvon.master_crosswalk (tenant_id, id, source_system, external_type, external_code, valid_from, match_method, created_by, updated_by, ${columns}) values ('${TENANT_A}', gen_random_uuid(), 'MUASAMCONG', 'EGP_PACKAGE', $1, date '2026-11-01', 'MANUAL', $2, $2, ${values})`, [`DB-${randomUUID().slice(0, 8)}`, memberId(LOADER)]);
      expect(await databaseRefusal(insert('status', "'PROPOSED'"))).toContain('master_crosswalk_subject_chk');
      expect(await databaseRefusal(insert('status, subject_type, subject_id', `'PROPOSED', 'PLANET', '${seeded.packageId}'`))).toContain('master_crosswalk_subject_type_chk');
      expect(await databaseRefusal(insert('status, subject_type, subject_id, approved_by, approved_at, decision_reason', `'ACTIVE', 'PACKAGE', '${seeded.packageId}', '${memberId(LOADER)}', now(), 'tự duyệt chính mình'`))).toContain('master_crosswalk_maker_checker_chk');
      expect(await databaseRefusal(insert('status, subject_type, subject_id', `'ACTIVE', 'PACKAGE', '${seeded.packageId}'`))).toContain('master_crosswalk_subject_decision_chk');
      const proposed = await as((tx) => mappings.propose(tx, { subjectType: 'PACKAGE', ourCode: seeded.packageCode, ourProjectCode: seeded.projectCode, externalCode: 'PK-GUARD', validFrom: null, validUntil: null, confidence: null, method: 'MANUAL', reason: 'Khớp theo mã gói thầu trên mạng' }, memberId(LOADER), NOW));
      expect(await databaseRefusal(owner("update machvon.master_crosswalk set external_code = 'PK-OTHER' where id = $1", [proposed.row.id]))).toContain('keeps what it maps');
      expect(await databaseRefusal(owner("update machvon.master_crosswalk set status = 'RETIRED' where id = $1", [proposed.row.id]))).toContain('moves from PROPOSED');
    });
  });

  describe('the files: dry run, apply once, the layout, and what an apply writes', () => {
    it('reads a KHLCNT file as a dry run that writes nothing and says what the apply would do with each valid row', async () => {
      const seeded = await seedBidPackage(harness, { budgetVnd: '100000000' });
      await seedPlan(seeded.projectId);
      const file = bytes(KHLCNT_HEADER, `KH-DRY,PK-DRY-1,Construction package,100000000,OPEN_BIDDING,2026-10-01,QD-12,${seeded.projectCode},${seeded.packageCode}`, `KH-DRY,PK-DRY-2,Unknown,5,OPEN_BIDDING,2026-10-01,QD-12,${seeded.projectCode},GT-NOT-IN-REGISTER`, 'KH-DRY,PK-DRY-3,Broken,12.000.000,NOT_A_METHOD,,,,');
      const preview = await as((tx) => previewFileImport(tx, adapterFor('KHLCNT'), file));
      expect(preview).toMatchObject({ connectorCode: 'EGP_KHLCNT_FILE', formatVersion: 'WORKING-ASSUMPTION-2026.2', alreadyApplied: false, counts: { total: 3, valid: 2, errors: 1, duplicate: 0, conflict: 0 } });
      expect(preview.rows.map((row) => [row.line, row.status, row.outcome ?? row.code])).toEqual([[2, 'VALID', 'RECORD_AND_PROPOSE'], [3, 'VALID', 'RECORD_AND_DIFFERENCE'], [4, 'ERROR', 'MONEY_INVALID']]);
      expect((await owner('select 1 from machvon.egp_record')).length + (await owner("select 1 from machvon.file_import where connector_code = 'EGP_KHLCNT_FILE'")).length).toBe(0);
    });

    it('applies a KHLCNT file once: the records, the mappings it proposes (PROPOSED, the loader is the maker), the differences it opens, the position it moves', async () => {
      const seeded = await seedBidPackage(harness, { budgetVnd: '200000000' });
      await seedPlan(seeded.projectId);
      const file = bytes(KHLCNT_HEADER, `KH-APPLY,PK-APPLY-1,Construction package,200000000,OPEN_BIDDING,2026-10-01,QD-12,${seeded.projectCode},${seeded.packageCode}`, 'KH-APPLY,PK-APPLY-2,Other package,300000000,OPEN_BIDDING,2026-10-01,QD-12,PRJ-NOT-HERE,GT-NOT-HERE');
      const adapter = adapterFor('KHLCNT');
      const result = await apply('KHLCNT', file, adapter);
      expect(result).toMatchObject({ outcome: 'APPLIED', counts: { total: 2, applied: 2, duplicate: 0, conflict: 0, quarantined: 0, differencesOpened: 1 } });
      expect(adapter.written).toMatchObject({ records: 2, differences: 1 });
      expect(adapter.written.proposals).toHaveLength(2);
      // the second row is one difference whose detail names both codes of the network (its package and its plan)
      const records = await owner<{ kind: string; business_key: string; layout_version: string; record: { packageExternalCode: string } }>('select kind, business_key, layout_version, record from machvon.egp_record where import_id = $1::uuid order by business_key', [result.importId]);
      expect(records.map((row) => [row.kind, row.business_key, row.layout_version])).toEqual([['KHLCNT', 'KH-APPLY|PK-APPLY-1', 'WORKING-ASSUMPTION-2026.2'], ['KHLCNT', 'KH-APPLY|PK-APPLY-2', 'WORKING-ASSUMPTION-2026.2']]);
      const proposed = await as((tx) => mappings.list(tx, { status: 'PROPOSED', q: seeded.packageCode }, { limit: 10, after: undefined }));
      const plans = await as((tx) => mappings.list(tx, { status: 'PROPOSED', q: seeded.projectCode }, { limit: 10, after: undefined }));
      expect(proposed.map((row) => [row.subjectType, row.ourCode, row.externalCode, row.matchMethod, row.proposedBy, row.importId])).toEqual(expect.arrayContaining([['PACKAGE', seeded.packageCode, 'PK-APPLY-1', 'IMPORT', memberId(LOADER), result.importId]]));
      expect(plans.some((row) => row.subjectType === 'PLAN' && row.externalCode === 'KH-APPLY')).toBe(true);
      // The code of ours that is not in the register is a difference with an owner, and no mapping.
      const items = await owner<{ code: string; business_key: string; status: string }>('select code, business_key, status from machvon.file_import_reconciliation_item where import_id = $1::uuid order by business_key, code', [result.importId]);
      expect(items.map((item) => [item.code, item.business_key])).toEqual([['EGP_OUR_CODE_UNKNOWN', 'KH-APPLY|PK-APPLY-2']]);
      expect(items.every((item) => item.status === 'OPEN')).toBe(true);
      const cursor = await owner<{ last_success_at: string | null; last_file_sha256: string }>("select last_success_at, last_file_sha256 from machvon.integration_cursor where connector_code = 'EGP_KHLCNT_FILE'");
      expect(cursor[0]?.last_success_at).not.toBeNull();
      expect(cursor[0]?.last_file_sha256).toBe(fileSha256(file));
    });

    it('answers the same file with "already applied" and changes nothing; the same key with other content is a conflict item and the first record stands', async () => {
      const seeded = await seedBidPackage(harness);
      const file = bytes(KHLCNT_HEADER, `KH-ONCE,PK-ONCE,Construction package,100000000,OPEN_BIDDING,2026-10-01,QD-12,${seeded.projectCode},${seeded.packageCode}`);
      expect((await apply('KHLCNT', file)).outcome).toBe('APPLIED');
      const again = await apply('KHLCNT', file);
      expect(again.outcome).toBe('ALREADY_IMPORTED');
      expect((await as((tx) => previewFileImport(tx, adapterFor('KHLCNT'), file))).alreadyApplied).toBe(true);
      const changed = bytes(KHLCNT_HEADER, `KH-ONCE,PK-ONCE,Construction package,150000000,OPEN_BIDDING,2026-10-01,QD-12,${seeded.projectCode},${seeded.packageCode}`);
      const conflict = await apply('KHLCNT', changed);
      expect(conflict).toMatchObject({ outcome: 'APPLIED', counts: { applied: 0, conflict: 1, differencesOpened: 1 } });
      const kept = await owner<{ record: { estimatedPrice: string } }>("select record from machvon.egp_record where business_key = 'KH-ONCE|PK-ONCE'");
      expect(kept).toHaveLength(1);
      expect(kept[0]?.record.estimatedPrice).toBe('100000000');
    });

    it('records a notice, a result and a contractor profile; a contractor of the register is mapped by tax code, one the register does not have is not a difference', async () => {
      const seeded = await seedBidPackage(harness);
      const tax = taxId();
      const unknownTax = taxId();
      const contractorId = await seedContractorWithTax(tax);
      const notice = bytes(
        'notice_code,notice_version,notice_kind,package_external_code,plan_code,published_at,bid_closing_at,bid_opening_at,estimated_price,bid_security_amount,project_code,package_code',
        `TB-1,0,INVITATION,PK-N-1,KH-N,2026-10-05,2026-10-20,2026-10-20,100000000,1000000,${seeded.projectCode},${seeded.packageCode}`,
      );
      const noticeResult = await apply('TBMT', notice);
      expect(noticeResult).toMatchObject({ outcome: 'APPLIED', counts: { applied: 1 } });
      const noticeMaps = await as((tx) => mappings.list(tx, { q: seeded.packageCode }, { limit: 10, after: undefined }));
      expect(noticeMaps.map((row) => [row.subjectType, row.status])).toEqual(expect.arrayContaining([['PACKAGE', 'PROPOSED'], ['NOTICE', 'PROPOSED']]));
      const result = bytes(
        'result_code,notice_code,package_external_code,result_kind,published_at,approved_on,contractor_tax_code,award_price,contractor_name,project_code,package_code',
        `KQ-1,TB-1,PK-N-1,AWARDED,2026-11-01,2026-10-31,${tax},90000000,Builders,${seeded.projectCode},${seeded.packageCode}`,
      );
      expect((await apply('RESULT', result)).counts).toMatchObject({ applied: 1 });
      const contractors = bytes(
        'contractor_tax_code,contractor_name,external_contractor_code,legal_status,registered_address,violation_count,as_of',
        `${tax},Builders,NT-${tax},ACTIVE,1 Main street,0,2026-11-01`,
        `${unknownTax},Somebody else,,ACTIVE,2 Main street,1,2026-11-01`,
      );
      const adapter = adapterFor('CONTRACTOR');
      const done = await apply('CONTRACTOR', contractors, adapter);
      expect(done).toMatchObject({ counts: { applied: 2, differencesOpened: 0 } });
      const mapped = await as((tx) => mappings.list(tx, { subjectType: 'CONTRACTOR', q: tax }, { limit: 10, after: undefined }));
      expect(mapped.map((row) => [row.subjectId, row.externalCode, row.matchMethod, row.status])).toEqual([[contractorId, `NT-${tax}`, 'RULE', 'PROPOSED']]);
      expect((await as((tx) => connection.recordCounts(tx))).CONTRACTOR).toBeGreaterThanOrEqual(2);
    });

    it('refuses to relink: a code another subject holds, or a subject that holds another code, becomes a difference and not a mapping', async () => {
      const one = await seedBidPackage(harness);
      const two = await seedBidPackage(harness);
      const make = (seeded: { packageCode: string; projectCode: string }, code: string) =>
        as((tx) => mappings.propose(tx, { subjectType: 'PACKAGE', ourCode: seeded.packageCode, ourProjectCode: seeded.projectCode, externalCode: code, validFrom: null, validUntil: null, confidence: null, method: 'MANUAL', reason: 'Khớp theo mã gói thầu trên mạng' }, memberId(LOADER), NOW));
      const held = await make(one, 'PK-HELD');
      await as((tx) => mappings.decide(tx, held.row.id, 1, { move: 'APPROVE', reason: 'Khớp theo mã gói thầu trên mạng' }, memberId(CHECKER), NOW), CHECKER);
      const file = bytes(KHLCNT_HEADER, `KH-RELINK,PK-HELD,Name,1,OPEN_BIDDING,2026-10-01,QD,${two.projectCode},${two.packageCode}`, `KH-RELINK,PK-ELSE,Name,1,OPEN_BIDDING,2026-10-01,QD,${one.projectCode},${one.packageCode}`);
      const result = await apply('KHLCNT', file);
      expect(result.counts.differencesOpened).toBeGreaterThanOrEqual(2);
      const items = await owner<{ code: string }>('select code from machvon.file_import_reconciliation_item where import_id = $1::uuid', [result.importId]);
      expect(items.map((item) => item.code)).toEqual(expect.arrayContaining(['EGP_EXTERNAL_CODE_TAKEN', 'EGP_SUBJECT_HAS_OTHER_CODE']));
      expect(await as((tx) => mappings.list(tx, { q: 'PK-ELSE' }, { limit: 10, after: undefined }))).toEqual([]);
      const heldRows = await as((tx) => mappings.list(tx, { q: 'PK-HELD' }, { limit: 10, after: undefined }));
      expect(heldRows.map((row) => [row.subjectId, row.status])).toEqual([[one.packageId, 'ACTIVE']]);
    });

    it('keeps a restriction of a registered contractor off the register while the layout is a working assumption, and writes it once the layout is official', async () => {
      const tax = taxId();
      const contractorId = await seedContractorWithTax(tax);
      const header = 'restriction_code,contractor_tax_code,contractor_name,restriction_kind,scope,valid_from,valid_until,decision_no,decision_date,legal_basis';
      const file = bytes(header, `RS-1,${tax},Builders,DEBARMENT,NATIONWIDE,2026-10-01,2027-10-01,QD-99,2026-09-30,Dieu 133`, `RS-2,${taxId()},Nobody here,REPUTATION_LISTED,,2026-10-01,2026-12-01,QD-98,,`);
      expect((await as((tx) => previewFileImport(tx, adapterFor('RESTRICTION'), file))).rows.map((row) => row.outcome)).toEqual(['RECORD_AND_DIFFERENCE', 'RECORD']);
      const working = await apply('RESTRICTION', file);
      expect(working.counts).toMatchObject({ applied: 2, differencesOpened: 1 });
      expect(await owner('select 1 from machvon.contractor_restriction where contractor_id = $1::uuid', [contractorId])).toHaveLength(0);
      const items = await owner<{ code: string }>('select code from machvon.file_import_reconciliation_item where import_id = $1::uuid', [working.importId]);
      expect(items.map((item) => item.code)).toEqual(['EGP_RESTRICTION_FOR_REGISTERED_CONTRACTOR']);

      // The same list under an official layout: the restriction is written to the register of contractors, from the network, as the register already allows.
      class OfficialAdapter extends EgpImportAdapter {
        override readonly formatVersion = 'OFFICIAL-2027.1';
      }
      const tax2 = taxId();
      const contractor2 = await seedContractorWithTax(tax2);
      const official = new OfficialAdapter('RESTRICTION', { actor: memberId(LOADER), now: NOW });
      const done = await apply('RESTRICTION', bytes(header, `RS-3,${tax2},Builders 2,DEBARMENT,NATIONWIDE,2026-10-01,2027-10-01,QD-97,2026-09-30,Dieu 133`), official);
      expect(done.counts).toMatchObject({ applied: 1, differencesOpened: 0 });
      expect(official.written.restrictions).toHaveLength(1);
      expect(await owner<{ kind: string; source: string; effective_until: string; note: string }>('select kind, source, effective_until::text, note from machvon.contractor_restriction where contractor_id = $1::uuid', [contractor2])).toEqual([
        { kind: 'DEBARMENT', source: 'NATIONAL_E_PROCUREMENT_IMPORT', effective_until: '2027-10-01', note: `EGP RS-3 QD-97 import ${done.importId}` },
      ]);
    });

    it('suggests a package of ours for a package of the network only when the price is the same to the unit and the names are alike, and stops once a mapping is proposed', async () => {
      const seeded = await seedBidPackage(harness, { budgetVnd: '777000000' });
      await seedAs(harness, [["update machvon.procurement_package set title = 'Xay dung cau Song Hong giai doan 2' where id = $1", [seeded.packageId]]]);
      const file = bytes(KHLCNT_HEADER, 'KH-SUG,PK-SUG-1,Xây dựng cầu Sông Hồng giai đoạn 2,777000000,OPEN_BIDDING,2026-10-01,QD,,', 'KH-SUG,PK-SUG-2,Xay dung cau Song Hong giai doan 2,777000001,OPEN_BIDDING,2026-10-01,QD,,', 'KH-SUG,PK-SUG-3,Tuyen duong khac hoan toan,777000000,OPEN_BIDDING,2026-10-01,QD,,');
      await apply('KHLCNT', file);
      const found = await as((tx) => mappings.suggestions(tx, 100));
      expect(found.threshold).toBe(0.8);
      const mine = found.items.filter((item) => item.externalCode.startsWith('PK-SUG'));
      expect(mine.map((item) => item.externalCode)).toEqual(['PK-SUG-1']);
      expect(mine[0]?.candidates.map((candidate) => [candidate.code, candidate.confidence])).toEqual([[seeded.packageCode, 1]]);
      await as((tx) => mappings.propose(tx, { subjectType: 'PACKAGE', ourCode: seeded.packageCode, ourProjectCode: seeded.projectCode, externalCode: 'PK-SUG-1', validFrom: null, validUntil: null, confidence: 1, method: 'NAME_SUGGESTION', reason: 'Xác nhận gợi ý theo tên và giá' }, memberId(LOADER), NOW));
      expect((await as((tx) => mappings.suggestions(tx, 100))).items.filter((item) => item.externalCode.startsWith('PK-SUG'))).toEqual([]);
    });

    it('lists the runs with their open differences, finds one, and refuses to change what a file said', async () => {
      const runs = await as((tx) => connection.listRuns(tx, { limit: 50, after: undefined }));
      expect(runs.length).toBeGreaterThan(3);
      expect(runs.every((run) => run.layoutVersion === 'WORKING-ASSUMPTION-2026.2' || run.layoutVersion === 'OFFICIAL-2027.1')).toBe(true);
      expect((await as((tx) => connection.listRuns(tx, { kind: 'RESTRICTION', limit: 50, after: undefined }))).every((run) => run.kind === 'RESTRICTION')).toBe(true);
      const withDifferences = runs.find((run) => run.openDifferences > 0);
      expect(withDifferences).toBeDefined();
      expect(await as((tx) => connection.findRun(tx, (withDifferences as { id: string }).id))).toMatchObject({ openDifferences: withDifferences?.openDifferences });
      expect(await as((tx) => connection.findRun(tx, randomUUID()))).toBeUndefined();
      expect(await as((tx) => connection.listRuns(tx, { limit: 50, after: undefined }), LOADER, TENANT_B)).toEqual([]);
      expect(await databaseRefusal(owner("update machvon.egp_record set kind = 'TBMT'"))).toContain('append-only');
      expect(await databaseRefusal(owner('delete from machvon.egp_record'))).toContain('append-only');
    });

    it('reads the health from the last applied file: fresh, aging, stale (CONNECTOR_STALE at the severity of the rule), and a switch that is off is shown beside it', async () => {
      const current = await as((tx) => connection.current(tx));
      const fresh = await as((tx) => connection.health(tx, new Date(NOW.getTime() + 3_600_000), current));
      expect(fresh.view.health.status).toBe('FRESH');
      expect(fresh.lastImportAt).not.toBeNull();
      expect(fresh.view.health.alert).toBeNull();
      const days = (n: number): Date => new Date(NOW.getTime() + n * 86_400_000);
      expect((await as((tx) => connection.health(tx, days(6), current))).view.health.status).toBe('AGING');
      const stale = await as((tx) => connection.health(tx, days(9), current));
      expect(stale.view.health).toMatchObject({ status: 'STALE', alert: { code: 'CONNECTOR_STALE', severity: 'WATCH' } });
      expect(stale.view.health.ageHours).toBeGreaterThan(168);
      expect(stale.view.applyBlocked).toBe(false);
      const off = await as((tx) => connection.setState(tx, current.version, { enabled: false, reason: 'Tạm dừng nhập trong lúc đổi mẫu tệp' }, memberId(LOADER)));
      expect((await as((tx) => connection.health(tx, days(9), off.row))).view).toMatchObject({ applyBlocked: true, enabled: false });
    });

    it('is a source of the alert centre: CONNECTOR_STALE for the integration administrator when the last file is older than the rule allows, nothing while fresh, switched off or for a reader without the role', async () => {
      const sources = new HomeConnectorSources();
      const contextAt = (tx: TenantTx, now: Date, holds: boolean): SourceContext => ({
        tx,
        membershipId: memberId(LOADER),
        now,
        today: now.toISOString().slice(0, 10),
        view: 'scope',
        unitScope: () => ({ sql: 'true', params: [] }),
        projectScope: () => ({ sql: 'true', params: [] }),
        rules: DEFAULT_SEVERITY_RULES,
        counting: false,
        holds: () => holds,
      });
      const soon = new Date(NOW.getTime() + 3_600_000);
      const late = new Date(NOW.getTime() + 9 * 86_400_000);
      const before = await as((tx) => connection.current(tx));
      if (!before.enabled) await as((tx) => connection.setState(tx, before.version, { enabled: true, reason: 'Bật lại để thử nguồn cảnh báo' }, memberId(LOADER)));
      expect(await as((tx) => sources.items(contextAt(tx, soon, true)))).toEqual([]);
      const found = await as((tx) => sources.items(contextAt(tx, late, true)));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ kind: 'CONNECTOR_STALE', source: 'CONNECTOR', severity: 'WATCH', status: 'STALE', target: { screen: 'BID-22' }, lifecycle: 'NEW' });
      expect(found[0]?.consequence).toContain('cũ hơn mức cho phép');
      expect(found[0]?.startedAt).toBe(new Date(NOW.getTime() + 168 * 3_600_000).toISOString());
      expect(await as((tx) => sources.items(contextAt(tx, late, false)))).toEqual([]);
      // Switched off with a reason, the connection is not nagged about: it was stopped on purpose.
      const current = await as((tx) => connection.current(tx));
      if (current.enabled) await as((tx) => connection.setState(tx, current.version, { enabled: false, reason: 'Dừng nhập trong lúc đổi mẫu tệp' }, memberId(LOADER)));
      expect(await as((tx) => sources.items(contextAt(tx, late, true)))).toEqual([]);
    });
  });
});
