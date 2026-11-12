import { REPORT_FORM_CATALOGUE } from './report-layout.ts';
import { agencyReceiverOf, assertReceiverKnown, reportCatalogueView } from './report-catalogue.ts';
import type { CatalogueEntry, ManagedReportCatalogue } from './report-catalogue.ts';

const entry = (key: string, attributes: Record<string, unknown>, label = key): CatalogueEntry => ({ key, label, attributes });

/** A managed catalogue that agrees with the six forms of the code, the way the template pack of the edition writes it. */
const agreeing = (): ManagedReportCatalogue => ({
  periodKinds: [entry('MONTH', { grain: 'MONTH' }), entry('QUARTER', { grain: 'QUARTER' }), entry('YEAR', { grain: 'YEAR' }), entry('MEETING', { grain: 'MEETING' })],
  reportTypes: [
    entry('PVN_MONTHLY', { period_kind_key: 'MONTH', audience: 'PARENT_GROUP', form_code: 'PVN-MONTHLY' }),
    entry('PVN_QUARTERLY', { period_kind_key: 'QUARTER', audience: 'PARENT_GROUP', form_code: 'PVN-QUARTERLY-F2' }),
    entry('HPM_MONTHLY', { period_kind_key: 'MONTH', audience: 'PARENT_GROUP', form_code: 'HPM-MONTHLY' }),
    entry('COMMITTEE_PERIODIC', { period_kind_key: 'QUARTER', audience: 'EXTERNAL_AGENCY', form_code: 'COMMITTEE-PERIODIC' }),
    entry('INVEST_STEERING', { period_kind_key: 'MONTH', audience: 'INTERNAL', form_code: 'INVEST-STEERING' }),
    entry('PLANT_PHU_MY', { period_kind_key: 'MONTH', audience: 'INTERNAL', form_code: 'PLANT-PHU-MY' }),
    entry('DEPARTMENT_PERIODIC', { period_kind_key: 'YEAR', audience: 'EXTERNAL_AGENCY' }),
  ],
  agencies: [
    entry('PVN', { agency_kind: 'PARENT_GROUP', channel: 'FILE', report_type_keys: ['PVN_MONTHLY', 'PVN_QUARTERLY'] }),
    entry('HPM', { agency_kind: 'PARENT_GROUP', channel: 'HPM', report_type_keys: ['HPM_MONTHLY'] }),
    entry('UB_DTPT_KHCN', { agency_kind: 'COMMITTEE', channel: 'FILE', report_type_keys: ['COMMITTEE_PERIODIC'], receiver_code: 'UB-DTPT-KHCN' }),
    entry('GIAO_BAN', { agency_kind: 'INTERNAL_MEETING', channel: 'MEETING', report_type_keys: ['INVEST_STEERING'], receiver_code: 'BAN-KHDT' }),
    entry('NMD_PM', { agency_kind: 'INTERNAL_MEETING', channel: 'FILE', report_type_keys: ['PLANT_PHU_MY'], receiver_code: 'NMD-PM' }),
    entry('SO_BAN_NGANH', { agency_kind: 'DEPARTMENT', channel: 'EMAIL', report_type_keys: ['DEPARTMENT_PERIODIC'] }),
  ],
});

const EMPTY: ManagedReportCatalogue = { periodKinds: [], reportTypes: [], agencies: [] };

