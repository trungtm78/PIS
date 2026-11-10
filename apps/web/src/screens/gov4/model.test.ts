import { describe, expect, it } from 'vitest';
import { asOfText, idFrom, toAdvancePolicy, toAdvancePosition, toChangeTier, toContractAvailability, toEacControl, toProjectReserve, toRecoveryTable, vnd } from './model';

const ID = '00000000-0000-4000-8000-000000000001';

describe('the models of the money control screens', () => {
  it('writes whole amounts as the locale does, leaves anything else as it came, and never turns a missing amount into zero', () => {
    expect(vnd('1234567890', 'vi')).toBe('1.234.567.890');
    expect(vnd('-5000', 'en')).toBe('-5,000');
    expect(vnd('12.5', 'vi')).toBe('12.5');
    expect(vnd(null, 'vi')).toBe('');
    expect(vnd(undefined, 'vi')).toBe('');
    expect(vnd('', 'vi')).toBe('');
  });

  it('reads the address and the times of the server defensively', () => {
    expect(idFrom(ID.toUpperCase())).toBe(ID);
    expect(idFrom('x')).toBeUndefined();
    expect(idFrom(null)).toBeUndefined();
    expect(asOfText('2026-11-08T03:05:00.000Z')).toBe('10:05 08/11/2026');
    expect(asOfText('yesterday')).toBe('yesterday');
  });

  it('refuses what is not the shape of an answer and fills what the server left out with empty, never with a wrong number', () => {
    for (const parse of [toContractAvailability, toEacControl, toProjectReserve, toChangeTier, toRecoveryTable, toAdvancePosition]) {
      expect(parse(undefined)).toBeUndefined();
      expect(parse(null)).toBeUndefined();
      expect(parse([])).toBeUndefined();
      expect(parse({})).toBeUndefined();
    }
    expect(toAdvancePolicy(undefined)).toEqual([]);
    expect(toAdvancePolicy({ items: 'no' })).toEqual([]);
    const reserve = toProjectReserve({ project_id: ID, funds: [{ id: ID, kind: 'CONTINGENCY' }, 'bad'], risks: [{ id: ID }], contingency_cover: null });
    expect(reserve?.funds).toHaveLength(1);
    expect(reserve?.funds[0]).toMatchObject({ balanceVnd: '', entries: [], openDrawdowns: [] });
    expect(reserve?.cover).toBeNull();
    expect(reserve?.actions).toEqual({ fund: false, requestDrawdown: false, decideDrawdown: false, setExposure: false });
    expect(toChangeTier({ change_id: ID, tier: 9 })?.tier).toBe(3);
    expect(toEacControl({ project_id: ID, verdict: 'whatever' })?.verdict).toBe('WITHIN');
    expect(toRecoveryTable({ advance: {}, position: {}, rows: [{ kind: 'PLANNED' }, { kind: 'x' }] })?.rows.map((row) => row.kind)).toEqual(['PLANNED', 'ACTUAL']);
  });
});
