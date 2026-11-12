import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeViolations, seriousViolations } from '../../../test/axe';
import { mount } from '../../sas/test-support';
import { ALL_PERMISSIONS, assignment, refusal, routeOf, serve, taskDetail, text, uuid } from '../test/fixtures';
import AssignmentLedgerScreen from './AssignmentLedgerScreen';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TASK = uuid(1002);
const page = { items: [assignment(1)], next_cursor: null, as_of: '2026-11-12T03:00:00.000Z' };

const open = (path: string, task: unknown = taskDetail({ can_assign: true })) => {
  const h = serve({ getProjectTask: task, listProjectTaskAssignments: page });
  (h.client.readAll as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  mount(<AssignmentLedgerScreen route={routeOf('PWF-16')} />, h, ALL_PERMISSIONS, path);
  return h;
};

describe('PWF-16: the ledger as a screen', () => {
  it('names the task, lists its ledger and offers the form when the server says the caller can assign', async () => {
    const h = open(`/pwf/pwf-16?id=${TASK}`);
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toContain('T2');
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.getByTestId('assign-form')).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('getProjectTask', { path: { task_id: TASK } });
    expect(screen.getByRole('link', { name: text('pwf.ledger.back.link') }).getAttribute('href')).toContain(`/pwf/pwf-04?id=${TASK}`);
    expect(screen.getByText(text('pwf.ledger.footer.reference', { id: 'PWF-16', req: 'FR-PWF-16' }))).toBeTruthy();
  });

  it('has no form when the server says the caller cannot assign', async () => {
    open(`/pwf/pwf-16?id=${TASK}`, taskDetail({ can_assign: false }));
    await screen.findByRole('table');
    expect(screen.queryByTestId('assign-form')).toBeNull();
  });

  it('asks for a task when the address names none', () => {
    open('/pwf/pwf-16');
    expect(screen.getByTestId('no-task').textContent).toBe(text('pwf.ledger.noTask.notice'));
  });

  it('shows the denied state when the task is out of the caller scope', async () => {
    open(`/pwf/pwf-16?id=${TASK}`, refusal('SCOPE_DENIED', 403));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('has no serious accessibility violation', async () => {
    open(`/pwf/pwf-16?id=${TASK}`);
    await screen.findByTestId('assign-form');
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });
});
