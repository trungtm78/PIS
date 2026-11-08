import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../../i18n';
import PostingScreen from './PostingScreen';
import { BATCH, BOTH, READER, SUBMITTER, client, detail, dueSoon, mount, overdue, posting, postingId, prepared, problem, receipted, rejected, route, severityRule, submitted, world } from './test/posting-test-support';
import type { World } from './test/posting-test-support';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Options {
  world?: Partial<World>;
  command?: (operation: string, input: unknown) => unknown;
  permissions?: string[] | undefined;
  mode?: 'FULL' | 'READ_ONLY';
  path?: string;
}

function mountWith(options: Options = {}) {
  const h = client(world(options.world), options.command);
  mount(<PostingScreen route={route} />, h, { permissions: options.permissions === undefined && 'permissions' in options ? undefined : (options.permissions ?? BOTH), ...(options.mode === undefined ? {} : { mode: options.mode }), ...(options.path === undefined ? {} : { path: options.path }) });
  return h;
}

const rowOf = (n: number): HTMLElement => document.querySelector(`[data-posting-id="${postingId(n)}"]`) as HTMLElement;
const listReads = (h: ReturnType<typeof client>): Array<Record<string, unknown>> => h.read.mock.calls.filter(([operation]) => operation === 'listEgpObligations').map(([, input]) => (input as { query: Record<string, unknown> }).query);
const rowsShown = async (): Promise<void> => {
  await waitFor(() => expect(document.querySelector('[data-posting-id]')).not.toBeNull());
};
const action = (n: number, key: string, kind = 'NOTICE', code?: string): HTMLElement => within(rowOf(n)).getByRole('button', { name: t(key as never, { kind: t(`egp.posting.kind.${kind === 'NOTICE' ? 'notice' : 'violation'}` as never), code: code ?? `GT-${n}` }) });
const dialogOf = (title: string): Promise<HTMLElement> => screen.findByRole('dialog', { name: title });
const REASON = 'Hệ thống mạng từ chối vì thiếu ngày đóng thầu';
const CANCEL_REASON = 'Gói thầu đã bị hủy nên không còn gì để đăng lên mạng';

