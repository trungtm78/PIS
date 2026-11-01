import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { onlineManager } from '@tanstack/react-query';
import { vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { TENANT, harness, mountInSession, routeOf } from '../test-support';
import type { Harness, SessionOptions } from '../test-support';
import IncomingMobileScreen from './IncomingMobileScreen';
import MobileApprovalScreen from './MobileApprovalScreen';

export type { Harness };

export const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
export const fill = (value: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, item]) => out.replace(`{${key}}`, String(item)), value);
export const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
export const lost = () => new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c', extensions: {} });

/** The query client of the application follows the browser: a test that went offline must not leave the next one paused. */
export const resetNetwork = (): void => onlineManager.setOnline(true);

/** Makes the device say whether it has a connection. */
export function setOnline(online: boolean): void {
  vi.spyOn(globalThis.navigator, 'onLine', 'get').mockReturnValue(online);
}

export const INCOMING_ROUTE = routeOf('DOC-23', 'FR-DOC-23');
export const APPROVAL_ROUTE = routeOf('DOC-22', 'FR-DOC-22');

// ---- DOC-23 ---------------------------------------------------------------------------------------------------------------

export const HANDLER = ['doc.incoming.read', 'doc.incoming.process'];
const UNIT = '00000000-0000-4000-8000-000000000f01';
export const letterId = (n: number): string => `00000000-0000-4000-8000-0000000d${String(n).padStart(4, '0')}`;
const actions = (on: Partial<Record<'register' | 'reject' | 'assign' | 'startProcessing' | 'resolve', boolean>> = {}) => ({
  register: false,
  reject: false,
  assign: false,
  startProcessing: false,
  resolve: false,
  ...on,
});
export { actions };

/** A letter as the list answers it: assigned to the signed-in handler, due on the 27th, nothing the caller may do unless the test says so. */
export const letter = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: letterId(n),
  document_id: `00000000-0000-4000-8000-0000000e${String(n).padStart(4, '0')}`,
  status: 'ASSIGNED',
  channel: 'UPLOAD',
  title: `Công văn số ${n}`,
  doc_type_code: 'CV',
  received_at: `2026-10-2${n}T02:00:00.000Z`,
  register: { id: '00000000-0000-4000-8000-000000000a01', code: 'REG-DEN-2026' },
  number: 9 + n,
  symbol: `${9 + n}/REG-DEN-2026`,
  original_symbol: null,
  original_issued_on: null,
  sender_name: 'Bộ Tài chính',
  urgency: 'NORMAL',
  due_on: '2026-10-27',
  leader_directive: 'Chuẩn bị ý kiến.',
  assigned_unit: { id: UNIT, name: 'Phòng Kế hoạch' },
  assignee: { user_id: TENANT.membershipId, display_name: 'Chuyên viên An' },
  resolution_summary: null,
  resolved_at: null,
  late_days: null,
  duplicate_of_id: null,
  rejection_reason: null,
  is_overdue: false,
  overdue_days: null,
  version: 3,
  actions: actions({ startProcessing: true }),
  ...overrides,
});

export function openIncoming(
  letters: Array<Record<string, unknown>>,
  options: SessionOptions & { command?: (operation: string, input: unknown) => unknown; reads?: (operation: string, input: unknown) => Promise<unknown>; page?: number } = {},
): Harness {
  const page = options.page ?? 50;
  const h = harness(
    (operation, input) => {
      if (operation !== 'listIncomingDocuments') return new Error(`unexpected read ${operation}`);
      const cursor = (input as { query?: { cursor?: string } } | undefined)?.query?.cursor;
      const start = cursor === undefined ? 0 : Number(cursor);
      return { items: letters.slice(start, start + page), ...(start + page < letters.length ? { next_cursor: String(start + page) } : {}), as_of: '2026-10-28T04:00:00.000Z' };
    },
    options.command ?? (() => ({ resource_id: letterId(1), resource_version: 4 })),
  );
  if (options.reads !== undefined) h.read.mockImplementation(options.reads);
  mountInSession(<IncomingMobileScreen route={INCOMING_ROUTE} />, h, { ...options, permissions: 'permissions' in options ? options.permissions : HANDLER });
  return h;
}

// ---- DOC-22 ---------------------------------------------------------------------------------------------------------------

export const LEADER = ['doc.outgoing.read', 'doc.outgoing.sign', 'doc.outgoing.review'];
export const DOC = '00000000-0000-4000-8000-0000000000d1';
export const future = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();

export const row = (overrides: Record<string, unknown> = {}) => ({
  id: DOC,
  document_id: '00000000-0000-4000-8000-0000000000d2',
  title: 'Quyết định giao vốn',
  doc_type_code: 'QD',
  status: 'SUBMITTED',
  signer_user_id: TENANT.membershipId,
  signer_title: 'Chủ tịch',
  current_version_id: 'v1',
  leader_signed_at: null,
  created_at: '2026-10-23T02:00:00Z',
  version: 1,
  ...overrides,
});

export const detail = (overrides: Record<string, unknown> = {}) => ({
  ...row(),
  sessions: [],
  versions: [{ id: 'v1', version: 1, stage: 'RENDERED_FINAL', checksum: 'ab'.repeat(32), page_count: 2, scan_status: 'CLEAN', created_at: '2026-10-23T02:00:00Z' }],
  certificates: [{ id: 'c1', kind: 'PERSONAL', subject_dn: 'CN=Nguyen Van A', issuer_dn: 'CN=CA', valid_until: '2027-01-01T00:00:00Z', status: 'Active' }],
  signatures: [],
  ...overrides,
});

export const session = (overrides: Record<string, unknown> = {}) => ({
  id: 's1',
  role: 'LEADER',
  status: 'AWAITING_SIGNER',
  adapter_code: 'REMOTE_CA',
  adapter_status: 'REMOTE',
  expires_at: future(10),
  created_at: new Date().toISOString(),
  version: 1,
  error_code: null,
  ...overrides,
});

export function openApproval(
  options: SessionOptions & {
    queue?: unknown[];
    current?: () => Record<string, unknown>;
    command?: (operation: string, input: unknown) => unknown;
    reads?: (operation: string, input: unknown) => Promise<unknown>;
    path?: string;
  } = {},
): Harness {
  const queue = options.queue ?? [row()];
  const current = options.current ?? (() => detail());
  const h = harness(
    (operation) => {
      if (operation === 'listOutgoingDocuments') return { items: queue, next_cursor: null };
      if (operation === 'getOutgoingDocument') return current();
      if (operation === 'getDocumentVersionDownload') return { url: 'https://files.example/v1.pdf' };
      return new Error(`unexpected read ${operation}`);
    },
    options.command ?? (() => ({ status: 'AWAITING_SIGNER', resource_id: 's1', resource_version: 1 })),
  );
  if (options.reads !== undefined) h.read.mockImplementation(options.reads);
  mountInSession(<MobileApprovalScreen route={APPROVAL_ROUTE} />, h, { ...options, permissions: 'permissions' in options ? options.permissions : LEADER }, options.path ?? '/doc/doc-22');
  return h;
}

/** The bodies of the commands sent, by operation. */
export const sent = (h: Harness, operation: string): Array<Record<string, unknown>> => h.command.mock.calls.filter(([name]) => name === operation).map(([, input]) => input as Record<string, unknown>);
