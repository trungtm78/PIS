import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import type { Metric } from './bi-model';
import { kindLabel, policyLabel, refusalMessage, sideLabel, versionProblemMessage, versionStateLabel } from './dashboard-labels';
import { BREAKPOINTS, BREAKPOINT_RANGE, CHART_PATH, LIBRARY_PATH, MANAGE_DASHBOARD_PERMISSION, POLICIES, WIDGET_KINDS, describeDashboardProblem, formFrom, hasVersionProblems, nextKey, validateVersion, versionBody, widgetOfChart } from './dashboard-model';
import type { Dashboard, DashboardVersion, DatasetPolicy, VersionForm, WidgetForm, WidgetKind } from './dashboard-model';
import { useDashboard, useDashboards, useDatasetVersions, useDatasets, useMetrics, useSaveVersion } from './hooks';
import { COMPARE_PATH } from './publication-model';
import { SignOffBlock } from './SignOffBlock';
import { SectionCard } from '../../ui';
import './bi-kit.css';

const NONE = '—';

/**
 * BI-03: the builder of a dashboard (ST-BI-005, BI F5). A version is saved whole and never edited: the form starts from the version the dashboard points to, every tile is over a certified metric, the grid has twelve
 * columns and the tiles do not overlap, and the datasets are read at their latest frozen version or at the ones pinned here. The server judges again (a metric that is not certified is 422 and nothing is saved).
 */
