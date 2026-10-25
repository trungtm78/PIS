import type { RevisionRow } from '@machvon/db';
import { revisionView } from '../../src/modules/ctr/contract-view';

const row = (overrides: Partial<RevisionRow> = {}): RevisionRow => ({
  id: 'r1',
  contractId: 'c1',
  contractCode: 'HD-001',
  revision: 1,
  kind: 'BASE',
  status: 'EFFECTIVE',
  amountVnd: '10000000000',
  documentVersionId: 'd1',
  validFrom: '2026-01-02',
  validUntil: null,
  retroactive: false,
  decidedAt: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  boqTotalVnd: '10000000000',
  boqLineCount: 2,
  supersedesId: null,
  changeRequest: null,
  reach: { contractId: 'c1', projectId: 'p1', ownerUnit: { id: 'u1', path: '/u1/' }, investorUnit: null },
  ...overrides,
});

describe('the revision of a contract as the register shows it (ST-CTR-007)', () => {
  it('tells the first revision as one that follows nothing and comes from no change order', () => {
    expect(revisionView(row())).toMatchObject({ revision: 1, kind: 'BASE', valid_until: null, retroactive: false, supersedes_id: null, change_request_id: null, change_request_code: null });
  });

  it('tells a revision that a change order made: the one it follows, the change order and its code', () => {
    expect(revisionView(row({ revision: 2, kind: 'CHANGE_ORDER', status: 'PENDING_EFFECTIVE', supersedesId: 'r1', changeRequest: { id: 'q1', code: 'CO-001' } }))).toMatchObject({
      revision: 2,
      kind: 'CHANGE_ORDER',
      status: 'PENDING_EFFECTIVE',
      supersedes_id: 'r1',
      change_request_id: 'q1',
      change_request_code: 'CO-001',
    });
  });

  it('keeps the allowlist: nothing of the reach or the tenant is shown', () => {
    expect(Object.keys(revisionView(row())).sort()).toEqual([
      'amount_vnd',
      'boq_line_count',
      'boq_total_vnd',
      'change_request_code',
      'change_request_id',
      'contract_code',
      'contract_id',
      'created_at',
      'decided_at',
      'document_version_id',
      'id',
      'kind',
      'retroactive',
      'revision',
      'status',
      'supersedes_id',
      'valid_from',
      'valid_until',
      'version',
    ]);
  });
});
