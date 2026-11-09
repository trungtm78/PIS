import { ApiError } from '@machvon/api-client';
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as tr } from '../../i18n';
import { harness, mount, routeOf } from '../mne/test-support';
import type { Harness } from '../mne/test-support';
import { vietnamToday } from '../mne/model';
import RagScreen from './RagScreen';
import { overrideWindow } from './gov-model';

const ROUTE = routeOf('HOME-11', 'FR-HOME-11');
const S40 = '00000000-0000-4000-8000-0000000000f2';
const NORTH = '00000000-0000-4000-8000-000000000012';
const SOUTH = '00000000-0000-4000-8000-000000000013';
const WEST = '00000000-0000-4000-8000-000000000014';
const EAST = '00000000-0000-4000-8000-000000000015';
const READER = ['home.read'];
const OVERRIDER = ['home.read', 'home.rag.override', 'home.rag.score'];
const TODAY = vietnamToday();
const WINDOW = overrideWindow(TODAY);

const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

const factor = (code: string, overrides: Record<string, unknown> = {}) => ({ code, value: 0.55, band: 'RED', points: 40, weight: 40, direction: 'HIGHER_IS_BETTER', green: 0.9, amber: 0.6, ...overrides });
const unit = (id: string, name: string, band: string, overrides: Record<string, unknown> = {}) => ({
  unit_id: id,
  code: name.slice(0, 3).toUpperCase(),
  name,
  band,
  rule_band: band,
  overridden: false,
  override: null,
  score: band === 'NO_DATA' ? null : 72.5,
  coverage_pct: band === 'NO_DATA' ? 40 : 100,
  no_data_reason: band === 'NO_DATA' ? 'LOW_COVERAGE' : null,
  factors: [],
  reasons: band === 'NO_DATA' || band === 'GREEN' ? [] : [factor('EWS_RATE_VS_PACE'), factor('EWS_CRITICAL_WARNINGS', { value: 3, direction: 'LOWER_IS_BETTER', green: 0, amber: 1, points: 25 })],
  projects: 4,
  previous: band === 'NO_DATA' ? null : { week_start: '2027-10-04', score: 60, band: 'AMBER' },
  trend: band === 'NO_DATA' ? [] : [{ week_start: '2027-09-27', score: 50, band: 'AMBER' }, { week_start: '2027-10-04', score: 60, band: 'AMBER' }, { week_start: '2027-10-11', score: 72.5, band }],
  ...overrides,
});
const reading = (units: unknown[], overrides: Record<string, unknown> = {}) => ({
  snapshot_id: S40,
  as_of_date: TODAY,
  week_start: TODAY,
  model: { unverified: true, versions: {}, min_coverage_pct: 60, score_green: 30, score_amber: 60, factors: [] },
  summary: { RED: 1, AMBER: 1, GREEN: 1, NO_DATA: 1 },
  units,
  ...overrides,
});
const UNITS = [unit(SOUTH, 'Ban Nam', 'GREEN', { score: 10 }), unit(WEST, 'Ban Tây', 'NO_DATA'), unit(EAST, 'Ban Đông', 'AMBER', { score: 45 }), unit(NORTH, 'Ban Bắc', 'RED')];

interface Answers {
  rag?: (query: Record<string, string>) => unknown;
  command?: (operation: string, input: { body?: Record<string, unknown>; attempt?: { key: string } }) => unknown;
}
function client(answers: Answers = {}): Harness {
  return harness(
    (operation, input) => (operation === 'getRagReading' ? (answers.rag ?? (() => reading(UNITS)))(((input as { query?: Record<string, string> }).query ?? {}) as Record<string, string>) : new Error(`unexpected read ${operation}`)),
    (operation, input) => (answers.command ?? (() => ({ operation_id: 'op', status: 'OVERRIDDEN', resource_version: 1, resource_id: 'r' })))(operation, input as never),
  );
}
const commands = (h: Harness, operation: string): Array<{ body?: Record<string, unknown>; attempt?: { key: string } }> => h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as never);

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });
afterEach(cleanup);

const cardOf = (id: string): HTMLElement => screen.getByTestId(`rag-unit-${id}`);

