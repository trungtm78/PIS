import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { ACCOUNTANT_ROLE, READER, client, detailRecord, engagementRecord, linkRecord, mount, rateRecord, routeOf, summaryRecord, world } from '../test-support';
import RecoveryScreen from './RecoveryScreen';

const ROUTE = routeOf('AUD-08', 'FR-AUD-08');
const ID = detailRecord(1).id as string;
const RECOMMENDATION = (summaryRecord().recommendations as Array<{ recommendation_id: string }>)[0]?.recommendation_id as string;
const DOCUMENT = '00000000-0000-4000-8000-000000000021';
const PATH = `/aud/aud-08?engagement=${ID}`;

afterEach(cleanup);

interface Setup {
  summary?: Record<string, unknown>;
  links?: Array<Record<string, unknown>>;
}

const stateOf = ({ summary = summaryRecord(), links }: Setup) =>
  world({ engagements: [engagementRecord(1, { status: 'FOLLOW_UP' })], summaries: { [ID]: summary }, links: { [ID]: links ?? [linkRecord(1)] } });

const open = (setup: Setup = {}, permissions: readonly string[] | undefined = ACCOUNTANT_ROLE, command: (operation: string, input: unknown) => unknown = () => ({ status: 'OK' }), mode?: 'FULL' | 'READ_ONLY') => {
  const h = client(stateOf(setup), command);
  mount(<RecoveryScreen route={ROUTE} />, h, { permissions, path: PATH, ...(mode === undefined ? {} : { mode }) });
  return h;
};

/** The button of the heading, which opens the dialog with no recommendation chosen. */
const headingAction = (): HTMLElement => within(document.querySelector('.heading .actions') as HTMLElement).getByRole('button', { name: vi_['aud.recovery.link.action'] });

const text = (id: string): string => screen.getByTestId(id).textContent ?? '';

