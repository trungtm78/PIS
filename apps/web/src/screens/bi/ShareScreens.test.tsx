import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import DashboardLibraryScreen from './DashboardLibraryScreen';
import DashboardShareScreen from './DashboardShareScreen';
import { toDashboard } from './dashboard-model';
import { EMPTY_SHARE, describeShareProblem, shareBody, toShare, validateShare } from './share-model';

const SHARE = routeOf('BI-17', 'FR-BI-17');
const LIBRARY = routeOf('BI-01', 'FR-BI-01');
const MAY = ['bi.dashboard.share', 'bi.query', 'dashboard_version.read'];
const ME = '00000000-0000-4000-8000-000000000001'; // the member of the session of the test support
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const D1 = '00000000-0000-4000-8000-0000000000e1';
const D2 = '00000000-0000-4000-8000-0000000000e2';
const S1 = '00000000-0000-4000-8000-0000000000a1';
const S2 = '00000000-0000-4000-8000-0000000000a2';
const GRANTEE = '00000000-0000-4000-8000-0000000000b1';
const failure = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });

const share = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  dashboard_id: D1,
  grantee_kind: 'USER',
  grantee_ref_id: GRANTEE,
  grantee_name: 'Nhân viên',
  permission: 'VIEW',
  status: 'ACTIVE',
  revoked_at: null,
  created_at: '2026-11-01T01:00:00.000Z',
  created_by: ME,
  version: 1,
  ...overrides,
});
const dashboard = (id: string, code: string, overrides: Record<string, unknown> = {}) => ({
  id,
  code,
  title: `Dashboard ${code}`,
  owner: { id: ME, name: 'Tôi' },
  audience: 'SHARED',
  status: 'PUBLISHED',
  current_version: null,
  mine: true,
  may_edit: true,
  permission: 'OWNER',
  version: 4,
  versions: [],
  shares: [share(S1), share(S2, { grantee_kind: 'UNIT', grantee_name: null, grantee_ref_id: OTHER, permission: 'EDIT', status: 'REVOKED', revoked_at: '2026-11-02T00:00:00.000Z' })],
  ...overrides,
});

interface World {
  dashboards?: unknown[] | Error;
  one?: Record<string, unknown> | Error;
}

