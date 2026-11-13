import type { useTranslation } from '../../../i18n';
import type { ChoiceProblem, LegalBasis, LegalState, SelectionMode, StepStatus, SuggestionBasis } from './model';

type T = ReturnType<typeof useTranslation>['t'];

export function stepStatusWord(t: T, status: StepStatus): string {
  switch (status) {
    case 'DONE':
      return t('pwf.process.step.done.word');
    case 'IN_PROGRESS':
      return t('pwf.process.step.inProgress.word');
    case 'NOT_STARTED':
      return t('pwf.process.step.notStarted.word');
    case 'NOT_APPLICABLE':
      return t('pwf.process.step.notApplicable.word');
  }
}

export function legalStateWord(t: T, state: LegalState): string {
  switch (state) {
    case 'IN_FORCE':
      return t('pwf.process.legal.inForce.word');
    case 'NOT_YET_IN_FORCE':
      return t('pwf.process.legal.notYet.word');
    case 'EXPIRED':
      return t('pwf.process.legal.expired.word');
    case 'SUPERSEDED':
      return t('pwf.process.legal.superseded.word');
    case 'UNKNOWN':
      return t('pwf.process.legal.unknown.word');
  }
}

export function docKindWord(t: T, kind: LegalBasis['doc_kind']): string {
  switch (kind) {
    case 'LAW':
      return t('pwf.process.docKind.law.word');
    case 'RESOLUTION':
      return t('pwf.process.docKind.resolution.word');
    case 'DECREE':
      return t('pwf.process.docKind.decree.word');
    case 'DECISION':
      return t('pwf.process.docKind.decision.word');
    case 'CIRCULAR':
      return t('pwf.process.docKind.circular.word');
    case 'DIRECTIVE':
      return t('pwf.process.docKind.directive.word');
    case 'OTHER':
    case null:
      return t('pwf.process.docKind.other.word');
  }
}

/** Why a template is the one suggested: the line of the rule, the type of the project, the default of the rule, or nothing to suggest. */
export function basisText(t: T, basis: SuggestionBasis, line: string | null): string {
  switch (basis) {
    case 'RULE':
      return t('pwf.process.basis.rule.text', { line: line ?? '' });
    case 'PROJECT_TYPE':
      return t('pwf.process.basis.projectType.text');
    case 'DEFAULT':
      return t('pwf.process.basis.default.text');
    case 'NONE':
      return t('pwf.process.basis.none.text');
  }
}

export function selectionModeWord(t: T, mode: SelectionMode): string {
  switch (mode) {
    case 'AUTO':
      return t('pwf.process.mode.auto.word');
    case 'CONFIRMED':
      return t('pwf.process.mode.confirmed.word');
    case 'OVERRIDE':
      return t('pwf.process.mode.override.word');
    case 'MANUAL':
      return t('pwf.process.mode.manual.word');
  }
}

export function choiceProblemText(t: T, problem: ChoiceProblem, facts = ''): string {
  switch (problem) {
    case 'suggestionUnavailable':
      return t('pwf.process.problem.suggestionUnavailable.text');
    case 'startRequired':
      return t('pwf.process.problem.startRequired.text');
    case 'startInvalid':
      return t('pwf.process.problem.startInvalid.text');
    case 'templateRequired':
      return t('pwf.process.problem.templateRequired.text');
    case 'reasonRequired':
      return t('pwf.process.problem.reasonRequired.text');
    case 'reasonTooLong':
      return t('pwf.process.problem.reasonTooLong.text');
    case 'factsRequired':
      return t('pwf.process.problem.factsRequired.text', { facts });
    case 'calendarMissing':
      return t('pwf.process.problem.calendarMissing.text');
  }
}

export function factWord(t: T, field: string): string {
  switch (field) {
    case 'project_group':
      return t('pwf.process.fact.group.label');
    case 'funding_source':
      return t('pwf.process.fact.funding.label');
    default:
      return t('pwf.process.fact.type.label');
  }
}

export function groupWord(t: T, group: string): string {
  switch (group) {
    case 'QTQG':
      return t('pwf.process.group.national.word');
    case 'A':
      return t('pwf.process.group.a.word');
    case 'B':
      return t('pwf.process.group.b.word');
    case 'C':
      return t('pwf.process.group.c.word');
    default:
      return group;
  }
}

export function fundingWord(t: T, source: string): string {
  switch (source) {
    case 'STATE_BUDGET':
      return t('pwf.process.funding.budget.word');
    case 'ODA':
      return t('pwf.process.funding.oda.word');
    case 'FOREIGN_LOAN':
      return t('pwf.process.funding.foreignLoan.word');
    case 'OTHER':
      return t('pwf.process.funding.other.word');
    default:
      return source;
  }
}
