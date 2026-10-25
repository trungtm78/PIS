import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import PetitionScreen from './PetitionScreen';
import { PAPER, PLANNER, READER, REPLY, client, contractorId, mount, packageId, petition, petitionId, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('BID-20', 'FR-BID-20');
const OK = { operation_id: 'o', status: 'RECEIVED', resource_version: 1, resource_id: petitionId(9) };
const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', extensions });
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { permissions?: readonly string[]; package?: number | null; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY' } = {}) {
  const h = client(state, options.command ?? (() => OK));
  const query = options.package === null ? '' : `?package=${packageId(options.package ?? 1)}`;
  mount(<PetitionScreen route={ROUTE} />, h, { permissions: options.permissions ?? READER, path: `/bid/bid-20${query}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
}

const dialog = (): HTMLElement => screen.getByRole('dialog');
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const rows = (): string[] => Array.from(document.querySelectorAll('[data-petition]')).map((row) => row.getAttribute('data-petition') as string);
const line = (id: string): HTMLElement => document.querySelector(`[data-petition="${id}"]`) as HTMLElement;

describe('PetitionScreen (BID-20): the petitions of contractors', () => {
  it('UI-BID-20: asks for a package, and offers every package of the scope', async () => {
    open(world(), { package: null });
    expect((await screen.findByTestId('choose-package')).textContent).toBe(vi_['bid.petitions.package.hint']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['bid.petitions.page.title']);
    const options = Array.from((document.getElementById('petitions-package') as HTMLSelectElement).options).map((option) => option.textContent);
    expect(options).toEqual([vi_['bid.petitions.package.choose'], 'GT-1 · Gói thầu xây lắp 1', 'GT-2 · Gói thầu xây lắp 2', 'GT-3 · Gói thầu xây lắp 3']);
    expect(screen.getByText(text('bid.petitions.footer.reference', { id: 'BID-20', req: 'FR-BID-20' }))).toBeTruthy();
    fireEvent.change(document.getElementById('petitions-package') as HTMLElement, { target: { value: packageId(2) } });
    expect(await screen.findByTestId('no-petitions')).toBeTruthy();
    fireEvent.change(document.getElementById('petitions-package') as HTMLElement, { target: { value: '' } });
    expect(await screen.findByTestId('choose-package')).toBeTruthy();
  });

  it('AC-ST-BID-007-1, UAT-AC456: shows the petitions of the package with the last day to answer and the days of the rule, and the overdue ones with the days past it', async () => {
    open(
      world({
        petitions: [
          petition(1, 1, { petition_kind: 'RESULT', overdue: true, days_overdue: 3, due_on: '2026-12-04' }),
          petition(2, 1, { due_on: '2026-12-09', status: 'RECEIVED' }),
          petition(3, 1, { status: 'RESOLVED', handled_by: { membership_id: 'm1', display_name: 'Chuyên viên An' }, actions: { resolve: false } }),
        ],
      }),
    );
    await screen.findByTestId('petitions');
    expect(rows()).toEqual([petitionId(1), petitionId(2), petitionId(3)]);
    const late = line(petitionId(1));
    expect(late.getAttribute('data-overdue')).toBe('true');
    expect(within(late).getByTestId('kind').textContent).toBe(vi_['bid.petitions.kind.result']);
    expect(within(late).getByTestId('contractor').textContent).toBe('Công ty nhà thầu 1');
    expect(within(late).getByTestId('due').textContent).toContain(text('bid.petitions.due.days', { days: 7 }));
    expect(within(late).getByTestId('overdue').textContent).toBe(text('bid.petitions.overdue.badge', { days: 3 }));
    expect(within(late).getByTestId('status').textContent).toBe(vi_['bid.petitions.status.received']);
    expect(within(late).getByTestId('handler').textContent).toBe(vi_['bid.petitions.none.text']);
    expect(within(line(petitionId(2))).queryByTestId('overdue')).toBeNull();
    const done = line(petitionId(3));
    expect(within(done).getByTestId('handler').textContent).toBe('Chuyên viên An');
    expect(within(done).getByTestId('status').textContent).toBe(vi_['bid.petitions.status.resolved']);
    expect(within(done).queryByRole('button')).toBeNull();
  });

  it('shows only the overdue petitions when asked, and says when there are none', async () => {
    open(world({ petitions: [petition(1, 1, { overdue: true, days_overdue: 1 }), petition(2, 1)] }));
    await screen.findByTestId('petitions');
    fireEvent.click(screen.getByLabelText(vi_['bid.petitions.overdueOnly.label']));
    await waitFor(() => expect(rows()).toEqual([petitionId(1)]));
    cleanup();
    open(world({ petitions: [petition(2, 1)] }));
    await screen.findByTestId('petitions');
    fireEvent.click(screen.getByLabelText(vi_['bid.petitions.overdueOnly.label']));
    expect((await screen.findByTestId('no-petitions')).textContent).toBe(vi_['bid.petitions.none.overdue']);
    cleanup();
    open(world());
    expect((await screen.findByTestId('no-petitions')).textContent).toBe(vi_['bid.petitions.none.notice']);
  });

  describe('who is offered what', () => {
    it('offers the answer where the server says the caller may give it, the log to a planner, and nothing in a read-only session', async () => {
      open(world({ petitions: [petition(1, 1), petition(2, 1, { actions: { resolve: false } })] }), { permissions: PLANNER });
      await screen.findByTestId('petitions');
      expect(screen.getByRole('button', { name: vi_['bid.petitions.receive.action'] })).toBeTruthy();
      expect(within(line(petitionId(1))).getByRole('button', { name: vi_['bid.petitions.resolve.action'] })).toBeTruthy();
      expect(within(line(petitionId(2))).queryByRole('button')).toBeNull();
      cleanup();
      open(world({ petitions: [petition(1, 1)] }), { permissions: READER });
      await screen.findByTestId('petitions');
      expect(screen.queryByRole('button', { name: vi_['bid.petitions.receive.action'] })).toBeNull();
      cleanup();
      open(world({ petitions: [petition(1, 1)] }), { permissions: PLANNER, mode: 'READ_ONLY' });
      await screen.findByTestId('petitions');
      expect(screen.queryByRole('button', { name: vi_['bid.petitions.receive.action'] })).toBeNull();
      expect(screen.queryByRole('button', { name: vi_['bid.petitions.resolve.action'] })).toBeNull();
    });

    it('AC-ST-BID-007-2, UAT-AC450: tells a person with a conflict of interest that somebody else answers, and offers them no answer', async () => {
      open(world({ petitions: [petition(1, 1, { viewer_in_conflict: true, actions: { resolve: false } }), petition(2, 1, { viewer_in_conflict: true, status: 'RESOLVED', actions: { resolve: false } })] }), { permissions: PLANNER });
      await screen.findByTestId('petitions');
      expect(within(line(petitionId(1))).getByTestId('conflict-note').textContent).toBe(vi_['bid.petitions.conflict.notice']);
      expect(within(line(petitionId(1))).queryByRole('button')).toBeNull();
      expect(within(line(petitionId(2))).queryByTestId('conflict-note')).toBeNull();
    });
  });

  describe('logging a petition', () => {
    const fill = (overrides: Record<string, string> = {}): void => {
      const values = { 'petition-kind': 'RESULT', 'petition-contractor': contractorId(2), 'petition-received': '2026-10-01', 'petition-document': ` ${PAPER.toUpperCase()} `, ...overrides };
      for (const [id, value] of Object.entries(values)) pick(id, value);
    };

    it('asks for every field, refuses a day that has not come, and sends the petition with the day and the paper', async () => {
      const h = open(world(), { permissions: PLANNER });
      await screen.findByTestId('no-petitions');
      fireEvent.click(screen.getByRole('button', { name: vi_['bid.petitions.receive.action'] }));
      await within(dialog()).findByRole('option', { name: 'Công ty nhà thầu 2' });
      pick('petition-received', '');
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.petitions.receive.submit'] }));
      expect(within(dialog()).getAllByText(vi_['bid.petitions.problem.required'])).toHaveLength(4);
      expect(h.command).not.toHaveBeenCalled();
      fill({ 'petition-received': '2999-01-01', 'petition-document': 'nope' });
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.petitions.receive.submit'] }));
      expect(within(dialog()).getByText(vi_['bid.petitions.problem.future'])).toBeTruthy();
      expect(within(dialog()).getByText(vi_['bid.petitions.problem.uuid'])).toBeTruthy();
      fill();
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.petitions.receive.submit'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('receiveProcurementPetition', expect.objectContaining({ body: { package_id: packageId(1), contractor_id: contractorId(2), petition_kind: 'RESULT', received_on: '2026-10-01', petition_document_id: PAPER } }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('says in words why a petition is out of time, and keeps the dialog open', async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ reason: 'FUTURE' }, vi_['bid.petitions.error.outOfTimeFuture']],
        [{ reason: 'NO_RESULT' }, vi_['bid.petitions.error.outOfTimeNoResult']],
        [{ reason: 'BEFORE_RESULT' }, vi_['bid.petitions.error.outOfTimeBeforeResult']],
        [{ reason: 'FILING_WINDOW_PASSED', last_day_to_file: '2026-11-25' }, text('bid.petitions.error.outOfTimeFilingUntil', { day: '2026-11-25' })],
        [{ reason: 'FILING_WINDOW_PASSED' }, vi_['bid.petitions.error.outOfTimeFiling']],
      ];
      for (const [extensions, message] of cases) {
        cleanup();
        open(world(), { permissions: PLANNER, command: () => problem('PETITION_OUT_OF_TIME', 422, extensions) });
        await screen.findByTestId('no-petitions');
        fireEvent.click(screen.getByRole('button', { name: vi_['bid.petitions.receive.action'] }));
        await within(dialog()).findByRole('option', { name: 'Công ty nhà thầu 2' });
        fill();
        fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.petitions.receive.submit'] }));
        expect((await screen.findByTestId('refusal')).textContent).toBe(message);
        expect(dialog()).toBeTruthy();
      }
    });

    it('words the other refusals: a paper that lodges a petition, no rule in force, no calendar', async () => {
      const cases: Array<[string, number, Record<string, unknown>, string]> = [
        ['PETITION_STATE_INVALID', 409, { reason: 'DOCUMENT_ALREADY_LODGED' }, vi_['bid.petitions.error.documentLodged']],
        ['TIMER_RULE_UNCONFIRMED', 422, {}, vi_['bid.petitions.error.ruleUnconfirmed']],
        ['CALENDAR_NOT_EFFECTIVE', 422, {}, vi_['bid.petitions.error.calendar']],
        ['SCOPE_DENIED', 403, {}, vi_['bid.petitions.error.denied']],
      ];
      for (const [code, status, extensions, message] of cases) {
        cleanup();
        open(world(), { permissions: PLANNER, command: () => problem(code, status, extensions) });
        await screen.findByTestId('no-petitions');
        fireEvent.click(screen.getByRole('button', { name: vi_['bid.petitions.receive.action'] }));
        await within(dialog()).findByRole('option', { name: 'Công ty nhà thầu 2' });
        fill();
        fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.petitions.receive.submit'] }));
        expect((await screen.findByTestId('refusal')).textContent).toBe(message);
      }
    });

    it('closes without sending on cancel and on the close button', async () => {
      const h = open(world(), { permissions: PLANNER });
      await screen.findByTestId('no-petitions');
      fireEvent.click(screen.getByRole('button', { name: vi_['bid.petitions.receive.action'] }));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.petitions.dialog.cancel'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: vi_['bid.petitions.receive.action'] }));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.petitions.dialog.close'] }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });
  });

  describe('answering a petition', () => {
    it('AC-ST-BID-007-1, UAT-AC456: asks for a way to deal with it and a document, and sends them under the version the screen showed', async () => {
      const h = open(world({ petitions: [petition(1, 1, { overdue: true, days_overdue: 2, version: 4 })] }), { permissions: PLANNER });
      await screen.findByTestId('petitions');
      fireEvent.click(within(line(petitionId(1))).getByRole('button', { name: vi_['bid.petitions.resolve.action'] }));
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.petitions.resolve.submit'] }));
      expect(within(dialog()).getAllByText(vi_['bid.petitions.problem.required'])).toHaveLength(2);
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.click(dialog().querySelector('input[data-outcome="RESOLVED"]') as HTMLElement);
      pick('petition-reply', 'nope');
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.petitions.resolve.submit'] }));
      expect(within(dialog()).getByText(vi_['bid.petitions.problem.uuid'])).toBeTruthy();
      pick('petition-reply', ` ${REPLY.toUpperCase()} `);
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.petitions.resolve.submit'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('resolveProcurementPetition', expect.objectContaining({ path: { id: petitionId(1) }, ifMatchVersion: 4, body: { outcome: 'RESOLVED', resolution_document_id: REPLY } }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('offers to pass a petition on to the level above, and offers only the answer for a petition that was passed on', async () => {
      const h = open(world({ petitions: [petition(1, 1), petition(2, 1, { status: 'ESCALATED' })] }), { permissions: PLANNER });
      await screen.findByTestId('petitions');
      fireEvent.click(within(line(petitionId(1))).getByRole('button', { name: vi_['bid.petitions.resolve.action'] }));
      expect(Array.from(dialog().querySelectorAll('input[data-outcome]')).map((input) => input.getAttribute('data-outcome'))).toEqual(['RESOLVED', 'ESCALATED']);
      fireEvent.click(dialog().querySelector('input[data-outcome="ESCALATED"]') as HTMLElement);
      pick('petition-reply', REPLY);
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.petitions.resolve.submit'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('resolveProcurementPetition', expect.objectContaining({ body: { outcome: 'ESCALATED', resolution_document_id: REPLY } })));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      fireEvent.click(within(line(petitionId(2))).getByRole('button', { name: vi_['bid.petitions.resolve.action'] }));
      expect(Array.from(dialog().querySelectorAll('input[data-outcome]')).map((input) => input.getAttribute('data-outcome'))).toEqual(['RESOLVED']);
    });

    it('AC-ST-BID-007-2, UAT-AC450: says in words that a conflict of interest stands between the caller and the contractor', async () => {
      open(world({ petitions: [petition(1, 1)] }), { permissions: PLANNER, command: () => problem('CONFLICT_OF_INTEREST_BLOCKED', 409) });
      await screen.findByTestId('petitions');
      fireEvent.click(within(line(petitionId(1))).getByRole('button', { name: vi_['bid.petitions.resolve.action'] }));
      fireEvent.click(dialog().querySelector('input[data-outcome="RESOLVED"]') as HTMLElement);
      pick('petition-reply', REPLY);
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.petitions.resolve.submit'] }));
      expect((await screen.findByTestId('refusal')).textContent).toBe(vi_['bid.petitions.error.conflict']);
    });

    it('words the refusals of a stale version and of a petition already answered', async () => {
      for (const [code, status, key] of [
        ['VERSION_CONFLICT', 409, 'bid.petitions.error.versionConflict'],
        ['PETITION_STATE_INVALID', 409, 'bid.petitions.error.petitionState'],
        ['VALIDATION_FAILED', 422, 'bid.petitions.error.validation'],
      ] as const) {
        cleanup();
        open(world({ petitions: [petition(1, 1)] }), { permissions: PLANNER, command: () => problem(code, status) });
        await screen.findByTestId('petitions');
        fireEvent.click(within(line(petitionId(1))).getByRole('button', { name: vi_['bid.petitions.resolve.action'] }));
        fireEvent.click(dialog().querySelector('input[data-outcome="RESOLVED"]') as HTMLElement);
        pick('petition-reply', REPLY);
        fireEvent.click(within(dialog()).getByRole('button', { name: vi_['bid.petitions.resolve.submit'] }));
        expect((await screen.findByTestId('refusal')).textContent).toBe((vi_ as Record<string, string>)[key]);
      }
    });
  });

  it('shows the declarations of conflict of interest of the package under the petitions', async () => {
    open(world({ petitions: [petition(1, 1)] }), { permissions: [...PLANNER, 'bid.evaluate'] });
    await screen.findByTestId('petitions');
    expect(await screen.findByTestId('conflict-panel')).toBeTruthy();
  });

  it('shows the state of a failed read and reads again on retry', async () => {
    const state = world({ failing: new Set(['get_resources_procurement_package']) });
    open(state, { package: null });
    const retry = await screen.findByRole('button', { name: /./ });
    state.failing.clear();
    fireEvent.click(retry);
    expect(await screen.findByTestId('choose-package')).toBeTruthy();
  });

  it('shows the state of a failed read of the petitions of a package', async () => {
    open(world({ failing: new Set(['listProcurementPetitions']) }));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
  });
});
