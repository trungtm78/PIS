import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import AssetViewScreen from './AssetViewScreen';
import DiaryViewScreen from './DiaryViewScreen';
import HandoverViewScreen from './HandoverViewScreen';
import QualityViewScreen from './QualityViewScreen';
import SettlementViewScreen from './SettlementViewScreen';
import WarrantyViewScreen from './WarrantyViewScreen';
import {
  CONTRACT,
  READERS,
  asset,
  finalRequest,
  contractorSignature,
  guestContract,
  open,
  otherContractSettlement,
  ownSettlement,
  projectSettlement,
  readAllOf,
  routeOf,
  rows,
  staffContract,
  world,
} from './test-support';
import type { World } from './test-support';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const fill = (key: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [name, item]) => out.replace(`{${name}}`, String(item)), word(key));
const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

type Id = keyof typeof READERS;
const SCREENS: Record<Id, { screen: (id: Id) => ReactElement; title: string; filled: Partial<World>; owner: string }> = {
  'CTR-09': { screen: (id) => <DiaryViewScreen route={routeOf(id)} />, title: 'ctr.diaryView.page.title', filled: { diaries: [rows.diary] }, owner: 'QMS-01' },
  'CTR-11': { screen: (id) => <QualityViewScreen route={routeOf(id)} />, title: 'ctr.qualityView.page.title', filled: { ncrs: [rows.ncr], inspections: [rows.inspection] }, owner: 'QMS-07' },
  'CTR-15': { screen: (id) => <HandoverViewScreen route={routeOf(id)} />, title: 'ctr.handoverView.page.title', filled: { handovers: [rows.handover] }, owner: 'AST-01' },
  'CTR-16': { screen: (id) => <WarrantyViewScreen route={routeOf(id)} />, title: 'ctr.warrantyView.page.title', filled: { warranties: [rows.warranty] }, owner: 'AST-04' },
  'CTR-17': {
    screen: (id) => <SettlementViewScreen route={routeOf(id)} />,
    title: 'ctr.settlementView.page.title',
    filled: { settlements: [projectSettlement, ownSettlement], finals: [finalRequest] },
    owner: 'PAY-15',
  },
  'CTR-18': { screen: (id) => <AssetViewScreen route={routeOf(id)} />, title: 'ctr.assetView.page.title', filled: { assets: [rows.asset] }, owner: 'AST-03' },
};
const IDS = Object.keys(SCREENS) as Id[];

const show = (id: Id, state: Partial<World> = {}, options: { permissions?: readonly string[] | undefined; path?: string; mode?: 'FULL' | 'READ_ONLY' } = {}) =>
  open(SCREENS[id].screen(id), world({ ...SCREENS[id].filled, ...state }), {
    permissions: 'permissions' in options ? options.permissions : READERS[id],
    path: options.path ?? `/ctr/${id.toLowerCase()}?id=${CONTRACT}`,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  });
const hrefOf = (element: HTMLElement): string | null => element.closest('a')?.getAttribute('href') ?? null;

afterEach(() => cleanup());

