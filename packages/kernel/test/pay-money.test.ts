import type { DomainError } from '../src/errors';
import {
  allocateLargestRemainder,
  computeDraftMoney,
  linesMatchHeader,
  partyRecovery,
  percentScaled,
  retentionOf,
  roundedDivision,
  signedDong,
  targetRecovered,
  wholeVnd,
} from '../src/pay-money';
import type { DraftMoneyInput, MoneyLine, PartyAdvance } from '../src/pay-money';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const B01 = '00000000-0000-4000-8000-000000000001';
const B02 = '00000000-0000-4000-8000-000000000002';
const SOLE = '00000000-0000-4000-8000-0000000000aa';
const line = (id: string, boqItemId: string, grossVnd: string, overrides: Partial<MoneyLine> = {}): MoneyLine => ({ acceptanceLineId: id, boqItemId, partyId: SOLE, grossVnd, retentionPct: '5', rounding: 'HALF_UP', ...overrides });
const advance = (overrides: Partial<PartyAdvance> = {}): PartyAdvance => ({
  partyId: SOLE,
  workValueVnd: '10000000000',
  previousGrossVnd: '0',
  tranches: [{ id: 't1', paidVnd: '2000000000', recoveredVnd: '0', thresholdPct: '80' }],
  ...overrides,
});
const input = (overrides: Partial<DraftMoneyInput> = {}): DraftMoneyInput => ({
  lines: [line('l1', B01, '2000000000'), line('l2', B02, '1000000000')],
  parties: [advance()],
  taxAdjustmentVnd: '0',
  extraRecoveryVnd: '0',
  ...overrides,
});