describe('PostingScreen (BID-32): the duties of posting to the national procurement network', () => {
  it('UI-BID-32: shows the badges, the note on receipts, the caption, the columns and the four figures of the catalogue', async () => {
    mountWith();
    await rowsShown();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t('egp.posting.page.title'));
    expect(screen.getByTestId('assumption-badge').textContent).toBe('Mẫu tệp là giả định (PENDING-EXTERNAL)');
    expect(screen.getByTestId('unverified-badge').textContent).toBe(t('egp.posting.badge.unverified'));
    expect(screen.getByTestId('receipt-note').textContent).toBe(t('egp.posting.note.receipt'));
    const table = screen.getByRole('table', { name: t('egp.posting.table.caption') });
    const headers = Array.from(table.querySelectorAll('thead th')).map((cell) => cell.textContent);
    expect(headers).toEqual(['kind', 'subject', 'due', 'clock', 'state', 'people', 'packet', 'receipt', 'actions'].map((column) => t(`egp.posting.column.${column}` as never)));
    for (const figure of ['rate', 'overdue', 'soon', 'waiting']) expect(screen.getByTestId(`figure-${figure}`)).toBeTruthy();
  });

  it('shows a duty with its kind, subject, deadline and the flag that the rule is not confirmed, its clock, its people and its packet', async () => {
    mountWith({ world: { items: [dueSoon(1), prepared(2)] } });
    await rowsShown();
    const one = rowOf(1);
    expect(within(one).getByText('Đăng thông báo mời thầu')).toBeTruthy();
    expect(within(one).getByText('GT-1')).toBeTruthy();
    expect(one.textContent).toContain('13/11/2026 17:00');
    expect(within(one).getByTestId('legal').textContent).toBe(t('egp.posting.cell.legal.unverified', { version: 0 }));
    expect(within(one).getByText(t('egp.posting.clock.dueSoon'))).toBeTruthy();
    expect(within(one).getByText(t('egp.posting.left.hours', { value: 22 }))).toBeTruthy();
    expect(within(one).getByTestId('alert-code').textContent).toBe('EGP_POSTING_DUE');
    expect(within(one).getByTestId('owner').textContent).toBe(t('egp.posting.cell.owner', { name: 'Lê Văn Cường' }));
    const two = rowOf(2);
    expect(within(two).getByTestId('prepared-by').textContent).toBe(t('egp.posting.cell.preparedBy', { name: 'Nguyễn Văn An' }));
    expect(two.textContent).toContain(`${'a'.repeat(12)}…`);
    expect(within(two).getByText(t('egp.posting.state.prepared'))).toBeTruthy();
  });

  it('says how long a duty is past its deadline, by the unit that reads best', async () => {
    mountWith({ world: { items: [overdue(1, { clock: { status: 'OVERDUE', ms_to_due: -18_000_000 } }), overdue(2, { clock: { status: 'OVERDUE', ms_to_due: -3 * 86_400_000 } }), overdue(3, { clock: { status: 'OVERDUE', ms_to_due: -600_000 } })] } });
    await rowsShown();
    expect(within(rowOf(1)).getByText(t('egp.posting.left.hoursLate', { value: 5 }))).toBeTruthy();
    expect(within(rowOf(2)).getByText(t('egp.posting.left.daysLate', { value: 3 }))).toBeTruthy();
    expect(within(rowOf(3)).getByText(t('egp.posting.left.minutesLate', { value: 10 }))).toBeTruthy();
    expect(within(rowOf(1)).getByTestId('alert-code').textContent).toBe('EGP_POSTING_OVERDUE');
  });

  it('counts the figures from the server: the rate posted on time, the overdue ones, the ones near their deadline and the ones waiting for a receipt', async () => {
    mountWith({ world: { items: [receipted(1), submitted(2, { clock: { status: 'MET_LATE', ms_to_due: null } }), overdue(3), dueSoon(4), submitted(5)] } });
    await rowsShown();
    expect(screen.getByTestId('rate-value').textContent).toBe('50,00%');
    expect(screen.getByTestId('overdue-value').textContent).toBe('1');
    expect(screen.getByTestId('soon-value').textContent).toBe('1');
    expect(screen.getByTestId('waiting-value').textContent).toBe('2');
    expect(screen.getByTestId('figure-rate').textContent).toContain(t('egp.posting.figure.rate.detail', { met: 2, late: 1, overdue: 1 }));
  });

  it('says that nothing is judged yet instead of 100 percent', async () => {
    mountWith({ world: { items: [posting(1)] } });
    await rowsShown();
    expect(screen.getByTestId('rate-value').textContent).toBe(t('egp.posting.figure.rate.none'));
  });

  it('the "i" of the rate says the formula, what is above and below the line, the source, the day, who answers and that nothing was confirmed', async () => {
    mountWith({ world: { items: [receipted(1), overdue(2)] } });
    await rowsShown();
    fireEvent.click(within(screen.getByTestId('figure-rate')).getByRole('button', { name: t('egp.mapping.info.open.label', { name: t('egp.posting.info.rate.name') }) }));
    const panel = await dialogOf(t('egp.posting.info.rate.name'));
    expect(panel.querySelector('[data-field="formula"]')?.textContent).toContain('Tỷ lệ = đúng hạn / (đúng hạn + muộn + quá hạn)');
    expect(panel.querySelector('[data-field="numerator"]')?.textContent).toContain(t('egp.posting.info.rate.numerator', { value: 1 }));
    expect(panel.querySelector('[data-field="denominator"]')?.textContent).toContain(t('egp.posting.info.rate.denominator', { value: 2 }));
    expect(panel.querySelector('[data-field="source"]')?.textContent).toContain('egp_posting_obligation');
    expect(panel.querySelector('[data-field="asOf"]')?.textContent).toContain('12/11/2026');
    expect(panel.querySelector('[data-field="owner"]')?.textContent).toContain(t('egp.posting.info.owner.text'));
    expect(panel.querySelector('[data-field="version"]')?.textContent).toContain(t('egp.posting.info.version.default', { version: 0, legal: 'UNVERIFIED' }));
    expect(panel.querySelector('[data-field="unverified"]')?.textContent).toBe(t('egp.posting.info.unverified.text'));
  });

  it('the "i" of the overdue figure carries the rule of the urgency of the server, and a rule the agency approved is said as such', async () => {
    mountWith({ world: { items: [overdue(1)], severity: severityRule({ source: 'RULE', version: 2, unverified: false, legal_status: 'VERIFIED', urgent_within_hours: 12 }) } });
    await rowsShown();
    fireEvent.click(within(screen.getByTestId('figure-overdue')).getByRole('button', { name: t('egp.mapping.info.open.label', { name: t('egp.posting.info.urgency.name') }) }));
    const panel = await dialogOf(t('egp.posting.info.urgency.name'));
    expect(panel.querySelector('[data-field="formula"]')?.textContent).toContain('Khẩn khi còn không quá urgent_within_hours giờ');
    expect(panel.querySelector('[data-field="version"]')?.textContent).toContain(t('egp.posting.info.version.rule', { version: 2, legal: 'VERIFIED' }));
    expect(panel.querySelector('[data-field="unverified"]')).toBeNull();
    expect(screen.getByTestId('figure-overdue').textContent).toContain(t('egp.posting.figure.overdue.detail', { hours: 12 }));
  });

  it('the duties of a rule that is confirmed carry no badge of unverified deadlines', async () => {
    mountWith({ world: { items: [posting(1, { legal_status: 'VERIFIED', rule_source: 'RULE', rule_version: 3 })], severity: severityRule({ unverified: false }) } });
    await rowsShown();
    expect(screen.queryByTestId('unverified-badge')).toBeNull();
    expect(within(rowOf(1)).getByTestId('legal').textContent).toBe(t('egp.posting.cell.legal.verified', { version: 3 }));
  });
});

