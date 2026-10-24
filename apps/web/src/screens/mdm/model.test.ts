import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { changedFields, describeProblem, fieldValue, isCalendarDate, namespaceOf, parseAttributes, proposalRows, recordLink, toChange, toPolicy, toRecord, toUsage, toVersion, validateEdit, validateNewRecord, validateRetire } from './model';
import type { RecordForm } from './model';
import { change, record, version } from './test-support';

const problem = (code: string, detail?: string) => new ApiError({ status: 409, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });

describe('the readers of the answers', () => {
  it('reads a record, a change request, a version and a usage', () => {
    expect(toRecord(record(1))).toMatchObject({ businessKey: 'GT-1', status: 'EFFECTIVE', label: 'Giao thông 1', openChangeRequestId: null, version: 3 });
    expect(toChange(change(1))).toMatchObject({ changeKind: 'UPDATE', status: 'IN_REVIEW', businessKey: 'GT-1', recordVersion: 3, impact: { total: 2, counts: { 'project.sector_master_version_id': 2 } } });
    expect(toVersion(version(1, 2))).toMatchObject({ revision: 2, label: 'Giao thông 1', approvedBy: expect.any(String) });
    expect(toUsage({ total: 1, counts: { 'project.area_master_version_id': 1 }, samples: [{ reference: 'project.area_master_version_id', id: 'p1' }, { id: 'broken' }] })).toEqual({
      total: 1,
      counts: { 'project.area_master_version_id': 1 },
      samples: [{ reference: 'project.area_master_version_id', id: 'p1' }],
    });
  });

  it('drops what it cannot read instead of guessing', () => {
    expect(toRecord(undefined)).toBeUndefined();
    expect(toRecord({ ...record(1), status: 'SOMETHING' })).toBeUndefined();
    expect(toRecord({ ...record(1), version: '3' })).toBeUndefined();
    expect(toChange({ ...change(1), change_kind: 'MERGE' })).toBeUndefined();
    expect(toChange({ ...change(1), status: 'x' })).toBeUndefined();
    expect(toChange({ ...change(1), impact: { counts: 'many', total: 2 } })?.impact).toBeNull();
    expect(toChange({ ...change(1), impact: null })?.impact).toBeNull();
    expect(toVersion({ ...version(1, 1), revision: 'one' })).toBeUndefined();
    expect(toUsage({ total: 'many' })).toBeUndefined();
    expect(toUsage('text')).toBeUndefined();
  });
});

describe('what changed between two versions', () => {
  const first = toVersion(version(1, 1)) ?? fail();
  const second = toVersion(version(1, 2, { label: 'Giao thông vận tải', attributes: { group: 'transport' }, valid_from: '2025-06-01', legal_basis: 'Decision 12' })) ?? fail();

  it('lists every filled field of the first version and only the differences after it', () => {
    expect(changedFields(undefined, first)).toEqual(['label', 'attributes', 'parent', 'validity']);
    expect(changedFields(undefined, second)).toEqual(['label', 'attributes', 'parent', 'validity', 'legalBasis']);
    expect(changedFields(first, second)).toEqual(['label', 'attributes', 'validity', 'legalBasis']);
    expect(changedFields(first, first)).toEqual([]);
  });

  it('does not see a change in the order of the attributes', () => {
    const left = toVersion(version(1, 1, { attributes: { a: 1, b: { c: 2, d: 3 } } })) ?? fail();
    const right = toVersion(version(1, 2, { attributes: { b: { d: 3, c: 2 }, a: 1 } })) ?? fail();
    expect(changedFields(left, right)).toEqual([]);
  });

  it('shows the value of each field as text', () => {
    expect(fieldValue(second, 'label')).toBe('Giao thông vận tải');
    expect(fieldValue(second, 'attributes')).toBe('{"group":"transport"}');
    expect(fieldValue(second, 'parent')).toBe('');
    expect(fieldValue(second, 'validity')).toBe('2025-06-01 →');
    expect(fieldValue(second, 'legalBasis')).toBe('Decision 12');
  });
});