function client(world: World, command: (operation: string, input: unknown) => unknown = () => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: S1, dashboard_version: 5 })) {
  const h = harness((operation) => (operation === 'getDashboard' ? (world.one ?? new Error('unexpected read')) : new Error(`unexpected read ${operation}`)), command);
  const readAll = vi.fn((operation: string) => {
    const result = operation === 'listDashboards' ? (world.dashboards ?? [dashboard(D1, 'D-ONE')]) : new Error(`unexpected readAll ${operation}`);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}
const address = `/bi/bi-17?dashboard=${D1}`;
const open = (world: World = {}, command?: (operation: string, input: unknown) => unknown, permissions: readonly string[] | undefined = MAY, mode?: 'READ_ONLY') => {
  const h = client({ one: dashboard(D1, 'D-ONE'), ...world }, command);
  mount(<DashboardShareScreen route={SHARE} />, h, { permissions, ...(mode === undefined ? {} : { mode }) }, address);
  return h;
};

afterEach(cleanup);

describe('the model of the shares of a dashboard (ST-BI-007)', () => {
  it('reads a share, drops one without an id and keeps what is missing as nothing', () => {
    expect(toShare(null)).toBeUndefined();
    expect(toShare({ grantee_kind: 'USER' })).toBeUndefined();
    expect(toShare(share(S1))).toMatchObject({ id: S1, kind: 'USER', granteeId: GRANTEE, granteeName: 'Nhân viên', permission: 'VIEW', status: 'ACTIVE', version: 1 });
    expect(toShare({ id: S2, grantee_kind: 'NONSENSE', permission: 'NONSENSE', status: 'REVOKED' })).toMatchObject({
      kind: 'USER',
      granteeId: '',
      granteeName: null,
      permission: 'VIEW',
      status: 'REVOKED',
      revokedAt: null,
      createdAt: '',
      version: 1,
    });
  });

  it('reads the permission and the shares of a dashboard', () => {
    const read = toDashboard(dashboard(D1, 'D-ONE'));
    expect(read).toMatchObject({ permission: 'OWNER' });
    expect(read?.shares).toHaveLength(2);
    expect(toDashboard({ id: D2, code: 'D-TWO', permission: 'NONSENSE', shares: 'x' })).toMatchObject({ permission: null, shares: [] });
    expect(toDashboard({ id: D2, code: 'D-TWO', permission: 'EDIT' })).toMatchObject({ permission: 'EDIT' });
    expect(toDashboard({ id: D2, code: 'D-TWO', permission: 'VIEW' })).toMatchObject({ permission: 'VIEW' });
  });

  it('checks the id of who the dashboard is shared with and writes the body of the contract', () => {
    expect(validateShare(EMPTY_SHARE)).toEqual({ granteeId: 'required' });
    expect(validateShare({ ...EMPTY_SHARE, granteeId: 'nope' })).toEqual({ granteeId: 'invalid' });
    expect(validateShare({ ...EMPTY_SHARE, granteeId: GRANTEE })).toEqual({});
    expect(shareBody({ kind: 'ROLE', granteeId: `  ${GRANTEE.toUpperCase()} `, permission: 'EDIT' })).toEqual({ grantee_kind: 'ROLE', grantee_ref_id: GRANTEE, permission: 'EDIT' });
  });

  it.each([
    [failure(422, 'GRANTEE_OUT_OF_TENANT'), 'outOfTenant'],
    [failure(409, 'STAGE_TRANSITION_DENIED'), 'duplicate'],
    [failure(422, 'VALIDATION_FAILED'), 'self'],
    [failure(409, 'SHARE_STATE_INVALID'), 'ended'],
    [failure(409, 'VERSION_CONFLICT'), 'conflict'],
    [failure(403, 'SCOPE_DENIED'), 'scope'],
    [failure(404, 'RESOURCE_NOT_FOUND'), 'notFound'],
    [failure(500, 'BOOM'), 'general'],
    [new Error('x'), 'general'],
  ])('names the reason of a refusal by the code of the server: %#', (error, reason) => {
    expect(describeShareProblem(error)).toBe(reason);
  });
});

describe('BI-17 sharing of a dashboard (ST-BI-007)', () => {
  it('says that a share gives no data, lists who it is shared with and what ended, and takes a share back under its version', async () => {
    const h = open();
    const table = await screen.findByTestId('shares');
    expect(screen.getByTestId('warning').textContent).toBe(vi_['bi.share.warning']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['bi.share.title']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect((rows[0] as HTMLElement).textContent).toContain('Nhân viên');
    expect((rows[0] as HTMLElement).textContent).toContain(vi_['bi.share.kind.user']);
    expect((rows[1] as HTMLElement).textContent).toContain(OTHER);
    expect(within(rows[1] as HTMLElement).queryByRole('button')).toBeNull();
    const user = userEvent.setup();
    await user.click(within(rows[0] as HTMLElement).getByRole('button', { name: vi_['bi.share.revoke'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('revokeDashboardShare', expect.objectContaining({ path: { id: S1 }, ifMatchVersion: 1 })));
  });

  it('shares with a person, a role or a unit after the checks of the id, under the version of the dashboard', async () => {
    const h = open();
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.share.form.title'] });
    await user.click(within(form).getByRole('button', { name: vi_['bi.share.submit'] }));
    expect(await within(form).findByText(vi_['bi.share.grantee.required'])).toBeTruthy();
    await user.type(within(form).getByLabelText(vi_['bi.share.grantee']), 'nope');
    await user.click(within(form).getByRole('button', { name: vi_['bi.share.submit'] }));
    expect(await within(form).findByText(vi_['bi.share.grantee.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.clear(within(form).getByLabelText(vi_['bi.share.grantee']));
    await user.selectOptions(within(form).getByLabelText(vi_['bi.share.kind']), 'UNIT');
    await user.selectOptions(within(form).getByLabelText(vi_['bi.share.permission']), 'EDIT');
    await user.type(within(form).getByLabelText(vi_['bi.share.grantee']), GRANTEE);
    await user.click(within(form).getByRole('button', { name: vi_['bi.share.submit'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'shareDashboard',
        expect.objectContaining({ path: { id: D1 }, body: { grantee_kind: 'UNIT', grantee_ref_id: GRANTEE, permission: 'EDIT' }, ifMatchVersion: 4 }),
      ),
    );
    expect((await screen.findByTestId('saved')).textContent).toBe(vi_['bi.share.saved']);
    expect((within(form).getByLabelText(vi_['bi.share.grantee']) as HTMLInputElement).value).toBe('');
  });

  it.each([
    [failure(422, 'GRANTEE_OUT_OF_TENANT'), 'outOfTenant', vi_['bi.share.refusal.outOfTenant']],
    [failure(409, 'STAGE_TRANSITION_DENIED'), 'duplicate', vi_['bi.share.refusal.duplicate']],
    [failure(422, 'VALIDATION_FAILED'), 'self', vi_['bi.share.refusal.self']],
    [failure(409, 'VERSION_CONFLICT'), 'conflict', vi_['bi.share.refusal.conflict']],
    [failure(403, 'SCOPE_DENIED'), 'scope', vi_['bi.share.refusal.scope']],
    [failure(404, 'RESOURCE_NOT_FOUND'), 'notFound', vi_['bi.share.refusal.notFound']],
    [failure(500, 'BOOM'), 'general', vi_['bi.share.refusal.general']],
  ])('tells why the server refused a share: %#', async (error, reason, message) => {
    open({}, () => error);
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.share.form.title'] });
    await user.type(within(form).getByLabelText(vi_['bi.share.grantee']), GRANTEE);
    await user.click(within(form).getByRole('button', { name: vi_['bi.share.submit'] }));
    const refusal = await screen.findByTestId('refusal');
    expect(refusal.getAttribute('data-reason')).toBe(reason);
    expect(refusal.textContent).toBe(message);
    expect(screen.queryByTestId('saved')).toBeNull();
  });

  it('tells why a revocation was refused, such as a share that already ended', async () => {
    open({}, () => failure(409, 'SHARE_STATE_INVALID'));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: vi_['bi.share.revoke'] }));
    const refusal = await screen.findByTestId('refusal');
    expect(refusal.getAttribute('data-reason')).toBe('ended');
    expect(refusal.textContent).toBe(vi_['bi.share.refusal.ended']);
  });

  it('shows the dashboard only to someone who may not share: not the owner, no right, a read-only session, an archived dashboard', async () => {
    open({ one: dashboard(D1, 'D-ONE', { mine: false, permission: 'VIEW', shares: [] }) });
    expect((await screen.findByTestId('read-only')).textContent).toBe(vi_['bi.share.readOnly']);
    expect(screen.getByTestId('no-shares').textContent).toBe(vi_['bi.share.list.hidden']);
    expect(screen.queryByRole('form', { name: vi_['bi.share.form.title'] })).toBeNull();
    cleanup();
    open({}, undefined, ['bi.query']);
    await screen.findByTestId('shares');
    expect(screen.queryByRole('form', { name: vi_['bi.share.form.title'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['bi.share.revoke'] })).toBeNull();
    cleanup();
    open({}, undefined, MAY, 'READ_ONLY');
    await screen.findByTestId('shares');
    expect(screen.queryByRole('form', { name: vi_['bi.share.form.title'] })).toBeNull();
    cleanup();
    open({ one: dashboard(D1, 'D-ONE', { status: 'ARCHIVED' }) });
    await screen.findByTestId('shares');
    expect(screen.queryByRole('form', { name: vi_['bi.share.form.title'] })).toBeNull();
    cleanup();
    open({ one: dashboard(D1, 'D-ONE', { shares: [] }) });
    expect((await screen.findByTestId('no-shares')).textContent).toBe(vi_['bi.share.list.empty']);
  });

  it('offers the dashboards of the caller only, asks to pick one first, and says when the dashboard cannot be read', async () => {
    const h = client({ dashboards: [dashboard(D1, 'D-ONE'), dashboard(D2, 'D-TWO', { mine: false, permission: 'VIEW' })], one: dashboard(D1, 'D-ONE') });
    mount(<DashboardShareScreen route={SHARE} />, h, { permissions: MAY }, '/bi/bi-17');
    expect((await screen.findByTestId('pick-first')).textContent).toBe(vi_['bi.share.choose']);
    const select = screen.getByLabelText(vi_['bi.share.pick']) as HTMLSelectElement;
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['—', 'D-ONE · Dashboard D-ONE']);
    const user = userEvent.setup();
    await user.selectOptions(select, D1);
    expect(await screen.findByTestId('shares')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText(vi_['bi.share.pick']), '');
    expect(await screen.findByTestId('pick-first')).toBeTruthy();
    cleanup();
    open({ one: failure(404, 'RESOURCE_NOT_FOUND') });
    expect((await screen.findByTestId('read-failed')).textContent).toBe(vi_['bi.share.failed']);
  });

  it('starts over when the member or the tenant changes: what was typed is not carried to another', async () => {
    const h = client({ one: dashboard(D1, 'D-ONE') });
    const view = mount(<DashboardShareScreen route={SHARE} />, h, { permissions: MAY }, address);
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.share.form.title'] });
    await user.type(within(form).getByLabelText(vi_['bi.share.grantee']), 'abc');
    view.rerenderWith({ permissions: MAY, tenant: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Khác', membershipId: ME } as never });
    await waitFor(() => expect((screen.getByLabelText(vi_['bi.share.grantee']) as HTMLInputElement).value).toBe(''));
  });

  it("leads from the library to the sharing of the dashboards that are the caller's only", async () => {
    const h = client({ dashboards: [dashboard(D1, 'D-ONE'), dashboard(D2, 'D-TWO', { mine: false, permission: 'VIEW', may_edit: false })] });
    mount(<DashboardLibraryScreen route={LIBRARY} />, h, { permissions: MAY });
    const links = await screen.findAllByRole('link', { name: vi_['bi.dash.library.share'] });
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe(`/bi/bi-17?dashboard=${D1}`);
  });
});

describe('the seven standard states of BI-17 (ST-BI-007)', () => {
  const offline = new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' });
  it.each([
    ['empty', [], vi_['states.empty.title']],
    ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
    ['offline', offline, vi_['states.offline.title']],
    ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
    ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
  ] as Array<[string, unknown[] | Error, string]>)('UI-BI-17 shows the %s state', async (_name, dashboards, title) => {
    mount(<DashboardShareScreen route={SHARE} />, client({ dashboards }), { permissions: MAY });
    expect(await screen.findByText(title)).toBeTruthy();
  });

  it('UI-BI-17 shows the loading state first, names the page, and retries after an error', async () => {
    const h = harness(() => new Error('unexpected'));
    (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
    mount(<DashboardShareScreen route={SHARE} />, h, { permissions: MAY });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(screen.getByRole('region', { name: vi_['bi.share.title'] })).toBeTruthy();
    cleanup();
    const world: World = { dashboards: failure(500, 'INTERNAL_ERROR') };
    mount(<DashboardShareScreen route={SHARE} />, client(world), { permissions: MAY });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    world.dashboards = [dashboard(D1, 'D-ONE')];
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    expect(await screen.findByTestId('pick-first')).toBeTruthy();
  });
});
