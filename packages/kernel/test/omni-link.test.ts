import { assertConversion, assertResourceLink, conversionOperationId, issueDescriptionOf } from '../src/omni-link';

const refusal = (run: () => unknown): { code: string; detail: string | undefined; status: number } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string; status: number };
    return { code: known.code, detail: known.detail, status: known.status };
  }
  throw new Error('it was allowed');
};
const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const CONVERSATION = '00000000-0000-4000-8000-0000000000c1';

describe('what a conversation is linked to, and the issue it becomes (ST-OMNI-007, OMNI.md 3.4)', () => {
  it('takes a link to a project, an issue or a contract by the id of the record', () => {
    for (const resource_type of ['project', 'issue', 'contract']) expect(assertResourceLink({ resource_type, resource_id: PROJECT.toUpperCase() })).toEqual({ resourceType: resource_type, resourceId: PROJECT });
    expect(refusal(() => assertResourceLink({ resource_type: 'document', resource_id: PROJECT }))).toEqual({ code: 'VALIDATION_FAILED', detail: 'resource_type', status: 422 });
    expect(refusal(() => assertResourceLink({ resource_type: 'project', resource_id: 'x' })).detail).toBe('resource_id');
    expect(refusal(() => assertResourceLink({})).detail).toBe('resource_type');
  });

  it('takes a conversion with a project, the code of the category of the issue and a summary of up to 500 characters', () => {
    expect(assertConversion({ project_id: PROJECT.toUpperCase(), issue_type: ' ROAD_DAMAGE ', summary: '  Người dân báo hư hỏng đường  ' })).toEqual({ projectId: PROJECT, issueType: 'ROAD_DAMAGE', summary: 'Người dân báo hư hỏng đường' });
    expect(assertConversion({ project_id: PROJECT, issue_type: 'X', summary: 'x'.repeat(500) }).summary).toHaveLength(500);
    expect(refusal(() => assertConversion({ issue_type: 'X', summary: 'x' })).detail).toBe('project_id');
    for (const issue_type of [undefined, '', '   ', 3, 'x'.repeat(61)]) expect(refusal(() => assertConversion({ project_id: PROJECT, issue_type, summary: 'x' })).detail).toBe('issue_type');
    for (const summary of [undefined, '', '   ', 3, 'x'.repeat(501)]) expect(refusal(() => assertConversion({ project_id: PROJECT, issue_type: 'X', summary })).detail).toBe('summary');
  });

  it('refuses a date or a person, which the issue takes from its policy and its own assignment, instead of ignoring them', () => {
    expect(refusal(() => assertConversion({ project_id: PROJECT, issue_type: 'X', summary: 'x', due_date: '2026-11-30' })).detail).toBe('due_date');
    expect(refusal(() => assertConversion({ project_id: PROJECT, issue_type: 'X', summary: 'x', assignee_membership_id: PROJECT })).detail).toBe('assignee_membership_id');
  });

  it('gives the same operation id to the same conversation at the same version, and another to another version or conversation', () => {
    const first = conversionOperationId(CONVERSATION, 3);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(conversionOperationId(CONVERSATION, 3)).toBe(first);
    expect(conversionOperationId(CONVERSATION, 4)).not.toBe(first);
    expect(conversionOperationId(PROJECT, 3)).not.toBe(first);
  });

  it('writes the description of the issue as the summary and the address of the conversation, with none of the words of the person', () => {
    expect(issueDescriptionOf('Báo hư hỏng đường', CONVERSATION)).toBe(`Báo hư hỏng đường\n\n/omni/omni-02?id=${CONVERSATION}`);
  });
});
