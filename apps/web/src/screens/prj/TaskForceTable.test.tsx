import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { TaskForceTable } from './TaskForceTable';
import { toTaskForceLine } from './accountability-model';

const force = (n: number, overrides: Record<string, unknown> = {}) =>
  toTaskForceLine({
    id: `00000000-0000-4000-8000-0000000000f${n}`,
    code: `TF-0${n}`,
    name: `Tổ công tác ${n}`,
    purpose: 'Đôn đốc giải ngân các dự án chậm',
    lead: { membership_id: '00000000-0000-4000-8000-0000000000c1', display_name: n === 2 ? null : 'Nguyễn Văn An' },
    scope_unit: { id: '00000000-0000-4000-8000-0000000000d1', code: 'U-BQL1', name: 'Ban QLDA 1' },
    establishment_document_id: n === 1 ? '00000000-0000-4000-8000-000000000900' : null,
    valid_from: '2026-01-05',
    valid_until: null,
    status: 'ACTIVE',
    version: 2,
    members: [
      { id: '00000000-0000-4000-8000-0000000000e1', membership_id: '00000000-0000-4000-8000-0000000000c1', display_name: 'Nguyễn Văn An', role: 'LEAD', project: null, valid_from: '2026-01-05', valid_until: null },
      { id: '00000000-0000-4000-8000-0000000000e2', membership_id: '00000000-0000-4000-8000-0000000000c2', display_name: null, role: 'SECRETARY', project: { id: 'p', code: 'DA-001', name: 'Cầu' }, valid_from: '2026-01-06', valid_until: '2026-03-01' },
    ],
    ...overrides,
  })!;

afterEach(cleanup);

describe('TaskForceTable (PRJ-18): the task forces', () => {
  it('UI-PRJ-18: shows each force with its scope unit, its lead, its period and its terms with the project each follows, the ended terms marked', () => {
    render(<TaskForceTable forces={[force(1), force(2, { status: 'DISSOLVED', valid_until: '2026-04-01' })]} canManage={false} onAddMember={vi.fn()} onDissolve={vi.fn()} />);
    const first = within(document.querySelector('[data-force-id$="f1"]') as HTMLElement);
    expect(first.getByRole('heading').textContent).toBe('TF-01 · Tổ công tác 1');
    expect(first.getByText('Ban QLDA 1')).toBeTruthy();
    expect(first.getByText('Nguyễn Văn An', { selector: 'dd' })).toBeTruthy();
    expect(first.getByText('00000000-0000-4000-8000-000000000900')).toBeTruthy();
    expect(first.getByText(vi_['prj.taskforce.status.active.label'])).toBeTruthy();
    const terms = Array.from(document.querySelectorAll('[data-force-id$="f1"] [data-member-id]')).map((tr) => [tr.getAttribute('data-ended'), ...Array.from(tr.querySelectorAll('th, td')).map((cell) => cell.textContent)]);
    expect(terms).toEqual([
      ['false', 'Nguyễn Văn An', vi_['prj.taskforce.memberRole.lead.label'], vi_['prj.taskforce.members.project.none'], `2026-01-05 → ${vi_['prj.taskforce.card.period.open']}`],
      ['true', vi_['prj.taskforce.members.unknown'], vi_['prj.taskforce.memberRole.secretary.label'], 'DA-001 Cầu', '2026-01-06 → 2026-03-01'],
    ]);
    const dissolved = within(document.querySelector('[data-force-id$="f2"]') as HTMLElement);
    expect(dissolved.getByText(vi_['prj.taskforce.status.dissolved.label'])).toBeTruthy();
    expect(dissolved.getByText(vi_['prj.taskforce.card.lead.unknown'], { selector: 'dd' })).toBeTruthy();
    expect(dissolved.getByText(vi_['prj.taskforce.card.document.none'])).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('offers to add a member and to dissolve only a force in force, and only to someone who may', () => {
    const onAdd = vi.fn();
    const onDissolve = vi.fn();
    const forces = [force(1), force(2, { status: 'DISSOLVED', valid_until: '2026-04-01' })];
    render(<TaskForceTable forces={forces} canManage={true} onAddMember={onAdd} onDissolve={onDissolve} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([vi_['prj.taskforce.member.action'].replace('{code}', 'TF-01'), vi_['prj.taskforce.dissolve.action'].replace('{code}', 'TF-01')]);
    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);
    expect(onAdd).toHaveBeenCalledWith(forces[0]);
    expect(onDissolve).toHaveBeenCalledWith(forces[0]);
  });

  it('says there is nothing when there is no task force', () => {
    render(<TaskForceTable forces={[]} canManage={true} onAddMember={vi.fn()} onDissolve={vi.fn()} />);
    expect(screen.getByTestId('forces-empty').textContent).toBe(vi_['prj.taskforce.list.empty.notice']);
  });
});
