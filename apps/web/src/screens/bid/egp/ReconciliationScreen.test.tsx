import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../../i18n';
import ReconciliationScreen from './ReconciliationScreen';
import { RECONCILER, READER, client, dueRule, item, itemId, madeByMe, noticeItem, overdueItem, problem, route, settled, mount, world } from './test/reconcile-test-support';
import type { World } from './test/reconcile-test-support';

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
  mount(<ReconciliationScreen route={route} />, h, { permissions: options.permissions === undefined && 'permissions' in options ? undefined : (options.permissions ?? RECONCILER), ...(options.mode === undefined ? {} : { mode: options.mode }), ...(options.path === undefined ? {} : { path: options.path }) });
  return h;
}

const rowOf = (n: number): HTMLElement => document.querySelector(`[data-item-id="${itemId(n)}"]`) as HTMLElement;
const listReads = (h: ReturnType<typeof client>): Array<Record<string, unknown>> => h.read.mock.calls.filter(([operation]) => operation === 'listEgpReconciliationItems').map(([, input]) => (input as { query: Record<string, unknown> }).query);
const rowsShown = async (): Promise<void> => {
  await waitFor(() => expect(document.querySelector('[data-item-id]')).not.toBeNull());
};
const LONG = 'Số trên mạng là đúng theo thông báo mời thầu';
const SENTENCE = 'Số trên mạng sai so với quyết định phê duyệt kế hoạch';

async function openResolve(n = 1): Promise<HTMLElement> {
  await rowsShown();
  fireEvent.click(within(rowOf(n)).getByRole('button', { name: new RegExp(`^${t('egp.reconcile.row.resolve.action')}`) }));
  return screen.findByRole('dialog', { name: t('egp.reconcile.resolve.title') });
}

const choose = (dialog: HTMLElement, label: string): void => {
  fireEvent.click(within(dialog).getByRole('radio', { name: new RegExp(label) }));
};
const writeReason = (dialog: HTMLElement, text: string): void => {
  fireEvent.change(within(dialog).getByLabelText(new RegExp(t('egp.reconcile.dialog.reason.label'))), { target: { value: text } });
};
const confirmButton = (dialog: HTMLElement): HTMLButtonElement => within(dialog).getByRole('button', { name: t('egp.reconcile.resolve.confirm.action') });
const send = (dialog: HTMLElement): void => {
  fireEvent.click(confirmButton(dialog));
};
const runButton = (): HTMLElement => screen.getByTestId('run-button');

