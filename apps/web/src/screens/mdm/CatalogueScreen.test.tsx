import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import CatalogueScreen from './CatalogueScreen';
import { READER, STEWARD, client, crosswalk, mount, record, routeOf, world } from './test-support';
import type { World } from './test-support';

const route = (id: string) => routeOf(id, `FR-${id}`);
const source = (n: number, key: string, attributes: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
  record(n, { master_type: 'FUND_SOURCE', business_key: key, label: `Nguồn ${key}`, attributes, ...overrides });
const policy = (masterType: string, scope: string) => ({ master_type: masterType, scope, retire_requires_successor: false, locked: scope === 'PLATFORM_ONLY', source: 'BASELINE', platform_records: 0, tenant_records: 0 });

const FUNDS = [
  source(1, 'NSTW', { category: 'NSTW', relation: 'ADDITIVE' }, { namespace: 'PLATFORM' }),
  source(2, 'NSTW-DTPT', { category: 'NSTW', relation: 'ADDITIVE' }, { namespace: 'PLATFORM', parent_record_id: record(1).id }),
  source(3, 'CTMTQG-NTM', { category: 'CTMTQG', relation: 'SUBSET_OF' }, { namespace: 'PLATFORM', parent_record_id: record(2).id, open_change_request_id: 'c1' }),
  source(4, 'NSDP', { category: 'NSDP', relation: 'ADDITIVE' }, { status: 'RETIRED' }),
];
const funds = (overrides: Partial<World> = {}): World => world({ records: FUNDS, policies: [policy('FUND_SOURCE', 'PLATFORM_ONLY')], ...overrides });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tbody tr[data-record-id]'));
const keys = (): string[] => rows().map((row) => row.getAttribute('data-key') ?? '');
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));

