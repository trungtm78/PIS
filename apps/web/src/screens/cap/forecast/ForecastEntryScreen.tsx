import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { mayAct } from '../approval-model';
import { Field, Money } from '../components';
import { levelLabel } from '../labels';
import { useProjects } from '../plan-hooks';
import { BUCKETS } from '../plan-model';
import type { Bucket } from '../plan-model';
import { monthLabel, scheduleProblemMessage, sourceLabel } from '../schedule-labels';
import { ADJUSTMENT_MONTH, BUDGET_LEVELS, MONTHS, REASON_MAX, REGISTER_SCHEDULE_PERMISSION, SCHEDULABLE_STATUSES, describeScheduleProblem } from '../schedule-model';
import type { BudgetLevel } from '../schedule-model';
import '../cap.css';
import { EacPanel, NONE, Picker, useChoice } from './components';
import { useRegisterForecast, useScheduleLines } from './hooks';
import { assumptionMessage } from './labels';
import { ASSUMPTION_MAX, EAC_READ_PERMISSION, EMPTY_FORECAST, PLAN_PATH, READ_PERMISSION, estimatesOf, forecastBody, formOf, linkTo, mayRead, validateForecast } from './model';
import type { ForecastErrors, ForecastField, ForecastForm, ScheduleLine } from './model';
import { unchanged } from '../../unsent';

/**
 * CAP-13: the entry of the estimated disbursement of a month (ST-CAP-012, CAP 3.1 F7): the investor picks a project and a year, and for a month and a source group types what is expected to be paid at the end of the period
 * and the assumption it rests on; an estimate without its assumption is not sent. Entering a month again makes a new revision and the old one is kept. The year-end estimate (EAC) beside the form is read from DIS and moves
 * with the estimate. Whoever may not register sees the estimates in force without the form.
 */
