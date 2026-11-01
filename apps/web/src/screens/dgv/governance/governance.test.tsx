import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { mountInSession } from '../../doc/test-support';
import { harness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { dataset, routeOf } from '../test-support';
import ChangeApprovalScreen from './ChangeApprovalScreen';
import ClassificationScreen from './ClassificationScreen';
import DuplicatesScreen from './DuplicatesScreen';
import RetentionScreen from './RetentionScreen';
import {
  activeHolds,
  changesOf,
  classificationCounts,
  decisionCounts,
  differences,
  duplicateRows,
  holds,
  holdsPersonalData,
  inForce,
  masterTypesOf,
  routesOf,
  valueText,
  waitingByClass,
  NO_DUPLICATE_FILTER,
} from './model';
import { toMerge } from '../../mdm/merge/model';
import { toChange } from '../../mdm/model';
import { toHold, toPolicy, toReviewItem } from '../../adm/retention/model';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const uuid = (n: number): string => `00000000-0000-4000-8000-${'0401'}${String(n).padStart(8, '0')}`;
const CCCD = '001099012345';

const merge = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(n),
  survivor_record_id: uuid(100 + n),
  survivor_key: `NCC-${n}`,
  merged_record_id: uuid(200 + n),
  merged_key: `NCC-DUP-${n}`,
  master_type: 'SUPPLIER',
  decisions: [
    { attribute: 'name', chosen: 'SURVIVOR', by: 'RULE', strategy: 'MOST_RECENT', source: null },
    { attribute: 'tax', chosen: 'MERGED', by: 'OVERRIDE', strategy: null, source: null },
    { attribute: 'phone', chosen: 'SURVIVOR', by: 'ONLY_ONE', strategy: null, source: null },
    { attribute: 'city', chosen: 'SURVIVOR', by: 'EQUAL', strategy: null, source: null },
  ],
  aliases: { merged_key: `NCC-DUP-${n}`, merged_label: `Nhà cung cấp ${n}` },
  repointed: [
    { table: 'contract', id: uuid(300) },
    { table: 'payment', id: uuid(301) },
  ],
  reason: 'Trùng mã số thuế',
  status: 'APPLIED',
  applied_at: `2026-10-0${n}T03:00:00Z`,
  reverted_at: null,
  revert_reason: null,
  version: 1,
  ...extra,
});
const policy = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(500 + n),
  record_class: 'project_dossier',
  revision: n,
  retention_years: 10,
  retention_basis: 'FROM_CLOSED',
  legal_basis_ref: 'Luat Luu tru',
  end_action: 'REVIEW_FOR_DESTRUCTION',
  effective_from: '2026-01-01',
  status: 'Published',
  created_by: uuid(1),
  approved_by: uuid(2),
  published_at: '2026-01-01T00:00:00Z',
  version: 1,
  ...extra,
});
const hold = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(600 + n),
  hold_kind: 'LITIGATION',
  status: 'Active',
  resource_scope: { kind: 'PROJECT', ids: [uuid(1), uuid(2)] },
  authority_reference: `QD-${n}/2026`,
  reason: 'Tranh chấp',
  effective_at: '2026-09-15T00:00:00Z',
  ...extra,
});
const review = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(700 + n),
  record_class: 'project_dossier',
  resource_type: 'project',
  resource_id: uuid(n),
  basis_date: '2016-01-01',
  due_on: `2026-10-0${n}`,
  end_action: 'REVIEW_FOR_DESTRUCTION',
  ...extra,
});
const docRule = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(800 + n),
  rule_set: 'TT74_2025_BTC',
  category_code: `CAT-${n}`,
  class_code: 'Y20',
  retention_years: 20,
  start_basis: 'FROM_CLOSED',
  status: 'PUBLISHED',
  version: 1,
  ...extra,
});
const change = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(900 + n),
  change_kind: 'UPDATE',
  master_type: 'SUPPLIER',
  business_key: `NCC-${n}`,
  master_record_namespace: 'TENANT',
  master_record_id: uuid(n),
  master_record_version: 1,
  status: 'IN_REVIEW',
  proposed: { name: 'Cong ty B', tax: '0100109106' },
  before: { name: 'Cong ty A', tax: '0100109106' },
  reason: 'Đổi tên theo giấy phép mới',
  impact: { counts: { contract: 2 }, total: 2 },
  effective_from: `2026-11-0${n}`,
  created_by: uuid(7),
  reviewed_by: null,
  decision_document_id: null,
  version: 1,
  ...extra,
});

