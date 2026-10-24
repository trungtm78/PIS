import { describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { assignmentStatusLabel, formProblemMessage, memberRoleLabel, problemMessage, roleLabel, taskForceStatusLabel } from './accountability-labels';
import type { AccountabilityProblem, FormProblem } from './accountability-model';

/** A translator that answers the text of the Vietnamese bundle for a key, so that a key that is not there shows as itself. */
const t = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;

describe('the labels of PRJ-17 and PRJ-18', () => {
  it('names the three roles, the two states of an assignment, the three roles of a member and the two states of a force with a text of the bundle', () => {
    expect(['LEADER_IN_CHARGE', 'DEPUTY_LEADER', 'FOCAL_OFFICER'].map((role) => roleLabel(t, role as never))).toEqual([
      vi_['prj.accountability.role.leader.label'],
      vi_['prj.accountability.role.deputy.label'],
      vi_['prj.accountability.role.focal.label'],
    ]);
    expect([assignmentStatusLabel(t, 'ACTIVE'), assignmentStatusLabel(t, 'ENDED')]).toEqual([vi_['prj.accountability.status.active.label'], vi_['prj.accountability.status.ended.label']]);
    expect((['LEAD', 'MEMBER', 'SECRETARY'] as const).map((role) => memberRoleLabel(t, role))).toEqual([
      vi_['prj.taskforce.memberRole.lead.label'],
      vi_['prj.taskforce.memberRole.member.label'],
      vi_['prj.taskforce.memberRole.secretary.label'],
    ]);
    expect([taskForceStatusLabel(t, 'ACTIVE'), taskForceStatusLabel(t, 'DISSOLVED')]).toEqual([vi_['prj.taskforce.status.active.label'], vi_['prj.taskforce.status.dissolved.label']]);
  });

  it('has a sentence of the bundle for every problem of a field and every refusal of the server', () => {
    const fields: FormProblem[] = ['required', 'invalidId', 'invalidDate', 'future', 'beforeStart', 'tooShort', 'tooLong', 'invalidText', 'invalidRole'];
    const refusals: AccountabilityProblem[] = [
      'leaderTaken',
      'leaderNotEligible',
      'alreadyEnded',
      'codeTaken',
      'outOfScope',
      'dissolved',
      'memberTaken',
      'documentInvalid',
      'versionConflict',
      'validation',
      'notFound',
      'denied',
      'general',
    ];
    const sentences = [...fields.map((problem) => formProblemMessage(t, problem)), ...refusals.map((problem) => problemMessage(t, problem))];
    expect(sentences).toHaveLength(22);
    expect(new Set(sentences).size).toBe(22);
    for (const sentence of sentences) expect(sentence).not.toMatch(/^prj\./);
  });
});
