import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import { message as word } from '../../ctr/test-catalogue';
import { ALL, CONTRACTOR, OTHER, READER, client, mount, policy, routeOf } from '../shared/test/vnd-test-support';
import type { World } from '../shared/test/vnd-test-support';
import PerformanceScreen from './PerformanceScreen';

const route = routeOf('VND-12', 'FR-VND-12');
const AS_OF = '2026-11-08T03:00:00.000Z';
const PROPOSAL = '00000000-0000-4000-8000-000000000b11';
const ALL_RIGHTS = [...ALL, 'vnd.performance.publish'];

const labelOf = (label: string): RegExp => new RegExp(label.split('').map((char) => (/[\p{L}\p{N} ]/u.test(char) ? char : `\\${char}`)).join(''));

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

const line = (n: number, over: Record<string, unknown> = {}) => ({
  proposal_id: n === 1 ? PROPOSAL : `00000000-0000-4000-8000-000000000b${String(10 + n)}`,
  contract_id: `00000000-0000-4000-8000-000000000c${String(10 + n)}`,
  contract_code: `HD-${n}`,
  contractor_id: n === 2 ? OTHER : CONTRACTOR,
  contractor_name: `Công ty nhà thầu ${n === 2 ? 2 : 1}`,
  evaluation_kind: 'COMPLETION',
  period_label: 'FINAL',
  state: 'ADOPTED',
  rating: 'POOR',
  score: '41.50',
  construction: true,
  adopted_on: '2026-04-20',
  ended_on: '2026-03-31',
  evaluation_id: null,
  response_kind: null,
  response_received_on: null,
  publication_due_on: '2026-09-30',
  publication_clock: 'OVERDUE',
  publication: null,
  updates: [],
  response_review: 'NOT_ANSWERED',
  obligation: null,
  can_post: true,
  ...over,
});

const page = (items: Array<Record<string, unknown>>) => ({
  items,
  figures: [
    { code: 'VENDOR_PERFORMANCE_PUBLISHED_IN_TIME', numerator: 1, denominator: 4, as_of: '2026-11-08' },
    { code: 'VENDOR_RESPONSE_REVIEWED_IN_TIME', numerator: 0, denominator: 0, as_of: '2026-11-08' },
  ],
  policy: policy('VENDOR_PERFORMANCE'),
  as_of: AS_OF,
});

const view = (lines: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
  contractor_id: CONTRACTOR,
  contractor_name: 'Công ty nhà thầu 1',
  lines,
  streak: 0,
  suggestion: 'NONE',
  retrospect_proposal_ids: lines.map((one) => one.proposal_id),
  policy: policy('VENDOR_PERFORMANCE'),
  as_of: AS_OF,
  ...over,
});

interface Options {
  permissions?: string[];
  mode?: 'FULL' | 'READ_ONLY';
  command?: (operation: string, input: unknown) => unknown;
  path?: string;
  failing?: World['failing'];
}

function open(list: Record<string, unknown> = page([line(1), line(2)]), detail: Record<string, unknown> | Error = view([line(1)]), options: Options = {}) {
  const world: World = { answers: { listVendorPerformancePublications: list, getVendorPerformance: detail }, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world, options.command);
  mount(<PerformanceScreen route={route} />, h, { permissions: options.permissions ?? ALL_RIGHTS, path: options.path ?? '/vnd/vnd-12', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, world };
}

const dialog = (name: string): HTMLElement => screen.getByRole('dialog', { name });
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-proposal-id]'));
const loaded = async (): Promise<void> => {
  await screen.findByTestId('performance-figures');
};

