import { describe, expect, it } from 'vitest';
import { ApiError } from '@machvon/api-client';
import { dayText, filtersOf, fitsPattern, instantDay, instantText, problemOf, queryOf, reasonOf, searchOf } from './int-model';

const error = (code: string, status: number, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });

describe('the model of the integration screens', () => {
  it('reads the error of a command into the kind a dialog explains', () => {
    expect(problemOf(error('VERSION_CONFLICT', 409)).kind).toBe('versionConflict');
    expect(problemOf(error('SELF_APPROVAL_DENIED', 403)).kind).toBe('selfApproval');
    expect(problemOf(error('CROSSWALK_DUPLICATE', 409, { reason: 'EXTERNAL_CODE_TAKEN' })).kind).toBe('duplicateTaken');
    expect(problemOf(error('CROSSWALK_DUPLICATE', 409, { reason: 'SUBJECT_HAS_OTHER_CODE' })).kind).toBe('duplicateHolds');
    expect(problemOf(error('CROSSWALK_DUPLICATE', 409, { reason: 'ALREADY_PROPOSED' })).kind).toBe('duplicateWaiting');
    expect(problemOf(error('CROSSWALK_DUPLICATE', 409)).kind).toBe('duplicate');
    for (const code of ['EGP_MAPPING_STATE_INVALID', 'OPEN_ACCOUNT_STATE_INVALID', 'BI_READER_STATE_INVALID']) expect(problemOf(error(code, 409)).kind).toBe('stateInvalid');
    expect(problemOf(error('OPEN_ACCOUNT_NAME_TAKEN', 409))).toMatchObject({ kind: 'nameTaken', field: 'name' });
    expect(problemOf(error('INT_SOURCE_SYSTEM_TAKEN', 409)).kind).toBe('systemTaken');
    expect(problemOf(error('INT_SOURCE_SYSTEM_IN_USE', 409)).kind).toBe('systemInUse');
    expect(problemOf(error('OPEN_DATASET_NOT_CERTIFIED', 422, { reason: 'EXPIRED' }))).toMatchObject({ kind: 'datasetClosed', reason: 'EXPIRED' });
    expect(problemOf(error('BI_PROVISIONING_UNAVAILABLE', 503)).kind).toBe('provisioning');
    expect(problemOf(error('VALIDATION_FAILED', 422, {}, 'our_code'))).toMatchObject({ kind: 'validation', field: 'our_code' });
    expect(problemOf(error('RESOURCE_NOT_FOUND', 404)).kind).toBe('notFound');
    expect(problemOf(error('SCOPE_DENIED', 403)).kind).toBe('forbidden');
    expect(problemOf(error('BOOM', 500)).kind).toBe('general');
    expect(problemOf(new Error('x')).kind).toBe('general');
  });

  it('writes days and instants in Vietnam time', () => {
    expect(dayText('2026-11-08')).toBe('08/11/2026');
    expect(dayText(null)).toBe('');
    expect(dayText('garbage')).toBe('garbage');
    expect(instantDay('2026-11-08T20:00:00.000Z')).toBe('09/11/2026');
    expect(instantText('2026-11-08T03:05:00.000Z')).toBe('08/11/2026 10:05');
    expect(instantText('nonsense')).toBe('');
  });

  it('holds a code to the whole format of its system, and a bad pattern never blocks', () => {
    expect(fitsPattern('P-\\d{3}', 'P-100')).toBe(true);
    expect(fitsPattern('P-\\d{3}', 'xP-100')).toBe(false);
    expect(fitsPattern('P-\\d{3}', 'P-1000')).toBe(false);
    expect(fitsPattern(null, 'anything')).toBe(true);
    expect(fitsPattern('(', 'anything')).toBe(true);
  });

  it('keeps the reason within what the server accepts', () => {
    expect(reasonOf('  too short ')).toBeUndefined();
    expect(reasonOf('  a reason of ten  ')).toBe('a reason of ten');
    expect(reasonOf('x'.repeat(2001))).toBeUndefined();
  });

  it('builds the query and the address of a list from the filters that are set', () => {
    expect(queryOf({ status: 'ACTIVE', q: ' ', outcome: undefined }, 'c1')).toEqual({ limit: 50, status: 'ACTIVE', cursor: 'c1' });
    expect(searchOf({ status: 'ACTIVE', q: undefined, outcome: '' }).toString()).toBe('status=ACTIVE');
    expect(filtersOf(new URLSearchParams('status=ACTIVE&other=1&q='), ['status', 'q'])).toEqual({ status: 'ACTIVE' });
  });
});
