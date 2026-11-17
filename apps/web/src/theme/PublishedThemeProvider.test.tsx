import { ApiError } from '@machvon/api-client';
import type { ApiClient } from '@machvon/api-client';
import { TOKENS } from '@machvon/design-tokens';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientProvider } from '../api/ApiClientContext';
import { ALL_MODULES_VISIBLE } from '../navigation/model';
import { SessionContext } from '../session/SessionContext';
import type { SessionTenant, SessionValue } from '../session/SessionContext';
import { useMyPublishedTheme } from '../screens/sas/theme/hooks';
import { PublishedThemeProvider, specOfPublishedTheme, useTenantLogo } from './PublishedThemeProvider';
import { useTheme } from './ThemeProvider';

const CONFIG = {
  name: 'Cao Bằng',
  title: 'Hệ thống',
  subtitle: '',
  header: 'Cổng',
  footer: '',
  address: '',
  email: '',
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
const published = (tenantId: string, hash: string, version: number, primary: string) => ({ tenantId, version, config: { ...CONFIG, primary }, hash, publishedAt: '2026-10-22T00:00:00.000Z', sourceVersion: null });

const A: SessionTenant = { id: '00000000-0000-4000-8000-00000000000a', name: 'A', monogram: 'A', membershipId: 'm1', theme: { themeId: 'session-a', version: 1, overlay: {} } };
const B: SessionTenant = { id: '00000000-0000-4000-8000-00000000000b', name: 'B', monogram: 'B', membershipId: 'm1', theme: { themeId: 'session-b', version: 1, overlay: {} } };

function Probe() {
  const theme = useTheme();
  return (
    <p data-testid="probe">
      {theme.themeId}@{theme.themeVersion}:{String(theme.rejected)}
    </p>
  );
}

function Host({ read, session, children }: { read: ReturnType<typeof vi.fn>; session: Partial<SessionValue>; children?: ReactNode }) {
  const [tenantId, setTenantId] = useState(A.id);
  const tenant = [A, B].find((candidate) => candidate.id === tenantId);
  const value: SessionValue = { tenant, tenants: [A, B], user: undefined, access: ALL_MODULES_VISIBLE, switchTenant: setTenantId, getSession: () => Promise.resolve({ token: 't' }), ...session };
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return (
    <SessionContext.Provider value={value}>
      <QueryClientProvider client={queries}>
        <ApiClientProvider client={{ read } as unknown as ApiClient}>
          <PublishedThemeProvider base={TOKENS}>
            <Probe />
            <button type="button" onClick={() => value.switchTenant(B.id)}>
              switch
            </button>
            {children}
          </PublishedThemeProvider>
        </ApiClientProvider>
      </QueryClientProvider>
    </SessionContext.Provider>
  );
}

afterEach(cleanup);

describe('specOfPublishedTheme', () => {
  it('names the theme by its hash and version and passes only the colours and the logo on as the overlay', () => {
    const spec = specOfPublishedTheme(published(A.id, 'h'.repeat(64), 4, '#112233'));
    expect(spec).toEqual({ themeId: 'h'.repeat(64), version: 4, overlay: expect.objectContaining({ primary: '#112233', primaryText: '#ffffff' }) });
    expect(Object.keys(spec.overlay as object)).not.toContain('name');
    expect(Object.keys(spec.overlay as object)).not.toContain('logoAssetId');
    const withLogo = specOfPublishedTheme({ ...published(A.id, 'h'.repeat(64), 4, '#112233'), config: { ...CONFIG, logoAssetId: '00000000-0000-4000-8000-0000000000f1' } });
    expect((withLogo.overlay as Record<string, unknown>).logoAssetId).toBe('00000000-0000-4000-8000-0000000000f1');
  });
});

// The read side of SAS-04 asks for the same published theme as the provider does.
function ReadSide() {
  useMyPublishedTheme(true);
  return null;
}

describe('PublishedThemeProvider', () => {
  it('follows the published theme that the read-only screen finds, because both read one cache entry', async () => {
    const read = vi.fn((operation: string) => {
      void operation;
      return Promise.resolve(read.mock.calls.length === 1 ? published(A.id, 'a'.repeat(64), 7, '#112233') : published(A.id, 'c'.repeat(64), 8, '#0a4d8c'));
    });
    function Toggle() {
      const [shown, setShown] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setShown(true)}>
            open screen
          </button>
          {shown ? <ReadSide /> : null}
        </>
      );
    }
    render(
      <Host read={read} session={{ tenantToken: { expiresAt: Date.now() + 60_000 } }}>
        <Toggle />
      </Host>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent(`${'a'.repeat(64)}@7:false`));
    // The tenant published again while the application stayed open: the screen reads version 8, and the wrapper applies it.
    await userEvent.click(screen.getByRole('button', { name: 'open screen' }));
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent(`${'c'.repeat(64)}@8:false`));
  });

  it('applies the published theme of the selected tenant after a real sign-in: its id and version are the published ones (AC-ST-SAS-005-7)', async () => {
    const read = vi.fn((operation: string) => (operation === 'getMyPublishedTheme' ? Promise.resolve(published(A.id, 'a'.repeat(64), 7, '#112233')) : Promise.reject(new Error('unexpected'))));
    const { container } = render(<Host read={read} session={{ tenantToken: { expiresAt: Date.now() + 60_000 } }} />);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent(`${'a'.repeat(64)}@7:false`));
    expect(read).toHaveBeenCalledWith('getMyPublishedTheme');
    expect(container.querySelector('style')?.textContent).toContain('#112233');
  });

  it('reads the theme of the other tenant after a switch, and never shows one tenant the theme of another', async () => {
    const read = vi.fn((operation: string) => {
      void operation;
      return Promise.resolve(read.mock.calls.length === 1 ? published(A.id, 'a'.repeat(64), 7, '#112233') : published(B.id, 'b'.repeat(64), 2, '#445566'));
    });
    render(<Host read={read} session={{ tenantToken: { expiresAt: Date.now() + 60_000 } }} />);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent(`${'a'.repeat(64)}@7:false`));
    await userEvent.click(screen.getByRole('button', { name: 'switch' }));
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent(`${'b'.repeat(64)}@2:false`));
  });

  it('keeps the theme of the session while the published one is being read, and when it cannot be read', async () => {
    const read = vi.fn(() => Promise.reject(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} })));
    render(<Host read={read} session={{ tenantToken: { expiresAt: Date.now() + 60_000 } }} />);
    expect(screen.getByTestId('probe')).toHaveTextContent('session-a@1:false');
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(screen.getByTestId('probe')).toHaveTextContent('session-a@1:false');
  });

  it('reads nothing without a tenant token (a development session carries its own theme)', async () => {
    const read = vi.fn();
    render(<Host read={read} session={{}} />);
    expect(screen.getByTestId('probe')).toHaveTextContent('session-a@1:false');
    expect(read).not.toHaveBeenCalled();
  });

  it('does not remount the screen when the theme arrives, so an open form keeps its values (AC-ST-SAS-005-7)', async () => {
    function Form() {
      const [value, setValue] = useState('');
      return <input aria-label="note" value={value} onChange={(event) => setValue(event.target.value)} />;
    }
    let release: (value: unknown) => void = () => undefined;
    const read = vi.fn(() => new Promise((resolve) => (release = resolve)));
    render(
      <Host read={read} session={{ tenantToken: { expiresAt: Date.now() + 60_000 } }}>
        <Form />
      </Host>,
    );
    await userEvent.type(screen.getByLabelText('note'), 'draft');
    release(published(A.id, 'a'.repeat(64), 7, '#112233'));
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent(`${'a'.repeat(64)}@7:false`));
    expect(screen.getByLabelText('note')).toHaveValue('draft');
  });
});

