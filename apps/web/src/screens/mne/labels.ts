import type { Translator } from '../../i18n';
import type { FieldProblem, GenerationProblem, Phase, ProblemView } from './model';
import type { FormStatus, ReportKind, ReportStatus, ReportingRole } from './types';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function reportKindLabel(t: T, kind: ReportKind): string {
  switch (kind) {
    case 'OVERALL_SEMIANNUAL':
      return t('mne.forms.kind.overallSemiannual');
    case 'OVERALL_ANNUAL':
      return t('mne.forms.kind.overallAnnual');
    case 'PROJECT_START':
      return t('mne.forms.kind.projectStart');
    case 'PROJECT_ADJUST':
      return t('mne.forms.kind.projectAdjust');
    case 'PROJECT_COMPLETION':
      return t('mne.forms.kind.projectCompletion');
    case 'PROJECT_PERIODIC':
      return t('mne.forms.kind.projectPeriodic');
    case 'EVALUATION':
      return t('mne.forms.kind.evaluation');
    case 'WEEKLY_QUICK':
      return t('mne.forms.kind.weeklyQuick');
  }
}

export function formStatusLabel(t: T, status: FormStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('mne.forms.state.draft');
    case 'PUBLISHED':
      return t('mne.forms.state.published');
    case 'RETIRED':
      return t('mne.forms.state.retired');
  }
}

export function phaseLabel(t: T, phase: Phase): string {
  switch (phase) {
    case 'draft':
      return t('mne.forms.phase.draft');
    case 'scheduled':
      return t('mne.forms.phase.scheduled');
    case 'inForce':
      return t('mne.forms.phase.inForce');
    case 'ended':
      return t('mne.forms.phase.ended');
  }
}

export function roleLabel(t: T, role: ReportingRole): string {
  switch (role) {
    case 'INVESTOR':
      return t('mne.calendar.role.investor');
    case 'PROJECT_OWNER_AGENCY':
      return t('mne.calendar.role.projectOwnerAgency');
    case 'PROVINCIAL_PEOPLE_COMMITTEE':
      return t('mne.calendar.role.provincialPeopleCommittee');
    case 'PLANNING_AGENCY':
      return t('mne.calendar.role.planningAgency');
  }
}

export function reportStatusLabel(t: T, status: ReportStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('mne.calendar.status.draft');
    case 'IN_REVIEW':
      return t('mne.calendar.status.inReview');
    case 'APPROVED':
      return t('mne.calendar.status.approved');
    case 'ISSUING':
      return t('mne.calendar.status.issuing');
    case 'ISSUED':
      return t('mne.calendar.status.issued');
    case 'EXPORTED':
      return t('mne.calendar.status.exported');
    case 'SUBMITTED_EXTERNAL':
      return t('mne.calendar.status.submittedExternal');
    case 'RETURNED':
      return t('mne.calendar.status.returned');
    case 'SUPERSEDED':
      return t('mne.calendar.status.superseded');
  }
}

export function fieldProblemMessage(t: T, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('mne.forms.field.required');
    case 'tooShort':
      return t('mne.forms.field.tooShort');
    case 'tooLong':
      return t('mne.forms.field.tooLong');
    case 'format':
      return t('mne.forms.field.format');
    case 'date':
      return t('mne.forms.field.date');
    case 'order':
      return t('mne.forms.field.order');
    case 'json':
      return t('mne.forms.field.json');
    case 'formats':
      return t('mne.forms.field.formats');
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'conflict':
      return t('mne.forms.problem.conflict.text');
    case 'selfApproval':
      return t('mne.forms.problem.selfApproval.text');
    case 'stateInvalid':
      return t('mne.forms.problem.stateInvalid.text');
    case 'rangeOverlap':
      return t('mne.forms.problem.rangeOverlap.text');
    case 'templateMissing':
      return t('mne.forms.problem.templateMissing.text');
    case 'invalid':
      return t('mne.forms.problem.invalid.text');
    case 'notFound':
      return t('mne.forms.problem.notFound.text');
    case 'denied':
      return t('mne.forms.problem.denied.text');
    case 'session':
      return t('mne.forms.problem.session.text');
    case 'general':
      return t('mne.forms.problem.general.text');
  }
}

export function generationMessage(t: T, problem: GenerationProblem): string {
  switch (problem) {
    case 'noRule':
      return t('mne.calendar.problem.noRule.text');
    case 'formNotEffective':
      return t('mne.calendar.problem.formNotEffective.text');
    case 'calendar':
      return t('mne.calendar.problem.calendar.text');
    case 'scopeDenied':
      return t('mne.calendar.problem.scopeDenied.text');
    case 'invalid':
      return t('mne.calendar.problem.invalid.text');
    case 'session':
      return t('mne.calendar.problem.session.text');
    case 'general':
      return t('mne.calendar.problem.general.text');
  }
}
