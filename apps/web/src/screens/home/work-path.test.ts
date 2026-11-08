import { describe, expect, it } from 'vitest';
import { pathOf } from './work-model';

const open = (screen: string) => pathOf({ target: { screen, id: 'x-1' } });

describe('where the alert targets of GOV-11a and MR-1 are opened', () => {
  it('opens the records of a project or a contract with its id', () => {
    expect(open('PRJ-28')).toBe('/prj/prj-28?id=x-1');
    expect(open('PRJ-29')).toBe('/prj/prj-29?id=x-1');
    expect(open('PRJ-30')).toBe('/prj/prj-30?id=x-1');
    expect(open('CTR-39')).toBe('/ctr/ctr-39?id=x-1');
  });

  it('opens the boards on their own page', () => {
    expect(open('CTR-38')).toBe('/ctr/ctr-38');
    expect(open('DIS-30')).toBe('/dis/dis-30');
    expect(open('PAY-22')).toBe('/pay/pay-22');
  });

  it('keeps the claim record of GOV-8 on its own screen', () => {
    expect(open('CTR-33')).toBe('/ctr/ctr-33?claim=x-1');
  });
});
