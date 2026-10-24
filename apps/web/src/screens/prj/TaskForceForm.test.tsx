import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { TaskForceForm } from './TaskForceForm';
import { client, mount, world } from './test-support';

const LEAD = '00000000-0000-4000-8000-0000000000c1';
const UNIT = '00000000-0000-4000-8000-0000000000d1';
const DOCUMENT = '00000000-0000-4000-8000-000000000900';
const OK = { operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: 'f' };
const problem = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

afterEach(cleanup);

const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const fill = (extra: Record<string, string> = {}): void => {
  const values: Record<string, string> = {
    [vi_['prj.taskforce.create.code.label']]: ' TF-01 ',
    [vi_['prj.taskforce.create.name.label']]: 'Tổ công tác giải ngân',
    [vi_['prj.taskforce.create.purpose.label']]: 'Đôn đốc giải ngân các dự án chậm',
    [vi_['prj.taskforce.create.lead.label']]: LEAD,
    [vi_['prj.taskforce.create.scope.label']]: UNIT,
    [vi_['prj.taskforce.create.from.label']]: '2026-01-05',
    ...extra,
  };
  for (const [label, value] of Object.entries(values)) set(label, value);
};
const submit = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['prj.taskforce.create.submit.action'] }));
};
const form = (command: (operation: string, input: unknown) => unknown = () => OK) => {
  const h = client(world(), command);
  mount(<TaskForceForm members={[{ id: LEAD, label: 'Nguyễn Văn An' }]} units={[{ id: UNIT, label: 'U-BQL1 Ban QLDA 1' }]} />, h, { permissions: ['taskforce.manage'] });
  return h;
};

describe('TaskForceForm (PRJ-18): founding a task force', () => {
  it('UI-PRJ-18: names the fields that are missing and sends nothing until the form is right', () => {
    const h = form();
    submit();
    expect(screen.getAllByText(vi_['prj.accountability.field.required.error'])).toHaveLength(6);
    fill({ [vi_['prj.taskforce.create.name.label']]: 'ab', [vi_['prj.taskforce.create.document.label']]: 'nope' });
    submit();
    expect(screen.getByText(vi_['prj.accountability.field.tooShort.error'])).toBeTruthy();
    expect(screen.getByText(vi_['prj.accountability.field.invalidId.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('AC-ST-PRJ-005-2: sends the code trimmed with the lead, the unit and the document in lower case, then clears the form and says so', async () => {
    const h = form();
    fill({ [vi_['prj.taskforce.create.document.label']]: DOCUMENT.toUpperCase() });
    submit();
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'createTaskForce',
        expect.objectContaining({
          body: {
            code: 'TF-01',
            name: 'Tổ công tác giải ngân',
            purpose: 'Đôn đốc giải ngân các dự án chậm',
            lead_membership_id: LEAD,
            scope_unit_id: UNIT,
            valid_from: '2026-01-05',
            establishment_document_id: DOCUMENT,
          },
        }),
      ),
    );
    expect((await screen.findByTestId('create-saved')).textContent).toBe(vi_['prj.taskforce.create.saved.notice']);
    expect((screen.getByLabelText(vi_['prj.taskforce.create.code.label']) as HTMLInputElement).value).toBe('');
    set(vi_['prj.taskforce.create.code.label'], 'TF-02');
    expect(screen.queryByTestId('create-saved')).toBeNull();
  });

  it('AC-ST-PRJ-005-2: tells why the server refused: a code in use, a lead outside the scope, a missing right', async () => {
    const cases: Array<[string, number, string]> = [
      ['TASK_FORCE_CODE_DUPLICATE', 409, 'prj.accountability.problem.codeTaken.error'],
      ['MEMBER_OUT_OF_SCOPE', 422, 'prj.accountability.problem.outOfScope.error'],
      ['SCOPE_DENIED', 403, 'prj.accountability.problem.denied.error'],
    ];
    for (const [code, status, key] of cases) {
      form(() => problem(code, status));
      fill();
      submit();
      expect((await screen.findByTestId('create-refusal')).textContent).toBe((vi_ as Record<string, string>)[key]);
      cleanup();
    }
  });
});
