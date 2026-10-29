import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import * as labels from './labels';
import { DIFFERENCE_KINDS, GATE_OUTCOMES, MAPPING_STATUSES, RECON_RESULTS, UNITS, decideBody, describeProblem, emptyDecide, emptyPropose, emptyRecon, formatDong, proposeBody, reconBody, resourceIdOf, toGate, toMapping, toRecon, validatePropose, validateRecon } from './model';
import { difference, gate, mapping, recon } from './test-support';

const problem = (code: string, detail?: string) => new ApiError({ status: 422, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });
const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const t = ((key: string) => word(key)) as Parameters<typeof labels.problemMessage>[0];
const UUID = '00000000-0000-4000-8000-000000000001';

describe('the rows the server sends', () => {
  it('reads a mapping, and leaves out a row that is not one', () => {
    expect(toMapping(mapping(1, { status: 'CONFIRMED', actions: { decide: true } }))).toMatchObject({ status: 'CONFIRMED', sourceSystem: 'PAY', unit: 'MILLION_VND', canDecide: true, proposedByName: 'Nguyen Van An', decidedByName: null });
    expect(toMapping(mapping(1, { actions: {} }))?.canDecide).toBe(false);
    for (const broken of [null, 'x', [], {}, mapping(1, { status: 'DELETED' }), mapping(1, { version: 'one' }), mapping(1, { id: 7 }), mapping(1, { dataset: {} })]) expect(toMapping(broken)).toBeUndefined();
  });

  it('reads a gate with the fields that had no confirmed mapping, and leaves out a row that is not one', () => {
    expect(toGate(gate(1, { outcome: 'QUARANTINED', reason: 'MAPPING_NOT_CONFIRMED', fields: [{ source_field: 'so_tien', missing: true }, { source_field: 'ok', factor: '1' }, 'x'] }))).toMatchObject({ outcome: 'QUARANTINED', missing: ['so_tien'], rowCount: 120 });
    expect(toGate(gate(1))?.missing).toEqual([]);
    for (const broken of [null, {}, gate(1, { outcome: 'LOST' }), gate(1, { batch_ref: 3 })]) expect(toGate(broken)).toBeUndefined();
  });

  it('reads a reconciliation with its totals as text, never as a float, and drops a difference that is not whole', () => {
    const read = toRecon(
      recon(1, {
        differences: [difference('P1', 'AMOUNT', 'BOTH', '9007199254740993', '1'), { key: 'P2', kind: 'WHATEVER', side: 'BOTH', amount_a_vnd: '1', amount_b_vnd: '1', difference_vnd: '0' }, { key: 'P3', kind: 'TIMING', side: 'BOTH', amount_a_vnd: 1, amount_b_vnd: '1', difference_vnd: '0' }],
      }),
    );
    expect(read).toMatchObject({ totalA: '385000000', totalB: '300000000', difference: '85000000', result: 'DIFFERENT', ownerName: 'Tran Thi Binh', byKind: { MISSING: 1, TIMING: 0, REVERSAL: 0, MAPPING: 0, AMOUNT: 1 } });
    expect(read?.differences).toEqual([{ key: 'P1', kind: 'AMOUNT', side: 'BOTH', amountA: '9007199254740993', amountB: '1', difference: '9007199254740992' }]);
    expect(toRecon(recon(1, { incident_id: null }))?.incidentId).toBeNull();
    expect(toRecon(recon(1, { by_kind: undefined }))?.byKind).toEqual({ MISSING: 0, TIMING: 0, REVERSAL: 0, MAPPING: 0, AMOUNT: 0 });
    for (const broken of [null, {}, recon(1, { result: 'MAYBE' }), recon(1, { total_a_vnd: 385000000 }), recon(1, { total_b_vnd: '1.5' }), recon(1, { id: 1 })]) expect(toRecon(broken)).toBeUndefined();
  });

  it('writes a whole number of dong in groups without going through a float, and reads the id of what a command made', () => {
    expect(formatDong('385000000', 'en')).toBe('385,000,000');
    expect(formatDong('-70000000', 'en')).toBe('-70,000,000');
    expect(formatDong('9007199254740993', 'en')).toBe('9,007,199,254,740,993');
    expect(formatDong('0', 'vi')).toBe('0');
    expect(resourceIdOf({ resource_id: UUID })).toBe(UUID);
    expect(resourceIdOf({})).toBeUndefined();
    expect(resourceIdOf(null)).toBeUndefined();
  });
});