describe('the forms', () => {
  const valid: RecordForm = { masterType: 'SECTOR', businessKey: 'GT', label: 'Giao thông', parentRecordId: '', validFrom: '2024-01-01', validUntil: '', legalBasis: '', attributes: '{"a":1}', reason: 'Initial entry' };

  it('accepts a complete new record', () => {
    expect(validateNewRecord(valid)).toEqual({});
  });

  it('names each problem of a new record', () => {
    expect(validateNewRecord({ ...valid, masterType: '', businessKey: ' ', label: '', reason: '' })).toEqual({ masterType: 'required', businessKey: 'required', label: 'required', reason: 'required' });
    expect(validateNewRecord({ ...valid, masterType: 'x'.repeat(51), businessKey: 'k'.repeat(101), label: 'l'.repeat(501), legalBasis: 'b'.repeat(2001) })).toEqual({
      masterType: 'tooLong',
      businessKey: 'tooLong',
      label: 'tooLong',
      legalBasis: 'tooLong',
    });
    expect(validateNewRecord({ ...valid, reason: 'abc' }).reason).toBe('tooShort');
    expect(validateNewRecord({ ...valid, reason: 'r'.repeat(2001) }).reason).toBe('tooLong');
    expect(validateNewRecord({ ...valid, validFrom: '' }).validFrom).toBe('required');
    expect(validateNewRecord({ ...valid, validFrom: '2024-02-30' }).validFrom).toBe('invalidDate');
    expect(validateNewRecord({ ...valid, validUntil: '2024-01-01' }).validUntil).toBe('order');
    expect(validateNewRecord({ ...valid, validUntil: 'never' }).validUntil).toBe('invalidDate');
    expect(validateNewRecord({ ...valid, validFrom: '', validUntil: '2024-01-01' })).toMatchObject({ validFrom: 'required' });
    expect(validateNewRecord({ ...valid, attributes: '[1]' }).attributes).toBe('invalidJson');
    expect(validateNewRecord({ ...valid, attributes: '{oops' }).attributes).toBe('invalidJson');
  });

  it('reads the attributes text as an object, an empty text as no attributes', () => {
    expect(parseAttributes('')).toEqual({});
    expect(parseAttributes('{"a":{"b":1}}')).toEqual({ a: { b: 1 } });
    expect(parseAttributes('null')).toBeUndefined();
    expect(parseAttributes('"text"')).toBeUndefined();
  });

  it('judges the effective date of a change against the start of the version in force', () => {
    const form = { label: 'New', attributes: '{}', parentRecordId: '', effectiveFrom: '2025-06-01', validUntil: '', legalBasis: '', reason: 'Renamed by decision' };
    expect(validateEdit(form, '2024-01-01')).toEqual({});
    expect(validateEdit({ ...form, effectiveFrom: '2024-01-01' }, '2024-01-01').effectiveFrom).toBe('order');
    expect(validateEdit({ ...form, effectiveFrom: '' }, '2024-01-01').effectiveFrom).toBe('required');
    expect(validateEdit({ ...form, effectiveFrom: 'soon' }, null).effectiveFrom).toBe('invalidDate');
    expect(validateEdit({ ...form, validUntil: '2025-06-01' }, null).validUntil).toBe('order');
    expect(validateEdit({ ...form, validUntil: 'x' }, null).validUntil).toBe('invalidDate');
    expect(validateEdit({ ...form, label: ' ', reason: 'abc', attributes: 'oops' }, null)).toEqual({ label: 'required', reason: 'tooShort', attributes: 'invalidJson' });
  });

  it('knows a calendar date from a string that only looks like one', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2023-02-29')).toBe(false);
    expect(isCalendarDate('24-02-29')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-00-10')).toBe(false);
  });
});

describe('the scope policy and the retirement form', () => {
  const policy = { master_type: 'SECTOR', scope: 'PLATFORM_WITH_TENANT_EXTENSION', retire_requires_successor: true, locked: false, source: 'BASELINE', platform_records: 4, tenant_records: 2 };

  it('reads a policy and drops one that is not complete', () => {
    expect(toPolicy(policy)).toEqual({ masterType: 'SECTOR', scope: 'PLATFORM_WITH_TENANT_EXTENSION', retireRequiresSuccessor: true, locked: false, source: 'BASELINE', platformRecords: 4, tenantRecords: 2 });
    expect(toPolicy({ ...policy, scope: 'EVERYONE' })).toBeUndefined();
    expect(toPolicy({ ...policy, source: 'OTHER' })).toBeUndefined();
    expect(toPolicy({ ...policy, platform_records: '4' })).toBeUndefined();
    expect(toPolicy({ ...policy, retire_requires_successor: 'yes' })?.retireRequiresSuccessor).toBe(false);
    expect(toPolicy(null)).toBeUndefined();
  });

  it('judges a retirement: the date after the start of the version in force, a reason, and a successor where one is required', () => {
    const form = { effectiveFrom: '2026-01-01', successorRecordId: '', reason: 'No longer used' };
    expect(validateRetire(form, '2024-01-01', false)).toEqual({});
    expect(validateRetire(form, '2024-01-01', true)).toEqual({ successorRecordId: 'required' });
    expect(validateRetire({ ...form, successorRecordId: 'r1' }, '2024-01-01', true)).toEqual({});
    expect(validateRetire({ ...form, effectiveFrom: '2024-01-01' }, '2024-01-01', false).effectiveFrom).toBe('order');
    expect(validateRetire({ ...form, effectiveFrom: '' }, null, false).effectiveFrom).toBe('required');
    expect(validateRetire({ ...form, effectiveFrom: '2026-13-01' }, null, false).effectiveFrom).toBe('invalidDate');
    expect(validateRetire({ ...form, reason: 'no' }, null, false).reason).toBe('tooShort');
  });
});

