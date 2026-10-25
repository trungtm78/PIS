import type { useTranslation } from '../../../i18n';
import type { Decision, FormProblem, HandoverKind, HandoverStatus, Problem, ProblemView, PunchStatus, Severity, Verification } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function kindLabel(t: Translate, kind: HandoverKind): string {
  switch (kind) {
    case 'PARTIAL':
      return t('ast.handover.kind.partial');
    case 'COMPLETION':
      return t('ast.handover.kind.completion');
    case 'ASSET_TRANSFER':
      return t('ast.handover.kind.assetTransfer');
  }
}

export function statusLabel(t: Translate, status: HandoverStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('ast.handover.status.draft');
    case 'INSPECTING':
      return t('ast.handover.status.inspecting');
    case 'PUNCH_PENDING':
      return t('ast.handover.status.punchPending');
    case 'ACCEPTED':
      return t('ast.handover.status.accepted');
    case 'REJECTED':
      return t('ast.handover.status.rejected');
    case 'CANCELLED':
      return t('ast.handover.status.cancelled');
  }
}

export function severityLabel(t: Translate, severity: Severity): string {
  switch (severity) {
    case 'CRITICAL':
      return t('ast.handover.severity.critical');
    case 'MAJOR':
      return t('ast.handover.severity.major');
    case 'MINOR':
      return t('ast.handover.severity.minor');
  }
}

export function punchStatusLabel(t: Translate, status: PunchStatus): string {
  switch (status) {
    case 'OPEN':
      return t('ast.handover.punch.open');
    case 'FIXED':
      return t('ast.handover.punch.fixed');
    case 'VERIFIED':
      return t('ast.handover.punch.verified');
    case 'WAIVED':
      return t('ast.handover.punch.waived');
  }
}

export function verificationLabel(t: Translate, outcome: Verification): string {
  switch (outcome) {
    case 'VERIFIED':
      return t('ast.handover.verification.verified');
    case 'REOPEN':
      return t('ast.handover.verification.reopen');
  }
}

export function decisionLabel(t: Translate, decision: Decision): string {
  switch (decision) {
    case 'approve':
      return t('ast.handover.decision.approve');
    case 'return':
      return t('ast.handover.decision.return');
    case 'reject':
      return t('ast.handover.decision.reject');
  }
}

export function documentRoleLabel(t: Translate, role: string): string {
  switch (role) {
    case 'MINUTES':
      return t('ast.handover.document.minutes');
    case 'AS_BUILT':
      return t('ast.handover.document.asBuilt');
    case 'OM_MANUAL':
      return t('ast.handover.document.omManual');
    case 'WARRANTY_CERTIFICATE':
      return t('ast.handover.document.warrantyCertificate');
    default:
      return role;
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('ast.handover.problem.required');
    case 'date':
      return t('ast.handover.problem.date');
    case 'uuid':
      return t('ast.handover.problem.uuid');
    case 'tooLong':
      return t('ast.handover.problem.tooLong');
    case 'past':
      return t('ast.handover.problem.past');
    case 'tooMany':
      return t('ast.handover.problem.tooMany');
  }
}

function baseMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'contractState':
      return t('ast.handover.error.contractState');
    case 'minutesRequired':
      return t('ast.handover.error.minutesRequired');
    case 'permitGate':
      return t('ast.handover.error.permitGate');
    case 'handoverState':
      return t('ast.handover.error.handoverState');
    case 'punchState':
      return t('ast.handover.error.punchState');
    case 'openCritical':
      return t('ast.handover.error.openCritical');
    case 'asBuiltRequired':
      return t('ast.handover.error.asBuiltRequired');
    case 'criticalWaiver':
      return t('ast.handover.error.criticalWaiver');
    case 'evidenceRequired':
      return t('ast.handover.error.evidenceRequired');
    case 'selfApproval':
      return t('ast.handover.error.selfApproval');
    case 'notClean':
      return t('ast.handover.error.notClean');
    case 'versionConflict':
      return t('ast.handover.error.versionConflict');
    case 'validation':
      return t('ast.handover.error.validation');
    case 'notFound':
      return t('ast.handover.error.notFound');
    case 'denied':
      return t('ast.handover.error.denied');
    case 'session':
      return t('ast.handover.error.session');
    case 'general':
      return t('ast.handover.error.general');
  }
}

/** What a refusal of a command says; the numbers of the critical items that are still open follow it when there are any. */
export function problemMessage(t: Translate, view: ProblemView): string {
  const base = baseMessage(t, view.problem);
  return view.detail.length === 0 ? base : `${base} ${t('ast.handover.error.items', { items: view.detail.join(', ') })}`;
}
