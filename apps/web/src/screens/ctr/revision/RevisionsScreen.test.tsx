import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { PROJECT, UUID_A, active, client, contractId, mount, requestId, routeOf, world } from '../change/test-support';
import type { World } from '../change/test-support';
import { revision } from '../test-support';
import RevisionsScreen from './RevisionsScreen';

const ROUTE = routeOf('CTR-26', 'FR-CTR-26');
const PATH = `/ctr/ctr-26?id=${contractId(1)}`;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const history = () => [
  revision(1, { id: 'r1', revision: 1, status: 'SUPERSEDED', amount_vnd: '10000000000', valid_from: '2026-01-02', valid_until: '2026-08-01', boq_total_vnd: '10000000000', boq_line_count: 2 }),
  revision(1, { id: 'r2', revision: 2, status: 'EFFECTIVE', kind: 'CHANGE_ORDER', amount_vnd: '10500000000', valid_from: '2026-08-01', supersedes_id: 'r1', change_request_id: requestId(1), change_request_code: 'CO-001', boq_total_vnd: '10000000000', boq_line_count: 2 }),
  revision(1, { id: UUID_A, revision: 3, status: 'PENDING_EFFECTIVE', kind: 'CHANGE_ORDER', amount_vnd: '10200000000', valid_from: '2999-12-01', supersedes_id: 'r2', change_request_id: requestId(2), boq_total_vnd: '10200000000', boq_line_count: 2 }),
];
const stateOf = (overrides: Partial<World> = {}): World => world({ details: [active({ revisions: history() })], ...overrides });

function open(state: World, path = PATH) {
  const h = client(state);
  mount(<RevisionsScreen route={ROUTE} />, h, { permissions: ['contract.read'], path });
  return h;
}

