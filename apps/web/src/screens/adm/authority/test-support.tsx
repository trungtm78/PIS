import { ApiError } from '@machvon/api-client';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { mountInSession } from '../../doc/test-support';
import { routeOf } from '../../dgv/test-support';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';

export const uuid = (n: number): string => `00000000-0000-4000-8000-${'0250'}${String(n).padStart(8, '0')}`;
export const problem = (code: string, status = 422, extensions: Record<string, unknown> = {}): ApiError => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions });
export const routeFor = (id: string, req: string) => routeOf(id, req);

export const UNITS = [
  { id: uuid(900), code: 'SO-A', name: 'Unit A' },
  { id: uuid(901), code: 'SO-B', name: 'Unit B' },
];
export const MEMBERS = [
  { id: uuid(601), display_name: 'Nina Receiver', status: 'Active', membership_type: 'STAFF' },
  { id: uuid(602), display_name: 'Left Already', status: 'Suspended', membership_type: 'STAFF' },
];

/** What a read answers: rows, or an error to fail with; `calls` counts the reads of each operation. */
export type Answers = Record<string, unknown[] | Error>;

export interface Opened extends Harness {
  answers: Answers;
  calls: Record<string, Array<Record<string, unknown> | undefined>>;
}

export function open(element: ReactElement, answers: Answers, options: { permissions?: readonly string[] | undefined; mode?: 'FULL' | 'READ_ONLY'; command?: (operation: string, input: unknown) => unknown; path: string }): Opened {
  const h = baseHarness(() => new Error('unexpected read'), options.command);
  const calls: Opened['calls'] = {};
  const all: Answers = { get_resources_organization_unit: UNITS, get_resources_membership: MEMBERS, ...answers };
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string, input?: { query?: Record<string, unknown> }) => {
    (calls[operation] ??= []).push(input?.query);
    const found = all[operation];
    if (found === undefined) return Promise.reject(new Error(`unexpected readAll ${operation}`));
    return found instanceof Error ? Promise.reject(found) : Promise.resolve(found);
  });
  mountInSession(element, h, { permissions: options.permissions, ...(options.mode === undefined ? {} : { mode: options.mode }) }, options.path);
  return { ...h, answers: all, calls };
}

export const commandsCalled = (h: Harness, operation: string): Array<{ path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number }> =>
  h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number });
