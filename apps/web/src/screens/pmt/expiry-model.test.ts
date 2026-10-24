import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW, WINDOWS, renewLink, summaryOf, toExpiringPermit, urgencyOf, windowOf } from './expiry-model';
import type { ExpiringPermitView } from './expiry-model';

const raw = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  dossier_id: 'd1',
  permit_type_code: 'ENV',
  permit_type_name: 'Giấy phép môi trường',
  permit_no: 'GP-1',
  status: 'ISSUED',
  valid_until: '2026-11-20',
  days_left: 27,
  alert_level: 2,
  alert_threshold_days: 30,
  project: { id: 'pr1', code: 'DA-1', name: 'Dự án 1' },
  responsible: { membership_id: 'm1', display_name: 'A' },
  ...overrides,
});
const view = (overrides: Partial<ExpiringPermitView> = {}): ExpiringPermitView => ({ ...(toExpiringPermit(raw()) as ExpiringPermitView), ...overrides });

describe('the board of expiring permits', () => {
  it('reads a permit of the board, with the person in charge when there is one', () => {
    expect(toExpiringPermit(raw())).toEqual({
      id: 'p1',
      dossierId: 'd1',
      permitTypeCode: 'ENV',
      permitTypeName: 'Giấy phép môi trường',
      permitNo: 'GP-1',
      status: 'ISSUED',
      validUntil: '2026-11-20',
      daysLeft: 27,
      alertLevel: 2,
      thresholdDays: 30,
      project: { id: 'pr1', code: 'DA-1', name: 'Dự án 1' },
      responsible: { membershipId: 'm1', displayName: 'A' },
    });
    expect(toExpiringPermit(raw({ responsible: null, permit_no: null, permit_type_code: null, alert_threshold_days: null, permit_type_name: undefined, project: { id: 'pr1' } }))).toMatchObject({
      responsible: null,
      permitNo: null,
      permitTypeCode: null,
      thresholdDays: null,
      permitTypeName: '',
      project: { id: 'pr1', code: '', name: '' },
    });
    expect(toExpiringPermit(raw({ responsible: { membership_id: 'm1' } }))?.responsible).toEqual({ membershipId: 'm1', displayName: '' });
  });

  it('leaves out what is not a permit of the board', () => {
    for (const bad of [undefined, 'x', raw({ id: undefined }), raw({ dossier_id: undefined }), raw({ status: 'PLANNED' }), raw({ valid_until: undefined }), raw({ days_left: 1.5 }), raw({ alert_level: 5 }), raw({ alert_level: -1 }), raw({ project: undefined })]) {
      expect(toExpiringPermit(bad)).toBeUndefined();
    }
  });

  it('tells how urgent a permit is: past its day, on its last day, within the last 15 days, or further away', () => {
    expect(urgencyOf({ status: 'EXPIRED', daysLeft: -3 })).toBe('EXPIRED');
    expect(urgencyOf({ status: 'ISSUED', daysLeft: -1 })).toBe('EXPIRED');
    expect(urgencyOf({ status: 'ISSUED', daysLeft: 0 })).toBe('LAST_DAY');
    expect(urgencyOf({ status: 'ISSUED', daysLeft: 15 })).toBe('SOON');
    expect(urgencyOf({ status: 'ISSUED', daysLeft: 16 })).toBe('AHEAD');
  });

  it('counts the permits that run out and those that already have', () => {
    expect(summaryOf([view(), view({ daysLeft: 0 }), view({ status: 'EXPIRED', daysLeft: -5 }), view({ daysLeft: -1 })])).toEqual({ expiring: 2, expired: 2 });
    expect(summaryOf([])).toEqual({ expiring: 0, expired: 0 });
  });

  it('takes a window the board offers, else the default', () => {
    for (const days of WINDOWS) expect(windowOf(String(days))).toBe(days);
    for (const bad of [null, '', '7', '061', 'abc', '1000', '-30']) expect(windowOf(bad)).toBe(DEFAULT_WINDOW);
  });

  it('links a permit to its own screen', () => {
    expect(renewLink('a b')).toBe('/pmt/pmt-02?permit=a%20b');
  });
});
