import { ApiError } from '@machvon/api-client';
import type { Translator } from '../../../i18n';
import type { TimelineEntry, TimelineGroup } from '../../../ui';
import type { BlockerDto, EntryDto, ExceptionDto, TimelineDto, WfRow, WorkflowStatus } from './model';
import { vietnamTime } from './model';

type T = Translator['t'];

export function methodLabel(t: T, code: string): string {
  switch (code) {
    case 'OPEN_BIDDING':
      return t('prc1.method.openBidding.name');
    case 'LIMITED_BIDDING':
      return t('prc1.method.limitedBidding.name');
    case 'DIRECT_APPOINTMENT':
      return t('prc1.method.directAppointment.name');
    case 'COMPETITIVE_QUOTATION':
      return t('prc1.method.competitiveQuotation.name');
    case 'DIRECT_PURCHASE':
      return t('prc1.method.directPurchase.name');
    case 'SELF_EXECUTION':
      return t('prc1.method.selfExecution.name');
    case 'COMMUNITY_PARTICIPATION':
      return t('prc1.method.communityParticipation.name');
    case 'SPECIAL_CASE':
      return t('prc1.method.specialCase.name');
    default:
      return code;
  }
}

export function statusLabel(t: T, status: WorkflowStatus): string {
  switch (status) {
    case 'NOT_STARTED':
      return t('prc1.status.notStarted.name');
    case 'IN_PROGRESS':
      return t('prc1.status.inProgress.name');
    case 'ON_HOLD':
      return t('prc1.status.onHold.name');
    case 'COMPLETED':
      return t('prc1.status.completed.name');
    case 'CANCELLED':
      return t('prc1.status.cancelled.name');
  }
}

export function milestoneLabel(t: T, kind: string): string {
  switch (kind) {
    case 'INVITATION_PUBLISHED':
      return t('prc1.milestone.invitation.name');
    case 'CLARIFICATION_DEADLINE':
      return t('prc1.milestone.clarification.name');
    case 'BID_CLOSING':
      return t('prc1.milestone.closing.name');
    case 'BID_OPENING':
      return t('prc1.milestone.opening.name');
    case 'EVALUATION_DONE':
      return t('prc1.milestone.evaluation.name');
    case 'RESULT_APPROVED':
      return t('prc1.milestone.approved.name');
    case 'RESULT_PUBLISHED':
      return t('prc1.milestone.published.name');
    case 'CONTRACT_SIGNED':
      return t('prc1.milestone.contract.name');
    default:
      return kind;
  }
}

export function evidenceKindLabel(t: T, kind: string): string {
  switch (kind) {
    case 'DOCUMENT':
      return t('prc1.evidence.document.name');
    case 'DECISION_DOCUMENT':
      return t('prc1.evidence.decision.name');
    case 'MILESTONE':
      return t('prc1.evidence.milestone.name');
    case 'ATTESTATION':
      return t('prc1.evidence.attestation.name');
    case 'EXTERNAL_RECEIPT':
      return t('prc1.evidence.receipt.name');
    default:
      return kind;
  }
}

export function blockerLabel(t: T, blocker: BlockerDto): string {
  switch (blocker.reason) {
    case 'ON_HOLD':
      return blocker.detail === null ? t('prc1.blocker.onHold.text') : t('prc1.blocker.onHoldWhy.text', { reason: blocker.detail });
    case 'REQUIRED_ITEMS_OPEN':
      return t('prc1.blocker.items.text', { count: blocker.count ?? 0 });
    case 'EVIDENCE_MISSING':
      return t('prc1.blocker.evidence.text', { kind: blocker.detail === null ? '' : evidenceKindLabel(t, blocker.detail) });
    case 'EXCEPTION_PENDING':
      return t('prc1.blocker.exception.text');
    case 'STEP_OVERDUE':
      return t('prc1.blocker.overdue.text', { days: blocker.count ?? 0 });
    case 'NO_OWNER':
      return t('prc1.blocker.noOwner.text');
    case 'CALENDAR_UNAVAILABLE':
      return t('prc1.blocker.calendar.text');
  }
}

