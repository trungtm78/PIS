import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { FIRST_TENANT, mountInSession } from '../adm/security/test-support';
import QualityScoreScreen from './QualityScoreScreen';
import { CONTRACT, DASHBOARD_READER, SNAPSHOT, STEWARD, dataset, dimensionRow, mount, problem, qualityClient, qualityWorld, routeOf, runRow, scoredRule, unassessedCard } from './quality-test-support';

const ROUTE = routeOf('DGV-07', 'FR-DGV-07');
const DATASET_ID = '00000000-0000-4000-8000-000200000001';
const PATH = `/dgv/dgv-07?dataset=${DATASET_ID}`;

afterEach(cleanup);

const DATASETS = [dataset(1, { dataset_code: 'DS-1', title: 'Dataset 1', working_contract_id: CONTRACT }), dataset(2, { dataset_code: 'DS-2', title: 'Dataset 2' })];
const ALL = ['COMPLETENESS', 'UNIQUENESS', 'VALIDITY', 'CONSISTENCY', 'TIMELINESS', 'ACCURACY', 'INTEGRITY'];

/** The scorecard of the dataset after nine rules passed and one integrity rule found two references to no project (AC-ST-DGV-002-1). */
function hardFailCard(overrides: Record<string, unknown> = {}) {
  const rules = [
    ...Array.from({ length: 9 }, (_, index) => scoredRule(index + 1)),
    scoredRule(10, {
      code: 'R-10-FK',
      dimension: 'INTEGRITY',
      action_on_fail: 'HARD_BLOCK',
      severity: 'CRITICAL',
      evaluated_count: 4,
      passed_count: 2,
      failed_count: 2,
      measured_value: '50.000000',
      result: 'FAIL',
      incident_id: '00000000-0000-4000-8000-000900000001',
    }),
  ];
  return unassessedCard({
    badge: 'FAILED',
    assessed: true,
    score: '95.00',
    hard_fail: true,
    certified_blocked: true,
    freshness: { slo_seconds: 86_400, age_seconds: 3_600 },
    snapshot_id: SNAPSHOT,
    snapshot_as_of: '2026-10-24T00:00:00.000000Z',
    definition_status: 'PROPOSED_PENDING_SIGNOFF',
    latest_run: runRow({ overall_result: 'FAILED', score: '95.00', hard_fail: true, certified_blocked: true, rule_count: 10, trigger: 'MANUAL' }),
    dimensions: ALL.map((dimension) => dimensionRow(dimension, dimension === 'ACCURACY' ? {} : { assessed: true, score: dimension === 'INTEGRITY' ? '50.00' : '100.00', rules_total: dimension === 'COMPLETENESS' ? 3 : 1, rules_failed: dimension === 'INTEGRITY' ? 1 : 0 })),
    rules,
    open_incidents: 1,
    overdue_incidents: 0,
    ...overrides,
  });
}

const world = (card: Record<string, unknown>) => qualityWorld({ datasets: DATASETS, cards: { [DATASET_ID]: card } });
const text = (id: string): string => screen.getByTestId(id).textContent ?? '';

