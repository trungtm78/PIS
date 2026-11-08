import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import base from '../../../i18n/vi.json';
import ReputationScreen from './ReputationScreen';
import { ALL, CONTRACTOR, DOCUMENT, OTHER, READER, client, mount, reputationEvent, reputationPage, routeOf, uuid, venture } from '../shared/test/vnd-test-support';
import type { World } from '../shared/test/vnd-test-support';

const word = (key: string): string => (base as Record<string, string>)[key] ?? key;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)), word(key));
const problem = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) });
const route = routeOf('VND-06', 'FR-VND-06');
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
const labelOf = (label: string): RegExp => new RegExp(escaped(label));
const EVENT = uuid('0012', 1);

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

const type = (scope: HTMLElement, label: string, value: string): void => {
  fireEvent.change(within(scope).getByLabelText(labelOf(label)), { target: { value } });
};
const dialog = (name: string): HTMLElement => screen.getByRole('dialog', { name });

interface Options {
  permissions?: string[];
  mode?: 'FULL' | 'READ_ONLY';
  command?: (operation: string, input: unknown) => unknown;
  path?: string;
  failing?: World['failing'];
}

const venturePage = (items: Array<Record<string, unknown>> = [venture(1)]) => ({ items, as_of: '2026-11-08T03:00:00.000Z' });

function open(events: Array<Record<string, unknown>> = [reputationEvent(1)], options: Options = {}, ventures: Array<Record<string, unknown>> = [venture(1)]) {
  const world: World = { answers: { listVendorReputationEvents: reputationPage(events), listVendorJointVentures: venturePage(ventures) }, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world, options.command);
  mount(<ReputationScreen route={route} />, h, { permissions: options.permissions ?? ALL, path: options.path ?? '/vnd/vnd-06', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, world };
}

const eventRows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-event-id]'));
const loaded = async (): Promise<void> => {
  await screen.findAllByText(word('vnd.behaviour.noBidSecurity.name'));
};

