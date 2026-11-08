import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_MEASURE,
  assessBody,
  calendarByDue,
  decimalText,
  decisionBody,
  describeRefusal,
  draftBody,
  draftFormOf,
  hasProblems,
  measureBody,
  measurementsNewestFirst,
  naReason,
  personName,
  toCalendarResult,
  toEffectView,
  validateAssess,
  validateDraft,
  validateMeasure,
} from './model';
import type { DraftForm, EffectView, IndicatorForm } from './model';

const refusal = (code: string, status = 409, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });
const WHO = { membership_id: '00000000-0000-4000-8000-0000000000a1', display_name: 'Nguyễn Văn An' };

const indicatorRaw = (overrides: Record<string, unknown> = {}) => ({
  id: 'i1',
  code: 'IRRIGATED_HA',
  name: 'Irrigated area',
  unit: 'ha',
  direction: 'HIGHER_IS_BETTER',
  baseline_value: '400.5',
  baseline_on: '2026-01-01',
  target_value: '800',
  measure_after_months: 12,
  data_source: 'Survey',
  formula: 'Sum of the plots',
  actual: { measurement_id: 'm1', value: '600', measured_on: '2027-03-01', method_note: 'Field survey', evidence_document_id: null, recorded_at: '2027-03-02T01:00:00.000Z' },
  variance: { variance_value: '-200', variance_pct: '-25.00', achievement_pct: '50.04', basis: 'BASELINE_TO_TARGET', band: 'MISSED' },
  ...overrides,
});

const raw = (overrides: Record<string, unknown> = {}) => ({
  project: { id: 'p1', code: 'DA-1', name: 'Project one', status: 'COMPLETED', project_group: 'B' },
  policy: { name: 'EFFECT_POLICY', code: 'DEFAULT', version: 'built-in:1', unverified: true, formula: 'F', source: 'S', as_of: '2026-11-08', legal_status: 'UNVERIFIED', owner: 'MNE', params: { met_at_pct: 100, partly_at_pct: 70, draft_statuses: ['APPRAISAL'], fix_statuses: ['PIPELINE'], measure_statuses: ['COMPLETED'] } },
  fixed: { id: 's1', version_no: 2, status: 'FIXED', basis: 'Decision 12', basis_document_id: null, supersedes_id: null, supersede_reason: null, drafted_by: WHO, drafted_at: '2026-02-01T01:00:00.000Z', fixed_by: { membership_id: 'm2', display_name: null }, fixed_at: '2026-02-02T01:00:00.000Z', fixed_on: '2026-02-02', version: 5, indicators: [indicatorRaw()] },
  draft: null,
  superseded: [{ id: 's0', version_no: 1, fixed_on: '2026-01-10' }],
  measurements: [],
  calendar: [],
  assessments: [],
  suggested_conclusion: 'PARTIALLY_SATISFACTORY',
  can: { draft: true, fix: false, measure: true, generate_calendar: true, assess: true, decide: false },
  as_of: '2026-11-08',
  ...overrides,
});