describe('the report catalogue: forms, report types and receiving agencies (MD.03)', () => {
  it('names the code of the agency a delivery is logged under: its receiver code, else its key', () => {
    expect(agencyReceiverOf(entry('PVN', {}))).toBe('PVN');
    expect(agencyReceiverOf(entry('UB_DTPT_KHCN', { receiver_code: 'UB-DTPT-KHCN' }))).toBe('UB-DTPT-KHCN');
    expect(agencyReceiverOf(entry('X', { receiver_code: 5 }))).toBe('X');
  });

  it('without any managed entry stands on the forms of the code, says so, and keeps every receiver of the code', () => {
    const view = reportCatalogueView(EMPTY, REPORT_FORM_CATALOGUE);
    expect(view.managed).toBe(false);
    expect(view.forms.map((form) => [form.code, form.receiver, form.period, form.source, form.problems])).toEqual(REPORT_FORM_CATALOGUE.map((one) => [one.code, one.receiver, one.period, 'CODE_DEFAULT', []]));
    expect(view.receivers).toEqual([...new Set(REPORT_FORM_CATALOGUE.map((one) => one.receiver))].sort());
  });

  it('reads the receiver of each form from the agency that lists the type of the form, and agrees with the code when the pack does', () => {
    const view = reportCatalogueView(agreeing(), REPORT_FORM_CATALOGUE);
    expect(view.managed).toBe(true);
    expect(view.forms.every((form) => form.source === 'MANAGED' && form.problems.length === 0)).toBe(true);
    expect(view.forms.map((form) => [form.code, form.receiver, form.period])).toEqual(REPORT_FORM_CATALOGUE.map((one) => [one.code, one.receiver, one.period]));
    expect(view.receivers).toEqual(['BAN-KHDT', 'HPM', 'NMD-PM', 'PVN', 'SO_BAN_NGANH', 'UB-DTPT-KHCN']);
  });

  it('lets the catalogue move a form to another agency: the managed receiver wins over the one of the code', () => {
    const catalogue = agreeing();
    catalogue.agencies = catalogue.agencies.map((one) => (one.key === 'HPM' ? entry('HPM', { ...one.attributes, report_type_keys: [] }) : one)).concat(entry('PVN_HPM', { agency_kind: 'PARENT_GROUP', channel: 'HPM', report_type_keys: ['HPM_MONTHLY'] }));
    const form = reportCatalogueView(catalogue, REPORT_FORM_CATALOGUE).forms.find((one) => one.code === 'HPM-MONTHLY');
    expect(form).toMatchObject({ receiver: 'PVN_HPM', source: 'MANAGED', agencyKey: 'PVN_HPM', reportTypeKey: 'HPM_MONTHLY', problems: [] });
  });

  it('keeps the receiver of the code and says why when the type has no agency, the agency is not unique, or the period disagrees', () => {
    const catalogue = agreeing();
    catalogue.agencies = [...catalogue.agencies.filter((one) => one.key !== 'NMD_PM'), entry('PVN_TWIN', { agency_kind: 'PARENT_GROUP', channel: 'FILE', report_type_keys: ['PVN_MONTHLY'] })];
    catalogue.reportTypes = catalogue.reportTypes.map((one) => (one.key === 'COMMITTEE_PERIODIC' ? entry(one.key, { ...one.attributes, period_kind_key: 'MONTH' }) : one));
    const forms = new Map(reportCatalogueView(catalogue, REPORT_FORM_CATALOGUE).forms.map((one) => [one.code, one]));
    expect(forms.get('PLANT-PHU-MY')).toMatchObject({ receiver: 'NMD-PM', source: 'MANAGED', problems: ['NO_AGENCY'] });
    expect(forms.get('PVN-MONTHLY')).toMatchObject({ receiver: 'PVN', problems: ['AGENCY_NOT_UNIQUE'] });
    expect(forms.get('COMMITTEE-PERIODIC')).toMatchObject({ receiver: 'UB-DTPT-KHCN', period: 'QUARTER', problems: ['PERIOD_MISMATCH'] });
  });

  it('stays on the code for a form whose report type the catalogue does not hold, and reports a type with no known period', () => {
    const catalogue = agreeing();
    catalogue.reportTypes = catalogue.reportTypes.filter((one) => one.key !== 'INVEST_STEERING').map((one) => (one.key === 'PVN_MONTHLY' ? entry(one.key, { ...one.attributes, period_kind_key: 'FORTNIGHT' }) : one));
    const forms = new Map(reportCatalogueView(catalogue, REPORT_FORM_CATALOGUE).forms.map((one) => [one.code, one]));
    expect(forms.get('INVEST-STEERING')).toMatchObject({ receiver: 'BAN-KHDT', source: 'CODE_DEFAULT', reportTypeKey: null, problems: [] });
    expect(forms.get('PVN-MONTHLY')).toMatchObject({ problems: ['PERIOD_UNKNOWN'] });
  });

  it('does not take a meeting for a period of a form: a type with the grain MEETING is judged as a mismatch of a form that is made for a month', () => {
    const catalogue = agreeing();
    catalogue.reportTypes = catalogue.reportTypes.map((one) => (one.key === 'INVEST_STEERING' ? entry(one.key, { ...one.attributes, period_kind_key: 'MEETING' }) : one));
    expect(reportCatalogueView(catalogue, REPORT_FORM_CATALOGUE).forms.find((one) => one.code === 'INVEST-STEERING')?.problems).toEqual(['PERIOD_MISMATCH']);
  });

  it('accepts any well-formed receiver when nothing is managed, and only the known ones when the catalogue is managed', () => {
    const open = reportCatalogueView(EMPTY, REPORT_FORM_CATALOGUE);
    expect(() => assertReceiverKnown(open, 'ANYBODY')).not.toThrow();
    const managed = reportCatalogueView(agreeing(), REPORT_FORM_CATALOGUE);
    for (const known of ['PVN', 'UB-DTPT-KHCN', 'BAN-KHDT', 'NMD-PM', 'SO_BAN_NGANH']) expect(() => assertReceiverKnown(managed, known)).not.toThrow();
    expect(() => assertReceiverKnown(managed, 'ANYBODY')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', status: 422, detail: 'receiver' }));
    expect(() => assertReceiverKnown(managed, 'pvn')).toThrow(expect.objectContaining({ detail: 'receiver' }));
  });

  it('always keeps the receiver of a form of the code deliverable, even when the managed agencies leave it out', () => {
    const catalogue = agreeing();
    catalogue.agencies = catalogue.agencies.filter((one) => one.key !== 'HPM');
    const view = reportCatalogueView(catalogue, REPORT_FORM_CATALOGUE);
    expect(view.forms.find((one) => one.code === 'HPM-MONTHLY')).toMatchObject({ receiver: 'HPM', problems: ['NO_AGENCY'] });
    expect(() => assertReceiverKnown(view, 'HPM')).not.toThrow();
  });
});
