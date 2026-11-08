import { ApiError } from '@machvon/api-client';
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as tr, translator } from '../../i18n';
import { harness, mount, routeOf, TENANT } from '../mne/test-support';
import type { Harness } from '../mne/test-support';
import MultiRankingScreen, { quadrantLabel, rankReason } from './MultiRankingScreen';
import RankingNotesScreen from './RankingNotesScreen';
import { toAnnotations, toComplaints, toRanking } from './ranking-model';

const READER = ['home.read'];
const ALL = ['home.read', 'home.ranking.annotate', 'home.ranking.annotation.decide', 'home.ranking.complain', 'home.ranking.complaint.resolve'];
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const ME = TENANT.membershipId;
const OTHER = '00000000-0000-4000-8000-0000000000aa';
const U1 = '00000000-0000-4000-8000-000000000011';
const U2 = '00000000-0000-4000-8000-000000000012';
const U3 = '00000000-0000-4000-8000-000000000013';

const metric = (code: string, over: Record<string, unknown> = {}) => ({ code, direction: code === 'EXPLANATIONS' || code === 'WARNINGS' ? 'LOWER_IS_BETTER' : 'HIGHER_IS_BETTER', weight: 20, value: 60, score: 40, null_reason: null, excluded: null, under_complaint: false, ...over });
const unit = (id: string, code: string, rank: number | null, over: Record<string, unknown> = {}) => ({
  unit_id: id,
  code,
  name: `Unit ${code}`,
  band: 'LARGE',
  rank,
  of_band: 3,
  band_thin: false,
  composite: rank === null ? null : 100 - rank * 10,
  null_reason: rank === null ? 'TOO_FEW_METRICS' : null,
  standing: 5,
  metrics: ['RATE', 'PHYSICAL', 'COMPLETENESS', 'EXPLANATIONS', 'WARNINGS'].map((code) => metric(code)),
  annotation: null,
  pair: { quadrant: 'SLOW_BOTH', rate_pct: 60, physical_pct: 45, null_reason: null },
  ...over,
});
const reading = (over: Record<string, unknown> = {}) => ({
  snapshot_id: 's1',
  as_of_date: '2027-10-12',
  certification_gate: null,
  null_reason: null,
  model: { rule_version: 'builtin', unverified: true, metrics: ['RATE', 'PHYSICAL', 'COMPLETENESS', 'EXPLANATIONS', 'WARNINGS'].map((code) => ({ code, direction: 'HIGHER_IS_BETTER', weight: 20 })), min_metrics: 3, min_units_per_band: 3, annotation_effect: 'SHOW_ONLY', annotation_reasons: ['LAND_CLEARANCE', 'FORCE_MAJEURE'], annotation_max_days: 180, pair_gap_pct: 15, pair_high_pct: 60 },
  info: { formula: 'Weighted mean of scores', source: 'Ranking rule', as_of: '2026-11-08', rule_version: 'builtin', unverified: true },
  bands: [{ code: 'SMALL', min_plan_vnd: '0', units: 0, thin: true }, { code: 'LARGE', min_plan_vnd: '1000000000000', units: 3, thin: false }],
  units: [unit(U1, 'A', 1), unit(U2, 'B', 2, { annotation: { id: 'n1', reason_code: 'LAND_CLEARANCE', valid_to: '2027-12-31' }, pair: { quadrant: null, rate_pct: 60, physical_pct: null, null_reason: 'NO_PHYSICAL_PROGRESS' } }), unit(U3, 'C', null, { metrics: [metric('RATE', { under_complaint: true }), metric('PHYSICAL', { value: null, score: null, null_reason: 'NO_PHYSICAL_PROGRESS' })] })],
  ...over,
});
const annotation = (id: string, status: string, proposer = OTHER) => ({ id, unit: { id: U2, code: 'B', name: 'Unit B' }, reason_code: 'LAND_CLEARANCE', metric_codes: ['RATE'], evidence: 'The compensation of 12 households is not paid yet.', valid_from: '2027-10-20', valid_to: '2027-12-31', status, proposed_by: { id: proposer, name: 'Proposer' }, proposed_at: '2027-10-20T00:00:00.000Z', decided_by: null, decided_at: null, decision_note: null });
const complaint = (id: string, status: string, filer = OTHER) => ({ id, unit: { id: U3, code: 'C', name: 'Unit C' }, metric_code: 'RATE', as_of_date: '2027-10-12', snapshot_id: 's1', claim: 'The Treasury paid 3 billion more on 9 October.', claimed_value: '62.5', status, filed_by: { id: filer, name: 'Filer' }, filed_at: '2027-10-20T00:00:00.000Z', due_on: '2027-10-30', overdue: false, reviewer: null, review_started_at: null, resolved_by: null, resolved_at: null, resolution: null });