interface World {
  merges: Array<Record<string, unknown>>;
  policies: Array<Record<string, unknown>>;
  holds: Array<Record<string, unknown>>;
  review: Array<Record<string, unknown>>;
  rules: Array<Record<string, unknown>>;
  changes: Array<Record<string, unknown>>;
  datasets: Array<Record<string, unknown>>;
  failing: Set<string>;
}

const ALL = ['master.read', 'adm.retention.read', 'legal_hold.read', 'doc.retention.read', 'data.catalog.read'];

function open(screenOf: (route: ReturnType<typeof routeOf>) => ReactElement, id: string, state: Partial<World> = {}, permissions: readonly string[] | undefined = ALL): Harness & { world: World } {
  const world: World = { merges: [], policies: [], holds: [], review: [], rules: [], changes: [], datasets: [], failing: new Set(), ...state };
  const h = harness(() => new Error('unexpected read'));
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string, input?: { query?: Record<string, string> }) => {
    if (world.failing.has(operation)) return Promise.reject(world.failing.has('denied') ? new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }) : new Error(`${operation} failed`));
    switch (operation) {
      case 'listMasterMerges':
        return Promise.resolve(world.merges);
      case 'get_resources_data_retention_policy':
        return Promise.resolve(world.policies);
      case 'get_resources_legal_hold':
        return Promise.resolve(world.holds);
      case 'get_resources_retention_review_item':
        return Promise.resolve(world.review);
      case 'listDocumentRetentionRules':
        return Promise.resolve(world.rules);
      case 'listMasterChangeRequests':
        return Promise.resolve(world.changes.filter((row) => row.status === input?.query?.status));
      case 'searchCatalog':
        return Promise.resolve(world.datasets);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  mountInSession(screenOf(routeOf(id, `FR-${id}`)), h, { permissions }, `/dgv/${id.toLowerCase()}`);
  return Object.assign(h, { world });
}

const readAllNames = (h: Harness): string[] => (h.client.readAll as unknown as { mock: { calls: string[][] } }).mock.calls.map((call) => call[0] as string);
const change_ = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const bodyRows = (table: HTMLElement): HTMLElement[] => within(table).getAllByRole('row').slice(1);

afterEach(() => cleanup());

