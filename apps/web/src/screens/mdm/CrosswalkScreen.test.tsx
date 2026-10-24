import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { mountInSession } from '../adm/security/test-support';
import CrosswalkScreen from './CrosswalkScreen';
import { CROSSWALK_MANAGER, READER, client, crosswalk, cursor, mount, record, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('MDM-24', 'FR-MDM-24');
const problem = (code: string, status = 409, detail?: string) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });
const ALL = [...CROSSWALK_MANAGER, 'integration.cursor.reset'];

afterEach(cleanup);

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-crosswalk-id]'));
const codes = (): string[] => rows().map((row) => row.getAttribute('data-external-code') ?? '');
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));
const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

const MAPPINGS = [
  crosswalk(1),
  crosswalk(2, { source_system: 'NATIONAL_PIM', external_type: 'PROJECT_CODE', external_code: 'PIM-2' }),
  crosswalk(3, { status: 'RETIRED', valid_until: '2025-12-31', match_method: 'IMPORT' }),
];
const mapped = (overrides: Partial<World> = {}): World => world({ crosswalks: MAPPINGS, ...overrides });

describe('CrosswalkScreen (MDM-24): the mappings of codes', () => {
  it('lists each mapping with its system, code type, external and internal code, validity, method and status', async () => {
    mount(<CrosswalkScreen route={ROUTE} />, client(mapped()), READER, '/mdm/mdm-24');
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['mdm.crosswalk.page.title']);
    expect(codes()).toEqual(['KB-1', 'PIM-2', 'KB-3']);
    const cells = (code: string) => Array.from(document.querySelectorAll(`tr[data-external-code="${code}"] td`)).map((cell) => cell.textContent);
    expect(cells('KB-3').slice(0, 7)).toEqual(['TREASURY', 'AGENCY_CODE', 'KB-3', 'GT-3 · SECTOR', '2024-01-01 → 2025-12-31', vi_['mdm.crosswalk.method.import.text'], vi_['mdm.crosswalk.status.retired.text']]);
    expect(screen.getByTestId('count').textContent).toBe(vi_['mdm.crosswalk.count.text'].replace('{count}', '3'));
    expect(screen.getByRole('table', { name: vi_['mdm.crosswalk.table.aria'] })).toBeTruthy();
  });

  it('filters by system, code type, code and status, and says when nothing matches or nothing exists', async () => {
    mount(<CrosswalkScreen route={ROUTE} />, client(mapped()), READER, '/mdm/mdm-24');
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['mdm.crosswalk.filter.system.label']), { target: { value: 'NATIONAL_PIM' } });
    expect(codes()).toEqual(['PIM-2']);
    // The code types on offer are those of the chosen system.
    expect(within(screen.getByLabelText(vi_['mdm.crosswalk.filter.type.label'])).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['mdm.crosswalk.filter.all.option'], 'PROJECT_CODE']);
    fireEvent.change(screen.getByLabelText(vi_['mdm.crosswalk.filter.system.label']), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(vi_['mdm.crosswalk.filter.type.label']), { target: { value: 'AGENCY_CODE' } });
    expect(codes()).toEqual(['KB-1', 'KB-3']);
    fireEvent.change(screen.getByLabelText(vi_['mdm.crosswalk.filter.status.label']), { target: { value: 'ACTIVE' } });
    expect(codes()).toEqual(['KB-1']);
    fireEvent.change(screen.getByLabelText(vi_['mdm.crosswalk.filter.code.label']), { target: { value: 'gt-1' } });
    expect(codes()).toEqual(['KB-1']);
    fireEvent.change(screen.getByLabelText(vi_['mdm.crosswalk.filter.code.label']), { target: { value: 'nothing' } });
    expect(screen.getByTestId('empty-crosswalk').textContent).toBe(vi_['mdm.crosswalk.noMatch.text']);
    cleanup();
    mount(<CrosswalkScreen route={ROUTE} />, client(world()), READER, '/mdm/mdm-24');
    expect(await screen.findByTestId('empty-crosswalk')).toBeTruthy();
    expect(screen.getByTestId('empty-crosswalk').textContent).toBe(vi_['mdm.crosswalk.empty.text']);
  });

  it('says that the mappings could not be read, with a retry', async () => {
    const state = mapped({ failing: new Set(['listMasterCrosswalks']) });
    mount(<CrosswalkScreen route={ROUTE} />, client(state), READER, '/mdm/mdm-24');
    expect(await screen.findByRole('alert')).toBeTruthy();
    state.failing = new Set();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await ready();
    expect(codes().length).toBe(3);
  });
});

