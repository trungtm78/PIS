import { linesOfContract } from '../src/index';

/**
 * The lines of DS-CTR of one contract (CA-1, R16): one per active party, the money spread by the largest remainder so that the lines add up to the contract to the dong, the flags and the days late on the lead line
 * only. Pure: no database.
 */

const BASE = {
  fact_text: '{}',
  id: 'c1',
  contractor_id: 'k1',
  project_id: 'p1',
  unit_id: 'u1',
  investor_id: null,
  fund_source_version_id: null,
  contract_status: 'ACTIVE',
  contract_type: 'LUMP_SUM',
  contract_value_vnd: '100',
  original_value_vnd: '90',
  approved_change_delta_vnd: '10',
  winning_bid_vnd: '80',
  requested_vnd: '50',
  accepted_vnd: '50',
  paid_vnd: '40',
  advance_paid_vnd: '10',
  advance_recovered_vnd: '4',
  advance_outstanding_vnd: '6',
  retention_withheld_vnd: '5',
  retention_released_vnd: '1',
  retention_held_vnd: '4',
  guarantee_required_vnd: '7',
  guarantee_valid_vnd: '7',
  bidder_count: 1,
  days_late: 12,
};

const sumOf = (lines: ReturnType<typeof linesOfContract>, field: string): bigint => lines.reduce((acc, line) => acc + BigInt((line.values[field] as string | null) ?? '0'), 0n);

describe('the lines of DS-CTR of a contract', () => {
  it('is one line with the whole contract for a contract with no parties, flags on it', () => {
    const lines = linesOfContract(BASE, []);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ contractorId: 'k1', isLead: true, sharePct: '100.0000' });
    expect(lines[0]?.values).toMatchObject({ contract_value_vnd: '100', active_value_vnd: '100', bid_variance_vnd: '10', single_bidder_flag: 1, bidder_known_flag: 1, days_late: 12 });
  });

  it('spreads every money field by the largest remainder so the lines add up to the contract exactly, whatever the shares', () => {
    const parties = [
      { contractorId: 'k1', sharePct: '33.3334', role: 'LEAD' },
      { contractorId: 'k2', sharePct: '33.3333', role: 'MEMBER' },
      { contractorId: 'k3', sharePct: '33.3333', role: 'MEMBER' },
    ];
    const lines = linesOfContract({ ...BASE, contract_value_vnd: '1000000000001', original_value_vnd: '999999999999', winning_bid_vnd: '7' }, parties);
    expect(lines).toHaveLength(3);
    expect(sumOf(lines, 'contract_value_vnd')).toBe(1_000_000_000_001n);
    expect(sumOf(lines, 'original_value_vnd')).toBe(999_999_999_999n);
    expect(sumOf(lines, 'winning_bid_vnd')).toBe(7n);
    expect(sumOf(lines, 'bid_variance_vnd')).toBe(999_999_999_992n);
    for (const field of ['requested_vnd', 'accepted_vnd', 'paid_vnd', 'advance_paid_vnd', 'advance_outstanding_vnd', 'retention_held_vnd', 'guarantee_required_vnd']) {
      expect(sumOf(lines, field)).toBe(BigInt((BASE as unknown as Record<string, string>)[field] as string));
    }
    // the shares as written add up to a hundred percent
    expect(lines.map((line) => line.sharePct)).toEqual(['33.3334', '33.3333', '33.3333']);
  });

  it('puts the flags and the days late on the lead line only, and nothing on the others', () => {
    const lines = linesOfContract(BASE, [
      { contractorId: 'k1', sharePct: '50.0000', role: 'MEMBER' },
      { contractorId: 'k2', sharePct: '50.0000', role: 'LEAD' },
    ]);
    const lead = lines.find((line) => line.isLead);
    expect(lead?.contractorId).toBe('k2');
    expect(lead?.values).toMatchObject({ single_bidder_flag: 1, bidder_known_flag: 1, days_late: 12 });
    const other = lines.find((line) => !line.isLead);
    expect(other?.values).toMatchObject({ single_bidder_flag: null, bidder_known_flag: null, days_late: null });
  });

  it('says nothing, not zero, for an advance, a retention, a guarantee or a bid the contract never had', () => {
    const lines = linesOfContract({ ...BASE, advance_paid_vnd: '0', advance_recovered_vnd: '0', advance_outstanding_vnd: '0', retention_withheld_vnd: '0', retention_released_vnd: '0', retention_held_vnd: '0', guarantee_required_vnd: null, guarantee_valid_vnd: null, winning_bid_vnd: null, bidder_count: null, days_late: null }, []);
    expect(lines[0]?.values).toMatchObject({ advance_paid_vnd: null, advance_outstanding_vnd: null, retention_withheld_vnd: null, guarantee_required_vnd: null, guarantee_valid_vnd: null, winning_bid_vnd: null, bid_variance_vnd: null, single_bidder_flag: null, bidder_known_flag: null, days_late: null });
  });

  it('counts the active value of a contract that is not active as zero, and the same contractor named twice as one party', () => {
    const draft = linesOfContract({ ...BASE, contract_status: 'DRAFT' }, []);
    expect(draft[0]?.values).toMatchObject({ contract_value_vnd: '100', active_value_vnd: '0' });
    const twice = linesOfContract(BASE, [
      { contractorId: 'k1', sharePct: '30.0000', role: 'LEAD' },
      { contractorId: 'k1', sharePct: '20.0000', role: 'MEMBER' },
      { contractorId: 'k2', sharePct: '50.0000', role: 'MEMBER' },
    ]);
    expect(twice).toHaveLength(2);
    expect(twice.map((line) => [line.contractorId, line.values.contract_value_vnd]).sort()).toEqual([['k1', '50'], ['k2', '50']]);
  });
});
