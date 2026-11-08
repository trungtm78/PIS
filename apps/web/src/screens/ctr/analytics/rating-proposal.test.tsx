import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RatingScreen from './RatingScreen';
import { harness } from '../../sas/test-support';
import { mount, routeOf } from './test-support';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ID = '00000000-0000-4000-8000-003000000001';
const OTHER = '00000000-0000-4000-8000-003000000002';
const CONTRACT = '00000000-0000-4000-8000-002000000001';
const RATER = ['contractor.performance.read', 'contractor.performance.propose'];
const proposal = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  contract_id: CONTRACT,
  contract_code: 'HD-1',
  contractor_id: '00000000-0000-4000-8000-004000000001',
  evaluation_kind: 'PERIODIC',
  period_label: '2026-Q4',
  as_of_date: '2026-11-08',
  state: 'NOTIFIED',
  rule: { version: 0, source: 'DEFAULT' },
  criteria: {
    quality: { score: 66, reason: null, readings: { open_defects: 1 } },
    schedule: { score: 56, reason: null, readings: { days_late: 40 } },
    safety_env: { score: null, reason: 'NOT_ENOUGH_OBSERVATION', readings: {} },
    cooperation: { score: 100, reason: null, readings: {} },
    financial: { score: null, reason: 'NO_FINANCIAL_EVIDENCE', readings: {} },
  },
  covered: 3,
  overall_score: '71.00',
  rating: 'FAIR',
  inputs_sha256: 'a'.repeat(64),
  proposed_by: 'member-1',
  proposed_note: null,
  notified: { by: 'member-1', at: '2026-11-08T02:00:00.000Z', note: null, letter_document_version_id: null },
  response_due_at: '2026-11-20T02:00:00.000Z',
  response_clock: { status: 'RUNNING', due_at: '2026-11-20T02:00:00.000Z', basis: 'WORKING_DAYS' },
  response: null,
  adopted: null,
  withdrawn: null,
  allowed: { notify: false, respond: true, adopt: false, withdraw: true },
  version: 2,
  created_at: '2026-11-08T01:00:00.000Z',
  ...over,
});

function open(answer: (operation: string, input: unknown) => unknown, path: string) {
  const h = harness(answer);
  mount(<RatingScreen route={routeOf('CTR-37', 'FR-CTR-37')} />, h, { permissions: RATER, path });
  return h;
}

describe('CTR-37 one proposal by its link (getContractRatingProposal)', () => {
  it('reads that proposal only, shows it with its clock and allowed steps, and offers the whole list', async () => {
    const h = open((operation, input) => (operation === 'getContractRatingProposal' ? proposal((input as { path: { id: string } }).path.id) : operation === 'listContractRatingProposals' ? { items: [proposal(ID), proposal(OTHER)], as_of: 'x' } : new Error(`unexpected ${operation}`)), `/ctr/ctr-37?proposal=${ID}`);
    const card = await screen.findByTestId('proposals');
    expect(h.read).toHaveBeenCalledWith('getContractRatingProposal', { path: { id: ID } });
    expect(h.read.mock.calls.some((call) => call[0] === 'listContractRatingProposals')).toBe(false);
    expect(within(card).getAllByRole('listitem').length).toBeGreaterThanOrEqual(1);
    expect(card.querySelectorAll('[data-proposal-id]')).toHaveLength(1);
    expect(within(card).getByTestId('overall').textContent).toBe('71,00');
    expect(screen.getByTestId('proposal-only')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('proposal-only')).getByRole('button'));
    await waitFor(() => expect(document.querySelectorAll('[data-proposal-id]')).toHaveLength(2));
    expect(h.read).toHaveBeenCalledWith('listContractRatingProposals', expect.anything());
  });

  it('shows a proposal that is not there for the caller as a failed read with a retry, and ignores a link that is not an identifier', async () => {
    let calls = 0;
    const h = open((operation) => (operation === 'getContractRatingProposal' ? (calls++ === 0 ? new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' }) : proposal(ID)) : { items: [], as_of: 'x' }), `/ctr/ctr-37?proposal=${ID}`);
    const retry = await screen.findByRole('button', { name: /thử lại|try again|retry/i });
    expect(screen.queryByTestId('proposals')).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByTestId('proposals')).toBeTruthy();
    cleanup();
    const second = open((operation) => (operation === 'listContractRatingProposals' ? { items: [], as_of: 'x' } : new Error(`unexpected ${operation}`)), '/ctr/ctr-37?proposal=nope');
    expect(await screen.findByTestId('no-proposals')).toBeTruthy();
    expect(second.read.mock.calls.some((call) => call[0] === 'getContractRatingProposal')).toBe(false);
    expect(h.read).toHaveBeenCalledTimes(2);
  });
});
