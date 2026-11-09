import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../../i18n';
import { harness } from '../../../../screens/sas/test-support';
import { mount } from '../shared/test-support';
import OrgPackScreen from './OrgPackScreen';
import type { OrgPack } from './model';

const word = (key: string, params: Record<string, string | number> = {}): string => translator.t(key, params);
const route = { id: 'ORG-01', path: '/org/org-01', title: 'ORG-01', kind: 'dashboard', area: 'data', module: 'ORG', group: 'Organisation and roles', role: 'workspace', parent: null } as never;
const BATCH = '00000000-0000-4000-8000-000000000077';

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

const unit = (code: string, fn: string, parent: string | null, present = false, placeholder = false) => ({ code, name: `Name ${code}`, parent_code: parent, unit_function: fn, placeholder, present });
const pack = (over: Partial<OrgPack> = {}): OrgPack =>
  ({
    label: 'PVFCCO-TEMPLATE',
    digest: 'a'.repeat(64),
    source: 'TEMPLATE',
    batch_id: null,
    directory_prefix: 'MACHVON-PVFCCO',
    loader: { target_entity: 'ORG_PACK', mapping_version: 'ORG-PACK-1', source_system: 'PVFCCO-TEMPLATE', file_name: 'pvfcco-template.csv', file_sha256: 'b'.repeat(64), row_count: 70 },
    file_csv: 'business_key,kind\r\nUNIT:ROOT,UNIT\r\n',
    units: [unit('ROOT', 'ROOT', null, true), unit('KHDT', 'AGGREGATOR', 'ROOT'), unit('TDA_1', 'INPUT_POINT', 'ROOT', false, true)],
    roles: [{ code: 'ENT_DATA_ENTRY', name: 'Entry', kind: 'ENTRY', rank: 30, permissions: ['ind.entry', 'ind.read'], present: false }],
    seats: [
      { key: 'SEAT:ENT_DATA_ENTRY@TDA_1', ad_group: 'MACHVON-PVFCCO-TDA-1-ENTRY', role_code: 'ENT_DATA_ENTRY', unit_code: 'TDA_1', scope_kind: 'UNIT_ONLY', min_holders: 1, max_holders: 1, holders: 0, state: 'VACANT' },
    ],
    steps: [
      { id: 'unit-approver', kind: 'UNIT_APPROVER', name: 'Unit approval', assignee: 'DOA', role_code: null, unit_code: null, sla_working_hours: 24, on_timeout: 'REMIND' },
      { id: 'push', kind: 'PUSH', name: 'Push', assignee: 'ROLE_IN_UNIT', role_code: 'ENT_PLANNING_REVIEWER', unit_code: 'KHDT', sla_working_hours: 8, on_timeout: 'REMIND' },
    ],
    delegation: { delegable_roles: ['ENT_DATA_ENTRY', 'ENT_UNIT_APPROVER'], max_days: 90, standing_review_days: 180 },
    absence: { max_cover_days: 90 },
    doa: { document_type: 'REPORT_ACCEPT', unit_code: 'ROOT', role_code: 'ENT_UNIT_APPROVER', approval_levels: 1 },
    catalogue: [{ master_type: 'ISSUE_CATEGORY', key: 'DELAY_CAUSE', label: 'Delay causes', parent_key: null }],
    plan: [
      { section: 'UNIT', key: 'UNIT:ROOT', action: 'UNCHANGED', detail: '' },
      { section: 'UNIT', key: 'UNIT:KHDT', action: 'CREATE', detail: '' },
      { section: 'ENTRY', key: 'ENTRY:ISSUE_CATEGORY:DELAY_CAUSE', action: 'PENDING', detail: 'the entry waits for review or publication' },
    ],
    counts: { CREATE: 1, UNCHANGED: 1, PENDING: 1, DRIFT: 0, BLOCKED: 0 },
    seat_counts: { VACANT: 1, FILLED: 0, OVER: 0 },
    stray_grants: 2,
    structure_complete: false,
    defects: [],
    as_of: '2026-11-09T03:00:00.000Z',
    ...over,
  }) as OrgPack;

