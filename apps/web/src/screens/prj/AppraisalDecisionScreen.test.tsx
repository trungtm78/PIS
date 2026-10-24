import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import AppraisalDecisionScreen from './AppraisalDecisionScreen';
import { DOCUMENT, OTHER_SHEET_ID, PROJECT_ID, SHEET_ID, appraisal, appraisalClient, lifecycle, mount, routeOf, sheet, world } from './appraisal-test-support';

const ROUTE = routeOf('PRJ-10', 'FR-PRJ-10');
const DECIDER = ['project.read', 'project.appraisal.decide'];
const OPEN = `/prj/prj-10?id=${PROJECT_ID}`;
const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const OK = { operation_id: 'o', status: 'DECIDED', resource_version: 2, resource_id: SHEET_ID };

afterEach(cleanup);

const deciding = (overrides: Record<string, unknown> = {}) =>
  appraisal({
    can_record: false,
    can_decide: true,
    sheets: [sheet(SHEET_ID, [4, 3, 5, 2, 4]), sheet(OTHER_SHEET_ID, [4, 3, 4, 3, 4], { total_score: '72.00', appraiser: { membership_id: 'x', display_name: 'Lê Văn Cường' }, note: 'Needs the land plan' })],
    summary: { sheet_count: 2, mean_score: '72.50', threshold_recommendation: 'ADMIT', override_required: { ADMIT: false, REJECT: true, RETURN: true } },
    decision_target: { id: SHEET_ID, version: 1 },
    ...overrides,
  });
const worldOf = (block: Record<string, unknown> | null = deciding(), status = 'APPRAISAL') => world({ lifecycle: lifecycle(status, block) });
const ready = () => screen.findByTestId('sheets');
const choose = (decision: string): void => {
  fireEvent.click(within(document.querySelector(`[data-decision="${decision}"]`) as HTMLElement).getByRole('radio'));
};
const fill = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const record = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['prj.decision.submit.action'] }));
};

