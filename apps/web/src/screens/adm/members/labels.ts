import type { Translator } from '../../../i18n';
import type { FieldProblem } from './rules';
import type { InvitationStatus, Lifecycle, Member, MembershipStatus, MembershipType, SeatCount } from './types';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function statusLabel(t: T, status: MembershipStatus): string {
  switch (status) {
    case 'Invited':
      return t('adm.members.status.invited');
    case 'Active':
      return t('adm.members.status.active');
    case 'Suspended':
      return t('adm.members.status.suspended');
    case 'Ended':
      return t('adm.members.status.ended');
    case 'Expired':
      return t('adm.members.status.expired');
  }
}

/** A seat count as people read it: `used/limit`, or the used number with the words for no cap. */
export function seatCountText(t: T, seats: SeatCount): string {
  return seats.limit === undefined ? t('adm.members.seats.unlimited', { used: seats.used }) : t('adm.members.seats.used', { used: seats.used, limit: seats.limit });
}

export function typeLabel(t: T, type: MembershipType): string {
  switch (type) {
    case 'STAFF':
      return t('adm.members.type.staff');
    case 'GUEST_CONTRACTOR':
      return t('adm.members.type.guest');
    case 'SERVICE_ACCOUNT':
      return t('adm.members.type.service');
  }
}

export function invitationLabel(t: T, status: InvitationStatus | null): string {
  switch (status) {
    case 'Pending':
      return t('adm.members.invitation.pending');
    case 'Accepted':
      return t('adm.members.invitation.accepted');
    case 'Expired':
      return t('adm.members.invitation.expired');
    case 'Revoked':
      return t('adm.members.invitation.revoked');
    case null:
      return t('adm.members.invitation.none');
  }
}

/** The class of the status pill: the prototype's colours for good, waiting and closed states. */
export function statusPill(status: MembershipStatus): string {
  switch (status) {
    case 'Active':
      return 'pill';
    case 'Invited':
      return 'pill warn';
    case 'Suspended':
      return 'pill warn';
    case 'Ended':
    case 'Expired':
      return 'pill gray';
  }
}

export function lifecycleTitle(t: T, action: Lifecycle, member: Member): string {
  const name = member.displayName;
  switch (action) {
    case 'suspend':
      return t('adm.members.lifecycle.suspend.title', { name });
    case 'reactivate':
      return t('adm.members.lifecycle.reactivate.title', { name });
    case 'end':
      return t('adm.members.lifecycle.end.title', { name });
  }
}

export function lifecycleAction(t: T, action: Lifecycle): string {
  switch (action) {
    case 'suspend':
      return t('adm.members.suspend.action');
    case 'reactivate':
      return t('adm.members.reactivate.action');
    case 'end':
      return t('adm.members.end.action');
  }
}

export function lifecycleRowLabel(t: T, action: Lifecycle, member: Member): string {
  const name = member.displayName;
  switch (action) {
    case 'suspend':
      return t('adm.members.suspend.label', { name });
    case 'reactivate':
      return t('adm.members.reactivate.label', { name });
    case 'end':
      return t('adm.members.end.label', { name });
  }
}

export function lifecycleDone(t: T, action: Lifecycle, member: Member): string {
  const name = member.displayName;
  switch (action) {
    case 'suspend':
      return t('adm.members.lifecycle.suspend.done', { name });
    case 'reactivate':
      return t('adm.members.lifecycle.reactivate.done', { name });
    case 'end':
      return t('adm.members.lifecycle.end.done', { name });
  }
}

export function fieldProblemMessage(t: T, problem: FieldProblem, max?: string): string {
  switch (problem) {
    case 'required':
      return t('adm.members.problem.required');
    case 'email':
      return t('adm.members.problem.email');
    case 'tooLong':
      return t('adm.members.problem.tooLong');
    case 'tooShort':
      return t('adm.members.problem.tooShort');
    case 'past':
      return t('adm.members.problem.past');
    case 'beyond':
      return t('adm.members.problem.beyond', { max: max ?? '' });
    case 'date':
      return t('adm.members.problem.date');
  }
}

/** The calendar date of an ISO timestamp (the table shows days, not instants). */
export function dayOf(timestamp: string): string {
  return timestamp.slice(0, 10);
}