/** Why the server refused an advance: one line for each blocker it named. */
export function refusalBlocker(t: T, code: string, subject: string | null): string {
  switch (code) {
    case 'REQUIRED_ITEM_OPEN':
      return t('prc1.refusal.item.text', { item: subject ?? '' });
    case 'STEP_EVIDENCE_MISSING':
      return t('prc1.refusal.evidence.text', { kind: subject === null ? '' : evidenceKindLabel(t, subject) });
    case 'MAKER_IS_APPROVER':
      return t('prc1.refusal.maker.text');
    case 'WORKFLOW_NOT_ACTIVE':
      return t('prc1.refusal.inactive.text');
    default:
      return code;
  }
}

export function exceptionKindLabel(t: T, kind: ExceptionDto['kind']): string {
  return kind === 'SKIP_ITEMS' ? t('prc1.exception.skip.name') : t('prc1.exception.correct.name');
}

export function exceptionStatusLabel(t: T, status: ExceptionDto['status']): string {
  switch (status) {
    case 'REQUESTED':
      return t('prc1.exception.requested.name');
    case 'APPROVED':
      return t('prc1.exception.approved.name');
    case 'REJECTED':
      return t('prc1.exception.rejected.name');
    case 'USED':
      return t('prc1.exception.used.name');
  }
}

export function itemStatusLabel(t: T, status: 'OPEN' | 'DONE' | 'WAIVED'): string {
  return status === 'OPEN' ? t('prc1.item.open.name') : status === 'DONE' ? t('prc1.item.done.name') : t('prc1.item.waived.name');
}

/** What a refused call says, in the words of the screen: the code decides, the detail of the server is never shown. */
export function errorText(t: T, error: unknown): string {
  if (!(error instanceof ApiError)) return t('prc1.error.unknown.text');
  switch (error.code) {
    case 'VERSION_CONFLICT':
      return t('prc1.error.version.text');
    case 'PACKAGE_WORKFLOW_BLOCKED':
      return t('prc1.error.blocked.text');
    case 'PACKAGE_WORKFLOW_STATE_INVALID':
      return t('prc1.error.state.text');
    case 'PACKAGE_WORKFLOW_METHOD_UNSUPPORTED':
      return t('prc1.error.method.text');
    case 'PACKAGE_STATE_INVALID':
      return t('prc1.error.package.text');
    case 'CHECKLIST_EVIDENCE_REQUIRED':
      return t('prc1.error.evidence.text');
    case 'STEP_EXCEPTION_STATE_INVALID':
      return t('prc1.error.exception.text');
    case 'WORKFLOW_MAKER_IS_APPROVER':
      return t('prc1.error.maker.text');
    case 'SELF_APPROVAL_DENIED':
      return t('prc1.error.self.text');
    case 'VALIDATION_FAILED':
      return t('prc1.error.validation.text');
    case 'RESOURCE_NOT_FOUND':
      return t('prc1.error.notFound.text');
    case 'GOVERNANCE_RULE_PARAMS_INVALID':
      return t('prc1.error.params.text');
    default:
      return error.status === 403 ? t('prc1.error.forbidden.text') : t('prc1.error.refused.text', { code: error.code });
  }
}

export interface Names {
  step: (code: string | null) => string | undefined;
}

const person = (entry: EntryDto): { name: string; initials: string } | null =>
  entry.actor === null
    ? null
    : { name: entry.actor.name ?? '', initials: initialsOf(entry.actor.name) };

/** The first letter of the first and of the last word of a name ("Nguyễn Văn An" is NA). */
function initialsOf(name: string | null): string {
  const words = (name ?? '').split(/\s+/).filter(Boolean);
  const first = words[0]?.charAt(0).toUpperCase() ?? '?';
  const last = words.length > 1 ? (words[words.length - 1] as string).charAt(0).toUpperCase() : '';
  return `${first}${last}`;
}

