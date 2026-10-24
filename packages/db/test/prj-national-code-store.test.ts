import { randomUUID } from 'node:crypto';
import { NATIONAL_CODE_CONNECTOR, NATIONAL_CODE_FORMAT_VERSION, fileSha256, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { previewFileImport } from '../src/file-import-preview';
import { FileImportStore } from '../src/file-import-store';
import { BASELINE_PACK, applyBaseline } from '../src/master-baseline';
import { MasterRules } from '../src/master-rules';
import { NationalCodeGate, PrjNationalCodeStore, hasCodeFormat, nationalCodeOf } from '../src/prj-national-code-store';
import type { NationalCodeAssignRequest } from '../src/prj-national-code-store';
import { PrjProjectStore, projectScope } from '../src/prj-project-store';
import type { ProjectStatus } from '../src/prj-project-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';

const harness = new AuthzHarness();
const projects = new PrjProjectStore();
const codes = new PrjNationalCodeStore();
const imports = new FileImportStore();
const gate = new NationalCodeGate();
const TODAY = vietnamDateOf(new Date());
const ACTOR = 1;
const WORKER = '00000000-0000-4000-8000-000000000000';
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;

const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });
const grant = (permission: string, scope: Scope): EffectiveAccess => ({
  membershipId: memberId(ACTOR),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'TEST', rank: 10, permissions: [permission], scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const subtree = (permission: string, unit: number, path: string): ScopeBuilder => projectScope(grant(permission, { kind: 'UNIT_SUBTREE', refIds: [unitId(unit)], paths: [path] }), permission, new Date());

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(ACTOR)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

let counter = 0;
let areaVersion = '';
let areaVersionB = '';

async function seedArea(tenant: string): Promise<string> {
  const recordId = randomUUID();
  const versionId = randomUUID();
  await harness.owner(tenant, [
    [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', $3, 'EFFECTIVE', $4, $4)`, [tenant, recordId, `AREA-${tenant.slice(-1)}`, memberId(ACTOR)]],
    [
      `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
       values ($1, $2, 'AREA', $3, 1, 'Area', '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $4, now(), $5, $5)`,
      [tenant, versionId, `AREA-${tenant.slice(-1)}`, recordId, memberId(ACTOR)],
    ],
  ]);
  return versionId;
}

async function document(status = 'EFFECTIVE'): Promise<string> {
  const id = randomUUID();
  await owner(
    `insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, symbol, issued_on, effect_status, classification, created_by, updated_by)
     values ($1, $2, 'REFERENCE', 'QD', 'A decision', $3, '2026-01-15', $4, 'INTERNAL', $5, $5)`,
    [TENANT_A, id, `QD-${id.slice(0, 8)}/2026`, status, memberId(ACTOR)],
  );
  return id;
}

interface Seeded {
  id: string;
  code: string;
  version: number;
}

/** A project of the register, moved straight to a stage by the owner the way the stories that come before this one leave it. */
async function project(status: ProjectStatus = 'BUDGETED', options: { nationalCode?: string | null; unit?: number; tenant?: string } = {}): Promise<Seeded> {
  counter += 1;
  const tenant = options.tenant ?? TENANT_A;
  const code = `NC-${counter}-${randomUUID().slice(0, 6)}`;
  const created = await as(
    (tx) => projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(options.unit ?? DEPARTMENT), areaMasterVersionId: tenant === TENANT_A ? areaVersion : areaVersionB, totalInvestmentVnd: '500000000000' }, memberId(ACTOR), TODAY),
    tenant,
  );
  await owner('update machvon.project set status = $2, project_group = $3, national_project_code = $4 where id = $1::uuid', [created.id, status, ['CONCEPT', 'APPRAISAL', 'REJECTED', 'CANCELLED'].includes(status) ? null : 'B', options.nationalCode ?? null], tenant);
  return { id: created.id, code, version: 1 };
}

/** A unique seven-digit code (the format the baseline rule says). */
const freshCode = (): string => String(7_000_000 + ++counter);

const row = async (projectId: string) => (await owner<Record<string, unknown>>('select * from machvon.project where id = $1::uuid', [projectId]))[0] as Record<string, unknown>;

const assign = (target: Seeded, nationalCode: string, options: Partial<NationalCodeAssignRequest> & { version?: number; act?: ScopeBuilder; read?: ScopeBuilder } = {}) =>
  as((tx) =>
    codes.assign(tx, {
      projectId: target.id,
      expectedVersion: options.version ?? target.version,
      actor: memberId(ACTOR),
      scopes: { act: options.act ?? everything, read: options.read ?? everything },
      nationalCode,
      evidenceDocumentId: options.evidenceDocumentId,
      today: TODAY,
    }),
  );

const csv = (...lines: string[]): Uint8Array => new TextEncoder().encode(['internal_code,national_project_code', ...lines].join('\n'));

async function runImport(bytes: Uint8Array, scope: ScopeBuilder = everything) {
  return as(async (tx) => {
    const adapter = await codes.importAdapter(tx, { scope, actor: memberId(ACTOR), today: TODAY });
    const result = await imports.run(tx, { adapter, bytes, fileObjectKey: `tenants/${TENANT_A}/import/${randomUUID()}`, importedBy: memberId(ACTOR), fallbackOwnerId: memberId(ACTOR), correlationId: randomUUID(), cursorScope: 'DEFAULT' });
    return { adapter, result, quarantined: await imports.quarantined(tx, result.importId, 100) };
  });
}

const dryRun = (bytes: Uint8Array, scope: ScopeBuilder = everything) =>
  as(async (tx) => previewFileImport(tx, await codes.importAdapter(tx, { scope, actor: memberId(ACTOR), today: TODAY }), bytes));

async function setRuleMode(mode: 'BLOCK' | 'WARN'): Promise<void> {
  await owner(
    `update machvon.master_record_version v set attributes = jsonb_set(attributes, '{mode}', to_jsonb($1::text)) from machvon.master_record r where r.id = v.master_record_id and r.master_type = 'NATIONAL_CODE_REQUIRED'`,
    [mode],
  );
}

jest.setTimeout(180_000);

describe('PrjNationalCodeStore (the national project code, ST-PRJ-004)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: OTHER_BRANCH, path: '/u3/' },
      ]);
      await harness.seedMembership(tenant, ACTOR, PROVINCE);
      await harness.tenants.withTenant({ tenantId: tenant, membershipId: WORKER, scopeVersion: 0 }, (tx) => applyBaseline(tx, BASELINE_PACK, WORKER, TODAY));
    }
    areaVersion = await seedArea(TENANT_A);
    areaVersionB = await seedArea(TENANT_B);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the code as it is stored and judged', () => {
    it('AC-ST-PRJ-004-1: a code is trimmed and bounded, and the format is the one of the rule in force (a format of none accepts any)', () => {
      expect(nationalCodeOf('  7654321  ')).toBe('7654321');
      for (const bad of ['', '   ', 'x'.repeat(51), 'a\u0007b', 'a\nb']) expect(() => nationalCodeOf(bad)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', detail: 'national_project_code' }));
      expect(nationalCodeOf('x'.repeat(50))).toHaveLength(50);
      const rule = { mode: 'BLOCK', fromStageKey: 'PIPELINE', format: { pattern: '^\\d{7}$', example: '7654321' }, reading: {} } as never;
      expect(hasCodeFormat(rule, '7654321')).toBe(true);
      expect(hasCodeFormat(rule, '765432')).toBe(false);
      expect(hasCodeFormat(rule, 'ABCDEFG')).toBe(false);
      expect(hasCodeFormat({ ...(rule as object), format: null } as never, 'anything')).toBe(true);
      expect(hasCodeFormat(undefined, 'anything')).toBe(true);
    });

    it('AC-ST-PRJ-004-1: the database refuses a code with a space around it, an empty one and a long one, whatever wrote it', async () => {
      const target = await project();
      for (const bad of [' 7000001', '7000001 ', '', 'x'.repeat(51)]) {
        await expect(owner('update machvon.project set national_project_code = $2 where id = $1::uuid', [target.id, bad])).rejects.toMatchObject({ code: '23514' });
      }
      await owner('update machvon.project set national_project_code = $2 where id = $1::uuid', [target.id, freshCode()]);
    });
  });

  describe('the assignment by hand', () => {
    it('AC-ST-PRJ-004-1: gives a BUDGETED project without a code the code it is given, under a new version, and says what it was', async () => {
      const target = await project('BUDGETED');
      const code = freshCode();
      const done = await assign(target, ` ${code} `);
      expect(done).toMatchObject({ projectId: target.id, code: target.code, status: 'BUDGETED', version: 2, previous: null, current: code, changed: true, via: 'MANUAL', evidenceDocumentId: null });
      expect(await row(target.id)).toMatchObject({ national_project_code: code, version: '2', status: 'BUDGETED', updated_by: memberId(ACTOR) });
    });

    it('AC-ST-PRJ-004-1: the same code again changes nothing: no new version', async () => {
      const code = freshCode();
      const target = await project('BUDGETED', { nationalCode: code });
      const done = await assign(target, code);
      expect(done).toMatchObject({ changed: false, version: 1, previous: code, current: code });
      expect((await row(target.id)).version).toBe('1');
    });

    it('AC-ST-PRJ-004-1: a code that does not have the format of the rule is 422 NATIONAL_CODE_FORMAT_INVALID', async () => {
      const target = await project();
      for (const bad of ['765432', 'ABCDEFG', '76543210', '7654 321']) {
        expect(await refusal(assign(target, bad))).toEqual({ code: 'NATIONAL_CODE_FORMAT_INVALID', status: 422, detail: 'national_project_code' });
      }
      expect(await refusal(assign(target, ''))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
      expect((await row(target.id)).national_project_code).toBeNull();
    });

    it('AC-ST-PRJ-004-2: a code held by another project of the tenant is 409 NATIONAL_CODE_DUPLICATE; another tenant may hold the same one', async () => {
      const code = freshCode();
      await project('BUDGETED', { nationalCode: code });
      const target = await project();
      expect(await refusal(assign(target, code))).toEqual({ code: 'NATIONAL_CODE_DUPLICATE', status: 409, detail: 'national_project_code' });
      const foreign = await project('BUDGETED', { tenant: TENANT_B });
      const done = await as((tx) => codes.assign(tx, { projectId: foreign.id, expectedVersion: 1, actor: memberId(ACTOR), scopes: { act: everything, read: everything }, nationalCode: code, today: TODAY }), TENANT_B);
      expect(done.changed).toBe(true);
    });

    it('AC-ST-PRJ-004-2: of two assignments of one code at once exactly one wins and the other is told 409, not a failed transaction', async () => {
      const code = freshCode();
      const first = await project();
      const second = await project();
      const outcomes = await Promise.allSettled([assign(first, code), assign(second, code)]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const lost = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      expect(lost?.reason).toMatchObject({ code: 'NATIONAL_CODE_DUPLICATE', status: 409 });
      expect(await owner('select count(*)::int as n from machvon.project where national_project_code = $1', [code])).toEqual([{ n: 1 }]);
    });

    it('AC-ST-PRJ-004-2: the write turns the unique index into 409 NATIONAL_CODE_DUPLICATE under a savepoint and leaves the transaction usable', async () => {
      const code = freshCode();
      await project('BUDGETED', { nationalCode: code });
      const target = await project();
      await as(async (tx) => {
        await expect(codes.setCode(tx, target.id, code, memberId(ACTOR), 2)).rejects.toMatchObject({ code: 'NATIONAL_CODE_DUPLICATE', status: 409, detail: 'national_project_code' });
        expect(await tx.query('select 1 as ok')).toEqual([{ ok: 1 }]);
        await codes.setCode(tx, target.id, freshCode(), memberId(ACTOR), 2);
      });
      expect((await row(target.id)).version).toBe('2');
    });

    it('AC-ST-PRJ-004-1: a project that has ended keeps its code (422 STAGE_LOCKED_FIELD)', async () => {
      for (const status of ['CLOSED', 'REJECTED', 'CANCELLED'] as const) {
        const ended = await project(status);
        expect(await refusal(assign(ended, freshCode()))).toEqual({ code: 'STAGE_LOCKED_FIELD', status: 422, detail: 'national_project_code' });
      }
    });

    it('AC-ST-PRJ-004-1: once a project is under way, changing the code it holds needs the document that grounds it; a first assignment does not', async () => {
      for (const status of ['IMPLEMENTATION', 'SUSPENDED', 'COMPLETED', 'SETTLED'] as const) {
        const held = await project(status, { nationalCode: freshCode() });
        const fresh = freshCode();
        expect(await refusal(assign(held, fresh))).toEqual({ code: 'DECISION_REQUIRED', status: 422, detail: 'evidence_document_id' });
        expect(await refusal(assign(held, fresh, { evidenceDocumentId: await document('RECALLED') }))).toMatchObject({ code: 'DECISION_REQUIRED' });
        expect(await refusal(assign(held, fresh, { evidenceDocumentId: 'nope' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'evidence_document_id' });
        const evidence = await document();
        const done = await assign(held, fresh, { evidenceDocumentId: evidence });
        expect(done).toMatchObject({ changed: true, version: 2, current: fresh, evidenceDocumentId: evidence });
        expect(done.previous).not.toBeNull();
      }
      const firstTime = await project('IMPLEMENTATION');
      expect((await assign(firstTime, freshCode())).changed).toBe(true);
      const early = await project('BUDGETED', { nationalCode: freshCode() });
      expect((await assign(early, freshCode())).changed).toBe(true);
    });

    it('AC-ST-PRJ-004-1: the version must be the one seen (409), and a project out of sight is 404 and one that is readable but not the caller\'s to change is 403', async () => {
      const target = await project();
      expect(await refusal(assign(target, freshCode(), { version: 5 }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(assign(target, freshCode(), { act: nothing, read: nothing }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(assign(target, freshCode(), { act: nothing, read: everything }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      const elsewhere = await project('BUDGETED', { unit: OTHER_BRANCH });
      expect(await refusal(assign(elsewhere, freshCode(), { act: subtree('project.national_code.manage', DEPARTMENT, '/u1/u2/'), read: everything }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect((await row(target.id)).national_project_code).toBeNull();
    });
  });

  describe('the rule that requires the code (BLOCK or WARN) read by the modules that ask', () => {
    it('AC-ST-PRJ-004-1: the gate says UNMET for a project without a code under BLOCK, MET with one, and WARNING under WARN', async () => {
      const without = await project('PIPELINE');
      const withCode = await project('PIPELINE', { nationalCode: freshCode() });
      const readings = await as((tx) => gate.assess(tx, [without.id, withCode.id, randomUUID()], TODAY));
      const byId = new Map(readings.map((entry) => [entry.projectId, entry.reading]));
      expect(byId.size).toBe(2);
      expect(byId.get(without.id)).toMatchObject({ key: 'NATIONAL_CODE', state: 'UNMET', refusal: { code: 'NATIONAL_CODE_REQUIRED', status: 422 } });
      expect(byId.get(withCode.id)).toEqual({ key: 'NATIONAL_CODE', state: 'MET' });
      await setRuleMode('WARN');
      try {
        const warned = await as((tx) => gate.assess(tx, [without.id], TODAY));
        expect(warned[0]?.reading).toEqual({ key: 'NATIONAL_CODE', state: 'WARNING' });
      } finally {
        await setRuleMode('BLOCK');
      }
      expect(await as((tx) => gate.assess(tx, [], TODAY))).toEqual([]);
    });
  });

  describe('the reconciliation file', () => {
    it('AC-ST-PRJ-004-2: three rows with one code twice: the dry run tells the row error, the apply takes the valid rows, the second apply answers that the file was applied', async () => {
      const [a, b, c] = [await project('BUDGETED'), await project('BUDGETED'), await project('BUDGETED')] as [Seeded, Seeded, Seeded];
      const first = freshCode();
      const second = freshCode();
      const bytes = csv(`${a.code},${first}`, `${b.code},${second}`, `${c.code},${first}`);
      const preview = await dryRun(bytes);
      expect(preview).toMatchObject({ fileSha256: fileSha256(bytes), connectorCode: NATIONAL_CODE_CONNECTOR, formatVersion: NATIONAL_CODE_FORMAT_VERSION, alreadyApplied: false, counts: { total: 3, valid: 2, duplicate: 0, conflict: 0, errors: 1 } });
      expect(preview.rows.map((entry) => [entry.line, entry.businessKey, entry.status, entry.outcome ?? entry.code])).toEqual([
        [2, a.code, 'VALID', 'ASSIGN'],
        [3, b.code, 'VALID', 'ASSIGN'],
        [4, c.code, 'ERROR', 'NATIONAL_CODE_DUPLICATE'],
      ]);
      expect(preview.rows[2]?.preview).toEqual({ internal_code: c.code, national_project_code: first });
      expect(preview.rows[0]?.preview).toEqual({ internal_code: a.code, national_project_code: first });
      // The dry run wrote nothing: not the file, not a row, not a project.
      expect(await owner('select count(*)::int as n from machvon.file_import where file_sha256 = $1', [fileSha256(bytes)])).toEqual([{ n: 0 }]);
      expect((await row(a.id)).national_project_code).toBeNull();

      const applied = await runImport(bytes);
      expect(applied.result).toMatchObject({ outcome: 'APPLIED', counts: { total: 3, applied: 2, duplicate: 0, conflict: 0, quarantined: 1, differencesOpened: 0 } });
      expect(applied.quarantined).toMatchObject([{ line: 4, businessKey: c.code, errorCode: 'NATIONAL_CODE_DUPLICATE', field: 'national_project_code', maskedPreview: { internal_code: c.code, national_project_code: first } }]);
      expect(applied.adapter.assigned.map((entry) => [entry.code, entry.current, entry.version, entry.via, entry.importId])).toEqual([
        [a.code, first, 2, 'IMPORT', applied.result.importId],
        [b.code, second, 2, 'IMPORT', applied.result.importId],
      ]);
      expect(await row(a.id)).toMatchObject({ national_project_code: first, version: '2' });
      expect(await row(b.id)).toMatchObject({ national_project_code: second, version: '2' });
      expect((await row(c.id)).national_project_code).toBeNull();

      const again = await runImport(bytes);
      expect(again.result.outcome).toBe('ALREADY_IMPORTED');
      expect(again.adapter.assigned).toEqual([]);
      expect(again.result.importId).toBe(applied.result.importId);
      const after = await dryRun(bytes);
      expect(after.alreadyApplied).toBe(true);
      // Every row that was applied is a repeat now, and the row that was refused is still refused.
      expect(after.counts).toMatchObject({ duplicate: 2, valid: 0, errors: 1 });
    });

    it('AC-ST-PRJ-004-2: a project that is not in the register, outside the scope, ended, with a code of the wrong format or one that another project holds, is a row error with its code', async () => {
      const inScope = await project('BUDGETED');
      const elsewhere = await project('BUDGETED', { unit: OTHER_BRANCH });
      const ended = await project('CLOSED');
      const formatted = await project('BUDGETED');
      const holder = await project('BUDGETED', { nationalCode: freshCode() });
      const claimed = await project('BUDGETED');
      const heldCode = (await row(holder.id)).national_project_code as string;
      const bytes = csv(`${inScope.code},${freshCode()}`, `${elsewhere.code},${freshCode()}`, `NO-SUCH-PROJECT,${freshCode()}`, `${ended.code},${freshCode()}`, `${formatted.code},ABC-123`, `${claimed.code},${heldCode}`);
      const scoped = subtree('project.national_code.manage', DEPARTMENT, '/u1/u2/');
      const preview = await dryRun(bytes, scoped);
      expect(preview.rows.map((entry) => [entry.businessKey === inScope.code ? 'in-scope' : entry.businessKey, entry.status, entry.code ?? entry.outcome])).toEqual([
        ['in-scope', 'VALID', 'ASSIGN'],
        [elsewhere.code, 'ERROR', 'PROJECT_NOT_FOUND'],
        ['NO-SUCH-PROJECT', 'ERROR', 'PROJECT_NOT_FOUND'],
        [ended.code, 'ERROR', 'PROJECT_STAGE_LOCKED'],
        [formatted.code, 'ERROR', 'NATIONAL_CODE_FORMAT_INVALID'],
        [claimed.code, 'ERROR', 'NATIONAL_CODE_DUPLICATE'],
      ]);
      const applied = await runImport(bytes, scoped);
      expect(applied.result.counts).toMatchObject({ total: 6, applied: 1, quarantined: 5 });
      expect(applied.quarantined.map((entry) => [entry.line, entry.errorCode, entry.field])).toEqual([
        [3, 'PROJECT_NOT_FOUND', 'internal_code'],
        [4, 'PROJECT_NOT_FOUND', 'internal_code'],
        [5, 'PROJECT_STAGE_LOCKED', 'internal_code'],
        [6, 'NATIONAL_CODE_FORMAT_INVALID', 'national_project_code'],
        [7, 'NATIONAL_CODE_DUPLICATE', 'national_project_code'],
      ]);
      expect((await row(elsewhere.id)).national_project_code).toBeNull();
    });

    it('AC-ST-PRJ-004-2: a project that holds another code is not overwritten: the disagreement is a difference with an owner; the same code is a repeat', async () => {
      const held = await project('IMPLEMENTATION', { nationalCode: freshCode() });
      const same = await project('BUDGETED', { nationalCode: freshCode() });
      const heldCode = (await row(held.id)).national_project_code as string;
      const sameCode = (await row(same.id)).national_project_code as string;
      const proposed = freshCode();
      const bytes = csv(`${held.code},${proposed}`, `${same.code},${sameCode}`);
      const preview = await dryRun(bytes);
      expect(preview.rows.map((entry) => [entry.status, entry.outcome])).toEqual([
        ['VALID', 'MISMATCH'],
        ['VALID', 'UNCHANGED'],
      ]);
      const applied = await runImport(bytes);
      expect(applied.result.counts).toMatchObject({ applied: 2, differencesOpened: 1, quarantined: 0 });
      expect(applied.adapter.assigned).toEqual([]);
      expect(await row(held.id)).toMatchObject({ national_project_code: heldCode, version: '1' });
      const items = await owner<{ code: string; expected: string; actual: string; owner_membership_id: string; status: string }>(
        `select code, expected_value as expected, actual_value as actual, owner_membership_id, status from machvon.file_import_reconciliation_item where import_id = $1::uuid`,
        [applied.result.importId],
      );
      expect(items).toEqual([{ code: 'NATIONAL_CODE_MISMATCH', expected: heldCode, actual: proposed, owner_membership_id: memberId(ACTOR), status: 'OPEN' }]);
    });

    it('AC-ST-PRJ-004-2: a row that was applied before is a repeat in another file, and the same project with another code opens a conflict', async () => {
      const target = await project('BUDGETED');
      const code = freshCode();
      await runImport(csv(`${target.code},${code}`));
      const repeated = csv(`${target.code},${code}`, `${(await project('BUDGETED')).code},${freshCode()}`);
      const preview = await dryRun(repeated);
      expect(preview.rows.map((entry) => entry.status)).toEqual(['DUPLICATE', 'VALID']);
      const conflicting = csv(`${target.code},${freshCode()}`);
      expect((await dryRun(conflicting)).rows.map((entry) => entry.status)).toEqual(['CONFLICT']);
      const ran = await runImport(conflicting);
      expect(ran.result.counts).toMatchObject({ conflict: 1, applied: 0, differencesOpened: 1 });
    });

    it('AC-ST-PRJ-004-2: two rows of one file for the same project: the first by the order of the keys wins, the other is a conflict', async () => {
      const target = await project('BUDGETED');
      const bytes = csv(`${target.code},${freshCode()}`, `${target.code},${freshCode()}`);
      const preview = await dryRun(bytes);
      expect(preview.rows.map((entry) => entry.status)).toEqual(['VALID', 'CONFLICT']);
      const ran = await runImport(bytes);
      expect(ran.result.counts).toMatchObject({ applied: 1, conflict: 1 });
    });

    it('a file that cannot be read is refused as the framework refuses it, and a connector that is paused takes no file', async () => {
      const unreadable = new TextEncoder().encode('name,code\nA,1');
      await expect(dryRun(unreadable)).rejects.toMatchObject({ code: 'IMPORT_SCHEMA_INVALID', status: 422 });
      await expect(dryRun(csv())).rejects.toMatchObject({ code: 'IMPORT_EMPTY', status: 422 });
      const failed = await runImport(unreadable);
      expect(failed.result).toMatchObject({ outcome: 'FAILED', errorCode: 'IMPORT_SCHEMA_INVALID' });
      const [cursor] = await owner<{ status: string }>(`select status from machvon.integration_cursor where connector_code = $1 and source_scope = 'DEFAULT'`, [NATIONAL_CODE_CONNECTOR]);
      if (cursor === undefined) {
        await owner(
          `insert into machvon.integration_cursor (tenant_id, id, connector_code, source_scope, cursor_json, schema_version, adapter_status, status) values ($1, gen_random_uuid(), $2, 'DEFAULT', '{}'::jsonb, '1', 'PROPOSED', 'PAUSED')`,
          [TENANT_A, NATIONAL_CODE_CONNECTOR],
        );
      } else {
        await owner(`update machvon.integration_cursor set status = 'PAUSED' where connector_code = $1 and source_scope = 'DEFAULT'`, [NATIONAL_CODE_CONNECTOR]);
      }
      try {
        expect(await refusal(runImport(csv(`${(await project()).code},${freshCode()}`)))).toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
      } finally {
        await owner(`update machvon.integration_cursor set status = 'ACTIVE', last_error_code = null where connector_code = $1 and source_scope = 'DEFAULT'`, [NATIONAL_CODE_CONNECTOR]);
      }
    });

    it('reads the rule data of the day once for the file: the format of the rule is the format of every row', async () => {
      const rule = await as((tx) => new MasterRules().nationalCode(tx, TODAY));
      expect(rule?.format?.pattern).toBe('^\\d{7}$');
    });
  });
});