describe('CatalogueScreen: the funding sources (MDM-04)', () => {
  it('shows the sources as a tree with their type, parent and containment, each marked with its namespace and any open request', async () => {
    mount(<CatalogueScreen route={route('MDM-04')} />, client(funds()), READER, '/mdm/mdm-04');
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['mdm.fundSource.page.title']);
    expect(screen.getByText(vi_['mdm.catalogue.page.subtitle'])).toBeTruthy();
    // Each entry under its parent: the depth shows as an indent of the first cell.
    expect(keys()).toEqual(['NSDP', 'NSTW', 'NSTW-DTPT', 'CTMTQG-NTM']);
    const cells = (key: string) => Array.from(document.querySelectorAll(`tr[data-key="${key}"] td`)).map((cell) => cell.textContent);
    expect(cells('CTMTQG-NTM').slice(0, 6)).toEqual([
      'CTMTQG-NTM',
      'Nguồn CTMTQG-NTM',
      vi_['mdm.value.category.ctmtqg'],
      'NSTW-DTPT',
      vi_['mdm.value.relation.subsetOf'],
      '2024-01-01 → ',
    ]);
    expect((document.querySelector('tr[data-key="CTMTQG-NTM"] td') as HTMLElement).style.paddingInlineStart).toBe('32px');
    expect((document.querySelector('tr[data-key="NSTW-DTPT"] td') as HTMLElement).style.paddingInlineStart).toBe('16px');
    expect(within(document.querySelector('tr[data-key="CTMTQG-NTM"]') as HTMLElement).getByText(vi_['mdm.catalogue.platform.pill'])).toBeTruthy();
    expect(within(document.querySelector('tr[data-key="CTMTQG-NTM"]') as HTMLElement).getByText(vi_['mdm.catalogue.pending.pill'])).toBeTruthy();
    expect(within(document.querySelector('tr[data-key="NSDP"]') as HTMLElement).queryByText(vi_['mdm.catalogue.platform.pill'])).toBeNull();
    expect(screen.getByTestId('count').textContent).toBe(vi_['mdm.catalogue.count.text'].replace('{count}', '4'));
  });

  it('opens an entry of the platform with its namespace in the link', async () => {
    mount(<CatalogueScreen route={route('MDM-04')} />, client(funds()), READER, '/mdm/mdm-04');
    await ready();
    const open = (key: string) => within(document.querySelector(`tr[data-key="${key}"]`) as HTMLElement).getByText(vi_['mdm.catalogue.open.action']).getAttribute('href');
    expect(open('NSTW')).toBe('/mdm/mdm-27?type=FUND_SOURCE&key=NSTW&ns=PLATFORM');
    expect(open('NSDP')).toBe('/mdm/mdm-27?type=FUND_SOURCE&key=NSDP');
  });

  it('says which types the platform keeps to itself, and offers no new entry for them', async () => {
    mount(<CatalogueScreen route={route('MDM-04')} />, client(funds()), STEWARD, '/mdm/mdm-04');
    await ready();
    expect(within(screen.getByTestId('scopes')).getByText(vi_['mdm.scope.platformOnly.label'], { exact: false })).toBeTruthy();
    expect(screen.queryByText(vi_['mdm.catalogue.add.action'])).toBeNull();
  });

  it('filters by text and by status, keeping the order flat while a filter is on', async () => {
    mount(<CatalogueScreen route={route('MDM-04')} />, client(funds()), READER, '/mdm/mdm-04');
    await ready();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(vi_['mdm.catalogue.search.label']), 'dtpt');
    expect(keys()).toEqual(['NSTW-DTPT']);
    await user.clear(screen.getByLabelText(vi_['mdm.catalogue.search.label']));
    await user.selectOptions(screen.getByLabelText(vi_['mdm.catalogue.status.label']), 'RETIRED');
    expect(keys()).toEqual(['NSDP']);
    await user.type(screen.getByLabelText(vi_['mdm.catalogue.search.label']), 'zzz');
    expect(screen.getByTestId('empty-catalogue').textContent).toBe(vi_['mdm.catalogue.noMatch.text']);
  });

  it('exports what is shown as a CSV file with the headings of the table', async () => {
    mount(<CatalogueScreen route={route('MDM-04')} />, client(funds()), READER, '/mdm/mdm-04');
    await ready();
    let blob: Blob | undefined;
    URL.createObjectURL = vi.fn((made: Blob) => {
      blob = made;
      return 'blob:csv';
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['mdm.catalogue.export.action'] }));
    expect(click).toHaveBeenCalledTimes(1);
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob as Blob);
    });
    expect(text).toContain(`${vi_['mdm.catalogue.key.column']},${vi_['mdm.catalogue.name.column']}`);
    expect(text).toContain('NSTW-DTPT');
  });

  it('says so when the catalogue is empty, and when it cannot be read', async () => {
    mount(<CatalogueScreen route={route('MDM-04')} />, client(world({ records: [] })), READER, '/mdm/mdm-04');
    expect((await screen.findByTestId('empty-catalogue')).textContent).toBe(vi_['mdm.catalogue.empty.text']);
    expect(screen.getByRole('button', { name: vi_['mdm.catalogue.export.action'] })).toBeDisabled();
    cleanup();
    mount(<CatalogueScreen route={route('MDM-04')} />, client(world({ failing: new Set(['searchMasterRecords']) })), READER, '/mdm/mdm-04');
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('CatalogueScreen: the other catalogues', () => {
  it('shows the programmes with their period, source and legal basis (MDM-05)', async () => {
    const program = record(1, { master_type: 'PROGRAM', business_key: 'NTM', label: 'Nông thôn mới', attributes: { kind: 'CTMTQG', period_from: 2021, period_to: 2025, fund_source_key: 'CTMTQG-NTM' }, revision: 2, legal_basis: 'NQ 25/2021' });
    mount(<CatalogueScreen route={route('MDM-05')} />, client(world({ records: [program] })), READER, '/mdm/mdm-05');
    await ready();
    expect(Array.from(document.querySelectorAll('tr[data-key="NTM"] td')).slice(0, 6).map((cell) => cell.textContent)).toEqual([
      'NTM',
      'Nông thôn mới',
      vi_['mdm.value.programKind.ctmtqg'],
      '2021 – 2025',
      'CTMTQG-NTM',
      'v2 · NQ 25/2021',
    ]);
  });

  const operational: Array<[string, Record<string, unknown>[], string, string[]]> = [
    ['MDM-13', [record(1, { master_type: 'DOCUMENT_TYPE', business_key: 'DECISION', label: 'Quyết định', attributes: { checklist: ['number', 'signature'], mime_types: ['application/pdf', 'image/png'], max_size_mb: 50 } })], 'DECISION', ['DECISION', 'Quyết định', 'number, signature', 'application/pdf, image/png', '50']],
    ['MDM-14', [record(1, { master_type: 'CONTRACT_TYPE', business_key: 'ANNEX', label: 'Phụ lục', attributes: { required_fields: ['number'], version_policy: 'ANNEX_ONLY', is_annex: true } })], 'ANNEX', ['ANNEX', 'Phụ lục', 'number', vi_['mdm.value.versionPolicy.annexOnly'], vi_['mdm.value.boolean.true']]],
    ['MDM-15', [record(1, { master_type: 'PAYMENT_TYPE', business_key: 'ADVANCE', label: 'Tạm ứng', attributes: { kind: 'ADVANCE', conditions: ['guarantee_in_place'], rule_set_key: 'ADV-RULES' } })], 'ADVANCE', ['ADVANCE', 'Tạm ứng', vi_['mdm.value.paymentKind.advance'], 'guarantee_in_place', 'ADV-RULES']],
    ['MDM-18', [record(1, { master_type: 'PRIORITY', business_key: 'URGENT', label: 'Khẩn cấp', attributes: { rank: 1, response_hours: 4, resolution_hours: 24, working_calendar: 'ALL_DAYS', escalate_after_hours: 12 } })], 'URGENT', ['URGENT', 'Khẩn cấp', '1', '4 / 24', vi_['mdm.value.workingCalendar.allDays'], '12']],
    ['MDM-19', [record(1, { master_type: 'CONTRACTOR_CRITERION', business_key: 'QUALITY', label: 'Chất lượng', revision: 3, attributes: { category: 'QUALITY', scale_max: 10, evidence_required: false } })], 'QUALITY', ['QUALITY', 'Chất lượng', vi_['mdm.value.criterionCategory.quality'], '10', vi_['mdm.value.boolean.false'], 'v3']],
    ['MDM-20', [record(1, { master_type: 'EXPERT_ROLE', business_key: 'PM', label: 'Chủ nhiệm dự án', attributes: { specialty: 'project_management', conditions: ['certificate_in_force'] } })], 'PM', ['PM', 'Chủ nhiệm dự án', 'project_management', 'certificate_in_force', '2024-01-01 → ']],
    ['MDM-21', [record(1, { master_type: 'CONTACT_PURPOSE', business_key: 'SURVEY', label: 'Khảo sát', attributes: { consent: 'EXPLICIT', security_level: 'CONFIDENTIAL' } })], 'SURVEY', ['SURVEY', 'Khảo sát', vi_['mdm.value.consent.explicit'], vi_['mdm.value.securityLevel.confidential']]],
    [
      'MDM-22',
      [
        record(1, { master_type: 'LANGUAGE', business_key: 'en', label: 'Tiếng Anh', attributes: { native_name: 'English' } }),
        record(2, { master_type: 'SHARED_TEXT', business_key: 'greeting', label: 'Xin chào', attributes: { translations: { en: 'Hello', fr: 'Bonjour' } } }),
      ],
      'greeting',
      ['SHARED_TEXT', 'greeting', 'Xin chào', 'en, fr'],
    ],
    [
      'MDM-23',
      [
        record(1, {
          master_type: 'RETENTION_POLICY',
          business_key: 'MASTER_DATA',
          label: 'Dữ liệu chủ',
          attributes: { owner_module: 'DGV', awaiting_confirmation: true, cxn: 'CXN-05', data_class: 'MASTER_DATA', classification: 'INTERNAL', permanent: true, legal_hold_allowed: false },
        }),
      ],
      'MASTER_DATA',
      ['MASTER_DATA', 'Dữ liệu chủ', vi_['mdm.value.classification.internal'], vi_['mdm.value.retention.permanent'], vi_['mdm.value.boolean.false'], vi_['mdm.rule.awaiting.pill'].replace('{cxn}', 'CXN-05')],
    ],
  ];

  it.each(operational)('shows the entries of the operational catalogue %s with their own columns', async (id, records, key, cells) => {
    mount(<CatalogueScreen route={route(id)} />, client(world({ records })), READER, `/mdm/${id.toLowerCase()}`);
    await ready();
    const row = document.querySelector(`tr[data-key="${key}"]`) as HTMLElement;
    expect(Array.from(row.querySelectorAll('td')).slice(0, cells.length).map((cell) => cell.textContent)).toEqual(cells);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBeTruthy();
  });

  it('shows the issue categories as a tree, each with its handling unit and the priority its SLA follows (MDM-17)', async () => {
    const records = [
      record(1, { master_type: 'ISSUE_CATEGORY', business_key: 'LAND', label: 'Đất đai', attributes: { handler_unit_key: 'LAND-UNIT', sla_priority_key: 'HIGH' } }),
      record(2, { master_type: 'ISSUE_CATEGORY', business_key: 'LAND-COMPENSATION', label: 'Bồi thường', parent_record_id: record(1).id, attributes: { sla_priority_key: 'URGENT' } }),
    ];
    mount(<CatalogueScreen route={route('MDM-17')} />, client(world({ records })), READER, '/mdm/mdm-17');
    await ready();
    expect(keys()).toEqual(['LAND', 'LAND-COMPENSATION']);
    expect(Array.from(document.querySelectorAll('tr[data-key="LAND-COMPENSATION"] td')).slice(0, 5).map((cell) => cell.textContent)).toEqual(['LAND-COMPENSATION', 'Bồi thường', 'LAND', '', 'URGENT']);
    expect((document.querySelector('tr[data-key="LAND-COMPENSATION"] td') as HTMLElement).style.paddingInlineStart).toBe('16px');
  });

  it('shows the units and the currencies with their factor, scale and rounding rule (MDM-12)', async () => {
    const records = [
      record(1, { master_type: 'UNIT', business_key: 'HA', label: 'Héc-ta', attributes: { dimension: 'AREA', factor: '10000', scale: 4, rounding: 'HALF_UP' } }),
      record(2, { master_type: 'CURRENCY', business_key: 'USD', label: 'Đô la Mỹ', attributes: { iso_code: 'USD', scale: 2, rounding: 'HALF_EVEN' } }),
    ];
    mount(<CatalogueScreen route={route('MDM-12')} />, client(world({ records })), READER, '/mdm/mdm-12');
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['mdm.unit.page.title']);
    expect(Array.from(document.querySelectorAll('tr[data-key="HA"] td')).slice(0, 7).map((cell) => cell.textContent)).toEqual(['UNIT', 'HA', 'Héc-ta', vi_['mdm.value.dimension.area'], '10000', '4', vi_['mdm.value.rounding.halfUp']]);
    expect(Array.from(document.querySelectorAll('tr[data-key="USD"] td')).slice(0, 7).map((cell) => cell.textContent)).toEqual(['CURRENCY', 'USD', 'Đô la Mỹ', 'USD', '', '2', vi_['mdm.value.rounding.halfEven']]);
  });

  it('shows the sectors under their parents (MDM-06) and the decision types and authorities (MDM-09, MDM-10)', async () => {
    const sectors = [record(1, { master_type: 'SECTOR', business_key: 'TRANSPORT', label: 'Giao thông', attributes: { sort_order: 10 } }), record(2, { master_type: 'SECTOR', business_key: 'ROADS', label: 'Đường bộ', parent_record_id: record(1).id })];
    mount(<CatalogueScreen route={route('MDM-06')} />, client(world({ records: sectors })), READER, '/mdm/mdm-06');
    await ready();
    expect(keys()).toEqual(['TRANSPORT', 'ROADS']);
    expect(Array.from(document.querySelectorAll('tr[data-key="ROADS"] td'))[2]?.textContent).toBe('TRANSPORT');
    cleanup();
    const types = [record(1, { master_type: 'DECISION_TYPE', business_key: 'APPROVAL', label: 'Quyết định đầu tư', attributes: { required_fields: ['number', 'issued_on'], template: 'TPL-1' } })];
    mount(<CatalogueScreen route={route('MDM-10')} />, client(world({ records: types })), READER, '/mdm/mdm-10');
    await ready();
    expect(Array.from(document.querySelectorAll('tr[data-key="APPROVAL"] td')).slice(0, 4).map((cell) => cell.textContent)).toEqual(['APPROVAL', 'Quyết định đầu tư', 'number, issued_on', 'TPL-1']);
    cleanup();
    const authorities = [record(1, { master_type: 'DECISION_AUTHORITY', business_key: 'PM-POLICY', attributes: { agency_key: 'PRIME_MINISTER', decision_type_key: 'INVESTMENT_POLICY', scope: 'NATIONAL' } })];
    mount(<CatalogueScreen route={route('MDM-09')} />, client(world({ records: authorities })), READER, '/mdm/mdm-09');
    await ready();
    expect(Array.from(document.querySelectorAll('tr[data-key="PM-POLICY"] td')).slice(0, 4).map((cell) => cell.textContent)).toEqual(['PM-POLICY', 'PRIME_MINISTER', 'INVESTMENT_POLICY', vi_['mdm.value.authorityScope.national']]);
  });

  it('shows the project groups and types together with a filter by type, and the rules that apply to them (MDM-07)', async () => {
    const thresholds = record(10, {
      master_type: 'PROJECT_GROUP_THRESHOLDS',
      business_key: 'DEFAULT',
      label: 'Ngưỡng nhóm dự án',
      legal_basis: 'Luật ĐTC 58/2024 [CXN-32]',
      attributes: {
        owner_module: 'PRJ',
        awaiting_confirmation: true,
        cxn: 'CXN-32',
        bands: [
          { sector_key: null, group_key: 'C', min_amount: '0', max_amount: '120000000000' },
          { sector_key: null, group_key: 'B', min_amount: '120000000000', max_amount: null },
        ],
      },
    });
    const criteria = record(11, {
      master_type: 'APPRAISAL_CRITERIA',
      business_key: 'APPR-CRIT-2026r1',
      label: 'Bộ tiêu chí',
      attributes: { owner_module: 'PRJ', criteria: [{ code: 'A', name: 'Phù hợp quy hoạch', max_score: 40 }, { code: 'B', name: 'Khả thi', max_score: 60 }], pass_threshold: 60 },
    });
    const retiredRule = record(12, { master_type: 'APPRAISAL_CRITERIA', business_key: 'OLD', status: 'RETIRED', attributes: { owner_module: 'PRJ', criteria: [], pass_threshold: 50 } });
    const state = world({
      records: [
        record(1, { master_type: 'PROJECT_GROUP', business_key: 'A', label: 'Dự án nhóm A', attributes: { rank: 2 } }),
        record(2, { master_type: 'PROJECT_TYPE', business_key: 'NEW', label: 'Xây dựng mới', attributes: { kind: 'CAPITAL_WORKS' } }),
        thresholds,
        criteria,
        retiredRule,
      ],
    });
    mount(<CatalogueScreen route={route('MDM-07')} />, client(state), STEWARD, '/mdm/mdm-07');
    await ready();
    expect(keys()).toEqual(['A', 'NEW']);
    expect(Array.from(document.querySelectorAll('tr[data-key="A"] td'))[3]?.textContent).toBe('#2');
    expect(Array.from(document.querySelectorAll('tr[data-key="NEW"] td'))[3]?.textContent).toBe(vi_['mdm.value.projectKind.capitalWorks']);
    await userEvent.setup().selectOptions(screen.getByLabelText(vi_['mdm.catalogue.type.label']), 'PROJECT_TYPE');
    expect(keys()).toEqual(['NEW']);
    expect(screen.getByText(vi_['mdm.catalogue.add.action']).getAttribute('href')).toBe('/mdm/mdm-25?type=PROJECT_TYPE');
    // Only the rules in force are shown; the one that waits for a confirmation says which, and the bands are exact amounts.
    const rules = within(screen.getByTestId('rules'));
    expect(document.querySelectorAll('[data-rule-type]')).toHaveLength(2);
    expect(rules.getByText(vi_['mdm.rule.awaiting.pill'].replace('{cxn}', 'CXN-32'))).toBeTruthy();
    expect(rules.getByText(vi_['mdm.rule.confirmed.pill'])).toBeTruthy();
    expect(rules.getByText('Luật ĐTC 58/2024 [CXN-32]')).toBeTruthy();
    const bands = within(screen.getByTestId('bands')).getAllByRole('row');
    expect(bands).toHaveLength(3);
    expect(bands[1]?.textContent).toBe(`${vi_['mdm.rule.bands.default.text']}C0${(120000000000).toLocaleString('vi')}`);
    expect(bands[2]?.textContent).toContain(vi_['mdm.rule.bands.open.text']);
    expect(rules.getByText(vi_['mdm.rule.criteria.item'].replace('{name}', 'Khả thi').replace('{score}', '60'))).toBeTruthy();
    expect(rules.getByText(vi_['mdm.rule.threshold.text'].replace('{score}', '60'))).toBeTruthy();
  });

  it('shows the stages with their allowed next steps and the national code rule with its mode and format (MDM-08)', async () => {
    const required = record(10, {
      master_type: 'NATIONAL_CODE_REQUIRED',
      business_key: 'DEFAULT',
      label: 'Mã số bắt buộc',
      legal_basis: 'Chờ văn bản gốc [CXN-01]',
      attributes: { owner_module: 'CAP', awaiting_confirmation: true, cxn: 'CXN-01', mode: 'BLOCK', from_stage_key: 'PIPELINE' },
    });
    const format = record(11, { master_type: 'NATIONAL_CODE_FORMAT', business_key: 'DEFAULT', label: 'Định dạng', attributes: { owner_module: 'CAP', pattern: '^\\d{7}$', example: '7654321' } });
    const stage = record(1, { master_type: 'PROJECT_STAGE', business_key: 'CONCEPT', label: 'Ý tưởng', attributes: { sequence: 1, allowed_next: ['APPRAISAL', 'CANCELLED'] } });
    mount(<CatalogueScreen route={route('MDM-08')} />, client(world({ records: [stage, required, format] })), READER, '/mdm/mdm-08');
    await ready();
    expect(Array.from(document.querySelectorAll('tr[data-key="CONCEPT"] td')).slice(0, 4).map((cell) => cell.textContent)).toEqual(['CONCEPT', 'Ý tưởng', '1', 'APPRAISAL, CANCELLED']);
    expect(screen.getByTestId('national-code-mode').textContent).toBe(vi_['mdm.rule.mode.text'].replace('{mode}', vi_['mdm.value.ruleMode.block']).replace('{stage}', 'PIPELINE'));
    expect(screen.getByTestId('national-code-format').textContent).toBe(vi_['mdm.rule.format.text'].replace('{pattern}', '^\\d{7}$').replace('{example}', '7654321'));
    expect(screen.getByText(vi_['mdm.rule.awaiting.pill'].replace('{cxn}', 'CXN-01'))).toBeTruthy();
  });

  it('says that the rules could not be read, with a retry, instead of showing an empty list of rules', async () => {
    const stage = record(1, { master_type: 'PROJECT_STAGE', business_key: 'CONCEPT', attributes: { sequence: 1 } });
    const state = world({ records: [stage], failingTypes: new Set(['NATIONAL_CODE_REQUIRED']) });
    mount(<CatalogueScreen route={route('MDM-08')} />, client(state), READER, '/mdm/mdm-08');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(vi_['mdm.rule.empty.text'])).toBeNull();
    state.failingTypes = new Set();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await ready();
    expect(screen.getByText(vi_['mdm.rule.empty.text'])).toBeTruthy();
  });

  it('says that no rule is in force, and refuses a route that is not a catalogue', async () => {
    mount(<CatalogueScreen route={route('MDM-08')} />, client(world({ records: [record(1, { master_type: 'PROJECT_STAGE', business_key: 'CONCEPT', attributes: { sequence: 1 } })] })), READER, '/mdm/mdm-08');
    await ready();
    expect(screen.getByText(vi_['mdm.rule.empty.text'])).toBeTruthy();
    cleanup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => mount(<CatalogueScreen route={route('MDM-99')} />, client(world()), READER, '/mdm/mdm-99')).toThrow('is not a catalogue');
    error.mockRestore();
  });

  it('offers a new entry to someone who may propose on a type that a tenant can extend, and none to a reader', async () => {
    const state = world({ records: [record(1, { master_type: 'SECTOR', business_key: 'T', label: 'Giao thông' })], policies: [policy('SECTOR', 'PLATFORM_WITH_TENANT_EXTENSION')] });
    mount(<CatalogueScreen route={route('MDM-06')} />, client(state), STEWARD, '/mdm/mdm-06');
    await ready();
    expect(screen.getByText(vi_['mdm.catalogue.add.action']).getAttribute('href')).toBe('/mdm/mdm-25?type=SECTOR');
    cleanup();
    mount(<CatalogueScreen route={route('MDM-06')} />, client(state), READER, '/mdm/mdm-06');
    await ready();
    expect(screen.queryByText(vi_['mdm.catalogue.add.action'])).toBeNull();
    fireEvent.change(screen.getByLabelText(vi_['mdm.catalogue.search.label']), { target: { value: 'x' } });
    expect(screen.getByTestId('empty-catalogue')).toBeTruthy();
  });
});

