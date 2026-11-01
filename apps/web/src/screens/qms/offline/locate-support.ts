import { act } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * A device whose position has not come yet: every request waits until the test lets it arrive or fail, so a test can change the form (or take the consent back) in between. `extra` is what else the
 * stubbed navigator says, such as `onLine`.
 */
export function slowDevice(extra: Record<string, unknown> = {}) {
  const waiting: Array<{ success: (position: unknown) => void; failure: () => void }> = [];
  const getCurrentPosition = vi.fn((success: (position: unknown) => void, failure: () => void) => {
    waiting.push({ success, failure });
  });
  vi.stubGlobal('navigator', { ...extra, geolocation: { getCurrentPosition } });
  return {
    getCurrentPosition,
    /** The oldest request that has not been answered gets this position. */
    arrive: (latitude = 10.8123456, longitude = 106.7123456, accuracy = 12.345): void => {
      act(() => waiting.shift()?.success({ coords: { latitude, longitude, accuracy } }));
    },
    /** The oldest request that has not been answered fails. */
    fail: (): void => {
      act(() => waiting.shift()?.failure());
    },
  };
}
