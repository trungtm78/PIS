import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { EndAssignmentDialog } from './EndAssignmentDialog';
import { toAssignmentLine } from './accountability-model';
import { client, mount, world } from './test-support';

const LINE = toAssignmentLine({
  id: '00000000-0000-4000-8000-0000000000a1',
  project_id: '00000000-0000-4000-8000-000000000010',
  project_code: 'DA-001',
  project_name: 'Cầu Thủ Thiêm 4',
  leader: { membership_id: '00000000-0000-4000-8000-0000000000c1', display_name: 'Nguyễn Văn An' },
  accountability_role: 'LEADER_IN_CHARGE',
  assignment_document_id: null,
  valid_from: '2026-01-05',
  valid_until: null,
  status: 'ACTIVE',
  end_reason: null,
  version: 3,
})!;
const OK = { operation_id: 'o', status: 'ENDED', resource_version: 4, resource_id: LINE.id };

afterEach(cleanup);

const dialog = (command: (operation: string, input: unknown) => unknown = () => OK) => {
  const h = client(world(), command);
  const onClose = vi.fn();
  mount(<EndAssignmentDialog line={LINE} onClose={onClose} />, h, { permissions: ['project.accountability.assign'] });
  return { h, onClose };
};
const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['prj.accountability.end.submit.action'] }));
};

describe('EndAssignmentDialog (PRJ-17): ending an assignment', () => {
  it('UI-PRJ-17: says whose assignment it is, and asks a day from the start to today and a reason before it sends', () => {
    const { h } = dialog();
    expect(screen.getByTestId('end-current').textContent).toBe(vi_['prj.accountability.end.current.text'].replace('{leader}', 'Nguyễn Văn An').replace('{from}', '2026-01-05'));
    submit();
    expect(screen.getAllByText(vi_['prj.accountability.field.required.error'])).toHaveLength(2);
    set(vi_['prj.accountability.end.until.label'], '2026-01-04');
    set(vi_['prj.accountability.end.reason.label'], 'no');
    submit();
    expect(screen.getByText(vi_['prj.accountability.field.beforeStart.error'])).toBeTruthy();
    expect(screen.getByText(vi_['prj.accountability.field.tooShort.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('AC-ST-PRJ-005-1: ends the assignment under the version the register showed and closes', async () => {
    const { h, onClose } = dialog();
    set(vi_['prj.accountability.end.until.label'], '2026-02-01');
    set(vi_['prj.accountability.end.reason.label'], '  Reassigned to another leader  ');
    submit();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(h.command).toHaveBeenCalledWith('endProjectLeaderAssignment', expect.objectContaining({ path: { id: LINE.id }, ifMatchVersion: 3, body: { valid_until: '2026-02-01', end_reason: 'Reassigned to another leader' } }));
  });

  it('tells a refusal of the server and keeps the dialog open; the close button and cancel leave it', async () => {
    const { onClose } = dialog(() => new ApiError({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'c', extensions: {} }));
    set(vi_['prj.accountability.end.until.label'], '2026-02-01');
    set(vi_['prj.accountability.end.reason.label'], 'Reassigned to another leader');
    submit();
    expect((await screen.findByTestId('end-refusal')).textContent).toBe(vi_['prj.accountability.problem.versionConflict.error']);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: vi_['prj.accountability.end.cancel.action'] }));
    fireEvent.click(screen.getByRole('button', { name: vi_['prj.accountability.end.close.label'] }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
