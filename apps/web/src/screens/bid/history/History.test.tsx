import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { READER, client, line, mount, routeOf, world } from '../test-support';
import type { Harness } from '../test-support';
import ContractLinksScreen from './ContractLinksScreen';
import { describeHistory, isUuid, toHistory, validityOf } from './model';
import RestrictionsScreen from './RestrictionsScreen';

const word = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(cleanup);

const CONTRACTOR = line(1).id;
const OUTSIDE = '00000000-0000-4000-8000-0000000000f9';
const restriction = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000a${n}`,
  kind: 'DEBARMENT',
  source: 'NATIONAL_E_PROCUREMENT_IMPORT',
  effective_from: '2026-01-01',
  effective_until: null,
  in_force: true,
  ...overrides,
});
const scorecard = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000b${n}`,
  contract_id: `00000000-0000-4000-8000-0000000000c${n}`,
  contract_code: `HD-A-00${n}`,
  kind: 'PERIODIC',
  period_label: `2026-Q${n}`,
  revision: 1,
  scores: { quality: 80 },
  overall_score: '83.00',
  rating: 'GOOD',
  approved_at: '2026-10-10T03:00:00.000Z',
  ...overrides,
});
const history = (overrides: Record<string, unknown> = {}) => ({
  contractor: { id: CONTRACTOR, legal_name: 'Công ty nhà thầu 1' },
  scorecards: [scorecard(7)],
  approved_count: 1,
  average_overall_score: '83.00',
  contracts: [{ id: '00000000-0000-4000-8000-0000000000c7', code: 'HD-A-007', status: 'ACTIVE' }],
  restrictions: [],
  restriction_in_force: false,
  as_of: '2026-10-31T00:00:00.000Z',
  ...overrides,
});

function open(Screen: typeof RestrictionsScreen, id: string, answer: (input: unknown) => unknown, path: string, options: { contractors?: boolean } = {}): Harness {
  const h = client(world({ contractors: options.contractors === false ? [] : [line(1)] }));
  const base = h.read.getMockImplementation();
  h.read.mockImplementation((operation: string, input?: unknown) => {
    if (operation !== 'getContractorHistory') return (base?.(operation, input) as Promise<unknown>) ?? Promise.reject(new Error(`unexpected read ${operation}`));
    const found = answer(input);
    return found instanceof Error ? Promise.reject(found) : Promise.resolve(found);
  });
  mount(<Screen route={routeOf(id, `FR-${id}`)} />, h, { permissions: READER, path });
  return h;
}
const asked = (h: Harness): Array<{ path: { id: string } }> => h.read.mock.calls.filter((call) => call[0] === 'getContractorHistory').map((call) => call[1] as { path: { id: string } });

