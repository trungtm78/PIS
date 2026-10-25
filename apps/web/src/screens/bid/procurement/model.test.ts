import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { toImportResult, resultOfProblem, describeImportProblem } from './import-model';
import {
  EMPTY_MILESTONE_FORM,
  canImport,
  canManage,
  describeProblem,
  filterLinks,
  formOf,
  localInput,
  milestoneBody,
  milestonesOf,
  momentOfInput,
  projectsOf,
  shortHash,
  toLink,
  toMilestone,
  toTrackedPackage,
  trackedPackages,
  validateMilestone,
  vietnamDay,
} from './model';
import type { MilestoneForm } from './model';
import { SHA, link, milestone, pack } from './test-support';

const NOW = new Date('2026-10-25T03:00:00Z');
const form = (overrides: Partial<MilestoneForm> = {}): MilestoneForm => ({ ...EMPTY_MILESTONE_FORM, kind: 'BID_OPENING', actualAt: '2026-09-01T09:30', ...overrides });
const refusal = (code: string, extensions: Record<string, unknown> = {}) => describeProblem(new ApiError({ status: 409, code, correlationId: 'c', extensions }));

describe('the model of BID-17 and BID-19 (ST-BID-005)', () => {
  it('reads Vietnam time: the day of a moment, the value of a datetime-local control and back', () => {
    expect(vietnamDay('2026-08-31T17:00:00.000Z')).toBe('2026-09-01');
    expect(vietnamDay('2026-08-31T16:59:00.000Z')).toBe('2026-08-31');
    expect(vietnamDay(null)).toBe('');
    expect(vietnamDay('nonsense')).toBe('');
    expect(localInput('2026-09-01T02:30:00.000Z')).toBe('2026-09-01T09:30');
    expect(localInput(null)).toBe('');
    expect(localInput('nonsense')).toBe('');
    expect(momentOfInput('2026-09-01T09:30')).toBe('2026-09-01T02:30:00.000Z');
    for (const bad of ['', '2026-09-01', '2026-09-01 09:30', '2026-02-30T09:30', 'x']) expect(momentOfInput(bad)).toBeUndefined();
  });

  it('reads a package with its version and a milestone, and drops what it cannot place', () => {
    expect(toTrackedPackage(pack(1))).toMatchObject({ id: pack(1).id, code: 'GT-1', status: 'PLANNED', version: 3, project: { code: 'PRJ-001' } });
    for (const bad of [{ id: 7 }, { code: undefined }, { status: undefined }, { version: 'x' }, { project: null }]) expect(toTrackedPackage({ ...pack(1), ...bad })).toBeUndefined();
    expect(toTrackedPackage(undefined)).toBeUndefined();
    expect(toMilestone(milestone(1, 1, 'BID_OPENING'))).toMatchObject({ kind: 'BID_OPENING', source: 'MANUAL', actualAt: '2026-09-01T02:00:00.000Z', plannedAt: null });
    for (const bad of [{ milestone_kind: 'SIGNING' }, { source: 'WEIRD' }, { id: 1 }, { package_id: null }]) expect(toMilestone({ ...milestone(1, 1, 'BID_OPENING'), ...bad })).toBeUndefined();
  });

  it('follows the packages of a plan in force, by code, of the project chosen, and puts the milestones of a package in the order of the kinds', () => {
    const packages = [pack(3), pack(1), pack(2, { status: 'DRAFT' }), pack(4, { status: 'CANCELLED' }), pack(5, { project: { id: 'other', code: 'PRJ-002', name: 'Đường' } })].flatMap((raw) => toTrackedPackage(raw) ?? []);
    expect(trackedPackages(packages, '').map((item) => item.code)).toEqual(['GT-1', 'GT-3', 'GT-5']);
    expect(trackedPackages(packages, 'other').map((item) => item.code)).toEqual(['GT-5']);
    expect(projectsOf(packages).map((project) => project.code)).toEqual(['PRJ-001', 'PRJ-002']);
    const lines = [milestone(2, 1, 'BID_OPENING'), milestone(1, 1, 'INVITATION_PUBLISHED'), milestone(3, 2, 'BID_CLOSING')].flatMap((raw) => toMilestone(raw) ?? []);
    expect(milestonesOf(pack(1).id, lines).map((line) => line.kind)).toEqual(['INVITATION_PUBLISHED', 'BID_OPENING']);
  });

  it('lets a session record or import only with the permission and not in read-only mode', () => {
    expect(canManage(['bid.plan.manage'], 'FULL')).toBe(true);
    expect(canManage(['bid.plan.manage'], undefined)).toBe(true);
    expect(canManage(['bid.plan.manage'], 'READ_ONLY')).toBe(false);
    expect(canManage(['bid.read'], 'FULL')).toBe(false);
    expect(canManage(undefined, 'FULL')).toBe(false);
    expect(canImport(['bid.import'], 'FULL')).toBe(true);
    expect(canImport(['bid.import'], 'READ_ONLY')).toBe(false);
    expect(canImport(['bid.read'], 'FULL')).toBe(false);
  });

  it('starts the form of a milestone from its dates, and asks a kind, one date, real dates and an actual date that has come', () => {
    const line = toMilestone(milestone(1, 1, 'BID_OPENING', { planned_at: '2026-08-30T02:00:00.000Z' }));
    expect(line && formOf(line)).toEqual({ kind: 'BID_OPENING', plannedAt: '2026-08-30T09:00', actualAt: '2026-09-01T09:00' });
    expect(validateMilestone(form(), NOW)).toEqual({});
    expect(validateMilestone(form({ actualAt: '', plannedAt: '2026-12-01T09:00' }), NOW)).toEqual({});
    expect(validateMilestone({ ...EMPTY_MILESTONE_FORM }, NOW)).toEqual({ kind: 'required', plannedAt: 'noDate' });
    expect(validateMilestone(form({ actualAt: '2026-02-30T09:00' }), NOW)).toEqual({ actualAt: 'date' });
    expect(validateMilestone(form({ plannedAt: 'tomorrow' }), NOW)).toEqual({ plannedAt: 'date' });
    expect(validateMilestone(form({ actualAt: '2026-10-26T09:00' }), NOW)).toEqual({ actualAt: 'future' });
  });

  it('builds the body of a record and leaves out a date that is empty', () => {
    expect(milestoneBody(form())).toEqual({ milestone_kind: 'BID_OPENING', actual_at: '2026-09-01T02:30:00.000Z' });
    expect(milestoneBody(form({ plannedAt: '2026-08-30T10:00' }))).toEqual({ milestone_kind: 'BID_OPENING', planned_at: '2026-08-30T03:00:00.000Z', actual_at: '2026-09-01T02:30:00.000Z' });
    expect(milestoneBody(form({ actualAt: '', plannedAt: '2026-08-30T10:00' }))).toEqual({ milestone_kind: 'BID_OPENING', planned_at: '2026-08-30T03:00:00.000Z' });
  });

  it('sorts a refusal of the server by its code and names the two milestones that break the order', () => {
    expect(refusal('MILESTONE_ORDER_INVALID', { earlier_kind: 'BID_CLOSING', later_kind: 'BID_OPENING' })).toEqual({ problem: 'orderInvalid', earlier: 'BID_CLOSING', later: 'BID_OPENING' });
    expect(refusal('MILESTONE_ORDER_INVALID', { earlier_kind: 'NOT_A_KIND' })).toEqual({ problem: 'orderInvalid', earlier: undefined, later: undefined });
    expect(refusal('VERSION_CONFLICT').problem).toBe('versionConflict');
    expect(refusal('PACKAGE_STATE_INVALID').problem).toBe('packageState');
    for (const code of ['VALIDATION_FAILED', 'INVALID_REQUEST', 'FIELD_NOT_ALLOWED']) expect(refusal(code).problem).toBe('validation');
    expect(refusal('RESOURCE_NOT_FOUND').problem).toBe('notFound');
    for (const code of ['SCOPE_DENIED', 'ENTITLEMENT_DENIED']) expect(refusal(code).problem).toBe('denied');
    expect(refusal('SESSION_EXPIRED').problem).toBe('session');
    expect(refusal('SOMETHING_ELSE').problem).toBe('general');
    expect(describeProblem(new Error('x')).problem).toBe('general');
  });

  it('reads a link with the milestones and the code that differ, the owner and the batch, and filters by status', () => {
    const different = toLink(
      link(2, 2, {
        diff_status: 'DIFFERENT',
        diff: { milestones: { BID_OPENING: { register: 'a', file: 'b' }, BID_CLOSING: { register: 'c' } }, external_code: { register: 'TBMT-1', file: 'TBMT-9' } },
        diff_owner: { membership_id: 'm', display_name: 'An' },
      }),
    );
    expect(different).toMatchObject({ packageCode: 'GT-2', externalCode: 'TBMT-2', diffStatus: 'DIFFERENT', ownerName: 'An', fileSha256: SHA, adapterStatus: 'PROPOSED' });
    expect(different?.milestoneDifferences).toEqual([{ kind: 'BID_OPENING', register: 'a', file: 'b' }]);
    expect(different?.codeDifference).toEqual({ register: 'TBMT-1', file: 'TBMT-9' });
    const plain = toLink(link(1, 1, { batch: null, project: undefined, diff: null }));
    expect(plain).toMatchObject({ projectCode: '', fileSha256: null, appliedAt: null, ownerName: null, codeDifference: null, milestoneDifferences: [] });
    for (const bad of [{ id: 1 }, { package_id: null }, { package_code: null }, { external_code: null }, { diff_status: 'WEIRD' }]) expect(toLink({ ...link(1, 1), ...bad })).toBeUndefined();
    const lines = [toLink(link(1, 1)), different].flatMap((item) => item ?? []);
    expect(filterLinks(lines, '').length).toBe(2);
    expect(filterLinks(lines, 'DIFFERENT').map((item) => item.packageCode)).toEqual(['GT-2']);
    expect(shortHash(SHA)).toBe('aaaaaaaaaaaa');
    expect(shortHash(null)).toBe('');
  });
});

