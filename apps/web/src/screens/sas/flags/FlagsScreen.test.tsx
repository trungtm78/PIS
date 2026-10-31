import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { harness, mount, routeOf } from '../test-support';
import FlagsScreen from './FlagsScreen';
import { cohortsOf, describeFlag, flagBody, formOfFlag, holds, isChangeable, tenantIdsOf, toFlags, validateFlag } from './model';
import type { FlagForm } from './model';

const ROUTE = routeOf('SAS-20', 'FR-SAS-20');
const ADMIN = ['system.release.manage'];
const OPERATOR = ['system.tenant.read'];
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const OK = { operation_id: 'o', status: 'Rollout', resource_version: 3, resource_id: 'x' };

const flag = (key: string, overrides: Record<string, unknown> = {}) => ({
  flag_key: key,
  description: `Description of ${key}`,
  status: 'Off',
  rollout: { tenant_cohorts: [], tenant_ids: [], percentage: 0 },
  revision: 1,
  version: 1,
  updated_by: '00000000-0000-4000-8000-0000000000c9',
  updated_at: '2026-10-31T01:00:00.000000Z',
  ...overrides,
});

afterEach(cleanup);

const open = (items: unknown[], command: (operation: string, input: unknown) => unknown = () => OK) => harness((operation) => (operation === 'listFeatureFlags' ? { items } : new Error(`unexpected read ${operation}`)), command);
const show = (h: ReturnType<typeof harness>, permissions: readonly string[] = ADMIN) => mount(<FlagsScreen route={ROUTE} />, h, permissions);
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const sent = (h: ReturnType<typeof harness>) => h.command.mock.calls.map(([name, input]) => ({ name, ...(input as { path?: Record<string, string>; body?: Record<string, unknown>; ifMatchVersion?: number }) }));