describe('AppraisalDecisionScreen (PRJ-10): the decision on the appraisal of a project', () => {
  it('UI-PRJ-10: shows every sheet of the round with its total, recommendation and opinion, the mean and what the threshold recommends', async () => {
    mount(<AppraisalDecisionScreen route={ROUTE} />, appraisalClient(worldOf()), { permissions: DECIDER, path: OPEN });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['prj.decision.page.title']);
    const rows = Array.from(document.querySelectorAll('[data-sheet]')).map((row) => Array.from(row.children).map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['Trần Thị Bình', '73.00', vi_['prj.appraisal.recommendation.admit.label'], vi_['prj.appraisal.status.submitted.label'], vi_['prj.decision.sheets.noNote']],
      ['Lê Văn Cường', '72.00', vi_['prj.appraisal.recommendation.admit.label'], vi_['prj.appraisal.status.submitted.label'], 'Needs the land plan'],
    ]);
    expect(screen.getByTestId('mean').textContent).toBe('72.50');
    expect(screen.getByTestId('threshold-recommendation').textContent).toBe(vi_['prj.appraisal.recommendation.admit.label']);
    expect(screen.getByTestId('set-awaiting').textContent).toContain('ASSUMPTION-APPRAISAL-60');
    expect(within(screen.getByTestId('appraisal-links')).getByRole('link').getAttribute('href')).toBe(`/prj/prj-15?id=${PROJECT_ID}`);
  });

  it('AC-ST-PRJ-003-3: marks the decisions that go against the sheets, and asks for the reason of the override only for them', async () => {
    mount(<AppraisalDecisionScreen route={ROUTE} />, appraisalClient(worldOf()), { permissions: DECIDER, path: OPEN });
    await ready();
    expect(within(document.querySelector('[data-decision="REJECT"]') as HTMLElement).getByText(vi_['prj.decision.override.badge'].trim())).toBeTruthy();
    expect(within(document.querySelector('[data-decision="ADMIT"]') as HTMLElement).queryByText(vi_['prj.decision.override.badge'].trim())).toBeNull();
    choose('ADMIT');
    expect(screen.queryByLabelText(vi_['prj.decision.overrideReason.label'])).toBeNull();
    expect(screen.getByLabelText(vi_['prj.decision.group.label'])).toBeTruthy();
    choose('REJECT');
    expect(screen.getByLabelText(vi_['prj.decision.overrideReason.label'])).toBeTruthy();
    expect(screen.queryByLabelText(vi_['prj.decision.group.label'])).toBeNull();
  });

  it('AC-ST-PRJ-003-4: asks for the group and the document before an admission, and for a real override reason before a contrary decision', async () => {
    const h = appraisalClient(worldOf(), () => OK);
    mount(<AppraisalDecisionScreen route={ROUTE} />, h, { permissions: DECIDER, path: OPEN });
    await ready();
    record();
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(expect.arrayContaining([vi_['prj.appraisal.field.required.error']]));
    choose('ADMIT');
    fill(vi_['prj.decision.reason.label'], 'Admit the project');
    record();
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    choose('REJECT');
    fill(vi_['prj.decision.overrideReason.label'], 'too short');
    record();
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['prj.appraisal.field.overrideShort.error']);
  });

  it('AC-ST-PRJ-003-2: admits the project in a group with the document, under the version of the sheet, and says where it went', async () => {
    const h = appraisalClient(worldOf(), () => OK);
    mount(<AppraisalDecisionScreen route={ROUTE} />, h, { permissions: DECIDER, path: OPEN });
    await ready();
    choose('ADMIT');
    fill(vi_['prj.decision.reason.label'], 'Admit the project');
    fill(vi_['prj.decision.document.label'], DOCUMENT.toUpperCase());
    fill(vi_['prj.decision.group.label'], 'B');
    record();
    const done = await screen.findByTestId('decided');
    expect(h.command).toHaveBeenCalledWith(
      'decideProjectAppraisal',
      expect.objectContaining({ path: { id: SHEET_ID }, ifMatchVersion: 1, body: { decision: 'ADMIT', reason: 'Admit the project', decision_document_id: DOCUMENT, project_group: 'B' } }),
    );
    expect(done.textContent).toContain(vi_['prj.decision.done.text'].replace('{decision}', vi_['prj.appraisal.recommendation.admit.label']));
    expect(within(done).getByRole('link', { name: vi_['prj.decision.done.board.link'] }).getAttribute('href')).toBe('/prj/prj-14');
    expect(screen.queryByRole('button', { name: vi_['prj.decision.submit.action'] })).toBeNull();
  });

  it('AC-ST-PRJ-003-2: keeps the notice of the decision when the read moves the project out of the appraisal under it', async () => {
    const state = worldOf();
    const h = appraisalClient(state, () => {
      state.lifecycle = lifecycle('PIPELINE', deciding({ can_decide: false, decision_target: null, sheets: [sheet(SHEET_ID, [4, 3, 5, 2, 4], { status: 'DECIDED', decision: 'ADMIT' })] }));
      return OK;
    });
    mount(<AppraisalDecisionScreen route={ROUTE} />, h, { permissions: DECIDER, path: OPEN });
    await ready();
    choose('ADMIT');
    fill(vi_['prj.decision.reason.label'], 'Admit the project');
    fill(vi_['prj.decision.document.label'], DOCUMENT);
    fill(vi_['prj.decision.group.label'], 'B');
    record();
    await screen.findByTestId('decided');
    await waitFor(() => expect(screen.getByTestId('sheets').textContent).toContain(vi_['prj.appraisal.status.decided.label']));
    expect(screen.getByTestId('decided')).toBeTruthy();
    expect(screen.queryByTestId('not-appraisal')).toBeNull();
  });

  it('AC-ST-PRJ-003-3: a contrary decision carries its override reason, a decision that follows the sheets does not', async () => {
    const h = appraisalClient(worldOf(), () => OK);
    mount(<AppraisalDecisionScreen route={ROUTE} />, h, { permissions: DECIDER, path: OPEN });
    await ready();
    choose('RETURN');
    fill(vi_['prj.decision.reason.label'], 'Complete the land plan');
    fill(vi_['prj.decision.overrideReason.label'], 'The land clearance plan is missing');
    record();
    await screen.findByTestId('decided');
    expect(h.command).toHaveBeenCalledWith(
      'decideProjectAppraisal',
      expect.objectContaining({ body: { decision: 'RETURN', reason: 'Complete the land plan', override_reason: 'The land clearance plan is missing' } }),
    );
  });

  it('AC-ST-PRJ-003-3: says why the server refused the decision: the proposer, the group, the override, a draft sheet, the version', async () => {
    const cases: Array<[string, number, string]> = [
      ['SELF_APPROVAL_DENIED', 403, 'prj.appraisal.problem.selfApproval.error'],
      ['PROJECT_GROUP_REQUIRED', 422, 'prj.appraisal.problem.groupRequired.error'],
      ['OVERRIDE_REASON_REQUIRED', 422, 'prj.appraisal.problem.overrideRequired.error'],
      ['APPRAISAL_INCOMPLETE', 422, 'prj.appraisal.problem.incomplete.error'],
      ['VERSION_CONFLICT', 409, 'prj.appraisal.problem.versionConflict.error'],
      ['SCOPE_DENIED', 403, 'prj.appraisal.problem.denied.error'],
      ['RESOURCE_NOT_FOUND', 404, 'prj.appraisal.problem.notFound.error'],
    ];
    for (const [code, status, key] of cases) {
      const h = appraisalClient(worldOf(), () => problem(code, status));
      const view = mount(<AppraisalDecisionScreen route={ROUTE} />, h, { permissions: DECIDER, path: OPEN });
      await ready();
      choose('ADMIT');
      fill(vi_['prj.decision.reason.label'], 'Admit the project');
      fill(vi_['prj.decision.document.label'], DOCUMENT);
      fill(vi_['prj.decision.group.label'], 'C');
      record();
      expect((await screen.findByTestId('problem')).textContent).toBe(vi_[key as keyof typeof vi_]);
      view.unmount();
    }
  });

  it('AC-ST-PRJ-003-3: tells the proposer they cannot decide, and offers nothing when there is no sheet or no open round', async () => {
    const proposer = mount(<AppraisalDecisionScreen route={ROUTE} />, appraisalClient(worldOf(deciding({ viewer_is_proposer: true, can_decide: false }))), { permissions: DECIDER, path: OPEN });
    expect((await screen.findByTestId('proposer')).textContent).toBe(vi_['prj.decision.proposer.notice']);
    expect(screen.queryByRole('button', { name: vi_['prj.decision.submit.action'] })).toBeNull();
    proposer.unmount();
    const empty = mount(<AppraisalDecisionScreen route={ROUTE} />, appraisalClient(worldOf(deciding({ sheets: [], summary: { sheet_count: 0, mean_score: null, threshold_recommendation: null, override_required: null }, decision_target: null }))), {
      permissions: DECIDER,
      path: OPEN,
    });
    expect((await screen.findByTestId('no-sheets')).textContent).toBe(vi_['prj.decision.noSheets.notice']);
    expect(screen.getByTestId('no-sheets-list').textContent).toBe(vi_['prj.decision.sheets.empty']);
    expect(screen.getByTestId('no-summary').textContent).toBe(vi_['prj.decision.summary.none']);
    empty.unmount();
    const decided = mount(<AppraisalDecisionScreen route={ROUTE} />, appraisalClient(worldOf(deciding({ can_decide: false, decision_target: null, sheets: [sheet(SHEET_ID, [4, 3, 5, 2, 4], { status: 'DECIDED', decision: 'ADMIT' })] }), 'PIPELINE')), {
      permissions: DECIDER,
      path: OPEN,
    });
    expect((await screen.findByTestId('not-appraisal')).textContent).toBe(vi_['prj.decision.notAppraisal.notice'].replace('{stage}', vi_['prj.stage.pipeline.label']));
    expect(screen.getByTestId('sheets').textContent).toContain(vi_['prj.appraisal.status.decided.label']);
    decided.unmount();
  });

  it('denies a caller without the permission or without an appraisal block, and a read-only session', async () => {
    const reader = mount(<AppraisalDecisionScreen route={ROUTE} />, appraisalClient(worldOf()), { permissions: ['project.read'], path: OPEN });
    expect((await screen.findByTestId('denied')).textContent).toBe(vi_['prj.decision.denied.notice']);
    reader.unmount();
    const none = mount(<AppraisalDecisionScreen route={ROUTE} />, appraisalClient(worldOf(null)), { permissions: DECIDER, path: OPEN });
    expect((await screen.findByTestId('denied')).textContent).toBe(vi_['prj.decision.denied.notice']);
    none.unmount();
    mount(<AppraisalDecisionScreen route={ROUTE} />, appraisalClient(worldOf()), { permissions: DECIDER, mode: 'READ_ONLY', path: OPEN });
    expect((await screen.findByTestId('read-only')).textContent).toBe(vi_['prj.decision.readOnly.frozen.notice']);
    expect(screen.getByTestId('sheets')).toBeTruthy();
  });

  it('says so when no project is named or the lifecycle cannot be read, and retries; a sheet without a name for its appraiser is unknown', async () => {
    const first = mount(<AppraisalDecisionScreen route={ROUTE} />, appraisalClient(worldOf()), { permissions: DECIDER, path: '/prj/prj-10' });
    expect((await screen.findByTestId('no-project')).textContent).toBe(vi_['prj.decision.noProject.notice']);
    first.unmount();
    const state = world({ failing: new Set(['getProjectLifecycle']) });
    const second = mount(<AppraisalDecisionScreen route={ROUTE} />, appraisalClient(state), { permissions: DECIDER, path: OPEN });
    const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
    state.failing = new Set();
    state.lifecycle = lifecycle('APPRAISAL', deciding({ sheets: [sheet(SHEET_ID, [4, 3, 5, 2, 4], { appraiser: { membership_id: 'x', display_name: null } })] }));
    await userEvent.setup().click(retry);
    await waitFor(() => expect(screen.getByTestId('sheets')).toBeTruthy());
    expect(screen.getByTestId('sheets').textContent).toContain(vi_['prj.decision.sheets.unknown']);
    second.unmount();
  });
});