describe('the import result of BID-19', () => {
  const dry = {
    status: 'DRY_RUN',
    mode: 'DRY_RUN',
    adapter: { status: 'PROPOSED' },
    already_applied: false,
    counts: { total: 3, valid: 2, duplicate: 0, conflict: 0, errors: 1 },
    rows: [
      { line: 2, status: 'VALID', outcome: 'CREATE', preview: { package_code: 'GT-1', milestone_kind: 'BID_OPENING' } },
      { line: 4, status: 'ERROR', code: 'PACKAGE_NOT_FOUND', field: 'package_code', preview: { package_code: 'GT-X', milestone_kind: 'BID_OPENING' } },
      { line: 5, status: 'WEIRD' },
    ],
    rows_truncated: false,
  };

  it('reads a dry run row by row, and an apply from its counts and its errors', () => {
    const preview = toImportResult(dry);
    expect(preview).toMatchObject({ dryRun: true, adapterStatus: 'PROPOSED', alreadyApplied: false, counts: { total: 3, valid: 2, errors: 1 }, truncated: false });
    expect(preview?.rows.map((row) => [row.line, row.packageCode, row.milestoneKind, row.status, row.outcome, row.code])).toEqual([
      [2, 'GT-1', 'BID_OPENING', 'VALID', 'CREATE', null],
      [4, 'GT-X', 'BID_OPENING', 'ERROR', null, 'PACKAGE_NOT_FOUND'],
    ]);
    const applied = toImportResult({
      mode: 'APPLY',
      counts: { total: 3, applied: 2, duplicate: 0, conflict: 0, quarantined: 1, differencesOpened: 1 },
      milestones_written: 2,
      errors: [{ line: 4, code: 'PACKAGE_NOT_FOUND', field: 'package_code', preview: { package_code: 'GT-X' } }],
      errors_truncated: true,
    });
    expect(applied).toMatchObject({ dryRun: false, written: 2, differences: 1, truncated: true, counts: { total: 3, valid: 2, errors: 1 } });
    expect(applied?.rows).toEqual([{ line: 4, packageCode: 'GT-X', milestoneKind: null, status: 'ERROR', outcome: null, code: 'PACKAGE_NOT_FOUND', field: 'package_code' }]);
    expect(toImportResult(undefined)).toBeUndefined();
    expect(toImportResult({ counts: {} })).toBeUndefined();
  });

  it('reads the result a refused import carries in its problem, and sorts the refusals of the file', () => {
    const refused = new ApiError({ status: 422, code: 'IMPORT_HAS_ERRORS', correlationId: 'c', extensions: { counts: { total: 1, applied: 0, duplicate: 0, conflict: 0, quarantined: 1, differencesOpened: 0 }, errors: [{ line: 2, code: 'PACKAGE_NOT_FOUND' }] } });
    expect(resultOfProblem(refused)?.rows).toHaveLength(1);
    expect(resultOfProblem(new Error('x'))).toBeUndefined();
    const sorted: Array<[string, string]> = [
      ['IMPORT_FILE_ALREADY_APPLIED', 'alreadyApplied'],
      ['IMPORT_HAS_ERRORS', 'hasErrors'],
      ['HASH_MISMATCH', 'hashMismatch'],
      ['IMPORT_SCHEMA_INVALID', 'schemaInvalid'],
      ['IMPORT_EMPTY', 'empty'],
      ['FILE_NOT_CLEAN', 'fileRefused'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['SCOPE_DENIED', 'denied'],
      ['OTHER', 'general'],
    ];
    for (const [code, problem] of sorted) expect(describeImportProblem(new ApiError({ status: 422, code, correlationId: 'c' }))).toBe(problem);
    expect(describeImportProblem(new Error('x'))).toBe('general');
  });
});
