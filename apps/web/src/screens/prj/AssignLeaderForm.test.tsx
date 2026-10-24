import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { AssignLeaderForm } from './AssignLeaderForm';
import { client, mount, world } from './test-support';

const PROJECT = '00000000-0000-4000-8000-000000000010';
const LEADER = '00000000-0000-4000-8000-0000000000c1';
const DOCUMENT = '00000000-0000-4000-8000-000000000900';
const PROJECTS = [{ id: PROJECT, label: 'DA-001 Cầu Thủ Thiêm 4' }];
const MEMBERS = [{ id: LEADER, label: 'Nguyễn Văn An' }];
const OK = { operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: 'a' };
const problem = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

afterEach(cleanup);

const pick = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const fill = (extra: Record<string, string> = {}): void => {
  const values: Record<string, string> = {
    [vi_['prj.accountability.assign.project.label']]: PROJECT,
    [vi_['prj.accountability.assign.leader.label']]: LEADER,
    [vi_['prj.accountability.assign.from.label']]: '2026-01-05',
    ...extra,
  };
  for (const [label, value] of Object.entries(values)) pick(label, value);
};
const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['prj.accountability.assign.submit.action'] }));
};
const form = (command: (operation: string, input: unknown) => unknown = () => OK) => {
  const h = client(world(), command);
  mount(<AssignLeaderForm projects={PROJECTS} members={MEMBERS} />, h, { permissions: ['project.accountability.assign'] });
  return h;
};

describe('AssignLeaderForm (PRJ-17): the assignment of a leader in charge', () => {
  it('AC-ST-PRJ-005-1, UI-PRJ-17: names the fields that are missing and sends nothing until the form is right', () => {
    const h = form();
    submit();
    expect(screen.getAllByText(vi_['prj.accountability.field.required.error'])).toHaveLength(3);
    fill({ [vi_['prj.accountability.assign.from.label']]: '2999-01-01', [vi_['prj.accountability.assign.document.label']]: 'nope' });
    submit();
    expect(screen.getByText(vi_['prj.accountability.field.future.error'])).toBeTruthy();
    expect(screen.getByText(vi_['prj.accountability.field.invalidId.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('AC-ST-PRJ-005-1: sends the assignment for the project with the role, the day and the document in lower case, then clears the form and says so', async () => {
    const h = form();
    fill({ [vi_['prj.accountability.assign.role.label']]: 'DEPUTY_LEADER', [vi_['prj.accountability.assign.document.label']]: DOCUMENT.toUpperCase() });
    submit();
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'assignProjectLeader',
        expect.objectContaining({ path: { id: PROJECT }, body: { leader_membership_id: LEADER, accountability_role: 'DEPUTY_LEADER', valid_from: '2026-01-05', assignment_document_id: DOCUMENT } }),
      ),
    );
    expect((await screen.findByTestId('assign-saved')).textContent).toBe(vi_['prj.accountability.assign.saved.notice']);
    expect((screen.getByLabelText(vi_['prj.accountability.assign.project.label']) as HTMLSelectElement).value).toBe('');
    // A new change takes the notice away.
    pick(vi_['prj.accountability.assign.document.label'], 'x');
    expect(screen.queryByTestId('assign-saved')).toBeNull();
  });

  it('AC-ST-PRJ-005-1: tells why the server refused: a second leader in charge, a person who cannot read the project, a stale document, a missing right', async () => {
    const cases: Array<[string, string]> = [
      ['LEADER_ALREADY_ASSIGNED', 'prj.accountability.problem.leaderTaken.error'],
      ['LEADER_NOT_ELIGIBLE', 'prj.accountability.problem.leaderNotEligible.error'],
      ['DECISION_REQUIRED', 'prj.accountability.problem.documentInvalid.error'],
      ['SCOPE_DENIED', 'prj.accountability.problem.denied.error'],
    ];
    for (const [code, key] of cases) {
      form(() => problem(code, code === 'SCOPE_DENIED' ? 403 : 409));
      fill();
      submit();
      expect((await screen.findByTestId('assign-refusal')).textContent).toBe((vi_ as Record<string, string>)[key]);
      cleanup();
    }
  });
});