describe('toEffectView', () => {
  it('keeps the decimals as the strings that came and the computed variance exactly as the server sent it', () => {
    const view = toEffectView(raw()) as EffectView;
    const line = view.fixed?.indicators[0];
    expect(line?.baselineValue).toBe('400.5');
    expect(line?.targetValue).toBe('800');
    expect(line?.actual?.value).toBe('600');
    expect(line?.variance).toEqual({ varianceValue: '-200', variancePct: '-25.00', achievementPct: '50.04', basis: 'BASELINE_TO_TARGET', band: 'MISSED' });
    expect(view.fixed?.version).toBe(5);
    expect(view.fixed?.fixedOn).toBe('2026-02-02');
    expect(view.superseded).toEqual([{ id: 's0', versionNo: 1, fixedOn: '2026-01-10' }]);
  });

  it('keeps a figure the server could not know as null (not measured), never as zero', () => {
    const view = toEffectView(raw({ fixed: { ...(raw().fixed as object), indicators: [indicatorRaw({ actual: null, baseline_value: null, variance: { variance_value: null, variance_pct: null, achievement_pct: null, basis: 'NONE', band: 'NOT_MEASURED' } })] } })) as EffectView;
    const line = view.fixed?.indicators[0];
    expect(line?.actual).toBeNull();
    expect(line?.baselineValue).toBeNull();
    expect([line?.variance.varianceValue, line?.variance.variancePct, line?.variance.achievementPct]).toEqual([null, null, null]);
    expect(line?.variance.band).toBe('NOT_MEASURED');
  });

  it('reads the rule, treats a rule that does not say it is verified as not verified, and the flags of the caller', () => {
    const view = toEffectView(raw()) as EffectView;
    expect(view.policy).toMatchObject({ unverified: true, metAtPct: 100, partlyAtPct: 70, version: 'built-in:1', owner: 'MNE' });
    expect((toEffectView(raw({ policy: {} })) as EffectView).policy.unverified).toBe(true);
    expect((toEffectView(raw({ policy: { unverified: false } })) as EffectView).policy.unverified).toBe(false);
    expect(view.can).toEqual({ draft: true, fix: false, measure: true, generateCalendar: true, assess: true, decide: false });
    expect((toEffectView(raw({ can: {} })) as EffectView).can).toEqual({ draft: false, fix: false, measure: false, generateCalendar: false, assess: false, decide: false });
  });

  it('keeps the measurements, the calendar and the assessments with their flags, and drops a row it cannot read', () => {
    const view = toEffectView(
      raw({
        measurements: [{ id: 'm1', indicator_code: 'X', measured_on: '2027-01-01', value: '1.5', method_note: 'n', evidence_document_id: null, corrects_id: 'm0', correction_reason: 'typo found', corrected: true, recorded_by: WHO, recorded_at: '2027-01-02T00:00:00.000Z' }],
        calendar: [
          { id: 'c1', kind: 'FINAL', anchor: 'COMPLETION', anchor_on: '2027-01-01', months: 3, due_on: '2027-04-01', required: true, status: 'PLANNED', state: 'OVERDUE', days_late: 12, assessment_id: null, rule_code: 'QTQG', rule_version: '1', rule_unverified: true },
          { id: 'c2', kind: 'NOPE' },
        ],
        assessments: [
          { id: 'a1', kind: 'FINAL', status: 'SUBMITTED', as_of: '2027-04-02', conclusion: 'UNSATISFACTORY', summary: 'S', lines: [{ code: 'X', name: 'N', unit: 'ha', direction: 'LOWER_IS_BETTER', baseline_value: null, target_value: '5', actual_value: null, measured_on: null, variance_value: null, variance_pct: null, achievement_pct: null, basis: 'NONE', band: 'NOT_MEASURED' }], policy_version: '1', policy_unverified: true, calendar_entry_id: 'c1', submitted_by: WHO, submitted_at: '2027-04-02T00:00:00.000Z', decided_by: null, decided_at: null, decision_reason: null, version: 2 },
          { id: 'a2', kind: 'WEIRD' },
        ],
      }),
    ) as EffectView;
    expect(view.measurements[0]).toMatchObject({ corrected: true, correctsId: 'm0', correctionReason: 'typo found', value: '1.5' });
    expect(view.calendar).toHaveLength(1);
    expect(view.calendar[0]).toMatchObject({ state: 'OVERDUE', daysLate: 12, ruleUnverified: true });
    expect(view.assessments).toHaveLength(1);
    expect(view.assessments[0]).toMatchObject({ status: 'SUBMITTED', version: 2, decidedBy: null, conclusion: 'UNSATISFACTORY' });
    expect(view.assessments[0]?.lines[0]).toMatchObject({ actualValue: null, band: 'NOT_MEASURED', direction: 'LOWER_IS_BETTER' });
  });

  it('is undefined for an answer without a project', () => {
    expect(toEffectView({})).toBeUndefined();
    expect(toEffectView(null)).toBeUndefined();
  });
});