describe('PerformanceScreen (VND-12): performance and its publication', () => {
  it('lists the adopted ratings with the rating, the day the contract ended, the clock of publication with its due day, and the answer of the contractor', async () => {
    open(
      page([
        line(1),
        line(2, { publication_clock: 'MET', publication: { id: 'p', kind: 'INITIAL', receipt: 'BN-2026-0042', posted_on: '2026-08-01', posted_by: 'm9', clock: 'MET' }, updates: [{ id: 'u', kind: 'UPDATE_AFTER_WARRANTY', receipt: 'BN-2026-0043', posted_on: '2026-10-01', posted_by: 'm9', clock: 'MET_LATE' }], rating: 'GOOD' }),
        line(3, { publication_clock: 'DUE_SOON', publication_due_on: '2026-11-20', response_review: 'DUE_SOON', response_received_on: '2026-10-25' }),
      ]),
    );
    await loaded();
    const [overdue, posted, soon] = rows();
    expect(overdue?.textContent).toContain('HD-1');
    expect(overdue?.textContent).toContain(word('vnd.performance.rating.poor.name'));
    expect(overdue?.textContent).toContain(word('vnd.performance.score.text', { score: '41.50' }));
    expect(overdue?.textContent).toContain('31/03/2026');
    expect(overdue?.textContent).toContain(word('vnd.performance.clock.overdue.name'));
    expect(overdue?.textContent).toContain(word('vnd.performance.due.text', { date: '30/09/2026' }));
    expect(overdue?.textContent).toContain(word('vnd.performance.review.notAnswered.name'));
    expect(posted?.textContent).toContain(word('vnd.performance.clock.met.name'));
    expect(posted?.textContent).toContain(word('vnd.performance.receipt.text', { receipt: 'BN-2026-0042', date: '01/08/2026' }));
    expect(posted?.textContent).toContain(word('vnd.performance.updates.text', { count: 1, kind: word('vnd.performance.kind.updateAfterWarranty.name') }));
    expect(soon?.textContent).toContain(word('vnd.performance.clock.dueSoon.name'));
    expect(soon?.textContent).toContain(word('vnd.performance.review.dueSoon.name'));
    expect(soon?.textContent).toContain(word('vnd.performance.response.text', { date: '25/10/2026' }));
  });

  it('says the rule and the two figures each with its "i" and the unverified flag', async () => {
    open();
    await loaded();
    const rule = screen.getByTestId('performance-rule');
    fireEvent.click(within(rule).getByRole('button', { name: word('vnd.info.open.label', { name: word('vnd.performance.figure.rule.name') }) }));
    const panel = screen.getByRole('dialog', { name: word('vnd.performance.figure.rule.name') });
    expect(panel.querySelector('[data-field=formula] dd')?.textContent).toBe('Formula of VENDOR_PERFORMANCE');
    expect(panel.querySelector('[data-field=unverified]')).toBeTruthy();
    expect(screen.getByTestId('figure-VENDOR_PERFORMANCE_PUBLISHED_IN_TIME').textContent).toBe('25%');
    expect(screen.getByTestId('figure-VENDOR_RESPONSE_REVIEWED_IN_TIME').textContent).toBe('–');
    const figures = screen.getByTestId('performance-figures');
    fireEvent.click(within(figures).getByRole('button', { name: word('vnd.info.open.label', { name: word('vnd.performance.figure.published.name') }) }));
    expect(screen.getByRole('dialog', { name: word('vnd.performance.figure.published.name') }).textContent).toContain(word('vnd.performance.figure.published.formula'));
  });

  it('filters the worklist by the state of the publication', async () => {
    const { h } = open();
    await loaded();
    expect(h.read).toHaveBeenCalledWith('listVendorPerformancePublications', { query: {} });
    fireEvent.change(screen.getByLabelText(word('vnd.performance.filter.state.label')), { target: { value: 'OVERDUE' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorPerformancePublications', { query: { state: 'OVERDUE' } }));
  });

  it('says an empty worklist, and a filtered one with a way to clear the filter', async () => {
    open(page([]));
    expect(await screen.findByText(word('ui.dataTable.emptyNone'))).toBeTruthy();
    cleanup();
    const { h } = open(page([]));
    await loaded();
    fireEvent.change(screen.getByLabelText(word('vnd.performance.filter.state.label')), { target: { value: 'POSTED' } });
    expect(await screen.findByText(word('ui.dataTable.emptyFiltered'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: word('ui.dataTable.clearFilters') }));
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('listVendorPerformancePublications', { query: {} }));
  });

  it('records the first publication with the receipt and the kind, and says the receipt of the command', async () => {
    const { h } = open();
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('post-publication'));
    const form = dialog(word('vnd.performance.post.title'));
    const send = within(form).getByRole('button', { name: word('vnd.performance.post.confirm') }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText(labelOf(word('vnd.performance.post.receipt.label'))), { target: { value: ' BN-2026-0100 ' } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('postVendorPerformance', { path: { id: PROPOSAL }, body: { kind: 'INITIAL', receipt: 'BN-2026-0100' }, attempt: { key: expect.any(String) } }));
    expect((await screen.findByTestId('receipt')).textContent).toContain(word('vnd.performance.post.title'));
  });

  it('offers only an update once the first posting exists, and no button to the person who adopted the rating or without the right', async () => {
    const posted = line(1, { publication_clock: 'MET', publication: { id: 'p', kind: 'INITIAL', receipt: 'BN-1', posted_on: '2026-08-01', posted_by: 'm9', clock: 'MET' } });
    const { h } = open(page([posted]));
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('post-publication'));
    const form = dialog(word('vnd.performance.post.title'));
    const kind = within(form).getByLabelText(labelOf(word('vnd.performance.post.kind.label'))) as HTMLSelectElement;
    expect(Array.from(kind.options).map((option) => option.value).filter((value) => value !== '')).toEqual(['UPDATE_AFTER_WARRANTY', 'UPDATE_AFTER_RESPONSE']);
    fireEvent.change(kind, { target: { value: 'UPDATE_AFTER_RESPONSE' } });
    fireEvent.change(within(form).getByLabelText(labelOf(word('vnd.performance.post.receipt.label'))), { target: { value: 'BN-2' } });
    fireEvent.click(within(form).getByRole('button', { name: word('vnd.performance.post.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('postVendorPerformance', { path: { id: PROPOSAL }, body: { kind: 'UPDATE_AFTER_RESPONSE', receipt: 'BN-2' }, attempt: { key: expect.any(String) } }));
    cleanup();
    open(page([line(1, { can_post: false })]));
    await loaded();
    expect(screen.queryByTestId('post-publication')).toBeNull();
    cleanup();
    open(page([line(1)]), view([line(1)]), { permissions: READER });
    await loaded();
    expect(screen.queryByTestId('post-publication')).toBeNull();
    cleanup();
    open(page([line(1)]), view([line(1)]), { mode: 'READ_ONLY' });
    await loaded();
    expect(screen.queryByTestId('post-publication')).toBeNull();
    expect(screen.getByTestId('readonly-note')).toBeTruthy();
  });

  it('says in the dialog what the server refused', async () => {
    open(page([line(1)]), view([line(1)]), { command: () => Promise.reject(new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' })) });
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('post-publication'));
    const form = dialog(word('vnd.performance.post.title'));
    fireEvent.change(within(form).getByLabelText(labelOf(word('vnd.performance.post.receipt.label'))), { target: { value: 'BN-2026-0100' } });
    fireEvent.click(within(form).getByRole('button', { name: word('vnd.performance.post.confirm') }));
    expect((await within(form).findByRole('alert')).textContent).toBeTruthy();
    expect(screen.queryByTestId('receipt')).toBeNull();
  });

  it('opens the history of a contractor with its streak banner and the suggestion, never an action that opens a case', async () => {
    const { h } = open(page([line(1)]), view([line(1), line(4, { proposal_id: 'second' })], { streak: 3, suggestion: 'PROPOSE_RESTRICTION' }));
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('open-history'));
    const banner = await screen.findByTestId('streak-banner');
    expect(h.read).toHaveBeenCalledWith('getVendorPerformance', { path: { id: CONTRACTOR } });
    expect(banner.textContent).toContain(word('vnd.performance.suggestion.proposeRestriction.name'));
    expect(banner.textContent).toContain(word('vnd.performance.streak.text', { count: 3 }));
    expect(within(banner).getByRole('link', { name: word('vnd.performance.streak.cases.link') }).getAttribute('href')).toBe('/vnd/vnd-03');
    expect(screen.getByText(word('vnd.performance.panel.retrospect.text', { count: 2 }))).toBeTruthy();
  });

  it('says a plan to remedy at the second poor rating, no streak otherwise, and an empty history', async () => {
    open(page([line(1)]), view([line(1)], { streak: 2, suggestion: 'REMEDY_PLAN' }));
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('open-history'));
    expect((await screen.findByTestId('streak-banner')).textContent).toContain(word('vnd.performance.suggestion.remedyPlan.name'));
    expect(screen.queryByRole('link', { name: word('vnd.performance.streak.cases.link') })).toBeNull();
    cleanup();
    open(page([line(1)]), view([], { streak: 1 }));
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('open-history'));
    expect((await screen.findByTestId('streak-none')).textContent).toBe(word('vnd.performance.streak.none.text', { count: 1 }));
    expect(screen.getByTestId('performance-empty').textContent).toBe(word('vnd.performance.panel.empty.text'));
  });

  it('keeps the list when the history fails, offering to retry it, and opens the contractor the address names', async () => {
    open(page([line(1)]), new Error('down'));
    await loaded();
    fireEvent.click(within(rows()[0] as HTMLElement).getByTestId('open-history'));
    expect(await screen.findByTestId('performance-panel-error')).toBeTruthy();
    expect(rows()).toHaveLength(1);
    cleanup();
    const { h } = open(page([line(1)]), view([line(1)]), { path: `/vnd/vnd-12?contractor=${CONTRACTOR}` });
    await screen.findByTestId('streak-none');
    expect(h.read).toHaveBeenCalledWith('getVendorPerformance', { path: { id: CONTRACTOR } });
  });

  it('shows a failed worklist with a way to retry in place', async () => {
    open(page([line(1)]), view([line(1)]), { failing: { listVendorPerformancePublications: { error: new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), times: 1 } } });
    expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await loaded();
    expect(rows()).toHaveLength(1);
  });
});
