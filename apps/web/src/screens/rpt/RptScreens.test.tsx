import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../i18n';
import base from '../../i18n/vi.json';
import CatalogueScreen from './CatalogueScreen';
import DeliveryLogScreen from './DeliveryLogScreen';
import DraftScreen from './DraftScreen';
import IssuedScreen from './IssuedScreen';
import { ALL, DEMO_MARK, READER, catalogue, delivery, demoEntry, draft, entry, harness, issue, mount, never, page, previewOf, routeOf, sha, uuid } from './test/support';

const word = (key: string): string => {
  const found = (base as Record<string, string | undefined>)[key];
  if (found === undefined) throw new Error(`missing key ${key}`);
  return found;
};
const fill = (key: string, params: Record<string, string | number>): string => Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), word(key));
const problem = (code: string, status: number, detail?: string, extensions?: Record<string, unknown>) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }), ...(extensions === undefined ? {} : { extensions }) });

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

describe('RPT-01, the catalogue and the generation of a report', () => {
  const route = routeOf('RPT-01', 'FR-RPT-01');
  const mountCatalogue = (answer: (op: string, input: unknown) => unknown, command?: (op: string, input: unknown) => unknown, permissions = ALL) => {
    const h = harness(answer, command);
    mount(<CatalogueScreen route={route} />, h, { permissions });
    return h;
  };

  it('AC-ST-RPT-001-4 / UI-RPT-01: lists the forms with edition, status, official acceptance, receiver, kind and source, and marks the demo form', async () => {
    mountCatalogue(() => catalogue([entry(), demoEntry()], { demo_mode: true }));
    expect(await screen.findByTestId('form-DIS-WEEKLY')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('rpt.cat.page.title'));
    const marks = screen.getAllByTestId('demo-mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toContain(DEMO_MARK);
    expect(marks[0]?.textContent).toContain(word('rpt.common.demo.notAccepted'));
    expect(screen.getByText(word('rpt.common.official.pendingExternal'))).toBeTruthy();
    expect(screen.getByText(word('rpt.common.official.confirmed'))).toBeTruthy();
    expect(screen.getByText(word('rpt.common.status.demo'))).toBeTruthy();
    expect(screen.getByText(word('rpt.common.source.illustrative'))).toBeTruthy();
    expect(screen.getByText(word('rpt.common.edition.enterprise'))).toBeTruthy();
    expect(screen.getByTestId('demo-note').textContent).toBe(word('rpt.cat.demo.on.text'));
  });

  it('does not offer a demo form while demo forms are off and says why', async () => {
    mountCatalogue(() => catalogue([demoEntry()], { demo_mode: false }));
    await screen.findByTestId('form-PVN-MONTHLY');
    expect(screen.queryByTestId('generate-PVN-MONTHLY')).toBeNull();
    expect(screen.getByTestId('blocked-PVN-MONTHLY').textContent).toBe(word('rpt.cat.action.demoOff'));
    expect(screen.getByTestId('demo-note').textContent).toBe(word('rpt.cat.demo.off.text'));
  });

  it('shows a reader the forms but no button to generate', async () => {
    mountCatalogue(() => catalogue([entry()], { can_generate: false }), undefined, READER);
    await screen.findByTestId('form-DIS-WEEKLY');
    expect(screen.queryByTestId('generate-DIS-WEEKLY')).toBeNull();
    expect(screen.getByText(word('rpt.cat.action.noRight'))).toBeTruthy();
  });

  it('asks for the period of the kind of the form, refuses an incomplete one, and sends the period the person typed', async () => {
    const h = mountCatalogue(
      () => catalogue([demoEntry({ issuable: true })], { demo_mode: true }),
      () => ({ outcome: 'CREATED', draft_id: uuid(5), issue_id: null, revision: 1, package_sha256: sha('a'), issue_count: 0 }),
    );
    fireEvent.click(await screen.findByTestId('generate-PVN-MONTHLY'));
    const fields = await screen.findByTestId('period-fields');
    expect(within(fields).getByText(word('rpt.cat.dialog.index.month'))).toBeTruthy();
    fireEvent.change(screen.getByTestId('period-index'), { target: { value: '13' } });
    fireEvent.click(screen.getByRole('button', { name: word('rpt.cat.dialog.confirm') }));
    expect((await screen.findByRole('alert')).textContent).toContain(word('rpt.cat.dialog.period.invalid'));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('period-year'), { target: { value: '2026' } });
    fireEvent.change(screen.getByTestId('period-index'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: word('rpt.cat.dialog.confirm') }));
    const receipt = await screen.findByTestId('generate-receipt');
    expect(receipt.textContent).toContain(fill('rpt.cat.receipt.created', { code: 'PVN-MONTHLY' }));
    expect(h.command).toHaveBeenCalledWith('generateReport', expect.objectContaining({ body: { layout_code: 'PVN-MONTHLY', period: { kind: 'MONTH', year: 2026, index: 10 } } }));
  });

  it('asks for a reason when the server says a copy of the period was issued with other figures, and then sends it', async () => {
    let calls = 0;
    const h = mountCatalogue(
      () => catalogue([entry()]),
      () => {
        calls += 1;
        if (calls === 1) return problem('VALIDATION_FAILED', 422, 'reason');
        return { outcome: 'CREATED', draft_id: uuid(6), issue_id: null, revision: 2, package_sha256: sha('a'), issue_count: 0 };
      },
    );
    fireEvent.click(await screen.findByTestId('generate-DIS-WEEKLY'));
    await screen.findByTestId('period-day');
    fireEvent.change(screen.getByTestId('period-day'), { target: { value: `${new Date().getUTCFullYear()}-03-08` } });
    fireEvent.click(screen.getByRole('button', { name: word('rpt.cat.dialog.confirm') }));
    expect((await screen.findByRole('alert')).textContent).toContain(word('rpt.common.error.reasonNeeded.text'));
    const reason = await screen.findByLabelText(new RegExp(word('rpt.cat.dialog.reason.label')));
    fireEvent.change(reason, { target: { value: 'The Treasury booked a late payment' } });
    fireEvent.click(screen.getByRole('button', { name: word('rpt.cat.dialog.confirm') }));
    await screen.findByTestId('generate-receipt');
    expect(h.command).toHaveBeenLastCalledWith('generateReport', expect.objectContaining({ body: expect.objectContaining({ reason: 'The Treasury booked a late payment' }) }));
  });

  it('says that the same content as the copy in force makes nothing new', async () => {
    mountCatalogue(
      () => catalogue([entry()]),
      () => ({ outcome: 'DUPLICATE', draft_id: null, issue_id: uuid(7), revision: 3, package_sha256: sha('a'), issue_count: 0 }),
    );
    fireEvent.click(await screen.findByTestId('generate-DIS-WEEKLY'));
    await screen.findByTestId('period-day');
    fireEvent.change(screen.getByTestId('period-day'), { target: { value: `${new Date().getUTCFullYear()}-03-08` } });
    fireEvent.click(screen.getByRole('button', { name: word('rpt.cat.dialog.confirm') }));
    expect((await screen.findByTestId('generate-receipt')).textContent).toContain(fill('rpt.cat.receipt.duplicate', { code: 'DIS-WEEKLY', revision: 3 }));
  });

  it('shows the loading, empty, error and denied states', async () => {
    const loading = mountCatalogue(() => never());
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    expect(loading.read).toHaveBeenCalled();
    cleanup();
    mountCatalogue(() => catalogue([]));
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    mountCatalogue(() => problem('INTERNAL_ERROR', 500));
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    mountCatalogue(() => problem('SCOPE_DENIED', 403));
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });
});