describe('the six aggregation views of a contract (ST-CTR-017, UI-CTR-09)', () => {
  it.each(IDS)('%s: names the contract in its heading, offers the six views side by side and a link to the screen that owns the data, and changes nothing', async (id) => {
    const h = show(id);
    await screen.findByTestId('read-only');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word(SCREENS[id].title));
    expect(screen.getByTestId('contract-code').textContent).toBe('HD-A-002');
    const tabs = within(screen.getByTestId('view-tabs'));
    expect(tabs.getAllByRole('link').map((link) => link.getAttribute('data-view'))).toEqual(IDS);
    expect(tabs.getByRole('link', { current: 'page' }).getAttribute('data-view')).toBe(id);
    expect(tabs.getByRole('link', { current: 'page' }).getAttribute('href')).toBe(`/ctr/${id.toLowerCase()}?id=${CONTRACT}`);
    expect(hrefOf(screen.getByTestId(`owner-${SCREENS[id].owner}`))).toMatch(/^\/(qms|ast|pay)\//);
    // Read-only: nothing to press, and no command is sent.
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.getByText(fill('ctr.view.footer.reference', { id, req: `FR-${id}` }))).toBeTruthy();
    expect(screen.getByRole('link', { name: word('ctr.view.back.workspace') }).getAttribute('href')).toBe(`/ctr/ctr-03?id=${CONTRACT}`);
  });

  it.each(IDS)('%s: reads the owner module for the contract named in the address and nothing else', async (id) => {
    const h = show(id);
    await screen.findByTestId('read-only');
    const reads = Object.fromEntries(
      [
        'get_resources_site_diary',
        'get_resources_quality_nonconformance',
        'listInspections',
        'get_resources_handover',
        'listWarrantyObligations',
        'get_resources_payment_request',
        'get_resources_asset_record',
      ].map((operation) => [operation, readAllOf(h, operation)]),
    );
    const asked = Object.entries(reads).filter(([, calls]) => calls.length > 0);
    expect(asked.length).toBeGreaterThan(0);
    for (const [, calls] of asked) expect(calls.every((call) => call.query?.contract_id === CONTRACT)).toBe(true);
  });

  it.each(IDS)('%s: asks for a contract when the address names none or names something that is not an identifier', async (id) => {
    for (const path of [`/ctr/${id.toLowerCase()}`, `/ctr/${id.toLowerCase()}?id=HD-A-002`]) {
      const h = show(id, {}, { path });
      expect((await screen.findByTestId('no-contract')).textContent).toContain(word('ctr.view.none.notice'));
      expect(screen.queryByTestId('view-tabs')).toBeNull();
      expect(h.read).not.toHaveBeenCalled();
      expect(readAllOf(h, 'get_resources_site_diary')).toEqual([]);
      cleanup();
    }
  });

  it.each(IDS)('%s: a reader without the right to read the data of the owner is denied, and nothing of the owner is read', async (id) => {
    const h = show(id, {}, { permissions: ['contract.read'] });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    expect(screen.queryByTestId('read-only')).toBeNull();
    for (const operation of [
      'get_resources_site_diary',
      'get_resources_quality_nonconformance',
      'get_resources_handover',
      'listWarrantyObligations',
      'get_resources_settlement_revision',
      'get_resources_asset_record',
    ])
      expect(readAllOf(h, operation)).toEqual([]);
  });

  it.each(IDS)('%s: shows the contract when the session has no list of permissions yet (the server judges every read)', async (id) => {
    show(id, {}, { permissions: undefined });
    expect(await screen.findByTestId('read-only')).toBeTruthy();
  });

  it.each(IDS)('%s: stays read-only in a read-only session', async (id) => {
    show(id, {}, { mode: 'READ_ONLY' });
    await screen.findByTestId('read-only');
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it.each(IDS)('%s: says nothing is there when the contract has no data in the owner module', async (id) => {
    show(id, { diaries: [], ncrs: [], inspections: [], handovers: [], warranties: [], settlements: [], finals: [], assets: [] });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
  });

  it.each(IDS)('%s: says nothing is there when the contract is not there for the caller', async (id) => {
    show(id, { contract: { id: 'x' } });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    expect(screen.queryByTestId('read-only')).toBeNull();
  });

  const failures: Array<[string, Error, string]> = [
    ['denied', problem(403, 'SCOPE_DENIED'), word('states.denied.title')],
    ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c', extensions: {} }), word('states.offline.title')],
    ['error', problem(500, 'INTERNAL_ERROR'), word('states.error.title')],
    ['signed out', problem(401, 'SESSION_EXPIRED'), word('states.signedOut.title')],
  ];
  for (const id of IDS) {
    it.each(failures)(`${id}: shows the state %s of a failed read of the owner, and never half a view`, async (_name, failure, title) => {
      show(id, { failing: failure });
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.queryByTestId('read-only')).toBeNull();
    });
  }

  it.each(IDS)('%s: shows the loading state while the owner answers, and reads again on a retry of a failed read', async (id) => {
    show(id, { loading: true });
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    const h = show(id, { failing: problem(500, 'INTERNAL_ERROR') });
    const retry = await screen.findByRole('button', { name: word('states.retry.action') });
    const before = h.read.mock.calls.length;
    retry.click();
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(before));
  });

  it.each(IDS)('%s: shows the failed read of the contract itself as a state of the view', async (id) => {
    show(id, { contract: problem(403, 'SCOPE_DENIED') });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });

  it.each(IDS.filter((id) => id !== 'CTR-09' && id !== 'CTR-11' && id !== 'CTR-15'))('%s: a guest contractor sees none of the financial columns, whatever the owner answered', async (id) => {
    show(id, { contract: guestContract() });
    await screen.findByTestId('guest-notice');
    expect(screen.getByTestId('guest-notice').textContent).toBe(word('ctr.view.guest.notice'));
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent ?? '');
    expect(headers.filter((header) => /VND/.test(header))).toEqual([]);
    for (const money of ['500.000.000', '150.000.000', '3.200.000.000', '9.850.000.000', '8.100.000.000', '9.000.000.000']) expect(document.body.textContent).not.toContain(money);
  });

  it.each(IDS)('%s: a staff reader is told nothing about guests', async (id) => {
    show(id);
    await screen.findByTestId('read-only');
    expect(screen.queryByTestId('guest-notice')).toBeNull();
  });
});

