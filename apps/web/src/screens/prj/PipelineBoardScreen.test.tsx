import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import PipelineBoardScreen from './PipelineBoardScreen';
import { DOCUMENT, boardClient, boardWorld, card, historyLine, lifecycle, mount, move, routeOf } from './pipeline-test-support';

const ROUTE = routeOf('PRJ-14', 'FR-PRJ-14');
const MANAGER = ['project.read', 'project.stage.implement', 'project.stage.suspend', 'project.stage.complete', 'project.stage.close', 'project.stage.cancel'];
const READER = ['project.read'];
const problem = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const stageText = (stage: string): string => vi_[`prj.stage.${stage.toLowerCase()}.label` as keyof typeof vi_];

afterEach(cleanup);

const column = (stage: string): HTMLElement => document.querySelector(`[data-stage="${stage}"]`) as HTMLElement;
const columnReady = (stage: string) => waitFor(() => expect(within(column(stage)).queryByText(vi_['prj.board.column.loading'])).toBeNull());
const openMove = async (code: string) => {
  fireEvent.click(await screen.findByRole('button', { name: vi_['prj.board.card.move.aria'].replace('{code}', code) }));
  await screen.findByRole('dialog');
};

/** A board with a funded project in the pipeline, one waiting for its code in the budget and one running. */
function threeStages() {
  const waiting = card(1, { status: 'PIPELINE' });
  const budgeted = card(2, { status: 'BUDGETED', national_project_code: null, capital_ready: null });
  const running = card(3, { status: 'IMPLEMENTATION', capital_ready: null, leader_in_charge: { membership_id: 'm', display_name: 'Nguyễn Văn An' } });
  return boardWorld({
    columns: { PIPELINE: [waiting], BUDGETED: [budgeted], IMPLEMENTATION: [running] },
    lifecycles: {
      [budgeted.id]: lifecycle(
        2,
        'BUDGETED',
        [
          move('startProjectImplementation', 'IMPLEMENTATION', [['INVESTMENT_DECISION_DOCUMENT', 'INPUT_REQUIRED'], ['NATIONAL_CODE', 'UNMET']]),
          move('cancelProject', 'CANCELLED', [['DECISION_DOCUMENT', 'INPUT_REQUIRED'], ['OPEN_OBLIGATIONS', 'MET']]),
        ],
        [historyLine('PIPELINE', 'BUDGETED', 'SYSTEM', null)],
      ),
      [running.id]: lifecycle(
        3,
        'IMPLEMENTATION',
        [move('suspendProject', 'SUSPENDED', [['DECISION_DOCUMENT', 'INPUT_REQUIRED']]), move('completeProject', 'COMPLETED', [['DECISION_DOCUMENT', 'INPUT_REQUIRED']])],
        [historyLine('BUDGETED', 'IMPLEMENTATION', 'USER', 'Trần Thị Bình')],
      ),
      [waiting.id]: lifecycle(1, 'PIPELINE', [move('cancelProject', 'CANCELLED', [['DECISION_DOCUMENT', 'INPUT_REQUIRED'], ['OPEN_OBLIGATIONS', 'WARNING']])]),
    },
  });
}