describe('the orders, the names and the reasons a figure is empty', () => {
  it('orders the measurements newest first and the calendar by the day it falls due', () => {
    const view = toEffectView(
      raw({
        measurements: [
          { id: 'a', indicator_code: 'X', measured_on: '2027-01-01', value: '1', method_note: 'n', recorded_at: '2027-01-01T00:00:00.000Z' },
          { id: 'b', indicator_code: 'X', measured_on: '2027-02-01', value: '2', method_note: 'n', recorded_at: '2027-02-01T00:00:00.000Z' },
          { id: 'c', indicator_code: 'X', measured_on: '2027-02-01', value: '3', method_note: 'n', recorded_at: '2027-02-02T00:00:00.000Z' },
        ],
        calendar: [
          { id: 'z', kind: 'FINAL', due_on: '2027-09-01' },
          { id: 'y', kind: 'INITIAL', due_on: '2027-03-01' },
        ],
      }),
    ) as EffectView;
    expect(measurementsNewestFirst(view.measurements).map((row) => row.id)).toEqual(['c', 'b', 'a']);
    expect(calendarByDue(view.calendar).map((row) => row.id)).toEqual(['y', 'z']);
  });

  it('names a person by the display name, or by the start of the id', () => {
    expect(personName({ membershipId: '12345678-aaaa', displayName: 'An' })).toBe('An');
    expect(personName({ membershipId: '12345678-aaaa', displayName: null })).toBe('12345678');
    expect(personName(null)).toBe('');
  });

  it('says why a computed figure is empty', () => {
    const none = { varianceValue: null, variancePct: null, achievementPct: null, basis: 'NONE' as const, band: 'NOT_MEASURED' as const };
    expect(naReason(none, 'variance')).toBe('NO_MEASUREMENT');
    expect(naReason(none, 'achievement')).toBe('NO_MEASUREMENT');
    expect(naReason({ ...none, varianceValue: '1', basis: 'DIRECTION_ONLY', band: 'MET' }, 'achievement')).toBe('BASELINE_EQUALS_TARGET');
    expect(naReason({ ...none, varianceValue: '1', basis: 'RATIO', band: 'MET' }, 'variance')).toBe('TARGET_ZERO');
    expect(naReason({ ...none, varianceValue: '1', basis: 'RATIO', band: 'MET' }, 'achievement')).toBe('NOT_COMPUTABLE');
  });

  it('reads the answer of the calendar: what was made and what waits for an anchor day', () => {
    const result = toCalendarResult({ created: [{ id: 'c', kind: 'INITIAL', due_on: '2027-03-01', anchor: 'IMPLEMENTATION_START', anchor_on: '2026-03-01' }, { kind: 'WEIRD' }], waiting: [{ kind: 'FINAL', anchor: 'COMPLETION' }], rule: { unverified: true } });
    expect(result.created).toEqual([{ kind: 'INITIAL', dueOn: '2027-03-01', anchor: 'IMPLEMENTATION_START', anchorOn: '2026-03-01' }]);
    expect(result.waiting).toEqual([{ kind: 'FINAL', anchor: 'COMPLETION' }]);
    expect(result.ruleUnverified).toBe(true);
    expect(toCalendarResult(null)).toEqual({ created: [], waiting: [], ruleUnverified: true });
  });
});

const row = (overrides: Partial<IndicatorForm> = {}): IndicatorForm => ({ code: 'IRRIGATED_HA', name: 'Irrigated area', unit: 'ha', direction: 'HIGHER_IS_BETTER', baselineValue: '', baselineOn: '', targetValue: '800', measureAfterMonths: '', dataSource: 'Survey', formula: 'Sum of plots', ...overrides });
const form = (overrides: Partial<DraftForm> = {}): DraftForm => ({ basis: 'Decision 12', basisDocumentId: '', supersedeReason: '', indicators: [row()], ...overrides });

