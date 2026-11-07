import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard, StatusPill, StickyActions } from '../../../ui';
import { BackLink, Field } from '../components';
import { useNow, usePeriods } from '../hooks';
import { statusLabel, statusTone } from '../labels';
import { periodsOf, yearsOf } from '../model';
import '../dis.css';
import { ErrorSummary } from './entry-parts';
import type { SummaryItem } from './entry-parts';
import { useCreateReport, useProjectOptions } from './hooks';
import { basisLabel, reportProblemMessage } from './labels';
import { BASES, CREATE_PERMISSION, EDIT_PATH, REPORTS_PATH, canCreate, describeReport, resourceIdOf } from './model';
import type { Basis } from './model';
import { deadlineOf } from './weekly-model';
import { dueText } from './weekly-text';

const NEVER_EMPTY = (): boolean => false;
/** The tone of the status of a period on the pill of the kit, from the names of the old tones. */
const PERIOD_TONE = { green: 'success', warn: 'warning', gray: 'neutral' } as const;
/** The request to reopen a locked period is a screen of its own (DIS-22). */
const REOPEN_PATH = '/dis/dis-22';

/**
 * DIS-02: the choice of the period and the project of a new weekly report. The system captures the plan version in force at the end of the period and what it allocated to each of the six
 * cells; the cumulative disbursement is entered on DIS-04. A period that is locked takes a report only for the projects a reopening that was approved names, which the server judges (ST-DIS-003,
 * DIS 3 F1).
 */
export default function ReportCreateScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <ReportCreateContent key={tenantId ?? 'none'} route={route} />;
}

function ReportCreateContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { permissions, mode } = useSession();
  const periods = usePeriods();
  const projects = useProjectOptions();
  const create = useCreateReport();
  const state = useScreenState({ isLoading: periods.isLoading || projects.isLoading, error: periods.error ?? projects.error, data: periods.data, isEmpty: NEVER_EMPTY });
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState<number | undefined>(undefined);
  const [periodId, setPeriodId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [basis, setBasis] = useState<Basis>('YTD');
  const [attempt, setAttempt] = useState(0);
  const submitted = attempt > 0;
  const now = useNow();
  const all = periods.data ?? [];
  const years = yearsOf(all, currentYear);
  const shownYear = year ?? currentYear;
  const weeks = periodsOf(all, shownYear, '').filter((period) => period.periodType === 'WEEK');
  const chosen = all.find((period) => period.id === periodId);
  const allowed = canCreate(permissions, mode);
  const described = create.isError ? describeReport(create.error) : undefined;
  const summary: SummaryItem[] = [];
  if (submitted && periodId === '') summary.push({ target: 'create-period', message: `${t('dis.reportCreate.period.label')}: ${t('dis.reportCreate.period.required')}` });
  if (submitted && projectId === '') summary.push({ target: 'create-project', message: `${t('dis.reportCreate.project.label')}: ${t('dis.reportCreate.project.required')}` });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempt(attempt + 1);
    if (!allowed || create.isPending || periodId === '' || projectId === '') return;
    create.mutate(
      { projectId, periodId, basis },
      {
        onSuccess: (done) => {
          const made = resourceIdOf(done);
          if (made !== undefined) void navigate(`${EDIT_PATH}?report=${made}`);
        },
      },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={REPORTS_PATH}>{t('dis.reportCreate.back.link')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.reportCreate.page.title')}</h1>
          <p>{t('dis.reportCreate.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void Promise.all([periods.refetch(), projects.refetch()])}>
        <form onSubmit={submit} noValidate className="dis-wr-stack" aria-label={t('dis.reportCreate.page.title')}>
          <ErrorSummary items={summary} attempt={attempt} />
          <p className="callout" data-testid="create-note">
            {t('dis.reportCreate.note')}
          </p>
          {allowed ? null : (
            <p className="callout warning" role="status" data-testid="create-denied">
              {t('dis.reportCreate.denied.note', { permission: CREATE_PERMISSION })}
            </p>
          )}
          {described === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="refusal">
              {reportProblemMessage(t, described.problem)}
              {described.existingId === undefined ? null : (
                <>
                  {' '}
                  <Link to={`${EDIT_PATH}?report=${described.existingId}`}>{t('dis.reportCreate.existing.link')}</Link>
                </>
              )}
            </p>
          )}
          <SectionCard title={t('dis.wr.create.section')} status={chosen === undefined ? undefined : <StatusPill tone={PERIOD_TONE[statusTone(chosen.status)]}>{statusLabel(t, chosen.status)}</StatusPill>}>
            <div className="formgrid">
              <Field id="create-year" label={t('dis.reportCreate.year.label')} error={undefined}>
                <select
                  id="create-year"
                  value={shownYear}
                  onChange={(event) => {
                    setYear(Number(event.target.value));
                    setPeriodId('');
                  }}
                >
                  {years.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="create-period" label={t('dis.reportCreate.period.label')} error={submitted && periodId === '' ? t('dis.reportCreate.period.required') : undefined}>
                <select id="create-period" value={periodId} onChange={(event) => setPeriodId(event.target.value)}>
                  <option value="">{t('dis.reportCreate.period.choose')}</option>
                  {weeks.map((period) => (
                    <option key={period.id} value={period.id}>
                      {t('dis.reportCreate.period.option', { code: period.code, start: period.startDate, end: period.endDate, status: statusLabel(t, period.status) })}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="create-project" label={t('dis.reportCreate.project.label')} error={submitted && projectId === '' ? t('dis.reportCreate.project.required') : undefined}>
                <select id="create-project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                  <option value="">{t('dis.reportCreate.project.choose')}</option>
                  {(projects.data ?? []).map((project) => (
                    <option key={project.id} value={project.id}>
                      {`${project.code} · ${project.name}`}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="create-basis" label={t('dis.reportCreate.basis.label')} error={undefined} hint={t('dis.reportCreate.basis.help')}>
                <select id="create-basis" value={basis} onChange={(event) => setBasis(event.target.value as Basis)}>
                  {BASES.map((item) => (
                    <option key={item} value={item}>
                      {basisLabel(t, item)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {chosen === undefined ? null : (
              <p className="sub" data-testid="create-deadline">
                {dueText(t, chosen.deadlineAt, chosen.status === 'OPEN' ? deadlineOf(chosen.deadlineAt, now) : undefined)}
              </p>
            )}
            {chosen?.status === 'LOCKED' ? (
              <p className="callout warning" role="status" data-testid="locked-note">
                {t('dis.reportCreate.locked.note')} <Link to={REOPEN_PATH}>{t('dis.reportCreate.locked.link')}</Link>
              </p>
            ) : null}
          </SectionCard>
          <StickyActions
            primary={
              <button type="submit" className="ui-button ui-button--primary" disabled={!allowed || create.isPending}>
                {create.isPending ? t('dis.reportCreate.submit.pending') : t('dis.reportCreate.submit.action')}
              </button>
            }
            secondary={[
              <Link key="back" className="ui-button ui-button--outline" to={REPORTS_PATH}>
                {t('dis.wr.back.action')}
              </Link>,
            ]}
          />
        </form>
      </StateBoundary>
      <p className="prototype-note">{t('dis.reportCreate.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