describe('the model of the governance views (ST-DGV-010)', () => {
  const merges = [
    merge(1),
    merge(2, { status: 'REVERTED', reverted_at: '2026-10-09T00:00:00Z', master_type: 'CONTRACTOR', merged_label: null, aliases: null }),
    merge(3, { master_type: 'SUPPLIER', applied_at: '2026-10-05T03:00:00Z' }),
  ].flatMap((raw) => toMerge(raw) ?? []);

  it('filters the merges by state, type and words, the latest first, and lists the types once', () => {
    expect(duplicateRows(merges, NO_DUPLICATE_FILTER).map((row) => row.id)).toEqual([uuid(3), uuid(2), uuid(1)]);
    expect(duplicateRows(merges, { ...NO_DUPLICATE_FILTER, status: 'REVERTED' }).map((row) => row.id)).toEqual([uuid(2)]);
    expect(duplicateRows(merges, { ...NO_DUPLICATE_FILTER, masterType: 'SUPPLIER' })).toHaveLength(2);
    expect(duplicateRows(merges, { ...NO_DUPLICATE_FILTER, words: ' nhà cung cấp 1' }).map((row) => row.id)).toEqual([uuid(1)]);
    expect(duplicateRows(merges, { ...NO_DUPLICATE_FILTER, words: 'ncc-dup-2' })).toHaveLength(1);
    expect(duplicateRows(merges, { ...NO_DUPLICATE_FILTER, words: 'zzz' })).toEqual([]);
    expect(masterTypesOf(merges)).toEqual(['CONTRACTOR', 'SUPPLIER']);
  });

  it('counts how the values of the golden record were chosen', () => {
    expect(decisionCounts(merges[0] as NonNullable<(typeof merges)[number]>)).toEqual({ rule: 1, override: 1, other: 2 });
    expect(decisionCounts({ decisions: [] })).toEqual({ rule: 0, override: 0, other: 0 });
  });

  it('keeps the latest published rule of each kind, counts what waits and which holds are active', () => {
    const policies = [
      policy(1),
      policy(2, { retention_years: 15 }),
      policy(3, { status: 'Draft' }),
      policy(1, { id: uuid(555), record_class: 'audit_event', retention_years: null, retention_basis: 'PERMANENT' }),
    ].flatMap((raw) => toPolicy(raw) ?? []);
    const forced = inForce(policies);
    expect(forced.map((entry) => [entry.recordClass, entry.revision])).toEqual([
      ['audit_event', 1],
      ['project_dossier', 2],
    ]);
    const waiting = waitingByClass([review(3), review(1), review(2, { record_class: 'audit_event' })].flatMap((raw) => toReviewItem(raw) ?? []));
    expect(waiting.get('project_dossier')).toEqual({ count: 2, earliestDue: '2026-10-01' });
    expect(waiting.get('audit_event')).toEqual({ count: 1, earliestDue: '2026-10-02' });
    expect(activeHolds([hold(1), hold(2, { status: 'Released' })].flatMap((raw) => toHold(raw) ?? []))).toHaveLength(1);
  });

  it('shows what a change moves, only where it differs, with personal numbers hidden', () => {
    const read = toChange(change(1, { before: { name: 'A', phone: '0912345678', gone: 1 }, proposed: { name: 'B', phone: '0912345678', added: { x: CCCD } } })) as NonNullable<
      ReturnType<typeof toChange>
    >;
    expect(differences(read)).toEqual([
      { attribute: 'added', before: '—', after: `{"x":"***"}` },
      { attribute: 'gone', before: '1', after: '—' },
      { attribute: 'name', before: 'A', after: 'B' },
    ]);
    expect(differences({ before: null, proposed: { a: 1 } })).toEqual([{ attribute: 'a', before: '—', after: '1' }]);
    expect(valueText(null)).toBe('—');
    expect(valueText(undefined)).toBe('—');
    expect(valueText(`so ${CCCD}`)).toBe('so ***');
  });

  it('keeps the changes of a type, the latest day first', () => {
    const list = [change(1), change(2, { master_type: 'CONTRACTOR' }), change(3)].flatMap((raw) => toChange(raw) ?? []);
    expect(changesOf(list, '').map((entry) => entry.id)).toEqual([uuid(903), uuid(902), uuid(901)]);
    expect(changesOf(list, 'SUPPLIER').map((entry) => entry.id)).toEqual([uuid(903), uuid(901)]);
  });

  it('counts the five levels from the rows it is given, names personal data and the routes of a level', () => {
    expect(classificationCounts([{ classification: 'PUBLIC' }, { classification: 'PUBLIC' }, { classification: 'IMPORTANT_CORE' }])).toEqual({
      PUBLIC: 2,
      INTERNAL: 0,
      CONFIDENTIAL: 0,
      PERSONAL: 0,
      IMPORTANT_CORE: 1,
    });
    expect(holdsPersonalData('PERSONAL')).toBe(true);
    expect(holdsPersonalData('INTERNAL')).toBe(false);
    expect(routesOf('IMPORTANT_CORE')).toEqual(['SELF_HOSTED']);
    expect(holds(undefined, 'x')).toBe(true);
    expect(holds(['x'], 'x')).toBe(true);
    expect(holds(['y'], 'x')).toBe(false);
  });
});