describe('RPT-02, the drafts and the flow of three people', () => {
  const route = routeOf('RPT-02', 'FR-RPT-02');
  const opened = uuid(21);
  const mountDrafts = (current: Record<string, unknown>, command?: (op: string, input: unknown) => unknown) => {
    const h = harness((op) => {
      if (op === 'listReportDrafts') return page([current]);
      if (op === 'getReportDraft') return current;
      return {};
    }, command);
    mount(<DraftScreen route={route} />, h, { permissions: ALL, path: `/?draft=${opened}` });
    return h;
  };

  it('AC-ST-RPT-001-5 / UI-RPT-02: shows the preview of every cell, the people, the lineage and the whole hash of the draft', async () => {
    mountDrafts(draft(21, { state: 'CHECKED', checked_by_name: 'Trần Thị Bình', base_revision: 2, reason: 'A late payment', version: 2, preview: previewOf(), issue_count: 1, issues: [{ ref: 'C6', code: 'NO_FIGURE', detail: 'X@Y' }] }));
    await screen.findByTestId('hash-package');
    const detail = screen.getByTestId('draft-detail');
    expect(within(detail).getByTestId('hash-package').textContent).toBe(sha('a'));
    expect(within(detail).getByTestId('person-preparer').textContent).toBe('Nguyễn Văn An');
    expect(within(detail).getByTestId('person-checker').textContent).toBe('Trần Thị Bình');
    expect(within(detail).getByTestId('fact-base').textContent).toBe(fill('rpt.draft.fact.base.text', { revision: 2, next: 3 }));
    expect(within(detail).getByTestId('fact-reason').textContent).toBe('A late payment');
    expect(within(detail).getByTestId('fact-snapshot').textContent).toBe(fill('rpt.draft.fact.snapshot.text', { revision: 1, cutoff: '2026-10-12' }));
    const cell = detail.querySelector('[data-cell="2:3"]');
    expect(cell?.textContent).toBe('60,00');
    expect(cell?.className).toContain('rpt-sheet__num');
    fireEvent.click(within(detail).getByRole('button', { name: word('rpt.common.issues.show') }));
    expect(within(detail).getByText(word('rpt.common.issue.noFigure'), { exact: false })).toBeTruthy();
  });

  it('draws a merged title cell over its columns and leaves out the cells it covers, with values not formulas (DEMO-04)', async () => {
    const merged = previewOf({
      columns: 4,
      rows: [
        { row: 1, kind: 'TITLE', cells: [{ col: 1, kind: 'TEXT', text: 'BÁO CÁO TÌNH HÌNH GIẢI NGÂN THÁNG', col_span: 4 }] },
        { row: 2, kind: 'HEADER', cells: [{ col: 1, kind: 'TEXT', text: 'Dự án', row_span: 2 }, { col: 2, kind: 'TEXT', text: 'Kế hoạch' }, { col: 3, kind: 'TEXT', text: 'Giải ngân' }, { col: 4, kind: 'TEXT', text: 'Tỷ lệ' }] },
        { row: 3, kind: 'DATA', cells: [{ col: 2, kind: 'NUMBER', text: '1.200.000' }, { col: 3, kind: 'NUMBER', text: '900.000' }, { col: 4, kind: 'FORMULA', text: '75,0' }] },
      ],
      row_count: 3,
    });
    mountDrafts(draft(21, { preview: merged }));
    await screen.findByTestId('hash-package');
    const detail = screen.getByTestId('draft-detail');
    const title = detail.querySelector('[data-cell="1:1"]') as HTMLTableCellElement;
    expect(title.colSpan).toBe(4);
    expect(detail.querySelector('[data-cell="1:2"]')).toBeNull();
    const head = detail.querySelector('[data-cell="2:1"]') as HTMLTableCellElement;
    expect(head.rowSpan).toBe(2);
    expect(detail.querySelector('[data-cell="3:1"]')).toBeNull();
    expect(detail.querySelector('[data-cell="3:4"]')?.textContent).toBe('75,0');
    expect(detail.querySelector('[data-cell="3:4"]')?.textContent).not.toMatch(/^=/);
    expect(detail.querySelectorAll('colgroup col').length).toBe(5);
  });

  it('shows the step that is now, and the button of it only to the person who may take it', async () => {
    mountDrafts(draft(21, { can_check: true }));
    const flow = await screen.findByTestId('flow');
    expect(within(flow).getByTestId('act-check')).toBeTruthy();
    expect(within(flow).queryByTestId('act-approve')).toBeNull();
    expect(within(flow).getByText(word('rpt.draft.step.later'), { selector: '[data-step="approve"] *' })).toBeTruthy();
    cleanup();
    mountDrafts(draft(21, { can_check: false }));
    expect((await screen.findByTestId('wait-check')).textContent).toBe(word('rpt.draft.wait.check'));
    expect(screen.queryByTestId('act-check')).toBeNull();
  });

  it('checks the draft at the version it saw, and says in words what the server refuses', async () => {
    let answers = 0;
    const h = mountDrafts(draft(21, { can_check: true, version: 4 }), () => {
      answers += 1;
      return answers === 1 ? problem('SELF_APPROVAL_DENIED', 403) : {};
    });
    fireEvent.click(await screen.findByTestId('act-check'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: word('rpt.draft.act.check') }));
    expect((await screen.findByRole('alert')).textContent).toContain(word('rpt.common.error.selfApproval.text'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: word('rpt.draft.act.check') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(h.command).toHaveBeenLastCalledWith('checkReport', expect.objectContaining({ path: { id: opened }, ifMatchVersion: 4 }));
  });

  it('names the current revision when the series has moved on, and the demo form switched off', async () => {
    mountDrafts(draft(21, { state: 'APPROVED', can_issue: true, version: 3, checked_by_name: 'B', approved_by_name: 'C' }), () => problem('REPORT_OUT_OF_DATE', 409, 'revision', { current_revision: 5 }));
    fireEvent.click(await screen.findByTestId('act-issue'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: word('rpt.draft.act.issue') }));
    expect((await screen.findByRole('alert')).textContent).toContain(fill('rpt.common.error.outOfDate.text', { revision: 5 }));
    cleanup();
    mountDrafts(draft(21, { state: 'APPROVED', form_status: 'DEMO', demo_mark: DEMO_MARK, demo_forms_off: true, can_issue: false, approved_by_name: 'C' }));
    expect((await screen.findByTestId('demo-off')).textContent).toBe(word('rpt.draft.demoOff.text'));
    expect(screen.getAllByTestId('demo-mark').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('act-issue')).toBeNull();
  });

  it('links an issued draft to its copy', async () => {
    mountDrafts(draft(21, { state: 'ISSUED', issue_id: uuid(31), checked_by_name: 'B', approved_by_name: 'C' }));
    const link = (await screen.findByTestId('issued-link')).querySelector('a');
    expect(link?.getAttribute('href')).toBe(`/rpt/rpt-03?issue=${uuid(31)}`);
  });

  it('shows the empty, error and denied states of the list', async () => {
    mount(<DraftScreen route={route} />, harness(() => page([])), { permissions: ALL });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    mount(<DraftScreen route={route} />, harness(() => problem('INTERNAL_ERROR', 500)), { permissions: ALL });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    mount(<DraftScreen route={route} />, harness(() => problem('SCOPE_DENIED', 403)), { permissions: ALL });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });
});

