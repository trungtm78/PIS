import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { ApiClientProvider } from '../../../../api/ApiClientContext';
import { ALL_MODULES_VISIBLE } from '../../../../navigation/model';
import type { WebRoute } from '../../../../routes/types';
import { SessionContext } from '../../../../session/SessionContext';
import type { SessionTenant, SessionValue } from '../../../../session/SessionContext';
import { harness } from '../../../sas/test-support';
import type { Harness } from '../../../sas/test-support';

export type { Harness };

export const ALL = ['doc.repo.read', 'doc.repo.upload', 'doc.repo.comment', 'doc.repo.review.submit'];
export const READER = ['doc.repo.read'];
export const AS_OF = '2026-11-08T03:00:00.000Z';

export const route = (id: string): WebRoute => ({ id, path: `/doc/${id.toLowerCase()}`, title: id, kind: 'table', area: 'overview', module: 'DOC', group: 'Hồ sơ dự án', role: 'workspace', parent: null, req: `FR-${id}` });

export const uuid = (family: number, n: number): string => `00000000-0000-4000-8000-${String(family).padStart(4, '0')}${String(n).padStart(8, '0')}`;
export const PROJECT = { id: uuid(1, 1), code: 'DA-01', name: 'Cầu Bằng Giang' };
export const DOCUMENT = uuid(2, 1);
export const VERSION_1 = uuid(3, 1);
export const VERSION_2 = uuid(3, 2);
export const REVIEW = uuid(4, 1);
export const SHA = 'a'.repeat(64);
export const KEY = `tenants/${uuid(0, 10)}/document/${uuid(5, 1)}`;
export const citation = (n: number): string => `cit_${String(n).padStart(20, '0')}`;

export const summary = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(2, n),
  project: PROJECT,
  contract: { id: uuid(6, 1), code: 'HD-01' },
  package: { id: uuid(7, 1), code: 'GT-03' },
  doc_class: 'DESIGN',
  title: `Thiết kế cơ sở gói ${n}`,
  reference: `TK-0${n}`,
  security_class: 'INTERNAL',
  effective_from: '2026-01-01',
  effective_to: '2026-12-31',
  effective_state: 'IN_FORCE',
  note: null,
  status: 'ACTIVE',
  archive_reason: null,
  current_version: { id: VERSION_2, version_no: 2, status: 'DRAFT', format: 'DOCX' },
  approved_version: { id: VERSION_1, version_no: 1 },
  version_count: 2,
  latest_review: { id: REVIEW, round: 1, status: 'APPROVED' },
  version: 3,
  created_at: '2026-11-01T02:00:00.000Z',
  created_by: uuid(8, 1),
  updated_at: '2026-11-05T02:00:00.000Z',
  updated_by: uuid(8, 1),
  ...over,
});

export const versionView = (no: number, over: Record<string, unknown> = {}) => ({
  id: no === 1 ? VERSION_1 : VERSION_2,
  document_id: DOCUMENT,
  version_no: no,
  file_sha256: SHA,
  size_bytes: 20480,
  format: 'DOCX',
  page_count: null,
  extraction_status: 'EXTRACTED',
  extraction_engine: 'machvon-local-reader 1',
  unit_count: 3,
  truncated_units: 0,
  status: no === 1 ? 'APPROVED' : 'DRAFT',
  change_note: no === 1 ? 'Bản đầu' : 'Sửa đơn giá',
  locked: no === 1,
  locked_at: no === 1 ? '2026-11-03T04:00:00.000Z' : null,
  locked_by_name: no === 1 ? 'Phạm Thị Lan' : null,
  open_comments: no === 1 ? 1 : 0,
  created_at: '2026-11-01T02:00:00.000Z',
  created_by_name: 'Nguyễn Văn An',
  ...over,
});

export const round = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(4, n),
  document_id: DOCUMENT,
  version_id: VERSION_1,
  version_no: 1,
  round: n,
  previous_review_id: null,
  status: 'APPROVED',
  submitted_by_name: 'Nguyễn Văn An',
  submitted_at: '2026-11-02T02:00:00.000Z',
  submit_note: null,
  concluded_at: '2026-11-03T04:00:00.000Z',
  conclusion_note: null,
  version: 3,
  ...over,
});

