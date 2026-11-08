import type { Translator } from '../../../i18n';
import type { ClockStatus, FieldProblem, PostingGroup, PostingKind, PostingRow, PostingState, Problem } from './posting-model';
import { timeLeft } from './posting-model';

type T = Translator['t'];

export function kindLabel(t: T, kind: PostingKind): string {
  switch (kind) {
    case 'PLAN':
      return t('egp.posting.kind.plan');
    case 'NOTICE':
      return t('egp.posting.kind.notice');
    case 'RESULT':
      return t('egp.posting.kind.result');
    case 'CONTRACT_INFO':
      return t('egp.posting.kind.contractInfo');
    case 'CONTRACTOR_PERFORMANCE':
      return t('egp.posting.kind.contractorPerformance');
    case 'VIOLATION':
      return t('egp.posting.kind.violation');
    case 'REPUTATION_EVENT':
      return t('egp.posting.kind.reputationEvent');
    case 'CONTRACTOR_RESPONSE':
      return t('egp.posting.kind.contractorResponse');
  }
}

/** What the subject code of a kind is, so that a person knows what to type when they open a duty by hand. */
export function subjectHint(t: T, kind: PostingKind): string {
  switch (kind) {
    case 'PLAN':
      return t('egp.posting.open.subject.plan');
    case 'NOTICE':
    case 'RESULT':
      return t('egp.posting.open.subject.package');
    case 'CONTRACT_INFO':
    case 'CONTRACTOR_PERFORMANCE':
      return t('egp.posting.open.subject.contract');
    case 'VIOLATION':
    case 'REPUTATION_EVENT':
    case 'CONTRACTOR_RESPONSE':
      return t('egp.posting.open.subject.contractor');
  }
}

export function stateLabel(t: T, state: PostingState): string {
  switch (state) {
    case 'DUE':
      return t('egp.posting.state.due');
    case 'PREPARED':
      return t('egp.posting.state.prepared');
    case 'SUBMITTED':
      return t('egp.posting.state.submitted');
    case 'RECEIPTED':
      return t('egp.posting.state.receipted');
    case 'REJECTED':
      return t('egp.posting.state.rejected');
    case 'CANCELLED':
      return t('egp.posting.state.cancelled');
  }
}

export function groupLabel(t: T, group: PostingGroup): string {
  switch (group) {
    case 'OPEN':
      return t('egp.posting.group.open');
    case 'SUBMITTED':
      return t('egp.posting.group.submitted');
    case 'CLOSED':
      return t('egp.posting.group.closed');
  }
}

export function clockLabel(t: T, status: ClockStatus): string {
  switch (status) {
    case 'ON_TIME':
      return t('egp.posting.clock.onTime');
    case 'DUE_SOON':
      return t('egp.posting.clock.dueSoon');
    case 'OVERDUE':
      return t('egp.posting.clock.overdue');
    case 'MET':
      return t('egp.posting.clock.met');
    case 'MET_LATE':
      return t('egp.posting.clock.metLate');
    case 'CANCELLED':
      return t('egp.posting.clock.cancelled');
  }
}

/** The time left to the deadline or past it, in words; nothing for a duty that no longer runs. */
export function leftText(t: T, row: Pick<PostingRow, 'clock' | 'msToDue'>): string | null {
  if (row.msToDue === null) return null;
  const left = timeLeft(row.msToDue);
  const late = row.msToDue < 0;
  switch (left.unit) {
    case 'days':
      return late ? t('egp.posting.left.daysLate', { value: left.value }) : t('egp.posting.left.days', { value: left.value });
    case 'hours':
      return late ? t('egp.posting.left.hoursLate', { value: left.value }) : t('egp.posting.left.hours', { value: left.value });
    case 'minutes':
      return late ? t('egp.posting.left.minutesLate', { value: left.value }) : t('egp.posting.left.minutes', { value: left.value });
  }
}

/** The name of a field of a packet; a field this screen does not know is shown as the server wrote it. */
export function fieldLabel(t: T, name: string): string {
  switch (name) {
    case 'plan_name':
      return t('egp.posting.field.planName');
    case 'decision_no':
      return t('egp.posting.field.decisionNo');
    case 'approved_on':
      return t('egp.posting.field.approvedOn');
    case 'package_code':
      return t('egp.posting.field.packageCode');
    case 'published_at':
      return t('egp.posting.field.publishedAt');
    case 'bid_closing_at':
      return t('egp.posting.field.bidClosingAt');
    case 'result_kind':
      return t('egp.posting.field.resultKind');
    case 'contract_no':
      return t('egp.posting.field.contractNo');
    case 'signed_on':
      return t('egp.posting.field.signedOn');
    case 'contractor_tax_code':
      return t('egp.posting.field.contractorTaxCode');
    case 'contract_price':
      return t('egp.posting.field.contractPrice');
    case 'completed_on':
      return t('egp.posting.field.completedOn');
    case 'schedule_rating':
      return t('egp.posting.field.scheduleRating');
    case 'quality_rating':
      return t('egp.posting.field.qualityRating');
    case 'behaviour_code':
      return t('egp.posting.field.behaviourCode');
    case 'occurred_on':
      return t('egp.posting.field.occurredOn');
    case 'evidence_ref':
      return t('egp.posting.field.evidenceRef');
    case 'response_received_on':
      return t('egp.posting.field.responseReceivedOn');
    case 'outcome':
      return t('egp.posting.field.outcome');
    default:
      return name;
  }
}

export function invalidText(t: T, problem: FieldProblem, min?: number): string {
  switch (problem) {
    case 'required':
      return t('egp.posting.invalid.required');
    case 'tooShort':
      return t('egp.posting.invalid.tooShort', { min: min ?? 0 });
    case 'tooLong':
      return t('egp.posting.invalid.tooLong');
    case 'control':
      return t('egp.posting.invalid.control');
    case 'day':
      return t('egp.posting.invalid.day');
    case 'future':
      return t('egp.posting.invalid.future');
    case 'time':
      return t('egp.posting.invalid.time');
  }
}

/** What a refusal of the server says to a person, in place. */
export function problemText(t: T, problem: Problem): string {
  switch (problem.kind) {
    case 'selfApproval':
      return t('egp.posting.problem.selfApproval');
    case 'versionConflict':
      return t('egp.posting.problem.versionConflict');
    case 'stateInvalid':
      return t('egp.posting.problem.stateInvalid');
    case 'receiptDuplicate':
      return t('egp.posting.problem.receiptDuplicate');
    case 'validation':
      return t('egp.posting.problem.validation');
    case 'calendar':
      return t('egp.posting.problem.calendar');
    case 'forbidden':
      return t('egp.posting.problem.forbidden');
    case 'notFound':
      return t('egp.posting.problem.notFound');
    case 'general':
      return t('egp.posting.problem.general');
  }
}