describe('the forms', () => {
  it('asks for a dataset, a system and both fields of a mapping, and sends only what was filled', () => {
    expect(validatePropose(emptyPropose())).toEqual({ datasetId: 'invalidId', sourceSystem: 'required', sourceField: 'required', targetField: 'required' });
    expect(validatePropose({ ...emptyPropose(UUID), sourceSystem: 'P', sourceField: 'a', targetField: 'b' })).toEqual({ sourceSystem: 'tooShort' });
    const form = { ...emptyPropose(UUID), sourceSystem: ' PAY ', sourceField: ' so_tien ', targetField: 'amount_vnd', unit: 'MILLION_VND' };
    expect(validatePropose(form)).toEqual({});
    expect(proposeBody(form)).toEqual({ dataset_id: UUID, source_system: 'PAY', source_field: 'so_tien', target_field: 'amount_vnd', unit: 'MILLION_VND' });
    expect(proposeBody({ ...form, unit: '', transformRule: ' x / 1000 ' })).toEqual({ dataset_id: UUID, source_system: 'PAY', source_field: 'so_tien', target_field: 'amount_vnd', transform_rule: 'x / 1000' });
    expect(UNITS).toEqual(['', 'VND', 'THOUSAND_VND', 'MILLION_VND', 'BILLION_VND']);
  });

  it('sends a decision with its note only when there is one', () => {
    expect(decideBody(emptyDecide('REJECTED'))).toEqual({ decision: 'REJECTED' });
    expect(decideBody({ decision: 'CONFIRMED', note: '  đã kiểm  ' })).toEqual({ decision: 'CONFIRMED', note: 'đã kiểm' });
  });

  it('asks for a month as YYYY-MM, a whole non-negative tolerance and, when given, a dataset; the sources and the basis are always the ones the server knows', () => {
    expect(validateRecon(emptyRecon())).toEqual({ asOfPeriod: 'required' });
    expect(validateRecon({ ...emptyRecon(), reconCode: 'A', asOfPeriod: '2026-13', toleranceVnd: '-1', datasetId: 'x' })).toEqual({ reconCode: 'tooShort', asOfPeriod: 'invalidPeriod', toleranceVnd: 'invalidAmount', datasetId: 'invalidId' });
    expect(validateRecon({ ...emptyRecon(), reconCode: '', asOfPeriod: '2026-10', toleranceVnd: '' })).toEqual({ reconCode: 'required', toleranceVnd: 'required' });
    const form = { ...emptyRecon(), asOfPeriod: '2026-10', toleranceVnd: '500' };
    expect(validateRecon(form)).toEqual({});
    expect(reconBody(form)).toEqual({ recon_code: 'PAY-DIS-MONTH', source_a: 'PAY.treasury_transaction', source_b: 'DIS.report_accepted', as_of_period: '2026-10', basis: 'VND, ngày Kho bạc thanh toán', tolerance_vnd: '500' });
    expect(reconBody({ ...form, datasetId: UUID })).toMatchObject({ dataset_id: UUID });
  });
});

describe('the refusals', () => {
  it('names each refusal of the server the screen has words for, and the field when the server judged it', () => {
    const cases: Array<[unknown, ReturnType<typeof describeProblem>]> = [
      [problem('MAPPING_DUPLICATE'), 'duplicate'],
      [problem('SELF_APPROVAL_DENIED'), 'selfApproval'],
      [problem('MAPPING_STATE_INVALID'), 'stateInvalid'],
      [problem('BASIS_MISMATCH'), 'basis'],
      [problem('SNAPSHOT_NOT_FOUND'), 'noClosedMonth'],
      [problem('VERSION_CONFLICT'), 'versionConflict'],
      [problem('VALIDATION_FAILED', 'unit'), 'unit'],
      [problem('VALIDATION_FAILED', 'dataset_id'), 'datasetMissing'],
      [problem('VALIDATION_FAILED', 'tolerance_vnd'), 'validation'],
      [problem('INVALID_REQUEST'), 'validation'],
      [problem('FIELD_NOT_ALLOWED'), 'validation'],
      [problem('RESOURCE_NOT_FOUND'), 'notFound'],
      [problem('SCOPE_DENIED'), 'denied'],
      [problem('PERMISSION_DENIED'), 'denied'],
      [problem('SOMETHING_ELSE'), 'general'],
      [new Error('network'), 'general'],
    ];
    for (const [error, expected] of cases) expect(describeProblem(error)).toBe(expected);
  });
});

describe('the words', () => {
  it('has a word for every status, outcome, result, kind, side, unit, problem and refusal, none of them a key', () => {
    const words: string[] = [
      ...MAPPING_STATUSES.map((status) => labels.mappingStatusLabel(t, status)),
      ...[...UNITS, null, 'OTHER'].map((unit) => labels.unitLabel(t, unit)),
      ...GATE_OUTCOMES.map((outcome) => labels.gateOutcomeLabel(t, outcome)),
      labels.gateReasonLabel(t, 'MAPPING_NOT_CONFIRMED'),
      labels.gateReasonLabel(t, null),
      ...RECON_RESULTS.map((result) => labels.resultLabel(t, result)),
      ...DIFFERENCE_KINDS.map((kind) => labels.kindLabel(t, kind)),
      ...(['A_ONLY', 'B_ONLY', 'BOTH'] as const).map((side) => labels.sideLabel(t, side)),
      ...(['required', 'tooShort', 'invalidId', 'invalidPeriod', 'invalidAmount'] as const).map((problemName) => labels.formProblemMessage(t, problemName)),
      ...(['unit', 'datasetMissing', 'duplicate', 'selfApproval', 'stateInvalid', 'basis', 'noClosedMonth', 'versionConflict', 'validation', 'notFound', 'denied', 'general'] as const).map((problemName) => labels.problemMessage(t, problemName)),
    ];
    for (const entry of words) expect(entry.startsWith('dgv.')).toBe(false);
    expect(new Set(words.filter((entry) => entry !== 'OTHER')).size).toBeGreaterThan(30);
    expect(labels.unitLabel(t, 'OTHER')).toBe('OTHER');
    expect(labels.gateReasonLabel(t, 'SOMETHING')).toBe('SOMETHING');
  });

  it('colours each status and result with a tone, so the state is never told by colour alone', () => {
    expect(MAPPING_STATUSES.map((status) => labels.mappingStatusTone(status))).toEqual(['warn', 'green', 'red', 'gray']);
    expect(RECON_RESULTS.map((result) => labels.resultTone(result))).toEqual(['green', 'warn', 'red']);
  });
});
