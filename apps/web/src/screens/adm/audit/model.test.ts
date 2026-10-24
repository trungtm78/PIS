import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_EXPORT,
  EMPTY_FILTER,
  describeProblem,
  exportBody,
  filterQuery,
  hasFilter,
  resourceTypesOf,
  shortHash,
  toAuditEvent,
  toAuditPage,
  toExportDone,
  toSealView,
  validateExport,
  validateFilter,
} from './model';

const ROW = {
  id: 'e1',
  seq: 7,
  actor_id: 'a1',
  action: 'widget.change',
  resource_type: 'widget',
  resource_id: 'r1',
  safe_diff: { n: 1 },
  reason: null,
  outcome: 'SUCCESS',
  classification: 'INTERNAL',
  impersonator_id: null,
  on_behalf_of_id: null,
  occurred_at: '2026-03-01T10:00:00.123Z',
  seal_hash: 'a'.repeat(64),
};

describe('toAuditEvent', () => {
  it('reads a row of the audit read', () => {
    expect(toAuditEvent(ROW)).toEqual({
      id: 'e1',
      seq: 7,
      actorId: 'a1',
      action: 'widget.change',
      resourceType: 'widget',
      resourceId: 'r1',
      safeDiff: { n: 1 },
      reason: null,
      outcome: 'SUCCESS',
      classification: 'INTERNAL',
      impersonatorId: null,
      onBehalfOfId: null,
      occurredAt: '2026-03-01T10:00:00.123Z',
      sealHash: 'a'.repeat(64),
    });
  });

  it('keeps a row that is not sealed yet and a diff that is not an object, and falls back to INTERNAL', () => {
    expect(toAuditEvent({ ...ROW, seal_hash: undefined, safe_diff: 'text', classification: undefined })).toMatchObject({ sealHash: null, safeDiff: null, classification: 'INTERNAL' });
  });

  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['no id', { ...ROW, id: undefined }],
    ['no actor', { ...ROW, actor_id: '' }],
    ['no action', { ...ROW, action: 3 }],
    ['no resource type', { ...ROW, resource_type: undefined }],
    ['no resource id', { ...ROW, resource_id: undefined }],
    ['no time', { ...ROW, occurred_at: undefined }],
    ['an unknown outcome', { ...ROW, outcome: 'MAYBE' }],
    ['no outcome', { ...ROW, outcome: undefined }],
    ['a seq that is not a number', { ...ROW, seq: '7' }],
  ])('drops a row with %s: a row is never shown half', (_name, raw) => {
    expect(toAuditEvent(raw)).toBeUndefined();
  });
});

describe('toSealView', () => {
  it('reads the four verdicts', () => {
    expect(toSealView({ status: 'OK', checked_at: '2026-03-01T10:00:00.000Z', seals: 3, broken: null })).toEqual({ status: 'OK', checkedAt: '2026-03-01T10:00:00.000Z', seals: 3, broken: null });
    expect(toSealView({ status: 'STALE', checked_at: 'x', seals: 1, broken: null }).status).toBe('STALE');
    expect(toSealView({ status: 'UNKNOWN', checked_at: null, seals: null, broken: null })).toEqual({ status: 'UNKNOWN', checkedAt: null, seals: null, broken: null });
    expect(toSealView({ status: 'BROKEN', checked_at: 'x', seals: 2, broken: { seal_id: 's1', from_seq: 4, to_seq: 9, reason: 'ROOT_MISMATCH' } })).toMatchObject({
      status: 'BROKEN',
      broken: { sealId: 's1', fromSeq: 4, toSeq: 9, reason: 'ROOT_MISMATCH' },
    });
  });

  it('keeps BROKEN when the window cannot be read, and never turns an unreadable answer into OK', () => {
    expect(toSealView({ status: 'BROKEN', broken: { seal_id: 's1', reason: 'SOMETHING_NEW', from_seq: 1, to_seq: 2 } })).toMatchObject({ status: 'BROKEN', broken: null });
    expect(toSealView({ status: 'BROKEN', broken: 'x' })).toMatchObject({ status: 'BROKEN', broken: null });
    for (const raw of [undefined, null, 'OK', [], {}, { status: 'FINE' }, { status: 3 }]) expect(toSealView(raw).status).toBe('UNKNOWN');
  });
});

describe('toAuditPage', () => {
  it('reads the rows, the cursor and the verdict, and survives an answer of another shape', () => {
    const page = toAuditPage({ items: [ROW, { nonsense: true }], next_cursor: 'c1', seal: { status: 'OK', checked_at: null, seals: 0, broken: null } });
    expect(page.events.map((event) => event.id)).toEqual(['e1']);
    expect(page.nextCursor).toBe('c1');
    expect(page.seal.status).toBe('OK');
    for (const raw of [undefined, 'x', { items: 'x' }]) expect(toAuditPage(raw)).toEqual({ events: [], nextCursor: undefined, seal: { status: 'UNKNOWN', checkedAt: null, seals: null, broken: null } });
    expect(toAuditPage({ items: [], next_cursor: null }).nextCursor).toBeUndefined();
  });
});

