import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { MANAGER, READER, RECORDER, client, conclusionRecord, detailRecord, engagementRecord, findingRecord, mount, recommendationRecord, routeOf, world } from '../test-support';
import ConclusionScreen from './ConclusionScreen';

const ROUTE = routeOf('AUD-04', 'FR-AUD-04');
const ID = detailRecord(1).id as string;
const CONCLUSION = conclusionRecord().id as string;
const DOCUMENT = (conclusionRecord().document as { id: string }).id;
const PATH = `/aud/aud-04?engagement=${ID}`;

afterEach(cleanup);

interface Setup {
  engagement?: Record<string, unknown>;
  conclusion?: Record<string, unknown> | null;
  recommendations?: Array<Record<string, unknown>>;
  findings?: Array<Record<string, unknown>>;
}

const stateOf = ({ engagement = {}, conclusion = conclusionRecord(), recommendations, findings }: Setup) =>
  world({
    engagements: [engagementRecord(1, { status: 'FOLLOW_UP', ...engagement })],
    details: { [ID]: detailRecord(1, { status: 'FOLLOW_UP', ...engagement }) },
    conclusions: { [ID]: conclusion === null ? [] : [conclusion] },
    recommendations: { [CONCLUSION]: recommendations ?? [recommendationRecord(1, { amount_vnd: '800000000' }), recommendationRecord(2, { rec_type: 'FINANCIAL_ADJUSTMENT', amount_vnd: '400000000' })] },
    findings: { [CONCLUSION]: findings ?? [findingRecord(1), findingRecord(2)] },
  });

const open = (setup: Setup = {}, permissions: readonly string[] | undefined = RECORDER, command: (operation: string, input: unknown) => unknown = () => ({ status: 'OK' }), mode?: 'FULL' | 'READ_ONLY') => {
  const h = client(stateOf(setup), command);
  mount(<ConclusionScreen route={ROUTE} />, h, { permissions, path: PATH, ...(mode === undefined ? {} : { mode }) });
  return h;
};

const text = (id: string): string => screen.getByTestId(id).textContent ?? '';

