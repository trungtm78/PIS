import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ClarificationScreen from './ClarificationScreen';
import { CLERK, client, clarificationId, mount, request, routeOf, world } from './test-support';

const ROUTE = routeOf('BID-11', 'FR-BID-11');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('BID-11 a link to one request (getBidClarification)', () => {
  it('reads that request alone when no package is chosen, and shows it the way the list shows it', async () => {
    const h = client(world());
    h.read.mockImplementation((operation: string) => (operation === 'getBidClarification' ? Promise.resolve(request(1)) : Promise.reject(new Error(`unexpected read ${operation}`))));
    mount(<ClarificationScreen route={ROUTE} />, h, { permissions: CLERK, path: `/bid/bid-11?clarification=${clarificationId(1)}` });
    expect(await screen.findByTestId('opened-request')).toBeTruthy();
    await waitFor(() => expect(document.querySelector(`[data-request="${clarificationId(1)}"]`)).not.toBeNull());
    expect(h.read).toHaveBeenCalledWith('getBidClarification', { path: { id: clarificationId(1) } });
    expect(h.read).not.toHaveBeenCalledWith('listBidClarifications', expect.anything());
  });

  it('shows a request that is not there for the caller (a 404) as an empty answer, never as an error', async () => {
    const h = client(world());
    h.read.mockImplementation(() => Promise.reject(new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' })));
    mount(<ClarificationScreen route={ROUTE} />, h, { permissions: CLERK, path: `/bid/bid-11?clarification=${clarificationId(1)}` });
    await waitFor(() => expect(h.read).toHaveBeenCalled());
    await waitFor(() => expect(document.querySelector('[data-request]')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the list when a package is chosen, and ignores a link that is not an identifier', async () => {
    const h = client(world({ requests: [request(1)] }));
    mount(<ClarificationScreen route={ROUTE} />, h, { permissions: CLERK, path: `/bid/bid-11?package=00000000-0000-4000-8000-0000000000a1&clarification=${clarificationId(1)}` });
    await waitFor(() => expect(h.read).toHaveBeenCalledWith('listBidClarifications', expect.anything()));
    expect(h.read).not.toHaveBeenCalledWith('getBidClarification', expect.anything());
    expect(screen.queryByTestId('opened-request')).toBeNull();
    cleanup();
    const other = client(world());
    mount(<ClarificationScreen route={ROUTE} />, other, { permissions: CLERK, path: '/bid/bid-11?clarification=not-an-id' });
    await waitFor(() => expect(other.read).toHaveBeenCalled());
    expect(other.read).not.toHaveBeenCalledWith('getBidClarification', expect.anything());
  });
});