describe('PipelineBoardScreen (PRJ-14): the project bank as a board of the PIMA stages', () => {
  it('shows a column for each open stage with the cards of the stage, the count, the group, the score, the amount and the leader (UI-PRJ-14)', async () => {
    const h = boardClient(threeStages());
    mount(<PipelineBoardScreen route={ROUTE} />, h, { permissions: MANAGER });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['prj.board.page.title']);
    const stages = Array.from(document.querySelectorAll('[data-stage]')).map((element) => element.getAttribute('data-stage'));
    expect(stages).toEqual(['CONCEPT', 'APPRAISAL', 'PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED', 'SETTLED']);
    await columnReady('IMPLEMENTATION');
    await columnReady('PIPELINE');
    expect(within(column('PIPELINE')).getByTestId('column-count').textContent).toBe('1 dự án');
    const running = within(column('IMPLEMENTATION'));
    expect(running.getByRole('link', { name: 'DA-2026-003' })).toBeTruthy();
    expect(running.getByText('Dự án số 3')).toBeTruthy();
    expect(running.getByText('Nguyễn Văn An')).toBeTruthy();
    expect(running.getByText('72.50')).toBeTruthy();
    expect(running.getByText(/500\.000\.000\.000|500,000,000,000/)).toBeTruthy();
    await columnReady('CONCEPT');
    expect(within(column('CONCEPT')).getByTestId('column-empty').textContent).toBe(vi_['prj.board.column.empty']);
    // The three stages that end a project's life are not read until they are asked for.
    expect(column('CLOSED')).toBeNull();
    const stagesRead = h.read.mock.calls.map((call) => (call[1] as { query: { stage: string } }).query.stage);
    expect(stagesRead).not.toContain('CLOSED');
  });

  it('disables drag and drop and says why: nothing on a card can be dragged, a move goes through the button (AC-ST-PRJ-002-4)', async () => {
    mount(<PipelineBoardScreen route={ROUTE} />, boardClient(threeStages()), { permissions: MANAGER });
    expect(screen.getByTestId('drag-disabled').textContent).toBe(vi_['prj.board.dragDisabled.notice']);
    await columnReady('PIPELINE');
    expect(document.querySelectorAll('[draggable="true"]')).toHaveLength(0);
    expect(document.querySelector('.prj-card')?.getAttribute('draggable')).toBeNull();
  });

  it('marks the project without a national code with the badge, and a pipeline project with whether it is ready for capital', async () => {
    const state = threeStages();
    state.columns.PIPELINE = [card(1, { capital_ready: true }), card(4, { capital_ready: false, national_project_code: null })];
    mount(<PipelineBoardScreen route={ROUTE} />, boardClient(state), { permissions: MANAGER });
    await columnReady('BUDGETED');
    await columnReady('PIPELINE');
    expect(within(column('BUDGETED')).getByTestId('national-code-missing').textContent).toBe(vi_['prj.nationalCode.missing.badge']);
    expect(within(column('PIPELINE')).getAllByTestId('capital-ready').map((badge) => badge.textContent)).toEqual([vi_['prj.board.card.ready.badge'], vi_['prj.board.card.notReady.badge']]);
    expect(within(column('IMPLEMENTATION')).queryByTestId('capital-ready')).toBeNull();
    expect(within(column('PIPELINE')).getByTestId('national-code').textContent).toBe('7654321');
  });

  it('filters every column by group, and reads the columns again for the group', async () => {
    const state = threeStages();
    state.columns.PIPELINE = [card(1, { project_group: 'A' }), card(4, { project_group: 'C' })];
    const h = boardClient(state);
    mount(<PipelineBoardScreen route={ROUTE} />, h, { permissions: MANAGER });
    await columnReady('PIPELINE');
    expect(within(column('PIPELINE')).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText(vi_['prj.board.group.label']), { target: { value: 'C' } });
    await waitFor(() => expect(within(column('PIPELINE')).getAllByRole('listitem')).toHaveLength(1));
    expect(within(column('PIPELINE')).getByRole('link', { name: 'DA-2026-004' })).toBeTruthy();
    expect(h.read.mock.calls.some((call) => (call[1] as { query: Record<string, string> }).query.project_group === 'C')).toBe(true);
  });

  it('shows the ended stages on request, and pages a column with its cursor', async () => {
    const state = threeStages();
    state.columns.CLOSED = [card(9, { status: 'CLOSED' })];
    state.columns.PIPELINE = [card(1), card(4), card(5)];
    state.pageSize = 2;
    mount(<PipelineBoardScreen route={ROUTE} />, boardClient(state), { permissions: MANAGER });
    await columnReady('PIPELINE');
    expect(within(column('PIPELINE')).getAllByRole('listitem')).toHaveLength(2);
    expect(within(column('PIPELINE')).getByTestId('column-count').textContent).toBe('3 dự án');
    fireEvent.click(within(column('PIPELINE')).getByRole('button', { name: vi_['prj.board.column.more'] }));
    await waitFor(() => expect(within(column('PIPELINE')).getAllByRole('listitem')).toHaveLength(3));
    expect(within(column('PIPELINE')).queryByRole('button', { name: vi_['prj.board.column.more'] })).toBeNull();
    fireEvent.click(screen.getByLabelText(vi_['prj.board.ended.toggle']));
    await columnReady('CLOSED');
    expect(within(column('CLOSED')).getByRole('link', { name: 'DA-2026-009' })).toBeTruthy();
    // A project that has ended offers no move.
    expect(within(column('CLOSED')).queryByRole('button', { name: /./ })).toBeNull();
  });

  it('says so in the column that cannot be read and reads it again on request', async () => {
    const state = threeStages();
    state.failingStages.add('PIPELINE');
    mount(<PipelineBoardScreen route={ROUTE} />, boardClient(state), { permissions: MANAGER });
    const failed = await within(column('PIPELINE')).findByRole('alert');
    expect(failed.textContent).toContain(vi_['prj.board.column.error']);
    await columnReady('BUDGETED');
    expect(within(column('BUDGETED')).getAllByRole('listitem')).toHaveLength(1);
    state.failingStages.clear();
    fireEvent.click(within(failed).getByRole('button', { name: vi_['prj.board.column.retry'] }));
    await waitFor(() => expect(within(column('PIPELINE')).getAllByRole('listitem')).toHaveLength(1));
  });

  it('is the standard card of a refusal, with no column, when the server refuses the read of the bank', async () => {
    mount(<PipelineBoardScreen route={ROUTE} />, boardClient(boardWorld({ denied: true })), { permissions: READER });
    expect((await screen.findByText(vi_['states.denied.title'])).textContent).toBe(vi_['states.denied.title']);
    expect(document.querySelectorAll('[data-stage]')).toHaveLength(0);
  });

  describe('the confirmation of a move', () => {
    it('names the guard that is not met instead of moving the project, and sends nothing (AC-ST-PRJ-002-4)', async () => {
      const h = boardClient(threeStages());
      mount(<PipelineBoardScreen route={ROUTE} />, h, { permissions: MANAGER });
      await openMove('DA-2026-002');
      const dialog = within(await screen.findByRole('dialog'));
      expect(dialog.getByText(vi_['prj.board.dialog.title'].replace('{code}', 'DA-2026-002'))).toBeTruthy();
      expect((await dialog.findByTestId('current-stage')).textContent).toBe(vi_['prj.board.dialog.current.text'].replace('{stage}', stageText('BUDGETED')));
      const guards = dialog.getByTestId('guards');
      expect(within(guards).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
        `${vi_['prj.guard.investmentDecision.label']}: ${vi_['prj.guard.input.state']}`,
        `${vi_['prj.guard.nationalCode.label']}: ${vi_['prj.guard.unmet.state']}`,
      ]);
      expect(dialog.getByTestId('unmet').textContent).toContain(vi_['prj.guard.nationalCode.label']);
      const confirm = dialog.getByRole('button', { name: vi_['prj.board.dialog.confirm.action'] }) as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
      fireEvent.click(confirm);
      fireEvent.submit(dialog.getByRole('button', { name: vi_['prj.board.dialog.confirm.action'] }).closest('form') as HTMLFormElement);
      expect(h.command).not.toHaveBeenCalled();
      // The history of the stage is in the same box: the system moved the project to this stage.
      expect(dialog.getByTestId('history').textContent).toContain(vi_['prj.board.dialog.history.system']);
    });

    it('offers the other moves of the stage and names their guards in turn', async () => {
      mount(<PipelineBoardScreen route={ROUTE} />, boardClient(threeStages()), { permissions: MANAGER });
      await openMove('DA-2026-002');
      const dialog = within(await screen.findByRole('dialog'));
      await dialog.findByTestId('guards');
      expect(dialog.getAllByRole('radio').map((radio) => radio.closest('label')?.textContent)).toEqual([
        `${vi_['prj.move.start.label']} (sang giai đoạn ${stageText('IMPLEMENTATION')})`,
        `${vi_['prj.move.cancel.label']} (sang giai đoạn ${stageText('CANCELLED')})`,
      ]);
      fireEvent.click(dialog.getAllByRole('radio')[1] as HTMLElement);
      expect(within(dialog.getByTestId('guards')).getAllByRole('listitem').map((item) => item.getAttribute('data-state'))).toEqual(['INPUT_REQUIRED', 'MET']);
      expect(dialog.queryByTestId('unmet')).toBeNull();
      expect((dialog.getByRole('button', { name: vi_['prj.board.dialog.confirm.action'] }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('sends the move against the version it read, with the reason and the document, then closes and reads the board again (AC-ST-PRJ-002-4)', async () => {
      const state = threeStages();
      const h = boardClient(state, () => ({ operation_id: 'o', status: 'SUSPENDED', resource_version: 4, resource_id: card(3).id }));
      mount(<PipelineBoardScreen route={ROUTE} />, h, { permissions: MANAGER });
      await openMove('DA-2026-003');
      const dialog = within(await screen.findByRole('dialog'));
      await dialog.findByTestId('guards');
      expect(dialog.getByTestId('history').textContent).toContain('Trần Thị Bình');
      fireEvent.change(dialog.getByLabelText(vi_['prj.board.dialog.reason.label']), { target: { value: '  Flood season stops the works  ' } });
      fireEvent.change(dialog.getByLabelText(vi_['prj.guard.decision.field']), { target: { value: DOCUMENT.toUpperCase() } });
      fireEvent.change(dialog.getByLabelText(vi_['prj.board.dialog.date.label']), { target: { value: '2026-11-01' } });
      const readsBefore = h.read.mock.calls.length;
      fireEvent.click(dialog.getByRole('button', { name: vi_['prj.board.dialog.confirm.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      const [operation, input] = h.command.mock.calls[0] as [string, { path: { id: string }; body: Record<string, unknown>; ifMatchVersion: number }];
      expect(operation).toBe('suspendProject');
      expect(input.path).toEqual({ id: card(3).id });
      expect(input.ifMatchVersion).toBe(3);
      expect(input.body).toEqual({ reason: 'Flood season stops the works', decision_document_id: DOCUMENT, effective_date: '2026-11-01' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(readsBefore));
    });

    it('sends the cancellation, whose document and obligations the server judges, as the command of its own', async () => {
      const h = boardClient(threeStages(), () => ({ status: 'CANCELLED' }));
      mount(<PipelineBoardScreen route={ROUTE} />, h, { permissions: MANAGER });
      await openMove('DA-2026-002');
      const dialog = within(await screen.findByRole('dialog'));
      await dialog.findByTestId('guards');
      fireEvent.click(dialog.getAllByRole('radio')[1] as HTMLElement);
      fireEvent.change(dialog.getByLabelText(vi_['prj.board.dialog.reason.label']), { target: { value: 'The project is dropped' } });
      fireEvent.change(dialog.getByLabelText(vi_['prj.guard.decision.field']), { target: { value: DOCUMENT } });
      fireEvent.click(dialog.getByRole('button', { name: vi_['prj.board.dialog.confirm.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('cancelProject');
      expect((h.command.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({ reason: 'The project is dropped', decision_document_id: DOCUMENT });
    });

    it('names what is missing in the form and sends nothing', async () => {
      const h = boardClient(threeStages());
      mount(<PipelineBoardScreen route={ROUTE} />, h, { permissions: MANAGER });
      await openMove('DA-2026-003');
      const dialog = within(await screen.findByRole('dialog'));
      await dialog.findByTestId('guards');
      fireEvent.click(dialog.getByRole('button', { name: vi_['prj.board.dialog.confirm.action'] }));
      expect(dialog.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(expect.arrayContaining([vi_['prj.board.reasonRequired.error'], vi_['prj.board.documentRequired.error']]));
      fireEvent.change(dialog.getByLabelText(vi_['prj.board.dialog.reason.label']), { target: { value: 'abc' } });
      fireEvent.change(dialog.getByLabelText(vi_['prj.guard.decision.field']), { target: { value: 'not a uuid' } });
      fireEvent.click(dialog.getByRole('button', { name: vi_['prj.board.dialog.confirm.action'] }));
      expect(dialog.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(expect.arrayContaining([vi_['prj.board.reasonShort.error'], vi_['prj.board.documentInvalid.error']]));
      expect(h.command).not.toHaveBeenCalled();
    });

    it('tells the refusal of the server in the box and keeps the box open', async () => {
      const refusals: Array<[string, string]> = [
        ['OPEN_OBLIGATIONS_EXIST', 'prj.stageProblem.openObligations.error'],
        ['STAGE_TRANSITION_DENIED', 'prj.stageProblem.transitionDenied.error'],
        ['VERSION_CONFLICT', 'prj.problem.versionConflict.error'],
      ];
      for (const [code, key] of refusals) {
        const h = boardClient(threeStages(), () => problem(code));
        const view = mount(<PipelineBoardScreen route={ROUTE} />, h, { permissions: MANAGER });
        await openMove('DA-2026-003');
        const dialog = within(await screen.findByRole('dialog'));
        await dialog.findByTestId('guards');
        fireEvent.change(dialog.getByLabelText(vi_['prj.board.dialog.reason.label']), { target: { value: 'Flood season' } });
        fireEvent.change(dialog.getByLabelText(vi_['prj.guard.decision.field']), { target: { value: DOCUMENT } });
        fireEvent.click(dialog.getByRole('button', { name: vi_['prj.board.dialog.confirm.action'] }));
        expect((await dialog.findByTestId('refusal')).textContent).toBe(vi_[key as keyof typeof vi_]);
        expect(screen.getByRole('dialog')).toBeTruthy();
        view.unmount();
      }
    });

    it('offers only the moves the caller may make, says so when there is none, and closes with Escape and with the cancel button', async () => {
      const state = threeStages();
      state.lifecycles[card(3).id] = lifecycle(3, 'IMPLEMENTATION', [move('suspendProject', 'SUSPENDED', [['DECISION_DOCUMENT', 'INPUT_REQUIRED']], false), move('completeProject', 'COMPLETED', [['DECISION_DOCUMENT', 'INPUT_REQUIRED']], true)]);
      state.lifecycles[card(2).id] = lifecycle(2, 'BUDGETED', [move('cancelProject', 'CANCELLED', [], false)]);
      mount(<PipelineBoardScreen route={ROUTE} />, boardClient(state), { permissions: MANAGER });
      await openMove('DA-2026-003');
      const dialog = within(await screen.findByRole('dialog'));
      await dialog.findByTestId('guards');
      expect(dialog.getAllByRole('radio')).toHaveLength(1);
      expect(dialog.getByText(new RegExp(vi_['prj.move.complete.label']))).toBeTruthy();
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await openMove('DA-2026-002');
      expect((await screen.findByTestId('no-moves')).textContent).toBe(vi_['prj.board.dialog.noMoves.notice']);
      expect((screen.getByRole('button', { name: vi_['prj.board.dialog.confirm.action'] }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: vi_['prj.board.dialog.cancel.action'] }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('says when the lifecycle cannot be read, and shows the history of a project that has none', async () => {
      const state = threeStages();
      delete state.lifecycles[card(2).id];
      mount(<PipelineBoardScreen route={ROUTE} />, boardClient(state), { permissions: MANAGER });
      await openMove('DA-2026-002');
      expect((await screen.findByText(vi_['prj.board.dialog.error.notice'])).getAttribute('role')).toBe('alert');
      fireEvent.click(screen.getByRole('button', { name: vi_['prj.board.dialog.close.label'] }));
      await openMove('DA-2026-001');
      await screen.findByTestId('guards');
      expect(screen.getByTestId('no-history').textContent).toBe(vi_['prj.board.dialog.history.empty']);
      expect(screen.getByTestId('warned').textContent).toContain(vi_['prj.guard.openObligations.label']);
    });
  });

  describe('who sees the buttons', () => {
    it('shows no button of change to a caller without a stage permission, nor to a session that is read-only', async () => {
      mount(<PipelineBoardScreen route={ROUTE} />, boardClient(threeStages()), { permissions: READER });
      await columnReady('PIPELINE');
      expect(screen.queryByRole('button', { name: vi_['prj.board.card.move.action'] })).toBeNull();
      cleanup();
      mount(<PipelineBoardScreen route={ROUTE} />, boardClient(threeStages()), { permissions: MANAGER, mode: 'READ_ONLY' });
      await columnReady('PIPELINE');
      expect(within(column('PIPELINE')).getByRole('link', { name: 'DA-2026-001' })).toBeTruthy();
      expect(screen.queryAllByRole('button', { name: /./ }).filter((button) => button.textContent === vi_['prj.board.card.move.action'])).toHaveLength(0);
    });

    it('shows the button to a caller who holds one stage permission', async () => {
      mount(<PipelineBoardScreen route={ROUTE} />, boardClient(threeStages()), { permissions: ['project.read', 'project.stage.cancel'] });
      await columnReady('PIPELINE');
      expect(screen.getAllByRole('button', { name: new RegExp(vi_['prj.board.card.move.action']) }).length).toBeGreaterThan(0);
    });
  });
});
