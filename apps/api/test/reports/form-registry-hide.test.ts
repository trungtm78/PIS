import { DIS_WEEKLY_LAYOUT, MOF_LAYOUTS } from '@machvon/kernel';
import type { ReportFormBundle } from '@machvon/kernel';
import { ReportFormRegistry } from '../../src/modules/reports/form-registry';

const bundleOf = (layout: ReportFormBundle['layout']): ReportFormBundle => ({ edition: 'public', layout, narrative: null, receiver: 'INTERNAL', periodKind: 'AS_OF', dataSource: 'LIVE', provider: 'DIS_HOME', templates: async () => ({ xlsx: new Uint8Array(), docx: null }) });

describe('the forms an edition takes out of its catalogue (DEMO-09)', () => {
  it('lists the forms that are not hidden, keeps a hidden one registered for the drafts and copies that exist, and forgets the hiding on clear', () => {
    const registry = new ReportFormRegistry();
    const mof = MOF_LAYOUTS[0];
    if (mof === undefined) throw new Error('the Ministry forms are missing');
    registry.register(bundleOf(DIS_WEEKLY_LAYOUT));
    registry.register(bundleOf(mof));
    expect(registry.listVisible().map((bundle) => bundle.layout.code)).toEqual([DIS_WEEKLY_LAYOUT.code, mof.code].sort());
    registry.hide([mof.code, 'CFG_AGENCY_REQUEST']);
    expect(registry.listVisible().map((bundle) => bundle.layout.code)).toEqual([DIS_WEEKLY_LAYOUT.code]);
    expect(registry.isHidden('CFG_AGENCY_REQUEST')).toBe(true);
    expect(registry.isHidden(DIS_WEEKLY_LAYOUT.code)).toBe(false);
    expect(registry.get(mof.code)).toBeDefined();
    expect(registry.list()).toHaveLength(2);
    registry.clear();
    expect(registry.isHidden(mof.code)).toBe(false);
  });
});