describe('DGV-10 duplicate governance', () => {
  const screenOf = (route: ReturnType<typeof routeOf>) => <DuplicatesScreen route={route} />;

  it('lists the merges with the golden record, how the values were chosen, the impact and the state, and writes nothing', async () => {
    const h = open(screenOf, 'DGV-10', { merges: [merge(1), merge(2, { status: 'REVERTED', reverted_at: '2026-10-09T00:00:00Z', master_type: 'CONTRACTOR', aliases: null })] });
    expect(await screen.findByRole('heading', { level: 1, name: word('dgv.governance.dup.page.title') })).toBeTruthy();
    const rows = bodyRows(await screen.findByTestId('duplicates-table'));
    expect(rows.map((row) => row.getAttribute('data-merge-id'))).toEqual([uuid(2), uuid(1)]);
    const applied = within(rows[1] as HTMLElement);
    expect(applied.getByText('NCC-DUP-1')).toBeTruthy();
    expect(applied.getByText('Nhà cung cấp 1')).toBeTruthy();
    expect(applied.getByText('NCC-1')).toBeTruthy();
    expect(applied.getByTestId('dup-chosen').textContent).toContain(word('dgv.governance.dup.chosen.text').replace('{rule}', '1').replace('{override}', '1').replace('{other}', '2'));
    expect(applied.getByTestId('dup-chosen').textContent).toContain(word('mdm.merge.by.override'));
    expect(applied.getByText(word('dgv.governance.dup.impact.text').replace('{count}', '2'))).toBeTruthy();
    expect(applied.getByText(word('mdm.merge.status.applied'))).toBeTruthy();
    expect(applied.getByText('2026-10-01')).toBeTruthy();
    const undone = within(rows[0] as HTMLElement);
    expect(undone.getByText(word('dgv.governance.dup.reverted.text').replace('{day}', '2026-10-09'))).toBeTruthy();
    expect(undone.queryByTestId('dup-chosen')?.textContent).toContain(word('mdm.merge.by.override'));
    expect(screen.getByTestId('duplicates-note').textContent).toBe(word('dgv.governance.dup.candidates.note'));
    expect(screen.getByRole('link', { name: word('dgv.governance.dup.history.link') }).getAttribute('href')).toBe('/mdm/mdm-35');
    expect(h.command).not.toHaveBeenCalled();
    expect(readAllNames(h)).toEqual(['listMasterMerges']);
  });

  it('narrows by words, state and type, and says so when none matches', async () => {
    open(screenOf, 'DGV-10', { merges: [merge(1), merge(2, { status: 'REVERTED', reverted_at: '2026-10-09T00:00:00Z', master_type: 'CONTRACTOR' }), merge(3, { decisions: [] })] });
    const table = await screen.findByTestId('duplicates-table');
    expect(bodyRows(table)).toHaveLength(3);
    change_('dup-status', 'REVERTED');
    expect(bodyRows(table)).toHaveLength(1);
    change_('dup-status', '');
    change_('dup-type', 'SUPPLIER');
    expect(bodyRows(table)).toHaveLength(2);
    change_('dup-words', 'ncc-dup-3');
    expect(bodyRows(table)).toHaveLength(1);
    change_('dup-words', 'zzz');
    expect(screen.getByTestId('duplicates-none')).toBeTruthy();
  });

  it('shows the empty, failed and denied states, and is denied without the right to read master data', async () => {
    open(screenOf, 'DGV-10');
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    const h = open(screenOf, 'DGV-10', { failing: new Set(['listMasterMerges']) });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    h.world.failing.clear();
    h.world.merges = [merge(1)];
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    expect(await screen.findByTestId('duplicates-table')).toBeTruthy();
    cleanup();
    open(screenOf, 'DGV-10', { failing: new Set(['listMasterMerges', 'denied']) });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    cleanup();
    const denied = open(screenOf, 'DGV-10', { merges: [merge(1)] }, ['data.catalog.read']);
    expect(await screen.findByTestId('duplicates-denied')).toBeTruthy();
    expect(readAllNames(denied)).toEqual([]);
    cleanup();
    open(screenOf, 'DGV-10', { merges: [merge(1)] }, undefined);
    expect(await screen.findByTestId('duplicates-table')).toBeTruthy();
  });
});