describe('ReconciliationScreen (BID-33): our register against what the national network said', () => {
  it('UI-BID-33: shows the badge of the assumed layout, the notes, the caption, the columns and the summary of the catalogue', async () => {
    mountWith();
    await rowsShown();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t('egp.reconcile.page.title'));
    expect(screen.getByTestId('assumption-badge').textContent).toBe('Mẫu tệp là giả định (PENDING-EXTERNAL)');
    expect(screen.getByTestId('assumption-badge').textContent).toBe(t('egp.reconcile.badge.assumption'));
    expect(screen.getByTestId('maker-note').textContent).toBe(t('egp.reconcile.note.maker'));
    expect(screen.getByTestId('unverified-note').textContent).toContain(t('egp.reconcile.note.unverified', { days: 10 }));
    const table = screen.getByRole('table', { name: t('egp.reconcile.table.caption') });
    expect(Array.from(table.querySelectorAll('thead th')).map((cell) => cell.textContent)).toEqual(['subject', 'field', 'ours', 'theirs', 'delta', 'owner', 'due', 'resolution', 'actions'].map((column) => t(`egp.reconcile.column.${column}` as never)));
    expect(screen.getByRole('region', { name: t('egp.reconcile.table.caption') })).toBeTruthy();
    expect(screen.getByTestId('summary').textContent).toContain(t('egp.reconcile.summary.text', { open: 1, overdue: 0, waivers: 0 }));
    expect(document.querySelector('[data-screen-id="BID-33"]')).not.toBeNull();
    expect(document.querySelector('.prototype-note')?.textContent).toBe('BID-33 · FR-BID-33');
    expect(screen.getByTestId('shown').textContent).toBe(t('egp.reconcile.paging.summary', { shown: 2 }));
  });

  it('shows an amount with the thousands marked, the signed difference, the day in Vietnam and the owner, and what a settled item was settled with', async () => {
    mountWith({ world: { items: [item(1), noticeItem(3), settled(2)] } });
    await rowsShown();
    const money = rowOf(1);
    expect(money.textContent).toContain('1.000.000.000');
    expect(money.textContent).toContain('1.200.000.000');
    expect(money.textContent).toContain('+200.000.000');
    expect(money.textContent).toContain(t('egp.reconcile.field.estimatedPrice'));
    expect(money.textContent).toContain('Lê Văn Cường');
    expect(money.textContent).toContain(t('egp.reconcile.cell.external', { code: 'IB26001' }));
    expect(money.textContent).toContain(t('egp.reconcile.difference.valueMismatch'));
    const notice = rowOf(3);
    expect(notice.textContent).toContain('23/10/2026');
    expect(notice.textContent).toContain('25/10/2026');
    expect(notice.textContent).toContain(t('egp.reconcile.field.bidClosingAt'));
    const done = rowOf(2).querySelector('[data-testid="resolution"]') as HTMLElement;
    expect(done.textContent).toContain(t('egp.reconcile.resolution.dispute'));
    expect(done.textContent).toContain(t('egp.reconcile.cell.resolved', { name: 'Nguyễn Văn An', day: '04/11/2026' }));
    expect(done.textContent).toContain('Số trên mạng sai so với quyết định phê duyệt');
    expect(done.textContent).toContain(t('egp.reconcile.cell.evidence', { evidence: 'CV-77/SKHDT' }));
    expect(done.textContent).toContain(t('egp.reconcile.followUp.escalate'));
    expect(within(rowOf(2)).queryByRole('button', { name: new RegExp(`^${t('egp.reconcile.row.resolve.action')}`) })).toBeNull();
  });

  it('marks what is overdue and counts it', async () => {
    mountWith({ world: { items: [overdueItem(1), item(2)] } });
    await rowsShown();
    expect(within(rowOf(1)).getByText(t('egp.reconcile.cell.overdue'))).toBeTruthy();
    expect(within(rowOf(2)).queryByText(t('egp.reconcile.cell.overdue'))).toBeNull();
    expect(screen.getByRole('button', { name: t('egp.reconcile.chip.overdue', { count: 1 }) })).toBeTruthy();
    expect(screen.getByTestId('summary').textContent).toContain(t('egp.reconcile.summary.text', { open: 2, overdue: 1, waivers: 0 }));
  });

  it('the "i" of the count says the formula, the source, the day, who answers and the rule behind the due time, with the flag that nothing was confirmed', async () => {
    mountWith();
    await rowsShown();
    const summary = screen.getByTestId('summary');
    fireEvent.click(within(summary).getByRole('button', { name: t('egp.mapping.info.open.label', { name: t('egp.reconcile.info.count.name') }) }));
    const panel = await screen.findByRole('dialog', { name: t('egp.reconcile.info.count.name') });
    expect(panel.querySelector('[data-field="formula"]')?.textContent).toContain(t('egp.reconcile.info.count.formula'));
    expect(panel.querySelector('[data-field="source"]')?.textContent).toContain('egp_record');
    expect(panel.querySelector('[data-field="asOf"]')?.textContent).toContain('12/11/2026');
    expect(panel.querySelector('[data-field="owner"]')?.textContent).toContain(t('egp.reconcile.info.owner.text'));
    expect(panel.querySelector('[data-field="version"]')?.textContent).toContain(t('egp.reconcile.info.version.default', { version: 0, legal: 'UNVERIFIED' }));
    expect(panel.querySelector('[data-field="unverified"]')?.textContent).toBe(t('egp.reconcile.info.unverified.text'));
  });

  it('the "i" of the difference of an amount carries the formula and source of the server, and the "i" of the due time the rule of the due time', async () => {
    mountWith({ world: { items: [item(1)] } });
    await rowsShown();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: t('egp.mapping.info.open.label', { name: t('egp.reconcile.info.delta.name') }) }));
    const panel = await screen.findByRole('dialog', { name: t('egp.reconcile.info.delta.name') });
    expect(panel.querySelector('[data-field="formula"]')?.textContent).toContain('Chênh lệch = số trên mạng trừ số của đơn vị');
    expect(panel.querySelector('[data-field="source"]')?.textContent).toContain('Bản ghi egp_record của tệp đã nhập');
    fireEvent.keyDown(panel, { key: 'Escape' });
    fireEvent.click(within(screen.getByTestId('unverified-note')).getByRole('button', { name: t('egp.mapping.info.open.label', { name: t('egp.reconcile.info.due.name') }) }));
    const due = await screen.findByRole('dialog', { name: t('egp.reconcile.info.due.name') });
    expect(due.querySelector('[data-field="formula"]')?.textContent).toContain('Ngày mở cộng 10 ngày làm việc theo lịch đã công bố');
    expect(due.querySelector('[data-field="source"]')?.textContent).toContain('Quy tắc EGP_RECONCILIATION_POLICY của hệ thống');
  });

  it('an amount of an item that has none (a day, a name) has no "i" on its difference', async () => {
    mountWith({ world: { items: [noticeItem(3)] } });
    await rowsShown();
    expect(within(rowOf(3)).queryByRole('button', { name: t('egp.mapping.info.open.label', { name: t('egp.reconcile.info.delta.name') }) })).toBeNull();
  });

  it('a rule the tenant approved is said as such and its note about being unverified goes away', async () => {
    mountWith({ world: { dueRule: dueRule({ source: 'RULE', version: 3, unverified: false, legal_status: 'VERIFIED' }) } });
    await rowsShown();
    expect(screen.queryByTestId('unverified-note')).toBeNull();
    fireEvent.click(within(screen.getByTestId('summary')).getByRole('button', { name: t('egp.mapping.info.open.label', { name: t('egp.reconcile.info.count.name') }) }));
    const panel = await screen.findByRole('dialog', { name: t('egp.reconcile.info.count.name') });
    expect(panel.querySelector('[data-field="version"]')?.textContent).toContain(t('egp.reconcile.info.version.rule', { version: 3, legal: 'VERIFIED' }));
    expect(panel.querySelector('[data-field="unverified"]')).toBeNull();
  });
});