export const detail = (over: Record<string, unknown> = {}, actions: Record<string, unknown> = {}) => ({
  document: summary(1),
  versions: [versionView(2), versionView(1)],
  rounds: [round(1)],
  actions: { update: true, add_version: true, archive: true, restore: false, comment: true, submit_for_review: true, withdraw_review: false, ...actions },
  as_of: AS_OF,
  ...over,
});

export const versionDetail = (no: number, over: Record<string, unknown> = {}, actions: Record<string, unknown> = {}) => ({
  version: versionView(no),
  document: summary(1),
  outline: { pages: [], sheets: [] },
  citation_example: null,
  actions: { comment: true, re_extract: false, download: true, ...actions },
  as_of: AS_OF,
  ...over,
});

export const unit = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(9, n),
  seq: n,
  citation_id: citation(n),
  citation_ref: `docver:${VERSION_1}#${citation(n)}`,
  kind: 'PARAGRAPH',
  locator: `para${n}`,
  label: `para${n}`,
  page: null,
  paragraph: n,
  sheet: null,
  cell: null,
  box: null,
  text: `Điều ${n}. Nội dung của đoạn thứ ${n}`,
  text_sha256: SHA,
  confidence: null,
  open_comments: 0,
  ...over,
});

export const comment = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(10, n),
  version_id: VERSION_1,
  citation_id: citation(2),
  citation_label: 'para2',
  parent_id: null,
  review_id: null,
  body: `Cần bổ sung căn cứ cho đoạn ${n}`,
  author_name: 'Lê Thị Hoa',
  author_id: uuid(8, 2),
  status: 'OPEN',
  resolved_by: null,
  resolved_at: null,
  resolution_note: null,
  created_at: '2026-11-04T02:00:00.000Z',
  ...over,
});

const ref = (n: number, text: string) => ({ citation_id: citation(n), label: `para${n}`, kind: 'PARAGRAPH', text, seq: n });
export const entry = (op: string, over: Record<string, unknown> = {}) => ({ op, before: null, after: null, words: null, ...over });

export const comparison = (over: Record<string, unknown> = {}) => ({
  document_id: DOCUMENT,
  from: { id: VERSION_1, version_no: 1, status: 'APPROVED', locked: true },
  to: { id: VERSION_2, version_no: 2, status: 'DRAFT', locked: false },
  mode: 'SEQUENCE',
  summary: { equal: 2, added: 1, removed: 0, changed: 1 },
  entries: [
    entry('EQUAL', { before: ref(1, 'Điều 1'), after: ref(1, 'Điều 1') }),
    entry('EQUAL', { before: ref(2, 'Điều 2'), after: ref(2, 'Điều 2') }),
    entry('CHANGED', {
      before: ref(3, 'Giá trị là 100 tỷ'),
      after: ref(3, 'Giá trị là 120 tỷ'),
      words: [
        { op: 'EQUAL', text: 'Giá trị là' },
        { op: 'REMOVED', text: '100' },
        { op: 'ADDED', text: '120' },
        { op: 'EQUAL', text: 'tỷ' },
      ],
    }),
    entry('ADDED', { after: ref(4, 'Điều 4 mới') }),
  ],
  formula: 'Units are lined up by a longest common subsequence of their digests.',
  as_of: AS_OF,
  ...over,
});

export const reviewer = (n: number, over: Record<string, unknown> = {}) => ({
  task_id: uuid(11, n),
  assignee_id: uuid(8, n),
  assignee_name: `Người duyệt ${n}`,
  state: 'PENDING',
  decision: null,
  reason: null,
  decided_at: null,
  due_at: '2026-11-10T03:00:00.000Z',
  can_decide: false,
  task_version: null,
  ...over,
});

