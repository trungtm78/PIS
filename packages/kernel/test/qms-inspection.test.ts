import type { DomainError } from '../src/errors';
import { INSPECTION_COMMANDS, INSPECTION_STATUSES, assertChecklist, assertInspectionTransition, checklistFor, requiredRolesFor } from '../src/qms-inspection';
import type { RegimeRule } from '../src/qms-inspection';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const REGIME: RegimeRule = {
  requiredRoles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER'],
  completionRequiredRoles: ['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER'],
  checklists: {
    CONCEALED_WORK: [
      { code: 'REBAR', label: 'Rebar placed to drawing' },
      { code: 'COVER', label: 'Concrete cover' },
    ],
  },
};
const TEMPLATE = checklistFor(REGIME, 'CONCEALED_WORK');

describe('the inspections of work (ST-QMS-004)', () => {
  it('moves along the edges of the life of an inspection and nowhere else', () => {
    expect(assertInspectionTransition('schedule', 'REQUESTED')).toBe('SCHEDULED');
    expect(assertInspectionTransition('record', 'SCHEDULED')).toBe('RESULT_RECORDED');
    expect(assertInspectionTransition('cancel', 'REQUESTED')).toBe('CANCELLED');
    expect(assertInspectionTransition('cancel', 'SCHEDULED')).toBe('CANCELLED');
    for (const command of INSPECTION_COMMANDS) {
      expect(INSPECTION_STATUSES.filter((status) => !refusalOf(command, status))).toEqual(command === 'cancel' ? ['REQUESTED', 'SCHEDULED'] : command === 'schedule' ? ['REQUESTED'] : ['SCHEDULED']);
    }
    expect(refusal(() => assertInspectionTransition('record', 'REQUESTED'))).toMatchObject({ code: 'INSPECTION_STATE_INVALID', status: 409, extensions: { inspection_status: 'REQUESTED' } });
    expect(refusal(() => assertInspectionTransition('cancel', 'RESULT_RECORDED'))).toMatchObject({ code: 'INSPECTION_STATE_INVALID' });
  });

  it('takes the roles to sign and the checklist from the regime: the completion has its own roles, a type with no checklist has none', () => {
    expect(requiredRolesFor(REGIME, 'CONCEALED_WORK')).toEqual(['CONTRACTOR', 'SUPERVISOR', 'OWNER']);
    expect(requiredRolesFor(REGIME, 'COMPLETION')).toEqual(['CONTRACTOR', 'SUPERVISOR', 'OWNER', 'DESIGNER']);
    expect(checklistFor(REGIME, 'SAFETY')).toEqual([]);
    expect(TEMPLATE).toEqual([
      { code: 'REBAR', label: 'Rebar placed to drawing' },
      { code: 'COVER', label: 'Concrete cover' },
    ]);
    // A copy: changing it does not change the rule.
    TEMPLATE[0]!.label = 'changed';
    expect(checklistFor(REGIME, 'CONCEALED_WORK')[0]?.label).toBe('Rebar placed to drawing');
    TEMPLATE[0]!.label = 'Rebar placed to drawing';
  });

  it('AC-ST-QMS-004-3, UAT-AC360: accepts a checklist that answers every item, and gives the answers in the order of the template with their labels', () => {
    expect(
      assertChecklist(TEMPLATE, [{ code: 'COVER', outcome: 'NA' }, { code: 'REBAR', outcome: 'PASS', note: ' ok ' }], 'PASS'),
    ).toEqual([
      { code: 'REBAR', label: 'Rebar placed to drawing', outcome: 'PASS', note: 'ok' },
      { code: 'COVER', label: 'Concrete cover', outcome: 'NA' },
    ]);
    expect(assertChecklist([], [], 'PASS')).toEqual([]);
  });

  it('refuses a checklist that leaves an item out, answers one that is not there, answers one twice or answers badly', () => {
    expect(refusal(() => assertChecklist(TEMPLATE, [{ code: 'REBAR', outcome: 'PASS' }], 'PASS'))).toMatchObject({ code: 'CHECKLIST_INCOMPLETE', status: 422, extensions: { reason: 'ITEMS_MISSING', codes: ['COVER'] } });
    expect(refusal(() => assertChecklist(TEMPLATE, [{ code: 'REBAR', outcome: 'PASS' }, { code: 'COVER', outcome: 'PASS' }, { code: 'X', outcome: 'PASS' }], 'PASS'))).toMatchObject({ extensions: { reason: 'ANSWER_UNKNOWN', codes: ['X'] } });
    expect(refusal(() => assertChecklist(TEMPLATE, [{ code: 'REBAR', outcome: 'PASS' }, { code: 'REBAR', outcome: 'PASS' }], 'PASS'))).toMatchObject({ extensions: { reason: 'ANSWER_DUPLICATED', code: 'REBAR' } });
    for (const bad of [{ code: 'REBAR', outcome: 'MAYBE' }, { outcome: 'PASS' }, 'x', null, { code: 'REBAR', outcome: 'PASS', note: 'x'.repeat(2001) }]) {
      expect(refusal(() => assertChecklist(TEMPLATE, [bad], 'PASS'))).toMatchObject({ extensions: { reason: 'ANSWER_INVALID' } });
    }
  });

  it('keeps the result and the answers from contradicting each other: a PASS has no failed item, a FAIL has one, a CONDITIONAL says its condition', () => {
    const failed = [{ code: 'REBAR', outcome: 'FAIL' }, { code: 'COVER', outcome: 'PASS' }];
    expect(refusal(() => assertChecklist(TEMPLATE, failed, 'PASS'))).toMatchObject({ extensions: { reason: 'RESULT_CONTRADICTS', codes: ['REBAR'] } });
    expect(refusal(() => assertChecklist(TEMPLATE, [{ code: 'REBAR', outcome: 'PASS' }, { code: 'COVER', outcome: 'PASS' }], 'FAIL'))).toMatchObject({ extensions: { reason: 'RESULT_CONTRADICTS' } });
    expect(assertChecklist(TEMPLATE, failed, 'FAIL')[0]).toMatchObject({ outcome: 'FAIL' });
    expect(refusal(() => assertChecklist(TEMPLATE, failed, 'CONDITIONAL'))).toMatchObject({ extensions: { reason: 'CONDITION_UNSTATED', codes: ['REBAR'] } });
    expect(assertChecklist(TEMPLATE, [{ code: 'REBAR', outcome: 'FAIL', note: 'Re-tie the rebar before the pour' }, { code: 'COVER', outcome: 'PASS' }], 'CONDITIONAL')[0]).toMatchObject({ note: 'Re-tie the rebar before the pour' });
  });
});

function refusalOf(command: Parameters<typeof assertInspectionTransition>[0], status: Parameters<typeof assertInspectionTransition>[1]): boolean {
  try {
    assertInspectionTransition(command, status);
    return false;
  } catch {
    return true;
  }
}
