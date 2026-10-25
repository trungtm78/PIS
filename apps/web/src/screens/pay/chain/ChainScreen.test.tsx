import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import ChainScreen from './ChainScreen';
import { AUDITOR, AUDITOR_WITHOUT_LIST, NOBODY, OTHER_PROJECT, PROJECT, chain, client, contractOf, mount, node, nodeId, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('PAY-17', 'FR-PAY-17');
const PATH = `/pay/pay-17?project=${PROJECT}&contract=${contractOf(1)}`;
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open(state: World, options: { path?: string; permissions?: readonly string[] } = {}) {
  const h = client(state);
  mount(<ChainScreen route={ROUTE} />, h, { permissions: options.permissions ?? AUDITOR, path: options.path ?? PATH });
  return h;
}

const rowOf = (id: string): HTMLElement => document.querySelector(`li[data-node="${id}"]`) as HTMLElement;
const listOf = (type: string): HTMLElement => document.querySelector(`article[data-type="${type}"]`) as HTMLElement;

describe('ChainScreen (PAY-17): the trace of a payment', () => {
  it('says so when the caller may not read the chain, and reads nothing', async () => {
    const h = open(world(), { permissions: NOBODY });
    expect((await screen.findByTestId('no-read')).textContent).toBe(vi_['pay.chain.read.denied']);
    expect(h.read).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pay.chain.title']);
    expect(screen.getByText(text('pay.chain.footer', { id: 'PAY-17', req: 'FR-PAY-17' }))).toBeTruthy();
  });

  it('asks for a project when the address names none', async () => {
    const h = open(world(), { path: '/pay/pay-17' });
    expect((await screen.findByTestId('pick')).textContent).toBe(vi_['pay.chain.pick.none']);
    expect(h.read).not.toHaveBeenCalled();
    cleanup();
    open(world(), { path: '/pay/pay-17?project=nope' });
    expect((await screen.findByTestId('pick')).textContent).toBe(vi_['pay.chain.pick.none']);
  });

  it('UI-PAY-17: lists the seven kinds of node in the order of the chain, each with its version, and the totals', async () => {
    open(world());
    await screen.findByTestId('counted-requests');
    expect([...document.querySelectorAll('article[data-type]')].map((article) => article.getAttribute('data-type'))).toEqual([
      'project',
      'contract',
      'measurement',
      'acceptance',
      'payment_request',
      'treasury_transaction',
      'settlement_revision',
    ]);
    const projectRow = rowOf(PROJECT);
    expect(within(projectRow).getByTestId('label').textContent).toBe('DA-001');
    expect(within(projectRow).getByTestId('version').textContent).toBe(text('pay.chain.version.of', { version: 4 }));
    const contractRow = rowOf(contractOf(1));
    expect(within(contractRow).getByTestId('version').textContent).toBe(`${text('pay.chain.version.of', { version: 7 })} · ${text('pay.chain.revision.of', { revision: 1 })}`);
    expect(within(contractRow).getByTestId('amount').textContent).toContain('9.000.000.000');
    const payment = rowOf(nodeId('0090', 1));
    expect(within(payment).getByTestId('status').textContent).toBe('SETTLED');
    expect(within(payment).getByTestId('amount').textContent).toContain('3.000.000.000');
    expect((within(payment).getByTestId('open') as HTMLAnchorElement).getAttribute('href')).toBe(`/pay/pay-03?request=${nodeId('0090', 1)}`);
    expect(within(rowOf(nodeId('0100', 1))).getByTestId('version').textContent).toBe(vi_['pay.chain.version.none']);
    expect((within(rowOf(nodeId('0100', 1))).getByTestId('open') as HTMLAnchorElement).getAttribute('href')).toBe('/pay/pay-05');
    expect((within(rowOf(nodeId('0150', 1))).getByTestId('open') as HTMLAnchorElement).getAttribute('href')).toBe(`/pay/pay-15?settlement=${nodeId('0150', 1)}`);
    expect((within(projectRow).getByTestId('open') as HTMLAnchorElement).getAttribute('href')).toContain('/prj/prj-03');
    expect((within(contractRow).getByTestId('open') as HTMLAnchorElement).getAttribute('href')).toContain('/ctr/ctr-03');
    expect((within(rowOf(nodeId('0080', 1))).getByTestId('open') as HTMLAnchorElement).getAttribute('href')).toContain(contractOf(1));
    expect(screen.getByTestId('counted-requests').textContent).toBe('1');
    expect(screen.getByTestId('counted-gross').textContent).toBe('3.000.000.000');
    expect(screen.getByTestId('settled-gross').textContent).toBe('3.000.000.000');
    expect(screen.getByTestId('as-of').textContent).toContain('26/10/26');
    expect(screen.queryByTestId('truncated')).toBeNull();
  });

  it('shows a corrected measurement as the new revision and the old one superseded, and the acceptance linked to the one it used', async () => {
    open(world());
    await screen.findByTestId('counted-requests');
    const first = rowOf(nodeId('0070', 1));
    const second = rowOf(nodeId('0070', 2));
    expect(first.getAttribute('data-superseded')).toBe('yes');
    expect(within(first).getByTestId('superseded').textContent).toBe(vi_['pay.chain.superseded']);
    expect(within(first).getByTestId('version').textContent).toContain(text('pay.chain.revision.of', { revision: 1 }));
    expect(within(first).getByTestId('leads-to').textContent).toContain('1');
    expect(second.getAttribute('data-superseded')).toBe('no');
    expect(within(second).getByTestId('corrects').textContent).toContain(vi_['pay.chain.corrects']);
    expect(within(second).getByTestId('version').textContent).toContain(text('pay.chain.revision.of', { revision: 2 }));
    expect(within(second).queryByTestId('leads-to')).toBeNull();
    expect(within(listOf('measurement')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('says so in words when a kind of node is empty, and when the chain was cut', async () => {
    const empty = chain({
      nodes: [node('project', PROJECT, { label: 'DA-001' })],
      edges: [],
      truncated: ['measurement', 'payment_request'],
      totals: { counted_requests: 0, counted_gross_vnd: '0', settled_gross_vnd: '0' },
      as_of: '',
    });
    open(world({ chains: [empty] }));
    await screen.findByTestId('counted-requests');
    expect(within(listOf('contract')).getByTestId('none').textContent).toBe(vi_['pay.chain.type.none']);
    expect(screen.getByTestId('truncated').textContent).toBe(text('pay.chain.truncated', { types: `${vi_['pay.chain.type.measurement']}, ${vi_['pay.chain.type.paymentRequest']}` }));
    expect(screen.queryByTestId('as-of')).toBeNull();
    expect(screen.getByTestId('counted-gross').textContent).toBe('0');
  });

  it('says a project that is not there for the caller is not there, and says nothing of what exists', async () => {
    open(world(), { path: `/pay/pay-17?project=${OTHER_PROJECT}` });
    expect((await screen.findByTestId('not-found')).textContent).toBe(vi_['pay.chain.error.notFound']);
    expect(screen.queryByTestId('counted-requests')).toBeNull();
  });

  it('fails in words when the chain cannot be read, and reads again on retry', async () => {
    const state = world();
    state.failing.add('getPaymentChain');
    open(state);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('picks the project from the list and then a contract of its chain, and goes back to all the contracts', async () => {
    const whole = chain({ contract_id: null });
    const state = world({ chains: [whole] });
    open(state, { path: '/pay/pay-17' });
    await screen.findByLabelText(vi_['pay.chain.pick.project']);
    await waitFor(() => expect(document.getElementById('chain-project')?.tagName).toBe('SELECT'));
    const project = document.getElementById('chain-project') as HTMLSelectElement;
    await waitFor(() => expect(document.querySelectorAll('#chain-project option').length).toBe(2));
    fireEvent.change(project, { target: { value: PROJECT } });
    await screen.findByTestId('counted-requests');
    const contract = document.getElementById('chain-contract') as HTMLSelectElement;
    expect([...contract.options].map((option) => option.textContent)).toEqual([vi_['pay.chain.pick.contract.all'], 'HD-001']);
    fireEvent.change(contract, { target: { value: contractOf(1) } });
    await waitFor(() => expect((document.getElementById('chain-contract') as HTMLSelectElement).value).toBe(contractOf(1)));
    fireEvent.change(document.getElementById('chain-contract') as HTMLSelectElement, { target: { value: '' } });
    await waitFor(() => expect((document.getElementById('chain-contract') as HTMLSelectElement).value).toBe(''));
    fireEvent.change(document.getElementById('chain-project') as HTMLSelectElement, { target: { value: '' } });
    expect((await screen.findByTestId('pick')).textContent).toBe(vi_['pay.chain.pick.none']);
  });

  it('keeps the contract picked in the picker even when the chain does not list it, and takes a typed project when the projects cannot be listed', async () => {
    const odd = chain({ contract_id: contractOf(9) });
    open(world({ chains: [odd] }), { path: `/pay/pay-17?project=${PROJECT}&contract=${contractOf(9)}` });
    await screen.findByTestId('counted-requests');
    expect([...(document.getElementById('chain-contract') as HTMLSelectElement).options].map((option) => option.value)).toEqual(['', contractOf(1), contractOf(9)]);
    cleanup();
    open(world(), { path: '/pay/pay-17', permissions: AUDITOR_WITHOUT_LIST });
    const input = (await screen.findByLabelText(vi_['pay.chain.pick.project'])) as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    fireEvent.change(input, { target: { value: PROJECT } });
    fireEvent.blur(input);
    await screen.findByTestId('counted-requests');
    fireEvent.change(document.getElementById('chain-project') as HTMLInputElement, { target: { value: 'nope' } });
    fireEvent.blur(document.getElementById('chain-project') as HTMLInputElement);
    expect((await screen.findByTestId('pick')).textContent).toBe(vi_['pay.chain.pick.none']);
  });
});
