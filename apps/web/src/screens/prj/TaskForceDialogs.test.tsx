import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { AddMemberDialog, DissolveDialog } from './TaskForceDialogs';
import { toTaskForceLine } from './accountability-model';
import { client, mount, world } from './test-support';

const PERSON = '00000000-0000-4000-8000-0000000000c2';
const PROJECT = '00000000-0000-4000-8000-000000000010';
const FORCE = toTaskForceLine({
  id: '00000000-0000-4000-8000-0000000000f1',
  code: 'TF-01',
  name: 'Tổ công tác 1',
  purpose: 'Đôn đốc giải ngân các dự án chậm',
  lead: { membership_id: '00000000-0000-4000-8000-0000000000c1', display_name: 'Nguyễn Văn An' },
  scope_unit: { id: '00000000-0000-4000-8000-0000000000d1', code: 'U-BQL1', name: 'Ban QLDA 1' },
  establishment_document_id: null,
  valid_from: '2026-01-05',
  valid_until: null,
  status: 'ACTIVE',
  version: 4,
  members: [
    { id: '00000000-0000-4000-8000-0000000000e1', membership_id: '00000000-0000-4000-8000-0000000000c1', display_name: 'Nguyễn Văn An', role: 'LEAD', project: null, valid_from: '2026-01-05', valid_until: null },
    { id: '00000000-0000-4000-8000-0000000000e2', membership_id: PERSON, display_name: 'Trần Thị Bình', role: 'MEMBER', project: null, valid_from: '2026-01-06', valid_until: null },
    { id: '00000000-0000-4000-8000-0000000000e3', membership_id: PERSON, display_name: 'Trần Thị Bình', role: 'MEMBER', project: null, valid_from: '2026-01-06', valid_until: '2026-02-01' },
  ],
})!;
const OK = { operation_id: 'o', status: 'ACTIVE', resource_version: 5, resource_id: FORCE.id };
const problem = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

afterEach(cleanup);

const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

describe('AddMemberDialog (PRJ-18): seating a member', () => {
  const dialog = (command: (operation: string, input: unknown) => unknown = () => OK) => {
    const h = client(world(), command);
    const onClose = vi.fn();
    mount(<AddMemberDialog force={FORCE} members={[{ id: PERSON, label: 'Trần Thị Bình' }]} projects={[{ id: PROJECT, label: 'DA-001 Cầu' }]} onClose={onClose} />, h, { permissions: ['taskforce.manage'] });
    return { h, onClose };
  };
  const submit = (): void => {
    fireEvent.click(screen.getByRole('button', { name: vi_['prj.taskforce.member.submit.action'] }));
  };

  it('UI-PRJ-18: says the scope the member must meet, and asks a member and a day from the start of the force before it sends', () => {
    const { h } = dialog();
    expect(screen.getByText(vi_['prj.taskforce.member.scope.text'].replace('{unit}', 'Ban QLDA 1'))).toBeTruthy();
    submit();
    expect(screen.getAllByText(vi_['prj.accountability.field.required.error'])).toHaveLength(2);
    set(vi_['prj.taskforce.member.person.label'], PERSON);
    set(vi_['prj.taskforce.member.from.label'], '2026-01-04');
    submit();
    expect(screen.getByText(vi_['prj.accountability.field.beforeStart.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('AC-ST-PRJ-005-2: sends the member with the role and the project, and closes', async () => {
    const { h, onClose } = dialog();
    set(vi_['prj.taskforce.member.person.label'], PERSON);
    set(vi_['prj.taskforce.member.role.label'], 'SECRETARY');
    set(vi_['prj.taskforce.member.project.label'], PROJECT);
    set(vi_['prj.taskforce.member.from.label'], '2026-02-01');
    submit();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(h.command).toHaveBeenCalledWith('addTaskForceMember', expect.objectContaining({ path: { id: FORCE.id }, body: { membership_id: PERSON, member_role: 'SECRETARY', valid_from: '2026-02-01', project_id: PROJECT } }));
  });

  it('AC-ST-PRJ-005-2: tells a member outside the scope, a duplicate and a dissolved force, and keeps the dialog open', async () => {
    const cases: Array<[string, number, string]> = [
      ['MEMBER_OUT_OF_SCOPE', 422, 'prj.accountability.problem.outOfScope.error'],
      ['DUPLICATE_KEY', 409, 'prj.accountability.problem.memberTaken.error'],
      ['TASK_FORCE_DISSOLVED', 409, 'prj.accountability.problem.dissolved.error'],
    ];
    for (const [code, status, key] of cases) {
      const { onClose } = dialog(() => problem(code, status));
      set(vi_['prj.taskforce.member.person.label'], PERSON);
      set(vi_['prj.taskforce.member.from.label'], '2026-02-01');
      submit();
      expect((await screen.findByTestId('member-refusal')).textContent).toBe((vi_ as Record<string, string>)[key]);
      expect(onClose).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it('closes with the close button and with cancel', () => {
    const { onClose } = dialog();
    fireEvent.click(screen.getByRole('button', { name: vi_['prj.taskforce.member.cancel.action'] }));
    fireEvent.click(screen.getByRole('button', { name: vi_['prj.taskforce.member.close.label'] }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('DissolveDialog (PRJ-18): dissolving a task force', () => {
  const dialog = (command: (operation: string, input: unknown) => unknown = () => OK) => {
    const h = client(world(), command);
    const onClose = vi.fn();
    mount(<DissolveDialog force={FORCE} onClose={onClose} />, h, { permissions: ['taskforce.manage'] });
    return { h, onClose };
  };
  const submit = (): void => {
    fireEvent.click(screen.getByRole('button', { name: vi_['prj.taskforce.dissolve.submit.action'] }));
  };

  it('AC-ST-PRJ-005-2: says how many open terms end with the force, asks a reason, and dissolves under the version the list showed', async () => {
    const { h, onClose } = dialog();
    expect(screen.getByTestId('dissolve-warning').textContent).toBe(vi_['prj.taskforce.dissolve.warning.text'].replace('{count}', '2'));
    submit();
    expect(screen.getByText(vi_['prj.accountability.field.required.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    set(vi_['prj.taskforce.dissolve.reason.label'], '  The disbursement target was met  ');
    submit();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(h.command).toHaveBeenCalledWith('dissolveTaskForce', expect.objectContaining({ path: { id: FORCE.id }, ifMatchVersion: 4, body: { reason: 'The disbursement target was met' } }));
  });

  it('tells a stale version and a force that is dissolved already, keeps the dialog open, and closes with the buttons', async () => {
    for (const [code, key] of [
      ['VERSION_CONFLICT', 'prj.accountability.problem.versionConflict.error'],
      ['TASK_FORCE_DISSOLVED', 'prj.accountability.problem.dissolved.error'],
    ] as const) {
      const { onClose } = dialog(() => problem(code));
      set(vi_['prj.taskforce.dissolve.reason.label'], 'The disbursement target was met');
      submit();
      expect((await screen.findByTestId('dissolve-refusal')).textContent).toBe((vi_ as Record<string, string>)[key]);
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: vi_['prj.taskforce.dissolve.cancel.action'] }));
      fireEvent.click(screen.getByRole('button', { name: vi_['prj.taskforce.dissolve.close.label'] }));
      expect(onClose).toHaveBeenCalledTimes(2);
      cleanup();
    }
  });
});
