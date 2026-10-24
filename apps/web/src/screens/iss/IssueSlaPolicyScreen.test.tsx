import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { mountInSession } from '../adm/security/test-support';
import IssueSlaPolicyScreen from './IssueSlaPolicyScreen';
import { MANAGER, READER, category, client, mount, policy, routeOf, world } from './test-support';
import type { Harness, World } from './test-support';

const ROUTE = routeOf('ISS-09', 'FR-ISS-09');

afterEach(cleanup);

interface PolicyWorld extends World {
  policies: Array<Record<string, unknown>>;
}

/** The client of the test-support, with the read of the policies added (the reads of the form are answered by it). */
function withPolicies(state: PolicyWorld, command?: (operation: string, input: unknown) => unknown): Harness {
  const h = client(state, command);
  const readAll = (h.client as unknown as { readAll: (operation: string, input?: unknown) => Promise<unknown[]> }).readAll;
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string, input?: unknown) => {
    if (operation !== 'listIssueSlaPolicies') return readAll(operation, input);
    return state.failing.has(operation) ? Promise.reject(new Error('listIssueSlaPolicies failed')) : Promise.resolve(state.policies);
  });
  return h;
}
const worldOf = (policies: Array<Record<string, unknown>>, overrides: Partial<World> = {}): PolicyWorld => ({ ...world(overrides), policies });

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-group-key]'));
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));

describe('IssueSlaPolicyScreen (ISS-09): the SLA policies', () => {
  it('lists the policies by category, severity and unit, and counts them', async () => {
    mount(<IssueSlaPolicyScreen route={ROUTE} />, withPolicies(worldOf([policy(1), policy(2, { severity: 'LOW' })])), READER, '/iss/iss-09');
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['iss.sla.page.title']);
    expect(rows().map((row) => row.getAttribute('data-severity'))).toEqual(['HIGH', 'LOW']);
    expect(screen.getByTestId('count').textContent).toBe(vi_['iss.sla.count.text'].replace('{count}', '2'));
  });

  it('says when there is no policy yet, and still offers the form to those who may publish', async () => {
    mount(<IssueSlaPolicyScreen route={ROUTE} />, withPolicies(worldOf([])), MANAGER, '/iss/iss-09');
    expect((await screen.findByTestId('empty-policies')).textContent).toBe(vi_['iss.sla.empty.text']);
    expect(screen.getByRole('form', { name: vi_['iss.sla.form.aria'] })).toBeTruthy();
  });

  it('says that the policies could not be read, with a retry', async () => {
    const state = worldOf([policy(1)], { failing: new Set(['listIssueSlaPolicies']) });
    mount(<IssueSlaPolicyScreen route={ROUTE} />, withPolicies(state), MANAGER, '/iss/iss-09');
    expect(await screen.findByRole('alert')).toBeTruthy();
    state.failing = new Set();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await ready();
    expect(rows()).toHaveLength(1);
  });

  it('offers neither the form nor the end of a policy to someone without issue.sla.manage, or while the tenant is suspended', async () => {
    mount(<IssueSlaPolicyScreen route={ROUTE} />, withPolicies(worldOf([policy(1)])), READER, '/iss/iss-09');
    await ready();
    expect(screen.queryByRole('form', { name: vi_['iss.sla.form.aria'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['iss.sla.retire.action'] })).toBeNull();
    cleanup();
    mountInSession(<IssueSlaPolicyScreen route={ROUTE} />, withPolicies(worldOf([policy(1)])), { permissions: MANAGER, mode: 'READ_ONLY' });
    await ready();
    expect(screen.queryByRole('form', { name: vi_['iss.sla.form.aria'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['iss.sla.retire.action'] })).toBeNull();
  });

  it('shows a published policy at once: the list is read again after the command (AC-ST-ISS-001-2)', async () => {
    const state = worldOf([policy(1)]);
    const h = withPolicies(state, () => {
      state.policies = [...state.policies, policy(2, { code: 'SLA-NEW' })];
      return { operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: policy(2).id };
    });
    mount(<IssueSlaPolicyScreen route={ROUTE} />, h, MANAGER, '/iss/iss-09');
    await ready();
    expect(rows()).toHaveLength(1);
    await waitFor(() => expect(within(screen.getByLabelText(vi_['iss.sla.form.category.label'])).getAllByRole('option').length).toBeGreaterThan(1));
    const set = (label: string, value: string): void => {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    };
    set(vi_['iss.sla.form.code.label'], 'SLA-NEW');
    set(vi_['iss.sla.form.category.label'], category(2).version_id);
    set(vi_['iss.sla.form.response.label'], '4');
    set(vi_['iss.sla.form.resolve.label'], '16');
    set(vi_['iss.sla.form.validFrom.label'], '2999-01-01');
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['iss.sla.save.action'] }));
    await waitFor(() => expect(rows()).toHaveLength(2));
  });
});