interface Answers {
  multi?: () => unknown;
  annotations?: (query: Record<string, unknown>) => unknown;
  complaints?: (query: Record<string, unknown>) => unknown;
  command?: (operation: string, input: { body?: Record<string, unknown>; path?: { id: string } }) => unknown;
}
function client(answers: Answers = {}): Harness {
  return harness(
    (operation, input) => {
      const query = ((input as { query?: Record<string, unknown> }).query ?? {}) as Record<string, unknown>;
      if (operation === 'getMultiMetricRanking') return (answers.multi ?? (() => reading()))();
      if (operation === 'listRankingAnnotations') return (answers.annotations ?? (() => ({ items: [annotation('a1', 'PROPOSED'), annotation('a2', 'APPROVED')] })))(query);
      if (operation === 'listRankingComplaints') return (answers.complaints ?? (() => ({ items: [complaint('c1', 'FILED'), complaint('c2', 'UNDER_REVIEW', ME)] })))(query);
      return new Error(`unexpected read ${operation}`);
    },
    (operation, input) => (answers.command ?? (() => ({ operation_id: 'op', status: 'OK', resource_version: 1, resource_id: 'r' })))(operation, input as never),
  );
}
const commands = (h: Harness, operation: string): Array<{ body?: Record<string, unknown>; path?: { id: string } }> => h.command.mock.calls.filter((call) => call[0] === operation).map((call) => call[1] as { body?: Record<string, unknown>; path?: { id: string } });

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });
afterEach(cleanup);

