import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../i18n';
import MappingScreen from './MappingScreen';
import { vietnamStamp } from './feed-model';
import { AS_OF, ME, activeMapping, client, connection, mapping, mappingId, mountScreen, problem, routeOf, unmapped, word, world } from './test/feed-test-support';
import type { MountOptions, World } from './test/feed-test-support';

const ROUTE = routeOf('FEED-03');

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

interface Options extends MountOptions {
  world?: Partial<World>;
  command?: (operation: string, input: unknown) => unknown;
}

function open(options: Options = {}) {
  const state = world(options.world);
  const h = client(state, options.command ?? (() => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 4 })));
  const mounted = mountScreen(<MappingScreen route={ROUTE} />, h, options);
  return { h, state, ...mounted };
}

const rowsOf = (): HTMLElement[] => Array.from(document.querySelectorAll('tr[data-mapping-id]')) as HTMLElement[];
const unmappedRows = (): HTMLElement[] => Array.from(document.querySelectorAll('tr[data-external-code]')).filter((row) => !row.hasAttribute('data-mapping-id')) as HTMLElement[];
const loaded = async (): Promise<void> => {
  await waitFor(() => expect(rowsOf().length).toBeGreaterThan(0));
};
const dialog = (): HTMLElement => screen.getByRole('dialog');
const reasonBox = (): HTMLElement => within(dialog()).getByLabelText(new RegExp(word('feed.common.dialog.reason.label')));
const type = (text: string): void => {
  fireEvent.change(within(dialog()).getByRole('textbox', { name: /Lý do/ }), { target: { value: text } });
};

