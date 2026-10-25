import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { formatVnd } from '../plan-model';
import ProposalScreen from './ProposalScreen';
import { AUTHORITY, CLERK, EVALUATOR, KEY, READER, SHA, client, contractorId, declaration, declarationId, files, mount, opened, opening, pack, packageId, proposal, proposalId, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('BID-05', 'FR-BID-05');
const PATH = `/bid/bid-05?package=${packageId(1)}`;
const UPLOADED = { file_object_key: KEY, file_sha256: SHA, size_bytes: 3 * 1024 * 1024, page_count: 120 };
const OK = { operation_id: 'o', status: 'RECEIVED', resource_version: 1, resource_id: proposalId(9) };
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const PAST = '2026-01-12T02:00:00.000Z';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Options {
  state?: World;
  command?: (operation: string, input: unknown) => unknown;
  upload?: () => unknown;
  permissions?: readonly string[];
  mode?: 'FULL' | 'READ_ONLY';
  path?: string;
}

function open(options: Options = {}) {
  const state = options.state ?? world();
  const h = client(state, options.command ?? (() => OK));
  const upload = vi.fn(async () => {
    const result = options.upload?.() ?? UPLOADED;
    if (result instanceof Error) throw result;
    return result;
  });
  (h.client as unknown as { upload: unknown }).upload = upload;
  mount(<ProposalScreen route={ROUTE} />, h, { permissions: options.permissions ?? CLERK, path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, upload, state };
}

const rowOf = (n: number): HTMLElement => document.querySelector(`[data-proposal-id="${proposalId(n)}"]`) as HTMLElement;
const labelled = (key: string, params: Record<string, string | number> = {}): HTMLElement => screen.getByLabelText(text(key, params));
const click = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }));
};
const dialog = (): HTMLElement => screen.getByRole('dialog');