export const reviewDetail = (over: Record<string, unknown> = {}, actions: Record<string, unknown> = {}) => ({
  review: round(1, { status: 'IN_REVIEW', concluded_at: null, version: 1, submit_note: 'Trình thẩm định lần đầu' }),
  document: { id: DOCUMENT, title: 'Thiết kế cơ sở gói 1', reference: 'TK-01', doc_class: 'DESIGN', project: PROJECT },
  stages: [
    { index: 0, id: 'technical', name: 'Thẩm định kỹ thuật', min_approvals: 2, approvals: 1, state: 'CURRENT', reviewers: [reviewer(1, { state: 'APPROVED', decision: 'approve', decided_at: '2026-11-03T02:00:00.000Z' }), reviewer(2, { can_decide: true, task_version: 1 }), reviewer(3)] },
    { index: 1, id: 'legal', name: 'Thẩm định pháp lý', min_approvals: 1, approvals: 0, state: 'WAITING', reviewers: [] },
  ],
  workflow_revision: 2,
  instance_status: 'Running',
  outcome: null,
  events: [{ seq: 1, kind: 'SUBMITTED', actor_name: 'Nguyễn Văn An', occurred_at: '2026-11-02T02:00:00.000Z', detail: {} }],
  open_comments: 2,
  actions: { withdraw: false, resubmit: false, ...actions },
  as_of: AS_OF,
  ...over,
});

export const reviewItem = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(4, n),
  document_id: uuid(2, n),
  document_title: `Thiết kế cơ sở gói ${n}`,
  doc_class: 'DESIGN',
  project: PROJECT,
  version_id: VERSION_1,
  version_no: 1,
  round: 1,
  status: 'IN_REVIEW',
  submitted_by_name: 'Nguyễn Văn An',
  submitted_at: '2026-11-02T02:00:00.000Z',
  concluded_at: null,
  current_stage: 'Thẩm định kỹ thuật',
  ...over,
});