describe('RevisionsScreen (CTR-26): the revisions of a contract and when they apply', () => {
  it('asks for a contract when the address names none, and reads it once one is chosen', async () => {
    const h = open(stateOf(), '/ctr/ctr-26');
    await screen.findByRole('heading', { level: 2, name: vi_['ctr.revision.pick.title'] });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['ctr.revision.versions.title']);
    expect(document.querySelectorAll('#versions-contract option')).toHaveLength(5);
    fireEvent.change(document.getElementById('versions-contract') as HTMLElement, { target: { value: '' } });
    expect(h.read).not.toHaveBeenCalled();
    fireEvent.change(document.getElementById('versions-contract') as HTMLElement, { target: { value: contractId(1) } });
    await screen.findByTestId('timeline');
    expect(h.read).toHaveBeenCalledWith('get_resources_contract_id', { path: { id: contractId(1) } });
  });

  it('UI-CTR-26: shows the contract and each revision in order with when it applies, what it adds, where it came from and how far its BOQ covers it', async () => {
    open(stateOf());
    await screen.findByTestId('timeline');
    expect(screen.getByTestId('contract-code').textContent).toBe('HD-A-001');
    expect(screen.getByTestId('value').textContent).toBe(text('ctr.value.amount', { amount: '10.200.000.000' }));
    expect(screen.getByTestId('workspace-link').getAttribute('href')).toBe(`/ctr/ctr-03?id=${contractId(1)}`);
    const items = Array.from(document.querySelectorAll('[data-revision]'));
    expect(items.map((item) => [item.getAttribute('data-revision'), item.getAttribute('data-standing')])).toEqual([
      ['1', 'OVER'],
      ['2', 'IN_FORCE'],
      ['3', 'WAITING'],
    ]);
    const [first, second, third] = items as HTMLElement[];
    expect(within(first!).getByTestId('standing').textContent).toBe(vi_['ctr.revision.standing.over']);
    expect(within(first!).getByTestId('period').textContent).toBe(text('ctr.revision.period.closed', { from: '2026-01-02', until: '2026-08-01' }));
    expect(within(first!).queryByTestId('delta')).toBeNull();
    expect(within(second!).getByTestId('standing').textContent).toBe(vi_['ctr.revision.standing.inForce']);
    expect(within(second!).getByTestId('period').textContent).toBe(text('ctr.revision.period.open', { from: '2026-08-01' }));
    expect(within(second!).getByTestId('amount').textContent).toBe(`${text('ctr.value.amount', { amount: '10.500.000.000' })} (+500.000.000)`);
    expect(within(second!).getByTestId('source-link').getAttribute('href')).toBe(`/ctr/ctr-08?project=${PROJECT}&request=${requestId(1)}`);
    expect(within(second!).getByTestId('source-link').textContent).toBe('CO-001');
    expect(within(second!).getByTestId('boq-short').textContent).toContain(text('ctr.revision.boq.short', { short: '500.000.000' }));
    expect(within(second!).getByTestId('retroactive').textContent).toBe(vi_['ctr.revision.retroactive.no']);
    expect(within(third!).getByTestId('amount').textContent).toBe(`${text('ctr.value.amount', { amount: '10.200.000.000' })} (-300.000.000)`);
    expect(within(third!).getByTestId('source-link').textContent).toBe(requestId(2));
    expect(within(third!).queryByTestId('boq-short')).toBeNull();
    expect(screen.getByText(text('ctr.revision.versions.footer', { id: 'CTR-26', req: 'FR-CTR-26' }))).toBeTruthy();
  });

  it('AC-ST-CTR-007-2, UAT-AC58: says a revision that waits for its day is not used for payment, and that the old one still prices the work until then', async () => {
    open(stateOf());
    await screen.findByTestId('timeline');
    const pending = document.querySelector('[data-revision="3"]') as HTMLElement;
    expect(within(pending).getByTestId('standing').textContent).toBe(vi_['ctr.revision.standing.waiting']);
    expect(within(pending).getByTestId('standing').className).toContain('warning');
    expect(within(pending).getByTestId('waiting-notice').textContent).toBe(text('ctr.revision.waiting.notice', { day: '2999-12-01' }));
    expect(document.querySelectorAll('[data-testid="waiting-notice"]')).toHaveLength(1);
    expect(within(pending).getByRole('link', { name: text('ctr.revision.boq.covers', { lines: 2, total: '10.200.000.000' }) }).getAttribute('href')).toBe(`/ctr/ctr-04?id=${contractId(1)}&revision=${UUID_A}`);
  });

  it('shows a revision that reaches back as retroactive, and a contract with no revision as empty', async () => {
    open(stateOf({ details: [active({ revisions: [revision(1, { id: 'r1', status: 'EFFECTIVE', retroactive: true })] })] }));
    await screen.findByTestId('timeline');
    expect(screen.getByTestId('retroactive').textContent).toBe(vi_['ctr.revision.retroactive.yes']);
    cleanup();
    open(stateOf({ details: [active({ revisions: [] })] }));
    expect((await screen.findByTestId('no-revisions')).textContent).toBe(vi_['ctr.revision.versions.empty']);
  });

  it('UI-CTR-26, AC-ST-CTR-016-1, UAT-AC58: lists, on a revision that reaches back, the acceptances it re-priced with the difference on each, and links to the adjustment', async () => {
    const adjustment = {
      id: 'adj-1',
      change_request_id: requestId(2),
      change_request_code: 'CO-002',
      revision_id: 'r2',
      effective_on: '2026-06-01',
      approved_on: '2026-08-10',
      basis: 'The owner agreed the new price from 1 June.',
      decision_document_version_id: UUID_A,
      total_delta_vnd: '50000000',
      affected: [{ id: 'l1', acceptance_id: UUID_A, acceptance_no: 'NT-001', boq_item_key: 'B02', party_id: null, quantity: '500.000000', old_amount_vnd: '1000000000', new_unit_price: '2100000.000000', new_amount_vnd: '1050000000', delta_vnd: '50000000' }],
    };
    const rows = [
      revision(1, { id: 'r1', revision: 1, status: 'SUPERSEDED', valid_until: '2026-08-10' }),
      revision(1, { id: 'r2', revision: 2, status: 'EFFECTIVE', kind: 'CHANGE_ORDER', retroactive: true, valid_from: '2026-08-10', supersedes_id: 'r1', change_request_id: requestId(2), change_request_code: 'CO-002' }),
    ];
    open(stateOf({ details: [active({ revisions: rows, retroactive_adjustments: [adjustment] })] }));
    await screen.findByTestId('timeline');
    const [first, second] = Array.from(document.querySelectorAll('[data-revision]')) as HTMLElement[];
    expect(within(first!).queryByTestId('retroactive-block')).toBeNull();
    const block = within(second!).getByTestId('retroactive-block');
    expect(within(block).getByTestId('adjustment-effective').textContent).toBe('2026-06-01');
    expect(within(block).getByTestId('adjustment-basis').textContent).toBe('The owner agreed the new price from 1 June.');
    expect(within(block).getByTestId('line-delta').textContent).toBe('+50.000.000');
    expect(within(block).getByText('NT-001')).toBeTruthy();
    expect(within(block).getByTestId('retro-link').getAttribute('href')).toBe(`/ctr/ctr-14?id=${contractId(1)}&request=${requestId(2)}`);
  });

  it('shows the flag and the link of a revision that reaches back, and no money, to a reader without the ledger', async () => {
    open(stateOf({ details: [active({ revisions: [revision(1, { id: 'r1', status: 'EFFECTIVE', retroactive: true })] })] }));
    await screen.findByTestId('timeline');
    expect(screen.getByTestId('retroactive-block')).toBeTruthy();
    expect(screen.queryByTestId('adjustment-total')).toBeNull();
    expect(screen.getByTestId('retro-link').getAttribute('href')).toBe(`/ctr/ctr-14?id=${contractId(1)}`);
  });

  it('answers a failed read with the error state, and a contract out of reach with the error state of a miss', async () => {
    const state = stateOf({ failing: new Set(['get_resources_contract_id']) });
    const h = open(state);
    const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
    state.failing.clear();
    fireEvent.click(retry);
    await screen.findByTestId('timeline');
    expect(h.read.mock.calls.filter(([operation]) => operation === 'get_resources_contract_id')).toHaveLength(2);
    cleanup();
    open(stateOf({ details: [] }), `/ctr/ctr-26?id=${contractId(9)}`);
    expect(await screen.findByRole('button', { name: vi_['states.retry.action'] })).toBeTruthy();
  });
});