describe('ReputationScreen (VND-06): the events of bid conduct', () => {
  it('lists the events with the contractor, the behaviour, the day, who recorded it and the clock of seven working days', async () => {
    open();
    await loaded();
    const [row] = eventRows();
    expect(within(row as HTMLElement).getByRole('link', { name: 'Công ty nhà thầu 1' }).getAttribute('href')).toBe(`/vnd/vnd-02?contractor=${CONTRACTOR}`);
    expect(row?.textContent).toContain(word('vnd.behaviour.noBidSecurity.name'));
    expect(row?.textContent).toContain('Không nộp bảo đảm dự thầu đúng hạn');
    expect(row?.textContent).toContain('30/10/2026');
    expect(row?.textContent).toContain(word('vnd.eventStatus.recorded.name'));
    expect(row?.textContent).toContain(text('vnd.reputation.recorded.text', { name: 'Lê Thị Hoa', time: '02/11/2026 09:00' }));
    expect(row?.textContent).toContain(word('vnd.clock.onTime.name'));
    expect(row?.textContent).toContain(text('alerts.deadline.left', { days: 3, date: '11/11' }));
    expect(row?.textContent).toContain(text('vnd.reputation.due.text', { time: '11/11/2026 09:00' }));
  });

  it('shows an overdue clock with the days late, a posted event with who posted it and the receipt, and a retracted one with its reason', async () => {
    open([
      reputationEvent(1, { clock: 'OVERDUE', post_due_at: '2026-11-05T02:00:00.000Z' }),
      reputationEvent(2, { status: 'POSTED', clock: 'MET', posted_by_name: 'Phạm Quốc Bảo', posted_at: '2026-11-04T02:00:00.000Z', posting_ref: 'BN-2026-0042', may_post: false }),
      reputationEvent(3, { status: 'RETRACTED', clock: 'ON_TIME', retracted_at: '2026-11-03T02:00:00.000Z', retract_reason: 'Ghi nhầm nhà thầu', may_post: false, may_retract: false }),
    ]);
    await loaded();
    const [late, posted, retracted] = eventRows();
    expect(late?.textContent).toContain(word('vnd.clock.overdue.name'));
    expect(late?.textContent).toContain(text('alerts.deadline.late', { days: 3 }));
    expect(posted?.textContent).toContain(word('vnd.eventStatus.posted.name'));
    expect(posted?.textContent).toContain(text('vnd.reputation.posted.text', { name: 'Phạm Quốc Bảo', time: '04/11/2026 09:00' }));
    expect(posted?.textContent).toContain(text('vnd.reputation.receipt.text', { receipt: 'BN-2026-0042' }));
    expect(posted?.textContent).toContain(word('vnd.clock.met.name'));
    expect(retracted?.textContent).toContain(word('vnd.eventStatus.retracted.name'));
    expect(retracted?.textContent).toContain('Ghi nhầm nhà thầu');
    expect(retracted?.textContent).not.toContain(word('vnd.clock.onTime.name'));
  });

  it('says the rule of the seven working days and the factor of the bid security, each with its "i" and the unverified flag', async () => {
    open();
    await loaded();
    const rule = screen.getByTestId('reputation-rule');
    expect(rule.textContent).toContain(word('vnd.reputation.rule.text'));
    fireEvent.click(within(rule).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.reputation.figure.deadline.name') }) }));
    const panel = screen.getByRole('dialog', { name: word('vnd.reputation.figure.deadline.name') });
    expect(panel.querySelector('[data-field=formula] dd')?.textContent).toBe('Formula of EGP_POSTING_DEADLINES');
    expect(panel.querySelector('[data-field=unverified]')).toBeTruthy();
    const security = screen.getByTestId('security-rule');
    expect(within(security).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.reputation.figure.security.name') }) })).toBeTruthy();
    expect(within(security).getByText(word('vnd.flag.unverified.badge'))).toBeTruthy();
  });

  it('marks the event the address names and says when it is not in the list', async () => {
    open([reputationEvent(1)], { path: `/vnd/vnd-06?event=${EVENT}` });
    await loaded();
    expect(eventRows()[0]?.getAttribute('data-focus')).toBe('true');
    expect(eventRows()[0]?.textContent).toContain(word('vnd.reputation.focus.badge'));
    expect(screen.queryByTestId('event-not-in-list')).toBeNull();
    cleanup();
    open([reputationEvent(1)], { path: `/vnd/vnd-06?event=${uuid('0012', 9)}` });
    await loaded();
    expect(screen.getByTestId('event-not-in-list').textContent).toBe(word('vnd.reputation.focus.missing.text'));
  });

  it('filters the events by status', async () => {
    const { h } = open();
    await loaded();
    expect(h.read).toHaveBeenCalledWith('listVendorReputationEvents', { query: {} });
    fireEvent.change(screen.getByLabelText(word('vnd.reputation.filter.status.label')), { target: { value: 'POSTED' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorReputationEvents', { query: { status: 'POSTED' } }));
  });

  describe('recording', () => {
    it('records an event with the body of the request', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('record-event'));
      const form = dialog(word('vnd.reputation.record.title'));
      const send = within(form).getByRole('button', { name: word('vnd.reputation.record.confirm') }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      type(form, word('vnd.reputation.field.contractor.label'), CONTRACTOR);
      type(form, word('vnd.reputation.field.behaviour.label'), 'WITHDRAWING_AFTER_CLOSING');
      type(form, word('vnd.reputation.field.eventOn.label'), '2026-11-05');
      type(form, word('vnd.reputation.field.description.label'), 'Rút hồ sơ dự thầu sau thời điểm đóng thầu');
      type(form, word('vnd.reputation.field.package.label'), uuid('0030', 1));
      type(form, word('vnd.reputation.field.contract.label'), uuid('0031', 1));
      type(form, word('vnd.reputation.field.evidence.label'), DOCUMENT);
      expect(send.disabled).toBe(false);
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('recordVendorReputationEvent', { body: { contractor_id: CONTRACTOR, behaviour_code: 'WITHDRAWING_AFTER_CLOSING', event_on: '2026-11-05', description: 'Rút hồ sơ dự thầu sau thời điểm đóng thầu', package_id: uuid('0030', 1), contract_id: uuid('0031', 1), evidence_document_id: DOCUMENT }, attempt: { key: expect.any(String) } }));
      expect((await screen.findByTestId('receipt')).textContent).toContain(word('vnd.reputation.record.title'));
    });

    it('sends only the fields that were filled and keeps the minimum of the description', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('record-event'));
      const form = dialog(word('vnd.reputation.record.title'));
      type(form, word('vnd.reputation.field.contractor.label'), CONTRACTOR);
      type(form, word('vnd.reputation.field.behaviour.label'), 'NOT_NEGOTIATING');
      type(form, word('vnd.reputation.field.eventOn.label'), '2026-11-05');
      type(form, word('vnd.reputation.field.description.label'), 'Quá ngắn');
      const send = within(form).getByRole('button', { name: word('vnd.reputation.record.confirm') }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      type(form, word('vnd.reputation.field.description.label'), 'Không thương thảo hợp đồng đúng hạn');
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('recordVendorReputationEvent', expect.objectContaining({ body: { contractor_id: CONTRACTOR, behaviour_code: 'NOT_NEGOTIATING', event_on: '2026-11-05', description: 'Không thương thảo hợp đồng đúng hạn' } })));
    });

    it('takes the contractor from the address', async () => {
      open([reputationEvent(1)], { path: `/vnd/vnd-06?contractor=${CONTRACTOR}` });
      await loaded();
      fireEvent.click(screen.getByTestId('record-event'));
      const form = dialog(word('vnd.reputation.record.title'));
      expect((within(form).getByLabelText(labelOf(word('vnd.reputation.field.contractor.label'))) as HTMLInputElement).value).toBe(CONTRACTOR);
    });

    it('shows the field detail of a 422', async () => {
      open([reputationEvent(1)], { command: () => Promise.reject(problem(422, 'VALIDATION_FAILED', 'contractor_id: unknown contractor')) });
      await loaded();
      fireEvent.click(screen.getByTestId('record-event'));
      const form = dialog(word('vnd.reputation.record.title'));
      type(form, word('vnd.reputation.field.contractor.label'), CONTRACTOR);
      type(form, word('vnd.reputation.field.behaviour.label'), 'NOT_NEGOTIATING');
      type(form, word('vnd.reputation.field.eventOn.label'), '2026-11-05');
      type(form, word('vnd.reputation.field.description.label'), 'Không thương thảo hợp đồng đúng hạn');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.reputation.record.confirm') }));
      expect((await within(form).findByRole('alert')).textContent).toContain('contractor_id: unknown contractor');
    });
  });

  describe('posting and retracting', () => {
    it('records the receipt of the posting, under the version of the event', async () => {
      const { h } = open([reputationEvent(1, { version: 4 })]);
      await loaded();
      fireEvent.click(screen.getByTestId('post-event'));
      const form = dialog(word('vnd.reputation.post.title'));
      const send = within(form).getByRole('button', { name: word('vnd.reputation.post.confirm') }) as HTMLButtonElement;
      type(form, word('vnd.reputation.field.receipt.label'), 'ab');
      expect(send.disabled).toBe(true);
      type(form, word('vnd.reputation.field.receipt.label'), ' BN-2026-0042 ');
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('postVendorReputationEvent', { path: { id: EVENT }, ifMatchVersion: 4, body: { receipt: 'BN-2026-0042' }, attempt: { key: expect.any(String) } }));
    });

    it('says in the dialog that another person has to post it when the server refuses the person who recorded it', async () => {
      open([reputationEvent(1)], { command: () => Promise.reject(problem(403, 'SELF_APPROVAL_DENIED')) });
      await loaded();
      fireEvent.click(screen.getByTestId('post-event'));
      const form = dialog(word('vnd.reputation.post.title'));
      type(form, word('vnd.reputation.field.receipt.label'), 'BN-1');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.reputation.post.confirm') }));
      const alert = await within(form).findByRole('alert');
      expect(alert.textContent).toBe(word('vnd.error.selfApproval.text'));
      expect(alert.getAttribute('data-code')).toBe('SELF_APPROVAL_DENIED');
    });

    it('says a changed version with a way to read the event again', async () => {
      open([reputationEvent(1)], { command: () => Promise.reject(problem(409, 'VERSION_CONFLICT')) });
      await loaded();
      fireEvent.click(screen.getByTestId('post-event'));
      const form = dialog(word('vnd.reputation.post.title'));
      type(form, word('vnd.reputation.field.receipt.label'), 'BN-1');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.reputation.post.confirm') }));
      expect((await within(form).findByRole('alert')).textContent).toBe(word('vnd.error.conflict.text'));
      expect(within(form).getByRole('button', { name: word('vnd.dialog.reload.action') })).toBeTruthy();
    });

    it('retracts with a reason of at least twenty characters', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('retract-event'));
      const form = dialog(word('vnd.reputation.retract.title'));
      const send = within(form).getByRole('button', { name: word('vnd.reputation.retract.confirm') }) as HTMLButtonElement;
      type(form, word('vnd.field.reason.label'), 'mười chín ký tự');
      expect(send.disabled).toBe(true);
      type(form, word('vnd.field.reason.label'), 'Ghi nhầm sang nhà thầu khác trong cùng gói thầu');
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('retractVendorReputationEvent', { path: { id: EVENT }, ifMatchVersion: 1, body: { reason: 'Ghi nhầm sang nhà thầu khác trong cùng gói thầu' }, attempt: { key: expect.any(String) } }));
    });

    it('offers the receipt and the retraction only when the answer allows them', async () => {
      open([reputationEvent(1, { may_post: false, may_retract: false })]);
      await loaded();
      expect(screen.queryByTestId('post-event')).toBeNull();
      expect(screen.queryByTestId('retract-event')).toBeNull();
    });
  });

  describe('states', () => {
    it('offers no command without the rights, nor in a read-only workspace', async () => {
      open([reputationEvent(1)], { permissions: READER });
      await loaded();
      expect(screen.queryByTestId('record-event')).toBeNull();
      expect(screen.queryByTestId('create-venture')).toBeNull();
      expect(screen.queryByTestId('end-venture')).toBeNull();
      cleanup();
      open([reputationEvent(1)], { mode: 'READ_ONLY' });
      await loaded();
      expect(screen.queryByTestId('record-event')).toBeNull();
      expect(screen.queryByTestId('post-event')).toBeNull();
      expect(screen.getByTestId('readonly-note')).toBeTruthy();
    });

    it('EMPTY: says there is no event, and when a filter found nothing offers to clear it', async () => {
      open([]);
      expect(await screen.findByText(word('ui.dataTable.emptyNone'))).toBeTruthy();
    });

    it('LOADING, ERROR with retry, FORBIDDEN', async () => {
      const pending = client({ answers: {} });
      pending.read.mockImplementation(() => new Promise(() => undefined));
      mount(<ReputationScreen route={route} />, pending, { permissions: ALL, path: '/vnd/vnd-06' });
      expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
      cleanup();
      open([reputationEvent(1)], { failing: { listVendorReputationEvents: { error: problem(500, 'INTERNAL_ERROR'), times: 1 } } });
      expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
      fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
      await loaded();
      cleanup();
      open([reputationEvent(1)], { failing: { listVendorReputationEvents: { error: problem(403, 'SCOPE_DENIED'), times: 9 } } });
      expect((await screen.findByRole('alert')).textContent).toContain(word('states.denied.title'));
    });

    it('STALE: keeps the last list when a refresh fails', async () => {
      let calls = 0;
      const world: World = { answers: { listVendorReputationEvents: () => (++calls === 1 ? reputationPage([reputationEvent(1)]) : problem(500, 'INTERNAL_ERROR')), listVendorJointVentures: venturePage() } };
      const mounted = mount(<ReputationScreen route={route} />, client(world), { permissions: ALL, path: '/vnd/vnd-06' });
      await loaded();
      await mounted.queries.refetchQueries({ queryKey: ['vnd'] });
      expect(await screen.findByTestId('stale-notice')).toBeTruthy();
      expect(eventRows()).toHaveLength(1);
    });
  });
});

