import { describe, expect, it } from 'vitest';
import { formProblemMessage, preflightMessage } from './labels';
import { EMPTY_FORM, NO_PLACE, captureBody, hasProblems, holds, preflightFlags, validateCapture } from './model';
import type { ChosenFile } from './model';

const FILE: ChosenFile = { name: 'a.jpg', type: 'image/jpeg', size: 10, sha256: 'a'.repeat(64) };
const CONTRACT = '00000000-0000-4000-8000-001000000002';
const FORM = { ...EMPTY_FORM, contractId: CONTRACT, objectKey: 'k' };

describe('QMS-10 model', () => {
  it('asks for the file, the contract and the reference, and refuses what is not an image, too large, too long or not an identifier', () => {
    expect(validateCapture(EMPTY_FORM, undefined, NO_PLACE).form).toEqual({ file: 'required', contractId: 'required', objectKey: 'required' });
    expect(hasProblems(validateCapture(FORM, FILE, NO_PLACE))).toBe(false);
    expect(validateCapture(FORM, { ...FILE, type: 'text/plain' }, NO_PLACE).form).toEqual({ file: 'notImage' });
    expect(validateCapture(FORM, { ...FILE, size: 15 * 1024 * 1024 + 1 }, NO_PLACE).form).toEqual({ file: 'tooLarge' });
    expect(validateCapture({ ...FORM, siteDiaryId: 'x', caption: 'y'.repeat(2001), objectKey: 'z'.repeat(2001) }, FILE, NO_PLACE).form).toEqual({
      siteDiaryId: 'invalidId',
      caption: 'tooLong',
      objectKey: 'tooLong',
    });
    expect(hasProblems(validateCapture(FORM, FILE, { consent: false, lat: '10', lng: '', accuracy: '' }))).toBe(true);
  });

  it('sends the place only with the consent and both coordinates', () => {
    const contract = { id: CONTRACT, projectId: 'p' };
    const base = captureBody(FORM, contract, FILE, NO_PLACE, 'op');
    expect(base).toEqual({ client_operation_id: 'op', project_id: 'p', contract_id: CONTRACT, object_key: 'k', file_sha256: FILE.sha256 });
    expect(captureBody({ ...FORM, siteDiaryId: 'd', caption: ' c ' }, contract, FILE, NO_PLACE, 'op')).toMatchObject({ site_diary_id: 'd', caption: 'c' });
    expect(captureBody(FORM, contract, FILE, { consent: false, lat: '1', lng: '2', accuracy: '3' }, 'op')).toEqual(base);
    expect(captureBody(FORM, contract, FILE, { consent: true, lat: '1', lng: '', accuracy: '' }, 'op')).toEqual({ ...base, geo_consent: true });
    expect(captureBody(FORM, contract, FILE, { consent: true, lat: '1', lng: '2', accuracy: '' }, 'op')).toEqual({ ...base, geo_consent: true, device_gps_lat: '1', device_gps_lng: '2' });
  });

  it('flags a repeated file and a place that will not be kept', () => {
    expect(preflightFlags(undefined, [], NO_PLACE)).toEqual(['PLACE_NOT_KEPT']);
    expect(preflightFlags('h', [{ fileSha256: 'h' }], { consent: true, lat: '1', lng: '2', accuracy: '' })).toEqual(['DUPLICATE_SAME_SITE']);
    expect(preflightFlags('h', [{ fileSha256: 'x' }], { consent: true, lat: '1', lng: '', accuracy: '' })).toEqual(['PLACE_NOT_KEPT']);
  });

  it('holds a permission, or is not told the permissions yet', () => {
    expect(holds(undefined, 'x')).toBe(true);
    expect(holds(['x'], 'x')).toBe(true);
    expect(holds([], 'x')).toBe(false);
  });

  it('words every form problem and every flag', () => {
    const t = (key: string): string => key;
    expect((['required', 'tooLong', 'notImage', 'tooLarge', 'invalidId'] as const).map((problem) => formProblemMessage(t, problem))).toHaveLength(5);
    expect((['DUPLICATE_SAME_SITE', 'PLACE_NOT_KEPT'] as const).map((flag) => preflightMessage(t, flag))).toEqual(['qms.capture.preflight.duplicate', 'qms.capture.preflight.placeNotKept']);
  });
});
