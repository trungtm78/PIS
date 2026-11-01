import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import DashboardCompareScreen from './DashboardCompareScreen';
import PublicationInboxScreen from './PublicationInboxScreen';
import { toDashboard, toVersion } from './dashboard-model';
import { EMPTY_REQUEST, compareVersions, decisionBody, decisionProblem, describePublicationProblem, mayRequest, requestBody, toRequest, validateRequest } from './publication-model';
import { rawMetric } from './test-support';

const INBOX = routeOf('BI-11', 'FR-BI-11');
const COMPARE = routeOf('BI-10', 'FR-BI-10');
const APPROVE = ['bi.publish', 'bi.query', 'dashboard_version.read', 'metric_definition.read'];
const ASK = ['bi.publish.request', 'bi.query', 'dashboard_version.read', 'metric_definition.read'];
const ME = '00000000-0000-4000-8000-000000000001'; // the member of the session of the test support
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const R1 = '00000000-0000-4000-8000-0000000000a1';
const R2 = '00000000-0000-4000-8000-0000000000a2';
const R3 = '00000000-0000-4000-8000-0000000000a3';
const OBJECT = '00000000-0000-4000-8000-0000000000b1';
const D1 = '00000000-0000-4000-8000-0000000000e1';
const V1 = '00000000-0000-4000-8000-0000000000f1';
const V2 = '00000000-0000-4000-8000-0000000000f2';
const V3 = '00000000-0000-4000-8000-0000000000f3';
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);
const failure = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });

const RATE = rawMetric({
  id: '00000000-0000-4000-8000-0000000000c1',
  code: 'disbursement_rate',
  revision: 2,
});
const DISBURSED = rawMetric({
  id: '00000000-0000-4000-8000-0000000000c2',
  code: 'disbursed',
  aggregation_type: 'additive',
  unit: 'VND',
  numerator_ast: null,
  denominator_ast: null,
});

const request = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  object_kind: 'METRIC',
  object_id: OBJECT,
  object_code: 't_rate',
  object_revision: 2,
  requested_by: { id: OTHER, name: 'Người đề nghị' },
  checks: [
    { code: 'FORMULA_COMPUTABLE', passed: true },
    { code: 'ROWS_MATCH_SNAPSHOT', passed: false },
    { code: 'SOMETHING_NEW', passed: true },
  ],
  status: 'PENDING',
  decision: null,
  decided_by: null,
  decided_at: null,
  comment: null,
  created_at: '2026-11-01T01:00:00.000Z',
  version: 3,
  ...overrides,
});

interface World {
  requests?: unknown[] | Error;
  dashboards?: unknown[];
  one?: Record<string, unknown> | Error;
  metrics?: unknown[] | Error;
}

