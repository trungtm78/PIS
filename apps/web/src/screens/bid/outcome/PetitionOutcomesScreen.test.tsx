import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import base from '../../../i18n/vi.json';
import { client, mount, routeOf, uuid } from '../../vnd/shared/test/vnd-test-support';
import type { World } from '../../vnd/shared/test/vnd-test-support';
import { decisionLabel, outcomeErrorText, outcomeStatusLabel } from './outcome-labels';
import { DECISIONS, OUTCOME_STATUSES, feedsFigures, outcomeIcon } from './outcome-model';
import PetitionOutcomesScreen from './PetitionOutcomesScreen';

const word = (key: string): string => (base as Record<string, string>)[key] ?? key;
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
const labelOf = (label: string): RegExp => new RegExp(escaped(label));
const dialog = (): HTMLElement => screen.getByRole('dialog');
const type = (scope: HTMLElement, label: string, value: string): void => {
  fireEvent.change(within(scope).getByLabelText(labelOf(label)), { target: { value } });
};
const sent = (): { attempt: { key: unknown } } => ({ attempt: { key: expect.any(String) } });
const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

const RECORDER = ['bid.read', 'bid.petition.outcome.record'];
const CHECKER = ['bid.read', 'bid.petition.outcome.confirm'];
const READER = ['bid.read'];
const PETITION = uuid('00f0', 1);
const AT = '2026-11-08T03:00:00.000Z';

const outcome = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0070', n),
  petition_id: PETITION,
  package: { id: uuid('0020', 1), code: 'GT-1' },
  contractor: { id: uuid('0001', 1), legal_name: 'Công ty nhà thầu 1' },
  petition_status: 'RESOLVED',
  outcome: 'UPHELD',
  decision_ref: `QD-${n}/2026`,
  decision_on: '2026-11-05',
  decision_document_id: null,
  note: null,
  status: 'PROPOSED',
  recorded_by_name: 'Lê Thị Hoa',
  recorded_at: '2026-11-06T02:00:00.000Z',
  checked_by_name: null,
  checked_at: null,
  return_reason: null,
  actions: { confirm: true, return: true },
  version: 1,
  ...over,
});

const route = routeOf('BID-34', 'FR-BID-34');

