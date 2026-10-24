import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import AppraisalScoreScreen from './AppraisalScoreScreen';
import { CRITERIA, EVIDENCE, PROJECT_ID, SET_ID, SHEET_ID, appraisal, appraisalClient, criteriaSet, lifecycle, mount, routeOf, sheet, world } from './appraisal-test-support';

const ROUTE = routeOf('PRJ-15', 'FR-PRJ-15');
const APPRAISER = ['project.read', 'project.appraise'];
const OPEN = `/prj/prj-15?id=${PROJECT_ID}`;
const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const OK = { operation_id: 'o', status: 'SUBMITTED', resource_version: 1, resource_id: SHEET_ID };

afterEach(cleanup);

const grid = () => screen.findByTestId('grid');
const score = (criterion: string, value: number): void => {
  const row = document.querySelector(`[data-criterion="${criterion}"]`) as HTMLElement;
  fireEvent.click(within(row).getByLabelText(vi_['prj.score.grid.option.aria'].replace('{score}', String(value)).replace('{criterion}', CRITERIA.find((entry) => entry.code === criterion)?.name ?? '')));
};
const scoreAll = (values: number[]): void => CRITERIA.forEach((criterion, index) => score(criterion.code, values[index] as number));
const recommend = (value: string): void => {
  fireEvent.change(screen.getByLabelText(vi_['prj.score.recommendation.label']), { target: { value } });
};
const record = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['prj.score.submit.action'] }));
};