describe('BI-25 the ranking on several measures (G3-8)', () => {
  const ROUTE = routeOf('BI-25', 'FR-BI-25');

  it('shows the units by band with their position, composite, measures, pair, and the unrated one without a position', async () => {
    mount(<MultiRankingScreen route={ROUTE} />, client(), { permissions: READER });
    const table = await screen.findByTestId('rank-band-LARGE');
    const rows = within(table).getAllByTestId('rank-row');
    expect(rows.map((row) => within(row).getByTestId('rank-position').textContent)).toEqual(['1', '2', tr('ana.common.na')]);
    expect(within(rows[0] as HTMLElement).getByTestId('rank-composite').textContent).toContain('90');
    expect(within(rows[0] as HTMLElement).getByTestId('rank-metric-RATE').textContent).toContain(fill(tr('ana.rank.value.percent'), { value: '60' }));
    expect(within(rows[0] as HTMLElement).getByTestId('rank-metric-EXPLANATIONS').textContent).toContain(fill(tr('ana.rank.value.perProject'), { value: '60' }));
    expect(within(rows[0] as HTMLElement).getByTestId('rank-pair').textContent).toContain(tr('ana.rank.pair.slowBoth'));
    expect(within(rows[2] as HTMLElement).getByTestId('rank-composite').textContent).toContain(tr('ana.rank.na.tooFew'));
    // A band with no unit is not drawn, and the model says its weights and that it is not confirmed.
    expect(screen.queryByTestId('rank-band-SMALL')).toBeNull();
    expect(screen.getByTestId('rank-model').textContent).toContain(tr('ana.rank.metric.rate'));
    expect(screen.getByTestId('ana-unverified')).toBeTruthy();
  });

  it('says a unit is held back outside its control, marks a disputed figure, and gives N/A with the reason for a missing measure and a missing pair', async () => {
    mount(<MultiRankingScreen route={ROUTE} />, client(), { permissions: READER });
    await screen.findByTestId('rank-band-LARGE');
    const [, second, third] = screen.getAllByTestId('rank-row');
    expect(within(second as HTMLElement).getByTestId('rank-annotation').textContent).toContain(tr('ana.rank.reason.LAND_CLEARANCE'));
    expect(within(second as HTMLElement).getByTestId('rank-annotation').textContent).toContain('31/12/2027');
    expect(within(second as HTMLElement).getByTestId('rank-pair').textContent).toContain(tr('ana.rank.na.noPhysical'));
    expect(within(third as HTMLElement).getByTestId('rank-disputed-RATE').textContent).toContain(tr('ana.rank.disputed'));
    expect(within(third as HTMLElement).getByTestId('rank-metric-PHYSICAL').textContent).toContain(tr('ana.rank.na.noPhysical'));
  });

  it('flags a band too small to compare', async () => {
    mount(<MultiRankingScreen route={ROUTE} />, client({ multi: () => reading({ bands: [{ code: 'SMALL', min_plan_vnd: '0', units: 0, thin: true }, { code: 'LARGE', min_plan_vnd: '1000000000000', units: 2, thin: true }] }) }), { permissions: READER });
    await screen.findByTestId('rank-band-LARGE');
    expect(screen.getByText(fill(tr('ana.rank.band.thin'), { count: 2 }))).toBeTruthy();
  });

  it('offers a note and a complaint only to a person who holds the right, and sends the note with the evidence and the measures', async () => {
    const h = client();
    const user = userEvent.setup();
    mount(<MultiRankingScreen route={ROUTE} />, h, { permissions: READER });
    await screen.findByTestId('rank-band-LARGE');
    expect(screen.queryByTestId(`rank-annotate-${U1}`)).toBeNull();
    expect(screen.queryByTestId(`rank-complain-${U1}-RATE`)).toBeNull();
    cleanup();
    mount(<MultiRankingScreen route={ROUTE} />, h, { permissions: ALL });
    fireEvent.click(await screen.findByTestId(`rank-annotate-${U1}`));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('annotate-reason'), { target: { value: 'FORCE_MAJEURE' } });
    fireEvent.click(within(dialog).getByTestId('annotate-metric-PHYSICAL'));
    fireEvent.change(within(dialog).getByTestId('annotate-until'), { target: { value: '2027-12-01' } });
    await user.type((dialog.querySelector('textarea') as HTMLTextAreaElement), 'A storm closed the site for three weeks.');
    await user.click(within(dialog).getByRole('button', { name: tr('ana.rank.annotate.confirm') }));
    await waitFor(() => expect(commands(h, 'proposeRankingAnnotation')).toHaveLength(1));
    expect(commands(h, 'proposeRankingAnnotation')[0]?.body).toEqual({ unit_id: U1, reason_code: 'FORCE_MAJEURE', metric_codes: ['RATE', 'PHYSICAL'], evidence: 'A storm closed the site for three weeks.', valid_to: '2027-12-01' });
    expect((await screen.findByTestId('rank-notice')).textContent).toBe(tr('ana.rank.annotate.done'));
  });

  it('sends a complaint about the figure that was clicked, with the day and the value the unit claims', async () => {
    const h = client();
    const user = userEvent.setup();
    mount(<MultiRankingScreen route={ROUTE} />, h, { permissions: ALL });
    fireEvent.click(await screen.findByTestId(`rank-complain-${U1}-RATE`));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('complain-claimed'), { target: { value: '62.5' } });
    await user.type((dialog.querySelector('textarea') as HTMLTextAreaElement), 'The Treasury paid 3 billion more on 9 October.');
    await user.click(within(dialog).getByRole('button', { name: tr('ana.rank.complain.confirm') }));
    await waitFor(() => expect(commands(h, 'fileRankingComplaint')).toHaveLength(1));
    expect(commands(h, 'fileRankingComplaint')[0]?.body).toEqual({ unit_id: U1, metric_code: 'RATE', as_of_date: '2027-10-12', claim: 'The Treasury paid 3 billion more on 9 October.', claimed_value: '62.5' });
  });

  it('says why a refusal happened inside the dialog and keeps it open', async () => {
    const h = client({ command: () => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }) });
    const user = userEvent.setup();
    mount(<MultiRankingScreen route={ROUTE} />, h, { permissions: ALL });
    fireEvent.click(await screen.findByTestId(`rank-annotate-${U1}`));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByTestId('annotate-until'), { target: { value: '2027-12-01' } });
    await user.type((dialog.querySelector('textarea') as HTMLTextAreaElement), 'A storm closed the site for three weeks.');
    await user.click(within(dialog).getByRole('button', { name: tr('ana.rank.annotate.confirm') }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(tr('ana.rank.problem.denied'));
  });

  it('does not show the table when the definition is not certified, and shows the empty, error and denied states', async () => {
    mount(<MultiRankingScreen route={ROUTE} />, client({ multi: () => reading({ certification_gate: 'NOT_CERTIFIED', null_reason: 'NOT_CERTIFIED', units: [], bands: [] }) }), { permissions: READER });
    expect(await screen.findByTestId('rank-gated')).toBeTruthy();
    cleanup();
    mount(<MultiRankingScreen route={ROUTE} />, client({ multi: () => reading({ null_reason: 'NO_SNAPSHOT', units: [], bands: [], snapshot_id: null }) }), { permissions: READER });
    expect(await screen.findByText(tr('states.empty.title'))).toBeTruthy();
    cleanup();
    mount(<MultiRankingScreen route={ROUTE} />, client({ multi: () => new Error('boom') }), { permissions: READER });
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    mount(<MultiRankingScreen route={ROUTE} />, client({ multi: () => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }) }), { permissions: READER });
    expect((await screen.findByRole('alert')).textContent).toContain(tr('states.denied.title'));
  });

  it('turns every reason and quadrant into words and reads wrong answers as nothing', () => {
    const reasons = ['NO_FIGURE', 'NO_PLAN', 'NO_PROJECTS', 'NOT_READABLE', 'NO_PHYSICAL_PROGRESS', 'TOO_FEW_METRICS', 'NO_SNAPSHOT', 'NOT_CERTIFIED'];
    expect(new Set(reasons.map((reason) => rankReason(translator.t, reason))).size).toBe(reasons.length);
    expect(new Set((['FAST_BOTH', 'MONEY_AHEAD_OF_WORK', 'WORK_AHEAD_OF_MONEY', 'SLOW_BOTH'] as const).map((quadrant) => quadrantLabel(translator.t, quadrant))).size).toBe(4);
    expect(toRanking({})).toBeUndefined();
    expect(toAnnotations({})).toBeUndefined();
    expect(toComplaints({ items: [{ id: 'x' }] })).toEqual([]);
  });
});

