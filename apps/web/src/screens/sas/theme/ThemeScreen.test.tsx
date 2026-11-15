import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import type { ApiClient } from '@machvon/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientProvider } from '../../../api/ApiClientContext';
import vi_ from '../../../i18n/vi.json';
import { ALL_MODULES_VISIBLE } from '../../../navigation/model';
import { SessionContext } from '../../../session/SessionContext';
import type { SessionValue } from '../../../session/SessionContext';
import { PLATFORM_TENANT, harness, routeOf } from '../test-support';
import type { Harness } from '../test-support';
import ThemeScreen from './ThemeScreen';
import type { ThemeConfig } from './types';
import { LOGO_MAX_BYTES } from './types';

const ROUTE = routeOf('SAS-04', 'FR-SAS-04');
const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
const TENANT_B = '00000000-0000-4000-8000-0000000000a2';
const ASSET = '00000000-0000-4000-8000-0000000000f1';
const ADMIN = ['system.tenant.read', 'system.tenant.manage', 'system.theme.manage'];
const REASON = 'The new colours failed the accessibility audit.';

const THEME: ThemeConfig = {
  name: 'Cao Bằng',
  title: 'Hệ thống đầu tư công',
  subtitle: 'Không gian quản lý',
  header: 'Cổng quản lý',
  footer: 'Chân trang',
  address: 'Địa chỉ cơ quan',
  email: 'hotro@donvi.example',
  phone: '',
  primary: '#0b5cad',
  primaryText: '#ffffff',
  menu: '#102a43',
  menuText: '#ffffff',
  selected: '#e6f0fa',
  selectedText: '#102a43',
  headerBg: '#ffffff',
  headerText: '#102a43',
  footerBg: '#f1f5f9',
  footerText: '#102a43',
  background: '#ffffff',
  titleColor: '#102a43',
  logoAssetId: null,
};

const fill = (template: string, params: Record<string, string | number>): string => template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
const version = (n: number, extra: Record<string, unknown> = {}) => ({ tenantId: TENANT_A, version: n, config: THEME, hash: 'a'.repeat(64), publishedAt: '2026-10-22T00:00:00.000Z', sourceVersion: null, ...extra });
const problem = (status: number, code: string, extensions: Record<string, unknown> = {}): ApiError => new ApiError({ status, code, correlationId: 'c0', retryAfterSeconds: undefined, detail: undefined, extensions });

interface World {
  draft: { revision: number; config: ThemeConfig };
  versions: Array<ReturnType<typeof version>>;
  tenants: Array<{ id: string; code: string; name: string }>;
}
let world: World;

function answer(operation: string, input: unknown): unknown {
  const path = (input as { path?: { tenantId?: string } } | undefined)?.path;
  switch (operation) {
    case 'listSystemTenants':
      return { items: world.tenants, next_cursor: null };
    case 'getSystemTenantThemeDraft':
      return path?.tenantId === TENANT_B ? { revision: 0, config: { ...THEME, name: 'Tenant B' } } : world.draft;
    case 'listSystemTenantThemeVersions':
      return { items: world.versions, nextCursor: null };
    case 'getMyPublishedTheme':
      return world.versions[0];
    default:
      return new Error(`unexpected read ${operation}`);
  }
}

interface Mounted {
  h: Harness;
  upload: ReturnType<typeof vi.fn>;
  queries: QueryClient;
}

function open(options: { permissions?: readonly string[] | undefined; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown; read?: (operation: string, input: unknown) => unknown; path?: string; requestStepUp?: () => Promise<void> } = {}): Mounted {
  const h = harness(options.read ?? answer, options.command);
  const upload = vi.fn(() => Promise.resolve({ assetId: ASSET, scanStatus: 'clean', contentHash: 'b'.repeat(64), contentType: 'image/png' }));
  const client = { ...h.client, upload } as unknown as ApiClient;
  const session: SessionValue = {
    tenant: PLATFORM_TENANT,
    tenants: [PLATFORM_TENANT],
    user: { displayName: 'Admin', initials: 'AD' },
    access: ALL_MODULES_VISIBLE,
    switchTenant: () => undefined,
    getSession: () => Promise.resolve({ token: 'token' }),
    permissions: 'permissions' in options ? options.permissions : ADMIN,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.requestStepUp === undefined ? {} : { requestStepUp: options.requestStepUp }),
  };
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={queries}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[options.path ?? `/sas/sas-04?tenant=${TENANT_A}`]}>
            <ThemeScreen route={ROUTE} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
  return { h, upload, queries };
}

const previewDocument = (): string => (screen.getByTitle(vi_['sas.theme.preview.frame.title']) as HTMLIFrameElement).srcdoc;
const colourField = (label: string): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement;
const setColour = (label: string, value: string): void => {
  fireEvent.change(colourField(label), { target: { value } });
};
const commandsOf = (h: Harness, operation: string): Array<Record<string, unknown>> => h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as Record<string, unknown>);
const loaded = (): Promise<HTMLElement> => screen.findByLabelText(vi_['sas.theme.field.name.label']);

