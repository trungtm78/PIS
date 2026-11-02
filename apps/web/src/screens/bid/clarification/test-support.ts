import { vi } from 'vitest';
import { harness as baseHarness } from '../../sas/test-support';
import type { Harness } from '../../sas/test-support';
import { opened, packageId, proposal, proposalId } from '../proposal/test-support';

export { mount, routeOf } from '../test-support';
export { opened, packageId, proposal, proposalId };
export type { Harness };

/** An evaluator who asks and reads, a clerk who takes the letters, a guest of a contractor, and a caller who holds neither. */
export const EVALUATOR = ['bid.evaluate', 'bid.clarification.read'];
export const CLERK = ['bid.clarification.read', 'bid.clarification.answer'];
export const GUEST = ['bid.clarification.read', 'bid.clarification.answer'];
export const READER = ['bid.read'];

const uuid = (family: string, n: number): string => `00000000-0000-4000-8000-${family}${String(n).padStart(8, '0')}`;
export const clarificationId = (n: number): string => uuid('00c0', n);
export const contractorOf = (n: number): string => uuid('0090', n);
export const FINDING = uuid('00d0', 1);
export const LETTER = uuid('00e0', 1);
export const REPLY = uuid('00e0', 2);
export const SOMEONE = uuid('00b0', 7);

/** A request as the list answers it to the staff: sent to a contractor, waiting, due far ahead, answerable. Overrides change what a test needs. */
export const request = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: clarificationId(n),
  package: { id: packageId(1), code: 'GT-1' },
  project_id: uuid('0030', 1),
  proposal_id: proposalId(n),
  contractor: { id: contractorOf(n), legal_name: `Công ty nhà thầu ${n}` },
  question: `Giải trình đơn giá của hạng mục ${n} trong bảng khối lượng.`,
  basis_finding: { id: FINDING, criterion_code: 'C2' },
  due_at: '2099-11-20T10:00:00.000Z',
  status: 'SENT',
  sent_document_id: LETTER,
  answer_document_id: null,
  answered_at: null,
  answered_by: null,
  answered_as_guest: null,
  asked_by: { membership_id: SOMEONE, display_name: 'Chuyên gia Lê Văn Hai' },
  created_at: '2026-11-10T03:00:00.000Z',
  actions: { answer: true },
  version: 1,
  ...overrides,
});

/** The same request as a contractor reads it: neither who asked nor what the question rests on. */
export const guestView = (n: number, overrides: Record<string, unknown> = {}) => request(n, { basis_finding: null, asked_by: null, ...overrides });

export interface World {
  requests: Array<Record<string, unknown>>;
  proposals: Array<Record<string, unknown>>;
  /** Reads that fail, by operation. */
  failing: Map<string, Error>;
}

export function world(overrides: Partial<World> = {}): World {
  return {
    requests: [],
    proposals: [opened(1, 1), opened(2, 1), proposal(3, 1), opened(4, 1, { status: 'SUPERSEDED' })],
    failing: new Map(),
    ...overrides,
  };
}

/** A client over `state`: the reads are answered from it and `command(operation, input)` answers the commands. */
export function client(state: World, command: (operation: string, input: unknown) => unknown = () => ({})): Harness {
  const h = baseHarness((operation, input) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return failure;
    if (operation === 'listBidClarifications') {
      const query = (input as { query?: { package_id?: string } } | undefined)?.query;
      const items = state.requests.filter((item) => query?.package_id === undefined || (item.package as { id: string }).id === query.package_id);
      return { items, as_of: '2026-12-05T03:00:00.000Z' };
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    const failure = state.failing.get(operation);
    if (failure !== undefined) return Promise.reject(failure);
    if (operation === 'get_resources_proposal') return Promise.resolve(state.proposals);
    return Promise.reject(new Error(`unexpected readAll ${operation}`));
  });
  return h;
}