describe('CrosswalkScreen: retiring a mapping', () => {
  it('asks for a reason, then ends the mapping with the version that was read', async () => {
    const h = client(mapped(), () => ({ operation_id: 'o', status: 'RETIRED', resource_version: 2, resource_id: MAPPINGS[0]?.id }));
    mount(<CrosswalkScreen route={ROUTE} />, h, CROSSWALK_MANAGER, '/mdm/mdm-24');
    await ready();
    const user = userEvent.setup();
    // A retired mapping has nothing to retire.
    expect(within(document.querySelector('tr[data-external-code="KB-3"]') as HTMLElement).queryByRole('button')).toBeNull();
    await user.click(within(document.querySelector('tr[data-external-code="KB-1"]') as HTMLElement).getByRole('button', { name: vi_['mdm.crosswalk.retire.action'] }));
    const form = screen.getByRole('form', { name: vi_['mdm.crosswalk.retire.title'].replace('{code}', 'KB-1') });
    await user.click(within(form).getByRole('button', { name: vi_['mdm.crosswalk.retire.confirm.action'] }));
    expect(within(form).getByText(vi_['mdm.field.required.error'])).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(vi_['mdm.crosswalk.retire.reason.label']), { target: { value: 'ab' } });
    await user.click(within(form).getByRole('button', { name: vi_['mdm.crosswalk.retire.confirm.action'] }));
    expect(within(form).getByText(vi_['mdm.field.tooShort.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['mdm.crosswalk.retire.reason.label']), { target: { value: 'Mapped to the wrong office' } });
    await user.click(within(form).getByRole('button', { name: vi_['mdm.crosswalk.retire.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('retireMasterCrosswalk', expect.objectContaining({ path: { id: MAPPINGS[0]?.id }, body: { reason: 'Mapped to the wrong office' }, ifMatchVersion: 1 })));
    await waitFor(() => expect(screen.queryByRole('form', { name: vi_['mdm.crosswalk.retire.title'].replace('{code}', 'KB-1') })).toBeNull());
  });

  it('shows the refusal of the server and lets the person cancel', async () => {
    const h = client(mapped(), () => problem('VERSION_CONFLICT'));
    mount(<CrosswalkScreen route={ROUTE} />, h, CROSSWALK_MANAGER, '/mdm/mdm-24');
    await ready();
    const user = userEvent.setup();
    await user.click(within(document.querySelector('tr[data-external-code="KB-1"]') as HTMLElement).getByRole('button', { name: vi_['mdm.crosswalk.retire.action'] }));
    const form = screen.getByRole('form', { name: vi_['mdm.crosswalk.retire.title'].replace('{code}', 'KB-1') });
    fireEvent.change(within(form).getByLabelText(vi_['mdm.crosswalk.retire.reason.label']), { target: { value: 'Mapped to the wrong office' } });
    await user.click(within(form).getByRole('button', { name: vi_['mdm.crosswalk.retire.confirm.action'] }));
    expect((await within(form).findByRole('alert')).textContent).toBe(vi_['mdm.problem.versionConflict.error']);
    await user.click(within(form).getByRole('button', { name: vi_['mdm.crosswalk.cancel.action'] }));
    expect(screen.queryByRole('form', { name: vi_['mdm.crosswalk.retire.title'].replace('{code}', 'KB-1') })).toBeNull();
  });

  it('offers nothing to retire to someone without the permission, or while the tenant is suspended', async () => {
    mount(<CrosswalkScreen route={ROUTE} />, client(mapped()), READER, '/mdm/mdm-24');
    await ready();
    expect(screen.queryByRole('button', { name: vi_['mdm.crosswalk.retire.action'] })).toBeNull();
    expect(screen.queryByRole('form', { name: vi_['mdm.crosswalk.form.aria'] })).toBeNull();
    cleanup();
    mountInSession(<CrosswalkScreen route={ROUTE} />, client(mapped()), { permissions: ALL, mode: 'READ_ONLY' });
    await ready();
    expect(screen.queryByRole('button', { name: vi_['mdm.crosswalk.retire.action'] })).toBeNull();
    expect(screen.queryByRole('form', { name: vi_['mdm.crosswalk.form.aria'] })).toBeNull();
  });
});

describe('CrosswalkScreen: adding a mapping', () => {
  const fill = (overrides: Record<string, string> = {}): void => {
    const values: Record<string, string> = {
      [vi_['mdm.crosswalk.form.masterType.label']]: 'SECTOR',
      [vi_['mdm.crosswalk.form.businessKey.label']]: 'GT-1',
      [vi_['mdm.crosswalk.form.system.label']]: ' TREASURY ',
      [vi_['mdm.crosswalk.form.type.label']]: 'AGENCY_CODE',
      [vi_['mdm.crosswalk.form.code.label']]: 'KB-NEW',
      [vi_['mdm.crosswalk.form.validFrom.label']]: '2026-01-01',
      ...overrides,
    };
    for (const [label, value] of Object.entries(values)) set(label, value);
  };
  const save = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: vi_['mdm.crosswalk.save.action'] }));

  it('names the fields that are missing, and sends nothing until the form is right', async () => {
    const h = client(mapped());
    mount(<CrosswalkScreen route={ROUTE} />, h, CROSSWALK_MANAGER, '/mdm/mdm-24');
    await ready();
    const user = userEvent.setup();
    await save(user);
    expect(screen.getAllByText(vi_['mdm.field.required.error']).length).toBe(6);
    fill({ [vi_['mdm.crosswalk.form.code.label']]: 'x'.repeat(101) });
    await save(user);
    expect(screen.getByText(vi_['mdm.field.tooLong.error'])).toBeTruthy();
    expect(screen.queryByText(vi_['mdm.field.required.error'])).toBeNull();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('finds the entry by its type and key, sends the mapping with the trimmed names, and clears the form', async () => {
    const h = client(mapped(), () => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: 'new' }));
    mount(<CrosswalkScreen route={ROUTE} />, h, CROSSWALK_MANAGER, '/mdm/mdm-24');
    await ready();
    const user = userEvent.setup();
    fill();
    await save(user);
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'createMasterCrosswalk',
        expect.objectContaining({ body: { master_record_id: record(1).id, source_system: 'TREASURY', external_type: 'AGENCY_CODE', external_code: 'KB-NEW', valid_from: '2026-01-01', match_method: 'MANUAL' } }),
      ),
    );
    expect((await screen.findByTestId('crosswalk-saved')).textContent).toBe(vi_['mdm.crosswalk.saved.notice']);
    expect((screen.getByLabelText(vi_['mdm.crosswalk.form.code.label']) as HTMLInputElement).value).toBe('');
  });

  it('prefers the entry of the tenant, and offers the method it was matched by', async () => {
    const state = mapped({ records: [record(1, { namespace: 'PLATFORM', id: '00000000-0000-4000-8000-0000000000c1' }), record(1)] });
    const h = client(state, () => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: 'new' }));
    mount(<CrosswalkScreen route={ROUTE} />, h, CROSSWALK_MANAGER, '/mdm/mdm-24');
    await ready();
    fill();
    set(vi_['mdm.crosswalk.form.method.label'], 'RULE');
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['mdm.crosswalk.save.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('createMasterCrosswalk', expect.objectContaining({ body: expect.objectContaining({ master_record_id: record(1).id, match_method: 'RULE' }) })));
  });

  it('says that the entry was not found instead of sending, and that the lookup failed when it cannot be read', async () => {
    const state = mapped();
    const h = client(state);
    mount(<CrosswalkScreen route={ROUTE} />, h, CROSSWALK_MANAGER, '/mdm/mdm-24');
    await ready();
    const user = userEvent.setup();
    fill({ [vi_['mdm.crosswalk.form.businessKey.label']]: 'NOPE' });
    await save(user);
    expect((await screen.findByRole('alert')).textContent).toBe(vi_['mdm.problem.notFound.error']);
    expect(h.command).not.toHaveBeenCalled();
    // Typing again clears the notice; a lookup that fails is the general message.
    fill();
    state.failing = new Set(['searchMasterRecords']);
    await save(user);
    expect((await screen.findByRole('alert')).textContent).toBe(vi_['mdm.problem.general.error']);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('shows a second ACTIVE mapping of the same code as the refusal of the server (AC-ST-MDM-007-1)', async () => {
    const h = client(mapped(), () => problem('CROSSWALK_DUPLICATE'));
    mount(<CrosswalkScreen route={ROUTE} />, h, CROSSWALK_MANAGER, '/mdm/mdm-24');
    await ready();
    fill({ [vi_['mdm.crosswalk.form.code.label']]: 'KB-1' });
    await save(userEvent.setup());
    expect((await screen.findByRole('alert')).textContent).toBe(vi_['mdm.problem.duplicateCrosswalk.error']);
    expect(screen.queryByTestId('crosswalk-saved')).toBeNull();
  });
});

describe('CrosswalkScreen: the integration connectors', () => {
  const CONNECTORS = [
    cursor(1, { connector_code: 'NATIONAL_PIM_FILE', adapter_status: 'PROPOSED', cursor_json: { after: '2026-01-01' }, version: 3 }),
    cursor(2, { connector_code: 'TREASURY_STATEMENT_FILE', adapter_status: 'VERIFIED', status: 'FAILED', last_error_code: 'FILE_REJECTED', last_success_at: '2026-10-01T00:00:00.000000Z', cursor_json: {} }),
    cursor(3, { connector_code: 'PROCUREMENT_FILE', adapter_status: 'MOCK', status: 'PAUSED', cursor_json: {} }),
    cursor(4, { connector_code: 'BUDGET_CODE_FILE', adapter_status: 'MISSING', cursor_json: {} }),
  ];
  const connectors = (overrides: Partial<World> = {}): World => mapped({ cursors: CONNECTORS, ...overrides });
  const cursorRow = (connector: string) => document.querySelector(`tr[data-connector="${connector}"]`) as HTMLElement;

  it('shows where each connector stands, with a badge that says whether its adapter is verified', async () => {
    mount(<CrosswalkScreen route={ROUTE} />, client(connectors()), CROSSWALK_MANAGER, '/mdm/mdm-24');
    await ready();
    await screen.findByRole('table', { name: vi_['mdm.cursor.table.aria'] });
    expect(within(cursorRow('NATIONAL_PIM_FILE')).getByText(vi_['mdm.cursor.adapter.proposed.pill']).className).toContain('gray');
    expect(within(cursorRow('TREASURY_STATEMENT_FILE')).getByText(vi_['mdm.cursor.adapter.verified.pill']).className).toContain('green');
    expect(within(cursorRow('PROCUREMENT_FILE')).getByText(vi_['mdm.cursor.adapter.mock.pill'])).toBeTruthy();
    expect(within(cursorRow('BUDGET_CODE_FILE')).getByText(vi_['mdm.cursor.adapter.missing.pill'])).toBeTruthy();
    expect(within(cursorRow('TREASURY_STATEMENT_FILE')).getByText(vi_['mdm.cursor.status.failed.text'])).toBeTruthy();
    expect(within(cursorRow('TREASURY_STATEMENT_FILE')).getByText('FILE_REJECTED')).toBeTruthy();
    expect(within(cursorRow('PROCUREMENT_FILE')).getByText(vi_['mdm.cursor.status.paused.text'])).toBeTruthy();
    expect(within(cursorRow('NATIONAL_PIM_FILE')).getByText(vi_['mdm.cursor.never.text'])).toBeTruthy();
    expect(within(cursorRow('TREASURY_STATEMENT_FILE')).getByText('2026-10-01T00:00:00.000000Z')).toBeTruthy();
    expect(within(cursorRow('NATIONAL_PIM_FILE')).getByText(vi_['mdm.cursor.status.active.text'])).toBeTruthy();
  });

  it('shows nothing of the connectors to someone who may not read them, and says so when there is none or they cannot be read', async () => {
    const h = client(connectors());
    mount(<CrosswalkScreen route={ROUTE} />, h, READER, '/mdm/mdm-24');
    await ready();
    expect(screen.queryByTestId('connectors')).toBeNull();
    expect(h.client.readAll).not.toHaveBeenCalledWith('get_resources_integration_cursor');
    cleanup();
    mount(<CrosswalkScreen route={ROUTE} />, client(mapped()), CROSSWALK_MANAGER, '/mdm/mdm-24');
    await ready();
    expect((await screen.findByTestId('empty-connectors')).textContent).toBe(vi_['mdm.cursor.empty.text']);
    cleanup();
    mount(<CrosswalkScreen route={ROUTE} />, client(connectors({ failing: new Set(['get_resources_integration_cursor']) })), CROSSWALK_MANAGER, '/mdm/mdm-24');
    await ready();
    const section = await screen.findByTestId('connectors');
    await waitFor(() => expect(within(section).getByRole('alert').textContent).toBe(vi_['mdm.cursor.read.error']));
    expect(within(section).queryByTestId('empty-connectors')).toBeNull();
    // The mappings are still there.
    expect(codes().length).toBe(3);
  });

  it('moves the position only for a stated reason, from the position it read, with the version it read (AC-ST-MDM-007-2)', async () => {
    const h = client(connectors(), () => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 4, resource_id: CONNECTORS[0]?.id }));
    mount(<CrosswalkScreen route={ROUTE} />, h, ALL, '/mdm/mdm-24');
    await ready();
    const user = userEvent.setup();
    await user.click(within(await waitFor(() => cursorRow('NATIONAL_PIM_FILE'))).getByRole('button', { name: vi_['mdm.cursor.reset.action'] }));
    const form = await screen.findByTestId('reset-form');
    const position = within(form).getByLabelText(vi_['mdm.cursor.reset.position.label']) as HTMLTextAreaElement;
    await waitFor(() => expect(JSON.parse(position.value)).toEqual({ after: '2026-01-01' }));
    await user.click(within(form).getByRole('button', { name: vi_['mdm.cursor.reset.submit.action'] }));
    expect(within(form).getByText(vi_['mdm.field.required.error'])).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(vi_['mdm.cursor.reset.reason.label']), { target: { value: 'too short' } });
    fireEvent.change(position, { target: { value: '[1, 2]' } });
    await user.click(within(form).getByRole('button', { name: vi_['mdm.cursor.reset.submit.action'] }));
    expect(within(form).getByText(vi_['mdm.field.tooShort.error'])).toBeTruthy();
    expect(within(form).getByText(vi_['mdm.field.invalidJson.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['mdm.cursor.reset.reason.label']), { target: { value: 'Re-read the file of March' } });
    fireEvent.change(position, { target: { value: '{"after": "2026-03-01"}' } });
    await user.click(within(form).getByRole('button', { name: vi_['mdm.cursor.reset.submit.action'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith('resetIntegrationCursor', expect.objectContaining({ path: { id: CONNECTORS[0]?.id }, body: { reason: 'Re-read the file of March', cursor_json: { after: '2026-03-01' } }, ifMatchVersion: 3 })),
    );
    await waitFor(() => expect(screen.queryByTestId('reset-form')).toBeNull());
  });

  it('sends an empty position for an empty text, shows the refusal of the server and lets the person cancel', async () => {
    const h = client(connectors(), () => problem('PERMISSION_DENIED', 403));
    mount(<CrosswalkScreen route={ROUTE} />, h, ALL, '/mdm/mdm-24');
    await ready();
    const user = userEvent.setup();
    await user.click(within(await waitFor(() => cursorRow('TREASURY_STATEMENT_FILE'))).getByRole('button', { name: vi_['mdm.cursor.reset.action'] }));
    const form = await screen.findByTestId('reset-form');
    await waitFor(() => expect((within(form).getByLabelText(vi_['mdm.cursor.reset.position.label']) as HTMLTextAreaElement).value).toBe('{}'));
    fireEvent.change(within(form).getByLabelText(vi_['mdm.cursor.reset.position.label']), { target: { value: '' } });
    fireEvent.change(within(form).getByLabelText(vi_['mdm.cursor.reset.reason.label']), { target: { value: 'Start the statements again' } });
    await user.click(within(form).getByRole('button', { name: vi_['mdm.cursor.reset.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('resetIntegrationCursor', expect.objectContaining({ body: { reason: 'Start the statements again', cursor_json: {} }, ifMatchVersion: 1 })));
    expect((await within(form).findByRole('alert')).textContent).toBe(vi_['mdm.problem.denied.error']);
    await user.click(within(form).getByRole('button', { name: vi_['mdm.crosswalk.cancel.action'] }));
    expect(screen.queryByTestId('reset-form')).toBeNull();
    // Opening the same connector twice closes it.
    const toggle = within(cursorRow('TREASURY_STATEMENT_FILE')).getByRole('button', { name: vi_['mdm.cursor.reset.action'] });
    await user.click(toggle);
    expect(await screen.findByTestId('reset-form')).toBeTruthy();
    await user.click(toggle);
    expect(screen.queryByTestId('reset-form')).toBeNull();
  });

  it('says that a connector could not be read for the reset, and offers no reset without the permission', async () => {
    const state = connectors();
    mount(<CrosswalkScreen route={ROUTE} />, client(state), ALL, '/mdm/mdm-24');
    await ready();
    const user = userEvent.setup();
    state.failing = new Set(['get_resources_integration_cursor_id']);
    await user.click(within(await waitFor(() => cursorRow('PROCUREMENT_FILE'))).getByRole('button', { name: vi_['mdm.cursor.reset.action'] }));
    const form = await screen.findByTestId('reset-form');
    await waitFor(() => expect(within(form).getByRole('alert').textContent).toBe(vi_['mdm.cursor.read.error']));
    expect(within(form).getByRole('button', { name: vi_['mdm.cursor.reset.submit.action'] })).toBeDisabled();
    cleanup();
    mount(<CrosswalkScreen route={ROUTE} />, client(connectors()), CROSSWALK_MANAGER, '/mdm/mdm-24');
    await screen.findByRole('table', { name: vi_['mdm.cursor.table.aria'] });
    expect(screen.queryByRole('button', { name: vi_['mdm.cursor.reset.action'] })).toBeNull();
  });

  it('shows the connectors to an operator who may not read the mappings, without asking for the mappings', async () => {
    const h = client(connectors());
    mount(<CrosswalkScreen route={ROUTE} />, h, ['integration.cursor.reset', 'integration_cursor.read'], '/mdm/mdm-24');
    await screen.findByRole('table', { name: vi_['mdm.cursor.table.aria'] });
    expect(screen.queryByRole('table', { name: vi_['mdm.crosswalk.table.aria'] })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(h.client.readAll).not.toHaveBeenCalledWith('listMasterCrosswalks', expect.anything());
    expect(screen.getAllByRole('button', { name: vi_['mdm.cursor.reset.action'] }).length).toBe(4);
  });

  it('starts over when the tenant changes, so a reset of one tenant is never sent to another', async () => {
    const view = mountInSession(<CrosswalkScreen route={ROUTE} />, client(connectors()), { permissions: ALL });
    await ready();
    await userEvent.setup().click(within(await waitFor(() => cursorRow('NATIONAL_PIM_FILE'))).getByRole('button', { name: vi_['mdm.cursor.reset.action'] }));
    await screen.findByTestId('reset-form');
    view.rerenderWith({ permissions: ALL, tenant: { id: '00000000-0000-4000-8000-0000000000bb', name: 'Other', monogram: 'OT', membershipId: '00000000-0000-4000-8000-0000000000bc', theme: { themeId: 'tenant', version: 1, overlay: {} } } });
    expect(screen.queryByTestId('reset-form')).toBeNull();
  });
});