export default function DashboardBuilderScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <BuilderContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BuilderContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const list = useDashboards();
  const metrics = useMetrics();
  const chosen = params.get('dashboard') ?? undefined;
  const dashboard = useDashboard(chosen);
  // The catalogue of metrics is a right of its own (`metric_definition.read`): a viewer who lacks it still sees the dashboard, and an editor whose read failed is told, and does not edit blind.
  const state = useScreenState({ isLoading: list.isLoading || metrics.isLoading, error: list.error, data: list.data });
  const failed = dashboard.isError && chosen !== undefined;
  // What the chart builder handed over is taken once, by the first editor that opens; the address is cleared of it then, so that a save and a new read do not add it again.
  const [handoff, setHandoff] = useState<Incoming | undefined>(() => (params.get('metric') === null ? undefined : { metric: params.get('metric'), kind: params.get('kind'), dimension: params.get('dimension') }));
  // The editor keeps what the person typed when the dashboard is read again; it starts over only when they ask for the latest.
  const [epoch, setEpoch] = useState(0);
  const consumed = (): void => {
    setHandoff(undefined);
    const next = new URLSearchParams(params);
    for (const key of ['metric', 'kind', 'dimension']) next.delete(key);
    setParams(next, { replace: true });
  };
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <p className="back-link">
        <Link to={LIBRARY_PATH}>
          <span aria-hidden="true">← </span>
          {t('bi.dash.back.link')}
        </Link>
      </p>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.dash.builder.title')}</h1>
          <p>{t('bi.dash.builder.subtitle')}</p>
        </div>
        <Link to={CHART_PATH}>{t('bi.dash.library.chart')}</Link>
      </div>
      <StateBoundary
        state={state}
        onRetry={() => {
          void list.refetch();
          void metrics.refetch();
        }}
      >
        <Field id="builder-dashboard" label={t('bi.dash.builder.pick')} error={undefined}>
          <select
            id="builder-dashboard"
            value={chosen ?? ''}
            onChange={(event) => {
              // What the chart builder handed over (a metric, a kind, a dimension) stays while another dashboard is picked.
              const next = new URLSearchParams(params);
              if (event.target.value === '') next.delete('dashboard');
              else next.set('dashboard', event.target.value);
              setParams(next);
            }}
          >
            <option value="">{NONE}</option>
            {(list.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {t('bi.dash.builder.option', { code: item.code, title: item.title })}
              </option>
            ))}
          </select>
        </Field>
        {metrics.isError ? (
          <p className="callout warning" role="alert" data-testid="metrics-failed">
            {t('bi.dash.builder.metricsFailed')}{' '}
            <button type="button" onClick={() => void metrics.refetch()}>
              {t('states.retry.action')}
            </button>
          </p>
        ) : null}
        {failed ? (
          <p className="callout warning" role="alert" data-testid="not-found">
            {refusalMessage(t, describeDashboardProblem(dashboard.error).reason)}
          </p>
        ) : null}
        {dashboard.data === undefined ? null : (
          <Editor
            key={`${dashboard.data.id}:${epoch}`}
            dashboard={dashboard.data}
            metrics={metrics.data ?? []}
            catalogueFailed={metrics.isError}
            incoming={handoff}
            onConsumed={consumed}
            onReload={() => setEpoch((value) => value + 1)}
          />
        )}
      </StateBoundary>
      <p className="prototype-note">{t('bi.dash.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface Incoming {
  metric: string | null;
  kind: string | null;
  dimension: string | null;
}

const isKind = (value: string | null): value is WidgetKind => value !== null && (WIDGET_KINDS as readonly string[]).includes(value);

function Editor({ dashboard, metrics, catalogueFailed, incoming, onConsumed, onReload }: { dashboard: Dashboard; metrics: Metric[]; catalogueFailed: boolean; incoming: Incoming | undefined; onConsumed: () => void; onReload: () => void }) {
  const { t } = useTranslation();
  const { mode, permissions } = useSession();
  const save = useSaveVersion();
  const latest: DashboardVersion | undefined = dashboard.versions[0];
  // The owner changes the dashboard, with the right to make dashboards (a save is refused without it).
  const mayEdit = dashboard.mayEdit && (permissions === undefined || permissions.includes(MANAGE_DASHBOARD_PERMISSION)) && mode !== 'READ_ONLY' && dashboard.status !== 'ARCHIVED' && !catalogueFailed;
  const [startFrom, setStartFrom] = useState(latest?.id ?? '');
  // The version of the dashboard the form was made on: a save is judged against it, not against what was read since (another person may have saved: the server says so, and the edits stay).
  const baseVersion = useRef(dashboard.version);
  const [form, setForm] = useState<VersionForm>(() => {
    const base = formFrom(latest);
    // The tile of the chart goes only into a draft that can be saved: a dashboard that is only seen keeps the handoff for the one that is picked next.
    const known = mayEdit && incoming !== undefined && incoming.metric !== null && metrics.some((metric) => metric.id === incoming.metric);
    return known && isKind(incoming.kind) ? { ...base, widgets: [...base.widgets, widgetOfChart({ metricVersionId: incoming.metric as string, kind: incoming.kind, dimensionCode: incoming.dimension ?? '' }, base.widgets, base.columns)] } : base;
  });
  const opened = useRef(false);
  useEffect(() => {
    // Once, when the editor opens.
    if (opened.current) return;
    opened.current = true;
    if (incoming !== undefined && mayEdit) onConsumed();
  }, [incoming, mayEdit, onConsumed]);
  const [attempted, setAttempted] = useState(false);
  const [saved, setSaved] = useState<number | undefined>(undefined);
  const metricIds = useMemo(() => new Set(metrics.map((metric) => metric.id)), [metrics]);
  const certified = useMemo(() => metrics.filter((metric) => metric.status === 'CERTIFIED' || form.widgets.some((widget) => widget.metricVersionId === metric.id)), [metrics, form.widgets]);
  const problems = attempted ? validateVersion(form, metricIds) : { widgets: {}, breakpoints: {}, filters: {} };
  const refusal = save.isError ? describeDashboardProblem(save.error) : undefined;
  const codeOf = (id: string): string => metrics.find((metric) => metric.id === id)?.code ?? id.slice(0, 8);

  const setWidget = (key: string, patch: Partial<WidgetForm>): void => {
    setSaved(undefined);
    setForm((value) => ({ ...value, widgets: value.widgets.map((widget) => (widget.key === key ? { ...widget, ...patch } : widget)) }));
  };
  const addWidget = (): void => {
    const first = certified.find((metric) => metric.status === 'CERTIFIED');
    if (first === undefined) return;
    setSaved(undefined);
    setForm((value) => ({ ...value, widgets: [...value.widgets, widgetOfChart({ metricVersionId: first.id, kind: 'BAR', dimensionCode: '' }, value.widgets, value.columns)] }));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (save.isPending || hasVersionProblems(validateVersion(form, metricIds))) return;
    save.mutate(
      { dashboardId: dashboard.id, version: baseVersion.current, body: versionBody(form) },
      {
        onSuccess: (done) => {
          const answer = done as { revision?: number; resource_version?: number };
          baseVersion.current = answer.resource_version ?? baseVersion.current + 1;
          setSaved(answer.revision);
        },
      },
    );
  };

  return (
    <div data-testid="editor" data-dashboard={dashboard.id}>
      <SectionCard title={t('bi.dash.builder.versions')}>
        {dashboard.versions.length === 0 ? (
          <p className="sub" data-testid="no-versions">
            {t('bi.dash.library.noVersion')}
          </p>
        ) : (
          <table className="table" data-testid="versions" aria-label={t('bi.dash.builder.versions')}>
            <thead>
              <tr>
                <th scope="col">{t('bi.dash.col.revision')}</th>
                <th scope="col">{t('bi.dash.col.state')}</th>
                <th scope="col">{t('bi.dash.col.tiles')}</th>
                <th scope="col">{t('bi.dash.col.policy')}</th>
                <th scope="col">{t('bi.dash.col.saved')}</th>
                <th scope="col">{t('bi.sign.col')}</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.versions.map((version) => (
                <tr key={version.id} data-version={version.id}>
                  <td>{version.revision}</td>
                  <td>{versionStateLabel(t, version.status)}</td>
                  <td>{version.widgets.length}</td>
                  <td>{policyLabel(t, version.policy)}</td>
                  <td>{version.createdAt}</td>
                  <td data-testid="version-sign">{t(`bi.sign.state.${version.signOff?.state ?? 'UNSIGNED'}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {dashboard.versions.length > 1 ? <Link to={`${COMPARE_PATH}?dashboard=${dashboard.id}`}>{t('bi.dash.builder.compare')}</Link> : null}
        <SignOffBlock signOff={dashboard.signOff} />
      </SectionCard>

      <SectionCard title={t('bi.dash.builder.preview')}>
        <div className="dash-grid" data-testid="preview" style={{ display: 'grid', gridTemplateColumns: `repeat(${form.columns}, 1fr)`, gap: 4 }}>
          {form.widgets.map((widget) => {
            const x = Number(widget.x);
            const y = Number(widget.y);
            const w = Number(widget.w);
            const h = Number(widget.h);
            const placed = [x, y, w, h].every((value) => Number.isInteger(value) && value >= 0) && w >= 1 && h >= 1;
            return (
              <div key={widget.key} className="card" data-widget={widget.id} data-kind={widget.kind} style={placed ? { gridColumn: `${x + 1} / span ${w}`, gridRow: `${y + 1} / span ${h}` } : undefined}>
                <strong>{widget.title.trim() === '' ? codeOf(widget.metricVersionId) : widget.title.trim()}</strong>
                <span className="sub"> {kindLabel(t, widget.kind)}</span>
              </div>
            );
          })}
        </div>
        <table className="table" data-testid="preview-table" aria-label={t('bi.dash.builder.previewTable')}>
          <thead>
            <tr>
              <th scope="col">{t('bi.dash.col.tile')}</th>
              <th scope="col">{t('bi.dash.col.kind')}</th>
              <th scope="col">{t('bi.dash.col.metric')}</th>
              <th scope="col">{t('bi.dash.col.place')}</th>
            </tr>
          </thead>
          <tbody>
            {form.widgets.map((widget) => (
              <tr key={widget.key}>
                <td>{widget.id}</td>
                <td>{kindLabel(t, widget.kind)}</td>
                <td>{codeOf(widget.metricVersionId)}</td>
                <td>{t('bi.dash.col.placeValue', { x: widget.x, y: widget.y, w: widget.w, h: widget.h })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>

      {mayEdit ? (
        <SectionCard title={t('bi.dash.builder.form')}>
        <form onSubmit={submit} noValidate aria-label={t('bi.dash.builder.form')}>
          <p className="sub">{t('bi.dash.builder.help')}</p>
          {saved === undefined ? null : (
            <p className="callout" role="status" data-testid="saved">
              {t('bi.dash.builder.saved', { revision: saved })}
            </p>
          )}
          {refusal === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="refusal" data-reason={refusal.reason}>
              {refusalMessage(t, refusal.reason)}
              {refusal.reason === 'conflict' ? (
                <>
                  {' '}
                  <button type="button" onClick={onReload}>
                    {t('bi.dash.builder.reload')}
                  </button>
                </>
              ) : null}
            </p>
          )}
          {problems.tooMany === undefined ? null : (
            <p className="field-error" role="alert">
              {versionProblemMessage(t, problems.tooMany)}
            </p>
          )}
          {dashboard.versions.length > 1 ? (
            <Field id="builder-start" label={t('bi.dash.builder.start')} error={undefined}>
              <select
                id="builder-start"
                value={startFrom}
                onChange={(event) => {
                  setStartFrom(event.target.value);
                  setSaved(undefined);
                  setForm(formFrom(dashboard.versions.find((version) => version.id === event.target.value)));
                }}
              >
                {dashboard.versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {t('bi.dash.builder.startOption', { revision: version.revision, state: versionStateLabel(t, version.status) })}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          <fieldset>
            <legend>{t('bi.dash.builder.tiles')}</legend>
            {form.widgets.map((widget, index) => {
              const list = problems.widgets[widget.key] ?? [];
              return (
                <div key={widget.key} className="formgrid" role="group" aria-label={t('bi.dash.tile.aria', { n: index + 1 })} data-tile={widget.key}>
                  <Field id={`tile-id-${widget.key}`} label={t('bi.dash.tile.id')} error={undefined}>
                    <input id={`tile-id-${widget.key}`} value={widget.id} aria-invalid={list.includes('widgetId') || list.includes('widgetIdTaken')} onChange={(event) => setWidget(widget.key, { id: event.target.value })} />
                  </Field>
                  <Field id={`tile-kind-${widget.key}`} label={t('bi.dash.tile.kind')} error={undefined}>
                    <select id={`tile-kind-${widget.key}`} value={widget.kind} onChange={(event) => setWidget(widget.key, { kind: event.target.value as WidgetKind, ...(event.target.value === 'KPI' ? { dimensionCode: '' } : {}) })}>
                      {WIDGET_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {kindLabel(t, kind)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field id={`tile-metric-${widget.key}`} label={t('bi.dash.tile.metric')} error={undefined}>
                    <select id={`tile-metric-${widget.key}`} value={widget.metricVersionId} onChange={(event) => setWidget(widget.key, { metricVersionId: event.target.value })}>
                      {certified.map((metric) => (
                        <option key={metric.id} value={metric.id}>
                          {t('bi.dash.tile.metricOption', { code: metric.code, revision: metric.revision })}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field id={`tile-dimension-${widget.key}`} label={t('bi.dash.tile.dimension')} error={undefined}>
                    <input id={`tile-dimension-${widget.key}`} value={widget.dimensionCode} disabled={widget.kind === 'KPI'} aria-invalid={list.includes('dimension')} onChange={(event) => setWidget(widget.key, { dimensionCode: event.target.value })} />
                  </Field>
                  <Field id={`tile-title-${widget.key}`} label={t('bi.dash.tile.title')} error={undefined}>
                    <input id={`tile-title-${widget.key}`} value={widget.title} aria-invalid={list.includes('title')} onChange={(event) => setWidget(widget.key, { title: event.target.value })} />
                  </Field>
                  {(['x', 'y', 'w', 'h'] as const).map((side) => (
                    <Field key={side} id={`tile-${side}-${widget.key}`} label={t('bi.dash.tile.side', { side: sideLabel(t, side) })} error={undefined}>
                      <input id={`tile-${side}-${widget.key}`} inputMode="numeric" value={widget[side]} aria-invalid={list.includes('grid')} onChange={(event) => setWidget(widget.key, { [side]: event.target.value })} />
                    </Field>
                  ))}
                  {list.map((problem) => (
                    <p key={problem} className="field-error" role="alert">
                      {versionProblemMessage(t, problem)}
                    </p>
                  ))}
                  <button type="button" onClick={() => setForm((value) => ({ ...value, widgets: value.widgets.filter((other) => other.key !== widget.key) }))}>
                    {t('bi.dash.tile.remove')}
                  </button>
                </div>
              );
            })}
            <button type="button" onClick={addWidget} disabled={!certified.some((metric) => metric.status === 'CERTIFIED')}>
              {t('bi.dash.tile.add')}
            </button>
          </fieldset>

          <fieldset>
            <legend>{t('bi.dash.builder.breakpoints')}</legend>
            {BREAKPOINTS.map((key) => (
              <Field key={key} id={`breakpoint-${key}`} label={t('bi.dash.breakpoint.label', { key })} error={problems.breakpoints[key] === undefined ? undefined : versionProblemMessage(t, problems.breakpoints[key] as never)} hint={t('bi.dash.breakpoint.hint', { min: BREAKPOINT_RANGE.min, max: BREAKPOINT_RANGE.max })}>
                <input id={`breakpoint-${key}`} inputMode="numeric" value={form.breakpoints[key]} aria-invalid={problems.breakpoints[key] !== undefined} onChange={(event) => setForm({ ...form, breakpoints: { ...form.breakpoints, [key]: event.target.value } })} />
              </Field>
            ))}
          </fieldset>

          <fieldset>
            <legend>{t('bi.dash.builder.filters')}</legend>
            {form.filters.map((row) => (
              <div key={row.key} className="formgrid" role="group" aria-label={t('bi.dash.filter.aria', { filter: row.filter })}>
                <Field id={`filter-name-${row.key}`} label={t('bi.dash.filter.name')} error={problems.filters[row.key] === undefined ? undefined : versionProblemMessage(t, problems.filters[row.key] as never)}>
                  <input id={`filter-name-${row.key}`} value={row.filter} aria-invalid={problems.filters[row.key] !== undefined} onChange={(event) => setForm({ ...form, filters: form.filters.map((other) => (other.key === row.key ? { ...other, filter: event.target.value } : other)) })} />
                </Field>
                <Field id={`filter-dimension-${row.key}`} label={t('bi.dash.filter.dimension')} error={undefined}>
                  <input id={`filter-dimension-${row.key}`} value={row.dimension} onChange={(event) => setForm({ ...form, filters: form.filters.map((other) => (other.key === row.key ? { ...other, dimension: event.target.value } : other)) })} />
                </Field>
                <button type="button" onClick={() => setForm({ ...form, filters: form.filters.filter((other) => other.key !== row.key) })}>
                  {t('bi.dash.filter.remove')}
                </button>
              </div>
            ))}
            <button type="button" onClick={() => setForm({ ...form, filters: [...form.filters, { key: nextKey(), filter: '', dimension: '' }] })}>
              {t('bi.dash.filter.add')}
            </button>
          </fieldset>

          <PolicyFields form={form} setForm={setForm} error={problems.pinned === undefined ? undefined : versionProblemMessage(t, problems.pinned)} />

          <div className="formfooter">
            <button type="submit" className="ui-button ui-button--primary" disabled={save.isPending}>
              {t('bi.dash.builder.submit')}
            </button>
          </div>
        </form>
        </SectionCard>
      ) : (
        <p className="callout" role="status" data-testid="read-only">
          {catalogueFailed && dashboard.mayEdit ? t('bi.dash.builder.metricsFailed') : t('bi.dash.builder.readOnly')}
        </p>
      )}
    </div>
  );
}

function PolicyFields({ form, setForm, error }: { form: VersionForm; setForm: (form: VersionForm) => void; error: string | undefined }) {
  const { t } = useTranslation();
  const datasets = useDatasets();
  const [datasetId, setDatasetId] = useState('');
  const versions = useDatasetVersions(datasetId === '' ? undefined : datasetId);
  const frozen = (versions.data ?? []).filter((version) => version.status === 'FROZEN');
  return (
    <fieldset>
      <legend>{t('bi.dash.builder.policy')}</legend>
      <Field id="policy" label={t('bi.dash.policy.label')} error={error}>
        <select id="policy" value={form.policy} onChange={(event) => setForm({ ...form, policy: event.target.value as DatasetPolicy, pinned: event.target.value === 'PINNED' ? form.pinned : [] })}>
          {POLICIES.map((policy) => (
            <option key={policy} value={policy}>
              {policyLabel(t, policy)}
            </option>
          ))}
        </select>
      </Field>
      {form.policy === 'PINNED' ? (
        <>
          <Field id="pin-dataset" label={t('bi.dash.pin.dataset')} error={undefined}>
            <select id="pin-dataset" value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
              <option value="">{NONE}</option>
              {(datasets.data ?? []).map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {dataset.code}
                </option>
              ))}
            </select>
          </Field>
          <ul data-testid="pin-options">
            {frozen.map((version) => (
              <li key={version.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={form.pinned.includes(version.id)}
                    onChange={(event) => setForm({ ...form, pinned: event.target.checked ? [...form.pinned, version.id] : form.pinned.filter((id) => id !== version.id) })}
                  />
                  {t('bi.dash.pin.option', { period: version.asOfPeriod })}
                </label>
              </li>
            ))}
          </ul>
          <p className="sub" data-testid="pinned-count">
            {t('bi.dash.pin.count', { count: form.pinned.length })}
          </p>
        </>
      ) : null}
    </fieldset>
  );
}