describe('DGV-11 retention and legal hold', () => {
  const screenOf = (route: ReturnType<typeof routeOf>) => <RetentionScreen route={route} />;
  const full = (): Partial<World> => ({
    policies: [
      policy(1),
      policy(2, { retention_years: 15 }),
      policy(1, { id: uuid(556), record_class: 'audit_event', retention_years: null, retention_basis: 'PERMANENT', end_action: 'ARCHIVE_TRANSFER' }),
    ],
    review: [review(3), review(1)],
    holds: [hold(1), hold(2, { status: 'Released' })],
    rules: [docRule(1), docRule(2, { status: 'DRAFT' })],
  });

  it('shows the retention of each kind of data, what waits, the holds in force and the retention rules of documents, from ADM and DOC, and writes nothing', async () => {
    const h = open(screenOf, 'DGV-11', full());
    expect(await screen.findByRole('heading', { level: 1, name: word('dgv.governance.ret.page.title') })).toBeTruthy();
    const policies = await screen.findByTestId('retention-policies');
    await within(policies).findByText('project_dossier');
    const rows = bodyRows(policies);
    expect(rows.map((row) => row.getAttribute('data-record-class'))).toEqual(['audit_event', 'project_dossier']);
    expect(within(rows[1] as HTMLElement).getByText(word('dgv.governance.ret.years.text').replace('{years}', '15').replace('{basis}', word('adm.retention.basis.closed')))).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(word('adm.retention.endAction.review'))).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByTestId('retention-waiting').textContent).toBe(word('dgv.governance.ret.waiting.text').replace('{count}', '2').replace('{day}', '2026-10-01'));
    expect(within(rows[0] as HTMLElement).getByText(word('adm.retention.basis.permanent'))).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByTestId('retention-waiting').textContent).toBe('—');
    const holds_ = await screen.findByTestId('retention-holds');
    await within(holds_).findByTestId('holds-summary');
    expect(within(holds_).getByTestId('holds-summary').textContent).toBe(word('dgv.governance.ret.holds.summary').replace('{count}', '1'));
    expect(within(holds_).getByText('QD-1/2026')).toBeTruthy();
    expect(within(holds_).getByText(word('dgv.governance.ret.holds.scoped').replace('{scope}', word('adm.retention.hold.scope.project')).replace('{count}', '2'))).toBeTruthy();
    expect(within(holds_).getByText('2026-09-15')).toBeTruthy();
    const docs = await screen.findByTestId('retention-doc-rules');
    await within(docs).findByText('CAT-1');
    expect(bodyRows(docs)).toHaveLength(1);
    expect(screen.getByRole('link', { name: word('dgv.governance.ret.policies.link') }).getAttribute('href')).toBe('/adm/adm-12');
    expect(screen.getByRole('link', { name: word('dgv.governance.ret.docs.link') }).getAttribute('href')).toBe('/doc/doc-18');
    expect(h.command).not.toHaveBeenCalled();
    expect(new Set(readAllNames(h))).toEqual(new Set(['get_resources_data_retention_policy', 'get_resources_retention_review_item', 'get_resources_legal_hold', 'listDocumentRetentionRules']));
  });

  it('says so when there is no hold, and shows a hold with a scope that names nothing', async () => {
    open(screenOf, 'DGV-11', { ...full(), holds: [] });
    expect((await within(await screen.findByTestId('retention-holds')).findByTestId('holds-summary')).textContent).toBe(word('dgv.governance.ret.holds.summary').replace('{count}', '0'));
    cleanup();
    open(screenOf, 'DGV-11', { ...full(), holds: [hold(1, { resource_scope: { kind: 'TENANT', ids: [] } })] });
    const holdsPart = await screen.findByTestId('retention-holds');
    expect(await within(holdsPart).findByText(word('adm.retention.hold.scope.tenant'))).toBeTruthy();
  });

  it('shows each part on its own: empty, failed with a retry, and refused', async () => {
    const h = open(screenOf, 'DGV-11', { failing: new Set(['get_resources_legal_hold', 'listDocumentRetentionRules']) });
    expect(await within(await screen.findByTestId('retention-policies')).findByText(word('states.empty.title'))).toBeTruthy();
    expect(await within(screen.getByTestId('retention-holds')).findByText(word('states.error.title'))).toBeTruthy();
    expect(await within(screen.getByTestId('retention-doc-rules')).findByText(word('states.error.title'))).toBeTruthy();
    h.world.failing.clear();
    h.world.holds = [hold(1)];
    h.world.rules = [docRule(1)];
    fireEvent.click(within(screen.getByTestId('retention-holds')).getByRole('button', { name: word('states.retry.action') }));
    expect(await within(screen.getByTestId('retention-holds')).findByText('QD-1/2026')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('retention-doc-rules')).getByRole('button', { name: word('states.retry.action') }));
    expect(await within(screen.getByTestId('retention-doc-rules')).findByText('CAT-1')).toBeTruthy();
    cleanup();
    const failed = open(screenOf, 'DGV-11', { failing: new Set(['get_resources_retention_review_item']) });
    expect(await within(await screen.findByTestId('retention-policies')).findByText(word('states.error.title'))).toBeTruthy();
    failed.world.failing.clear();
    failed.world.policies = [policy(1)];
    fireEvent.click(within(screen.getByTestId('retention-policies')).getByRole('button', { name: word('states.retry.action') }));
    expect(await within(screen.getByTestId('retention-policies')).findByText('project_dossier')).toBeTruthy();
  });

  it('is denied part by part without the right to read it, and reads only what it may', async () => {
    const h = open(screenOf, 'DGV-11', full(), ['legal_hold.read']);
    expect(await screen.findByTestId('policies-denied')).toBeTruthy();
    expect(screen.getByTestId('rules-denied')).toBeTruthy();
    await within(screen.getByTestId('retention-holds')).findByTestId('holds-summary');
    expect(readAllNames(h)).toEqual(['get_resources_legal_hold']);
    cleanup();
    const none = open(screenOf, 'DGV-11', full(), ['master.read']);
    expect(await screen.findByTestId('holds-denied')).toBeTruthy();
    expect(readAllNames(none)).toEqual([]);
    expect(screen.getByTestId('readonly-note').textContent).toBe(word('dgv.governance.readonly.note'));
  });
});

