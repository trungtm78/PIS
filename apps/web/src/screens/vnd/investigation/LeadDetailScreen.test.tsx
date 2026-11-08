import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import LeadDetailScreen from './LeadDetailScreen';
import { AUDITOR, LEAD, LEAD_READER, client, leadDetail, leadLine, linkGraph, mount, routeOf, uuid } from './test/investigation-fixtures';
import type { World } from './test/investigation-fixtures';
import { labelOf, problem, text, word } from './test/helpers';

const route = routeOf('VND-14', 'FR-VND-14');

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

interface Options {
  permissions?: string[];
  mode?: 'FULL' | 'READ_ONLY';
  command?: (operation: string, input: unknown) => unknown;
  failing?: World['failing'];
  path?: string;
}

function open(detail: Record<string, unknown> = leadDetail(), options: Options = {}) {
  const world: World = { answers: { getVendorLead: detail, getVendorContractorLinks: linkGraph() }, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world, options.command);
  mount(<LeadDetailScreen route={route} />, h, { permissions: options.permissions ?? AUDITOR, path: options.path ?? `/vnd/vnd-14?lead=${LEAD}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, world };
}

const loaded = async (): Promise<void> => {
  await screen.findByTestId('lead-facts');
};
const type = (scope: HTMLElement, label: string, value: string): void => {
  fireEvent.change(within(scope).getByLabelText(labelOf(label)), { target: { value } });
};
const dialog = (name: string): HTMLElement => screen.getByRole('dialog', { name });
const all = { may_take: true, may_propose_dismissal: true, may_confirm_dismissal: true, may_reject_dismissal: true, may_confirm_signal: true, may_refer: true };

describe('LeadDetailScreen (VND-14): one lead', () => {
  it('shows the kind, the rank, the contractors with their profile and the restriction in words, the packages and the dates', async () => {
    open();
    await loaded();
    const facts = screen.getByTestId('lead-facts');
    expect(within(facts).getByTestId('fact-rank').textContent).toContain('85');
    expect(within(facts).getByTestId('fact-kind').textContent).toContain(word('vnd3.leadKind.linkCluster.name'));
    const contractors = within(facts).getByTestId('fact-contractors');
    expect(within(contractors).getByRole('link', { name: 'Công ty nhà thầu 2' }).getAttribute('href')).toBe(`/vnd/vnd-02?contractor=${uuid('0001', 2)}`);
    expect(contractors.textContent).toContain(word('vnd3.graph.restricted.badge'));
    expect(within(facts).getByTestId('fact-packages').textContent).toContain('GT-2026-01');
    expect(within(facts).getByTestId('fact-flagged').textContent).toContain(text('vnd3.lead.flagged.text', { first: '20/10/2026', last: '07/11/2026', count: 3 }));
    expect(within(facts).getByTestId('fact-reviewer').textContent).toContain('–');
    expect(screen.getByTestId('not-conclusion').textContent).toBe(word('vnd3.lead.notConclusion.text'));
    expect(screen.getByTestId('signal-notice')).toBeTruthy();
  });

  it('draws the graph of the lead and reads without it: the table lists the links', async () => {
    open();
    await loaded();
    expect(screen.getAllByTestId(/^graph-node-/)).toHaveLength(3);
    expect(document.querySelectorAll('tr[data-link]')).toHaveLength(2);
    const policy = screen.getByTestId('link-policy');
    fireEvent.click(within(policy).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd3.lead.graph.rule.name') }) }));
    expect(screen.getByText('Formula of VENDOR_LINK_RULE')).toBeTruthy();
  });

  it('puts a contractor in the middle and reads its wider links with the panel for a contractor', async () => {
    const { h } = open();
    await loaded();
    expect(h.read).not.toHaveBeenCalledWith('getVendorContractorLinks', expect.anything());
    fireEvent.change(screen.getByTestId('focus-select'), { target: { value: uuid('0001', 1) } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('getVendorContractorLinks', { path: { id: uuid('0001', 1) } }));
    expect(await screen.findByTestId('links-policy')).toBeTruthy();
    expect(screen.getByTestId('links-clusters').textContent).toContain(text('vnd3.links.cluster.item', { count: 2, score: 95 }));
    expect(screen.getByTestId('links-ignored').textContent).toContain(text('vnd3.links.ignored.text', { count: 1 }));
    expect(screen.getAllByTestId(`graph-node-${uuid('0001', 1)}`).map((node) => node.getAttribute('data-x'))).toContain('280');
  });

  it('lists the signals with the numbers they rest on, in words, and the rule with its "i"', async () => {
    open();
    await loaded();
    const row = document.querySelector('tr');
    expect(row).toBeTruthy();
    const body = screen.getByRole('table', { name: word('vnd3.lead.signals.caption') });
    expect(body.textContent).toContain(word('vnd3.leadKind.coverBid.name'));
    expect(body.textContent).toContain('75');
    expect(body.textContent).toContain(word('vnd3.evidence.closeGapBp.name'));
    expect(body.textContent).toContain('2961');
    const policy = screen.getByTestId('rigging-policy');
    fireEvent.click(within(policy).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd3.lead.signals.rule.name') }) }));
    expect(screen.getByText('Formula of VENDOR_BID_RIGGING')).toBeTruthy();
  });

  it('says how much of the traces was recorded, and that not recorded is not clear', async () => {
    open();
    await loaded();
    expect(screen.getByTestId('trace-coverage').textContent).toBe(text('vnd3.lead.trace.text', { origin: 5, files: 8, bids: 20, pct: 25 }));
    cleanup();
    open(leadDetail({ trace_coverage: { bids: 0, with_origin: 0, with_files: 0 } }));
    await loaded();
    expect(screen.getByTestId('trace-coverage').textContent).toBe(word('vnd3.lead.trace.none.text'));
    expect(screen.getByText(word('vnd3.lead.trace.notRecorded.text'))).toBeTruthy();
  });

  it('shows the history as a timeline with the steps in words', async () => {
    open();
    await loaded();
    const timeline = screen.getByRole('list', { name: word('vnd3.lead.history.caption') });
    expect(timeline.textContent).toContain(`${word('vnd3.leadMove.scanNew.name')}: ${word('vnd3.leadStatus.new.name')}`);
    expect(timeline.textContent).toContain(`${word('vnd3.leadMove.take.name')}: ${word('vnd3.leadStatus.inReview.name')}`);
  });

  describe('the review', () => {
    it('offers only the moves the answer allows', async () => {
      open();
      await loaded();
      expect(screen.getByTestId('take-lead')).toBeTruthy();
      for (const id of ['propose-dismissal', 'confirm-dismissal', 'reject-dismissal', 'confirm-signal', 'refer-lead']) expect(screen.queryByTestId(id)).toBeNull();
      cleanup();
      open(leadDetail({ ...all }));
      await loaded();
      for (const id of ['take-lead', 'propose-dismissal', 'confirm-dismissal', 'reject-dismissal', 'confirm-signal', 'refer-lead']) expect(screen.getByTestId(id)).toBeTruthy();
      cleanup();
      open(leadDetail({ may_take: false }));
      await loaded();
      expect(screen.getByTestId('no-actions').textContent).toBe(word('vnd3.lead.review.none.text'));
    });

    it('offers no move in a read-only workspace', async () => {
      open(leadDetail({ ...all }), { mode: 'READ_ONLY' });
      await loaded();
      expect(screen.queryByTestId('take-lead')).toBeNull();
      expect(screen.getByTestId('readonly-note')).toBeTruthy();
      expect(screen.getByTestId('no-actions')).toBeTruthy();
    });

    it('takes the lead under the version it saw and says what was done', async () => {
      const { h } = open();
      await loaded();
      fireEvent.click(screen.getByTestId('take-lead'));
      const form = dialog(word('vnd3.leadMove.take.title'));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd3.leadMove.take.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('takeVendorLead', { path: { id: LEAD }, ifMatchVersion: 2, attempt: { key: expect.any(String) } }));
      expect((await screen.findByTestId('receipt')).textContent).toContain(word('vnd3.leadMove.take.title'));
    });

    it('proposes a dismissal with a reason of five characters at least', async () => {
      const { h } = open(leadDetail({ ...all, lead: leadLine(1, { status: 'IN_REVIEW' }) }));
      await loaded();
      fireEvent.click(screen.getByTestId('propose-dismissal'));
      const form = dialog(word('vnd3.leadMove.proposeDismissal.title'));
      const send = within(form).getByRole('button', { name: word('vnd3.leadMove.proposeDismissal.confirm') }) as HTMLButtonElement;
      type(form, word('vnd.field.reason.label'), 'abc');
      expect(send.disabled).toBe(true);
      type(form, word('vnd.field.reason.label'), ' Địa chỉ của một văn phòng chung ');
      fireEvent.click(send);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('proposeVendorLeadDismissal', { path: { id: LEAD }, ifMatchVersion: 2, body: { reason: 'Địa chỉ của một văn phòng chung' }, attempt: { key: expect.any(String) } }));
    });

    it('confirms, rejects, confirms the signal and refers through the right operations', async () => {
      const { h } = open(leadDetail({ ...all, lead: leadLine(1, { status: 'DISMISS_PROPOSED' }), dismiss_proposed_by_name: 'Lê Thị Hoa', dismiss_reason: 'Địa chỉ chung' }));
      await loaded();
      fireEvent.click(screen.getByTestId('confirm-dismissal'));
      fireEvent.click(within(dialog(word('vnd3.leadMove.confirmDismissal.title'))).getByRole('button', { name: word('vnd3.leadMove.confirmDismissal.confirm') }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('confirmVendorLeadDismissal', { path: { id: LEAD }, ifMatchVersion: 2, attempt: { key: expect.any(String) } }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      for (const [id, move, operation] of [
        ['reject-dismissal', 'rejectDismissal', 'rejectVendorLeadDismissal'],
        ['confirm-signal', 'confirmSignal', 'confirmVendorLeadSignal'],
        ['refer-lead', 'refer', 'referVendorLead'],
      ] as const) {
        fireEvent.click(screen.getByTestId(id));
        const form = dialog(word(`vnd3.leadMove.${move}.title`));
        type(form, word('vnd.field.reason.label'), 'Lý do đủ dài để ghi');
        fireEvent.click(within(form).getByRole('button', { name: word(`vnd3.leadMove.${move}.confirm`) }));
        await waitFor(() => expect(h.command).toHaveBeenCalledWith(operation, { path: { id: LEAD }, ifMatchVersion: 2, body: { reason: 'Lý do đủ dài để ghi' }, attempt: { key: expect.any(String) } }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      }
    });

    it('shows who proposed the dismissal and why, with the maker and no checker yet', async () => {
      open(leadDetail({ ...all, lead: leadLine(1, { status: 'DISMISS_PROPOSED' }), dismiss_proposed_by_name: 'Lê Thị Hoa', dismiss_reason: 'Địa chỉ chung' }));
      await loaded();
      const proposal = screen.getByTestId('dismissal-proposal');
      expect(proposal.textContent).toContain('Lê Thị Hoa');
      expect(proposal.textContent).toContain(text('vnd3.lead.dismissal.reason.text', { reason: 'Địa chỉ chung' }));
      expect(within(proposal).getByRole('group')).toBeTruthy();
    });

    it('says in the dialog that a different auditor has to confirm when the server refuses the same person', async () => {
      open(leadDetail({ ...all, lead: leadLine(1, { status: 'DISMISS_PROPOSED' }), dismiss_proposed_by_name: 'Tôi' }), { command: () => Promise.reject(problem(403, 'SELF_APPROVAL_DENIED')) });
      await loaded();
      fireEvent.click(screen.getByTestId('confirm-dismissal'));
      const form = dialog(word('vnd3.leadMove.confirmDismissal.title'));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd3.leadMove.confirmDismissal.confirm') }));
      const alert = await within(form).findByRole('alert');
      expect(alert.textContent).toBe(word('vnd.error.selfApproval.text'));
      expect(alert.getAttribute('data-code')).toBe('SELF_APPROVAL_DENIED');
    });

    it('says a changed version with a way to read the lead again', async () => {
      open(leadDetail({ ...all }), { command: () => Promise.reject(problem(409, 'VERSION_CONFLICT')) });
      await loaded();
      fireEvent.click(screen.getByTestId('take-lead'));
      const form = dialog(word('vnd3.leadMove.take.title'));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd3.leadMove.take.confirm') }));
      expect((await within(form).findByRole('alert')).textContent).toBe(word('vnd.error.conflict.text'));
      expect(within(form).getByRole('button', { name: word('vnd.dialog.reload.action') })).toBeTruthy();
    });

    it('says a lead that is not in the state the move needs', async () => {
      open(leadDetail({ ...all }), { command: () => Promise.reject(problem(409, 'LEAD_STATE_INVALID')) });
      await loaded();
      fireEvent.click(screen.getByTestId('take-lead'));
      const form = dialog(word('vnd3.leadMove.take.title'));
      fireEvent.click(within(form).getByRole('button', { name: word('vnd3.leadMove.take.confirm') }));
      expect((await within(form).findByRole('alert')).textContent).toBe(word('vnd.error.stateInvalid.text'));
    });

    it('writes the reason of a decided lead where the buttons were', async () => {
      open(leadDetail({ lead: leadLine(1, { status: 'REFERRED' }), referral_reason: 'Gửi thanh tra', may_take: false }));
      await loaded();
      expect(screen.getByTestId('referral-reason').textContent).toBe(text('vnd3.lead.referred.reason.text', { reason: 'Gửi thanh tra' }));
      cleanup();
      open(leadDetail({ lead: leadLine(1, { status: 'CONFIRMED' }), confirm_reason: 'Cùng tác giả ba tệp', may_take: false }));
      await loaded();
      expect(screen.getByTestId('confirm-reason').textContent).toContain('Cùng tác giả ba tệp');
      cleanup();
      open(leadDetail({ lead: leadLine(1, { status: 'DISMISSED' }), dismiss_reason: 'Văn phòng chung', may_take: false }));
      await loaded();
      expect(screen.getByTestId('dismissed-reason').textContent).toContain('Văn phòng chung');
    });
  });

  describe('states', () => {
    it('says no lead was chosen', () => {
      open(leadDetail(), { path: '/vnd/vnd-14' });
      expect(screen.getByTestId('lead-missing').textContent).toBe(word('vnd3.lead.missing.text'));
    });

    it('HIDDEN: says the scope is hidden and names nothing when the server answers 404 (the caller took part in the packages) or 403', async () => {
      open(leadDetail(), { failing: { getVendorLead: { error: problem(404, 'RESOURCE_NOT_FOUND'), times: 9 } } });
      expect((await screen.findByTestId('lead-hidden')).textContent).toBe(word('vnd3.lead.hidden.text'));
      expect(screen.queryByTestId('lead-facts')).toBeNull();
      expect(screen.queryByTestId('take-lead')).toBeNull();
      cleanup();
      open(leadDetail(), { failing: { getVendorLead: { error: problem(403, 'SCOPE_DENIED'), times: 9 } } });
      expect(await screen.findByTestId('lead-hidden')).toBeTruthy();
    });

    it('LOADING, then ERROR with a retry', async () => {
      const pending = client({ answers: {} });
      pending.read.mockImplementation(() => new Promise(() => undefined));
      mount(<LeadDetailScreen route={route} />, pending, { permissions: LEAD_READER, path: `/vnd/vnd-14?lead=${LEAD}` });
      expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
      cleanup();
      open(leadDetail(), { failing: { getVendorLead: { error: problem(500, 'INTERNAL_ERROR'), times: 1 } } });
      expect((await screen.findByRole('alert')).textContent).toContain(word('states.error.title'));
      fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
      await loaded();
    });

    it('STALE: keeps the last answer when a refresh fails', async () => {
      let calls = 0;
      const world: World = { answers: { getVendorLead: () => (++calls === 1 ? leadDetail() : problem(500, 'INTERNAL_ERROR')), getVendorContractorLinks: linkGraph() } };
      const mounted = mount(<LeadDetailScreen route={route} />, client(world), { permissions: AUDITOR, path: `/vnd/vnd-14?lead=${LEAD}` });
      await loaded();
      await mounted.queries.refetchQueries({ queryKey: ['vnd'] });
      expect(await screen.findByTestId('stale-notice')).toBeTruthy();
      expect(screen.getByTestId('lead-facts')).toBeTruthy();
    });
  });

  it('speaks English when the language is English', async () => {
    translator.setLocale('en');
    open();
    expect((await screen.findByTestId('fact-kind')).textContent).toContain('Cluster of linked contractors');
    expect(screen.getByTestId('not-conclusion').textContent).toContain('not a conclusion');
  });
});
