import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DirectiveWidget from './DirectiveWidget';
import PeriodScreen from './PeriodScreen';
import { AS_OF, POLICY, PROJECT_A, UNIT_B, harness, mount, overdueDirective, directive, refusal, routeOf, text, uuid } from './test-support';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ROUTE = routeOf('DIR-05');
const item = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid(200 + n),
  code: `GB-2026-001/CD-0${n}`,
  meeting: { id: uuid(301), code: 'GB-2026-001', meeting_date: '2026-10-01' },
  scope_kind: 'PROJECT',
  project: { id: PROJECT_A, code: 'DA-01', name: 'Đường tỉnh 205' },
  text: `Chỉ đạo của kỳ số ${n}.`,
  assignee_unit: { id: uuid(101), code: 'BQL1', name: 'Ban quản lý 1' },
  due_on_at_end: '2026-10-25',
  status_at_end: 'OPEN',
  raised_in_period: true,
  closed_in_period: false,
  extended_in_period: false,
  open_at_end: true,
  last_note: null,
  last_note_on: null,
  ...overrides,
});
const report = (items: unknown[] = [item(1, { status_at_end: 'OVERDUE', last_note: 'Đang chờ ý kiến của sở.', last_note_on: '2026-10-20' }), item(2, { status_at_end: 'DONE', closed_in_period: true, open_at_end: false, extended_in_period: true })]) => ({
  period: { from: '2026-10-09', to: '2026-11-08' },
  counts: { total: 2, raised: 2, closed: 1, extended: 1, open_at_end: 1, overdue_at_end: 1, by_status: { OPEN: 0, IN_PROGRESS: 0, DONE: 1, OVERDUE: 1, CANCELLED: 0 } },
  items,
  truncated: false,
  definitions: { raised: 'Chỉ đạo của các cuộc giao ban họp trong kỳ.', closed: 'Chỉ đạo có sự kiện đóng trong kỳ.', extended: 'Chỉ đạo có gia hạn được duyệt trong kỳ.', open_at_end: 'Chưa đóng vào cuối ngày cuối kỳ.', overdue_at_end: 'Hạn không sau ngày cuối kỳ.', by_status: 'Mỗi chỉ đạo nằm đúng một trạng thái.' },
  as_of: AS_OF,
});
const tileOf = (label: string): HTMLElement => Array.from(document.querySelectorAll<HTMLElement>('.ui-kpi')).find((tile) => tile.textContent?.includes(label) === true) as HTMLElement;

