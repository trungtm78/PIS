import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { routeOf } from '../doc/test-support';
import RetentionPolicyScreen from './RetentionPolicyScreen';
import { harness, mountInSession } from './security/test-support';

vi.setConfig({ testTimeout: 30_000 });

const ROUTE = routeOf('ADM-12', 'FR-ADM-12');
const READER = ['adm.retention.read', 'legal_hold.read'];

const POLICY = {
  id: 'p-live',
  record_class: 'project_dossier',
  revision: 2,
  retention_years: 12,
  retention_basis: 'FROM_CLOSED',
  legal_basis_ref: 'TT 10/2022/TT-BNV [CXN-RET-03]',
  end_action: 'REVIEW_FOR_DESTRUCTION',
  effective_from: '2026-01-01',
  status: 'Published',
  created_by: 'u1',
  approved_by: 'u2',
  published_at: '2026-01-02T00:00:00.000Z',
  version: 2,
};
const ITEM = { id: 'r1', record_class: 'project_dossier', resource_type: 'project', resource_id: 'abcdef12-0000-4000-8000-000000000001', policy_id: 'p-live', basis_date: '2024-03-15', due_on: '2025-03-15', end_action: 'REVIEW_FOR_DESTRUCTION', status: 'PENDING_REVIEW', listed_at: '2026-10-24T00:00:00.000Z' };
const HOLD = { id: 'h1', hold_kind: 'INSPECTION', status: 'Active', resource_scope: { kind: 'TENANT', ids: [] }, authority_reference: '***', reason: 'Inspection of the year', effective_at: '2026-01-01T00:00:00.000Z' };

type Reads = Record<string, () => Promise<unknown[]>>;

function withReads(reads: Reads) {
  const h = harness(() => new Error('no read'));
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = (operation) => (reads[operation] ?? (() => Promise.reject(new Error('unexpected read ' + operation))))();
  return h;
}
const ok = (): Reads => ({
  get_resources_data_retention_policy: () => Promise.resolve([POLICY]),
  get_resources_retention_review_item: () => Promise.resolve([ITEM]),
  get_resources_legal_hold: () => Promise.resolve([HOLD]),
});
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

afterEach(cleanup);

describe('RetentionPolicyScreen (ADM-12)', () => {
  it('reads the rules, the review list and the holds of the tenant and shows them (AC-ST-ADM-017-1)', async () => {
    mountInSession(<RetentionPolicyScreen route={ROUTE} />, withReads(ok()), { permissions: READER });
    expect(await screen.findByTestId('review')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('holds').textContent).toContain('Inspection of the year'));
    expect(document.querySelector('[data-policy-id="p-live"]')).not.toBeNull();
    expect(document.querySelector('[data-review-id="r1"]')).not.toBeNull();
    expect(screen.queryByText(vi_['adm.retention.holds.error'])).toBeNull();
  });

  it('shows the loading state while the rules are read', () => {
    mountInSession(<RetentionPolicyScreen route={ROUTE} />, withReads({ ...ok(), get_resources_data_retention_policy: () => new Promise(() => undefined) }), { permissions: READER });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
  });

  it('still offers the form to a tenant with no rule: an empty register is not an empty screen', async () => {
    const reads = { ...ok(), get_resources_data_retention_policy: () => Promise.resolve([]), get_resources_retention_review_item: () => Promise.resolve([]), get_resources_legal_hold: () => Promise.resolve([]) };
    mountInSession(<RetentionPolicyScreen route={ROUTE} />, withReads(reads), { permissions: [...READER, 'adm.retention.manage'] });
    expect(await screen.findByText(vi_['adm.retention.policy.empty'])).toBeTruthy();
    expect(screen.getByText(vi_['adm.retention.review.empty'])).toBeTruthy();
  });

  it('is denied without reading anything when the session lacks adm.retention.read', () => {
    const reads: Reads = {};
    mountInSession(<RetentionPolicyScreen route={ROUTE} />, withReads(reads), { permissions: ['legal_hold.read'] });
    expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy();
  });

  it.each([
    ['denied', failure(403, 'SCOPE_DENIED'), 'states.denied.title'],
    ['signedOut', failure(401, 'SESSION_EXPIRED'), 'states.signedOut.title'],
    ['offline', failure(0, NETWORK_ERROR_CODE), 'states.offline.title'],
    ['error', failure(500, 'INTERNAL_ERROR'), 'states.error.title'],
  ] as const)('shows the %s state when the rules cannot be read', async (_state, error, key) => {
    mountInSession(<RetentionPolicyScreen route={ROUTE} />, withReads({ ...ok(), get_resources_data_retention_policy: () => Promise.reject(error) }), { permissions: READER });
    expect(await screen.findByText(vi_[key])).toBeTruthy();
  });

  it('shows the error state when only the review list fails, and reads again when the person retries', async () => {
    let calls = 0;
    const reads = { ...ok(), get_resources_retention_review_item: () => (++calls === 1 ? Promise.reject(failure(500, 'INTERNAL_ERROR')) : Promise.resolve([ITEM])) };
    mountInSession(<RetentionPolicyScreen route={ROUTE} />, withReads(reads), { permissions: READER });
    await userEvent.setup().click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(document.querySelector('[data-review-id="r1"]')).not.toBeNull());
    expect(calls).toBe(2);
  });

  it('retries the rules when they were the ones that failed', async () => {
    let calls = 0;
    const reads = { ...ok(), get_resources_data_retention_policy: () => (++calls === 1 ? Promise.reject(failure(500, 'INTERNAL_ERROR')) : Promise.resolve([POLICY])) };
    mountInSession(<RetentionPolicyScreen route={ROUTE} />, withReads(reads), { permissions: READER });
    await userEvent.setup().click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(document.querySelector('[data-policy-id="p-live"]')).not.toBeNull());
  });

  it('keeps the screen usable and says so when the holds cannot be read or may not be read', async () => {
    const failing = { ...ok(), get_resources_legal_hold: () => Promise.reject(failure(500, 'INTERNAL_ERROR')) };
    mountInSession(<RetentionPolicyScreen route={ROUTE} />, withReads(failing), { permissions: READER });
    expect(await screen.findByText(vi_['adm.retention.holds.error'])).toBeTruthy();
    expect(document.querySelector('[data-policy-id="p-live"]')).not.toBeNull();
    cleanup();
    mountInSession(<RetentionPolicyScreen route={ROUTE} />, withReads(ok()), { permissions: ['adm.retention.read'] });
    expect(await screen.findByText(vi_['adm.retention.holds.error'])).toBeTruthy();
  });

  it('reads without checking permissions when the session does not know them', async () => {
    mountInSession(<RetentionPolicyScreen route={ROUTE} />, withReads(ok()), { permissions: undefined });
    expect(await screen.findByTestId('review')).toBeTruthy();
  });
});
