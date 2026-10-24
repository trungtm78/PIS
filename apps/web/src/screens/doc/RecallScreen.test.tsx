import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import RecallScreen from './RecallScreen';
import { harness, mount, mountInSession, routeOf } from './test-support';

const ROUTE = routeOf('DOC-19', 'FR-DOC-19');
const DOC = '00000000-0000-4000-8000-0000000000d9';
const ANCHOR = '00000000-0000-4000-8000-0000000000a9';
const OTHER = '00000000-0000-4000-8000-0000000000d8';
const OTHER_ANCHOR = '00000000-0000-4000-8000-0000000000a8';
const APPROVER = '00000000-0000-4000-8000-0000000000b1';
const LEADER = ['doc.outgoing.read', 'doc.outgoing.recall'];
const MANAGER = ['doc.outgoing.read', 'doc.outgoing.void_number'];
const REASON = 'Wrong figures in table 2, issued for the wrong period';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: DOC,
  document_id: ANCHOR,
  title: 'Decision to assign capital',
  doc_type_code: 'QD',
  status: 'DELIVERED',
  document_number: 42,
  symbol: '42/QD-UBND',
  issued_on: '2026-10-23',
  issued_at: '2026-10-23T03:00:00Z',
  created_at: '2026-10-23T01:00:00Z',
  effect_status: 'EFFECTIVE',
  version: 6,
  ...overrides,
});

const notice = (overrides: Record<string, unknown> = {}) => ({
  id: 'd1',
  recipient_name: 'Department of Finance',
  channel: 'PAPER_HANDOVER',
  status: 'SENT',
  recall_notice_at: null,
  ...overrides,
});

const event = (overrides: Record<string, unknown> = {}) => ({
  id: 'e1',
  kind: 'ISSUED',
  from_status: 'SEALED',
  to_status: 'ISSUED',
  actor_id: '00000000-0000-4000-8000-000000000001',
  comment: null,
  occurred_at: '2026-10-23T03:00:00Z',
  ...overrides,
});

interface World {
  docs: Array<Record<string, unknown>>;
  events?: unknown[];
  next?: Record<string, string>;
}

/** The server as the screen sees it: the list by status, the document by id and its timeline. */
function answer(world: World) {
  return (operation: string, input: unknown): unknown => {
    const query = input as { query?: { status: string; cursor?: string }; path?: { id: string } };
    if (operation === 'listOutgoingDocuments') {
      const status = query.query?.status ?? '';
      const items = world.docs.filter((doc) => doc.status === status);
      const next = world.next?.[status];
      if (next !== undefined && query.query?.cursor === undefined) return { items, next_cursor: next };
      return { items: query.query?.cursor === undefined ? items : [], next_cursor: null };
    }
    if (operation === 'getOutgoingDocument') return world.docs.find((doc) => doc.id === query.path?.id) ?? new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' });
    if (operation === 'getDocumentTimeline') return { events: world.events ?? [] };
    return new Error(`unexpected read ${operation}`);
  };
}

const problem = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }) });

afterEach(cleanup);

