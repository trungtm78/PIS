import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en_ from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import CampaignApprovalScreen from './CampaignApprovalScreen';
import CampaignScheduleScreen from './CampaignScheduleScreen';
import SegmentScreen from './SegmentScreen';
import { campaignBody, campaignProblems, describeProblem, emptyForm, excludedTotal, parseRoles, shortHash, toCampaign, toPreview, validUntil } from './campaign/model';
import { campaignsKey } from './campaign/hooks';
import { harness, mount, routeOf, TENANT } from './delivery/test-support';

const MAKER = ['notification.campaign.manage', 'notification.campaign.read'];
const CHECKER = ['notification.campaign.approve', 'notification.campaign.read'];
const READER = ['notification.campaign.read'];
const NOBODY = ['notification.self'];
const HASH = 'ab12'.repeat(16);
const reason = 'The notice was checked against the circular.';
const problem = (code: string, status = 409, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail });

const rawCampaign = (overrides: Record<string, unknown> = {}) => ({
  id: 'campaign-1',
  name: 'Holiday notice',
  purpose: 'ANNOUNCEMENT',
  template_version_id: 'template-1',
  template_code: 'campaign.notice',
  template_channel: 'EMAIL',
  segment: { unit_ids: ['unit-2'], role_codes: ['STAFF'], include_guests: false, units: [{ id: 'unit-2', name: 'Operations', code: 'OPS' }] },
  scheduled_at: '2026-11-01T01:00:00Z',
  status: 'Previewed',
  recipient_count: 120,
  excluded: { opted_out: 10, no_consent: 3, inactive: 2, duplicate: 1 },
  preview_hash: HASH,
  previewed_at: '2026-10-30T03:00:00Z',
  created_by: 'someone-else',
  created_at: '2026-10-30T02:00:00Z',
  notification_count: 0,
  waiting_count: 0,
  version: 4,
  ...overrides,
});
const unit = (id: string, name: string, depth: number) => ({ id, code: id, name, parent_id: null, valid_from: '2026-01-01', valid_until: null, unit_type: 'DEPARTMENT', administrative_code: null, is_investor: false, legal_basis_ref: null, status: 'Active', successor_id: null, depth, version: 1 });
const template = (id: string, code: string, channel: string, status = 'Active', variables = false) => ({ id, code, channel, locale: 'vi-VN', revision: 1, purpose: 'OPERATIONAL', content_ast: { body: 'B' }, variable_schema: variables ? { properties: { code: { type: 'string', classification: 'PUBLIC' } } } : {}, status, created_by: 'x', created_at: '2026-10-01T00:00:00Z', version: 1 });

afterEach(cleanup);

interface Answers {
  campaigns?: () => unknown;
  command?: (operation: string, input: unknown) => unknown;
}

function open(element: JSX.Element, permissions: readonly string[], answers: Answers = {}) {
  const campaigns = answers.campaigns ?? (() => [rawCampaign()]);
  const respond = (value: unknown) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
  const h = harness(
    (operation) => (operation === 'get_resources_notification_template_version' ? { items: [template('template-1', 'campaign.notice', 'EMAIL'), template('template-2', 'campaign.inbox', 'IN_APP'), template('template-3', 'campaign.old', 'EMAIL', 'Retired'), template('template-4', 'campaign.variable', 'EMAIL', 'Active', true)], next_cursor: null } : new Error(`unexpected read ${operation}`)),
    answers.command ?? (() => ({})),
  );
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    if (operation === 'listCampaigns') return respond(campaigns());
    if (operation === 'get_resources_organization_unit') return respond([unit('unit-1', 'Head office', 0), unit('unit-2', 'Operations', 1)]);
    return respond(new Error(`unexpected readAll ${operation}`));
  });
  return { h, ...mount(element, h, { permissions }) };
}
const segments = (permissions: readonly string[], answers?: Answers) => open(<SegmentScreen route={routeOf('NOT-09', 'FR-NOT-09')} />, permissions, answers);
const schedule = (permissions: readonly string[], answers?: Answers) => open(<CampaignScheduleScreen route={routeOf('NOT-10', 'FR-NOT-10')} />, permissions, answers);
const approval = (permissions: readonly string[], answers?: Answers) => open(<CampaignApprovalScreen route={routeOf('NOT-16', 'FR-NOT-16')} />, permissions, answers);

