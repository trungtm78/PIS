import type { useTranslation } from '../../../i18n';
import type { DailyProblem, DayState, ItemStatus, LineKind, PartialReason } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function kindLabel(t: Translate, kind: LineKind): string {
  switch (kind) {
    case 'TIMING':
      return t('govd.recon.kind.timing');
    case 'UNMATCHED':
      return t('govd.recon.kind.unmatched');
    case 'MISSING_ON_TREASURY':
      return t('govd.recon.kind.missingOnTreasury');
    case 'MISSING_INTERNAL':
      return t('govd.recon.kind.missingInternal');
    case 'AMOUNT':
      return t('govd.recon.kind.amount');
  }
}

export function itemStatusLabel(t: Translate, status: ItemStatus): string {
  switch (status) {
    case 'OPEN':
      return t('govd.recon.status.open');
    case 'EXPLAINED':
      return t('govd.recon.status.explained');
    case 'RESOLVED':
      return t('govd.recon.status.resolved');
    case 'WRITTEN_OFF_APPROVED':
      return t('govd.recon.status.writtenOff');
    case 'AUTO_CLEARED':
      return t('govd.recon.status.autoCleared');
  }
}

export function dayStateLabel(t: Translate, state: DayState): string {
  switch (state) {
    case 'NO_RUN':
      return t('govd.recon.days.state.noRun');
    case 'COMPLETE':
      return t('govd.recon.days.state.complete');
    case 'PARTIAL':
      return t('govd.recon.days.state.partial');
  }
}

export function partialReasonLabel(t: Translate, reason: PartialReason | null): string {
  switch (reason) {
    case 'STATEMENT_MISSING':
      return t('govd.recon.days.reason.statementMissing');
    case 'SOURCE_UNREADABLE':
      return t('govd.recon.days.reason.sourceUnreadable');
    case null:
      return '';
  }
}

export function problemMessage(t: Translate, problem: DailyProblem): string {
  switch (problem) {
    case 'required':
      return t('govd.recon.problem.required');
    case 'tooLong':
      return t('govd.recon.problem.tooLong');
    case 'uuid':
      return t('govd.recon.problem.uuid');
    case 'invalid':
      return t('govd.recon.problem.invalid');
    case 'past':
      return t('govd.recon.problem.past');
    case 'future':
      return t('govd.recon.problem.future');
  }
}
