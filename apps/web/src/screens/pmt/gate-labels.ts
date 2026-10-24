import type { useTranslation } from '../../i18n';
import type { GateCode, GateProblemView, GateStatus, Outcome, Requirement } from './gate-model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function gateLabel(t: Translate, code: GateCode): string {
  switch (code) {
    case 'CONTRACT_ACTIVATION':
      return t('pmt.gate.code.contractActivation.label');
    case 'START_CONSTRUCTION':
      return t('pmt.gate.code.startConstruction.label');
    case 'ACCEPTANCE_COMPLETION':
      return t('pmt.gate.code.acceptanceCompletion.label');
    case 'HANDOVER':
      return t('pmt.gate.code.handover.label');
    case 'ADVANCE_DISBURSEMENT':
      return t('pmt.gate.code.advanceDisbursement.label');
  }
}

export function requirementLabel(t: Translate, requirement: Requirement): string {
  switch (requirement) {
    case 'VALID_PERMIT':
      return t('pmt.gate.requirement.validPermit.label');
    case 'VALID_OR_EXEMPT':
      return t('pmt.gate.requirement.validOrExempt.label');
    case 'SUBMITTED_ONLY':
      return t('pmt.gate.requirement.submittedOnly.label');
  }
}

export function statusLabel(t: Translate, status: GateStatus): string {
  switch (status) {
    case 'PASSED':
      return t('pmt.gate.status.passed.label');
    case 'PASSED_WITH_WAIVER':
      return t('pmt.gate.status.waived.label');
    case 'BLOCKED':
      return t('pmt.gate.status.blocked.label');
  }
}

export function outcomeLabel(t: Translate, outcome: Outcome): string {
  switch (outcome) {
    case 'SATISFIED':
      return t('pmt.gate.outcome.satisfied.label');
    case 'WAIVED':
      return t('pmt.gate.outcome.waived.label');
    case 'BLOCKING':
      return t('pmt.gate.outcome.blocking.label');
  }
}

export function gateProblemMessage(t: Translate, problem: GateProblemView): string {
  switch (problem.reason) {
    case 'overlap':
      return t('pmt.gate.problem.overlap.error');
    case 'legalBasis':
      return t('pmt.gate.problem.legalBasis.error');
    case 'validation':
      return t('pmt.gate.problem.validation.error');
    case 'denied':
      return t('pmt.gate.problem.denied.error');
    case 'notFound':
      return t('pmt.gate.problem.notFound.error');
    case 'general':
      return t('pmt.gate.problem.general.error');
  }
}
