import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { builtVersion, isNewer, servedVersion } from '../version';
import { NewVersionBar, VERSION_CHECK_MS, VersionLabel } from './NewVersionBar';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const BUILT = { version: '1.0.7', commit: 'abc123def' };

describe('the release of the build', () => {
  it('is what the build stamped, and nothing for a build without a version', () => {
    expect(builtVersion({ VITE_APP_VERSION: ' 1.0.7 ', VITE_APP_COMMIT: 'abc123def' })).toEqual(BUILT);
    expect(builtVersion({ VITE_APP_VERSION: '1.0.7' })).toEqual({ version: '1.0.7', commit: '' });
    expect(builtVersion({})).toBeUndefined();
    expect(builtVersion({ VITE_APP_VERSION: ' ' })).toBeUndefined();
  });

  it('reads /version.json without a cache, and gives nothing when the server cannot say', async () => {
    const fetcher = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(new Response(JSON.stringify({ version: '1.0.8', commit: 'fff' }), { status: 200 })));
    expect(await servedVersion(fetcher as unknown as typeof fetch)).toEqual({ version: '1.0.8', commit: 'fff' });
    expect(fetcher.mock.calls[0]?.[0]).toBe('/version.json');
    expect(fetcher.mock.calls[0]?.[1]?.cache).toBe('no-store');
    expect(await servedVersion((() => Promise.resolve(new Response('', { status: 404 }))) as unknown as typeof fetch)).toBeUndefined();
    expect(await servedVersion((() => Promise.resolve(new Response('<html>', { status: 200 }))) as unknown as typeof fetch)).toBeUndefined();
    expect(await servedVersion((() => Promise.reject(new Error('offline'))) as unknown as typeof fetch)).toBeUndefined();
  });

  it('is newer when the version differs, or the commit of the same version', () => {
    expect(isNewer(BUILT, { version: '1.0.8', commit: '' })).toBe(true);
    expect(isNewer(BUILT, { version: '1.0.7', commit: 'other' })).toBe(true);
    expect(isNewer(BUILT, { version: '1.0.7', commit: 'abc123def' })).toBe(false);
    expect(isNewer(BUILT, { version: '1.0.7', commit: '' })).toBe(false);
    expect(isNewer(undefined, { version: '1.0.8', commit: '' })).toBe(false);
    expect(isNewer(BUILT, undefined)).toBe(false);
  });

  it('is shown small as "Phiên bản 1.0.7", and not at all for a build without a version', () => {
    render(<VersionLabel built={BUILT} />);
    expect(screen.getByText('Phiên bản 1.0.7')).toBeInTheDocument();
    cleanup();
    const { container } = render(<VersionLabel built={undefined} />);
    expect(container.textContent).toBe('');
  });
});

describe('the bar of a tab that runs an older release', () => {
  it('stays away while the server holds the release of the tab, appears when it holds another, and reloads only when the person asks', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let served = { version: '1.0.7', commit: 'abc123def' };
    const read = vi.fn(() => Promise.resolve(served));
    const reload = vi.fn();
    render(<NewVersionBar built={BUILT} read={read} reload={reload} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
    // A newer release is installed: the next check (the timer, or the tab getting the focus back) finds it.
    served = { version: '1.0.8', commit: 'fff000111' };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VERSION_CHECK_MS);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Hệ thống đã có bản mới.');
    expect(reload).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('asks again when the tab gets the focus back, and asks nothing for a build without a version', async () => {
    const read = vi.fn(() => Promise.resolve(undefined));
    render(<NewVersionBar built={BUILT} read={read} reload={() => undefined} />);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
    cleanup();
    const never = vi.fn(() => Promise.resolve(undefined));
    render(<NewVersionBar built={undefined} read={never} reload={() => undefined} />);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(never).not.toHaveBeenCalled();
  });
});
