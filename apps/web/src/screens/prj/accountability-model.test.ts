import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_ASSIGN,
  EMPTY_DISSOLVE,
  EMPTY_END,
  EMPTY_MEMBER,
  EMPTY_TASK_FORCE,
  assignBody,
  canEndAssignment,
  describeProblem,
  endBody,
  memberBody,
  openMembers,
  taskForceBody,
  toAssignmentLine,
  toTaskForceLine,
  validateAssign,
  validateDissolve,
  validateEnd,
  validateMember,
  validateTaskForce,
  vietnamToday,
} from './accountability-model';

const ID = '00000000-0000-4000-8000-0000000000a1';
const TODAY = '2026-10-24';

const assignment = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  project_id: '00000000-0000-4000-8000-0000000000b1',
  project_code: 'DA-001',
  project_name: 'Cầu Thủ Thiêm 4',
  leader: { membership_id: '00000000-0000-4000-8000-0000000000c1', display_name: 'Nguyễn Văn An' },
  accountability_role: 'LEADER_IN_CHARGE',
  assignment_document_id: null,
  valid_from: '2026-01-05',
  valid_until: null,
  status: 'ACTIVE',
  end_reason: null,
  version: 1,
  ...overrides,
});

const force = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  code: 'TF-01',
  name: 'Tổ công tác giải ngân',
  purpose: 'Đôn đốc giải ngân các dự án chậm',
  lead: { membership_id: '00000000-0000-4000-8000-0000000000c1', display_name: 'Nguyễn Văn An' },
  scope_unit: { id: '00000000-0000-4000-8000-0000000000d1', code: 'U-BQL1', name: 'Ban QLDA 1' },
  establishment_document_id: null,
  valid_from: '2026-01-05',
  valid_until: null,
  status: 'ACTIVE',
  version: 2,
  members: [
    { id: '00000000-0000-4000-8000-0000000000e1', membership_id: '00000000-0000-4000-8000-0000000000c1', display_name: 'Nguyễn Văn An', role: 'LEAD', project: null, valid_from: '2026-01-05', valid_until: null },
    { id: '00000000-0000-4000-8000-0000000000e2', membership_id: '00000000-0000-4000-8000-0000000000c2', display_name: 'Trần Thị Bình', role: 'MEMBER', project: { id: 'p', code: 'DA-001', name: 'Cầu' }, valid_from: '2026-01-06', valid_until: '2026-03-01' },
  ],
  ...overrides,
});

describe('toAssignmentLine: the register of assignments, read defensively', () => {
  it('reads a row with the leader, the role, the window and the version', () => {
    expect(toAssignmentLine(assignment())).toEqual({
      id: ID,
      projectId: '00000000-0000-4000-8000-0000000000b1',
      projectCode: 'DA-001',
      projectName: 'Cầu Thủ Thiêm 4',
      leaderMembershipId: '00000000-0000-4000-8000-0000000000c1',
      leaderName: 'Nguyễn Văn An',
      role: 'LEADER_IN_CHARGE',
      documentId: null,
      validFrom: '2026-01-05',
      validUntil: null,
      status: 'ACTIVE',
      endReason: null,
      version: 1,
    });
    expect(toAssignmentLine(assignment({ status: 'ENDED', valid_until: '2026-02-01', end_reason: 'Moved', assignment_document_id: ID, leader: { membership_id: ID } }))).toMatchObject({ status: 'ENDED', validUntil: '2026-02-01', endReason: 'Moved', documentId: ID, leaderName: null });
  });

  it('drops what it cannot trust', () => {
    for (const bad of [undefined, 'row', null, assignment({ id: 1 }), assignment({ leader: null }), assignment({ accountability_role: 'CHIEF' }), assignment({ status: 'DONE' }), assignment({ version: '1' }), assignment({ valid_from: undefined })]) {
      expect(toAssignmentLine(bad)).toBeUndefined();
    }
    expect(toAssignmentLine(assignment({ project_name: 3 }))?.projectName).toBe('');
  });

  it('offers to end only an assignment in force, to whoever may administer assignments', () => {
    const active = toAssignmentLine(assignment());
    const ended = toAssignmentLine(assignment({ status: 'ENDED', valid_until: '2026-02-01', end_reason: 'Moved' }));
    expect([canEndAssignment(active!, true), canEndAssignment(active!, false), canEndAssignment(ended!, true)]).toEqual([true, false, false]);
  });
});

