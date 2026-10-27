/**
 * The history of an early warning as the profile of HOME-06 tells it (ST-HOME-003, HOME 3 F4): opened, acknowledged by someone with their reason, an explanation asked for and answered, and the way it closed. The
 * rows keep these as columns of the warning and of its explanation; the history is read from them in the order the moments say.
 */
export type WarningHistoryEvent = 'OPENED' | 'ACKNOWLEDGED' | 'EXPLANATION_REQUESTED' | 'EXPLANATION_RESPONDED' | 'RESOLVED' | 'DISMISSED';

export interface WarningHistoryEntry {
  event: WarningHistoryEvent;
  at: string;
  by: string | null;
  note: string | null;
}

export interface WarningHistoryInput {
  openedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgementNote: string | null;
  /** The explanation asked for on the warning, with the moments it has. */
  explanation: { requestedAt: string; requestedBy: string | null; status: string; respondedAt: string | null; reviewedAt: string | null } | null;
  closedAt: string | null;
  closedBy: string | null;
  status: string;
  resolutionReason: string | null;
}

/** The steps a warning has been through, the first being the day it was opened and none before it; a step that has no moment is not told. */
export function warningHistory(input: WarningHistoryInput): WarningHistoryEntry[] {
  const steps: WarningHistoryEntry[] = [];
  if (input.acknowledgedAt !== null) steps.push({ event: 'ACKNOWLEDGED', at: input.acknowledgedAt, by: input.acknowledgedBy, note: input.acknowledgementNote });
  if (input.explanation !== null) {
    steps.push({ event: 'EXPLANATION_REQUESTED', at: input.explanation.requestedAt, by: input.explanation.requestedBy, note: null });
    if (input.explanation.respondedAt !== null) steps.push({ event: 'EXPLANATION_RESPONDED', at: input.explanation.respondedAt, by: null, note: null });
  }
  if (input.closedAt !== null) steps.push({ event: input.status === 'DISMISSED' ? 'DISMISSED' : 'RESOLVED', at: input.closedAt, by: input.closedBy, note: input.resolutionReason });
  steps.sort((left, right) => left.at.localeCompare(right.at));
  // Nothing happened before the warning existed: a clock that says so is moved to the day it was opened.
  const later = steps.map((step) => (step.at < input.openedAt ? { ...step, at: input.openedAt } : step));
  return [{ event: 'OPENED', at: input.openedAt, by: null, note: null }, ...later];
}
