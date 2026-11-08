import type { Translator } from '../../../i18n';
import type { DifferenceKind, FieldProblem, ItemState, Problem, ProblemKind, ReconcileSubject, ResolutionKind } from './reconcile-model';
import { dongText, instantDay } from './mapping-model';
import { DAY_FIELDS, MIN_REASON, MONEY_FIELDS } from './reconcile-model';

type T = Translator['t'];

/** Every key is written out in its `t(...)` call so that the i18n check sees it in use. */
export function subjectLabel(t: T, subject: ReconcileSubject): string {
  switch (subject) {
    case 'PLAN':
      return t('egp.reconcile.subject.plan');
    case 'PACKAGE':
      return t('egp.reconcile.subject.package');
    case 'NOTICE':
      return t('egp.reconcile.subject.notice');
    case 'RESULT':
      return t('egp.reconcile.subject.result');
    case 'CONTRACTOR':
      return t('egp.reconcile.subject.contractor');
  }
}

export function stateLabel(t: T, state: ItemState): string {
  switch (state) {
    case 'OPEN':
      return t('egp.reconcile.state.open');
    case 'RESOLVED':
      return t('egp.reconcile.state.resolved');
  }
}

/** The name of a compared field; a field this screen does not know is shown as the server wrote it. */
export function fieldLabel(t: T, field: string): string {
  switch (field) {
    case 'package_name':
      return t('egp.reconcile.field.packageName');
    case 'estimated_price':
      return t('egp.reconcile.field.estimatedPrice');
    case 'selection_method':
      return t('egp.reconcile.field.selectionMethod');
    case 'approved_on':
      return t('egp.reconcile.field.approvedOn');
    case 'published_at':
      return t('egp.reconcile.field.publishedAt');
    case 'bid_closing_at':
      return t('egp.reconcile.field.bidClosingAt');
    case 'bid_opening_at':
      return t('egp.reconcile.field.bidOpeningAt');
    case 'result_kind':
      return t('egp.reconcile.field.resultKind');
    case 'contractor_tax_code':
      return t('egp.reconcile.field.contractorTaxCode');
    case 'award_price':
      return t('egp.reconcile.field.awardPrice');
    case 'contractor_name':
      return t('egp.reconcile.field.contractorName');
    default:
      return field;
  }
}

export function differenceLabel(t: T, kind: DifferenceKind): string {
  switch (kind) {
    case 'VALUE_MISMATCH':
      return t('egp.reconcile.difference.valueMismatch');
    case 'MISSING_OURS':
      return t('egp.reconcile.difference.missingOurs');
    case 'MISSING_THEIRS':
      return t('egp.reconcile.difference.missingTheirs');
  }
}

export function resolutionLabel(t: T, kind: ResolutionKind): string {
  switch (kind) {
    case 'ACCEPT_EXTERNAL':
      return t('egp.reconcile.resolution.acceptExternal');
    case 'CORRECT_OURS':
      return t('egp.reconcile.resolution.correctOurs');
    case 'DISPUTE':
      return t('egp.reconcile.resolution.dispute');
    case 'WAIVE':
      return t('egp.reconcile.resolution.waive');
  }
}

/** One sentence on what a resolution does and does not do. */
export function resolutionEffect(t: T, kind: ResolutionKind): string {
  switch (kind) {
    case 'ACCEPT_EXTERNAL':
      return t('egp.reconcile.effect.acceptExternal');
    case 'CORRECT_OURS':
      return t('egp.reconcile.effect.correctOurs');
    case 'DISPUTE':
      return t('egp.reconcile.effect.dispute');
    case 'WAIVE':
      return t('egp.reconcile.effect.waive');
  }
}

/** What the server says comes next after a resolution (`EGP_RESOLUTION_FOLLOW_UP`); an unknown code says nothing. */
export function followUpText(t: T, followUp: string): string {
  switch (followUp) {
    case 'CHANGE_OURS_BY_OWNER_COMMAND':
      return t('egp.reconcile.followUp.changeOurs');
    case 'CHECK_POSTING_CORRECTION_DUE':
      return t('egp.reconcile.followUp.checkPosting');
    case 'ESCALATE_TO_OPERATOR':
      return t('egp.reconcile.followUp.escalate');
    case 'REVIEW_ON_DAY':
      return t('egp.reconcile.followUp.review');
    default:
      return '';
  }
}

export function invalidText(t: T, problem: FieldProblem, kind: ResolutionKind): string {
  switch (problem) {
    case 'required':
      return t('egp.reconcile.invalid.required');
    case 'tooShort':
      return t('egp.reconcile.invalid.tooShort', { min: MIN_REASON[kind] });
    case 'tooLong':
      return t('egp.reconcile.invalid.tooLong');
    case 'day':
      return t('egp.reconcile.invalid.day');
    case 'notFuture':
      return t('egp.reconcile.invalid.notFuture');
    case 'tooFar':
      return t('egp.reconcile.invalid.tooFar');
  }
}

function fieldProblemText(t: T, field: NonNullable<Problem['field']>): string {
  switch (field) {
    case 'reason':
      return t('egp.reconcile.problem.field.reason');
    case 'evidenceRef':
      return t('egp.reconcile.problem.field.evidenceRef');
    case 'reviewOn':
      return t('egp.reconcile.problem.field.reviewOn');
    case 'kind':
      return t('egp.reconcile.problem.field.kind');
    case 'subject':
      return t('egp.reconcile.problem.field.subject');
    case 'owner':
      return t('egp.reconcile.problem.field.owner');
  }
}

function kindText(t: T, kind: ProblemKind): string {
  switch (kind) {
    case 'selfApproval':
      return t('egp.reconcile.problem.self');
    case 'versionConflict':
      return t('egp.reconcile.problem.version');
    case 'stateInvalid':
      return t('egp.reconcile.problem.state');
    case 'validation':
      return t('egp.reconcile.problem.validation');
    case 'calendar':
      return t('egp.reconcile.problem.calendar');
    case 'forbidden':
      return t('egp.reconcile.problem.forbidden');
    case 'notFound':
      return t('egp.reconcile.problem.notFound');
    case 'general':
      return t('egp.reconcile.problem.general');
  }
}

/** What a refusal says: the named reason, or for a validation the field it names. */
export function problemText(t: T, problem: Problem): string {
  if (problem.kind === 'validation' && problem.field !== undefined) return fieldProblemText(t, problem.field);
  return kindText(t, problem.kind);
}

/** A value of the register or of the network as a person reads it: an amount with the thousands marked, a day as dd/mm/yyyy (Vietnam), anything else as it is; nothing is said as "none". */
export function valueText(t: T, locale: string, field: string, value: string | null): string {
  if (value === null) return t('egp.reconcile.cell.none');
  if (MONEY_FIELDS.includes(field)) return dongText(value, locale);
  if (DAY_FIELDS.includes(field)) return instantDay(value);
  return value;
}

/** The signed difference of an amount (theirs minus ours): a plus sign for what the network says is more. Only amounts have one. */
export function deltaText(locale: string, field: string, delta: string | null): string | null {
  if (delta === null || !MONEY_FIELDS.includes(field)) return delta;
  const grouped = dongText(delta.startsWith('-') ? delta.slice(1) : delta, locale);
  if (delta.startsWith('-')) return `-${grouped}`;
  return delta === '0' ? grouped : `+${grouped}`;
}
