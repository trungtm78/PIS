import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import MasterApprovalScreen from './MasterApprovalScreen';
import { COMMUNE_A, COMMUNE_B, MERGED } from './succession-test-support';
import { REVIEWER, change, client, mount, routeOf, world } from './test-support';

const ROUTE = routeOf('MDM-32', 'FR-MDM-32');

afterEach(cleanup);

const rowOf = (id: string): HTMLElement => document.querySelector(`[data-change-id="${id}"]`) as HTMLElement;
const ready = () => waitFor(() => expect(document.querySelector('[data-change-id]')).not.toBeNull());

const MERGE_REQUEST = change(1, {
  change_kind: 'SUCCESSION',
  master_type: 'AREA',
  business_key: 'XA-A',
  master_record_id: COMMUNE_A.id,
  proposed: { succession_kind: 'MERGE', effective_date: '2025-07-01', legal_basis: 'Resolution of the 2025 reform', edges: [{ successor_record_id: MERGED.id, share_pct: null }] },
  before: null,
  effective_from: '2025-07-01',
  impact: { counts: { 'project.area_master_version_id': 3 }, total: 3, computed_at: '2026-10-24T00:00:00.000Z' },
});

describe('MasterApprovalScreen (MDM-32): a succession request', () => {
  it('shows the kind, the date, the legal basis and the receiving entries of a succession, and what refers to the entry (AC-ST-MDM-009-1)', async () => {
    mount(<MasterApprovalScreen route={ROUTE} />, client(world({ records: [COMMUNE_A, COMMUNE_B, MERGED], changes: [MERGE_REQUEST] })), REVIEWER);
    await ready();
    const row = within(rowOf(MERGE_REQUEST.id));
    expect(row.getByText(vi_['mdm.kind.change.succession'])).toBeTruthy();
    expect(row.getByText(vi_['mdm.approval.succession.summary'])).toBeTruthy();
    expect(row.getByText('AREA · XA-A').getAttribute('href')).toBe('/mdm/mdm-27?type=AREA&key=XA-A');
    await userEvent.setup().click(row.getByRole('button', { name: vi_['mdm.approval.review.action'] }));
    const proposal = within(screen.getByTestId('proposal'));
    expect(proposal.getByText(vi_['mdm.approval.succession.kind.text']).closest('tr')?.textContent).toContain(`MERGE · ${vi_['mdm.value.successionKind.merge']}`);
    expect(proposal.getByText(vi_['mdm.approval.succession.effective.text']).closest('tr')?.textContent).toContain('2025-07-01');
    expect(proposal.getByText(vi_['mdm.approval.succession.basis.text']).closest('tr')?.textContent).toContain('Resolution of the 2025 reform');
    await waitFor(() => expect(proposal.getByText(vi_['mdm.approval.succession.successors.text']).closest('tr')?.textContent).toContain('XA-Y'));
    expect(screen.getByTestId('impact').getAttribute('data-impact-total')).toBe('3');
  });

  it('shows the share of each receiving entry of a split', async () => {
    const split = change(2, {
      change_kind: 'SUCCESSION',
      master_type: 'AREA',
      business_key: 'XA-A',
      proposed: { succession_kind: 'SPLIT', effective_date: '2025-07-01', legal_basis: 'x', edges: [{ successor_record_id: COMMUNE_B.id, share_pct: '60.00' }, { successor_record_id: MERGED.id, share_pct: '40.00' }] },
      before: null,
    });
    mount(<MasterApprovalScreen route={ROUTE} />, client(world({ records: [COMMUNE_A, COMMUNE_B, MERGED], changes: [split] })), REVIEWER);
    await ready();
    await userEvent.setup().click(within(rowOf(split.id)).getByRole('button', { name: vi_['mdm.approval.review.action'] }));
    await waitFor(() => expect(document.querySelector(`[data-successor="${COMMUNE_B.id}"]`)?.textContent).toContain('XA-B'));
    expect(document.querySelector(`[data-successor="${COMMUNE_B.id}"]`)?.textContent).toContain(vi_['mdm.succession.share.text'].replace('{share}', '60.00'));
    expect(document.querySelector(`[data-successor="${MERGED.id}"]`)?.textContent).toContain(vi_['mdm.succession.share.text'].replace('{share}', '40.00'));
  });

  it('says so when the proposal cannot be read, and still lets the reviewer decide', async () => {
    const broken = change(3, { change_kind: 'SUCCESSION', master_type: 'AREA', business_key: 'XA-A', proposed: { label: 'not a succession' }, before: null });
    mount(<MasterApprovalScreen route={ROUTE} />, client(world({ changes: [broken] })), REVIEWER);
    await ready();
    fireEvent.click(within(rowOf(broken.id)).getByRole('button', { name: vi_['mdm.approval.review.action'] }));
    expect(await screen.findByText(vi_['mdm.approval.succession.unreadable.error'])).toBeTruthy();
    expect(screen.getByRole('button', { name: vi_['mdm.approval.decision.approve.action'] })).toBeTruthy();
  });
});
