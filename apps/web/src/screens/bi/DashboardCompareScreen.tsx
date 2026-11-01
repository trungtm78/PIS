import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import { kindLabel as widgetKindLabel, policyLabel, versionStateLabel } from './dashboard-labels';
import { BUILDER_PATH, LIBRARY_PATH } from './dashboard-model';
import type { Dashboard, DashboardVersion, Widget } from './dashboard-model';
import { useDashboard, useDashboards, useMetrics, useSubmitPublication } from './hooks';
import { refusalMessage, settingLabel, tileFieldLabel } from './publication-labels';
import { INBOX_PATH, REQUEST_PERMISSION, compareVersions, describePublicationProblem, mayRequest } from './publication-model';
import '../dis/dis.css';

const NONE = '—';

/**
 * BI-10: the comparison of two versions of a dashboard (ST-BI-006, BI F5): the tiles added, removed and changed, the metrics each version names (by version) and the settings (columns, breakpoints, filters, the policy for
 * the datasets). The versions are fixed once saved, so what is shown is the difference between two facts. The owner asks to publish the newer draft from here; the approver decides in BI-11.
 */
export default function DashboardCompareScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <CompareContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function CompareContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const list = useDashboards();
  const metrics = useMetrics();
  const chosen = params.get('dashboard') ?? undefined;
  const dashboard = useDashboard(chosen);
  const state = useScreenState({
    isLoading: list.isLoading,
    error: list.error,
    data: list.data,
  });
  const codes = useMemo(() => new Map((metrics.data ?? []).map((metric) => [metric.id, `${metric.code} · ${t('bi.pub.revision', { revision: metric.revision })}`])), [metrics.data, t]);
  const metricName = (id: string): string => codes.get(id) ?? id;
  const pick = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(key);
    else next.set(key, value);
    // A change of dashboard drops the versions of the other one.
    if (key === 'dashboard') {
      next.delete('from');
      next.delete('to');
    }
    setParams(next, { replace: true });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <p className="back-link">
        <Link to={chosen === undefined ? LIBRARY_PATH : `${BUILDER_PATH}?dashboard=${chosen}`}>
          <span aria-hidden="true">← </span>
          {t('bi.cmp.back')}
        </Link>
      </p>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.cmp.title')}</h1>
          <p>{t('bi.cmp.subtitle')}</p>
        </div>
        <Link to={INBOX_PATH}>{t('bi.cmp.inbox')}</Link>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="mne-filters">
          <Field id="cmp-dashboard" label={t('bi.cmp.pick')} error={undefined}>
            <select id="cmp-dashboard" value={chosen ?? ''} onChange={(event) => pick('dashboard', event.target.value)}>
              <option value="">{NONE}</option>
              {(list.data ?? []).map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.code} · {candidate.title}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {chosen === undefined ? (
          <p className="card" data-testid="pick-first">
            {t('bi.cmp.choose')}
          </p>
        ) : dashboard.isError ? (
          <p className="callout warning" role="alert" data-testid="read-failed">
            {t('bi.cmp.failed')}
          </p>
        ) : dashboard.data === undefined ? (
          <p className="sub" role="status">
            {t('bi.cmp.loading')}
          </p>
        ) : (
          <Comparison
            dashboard={dashboard.data}
            from={params.get('from') ?? undefined}
            to={params.get('to') ?? undefined}
            onPick={pick}
            metricName={metricName}
            mayAsk={mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(REQUEST_PERMISSION))}
          />
        )}
      </StateBoundary>
      <p className="prototype-note">{t('bi.dash.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Comparison({
  dashboard,
  from,
  to,
  onPick,
  metricName,
  mayAsk,
}: {
  dashboard: Dashboard;
  from: string | undefined;
  to: string | undefined;
  onPick: (key: string, value: string) => void;
  metricName: (id: string) => string;
  mayAsk: boolean;
}) {
  const { t } = useTranslation();
  const versions = dashboard.versions;
  const newer: DashboardVersion | undefined = versions.find((version) => version.id === to) ?? versions[0];
  const older: DashboardVersion | undefined = versions.find((version) => version.id === from) ?? versions.find((version) => version.id !== newer?.id);
  if (newer === undefined || older === undefined) {
    return (
      <p className="card" data-testid="few">
        {t('bi.cmp.few')}
      </p>
    );
  }
  const diff = compareVersions(older, newer);
  const tileName = (widget: Widget): string => `${widget.title ?? widget.id} · ${widgetKindLabel(t, widget.kind)} · ${metricName(widget.metricVersionId)}`;
  const optionsOf = (): JSX.Element[] =>
    versions.map((version) => (
      <option key={version.id} value={version.id}>
        {t('bi.cmp.version', {
          revision: version.revision,
          state: versionStateLabel(t, version.status),
        })}
      </option>
    ));
  return (
    <>
      <div className="mne-filters">
        <Field id="cmp-older" label={t('bi.cmp.older')} error={undefined}>
          <select id="cmp-older" value={older.id} onChange={(event) => onPick('from', event.target.value)}>
            {optionsOf()}
          </select>
        </Field>
        <Field id="cmp-newer" label={t('bi.cmp.newer')} error={undefined}>
          <select id="cmp-newer" value={newer.id} onChange={(event) => onPick('to', event.target.value)}>
            {optionsOf()}
          </select>
        </Field>
      </div>
      {older.id === newer.id ? (
        <p className="callout" data-testid="same-version">
          {t('bi.cmp.sameVersion')}
        </p>
      ) : diff.same ? (
        <p className="callout" data-testid="no-difference">
          {t('bi.cmp.same')}
        </p>
      ) : (
        <>
          <section className="card" aria-labelledby="cmp-tiles" data-testid="tiles">
            <h2 id="cmp-tiles">{t('bi.cmp.tiles.title')}</h2>
            <ul>
              {diff.tilesAdded.map((widget) => (
                <li key={`a-${widget.id}`} data-change="added">
                  <span className="pill">{t('bi.cmp.tiles.added')}</span> {tileName(widget)}
                </li>
              ))}
              {diff.tilesRemoved.map((widget) => (
                <li key={`r-${widget.id}`} data-change="removed">
                  <span className="pill warn">{t('bi.cmp.tiles.removed')}</span> {tileName(widget)}
                </li>
              ))}
              {diff.tilesChanged.map((change) => (
                <li key={`c-${change.id}`} data-change="changed">
                  <span className="pill gray">{t('bi.cmp.tiles.changed')}</span> {tileName(change.after)} — {change.fields.map((field) => tileFieldLabel(t, field)).join(', ')}
                </li>
              ))}
            </ul>
          </section>
          <section className="card" aria-labelledby="cmp-metrics" data-testid="metrics">
            <h2 id="cmp-metrics">{t('bi.cmp.metrics.title')}</h2>
            <ul>
              {diff.metricsAdded.map((id) => (
                <li key={`a-${id}`} data-change="added">
                  <span className="pill">{t('bi.cmp.metrics.added')}</span> {metricName(id)}
                </li>
              ))}
              {diff.metricsRemoved.map((id) => (
                <li key={`r-${id}`} data-change="removed">
                  <span className="pill warn">{t('bi.cmp.metrics.removed')}</span> {metricName(id)}
                </li>
              ))}
              {diff.metricsKept.map((id) => (
                <li key={`k-${id}`} data-change="kept">
                  <span className="pill gray">{t('bi.cmp.metrics.kept')}</span> {metricName(id)}
                </li>
              ))}
            </ul>
          </section>
          <section className="card" aria-labelledby="cmp-settings" data-testid="settings">
            <h2 id="cmp-settings">{t('bi.cmp.settings.title')}</h2>
            {diff.settings.length === 0 ? (
              <p className="sub">{t('bi.cmp.settings.same')}</p>
            ) : (
              <ul>
                {diff.settings.map((change) => (
                  <li key={change.key} data-setting={change.key}>
                    {settingLabel(t, change.key)}: {change.key === 'policy' ? policyLabel(t, older.policy) : (change.before ?? NONE)} →{' '}
                    {change.key === 'policy' ? policyLabel(t, newer.policy) : (change.after ?? NONE)}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      {mayAsk && mayRequest(dashboard, newer) ? <RequestPublication key={newer.id} version={newer} /> : null}
    </>
  );
}

/** The owner asks to publish a draft: one request, and the answer (or the refusal) next to the button. */
function RequestPublication({ version }: { version: DashboardVersion }) {
  const { t } = useTranslation();
  const ask = useSubmitPublication();
  const refusal = ask.isError ? describePublicationProblem(ask.error) : undefined;
  return (
    <div className="card">
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="refusal" data-reason={refusal.reason}>
          {refusalMessage(t, refusal.reason, refusal.detail)}
        </p>
      )}
      {ask.isSuccess ? (
        <p className="callout" role="status" data-testid="asked">
          {t('bi.cmp.asked')}
        </p>
      ) : null}
      <button type="button" className="primary" disabled={ask.isPending || ask.isSuccess} onClick={() => ask.mutate({ kind: 'DASHBOARD', objectId: version.id })}>
        {t('bi.cmp.request', { revision: version.revision })}
      </button>
    </div>
  );
}
