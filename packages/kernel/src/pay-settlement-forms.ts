import { DomainError } from './errors.ts';
import { groupedVnd } from './pay-forms.ts';
import type { SettlementScope } from './pay-project-settlement.ts';
import { wholeVnd } from './pay-money.ts';

/**
 * The forms of a settlement (ST-PAY-012, PAY 3.5 step 3, CXN-09): which forms a settlement of a year or of a completed project is drawn up with, and the payload that fills them. The codes are the ones of the
 * settlement of annual capital (01 to 05/QTNĐ) and of a completed project (01 to 12/QTDA, of which 10/QTDA is the decision that approves the settlement); they await the confirmation of the original forms (CXN-09), which
 * DOC holds as templates. The payload is a pure function of the facts of the settlement, so the same settlement gives the same payload and the same hash on every run.
 */

export const ANNUAL_SETTLEMENT_FORM_CODES = ['01/QTNĐ', '02/QTNĐ', '03/QTNĐ', '04/QTNĐ', '05/QTNĐ'] as const;
export const PROJECT_SETTLEMENT_FORM_CODES = ['01/QTDA', '02/QTDA', '03/QTDA', '04/QTDA', '05/QTDA', '06/QTDA', '07/QTDA', '08/QTDA', '09/QTDA', '10/QTDA', '11/QTDA', '12/QTDA'] as const;
export const SETTLEMENT_FORM_CODES = [...ANNUAL_SETTLEMENT_FORM_CODES, ...PROJECT_SETTLEMENT_FORM_CODES] as const;
export type SettlementFormCode = (typeof SETTLEMENT_FORM_CODES)[number];

/** The form that is the decision approving the settlement of a project: DOC draws it as the draft of a document that is issued by its own steps. */
export const SETTLEMENT_DECISION_FORM = '10/QTDA';

/** The forms a settlement of a scope is drawn up with; a settlement of one contract has none. */
export function settlementFormsOf(scope: SettlementScope): readonly SettlementFormCode[] {
  if (scope === 'ANNUAL') return ANNUAL_SETTLEMENT_FORM_CODES;
  if (scope === 'PROJECT') return PROJECT_SETTLEMENT_FORM_CODES;
  return [];
}

/**
 * The forms asked for: each one a form of the scope of the settlement, named once, in the order of the list of forms. A settlement of one contract has no form (422 `VALIDATION_FAILED` on the settlement); an
 * unknown form, one of the other scope or one named twice is 422 on `form_codes` and names the form.
 */
export function settlementFormsAskedFor(scope: SettlementScope, codes: readonly string[]): SettlementFormCode[] {
  const allowed = settlementFormsOf(scope);
  if (allowed.length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'id', { extensions: { reason: 'SCOPE_HAS_NO_FORMS', settlement_scope: scope } });
  if (codes.length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'form_codes');
  const asked: SettlementFormCode[] = [];
  for (const code of codes) {
    const known = allowed.find((candidate) => candidate === code);
    if (known === undefined || asked.includes(known)) throw new DomainError('VALIDATION_FAILED', 422, 'form_codes', { extensions: { form_code: code } });
    asked.push(known);
  }
  return allowed.filter((code) => asked.includes(code));
}

/** What the form is filled from: the figures are the server's, and the names are the ones the records of the project carry. */
export interface SettlementFormFacts {
  agency: string;
  place: string;
  projectCode: string;
  projectName: string;
  scope: Exclude<SettlementScope, 'CONTRACT'>;
  fiscalYear: number | null;
  revision: number;
  projectGroup: string | null;
  settledAmountVnd: string;
  outstandingVnd: string;
  unrecoveredAdvanceVnd: string;
  submittedOn: string | null;
  verifiedOn: string | null;
}

/**
 * The payload of a form. The mapping of the fields to the cells of the forms is the accountant's and the capital owner's to sign (docs/pay-settlement-forms.md): the value settled is `settled_amount`, what is still
 * owed `outstanding`, the advance not recovered `unrecovered_advance`; the project, the year and the days come from the settlement.
 */
export function settlementFormPayload(facts: SettlementFormFacts, formCode: SettlementFormCode): Record<string, unknown> {
  for (const amount of [facts.settledAmountVnd, facts.outstandingVnd, facts.unrecoveredAdvanceVnd]) wholeVnd(amount, 'amount');
  const decision = formCode === SETTLEMENT_DECISION_FORM;
  const subject = facts.scope === 'ANNUAL' ? `quyết toán niên độ ${facts.fiscalYear ?? ''} của dự án ${facts.projectCode}` : `quyết toán dự án hoàn thành ${facts.projectCode}`;
  return {
    agency: facts.agency,
    place: facts.place,
    form_code: formCode,
    summary: decision ? `Quyết định phê duyệt ${subject}` : `Báo cáo ${subject}`,
    settlement_scope: facts.scope,
    revision: String(facts.revision),
    project_code: facts.projectCode,
    project_name: facts.projectName,
    project_group: facts.projectGroup ?? '',
    fiscal_year: facts.fiscalYear === null ? '' : String(facts.fiscalYear),
    // The amount DOC reads to judge the authority of the signer of the decision (the band of the signer's limit), so the value of the settlement is the amount of the document.
    amount_vnd: facts.settledAmountVnd,
    settled_amount_vnd: facts.settledAmountVnd,
    outstanding_vnd: facts.outstandingVnd,
    unrecovered_advance_vnd: facts.unrecoveredAdvanceVnd,
    settled_amount_text: groupedVnd(facts.settledAmountVnd),
    outstanding_text: groupedVnd(facts.outstandingVnd),
    unrecovered_advance_text: groupedVnd(facts.unrecoveredAdvanceVnd),
    submitted_on: facts.submittedOn ?? '',
    verified_on: facts.verifiedOn ?? '',
  };
}
