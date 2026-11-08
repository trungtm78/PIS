import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../../i18n';
import MappingScreen from './MappingScreen';
import { ME, MAPPER, READER, client, mapping, mappingId, mount, packageId, problem, proposed, route, suggestions, world } from './mapping-test-support';
import type { World } from './mapping-test-support';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Options {
  world?: Partial<World>;
  command?: (operation: string, input: unknown) => unknown;
  permissions?: string[] | undefined;
  mode?: 'FULL' | 'READ_ONLY';
  path?: string;
}

function mountWith(options: Options = {}) {
  const h = client(world(options.world), options.command);
  mount(<MappingScreen route={route} />, h, { permissions: options.permissions === undefined && 'permissions' in options ? undefined : (options.permissions ?? MAPPER), ...(options.mode === undefined ? {} : { mode: options.mode }), ...(options.path === undefined ? {} : { path: options.path }) });
  return h;
}

const rowOf = (n: number): HTMLElement => document.querySelector(`[data-mapping-id="${mappingId(n)}"]`) as HTMLElement;
const listReads = (h: ReturnType<typeof client>): Array<Record<string, unknown>> => h.read.mock.calls.filter(([operation]) => operation === 'listEgpMappings').map(([, input]) => (input as { query: Record<string, unknown> }).query);
const proposeButton = (): HTMLElement => screen.getByRole('button', { name: t('egp.mapping.action.propose') });
const reasonOf = (dialog: HTMLElement, label: string): HTMLElement => within(dialog).getByLabelText(new RegExp(label));
/** The table is there while it loads (a skeleton): the rows are what tells the list has come. */
const rowsShown = async (): Promise<void> => {
  await waitFor(() => expect(document.querySelector('[data-mapping-id]')).not.toBeNull());
};
const LONG = 'Khớp theo hồ sơ mời thầu';

async function openPropose(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: t('egp.mapping.action.propose') }));
  return screen.findByRole('dialog', { name: t('egp.mapping.propose.title') });
}

function fill(dialog: HTMLElement, values: { ours?: string; external?: string; from?: string; until?: string; project?: string; reason?: string }): void {
  const set = (label: string, value: string | undefined): void => {
    if (value !== undefined) fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
  };
  set(t('egp.mapping.field.ourCode.label'), values.ours);
  set(t('egp.mapping.field.externalCode.label'), values.external);
  set(t('egp.mapping.field.validFrom.label'), values.from);
  set(t('egp.mapping.field.validUntil.label'), values.until);
  set(t('egp.mapping.field.projectCode.label'), values.project);
  if (values.reason !== undefined) fireEvent.change(reasonOf(dialog, t('egp.mapping.propose.reason.label')), { target: { value: values.reason } });
}

const send = (dialog: HTMLElement, label = t('egp.mapping.propose.confirm.action')): void => {
  fireEvent.click(within(dialog).getByRole('button', { name: label }));
};

