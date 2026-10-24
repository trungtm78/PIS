import type { useTranslation } from '../../i18n';
import type { AdapterStatus, FieldProblem, LookupOutcome, LookupView, ProblemView, RestrictionKind, VerificationBasis, VerificationStatus } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: VerificationStatus): string {
  switch (status) {
    case 'UNVERIFIED':
      return t('bid.status.unverified.label');
    case 'VERIFIED':
      return t('bid.status.verified.label');
    case 'REJECTED':
      return t('bid.status.rejected.label');
  }
}

/** How the tax id was verified, in words that never say more than was done: a document checked by a person, or that and a lookup an adapter confirmed. */
export function basisLabel(t: Translate, basis: VerificationBasis): string {
  switch (basis) {
    case 'EVIDENCE_DOCUMENT':
      return t('bid.basis.document.label');
    case 'EVIDENCE_DOCUMENT_AND_LOOKUP':
      return t('bid.basis.lookup.label');
  }
}

export function kindLabel(t: Translate, kind: RestrictionKind): string {
  switch (kind) {
    case 'DEBARMENT':
      return t('bid.kind.debarment.label');
    case 'SUSPENSION':
      return t('bid.kind.suspension.label');
    case 'WARNING':
      return t('bid.kind.warning.label');
  }
}

/** The verdict on the adapter of the official lookup (not on the contractor): it is shown beside every answer the lookup gave. */
export function adapterLabel(t: Translate, status: AdapterStatus): string {
  switch (status) {
    case 'VERIFIED':
      return t('bid.adapter.verified.label');
    case 'PROPOSED':
      return t('bid.adapter.proposed.label');
    case 'MOCK':
      return t('bid.adapter.mock.label');
    case 'MISSING':
      return t('bid.adapter.missing.label');
  }
}

export function outcomeLabel(t: Translate, outcome: LookupOutcome): string {
  switch (outcome) {
    case 'MATCH':
      return t('bid.outcome.match.label');
    case 'NOT_FOUND':
      return t('bid.outcome.notFound.label');
    case 'NAME_MISMATCH':
      return t('bid.outcome.nameMismatch.label');
    case 'UNAVAILABLE':
      return t('bid.outcome.unavailable.label');
  }
}

/** What the official lookup said, and through which adapter; the sentence never calls an answer of an adapter that is not VERIFIED a confirmation. */
export function lookupSummary(t: Translate, lookup: LookupView | null): string {
  if (lookup === null) return t('bid.lookup.none.text');
  return t('bid.lookup.summary.text', { adapter: adapterLabel(t, lookup.adapterStatus), outcome: outcomeLabel(t, lookup.outcome), date: lookup.checkedAt.slice(0, 10) });
}

export function fieldProblemMessage(t: Translate, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('bid.field.required.error');
    case 'tooShort':
      return t('bid.field.tooShort.error');
    case 'tooLong':
      return t('bid.field.tooLong.error');
    case 'invalidTaxId':
      return t('bid.field.invalidTaxId.error');
    case 'invalidId':
      return t('bid.field.invalidId.error');
    case 'invalidDate':
      return t('bid.field.invalidDate.error');
    case 'order':
      return t('bid.field.order.error');
  }
}

/** The sentence for a refusal of a command; a problem the screen has no sentence for is the general one. */
export function problemMessage(t: Translate, problem: ProblemView): string {
  switch (problem.reason) {
    case 'taxIdInvalid':
      return t('bid.problem.taxIdInvalid.error');
    case 'alreadyVerified':
      return t('bid.problem.alreadyVerified.error');
    case 'duplicateVerified':
      return t('bid.problem.duplicateVerified.error');
    case 'selfApproval':
      return t('bid.problem.selfApproval.error');
    case 'versionConflict':
      return t('bid.problem.versionConflict.error');
    case 'stageDenied':
      return t('bid.problem.stageDenied.error');
    case 'decisionNotEffective':
      return t('bid.problem.decisionNotEffective.error');
    case 'adapterContradicts':
      return t('bid.problem.adapterContradicts.error');
    case 'validation':
      return problem.field === undefined ? t('bid.problem.validation.error') : t('bid.problem.validationField.error', { field: problem.field });
    case 'notFound':
      return t('bid.problem.notFound.error');
    case 'denied':
      return t('bid.problem.denied.error');
    case 'general':
      return t('bid.problem.general.error');
  }
}
