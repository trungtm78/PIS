import { DEFAULT_KPI_SET_PARAMS, convertScore, parseKpiSet } from '@machvon/kernel/src/workflow-kpi.ts';
import { describe, expect, it } from 'vitest';
import { kpiOperations } from '../test/fixtures';
import { NO_REFERENCES, addItem, addStep, blankForm, blankItem, convert, curveOf, formOf, operationOf, paramNames, paramsOf, problemsOf, removeItem, removeStep, updateItem, updateScale, updateStep } from './kpi-set-model';
import type { ItemForm, KpiSetForm, ScaleForm } from './kpi-set-model';

const valid = (): KpiSetForm => ({
  templateCode: 'PUBLIC_INVESTMENT',
  items: [{ ...blankItem(), kpiCode: 'PWF_TASK_DEVIATION_DAYS', weight: '40', scale: { ...blankItem().scale, worst: '10', best: '0' }, ragCode: 'PWF_SCORE' }],
});

const paths = (form: KpiSetForm, references = NO_REFERENCES): string[] => problemsOf(form, references, undefined).map((one) => one.path);

describe('the form of a KPI set reads and writes the params of the rule', () => {
  it('writes the default set the kernel ships back to the same params, and the kernel accepts what the form writes', () => {
    const form = formOf(DEFAULT_KPI_SET_PARAMS);
    expect(form.items).toHaveLength(6);
    expect(paramsOf(form)).toEqual(DEFAULT_KPI_SET_PARAMS);
    expect(() => parseKpiSet(paramsOf(form))).not.toThrow();
    expect(problemsOf(form)).toEqual([]);
  });

  it('starts a blank form with one item and reads nothing as a blank item', () => {
    expect(blankForm().items).toHaveLength(1);
    expect(formOf(null).items).toHaveLength(1);
    expect(formOf({ template_code: 'X', items: [{ scale: { kind: 'STEPPED', mode: 'AT_LEAST', steps: [], otherwise_score: 5 } }] }).items[0]?.scale.steps).toEqual([{ bound: '', score: '' }]);
  });

  it('leaves out the parameters and the scope an item does not use', () => {
    const params = paramsOf(valid()) as { items: Array<Record<string, unknown>> };
    expect(params.items[0]).not.toHaveProperty('operation_params');
    expect(params.items[0]).not.toHaveProperty('applies_to');
    const withParams = updateItem(valid(), 0, { unit: 'WORKING', against: 'FIRST_BASELINE', grace: '2', kinds: ['TASK'], phases: 'PREPARATION, EXECUTION', tasks: 'T1' });
    const item = (paramsOf(withParams) as { items: Array<Record<string, unknown>> }).items[0];
    expect(item?.operation_params).toEqual({ unit: 'WORKING', against: 'FIRST_BASELINE', grace_days: 2 });
    expect(item?.applies_to).toEqual({ task_kinds: ['TASK'], phases: ['PREPARATION', 'EXECUTION'], tasks: ['T1'] });
    expect(() => parseKpiSet(paramsOf(withParams))).not.toThrow();
  });

  it('adds and removes items and steps inside the limits', () => {
    let form = valid();
    for (let at = 0; at < 30; at += 1) form = addItem(form);
    expect(form.items).toHaveLength(20);
    expect(removeItem(form, 0).items).toHaveLength(19);
    let stepped = updateScale(valid(), 0, { kind: 'STEPPED' });
    for (let at = 0; at < 20; at += 1) stepped = addStep(stepped, 0);
    expect((stepped.items[0] as ItemForm).scale.steps).toHaveLength(10);
    expect((removeStep(stepped, 0, 0).items[0] as ItemForm).scale.steps).toHaveLength(9);
    const single = updateScale(valid(), 0, { kind: 'STEPPED' });
    expect((removeStep(single, 0, 0).items[0] as ItemForm).scale.steps).toHaveLength(1);
    expect((updateStep(single, 0, 0, { bound: '3' }).items[0] as ItemForm).scale.steps[0]?.bound).toBe('3');
  });
});