describe('the problems of the commands', () => {
  it('maps the codes the server answers to the reasons the screens show', () => {
    expect(describeProblem(problem('DUPLICATE_KEY'))).toEqual({ reason: 'duplicateKey', field: undefined });
    expect(describeProblem(problem('MASTER_IN_USE')).reason).toBe('inUse');
    expect(describeProblem(problem('SELF_APPROVAL_DENIED')).reason).toBe('selfApproval');
    expect(describeProblem(problem('EFFECTIVE_RANGE_OVERLAP')).reason).toBe('overlap');
    expect(describeProblem(problem('IMPACT_NOT_COMPUTED')).reason).toBe('impactNotComputed');
    expect(describeProblem(problem('CHANGE_NOT_APPROVED')).reason).toBe('notApproved');
    expect(describeProblem(problem('VALIDATION_FAILED', 'valid_until'))).toEqual({ reason: 'validation', field: 'valid_until' });
    expect(describeProblem(problem('SOMETHING_NEW')).reason).toBe('general');
    expect(describeProblem(new Error('lost')).reason).toBe('general');
  });

  it('puts the type and the key of a record in a link, and the namespace when it is the platform', () => {
    expect(recordLink('/mdm/mdm-27', 'SECTOR', 'GT 1/2')).toBe('/mdm/mdm-27?type=SECTOR&key=GT+1%2F2');
    expect(recordLink('/mdm/mdm-27', 'SECTOR', 'GT', 'TENANT')).toBe('/mdm/mdm-27?type=SECTOR&key=GT');
    expect(recordLink('/mdm/mdm-27', 'SECTOR', 'GT', 'PLATFORM')).toBe('/mdm/mdm-27?type=SECTOR&key=GT&ns=PLATFORM');
    expect(namespaceOf('PLATFORM')).toBe('PLATFORM');
    expect(namespaceOf('TENANT')).toBe('TENANT');
    expect(namespaceOf('other')).toBe('TENANT');
    expect(namespaceOf(null)).toBe('TENANT');
  });

  it('reads the namespace of a record and of the entry a change is about', () => {
    expect(toRecord(record(1))?.namespace).toBe('TENANT');
    expect(toRecord(record(1, { namespace: 'PLATFORM' }))?.namespace).toBe('PLATFORM');
    expect(toChange(change(1, { master_record_namespace: 'PLATFORM' }))?.namespace).toBe('PLATFORM');
    expect(toChange(change(1))?.namespace).toBe('TENANT');
  });

  it('lists what a proposal changes against the version in force, field by field', () => {
    const before = { label: 'Giao thông', attributes: { b: 1, a: 2 }, parent_record_id: null, valid_until: null, legal_basis: 'Decision 1' };
    expect(proposalRows(before, { label: 'Giao thông vận tải', attributes: { a: 2, b: 1 }, parent_record_id: null, valid_until: '2030-01-01', legal_basis: 'Decision 1' })).toEqual([
      { field: 'label', before: 'Giao thông', after: 'Giao thông vận tải' },
      { field: 'validUntil', before: '', after: '2030-01-01' },
    ]);
    expect(proposalRows(before, { successor_record_id: 'r2' })).toEqual([{ field: 'successor', before: '', after: 'r2' }]);
    expect(proposalRows(before, {})).toEqual([]);
    expect(proposalRows(null, { label: 'New', attributes: { a: 1 }, valid_until: null })).toEqual([
      { field: 'label', before: null, after: 'New' },
      { field: 'attributes', before: null, after: '{"a":1}' },
    ]);
  });
});

function fail(): never {
  throw new Error('fixture could not be read');
}
