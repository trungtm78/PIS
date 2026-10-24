import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ApiClientProvider } from '../../api/ApiClientContext';
import { ALL_MODULES_VISIBLE } from '../../navigation/model';
import type { WebRoute } from '../../routes/types';
import { SessionContext } from '../../session/SessionContext';
import type { SessionValue } from '../../session/SessionContext';
import { vi } from 'vitest';
import { harness } from '../sas/test-support';
import type { Harness } from '../sas/test-support';

export { harness };
export type { Harness };

export type Answer = Array<Record<string, unknown>> | Error;

/**
 * A client whose commands are answered by `command` and whose catalogue read (`readAll` of `listMneForms`, which follows the cursors) is answered by
 * `rows`: a list of rows, or a failure. `readAll` is the spy to look at the filters the screen sent.
 */
export function formsClient(
  rows: (query: unknown) => Answer,
  command: (operation: string, input: unknown) => unknown = () => ({}),
  rules: () => Answer = () => [],
): Harness & { readAll: ReturnType<typeof vi.fn> } {
  const h = harness((operation) => new Error(`unexpected read ${operation}`), command);
  const readAll = vi.fn((operation: string, input?: { query?: unknown }) => {
    if (operation !== 'listMneForms' && operation !== 'listMneObligationRules') return Promise.reject(new Error(`unexpected readAll ${operation}`));
    const answer = operation === 'listMneForms' ? rows(input?.query) : rules();
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}

export const TENANT = { id: '00000000-0000-4000-8000-00000000000a', name: 'Cao Bang', monogram: 'CB', membershipId: '00000000-0000-4000-8000-000000000001', theme: { themeId: 'tenant', version: 1, overlay: {} } };
export const SECOND_TENANT = { ...TENANT, id: '00000000-0000-4000-8000-00000000000b', name: 'Lang Son', monogram: 'LS' };

export const ME = TENANT.membershipId;
export const OTHER = '00000000-0000-4000-8000-0000000000aa';

export const READ = 'mne.read';
export const MANAGE_FORMS = 'mne.form.manage';
export const APPROVE_FORMS = 'mne.form.approve';
export const MANAGE_CALENDAR = 'mne.calendar.manage';
export const READER = [READ];
export const FORM_ADMIN = [READ, MANAGE_FORMS, APPROVE_FORMS];
export const PLANNER = [READ, MANAGE_CALENDAR];
export const APPROVE_CALENDAR = 'mne.calendar.approve';
export const RULE_ADMIN = [READ, MANAGE_CALENDAR, APPROVE_CALENDAR];

export function routeOf(id: string, req: string): WebRoute {
  return { id, path: `/mne/${id.toLowerCase()}`, title: id, kind: 'table', area: 'insights', module: 'MNE', group: 'Calendar and forms', role: 'workspace', parent: null, req };
}

export interface SessionOptions {
  permissions?: readonly string[] | undefined;
  mode?: SessionValue['mode'];
  tenant?: typeof TENANT;
}

/** Mounts a screen in a session whose permissions, mode and tenant `rerenderWith` changes while the screen stays mounted. */
export function mount(screen: ReactElement, h: Harness, options: SessionOptions = {}, path = '/'): RenderResult & { queries: QueryClient; rerenderWith(next: SessionOptions): void } {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = (current: SessionOptions): ReactElement => {
    const tenant = current.tenant ?? TENANT;
    const session: SessionValue = {
      tenant,
      tenants: [TENANT, SECOND_TENANT],
      user: { displayName: 'Clerk', initials: 'CK' },
      access: ALL_MODULES_VISIBLE,
      switchTenant: () => undefined,
      getSession: () => Promise.resolve({ token: 'token' }),
      permissions: 'permissions' in current ? current.permissions : FORM_ADMIN,
      ...(current.mode === undefined ? {} : { mode: current.mode }),
    };
    return (
      <SessionContext.Provider value={session}>
        <QueryClientProvider client={queries}>
          <ApiClientProvider client={h.client}>
            <MemoryRouter initialEntries={[path]}>{screen}</MemoryRouter>
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>
    );
  };
  const view = render(tree(options));
  return { queries, ...view, rerenderWith: (next) => view.rerender(tree(next)) };
}

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A row of `listMneForms`, in the shape the server writes it. */
export const formRow = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid(100 + n),
  form_code: `TT44-M0${n}`,
  revision: 1,
  title: `Báo cáo giám sát mẫu ${n}`,
  report_kind: 'OVERALL_SEMIANNUAL',
  legal_basis: 'Thông tư 44/2026/TT-BTC [CXN-10]',
  legal_confirmation_ref: null,
  awaiting_confirmation: true,
  cxn_refs: ['CXN-10'],
  watermark_text: 'Mẫu chờ xác nhận pháp lý [CXN-10]',
  effective_from: '2026-01-01',
  effective_until: null,
  doc_template_code: `MNE-TT44-M0${n}`,
  doc_template_id: uuid(200 + n),
  export_formats: ['XLSX', 'PDF'],
  status: 'PUBLISHED',
  origin: 'PLATFORM_PACK',
  pack_version: '2026.10.1',
  version: 2,
  created_by: OTHER,
  approved_by: null,
  ...overrides,
});

/** A row of `listMneObligationRules`, in the shape the server writes it. */
export const ruleRow = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid(600 + n),
  rule_code: `OVERALL_RULE_${n}`,
  revision: 1,
  form_id: uuid(100 + n),
  form_code: 'TT44-M02',
  reporting_role: 'INVESTOR',
  recipient: 'Sở Tài chính',
  frequency: 'SEMIANNUAL',
  due_rule_json: { period: 'H1', month: 7, day: 10 },
  legal_basis: 'Thông tư 44/2026/TT-BTC, trước ngày 10 tháng 7 [CXN-10]',
  legal_confirmation_ref: null,
  awaiting_confirmation: true,
  cxn_refs: ['CXN-10'],
  effective_from: '2026-01-01',
  effective_until: null,
  status: 'PUBLISHED',
  origin: 'TENANT',
  pack_version: null,
  version: 2,
  created_by: OTHER,
  approved_by: null,
  ...overrides,
});

/** A row of `listMneObligations`, in the shape the server writes it. */
export const obligationRow = (n: number, overrides: Record<string, unknown> = {}) => ({
  mne_report_id: uuid(300 + n),
  obligation_rule_id: uuid(400 + n),
  rule_code: 'OVERALL_SEMIANNUAL',
  rule_revision: 1,
  reporting_role: 'INVESTOR',
  recipient: 'Cơ quan chủ quản',
  form_id: uuid(100 + n),
  form_code: 'TT44-M02',
  form_revision: 1,
  form_title: 'Báo cáo giám sát, đánh giá tổng thể 6 tháng',
  report_year: 2026,
  period_label: 'H1-2026',
  scope_unit_id: uuid(500 + n),
  unit_code: `CDT-${n}`,
  unit_name: `Chủ đầu tư ${n}`,
  due_date: '2026-07-10',
  status: 'DRAFT',
  is_late: false,
  days_late: 0,
  legal_basis: 'Thông tư 44/2026/TT-BTC, báo cáo trước ngày 10 tháng 7 [CXN-10]',
  awaiting_confirmation: true,
  cxn_refs: ['CXN-10'],
  ...overrides,
});
