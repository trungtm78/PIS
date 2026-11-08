import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../../i18n';
import { AS_OF, clientFor, id, logEntry, mount, problem, routeFor } from '../test-support';
import AccessLogScreen from './AccessLogScreen';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const route = routeFor('INT-05', 'FR-INT-05');
const page = (items: unknown[], over: Record<string, unknown> = {}) => ({ items, next_cursor: null, outcomes: ['OK', 'DENIED_CLIENT', 'DENIED_SCOPE', 'DENIED_DATASET', 'RATE_LIMITED', 'INVALID_REQUEST'], as_of: AS_OF, ...over });
const rowsShown = async (): Promise<void> => {
  await waitFor(() => expect(document.querySelector('[data-entry-id]')).not.toBeNull());
};

describe('AccessLogScreen (INT-05): every call of a machine to the open API', () => {
  it('UI-INT-05: shows the notes on names and on BI reads, the columns of the catalogue and each call in words', async () => {
    const h = clientFor({ listOpenAccessLog: page([logEntry(1), logEntry(2, { outcome: 'RATE_LIMITED', status: 429, row_count: null, scope: null, query_keys: [] })]) });
    mount(<AccessLogScreen route={route} />, h);
    await rowsShown();
    expect(screen.getByTestId('log-note').textContent).toBe(t('int.log.note.names'));
    expect(screen.getByTestId('bi-note').textContent).toBe(t('int.log.note.bi'));
    const table = screen.getByRole('table', { name: t('int.log.table.caption') });
    expect(Array.from(table.querySelectorAll('thead th')).map((cell) => cell.textContent)).toEqual(['time', 'account', 'operation', 'scope', 'path', 'keys', 'outcome', 'status', 'rows', 'correlation'].map((column) => t(`int.log.column.${column}` as never)));
    expect(screen.getByText(t('int.log.outcome.rateLimited'))).toBeTruthy();
    expect(screen.getByText(t('int.log.outcome.ok'))).toBeTruthy();
  });

  it('says why the log is empty, shows a failed read as an error with retry, and a refusal as denied', async () => {
    mount(<AccessLogScreen route={route} />, clientFor({ listOpenAccessLog: page([]) }));
    expect(await screen.findByTestId('empty')).toBeTruthy();
    cleanup();
    const failing = clientFor({ listOpenAccessLog: new Error('x') });
    mount(<AccessLogScreen route={route} />, failing);
    expect(await screen.findByTestId('error')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('states.retry.action') }));
    await waitFor(() => expect(failing.read.mock.calls.length).toBeGreaterThan(1));
    cleanup();
    mount(<AccessLogScreen route={route} />, clientFor({ listOpenAccessLog: problem('SCOPE_DENIED', 403) }));
    expect(await screen.findByTestId('denied')).toBeTruthy();
  });

  it('filters by outcome and account in the address and in the query, and refuses an account that is not a uuid', async () => {
    const h = clientFor({ listOpenAccessLog: page([logEntry(1)]) });
    mount(<AccessLogScreen route={route} />, h);
    await rowsShown();
    fireEvent.change(screen.getByLabelText(t('int.log.filter.outcome.label')), { target: { value: 'DENIED_SCOPE' } });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?outcome=DENIED_SCOPE'));
    fireEvent.change(screen.getByLabelText(t('int.log.filter.account.label')), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: t('int.log.filter.apply.action') }));
    expect(screen.getByText(t('int.log.filter.account.error'))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t('int.log.filter.account.label')), { target: { value: id('00a0', 1) } });
    fireEvent.click(screen.getByRole('button', { name: t('int.log.filter.apply.action') }));
    await waitFor(() => expect(h.read.mock.calls.some(([, input]) => (input as { query?: Record<string, unknown> }).query?.account_id === id('00a0', 1))).toBe(true));
  });

  it('loads the next page when the server gives a cursor', async () => {
    const list = vi.fn((input: unknown) => ((input as { query: Record<string, unknown> }).query.cursor === undefined ? page([logEntry(1)], { next_cursor: 'c2' }) : page([logEntry(2)])));
    mount(<AccessLogScreen route={route} />, clientFor({ listOpenAccessLog: list }));
    await rowsShown();
    fireEvent.click(await screen.findByRole('button', { name: t('int.common.paging.more') }));
    await waitFor(() => expect(screen.getByTestId('shown').textContent).toBe(t('int.common.paging.summary', { shown: 2 })));
  });
});
