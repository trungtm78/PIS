import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { billions, bytesOfBase64, chartPoints, dayText, describeRefusal, deviationTone, incompleteIssues, isCalendarDay, toBaselineView, toComponentLinks, toDisbursementCheck, toEvmView, toExportFile, toSCurveView, vietnamToday } from './model';

const ID = '00000000-0000-4000-8000-000000000001';
const refusal = (code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 422, code, correlationId: 'c', extensions });

describe('the models of the baseline, earned value and disbursement screens', () => {
  it('reads the days of Vietnam and writes them as the reader does', () => {
    expect(vietnamToday(new Date('2026-11-08T18:00:00.000Z'))).toBe('2026-11-09');
    expect(vietnamToday(new Date('2026-11-08T16:59:00.000Z'))).toBe('2026-11-08');
    expect(isCalendarDay('2026-02-29')).toBe(false);
    expect(isCalendarDay('2026-02-28')).toBe(true);
    expect(isCalendarDay('08/11/2026')).toBe(false);
    expect(dayText('2026-11-08')).toBe('08/11/2026');
    expect(dayText('yesterday')).toBe('yesterday');
    expect(dayText(null)).toBe('');
  });

  it('refuses what is not the shape of an answer', () => {
    for (const parse of [toBaselineView, toEvmView, toSCurveView, toDisbursementCheck, toExportFile]) {
      expect(parse(undefined)).toBeUndefined();
      expect(parse(null)).toBeUndefined();
      expect(parse([])).toBeUndefined();
      expect(parse({})).toBeUndefined();
    }
    expect(toEvmView({ project_id: ID })).toBeUndefined();
    expect(toSCurveView({ project_id: ID })).toBeUndefined();
    expect(toDisbursementCheck({ project_id: ID, allowed: 'yes' })).toBeUndefined();
    expect(toComponentLinks({})).toBeUndefined();
    expect(toComponentLinks({ items: [] })).toEqual([]);
  });

  it('keeps money as the string it came as, null as null, and ignores a field it does not list', () => {
    const view = toEvmView({
      project_id: ID,
      project_code: 'DA-01',
      scope: 'WHATEVER',
      source: 'FROZEN',
      secret: 'not listed',
      baseline: { version: 0, selection: 'V0' },
      figures: { status: 'OK', as_of: '2026-11-08', eac_method: 'CPI_CUMULATIVE', bac_vnd: '9007199254740993123', pv_vnd: '0', ev_vnd: null, ac_vnd: '', cpi: '0.9250', spi: null, unavailable: { ev: 'EV_ZERO', nonsense: 'X', cpi: 7 }, missing: ['NO_BASELINE', 3], rag_cpi: 'AMBER', rag_spi: 'PURPLE', extra: 1 },
      eac_against_total: { over_vnd: '-5', over_pct: null },
      total_investment_vnd: '100',
      rows: [{ key: 'a', code: 'GT-1', name: 'Package', bac_vnd: '10', pv_vnd: '0', ev_vnd: null, ac_vnd: '0', cpi: null, spi: '1.0000', rag_cpi: null, rag_spi: 'GREEN', missing: ['NO_CONTRACT_LINK'], contracts: [{ contract_id: ID, code: 'HD-1', value_vnd: '5' }, 'bad'] }, 'bad'],
      policy: { version: '3', source: 'BUILT_IN', eac_method: 'CPI_CUMULATIVE', amber_below: 0.95, red_below: 0.85 },
    });
    expect(view).toBeDefined();
    expect(view).not.toHaveProperty('secret');
    expect(view?.scope).toBe('PROJECT');
    expect(view?.source).toBe('FROZEN');
    expect(view?.figures.bacVnd).toBe('9007199254740993123');
    expect(view?.figures.pvVnd).toBe('0');
    expect(view?.figures.evVnd).toBeNull();
    expect(view?.figures.acVnd).toBeNull();
    expect(view?.figures.spi).toBeNull();
    expect(view?.figures.unavailable).toEqual({ ev: 'EV_ZERO' });
    expect(view?.figures.missing).toEqual(['NO_BASELINE']);
    expect(view?.figures.ragCpi).toBe('AMBER');
    expect(view?.figures.ragSpi).toBeNull();
    expect(view?.figures).not.toHaveProperty('extra');
    expect(view?.eacAgainstTotal).toEqual({ overVnd: '-5', overPct: null });
    expect(view?.rows).toHaveLength(1);
    expect(view?.rows[0]).toMatchObject({ evVnd: null, acVnd: '0', pvVnd: '0', ragSpi: 'GREEN', contracts: [{ contractId: ID, code: 'HD-1', valueVnd: '5' }] });
    expect(view?.policy).toEqual({ version: '3', source: 'BUILT_IN', eacMethod: 'CPI_CUMULATIVE', amberBelow: 0.95, redBelow: 0.85 });
  });

  it('reads the baseline with its allowlist, fills what is left out with empty and never with a number', () => {
    const view = toBaselineView({ project_id: ID, project_code: 'DA-01', versions: [{ id: ID, version: 2, kind: 'REVISION', total_investment_vnd: '1', bac_vnd: '2', lines: ['bad', { component_id: ID, code: 'C', name: 'N', bac_vnd: '3' }] }, 'bad'], deviation: { cost_vnd: '5', cost_pct: null, bac_vnd: '6', finish_slip_days: null, milestones: [{ code: 'M1', moves: 2 }] }, policy: { version: '1', source: 'BUILT_IN' }, actions: { capture: true }, hidden: 1 });
    expect(view).not.toHaveProperty('hidden');
    expect(view?.hasBaseline).toBe(false);
    expect(view?.versions).toHaveLength(1);
    expect(view?.versions[0]).toMatchObject({ kind: 'REVISION', version: 2, sourceRevisionId: null });
    expect(view?.versions[0]?.lines).toHaveLength(1);
    expect(view?.deviation).toMatchObject({ costVnd: '5', costPct: null, finishSlipDays: null });
    expect(view?.deviation?.milestones[0]).toMatchObject({ code: 'M1', moves: 2, slipDays: null });
    expect(view?.policy).toMatchObject({ source: 'BUILT_IN', costPct: null, slipDays: null, rescheduleAlertCount: null });
    expect(view?.actions).toEqual({ capture: true, decideReappraisal: false, acknowledgeAlert: false });
    expect(toBaselineView({ project_id: ID, deviation: 'no' })?.deviation).toBeNull();
  });

  it('reads the curve, the checks and the export file', () => {
    const curve = toSCurveView({ project_id: ID, project_code: 'DA', as_of: '2026-11-08', points: [{ day: '2026-11-08', pv_v0_vnd: '1', pv_current_vnd: '2', ev_vnd: null, ac_vnd: '0' }, 'bad'], figures: {}, missing: ['NO_SCHEDULE'] });
    expect(curve?.points).toEqual([{ day: '2026-11-08', pvV0Vnd: '1', pvCurrentVnd: '2', evVnd: null, acVnd: '0' }]);
    expect(curve?.figures.status).toBe('INSUFFICIENT');
    expect(toDisbursementCheck({ project_id: ID, allowed: false, refusal: 'DISBURSEMENT_NO_APPROVED_PLAN', fix: 'ENTER_APPROVED_PLAN', cause: { project_status: 'BUDGETED', allocated_vnd: '0' }, warnings: ['REAPPRAISAL_OPEN', 4], policy_version: '1' })).toMatchObject({ allowed: false, refusal: 'DISBURSEMENT_NO_APPROVED_PLAN', fix: 'ENTER_APPROVED_PLAN', cause: { allocatedVnd: '0' }, warnings: ['REAPPRAISAL_OPEN'] });
    expect(toDisbursementCheck({ project_id: ID, allowed: true, refusal: 'OTHER', fix: 'OTHER' })).toMatchObject({ refusal: null, fix: null });
    expect(toExportFile({ file_name: 'a.xlsx', content_base64: 'AQID', size_bytes: 3, sha256: 'x' })).toMatchObject({ fileName: 'a.xlsx', contentType: 'application/octet-stream', sizeBytes: 3 });
    expect(toExportFile({ file_name: 'a.xlsx', content_base64: '' })).toBeUndefined();
  });

  it('decodes the bytes of a file exactly, and draws money in billions without losing the whole dong in the text', () => {
    expect([...bytesOfBase64('AAECAwT/')]).toEqual([0, 1, 2, 3, 4, 255]);
    expect(billions('2500000000')).toBe(2.5);
    expect(billions('-1000000000')).toBe(-1);
    expect(billions(null)).toBeNull();
    expect(billions('12.5')).toBeNull();
  });

  it('thins the curve for the picture but always keeps the first, the last and the day of the view', () => {
    const points = Array.from({ length: 50 }, (_, index) => ({ day: `2026-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`, pvV0Vnd: '1', pvCurrentVnd: '1', evVnd: null, acVnd: null }));
    const asOf = points[23]?.day ?? '';
    const thinned = chartPoints(points, asOf, 10);
    expect(thinned.length).toBeLessThanOrEqual(10);
    expect(thinned[0]).toBe(points[0]);
    expect(thinned[thinned.length - 1]).toBe(points[49]);
    expect(thinned.map((point) => point.day)).toContain(asOf);
    expect(chartPoints(points.slice(0, 5), asOf, 10)).toHaveLength(5);
  });

  it('judges a deviation against its threshold and says nothing when there is nothing to compare', () => {
    expect(deviationTone('12.50', 10)).toBe('danger');
    expect(deviationTone('-12.50', 10)).toBe('danger');
    expect(deviationTone('8', 10)).toBe('warning');
    expect(deviationTone('2', 10)).toBe('default');
    expect(deviationTone(31, 30)).toBe('danger');
    expect(deviationTone(null, 10)).toBe('default');
    expect(deviationTone('5', null)).toBe('default');
    expect(deviationTone('x', 10)).toBe('default');
  });

  it('words every refusal and names the components that stop a capture', () => {
    const cases: Array<[string, string]> = [
      ['BASELINE_NO_WBS', 'noWbs'],
      ['BASELINE_INCOMPLETE', 'incomplete'],
      ['BASELINE_ALREADY_TAKEN', 'alreadyTaken'],
      ['SELF_APPROVAL_DENIED', 'selfApproval'],
      ['REAPPRAISAL_STATE_INVALID', 'reappraisalState'],
      ['GOVERNANCE_ALERT_STATE_INVALID', 'alertState'],
      ['VERSION_CONFLICT', 'versionConflict'],
      ['COMPONENT_CONTRACT_UNCHANGED', 'componentUnchanged'],
      ['BASELINE_MISSING', 'baselineMissing'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['SCOPE_DENIED', 'denied'],
      ['ENTITLEMENT_DENIED', 'denied'],
      ['VALIDATION_FAILED', 'validation'],
      ['SESSION_EXPIRED', 'session'],
      ['SOMETHING_ELSE', 'general'],
    ];
    for (const [code, expected] of cases) expect(describeRefusal(refusal(code))).toBe(expected);
    expect(describeRefusal(new Error('x'))).toBe('general');
    expect(incompleteIssues(refusal('BASELINE_INCOMPLETE', { issues: [{ code: 'NO_FINISH_DATE', component_code: 'C1' }, { code: 'FINISH_BEFORE_START', component_code: 'C2' }, { code: 'NEW', component_code: 'C3' }, 'bad'] }))).toEqual([
      { componentCode: 'C1', problem: 'NO_FINISH_DATE' },
      { componentCode: 'C2', problem: 'FINISH_BEFORE_START' },
      { componentCode: 'C3', problem: 'OTHER' },
    ]);
    expect(incompleteIssues(refusal('BASELINE_NO_WBS'))).toEqual([]);
    expect(incompleteIssues(new Error('x'))).toEqual([]);
  });
});