beforeEach(() => {
  world = { draft: { revision: 0, config: THEME }, versions: [version(1)], tenants: [{ id: TENANT_A, code: 'cao-bang', name: 'Cao Bằng' }, { id: TENANT_B, code: 'lao-cai', name: 'Lào Cai' }] };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SAS-04 theme editor', () => {
  it('shows the draft of the tenant named in the address, the callout, the picker and the preview of the draft', async () => {
    open();
    expect(await loaded()).toHaveValue('Cao Bằng');
    expect(screen.getByRole('heading', { level: 1, name: vi_['sas.theme.page.title'] })).toBeTruthy();
    expect(screen.getByText(vi_['sas.theme.callout.manage.text'])).toBeTruthy();
    expect(screen.getByLabelText(vi_['sas.theme.field.title.label'])).toHaveValue('Hệ thống đầu tư công');
    expect(colourField(vi_['sas.theme.field.primary.label']).value).toBe('#0b5cad');
    expect(screen.getByLabelText(vi_['sas.theme.tenant.label'])).toHaveValue(TENANT_A);
    expect(screen.getByText(vi_['sas.theme.preview.draft.label'])).toBeTruthy();
    expect(screen.getByText(fill(vi_['sas.theme.tenant.version.text'], { version: 1 }))).toBeTruthy();
    expect(screen.getByText(fill(vi_['sas.theme.footer.reference'], { id: 'SAS-04', req: 'FR-SAS-04' }))).toBeTruthy();
    expect(screen.getByText(vi_['sas.theme.validation.valid.title'])).toBeTruthy();
  });

  it('opens on the first tenant of the registry when the address names none', async () => {
    const { h } = open({ path: '/sas/sas-04' });
    await loaded();
    expect(screen.getByLabelText(vi_['sas.theme.tenant.label'])).toHaveValue(TENANT_A);
    expect(h.read).toHaveBeenCalledWith('getSystemTenantThemeDraft', { path: { tenantId: TENANT_A } });
  });

  it('shows the draft in a frame with no permission, and the preview follows the edits without touching the application (isolation)', async () => {
    open();
    await loaded();
    const frame = screen.getByTitle(vi_['sas.theme.preview.frame.title']);
    expect(frame.getAttribute('sandbox')).toBe('');
    const rootBefore = getComputedStyle(document.documentElement).getPropertyValue('--mv-theme-primary');
    const stylesBefore = document.querySelectorAll('style').length;
    expect(previewDocument()).toContain('#0b5cad');
    setColour(vi_['sas.theme.field.primary.label'], '#aa1122');
    expect(previewDocument()).toContain('#aa1122');
    expect(previewDocument()).not.toContain('#0b5cad');
    // Nothing of the draft reached the application: no theme wrapper, no custom property, no new stylesheet.
    expect(document.querySelector('[data-mv-tenant-theme]')).toBeNull();
    expect(getComputedStyle(document.documentElement).getPropertyValue('--mv-theme-primary')).toBe(rootBefore);
    expect(document.querySelectorAll('style').length).toBe(stylesBefore);
    expect(document.body.innerHTML).not.toContain('#aa1122</style>');
    // The texts follow too, as text.
    fireEvent.change(screen.getByLabelText(vi_['sas.theme.field.title.label']), { target: { value: '<b>Mới</b>' } });
    expect(previewDocument()).toContain('&lt;b&gt;Mới&lt;/b&gt;');
  });

  it('switches the preview between web and smartphone', async () => {
    open();
    await loaded();
    expect(previewDocument()).toContain('grid-template-columns:140px 1fr');
    await userEvent.selectOptions(screen.getByLabelText(vi_['sas.theme.preview.platform.label']), 'phone');
    expect(previewDocument()).toContain('grid-template-columns:1fr');
    expect(document.querySelector('.theme-preview-canvas')?.className).toContain('phone');
  });

  it('applies a palette to the draft only', async () => {
    open();
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.preset.navy.label'] }));
    expect(colourField(vi_['sas.theme.field.primary.label']).value).toBe('#244c78');
    expect(previewDocument()).toContain('#244c78');
    expect(screen.getByText(vi_['sas.theme.status.preset.text'])).toBeTruthy();
  });

  it('refuses a pair under 4.5:1 with the finding, never applies it to the preview and does not offer to save it', async () => {
    const { h } = open();
    await loaded();
    setColour(vi_['sas.theme.field.primary.label'], '#8c8c8c');
    const message = screen.getByText((content) => content.includes(vi_['sas.theme.field.primaryText.label']) && content.includes(vi_['sas.theme.field.primary.label']) && content.includes(':1'));
    expect(message.getAttribute('data-issue')).toBe('CONTRAST');
    expect(previewDocument()).not.toContain('#8c8c8c');
    expect(previewDocument()).toContain('#0b5cad');
    expect(screen.getByRole('button', { name: vi_['sas.theme.save.action'] })).toBeDisabled();
    expect(screen.getByRole('button', { name: vi_['sas.theme.review.action'] })).toBeDisabled();
    expect(commandsOf(h, 'putSystemTenantThemeDraft')).toHaveLength(0);
    // Back to a passing pair: the preview follows again and the buttons come back.
    setColour(vi_['sas.theme.field.primary.label'], '#767676');
    expect(previewDocument()).toContain('#767676');
    expect(screen.getByRole('button', { name: vi_['sas.theme.save.action'] })).toBeEnabled();
  });

  it('shows each finding of a stored draft by its kind (forbidden value, bad colour, missing text, email) and keeps all of them out of the preview', async () => {
    world.draft = { revision: 3, config: { ...THEME, primary: 'url(https://evil.example/a.png)', menu: 'red', name: '', email: 'nope' } };
    open();
    await loaded();
    const kinds = [...document.querySelectorAll('#theme-validation [data-issue]')].map((item) => item.getAttribute('data-issue'));
    expect(kinds).toEqual(expect.arrayContaining(['FORBIDDEN_VALUE', 'BAD_COLOR', 'REQUIRED', 'EMAIL']));
    expect(screen.getByText(fill(vi_['sas.theme.issue.forbidden.text'], { field: vi_['sas.theme.field.primary.label'] }))).toBeTruthy();
    expect(screen.getByText(fill(vi_['sas.theme.issue.badColor.text'], { field: vi_['sas.theme.field.menu.label'] }))).toBeTruthy();
    expect(screen.getByText(fill(vi_['sas.theme.issue.required.text'], { field: vi_['sas.theme.field.name.label'] }))).toBeTruthy();
    expect(screen.getByText(vi_['sas.theme.issue.email.text'])).toBeTruthy();
    expect(previewDocument()).not.toContain('evil.example');
    expect(screen.getByRole('button', { name: vi_['sas.theme.review.action'] })).toBeDisabled();
  });

  it('saves the draft with the revision it was read at, and then there is nothing to save', async () => {
    const { h } = open({ command: () => ({ revision: 1, config: { ...THEME, title: 'Mới' } }) });
    await loaded();
    expect(screen.getByRole('button', { name: vi_['sas.theme.save.action'] })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(vi_['sas.theme.field.title.label']), { target: { value: 'Mới' } });
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.save.action'] }));
    await screen.findByText(vi_['sas.theme.status.saved.text']);
    expect(commandsOf(h, 'putSystemTenantThemeDraft')).toEqual([expect.objectContaining({ path: { tenantId: TENANT_A }, ifMatchVersion: 0, body: { ...THEME, title: 'Mới' } })]);
    expect(screen.getByRole('button', { name: vi_['sas.theme.save.action'] })).toBeDisabled();
  });

  it('cuts a text at the length of the contract', async () => {
    open();
    await loaded();
    fireEvent.change(screen.getByLabelText(vi_['sas.theme.field.name.label']), { target: { value: 'x'.repeat(200) } });
    expect((screen.getByLabelText(vi_['sas.theme.field.name.label']) as HTMLInputElement).value).toHaveLength(160);
  });

  it('tells the person when another administrator saved first (VERSION_CONFLICT) and reloads on request', async () => {
    const { h } = open({
      command: () => problem(409, 'VERSION_CONFLICT', { current_version: 4 }),
    });
    await loaded();
    fireEvent.change(screen.getByLabelText(vi_['sas.theme.field.title.label']), { target: { value: 'Mới' } });
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.save.action'] }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(vi_['sas.theme.error.conflict.text']);
    world.draft = { revision: 4, config: { ...THEME, title: 'Của người khác' } };
    const reads = h.read.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.error.reload.action'] }));
    await waitFor(() => expect(screen.getByLabelText(vi_['sas.theme.field.title.label'])).toHaveValue('Của người khác'));
    expect(h.read.mock.calls.length).toBeGreaterThan(reads);
  });

  it('waits for the fresh draft before it rebuilds the editor after a conflict, whichever read answers first', async () => {
    let draftReads = 0;
    let release: (value: unknown) => void = () => undefined;
    const slowDraft = new Promise((resolveDraft) => {
      release = resolveDraft;
    });
    const read = (operation: string, input: unknown): unknown => {
      if (operation === 'getSystemTenantThemeDraft') {
        draftReads += 1;
        if (draftReads === 2) return slowDraft;
      }
      return answer(operation, input);
    };
    const { h } = open({ read, command: (operation, input) => (operation === 'putSystemTenantThemeDraft' && (input as { ifMatchVersion: number }).ifMatchVersion === 0 ? problem(409, 'VERSION_CONFLICT', { current_version: 4 }) : { revision: 5, config: { ...THEME, title: 'Mới nhất' } }) });
    await loaded();
    fireEvent.change(screen.getByLabelText(vi_['sas.theme.field.title.label']), { target: { value: 'Mới' } });
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.save.action'] }));
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.error.reload.action'] }));
    // The versions answer at once, the draft later: the editor must not be rebuilt from the draft that was cached.
    await waitFor(() => expect(draftReads).toBe(2));
    expect(screen.getByLabelText(vi_['sas.theme.field.title.label'])).toHaveValue('Mới');
    release({ revision: 4, config: { ...THEME, title: 'Của người khác' } });
    await waitFor(() => expect(screen.getByLabelText(vi_['sas.theme.field.title.label'])).toHaveValue('Của người khác'));
    // The editor holds the fresh revision: its next save is built on revision 4, not on the cached one.
    fireEvent.change(screen.getByLabelText(vi_['sas.theme.field.title.label']), { target: { value: 'Mới nhất' } });
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.save.action'] }));
    await screen.findByText(vi_['sas.theme.status.saved.text']);
    expect(commandsOf(h, 'putSystemTenantThemeDraft').map((call) => call.ifMatchVersion)).toEqual([0, 4]);
  });

  it('keeps the tenant picker when the theme of the chosen tenant cannot be read, so another tenant can be chosen', async () => {
    const read = (operation: string, input: unknown): unknown => {
      const tenantId = (input as { path?: { tenantId?: string } } | undefined)?.path?.tenantId;
      if (operation === 'getSystemTenantThemeDraft' && tenantId === TENANT_B) return problem(404, 'RESOURCE_NOT_FOUND');
      return answer(operation, input);
    };
    const { h } = open({ read, path: `/sas/sas-04?tenant=${TENANT_B}` });
    await screen.findByRole('alert');
    const picker = screen.getByLabelText(vi_['sas.theme.tenant.label']);
    expect(picker).toHaveValue(TENANT_B);
    await userEvent.selectOptions(picker, TENANT_A);
    await waitFor(() => expect(screen.getByLabelText(vi_['sas.theme.field.name.label'])).toHaveValue('Cao Bằng'));
    expect(h.read).toHaveBeenCalledWith('getSystemTenantThemeDraft', { path: { tenantId: TENANT_A } });
    // The editor owns the picker again, and only one picker is on the screen.
    expect(screen.getAllByLabelText(vi_['sas.theme.tenant.label'])).toHaveLength(1);
  });

  it('does not ask about unsaved changes of an editor that is gone when the picker is used after a failed read', async () => {
    const read = (operation: string, input: unknown): unknown => {
      const tenantId = (input as { path?: { tenantId?: string } } | undefined)?.path?.tenantId;
      if (operation === 'getSystemTenantThemeDraft' && tenantId === TENANT_B) return problem(404, 'RESOURCE_NOT_FOUND');
      return answer(operation, input);
    };
    open({ read });
    await loaded();
    fireEvent.change(screen.getByLabelText(vi_['sas.theme.field.title.label']), { target: { value: 'Mới' } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.selectOptions(screen.getByLabelText(vi_['sas.theme.tenant.label']), TENANT_B);
    await screen.findByRole('alert');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.selectOptions(screen.getByLabelText(vi_['sas.theme.tenant.label']), TENANT_A);
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText(vi_['sas.theme.field.name.label'])).toHaveValue('Cao Bằng'));
  });

  it('shows what the server found wrong that the form did not (422 with findings)', async () => {
    open({ command: () => problem(422, 'VALIDATION_FAILED', { findings: [{ code: 'LOGO', token: 'logoAssetId' }] }) });
    await loaded();
    fireEvent.change(screen.getByLabelText(vi_['sas.theme.field.title.label']), { target: { value: 'Mới' } });
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.save.action'] }));
    expect(await screen.findByText(vi_['sas.theme.error.invalid.text'])).toBeTruthy();
    expect(screen.getAllByText(vi_['sas.theme.issue.logo.text']).length).toBeGreaterThan(0);
  });

  it('discards the unsaved changes after a confirmation, and keeps them when the person declines', async () => {
    open();
    await loaded();
    fireEvent.change(screen.getByLabelText(vi_['sas.theme.field.title.label']), { target: { value: 'Mới' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.discard.action'] }));
    expect(confirm).toHaveBeenCalledWith(vi_['sas.theme.discard.confirm']);
    expect(screen.getByLabelText(vi_['sas.theme.field.title.label'])).toHaveValue('Mới');
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.discard.action'] }));
    expect(screen.getByLabelText(vi_['sas.theme.field.title.label'])).toHaveValue('Hệ thống đầu tư công');
  });

  it('asks before leaving unsaved changes for another tenant, and loads the other tenant when allowed', async () => {
    const { h } = open();
    await loaded();
    fireEvent.change(screen.getByLabelText(vi_['sas.theme.field.title.label']), { target: { value: 'Mới' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.selectOptions(screen.getByLabelText(vi_['sas.theme.tenant.label']), TENANT_B);
    expect(confirm).toHaveBeenCalledWith(vi_['sas.theme.tenant.switch.confirm']);
    expect(screen.getByLabelText(vi_['sas.theme.tenant.label'])).toHaveValue(TENANT_A);
    confirm.mockReturnValue(true);
    await userEvent.selectOptions(screen.getByLabelText(vi_['sas.theme.tenant.label']), TENANT_B);
    await waitFor(() => expect(screen.getByLabelText(vi_['sas.theme.field.name.label'])).toHaveValue('Tenant B'));
    expect(h.read).toHaveBeenCalledWith('getSystemTenantThemeDraft', { path: { tenantId: TENANT_B } });
  });
});

describe('SAS-04 review, publish and restore', () => {
  const reviewResult = (changes: Array<{ field: string; before: string | null; after: string | null }>, candidate: ThemeConfig = THEME) => ({
    reviewToken: 't'.repeat(43),
    expiresAt: '2026-10-23T03:15:00.000Z',
    baseVersion: 1,
    candidate,
    changes,
  });

  function flow(extra: (operation: string, input: unknown) => unknown = () => undefined) {
    const candidate = { ...THEME, primary: '#112233' };
    return (operation: string, input: unknown): unknown => {
      const custom = extra(operation, input);
      if (custom !== undefined) return custom;
      if (operation === 'putSystemTenantThemeDraft') return { revision: 1, config: candidate };
      if (operation === 'reviewSystemTenantTheme') return reviewResult([{ field: 'primary', before: '#0b5cad', after: '#112233' }], candidate);
      if (operation === 'publishSystemTenantTheme') return version(2, { config: candidate, sourceVersion: null });
      return new Error('unexpected command');
    };
  }

  it('saves what changed, reviews the saved revision against the published version, and publishes only after the confirmation', async () => {
    world.versions = [version(1)];
    const { h } = open({ command: flow() });
    await loaded();
    setColour(vi_['sas.theme.field.primary.label'], '#112233');
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.review.action'] }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(fill(vi_['sas.theme.review.changes.title'], { count: 1 }));
    expect(commandsOf(h, 'putSystemTenantThemeDraft')).toHaveLength(1);
    expect(commandsOf(h, 'reviewSystemTenantTheme')).toEqual([expect.objectContaining({ path: { tenantId: TENANT_A }, body: { draftRevision: 1, baseVersion: 1 } })]);
    const row = within(dialog).getByText(vi_['sas.theme.field.primary.label']).closest('tr');
    expect(row).toHaveTextContent('#0b5cad');
    expect(row).toHaveTextContent('#112233');
    expect(within(dialog).getByText(vi_['sas.theme.review.valid.text'])).toBeTruthy();
    expect((within(dialog).getByTitle(vi_['sas.theme.review.preview.title']) as HTMLIFrameElement).srcdoc).toContain('#112233');

    const apply = within(dialog).getByRole('button', { name: vi_['sas.theme.review.apply.confirm'] });
    expect(apply).toBeDisabled();
    await userEvent.click(apply);
    expect(commandsOf(h, 'publishSystemTenantTheme')).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('checkbox', { name: vi_['sas.theme.review.confirm.label'] }));
    await userEvent.click(apply);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'publishSystemTenantTheme')).toEqual([expect.objectContaining({ path: { tenantId: TENANT_A }, body: { reviewToken: 't'.repeat(43), baseVersion: 1 } })]);
    expect(screen.getByText(fill(vi_['sas.theme.status.published.text'], { version: 2 }))).toBeTruthy();
  });

  it('saves the next edit at draft revision 0 once publishing has cleared the draft', async () => {
    world.versions = [version(1)];
    const { h } = open({ command: flow() });
    await loaded();
    setColour(vi_['sas.theme.field.primary.label'], '#112233');
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.review.action'] }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(fill(vi_['sas.theme.review.changes.title'], { count: 1 }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: vi_['sas.theme.review.confirm.label'] }));
    await userEvent.click(within(dialog).getByRole('button', { name: vi_['sas.theme.review.apply.confirm'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'putSystemTenantThemeDraft')).toEqual([expect.objectContaining({ ifMatchVersion: 0 })]);

    fireEvent.change(screen.getByLabelText(vi_['sas.theme.field.title.label']), { target: { value: 'Mới' } });
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.save.action'] }));
    await waitFor(() => expect(commandsOf(h, 'putSystemTenantThemeDraft')).toHaveLength(2));
    // The server cleared the draft that was published: the next draft starts again at revision 0, not at the revision the editor held.
    expect(commandsOf(h, 'putSystemTenantThemeDraft')[1]).toMatchObject({ ifMatchVersion: 0 });
  });

  it('reviews an unchanged saved draft without saving it again', async () => {
    world.draft = { revision: 2, config: { ...THEME, primary: '#112233' } };
    const { h } = open({ command: flow() });
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.review.action'] }));
    await screen.findByRole('dialog');
    await waitFor(() => expect(commandsOf(h, 'reviewSystemTenantTheme')).toHaveLength(1));
    expect(commandsOf(h, 'putSystemTenantThemeDraft')).toHaveLength(0);
    expect(commandsOf(h, 'reviewSystemTenantTheme')[0]).toMatchObject({ body: { draftRevision: 2, baseVersion: 1 } });
  });

  it('has nothing to review while the draft was never changed', async () => {
    open({ command: flow() });
    await loaded();
    expect(screen.getByRole('button', { name: vi_['sas.theme.review.action'] })).toBeDisabled();
  });

  it('closes the review without publishing and keeps the draft', async () => {
    world.draft = { revision: 2, config: { ...THEME, primary: '#112233' } };
    const { h } = open({ command: flow() });
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.review.action'] }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('checkbox');
    await userEvent.click(within(dialog).getByRole('button', { name: vi_['sas.theme.review.back.action'] }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(commandsOf(h, 'publishSystemTenantTheme')).toHaveLength(0);
    expect(colourField(vi_['sas.theme.field.primary.label']).value).toBe('#112233');
  });

  it('says REVIEW_INVALID in words and offers a new review, without naming anyone (AC-ST-SAS-005-8)', async () => {
    world.draft = { revision: 2, config: { ...THEME, primary: '#112233' } };
    const { h } = open({ command: flow((operation) => (operation === 'publishSystemTenantTheme' ? problem(409, 'REVIEW_INVALID') : undefined)) });
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.review.action'] }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(await within(dialog).findByRole('checkbox'));
    await userEvent.click(within(dialog).getByRole('button', { name: vi_['sas.theme.review.apply.confirm'] }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(vi_['sas.theme.error.reviewInvalid.text']);
    expect(alert.getAttribute('data-problem')).toBe('reviewInvalid');
    await userEvent.click(within(dialog).getByRole('button', { name: vi_['sas.theme.error.reviewAgain.action'] }));
    await waitFor(() => expect(commandsOf(h, 'reviewSystemTenantTheme')).toHaveLength(2));
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('UAT-NFR-SECURITY-02: a publication refused with MFA_REQUIRED asks for the second factor, publishes nothing until it is given, and then sends the same review once more', async () => {
    world.draft = { revision: 2, config: { ...THEME, primary: '#112233' } };
    let steppedUp = false;
    const requestStepUp = vi.fn(() => {
      steppedUp = true;
      return Promise.resolve();
    });
    const { h } = open({ requestStepUp, command: flow((operation) => (operation === 'publishSystemTenantTheme' && !steppedUp ? problem(403, 'MFA_REQUIRED') : undefined)) });
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.review.action'] }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(await within(dialog).findByRole('checkbox'));
    await userEvent.click(within(dialog).getByRole('button', { name: vi_['sas.theme.review.apply.confirm'] }));

    const prompt = await screen.findByRole('alertdialog', { name: vi_['adm.roles.stepUp.title'] });
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(requestStepUp).not.toHaveBeenCalled();
    expect(commandsOf(h, 'publishSystemTenantTheme')).toHaveLength(1);
    expect(screen.queryByText(fill(vi_['sas.theme.status.published.text'], { version: 2 }))).toBeNull();

    await userEvent.click(within(prompt).getByRole('button', { name: vi_['adm.roles.stepUp.confirm.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requestStepUp).toHaveBeenCalledTimes(1);
    expect(commandsOf(h, 'publishSystemTenantTheme')).toHaveLength(2);
    expect(commandsOf(h, 'publishSystemTenantTheme')[1]).toEqual(expect.objectContaining({ path: { tenantId: TENANT_A }, body: { reviewToken: 't'.repeat(43), baseVersion: 1 } }));
    expect(screen.getByText(fill(vi_['sas.theme.status.published.text'], { version: 2 }))).toBeTruthy();
  });

  it('UAT-NFR-SECURITY-02: declining the second factor publishes nothing and leaves the review open', async () => {
    world.draft = { revision: 2, config: { ...THEME, primary: '#112233' } };
    const requestStepUp = vi.fn(() => Promise.resolve());
    const { h } = open({ requestStepUp, command: flow((operation) => (operation === 'publishSystemTenantTheme' ? problem(403, 'MFA_REQUIRED') : undefined)) });
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.review.action'] }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(await within(dialog).findByRole('checkbox'));
    await userEvent.click(within(dialog).getByRole('button', { name: vi_['sas.theme.review.apply.confirm'] }));
    const prompt = await screen.findByRole('alertdialog', { name: vi_['adm.roles.stepUp.title'] });
    await userEvent.click(within(prompt).getByRole('button', { name: vi_['adm.roles.stepUp.cancel.action'] }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(requestStepUp).not.toHaveBeenCalled();
    expect(commandsOf(h, 'publishSystemTenantTheme')).toHaveLength(1);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('UAT-NFR-SECURITY-02: Escape in the second-factor prompt closes the prompt only, and the prompt stands beside the review, not inside it', async () => {
    world.draft = { revision: 2, config: { ...THEME, primary: '#112233' } };
    open({ command: flow((operation) => (operation === 'publishSystemTenantTheme' ? problem(403, 'MFA_REQUIRED') : undefined)) });
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.review.action'] }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(await within(dialog).findByRole('checkbox'));
    await userEvent.click(within(dialog).getByRole('button', { name: vi_['sas.theme.review.apply.confirm'] }));
    const prompt = await screen.findByRole('alertdialog', { name: vi_['adm.roles.stepUp.title'] });
    // The stylesheet lifts the prompt over the review by this order: the overlay of the prompt follows the overlay of the review in the body.
    expect(document.querySelector('.theme-review-overlay ~ .catalog.command-mode')?.contains(prompt)).toBe(true);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('asks the screen to reload when the base version moved (VERSION_CONFLICT on publish)', async () => {
    world.draft = { revision: 2, config: { ...THEME, primary: '#112233' } };
    const { h } = open({ command: flow((operation) => (operation === 'publishSystemTenantTheme' ? problem(409, 'VERSION_CONFLICT', { current_version: 3 }) : undefined)) });
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.review.action'] }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(await within(dialog).findByRole('checkbox'));
    await userEvent.click(within(dialog).getByRole('button', { name: vi_['sas.theme.review.apply.confirm'] }));
    expect(await within(dialog).findByText(vi_['sas.theme.error.conflict.text'])).toBeTruthy();
    world.versions = [version(3), version(1)];
    const reads = h.read.mock.calls.length;
    await userEvent.click(within(dialog).getByRole('button', { name: vi_['sas.theme.error.reload.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(reads));
    expect(await screen.findByText(fill(vi_['sas.theme.tenant.version.text'], { version: 3 }))).toBeTruthy();
  });

  it('lists the versions, marks the one in use and offers a restore for each other version', async () => {
    world.versions = [version(3, { sourceVersion: 1 }), version(2), version(1)];
    open({ command: flow() });
    await loaded();
    const cards = [...document.querySelectorAll('.theme-version')];
    expect(cards.map((card) => card.getAttribute('data-version'))).toEqual(['3', '2', '1']);
    expect(cards[0]).toHaveTextContent(vi_['sas.theme.history.current.label']);
    expect(cards[0]).toHaveTextContent(fill(vi_['sas.theme.history.restored.text'], { version: 1 }));
    expect(cards[2]).toHaveTextContent(vi_['sas.theme.history.initial.text']);
    expect(screen.queryByRole('button', { name: fill(vi_['sas.theme.history.restore.action'], { version: 3 }) })).toBeNull();
    expect(screen.getByRole('button', { name: fill(vi_['sas.theme.history.restore.action'], { version: 2 }) })).toBeTruthy();
    expect(screen.getByRole('button', { name: fill(vi_['sas.theme.history.restore.action'], { version: 1 }) })).toBeTruthy();
  });

  it('restores an old version with a reason: review, confirmation, publish as a new version', async () => {
    world.versions = [version(2), version(1)];
    const restored = { ...THEME, primary: '#0b5cad' };
    const { h } = open({
      command: flow((operation) => {
        if (operation === 'reviewSystemTenantTheme') return { ...reviewResult([{ field: 'primary', before: '#112233', after: '#0b5cad' }], restored), baseVersion: 2 };
        if (operation === 'publishSystemTenantTheme') return version(3, { sourceVersion: 1, config: restored });
        return undefined;
      }),
    });
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: fill(vi_['sas.theme.history.restore.action'], { version: 1 }) }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: fill(vi_['sas.theme.review.restore.title'], { version: 1 }) })).toBeTruthy();
    // A short reason never leaves the browser.
    await userEvent.type(within(dialog).getByLabelText(vi_['sas.theme.review.reason.label']), 'too short');
    await userEvent.click(within(dialog).getByRole('button', { name: vi_['sas.theme.review.request.action'] }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(vi_['sas.theme.review.reason.tooShort']);
    expect(commandsOf(h, 'reviewSystemTenantTheme')).toHaveLength(0);
    await userEvent.clear(within(dialog).getByLabelText(vi_['sas.theme.review.reason.label']));
    await userEvent.type(within(dialog).getByLabelText(vi_['sas.theme.review.reason.label']), REASON);
    await userEvent.click(within(dialog).getByRole('button', { name: vi_['sas.theme.review.request.action'] }));
    await within(dialog).findByText(fill(vi_['sas.theme.review.changes.title'], { count: 1 }));
    expect(commandsOf(h, 'reviewSystemTenantTheme')).toEqual([expect.objectContaining({ body: { sourceVersion: 1, baseVersion: 2, reason: REASON } })]);
    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.click(within(dialog).getByRole('button', { name: vi_['sas.theme.review.restore.confirm'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(h, 'publishSystemTenantTheme')).toEqual([expect.objectContaining({ body: { reviewToken: 't'.repeat(43), baseVersion: 2 } })]);
    expect(screen.getByText(fill(vi_['sas.theme.status.restored.text'], { version: 3 }))).toBeTruthy();
  });

  it('shows a logo as present or absent in the review, not as an id', async () => {
    world.draft = { revision: 2, config: { ...THEME, logoAssetId: ASSET } };
    open({ command: flow((operation) => (operation === 'reviewSystemTenantTheme' ? reviewResult([{ field: 'logoAssetId', before: null, after: ASSET }], { ...THEME, logoAssetId: ASSET }) : undefined)) });
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.review.action'] }));
    const dialog = await screen.findByRole('dialog');
    const row = (await within(dialog).findByText(vi_['sas.theme.field.logo.label'])).closest('tr');
    expect(row).toHaveTextContent(vi_['sas.theme.review.logo.none']);
    expect(row).toHaveTextContent(vi_['sas.theme.review.logo.some']);
    expect(dialog.textContent).not.toContain(ASSET);
  });

  it('shows an empty value as a dash and states that nothing changed when the review finds no difference', async () => {
    world.draft = { revision: 2, config: THEME };
    open({ command: flow((operation) => (operation === 'reviewSystemTenantTheme' ? reviewResult([]) : undefined)) });
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.review.action'] }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(vi_['sas.theme.review.changes.none'])).toBeTruthy();
  });
});

describe('SAS-04 logo', () => {
  const png = (name = 'logo.png', size = 64): File => new File([new Uint8Array(size)], name, { type: 'image/png' });
  const pick = (file: File): void => {
    fireEvent.change(screen.getByLabelText(vi_['sas.theme.field.logo.label']), { target: { files: [file] } });
  };

  it('uploads the file as one multipart form, then the draft uses the asset', async () => {
    const { upload } = open();
    await loaded();
    pick(png());
    await screen.findByText(vi_['sas.theme.status.logoAdded.text']);
    expect(upload).toHaveBeenCalledTimes(1);
    const [operation, input] = upload.mock.calls[0] as unknown as [string, { path: unknown; form: FormData }];
    expect(operation).toBe('uploadSystemTenantThemeAsset');
    expect(input.path).toEqual({ tenantId: TENANT_A });
    expect((input.form.get('file') as File).name).toBe('logo.png');
    expect(screen.getByText('logo.png')).toBeTruthy();
    expect(screen.getByRole('button', { name: vi_['sas.theme.logo.remove.action'] })).toBeEnabled();
  });

  it('keeps the edits made while the logo uploads (the asset joins the form as it is when the upload ends)', async () => {
    const { upload } = open();
    await loaded();
    let finish: (asset: unknown) => void = () => undefined;
    upload.mockImplementation(
      () =>
        new Promise((resolveUpload) => {
          finish = resolveUpload;
        }),
    );
    pick(png());
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText(vi_['sas.theme.field.title.label']), { target: { value: 'Mới' } });
    setColour(vi_['sas.theme.field.primary.label'], '#aa1122');
    finish({ assetId: ASSET, scanStatus: 'clean', contentHash: 'b'.repeat(64), contentType: 'image/png' });
    await screen.findByText(vi_['sas.theme.status.logoAdded.text']);
    expect(screen.getByLabelText(vi_['sas.theme.field.title.label'])).toHaveValue('Mới');
    expect(colourField(vi_['sas.theme.field.primary.label']).value).toBe('#aa1122');
    expect(screen.getByRole('button', { name: vi_['sas.theme.logo.remove.action'] })).toBeEnabled();
    expect(previewDocument()).toContain('#aa1122');
  });

  it('refuses a file that is not PNG, JPEG or WebP, and a file over 1 MiB, without sending anything', async () => {
    const { upload } = open();
    await loaded();
    pick(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }));
    expect(await screen.findByText(vi_['sas.theme.error.fileType.text'])).toBeTruthy();
    pick(png('big.png', LOGO_MAX_BYTES + 1));
    expect(await screen.findByText(vi_['sas.theme.error.tooLarge.text'])).toBeTruthy();
    expect(upload).not.toHaveBeenCalled();
  });

  it('shows the refusal of the server in words (not allowed, too large, infected)', async () => {
    for (const [status, code, key] of [
      [422, 'FILE_TYPE_NOT_ALLOWED', 'sas.theme.error.fileType.text'],
      [413, 'PAYLOAD_TOO_LARGE', 'sas.theme.error.tooLarge.text'],
      [422, 'FILE_NOT_CLEAN', 'sas.theme.error.infected.text'],
    ] as const) {
      const mounted = open();
      mounted.upload.mockRejectedValueOnce(problem(status, code));
      await loaded();
      pick(png());
      expect(await screen.findByText(vi_[key])).toBeTruthy();
      cleanup();
    }
  });

  it('removes the logo from the draft', async () => {
    world.draft = { revision: 1, config: { ...THEME, logoAssetId: ASSET } };
    open();
    await loaded();
    expect(screen.getByText(vi_['sas.theme.logo.some.text'])).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.logo.remove.action'] }));
    expect(screen.getByText(vi_['sas.theme.logo.none.text'])).toBeTruthy();
    expect(screen.getByText(vi_['sas.theme.status.logoRemoved.text'])).toBeTruthy();
    expect(screen.getByRole('button', { name: vi_['sas.theme.logo.remove.action'] })).toBeDisabled();
  });
});

describe('SAS-04 roles and states', () => {
  it('gives a person without system.theme.manage the published theme of the own tenant, read-only, and reads nothing of the control plane', async () => {
    const { h } = open({ permissions: ['system.tenant.read'], path: '/sas/sas-04' });
    expect(await loaded()).toBeDisabled();
    expect(screen.getByText(vi_['sas.theme.callout.readOnly.text'])).toBeTruthy();
    expect(screen.getByText(vi_['sas.theme.preview.published.label'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['sas.theme.save.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['sas.theme.review.action'] })).toBeNull();
    expect(screen.queryByLabelText(vi_['sas.theme.tenant.label'])).toBeNull();
    expect(screen.queryByText(vi_['sas.theme.history.title'])).toBeNull();
    expect(colourField(vi_['sas.theme.field.primary.label'])).toBeDisabled();
    expect(h.read.mock.calls.map((call) => call[0])).toEqual(['getMyPublishedTheme']);
  });

  it('treats a session that does not state its permissions as a reader, not as an administrator', async () => {
    const { h } = open({ permissions: undefined });
    await loaded();
    expect(h.read.mock.calls.map((call) => call[0])).toEqual(['getMyPublishedTheme']);
  });

  it('drops every control while the session is read-only (a suspended tenant)', async () => {
    world.versions = [version(2), version(1)];
    open({ mode: 'READ_ONLY' });
    expect(await loaded()).toBeDisabled();
    expect(screen.queryByRole('button', { name: fill(vi_['sas.theme.history.restore.action'], { version: 1 }) })).toBeNull();
    expect(screen.getByRole('button', { name: vi_['sas.theme.review.action'] })).toBeDisabled();
  });

  it.each([
    ['denied', problem(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
    ['offline', problem(0, NETWORK_ERROR_CODE), vi_['states.offline.title']],
    ['error', new Error('boom'), vi_['states.error.title']],
    ['signed out', problem(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
  ])('shows the %s state when the draft cannot be read (AC-ST-SAS-005-8)', async (_name, failure, title) => {
    open({ read: (operation, input) => (operation === 'getSystemTenantThemeDraft' ? failure : answer(operation, input)) });
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.queryByLabelText(vi_['sas.theme.field.name.label'])).toBeNull();
  });

  it('shows the loading state while the draft is read', () => {
    open({ read: (operation, input) => (operation === 'getSystemTenantThemeDraft' ? new Promise(() => undefined) : answer(operation, input)) });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
  });

  it('shows the error state of the registry when no tenant can be chosen', async () => {
    open({ path: '/sas/sas-04', read: (operation, input) => (operation === 'listSystemTenants' ? problem(403, 'SCOPE_DENIED') : answer(operation, input)) });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
  });

  it('names a tenant that lies beyond the loaded pages in the picker, and offers more tenants', async () => {
    const outsider = '00000000-0000-4000-8000-0000000000a9';
    open({
      path: `/sas/sas-04?tenant=${outsider}`,
      read: (operation, input) => {
        if (operation === 'listSystemTenants') return { items: world.tenants, next_cursor: 'next' };
        return answer(operation, input);
      },
    });
    await loaded();
    expect(screen.getByLabelText(vi_['sas.theme.tenant.label'])).toHaveValue(outsider);
    expect(screen.getByRole('button', { name: vi_['sas.theme.tenant.more.action'] })).toBeTruthy();
  });

  it('pages through the history of versions', async () => {
    const pages = [{ items: [version(3), version(2)], nextCursor: 'more' }, { items: [version(1)], nextCursor: null }];
    let asked = 0;
    open({
      read: (operation, input) => {
        if (operation !== 'listSystemTenantThemeVersions') return answer(operation, input);
        const page = pages[asked] ?? pages[1];
        asked += 1;
        return page;
      },
    });
    await loaded();
    expect(document.querySelectorAll('.theme-version')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: vi_['sas.theme.history.more.action'] }));
    await waitFor(() => expect(document.querySelectorAll('.theme-version')).toHaveLength(3));
    expect(screen.queryByRole('button', { name: vi_['sas.theme.history.more.action'] })).toBeNull();
  });
});
