import { NETWORK_ERROR_CODE } from '@machvon/api-client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import ReviewScreen from './ReviewScreen';
import { EVALUATOR, NOBODY, RECORD, client, failedRun, findingId, mount, packageId, problem, proposalId, reviewEntry, reviewable, routeOf, run, runId, scored, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('BID-12', 'FR-BID-12');
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const LONG = 'Hợp đồng tương tự ở trang 18 chưa được nghiệm thu, không đạt yêu cầu kinh nghiệm';
const NINETEEN = 'x'.repeat(19);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Options {
  permissions?: readonly string[];
  path?: string;
  mode?: 'FULL' | 'READ_ONLY';
  command?: (operation: string, input: unknown) => unknown;
}

function open(state: World, options: Options = {}) {
  const h = client(state, options.command);
  mount(<ReviewScreen route={ROUTE} />, h, { permissions: options.permissions ?? EVALUATOR, path: options.path ?? `/bid/bid-12?run=${runId(1)}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

/** A run that waits for the experts, with one finding scored 4 out of 5 by an expert, one nobody decided and one that lacks a source. */
const three = (): World =>
  world({
    runs: [run(1)],
    findings: [scored(1), reviewable(2, { status: 'CONTRADICTED' }), reviewable(3, { status: 'NEEDS_REVIEW', evidence_count: 0, missing_source: true, evidence: [] })],
  });
const panelOf = (n: number): HTMLElement => document.querySelector(`[data-review="${findingId(n)}"]`) as HTMLElement;
const cardOf = (n: number): HTMLElement => document.querySelector(`[data-finding="${findingId(n)}"]`) as HTMLElement;
const field = (kind: 'status' | 'score' | 'reason', n: number): HTMLElement => document.getElementById(`review-${kind}-${findingId(n)}`) as HTMLElement;
const typeReason = (n: number, value: string): void => void fireEvent.change(field('reason', n), { target: { value } });
const submit = (n: number): void => void fireEvent.click(within(panelOf(n)).getByRole('button', { name: vi_['bid.review.submit.action'] }));

/** The decision of an expert as the server records it: the finding now stands for what they set, with one decision more. */
function recording(state: World, n: number, status: string, score: string | null, decision: string) {
  return () => {
    const found = state.findings[n - 1] as Record<string, unknown>;
    const version = (found.version as number) + 1;
    Object.assign(found, {
      final_status: status,
      final_score: score,
      reviewed_at: '2026-12-07T04:00:00.000Z',
      review_count: version - 1,
      version,
      reviews: [...(found.reviews as unknown[]), reviewEntry(version, { from_status: 'SUPPORTED', to_status: status, score_before: '4.00', score_after: score, reason: LONG, decision })],
    });
    return { operation_id: '00000000-0000-4000-8000-000000000999', status, resource_version: version, resource_id: findingId(n), review_id: `00000000-0000-4000-8000-0000000b${String(version).padStart(4, '0')}`, decision, final_status: status, final_score: score, ai_decision_record_id: RECORD, run_status: 'AWAITING_REVIEW' };
  };
}

describe('ReviewScreen (BID-12): the expert verification of the findings of an analysis run', () => {
  describe('the standard states of the screen', () => {
    it('UI-BID-12: shows the loading state, then the findings under the label of an AI proposal with the decision of the person in a panel of its own', async () => {
      open(three());
      expect(screen.getByRole('status', { busy: true })).toBeTruthy();
      expect(await screen.findByTestId('findings')).toBeTruthy();
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['bid.review.page.title']);
      expect(screen.getByTestId('ai-notice').textContent).toBe(vi_['bid.review.page.aiNotice']);
      expect(screen.getByText(text('bid.review.footer.reference', { id: 'BID-12', req: 'FR-BID-12' }))).toBeTruthy();
      expect(screen.getAllByTestId('ai-label')).toHaveLength(3);
      for (const label of screen.getAllByTestId('ai-label')) expect(label.textContent).toBe(vi_['bid.analysis.finding.aiLabel']);
      expect(document.querySelectorAll('[data-review]')).toHaveLength(3);
      // What the model said is never inside the panel of what a person decided.
      expect(within(panelOf(1)).queryByTestId('ai-label')).toBeNull();
      expect(within(cardOf(1)).queryByTestId('final-status')).toBeNull();
    });

    it('UI-BID-12: says that no run is chosen, without reading one', async () => {
      const h = open(three(), { path: '/bid/bid-12' });
      expect((await screen.findByTestId('no-run')).textContent).toBe(vi_['bid.review.run.none']);
      expect(h.read).not.toHaveBeenCalled();
    });

    it('UI-BID-12: shows the empty state of a run with no finding, and the error, offline and signed-out states', async () => {
      open(world({ runs: [failedRun(1)] }));
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
      cleanup();
      const state = three();
      state.failing.set('listAnalysisFindings', new Error('down'));
      open(state);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      state.failing.clear();
      fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByTestId('findings')).toBeTruthy();
      for (const [failure, title] of [
        [problem(NETWORK_ERROR_CODE, 0), 'states.offline.title'],
        [problem('SESSION_EXPIRED', 401), 'states.signedOut.title'],
        [problem('SCOPE_DENIED', 403), 'states.denied.title'],
      ] as const) {
        cleanup();
        const failing = three();
        failing.failing.set('listAnalysisFindings', failure);
        open(failing);
        expect(await screen.findByText(vi_[title])).toBeTruthy();
      }
    });

    it('UI-BID-12: shows the denied state to a caller who is not in the evaluation team, and reads nothing for them', async () => {
      const h = open(three(), { permissions: NOBODY });
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      expect(h.read).not.toHaveBeenCalled();
      expect(screen.queryByTestId('findings')).toBeNull();
    });

    it('UAT-AC14: says there is no such run for a caller who has no view of its proposal, and names the declaration of one who owes it', async () => {
      open(world(), { path: `/bid/bid-12?run=${runId(7)}` });
      expect((await screen.findByTestId('run-not-found')).textContent).toBe(vi_['bid.review.run.notFound']);
      cleanup();
      const owes = three();
      owes.failing.set('listAnalysisFindings', problem('CONFLICT_UNDECLARED', 403));
      open(owes);
      expect((await screen.findByTestId('run-undeclared')).textContent).toBe(vi_['bid.review.run.undeclared']);
      expect(screen.queryByText(vi_['states.denied.title'])).toBeNull();
      expect(screen.queryByTestId('review-form')).toBeNull();
    });

    it('UI-BID-12: shows a run that is not waiting for the experts without a form, and a session that is read-only without one either', async () => {
      const state = three();
      state.runs = [run(1, { status: 'CANCELLED', cancel_reason: 'Chọn nhầm bộ tiêu chí' })];
      open(state);
      await screen.findByTestId('findings');
      expect(screen.getByTestId('run-not-reviewable').textContent).toBe(vi_['bid.review.run.notReviewable']);
      expect(screen.queryByTestId('review-form')).toBeNull();
      cleanup();
      open(three(), { mode: 'READ_ONLY' });
      await screen.findByTestId('findings');
      expect(screen.queryByTestId('run-not-reviewable')).toBeNull();
      expect(screen.queryByTestId('review-form')).toBeNull();
      expect(screen.getAllByTestId('history')).toHaveLength(1);
    });
  });

  describe('what the model said and what a person decided', () => {
    it('shows what stands for a finding a person decided, with its history: who, when, from what to what, the score, the reason and the decision', async () => {
      open(three());
      await screen.findByTestId('findings');
      const decided = panelOf(1);
      expect(within(decided).getByTestId('final-status').textContent).toBe(vi_['bid.analysis.findingStatus.supported']);
      expect(within(decided).getByTestId('final-score').textContent).toContain('4.00');
      const entry = within(decided).getByTestId('history').querySelector('[data-review-entry]') as HTMLElement;
      expect(within(entry).getByTestId('reviewer').textContent).toBe('Chuyên gia Lê Văn Hai');
      expect(within(entry).getByTestId('entry-decision').textContent).toBe(vi_['bid.review.decision.acceptedWithChange']);
      expect(within(entry).getByTestId('entry-change').textContent).toBe(text('bid.review.history.change', { from: vi_['bid.analysis.findingStatus.supported'], to: vi_['bid.analysis.findingStatus.supported'] }));
      expect(within(entry).getByTestId('entry-score').textContent).toBe(text('bid.review.history.score', { before: vi_['bid.review.history.noScore'], after: '4.00' }));
      expect(within(entry).getByTestId('entry-reason').textContent).toContain('đã được nghiệm thu');
      expect(within(entry).getByTestId('entry-record').textContent).toBe(text('bid.review.history.record', { id: RECORD.slice(0, 8) }));
    });

    it('says of a finding nobody decided that it does not stand as a conclusion, and shows no status of a person for it', async () => {
      open(three());
      await screen.findByTestId('findings');
      expect(within(panelOf(2)).getByTestId('undecided').textContent).toBe(vi_['bid.review.standing.none']);
      expect(within(panelOf(2)).queryByTestId('final-status')).toBeNull();
      expect(within(panelOf(2)).queryByTestId('history')).toBeNull();
      // The status that was proposed is still the one of the AI.
      expect(within(cardOf(2)).getByTestId('finding-status').textContent).toBe(vi_['bid.analysis.findingStatus.contradicted']);
    });

    it('UAT-NFR-AI-02: offers no accept action for all the findings and no award: one form to a finding, each with a reason', async () => {
      open(three());
      await screen.findByTestId('findings');
      expect(screen.getAllByTestId('review-form')).toHaveLength(3);
      expect(screen.queryByRole('checkbox')).toBeNull();
      const names = screen.queryAllByRole('button').map((button) => button.textContent ?? '');
      expect(names.filter((name) => /tất cả|all|hàng loạt|bulk|trúng|award|phê duyệt/i.test(name) && name !== vi_['bid.review.filter.status.all'])).toEqual([]);
      expect(screen.getAllByRole('button', { name: vi_['bid.review.submit.action'] })).toHaveLength(3);
      expect(screen.getByTestId('award-notice').textContent).toBe(vi_['bid.review.page.awardNotice']);
    });

    it('shows the way to the workbench and to the comparison of the package, carrying the ids that identify them', async () => {
      open(three());
      await screen.findByTestId('findings');
      expect(screen.getByTestId('link-workbench').getAttribute('href')).toBe(`/bid/bid-09?run=${runId(1)}`);
      expect(screen.getByTestId('link-compare').getAttribute('href')).toBe(`/bid/bid-10?package=${packageId(1)}&criteria_version_id=00000000-0000-4000-8000-006000000001`);
    });
  });

  describe('the review of a finding', () => {
    it('AC-ST-BID-010-1, UAT-AC16: refuses a short reason before anything is sent, then records the change from SUPPORTED 4 to CONTRADICTED 2 with the version seen, and shows the record of the decision of the person', async () => {
      const state = three();
      const h = open(state, { command: recording(state, 1, 'CONTRADICTED', '2.00', 'ACCEPTED_WITH_CHANGE') });
      await screen.findByTestId('findings');
      expect((field('status', 1) as HTMLSelectElement).value).toBe('SUPPORTED');
      fireEvent.change(field('status', 1), { target: { value: 'CONTRADICTED' } });
      fireEvent.change(field('score', 1), { target: { value: '2' } });
      typeReason(1, 'ngắn');
      submit(1);
      expect(await within(panelOf(1)).findByText(vi_['bid.review.reasonProblem.tooShort'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      typeReason(1, `  ${LONG}  `);
      submit(1);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'reviewAnalysisFinding',
        expect.objectContaining({ path: { id: findingId(1) }, body: { to_status: 'CONTRADICTED', reason: LONG, score_after: '2' }, ifMatchVersion: 2, attempt: expect.anything() }),
      );
      expect((await screen.findByTestId('recorded')).textContent).toBe(text('bid.review.recorded.text', { decision: vi_['bid.review.decision.acceptedWithChange'], record: RECORD.slice(0, 8) }));
      // The findings are read again: what stands is the decision, with the history of both.
      await waitFor(() => expect(within(panelOf(1)).getByTestId('final-status').textContent).toBe(vi_['bid.analysis.findingStatus.contradicted']));
      expect(within(panelOf(1)).getAllByTestId('history')[0]?.querySelectorAll('[data-review-entry]')).toHaveLength(2);
      expect(within(panelOf(1)).getByTestId('final-score').textContent).toContain('2.00');
      // The finding of the AI is as the model said it.
      expect(within(cardOf(1)).getByTestId('finding-status').textContent).toBe(vi_['bid.analysis.findingStatus.supported']);
      expect((field('reason', 1) as HTMLTextAreaElement).value).toBe('');
      // Nothing here decides the award: the only action of the form is the record of the decision.
      expect(screen.queryByRole('button', { name: /trúng|award/i })).toBeNull();
    });

    it('asks for 20 characters of reason once trimmed: 19 are refused, 20 are sent, and the count is shown as it is typed', async () => {
      const state = three();
      const h = open(state, { command: recording(state, 2, 'CONTRADICTED', null, 'ACCEPTED') });
      await screen.findByTestId('findings');
      typeReason(2, `   ${NINETEEN}   `);
      expect(within(panelOf(2)).getByTestId('reason-count').textContent).toBe(text('bid.review.reason.count', { count: 19, min: 20 }));
      submit(2);
      expect(await within(panelOf(2)).findByText(vi_['bid.review.reasonProblem.tooShort'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      typeReason(2, 'x'.repeat(4001));
      submit(2);
      await waitFor(() => expect(within(panelOf(2)).getByText(vi_['bid.review.reasonProblem.tooLong'])).toBeTruthy());
      typeReason(2, 'x'.repeat(20));
      submit(2);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('reviewAnalysisFinding', expect.objectContaining({ body: { to_status: 'CONTRADICTED', reason: 'x'.repeat(20) }, ifMatchVersion: 1 }));
    });

    it('refuses a score that is not a number before anything is sent', async () => {
      const h = open(three());
      await screen.findByTestId('findings');
      fireEvent.change(field('score', 2), { target: { value: '-1' } });
      typeReason(2, LONG);
      submit(2);
      expect(await within(panelOf(2)).findByText(vi_['bid.review.scoreProblem.invalid'])).toBeTruthy();
      fireEvent.change(field('score', 2), { target: { value: '1.234' } });
      submit(2);
      expect(await within(panelOf(2)).findByText(vi_['bid.review.scoreProblem.invalid'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('sends one review at a time: while one is on its way its fields cannot change, those of the other findings are closed, and a second click sends nothing', async () => {
      let release: (value: unknown) => void = () => undefined;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      const state = three();
      const finish = recording(state, 2, 'CONTRADICTED', null, 'ACCEPTED');
      const h = open(state, { command: () => pending.then(finish) as unknown as Error });
      await screen.findByTestId('findings');
      typeReason(2, LONG);
      submit(2);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(within(panelOf(2)).getByRole('button', { name: vi_['bid.review.submit.pending'] })).toBeTruthy());
      expect((field('reason', 2) as HTMLTextAreaElement).readOnly).toBe(true);
      expect((field('score', 2) as HTMLInputElement).readOnly).toBe(true);
      expect((field('status', 2) as HTMLSelectElement).disabled).toBe(true);
      expect((within(panelOf(2)).getByRole('button', { name: vi_['bid.review.submit.pending'] }) as HTMLButtonElement).disabled).toBe(true);
      for (const n of [1, 3]) {
        expect((field('reason', n) as HTMLTextAreaElement).disabled).toBe(true);
        expect((field('status', n) as HTMLSelectElement).disabled).toBe(true);
        expect((within(panelOf(n)).getByRole('button', { name: vi_['bid.review.submit.action'] }) as HTMLButtonElement).disabled).toBe(true);
      }
      // A mutation starts after the handler returns: the submits are flushed before the count is read.
      await act(async () => {
        fireEvent.submit(within(panelOf(2)).getByTestId('review-form'));
        fireEvent.submit(within(panelOf(1)).getByTestId('review-form'));
      });
      expect(h.command).toHaveBeenCalledTimes(1);
      release(undefined);
      await screen.findByTestId('recorded');
      expect((field('status', 1) as HTMLSelectElement).disabled).toBe(false);
    });

    it('keeps what was typed when the answer is lost, and the retry is the same request with the same idempotency key', async () => {
      const state = three();
      const finish = recording(state, 2, 'CONTRADICTED', null, 'ACCEPTED');
      let calls = 0;
      const h = open(state, {
        command: () => {
          calls += 1;
          return calls === 1 ? problem('INTERNAL_ERROR', 500) : finish();
        },
      });
      await screen.findByTestId('findings');
      typeReason(2, LONG);
      submit(2);
      expect((await within(panelOf(2)).findByTestId('refusal')).textContent).toBe(vi_['bid.review.error.general']);
      expect((field('reason', 2) as HTMLTextAreaElement).value).toBe(LONG);
      submit(2);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      const keys = h.command.mock.calls.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
      expect(keys[0]).toBe(keys[1]);
      await screen.findByTestId('recorded');
    });

    it('when the server recorded the decision but the answer was lost, the retry names the version of the first request and its key, so the server replays instead of recording twice', async () => {
      const state = three();
      const finish = recording(state, 2, 'CONTRADICTED', null, 'ACCEPTED');
      let calls = 0;
      const h = open(state, {
        command: () => {
          calls += 1;
          if (calls > 1) return finish();
          finish();
          return problem('INTERNAL_ERROR', 500);
        },
      });
      await screen.findByTestId('findings');
      const reads = h.read.mock.calls.length;
      typeReason(2, LONG);
      submit(2);
      await within(panelOf(2)).findByTestId('refusal');
      await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(reads));
      await waitFor(() => expect(within(panelOf(2)).getByTestId('final-status')).toBeTruthy());
      expect((field('reason', 2) as HTMLTextAreaElement).value).toBe(LONG);
      submit(2);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ ifMatchVersion: 1 });
      expect(h.command.mock.calls[1]?.[1]).toMatchObject({ ifMatchVersion: 1 });
      const keys = h.command.mock.calls.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
      expect(keys[0]).toBe(keys[1]);
    });

    it('a change of what is typed is a new intention with a new idempotency key', async () => {
      const state = three();
      const h = open(state, { command: () => problem('INTERNAL_ERROR', 500) });
      await screen.findByTestId('findings');
      typeReason(2, LONG);
      submit(2);
      await within(panelOf(2)).findByTestId('refusal');
      typeReason(2, `${LONG} (corrigé)`);
      submit(2);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      const keys = h.command.mock.calls.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
      expect(keys[0]).not.toBe(keys[1]);
    });

    it('meets a version conflict by reading the findings again, keeps what was typed, and the next request names the new version with a new key', async () => {
      const state = three();
      let calls = 0;
      const finish = recording(state, 2, 'CONTRADICTED', null, 'ACCEPTED');
      const h = open(state, {
        command: () => {
          calls += 1;
          if (calls > 1) return finish();
          // Someone else decided in the meantime: the finding has a decision more.
          Object.assign(state.findings[1] as Record<string, unknown>, { version: 2, review_count: 1, final_status: 'MISSING', reviewed_at: '2026-12-06T05:00:00.000Z', reviews: [reviewEntry(7, { from_status: 'CONTRADICTED', to_status: 'MISSING', score_after: null })] });
          return problem('VERSION_CONFLICT', 409, { current_version: 2 });
        },
      });
      await screen.findByTestId('findings');
      const reads = h.read.mock.calls.length;
      typeReason(2, LONG);
      submit(2);
      expect((await within(panelOf(2)).findByTestId('refusal')).textContent).toBe(vi_['bid.review.error.conflict']);
      await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(reads));
      await waitFor(() => expect(within(panelOf(2)).getByTestId('final-status').textContent).toBe(vi_['bid.analysis.findingStatus.missing']));
      expect((field('reason', 2) as HTMLTextAreaElement).value).toBe(LONG);
      submit(2);
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ ifMatchVersion: 1 });
      expect(h.command.mock.calls[1]?.[1]).toMatchObject({ ifMatchVersion: 2 });
      const keys = h.command.mock.calls.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
      expect(keys[0]).not.toBe(keys[1]);
    });

    it('words the refusals of the server: the reason, a run that is not in review any more, the declaration, a finding out of reach, the scope and the session', async () => {
      for (const [code, status, key] of [
        ['REASON_REQUIRED', 422, 'bid.review.error.reasonRequired'],
        ['RUN_NOT_COMPLETED', 422, 'bid.review.error.runNotCompleted'],
        ['CONFLICT_UNDECLARED', 403, 'bid.review.error.undeclared'],
        ['RESOURCE_NOT_FOUND', 404, 'bid.review.error.notFound'],
        ['VALIDATION_FAILED', 422, 'bid.review.error.validation'],
        ['SCOPE_DENIED', 403, 'bid.review.error.denied'],
        ['SESSION_EXPIRED', 401, 'bid.review.error.session'],
      ] as const) {
        open(three(), { command: () => problem(code, status) });
        await screen.findByTestId('findings');
        typeReason(2, LONG);
        submit(2);
        expect((await within(panelOf(2)).findByTestId('refusal')).textContent).toBe(vi_[key]);
        cleanup();
      }
    });

    it('does not show the decision recorded for one finding on another, and a refusal belongs to the finding it was sent for', async () => {
      const h = open(three(), { command: () => problem('REASON_REQUIRED', 422) });
      await screen.findByTestId('findings');
      typeReason(2, LONG);
      submit(2);
      await within(panelOf(2)).findByTestId('refusal');
      expect(within(panelOf(1)).queryByTestId('refusal')).toBeNull();
      expect(within(panelOf(3)).queryByTestId('refusal')).toBeNull();
      expect(h.command).toHaveBeenCalledTimes(1);
    });
  });

  describe('the filters and the pages', () => {
    it('filters by status and by the missing source, and keeps the filters where they are when nothing matches', async () => {
      open(three());
      await screen.findByTestId('findings');
      fireEvent.change(document.getElementById('review-finding-missing') as HTMLElement, { target: { value: 'true' } });
      await waitFor(() => expect(document.querySelectorAll('[data-review]')).toHaveLength(1));
      expect(panelOf(3)).toBeTruthy();
      fireEvent.change(document.getElementById('review-finding-status') as HTMLElement, { target: { value: 'MISSING' } });
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
      expect(document.getElementById('review-finding-status')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: vi_['bid.review.filter.clear'] }));
      await waitFor(() => expect(document.querySelectorAll('[data-review]')).toHaveLength(3));
    });

    it('reads the findings a page at a time', async () => {
      const state = three();
      state.pageSize = 2;
      open(state);
      await screen.findByTestId('findings');
      expect(document.querySelectorAll('[data-review]')).toHaveLength(2);
      fireEvent.click(screen.getByRole('button', { name: vi_['bid.review.loadMore.action'] }));
      await waitFor(() => expect(document.querySelectorAll('[data-review]')).toHaveLength(3));
      expect(screen.queryByRole('button', { name: vi_['bid.review.loadMore.action'] })).toBeNull();
    });

    it('carries the proposal and the package of the run, so that the way back needs nothing else', async () => {
      open(three(), { path: `/bid/bid-12?run=${runId(1)}&proposal=${proposalId(1)}&package=${packageId(1)}` });
      await screen.findByTestId('findings');
      expect(screen.getByTestId('link-compare').getAttribute('href')).toContain(`package=${packageId(1)}`);
    });
  });
});
