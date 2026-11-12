import { masterTypeDefinition, validateMasterContent } from '../src/master-types';
import type { EntryRef, TypeLookup } from '../src/master-types';
import type { MasterContent } from '../src/master-store';

const content = (attributes: Record<string, unknown>): MasterContent => ({ label: 'Entry', attributes, parentRecordId: null, validFrom: '2026-01-01', validUntil: null, legalBasis: null });
const entry = (masterType: string, businessKey: string, attributes: Record<string, unknown> = {}): EntryRef => ({ masterType, businessKey, attributes });
const CATALOGUE: EntryRef[] = [entry('REPORTING_PERIOD_KIND', 'MONTH', { grain: 'MONTH' }), entry('REPORT_TYPE', 'MONTHLY_PVN', { audience: 'PARENT_GROUP' })];
const lookup: TypeLookup = { entry: (masterType, businessKey) => Promise.resolve(CATALOGUE.find((item) => item.masterType === masterType && item.businessKey === businessKey)) };

async function problem(masterType: string, businessKey: string, value: MasterContent): Promise<string | undefined> {
  try {
    await validateMasterContent({ masterType, businessKey, content: value, parent: undefined, lookup });
  } catch (error) {
    return (error as { detail?: string }).detail;
  }
  return undefined;
}

describe('the shared catalogues of the report chain (MD.03, ENT-3d)', () => {
  it('defines the five types', () => {
    for (const type of ['REPORTING_PERIOD_KIND', 'REPORT_TYPE', 'RECEIVING_AGENCY', 'CAPITAL_SOURCE', 'REPORT_UNIT']) expect(masterTypeDefinition(type)?.masterType).toBe(type);
  });

  describe('REPORTING_PERIOD_KIND', () => {
    it('follows the grain: a month is 1, a quarter 3, a year 12, a meeting 0', async () => {
      expect(await problem('REPORTING_PERIOD_KIND', 'QUARTER', content({ grain: 'QUARTER', months: 3, entry_deadline_working_days: 10 }))).toBeUndefined();
      expect(await problem('REPORTING_PERIOD_KIND', 'MEETING', content({ grain: 'MEETING', months: 0, entry_deadline_working_days: 3 }))).toBeUndefined();
      expect(await problem('REPORTING_PERIOD_KIND', 'QUARTER', content({ grain: 'QUARTER', months: 4, entry_deadline_working_days: 10 }))).toBe('attributes.months');
      expect(await problem('REPORTING_PERIOD_KIND', 'YEAR', content({ grain: 'YEAR', months: 12, entry_deadline_working_days: 0 }))).toBe('attributes.entry_deadline_working_days');
      expect(await problem('REPORTING_PERIOD_KIND', 'WEEK', content({ grain: 'WEEK', months: 0, entry_deadline_working_days: 3 }))).toBe('attributes.grain');
    });
  });

  describe('REPORT_TYPE and RECEIVING_AGENCY', () => {
    it('names a period kind and an audience; an agency names the report types it receives', async () => {
      expect(await problem('REPORT_TYPE', 'MONTHLY_PVN', content({ period_kind_key: 'MONTH', audience: 'PARENT_GROUP', form_code: 'PVN-01' }))).toBeUndefined();
      expect(await problem('REPORT_TYPE', 'X', content({ period_kind_key: 'FORTNIGHT', audience: 'PARENT_GROUP' }))).toBe('attributes.period_kind_key');
      expect(await problem('REPORT_TYPE', 'X', content({ period_kind_key: 'MONTH', audience: 'PRESS' }))).toBe('attributes.audience');
      expect(await problem('RECEIVING_AGENCY', 'PVN', content({ agency_kind: 'PARENT_GROUP', report_type_keys: ['MONTHLY_PVN'], channel: 'HPM' }))).toBeUndefined();
      expect(await problem('RECEIVING_AGENCY', 'PVN', content({ agency_kind: 'PARENT_GROUP', report_type_keys: ['NO_SUCH'], channel: 'HPM' }))).toBe('attributes.report_type_keys');
      expect(await problem('RECEIVING_AGENCY', 'PVN', content({ agency_kind: 'PARENT_GROUP', channel: 'PIGEON' }))).toBe('attributes.channel');
    });

    it('may carry the code its deliveries are logged under (MD.03, the report catalogue)', async () => {
      const agency = (receiver: unknown) => content({ agency_kind: 'COMMITTEE', channel: 'FILE', report_type_keys: ['MONTHLY_PVN'], receiver_code: receiver });
      expect(await problem('RECEIVING_AGENCY', 'UB_DTPT_KHCN', agency('UB-DTPT-KHCN'))).toBeUndefined();
      expect(await problem('RECEIVING_AGENCY', 'UB_DTPT_KHCN', agency('ub dtpt'))).toBe('attributes.receiver_code');
      expect(await problem('RECEIVING_AGENCY', 'UB_DTPT_KHCN', agency(''))).toBe('attributes.receiver_code');
      expect(await problem('RECEIVING_AGENCY', 'UB_DTPT_KHCN', agency('A'.repeat(61)))).toBe('attributes.receiver_code');
    });
  });

  describe('CAPITAL_SOURCE and REPORT_UNIT', () => {
    it('carries the code of the class of the funding pack, and units with an exact factor', async () => {
      expect(await problem('CAPITAL_SOURCE', 'EQUITY', content({ fnd_class_code: 'EQUITY', repayable: false }))).toBeUndefined();
      expect(await problem('CAPITAL_SOURCE', 'EQUITY', content({ fnd_class_code: 'equity' }))).toBe('attributes.fnd_class_code');
      expect(await problem('REPORT_UNIT', 'BILLION_VND', content({ kind: 'MONEY', symbol: 'bn VND', factor: '1000000000', scale: 2, rounding: 'HALF_UP' }))).toBeUndefined();
      expect(await problem('REPORT_UNIT', 'BAD', content({ kind: 'MONEY', symbol: 'x', factor: '0', scale: 2, rounding: 'HALF_UP' }))).toBe('attributes.factor');
      expect(await problem('REPORT_UNIT', 'BAD', content({ kind: 'WEIGHT', symbol: 'x', factor: '1', scale: 2, rounding: 'HALF_UP' }))).toBe('attributes.kind');
    });
  });
});