describe('HOME-11 colours with their reasons (G3-2)', () => {
  it('lists the units red first, each with its colour as text and a mark', async () => {
    mount(<RagScreen route={ROUTE} />, client(), { permissions: READER });
    const list = await screen.findByTestId('rag-units');
    const order = Array.from(list.querySelectorAll('article')).map((card) => card.getAttribute('data-band'));
    expect(order).toEqual(['RED', 'AMBER', 'NO_DATA', 'GREEN']);
    expect(within(cardOf(NORTH)).getByTestId('band-RED').textContent).toContain(tr('govc.home.band.red'));
    expect(within(cardOf(EAST)).getByTestId('band-AMBER').textContent).toContain(tr('govc.home.band.amber'));
    expect(within(cardOf(SOUTH)).getByTestId('band-GREEN').textContent).toContain(tr('govc.home.band.green'));
    // The colour is a shape and a word, never the tint alone.
    expect(within(cardOf(NORTH)).getByTestId('band-RED').textContent).toMatch(/▲/);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(tr('govc.home.rag.page.title'));
  });

  it('says why: the factor by name, its value against its line and its points, the week before and the trend as a table too', async () => {
    mount(<RagScreen route={ROUTE} />, client(), { permissions: READER });
    await screen.findByTestId('rag-units');
    const card = cardOf(NORTH);
    expect(within(card).getByTestId(`rag-score-${NORTH}`).textContent).toContain(fill(tr('govc.home.rag.score.value'), { score: '72,5' }));
    expect(within(card).getByTestId(`rag-score-${NORTH}`).textContent).toContain(fill(tr('govc.home.rag.delta.worse'), { delta: '12,5' }));
    expect(within(card).getByTestId(`rag-coverage-${NORTH}`).textContent).toBe('100%');
    const reasons = within(card).getByTestId(`rag-reasons-${NORTH}`);
    const items = within(reasons).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain(tr('govc.home.rag.factor.ratePace'));
    expect(items[0]?.textContent).toContain(fill(tr('govc.home.rag.line.higher'), { value: '0,55', green: '0,9', amber: '0,6' }));
    expect(items[0]?.textContent).toContain(fill(tr('govc.home.rag.points'), { points: 40 }));
    expect(items[1]?.textContent).toContain(tr('govc.home.rag.factor.critical'));
    expect(items[1]?.textContent).toContain(fill(tr('govc.home.rag.line.lower'), { value: '3', green: '0', amber: '1' }));
    expect(within(card).getByTestId(`rag-previous-${NORTH}`).textContent).toContain(tr('govc.home.band.amber'));
    expect(within(card).getByTestId(`rag-previous-${NORTH}`).textContent).toContain('04/10/2027');
    const trend = within(card).getByTestId('rag-trend');
    expect(within(trend).getByRole('img', { name: fill(tr('govc.home.rag.trend.aria'), { name: 'BAN Ban Bắc', count: 3, from: '50', to: '72,5' }) })).toBeTruthy();
    const rows = within(trend).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('27/09/2027');
    expect(rows[2]?.textContent).toContain('72,5');
  });

  it('says "chưa đủ dữ liệu" for a unit with too little data, with no score and nothing green or 0', async () => {
    mount(<RagScreen route={ROUTE} />, client(), { permissions: READER });
    await screen.findByTestId('rag-units');
    const card = cardOf(WEST);
    expect(within(card).getByTestId('band-NO_DATA').textContent).toContain(tr('govc.home.band.noData'));
    expect(within(card).getByTestId(`rag-score-${WEST}`).textContent).toBe(tr('govc.home.rag.score.none'));
    expect(within(card).getByTestId(`rag-nodata-${WEST}`).textContent).toBe(fill(tr('govc.home.rag.noData.coverage'), { coverage: 40, min: 60 }));
    expect(within(card).queryByText(tr('govc.home.band.green'))).toBeNull();
    expect(within(card).queryByTestId(`rag-reasons-${WEST}`)).toBeNull();
    expect(within(card).getByTestId(`rag-previous-${WEST}`).textContent).toBe(tr('govc.home.rag.previous.none'));
    expect(card.textContent).not.toMatch(/(^|[^\d,])0([^\d,]|$)/);
  });

  it('shows the colour of the rules beside the overridden colour, with the reason, the last day and who', async () => {
    const overridden = unit(SOUTH, 'Ban Nam', 'GREEN', { score: 70, rule_band: 'RED', overridden: true, override: { band: 'GREEN', rule_band: 'RED', reason: 'Đã có cam kết giải ngân tháng 11', until: '2027-11-30', by: 'Lan Anh', at: '2027-10-12T01:00:00Z' } });
    mount(<RagScreen route={ROUTE} />, client({ rag: () => reading([overridden]) }), { permissions: READER });
    const block = await screen.findByTestId(`rag-override-${SOUTH}`);
    expect(within(block).getByTestId('band-RED').textContent).toContain(tr('govc.home.band.red'));
    expect(within(block).getByTestId('band-GREEN').textContent).toContain(tr('govc.home.band.green'));
    expect(block.textContent).toContain('Đã có cam kết giải ngân tháng 11');
    expect(block.textContent).toContain('30/11/2027');
    expect(block.textContent).toContain('Lan Anh');
    expect(within(cardOf(SOUTH)).getByText(tr('govc.home.rag.overridden'))).toBeTruthy();
    // No right to override: no button of withdrawing.
    expect(within(block).queryByRole('button')).toBeNull();
  });

  it('explains the model, and says that its thresholds are starting values', async () => {
    mount(<RagScreen route={ROUTE} />, client(), { permissions: READER });
    await screen.findByTestId('rag-units');
    expect(screen.getByTestId('rag-model').textContent).toContain(fill(tr('govc.home.rag.model.lines'), { green: 30, amber: 60 }));
    expect(screen.getByText(tr('govc.home.rag.model.unverified'))).toBeTruthy();
  });
});

