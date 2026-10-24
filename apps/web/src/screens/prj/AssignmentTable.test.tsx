import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { AssignmentTable } from './AssignmentTable';
import { toAssignmentLine } from './accountability-model';

const row = (n: number, overrides: Record<string, unknown> = {}) =>
  toAssignmentLine({
    id: `00000000-0000-4000-8000-0000000000a${n}`,
    project_id: '00000000-0000-4000-8000-000000000010',
    project_code: `DA-00${n}`,
    project_name: `Dự án ${n}`,
    leader: { membership_id: '00000000-0000-4000-8000-0000000000c1', display_name: n === 3 ? null : 'Nguyễn Văn An' },
    accountability_role: 'LEADER_IN_CHARGE',
    assignment_document_id: n === 1 ? '00000000-0000-4000-8000-000000000900' : null,
    valid_from: '2026-01-05',
    valid_until: null,
    status: 'ACTIVE',
    end_reason: null,
    version: 1,
    ...overrides,
  })!;

afterEach(cleanup);

describe('AssignmentTable (PRJ-17): the register of assignments', () => {
  it('UI-PRJ-17: shows the leader, the role, the document and the period of each assignment, the ended ones with their reason, and a state in words', () => {
    const lines = [row(1), row(2, { status: 'ENDED', valid_until: '2026-03-01', end_reason: 'Moved to the ministry', accountability_role: 'DEPUTY_LEADER' }), row(3)];
    render(<AssignmentTable lines={lines} canEnd={false} onEnd={vi.fn()} />);
    const cells = (n: number) => Array.from(document.querySelector(`[data-assignment-id$="a${n}"]`)?.querySelectorAll('th, td') ?? []).map((cell) => cell.textContent);
    expect(cells(1)).toEqual(['DA-001 Dự án 1', 'Nguyễn Văn An', vi_['prj.accountability.role.leader.label'], '00000000-0000-4000-8000-000000000900', `2026-01-05 → ${vi_['prj.accountability.validity.open']}`, vi_['prj.accountability.status.active.label'], '']);
    expect(cells(2)[2]).toBe(vi_['prj.accountability.role.deputy.label']);
    expect(cells(2)[4]).toBe(`2026-01-05 → 2026-03-01 ${vi_['prj.accountability.end.reason.text'].replace('{reason}', 'Moved to the ministry')}`);
    expect(cells(2)[5]).toBe(vi_['prj.accountability.status.ended.label']);
    expect(cells(3)[1]).toBe(vi_['prj.accountability.leader.unknown']);
    expect(cells(3)[3]).toBe(vi_['prj.accountability.document.none']);
  });

  it('offers to end only an assignment in force, and only to someone who may', () => {
    const lines = [row(1), row(2, { status: 'ENDED', valid_until: '2026-03-01', end_reason: 'Moved' })];
    const onEnd = vi.fn();
    render(<AssignmentTable lines={lines} canEnd={true} onEnd={onEnd} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe(vi_['prj.accountability.end.action'].replace('{project}', 'DA-001'));
    fireEvent.click(buttons[0]!);
    expect(onEnd).toHaveBeenCalledWith(lines[0]);
    cleanup();
    render(<AssignmentTable lines={lines} canEnd={false} onEnd={onEnd} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(within(screen.getByTestId('assignments')).getAllByRole('row')).toHaveLength(3);
  });

  it('says there is nothing when the register is empty', () => {
    render(<AssignmentTable lines={[]} canEnd={true} onEnd={vi.fn()} />);
    expect(screen.getByTestId('assignments-empty').textContent).toBe(vi_['prj.accountability.table.empty.notice']);
  });
});
