import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { seriousViolations, describeViolations } from '../../test/axe';
import { AlertBell } from './AlertBell';
import { alertsBackend, countsAnswer, failure, harness, listAnswer, mount, rawItem } from './test-support';

const list = listAnswer([rawItem('w1')]);

describe('AlertBell', () => {
  it('shows a pending mark, never 0, until the first answer, then the count and the name with the urgent ones', async () => {
    const h = harness(alertsBackend({ mine: { counts: countsAnswer(2, 4, 1), list } }));
    mount(<AlertBell />, h);
    const loading = screen.getByRole('button', { name: 'Đang tải việc cần xử lý' });
    expect(loading).toHaveTextContent('…');
    expect(loading).not.toHaveTextContent('0');
    const bell = await screen.findByRole('button', { name: '7 việc cần xử lý, 2 khẩn' });
    expect(bell).toHaveTextContent('Cần xử lý');
    expect(bell).toHaveTextContent('7');
    expect(bell).toHaveTextContent('2 khẩn');
    expect(bell).toHaveAttribute('data-urgent', 'true');
    expect(bell).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('shows no red count when nothing is urgent', async () => {
    const h = harness(alertsBackend({ mine: { counts: countsAnswer(0, 3, 0), list } }));
    mount(<AlertBell />, h);
    const bell = await screen.findByRole('button', { name: '3 việc cần xử lý' });
    expect(bell).toHaveAttribute('data-urgent', 'false');
    expect(bell).not.toHaveTextContent('khẩn');
  });

  it('says plainly when nothing waits', async () => {
    const h = harness(alertsBackend({ mine: { counts: countsAnswer(0, 0, 0), list: listAnswer([]) } }));
    mount(<AlertBell />, h);
    expect(await screen.findByRole('button', { name: 'Không có việc cần xử lý' })).toHaveTextContent('0');
  });

  it('says it could not read, with a warning dot, instead of showing 0', async () => {
    const h = harness(() => failure(503));
    mount(<AlertBell />, h);
    const bell = await screen.findByRole('button', { name: 'Không đọc được việc cần xử lý' });
    expect(bell).toHaveTextContent('!');
    expect(screen.getByTestId('alert-bell-warning')).toBeInTheDocument();
  });

  it('marks a source that could not be read with a warning dot and in its name', async () => {
    const h = harness(alertsBackend({ mine: { counts: countsAnswer(1, 0, 0, { unavailable_sources: ['PERMIT'] }), list } }));
    mount(<AlertBell />, h);
    expect(await screen.findByRole('button', { name: '1 việc cần xử lý, 1 khẩn, một nguồn chưa đọc được' })).toBeInTheDocument();
    expect(screen.getByTestId('alert-bell-warning')).toBeInTheDocument();
  });

  it('keeps the last count and says it is old when a refresh fails', async () => {
    let fail = false;
    const backend = alertsBackend({ mine: { counts: countsAnswer(0, 2, 0), list } });
    const h = harness((operation, input) => (fail ? failure(503) : backend(operation, input)));
    const view = mount(<AlertBell />, h);
    await screen.findByRole('button', { name: '2 việc cần xử lý' });
    fail = true;
    await view.queries.refetchQueries({ queryKey: ['alerts'] });
    expect(await screen.findByRole('button', { name: '2 việc cần xử lý, số liệu cũ' })).toBeInTheDocument();
    expect(screen.getByTestId('alert-bell-warning')).toBeInTheDocument();
  });

  it('does not read the list until the drawer is opened, opens it by a click and gives the focus back on Escape', async () => {
    const user = userEvent.setup();
    const h = harness(alertsBackend({ mine: { counts: countsAnswer(1, 0, 0), list }, scope: { counts: countsAnswer(0, 0, 0, { view: 'scope' }), list: listAnswer([], { view: 'scope' }) } }));
    mount(<AlertBell />, h);
    const bell = await screen.findByRole('button', { name: '1 việc cần xử lý, 1 khẩn' });
    expect(h.read.mock.calls.filter(([operation]) => operation === 'getMyWork')).toHaveLength(0);
    await user.click(bell);
    const drawer = await screen.findByRole('dialog', { name: 'Cần xử lý ngay' });
    expect(drawer).toBeInTheDocument();
    expect(bell).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'getMyWork')).toHaveLength(1));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bell).toHaveFocus();
  });

  it('has no serious accessibility violation', async () => {
    const h = harness(alertsBackend({ mine: { counts: countsAnswer(1, 1, 0), list } }));
    const { container } = mount(<AlertBell />, h);
    await screen.findByRole('button', { name: '2 việc cần xử lý, 1 khẩn' });
    expect(describeViolations(await seriousViolations(container))).toEqual([]);
  });
});
