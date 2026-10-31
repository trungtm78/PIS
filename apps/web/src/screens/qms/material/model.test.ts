import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { canManage, describeProblem, toContractOption, emptyRegister, emptyResult, isDay, parseValues, registerBody, resultBody, toMaterialTest, validateRegister, validateResult, vietnamToday } from './model';
import type { MaterialTest } from './model';

const problem = (code: string, extensions: Record<string, unknown> = {}, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions });
const CONTRACT = '00000000-0000-4000-8000-000000000001';
const REPORT = '00000000-0000-4000-8000-0000000000e1';
const raw = (overrides: Record<string, unknown> = {}) => ({
  id: 't-1',
  contract: { id: CONTRACT, code: 'HD-001' },
  sample_code: 'BT-0601',
  material_kind: 'Concrete B02',
  lab_name: 'Central laboratory',
  standard_ref: 'STD-BT-30',
  sampled_on: '2026-10-20',
  tested_on: null,
  result: 'PENDING',
  result_values: {},
  report_document_version_id: null,
  status: 'REGISTERED',
  nonconformance: null,
  allowed: { record: true },
  version: 1,
  ...overrides,
});
const test = (overrides: Partial<MaterialTest> = {}): MaterialTest => ({ ...(toMaterialTest(raw()) as MaterialTest), ...overrides });

