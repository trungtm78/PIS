import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { EMPTY_ASSIGN, assignBody, canAssign, describeReconcileProblem, missingCount, needsEvidence, reconcileState, validateAssign } from './national-code-model';
import { line } from './test-support';
import { toProjectLine } from './model';
import type { ProjectLine } from './model';

const of = (overrides: Record<string, unknown>): ProjectLine => toProjectLine(line(1, overrides)) as ProjectLine;
const DOCUMENT = '00000000-0000-4000-8000-000000000900';

describe('the national code of a project in the register (PRJ-21)', () => {
  it('AC-ST-PRJ-004-1: a project holds a code or misses it, and the missing ones are counted', () => {
    expect(reconcileState(of({ national_project_code: null }))).toBe('MISSING');
    expect(reconcileState(of({ national_project_code: '7654321' }))).toBe('HAS_CODE');
    expect(missingCount([of({}), of({ national_project_code: '7654321' }), of({ national_project_code: null })])).toBe(2);
    expect(missingCount([])).toBe(0);
  });

  it('AC-ST-PRJ-004-1: the assignment is offered with the permission, outside a read-only session and for a project that has not ended', () => {
    const open = of({ status: 'BUDGETED' });
    expect(canAssign(open, ['project.national_code.manage'], 'FULL')).toBe(true);
    expect(canAssign(open, undefined, undefined)).toBe(true);
    expect(canAssign(open, ['project.read'], 'FULL')).toBe(false);
    expect(canAssign(open, ['project.national_code.manage'], 'READ_ONLY')).toBe(false);
    for (const status of ['CLOSED', 'REJECTED', 'CANCELLED']) expect(canAssign(of({ status }), ['project.national_code.manage'], 'FULL')).toBe(false);
  });

  it('AC-ST-PRJ-004-1: changing a code that a project under way holds needs a ground; a first assignment, an early stage or the same code does not', () => {
    const under = of({ status: 'IMPLEMENTATION', national_project_code: '7654321' });
    expect(needsEvidence(under)).toBe(true);
    expect(needsEvidence(of({ status: 'IMPLEMENTATION', national_project_code: null }))).toBe(false);
    expect(needsEvidence(of({ status: 'BUDGETED', national_project_code: '7654321' }))).toBe(false);
    expect(validateAssign(under, { code: '7000001', evidenceId: '' })).toEqual({ evidenceId: 'evidenceRequired' });
    expect(validateAssign(under, { code: '7654321', evidenceId: '' })).toEqual({});
    expect(validateAssign(under, { code: '7000001', evidenceId: DOCUMENT })).toEqual({});
  });

  it('checks the code and the ground before anything is sent', () => {
    const project = of({ status: 'BUDGETED' });
    expect(validateAssign(project, EMPTY_ASSIGN)).toEqual({ code: 'codeRequired' });
    expect(validateAssign(project, { code: 'x'.repeat(51), evidenceId: 'nope' })).toEqual({ code: 'codeTooLong', evidenceId: 'evidenceInvalid' });
    expect(validateAssign(project, { code: 'a\u0007', evidenceId: '' })).toEqual({ code: 'codeInvalid' });
    expect(validateAssign(project, { code: '7000001', evidenceId: '' })).toEqual({});
  });

  it('sends the trimmed code and the ground in lower case, and nothing that was left empty', () => {
    expect(assignBody({ code: ' 7000001 ', evidenceId: '' })).toEqual({ national_project_code: '7000001' });
    expect(assignBody({ code: '7000001', evidenceId: ` ${DOCUMENT.toUpperCase()} ` })).toEqual({ national_project_code: '7000001', evidence_document_id: DOCUMENT });
  });

  it('maps the refusals of the assignment to the reasons the dialog says', () => {
    const problem = (code: string) => new ApiError({ status: 409, code, correlationId: 'c', extensions: {} });
    expect(describeReconcileProblem(problem('NATIONAL_CODE_DUPLICATE'))).toBe('duplicate');
    expect(describeReconcileProblem(problem('INVALID_REQUEST'))).toBe('validation');
    expect(describeReconcileProblem(problem('NOPE'))).toBe('general');
    expect(describeReconcileProblem(new Error('boom'))).toBe('general');
  });
});