describe('CatalogueScreen: the Treasury offices and their linked codes (MDM-16)', () => {
  const office = (n: number, key: string, attributes: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
    record(n, { master_type: 'TREASURY_OFFICE', business_key: key, label: `Kho bạc ${key}`, attributes, ...overrides });
  const OFFICES = [office(1, 'KBNN-HN', { level: 'PROVINCE', province: 'Hà Nội' }), office(2, 'KBNN-TW', { level: 'CENTRAL' })];
  const links = [
    crosswalk(1, { business_key: 'KBNN-HN', external_code: '0011' }),
    crosswalk(1, { id: '00000000-0000-4000-8000-00000000e0ff', business_key: 'KBNN-HN', external_code: '0012' }),
    crosswalk(2, { business_key: 'KBNN-TW', external_code: 'TW-9', source_system: 'OTHER' }),
  ];

  it('shows each office with the Treasury codes that are mapped to it, its area, level and validity', async () => {
    mount(<CatalogueScreen route={route('MDM-16')} />, client(world({ records: OFFICES, crosswalks: links })), READER, '/mdm/mdm-16');
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['mdm.treasuryOffice.page.title']);
    const cells = (key: string) => Array.from(document.querySelectorAll(`tr[data-key="${key}"] td`)).map((cell) => cell.textContent);
    // The codes of the Treasury only: a code of another system is not a Treasury code.
    expect(cells('KBNN-HN').slice(0, 6)).toEqual(['KBNN-HN', 'Kho bạc KBNN-HN', '0011, 0012', 'Hà Nội', vi_['mdm.value.treasuryLevel.province'], '2024-01-01 → ']);
    expect(cells('KBNN-TW').slice(2, 5)).toEqual(['', '', vi_['mdm.value.treasuryLevel.central']]);
  });

  it('says that the mappings could not be read instead of showing offices that look unlinked, and reads them again on retry', async () => {
    const state = world({ records: OFFICES, crosswalks: links, failing: new Set(['listMasterCrosswalks']) });
    mount(<CatalogueScreen route={route('MDM-16')} />, client(state), READER, '/mdm/mdm-16');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(rows().length).toBe(0);
    state.failing = new Set();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await ready();
    expect(document.querySelector('tr[data-key="KBNN-HN"]')?.textContent).toContain('0011, 0012');
  });
});
