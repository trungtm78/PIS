import { describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { typeLabel } from './labels';
import { NODE_TYPES, chainLink, childrenOf, correctsOf, nodeLink, nodesOf, toChain, vndText } from './model';
import { PROJECT, chain, contractOf, node, nodeId } from './test-support';

const t = (key: string): string => (vi_ as Record<string, string>)[key] ?? `missing:${key}`;

describe('reading the chain of a payment', () => {
  it('reads the answer of the server with its nodes, its edges and its totals', () => {
    const read = toChain(chain());
    expect(read).toMatchObject({
      projectId: PROJECT,
      contractId: contractOf(1),
      countedRequests: 1,
      countedGrossVnd: '3000000000',
      settledGrossVnd: '3000000000',
      truncated: [],
      asOf: '2026-10-26T05:00:00.000Z',
    });
    expect(read?.nodes.map((candidate) => candidate.type)).toEqual([
      'project',
      'contract',
      'measurement',
      'measurement',
      'acceptance',
      'payment_request',
      'treasury_transaction',
      'settlement_revision',
    ]);
    expect(read?.edges).toHaveLength(8);
    const contract = read?.nodes.find((candidate) => candidate.type === 'contract');
    expect(contract).toMatchObject({ id: contractOf(1), version: 7, revision: 1, status: 'ACTIVE', label: 'HD-001', amountVnd: '9000000000', superseded: false });
    expect(read?.nodes.find((candidate) => candidate.type === 'treasury_transaction')?.version).toBeNull();
  });

  it('keeps only the facts that are plain and a node that is whole', () => {
    const read = toChain(
      chain({
        nodes: [
          node('project', PROJECT, { facts: { name: 'Cầu', size: 3, ok: true, none: null, nested: { a: 1 }, list: [1] }, amount_vnd: '1.5', version: 'x', revision: 1.5 }),
          node('unknown', nodeId('0001', 9)),
          { type: 'contract' },
          'x',
        ],
        edges: [{ from: 'a', to: 'b', relation: 'HAS_CONTRACT' }, { from: 'a' }, 'x'],
        truncated: ['measurement', 'planet'],
      }),
    );
    expect(read?.nodes).toHaveLength(1);
    expect(read?.nodes[0]).toMatchObject({ facts: { name: 'Cầu', size: 3, ok: true, none: null }, amountVnd: null, version: null, revision: null, label: PROJECT.slice(-8) });
    expect(Object.keys(read?.nodes[0]?.facts ?? {})).toEqual(['name', 'size', 'ok', 'none']);
    expect(read?.edges).toEqual([{ from: 'a', to: 'b', relation: 'HAS_CONTRACT' }]);
    expect(read?.truncated).toEqual(['measurement']);
  });

  it('refuses an answer that is not a chain, rather than showing half of one', () => {
    expect(toChain(undefined)).toBeUndefined();
    expect(toChain('x')).toBeUndefined();
    expect(toChain(chain({ project_id: 7 }))).toBeUndefined();
    expect(toChain(chain({ nodes: 'x' }))).toBeUndefined();
    expect(toChain(chain({ totals: undefined }))).toBeUndefined();
    expect(toChain(chain({ totals: { counted_requests: 1, counted_gross_vnd: '3.5', settled_gross_vnd: '3' } }))).toBeUndefined();
    expect(toChain(chain({ totals: { counted_requests: 1, counted_gross_vnd: '3', settled_gross_vnd: 'x' } }))).toBeUndefined();
    expect(toChain(chain({ totals: { counted_requests: 'x', counted_gross_vnd: '3', settled_gross_vnd: '3' } }))).toBeUndefined();
    expect(toChain(chain({ edges: undefined, truncated: undefined, as_of: undefined, contract_id: undefined }))).toMatchObject({ edges: [], truncated: [], asOf: '', contractId: null });
  });

  it('finds the nodes of a type, the nodes a node leads to without the corrections, and what a correction corrects', () => {
    const read = toChain(chain());
    if (read === undefined) throw new Error('no chain');
    expect(nodesOf(read, 'measurement')).toHaveLength(2);
    expect(nodesOf(read, 'settlement_revision')).toHaveLength(1);
    expect(childrenOf(read, nodeId('0070', 2))).toEqual([]);
    expect(childrenOf(read, nodeId('0090', 1)).map((candidate) => candidate.type)).toEqual(['treasury_transaction', 'settlement_revision']);
    expect(correctsOf(nodesOf(read, 'measurement')[1]!)).toBe(nodeId('0070', 1));
    expect(correctsOf(nodesOf(read, 'measurement')[0]!)).toBeNull();
  });

  it('leads each node to the screen where it is worked on', () => {
    const read = toChain(chain());
    if (read === undefined) throw new Error('no chain');
    const link = (type: (typeof NODE_TYPES)[number]) => nodeLink(nodesOf(read, type)[0]!);
    expect(link('project')).toBe(`/prj/prj-03?id=${PROJECT}`);
    expect(link('contract')).toBe(`/ctr/ctr-03?id=${contractOf(1)}`);
    expect(link('measurement')).toContain(contractOf(1));
    expect(link('acceptance')).toContain(contractOf(1));
    expect(link('payment_request')).toBe(`/pay/pay-03?request=${nodeId('0090', 1)}`);
    expect(link('treasury_transaction')).toBe('/pay/pay-05');
    expect(link('settlement_revision')).toBe(`/pay/pay-15?settlement=${nodeId('0150', 1)}`);
    const loose = toChain(chain({ nodes: [node('measurement', nodeId('0070', 9)), node('acceptance', nodeId('0080', 9))] }))?.nodes ?? [];
    expect(loose.map((candidate) => nodeLink(candidate))).toEqual([undefined, undefined]);
    expect(chainLink(PROJECT)).toBe(`/pay/pay-17?project=${PROJECT}`);
    expect(chainLink(PROJECT, contractOf(1))).toBe(`/pay/pay-17?project=${PROJECT}&contract=${contractOf(1)}`);
  });

  it('writes an amount the way the locale does and has a word for every kind of node', () => {
    expect(vndText('3000000000', 'vi')).toBe('3.000.000.000');
    expect(vndText('abc', 'vi')).toBe('abc');
    const words = NODE_TYPES.map((type) => typeLabel(t, type));
    expect(new Set(words).size).toBe(words.length);
    expect(words.join()).not.toContain('missing:');
  });
});