describe('ReputationScreen (VND-06): the joint ventures', () => {
  const ventureRows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-venture-id]'));

  it('lists the ventures with the members linked to their profile, their shares, one lead and the period', async () => {
    open();
    await screen.findByText('Liên danh 1');
    const [row] = ventureRows();
    expect(row?.textContent).toContain(word('vnd.ventureStatus.active.name'));
    expect(within(row as HTMLElement).getByRole('link', { name: 'Công ty nhà thầu 2' }).getAttribute('href')).toBe(`/vnd/vnd-02?contractor=${OTHER}`);
    expect(row?.textContent).toContain(text('vnd.ventures.share.text', { share: '60' }));
    expect(row?.textContent).toContain(text('vnd.ventures.share.text', { share: '40' }));
    expect(within(row as HTMLElement).getAllByText(word('vnd.ventures.lead.badge'))).toHaveLength(1);
    expect(row?.textContent).toContain(`01/06/2026 – ${word('vnd.ventures.period.open')}`);
    expect(screen.getByTestId('ventures-rule').textContent).toBe(word('vnd.ventures.rule.text'));
  });

  it('filters by status and says an ended venture with its reason', async () => {
    const { h } = open([reputationEvent(1)], {}, [venture(1, { status: 'ENDED', ends_on: '2026-10-01', ended_reason: 'Hết hợp đồng' })]);
    await screen.findByText('Liên danh 1');
    expect(ventureRows()[0]?.textContent).toContain('Hết hợp đồng');
    expect(within(ventureRows()[0] as HTMLElement).queryByTestId('end-venture')).toBeNull();
    fireEvent.change(screen.getByLabelText(word('vnd.ventures.filter.status.label')), { target: { value: 'ACTIVE' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listVendorJointVentures', { query: { status: 'ACTIVE' } }));
  });

  it('says there is none, and none in a status that was chosen', async () => {
    open([reputationEvent(1)], {}, []);
    expect((await screen.findByTestId('ventures-empty')).textContent).toBe(word('vnd.ventures.empty.text'));
    fireEvent.change(screen.getByLabelText(word('vnd.ventures.filter.status.label')), { target: { value: 'ENDED' } });
    await waitFor(() => expect(screen.getByTestId('ventures-empty').textContent).toBe(word('vnd.ventures.emptyFiltered.text')));
  });

  it('says a failed read of the ventures in place, with a retry, while the events stay', async () => {
    open([reputationEvent(1)], { failing: { listVendorJointVentures: { error: problem(500, 'INTERNAL_ERROR'), times: 1 } } });
    await loaded();
    const notice = await screen.findByTestId('ventures-error');
    expect(notice.textContent).toContain(word('vnd.ventures.error.text'));
    fireEvent.click(within(notice).getByRole('button', { name: word('states.retry.action') }));
    expect(await screen.findByText('Liên danh 1')).toBeTruthy();
  });

  describe('creating one', () => {
    const member = (form: HTMLElement, row: number, id: string, share: string): void => {
      fireEvent.change(within(form).getByLabelText(text('vnd.rows.cell.label', { column: word('vnd.ventures.members.column.contractor'), row })), { target: { value: id } });
      fireEvent.change(within(form).getByLabelText(text('vnd.rows.cell.label', { column: word('vnd.ventures.members.column.share'), row })), { target: { value: share } });
    };
    const lead = (form: HTMLElement, row: number): void => {
      fireEvent.click(within(form).getByLabelText(text('vnd.rows.cell.label', { column: word('vnd.ventures.members.column.lead'), row })));
    };

    it('shows the total as the rows are typed and keeps the button off until the plan adds up', async () => {
      open();
      await screen.findByText('Liên danh 1');
      fireEvent.click(screen.getByTestId('create-venture'));
      const form = dialog(word('vnd.ventures.create.title'));
      const send = within(form).getByRole('button', { name: word('vnd.ventures.create.confirm') }) as HTMLButtonElement;
      type(form, word('vnd.ventures.field.name.label'), 'Liên danh Bắc Nam');
      expect(send.disabled).toBe(true);
      member(form, 1, CONTRACTOR, '60');
      member(form, 2, OTHER, '30');
      lead(form, 1);
      const total = within(form).getByTestId('venture-total');
      expect(total.textContent).toBe(text('vnd.ventures.total.text', { total: 90 }));
      expect(total.getAttribute('data-ok')).toBe('false');
      expect(within(form).getByTestId('venture-problems').textContent).toContain(word('vnd.ventures.problem.total.text'));
      expect(send.disabled).toBe(true);
      member(form, 2, OTHER, '40');
      expect(total.textContent).toBe(text('vnd.ventures.total.text', { total: 100 }));
      expect(total.getAttribute('data-ok')).toBe('true');
      expect(within(form).queryByTestId('venture-problems')).toBeNull();
      expect(send.disabled).toBe(false);
    });

    it('names each fault of a plan: no lead, two leads, one contractor twice, a wrong id, a share that is not a number', async () => {
      open();
      await screen.findByText('Liên danh 1');
      fireEvent.click(screen.getByTestId('create-venture'));
      const form = dialog(word('vnd.ventures.create.title'));
      type(form, word('vnd.ventures.field.name.label'), 'Liên danh Bắc Nam');
      member(form, 1, CONTRACTOR, '50');
      member(form, 2, CONTRACTOR, '50');
      expect(within(form).getByTestId('venture-problems').textContent).toContain(word('vnd.ventures.problem.duplicate.text'));
      expect(within(form).getByTestId('venture-problems').textContent).toContain(word('vnd.ventures.problem.lead.text'));
      member(form, 2, 'khong-phai-ma', '50');
      expect(within(form).getByTestId('venture-problems').textContent).toContain(word('vnd.ventures.problem.id.text'));
      member(form, 2, OTHER, 'abc');
      expect(within(form).getByTestId('venture-problems').textContent).toContain(word('vnd.ventures.problem.share.text'));
      lead(form, 1);
      lead(form, 2);
      lead(form, 1);
      expect((within(form).getByLabelText(text('vnd.rows.cell.label', { column: word('vnd.ventures.members.column.lead'), row: 2 })) as HTMLInputElement).checked).toBe(false);
      fireEvent.click(within(form).getByRole('button', { name: text('vnd.ventures.members.remove.label', { row: 2 }) }));
      expect(within(form).getByTestId('venture-problems').textContent).toContain(word('vnd.ventures.problem.members.text'));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.ventures.members.add.action') }));
      expect(within(form).getByLabelText(text('vnd.rows.cell.label', { column: word('vnd.ventures.members.column.share'), row: 2 }))).toBeTruthy();
    });

    it('creates a venture with the members, their shares, the lead and the optional fields', async () => {
      const { h } = open();
      await screen.findByText('Liên danh 1');
      fireEvent.click(screen.getByTestId('create-venture'));
      const form = dialog(word('vnd.ventures.create.title'));
      type(form, word('vnd.ventures.field.name.label'), ' Liên danh Bắc Nam ');
      member(form, 1, CONTRACTOR, '33.33');
      member(form, 2, OTHER, '33,33');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.ventures.members.add.action') }));
      member(form, 3, uuid('0001', 3), '33.34');
      lead(form, 2);
      type(form, word('vnd.ventures.field.agreement.label'), DOCUMENT);
      type(form, word('vnd.ventures.field.starts.label'), '2026-12-01');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.ventures.create.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('createVendorJointVenture', {
        body: {
          name: 'Liên danh Bắc Nam',
          members: [
            { contractor_id: CONTRACTOR, share_pct: '33.33', lead: false },
            { contractor_id: OTHER, share_pct: '33.33', lead: true },
            { contractor_id: uuid('0001', 3), share_pct: '33.34', lead: false },
          ],
          agreement_document_id: DOCUMENT,
          starts_on: '2026-12-01',
        },
        attempt: { key: expect.any(String) },
      });
      expect((await screen.findByTestId('receipt')).textContent).toContain(word('vnd.ventures.create.title'));
    });

    it('says in the dialog that the shares must total 100 when the server refuses the plan', async () => {
      open([reputationEvent(1)], { command: () => Promise.reject(problem(422, 'JOINT_VENTURE_SHARES_INVALID')) });
      await screen.findByText('Liên danh 1');
      fireEvent.click(screen.getByTestId('create-venture'));
      const form = dialog(word('vnd.ventures.create.title'));
      type(form, word('vnd.ventures.field.name.label'), 'Liên danh Bắc Nam');
      member(form, 1, CONTRACTOR, '60');
      member(form, 2, OTHER, '40');
      lead(form, 1);
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.ventures.create.confirm') }));
      expect((await within(form).findByRole('alert')).textContent).toBe(word('vnd.error.shares.text'));
    });
  });

  describe('ending one', () => {
    it('ends an active venture with a reason of at least five characters, under its version', async () => {
      const { h } = open();
      await screen.findByText('Liên danh 1');
      fireEvent.click(screen.getByTestId('end-venture'));
      const form = dialog(word('vnd.ventures.end.title'));
      const send = within(form).getByRole('button', { name: word('vnd.ventures.end.confirm') }) as HTMLButtonElement;
      type(form, word('vnd.field.reason.label'), 'abc');
      expect(send.disabled).toBe(true);
      type(form, word('vnd.field.reason.label'), 'Hết hợp đồng thầu chung');
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('endVendorJointVenture', { path: { id: uuid('0013', 1) }, ifMatchVersion: 1, body: { reason: 'Hết hợp đồng thầu chung' }, attempt: { key: expect.any(String) } }));
    });

    it('says a changed version with a way to read the venture again', async () => {
      open([reputationEvent(1)], { command: () => Promise.reject(problem(409, 'VERSION_CONFLICT')) });
      await screen.findByText('Liên danh 1');
      fireEvent.click(screen.getByTestId('end-venture'));
      const form = dialog(word('vnd.ventures.end.title'));
      type(form, word('vnd.field.reason.label'), 'Hết hợp đồng thầu chung');
      fireEvent.click(within(form).getByRole('button', { name: word('vnd.ventures.end.confirm') }));
      expect((await within(form).findByRole('alert')).textContent).toBe(word('vnd.error.conflict.text'));
      expect(within(form).getByRole('button', { name: word('vnd.dialog.reload.action') })).toBeTruthy();
    });
  });
});