describe('CTR-09: the site diaries', () => {
  it('UI-CTR-09: lists each diary with its day, its status, the weather, the workforce and the roles that signed, each linking to QMS-03', async () => {
    show('CTR-09', { diaries: [rows.diary, { id: 'x' }] });
    const table = await screen.findByTestId('diaries');
    const row = table.querySelector('[data-diary]') as HTMLElement;
    expect(within(row).getByTestId('date').textContent).toBe('2026-10-21');
    expect(within(row).getByTestId('status').textContent).toBe(word('qms.diary.status.contractorSigned'));
    expect(within(row).getByTestId('weather').textContent).toBe(word('qms.diary.weather.sunny'));
    expect(within(row).getByTestId('workforce').textContent).toBe('12');
    expect(within(row).getByTestId('signed').textContent).toBe(word('qms.diary.role.contractor'));
    expect(within(row).getByTestId('conflicts').textContent).toBe('0');
    expect(hrefOf(within(row).getByTestId('open'))).toBe(`/qms/qms-03?diary=${rows.diary.id}`);
    // A row that is not a diary is left out.
    expect(table.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(hrefOf(screen.getByTestId('owner-QMS-01'))).toBe('/qms/qms-01');
    expect(hrefOf(screen.getByTestId('owner-QMS-11'))).toBe(`/qms/qms-11?contract=${CONTRACT}`);
  });

  it('shows a draft that nobody signed, without weather or workforce, and the copies of devices that wait', async () => {
    const draft = {
      ...rows.diary,
      status: 'DRAFT',
      signatures: [],
      weather_code: null,
      workforce_count: null,
      conflicts: [{ id: 'c1', diary_no: 'NK-C1', state: 'CONFLICT_PENDING', created_at: '2026-10-21T03:00:00.000Z', author: { display_name: 'Nhà thầu' }, content: {} }],
    };
    show('CTR-09', { diaries: [draft] });
    const table = await screen.findByTestId('diaries');
    expect(within(table).getByTestId('signed').textContent).toBe(word('ctr.diaryView.signed.none'));
    expect(within(table).getByTestId('weather').textContent).toBe('–');
    expect(within(table).getByTestId('workforce').textContent).toBe('–');
    expect(within(table).getByTestId('conflicts').textContent).toBe('1');
  });

  it('ignores a signature that is void', async () => {
    show('CTR-09', { diaries: [{ ...rows.diary, signatures: [{ ...contractorSignature, valid: false }] }] });
    expect((await screen.findByTestId('signed')).textContent).toBe(word('ctr.diaryView.signed.none'));
  });

  it('shows the coverage of the month beside the diaries (FR-CTR-09)', async () => {
    const h = show('CTR-09', { diaries: [rows.diary] });
    await screen.findByTestId('cover-working');
    expect(screen.getByTestId('cover-working').textContent).toBe('2');
    expect(screen.getByTestId('cover-signed').textContent).toBe('1');
    expect(screen.getByTestId('cover-draft').textContent).toBe('0');
    expect(screen.getByTestId('cover-missing').textContent).toBe('1');
    expect(screen.getByTestId('cover-late').textContent).toBe('1');
    const call = h.read.mock.calls.find((one) => one[0] === 'getDiaryCoverage');
    expect(call?.[1]).toMatchObject({ path: { id: CONTRACT } });
  });

  it('says the coverage is not there when the contract has no calendar in force, and keeps the diaries', async () => {
    show('CTR-09', { diaries: [rows.diary], coverage: problem(409, 'CALENDAR_NOT_EFFECTIVE') });
    await waitFor(() => expect(screen.getByTestId('coverage-none').textContent).toBe(word('ctr.diaryView.cover.unavailable')));
    expect(screen.getByTestId('diaries')).toBeTruthy();
  });
});

describe('CTR-11: the quality of the work', () => {
  it('UI-CTR-11: lists the non-conformances and the inspections of the contract, and says how many block the acceptance (FR-CTR-11)', async () => {
    show('CTR-11');
    await screen.findByTestId('ncrs');
    const ncr = screen.getByTestId('ncrs').querySelector('[data-ncr]') as HTMLElement;
    expect(within(ncr).getByTestId('no').textContent).toBe('NCR-001');
    expect(within(ncr).getByTestId('severity').textContent).toBe(word('qms.ncr.severity.critical'));
    expect(within(ncr).getByTestId('status').textContent).toBe(word('qms.ncr.status.open'));
    expect(within(ncr).getByTestId('due').textContent).toBe(`2026-11-05 · ${word('ctr.qualityView.due.overdue')}`);
    expect(within(ncr).getByTestId('blocks').textContent).toBe(word('ctr.qualityView.blocks.yes'));
    const inspection = screen.getByTestId('inspections').querySelector('[data-inspection]') as HTMLElement;
    expect(within(inspection).getByTestId('no').textContent).toBe('KT-001');
    expect(within(inspection).getByTestId('requested').textContent).toBe('2026-10-30');
    expect(within(inspection).getByTestId('status').textContent).toBe(word('qms.inspection.status.resultRecorded'));
    expect(within(inspection).getByTestId('result').textContent).toBe(word('qms.inspection.result.pass'));
    expect(screen.getByTestId('blocking').textContent).toBe(fill('ctr.qualityView.blocking.some', { count: 1 }));
    expect(hrefOf(screen.getByTestId('owner-QMS-07'))).toBe(`/qms/qms-07?contract=${CONTRACT}`);
    expect(hrefOf(screen.getByTestId('owner-QMS-04'))).toBe(`/qms/qms-04?contract=${CONTRACT}`);
  });

  it('says no NCR blocks the acceptance, and that a part with nothing to show is empty', async () => {
    show('CTR-11', { ncrs: [], inspections: [{ ...rows.inspection, status: 'REQUESTED', result: null }] });
    expect((await screen.findByTestId('blocking')).textContent).toBe(word('ctr.qualityView.blocking.none'));
    expect(screen.getByTestId('no-ncrs').textContent).toBe(word('ctr.qualityView.ncr.empty'));
    expect(screen.getByTestId('result').textContent).toBe('–');
    cleanup();
    show('CTR-11', { ncrs: [{ ...rows.ncr, blocks_acceptance: false, overdue: false }], inspections: [] });
    expect((await screen.findByTestId('no-inspections')).textContent).toBe(word('ctr.qualityView.inspection.empty'));
    expect(screen.getByTestId('due').textContent).toBe('2026-11-05');
    expect(screen.getByTestId('blocks').textContent).toBe(word('ctr.qualityView.blocks.no'));
  });

  it('needs the right to read both the non-conformances and the inspections', async () => {
    show('CTR-11', {}, { permissions: ['quality_nonconformance.read'] });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });
});

describe('CTR-15: completion and handover', () => {
  it('UI-CTR-15: lists the handovers with the kind, the receiving unit, the dates and the critical items still open, each linking to AST-02', async () => {
    show('CTR-15', {
      handovers: [rows.handover, { ...rows.handover, id: 'h2', handover_no: 'BG-002', status: 'DRAFT', planned_on: null, accepted_at: null, open_critical_punch_count: 2 }, { id: 'x' }],
    });
    const table = await screen.findByTestId('handovers');
    const first = table.querySelector(`[data-handover="${rows.handover.id}"]`) as HTMLElement;
    expect(within(first).getByTestId('kind').textContent).toBe(word('ast.handover.kind.completion'));
    expect(within(first).getByTestId('status').textContent).toBe(word('ast.handover.status.accepted'));
    expect(within(first).getByTestId('unit').textContent).toBe('Sở Giao thông');
    expect(within(first).getByTestId('planned').textContent).toBe('2026-11-10');
    expect(within(first).getByTestId('handed').textContent).toBe('–');
    expect(within(first).getByTestId('accepted-at').textContent).toBe('2026-10-28');
    expect(within(first).getByTestId('items').textContent).toBe('3');
    expect(hrefOf(within(first).getByTestId('open'))).toBe(`/ast/ast-02?id=${rows.handover.id}`);
    const second = table.querySelector('[data-handover="h2"]') as HTMLElement;
    expect(within(second).getByTestId('planned').textContent).toBe('–');
    expect(within(second).getByTestId('accepted-at').textContent).toBe('–');
    expect(within(second).getByTestId('critical').textContent).toBe('2');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(screen.getByTestId('accepted').textContent).toBe(fill('ctr.handoverView.accepted.notice', { accepted: 1, total: 2 }));
    expect(hrefOf(screen.getByTestId('owner-AST-01'))).toBe('/ast/ast-01');
  });
});

describe('CTR-16: warranty', () => {
  it('UI-CTR-16: lists the obligations with their term, their status and their claims, and the guarantee and the retention for the staff', async () => {
    show('CTR-16', {
      warranties: [
        rows.warranty,
        { ...rows.warranty, id: 'w2', status: 'CLOSED', asset: { id: 'a1', asset_code: 'AS-001', name: 'Trạm bơm', status: 'REGISTERED' }, guarantee: null, open_claims: 2, total_claims: 3 },
      ],
    });
    const table = await screen.findByTestId('warranties');
    const first = table.querySelector(`[data-warranty="${rows.warranty.id}"]`) as HTMLElement;
    expect(within(first).getByTestId('open').textContent).toBe('Phạm vi bảo hành 1');
    expect(hrefOf(within(first).getByTestId('open'))).toBe(`/ast/ast-04?handover=${rows.warranty.handover.id}`);
    expect(within(first).getByTestId('handover').textContent).toBe('BG-001');
    expect(within(first).getByTestId('starts').textContent).toBe('2026-09-01');
    expect(within(first).getByTestId('ends').textContent).toBe('2999-09-01');
    expect(within(first).getByTestId('months').textContent).toBe('12');
    expect(within(first).getByTestId('status').textContent).toBe(word('ast.warranty.status.active'));
    expect(within(first).getByTestId('claims').textContent).toBe(fill('ctr.warrantyView.claims.value', { open: 0, total: 0 }));
    expect(within(first).getByTestId('guarantee').textContent).toBe('500.000.000');
    expect(within(first).getByTestId('retention').textContent).toBe('150.000.000');
    const second = table.querySelector('[data-warranty="w2"]') as HTMLElement;
    expect(within(second).getByTestId('open').textContent).toBe('AS-001 · Trạm bơm');
    expect(within(second).getByTestId('guarantee').textContent).toBe('–');
    expect(within(second).getByTestId('claims').textContent).toBe(fill('ctr.warrantyView.claims.value', { open: 2, total: 3 }));
    expect(screen.getByTestId('running').textContent).toBe(fill('ctr.warrantyView.running.notice', { running: 1, total: 2 }));
    expect(screen.getByTestId('release-note').textContent).toBe(word('ctr.warrantyView.release.notice'));
    expect(hrefOf(screen.getByTestId('owner-AST-04'))).toBe('/ast/ast-04');
  });

  it('shows the term and the claims to a guest contractor, without the guarantee and the retention', async () => {
    show('CTR-16', { contract: guestContract() });
    const table = await screen.findByTestId('warranties');
    expect(within(table).getByTestId('ends').textContent).toBe('2999-09-01');
    expect(within(table).queryByTestId('guarantee')).toBeNull();
    expect(within(table).queryByTestId('retention')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: word('ctr.warrantyView.column.retention') })).toBeNull();
  });
});

