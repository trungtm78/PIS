import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../components';
import { usePeriods } from '../hooks';
import '../dis.css';
import { useCreateReport, useProjectOptions, useReport, useSaveDraft } from '../report/hooks';
import { reportProblemMessage } from '../report/labels';
import { REVIEW_PATH, canCreate, canEdit, describeReport, resourceIdOf } from '../report/model';
import { NOTE_FIELDS, notesBody, notesFormOf, validateNotes } from '../report/step-model';
import type { NoteField, NotesForm } from '../report/step-model';

const NEVER_EMPTY = (): boolean => false;
const THIS_PATH = '/dis/dis-13';

/**
 * DIS-13: the monthly narrative report (ST-DIS-015, FR-DIS-13). The investor chooses a month and a project, which starts the monthly draft, and writes what was achieved, the causes, the solutions and the
 * proposals. The causes are required to send a monthly report (the server refuses the send with 422 on `narrative.causes_text`, which DIS-06 shows); the volumes and the sending are the steps of the report.
 */
export default function MonthlyNarrativeScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  const [params] = useSearchParams();
  const reportId = params.get('report') ?? undefined;
  return reportId === undefined ? <Start key={tenantId ?? 'none'} route={route} /> : <Narrative key={`${tenantId ?? 'none'}:${reportId}`} route={route} reportId={reportId} />;
}

function Start({ route }: ScreenProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { permissions, mode } = useSession();
  const periods = usePeriods();
  const projects = useProjectOptions();
  const create = useCreateReport();
  const state = useScreenState({ isLoading: periods.isLoading || projects.isLoading, error: periods.error ?? projects.error, data: periods.data, isEmpty: NEVER_EMPTY });
  const [periodId, setPeriodId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const months = (periods.data ?? []).filter((period) => period.periodType === 'MONTH').sort((left, right) => (left.startDate < right.startDate ? 1 : left.startDate > right.startDate ? -1 : 0));
  const allowed = canCreate(permissions, mode);
  const described = create.isError ? describeReport(create.error) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (!allowed || create.isPending || periodId === '' || projectId === '') return;
    create.mutate(
      { projectId, periodId, basis: 'PERIOD', reportType: 'MONTHLY' },
      {
        onSuccess: (done) => {
          const made = resourceIdOf(done);
          if (made !== undefined) void navigate(`${THIS_PATH}?report=${made}`);
        },
      },
    );
  };
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.monthly.page.title')}</h1>
          <p>{t('dis.monthly.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void Promise.all([periods.refetch(), projects.refetch()])}>
        <form className="card" onSubmit={submit} noValidate>
          {allowed ? null : (
            <p className="callout warning" role="status" data-testid="create-denied">
              {t('dis.monthly.denied.note')}
            </p>
          )}
          {described === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="refusal">
              {reportProblemMessage(t, described.problem)}
              {described.existingId === undefined ? null : (
                <>
                  {' '}
                  <Link to={`${THIS_PATH}?report=${described.existingId}`}>{t('dis.monthly.existing.link')}</Link>
                </>
              )}
            </p>
          )}
          <div className="formgrid">
            <Field id="monthly-month" label={t('dis.monthly.month.label')} error={submitted && periodId === '' ? t('dis.monthly.month.required') : undefined}>
              <select id="monthly-month" value={periodId} onChange={(event) => setPeriodId(event.target.value)}>
                <option value="">{t('dis.monthly.month.choose')}</option>
                {months.map((period) => (
                  <option key={period.id} value={period.id}>
                    {t('dis.monthly.month.option', { code: period.code, start: period.startDate, end: period.endDate })}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="monthly-project" label={t('dis.monthly.project.label')} error={submitted && projectId === '' ? t('dis.monthly.project.required') : undefined}>
              <select id="monthly-project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                <option value="">{t('dis.monthly.project.choose')}</option>
                {(projects.data ?? []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {`${project.code} · ${project.name}`}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="formfooter">
            <button type="submit" className="primary" disabled={!allowed || create.isPending}>
              {create.isPending ? t('dis.monthly.start.pending') : t('dis.monthly.start.action')}
            </button>
          </div>
        </form>
      </StateBoundary>
      <p className="prototype-note">{t('dis.monthly.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Narrative({ route, reportId }: ScreenProps & { reportId: string }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const report = useReport(reportId);
  const state = useScreenState({ isLoading: report.isLoading, error: report.error, data: report.data, isEmpty: (data) => data === undefined });
  const detail = report.data;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.monthly.page.title')}</h1>
          <p>{t('dis.monthly.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void report.refetch()}>
        {detail === undefined ? null : (
          <section className="card" aria-labelledby="narrative-title">
            <h2 id="narrative-title">{t('dis.monthly.narrative.title', { project: detail.project.code, period: detail.period.code })}</h2>
            {detail.reportType === 'MONTHLY' ? null : (
              <p className="callout warning" role="alert" data-testid="not-monthly">
                {t('dis.monthly.notMonthly.note')}
              </p>
            )}
            <NarrativeForm key={detail.id} detail={detail} editable={detail.reportType === 'MONTHLY' && canEdit(permissions, mode, detail.status)} />
          </section>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('dis.monthly.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function NarrativeForm({ detail, editable }: { detail: NonNullable<ReturnType<typeof useReport>['data']>; editable: boolean }) {
  const { t } = useTranslation();
  const save = useSaveDraft();
  const [form, setForm] = useState<NotesForm>(() => notesFormOf(detail));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateNotes(form);
  const described = save.isError ? describeReport(save.error) : undefined;
  const label = (field: NoteField): string => {
    switch (field) {
      case 'results':
        return t('dis.monthly.field.results');
      case 'causes':
        return t('dis.monthly.field.causes');
      case 'solutions':
        return t('dis.monthly.field.solutions');
      case 'proposals':
        return t('dis.monthly.field.proposals');
    }
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (!editable || save.isPending || Object.keys(problems).length > 0) return;
    save.mutate({ detail, body: notesBody(detail, form) });
  };
  const missingCauses = form.causes.trim() === '';
  return (
    <form onSubmit={submit} noValidate>
      <p className="sub">{t('dis.monthly.narrative.help')}</p>
      {described === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="narrative-refusal">
          {reportProblemMessage(t, described.problem)}
        </p>
      )}
      {save.isSuccess ? (
        <p className="callout" role="status" data-testid="narrative-saved">
          {t('dis.monthly.saved.note')}
        </p>
      ) : null}
      {NOTE_FIELDS.map((field) => (
        <Field
          key={field}
          id={`monthly-${field}`}
          label={label(field)}
          error={submitted && problems[field] !== undefined ? t('dis.monthly.tooLong.error') : undefined}
          {...(field === 'causes' ? { hint: missingCauses ? t('dis.monthly.causes.required') : t('dis.monthly.causes.hint') } : {})}
        >
          <textarea id={`monthly-${field}`} rows={4} value={form[field]} disabled={!editable} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setForm({ ...form, [field]: event.target.value })} />
        </Field>
      ))}
      <div className="formfooter">
        {editable ? (
          <button type="submit" className="primary" disabled={save.isPending}>
            {save.isPending ? t('dis.monthly.save.pending') : t('dis.monthly.save.action')}
          </button>
        ) : null}{' '}
        <Link to={`${REVIEW_PATH}?report=${detail.id}`}>{t('dis.monthly.review.link')}</Link>
      </div>
    </form>
  );
}
