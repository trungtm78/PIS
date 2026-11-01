import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { READER, client, issue, mountIssue, person, routeOf, world } from '../test-support';
import SourceIssuesScreen from './SourceIssuesScreen';

const ROUTE = routeOf('ISS-11', 'FR-ISS-11');
const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const REF = (n: number): string => `00000000-0000-4000-8000-0000000000${n}0`;

afterEach(cleanup);

const ISSUES = [
  issue(1, { title: 'Hộ ông Nguyễn Văn Hộ chưa nhận tiền', source_module: 'LND', source_ref_id: REF(1), category_label: 'Giải phóng mặt bằng', assignee: person(2), reported_by: person(3) }),
  issue(2, {
    title: 'Giấy phép hết hạn',
    source_module: 'PMT',
    source_ref_id: REF(2),
    category_label: 'Giấy phép',
    severity: 'CRITICAL',
    overdue_since: '2026-10-01T02:00:00.000Z',
    overdue_days: 4,
    due_at: '2026-10-02T02:00:00.000Z',
  }),
  issue(3, { source_module: 'QMS', source_ref_id: REF(3), category_label: 'Chất lượng' }),
  issue(4, { source_module: 'AST', source_ref_id: REF(4), category_label: 'Bảo hành' }),
  issue(5, { source_module: 'AUD', source_ref_id: REF(5), category_label: 'Kiểm toán' }),
  issue(6, { source_module: 'PMT', source_ref_id: null, category_label: 'Giấy phép' }),
  issue(7),
];

const show = (permissions: readonly string[] | undefined = READER) => {
  const h = client(world({ issues: ISSUES }));
  mountIssue(<SourceIssuesScreen route={ROUTE} />, h, { permissions, path: '/iss/iss-11' });
  return h;
};
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-issue]'));
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));

describe('SourceIssuesScreen (ISS-11): the issues that other modules opened', () => {
  it('UI-ISS-11: shows each automatic issue with its source, the link to the object and its category, and no personal data', async () => {
    show();
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('iss.sources.page.title'));
    expect(rows()).toHaveLength(6);
    const land = within(rows()[0] as HTMLElement);
    expect(land.getByTestId('source').textContent).toBe(word('iss.source.lnd.text'));
    expect(land.getByTestId('category').textContent).toBe('Giải phóng mặt bằng');
    expect(land.queryByTestId('source-link')).toBeNull();
    expect(land.getByTestId('object-text').textContent).toBe(word('iss.sources.object.reference').replace('{reference}', REF(1)));
    expect(land.getByRole('link', { name: 'VM-2026-000001' }).getAttribute('href')).toBe('/iss/iss-03?id=00000000-0000-4000-8000-a20000000001');
    const permit = within(rows()[1] as HTMLElement);
    expect(permit.getByTestId('source-link').getAttribute('href')).toBe(`/pmt/pmt-02?permit=${REF(2)}`);
    expect(permit.getByTestId('due').textContent).toContain(word('iss.sources.overdue.text').replace('{days}', '4'));
    for (const [index, ref] of [
      [2, 3],
      [3, 4],
      [4, 5],
    ] as const) {
      const cell = within(rows()[index] as HTMLElement);
      expect(cell.queryByTestId('source-link')).toBeNull();
      expect(cell.getByTestId('object').textContent).toBe(word('iss.sources.object.reference').replace('{reference}', REF(ref)));
    }
    expect(within(rows()[5] as HTMLElement).getByTestId('object').textContent).toBe(word('iss.sources.object.none'));
    const text = document.body.textContent ?? '';
    for (const personal of ['Nguyễn Văn Hộ', 'Nguyễn Văn B', 'Nguyễn Văn C', 'Giấy phép hết hạn']) expect(text).not.toContain(personal);
    expect(screen.getByTestId('privacy-note').textContent).toBe(word('iss.sources.privacy.notice'));
  });

  it('counts the issues by source and filters them by source and by category', async () => {
    show();
    await ready();
    const counts = within(screen.getByTestId('counts'))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(counts).toEqual([
      word('iss.sources.counts.item').replace('{source}', word('iss.source.lnd.text')).replace('{count}', '1'),
      word('iss.sources.counts.item').replace('{source}', word('iss.source.pmt.text')).replace('{count}', '2'),
      word('iss.sources.counts.item').replace('{source}', word('iss.source.qms.text')).replace('{count}', '1'),
      word('iss.sources.counts.item').replace('{source}', word('iss.source.ast.text')).replace('{count}', '1'),
      word('iss.sources.counts.item').replace('{source}', word('iss.source.aud.text')).replace('{count}', '1'),
    ]);
    fireEvent.change(screen.getByLabelText(word('iss.sources.filter.source')), { target: { value: 'PMT' } });
    expect(rows()).toHaveLength(2);
    expect(screen.getByTestId('count').textContent).toBe(word('iss.sources.count.text').replace('{count}', '2'));
    fireEvent.change(screen.getByLabelText(word('iss.sources.filter.category')), { target: { value: 'Chất lượng' } });
    expect(screen.getByTestId('no-match').textContent).toBe(word('iss.sources.noMatch.notice'));
    fireEvent.change(screen.getByLabelText(word('iss.sources.filter.source')), { target: { value: '' } });
    expect(rows()).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(word('iss.sources.filter.source')), { target: { value: 'nonsense' } });
    expect(rows()).toHaveLength(1);
  });

  it('shows the empty state when no module has opened an issue', async () => {
    const h = client(world({ issues: [issue(1)] }));
    mountIssue(<SourceIssuesScreen route={ROUTE} />, h, { permissions: READER, path: '/' });
    expect((await screen.findByText(word('states.empty.title'))).tagName).toBe('H1');
  });

  it('reads nothing and shows the denied state without the permission to read issues', async () => {
    const h = show(['issue.create']);
    expect((await screen.findByText(word('states.denied.title'))).tagName).toBe('H1');
    expect(h.client.readAll).not.toHaveBeenCalled();
  });

  it.each([
    ['denied', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', extensions: {} }), 'states.denied.title'],
    ['signed out', new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c', extensions: {} }), 'states.signedOut.title'],
    ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c', extensions: {} }), 'states.offline.title'],
    ['error', new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c', extensions: {} }), 'states.error.title'],
  ])('shows the %s state when the read fails, and reads again on retry', async (_name, failure, title) => {
    const h = client(world({ issues: ISSUES }));
    const read = vi.fn(() => Promise.reject(failure));
    (h.client as unknown as { readAll: unknown }).readAll = read;
    mountIssue(<SourceIssuesScreen route={ROUTE} />, h, { permissions: READER, path: '/' });
    expect((await screen.findByText(word(title))).tagName).toBe('H1');
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it('shows the loading state while the issues are on their way', () => {
    const h = client(world());
    (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
    mountIssue(<SourceIssuesScreen route={ROUTE} />, h, { permissions: READER, path: '/' });
    expect(screen.getByRole('status', { name: word('states.loading.label') })).toBeTruthy();
  });

  it('reads while the permissions are not known yet', async () => {
    const h = show(undefined);
    await ready();
    expect(h.client.readAll).toHaveBeenCalledWith('get_resources_issue');
  });
});