describe('FlagsScreen (SAS-20): the release flags', () => {
  it('UI-SAS-20: lists each flag with its status in words, whom it is on for, the revision of its rollout and an action to change it', async () => {
    const h = open([
      flag('sas.silo_promotion', { status: 'Rollout', rollout: { tenant_cohorts: ['vn-pilot', 'vn-south'], tenant_ids: [A, B], percentage: 20 }, revision: 3, version: 3 }),
      flag('sas.tenant_restore_in_place', { status: 'On', revision: 4, version: 4 }),
      flag('sas.old_flag', { status: 'Retired', revision: 9, version: 9 }),
    ]);
    show(h);
    const table = await screen.findByTestId('flags');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['sas.flags.page.title']);
    for (const key of ['sas.flags.col.flag', 'sas.flags.col.status', 'sas.flags.col.rollout', 'sas.flags.col.revision'] as const) expect(within(table).getByRole('columnheader', { name: vi_[key] })).toBeTruthy();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('sas.silo_promotion');
    expect(rows[0]?.textContent).toContain('Description of sas.silo_promotion');
    expect(rows[0]?.textContent).toContain(vi_['sas.flags.status.rollout']);
    expect(within(rows[0] as HTMLElement).getByTestId('rollout').textContent).toBe(
      [vi_['sas.flags.rollout.cohorts'].replace('{cohorts}', 'vn-pilot, vn-south'), vi_['sas.flags.rollout.tenants'].replace('{count}', '2'), vi_['sas.flags.rollout.percentage'].replace('{percentage}', '20')].join(' · '),
    );
    expect(rows[0]?.textContent).toContain(vi_['sas.flags.revision.value'].replace('{revision}', '3'));
    expect(rows[1]?.textContent).toContain(vi_['sas.flags.status.on']);
    expect(within(rows[1] as HTMLElement).getByTestId('rollout').textContent).toBe('—');
    expect(rows[2]?.textContent).toContain(vi_['sas.flags.status.retired']);
    // A retired flag is final: no action on it.
    expect(within(rows[2] as HTMLElement).queryByRole('button')).toBeNull();
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: vi_['sas.flags.edit.action'] })).toBeTruthy();
  });

  it('says that only the System Admin changes flags, and asks the server for nothing, to a caller without the right', async () => {
    const h = open([flag('sas.silo_promotion')]);
    show(h, OPERATOR);
    expect((await screen.findByTestId('denied')).textContent).toBe(vi_['sas.flags.denied.notice']);
    expect(h.read).not.toHaveBeenCalled();
  });

  it('rolls a flag out to a cohort, a tenant and a share under the version it saw, with the reason', async () => {
    const h = open([flag('sas.silo_promotion', { version: 5, revision: 5 })]);
    show(h);
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.flags.edit.action'] }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('edit-summary').textContent).toBe(vi_['sas.flags.edit.summary'].replace('{revision}', '5').replace('{status}', vi_['sas.flags.status.off']));
    expect(within(dialog).queryByLabelText(vi_['sas.flags.field.cohorts.label'])).toBeNull();
    fireEvent.click(within(dialog).getByLabelText(vi_['sas.flags.status.rollout']));
    type(vi_['sas.flags.field.cohorts.label'], ' vn-pilot , vn-pilot,vn-south ');
    type(vi_['sas.flags.field.tenants.label'], `${A.toUpperCase()}\n${B}`);
    type(vi_['sas.flags.field.percentage.label'], '25');
    type(vi_['sas.flags.field.reason.label'], '  Staged rollout to the pilot cohort ');
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['sas.flags.edit.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)[0]).toMatchObject({
      name: 'updateFeatureFlag',
      path: { flagKey: 'sas.silo_promotion' },
      ifMatchVersion: 5,
      body: { status: 'Rollout', rollout: { tenant_cohorts: ['vn-pilot', 'vn-south'], tenant_ids: [A, B], percentage: 25 }, reason: 'Staged rollout to the pilot cohort' },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('refuses before it sends a rollout that names no one, a cohort or a tenant that is not one, a share out of range and a reason that is missing', async () => {
    const h = open([flag('sas.silo_promotion')]);
    show(h);
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.flags.edit.action'] }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText(vi_['sas.flags.status.rollout']));
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['sas.flags.edit.submit.action'] }));
    expect((await within(dialog).findAllByText(vi_['sas.flags.field.required.error'])).length).toBe(2);
    type(vi_['sas.flags.field.cohorts.label'], 'Not A Cohort');
    type(vi_['sas.flags.field.tenants.label'], 'x');
    type(vi_['sas.flags.field.percentage.label'], '101');
    type(vi_['sas.flags.field.reason.label'], 'Staged rollout to the pilot cohort');
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['sas.flags.edit.submit.action'] }));
    expect((await within(dialog).findAllByText(vi_['sas.flags.field.invalid.error'])).length).toBe(3);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('turns a flag on or off with a reason alone, and says in words why the server refused', async () => {
    const h = open([flag('sas.silo_promotion', { status: 'Rollout', rollout: { tenant_cohorts: ['vn-pilot'], tenant_ids: [], percentage: 0 } })], () => new ApiError({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'c' }));
    show(h);
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.flags.edit.action'] }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText(vi_['sas.flags.status.rollout']) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText(vi_['sas.flags.field.cohorts.label']) as HTMLInputElement).value).toBe('vn-pilot');
    fireEvent.click(within(dialog).getByLabelText(vi_['sas.flags.status.on']));
    expect(within(dialog).queryByLabelText(vi_['sas.flags.field.cohorts.label'])).toBeNull();
    type(vi_['sas.flags.field.reason.label'], 'The pilot went well, on for all');
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['sas.flags.edit.submit.action'] }));
    expect((await within(dialog).findByTestId('edit-refusal')).textContent).toBe(vi_['sas.flags.problem.versionConflict']);
    expect(sent(h)[0]?.body).toEqual({ status: 'On', reason: 'The pilot went well, on for all' });
    fireEvent.click(within(dialog).getByRole('button', { name: vi_['sas.flags.dialog.close.label'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(await screen.findByRole('button', { name: vi_['sas.flags.edit.action'] }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: vi_['sas.flags.dialog.cancel.action'] }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says that there are no flags, and says in words that the flags could not be read', async () => {
    show(open([]));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    const failing = harness(() => new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }));
    show(failing);
    fireEvent.click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(failing.read.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});

describe('the model of the release flags', () => {
  it('reads the flags and leaves out what is not one', () => {
    const read = toFlags({ items: [flag('a.flag', { status: 'Rollout', rollout: { tenant_cohorts: ['x1', 5], tenant_ids: [A], percentage: 'x' } }), { flag_key: 'b' }, null, flag('c.flag', { status: 'Sometimes' }), flag('d.flag', { rollout: 'x', description: 5 })] });
    expect(read.map((item) => item.key)).toEqual(['a.flag', 'd.flag']);
    expect(read[0]).toMatchObject({ cohorts: ['x1'], tenantIds: [A], percentage: 0, revision: 1, version: 1 });
    expect(read[1]).toMatchObject({ cohorts: [], tenantIds: [], percentage: 0, description: '' });
    expect(toFlags(undefined)).toEqual([]);
    expect([holds(ADMIN, 'system.release.manage', undefined), holds(OPERATOR, 'system.release.manage', undefined), holds(undefined, 'x', 'FULL'), holds(ADMIN, 'system.release.manage', 'READ_ONLY')]).toEqual([true, false, true, false]);
    expect([isChangeable({ status: 'Off' }), isChangeable({ status: 'Rollout' }), isChangeable({ status: 'On' }), isChangeable({ status: 'Retired' })]).toEqual([true, true, true, false]);
  });

  const FORM: FlagForm = { status: 'Rollout', cohorts: 'vn-pilot', tenantIds: '', percentage: '', reason: 'Staged rollout to the pilot cohort' };

  it('takes the form of a flag, checks it and builds the body the server takes', () => {
    const view = toFlags({ items: [flag('a.flag', { status: 'Rollout', rollout: { tenant_cohorts: ['vn-pilot', 'vn-south'], tenant_ids: [A, B], percentage: 30 } }), flag('b.flag')] });
    expect(formOfFlag(view[0] as never)).toEqual({ status: 'Rollout', cohorts: 'vn-pilot, vn-south', tenantIds: `${A}\n${B}`, percentage: '30', reason: '' });
    expect(formOfFlag(view[1] as never)).toMatchObject({ status: 'Off', cohorts: '', tenantIds: '', percentage: '' });
    expect(cohortsOf({ cohorts: 'a, b,,a ' })).toEqual(['a', 'b']);
    expect(tenantIdsOf({ tenantIds: ` ${A.toUpperCase()},\n${B} ${A}` })).toEqual([A, B]);
    expect(validateFlag(FORM)).toEqual({});
    expect(validateFlag({ ...FORM, cohorts: '', tenantIds: A })).toEqual({});
    expect(validateFlag({ ...FORM, cohorts: '', percentage: '5' })).toEqual({});
    expect(validateFlag({ ...FORM, cohorts: '', percentage: '0' })).toEqual({ cohorts: 'required' });
    expect(validateFlag({ ...FORM, cohorts: '', percentage: '' })).toEqual({ cohorts: 'required' });
    expect(validateFlag({ ...FORM, cohorts: 'Bad', tenantIds: 'x', percentage: '5.5' })).toEqual({ cohorts: 'invalid', tenantIds: 'invalid', percentage: 'invalid' });
    expect(validateFlag({ ...FORM, cohorts: Array.from({ length: 21 }, (_, n) => `c${n}x`).join(',') })).toEqual({ cohorts: 'invalid' });
    expect(validateFlag({ ...FORM, percentage: '101' })).toEqual({ percentage: 'invalid' });
    expect(validateFlag({ ...FORM, reason: ' ' })).toEqual({ reason: 'required' });
    expect(validateFlag({ ...FORM, reason: 'short' })).toEqual({ reason: 'invalid' });
    // A flag that is not in rollout carries no rollout, so the fields of it are not judged.
    expect(validateFlag({ ...FORM, status: 'On', cohorts: 'Bad', percentage: '999' })).toEqual({});
    expect(flagBody(FORM)).toEqual({ status: 'Rollout', rollout: { tenant_cohorts: ['vn-pilot'], tenant_ids: [] }, reason: 'Staged rollout to the pilot cohort' });
    expect(flagBody({ ...FORM, percentage: ' 10 ', tenantIds: A })).toEqual({ status: 'Rollout', rollout: { tenant_cohorts: ['vn-pilot'], tenant_ids: [A], percentage: 10 }, reason: 'Staged rollout to the pilot cohort' });
    expect(flagBody({ ...FORM, status: 'Off', reason: ' Switched off ' })).toEqual({ status: 'Off', reason: 'Switched off' });
    const refusal = (status: number, code: string) => describeFlag(new ApiError({ status, code, correlationId: 'c' }));
    expect([refusal(422, 'FLAG_RULE_INVALID'), refusal(409, 'VERSION_CONFLICT'), refusal(404, 'RESOURCE_NOT_FOUND'), refusal(403, 'SCOPE_DENIED'), refusal(422, 'VALIDATION_FAILED'), refusal(400, 'INVALID_REQUEST'), refusal(500, 'X'), describeFlag(new Error('x'))]).toEqual([
      'rule', 'versionConflict', 'notFound', 'scopeDenied', 'validation', 'validation', 'general', 'general',
    ]);
  });
});