describe('MappingScreen (FEED-03): the project codes of the Finance Department', () => {
  it('AC-ST-FEED-001-6 / UI-FEED-03: lists the mappings with the code of the Department, ours, method, validity, state and the people, and says the layout is an assumption', async () => {
    open();
    await loaded();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('feed.mapping.page.title'));
    expect(screen.getAllByTestId('acceptance-badge')[0]?.textContent).toContain(word('feed.common.acceptance.pending'));
    expect(screen.getByTestId('maker-note').textContent).toBe(word('feed.mapping.note.maker'));
    const rows = rowsOf();
    expect(rows).toHaveLength(3);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText('FIN-0001')).toBeTruthy();
    expect(first.getByText('DA-1')).toBeTruthy();
    expect(first.getByText('Dự án số 1')).toBeTruthy();
    expect(first.getByText(word('feed.mapping.method.manual'))).toBeTruthy();
    expect(first.getByText(word('feed.mapping.status.proposed'))).toBeTruthy();
    expect(first.getByTestId('proposed-by').textContent).toBe(word('feed.mapping.cell.proposed', { name: 'Lê Thị Hoa', day: '06/11/2026' }));
    expect(first.getByText(word('feed.mapping.cell.validity', { from: '01/01/2026', until: word('feed.mapping.cell.unlimited') }))).toBeTruthy();
    const active = within(rows[1] as HTMLElement);
    expect(active.getByTestId('decided-by').textContent).toBe(word('feed.mapping.cell.approved', { name: 'Nguyễn Văn An', day: '07/11/2026' }));
    const rejected = within(rows[2] as HTMLElement);
    expect(rejected.getByTestId('decided-by').textContent).toBe(word('feed.mapping.cell.rejected', { name: 'Nguyễn Văn An', day: '07/11/2026' }));
  });

  it('opens the "i" of the state of a mapping: the formula, the table it comes from and the version of the record', async () => {
    open();
    await loaded();
    fireEvent.click(within(rowsOf()[0] as HTMLElement).getByRole('button', { name: word('feed.common.info.open.label', { name: word('feed.mapping.figure.status.name') }) }));
    const panel = screen.getByRole('dialog', { name: word('feed.mapping.figure.status.name') });
    expect(panel.querySelector('[data-field="source"] dd')?.textContent).toBe(word('feed.mapping.figure.status.source'));
    expect(panel.querySelector('[data-field="version"] dd')?.textContent).toBe(word('feed.mapping.figure.status.version', { version: 3 }));
    expect(panel.querySelector('[data-field="asOf"] dd')?.textContent).toBe(vietnamStamp(AS_OF));
  });

  it('shows the chips with the count of each state and narrows the list by a press', async () => {
    open();
    await loaded();
    const chips = within(screen.getByRole('group', { name: word('feed.mapping.chip.group.label') }));
    expect(chips.getByRole('button', { name: word('feed.mapping.chip.all', { count: 3 }) }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chips.getByRole('button', { name: word('feed.mapping.chip.label', { label: word('feed.mapping.status.active'), count: 1 }) }));
    await waitFor(() => expect(rowsOf()).toHaveLength(1));
    expect(rowsOf()[0]?.getAttribute('data-status')).toBe('ACTIVE');
    fireEvent.click(chips.getByRole('button', { name: word('feed.mapping.chip.all', { count: 3 }) }));
    await waitFor(() => expect(rowsOf()).toHaveLength(3));
  });

  it('searches by code and says when nothing matches', async () => {
    open();
    await loaded();
    fireEvent.change(screen.getByLabelText(word('feed.mapping.filter.q.label')), { target: { value: 'FIN-0002' } });
    fireEvent.click(screen.getByRole('button', { name: word('feed.mapping.filter.apply.action') }));
    await waitFor(() => expect(rowsOf()).toHaveLength(1));
    fireEvent.change(screen.getByLabelText(word('feed.mapping.filter.q.label')), { target: { value: 'NONE' } });
    fireEvent.click(screen.getByRole('button', { name: word('feed.mapping.filter.apply.action') }));
    await waitFor(() => expect(rowsOf()).toHaveLength(0));
  });

  it('starts from the filter in the address', async () => {
    open({ path: '/?status=REJECTED' });
    await waitFor(() => expect(rowsOf()).toHaveLength(1));
    expect(rowsOf()[0]?.getAttribute('data-status')).toBe('REJECTED');
  });

  it('pages: load more appends the next page', async () => {
    open({ world: { pageSize: 2 } });
    await loaded();
    expect(rowsOf()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: word('feed.common.paging.more') }));
    await waitFor(() => expect(rowsOf()).toHaveLength(3));
  });

  it('lists the codes that wait for a mapping with the hint of the server, and says when the list is cut', async () => {
    open({ world: { unmapped: { items: [unmapped(1), unmapped(2)], total: 90 } } });
    await loaded();
    await waitFor(() => expect(unmappedRows()).toHaveLength(2));
    expect(within(unmappedRows()[0] as HTMLElement).getByText('DA-HINT')).toBeTruthy();
    expect(within(unmappedRows()[1] as HTMLElement).getByText(word('feed.mapping.unmapped.hint.none'))).toBeTruthy();
    expect(screen.getByText(word('feed.mapping.unmapped.total.text', { count: '90' }))).toBeTruthy();
    expect(screen.getByTestId('unmapped-partial').textContent).toBe(word('feed.mapping.unmapped.partial.text', { shown: 2, total: 90 }));
  });

  it('says that every code is mapped when none waits', async () => {
    open({ world: { unmapped: { items: [] } } });
    expect((await screen.findByTestId('unmapped-empty')).textContent).toBe(word('feed.mapping.unmapped.empty.text'));
  });

  it('says the list of unmapped codes could not be read without hiding the mappings', async () => {
    open({ world: { failing: new Map([['listFinanceFeedUnmapped', new Error('down')]]) } });
    await loaded();
    expect((await screen.findByTestId('error')).textContent).toContain(word('feed.common.state.error.title'));
    expect(rowsOf()).toHaveLength(3);
  });
});

