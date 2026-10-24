import { ApiError } from '@machvon/api-client';
import { FROZEN_STATUSES } from './model';
import type { ProjectLine, ProjectStatus } from './model';

/** PRJ-21: the national project codes of the register, reconciled by hand (ST-PRJ-004, PRJ 3.1 F7, BR-PRJ-02). */
export const RECONCILE_PATH = '/prj/prj-21';
export const MANAGE_PERMISSION = 'project.national_code.manage';

/** The adapter of the national system is a proposal: the screen reads no system of the State, it works on the file a person hands over. */
export const ADAPTER_STATUS = 'PROPOSED';

export const CODE_MAX_LENGTH = 50;
export const UNDER_WAY: readonly ProjectStatus[] = ['IMPLEMENTATION', 'SUSPENDED', 'COMPLETED', 'SETTLED'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether the register holds the code of the project (the file that is reconciled against it is for the import panel). */
export type ReconcileState = 'HAS_CODE' | 'MISSING';

export const reconcileState = (project: ProjectLine): ReconcileState => (project.nationalProjectCode === null ? 'MISSING' : 'HAS_CODE');

/** A project that has ended keeps its code: no assignment is offered for it. */
export const canAssign = (project: ProjectLine, permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean =>
  (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY' && !FROZEN_STATUSES.includes(project.status);

/** How many projects of a list have no code. */
export const missingCount = (projects: readonly ProjectLine[]): number => projects.filter((project) => reconcileState(project) === 'MISSING').length;

export interface AssignForm {
  code: string;
  evidenceId: string;
}

export const EMPTY_ASSIGN: AssignForm = { code: '', evidenceId: '' };

export type AssignProblem = 'codeRequired' | 'codeTooLong' | 'codeInvalid' | 'evidenceInvalid' | 'evidenceRequired';

/** Whether changing the code the project holds needs the document that grounds the change (the server judges the same rule). */
export const needsEvidence = (project: ProjectLine): boolean => project.nationalProjectCode !== null && UNDER_WAY.includes(project.status);

/** What is wrong with the form before anything is sent; the server judges the rules again, with the format of the rule in force. */
export function validateAssign(project: ProjectLine, form: AssignForm): Partial<Record<keyof AssignForm, AssignProblem>> {
  const problems: Partial<Record<keyof AssignForm, AssignProblem>> = {};
  const code = form.code.trim();
  if (code === '') problems.code = 'codeRequired';
  else if (code.length > CODE_MAX_LENGTH) problems.code = 'codeTooLong';
  // eslint-disable-next-line no-control-regex
  else if (/[\u0000-\u001f\u007f]/.test(code)) problems.code = 'codeInvalid';
  const evidence = form.evidenceId.trim();
  if (evidence !== '' && !UUID.test(evidence)) problems.evidenceId = 'evidenceInvalid';
  else if (evidence === '' && needsEvidence(project) && code !== project.nationalProjectCode) problems.evidenceId = 'evidenceRequired';
  return problems;
}

export interface AssignBody {
  national_project_code: string;
  evidence_document_id?: string;
}

export function assignBody(form: AssignForm): AssignBody {
  const body: AssignBody = { national_project_code: form.code.trim() };
  const evidence = form.evidenceId.trim();
  if (evidence !== '') body.evidence_document_id = evidence.toLowerCase();
  return body;
}

export type ReconcileProblem = 'formatInvalid' | 'duplicate' | 'evidenceRequired' | 'stageLocked' | 'versionConflict' | 'validation' | 'notFound' | 'denied' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, ReconcileProblem>> = {
  NATIONAL_CODE_FORMAT_INVALID: 'formatInvalid',
  NATIONAL_CODE_DUPLICATE: 'duplicate',
  DECISION_REQUIRED: 'evidenceRequired',
  STAGE_LOCKED_FIELD: 'stageLocked',
  VERSION_CONFLICT: 'versionConflict',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

/** Maps the error of the assignment to what the dialog shows; an unknown failure is the general message. */
export function describeReconcileProblem(error: unknown): ReconcileProblem {
  return error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general';
}
