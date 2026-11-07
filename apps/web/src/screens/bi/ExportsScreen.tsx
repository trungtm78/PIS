import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { exportProblemMessage, exportRefusalMessage, exportStatusLabel, formatLabel } from './export-labels';
import { EMPTY_EXPORT, EXPORT_FORMATS, EXPORT_PERMISSION, SCHEDULES_PATH, describeExportProblem, reasonOfJob, validateExport } from './export-model';
import type { Download, ExportForm, ExportFormat } from './export-model';
import { useDatasetVersions, useDatasets, useExportLink, useExports, useMetrics, useRequestExport } from './hooks';
import { linkOf } from '../ctr/export/model';
import { dimensionLabel } from './labels';
import { DIMENSIONS } from './query-model';
import './bi-kit.css';
import { StatusPill } from '../../ui';
import { exportStatusTone } from './tones';

const NONE = '—';
const day = (stamp: string): string => stamp.slice(0, 10);

/**
 * BI-16: the files of the exports (ST-BI-008, BI F7): the exports made for the person, each with the period and the snapshot it reads, the scope the person had when it ran, the format, the rows against the cap, the state and
 * when it expires. A file is READY with a link that the server gives only after judging the person again (a person whose scope changed, or who lost the right, gets none); a refusal is kept as a job with its reason.
 */
