import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { routeOf } from '../test-support';
import { mountInSession } from '../../doc/test-support';
import MappingScreen from './MappingScreen';
import { DATASET, client, commandsOf, mapping, mappingId, problem, uuid, world } from './test-support';
import type { Harness, World } from './test-support';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const PERMISSIONS = ['data.mapping.read', 'data.mapping.manage', 'data.mapping.approve', 'data.catalog.read'];
const ROUTE = routeOf('DGV-20', 'FR-DGV-20');

function open(state: Partial<World> = {}, options: { mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown; path?: string } = {}): Harness & { state: World } {
  const full = world(state);
  const h = client(full, options.command);
  mountInSession(<MappingScreen route={ROUTE} />, h, { permissions: PERMISSIONS, ...(options.mode === undefined ? {} : { mode: options.mode }) }, options.path ?? '/dgv/dgv-20');
  return { ...h, state: full };
}

const rows = (): string[] => Array.from(document.querySelectorAll('[data-mapping]')).map((row) => row.getAttribute('data-mapping') as string);
const dialog = (): HTMLElement => screen.getByRole('dialog');
const pick = (id: string, value: string): void => {
  fireEvent.change(document.getElementById(id) as HTMLElement, { target: { value } });
};
const type = pick;

afterEach(() => cleanup());