/** One entry of the API as the Timeline of the kit shows it: every word comes from the keys, the reasons and names from the data. */
export function toTimelineEntry(t: T, entry: EntryDto, names: Names): TimelineEntry {
  const from = names.step(entry.from_step) ?? entry.from_step ?? '';
  const to = names.step(entry.to_step) ?? entry.to_step ?? '';
  const spent = entry.spent_working_days !== null ? t('prc1.timeline.after.working', { days: entry.spent_working_days }) : entry.spent_calendar_days !== null ? t('prc1.timeline.after.calendar', { days: entry.spent_calendar_days }) : undefined;
  const base = { id: entry.id, at: entry.at, actor: person(entry), ...(spent === undefined ? {} : { after: spent }), ...(entry.reason === null ? {} : { note: entry.reason }), ...(entry.evidence.length === 0 ? {} : { evidence: entry.evidence.map((one) => ({ label: one.milestone_kind === null ? evidenceKindLabel(t, one.kind) : milestoneLabel(t, one.milestone_kind), href: one.document_id === null ? '#' : `/d/${one.document_id}` })) }) };
  switch (entry.kind) {
    case 'START':
      return { ...base, kind: 'transition', title: t('prc1.timeline.start.text', { step: to }) };
    case 'STATE_CHANGE':
      return { ...base, kind: 'transition', from, to };
    case 'COMPLETE':
      return { ...base, kind: 'transition', title: t('prc1.timeline.complete.text'), tone: 'success' };
    case 'RETURN':
      return { ...base, kind: 'return', title: t('prc1.timeline.return.text', { from, to }) };
    case 'CORRECTION':
      return { ...base, kind: 'return', title: t('prc1.timeline.correction.text', { from, to }) };
    case 'CANCEL':
      return { ...base, kind: 'return', title: t('prc1.timeline.cancel.text'), tone: 'danger' };
    case 'CHECKLIST_DONE':
      return { ...base, kind: 'checklist', title: t('prc1.timeline.item.text', { item: entry.subject ?? '' }) };
    case 'HOLD':
      return { ...base, kind: 'hold', title: t('prc1.timeline.hold.text') };
    case 'RESUME':
      return { ...base, kind: 'hold', title: t('prc1.timeline.resume.text'), tone: 'success' };
    case 'EXCEPTION':
      return { ...base, kind: 'note', title: entry.subject === 'EXCEPTION_APPROVED' ? t('prc1.timeline.exceptionApproved.text') : entry.subject === 'EXCEPTION_REJECTED' ? t('prc1.timeline.exceptionRejected.text') : t('prc1.timeline.exceptionRequested.text') };
    case 'ASSIGNMENT':
      return { ...base, kind: 'note', title: entry.subject === 'REASSIGN_OWNER' ? t('prc1.timeline.reassign.text') : entry.subject === 'ASSIGN_ITEM' ? t('prc1.timeline.assignItem.text') : t('prc1.timeline.assign.text') };
    case 'MILESTONE':
      return { ...base, kind: 'note', title: t('prc1.timeline.milestone.text', { milestone: milestoneLabel(t, entry.subject ?? '') }) };
    case 'IMPORT':
      return { ...base, kind: 'import', title: t('prc1.timeline.import.text', { milestone: milestoneLabel(t, entry.subject ?? '') }) };
    case 'CLOCK_OVERDUE':
      return { ...base, kind: 'clock', title: t('prc1.timeline.overdue.text', { step: from }), badge: t('prc1.timeline.overdue.badge'), tone: 'danger', note: t('prc1.timeline.overdue.consequence') };
  }
}

export function toTimelineGroups(t: T, timeline: TimelineDto, names: Names): TimelineGroup[] {
  return timeline.days.map((day) => ({ date: day.day, entries: [...day.entries].reverse().map((entry) => toTimelineEntry(t, entry, names)) }));
}

/** The one line under the stepper: where the package is, how long, how far past the standard, who holds it. */
export function whereLine(t: T, input: { stepName: string | null; days: number | null; over: number; owner: string | null }): string {
  const parts = [input.stepName === null ? t('prc1.where.none.text') : t('prc1.where.step.text', { step: input.stepName })];
  if (input.days !== null) parts.push(t('prc1.where.days.text', { days: input.days }));
  if (input.over > 0) parts.push(t('prc1.where.over.text', { days: input.over }));
  parts.push(input.owner === null ? t('prc1.where.noOwner.text') : t('prc1.where.owner.text', { name: input.owner }));
  return parts.join(' · ');
}

/** The countdown of a step: "Còn 2 ngày · 09/11", "Hôm nay là hạn", "Quá hạn 3 ngày". */
export function countdownText(t: T, countdown: { days_left: number; due_on: string } | null, row?: Pick<WfRow, 'late_days'>): string {
  if (countdown === null) return t('prc1.countdown.none.text');
  const day = `${countdown.due_on.slice(8, 10)}/${countdown.due_on.slice(5, 7)}`;
  if (countdown.days_left > 0) return t('prc1.countdown.left.text', { days: countdown.days_left, day });
  if (countdown.days_left === 0) return t('prc1.countdown.today.text', { day });
  return t('prc1.countdown.over.text', { days: row?.late_days ?? -countdown.days_left, day });
}

export const clockOf = (instant: string): string => vietnamTime(instant);