describe('AppraisalScoreScreen (PRJ-15): the scoring of a project against the criteria set', () => {
  it('UI-PRJ-15: shows a criterion on each row with its weight and six segments from 0 to 5, the set, its threshold and the confirmation it waits for', async () => {
    mount(<AppraisalScoreScreen route={ROUTE} />, appraisalClient(world()), { permissions: APPRAISER, path: OPEN });
    await grid();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['prj.score.page.title']);
    const rows = Array.from(document.querySelectorAll('[data-criterion]'));
    expect(rows.map((row) => [row.querySelector('th')?.textContent, row.querySelectorAll('td')[0]?.textContent, row.querySelectorAll('input[type="radio"]').length])).toEqual(
      CRITERIA.map((criterion) => [criterion.name, criterion.weight, 6]),
    );
    expect(screen.getAllByRole('radiogroup')).toHaveLength(5);
    expect(screen.getByTestId('criteria-basis').textContent).toContain('APPR-CRIT-2026r1');
    expect(screen.getByTestId('criteria-basis').textContent).toContain('60');
    expect(screen.getByTestId('set-awaiting').textContent).toBe(vi_['prj.appraisal.set.awaitingCxn.badge'].replace('{cxn}', 'ASSUMPTION-APPRAISAL-60'));
    expect(screen.getByTestId('no-own-sheet').textContent).toBe(vi_['prj.score.own.none']);
    expect(screen.getByTestId('total').textContent).toBe(vi_['prj.score.total.none']);
  });

  it('AC-ST-PRJ-003-1: previews the total as the scores are chosen (4,3,5,2,4 against 30/25/20/15/10 is 73.00) and says it is only a preview', async () => {
    mount(<AppraisalScoreScreen route={ROUTE} />, appraisalClient(world()), { permissions: APPRAISER, path: OPEN });
    await grid();
    scoreAll([4, 3, 5, 2, 4]);
    expect(screen.getByTestId('total').textContent).toBe(vi_['prj.score.total.preview'].replace('{total}', '73.00'));
    score('C3', 4);
    expect(screen.getByTestId('total').textContent).toContain('69.00');
  });

  it('AC-ST-PRJ-003-1: asks for every score, a valid evidence id and a recommendation before the sheet is sent', async () => {
    const h = appraisalClient(world(), () => OK);
    mount(<AppraisalScoreScreen route={ROUTE} />, h, { permissions: APPRAISER, path: OPEN });
    await grid();
    record();
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.getByTestId('scores-error').textContent).toBe(vi_['prj.appraisal.field.scoresIncomplete.error']);
    scoreAll([4, 3, 5, 2, 4]);
    fireEvent.change(screen.getByLabelText(vi_['prj.score.grid.evidence.aria'].replace('{criterion}', CRITERIA[0]?.name ?? '')), { target: { value: 'not-an-id' } });
    record();
    expect(h.command).not.toHaveBeenCalled();
    const alerts = screen.getAllByRole('alert').map((alert) => alert.textContent);
    expect(alerts).toContain(vi_['prj.appraisal.field.evidenceInvalid.error']);
    expect(alerts).toContain(vi_['prj.appraisal.field.required.error']);
  });

  it('AC-ST-PRJ-003-1: sends the sheet with the version of the set, the whole scores, the evidence and the opinion, and shows the total the server answers', async () => {
    let recorded = false;
    const state = world();
    const h = appraisalClient(state, () => {
      recorded = true;
      state.lifecycle = lifecycle('APPRAISAL', appraisal({ sheets: [sheet(SHEET_ID, [4, 3, 5, 2, 4], { mine: true, total_score: '73.00' })] }));
      return OK;
    });
    mount(<AppraisalScoreScreen route={ROUTE} />, h, { permissions: APPRAISER, path: OPEN });
    await grid();
    scoreAll([4, 3, 5, 2, 4]);
    fireEvent.change(screen.getByLabelText(vi_['prj.score.grid.evidence.aria'].replace('{criterion}', CRITERIA[0]?.name ?? '')), { target: { value: EVIDENCE.toUpperCase() } });
    recommend('ADMIT');
    fireEvent.change(screen.getByLabelText(vi_['prj.score.note.label']), { target: { value: '  A sound proposal  ' } });
    record();
    expect((await screen.findByTestId('saved')).textContent).toBe(vi_['prj.score.saved.notice']);
    expect(recorded).toBe(true);
    expect(h.command).toHaveBeenCalledWith(
      'recordProjectAppraisal',
      expect.objectContaining({
        path: { id: PROJECT_ID },
        body: {
          criteria_set_version_id: SET_ID,
          recommendation: 'ADMIT',
          note: 'A sound proposal',
          scores: [
            { criterion_code: 'C1', score: 4, evidence_ids: [EVIDENCE] },
            { criterion_code: 'C2', score: 3 },
            { criterion_code: 'C3', score: 5 },
            { criterion_code: 'C4', score: 2 },
            { criterion_code: 'C5', score: 4 },
          ],
        },
      }),
    );
    await waitFor(() => expect(screen.getByTestId('own-sheet').textContent).toContain('73.00'));
    expect(screen.getByTestId('own-sheet').textContent).toContain(vi_['prj.appraisal.recommendation.admit.label']);
    expect(screen.getByRole('button', { name: vi_['prj.score.resubmit.action'] })).toBeTruthy();
  });

  it('AC-ST-PRJ-003-1: starts from the sheet the caller recorded, so that scoring again changes what they said', async () => {
    const own = sheet(SHEET_ID, [4, 3, 5, 2, 4], { mine: true, note: 'First opinion', recommendation: 'RETURN' });
    const h = appraisalClient(world({ lifecycle: lifecycle('APPRAISAL', appraisal({ sheets: [own] })) }), () => OK);
    mount(<AppraisalScoreScreen route={ROUTE} />, h, { permissions: APPRAISER, path: OPEN });
    await grid();
    expect(screen.getByTestId('total').textContent).toContain('73.00');
    expect((screen.getByLabelText(vi_['prj.score.note.label']) as HTMLTextAreaElement).value).toBe('First opinion');
    expect((screen.getByLabelText(vi_['prj.score.recommendation.label']) as HTMLSelectElement).value).toBe('RETURN');
    score('C1', 5);
    fireEvent.click(screen.getByRole('button', { name: vi_['prj.score.resubmit.action'] }));
    await screen.findByTestId('saved');
    expect(h.command).toHaveBeenCalledWith('recordProjectAppraisal', expect.objectContaining({ body: expect.objectContaining({ recommendation: 'RETURN', note: 'First opinion' }) }));
  });

  it('AC-ST-PRJ-003-3: says why the server refused a sheet: the proposer, the weights, the scale, the stage, a version moved', async () => {
    const cases: Array<[string, number, string]> = [
      ['SELF_APPROVAL_DENIED', 403, 'prj.appraisal.problem.selfApproval.error'],
      ['CRITERIA_WEIGHT_INVALID', 422, 'prj.appraisal.problem.criteriaWeight.error'],
      ['SCORE_OUT_OF_RANGE', 422, 'prj.appraisal.problem.scoreRange.error'],
      ['STAGE_TRANSITION_DENIED', 409, 'prj.appraisal.problem.transitionDenied.error'],
      ['VERSION_CONFLICT', 409, 'prj.appraisal.problem.versionConflict.error'],
    ];
    for (const [code, status, key] of cases) {
      const h = appraisalClient(world(), () => problem(code, status));
      const view = mount(<AppraisalScoreScreen route={ROUTE} />, h, { permissions: APPRAISER, path: OPEN });
      await grid();
      scoreAll([4, 3, 5, 2, 4]);
      recommend('ADMIT');
      record();
      expect((await screen.findByTestId('problem')).textContent).toBe(vi_[key as keyof typeof vi_]);
      view.unmount();
    }
  });

  it('AC-ST-PRJ-003-3: tells the proposer they cannot score, and offers nothing where there is nothing to score against', async () => {
    const proposer = mount(<AppraisalScoreScreen route={ROUTE} />, appraisalClient(world({ lifecycle: lifecycle('APPRAISAL', appraisal({ viewer_is_proposer: true, can_record: false })) })), { permissions: APPRAISER, path: OPEN });
    expect((await screen.findByTestId('proposer')).textContent).toBe(vi_['prj.score.proposer.notice']);
    expect(screen.queryByTestId('grid')).toBeNull();
    proposer.unmount();
    const noSet = mount(<AppraisalScoreScreen route={ROUTE} />, appraisalClient(world({ lifecycle: lifecycle('APPRAISAL', appraisal({ criteria_set: null })) })), { permissions: APPRAISER, path: OPEN });
    expect((await screen.findByTestId('no-set')).textContent).toBe(vi_['prj.score.noSet.notice']);
    noSet.unmount();
    const closed = mount(<AppraisalScoreScreen route={ROUTE} />, appraisalClient(world({ lifecycle: lifecycle('PIPELINE', appraisal({ can_record: false })) })), { permissions: APPRAISER, path: OPEN });
    expect((await screen.findByTestId('not-appraisal')).textContent).toBe(vi_['prj.score.notAppraisal.notice']);
    closed.unmount();
  });

  it('denies a caller without the permission or without an appraisal block, and a read-only session', async () => {
    const reader = mount(<AppraisalScoreScreen route={ROUTE} />, appraisalClient(world()), { permissions: ['project.read'], path: OPEN });
    expect((await screen.findByTestId('denied')).textContent).toBe(vi_['prj.score.denied.notice']);
    reader.unmount();
    const none = mount(<AppraisalScoreScreen route={ROUTE} />, appraisalClient(world({ lifecycle: lifecycle('APPRAISAL', null) })), { permissions: APPRAISER, path: OPEN });
    expect((await screen.findByTestId('denied')).textContent).toBe(vi_['prj.score.denied.notice']);
    none.unmount();
    mount(<AppraisalScoreScreen route={ROUTE} />, appraisalClient(world()), { permissions: APPRAISER, mode: 'READ_ONLY', path: OPEN });
    expect((await screen.findByTestId('read-only')).textContent).toBe(vi_['prj.score.readOnly.frozen.notice']);
    expect(screen.queryByTestId('grid')).toBeNull();
  });

  it('says so when no project is named or the lifecycle cannot be read, and retries', async () => {
    const first = mount(<AppraisalScoreScreen route={ROUTE} />, appraisalClient(world()), { permissions: APPRAISER, path: '/prj/prj-15' });
    expect((await screen.findByTestId('no-project')).textContent).toBe(vi_['prj.score.noProject.notice']);
    first.unmount();
    const state = world({ failing: new Set(['getProjectLifecycle']) });
    mount(<AppraisalScoreScreen route={ROUTE} />, appraisalClient(state), { permissions: APPRAISER, path: OPEN });
    const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
    state.failing = new Set();
    await userEvent.setup().click(retry);
    await waitFor(() => expect(screen.getByTestId('grid')).toBeTruthy());
  });

  it('keeps the set of an older round in view with the weights it was scored by, and links to the decision', async () => {
    const older = criteriaSet({ key: 'APPR-CRIT-2025', awaiting_confirmation: false, cxn: null, legal_basis: '', criteria: [{ code: 'C1', name: 'Only', weight: '100' }] });
    mount(<AppraisalScoreScreen route={ROUTE} />, appraisalClient(world({ lifecycle: lifecycle('APPRAISAL', appraisal({ criteria_set: older })) })), { permissions: APPRAISER, path: OPEN });
    await grid();
    expect(screen.queryByTestId('set-awaiting')).toBeNull();
    expect(document.querySelectorAll('[data-criterion]')).toHaveLength(1);
    expect(within(screen.getByTestId('appraisal-links')).getByRole('link').getAttribute('href')).toBe(`/prj/prj-10?id=${PROJECT_ID}`);
  });
});