describe('AUD-04 conclusion of an engagement', () => {
  describe('the conclusion that was recorded', () => {
    it('shows what was received, the money of it with the shortfall of 50.000.000 as a warning, and the recommendations with their amounts', async () => {
      open();
      expect(await screen.findByRole('heading', { level: 1, name: vi_['aud.conclusion.page.title'] })).toBeTruthy();
      const card = within(await screen.findByTestId('conclusion-card'));
      expect(card.getByText(vi_['aud.conclusionKind.auditReport'])).toBeTruthy();
      expect(card.getByText('Báo cáo kiểm toán cầu')).toBeTruthy();
      expect(card.getByText('88/BC-KTNN')).toBeTruthy();
      expect(card.getByText('2026-12-31')).toBeTruthy();
      expect(card.getByText(vi_['aud.conclusionStatus.received'])).toBeTruthy();
      expect(card.getByText(vi_['aud.conclusion.view.public.no'])).toBeTruthy();
      expect(text('money-total')).toBe('1.250.000.000');
      expect(text('money-recommended')).toBe('1.200.000.000');
      expect(text('money-shortfall')).toBe('50.000.000');
      expect(text('shortfall')).toBe(vi_['aud.conclusion.shortfall.warning'].replace('{amount}', '50.000.000'));
      expect(screen.getByTestId('shortfall').getAttribute('role')).toBe('status');
      expect(text('summary-card')).toContain('Kiểm toán phát hiện thanh toán vượt khối lượng được duyệt.');
      const rows = (await screen.findAllByRole('row')).slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
      expect(rows.map((row) => [row[0]?.slice(0, 6), row[1], row[2], row[3], row[4]])).toEqual([
        ['KN-001', vi_['aud.recommendationType.financialRecovery'], '800.000.000', '0', vi_['aud.recommendationStatus.open']],
        ['KN-002', vi_['aud.recommendationType.financialAdjustment'], '400.000.000', '0', vi_['aud.recommendationStatus.open']],
      ]);
      expect(screen.getByRole('link', { name: vi_['aud.conclusion.engagement.file.link'] }).getAttribute('href')).toBe(`/aud/aud-03?engagement=${ID}`);
      expect(screen.getByRole('link', { name: vi_['aud.conclusion.findings.link'] }).getAttribute('href')).toBe(`/aud/aud-05?engagement=${ID}`);
      expect(screen.queryByTestId('conclusion-form')).toBeNull();
    });

    it('says the recommendations equal the total when nothing is left, falls back on the ids and dashes of what is not known, and says so when there are no recommendations', async () => {
      open({
        conclusion: conclusionRecord({ recommended_vnd: '1250000000', shortfall_vnd: '0', is_public: true, implementation_due_on: null, report_due_on: null, document: { id: DOCUMENT, title: '', symbol: null } }),
        recommendations: [recommendationRecord(1, { rec_type: 'REFERRAL', amount_vnd: null })],
      });
      expect(await screen.findByTestId('conclusion-card')).toBeTruthy();
      expect(text('shortfall')).toBe(vi_['aud.conclusion.shortfall.none']);
      expect(screen.getByTestId('shortfall').getAttribute('role')).toBeNull();
      const card = within(screen.getByTestId('conclusion-card'));
      expect(card.getByText(DOCUMENT)).toBeTruthy();
      expect(card.getByText(vi_['aud.conclusion.view.public.yes'])).toBeTruthy();
      expect(card.getAllByText('—').length).toBeGreaterThanOrEqual(3);
      expect(within((await screen.findAllByRole('row'))[1] as HTMLElement).getAllByText('—').length).toBe(2);
      cleanup();
      open({ recommendations: [] });
      expect(await screen.findByTestId('no-recommendations')).toBeTruthy();
    });

    it('offers the recommendation to whoever may record, on the current revision of an engagement that is followed up and not otherwise', async () => {
      open();
      await screen.findByTestId('conclusion-card');
      expect(screen.getByRole('button', { name: vi_['aud.conclusion.recommendations.add.action'] })).toBeTruthy();
      cleanup();
      open({}, READER);
      await screen.findByTestId('conclusion-card');
      expect(screen.queryByRole('button', { name: vi_['aud.conclusion.recommendations.add.action'] })).toBeNull();
      cleanup();
      open({}, RECORDER, undefined, 'READ_ONLY');
      await screen.findByTestId('conclusion-card');
      expect(screen.queryByRole('button', { name: vi_['aud.conclusion.recommendations.add.action'] })).toBeNull();
      for (const setup of [{ conclusion: conclusionRecord({ status: 'SUPERSEDED' }) }, { engagement: { status: 'CLOSED' } }, { conclusion: conclusionRecord({ status: 'CLOSED' }) }]) {
        cleanup();
        open(setup);
        // A conclusion that was superseded is not the current one: the engagement then shows no conclusion.
        await screen.findByRole('heading', { level: 1, name: vi_['aud.conclusion.page.title'] });
        await waitFor(() => expect(screen.queryByTestId('engagement-card')).not.toBeNull());
        expect(screen.queryByRole('button', { name: vi_['aud.conclusion.recommendations.add.action'] })).toBeNull();
      }
    });
  });

  describe('adding a recommendation (AC-ST-AUD-002-1)', () => {
    const dialog = async (command: (operation: string, input: unknown) => unknown = () => ({ status: 'OK' })) => {
      const h = open({}, RECORDER, command);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['aud.conclusion.recommendations.add.action'] }));
      return { h, user, box: screen.getByRole('dialog') };
    };

    it('says what is left of the total, refuses an amount above it before sending it, and sends the one that fits in whole dong', async () => {
      const { h, user, box } = await dialog();
      await user.type(within(box).getByLabelText(vi_['aud.recommendation.dialog.code.label']), 'KN-003');
      await user.selectOptions(within(box).getByLabelText(vi_['aud.recommendation.dialog.type.label']), 'FINANCIAL_RECOVERY');
      expect(within(box).getByText(vi_['aud.recommendation.dialog.amount.remaining'].replace('{remaining}', '50.000.000'))).toBeTruthy();
      await user.type(within(box).getByLabelText(vi_['aud.recommendation.dialog.description.label']), 'Thu hồi khoản chi vượt khối lượng.');
      await user.type(within(box).getByLabelText(vi_['aud.recommendation.dialog.amount.label']), '100.000.000');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getByText(vi_['aud.formProblem.exceeds'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await user.clear(within(box).getByLabelText(vi_['aud.recommendation.dialog.amount.label']));
      await user.type(within(box).getByLabelText(vi_['aud.recommendation.dialog.amount.label']), '50.000.000');
      await user.selectOptions(within(box).getByLabelText(vi_['aud.recommendation.dialog.finding.label']), findingRecord(2).id as string);
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('createAuditRecommendation');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        path: { id: CONCLUSION },
        body: { rec_code: 'KN-003', rec_type: 'FINANCIAL_RECOVERY', description: 'Thu hồi khoản chi vượt khối lượng.', amount_vnd: '50000000', finding_id: findingRecord(2).id },
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('asks for no amount on a recommendation that is not financial, and sends none', async () => {
      const { h, user, box } = await dialog();
      await user.type(within(box).getByLabelText(vi_['aud.recommendation.dialog.code.label']), 'KN-004');
      expect(within(box).queryByLabelText(vi_['aud.recommendation.dialog.amount.label'])).toBeNull();
      await user.selectOptions(within(box).getByLabelText(vi_['aud.recommendation.dialog.type.label']), 'REFERRAL');
      expect(within(box).queryByLabelText(vi_['aud.recommendation.dialog.amount.label'])).toBeNull();
      await user.type(within(box).getByLabelText(vi_['aud.recommendation.dialog.description.label']), 'Chuyển hồ sơ cho cơ quan điều tra.');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { rec_type: 'REFERRAL' } });
      expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).not.toHaveProperty('amount_vnd');
    });

    it('tells what the server says is left when another recommendation took it, and keeps the dialog and what was typed', async () => {
      const { user, box } = await dialog(() => new ApiError({ status: 422, code: 'FINANCIAL_TOTAL_MISMATCH', correlationId: 'c', extensions: { remaining_vnd: '20000000' } }));
      await user.type(within(box).getByLabelText(vi_['aud.recommendation.dialog.code.label']), 'KN-005');
      await user.selectOptions(within(box).getByLabelText(vi_['aud.recommendation.dialog.type.label']), 'FINANCIAL_ADJUSTMENT');
      await user.type(within(box).getByLabelText(vi_['aud.recommendation.dialog.description.label']), 'Giảm trừ vào đợt thanh toán sau.');
      await user.type(within(box).getByLabelText(vi_['aud.recommendation.dialog.amount.label']), '40.000.000');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect((await within(box).findByTestId('refusal')).textContent).toBe(vi_['aud.conclusionProblem.totalMismatch'].replace('{remaining}', '20.000.000'));
      expect((within(box).getByLabelText(vi_['aud.recommendation.dialog.code.label']) as HTMLInputElement).value).toBe('KN-005');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.close.label'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('tells the other refusals in words: a code used before, a place outside the engagement, an engagement that moved on', async () => {
      const cases: Array<[string, string]> = [
        ['REC_CODE_DUPLICATE', vi_['aud.conclusionProblem.recommendationDuplicate']],
        ['TARGET_OUT_OF_ENGAGEMENT', vi_['aud.conclusionProblem.targetOutside']],
        ['ENGAGEMENT_STATE_INVALID', vi_['aud.conclusionProblem.stateInvalid']],
        ['AMOUNT_REQUIRED', vi_['aud.conclusionProblem.amountRequired']],
      ];
      for (const [code, message] of cases) {
        cleanup();
        const { user, box } = await dialog(() => new ApiError({ status: 409, code, correlationId: 'c' }));
        await user.type(within(box).getByLabelText(vi_['aud.recommendation.dialog.code.label']), 'KN-009');
        await user.selectOptions(within(box).getByLabelText(vi_['aud.recommendation.dialog.type.label']), 'POLICY_CHANGE');
        await user.type(within(box).getByLabelText(vi_['aud.recommendation.dialog.description.label']), 'Sửa quy trình thanh toán.');
        await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
        expect((await within(box).findByTestId('refusal')).textContent).toBe(message);
      }
    });

    it('says what is missing in an empty dialog', async () => {
      const { h, user, box } = await dialog();
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getAllByText(vi_['aud.formProblem.required']).length).toBe(3);
      expect(h.command).not.toHaveBeenCalled();
    });
  });

  describe('recording the conclusion (AC-ST-AUD-002-2)', () => {
    const form = (overrides: Setup['engagement'] = {}, permissions: readonly string[] | undefined = RECORDER, command?: (operation: string, input: unknown) => unknown) =>
      open({ engagement: { status: 'ONGOING', version: 2, ...overrides }, conclusion: null }, permissions, command);

    it('offers the form to whoever may record an engagement that is ongoing or whose fieldwork has ended, and to nobody else', async () => {
      form();
      expect(await screen.findByTestId('conclusion-form')).toBeTruthy();
      cleanup();
      form({ status: 'AWAITING_CONCLUSION' });
      expect(await screen.findByTestId('conclusion-form')).toBeTruthy();
      cleanup();
      form({}, READER);
      expect((await screen.findByTestId('conclusion-read-only')).textContent).toBe(vi_['aud.conclusion.readOnly.note']);
      expect(screen.queryByTestId('conclusion-form')).toBeNull();
      cleanup();
      for (const status of ['PLANNED', 'CANCELLED', 'CLOSED']) {
        form({ status });
        expect((await screen.findByTestId('conclusion-not-ready')).textContent).toBe(vi_['aud.conclusion.notReady.note']);
        expect(screen.queryByTestId('conclusion-form')).toBeNull();
        cleanup();
      }
    });

    it('asks for the kind, the document, the days, the total and the summary, and says what is wrong without sending anything', async () => {
      const h = form();
      const user = userEvent.setup();
      const box = within(await screen.findByTestId('conclusion-form'));
      await user.click(box.getByRole('button', { name: vi_['aud.conclusion.form.submit.action'] }));
      expect(box.getAllByText(vi_['aud.formProblem.required']).length).toBe(6);
      await user.selectOptions(box.getByLabelText(vi_['aud.conclusion.form.kind.label']), 'AUDIT_REPORT');
      await user.type(box.getByLabelText(vi_['aud.conclusion.form.document.label']), 'not-an-id');
      await user.type(box.getByLabelText(vi_['aud.conclusion.form.issuedOn.label']), '2026-10-10');
      await user.type(box.getByLabelText(vi_['aud.conclusion.form.receivedOn.label']), '2026-10-09');
      await user.type(box.getByLabelText(vi_['aud.conclusion.form.total.label']), '12x');
      await user.type(box.getByLabelText(vi_['aud.conclusion.form.summary.label']), 'ngắn');
      await user.click(box.getByRole('button', { name: vi_['aud.conclusion.form.submit.action'] }));
      for (const problem of ['invalid', 'order', 'tooShort']) expect(box.getAllByText(vi_[`aud.formProblem.${problem}` as 'aud.formProblem.invalid']).length).toBeGreaterThan(0);
      expect(h.command).not.toHaveBeenCalled();
    });

    it('sends the conclusion under the version of the engagement that the screen showed', async () => {
      const h = form();
      const user = userEvent.setup();
      const box = within(await screen.findByTestId('conclusion-form'));
      await user.selectOptions(box.getByLabelText(vi_['aud.conclusion.form.kind.label']), 'AUDIT_REPORT');
      await user.type(box.getByLabelText(vi_['aud.conclusion.form.document.label']), DOCUMENT);
      await user.type(box.getByLabelText(vi_['aud.conclusion.form.issuedOn.label']), '2026-10-10');
      await user.type(box.getByLabelText(vi_['aud.conclusion.form.receivedOn.label']), '2026-10-15');
      await user.type(box.getByLabelText(vi_['aud.conclusion.form.implementationDue.label']), '2026-12-31');
      await user.type(box.getByLabelText(vi_['aud.conclusion.form.total.label']), '1.250.000.000');
      await user.click(box.getByLabelText(vi_['aud.conclusion.form.public.label']));
      await user.type(box.getByLabelText(vi_['aud.conclusion.form.summary.label']), 'Kiểm toán phát hiện thanh toán vượt khối lượng.');
      await user.click(box.getByRole('button', { name: vi_['aud.conclusion.form.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('recordAuditConclusion');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        path: { id: ID },
        ifMatchVersion: 2,
        body: {
          conclusion_kind: 'AUDIT_REPORT',
          conclusion_document_id: DOCUMENT,
          issued_on: '2026-10-10',
          received_on: '2026-10-15',
          implementation_due_on: '2026-12-31',
          summary: 'Kiểm toán phát hiện thanh toán vượt khối lượng.',
          total_financial_vnd: '1250000000',
          is_public: true,
        },
      });
      expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).not.toHaveProperty('report_due_on');
    });

    const REFUSALS: Array<[string, string]> = [
      ['DECISION_DOCUMENT_NOT_EFFECTIVE', vi_['aud.conclusionProblem.decisionNotEffective']],
      ['VERSION_CONFLICT', vi_['aud.conclusionProblem.versionConflict']],
      ['ENGAGEMENT_STATE_INVALID', vi_['aud.conclusionProblem.stateInvalid']],
      ['CONCLUSION_REVISION_INVALID', vi_['aud.conclusionProblem.revisionInvalid']],
      ['SCOPE_DENIED', vi_['aud.conclusionProblem.scopeDenied']],
      ['VALIDATION_FAILED', vi_['aud.conclusionProblem.validation']],
      ['SOMETHING_ELSE', vi_['aud.conclusionProblem.general']],
    ];

    it.each(REFUSALS)('tells the refusal %s of the server in words and keeps what was typed', async (code, message) => {
      form({}, RECORDER, () => new ApiError({ status: 409, code, correlationId: 'c' }));
      const user = userEvent.setup();
      const box = within(await screen.findByTestId('conclusion-form'));
      await user.selectOptions(box.getByLabelText(vi_['aud.conclusion.form.kind.label']), 'INSPECTION_CONCLUSION');
      await user.type(box.getByLabelText(vi_['aud.conclusion.form.document.label']), DOCUMENT);
      await user.type(box.getByLabelText(vi_['aud.conclusion.form.issuedOn.label']), '2026-10-10');
      await user.type(box.getByLabelText(vi_['aud.conclusion.form.receivedOn.label']), '2026-10-15');
      await user.type(box.getByLabelText(vi_['aud.conclusion.form.total.label']), '0');
      await user.type(box.getByLabelText(vi_['aud.conclusion.form.summary.label']), 'Kết luận thanh tra về việc đầu tư cầu.');
      await user.click(box.getByRole('button', { name: vi_['aud.conclusion.form.submit.action'] }));
      expect((await box.findByTestId('refusal')).textContent).toBe(message);
      expect((box.getByLabelText(vi_['aud.conclusion.form.summary.label']) as HTMLTextAreaElement).value).toBe('Kết luận thanh tra về việc đầu tư cầu.');
    });
  });

  describe('choosing the engagement', () => {
    it('with none chosen asks for one, and lists the engagements that can take a conclusion or have one', async () => {
      const state = world({
        engagements: [
          engagementRecord(1, { status: 'FOLLOW_UP' }),
          engagementRecord(2, { status: 'PLANNED' }),
          engagementRecord(3, { status: 'ONGOING' }),
          engagementRecord(4, { status: 'CANCELLED' }),
          engagementRecord(5, { status: 'AWAITING_CONCLUSION' }),
        ],
      });
      mount(<ConclusionScreen route={ROUTE} />, client(state), { permissions: RECORDER, path: '/aud/aud-04' });
      expect((await screen.findByTestId('conclusion-choose')).textContent).toBe(vi_['aud.conclusion.choose.text']);
      await waitFor(() => expect(screen.getAllByRole('option').length).toBe(4));
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
        vi_['aud.conclusion.picker.choose'],
        vi_['aud.conclusion.picker.option'].replace('{code}', 'TTCP-2026-001').replace('{status}', vi_['aud.engagementStatus.followUp']),
        vi_['aud.conclusion.picker.option'].replace('{code}', 'TTCP-2026-003').replace('{status}', vi_['aud.engagementStatus.ongoing']),
        vi_['aud.conclusion.picker.option'].replace('{code}', 'TTCP-2026-005').replace('{status}', vi_['aud.engagementStatus.awaitingConclusion']),
      ]);
    });

    it('opens the conclusion of the engagement chosen', async () => {
      const state = stateOf({});
      mount(<ConclusionScreen route={ROUTE} />, client(state), { permissions: RECORDER, path: '/aud/aud-04' });
      const user = userEvent.setup();
      await waitFor(() => expect(screen.getAllByRole('option').length).toBe(2));
      await user.selectOptions(screen.getByLabelText(vi_['aud.conclusion.picker.label']), ID);
      expect(await screen.findByTestId('conclusion-card')).toBeTruthy();
      await user.selectOptions(screen.getByLabelText(vi_['aud.conclusion.picker.label']), '');
      expect(await screen.findByTestId('conclusion-choose')).toBeTruthy();
    });
  });

  describe('the seven states', () => {
    it('says the engagement is not there for one that is not found (the same words as an engagement of another scope)', async () => {
      mount(<ConclusionScreen route={ROUTE} />, client(world()), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
      expect(screen.queryByTestId('conclusion-card')).toBeNull();
    });

    it('shows a loading state first, then the denied, signed-out, offline and error states, for the engagement and for its conclusions', async () => {
      const failing = (operation: string, error: Error) => {
        const state = stateOf({});
        state.failing.set(operation, error);
        return client(state);
      };
      mount(<ConclusionScreen route={ROUTE} />, failing('getAuditEngagement', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      cleanup();
      mount(<ConclusionScreen route={ROUTE} />, failing('listAuditConclusions', new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
      cleanup();
      mount(<ConclusionScreen route={ROUTE} />, failing('listAuditConclusions', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      mount(<ConclusionScreen route={ROUTE} />, failing('getAuditEngagement', new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    });

    it('keeps the conclusion when only the recommendations cannot be read, and offers to try again', async () => {
      const state = stateOf({});
      state.failing.set('listAuditRecommendations', new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }));
      mount(<ConclusionScreen route={ROUTE} />, client(state), { permissions: RECORDER, path: PATH });
      expect(await screen.findByTestId('conclusion-card')).toBeTruthy();
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      expect(screen.getByRole('button', { name: vi_['states.retry.action'] })).toBeTruthy();
    });
  });

  it('shows the engagement with its manager role too (a manager who may not record sees the conclusion but cannot add)', async () => {
    open({}, MANAGER);
    await screen.findByTestId('conclusion-card');
    expect(screen.queryByRole('button', { name: vi_['aud.conclusion.recommendations.add.action'] })).toBeNull();
  });
});
