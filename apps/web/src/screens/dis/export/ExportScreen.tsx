import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../components';
import { usePeriods } from '../hooks';
import { useFrozenSnapshots } from '../rates/hooks';
import '../dis.css';
import { useCreateExport, useIssueDownload } from './hooks';
import { COLUMN_KEYS, FORMATS, SCALES, canChoose, canExport, describeExport, exportIdOf, initialForm, linkOf, validateForm } from './model';
import type { ColumnKey, ExportForm, ExportProblem, Format, Scale } from './model';

type T = Translator['t'];

function problemMessage(t: T, problem: ExportProblem): string {
  switch (problem) {
    case 'notFrozen':
      return t('dis.export.problem.notFrozen');
    case 'rowCap':
      return t('dis.export.problem.rowCap');
    case 'scopeDenied':
      return t('dis.export.problem.scopeDenied');
    case 'validation':
      return t('dis.export.problem.validation');
    case 'notFound':
      return t('dis.export.problem.notFound');
    case 'general':
      return t('dis.export.problem.general');
  }
}

const formatLabel = (t: T, format: Format): string => (format === 'XLSX' ? t('dis.export.format.xlsx') : format === 'CSV' ? t('dis.export.format.csv') : t('dis.export.format.pdf'));
const scaleLabel = (t: T, scale: Scale): string => (scale === 'VND' ? t('dis.export.scale.vnd') : t('dis.export.scale.million'));

function columnLabel(t: T, key: ColumnKey): string {
  switch (key) {
    case 'project_code':
      return t('dis.export.col.projectCode');
    case 'project_name':
      return t('dis.export.col.projectName');
    case 'unit_code':
      return t('dis.export.col.unitCode');
    case 'unit_name':
      return t('dis.export.col.unitName');
    case 'bucket':
      return t('dis.export.col.bucket');
    case 'budget_level':
      return t('dis.export.col.budgetLevel');
    case 'plan_pm_assigned_vnd':
      return t('dis.export.col.planPm');
    case 'plan_local_added_vnd':
      return t('dis.export.col.planLocal');
    case 'plan_total_vnd':
      return t('dis.export.col.planTotal');
    case 'disbursed_treasury_vnd':
      return t('dis.export.col.treasury');
    case 'disbursed_reported_vnd':
      return t('dis.export.col.reported');
    case 'ctmtqg_subset_vnd':
      return t('dis.export.col.ctmtqg');
    case 'rate_pm_pct':
      return t('dis.export.col.ratePm');
    case 'rate_total_pct':
      return t('dis.export.col.rateTotal');
    case 'rate_null_reason':
      return t('dis.export.col.reason');
    case 'treasury_coverage':
      return t('dis.export.col.coverage');
  }
}

/**
 * DIS-17: the export of a frozen snapshot to a file (ST-DIS-016, FR-DIS-17). Only the lines of the projects the person may see are in the file; the file says in its header what the numbers are (scope, period,
 * snapshot, unit, time, status of the definitions) and, while the definitions await the sign-off of D03, says so in a notice. The link to a file is asked for each time and the server judges the permission and
 * the scope again: a person whose scope has narrowed since is refused and makes the file again.
 */
export default function ExportScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <ExportContent key={tenantId ?? 'none'} route={route} />;
}

function ExportContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const reads = canChoose(permissions);
  const frozen = useFrozenSnapshots(reads);
  const periods = usePeriods();
  const create = useCreateExport();
  const issue = useIssueDownload();
  const [form, setForm] = useState<ExportForm>(initialForm());
  const [submitted, setSubmitted] = useState(false);
  const [ready, setReady] = useState<string | undefined>(undefined);
  const listed = useScreenState({ isLoading: frozen.isLoading, error: frozen.error, data: frozen.data, isEmpty: (data) => (data as unknown[]).length === 0 });
  const state = reads ? listed : 'default';
  const allowed = canExport(permissions) && reads;
  const codes = new Map((periods.data ?? []).map((period) => [period.id, period.code]));
  const chosen = (frozen.data ?? []).find((snapshot) => snapshot.id === form.snapshotId);
  const invalid = submitted ? validateForm(form) : undefined;
  const createProblem = create.isError ? describeExport(create.error) : undefined;
  const downloadProblem = issue.isError ? describeExport(issue.error) : undefined;
  const link = issue.data;

  const toggle = (key: ColumnKey): void => setForm({ ...form, columns: form.columns.includes(key) ? form.columns.filter((each) => each !== key) : COLUMN_KEYS.filter((each) => each === key || form.columns.includes(each)) });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    setReady(undefined);
    issue.reset();
    if (!allowed || create.isPending || validateForm(form) !== undefined) return;
    create.mutate(form, { onSuccess: (done) => setReady(exportIdOf(done)) });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.export.page.title')}</h1>
          <p>{t('dis.export.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void frozen.refetch()}>
        <form className="card" onSubmit={submit} noValidate aria-label={t('dis.export.form.aria')}>
          {canExport(permissions) ? null : (
            <p className="callout warning" role="status" data-testid="export-denied">
              {t('dis.export.denied.note')}
            </p>
          )}
          {canExport(permissions) && !reads ? (
            <p className="callout warning" role="status" data-testid="export-read-needed">
              {t('dis.export.readNeeded.note')}
            </p>
          ) : null}
          {createProblem === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="export-refusal">
              {problemMessage(t, createProblem)}
            </p>
          )}
          <div className="formgrid">
            <Field id="export-snapshot" label={t('dis.export.snapshot.label')} error={invalid === 'snapshotRequired' ? t('dis.export.snapshot.required') : undefined}>
              <select id="export-snapshot" value={form.snapshotId} onChange={(event) => setForm({ ...form, snapshotId: event.target.value })}>
                <option value="">{t('dis.export.snapshot.choose')}</option>
                {(frozen.data ?? []).map((snapshot) => (
                  <option key={snapshot.id} value={snapshot.id}>
                    {t('dis.export.snapshot.option', { period: codes.get(snapshot.periodId) ?? snapshot.periodId.slice(0, 8), cutoff: snapshot.cutoffDate })}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="export-format" label={t('dis.export.format.label')} error={undefined}>
              <select id="export-format" value={form.format} onChange={(event) => setForm({ ...form, format: event.target.value as Format })}>
                {FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {formatLabel(t, format)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="export-scale" label={t('dis.export.scale.label')} error={undefined}>
              <select id="export-scale" value={form.scale} onChange={(event) => setForm({ ...form, scale: event.target.value as Scale })}>
                {SCALES.map((scale) => (
                  <option key={scale} value={scale}>
                    {scaleLabel(t, scale)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {chosen?.definitionStatus === 'PROPOSED_PENDING_SIGNOFF' ? (
            <p className="callout" role="note" data-testid="export-pending-note">
              {t('dis.export.pending.note')}
            </p>
          ) : null}
          <fieldset aria-describedby={invalid === 'columnsRequired' ? 'export-columns-error' : undefined}>
            <legend>{t('dis.export.columns.legend')}</legend>
            <div className="dis-chip-list">
              {COLUMN_KEYS.map((key) => (
                <label key={key} className="check">
                  <input type="checkbox" checked={form.columns.includes(key)} onChange={() => toggle(key)} /> {columnLabel(t, key)}
                </label>
              ))}
            </div>
            <p>
              <button type="button" onClick={() => setForm({ ...form, columns: COLUMN_KEYS })}>
                {t('dis.export.columns.all.action')}
              </button>
            </p>
            {invalid === 'columnsRequired' ? (
              <small role="alert" className="field-error" id="export-columns-error">
                {t('dis.export.columns.required')}
              </small>
            ) : null}
          </fieldset>
          <div className="formfooter">
            <button type="submit" className="primary" disabled={!allowed || create.isPending}>
              {create.isPending ? t('dis.export.submit.pending') : t('dis.export.submit.action')}
            </button>
          </div>
        </form>
        {ready === undefined ? null : (
          <section className="card" aria-labelledby="export-ready-title" data-testid="export-ready">
            <h2 id="export-ready-title">{t('dis.export.ready.title')}</h2>
            <p>{t('dis.export.ready.text')}</p>
            {downloadProblem === undefined ? null : (
              <p className="callout warning" role="alert" data-testid="download-refusal">
                {problemMessage(t, downloadProblem)}
              </p>
            )}
            {link === undefined ? (
              <button type="button" disabled={issue.isPending} onClick={() => issue.mutate(ready)}>
                {t('dis.export.download.action')}
              </button>
            ) : (
              <p data-testid="download-link">
                <a href={linkOf(link.url, import.meta.env.VITE_API_BASE_URL ?? '')} download>
                  {t('dis.export.download.link')}
                </a>{' '}
                <span className="sub">{t('dis.export.download.expires', { at: link.expiresAt.slice(11, 16), rows: String(link.rows) })}</span>{' '}
                <button type="button" disabled={issue.isPending} onClick={() => issue.mutate(ready)}>
                  {t('dis.export.download.renew.action')}
                </button>
              </p>
            )}
          </section>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('dis.export.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
