import type { ApiClient } from '@machvon/api-client';
import { ApiError } from '@machvon/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { ApiClientProvider } from '../../api/ApiClientContext';
import part from '../../i18n/vi.json';
import vi_ from '../../i18n/vi.json';
import { ALL_MODULES_VISIBLE } from '../../navigation/model';
import type { WebRoute } from '../../routes/types';
import { SessionContext } from '../../session/SessionContext';
import type { SessionMode, SessionValue } from '../../session/SessionContext';

export const TENANT = { id: '00000000-0000-4000-8000-0000000000aa', name: 'Cao Bằng', monogram: 'CB', membershipId: '00000000-0000-4000-8000-0000000000e9', theme: { themeId: 'platform', version: 1, overlay: {} } };

const catalogue = { ...(vi_ as Record<string, string>), ...(part as Record<string, string>) };
/** The words of a key in Vietnamese, with its parameters filled in, as the screen writes them. */
export const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replaceAll(`{${name}}`, String(value)), catalogue[key] ?? key);

export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const routeOf = (id: string): WebRoute => ({ id, path: `/dir/${id.toLowerCase()}`, title: id, kind: 'table', area: 'overview', module: 'DIR', group: 'Chỉ đạo giao ban', role: 'workspace', parent: null, req: `FR-${id}` });
export const refusal = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

export interface Harness {
  client: ApiClient;
  read: ReturnType<typeof vi.fn>;
  readAll: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
}

export const UNIT_A = uuid(101);
export const UNIT_B = uuid(102);
export const PROJECT_A = uuid(111);
export const MEMBER_A = uuid(121);
const LOOKUPS: Record<string, unknown[]> = {
  get_resources_organization_unit: [
    { id: UNIT_A, code: 'BQL1', name: 'Ban quản lý 1' },
    { id: UNIT_B, code: 'SXD', name: 'Sở Xây dựng' },
  ],
  get_resources_project: [{ id: PROJECT_A, code: 'DA-01', name: 'Đường tỉnh 205' }],
  get_resources_membership: [{ id: MEMBER_A, display_name: 'Nguyễn Văn A' }],
};

/** A client whose reads are answered by `answer(operation, input)` (a value, or an Error to reject with), whose lookups are fixed and whose commands are answered by `command`. */
export function harness(answer: (operation: string, input: unknown) => unknown, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const respond = (value: unknown) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
  const read = vi.fn((operation: string, input?: unknown) => respond(answer(operation, input)));
  const readAll = vi.fn((operation: string) => respond(LOOKUPS[operation] ?? []));
  const cmd = vi.fn((operation: string, input: unknown) => respond(command(operation, input)));
  return { client: { read, readAll, command: cmd } as unknown as ApiClient, read, readAll, command: cmd };
}

export function mount(screen: ReactElement, h: Harness, options: { permissions?: readonly string[] | undefined; mode?: SessionMode; path?: string } = {}): RenderResult & { queries: QueryClient } {
  const session: SessionValue = {
    tenant: TENANT,
    tenants: [TENANT],
    user: { displayName: 'Thư ký', initials: 'TK' },
    access: ALL_MODULES_VISIBLE,
    switchTenant: () => undefined,
    getSession: () => Promise.resolve({ token: 'token' }),
    permissions: options.permissions,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  };
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    queries,
    ...render(
      <SessionContext.Provider value={session}>
        <QueryClientProvider client={queries}>
          <ApiClientProvider client={h.client}>
            <MemoryRouter initialEntries={[options.path ?? '/']}>{screen}</MemoryRouter>
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>,
    ),
  };
}

// -- Server answers ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const AS_OF = '2026-11-08T03:00:00.000Z';
export const POLICY = { code: 'DEFAULT', version: null, source: 'DEFAULT', unverified: true, reminder_days_before: [3, 1, 0], escalate_after_overdue_days: 7, max_extensions: 3, max_extension_days: 60, close_requires_evidence: true };
const person = (n: number, name: string) => ({ membership_id: uuid(n), display_name: name });

export function directive(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uuid(200 + n),
    code: `GB-2026-001/CD-0${n}`,
    seq: n,
    meeting: { id: uuid(301), code: 'GB-2026-001', meeting_date: '2026-10-01', title: 'Giao ban tuần 40' },
    scope_kind: 'PROJECT',
    project: { id: PROJECT_A, code: 'DA-01', name: 'Đường tỉnh 205' },
    scope_unit: { id: UNIT_A, code: 'BQL1', name: 'Ban quản lý 1' },
    text: `Hoàn thành thủ tục giải phóng mặt bằng đợt ${n}.`,
    assignee_unit: { id: UNIT_A, code: 'BQL1', name: 'Ban quản lý 1' },
    assignee: person(121, 'Nguyễn Văn A'),
    original_due_on: '2026-11-20',
    due_on: '2026-11-20',
    extension_count: 0,
    status: 'OPEN',
    stored_status: 'OPEN',
    phase: 'DUE_LATER',
    days_to_due: 12,
    overdue_days: 0,
    reminder_today: false,
    escalates_on: '2026-11-27',
    closed_at: null,
    evidence_count: 0,
    open_extension: null,
    created_by: person(122, 'Trần Thị B'),
    created_at: '2026-10-01T02:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

export const overdueDirective = (n: number) => directive(n, { status: 'OVERDUE', phase: 'OVERDUE', due_on: '2026-11-03', original_due_on: '2026-11-03', days_to_due: -5, overdue_days: 5 });

export function meeting(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uuid(300 + n),
    code: `GB-2026-00${n}`,
    meeting_date: '2026-10-01',
    meeting_type: 'WEEKLY',
    title: `Giao ban tuần ${n}`,
    summary: null,
    unit: { id: UNIT_A, code: 'BQL1', name: 'Ban quản lý 1' },
    minutes_document_version_id: null,
    created_by: uuid(122),
    created_at: '2026-10-01T02:00:00.000Z',
    version: 3,
    counts: { total: 4, by_status: { OPEN: 1, IN_PROGRESS: 1, DONE: 1, OVERDUE: 1, CANCELLED: 0 } },
    ...overrides,
  };
}

export const summary = {
  total: 9,
  by_status: { OPEN: 3, IN_PROGRESS: 2, DONE: 1, OVERDUE: 2, CANCELLED: 1 },
  due_soon: 2,
  escalated: 1,
  by_unit: [
    { unit: { id: UNIT_A, code: 'BQL1', name: 'Ban quản lý 1' }, total: 6, open: 3, overdue: 2, done: 1 },
    { unit: { id: UNIT_B, code: 'SXD', name: 'Sở Xây dựng' }, total: 3, open: 2, overdue: 0, done: 0 },
  ],
  truncated: false,
  definitions: { by_status: 'Số chỉ đạo theo trạng thái mà người đọc thấy.', due_soon: 'Chỉ đạo chưa xong có hạn trong 3 ngày.', escalated: 'Chỉ đạo quá hạn từ 7 ngày trở lên.', by_unit: 'Theo đơn vị.' },
  policy: POLICY,
  as_of: AS_OF,
};

export const page = (items: unknown[], next: string | null = null) => ({ items, next_cursor: next, as_of: AS_OF });
