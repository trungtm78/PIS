import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  appliedCount,
  appointBody,
  appointProblems,
  decimalText,
  decisionBody,
  decisionProblems,
  decisionsFrom,
  directiveBody,
  directiveProblems,
  dimensionOf,
  filterQuery,
  filtersFrom,
  figureWord,
  isDay,
  lastYearView,
  meetingBody,
  optionsOf,
  outlookView,
  pctText,
  pointsText,
  refusalOf,
  stateOf,
  toFigure,
  vndText,
} from './model';
import type { Figure, Row } from './model';

const UNIT = '00000000-0000-4000-8000-000000000011';
const MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';

describe('numbers are written from the text of the API', () => {
  it('groups the thousands of a whole amount with the mark of the locale and never goes through a float', () => {
    expect(decimalText('1250000000000', 'vi')).toBe('1.250.000.000.000');
    expect(decimalText('1250000000000', 'en')).toBe('1,250,000,000,000');
    // 2^63 + 1 is not representable as a float: the digits survive because they are never parsed.
    expect(decimalText('9223372036854775809', 'vi')).toBe('9.223.372.036.854.775.809');
    expect(decimalText('-1234567.50', 'vi')).toBe('-1.234.567,50');
    expect(decimalText('60.00', 'en')).toBe('60.00');
  });

  it('keeps what is not a decimal as it came and keeps null as null (an unknown amount is never 0)', () => {
    expect(decimalText('n/a', 'vi')).toBe('n/a');
    expect(vndText(null, 'vi')).toBeNull();
    expect(vndText(undefined, 'vi')).toBeNull();
    expect(vndText('0', 'vi')).toBe('0');
    expect(pctText(null, 'vi')).toBeNull();
    expect(pctText('61.25', 'vi')).toBe('61,25%');
  });

  it('writes points with their sign and zero without one', () => {
    expect(pointsText('3.20', 'vi')).toBe('+3,20');
    expect(pointsText('-4.10', 'vi')).toBe('-4,10');
    expect(pointsText('0.00', 'vi')).toBe('0,00');
    expect(pointsText(null, 'vi')).toBeNull();
  });
});

describe('days', () => {
  it('accepts only real days of the calendar', () => {
    expect(isDay('2026-11-08')).toBe(true);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('08/11/2026')).toBe(false);
  });
});

describe('figures', () => {
  const raw = (over: Partial<Figure> = {}): Figure => ({ metric_code: 'COMMITTEE_DISBURSEMENT_RATE', value: '61.2', display_value: '61,20', null_reason: null, unit: 'PERCENT', formula: 'a / b', flags: ['UNVERIFIED_DEFINITION'], ...over });

  it('takes the text of the server and the definition behind the "i", and drops a flag nobody knows', () => {
    const tile = toFigure(raw({ flags: ['UNVERIFIED_DEFINITION', 'FUTURE_FLAG' as never], kpi: { code: 'COMMITTEE_DISBURSEMENT_RATE', name: 'Rate', formula: 'a / b', source: 's', owner: 'o', version: 0, origin: 'DEFAULT', unverified: true, asOf: '2026-11-08', exclusions: [] } }));
    expect(tile).toMatchObject({ metricCode: 'COMMITTEE_DISBURSEMENT_RATE', displayValue: '61,20', unit: 'PERCENT', flags: ['UNVERIFIED_DEFINITION'], kpi: { name: 'Rate', unverified: true } });
  });

  it('keeps a missing text missing (no zero is made) and says why', () => {
    const tile = toFigure(raw({ value: null, display_value: null, null_reason: 'NO_DATA', flags: ['NO_DATA'] }));
    expect(tile?.displayValue).toBeNull();
    expect(tile?.nullReason).toBe('NO_DATA');
  });

  it('does not show a figure of a unit nobody knows', () => {
    expect(toFigure(raw({ unit: 'GRAMS' }))).toBeUndefined();
  });

  it('names a metric by the word of its code', () => {
    expect(figureWord('COMMITTEE_GAP_VS_CURVE')).toBe('gapVsCurve');
    expect(figureWord('COMMITTEE_DIRECTIVES_OVERDUE')).toBe('directivesOverdue');
    expect(figureWord('COMMITTEE_PLAN_TOTAL')).toBe('planTotal');
  });
});

