import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { compared } from '../compare/test-support';
import ReportScreen from './ReportScreen';
import { CV2, EVALUATOR, READER, client, comparison, mount, packageId, report, reportId, routeOf, runId, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('BID-13', 'FR-BID-13');
const OK = { operation_id: '00000000-0000-4000-8000-000000000999', status: 'DRAFT', resource_version: 1, resource_id: reportId(1) };
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);
const CONCLUSION = 'Nhà thầu 1 đáp ứng các tiêu chí bắt buộc; nhà thầu 2 thiếu giấy phép hoạt động.';
const DISSENT = 'Tôi không đồng ý với điểm kinh nghiệm của nhà thầu thứ hai.';

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
  const h = client(state, options.command ?? (() => OK));
  mount(<ReportScreen route={ROUTE} />, h, { permissions: options.permissions ?? EVALUATOR, path: options.path ?? `/bid/bid-13?package=${packageId(1)}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

/** A comparison in which every finding of the two proposals is decided: the report can be made. */
const ready = () => comparison({ proposals: [compared(1, { decided_count: 3, criteria_count: 3 }), compared(2, { decided_count: 3, criteria_count: 3 })], excluded: [] });
const card = (n: number): HTMLElement => document.querySelector(`[data-report="${reportId(n)}"]`) as HTMLElement;
const type = (element: HTMLElement, value: string): void => void fireEvent.change(element, { target: { value } });
const conclusionField = (): HTMLTextAreaElement => screen.getByLabelText(vi_['bid.report.create.conclusion.label']) as HTMLTextAreaElement;
const createButton = (pending = false): HTMLElement => screen.getByRole('button', { name: pending ? vi_['bid.report.create.pending'] : vi_['bid.report.create.submit'] });
const signButton = (n: number, pending = false): HTMLElement => within(card(n)).getByRole('button', { name: pending ? vi_['bid.report.sign.pending'] : vi_['bid.report.sign.submit'] });
const dissentField = (n: number): HTMLTextAreaElement => within(card(n)).getByLabelText(vi_['bid.report.sign.dissent.label']) as HTMLTextAreaElement;

describe('ReportScreen (BID-13): the evaluation report and its sign-off', () => {
  describe('UI-BID-13: the seven states', () => {
    it('shows the loading state while the reports are read, and the reports once they are', async () => {
      open(world({ reports: [report(1)] }));
      expect(screen.getAllByRole('status', { name: vi_['states.loading.label'] }).length).toBeGreaterThan(0);
      await screen.findByTestId('reports');
      expect(screen.getByRole('heading', { level: 1, name: vi_['bid.report.page.title'] })).toBeTruthy();
      expect(screen.getByText(text('bid.report.footer.reference', { id: 'BID-13', req: 'FR-BID-13' }))).toBeTruthy();
    });

    it('shows the empty state when there is no report, and still offers the draft to the evaluation team', async () => {
      open(world({ comparison: ready() }));
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
      expect(await screen.findByTestId('create-panel')).toBeTruthy();
    });

    it('shows the error state with a retry that reads again', async () => {
      const state = world({ reports: [report(1)], failing: new Map([['listEvaluationReports', new Error('boom')]]) });
      const h = open(state);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      state.failing.clear();
      fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      await screen.findByTestId('reports');
      expect(h.read.mock.calls.length).toBeGreaterThan(1);
    });

    it('shows the offline, signed-out and denied states for what the server says', async () => {
      open(world({ failing: new Map([['listEvaluationReports', problem(NETWORK_ERROR_CODE, 0)]]) }));
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      open(world({ failing: new Map([['listEvaluationReports', problem('SESSION_EXPIRED', 401)]]) }));
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
      cleanup();
      open(world({ failing: new Map([['listEvaluationReports', problem('SCOPE_DENIED', 403)]]) }));
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    });

    it('is denied without the right to evaluate, and reads nothing', () => {
      const h = open(world({ reports: [report(1)] }), { permissions: READER });
      expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy();
      expect(h.read).not.toHaveBeenCalled();
    });

    it('tells a member who owes the declaration to make it, with the way there, instead of an error', async () => {
      open(world({ failing: new Map([['listEvaluationReports', problem('CONFLICT_UNDECLARED', 403)]]) }));
      const notice = await screen.findByTestId('undeclared');
      expect(notice.textContent).toContain(vi_['bid.report.undeclared.notice']);
      expect(within(notice).getByTestId('link-declare').getAttribute('href')).toBe(`/bid/bid-05?package=${packageId(1)}`);
      expect(screen.queryByText(vi_['states.error.title'])).toBeNull();
    });

    it('asks for a package when none is named, and reads nothing', () => {
      const h = open(world(), { path: '/bid/bid-13' });
      expect(screen.getByTestId('choose-package')).toBeTruthy();
      expect(h.read).not.toHaveBeenCalled();
    });

    it('shows the retry of the comparison that makes the draft when it cannot be read', async () => {
      const state = world({ reports: [report(1)], failing: new Map([['compareProposals', new Error('boom')]]) });
      open(state);
      await screen.findByTestId('reports');
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      state.failing.clear();
      fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      await screen.findByTestId('create-panel');
    });
  });

  describe('the report as the team reads it', () => {
    it('shows what the experts decided criterion by criterion, the weighted score and the mandatory criteria not met, with no ranking and no winner', async () => {
      open(world({ reports: [report(1)] }));
      await screen.findByTestId('reports');
      const table = within(card(1)).getByTestId('summary');
      expect(within(table).getAllByTestId('proposal-head').map((head) => head.textContent)).toEqual([
        `Công ty nhà thầu 1${text('bid.report.table.weighted', { score: '32.00' })}`,
        `Công ty nhà thầu 2${text('bid.report.table.noScore')} · ${text('bid.report.table.mandatoryNotMet', { count: 1 })}`,
      ]);
      const rows = within(table).getAllByRole('row').slice(1);
      expect(rows.map((row) => within(row).getAllByTestId('cell').map((cell) => cell.getAttribute('data-risk')))).toEqual([['NONE', 'MANDATORY_NOT_MET'], ['NONE', 'UNDECIDED']]);
      expect(within(rows[1] as HTMLElement).getByTestId('decided-score').textContent).toContain('8.00');
      expect(within(rows[1] as HTMLElement).getByTestId('undecided').textContent).toBe(vi_['bid.report.table.undecided']);
      expect(within(card(1)).getByTestId('conclusion').textContent).toBe('Hồ sơ của nhà thầu 1 đáp ứng tiêu chí bắt buộc; nhà thầu 2 thiếu giấy phép.');
      expect(within(card(1)).getByTestId('award-note').textContent).toBe(vi_['bid.report.award.note']);
      expect(card(1).textContent).not.toMatch(/trúng thầu:|xếp hạng #|winner/i);
    });

    it('shows who signed and who is still awaited, each by name with why', async () => {
      open(world({ reports: [report(1, { awaiting: [{ membership_id: 'm2', display_name: 'Chuyên gia 2', standing: 'UNDECLARED' }, { membership_id: 'm3', display_name: 'Chuyên gia 3', standing: 'PENDING' }, { membership_id: 'm4', display_name: 'Chuyên gia 4', standing: 'ALLOWED' }] })] }));
      await screen.findByTestId('reports');
      expect(within(within(card(1)).getByTestId('signatures')).getByText(/Chuyên gia 1/)).toBeTruthy();
      const awaiting = within(card(1)).getByTestId('awaiting');
      expect(awaiting.textContent).toContain(`Chuyên gia 2 · ${vi_['bid.report.awaiting.undeclared']}`);
      expect(awaiting.textContent).toContain(`Chuyên gia 3 · ${vi_['bid.report.awaiting.pending']}`);
      expect(awaiting.textContent).toContain(`Chuyên gia 4 · ${vi_['bid.report.awaiting.unsigned']}`);
    });

    it('says nobody has signed when nobody has, and shows the dissent in the words of the member who signed with it', async () => {
      open(world({ reports: [report(1, { signed_off_by: [], awaiting: [] }), report(2, { signed_off_by: [{ membership_id: 'm2', display_name: 'Chuyên gia 2', signed_at: null, dissent: true }], dissenting_opinions: [{ membership_id: 'm2', display_name: 'Chuyên gia 2', text: DISSENT, recorded_at: '2026-12-06T08:00:00.000Z' }] })] }));
      await screen.findByTestId('reports');
      expect(within(card(1)).getByTestId('no-signatures').textContent).toBe(vi_['bid.report.signatures.none']);
      expect(within(card(1)).queryByTestId('awaiting')).toBeNull();
      expect(within(card(1)).queryByTestId('dissents')).toBeNull();
      expect(within(card(2)).getByTestId('with-dissent').textContent).toBe(vi_['bid.report.signatures.withDissent']);
      expect(within(within(card(2)).getByTestId('dissents')).getByText(DISSENT)).toBeTruthy();
    });

    it('shows the stage of the minutes for each status and the state of the document in DOC as DOC says it', async () => {
      open(
        world({
          reports: [
            report(1),
            report(2, { status: 'ISSUE_REQUESTED', document_status: 'DRAFT', actions: { sign_off: false } }),
            report(3, { status: 'SIGNED_OFF', actions: { sign_off: false } }),
            report(4, { status: 'ISSUED', report_document_id: '00000000-0000-4000-8000-0000000000e9', document_status: 'ISSUED', issued_at: '2026-12-07T03:00:00.000Z', actions: { sign_off: false } }),
            report(5, { status: 'SUPERSEDED', report_document_id: '00000000-0000-4000-8000-0000000000e8', actions: { sign_off: false } }),
          ],
        }),
      );
      await screen.findByTestId('reports');
      expect([1, 2, 3, 4, 5].map((n) => within(card(n)).getByTestId('stage').textContent?.split(' · ')[0])).toEqual([
        vi_['bid.report.stage.signing'],
        vi_['bid.report.stage.doc'],
        vi_['bid.report.stage.refused'],
        vi_['bid.report.stage.issued'],
        vi_['bid.report.stage.superseded'],
      ]);
      expect([1, 2, 3, 4, 5].map((n) => within(card(n)).getByTestId('status').textContent)).toEqual([
        vi_['bid.report.status.draft'],
        vi_['bid.report.status.issueRequested'],
        vi_['bid.report.status.signedOff'],
        vi_['bid.report.status.issued'],
        vi_['bid.report.status.superseded'],
      ]);
      expect(within(card(2)).getByTestId('doc-state').textContent).toContain(text('bid.report.doc.state', { state: 'DRAFT' }));
      expect(within(card(1)).queryByTestId('doc-state')).toBeNull();
      expect(within(card(4)).getByTestId('document-id').textContent).toBe('00000000-0000-4000-8000-0000000000e9');
      expect(within(card(1)).queryByTestId('document')).toBeNull();
    });

    it('lists the proposals the report does not cover, and warns that minutes DOC recalled are not to be relied on', async () => {
      const covered = { ...report(1).summary, not_covered: [{ proposal_id: 'p9', contractor: { id: 'c9', legal_name: 'Công ty 9' }, reason: 'NO_ANALYSIS_RUN' }, { proposal_id: 'p8', contractor: { id: 'c8', legal_name: 'Công ty 8' }, reason: 'NOT_SELECTED' }, { proposal_id: 'p7', contractor: { id: 'c7', legal_name: 'Công ty 7' }, reason: 'CRITERIA_VERSION_MISMATCH' }] };
      open(world({ reports: [report(1, { summary: covered, status: 'ISSUED', report_document_id: '00000000-0000-4000-8000-0000000000e9', recalled_at: '2026-12-08T03:00:00.000Z', actions: { sign_off: false } })] }));
      await screen.findByTestId('reports');
      const left = within(card(1)).getByTestId('not-covered');
      expect(left.textContent).toContain(`Công ty 9: ${vi_['bid.report.notCovered.noRun']}`);
      expect(left.textContent).toContain(`Công ty 8: ${vi_['bid.report.notCovered.notSelected']}`);
      expect(left.textContent).toContain(`Công ty 7: ${vi_['bid.report.notCovered.mismatch']}`);
      expect(within(card(1)).getByTestId('recalled')).toBeTruthy();
    });

    it('marks a draft that went stale and offers no signature for it', async () => {
      open(world({ reports: [report(1, { stale: true, actions: { sign_off: false } })] }));
      await screen.findByTestId('reports');
      expect(within(card(1)).getByTestId('stale').textContent).toBe(vi_['bid.report.stale.notice']);
      expect(within(card(1)).queryByTestId('sign-form')).toBeNull();
    });
  });

  describe('AC-ST-BID-012-1, UAT-AC453: making the draft', () => {
    it('AC-ST-BID-012-1, UAT-AC453: sends the runs of the proposals in the report and the conclusion trimmed, with an idempotency attempt, and reads the reports again', async () => {
      const h = open(world({ comparison: ready() }));
      await screen.findByTestId('create-form');
      type(conclusionField(), `  ${CONCLUSION}  `);
      fireEvent.click(createButton());
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('createEvaluationReport');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { package_id: packageId(1), criteria_version_id: CV2, run_ids: [runId(1), runId(2)], summary: { conclusion: CONCLUSION } }, attempt: expect.anything() });
      expect((await screen.findByTestId('created')).textContent).toBe(vi_['bid.report.create.created']);
      expect(conclusionField().value).toBe('');
      expect(h.read.mock.calls.filter((call) => call[0] === 'listEvaluationReports').length).toBeGreaterThan(1);
    });

    it('leaves a proposal out of the report when the person takes it out, and asks for at least one', async () => {
      const h = open(world({ comparison: ready() }));
      await screen.findByTestId('create-form');
      const boxes = within(screen.getByTestId('create-form')).getAllByRole('checkbox') as HTMLInputElement[];
      expect(boxes.map((box) => box.checked)).toEqual([true, true]);
      fireEvent.click(boxes[1] as HTMLElement);
      type(conclusionField(), CONCLUSION);
      fireEvent.click(createButton());
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect((h.command.mock.calls[0]?.[1] as { body: { run_ids: string[] } }).body.run_ids).toEqual([runId(1)]);
      cleanup();
      const none = open(world({ comparison: ready() }));
      await screen.findByTestId('create-form');
      for (const box of within(screen.getByTestId('create-form')).getAllByRole('checkbox')) fireEvent.click(box);
      type(conclusionField(), CONCLUSION);
      fireEvent.click(createButton());
      expect(screen.getByText(vi_['bid.report.problem.noRun'])).toBeTruthy();
      expect(none.command).not.toHaveBeenCalled();
      fireEvent.click(within(screen.getByTestId('create-form')).getAllByRole('checkbox')[0] as HTMLElement);
      expect(within(screen.getByTestId('create-form')).queryByText(vi_['bid.report.problem.noRun'])).toBeNull();
    });

    it('asks for a conclusion of the right length before it sends anything, and counts the characters', async () => {
      const h = open(world({ comparison: ready() }));
      await screen.findByTestId('create-form');
      fireEvent.click(createButton());
      expect(screen.getByText(vi_['bid.report.problem.required'])).toBeTruthy();
      type(conclusionField(), 'ngắn quá');
      expect(screen.getByText(vi_['bid.report.problem.tooShort'])).toBeTruthy();
      expect(screen.getByTestId('conclusion-count').textContent).toBe(text('bid.report.create.conclusion.count', { count: 8, min: 20, max: 8000 }));
      type(conclusionField(), 'x'.repeat(8001));
      expect(screen.getByText(vi_['bid.report.problem.tooLong'])).toBeTruthy();
      fireEvent.click(createButton());
      expect(h.command).not.toHaveBeenCalled();
      expect(conclusionField().getAttribute('aria-invalid')).toBe('true');
    });

    it('UAT-AC453: tells how many findings nobody decided when the server refuses the draft for them, keeps what was typed and points to the review', async () => {
      const state = world({ comparison: comparison({ proposals: [compared(1, { decided_count: 3, criteria_count: 3 }), compared(2, { decided_count: 2, criteria_count: 3 })], excluded: [] }) });
      open(state, { command: () => problem('UNREVIEWED_FINDINGS', 422, { unreviewed_count: 1, finding_ids: ['f'] }) });
      await screen.findByTestId('create-form');
      expect(screen.getByTestId('undecided-note').textContent).toContain(vi_['bid.report.create.undecided']);
      expect(screen.getByTestId(`review-link-${runId(2)}`).getAttribute('href')).toBe(`/bid/bid-12?run=${runId(2)}`);
      expect(screen.queryByTestId(`review-link-${runId(1)}`)).toBeNull();
      type(conclusionField(), CONCLUSION);
      fireEvent.click(createButton());
      expect((await screen.findByTestId('create-refusal')).textContent).toBe(text('bid.report.error.unreviewed', { count: 1 }));
      expect(conclusionField().value).toBe(CONCLUSION);
    });

    it('says in words why any other refusal was made', async () => {
      const refusals: Array<[Error, string]> = [
        [problem('CRITERIA_VERSION_MISMATCH'), 'bid.report.error.criteriaMismatch'],
        [problem('RUN_NOT_COMPLETED'), 'bid.report.error.runNotCompleted'],
        [problem('CONFLICT_UNDECLARED', 403), 'bid.report.error.undeclared'],
        [problem('RESOURCE_NOT_FOUND', 404), 'bid.report.error.notFound'],
        [problem('VALIDATION_FAILED'), 'bid.report.error.validation'],
        [new Error('boom'), 'bid.report.error.general'],
      ];
      for (const [refusal, key] of refusals) {
        cleanup();
        open(world({ comparison: ready() }), { command: () => refusal });
        await screen.findByTestId('create-form');
        type(conclusionField(), CONCLUSION);
        fireEvent.click(createButton());
        expect((await screen.findByTestId('create-refusal')).textContent).toBe((vi_ as Record<string, string>)[key]);
      }
    });

    it('says there is nothing to put in the report when no proposal has an analysis on the criteria', async () => {
      open(world({ comparison: comparison({ proposals: [], excluded: [] }) }));
      expect((await screen.findByTestId('no-candidates')).textContent).toBe(vi_['bid.report.create.noCandidates']);
    });

    it('keeps the same idempotency key when the answer is lost, and takes a new one for other words', async () => {
      let attempt = 0;
      const h = open(world({ comparison: ready() }), {
        command: () => {
          attempt += 1;
          return attempt === 1 ? problem(NETWORK_ERROR_CODE, 0) : OK;
        },
      });
      await screen.findByTestId('create-form');
      type(conclusionField(), CONCLUSION);
      fireEvent.click(createButton());
      await screen.findByTestId('create-refusal');
      fireEvent.click(createButton());
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      const keys = h.command.mock.calls.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
      expect(keys[0]).toBe(keys[1]);
    });

    it('sends one draft at a time: while it is on its way the field cannot change and a second click sends nothing', async () => {
      let release: (value: unknown) => void = () => undefined;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      const h = open(world({ comparison: ready() }), { command: () => pending.then(() => OK) as unknown as Error });
      await screen.findByTestId('create-form');
      type(conclusionField(), CONCLUSION);
      fireEvent.click(createButton());
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(createButton(true)).toBeTruthy());
      expect(conclusionField().readOnly).toBe(true);
      await act(async () => {
        fireEvent.submit(screen.getByTestId('create-form'));
      });
      expect(h.command).toHaveBeenCalledTimes(1);
      await act(async () => {
        release(undefined);
      });
      await screen.findByTestId('created');
    });

    it('is not offered to a session that is read-only', async () => {
      open(world({ reports: [report(1)], comparison: ready() }), { mode: 'READ_ONLY' });
      await screen.findByTestId('reports');
      expect(screen.queryByTestId('create-panel')).toBeNull();
      expect(within(card(1)).queryByTestId('sign-form')).toBeNull();
    });
  });

  describe('AC-ST-BID-012-1, UAT-AC453: the signature', () => {
    it('AC-ST-BID-012-1, UAT-AC453: signs with the version the person saw and no dissent, with an idempotency attempt, and reads the reports again', async () => {
      const h = open(world({ reports: [report(1)] }));
      await screen.findByTestId('reports');
      fireEvent.click(signButton(1));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('signOffEvaluationReport');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: reportId(1) }, body: {}, ifMatchVersion: 2, attempt: expect.anything() });
      await waitFor(() => expect(h.read.mock.calls.filter((call) => call[0] === 'listEvaluationReports').length).toBeGreaterThan(1));
    });

    it('signs with the dissent typed, trimmed, in the words of the member, and drops it once the signature is taken', async () => {
      const state = world({ reports: [report(1)] });
      const h = open(state, {
        command: () => {
          state.reports[0] = report(1, { signed_off_by: [], actions: { sign_off: false }, version: 3 });
          return OK;
        },
      });
      await screen.findByTestId('reports');
      type(dissentField(1), `  ${DISSENT}  `);
      fireEvent.click(signButton(1));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { dissent: DISSENT }, ifMatchVersion: 2 });
      await waitFor(() => expect(within(card(1)).queryByTestId('sign-form')).toBeNull());
    });

    it('checks the dissent before it sends anything: a short one is refused, an empty one is no dissent', async () => {
      const h = open(world({ reports: [report(1)] }));
      await screen.findByTestId('reports');
      type(dissentField(1), 'không');
      fireEvent.click(signButton(1));
      expect(within(card(1)).getByText(vi_['bid.report.problem.tooShort'])).toBeTruthy();
      type(dissentField(1), 'x'.repeat(4001));
      expect(within(card(1)).getByText(vi_['bid.report.problem.tooLong'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('says in words why a refusal was made and keeps what was typed', async () => {
      const refusals: Array<[Error, string]> = [
        [problem('ALREADY_SIGNED_OFF'), 'bid.report.error.alreadySigned'],
        [problem('REPORT_STATE_INVALID', 409), 'bid.report.error.notDraft'],
        [problem('REPORT_OUT_OF_DATE', 409), 'bid.report.error.outOfDate'],
        [problem('VERSION_CONFLICT', 409), 'bid.report.error.versionConflict'],
        [problem('DOC_TEMPLATE_MISSING'), 'bid.report.error.templateMissing'],
        [problem('PROVIDER_UNAVAILABLE', 503), 'bid.report.error.docUnavailable'],
        [problem('CONFLICT_UNDECLARED', 403), 'bid.report.error.undeclared'],
        [problem('SESSION_EXPIRED', 401), 'bid.report.error.session'],
        [problem('SCOPE_DENIED', 403), 'bid.report.error.denied'],
      ];
      for (const [refusal, key] of refusals) {
        cleanup();
        open(world({ reports: [report(1)] }), { command: () => refusal });
        await screen.findByTestId('reports');
        type(dissentField(1), DISSENT);
        fireEvent.click(signButton(1));
        expect((await within(card(1)).findByTestId('refusal')).textContent).toBe((vi_ as Record<string, string>)[key]);
        expect(dissentField(1).value).toBe(DISSENT);
      }
    });

    it('keeps the refusal in words when the report stops being signable because of it: it went stale, or another member completed it', async () => {
      for (const [refusal, key, becomes] of [
        [problem('REPORT_OUT_OF_DATE', 409), 'bid.report.error.outOfDate', { stale: true, actions: { sign_off: false } }],
        [problem('REPORT_STATE_INVALID', 409), 'bid.report.error.notDraft', { status: 'ISSUE_REQUESTED', version: 5, actions: { sign_off: false } }],
      ] as const) {
        cleanup();
        const state = world({ reports: [report(1)] });
        const h = open(state, {
          command: () => {
            Object.assign(state.reports[0] as Record<string, unknown>, becomes);
            return refusal;
          },
        });
        await screen.findByTestId('reports');
        fireEvent.click(signButton(1));
        await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(within(card(1)).queryByTestId('sign-form')).toBeNull());
        expect(within(card(1)).getByTestId('refusal').textContent).toBe((vi_ as Record<string, string>)[key]);
      }
    });

    it('keeps the idempotency key when the answer is lost, and takes a new one for another dissent', async () => {
      let attempt = 0;
      const h = open(world({ reports: [report(1)] }), {
        command: () => {
          attempt += 1;
          return attempt === 1 ? problem(NETWORK_ERROR_CODE, 0) : OK;
        },
      });
      await screen.findByTestId('reports');
      type(dissentField(1), DISSENT);
      fireEvent.click(signButton(1));
      await within(card(1)).findByTestId('refusal');
      fireEvent.click(signButton(1));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      const keys = h.command.mock.calls.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
      expect(keys[0]).toBe(keys[1]);
    });

    it('signs one report at a time: while one is on its way its field cannot change, the other reports are closed, and a second submit sends nothing', async () => {
      let release: (value: unknown) => void = () => undefined;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      const h = open(world({ reports: [report(1), report(2)] }), { command: () => pending.then(() => OK) as unknown as Error });
      await screen.findByTestId('reports');
      type(dissentField(1), DISSENT);
      fireEvent.click(signButton(1));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(signButton(1, true)).toBeTruthy());
      expect(dissentField(1).readOnly).toBe(true);
      expect((signButton(1, true) as HTMLButtonElement).disabled).toBe(true);
      expect(dissentField(2).disabled).toBe(true);
      expect((signButton(2) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => {
        fireEvent.submit(within(card(1)).getByTestId('sign-form'));
        fireEvent.submit(within(card(2)).getByTestId('sign-form'));
      });
      expect(h.command).toHaveBeenCalledTimes(1);
      await act(async () => {
        release(undefined);
      });
    });

    it('offers no signature for a report the caller signed, a read-only session, or a caller without the right', async () => {
      open(world({ reports: [report(1, { actions: { sign_off: false } })] }));
      await screen.findByTestId('reports');
      expect(within(card(1)).queryByTestId('sign-form')).toBeNull();
      cleanup();
      open(world({ reports: [report(1)] }), { mode: 'READ_ONLY' });
      await screen.findByTestId('reports');
      expect(within(card(1)).queryByTestId('sign-form')).toBeNull();
    });
  });

  it('links to the comparison of the package, where the proposals stand side by side', async () => {
    open(world({ reports: [report(1)] }));
    await screen.findByTestId('reports');
    expect(screen.getByTestId('link-compare').getAttribute('href')).toBe(`/bid/bid-10?package=${packageId(1)}`);
  });
});
