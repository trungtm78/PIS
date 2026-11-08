import { describe, expect, it } from 'vitest';
import { WORK_SOURCES } from '../../../ui/alerts/types';
import { WORK_KINDS, pathOf, toWorkPage } from '../../home/work-model';

const KINDS = ['CLAIM_LIMITATION_APPROACHING', 'CLAIM_LIMITATION_MISSED', 'CLAIM_RESPONSE_DUE', 'CLAIM_SETTLEMENT_OVERDUE', 'EW_REGISTER_OVERDUE', 'EW_MEETING_OVERDUE', 'EW_ACTION_OVERDUE'];

describe('the alert centre and the registers of claims and early warnings', () => {
  it('knows the seven kinds and the two sources the registers feed it with', () => {
    for (const kind of KINDS) expect(WORK_KINDS as readonly string[]).toContain(kind);
    expect(WORK_SOURCES).toContain('CONTRACT_CLAIM');
    expect(WORK_SOURCES).toContain('CONTRACT_EARLY_WARNING');
  });

  it('keeps an item of these kinds in the list instead of dropping it as unknown', () => {
    const items = KINDS.map((kind, index) => ({ id: `id-${index}`, kind, title: kind, subtitle: null, status: 'OVERDUE', due_on: '2026-11-01', original_due_on: '2026-11-01', bucket: 'OVERDUE', days_late: 7, target: { screen: 'CTR-33', id: `id-${index}` } }));
    expect(toWorkPage({ items }).items.map((item) => item.kind)).toEqual(KINDS);
  });

  it('opens a claim by its id, the register of a contract by the id of the contract and a warning by its id', () => {
    expect(pathOf({ target: { screen: 'CTR-33', id: 'claim-1' } })).toBe('/ctr/ctr-33?claim=claim-1');
    expect(pathOf({ target: { screen: 'CTR-35', id: 'contract-1' } })).toBe('/ctr/ctr-35?contract=contract-1');
    expect(pathOf({ target: { screen: 'CTR-36', id: 'warning-1' } })).toBe('/ctr/ctr-36?warning=warning-1');
  });
});
