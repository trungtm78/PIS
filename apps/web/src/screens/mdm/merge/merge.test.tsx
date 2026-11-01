import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { OTHER, mount, record, routeOf, world, client } from '../test-support';
import type { Harness } from '../test-support';
import MergeHistoryScreen from './MergeHistoryScreen';
import MergeScreen from './MergeScreen';
import SurvivorshipScreen from './SurvivorshipScreen';
import * as labels from './labels';
import { EMPTY_MERGE, EMPTY_RULE, addSource, describeMergeProblem, mergeBody, moveSource, ruleBody, toMerge, toRule, unmergeBody, usesSources, validateMerge, validateRule } from './model';

const RULES_ROUTE = routeOf('MDM-36', 'FR-MDM-36');
const MERGE_ROUTE = routeOf('MDM-30', 'FR-MDM-30');
const HISTORY_ROUTE = routeOf('MDM-35', 'FR-MDM-35');
const RULE_MANAGER = ['master.read', 'master.survivorship.manage'];
const RULE_APPROVER = ['master.read', 'master.survivorship.approve'];
const CHECKER = ['master.read', 'master.merge'];
const READER = ['master.read'];
const failure = (status: number, code: string, detail?: string, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', detail, extensions });
const fill = (value: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, item]) => out.replace(`{${key}}`, String(item)), value);

const rule = (n: number, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000f1${String(n).padStart(2, '0')}`,
  master_type: 'CONTRACTOR',
  attribute_name: `attribute_${n}`,
  strategy: 'SOURCE_PRIORITY',
  source_priority: ['NATIONAL', 'TREASURY', 'TENANT'],
  revision: 1,
  status: 'PUBLISHED',
  effective_from: '2026-01-01',
  approved_by: OTHER,
  created_by: OTHER,
  created_at: '2026-10-01T00:00:00Z',
  version: 2,
  ...over,
});
const merge = (n: number, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-00000000f2${String(n).padStart(2, '0')}`,
  survivor_record_id: record(1).id,
  survivor_key: 'CONTRACTOR-A2',
  merged_record_id: record(2).id,
  merged_key: 'CONTRACTOR-A',
  master_type: 'CONTRACTOR',
  decisions: [
    { attribute: 'phone', chosen: 'MERGED', by: 'RULE', strategy: 'SOURCE_PRIORITY', source: 'NATIONAL' },
    { attribute: 'tax_code', chosen: 'SURVIVOR', by: 'EQUAL', strategy: null, source: 'TENANT' },
    { attribute: 'address', chosen: 'MERGED', by: 'ONLY_ONE', strategy: null, source: 'NATIONAL' },
    { attribute: 'email', chosen: 'SURVIVOR', by: 'OVERRIDE', strategy: null, source: 'TENANT' },
  ],
  aliases: { merged_key: 'CONTRACTOR-A', merged_label: 'Contractor A' },
  repointed: [
    { table: 'master_crosswalk', id: 'x' },
    { table: 'contractor', id: 'y' },
  ],
  reason: 'The two entries are the same contractor.',
  status: 'APPLIED',
  applied_at: '2026-11-01T10:00:00Z',
  reverted_by: null,
  reverted_at: null,
  revert_reason: null,
  version: 1,
  ...over,
});
const entry = (n: number, over: Record<string, unknown> = {}) =>
  record(n, { master_type: 'CONTRACTOR', business_key: `CONTRACTOR-${n}`, label: `Contractor ${n}`, attributes: {}, version: 4, ...over });

interface Extra {
  rules?: unknown[] | Error;
  merges?: unknown[] | Error;
  policies?: Error;
  records?: Error;
}

