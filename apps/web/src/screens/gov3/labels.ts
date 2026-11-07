import type { Refusal } from './model';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** What a refusal of a command says; each key is written out so the i18n check can see it is in use. */
export function refusalText(t: Translate, refusal: Refusal): string {
  switch (refusal) {
    case 'noWbs':
      return t('govb1.refusal.noWbs');
    case 'incomplete':
      return t('govb1.refusal.incomplete');
    case 'alreadyTaken':
      return t('govb1.refusal.alreadyTaken');
    case 'selfApproval':
      return t('govb1.refusal.selfApproval');
    case 'reappraisalState':
      return t('govb1.refusal.reappraisalState');
    case 'alertState':
      return t('govb1.refusal.alertState');
    case 'versionConflict':
      return t('govb1.refusal.versionConflict');
    case 'componentUnchanged':
      return t('govb1.refusal.componentUnchanged');
    case 'baselineMissing':
      return t('govb1.refusal.baselineMissing');
    case 'notFound':
      return t('govb1.refusal.notFound');
    case 'denied':
      return t('govb1.refusal.denied');
    case 'validation':
      return t('govb1.refusal.validation');
    case 'session':
      return t('govb1.refusal.session');
    case 'general':
      return t('govb1.refusal.general');
  }
}

/** Why a figure cannot be shown (the code of the server) and what to do about it: the first line is the reason, the second the way out. */
export function reasonText(t: Translate, code: string): { reason: string; hint: string } {
  switch (code) {
    case 'NO_BASELINE':
      return { reason: t('govb1.reason.noBaseline'), hint: t('govb1.hint.noBaseline') };
    case 'NO_CONTRACT_LINK':
      return { reason: t('govb1.reason.noContractLink'), hint: t('govb1.hint.noContractLink') };
    case 'CONTRACT_VALUE_ZERO':
      return { reason: t('govb1.reason.contractValueZero'), hint: t('govb1.hint.contractValueZero') };
    case 'NO_SCHEDULE':
      return { reason: t('govb1.reason.noSchedule'), hint: t('govb1.hint.noSchedule') };
    case 'AC_ZERO':
      return { reason: t('govb1.reason.acZero'), hint: t('govb1.hint.acZero') };
    case 'PV_ZERO':
      return { reason: t('govb1.reason.pvZero'), hint: t('govb1.hint.pvZero') };
    case 'EV_ZERO':
      return { reason: t('govb1.reason.evZero'), hint: t('govb1.hint.evZero') };
    case 'BAC_EQUALS_AC':
      return { reason: t('govb1.reason.bacEqualsAc'), hint: t('govb1.hint.bacEqualsAc') };
    case 'NO_DATA':
      return { reason: t('govb1.reason.noData'), hint: t('govb1.hint.noData') };
    default:
      return { reason: t('govb1.reason.other', { code }), hint: t('govb1.hint.other') };
  }
}

export function methodText(t: Translate, method: string): string {
  switch (method) {
    case 'CPI_CUMULATIVE':
      return t('govb1.method.cpi');
    case 'AC_PLUS_REMAINING':
      return t('govb1.method.acRemaining');
    case 'AC_PLUS_REMAINING_OVER_CPI_SPI':
      return t('govb1.method.acRemainingCpiSpi');
    default:
      return method;
  }
}

export function ragText(t: Translate, rag: 'GREEN' | 'AMBER' | 'RED'): string {
  switch (rag) {
    case 'GREEN':
      return t('govb1.rag.green');
    case 'AMBER':
      return t('govb1.rag.amber');
    case 'RED':
      return t('govb1.rag.red');
  }
}

export const ragTone = (rag: 'GREEN' | 'AMBER' | 'RED' | null): 'success' | 'warning' | 'danger' | 'neutral' => (rag === 'GREEN' ? 'success' : rag === 'AMBER' ? 'warning' : rag === 'RED' ? 'danger' : 'neutral');
