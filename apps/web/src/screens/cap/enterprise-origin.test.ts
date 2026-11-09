import { describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import { assertAppropriationForPack, budgetLevelsOfPack, builtInPack, originsOfPack } from '@machvon/kernel/src/fnd-taxonomy.ts';
import { decisionKindLabel, originLabel, levelLabel } from './labels';
import { ALL_ORIGINS, ENTERPRISE_ORIGINS, ORIGINS, changeField, decisionKindsOf, emptyFormOf, formLevelsOf, formOfRevision, formOriginsOf, groupByOrigin, registerBody, sortLines, toAppropriation, validateForm } from './model';
import type { AppropriationForm } from './model';
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

/** The form of the enterprise edition: the pack of the edition lists other origins and one level, and binds each origin to kinds of decision document (CAP, ENT-3e). */
describe('the form of the enterprise edition', () => {
  const form = (patch: Partial<AppropriationForm> = {}): AppropriationForm => ({ ...emptyFormOf(true), fundSourceVersionId: 'v', planYear: '2026', amount: '10', decisionDocumentId: '00000000-0000-4000-8000-000000000001', issuingAuthority: 'Hội đồng thành viên', ...patch });

  it('offers the origins, the level and the kinds of the built-in enterprise pack of the kernel, no more and no less', () => {
    const pack = builtInPack('ENTERPRISE');
    expect([...formOriginsOf(true)]).toEqual([...originsOfPack(pack)]);
    expect([...formLevelsOf(true)]).toEqual(budgetLevelsOfPack(pack));
    for (const origin of formOriginsOf(true)) expect([...decisionKindsOf(origin)]).toEqual([...(pack.originDecisions.get(origin) ?? [])]);
  });

  it('opens on a line the pack accepts, and the public form keeps its own default and sends no kind', () => {
    const pack = builtInPack('ENTERPRISE');
    const open = emptyFormOf(true);
    expect(() => assertAppropriationForPack(pack, { origin: open.origin, budgetLevel: open.budgetLevel, decisionKind: open.decisionKind })).not.toThrow();
    expect(emptyFormOf(false)).toMatchObject({ origin: 'PM_ASSIGNED', budgetLevel: 'CENTRAL', decisionKind: '' });
    expect(registerBody({ ...emptyFormOf(false), fundSourceVersionId: 'v', planYear: '2026', amount: '1', decisionDocumentId: 'x', issuingAuthority: 'ab' }, 'vi-VN')).not.toHaveProperty('decision_kind');
  });

  it('sends a body that the pack of the edition accepts for every origin it lists', () => {
    const pack = builtInPack('ENTERPRISE');
    for (const origin of formOriginsOf(true)) {
      const chosen = changeField(emptyFormOf(true), 'origin', origin, true);
      const body = registerBody(form({ ...chosen, ...(origin === 'CARRYOVER' ? { sourceYear: '2025', extendedTo: '2026-12-31', extensionDocumentId: '00000000-0000-4000-8000-000000000002' } : {}) }), 'vi-VN');
      expect(() => assertAppropriationForPack(pack, { origin: body.origin, budgetLevel: body.budget_level, decisionKind: body.decision_kind })).not.toThrow();
    }
  });

  it('takes the first kind of the new origin when the kind chosen does not fit it, and keeps one that does', () => {
    expect(changeField(emptyFormOf(true), 'origin', 'BOARD_APPROVED', true)).toMatchObject({ origin: 'BOARD_APPROVED', decisionKind: 'COMPANY_RESOLUTION' });
    expect(changeField({ ...emptyFormOf(true), decisionKind: 'GROUP_DECISION' }, 'origin', 'CARRYOVER', true)).toMatchObject({ origin: 'CARRYOVER', decisionKind: 'GROUP_DECISION' });
    expect(changeField(emptyFormOf(false), 'origin', 'LOCAL_ADDED', false)).toMatchObject({ origin: 'LOCAL_ADDED', decisionKind: '' });
    expect(changeField(emptyFormOf(false), 'planYear', '2027', false).sourceYear).toBe('2027');
  });

  it('asks for a kind that fits the origin in the enterprise edition only', () => {
    expect(validateForm(form(), 'vi-VN', true)).toEqual({});
    expect(validateForm(form({ decisionKind: '' }), 'vi-VN', true).decisionKind).toBe('required');
    expect(validateForm(form({ origin: 'BOARD_APPROVED', decisionKind: 'GROUP_RESOLUTION' }), 'vi-VN', true).decisionKind).toBe('required');
    expect(validateForm({ ...form(), origin: 'PM_ASSIGNED', budgetLevel: 'CENTRAL', decisionKind: '' }, 'vi-VN')).toEqual({});
  });

  it('names the kinds in the words of the language and carries the kind of a line into its revision', () => {
    expect(decisionKindLabel(t, 'GROUP_RESOLUTION')).toBe(t('cap.decisionKind.groupResolution.label'));
    expect(decisionKindLabel(t, 'COMPANY_DECISION')).toBe(t('cap.decisionKind.companyDecision.label'));
    expect(decisionKindLabel(t, 'GROUP_DECISION')).toBe(t('cap.decisionKind.groupDecision.label'));
    expect(decisionKindLabel(t, 'COMPANY_RESOLUTION')).toBe(t('cap.decisionKind.companyResolution.label'));
    expect(decisionKindLabel(t, 'SOMETHING_ELSE')).toBe('SOMETHING_ELSE');
    const revised = toAppropriation(line(6, { origin: 'GROUP_ASSIGNED', budget_level: 'ALL', decision_kind: 'GROUP_DECISION' }));
    expect(revised?.decisionKind).toBe('GROUP_DECISION');
    expect(revised === undefined ? undefined : formOfRevision(revised, 'vi-VN')).toMatchObject({ origin: 'GROUP_ASSIGNED', budgetLevel: 'ALL', decisionKind: 'GROUP_DECISION' });
  });
});