describe('the draft of the targets', () => {
  it('accepts a complete form and sends only what was written, the decimals as texts (the comma read as the point)', () => {
    expect(hasProblems(validateDraft(form(), false))).toBe(false);
    const body = draftBody(form({ indicators: [row({ baselineValue: ' 400,5 ', baselineOn: '2026-01-01', targetValue: '800', measureAfterMonths: '12' })] }), false);
    expect(body).toEqual({ basis: 'Decision 12', indicators: [{ code: 'IRRIGATED_HA', name: 'Irrigated area', unit: 'ha', direction: 'HIGHER_IS_BETTER', baseline_value: '400.5', baseline_on: '2026-01-01', target_value: '800', measure_after_months: 12, data_source: 'Survey', formula: 'Sum of plots' }] });
    expect(decimalText(' 12,25 ')).toBe('12.25');
  });

  it('asks for the reason of a revision only when a fixed set stands, and sends it', () => {
    expect(validateDraft(form(), true).supersedeReason).toBe('required');
    expect(validateDraft(form({ supersedeReason: 'too short' }), true).supersedeReason).toBe('short');
    expect(hasProblems(validateDraft(form({ supersedeReason: 'The scope of the works changed' }), true))).toBe(false);
    expect(draftBody(form({ supersedeReason: ' The scope of the works changed ' }), true)).toMatchObject({ supersede_reason: 'The scope of the works changed' });
    expect(draftBody(form({ supersedeReason: 'ignored' }), false)).not.toHaveProperty('supersede_reason');
  });

  it.each([
    ['basis', form({ basis: '' }), 'basis', 'required'],
    ['basis too short', form({ basis: 'ab' }), 'basis', 'short'],
    ['document id', form({ basisDocumentId: 'not-a-uuid' }), 'basisDocumentId', 'invalid'],
    ['no indicator', form({ indicators: [] }), 'indicators', 'invalid'],
  ])('refuses %s', (_name, input, field, problem) => {
    expect(validateDraft(input, false)[field as 'basis']).toBe(problem);
  });

  it.each([
    ['code in lower case', { code: 'irrigated' }, 'code', 'invalid'],
    ['empty code', { code: '' }, 'code', 'required'],
    ['short name', { name: 'ab' }, 'name', 'short'],
    ['no unit', { unit: '' }, 'unit', 'required'],
    ['target that is not a decimal', { targetValue: '12a' }, 'targetValue', 'invalid'],
    ['target with seven decimals', { targetValue: '1.1234567' }, 'targetValue', 'invalid'],
    ['no target', { targetValue: '' }, 'targetValue', 'required'],
    ['baseline that is not a decimal', { baselineValue: 'x' }, 'baselineValue', 'invalid'],
    ['a day that does not exist', { baselineOn: '2026-02-30' }, 'baselineOn', 'invalid'],
    ['months above 240', { measureAfterMonths: '241' }, 'measureAfterMonths', 'invalid'],
    ['months that are not whole', { measureAfterMonths: '1.5' }, 'measureAfterMonths', 'invalid'],
    ['no data source', { dataSource: '' }, 'dataSource', 'required'],
    ['no formula', { formula: '' }, 'formula', 'required'],
  ] as const)('refuses an indicator with %s', (_name, patch, field, problem) => {
    const found = validateDraft(form({ indicators: [row(patch)] }), false);
    expect(found.rows[0]?.[field]).toBe(problem);
    expect(hasProblems(found)).toBe(true);
  });

  it('refuses the same code twice', () => {
    const found = validateDraft(form({ indicators: [row(), row()] }), false);
    expect(found.rows[0]?.code).toBeUndefined();
    expect(found.rows[1]?.code).toBe('invalid');
  });

  it('starts from the set that stands (its indicators copied) or from one empty row', () => {
    const view = toEffectView(raw()) as EffectView;
    const start = draftFormOf(view.fixed);
    expect(start.basis).toBe('Decision 12');
    expect(start.supersedeReason).toBe('');
    expect(start.indicators[0]).toMatchObject({ code: 'IRRIGATED_HA', baselineValue: '400.5', targetValue: '800', measureAfterMonths: '12' });
    expect(draftFormOf(null).indicators).toHaveLength(1);
    expect(draftFormOf(null).indicators[0]?.code).toBe('');
  });
});

