import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { bytesOfBase64, changePathOf, checkOverride, checkOverrideTarget, describeChanges, describeRag, isRefused, magnitudeOf, overrideWindow, redFirst, scoreDelta, toChanges, toFiguresFile, toRagReading } from './gov-model';

const fail = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
const S40 = '00000000-0000-4000-8000-0000000000f2';

const line = (overrides: Record<string, unknown> = {}) => ({ kind: 'RATE_CHANGE', direction: 'UP', params: { from: '10.00', to: '12.50', delta: '2.50' }, link: 'DRILL', metric_code: 'DISBURSEMENT_RATE_PM', context_token: 'tok.sig', ...overrides });
const changes = (overrides: Record<string, unknown> = {}) => ({ snapshot_id: S40, as_of_date: '2027-10-12', week_start: '2027-10-11', previous_week_start: '2027-10-04', previous_as_of_date: '2027-10-05', reason: null, max_lines: 5, lines: [line()], ...overrides });

describe('"Thay đổi từ tuần trước" as the block reads it (G3-4)', () => {
  it('reads the lines with their numbers, and says no previous week when the server does', () => {
    const read = toChanges(changes());
    expect(read).toMatchObject({ weekStart: '2027-10-11', previousWeekStart: '2027-10-04', reason: null });
    expect(read?.lines[0]).toMatchObject({ kind: 'RATE_CHANGE', direction: 'UP', link: 'DRILL', params: { from: '10.00', to: '12.50', delta: '2.50' } });
    expect(toChanges(changes({ reason: 'NO_PREVIOUS_WEEK', lines: [], previous_week_start: '', previous_as_of_date: null }))?.reason).toBe('NO_PREVIOUS_WEEK');
  });

  it('keeps an empty list empty (nothing moved), and refuses an answer that is not one', () => {
    expect(toChanges(changes({ lines: [] }))?.lines).toEqual([]);
    for (const bad of [null, [], {}, changes({ snapshot_id: '' }), changes({ lines: 'x' })]) expect(toChanges(bad)).toBeUndefined();
  });

  it('does not say a line it has no sentence for or whose numbers are missing, and says at most five', () => {
    const read = toChanges(changes({ lines: [line({ kind: 'SURPRISE' }), line({ link: 'ELSEWHERE' }), line({ direction: 'SIDEWAYS' }), line({ params: { from: '1', to: '2' } }), ...Array.from({ length: 8 }, () => line())] }));
    expect(read?.lines).toHaveLength(5);
    expect(read?.lines.every((each) => each.kind === 'RATE_CHANGE')).toBe(true);
  });

  it('gives ONE link by kind: the drill with the token of the line, the colours, the warnings, the work, the ranking', () => {
    expect(changePathOf({ link: 'DRILL', contextToken: 'a.b+c' })).toBe('/home/home-10?token=a.b%2Bc');
    expect(changePathOf({ link: 'RAG', contextToken: null })).toBe('/home/home-11');
    expect(changePathOf({ link: 'WARNINGS', contextToken: null })).toBe('/home/home-03');
    expect(changePathOf({ link: 'MY_WORK', contextToken: null })).toBe('/home/home-02');
    expect(changePathOf({ link: 'RANKING', contextToken: null })).toBe('/home/home-04');
    // A drill with no token opens nothing: it has no link.
    expect(changePathOf({ link: 'DRILL', contextToken: null })).toBeUndefined();
    expect(changePathOf({ link: 'DRILL', contextToken: '' })).toBeUndefined();
  });

  it('writes the size of a change without the sign (the direction says it)', () => {
    expect(magnitudeOf('-2.50')).toBe('2.50');
    expect(magnitudeOf('+3')).toBe('3');
    expect(magnitudeOf(undefined)).toBe('');
  });

  it('tells nothing frozen, a refusal and a failure apart (a failure is never "no change")', () => {
    expect([fail(404, 'RESOURCE_NOT_FOUND'), fail(403, 'SCOPE_DENIED'), fail(500, 'INTERNAL_ERROR'), new Error('x')].map(describeChanges)).toEqual(['noSnapshot', 'denied', 'error', 'error']);
  });
});

