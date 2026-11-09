import { describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import { originLabel, levelLabel } from './labels';
import { ALL_ORIGINS, ENTERPRISE_ORIGINS, ORIGINS, groupByOrigin, sortLines, toAppropriation } from './model';
import { line } from './test-support';

/** The origins of the enterprise pack in the register of CAP (ENT-3e, CN.01): shown when the server returns them, never offered by the public form. */
describe('the enterprise origins in the appropriation book', () => {
  const group = toAppropriation(line(1, { origin: 'GROUP_ASSIGNED', budget_level: 'ALL', decision_kind: 'GROUP_RESOLUTION' }));
  const company = toAppropriation(line(2, { origin: 'BOARD_APPROVED', budget_level: 'ALL', decision_kind: 'COMPANY_DECISION' }));
  const pm = toAppropriation(line(3));

  it('reads a line of the enterprise pack, with its origin and its single level', () => {
    expect(group).toMatchObject({ origin: 'GROUP_ASSIGNED', budgetLevel: 'ALL' });
    expect(company).toMatchObject({ origin: 'BOARD_APPROVED', budgetLevel: 'ALL' });
  });

  it('still refuses an origin or a level nobody lists', () => {
    expect(toAppropriation(line(4, { origin: 'SOMEBODY' }))).toBeUndefined();
    expect(toAppropriation(line(5, { budget_level: 'REGIONAL' }))).toBeUndefined();
  });

  it('the public form and filters keep their five origins; the enterprise ones are a separate list', () => {
    expect(ORIGINS).toEqual(['PM_ASSIGNED', 'LOCAL_ADDED', 'CARRYOVER', 'CENTRAL_SUPPORT', 'REVENUE_INCREASE']);
    expect(ENTERPRISE_ORIGINS).toEqual(['GROUP_ASSIGNED', 'BOARD_APPROVED']);
    expect(ALL_ORIGINS).toHaveLength(7);
  });

  it('names the origins and the level in the words of the language', () => {
    expect(originLabel(t, 'GROUP_ASSIGNED')).toBe(t('cap.origin.groupAssigned.label'));
    expect(originLabel(t, 'BOARD_APPROVED')).toBe(t('cap.origin.boardApproved.label'));
    expect(levelLabel(t, 'ALL')).toBe(t('cap.level.all.label'));
    expect(levelLabel(t, 'CENTRAL')).toBe(t('cap.level.central.label'));
  });

  it('keeps the origins apart in the groups and in the order of the register: the group, then the company', () => {
    const all = [company, group, pm].flatMap((one) => (one === undefined ? [] : [one]));
    expect(sortLines(all).map((one) => one.origin)).toEqual(['PM_ASSIGNED', 'GROUP_ASSIGNED', 'BOARD_APPROVED']);
    expect(groupByOrigin(all).map((one) => one.origin)).toEqual(['PM_ASSIGNED', 'GROUP_ASSIGNED', 'BOARD_APPROVED']);
  });
});