describe('PostingScreen: the view kept in the address', () => {
  it('the chips set the group, "all" clears it, and each asks the server again', async () => {
    const h = mountWith({ world: { items: [posting(1), submitted(2), receipted(3)] } });
    await rowsShown();
    fireEvent.click(screen.getByRole('button', { name: t('egp.posting.chip.label', { label: t('egp.posting.group.submitted'), count: 1 }) }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?group=SUBMITTED'));
    await waitFor(() => expect(document.querySelectorAll('[data-posting-id]')).toHaveLength(1));
    expect(listReads(h).at(-1)).toMatchObject({ group: 'SUBMITTED' });
    fireEvent.click(screen.getByRole('button', { name: t('egp.posting.chip.label', { label: t('egp.posting.group.closed'), count: 1 }) }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?group=CLOSED'));
    fireEvent.click(screen.getByRole('button', { name: t('egp.posting.chip.all', { count: 3 }) }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(''));
    await waitFor(() => expect(document.querySelectorAll('[data-posting-id]')).toHaveLength(3));
  });

  it('the kind, the clock and "only mine" go to the address and to the server, and a link opens the view they describe', async () => {
    const h = mountWith({ world: { items: [overdue(1), posting(2, { owner_id: 'someone-else' })] }, path: '/bid/bid-32?kind=NOTICE&clock=OVERDUE&mine=true' });
    await rowsShown();
    expect(listReads(h)[0]).toMatchObject({ kind: 'NOTICE', clock: 'OVERDUE', mine: 'true', limit: 50 });
    expect(document.querySelectorAll('[data-posting-id]')).toHaveLength(1);
    expect((screen.getByLabelText(t('egp.posting.filter.kind.label')) as HTMLSelectElement).value).toBe('NOTICE');
    expect((screen.getByLabelText(t('egp.posting.filter.clock.label')) as HTMLSelectElement).value).toBe('OVERDUE');
    expect((screen.getByLabelText(t('egp.posting.filter.mine.label')) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText(t('egp.posting.filter.mine.label')));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?kind=NOTICE&clock=OVERDUE'));
    fireEvent.change(screen.getByLabelText(t('egp.posting.filter.kind.label')), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(t('egp.posting.filter.clock.label')), { target: { value: 'DUE_SOON' } });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?clock=DUE_SOON'));
  });

  it('a filter that matches nothing leaves the table empty and not the empty register', async () => {
    mountWith({ world: { items: [posting(1)] }, path: '/bid/bid-32?clock=OVERDUE' });
    await waitFor(() => expect(screen.getByTestId('shown')).toBeTruthy());
    expect(document.querySelectorAll('[data-posting-id]')).toHaveLength(0);
    expect(screen.queryByTestId('empty')).toBeNull();
  });

  it('loads the next page on demand and keeps what is shown', async () => {
    const items = [1, 2, 3].map((n) => posting(n));
    const h = mountWith({ world: { items, pageSize: 2 } });
    await rowsShown();
    expect(document.querySelectorAll('[data-posting-id]')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: t('egp.posting.paging.more') }));
    await waitFor(() => expect(document.querySelectorAll('[data-posting-id]')).toHaveLength(3));
    expect(screen.getByTestId('shown').textContent).toBe(t('egp.posting.paging.summary', { shown: 3 }));
    expect(listReads(h).at(-1)).toMatchObject({ cursor: '2' });
  });
});

describe('PostingScreen: the commands', () => {
  it('prepares a posting with the fields the kind needs, filled from the register where it can, and sends the id, the version and the fields', async () => {
    const h = mountWith();
    await rowsShown();
    fireEvent.click(action(1, 'egp.posting.action.prepare.label'));
    const dialog = await dialogOf(t('egp.posting.prepare.title'));
    await waitFor(() => expect(within(dialog).getByLabelText(t('egp.posting.field.packageCode'))).toBeTruthy());
    expect(within(dialog).getByTestId('suggested-note').textContent).toBe(t('egp.posting.prepare.suggested.note'));
    expect((within(dialog).getByLabelText(t('egp.posting.field.packageCode')) as HTMLInputElement).value).toBe('GT-1');
    const confirm = within(dialog).getByRole('button', { name: t('egp.posting.prepare.confirm.action') });
    fireEvent.click(confirm);
    expect(await within(dialog).findByText(t('egp.posting.invalid.summary'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.field.publishedAt')), { target: { value: '2026-11-02' } });
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.field.bidClosingAt')), { target: { value: '2026-11-20' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('prepareEgpObligation', expect.objectContaining({ path: { id: postingId(1) }, body: { fields: { package_code: 'GT-1', published_at: '2026-11-02', bid_closing_at: '2026-11-20' } }, ifMatchVersion: 1 }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t('egp.posting.prepare.title') })).toBeNull());
    expect((await screen.findByTestId('receipt')).textContent).toBe(t('egp.posting.success.prepared', { kind: t('egp.posting.kind.notice'), code: 'GT-1' }));
  });

  it('offers the file of the contractor export for a violation, asks for the id of its batch, and sends it instead of the fields', async () => {
    const violation = posting(1, { kind: 'VIOLATION', obligation: 'Đăng thông tin nhà thầu vi phạm', subject_code: '0101234567' });
    const h = mountWith({ world: { items: [violation], details: new Map([[postingId(1), detail(violation, { required_fields: ['contractor_tax_code', 'behaviour_code', 'occurred_on', 'evidence_ref'], suggested_fields: {} })]]) } });
    await rowsShown();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: t('egp.posting.action.prepare.label', { kind: t('egp.posting.kind.violation'), code: '0101234567' }) }));
    const dialog = await dialogOf(t('egp.posting.prepare.title'));
    fireEvent.click(await within(dialog).findByRole('radio', { name: t('egp.posting.prepare.source.batch') }));
    expect(within(dialog).queryByLabelText(t('egp.posting.field.behaviourCode'))).toBeNull();
    expect(within(dialog).getByRole('link', { name: t('egp.posting.prepare.batch.link') }).getAttribute('href')).toBe('/ctr/ctr-24');
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.prepare.confirm.action') }));
    expect(await within(dialog).findByText(t('egp.posting.invalid.summary'))).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.prepare.batch.label')), { target: { value: BATCH.toUpperCase() } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.prepare.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('prepareEgpObligation', expect.objectContaining({ path: { id: postingId(1) }, body: { export_batch_id: BATCH }, ifMatchVersion: 1 }));
  });

  it('a notice has no choice of source: the file of the contractor export is for the evaluation and the violations only', async () => {
    mountWith();
    await rowsShown();
    fireEvent.click(action(1, 'egp.posting.action.prepare.label'));
    const dialog = await dialogOf(t('egp.posting.prepare.title'));
    await waitFor(() => expect(within(dialog).getByLabelText(t('egp.posting.field.packageCode'))).toBeTruthy());
    expect(within(dialog).queryByRole('radio')).toBeNull();
  });

  it('says in place which field of the packet the server refused', async () => {
    const h = mountWith({ command: () => Promise.reject(problem('VALIDATION_FAILED', 422, {}, 'fields.bid_closing_at')) });
    await rowsShown();
    fireEvent.click(action(1, 'egp.posting.action.prepare.label'));
    const dialog = await dialogOf(t('egp.posting.prepare.title'));
    await waitFor(() => expect(within(dialog).getByLabelText(t('egp.posting.field.bidClosingAt'))).toBeTruthy());
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.field.publishedAt')), { target: { value: '2026-11-02' } });
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.field.bidClosingAt')), { target: { value: 'khong hop le' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.prepare.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(await within(dialog).findByText(t('egp.posting.problem.validation'))).toBeTruthy();
    expect(dialog.querySelector('#posting-field-bid_closing_at-error')?.textContent).toBe(t('egp.posting.problem.validation'));
  });

  it('records that it was posted after another person prepared it, and refuses in place the one who prepared it', async () => {
    const h = mountWith({ command: () => Promise.reject(problem('SELF_APPROVAL_DENIED', 403)) });
    await rowsShown();
    fireEvent.click(action(2, 'egp.posting.action.submit.label'));
    const dialog = await dialogOf(t('egp.posting.submit.title'));
    expect(dialog.textContent).toContain('Nguyễn Văn An');
    expect(dialog.textContent).toContain(`${'a'.repeat(12)}…`);
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.submit.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('submitEgpObligation', expect.objectContaining({ path: { id: postingId(2) }, ifMatchVersion: 2 })));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(t('egp.posting.problem.selfApproval'));
  });

  it('a duty that the caller prepared shows no button to post it, only the words that another person does', async () => {
    mountWith({ world: { items: [prepared(2, { actions: { prepare: false, submit: false, receipt: false, reject: false, cancel: true } })] } });
    await rowsShown();
    expect(within(rowOf(2)).queryByRole('button', { name: new RegExp(t('egp.posting.action.submit')) })).toBeNull();
    expect(within(rowOf(2)).getByTestId('waiting-words').textContent).toBe(t('egp.posting.row.waitingSubmit'));
  });

  it('records the receipt: the reference and, if given, the time (Vietnam), and sends the id, the version and both', async () => {
    const h = mountWith({ world: { items: [submitted(3)] } });
    await rowsShown();
    fireEvent.click(action(3, 'egp.posting.action.receipt.label'));
    const dialog = await dialogOf(t('egp.posting.receipt.title'));
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.receipt.confirm.action') }));
    expect(await within(dialog).findByText(t('egp.posting.invalid.required'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.receipt.ref.label')), { target: { value: ' BN-2026-0042 ' } });
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.receipt.at.label')), { target: { value: '2025-11-08T10:30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.receipt.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('receiptEgpObligation', expect.objectContaining({ path: { id: postingId(3) }, body: { receipt_ref: 'BN-2026-0042', receipted_at: '2025-11-08T03:30:00.000Z' }, ifMatchVersion: 3 }));
    expect((await screen.findByTestId('receipt')).textContent).toBe(t('egp.posting.success.receipted', { kind: t('egp.posting.kind.notice'), code: 'GT-3', ref: 'BN-2026-0042' }));
  });

  it('sends no time when none is given, and refuses a time before the posting or in the future', async () => {
    const h = mountWith({ world: { items: [submitted(3)] } });
    await rowsShown();
    fireEvent.click(action(3, 'egp.posting.action.receipt.label'));
    const dialog = await dialogOf(t('egp.posting.receipt.title'));
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.receipt.ref.label')), { target: { value: 'BN-1' } });
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.receipt.at.label')), { target: { value: '2025-11-07T09:00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.receipt.confirm.action') }));
    expect(await within(dialog).findByText(t('egp.posting.invalid.day'))).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.receipt.at.label')), { target: { value: '2999-01-01T09:00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.receipt.confirm.action') }));
    expect(await within(dialog).findByText(t('egp.posting.invalid.future'))).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.receipt.at.label')), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.receipt.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('receiptEgpObligation', expect.objectContaining({ body: { receipt_ref: 'BN-1' } }));
  });

  it('says in place that a reference was already recorded for another posting', async () => {
    mountWith({ world: { items: [submitted(3)] }, command: () => Promise.reject(problem('EGP_RECEIPT_DUPLICATE', 409, {}, 'receipt_ref')) });
    await rowsShown();
    fireEvent.click(action(3, 'egp.posting.action.receipt.label'));
    const dialog = await dialogOf(t('egp.posting.receipt.title'));
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.receipt.ref.label')), { target: { value: 'BN-1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.receipt.confirm.action') }));
    expect(await within(dialog).findByText(t('egp.posting.problem.receiptDuplicate'))).toBeTruthy();
  });

  it('records a rejection with ten characters and sends the reason', async () => {
    const h = mountWith({ world: { items: [submitted(3)] } });
    await rowsShown();
    fireEvent.click(action(3, 'egp.posting.action.reject.label'));
    const dialog = await dialogOf(t('egp.posting.reject.title'));
    const confirm = within(dialog).getByRole('button', { name: t('egp.posting.reject.confirm.action') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(new RegExp(t('egp.posting.dialog.reason.label'))), { target: { value: 'ngắn' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(new RegExp(t('egp.posting.dialog.reason.label'))), { target: { value: REASON } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('rejectEgpObligation', expect.objectContaining({ path: { id: postingId(3) }, body: { reason: REASON }, ifMatchVersion: 3 })));
    expect((await screen.findByTestId('receipt')).textContent).toBe(t('egp.posting.success.rejected', { kind: t('egp.posting.kind.notice'), code: 'GT-3' }));
  });

  it('cancels only with twenty characters', async () => {
    const h = mountWith();
    await rowsShown();
    fireEvent.click(action(1, 'egp.posting.action.cancel.label'));
    const dialog = await dialogOf(t('egp.posting.cancel.title'));
    const confirm = within(dialog).getByRole('button', { name: t('egp.posting.cancel.confirm.action') }) as HTMLButtonElement;
    fireEvent.change(within(dialog).getByLabelText(new RegExp(t('egp.posting.dialog.reason.label'))), { target: { value: REASON.slice(0, 15) } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(new RegExp(t('egp.posting.dialog.reason.label'))), { target: { value: CANCEL_REASON } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('cancelEgpObligation', expect.objectContaining({ path: { id: postingId(1) }, body: { reason: CANCEL_REASON }, ifMatchVersion: 1 })));
  });

  it('a rejected posting is prepared again, and shows the reason of the rejection', async () => {
    mountWith({ world: { items: [rejected(4)] } });
    await rowsShown();
    expect(rowOf(4).textContent).toContain(t('egp.posting.cell.rejection', { reason: 'Thiếu ngày đóng thầu' }));
    expect(within(rowOf(4)).getByRole('button', { name: t('egp.posting.action.prepare.label', { kind: t('egp.posting.kind.notice'), code: 'GT-4' }) })).toBeTruthy();
  });

  it('a version conflict offers to reload and the reload reads the list again and closes the dialog', async () => {
    const h = mountWith({ command: () => Promise.reject(problem('VERSION_CONFLICT', 409)) });
    await rowsShown();
    fireEvent.click(action(1, 'egp.posting.action.cancel.label'));
    const dialog = await dialogOf(t('egp.posting.cancel.title'));
    fireEvent.change(within(dialog).getByLabelText(new RegExp(t('egp.posting.dialog.reason.label'))), { target: { value: CANCEL_REASON } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.cancel.confirm.action') }));
    expect(await within(dialog).findByText(t('egp.posting.problem.versionConflict'))).toBeTruthy();
    const before = listReads(h).length;
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.problem.reload.action') }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t('egp.posting.cancel.title') })).toBeNull());
    await waitFor(() => expect(listReads(h).length).toBeGreaterThan(before));
  });

  it('a second press while it is sending does not send twice', async () => {
    let release: () => void = () => undefined;
    const h = mountWith({ world: { items: [prepared(2)] }, command: () => new Promise((resolve) => (release = () => resolve({}))) });
    await rowsShown();
    fireEvent.click(action(2, 'egp.posting.action.submit.label'));
    const dialog = await dialogOf(t('egp.posting.submit.title'));
    const confirm = within(dialog).getByRole('button', { name: t('egp.posting.submit.confirm.action') }) as HTMLButtonElement;
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm.disabled).toBe(true));
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    release();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t('egp.posting.submit.title') })).toBeNull());
    expect(h.command).toHaveBeenCalledTimes(1);
  });
});

describe('PostingScreen: opening duties', () => {
  it('opens by hand for a notice: the kind, the code of the package and its project, the day; and sends them', async () => {
    const h = mountWith();
    await rowsShown();
    fireEvent.click(screen.getByTestId('open-button'));
    const dialog = await dialogOf(t('egp.posting.open.title'));
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.open.confirm.action') }));
    expect(await within(dialog).findByText(t('egp.posting.invalid.summary'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.open.code.label')), { target: { value: ' GT-0007 ' } });
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.open.project.label')), { target: { value: 'PRJ-1' } });
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.open.day.label')), { target: { value: '2999-01-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.open.confirm.action') }));
    expect(await within(dialog).findByText(t('egp.posting.invalid.future'))).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.open.day.label')), { target: { value: '2026-11-04' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.open.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('openEgpObligation', expect.objectContaining({ body: { kind: 'NOTICE', our_code: 'GT-0007', our_project_code: 'PRJ-1', triggered_on: '2026-11-04' } }));
    expect((await screen.findByTestId('receipt')).textContent).toBe(t('egp.posting.success.opened', { kind: t('egp.posting.kind.notice'), code: 'GT-0007' }));
  });

  it('names what the code is for the kind that is chosen, and asks for the project only where the subject is a package', async () => {
    mountWith();
    await rowsShown();
    fireEvent.click(screen.getByTestId('open-button'));
    const dialog = await dialogOf(t('egp.posting.open.title'));
    expect(within(dialog).getByText(t('egp.posting.open.subject.package'))).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.open.kind.label')), { target: { value: 'VIOLATION' } });
    expect(within(dialog).getByText(t('egp.posting.open.subject.contractor'))).toBeTruthy();
    expect(within(dialog).queryByLabelText(t('egp.posting.open.project.label'))).toBeNull();
  });

  it('says in place that the working calendar is missing', async () => {
    mountWith({ command: () => Promise.reject(problem('CALENDAR_NOT_EFFECTIVE', 422)) });
    await rowsShown();
    fireEvent.click(screen.getByTestId('open-button'));
    const dialog = await dialogOf(t('egp.posting.open.title'));
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.open.code.label')), { target: { value: 'GT-1' } });
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.open.day.label')), { target: { value: '2026-11-04' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.open.confirm.action') }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(t('egp.posting.problem.calendar'));
  });

  it('opens from the events of the register from a cutover day, says what it did, and says when there is more', async () => {
    const h = mountWith({ command: () => ({ since_on: '2026-10-01', opened: 3, existing: 1, outcomes: [{ fact: 'PLAN_APPROVED', kind: 'PLAN', opened: 3, existing: 1, truncated: true }] }) });
    await rowsShown();
    fireEvent.click(screen.getByTestId('sweep-button'));
    const dialog = await dialogOf(t('egp.posting.sweep.title'));
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.sweep.since.label')), { target: { value: '2999-01-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.sweep.confirm.action') }));
    expect(await within(dialog).findByText(t('egp.posting.invalid.future'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.sweep.since.label')), { target: { value: '2026-10-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.sweep.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('sweepEgpObligations', expect.objectContaining({ body: { since_on: '2026-10-01' } })));
    expect((await screen.findByTestId('receipt')).textContent).toBe(t('egp.posting.success.sweptMore', { opened: 3, existing: 1, since: '01/10/2026' }));
  });

  it('sweeps with the default cutover when no day is given', async () => {
    const h = mountWith({ command: () => ({ since_on: '2026-08-14', opened: 0, existing: 0, outcomes: [] }) });
    await rowsShown();
    fireEvent.click(screen.getByTestId('sweep-button'));
    const dialog = await dialogOf(t('egp.posting.sweep.title'));
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.sweep.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('sweepEgpObligations', expect.objectContaining({ body: {} })));
    expect((await screen.findByTestId('receipt')).textContent).toBe(t('egp.posting.success.swept', { opened: 0, existing: 0, since: '14/08/2026' }));
  });
});

describe('PostingScreen: the detail of a duty', () => {
  it('shows the history, the rule that gave the deadline with its "i", and the packet', async () => {
    mountWith({ world: { items: [prepared(2)] } });
    await rowsShown();
    fireEvent.click(action(2, 'egp.posting.action.details.label'));
    const panel = await screen.findByTestId('detail');
    await waitFor(() => expect(within(panel).getByTestId('history')).toBeTruthy());
    expect(within(panel).getByTestId('detail-rule').textContent).toContain(t('egp.posting.detail.rule', { due: 5, version: 0 }));
    expect(within(panel).getByTestId('detail-packet').textContent).toContain(`${'a'.repeat(12)}…`);
    expect(within(panel).getByTestId('history').textContent).toContain('Lê Văn Cường');
    fireEvent.click(within(panel).getByRole('button', { name: t('egp.mapping.info.open.label', { name: t('egp.posting.info.deadline.name') }) }));
    const rule = await dialogOf(t('egp.posting.info.deadline.name'));
    expect(rule.querySelector('[data-field="formula"]')?.textContent).toContain('Ngày phát sinh cộng 5 ngày làm việc');
    expect(rule.querySelector('[data-field="unverified"]')?.textContent).toBe(t('egp.posting.info.unverified.text'));
    fireEvent.keyDown(rule, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: t('egp.posting.detail.close.action') }));
    await waitFor(() => expect(screen.queryByTestId('detail')).toBeNull());
  });

  it('says when the detail cannot be read and reads it again on request', async () => {
    mountWith({ world: { items: [prepared(2)], details: new Map() } });
    await rowsShown();
    fireEvent.click(action(2, 'egp.posting.action.details.label'));
    expect(await screen.findByTestId('detail-error')).toBeTruthy();
  });
});

describe('PostingScreen: who may do what, and the states', () => {
  it('shows a reader the board and no button, with the reason', async () => {
    mountWith({ permissions: READER, world: { actions: { sweep: false, open: false, prepare: false, submit: false }, items: [posting(1, { actions: { prepare: false, submit: false, receipt: false, reject: false, cancel: false } }), submitted(3, { actions: { prepare: false, submit: false, receipt: false, reject: false, cancel: false } })] } });
    await rowsShown();
    expect(screen.queryByTestId('sweep-button')).toBeNull();
    expect(screen.queryByTestId('open-button')).toBeNull();
    expect(screen.getByTestId('readonly-note').textContent).toBe(t('egp.posting.readonly.right'));
    expect(within(rowOf(1)).queryByRole('button', { name: new RegExp(t('egp.posting.action.prepare')) })).toBeNull();
    expect(within(rowOf(1)).getByRole('button', { name: t('egp.posting.action.details.label', { kind: t('egp.posting.kind.notice'), code: 'GT-1' }) })).toBeTruthy();
    expect(screen.getByTestId('export-link').getAttribute('href')).toBe('/ctr/ctr-24');
  });

  it('a person who may only post sees the buttons to post and to record the receipt, not to open', async () => {
    mountWith({ permissions: SUBMITTER, world: { actions: { sweep: false, open: false, prepare: false, submit: true }, items: [prepared(2), submitted(3)] } });
    await rowsShown();
    expect(screen.queryByTestId('open-button')).toBeNull();
    expect(within(rowOf(2)).getByRole('button', { name: t('egp.posting.action.submit.label', { kind: t('egp.posting.kind.notice'), code: 'GT-2' }) })).toBeTruthy();
    expect(within(rowOf(3)).getByRole('button', { name: t('egp.posting.action.receipt.label', { kind: t('egp.posting.kind.notice'), code: 'GT-3' }) })).toBeTruthy();
    expect(screen.queryByTestId('readonly-note')).toBeNull();
  });

  it('shows no command while the tenant is read-only, and says why', async () => {
    mountWith({ mode: 'READ_ONLY' });
    await rowsShown();
    expect(screen.queryByTestId('sweep-button')).toBeNull();
    expect(screen.getByTestId('readonly-note').textContent).toBe(t('egp.posting.readonly.mode'));
  });

  it('a session whose permissions are not known keeps the buttons (the server decides)', async () => {
    mountWith({ permissions: undefined });
    await rowsShown();
    expect(screen.getByTestId('sweep-button')).toBeTruthy();
  });

  it('shows a skeleton while it loads, with the page already there', async () => {
    mountWith({ world: { hold: true } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t('egp.posting.page.title'));
    expect(document.querySelector('[data-posting-id]')).toBeNull();
    expect(screen.queryByTestId('empty')).toBeNull();
    expect(screen.queryByTestId('error')).toBeNull();
  });

  it('an empty register says why, tells what to do and links to the imports', async () => {
    mountWith({ world: { items: [] } });
    const empty = await screen.findByTestId('empty');
    expect(empty.textContent).toContain(t('egp.posting.empty.title'));
    expect(within(empty).getByRole('link', { name: t('egp.posting.empty.import.link') }).getAttribute('href')).toBe('/bid/bid-24');
    expect(screen.queryByRole('group', { name: t('egp.posting.chip.group.label') })).toBeNull();
  });

  it('a failed read says so, offers a retry, and the retry reads again', async () => {
    const state = world();
    state.failing.set('listEgpObligations', problem('INTERNAL_ERROR', 500));
    const h = client(state);
    mount(<PostingScreen route={route} />, h, { permissions: BOTH });
    const error = await screen.findByTestId('error');
    expect(error.textContent).toContain(t('egp.posting.error.title'));
    state.failing.clear();
    fireEvent.click(within(error).getByRole('button', { name: t('states.retry.action') }));
    await rowsShown();
    expect(screen.queryByTestId('error')).toBeNull();
  });

  it('a grant over part of the units is refused as a whole: the denied block, no duty, no button to open', async () => {
    const state = world();
    state.failing.set('listEgpObligations', problem('SCOPE_DENIED', 403));
    mount(<PostingScreen route={route} />, client(state), { permissions: BOTH });
    const denied = await screen.findByTestId('denied');
    expect(denied.textContent).toContain(t('egp.posting.denied.title'));
    expect(document.querySelector('[data-posting-id]')).toBeNull();
    expect(screen.queryByTestId('open-button')).toBeNull();
    expect(screen.queryByTestId('figures')).toBeNull();
  });

  it('marks the numbers as not up to date when a refresh fails after they were shown, and keeps them', async () => {
    const state = world();
    const h = client(state);
    mount(<PostingScreen route={route} />, h, { permissions: BOTH });
    await rowsShown();
    fireEvent.click(action(1, 'egp.posting.action.cancel.label'));
    const dialog = await dialogOf(t('egp.posting.cancel.title'));
    fireEvent.change(within(dialog).getByLabelText(new RegExp(t('egp.posting.dialog.reason.label'))), { target: { value: CANCEL_REASON } });
    state.failing.set('listEgpObligations', problem('INTERNAL_ERROR', 500));
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.cancel.confirm.action') }));
    await waitFor(() => expect(document.querySelector('.ui-context .ui-pill')).not.toBeNull());
    expect(document.querySelectorAll('[data-posting-id]')).toHaveLength(2);
    expect(screen.queryByTestId('error')).toBeNull();
  });

  it('names the scope and the adapter, and the day the figures are as of', async () => {
    mountWith();
    await rowsShown();
    const bar = document.querySelector('.ui-context') as HTMLElement;
    expect(bar.textContent).toContain('Cao Bang');
    expect(bar.textContent).toContain(t('egp.posting.context.adapter.value'));
    expect(bar.textContent).toContain('12/11/2026');
  });

  it('keeps the receipt a person has just written after the list was read again', async () => {
    const h = mountWith({ world: { items: [submitted(3)] } });
    await rowsShown();
    fireEvent.click(action(3, 'egp.posting.action.receipt.label'));
    const dialog = await dialogOf(t('egp.posting.receipt.title'));
    fireEvent.change(within(dialog).getByLabelText(t('egp.posting.receipt.ref.label')), { target: { value: 'BN-9' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.posting.receipt.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('receipt')).toBeTruthy());
    expect(listReads(h).length).toBeGreaterThanOrEqual(2);
  });
});
