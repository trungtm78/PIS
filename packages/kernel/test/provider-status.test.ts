import { UNCERTAIN_STATUS, defineStatusTable, reduceStatus } from '../src/provider-status.ts';

type Delivery = 'SENDING' | 'UNCERTAIN' | 'ACCEPTED' | 'DELIVERED' | 'READ' | 'FAILED';

const DELIVERY = defineStatusTable<Delivery>(
  'delivery',
  {
    SENDING: ['UNCERTAIN', 'ACCEPTED', 'FAILED'],
    UNCERTAIN: ['ACCEPTED', 'DELIVERED', 'FAILED'],
    ACCEPTED: ['DELIVERED', 'FAILED'],
    DELIVERED: ['READ'],
    READ: [],
    FAILED: [],
  },
  ['SENDING'],
);

describe('defineStatusTable', () => {
  it('computes what follows a status, through others', () => {
    expect([...(DELIVERY.after.get('SENDING') ?? [])].sort()).toEqual(['ACCEPTED', 'DELIVERED', 'FAILED', 'READ', 'UNCERTAIN']);
    expect([...(DELIVERY.after.get('READ') ?? [])]).toEqual([]);
    expect(UNCERTAIN_STATUS).toBe('UNCERTAIN');
  });

  it('refuses a cycle, a move to itself, an undeclared status and a bad start', () => {
    expect(() => defineStatusTable<string>('c', { A: ['B'], B: ['A'] }, ['A'])).toThrow('cycle');
    expect(() => defineStatusTable<string>('s', { A: ['A'] }, ['A'])).toThrow('itself');
    expect(() => defineStatusTable<string>('u', { A: ['Z'] }, ['A'])).toThrow('undeclared');
    expect(() => defineStatusTable<string>('i', { A: [] }, ['B'])).toThrow('initial');
    expect(() => defineStatusTable<string>('e', { A: [] }, [])).toThrow('initial');
  });

  it('accepts a diamond, where two paths reach one status', () => {
    const diamond = defineStatusTable('d', { A: ['B', 'C'], B: ['D'], C: ['D'], D: [] }, ['A']);
    expect([...(diamond.after.get('A') ?? [])].sort()).toEqual(['B', 'C', 'D']);
  });
});

describe('reduceStatus', () => {
  it.each<[Delivery, string, string]>([
    ['SENDING', 'ACCEPTED', 'APPLIED'],
    ['SENDING', 'DELIVERED', 'APPLIED'],
    ['ACCEPTED', 'DELIVERED', 'APPLIED'],
    ['UNCERTAIN', 'ACCEPTED', 'APPLIED'],
    ['SENDING', 'UNCERTAIN', 'APPLIED'],
    ['DELIVERED', 'DELIVERED', 'DUPLICATE'],
    ['DELIVERED', 'ACCEPTED', 'STALE'],
    ['READ', 'SENDING', 'STALE'],
    ['ACCEPTED', 'UNCERTAIN', 'STALE'],
    ['DELIVERED', 'FAILED', 'CONFLICT'],
    ['FAILED', 'DELIVERED', 'CONFLICT'],
    ['DELIVERED', 'BOUNCED', 'UNKNOWN_STATUS'],
  ])('%s receiving %s is %s', (current, incoming, outcome) => {
    expect(reduceStatus(DELIVERY, current, incoming)).toBe(outcome);
  });

  it('never moves backwards for any pair of statuses', () => {
    for (const from of DELIVERY.statuses) {
      for (const to of DELIVERY.statuses) {
        if (reduceStatus(DELIVERY, from, to) === 'APPLIED') {
          expect(reduceStatus(DELIVERY, to, from)).not.toBe('APPLIED');
        }
      }
    }
  });

  it('ends at DELIVERED for ACCEPTED, DELIVERED, a duplicate DELIVERED and a late ACCEPTED (AC-ST-KERNEL-071-1)', () => {
    let status: Delivery = 'SENDING';
    const outcomes: string[] = [];
    for (const incoming of ['ACCEPTED', 'DELIVERED', 'DELIVERED', 'ACCEPTED']) {
      const outcome = reduceStatus(DELIVERY, status, incoming);
      outcomes.push(outcome);
      if (outcome === 'APPLIED') status = incoming as Delivery;
    }
    expect(status).toBe('DELIVERED');
    expect(outcomes).toEqual(['APPLIED', 'APPLIED', 'DUPLICATE', 'STALE']);
  });
});
