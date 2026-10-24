import { describe, expect, it } from 'vitest';
import { acceptStateOf, countByLevel, filterBreaches, offeredLevels, toBreach } from './escalation-model';
import type { BreachView } from './escalation-model';
import { toEscalation, toIssueView } from './issue-model';
import { breach, detail } from './test-support';

const view = (n: number, overrides: Record<string, unknown> = {}): BreachView => toBreach(breach(n, overrides)) as BreachView;

describe('the readers of the escalations (ST-ISS-004)', () => {
  it('reads a line of the board with its unit, its task force and who accepted it', () => {
    expect(view(1)).toMatchObject({ level: 2, trigger: 'SLA_AUTO', status: 'OPEN', targetUnit: { name: 'Ủy ban nhân dân 1' }, taskForce: null, acceptable: false, overdueDays: 3, issueTitle: 'Chậm bàn giao mặt bằng số 1' });
    const third = view(2, {
      level: 3,
      trigger: 'MANUAL',
      target_unit: null,
      task_force: { id: 'tf-1', code: 'TF-A-01', name: 'Tổ công tác A' },
      status: 'ACCEPTED',
      accepted_by: { membership_id: 'm-1' },
      accepted_at: '2026-10-21T02:00:00.000Z',
      acceptable: true,
      issue_title: null,
      overdue_since: null,
      overdue_days: null,
    });
    expect(third).toMatchObject({ level: 3, trigger: 'MANUAL', targetUnit: null, taskForce: { code: 'TF-A-01' }, acceptedBy: { id: 'm-1' }, acceptable: true, issueTitle: null, overdueSince: null, overdueDays: null });
  });

  it('leaves out a line it cannot trust', () => {
    for (const broken of [null, 'x', { ...breach(1), escalation_id: undefined }, { ...breach(1), level: 4 }, { ...breach(1), status: 'DONE' }, { ...breach(1), severity: 'URGENT' }, { ...breach(1), accept_due_at: undefined }, { ...breach(1), issue_status: 'GONE' }]) {
      expect(toBreach(broken)).toBeUndefined();
    }
  });

  it('says where an escalation stands against the time its receiver has to accept it', () => {
    const now = new Date('2026-10-24T01:00:00.000Z');
    expect(acceptStateOf({ status: 'ACCEPTED', acceptDueAt: '2020-01-01T00:00:00.000Z' }, now)).toBe('accepted');
    expect(acceptStateOf({ status: 'OPEN', acceptDueAt: '2026-10-24T00:59:00.000Z' }, now)).toBe('late');
    expect(acceptStateOf({ status: 'OPEN', acceptDueAt: '2026-10-24T01:01:00.000Z' }, now)).toBe('waiting');
  });

  it('narrows the board by level and counts the levels', () => {
    const lines = [view(1, { level: 2 }), view(2, { level: 3 }), view(3, { level: 2 })];
    expect(filterBreaches(lines, '').length).toBe(3);
    expect(filterBreaches(lines, '2').map((line) => line.level)).toEqual([2, 2]);
    expect(filterBreaches(lines, '1')).toEqual([]);
    expect(countByLevel(lines)).toEqual({ 1: 0, 2: 2, 3: 1 });
  });

  it('offers the levels above the one reached, and the task force only when one answers for the issue', () => {
    const force = { id: 'tf', code: 'TF', name: 'Task force' };
    expect(offeredLevels(0, force)).toEqual([1, 2, 3]);
    expect(offeredLevels(0, null)).toEqual([1, 2]);
    expect(offeredLevels(2, force)).toEqual([3]);
    expect(offeredLevels(2, null)).toEqual([]);
    expect(offeredLevels(3, force)).toEqual([]);
  });

  it('reads the escalations and the task force of the workspace', () => {
    const view_ = toIssueView(
      detail(1, {
        escalations: [
          { id: 'e1', level: 2, trigger: 'SLA_AUTO', status: 'OPEN', target_unit: { id: 'u1', name: 'Unit 1' }, task_force: null, reason: 'SLA_L2_THRESHOLD_REACHED', accept_due_at: '2026-10-21T02:00:00.000Z', accepted_by: null, accepted_at: null, created_at: '2026-10-20T02:00:00.000Z' },
          { id: 'bad', level: 9 },
        ],
        active_task_force: { id: 'tf1', code: 'TF-1', name: 'Task force' },
      }),
    );
    expect(view_?.escalations).toHaveLength(1);
    expect(view_?.escalations[0]).toMatchObject({ level: 2, targetUnit: { name: 'Unit 1' }, taskForce: null, reason: 'SLA_L2_THRESHOLD_REACHED', acceptedBy: null });
    expect(view_?.activeTaskForce).toEqual({ id: 'tf1', code: 'TF-1', name: 'Task force' });
    expect(toIssueView(detail(2, { escalations: undefined, active_task_force: { id: 'x' } }))).toMatchObject({ escalations: [], activeTaskForce: null });
    expect(toEscalation({ id: 'e', level: 3, trigger: 'MANUAL', status: 'ACCEPTED', task_force: { id: 't', code: 'TF' }, target_unit: { id: 'u' }, accept_due_at: 'a', created_at: 'c', accepted_by: { membership_id: 'm' }, accepted_at: 'x' })).toMatchObject({
      taskForce: { name: 'TF' },
      targetUnit: { id: 'u', name: '' },
      acceptedBy: { id: 'm' },
    });
  });
});