describe('AUD-08 ledger of recoveries and reconciliation with PAY', () => {
  it('AC-ST-AUD-004-1: shows the money, what is left and the two rates each with their numerator and denominator', async () => {
    open({ summary: summaryRecord({ recovered_vnd: '800000000', remaining_vnd: '0', money_rate: rateRecord('800000000', '800000000', '100.00'), count_rate: rateRecord('1', '1', '100.00') }) });
    expect(await screen.findByRole('heading', { level: 1, name: vi_['aud.recovery.page.title'] })).toBeTruthy();
    await screen.findByTestId('recovery-totals');
    expect(text('total-amount')).toBe('800.000.000');
    expect(text('total-recovered')).toBe('800.000.000');
    expect(text('total-remaining')).toBe('0');
    expect(text('rate-money')).toBe(`100,00% ${vi_['aud.recovery.rate.parts'].replace('{numerator}', '800.000.000').replace('{denominator}', '800.000.000')}`);
    expect(text('rate-count')).toContain('100,00%');
    expect(text('rate-count')).toContain('(1 / 1)');
    expect(text('recovery-rule')).toBe(vi_['aud.recovery.rule.note']);
  });

  it('says a rate is not applicable, never 0 percent, when nothing was recommended', async () => {
    open({ summary: summaryRecord({ amount_vnd: '0', recovered_vnd: '0', remaining_vnd: '0', money_rate: rateRecord('0', '0', null), count_rate: rateRecord('0', '0', null), recommendations: [] }), links: [] });
    await screen.findByTestId('recovery-totals');
    expect(text('rate-money')).toContain(vi_['aud.recovery.rate.na']);
    expect(text('rate-money')).not.toContain('0%');
    expect(screen.getByTestId('no-financial').textContent).toBe(vi_['aud.recovery.recommendations.none']);
    expect(screen.getByTestId('no-lines').textContent).toBe(vi_['aud.recovery.ledger.none']);
    expect(screen.queryByRole('button', { name: vi_['aud.recovery.link.action'] })).toBeNull();
  });

  it('lists each recommendation with its money and each line of the ledger with its source, its sign, what was recovered up to it and what is left, and marks the reversal and the reversed line', async () => {
    open({
      links: [
        linkRecord(1, { amount_vnd: '100000000', cumulative_vnd: '100000000', remaining_vnd: '700000000', reversed: true }),
        linkRecord(2, { source_kind: 'TREASURY_REMITTANCE', amount_vnd: '50000000', cumulative_vnd: '150000000', remaining_vnd: '650000000', evidence_document_id: DOCUMENT }),
        linkRecord(3, { amount_vnd: '-100000000', reversal_of_id: linkRecord(1).id, cumulative_vnd: '50000000', remaining_vnd: '750000000', note: 'Nhập hai lần.' }),
      ],
    });
    await screen.findByTestId('recovery-totals');
    const rec = within(document.querySelector('tr[data-recommendation-id]') as HTMLElement);
    expect(rec.getByText('KN-001')).toBeTruthy();
    expect(rec.getByText(vi_['aud.recommendationStatus.inProgress'])).toBeTruthy();
    const rows = Array.from(document.querySelectorAll('tr[data-link-id]')).map((row) => within(row as HTMLElement).getAllByRole('cell').map((cell) => cell.textContent));
    expect(rows.map((row) => row.slice(1, 6))).toEqual([
      [vi_['aud.recoverySource.payRecovery'], '100.000.000', '2026-10-20', '100.000.000', '700.000.000'],
      [vi_['aud.recoverySource.treasuryRemittance'], '50.000.000', '2026-10-20', '150.000.000', '650.000.000'],
      [vi_['aud.recoverySource.payRecovery'], '-100.000.000', '2026-10-20', '50.000.000', '750.000.000'],
    ]);
    expect(rows[0]?.[6]).toContain(vi_['aud.recovery.ledger.reversed']);
    expect(rows[2]?.[6]).toContain(vi_['aud.recovery.ledger.reversal.line']);
    expect(rows[2]?.[0]).toContain('Nhập hai lần.');
  });

  it('offers the line and the reversal to an accountant only: not to a reader, not in a tenant that is read only, not for a line that was reversed or is a reversal', async () => {
    open({ links: [linkRecord(1), linkRecord(2, { reversed: true }), linkRecord(3, { amount_vnd: '-5', reversal_of_id: linkRecord(2).id })] });
    await screen.findByTestId('recovery-totals');
    expect(screen.getAllByRole('button', { name: vi_['aud.recovery.link.action'] }).length).toBe(2);
    expect(screen.getAllByRole('button', { name: vi_['aud.recovery.reverse.action'] }).length).toBe(1);
    cleanup();
    open({}, READER);
    await screen.findByTestId('recovery-totals');
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    open({}, ACCOUNTANT_ROLE, undefined, 'READ_ONLY');
    await screen.findByTestId('recovery-totals');
    expect(screen.queryByRole('button', { name: vi_['aud.recovery.link.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['aud.recovery.reverse.action'] })).toBeNull();
  });

  it('keeps a recommendation with nothing left, or one that was cancelled, out of the buttons of the table', async () => {
    const item = (id: string, code: string, status: string, remaining: string) => ({ recommendation_id: id, rec_code: code, status, amount_vnd: '10', recovered_vnd: '0', remaining_vnd: remaining, line_count: 0, version: 1 });
    open({ summary: summaryRecord({ recommendations: [item('a', 'A', 'IN_PROGRESS', '10'), item('b', 'B', 'IN_PROGRESS', '0'), item('c', 'C', 'CANCELLED', '10')] }), links: [] });
    await screen.findByTestId('recovery-totals');
    const buttons = within(document.querySelector('table') as HTMLElement).getAllByRole('button', { name: vi_['aud.recovery.link.action'] });
    expect(buttons.length).toBe(1);
  });

  it('shows what the ledger could not take from PAY, in words, with the amount and the source', async () => {
    open({
      summary: summaryRecord({
        exceptions: [
          { id: 'x1', recommendation_id: RECOMMENDATION, rec_code: 'KN-001', kind: 'OVER_RECOVERY', source_kind: 'PAY_DEDUCTION', source_id: null, amount_vnd: '200000000', recorded_on: '2026-10-21', status: 'OPEN', created_at: 'now' },
          { id: 'x2', recommendation_id: RECOMMENDATION, rec_code: 'KN-001', kind: 'UNMATCHED_REVERSAL', source_kind: 'PAY_RECOVERY', source_id: null, amount_vnd: '100000000', recorded_on: '2026-10-22', status: 'OPEN', created_at: 'now' },
          { id: 'x3', recommendation_id: RECOMMENDATION, rec_code: 'KN-009', kind: 'NOT_APPLICABLE', source_kind: 'PAY_RECOVERY', source_id: null, amount_vnd: '5', recorded_on: '2026-10-23', status: 'OPEN', created_at: 'now' },
        ],
      }),
    });
    const panel = within(await screen.findByTestId('exceptions'));
    expect(panel.getByRole('status').textContent).toBe(vi_['aud.recovery.exceptions.note'].replace('{count}', '3'));
    const rows = Array.from(document.querySelectorAll('tr[data-exception-id]')).map((row) => within(row as HTMLElement).getAllByRole('cell').map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['KN-001', vi_['aud.recoveryException.overRecovery'], vi_['aud.recoverySource.payDeduction'], '200.000.000', '2026-10-21'],
      ['KN-001', vi_['aud.recoveryException.unmatchedReversal'], vi_['aud.recoverySource.payRecovery'], '100.000.000', '2026-10-22'],
      ['KN-009', vi_['aud.recoveryException.notApplicable'], vi_['aud.recoverySource.payRecovery'], '5', '2026-10-23'],
    ]);
    expect(within(panel.getByRole('link', { name: vi_['aud.recovery.exceptions.file.link'] }) as HTMLElement).getByText(vi_['aud.recovery.exceptions.file.link'])).toBeTruthy();
  });

  describe('recording a line by hand (AC-ST-AUD-004-2)', () => {
    const dialog = async (command: (operation: string, input: unknown) => unknown = () => ({ status: 'OK' }), setup: Setup = {}) => {
      const h = open(setup, ACCOUNTANT_ROLE, command);
      const user = userEvent.setup();
      await screen.findByTestId('recovery-totals');
      await user.click(headingAction());
      return { h, user, box: screen.getByRole('dialog') };
    };
    const fill = async (user: ReturnType<typeof userEvent.setup>, box: HTMLElement, amount: string) => {
      await user.selectOptions(within(box).getByLabelText(vi_['aud.recovery.link.recommendation.label']), RECOMMENDATION);
      await user.selectOptions(within(box).getByLabelText(vi_['aud.recovery.link.source.label']), 'TREASURY_REMITTANCE');
      await user.type(within(box).getByLabelText(vi_['aud.recovery.link.amount.label']), amount);
      await user.type(within(box).getByLabelText(vi_['aud.recovery.link.evidence.label']), DOCUMENT);
    };

    it('says what is left on the recommendation, refuses an amount above it before sending it, and sends the line under the version of the recommendation', async () => {
      const { h, user, box } = await dialog();
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getAllByText(vi_['aud.formProblem.required']).length).toBe(4);
      await fill(user, box, '300.000.001');
      expect(within(box).getByText(vi_['aud.recovery.link.amount.remaining'].replace('{remaining}', '300.000.000'))).toBeTruthy();
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getByText(vi_['aud.formProblem.exceeds'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await user.clear(within(box).getByLabelText(vi_['aud.recovery.link.amount.label']));
      await user.type(within(box).getByLabelText(vi_['aud.recovery.link.amount.label']), '300.000.000');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('linkAuditRecovery');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        path: { id: RECOMMENDATION },
        ifMatchVersion: 6,
        body: { source_kind: 'TREASURY_REMITTANCE', amount_vnd: '300000000', evidence_document_id: DOCUMENT },
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('opens on the recommendation of the row that was pressed', async () => {
      open({}, ACCOUNTANT_ROLE);
      const user = userEvent.setup();
      await screen.findByTestId('recovery-totals');
      const row = document.querySelector('tr[data-recommendation-id]') as HTMLElement;
      await user.click(within(row).getByRole('button', { name: vi_['aud.recovery.link.action'] }));
      expect((within(screen.getByRole('dialog')).getByLabelText(vi_['aud.recovery.link.recommendation.label']) as HTMLSelectElement).value).toBe(RECOMMENDATION);
    });

    it('tells what the server says is left when another accountant took it first, and keeps the dialog and what was typed', async () => {
      const { user, box } = await dialog(() => new ApiError({ status: 409, code: 'RECOVERY_EXCEEDS_RECOMMENDATION', correlationId: 'c', extensions: { remaining_vnd: '20000000' } }));
      await fill(user, box, '100.000.000');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect((await within(box).findByTestId('refusal')).textContent).toBe(vi_['aud.recoveryProblem.exceeds'].replace('{remaining}', '20.000.000'));
      expect((within(box).getByLabelText(vi_['aud.recovery.link.amount.label']) as HTMLInputElement).value).toBe('100.000.000');
    });

    const REFUSALS: Array<[string, string]> = [
      ['RECOVERY_SOURCE_ALREADY_LINKED', vi_['aud.recoveryProblem.sourceLinked']],
      ['RECOMMENDATION_NOT_FINANCIAL', vi_['aud.recoveryProblem.notFinancial']],
      ['EVIDENCE_REQUIRED', vi_['aud.recoveryProblem.evidenceRequired']],
      ['RECOMMENDATION_STATE_INVALID', vi_['aud.recoveryProblem.recommendationState']],
      ['ENGAGEMENT_STATE_INVALID', vi_['aud.recoveryProblem.engagementState']],
      ['VERSION_CONFLICT', vi_['aud.recoveryProblem.versionConflict']],
      ['SCOPE_DENIED', vi_['aud.recoveryProblem.scopeDenied']],
      ['VALIDATION_FAILED', vi_['aud.recoveryProblem.validation']],
      ['RESOURCE_NOT_FOUND', vi_['aud.recoveryProblem.notFound']],
      ['SOMETHING_ELSE', vi_['aud.recoveryProblem.general']],
    ];

    it.each(REFUSALS)('tells the refusal %s in words', async (code, message) => {
      const { user, box } = await dialog(() => new ApiError({ status: 409, code, correlationId: 'c' }));
      await fill(user, box, '1.000');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect((await within(box).findByTestId('refusal')).textContent).toBe(message);
    });
  });

  describe('reversing a line (AC-ST-AUD-004-2)', () => {
    it('asks for the reason in words, says nothing is deleted, and sends the reversal of the line', async () => {
      const h = open();
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['aud.recovery.reverse.action'] }));
      const box = screen.getByRole('dialog');
      expect(within(box).getByTestId('reverse-note').textContent).toBe(vi_['aud.recovery.reverse.note']);
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getByText(vi_['aud.formProblem.required'])).toBeTruthy();
      await user.type(within(box).getByLabelText(vi_['aud.recovery.reverse.reason.label']), 'ngắn');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getByText(vi_['aud.formProblem.tooShort'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await user.clear(within(box).getByLabelText(vi_['aud.recovery.reverse.reason.label']));
      await user.type(within(box).getByLabelText(vi_['aud.recovery.reverse.reason.label']), 'Chứng từ của Kho bạc đã nhập hai lần.');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('reverseAuditRecovery');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: linkRecord(1).id }, body: { reason: 'Chứng từ của Kho bạc đã nhập hai lần.' } });
      expect((h.command.mock.calls[0]?.[1] as Record<string, unknown>).ifMatchVersion).toBeUndefined();
    });

    it('tells a line that was reversed already in words', async () => {
      open({}, ACCOUNTANT_ROLE, () => new ApiError({ status: 409, code: 'RECOVERY_ALREADY_REVERSED', correlationId: 'c' }));
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['aud.recovery.reverse.action'] }));
      const box = screen.getByRole('dialog');
      await user.type(within(box).getByLabelText(vi_['aud.recovery.reverse.reason.label']), 'Chứng từ của Kho bạc đã nhập hai lần.');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect((await within(box).findByTestId('refusal')).textContent).toBe(vi_['aud.recoveryProblem.alreadyReversed']);
    });
  });

  describe('choosing the engagement and the seven states', () => {
    it('with none chosen asks for one', async () => {
      mount(<RecoveryScreen route={ROUTE} />, client(stateOf({})), { permissions: READER, path: '/aud/aud-08' });
      expect((await screen.findByTestId('recovery-choose')).textContent).toBe(vi_['aud.recovery.choose.text']);
      await waitFor(() => expect(screen.getAllByRole('option').length).toBe(2));
    });

    it('says the engagement is not there for one that is not found (the same words as an engagement of another scope)', async () => {
      mount(<RecoveryScreen route={ROUTE} />, client(world()), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    });

    it('shows a loading state first, then the denied, signed-out, offline and error states', async () => {
      const failing = (operation: string, error: Error) => {
        const state = stateOf({});
        state.failing.set(operation, error);
        return client(state);
      };
      mount(<RecoveryScreen route={ROUTE} />, failing('getAuditRecoverySummary', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      cleanup();
      mount(<RecoveryScreen route={ROUTE} />, failing('listAuditRecoveryLinks', new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
      cleanup();
      mount(<RecoveryScreen route={ROUTE} />, failing('listAuditRecoveryLinks', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      mount(<RecoveryScreen route={ROUTE} />, failing('getAuditRecoverySummary', new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    });
  });
});
