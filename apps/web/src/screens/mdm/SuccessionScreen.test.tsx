import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import SuccessionScreen from './SuccessionScreen';
import { COMMUNE_A, COMMUNE_B, DISTRICT, MERGED, PROVINCE, conversion, edge, outside, target } from './succession-test-support';
import { READER, STEWARD, change, client, mount, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('MDM-37', 'FR-MDM-37');
const problem = (code: string, status = 422, detail?: string) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });

afterEach(cleanup);

const text = (template: string, params: Record<string, string | number>): string => Object.entries(params).reduce((result, [name, value]) => result.replace(`{${name}}`, String(value)), template);

/** FX-MDM-001: the district and the two communes end on 2025-07-01, the province stays, the merged commune begins. */
function reform(overrides: Partial<World> = {}): World {
  const merge1 = edge(1, COMMUNE_A, MERGED);
  const merge2 = edge(2, COMMUNE_B, MERGED);
  const abolish = edge(3, DISTRICT, PROVINCE, { succession_kind: 'ABOLISH_LEVEL' });
  return world({
    records: [DISTRICT, PROVINCE, COMMUNE_A, COMMUNE_B, MERGED],
    recordsOn: {
      '2025-06-30': [DISTRICT, PROVINCE, COMMUNE_A, COMMUNE_B, outside(MERGED)],
      '2025-07-01': [outside(DISTRICT), PROVINCE, outside(COMMUNE_A), outside(COMMUNE_B), MERGED],
    },
    successors: {
      [DISTRICT.id]: conversion(DISTRICT, '2025-07-01', [abolish], [target(PROVINCE, { succession_kind: 'ABOLISH_LEVEL', effective_date: '2025-07-01' })]),
      [COMMUNE_A.id]: conversion(COMMUNE_A, '2025-07-01', [merge1], [target(MERGED, { succession_kind: 'MERGE', effective_date: '2025-07-01' })]),
      [COMMUNE_B.id]: conversion(COMMUNE_B, '2025-07-01', [merge2], [target(MERGED, { succession_kind: 'MERGE', effective_date: '2025-07-01' })]),
    },
    ...overrides,
  });
}

const connectors = (): HTMLElement[] => screen.queryAllByTestId('connector-row');
const keysOf = (row: HTMLElement, side: 'before' | 'after'): string[] => Array.from(row.querySelectorAll(`[data-side="${side}"] li`)).map((item) => item.getAttribute('data-key') ?? '');
const ready = () => waitFor(() => expect(screen.getByTestId('succession-tree')).toBeTruthy());

