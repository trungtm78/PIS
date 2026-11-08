import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { Info } from '../gov11/gov11-kit';
import type { RuleReading } from '../gov11/gov11-kit';
import { useProjectOptions, useUnitOptions } from '../dir/hooks';
import { useFrozenSnapshots } from '../dis/rates/hooks';
import { Field } from './components';
import { useCreateReport, useForms } from './hooks';
import { reportProblemMessage } from './labels';
import { describeReportProblem } from './report-model';
import { EMPTY_CREATE, PERIOD_LABEL_MAX, createBody, createProblems, resourceIdOf } from './report-create-model';
import type { CreateField, CreateProblem, CreateValues } from './report-create-model';
import { vietnamToday, yearsAround } from './model';

interface Props {
  /** Opens the report that was made. */
  onCreated: (reportId: string) => void;
  onCancel: () => void;
}

/**
 * Makes a report by hand (MNE-03): the revision of the form in force, the year and the label of the period, the unit it is about, a project when it is a project report, and the frozen snapshot its locked cells are filled
 * from. A report that already exists for the same form, period and unit is refused by the server (REPORT_EXISTS) and the screen says so; the report is made as a draft and goes through review and approval like any other.
 */
export function ReportCreateForm({ onCreated, onCancel }: Props) {
  const { t } = useTranslation();
  const today = vietnamToday();
  const forms = useForms({ reportKind: '', effectiveOn: today });
  const units = useUnitOptions();
  const projects = useProjectOptions();
  const snapshots = useFrozenSnapshots();
  const create = useCreateReport();
  const [values, setValues] = useState<CreateValues>({ ...EMPTY_CREATE, reportYear: today.slice(0, 4) });
  const [tried, setTried] = useState(false);
  const problems = createProblems(values);
  const published = (forms.data ?? []).filter((form) => form.status === 'PUBLISHED');
  const chosen = published.find((form) => form.id === values.formId);
  const snapshot = (snapshots.data ?? []).find((one) => one.id === values.snapshotId);
  const set = (change: Partial<CreateValues>): void => setValues({ ...values, ...change });
  const message = (field: CreateField): string | undefined => {
    const code: CreateProblem | undefined = tried ? problems[field] : undefined;
    switch (code) {
      case 'required':
        return t('mne.create.error.required');
      case 'yearInvalid':
        return t('mne.create.error.year');
      case 'periodLong':
        return t('mne.create.error.periodLong', { max: PERIOD_LABEL_MAX });
      default:
        return undefined;
    }
  };
  const failure = create.isError ? describeReportProblem(create.error) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setTried(true);
    if (Object.keys(problems).length > 0) return;
    create.mutate({ body: createBody(values) }, { onSuccess: (answer) => onCreated(resourceIdOf(answer)) });
  };
  const rule: RuleReading | undefined =
    chosen === undefined
      ? undefined
      : {
          version: chosen.revision,
          source: 'RULE',
          unverified: chosen.awaitingConfirmation,
          provenance: { formula: t('mne.create.info.formula'), source: chosen.legalBasis, as_of: snapshot?.asOfDate ?? chosen.effectiveFrom, legal_status: chosen.awaitingConfirmation ? 'UNVERIFIED' : 'CONFIRMED' },
        };
  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="create-title" data-testid="create-form">
      <h2 id="create-title">{t('mne.create.title')}</h2>
      <p className="sub">{t('mne.create.help')}</p>
      <Field id="create-form-id" label={t('mne.create.form.label')} error={message('formId')}>
        <select id="create-form-id" value={values.formId} onChange={(event) => set({ formId: event.target.value })} disabled={forms.isLoading} aria-invalid={message('formId') !== undefined}>
          <option value="">{forms.isLoading ? t('mne.create.loading') : t('mne.create.form.choose')}</option>
          {published.map((form) => (
            <option key={form.id} value={form.id}>
              {t('mne.create.form.option', { code: form.formCode, revision: form.revision, title: form.title })}
            </option>
          ))}
        </select>
      </Field>
      {forms.isError ? (
        <p className="callout warning" role="alert" data-testid="create-forms-error">
          {t('mne.create.lookup.error')}{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void forms.refetch()}>
            {t('mne.create.retry')}
          </button>
        </p>
      ) : null}
      {!forms.isLoading && !forms.isError && published.length === 0 ? (
        <p className="sub" data-testid="create-no-forms">
          {t('mne.create.form.none')}
        </p>
      ) : null}
      {chosen === undefined ? null : (
        <p className="sub" data-testid="create-legal">
          {t('mne.create.form.legal', { basis: chosen.legalBasis })} {rule === undefined ? null : <Info name={t('mne.create.info.name')} rule={rule} fallbackFormula={t('mne.create.info.formula')} owner={t('mne.create.info.owner')} asOf={rule.provenance?.as_of ?? ''} />}
        </p>
      )}
      <div className="mne-filters">
        <Field id="create-year" label={t('mne.create.year.label')} error={message('reportYear')}>
          <select id="create-year" value={values.reportYear} onChange={(event) => set({ reportYear: event.target.value })} aria-invalid={message('reportYear') !== undefined}>
            {yearsAround(today, values.reportYear === '' ? [] : [Number(values.reportYear)]).map((year) => (
              <option key={year} value={String(year)}>
                {year}
              </option>
            ))}
          </select>
        </Field>
        <Field id="create-period" label={t('mne.create.period.label')} hint={t('mne.create.period.hint', { max: PERIOD_LABEL_MAX })} error={message('periodLabel')}>
          <input id="create-period" value={values.periodLabel} onChange={(event) => set({ periodLabel: event.target.value })} aria-invalid={message('periodLabel') !== undefined} />
        </Field>
      </div>
      <Field id="create-unit" label={t('mne.create.unit.label')} error={message('unitId')}>
        <select id="create-unit" value={values.unitId} onChange={(event) => set({ unitId: event.target.value })} disabled={units.isLoading} aria-invalid={message('unitId') !== undefined}>
          <option value="">{units.isLoading ? t('mne.create.loading') : t('mne.create.unit.choose')}</option>
          {(units.data ?? []).map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.label}
            </option>
          ))}
        </select>
      </Field>
      <Field id="create-project" label={t('mne.create.project.label')} hint={t('mne.create.project.hint')} error={undefined}>
        <select id="create-project" value={values.projectId} onChange={(event) => set({ projectId: event.target.value })} disabled={projects.isLoading}>
          <option value="">{t('mne.create.project.none')}</option>
          {(projects.data ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.label}
            </option>
          ))}
        </select>
      </Field>
      <Field id="create-snapshot" label={t('mne.create.snapshot.label')} hint={t('mne.create.snapshot.hint')} error={undefined}>
        <select id="create-snapshot" value={values.snapshotId} onChange={(event) => set({ snapshotId: event.target.value })} disabled={snapshots.isLoading}>
          <option value="">{t('mne.create.snapshot.none')}</option>
          {(snapshots.data ?? []).map((one) => (
            <option key={one.id} value={one.id}>
              {t('mne.report.snapshot.option', { date: one.asOfDate })}
            </option>
          ))}
        </select>
      </Field>
      {units.isError || projects.isError || snapshots.isError ? (
        <p className="callout warning" role="alert" data-testid="create-lookup-error">
          {t('mne.create.lookup.error')}
        </p>
      ) : null}
      {!snapshots.isLoading && !snapshots.isError && (snapshots.data ?? []).length === 0 ? (
        <p className="sub" data-testid="create-no-snapshot">
          {t('mne.report.snapshot.noneFrozen')}
        </p>
      ) : null}
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="create-problem">
          {reportProblemMessage(t, failure, (key) => key)}
        </p>
      )}
      <div className="mne-actions">
        <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending} data-testid="create-submit">
          {create.isPending ? t('mne.report.action.working') : t('mne.create.submit')}
        </button>
        <button type="button" className="ui-button ui-button--outline" onClick={onCancel} data-testid="create-cancel">
          {t('mne.create.cancel')}
        </button>
      </div>
    </form>
  );
}