describe('CTR-17: settlement', () => {
  it('UI-CTR-17: lists the settlements of the contract and of its project and the final payment requests, linking to PAY', async () => {
    const h = show('CTR-17', { settlements: [projectSettlement, ownSettlement, otherContractSettlement] });
    const table = await screen.findByTestId('settlements');
    const rowsShown = Array.from(table.querySelectorAll('[data-settlement]')) as HTMLElement[];
    // The settlement of another contract of the project is not this contract's.
    expect(rowsShown).toHaveLength(2);
    const [project, own] = rowsShown as [HTMLElement, HTMLElement];
    expect(within(project).getByTestId('open').textContent).toBe(word('pay.settlement.scope.project'));
    expect(hrefOf(within(project).getByTestId('open'))).toBe(`/pay/pay-15?settlement=${projectSettlement.id}`);
    expect(within(project).getByTestId('year').textContent).toBe('–');
    expect(within(project).getByTestId('status').textContent).toBe(word('pay.settlement.status.closed'));
    expect(within(project).getByTestId('closed').textContent).toBe('2026-10-29');
    expect(within(project).getByTestId('settled').textContent).toBe('9.850.000.000');
    expect(within(project).getByTestId('outstanding').textContent).toBe('150.000.000');
    expect(within(project).getByTestId('advance').textContent).toBe('0');
    expect(within(own).getByTestId('open').textContent).toBe(word('pay.settlement.scope.contract'));
    expect(within(own).getByTestId('revision').textContent).toBe('1');
    expect(within(own).getByTestId('submitted').textContent).toBe('2026-10-01');
    expect(within(own).getByTestId('due').textContent).toBe('2027-03-30');
    expect(within(own).getByTestId('closed').textContent).toBe('–');
    const request = screen.getByTestId('finals').querySelector('[data-request]') as HTMLElement;
    expect(within(request).getByTestId('open-request').textContent).toBe('DNTT-001');
    expect(hrefOf(within(request).getByTestId('open-request'))).toMatch(/^\/pay\/pay-03\?/);
    expect(within(request).getByTestId('kind').textContent).toBe(word('pay.payment.kind.final'));
    expect(within(request).getByTestId('request-status').textContent).toBe(word('pay.payment.status.settled'));
    expect(within(request).getByTestId('paid').textContent).toBe('2026-10-30');
    expect(within(request).getByTestId('gross').textContent).toBe('9.000.000.000');
    expect(within(request).getByTestId('net').textContent).toBe('8.100.000.000');
    expect(hrefOf(screen.getByTestId('owner-PAY-15'))).toBe('/pay/pay-15');
    expect(hrefOf(screen.getByTestId('owner-PAY-01'))).toMatch(/^\/pay\/pay-01\?/);
    // The settlements are read for the project of the contract, the requests for the contract and for the final kind alone.
    expect(readAllOf(h, 'get_resources_settlement_revision')[0]?.query).toMatchObject({ project_id: staffContract().project_id });
    expect(readAllOf(h, 'get_resources_payment_request')[0]?.query).toMatchObject({ contract_id: CONTRACT, request_kind: 'FINAL' });
  });

  it('reads nothing of PAY before the contract is there, since the project comes from it', async () => {
    const h = show('CTR-17', { contract: problem(500, 'INTERNAL_ERROR') });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    expect(readAllOf(h, 'get_resources_settlement_revision')).toEqual([]);
    expect(readAllOf(h, 'get_resources_payment_request')).toEqual([]);
  });

  it('shows a guest contractor the status and the dates of the settlement and of the request, without any amount', async () => {
    show('CTR-17', { contract: guestContract(), settlements: [ownSettlement] });
    const table = await screen.findByTestId('settlements');
    expect(within(table).getByTestId('status').textContent).toBe(word('pay.settlement.status.verified'));
    for (const id of ['settled', 'outstanding', 'advance', 'gross', 'net']) expect(screen.queryByTestId(id)).toBeNull();
  });

  it('says so when there is a settlement and no final request, or the other way round', async () => {
    show('CTR-17', { settlements: [ownSettlement], finals: [] });
    expect((await screen.findByTestId('no-finals')).textContent).toBe(word('ctr.settlementView.finals.empty'));
    cleanup();
    show('CTR-17', { settlements: [], finals: [finalRequest] });
    expect((await screen.findByTestId('no-settlements')).textContent).toBe(word('ctr.settlementView.settlements.empty'));
    expect(screen.getByTestId('open-request').textContent).toBe('DNTT-001');
  });

  it('needs the right to read both the settlements and the payment requests', async () => {
    show('CTR-17', {}, { permissions: ['settlement_revision.read'] });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
  });
});

