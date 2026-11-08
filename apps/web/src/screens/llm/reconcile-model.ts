/** The right to decide the reconciliation of the usage of a budget (the operation `post_budgets_id_reconcile`). */
export const RECONCILE_PERMISSION = 'llm.finops';

export const RECONCILE_DECISIONS = ['approve', 'return', 'reject'] as const;
export type ReconcileDecision = (typeof RECONCILE_DECISIONS)[number];

/** The store takes a reason of ten characters at least once trimmed (422 VALIDATION_FAILED otherwise). */
export const REASON_MIN = 10;
export const REASON_MAX = 2000;

export interface ReconcileForm {
  decision: ReconcileDecision;
  reason: string;
  /** The reservations the decision is about (their usage came back late or not at all). */
  reservationIds: readonly string[];
}

export const EMPTY_RECONCILE: ReconcileForm = { decision: 'approve', reason: '', reservationIds: [] };

export type ReconcileProblem = 'noReservation' | 'reasonShort' | 'reasonLong';

/** At least one reservation is chosen, and the reason is ten characters at least once trimmed. */
export function reconcileProblems(form: ReconcileForm): Partial<Record<'reservations' | 'reason', ReconcileProblem>> {
  const found: Partial<Record<'reservations' | 'reason', ReconcileProblem>> = {};
  if (form.reservationIds.length === 0) found.reservations = 'noReservation';
  if (form.reason.trim().length < REASON_MIN) found.reason = 'reasonShort';
  else if (form.reason.length > REASON_MAX) found.reason = 'reasonLong';
  return found;
}

export function reconcileBody(form: ReconcileForm): { decision: ReconcileDecision; reason: string; evidence_ids: string[] } {
  return { decision: form.decision, reason: form.reason.trim(), evidence_ids: [...form.reservationIds] };
}

/** Whether the person is offered the decision: they hold the right, the system is not read-only. */
export const mayReconcile = (permissions: readonly string[] | undefined, frozen: boolean): boolean => !frozen && (permissions === undefined || permissions.includes(RECONCILE_PERMISSION));

/** Adds or removes a reservation from the chosen ones, keeping the order they were chosen in. */
export function toggleReservation(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((one) => one !== id) : [...ids, id];
}