describe('RestrictionsScreen (BID-21): the restrictions on a contractor', () => {
  it('UI-BID-21, UAT-AC446: lists each restriction with its kind, source and validity in words, and says that the one in force blocks a proposal', async () => {
    open(
      RestrictionsScreen,
      'BID-21',
      () =>
        history({
          restrictions: [
            restriction(1, { kind: 'SUSPENSION', source: 'DECISION', effective_from: '2999-01-01', effective_until: '2999-12-31', in_force: false }),
            restriction(2),
            restriction(3, { kind: 'WARNING', source: 'DECISION', effective_from: '2025-01-01', effective_until: '2025-06-30', in_force: false }),
          ],
          restriction_in_force: true,
        }),
      `/bid/bid-21?contractor=${CONTRACTOR}`,
    );
    const table = await screen.findByTestId('restrictions');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('bid.history.restrictions.title'));
    expect(screen.getByTestId('blocked').textContent).toBe(word('bid.history.restrictions.blocked.notice', { name: 'Công ty nhà thầu 1' }));
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.getAttribute('data-validity'))).toEqual(['upcoming', 'inForce', 'ended']);
    expect(rows[0]?.textContent).toContain(word('bid.kind.suspension.label'));
    expect(rows[0]?.textContent).toContain(word('bid.history.source.decision'));
    expect(rows[0]?.textContent).toContain(word('bid.history.validity.upcoming'));
    expect(rows[1]?.textContent).toContain(word('bid.history.source.import'));
    expect(rows[1]?.textContent).toContain(word('bid.history.until.open'));
    expect(rows[1]?.textContent).toContain(word('bid.history.validity.inForce'));
    expect(rows[2]?.textContent).toContain('2025-06-30');
    expect(rows[2]?.textContent).toContain(word('bid.history.validity.ended'));
  });

  it('says that a contractor has no restriction, and does not warn of a block', async () => {
    open(RestrictionsScreen, 'BID-21', () => history(), `/bid/bid-21?contractor=${CONTRACTOR}`);
    expect((await screen.findByTestId('none')).textContent).toBe(word('bid.history.restrictions.none.notice'));
    expect(screen.queryByTestId('blocked')).toBeNull();
  });

  it('asks for a contractor first, then reads the one chosen from the register or named by its identifier, and asks for no identifier that is not one', async () => {
    const h = open(RestrictionsScreen, 'BID-21', () => history(), '/bid/bid-21');
    expect((await screen.findByTestId('no-contractor')).textContent).toBe(word('bid.history.noContractor.notice'));
    expect(asked(h)).toHaveLength(0);
    const select = (await screen.findByLabelText(word('bid.history.field.contractor'))) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
    fireEvent.change(select, { target: { value: CONTRACTOR } });
    await screen.findByTestId('none');
    expect(asked(h).at(-1)?.path.id).toBe(CONTRACTOR);
    const field = screen.getByLabelText(word('bid.history.field.contractorId')) as HTMLInputElement;
    expect(field.value).toBe(CONTRACTOR);
    const before = asked(h).length;
    fireEvent.change(field, { target: { value: 'not an identifier' } });
    expect(await screen.findByText(word('bid.history.field.contractorId.error'))).toBeTruthy();
    expect(asked(h)).toHaveLength(before);
    fireEvent.change(field, { target: { value: ` ${OUTSIDE.toUpperCase()} ` } });
    await waitFor(() => expect(asked(h).at(-1)?.path.id).toBe(OUTSIDE));
    expect(select.value).toBe('');
  });

  it('offers only the identifier when the register cannot be read', async () => {
    open(RestrictionsScreen, 'BID-21', () => history(), '/bid/bid-21', { contractors: false });
    await screen.findByTestId('no-contractor');
    expect(screen.queryByLabelText(word('bid.history.field.contractor'))).toBeNull();
    expect(screen.getByLabelText(word('bid.history.field.contractorId'))).toBeTruthy();
  });

  it.each([
    ['RESOURCE_NOT_FOUND', 404, 'notFound'],
    ['SCOPE_DENIED', 403, 'denied'],
  ] as const)('says in words why the server refused with %s', async (code, status, problem) => {
    open(RestrictionsScreen, 'BID-21', () => new ApiError({ status, code, correlationId: 'c' }), `/bid/bid-21?contractor=${CONTRACTOR}`);
    expect((await screen.findByTestId('history-refusal')).textContent).toBe(word(`bid.history.problem.${problem}`));
  });

  it('offers a retry for a failure it can say nothing of', async () => {
    const h = open(RestrictionsScreen, 'BID-21', () => new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }), `/bid/bid-21?contractor=${CONTRACTOR}`);
    fireEvent.click(await screen.findByRole('button', { name: word('states.retry.action') }));
    await waitFor(() => expect(asked(h).length).toBeGreaterThanOrEqual(2));
  });
});

