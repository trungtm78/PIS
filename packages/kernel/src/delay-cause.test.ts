import { delayCauseGroups, delayCauseOptions, isKnownDelayCause } from './delay-cause.ts';
import type { IssueCategoryEntry } from './delay-cause.ts';

const entry = (key: string, label: string, attributes: Record<string, unknown>, retired = false): IssueCategoryEntry => ({ key, label, versionId: `v-${key}`, recordId: `r-${key}`, parentRecordId: null, attributes, retired });

const ENTRIES = [
  entry('GPMB', 'Giai phong mat bang', { delay_cause: true, cause_group: 'SITE_CLEARANCE' }),
  entry('VON', 'Cham giai ngan von', { delay_cause: true, cause_group: 'CAPITAL' }),
  entry('MUA', 'Mua xuan', { delay_cause: true, cause_group: 'WEATHER' }),
  entry('KHAC', 'Nguyen nhan khac', { delay_cause: true }),
  entry('LOI', 'Loi ky thuat', { delay_cause: false, cause_group: 'DESIGN' }),
  entry('CU', 'Nguyen nhan cu', { delay_cause: true, cause_group: 'CAPITAL' }, true),
  entry('LA', 'Nhom la', { delay_cause: true, cause_group: 'NOT_A_GROUP' }),
];

describe('delay causes', () => {
  it('lists only the entries that are causes and in force, by family order then label', () => {
    expect(delayCauseOptions(ENTRIES).map((option) => option.key)).toEqual(['GPMB', 'VON', 'MUA', 'KHAC', 'LA']);
  });
  it('puts an entry with no or an unknown family under OTHER', () => {
    const groups = delayCauseOptions(ENTRIES).filter((option) => option.group === 'OTHER').map((option) => option.key);
    expect(groups).toEqual(['KHAC', 'LA']);
  });
  it('groups the options and leaves empty families out', () => {
    expect(delayCauseGroups(delayCauseOptions(ENTRIES)).map((list) => `${list.group}:${list.causes.length}`)).toEqual(['SITE_CLEARANCE:1', 'CAPITAL:1', 'WEATHER:1', 'OTHER:2']);
  });
  it('knows a cause by its key and refuses a retired or non-cause entry', () => {
    expect(isKnownDelayCause(ENTRIES, 'GPMB')).toBe(true);
    expect(isKnownDelayCause(ENTRIES, 'CU')).toBe(false);
    expect(isKnownDelayCause(ENTRIES, 'LOI')).toBe(false);
    expect(isKnownDelayCause(ENTRIES, 'NOPE')).toBe(false);
  });
});