describe('ReconciliationScreen: the view kept in the address', () => {
  it('the chips set the state, "all" clears it, the overdue chip replaces the state, and each asks the server again', async () => {
    const h = mountWith({ world: { items: [overdueItem(1), item(2), settled(3)] } });
    await rowsShown();
    expect(screen.getByRole('button', { name: t('egp.reconcile.chip.all', { count: 3 }) }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: t('egp.reconcile.chip.resolved', { count: 1 }) }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?state=RESOLVED'));
    await waitFor(() => expect(document.querySelector('[data-item-id]')?.getAttribute('data-state')).toBe('RESOLVED'));
    expect(document.querySelectorAll('[data-item-id]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: t('egp.reconcile.chip.overdue', { count: 1 }) }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?overdue=true'));
    await waitFor(() => expect(document.querySelectorAll('[data-item-id]')).toHaveLength(1));
    expect(rowOf(1)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('egp.reconcile.chip.open', { count: 2 }) }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?state=OPEN'));
    fireEvent.click(screen.getByRole('button', { name: t('egp.reconcile.chip.all', { count: 3 }) }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(''));
    await waitFor(() => expect(document.querySelectorAll('[data-item-id]')).toHaveLength(3));
    expect(listReads(h).map((query) => query.state)).toEqual(expect.arrayContaining([undefined, 'RESOLVED', 'OPEN']));
    expect(listReads(h).some((query) => query.overdue === 'true')).toBe(true);
  });

  it('the subject and "only mine" go to the address and to the server, and a link opens the view they describe', async () => {
    const h = mountWith({ path: '/?subject_type=NOTICE&mine=true', world: { items: [noticeItem(3), item(1), item(4, { owner_id: 'someone-else' })] } });
    await waitFor(() => expect(document.querySelectorAll('[data-item-id]')).toHaveLength(1));
    expect(rowOf(3)).not.toBeNull();
    expect((screen.getByLabelText(t('egp.reconcile.filter.subject.label')) as HTMLSelectElement).value).toBe('NOTICE');
    expect((screen.getByLabelText(t('egp.reconcile.filter.mine.label')) as HTMLInputElement).checked).toBe(true);
    expect(listReads(h)[0]).toMatchObject({ subject_type: 'NOTICE', mine: 'true', limit: 50 });
    fireEvent.click(screen.getByLabelText(t('egp.reconcile.filter.mine.label')));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?subject_type=NOTICE'));
    fireEvent.change(screen.getByLabelText(t('egp.reconcile.filter.subject.label')), { target: { value: 'PACKAGE' } });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?subject_type=PACKAGE'));
    await waitFor(() => expect(document.querySelectorAll('[data-item-id]')).toHaveLength(2));
    fireEvent.change(screen.getByLabelText(t('egp.reconcile.filter.subject.label')), { target: { value: '' } });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(''));
  });

  it('loads the next page on demand and keeps what is shown', async () => {
    mountWith({ world: { items: [item(1), item(2), item(3)], pageSize: 2 } });
    await rowsShown();
    expect(document.querySelectorAll('[data-item-id]')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: t('egp.reconcile.paging.more') }));
    await waitFor(() => expect(document.querySelectorAll('[data-item-id]')).toHaveLength(3));
    expect(screen.getByTestId('shown').textContent).toBe(t('egp.reconcile.paging.summary', { shown: 3 }));
    expect(screen.queryByRole('button', { name: t('egp.reconcile.paging.more') })).toBeNull();
  });

  it('a filter that matches nothing says so and offers to clear it', async () => {
    mountWith({ path: '/?state=RESOLVED&subject_type=CONTRACTOR' });
    await waitFor(() => expect(screen.getByTestId('shown')).toBeTruthy());
    expect(document.querySelectorAll('[data-item-id]')).toHaveLength(0);
    expect(screen.queryByTestId('empty')).toBeNull();
  });
});

