import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../i18n';
import PortalAdminScreen from './PortalAdminScreen';
import { AS_OF, PORTAL_MANAGER, PORTAL_READER, PROJECT_ID, harness, mount, never, problem, record, routeOf, settings, settingsRead, word } from './test/support';
import type { Harness } from './test/support';

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

const route = routeOf('PRJ-32', 'FR-PRJ-32');
interface World {
  settings: unknown;
  records: unknown;
  export: unknown;
}
const show = (world: Partial<World> = {}, permissions: readonly string[] = PORTAL_MANAGER, command?: (op: string, input: unknown) => unknown): Harness => {
  const state: World = { settings: settingsRead(settings()), records: { as_of: AS_OF, items: [record()], has_more: false }, export: undefined, ...world };
  const h = harness((operation) => {
    if (operation === 'getPortalSettings') return state.settings;
    if (operation === 'listPortalRecords') return state.records;
    if (operation === 'exportPortalOc4ids') return state.export;
    return new Error(`unexpected ${operation}`);
  }, command);
  mount(<PortalAdminScreen route={route} />, h, { permissions });
  return h;
};

describe('PRJ-32, the administration of the public portal', () => {
  it('UI-PRJ-32: shows the settings, the policy copied from the rule with its "i", the public address and the published records', async () => {
    show();
    expect(await screen.findByTestId('policy-fields')).toBeTruthy();
    expect(screen.getByTestId('policy-fields').textContent).toBe('project_code, title, summary');
    expect(screen.getByTestId('policy-rate').textContent).toContain('60');
    expect(screen.getByTestId('public-link').getAttribute('href')).toBe('/public/portals/cao-bang');
    expect((screen.getByTestId('settings-slug') as HTMLInputElement).value).toBe('cao-bang');
    expect(await screen.findByTestId(`record-${PROJECT_ID}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(word('prj.portal.info.policy.name')) }));
    const panel = await screen.findByRole('dialog', { name: word('prj.portal.info.policy.name') });
    expect(within(panel).getByText(word('prj.info.panel.unverified'))).toBeTruthy();
    expect(screen.queryByTestId('policy-stale')).toBeNull();
  });

  it('says that the copy of the policy in the settings is not the rule in force', async () => {
    show({ settings: settingsRead(settings(), { rule: { version: 3, unverified: false, allowed_fields: ['project_code'], rate_per_minute: 30, page_size_max: 50 } }) });
    expect((await screen.findByTestId('policy-stale')).textContent).toBe(word('prj.portalAdmin.policy.stale'));
  });

  it('creates the settings with version 0 and the values that were typed', async () => {
    const h = show({ settings: settingsRead(null), records: { as_of: AS_OF, items: [], has_more: false } }, PORTAL_MANAGER, () => ({ status: 'DISABLED' }));
    await screen.findByText(word('prj.portalAdmin.settings.none'));
    fireEvent.click(screen.getByTestId('settings-save'));
    expect((await screen.findByTestId('message')).textContent).toBe(word('prj.common.error.validationFailed'));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('settings-slug'), { target: { value: 'tinh-b' } });
    fireEvent.change(screen.getByTestId('settings-title'), { target: { value: 'Portal of province B' } });
    fireEvent.change(screen.getByLabelText(word('prj.portalAdmin.settings.publisher')), { target: { value: 'Board of B' } });
    fireEvent.change(screen.getByLabelText(word('prj.portalAdmin.settings.prefix')), { target: { value: 'VN-B' } });
    fireEvent.click(screen.getByTestId('settings-save'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('savePortalSettings', expect.objectContaining({ body: expect.objectContaining({ expected_version: 0, slug: 'tinh-b', title: 'Portal of province B', publisher_name: 'Board of B', id_prefix: 'VN-B', enabled: false }) })));
    expect((await screen.findByTestId('message')).textContent).toBe(word('prj.portalAdmin.receipt.saved'));
  });

  it('says in words that the address belongs to another portal', async () => {
    show({}, PORTAL_MANAGER, () => problem('PORTAL_SLUG_TAKEN', 409));
    await screen.findByTestId('settings-save');
    fireEvent.click(screen.getByTestId('settings-save'));
    expect((await screen.findByTestId('message')).textContent).toBe(word('prj.common.error.portalSlugTaken'));
  });

  it('publishes a project with a plain text description and refuses markup before it asks the server', async () => {
    const h = show({}, PORTAL_MANAGER, () => ({ status: 'CREATED' }));
    fireEvent.click(await screen.findByTestId('publish-open'));
    fireEvent.change(await screen.findByTestId('publish-project'), { target: { value: PROJECT_ID } });
    fireEvent.change(screen.getByTestId('publish-summary'), { target: { value: 'Click <a href="x">here</a> to see more' } });
    fireEvent.click(screen.getByRole('button', { name: word('prj.portalAdmin.publish.confirm') }));
    expect((await screen.findByRole('alert')).textContent).toContain(word('prj.common.error.validationFailed'));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('publish-summary'), { target: { value: 'A road of 12 km that joins two communes.' } });
    fireEvent.click(screen.getByRole('button', { name: word('prj.portalAdmin.publish.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('publishPortalRecord', expect.objectContaining({ body: { project_id: PROJECT_ID, summary: 'A road of 12 km that joins two communes.', sector: 'transport.road', project_type: 'construction', purpose: 'economic' } })));
    expect((await screen.findByTestId('message')).textContent).toBe(word('prj.portalAdmin.receipt.publish.created'));
  });

  it('says why a project cannot be published', async () => {
    show({}, PORTAL_MANAGER, () => problem('PORTAL_NOT_PUBLISHABLE', 422));
    fireEvent.click(await screen.findByTestId('publish-open'));
    fireEvent.change(await screen.findByTestId('publish-project'), { target: { value: PROJECT_ID } });
    fireEvent.change(screen.getByTestId('publish-summary'), { target: { value: 'A road of 12 km that joins two communes.' } });
    fireEvent.click(screen.getByRole('button', { name: word('prj.portalAdmin.publish.confirm') }));
    expect((await screen.findByRole('alert')).textContent).toContain(word('prj.common.error.portalNotPublishable'));
  });

  it('withdraws a record with a reason', async () => {
    const h = show({}, PORTAL_MANAGER, () => ({ status: 'WITHDRAWN' }));
    fireEvent.click(await screen.findByTestId(`withdraw-${PROJECT_ID}`));
    const reason = await screen.findByLabelText(new RegExp(word('prj.portalAdmin.withdraw.reason')));
    fireEvent.change(reason, { target: { value: 'The project is under review' } });
    fireEvent.click(screen.getByRole('button', { name: word('prj.portalAdmin.withdraw.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('withdrawPortalRecord', expect.objectContaining({ body: { reason: 'The project is under review' } })));
    expect((await screen.findByTestId('message')).textContent).toBe(word('prj.portalAdmin.receipt.withdrawn'));
  });

  it('checks the export against the required fields and lists what is missing instead of inventing it', async () => {
    show({ export: { as_of: AS_OF, version: '0.9', required_fields: ['id', 'title', 'budget'], lists: { source: 'x', legal_status: 'UNVERIFIED' }, complete: false, issues: [{ path: 'projects[0].budget', problem: 'MISSING' }], package: { projects: [{ id: 'VN-CB-PRJ-001' }] } } });
    fireEvent.click(await screen.findByTestId('export-check'));
    expect((await screen.findByTestId('export-verdict')).textContent).toBe('Bản xuất còn thiếu hoặc sai 1 chỗ so với chuẩn; hệ thống không bịa giá trị cho trường bị loại khỏi danh sách được phép.');
    expect(screen.getByTestId('export-issues').textContent).toContain('projects[0].budget');
    expect(screen.getByTestId('export-issues').textContent).toContain(word('prj.portal.issue.missing'));
    expect(screen.getByTestId('export-lists').textContent).toContain(word('prj.portalAdmin.export.unverified'));
    expect(screen.getByTestId('export-download').getAttribute('href')).toContain('data:application/json');
  });

  it('says that the export is complete when it is', async () => {
    show({ export: { as_of: AS_OF, version: '0.9', required_fields: ['id'], lists: { source: 'x', legal_status: 'UNVERIFIED' }, complete: true, issues: [], package: { projects: [{ id: 'a' }, { id: 'b' }] } } });
    fireEvent.click(await screen.findByTestId('export-check'));
    expect((await screen.findByTestId('export-verdict')).textContent).toContain('2');
    expect(screen.queryByTestId('export-issues')).toBeNull();
  });

  it('shows a reader the portal without any change button', async () => {
    show({}, PORTAL_READER);
    await screen.findByTestId('policy-fields');
    for (const id of ['settings-save', 'publish-open', `withdraw-${PROJECT_ID}`]) expect(screen.queryByTestId(id)).toBeNull();
    expect((screen.getByTestId('settings-slug') as HTMLInputElement).disabled).toBe(true);
  });

  it('shows the loading, error and denied states, and an empty list of records', async () => {
    const loading = harness(() => never());
    mount(<PortalAdminScreen route={route} />, loading, { permissions: PORTAL_MANAGER });
    expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
    cleanup();
    const failing = harness(() => problem('INTERNAL_ERROR', 500));
    mount(<PortalAdminScreen route={route} />, failing, { permissions: PORTAL_MANAGER });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    const denied = harness(() => problem('SCOPE_DENIED', 403));
    mount(<PortalAdminScreen route={route} />, denied, { permissions: PORTAL_MANAGER });
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    cleanup();
    show({ records: { as_of: AS_OF, items: [], has_more: false } });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
  });
});
