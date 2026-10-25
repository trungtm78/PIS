import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import ResultScreen from './ResultScreen';
import { AUTHORITY, DECISION, ME, MINUTES, PROPOSER, READER, client, contractorId, mount, packageId, resultId, result, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('BID-18', 'FR-BID-18');
const OK = { operation_id: 'o', status: 'SUBMITTED', resource_version: 2, resource_id: resultId(1) };
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { permissions?: readonly string[]; package?: number | null; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY' } = {}) {
  const h = client(state, options.command ?? (() => OK));
  const query = options.package === null ? '' : `?package=${packageId(options.package ?? 1)}`;
  mount(<ResultScreen route={ROUTE} />, h, { permissions: options.permissions ?? READER, path: `/bid/bid-18${query}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const dialog = (): HTMLElement => screen.getByRole('dialog');
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const rows = (): string[] => Array.from(document.querySelectorAll('[data-result]')).map((row) => row.getAttribute('data-result') as string);
const UUID = '00000000-0000-4000-8000-0000000000a1';

describe('ResultScreen (BID-18): the result of the selection of a contractor', () => {
  it('UI-BID-18: says that the decision is a person\'s and that nothing here comes from an AI', async () => {
    open(world(), { package: null });
    expect((await screen.findByTestId('choose-package')).textContent).toBe(vi_['bid.results.package.hint']);
    expect(screen.getByTestId('no-ai').textContent).toBe(vi_['bid.results.noAi.notice']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['bid.results.page.title']);
    expect(document.body.textContent?.toLowerCase()).not.toContain('gợi ý của ai');
  });

  it('offers the packages whose plan is in force and the ones the selection has ended, and no other', async () => {
    open(world(), { package: null });
    await screen.findByTestId('choose-package');
    const options = Array.from((document.getElementById('results-package') as HTMLSelectElement).options).map((option) => option.textContent);
    expect(options).toEqual([vi_['bid.results.package.choose'], 'GT-1 · Gói thầu xây lắp 1', 'GT-2 · Gói thầu xây lắp 2']);
  });

  it('shows the results of the chosen package: the outcome, the winner, the price against the price of the package, the evaluation, who submitted and who decided, and the status', async () => {
    open(
      world({
        results: [
          result(2, 1, { status: 'SUBMITTED', award_price_vnd: '17000000000' }),
          result(1, 1, { status: 'REJECTED', decided_by: { membership_id: ME, display_name: 'Người duyệt' }, decided_at: '2026-10-21T02:00:00.000Z', comment: 'Giá chưa được chứng minh.' }),
        ],
      }),
    );
    await screen.findByTestId('results');
    expect(rows()).toEqual([resultId(2), resultId(1)]);
    const first = document.querySelector(`[data-result="${resultId(2)}"]`) as HTMLElement;
    expect(within(first).getByTestId('outcome').textContent).toBe(vi_['bid.results.outcome.awarded']);
    expect(within(first).getByTestId('winner').textContent).toBe('Công ty nhà thầu 1');
    expect(within(first).getByTestId('price').textContent).toBe(text('bid.results.price.value', { price: '17.000.000.000', budget: '18.000.000.000' }));
    expect(within(first).getByTestId('minutes').textContent).toBe('Biên bản đánh giá');
    expect(within(first).getByTestId('submitted').textContent).toContain('Chuyên viên đấu thầu');
    expect(within(first).getByTestId('decided').textContent).toBe(vi_['bid.results.none.text']);
    expect(within(first).getByTestId('status').textContent).toBe(vi_['bid.results.status.submitted']);
    const second = document.querySelector(`[data-result="${resultId(1)}"]`) as HTMLElement;
    expect(within(second).getByTestId('decided').textContent).toContain('Người duyệt');
    expect(within(second).getByTestId('decided').textContent).toContain('Giá chưa được chứng minh.');
    expect(within(second).getByTestId('status').textContent).toBe(vi_['bid.results.status.rejected']);
    expect(screen.getByTestId('package-status').textContent).toBe(text('bid.results.package.status', { project: 'PRJ-001', status: 'APPROVED' }));
  });

  it('shows an outcome with no winner and no price with dashes, and says so when the package has no result', async () => {
    open(world({ results: [result(1, 1, { outcome: 'NO_ACCEPTABLE_BID', winner: null, award_price_vnd: null, evaluation_minutes: null, submitted_by: null })] }));
    await screen.findByTestId('results');
    const row = rows()[0] as string;
    const line = document.querySelector(`[data-result="${row}"]`) as HTMLElement;
    for (const id of ['winner', 'price', 'minutes', 'submitted']) expect(within(line).getByTestId(id).textContent).toBe(vi_['bid.results.none.text']);
    cleanup();
    open(world(), { package: 1 });
    expect((await screen.findByTestId('no-results')).textContent).toBe(vi_['bid.results.none.notice']);
  });

  describe('who is offered what', () => {
    it('offers the submission to a proposer for a package whose plan is in force and that has no result waiting, and to nobody else', async () => {
      open(world(), { permissions: PROPOSER });
      await screen.findByTestId('no-results');
      expect(screen.getByRole('button', { name: vi_['bid.results.submit.action'] })).toBeTruthy();
      cleanup();
      open(world({ results: [result(1, 1)] }), { permissions: PROPOSER });
      await screen.findByTestId('results');
      expect(screen.queryByRole('button', { name: vi_['bid.results.submit.action'] })).toBeNull();
      cleanup();
      open(world(), { permissions: PROPOSER, package: 2 });
      await screen.findByTestId('no-results');
      expect(screen.queryByRole('button', { name: vi_['bid.results.submit.action'] })).toBeNull();
      cleanup();
      open(world(), { permissions: READER });
      await screen.findByTestId('no-results');
      expect(screen.queryByRole('button', { name: vi_['bid.results.submit.action'] })).toBeNull();
      cleanup();
      open(world(), { permissions: PROPOSER, mode: 'READ_ONLY' });
      await screen.findByTestId('no-results');
      expect(screen.queryByRole('button', { name: vi_['bid.results.submit.action'] })).toBeNull();
    });

    it('offers the decision on a result that waits to an authority who did not submit it, and says whose it is when it is their own', async () => {
      open(world({ results: [result(1, 1), result(2, 1, { submitted_by: { membership_id: ME, display_name: 'Tôi' } }), result(3, 1, { status: 'APPROVED' })] }), { permissions: AUTHORITY });
      await screen.findByTestId('results');
      expect(Array.from(document.querySelectorAll('[data-decide]')).map((button) => button.getAttribute('data-decide'))).toEqual([resultId(1)]);
      const own = document.querySelector(`[data-result="${resultId(2)}"]`) as HTMLElement;
      expect(within(own).getByTestId('own-result').textContent).toBe(vi_['bid.results.own.notice']);
      cleanup();
      open(world({ results: [result(1, 1)] }), { permissions: READER });
      await screen.findByTestId('results');
      expect(document.querySelectorAll('[data-decide]')).toHaveLength(0);
      expect(screen.queryByTestId('own-result')).toBeNull();
    });
  });

  describe('submitting a result', () => {
    const start = async (state: World = world(), options: Parameters<typeof open>[1] = {}) => {
      const h = open(state, { permissions: PROPOSER, ...options });
      await screen.findByTestId('no-results');
      fireEvent.click(screen.getByRole('button', { name: vi_['bid.results.submit.action'] }));
      return h;
    };
    const send = (): void => {
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.results.submit.action'] }));
    };

    it('AC-ST-BID-006-1, UAT-AC455: asks for the outcome, the winner, the price and the evaluation, offers the verified contractors, and sends the award', async () => {
      const h = await start();
      expect(within(dialog()).getByText(text('bid.results.submit.title', { code: 'GT-1' }))).toBeTruthy();
      send();
      expect(within(dialog()).getAllByText(vi_['bid.results.problem.required'])).toHaveLength(2);
      pick('result-outcome', 'AWARDED');
      await waitFor(() => expect(Array.from((document.getElementById('result-winner') as HTMLSelectElement).options).map((option) => option.textContent)).toContain('Công ty nhà thầu 1'));
      const winners = Array.from((document.getElementById('result-winner') as HTMLSelectElement).options).map((option) => option.textContent);
      expect(winners).not.toContain('Công ty chưa xác minh');
      send();
      expect(within(dialog()).getAllByText(vi_['bid.results.problem.required']).length).toBeGreaterThanOrEqual(3);
      pick('result-winner', contractorId(1));
      pick('result-price', '17.650');
      pick('result-minutes', 'nope');
      send();
      expect(within(dialog()).getByText(vi_['bid.results.problem.price'])).toBeTruthy();
      expect(within(dialog()).getByText(vi_['bid.results.problem.uuid'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      pick('result-price', '17650000000');
      pick('result-minutes', MINUTES.toUpperCase());
      send();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'submitProcurementResult',
        expect.objectContaining({ body: { package_id: packageId(1), outcome: 'AWARDED', evaluation_report_id: MINUTES, winner_contractor_id: contractorId(1), award_price_vnd: '17650000000' } }),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('sends no winner and no price for an outcome that has none, and drops what was typed when the outcome changes', async () => {
      const h = await start();
      pick('result-outcome', 'AWARDED');
      pick('result-price', '5');
      pick('result-outcome', 'NO_ACCEPTABLE_BID');
      expect(document.getElementById('result-winner')).toBeNull();
      expect(document.getElementById('result-price')).toBeNull();
      pick('result-minutes', MINUTES);
      send();
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('submitProcurementResult', expect.objectContaining({ body: { package_id: packageId(1), outcome: 'NO_ACCEPTABLE_BID', evaluation_report_id: MINUTES } })));
    });

    it('AC-ST-BID-006-1, AC-ST-BID-006-2: says why the server refused it: the price, a restricted winner, an evaluation that is not issued, a plan that is not in force, a result still open', async () => {
      for (const [error, expected] of [
        [problem('PRICE_EXCEEDS_PACKAGE_BUDGET'), vi_['bid.results.error.priceExceeds']],
        [problem('CONTRACTOR_RESTRICTED'), vi_['bid.results.error.restricted']],
        [problem('CONTRACTOR_NOT_VERIFIED'), vi_['bid.results.error.notVerified']],
        [problem('REPORT_NOT_ISSUED', 409), vi_['bid.results.error.reportNotIssued']],
        [problem('PLAN_NOT_APPROVED', 409), vi_['bid.results.error.planNotApproved']],
        [problem('RESULT_STATE_INVALID', 409, { reason: 'OPEN_RESULT' }), vi_['bid.results.error.openResult']],
        [problem('VALIDATION_FAILED'), vi_['bid.results.error.validation']],
        [new Error('boom'), vi_['bid.results.error.general']],
      ] as const) {
        await start(world(), { command: () => error });
        pick('result-outcome', 'CANCELLED');
        pick('result-minutes', MINUTES);
        send();
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(expected);
        expect((document.getElementById('result-minutes') as HTMLInputElement).value).toBe(MINUTES);
        cleanup();
      }
    });
  });

  describe('deciding a result', () => {
    const start = async (options: Parameters<typeof open>[1] = {}) => {
      const h = open(world({ results: [result(1, 1, { version: 3 })] }), { permissions: AUTHORITY, ...options });
      await screen.findByTestId('results');
      fireEvent.click(document.querySelector(`[data-decide="${resultId(1)}"]`) as HTMLElement);
      return h;
    };
    const choose = (kind: 'APPROVE' | 'REJECT'): void => {
      fireEvent.click(document.querySelector(`input[data-decision="${kind}"]`) as HTMLElement);
    };
    const confirm = (label: string): void => {
      fireEvent.click(within(dialog()).getByRole('button', { name: label }));
    };

    it('AC-ST-BID-006-1, UAT-AC455: asks for the decision, then for the document of an approval, and sends it under the version the screen showed', async () => {
      const h = await start();
      expect(within(dialog()).getByText(text('bid.results.decide.title', { code: 'GT-1' }))).toBeTruthy();
      confirm(vi_['bid.results.decide.approve']);
      expect(within(dialog()).getByText(vi_['bid.results.problem.required'])).toBeTruthy();
      choose('APPROVE');
      confirm(vi_['bid.results.decide.approve']);
      expect(within(dialog()).getByText(vi_['bid.results.problem.required'])).toBeTruthy();
      pick('result-document', 'nope');
      confirm(vi_['bid.results.decide.approve']);
      expect(within(dialog()).getByText(vi_['bid.results.problem.uuid'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      pick('result-document', DECISION.toUpperCase());
      pick('result-comment', ' KQ-01 ');
      confirm(vi_['bid.results.decide.approve']);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('decideProcurementResult', expect.objectContaining({ path: { id: resultId(1) }, ifMatchVersion: 3, body: { decision: 'APPROVE', decision_document_id: DECISION, comment: 'KQ-01' } }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('turns a result down with the reason in words and no document', async () => {
      const h = await start();
      choose('REJECT');
      expect(document.getElementById('result-document')).toBeNull();
      confirm(vi_['bid.results.decide.reject']);
      expect(within(dialog()).getByText(vi_['bid.results.problem.required'])).toBeTruthy();
      pick('result-comment', 'Giá chưa được chứng minh.');
      confirm(vi_['bid.results.decide.reject']);
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('decideProcurementResult', expect.objectContaining({ ifMatchVersion: 3, body: { decision: 'REJECT', comment: 'Giá chưa được chứng minh.' } })));
    });

    it('says why the server refused the decision: a proposer, a limit, a missing document, a result that moved', async () => {
      for (const [error, expected] of [
        [problem('SELF_APPROVAL_DENIED', 403), vi_['bid.results.error.selfApproval']],
        [problem('SCOPE_DENIED', 403, { approver_role_id: UUID }), vi_['bid.results.error.delegation']],
        [problem('SCOPE_DENIED', 403), vi_['bid.results.error.denied']],
        [problem('DOA_RULE_NOT_FOUND'), vi_['bid.results.error.noRule']],
        [problem('DECISION_DOCUMENT_NOT_EFFECTIVE'), vi_['bid.results.error.decisionDocument']],
        [problem('RESULT_STATE_INVALID', 409), vi_['bid.results.error.resultState']],
        [problem('VERSION_CONFLICT', 409), vi_['bid.results.error.versionConflict']],
        [problem('RESOURCE_NOT_FOUND', 404), vi_['bid.results.error.notFound']],
        [problem('SESSION_EXPIRED', 401), vi_['bid.results.error.session']],
        [problem('PRICE_EXCEEDS_PACKAGE_BUDGET'), vi_['bid.results.error.priceExceeds']],
      ] as const) {
        await start({ command: () => error });
        choose('APPROVE');
        pick('result-document', DECISION);
        confirm(vi_['bid.results.decide.approve']);
        expect((await within(dialog()).findByTestId('refusal')).textContent).toBe(expected);
        cleanup();
      }
    });
  });

  describe('the seven states (UI-BID-18)', () => {
    const failing = (error: ApiError) => {
      const h = client(world());
      (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = vi.fn(() => Promise.reject(error));
      mount(<ResultScreen route={ROUTE} />, h, { permissions: READER, path: '/bid/bid-18' });
    };

    it('shows a loading state first, then the denied, signed-out, offline and error states, and the empty state when no package has a result to show', async () => {
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
      open(world({ packages: [] }), { package: null });
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    });

    it('shows the failure of the results of the chosen package, and reads them again on retry', async () => {
      const state = world({ results: [result(1, 1)] });
      state.failing.add('listProcurementResults');
      open(state);
      const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
      state.failing.delete('listProcurementResults');
      fireEvent.click(retry);
      await screen.findByTestId('results');
    });
  });
});
