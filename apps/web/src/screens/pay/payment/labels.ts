import type { useTranslation } from '../../../i18n';
import type { DocKind, FormProblem, PaymentKind, PaymentStatus, Problem, WarningCode } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function statusLabel(t: Translate, status: PaymentStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('pay.payment.status.draft');
    case 'SUBMITTED':
      return t('pay.payment.status.submitted');
    case 'VERIFIED':
      return t('pay.payment.status.verified');
    case 'SENT_TREASURY':
      return t('pay.payment.status.sentTreasury');
    case 'SETTLED':
      return t('pay.payment.status.settled');
    case 'RETURNED':
      return t('pay.payment.status.returned');
    case 'CANCELLED':
      return t('pay.payment.status.cancelled');
    case 'REVERSED':
      return t('pay.payment.status.reversed');
  }
}

export function kindLabel(t: Translate, kind: PaymentKind): string {
  switch (kind) {
    case 'ADVANCE':
      return t('pay.payment.kind.advance');
    case 'INTERIM':
      return t('pay.payment.kind.interim');
    case 'FINAL':
      return t('pay.payment.kind.final');
  }
}

export function docKindLabel(t: Translate, kind: DocKind): string {
  switch (kind) {
    case 'INVOICE':
      return t('pay.payment.docKind.invoice');
    case 'ACCEPTANCE_MINUTES':
      return t('pay.payment.docKind.acceptanceMinutes');
    case 'GUARANTEE':
      return t('pay.payment.docKind.guarantee');
    case 'CONTRACT_COPY':
      return t('pay.payment.docKind.contractCopy');
    case 'TREASURY_FORM':
      return t('pay.payment.docKind.treasuryForm');
    case 'OTHER':
      return t('pay.payment.docKind.other');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('pay.payment.problem.required');
    case 'tooLong':
      return t('pay.payment.problem.tooLong');
    case 'amount':
      return t('pay.payment.problem.amount');
    case 'uuid':
      return t('pay.payment.problem.uuid');
    case 'date':
      return t('pay.payment.problem.date');
  }
}

export function warningMessage(t: Translate, code: WarningCode): string {
  switch (code) {
    case 'OTHER_DRAFTS_FOR_ACCEPTANCE':
      return t('pay.payment.warning.otherDrafts');
    case 'NATIONAL_CODE_MISSING':
      return t('pay.payment.warning.nationalCode');
    case 'DUPLICATE_INVOICE_OTHER_CONTRACT':
      return t('pay.payment.warning.invoiceElsewhere');
  }
}

/** What a refusal of a command says. */
export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'acceptanceNotApproved':
      return t('pay.payment.error.acceptanceNotApproved');
    case 'claimed':
      return t('pay.payment.error.claimed');
    case 'contractState':
      return t('pay.payment.error.contractState');
    case 'referenceDuplicate':
      return t('pay.payment.error.referenceDuplicate');
    case 'paymentState':
      return t('pay.payment.error.paymentState');
    case 'netMismatch':
      return t('pay.payment.error.netMismatch');
    case 'invoiceRequired':
      return t('pay.payment.error.invoiceRequired');
    case 'valueExceeded':
      return t('pay.payment.error.valueExceeded');
    case 'advanceExceeded':
      return t('pay.payment.error.advanceExceeded');
    case 'allocationUnavailable':
      return t('pay.payment.error.allocationUnavailable');
    case 'planYear':
      return t('pay.payment.error.planYear');
    case 'nationalCode':
      return t('pay.payment.error.nationalCode');
    case 'invoiceDuplicate':
      return t('pay.payment.error.invoiceDuplicate');
    case 'documentNotClean':
      return t('pay.payment.error.documentNotClean');
    case 'selfApproval':
      return t('pay.payment.error.selfApproval');
    case 'versionConflict':
      return t('pay.payment.error.versionConflict');
    case 'validation':
      return t('pay.payment.error.validation');
    case 'notFound':
      return t('pay.payment.error.notFound');
    case 'denied':
      return t('pay.payment.error.denied');
    case 'session':
      return t('pay.payment.error.session');
    case 'general':
      return t('pay.payment.error.general');
  }
}
