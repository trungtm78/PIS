import type { useTranslation } from '../../i18n';
import type { AccountabilityProblem, AccountabilityRole, AssignmentStatus, FormProblem, MemberRole, TaskForceStatus } from './accountability-model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function roleLabel(t: Translate, role: AccountabilityRole): string {
  switch (role) {
    case 'LEADER_IN_CHARGE':
      return t('prj.accountability.role.leader.label');
    case 'DEPUTY_LEADER':
      return t('prj.accountability.role.deputy.label');
    case 'FOCAL_OFFICER':
      return t('prj.accountability.role.focal.label');
  }
}

export function assignmentStatusLabel(t: Translate, status: AssignmentStatus): string {
  return status === 'ACTIVE' ? t('prj.accountability.status.active.label') : t('prj.accountability.status.ended.label');
}

export function memberRoleLabel(t: Translate, role: MemberRole): string {
  switch (role) {
    case 'LEAD':
      return t('prj.taskforce.memberRole.lead.label');
    case 'MEMBER':
      return t('prj.taskforce.memberRole.member.label');
    case 'SECRETARY':
      return t('prj.taskforce.memberRole.secretary.label');
  }
}

export function taskForceStatusLabel(t: Translate, status: TaskForceStatus): string {
  return status === 'ACTIVE' ? t('prj.taskforce.status.active.label') : t('prj.taskforce.status.dissolved.label');
}

/** The sentence for a field that is wrong before anything is sent. */
export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('prj.accountability.field.required.error');
    case 'invalidId':
      return t('prj.accountability.field.invalidId.error');
    case 'invalidDate':
      return t('prj.accountability.field.invalidDate.error');
    case 'future':
      return t('prj.accountability.field.future.error');
    case 'beforeStart':
      return t('prj.accountability.field.beforeStart.error');
    case 'tooShort':
      return t('prj.accountability.field.tooShort.error');
    case 'tooLong':
      return t('prj.accountability.field.tooLong.error');
    case 'invalidText':
      return t('prj.accountability.field.invalidText.error');
    case 'invalidRole':
      return t('prj.accountability.field.invalidRole.error');
  }
}

/** The sentence for a refusal of the server; a problem the screen has no sentence for is the general one. */
export function problemMessage(t: Translate, problem: AccountabilityProblem): string {
  switch (problem) {
    case 'leaderTaken':
      return t('prj.accountability.problem.leaderTaken.error');
    case 'leaderNotEligible':
      return t('prj.accountability.problem.leaderNotEligible.error');
    case 'alreadyEnded':
      return t('prj.accountability.problem.alreadyEnded.error');
    case 'codeTaken':
      return t('prj.accountability.problem.codeTaken.error');
    case 'outOfScope':
      return t('prj.accountability.problem.outOfScope.error');
    case 'dissolved':
      return t('prj.accountability.problem.dissolved.error');
    case 'memberTaken':
      return t('prj.accountability.problem.memberTaken.error');
    case 'documentInvalid':
      return t('prj.accountability.problem.documentInvalid.error');
    case 'versionConflict':
      return t('prj.accountability.problem.versionConflict.error');
    case 'validation':
      return t('prj.accountability.problem.validation.error');
    case 'notFound':
      return t('prj.accountability.problem.notFound.error');
    case 'denied':
      return t('prj.accountability.problem.denied.error');
    case 'general':
      return t('prj.accountability.problem.general.error');
  }
}
