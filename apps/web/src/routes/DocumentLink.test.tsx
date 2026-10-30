import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientProvider } from '../api/ApiClientContext';
import vi_ from '../i18n/vi.json';
import { ALL_MODULES_VISIBLE } from '../navigation/model';
import { SessionContext } from '../session/SessionContext';
import type { SessionTenant, SessionValue } from '../session/SessionContext';
import { harness } from '../screens/sas/test-support';
import { DocumentLink } from './DocumentLink';

// The sign-in itself belongs to the session; here only that it is what a signed-out person is given.
vi.mock('../session/oidc/SignInGate', () => ({ SignInGate: () => <p data-testid="gate">sign in</p> }));

const TENANT: SessionTenant = { id: '00000000-0000-4000-8000-00000000000a', name: 'Cao Bang', monogram: 'CB', membershipId: '00000000-0000-4000-8000-000000000001', theme: { themeId: 'tenant', version: 1, overlay: {} } };
const ID = '00000000-0000-4000-8000-0000000000d1';

afterEach(cleanup);

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function open(path: string, answer: () => unknown, session: Partial<SessionValue> = {}, withLink = false) {
  const h = harness(answer);
  const value: SessionValue = {
    tenant: TENANT,
    tenants: [TENANT],
    user: { displayName: 'Person', initials: 'PE' },
    access: ALL_MODULES_VISIBLE,
    switchTenant: () => undefined,
    getSession: () => Promise.resolve({ token: 'token' }),
    permissions: undefined,
    ...session,
  };
  render(
    <SessionContext.Provider value={value}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
        <ApiClientProvider client={h.client}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route
                path="/d/:id"
                element={
                  <>
                    {withLink ? <Link to="/d/00000000-0000-4000-8000-0000000000d2">next</Link> : null}
                    <DocumentLink />
                  </>
                }
              />
              <Route path="*" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
  return h;
}

describe('the opaque link of a message to a person (AC-ST-OMNI-005-5, BR-NOT-11)', () => {
  it('asks the server for the document version it names with the session of the person, and shows what the server gives', async () => {
    const h = open(`/d/${ID.toUpperCase()}`, () => ({ id: ID, version: 3, mime: 'application/pdf', page_count: 12, classification: 'INTERNAL' }));
    expect(await screen.findByText('application/pdf')).toBeTruthy();
    expect(document.querySelector('[data-version]')?.textContent).toBe('3');
    expect(document.querySelector('[data-pages]')?.textContent).toBe('12');
    expect(document.querySelector('[data-classification]')?.textContent).toBe('INTERNAL');
    expect(h.read.mock.calls[0]).toEqual(['get_resources_document_version_id', { path: { id: ID } }]);
  });

  it('asks for the file each time it is opened, with the session of the person, and opens the address the server gives; a refusal is told in words and the button stays', async () => {
    const windows: Array<{ opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> }> = [];
    const opened = vi.spyOn(window, 'open').mockImplementation(() => {
      const popup = { opener: 'the page', location: { href: '' }, close: vi.fn() };
      windows.push(popup);
      return popup as unknown as Window;
    });
    let calls = 0;
    const h = open(`/d/${ID}`, () => ({ version: 3 }));
    h.read.mockImplementation((operation: string) => {
      if (operation === 'getDocumentVersionDownload') return (calls += 1) === 1 ? Promise.reject(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })) : Promise.resolve({ url: `https://files.example.test/a.pdf?signature=${calls}` });
      return Promise.resolve({ version: 3, mime: 'application/pdf', page_count: 2, classification: 'INTERNAL' });
    });
    fireEvent.click(await screen.findByRole('button', { name: vi_['doc.link.download.action'] }));
    expect(await screen.findByText(vi_['doc.link.download.failed'])).toBeTruthy();
    // The window is opened in the click and the refused one is closed again.
    expect(windows[0]?.close).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: vi_['doc.link.download.action'] }));
    await waitFor(() => expect(windows[1]?.location.href).toBe('https://files.example.test/a.pdf?signature=2'));
    expect(windows[1]?.opener).toBeNull();
    expect(windows[1]?.close).not.toHaveBeenCalled();
    // The address lasts a few minutes: a page left open asks for a new one, and the button is still there.
    fireEvent.click(screen.getByRole('button', { name: vi_['doc.link.download.action'] }));
    await waitFor(() => expect(windows[2]?.location.href).toBe('https://files.example.test/a.pdf?signature=3'));
    expect(opened).toHaveBeenCalledTimes(3);
    expect(h.read.mock.calls.filter((call) => call[0] === 'getDocumentVersionDownload')).toHaveLength(3);
    opened.mockRestore();
  });

  it('starts over for another document: the state of the first is not carried to the second', async () => {
    const other = '00000000-0000-4000-8000-0000000000d2';
    const windows: Array<{ opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> }> = [];
    const opened = vi.spyOn(window, 'open').mockImplementation(() => {
      const popup = { opener: 'the page', location: { href: '' }, close: vi.fn() };
      windows.push(popup);
      return popup as unknown as Window;
    });
    const h = open(`/d/${ID}`, () => ({}), {}, true);
    h.read.mockImplementation((operation: string, input: unknown) => (operation === 'getDocumentVersionDownload' ? Promise.resolve({ url: `https://files.example.test/${(input as { path: { id: string } }).path.id}.pdf` }) : Promise.resolve({ version: 1 })));
    fireEvent.click(await screen.findByRole('button', { name: vi_['doc.link.download.action'] }));
    await waitFor(() => expect(windows[0]?.location.href).toBe(`https://files.example.test/${ID}.pdf`));
    fireEvent.click(screen.getByRole('link', { name: 'next' }));
    await waitFor(() => expect(document.querySelector('[data-document-details]')).not.toBeNull());
    fireEvent.click(await screen.findByRole('button', { name: vi_['doc.link.download.action'] }));
    await waitFor(() => expect(windows[1]?.location.href).toBe(`https://files.example.test/${other}.pdf`));
    opened.mockRestore();
  });

  it('goes to the address in this window when the browser does not let another one open', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign } });
    try {
      const h = open(`/d/${ID}`, () => ({}));
      h.read.mockImplementation((operation: string) => (operation === 'getDocumentVersionDownload' ? Promise.resolve({ url: 'https://files.example.test/b.pdf' }) : Promise.resolve({ version: 1 })));
      fireEvent.click(await screen.findByRole('button', { name: vi_['doc.link.download.action'] }));
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://files.example.test/b.pdf'));
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
      opened.mockRestore();
    }
  });

  it('says it could not make the address when the server gives none', async () => {
    const h = open(`/d/${ID}`, () => ({}));
    h.read.mockImplementation((operation: string) => (operation === 'getDocumentVersionDownload' ? Promise.resolve({}) : Promise.resolve({ version: 1 })));
    fireEvent.click(await screen.findByRole('button', { name: vi_['doc.link.download.action'] }));
    expect(await screen.findByText(vi_['doc.link.download.failed'])).toBeTruthy();
  });

  it('shows what is missing of the answer as empty, never as a figure', async () => {
    open(`/d/${ID}`, () => null);
    await waitFor(() => expect(document.querySelector('[data-document-details]')).not.toBeNull());
    expect(document.querySelector('[data-version]')?.textContent).toBe('');
    expect(document.querySelector('[data-pages]')?.textContent).toBe('');
  });

  it('says refused for a document the person may not read and for one that is not there, in the same words', async () => {
    for (const status of [403, 404]) {
      open(`/d/${ID}`, () => new ApiError({ status, code: status === 403 ? 'SCOPE_DENIED' : 'RESOURCE_NOT_FOUND', correlationId: 'c' }));
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      cleanup();
    }
  });

  it('shows the signed-out, offline and error states, and a loading state first', async () => {
    const loading = open(`/d/${ID}`, () => new Promise(() => undefined));
    expect(loading.read).toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    cleanup();
    for (const [error, title] of [
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      open(`/d/${ID}`, () => error);
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
  });

  it('asks nobody who has not chosen a tenant yet, and says not found for what is not the shape of a document version', () => {
    const h = open(`/d/${ID}`, () => ({}), { tenant: undefined });
    expect(screen.getByText(vi_['states.signedOut.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
    cleanup();
    open('/d/short', () => ({}));
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('sends a person who is known but has not chosen a tenant to choose one, and back here after', () => {
    const h = open(`/d/${ID}`, () => ({}), { status: 'identified', tenant: undefined });
    expect(screen.getByTestId('where').textContent).toBe(`/iam/iam-04?next=${encodeURIComponent(`/d/${ID}`)}`);
    expect(h.read).not.toHaveBeenCalled();
  });

  it('sends a person who is not signed in through the sign-in first', () => {
    const signIn = vi.fn();
    const h = open(`/d/${ID}`, () => ({}), { status: 'signedOut', signIn, tenant: undefined });
    expect(h.read).not.toHaveBeenCalled();
    expect(screen.getByTestId('gate')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: vi_['doc.link.page.title'] })).toBeNull();
  });
});