describe('toTaskForceLine: the task forces with their terms, read defensively', () => {
  it('reads the force, the scope, the lead and the terms with the project each follows', () => {
    const line = toTaskForceLine(force());
    expect(line).toMatchObject({ id: ID, code: 'TF-01', leadName: 'Nguyễn Văn An', scopeUnitName: 'Ban QLDA 1', status: 'ACTIVE', version: 2, documentId: null });
    expect(line?.members.map((member) => [member.role, member.displayName, member.projectCode, member.validUntil])).toEqual([
      ['LEAD', 'Nguyễn Văn An', null, null],
      ['MEMBER', 'Trần Thị Bình', 'DA-001', '2026-03-01'],
    ]);
    expect(openMembers(line!).map((member) => member.role)).toEqual(['LEAD']);
  });

  it('drops a row and a term it cannot trust, and reads no members from a field that is not a list', () => {
    for (const bad of [undefined, 3, force({ code: 4 }), force({ lead: {} }), force({ scope_unit: null }), force({ status: 'GONE' }), force({ version: 'x' })]) expect(toTaskForceLine(bad)).toBeUndefined();
    expect(toTaskForceLine(force({ members: 'none' }))?.members).toEqual([]);
    expect(toTaskForceLine(force({ members: [{ id: 1 }, null, { id: ID, membership_id: ID, role: 'CHAIR', valid_from: '2026-01-01' }] }))?.members).toEqual([]);
    expect(toTaskForceLine(force({ purpose: 7, scope_unit: { id: ID } }))).toMatchObject({ purpose: '', scopeUnitName: '' });
  });
});

