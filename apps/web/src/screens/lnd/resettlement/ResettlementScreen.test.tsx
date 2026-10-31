import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { PROJECT, client, mount, routeOf, world } from '../test-support';
import type { Harness } from '../test-support';
import ResettlementScreen from './ResettlementScreen';
import { EMPTY_FORM, allocationBody, canAllocate, describeRefusal, toAllocation, toCandidate, validateForm } from './model';

const ROUTE = routeOf('LND-12', 'FR-LND-12');
const ALLOCATOR = ['land.resettle.write', 'land.read'];
const READER = ['land.read'];
const OK = { operation_id: 'o', status: 'ALLOCATED', resource_version: 1, resource_id: 'x' };
const word = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

const uuid = (n: number): string => `00000000-0000-4000-8000-0000000000e${n}`;
const household = (n: number) => ({ id: uuid(n), household_code: `HGD-00${n}`, head_name: `Ng*** V** A${n}` });
const allocation = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000000a${n}`,
  project_id: PROJECT,
  household: household(n),
  plan_item_id: uuid(10 + n),
  owner_unit_id: uuid(20),
  unit_kind: 'PLOT',
  unit_code: `PLOT-0${n}`,
  site_text: 'Khu tái định cư số 1',
  area_m2: '120.50',
  priority_rank: 2,
  allocated_on: '2026-10-20',
  handed_on: null,
  status: 'ALLOCATED',
  version: 1,
  ...overrides,
});
const candidate = (n: number, overrides: Record<string, unknown> = {}) => ({ plan_item_id: uuid(10 + n), plan_id: uuid(30), household: household(n), owner_unit_id: uuid(20), item_kind: 'RESETTLEMENT_LAND', unit_kinds: ['PLOT'], ...overrides });

afterEach(cleanup);

function open(
  options: { allocations?: unknown[]; candidates?: unknown[]; command?: (operation: string, input: unknown) => unknown; permissions?: readonly string[]; path?: string; failing?: boolean; failingCandidates?: boolean } = {},
): Harness {
  const h = client(
    world({ allocations: options.allocations ?? [], candidates: options.candidates ?? [], ...(options.failing === true || options.failingCandidates === true ? { failing: new Set([options.failing === true ? 'listResettlementAllocations' : 'listResettlementCandidates']) } : {}) } as never),
    options.command ?? (() => OK),
  );
  mount(<ResettlementScreen route={ROUTE} />, h, { permissions: options.permissions ?? ALLOCATOR, path: options.path ?? `/lnd/lnd-12?project=${PROJECT}` });
  return h;
}
const sent = (h: Harness) => h.command.mock.calls.map(([name, input]) => ({ name, ...(input as { body?: Record<string, unknown> }) }));
const form = (): HTMLElement => screen.getByRole('form', { name: word('lnd.resettlement.form.title') });
const fill = (label: string, value: string): void => {
  fireEvent.change(within(form()).getByLabelText(label), { target: { value } });
};
const pick = async (n: number): Promise<void> => {
  const select = (await within(form()).findByLabelText(word('lnd.resettlement.field.candidate.label'))) as HTMLSelectElement;
  await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: uuid(10 + n) } });
};
const submit = (): void => {
  fireEvent.click(within(form()).getByRole('button', { name: word('lnd.resettlement.form.submit.action') }));
};

describe('ResettlementScreen (LND-12): the resettlement of the households', () => {
  it('UI-LND-12: asks for a project first, then lists the allocations with the household masked and the unit, site, area, rank, day and status in words', async () => {
    open({ allocations: [allocation(1), allocation(2, { unit_kind: 'HOUSE', status: 'HANDED_OVER', area_m2: null, priority_rank: null, allocated_on: null })], path: '/lnd/lnd-12' });
    expect((await screen.findByTestId('choose-project')).textContent).toBe(word('lnd.resettlement.project.notice'));
    expect(screen.getByTestId('privacy-note').textContent).toBe(word('lnd.resettlement.privacy.note'));
    fireEvent.change(await screen.findByLabelText(word('lnd.resettlement.project.label')), { target: { value: PROJECT } });
    const table = await screen.findByTestId('allocations');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('HGD-001');
    expect(rows[0]?.textContent).toContain('Ng*** V** A1');
    expect(rows[0]?.textContent).toContain(word('lnd.resettlement.unit.plot'));
    expect(rows[0]?.textContent).toContain('PLOT-01');
    expect(rows[0]?.textContent).toContain('120.50');
    expect(rows[0]?.textContent).toContain('2026-10-20');
    expect(rows[0]?.textContent).toContain(word('lnd.resettlement.status.allocated'));
    expect(rows[1]?.textContent).toContain(word('lnd.resettlement.unit.house'));
    expect(rows[1]?.textContent).toContain(word('lnd.resettlement.status.handedOver'));
    expect(rows[1]?.textContent).toContain('—');
  });

  it('says in words that the project has no allocation, and shows a reader the list and no form', async () => {
    open({ permissions: READER });
    expect((await screen.findByTestId('empty')).textContent).toBe(word('lnd.resettlement.empty.notice'));
    expect(screen.queryByRole('form', { name: word('lnd.resettlement.form.title') })).toBeNull();
  });

  it('offers the candidates by household and item, only the kinds of unit the item gives, and sends the allocation with the household and the unit of the candidate', async () => {
    const h = open({ candidates: [candidate(1), candidate(2, { item_kind: 'RESETTLEMENT_HOUSE', unit_kinds: ['HOUSE', 'APARTMENT'] })] });
    await pick(2);
    const kind = within(form()).getByLabelText(word('lnd.resettlement.field.kind.label')) as HTMLSelectElement;
    expect(Array.from(kind.options).map((option) => option.value)).toEqual(['', 'APARTMENT', 'HOUSE']);
    fireEvent.change(kind, { target: { value: 'APARTMENT' } });
    fill(word('lnd.resettlement.field.code.label'), ' FLAT-12 ');
    fill(word('lnd.resettlement.field.site.label'), 'Khu A');
    fill(word('lnd.resettlement.field.area.label'), '65.5');
    fill(word('lnd.resettlement.field.rank.label'), '4');
    submit();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(sent(h)[0]).toMatchObject({
      name: 'allocateResettlement',
      body: { household_id: uuid(2), plan_item_id: uuid(12), owner_unit_id: uuid(20), unit_kind: 'APARTMENT', unit_code: 'FLAT-12', site_text: 'Khu A', area_m2: '65.5', priority_rank: 4 },
    });
    expect((await screen.findByTestId('allocate-saved')).textContent).toBe(word('lnd.resettlement.form.saved'));
  });

  it('asks for the candidate, the kind, the code and the site before it asks the server, and refuses a value that cannot be one', async () => {
    const h = open({ candidates: [candidate(1)] });
    await screen.findByRole('form', { name: word('lnd.resettlement.form.title') });
    submit();
    expect(await within(form()).findAllByText(word('lnd.resettlement.field.required.error'))).toHaveLength(4);
    expect(h.command).not.toHaveBeenCalled();
    await pick(1);
    fireEvent.change(within(form()).getByLabelText(word('lnd.resettlement.field.kind.label')), { target: { value: 'PLOT' } });
    fill(word('lnd.resettlement.field.code.label'), 'x'.repeat(61));
    fill(word('lnd.resettlement.field.site.label'), 'y'.repeat(301));
    fill(word('lnd.resettlement.field.area.label'), '0');
    fill(word('lnd.resettlement.field.rank.label'), '0');
    submit();
    expect(await within(form()).findAllByText(word('lnd.resettlement.field.invalid.error'))).toHaveLength(4);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says there is nothing to allocate when no approved item waits for a unit', async () => {
    open();
    expect(await within(await screen.findByRole('form', { name: word('lnd.resettlement.form.title') })).findByText(word('lnd.resettlement.field.candidate.none'))).toBeTruthy();
  });

  it.each([
    ['UNIT_ALREADY_ALLOCATED', 409, {}, word('lnd.resettlement.problem.unitTaken')],
    ['HOUSEHOLD_NOT_ELIGIBLE', 422, { reason: 'PLAN_NOT_APPROVED' }, word('lnd.resettlement.problem.notEligible', { reason: word('lnd.resettlement.reason.notApproved') })],
    ['HOUSEHOLD_NOT_ELIGIBLE', 422, { reason: 'ALREADY_ALLOCATED' }, word('lnd.resettlement.problem.notEligible', { reason: word('lnd.resettlement.reason.alreadyAllocated') })],
    ['HOUSEHOLD_NOT_ELIGIBLE', 422, { reason: 'UNIT_KIND_MISMATCH' }, word('lnd.resettlement.problem.notEligible', { reason: word('lnd.resettlement.reason.kindMismatch') })],
    ['HOUSEHOLD_NOT_ELIGIBLE', 422, { reason: 'NO_PLAN_ITEM' }, word('lnd.resettlement.problem.notEligible', { reason: word('lnd.resettlement.reason.noItem') })],
    ['HOUSEHOLD_NOT_ELIGIBLE', 422, { reason: 'PLAN_ITEM_NOT_FOUND' }, word('lnd.resettlement.problem.notEligible', { reason: word('lnd.resettlement.reason.itemNotFound') })],
    ['HOUSEHOLD_NOT_ELIGIBLE', 422, { reason: 'PLAN_ITEM_OF_ANOTHER_HOUSEHOLD' }, word('lnd.resettlement.problem.notEligible', { reason: word('lnd.resettlement.reason.otherHousehold') })],
    ['HOUSEHOLD_NOT_ELIGIBLE', 422, { reason: 'NOT_A_RESETTLEMENT_ITEM' }, word('lnd.resettlement.problem.notEligible', { reason: word('lnd.resettlement.reason.notResettlement') })],
    ['HOUSEHOLD_NOT_ELIGIBLE', 422, {}, word('lnd.resettlement.problem.notEligible', { reason: word('lnd.resettlement.reason.unknown') })],
    ['SCOPE_DENIED', 403, {}, word('lnd.resettlement.problem.scopeDenied')],
    ['RESOURCE_NOT_FOUND', 404, {}, word('lnd.resettlement.problem.notFound')],
    ['VALIDATION_FAILED', 422, {}, word('lnd.resettlement.problem.validation')],
    ['INTERNAL', 500, {}, word('lnd.resettlement.problem.general')],
  ] as const)('says in words why the server refused with %s %s', async (code, status, extensions, message) => {
    open({ candidates: [candidate(1)], command: () => new ApiError({ status, code, correlationId: 'c', extensions }) });
    await pick(1);
    fireEvent.change(within(form()).getByLabelText(word('lnd.resettlement.field.kind.label')), { target: { value: 'PLOT' } });
    fill(word('lnd.resettlement.field.code.label'), 'PLOT-1');
    fill(word('lnd.resettlement.field.site.label'), 'Khu A');
    submit();
    expect((await within(form()).findByTestId('allocate-refusal')).textContent).toBe(message);
  });

  it('keeps the form as it was sent while the request is on its way: nothing can be edited and nothing sent twice', async () => {
    const h = open({ candidates: [candidate(1)], command: () => new Promise(() => undefined) });
    await pick(1);
    fireEvent.change(within(form()).getByLabelText(word('lnd.resettlement.field.kind.label')), { target: { value: 'PLOT' } });
    fill(word('lnd.resettlement.field.code.label'), 'PLOT-1');
    fill(word('lnd.resettlement.field.site.label'), 'Khu A');
    submit();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((within(form()).getByLabelText(word('lnd.resettlement.field.code.label')) as HTMLInputElement).matches(':disabled')).toBe(true));
    fireEvent.click(within(form()).getByRole('button', { name: word('lnd.resettlement.form.submit.action') }));
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('tells a failure to load the candidates apart from there being none, and offers to load them again', async () => {
    const h = open({ failingCandidates: true });
    const form = await screen.findByRole('form', { name: word('lnd.resettlement.form.title') });
    expect((await within(form).findByTestId('candidates-failed')).textContent).toContain(word('lnd.resettlement.candidates.failed'));
    expect(within(form).queryByText(word('lnd.resettlement.field.candidate.none'))).toBeNull();
    const asked = () => (h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((call) => call[0] === 'listResettlementCandidates').length;
    const before = asked();
    fireEvent.click(within(form).getByRole('button', { name: word('lnd.resettlement.candidates.retry.action') }));
    await waitFor(() => expect(asked()).toBeGreaterThan(before));
  });

  it('offers a retry when the allocations could not be read', async () => {
    const h = open({ failing: true });
    fireEvent.click(await screen.findByRole('button', { name: word('states.retry.action') }));
    const asked = () => (h.client.readAll as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((call) => call[0] === 'listResettlementAllocations').length;
    await waitFor(() => expect(asked()).toBeGreaterThanOrEqual(2));
  });
});

describe('the model of LND-12', () => {
  it('reads an allocation and a candidate and leaves out what is not one', () => {
    expect(toAllocation(undefined)).toBeUndefined();
    expect(toAllocation({ id: 'x' })).toBeUndefined();
    expect(toAllocation(allocation(1, { unit_kind: 'TENT' }))).toBeUndefined();
    expect(toAllocation(allocation(1, { status: 'ODD' }))).toBeUndefined();
    expect(toAllocation(allocation(1, { household: { id: 'x' } }))).toBeUndefined();
    expect(toAllocation(allocation(1, { area_m2: undefined, priority_rank: 'x', site_text: undefined }))).toMatchObject({ areaM2: null, priorityRank: null, siteText: '' });
    expect(toCandidate(candidate(1, { item_kind: 'ODD' }))).toBeUndefined();
    expect(toCandidate({ plan_item_id: 'a' })).toBeUndefined();
    expect(toCandidate(candidate(1, { unit_kinds: ['PLOT', 'TENT', 3] }))?.unitKinds).toEqual(['PLOT']);
    expect(toCandidate(candidate(1, { unit_kinds: undefined }))?.unitKinds).toEqual([]);
  });

  it('validates the form against the candidate chosen and builds the body', () => {
    const candidates = [toCandidate(candidate(1)) as NonNullable<ReturnType<typeof toCandidate>>];
    const good = { ...EMPTY_FORM, planItemId: uuid(11), unitKind: 'PLOT', unitCode: 'P-1', siteText: 'Khu A' };
    expect(validateForm(good, candidates)).toEqual({});
    expect(validateForm({ ...good, planItemId: uuid(99) }, candidates)).toEqual({ candidate: 'invalid' });
    expect(validateForm({ ...good, unitKind: 'HOUSE' }, candidates)).toEqual({ unitKind: 'invalid' });
    expect(validateForm({ ...good, area: '12.345' }, candidates)).toEqual({ area: 'invalid' });
    expect(validateForm({ ...good, rank: '1.5' }, candidates)).toEqual({ rank: 'invalid' });
    expect(validateForm({ ...good, rank: '100000' }, candidates)).toEqual({});
    expect(validateForm({ ...good, rank: '100001' }, candidates)).toEqual({ rank: 'invalid' });
    expect(validateForm({ ...good, rank: '0' }, candidates)).toEqual({ rank: 'invalid' });
    expect(allocationBody(good, candidates)).toEqual({ household_id: uuid(1), plan_item_id: uuid(11), owner_unit_id: uuid(20), unit_kind: 'PLOT', unit_code: 'P-1', site_text: 'Khu A' });
    expect(allocationBody({ ...good, area: '9', rank: '3' }, candidates)).toMatchObject({ area_m2: '9', priority_rank: 3 });
    expect(allocationBody({ ...good, planItemId: uuid(99) }, candidates)).toMatchObject({ household_id: '', owner_unit_id: '' });
  });

  it('holds the right only outside the read-only mode, and reads anything but an error of the server as a general failure', () => {
    expect(canAllocate(['land.resettle.write'], 'FULL')).toBe(true);
    expect(canAllocate(['land.resettle.write'], 'READ_ONLY')).toBe(false);
    expect(canAllocate(['land.read'], 'FULL')).toBe(false);
    expect(canAllocate(undefined, undefined)).toBe(true);
    expect(describeRefusal(new Error('boom'))).toEqual({ problem: 'general', reason: undefined });
    expect(describeRefusal(new ApiError({ status: 418, code: 'TEAPOT', correlationId: 'c' })).problem).toBe('general');
  });
});