describe('MappingScreen (BID-23): the codes of the national bidding network and our records', () => {
  it('UI-BID-23: shows the badge of the assumed layout, the note on relinking, the caption and the columns of the catalogue', async () => {
    mountWith();
    await screen.findByTestId('suggestions');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t('egp.mapping.page.title'));
    expect(screen.getByTestId('assumption-badge').textContent).toBe('Mẫu tệp là giả định (PENDING-EXTERNAL)');
    expect(screen.getByTestId('assumption-badge').textContent).toBe(t('egp.mapping.badge.assumption'));
    expect(screen.getByTestId('relink-note').textContent).toBe(t('egp.mapping.note.relink'));
    await rowsShown();
    const table = screen.getByRole('table', { name: t('egp.mapping.table.caption') });
    const headers = Array.from(table.querySelectorAll('thead th')).map((cell) => cell.textContent);
    expect(headers).toEqual(['subject', 'ours', 'external', 'method', 'confidence', 'validity', 'status', 'people', 'actions'].map((column) => t(`egp.mapping.column.${column}` as never)));
    expect(screen.getByRole('region', { name: t('egp.mapping.table.caption') })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: t('egp.mapping.suggest.title') })).toBeTruthy();
  });

  it('shows a row in words: our code and project, the code on the network, the method, the validity (empty end: no limit), the status as text, who proposed and who decided', async () => {
    mountWith({
      world: {
        mappings: [
          mapping(1, { project_code: 'PRJ-1', valid_until: '2027-01-01' }),
          mapping(2, { match_method: 'IMPORT', import_id: 'i', status: 'REJECTED', approved_by_name: 'Lê Văn Cường', decision_reason: 'Sai mã thông báo', can_retire: false }),
          mapping(3, { match_method: 'MANUAL', confidence: 0.9 }),
          mapping(4, { subject_type: 'CONTRACTOR', external_type: 'EGP_CONTRACTOR', our_code: '0101234567', match_method: 'RULE', status: 'RETIRED', retired_by_name: 'Phạm Thị Dung', retired_at: '2026-11-05T02:00:00.000Z', retire_reason: 'Nhà thầu đổi mã', can_retire: false }),
          proposed(5, { our_code: null }),
        ],
      },
    });
    await rowsShown();
    const one = rowOf(1);
    expect(one.textContent).toContain(t('egp.mapping.subject.package'));
    expect(one.textContent).toContain('GT-1');
    expect(one.textContent).toContain(t('egp.mapping.cell.project', { code: 'PRJ-1' }));
    expect(one.textContent).toContain('IB26001');
    expect(one.textContent).toContain('EGP_PACKAGE');
    expect(one.textContent).toContain(t('egp.mapping.method.manual'));
    expect(one.textContent).toContain(t('egp.mapping.cell.validity', { from: '01/10/2026', until: '01/01/2027' }));
    expect(one.textContent).toContain(t('egp.mapping.status.active'));
    expect(within(one).getByTestId('proposed-by').textContent).toBe(t('egp.mapping.cell.proposed', { name: 'Nguyễn Văn An', day: '01/10/2026' }));
    expect(within(one).getByTestId('decided-by').textContent).toBe(t('egp.mapping.cell.approved', { name: 'Trần Thị Bình', day: '02/10/2026' }));
    expect(rowOf(1).textContent).not.toContain(t('egp.mapping.cell.unlimited'));
    // The same table, other rows: unlimited end, the file, a confirmed suggestion with its likeness, the tax code, the history of a retired row.
    expect(rowOf(2).textContent).toContain(t('egp.mapping.cell.validity', { from: '01/10/2026', until: t('egp.mapping.cell.unlimited') }));
    expect(rowOf(2).textContent).toContain(t('egp.mapping.method.import'));
    expect(rowOf(2).textContent).toContain(t('egp.mapping.status.rejected'));
    expect(within(rowOf(2)).getByTestId('decided-by').textContent).toBe(t('egp.mapping.cell.rejected', { name: 'Lê Văn Cường', day: '02/10/2026' }));
    expect(rowOf(2).textContent).toContain(t('egp.mapping.cell.reason', { reason: 'Sai mã thông báo' }));
    expect(rowOf(3).textContent).toContain(t('egp.mapping.method.suggestion'));
    expect(rowOf(3).textContent).toContain('0,9');
    expect(within(rowOf(3)).getByRole('button', { name: t('egp.mapping.info.open.label', { name: t('egp.mapping.info.name.text') }) })).toBeTruthy();
    expect(rowOf(1).textContent).toContain(t('egp.mapping.cell.none'));
    expect(rowOf(4).textContent).toContain(t('egp.mapping.subject.contractor'));
    expect(rowOf(4).textContent).toContain(t('egp.mapping.method.rule'));
    expect(within(rowOf(4)).getByTestId('retired-by').textContent).toBe(t('egp.mapping.cell.retired', { name: 'Phạm Thị Dung', day: '05/11/2026' }));
    expect(rowOf(4).textContent).toContain(t('egp.mapping.cell.reason', { reason: 'Nhà thầu đổi mã' }));
    expect(rowOf(5).textContent).toContain(t('egp.mapping.cell.noOurCode'));
    expect(rowOf(5).textContent).toContain(t('egp.mapping.status.proposed'));
  });

  it('counts the mappings by status as chips, and a chip sets the status in the address', async () => {
    const h = mountWith();
    const all = await screen.findByRole('button', { name: t('egp.mapping.chip.all', { count: 2 }) });
    expect(all.getAttribute('aria-pressed')).toBe('true');
    const waiting = screen.getByRole('button', { name: t('egp.mapping.chip.label', { label: t('egp.mapping.status.proposed'), count: 1 }) });
    expect(screen.getByRole('button', { name: t('egp.mapping.chip.label', { label: t('egp.mapping.status.rejected'), count: 0 }) })).toBeTruthy();
    fireEvent.click(waiting);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?status=PROPOSED'));
    await waitFor(() => expect(document.querySelectorAll('[data-mapping-id]')).toHaveLength(1));
    expect(listReads(h).at(-1)).toEqual({ status: 'PROPOSED', limit: 50 });
    expect(screen.getByRole('button', { name: t('egp.mapping.chip.label', { label: t('egp.mapping.status.proposed'), count: 1 }) }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: t('egp.mapping.chip.all', { count: 2 }) }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(''));
  });

  it('keeps the subject, the status and the free text in the address and sends them to the list', async () => {
    const h = mountWith({ path: '/?subject_type=PACKAGE&status=ACTIVE&q=GT-1' });
    await rowsShown();
    expect(listReads(h)[0]).toEqual({ subject_type: 'PACKAGE', status: 'ACTIVE', q: 'GT-1', limit: 50 });
    expect((screen.getByLabelText(t('egp.mapping.filter.subject.label')) as HTMLSelectElement).value).toBe('PACKAGE');
    expect((screen.getByLabelText(t('egp.mapping.filter.q.label')) as HTMLInputElement).value).toBe('GT-1');
    expect(document.querySelectorAll('[data-mapping-id]')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(t('egp.mapping.filter.subject.label')), { target: { value: '' } });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?status=ACTIVE&q=GT-1'));
    fireEvent.change(screen.getByLabelText(t('egp.mapping.filter.subject.label')), { target: { value: 'CONTRACTOR' } });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?subject_type=CONTRACTOR&status=ACTIVE&q=GT-1'));
    fireEvent.change(screen.getByLabelText(t('egp.mapping.filter.q.label')), { target: { value: 'IB2' } });
    fireEvent.click(screen.getByRole('button', { name: t('egp.mapping.filter.apply.action') }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('?subject_type=CONTRACTOR&status=ACTIVE&q=IB2'));
  });

  it('says that no row matches the filters and clears them from the same place', async () => {
    mountWith({ path: '/?q=khong-co-ma-nay' });
    expect(await screen.findByText(t('ui.dataTable.emptyFiltered'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('ui.dataTable.clearFilters') }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(''));
    await waitFor(() => expect(document.querySelectorAll('[data-mapping-id]')).toHaveLength(2));
  });

  it('pages by cursor: "load more" asks for the next page, keeps the rows and goes away at the end', async () => {
    const h = mountWith({ world: { mappings: [mapping(1), mapping(2), mapping(3)], pageSize: 2 } });
    await rowsShown();
    expect(document.querySelectorAll('[data-mapping-id]')).toHaveLength(2);
    expect(screen.getByTestId('shown').textContent).toBe(t('egp.mapping.paging.summary', { shown: 2 }));
    fireEvent.click(screen.getByRole('button', { name: t('egp.mapping.paging.more') }));
    await waitFor(() => expect(document.querySelectorAll('[data-mapping-id]')).toHaveLength(3));
    expect(listReads(h).at(-1)).toEqual({ limit: 50, cursor: '2' });
    expect(screen.getByTestId('shown').textContent).toBe(t('egp.mapping.paging.summary', { shown: 3 }));
    expect(screen.queryByRole('button', { name: t('egp.mapping.paging.more') })).toBeNull();
  });

  // ---- the states matrix ---------------------------------------------------------------------------------------------------------------------------------------------------

  it('loading: a skeleton in the table, no counts and no zero', async () => {
    mountWith({ world: { hold: true } });
    await waitFor(() => expect(document.querySelector('table[aria-busy="true"]')).not.toBeNull());
    expect(screen.queryByRole('button', { name: t('egp.mapping.chip.all', { count: 0 }) })).toBeNull();
    expect(screen.queryByTestId('empty')).toBeNull();
    expect(screen.queryByTestId('error')).toBeNull();
    expect(document.querySelectorAll('[data-mapping-id]')).toHaveLength(0);
  });

  it('empty: no mapping yet explains how they arise and still offers the proposal and the suggestions', async () => {
    mountWith({ world: { mappings: [] } });
    const empty = await screen.findByTestId('empty');
    expect(empty.textContent).toContain(t('egp.mapping.empty.title'));
    expect(empty.textContent).toContain(t('egp.mapping.empty.body'));
    expect(t('egp.mapping.empty.body')).toContain('BID-24');
    expect(within(empty).getByRole('link', { name: t('egp.mapping.empty.import.link') }).getAttribute('href')).toBe('/bid/bid-24');
    expect(screen.queryByRole('table')).toBeNull();
    expect(proposeButton()).toBeTruthy();
    expect(await screen.findByTestId('suggestions')).toBeTruthy();
  });

  it('error: names the failure, does not say "no mappings", and retries in place', async () => {
    const state = world({ failing: new Map([['listEgpMappings', new Error('boom')]]) });
    const h = client(state);
    mount(<MappingScreen route={route} />, h, { permissions: MAPPER });
    const error = await screen.findByTestId('error');
    expect(error.textContent).toContain(t('egp.mapping.error.title'));
    expect(screen.queryByTestId('empty')).toBeNull();
    state.failing.clear();
    fireEvent.click(within(error).getByRole('button', { name: t('states.retry.action') }));
    await rowsShown();
    expect(document.querySelectorAll('[data-mapping-id]')).toHaveLength(2);
    expect(screen.queryByTestId('error')).toBeNull();
  });

  it('forbidden: a 403 on the list says the scope is hidden, leaks nothing and offers no action', async () => {
    mountWith({ world: { failing: new Map([['listEgpMappings', problem('SCOPE_DENIED', 403)]]) } });
    const denied = await screen.findByTestId('denied');
    expect(denied.textContent).toContain(t('egp.mapping.denied.title'));
    expect(denied.textContent).toContain(t('egp.mapping.denied.body'));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByTestId('suggestions')).toBeNull();
    expect(screen.queryByRole('button', { name: t('egp.mapping.action.propose') })).toBeNull();
    expect(screen.queryByTestId('readonly-note')).toBeNull();
  });

  it('read-only: without the right to map there is no proposal, no retire and no approve, and the screen says why', async () => {
    mountWith({ permissions: READER, world: { mappings: [mapping(1, { can_retire: false }), proposed(2, { can_decide: false })] } });
    await rowsShown();
    expect(screen.getByTestId('readonly-note').textContent).toBe(t('egp.mapping.readonly.notice'));
    expect(screen.queryByRole('button', { name: t('egp.mapping.action.propose') })).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(`^${t('egp.mapping.action.approve')}`) })).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(`^${t('egp.mapping.action.retire')}`) })).toBeNull();
    expect(within(rowOf(2)).getByTestId('waiting-words').textContent).toBe(t('egp.mapping.row.waiting'));
    await screen.findByTestId('suggestions');
    expect(screen.queryByRole('button', { name: t('egp.mapping.suggest.propose.label', { ours: 'GT-9', external: 'IB2600900' }) })).toBeNull();
  });

  it('read-only: a frozen session (suspended tenant) shows no control that changes data, even when the server would allow it', async () => {
    mountWith({ mode: 'READ_ONLY', world: { mappings: [mapping(1), proposed(2)] } });
    await rowsShown();
    expect(screen.queryByRole('button', { name: t('egp.mapping.action.propose') })).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(`^${t('egp.mapping.action.approve')}`) })).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(`^${t('egp.mapping.action.retire')}`) })).toBeNull();
    expect(screen.getByTestId('readonly-note')).toBeTruthy();
  });

  it('a session whose permissions are not known keeps the buttons (the server decides)', async () => {
    mountWith({ permissions: undefined });
    expect(await screen.findByRole('button', { name: t('egp.mapping.action.propose') })).toBeTruthy();
  });

  // ---- propose -----------------------------------------------------------------------------------------------------------------------------------------------------------

  it('propose: the dialog opens on its first field, the button waits for a reason of 10 characters, a contractor is mapped by tax code, a package asks for its project', async () => {
    mountWith();
    const dialog = await openPropose();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText(t('egp.mapping.field.subject.label'))));
    const confirm = within(dialog).getByRole('button', { name: t('egp.mapping.propose.confirm.action') });
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.change(reasonOf(dialog, t('egp.mapping.propose.reason.label')), { target: { value: 'quá ngắn' } });
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.change(reasonOf(dialog, t('egp.mapping.propose.reason.label')), { target: { value: LONG } });
    expect(confirm).toHaveProperty('disabled', false);
    expect(within(dialog).getByText(t('egp.mapping.propose.maker.note'))).toBeTruthy();
    expect(within(dialog).getByLabelText(t('egp.mapping.field.projectCode.label'))).toBeTruthy();
    expect(within(dialog).queryByTestId('contractor-note')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(t('egp.mapping.field.subject.label')), { target: { value: 'CONTRACTOR' } });
    expect(within(dialog).getByTestId('contractor-note').textContent).toBe(t('egp.mapping.propose.contractor.note'));
    expect(within(dialog).getByLabelText(t('egp.mapping.field.ourCode.contractor'))).toBeTruthy();
    expect(within(dialog).queryByLabelText(t('egp.mapping.field.ourCode.label'))).toBeNull();
    expect(within(dialog).queryByLabelText(t('egp.mapping.field.projectCode.label'))).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(t('egp.mapping.field.subject.label')), { target: { value: 'PROJECT' } });
    expect(within(dialog).queryByLabelText(t('egp.mapping.field.projectCode.label'))).toBeNull();
    expect(within(dialog).getByLabelText(t('egp.mapping.field.ourCode.label'))).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('propose: checks the fields before it sends anything (codes, the end after the start) and sends nothing while they are wrong', async () => {
    const h = mountWith();
    const dialog = await openPropose();
    fill(dialog, { reason: LONG, ours: ' ', external: '' });
    send(dialog);
    expect(within(dialog).getByRole('alert').textContent).toBe(t('egp.mapping.invalid.summary'));
    expect(within(dialog).getAllByText(t('egp.mapping.invalid.required'))).toHaveLength(2);
    expect(within(dialog).getByLabelText(t('egp.mapping.field.ourCode.label')).getAttribute('aria-invalid')).toBe('true');
    expect(within(dialog).getByLabelText(t('egp.mapping.field.ourCode.label')).getAttribute('aria-describedby')).toBe('mapping-our-code-error');
    fill(dialog, { ours: 'GT-1', external: 'x'.repeat(101), from: '2026-11-10', until: '2026-11-10' });
    send(dialog);
    expect(within(dialog).getByText(t('egp.mapping.invalid.tooLong'))).toBeTruthy();
    expect(within(dialog).getByText(t('egp.mapping.invalid.range'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('propose: sends the body the server expects, closes, says what happened and refreshes the list', async () => {
    const h = mountWith({ world: { mappings: [] } });
    await screen.findByTestId('empty');
    const before = listReads(h).length;
    const dialog = await openPropose();
    fill(dialog, { ours: ' GT-7 ', project: 'PRJ-1', external: 'IB26007', from: '2026-11-01', until: '2027-11-01', reason: LONG });
    send(dialog);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledTimes(1);
    expect(h.command).toHaveBeenCalledWith('proposeEgpMapping', expect.objectContaining({ body: { subject_type: 'PACKAGE', our_code: 'GT-7', our_project_code: 'PRJ-1', external_code: 'IB26007', match_method: 'MANUAL', valid_from: '2026-11-01', valid_until: '2027-11-01', reason: LONG } }));
    expect((await screen.findByTestId('receipt')).textContent).toBe(t('egp.mapping.success.proposed', { code: 'GT-7', external: 'IB26007' }));
    await waitFor(() => expect(listReads(h).length).toBeGreaterThan(before));
  });

  it('propose: a contractor goes by tax code and carries no project, no method of suggestion', async () => {
    const h = mountWith();
    const dialog = await openPropose();
    fireEvent.change(within(dialog).getByLabelText(t('egp.mapping.field.subject.label')), { target: { value: 'CONTRACTOR' } });
    fireEvent.change(within(dialog).getByLabelText(t('egp.mapping.field.ourCode.contractor')), { target: { value: '0101234567' } });
    fireEvent.change(within(dialog).getByLabelText(t('egp.mapping.field.externalCode.label')), { target: { value: '0101234567' } });
    fireEvent.change(reasonOf(dialog, t('egp.mapping.propose.reason.label')), { target: { value: 'Khớp theo mã số thuế' } });
    send(dialog);
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command).toHaveBeenCalledWith('proposeEgpMapping', expect.objectContaining({ body: { subject_type: 'CONTRACTOR', our_code: '0101234567', external_code: '0101234567', match_method: 'MANUAL', reason: 'Khớp theo mã số thuế' } }));
  });

  it('propose: each named reason of CROSSWALK_DUPLICATE is said in words, in the dialog', async () => {
    const reasons: Array<[string, string]> = [
      ['EXTERNAL_CODE_TAKEN', 'egp.mapping.problem.taken'],
      ['SUBJECT_HAS_OTHER_CODE', 'egp.mapping.problem.otherCode'],
      ['UNCHANGED', 'egp.mapping.problem.unchanged'],
      ['ALREADY_PROPOSED', 'egp.mapping.problem.waiting'],
      ['NEW_REASON', 'egp.mapping.problem.duplicate'],
    ];
    let next = 0;
    const h = mountWith({ command: () => problem('CROSSWALK_DUPLICATE', 409, { reason: reasons[next++]?.[0] }) });
    const dialog = await openPropose();
    fill(dialog, { ours: 'GT-1', external: 'IB1', reason: LONG });
    for (const [, key] of reasons) {
      send(dialog);
      await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe(t(key as never)));
      await waitFor(() => expect(within(dialog).getByRole('button', { name: t('egp.mapping.propose.confirm.action') })).toHaveProperty('disabled', false));
    }
    expect(h.command).toHaveBeenCalledTimes(reasons.length);
    // The dialog stays: nothing was lost, the person corrects and sends again.
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('propose: a VALIDATION_FAILED names the field: no row of ours with that code, two rows of one code, the end of validity', async () => {
    const cases: Array<[string, string, string]> = [
      ['our_code', 'egp.mapping.problem.field.ourCode', 'mapping-our-code'],
      ['our_project_code', 'egp.mapping.problem.field.projectCode', 'mapping-project-code'],
      ['valid_until', 'egp.mapping.problem.field.validUntil', 'mapping-valid-until'],
    ];
    let next = 0;
    mountWith({ command: () => problem('VALIDATION_FAILED', 422, {}, cases[next++]?.[0]) });
    const dialog = await openPropose();
    fill(dialog, { ours: 'GT-1', external: 'IB1', reason: LONG });
    for (const [, key, id] of cases) {
      send(dialog);
      await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe(t(key as never)));
      const field = dialog.querySelector(`#${id}`) as HTMLElement;
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(dialog.querySelector(`#${id}-error`)?.textContent).toBe(t(key as never));
      await waitFor(() => expect(within(dialog).getByRole('button', { name: t('egp.mapping.propose.confirm.action') })).toHaveProperty('disabled', false));
    }
  });

  it('propose: lists the findings of the server (external type, contractor by tax code) in words', async () => {
    mountWith({
      command: () =>
        problem('VALIDATION_FAILED', 422, {
          findings: [
            { field: 'external_type', code: 'EXTERNAL_TYPE_MISMATCH' },
            { field: 'match_method', code: 'CONTRACTOR_BY_TAX_CODE_ONLY' },
            { field: 'x', code: 'SOMETHING_NEW' },
          ],
        }),
    });
    const dialog = await openPropose();
    fill(dialog, { ours: 'GT-1', external: 'IB1', reason: LONG });
    send(dialog);
    const list = await within(dialog).findByRole('list', { name: t('egp.mapping.problem.findings.label') });
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual([t('egp.mapping.error.externalTypeMismatch'), t('egp.mapping.error.contractorByTaxCodeOnly'), t('egp.mapping.problem.validation')]);
  });

  // ---- decide and retire -------------------------------------------------------------------------------------------------------------------------------------------------

  it('approve: needs a reason of 10 characters, sends the decision with If-Match of the version the row had, and says what happened', async () => {
    const h = mountWith();
    await rowsShown();
    fireEvent.click(within(rowOf(2)).getByRole('button', { name: t('egp.mapping.action.approve.label', { ours: 'GT-2', external: 'IB26002' }) }));
    const dialog = await screen.findByRole('dialog', { name: t('egp.mapping.approve.title') });
    expect(within(dialog).getByText(t('egp.mapping.approve.effect'))).toBeTruthy();
    expect(within(dialog).getByText(t('egp.mapping.dialog.maker.note'))).toBeTruthy();
    expect(within(dialog).getByText('Nguyễn Văn An')).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: t('egp.mapping.approve.confirm.action') });
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.change(reasonOf(dialog, t('egp.mapping.dialog.reason.label')), { target: { value: 'ngắn' } });
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.change(reasonOf(dialog, t('egp.mapping.dialog.reason.label')), { target: { value: '  Đã đối chiếu thông báo mời thầu  ' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledTimes(1);
    expect(h.command).toHaveBeenCalledWith('decideEgpMapping', expect.objectContaining({ path: { id: mappingId(2) }, body: { decision: 'APPROVE', reason: 'Đã đối chiếu thông báo mời thầu' }, ifMatchVersion: 1 }));
    expect((await screen.findByTestId('receipt')).textContent).toBe(t('egp.mapping.success.approved', { code: 'GT-2', external: 'IB26002' }));
  });

  it('reject: the same dialog with its own words; the row stays as history', async () => {
    const h = mountWith();
    await rowsShown();
    fireEvent.click(within(rowOf(2)).getByRole('button', { name: t('egp.mapping.action.reject.label', { ours: 'GT-2', external: 'IB26002' }) }));
    const dialog = await screen.findByRole('dialog', { name: t('egp.mapping.reject.title') });
    expect(within(dialog).getByText(t('egp.mapping.reject.effect'))).toBeTruthy();
    fireEvent.change(reasonOf(dialog, t('egp.mapping.dialog.reason.label')), { target: { value: 'Mã không đúng gói' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.mapping.reject.confirm.action') }));
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command).toHaveBeenCalledWith('decideEgpMapping', expect.objectContaining({ path: { id: mappingId(2) }, body: { decision: 'REJECT', reason: 'Mã không đúng gói' }, ifMatchVersion: 1 }));
    expect((await screen.findByTestId('receipt')).textContent).toBe(t('egp.mapping.success.rejected', { code: 'GT-2', external: 'IB26002' }));
  });

  it('maker is not approver: the row the caller proposed says so in words and has no approve or reject button', async () => {
    mountWith({ world: { mappings: [proposed(3, { proposed_by: ME, can_decide: false }), proposed(4, { can_decide: false })] } });
    await rowsShown();
    expect(within(rowOf(3)).getByTestId('maker-words').textContent).toBe('Người đề xuất không tự duyệt');
    expect(within(rowOf(3)).getByTestId('maker-words').textContent).toBe(t('egp.mapping.row.selfApproval'));
    expect(within(rowOf(3)).queryByRole('button')).toBeNull();
    // Someone else's proposal that the caller has no right to decide says it waits, not that the caller proposed it.
    expect(within(rowOf(4)).getByTestId('waiting-words').textContent).toBe(t('egp.mapping.row.waiting'));
    expect(within(rowOf(4)).queryByRole('button')).toBeNull();
  });

  it('a refusal of the decision is said in the dialog: the maker is not the approver, the row changed (reload), the row is no longer waiting, the code was taken meanwhile', async () => {
    const cases: Array<[Error, string]> = [
      [problem('SELF_APPROVAL_DENIED', 403), 'egp.mapping.problem.self'],
      [problem('VERSION_CONFLICT', 409), 'egp.mapping.problem.version'],
      [problem('EGP_MAPPING_STATE_INVALID', 409), 'egp.mapping.problem.state'],
      [problem('CROSSWALK_DUPLICATE', 409, { reason: 'EXTERNAL_CODE_TAKEN' }), 'egp.mapping.problem.taken'],
    ];
    for (const [error, key] of cases) {
      const h = mountWith({ command: () => error });
      await rowsShown();
      fireEvent.click(within(rowOf(2)).getByRole('button', { name: t('egp.mapping.action.approve.label', { ours: 'GT-2', external: 'IB26002' }) }));
      const dialog = await screen.findByRole('dialog', { name: t('egp.mapping.approve.title') });
      fireEvent.change(reasonOf(dialog, t('egp.mapping.dialog.reason.label')), { target: { value: 'Đã đối chiếu hồ sơ' } });
      fireEvent.click(within(dialog).getByRole('button', { name: t('egp.mapping.approve.confirm.action') }));
      await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe(t(key as never)));
      expect(h.command).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('receipt')).toBeNull();
      const reload = within(dialog).queryByRole('button', { name: t('egp.mapping.problem.reload.action') });
      expect(reload === null).toBe(error.message !== 'VERSION_CONFLICT');
      cleanup();
    }
  });

  it('conflict: a version conflict offers the reload, which refreshes the list and closes the dialog', async () => {
    const h = mountWith({ command: () => problem('VERSION_CONFLICT', 409) });
    await rowsShown();
    fireEvent.click(within(rowOf(2)).getByRole('button', { name: t('egp.mapping.action.approve.label', { ours: 'GT-2', external: 'IB26002' }) }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(reasonOf(dialog, t('egp.mapping.dialog.reason.label')), { target: { value: 'Đã đối chiếu hồ sơ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.mapping.approve.confirm.action') }));
    const reload = await within(dialog).findByRole('button', { name: t('egp.mapping.problem.reload.action') });
    const before = listReads(h).length;
    fireEvent.click(reload);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(listReads(h).length).toBeGreaterThan(before));
  });

  it('retire: only where the row can be retired, with a reason, If-Match, and the words that the row stays as history', async () => {
    const h = mountWith({ world: { mappings: [mapping(1), mapping(2, { can_retire: false })] } });
    await rowsShown();
    expect(within(rowOf(2)).queryByRole('button')).toBeNull();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: t('egp.mapping.action.retire.label', { ours: 'GT-1', external: 'IB26001' }) }));
    const dialog = await screen.findByRole('dialog', { name: t('egp.mapping.retire.title') });
    expect(within(dialog).getByText(t('egp.mapping.retire.effect'))).toBeTruthy();
    expect(t('egp.mapping.retire.effect')).toContain('lịch sử');
    const confirm = within(dialog).getByRole('button', { name: t('egp.mapping.retire.confirm.action') });
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.change(reasonOf(dialog, t('egp.mapping.dialog.reason.label')), { target: { value: 'Gói được nối lại mã mới' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).toHaveBeenCalledWith('retireEgpMapping', expect.objectContaining({ path: { id: mappingId(1) }, body: { reason: 'Gói được nối lại mã mới' }, ifMatchVersion: 3 }));
    expect((await screen.findByTestId('receipt')).textContent).toBe(t('egp.mapping.success.retired', { code: 'GT-1', external: 'IB26001' }));
  });

  it('retire: a row that is no longer in force is refused in words', async () => {
    mountWith({ command: () => problem('EGP_MAPPING_STATE_INVALID', 409) });
    await rowsShown();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: t('egp.mapping.action.retire.label', { ours: 'GT-1', external: 'IB26001' }) }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(reasonOf(dialog, t('egp.mapping.dialog.reason.label')), { target: { value: 'Gói được nối lại mã mới' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('egp.mapping.retire.confirm.action') }));
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe(t('egp.mapping.problem.state')));
  });

  it('a dialog keeps focus inside, Escape cancels it and gives the focus back to the button that opened it', async () => {
    mountWith();
    const opener = await screen.findByRole('button', { name: t('egp.mapping.action.propose') });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: t('egp.mapping.propose.title') });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  // ---- the suggestions ------------------------------------------------------------------------------------------------------------------------------------------------

  it('suggestions: shows the package of the network with its price and the candidates of ours with the likeness, and says nothing is linked', async () => {
    mountWith();
    const list = await screen.findByTestId('suggestions');
    const item = within(list).getAllByRole('listitem')[0] as HTMLElement;
    expect(item.textContent).toContain(t('egp.mapping.suggest.external', { code: 'IB2600900', name: 'Xây dựng cầu qua sông Gâm' }));
    expect(item.textContent).toContain(t('egp.mapping.suggest.meta', { price: BigInt('128400000000').toLocaleString('vi'), plan: 'PL2600001' }));
    expect(item.textContent).toContain(t('egp.mapping.suggest.candidate', { code: 'GT-9', name: 'Xây dựng cầu qua sông Gâm giai đoạn 1' }));
    expect(item.textContent).toContain(t('egp.mapping.suggest.budget', { amount: BigInt('128400000000').toLocaleString('vi') }));
    expect(within(item).getByTestId('likeness').textContent).toContain(t('egp.mapping.suggest.likeness', { value: (0.857).toLocaleString('vi') }));
    expect(screen.getByText(t('egp.mapping.suggest.intro'))).toBeTruthy();
    expect(t('egp.mapping.suggest.intro')).toContain('gợi ý');
  });

  it('suggestions: the "i" says the formula, the source, the threshold and the legal status of the server, and that it is a hint a person confirms', async () => {
    mountWith();
    await screen.findByTestId('suggestions');
    const name = t('egp.mapping.info.name.text');
    const buttons = screen.getAllByRole('button', { name: t('egp.mapping.info.open.label', { name }) });
    fireEvent.click(buttons[0] as HTMLElement);
    const panel = await screen.findByRole('dialog', { name });
    expect(panel.textContent).toContain('Jaccard của các từ của hai tên');
    expect(panel.textContent).toContain('Tệp KHLCNT đã nhập và ngân sách gói thầu');
    expect(panel.textContent).toContain(t('egp.mapping.info.threshold.text', { threshold: (0.8).toLocaleString('vi'), legal: 'UNVERIFIED' }));
    expect(panel.textContent).toContain(t('egp.mapping.info.unverified.text'));
    expect(panel.textContent).toContain('12/11/2026 10:00');
    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name })).toBeNull());
  });

  it('suggestions: the button opens the proposal filled with the package, the codes, the method and the likeness; nothing is sent until a reason is given and the person confirms', async () => {
    const h = mountWith();
    await screen.findByTestId('suggestions');
    fireEvent.click(screen.getByRole('button', { name: t('egp.mapping.suggest.propose.label', { ours: 'GT-9', external: 'IB2600900' }) }));
    const dialog = await screen.findByRole('dialog', { name: t('egp.mapping.propose.title') });
    expect(h.command).not.toHaveBeenCalled();
    expect((within(dialog).getByLabelText(t('egp.mapping.field.subject.label')) as HTMLSelectElement).value).toBe('PACKAGE');
    expect(within(dialog).getByLabelText(t('egp.mapping.field.subject.label'))).toHaveProperty('disabled', true);
    const ours = within(dialog).getByLabelText(t('egp.mapping.field.ourCode.label')) as HTMLInputElement;
    const external = within(dialog).getByLabelText(t('egp.mapping.field.externalCode.label')) as HTMLInputElement;
    expect([ours.value, ours.readOnly, external.value, external.readOnly]).toEqual(['GT-9', true, 'IB2600900', true]);
    expect(within(dialog).getByTestId('suggestion-note').textContent).toBe(t('egp.mapping.propose.suggestion.note', { value: (0.857).toLocaleString('vi') }));
    // The first field a person can change takes the focus.
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText(t('egp.mapping.field.projectCode.label'))));
    fill(dialog, { project: 'PRJ-1', reason: 'Đã đối chiếu thông báo mời thầu' });
    send(dialog);
    await waitFor(() => expect(h.command).toHaveBeenCalled());
    expect(h.command).toHaveBeenCalledWith('proposeEgpMapping', expect.objectContaining({ body: { subject_type: 'PACKAGE', our_code: 'GT-9', our_project_code: 'PRJ-1', external_code: 'IB2600900', match_method: 'NAME_SUGGESTION', confidence: 0.857, reason: 'Đã đối chiếu thông báo mời thầu' } }));
    expect((await screen.findByTestId('receipt')).textContent).toBe(t('egp.mapping.success.proposed', { code: 'GT-9', external: 'IB2600900' }));
  });

  it('suggestions: empty says why, and an error is said in place without touching the list', async () => {
    mountWith({ world: { suggestions: suggestions({ items: [] }) } });
    expect((await screen.findByTestId('suggestions-empty')).textContent).toBe(t('egp.mapping.suggest.empty'));
    await rowsShown();
    cleanup();
    const state = world({ failing: new Map([['listEgpMappingSuggestions', new Error('boom')]]) });
    mount(<MappingScreen route={route} />, client(state), { permissions: MAPPER });
    const error = await screen.findByTestId('suggestions-error');
    expect(error.textContent).toContain(t('egp.mapping.suggest.error'));
    await rowsShown();
    state.failing.clear();
    fireEvent.click(within(error).getByRole('button', { name: t('states.retry.action') }));
    expect(await screen.findByTestId('suggestions')).toBeTruthy();
  });

  it('suggestions: the packages of ours with the same ids are told apart by id, not by code', async () => {
    mountWith({
      world: {
        suggestions: suggestions({
          items: [
            {
              external_code: 'IB1',
              imported_name: 'Gói A',
              imported_price_vnd: '100',
              plan_code: 'PL1',
              import_id: 'i1',
              candidates: [
                { package_id: packageId(1), code: 'GT-1', name: 'Gói A1', budget_vnd: '100', confidence: 0.9 },
                { package_id: packageId(2), code: 'GT-1', name: 'Gói A2', budget_vnd: '100', confidence: 0.85 },
              ],
            },
          ],
        }),
      },
    });
    const list = await screen.findByTestId('suggestions');
    expect(list.querySelectorAll('[data-package-id]')).toHaveLength(2);
  });
});
