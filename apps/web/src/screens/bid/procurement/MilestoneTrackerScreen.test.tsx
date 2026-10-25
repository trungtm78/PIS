import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import MilestoneTrackerScreen from './MilestoneTrackerScreen';
import { OTHER_PROJECT, PLANNER, READER, client, mount, pack, packageId, routeOf, world } from './test-support';

const ROUTE = routeOf('BID-17', 'FR-BID-17');
const OK = { operation_id: 'o', status: 'BID_CLOSING', resource_version: 4, resource_id: packageId(1) };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const rowOf = (n: number): HTMLElement => document.querySelector(`[data-package-id="${packageId(n)}"]`) as HTMLElement;
const ready = () => screen.findByTestId('packages');
const label = (key: string) => screen.getByLabelText(vi_[key as keyof typeof vi_] as string);

describe('MilestoneTrackerScreen (BID-17): the milestones of the choice of a contractor', () => {
  it('UI-BID-17: lists the packages of a plan in force with their milestones in order, each with its dates and its source', async () => {
    mount(<MilestoneTrackerScreen route={ROUTE} />, client(world({ packages: [pack(1), pack(2), pack(3, { status: 'DRAFT' })] })), { permissions: READER });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['bid.milestones.page.title']);
    expect(Array.from(document.querySelectorAll('thead th')).map((header) => header.textContent)).toEqual([
      vi_['bid.milestones.column.package'],
      vi_['bid.milestones.column.project'],
      vi_['bid.milestones.column.milestones'],
      vi_['bid.milestones.column.action'],
    ]);
    // The package in a draft plan is not followed.
    expect(Array.from(document.querySelectorAll('[data-package-id]')).map((row) => row.getAttribute('data-package-id'))).toEqual([packageId(1), packageId(2)]);
    expect(rowOf(1).querySelector('th')?.textContent).toBe('GT-1 · Gói thầu xây lắp 1');
    const kinds = Array.from(rowOf(1).querySelectorAll('li')).map((item) => item.getAttribute('data-kind'));
    expect(kinds).toEqual(['INVITATION_PUBLISHED', 'BID_OPENING']);
    const opening = rowOf(1).querySelector('[data-kind="BID_OPENING"]') as HTMLElement;
    expect(within(opening).getByTestId('planned').textContent?.trim()).toBe(vi_['bid.milestones.planned.text'].replace('{date}', '2026-08-30'));
    expect(within(opening).getByTestId('actual').textContent?.trim()).toBe(vi_['bid.milestones.actual.text'].replace('{date}', '2026-09-01'));
    expect(within(opening).getByTestId('source').textContent).toBe(vi_['bid.milestone.source.import']);
    expect(within(rowOf(1).querySelector('[data-kind="INVITATION_PUBLISHED"]') as HTMLElement).getByTestId('source').textContent).toBe(vi_['bid.milestone.source.manual']);
    expect(within(rowOf(2)).getByTestId('no-milestones').textContent).toBe(vi_['bid.milestones.none.text']);
    // A reader sees the dates and has no button.
    expect(screen.queryByRole('button')).toBeNull();
    expect((screen.getByRole('link', { name: vi_['bid.milestones.links.link'] }) as HTMLAnchorElement).getAttribute('href')).toBe('/bid/bid-19');
  });

  it('filters by project and says so when the project has no package in force', async () => {
    mount(<MilestoneTrackerScreen route={ROUTE} />, client(world({ packages: [pack(1), pack(2, { project: { id: OTHER_PROJECT, code: 'PRJ-002', name: 'Đường tỉnh lộ' } })] })), { permissions: READER });
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['bid.milestones.project.label']), { target: { value: OTHER_PROJECT } });
    expect(document.querySelectorAll('[data-package-id]')).toHaveLength(1);
    expect(rowOf(2)).not.toBeNull();
  });

  it('says there is nothing to follow when no package is in force at all', async () => {
    mount(<MilestoneTrackerScreen route={ROUTE} />, client(world({ packages: [pack(1, { status: 'DRAFT' })], milestones: [] })), { permissions: READER });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  it('shows the error state when the packages cannot be read, and reads them again on retry', async () => {
    const state = world({ failing: new Set(['get_resources_procurement_package']) });
    const h = client(state);
    mount(<MilestoneTrackerScreen route={ROUTE} />, h, { permissions: READER });
    const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
    state.failing.clear();
    fireEvent.click(retry);
    await ready();
  });

  it('AC-ST-BID-005-1, UI-BID-17: records a milestone for a package under its version, with the dates read as Vietnam time, and closes', async () => {
    const h = client(world(), () => OK);
    mount(<MilestoneTrackerScreen route={ROUTE} />, h, { permissions: PLANNER });
    await ready();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['bid.milestones.record.aria'].replace('{code}', 'GT-1') }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(vi_['bid.milestone.dialog.title'].replace('{code}', 'GT-1'));
    // Without a kind or a date nothing is sent.
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['bid.milestone.dialog.submit'] }));
    expect(await within(dialog).findByText(vi_['bid.milestone.field.required'])).toBeTruthy();
    expect(within(dialog).getByText(vi_['bid.milestone.field.noDate'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(label('bid.milestone.field.kind'), { target: { value: 'BID_CLOSING' } });
    fireEvent.change(label('bid.milestone.field.actual'), { target: { value: '2026-09-01T09:30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['bid.milestone.dialog.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith(
      'recordProcurementMilestone',
      expect.objectContaining({ path: { id: packageId(1) }, ifMatchVersion: 3, body: { milestone_kind: 'BID_CLOSING', actual_at: '2026-09-01T02:30:00.000Z' } }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('corrects a milestone: the form starts from its dates, the kind cannot change, and choosing a kind that has dates fills them', async () => {
    const h = client(world(), () => OK);
    mount(<MilestoneTrackerScreen route={ROUTE} />, h, { permissions: PLANNER });
    await ready();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['bid.milestones.edit.aria'].replace('{kind}', vi_['bid.milestone.opening.label']).replace('{code}', 'GT-1') }));
    const dialog = await screen.findByRole('dialog');
    expect((label('bid.milestone.field.kind') as HTMLSelectElement).value).toBe('BID_OPENING');
    expect((label('bid.milestone.field.kind') as HTMLSelectElement).disabled).toBe(true);
    expect((label('bid.milestone.field.actual') as HTMLInputElement).value).toBe('2026-09-01T09:00');
    expect((label('bid.milestone.field.planned') as HTMLInputElement).value).toBe('2026-08-30T09:00');
    fireEvent.change(label('bid.milestone.field.actual'), { target: { value: '2026-09-02T09:00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['bid.milestone.dialog.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).toMatchObject({ milestone_kind: 'BID_OPENING', actual_at: '2026-09-02T02:00:00.000Z', planned_at: '2026-08-30T02:00:00.000Z' });
    cleanup();

    mount(<MilestoneTrackerScreen route={ROUTE} />, client(world(), () => OK), { permissions: PLANNER });
    await ready();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['bid.milestones.record.aria'].replace('{code}', 'GT-1') }));
    await screen.findByRole('dialog');
    fireEvent.change(label('bid.milestone.field.kind'), { target: { value: 'INVITATION_PUBLISHED' } });
    expect((label('bid.milestone.field.actual') as HTMLInputElement).value).toBe('2026-08-01T09:00');
    fireEvent.change(label('bid.milestone.field.kind'), { target: { value: 'CONTRACT_SIGNED' } });
    expect((label('bid.milestone.field.actual') as HTMLInputElement).value).toBe('');
  });

  it('refuses a date in the future before it sends anything', async () => {
    const h = client(world(), () => OK);
    mount(<MilestoneTrackerScreen route={ROUTE} />, h, { permissions: PLANNER });
    await ready();
    fireEvent.click(within(rowOf(2)).getByRole('button', { name: vi_['bid.milestones.record.aria'].replace('{code}', 'GT-2') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(label('bid.milestone.field.kind'), { target: { value: 'BID_OPENING' } });
    fireEvent.change(label('bid.milestone.field.actual'), { target: { value: '2099-01-01T09:00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['bid.milestone.dialog.submit'] }));
    expect(await within(dialog).findByText(vi_['bid.milestone.field.future'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says what the server refused, with the two milestones that break the order, and keeps the dialog open', async () => {
    const refuse = (code: string, extensions: Record<string, unknown> = {}) => () => new ApiError({ status: 409, code, correlationId: 'c', extensions });
    const cases: Array<[() => unknown, string]> = [
      [refuse('MILESTONE_ORDER_INVALID', { earlier_kind: 'BID_CLOSING', later_kind: 'BID_OPENING' }), vi_['bid.milestone.problem.order'].replace('{earlier}', vi_['bid.milestone.closing.label']).replace('{later}', vi_['bid.milestone.opening.label'])],
      [refuse('MILESTONE_ORDER_INVALID'), vi_['bid.milestone.problem.orderPlain']],
      [refuse('VERSION_CONFLICT'), vi_['bid.milestone.problem.conflict']],
      [refuse('PACKAGE_STATE_INVALID'), vi_['bid.milestone.problem.state']],
      [refuse('SCOPE_DENIED'), vi_['bid.milestone.problem.denied']],
      [refuse('RESOURCE_NOT_FOUND'), vi_['bid.milestone.problem.notFound']],
      [refuse('VALIDATION_FAILED'), vi_['bid.milestone.problem.validation']],
      [refuse('SESSION_EXPIRED'), vi_['bid.milestone.problem.session']],
      [refuse('OTHER'), vi_['bid.milestone.problem.general']],
    ];
    for (const [command, message] of cases) {
      mount(<MilestoneTrackerScreen route={ROUTE} />, client(world(), command), { permissions: PLANNER });
      await ready();
      fireEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['bid.milestones.edit.aria'].replace('{kind}', vi_['bid.milestone.opening.label']).replace('{code}', 'GT-1') }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: vi_['bid.milestone.dialog.submit'] }));
      expect((await screen.findByTestId('refusal')).textContent).toBe(message);
      expect(screen.getByRole('dialog')).toBeTruthy();
      cleanup();
    }
  });

  it('offers no record in a read-only session, and closes the dialog without sending when it is cancelled', async () => {
    mount(<MilestoneTrackerScreen route={ROUTE} />, client(world()), { permissions: PLANNER, mode: 'READ_ONLY' });
    await ready();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    const h = client(world(), () => OK);
    mount(<MilestoneTrackerScreen route={ROUTE} />, h, { permissions: PLANNER });
    await ready();
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: vi_['bid.milestones.record.aria'].replace('{code}', 'GT-1') }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: vi_['bid.milestone.dialog.cancel'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(h.command).not.toHaveBeenCalled();
  });
});
