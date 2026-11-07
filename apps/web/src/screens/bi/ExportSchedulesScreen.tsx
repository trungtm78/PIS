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
import { exportRefusalMessage, formatLabel, scheduleProblemMessage, scheduleStateLabel } from './export-labels';
import { EMPTY_SCHEDULE, EXPORTS_PATH, SCHEDULE_FORMATS, SCHEDULE_PERMISSION, describeExportProblem, validateSchedule } from './export-model';
import type { ScheduleForm, ScheduleFormat } from './export-model';
import { useCreateSchedule, useMetrics, useSchedules } from './hooks';
import { dimensionLabel } from './labels';
import { DIMENSIONS } from './query-model';
import './bi-kit.css';
import { StatusPill } from '../../ui';
import { scheduleStateTone } from './tones';

const NONE = '—';

/**
 * BI-12: the schedules of the exports (ST-BI-008, BI F7): when a file is made (a cron, in the time of Vietnam), in which format and for whom. Each run makes one file for each recipient under the scope that recipient has
 * then, so two recipients of one schedule receive different figures, and a recipient who lost the right receives nothing. A schedule that only sends the link keeps the file behind the sign-in.
 */
export default function ExportSchedulesScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <SchedulesContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function SchedulesContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const may = mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(SCHEDULE_PERMISSION));
  const list = useSchedules();
  const metrics = useMetrics();
  const create = useCreateSchedule();
  const certified = useMemo(() => (metrics.data ?? []).filter((metric) => metric.status === 'CERTIFIED'), [metrics.data]);
  const [form, setForm] = useState<ScheduleForm>(EMPTY_SCHEDULE);
  const [attempted, setAttempted] = useState(false);
  const [saved, setSaved] = useState(false);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data });
  const chosen = { ...form, metricId: form.metricId !== '' ? form.metricId : (certified[0]?.id ?? '') };
  const problems = attempted ? validateSchedule(chosen) : {};
  const refusal = create.isError ? describeExportProblem(create.error) : undefined;
  const codeOf = (id: string): string => certified.find((metric) => metric.id === id)?.code ?? (metrics.data ?? []).find((metric) => metric.id === id)?.code ?? id;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    setSaved(false);
    const found = validateSchedule(chosen);
    if (create.isPending || found.metric !== undefined || found.cron !== undefined || found.recipients !== undefined) return;
    create.mutate(chosen, {
      onSuccess: () => {
        setForm({ ...EMPTY_SCHEDULE, metricId: form.metricId });
        setAttempted(false);
        setSaved(true);
      },
    });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.sch.title')}</h1>
          <p>{t('bi.sch.subtitle')}</p>
        </div>
        <Link to={EXPORTS_PATH}>{t('bi.sch.exports')}</Link>
      </div>
      <p className="callout" data-testid="scope-note">
        {t('bi.sch.scopeNote')}
      </p>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="refusal" data-reason={refusal}>
          {exportRefusalMessage(t, refusal)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="saved">
          {t('bi.sch.saved')}
        </p>
      ) : null}
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <table className="table" data-testid="schedules" aria-label={t('bi.sch.list.title')}>
          <thead>
            <tr>
              <th scope="col">{t('bi.sch.col.what')}</th>
              <th scope="col">{t('bi.sch.col.cron')}</th>
              <th scope="col">{t('bi.sch.col.format')}</th>
              <th scope="col">{t('bi.sch.col.recipients')}</th>
              <th scope="col">{t('bi.sch.col.last')}</th>
              <th scope="col">{t('bi.sch.col.state')}</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((schedule) => (
              <tr key={schedule.id} data-schedule={schedule.id} data-status={schedule.status}>
                <td>
                  {codeOf(schedule.asked.metricId)}
                  <p className="sub">{schedule.asked.dimension === null ? NONE : dimensionLabel(t, schedule.asked.dimension)}</p>
                </td>
                <td>
                  <code>{schedule.cron}</code>
                  <p className="sub">{schedule.timezone}</p>
                </td>
                <td>{formatLabel(t, schedule.format)}</td>
                <td>{t('bi.sch.recipients.count', { count: schedule.recipients.length })}</td>
                <td>{schedule.lastRunAt === null ? t('bi.sch.last.never') : schedule.lastRunAt.slice(0, 16).replace('T', ' ')}</td>
                <td>
                  <StatusPill tone={scheduleStateTone(schedule.status)}>{scheduleStateLabel(t, schedule.status)}</StatusPill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </StateBoundary>
      {may ? (
        <form className="card" onSubmit={submit} noValidate aria-label={t('bi.sch.form.title')}>
          <h2>{t('bi.sch.form.title')}</h2>
          <Field id="sch-metric" label={t('bi.exp.metric')} error={problems.metric === undefined ? undefined : scheduleProblemMessage(t, problems.metric)}>
            <select id="sch-metric" value={chosen.metricId} onChange={(event) => setForm({ ...form, metricId: event.target.value })}>
              {certified.map((metric) => (
                <option key={metric.id} value={metric.id}>
                  {metric.code}
                </option>
              ))}
            </select>
          </Field>
          <Field id="sch-dimension" label={t('bi.exp.dimension')} error={undefined}>
            <select id="sch-dimension" value={form.dimension} onChange={(event) => setForm({ ...form, dimension: event.target.value })}>
              <option value="">{t('bi.exp.dimension.none')}</option>
              {DIMENSIONS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {dimensionLabel(t, candidate)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="sch-cron" label={t('bi.sch.cron')} error={problems.cron === undefined ? undefined : scheduleProblemMessage(t, problems.cron)}>
            <input id="sch-cron" value={form.cron} aria-invalid={problems.cron !== undefined} placeholder="0 8 * * 1" onChange={(event) => setForm({ ...form, cron: event.target.value })} />
          </Field>
          <p className="sub">{t('bi.sch.cron.help')}</p>
          <Field id="sch-format" label={t('bi.exp.format')} error={undefined}>
            <select id="sch-format" value={form.format} onChange={(event) => setForm({ ...form, format: event.target.value as ScheduleFormat })}>
              {SCHEDULE_FORMATS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {formatLabel(t, candidate)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="sch-recipients" label={t('bi.sch.recipients')} error={problems.recipients === undefined ? undefined : scheduleProblemMessage(t, problems.recipients)}>
            <textarea id="sch-recipients" value={form.recipients} aria-invalid={problems.recipients !== undefined} onChange={(event) => setForm({ ...form, recipients: event.target.value })} />
          </Field>
          <p className="sub">{t('bi.sch.recipients.help')}</p>
          <div className="formfooter">
            <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending}>
              {t('bi.sch.submit')}
            </button>
          </div>
        </form>
      ) : null}
      <p className="prototype-note">{t('bi.dash.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
