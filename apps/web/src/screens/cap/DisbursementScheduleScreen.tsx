import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { mayAct } from './approval-model';
import { Field, Money } from './components';
import { levelLabel } from './labels';
import { millionsInput, millionsText } from './model';
import { useProjects } from './plan-hooks';
import { BUCKETS } from './plan-model';
import type { Bucket } from './plan-model';
import { useRegisterSchedule, useSchedules } from './schedule-hooks';
import { amountProblemMessage, ctmtqgProblemMessage, monthLabel, scheduleProblemMessage, sourceLabel } from './schedule-labels';
import {
  ADJUSTMENT_MONTH,
  BUDGET_LEVELS,
  EMPTY_REGISTRATION,
  MAX_YEAR,
  MIN_YEAR,
  MONTHS,
  REASON_MAX,
  REGISTER_SCHEDULE_PERMISSION,
  SCHEDULABLE_STATUSES,
  currentOf,
  describeScheduleProblem,
  monthOf,
  monthRows,
  ratePercent,
  registrationBody,
  validateRegistration,
  yearOf,
  yearTotal,
} from './schedule-model';
import type { BudgetLevel, MonthRow, RegistrationField, RegistrationForm, RegistrationProblem, ScheduleItem } from './schedule-model';
import './cap.css';

/**
 * CAP-08: the registration of the disbursement of next month. The investor picks a project and a year and sees the thirteen months (twelve and the
 * adjustment period) by source group: capital of the year, carried-over capital and other capital. A registration is a promise: it is shown beside
 * what the Treasury paid in the month and the rate of achievement, and never added to it. Registering a month again replaces the current figure with a
 * new revision; the old one is kept.
 */