export default function ExportsScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <ExportsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ExportsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const mayExport = mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(EXPORT_PERMISSION));
  const list = useExports();
  const metrics = useMetrics();
  const datasets = useDatasets();
  const disbursement = (datasets.data ?? []).find((dataset) => dataset.sourceKind === 'PERIOD_SNAPSHOT');
  const versions = useDatasetVersions(disbursement?.id);
  const request = useRequestExport();
  const link = useExportLink();
  const certified = useMemo(() => (metrics.data ?? []).filter((metric) => metric.status === 'CERTIFIED'), [metrics.data]);
  const periods = useMemo(() => [...new Set((versions.data ?? []).filter((version) => version.status === 'FROZEN').map((version) => version.asOfPeriod))], [versions.data]);
  const [form, setForm] = useState<ExportForm>(EMPTY_EXPORT);
  const [attempted, setAttempted] = useState(false);
  const [saved, setSaved] = useState(false);
  const [download, setDownload] = useState<{ id: string; link: Download } | undefined>(undefined);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data });
  const chosen = { ...form, metricId: form.metricId !== '' ? form.metricId : (certified[0]?.id ?? ''), period: form.period !== '' ? form.period : (periods[0] ?? '') };
  const problems = attempted ? validateExport(chosen) : {};
  const refusal = request.isError ? describeExportProblem(request.error) : link.isError ? describeExportProblem(link.error) : undefined;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    setSaved(false);
    const found = validateExport(chosen);
    if (request.isPending || found.metric !== undefined || found.period !== undefined) return;
    link.reset();
    request.mutate(chosen, { onSuccess: () => setSaved(true) });
  };
  const fetchLink = (id: string): void => {
    request.reset();
    // The link is a path of the API: it is resolved against the base the web app calls the API on.
    link.mutate(id, { onSuccess: (found) => setDownload({ id, link: { ...found, url: linkOf(found.url, import.meta.env.VITE_API_BASE_URL ?? '') } }) });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.exp.title')}</h1>
          <p>{t('bi.exp.subtitle')}</p>
        </div>
        <Link to={SCHEDULES_PATH}>{t('bi.exp.schedules')}</Link>
      </div>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="refusal" data-reason={refusal}>
          {exportRefusalMessage(t, refusal)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="saved">
          {t('bi.exp.saved')}
        </p>
      ) : null}
      {download === undefined ? null : (
        <p className="callout" role="status" data-testid="link">
          <a href={download.link.url} download>
            {t('bi.exp.link.open')}
          </a>{' '}
          {t('bi.exp.link.expires', { at: download.link.expiresAt })}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <table className="table" data-testid="exports" aria-label={t('bi.exp.list.title')}>
          <thead>
            <tr>
              <th scope="col">{t('bi.exp.col.period')}</th>
              <th scope="col">{t('bi.exp.col.scope')}</th>
              <th scope="col">{t('bi.exp.col.format')}</th>
              <th scope="col">{t('bi.exp.col.rows')}</th>
              <th scope="col">{t('bi.exp.col.status')}</th>
              <th scope="col">{t('bi.exp.col.action')}</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((job) => {
              const reason = reasonOfJob(job.deniedReason);
              return (
                <tr key={job.id} data-export={job.id} data-status={job.status}>
                  <td>
                    {job.asOfPeriod}
                    <span className="sub"> · {job.snapshotId.slice(0, 8)}</span>
                    <p className="sub">{job.asked.dimension === null ? NONE : dimensionLabel(t, job.asked.dimension)}</p>
                  </td>
                  <td>{job.scopeDescription}</td>
                  <td>{formatLabel(t, job.format)}</td>
                  <td>{job.rowCount === null ? NONE : t('bi.exp.rows', { rows: job.rowCount, cap: job.rowCap })}</td>
                  <td>
                    <StatusPill tone={exportStatusTone(job.status)}>{exportStatusLabel(t, job.status)}</StatusPill>
                    {job.status === 'READY' && job.expiresAt !== null ? <p className="sub">{t('bi.exp.expires', { date: day(job.expiresAt) })}</p> : null}
                    {reason === undefined ? null : (
                      <p className="sub" data-testid="job-reason" data-reason={reason}>
                        {exportRefusalMessage(t, reason)}
                      </p>
                    )}
                  </td>
                  <td>
                    {job.status === 'READY' ? (
                      <button type="button" disabled={link.isPending} onClick={() => fetchLink(job.id)}>
                        {t('bi.exp.download')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </StateBoundary>
      {mayExport ? (
        <form className="card" onSubmit={submit} noValidate aria-label={t('bi.exp.form.title')}>
          <h2>{t('bi.exp.form.title')}</h2>
          <p className="sub">{t('bi.exp.form.help')}</p>
          <Field id="exp-metric" label={t('bi.exp.metric')} error={problems.metric === undefined ? undefined : exportProblemMessage(t, problems.metric)}>
            <select id="exp-metric" value={chosen.metricId} onChange={(event) => setForm({ ...form, metricId: event.target.value })}>
              {certified.map((metric) => (
                <option key={metric.id} value={metric.id}>
                  {metric.code}
                </option>
              ))}
            </select>
          </Field>
          <Field id="exp-period" label={t('bi.exp.period')} error={problems.period === undefined ? undefined : exportProblemMessage(t, problems.period)}>
            <select id="exp-period" value={chosen.period} onChange={(event) => setForm({ ...form, period: event.target.value })}>
              {periods.map((period) => (
                <option key={period} value={period}>
                  {period}
                </option>
              ))}
            </select>
          </Field>
          <Field id="exp-dimension" label={t('bi.exp.dimension')} error={undefined}>
            <select id="exp-dimension" value={form.dimension} onChange={(event) => setForm({ ...form, dimension: event.target.value })}>
              <option value="">{t('bi.exp.dimension.none')}</option>
              {DIMENSIONS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {dimensionLabel(t, candidate)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="exp-format" label={t('bi.exp.format')} error={undefined}>
            <select id="exp-format" value={form.format} onChange={(event) => setForm({ ...form, format: event.target.value as ExportFormat })}>
              {EXPORT_FORMATS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {formatLabel(t, candidate)}
                </option>
              ))}
            </select>
          </Field>
          <div className="formfooter">
            <button type="submit" className="ui-button ui-button--primary" disabled={request.isPending}>
              {t('bi.exp.submit')}
            </button>
          </div>
        </form>
      ) : null}
      <p className="prototype-note">{t('bi.dash.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