const factor = (code: string, overrides: Record<string, unknown> = {}) => ({ code, value: 0.5, band: 'RED', points: 40, weight: 40, direction: 'HIGHER_IS_BETTER', green: 0.9, amber: 0.6, ...overrides });
const unit = (id: string, band: string, overrides: Record<string, unknown> = {}) => ({
  unit_id: id,
  code: id.toUpperCase(),
  name: `Đơn vị ${id}`,
  band,
  rule_band: band,
  overridden: false,
  override: null,
  score: band === 'NO_DATA' ? null : 55,
  coverage_pct: 100,
  no_data_reason: band === 'NO_DATA' ? 'LOW_COVERAGE' : null,
  factors: [factor('EWS_RATE_VS_PACE')],
  reasons: [factor('EWS_RATE_VS_PACE')],
  projects: 4,
  previous: { week_start: '2027-10-04', score: 40, band: 'AMBER' },
  trend: [{ week_start: '2027-10-04', score: 40, band: 'AMBER' }, { week_start: '2027-10-11', score: 55, band: 'RED' }],
  ...overrides,
});
const rag = (units: unknown[], overrides: Record<string, unknown> = {}) => ({ snapshot_id: S40, as_of_date: '2027-10-12', week_start: '2027-10-11', model: { unverified: true, versions: {}, min_coverage_pct: 60, score_green: 30, score_amber: 60, factors: [] }, summary: { RED: 1, AMBER: 0, GREEN: 1, NO_DATA: 1 }, units, ...overrides });

describe('the explainable colours as the screen reads them (G3-2)', () => {
  it('puts red first, then amber, then the units that cannot be judged, then green, and keeps the server order inside a colour', () => {
    const read = toRagReading(rag([unit('g', 'GREEN'), unit('n', 'NO_DATA'), unit('a', 'AMBER'), unit('r2', 'RED'), unit('r1', 'RED')]));
    expect(read?.units.map((each) => each.unitId)).toEqual(['r2', 'r1', 'a', 'n', 'g']);
    expect(redFirst([]).length).toBe(0);
  });

  it('never gives a unit without enough data a score, whatever it was sent with, and never turns a missing number into 0', () => {
    const read = toRagReading(rag([unit('n', 'NO_DATA', { score: 0, coverage_pct: null, factors: [factor('EWS_RATE_VS_PACE', { value: null, band: 'NO_DATA', points: 0 })], reasons: [] })]));
    expect(read?.units[0]).toMatchObject({ band: 'NO_DATA', score: null, coveragePct: null, noDataReason: 'LOW_COVERAGE' });
    expect(read?.units[0]?.factors[0]?.value).toBeNull();
  });

  it('keeps the colour of the rules beside the overridden colour, with its reason, its last day and who', () => {
    const read = toRagReading(rag([unit('o', 'GREEN', { rule_band: 'RED', overridden: true, override: { band: 'GREEN', rule_band: 'RED', reason: 'Đã có cam kết giải ngân', until: '2027-11-30', by: 'Lan', at: '2027-10-12T01:00:00Z' } })]));
    expect(read?.units[0]).toMatchObject({ band: 'GREEN', ruleBand: 'RED', overridden: true, override: { band: 'GREEN', ruleBand: 'RED', reason: 'Đã có cam kết giải ngân', until: '2027-11-30', by: 'Lan' } });
  });

  it('keeps the one to three reasons, the week before and the last eight weeks of the trend', () => {
    const weeks = Array.from({ length: 12 }, (_, index) => ({ week_start: `2027-0${(index % 9) + 1}-01`, score: index, band: 'AMBER' }));
    const read = toRagReading(rag([unit('r', 'RED', { reasons: [factor('A'), factor('B'), factor('C'), factor('D')], trend: weeks })]));
    expect(read?.units[0]?.reasons.map((each) => each.code)).toEqual(['A', 'B', 'C']);
    expect(read?.units[0]?.trend).toHaveLength(8);
    expect(read?.units[0]?.previous).toEqual({ weekStart: '2027-10-04', score: 40, band: 'AMBER' });
  });

  it('does not read a unit with no colour or no id, nor a factor with no line, and counts the summary itself when it was not sent', () => {
    const read = toRagReading(rag([unit('r', 'RED'), unit('x', 'PURPLE'), { ...unit('y', 'RED'), unit_id: '' }, unit('z', 'RED', { factors: [{ code: 'A', value: 1 }] })], { summary: undefined }));
    expect(read?.units.map((each) => each.unitId)).toEqual(['r', 'z']);
    expect(read?.units[1]?.factors).toEqual([]);
    expect(read?.summary).toEqual({ RED: 2, AMBER: 0, GREEN: 0, NO_DATA: 0 });
    for (const bad of [null, {}, rag('x' as never), { ...rag([]), snapshot_id: '' }]) expect(toRagReading(bad)).toBeUndefined();
  });

  it('measures the change of the score against the week before (positive is riskier) and says nothing without both', () => {
    expect(scoreDelta({ score: 55, previous: { weekStart: 'w', score: 40, band: 'AMBER' } })).toBe(15);
    expect(scoreDelta({ score: 30, previous: { weekStart: 'w', score: 40.5, band: 'AMBER' } })).toBe(-10.5);
    expect(scoreDelta({ score: null, previous: { weekStart: 'w', score: 40, band: 'AMBER' } })).toBeNull();
    expect(scoreDelta({ score: 5, previous: null })).toBeNull();
  });

  it('tells nothing frozen, a refusal and a failure apart, and counts 403 of the right as a refusal and no other', () => {
    expect([fail(404, 'RESOURCE_NOT_FOUND'), fail(403, 'SCOPE_DENIED'), fail(500, 'X'), new Error('x')].map(describeRag)).toEqual(['noSnapshot', 'denied', 'error', 'error']);
    expect(isRefused(fail(403, 'SCOPE_DENIED'))).toBe(true);
    expect(isRefused(fail(403, 'FORBIDDEN'))).toBe(true);
    expect(isRefused(fail(422, 'VALIDATION_FAILED'))).toBe(false);
    expect(isRefused(new Error('x'))).toBe(false);
  });
});

