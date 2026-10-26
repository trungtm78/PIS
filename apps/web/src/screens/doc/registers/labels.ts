import type { Translator } from '../../../i18n';
import type { FieldProblem } from './rules';
import type { ProblemView } from './problems';
import type { Direction, EntryStatus, RegisterMode, RegisterStatus, SymbolKind } from './types';

type T = Translator['t'];

// Every key is written out so the i18n check can see it is in use.
export function directionLabel(t: T, direction: Direction): string {
  return direction === 'OUTGOING' ? t('doc.registers.direction.outgoing') : t('doc.registers.direction.incoming');
}

export function statusLabel(t: T, status: RegisterStatus): string {
  return status === 'OPEN' ? t('doc.registers.status.open') : t('doc.registers.status.closed');
}

export function modeLabel(t: T, mode: RegisterMode): string {
  return mode === 'MANAGED' ? t('doc.registers.mode.managed') : t('doc.registers.mode.mirrored');
}

export function entryStatusLabel(t: T, status: EntryStatus): string {
  switch (status) {
    case 'ALLOCATED':
      return t('doc.registers.entryStatus.allocated');
    case 'VOIDED':
      return t('doc.registers.entryStatus.voided');
    case 'RECALLED':
      return t('doc.registers.entryStatus.recalled');
  }
}

export function symbolKindLabel(t: T, kind: SymbolKind): string {
  switch (kind) {
    case 'DECISION':
      return t('doc.types.kind.decision');
    case 'NAMED_TYPE':
      return t('doc.types.kind.namedType');
    case 'OFFICIAL_LETTER':
      return t('doc.types.kind.officialLetter');
  }
}

export function fieldProblemMessage(t: T, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('doc.form.problem.required');
    case 'tooShort':
      return t('doc.form.problem.tooShort');
    case 'tooLong':
      return t('doc.form.problem.tooLong');
    case 'date':
      return t('doc.form.problem.date');
    case 'range':
      return t('doc.form.problem.range');
    case 'pattern':
      return t('doc.form.problem.pattern');
    case 'year':
      return t('doc.form.problem.year');
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'conflict':
      return t('doc.problem.conflict.text');
    case 'registerExists':
      return t('doc.problem.registerExists.text');
    case 'notOpen':
      return t('doc.problem.notOpen.text');
    case 'hasNumbered':
      return t('doc.problem.hasNumbered.text');
    case 'rangeOverlap':
      return t('doc.problem.rangeOverlap.text');
    case 'patternInvalid':
      return t('doc.problem.patternInvalid.text');
    case 'invalid':
      return t('doc.problem.invalid.text');
    case 'notFound':
      return t('doc.problem.notFound.text');
    case 'denied':
      return t('doc.problem.denied.text');
    case 'session':
      return t('doc.problem.session.text');
    case 'general':
      return t('doc.problem.general.text');
  }
}