describe('the forms', () => {
  it('knows the day in Viet Nam, not the day of the machine', () => {
    expect(vietnamToday(new Date('2026-10-23T18:30:00Z'))).toBe('2026-10-24');
    expect(vietnamToday(new Date('2026-10-23T16:30:00Z'))).toBe('2026-10-23');
  });

  it('asks the project, the leader, the role and a day that is not in the future, and a document only when it is an id', () => {
    expect(validateAssign(EMPTY_ASSIGN, TODAY)).toEqual({ projectId: 'required', leaderId: 'required', validFrom: 'required' });
    const filled = { projectId: ID, leaderId: ID, role: 'DEPUTY_LEADER', validFrom: '2026-01-05', documentId: '' };
    expect(validateAssign(filled, TODAY)).toEqual({});
    expect(validateAssign({ ...filled, role: 'CHIEF', validFrom: '2026-02-30', documentId: 'nope' }, TODAY)).toEqual({ role: 'invalidRole', validFrom: 'invalidDate', documentId: 'invalidId' });
    expect(validateAssign({ ...filled, validFrom: '2026-10-25' }, TODAY)).toEqual({ validFrom: 'future' });
    expect(assignBody({ ...filled, documentId: ` ${ID.toUpperCase()} ` })).toEqual({ leader_membership_id: ID, accountability_role: 'DEPUTY_LEADER', valid_from: '2026-01-05', assignment_document_id: ID });
    expect(assignBody(filled)).toEqual({ leader_membership_id: ID, accountability_role: 'DEPUTY_LEADER', valid_from: '2026-01-05' });
  });

  it('asks a day between the start and today, and a reason, to end an assignment', () => {
    expect(validateEnd(EMPTY_END, TODAY, '2026-01-05')).toEqual({ validUntil: 'required', reason: 'required' });
    expect(validateEnd({ validUntil: '2026-01-04', reason: 'no' }, TODAY, '2026-01-05')).toEqual({ validUntil: 'beforeStart', reason: 'tooShort' });
    expect(validateEnd({ validUntil: '2026-10-25', reason: 'x'.repeat(2001) }, TODAY, '2026-01-05')).toEqual({ validUntil: 'future', reason: 'tooLong' });
    expect(validateEnd({ validUntil: '2026-01-05', reason: 'Line one\nline two' }, TODAY, '2026-01-05')).toEqual({});
    expect(validateEnd({ validUntil: '2026-01-06', reason: 'bad \u0007 reason' }, TODAY, '2026-01-05')).toEqual({ reason: 'invalidText' });
    expect(endBody({ validUntil: '2026-02-01', reason: '  Reassigned  ' })).toEqual({ valid_until: '2026-02-01', end_reason: 'Reassigned' });
  });

  it('asks the code, the name, the purpose, the lead, the scope and a day to found a task force', () => {
    expect(Object.keys(validateTaskForce(EMPTY_TASK_FORCE, TODAY)).sort()).toEqual(['code', 'leadId', 'name', 'purpose', 'scopeUnitId', 'validFrom']);
    const filled = { code: ' TF-01 ', name: ' Tổ công tác ', purpose: ' Đôn đốc giải ngân ', leadId: ID, scopeUnitId: ID, validFrom: '2026-01-05', documentId: ID.toUpperCase() };
    expect(validateTaskForce(filled, TODAY)).toEqual({});
    expect(validateTaskForce({ ...filled, code: 'C'.repeat(31), name: 'ab', purpose: 'short', documentId: 'x' }, TODAY)).toEqual({ code: 'tooLong', name: 'tooShort', purpose: 'tooShort', documentId: 'invalidId' });
    expect(taskForceBody(filled)).toEqual({ code: 'TF-01', name: 'Tổ công tác', purpose: 'Đôn đốc giải ngân', lead_membership_id: ID, scope_unit_id: ID, valid_from: '2026-01-05', establishment_document_id: ID });
    expect(taskForceBody({ ...filled, documentId: '' })).not.toHaveProperty('establishment_document_id');
  });

  it('asks a member, a role other than LEAD and a day from the start of the force; a project is optional', () => {
    expect(validateMember(EMPTY_MEMBER, TODAY, '2026-01-05')).toEqual({ membershipId: 'required', validFrom: 'required' });
    expect(validateMember({ membershipId: ID, role: 'LEAD', projectId: '', validFrom: '2026-01-04' }, TODAY, '2026-01-05')).toEqual({ role: 'invalidRole', validFrom: 'beforeStart' });
    expect(validateMember({ membershipId: ID, role: 'SECRETARY', projectId: ID, validFrom: '2026-01-05' }, TODAY, '2026-01-05')).toEqual({});
    expect(memberBody({ membershipId: ID, role: 'SECRETARY', projectId: ID, validFrom: '2026-01-05' })).toEqual({ membership_id: ID, member_role: 'SECRETARY', valid_from: '2026-01-05', project_id: ID });
    expect(memberBody({ membershipId: ID, role: 'MEMBER', projectId: '', validFrom: '2026-01-05' })).not.toHaveProperty('project_id');
  });

  it('asks a reason to dissolve a task force', () => {
    expect(validateDissolve(EMPTY_DISSOLVE)).toEqual({ reason: 'required' });
    expect(validateDissolve({ reason: 'The target was met' })).toEqual({});
  });
});

describe('describeProblem: what the server refuses', () => {
  const problem = (code: string) => new ApiError({ status: 409, code, correlationId: 'c', extensions: {} });

  it.each([
    ['LEADER_ALREADY_ASSIGNED', 'leaderTaken'],
    ['LEADER_NOT_ELIGIBLE', 'leaderNotEligible'],
    ['STAGE_TRANSITION_DENIED', 'alreadyEnded'],
    ['TASK_FORCE_CODE_DUPLICATE', 'codeTaken'],
    ['MEMBER_OUT_OF_SCOPE', 'outOfScope'],
    ['TASK_FORCE_DISSOLVED', 'dissolved'],
    ['DUPLICATE_KEY', 'memberTaken'],
    ['DECISION_REQUIRED', 'documentInvalid'],
    ['VERSION_CONFLICT', 'versionConflict'],
    ['VALIDATION_FAILED', 'validation'],
    ['INVALID_REQUEST', 'validation'],
    ['RESOURCE_NOT_FOUND', 'notFound'],
    ['SCOPE_DENIED', 'denied'],
    ['SOMETHING_ELSE', 'general'],
  ])('%s is %s', (code, expected) => {
    expect(describeProblem(problem(code))).toBe(expected);
  });

  it('is general for what is not a problem of the server', () => {
    expect(describeProblem(new Error('offline'))).toBe('general');
    expect(describeProblem(undefined)).toBe('general');
  });
});
