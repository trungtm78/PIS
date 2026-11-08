import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { feed, workspace } from '../../screens/ban/test/support';
import { CommitteeCard } from './CommitteeCard';
import { mountPwa, pwaClient, word } from './test-support';

afterEach(cleanup);

const READER = ['committee.read'];

function open(answer: () => unknown, permissions: readonly string[] | undefined = READER) {
  const h = pwaClient({ read: (operation) => (operation === 'getCommitteeWorkspace' ? answer() : new Error(`unexpected read ${operation}`)) });
  mountPwa(<CommitteeCard />, h, { permissions });
  return h;
}

describe('CommitteeCard (PWA dashboard)', () => {
  it('shows the four figures of the head, each with its "i", with the day of the figures and the way to the full workspace', async () => {
    const h = open(() => workspace());
    const card = await screen.findByTestId('pwa-committee');
    await waitFor(() => expect(within(card).getByTestId('figure-COMMITTEE_DISBURSEMENT_RATE')).toBeTruthy());
    for (const code of ['COMMITTEE_DISBURSEMENT_RATE', 'COMMITTEE_GAP_VS_CURVE', 'COMMITTEE_ATTENTION_PROJECTS', 'COMMITTEE_DIRECTIVES_OVERDUE']) {
      const tile = within(card).getByTestId(`figure-${code}`);
      expect(within(tile).getByRole('button', { name: word('govc.home.info.open', { name: `Chỉ tiêu ${code}` }) })).toBeTruthy();
    }
    expect(within(card).queryByTestId('figure-COMMITTEE_PLAN_TOTAL')).toBeNull();
    expect(within(card).getByTestId('figure-COMMITTEE_GAP_VS_CURVE').textContent).toContain('-4,00');
    expect(within(card).getByTestId('figure-COMMITTEE_ATTENTION_PROJECTS').textContent).toContain('3');
    expect(within(card).getByTestId('figure-COMMITTEE_DIRECTIVES_OVERDUE').textContent).toContain('2');
    expect(within(card).getByText(word('ban.pwa.card.asOf', { day: '08/11/2026' }))).toBeTruthy();
    expect(screen.getByTestId('pwa-committee-link').getAttribute('href')).toBe('/ban/ban-01');
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledWith('getCommitteeWorkspace', { query: {} });
  });

  it('opens the formula, the source and the day of a figure', async () => {
    open(() => workspace());
    const tile = await screen.findByTestId('figure-COMMITTEE_DISBURSEMENT_RATE');
    fireEvent.click(within(tile).getByRole('button', { name: word('govc.home.info.open', { name: 'Chỉ tiêu COMMITTEE_DISBURSEMENT_RATE' }) }));
    const panel = await screen.findByRole('dialog');
    expect(panel.textContent).toContain('Lõi dữ liệu đầu tư công');
    expect(panel.textContent).toContain('08/11/2026');
  });

  it('says nothing has been loaded when the core is empty, and shows no figure as 0', async () => {
    open(() => workspace({ feed: feed({ empty: true }), figures: [] }));
    expect(await screen.findByText(word('ban.pwa.card.noFeed'))).toBeTruthy();
    expect(screen.queryByTestId('figure-COMMITTEE_DISBURSEMENT_RATE')).toBeNull();
  });

  it('is a skeleton with no number while it is read, and a failure says so and retries in place', async () => {
    open(() => new Promise(() => undefined));
    const status = screen.getByRole('status', { name: word('ban.pwa.card.loading') });
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.textContent).not.toMatch(/\d/);
    cleanup();
    let failing = true;
    const h = open(() => (failing ? new Error('down') : workspace()));
    expect((await screen.findByRole('alert')).textContent).toContain(word('ban.pwa.card.error'));
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: word('ui.common.retry') }));
    expect(await screen.findByTestId('figure-COMMITTEE_DISBURSEMENT_RATE')).toBeTruthy();
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it('says the scope is hidden by the server and, without the right, does not even ask', async () => {
    open(() => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }));
    expect((await screen.findByTestId('pwa-committee-denied')).textContent).toBe(word('ban.pwa.card.denied'));
    cleanup();
    const h = open(() => workspace(), ['home.read']);
    expect(screen.getByTestId('pwa-committee-denied').textContent).toBe(word('ban.pwa.card.denied'));
    expect(h.read).not.toHaveBeenCalled();
  });
});
