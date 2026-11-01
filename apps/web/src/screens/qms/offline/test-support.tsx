import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { ApiClientProvider } from '../../../api/ApiClientContext';
import vi_ from '../../../i18n/vi.json';
import { ALL_MODULES_VISIBLE } from '../../../navigation/model';
import { SessionContext } from '../../../session/SessionContext';
import type { SessionStatus, SessionTenant, SessionTenantToken } from '../../../session/SessionContext';
import { TENANT, contractId, mount } from '../../ctr/test-support';
import { actions, client, copy, diary, diaryId, routeOf, world } from '../diary/test-support';
import type { Harness, World } from '../diary/test-support';
import OfflineDiaryScreen from './OfflineDiaryScreen';
import type { WebRoute } from '../../../routes/types';
import { queueKey } from './store';

export { actions, copy, diary, diaryId, world };
export type { World };

export const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
export const fill = (value: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, item]) => out.replace(`{${key}}`, String(item)), value);
export const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
export const lost = () => new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c', extensions: {} });

export const ROUTE = routeOf('QMS-09', 'FR-QMS-09');
/** The same screen as a route that names no requirement. */
export const ROUTE_WITHOUT_REQ: WebRoute = { ...ROUTE, req: null };
/** The contractor's site engineer: reads and writes diaries, reads contracts and signs as the contractor. */
export const ENGINEER = ['site_diary.read', 'diary.write', 'contract.read', 'diary.sign.contractor'];
export const OWN_KEY = queueKey(TENANT.id, TENANT.membershipId);
export const OTHER_KEY = queueKey('00000000-0000-4000-8000-0000000000bb', TENANT.membershipId);
export const CONTRACT = contractId(2);

export function open(
  state: World = world(),
  options: {
    permissions?: readonly string[] | undefined;
    mode?: 'FULL' | 'READ_ONLY';
    route?: WebRoute;
    command?: (operation: string, input: unknown) => unknown;
    reads?: (operation: string, input: unknown) => Promise<unknown>;
  } = {},
): Harness {
  const h = client(state, options.command);
  if (options.reads !== undefined) h.read.mockImplementation(options.reads);
  mount(<OfflineDiaryScreen route={options.route ?? ROUTE} />, h, {
    permissions: 'permissions' in options ? options.permissions : ENGINEER,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    path: '/qms/qms-09',
  });
  return h;
}

interface Allowed {
  permissions: readonly string[];
  mode: 'FULL' | 'READ_ONLY';
  /** The tenant the session switches to; the one of the tests when none is given. */
  tenant?: SessionTenant;
  /** The state of the sign-in, when the test is about the session being made again. */
  status?: SessionStatus;
  tenantToken?: SessionTenantToken;
}

/** The screen opened as `open` does, with a way to change what the session may do while the screen stays mounted (a role granted, a freeze lifted). */
export function openChanging(state: World, options: Allowed, command?: (operation: string, input: unknown) => unknown) {
  const h = client(state, command);
  const mounted = mount(<OfflineDiaryScreen route={ROUTE} />, h, { ...options, path: '/qms/qms-09' });
  const change = (next: Allowed): void =>
    mounted.rerender(
      <SessionContext.Provider
        value={{
          tenant: next.tenant ?? TENANT,
          tenants: [next.tenant ?? TENANT],
          user: { displayName: 'Admin', initials: 'AD' },
          access: ALL_MODULES_VISIBLE,
          switchTenant: () => undefined,
          getSession: () => Promise.resolve({ token: 'token' }),
          permissions: next.permissions,
          mode: next.mode,
          ...(next.status === undefined ? {} : { status: next.status }),
          ...(next.tenantToken === undefined ? {} : { tenantToken: next.tenantToken }),
        }}
      >
        <QueryClientProvider client={mounted.queries}>
          <ApiClientProvider client={h.client}>
            <MemoryRouter initialEntries={['/qms/qms-09']}>
              <OfflineDiaryScreen route={ROUTE} />
            </MemoryRouter>
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>,
    );
  return { h, change, unmount: mounted.unmount };
}

/** A diary left on the device, as the storage keeps it. */
export const PENDING_ENTRY = {
  clientOperationId: '00000000-0000-4000-8000-0000000000e1',
  contractId: '00000000-0000-4000-8000-000000000002',
  contractCode: 'HD-A-002',
  recordDate: '2026-10-20',
  content: { summary: 'x' },
  baseServerVersion: 4,
  queuedAt: '2026-10-20T01:00:00.000Z',
  state: 'PENDING',
  reason: null,
};

/** Makes the device say whether it has a connection. */
export function setOnline(online: boolean): void {
  vi.spyOn(globalThis.navigator, 'onLine', 'get').mockReturnValue(online);
}

/** The device comes back (or goes away): the browser tells the page. */
export function signal(online: boolean): void {
  setOnline(online);
  fireEvent(window, new Event(online ? 'online' : 'offline'));
}

export const type = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

/** Fills the form of a new diary of a day for the contract of the test. */
export async function fillDiary(summary = 'Đổ bê tông móng', date = '2026-10-24'): Promise<void> {
  await screen.findByRole('option', { name: /HD-A-002/ });
  type(word('qms.diary.field.contract'), CONTRACT);
  type(word('qms.diary.field.date'), date);
  type(word('qms.diary.field.summary'), summary);
}

export const keep = (): void => {
  fireEvent.click(screen.getByRole('button', { name: word('qms.offline.compose.submit') }));
};

/** The bodies of the commands sent, by operation. */
export const sent = (h: Harness, operation: string): Array<Record<string, unknown>> =>
  h.command.mock.calls.filter(([name]) => name === operation).map(([, input]) => (input as { body: Record<string, unknown> }).body);

export const stored = (key = OWN_KEY): Array<Record<string, unknown>> => JSON.parse(globalThis.localStorage.getItem(key) ?? '[]') as Array<Record<string, unknown>>;

/** Web Locks that grant a request only when the test says so, to hold a tab at the moment it waits for the lock. */
export function heldLocks(): { grant(): Promise<void> } {
  const waiting: Array<() => void> = [];
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_name: string, run: () => unknown) => new Promise((resolve) => waiting.push(() => resolve(run()))),
    },
  });
  return {
    grant: () =>
      act(async () => {
        waiting.splice(0).forEach((granted) => granted());
        await new Promise((resolve) => setTimeout(resolve, 20));
      }),
  };
}
