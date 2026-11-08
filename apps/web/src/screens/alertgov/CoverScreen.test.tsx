import { ApiError } from '@machvon/api-client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as translate } from '../../i18n';
import CoverScreen from './CoverScreen';
import { ABSENCE_ID, AS_OF, COVER_ID, DEPUTY, HEALTH_READER, MANAGER, ME, OTHER, READER, absenceRow, client, coverRow, coverageDto, failing, mount, route, rule, world } from './test-support';
import type { World } from './test-support';

const ROUTE = route('ADM-28', 'FR-ADM-28', 'ADM');
const text = (key: string, params: Record<string, string | number> = {}): string => translate(key, params);
const OTHER_ABSENCE = '00000000-0000-4000-8000-00000000a002';
const iso = (local: string): string => new Date(`${local}:00+07:00`).toISOString();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, permissions: readonly string[] | undefined = MANAGER) {
  const h = client(state);
  const view = mount(<CoverScreen route={ROUTE} />, h, { permissions, path: '/adm/adm-28' });
  return { h, ...view };
}

const fill = (id: string, value: string): void => {
  fireEvent.change(screen.getByTestId(id), { target: { value } });
};

describe('CoverScreen (ADM-28): absences, deputies and the coverage of who receives', () => {
  it('shows a skeleton while it loads, then my absences, the pending covers, the people I manage and the coverage', async () => {
    const { h } = open(world());
    expect(screen.getByRole('status', { name: text('states.loading.label') })).toBeInTheDocument();
    const mine = await screen.findByTestId(`absence-${ABSENCE_ID}`);
    expect(h.read).toHaveBeenCalledWith('listAlertAbsences', { query: { mine: 'true', state: 'current' } });
    expect(h.read).toHaveBeenCalledWith('listAlertAbsences', { query: { mine: 'false', state: 'current' } });
    expect(mine.textContent).toContain('Tran Van Me');
    expect(mine.textContent).toContain(text('alertgov.absence.kind.leave'));
    expect(mine.textContent).toContain(text('alertgov.coverage.state.uncovered'));
    expect(within(mine).getByTestId('no-covers')).toBeInTheDocument();
    expect(await screen.findByTestId(`pending-${COVER_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId(`absence-${OTHER_ABSENCE}`).textContent).toContain('Le Thi Other');
    expect(await screen.findByTestId('coverage')).toBeInTheDocument();
    expect(h.read).toHaveBeenCalledWith('getAlertCoverageReport', {});
  });

  it('shows the coverage: how many positions have a backup, the positions and each gap open or closed', async () => {
    open(world());
    const coverage = await screen.findByTestId('coverage');
    expect(within(coverage).getByTestId('coverage-summary').textContent).toBe(text('alertgov.cover.report.summary', { backed: 0, total: 2, percent: 0 }));
    expect(coverage.textContent).toContain(text('alertgov.position.state.singlePoint'));
    expect(coverage.textContent).toContain(text('alertgov.position.state.uncovered'));
    const gaps = within(coverage).getByRole('table', { name: text('alertgov.cover.report.gapsCaption') });
    expect(gaps.textContent).toContain(text('alertgov.gap.kind.absentNoCover'));
    expect(gaps.textContent).toContain('Le Thi Other');
    expect(gaps.textContent).toContain(text('alertgov.gap.open.text'));
  });

  it('says there are no positions to compute the coverage from instead of showing 0%', async () => {
    open(world({ coverage: coverageDto({ positions: [], gaps: [], summary: { backed_up: 0, total: 0, percent: null } }) }));
    expect((await screen.findByTestId('coverage-summary')).textContent).toBe(text('alertgov.cover.report.noPositions'));
  });

  it('does not show what a person who may not manage covers should not see: the other people and the pending covers', async () => {
    const { h } = open(world(), READER);
    await screen.findByTestId(`absence-${ABSENCE_ID}`);
    expect(screen.queryByTestId('pending-empty')).toBeNull();
    expect(screen.queryByTestId(`pending-${COVER_ID}`)).toBeNull();
    expect(screen.queryByTestId('declare-member')).toBeNull();
    expect(screen.queryByTestId('coverage')).toBeNull();
    expect(h.read).not.toHaveBeenCalledWith('listAlertAbsences', { query: { mine: 'false', state: 'current' } });
    expect(h.read).not.toHaveBeenCalledWith('getAlertCoverageReport', expect.anything());
  });

  it('shows the coverage to a reader who may read the health, without the means to manage covers', async () => {
    open(world(), HEALTH_READER);
    expect(await screen.findByTestId('coverage')).toBeInTheDocument();
    expect(screen.queryByTestId(`pending-${COVER_ID}`)).toBeNull();
  });

  it('shows a cover with its scope, whether it is in force, and who may revoke it', async () => {
    const cover = coverRow({ status: 'APPROVED', in_force: true, scope_kind: 'SOURCES', sources: ['ISSUE', 'REPORT'] });
    open(world({ mine: { items: [absenceRow({ coverage: 'COVERED', covers: [cover] })], pending_covers: [], rule: rule({ params: {} }), as_of: AS_OF } }));
    const line = await screen.findByTestId(`cover-${COVER_ID}`);
    expect(line.textContent).toContain('Pham Deputy');
    expect(line.textContent).toContain(text('alertgov.cover.status.approved'));
    expect(line.textContent).toContain(text('alertgov.cover.inForce.text'));
    expect(line.textContent).toContain(text('alertgov.cover.scope.sources', { sources: `${text('alerts.source.issue')}, ${text('alerts.source.report')}` }));
    expect(within(line).getByTestId(`revoke-${COVER_ID}`)).toBeInTheDocument();
  });

  it('validates the declaration before sending: both moments, and the end after the start', async () => {
    const { h } = open(world());
    await screen.findByTestId('declare-form');
    await userEvent.click(screen.getByTestId('declare-submit'));
    expect((await screen.findByTestId('declare-error')).textContent).toBe(text('alertgov.cover.declare.window.error'));
    fill('declare-from', '2027-10-20T08:00');
    fill('declare-until', '2027-10-19T08:00');
    await userEvent.click(screen.getByTestId('declare-submit'));
    expect(screen.getByTestId('declare-error')).toBeInTheDocument();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('declares an absence with one command, in Vietnam time, and clears the form', async () => {
    const { h } = open(world(), READER);
    await screen.findByTestId('declare-form');
    await userEvent.selectOptions(screen.getByTestId('declare-kind'), 'MISSION');
    fill('declare-from', '2027-10-20T08:00');
    fill('declare-until', '2027-10-22T17:30');
    await userEvent.type(screen.getByTestId('declare-reason'), '  Site visit  ');
    await userEvent.click(screen.getByTestId('declare-submit'));
    expect(await screen.findByText(text('alertgov.cover.declare.done'))).toBeInTheDocument();
    expect(h.command).toHaveBeenCalledTimes(1);
    const [operation, input] = h.command.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(operation).toBe('declareAlertAbsence');
    expect(input.body).toEqual({ kind: 'MISSION', valid_from: iso('2027-10-20T08:00'), valid_until: iso('2027-10-22T17:30'), reason: 'Site visit' });
    expect(screen.getByTestId('declare-from')).toHaveValue('');
  });

  it('lets a manager declare for somebody else, and sends that person', async () => {
    const { h } = open(world());
    await screen.findByTestId('declare-form');
    await userEvent.selectOptions(await screen.findByTestId('declare-member'), OTHER);
    fill('declare-from', '2027-10-20T08:00');
    fill('declare-until', '2027-10-22T08:00');
    await userEvent.click(screen.getByTestId('declare-submit'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).toMatchObject({ membership_id: OTHER, kind: 'LEAVE' });
  });

  it('says in words that the new absence overlaps another one (409) and lets the message go', async () => {
    const { h } = open(world(), READER);
    await screen.findByTestId('declare-form');
    h.command.mockRejectedValueOnce(new ApiError({ status: 409, code: 'ALERT_ABSENCE_OVERLAP', correlationId: 'c' }));
    fill('declare-from', '2027-10-20T08:00');
    fill('declare-until', '2027-10-22T08:00');
    await userEvent.click(screen.getByTestId('declare-submit'));
    const problem = await screen.findByTestId('problem');
    expect(problem.textContent).toContain(text('alertgov.problem.overlap.text'));
    await userEvent.click(within(problem).getByRole('button', { name: text('alertgov.common.dismiss.action') }));
    expect(screen.queryByTestId('problem')).toBeNull();
  });

  it('locks the declare button while the command runs', async () => {
    const { h } = open(world(), READER);
    await screen.findByTestId('declare-form');
    let release: (value: unknown) => void = () => undefined;
    h.command.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    fill('declare-from', '2027-10-20T08:00');
    fill('declare-until', '2027-10-22T08:00');
    await userEvent.click(screen.getByTestId('declare-submit'));
    await waitFor(() => expect(screen.getByTestId('declare-submit')).toBeDisabled());
    expect(screen.getByTestId('declare-submit').textContent).toBe(text('alertgov.cover.declare.pending'));
    await userEvent.click(screen.getByTestId('declare-submit'));
    expect(h.command).toHaveBeenCalledTimes(1);
    await act(async () => release({ operation_id: 'o', status: 'Created', resource_version: 1 }));
    expect(await screen.findByText(text('alertgov.cover.declare.done'))).toBeInTheDocument();
  });

  it('proposes a deputy for all the alerts, never the absent person, with the window of the absence as the start', async () => {
    const { h } = open(world(), READER);
    await userEvent.click(await screen.findByTestId(`propose-${ABSENCE_ID}`));
    const form = await screen.findByTestId(`propose-form-${ABSENCE_ID}`);
    const options = within(within(form).getByTestId('propose-deputy')).getAllByRole('option').map((one) => one.textContent);
    expect(options).not.toContain('Tran Van Me');
    await userEvent.click(within(form).getByTestId('propose-submit'));
    expect((await within(form).findByTestId('propose-error')).textContent).toBe(text('alertgov.cover.propose.invalid'));
    expect(h.command).not.toHaveBeenCalled();
    await userEvent.selectOptions(await within(form).findByRole('option', { name: 'Pham Deputy' }).then(() => within(form).getByTestId('propose-deputy')), DEPUTY);
    await userEvent.click(within(form).getByTestId('propose-submit'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, input] = h.command.mock.calls[0] as [string, { path: { id: string }; body: Record<string, unknown> }];
    expect(operation).toBe('proposeAlertCover');
    expect(input.path).toEqual({ id: ABSENCE_ID });
    expect(input.body).toEqual({ deputy_id: DEPUTY, valid_from: '2027-10-15T03:00:00.000Z', valid_until: '2027-10-20T03:00:00.000Z', scope_kind: 'ALL', sources: [] });
    await waitFor(() => expect(screen.queryByTestId(`propose-form-${ABSENCE_ID}`)).toBeNull());
  });

  it('proposes a cover for some sources only, and asks for at least one', async () => {
    const { h } = open(world(), READER);
    await userEvent.click(await screen.findByTestId(`propose-${ABSENCE_ID}`));
    const form = await screen.findByTestId(`propose-form-${ABSENCE_ID}`);
    await within(form).findByRole('option', { name: 'Pham Deputy' });
    await userEvent.selectOptions(within(form).getByTestId('propose-deputy'), DEPUTY);
    await userEvent.selectOptions(within(form).getByTestId('propose-scope'), 'SOURCES');
    await userEvent.click(within(form).getByTestId('propose-submit'));
    expect(await within(form).findByTestId('propose-error')).toBeInTheDocument();
    expect(h.command).not.toHaveBeenCalled();
    await userEvent.click(within(form).getByTestId('source-ISSUE'));
    await userEvent.click(within(form).getByTestId('propose-submit'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).toMatchObject({ scope_kind: 'SOURCES', sources: ['ISSUE'] });
  });

  it('can close the proposal without sending anything', async () => {
    const { h } = open(world(), READER);
    await userEvent.click(await screen.findByTestId(`propose-${ABSENCE_ID}`));
    const form = await screen.findByTestId(`propose-form-${ABSENCE_ID}`);
    await userEvent.click(within(form).getByRole('button', { name: text('alertgov.common.cancel.action') }));
    expect(screen.queryByTestId(`propose-form-${ABSENCE_ID}`)).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('approves a cover with the version that was read, and reads the lists again', async () => {
    const { h } = open(world());
    await userEvent.click(await screen.findByTestId(`approve-${COVER_ID}`));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Pham Deputy');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Fine with it');
    await userEvent.click(within(dialog).getByRole('button', { name: text('alertgov.cover.decide.approve') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, input] = h.command.mock.calls[0] as [string, { path: { id: string }; body: Record<string, unknown>; ifMatchVersion: number }];
    expect(operation).toBe('decideAlertCover');
    expect(input.path).toEqual({ id: COVER_ID });
    expect(input.ifMatchVersion).toBe(1);
    expect(input.body).toEqual({ decision: 'APPROVE', note: 'Fine with it' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.read.mock.calls.filter(([op]) => op === 'listAlertAbsences').length).toBeGreaterThan(2);
  });

  it('rejects a cover without a note, and sends no note then', async () => {
    const { h } = open(world());
    await userEvent.click(await screen.findByTestId(`reject-${COVER_ID}`));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: text('alertgov.cover.decide.rejectTitle') })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: text('alertgov.cover.decide.reject') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).toEqual({ decision: 'REJECT' });
  });

  it('says in words that the proposer, the absent person and the deputy cannot decide (403), and keeps the dialog open', async () => {
    const { h } = open(world());
    h.command.mockRejectedValueOnce(new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' }));
    await userEvent.click(await screen.findByTestId(`approve-${COVER_ID}`));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: text('alertgov.cover.decide.approve') }));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText(text('alertgov.problem.self.text'))).toBeInTheDocument());
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: text('alertgov.common.cancel.action') }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('revokes a cover only with a reason, with the version that was read', async () => {
    const approved = coverRow({ status: 'APPROVED', version: 3 });
    const { h } = open(world({ mine: { items: [absenceRow({ coverage: 'COVERED', covers: [approved] })], pending_covers: [], rule: rule({ params: {} }), as_of: AS_OF } }));
    await userEvent.click(await screen.findByTestId(`revoke-${COVER_ID}`));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: text('alertgov.cover.revoke.confirm') });
    await userEvent.click(confirm);
    expect(h.command).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'Back early');
    await userEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, input] = h.command.mock.calls[0] as [string, { path: { id: string }; body: Record<string, unknown>; ifMatchVersion: number }];
    expect(operation).toBe('revokeAlertCover');
    expect(input.ifMatchVersion).toBe(3);
    expect(input.body).toEqual({ reason: 'Back early' });
  });

  it('ends an absence as ended or as withdrawn, with a reason and the version', async () => {
    const { h } = open(world(), READER);
    await userEvent.click(await screen.findByTestId(`end-${ABSENCE_ID}`));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByTestId('end-status'), 'CANCELLED');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Plans changed');
    await userEvent.click(within(dialog).getByRole('button', { name: text('alertgov.absence.end.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, input] = h.command.mock.calls[0] as [string, { path: { id: string }; body: Record<string, unknown>; ifMatchVersion: number }];
    expect(operation).toBe('endAlertAbsence');
    expect(input.path).toEqual({ id: ABSENCE_ID });
    expect(input.ifMatchVersion).toBe(1);
    expect(input.body).toEqual({ status: 'CANCELLED', reason: 'Plans changed' });
  });

  it('says it was changed meanwhile (409) when the version is old', async () => {
    const { h } = open(world(), READER);
    h.command.mockRejectedValueOnce(new ApiError({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'c' }));
    await userEvent.click(await screen.findByTestId(`end-${ABSENCE_ID}`));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Back early');
    await userEvent.click(within(dialog).getByRole('button', { name: text('alertgov.absence.end.confirm') }));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText(text('alertgov.problem.conflict.text'))).toBeInTheDocument());
  });

  it('offers to end or to propose only for an absence that is still on, and only to its owner or a manager', async () => {
    const other = absenceRow({ id: OTHER_ABSENCE, membership_id: OTHER, name: 'Le Thi Other' });
    const over = absenceRow({ id: '00000000-0000-4000-8000-00000000a003', phase: 'OVER' });
    const state = world({ mine: { items: [over], pending_covers: [], rule: rule({ params: {} }), as_of: AS_OF }, managed: { items: [other], pending_covers: [], rule: rule({ params: {} }), as_of: AS_OF } });
    open(state);
    await screen.findByTestId(`absence-${OTHER_ABSENCE}`);
    expect(screen.queryByTestId('end-00000000-0000-4000-8000-00000000a003')).toBeNull();
    expect(screen.getByTestId(`end-${OTHER_ABSENCE}`)).toBeInTheDocument();
    expect(screen.getByTestId('pending-empty')).toBeInTheDocument();
  });

  it('shows an empty list as empty', async () => {
    open(world({ mine: { items: [], pending_covers: [], rule: rule({ params: {} }), as_of: AS_OF }, managed: { items: [], pending_covers: [], rule: rule({ params: {} }), as_of: AS_OF } }));
    expect((await screen.findAllByTestId('absences-empty')).length).toBe(2);
  });

  it('shows an error with a retry, keeps the last lists when a refresh fails, and says the coverage could not be read', async () => {
    const broken = world({ failing: failing('listAlertAbsences', new Error('boom')) });
    open(broken);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    broken.failing.clear();
    await userEvent.click(screen.getByRole('button', { name: text('states.retry.action') }));
    await screen.findByTestId(`absence-${ABSENCE_ID}`);
    cleanup();
    const state = world();
    const { queries } = open(state);
    await screen.findByTestId(`absence-${ABSENCE_ID}`);
    state.failing = failing('listAlertAbsences', new Error('boom'));
    await queries.refetchQueries();
    expect(await screen.findByTestId('stale')).toBeInTheDocument();
    expect(screen.getByTestId(`absence-${ABSENCE_ID}`)).toBeInTheDocument();
    cleanup();
    open(world({ failing: failing('getAlertCoverageReport', new Error('boom')) }));
    await screen.findByTestId(`absence-${ABSENCE_ID}`);
    const retry = await screen.findByRole('button', { name: text('states.retry.action') });
    expect(retry).toBeInTheDocument();
  });

  it('is denied without the right to read, and when the server refuses', async () => {
    const { h } = open(world(), []);
    expect(await screen.findByText(text('states.denied.title'))).toBeInTheDocument();
    expect(h.read).not.toHaveBeenCalled();
    cleanup();
    open(world({ failing: failing('listAlertAbsences', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })) }));
    expect(await screen.findByText(text('states.denied.title'))).toBeInTheDocument();
  });
});

void ME;