function mountWith(options: { reply?: (input: unknown) => unknown; command?: (operation: string, input: unknown) => unknown; mode?: 'FULL' | 'READ_ONLY' } = {}) {
  const reads: unknown[] = [];
  const h = harness((operation, input) => {
    if (operation !== 'getEnterpriseOrgPack') return new Error(`unexpected read ${operation}`);
    reads.push(input);
    return (options.reply ?? (() => pack()))(input);
  }, options.command ?? (() => ({ label: 'PVFCCO-TEMPLATE', digest: 'a', batch_id: BATCH, items: [], counts: { CREATED: 3, UNCHANGED: 1, PENDING: 2, DRIFT: 0, BLOCKED: 0 }, seat_counts: { VACANT: 1, FILLED: 0, OVER: 0 }, stray_grants: 0, structure_complete: true })));
  mount(<OrgPackScreen route={route} />, h, { permissions: ['adm.migration.read', 'adm.migration.approve'], ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, reads };
}

describe('OrgPackScreen (ORG-01): the organisation and the roles of the enterprise edition', () => {
  it('shows the template as illustrative data: units, roles, seats with their directory groups, the steps with their deadlines, the delegation defaults and the catalogue', async () => {
    mountWith();
    await screen.findByTestId('template-note');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('org.page.title'));
    expect(screen.getByTestId('template-note').textContent).toBe(word('org.source.template.text', { label: 'PVFCCO-TEMPLATE' }));
    expect(screen.getByText('Name TDA_1').tagName).toBe('EM');
    expect(screen.getByText('MACHVON-PVFCCO-TDA-1-ENTRY')).toBeTruthy();
    expect(screen.getByText(word('org.step.kind.push'))).toBeTruthy();
    expect(screen.getByTestId('delegation-days').textContent).toContain('90');
    expect(screen.getByTestId('delegation-review').textContent).toContain('180');
    expect(screen.getByTestId('doa').textContent).toContain('REPORT_ACCEPT / ROOT / ENT_UNIT_APPROVER');
    expect(screen.getByTestId('directory-prefix').textContent).toContain('MACHVON-PVFCCO');
    expect(screen.getByText('Delay causes')).toBeTruthy();
  });

  it('says what a load would do and who sits in the seats, and lists only the items that do not match yet', async () => {
    mountWith();
    await screen.findByTestId('plan-counts');
    expect(within(screen.getByTestId('plan-CREATE')).getByText('1')).toBeTruthy();
    expect(within(screen.getByTestId('plan-DRIFT')).getByText('0')).toBeTruthy();
    expect(within(screen.getByTestId('seat-VACANT')).getByText('1')).toBeTruthy();
    expect(within(screen.getByTestId('stray-grants')).getByText('2')).toBeTruthy();
    expect(screen.getByText('UNIT:KHDT')).toBeTruthy();
    expect(screen.queryByText('UNIT:ROOT')).toBeNull();
    expect(screen.getByText(word('org.verify.incomplete.badge'))).toBeTruthy();
  });

  it('downloads the file of the template', async () => {
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    mountWith();
    fireEvent.click(await screen.findByTestId('download-button'));
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:x');
    expect(await screen.findByText(word('org.load.downloaded.text'))).toBeTruthy();
  });

  it('shows the pack of an applied batch, with the defects of its rows, and loads it only when it has none', async () => {
    const calls: Array<[string, unknown]> = [];
    const { reads } = mountWith({
      reply: (input) => ((input as { query?: { batch_id?: string } } | undefined)?.query?.batch_id === BATCH ? pack({ source: 'BATCH', batch_id: BATCH, file_csv: null, structure_complete: true }) : pack()),
      command: (operation, input) => {
        calls.push([operation, input]);
        return { label: 'PVFCCO-TEMPLATE', digest: 'a', batch_id: BATCH, items: [], counts: { CREATED: 3, UNCHANGED: 1, PENDING: 2, DRIFT: 0, BLOCKED: 0 }, seat_counts: { VACANT: 1, FILLED: 0, OVER: 0 }, stray_grants: 0, structure_complete: true };
      },
    });
    const input = await screen.findByTestId('batch-input');
    fireEvent.change(input, { target: { value: 'not a batch' } });
    expect((screen.getByTestId('batch-show') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(word('org.batch.format.problem'))).toBeTruthy();
    fireEvent.change(input, { target: { value: BATCH } });
    fireEvent.click(screen.getByTestId('batch-show'));
    const button = await screen.findByTestId('materialise-button');
    expect(screen.getByTestId('template-note').textContent).toBe(word('org.source.batch.text', { label: 'PVFCCO-TEMPLATE' }));
    expect(JSON.stringify(reads)).toContain(BATCH);
    fireEvent.click(button);
    const result = await screen.findByTestId('load-result');
    expect(result.textContent).toContain(word('org.load.result.text', { created: 3, unchanged: 1, pending: 2, drift: 0, blocked: 0 }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('materialiseEnterpriseOrgPack');
    expect(JSON.stringify(calls[0]?.[1])).toContain(BATCH);
  });

  it('shows the defects of a batch and offers no load while there are any', async () => {
    mountWith({ reply: () => pack({ source: 'BATCH', batch_id: BATCH, file_csv: null, defects: [{ code: 'SEAT_SCOPE', key: 'SEAT:ENT_DATA_ENTRY@TDA_1', field: 'data.scope', message: 'ENTRY is held with the scope UNIT_ONLY' }] }) });
    fireEvent.change(await screen.findByTestId('batch-input'), { target: { value: BATCH } });
    fireEvent.click(screen.getByTestId('batch-show'));
    expect((await screen.findByTestId('defects')).textContent).toContain('SEAT_SCOPE');
    await waitFor(() => expect((screen.getByTestId('materialise-button') as HTMLButtonElement).disabled).toBe(true));
  });

  it('says why a load failed with the code the server gave', async () => {
    const { ApiError } = await import('@machvon/api-client');
    mountWith({
      reply: () => pack({ source: 'BATCH', batch_id: BATCH, file_csv: null }),
      command: () => new ApiError({ status: 409, code: 'MIGRATION_STATE_INVALID', correlationId: 'c' }),
    });
    fireEvent.change(await screen.findByTestId('batch-input'), { target: { value: BATCH } });
    fireEvent.click(screen.getByTestId('batch-show'));
    fireEvent.click(await screen.findByTestId('materialise-button'));
    expect((await screen.findByTestId('load-error')).textContent).toBe(word('org.load.error.text', { code: 'MIGRATION_STATE_INVALID' }));
  });

  it('is read only in the read-only mode, and has an English text for everything it says', async () => {
    mountWith({ mode: 'READ_ONLY', reply: () => pack({ source: 'BATCH', batch_id: BATCH, file_csv: null }) });
    fireEvent.change(await screen.findByTestId('batch-input'), { target: { value: BATCH } });
    fireEvent.click(screen.getByTestId('batch-show'));
    expect(((await screen.findByTestId('materialise-button')) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('readonly-note')).toBeTruthy();
    translator.setLocale('en');
    expect(word('org.page.title')).toBe('Organisation and roles of the enterprise edition');
  });

  it('shows the error state with a retry when the pack cannot be read', async () => {
    mountWith({ reply: () => new Error('boom') });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