export default function ForecastEntryScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The entry belongs to one person in one tenant: a move to another starts the screen over, with no half-typed estimate left for the other.
  return <EntryContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function EntryContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const readable = mayRead(permissions, READ_PERMISSION);
  const projects = useProjects(readable);
  const offered = (projects.data ?? []).filter((project) => SCHEDULABLE_STATUSES.includes(project.status));
  const { selected, typedYear, year, chooseProject, chooseYear } = useChoice(offered);
  const lines = useScheduleLines(selected?.id, year, readable);
  // The choice and the form stay on screen while a project or a year is read: only the register of projects replaces the whole screen, the estimates have their own card.
  const state = useScreenState({ isLoading: readable && projects.isLoading, error: readable ? projects.error : undefined, data: readable ? offered : undefined });
  const linesState = useScreenState({ isLoading: lines.isLoading, error: lines.error, data: lines.data, isEmpty: () => false });
  const [form, setForm] = useState<ForecastForm>(EMPTY_FORECAST);
  const estimates = estimatesOf(lines.data ?? []);
  const allowed = mayAct(permissions, mode, REGISTER_SCHEDULE_PERMISSION);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.estimate.page.title')}</h1>
          <p>{t('cap.estimate.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={readable ? state : 'denied'} onRetry={() => void projects.refetch()}>
        {selected === undefined ? null : (
          <>
            <Picker
              id="entry"
              offered={offered}
              selected={selected}
              typedYear={typedYear}
              yearValid={year !== undefined}
              onProject={(id) => {
                setForm(() => EMPTY_FORECAST);
                chooseProject(id);
              }}
              onYear={(value) => {
                setForm(() => EMPTY_FORECAST);
                chooseYear(value);
              }}
            />
            <p className="callout" role="note" data-testid="promise">
              {t('cap.estimate.note.assumption.notice')}
            </p>
            <EacPanel projectId={selected.id} allowed={mayRead(permissions, EAC_READ_PERMISSION)} />
            {year === undefined ? null : (
              <EstimateTable estimates={estimates} year={year} allowed={allowed} state={linesState} onRetry={() => void lines.refetch()} onChange={(line) => setForm(formOf(line, locale))} />
            )}
            {year === undefined ? null : allowed ? (
              <EntryForm key={`${selected.id}:${year}`} projectId={selected.id} year={year} estimates={estimates} form={form} setForm={setForm} locale={locale} />
            ) : (
              <p className="callout" role="status" data-testid="entry-denied">
                {mode === 'READ_ONLY' ? t('cap.readOnly.frozen.notice') : t('cap.estimate.denied.notice')}
              </p>
            )}
            <p>
              <Link className="button" to={linkTo(PLAN_PATH, selected.id, typedYear)} data-testid="back-to-plan">
                {t('cap.estimate.plan.action')}
              </Link>
            </p>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('cap.estimate.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface TableProps {
  estimates: readonly ScheduleLine[];
  year: number;
  allowed: boolean;
  state: ScreenState;
  onRetry(): void;
  onChange(line: ScheduleLine): void;
}

function EstimateTable({ estimates, year, allowed, state, onRetry, onChange }: TableProps) {
  const { t } = useTranslation();
  return (
    <div className="card" data-testid="estimates" data-year={year}>
      <h2>{t('cap.estimate.table.title', { year })}</h2>
      <StateBoundary state={state} onRetry={onRetry}>
        {estimates.length === 0 ? (
          <p className="callout" role="status" data-testid="no-estimate">
            {t('cap.estimate.empty.notice')}
          </p>
        ) : (
          <div className="cap-scroll">
            <table className="table cap-table" aria-label={t('cap.estimate.table.aria', { year })}>
              <thead>
                <tr>
                  <th scope="col">{t('cap.estimate.column.month')}</th>
                  <th scope="col">{t('cap.estimate.column.source')}</th>
                  <th scope="col">{t('cap.estimate.column.level')}</th>
                  <th scope="col" className="cap-number">
                    {t('cap.estimate.column.amount')}
                  </th>
                  <th scope="col">{t('cap.estimate.column.assumption')}</th>
                  <th scope="col">{t('cap.estimate.column.revision')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('cap.estimate.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {estimates.map((line) => (
                  <tr key={line.id} data-estimate={line.id} data-month={line.month}>
                    <th scope="row">{monthLabel(t, line.month, line.month === ADJUSTMENT_MONTH)}</th>
                    <td>{sourceLabel(t, line.bucket)}</td>
                    <td>{levelLabel(t, line.budgetLevel)}</td>
                    <td className="cap-number">
                      <Money vnd={line.amountVnd} />
                    </td>
                    <td data-testid="assumption">{line.assumption ?? NONE}</td>
                    <td>{line.revision}</td>
                    <td>
                      {allowed ? (
                        <button type="button" onClick={() => onChange(line)}>
                          {t('cap.estimate.change.action', { month: line.month })}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </StateBoundary>
    </div>
  );
}

interface FormProps {
  projectId: string;
  year: number;
  estimates: readonly ScheduleLine[];
  form: ForecastForm;
  setForm(update: (form: ForecastForm) => ForecastForm): void;
  locale: string;
}

function EntryForm({ projectId, year, estimates, form, setForm, locale }: FormProps) {
  const { t } = useTranslation();
  const register = useRegisterForecast();
  const [errors, setErrors] = useState<ForecastErrors>({});
  const [saved, setSaved] = useState<number | undefined>(undefined);
  const problem = register.isError ? describeScheduleProblem(register.error) : undefined;
  const setField = <K extends ForecastField>(field: K, value: ForecastForm[K]): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setSaved(undefined);
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (register.isPending) return;
    const found = validateForecast(form, locale);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const before = estimates.find((line) => line.month === Number(form.month) && line.bucket === form.bucket && line.budgetLevel === form.budgetLevel);
    register.mutate(forecastBody(form, projectId, year, locale), {
      onSuccess: () => {
        setSaved((before?.revision ?? 0) + 1);
        setForm((current) => (unchanged(current, form) ? EMPTY_FORECAST : current));
      },
    });
  };
  return (
    <form className="card cap-form" data-testid="entry" aria-label={t('cap.estimate.form.title')} onSubmit={submit} noValidate>
      <h2>{t('cap.estimate.form.title')}</h2>
      {saved === undefined ? null : (
        <p className="callout" role="status" data-testid="saved">
          {t('cap.estimate.save.done', { revision: saved })}
        </p>
      )}
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="problem" data-problem={problem}>
          {scheduleProblemMessage(t, problem)}
        </p>
      )}
      <div className="cap-filters">
        <Field id="entry-month" label={t('cap.estimate.month.label')} error={errors.month === undefined ? undefined : t('cap.schedule.month.required.error')}>
          <select id="entry-month" value={form.month} aria-invalid={errors.month !== undefined} onChange={(event) => setField('month', event.target.value)}>
            <option value="">{t('cap.schedule.month.placeholder')}</option>
            {MONTHS.map((value) => (
              <option key={value} value={String(value)}>
                {monthLabel(t, value, value === ADJUSTMENT_MONTH)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="entry-bucket" label={t('cap.schedule.bucket.label')} error={undefined}>
          <select id="entry-bucket" value={form.bucket} onChange={(event) => setField('bucket', event.target.value as Bucket)}>
            {BUCKETS.map((bucket) => (
              <option key={bucket} value={bucket}>
                {sourceLabel(t, bucket)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="entry-level" label={t('cap.schedule.level.label')} error={undefined}>
          <select id="entry-level" value={form.budgetLevel} onChange={(event) => setField('budgetLevel', event.target.value as BudgetLevel)}>
            {BUDGET_LEVELS.map((level) => (
              <option key={level} value={level}>
                {levelLabel(t, level)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="entry-amount"
          label={t('cap.estimate.amount.label')}
          error={errors.amount === undefined ? undefined : errors.amount === 'required' ? t('cap.schedule.amount.required.error') : t('cap.schedule.amount.invalid.error')}
        >
          <input id="entry-amount" inputMode="decimal" value={form.amount} aria-invalid={errors.amount !== undefined} onChange={(event) => setField('amount', event.target.value)} />
        </Field>
      </div>
      <Field
        id="entry-assumption"
        label={t('cap.estimate.assumption.label')}
        hint={t('cap.estimate.assumption.hint')}
        error={errors.assumption === undefined ? undefined : assumptionMessage(t, errors.assumption)}
      >
        <textarea
          id="entry-assumption"
          value={form.assumption}
          maxLength={ASSUMPTION_MAX}
          aria-invalid={errors.assumption !== undefined}
          onChange={(event) => setField('assumption', event.target.value)}
        />
      </Field>
      <Field id="entry-reason" label={t('cap.estimate.reason.label')} hint={t('cap.estimate.reason.hint')} error={errors.reason === undefined ? undefined : t('cap.schedule.reason.tooLong.error')}>
        <textarea id="entry-reason" value={form.reason} maxLength={REASON_MAX} aria-invalid={errors.reason !== undefined} onChange={(event) => setField('reason', event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="button primary" disabled={register.isPending}>
          {register.isPending ? t('cap.estimate.save.pending') : t('cap.estimate.save.action')}
        </button>
      </div>
    </form>
  );
}