describe('SuccessionScreen (MDM-37): the inheritance tree', () => {
  it('shows the structure before and from 01/07/2025 in two columns joined by connectors named MERGE and ABOLISH_LEVEL (AC-ST-MDM-009-1)', async () => {
    mount(<SuccessionScreen route={ROUTE} />, client(reform()), READER, '/mdm/mdm-37');
    await waitFor(() => expect(connectors()).toHaveLength(2));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['mdm.succession.page.title']);
    expect(screen.getByRole('heading', { level: 2, name: text(vi_['mdm.succession.before.title'], { date: '2025-07-01' }) })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: text(vi_['mdm.succession.after.title'], { date: '2025-07-01' }) })).toBeTruthy();
    // The date is a working assumption until CXN-34 is confirmed, and the screen says so.
    expect(screen.getByTestId('assumption').textContent).toBe(vi_['mdm.succession.assumption.notice']);
    const merge = connectors().find((row) => row.getAttribute('data-connector') === 'MERGE') as HTMLElement;
    expect(keysOf(merge, 'before')).toEqual(['XA-A', 'XA-B']);
    expect(keysOf(merge, 'after')).toEqual(['XA-Y']);
    expect(within(merge).getByText('MERGE').getAttribute('data-kind')).toBe('MERGE');
    expect(within(merge).getByText(vi_['mdm.value.successionKind.merge'])).toBeTruthy();
    const abolish = connectors().find((row) => row.getAttribute('data-connector') === 'ABOLISH_LEVEL') as HTMLElement;
    expect(keysOf(abolish, 'before')).toEqual(['HUYEN-X']);
    expect(keysOf(abolish, 'after')).toEqual(['TINH-X']);
    expect(screen.getByTestId('unchanged').textContent).toBe(text(vi_['mdm.succession.unchanged.text'], { count: 0 }));
  });

  it('reads the structure of the day before and of the date, and the successions of the entries that ended', async () => {
    const h = client(reform());
    mount(<SuccessionScreen route={ROUTE} />, h, READER, '/mdm/mdm-37');
    await waitFor(() => expect(connectors()).toHaveLength(2));
    expect(h.read).toHaveBeenCalledWith('getMasterRecordSuccessors', { path: { id: COMMUNE_A.id }, query: { date: '2025-07-01' } });
    expect(h.read).toHaveBeenCalledWith('getMasterRecordSuccessors', { path: { id: DISTRICT.id }, query: { date: '2025-07-01' } });
    // The province stands on both days: it needs no read of its successors.
    expect(h.read).not.toHaveBeenCalledWith('getMasterRecordSuccessors', { path: { id: PROVINCE.id }, query: { date: '2025-07-01' } });
    const searched = (h.client.readAll as unknown as { mock: { calls: Array<[string, { query: Record<string, string> }]> } }).mock.calls.filter(([operation]) => operation === 'searchMasterRecords').map(([, input]) => input.query.as_of);
    expect(searched).toEqual(expect.arrayContaining(['2025-06-30', '2025-07-01']));
  });

  it('moves the columns with the date picker, and says when no succession takes effect on the date', async () => {
    mount(<SuccessionScreen route={ROUTE} />, client(reform()), READER, '/mdm/mdm-37');
    await waitFor(() => expect(connectors()).toHaveLength(2));
    fireEvent.change(screen.getByLabelText(vi_['mdm.succession.date.label']), { target: { value: '2025-08-01' } });
    expect(await screen.findByTestId('no-succession')).toBeTruthy();
    expect(screen.getByTestId('no-succession').textContent).toBe(text(vi_['mdm.succession.tree.empty.text'], { date: '2025-08-01' }));
    expect(screen.getByRole('heading', { level: 2, name: text(vi_['mdm.succession.after.title'], { date: '2025-08-01' }) })).toBeTruthy();
    expect(connectors()).toHaveLength(0);
    // The five entries stand across that day: nothing changed, all are counted as unchanged.
    expect(screen.getByTestId('unchanged').textContent).toBe(text(vi_['mdm.succession.unchanged.text'], { count: 5 }));
    fireEvent.change(screen.getByLabelText(vi_['mdm.succession.date.label']), { target: { value: '2025-07-01' } });
    await waitFor(() => expect(connectors()).toHaveLength(2));
  });

  it('refuses a date that is not a date and keeps the last structure', async () => {
    mount(<SuccessionScreen route={ROUTE} />, client(reform()), READER, '/mdm/mdm-37');
    await waitFor(() => expect(connectors()).toHaveLength(2));
    fireEvent.change(screen.getByLabelText(vi_['mdm.succession.date.label']), { target: { value: '2025-02-30' } });
    expect(screen.getByText(vi_['mdm.field.invalidDate.error'])).toBeTruthy();
    expect(connectors()).toHaveLength(2);
  });

  it('switches the catalogue type and reads that type', async () => {
    const h = client(reform());
    mount(<SuccessionScreen route={ROUTE} />, h, READER, '/mdm/mdm-37');
    await waitFor(() => expect(connectors()).toHaveLength(2));
    fireEvent.change(screen.getByLabelText(vi_['mdm.succession.type.label']), { target: { value: 'AGENCY' } });
    expect(await screen.findByTestId('no-succession')).toBeTruthy();
    const types = (h.client.readAll as unknown as { mock: { calls: Array<[string, { query?: Record<string, string> }]> } }).mock.calls.map(([, input]) => input.query?.master_type);
    expect(types).toContain('AGENCY');
  });

  it('says that the structure could not be read, with a retry', async () => {
    const state = reform({ failing: new Set(['getMasterRecordSuccessors']) });
    mount(<SuccessionScreen route={ROUTE} />, client(state), READER, '/mdm/mdm-37');
    expect(await screen.findByRole('alert')).toBeTruthy();
    state.failing = new Set();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(connectors()).toHaveLength(2));
  });

  it('lists the successions that wait for a decision, with their successors and status', async () => {
    const waiting = change(7, {
      change_kind: 'SUCCESSION',
      master_type: 'AREA',
      business_key: 'XA-A',
      status: 'IN_REVIEW',
      effective_from: '2025-07-01',
      proposed: { succession_kind: 'SPLIT', effective_date: '2025-07-01', legal_basis: 'x', edges: [{ successor_record_id: MERGED.id, share_pct: '60.00' }] },
    });
    const other = change(8, { change_kind: 'UPDATE', master_type: 'AREA', status: 'IN_REVIEW' });
    mount(<SuccessionScreen route={ROUTE} />, client(reform({ changes: [waiting, other] })), READER, '/mdm/mdm-37');
    const row = await waitFor(() => {
      const found = document.querySelector(`tr[data-change-id="${waiting.id}"]`);
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    expect(row.textContent).toContain('XA-A');
    expect(row.textContent).toContain('XA-Y (60.00%)');
    expect(row.textContent).toContain(vi_['mdm.value.successionKind.split']);
    expect(document.querySelector(`tr[data-change-id="${other.id}"]`)).toBeNull();
  });
});