describe('ContractLinksScreen (BID-14): the contracts and the approved scorecards of a contractor', () => {
  it('UI-BID-14, UAT-AC451: lists the contracts, each linked to its workspace, and the approved scorecards with the average', async () => {
    open(
      ContractLinksScreen,
      'BID-14',
      () => history({ scorecards: [scorecard(7), scorecard(9, { kind: 'COMPLETION', rating: 'EXCELLENT', overall_score: '95.00', approved_at: null })], approved_count: 2, average_overall_score: '89.00' }),
      `/bid/bid-14?contractor=${CONTRACTOR}`,
    );
    const contracts = await screen.findByTestId('contracts');
    const link = within(contracts).getByRole('link', { name: 'HD-A-007' });
    expect(link.getAttribute('href')).toBe('/ctr/ctr-03?id=00000000-0000-4000-8000-0000000000c7');
    expect(within(contracts).getAllByRole('row')[1]?.textContent).toContain(word('ctr.status.active.label'));
    expect(screen.getByTestId('average').textContent).toBe(word('bid.history.scorecards.average', { score: '89.00', count: 2 }));
    const rows = within(screen.getByTestId('scorecards')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('HD-A-007');
    expect(rows[0]?.textContent).toContain('2026-Q7');
    expect(rows[0]?.textContent).toContain(word('ctr.scorecard.kind.periodic'));
    expect(rows[0]?.textContent).toContain('83.00');
    expect(rows[0]?.textContent).toContain(word('ctr.scorecard.rating.good'));
    expect(rows[1]?.textContent).toContain(word('ctr.scorecard.kind.completion'));
    expect(rows[1]?.textContent).toContain(word('ctr.scorecard.rating.excellent'));
    expect(rows[1]?.textContent).toContain(word('bid.history.none'));
  });

  it('says in words that there is no contract and no scorecard in what the caller may see', async () => {
    open(ContractLinksScreen, 'BID-14', () => history({ scorecards: [], approved_count: 0, contracts: [], average_overall_score: null }), `/bid/bid-14?contractor=${CONTRACTOR}`);
    expect((await screen.findByTestId('no-contracts')).textContent).toBe(word('bid.history.contracts.none.notice'));
    expect(screen.getByTestId('no-scorecards').textContent).toBe(word('bid.history.scorecards.none.notice'));
    expect(screen.getByTestId('average').textContent).toBe(word('bid.history.scorecards.average.none'));
  });

  it('shows a status or a rating it does not know as it was sent', async () => {
    open(ContractLinksScreen, 'BID-14', () => history({ contracts: [{ id: '00000000-0000-4000-8000-0000000000c7', code: 'HD-A-007', status: 'ODD' }], scorecards: [scorecard(7, { kind: 'ODD', rating: 'STRANGE' })] }), `/bid/bid-14?contractor=${CONTRACTOR}`);
    const contracts = await screen.findByTestId('contracts');
    expect(contracts.textContent).toContain('ODD');
    expect(within(screen.getByTestId('scorecards')).getAllByRole('row')[1]?.textContent).toContain('STRANGE');
  });
});

describe('the model of the history', () => {
  it('reads the answer of the server and leaves out what is not a line', () => {
    expect(toHistory(undefined)).toBeUndefined();
    expect(toHistory({ contractor: {} })).toBeUndefined();
    const read = toHistory({
      contractor: { id: CONTRACTOR },
      scorecards: [null, { id: 'x' }, scorecard(1, { revision: '1' }), scorecard(2)],
      contracts: [null, { id: 'x' }, { id: 'a', code: 'C' }],
      restrictions: [null, restriction(1, { kind: 'ODD' }), restriction(2, { source: 'ODD' }), restriction(3, { effective_from: undefined }), restriction(4)],
    });
    expect(read?.contractor.legalName).toBe('');
    expect(read?.scorecards.map((card) => card.periodLabel)).toEqual(['2026-Q2']);
    expect(read?.contracts).toEqual([{ id: 'a', code: 'C', status: '' }]);
    expect(read?.restrictions).toHaveLength(1);
    expect(read?.averageOverallScore).toBeNull();
    expect(read?.approvedCount).toBe(0);
    expect(toHistory({ contractor: { id: CONTRACTOR }, approved_count: -1 })?.approvedCount).toBe(0);
    expect(toHistory({ contractor: { id: CONTRACTOR }, approved_count: 3 })?.approvedCount).toBe(3);
    expect(read?.restrictionInForce).toBe(false);
  });

  it('tells a restriction in force from one that ended and one that has not begun', () => {
    const base = { id: 'r', kind: 'WARNING', source: 'DECISION', effectiveFrom: '2026-01-01', effectiveUntil: null } as const;
    expect(validityOf({ ...base, inForce: true }, '2026-10-31')).toBe('inForce');
    expect(validityOf({ ...base, inForce: false, effectiveUntil: '2026-02-01' }, '2026-10-31')).toBe('ended');
    expect(validityOf({ ...base, inForce: false, effectiveFrom: '2026-11-01' }, '2026-10-31')).toBe('upcoming');
    expect(validityOf({ ...base, inForce: false, effectiveFrom: '2026-10-31' }, '2026-10-31')).toBe('ended');
  });

  it('reads anything but an error of the server as a general failure, and knows an identifier', () => {
    expect(describeHistory(new Error('boom'))).toBe('general');
    expect(describeHistory(new ApiError({ status: 418, code: 'TEAPOT', correlationId: 'c' }))).toBe('general');
    expect(isUuid(CONTRACTOR)).toBe(true);
    expect(isUuid('nope')).toBe(false);
  });
});
