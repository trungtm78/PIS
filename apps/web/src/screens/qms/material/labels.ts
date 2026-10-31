import type { Translator } from '../../../i18n';
import type { FormProblem, Problem, Result, Severity, Status } from './model';

type T = Translator['t'];

export function resultLabel(t: T, result: Result | 'PENDING'): string {
  switch (result) {
    case 'PENDING':
      return t('qms.material.result.pending');
    case 'PASS':
      return t('qms.material.result.pass');
    case 'FAIL':
      return t('qms.material.result.fail');
  }
}

export function statusLabel(t: T, status: Status): string {
  switch (status) {
    case 'REGISTERED':
      return t('qms.material.status.registered');
    case 'RESULT_RECORDED':
      return t('qms.material.status.recorded');
    case 'ACCEPTED':
      return t('qms.material.status.accepted');
    case 'REJECTED':
      return t('qms.material.status.rejected');
  }
}

export function severityLabel(t: T, severity: Severity): string {
  switch (severity) {
    case 'MINOR':
      return t('qms.material.severity.minor');
    case 'MAJOR':
      return t('qms.material.severity.major');
    case 'CRITICAL':
      return t('qms.material.severity.critical');
  }
}

export function formProblemMessage(t: T, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('qms.material.problem.required');
    case 'invalid':
      return t('qms.material.problem.invalid');
    case 'tooLong':
      return t('qms.material.problem.tooLong');
    case 'future':
      return t('qms.material.problem.future');
    case 'early':
      return t('qms.material.problem.early');
    case 'object':
      return t('qms.material.problem.object');
  }
}

/** What a refusal of the server says, in words. */
export function problemMessage(t: T, problem: Problem): string {
  switch (problem) {
    case 'duplicate':
      return t('qms.material.error.duplicate');
    case 'state':
      return t('qms.material.error.state');
    case 'conflict':
      return t('qms.material.error.conflict');
    case 'notClean':
      return t('qms.material.error.notClean');
    case 'contractState':
      return t('qms.material.error.contractState');
    case 'future':
      return t('qms.material.error.future');
    case 'early':
      return t('qms.material.error.early');
    case 'denied':
      return t('qms.material.error.denied');
    case 'notFound':
      return t('qms.material.error.notFound');
    case 'validation':
      return t('qms.material.error.validation');
    case 'general':
      return t('qms.material.error.general');
  }
}