describe('DIR-05: the directives of a period', () => {
  it('opens on the last thirty days, shows the figures with the definition of each, the status of every directive at the end of the period, and the latest note', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-08T05:00:00Z') });
    const h = harness(() => report());
    mount(<PeriodScreen route={ROUTE} />, h, { permissions: ['directive.read'] });
    expect(await screen.findByRole('link', { name: 'GB-2026-001/CD-01' })).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('getDirectivesForReport', { query: { from: '2026-10-09', to: '2026-11-08' } });
    expect(screen.getByLabelText(text('dir.period.from.label'))).toHaveProperty('value', '2026-10-09');
    expect(screen.getByLabelText(text('dir.period.to.label'))).toHaveProperty('value', '2026-11-08');
    expect(within(tileOf(text('dir.period.tile.total.label'))).getByText('2')).toBeTruthy();
    expect(within(tileOf(text('dir.period.tile.closed.label'))).getByText('1')).toBeTruthy();
    expect(within(tileOf(text('dir.period.tile.overdue.label'))).getByText('1')).toBeTruthy();
    expect(screen.getByTestId('by-status').textContent).toContain(`${text('dir.status.done.label')}: 1`);
    expect(screen.getByTestId('by-status').textContent).toContain(`${text('dir.status.overdue.label')}: 1`);
    const late = screen.getByRole('link', { name: 'GB-2026-001/CD-01' }).closest('tr') as HTMLElement;
    expect(within(late).getByText(text('dir.status.overdue.label'))).toBeTruthy();
    expect(within(late).getByText('Đang chờ ý kiến của sở. (20/10/2026)')).toBeTruthy();
    expect(within(late).getByText('25/10/2026')).toBeTruthy();
    const done = screen.getByRole('link', { name: 'GB-2026-001/CD-02' }).closest('tr') as HTMLElement;
    expect(within(done).getByText(`${text('dir.period.fact.raised')} · ${text('dir.period.fact.closed')} · ${text('dir.period.fact.extended')}`)).toBeTruthy();
    expect(screen.getByText(text('dir.period.total.text', { count: 2 }))).toBeTruthy();
    expect(document.querySelector('.ui-context__asof')?.textContent).toContain('08/11/2026');
    fireEvent.click(screen.getByRole('button', { name: text('dir.info.open.label', { name: text('dir.period.tile.overdue.label') }) }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('Hạn không sau ngày cuối kỳ.')).toBeTruthy();
    expect(within(panel).getByText(text('dir.period.version.text'))).toBeTruthy();
  });

  it('reads again for the period and the unit chosen, and says a period that is none instead of reading it', async () => {
    const h = harness(() => report());
    mount(<PeriodScreen route={ROUTE} />, h, { permissions: ['directive.read'] });
    await screen.findByRole('link', { name: 'GB-2026-001/CD-01' });
    fireEvent.change(screen.getByLabelText(text('dir.period.from.label')), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText(text('dir.period.to.label')), { target: { value: '2026-10-31' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getDirectivesForReport', { query: { from: '2026-10-01', to: '2026-10-31' } }));
    await screen.findByRole('option', { name: 'SXD · Sở Xây dựng' });
    fireEvent.change(screen.getByLabelText(text('dir.filter.unit.label')), { target: { value: UNIT_B } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getDirectivesForReport', { query: { from: '2026-10-01', to: '2026-10-31', unit_id: UNIT_B } }));
    const reads = h.read.mock.calls.length;
    fireEvent.change(screen.getByLabelText(text('dir.period.from.label')), { target: { value: '2026-12-01' } });
    expect((await screen.findByTestId('period-invalid')).textContent).toBe(text('dir.period.invalid.text'));
    expect(h.read.mock.calls.length).toBe(reads);
    fireEvent.change(screen.getByLabelText(text('dir.period.from.label')), { target: { value: '' } });
    expect(screen.getByTestId('period-invalid')).toBeTruthy();
  });

  it('shows an empty period as empty, a skeleton while reading, and an error or a denial instead of zeros', async () => {
    mount(<PeriodScreen route={ROUTE} />, harness(() => ({ ...report([]), counts: { ...report().counts, total: 0 } })), { permissions: ['directive.read'] });
    expect(screen.getByRole('status', { name: text('states.loading.label') })).toBeTruthy();
    expect(await screen.findByText(text('ui.dataTable.emptyNone'))).toBeTruthy();
    cleanup();
    mount(<PeriodScreen route={ROUTE} />, harness(() => new Error('boom')), { permissions: ['directive.read'] });
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    mount(<PeriodScreen route={ROUTE} />, harness(() => refusal('SCOPE_DENIED', 403)), { permissions: ['directive.read'] });
    expect(await screen.findByText(text('states.denied.title'))).toBeTruthy();
  });

  it('says the list was cut when the server did', async () => {
    mount(<PeriodScreen route={ROUTE} />, harness(() => ({ ...report(), truncated: true })), { permissions: ['directive.read'] });
    expect(await screen.findByText(text('dir.period.truncated.text'))).toBeTruthy();
  });
});

const widget = (overrides: Record<string, unknown> = {}) => ({
  counts: { overdue: 3, due_soon: 2, escalated: 1, open: 8 },
  items: [overdueDirective(1), { ...overdueDirective(2), phase: 'ESCALATED', overdue_days: 9 }],
  truncated: false,
  definitions: { overdue: 'Chỉ đạo đang mở mà hạn trước hôm nay.', due_soon: 'Chỉ đạo có hạn trong 3 ngày.', escalated: 'Chỉ đạo quá hạn từ 7 ngày.' },
  policy: POLICY,
  as_of: AS_OF,
  ...overrides,
});

describe('the directive widget of the dashboard', () => {
  it('shows the counts, each with its "i", and the oldest overdue directives that open their directive', async () => {
    const h = harness(() => widget());
    mount(<DirectiveWidget />, h, { permissions: ['directive.read'] });
    const box = await screen.findByTestId('directive-widget');
    expect((await within(box).findByRole('link', { name: 'GB-2026-001/CD-01' })).getAttribute('href')).toBe(`/dir/dir-04?directive=${uuid(201)}`);
    expect(within(box).getByText(text('dir.clock.late.text', { days: 5 }))).toBeTruthy();
    expect(within(box).getByText(text('dir.clock.escalated.text', { days: 9 }))).toBeTruthy();
    const tile = (label: string) => Array.from(box.querySelectorAll<HTMLElement>('.ui-kpi')).find((element) => element.textContent?.includes(label) === true) as HTMLElement;
    expect(within(tile(text('dir.widget.overdue.label'))).getByText('3')).toBeTruthy();
    expect(within(tile(text('dir.widget.soon.label'))).getByText('2')).toBeTruthy();
    expect(within(tile(text('dir.widget.escalated.label'))).getByText('1')).toBeTruthy();
    fireEvent.click(within(box).getByRole('button', { name: text('dir.info.open.label', { name: text('dir.widget.overdue.label') }) }));
    expect(within(await screen.findByRole('dialog')).getByText('Chỉ đạo đang mở mà hạn trước hôm nay.')).toBeTruthy();
    expect(screen.getByRole('link', { name: text('dir.widget.all.action') }).getAttribute('href')).toBe('/dir/dir-03');
    expect(h.read).toHaveBeenCalledWith('getDirectiveWidget', {});
  });

  it('says none is overdue only when the server said so, never while loading or after a failure', async () => {
    mount(<DirectiveWidget />, harness(() => widget({ counts: { overdue: 0, due_soon: 0, escalated: 0, open: 3 }, items: [] })), { permissions: ['directive.read'] });
    expect(document.querySelectorAll('.ui-kpi--loading').length).toBe(3);
    expect(screen.queryByTestId('widget-none')).toBeNull();
    expect((await screen.findByTestId('widget-none')).textContent).toBe(text('dir.widget.none.text'));
    cleanup();
    const failing = harness(() => new Error('boom'));
    mount(<DirectiveWidget />, failing, { permissions: ['directive.read'] });
    await waitFor(() => expect(document.querySelectorAll('.ui-kpi--error').length).toBe(3));
    expect(screen.queryByTestId('widget-none')).toBeNull();
    const before = failing.read.mock.calls.length;
    fireEvent.click(screen.getAllByRole('button', { name: text('ui.common.retry') })[0] as HTMLElement);
    await waitFor(() => expect(failing.read.mock.calls.length).toBeGreaterThan(before));
  });

  it('tells a reader who may not read the directives so', async () => {
    mount(<DirectiveWidget />, harness(() => refusal('SCOPE_DENIED', 403)), { permissions: [] });
    expect((await screen.findByTestId('widget-denied')).textContent).toBe(text('dir.widget.denied.text'));
  });

  it('says a count that was cut and the policy it follows', async () => {
    mount(<DirectiveWidget />, harness(() => widget({ truncated: true })), { permissions: ['directive.read'] });
    expect(await screen.findByText(text('dir.board.truncated.text'))).toBeTruthy();
    expect(screen.getByTestId('policy-note').textContent).toContain(text('dir.policy.unverified.text'));
    void directive;
  });
});

describe('DIR-05: presentation mode (ENT-4d, BC.02)', () => {
  it('opens the counts and the late directives over the page, with the clip hook on the button, and leaves with Escape', async () => {
    const h = harness(() => report());
    mount(<PeriodScreen route={ROUTE} />, h, { permissions: ['directive.read'] });
    expect(await screen.findByRole('link', { name: 'GB-2026-001/CD-01' })).toBeTruthy();
    const open = screen.getByTestId('dir-presentation-mode');
    expect(open.getAttribute('data-clip-ref')).toBe('dir.dashboard.presentation-mode');
    fireEvent.click(open);
    const presentation = await screen.findByRole('dialog', { name: text('dir.present.title.text') });
    expect(within(presentation).getByRole('heading', { level: 2, name: text('dir.present.counts.title') })).toBeTruthy();
    fireEvent.keyDown(presentation, { key: 'ArrowRight' });
    expect(within(presentation).getByRole('heading', { level: 2, name: text('dir.present.overdue.title') })).toBeTruthy();
    expect(within(presentation).getByText('GB-2026-001/CD-01')).toBeTruthy();
    // The directive that is not late is not on the board of the late ones, and the page's own buttons are not in the presentation.
    expect(within(presentation).queryByText('GB-2026-001/CD-02')).toBeNull();
    expect(within(presentation).queryByLabelText(text('dir.period.from.label'))).toBeNull();
    fireEvent.keyDown(presentation, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: text('dir.present.title.text') })).toBeNull());
  });

  it('keeps the button off until the period is read', () => {
    mount(<PeriodScreen route={ROUTE} />, harness(() => new Promise(() => undefined)), { permissions: ['directive.read'] });
    expect((screen.getByTestId('dir-presentation-mode') as HTMLButtonElement).disabled).toBe(true);
  });
});