describe('the measurement, the assessment and the decision', () => {
  const full = { ...EMPTY_MEASURE, indicatorCode: 'IRRIGATED_HA', measuredOn: '2027-03-01', value: '612,5', methodNote: 'Field survey' };

  it('checks the measurement and sends the decimal as a text, with the correction only when one is chosen', () => {
    expect(validateMeasure(full, '2027-12-31')).toEqual({});
    expect(measureBody(full)).toEqual({ indicator_code: 'IRRIGATED_HA', measured_on: '2027-03-01', value: '612.5', method_note: 'Field survey' });
    const correcting = { ...full, correctsId: 'm0', correctionReason: 'The first reading was a typo' };
    expect(validateMeasure(correcting, '2027-12-31')).toEqual({});
    expect(measureBody({ ...correcting, evidenceDocumentId: '00000000-0000-4000-8000-0000000000e1' })).toMatchObject({ corrects_id: 'm0', correction_reason: 'The first reading was a typo', evidence_document_id: '00000000-0000-4000-8000-0000000000e1' });
  });

  it.each([
    ['no indicator', { indicatorCode: '' }, 'indicatorCode', 'required'],
    ['no day', { measuredOn: '' }, 'measuredOn', 'required'],
    ['a day in the future', { measuredOn: '2028-01-01' }, 'measuredOn', 'invalid'],
    ['a value that is not a decimal', { value: 'abc' }, 'value', 'invalid'],
    ['no value', { value: '' }, 'value', 'required'],
    ['no method', { methodNote: '' }, 'methodNote', 'required'],
    ['an evidence id that is not an id', { evidenceDocumentId: 'x' }, 'evidenceDocumentId', 'invalid'],
    ['a correction without a reason', { correctsId: 'm0', correctionReason: 'short' }, 'correctionReason', 'short'],
  ] as const)('refuses a measurement with %s', (_name, patch, field, problem) => {
    expect(validateMeasure({ ...full, ...patch }, '2027-12-31')[field]).toBe(problem);
  });

  it('checks the summary of an assessment and builds its body', () => {
    expect(validateAssess({ kind: 'FINAL', conclusion: 'SATISFACTORY', summary: 'short' }).summary).toBe('short');
    expect(validateAssess({ kind: 'FINAL', conclusion: 'SATISFACTORY', summary: 'All targets were reached' })).toEqual({});
    expect(assessBody({ kind: 'AD_HOC', conclusion: 'UNSATISFACTORY', summary: ' Not enough water ' })).toEqual({ kind: 'AD_HOC', conclusion: 'UNSATISFACTORY', summary: 'Not enough water' });
  });

  it('sends the reason of a decision only when there is one', () => {
    expect(decisionBody('APPROVE', '')).toEqual({ decision: 'APPROVE' });
    expect(decisionBody('RETURN', ' The summary does not match the figures ')).toEqual({ decision: 'RETURN', reason: 'The summary does not match the figures' });
  });
});

describe('describeRefusal', () => {
  it.each([
    ['EFFECT_TARGET_STATE_INVALID', 409, {}, 'targetState'],
    ['EFFECT_TARGET_STATE_INVALID', 409, { reason: 'NOT_THE_AUTHOR' }, 'notTheAuthor'],
    ['EFFECT_TARGETS_NOT_FIXED', 409, {}, 'notFixed'],
    ['EFFECT_MEASUREMENT_DUPLICATE', 409, {}, 'measurementDuplicate'],
    ['EFFECT_ASSESSMENT_STATE_INVALID', 409, {}, 'assessmentState'],
    ['EFFECT_ASSESSMENT_STATE_INVALID', 409, { reason: 'ALREADY_APPROVED' }, 'assessmentAlready'],
    ['PROJECT_STAGE_INVALID', 422, {}, 'stageInvalid'],
    ['SELF_APPROVAL_DENIED', 403, {}, 'selfApproval'],
    ['VERSION_CONFLICT', 409, {}, 'versionConflict'],
    ['VALIDATION_FAILED', 422, {}, 'validation'],
    ['VALIDATION_FAILED', 422, { reason: 'NO_MEASUREMENT' }, 'noMeasurement'],
    ['SCOPE_DENIED', 403, {}, 'denied'],
    ['RESOURCE_NOT_FOUND', 404, {}, 'notFound'],
    ['SESSION_EXPIRED', 401, {}, 'session'],
    ['SOMETHING_ELSE', 500, {}, 'general'],
  ])('words %s %j as %s', (code, status, extensions, expected) => {
    expect(describeRefusal(refusal(code, status, extensions)).refusal).toBe(expected);
  });

  it('keeps the field the server named, and words a failure that is not an answer of the server as general', () => {
    expect(describeRefusal(refusal('VALIDATION_FAILED', 422, {}, 'indicator_code'))).toEqual({ refusal: 'validation', field: 'indicator_code' });
    expect(describeRefusal(refusal('VALIDATION_FAILED', 422)).field).toBeUndefined();
    expect(describeRefusal(new Error('x'))).toEqual({ refusal: 'general', field: undefined });
  });
});
