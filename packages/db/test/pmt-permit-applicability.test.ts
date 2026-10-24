import { checkApplicability } from '../src/pmt-permit-applicability';

const refusal = (rule: unknown): { code: string; status: number; detail: string | undefined } | undefined => {
  try {
    checkApplicability(rule);
  } catch (error) {
    const { code, status, detail } = error as { code: string; status: number; detail?: string };
    return { code, status, detail };
  }
  return undefined;
};

describe('the applicability condition of a permit type (PMT 6, applies_to_rule)', () => {
  it('accepts the empty condition, which applies to every project', () => {
    expect(checkApplicability({})).toEqual({});
  });

  it('stores the lists sorted and without repeats, and keeps the amounts as digits', () => {
    expect(
      checkApplicability({
        work_types: ['ROAD', 'BRIDGE', 'ROAD'],
        project_group_keys: ['B', 'A'],
        min_total_investment_vnd: '0',
        max_total_investment_vnd: '2300000000000',
      }),
    ).toEqual({ project_group_keys: ['A', 'B'], work_types: ['BRIDGE', 'ROAD'], min_total_investment_vnd: '0', max_total_investment_vnd: '2300000000000' });
  });

  it('accepts equal bounds', () => {
    expect(checkApplicability({ min_total_investment_vnd: '500', max_total_investment_vnd: '500' })).toEqual({ min_total_investment_vnd: '500', max_total_investment_vnd: '500' });
  });

  it.each([
    ['a text instead of an object', 'ALL'],
    ['null', null],
    ['an array', []],
    ['a key nobody reads', { sector: 'ROAD' }],
    ['an empty list', { work_types: [] }],
    ['a list that is not a list', { work_types: 'ROAD' }],
    ['a key that is not a code', { work_types: ['road'] }],
    ['a key that is not a text', { project_group_keys: [1] }],
    ['more than fifty keys', { work_types: Array.from({ length: 51 }, (_unused, n) => `T${n}`) }],
    ['an amount with a decimal point', { min_total_investment_vnd: '1.5' }],
    ['an amount with a leading zero', { min_total_investment_vnd: '007' }],
    ['a negative amount', { max_total_investment_vnd: '-1' }],
    ['an amount that is a number', { max_total_investment_vnd: 5 }],
    ['an amount longer than the column', { max_total_investment_vnd: '1'.repeat(25) }],
    ['a minimum above the maximum', { min_total_investment_vnd: '10', max_total_investment_vnd: '9' }],
  ])('refuses %s as a 422 naming applies_to_rule', (_name, rule) => {
    expect(refusal(rule)).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'applies_to_rule' });
  });
});
