import { NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import ConfigScreen from './ConfigScreen';
import { EVALUATOR, NOBODY, PROFILE, RUN_READER, client, criteria, failedRun, mount, pack, packageId, problem, proposalId, routeOf, run, runId, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('BID-07', 'FR-BID-07');
const STARTED = { operation_id: 'o', status: 'AWAITING_REVIEW', resource_version: 2, resource_id: runId(9), reused: false, failure_code: null };
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const PATH = `/bid/bid-07?package=${packageId(1)}&proposal=${proposalId(1)}`;

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
  const h = client(state, options.command ?? (() => STARTED));
  mount(<ConfigScreen route={ROUTE} />, h, { permissions: options.permissions ?? EVALUATOR, path: options.path ?? PATH, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const typeProfile = (value = PROFILE): void => {
  fireEvent.change(screen.getByLabelText(vi_['bid.analysis.profile.label']), { target: { value } });
};
const start = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['bid.analysis.start.action'] }));
};
const ready = async (state: World, options: Options = {}) => {
  const h = open(state, options);
  await screen.findByTestId('run-form');
  return h;
};
/** The form with the criteria in force read: they come after the form does. */
const loaded = async (state: World, options: Options = {}) => {
  const h = await ready(state, options);
  await waitFor(() => expect((screen.getByLabelText(vi_['bid.analysis.criteria.label']) as HTMLSelectElement).options.length).toBeGreaterThan(1));
  return h;
};

