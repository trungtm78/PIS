import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import ExportSchedulesScreen from './ExportSchedulesScreen';
import ExportsScreen from './ExportsScreen';
import {
  EMPTY_EXPORT,
  EMPTY_SCHEDULE,
  describeExportProblem,
  exportBody,
  reasonOfJob,
  recipientsOf,
  scheduleBody,
  toDownload,
  toExportJob,
  toSchedule,
  validateExport,
  validateSchedule,
} from './export-model';
import { rawMetric } from './test-support';

const EXPORTS = routeOf('BI-16', 'FR-BI-16');
const SCHEDULES = routeOf('BI-12', 'FR-BI-12');
const EXPORT_RIGHT = ['bi.export', 'bi.query', 'metric_definition.read'];
const SCHEDULE_RIGHT = ['bi.export.schedule', 'bi.query', 'metric_definition.read'];
const ME = '00000000-0000-4000-8000-000000000001'; // the member of the session of the test support
const J1 = '00000000-0000-4000-8000-0000000000a1';
const J2 = '00000000-0000-4000-8000-0000000000a2';
const J3 = '00000000-0000-4000-8000-0000000000a3';
const S1 = '00000000-0000-4000-8000-0000000000b1';
const R1 = '00000000-0000-4000-8000-0000000000c1';
const R2 = '00000000-0000-4000-8000-0000000000c2';
const DATASET = '00000000-0000-4000-8000-0000000000d1';
const SNAP = '00000000-0000-4000-8000-0000000000e1';
const failure = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });
const fill = (value: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, item]) => out.replace(`{${key}}`, String(item)), value);

const RATE = rawMetric({ id: '00000000-0000-4000-8000-0000000000f1', code: 'disbursement_rate', aggregation_type: 'ratio', unit: 'percent' });
const DRAFT = rawMetric({ id: '00000000-0000-4000-8000-0000000000f2', code: 't_draft', status: 'DRAFT', origin: 'TENANT_UI' });
const dataset = {
  id: DATASET,
  dataset_code: 'DS-DISB',
  title: 'DISB',
  source_kind: 'PERIOD_SNAPSHOT',
  grain: 'project',
  join_paths: {},
  refresh_policy: 'ON_SNAPSHOT_FROZEN',
  status: 'ACTIVE',
  latest_version: null,
};
const datasetVersion = (id: string, period: string, status = 'FROZEN') => ({
  id,
  dataset_id: DATASET,
  as_of_period: period,
  source_snapshot_id: null,
  built_at: '2026-11-01T01:00:00.000Z',
  row_count: 3,
  excluded_quarantine_rows: 0,
  quality_badge: 'PASSED',
  feeds_certified: true,
  status,
});

const job = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  requested_by: ME,
  subject: { id: ME, name: 'Tôi' },
  schedule_id: null,
  query_spec: { metric_version_id: RATE.id, dimensions: ['unit'] },
  as_of_period: '2026-10',
  snapshot_id: SNAP,
  scope_description: 'Toàn tỉnh',
  format: 'CSV',
  row_count: 12,
  row_cap: 100000,
  truncated: false,
  file_sha256: 'a'.repeat(64),
  status: 'READY',
  denied_reason: null,
  expires_at: '2026-11-08T01:00:00.000Z',
  created_at: '2026-11-01T01:00:00.000Z',
  version: 3,
  ...overrides,
});
const schedule = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  dashboard_id: null,
  query_spec: { metric_version_id: RATE.id, dimensions: ['unit'] },
  cron: '0 8 * * 1',
  timezone: 'Asia/Ho_Chi_Minh',
  format: 'XLSX',
  recipients: [R1, R2],
  status: 'ACTIVE',
  owner: { id: ME, name: 'Tôi' },
  last_run_at: '2026-11-02T01:00:00.000Z',
  created_at: '2026-10-01T01:00:00.000Z',
  version: 2,
  ...overrides,
});