function LogoProbe() {
  const logo = useTenantLogo();
  return <p data-testid="logo">{logo ?? 'monogram'}</p>;
}

describe('useTenantLogo', () => {
  const token = { tenantToken: { expiresAt: Date.now() + 60_000 } };
  const LOGO = { content_hash: 'f'.repeat(64), mime: 'image/png', content_base64: 'iVBORw0KGgo=' };

  it('reads the logo the published theme names, with the session, and gives it as a data address for the image of the tenant card', async () => {
    const read = vi.fn((operation: string) =>
      Promise.resolve(operation === 'getMyThemeLogo' ? LOGO : { ...published(A.id, 'a'.repeat(64), 2, '#112233'), config: { ...CONFIG, logoAssetId: '00000000-0000-4000-8000-0000000000f1' } }),
    );
    render(
      <Host read={read} session={token}>
        <LogoProbe />
      </Host>,
    );
    await waitFor(() => expect(screen.getByTestId('logo').textContent).toBe('data:image/png;base64,iVBORw0KGgo='));
    expect(read.mock.calls.filter(([operation]) => operation === 'getMyThemeLogo')).toHaveLength(1);
  });

  it('keeps the monogram and never asks for a logo when the published theme names none', async () => {
    const read = vi.fn((operation: string) => Promise.resolve(operation === 'getMyThemeLogo' ? LOGO : published(A.id, 'a'.repeat(64), 2, '#112233')));
    render(
      <Host read={read} session={token}>
        <LogoProbe />
      </Host>,
    );
    await waitFor(() => expect(read).toHaveBeenCalledWith('getMyPublishedTheme'));
    expect(screen.getByTestId('logo').textContent).toBe('monogram');
    expect(read).not.toHaveBeenCalledWith('getMyThemeLogo');
  });

  it('keeps the monogram when the logo cannot be read', async () => {
    const read = vi.fn((operation: string) =>
      operation === 'getMyThemeLogo'
        ? Promise.reject(new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND' } as never))
        : Promise.resolve({ ...published(A.id, 'a'.repeat(64), 2, '#112233'), config: { ...CONFIG, logoAssetId: '00000000-0000-4000-8000-0000000000f1' } }),
    );
    render(
      <Host read={read} session={token}>
        <LogoProbe />
      </Host>,
    );
    await waitFor(() => expect(read).toHaveBeenCalledWith('getMyThemeLogo'));
    expect(screen.getByTestId('logo').textContent).toBe('monogram');
  });
});
