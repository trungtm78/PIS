import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { harness, mount, routeOf } from '../../mne/test-support';
import type { Harness } from '../../mne/test-support';
import ConsumerInboxScreen from './ConsumerInboxScreen';
import ContractScreen from './ContractScreen';
import { EMPTY_DRAFT, allApproved, describeContractProblem, draftBody, isDay, openRevision, shortHash, toRevision, toVersion, toWaiting, validateDraft } from './model';

const ROUTE = routeOf('DGV-13', 'FR-DGV-13');
const INBOX = routeOf('DGV-19', 'FR-DGV-19');
const MANAGER = ['data.catalog.read', 'data.contract.manage'];
const OWNER = ['data.catalog.read', 'data.contract.approve', 'data.contract.publish'];
const ME = '00000000-0000-4000-8000-000000000001'; // the member of the session of the test support
const OTHER = '00000000-0000-4000-8000-0000000000aa';
const DS1 = '00000000-0000-4000-8000-0000000000d1';
const DS2 = '00000000-0000-4000-8000-0000000000d2';
const REV = '00000000-0000-4000-8000-0000000000c1';
const VER1 = '00000000-0000-4000-8000-0000000000b1';
const VER2 = '00000000-0000-4000-8000-0000000000b2';
const failure = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });
const fill = (value: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, item]) => out.replace(`{${key}}`, String(item)), value);

const dataset = (id: string, code: string) => ({
  id,
  dataset_code: code,
  title: code,
  domain: 'TREASURY',
  grain: 'g',
  producer_module: 'DIS',
  owner_user_id: ME,
  owner_name: 'Owner',
  steward_user_id: ME,
  steward_name: 'Steward',
  classification: 'INTERNAL',
  is_critical: false,
  freshness_slo_seconds: 3600,
  contract_revision: null,
  status: 'ACTIVE',
  quality_badge: 'NOT_ASSESSED',
  version: 1,
});
const column = (name: string, overrides: Record<string, unknown> = {}) => ({
  object: 'disbursement',
  name,
  logicalType: 'string',
  physicalType: null,
  required: false,
  primaryKey: false,
  classification: null,
  unit: null,
  ...overrides,
});
const approval = (id: string, ref: string, overrides: Record<string, unknown> = {}) => ({
  id,
  consumer_kind: 'MODULE',
  consumer_ref: ref,
  consumer_owner: { membership_id: OTHER, display_name: 'Consumer owner' },
  decision: 'PENDING',
  decided_by: null,
  decided_at: null,
  comment: null,
  version: 1,
  ...overrides,
});
const revision = (overrides: Record<string, unknown> = {}) => ({
  id: REV,
  dataset_id: DS1,
  dataset_code: 'DS-ONE',
  revision: 2,
  status: 'IN_REVIEW',
  odcs_version: 'v3.0.2',
  compatibility: 'BREAKING',
  effective_from: '2030-11-01',
  freshness_seconds: 3600,
  classification: 'INTERNAL',
  owner_id: ME,
  created_by: OTHER,
  approved_by: null,
  created_at: '2026-11-01T01:00:00.000Z',
  columns: [column('org_unit_code', { required: true, primaryKey: true }), column('amount', { logicalType: 'number', physicalType: 'numeric(24,2)', unit: 'VND', classification: 'INTERNAL' })],
  consumer_approvals: [
    approval('00000000-0000-4000-8000-0000000000a1', 'HOME', { consumer_owner: { membership_id: ME, display_name: 'Me' } }),
    approval('00000000-0000-4000-8000-0000000000a2', 'MNE-07', { decision: 'APPROVED', comment: 'agreed' }),
  ],
  version: 1,
  ...overrides,
});
const version = (id: string, rev: number, overrides: Record<string, unknown> = {}) => ({
  id,
  dataset_id: DS1,
  dataset_code: 'DS-ONE',
  contract_id: REV,
  revision: rev,
  grain: 'g',
  owner_id: ME,
  compatibility: rev === 1 ? 'INITIAL' : 'BREAKING',
  odcs_sha256: `${rev}`.repeat(64),
  odcs_object_key: 'k',
  published_by: OTHER,
  published_at: '2026-10-01T00:00:00.000Z',
  supersedes_id: null,
  migration_window_until: null,
  serving: true,
  serving_until: null,
  columns: [],
  ...overrides,
});
/** An approval as the list of the approvals of the person gives it: with the revision it is about. */
const waiting = (id: string, ref: string, overrides: Record<string, unknown> = {}, contract: Record<string, unknown> = {}) => ({
  ...approval(id, ref, { consumer_owner: { membership_id: ME, display_name: 'Me' } }),
  contract: {
    id: REV,
    dataset_id: DS1,
    dataset_code: 'DS-ONE',
    revision: 2,
    status: 'IN_REVIEW',
    compatibility: 'BREAKING',
    effective_from: '2030-11-01',
    odcs_version: 'v3.0.2',
    changes,
    ...contract,
  },
  ...overrides,
});
const changes = [
  { kind: 'COLUMN_REMOVED', object: 'disbursement', column: 'unit_code', breaking: true },
  { kind: 'TYPE_CHANGED', object: 'disbursement', column: 'amount', breaking: true },
];

