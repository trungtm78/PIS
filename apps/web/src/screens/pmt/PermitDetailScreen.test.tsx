import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import PermitDetailScreen from './PermitDetailScreen';
import { MANAGER_ONLY, OFFICER, READ_ONLY, client, dossierId, milestone, mount, permitDetail, permitId, world } from './dossier-test-support';
import { routeOf } from './test-support';

const ROUTE = routeOf('PMT-02', 'FR-PMT-02');

afterEach(cleanup);

const open = (state = world(), permissions: readonly string[] | undefined = OFFICER, path = `/?permit=${permitId(1)}`, command?: (operation: string, input: unknown) => unknown) => {
  const h = client(state, command);
  mount(<PermitDetailScreen route={ROUTE} />, h, { permissions, path });
  return h;
};
const forms = (): string[] => screen.queryAllByRole('form').map((form) => form.getAttribute('aria-label') ?? '');

describe('PermitDetailScreen (PMT-02): one permit and the timeline of its milestones', () => {
  it('shows the permit, the timeline of its milestones and the actions its status allows, with the way back to the dossier (UI-PMT-02)', async () => {
    open(world({ permits: [permitDetail(1, { status: 'IN_APPRAISAL', version: 4, milestones: [milestone(1), milestone(2, { step_code: 'ACKNOWLEDGED', actual_on: '2026-10-02' })] })] }));
    expect(await screen.findByTestId('permit-summary')).toBeTruthy();
    expect(document.querySelector('[data-screen-id="PMT-02"]')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['pmt.permit.page.title']);
    expect(screen.getByTestId('permit-status').textContent).toBe(vi_['pmt.permit.status.inAppraisal.text']);
    expect(within(screen.getByTestId('timeline')).getAllByRole('listitem')).toHaveLength(2);
    expect(forms()).toEqual([vi_['pmt.permit.milestone.aria'], vi_['pmt.permit.decision.aria']]);
    expect(screen.getByRole('link', { name: new RegExp(vi_['pmt.permit.back.link']) }).getAttribute('href')).toBe(`/pmt/pmt-01?dossier=${dossierId(1)}`);
  });

  it('reads the permit again after a milestone, and shows the status it moved to and the new milestone', async () => {
    const state = world({ permits: [permitDetail(1, { status: 'PLANNED', version: 1 })] });
    const h = open(state, OFFICER, undefined, (operation) => {
      if (operation === 'recordPermitMilestone') state.permits = [permitDetail(1, { status: 'SUBMITTED', version: 2, milestones: [milestone(1)] })];
      return { operation_id: 'o', status: 'SUBMITTED', resource_version: 2, resource_id: permitId(1) };
    });
    await screen.findByTestId('no-milestones');
    fireEvent.change(screen.getByLabelText(vi_['pmt.permit.milestone.actual.label']), { target: { value: '2026-10-01' } });
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['pmt.permit.milestone.save.action'] }));
    await waitFor(() => expect(screen.getByTestId('permit-status').textContent).toBe(vi_['pmt.permit.status.submitted.text']));
    expect(within(screen.getByTestId('timeline')).getAllByRole('listitem')).toHaveLength(1);
    expect(h.command).toHaveBeenCalledWith('recordPermitMilestone', expect.objectContaining({ ifMatchVersion: 1 }));
    // The form offers the next step of the new status.
    expect(within(screen.getByRole('form', { name: vi_['pmt.permit.milestone.aria'] })).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['pmt.permit.step.acknowledged.text']]);
  });

  it('offers the milestone to the one who manages and nothing to the one who may only read, and nothing while the tenant is suspended', async () => {
    const state = world({ permits: [permitDetail(1, { status: 'IN_APPRAISAL' })] });
    open(state, MANAGER_ONLY);
    await screen.findByTestId('permit-summary');
    expect(forms()).toEqual([vi_['pmt.permit.milestone.aria']]);
    cleanup();
    open(state, READ_ONLY);
    expect((await screen.findByTestId('actions-readonly')).textContent).toBe(vi_['pmt.permit.actions.readonly.text']);
    cleanup();
    mount(<PermitDetailScreen route={ROUTE} />, client(state), { permissions: OFFICER, mode: 'READ_ONLY', path: `/?permit=${permitId(1)}` });
    expect((await screen.findByTestId('actions-readonly')).textContent).toBe(vi_['pmt.permit.actions.readonly.text']);
  });

  it('asks to pick a permit from the dossier when none is named', () => {
    open(world(), OFFICER, '/');
    expect(screen.getByTestId('pick-permit').textContent).toBe(vi_['pmt.permit.pick.notice']);
    expect(screen.getByRole('link', { name: new RegExp(vi_['pmt.permit.back.link']) }).getAttribute('href')).toBe('/pmt/pmt-01');
  });

  it('says so when the permit named is not there or lies outside the scope of the caller', async () => {
    open(world());
    expect((await screen.findByTestId('no-permit')).textContent).toBe(vi_['pmt.permit.missing.notice']);
    expect(screen.queryByTestId('permit-summary')).toBeNull();
  });

  it('says so when the read is refused or fails, and reads again on retry', async () => {
    const state = world({ failing: new Set(['get_resources_permit_id']) });
    open(state);
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    state.failing.clear();
    state.permits = [permitDetail(1)];
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await screen.findByTestId('permit-summary');
    cleanup();
    const denied = new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} });
    const h = client(world());
    (h.read as unknown as { mockImplementation: (impl: () => Promise<never>) => void }).mockImplementation(() => Promise.reject(denied));
    mount(<PermitDetailScreen route={ROUTE} />, h, { permissions: OFFICER, path: `/?permit=${permitId(1)}` });
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
  });
});