describe('HOME-11 the whole states matrix', () => {
  it('shows a skeleton while it is read, with no number in it', () => {
    mount(<RagScreen route={ROUTE} />, harness(() => new Promise(() => undefined)), { permissions: READER });
    const loading = screen.getByRole('status', { name: tr('states.loading.label') });
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.textContent).not.toMatch(/\d/);
  });

  it('says an error and retries; says a refusal as a refusal; says nothing frozen yet with the way to the snapshots', async () => {
    const user = userEvent.setup();
    let answer: () => unknown = () => failure(500, 'INTERNAL_ERROR');
    mount(<RagScreen route={ROUTE} />, client({ rag: () => answer() }), { permissions: READER });
    const retry = await screen.findByRole('button', { name: tr('states.retry.action') });
    answer = () => reading(UNITS);
    await user.click(retry);
    expect(await screen.findByTestId('rag-units')).toBeTruthy();
    cleanup();
    mount(<RagScreen route={ROUTE} />, client({ rag: () => failure(403, 'SCOPE_DENIED') }), { permissions: READER });
    expect((await screen.findByRole('alert')).textContent).toContain(tr('states.denied.title'));
    cleanup();
    mount(<RagScreen route={ROUTE} />, client({ rag: () => failure(404, 'RESOURCE_NOT_FOUND') }), { permissions: READER });
    const empty = await screen.findByTestId('home-empty');
    expect(within(empty).getByRole('link', { name: tr('home.empty.link') }).getAttribute('href')).toBe('/dis/dis-21');
  });

  it('says there is nothing to show when the scope has no unit, and says the figures are old when the snapshot is', async () => {
    mount(<RagScreen route={ROUTE} />, client({ rag: () => reading([], { summary: { RED: 0, AMBER: 0, GREEN: 0, NO_DATA: 0 } }) }), { permissions: READER });
    expect(await screen.findByText(tr('states.empty.title'))).toBeTruthy();
    cleanup();
    mount(<RagScreen route={ROUTE} />, client({ rag: () => reading(UNITS, { as_of_date: '2020-01-01', week_start: '2019-12-30' }) }), { permissions: READER });
    expect(await screen.findByTestId('rag-old')).toBeTruthy();
  });

  it('keeps the colours and says they are old when a reading after a good one fails', async () => {
    const user = userEvent.setup();
    let answer: () => unknown = () => reading(UNITS);
    mount(<RagScreen route={ROUTE} />, client({ rag: () => answer() }), { permissions: OVERRIDER });
    await screen.findByTestId('rag-units');
    answer = () => failure(500, 'INTERNAL_ERROR');
    // The scoring refreshes the colours: its failure leaves what is on the screen.
    await user.click(screen.getByRole('button', { name: tr('govc.home.rag.score.action') }));
    expect(await screen.findByTestId('rag-stale')).toBeTruthy();
    expect(screen.getByTestId('rag-units')).toBeTruthy();
  });

  it('narrows to the unit of the address', async () => {
    const h = client();
    mount(<RagScreen route={ROUTE} />, h, { permissions: READER }, `/?unit=${NORTH}`);
    await screen.findByTestId('rag-units');
    expect((h.read.mock.calls[0]?.[1] as { query: Record<string, string> }).query).toEqual({ unit_id: NORTH });
  });
});

