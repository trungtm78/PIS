import type { Translator } from '../../../i18n';
import type { Bearer, FormProblem, Lane, Outcome, Problem, Severity, Status } from './model';

type T = Translator['t'];

export function severityLabel(t: T, severity: Severity): string {
  switch (severity) {
    case 'CRITICAL':
      return t('ast.claims.severity.critical');
    case 'MAJOR':
      return t('ast.claims.severity.major');
    case 'MINOR':
      return t('ast.claims.severity.minor');
  }
}

export function statusLabel(t: T, status: Status): string {
  switch (status) {
    case 'OPEN':
      return t('ast.claims.status.open');
    case 'ACKNOWLEDGED':
      return t('ast.claims.status.acknowledged');
    case 'REPAIRING':
      return t('ast.claims.status.repairing');
    case 'FIXED':
      return t('ast.claims.status.fixed');
    case 'VERIFIED':
      return t('ast.claims.status.verified');
    case 'CLOSED':
      return t('ast.claims.status.closed');
    case 'DISPUTED':
      return t('ast.claims.status.disputed');
  }
}

export function laneLabel(t: T, lane: Lane): string {
  switch (lane) {
    case 'OPEN':
      return t('ast.claims.lane.open');
    case 'IN_PROGRESS':
      return t('ast.claims.lane.progress');
    case 'FIXED':
      return t('ast.claims.lane.fixed');
    case 'DISPUTED':
      return t('ast.claims.lane.disputed');
    case 'VERIFIED':
      return t('ast.claims.lane.verified');
  }
}

export function bearerLabel(t: T, bearer: Bearer): string {
  switch (bearer) {
    case 'CONTRACTOR':
      return t('ast.claims.bearer.contractor');
    case 'OWNER':
      return t('ast.claims.bearer.owner');
    case 'THIRD_PARTY':
      return t('ast.claims.bearer.third');
    case 'UNDETERMINED':
      return t('ast.claims.bearer.undetermined');
  }
}

export function outcomeLabel(t: T, outcome: Outcome): string {
  return outcome === 'VERIFIED' ? t('ast.claims.outcome.verified') : t('ast.claims.outcome.disputed');
}

export function formProblemMessage(t: T, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('ast.claims.problem.required');
    case 'invalid':
      return t('ast.claims.problem.invalid');
    case 'tooLong':
      return t('ast.claims.problem.tooLong');
    case 'evidence':
      return t('ast.claims.problem.evidence');
    case 'outside':
      return t('ast.claims.problem.outside');
  }
}

/** What a refusal of the server says, in words. */
export function problemMessage(t: T, problem: Problem): string {
  switch (problem) {
    case 'expired':
      return t('ast.claims.error.expired');
    case 'duplicate':
      return t('ast.claims.error.duplicate');
    case 'closed':
      return t('ast.claims.error.closed');
    case 'beforeStart':
      return t('ast.claims.error.beforeStart');
    case 'notParty':
      return t('ast.claims.error.notParty');
    case 'beforeReport':
      return t('ast.claims.error.beforeReport');
    case 'evidenceInvalid':
      return t('ast.claims.error.evidenceInvalid');
    case 'evidenceRequired':
      return t('ast.claims.error.evidenceRequired');
    case 'notClean':
      return t('ast.claims.error.notClean');
    case 'state':
      return t('ast.claims.error.state');
    case 'conflict':
      return t('ast.claims.error.conflict');
    case 'self':
      return t('ast.claims.error.self');
    case 'denied':
      return t('ast.claims.error.denied');
    case 'notFound':
      return t('ast.claims.error.notFound');
    case 'validation':
      return t('ast.claims.error.validation');
    case 'general':
      return t('ast.claims.error.general');
  }
}