const stateTitles = [
  [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
  [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
  [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
  [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
] as const;

describe('NOT-09 recipient groups (UI-NOT-09)', () => {
  it('AC-ST-NOT-009-4 UI-NOT-09: shows the campaigns not yet sent to approval with the last preview, the people left out for each reason and the hash', async () => {
    segments(MAKER, { campaigns: () => [rawCampaign(), rawCampaign({ id: 'campaign-2', name: 'Sent', status: 'PendingApproval' }), rawCampaign({ id: 'campaign-3', name: 'Fresh', status: 'Draft', recipient_count: null, excluded: null, preview_hash: null })] });
    const first = (await waitFor(() => {
      const row = document.querySelector('[data-campaign-id="campaign-1"]') as HTMLElement | null;
      if (row === null) throw new Error('not yet');
      return row;
    })) as HTMLElement;
    expect(first.querySelector('[data-count]')?.textContent).toBe(vi_['not.segment.preview.count'].replace('{count}', '120'));
    expect(first.querySelector('[data-hash]')?.textContent).toBe(HASH.slice(0, 12));
    expect(first.querySelector('[data-reason="opted_out"]')?.textContent).toContain('10');
    expect(first.querySelector('[data-reason="no_consent"]')?.textContent).toContain('3');
    expect(first.querySelector('[data-reason="inactive"]')?.textContent).toContain('2');
    expect(first.querySelector('[data-reason="duplicate"]')?.textContent).toContain('1');
    expect(first.textContent).toContain(vi_['not.segment.preview.excluded'].replace('{count}', '16'));
    // The campaign already sent to approval is not here, and a draft says it was not previewed.
    expect(document.querySelector('[data-campaign-id="campaign-2"]')).toBeNull();
    expect((document.querySelector('[data-campaign-id="campaign-3"]') as HTMLElement).querySelector('[data-no-preview]')?.textContent).toBe(vi_['not.segment.preview.none']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['not.segment.page.title']);
  });

  it('AC-ST-NOT-009-4 UI-NOT-09: shows a loading state, then the denied, signed-out, offline and error states, and says in words when there is no draft', async () => {
    for (const [error, title] of stateTitles) {
      segments(READER, { campaigns: () => error });
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const loading = segments(MAKER, { campaigns: () => [] });
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    expect(await screen.findByText(vi_['not.segment.list.none'])).toBeTruthy();
    cleanup();
    const { h } = segments(NOBODY);
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect((h.client.readAll as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalledWith('listCampaigns', expect.anything());
  });

  it('offers only the Active templates without variables of a channel that sends outside and the units of the tenant, and tells before sending what the server would refuse', async () => {
    const { h } = segments(MAKER, { campaigns: () => [], command: () => ({ operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: 'campaign-9' }) });
    const select = (await screen.findByLabelText(vi_['not.segment.form.template.label'])) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    expect([...select.options].map((option) => option.value)).toEqual(['', 'template-1']);
    expect(await screen.findByLabelText('Operations')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: vi_['not.segment.form.submit.action'] }));
    for (const key of ['not.segment.form.name.invalid', 'not.segment.form.template.invalid', 'not.segment.form.segment.invalid'] as const) expect(screen.getByText(vi_[key])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(vi_['not.segment.form.roles.label']), { target: { value: 'bad-role!' } });
    fireEvent.change(screen.getByLabelText(vi_['not.segment.form.schedule.label']), { target: { value: '2020-01-01T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['not.segment.form.submit.action'] }));
    expect(screen.getByText(vi_['not.segment.form.roles.invalid'])).toBeTruthy();
    expect(screen.getByText(vi_['not.segment.form.schedule.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('makes a campaign with the group, the template and the time, sending only what was chosen, and says it is a draft', async () => {
    const { h } = segments(MAKER, { campaigns: () => [], command: () => ({ operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: 'campaign-9' }) });
    const select = (await screen.findByLabelText(vi_['not.segment.form.template.label'])) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    fireEvent.change(screen.getByLabelText(vi_['not.segment.form.name.label']), { target: { value: '  Holiday notice ' } });
    fireEvent.change(select, { target: { value: 'template-1' } });
    fireEvent.click(await screen.findByLabelText('Operations'));
    fireEvent.change(screen.getByLabelText(vi_['not.segment.form.roles.label']), { target: { value: 'staff, engineer' } });
    fireEvent.click(screen.getByLabelText(vi_['not.segment.form.guests.label']));
    const at = new Date(Date.now() + 2 * 86_400_000);
    const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    fireEvent.change(screen.getByLabelText(vi_['not.segment.form.schedule.label']), { target: { value: local } });
    fireEvent.click(screen.getByRole('button', { name: vi_['not.segment.form.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, input] = h.command.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(operation).toBe('createCampaign');
    expect(input.body).toMatchObject({ name: 'Holiday notice', purpose: 'ANNOUNCEMENT', template_version_id: 'template-1', segment: { unit_ids: ['unit-2'], role_codes: ['ENGINEER', 'STAFF'], include_guests: true } });
    expect(Date.parse(input.body.scheduled_at as string)).toBe(Date.parse(local));
    expect(await screen.findByText(vi_['not.segment.done.created'])).toBeTruthy();
  });

  it('says what the server refused with and keeps what was typed: a group that names nobody, a template that cannot be used, a time, the scope', async () => {
    for (const [code, key] of [['SEGMENT_INVALID', 'not.campaign.problem.segment'], ['TEMPLATE_INVALID', 'not.campaign.problem.template'], ['SCOPE_DENIED', 'not.campaign.problem.denied']] as const) {
      segments(MAKER, { campaigns: () => [], command: () => problem(code, code === 'SCOPE_DENIED' ? 403 : 409) });
      const select = (await screen.findByLabelText(vi_['not.segment.form.template.label'])) as HTMLSelectElement;
      await waitFor(() => expect(select.options.length).toBe(2));
      fireEvent.change(screen.getByLabelText(vi_['not.segment.form.name.label']), { target: { value: 'Keep me' } });
      fireEvent.change(select, { target: { value: 'template-1' } });
      fireEvent.change(screen.getByLabelText(vi_['not.segment.form.roles.label']), { target: { value: 'STAFF' } });
      fireEvent.click(screen.getByRole('button', { name: vi_['not.segment.form.submit.action'] }));
      expect(await screen.findByText(vi_[key])).toBeTruthy();
      expect((screen.getByLabelText(vi_['not.segment.form.name.label']) as HTMLInputElement).value).toBe('Keep me');
      cleanup();
    }
  });

  it('previews the recipients with a reason at the version read, and shows the count, the people left out by reason, the hash and the masked samples', async () => {
    const preview = { recipient_count: 120, excluded: { opted_out: 10, no_consent: 0, inactive: 0, duplicate: 0 }, preview_hash: HASH, sample_recipients_masked: ['N*** V*** A***', 'T*** B***'], previewed_at: '2026-10-30T03:00:00Z', version: 5 };
    const { h } = segments(MAKER, { campaigns: () => [rawCampaign({ status: 'Draft', recipient_count: null, excluded: null, preview_hash: null })], command: () => preview });
    const row = (await waitFor(() => {
      const found = document.querySelector('[data-campaign-id="campaign-1"]') as HTMLElement | null;
      if (found === null) throw new Error('not yet');
      return found;
    })) as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: vi_['not.segment.preview.action'] }));
    const form = (await screen.findByRole('form', { name: vi_['not.segment.preview.form.aria'].replace('{name}', 'Holiday notice') })) as HTMLElement;
    fireEvent.click(within(form).getByRole('button', { name: vi_['not.segment.preview.run.action'] }));
    expect(within(form).getByText(vi_['not.segment.preview.reason.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['not.segment.preview.reason.label']), { target: { value: reason } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['not.segment.preview.run.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['previewCampaignRecipients', expect.objectContaining({ path: { campaignId: 'campaign-1' }, body: { reason }, ifMatchVersion: 4 })]);
    await waitFor(() => expect(row.querySelector('[data-count]')?.textContent).toBe(vi_['not.segment.preview.count'].replace('{count}', '120')));
    expect(row.querySelector('[data-reason="opted_out"]')?.textContent).toContain('10');
    expect(row.querySelector('[data-samples]')?.textContent).toContain('N*** V*** A***');
  });

  it('shows no form to a person who only reads', async () => {
    segments(READER, { campaigns: () => [rawCampaign({ status: 'Draft' })] });
    await screen.findByText('Holiday notice');
    expect(screen.queryByRole('form', { name: vi_['not.segment.form.aria'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['not.segment.preview.action'] })).toBeNull();
  });
});

describe('NOT-10 schedule and campaigns (UI-NOT-10)', () => {
  it('AC-ST-NOT-009-5 UI-NOT-10: shows when each campaign goes out, in which zone, until when, to how many, its hash and its state', async () => {
    schedule(MAKER, {
      campaigns: () => [
        rawCampaign(),
        rawCampaign({ id: 'campaign-2', name: 'As soon as possible', scheduled_at: null, status: 'Sending', approved_at: '2026-10-28T03:00:00Z', notification_count: 120, waiting_count: 30 }),
        rawCampaign({ id: 'campaign-3', name: 'Fresh', status: 'Draft', scheduled_at: null, recipient_count: null, excluded: null, preview_hash: null }),
      ],
    });
    const table = await screen.findByRole('table');
    const first = table.querySelector('[data-campaign-id="campaign-1"]') as HTMLElement;
    expect(first.querySelector('[data-zone]')?.textContent).toBe('Asia/Ho_Chi_Minh');
    expect(first.querySelector('[data-time]')?.textContent).toContain('1/11/26');
    expect(first.querySelector('[data-valid]')?.textContent).toContain('8/11/26');
    expect(first.querySelector('[data-recipients]')?.textContent).toContain('120');
    expect(first.querySelector('[data-hash]')?.textContent).toBe(HASH.slice(0, 12));
    expect(first.querySelector('[data-status]')?.textContent).toBe(vi_['not.campaign.status.previewed']);
    const second = table.querySelector('[data-campaign-id="campaign-2"]') as HTMLElement;
    expect(second.querySelector('[data-time]')?.textContent).toBe(vi_['not.schedule.time.asap']);
    expect(second.querySelector('[data-valid]')?.textContent).toContain('4/11/26');
    expect(second.querySelector('[data-recipients]')?.textContent).toContain('30');
    const third = table.querySelector('[data-campaign-id="campaign-3"]') as HTMLElement;
    expect(third.querySelector('[data-valid]')?.textContent).toBe(vi_['not.schedule.valid.none']);
    expect(third.querySelector('[data-recipients]')?.textContent).toBe(vi_['not.schedule.recipients.none']);
    expect(third.querySelector('[data-hash]')?.textContent).toBe(vi_['not.schedule.hash.none']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['not.schedule.page.title']);
  });

  it('AC-ST-NOT-009-5 UI-NOT-10: shows a loading state, then the denied, signed-out, offline and error states, and says in words when there is no campaign', async () => {
    for (const [error, title] of stateTitles) {
      schedule(READER, { campaigns: () => error });
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const loading = schedule(READER, { campaigns: () => [] });
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    schedule(NOBODY);
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
  });

  it('reads the state chosen in the filter', async () => {
    const { h } = schedule(READER);
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText(vi_['not.schedule.filter.label']), { target: { value: 'Rejected' } });
    await waitFor(() => expect((h.client.readAll as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual(['listCampaigns', { query: { status: 'Rejected' } }]));
  });

  it('sends a previewed campaign to approval with the hash of its preview at the version read, and only a previewed one', async () => {
    const { h } = schedule(MAKER, { campaigns: () => [rawCampaign(), rawCampaign({ id: 'campaign-2', name: 'Waiting', status: 'PendingApproval' })], command: () => ({ operation_id: 'o', status: 'PENDINGAPPROVAL', resource_version: 5, resource_id: 'campaign-1' }) });
    await screen.findByRole('table');
    expect(screen.getAllByRole('button', { name: new RegExp(vi_['not.schedule.submit.action']) })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: vi_['not.schedule.submit.aria'].replace('{name}', 'Holiday notice') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['submitCampaign', expect.objectContaining({ path: { campaignId: 'campaign-1' }, body: { preview_hash: HASH }, ifMatchVersion: 4 })]);
    expect(await screen.findByText(vi_['not.schedule.done.submitted'])).toBeTruthy();
  });

  it('tells in words that the set changed (PREVIEW_STALE) and that the campaign is not in a state for it', async () => {
    for (const [code, key] of [['PREVIEW_STALE', 'not.campaign.problem.stale'], ['CAMPAIGN_STATE_INVALID', 'not.campaign.problem.state'], ['VERSION_CONFLICT', 'not.campaign.problem.conflict']] as const) {
      schedule(MAKER, { command: () => problem(code) });
      await screen.findByRole('table');
      fireEvent.click(screen.getByRole('button', { name: vi_['not.schedule.submit.aria'].replace('{name}', 'Holiday notice') }));
      expect(await screen.findByText(vi_[key])).toBeTruthy();
      cleanup();
    }
  });

  it('cancels a campaign that has not ended with a reason, asking for one before it sends anything, and offers no cancel for one that ended', async () => {
    const { h } = schedule(MAKER, { campaigns: () => [rawCampaign(), rawCampaign({ id: 'campaign-2', name: 'Done', status: 'Completed' }), rawCampaign({ id: 'campaign-3', name: 'Dropped', status: 'Cancelled' })], command: () => ({ operation_id: 'o', status: 'CANCELLED', resource_version: 5, resource_id: 'campaign-1' }) });
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: vi_['not.schedule.cancel.aria'].replace('{name}', 'Done') })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['not.schedule.cancel.aria'].replace('{name}', 'Dropped') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: vi_['not.schedule.cancel.aria'].replace('{name}', 'Holiday notice') }));
    const form = (await screen.findByRole('form', { name: vi_['not.schedule.cancel.form.aria'].replace('{name}', 'Holiday notice') })) as HTMLElement;
    fireEvent.click(within(form).getByRole('button', { name: vi_['not.schedule.cancel.confirm.action'] }));
    expect(within(form).getByText(vi_['not.schedule.cancel.reason.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['not.schedule.cancel.reason.label']), { target: { value: reason } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['not.schedule.cancel.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['cancelCampaign', expect.objectContaining({ path: { campaignId: 'campaign-1' }, body: { reason }, ifMatchVersion: 4 })]);
    expect(await screen.findByText(vi_['not.schedule.done.cancelled'])).toBeTruthy();
  });

  it('offers no action to a person who only reads, nor in read-only mode', async () => {
    schedule(READER);
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: vi_['not.schedule.submit.aria'].replace('{name}', 'Holiday notice') })).toBeNull();
    expect(screen.queryByRole('link', { name: vi_['not.schedule.new.link'] })).toBeNull();
  });
});

describe('NOT-16 broadcast approval (UI-NOT-16)', () => {
  it('AC-ST-NOT-009-3 UI-NOT-16: shows the scope, the template, the number of people, the exclusions per reason, the hash and who made the campaign', async () => {
    const { h } = approval(CHECKER);
    const card = (await waitFor(() => {
      const found = document.querySelector('[data-campaign-id="campaign-1"]') as HTMLElement | null;
      if (found === null) throw new Error('not yet');
      return found;
    })) as HTMLElement;
    expect(card.querySelector('[data-scope]')?.textContent).toContain(vi_['not.approval.scope.text'].replace('{units}', '1').replace('{roles}', 'STAFF').replace('{guests}', vi_['not.approval.guests.no']));
    // The approver reads which units, by name, and not only how many.
    expect(card.querySelector('[data-unit-id="unit-2"]')?.textContent).toBe('Operations (OPS)');
    expect(card.querySelector('[data-template]')?.textContent).toContain('campaign.notice');
    expect(card.querySelector('[data-recipients]')?.textContent).toBe('120');
    expect(card.querySelector('[data-excluded-total]')?.textContent).toContain('16');
    expect(card.querySelector('[data-reason="opted_out"]')?.textContent).toContain('10');
    expect(card.querySelector('[data-hash]')?.textContent).toBe(HASH.slice(0, 12));
    expect(card.querySelector('[data-creator]')?.textContent).toBe('someone-else');
    expect(card.querySelector('[data-self]')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['not.approval.page.title']);
    expect((h.client.readAll as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual(['listCampaigns', { query: { status: 'PendingApproval' } }]);
  });

  it('AC-ST-NOT-009-3 UI-NOT-16: shows a loading state, then the denied, signed-out, offline and error states, and says in words when nothing waits', async () => {
    for (const [error, title] of stateTitles) {
      approval(CHECKER, { campaigns: () => error });
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const loading = approval(CHECKER, { campaigns: () => [] });
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    approval(NOBODY);
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
  });

  it('approves with a reason at the version read, asking for the reason first, and sends back or rejects the same way', async () => {
    const { h } = approval(CHECKER, { command: () => ({ operation_id: 'o', status: 'SENDING', resource_version: 6, resource_id: 'campaign-1' }) });
    const card = (await waitFor(() => {
      const found = document.querySelector('[data-campaign-id="campaign-1"]') as HTMLElement | null;
      if (found === null) throw new Error('not yet');
      return found;
    })) as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: vi_['not.approval.approve.action'] }));
    expect(within(card).getByText(vi_['not.approval.reason.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(card).getByLabelText(vi_['not.approval.reason.label']), { target: { value: reason } });
    fireEvent.click(within(card).getByRole('button', { name: vi_['not.approval.approve.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['decideCampaign', expect.objectContaining({ path: { campaignId: 'campaign-1' }, body: { decision: 'approve', reason, evidence_ids: [] }, ifMatchVersion: 4 })]);
    expect(await screen.findByText(vi_['not.approval.done.approve'])).toBeTruthy();
    fireEvent.change(within(card).getByLabelText(vi_['not.approval.reason.label']), { target: { value: reason } });
    fireEvent.click(within(card).getByRole('button', { name: vi_['not.approval.reject.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect((h.command.mock.calls[1] as [string, { body: Record<string, unknown> }])[1].body).toMatchObject({ decision: 'reject' });
    fireEvent.change(within(card).getByLabelText(vi_['not.approval.reason.label']), { target: { value: reason } });
    fireEvent.click(within(card).getByRole('button', { name: vi_['not.approval.return.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(3));
    expect((h.command.mock.calls[2] as [string, { body: Record<string, unknown> }])[1].body).toMatchObject({ decision: 'return' });
  });

  it('does not let the person who made the campaign decide: the notice is there and the buttons are off', async () => {
    approval(CHECKER, { campaigns: () => [rawCampaign({ status: 'PendingApproval', created_by: TENANT.membershipId })] });
    const card = (await waitFor(() => {
      const found = document.querySelector('[data-campaign-id="campaign-1"]') as HTMLElement | null;
      if (found === null) throw new Error('not yet');
      return found;
    })) as HTMLElement;
    expect(card.querySelector('[data-self]')?.textContent).toBe(vi_['not.approval.self.notice']);
    for (const key of ['not.approval.approve.action', 'not.approval.return.action', 'not.approval.reject.action'] as const) expect((within(card).getByRole('button', { name: vi_[key] }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says in words what the server refused with: the set changed since the preview, the maker, the state, the channel, and a conflict', async () => {
    for (const [code, status, key] of [
      ['PREVIEW_STALE', 409, 'not.campaign.problem.stale'],
      ['SELF_APPROVAL_DENIED', 403, 'not.campaign.problem.self'],
      ['CAMPAIGN_STATE_INVALID', 409, 'not.campaign.problem.state'],
      ['CHANNEL_UNVERIFIED', 422, 'not.campaign.problem.channel'],
      ['VERSION_CONFLICT', 409, 'not.campaign.problem.conflict'],
    ] as const) {
      approval(CHECKER, { command: () => problem(code, status) });
      const card = (await waitFor(() => {
        const found = document.querySelector('[data-campaign-id="campaign-1"]') as HTMLElement | null;
        if (found === null) throw new Error('not yet');
        return found;
      })) as HTMLElement;
      fireEvent.change(within(card).getByLabelText(vi_['not.approval.reason.label']), { target: { value: reason } });
      fireEvent.click(within(card).getByRole('button', { name: vi_['not.approval.approve.action'] }));
      expect(await screen.findByText(vi_[key])).toBeTruthy();
      cleanup();
    }
  });

  it('shows the campaigns to a person who only reads but no decision', async () => {
    approval(READER);
    await waitFor(() => expect(document.querySelector('[data-campaign-id="campaign-1"]')).not.toBeNull());
    expect(screen.queryByRole('button', { name: vi_['not.approval.approve.action'] })).toBeNull();
  });
});

describe('the model of the campaign screens', () => {
  it('reads a campaign and a preview as the API answers them, and leaves out what is not one', () => {
    expect(toCampaign(rawCampaign())).toMatchObject({ id: 'campaign-1', unitIds: ['unit-2'], roleCodes: ['STAFF'], includeGuests: false, recipientCount: 120, excluded: { opted_out: 10, no_consent: 3, inactive: 2, duplicate: 1 }, previewHash: HASH, version: 4 });
    expect(toCampaign(rawCampaign({ status: 'Nope' }))).toBeUndefined();
    expect(toCampaign(rawCampaign({ purpose: 'MARKETING' }))).toBeUndefined();
    expect(toCampaign({})).toBeUndefined();
    expect(toCampaign(rawCampaign({ recipient_count: null, excluded: undefined, scheduled_at: null }))).toMatchObject({ recipientCount: undefined, excluded: undefined, scheduledAt: undefined });
    expect(toPreview({ recipient_count: 3, excluded: { opted_out: 1 }, preview_hash: HASH, sample_recipients_masked: ['A***'], previewed_at: 'x', version: 2 })).toEqual({ recipientCount: 3, excluded: { opted_out: 1, no_consent: 0, inactive: 0, duplicate: 0 }, hash: HASH, samples: ['A***'], previewedAt: 'x', version: 2 });
    expect(excludedTotal(undefined)).toBe(0);
    expect(shortHash(undefined)).toBe('');
  });

  it('counts the validity from the time of the campaign, or from its approval when it has no time', () => {
    expect(validUntil({ scheduledAt: '2026-11-01T01:00:00Z', approvedAt: undefined })?.toISOString()).toBe('2026-11-08T01:00:00.000Z');
    expect(validUntil({ scheduledAt: undefined, approvedAt: '2026-10-28T03:00:00Z' })?.toISOString()).toBe('2026-11-04T03:00:00.000Z');
    expect(validUntil({ scheduledAt: undefined, approvedAt: undefined })).toBeUndefined();
    // Approved after its time, the sends were due at the approval: the validity counts from there.
    expect(validUntil({ scheduledAt: '2026-11-01T01:00:00Z', approvedAt: '2026-11-03T03:00:00Z' })?.toISOString()).toBe('2026-11-10T03:00:00.000Z');
    expect(validUntil({ scheduledAt: '2026-11-05T01:00:00Z', approvedAt: '2026-11-03T03:00:00Z' })?.toISOString()).toBe('2026-11-12T01:00:00.000Z');
  });

  it('judges the form the way the server does and builds a body of what was chosen', () => {
    const now = new Date('2026-10-30T10:00:00Z');
    expect(campaignProblems(emptyForm(), now)).toEqual(['name', 'template', 'segment']);
    expect(campaignProblems({ ...emptyForm(), name: 'x'.repeat(121), templateId: 't', roles: 'bad role!' }, now)).toEqual(['name', 'roles']);
    expect(campaignProblems({ ...emptyForm(), name: 'ok', templateId: 't', unitIds: ['u'], scheduledAt: '2026-10-30T10:00:30Z' }, now)).toEqual(['schedule']);
    expect(parseRoles(' staff; engineer,STAFF ')).toEqual(['ENGINEER', 'STAFF']);
    expect(campaignBody({ ...emptyForm(), name: ' ok ', templateId: 't', unitIds: ['u'] })).toEqual({ name: 'ok', purpose: 'ANNOUNCEMENT', template_version_id: 't', segment: { unit_ids: ['u'], include_guests: false } });
  });

  it('maps the codes of the server to what the person is told', () => {
    expect(describeProblem(problem('PREVIEW_STALE'))).toEqual({ reason: 'stale', field: undefined });
    expect(describeProblem(problem('VALIDATION_FAILED', 422, 'reason'))).toEqual({ reason: 'invalid', field: 'reason' });
    expect(describeProblem(problem('ENTITLEMENT_DENIED', 403))).toEqual({ reason: 'denied', field: undefined });
    expect(describeProblem(new Error('x'))).toEqual({ reason: 'general', field: undefined });
  });

  it('keeps the campaigns one membership read apart from those of another in the same tenant', () => {
    expect(campaignsKey('tenant-1', 'member-1')).not.toEqual(campaignsKey('tenant-1', 'member-2'));
    expect(campaignsKey('tenant-1', 'member-1')).toEqual(campaignsKey('tenant-1', 'member-1'));
  });

  it('has every string of the three screens in both languages', () => {
    const keys = Object.keys(vi_).filter((key) => /^not\.(segment|schedule|approval|campaign)\./.test(key));
    expect(keys.length).toBeGreaterThan(100);
    for (const key of keys) expect(Object.keys(en_)).toContain(key);
  });
});