describe('HOME-11 override and withdraw (G3-2)', () => {
  const openForm = async (user: ReturnType<typeof userEvent.setup>, id: string, name: string): Promise<HTMLElement> => {
    await user.click(within(cardOf(id)).getByRole('button', { name: fill(tr('govc.home.rag.override.open'), { name }) }));
    return screen.getByTestId(`rag-form-${id}`);
  };

  it('offers nothing to a person who may not, nor to a frozen workspace', async () => {
    mount(<RagScreen route={ROUTE} />, client(), { permissions: READER });
    await screen.findByTestId('rag-units');
    expect(screen.queryByRole('button', { name: tr('govc.home.rag.override.action') })).toBeNull();
    expect(screen.queryByRole('button', { name: tr('govc.home.rag.score.action') })).toBeNull();
    cleanup();
    mount(<RagScreen route={ROUTE} />, client(), { permissions: OVERRIDER, mode: 'READ_ONLY' });
    await screen.findByTestId('rag-units');
    expect(screen.queryByRole('button', { name: /Ghi đè/ })).toBeNull();
  });

  it('asks the colour and the last day first, and refuses the colour of the rules and a day outside the window', async () => {
    const user = userEvent.setup();
    mount(<RagScreen route={ROUTE} />, client(), { permissions: OVERRIDER });
    await screen.findByTestId('rag-units');
    const form = await openForm(user, NORTH, 'BAN Ban Bắc');
    // The colour of the rules is not among the choices.
    const options = within(form).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual([tr('govc.home.rag.form.bandChoose'), tr('govc.home.band.amber'), tr('govc.home.band.green')]);
    await user.click(within(form).getByRole('button', { name: tr('govc.home.rag.form.next') }));
    expect(within(form).getAllByRole('alert')).toHaveLength(2);
    await user.selectOptions(within(form).getByRole('combobox'), 'GREEN');
    fireEvent.change(within(form).getByLabelText(tr('govc.home.rag.form.until')), { target: { value: '2999-01-01' } });
    await user.click(within(form).getByRole('button', { name: tr('govc.home.rag.form.next') }));
    expect(within(form).getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('puts a colour over the rules through the dialog with a reason of ten characters at least, under one idempotency key', async () => {
    const user = userEvent.setup();
    let fails = true;
    const h = client({ command: () => (fails ? failure(500, 'INTERNAL_ERROR') : { operation_id: 'op', status: 'OVERRIDDEN', resource_version: 1, resource_id: 'r' }) });
    mount(<RagScreen route={ROUTE} />, h, { permissions: OVERRIDER });
    await screen.findByTestId('rag-units');
    const form = await openForm(user, NORTH, 'BAN Ban Bắc');
    await user.selectOptions(within(form).getByRole('combobox'), 'GREEN');
    fireEvent.change(within(form).getByLabelText(tr('govc.home.rag.form.until')), { target: { value: WINDOW.min } });
    await user.click(within(form).getByRole('button', { name: tr('govc.home.rag.form.next') }));
    const dialog = await screen.findByRole('dialog', { name: tr('govc.home.rag.dialog.overrideTitle') });
    // The dialog names the unit, the colour of the rules, the colour to show and the day.
    expect(dialog.textContent).toContain('BAN Ban Bắc');
    expect(dialog.textContent).toContain(tr('govc.home.band.red'));
    expect(dialog.textContent).toContain(tr('govc.home.band.green'));
    const reason = within(dialog).getByLabelText(new RegExp(fill(tr('govc.home.rag.dialog.reason'), { min: 10, max: 500 }).replace(/[()]/g, '\\$&')));
    // The reason is required: the button waits for one.
    expect((within(dialog).getByRole('button', { name: tr('govc.home.rag.dialog.overrideConfirm') }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(reason, 'ngắn');
    await user.click(within(dialog).getByRole('button', { name: tr('govc.home.rag.dialog.overrideConfirm') }));
    expect(dialog.textContent).toContain(fill(tr('govc.home.rag.dialog.reasonError'), { min: 10, max: 500 }));
    expect(commands(h, 'setRagOverride')).toHaveLength(0);
    await user.clear(reason);
    await user.type(reason, 'Đã có cam kết giải ngân tháng 11');
    await user.click(within(dialog).getByRole('button', { name: tr('govc.home.rag.dialog.overrideConfirm') }));
    // A failure that is not a refusal keeps the dialog open and says so; the retry is the same intention (the same key).
    await waitFor(() => expect(dialog.textContent).toContain(tr('govc.home.rag.dialog.failed')));
    fails = false;
    await user.click(within(dialog).getByRole('button', { name: tr('govc.home.rag.dialog.overrideConfirm') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const sent = commands(h, 'setRagOverride');
    expect(sent).toHaveLength(2);
    expect(sent[0]?.body).toEqual({ unit_id: NORTH, band: 'GREEN', reason: 'Đã có cam kết giải ngân tháng 11', until: WINDOW.min });
    expect(sent[1]?.attempt?.key).toBe(sent[0]?.attempt?.key);
    // The colours are asked again so the server stays the truth.
    await waitFor(() => expect(h.read.mock.calls.filter((call) => call[0] === 'getRagReading').length).toBeGreaterThan(1));
  });

  it('says a refusal of the right (403) as a refusal, closes the dialog, and does not offer a retry', async () => {
    const user = userEvent.setup();
    const h = client({ command: () => failure(403, 'SCOPE_DENIED') });
    mount(<RagScreen route={ROUTE} />, h, { permissions: OVERRIDER });
    await screen.findByTestId('rag-units');
    const form = await openForm(user, NORTH, 'BAN Ban Bắc');
    await user.selectOptions(within(form).getByRole('combobox'), 'AMBER');
    fireEvent.change(within(form).getByLabelText(tr('govc.home.rag.form.until')), { target: { value: WINDOW.max } });
    await user.click(within(form).getByRole('button', { name: tr('govc.home.rag.form.next') }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Đã có cam kết giải ngân tháng 11');
    await user.click(within(dialog).getByRole('button', { name: tr('govc.home.rag.dialog.overrideConfirm') }));
    expect((await screen.findByTestId('rag-refused')).textContent).toContain(tr('govc.home.rag.denied.action'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('withdraws an override with a reason, and says when none is left in force', async () => {
    const user = userEvent.setup();
    const overridden = unit(SOUTH, 'Ban Nam', 'GREEN', { rule_band: 'RED', overridden: true, override: { band: 'GREEN', rule_band: 'RED', reason: 'Đã có cam kết giải ngân tháng 11', until: '2027-11-30', by: 'Lan Anh', at: null } });
    let answer: () => unknown = () => failure(404, 'RESOURCE_NOT_FOUND');
    const h = client({ rag: () => reading([overridden]), command: () => answer() });
    mount(<RagScreen route={ROUTE} />, h, { permissions: OVERRIDER });
    const block = await screen.findByTestId(`rag-override-${SOUTH}`);
    await user.click(within(block).getByRole('button', { name: tr('govc.home.rag.override.withdraw') }));
    const dialog = await screen.findByRole('dialog', { name: tr('govc.home.rag.dialog.withdrawTitle') });
    await user.type(within(dialog).getByRole('textbox'), 'Cam kết không còn hiệu lực');
    await user.click(within(dialog).getByRole('button', { name: tr('govc.home.rag.dialog.withdrawConfirm') }));
    await waitFor(() => expect(dialog.textContent).toContain(tr('govc.home.rag.dialog.gone')));
    answer = () => ({ operation_id: 'op', status: 'REVOKED', resource_version: 1, resource_id: 'r' });
    await user.click(within(dialog).getByRole('button', { name: tr('govc.home.rag.dialog.withdrawConfirm') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commands(h, 'revokeRagOverride')[0]?.body).toEqual({ unit_id: SOUTH, reason: 'Cam kết không còn hiệu lực' });
  });

  it('scores the week on request and says whether it was already scored', async () => {
    const user = userEvent.setup();
    const h = client({ command: () => ({ operation_id: 'op', status: 'ALREADY_SCORED', resource_version: 1, resource_id: 'r' }) });
    mount(<RagScreen route={ROUTE} />, h, { permissions: OVERRIDER });
    await screen.findByTestId('rag-units');
    await user.click(screen.getByRole('button', { name: tr('govc.home.rag.score.action') }));
    await waitFor(() => expect(screen.getByTestId('rag-score-status').textContent).toBe(tr('govc.home.rag.score.already')));
    expect(commands(h, 'scoreEarlyWarningWeek')).toHaveLength(1);
  });
});