describe('MappingScreen (FEED-03): the maker and the checker', () => {
  it('offers approve and reject only on a proposal that the person may decide, and retire only on an active mapping', async () => {
    open();
    await loaded();
    const rows = rowsOf();
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: word('feed.mapping.action.approve.label', { ours: 'DA-1', external: 'FIN-0001' }) })).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: word('feed.mapping.action.reject.label', { ours: 'DA-1', external: 'FIN-0001' }) })).toBeTruthy();
    expect(within(rows[0] as HTMLElement).queryByRole('button', { name: /Thu hồi/ })).toBeNull();
    expect(within(rows[1] as HTMLElement).getByRole('button', { name: word('feed.mapping.action.retire.label', { ours: 'DA-2', external: 'FIN-0002' }) })).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByRole('button', { name: /Duyệt/ })).toBeNull();
    expect(within(rows[2] as HTMLElement).queryAllByRole('button')).toHaveLength(1);
  });

  it('says to the maker that another person approves, and offers no approve button', async () => {
    open({ world: { mappings: [mapping(1, { proposed_by: ME, can_decide: false })] } });
    await loaded();
    expect(within(rowsOf()[0] as HTMLElement).getByTestId('maker-words').textContent).toBe(word('feed.mapping.row.selfApproval'));
    expect(within(rowsOf()[0] as HTMLElement).queryByRole('button', { name: /Duyệt/ })).toBeNull();
  });

  it('says a proposal waits for a person who may approve when the caller may not', async () => {
    open({ world: { mappings: [mapping(1, { can_decide: false })] } });
    await loaded();
    expect(within(rowsOf()[0] as HTMLElement).getByTestId('waiting-words').textContent).toBe(word('feed.mapping.row.waiting'));
  });

  it('approves with a reason under the version the person saw, then says what was done and reads the lists again', async () => {
    const { h } = open();
    await loaded();
    fireEvent.click(within(rowsOf()[0] as HTMLElement).getByRole('button', { name: word('feed.mapping.action.approve.label', { ours: 'DA-1', external: 'FIN-0001' }) }));
    expect(within(dialog()).getByText(word('feed.mapping.dialog.maker.note'))).toBeTruthy();
    expect(within(dialog()).getByText('Lê Thị Hoa')).toBeTruthy();
    const confirm = within(dialog()).getByRole('button', { name: word('feed.mapping.approve.confirm.action') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    type('Đã đối chiếu hồ sơ dự án');
    expect(confirm.disabled).toBe(false);
    const before = h.read.mock.calls.length;
    fireEvent.click(confirm);
    expect((await screen.findByTestId('receipt')).textContent).toBe(word('feed.mapping.success.approved', { external: 'FIN-0001', ours: 'DA-1' }));
    const [operation, input] = h.command.mock.calls[0] as [string, { path: { id: string }; body: unknown; ifMatchVersion: number }];
    expect(operation).toBe('decideFinanceFeedMapping');
    expect(input.path.id).toBe(mappingId(1));
    expect(input.body).toEqual({ decision: 'APPROVE', reason: 'Đã đối chiếu hồ sơ dự án' });
    expect(input.ifMatchVersion).toBe(3);
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(before));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('rejects with a reason', async () => {
    const { h } = open();
    await loaded();
    fireEvent.click(within(rowsOf()[0] as HTMLElement).getByRole('button', { name: word('feed.mapping.action.reject.label', { ours: 'DA-1', external: 'FIN-0001' }) }));
    type('Sai dự án, trùng tên khác chủ đầu tư');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('feed.mapping.reject.confirm.action') }));
    expect((await screen.findByTestId('receipt')).textContent).toBe(word('feed.mapping.success.rejected', { external: 'FIN-0001', ours: 'DA-1' }));
    expect((h.command.mock.calls[0] as [string, { body: { decision: string } }])[1].body.decision).toBe('REJECT');
  });

  it('retires an active mapping with a reason', async () => {
    const { h } = open();
    await loaded();
    fireEvent.click(within(rowsOf()[1] as HTMLElement).getByRole('button', { name: word('feed.mapping.action.retire.label', { ours: 'DA-2', external: 'FIN-0002' }) }));
    expect(within(dialog()).getByText(word('feed.mapping.retire.effect'))).toBeTruthy();
    type('Mã đã được Sở cấp lại cho dự án khác');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('feed.mapping.retire.confirm.action') }));
    expect((await screen.findByTestId('receipt')).textContent).toBe(word('feed.mapping.success.retired', { external: 'FIN-0002', ours: 'DA-2' }));
    const [operation, input] = h.command.mock.calls[0] as [string, { body: unknown }];
    expect(operation).toBe('retireFinanceFeedMapping');
    expect(input.body).toEqual({ reason: 'Mã đã được Sở cấp lại cho dự án khác' });
  });

  it.each([
    ['SELF_APPROVAL_DENIED', 403, word('feed.common.problem.selfApproval')],
    ['FEED_MAPPING_STATE_INVALID', 409, word('feed.common.problem.mappingState')],
    ['RESOURCE_NOT_FOUND', 404, word('feed.common.problem.notFound')],
    ['SCOPE_DENIED', 403, word('feed.common.problem.scopeDenied')],
  ])('says in the dialog why the server refused: %s', async (code, status, expected) => {
    open({ command: () => problem(code, status) });
    await loaded();
    fireEvent.click(within(rowsOf()[0] as HTMLElement).getByRole('button', { name: word('feed.mapping.action.approve.label', { ours: 'DA-1', external: 'FIN-0001' }) }));
    type('Đã đối chiếu hồ sơ dự án');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('feed.mapping.approve.confirm.action') }));
    expect((await within(dialog()).findByRole('alert')).textContent).toContain(expected);
    expect(screen.queryByTestId('receipt')).toBeNull();
  });

  it('offers the reload when the version moved', async () => {
    const { h } = open({ command: () => problem('VERSION_CONFLICT', 409) });
    await loaded();
    fireEvent.click(within(rowsOf()[0] as HTMLElement).getByRole('button', { name: word('feed.mapping.action.approve.label', { ours: 'DA-1', external: 'FIN-0001' }) }));
    type('Đã đối chiếu hồ sơ dự án');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('feed.mapping.approve.confirm.action') }));
    await within(dialog()).findByText(word('feed.common.problem.versionConflict'));
    const before = h.read.mock.calls.length;
    fireEvent.click(within(dialog()).getByRole('button', { name: word('feed.common.problem.reload.action') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('MappingScreen (FEED-03): proposing by hand', () => {
  const open1 = async (options: Options = {}) => {
    const mounted = open(options);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: word('feed.mapping.action.propose') }));
    return mounted;
  };
  const field = (label: string): HTMLInputElement => within(dialog()).getByLabelText(label) as HTMLInputElement;

  it('checks the fields in place before it sends: both codes are required, the end day follows the start day', async () => {
    const { h } = await open1();
    type('Trùng tên và vốn của dự án');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('feed.mapping.propose.confirm.action') }));
    expect(within(dialog()).getAllByText(word('feed.mapping.issue.required'))).toHaveLength(2);
    expect(within(dialog()).getByRole('alert').textContent).toBe(word('feed.mapping.invalid.summary'));
    fireEvent.change(field(word('feed.mapping.field.externalCode.label')), { target: { value: 'FIN-5' } });
    fireEvent.change(field(word('feed.mapping.field.ourCode.label')), { target: { value: 'DA-5' } });
    fireEvent.change(field(word('feed.mapping.field.validFrom.label')), { target: { value: '2026-05-01' } });
    fireEvent.change(field(word('feed.mapping.field.validUntil.label')), { target: { value: '2026-04-01' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: word('feed.mapping.propose.confirm.action') }));
    expect(within(dialog()).getByText(word('feed.mapping.issue.order'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('sends the proposal with the reason and says that another person must approve it', async () => {
    const { h } = await open1({ command: () => mapping(9) });
    expect(within(dialog()).getByText(word('feed.mapping.propose.maker.note'))).toBeTruthy();
    fireEvent.change(field(word('feed.mapping.field.externalCode.label')), { target: { value: ' FIN-5 ' } });
    fireEvent.change(field(word('feed.mapping.field.ourCode.label')), { target: { value: 'DA-5' } });
    fireEvent.change(field(word('feed.mapping.field.validFrom.label')), { target: { value: '2026-05-01' } });
    type('Trùng tên và vốn của dự án');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('feed.mapping.propose.confirm.action') }));
    expect((await screen.findByTestId('receipt')).textContent).toBe(word('feed.mapping.success.proposed', { external: 'FIN-5', ours: 'DA-5' }));
    const [operation, input] = h.command.mock.calls[0] as [string, { body: unknown }];
    expect(operation).toBe('proposeFinanceFeedMapping');
    expect(input.body).toEqual({ our_code: 'DA-5', external_code: 'FIN-5', reason: 'Trùng tên và vốn của dự án', valid_from: '2026-05-01' });
  });

  it('opens from an unmapped code with the code fixed and the hint as our code', async () => {
    open();
    await waitFor(() => expect(unmappedRows()).toHaveLength(2));
    fireEvent.click(within(unmappedRows()[0] as HTMLElement).getByRole('button', { name: word('feed.mapping.unmapped.propose.label', { code: 'FIN-901' }) }));
    expect(field(word('feed.mapping.field.externalCode.label')).value).toBe('FIN-901');
    expect(field(word('feed.mapping.field.externalCode.label')).readOnly).toBe(true);
    expect(field(word('feed.mapping.field.ourCode.label')).value).toBe('DA-HINT');
  });

  it('says in the field when the server names it, and for a code already mapped', async () => {
    await open1({ command: () => problem('VALIDATION_FAILED', 422, 'our_code') });
    fireEvent.change(field(word('feed.mapping.field.externalCode.label')), { target: { value: 'FIN-5' } });
    fireEvent.change(field(word('feed.mapping.field.ourCode.label')), { target: { value: 'DA-5' } });
    type('Trùng tên và vốn của dự án');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('feed.mapping.propose.confirm.action') }));
    await waitFor(() => expect(field(word('feed.mapping.field.ourCode.label')).getAttribute('aria-invalid')).toBe('true'));
    cleanup();
    await open1({ command: () => problem('CROSSWALK_DUPLICATE', 409) });
    fireEvent.change(field(word('feed.mapping.field.externalCode.label')), { target: { value: 'FIN-5' } });
    fireEvent.change(field(word('feed.mapping.field.ourCode.label')), { target: { value: 'DA-5' } });
    type('Trùng tên và vốn của dự án');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('feed.mapping.propose.confirm.action') }));
    expect((await within(dialog()).findByRole('alert')).textContent).toContain(word('feed.common.problem.duplicate'));
  });

  it('offers no propose button to a person who may not, or in a read-only workspace, and says why', async () => {
    open({ world: { connection: connection({}, { propose_mapping: false, decide_mapping: false }), mappings: [mapping(1, { can_decide: false }), activeMapping(2, { can_retire: false })] } });
    await loaded();
    expect(screen.queryByRole('button', { name: word('feed.mapping.action.propose') })).toBeNull();
    expect(screen.getByTestId('readonly-note').textContent).toBe(word('feed.common.readonly.right'));
    cleanup();
    open({ mode: 'READ_ONLY' });
    await loaded();
    expect(screen.queryByRole('button', { name: word('feed.mapping.action.propose') })).toBeNull();
    expect(screen.queryByRole('button', { name: /Duyệt/ })).toBeNull();
    expect(screen.getByTestId('readonly-note').textContent).toBe(word('feed.common.readonly.mode'));
  });
});