describe('the filters of an address', () => {
  it('reads codes and a unit id, drops anything else, and counts what is applied', () => {
    const params = new URLSearchParams({ sector_code: 'GT', district_code: 'a b', investor_unit_id: 'not-a-uuid', fund_source_code: 'NSTW' });
    const filters = filtersFrom(params);
    expect(filters).toEqual({ sector_code: 'GT', district_code: '', investor_unit_id: '', fund_source_code: 'NSTW' });
    expect(appliedCount(filters)).toBe(2);
    expect(filterQuery(filters)).toEqual({ sector_code: 'GT', fund_source_code: 'NSTW' });
    expect(filtersFrom(new URLSearchParams({ investor_unit_id: UNIT.toUpperCase() })).investor_unit_id).toBe(UNIT);
  });

  it('falls back to the sector tab for a tab nobody knows and keeps a chosen value in the options', () => {
    expect(dimensionOf('fundSource')).toBe('fundSource');
    expect(dimensionOf('x')).toBe('sector');
    expect(dimensionOf(null)).toBe('sector');
    const rows = [{ key: 'GT', label: 'Transport' }] as Row[];
    expect(optionsOf(rows, 'GT')).toEqual([{ key: 'GT', label: 'Transport' }]);
    expect(optionsOf(rows, 'XD')[0]).toEqual({ key: 'XD', label: 'XD' });
  });
});

describe('the year-end band and last year', () => {
  const outlook = (over: Record<string, unknown> = {}) => ({ low_vnd: '800000000', high_vnd: '950000000', low_pct: '80.00', high_pct: '95.00', methods: [], thin: false, reason: null, ...over }) as never;

  it('says the band when both ends are known and why when one is not', () => {
    expect(outlookView(outlook(), 'vi')).toEqual({ kind: 'range', low: '800.000.000', high: '950.000.000', lowPct: '80,00%', highPct: '95,00%', thin: false });
    expect(outlookView(outlook({ low_vnd: null, high_vnd: null, reason: 'NO_PLAN' }), 'vi')).toEqual({ kind: 'none', reason: 'noPlan' });
    expect(outlookView(outlook({ high_vnd: null, reason: null }), 'vi')).toEqual({ kind: 'none', reason: 'noData' });
  });

  it('gives last year as an amount, as a coverage when only some lines have it, or as none', () => {
    expect(lastYearView({ last_year_vnd: '5', last_year_coverage: { known: 3, total: 3 } }, 'vi')).toEqual({ kind: 'amount', amount: '5' });
    expect(lastYearView({ last_year_vnd: null, last_year_coverage: { known: 2, total: 5 } }, 'vi')).toEqual({ kind: 'partial', known: 2, total: 5 });
    expect(lastYearView({ last_year_vnd: null, last_year_coverage: { known: 0, total: 5 } }, 'vi')).toEqual({ kind: 'none' });
    expect(lastYearView({ last_year_vnd: null, last_year_coverage: { known: 0, total: 0 } }, 'vi')).toEqual({ kind: 'none' });
  });
});

describe('decisions on the attention list', () => {
  it('offers what means something from the state a row is in', () => {
    expect(decisionsFrom('NONE')).toEqual(['ACKNOWLEDGED', 'DEFERRED', 'DIRECTED']);
    expect(decisionsFrom('REOPENED')).toEqual(['ACKNOWLEDGED', 'DEFERRED', 'DIRECTED']);
    expect(decisionsFrom('DEFERRED')).toContain('REOPENED');
    expect(decisionsFrom('DIRECTED')).toEqual(['REOPENED']);
    expect(stateOf({ decision: null })).toBe('NONE');
    expect(stateOf({ decision: { decision: 'DEFERRED' } as never })).toBe('DEFERRED');
  });

  it('wants a note for every decision and a day after today for a deferral', () => {
    expect(decisionProblems({ decision: 'ACKNOWLEDGED', note: '  ', deferUntil: '' }, '2026-11-08')).toEqual(['note']);
    expect(decisionProblems({ decision: 'ACKNOWLEDGED', note: 'seen', deferUntil: '' }, '2026-11-08')).toEqual([]);
    expect(decisionProblems({ decision: 'DEFERRED', note: 'wait', deferUntil: '2026-11-08' }, '2026-11-08')).toEqual(['deferUntil']);
    expect(decisionProblems({ decision: 'DEFERRED', note: 'wait', deferUntil: '2026-11-09' }, '2026-11-08')).toEqual([]);
  });

  it('sends the day only with a deferral and trims the note', () => {
    expect(decisionBody({ projectId: UNIT, decision: 'ACKNOWLEDGED', note: ' seen ', deferUntil: '2026-12-01' })).toEqual({ project_id: UNIT, decision: 'ACKNOWLEDGED', note: 'seen' });
    expect(decisionBody({ projectId: UNIT, decision: 'DEFERRED', note: 'wait', deferUntil: '2026-12-01' })).toEqual({ project_id: UNIT, decision: 'DEFERRED', note: 'wait', defer_until: '2026-12-01' });
  });
});