describe('ConfigScreen (BID-07): the configuration of an AI analysis run', () => {
  describe('the standard states of the screen', () => {
    it('UI-BID-07: shows the loading state, then asks for a package and offers the packages that are or were open for bids', async () => {
      open(world(), { path: '/bid/bid-07' });
      expect(screen.getByRole('status', { busy: true })).toBeTruthy();
      expect((await screen.findByTestId('choose-package')).textContent).toBe(vi_['bid.analysis.package.hint']);
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['bid.analysis.config.title']);
      expect(Array.from((document.getElementById('analysis-package') as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
        vi_['bid.analysis.package.choose'],
        'GT-1 · Gói thầu xây lắp 1',
        'GT-2 · Gói thầu xây lắp 2',
      ]);
      expect(screen.getByText(text('bid.analysis.footer.reference', { id: 'BID-07', req: 'FR-BID-07' }))).toBeTruthy();
    });

    it('UI-BID-07: shows the empty state when no package is open for bids', async () => {
      open(world({ packages: [pack(3, { status: 'DRAFT' })] }), { path: '/bid/bid-07' });
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    });

    it('UI-BID-07: shows the error state with a retry that reads again, the offline state and the signed-out state', async () => {
      const state = world();
      state.failing.set('get_resources_procurement_package', new Error('down'));
      const h = open(state, { path: '/bid/bid-07' });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      state.failing.clear();
      fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(await screen.findByTestId('choose-package')).toBeTruthy();
      expect((h.client.readAll as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
      cleanup();
      const offline = world();
      offline.failing.set('get_resources_procurement_package', problem(NETWORK_ERROR_CODE, 0));
      open(offline, { path: '/bid/bid-07' });
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      const lapsed = world();
      lapsed.failing.set('get_resources_procurement_package', problem('SESSION_EXPIRED', 401));
      open(lapsed, { path: '/bid/bid-07' });
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
    });

    it('UI-BID-07: shows the denied state to a caller without the right to ask for a run, and reads nothing for them', async () => {
      const h = open(world(), { permissions: NOBODY });
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      expect(h.read).not.toHaveBeenCalled();
      expect(h.client.readAll as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      expect(h.command).not.toHaveBeenCalled();
      expect(screen.queryByTestId('run-form')).toBeNull();
    });

    it('UI-BID-07: says when the proposals cannot be read or there is none in full, and offers only the proposals the caller has in full', async () => {
      open(world(), { path: `/bid/bid-07?package=${packageId(1)}` });
      const select = (await screen.findByLabelText(vi_['bid.analysis.proposal.label'])) as HTMLSelectElement;
      expect(Array.from(select.options).map((option) => option.textContent)).toEqual([vi_['bid.analysis.proposal.choose'], text('bid.analysis.proposal.option', { name: 'Công ty nhà thầu 1', revision: 1 })]);
      expect(screen.queryByTestId('run-form')).toBeNull();
      fireEvent.change(select, { target: { value: proposalId(1) } });
      expect(await screen.findByTestId('run-form')).toBeTruthy();
      fireEvent.change(document.getElementById('analysis-package') as HTMLElement, { target: { value: packageId(2) } });
      expect((await screen.findByTestId('no-proposals')).textContent).toBe(vi_['bid.analysis.proposals.none']);
      cleanup();
      const failing = world();
      failing.failing.set('get_resources_proposal', new Error('down'));
      open(failing, { path: `/bid/bid-07?package=${packageId(1)}` });
      expect((await screen.findByTestId('proposals-error')).textContent).toContain(vi_['bid.analysis.proposals.error']);
      failing.failing.clear();
      fireEvent.click(screen.getByRole('button', { name: vi_['bid.analysis.retry.action'] }));
      expect(await screen.findByLabelText(vi_['bid.analysis.proposal.label'])).toBeTruthy();
    });

    it('ignores a package or a proposal of the address that is not on offer', async () => {
      open(world(), { path: `/bid/bid-07?package=${packageId(3)}&proposal=${proposalId(1)}` });
      expect(await screen.findByTestId('choose-package')).toBeTruthy();
      cleanup();
      open(world(), { path: `/bid/bid-07?package=${packageId(1)}&proposal=${proposalId(2)}` });
      expect(await screen.findByLabelText(vi_['bid.analysis.proposal.label'])).toBeTruthy();
      expect(screen.queryByTestId('run-form')).toBeNull();
    });
  });

  describe('the form', () => {
    it('offers the criteria in force only, takes the only one for the choice, and shows the class of the data and the routes as the server sets them', async () => {
      await loaded(world());
      const select = screen.getByLabelText(vi_['bid.analysis.criteria.label']) as HTMLSelectElement;
      expect(Array.from(select.options).map((option) => option.textContent)).toEqual([vi_['bid.analysis.criteria.choose'], text('bid.analysis.criteria.option', { revision: 1, count: 1 })]);
      expect(select.value).toBe(select.options[1]?.value);
      const routing = screen.getByTestId('routing');
      expect(routing.textContent).toContain(vi_['bid.analysis.classification.value']);
      expect(routing.textContent).toContain(vi_['bid.analysis.routes.value']);
      // The class and the route are not fields: nothing here is typed for them.
      expect(within(screen.getByTestId('run-form')).queryByLabelText(vi_['bid.analysis.classification.label'])).toBeNull();
      expect(within(screen.getByTestId('run-form')).queryByLabelText(vi_['bid.analysis.routes.label'])).toBeNull();
    });

    it('asks for the criteria to be chosen when several are in force, and says when there are none or when the caller may not read them', async () => {
      const several = world({ criteria: [criteria(1, 1), criteria(4, 1)] });
      await loaded(several);
      expect((screen.getByLabelText(vi_['bid.analysis.criteria.label']) as HTMLSelectElement).value).toBe('');
      cleanup();
      await ready(world({ criteria: [criteria(2, 1, { status: 'DRAFT' })] }));
      expect(screen.getByTestId('no-criteria').textContent).toBe(vi_['bid.analysis.criteria.none']);
      cleanup();
      const h = await ready(world(), { permissions: EVALUATOR.filter((permission) => permission !== 'criteria_version.read') });
      expect(screen.getByTestId('criteria-hidden').textContent).toBe(vi_['bid.analysis.criteria.hidden']);
      expect(h.client.readAll as ReturnType<typeof vi.fn>).not.toHaveBeenCalledWith('get_resources_criteria_version', expect.anything());
    });

    it('holds the run back while a page of the OCR waits, and says how many; the gate is read only for a caller who may read the OCR', async () => {
      await ready(world({ blockedPages: 2 }));
      expect((await screen.findByTestId('gate-blocked')).textContent).toBe(text('bid.analysis.gate.blocked', { count: 2, threshold: '85%' }));
      expect((screen.getByRole('button', { name: vi_['bid.analysis.start.action'] }) as HTMLButtonElement).disabled).toBe(true);
      cleanup();
      await ready(world());
      expect((await screen.findByTestId('gate-ready')).textContent).toBe(vi_['bid.analysis.gate.ready']);
      cleanup();
      const h = await ready(world(), { permissions: EVALUATOR.filter((permission) => permission !== 'bid.ocr.read') });
      expect(screen.getByTestId('gate-unknown').textContent).toBe(vi_['bid.analysis.gate.unknown']);
      expect(h.read.mock.calls.map((call) => call[0])).not.toContain('listProposalOcrPages');
    });

    it('does not offer the request in a read-only session or without the right, and sends nothing', async () => {
      const h = await ready(world(), { mode: 'READ_ONLY' });
      expect((screen.getByRole('button', { name: vi_['bid.analysis.start.action'] }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByLabelText(vi_['bid.analysis.profile.label']) as HTMLInputElement).readOnly).toBe(true);
      expect(h.command).not.toHaveBeenCalled();
    });

    it('judges the form before it sends anything: a profile that is not an id and a cost that is not a whole number are refused where they are', async () => {
      const h = await loaded(world({ criteria: [criteria(1, 1), criteria(4, 1)] }));
      start();
      expect((await screen.findByRole('alert')).textContent).toBe(vi_['bid.analysis.formProblem.criteria']);
      const select = screen.getByLabelText(vi_['bid.analysis.criteria.label']) as HTMLSelectElement;
      fireEvent.change(select, { target: { value: select.options[1]?.value } });
      typeProfile('not-an-id');
      start();
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(vi_['bid.analysis.formProblem.profile']));
      typeProfile();
      fireEvent.change(screen.getByLabelText(vi_['bid.analysis.cost.label']), { target: { value: '12x' } });
      start();
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(vi_['bid.analysis.formProblem.cost']));
      fireEvent.change(screen.getByLabelText(vi_['bid.analysis.cost.label']), { target: { value: '' } });
      fireEvent.change(screen.getByLabelText(vi_['bid.analysis.criteria.label']), { target: { value: '' } });
      start();
      expect((await screen.findByRole('alert')).textContent).toBe(vi_['bid.analysis.formProblem.criteria']);
      expect(h.command).not.toHaveBeenCalled();
    });
  });

  describe('asking for a run', () => {
    it('sends the proposal, the criteria, the profile and the cost limit with one idempotency attempt, and links to the progress of the run', async () => {
      const state = world();
      const h = await loaded(state);
      typeProfile();
      fireEvent.change(screen.getByLabelText(vi_['bid.analysis.cost.label']), { target: { value: ' 5000000 ' } });
      start();
      const answer = await screen.findByTestId('started');
      expect(h.command).toHaveBeenCalledTimes(1);
      expect(h.command).toHaveBeenCalledWith(
        'post_analysis_runs',
        expect.objectContaining({ body: { proposal_id: proposalId(1), criteria_version_id: expect.any(String), profile_version_id: PROFILE, max_cost_vnd: '5000000' }, attempt: expect.anything() }),
      );
      expect(within(answer).getByText(vi_['bid.analysis.started.made'])).toBeTruthy();
      expect(within(answer).queryByTestId('started-failure')).toBeNull();
      expect(within(answer).getByRole('link', { name: vi_['bid.analysis.started.open'] }).getAttribute('href')).toBe(`/bid/bid-08?run=${runId(9)}`);
    });

    it('UAT-AC15: tells a repeat of the input that was run before that this is that run', async () => {
      await loaded(world(), { command: () => ({ ...STARTED, resource_id: runId(1), reused: true }) });
      typeProfile();
      start();
      const answer = await screen.findByTestId('started');
      expect(within(answer).getByText(vi_['bid.analysis.started.reused'])).toBeTruthy();
      expect(within(answer).getByRole('link').getAttribute('href')).toBe(`/bid/bid-08?run=${runId(1)}`);
    });

    it('AC-ST-BID-009-1, UAT-AC19: tells that a run ended without an answer because the domestic and the self-hosted model both failed, with no international call', async () => {
      await loaded(world(), { command: () => ({ ...STARTED, status: 'FAILED', failure_code: 'AI_ROUTE_EXHAUSTED' }) });
      typeProfile();
      start();
      expect((await screen.findByTestId('started-failure')).textContent).toBe(vi_['bid.analysis.failure.routeExhausted']);
    });

    it('asks again as a new request once a refusal the server kept as a run is behind: the budget was spent, or the switch of the task was engaged', async () => {
      for (const [code, status] of [['BUDGET_EXCEEDED', 429], ['AI_KILL_SWITCH_ENGAGED', 503]] as const) {
        let calls = 0;
        const h = await loaded(world(), {
          command: () => {
            calls += 1;
            return calls === 1 ? problem(code, status) : STARTED;
          },
        });
        typeProfile();
        start();
        await screen.findByTestId('refusal');
        start();
        await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
        const keys = h.command.mock.calls.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
        expect(keys[0]).not.toBe(keys[1]);
        cleanup();
      }
    });

    it('words the refusal of the server, and a retry after a lost answer is the same request (same idempotency key)', async () => {
      let calls = 0;
      const h = await loaded(world(), {
        command: () => {
          calls += 1;
          return calls === 1 ? problem('INTERNAL_ERROR', 500) : STARTED;
        },
      });
      typeProfile();
      start();
      expect((await screen.findByTestId('refusal')).textContent).toBe(vi_['bid.analysis.error.general']);
      expect((screen.getByLabelText(vi_['bid.analysis.profile.label']) as HTMLInputElement).value).toBe(PROFILE);
      start();
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      const keys = h.command.mock.calls.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
      expect(keys[0]).toBe(keys[1]);
      expect(await screen.findByTestId('started')).toBeTruthy();
      expect(screen.queryByTestId('refusal')).toBeNull();
    });

    it('words each refusal the server may give for a run', async () => {
      const cases: Array<[string, number, string]> = [
        ['CONFLICT_UNDECLARED', 403, 'undeclared'],
        ['OCR_REVIEW_PENDING', 409, 'ocrPending'],
        ['OCR_NOT_RECORDED', 409, 'ocrNotRecorded'],
        ['CRITERIA_STATE_INVALID', 409, 'criteriaState'],
        ['PROFILE_NOT_PUBLISHED', 422, 'profile'],
        ['TOOL_NOT_READ_ONLY', 422, 'tools'],
        ['AI_ROUTE_NOT_ALLOWED', 422, 'routeNotAllowed'],
        ['BUDGET_EXCEEDED', 429, 'budget'],
        ['AI_KILL_SWITCH_ENGAGED', 503, 'killSwitch'],
        ['VALIDATION_FAILED', 422, 'validation'],
        ['RESOURCE_NOT_FOUND', 404, 'notFound'],
        ['SESSION_EXPIRED', 401, 'session'],
      ];
      for (const [code, status, kind] of cases) {
        await loaded(world(), { command: () => problem(code, status) });
        typeProfile();
        start();
        expect((await screen.findByTestId('refusal')).textContent).toBe(vi_[`bid.analysis.error.${kind}` as keyof typeof vi_]);
        cleanup();
      }
    });
  });

  describe('the runs of the proposal', () => {
    it('lists the runs newest first with their status, their data, their findings and their cost, and links to their progress and their evidence', async () => {
      const state = world({ runs: [run(1), failedRun(2), run(3, { proposal_id: proposalId(2) })] });
      await ready(state);
      const list = await screen.findByTestId('runs');
      const rows = within(list).getAllByRole('row').slice(1);
      expect(rows).toHaveLength(2);
      const first = rows[0] as HTMLElement;
      expect(within(first).getByTestId('run-status').textContent).toBe(vi_['bid.analysis.status.awaitingReview']);
      expect(first.textContent).toContain(text('bid.analysis.runs.data', { classification: vi_['bid.analysis.class.confidential'], route: vi_['bid.analysis.route.domesticHosted'] }));
      expect(first.textContent).toContain(text('bid.analysis.runs.findings', { count: 5, missing: 1 }));
      expect(first.textContent).toContain('1.234.567');
      expect(within(first).getByRole('link', { name: vi_['bid.analysis.runs.progress'] }).getAttribute('href')).toBe(`/bid/bid-08?run=${runId(1)}`);
      expect(within(first).getByRole('link', { name: vi_['bid.analysis.runs.evidence'] }).getAttribute('href')).toBe(`/bid/bid-09?run=${runId(1)}`);
      const second = rows[1] as HTMLElement;
      expect(within(second).getByTestId('run-status').textContent).toBe(vi_['bid.analysis.status.failed']);
      expect(within(second).queryByRole('link', { name: vi_['bid.analysis.runs.evidence'] })).toBeNull();
    });

    it('keeps the filter where it is when it matches no run, and filters by status', async () => {
      await ready(world({ runs: [run(1), failedRun(2)] }));
      await screen.findByTestId('runs');
      fireEvent.change(document.getElementById('analysis-status') as HTMLElement, { target: { value: 'CANCELLED' } });
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
      expect(document.getElementById('analysis-status')).toBeTruthy();
      fireEvent.change(document.getElementById('analysis-status') as HTMLElement, { target: { value: 'FAILED' } });
      expect(within(await screen.findByTestId('runs')).getAllByRole('row')).toHaveLength(2);
      fireEvent.click(screen.getByRole('button', { name: vi_['bid.analysis.runs.filter.clear'] }));
      await waitFor(() => expect(within(screen.getByTestId('runs')).getAllByRole('row')).toHaveLength(3));
    });

    it('shows the error state of the runs with a retry, and pages them', async () => {
      const state = world({ runs: [run(1), run(2), run(3)], pageSize: 2 });
      state.failing.set('get_resources_analysis_run', new Error('down'));
      await ready(state);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      expect(document.getElementById('analysis-status')).toBeTruthy();
      state.failing.clear();
      fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      expect(within(await screen.findByTestId('runs')).getAllByRole('row')).toHaveLength(3);
      fireEvent.click(screen.getByRole('button', { name: vi_['bid.analysis.loadMore.action'] }));
      await waitFor(() => expect(within(screen.getByTestId('runs')).getAllByRole('row')).toHaveLength(4));
    });

    it('reads no run for a caller who may not read them, and says so', async () => {
      const h = await ready(world({ runs: [run(1)] }), { permissions: EVALUATOR.filter((permission) => permission !== 'analysis_run.read') });
      expect(screen.getByTestId('runs-hidden').textContent).toBe(vi_['bid.analysis.runs.hidden']);
      expect(h.read.mock.calls.map((call) => call[0])).not.toContain('get_resources_analysis_run');
      expect(screen.queryByTestId('runs')).toBeNull();
    });

    it('only reads the runs for a caller who holds the right to ask for one as well', async () => {
      const h = open(world({ runs: [run(1)] }), { permissions: RUN_READER });
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      expect(h.read).not.toHaveBeenCalled();
    });
  });
});