function client(
  world: World,
  command: (operation: string, input: unknown) => unknown = () => ({
    operation_id: 'o',
    status: 'DECIDED',
    resource_version: 4,
    resource_id: R1,
  }),
) {
  const h = harness((operation) => (operation === 'getDashboard' ? (world.one ?? new Error('unexpected read')) : new Error(`unexpected read ${operation}`)), command);
  const readAll = vi.fn((operation: string) => {
    const result =
      operation === 'listBiPublicationRequests'
        ? (world.requests ?? [])
        : operation === 'listDashboards'
          ? (world.dashboards ?? [])
          : operation === 'get_resources_metric_definition'
            ? (world.metrics ?? [RATE, DISBURSED])
            : new Error(`unexpected readAll ${operation}`);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}

const widget = (id: string, metric: string, overrides: Record<string, unknown> = {}) => ({
  id,
  kind: 'BAR',
  metric_version_id: metric,
  dimension_code: 'unit',
  grid: { x: 0, y: 0, w: 6, h: 4 },
  ...overrides,
});
const version = (id: string, revision: number, widgets: unknown[], metrics: string[], overrides: Record<string, unknown> = {}) => ({
  id,
  dashboard_id: D1,
  revision,
  layout_json: { columns: 12, widgets },
  metric_versions: metrics,
  filter_mappings: { period: 'bucket' },
  breakpoints: { sm: 640 },
  dataset_version_policy: 'LATEST_FROZEN',
  pinned_dataset_version_ids: [],
  status: 'PUBLISHED',
  created_by: ME,
  created_at: '2026-11-01T01:00:00.000Z',
  published_by: OTHER,
  published_at: '2026-11-02T01:00:00.000Z',
  ...overrides,
});
const dashboard = (versions: unknown[], overrides: Record<string, unknown> = {}) => ({
  id: D1,
  code: 'D-ONE',
  title: 'Dashboard D-ONE',
  owner: { id: ME, name: 'Tôi' },
  audience: 'PRIVATE',
  status: 'PUBLISHED',
  current_version: {
    id: V2,
    revision: 2,
    status: 'DRAFT',
    metric_count: 2,
    metrics_certified: true,
  },
  mine: true,
  may_edit: true,
  version: 5,
  versions,
  ...overrides,
});
const OLD = version(V1, 1, [widget('w1', RATE.id, { title: 'Giải ngân' }), widget('w2', RATE.id)], [RATE.id], { status: 'SUPERSEDED' });
const NEW = version(V2, 2, [widget('w1', RATE.id, { title: 'Giải ngân', kind: 'LINE' }), widget('w3', DISBURSED.id, { title: 'Tổng' })], [RATE.id, DISBURSED.id], {
  status: 'DRAFT',
  published_by: null,
  published_at: null,
  breakpoints: { sm: 640, md: 1024 },
  dataset_version_policy: 'PINNED',
  pinned_dataset_version_ids: ['00000000-0000-4000-8000-0000000000d9'],
});

afterEach(cleanup);

describe('the model of the publication requests (ST-BI-006)', () => {
  it('reads a request, drops one without an id, and keeps what is missing as nothing', () => {
    expect(toRequest(null)).toBeUndefined();
    expect(toRequest({ object_kind: 'METRIC' })).toBeUndefined();
    const read = toRequest(
      request(R1, {
        decision: 'APPROVED',
        decided_by: { id: ME, name: null },
        decided_at: '2026-11-02T00:00:00.000Z',
        comment: 'Đạt',
        status: 'DECIDED',
      }),
    );
    expect(read).toMatchObject({
      id: R1,
      kind: 'METRIC',
      objectCode: 't_rate',
      objectRevision: 2,
      status: 'DECIDED',
      decision: 'APPROVED',
      decidedBy: { id: ME, name: null },
      comment: 'Đạt',
      version: 3,
    });
    expect(read?.checks).toHaveLength(3);
    expect(
      toRequest({
        id: R2,
        object_kind: 'NONSENSE',
        status: 'NONSENSE',
        checks: 'x',
        requested_by: 7,
      }),
    ).toMatchObject({
      kind: 'METRIC',
      status: 'PENDING',
      checks: [],
      requestedBy: { id: '', name: null },
      objectRevision: null,
      version: 1,
      decidedBy: null,
    });
  });

  it('checks the id of an object to ask for, and writes the body as the contract has it', () => {
    expect(validateRequest(EMPTY_REQUEST)).toEqual({ objectId: 'required' });
    expect(validateRequest({ kind: 'METRIC', objectId: 'not an id' })).toEqual({
      objectId: 'invalid',
    });
    expect(validateRequest({ kind: 'METRIC', objectId: OBJECT })).toEqual({});
    expect(
      requestBody({
        kind: 'DASHBOARD',
        objectId: `  ${OBJECT.toUpperCase()} `,
      }),
    ).toEqual({ object_kind: 'DASHBOARD', object_id: OBJECT });
  });

  it('asks the reason of a rejection only, and sends the comment trimmed or none', () => {
    expect(decisionProblem('REJECTED', '  ')).toBe('reasonRequired');
    expect(decisionProblem('REJECTED', 'Sai')).toBeUndefined();
    expect(decisionProblem('APPROVED', '')).toBeUndefined();
    expect(decisionBody('APPROVED', ' ')).toEqual({ decision: 'APPROVED' });
    expect(decisionBody('REJECTED', ' Sai mẫu số ')).toEqual({
      decision: 'REJECTED',
      comment: 'Sai mẫu số',
    });
  });

  it('names the reason of a refusal by the code of the server, and the check it points at', () => {
    expect(describePublicationProblem(failure(403, 'SELF_APPROVAL_DENIED'))).toEqual({ reason: 'self', detail: '' });
    expect(describePublicationProblem(failure(422, 'REPRODUCIBILITY_CHECK_FAILED', 'GROUPS_ADD_UP'))).toEqual({ reason: 'reproduction', detail: 'GROUPS_ADD_UP' });
    expect(describePublicationProblem(failure(500, 'SOMETHING'))).toEqual({
      reason: 'general',
      detail: '',
    });
    expect(describePublicationProblem(new Error('x'))).toEqual({
      reason: 'general',
      detail: '',
    });
  });

  it('compares two versions: the tiles added, removed and changed, the metrics and the settings', () => {
    const older = toVersion(OLD)!;
    const newer = toVersion(NEW)!;
    const diff = compareVersions(older, newer);
    expect(diff.same).toBe(false);
    expect(diff.tilesAdded.map((tile) => tile.id)).toEqual(['w3']);
    expect(diff.tilesRemoved.map((tile) => tile.id)).toEqual(['w2']);
    expect(diff.tilesChanged).toEqual([expect.objectContaining({ id: 'w1', fields: ['kind'] })]);
    expect(diff.metricsAdded).toEqual([DISBURSED.id]);
    expect(diff.metricsKept).toEqual([RATE.id]);
    expect(diff.metricsRemoved).toEqual([]);
    expect(diff.settings.map((setting) => setting.key)).toEqual(['breakpoint:md', 'pinned', 'policy']);
    expect(compareVersions(older, older).same).toBe(true);
    const moved = toVersion(
      version(
        V3,
        3,
        [
          widget('w1', RATE.id, {
            title: 'Khác',
            dimension_code: 'fund',
            metric_version_id: DISBURSED.id,
            grid: { x: 1, y: 0, w: 6, h: 4 },
          }),
        ],
        [DISBURSED.id],
        {
          filter_mappings: {},
          layout_json: {
            columns: 24,
            widgets: [
              widget('w1', DISBURSED.id, {
                title: 'Khác',
                dimension_code: 'fund',
                grid: { x: 1, y: 0, w: 6, h: 4 },
              }),
            ],
          },
        },
      ),
    )!;
    const against = compareVersions(older, moved);
    expect(against.tilesChanged[0]?.fields).toEqual(['title', 'metric', 'dimension', 'grid']);
    expect(against.metricsRemoved).toEqual([RATE.id]);
    expect(against.settings.map((setting) => setting.key)).toEqual(['breakpoint:sm', 'columns', 'filter:period'].filter((key) => key !== 'breakpoint:sm'));
  });

  it('lets the owner ask for a draft, and nobody else for anything else', () => {
    const owner = toDashboard(dashboard([NEW, OLD]))!;
    expect(mayRequest(owner, owner.versions[0]!)).toBe(true);
    expect(mayRequest(owner, owner.versions[1]!)).toBe(false);
    expect(mayRequest({ ...owner, mayEdit: false }, owner.versions[0]!)).toBe(false);
    expect(mayRequest({ ...owner, status: 'ARCHIVED' }, owner.versions[0]!)).toBe(false);
  });
});

describe('BI-11 inbox of the requests to publish (ST-BI-006)', () => {
  it('lists the pending requests with what they are about, who asked and the checks, and reads the pending ones first', async () => {
    const h = client({
      requests: [
        request(R1),
        request(R2, {
          object_kind: 'DASHBOARD',
          object_code: 'D-3',
          object_revision: 2,
          checks: [],
        }),
      ],
    });
    mount(<PublicationInboxScreen route={INBOX} />, h, {
      permissions: APPROVE,
    });
    const table = await screen.findByTestId('requests');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(h.readAll).toHaveBeenCalledWith('listBiPublicationRequests', {
      query: { status: 'PENDING' },
    });
    expect(within(rows[0] as HTMLElement).getByText(vi_['bi.pub.kind.metric'])).toBeTruthy();
    expect((rows[0] as HTMLElement).textContent).toContain('t_rate');
    expect((rows[0] as HTMLElement).textContent).toContain(fill(vi_['bi.pub.revision'], { revision: 2 }));
    expect((rows[0] as HTMLElement).textContent).toContain(
      fill(vi_['bi.pub.requested'], {
        name: 'Người đề nghị',
        date: '2026-11-01',
      }),
    );
    const checks = (rows[0] as HTMLElement).querySelectorAll('[data-check]');
    expect(checks).toHaveLength(3);
    expect(
      within(rows[0] as HTMLElement)
        .getByText(vi_['bi.pub.check.formula'])
        .getAttribute('data-passed'),
    ).toBe('true');
    expect(
      within(rows[0] as HTMLElement)
        .getByText(vi_['bi.pub.check.rows'])
        .getAttribute('data-passed'),
    ).toBe('false');
    expect(within(rows[0] as HTMLElement).getByText('SOMETHING_NEW')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(vi_['bi.pub.kind.dashboard'])).toBeTruthy();
    expect(
      within(rows[0] as HTMLElement).getByRole('button', {
        name: vi_['bi.pub.review'],
      }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['bi.pub.inbox.title']);
  });

  it('approves a request under the version it was read at, and closes the decision', async () => {
    const h = client({ requests: [request(R1)] });
    mount(<PublicationInboxScreen route={INBOX} />, h, {
      permissions: APPROVE,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: vi_['bi.pub.review'] }));
    const panel = await screen.findByTestId('decide');
    expect(within(panel).getByRole('heading', { level: 2 }).textContent).toBe(fill(vi_['bi.pub.decide.title'], { object: 't_rate' }));
    await user.type(within(panel).getByLabelText(vi_['bi.pub.decide.comment']), ' Đạt ');
    await user.click(within(panel).getByRole('button', { name: vi_['bi.pub.decide.approve'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith(
      'decideBiPublication',
      expect.objectContaining({
        path: { id: R1 },
        body: { decision: 'APPROVED', comment: 'Đạt' },
        ifMatchVersion: 3,
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('decide')).toBeNull());
  });

  it('asks the reason of a rejection before it sends anything', async () => {
    const h = client({ requests: [request(R1)] });
    mount(<PublicationInboxScreen route={INBOX} />, h, {
      permissions: APPROVE,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: vi_['bi.pub.review'] }));
    const panel = await screen.findByTestId('decide');
    await user.click(within(panel).getByRole('button', { name: vi_['bi.pub.decide.reject'] }));
    expect(await within(panel).findByText(vi_['bi.pub.decide.reason'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(panel).getByLabelText(vi_['bi.pub.decide.comment']), 'Sai mẫu số');
    await user.click(within(panel).getByRole('button', { name: vi_['bi.pub.decide.reject'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'decideBiPublication',
        expect.objectContaining({
          body: { decision: 'REJECTED', comment: 'Sai mẫu số' },
        }),
      ),
    );
  });

  it('does not let the one who asked decide, and says so', async () => {
    const h = client({
      requests: [request(R1, { requested_by: { id: ME, name: 'Tôi' } })],
    });
    mount(<PublicationInboxScreen route={INBOX} />, h, {
      permissions: APPROVE,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: vi_['bi.pub.review'] }));
    const panel = await screen.findByTestId('decide');
    expect(within(panel).getByTestId('self').textContent).toBe(vi_['bi.pub.self']);
    expect(
      within(panel).queryByRole('button', {
        name: vi_['bi.pub.decide.approve'],
      }),
    ).toBeNull();
  });

  it.each([
    [failure(403, 'SELF_APPROVAL_DENIED'), 'self', vi_['bi.pub.refusal.self']],
    [
      failure(422, 'REPRODUCIBILITY_CHECK_FAILED', 'ROWS_MATCH_SNAPSHOT'),
      'reproduction',
      fill(vi_['bi.pub.refusal.reproduction'], {
        check: vi_['bi.pub.check.rows'],
      }),
    ],
    [failure(422, 'METRIC_NOT_CERTIFIED'), 'notCertified', vi_['bi.pub.refusal.notCertified']],
    [failure(422, 'DATASET_VERSION_NOT_FROZEN'), 'notFrozen', vi_['bi.pub.refusal.notFrozen']],
    [failure(409, 'VERSION_CONFLICT'), 'conflict', vi_['bi.pub.refusal.conflict']],
    [failure(409, 'STAGE_TRANSITION_DENIED'), 'decided', vi_['bi.pub.refusal.decided']],
    [failure(422, 'VALIDATION_FAILED', 'comment'), 'invalid', vi_['bi.pub.refusal.invalid']],
    [failure(403, 'SCOPE_DENIED'), 'scope', vi_['bi.pub.refusal.scope']],
    [failure(404, 'RESOURCE_NOT_FOUND'), 'notFound', vi_['bi.pub.refusal.notFound']],
    [failure(500, 'BOOM'), 'general', vi_['bi.pub.refusal.general']],
    [failure(409, 'PUBLICATION_ALREADY_PENDING'), 'pending', vi_['bi.pub.refusal.pending']],
  ])('tells why the server refused a decision: %#', async (error, reason, message) => {
    const h = client({ requests: [request(R1)] }, () => error);
    mount(<PublicationInboxScreen route={INBOX} />, h, {
      permissions: APPROVE,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: vi_['bi.pub.review'] }));
    await user.click(
      within(await screen.findByTestId('decide')).getByRole('button', {
        name: vi_['bi.pub.decide.approve'],
      }),
    );
    const refusal = await screen.findByTestId('refusal');
    expect(refusal.getAttribute('data-reason')).toBe(reason);
    expect(refusal.textContent).toBe(message);
    // The request is read again after a refusal, and the decision stays open to try again.
    expect(screen.getByTestId('decide')).toBeTruthy();
  });

  it('shows the decided requests with the decision, who decided and the comment, when all states are asked for', async () => {
    const decided = request(R3, {
      status: 'DECIDED',
      decision: 'REJECTED',
      decided_by: { id: OTHER, name: 'Người duyệt' },
      comment: 'Sai mẫu số',
      version: 2,
    });
    const h = client({ requests: [request(R1), decided] });
    mount(<PublicationInboxScreen route={INBOX} />, h, {
      permissions: APPROVE,
    });
    const user = userEvent.setup();
    await screen.findByTestId('requests');
    await user.selectOptions(screen.getByLabelText(vi_['bi.pub.filter.status']), 'ALL');
    await waitFor(() => expect(h.readAll).toHaveBeenCalledWith('listBiPublicationRequests', {}));
    const row = (await screen.findAllByTestId('decision')).at(0) as HTMLElement;
    expect(row.textContent).toContain(
      fill(vi_['bi.pub.decided'], {
        decision: vi_['bi.pub.decision.rejected'],
        name: 'Người duyệt',
      }),
    );
    expect(row.textContent).toContain('Sai mẫu số');
    // A decided request has no review button.
    expect(within(document.querySelector(`[data-request="${R3}"]`) as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('gives a member without the right to decide the list and the form to ask, and a member who may only look neither', async () => {
    const h = client({ requests: [request(R1)] });
    mount(<PublicationInboxScreen route={INBOX} />, h, {
      permissions: [...ASK, 'bi.publish'],
    });
    await screen.findByTestId('requests');
    expect(screen.getByRole('form', { name: vi_['bi.pub.request.title'] })).toBeTruthy();
    cleanup();
    const asker = client({ requests: [request(R1)] });
    mount(<PublicationInboxScreen route={INBOX} />, asker, {
      permissions: ASK,
    });
    await screen.findByTestId('requests');
    expect(screen.queryByRole('button', { name: vi_['bi.pub.review'] })).toBeNull();
    expect(screen.getByRole('form', { name: vi_['bi.pub.request.title'] })).toBeTruthy();
    cleanup();
    const reader = client({ requests: [request(R1)] });
    mount(<PublicationInboxScreen route={INBOX} />, reader, {
      permissions: APPROVE,
      mode: 'READ_ONLY',
    });
    await screen.findByTestId('requests');
    expect(screen.queryByRole('button', { name: vi_['bi.pub.review'] })).toBeNull();
    expect(screen.queryByRole('form', { name: vi_['bi.pub.request.title'] })).toBeNull();
  });

  it('asks for the publication of an object after the checks of the id, and says that the request was sent', async () => {
    const h = client({ requests: [] }, () => ({
      operation_id: 'o',
      status: 'PENDING',
      resource_version: 1,
      resource_id: R1,
      checks: [],
    }));
    mount(<PublicationInboxScreen route={INBOX} />, h, { permissions: ASK });
    const user = userEvent.setup();
    const form = await screen.findByRole('form', {
      name: vi_['bi.pub.request.title'],
    });
    await user.click(within(form).getByRole('button', { name: vi_['bi.pub.request.submit'] }));
    expect(await within(form).findByText(vi_['bi.pub.request.object.required'])).toBeTruthy();
    await user.type(within(form).getByLabelText(vi_['bi.pub.request.object']), 'nope');
    await user.click(within(form).getByRole('button', { name: vi_['bi.pub.request.submit'] }));
    expect(await within(form).findByText(vi_['bi.pub.request.object.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.clear(within(form).getByLabelText(vi_['bi.pub.request.object']));
    await user.selectOptions(within(form).getByLabelText(vi_['bi.pub.request.kind']), 'ACCESS_POLICY');
    await user.type(within(form).getByLabelText(vi_['bi.pub.request.object']), OBJECT);
    await user.click(within(form).getByRole('button', { name: vi_['bi.pub.request.submit'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'submitBiPublication',
        expect.objectContaining({
          body: { object_kind: 'ACCESS_POLICY', object_id: OBJECT },
        }),
      ),
    );
    expect((await screen.findByTestId('asked')).textContent).toBe(vi_['bi.pub.request.saved']);
    expect((within(form).getByLabelText(vi_['bi.pub.request.object']) as HTMLInputElement).value).toBe('');
  });

  it('tells why a request was refused: a metric whose rerun failed, an object that already has one', async () => {
    const h = client({ requests: [] }, () => failure(422, 'REPRODUCIBILITY_CHECK_FAILED', 'GROUPS_ADD_UP'));
    mount(<PublicationInboxScreen route={INBOX} />, h, { permissions: ASK });
    const user = userEvent.setup();
    const form = await screen.findByRole('form', {
      name: vi_['bi.pub.request.title'],
    });
    await user.type(within(form).getByLabelText(vi_['bi.pub.request.object']), OBJECT);
    await user.click(within(form).getByRole('button', { name: vi_['bi.pub.request.submit'] }));
    const refusal = await screen.findByTestId('request-refusal');
    expect(refusal.getAttribute('data-reason')).toBe('reproduction');
    expect(refusal.textContent).toBe(
      fill(vi_['bi.pub.refusal.reproduction'], {
        check: vi_['bi.pub.check.groups'],
      }),
    );
  });

  it('says there is nothing to decide, and shows the failure of the list with a way to read it again', async () => {
    const h = client({ requests: [] });
    mount(<PublicationInboxScreen route={INBOX} />, h, {
      permissions: APPROVE,
    });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    expect(screen.queryByTestId('requests')).toBeNull();
    cleanup();
    const broken = client({ requests: failure(500, 'BOOM') });
    mount(<PublicationInboxScreen route={INBOX} />, broken, {
      permissions: APPROVE,
    });
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByTestId('requests')).toBeNull();
  });

  it('starts over when the member or the tenant changes: what was open is not carried to another', async () => {
    const h = client({ requests: [request(R1)] });
    const view = mount(<PublicationInboxScreen route={INBOX} />, h, {
      permissions: APPROVE,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: vi_['bi.pub.review'] }));
    expect(await screen.findByTestId('decide')).toBeTruthy();
    view.rerenderWith({
      permissions: APPROVE,
      tenant: {
        id: '00000000-0000-4000-8000-0000000000aa',
        name: 'Khác',
        membershipId: ME,
      } as never,
    });
    await waitFor(() => expect(screen.queryByTestId('decide')).toBeNull());
  });
});

describe('BI-10 comparison of two versions of a dashboard (ST-BI-006)', () => {
  const address = `/bi/bi-10?dashboard=${D1}`;
  const world = (overrides: World = {}): World => ({
    dashboards: [toRaw(dashboard([OLD, NEW]))],
    one: dashboard([NEW, OLD]),
    ...overrides,
  });
  function toRaw(value: Record<string, unknown>): Record<string, unknown> {
    const { versions: _versions, ...rest } = value;
    void _versions;
    return rest;
  }

  it('compares the two newest versions: the tiles added, removed and changed, the metrics by version and the settings', async () => {
    const h = client(world());
    mount(<DashboardCompareScreen route={COMPARE} />, h, { permissions: [...ASK, 'bi.dashboard.manage'] }, address);
    const tiles = await screen.findByTestId('tiles');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['bi.cmp.title']);
    expect((screen.getByLabelText(vi_['bi.cmp.newer']) as HTMLSelectElement).value).toBe(V2);
    expect((screen.getByLabelText(vi_['bi.cmp.older']) as HTMLSelectElement).value).toBe(V1);
    expect(
      within(tiles)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('data-change')),
    ).toEqual(['added', 'removed', 'changed']);
    expect(within(tiles).getByText(new RegExp('Tổng · .* · disbursed'))).toBeTruthy();
    expect(within(tiles).getByText(new RegExp(vi_['bi.cmp.field.kind']))).toBeTruthy();
    const metrics = screen.getByTestId('metrics');
    expect(
      within(metrics)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('data-change')),
    ).toEqual(['added', 'kept']);
    expect(within(metrics).getByText(`disbursement_rate · ${fill(vi_['bi.pub.revision'], { revision: 2 })}`)).toBeTruthy();
    const settings = within(screen.getByTestId('settings')).getAllByRole('listitem');
    expect(settings.map((item) => item.getAttribute('data-setting'))).toEqual(['breakpoint:md', 'pinned', 'policy']);
    expect(settings[0]?.textContent).toContain(fill(vi_['bi.cmp.setting.breakpoint'], { key: 'md' }));
    expect(settings[2]?.textContent).toContain(`${vi_['bi.dash.policy.latest']} → ${vi_['bi.dash.policy.pinned']}`);
  });

  it('lets the owner ask to publish the newer draft, once', async () => {
    const h = client(world(), () => ({
      operation_id: 'o',
      status: 'PENDING',
      resource_version: 1,
      resource_id: R1,
      checks: [],
    }));
    mount(<DashboardCompareScreen route={COMPARE} />, h, { permissions: ASK }, address);
    const user = userEvent.setup();
    const button = await screen.findByRole('button', {
      name: fill(vi_['bi.cmp.request'], { revision: 2 }),
    });
    await user.click(button);
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'submitBiPublication',
        expect.objectContaining({
          body: { object_kind: 'DASHBOARD', object_id: V2 },
        }),
      ),
    );
    expect((await screen.findByTestId('asked')).textContent).toBe(vi_['bi.cmp.asked']);
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('tells why the request was refused, next to the button', async () => {
    const h = client(world(), () => failure(422, 'METRIC_NOT_CERTIFIED', 'metric_versions'));
    mount(<DashboardCompareScreen route={COMPARE} />, h, { permissions: ASK }, address);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', {
        name: fill(vi_['bi.cmp.request'], { revision: 2 }),
      }),
    );
    const refusal = await screen.findByTestId('refusal');
    expect(refusal.getAttribute('data-reason')).toBe('notCertified');
    expect(refusal.textContent).toBe(vi_['bi.pub.refusal.notCertified']);
  });

  it('offers no request to someone who may not ask, to a dashboard that is not theirs or to a version that is not a draft', async () => {
    mount(<DashboardCompareScreen route={COMPARE} />, client(world()), { permissions: APPROVE }, address);
    await screen.findByTestId('tiles');
    expect(
      screen.queryByRole('button', {
        name: fill(vi_['bi.cmp.request'], { revision: 2 }),
      }),
    ).toBeNull();
    cleanup();
    mount(<DashboardCompareScreen route={COMPARE} />, client(world({ one: dashboard([NEW, OLD], { may_edit: false, mine: false }) })), { permissions: ASK }, address);
    await screen.findByTestId('tiles');
    expect(
      screen.queryByRole('button', {
        name: fill(vi_['bi.cmp.request'], { revision: 2 }),
      }),
    ).toBeNull();
    cleanup();
    const published = { ...NEW, status: 'PUBLISHED' };
    mount(<DashboardCompareScreen route={COMPARE} />, client(world({ one: dashboard([published, OLD]) })), { permissions: ASK }, address);
    await screen.findByTestId('tiles');
    expect(
      screen.queryByRole('button', {
        name: fill(vi_['bi.cmp.request'], { revision: 2 }),
      }),
    ).toBeNull();
    cleanup();
    mount(<DashboardCompareScreen route={COMPARE} />, client(world()), { permissions: ASK, mode: 'READ_ONLY' }, address);
    await screen.findByTestId('tiles');
    expect(
      screen.queryByRole('button', {
        name: fill(vi_['bi.cmp.request'], { revision: 2 }),
      }),
    ).toBeNull();
  });

  it('compares the versions that are picked, says when they are the same one or the same in content, and starts with the choice of a dashboard', async () => {
    const copy = { ...OLD, id: V3, revision: 3, status: 'DRAFT' };
    const h = client(world({ one: dashboard([copy, NEW, OLD]) }));
    mount(<DashboardCompareScreen route={COMPARE} />, h, { permissions: APPROVE }, address);
    const user = userEvent.setup();
    await screen.findByTestId('tiles');
    await user.selectOptions(screen.getByLabelText(vi_['bi.cmp.newer']), V3);
    await user.selectOptions(screen.getByLabelText(vi_['bi.cmp.older']), V1);
    expect((await screen.findByTestId('no-difference')).textContent).toBe(vi_['bi.cmp.same']);
    await user.selectOptions(screen.getByLabelText(vi_['bi.cmp.older']), V3);
    expect((await screen.findByTestId('same-version')).textContent).toBe(vi_['bi.cmp.sameVersion']);
    await user.selectOptions(screen.getByLabelText(vi_['bi.cmp.pick']), '');
    expect((await screen.findByTestId('pick-first')).textContent).toBe(vi_['bi.cmp.choose']);
  });

  it('needs two versions, and says when the dashboard cannot be read, while the metrics of the catalogue are named by their id if the catalogue fails', async () => {
    mount(<DashboardCompareScreen route={COMPARE} />, client(world({ one: dashboard([OLD]) })), { permissions: APPROVE }, address);
    expect((await screen.findByTestId('few')).textContent).toBe(vi_['bi.cmp.few']);
    cleanup();
    mount(<DashboardCompareScreen route={COMPARE} />, client(world({ one: failure(404, 'RESOURCE_NOT_FOUND') })), { permissions: APPROVE }, address);
    expect((await screen.findByTestId('read-failed')).textContent).toBe(vi_['bi.cmp.failed']);
    cleanup();
    mount(<DashboardCompareScreen route={COMPARE} />, client(world({ metrics: failure(403, 'SCOPE_DENIED') })), { permissions: APPROVE }, address);
    const metrics = await screen.findByTestId('metrics');
    expect(within(metrics).getByText(DISBURSED.id)).toBeTruthy();
    cleanup();
    mount(<DashboardCompareScreen route={COMPARE} />, client(world()), { permissions: APPROVE }, '/bi/bi-10');
    expect((await screen.findByTestId('pick-first')).textContent).toBe(vi_['bi.cmp.choose']);
    expect(screen.getByRole('link', { name: vi_['bi.cmp.inbox'] }).getAttribute('href')).toBe('/bi/bi-11');
  });

  it('shows the failure of the list of dashboards with a way to read it again', async () => {
    const broken = client(world());
    (broken.client as unknown as { readAll: unknown }).readAll = vi.fn(() => Promise.reject(failure(500, 'BOOM')));
    mount(<DashboardCompareScreen route={COMPARE} />, broken, { permissions: APPROVE }, address);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });
});

describe('the seven standard states of BI-10 and BI-11 (ST-BI-006)', () => {
  const offline = new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' });
  const states: Array<[string, unknown[] | Error, string]> = [
    ['empty', [], vi_['states.empty.title']],
    ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
    ['offline', offline, vi_['states.offline.title']],
    ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
    ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
  ];

  it.each(states)('UI-BI-11 shows the %s state', async (_name, requests, title) => {
    mount(<PublicationInboxScreen route={INBOX} />, client({ requests }), { permissions: APPROVE });
    expect(await screen.findByText(title)).toBeTruthy();
  });

  it.each(states)('UI-BI-10 shows the %s state', async (_name, dashboards, title) => {
    const h = client({});
    (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => (dashboards instanceof Error ? Promise.reject(dashboards) : Promise.resolve(dashboards)));
    mount(<DashboardCompareScreen route={COMPARE} />, h, { permissions: APPROVE });
    expect(await screen.findByText(title)).toBeTruthy();
  });

  it('UI-BI-11 and UI-BI-10 show the loading state first and name the page', () => {
    for (const [screenElement, name] of [
      [<PublicationInboxScreen key="inbox" route={INBOX} />, vi_['bi.pub.inbox.title']],
      [<DashboardCompareScreen key="compare" route={COMPARE} />, vi_['bi.cmp.title']],
    ] as const) {
      const h = harness(() => new Error('unexpected'));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(screenElement, h, { permissions: APPROVE });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name })).toBeTruthy();
      cleanup();
    }
  });

  it('UI-BI-11 retries after an error and then lists the requests', async () => {
    const world: World = { requests: failure(500, 'INTERNAL_ERROR') };
    mount(<PublicationInboxScreen route={INBOX} />, client(world), { permissions: APPROVE });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    world.requests = [request(R1)];
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    expect(await screen.findByTestId('requests')).toBeTruthy();
  });
});