describe('the directive issued from a project row', () => {
  const project = { project_id: MEMBERSHIP, investor_unit_id: UNIT };

  it('needs a meeting, a text and a due day not before the meeting', () => {
    const base = { meeting: { kind: 'existing', meetingId: 'm1' } as const, meetingDate: '2026-11-03', text: 'Speed up', dueOn: '2026-11-20', today: '2026-11-08' };
    expect(directiveProblems(base)).toEqual([]);
    expect(directiveProblems({ ...base, meeting: { kind: 'existing', meetingId: '' } })).toEqual(['meeting']);
    expect(directiveProblems({ ...base, text: ' ' })).toEqual(['text']);
    expect(directiveProblems({ ...base, dueOn: '2026-11-02' })).toEqual(['dueOn']);
    expect(directiveProblems({ ...base, dueOn: '' })).toEqual(['dueOn']);
  });

  it('holds a new meeting to today for the due day', () => {
    const base = { meeting: { kind: 'new', title: 'Committee' } as const, meetingDate: '', text: 'Speed up', dueOn: '2026-11-07', today: '2026-11-08' };
    expect(directiveProblems(base)).toEqual(['dueOn']);
    expect(directiveProblems({ ...base, dueOn: '2026-11-08' })).toEqual([]);
    expect(directiveProblems({ ...base, meeting: { kind: 'new', title: ' ' }, dueOn: '2026-11-08' })).toEqual(['meeting']);
  });

  it('builds the bodies of the DIR commands from the project row', () => {
    expect(meetingBody({ project, today: '2026-11-08', title: ' Committee ' })).toEqual({ meeting_date: '2026-11-08', meeting_type: 'EXTRAORDINARY', title: 'Committee', unit_id: UNIT });
    expect(directiveBody({ project, text: ' Speed up ', dueOn: '2026-11-20' })).toEqual({ scope_kind: 'PROJECT', project_id: MEMBERSHIP, text: 'Speed up', assignee_unit_id: UNIT, due_on: '2026-11-20' });
  });
});

describe('the appointment of a member', () => {
  const input = { committeeId: UNIT, membershipId: MEMBERSHIP, role: 'HEAD' as const, agencyCode: 'PA05', agencyName: '', decisionRef: ' QD-57 ', validFrom: '2026-11-01', validUntil: '', mfaRequired: true };

  it('checks the person, the days and the code of the agency', () => {
    expect(appointProblems(input)).toEqual([]);
    expect(appointProblems({ ...input, membershipId: 'x', validFrom: '', agencyCode: '??' })).toEqual(['membership', 'validFrom', 'agencyCode']);
    expect(appointProblems({ ...input, validUntil: '2026-10-01' })).toEqual(['validUntil']);
  });

  it('sends only what was typed', () => {
    expect(appointBody(input)).toEqual({ committee_id: UNIT, membership_id: MEMBERSHIP, committee_role: 'HEAD', agency_code: 'PA05', decision_ref: 'QD-57', valid_from: '2026-11-01', mfa_required: true });
    expect(appointBody({ ...input, mfaRequired: false, validUntil: '2027-01-01' })).not.toHaveProperty('mfa_required');
    expect(appointBody({ ...input, validUntil: '2027-01-01' })).toHaveProperty('valid_until', '2027-01-01');
  });
});

describe('refusals', () => {
  it('reads the code, the field and the reason of a problem, and says unknown for anything else', () => {
    const error = new ApiError({ status: 422, code: 'VALIDATION_FAILED', correlationId: 'c', detail: 'membership_id', extensions: { reason: 'self_appointment' } });
    expect(refusalOf(error)).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'membership_id', reason: 'self_appointment' });
    expect(refusalOf(new Error('x')).code).toBe('UNKNOWN');
  });
});
