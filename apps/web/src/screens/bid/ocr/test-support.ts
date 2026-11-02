import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { TENANT } from '../test-support';

export { mount, routeOf } from '../test-support';
export type { Harness };

export const REVIEWER = ['bid.read', 'proposal.read', 'bid.evaluate', 'bid.ocr.read', 'bid.ocr.review'];
export const READER = ['bid.ocr.read'];
export const NOBODY = ['bid.read'];
/** The membership the session signs in as. */
export const ME = TENANT.membershipId;

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const PROJECT = uuid('0030', 1);
export const packageId = (n: number): string => uuid('0020', n);
export const proposalId = (n: number): string => uuid('0080', n);
export const versionId = (n: number): string => uuid('0070', n);
export const pageId = (n: number): string => uuid('0060', n);
export const KEY = 'tenants/00000000-0000-4000-8000-00000000000a/document/00000000-0000-4000-8000-0000000000aa';

/** A package whose plan is in force, open for bids. */
export const pack = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: packageId(n),
  code: `GT-${n}`,
  title: `Gói thầu xây lắp ${n}`,
  project: { id: PROJECT, code: 'PRJ-001', name: 'Cầu qua sông', status: 'IMPLEMENTATION' },
  status: 'APPROVED',
  version: 3,
  ...overrides,
});

/** A proposal the caller has in full. */
export const proposal = (n: number, packageNumber: number, overrides: Record<string, unknown> = {}) => ({
  id: proposalId(n),
  package: { id: packageId(packageNumber), code: `GT-${packageNumber}`, title: `Gói thầu xây lắp ${packageNumber}` },
  project: { id: PROJECT, code: 'PRJ-001' },
  contractor: { id: uuid('0090', n), legal_name: `Công ty nhà thầu ${n}` },
  revision: 1,
  status: 'RECEIVED',
  submitted_at: '2026-11-10T02:00:00.000Z',
  access_released_at: '2026-11-12T02:00:00.000Z',
  locked: false,
  file_count: 1,
  classification: 'CONFIDENTIAL',
  access: 'FULL',
  conflict_standing: 'CLEAR',
  bid_price_vnd: '17650000000',
  version: 1,
  ...overrides,
});

export const document = (n: number, title: string, pageCount = 30) => ({ document_version_id: versionId(n), title, part: 'FINANCIAL', page_count: pageCount });

/** A page as the list answers it: accepted, read from the first file. */
export const page = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: pageId(n),
  document_version_id: versionId(1),
  page_index: n - 1,
  ocr_confidence: '0.9700',
  review_status: 'AUTO_ACCEPTED',
  table_mismatch: false,
  reviewed_by: null,
  reviewed_at: null,
  note: null,
  engine_version: 'ocr-engine-1.0',
  text: `Nội dung trang ${n}`,
  text_state: 'READABLE',
  corrected_text: null,
  ...overrides,
});

/** A page that waits for a person: read at 0.71. */
export const waiting = (n: number, overrides: Record<string, unknown> = {}) =>
  page(n, { ocr_confidence: '0.7100', review_status: 'NEEDS_REVIEW', text: `Tổng cộng: 1.000.000 + 2.000.OOO = 3.000.000 (trang ${n})`, ...overrides });

export interface World {
  packages: Array<Record<string, unknown>>;
  proposals: Array<Record<string, unknown>>;
  documents: Array<Record<string, unknown>>;
  pages: Array<Record<string, unknown>>;
  /** Reads that fail, by operation, with the failure they answer. */
  failing: Map<string, Error>;
  /** The page size the list answers with; the screen asks for more with the cursor. */
  pageSize: number;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    packages: [pack(1), pack(2), pack(3, { status: 'DRAFT' })],
    proposals: [proposal(1, 1), proposal(2, 1, { access: 'METADATA' }), proposal(3, 1, { status: 'SUPERSEDED' })],
    documents: [document(1, 'Đề xuất tài chính'), document(2, 'Đề xuất kỹ thuật', 120)],
    pages: [],
    failing: new Map(),
    pageSize: 100,
    ...overrides,
  };
}

/** The list as the server answers it: filtered, in pages, with the gate of the whole proposal. */
function listing(state: World, query: { review_status?: string; document_version_id?: string; cursor?: string; limit?: number } | undefined) {
  const filtered = state.pages.filter(
    (item) =>
      (query?.review_status === undefined || item.review_status === query.review_status) && (query?.document_version_id === undefined || item.document_version_id === query.document_version_id),
  );
  const from = query?.cursor === undefined ? 0 : Number(query.cursor);
  const shown = filtered.slice(from, from + state.pageSize);
  const blocked = state.pages.filter((item) => item.review_status === 'NEEDS_REVIEW').length;
  return {
    items: shown,
    next_cursor: from + state.pageSize < filtered.length ? String(from + state.pageSize) : null,
    as_of: '2026-12-05T03:00:00.000Z',
    financial_ready: blocked === 0,
    blocked_pages: blocked,
    threshold: '0.850',
    documents: state.documents,
  };
}

/** A client over `state`: the reads are answered from it, `command(operation, input)` answers the commands and `upload` the upload of the corrected text. */
export function client(
  state: World,
  command: (operation: string, input: unknown) => unknown = () => ({}),
  upload: () => unknown = () => ({ file_object_key: KEY, file_sha256: 'a'.repeat(64), size_bytes: 10 }),
): Harness & { upload: ReturnType<typeof vi.fn> } {
  const h = baseHarness((operation, input) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return failure;
    if (operation === 'listProposalOcrPages') return listing(state, (input as { query?: Parameters<typeof listing>[1] } | undefined)?.query);
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string, input?: { query?: { package_id?: string } }) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return Promise.reject(failure);
    switch (operation) {
      case 'get_resources_procurement_package':
        return Promise.resolve(state.packages);
      case 'get_resources_proposal':
        return Promise.resolve(state.proposals.filter((item) => (item.package as { id: string }).id === input?.query?.package_id));
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  const sent = vi.fn<(operation: string, input: unknown) => Promise<unknown>>(async () => {
    const result = upload();
    if (result instanceof Error) throw result;
    return result;
  });
  (h.client as unknown as { upload: unknown }).upload = sent;
  return Object.assign(h, { upload: sent });
}