function open(
  over: Partial<ReturnType<typeof world>> = {},
  extra: Extra = {},
  command: (operation: string, input: unknown) => unknown = () => ({ operation_id: 'o', status: 'OK', resource_version: 2, resource_id: 'x' }),
): Harness & { readAll: ReturnType<typeof vi.fn> } {
  const h = client(
    world({
      records: [
        entry(1, { attributes: { phone: 'tenant-phone', tax_code: '0101' } }),
        entry(2, { attributes: { phone: 'national-phone', tax_code: '0101', address: 'Cao Bang' } }),
        entry(3, { status: 'RETIRED' }),
        entry(4, { namespace: 'PLATFORM' }),
      ],
      policies: [
        { master_type: 'CONTRACTOR', scope: 'TENANT_ONLY', retire_requires_successor: false, locked: false, source: 'BASELINE', platform_records: 0, tenant_records: 4 },
        { master_type: 'FUND_SOURCE', scope: 'PLATFORM_ONLY', retire_requires_successor: true, locked: true, source: 'BASELINE', platform_records: 3, tenant_records: 0 },
      ],
      ...over,
    }),
    command,
  );
  const base = (h.client as unknown as { readAll: (operation: string, input?: unknown) => Promise<unknown[]> }).readAll;
  const pick = (value: unknown[] | Error): Promise<unknown[]> => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
  const readAll = vi.fn((operation: string, input?: unknown) => {
    if (operation === 'listSurvivorshipRules') return pick(extra.rules ?? [rule(1), rule(2, { status: 'DRAFT', version: 1, revision: 2, strategy: 'MOST_RECENT', source_priority: [] })]);
    if (operation === 'listMasterMerges') return pick(extra.merges ?? [merge(1)]);
    if (operation === 'searchMasterRecords' && extra.records !== undefined) return pick(extra.records);
    return base(operation, input);
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  const baseRead = (h.client as unknown as { read: (operation: string, input?: unknown) => Promise<unknown> }).read.bind(h.client);
  (h.client as unknown as { read: unknown }).read = (operation: string, input?: unknown) =>
    operation === 'listMasterTypePolicies' && extra.policies !== undefined ? Promise.reject(extra.policies) : baseRead(operation, input);
  return Object.assign(h, { readAll });
}

afterEach(cleanup);

describe('the model of the merge (ST-MDM-010)', () => {
  it('reads a rule and a merge, and leaves out what is not one', () => {
    expect(toRule(rule(1))).toMatchObject({
      masterType: 'CONTRACTOR',
      attribute: 'attribute_1',
      strategy: 'SOURCE_PRIORITY',
      sources: ['NATIONAL', 'TREASURY', 'TENANT'],
      revision: 1,
      status: 'PUBLISHED',
      version: 2,
    });
    for (const bad of [null, {}, rule(1, { strategy: 'LUCK' }), rule(1, { status: 'LOST' }), rule(1, { revision: '1' }), rule(1, { effective_from: 1 })]) expect(toRule(bad)).toBeUndefined();
    expect(toRule(rule(1, { source_priority: 'x' }))?.sources).toEqual([]);
    expect(toMerge(merge(1))).toMatchObject({ survivorKey: 'CONTRACTOR-A2', mergedKey: 'CONTRACTOR-A', mergedLabel: 'Contractor A', repointed: 2, status: 'APPLIED', masterType: 'CONTRACTOR' });
    expect(toMerge(merge(1))?.decisions).toHaveLength(4);
    expect(toMerge(merge(1, { decisions: [3, { attribute: 'x', chosen: 'BOTH', by: 'RULE' }] }))?.decisions).toEqual([]);
    expect(toMerge(merge(1, { aliases: 'x', repointed: 'x', decisions: 'x' }))).toMatchObject({ mergedLabel: null, repointed: 0, decisions: [] });
    for (const bad of [null, {}, merge(1, { status: 'LOST' }), merge(1, { version: '1' }), merge(1, { reason: 3 })]) expect(toMerge(bad)).toBeUndefined();
  });

  it('checks a rule, and keeps the order of the sources as the keys moved it', () => {
    expect(validateRule({ ...EMPTY_RULE, masterType: 'CONTRACTOR', attribute: 'phone', sources: ['NATIONAL'], effectiveFrom: '2026-11-01' })).toEqual({});
    expect(validateRule(EMPTY_RULE)).toEqual({ masterType: 'required', attribute: 'required', sources: 'required', effectiveFrom: 'required' });
    expect(validateRule({ ...EMPTY_RULE, masterType: 'x'.repeat(51), attribute: 'y'.repeat(101), strategy: 'MOST_RECENT', effectiveFrom: '2026-02-30' })).toEqual({
      masterType: 'invalid',
      attribute: 'invalid',
      effectiveFrom: 'invalid',
    });
    expect(validateRule({ ...EMPTY_RULE, masterType: 'T', attribute: 'a', strategy: 'MOST_COMPLETE', sources: Array.from({ length: 51 }, (_, n) => `S${n}`), effectiveFrom: '2026-11-01' })).toEqual({
      sources: 'invalid',
    });
    expect(usesSources('SOURCE_PRIORITY')).toBe(true);
    expect(usesSources('MOST_COMPLETE')).toBe(true);
    expect(usesSources('MOST_RECENT')).toBe(false);
    expect(usesSources('STEWARD_DECISION')).toBe(false);
    expect(ruleBody({ masterType: ' T ', attribute: ' phone ', strategy: 'SOURCE_PRIORITY', sources: ['A', 'B'], effectiveFrom: '2026-11-01' })).toEqual({
      master_type: 'T',
      attribute_name: 'phone',
      strategy: 'SOURCE_PRIORITY',
      source_priority: ['A', 'B'],
      effective_from: '2026-11-01',
    });
    expect(ruleBody({ masterType: 'T', attribute: 'a', strategy: 'MOST_RECENT', sources: ['A'], effectiveFrom: '2026-11-01' })).not.toHaveProperty('source_priority');
    expect(ruleBody({ masterType: 'T', attribute: 'a', strategy: 'MOST_COMPLETE', sources: [], effectiveFrom: '2026-11-01' })).not.toHaveProperty('source_priority');
    expect(moveSource(['A', 'B', 'C'], 2, -1)).toEqual(['A', 'C', 'B']);
    expect(moveSource(['A', 'B', 'C'], 0, 1)).toEqual(['B', 'A', 'C']);
    expect(moveSource(['A', 'B'], 0, -1)).toEqual(['A', 'B']);
    expect(moveSource(['A', 'B'], 1, 1)).toEqual(['A', 'B']);
    expect(moveSource(['A', 'B'], 5, -1)).toEqual(['A', 'B']);
    expect(addSource(['A'], ' B ')).toEqual(['A', 'B']);
    expect(addSource(['A'], 'A')).toEqual(['A']);
    expect(addSource(['A'], '  ')).toEqual(['A']);
  });

  it('checks a merge and builds what is sent', () => {
    expect(validateMerge(EMPTY_MERGE)).toEqual({ survivorId: 'required', mergedId: 'required', reason: 'required' });
    expect(validateMerge({ survivorId: 'a', mergedId: 'a', reason: 'short' })).toEqual({ mergedId: 'invalid', reason: 'invalid' });
    expect(validateMerge({ survivorId: 'a', mergedId: 'b', reason: 'The same contractor.' })).toEqual({});
    expect(mergeBody({ survivorId: 'a', mergedId: 'b', reason: ' The same contractor. ' }, {})).toEqual({ merged_record_id: 'b', reason: 'The same contractor.' });
    expect(mergeBody({ survivorId: 'a', mergedId: 'b', reason: 'The same contractor.' }, { phone: 'MERGED' })).toEqual({
      merged_record_id: 'b',
      reason: 'The same contractor.',
      survivorship_overrides: { phone: 'MERGED' },
    });
    expect(unmergeBody(' A mistake of the merge ', {})).toEqual({ reason: 'A mistake of the merge' });
    expect(unmergeBody('A mistake of the merge', { phone: 'KEEP' })).toEqual({ reason: 'A mistake of the merge', steward_decisions: { phone: 'KEEP' } });
  });

  it('says what a refusal means and which attributes it names', () => {
    const cases: Array<[string, string]> = [
      ['MERGE_CONFLICT', 'conflict'],
      ['UNMERGE_CONFLICT', 'unmergeConflict'],
      ['MERGE_ALREADY_REVERTED', 'alreadyReverted'],
      ['POLICY_LOCKED', 'locked'],
      ['SELF_APPROVAL_DENIED', 'self'],
      ['SCOPE_DENIED', 'scope'],
      ['VERSION_CONFLICT', 'stale'],
      ['STAGE_TRANSITION_DENIED', 'state'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['VALIDATION_FAILED', 'validation'],
      ['OTHER', 'general'],
    ];
    for (const [code, reason] of cases)
      expect(describeMergeProblem(failure(409, code, 'field', { attributes: ['phone', 3, 'email'] }))).toEqual({ reason, detail: 'field', attributes: ['phone', 'email'] });
    expect(describeMergeProblem(failure(409, 'MERGE_CONFLICT'))).toEqual({ reason: 'conflict', detail: '', attributes: [] });
    expect(describeMergeProblem(new Error('x'))).toEqual({ reason: 'general', detail: '', attributes: [] });
  });

  it('has a word for everything it names', () => {
    const t = (key: string, values?: Record<string, string | number>): string => (values === undefined ? key : `${key}:${Object.values(values).join(',')}`);
    for (const strategy of ['SOURCE_PRIORITY', 'MOST_RECENT', 'MOST_COMPLETE', 'STEWARD_DECISION'] as const) expect(labels.strategyLabel(t, strategy)).toMatch(/^mdm\.merge\.strategy\./);
    for (const status of ['DRAFT', 'PUBLISHED', 'RETIRED'] as const) expect(labels.ruleStatusLabel(t, status)).toMatch(/^mdm\.merge\.rule\.status\./);
    expect(labels.mergeStatusLabel(t, 'APPLIED')).toBe('mdm.merge.status.applied');
    expect(labels.mergeStatusLabel(t, 'REVERTED')).toBe('mdm.merge.status.reverted');
    expect(labels.sideLabel(t, 'SURVIVOR')).toBe('mdm.merge.side.survivor');
    expect(labels.sideLabel(t, 'MERGED')).toBe('mdm.merge.side.merged');
    for (const by of ['ONLY_ONE', 'EQUAL', 'RULE', 'OVERRIDE'] as const) expect(labels.byLabel(t, by)).toMatch(/^mdm\.merge\.by\./);
    for (const reason of ['conflict', 'unmergeConflict', 'alreadyReverted', 'locked', 'self', 'scope', 'stale', 'state', 'notFound', 'validation', 'general'] as const)
      expect(labels.problemMessage(t, { reason, detail: 'f', attributes: ['a'] })).toMatch(/^mdm\.merge\.problem\./);
  });
});

const states: Array<[string, Error, string]> = [
  ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
  ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c', extensions: {} }), vi_['states.offline.title']],
  ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
  ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
];

describe('MDM-36, the rules of survivorship (ST-MDM-010, MDM-36)', () => {
  it('lists the rules with their strategy, their order of sources, their revision and where they stand', async () => {
    mount(<SurvivorshipScreen route={RULES_ROUTE} />, open(), READER);
    const table = await screen.findByTestId('rules');
    const published = table.querySelector('[data-status="PUBLISHED"]') as HTMLElement;
    expect(published.textContent).toContain(vi_['mdm.merge.strategy.sourcePriority']);
    expect(published.textContent).toContain('1. NATIONAL › 2. TREASURY › 3. TENANT');
    expect(published.textContent).toContain(vi_['mdm.merge.rule.status.published']);
    expect((table.querySelector('[data-status="DRAFT"]') as HTMLElement).textContent).toContain(vi_['mdm.merge.strategy.mostRecent']);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('form', { name: vi_['mdm.merge.draft.title'] })).toBeNull();
  });

  it('publishes a draft against the version that was read, and shows the refusal of the server', async () => {
    const user = userEvent.setup();
    const h = open({}, {}, () => {
      throw failure(403, 'SELF_APPROVAL_DENIED');
    });
    mount(<SurvivorshipScreen route={RULES_ROUTE} />, h, RULE_APPROVER);
    expect(screen.queryByRole('button', { name: fill(vi_['mdm.merge.rule.publish'], { attribute: 'attribute_1' }) })).toBeNull();
    await user.click(await screen.findByRole('button', { name: fill(vi_['mdm.merge.rule.publish'], { attribute: 'attribute_2' }) }));
    expect((await screen.findByTestId('publish-refusal')).getAttribute('data-reason')).toBe('self');
    expect(h.command).toHaveBeenCalledWith('publishSurvivorshipRule', expect.objectContaining({ path: { id: rule(2).id }, ifMatchVersion: 1 }));
  });

  it('drafts a rule: checked first, the order of the sources set with the keys, the refusal of the server shown', async () => {
    const user = userEvent.setup();
    const h = open({}, {}, (_operation, input) => {
      if ((input as { body: { attribute_name: string } }).body.attribute_name === 'bad') throw failure(422, 'VALIDATION_FAILED', 'source_priority');
      return { operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: 'x' };
    });
    mount(<SurvivorshipScreen route={RULES_ROUTE} />, h, RULE_MANAGER);
    const form = await screen.findByRole('form', { name: vi_['mdm.merge.draft.title'] });
    await user.click(within(form).getByRole('button', { name: vi_['mdm.merge.draft.submit'] }));
    expect((await within(form).findAllByText(vi_['mdm.merge.form.required'])).length).toBeGreaterThanOrEqual(3);
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['mdm.merge.col.type']), 'CONTRACTOR');
    await user.type(within(form).getByLabelText(vi_['mdm.merge.col.attribute']), 'bad');
    await user.type(within(form).getByLabelText(vi_['mdm.merge.col.effective']), '2026-12-01');
    for (const name of ['TENANT', 'NATIONAL', 'TREASURY']) {
      await user.type(within(form).getByLabelText(vi_['mdm.merge.draft.source']), name);
      await user.click(within(form).getByRole('button', { name: vi_['mdm.merge.draft.add'] }));
    }
    // TENANT, NATIONAL, TREASURY: move TENANT down twice and TREASURY up, remove nothing yet.
    await user.click(within(form).getByRole('button', { name: fill(vi_['mdm.merge.draft.down'], { source: 'TENANT' }) }));
    await user.click(within(form).getByRole('button', { name: fill(vi_['mdm.merge.draft.down'], { source: 'TENANT' }) }));
    expect(
      within(form)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('data-source')),
    ).toEqual(['NATIONAL', 'TREASURY', 'TENANT']);
    expect((within(form).getByRole('button', { name: fill(vi_['mdm.merge.draft.up'], { source: 'NATIONAL' }) }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(form).getByRole('button', { name: fill(vi_['mdm.merge.draft.down'], { source: 'TENANT' }) }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(form).getByRole('button', { name: fill(vi_['mdm.merge.draft.up'], { source: 'TENANT' }) }));
    await user.click(within(form).getByRole('button', { name: fill(vi_['mdm.merge.draft.remove'], { source: 'TREASURY' }) }));
    expect(
      within(form)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('data-source')),
    ).toEqual(['NATIONAL', 'TENANT']);
    await user.click(within(form).getByRole('button', { name: vi_['mdm.merge.draft.submit'] }));
    expect((await within(form).findByTestId('draft-refusal')).getAttribute('data-reason')).toBe('validation');
    expect(h.command).toHaveBeenLastCalledWith(
      'createSurvivorshipRuleVersion',
      expect.objectContaining({ body: { master_type: 'CONTRACTOR', attribute_name: 'bad', strategy: 'SOURCE_PRIORITY', source_priority: ['NATIONAL', 'TENANT'], effective_from: '2026-12-01' } }),
    );
    await user.clear(within(form).getByLabelText(vi_['mdm.merge.col.attribute']));
    await user.type(within(form).getByLabelText(vi_['mdm.merge.col.attribute']), 'phone');
    await user.click(within(form).getByRole('button', { name: vi_['mdm.merge.draft.submit'] }));
    expect(await within(form).findByTestId('draft-saved')).toBeTruthy();
    // Another strategy asks for no order of sources.
    await user.selectOptions(within(form).getByLabelText(vi_['mdm.merge.col.strategy']), 'MOST_RECENT');
    expect(within(form).queryByTestId('sources')).toBeNull();
  });

  it('says there is none, and gives no form and no button to a read-only session', async () => {
    mount(<SurvivorshipScreen route={RULES_ROUTE} />, open({}, { rules: [] }), RULE_MANAGER);
    expect((await screen.findByTestId('no-rules')).textContent).toBe(vi_['mdm.merge.rules.none']);
    cleanup();
    mount(<SurvivorshipScreen route={RULES_ROUTE} />, open(), [...RULE_MANAGER, ...RULE_APPROVER]);
    expect(await screen.findByTestId('rules')).toBeTruthy();
  });

  it.each(states)('UI-MDM-36 shows the %s state', async (_name, answer, title) => {
    mount(<SurvivorshipScreen route={RULES_ROUTE} />, open({}, { rules: answer }), RULE_MANAGER);
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.queryByRole('form', { name: vi_['mdm.merge.draft.title'] })).toBeNull();
  });

  it('shows the loading state while the rules are read', async () => {
    const h = open();
    h.readAll.mockImplementation(() => new Promise(() => undefined));
    mount(<SurvivorshipScreen route={RULES_ROUTE} />, h, RULE_MANAGER);
    expect(await screen.findByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
  });
});

describe('MDM-30, the merge (ST-MDM-010, MDM-30)', () => {
  it('offers the types the tenant owns and has two entries of, and the entries that are in force and are the tenant’s', async () => {
    mount(<MergeScreen route={MERGE_ROUTE} />, open(), CHECKER);
    const survivor = await screen.findByLabelText(vi_['mdm.merge.merge.survivor']);
    expect(
      within(screen.getByLabelText(vi_['mdm.merge.col.type']))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['CONTRACTOR']);
    await waitFor(() => expect(within(survivor).getAllByRole('option').length).toBe(3));
    expect(
      within(survivor)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['', 'CONTRACTOR-1 · Contractor 1', 'CONTRACTOR-2 · Contractor 2']);
  });

  it('merges two entries against the version of the survivor that was read, and says how many references were pointed again', async () => {
    const user = userEvent.setup();
    const h = open({}, {}, () => ({ operation_id: 'o', status: 'MERGED', resource_version: 5, resource_id: record(1).id, repointed: 4 }));
    mount(<MergeScreen route={MERGE_ROUTE} />, h, CHECKER);
    const form = await screen.findByRole('form', { name: vi_['mdm.merge.merge.form'] });
    await user.click(within(form).getByRole('button', { name: vi_['mdm.merge.merge.submit'] }));
    expect((await within(form).findAllByText(vi_['mdm.merge.form.required'])).length).toBe(3);
    expect(h.command).not.toHaveBeenCalled();
    await waitFor(() => expect(within(form).getAllByRole('option').length).toBeGreaterThan(2));
    await user.selectOptions(within(form).getByLabelText(vi_['mdm.merge.merge.survivor']), record(1).id);
    await user.selectOptions(within(form).getByLabelText(vi_['mdm.merge.merge.merged']), record(1).id);
    await user.type(within(form).getByLabelText(vi_['mdm.merge.merge.reason']), 'short');
    await user.click(within(form).getByRole('button', { name: vi_['mdm.merge.merge.submit'] }));
    expect(await within(form).findByText(vi_['mdm.merge.merge.merged.same'])).toBeTruthy();
    expect(await within(form).findByText(vi_['mdm.merge.merge.reason.invalid'])).toBeTruthy();
    await user.selectOptions(within(form).getByLabelText(vi_['mdm.merge.merge.merged']), record(2).id);
    await user.clear(within(form).getByLabelText(vi_['mdm.merge.merge.reason']));
    await user.type(within(form).getByLabelText(vi_['mdm.merge.merge.reason']), 'The two entries are the same contractor.');
    await user.click(within(form).getByRole('button', { name: vi_['mdm.merge.merge.submit'] }));
    expect((await within(form).findByTestId('merge-done')).textContent).toBe(fill(vi_['mdm.merge.merge.done'], { count: 4 }));
    expect(h.command).toHaveBeenCalledWith(
      'post_master_records_id_merge',
      expect.objectContaining({ path: { id: record(1).id }, ifMatchVersion: 4, body: { merged_record_id: record(2).id, reason: 'The two entries are the same contractor.' } }),
    );
  });

  it('shows the attributes no rule settled with the value of each entry, and sends the merge again with the choices (409 MERGE_CONFLICT)', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const h = open({}, {}, (_operation, input) => {
      calls += 1;
      if ((input as { body: { survivorship_overrides?: unknown } }).body.survivorship_overrides === undefined)
        throw failure(409, 'MERGE_CONFLICT', 'survivorship_overrides', { attributes: ['phone', 'label'] });
      return { operation_id: 'o', status: 'MERGED', resource_version: 5, resource_id: record(1).id, repointed: 0 };
    });
    mount(<MergeScreen route={MERGE_ROUTE} />, h, CHECKER);
    const form = await screen.findByRole('form', { name: vi_['mdm.merge.merge.form'] });
    await waitFor(() => expect(within(form).getAllByRole('option').length).toBeGreaterThan(2));
    await user.selectOptions(within(form).getByLabelText(vi_['mdm.merge.merge.survivor']), record(1).id);
    await user.selectOptions(within(form).getByLabelText(vi_['mdm.merge.merge.merged']), record(2).id);
    await user.type(within(form).getByLabelText(vi_['mdm.merge.merge.reason']), 'The two entries are the same contractor.');
    await user.click(within(form).getByRole('button', { name: vi_['mdm.merge.merge.submit'] }));
    const conflicts = await within(form).findByTestId('conflicts');
    expect(within(form).getByTestId('merge-refusal').getAttribute('data-reason')).toBe('conflict');
    expect(within(conflicts).getByRole('radiogroup', { name: 'phone' }).textContent).toContain('tenant-phone');
    expect(within(conflicts).getByRole('radiogroup', { name: 'phone' }).textContent).toContain('national-phone');
    expect(within(conflicts).getByRole('radiogroup', { name: 'label' }).textContent).toContain('Contractor 1');
    // Not sent again until each attribute has a side.
    expect((within(form).getByRole('button', { name: vi_['mdm.merge.merge.submit'] }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(within(conflicts).getByRole('radiogroup', { name: 'phone' })).getByRole('radio', { name: fill(vi_['mdm.merge.merge.take.merged'], { value: 'national-phone' }) }));
    await user.click(within(within(conflicts).getByRole('radiogroup', { name: 'label' })).getByRole('radio', { name: fill(vi_['mdm.merge.merge.take.survivor'], { value: 'Contractor 1' }) }));
    await user.click(within(form).getByRole('button', { name: vi_['mdm.merge.merge.submit'] }));
    expect(await within(form).findByTestId('merge-done')).toBeTruthy();
    expect(calls).toBe(2);
    expect(h.command).toHaveBeenLastCalledWith(
      'post_master_records_id_merge',
      expect.objectContaining({ body: { merged_record_id: record(2).id, reason: 'The two entries are the same contractor.', survivorship_overrides: { phone: 'MERGED', label: 'SURVIVOR' } } }),
    );
  });

  it('shows the value of an attribute called label, which the server keys with an escape, and not the name of the entry', async () => {
    const user = userEvent.setup();
    const h = open(
      { records: [entry(1, { label: 'Name 1', attributes: { label: 'nested-1', '~x': 'escaped-1' } }), entry(2, { label: 'Name 2', attributes: { label: 'nested-2', '~x': 'escaped-2' } })] },
      {},
      () => {
        throw failure(409, 'MERGE_CONFLICT', 'survivorship_overrides', { attributes: ['~label', '~~x'] });
      },
    );
    mount(<MergeScreen route={MERGE_ROUTE} />, h, CHECKER);
    const form = await screen.findByRole('form', { name: vi_['mdm.merge.merge.form'] });
    await waitFor(() => expect(within(form).getAllByRole('option').length).toBeGreaterThan(2));
    await user.selectOptions(within(form).getByLabelText(vi_['mdm.merge.merge.survivor']), record(1).id);
    await user.selectOptions(within(form).getByLabelText(vi_['mdm.merge.merge.merged']), record(2).id);
    await user.type(within(form).getByLabelText(vi_['mdm.merge.merge.reason']), 'The two entries are the same contractor.');
    await user.click(within(form).getByRole('button', { name: vi_['mdm.merge.merge.submit'] }));
    const conflicts = await within(form).findByTestId('conflicts');
    expect(within(conflicts).getByRole('radiogroup', { name: '~label' }).textContent).toContain('nested-1');
    expect(within(conflicts).getByRole('radiogroup', { name: '~label' }).textContent).toContain('nested-2');
    expect(within(conflicts).getByRole('radiogroup', { name: '~label' }).textContent).not.toContain('Name 1');
    expect(within(conflicts).getByRole('radiogroup', { name: '~~x' }).textContent).toContain('escaped-1');
  });

  it('drops the conflicts of a pair when another entry is chosen, so they are not asked of the new pair', async () => {
    const user = userEvent.setup();
    const h = open({}, {}, () => {
      throw failure(409, 'MERGE_CONFLICT', 'survivorship_overrides', { attributes: ['phone'] });
    });
    mount(<MergeScreen route={MERGE_ROUTE} />, h, CHECKER);
    const form = await screen.findByRole('form', { name: vi_['mdm.merge.merge.form'] });
    await waitFor(() => expect(within(form).getAllByRole('option').length).toBeGreaterThan(2));
    await user.selectOptions(within(form).getByLabelText(vi_['mdm.merge.merge.survivor']), record(1).id);
    await user.selectOptions(within(form).getByLabelText(vi_['mdm.merge.merge.merged']), record(2).id);
    await user.type(within(form).getByLabelText(vi_['mdm.merge.merge.reason']), 'The two entries are the same contractor.');
    await user.click(within(form).getByRole('button', { name: vi_['mdm.merge.merge.submit'] }));
    expect(await within(form).findByTestId('conflicts')).toBeTruthy();
    await user.selectOptions(within(form).getByLabelText(vi_['mdm.merge.merge.merged']), record(1).id);
    await waitFor(() => expect(within(form).queryByTestId('conflicts')).toBeNull());
    expect(within(form).queryByTestId('merge-refusal')).toBeNull();
  });

  it('shows a refusal that is not a conflict, and gives no button to who may not merge', async () => {
    const user = userEvent.setup();
    const h = open({}, {}, () => {
      throw failure(403, 'POLICY_LOCKED');
    });
    mount(<MergeScreen route={MERGE_ROUTE} />, h, CHECKER);
    const form = await screen.findByRole('form', { name: vi_['mdm.merge.merge.form'] });
    await waitFor(() => expect(within(form).getAllByRole('option').length).toBeGreaterThan(2));
    await user.selectOptions(within(form).getByLabelText(vi_['mdm.merge.merge.survivor']), record(1).id);
    await user.selectOptions(within(form).getByLabelText(vi_['mdm.merge.merge.merged']), record(2).id);
    await user.type(within(form).getByLabelText(vi_['mdm.merge.merge.reason']), 'The two entries are the same contractor.');
    await user.click(within(form).getByRole('button', { name: vi_['mdm.merge.merge.submit'] }));
    expect((await within(form).findByTestId('merge-refusal')).getAttribute('data-reason')).toBe('locked');
    expect(within(form).queryByTestId('conflicts')).toBeNull();
    cleanup();
    mount(<MergeScreen route={MERGE_ROUTE} />, open(), READER);
    await screen.findByRole('form', { name: vi_['mdm.merge.merge.form'] });
    expect(screen.queryByRole('button', { name: vi_['mdm.merge.merge.submit'] })).toBeNull();
  });

  it('says there is nothing to merge when no type has two entries of the tenant, and chooses another type', async () => {
    mount(<MergeScreen route={MERGE_ROUTE} />, open({ policies: [] }), CHECKER);
    expect((await screen.findByTestId('no-types')).textContent).toBe(vi_['mdm.merge.merge.noTypes']);
    cleanup();
    const user = userEvent.setup();
    const h = open({
      policies: [
        { master_type: 'CONTRACTOR', scope: 'TENANT_ONLY', retire_requires_successor: false, locked: false, source: 'BASELINE', platform_records: 0, tenant_records: 4 },
        { master_type: 'OFFICE', scope: 'TENANT_ONLY', retire_requires_successor: false, locked: false, source: 'BASELINE', platform_records: 0, tenant_records: 2 },
        { master_type: 'LONELY', scope: 'TENANT_ONLY', retire_requires_successor: false, locked: false, source: 'BASELINE', platform_records: 0, tenant_records: 1 },
      ],
    });
    mount(<MergeScreen route={MERGE_ROUTE} />, h, CHECKER);
    const type = await screen.findByLabelText(vi_['mdm.merge.col.type']);
    expect(
      within(type)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['CONTRACTOR', 'OFFICE']);
    await user.selectOptions(type, 'OFFICE');
    await waitFor(() => expect(h.readAll).toHaveBeenCalledWith('searchMasterRecords', expect.objectContaining({ query: expect.objectContaining({ master_type: 'OFFICE' }) })));
  });

  it.each(states)('UI-MDM-30 shows the %s state when the types cannot be read', async (_name, answer, title) => {
    mount(<MergeScreen route={MERGE_ROUTE} />, open({}, { policies: answer }), CHECKER);
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.queryByRole('form', { name: vi_['mdm.merge.merge.form'] })).toBeNull();
  });

  it('holds the form back when the entries cannot be read, and reads them again on retry', async () => {
    const user = userEvent.setup();
    const h = open({}, { records: failure(500, 'INTERNAL_ERROR') });
    mount(<MergeScreen route={MERGE_ROUTE} />, h, CHECKER);
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    expect(screen.queryByRole('form', { name: vi_['mdm.merge.merge.form'] })).toBeNull();
    const before = h.readAll.mock.calls.length;
    await user.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(h.readAll.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('MDM-35, the merges and their undoing (ST-MDM-010, MDM-35, UAT-AC274, UAT-AC275)', () => {
  it('shows each merge: the alias, the references pointed again, how each attribute was settled and by what, and where it stands', async () => {
    const reverted = merge(2, { status: 'REVERTED', revert_reason: 'It was a mistake.', reverted_at: '2026-11-02T10:00:00Z', survivor_key: 'CONTRACTOR-B2', merged_key: 'CONTRACTOR-B' });
    mount(<MergeHistoryScreen route={HISTORY_ROUTE} />, open({}, { merges: [merge(1), reverted] }), READER);
    await screen.findAllByTestId('decisions');
    const [first, second] = Array.from(document.querySelectorAll<HTMLElement>('[data-merge]')) as [HTMLElement, HTMLElement];
    expect(first.getAttribute('data-status')).toBe('APPLIED');
    expect(within(first).getByTestId('alias').textContent).toContain('CONTRACTOR-A');
    expect(within(first).getByTestId('alias').textContent).toContain('Contractor A');
    expect(within(first).getByTestId('repointed').textContent).toBe('2');
    const decisions = within(first).getByTestId('decisions');
    expect((decisions.querySelector('[data-attribute="phone"]') as HTMLElement).textContent).toContain(`${vi_['mdm.merge.by.rule']} · ${vi_['mdm.merge.strategy.sourcePriority']}`);
    expect((decisions.querySelector('[data-attribute="phone"]') as HTMLElement).textContent).toContain('NATIONAL');
    expect((decisions.querySelector('[data-attribute="phone"]') as HTMLElement).getAttribute('data-chosen')).toBe('MERGED');
    expect((decisions.querySelector('[data-attribute="tax_code"]') as HTMLElement).textContent).toContain(vi_['mdm.merge.by.equal']);
    expect((decisions.querySelector('[data-attribute="address"]') as HTMLElement).textContent).toContain(vi_['mdm.merge.by.onlyOne']);
    expect((decisions.querySelector('[data-attribute="email"]') as HTMLElement).textContent).toContain(vi_['mdm.merge.by.override']);
    expect(within(second).getByTestId('revert-reason').textContent).toBe('It was a mistake.');
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('undoes a merge with a reason, against the version that was read', async () => {
    const user = userEvent.setup();
    const h = open({}, {}, () => ({ operation_id: 'o', status: 'REVERTED', resource_version: 2, resource_id: merge(1).id }));
    mount(<MergeHistoryScreen route={HISTORY_ROUTE} />, h, CHECKER);
    const form = await screen.findByRole('form', { name: fill(vi_['mdm.merge.history.unmerge'], { survivor: 'CONTRACTOR-A2' }) });
    await user.click(within(form).getByRole('button', { name: vi_['mdm.merge.history.unmerge.submit'] }));
    expect(await within(form).findByText(vi_['mdm.merge.history.reason.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['mdm.merge.history.unmerge.reason']), '  The merge was a mistake.  ');
    await user.click(within(form).getByRole('button', { name: vi_['mdm.merge.history.unmerge.submit'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith('unmergeMasterRecords', expect.objectContaining({ path: { id: merge(1).id }, ifMatchVersion: 1, body: { reason: 'The merge was a mistake.' } })),
    );
  });

  it('asks, for each attribute the survivor edited after the merge, to keep the edit or give the value back, and sends the answers (409 UNMERGE_CONFLICT)', async () => {
    const user = userEvent.setup();
    const h = open({}, {}, (_operation, input) => {
      if ((input as { body: { steward_decisions?: unknown } }).body.steward_decisions === undefined) throw failure(409, 'UNMERGE_CONFLICT', 'steward_decisions', { attributes: ['phone', 'address'] });
      return { operation_id: 'o', status: 'REVERTED', resource_version: 2, resource_id: merge(1).id };
    });
    mount(<MergeHistoryScreen route={HISTORY_ROUTE} />, h, CHECKER);
    const form = await screen.findByRole('form', { name: fill(vi_['mdm.merge.history.unmerge'], { survivor: 'CONTRACTOR-A2' }) });
    await user.type(within(form).getByLabelText(vi_['mdm.merge.history.unmerge.reason']), 'The merge was a mistake.');
    await user.click(within(form).getByRole('button', { name: vi_['mdm.merge.history.unmerge.submit'] }));
    const conflicts = await within(form).findByTestId('unmerge-conflicts');
    expect(within(form).getByTestId('unmerge-refusal').getAttribute('data-reason')).toBe('unmergeConflict');
    expect((within(form).getByRole('button', { name: vi_['mdm.merge.history.unmerge.submit'] }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(within(conflicts).getByRole('radiogroup', { name: 'phone' })).getByRole('radio', { name: vi_['mdm.merge.history.keep'] }));
    await user.click(within(within(conflicts).getByRole('radiogroup', { name: 'address' })).getByRole('radio', { name: vi_['mdm.merge.history.revert'] }));
    await user.click(within(form).getByRole('button', { name: vi_['mdm.merge.history.unmerge.submit'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenLastCalledWith(
        'unmergeMasterRecords',
        expect.objectContaining({ body: { reason: 'The merge was a mistake.', steward_decisions: { phone: 'KEEP', address: 'REVERT' } } }),
      ),
    );
  });

  it('shows a refusal that is not a conflict, and gives no button to who may not unmerge', async () => {
    const user = userEvent.setup();
    const h = open({}, {}, () => {
      throw failure(409, 'MERGE_ALREADY_REVERTED');
    });
    mount(<MergeHistoryScreen route={HISTORY_ROUTE} />, h, CHECKER);
    const form = await screen.findByRole('form', { name: fill(vi_['mdm.merge.history.unmerge'], { survivor: 'CONTRACTOR-A2' }) });
    await user.type(within(form).getByLabelText(vi_['mdm.merge.history.unmerge.reason']), 'The merge was a mistake.');
    await user.click(within(form).getByRole('button', { name: vi_['mdm.merge.history.unmerge.submit'] }));
    expect((await within(form).findByTestId('unmerge-refusal')).getAttribute('data-reason')).toBe('alreadyReverted');
    expect(within(form).queryByTestId('unmerge-conflicts')).toBeNull();
    cleanup();
    mount(<MergeHistoryScreen route={HISTORY_ROUTE} />, open(), READER);
    await screen.findByTestId('decisions');
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('says there is none', async () => {
    mount(<MergeHistoryScreen route={HISTORY_ROUTE} />, open({}, { merges: [] }), CHECKER);
    expect((await screen.findByTestId('no-merges')).textContent).toBe(vi_['mdm.merge.history.none']);
  });

  it.each(states)('UI-MDM-35 shows the %s state', async (_name, answer, title) => {
    mount(<MergeHistoryScreen route={HISTORY_ROUTE} />, open({}, { merges: answer }), CHECKER);
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('shows the loading state while the merges are read', async () => {
    const h = open();
    h.readAll.mockImplementation(() => new Promise(() => undefined));
    mount(<MergeHistoryScreen route={HISTORY_ROUTE} />, h, CHECKER);
    expect(await screen.findByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
  });
});