describe('MappingScreen (FEED-03): the states', () => {
  it('shows loading, then the empty state with the way to the import', async () => {
    const state = world({ mappings: [], unmapped: { items: [] } });
    state.hanging.add('listFinanceFeedMappings');
    mountScreen(<MappingScreen route={ROUTE} />, client(state));
    expect((await screen.findAllByTestId('loading')).length).toBeGreaterThan(0);
    cleanup();
    open({ world: { mappings: [], unmapped: { items: [] } } });
    const empty = await screen.findByTestId('empty');
    expect(empty.textContent).toContain(word('feed.mapping.empty.title'));
    expect(within(empty).getByRole('link', { name: word('feed.mapping.empty.import.link') }).getAttribute('href')).toBe('/feed/feed-02');
  });

  it('shows an error with a new try', async () => {
    const { state } = open({ world: { failing: new Map([['listFinanceFeedMappings', new Error('down')]]) } });
    const error = await screen.findByTestId('error');
    state.failing.clear();
    fireEvent.click(within(error).getByRole('button', { name: word('states.retry.action') }));
    await loaded();
  });

  it('shows the forbidden card instead of the whole screen for a 403, with no button to propose', async () => {
    open({ world: { failing: new Map([['listFinanceFeedMappings', problem('SCOPE_DENIED', 403)]]) } });
    expect((await screen.findByTestId('denied')).textContent).toContain(word('feed.common.state.denied.title'));
    expect(screen.queryByRole('button', { name: word('feed.mapping.action.propose') })).toBeNull();
    expect(unmappedRows()).toHaveLength(0);
  });

  it('keeps the mappings and says the refresh failed (stale)', async () => {
    const { queries, state } = open();
    await loaded();
    state.failing.set('listFinanceFeedMappings', new Error('down'));
    await act(async () => {
      await queries.invalidateQueries({ predicate: (query) => query.queryKey.includes('mappings') });
    });
    expect((await screen.findByTestId('stale')).textContent).toContain(word('feed.common.state.stale.text', { time: vietnamStamp(AS_OF) }));
    expect(rowsOf()).toHaveLength(3);
  });

  it('reads the reason box of the dialog by its label', async () => {
    open();
    await loaded();
    fireEvent.click(within(rowsOf()[0] as HTMLElement).getByRole('button', { name: word('feed.mapping.action.approve.label', { ours: 'DA-1', external: 'FIN-0001' }) }));
    expect(reasonBox()).toBeTruthy();
  });
});