describe('RecallScreen (DOC-19)', () => {
  it('shows a delivered document in force with the recall form and its timeline', async () => {
    const world: World = { docs: [row({ distributions: [notice()] })], events: [event()] };
    mount(<RecallScreen route={ROUTE} />, harness(answer(world)), LEADER);
    expect(await screen.findByRole('form', { name: vi_['doc.recall.recall.form'] })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['doc.recall.page.title']);
    expect(screen.getByTestId('document-status').textContent).toBe(vi_['doc.recall.status.delivered']);
    expect(screen.getByTestId('document-effect').textContent).toBe(vi_['doc.recall.effect.text'].replace('{effect}', vi_['doc.recall.effect.effective']));
    expect(screen.getByText(vi_['doc.recall.symbol.text'].replace('{symbol}', '42/QD-UBND'))).toBeTruthy();
    expect(screen.getByText(vi_['doc.recall.version.pill'].replace('{version}', '6'))).toBeTruthy();
    expect(screen.queryByTestId('recall-banner')).toBeNull();
    expect(screen.queryByRole('form', { name: vi_['doc.recall.void.form'] })).toBeNull();
    const history = await screen.findByRole('list', { name: vi_['doc.recall.history.title'] });
    expect(within(history).getByText(vi_['doc.draft.event.issued'])).toBeTruthy();
  });

  it('says there is nothing to recall when no document is listed', async () => {
    mount(<RecallScreen route={ROUTE} />, harness(answer({ docs: [] })), LEADER);
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  it('says the documents could not be read and reads them again on request', async () => {
    const world: World = { docs: [row()] };
    let fails = true;
    const h = harness((operation, input) => (fails ? new ApiError({ status: 503, code: 'UNAVAILABLE', correlationId: 'c' }) : answer(world)(operation, input)));
    mount(<RecallScreen route={ROUTE} />, h, LEADER);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    fails = false;
    await user.click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    expect(await screen.findByRole('form', { name: vi_['doc.recall.recall.form'] })).toBeTruthy();
  });

  describe('recalling (AC-ST-DOC-012-1, UAT-AC411)', () => {
    it('asks for a reason of ten characters, then recalls with the version it saw, the basis and the notice (trimmed)', async () => {
      const world: World = { docs: [row(), row({ id: OTHER, document_id: OTHER_ANCHOR, title: 'Recalling decision', status: 'ISSUED', created_at: '2026-10-23T00:00:00Z' })] };
      const h = harness(answer(world), () => ({ status: 'RECALLED', resource_id: DOC, resource_version: 7 }));
      mount(<RecallScreen route={ROUTE} />, h, LEADER);
      const user = userEvent.setup();
      const button = await screen.findByRole('button', { name: vi_['doc.recall.recall.submit.action'] });
      await user.click(button);
      expect((await screen.findByRole('alert')).textContent).toBe(vi_['doc.recall.reason.problem.required']);
      const reason = screen.getByLabelText(vi_['doc.recall.recall.reason.label']);
      await user.type(reason, 'too short');
      await user.click(button);
      expect((await screen.findByRole('alert')).textContent).toBe(vi_['doc.recall.reason.problem.tooShort']);
      expect(h.command).not.toHaveBeenCalled();
      await user.clear(reason);
      await user.type(reason, `  ${REASON}  `);
      await user.selectOptions(screen.getByLabelText(vi_['doc.recall.recall.basis.label']), OTHER_ANCHOR);
      await user.click(button);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('recallOutgoingDocument');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: DOC }, ifMatchVersion: 6, body: { reason: REASON, notify_recipients: true, recall_basis_document_id: OTHER_ANCHOR } });
      const done = await screen.findByText(vi_['doc.recall.done.recalled'].replace('{symbol}', '42/QD-UBND'));
      expect(done.closest('[role="status"]')).not.toBeNull();
    });

    it('offers only other documents in force as the basis, and sends no basis and no notice when none is chosen', async () => {
      const world: World = {
        docs: [row(), row({ id: OTHER, document_id: OTHER_ANCHOR, title: 'Recalling decision', status: 'ISSUED', created_at: '2026-10-23T00:00:00Z' }), row({ id: 'n1', document_id: 'a3', title: 'Not in force yet', status: 'NUMBERED' })],
      };
      const h = harness(answer(world), () => ({ status: 'RECALLED', resource_id: DOC, resource_version: 7 }));
      mount(<RecallScreen route={ROUTE} />, h, LEADER);
      const user = userEvent.setup();
      const basis = (await screen.findByLabelText(vi_['doc.recall.recall.basis.label'])) as HTMLSelectElement;
      expect([...basis.options].map((option) => option.value)).toEqual(['', OTHER_ANCHOR]);
      await user.type(screen.getByLabelText(vi_['doc.recall.recall.reason.label']), REASON);
      await user.click(screen.getByLabelText(vi_['doc.recall.recall.notify.label']));
      await user.click(screen.getByRole('button', { name: vi_['doc.recall.recall.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { reason: REASON, notify_recipients: false } });
      expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).not.toHaveProperty('recall_basis_document_id');
    });

    it('tells an archived document it needs a basis', async () => {
      // Archived documents are not listed (the archive is its own flow); one opened by its address can still be recalled with a basis.
      mount(<RecallScreen route={ROUTE} />, harness(answer({ docs: [row({ status: 'ARCHIVED' })] })), LEADER, `/doc/doc-19?doc=${DOC}`);
      expect(await screen.findByText(vi_['doc.recall.recall.basis.required'])).toBeTruthy();
    });

    it.each([
      ['VERSION_CONFLICT', 409, 'doc.recall.problem.conflict'],
      ['DOCUMENT_STATE_INVALID', 409, 'doc.recall.problem.state'],
      ['RECALL_BASIS_REQUIRED', 422, 'doc.recall.problem.basis'],
      ['VALIDATION_FAILED', 422, 'doc.recall.problem.invalid'],
      ['RESOURCE_NOT_FOUND', 404, 'doc.recall.problem.notFound'],
      ['SCOPE_DENIED', 403, 'doc.recall.problem.denied'],
      ['SESSION_EXPIRED', 401, 'doc.recall.problem.session'],
      ['SOMETHING_ELSE', 500, 'doc.recall.problem.general'],
    ] as const)('says in words why the recall was refused: %s', async (code, status, key) => {
      const h = harness(answer({ docs: [row()] }), () => problem(status, code));
      mount(<RecallScreen route={ROUTE} />, h, LEADER);
      const user = userEvent.setup();
      await user.type(await screen.findByLabelText(vi_['doc.recall.recall.reason.label']), REASON);
      await user.click(screen.getByRole('button', { name: vi_['doc.recall.recall.submit.action'] }));
      expect((await screen.findByRole('alert')).textContent).toContain(vi_[key]);
    });

    it('says a failure that is not an answer of the server in general words', async () => {
      const h = harness(answer({ docs: [row()] }), () => new Error('offline'));
      mount(<RecallScreen route={ROUTE} />, h, LEADER);
      const user = userEvent.setup();
      await user.type(await screen.findByLabelText(vi_['doc.recall.recall.reason.label']), REASON);
      await user.click(screen.getByRole('button', { name: vi_['doc.recall.recall.submit.action'] }));
      expect((await screen.findByRole('alert')).textContent).toContain(vi_['doc.recall.problem.general']);
    });

    it('shows no way to recall to someone without the right, and nothing at all in a suspended tenant', async () => {
      mount(<RecallScreen route={ROUTE} />, harness(answer({ docs: [row()] })), ['doc.outgoing.read']);
      expect(await screen.findByText(vi_['doc.recall.recall.denied'])).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['doc.recall.recall.submit.action'] })).toBeNull();
      cleanup();
      const view = mountInSession(<RecallScreen route={ROUTE} />, harness(answer({ docs: [row()] })), { permissions: LEADER, mode: 'READ_ONLY' });
      expect(await screen.findByText(vi_['doc.recall.frozen.notice'])).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['doc.recall.recall.submit.action'] })).toBeNull();
      view.unmount();
    });

    it('does not submit twice while the first recall is on its way', async () => {
      let release: (value: unknown) => void = () => undefined;
      const h = harness(answer({ docs: [row()] }));
      h.command.mockImplementation(() => new Promise((resolve) => (release = resolve)));
      mount(<RecallScreen route={ROUTE} />, h, LEADER);
      const user = userEvent.setup();
      await user.type(await screen.findByLabelText(vi_['doc.recall.recall.reason.label']), REASON);
      const button = screen.getByRole('button', { name: vi_['doc.recall.recall.submit.action'] }) as HTMLButtonElement;
      await user.click(button);
      await waitFor(() => expect(button.disabled).toBe(true));
      await user.click(button);
      expect(h.command).toHaveBeenCalledTimes(1);
      release({ status: 'RECALLED', resource_id: DOC, resource_version: 7 });
    });
  });

  describe('a recalled document', () => {
    const recalled = (distributions: unknown[]) =>
      row({ status: 'RECALLED', effect_status: 'RECALLED', recall_reason: REASON, recalled_at: '2026-10-23T04:00:00Z', recalled_by: '00000000-0000-4000-8000-0000000000c1', distributions, version: 7 });

    it('shows the banner with the reason, the notice each recipient got and the timeline, and offers no recall', async () => {
      const world: World = {
        docs: [
          recalled([
            notice({ id: 'd1', recipient_name: 'Department of Finance', status: 'ACKNOWLEDGED', recall_notice_at: '2026-10-23T04:00:00Z' }),
            notice({ id: 'd2', recipient_name: 'State Treasury', status: 'CANCELLED', channel: 'EMAIL' }),
          ]),
        ],
        events: [event(), event({ id: 'e2', kind: 'RECALLED', from_status: 'DELIVERED', to_status: 'RECALLED', comment: REASON, occurred_at: '2026-10-23T04:00:00Z' })],
      };
      mount(<RecallScreen route={ROUTE} />, harness(answer(world)), LEADER);
      const banner = await screen.findByTestId('recall-banner');
      expect(banner.textContent).toContain(vi_['doc.recall.banner.title']);
      expect(banner.textContent).toContain(REASON);
      expect(banner.textContent).toContain('42/QD-UBND');
      expect(screen.getByTestId('document-status').textContent).toBe(vi_['doc.recall.status.recalled']);
      expect(screen.getByTestId('document-effect').textContent).toContain(vi_['doc.recall.effect.recalled']);
      expect(screen.queryByRole('form', { name: vi_['doc.recall.recall.form'] })).toBeNull();
      expect(screen.getByTestId('notice-progress').textContent).toBe(vi_['doc.recall.notices.progress'].replace('{noticed}', '1').replace('{total}', '2').replace('{calledOff}', '1'));
      const finance = document.querySelector('tr[data-distribution-id="d1"]') as HTMLElement;
      expect(finance.textContent).toContain('Department of Finance');
      expect(finance.textContent).not.toContain(vi_['doc.recall.notice.none']);
      const treasury = document.querySelector('tr[data-distribution-id="d2"]') as HTMLElement;
      expect(treasury.textContent).toContain(vi_['doc.recall.notice.none']);
      const history = await screen.findByRole('list', { name: vi_['doc.recall.history.title'] });
      expect(within(history).getByText(vi_['doc.draft.event.recalled'])).toBeTruthy();
      expect(within(history).getByText(REASON)).toBeTruthy();
    });

    it('says the document was sent to nobody, and that the timeline is empty', async () => {
      mount(<RecallScreen route={ROUTE} />, harness(answer({ docs: [recalled([])] })), LEADER);
      expect(await screen.findByText(vi_['doc.recall.notices.empty'])).toBeTruthy();
      expect(await screen.findByText(vi_['doc.recall.history.empty'])).toBeTruthy();
    });
  });

  describe('voiding a number (AC-ST-DOC-012-2, UAT-AC427)', () => {
    const numbered = (overrides: Record<string, unknown> = {}) => row({ status: 'NUMBERED', effect_status: 'PENDING', issued_at: null, version: 3, ...overrides });

    it('asks for the reason and the approver in the browser, then voids with the version it saw', async () => {
      const world: World = { docs: [numbered()] };
      // Voiding takes the number off the document: the notice must still name the number that was voided.
      const h = harness(answer(world), () => {
        world.docs = [numbered({ status: 'CANCELLED', effect_status: 'EXPIRED', document_number: null, symbol: null, version: 4 })];
        return { status: 'CANCELLED', resource_id: DOC, resource_version: 4 };
      });
      mount(<RecallScreen route={ROUTE} />, h, MANAGER);
      const user = userEvent.setup();
      const button = await screen.findByRole('button', { name: vi_['doc.recall.void.submit.action'] });
      expect(screen.queryByRole('form', { name: vi_['doc.recall.recall.form'] })).toBeNull();
      await user.click(button);
      const alerts = await screen.findAllByRole('alert');
      expect(alerts.map((alert) => alert.textContent)).toEqual([vi_['doc.recall.reason.problem.required'], vi_['doc.recall.void.approver.invalid']]);
      await user.type(screen.getByLabelText(vi_['doc.recall.void.reason.label']), REASON);
      await user.type(screen.getByLabelText(vi_['doc.recall.void.approver.label']), 'not an id');
      await user.click(button);
      expect((await screen.findByRole('alert')).textContent).toBe(vi_['doc.recall.void.approver.invalid']);
      expect(h.command).not.toHaveBeenCalled();
      const approver = screen.getByLabelText(vi_['doc.recall.void.approver.label']);
      await user.clear(approver);
      await user.type(approver, `  ${APPROVER.toUpperCase()}  `);
      await user.click(button);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('voidOutgoingDocumentNumber');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: DOC }, ifMatchVersion: 3, body: { reason: REASON, approver_user_id: APPROVER } });
      expect(await screen.findByText(vi_['doc.recall.done.voided'].replace('{number}', '42'))).toBeTruthy();
    });

    it('voids a sealed document too, and says in words why the void was refused', async () => {
      const cases = [
        ['SELF_APPROVAL_DENIED', 403, undefined, 'doc.recall.problem.selfApproval'],
        ['VALIDATION_FAILED', 422, 'approver_user_id', 'doc.recall.problem.approver'],
        ['DOCUMENT_STATE_INVALID', 409, undefined, 'doc.recall.problem.state'],
      ] as const;
      for (const [code, status, detail, key] of cases) {
        const h = harness(answer({ docs: [numbered({ status: 'SEALED' })] }), () => problem(status, code, detail));
        mount(<RecallScreen route={ROUTE} />, h, MANAGER);
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText(vi_['doc.recall.void.reason.label']), REASON);
        await user.type(screen.getByLabelText(vi_['doc.recall.void.approver.label']), APPROVER);
        await user.click(screen.getByRole('button', { name: vi_['doc.recall.void.submit.action'] }));
        expect((await screen.findByRole('alert')).textContent).toContain(vi_[key]);
        cleanup();
      }
    });

    it('shows no way to void to someone without the right, and nothing at all in a suspended tenant', async () => {
      mount(<RecallScreen route={ROUTE} />, harness(answer({ docs: [numbered()] })), ['doc.outgoing.read']);
      expect(await screen.findByText(vi_['doc.recall.void.denied'])).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['doc.recall.void.submit.action'] })).toBeNull();
      cleanup();
      const view = mountInSession(<RecallScreen route={ROUTE} />, harness(answer({ docs: [numbered()] })), { permissions: MANAGER, mode: 'READ_ONLY' });
      expect(await screen.findByText(vi_['doc.recall.frozen.notice'])).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['doc.recall.void.submit.action'] })).toBeNull();
      view.unmount();
    });
  });

  describe('choosing a document', () => {
    it('opens the document chosen from the list, with a clean form, and keeps the choice in the address', async () => {
      const world: World = { docs: [row(), row({ id: OTHER, document_id: OTHER_ANCHOR, title: 'Second decision', status: 'ISSUED', created_at: '2026-10-23T00:00:00Z', version: 2 })] };
      mount(<RecallScreen route={ROUTE} />, harness(answer(world)), LEADER);
      const user = userEvent.setup();
      const reason = await screen.findByLabelText(vi_['doc.recall.recall.reason.label']);
      await user.type(reason, 'a reason that was started');
      await user.selectOptions(screen.getByLabelText(vi_['doc.recall.queue.label']), OTHER);
      await waitFor(() => expect(screen.getByTestId('document-status').textContent).toBe(vi_['doc.recall.status.issued']));
      expect((screen.getByLabelText(vi_['doc.recall.recall.reason.label']) as HTMLTextAreaElement).value).toBe('');
      expect(screen.getByText(vi_['doc.recall.version.pill'].replace('{version}', '2'))).toBeTruthy();
    });

    it('opens the document named in the address even when it is not in the first page, and offers more documents when there are', async () => {
      const world: World = { docs: [row(), row({ id: OTHER, document_id: OTHER_ANCHOR, title: 'Named in the address', status: 'RECALLED', effect_status: 'RECALLED', created_at: '2026-10-22T00:00:00Z' })], next: { DELIVERED: 'c2' } };
      const h = harness(answer({ ...world, docs: world.docs.filter((doc) => doc.id !== OTHER) }));
      const withOther = harness((operation, input) => (operation === 'getOutgoingDocument' && (input as { path: { id: string } }).path.id === OTHER ? world.docs[1] : answer(world)(operation, input)));
      mount(<RecallScreen route={ROUTE} />, withOther, LEADER, `/doc/doc-19?doc=${OTHER}`);
      expect(await screen.findByTestId('recall-banner')).toBeTruthy();
      expect(screen.getByTestId('document-status').textContent).toBe(vi_['doc.recall.status.recalled']);
      const more = await screen.findByRole('button', { name: vi_['doc.recall.queue.more.action'] });
      const user = userEvent.setup();
      await user.click(more);
      await waitFor(() => expect(withOther.read.mock.calls.filter(([operation, input]) => operation === 'listOutgoingDocuments' && (input as { query: { cursor?: string } }).query.cursor === 'c2')).toHaveLength(1));
      expect(h.command).not.toHaveBeenCalled();
    });
  });
});
