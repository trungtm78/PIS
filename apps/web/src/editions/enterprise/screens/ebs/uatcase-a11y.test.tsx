import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../../i18n';
import { describeViolations, seriousViolations } from '../../../../test/axe';
import { EBS_ADMIN, difference, ebsClient, ebsConnection, ebsRoute, mount, uuid } from '../shared/test-support';
import ConnectionScreen from './ConnectionScreen';
import DifferencesScreen from './DifferencesScreen';

const word = (key: string, params: Record<string, string | number> = {}): string => translator.t(key, params);

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

/** The three kinds of difference of the case: one open, one open and past its due day, one that is closed (explained). */
const differences = () => [
  difference(1),
  difference(2, { measure: 'COMMITTED_VND', difference_kind: 'MISSING_OURS', ours: null, delta: null, overdue: true, due_at: '2026-11-01T16:59:59.999Z' }),
  difference(3, { state: 'RESOLVED', resolution: { kind: 'TIMING', resolved_by: uuid(7), resolved_by_name: 'Pham Van Cuong', resolved_at: '2026-11-07T02:00:00.000Z', reason: 'Booked next month', evidence_ref: null, review_on: '2026-12-01' }, delta: '-50', version: 2 }, { may_resolve: false, may_reassign: false }),
];

describe('UAT-EBS-A11-01 the differences of Oracle EBS (EBS-02) and the connection (EBS-01) with data in every state', () => {
  it('UAT-EBS-A11-01 EBS-02 has column headers, says open, overdue and closed in words, and has no serious axe violation', async () => {
    mount(<DifferencesScreen route={ebsRoute('EBS-02')} />, ebsClient({ connection: ebsConnection(), differences: differences() }), { permissions: EBS_ADMIN });
    const table = await screen.findByRole('table', { name: word('ebs.differences.section.title') });
    const headers = within(table).getAllByRole('columnheader').map((header) => header.textContent);
    expect(headers).toEqual(['project', 'period', 'measure', 'ours', 'theirs', 'delta', 'owner', 'due', 'state', 'actions'].map((column) => word(`ebs.differences.column.${column}`)));
    // The list shows the open ones first: the state is a word on each row, and the overdue day is a word beside the due day.
    expect(within(table).getAllByText(word('ebs.difference.state.open'))).toHaveLength(2);
    expect(within(table).getAllByText(word('ebs.differences.overdue.badge'))).toHaveLength(1);
    // The gap has its sign as a character, not only a colour.
    expect(screen.getByTestId(`delta-${uuid(401)}`).textContent).toMatch(/^\+/);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
    // The closed ones are one choice of the state filter away; they say so in words too, and their gap keeps its minus sign.
    fireEvent.change(screen.getByTestId('filter-state'), { target: { value: 'RESOLVED' } });
    const closed = await screen.findByTestId(`delta-${uuid(403)}`);
    expect(closed.textContent).toMatch(/^[-−]/);
    expect(within(screen.getByRole('table')).getAllByText(word('ebs.difference.state.resolved'))).toHaveLength(1);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });

  it('UAT-EBS-A11-01 the explanation dialog opens from the keyboard, holds the focus inside, and gives it back to the button that opened it', async () => {
    mount(<DifferencesScreen route={ebsRoute('EBS-02')} />, ebsClient({ connection: ebsConnection(), differences: differences() }), { permissions: EBS_ADMIN });
    const opener = await screen.findByTestId(`resolve-${uuid(401)}`);
    const user = userEvent.setup();
    opener.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: word('ebs.resolve.dialog.title') });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
    // Tab cycles inside the dialog and never leaves it.
    for (let stop = 0; stop < 12; stop += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('UAT-EBS-A11-01 EBS-01 with a connection that has runs, counts and history has no serious axe violation and its statuses are words', async () => {
    mount(<ConnectionScreen route={ebsRoute('EBS-01')} />, ebsClient({ connection: ebsConnection(), differences: [] }), { permissions: EBS_ADMIN });
    const card = await screen.findByTestId('status-card');
    expect(card.textContent).toContain(word('ebs.status.registry.draft'));
    expect(screen.getAllByText(word('ent.acceptance.pending.badge')).length).toBeGreaterThan(0);
    expect(screen.getByTestId('health-explain').textContent?.length).toBeGreaterThan(0);
    expect(describeViolations(await seriousViolations(document.body))).toEqual([]);
  });

  it('negative control: the axe helper reports an image without a text alternative', async () => {
    document.body.innerHTML = '<main><h1>t</h1><img src="x"></main>';
    expect(describeViolations(await seriousViolations(document.body)).join(' ')).toContain('image-alt');
  });
});