interface World {
  jobs?: unknown[] | Error;
  schedules?: unknown[] | Error;
  metrics?: unknown[] | Error;
  versions?: unknown[];
  link?: Record<string, unknown> | Error;
}

function client(world: World, command: (operation: string, input: unknown) => unknown = () => ({ operation_id: 'o', status: 'READY', resource_version: 2, resource_id: J1 })) {
  const h = harness((operation) => (operation === 'getBiExport' ? (world.link ?? new Error('unexpected read')) : new Error(`unexpected read ${operation}`)), command);
  const readAll = vi.fn((operation: string) => {
    const result =
      operation === 'listBiExports'
        ? (world.jobs ?? [])
        : operation === 'listBiExportSchedules'
          ? (world.schedules ?? [])
          : operation === 'get_resources_metric_definition'
            ? (world.metrics ?? [RATE, DRAFT])
            : operation === 'listBiDatasets'
              ? [dataset]
              : operation === 'listBiDatasetVersions'
                ? (world.versions ?? [
                    datasetVersion(SNAP, '2026-10'),
                    datasetVersion('00000000-0000-4000-8000-0000000000e2', '2026-09'),
                    datasetVersion('00000000-0000-4000-8000-0000000000e3', '2026-11', 'BUILDING'),
                  ])
                : new Error(`unexpected readAll ${operation}`);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}

afterEach(cleanup);

describe('the model of the exports and their schedules (ST-BI-008)', () => {
  it('reads a job and a schedule, drops a row without an id and keeps what is missing as nothing', () => {
    expect(toExportJob(null)).toBeUndefined();
    expect(toExportJob({ status: 'READY' })).toBeUndefined();
    expect(toExportJob(job(J1))).toMatchObject({
      id: J1,
      status: 'READY',
      format: 'CSV',
      asOfPeriod: '2026-10',
      snapshotId: SNAP,
      rowCount: 12,
      rowCap: 100000,
      asked: { metricId: RATE.id, dimension: 'unit' },
      version: 3,
    });
    expect(toExportJob({ id: J2, status: 'NONSENSE', format: 'NONSENSE', query_spec: 'x' })).toMatchObject({
      status: 'QUEUED',
      format: 'CSV',
      rowCount: null,
      rowCap: 0,
      asked: { metricId: '', dimension: null },
      expiresAt: null,
      version: 1,
    });
    expect(toSchedule(null)).toBeUndefined();
    expect(toSchedule({ cron: 'x' })).toBeUndefined();
    expect(toSchedule(schedule(S1))).toMatchObject({
      id: S1,
      cron: '0 8 * * 1',
      format: 'XLSX',
      recipients: [R1, R2],
      status: 'ACTIVE',
      lastRunAt: '2026-11-02T01:00:00.000Z',
      asked: { dimension: 'unit' },
    });
    expect(toSchedule({ id: S1, format: 'NONSENSE', status: 'NONSENSE', recipients: 'x' })).toMatchObject({ format: 'CSV', status: 'ACTIVE', recipients: [], lastRunAt: null, dashboardId: null });
  });

  it('reads the link of a download only when the server gave one', () => {
    expect(toDownload(null)).toBeUndefined();
    expect(toDownload(job(J1))).toBeUndefined();
    expect(toDownload({ download: { url: '/bi/exports/x/file?sig=1', expires_at: '2026-11-01T01:05:00.000Z' } })).toEqual({ url: '/bi/exports/x/file?sig=1', expiresAt: '2026-11-01T01:05:00.000Z' });
    expect(toDownload({ download: { expires_at: 'x' } })).toBeUndefined();
  });

  it('checks the form of an export and writes the body of the contract', () => {
    expect(validateExport(EMPTY_EXPORT)).toEqual({ metric: 'metricRequired', period: 'periodRequired' });
    expect(validateExport({ ...EMPTY_EXPORT, metricId: RATE.id, period: ' 2026-10 ' })).toEqual({});
    expect(exportBody({ metricId: RATE.id, period: ' 2026-10 ', dimension: 'unit', format: 'XLSX' })).toEqual({
      query_spec: { metric_version_id: RATE.id, dimensions: ['unit'] },
      as_of_period: '2026-10',
      format: 'XLSX',
    });
    expect(exportBody({ metricId: RATE.id, period: '2026-10', dimension: '', format: 'CSV' }).query_spec.dimensions).toEqual([]);
  });

  it('checks the form of a schedule: the five fields of the cron and the recipients, each once', () => {
    expect(recipientsOf(` ${R1.toUpperCase()}, ${R2}\n${R1};; `)).toEqual([R1, R2]);
    expect(validateSchedule(EMPTY_SCHEDULE)).toEqual({ metric: 'metricRequired', cron: 'cronRequired', recipients: 'recipientsRequired' });
    expect(validateSchedule({ ...EMPTY_SCHEDULE, metricId: RATE.id, cron: '0 8 * *', recipients: R1 })).toEqual({ cron: 'cronFields' });
    expect(validateSchedule({ ...EMPTY_SCHEDULE, metricId: RATE.id, cron: '0 8 * * 1', recipients: `${R1} nope` })).toEqual({ recipients: 'recipientsInvalid' });
    const many = Array.from({ length: 501 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`).join(',');
    expect(validateSchedule({ ...EMPTY_SCHEDULE, metricId: RATE.id, cron: '0 8 * * 1', recipients: many })).toEqual({ recipients: 'recipientsMany' });
    expect(validateSchedule({ ...EMPTY_SCHEDULE, metricId: RATE.id, cron: ' 0 8 * * 1 ', recipients: R1 })).toEqual({});
    expect(scheduleBody({ metricId: RATE.id, dimension: 'fund_source', cron: ' 0 8 * * 1 ', format: 'LINK_ONLY', recipients: `${R2.toUpperCase()}\n${R2}` })).toEqual({
      query_spec: { metric_version_id: RATE.id, dimensions: ['fund_source'] },
      cron: '0 8 * * 1',
      format: 'LINK_ONLY',
      recipients: [R2],
    });
  });

  it.each([
    [failure(422, 'EXPORT_ROW_CAP_EXCEEDED'), 'rowCap'],
    [failure(403, 'ACCESS_POLICY_MISSING'), 'policy'],
    [failure(403, 'SCOPE_DENIED'), 'scope'],
    [failure(403, 'CLASSIFICATION_EXPORT_DENIED'), 'classification'],
    [failure(422, 'SNAPSHOT_NOT_FOUND'), 'noSnapshot'],
    [failure(422, 'METRIC_NOT_CERTIFIED'), 'notCertified'],
    [failure(422, 'DIMENSION_NOT_IN_DATASET'), 'dimension'],
    [failure(422, 'EXPORT_EXPIRED'), 'expired'],
    [failure(409, 'CRON_INVALID'), 'cron'],
    [failure(422, 'RECIPIENT_OUT_OF_TENANT'), 'recipient'],
    [failure(422, 'VALIDATION_FAILED'), 'invalid'],
    [failure(500, 'BOOM'), 'general'],
    [new Error('x'), 'general'],
  ])('names the reason of a refusal by the code of the server: %#', (error, reason) => {
    expect(describeExportProblem(error)).toBe(reason);
  });

  it('names the reason a job was refused by the code kept on it, and none for a job that was not', () => {
    expect(reasonOfJob(null)).toBeUndefined();
    expect(reasonOfJob('SCOPE_DENIED')).toBe('scope');
    expect(reasonOfJob('EXPORT_ROW_CAP_EXCEEDED')).toBe('rowCap');
    expect(reasonOfJob('SOMETHING')).toBe('general');
  });
});

describe('BI-16 the files of the exports (ST-BI-008)', () => {
  it('lists the exports with the period and snapshot, the scope, the format, the rows against the cap, the state and when it expires, and says why one was refused', async () => {
    const h = client({
      jobs: [
        job(J1),
        job(J2, {
          status: 'DENIED',
          denied_reason: 'EXPORT_ROW_CAP_EXCEEDED',
          row_count: null,
          expires_at: null,
          file_sha256: null,
          format: 'PDF',
          scope_description: 'Theo phạm vi được cấp của người nhận',
        }),
        job(J3, { status: 'EXPIRED', query_spec: { metric_version_id: RATE.id }, format: 'XLSX' }),
      ],
    });
    mount(<ExportsScreen route={EXPORTS} />, h, { permissions: EXPORT_RIGHT });
    const table = await screen.findByTestId('exports');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['bi.exp.title']);
    expect((rows[0] as HTMLElement).textContent).toContain('2026-10');
    expect((rows[0] as HTMLElement).textContent).toContain(SNAP.slice(0, 8));
    expect((rows[0] as HTMLElement).textContent).toContain(vi_['bi.query.dimension.unit']);
    expect((rows[0] as HTMLElement).textContent).toContain('Toàn tỉnh');
    expect((rows[0] as HTMLElement).textContent).toContain(fill(vi_['bi.exp.rows'], { rows: 12, cap: 100000 }));
    expect((rows[0] as HTMLElement).textContent).toContain(fill(vi_['bi.exp.expires'], { date: '2026-11-08' }));
    expect(within(rows[0] as HTMLElement).getByText(vi_['bi.exp.status.ready'])).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: vi_['bi.exp.download'] })).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByTestId('job-reason').textContent).toBe(vi_['bi.exp.refusal.rowCap']);
    expect(within(rows[1] as HTMLElement).getByText(vi_['bi.exp.format.pdf'])).toBeTruthy();
    expect((rows[1] as HTMLElement).textContent).toContain('—');
    expect(within(rows[1] as HTMLElement).queryByRole('button')).toBeNull();
    expect(within(rows[2] as HTMLElement).getByText(vi_['bi.exp.status.expired'])).toBeTruthy();
    expect(within(rows[2] as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('gets the link of a file at the moment of the download, and shows it with when it ends', async () => {
    const h = client({ jobs: [job(J1)], link: { ...job(J1), download: { url: `/bi/exports/${J1}/file?tenant=t&expires=1&signature=s`, expires_at: '2026-11-01T01:05:00.000Z' } } });
    mount(<ExportsScreen route={EXPORTS} />, h, { permissions: EXPORT_RIGHT });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: vi_['bi.exp.download'] }));
    const shown = await screen.findByTestId('link');
    expect(within(shown).getByRole('link', { name: vi_['bi.exp.link.open'] }).getAttribute('href')).toBe(`/bi/exports/${J1}/file?tenant=t&expires=1&signature=s`);
    expect(shown.textContent).toContain(fill(vi_['bi.exp.link.expires'], { at: '2026-11-01T01:05:00.000Z' }));
    expect(h.read).toHaveBeenCalledWith('getBiExport', expect.objectContaining({ path: { id: J1 } }));
  });

  it('resolves the link of a file against the base the web app calls the API on', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '/api/');
    try {
      const h = client({ jobs: [job(J1)], link: { ...job(J1), download: { url: `/bi/exports/${J1}/file?tenant=t&expires=1&signature=s`, expires_at: '2026-11-01T01:05:00.000Z' } } });
      mount(<ExportsScreen route={EXPORTS} />, h, { permissions: EXPORT_RIGHT });
      await userEvent.setup().click(await screen.findByRole('button', { name: vi_['bi.exp.download'] }));
      expect(
        within(await screen.findByTestId('link'))
          .getByRole('link', { name: vi_['bi.exp.link.open'] })
          .getAttribute('href'),
      ).toBe(`/api/bi/exports/${J1}/file?tenant=t&expires=1&signature=s`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    [failure(403, 'SCOPE_DENIED'), 'scope', vi_['bi.exp.refusal.scope']],
    [failure(422, 'EXPORT_EXPIRED'), 'expired', vi_['bi.exp.refusal.expired']],
    [new Error('the export has no file'), 'general', vi_['bi.exp.refusal.general']],
  ])('tells why no link was given: %#', async (error, reason, message) => {
    const h = client({ jobs: [job(J1)], link: error instanceof ApiError ? error : { ...job(J1) } });
    mount(<ExportsScreen route={EXPORTS} />, h, { permissions: EXPORT_RIGHT });
    await userEvent.setup().click(await screen.findByRole('button', { name: vi_['bi.exp.download'] }));
    const refusal = await screen.findByTestId('refusal');
    expect(refusal.getAttribute('data-reason')).toBe(reason);
    expect(refusal.textContent).toBe(message);
    expect(screen.queryByTestId('link')).toBeNull();
  });

  it('asks for an export with the certified metrics, the frozen periods and the dimensions, and says that it was made', async () => {
    const h = client({ jobs: [job(J1)] }, () => ({ operation_id: 'o', status: 'READY', resource_version: 2, resource_id: J1, row_count: 12 }));
    mount(<ExportsScreen route={EXPORTS} />, h, { permissions: EXPORT_RIGHT });
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.exp.form.title'] });
    await waitFor(() =>
      expect(
        within(within(form).getByLabelText(vi_['bi.exp.metric']))
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['disbursement_rate']),
    );
    await waitFor(() =>
      expect(
        within(within(form).getByLabelText(vi_['bi.exp.period']))
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['2026-10', '2026-09']),
    );
    await user.selectOptions(within(form).getByLabelText(vi_['bi.exp.dimension']), 'fund_source');
    await user.selectOptions(within(form).getByLabelText(vi_['bi.exp.format']), 'XLSX');
    await user.selectOptions(within(form).getByLabelText(vi_['bi.exp.period']), '2026-09');
    await user.click(within(form).getByRole('button', { name: vi_['bi.exp.submit'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'requestBiExport',
        expect.objectContaining({ body: { query_spec: { metric_version_id: RATE.id, dimensions: ['fund_source'] }, as_of_period: '2026-09', format: 'XLSX' } }),
      ),
    );
    expect((await screen.findByTestId('saved')).textContent).toBe(vi_['bi.exp.saved']);
  });

  it('asks the metric and the period first when the catalogue has none, and sends nothing', async () => {
    const h = client({ jobs: [job(J1)], metrics: [DRAFT], versions: [] });
    mount(<ExportsScreen route={EXPORTS} />, h, { permissions: EXPORT_RIGHT });
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.exp.form.title'] });
    await user.click(within(form).getByRole('button', { name: vi_['bi.exp.submit'] }));
    expect(await within(form).findByText(vi_['bi.exp.problem.metric'])).toBeTruthy();
    expect(within(form).getByText(vi_['bi.exp.problem.period'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it.each([
    [failure(422, 'EXPORT_ROW_CAP_EXCEEDED'), 'rowCap', vi_['bi.exp.refusal.rowCap']],
    [failure(403, 'ACCESS_POLICY_MISSING'), 'policy', vi_['bi.exp.refusal.policy']],
    [failure(403, 'CLASSIFICATION_EXPORT_DENIED'), 'classification', vi_['bi.exp.refusal.classification']],
    [failure(422, 'SNAPSHOT_NOT_FOUND'), 'noSnapshot', vi_['bi.exp.refusal.noSnapshot']],
    [failure(422, 'METRIC_NOT_CERTIFIED'), 'notCertified', vi_['bi.exp.refusal.notCertified']],
    [failure(422, 'DIMENSION_NOT_IN_DATASET'), 'dimension', vi_['bi.exp.refusal.dimension']],
    [failure(422, 'VALIDATION_FAILED'), 'invalid', vi_['bi.exp.refusal.invalid']],
    [failure(500, 'BOOM'), 'general', vi_['bi.exp.refusal.general']],
  ])('tells why the server refused an export: %#', async (error, reason, message) => {
    const h = client({ jobs: [job(J1)] }, () => error);
    mount(<ExportsScreen route={EXPORTS} />, h, { permissions: EXPORT_RIGHT });
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.exp.form.title'] });
    await waitFor(() => expect(within(form).getByLabelText(vi_['bi.exp.period'])).toBeTruthy());
    await user.click(within(form).getByRole('button', { name: vi_['bi.exp.submit'] }));
    const refusal = await screen.findByTestId('refusal');
    expect(refusal.getAttribute('data-reason')).toBe(reason);
    expect(refusal.textContent).toBe(message);
    expect(screen.queryByTestId('saved')).toBeNull();
  });

  it('gives no form to a member who may not export or to a read-only session, and leads to the schedules', async () => {
    mount(<ExportsScreen route={EXPORTS} />, client({ jobs: [job(J1)] }), { permissions: ['bi.query'] });
    await screen.findByTestId('exports');
    expect(screen.queryByRole('form', { name: vi_['bi.exp.form.title'] })).toBeNull();
    expect(screen.getByRole('link', { name: vi_['bi.exp.schedules'] }).getAttribute('href')).toBe('/bi/bi-12');
    cleanup();
    mount(<ExportsScreen route={EXPORTS} />, client({ jobs: [job(J1)] }), { permissions: EXPORT_RIGHT, mode: 'READ_ONLY' });
    await screen.findByTestId('exports');
    expect(screen.queryByRole('form', { name: vi_['bi.exp.form.title'] })).toBeNull();
  });

  it('starts over when the member or the tenant changes: what was chosen is not carried to another', async () => {
    const h = client({ jobs: [job(J1)], link: { ...job(J1), download: { url: '/x', expires_at: 'z' } } });
    const view = mount(<ExportsScreen route={EXPORTS} />, h, { permissions: EXPORT_RIGHT });
    await userEvent.setup().click(await screen.findByRole('button', { name: vi_['bi.exp.download'] }));
    expect(await screen.findByTestId('link')).toBeTruthy();
    view.rerenderWith({ permissions: EXPORT_RIGHT, tenant: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Khác', membershipId: ME } as never });
    await waitFor(() => expect(screen.queryByTestId('link')).toBeNull());
  });
});

describe('BI-12 the schedules of the exports (ST-BI-008)', () => {
  it('lists the schedules with what they make, the cron and its zone, the format, the recipients and the last run, and tells that every recipient has their own scope', async () => {
    const h = client({
      schedules: [
        schedule(S1),
        schedule('00000000-0000-4000-8000-0000000000b2', { last_run_at: null, status: 'PAUSED', format: 'LINK_ONLY', query_spec: { metric_version_id: 'unknown' }, recipients: [R1] }),
      ],
    });
    mount(<ExportSchedulesScreen route={SCHEDULES} />, h, { permissions: SCHEDULE_RIGHT });
    const table = await screen.findByTestId('schedules');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId('scope-note').textContent).toBe(vi_['bi.sch.scopeNote']);
    expect((rows[0] as HTMLElement).textContent).toContain('0 8 * * 1');
    expect((rows[0] as HTMLElement).textContent).toContain('Asia/Ho_Chi_Minh');
    expect((rows[0] as HTMLElement).textContent).toContain('disbursement_rate');
    expect((rows[0] as HTMLElement).textContent).toContain(vi_['bi.query.dimension.unit']);
    expect((rows[0] as HTMLElement).textContent).toContain(fill(vi_['bi.sch.recipients.count'], { count: 2 }));
    expect((rows[0] as HTMLElement).textContent).toContain('2026-11-02 01:00');
    expect(within(rows[0] as HTMLElement).getByText(vi_['bi.sch.state.active'])).toBeTruthy();
    expect((rows[1] as HTMLElement).textContent).toContain(vi_['bi.sch.last.never']);
    expect((rows[1] as HTMLElement).textContent).toContain('unknown');
    expect(within(rows[1] as HTMLElement).getByText(vi_['bi.sch.state.paused'])).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(vi_['bi.exp.format.link'])).toBeTruthy();
    expect(screen.getByRole('link', { name: vi_['bi.sch.exports'] }).getAttribute('href')).toBe('/bi/bi-16');
  });

  it('makes a schedule after the checks of the cron and the recipients, and clears the form', async () => {
    const h = client({ schedules: [schedule(S1)] }, () => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: S1 }));
    mount(<ExportSchedulesScreen route={SCHEDULES} />, h, { permissions: SCHEDULE_RIGHT });
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.sch.form.title'] });
    await user.click(within(form).getByRole('button', { name: vi_['bi.sch.submit'] }));
    expect(await within(form).findByText(vi_['bi.sch.problem.cronRequired'])).toBeTruthy();
    expect(within(form).getByText(vi_['bi.sch.problem.recipientsRequired'])).toBeTruthy();
    await user.type(within(form).getByLabelText(vi_['bi.sch.cron']), '0 8 * *');
    await user.type(within(form).getByLabelText(vi_['bi.sch.recipients']), 'nope');
    await user.click(within(form).getByRole('button', { name: vi_['bi.sch.submit'] }));
    expect(await within(form).findByText(vi_['bi.sch.problem.cronFields'])).toBeTruthy();
    expect(within(form).getByText(vi_['bi.sch.problem.recipientsInvalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['bi.sch.cron']), ' 1');
    await user.clear(within(form).getByLabelText(vi_['bi.sch.recipients']));
    await user.type(within(form).getByLabelText(vi_['bi.sch.recipients']), `${R1},${R2}`);
    await user.selectOptions(within(form).getByLabelText(vi_['bi.exp.dimension']), 'unit');
    await user.selectOptions(within(form).getByLabelText(vi_['bi.exp.format']), 'LINK_ONLY');
    await user.click(within(form).getByRole('button', { name: vi_['bi.sch.submit'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'createBiExportSchedule',
        expect.objectContaining({ body: { query_spec: { metric_version_id: RATE.id, dimensions: ['unit'] }, cron: '0 8 * * 1', format: 'LINK_ONLY', recipients: [R1, R2] } }),
      ),
    );
    expect((await screen.findByTestId('saved')).textContent).toBe(vi_['bi.sch.saved']);
    expect((within(form).getByLabelText(vi_['bi.sch.cron']) as HTMLInputElement).value).toBe('');
    expect((within(form).getByLabelText(vi_['bi.sch.recipients']) as HTMLTextAreaElement).value).toBe('');
  });

  it.each([
    [failure(409, 'CRON_INVALID', 'minute'), 'cron', vi_['bi.exp.refusal.cron']],
    [failure(422, 'RECIPIENT_OUT_OF_TENANT'), 'recipient', vi_['bi.exp.refusal.recipient']],
    [failure(422, 'METRIC_NOT_CERTIFIED'), 'notCertified', vi_['bi.exp.refusal.notCertified']],
    [failure(500, 'BOOM'), 'general', vi_['bi.exp.refusal.general']],
  ])('tells why the server refused a schedule: %#', async (error, reason, message) => {
    const h = client({ schedules: [schedule(S1)] }, () => error);
    mount(<ExportSchedulesScreen route={SCHEDULES} />, h, { permissions: SCHEDULE_RIGHT });
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: vi_['bi.sch.form.title'] });
    await waitFor(() => expect(within(within(form).getByLabelText(vi_['bi.exp.metric'])).getAllByRole('option')).toHaveLength(1));
    await user.type(within(form).getByLabelText(vi_['bi.sch.cron']), '0 8 * * 1');
    await user.type(within(form).getByLabelText(vi_['bi.sch.recipients']), R1);
    await user.click(within(form).getByRole('button', { name: vi_['bi.sch.submit'] }));
    const refusal = await screen.findByTestId('refusal');
    expect(refusal.getAttribute('data-reason')).toBe(reason);
    expect(refusal.textContent).toBe(message);
    expect(screen.queryByTestId('saved')).toBeNull();
  });

  it('gives no form to a member who may not schedule or to a read-only session', async () => {
    mount(<ExportSchedulesScreen route={SCHEDULES} />, client({ schedules: [schedule(S1)] }), { permissions: ['bi.query'] });
    await screen.findByTestId('schedules');
    expect(screen.queryByRole('form', { name: vi_['bi.sch.form.title'] })).toBeNull();
    cleanup();
    mount(<ExportSchedulesScreen route={SCHEDULES} />, client({ schedules: [schedule(S1)] }), { permissions: SCHEDULE_RIGHT, mode: 'READ_ONLY' });
    await screen.findByTestId('schedules');
    expect(screen.queryByRole('form', { name: vi_['bi.sch.form.title'] })).toBeNull();
  });

  it('starts over when the member or the tenant changes: what was typed is not carried to another', async () => {
    const view = mount(<ExportSchedulesScreen route={SCHEDULES} />, client({ schedules: [schedule(S1)] }), { permissions: SCHEDULE_RIGHT });
    const form = await screen.findByRole('form', { name: vi_['bi.sch.form.title'] });
    await userEvent.setup().type(within(form).getByLabelText(vi_['bi.sch.cron']), '0 8');
    view.rerenderWith({ permissions: SCHEDULE_RIGHT, tenant: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Khác', membershipId: ME } as never });
    await waitFor(() => expect((screen.getByLabelText(vi_['bi.sch.cron']) as HTMLInputElement).value).toBe(''));
  });
});

describe('the seven standard states of BI-12 and BI-16 (ST-BI-008)', () => {
  const offline = new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' });
  const states: Array<[string, unknown[] | Error, string]> = [
    ['empty', [], vi_['states.empty.title']],
    ['denied', failure(403, 'SCOPE_DENIED'), vi_['states.denied.title']],
    ['offline', offline, vi_['states.offline.title']],
    ['error', failure(500, 'INTERNAL_ERROR'), vi_['states.error.title']],
    ['signed out', failure(401, 'SESSION_EXPIRED'), vi_['states.signedOut.title']],
  ];

  it.each(states)('UI-BI-16 shows the %s state', async (_name, jobs, title) => {
    mount(<ExportsScreen route={EXPORTS} />, client({ jobs }), { permissions: EXPORT_RIGHT });
    expect(await screen.findByText(title)).toBeTruthy();
  });

  it.each(states)('UI-BI-12 shows the %s state', async (_name, schedules, title) => {
    mount(<ExportSchedulesScreen route={SCHEDULES} />, client({ schedules }), { permissions: SCHEDULE_RIGHT });
    expect(await screen.findByText(title)).toBeTruthy();
  });

  it('UI-BI-16 and UI-BI-12 show the loading state first and name the page', () => {
    for (const [element, name] of [
      [<ExportsScreen key="exports" route={EXPORTS} />, vi_['bi.exp.title']],
      [<ExportSchedulesScreen key="schedules" route={SCHEDULES} />, vi_['bi.sch.title']],
    ] as const) {
      const h = harness(() => new Error('unexpected'));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(element, h, { permissions: [...EXPORT_RIGHT, 'bi.export.schedule'] });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name })).toBeTruthy();
      cleanup();
    }
  });

  it('UI-BI-16 retries after an error and then lists the exports', async () => {
    const world: World = { jobs: failure(500, 'INTERNAL_ERROR') };
    mount(<ExportsScreen route={EXPORTS} />, client(world), { permissions: EXPORT_RIGHT });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    world.jobs = [job(J1)];
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    expect(await screen.findByTestId('exports')).toBeTruthy();
  });

  it('UI-BI-12 retries after an error and then lists the schedules', async () => {
    const world: World = { schedules: failure(500, 'INTERNAL_ERROR') };
    mount(<ExportSchedulesScreen route={SCHEDULES} />, client(world), { permissions: SCHEDULE_RIGHT });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    world.schedules = [schedule(S1)];
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    expect(await screen.findByTestId('schedules')).toBeTruthy();
  });
});