describe('ProposalScreen (BID-05): the sealed proposals and the declaration of conflict of interest', () => {
  describe('the clerk', () => {
    it('UI-BID-05, AC-ST-BID-004-1, UAT-AC448: sees the receipt of each proposal while the bids are closed, with the price hidden and no way to open one', async () => {
      open();
      await screen.findByTestId('proposals');
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['bid.proposals.page.title']);
      expect(screen.getByTestId('opening').textContent).toBe(text('bid.proposals.locked.text', { date: '2099-11-12 09:00' }));
      expect(Array.from(document.querySelectorAll('thead th')).map((header) => header.textContent)).toEqual([
        vi_['bid.proposals.column.contractor'],
        vi_['bid.proposals.column.revision'],
        vi_['bid.proposals.column.received'],
        vi_['bid.proposals.column.files'],
        vi_['bid.proposals.column.state'],
        vi_['bid.proposals.column.price'],
        vi_['bid.proposals.column.action'],
      ]);
      const row = rowOf(1);
      expect(row.getAttribute('data-access')).toBe('METADATA');
      expect(within(row).getByRole('rowheader').textContent).toBe('Công ty nhà thầu 1');
      expect(Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)).toEqual([
        text('bid.proposals.revision.text', { revision: 1 }),
        '2026-11-10 09:00',
        '2',
        vi_['bid.proposals.access.locked'],
        vi_['bid.proposals.price.hidden'],
        '',
      ]);
      expect(screen.queryByRole('button', { name: /Xem hồ sơ/ })).toBeNull();
      expect(screen.queryByTestId('conflict-panel')).toBeNull();
      expect(screen.getByRole('button', { name: vi_['bid.proposals.intake.action'] })).toHaveProperty('disabled', false);
      expect(screen.getByText(text('bid.proposals.footer.reference', { id: 'BID-05', req: 'FR-BID-05' }))).toBeTruthy();
    });

    it('says the receipt is only the receipt once the bids are opened, and that the bids are closed to new proposals', async () => {
      open({ state: world({ milestones: [opening(1, PAST)], proposals: [proposal(1, 1, { access_released_at: PAST, locked: false })] }) });
      await screen.findByTestId('proposals');
      expect(screen.getByTestId('opening').textContent).toBe(text('bid.proposals.released.text', { date: '2026-01-12 09:00' }));
      expect(within(rowOf(1)).getByTestId('access').textContent).toBe(vi_['bid.proposals.access.metadata']);
      expect(screen.getByRole('button', { name: vi_['bid.proposals.intake.action'] })).toHaveProperty('disabled', true);
    });

    it('does not offer the receipt of a proposal when the package has no opening, and says why', async () => {
      open({ state: world({ milestones: [] }) });
      await screen.findByTestId('proposals');
      expect(screen.getByTestId('opening-unset').textContent).toBe(vi_['bid.proposals.opening.unset']);
      expect(screen.getByRole('button', { name: vi_['bid.proposals.intake.action'] })).toHaveProperty('disabled', true);
    });

    it('shows a replaced proposal after the live ones, with its state', async () => {
      open({ state: world({ proposals: [proposal(1, 1, { status: 'SUPERSEDED', submitted_at: '2026-11-11T02:00:00.000Z' }), proposal(2, 1)] }) });
      await screen.findByTestId('proposals');
      expect(Array.from(document.querySelectorAll('[data-proposal-id]')).map((row) => row.getAttribute('data-status'))).toEqual(['RECEIVED', 'SUPERSEDED']);
      expect(within(rowOf(1)).getByText(vi_['bid.proposals.status.superseded'])).toBeTruthy();
    });

    it('offers no way to receive a proposal to someone who may only read, or in a read-only session', async () => {
      open({ permissions: READER });
      await screen.findByTestId('proposals');
      expect(screen.queryByRole('button', { name: vi_['bid.proposals.intake.action'] })).toBeNull();
      cleanup();
      open({ mode: 'READ_ONLY' });
      await screen.findByTestId('proposals');
      expect(screen.queryByRole('button', { name: vi_['bid.proposals.intake.action'] })).toBeNull();
    });
  });

  describe('the choice of a package', () => {
    it('lists the packages that are open for bids, asks for one first and reads the proposals of the one chosen', async () => {
      const { h } = open({ state: world({ packages: [pack(1), pack(2), pack(3, { status: 'DRAFT' })] }), path: '/bid/bid-05' });
      expect((await screen.findByTestId('choose-package')).textContent).toBe(vi_['bid.proposals.package.hint']);
      expect(Array.from((labelled('bid.proposals.package.label') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
        vi_['bid.proposals.package.choose'],
        'GT-1 · Gói thầu xây lắp 1',
        'GT-2 · Gói thầu xây lắp 2',
      ]);
      expect(screen.queryByTestId('proposals')).toBeNull();
      fireEvent.change(labelled('bid.proposals.package.label'), { target: { value: packageId(1) } });
      await screen.findByTestId('proposals');
      expect((h.client as unknown as { readAll: { mock: { calls: unknown[][] } } }).readAll.mock.calls.some((call) => call[0] === 'get_resources_proposal' && JSON.stringify(call[1]) === JSON.stringify({ query: { package_id: packageId(1) } }))).toBe(true);
      fireEvent.change(labelled('bid.proposals.package.label'), { target: { value: '' } });
      expect(await screen.findByTestId('choose-package')).toBeTruthy();
    });

    it('ignores a package in the address that is not open for bids', async () => {
      open({ path: `/bid/bid-05?package=${packageId(7)}` });
      expect(await screen.findByTestId('choose-package')).toBeTruthy();
    });

    it('says so when the package has no proposal the caller may see', async () => {
      open({ state: world({ proposals: [] }) });
      expect((await screen.findByTestId('no-proposals')).textContent).toBe(vi_['bid.proposals.none.notice']);
    });
  });

  describe('the member of the evaluation team', () => {
    const released = (overrides: Partial<World> = {}) =>
      world({
        milestones: [opening(1, PAST)],
        proposals: [opened(1, 1), opened(2, 1, { bid_price_vnd: '17000000000' })],
        declarations: [declaration(1, { has_conflict: false, relation_text: null, contractor: null, standing: 'CLEAR', is_own: true })],
        ...overrides,
      });

    it('AC-ST-BID-004-1, UAT-AC448: sees the price and can open the proposal in full from the opening, once they declared', async () => {
      const state = released();
      state.details = { [proposalId(1)]: { ...opened(1, 1), documents: files } };
      const { h } = open({ state, permissions: EVALUATOR });
      await screen.findByTestId('proposals');
      expect(within(rowOf(1)).getByTestId('access').textContent).toBe(vi_['bid.proposals.access.full']);
      expect(within(rowOf(1)).getByTestId('price').textContent).toBe(formatVnd('17650000000'));
      expect(within(rowOf(2)).getByTestId('price').textContent).toBe(formatVnd('17000000000'));
      expect(screen.getByTestId('own-standing').textContent).toBe(vi_['bid.conflict.own.clear']);
      expect(screen.queryByTestId('conflict-banner')).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['bid.proposals.intake.action'] })).toBeNull();
      fireEvent.click(within(rowOf(1)).getByRole('button', { name: text('bid.proposals.open.aria', { name: 'Công ty nhà thầu 1' }) }));
      const detail = await screen.findByTestId('proposal-detail');
      expect(h.read).toHaveBeenCalledWith('get_resources_proposal_id', { path: { id: proposalId(1) } });
      expect(within(detail).getByTestId('detail-price').textContent).toBe(formatVnd('17650000000'));
      expect(Array.from(within(detail).getByTestId('detail-files').querySelectorAll('li')).map((item) => item.textContent)).toEqual([
        `Đề xuất kỹ thuật ${vi_['bid.proposals.part.technical']} · ${text('bid.proposals.detail.pages', { pages: 120 })} · 3.0 MB`,
        `Đề xuất tài chính ${vi_['bid.proposals.part.financial']} · ${text('bid.proposals.detail.pages', { pages: 12 })} · 200 KB`,
      ]);
      fireEvent.click(within(detail).getAllByRole('button', { name: vi_['bid.proposals.detail.close'] })[0] as HTMLElement);
      expect(screen.queryByTestId('proposal-detail')).toBeNull();
    });

    it('says why a proposal cannot be opened when the server refuses it', async () => {
      const state = released();
      state.details = {};
      open({ state, permissions: EVALUATOR });
      await screen.findByTestId('proposals');
      fireEvent.click(within(rowOf(1)).getByRole('button', { name: text('bid.proposals.open.aria', { name: 'Công ty nhà thầu 1' }) }));
      expect((await screen.findByTestId('open-refusal')).textContent).toBe(vi_['bid.proposals.error.general']);
    });

    it('UAT-AC450: is told to declare before anything else, and sees the proposals as waiting for the declaration, without a price or a button', async () => {
      const state = released({
        proposals: [{ ...proposal(1, 1, { access_released_at: PAST, locked: false, access: 'DECLARATION_REQUIRED' }) }],
        declarations: [],
      });
      open({ state, permissions: EVALUATOR });
      await screen.findByTestId('proposals');
      expect(within(rowOf(1)).getByTestId('access').textContent).toBe(vi_['bid.proposals.access.declaration']);
      expect(within(rowOf(1)).getByTestId('price').textContent).toBe(vi_['bid.proposals.price.hidden']);
      expect(within(rowOf(1)).queryByRole('button')).toBeNull();
      const banner = screen.getByTestId('conflict-banner');
      expect(banner.textContent).toContain(vi_['bid.conflict.required.notice']);
    });

    it('AC-ST-BID-004-2: declares that no relation stands between them and a bidder', async () => {
      const state = released({ declarations: [] });
      const { h } = open({ state, permissions: EVALUATOR, command: () => ({ operation_id: 'o', status: 'CLEAR', resource_version: 1, resource_id: declarationId(1) }) });
      await screen.findByTestId('conflict-banner');
      click(vi_['bid.conflict.declare.action']);
      expect(dialog()).toBeTruthy();
      // The question is asked and never assumed.
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.conflict.declare.submit'] }));
      expect(within(dialog()).getByText(vi_['bid.conflict.problem.answer'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.click(within(dialog()).getByLabelText(vi_['bid.conflict.declare.no']));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.conflict.declare.submit'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('declareConflictOfInterest', expect.objectContaining({ path: { id: packageId(1) }, body: { has_conflict: false } }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('AC-ST-BID-004-2: declares a conflict with the words of the relation and the contractor it is with', async () => {
      const state = released({ declarations: [] });
      const { h } = open({ state, permissions: EVALUATOR });
      await screen.findByTestId('conflict-banner');
      click(vi_['bid.conflict.declare.action']);
      fireEvent.click(within(dialog()).getByLabelText(vi_['bid.conflict.declare.yes']));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.conflict.declare.submit'] }));
      expect(within(dialog()).getByText(vi_['bid.conflict.problem.relation'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(within(dialog()).getByLabelText(vi_['bid.conflict.field.relation']), { target: { value: '  Giám đốc là anh em họ của tôi.  ' } });
      await waitFor(() => expect((within(dialog()).getByLabelText(vi_['bid.conflict.field.contractor']) as HTMLSelectElement).options.length).toBeGreaterThan(1));
      fireEvent.change(within(dialog()).getByLabelText(vi_['bid.conflict.field.contractor']), { target: { value: contractorId(1) } });
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.conflict.declare.submit'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'declareConflictOfInterest',
        expect.objectContaining({ path: { id: packageId(1) }, body: { has_conflict: true, relation_text: 'Giám đốc là anh em họ của tôi.', contractor_id: contractorId(1) } }),
      );
    });

    it('says what the server refused when the declaration was made already, and keeps the dialog', async () => {
      const state = released({ declarations: [] });
      open({ state, permissions: EVALUATOR, command: () => problem('ALREADY_DECLARED') });
      await screen.findByTestId('conflict-banner');
      click(vi_['bid.conflict.declare.action']);
      fireEvent.click(within(dialog()).getByLabelText(vi_['bid.conflict.declare.no']));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.conflict.declare.submit'] }));
      expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_['bid.conflict.error.alreadyDeclared']);
    });

    it('tells a member who is waiting for a decision, one who is recused and one who is blocked what they can and cannot see', async () => {
      for (const [standing, key] of [
        ['PENDING', 'bid.conflict.own.pending'],
        ['RECUSED', 'bid.conflict.own.recused'],
        ['BLOCKED', 'bid.conflict.own.blocked'],
        ['ALLOWED', 'bid.conflict.own.allowed'],
      ] as const) {
        open({ state: released({ proposals: [], declarations: [declaration(1, { is_own: true, standing })] }), permissions: EVALUATOR });
        expect((await screen.findByTestId('own-standing')).textContent).toBe(vi_[key]);
        cleanup();
      }
    });

    it('offers no declaration in a read-only session', async () => {
      open({ state: released({ declarations: [] }), permissions: EVALUATOR, mode: 'READ_ONLY' });
      await screen.findByTestId('proposals');
      expect(screen.queryByTestId('conflict-banner')).toBeNull();
    });
  });

  describe('whoever decides', () => {
    const decisions = () =>
      world({
        milestones: [opening(1, PAST)],
        proposals: [],
        mayDecide: true,
        declarations: [
          declaration(1),
          declaration(2, { is_own: true, member: { membership_id: 'm', display_name: 'Người duyệt' } }),
          declaration(3, { has_conflict: false, relation_text: null, contractor: null, standing: 'CLEAR' }),
          declaration(4, { decision: 'ALLOWED', standing: 'ALLOWED', version: 2, contractor: null }),
        ],
      });
    const declarationRow = (n: number): HTMLElement => document.querySelector(`[data-declaration-id="${declarationId(n)}"]`) as HTMLElement;

    it('sees every declaration of the package with the words of the relation and decides the ones that name a conflict, never their own', async () => {
      open({ state: decisions(), permissions: AUTHORITY });
      await screen.findByTestId('declarations');
      expect(Array.from(document.querySelectorAll('[data-declaration-id]')).map((row) => [row.getAttribute('data-declaration-id'), row.getAttribute('data-standing')])).toEqual([
        [declarationId(1), 'PENDING'],
        [declarationId(2), 'PENDING'],
        [declarationId(3), 'CLEAR'],
        [declarationId(4), 'ALLOWED'],
      ]);
      expect(Array.from(declarationRow(1).querySelectorAll('td')).map((cell) => cell.textContent)).toEqual([
        'Giám đốc nhà thầu là anh em họ của tôi.',
        'Công ty nhà thầu 1',
        '2026-11-10 10:00',
        vi_['bid.conflict.standing.pending'],
        vi_['bid.conflict.decide.action'],
      ]);
      expect(within(declarationRow(2)).getByTestId('own-note').textContent).toBe(vi_['bid.conflict.own.note']);
      expect(within(declarationRow(2)).queryByRole('button')).toBeNull();
      expect(within(declarationRow(3)).queryByRole('button')).toBeNull();
      expect(within(declarationRow(3)).getAllByRole('cell')[0]?.textContent).toBe(vi_['bid.conflict.none.text']);
      expect(within(declarationRow(4)).getByRole('button').textContent).toBe(vi_['bid.conflict.decide.again']);
      expect(within(declarationRow(4)).getAllByRole('cell')[1]?.textContent).toBe(vi_['bid.conflict.whole.text']);
      expect(screen.queryByTestId('conflict-banner')).toBeNull();
    });

    it('AC-ST-BID-004-2, UAT-AC450: asks for a decision and for reasons in words, then decides under the version they saw', async () => {
      const { h } = open({ state: decisions(), permissions: AUTHORITY });
      await screen.findByTestId('declarations');
      fireEvent.click(within(declarationRow(1)).getByRole('button', { name: text('bid.conflict.decide.aria', { name: 'Chuyên gia 1' }) }));
      expect(within(dialog()).getByTestId('decision-relation').textContent).toBe(text('bid.conflict.decide.relation', { text: 'Giám đốc nhà thầu là anh em họ của tôi.' }));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.conflict.decide.submit'] }));
      expect(within(dialog()).getByText(vi_['bid.conflict.problem.decision'])).toBeTruthy();
      expect(within(dialog()).getByText(vi_['bid.conflict.problem.reasonShort'])).toBeTruthy();
      expect(Array.from((within(dialog()).getByLabelText(vi_['bid.conflict.field.decision']) as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
        vi_['bid.conflict.field.decision.choose'],
        vi_['bid.conflict.decision.allowed'],
        vi_['bid.conflict.decision.recused'],
        vi_['bid.conflict.decision.blocked'],
      ]);
      fireEvent.change(within(dialog()).getByLabelText(vi_['bid.conflict.field.decision']), { target: { value: 'RECUSED' } });
      fireEvent.change(within(dialog()).getByLabelText(vi_['bid.conflict.field.reason']), { target: { value: 'Short.' } });
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.conflict.decide.submit'] }));
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(within(dialog()).getByLabelText(vi_['bid.conflict.field.reason']), { target: { value: '  Mối quan hệ họ hàng gần với giám đốc nhà thầu.  ' } });
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.conflict.decide.submit'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'decideConflictOfInterest',
        expect.objectContaining({ path: { id: declarationId(1) }, ifMatchVersion: 1, body: { decision: 'RECUSED', decision_reason: 'Mối quan hệ họ hàng gần với giám đốc nhà thầu.' } }),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('decides again a declaration that was decided, under its newer version', async () => {
      const { h } = open({ state: decisions(), permissions: AUTHORITY });
      await screen.findByTestId('declarations');
      fireEvent.click(within(declarationRow(4)).getByRole('button'));
      fireEvent.change(within(dialog()).getByLabelText(vi_['bid.conflict.field.decision']), { target: { value: 'BLOCKED' } });
      fireEvent.change(within(dialog()).getByLabelText(vi_['bid.conflict.field.reason']), { target: { value: 'Có thông tin mới về mối quan hệ.' } });
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.conflict.decide.submit'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('decideConflictOfInterest', expect.objectContaining({ path: { id: declarationId(4) }, ifMatchVersion: 2 })));
    });

    it('says what the server refused: the declaration of the decider, a stale version and a declaration with no conflict', async () => {
      for (const [code, status, key] of [
        ['SELF_APPROVAL_DENIED', 403, 'bid.conflict.error.selfApproval'],
        ['VERSION_CONFLICT', 409, 'bid.conflict.error.versionConflict'],
        ['NO_CONFLICT_DECLARED', 422, 'bid.conflict.error.noConflict'],
      ] as const) {
        open({ state: decisions(), permissions: AUTHORITY, command: () => problem(code, status) });
        await screen.findByTestId('declarations');
        fireEvent.click(within(declarationRow(1)).getByRole('button'));
        fireEvent.change(within(dialog()).getByLabelText(vi_['bid.conflict.field.decision']), { target: { value: 'ALLOWED' } });
        fireEvent.change(within(dialog()).getByLabelText(vi_['bid.conflict.field.reason']), { target: { value: 'Đã xem xét và cho phép tham gia.' } });
        fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.conflict.decide.submit'] }));
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_[key]);
        cleanup();
      }
    });

    it('shows the error when the declarations cannot be read', async () => {
      open({ state: world({ failing: new Set(['listConflictDeclarations']) }), permissions: EVALUATOR });
      expect((await screen.findByTestId('conflict-error')).textContent).toBe(vi_['bid.conflict.error.load']);
    });
  });

  describe('the receipt of a proposal', () => {
    const intakeButton = (): HTMLElement => screen.getByRole('button', { name: vi_['bid.proposals.intake.action'] });
    const choose = (n: number): void => {
      const input = labelled('bid.proposals.file.pick', { n }) as HTMLInputElement;
      fireEvent.change(input, { target: { files: [new File(['%PDF-1.7'], 'ho-so-ky-thuat.pdf', { type: 'application/pdf' })] } });
    };

    it('UI-BID-05: asks for what is missing before it sends anything', async () => {
      const { h } = open();
      await screen.findByTestId('proposals');
      fireEvent.click(intakeButton());
      expect(dialog()).toBeTruthy();
      await waitFor(() => expect((labelled('bid.proposals.field.contractor') as HTMLSelectElement).options.length).toBeGreaterThan(1));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.proposals.intake.submit'] }));
      expect(within(dialog()).getAllByText(vi_['bid.proposals.problem.required'])).toHaveLength(2);
      expect(within(dialog()).getByText(vi_['bid.proposals.problem.files'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('offers the verified contractors only and marks the one that is restricted', async () => {
      open();
      await screen.findByTestId('proposals');
      fireEvent.click(intakeButton());
      await waitFor(() => expect((labelled('bid.proposals.field.contractor') as HTMLSelectElement).options.length).toBeGreaterThan(1));
      expect(Array.from((labelled('bid.proposals.field.contractor') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
        vi_['bid.proposals.field.contractor.choose'],
        'Công ty nhà thầu 1',
        text('bid.proposals.field.contractor.restricted', { name: 'Công ty nhà thầu 2' }),
      ]);
    });

    it('AC-ST-BID-004-1, UAT-AC448: puts each file through the upload door, names it by the key and the digest the door answered, and receives the proposal', async () => {
      const { h, upload } = open({ command: () => OK });
      await screen.findByTestId('proposals');
      fireEvent.click(intakeButton());
      await waitFor(() => expect((labelled('bid.proposals.field.contractor') as HTMLSelectElement).options.length).toBeGreaterThan(1));
      fireEvent.change(labelled('bid.proposals.field.contractor'), { target: { value: contractorId(1) } });
      fireEvent.change(labelled('bid.proposals.field.submittedAt'), { target: { value: '2025-10-24T09:00' } });
      fireEvent.change(labelled('bid.proposals.field.price'), { target: { value: '17650000000' } });
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.proposals.files.add'] }));
      choose(1);
      expect((await screen.findByTestId('file-uploaded')).textContent).toBe(text('bid.proposals.file.uploaded', { pages: 120, size: '3.0 MB' }));
      expect(upload).toHaveBeenCalledTimes(1);
      // The name of the file becomes the title until the clerk says otherwise.
      expect((labelled('bid.proposals.file.title', { n: 1 }) as HTMLInputElement).value).toBe('ho-so-ky-thuat');
      fireEvent.change(labelled('bid.proposals.file.part', { n: 1 }), { target: { value: 'FINANCIAL' } });
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.proposals.intake.submit'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'receiveProposal',
        expect.objectContaining({
          body: {
            package_id: packageId(1),
            contractor_id: contractorId(1),
            submitted_at: '2025-10-24T02:00:00.000Z',
            bid_price_vnd: '17650000000',
            documents: [{ part: 'FINANCIAL', title: 'ho-so-ky-thuat', file_object_key: KEY, file_sha256: SHA }],
          },
        }),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('does not send a proposal whose file is not stored, and says why the file was refused', async () => {
      const { h } = open({ upload: () => problem('UPLOAD_NOT_PDF') });
      await screen.findByTestId('proposals');
      fireEvent.click(intakeButton());
      await waitFor(() => expect((labelled('bid.proposals.field.contractor') as HTMLSelectElement).options.length).toBeGreaterThan(1));
      fireEvent.change(labelled('bid.proposals.field.contractor'), { target: { value: contractorId(1) } });
      fireEvent.change(labelled('bid.proposals.field.submittedAt'), { target: { value: '2025-10-24T09:00' } });
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.proposals.files.add'] }));
      choose(1);
      expect((await screen.findByTestId('file-failed')).textContent).toBe(vi_['bid.proposals.error.notPdf']);
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.proposals.intake.submit'] }));
      expect(within(dialog()).getByText(vi_['bid.proposals.problem.notUploaded'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      // The row can be taken out.
      fireEvent.click(within(dialog()).getByRole('button', { name: text('bid.proposals.file.remove.aria', { n: 1 }) }));
      expect(document.querySelector('[data-file-uid]')).toBeNull();
    });

    it('says what the server refused: the bids are closed, the contractor is restricted or a file is already used', async () => {
      for (const [code, key, extensions] of [
        ['BID_CLOSED', 'bid.proposals.error.bidClosed', {}],
        ['CONTRACTOR_RESTRICTED', 'bid.proposals.error.restricted', {}],
        ['CONTRACTOR_NOT_VERIFIED', 'bid.proposals.error.notVerified', {}],
        ['VALIDATION_FAILED', 'bid.proposals.error.fileUsed', { reason: 'FILE_ALREADY_ATTACHED' }],
      ] as const) {
        open({ command: () => problem(code, 422, extensions) });
        await screen.findByTestId('proposals');
        fireEvent.click(intakeButton());
        await waitFor(() => expect((labelled('bid.proposals.field.contractor') as HTMLSelectElement).options.length).toBeGreaterThan(1));
        fireEvent.change(labelled('bid.proposals.field.contractor'), { target: { value: contractorId(1) } });
        fireEvent.change(labelled('bid.proposals.field.submittedAt'), { target: { value: '2025-10-24T09:00' } });
        fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.proposals.files.add'] }));
        choose(1);
        await screen.findByTestId('file-uploaded');
        fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.proposals.intake.submit'] }));
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(vi_[key]);
        expect(screen.getByRole('dialog')).toBeTruthy();
        cleanup();
      }
    });
  });

  describe('the seven states (UI-BID-05)', () => {
    const failing = (error: ApiError) => {
      const h = client(world(), () => OK);
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => Promise.reject(error));
      mount(<ProposalScreen route={ROUTE} />, h, { permissions: CLERK, path: PATH });
    };

    it('shows a loading state first, then the denied, signed-out, offline and error states, and the empty state when no package is open', async () => {
      failing(problem('SCOPE_DENIED', 403));
      expect(screen.getByRole('status')).toBeTruthy();
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      cleanup();
      failing(problem('SESSION_EXPIRED', 401));
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
      cleanup();
      failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }));
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      failing(problem('INTERNAL_ERROR', 500));
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      cleanup();
      open({ state: world({ packages: [pack(1, { status: 'DRAFT' })] }) });
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    });

    it('reads the packages again on retry', async () => {
      const state = world({ failing: new Set(['get_resources_procurement_package']) });
      open({ state });
      const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
      state.failing.clear();
      fireEvent.click(retry);
      await screen.findByTestId('proposals');
    });

    it('shows the error of the proposals on their own and reads them again on request', async () => {
      const state = world({ failing: new Set(['get_resources_proposal']) });
      open({ state });
      const error = await screen.findByTestId('proposals-error');
      expect(error.textContent).toContain(vi_['bid.proposals.error.load']);
      state.failing.clear();
      fireEvent.click(within(error).getByRole('button', { name: vi_['bid.proposals.error.retry'] }));
      await screen.findByTestId('proposals');
    });
  });
});