describe('ReconciliationScreen: running the reconciliation', () => {
  it('runs it with no subject, says what it did, and reads the list again', async () => {
    const h = mountWith({ command: () => ({ examined: 4, differences: 3, opened: 2, unchanged: 1, settled_already: 0, no_owner: 0, items: [], as_of: '2026-11-12T03:00:00.000Z' }) });
    await rowsShown();
    const before = listReads(h).length;
    fireEvent.click(runButton());
    const receipt = await screen.findByTestId('receipt');
    expect(receipt.textContent).toBe(t('egp.reconcile.success.run', { examined: 4, differences: 3, opened: 2, unchanged: 1, settled: 0 }));
    expect(h.command).toHaveBeenCalledTimes(1);
    expect(h.command).toHaveBeenCalledWith('runEgpReconciliation', expect.objectContaining({ body: {} }));
    expect(screen.queryByTestId('no-owner-note')).toBeNull();
    await waitFor(() => expect(listReads(h).length).toBeGreaterThan(before));
  });

  it('runs it for the subject that is chosen, and warns when a difference found nobody who may settle it', async () => {
    const h = mountWith({ path: '/?subject_type=NOTICE', command: () => ({ examined: 1, differences: 1, opened: 0, unchanged: 0, settled_already: 0, no_owner: 1 }) });
    await screen.findByTestId('shown');
    fireEvent.click(screen.getByRole('button', { name: t('egp.reconcile.action.runSubject', { subject: t('egp.reconcile.subject.notice') }) }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('runEgpReconciliation', expect.objectContaining({ body: { subject_type: 'NOTICE' } })));
    expect((await screen.findByTestId('no-owner-note')).textContent).toBe(t('egp.reconcile.note.noOwner', { count: 1 }));
  });

  it('says in place when the run was refused', async () => {
    mountWith({ command: () => problem('CALENDAR_NOT_EFFECTIVE', 422) });
    await rowsShown();
    fireEvent.click(runButton());
    expect((await screen.findByTestId('run-error')).textContent).toBe(t('egp.reconcile.run.error'));
    expect(screen.queryByTestId('receipt')).toBeNull();
  });

  it('shows no run button to a person without the right, or when the server says no, or while the tenant is read-only, and says why', async () => {
    mountWith({ permissions: READER });
    await rowsShown();
    expect(screen.queryByTestId('run-button')).toBeNull();
    expect(screen.getByTestId('readonly-note').textContent).toBe(t('egp.reconcile.readonly.right'));
    cleanup();
    mountWith({ world: { canRun: false } });
    await rowsShown();
    expect(screen.queryByTestId('run-button')).toBeNull();
    cleanup();
    mountWith({ mode: 'READ_ONLY' });
    await rowsShown();
    expect(screen.queryByTestId('run-button')).toBeNull();
    expect(screen.getByTestId('readonly-note').textContent).toBe(t('egp.reconcile.readonly.mode'));
    expect(within(rowOf(1)).queryByRole('button', { name: new RegExp(`^${t('egp.reconcile.row.resolve.action')}`) })).toBeNull();
  });

  it('a session whose permissions are not known keeps the buttons (the server decides)', async () => {
    mountWith({ permissions: undefined });
    await rowsShown();
    expect(screen.getByTestId('run-button')).toBeTruthy();
    expect(within(rowOf(1)).getByRole('button', { name: new RegExp(`^${t('egp.reconcile.row.resolve.action')}`) })).toBeTruthy();
  });
});

describe('ReconciliationScreen: settling an item', () => {
  it('the person who made the record sees the words instead of a button', async () => {
    mountWith({ world: { items: [madeByMe(1), item(2)] } });
    await rowsShown();
    expect(within(rowOf(1)).queryByRole('button', { name: new RegExp(`^${t('egp.reconcile.row.resolve.action')}`) })).toBeNull();
    expect(within(rowOf(1)).getByTestId('maker-words').textContent).toBe(t('egp.reconcile.row.maker'));
    expect(within(rowOf(2)).queryByTestId('maker-words')).toBeNull();
    expect(within(rowOf(2)).getByRole('button', { name: new RegExp(`^${t('egp.reconcile.row.resolve.action')}`) })).toBeTruthy();
  });

  it('names the difference and the owner, offers the four resolutions each with what it does, and says that accepting changes nothing from here', async () => {
    mountWith();
    const dialog = await openResolve();
    expect(dialog.textContent).toContain('GT-1');
    expect(dialog.textContent).toContain(t('egp.reconcile.field.estimatedPrice'));
    expect(dialog.textContent).toContain('1.000.000.000');
    expect(dialog.textContent).toContain('1.200.000.000');
    expect(dialog.textContent).toContain('Lê Văn Cường');
    expect(within(dialog).getAllByRole('radio')).toHaveLength(4);
    for (const kind of ['acceptExternal', 'correctOurs', 'dispute', 'waive']) {
      expect(within(dialog).getByRole('radio', { name: new RegExp(t(`egp.reconcile.resolution.${kind}` as never)) })).toBeTruthy();
      expect(dialog.textContent).toContain(t(`egp.reconcile.effect.${kind}` as never));
    }
    expect(t('egp.reconcile.effect.acceptExternal')).toContain('không sửa từ màn hình này');
    expect((within(dialog).getByRole('radio', { name: new RegExp(t('egp.reconcile.resolution.acceptExternal')) }) as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).queryByLabelText(t('egp.reconcile.dialog.evidence.label'))).toBeNull();
    expect(within(dialog).queryByLabelText(t('egp.reconcile.dialog.reviewOn.label'))).toBeNull();
  });

  it('accepts the figure of the network: ten characters are enough, and the command carries the id, the version and the reason', async () => {
    const h = mountWith();
    const dialog = await openResolve();
    expect(confirmButton(dialog).disabled).toBe(true);
    writeReason(dialog, 'Quá ngắn');
    expect(confirmButton(dialog).disabled).toBe(true);
    writeReason(dialog, LONG);
    expect(confirmButton(dialog).disabled).toBe(false);
    send(dialog);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('resolveEgpReconciliationItem', expect.objectContaining({ path: { id: itemId(1) }, body: { kind: 'ACCEPT_EXTERNAL', reason: LONG }, ifMatchVersion: 1 }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t('egp.reconcile.resolve.title') })).toBeNull());
    expect((await screen.findByTestId('receipt')).textContent).toBe(
      t('egp.reconcile.success.resolved', { kind: t('egp.reconcile.resolution.acceptExternal'), field: t('egp.reconcile.field.estimatedPrice'), subject: t('egp.reconcile.subject.package'), code: 'GT-1' }),
    );
  });

  it('corrects ours with ten characters', async () => {
    const h = mountWith();
    const dialog = await openResolve();
    choose(dialog, t('egp.reconcile.resolution.correctOurs'));
    writeReason(dialog, '1234567890');
    expect(confirmButton(dialog).disabled).toBe(false);
    send(dialog);
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command).toHaveBeenCalledWith('resolveEgpReconciliationItem', expect.objectContaining({ path: { id: itemId(1) }, body: { kind: 'CORRECT_OURS', reason: '1234567890' }, ifMatchVersion: 1 }));
  });

  it('disputes only with twenty characters and the letter, and sends both', async () => {
    const h = mountWith();
    const dialog = await openResolve();
    writeReason(dialog, LONG);
    choose(dialog, t('egp.reconcile.resolution.dispute'));
    // The reason that was long enough for accepting is long enough for a dispute too; a shorter one is not.
    writeReason(dialog, '1234567890123');
    expect(confirmButton(dialog).disabled).toBe(true);
    writeReason(dialog, SENTENCE);
    expect(confirmButton(dialog).disabled).toBe(false);
    send(dialog);
    expect(await within(dialog).findByText(t('egp.reconcile.invalid.required'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(t('egp.reconcile.dialog.evidence.label')), { target: { value: 'CV-77/SKHDT ngày 05/11/2026' } });
    send(dialog);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('resolveEgpReconciliationItem', expect.objectContaining({ path: { id: itemId(1) }, body: { kind: 'DISPUTE', reason: SENTENCE, evidence_ref: 'CV-77/SKHDT ngày 05/11/2026' }, ifMatchVersion: 1 }));
  });

  it('waives with twenty characters and a day after today within a year, refusing a day that is past or too far', async () => {
    const h = mountWith();
    const dialog = await openResolve();
    choose(dialog, t('egp.reconcile.resolution.waive'));
    writeReason(dialog, 'Để lại đến khi có biên bản xác nhận của chủ đầu tư');
    const day = within(dialog).getByLabelText(t('egp.reconcile.dialog.reviewOn.label'));
    send(dialog);
    expect(await within(dialog).findByText(t('egp.reconcile.invalid.required'))).toBeTruthy();
    fireEvent.change(day, { target: { value: '2020-01-01' } });
    send(dialog);
    expect(await within(dialog).findByText(t('egp.reconcile.invalid.notFuture'))).toBeTruthy();
    fireEvent.change(day, { target: { value: '2999-01-01' } });
    send(dialog);
    expect(await within(dialog).findByText(t('egp.reconcile.invalid.tooFar'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    const next = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    fireEvent.change(day, { target: { value: next } });
    send(dialog);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('resolveEgpReconciliationItem', expect.objectContaining({ path: { id: itemId(1) }, body: { kind: 'WAIVE', reason: 'Để lại đến khi có biên bản xác nhận của chủ đầu tư', review_on: next }, ifMatchVersion: 1 }));
  });

  it('cancels without sending anything', async () => {
    const h = mountWith();
    const dialog = await openResolve();
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.mapping.dialog.cancel.action') }));
    expect(screen.queryByRole('dialog', { name: t('egp.reconcile.resolve.title') })).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it.each([
    ['SELF_APPROVAL_DENIED', 403, 'egp.reconcile.problem.self'],
    ['EGP_RECONCILIATION_STATE_INVALID', 409, 'egp.reconcile.problem.state'],
    ['CALENDAR_NOT_EFFECTIVE', 422, 'egp.reconcile.problem.calendar'],
    ['RESOURCE_NOT_FOUND', 404, 'egp.reconcile.problem.notFound'],
    ['SCOPE_DENIED', 403, 'egp.reconcile.problem.forbidden'],
    ['BOOM', 500, 'egp.reconcile.problem.general'],
  ])('says in the dialog why %s refused it, and keeps the dialog open', async (code, status, key) => {
    const h = mountWith({ command: () => problem(code, status) });
    const dialog = await openResolve();
    writeReason(dialog, LONG);
    send(dialog);
    expect((await within(dialog).findByRole('alert')).textContent).toBe(t(key as never));
    expect(screen.getByRole('dialog', { name: t('egp.reconcile.resolve.title') })).toBeTruthy();
    expect(h.command).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('receipt')).toBeNull();
  });

  it('names the field a validation refused, in the words of the screen', async () => {
    mountWith({ command: () => problem('VALIDATION_FAILED', 422, {}, 'review_on') });
    const dialog = await openResolve();
    writeReason(dialog, LONG);
    send(dialog);
    expect((await within(dialog).findByRole('alert')).textContent).toBe(t('egp.reconcile.problem.field.reviewOn'));
  });

  it('a version conflict offers to reload the list, and the reload reads again and closes the dialog', async () => {
    const h = mountWith({ command: () => problem('VERSION_CONFLICT', 409) });
    const dialog = await openResolve();
    writeReason(dialog, LONG);
    send(dialog);
    expect((await within(dialog).findByRole('alert')).textContent).toBe(t('egp.reconcile.problem.version'));
    const before = listReads(h).length;
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.reconcile.problem.reload.action') }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t('egp.reconcile.resolve.title') })).toBeNull());
    await waitFor(() => expect(listReads(h).length).toBeGreaterThan(before));
  });

  it('a second press while it is sending does not send twice', async () => {
    let release: () => void = () => undefined;
    const h = mountWith({ command: () => new Promise((resolve) => (release = () => resolve({}))) });
    const dialog = await openResolve();
    writeReason(dialog, LONG);
    send(dialog);
    const pending = dialog.querySelector('.ui-dialog__actions button:last-child') as HTMLButtonElement;
    await waitFor(() => expect(pending.disabled).toBe(true));
    fireEvent.click(pending);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    release();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: t('egp.reconcile.resolve.title') })).toBeNull());
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('a row owned by someone else that the server lets the caller settle is settled the same way', async () => {
    const h = mountWith({ world: { items: [item(5, { owner_id: 'someone-else', owner_name: 'Phạm Thị Dung' })] } });
    const dialog = await openResolve(5);
    expect(dialog.textContent).toContain('Phạm Thị Dung');
    writeReason(dialog, LONG);
    send(dialog);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('resolveEgpReconciliationItem', expect.objectContaining({ path: { id: itemId(5) } })));
  });
});

describe('ReconciliationScreen: the states', () => {
  it('shows a skeleton while it loads, with the page already there', async () => {
    mountWith({ world: { hold: true } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t('egp.reconcile.page.title'));
    expect(screen.getByRole('table', { name: t('egp.reconcile.table.caption') })).toBeTruthy();
    expect(document.querySelector('[data-item-id]')).toBeNull();
    expect(screen.queryByTestId('run-button')).toBeNull();
    expect(screen.queryByTestId('empty')).toBeNull();
    expect(screen.queryByTestId('error')).toBeNull();
  });

  it('an empty register says why, tells what to do and links to the imports', async () => {
    mountWith({ world: { items: [] } });
    const empty = await screen.findByTestId('empty');
    expect(empty.textContent).toContain(t('egp.reconcile.empty.title'));
    expect(empty.textContent).toContain(t('egp.reconcile.empty.body'));
    expect(within(empty).getByRole('link', { name: t('egp.reconcile.empty.import.link') }).getAttribute('href')).toBe('/bid/bid-24');
    expect(screen.getByTestId('run-button')).toBeTruthy();
    expect(screen.queryByRole('group', { name: t('egp.reconcile.chip.group.label') })).toBeNull();
  });

  it('a failed read says so, offers a retry, and the retry reads again', async () => {
    const world = { failing: new Map<string, Error>([['listEgpReconciliationItems', problem('INTERNAL_ERROR', 500)]]) };
    const h = mountWith({ world });
    const error = await screen.findByTestId('error');
    expect(error.textContent).toContain(t('egp.reconcile.error.title'));
    expect(screen.queryByTestId('run-button')).toBeNull();
    const before = listReads(h).length;
    fireEvent.click(within(error).getByRole('button', { name: t('states.retry.action') }));
    await waitFor(() => expect(listReads(h).length).toBeGreaterThan(before));
  });

  it('a grant over part of the units is refused as a whole: the denied block, no item, no run', async () => {
    mountWith({ world: { failing: new Map<string, Error>([['listEgpReconciliationItems', problem('SCOPE_DENIED', 403)]]) } });
    const denied = await screen.findByTestId('denied');
    expect(denied.textContent).toContain(t('egp.reconcile.denied.title'));
    expect(denied.textContent).toContain(t('egp.reconcile.denied.body'));
    expect(screen.queryByTestId('run-button')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('marks the numbers as not up to date when a refresh fails after they were shown, and keeps them', async () => {
    const state = world();
    const h = client(state);
    mount(<ReconciliationScreen route={route} />, h, { permissions: RECONCILER });
    await rowsShown();
    state.failing.set('listEgpReconciliationItems', problem('INTERNAL_ERROR', 500));
    fireEvent.click(screen.getByTestId('run-button'));
    await waitFor(() => expect(document.querySelector('.ui-context .ui-pill')).not.toBeNull());
    expect(document.querySelector('.ui-context')?.textContent).toContain(t('ui.contextBar.staleAsOf', { time: '12/11/2026' }));
    expect(document.querySelectorAll('[data-item-id]')).toHaveLength(2);
    expect(screen.queryByTestId('error')).toBeNull();
  });

  it('shows the scope, the working days of the rule and the day the figures are as of', async () => {
    mountWith();
    await rowsShown();
    const context = document.querySelector('.ui-context') as HTMLElement;
    expect(context.textContent).toContain('Cao Bang');
    expect(context.textContent).toContain(t('egp.reconcile.context.rule.value', { days: 10 }));
    expect(context.textContent).toContain(t('ui.contextBar.asOf', { time: '12/11/2026' }));
  });
});
