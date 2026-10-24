import type { useTranslation } from '../../i18n';
import { WAIVER_MAX_DAYS } from './waiver-model';
import type { WaiverFieldProblem, WaiverPhase, WaiverProblemView, WaiverStatus } from './waiver-model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function waiverStatusLabel(t: Translate, status: WaiverStatus): string {
  switch (status) {
    case 'ACTIVE':
      return t('pmt.waiver.status.active.label');
    case 'EXPIRED':
      return t('pmt.waiver.status.expired.label');
    case 'REVOKED':
      return t('pmt.waiver.status.revoked.label');
  }
}

export function phaseLabel(t: Translate, phase: WaiverPhase): string {
  switch (phase) {
    case 'inForce':
      return t('pmt.waiver.phase.inForce.label');
    case 'lapsed':
      return t('pmt.waiver.phase.lapsed.label');
    case 'revoked':
      return t('pmt.waiver.phase.revoked.label');
  }
}

export function waiverFieldMessage(t: Translate, problem: WaiverFieldProblem, latestDay: string): string {
  switch (problem) {
    case 'required':
      return t('pmt.waiver.field.required.error');
    case 'tooLong':
      return t('pmt.waiver.field.tooLong.error');
    case 'invalidId':
      return t('pmt.waiver.field.invalidId.error');
    case 'invalidDate':
      return t('pmt.waiver.field.invalidDate.error');
    case 'pastDate':
      return t('pmt.waiver.field.pastDate.error');
    case 'beyondMaximum':
      return t('pmt.waiver.field.beyondMaximum.error', { days: WAIVER_MAX_DAYS, latest: latestDay });
  }
}

/** The sentence for a refusal of a command of the waivers; a problem the screen has no sentence for is the general one. */
export function waiverProblemMessage(t: Translate, problem: WaiverProblemView): string {
  switch (problem.reason) {
    case 'tooLong':
      return t('pmt.waiver.problem.tooLong.error', { days: problem.maxDays ?? WAIVER_MAX_DAYS, latest: problem.latestDay ?? '' });
    case 'selfApproval':
      return t('pmt.waiver.problem.selfApproval.error');
    case 'documentRequired':
      return t('pmt.waiver.problem.documentRequired.error');
    case 'stateInvalid':
      return t('pmt.waiver.problem.stateInvalid.error');
    case 'validation':
      return t('pmt.waiver.problem.validation.error');
    case 'notFound':
      return t('pmt.waiver.problem.notFound.error');
    case 'denied':
      return t('pmt.waiver.problem.denied.error');
    case 'general':
      return t('pmt.waiver.problem.general.error');
  }
}
