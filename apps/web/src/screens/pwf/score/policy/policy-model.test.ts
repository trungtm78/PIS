import { DEFAULT_STAFF_SCORING_PARAMS, parseStaffScoringPolicy } from '@machvon/kernel/src/workflow-kpi.ts';
import { describe, expect, it } from 'vitest';
import { addBand, blankForm, formOf, paramsOf, problemsOf, removeBand, updateBand } from './policy-model';
import type { PolicyForm } from './policy-model';

const defaults = (): PolicyForm => formOf(DEFAULT_STAFF_SCORING_PARAMS);
const paths = (form: PolicyForm): string[] => problemsOf(form).map((one) => one.path);

describe('the form of the scoring policy reads and writes the params of the rule', () => {
  it('writes the default policy back to the same params and the kernel accepts it', () => {
    expect(paramsOf(defaults())).toEqual(DEFAULT_STAFF_SCORING_PARAMS);
    expect(() => parseStaffScoringPolicy(paramsOf(defaults()))).not.toThrow();
    expect(problemsOf(defaults())).toEqual([]);
  });

  it('starts blank with two bands, the last at 0, and reads nothing as blank', () => {
    expect(blankForm().bands).toHaveLength(2);
    expect(blankForm().bands[1]?.minScore).toBe('0');
    expect(formOf(null).bands).toHaveLength(2);
  });
});

describe('what is found wrong before the form is sent', () => {
  it('names the field of a number out of its range', () => {
    expect(paths({ ...defaults(), minRatedTasks: '0' })).toEqual(['min_rated_tasks']);
    expect(paths({ ...defaults(), maxAdjustment: '31' })).toEqual(['calibration.max_adjustment_points']);
    expect(paths({ ...defaults(), minReason: '19' })).toEqual(['calibration.min_reason_length']);
    expect(paths({ ...defaults(), responseWindow: '61' })).toEqual(['response_window_days']);
    expect(paths({ ...defaults(), retention: '11' })).toEqual(['retention_months']);
    expect(paths({ ...defaults(), roleFactors: { ...defaults().roleFactors, ACCOUNTABLE: '1.5' } })).toEqual(['role_factors.ACCOUNTABLE']);
    expect(paths({ ...defaults(), priorityWeights: { ...defaults().priorityWeights, LOW: '0' } })).toEqual(['priority_weights.LOW']);
    expect(paths({ ...defaults(), minEffectiveWeight: '' })).toEqual(['min_effective_weight']);
  });

  it('wants the bands to fall, to have distinct codes, and the last to start at 0', () => {
    expect(paths(updateBand(defaults(), 1, { minScore: '95' }))).toEqual(['bands[1].min_score']);
    expect(paths(updateBand(defaults(), 1, { code: 'EXCELLENT' }))).toEqual(['bands[1].code']);
    expect(paths(updateBand(defaults(), 3, { minScore: '5' }))).toEqual(['bands[3].min_score']);
    expect(problemsOf(updateBand(defaults(), 3, { minScore: '5' }))[0]?.kind).toBe('lastBand');
    expect(paths(updateBand(defaults(), 0, { code: 'bad' }))).toEqual(['bands[0].code']);
    expect(() => parseStaffScoringPolicy(paramsOf(updateBand(defaults(), 1, { minScore: '95' })))).toThrow();
  });

  it('adds a band before the last one and never goes below two or above eight', () => {
    let form = defaults();
    for (let at = 0; at < 10; at += 1) form = addBand(form);
    expect(form.bands).toHaveLength(8);
    expect(form.bands[form.bands.length - 1]?.minScore).toBe('0');
    expect(paths(form).length).toBeGreaterThan(0);
    let small = blankForm();
    small = removeBand(small, 0);
    expect(small.bands).toHaveLength(2);
    expect(removeBand(defaults(), 1).bands).toHaveLength(3);
  });
});