describe('the testing of materials (QMS-06, ST-QMS-007)', () => {
  it('reads a test with its result, its report and its non-conformance, and drops what is not one', () => {
    expect(toMaterialTest(raw())).toEqual({
      id: 't-1',
      contract: { id: CONTRACT, code: 'HD-001' },
      sampleCode: 'BT-0601',
      materialKind: 'Concrete B02',
      labName: 'Central laboratory',
      standardRef: 'STD-BT-30',
      sampledOn: '2026-10-20',
      testedOn: null,
      result: 'PENDING',
      resultValues: {},
      reportId: null,
      status: 'REGISTERED',
      nonconformance: null,
      canRecord: true,
      version: 1,
    });
    expect(
      toMaterialTest(raw({ result: 'FAIL', status: 'RESULT_RECORDED', tested_on: '2026-10-25', result_values: { strength_mpa: 18.5 }, report_document_version_id: REPORT, nonconformance: { id: 'n-1', ncr_no: 'NCR-001', severity: 'MAJOR', status: 'OPEN' }, allowed: undefined, version: 2 })),
    ).toMatchObject({ result: 'FAIL', testedOn: '2026-10-25', resultValues: { strength_mpa: 18.5 }, reportId: REPORT, nonconformance: { id: 'n-1', ncrNo: 'NCR-001', severity: 'MAJOR', status: 'OPEN' }, canRecord: false });
    expect(toMaterialTest(raw({ nonconformance: { id: 'n-2' }, result: 'NOPE', result_values: 'x', version: 'x' }))).toMatchObject({ nonconformance: { ncrNo: '', severity: 'MAJOR', status: '' }, result: 'PENDING', resultValues: {}, version: 0 });
    for (const bad of [null, 'x', [], raw({ id: 1 }), raw({ contract: null }), raw({ sample_code: undefined }), raw({ status: 'NOPE' }), raw({ sampled_on: undefined })]) expect(toMaterialTest(bad)).toBeUndefined();
  });

  it('reads the contracts a sample can be registered on', () => {
    expect(toContractOption({ id: CONTRACT, code: 'HD-001', title: 'Road' })).toEqual([{ id: CONTRACT, code: 'HD-001', title: 'Road' }]);
    expect(toContractOption({ id: CONTRACT, code: 'HD-001' })).toEqual([{ id: CONTRACT, code: 'HD-001', title: null }]);
    for (const bad of [null, 'x', { id: CONTRACT }, { code: 'HD-001' }]) expect(toContractOption(bad)).toEqual([]);
  });

  it('is for the holders of the right, and not while the tenant is read-only', () => {
    expect([canManage(['material.manage'], 'FULL'), canManage(undefined, undefined), canManage(['material.manage'], 'READ_ONLY'), canManage(['material.record'], 'FULL')]).toEqual([true, true, false, false]);
    expect(vietnamToday(new Date('2027-01-14T17:30:00Z'))).toBe('2027-01-15');
    expect([isDay('2028-02-29'), isDay('2027-02-29'), isDay('2027-1-1')]).toEqual([true, false, false]);
  });

  it('asks for a contract being performed, the words of the sample and a day that is real and not in the future', () => {
    const empty = emptyRegister('', '2026-10-31');
    expect(validateRegister(empty, [CONTRACT], '2026-10-31')).toEqual({ contractId: 'required', sampleCode: 'required', materialKind: 'required', labName: 'required', standardRef: 'required' });
    const form = { ...empty, contractId: CONTRACT, sampleCode: 'BT-1', materialKind: 'Concrete', labName: 'Lab', standardRef: 'STD' };
    expect(validateRegister(form, [CONTRACT], '2026-10-31')).toEqual({});
    expect(validateRegister({ ...form, contractId: 'other' }, [CONTRACT], '2026-10-31')).toEqual({ contractId: 'invalid' });
    expect(validateRegister({ ...form, sampledOn: '2026-11-01' }, [CONTRACT], '2026-10-31')).toEqual({ sampledOn: 'future' });
    expect(validateRegister({ ...form, sampledOn: '2026-02-30' }, [CONTRACT], '2026-10-31')).toEqual({ sampledOn: 'invalid' });
    expect(validateRegister({ ...form, sampledOn: '' }, [CONTRACT], '2026-10-31')).toEqual({ sampledOn: 'required' });
    expect(validateRegister({ ...form, sampleCode: 'x'.repeat(201), standardRef: '   ' }, [CONTRACT], '2026-10-31')).toEqual({ sampleCode: 'tooLong', standardRef: 'required' });
    expect(registerBody({ ...form, sampleCode: ' BT-1 ', labName: ' Lab ' })).toEqual({ contract_id: CONTRACT, sample_code: 'BT-1', material_kind: 'Concrete', lab_name: 'Lab', standard_ref: 'STD', sampled_on: '2026-10-31' });
  });

  it('asks for a result, a day between the sample and today, the values as an object and the report as a code', () => {
    expect(validateResult({ ...emptyResult('2026-10-31'), values: '' }, test(), '2026-10-31')).toEqual({ result: 'required', values: 'object', reportId: 'required' });
    const form = { result: 'FAIL', testedOn: '2026-10-25', values: '{"strength_mpa": 18.5}', reportId: REPORT };
    expect(validateResult(form, test(), '2026-10-31')).toEqual({});
    expect(validateResult({ ...form, result: 'MAYBE' }, test(), '2026-10-31')).toEqual({ result: 'invalid' });
    expect(validateResult({ ...form, testedOn: '2026-10-19' }, test(), '2026-10-31')).toEqual({ testedOn: 'early' });
    expect(validateResult({ ...form, testedOn: '2026-11-01' }, test(), '2026-10-31')).toEqual({ testedOn: 'future' });
    expect(validateResult({ ...form, testedOn: '2026-13-01' }, test(), '2026-10-31')).toEqual({ testedOn: 'invalid' });
    expect(validateResult({ ...form, testedOn: '' }, test(), '2026-10-31')).toEqual({ testedOn: 'required' });
    expect(validateResult({ ...form, values: '[1, 2]' }, test(), '2026-10-31')).toEqual({ values: 'object' });
    expect(validateResult({ ...form, values: 'not json' }, test(), '2026-10-31')).toEqual({ values: 'object' });
    expect(validateResult({ ...form, values: JSON.stringify({ text: 'x'.repeat(70_000) }) }, test(), '2026-10-31')).toEqual({ values: 'tooLong' });
    expect(validateResult({ ...form, reportId: 'nope' }, test(), '2026-10-31')).toEqual({ reportId: 'invalid' });
    expect(parseValues('{"a": 1}')).toEqual({ a: 1 });
    expect(parseValues('null')).toBeUndefined();
    expect(resultBody({ ...form, testedOn: ' 2026-10-25 ', reportId: ` ${REPORT} ` })).toEqual({ result: 'FAIL', tested_on: '2026-10-25', result_values: { strength_mpa: 18.5 }, report_document_version_id: REPORT });
  });

  it('names the refusals of the server and the reason of a refused day', () => {
    const cases: Array<[unknown, string]> = [
      [problem('SAMPLE_CODE_DUPLICATE', {}, 409), 'duplicate'],
      [problem('MATERIAL_TEST_STATE_INVALID', {}, 409), 'state'],
      [problem('VERSION_CONFLICT', {}, 409), 'conflict'],
      [problem('DOCUMENT_NOT_CLEAN'), 'notClean'],
      [problem('CONTRACT_STATE_INVALID', {}, 409), 'contractState'],
      [problem('SCOPE_DENIED', {}, 403), 'denied'],
      [problem('RESOURCE_NOT_FOUND', {}, 404), 'notFound'],
      [problem('VALIDATION_FAILED'), 'validation'],
      [problem('INVALID_REQUEST', {}, 400), 'validation'],
      [problem('VALIDATION_FAILED', { reason: 'IN_THE_FUTURE' }), 'future'],
      [problem('VALIDATION_FAILED', { reason: 'BEFORE_SAMPLE' }), 'early'],
      [problem('VALIDATION_FAILED', { reason: 'NOT_FOUND' }), 'validation'],
      [problem('INTERNAL_ERROR', {}, 500), 'general'],
      [new Error('down'), 'general'],
    ];
    expect(cases.map(([error]) => describeProblem(error))).toEqual(cases.map(([, expected]) => expected));
  });
});