describe('QualityScoreScreen (DGV-07): profiling and quality score (UI-DGV-07)', () => {
  it('asks for a dataset when none is chosen, and loads its scorecard when one is chosen from the list', async () => {
    const h = qualityClient(world(hardFailCard()));
    mount(<QualityScoreScreen route={ROUTE} />, h, STEWARD, '/dgv/dgv-07');
    expect((await screen.findByTestId('choose-dataset')).textContent).toBe(vi_['dgv.score.choose.text']);
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(3));
    fireEvent.change(screen.getByLabelText(vi_['dgv.score.dataset.label']), { target: { value: DATASET_ID } });
    expect(await screen.findByTestId('scorecard')).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('getQualityScorecard', { path: { id: DATASET_ID } });
    fireEvent.change(screen.getByLabelText(vi_['dgv.score.dataset.label']), { target: { value: '' } });
    expect(await screen.findByTestId('choose-dataset')).toBeTruthy();
  });

  it('is a hard fail with a score of about 95, the verdict failed and the snapshot blocked for certified figures (AC-ST-DGV-002-1)', async () => {
    mount(<QualityScoreScreen route={ROUTE} />, qualityClient(world(hardFailCard())), DASHBOARD_READER, PATH);
    const card = await screen.findByTestId('scorecard');
    expect(card.getAttribute('data-badge')).toBe('FAILED');
    expect(text('score')).toContain('95.00');
    expect(within(card).getAllByText(vi_['dgv.score.hardFail.pill']).length).toBeGreaterThan(0);
    expect(text('hard-fail')).toBe(vi_['dgv.score.hardFail.text']);
    expect(text('certified-blocked')).toBe(vi_['dgv.score.certifiedBlocked.text']);
    expect(screen.queryByTestId('not-assessed')).toBeNull();
    expect(text('incidents')).toBe(vi_['dgv.dashboard.incidents.text'].replace('{open}', '1').replace('{overdue}', '0'));
    expect(text('snapshot-id')).toBe(SNAPSHOT);
    expect(text('latest-run')).toContain(vi_['dgv.badge.failed.text']);
    expect(text('latest-run')).toContain(vi_['dgv.quality.trigger.manual.text']);

    const failed = document.querySelector('tr[data-rule-code="R-10-FK"]') as HTMLElement;
    expect(failed.getAttribute('data-result')).toBe('FAIL');
    expect(Array.from(failed.querySelectorAll('td')).map((cell) => cell.textContent)).toEqual([
      `R-10-FK${vi_['dgv.score.rule.revision'].replace('{revision}', '1')}`,
      vi_['dgv.quality.dimension.integrity.text'],
      '50.000000%',
      '100.000000%',
      '4 kiểm, 2 lỗi, 0 cách ly',
      `${vi_['dgv.quality.action.hardBlock.text']}${vi_['dgv.quality.severity.critical.text']}`,
      vi_['dgv.quality.result.fail.text'],
    ]);
    expect(failed.querySelector('.ui-pill')?.className).toBe('ui-pill ui-tone-danger');
    expect(document.querySelectorAll('tr[data-result="PASS"]')).toHaveLength(9);
  });

  it('shows a dataset that was never assessed as not assessed, with no score and no dimension scored, never 0 or passed (AC-ST-DGV-002-2)', async () => {
    mount(<QualityScoreScreen route={ROUTE} />, qualityClient(world(unassessedCard())), DASHBOARD_READER, PATH);
    const card = await screen.findByTestId('scorecard');
    expect(card.getAttribute('data-badge')).toBe('NOT_ASSESSED');
    expect(text('not-assessed')).toBe(vi_['dgv.score.notAssessed.text']);
    expect(text('score')).toContain(vi_['dgv.score.score.none']);
    expect(text('score')).not.toMatch(/\d/);
    expect(screen.queryByTestId('hard-fail')).toBeNull();
    expect(screen.queryByTestId('certified-blocked')).toBeNull();
    expect(screen.queryByTestId('latest-run')).toBeNull();
    const dimensionCells = screen.getAllByTestId('dimension-score').map((cell) => cell.textContent);
    expect(dimensionCells).toEqual(ALL.map(() => vi_['dgv.score.dimension.notAssessed']));
    expect(screen.getByTestId('no-results').textContent).toBe(vi_['dgv.score.rules.empty']);
    expect(within(card).getByText(vi_['dgv.score.freshness.none'].replace('{slo}', '1 ngày'))).toBeTruthy();
  });

  it('says how old the run is when it is older than the freshness SLO', async () => {
    const stale = hardFailCard({ badge: 'STALE', hard_fail: false, certified_blocked: false, freshness: { slo_seconds: 86_400, age_seconds: 172_800 } });
    mount(<QualityScoreScreen route={ROUTE} />, qualityClient(world(stale)), DASHBOARD_READER, PATH);
    await screen.findByTestId('scorecard');
    expect(text('stale')).toBe(vi_['dgv.score.stale.text'].replace('{age}', '2 ngày').replace('{slo}', '1 ngày'));
    expect(screen.queryByTestId('hard-fail')).toBeNull();
  });

  it('scores only the dimensions that were measured: a dimension without a rule shows not assessed, not 0', async () => {
    mount(<QualityScoreScreen route={ROUTE} />, qualityClient(world(hardFailCard())), DASHBOARD_READER, PATH);
    await screen.findByTestId('scorecard');
    const dimension = (name: string): HTMLElement => document.querySelector(`tr[data-dimension="${name}"]`) as HTMLElement;
    expect(within(dimension('ACCURACY')).getByTestId('dimension-score').textContent).toBe(vi_['dgv.score.dimension.notAssessed']);
    expect(dimension('ACCURACY').getAttribute('data-assessed')).toBe('false');
    expect(within(dimension('INTEGRITY')).getByTestId('dimension-score').textContent).toBe('50.00');
    expect(dimension('COMPLETENESS').textContent).toContain(vi_['dgv.score.dimensionRules.text'].replace('{total}', '3').replace('{failed}', '0'));
    expect(dimension('INTEGRITY').textContent).toContain(vi_['dgv.score.dimensionRules.text'].replace('{total}', '1').replace('{failed}', '1'));
  });

  it('says that the definitions behind the snapshot are not signed yet, and says nothing when they are', async () => {
    mount(<QualityScoreScreen route={ROUTE} />, qualityClient(world(hardFailCard())), DASHBOARD_READER, PATH);
    expect((await screen.findByTestId('definitions-unsigned')).textContent).toBe(vi_['dgv.score.definitionsUnsigned.text']);
    cleanup();
    mount(<QualityScoreScreen route={ROUTE} />, qualityClient(world(hardFailCard({ definition_status: 'SIGNED' }))), DASHBOARD_READER, PATH);
    await screen.findByTestId('scorecard');
    expect(screen.queryByTestId('definitions-unsigned')).toBeNull();
  });

  it('words a rule that could not be measured as such and shows a waiting or a failed run beside the result', async () => {
    const errored = scoredRule(1, { result: 'ERROR', measured_value: null, evaluated_count: 0, passed_count: 0, error_code: 'NO_ROWS_EVALUATED' });
    const waiting = hardFailCard({ rules: [errored], pending_attempt: runRow({ status: 'RUNNING', overall_result: null, score: null, finished_at: null, started_at: '2026-10-24T08:00:00.000000Z' }) });
    mount(<QualityScoreScreen route={ROUTE} />, qualityClient(world(waiting)), DASHBOARD_READER, PATH);
    expect((await screen.findByTestId('pending-attempt')).textContent).toBe(vi_['dgv.score.pending.running.text'].replace('{value}', '2026-10-24 08:00'));
    const row = document.querySelector('tr[data-rule-code="R-1"]') as HTMLElement;
    expect(row.textContent).toContain(vi_['dgv.score.rule.notMeasured']);
    expect(row.textContent).toContain(vi_['dgv.quality.ruleError.noRows.text']);
    expect(row.querySelector('.ui-pill')?.className).toBe('ui-pill ui-tone-neutral');
    cleanup();

    const broken = hardFailCard({ pending_attempt: runRow({ status: 'FAILED', overall_result: null, score: null, failure_code: 'SNAPSHOT_CHANGED' }) });
    mount(<QualityScoreScreen route={ROUTE} />, qualityClient(world(broken)), DASHBOARD_READER, PATH);
    expect((await screen.findByTestId('pending-attempt')).textContent).toBe(vi_['dgv.score.pending.failed.text'].replace('{reason}', vi_['dgv.quality.failure.snapshotChanged.text']));
  });

  it('shows the error state when the scorecard of the chosen dataset does not exist or cannot be read', async () => {
    mount(<QualityScoreScreen route={ROUTE} />, qualityClient(qualityWorld({ datasets: DATASETS })), DASHBOARD_READER, PATH);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('scorecard')).toBeNull();
    cleanup();
    mount(<QualityScoreScreen route={ROUTE} />, qualityClient(world({ dataset_id: 'incomplete' })), DASHBOARD_READER, PATH);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  describe('running the checks', () => {
    it('is offered to the person who may run them and not to a reader', async () => {
      mount(<QualityScoreScreen route={ROUTE} />, qualityClient(world(hardFailCard())), DASHBOARD_READER, PATH);
      await screen.findByTestId('scorecard');
      expect(screen.queryByRole('form', { name: vi_['dgv.score.run.title'] })).toBeNull();
      cleanup();
      mount(<QualityScoreScreen route={ROUTE} />, qualityClient(world(hardFailCard())), STEWARD, PATH);
      await screen.findByTestId('scorecard');
      expect(screen.getByRole('form', { name: vi_['dgv.score.run.title'] })).toBeTruthy();
    });

    it('is not offered in a read-only workspace', async () => {
      mountInSession(<QualityScoreScreen route={ROUTE} />, qualityClient(world(hardFailCard())), { tenant: FIRST_TENANT, permissions: STEWARD, mode: 'READ_ONLY' });
      await waitFor(() => expect(screen.getAllByRole('option').length).toBe(3));
      fireEvent.change(screen.getByLabelText(vi_['dgv.score.dataset.label']), { target: { value: DATASET_ID } });
      await screen.findByTestId('scorecard');
      expect(screen.queryByRole('form', { name: vi_['dgv.score.run.title'] })).toBeNull();
    });

    it('refuses an empty or malformed snapshot id before asking, and asks for the working contract with the id in lower case', async () => {
      const h = qualityClient(world(hardFailCard()), () => ({ status: 'RUNNING', resource_version: 1 }));
      mount(<QualityScoreScreen route={ROUTE} />, h, STEWARD, PATH);
      await screen.findByTestId('scorecard');
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: vi_['dgv.score.run.start.action'] }));
      expect(screen.getByText(vi_['dgv.field.required.error'])).toBeTruthy();
      fireEvent.change(screen.getByLabelText(vi_['dgv.score.run.snapshot.label']), { target: { value: 'not-an-id' } });
      await user.click(screen.getByRole('button', { name: vi_['dgv.score.run.start.action'] }));
      expect(screen.getByText(vi_['dgv.quality.field.invalidId.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();

      fireEvent.change(screen.getByLabelText(vi_['dgv.score.run.snapshot.label']), { target: { value: ` ${SNAPSHOT.toUpperCase()} ` } });
      await user.click(screen.getByRole('button', { name: vi_['dgv.score.run.start.action'] }));
      expect((await screen.findByTestId('run-requested')).textContent).toBe(vi_['dgv.score.run.requested.notice']);
      expect(h.command).toHaveBeenCalledTimes(1);
      expect(h.command.mock.calls[0]?.[0]).toBe('runQualityChecks');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { dataset_contract_id: CONTRACT, snapshot_id: SNAPSHOT, trigger: 'MANUAL' } });
      expect((screen.getByLabelText(vi_['dgv.score.run.snapshot.label']) as HTMLInputElement).value).toBe('');
    });

    it('tells why the server refused: a run in progress, a snapshot that is missing or not frozen', async () => {
      const refusals = [
        [problem('RUN_ALREADY_RUNNING', 409, 'snapshot_id'), vi_['dgv.quality.problem.alreadyRunning.error']],
        [problem('SNAPSHOT_NOT_FOUND', 404, 'snapshot_id'), vi_['dgv.quality.problem.snapshotNotFound.error']],
        [problem('STAGE_TRANSITION_DENIED', 409, 'snapshot_id'), vi_['dgv.quality.problem.snapshotNotFrozen.error']],
        [problem('SCOPE_DENIED', 403), vi_['dgv.problem.denied.error']],
      ] as const;
      for (const [error, message] of refusals) {
        const h = qualityClient(world(hardFailCard()), () => error);
        mount(<QualityScoreScreen route={ROUTE} />, h, STEWARD, PATH);
        await screen.findByTestId('scorecard');
        fireEvent.change(screen.getByLabelText(vi_['dgv.score.run.snapshot.label']), { target: { value: SNAPSHOT } });
        await userEvent.setup().click(screen.getByRole('button', { name: vi_['dgv.score.run.start.action'] }));
        await waitFor(() => expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(message));
        expect(screen.queryByTestId('run-requested')).toBeNull();
        cleanup();
      }
    });

    it('cannot run while the dataset has no working contract, and says why', async () => {
      const bare = qualityWorld({ datasets: [dataset(1, { working_contract_id: null })], cards: { [DATASET_ID]: unassessedCard() } });
      mount(<QualityScoreScreen route={ROUTE} />, qualityClient(bare), STEWARD, PATH);
      await screen.findByTestId('scorecard');
      expect(screen.getByTestId('no-contract').textContent).toBe(vi_['dgv.score.run.noContract.text']);
      expect((screen.getByRole('button', { name: vi_['dgv.score.run.start.action'] }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.submit(screen.getByRole('form', { name: vi_['dgv.score.run.title'] }));
    });
  });
});
