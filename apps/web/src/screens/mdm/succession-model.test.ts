import { describe, expect, it } from 'vitest';
import { COMMUNE_A, COMMUNE_B, DISTRICT, MERGED, PROVINCE, edge } from './succession-test-support';
import {
  EMPTY_SUCCESSION_FORM,
  REFORM_DATE,
  connectorsOf,
  dayBefore,
  edgesOn,
  isShare,
  toConversion,
  toEdge,
  toProposedSuccession,
  toStructure,
  validateSuccession,
  vietnamToday,
} from './succession-model';
import type { SuccessionForm } from './succession-model';

const ok: SuccessionForm = { ...EMPTY_SUCCESSION_FORM, predecessorId: COMMUNE_A.id, successorId: MERGED.id, legalBasis: 'Resolution of the reform', reason: 'Recorded after the reform' };

describe('succession model', () => {
  it('reads an edge, a target, a structure and a conversion, and drops what is not one', () => {
    const merge = edge(1, COMMUNE_A, MERGED);
    expect(toEdge(merge)).toMatchObject({ predecessorKey: 'XA-A', successorKey: 'XA-Y', kind: 'MERGE', effectiveDate: REFORM_DATE, sharePct: null });
    expect(toEdge({ ...merge, succession_kind: 'WRONG' })).toBeUndefined();
    expect(toEdge({ ...merge, id: undefined })).toBeUndefined();
    expect(toEdge('nothing')).toBeUndefined();
    const conversion = toConversion({ master_record_id: 'a', master_type: 'AREA', business_key: 'XA-A', as_of: REFORM_DATE, edges: [merge, 'junk'], targets: [{ record_id: 'b', business_key: 'XA-Y', succession_kind: 'MERGE', share_pct: '100.00', in_force: true, version: { id: 'v', revision: 1, label: 'Xã Y', valid_from: REFORM_DATE } }, { record_id: 'c' }] });
    expect(conversion?.edges).toHaveLength(1);
    expect(conversion?.targets).toEqual([{ recordId: 'b', masterType: '', businessKey: 'XA-Y', kind: 'MERGE', effectiveDate: null, sharePct: '100.00', inForce: true, version: { id: 'v', revision: 1, label: 'Xã Y', parentRecordId: null, validFrom: REFORM_DATE, validUntil: null } }]);
    expect(toConversion({})).toBeUndefined();
    const view = toStructure({ master_record_id: 'a', master_type: 'AREA', business_key: 'XA-A', as_of: REFORM_DATE, state: 'SUCCEEDED', version: null, predecessors: [], successors: [merge] });
    expect(view).toMatchObject({ state: 'SUCCEEDED', version: null, structureDate: null, targets: [] });
    expect(view?.successors).toHaveLength(1);
    expect(toStructure({ master_record_id: 'a', master_type: 'AREA', business_key: 'XA-A', as_of: REFORM_DATE, state: 'LOST' })).toBeUndefined();
    expect(toStructure(null)).toBeUndefined();
  });

  it('reads the proposal of a succession request', () => {
    expect(toProposedSuccession({ succession_kind: 'SPLIT', effective_date: REFORM_DATE, legal_basis: 'x', edges: [{ successor_record_id: 'a', share_pct: '60.00' }, { successor_record_id: 7 }, { successor_record_id: 'b', share_pct: null }] })).toEqual({
      kind: 'SPLIT',
      effectiveDate: REFORM_DATE,
      legalBasis: 'x',
      edges: [
        { successorRecordId: 'a', sharePct: '60.00' },
        { successorRecordId: 'b', sharePct: null },
      ],
    });
    expect(toProposedSuccession({ label: 'not a succession' })).toBeUndefined();
  });

  it('does date arithmetic without a time zone, and reads today in the business time zone', () => {
    expect(dayBefore('2025-07-01')).toBe('2025-06-30');
    expect(dayBefore('2024-03-01')).toBe('2024-02-29');
    expect(dayBefore('2025-01-01')).toBe('2024-12-31');
    // 18:00 UTC is already the next day in Vietnam (UTC+7).
    expect(vietnamToday(new Date('2026-10-23T18:00:00Z'))).toBe('2026-10-24');
  });

  it('keeps the edges of one date once, and groups the edges that share an entry into connectors', () => {
    const edges = [
      edge(1, COMMUNE_A, MERGED),
      edge(2, COMMUNE_B, MERGED),
      edge(3, DISTRICT, PROVINCE, { succession_kind: 'ABOLISH_LEVEL' }),
      edge(4, COMMUNE_A, MERGED, { effective_date: '2025-01-01' }),
      edge(1, COMMUNE_A, MERGED),
    ].flatMap((raw) => toEdge(raw) ?? []);
    expect(edgesOn(edges, REFORM_DATE).map((item) => item.id)).toHaveLength(3);
    const connectors = connectorsOf(edgesOn(edges, REFORM_DATE));
    expect(connectors).toHaveLength(2);
    expect(connectors.map((connector) => [connector.before.map((entry) => entry.key), connector.after.map((entry) => entry.key), connector.kinds])).toEqual([
      [['HUYEN-X'], ['TINH-X'], ['ABOLISH_LEVEL']],
      [['XA-A', 'XA-B'], ['XA-Y'], ['MERGE']],
    ]);
    const split = connectorsOf(
      [edge(5, PROVINCE, COMMUNE_A, { succession_kind: 'SPLIT', share_pct: '60.00' }), edge(6, PROVINCE, COMMUNE_B, { succession_kind: 'SPLIT', share_pct: '40.00' })].flatMap((raw) => toEdge(raw) ?? []),
    );
    expect(split).toHaveLength(1);
    expect(split[0]?.after.map((entry) => [entry.key, entry.sharePct])).toEqual([
      ['XA-A', '60.00'],
      ['XA-B', '40.00'],
    ]);
    expect(connectorsOf([])).toEqual([]);
  });

  it('judges the form: entries, date, share of a split, basis and reason', () => {
    expect(validateSuccession(ok)).toEqual({});
    expect(validateSuccession({ ...ok, masterType: ' ' })).toEqual({ masterType: 'required' });
    expect(validateSuccession({ ...EMPTY_SUCCESSION_FORM })).toEqual({ predecessorId: 'required', successorId: 'required', legalBasis: 'required', reason: 'required' });
    expect(validateSuccession({ ...ok, successorId: ok.predecessorId })).toEqual({ successorId: 'sameEntry' });
    expect(validateSuccession({ ...ok, effectiveDate: '' })).toEqual({ effectiveDate: 'required' });
    expect(validateSuccession({ ...ok, effectiveDate: '2025-02-30' })).toEqual({ effectiveDate: 'invalidDate' });
    expect(validateSuccession({ ...ok, legalBasis: 'ab' })).toEqual({ legalBasis: 'tooShort' });
    expect(validateSuccession({ ...ok, legalBasis: 'x'.repeat(2001) })).toEqual({ legalBasis: 'tooLong' });
    expect(validateSuccession({ ...ok, reason: 'abc' })).toEqual({ reason: 'tooShort' });
    expect(validateSuccession({ ...ok, reason: 'x'.repeat(2001) })).toEqual({ reason: 'tooLong' });
    // A share belongs to a split only.
    expect(validateSuccession({ ...ok, sharePct: 'not read for a merge' })).toEqual({});
    expect(validateSuccession({ ...ok, kind: 'SPLIT' })).toEqual({ sharePct: 'required' });
    expect(validateSuccession({ ...ok, kind: 'SPLIT', sharePct: '100' })).toEqual({ sharePct: 'invalidShare' });
    expect(validateSuccession({ ...ok, kind: 'SPLIT', sharePct: '60.5' })).toEqual({});
  });

  it('accepts a share of more than 0 and less than 100 with at most two decimals', () => {
    for (const good of ['0.01', '33.33', '60', ' 99.99 ']) expect(isShare(good)).toBe(true);
    for (const bad of ['0', '0.00', '100', '100.00', '-1', '1.234', 'x', '', '5%']) expect(isShare(bad)).toBe(false);
  });
});