describe('SuccessionScreen: recording a succession', () => {
  const fill = (label: string, value: string): void => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  };
  const form = () => screen.getByRole('form', { name: vi_['mdm.succession.form.aria'] });
  const answer = (id: string, version = 1) => ({ operation_id: 'o', status: 'DRAFT', resource_version: version, resource_id: id });
  const DRAFT = change(9, {
    change_kind: 'SUCCESSION',
    master_type: 'AREA',
    business_key: 'XA-A',
    status: 'DRAFT',
    version: 1,
    proposed: { succession_kind: 'MERGE', effective_date: '2025-07-01', legal_basis: 'x', edges: [{ successor_record_id: MERGED.id, share_pct: null }] },
  });

  async function waitForForm(): Promise<void> {
    await ready();
    await screen.findByRole('form', { name: vi_['mdm.succession.form.aria'] });
    await waitFor(() => expect(within(form()).getAllByRole('option').length).toBeGreaterThan(5));
  }

  it('checks the form before it asks the server, and names each fault', async () => {
    const h = client(reform());
    mount(<SuccessionScreen route={ROUTE} />, h, STEWARD, '/mdm/mdm-37');
    await waitForForm();
    const user = userEvent.setup();
    await user.click(within(form()).getByRole('button', { name: vi_['mdm.succession.save.action'] }));
    expect(within(form()).getAllByText(vi_['mdm.field.required.error']).length).toBeGreaterThanOrEqual(4);
    fill(vi_['mdm.succession.predecessor.label'], COMMUNE_A.id);
    fill(vi_['mdm.succession.successor.label'], COMMUNE_A.id);
    fill(vi_['mdm.succession.basis.label'], 'ab');
    fill(vi_['mdm.succession.reason.label'], 'abc');
    await user.click(within(form()).getByRole('button', { name: vi_['mdm.succession.save.action'] }));
    expect(within(form()).getByText(vi_['mdm.succession.sameEntry.error'])).toBeTruthy();
    expect(within(form()).getAllByText(vi_['mdm.field.tooShort.error'])).toHaveLength(2);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('records a merge as a draft, shows what it touches, and sends it to review after the impact was read (AC-ST-MDM-009-1)', async () => {
    const h = client(reform({ changes: [DRAFT] }), (operation) => (operation === 'recordMasterSuccession' ? answer(DRAFT.id) : { operation_id: 'o', status: 'IN_REVIEW', resource_version: 2, resource_id: DRAFT.id }));
    mount(<SuccessionScreen route={ROUTE} />, h, STEWARD, '/mdm/mdm-37');
    await waitForForm();
    const user = userEvent.setup();
    fill(vi_['mdm.succession.predecessor.label'], COMMUNE_A.id);
    fill(vi_['mdm.succession.successor.label'], MERGED.id);
    fill(vi_['mdm.succession.basis.label'], '  Resolution of the 2025 reform  ');
    fill(vi_['mdm.succession.reason.label'], 'Recorded after the reform');
    // A share is asked for a split only.
    expect(screen.queryByLabelText(vi_['mdm.succession.shareField.label'])).toBeNull();
    await user.click(within(form()).getByRole('button', { name: vi_['mdm.succession.save.action'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'recordMasterSuccession',
        expect.objectContaining({
          body: { predecessor_record_id: COMMUNE_A.id, successor_record_id: MERGED.id, succession_kind: 'MERGE', effective_date: '2025-07-01', legal_basis: 'Resolution of the 2025 reform', reason: 'Recorded after the reform' },
        }),
      ),
    );
    expect(await screen.findByTestId('succession-saved')).toBeTruthy();
    const impact = await screen.findByTestId('impact');
    expect(impact.getAttribute('data-impact-total')).toBe('2');
    // Nothing is sent before the impact is read.
    const send = screen.getByRole('button', { name: vi_['mdm.impact.submit.action'] });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByLabelText(vi_['mdm.impact.read.label']));
    await user.click(send);
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('submitMasterChangeRequest', expect.objectContaining({ path: { id: DRAFT.id }, ifMatchVersion: 1 })));
    expect(await screen.findByTestId('succession-submitted')).toBeTruthy();
  });

  it('asks for a share only for a split, refuses a share that is not one, and offers the next successor after the first is saved', async () => {
    const h = client(reform({ changes: [DRAFT] }), () => answer(DRAFT.id));
    mount(<SuccessionScreen route={ROUTE} />, h, STEWARD, '/mdm/mdm-37');
    await waitForForm();
    const user = userEvent.setup();
    fill(vi_['mdm.succession.kind.label'], 'SPLIT');
    fill(vi_['mdm.succession.predecessor.label'], COMMUNE_A.id);
    fill(vi_['mdm.succession.successor.label'], MERGED.id);
    fill(vi_['mdm.succession.basis.label'], 'Resolution of the 2025 reform');
    fill(vi_['mdm.succession.reason.label'], 'Recorded after the reform');
    await user.click(within(form()).getByRole('button', { name: vi_['mdm.succession.save.action'] }));
    expect(within(form()).getByText(vi_['mdm.field.required.error'])).toBeTruthy();
    fill(vi_['mdm.succession.shareField.label'], '100');
    await user.click(within(form()).getByRole('button', { name: vi_['mdm.succession.save.action'] }));
    expect(within(form()).getByText(vi_['mdm.succession.invalidShare.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fill(vi_['mdm.succession.shareField.label'], '60.5');
    await user.click(within(form()).getByRole('button', { name: vi_['mdm.succession.save.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('recordMasterSuccession', expect.objectContaining({ body: expect.objectContaining({ succession_kind: 'SPLIT', share_pct: '60.5' }) })));
    // The split stays open for its next successor: the receiving entry and the share are typed again, the rest stays.
    await user.click(await screen.findByTestId('add-another'));
    expect((screen.getByLabelText(vi_['mdm.succession.successor.label']) as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText(vi_['mdm.succession.shareField.label']) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(vi_['mdm.succession.predecessor.label']) as HTMLSelectElement).value).toBe(COMMUNE_A.id);
  });

  it('shows the refusal of the server for a ring and for an unknown field, and writes nothing more (AC-ST-MDM-009-3)', async () => {
    const h = client(reform(), () => problem('SUCCESSION_CYCLE'));
    mount(<SuccessionScreen route={ROUTE} />, h, STEWARD, '/mdm/mdm-37');
    await waitForForm();
    fill(vi_['mdm.succession.predecessor.label'], COMMUNE_A.id);
    fill(vi_['mdm.succession.successor.label'], MERGED.id);
    fill(vi_['mdm.succession.basis.label'], 'Resolution of the 2025 reform');
    fill(vi_['mdm.succession.reason.label'], 'Recorded after the reform');
    await userEvent.setup().click(within(form()).getByRole('button', { name: vi_['mdm.succession.save.action'] }));
    expect((await screen.findByTestId('record-problem')).textContent).toBe(vi_['mdm.problem.successionCycle.error']);
    expect(screen.queryByTestId('succession-saved')).toBeNull();
  });

  it('offers no form to someone who may only read, and none while the tenant is frozen', async () => {
    mount(<SuccessionScreen route={ROUTE} />, client(reform()), READER, '/mdm/mdm-37');
    await ready();
    const read = await screen.findByRole('form', { name: vi_['mdm.succession.form.aria'] });
    expect(within(read).queryByRole('button', { name: vi_['mdm.succession.save.action'] })).toBeNull();
    expect(within(read).getByText(vi_['mdm.readOnly.denied.notice'])).toBeTruthy();
  });
});