describe('what is found wrong before the form is sent', () => {
  it('accepts a good form and names the field of each defect', () => {
    expect(paths(valid())).toEqual([]);
    expect(paths({ ...valid(), templateCode: '' })).toEqual(['template_code']);
    expect(paths(updateItem(valid(), 0, { kpiCode: 'bad code' }))).toEqual(['items[0].kpi_code']);
    expect(paths(updateItem(valid(), 0, { weight: '0' }))).toEqual(['items[0].weight']);
    expect(paths(updateItem(valid(), 0, { weight: '101' }))).toEqual(['items[0].weight']);
    expect(paths(updateItem(valid(), 0, { grace: '31' }))).toEqual(['items[0].grace']);
    expect(paths(updateItem(valid(), 0, { ragCode: 'bad' }))).toEqual(['items[0].rag_code']);
    expect(paths(updateItem(valid(), 0, { phases: 'good_one, BAD' }))).toEqual(['items[0].phases']);
  });

  it('refuses two items with the same KPI code (a code is measured once in a set)', () => {
    const form = { ...valid(), items: [valid().items[0] as ItemForm, valid().items[0] as ItemForm] };
    expect(paths(form)).toEqual(['items[1].kpi_code']);
  });

  it('checks the references against the registers when they could be read, and not at all when they could not', () => {
    const references = { kpiCodes: ['OTHER'], ragCodes: ['OTHER'], templateCodes: ['OTHER'] };
    expect(paths(valid(), references).sort()).toEqual(['items[0].kpi_code', 'items[0].rag_code', 'template_code']);
    expect(paths(valid(), NO_REFERENCES)).toEqual([]);
  });

  it('refuses an operation the catalogue does not have', () => {
    const operations = kpiOperations().items as never;
    expect(problemsOf(valid(), NO_REFERENCES, operations)).toEqual([]);
    expect(problemsOf(updateItem(valid(), 0, { operation: 'EVIDENCE_COMPLETENESS' }), NO_REFERENCES, (operations as Array<{ code: string }>).filter((one) => one.code !== 'EVIDENCE_COMPLETENESS') as never).map((one) => one.path)).toEqual(['items[0].operation']);
  });

  it('refuses a linear scale whose two ends are the same', () => {
    expect(problemsOf(updateScale(valid(), 0, { worst: '5', best: '5' })).map((one) => [one.path, one.kind])).toEqual([['items[0].scale.best', 'sameValue']]);
    expect(paths(updateScale(valid(), 0, { worst: '', best: 'x' }))).toEqual(['items[0].scale.worst', 'items[0].scale.best']);
  });

  const stepped = (mode: 'AT_MOST' | 'AT_LEAST', steps: Array<[string, string]>): KpiSetForm =>
    updateScale(valid(), 0, { kind: 'STEPPED', mode, otherwise: '0', steps: steps.map(([bound, score]) => ({ bound, score })) });

  it('wants the bounds of a stepped scale to climb for AT_MOST and fall for AT_LEAST, as the kernel does', () => {
    expect(paths(stepped('AT_MOST', [['0', '100'], ['5', '80']]))).toEqual([]);
    expect(paths(stepped('AT_MOST', [['5', '100'], ['0', '80']]))).toEqual(['items[0].scale.steps[1].bound']);
    expect(paths(stepped('AT_MOST', [['5', '100'], ['5', '80']]))).toEqual(['items[0].scale.steps[1].bound']);
    expect(paths(stepped('AT_LEAST', [['90', '100'], ['70', '80']]))).toEqual([]);
    expect(paths(stepped('AT_LEAST', [['70', '100'], ['90', '80']]))).toEqual(['items[0].scale.steps[1].bound']);
    expect(() => parseKpiSet(paramsOf(stepped('AT_MOST', [['0', '100'], ['5', '80']])))).not.toThrow();
    expect(() => parseKpiSet(paramsOf(stepped('AT_MOST', [['5', '100'], ['0', '80']])))).toThrow();
  });

  it('checks the scores of the steps and the score for no step inside 0 to 100', () => {
    expect(paths(stepped('AT_MOST', [['0', '101']]))).toEqual(['items[0].scale.steps[0].score']);
    expect(paths(updateScale(stepped('AT_MOST', [['0', '100']]), 0, { otherwise: '-1' }))).toEqual(['items[0].scale.otherwise']);
  });
});

describe('the conversion curve says what the platform says', () => {
  const linear = (worst: string, best: string): ScaleForm => ({ ...blankItem().scale, worst, best });

  it('converts exactly as the kernel does, in both directions of a linear scale and in both modes of a stepped one', () => {
    const scales: Array<[ScaleForm, Parameters<typeof convertScore>[1]]> = [
      [linear('10', '0'), { kind: 'LINEAR', worst: 10, best: 0 }],
      [linear('50', '100'), { kind: 'LINEAR', worst: 50, best: 100 }],
      [{ ...blankItem().scale, kind: 'STEPPED', mode: 'AT_MOST', steps: [{ bound: '0', score: '100' }, { bound: '5', score: '80' }], otherwise: '0' }, { kind: 'STEPPED', mode: 'AT_MOST', steps: [{ bound: 0, score: 100 }, { bound: 5, score: 80 }], otherwiseScore: 0 }],
      [{ ...blankItem().scale, kind: 'STEPPED', mode: 'AT_LEAST', steps: [{ bound: '90', score: '100' }, { bound: '70', score: '60' }], otherwise: '10' }, { kind: 'STEPPED', mode: 'AT_LEAST', steps: [{ bound: 90, score: 100 }, { bound: 70, score: 60 }], otherwiseScore: 10 }],
    ];
    for (const [form, kernel] of scales) {
      for (let value = -20; value <= 120; value += 3.5) expect(convert(value, form)).toBe(convertScore(value, kernel));
    }
  });

  it('gives no number for a scale that cannot be read yet', () => {
    expect(convert(1, linear('', ''))).toBeUndefined();
    expect(convert(1, linear('3', '3'))).toBeUndefined();
    expect(convert(Number.NaN, linear('0', '1'))).toBeUndefined();
    expect(convert(1, { ...blankItem().scale, kind: 'STEPPED', steps: [{ bound: '', score: '1' }] })).toBeUndefined();
    expect(curveOf(linear('', ''))).toEqual([]);
  });

  it('samples the curve a little beyond the ends of the scale, from 0 to 100', () => {
    const points = curveOf(linear('10', '0'), 5);
    expect(points).toHaveLength(5);
    expect(points[0]).toEqual({ value: -2, score: 100 });
    expect(points[4]).toEqual({ value: 12, score: 0 });
    expect(Math.min(...points.map((point) => point.score))).toBe(0);
    expect(Math.max(...points.map((point) => point.score))).toBe(100);
  });
});

describe('the catalogue of operations', () => {
  it('names the unit, the direction and the parameters of an operation the author picked', () => {
    const operations = kpiOperations().items as never;
    expect(operationOf(operations, 'DAYS_DEVIATION')?.unit).toBe('DAYS');
    expect(operationOf(operations, 'NOPE')).toBeUndefined();
    expect(paramNames(operationOf(operations, 'ON_TIME_RATE'))).toEqual(['grace_days']);
    expect(paramNames(undefined, ['unit'])).toEqual(['unit']);
  });
});