describe('the money of a payment request (ST-PAY-002)', () => {
  describe('amounts and percentages', () => {
    it('reads whole dong and percentages exactly, and refuses anything else as 422 VALIDATION_FAILED naming the field', () => {
      expect(wholeVnd('0', 'x')).toBe(0n);
      expect(wholeVnd('999999999999999999999999', 'x')).toBe(999999999999999999999999n);
      expect(signedDong('-1000000', 'x')).toBe(-1000000n);
      expect(percentScaled('80', 'x')).toBe(800000n);
      expect(percentScaled('7.5', 'x')).toBe(75000n);
      expect(percentScaled('0.0001', 'x')).toBe(1n);
      for (const bad of ['', '-1', '1.5', '01', 'x', '1'.repeat(25)]) expect(refusal(() => wholeVnd(bad, 'amount'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'amount' });
      for (const bad of ['1.5', '--1', '', '01']) expect(refusal(() => signedDong(bad, 'tax'))).toMatchObject({ detail: 'tax' });
      for (const bad of ['', '-5', '5.12345', '1000', 'x']) expect(refusal(() => percentScaled(bad, 'pct'))).toMatchObject({ detail: 'pct' });
    });

    it('rounds a division by the rule of the line', () => {
      expect(roundedDivision(10n, 4n, 'DOWN')).toBe(2n);
      expect(roundedDivision(10n, 4n, 'UP')).toBe(3n);
      expect(roundedDivision(10n, 4n, 'HALF_UP')).toBe(3n);
      expect(roundedDivision(10n, 4n, 'HALF_EVEN')).toBe(2n);
      expect(roundedDivision(14n, 4n, 'HALF_EVEN')).toBe(4n);
      expect(roundedDivision(9n, 4n, 'HALF_EVEN')).toBe(2n);
      expect(roundedDivision(11n, 4n, 'HALF_EVEN')).toBe(3n);
      expect(roundedDivision(8n, 4n, 'UP')).toBe(2n);
      expect(() => roundedDivision(1n, 0n, 'DOWN')).toThrow(RangeError);
      expect(() => roundedDivision(-1n, 3n, 'DOWN')).toThrow(RangeError);
    });

    it('BR-PAY-05: the retention of a line is its gross times its percentage, rounded as the line is', () => {
      expect(retentionOf('2000000000', '5', 'HALF_UP')).toBe('100000000');
      expect(retentionOf('1001', '5', 'HALF_UP')).toBe('50');
      expect(retentionOf('1010', '5', 'HALF_UP')).toBe('51');
      expect(retentionOf('1010', '5', 'DOWN')).toBe('50');
      expect(retentionOf('1010', '5', 'HALF_EVEN')).toBe('50');
      expect(retentionOf('1000', '2.5', 'HALF_UP')).toBe('25');
      expect(retentionOf('0', '5', 'UP')).toBe('0');
    });
  });

  describe('the advance to recover (BR-PAY-04)', () => {
    it('UAT-AC323: V = 10bn, A = 2bn, threshold 80 percent, gross to date 3bn recovers floor(2bn x 3/8) = 750,000,000', () => {
      expect(targetRecovered('2000000000', '10000000000', '80', '3000000000')).toBe('750000000');
      expect(partyRecovery(advance(), '3000000000')).toEqual({ recoveryVnd: '750000000', roomLeftVnd: '1250000000' });
    });

    it('recovers the whole advance from the threshold on, and floors the part before it', () => {
      expect(targetRecovered('2000000000', '10000000000', '80', '8000000000')).toBe('2000000000');
      expect(targetRecovered('2000000000', '10000000000', '80', '9000000000')).toBe('2000000000');
      expect(targetRecovered('2000000000', '10000000000', '80', '7999999999')).toBe('1999999999');
      expect(targetRecovered('100', '3', '100', '1')).toBe('33');
      expect(targetRecovered('1000', '0', '80', '5')).toBe('1000');
      expect(targetRecovered('0', '10000000000', '80', '3000000000')).toBe('0');
    });

    it('UAT-AC327: a member of a joint venture recovers on its own work, whatever the others do', () => {
      const m1 = advance({ partyId: 'm1', workValueVnd: '6000000000', tranches: [{ id: 'a', paidVnd: '900000000', recoveredVnd: '0', thresholdPct: '80' }] });
      expect(partyRecovery(m1, '2400000000').recoveryVnd).toBe('450000000');
      const later = advance({ partyId: 'm1', workValueVnd: '6000000000', previousGrossVnd: '2400000000', tranches: [{ id: 'a', paidVnd: '900000000', recoveredVnd: '450000000', thresholdPct: '80' }] });
      expect(partyRecovery(later, '2400000000')).toEqual({ recoveryVnd: '450000000', roomLeftVnd: '0' });
    });

    it('takes what the earlier requests did not, never below zero and never above what is outstanding', () => {
      const ahead = advance({ previousGrossVnd: '3000000000', tranches: [{ id: 't', paidVnd: '2000000000', recoveredVnd: '900000000', thresholdPct: '80' }] });
      // The target for 3bn is 750m, which is already recovered: nothing now.
      expect(partyRecovery(ahead, '0')).toEqual({ recoveryVnd: '0', roomLeftVnd: '1100000000' });
      const nearly = advance({ previousGrossVnd: '7000000000', tranches: [{ id: 't', paidVnd: '2000000000', recoveredVnd: '1900000000', thresholdPct: '80' }] });
      expect(partyRecovery(nearly, '3000000000')).toEqual({ recoveryVnd: '100000000', roomLeftVnd: '0' });
      expect(partyRecovery(advance({ tranches: [] }), '3000000000')).toEqual({ recoveryVnd: '0', roomLeftVnd: '0' });
      const unpaid = advance({ tranches: [{ id: 't', paidVnd: '0', recoveredVnd: '0', thresholdPct: '80' }] });
      expect(partyRecovery(unpaid, '3000000000')).toEqual({ recoveryVnd: '0', roomLeftVnd: '0' });
    });

    it('treats each tranche by its own threshold', () => {
      const two = advance({
        workValueVnd: '1000',
        tranches: [
          { id: 'a', paidVnd: '100', recoveredVnd: '0', thresholdPct: '50' },
          { id: 'b', paidVnd: '100', recoveredVnd: '0', thresholdPct: '100' },
        ],
      });
      // gross 250: tranche a is at 250/500 of the way, tranche b at 250/1000.
      expect(partyRecovery(two, '250').recoveryVnd).toBe(String(50 + 25));
    });
  });

  describe('the largest remainder (BR-PAY-07)', () => {
    const slots = (weights: bigint[]) => weights.map((weight, index) => ({ key: `k${index}`, weight, capacity: weight * 1000n }));

    it('UAT-AC324: 100 over gross 1:2 is 33 and 67, and 101 is 34 and 67', () => {
      expect(allocateLargestRemainder(100n, slots([1000000000n, 2000000000n]))).toEqual([33n, 67n]);
      expect(allocateLargestRemainder(101n, slots([1000000000n, 2000000000n]))).toEqual([34n, 67n]);
      expect(allocateLargestRemainder(0n, slots([1n, 2n]))).toEqual([0n, 0n]);
    });

    it('breaks a tie by the key ascending, whatever the order the lines come in, and is repeatable', () => {
      const three = [
        { key: 'b', weight: 1n, capacity: 10n },
        { key: 'a', weight: 1n, capacity: 10n },
        { key: 'c', weight: 1n, capacity: 10n },
      ];
      expect(allocateLargestRemainder(2n, three)).toEqual([0n, 1n, 1n].map((_, index) => [1n, 1n, 0n][index]));
      expect(allocateLargestRemainder(2n, three)).toEqual(allocateLargestRemainder(2n, three));
      expect(allocateLargestRemainder(1n, three)).toEqual([0n, 1n, 0n]);
    });

    it('never gives a line more than it can take and shares the rest among the others', () => {
      const capped = [
        { key: 'a', weight: 1n, capacity: 2n },
        { key: 'b', weight: 1n, capacity: 100n },
      ];
      expect(allocateLargestRemainder(10n, capped)).toEqual([2n, 8n]);
      expect(allocateLargestRemainder(1000n, capped)).toEqual([2n, 100n]);
      expect(allocateLargestRemainder(5n, [{ key: 'a', weight: 0n, capacity: 5n }])).toEqual([0n]);
      expect(allocateLargestRemainder(5n, [])).toEqual([]);
      expect(allocateLargestRemainder(5n, [{ key: 'a', weight: 1n, capacity: 0n }])).toEqual([0n]);
    });

    it('shares what a full line left when the remainder falls on it', () => {
      // 3 over weights 1:1 with the first line able to take 1 only: 1 and 2.
      expect(
        allocateLargestRemainder(3n, [
          { key: 'a', weight: 1n, capacity: 1n },
          { key: 'b', weight: 1n, capacity: 5n },
        ]),
      ).toEqual([1n, 2n]);
      // the remainder's first claimant is full already: the dong goes to the next one.
      expect(
        allocateLargestRemainder(2n, [
          { key: 'a', weight: 2n, capacity: 0n },
          { key: 'b', weight: 1n, capacity: 1n },
          { key: 'c', weight: 1n, capacity: 1n },
        ]),
      ).toEqual([0n, 1n, 1n]);
    });
  });

  describe('the draft (BR-PAY-03..06)', () => {
    it('AC-ST-PAY-002-1, UAT-AC323: gross 3bn, recovery 750m, retention 150m, net 2.1bn, with the lines B01 and B02', () => {
      const draft = computeDraftMoney(input());
      expect(draft).toMatchObject({ grossVnd: '3000000000', advanceRecoveryVnd: '750000000', retentionVnd: '150000000', taxAdjustmentVnd: '0', netVnd: '2100000000', formulaRecoveryVnd: '750000000' });
      expect(draft.lines).toEqual([
        { acceptanceLineId: 'l1', boqItemId: B01, partyId: SOLE, grossVnd: '2000000000', advanceRecoveryVnd: '500000000', retentionVnd: '100000000', netVnd: '1400000000' },
        { acceptanceLineId: 'l2', boqItemId: B02, partyId: SOLE, grossVnd: '1000000000', advanceRecoveryVnd: '250000000', retentionVnd: '50000000', netVnd: '700000000' },
      ]);
      expect(linesMatchHeader(draft, draft.lines)).toBe(true);
    });

    it('a signed tax adjustment moves the net of the header and not of the lines', () => {
      const draft = computeDraftMoney(input({ taxAdjustmentVnd: '-1000000' }));
      expect(draft.netVnd).toBe('2099000000');
      expect(draft.lines.map((item) => item.netVnd)).toEqual(['1400000000', '700000000']);
      expect(linesMatchHeader(draft, draft.lines)).toBe(true);
      expect(computeDraftMoney(input({ taxAdjustmentVnd: '5' })).netVnd).toBe('2100000005');
    });

    it('UAT-AC324: a header recovery of 100 (then 101) is shared 33/67 (34/67) over lines of gross 1:2', () => {
      const small = (recovery: number) =>
        computeDraftMoney({
          lines: [line('l1', B01, '1000000000', { retentionPct: '0' }), line('l2', B02, '2000000000', { retentionPct: '0' })],
          // paid 10bn, V 10bn, 100 percent: floor(10bn x 3bn / 10bn) = 3bn... scaled down: use a tranche whose target is exactly the recovery asked
          parties: [advance({ workValueVnd: '3000000000', tranches: [{ id: 't', paidVnd: String(recovery), recoveredVnd: '0', thresholdPct: '100' }] })],
          taxAdjustmentVnd: '0',
          extraRecoveryVnd: '0',
        });
      expect(small(100).lines.map((item) => item.advanceRecoveryVnd)).toEqual(['33', '67']);
      expect(small(101).lines.map((item) => item.advanceRecoveryVnd)).toEqual(['34', '67']);
      expect(small(101).advanceRecoveryVnd).toBe('101');
      expect(small(100)).toEqual(small(100));
    });

    it('keeps recovery and retention within the gross of each line, so no net is negative, and carries the rest to the next request', () => {
      const draft = computeDraftMoney({
        lines: [line('l1', B01, '1000', { retentionPct: '90' }), line('l2', B02, '1000', { retentionPct: '0' })],
        parties: [advance({ workValueVnd: '1000', tranches: [{ id: 't', paidVnd: '5000', recoveredVnd: '0', thresholdPct: '100' }] })],
        taxAdjustmentVnd: '0',
        extraRecoveryVnd: '0',
      });
      // The formula wants 2000 (all of gross 2000 against V 1000 is past the threshold: the whole 5000), the lines can carry 100 + 1000.
      expect(draft.formulaRecoveryVnd).toBe('5000');
      expect(draft.lines.map((item) => [item.advanceRecoveryVnd, item.retentionVnd, item.netVnd])).toEqual([
        ['100', '900', '0'],
        ['1000', '0', '0'],
      ]);
      expect(draft.advanceRecoveryVnd).toBe('1100');
      expect(linesMatchHeader(draft, draft.lines)).toBe(true);
    });

    it('recovers extra on top of the formula within the room the advance has left, and refuses more as 422', () => {
      const draft = computeDraftMoney(input({ extraRecoveryVnd: '100000000' }));
      expect(draft.advanceRecoveryVnd).toBe('850000000');
      expect(draft.formulaRecoveryVnd).toBe('750000000');
      expect(draft.netVnd).toBe(String(3000000000 - 850000000 - 150000000));
      expect(computeDraftMoney(input({ extraRecoveryVnd: '1250000000' })).advanceRecoveryVnd).toBe('2000000000');
      expect(refusal(() => computeDraftMoney(input({ extraRecoveryVnd: '1250000001' })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'advance_recovery_extra_vnd', extensions: { reason: 'EXTRA_EXCEEDS_OUTSTANDING' } });
    });

    it('gives each party of a joint venture its own recovery, shared over its own lines', () => {
      const draft = computeDraftMoney({
        lines: [line('l1', B01, '2400000000', { partyId: 'm1', retentionPct: '0' }), line('l2', B02, '1000000000', { partyId: 'm2', retentionPct: '0' })],
        parties: [
          advance({ partyId: 'm1', workValueVnd: '6000000000', tranches: [{ id: 'a', paidVnd: '900000000', recoveredVnd: '0', thresholdPct: '80' }] }),
          advance({ partyId: 'm2', workValueVnd: '4000000000', tranches: [{ id: 'b', paidVnd: '400000000', recoveredVnd: '0', thresholdPct: '80' }] }),
        ],
        taxAdjustmentVnd: '0',
        extraRecoveryVnd: '0',
      });
      expect(draft.lines.map((item) => [item.partyId, item.advanceRecoveryVnd])).toEqual([
        ['m1', '450000000'],
        ['m2', '125000000'],
      ]);
    });

    it('a party that holds no advance recovers nothing, and a request without lines is worth nothing', () => {
      const none = computeDraftMoney(input({ parties: [] }));
      expect(none.advanceRecoveryVnd).toBe('0');
      expect(none.netVnd).toBe('2850000000');
      expect(computeDraftMoney(input({ lines: [], parties: [] }))).toMatchObject({ grossVnd: '0', netVnd: '0', lines: [] });
      expect(computeDraftMoney(input({ lines: [line('l1', B01, '0')], parties: [advance()] })).advanceRecoveryVnd).toBe('0');
    });

    it('refuses amounts that are not whole dong', () => {
      expect(refusal(() => computeDraftMoney(input({ taxAdjustmentVnd: '1.5' })))).toMatchObject({ detail: 'tax_adjustment_vnd' });
      expect(refusal(() => computeDraftMoney(input({ extraRecoveryVnd: '-1' })))).toMatchObject({ detail: 'advance_recovery_extra_vnd' });
      expect(refusal(() => computeDraftMoney(input({ lines: [line('l1', B01, 'x')] })))).toMatchObject({ detail: 'gross_vnd' });
    });
  });

  describe('lines and header (AC-ST-PAY-002-3, UAT-AC64)', () => {
    const header = { grossVnd: '3000000000', advanceRecoveryVnd: '750000000', retentionVnd: '150000000', taxAdjustmentVnd: '0', netVnd: '2100000000' };
    const lines = [
      { grossVnd: '2000000000', advanceRecoveryVnd: '500000000', retentionVnd: '100000000', netVnd: '1400000000' },
      { grossVnd: '1000000000', advanceRecoveryVnd: '250000000', retentionVnd: '50000000', netVnd: '700000000' },
    ];

    it('accepts lines that add up to the header and refuses any that do not', () => {
      expect(linesMatchHeader(header, lines)).toBe(true);
      expect(linesMatchHeader(header, [lines[0]!, { ...lines[1]!, netVnd: '699999999' }])).toBe(false);
      expect(linesMatchHeader(header, [lines[0]!, { ...lines[1]!, grossVnd: '999999999' }])).toBe(false);
      expect(linesMatchHeader(header, [lines[0]!, { ...lines[1]!, advanceRecoveryVnd: '1' }])).toBe(false);
      expect(linesMatchHeader(header, [lines[0]!, { ...lines[1]!, retentionVnd: '1' }])).toBe(false);
      expect(linesMatchHeader({ ...header, netVnd: '2100000001' }, lines)).toBe(false);
      expect(linesMatchHeader({ ...header, taxAdjustmentVnd: '-5', netVnd: '2099999995' }, lines)).toBe(true);
    });
  });
});