describe('RPT-03, the issued copies, their deliveries and answers', () => {
  const route = routeOf('RPT-03', 'FR-RPT-03');
  const mountIssued = (current: Record<string, unknown>, command?: (op: string, input: unknown) => unknown, open = true) => {
    const h = harness((op) => {
      if (op === 'listReportIssues') return page([current]);
      if (op === 'getReportIssue') return current;
      return {};
    }, command);
    mount(<IssuedScreen route={route} />, h, { permissions: ALL, path: open ? `/?issue=${current.id as string}` : '/' });
    return h;
  };

  it('AC-ST-RPT-001-6 / UI-RPT-03: lists the copies with the whole sha256 and whether a later revision replaced them', async () => {
    mountIssued(issue(41, { is_current: false, current_revision: 2 }), undefined, false);
    expect((await screen.findByText(sha('c'))).tagName).toBe('CODE');
    expect(screen.getByText(word('rpt.issued.col.current.no'))).toBeTruthy();
  });

  it('shows the chain of revisions, the people, the files with their hashes, and that a replaced copy cannot be delivered', async () => {
    mountIssued(
      issue(41, {
        revision: 1,
        is_current: false,
        current_revision: 2,
        can_deliver: false,
        chain: [
          { id: uuid(41), revision: 1, sha256: sha('c'), issued_at: '2026-11-07T02:00:00.000Z', reason: null },
          { id: uuid(42), revision: 2, sha256: sha('e'), issued_at: '2026-11-08T02:00:00.000Z', reason: 'A late payment of the week' },
        ],
      }),
    );
    await screen.findByTestId('currency');
    const detail = screen.getByTestId('issue-detail');
    expect(within(detail).getByTestId('currency').textContent).toBe(fill('rpt.issued.superseded.text', { revision: 2 }));
    expect(within(detail).getByTestId('hash-package').textContent).toBe(sha('c'));
    expect(within(detail).getByTestId('hash-xlsx').textContent).toBe(sha('d'));
    expect(within(detail).getByTestId('person-approver').textContent).toBe('Lê Văn Cường');
    expect(within(detail).getByTestId('person-issuer').textContent).toBe('Lê Văn Cường');
    expect(within(detail).getByTestId('chain').textContent).toContain('A late payment of the week');
    expect(within(detail).queryByTestId('deliver-open')).toBeNull();
    expect(within(detail).getByTestId('deliver-blocked').textContent).toBe(word('rpt.issued.deliver.superseded'));
  });

  it('delivers a copy to a receiver once, and says in words when it was delivered already', async () => {
    let answers = 0;
    const h = mountIssued(issue(41), () => {
      answers += 1;
      return answers === 1 ? problem('ALREADY_DELIVERED', 409, 'receiver') : delivery(51);
    });
    fireEvent.click(await screen.findByTestId('deliver-open'));
    fireEvent.change(await screen.findByTestId('deliver-receiver'), { target: { value: 'bad receiver!' } });
    fireEvent.click(screen.getByRole('button', { name: word('rpt.issued.deliver.confirm') }));
    expect((await screen.findByRole('alert')).textContent).toContain(word('rpt.issued.deliver.receiver.invalid'));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('deliver-receiver'), { target: { value: 'MOF' } });
    fireEvent.change(screen.getByTestId('deliver-reference'), { target: { value: 'letter 12/BC' } });
    fireEvent.click(screen.getByRole('button', { name: word('rpt.issued.deliver.confirm') }));
    expect((await screen.findByRole('alert')).textContent).toContain(word('rpt.common.error.alreadyDelivered.text'));
    expect(h.command).toHaveBeenCalledWith('deliverReport', expect.objectContaining({ path: { id: uuid(41) }, body: { receiver: 'MOF', channel: 'MANUAL', reference: 'letter 12/BC' } }));
  });

  it('records the answer of a receiver, and a rejection needs words', async () => {
    const h = mountIssued(issue(41, { deliveries: [delivery(51)] }), () => delivery(52, { event: 'ACCEPTED' }));
    fireEvent.click(await screen.findByTestId('accept-MOF'));
    fireEvent.click(await screen.findByRole('button', { name: word('rpt.issued.answer.accept.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('answerReportDelivery', expect.objectContaining({ body: { receiver: 'MOF', outcome: 'ACCEPTED' } })));
    cleanup();
    const again = mountIssued(issue(41, { deliveries: [delivery(51)] }), () => delivery(53, { event: 'REJECTED' }));
    fireEvent.click(await screen.findByTestId('reject-MOF'));
    const confirm = await screen.findByRole('button', { name: word('rpt.issued.answer.reject.confirm') });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(await screen.findByLabelText(new RegExp(word('rpt.issued.answer.reject.reason'))), { target: { value: 'The totals do not match ours' } });
    fireEvent.click(screen.getByRole('button', { name: word('rpt.issued.answer.reject.confirm') }));
    await waitFor(() => expect(again.command).toHaveBeenCalledWith('answerReportDelivery', expect.objectContaining({ body: { receiver: 'MOF', outcome: 'REJECTED', note: 'The totals do not match ours' } })));
  });

  it('never offers the acceptance of a copy made on a demo form, and says so', async () => {
    mountIssued(issue(41, { form_status: 'DEMO', demo_mark: DEMO_MARK, counts_as_accepted: false, can_answer: false, deliveries: [delivery(51, { counts_as_accepted: false })] }));
    await screen.findByTestId('currency');
    const detail = screen.getByTestId('issue-detail');
    expect(within(detail).getAllByTestId('demo-mark').length).toBeGreaterThan(0);
    expect(within(detail).queryByTestId('accept-MOF')).toBeNull();
    expect(within(detail).getByTestId('no-accept-MOF').textContent).toContain(word('rpt.common.demo.notAccepted'));
  });

  it('shows the empty and error states', async () => {
    mount(<IssuedScreen route={route} />, harness(() => page([])), { permissions: ALL });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    mount(<IssuedScreen route={route} />, harness(() => problem('INTERNAL_ERROR', 500)), { permissions: ALL });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
  });
});

describe('RPT-04, the delivery log', () => {
  const route = routeOf('RPT-04', 'FR-RPT-04');

  it('AC-ST-RPT-001-7 / UI-RPT-04: lists every event with the receiver, channel, who recorded it, the hash and whether it counts as accepted', async () => {
    mount(<DeliveryLogScreen route={route} />, harness(() => page([delivery(61), delivery(62, { event: 'ACCEPTED', channel: 'EMAIL' }), delivery(63, { counts_as_accepted: false, receiver: 'HPM' })])), { permissions: READER });
    const rows = await screen.findAllByRole('row');
    expect(rows.length).toBe(4);
    expect(screen.getAllByText(word('rpt.common.event.delivered')).length).toBe(2);
    expect(screen.getByText(word('rpt.common.event.accepted'))).toBeTruthy();
    expect(screen.getByText(word('rpt.log.counts.no'))).toBeTruthy();
    expect(screen.getAllByText(sha('c')).length).toBe(3);
  });

  it('filters by receiver and shows the empty, error and denied states', async () => {
    const h = harness(() => page([delivery(61)]));
    mount(<DeliveryLogScreen route={route} />, h, { permissions: READER });
    await screen.findAllByRole('row');
    fireEvent.change(screen.getByTestId('filter-receiver'), { target: { value: 'MOF' } });
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('listReportDeliveries', expect.objectContaining({ query: expect.objectContaining({ receiver: 'MOF' }) })));
    cleanup();
    mount(<DeliveryLogScreen route={route} />, harness(() => page([])), { permissions: READER });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    mount(<DeliveryLogScreen route={route} />, harness(() => problem('INTERNAL_ERROR', 500)), { permissions: READER });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    mount(<DeliveryLogScreen route={route} />, harness(() => problem('SCOPE_DENIED', 403)), { permissions: READER });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });
});