describe('DGV-12 approval of changes to critical data', () => {
  const screenOf = (route: ReturnType<typeof routeOf>) => <ChangeApprovalScreen route={route} />;

  it('shows for each change the value before, the value proposed, the ground and the approver, from MDM, and writes nothing', async () => {
    const h = open(screenOf, 'DGV-12', {
      changes: [
        change(1),
        change(2, { master_type: 'CONTRACTOR', business_key: null, before: null, proposed: {}, reason: '', change_kind: 'CREATE' }),
        change(3, { status: 'APPROVED', reviewed_by: uuid(8), decision_document_id: uuid(44), reason: `lien he ${CCCD}` }),
      ],
    });
    expect(await screen.findByRole('heading', { level: 1, name: word('dgv.governance.chg.page.title') })).toBeTruthy();
    const table = await screen.findByTestId('changes-table');
    const rows = bodyRows(table);
    expect(rows.map((row) => row.getAttribute('data-change-id'))).toEqual([uuid(902), uuid(901)]);
    const first = within(rows[1] as HTMLElement);
    expect(first.getByTestId('change-before').textContent).toBe('name: Cong ty A');
    expect(first.getByTestId('change-after').textContent).toBe('name: Cong ty B');
    expect(first.getByText('Đổi tên theo giấy phép mới')).toBeTruthy();
    expect(first.getByText(word('dgv.governance.chg.approver.none'))).toBeTruthy();
    expect(first.getByText(word('dgv.governance.chg.effective.text').replace('{day}', '2026-11-01'), { exact: false })).toBeTruthy();
    const empty = within(rows[0] as HTMLElement);
    expect(empty.getByTestId('change-before').textContent).toBe('—');
    expect(empty.getByTestId('change-after').textContent).toBe('—');
    expect(empty.getAllByText('—').length).toBeGreaterThanOrEqual(4);
    expect(screen.getByRole('link', { name: word('dgv.governance.chg.queue.link') }).getAttribute('href')).toBe('/mdm/mdm-32');
    change_('chg-status', 'APPROVED');
    const decided = await within(await screen.findByTestId('changes-table')).findByText(word('dgv.governance.chg.document.text').replace('{id}', uuid(44).slice(0, 8)), { exact: false });
    expect(decided).toBeTruthy();
    expect(document.body.textContent).not.toContain(CCCD);
    expect(within(screen.getByTestId('changes-table')).getByText(uuid(8).slice(0, 8))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    expect(new Set(readAllNames(h))).toEqual(new Set(['listMasterChangeRequests']));
    const asked = (h.client.readAll as unknown as { mock: { calls: Array<[string, { query: { status: string } }]> } }).mock.calls.map((call) => call[1].query.status);
    expect(asked).toContain('IN_REVIEW');
    expect(asked).toContain('APPROVED');
  });

  it('narrows to a master type and says so when no change is in the state', async () => {
    open(screenOf, 'DGV-12', { changes: [change(1), change(2, { master_type: 'CONTRACTOR' })] });
    const table = await screen.findByTestId('changes-table');
    expect(bodyRows(table)).toHaveLength(2);
    change_('chg-type', 'CONTRACTOR');
    expect(bodyRows(table)).toHaveLength(1);
    change_('chg-status', 'REJECTED');
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
  });

  it('shows the failed state with a retry and is denied without the right to read master data', async () => {
    const h = open(screenOf, 'DGV-12', { failing: new Set(['listMasterChangeRequests']) });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    h.world.failing.clear();
    h.world.changes = [change(1)];
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    expect(await screen.findByTestId('changes-table')).toBeTruthy();
    cleanup();
    const denied = open(screenOf, 'DGV-12', { changes: [change(1)] }, ['adm.retention.read']);
    expect(await screen.findByTestId('changes-denied')).toBeTruthy();
    expect(readAllNames(denied)).toEqual([]);
  });
});

describe('DGV-15 classification and rights over data', () => {
  const screenOf = (route: ReturnType<typeof routeOf>) => <ClassificationScreen route={route} />;
  const catalogue = () => [
    dataset(1, { classification: 'PUBLIC' }),
    dataset(2, { classification: 'PERSONAL', is_critical: true, owner_name: null }),
    dataset(3, { classification: 'IMPORTANT_CORE' }),
    dataset(4, { classification: 'INTERNAL' }),
  ];

  it('counts the five levels and lists each dataset with whether it holds personal data and the routes its level allows', async () => {
    const h = open(screenOf, 'DGV-15', { datasets: catalogue() });
    expect(await screen.findByRole('heading', { level: 1, name: word('dgv.governance.cls.page.title') })).toBeTruthy();
    const table = await screen.findByTestId('classification-table');
    const counts = screen.getByTestId('classification-counts');
    for (const level of ['PUBLIC', 'INTERNAL', 'PERSONAL', 'IMPORTANT_CORE']) expect(within(counts.querySelector(`[data-classification="${level}"]`) as HTMLElement).getByText('1')).toBeTruthy();
    expect(within(counts.querySelector('[data-classification="CONFIDENTIAL"]') as HTMLElement).getByText('0')).toBeTruthy();
    const personal = table.querySelector('[data-classification="PERSONAL"]') as HTMLElement;
    expect(within(personal).getByText(word('dgv.governance.cls.pii.yes'))).toBeTruthy();
    expect(within(personal).getByText(word('dgv.governance.cls.critical'))).toBeTruthy();
    expect(within(personal).getByText(`${word('llm.route.domestic')}, ${word('llm.route.selfHosted')}`)).toBeTruthy();
    expect(within(personal).getByText('—')).toBeTruthy();
    const core = table.querySelector('[data-classification="IMPORTANT_CORE"]') as HTMLElement;
    expect(within(core).getByText(word('llm.route.selfHosted'))).toBeTruthy();
    expect(within(core).getByText(word('dgv.governance.cls.pii.no'))).toBeTruthy();
    expect(screen.getByTestId('classification-policy').textContent).toBe(word('dgv.governance.cls.policy.note'));
    expect(h.command).not.toHaveBeenCalled();
    expect(new Set(readAllNames(h))).toEqual(new Set(['searchCatalog']));
  });

  it('does not list a dataset the server did not give, and does not count it', async () => {
    // The server leaves a PERSONAL dataset out for who has no right to it: the screen shows and counts what it was given.
    open(screenOf, 'DGV-15', { datasets: catalogue().filter((row) => row.classification !== 'PERSONAL') });
    const table = await screen.findByTestId('classification-table');
    expect(table.querySelector('[data-classification="PERSONAL"]')).toBeNull();
    expect(within(screen.getByTestId('classification-counts').querySelector('[data-classification="PERSONAL"]') as HTMLElement).getByText('0')).toBeTruthy();
    expect(bodyRows(table)).toHaveLength(3);
  });

  it('narrows to one level and says so when the level has none', async () => {
    open(screenOf, 'DGV-15', { datasets: catalogue().filter((row) => row.classification !== 'PERSONAL') });
    const table = await screen.findByTestId('classification-table');
    change_('cls-level', 'IMPORTANT_CORE');
    expect(bodyRows(table)).toHaveLength(1);
    change_('cls-level', 'PERSONAL');
    expect(screen.getByTestId('classification-none')).toBeTruthy();
    change_('cls-level', '');
    expect(bodyRows(table)).toHaveLength(3);
  });

  it('shows the empty and failed states, and is denied without the right to read the catalogue', async () => {
    open(screenOf, 'DGV-15');
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    const h = open(screenOf, 'DGV-15', { failing: new Set(['searchCatalog']) });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    h.world.failing.clear();
    h.world.datasets = catalogue();
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await waitFor(() => expect(screen.getByTestId('classification-table')).toBeTruthy());
    cleanup();
    const denied = open(screenOf, 'DGV-15', { datasets: catalogue() }, ['master.read']);
    expect(await screen.findByTestId('classification-denied')).toBeTruthy();
    expect(readAllNames(denied)).toEqual([]);
  });
});

describe('the frame of the governance views', () => {
  it('names the screen in its footer, with the requirement when the route has one and without it when it has none', async () => {
    const bare = Object.fromEntries(Object.entries(routeOf('DGV-10', 'FR-DGV-10')).filter(([key]) => key !== 'req')) as unknown as ReturnType<typeof routeOf>;
    open((route) => <DuplicatesScreen route={route} />, 'DGV-10');
    expect(
      (await screen.findByText(word('dgv.governance.footer.reference').replace('{id}', 'DGV-10').replace('{req}', 'FR-DGV-10').replace('{title}', word('dgv.governance.dup.page.title')))).textContent,
    ).toContain('FR-DGV-10');
    cleanup();
    open(() => <DuplicatesScreen route={bare} />, 'DGV-10');
    await screen.findByTestId('readonly-note');
    expect(document.querySelector('.prototype-note')?.textContent).toBe(
      word('dgv.governance.footer.reference').replace('{id}', 'DGV-10').replace('{req}', '').replace('{title}', word('dgv.governance.dup.page.title')),
    );
  });
});