function open(element: ReactElement, answers: World['answers'], options: { permissions?: string[]; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown; path?: string; failing?: World['failing'] } = {}) {
  const world: World = { answers, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world, options.command);
  mount(element, h, { permissions: options.permissions ?? CHECKER, path: options.path ?? '/bid/bid-34', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const answers = (items: Array<Record<string, unknown>> = [outcome(1), outcome(2, { outcome: 'REJECTED', status: 'CONFIRMED', checked_by_name: 'Phạm Quốc Bảo', actions: { confirm: false, return: false } })]) => ({
  listProcurementPetitionOutcomes: { items, as_of: AT },
});
const row = (n: number): HTMLElement => document.querySelector(`tr[data-outcome-id="${uuid('0070', n)}"]`) as HTMLElement;

describe('PetitionOutcomesScreen (BID-34)', () => {
  it('lists the outcomes with the decision reference, the people and the status in words, and says that only confirmed ones feed the figures', async () => {
    open(<PetitionOutcomesScreen route={route} />, answers());
    await screen.findByTestId('figures-note');
    expect(screen.getByTestId('figures-note').textContent).toBe(word('bid34.figures.note'));
    expect(row(1).textContent).toContain('GT-1');
    expect(row(1).textContent).toContain('QD-1/2026');
    expect(row(1).textContent).toContain(word('bid34.decision.upheld.name'));
    expect(row(1).textContent).toContain(word('bid34.status.proposed.name'));
    expect(row(1).textContent).not.toContain(word('bid34.feeds.text'));
    expect(row(2).textContent).toContain(word('bid34.status.confirmed.name'));
    expect(row(2).textContent).toContain(word('bid34.feeds.text'));
    expect(row(2).textContent).toContain('Phạm Quốc Bảo');
  });

  it('offers confirm and return only to the checker where the server says so, and recording only to the recorder', async () => {
    open(<PetitionOutcomesScreen route={route} />, answers(), { permissions: CHECKER });
    await screen.findByTestId('figures-note');
    expect(within(row(1)).getByTestId('confirm')).toBeTruthy();
    expect(within(row(2)).queryByTestId('confirm')).toBeNull();
    expect(screen.queryByTestId('record-outcome')).toBeNull();
    cleanup();
    open(<PetitionOutcomesScreen route={route} />, answers(), { permissions: RECORDER });
    await screen.findByTestId('figures-note');
    expect(screen.getByTestId('record-outcome')).toBeTruthy();
    expect(screen.queryByTestId('confirm')).toBeNull();
    cleanup();
    open(<PetitionOutcomesScreen route={route} />, answers([outcome(1, { actions: { confirm: false, return: false } })]), { permissions: CHECKER });
    await screen.findByTestId('figures-note');
    expect(screen.queryByTestId('confirm')).toBeNull();
    cleanup();
    open(<PetitionOutcomesScreen route={route} />, answers(), { permissions: READER });
    await screen.findByTestId('figures-note');
    expect(screen.queryByTestId('record-outcome')).toBeNull();
    expect(screen.queryByTestId('confirm')).toBeNull();
    cleanup();
    open(<PetitionOutcomesScreen route={route} />, answers(), { permissions: [...RECORDER, ...CHECKER], mode: 'READ_ONLY' });
    await screen.findByTestId('figures-note');
    expect(screen.getByTestId('readonly-note')).toBeTruthy();
    expect(screen.queryByTestId('record-outcome')).toBeNull();
    expect(screen.queryByTestId('confirm')).toBeNull();
  });

  it('records an outcome with the reference and the day of the decision, opened for the petition named in the address', async () => {
    const h = open(<PetitionOutcomesScreen route={route} />, answers(), { permissions: RECORDER, path: `/bid/bid-34?petition=${PETITION}` });
    expect(h.read).toBeDefined();
    fireEvent.click(await screen.findByTestId('record-outcome'));
    const box = dialog();
    expect((within(box).getByLabelText(labelOf(word('bid34.record.field.petition.label'))) as HTMLInputElement).value).toBe(PETITION);
    const confirm = within(box).getByRole('button', { name: word('bid34.record.confirm.action') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(box).getByLabelText(labelOf(word('bid34.record.field.outcome.label'))), { target: { value: 'UPHELD' } });
    type(box, word('bid34.record.field.ref.label'), 'QD-15/2026');
    type(box, word('bid34.record.field.day.label'), '2026-11-05');
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('recordProcurementPetitionOutcome', { path: { id: PETITION }, body: { outcome: 'UPHELD', decision_ref: 'QD-15/2026', decision_on: '2026-11-05' }, ...sent() }));
    expect((await screen.findByTestId('receipt')).textContent).toContain(word('bid34.record.title.text'));
    expect(h.read).toHaveBeenCalledWith('listProcurementPetitionOutcomes', { query: { petition_id: PETITION } });
  });

  it('says in the dialog why a record was refused: the petition cannot take the outcome, or the caller has a conflict of interest', async () => {
    open(<PetitionOutcomesScreen route={route} />, answers(), { permissions: RECORDER, command: () => problem(422, 'PETITION_OUTCOME_NOT_ALLOWED') });
    fireEvent.click(await screen.findByTestId('record-outcome'));
    const box = dialog();
    type(box, word('bid34.record.field.petition.label'), PETITION);
    fireEvent.change(within(box).getByLabelText(labelOf(word('bid34.record.field.outcome.label'))), { target: { value: 'WITHDRAWN' } });
    type(box, word('bid34.record.field.ref.label'), 'CV-7/2026');
    type(box, word('bid34.record.field.day.label'), '2026-11-05');
    fireEvent.click(within(box).getByRole('button', { name: word('bid34.record.confirm.action') }));
    expect((await within(box).findByTestId('dialog-error')).textContent).toBe(word('bid34.error.notAllowed.text'));
    expect(outcomeErrorText(translator.t, problem(409, 'CONFLICT_OF_INTEREST_BLOCKED'))).toBe(word('bid34.error.conflict.text'));
    expect(outcomeErrorText(translator.t, problem(409, 'PETITION_OUTCOME_STATE_INVALID'))).toBe(word('bid34.error.state.text'));
  });

  it('confirms with the version that was read, and returns only with a reason', async () => {
    const h = open(<PetitionOutcomesScreen route={route} />, answers());
    await screen.findByTestId('figures-note');
    fireEvent.click(within(row(1)).getByTestId('confirm'));
    const box = dialog();
    expect(box.textContent).toContain('QD-1/2026');
    fireEvent.click(within(box).getByRole('button', { name: word('bid34.confirm.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('confirmProcurementPetitionOutcome', { path: { id: uuid('0070', 1) }, ifMatchVersion: 1, ...sent() }));
    cleanup();
    const g = open(<PetitionOutcomesScreen route={route} />, answers());
    await screen.findByTestId('figures-note');
    fireEvent.click(within(row(1)).getByTestId('return'));
    const returnBox = dialog();
    const giveBack = within(returnBox).getByRole('button', { name: word('bid34.return.confirm.action') }) as HTMLButtonElement;
    expect(giveBack.disabled).toBe(true);
    type(returnBox, word('vnd.field.reason.label'), 'Số quyết định chưa đúng');
    fireEvent.click(giveBack);
    await waitFor(() => expect(g.command).toHaveBeenCalledWith('returnProcurementPetitionOutcome', { path: { id: uuid('0070', 1) }, ifMatchVersion: 1, body: { reason: 'Số quyết định chưa đúng' }, ...sent() }));
  });

  it('filters by status on the server', async () => {
    const h = open(<PetitionOutcomesScreen route={route} />, answers());
    await screen.findByTestId('figures-note');
    fireEvent.change(screen.getByLabelText(word('bid34.filter.status.label')), { target: { value: 'CONFIRMED' } });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listProcurementPetitionOutcomes', { query: { status: 'CONFIRMED' } }));
  });

  it('says the states: nothing recorded yet, error with retry, denied', async () => {
    open(<PetitionOutcomesScreen route={route} />, answers([]));
    expect(await screen.findByTestId('outcomes-empty')).toBeTruthy();
    cleanup();
    const h = open(<PetitionOutcomesScreen route={route} />, answers(), { failing: { listProcurementPetitionOutcomes: { error: new Error('boom'), times: 1 } } });
    fireEvent.click(await screen.findByRole('button', { name: word('states.retry.action') }));
    await screen.findByTestId('figures-note');
    expect(h.read.mock.calls.filter(([operation]) => operation === 'listProcurementPetitionOutcomes').length).toBeGreaterThanOrEqual(2);
    cleanup();
    open(<PetitionOutcomesScreen route={route} />, { listProcurementPetitionOutcomes: problem(403, 'SCOPE_DENIED') });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });
});

describe('the words and marks of the outcomes', () => {
  it('has a name for every decision and status in both languages, a mark for every status, and feeds the figures from CONFIRMED only', () => {
    for (const locale of ['vi', 'en'] as const) {
      translator.setLocale(locale);
      for (const decision of DECISIONS) expect(decisionLabel(translator.t, decision).startsWith('bid34.')).toBe(false);
      for (const status of OUTCOME_STATUSES) expect(outcomeStatusLabel(translator.t, status).startsWith('bid34.')).toBe(false);
    }
    translator.setLocale('vi');
    expect(new Set(OUTCOME_STATUSES.map((status) => outcomeIcon(status))).size).toBe(OUTCOME_STATUSES.length);
    expect(OUTCOME_STATUSES.filter((status) => feedsFigures(status))).toEqual(['CONFIRMED']);
  });
});