describe('the filter', () => {
  it('sends only what was filled in, trimmed, with the period as instants', () => {
    expect(filterQuery(EMPTY_FILTER)).toEqual({});
    expect(hasFilter(EMPTY_FILTER)).toBe(false);
    const values = { actorId: ' 0000000A-0000-4000-8000-000000000001 ', action: ' widget.change ', resourceType: 'widget', outcome: 'DENIED' as const, from: '2026-03-01T10:00', to: '2026-03-02T10:00' };
    expect(filterQuery(values)).toEqual({
      actor_id: '0000000a-0000-4000-8000-000000000001',
      action: 'widget.change',
      resource_type: 'widget',
      outcome: 'DENIED',
      from: new Date('2026-03-01T10:00').toISOString(),
      to: new Date('2026-03-02T10:00').toISOString(),
    });
    expect(hasFilter(values)).toBe(true);
    expect(filterQuery({ ...EMPTY_FILTER, outcome: 'FAILED' })).toEqual({ outcome: 'FAILED' });
  });

  it('finds the mistakes the server would refuse', () => {
    expect(validateFilter(EMPTY_FILTER)).toEqual({});
    expect(validateFilter({ ...EMPTY_FILTER, actorId: 'not-a-uuid' })).toEqual({ actorId: 'invalid' });
    expect(validateFilter({ ...EMPTY_FILTER, action: 'x'.repeat(201), resourceType: 'y'.repeat(201) })).toEqual({ action: 'tooLong', resourceType: 'tooLong' });
    expect(validateFilter({ ...EMPTY_FILTER, from: 'soon', to: 'later' })).toEqual({ from: 'invalid', to: 'invalid' });
    expect(validateFilter({ ...EMPTY_FILTER, from: '2026-03-02T10:00', to: '2026-03-01T10:00' })).toEqual({ to: 'order' });
    expect(validateFilter({ ...EMPTY_FILTER, from: '2026-03-01T10:00', to: '2026-03-01T10:00' })).toEqual({ to: 'order' });
    expect(validateFilter({ ...EMPTY_FILTER, from: '2026-03-01T10:00', to: '2026-03-01T10:01' })).toEqual({});
  });
});

describe('the export', () => {
  const values = { ...EMPTY_EXPORT, from: '2026-01-01T00:00', to: '2026-06-01T00:00' };

  it('needs a period, in order, of at most 366 days (UAT-AC139)', () => {
    expect(validateExport(values)).toEqual({});
    expect(validateExport(EMPTY_EXPORT)).toEqual({ from: 'required', to: 'required' });
    expect(validateExport({ ...values, from: 'x', to: 'y' })).toEqual({ from: 'invalid', to: 'invalid' });
    expect(validateExport({ ...values, to: '2026-01-01T00:00' })).toEqual({ to: 'order' });
    expect(validateExport({ ...values, to: '2025-12-01T00:00' })).toEqual({ to: 'order' });
    // A day more or less than a whole year, far enough from 366 days to be right in any time zone.
    expect(validateExport({ ...values, to: '2027-01-01T00:00' })).toEqual({});
    expect(validateExport({ ...values, to: '2027-01-04T00:00' })).toEqual({ to: 'range' });
  });

  it('checks the resource type names as the server does', () => {
    expect(validateExport({ ...values, resourceTypes: 'widget, gadget' })).toEqual({});
    expect(validateExport({ ...values, resourceTypes: 'Widget' })).toEqual({ resourceTypes: 'invalid' });
    expect(validateExport({ ...values, resourceTypes: 'a b' })).toEqual({ resourceTypes: 'invalid' });
    expect(validateExport({ ...values, resourceTypes: Array.from({ length: 51 }, (_, index) => `t${index}`).join(',') })).toEqual({ resourceTypes: 'invalid' });
    expect(resourceTypesOf(' widget ,gadget,, widget')).toEqual(['widget', 'gadget']);
  });

  it('builds the body of exportAuditLog', () => {
    expect(exportBody(values)).toEqual({ from: new Date('2026-01-01T00:00').toISOString(), to: new Date('2026-06-01T00:00').toISOString(), format: 'JSONL' });
    expect(exportBody({ ...values, format: 'CSV', resourceTypes: 'widget,gadget' })).toMatchObject({ format: 'CSV', resource_types: ['widget', 'gadget'] });
  });

  it('reads the answer of the export: the id of the export, or nothing', () => {
    expect(toExportDone({ resource_id: 'x1', status: 'READY' })).toEqual({ exportId: 'x1' });
    expect(toExportDone({})).toBeUndefined();
    expect(toExportDone('x')).toBeUndefined();
  });
});

describe('describeProblem and shortHash', () => {
  const failure = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c' });

  it('maps the codes of an export to the reasons the screen words', () => {
    expect(describeProblem(failure('EXPORT_RANGE_TOO_LARGE')).reason).toBe('rangeTooLarge');
    expect(describeProblem(failure('VALIDATION_FAILED')).reason).toBe('invalid');
    expect(describeProblem(failure('INVALID_REQUEST', 400)).reason).toBe('invalid');
    expect(describeProblem(failure('SCOPE_DENIED', 403)).reason).toBe('denied');
    expect(describeProblem(failure('FILE_NOT_CLEAN')).reason).toBe('notClean');
    expect(describeProblem(failure('SESSION_EXPIRED', 401)).reason).toBe('session');
    expect(describeProblem(failure('SOMETHING_ELSE', 500)).reason).toBe('general');
    expect(describeProblem(new Error('x')).reason).toBe('general');
  });

  it('shortens a hash to twelve characters', () => {
    expect(shortHash('0123456789abcdef0123')).toBe('0123456789ab');
  });
});
