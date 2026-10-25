import { DomainError } from './errors.ts';
import { wholeVnd, signedDong } from './pay-money.ts';

/**
 * The Treasury forms of a payment request (ST-PAY-005, PAY 3.3 step 1, CXN-08): which forms a request goes to the Treasury with, and the payload that fills them. The codes await the original
 * appendix of Decree 254/2025; they are the only place the platform names them, and the database holds the same four (V1566). The payload is a pure function of the facts of the request, so the
 * same request gives the same payload and the same hash on every run.
 */

export const PAYMENT_FORM_CODES = ['03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT'] as const;
export type PaymentFormCode = (typeof PAYMENT_FORM_CODES)[number];

export const isPaymentFormCode = (value: string): value is PaymentFormCode => (PAYMENT_FORM_CODES as readonly string[]).includes(value);

/** The forms a request still lacks, in the order of the list of forms. */
export const formsMissing = (generated: Iterable<string>): PaymentFormCode[] => {
  const have = new Set(generated);
  return PAYMENT_FORM_CODES.filter((code) => !have.has(code));
};

/** The forms asked for: each one a known form, named once; none asked for is all of them. */
export function formsAskedFor(codes: readonly string[]): PaymentFormCode[] {
  if (codes.length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'form_codes');
  const asked: PaymentFormCode[] = [];
  for (const code of codes) {
    if (!isPaymentFormCode(code) || asked.includes(code)) throw new DomainError('VALIDATION_FAILED', 422, 'form_codes', { extensions: { form_code: code } });
    asked.push(code);
  }
  return PAYMENT_FORM_CODES.filter((code) => asked.includes(code));
}

/** What the form is filled from: the figures are the server's, and the names are the ones the records of the contract carry. */
export interface FormFacts {
  agency: string;
  place: string;
  requestNo: string;
  requestKind: string;
  contractCode: string;
  contractTitle: string;
  contractorName: string;
  projectCode: string;
  projectName: string;
  planYear: number | null;
  grossVnd: string;
  advanceRecoveryVnd: string;
  retentionVnd: string;
  taxAdjustmentVnd: string;
  netVnd: string;
}

/** An amount of dong in groups of three digits, as it is written on a form (a minus sign stays in front). */
export function groupedVnd(value: string): string {
  const negative = value.startsWith('-');
  const digits = (negative ? value.slice(1) : value).replace(/^0+(?=\d)/, '');
  signedDong(value, 'amount');
  return `${negative ? '-' : ''}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

/**
 * The payload of a form. The field mapping to the cells of the forms is the accountant's to sign (docs/pay-treasury-forms.md): the value of the accepted work is `gross`, the advance recovered is
 * `advance_recovery`, the retention is `retention`, the amount asked for is `net`; the contract, the contractor and the line of capital come from the records of the contract.
 */
export function formPayload(facts: FormFacts, formCode: PaymentFormCode): Record<string, unknown> {
  for (const amount of [facts.grossVnd, facts.advanceRecoveryVnd, facts.retentionVnd]) wholeVnd(amount, 'amount');
  return {
    agency: facts.agency,
    place: facts.place,
    form_code: formCode,
    summary: `Giấy đề nghị thanh toán ${facts.requestNo} của hợp đồng ${facts.contractCode}`,
    request_no: facts.requestNo,
    request_kind: facts.requestKind,
    contract_code: facts.contractCode,
    contract_title: facts.contractTitle,
    contractor_name: facts.contractorName,
    project_code: facts.projectCode,
    project_name: facts.projectName,
    plan_year: facts.planYear === null ? '' : String(facts.planYear),
    gross_vnd: facts.grossVnd,
    advance_recovery_vnd: facts.advanceRecoveryVnd,
    retention_vnd: facts.retentionVnd,
    tax_adjustment_vnd: facts.taxAdjustmentVnd,
    net_vnd: facts.netVnd,
    gross_text: groupedVnd(facts.grossVnd),
    advance_recovery_text: groupedVnd(facts.advanceRecoveryVnd),
    retention_text: groupedVnd(facts.retentionVnd),
    tax_adjustment_text: groupedVnd(facts.taxAdjustmentVnd),
    net_text: groupedVnd(facts.netVnd),
  };
}
