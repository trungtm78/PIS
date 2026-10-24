import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { routeOf } from '../doc/test-support';
import { harness, mountInSession } from './security/test-support';
import DoaMatrixScreen from './DoaMatrixScreen';

vi.setConfig({ testTimeout: 30_000 });

const ROUTE = routeOf('ADM-15', 'FR-ADM-15');
const BOTH = ['adm.doa.manage', 'adm.doa.approve', 'adm.doa.read'];

const unit = (id: string, code: string, parent: string | null) => ({
  id,
  code,
  name: `Unit ${code}`,
  parent_id: parent,
  valid_from: '2026-01-01',
  valid_until: null,
  unit_type: 'DEPARTMENT',
  status: 'Active',
  successor_id: null,
  depth: 0,
  version: 1,
});
const MATRIX = {
  id: 'm1',
  revision: 1,
  status: 'Published',
  effective_from: '2026-01-01',
  effective_until: null,
  legal_basis_ref: 'Internal regulation 12/QD-2026',
  created_by: 'u1',
  last_edited_by: 'u1',
  approved_by: 'u2',
  published_at: '2026-01-01T00:00:00Z',
  version: 3,
  rules: [{ id: 'a', document_type: 'FX', unit_id: 'u1', include_subtree: true, amount_min_vnd: '0', amount_max_vnd: null, approver_role_id: 'r1', approval_levels: 1, requires_distinct_approvers: true }],
};

type Reads = Partial<Record<string, () => Promise<unknown[]>>>;
function withReads(reads: Reads) {
  const h = harness(() => new Error('no read'));
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = (operation: string) => (reads[operation] ?? (() => Promise.reject(new Error(`unexpected read ${operation}`))))();
  return h;
}
const ALL: Reads = {
  get_resources_doa_matrix_version: () => Promise.resolve([MATRIX]),
  get_resources_organization_unit: () => Promise.resolve([unit('u1', 'PRV', null)]),
  get_resources_role_definition: () => Promise.resolve([{ id: 'r1', code: 'LEADER_STC' }, { id: 5, code: 'junk' }, { code: 'no id' }]),
};

afterEach(cleanup);

describe('DoaMatrixScreen (ADM-15)', () => {
  it('reads the versions, the units and the roles and draws the bands of the matrix in force with its approver (AC-ST-ADM-011-3)', async () => {
    mountInSession(<DoaMatrixScreen route={ROUTE} />, withReads(ALL), { permissions: BOTH });
    const inView = await screen.findByTestId('matrix-in-view');
    expect(inView.getAttribute('data-matrix-id')).toBe('m1');
    expect(inView.querySelector('.doa-seg')?.textContent).toContain('LEADER_STC');
    expect(screen.queryByText(vi_['adm.doa.options.error'])).toBeNull();
  });

  it('shows the loading state while the versions are read', () => {
    mountInSession(<DoaMatrixScreen route={ROUTE} />, withReads({ ...ALL, get_resources_doa_matrix_version: () => new Promise(() => undefined) }), { permissions: BOTH });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
  });

  it('still offers the form to a tenant with no matrix', async () => {
    mountInSession(<DoaMatrixScreen route={ROUTE} />, withReads({ ...ALL, get_resources_doa_matrix_version: () => Promise.resolve([]) }), { permissions: BOTH });
    expect(await screen.findByText(vi_['adm.doa.versions.empty'])).toBeTruthy();
    expect(screen.getByRole('button', { name: vi_['adm.doa.draft.save.action'] })).toBeTruthy();
  });

  it.each([
    ['get_resources_organization_unit'],
    ['get_resources_role_definition'],
  ])('says the rules cannot be written yet when %s cannot be read, and still shows the versions', async (operation) => {
    const failing = withReads({ ...ALL, [operation]: () => Promise.reject(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })) });
    mountInSession(<DoaMatrixScreen route={ROUTE} />, failing, { permissions: BOTH });
    expect(await screen.findByText(vi_['adm.doa.options.error'])).toBeTruthy();
    expect(screen.getByTestId('matrix-in-view')).toBeTruthy();
  });

  it.each([
    ['denied', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), 'states.denied.title'],
    ['signedOut', new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), 'states.signedOut.title'],
    ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), 'states.offline.title'],
    ['error', new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), 'states.error.title'],
  ] as const)('shows the %s state when the versions cannot be read', async (_state, failure, key) => {
    mountInSession(<DoaMatrixScreen route={ROUTE} />, withReads({ ...ALL, get_resources_doa_matrix_version: () => Promise.reject(failure) }), { permissions: BOTH });
    expect(await screen.findByText(vi_[key])).toBeTruthy();
  });

  it('reads again when the person retries after a failure', async () => {
    let calls = 0;
    const h = withReads({
      ...ALL,
      get_resources_doa_matrix_version: () => (++calls === 1 ? Promise.reject(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })) : Promise.resolve([MATRIX])),
    });
    mountInSession(<DoaMatrixScreen route={ROUTE} />, h, { permissions: BOTH });
    await userEvent.setup().click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(screen.getByTestId('matrix-in-view')).toBeTruthy());
    expect(calls).toBe(2);
  });
});