export const UPLOADED = { file_object_key: KEY, file_sha256: SHA, size_bytes: 20480, format: 'DOCX', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', page_count: null };

export interface World {
  documents: Array<Record<string, unknown>>;
  /** Documents of the second page, served when the cursor is asked for. */
  more?: Array<Record<string, unknown>>;
  detail?: Record<string, unknown>;
  versions: Record<string, Record<string, unknown>>;
  units: Record<string, Array<Record<string, unknown>>>;
  comments: Array<Record<string, unknown>>;
  comparison?: Record<string, unknown>;
  reviews: Array<Record<string, unknown>>;
  review?: Record<string, unknown>;
  download?: Record<string, unknown>;
  /** The next reads of an operation fail with this error, `times` times. */
  failing: Map<string, { error: Error; times: number }>;
  /** Reads that never answer. */
  hanging: Set<string>;
}

export function world(over: Partial<World> = {}): World {
  return { documents: [summary(1), summary(2, { status: 'ARCHIVED', latest_review: null, approved_version: null })], versions: {}, units: {}, comments: [], reviews: [], failing: new Map(), hanging: new Set(), ...over };
}

/** A client over `state`: every read is answered from it, `command(operation, input)` answers the commands; the reads of the registers of the projects, contracts and packages answer one row each. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({ operation_id: 'o', status: 'OK', resource_version: 2, resource_id: DOCUMENT })): Harness {
  const h = harness((operation, input) => {
    if (state.hanging.has(operation)) return new Promise(() => undefined);
    const failing = state.failing.get(operation);
    if (failing !== undefined && failing.times > 0) {
      failing.times -= 1;
      return failing.error;
    }
    const query = (input as { query?: Record<string, string> } | undefined)?.query ?? {};
    const id = (input as { path?: { id?: string } } | undefined)?.path?.id ?? '';
    switch (operation) {
      case 'listProjectDocuments':
        return query.cursor === undefined ? { items: state.documents, next_cursor: state.more === undefined ? null : 'next', classes: ['DESIGN', 'CONTRACT', 'REPORT'], as_of: AS_OF } : { items: state.more ?? [], next_cursor: null, classes: ['DESIGN'], as_of: AS_OF };
      case 'getProjectDocument':
        return state.detail ?? new Error('not found');
      case 'getProjectDocumentVersion':
        return state.versions[id] ?? new Error('not found');
      case 'listDocumentTextUnits':
        return { items: (state.units[id] ?? []).filter((item) => query.q === undefined || String(item.text).includes(query.q)), next_cursor: null, as_of: AS_OF };
      case 'listDocumentComments':
        return { items: state.comments, open_count: state.comments.filter((item) => item.status === 'OPEN').length, as_of: AS_OF };
      case 'compareDocumentVersions':
        return state.comparison ?? new Error('not found');
      case 'listDocumentReviews':
        return { items: state.reviews.filter((item) => query.status === undefined || item.status === query.status), next_cursor: null, as_of: AS_OF };
      case 'getDocumentReview':
        return state.review ?? new Error('not found');
      case 'getProjectDocumentVersionDownload':
        return state.download ?? { version_id: id, url: '/project-document-files/f1?tenant=t&expires=1&signature=s', expires_at: '2026-11-08T03:05:00.000Z', mime: 'application/pdf', file_sha256: SHA, size_bytes: 20480, page_count: null };
      default:
        return new Error(`unexpected read ${operation}`);
    }
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn(async (operation: string) => {
    if (operation === 'get_resources_project') return [{ id: PROJECT.id, code: PROJECT.code, name: PROJECT.name }];
    if (operation === 'get_resources_contract') return [{ id: uuid(6, 1), code: 'HD-01', project_id: PROJECT.id }];
    if (operation === 'get_resources_procurement_package') return [{ id: uuid(7, 1), code: 'GT-03', title: 'Gói xây lắp', project_id: PROJECT.id }];
    return [];
  });
  return h;
}

export const TENANT_ONE: SessionTenant = { id: '00000000-0000-4000-8000-00000000000a', name: 'Cao Bang', monogram: 'CB', membershipId: '00000000-0000-4000-8000-000000000001', theme: { themeId: 'tenant', version: 1, overlay: {} } };
export const TENANT_TWO: SessionTenant = { ...TENANT_ONE, id: '00000000-0000-4000-8000-00000000000b', name: 'Lang Son', membershipId: '00000000-0000-4000-8000-000000000002' };

export interface MountOptions {
  permissions?: readonly string[] | undefined;
  mode?: 'FULL' | 'READ_ONLY';
  path?: string;
  upload?: () => unknown;
}

/** Mounts a screen in a session; the upload of the client answers `options.upload` (a value, or an Error to throw). `switchTo` changes the signed-in membership the way the shell does. */
export function mountScreen(screen: ReactElement, h: Harness, options: MountOptions = {}): RenderResult & { queries: QueryClient; upload: ReturnType<typeof vi.fn>; switchTo: () => void } {
  const upload = vi.fn(async () => {
    const result = options.upload?.() ?? UPLOADED;
    if (result instanceof Error) throw result;
    return result;
  });
  (h.client as unknown as { upload: unknown }).upload = upload;
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  let switchTo: () => void = () => undefined;
  function Shell(): ReactElement {
    const [tenant, setTenant] = useState(TENANT_ONE);
    switchTo = () => setTenant(TENANT_TWO);
    const session: SessionValue = {
      tenant,
      tenants: [TENANT_ONE, TENANT_TWO],
      user: { displayName: 'Admin', initials: 'AD' },
      access: ALL_MODULES_VISIBLE,
      switchTenant: () => undefined,
      getSession: () => Promise.resolve({ token: 'token' }),
      permissions: 'permissions' in options ? options.permissions : ALL,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    };
    return (
      <SessionContext.Provider value={session}>
        <QueryClientProvider client={queries}>
          <ApiClientProvider client={h.client}>
            <MemoryRouter initialEntries={[options.path ?? '/']}>{screen}</MemoryRouter>
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>
    );
  }
  const rendered = render(<Shell />);
  return { ...rendered, queries, upload, switchTo: () => switchTo() };
}