export default function DisbursementScheduleScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ScheduleContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ScheduleContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const projects = useProjects();
  const offered = useMemo(() => (projects.data ?? []).filter((project) => SCHEDULABLE_STATUSES.includes(project.status)), [projects.data]);
  const selected = offered.find((project) => project.id === params.get('project')) ?? offered[0];
  const [typedYear, setTypedYear] = useState(String(new Date().getFullYear()));
  const year = yearOf(typedYear);
  const schedules = useSchedules(selected?.id, year);
  const state = useScreenState({ isLoading: projects.isLoading || (selected !== undefined && year !== undefined && schedules.isLoading), error: projects.error ?? schedules.error, data: offered });
  const rows = useMemo(() => monthRows(schedules.data ?? []), [schedules.data]);
  const total = useMemo(() => yearTotal(rows), [rows]);
  const choose = (id: string): void => {
    const next = new URLSearchParams(params);
    next.set('project', id);
    setParams(next, { replace: true });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.schedule.page.title')}</h1>
          <p>{t('cap.schedule.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void projects.refetch()}>
        {selected === undefined ? null : (
          <>
            <div className="card cap-filters">
              <div className="field" data-field="schedule-project">
                <label htmlFor="schedule-project">{t('cap.schedule.project.label')}</label>
                <select id="schedule-project" value={selected.id} onChange={(event) => choose(event.target.value)}>
                  {offered.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.code} · {project.name}
                    </option>
                  ))}
                </select>
              </div>
              <Field id="schedule-year" label={t('cap.schedule.year.label')} error={year === undefined ? t('cap.schedule.year.invalid.error', { min: MIN_YEAR, max: MAX_YEAR }) : undefined}>
                <input id="schedule-year" inputMode="numeric" value={typedYear} aria-invalid={year === undefined} maxLength={4} onChange={(event) => setTypedYear(event.target.value)} />
              </Field>
            </div>
            <p className="callout" role="note" data-testid="promise">
              {t('cap.schedule.note.promise.notice')}
            </p>
            {year === undefined ? null : <Grid year={year} rows={rows} total={total} loading={schedules.isLoading} />}
            {year === undefined ? null : (
              <RegisterForm
                key={`${selected.id}:${year}`}
                projectId={selected.id}
                year={year}
                items={schedules.data ?? []}
                allowed={mayAct(permissions, mode, REGISTER_SCHEDULE_PERMISSION)}
                frozen={mode === 'READ_ONLY'}
                locale={locale}
              />
            )}
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('cap.schedule.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface GridProps {
  year: number;
  rows: readonly MonthRow[];
  total: ReturnType<typeof yearTotal>;
  loading: boolean;
}

function Grid({ year, rows, total, loading }: GridProps) {
  const { t, locale } = useTranslation();
  const empty = !loading && rows.every((row) => row.registeredVnd === '0');
  return (
    <div className="card" data-testid="grid" data-year={year}>
      <h2>{t('cap.schedule.table.title', { year })}</h2>
      {empty ? (
        <p className="callout" role="status" data-testid="no-registration">
          {t('cap.schedule.empty.notice')}
        </p>
      ) : null}
      <div className="cap-scroll">
        <table className="table cap-table" aria-label={t('cap.schedule.table.aria', { year })}>
          <caption className="sr-only">{t('cap.schedule.table.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('cap.schedule.column.month')}</th>
              {BUCKETS.map((bucket) => (
                <th scope="col" key={bucket} className="cap-number">
                  {sourceLabel(t, bucket)}
                </th>
              ))}
              <th scope="col" className="cap-number">
                {t('cap.schedule.column.total')}
              </th>
              <th scope="col" className="cap-number">
                {t('cap.schedule.column.disbursed')}
              </th>
              <th scope="col" className="cap-number">
                {t('cap.schedule.column.rate')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.month} data-month={row.month} data-registered={row.registeredVnd === '0' ? 'false' : 'true'}>
                <th scope="row">{monthLabel(t, row.month, row.month === ADJUSTMENT_MONTH)}</th>
                {BUCKETS.map((bucket) => (
                  <td key={bucket} className="cap-number" data-bucket={bucket}>
                    <Money vnd={row.byBucket[bucket]} />
                  </td>
                ))}
                <td className="cap-number" data-testid="registered">
                  <Money vnd={row.registeredVnd} />
                </td>
                <td className="cap-number" data-testid="disbursed">
                  <Money vnd={row.disbursedVnd} />
                </td>
                <td className="cap-number" data-testid="rate" data-rate={row.rate ?? ''}>
                  {row.rate === null ? <small className="sub">{t('cap.schedule.rate.none.label')}</small> : ratePercent(row.rate, locale)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{t('cap.schedule.total.label')}</th>
              <td colSpan={3} />
              <td className="cap-number" data-testid="total-registered">
                <Money vnd={total.registeredVnd} />
              </td>
              <td className="cap-number" data-testid="total-disbursed">
                <Money vnd={total.disbursedVnd} />
              </td>
              <td className="cap-number" data-testid="total-rate" data-rate={total.rate ?? ''}>
                {total.rate === null ? <small className="sub">{t('cap.schedule.rate.none.label')}</small> : ratePercent(total.rate, locale)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

interface RegisterFormProps {
  projectId: string;
  year: number;
  items: readonly ScheduleItem[];
  allowed: boolean;
  frozen: boolean;
  locale: string;
}

function RegisterForm({ projectId, year, items, allowed, frozen, locale }: RegisterFormProps) {
  const { t } = useTranslation();
  const register = useRegisterSchedule();
  const [form, setForm] = useState<RegistrationForm>(EMPTY_REGISTRATION);
  const [errors, setErrors] = useState<Partial<Record<RegistrationField, RegistrationProblem>>>({});
  const [saved, setSaved] = useState<number | undefined>(undefined);
  const month = monthOf(form.month);
  const current = month === undefined ? undefined : currentOf(items, month, form.bucket, form.budgetLevel);
  // Choosing a month and a source group that already has a registration offers its figure to change.
  useEffect(() => {
    if (current === undefined) return;
    setForm((value) => ({ ...value, amount: millionsInput(current.amountVnd, locale), ctmtqg: current.ctmtqgSubsetVnd === null ? '' : millionsInput(current.ctmtqgSubsetVnd, locale) }));
  }, [current, locale]);
  const problem = register.isError ? describeScheduleProblem(register.error) : undefined;

  if (!allowed) {
    return (
      <p className="callout" role="status" data-testid="register-denied">
        {frozen ? t('cap.readOnly.frozen.notice') : t('cap.schedule.denied.notice')}
      </p>
    );
  }
  const setField = <K extends RegistrationField>(field: K, value: RegistrationForm[K]): void => {
    setForm((value0) => ({ ...value0, [field]: value }));
    setErrors((value0) => ({ ...value0, [field]: undefined }));
    setSaved(undefined);
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (register.isPending) return;
    const found = validateRegistration(form, locale);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    register.mutate(registrationBody(form, projectId, year, locale), {
      onSuccess: () => setSaved((current?.revision ?? 0) + 1),
    });
  };
  return (
    <form className="card cap-form" data-testid="register" aria-label={t('cap.schedule.form.title')} onSubmit={submit} noValidate>
      <h2>{t('cap.schedule.form.title')}</h2>
      {saved === undefined ? null : (
        <p className="callout" role="status" data-testid="saved">
          {t('cap.schedule.save.done', { revision: saved })}
        </p>
      )}
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="problem" data-problem={problem}>
          {scheduleProblemMessage(t, problem)}
        </p>
      )}
      <div className="cap-filters">
        <Field id="register-month" label={t('cap.schedule.month.field.label')} error={errors.month === undefined ? undefined : t('cap.schedule.month.required.error')}>
          <select id="register-month" value={form.month} aria-invalid={errors.month !== undefined} onChange={(event) => setField('month', event.target.value)}>
            <option value="">{t('cap.schedule.month.placeholder')}</option>
            {MONTHS.map((value) => (
              <option key={value} value={String(value)}>
                {monthLabel(t, value, value === ADJUSTMENT_MONTH)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="register-bucket" label={t('cap.schedule.bucket.label')} error={undefined}>
          <select id="register-bucket" value={form.bucket} onChange={(event) => setField('bucket', event.target.value as Bucket)}>
            {BUCKETS.map((bucket) => (
              <option key={bucket} value={bucket}>
                {sourceLabel(t, bucket)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="register-level" label={t('cap.schedule.level.label')} error={undefined}>
          <select id="register-level" value={form.budgetLevel} onChange={(event) => setField('budgetLevel', event.target.value as BudgetLevel)}>
            {BUDGET_LEVELS.map((level) => (
              <option key={level} value={level}>
                {levelLabel(t, level)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {current === undefined ? null : (
        <p className="callout" role="status" data-testid="current">
          {t('cap.schedule.current.notice', { amount: millionsText(current.amountVnd, locale), revision: current.revision })}
        </p>
      )}
      <div className="cap-filters">
        <Field id="register-amount" label={t('cap.schedule.amount.label')} error={errors.amount === undefined ? undefined : amountProblemMessage(t, errors.amount)}>
          <input id="register-amount" inputMode="decimal" value={form.amount} aria-invalid={errors.amount !== undefined} onChange={(event) => setField('amount', event.target.value)} />
        </Field>
        <Field id="register-ctmtqg" label={t('cap.schedule.ctmtqg.label')} error={errors.ctmtqg === undefined ? undefined : ctmtqgProblemMessage(t, errors.ctmtqg)}>
          <input id="register-ctmtqg" inputMode="decimal" value={form.ctmtqg} aria-invalid={errors.ctmtqg !== undefined} onChange={(event) => setField('ctmtqg', event.target.value)} />
        </Field>
      </div>
      <Field id="register-reason" label={t('cap.schedule.reason.label')} hint={t('cap.schedule.reason.hint')} error={errors.reason === undefined ? undefined : t('cap.schedule.reason.tooLong.error')}>
        <textarea id="register-reason" value={form.reason} maxLength={REASON_MAX} aria-invalid={errors.reason !== undefined} onChange={(event) => setField('reason', event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="button primary" disabled={register.isPending}>
          {register.isPending ? t('cap.schedule.save.pending') : t('cap.schedule.save.action')}
        </button>
      </div>
    </form>
  );
}