describe('CTR-18: assets', () => {
  it('UI-CTR-18: lists the assets of the contract with the handover, the receiving unit, the dates and, for the staff, the value and its basis; and checks the total against the contract (FR-CTR-18)', async () => {
    show('CTR-18', {
      assets: [
        rows.asset,
        asset(2, {
          value_vnd: '1800000000',
          value_basis: null,
          name: null,
          status: 'TRANSFERRED',
          transferred_on: '2026-10-30',
          warranty_until: '2027-10-30',
          handover: { id: 'h1', handover_no: null, status: 'ACCEPTED' },
        }),
      ],
    });
    const table = await screen.findByTestId('assets');
    const first = table.querySelector(`[data-asset="${rows.asset.id}"]`) as HTMLElement;
    expect(within(first).getByTestId('open').textContent).toBe('AS-001');
    expect(hrefOf(within(first).getByTestId('open'))).toBe(`/ast/ast-03?handover=${rows.asset.handover.id}`);
    expect(within(first).getByTestId('name').textContent).toBe('Trạm bơm 1');
    expect(within(first).getByTestId('handover').textContent).toBe('BG-001');
    expect(within(first).getByTestId('unit').textContent).toBe('Sở Giao thông');
    expect(within(first).getByTestId('status').textContent).toBe(word('ast.asset.status.registered'));
    expect(within(first).getByTestId('registered').textContent).toBe('2026-10-20');
    expect(within(first).getByTestId('transferred').textContent).toBe('–');
    expect(within(first).getByTestId('value').textContent).toBe('3.200.000.000');
    expect(within(first).getByTestId('basis').textContent).toBe(word('ast.asset.basis.contractValue'));
    const second = table.querySelector(`[data-asset="${asset(2).id}"]`) as HTMLElement;
    expect(within(second).getByTestId('name').textContent).toBe('–');
    expect(within(second).getByTestId('handover').textContent).toBe('–');
    expect(within(second).getByTestId('transferred').textContent).toBe('2026-10-30');
    expect(within(second).getByTestId('warranty').textContent).toBe('2027-10-30');
    expect(within(second).getByTestId('basis').textContent).toBe('–');
    expect(screen.getByTestId('total').textContent).toBe(fill('ctr.assetView.total.within', { total: '5.000.000.000', contract: '10.200.000.000' }));
    expect(screen.getByTestId('total').className).not.toContain('warning');
    expect(hrefOf(screen.getByTestId('owner-AST-03'))).toBe('/ast/ast-03');
  });

  it('warns when the assets come to more than the contract is worth', async () => {
    show('CTR-18', { assets: [asset(1, { value_vnd: '11000000000' })] });
    const total = await screen.findByTestId('total');
    expect(total.textContent).toBe(fill('ctr.assetView.total.over', { total: '11.000.000.000', contract: '10.200.000.000' }));
    expect(total.className).toContain('warning');
  });

  it('shows a value that the server left out as a dash, and leaves the check out for a reader of a guest contract', async () => {
    show('CTR-18', { assets: [asset(1, { value_vnd: null, value_basis: null })] });
    expect((await screen.findByTestId('value')).textContent).toBe('–');
    cleanup();
    show('CTR-18', { contract: guestContract(), assets: [rows.asset] });
    await screen.findByTestId('assets');
    expect(screen.queryByTestId('total')).toBeNull();
    expect(screen.queryByTestId('value')).toBeNull();
    expect(screen.queryByTestId('basis')).toBeNull();
    expect(document.body.textContent).not.toContain('3.200.000.000');
  });
});
