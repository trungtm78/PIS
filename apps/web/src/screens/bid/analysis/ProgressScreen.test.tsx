import { NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import ProgressScreen from './ProgressScreen';
import { EVALUATOR, NOBODY, POLICY, RUN_READER, TIMELINE_FAILED, client, failedRun, mount, packageId, problem, proposalId, routeOf, run, runId, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('BID-08', 'FR-BID-08');
const CANCELLED = { operation_id: 'o', status: 'CANCELLED', resource_version: 3, resource_id: runId(1) };
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const moment = (iso: string): string => new Intl.DateTimeFormat('vi', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Options {
  permissions?: readonly string[];
  mode?: 'FULL' | 'READ_ONLY';
  path?: string;
  command?: (operation: string, input: unknown) => unknown;
}

function open(state: World, options: Options = {}) {
  const h = client(state, options.command ?? (() => CANCELLED));
  mount(<ProgressScreen route={ROUTE} />, h, { permissions: options.permissions ?? EVALUATOR, path: options.path ?? `/bid/bid-08?run=${runId(1)}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}
const states = (): string[] => within(screen.getByTestId('timeline')).getAllByRole('listitem').map((item) => item.getAttribute('data-state') as string);
const typeReason = (value: string): void => {
  fireEvent.change(screen.getByLabelText(vi_['bid.analysis.cancel.label']), { target: { value } });
};
const cancel = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['bid.analysis.cancel.action'] }));
};

describe('ProgressScreen (BID-08): how an analysis run went', () => {
  describe('the standard states of the screen', () => {
    it('UI-BID-08: shows the loading state, then the run with its steps', async () => {
      open(world({ runs: [run(1)] }));
      expect(screen.getByRole('status', { busy: true })).toBeTruthy();
      expect(await screen.findByTestId('timeline')).toBeTruthy();
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['bid.analysis.progress.title']);
      expect(screen.getByText(text('bid.analysis.footer.reference', { id: 'BID-08', req: 'FR-BID-08' }))).toBeTruthy();
    });

    it('UI-BID-08: says that no run is chosen, without reading one', async () => {
      const h = open(world({ runs: [run(1)] }), { path: '/bid/bid-08' });
      expect((await screen.findByTestId('no-run')).textContent).toBe(vi_['bid.analysis.run.none']);
      expect(h.read).not.toHaveBeenCalled();
    });

    it('UI-BID-08: shows the error state with a retry, the offline state, the signed-out state and the denied state of a refusal for scope', async () => {
      const state = world({ runs: [run(1)] });
      state.failing.set('get_resources_analysis_run_id', new Error('down'));
      open(state);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      state.failing.clear();
      fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByTestId('timeline')).toBeTruthy();
      for (const [failure, title] of [
        [problem(NETWORK_ERROR_CODE, 0), 'states.offline.title'],
        [problem('SESSION_EXPIRED', 401), 'states.signedOut.title'],
        [problem('SCOPE_DENIED', 403), 'states.denied.title'],
      ] as const) {
        cleanup();
        const failing = world({ runs: [run(1)] });
        failing.failing.set('get_resources_analysis_run_id', failure);
        open(failing);
        expect(await screen.findByText(vi_[title])).toBeTruthy();
      }
    });

    it('UI-BID-08: shows the denied state to a caller without the right to read runs, and reads nothing for them', async () => {
      const h = open(world({ runs: [run(1)] }), { permissions: NOBODY });
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      expect(h.read).not.toHaveBeenCalled();
    });

    it('UI-BID-08: says there is no such run for a run that does not exist for the caller, and names the declaration they owe', async () => {
      open(world(), { path: `/bid/bid-08?run=${runId(7)}` });
      expect((await screen.findByTestId('run-not-found')).textContent).toBe(vi_['bid.analysis.run.notFound']);
      cleanup();
      const owes = world({ runs: [run(1)] });
      owes.failing.set('get_resources_analysis_run_id', problem('CONFLICT_UNDECLARED', 403));
      open(owes);
      expect((await screen.findByTestId('run-undeclared')).textContent).toBe(vi_['bid.analysis.run.undeclared']);
      expect(screen.queryByText(vi_['states.denied.title'])).toBeNull();
    });
  });

  describe('the run', () => {
    it('shows the steps of a run that waits for the experts, its data, its route under the policy, its cost and what it found, with the way to the evidence', async () => {
      open(world({ runs: [run(1, { supersedes_run_id: runId(5) })] }));
      await screen.findByTestId('timeline');
      expect(states()).toEqual(['DONE', 'DONE', 'DONE', 'PENDING']);
      expect(within(screen.getByTestId('timeline')).getAllByRole('listitem')[0]?.textContent).toContain(vi_['bid.analysis.step.extract']);
      expect(screen.getByTestId('run-status').textContent).toBe(vi_['bid.analysis.status.awaitingReview']);
      const facts = screen.getByTestId('facts').textContent as string;
      expect(facts).toContain(vi_['bid.analysis.class.confidential']);
      expect(facts).toContain(vi_['bid.analysis.route.domesticHosted']);
      expect(screen.getByTestId('policy').textContent).toBe(POLICY);
      expect(screen.getByTestId('cost').textContent).toBe(text('bid.analysis.facts.vnd', { amount: '1.234.567' }));
      expect(screen.getByTestId('counts').textContent).toBe(text('bid.analysis.facts.counts', { count: 5, missing: 1, reviewed: 0 }));
      expect(facts).toContain(moment('2026-12-05T03:00:00.000Z'));
      expect(screen.getByTestId('to-workbench').getAttribute('href')).toBe(`/bid/bid-09?run=${runId(1)}`);
      expect(screen.getByTestId('supersedes').getAttribute('href')).toBe(`/bid/bid-08?run=${runId(5)}`);
      expect(screen.getByRole('link', { name: vi_['bid.analysis.link.config'] }).getAttribute('href')).toBe(`/bid/bid-07?package=${packageId(1)}&proposal=${proposalId(1)}`);
      expect(screen.queryByTestId('failure')).toBeNull();
    });

    it('AC-ST-BID-009-1, UAT-AC19: shows the step that failed, the end without an answer, the self-hosted route last tried under the policy and no international attempt', async () => {
      open(world({ runs: [failedRun(1)] }));
      await screen.findByTestId('timeline');
      expect(states()).toEqual(['DONE', 'FAILED', 'SKIPPED', 'SKIPPED']);
      expect(screen.getByTestId('run-status').textContent).toBe(vi_['bid.analysis.status.failed']);
      expect(screen.getByTestId('failure').textContent).toBe(vi_['bid.analysis.failure.routeExhausted']);
      expect(screen.getByTestId('facts').textContent).toContain(vi_['bid.analysis.route.selfHosted']);
      expect(screen.getByTestId('facts').textContent).not.toContain(vi_['bid.analysis.route.international']);
      expect(screen.getByTestId('policy').textContent).toBe(POLICY);
      expect(screen.queryByTestId('to-workbench')).toBeNull();
      expect(screen.queryByTestId('cancel-form')).toBeNull();
    });

    it('words every failure a run can end with, and a run refused before any route, under the baseline policy and with no cost', async () => {
      const codes: Array<[string, string]> = [
        ['REJECTED_NO_CITATION', 'noCitation'],
        ['OUTPUT_INVALID', 'outputInvalid'],
        ['AI_ROUTE_NOT_ALLOWED', 'routeNotAllowed'],
        ['COST_ABOVE_LIMIT', 'costAboveLimit'],
        ['BUDGET_EXCEEDED', 'budget'],
        ['AI_KILL_SWITCH_ENGAGED', 'killSwitch'],
        ['INVALID_JSON', 'invalidJson'],
        ['SOMETHING_NEW', 'other'],
      ];
      for (const [code, kind] of codes) {
        open(world({ runs: [failedRun(1, { failure_code: code, status: 'REJECTED_BY_POLICY', route_class: null, policy_version_id: null, cost_vnd: null, finished_at: null, timeline: TIMELINE_FAILED })] }));
        expect((await screen.findByTestId('failure')).textContent).toBe(vi_[`bid.analysis.failure.${kind}` as keyof typeof vi_]);
        expect(screen.getByTestId('policy').textContent).toBe(vi_['bid.analysis.facts.baseline']);
        expect(screen.getByTestId('cost').textContent).toBe(vi_['bid.analysis.facts.noCost']);
        expect(screen.getByTestId('facts').textContent).toContain(vi_['bid.analysis.route.none']);
        expect(screen.getByTestId('facts').textContent).toContain(vi_['bid.analysis.facts.notFinished']);
        cleanup();
      }
    });

    it('shows the reason of a run that was cancelled, and offers no more cancellation', async () => {
      open(world({ runs: [run(1, { status: 'CANCELLED', cancel_reason: 'Chọn nhầm bộ tiêu chí', timeline: [{ step: 'EXTRACT', state: 'DONE' }, { step: 'MATCH', state: 'DONE' }, { step: 'VERIFY', state: 'DONE' }, { step: 'COMPLETE', state: 'SKIPPED' }] })] }));
      expect((await screen.findByTestId('cancel-reason')).textContent).toContain('Chọn nhầm bộ tiêu chí');
      expect(states()).toEqual(['DONE', 'DONE', 'DONE', 'SKIPPED']);
      expect(screen.queryByTestId('cancel-form')).toBeNull();
    });
  });

  describe('cancelling a run', () => {
    it('cancels a run that waits for the experts with the version the person saw and the reason, once, and shows the run as cancelled', async () => {
      const state = world({ runs: [run(1)] });
      const h = open(state, {
        command: () => {
          Object.assign(state.runs[0] as Record<string, unknown>, { status: 'CANCELLED', cancel_reason: 'Chọn nhầm bộ tiêu chí', version: 3 });
          return CANCELLED;
        },
      });
      await screen.findByTestId('cancel-form');
      typeReason('  Chọn nhầm bộ tiêu chí  ');
      cancel();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('post_analysis_runs_id_cancel', expect.objectContaining({ path: { id: runId(1) }, body: { reason: 'Chọn nhầm bộ tiêu chí' }, ifMatchVersion: 2, attempt: expect.anything() }));
      expect(await screen.findByTestId('cancel-reason')).toBeTruthy();
      expect(screen.getByTestId('run-status').textContent).toBe(vi_['bid.analysis.status.cancelled']);
      expect(screen.queryByTestId('cancel-form')).toBeNull();
    });

    it('asks for a reason before it sends anything', async () => {
      const h = open(world({ runs: [run(1)] }));
      await screen.findByTestId('cancel-form');
      typeReason('ab');
      cancel();
      expect((await screen.findByRole('alert')).textContent).toBe(vi_['bid.analysis.reasonProblem.tooShort']);
      typeReason('x'.repeat(1001));
      cancel();
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(vi_['bid.analysis.reasonProblem.tooLong']));
      expect(h.command).not.toHaveBeenCalled();
    });

    it('keeps the reason when the server refuses, says why, and a retry after a lost answer is the same request (same idempotency key)', async () => {
      let calls = 0;
      const h = open(world({ runs: [run(1)] }), {
        command: () => {
          calls += 1;
          return calls === 1 ? problem('INTERNAL_ERROR', 500) : CANCELLED;
        },
      });
      await screen.findByTestId('cancel-form');
      typeReason('Chọn nhầm bộ tiêu chí');
      cancel();
      expect((await screen.findByTestId('cancel-refusal')).textContent).toBe(vi_['bid.analysis.error.general']);
      expect((screen.getByLabelText(vi_['bid.analysis.cancel.label']) as HTMLTextAreaElement).value).toBe('Chọn nhầm bộ tiêu chí');
      cancel();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      const keys = h.command.mock.calls.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
      expect(keys[0]).toBe(keys[1]);
    });

    it('words the refusal of a cancellation of a run that is over or that changed since', async () => {
      for (const [code, status, kind] of [
        ['ANALYSIS_STATE_INVALID', 409, 'state'],
        ['VERSION_CONFLICT', 409, 'conflict'],
        ['RESOURCE_NOT_FOUND', 404, 'notFound'],
        ['CONFLICT_UNDECLARED', 403, 'undeclared'],
      ] as const) {
        open(world({ runs: [run(1)] }), { command: () => problem(code, status) });
        await screen.findByTestId('cancel-form');
        typeReason('Chọn nhầm bộ tiêu chí');
        cancel();
        expect((await screen.findByTestId('cancel-refusal')).textContent).toBe(vi_[`bid.analysis.error.${kind}` as keyof typeof vi_]);
        cleanup();
      }
    });

    it('offers no cancellation to a caller without the right, in a read-only session, once a finding was reviewed, or for a run that is over', async () => {
      const h = open(world({ runs: [run(1)] }), { permissions: RUN_READER });
      await screen.findByTestId('timeline');
      expect(screen.queryByTestId('cancel-form')).toBeNull();
      cleanup();
      open(world({ runs: [run(1)] }), { mode: 'READ_ONLY' });
      await screen.findByTestId('timeline');
      expect(screen.queryByTestId('cancel-form')).toBeNull();
      cleanup();
      open(world({ runs: [run(1, { reviewed_count: 2 })] }));
      await screen.findByTestId('timeline');
      expect(screen.queryByTestId('cancel-form')).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });
  });
});