describe('what an override may be before it is asked for (G3-2)', () => {
  it('lasts after today and at most 90 days', () => {
    expect(overrideWindow('2027-10-12')).toEqual({ min: '2027-10-13', max: '2028-01-10' });
    expect(overrideWindow('2027-12-31')).toEqual({ min: '2028-01-01', max: '2028-03-30' });
  });

  it('must differ from the colour of the rules and end inside the window', () => {
    expect(checkOverrideTarget({ band: 'GREEN', until: '2027-11-01' }, 'RED', '2027-10-12')).toEqual([]);
    expect(checkOverrideTarget({ band: 'RED', until: '2027-11-01' }, 'RED', '2027-10-12')).toEqual(['band']);
    expect(checkOverrideTarget({ band: 'NO_DATA', until: '2027-11-01' }, 'RED', '2027-10-12')).toEqual(['band']);
    expect(checkOverrideTarget({ band: 'GREEN', until: '2027-10-12' }, 'RED', '2027-10-12')).toEqual(['until']);
    expect(checkOverrideTarget({ band: 'GREEN', until: '2028-01-11' }, 'RED', '2027-10-12')).toEqual(['until']);
    expect(checkOverrideTarget({ band: '', until: '' }, 'RED', '2027-10-12')).toEqual(['band', 'until']);
  });

  it('needs a reason of 10 to 500 characters, counted without the spaces around it', () => {
    expect(checkOverride({ band: 'GREEN', until: '2027-11-01', reason: 'ngắn' }, 'RED', '2027-10-12')).toEqual(['reason']);
    expect(checkOverride({ band: 'GREEN', until: '2027-11-01', reason: '   ngắn quá   ' }, 'RED', '2027-10-12')).toEqual(['reason']);
    expect(checkOverride({ band: 'GREEN', until: '2027-11-01', reason: 'Đã có cam kết giải ngân' }, 'RED', '2027-10-12')).toEqual([]);
    expect(checkOverride({ band: 'GREEN', until: '2027-11-01', reason: 'x'.repeat(501) }, 'RED', '2027-10-12')).toEqual(['reason']);
  });
});

describe('the file of the figures', () => {
  const file = { file_name: 'so-lieu.csv', media_type: 'text/csv', format: 'CSV', snapshot_id: S40, as_of_date: '2027-10-12', rows: 3, size_bytes: 5, sha256: 'ab', content_base64: 'aGVsbG8=' };

  it('reads the name, the type and the content, and refuses an answer with no content', () => {
    expect(toFiguresFile(file)).toMatchObject({ fileName: 'so-lieu.csv', mediaType: 'text/csv', format: 'CSV', rows: 3, contentBase64: 'aGVsbG8=' });
    for (const bad of [null, {}, { ...file, content_base64: '' }, { ...file, format: 'PDF' }, { ...file, file_name: '' }]) expect(toFiguresFile(bad)).toBeUndefined();
  });

  it('turns the base64 content into the bytes of the file', () => {
    expect(Array.from(bytesOfBase64('aGVsbG8='))).toEqual([104, 101, 108, 108, 111]);
  });
});