interface World {
  datasets: unknown[] | Error;
  revisions: unknown[] | Error;
  versions: unknown[] | Error;
  detail: unknown;
  waiting: unknown[] | Error;
}

function open(
  world: Partial<World> = {},
  command: (operation: string, input: unknown) => unknown = () => ({ operation_id: 'o', status: 'PUBLISHED', resource_version: 2, resource_id: REV }),
): Harness & { readAll: ReturnType<typeof vi.fn> } {
  const state: World = {
    datasets: [dataset(DS1, 'DS-ONE'), dataset(DS2, 'DS-TWO')],
    revisions: [revision()],
    versions: [version(VER2, 2), version(VER1, 1, { serving: true, serving_until: '2030-12-31' })],
    detail: { ...revision(), odcs_json: {}, changes },
    waiting: [waiting('00000000-0000-4000-8000-0000000000a1', 'HOME')],
    ...world,
  };
  const h = harness((operation) => (operation === 'get_resources_dataset_contract_id' ? state.detail : new Error(`unexpected read ${operation}`)), command);
  const readAll = vi.fn((operation: string, input?: { query?: Record<string, string> }) => {
    const pick = (value: unknown[] | Error): Promise<unknown[]> => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
    switch (operation) {
      case 'searchCatalog':
        return pick(state.datasets);
      case 'get_resources_dataset_contract':
        return pick(
          state.revisions instanceof Error
            ? state.revisions
            : state.revisions.filter(
                (item) =>
                  (input?.query?.dataset_id === undefined || (item as { dataset_id: string }).dataset_id === input.query.dataset_id) &&
                  (input?.query?.status === undefined || (item as { status: string }).status === input.query.status),
              ),
        );
      case 'listConsumerApprovals':
        return pick(state.waiting);
      case 'get_resources_data_contract_version':
        return pick(state.versions);
      default:
        return Promise.reject(new Error(`unexpected readAll ${operation}`));
    }
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}

afterEach(cleanup);

describe('the model of the data contracts (ST-DGV-005)', () => {
  it('reads a revision with its columns, the approvals of its consumers and the changes, and leaves out what is not one', () => {
    const read = toRevision({ ...revision(), changes });
    expect(read).toMatchObject({ id: REV, revision: 2, status: 'IN_REVIEW', compatibility: 'BREAKING', effectiveFrom: '2030-11-01', version: 1 });
    expect(read?.columns.map((item) => item.name)).toEqual(['org_unit_code', 'amount']);
    expect(read?.approvals.map((item) => `${item.kind}:${item.ref}:${item.decision}`)).toEqual(['MODULE:HOME:PENDING', 'MODULE:MNE-07:APPROVED']);
    expect(read?.changes).toEqual([
      { kind: 'COLUMN_REMOVED', object: 'disbursement', column: 'unit_code', breaking: true },
      { kind: 'TYPE_CHANGED', object: 'disbursement', column: 'amount', breaking: true },
    ]);
    expect(toRevision({ ...revision(), status: 'LOST' })).toBeUndefined();
    expect(toRevision({ ...revision(), revision: '2' })).toBeUndefined();
    expect(toRevision({ id: REV })).toBeUndefined();
    expect(toRevision('x')).toBeUndefined();
    const sparse = toRevision({
      ...revision(),
      compatibility: 'SIDEWAYS',
      columns: [1, { object: 'o' }, column('a')],
      consumer_approvals: [1, approval('x', 'R', { consumer_kind: 'PARTNER' }), approval('y', 'R', { decision: 'MAYBE' }), { ...approval('z', 'R'), consumer_owner: null }],
      changes: [3, { kind: 'NEW', object: 'o', column: 'c' }, { kind: 'MADE_REQUIRED', object: 'o' }],
      version: 'x',
    });
    expect(sparse).toMatchObject({ compatibility: null, version: 1, columns: [{ name: 'a' }], approvals: [], changes: [] });
  });

  it('reads a published version with whether it serves and until when, and leaves out what is not one', () => {
    expect(toVersion(version(VER1, 1, { serving_until: '2030-12-31', migration_window_until: '2030-12-31' }))).toMatchObject({
      id: VER1,
      revision: 1,
      compatibility: 'INITIAL',
      serving: true,
      servingUntil: '2030-12-31',
      migrationWindowUntil: '2030-12-31',
    });
    expect(toVersion({ ...version(VER1, 1), compatibility: 'X', serving: 'yes' })).toMatchObject({ compatibility: null, serving: false });
    expect(toVersion({ id: VER1 })).toBeUndefined();
    expect(toVersion(null)).toBeUndefined();
  });

  it('finds the revision in review, tells whether every consumer approved, and which approvals wait for a person', () => {
    const a = toRevision(revision()) as NonNullable<ReturnType<typeof toRevision>>;
    const closed = toRevision(revision({ id: 'x', status: 'PUBLISHED' })) as NonNullable<ReturnType<typeof toRevision>>;
    expect(openRevision([closed, a])).toBe(a);
    expect(openRevision([closed])).toBeUndefined();
    expect(allApproved(a)).toBe(false);
    expect(allApproved(toRevision(revision({ consumer_approvals: [] })) as never)).toBe(true);
  });

  it('reads an approval that waits for the person with the revision it is about, and leaves out what is not one', () => {
    const read = toWaiting(waiting('00000000-0000-4000-8000-0000000000a1', 'HOME'));
    expect(read).toMatchObject({
      contractId: REV,
      contractStatus: 'IN_REVIEW',
      datasetCode: 'DS-ONE',
      revision: 2,
      compatibility: 'BREAKING',
      effectiveFrom: '2030-11-01',
      approval: { ref: 'HOME', decision: 'PENDING', version: 1 },
    });
    expect(toWaiting(waiting('x', 'HOME', {}, { compatibility: 'SIDEWAYS' }))?.compatibility).toBeNull();
    expect(toWaiting(waiting('x', 'HOME', {}, { status: 'LOST' }))).toBeUndefined();
    expect(toWaiting(waiting('x', 'HOME', {}, { revision: '2' }))).toBeUndefined();
    expect(toWaiting({ ...waiting('x', 'HOME'), contract: null })).toBeUndefined();
    expect(toWaiting({ ...waiting('x', 'HOME'), consumer_ref: 3 })).toBeUndefined();
    expect(toWaiting(undefined)).toBeUndefined();
  });

  it('checks the form of a draft: the document, the day', () => {
    expect(validateDraft(EMPTY_DRAFT)).toEqual({ document: 'required', effectiveFrom: 'required' });
    expect(validateDraft({ ...EMPTY_DRAFT, document: '[]', effectiveFrom: '2030-02-30' })).toEqual({ document: 'invalid', effectiveFrom: 'invalid' });
    expect(validateDraft({ ...EMPTY_DRAFT, document: '{nope', effectiveFrom: '2030-02-28' })).toEqual({ document: 'invalid' });
    expect(validateDraft({ ...EMPTY_DRAFT, document: '{"apiVersion":"v3.0.2"}', effectiveFrom: '2030-02-28' })).toEqual({});
    expect(draftBody(DS1, { odcsVersion: 'v3.0.2', document: '{"a":1}', effectiveFrom: ' 2030-01-01 ' })).toEqual({
      dataset_id: DS1,
      odcs_version: 'v3.0.2',
      odcs_json: { a: 1 },
      effective_from: '2030-01-01',
    });
    expect(draftBody(DS1, { odcsVersion: 'v3.0.2', document: 'nope', effectiveFrom: '2030-01-01' }).odcs_json).toEqual({});
  });

  it('knows a calendar day, and shows the first characters of a hash', () => {
    expect(isDay('2030-02-28')).toBe(true);
    expect(isDay('2030-02-30')).toBe(false);
    expect(isDay('2030-2-3')).toBe(false);
    expect(isDay('')).toBe(false);
    expect(shortHash('abcdef0123456789')).toBe('abcdef012345');
    expect(shortHash(null)).toBe('');
  });

  it.each([
    ['ODCS_SCHEMA_INVALID', 'schema'],
    ['CONTRACT_REVISION_OPEN', 'open'],
    ['CONSUMER_APPROVAL_PENDING', 'pending'],
    ['MIGRATION_WINDOW_REQUIRED', 'window'],
    ['SELF_APPROVAL_DENIED', 'self'],
    ['NOT_CONSUMER_OWNER', 'notOwner'],
    ['VERSION_CONFLICT', 'stale'],
    ['STAGE_TRANSITION_DENIED', 'state'],
    ['RESOURCE_NOT_FOUND', 'notFound'],
    ['SCOPE_DENIED', 'scope'],
    ['VALIDATION_FAILED', 'validation'],
    ['SOMETHING_ELSE', 'general'],
  ])('tells the code %s as %s, with the path or the field it names', (code, reason) => {
    expect(describeContractProblem(failure(422, code, 'x.y'))).toEqual({ reason, detail: 'x.y' });
    expect(describeContractProblem(new Error('boom'))).toEqual({ reason: 'general', detail: '' });
  });
});

describe('DGV-13, the data contract of a dataset (ST-DGV-005, UAT-AC50)', () => {
  it('shows the published versions with their hash, compatibility and whether they serve, and the revision in review with its changes, its columns and the approvals of its consumers', async () => {
    const h = open();
    mount(<ContractScreen route={ROUTE} />, h, { permissions: OWNER });
    const versions = await screen.findByTestId('versions');
    const rows = within(versions).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('data-serving')).toBe('true');
    expect(rows[0]?.textContent).toContain(vi_['dgv.contract.compat.breaking']);
    expect(rows[0]?.textContent).toContain('222222222222');
    expect(rows[1]?.textContent).toContain(fill(vi_['dgv.contract.serving.until'], { day: '2030-12-31' }));
    const detail = await screen.findByRole('region', { name: fill(vi_['dgv.contract.open.title'], { revision: 2 }) });
    expect(within(detail).getByTestId('compat').textContent).toBe(vi_['dgv.contract.compat.breaking']);
    expect(within(detail).getByTestId('status').textContent).toBe(vi_['dgv.contract.status.inReview']);
    await waitFor(() => expect(within(detail).getByTestId('changes').textContent).toContain(fill(vi_['dgv.contract.change.removed'], { column: 'unit_code' })));
    expect(within(detail).getByTestId('changes').textContent).toContain(fill(vi_['dgv.contract.change.type'], { column: 'amount' }));
    const schema = within(detail).getByTestId('schema');
    expect(within(schema).getAllByRole('row').slice(1)).toHaveLength(2);
    expect(schema.textContent).toContain('numeric(24,2)');
    const approvals = within(detail).getByTestId('approvals');
    expect(
      within(approvals)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.getAttribute('data-decision')),
    ).toEqual(['PENDING', 'APPROVED']);
    expect(within(detail).getByTestId('waiting').textContent).toBe(fill(vi_['dgv.contract.approvals.waiting'], { count: 1 }));
    expect(h.readAll).toHaveBeenCalledWith('get_resources_dataset_contract', { query: { dataset_id: DS1 } });
  });

  it('says so when the dataset has no version published and no revision in review, and offers the draft form to a steward', async () => {
    mount(<ContractScreen route={ROUTE} />, open({ revisions: [], versions: [] }), { permissions: MANAGER });
    expect((await screen.findByTestId('no-versions')).textContent).toBe(vi_['dgv.contract.versions.none']);
    expect(screen.getByTestId('no-open').textContent).toBe(vi_['dgv.contract.open.none']);
    expect(screen.getByRole('form', { name: vi_['dgv.contract.draft.title'] })).toBeTruthy();
  });

  it.each([
    ['revisions', { revisions: failure(500, 'INTERNAL_ERROR') }],
    ['versions', { versions: failure(500, 'INTERNAL_ERROR') }],
  ])('does not show a failed read of the %s as an empty dataset: no draft form, an error and a way to read again', async (_name, broken) => {
    const h = open(broken as Partial<World>);
    mount(<ContractScreen route={ROUTE} />, h, { permissions: MANAGER });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    expect(screen.queryByTestId('no-open')).toBeNull();
    expect(screen.queryByTestId('no-versions')).toBeNull();
    expect(screen.queryByRole('form', { name: vi_['dgv.contract.draft.title'] })).toBeNull();
    // Read again once the server answers.
    h.readAll.mockImplementation((operation: string) => Promise.resolve(operation === 'searchCatalog' ? [dataset(DS1, 'DS-ONE')] : []));
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    expect(await screen.findByRole('form', { name: vi_['dgv.contract.draft.title'] })).toBeTruthy();
  });

  it('does not give the form to publish from the row of the list when the revision in review could not be read whole, and reads it again on retry', async () => {
    const h = open({ detail: failure(500, 'INTERNAL_ERROR') });
    mount(<ContractScreen route={ROUTE} />, h, { permissions: MANAGER });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    expect(screen.queryByRole('region', { name: fill(vi_['dgv.contract.open.title'], { revision: 2 }) })).toBeNull();
    expect(screen.queryByRole('form', { name: vi_['dgv.contract.publish.title'] })).toBeNull();
    h.read.mockImplementation(() => Promise.resolve({ ...revision(), odcs_json: {}, changes }));
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    expect(await screen.findByRole('region', { name: fill(vi_['dgv.contract.open.title'], { revision: 2 }) })).toBeTruthy();
  });

  it('shows the loading state while the revisions and the versions are read', () => {
    const h = open();
    h.readAll.mockImplementation((operation: string) => (operation === 'searchCatalog' ? Promise.resolve([dataset(DS1, 'DS-ONE')]) : new Promise(() => undefined)));
    mount(<ContractScreen route={ROUTE} />, h, { permissions: MANAGER });
    return screen.findByRole('status', { name: vi_['states.loading.label'] });
  });

  it('gives no form and no button to a person who has no right over the contracts, or in a read-only session', async () => {
    mount(<ContractScreen route={ROUTE} />, open(), { permissions: ['data.catalog.read'] });
    await screen.findByTestId('versions');
    expect(screen.queryByRole('form', { name: vi_['dgv.contract.publish.title'] })).toBeNull();
    expect(screen.queryByRole('form', { name: vi_['dgv.contract.draft.title'] })).toBeNull();
    cleanup();
    mount(<ContractScreen route={ROUTE} />, open({ revisions: [] }), { permissions: [...OWNER, ...MANAGER], mode: 'READ_ONLY' });
    await screen.findByTestId('versions');
    expect(screen.queryByRole('form', { name: vi_['dgv.contract.draft.title'] })).toBeNull();
    expect(screen.queryByRole('form', { name: vi_['dgv.contract.publish.title'] })).toBeNull();
  });

  it('publishes a breaking revision with the end of the window, against the version that was read, and shows the refusal of the server', async () => {
    const user = userEvent.setup();
    const h = open({}, (_operation, input) => {
      const body = (input as { body: { migration_window_until?: string } }).body;
      if (body.migration_window_until === '2030-12-31') throw failure(409, 'CONSUMER_APPROVAL_PENDING');
      return { operation_id: 'o', status: 'PUBLISHED', resource_version: 2, resource_id: REV };
    });
    h.command.mockImplementationOnce(() => Promise.reject(failure(409, 'CONSUMER_APPROVAL_PENDING')));
    mount(<ContractScreen route={ROUTE} />, h, { permissions: OWNER });
    const form = await screen.findByRole('form', { name: vi_['dgv.contract.publish.title'] });
    // The window is asked for before anything is sent.
    await user.click(within(form).getByRole('button', { name: vi_['dgv.contract.publish.submit'] }));
    expect(await within(form).findByText(vi_['dgv.contract.window.required'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['dgv.contract.window']), '2030-12-31');
    const readsBefore = h.readAll.mock.calls.filter(([operation]) => operation === 'get_resources_dataset_contract').length;
    await user.click(within(form).getByRole('button', { name: vi_['dgv.contract.publish.submit'] }));
    const refusal = await screen.findByTestId('refusal');
    // The refusal kept the approvals it asked for: the revisions are read again.
    await waitFor(() => expect(h.readAll.mock.calls.filter(([operation]) => operation === 'get_resources_dataset_contract').length).toBeGreaterThan(readsBefore));
    expect(refusal.getAttribute('data-reason')).toBe('pending');
    expect(refusal.textContent).toBe(vi_['dgv.contract.problem.pending']);
    expect(h.command).toHaveBeenCalledWith('publishDatasetContract', expect.objectContaining({ path: { id: REV }, body: { migration_window_until: '2030-12-31' }, ifMatchVersion: 1 }));
  });

  it('publishes a revision that is not breaking without asking for a window', async () => {
    const user = userEvent.setup();
    const backward = revision({ compatibility: 'BACKWARD_COMPATIBLE', consumer_approvals: [] });
    const h = open({ revisions: [backward], detail: { ...backward, odcs_json: {}, changes: [] } });
    mount(<ContractScreen route={ROUTE} />, h, { permissions: OWNER });
    const form = await screen.findByRole('form', { name: vi_['dgv.contract.publish.title'] });
    expect(within(form).queryByLabelText(vi_['dgv.contract.window'])).toBeNull();
    await user.click(within(form).getByRole('button', { name: vi_['dgv.contract.publish.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('publishDatasetContract', expect.objectContaining({ body: {}, ifMatchVersion: 1 })));
    expect(screen.queryByTestId('waiting')).toBeNull();
  });

  it('returns or rejects the revision with a reason that is asked for, by the baseline command', async () => {
    const user = userEvent.setup();
    const h = open();
    mount(<ContractScreen route={ROUTE} />, h, { permissions: OWNER });
    const form = await screen.findByRole('form', { name: vi_['dgv.contract.publish.title'] });
    await user.click(within(form).getByRole('button', { name: vi_['dgv.contract.reject'] }));
    expect(await within(form).findByText(vi_['dgv.contract.reason.required'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['dgv.contract.reason']), '  Not before the year end  ');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.contract.reject'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'post_data_contracts_id_publish',
        expect.objectContaining({ path: { id: REV }, body: { decision: 'reject', reason: 'Not before the year end', evidence_ids: [] }, ifMatchVersion: 1 }),
      ),
    );
    await user.click(within(form).getByRole('button', { name: vi_['dgv.contract.return'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith('post_data_contracts_id_publish', expect.objectContaining({ body: { decision: 'return', reason: 'Not before the year end', evidence_ids: [] } })),
    );
  });

  it('shows the refusal of a close, and only the buttons of the right the person has', async () => {
    const user = userEvent.setup();
    const h = open({}, () => {
      throw failure(403, 'SELF_APPROVAL_DENIED');
    });
    mount(<ContractScreen route={ROUTE} />, h, { permissions: ['data.catalog.read', 'data.contract.publish'] });
    const form = await screen.findByRole('form', { name: vi_['dgv.contract.publish.title'] });
    expect(within(form).queryByRole('button', { name: vi_['dgv.contract.publish.submit'] })).toBeNull();
    await user.type(within(form).getByLabelText(vi_['dgv.contract.reason']), 'No');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.contract.return'] }));
    expect((await screen.findByTestId('refusal')).getAttribute('data-reason')).toBe('self');
  });

  it('drafts a revision from the document that was typed, and says where an ODCS document is wrong', async () => {
    const user = userEvent.setup();
    const h = open({ revisions: [] }, (_operation, input) => {
      if ((input as { body: { odcs_json: { bad?: boolean } } }).body.odcs_json.bad === true) throw failure(422, 'ODCS_SCHEMA_INVALID', 'schema[0].properties[0].logicalType');
      return { operation_id: 'o', status: 'IN_REVIEW', resource_version: 1, resource_id: REV };
    });
    mount(<ContractScreen route={ROUTE} />, h, { permissions: MANAGER });
    const form = await screen.findByRole('form', { name: vi_['dgv.contract.draft.title'] });
    await user.click(within(form).getByRole('button', { name: vi_['dgv.contract.draft.submit'] }));
    expect(within(form).getAllByText(vi_['dgv.contract.draft.required'])).toHaveLength(2);
    await user.click(within(form).getByLabelText(vi_['dgv.contract.draft.document']));
    await user.paste('{ nope');
    await user.type(within(form).getByLabelText(vi_['dgv.contract.draft.effective']), '2030-11-01');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.contract.draft.submit'] }));
    expect(await within(form).findByText(vi_['dgv.contract.draft.json'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.clear(within(form).getByLabelText(vi_['dgv.contract.draft.document']));
    await user.click(within(form).getByLabelText(vi_['dgv.contract.draft.document']));
    await user.paste('{"bad":true}');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.contract.draft.submit'] }));
    const refusal = await screen.findByTestId('draft-refusal');
    expect(refusal.textContent).toBe(fill(vi_['dgv.contract.problem.schema'], { path: 'schema[0].properties[0].logicalType' }));
    await user.clear(within(form).getByLabelText(vi_['dgv.contract.draft.document']));
    await user.click(within(form).getByLabelText(vi_['dgv.contract.draft.document']));
    await user.paste('{"apiVersion":"v3.0.2"}');
    await user.selectOptions(within(form).getByLabelText(vi_['dgv.contract.draft.version']), 'v3.0.1');
    await user.click(within(form).getByRole('button', { name: vi_['dgv.contract.draft.submit'] }));
    expect((await screen.findByTestId('saved')).textContent).toBe(vi_['dgv.contract.draft.saved']);
    expect(h.command).toHaveBeenLastCalledWith(
      'createDatasetContractRevision',
      expect.objectContaining({ body: { dataset_id: DS1, odcs_version: 'v3.0.1', odcs_json: { apiVersion: 'v3.0.2' }, effective_from: '2030-11-01' } }),
    );
  });

  it('asks for the contract of the dataset that is chosen', async () => {
    const user = userEvent.setup();
    const h = open();
    mount(<ContractScreen route={ROUTE} />, h, { permissions: OWNER });
    await screen.findByTestId('versions');
    await user.selectOptions(screen.getByLabelText(vi_['dgv.contract.dataset']), DS2);
    await waitFor(() => expect(h.readAll).toHaveBeenCalledWith('get_resources_dataset_contract', { query: { dataset_id: DS2 } }));
    expect(h.readAll).toHaveBeenCalledWith('get_resources_data_contract_version', { query: { dataset_id: DS2 } });
  });

  it('starts over when the member or the tenant changes: what was typed is not carried to another', async () => {
    const user = userEvent.setup();
    const view = mount(<ContractScreen route={ROUTE} />, open({ revisions: [] }), { permissions: MANAGER });
    const form = await screen.findByRole('form', { name: vi_['dgv.contract.draft.title'] });
    await user.type(within(form).getByLabelText(vi_['dgv.contract.draft.effective']), '2030-11-01');
    view.rerenderWith({ permissions: MANAGER, tenant: { id: '00000000-0000-4000-8000-0000000000bb', name: 'Khác', membershipId: ME } as never });
    await waitFor(() => expect((screen.getByLabelText(vi_['dgv.contract.draft.effective']) as HTMLInputElement).value).toBe(''));
  });
});

describe('the seven standard states of DGV-13 and DGV-19 (ST-DGV-005)', () => {
  const offline = new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' });
  const states: Array<[string, Error | unknown[], string]> = [
    ['empty', [], vi_['states.empty.title']],
    ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
    ['offline', offline, vi_['states.offline.title']],
    ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
    ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
  ];

  it.each(states)('UI-DGV-13 shows the %s state', async (_name, datasets, title) => {
    mount(<ContractScreen route={ROUTE} />, open({ datasets }), { permissions: OWNER });
    expect(await screen.findByText(title)).toBeTruthy();
  });

  it.each(states)('UI-DGV-19 shows the %s state', async (_name, answer, title) => {
    mount(<ConsumerInboxScreen route={INBOX} />, open({ waiting: answer }), { permissions: ['data.contract.consume'] });
    expect(await screen.findByText(title)).toBeTruthy();
  });

  it('UI-DGV-13 and UI-DGV-19 show the loading state first and name the page', () => {
    for (const [element, name] of [
      [<ContractScreen key="contract" route={ROUTE} />, vi_['dgv.contract.title']],
      [<ConsumerInboxScreen key="inbox" route={INBOX} />, vi_['dgv.inbox.title']],
    ] as const) {
      const h = open();
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(element, h, { permissions: OWNER });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name })).toBeTruthy();
      cleanup();
    }
  });

  it('UI-DGV-13 retries after an error', async () => {
    const world: Partial<World> = { datasets: failure(500, 'INTERNAL_ERROR') };
    const h = open(world);
    mount(<ContractScreen route={ROUTE} />, h, { permissions: OWNER });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    h.readAll.mockImplementation((operation: string) => Promise.resolve(operation === 'searchCatalog' ? [dataset(DS1, 'DS-ONE')] : []));
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    expect(await screen.findByTestId('no-versions')).toBeTruthy();
  });
});

describe('DGV-19, the approvals that wait for the owner of a consumer (ST-DGV-005, UAT-AC50)', () => {
  it('lists the approvals that wait for the person, each with the dataset, the revision, the consumer and what changes', async () => {
    // The approval of a revision that is no longer in review does not wait for anybody.
    const closed = waiting('00000000-0000-4000-8000-0000000000a9', 'ELSEWHERE', {}, { status: 'REJECTED' });
    const h = open({ waiting: [waiting('00000000-0000-4000-8000-0000000000a1', 'HOME'), closed] });
    mount(<ConsumerInboxScreen route={INBOX} />, h, { permissions: ['data.contract.consume'] });
    const inbox = await screen.findByTestId('inbox');
    const items = within(inbox).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(h.readAll).toHaveBeenCalledWith('listConsumerApprovals', { query: { decision: 'PENDING' } });
    expect(items[0]?.getAttribute('data-approval')).toBe('00000000-0000-4000-8000-0000000000a1');
    expect(within(items[0] as HTMLElement).getByTestId('consumer').textContent).toContain('HOME');
    expect(items[0]?.textContent).toContain('DS-ONE');
    expect(items[0]?.textContent).toContain(vi_['dgv.contract.compat.breaking']);
    // The owner is told what changes before the decision.
    const told = within(items[0] as HTMLElement).getByTestId('changes');
    expect(
      within(told)
        .getAllByText(/./)
        .filter((node) => node.tagName === 'P'),
    ).toHaveLength(changes.length);
    expect(told.querySelector('[data-breaking="true"]')).not.toBeNull();
  });

  it('approves or rejects with a comment, against the version of the approval that was read', async () => {
    const user = userEvent.setup();
    const h = open({}, () => ({ operation_id: 'o', status: 'APPROVED', resource_version: 2, resource_id: 'x' }));
    mount(<ConsumerInboxScreen route={INBOX} />, h, { permissions: ['data.contract.consume'] });
    const item = (await screen.findAllByRole('listitem'))[0] as HTMLElement;
    await user.type(within(item).getByLabelText(vi_['dgv.inbox.comment']), '  HOME moves on 2030-11-15  ');
    await user.click(within(item).getByRole('button', { name: vi_['dgv.inbox.approve'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'recordConsumerApproval',
        expect.objectContaining({ path: { id: '00000000-0000-4000-8000-0000000000a1' }, body: { decision: 'APPROVED', comment: 'HOME moves on 2030-11-15' }, ifMatchVersion: 1 }),
      ),
    );
    await user.click(within(item).getByRole('button', { name: vi_['dgv.inbox.reject'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('recordConsumerApproval', expect.objectContaining({ body: { decision: 'REJECTED', comment: 'HOME moves on 2030-11-15' } })));
  });

  it('sends no comment when none was typed, and shows the refusal of the server', async () => {
    const user = userEvent.setup();
    const h = open({}, () => {
      throw failure(403, 'NOT_CONSUMER_OWNER');
    });
    mount(<ConsumerInboxScreen route={INBOX} />, h, { permissions: ['data.contract.consume'] });
    const item = (await screen.findAllByRole('listitem'))[0] as HTMLElement;
    await user.click(within(item).getByRole('button', { name: vi_['dgv.inbox.approve'] }));
    expect((await screen.findByTestId('refusal')).getAttribute('data-reason')).toBe('notOwner');
    expect(h.command).toHaveBeenCalledWith('recordConsumerApproval', expect.objectContaining({ body: { decision: 'APPROVED' } }));
  });

  it('gives no button to a person who may not consume, or in a read-only session', async () => {
    mount(<ConsumerInboxScreen route={INBOX} />, open(), { permissions: ['data.catalog.read'] });
    const item = (await screen.findAllByRole('listitem'))[0] as HTMLElement;
    expect(within(item).queryByRole('button')).toBeNull();
    cleanup();
    mount(<ConsumerInboxScreen route={INBOX} />, open(), { permissions: ['data.contract.consume'], mode: 'READ_ONLY' });
    expect(within((await screen.findAllByRole('listitem'))[0] as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('says nothing waits when no approval is the person’s, and needs no right to read the contracts', async () => {
    const h = open({ waiting: [] });
    mount(<ConsumerInboxScreen route={INBOX} />, h, { permissions: ['data.contract.consume'] });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    expect(h.readAll.mock.calls.map(([operation]) => operation)).toEqual(['listConsumerApprovals']);
  });

  it('starts over when the member or the tenant changes: the comment that was typed is not carried to another', async () => {
    const user = userEvent.setup();
    const view = mount(<ConsumerInboxScreen route={INBOX} />, open(), { permissions: ['data.contract.consume'] });
    const item = (await screen.findAllByRole('listitem'))[0] as HTMLElement;
    await user.type(within(item).getByLabelText(vi_['dgv.inbox.comment']), 'text');
    view.rerenderWith({ permissions: ['data.contract.consume'], tenant: { id: '00000000-0000-4000-8000-0000000000bb', name: 'Khác', membershipId: ME } as never });
    await waitFor(() => expect((screen.getByLabelText(vi_['dgv.inbox.comment']) as HTMLInputElement).value).toBe(''));
  });
});