describe('BI-26 notes and complaints of the ranking (G3-8)', () => {
  const ROUTE = routeOf('BI-26', 'FR-BI-26');

  it('lists the notes and the complaints with their status and the people', async () => {
    mount(<RankingNotesScreen route={ROUTE} />, client(), { permissions: READER });
    const notes = await screen.findByTestId('annotation-table');
    const rows = within(notes).getAllByTestId('annotation-row');
    expect(rows[0]?.textContent).toContain(tr('ana.notes.annotation.status.proposed'));
    expect(rows[0]?.textContent).toContain(tr('ana.rank.reason.LAND_CLEARANCE'));
    expect(rows[0]?.textContent).toContain(fill(tr('ana.notes.proposedBy'), { name: 'Proposer' }));
    const complaints = within(screen.getByTestId('complaint-table')).getAllByTestId('complaint-row');
    expect(complaints[0]?.textContent).toContain(tr('ana.notes.complaint.status.filed'));
    expect(complaints[0]?.textContent).toContain(fill(tr('ana.notes.claimed'), { value: '62.5' }));
  });

  it('lets a decider approve a note of somebody else with words, and not their own', async () => {
    const h = client({ annotations: () => ({ items: [annotation('a1', 'PROPOSED'), annotation('a3', 'PROPOSED', ME)] }) });
    const user = userEvent.setup();
    mount(<RankingNotesScreen route={ROUTE} />, h, { permissions: ALL });
    await screen.findByTestId('annotation-table');
    expect(screen.queryByTestId('annotation-approve-a3')).toBeNull();
    expect(screen.getByTestId('annotation-withdraw-a3')).toBeTruthy();
    fireEvent.click(screen.getByTestId('annotation-approve-a1'));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: tr('ana.notes.dialog.confirm') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.type(within(dialog).getByRole('textbox'), 'Evidence checked on site.');
    await user.click(confirm);
    await waitFor(() => expect(commands(h, 'decideRankingAnnotation')).toHaveLength(1));
    expect(commands(h, 'decideRankingAnnotation')[0]).toMatchObject({ path: { id: 'a1' }, body: { decision: 'APPROVE', note: 'Evidence checked on site.' } });
  });

  it('answers a complaint by taking it up and then by the three answers, never the one who filed it', async () => {
    const h = client();
    const user = userEvent.setup();
    mount(<RankingNotesScreen route={ROUTE} />, h, { permissions: ALL });
    await screen.findByTestId('complaint-table');
    expect(screen.queryByTestId('complaint-uphold-c2')).toBeNull();
    fireEvent.click(screen.getByTestId('complaint-review-c1'));
    const first = await screen.findByRole('dialog');
    await user.click(within(first).getByRole('button', { name: tr('ana.notes.dialog.confirm') }));
    await waitFor(() => expect(commands(h, 'resolveRankingComplaint')).toHaveLength(1));
    expect(commands(h, 'resolveRankingComplaint')[0]).toMatchObject({ path: { id: 'c1' }, body: { action: 'START_REVIEW' } });
    fireEvent.click(await screen.findByTestId('complaint-correct-c1'));
    const second = await screen.findByRole('dialog');
    await user.type(within(second).getByRole('textbox'), 'The Treasury figure was corrected by the source.');
    await user.click(within(second).getByRole('button', { name: tr('ana.notes.dialog.confirm') }));
    await waitFor(() => expect(commands(h, 'resolveRankingComplaint')).toHaveLength(2));
    expect(commands(h, 'resolveRankingComplaint')[1]?.body).toEqual({ action: 'CORRECT', resolution: 'The Treasury figure was corrected by the source.' });
  });

  it('says why a decision was refused: the same person, the state that moved', async () => {
    const h = client({ command: () => new ApiError({ status: 403, code: 'SELF_APPROVAL_DENIED', correlationId: 'c' }) });
    const user = userEvent.setup();
    mount(<RankingNotesScreen route={ROUTE} />, h, { permissions: ALL });
    fireEvent.click(await screen.findByTestId('annotation-approve-a1'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Evidence checked on site.');
    await user.click(within(dialog).getByRole('button', { name: tr('ana.notes.dialog.confirm') }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(tr('ana.notes.problem.self'));
  });

  it('shows no action to a reader, filters by status, and shows the empty, error and denied states', async () => {
    const h = client();
    mount(<RankingNotesScreen route={ROUTE} />, h, { permissions: READER });
    await screen.findByTestId('annotation-table');
    expect(screen.queryByTestId('annotation-approve-a1')).toBeNull();
    expect(screen.queryByTestId('complaint-uphold-c1')).toBeNull();
    fireEvent.change(screen.getByTestId('annotation-filter'), { target: { value: 'APPROVED' } });
    await waitFor(() => expect(h.read.mock.calls.some((call) => (call[1] as { query: Record<string, unknown> }).query.status === 'APPROVED')).toBe(true));
    cleanup();
    mount(<RankingNotesScreen route={ROUTE} />, client({ annotations: () => ({ items: [] }), complaints: () => ({ items: [] }) }), { permissions: READER });
    expect(await screen.findByText(tr('states.empty.title'))).toBeTruthy();
    cleanup();
    mount(<RankingNotesScreen route={ROUTE} />, client({ annotations: () => new Error('boom') }), { permissions: READER });
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    mount(<RankingNotesScreen route={ROUTE} />, client({ annotations: () => new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }) }), { permissions: READER });
    expect((await screen.findByRole('alert')).textContent).toContain(tr('states.denied.title'));
  });
});