describe('MappingScreen (DGV-20): the mappings of the fields of a source', () => {
  it('UI-DGV-20: lists the mappings with their dataset, source, target, unit, status and who proposed them', async () => {
    open({ mappings: [mapping(2, { status: 'CONFIRMED', unit: 'VND', decided_by: { id: uuid('0001', 2), name: 'Tran Thi Binh' }, decision_note: 'Đã kiểm với KBNN' }), mapping(1, { transform_rule: 'x / 1000' })] });
    await screen.findByTestId('mappings');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('dgv.source.title'));
    expect(rows()).toEqual([mappingId(2), mappingId(1)]);
    const confirmed = document.querySelector(`[data-mapping="${mappingId(2)}"]`) as HTMLElement;
    expect(within(confirmed).getByTestId('status').textContent).toBe(word('dgv.source.status.confirmed'));
    expect(within(confirmed).getByTestId('unit').textContent).toBe(word('dgv.source.unit.vnd'));
    expect(confirmed.textContent).toContain('Tran Thi Binh');
    expect(confirmed.textContent).toContain('Đã kiểm với KBNN');
    const proposed = document.querySelector(`[data-mapping="${mappingId(1)}"]`) as HTMLElement;
    expect(within(proposed).getByTestId('status').textContent).toBe(word('dgv.source.status.proposed'));
    expect(within(proposed).getByTestId('unit').textContent).toBe(word('dgv.source.unit.million'));
    expect(proposed.textContent).toContain('Nguyen Van An');
    expect(proposed.textContent).toContain('x / 1000');
    expect(screen.getByText(word('dgv.source.footer.reference').replace('{id}', 'DGV-20').replace('{req}', 'FR-DGV-20'))).toBeTruthy();
  });

  it('narrows the list by dataset and status, asking the server for only what was chosen, and starts on the dataset in the link', async () => {
    const h = open({ mappings: [mapping(2, { status: 'CONFIRMED' }), mapping(1)] });
    await screen.findByTestId('mappings');
    const queries = () => h.read.mock.calls.filter((call) => call[0] === 'listSourceMappings').map((call) => (call[1] as { query: Record<string, unknown> }).query);
    expect(queries()[0]).toEqual({ limit: 50 });
    pick('mapping-filter-status', 'PROPOSED');
    await waitFor(() => expect(rows()).toEqual([mappingId(1)]));
    expect(queries().at(-1)).toEqual({ limit: 50, status: 'PROPOSED' });
    pick('mapping-filter-status', '');
    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() => expect(document.querySelector(`#mapping-filter-dataset option[value="${DATASET.id}"]`)).not.toBeNull());
    pick('mapping-filter-dataset', DATASET.id);
    await waitFor(() => expect(queries().at(-1)).toEqual({ limit: 50, dataset_id: DATASET.id }));
    cleanup();
    const linked = open({ mappings: [mapping(1)] }, { path: `/dgv/dgv-20?dataset=${DATASET.id}` });
    await screen.findByTestId('mappings');
    expect((linked.read.mock.calls.find((call) => call[0] === 'listSourceMappings')?.[1] as { query: Record<string, unknown> }).query).toEqual({ limit: 50, dataset_id: DATASET.id });
  });

  it('says when there is no mapping, and shows a read that failed with a way to read again', async () => {
    open();
    expect((await screen.findByTestId('no-mappings')).textContent).toBe(word('dgv.source.none.notice'));
    cleanup();
    const failing = world({ failing: new Set(['listSourceMappings']) });
    const h = client(failing);
    mountInSession(<MappingScreen route={ROUTE} />, h, { permissions: PERMISSIONS }, '/dgv/dgv-20');
    const retry = await screen.findByRole('button', { name: /thử lại|retry/i });
    failing.failing.clear();
    fireEvent.click(retry);
    await screen.findByTestId('no-mappings');
  });

  it('AC-ST-DGV-004-2: proposes a mapping with the unit of the source, after the form is complete, and closes when the server accepts it', async () => {
    const h = open();
    await screen.findByTestId('no-mappings');
    fireEvent.click(screen.getByRole('button', { name: word('dgv.source.propose.action') }));
    // Nothing is sent from an empty form.
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.source.propose.submit') }));
    expect(within(dialog()).getByText(word('dgv.source.problem.invalidId'))).toBeTruthy();
    expect(within(dialog()).getAllByText(word('dgv.source.problem.required')).length).toBeGreaterThan(0);
    expect(commandsOf(h, 'proposeSourceMapping')).toHaveLength(0);
    await waitFor(() => expect(document.querySelector(`#propose-dataset option[value="${DATASET.id}"]`)).not.toBeNull());
    pick('propose-dataset', DATASET.id);
    type('propose-system', 'PAY');
    type('propose-source', 'so_tien');
    type('propose-target', 'amount_vnd');
    pick('propose-unit', 'MILLION_VND');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.source.propose.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'proposeSourceMapping')).toEqual([{ body: { dataset_id: DATASET.id, source_system: 'PAY', source_field: 'so_tien', target_field: 'amount_vnd', unit: 'MILLION_VND' }, attempt: expect.anything() }]);
  });

  it('tells the person why a proposal was refused, in words, and keeps the form open', async () => {
    let refusal = problem('MAPPING_DUPLICATE', 409, 'target_field');
    const h = open({}, { command: () => refusal });
    await screen.findByTestId('no-mappings');
    fireEvent.click(screen.getByRole('button', { name: word('dgv.source.propose.action') }));
    await waitFor(() => expect(document.querySelector(`#propose-dataset option[value="${DATASET.id}"]`)).not.toBeNull());
    pick('propose-dataset', DATASET.id);
    type('propose-system', 'PAY');
    type('propose-source', 'so_tien');
    type('propose-target', 'amount_vnd');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.source.propose.submit') }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('dgv.source.error.duplicate'));
    refusal = problem('VALIDATION_FAILED', 422, 'unit');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.source.propose.submit') }));
    await waitFor(() => expect(screen.getByTestId('refusal').textContent).toBe(word('dgv.source.error.unit')));
    expect(commandsOf(h, 'proposeSourceMapping')).toHaveLength(2);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('offers to confirm or reject only where the server says the viewer may, and decides at the version that was read', async () => {
    const h = open({ mappings: [mapping(3, { actions: { decide: true }, version: 4 }), mapping(2), mapping(1, { status: 'CONFIRMED', actions: { decide: false } })] });
    await screen.findByTestId('mappings');
    expect(document.querySelectorAll('[data-action="confirm"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-action="reject"]')).toHaveLength(1);
    fireEvent.click(document.querySelector('[data-action="confirm"]') as HTMLElement);
    expect(within(dialog()).getByTestId('decide-summary').textContent).toContain('PAY.so_tien_3');
    type('decide-note', 'Đơn vị đã kiểm với KBNN.');
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.source.confirm.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'decideSourceMapping')).toEqual([{ path: { id: mappingId(3) }, body: { decision: 'CONFIRMED', note: 'Đơn vị đã kiểm với KBNN.' }, ifMatchVersion: 4, attempt: expect.anything() }]);
    // A rejection without a note sends no note.
    fireEvent.click(document.querySelector('[data-action="reject"]') as HTMLElement);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.source.reject.submit') }));
    await waitFor(() => expect(commandsOf(h, 'decideSourceMapping')).toHaveLength(2));
    expect(commandsOf(h, 'decideSourceMapping')[1]).toMatchObject({ body: { decision: 'REJECTED' }, ifMatchVersion: 4 });
    expect(commandsOf(h, 'decideSourceMapping')[1]?.body).not.toHaveProperty('note');
  });

  it('shows the refusal of a decision: the proposer cannot confirm, a mapping that was decided meanwhile, a changed version', async () => {
    let refusal = problem('SELF_APPROVAL_DENIED', 403);
    open({ mappings: [mapping(1, { actions: { decide: true } })] }, { command: () => refusal });
    await screen.findByTestId('mappings');
    fireEvent.click(document.querySelector('[data-action="confirm"]') as HTMLElement);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.source.confirm.submit') }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(word('dgv.source.error.selfApproval'));
    refusal = problem('MAPPING_STATE_INVALID', 409);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.source.confirm.submit') }));
    await waitFor(() => expect(screen.getByTestId('refusal').textContent).toBe(word('dgv.source.error.stateInvalid')));
    refusal = problem('VERSION_CONFLICT', 409);
    fireEvent.click(within(dialog()).getByRole('button', { name: word('dgv.source.confirm.submit') }));
    await waitFor(() => expect(screen.getByTestId('refusal').textContent).toBe(word('dgv.source.error.versionConflict')));
  });

  it('shows no button that changes anything while the tenant is read-only', async () => {
    open({ mappings: [mapping(1, { actions: { decide: true } })] }, { mode: 'READ_ONLY' });
    await screen.findByTestId('mappings');
    expect(screen.queryByRole('button', { name: word('dgv.source.propose.action') })).toBeNull();
    expect(document.querySelector('[data-action="confirm"]')).toBeNull();
    expect(document.querySelector('[data-action="reject"]')).toBeNull();
  });
});
