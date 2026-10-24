import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import MasterHubScreen from './MasterHubScreen';
import { READER, STEWARD, change, client, mount, record, routeOf, world } from './test-support';

const ROUTE = routeOf('MDM-01', 'FR-MDM-01');
const fill = (template: string, params: Record<string, string | number>): string => template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));

afterEach(cleanup);

const ready = () => waitFor(() => expect(document.querySelector('[data-record-id]')).not.toBeNull());

describe('MasterHubScreen (MDM-01)', () => {
  it('shows a card per catalogue type with what is in force and what waits, and the records below', async () => {
    const state = world({ records: [record(1), record(2, { status: 'DRAFT', open_change_request_id: 'c1' }), record(3, { master_type: 'FUND_SOURCE', business_key: 'NSTW' })] });
    mount(<MasterHubScreen route={ROUTE} />, client(state), STEWARD);
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['mdm.hub.page.title']);
    const sector = document.querySelector('[data-type-card="SECTOR"]') as HTMLElement;
    expect(sector.textContent).toContain(fill(vi_['mdm.hub.card.summary'], { total: 2, inForce: 1, open: 1 }));
    expect(document.querySelector('[data-type-card="FUND_SOURCE"]')?.textContent).toContain(fill(vi_['mdm.hub.card.summary'], { total: 1, inForce: 1, open: 0 }));
    expect(document.querySelectorAll('[data-record-id]')).toHaveLength(3);
    const waiting = document.querySelector('[data-status="DRAFT"]') as HTMLElement;
    expect(within(waiting).getByText(vi_['mdm.hub.pending.pill'])).toBeTruthy();
    expect(within(waiting).getByText(vi_['mdm.status.record.draft'])).toBeTruthy();
  });

  it('keeps only the records of the chosen type, and shows all of them again on the second click', async () => {
    const state = world({ records: [record(1), record(3, { master_type: 'FUND_SOURCE', business_key: 'NSTW' })] });
    mount(<MasterHubScreen route={ROUTE} />, client(state), STEWARD);
    await ready();
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-type-card="FUND_SOURCE"]') as HTMLElement);
    expect(document.querySelectorAll('[data-record-id]')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 2, name: fill(vi_['mdm.hub.table.type.title'], { type: 'FUND_SOURCE' }) })).toBeTruthy();
    await user.click(document.querySelector('[data-type-card="FUND_SOURCE"]') as HTMLElement);
    expect(document.querySelectorAll('[data-record-id]')).toHaveLength(2);
  });

  it('counts the requests that wait for a review in the link to the queue, and links each record to its detail and history', async () => {
    const state = world({ changes: [change(1), change(2), change(3, { status: 'APPROVED' })] });
    mount(<MasterHubScreen route={ROUTE} />, client(state), STEWARD);
    await ready();
    await waitFor(() => expect(screen.getByTestId('queue-link').textContent).toBe(fill(vi_['mdm.hub.queue.link'], { count: 2 })));
    expect(screen.getByTestId('queue-link').getAttribute('href')).toBe('/mdm/mdm-32');
    const row = document.querySelector(`[data-record-id="${record(1).id}"]`) as HTMLElement;
    expect(within(row).getByText(vi_['mdm.hub.open.action']).getAttribute('href')).toBe('/mdm/mdm-27?type=SECTOR&key=GT-1');
    expect(within(row).getByText(vi_['mdm.hub.history.action']).getAttribute('href')).toBe('/mdm/mdm-28?type=SECTOR&key=GT-1');
  });

  it('offers to add an entry only to someone who may propose, and not while the tenant is suspended', async () => {
    mount(<MasterHubScreen route={ROUTE} />, client(world()), STEWARD);
    await ready();
    expect(screen.getByText(vi_['mdm.hub.add.action']).getAttribute('href')).toBe('/mdm/mdm-25');
    cleanup();
    mount(<MasterHubScreen route={ROUTE} />, client(world()), READER);
    await ready();
    expect(screen.queryByText(vi_['mdm.hub.add.action'])).toBeNull();
  });

  it('shows the empty state when the tenant has no entry, and an error with a retry that reads again', async () => {
    const state = world({ records: [] });
    mount(<MasterHubScreen route={ROUTE} />, client(state), STEWARD);
    await waitFor(() => expect(document.querySelector('[data-record-id]')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    cleanup();
    const failing = world({ failing: new Set(['searchMasterRecords']) });
    mount(<MasterHubScreen route={ROUTE} />, client(failing), STEWARD);
    const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
    failing.failing.clear();
    await userEvent.setup().click(retry);
    await ready();
  });
});
