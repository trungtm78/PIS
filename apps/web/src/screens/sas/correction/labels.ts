import type { Translator } from '../../../i18n';
import type { InvoiceKind } from '../billing/model';
import type { CorrectionKind, FormProblems, LineProblem, ProblemView, TotalProblem, VatCategory } from './model';

type T = Translator['t'];

export function kindLabel(t: T, kind: InvoiceKind | CorrectionKind): string {
  switch (kind) {
    case 'ORIGINAL':
      return t('sas.correction.kind.original');
    case 'ADJUSTMENT':
      return t('sas.correction.kind.adjustment');
    case 'REPLACEMENT':
      return t('sas.correction.kind.replacement');
  }
}

export function vatLabel(t: T, category: VatCategory): string {
  switch (category) {
    case 'NOT_SUBJECT':
      return t('sas.correction.vat.notSubject');
    case 'VAT_0':
      return t('sas.correction.vat.zero');
    case 'VAT_5':
      return t('sas.correction.vat.five');
    case 'VAT_8':
      return t('sas.correction.vat.eight');
    case 'VAT_10':
      return t('sas.correction.vat.ten');
  }
}

export function lineProblemMessage(t: T, problem: LineProblem): string {
  switch (problem) {
    case 'description':
      return t('sas.correction.line.problem.description');
    case 'amount':
      return t('sas.correction.line.problem.amount');
    case 'zero':
      return t('sas.correction.line.problem.zero');
  }
}

export function totalProblemMessage(t: T, problem: TotalProblem): string {
  switch (problem) {
    case 'zero':
      return t('sas.correction.total.problem.zero');
    case 'belowZero':
      return t('sas.correction.total.problem.belowZero');
    case 'notAbove':
      return t('sas.correction.total.problem.notAbove');
  }
}

export function linesProblemMessage(t: T, problem: NonNullable<FormProblems['lines']>): string {
  return problem === 'empty' ? t('sas.correction.lines.problem.empty') : t('sas.correction.lines.problem.tooMany');
}

export function problemMessage(t: T, problem: ProblemView, format: (amount: string) => string): string {
  switch (problem.reason) {
    case 'adjustmentInvalid':
      return problem.standingVnd === undefined ? t('sas.correction.problem.adjustment') : t('sas.correction.problem.adjustmentStanding', { amount: format(problem.standingVnd) });
    case 'alreadyReplaced':
      return t('sas.correction.problem.alreadyReplaced');
    case 'stateInvalid':
      return t('sas.correction.problem.stateInvalid');
    case 'invalid':
      return problem.field === undefined ? t('sas.correction.problem.invalid') : t('sas.correction.problem.invalidAt', { field: problem.field });
    case 'denied':
      return t('sas.correction.problem.denied');
    case 'notFound':
      return t('sas.correction.problem.notFound');
    case 'session':
      return t('sas.correction.problem.session');
    case 'general':
      return t('sas.correction.problem.general');
  }
}
