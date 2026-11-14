import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { BackLink, Field } from './components';
import { PlanRefusal } from './plan-components';
import { useCreatePlan, useLineChoices, usePackages, usePlans, useProjectChoices } from './plan-hooks';
import { biddingFormLabel, contractTypeLabel, methodLabel, planFieldMessage } from './plan-labels';
import {
  BIDDING_FORMS,
  CONTRACT_TYPES,
  EMPTY_PLAN_FORM,
  MANAGE_PLAN_PERMISSION,
  PLANS_PATH,
  SELECTION_METHODS,
  describeProblem,
  emptyRow,
  formatVnd,
  hasErrors,
  planLink,
  rowsOf,
  sumVnd,
  validatePlan,
} from './plan-model';
import type { BiddingForm, ContractType, FieldProblem, PackageRow, PlanErrors, PlanForm, SelectionMethod } from './plan-model';
import './bid.css';
import { StickyActions } from '../../ui';

/**
 * BID-16: drafting and revising a procurement plan. A plan is never edited once made: a change is a new revision, which starts from the packages
 * of the plan it revises. The packages name the line of capital that pays for each; the server checks their sums against the lines when the plan
 * is submitted, and the screen shows the running sum so the planner sees the figure first (ST-BID-001).
 */
export default function ProcurementPlanEditorScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <EditorContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function EditorContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params] = useSearchParams();
  const reviseId = params.get('revise') ?? undefined;
  const mayPlan = mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(MANAGE_PLAN_PERMISSION));
  const create = useCreatePlan();
  const plans = usePlans();
  const packages = usePackages();
  const projects = useProjectChoices();
  const lines = useLineChoices();
  const [form, setForm] = useState<PlanForm>(EMPTY_PLAN_FORM);
  const [errors, setErrors] = useState<PlanErrors>({ packages: {} });
  const [seeded, setSeeded] = useState(false);
  const refused = create.isError ? describeProblem(create.error) : undefined;
  // What the reads of a revision say while its form is not there yet: loading, or why the plan could not be read.
  const reading = useScreenState({ isLoading: true, error: plans.error ?? packages.error, data: undefined });

  // A revision starts from the plan it revises: its project, its text and its packages, once they have been read.
  const base = (plans.data ?? []).find((plan) => plan.id === reviseId);
  useEffect(() => {
    if (seeded || reviseId === undefined || base === undefined || packages.data === undefined) return;
    setForm({ projectId: base.project.id, title: base.title, legalBasis: base.legalBasis, rows: rowsOf(packages.data.filter((item) => item.planId === base.id)) });
    setSeeded(true);
  }, [seeded, reviseId, base, packages.data]);

  const lineChoices = useMemo(() => (lines.data ?? []).filter((line) => form.projectId.trim() === '' || line.projectId === form.projectId.trim().toLowerCase()), [lines.data, form.projectId]);
  const total = useMemo(() => sumVnd(form.rows.map((row) => (/^\d+$/.test(row.budget.trim()) ? row.budget.trim() : '0'))), [form.rows]);

  const touch = (): void => {
    create.reset();
  };
  const setHead = (field: 'projectId' | 'title' | 'legalBasis', value: string): void => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    touch();
  };
  const setRow = (key: string, change: Partial<PackageRow>): void => {
    setForm((previous) => ({ ...previous, rows: previous.rows.map((row) => (row.key === key ? { ...row, ...change } : row)) }));
    setErrors((previous) => ({ ...previous, packages: { ...previous.packages, [key]: {} } }));
    touch();
  };
  const message = (problem: FieldProblem | undefined): string | undefined => (problem === undefined ? undefined : planFieldMessage(t, problem));

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending) return;
    const found = validatePlan(form);
    setErrors(found);
    if (hasErrors(found)) return;
    create.mutate(form);
  };

  if (!mayPlan) {
    return (
      <section data-screen-id={route.id} aria-labelledby="screen-title">
        <BackLink to={PLANS_PATH}>{t('bid.back.plans.link')}</BackLink>
        <div className="heading">
          <h1 id="screen-title">{t('bid.editor.page.title')}</h1>
        </div>
        <p className="callout warning" role="status" data-testid="read-only">
          {t('bid.editor.readOnly.notice')}
        </p>
      </section>
    );
  }

  // The form of a revision is offered once the plan it revises has been read. Drawn before that it was an empty form that took what the person did (a row added, a field typed) and lost it when the plan arrived and
  // replaced the form; a plan that is not there, or not for this person, is said in words and no empty form stands in for it.
  if (reviseId !== undefined && !seeded) {
    const absent = plans.data !== undefined && packages.data !== undefined && base === undefined;
    return (
      <section data-screen-id={route.id} aria-labelledby="screen-title">
        <BackLink to={PLANS_PATH}>{t('bid.back.plans.link')}</BackLink>
        <div className="heading">
          <h1 id="screen-title">{t('bid.editor.revise.title')}</h1>
        </div>
        {absent ? (
          <p className="callout warning" role="status" data-testid="revise-missing">
            {t('bid.plans.missing.notice')}
          </p>
        ) : (
          <div data-testid="revise-reading">
            <StateBoundary
              state={reading}
              onRetry={() => {
                void plans.refetch();
                void packages.refetch();
              }}
            />
          </div>
        )}
      </section>
    );
  }

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={PLANS_PATH}>{t('bid.back.plans.link')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{reviseId === undefined ? t('bid.editor.page.title') : t('bid.editor.revise.title')}</h1>
          <p>{t('bid.editor.page.subtitle')}</p>
        </div>
      </div>
      <form className="card" onSubmit={send} noValidate aria-label={t('bid.editor.form.title')} data-testid="plan-form">
        {refused === undefined ? null : <PlanRefusal problem={refused} testId="create-refusal" />}
        {create.isSuccess ? (
          <p className="callout" role="status" data-testid="create-done">
            {t('bid.editor.done.notice')} {create.data.resource_id === undefined ? null : <Link to={planLink(create.data.resource_id)}>{t('bid.editor.open.link')}</Link>}
          </p>
        ) : null}
        <div className="formgrid">
          <Field id="plan-projectId" label={t('bid.editor.project.label')} error={message(errors.projectId)} hint={t('bid.editor.project.hint')}>
            <input id="plan-projectId" list="plan-projects" value={form.projectId} aria-invalid={errors.projectId !== undefined} onChange={(event) => setHead('projectId', event.target.value)} />
            <datalist id="plan-projects">
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {`${project.code} ${project.name}`}
                </option>
              ))}
            </datalist>
          </Field>
          <Field id="plan-title" label={t('bid.editor.title.label')} error={message(errors.title)}>
            <input id="plan-title" value={form.title} aria-invalid={errors.title !== undefined} onChange={(event) => setHead('title', event.target.value)} />
          </Field>
          <Field id="plan-legalBasis" label={t('bid.editor.basis.label')} error={message(errors.legalBasis)}>
            <textarea id="plan-legalBasis" rows={2} value={form.legalBasis} aria-invalid={errors.legalBasis !== undefined} onChange={(event) => setHead('legalBasis', event.target.value)} />
          </Field>
        </div>
        <datalist id="plan-lines">
          {lineChoices.map((line) => (
            <option key={line.id} value={line.id}>
              {line.label}
            </option>
          ))}
        </datalist>
        <h2>{t('bid.editor.packages.title')}</h2>
        {errors.rows === undefined ? null : (
          <p role="alert" className="field-error">
            {message(errors.rows)}
          </p>
        )}
        {form.rows.map((row, index) => (
          <fieldset key={row.key} className="bid-package-row" data-testid="package-row" aria-label={t('bid.editor.row.title', { number: index + 1 })}>
            <legend>{t('bid.editor.row.title', { number: index + 1 })}</legend>
            <div className="formgrid">
              <RowInput id={`${row.key}-code`} label={t('bid.editor.row.code')} value={row.code} error={message(errors.packages[row.key]?.code)} onChange={(value) => setRow(row.key, { code: value })} />
              <RowInput id={`${row.key}-title`} label={t('bid.editor.row.title.label')} value={row.title} error={message(errors.packages[row.key]?.title)} onChange={(value) => setRow(row.key, { title: value })} />
              <RowInput
                id={`${row.key}-budget`}
                label={t('bid.editor.row.budget')}
                hint={t('bid.editor.row.budgetHint')}
                value={row.budget}
                inputMode="numeric"
                error={message(errors.packages[row.key]?.budget)}
                onChange={(value) => setRow(row.key, { budget: value })}
              />
              <Field id={`${row.key}-method`} label={t('bid.editor.row.method')} error={undefined}>
                <select id={`${row.key}-method`} value={row.method} onChange={(event) => setRow(row.key, { method: event.target.value as SelectionMethod })}>
                  {SELECTION_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {methodLabel(t, method)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id={`${row.key}-contractType`} label={t('bid.editor.row.contractType')} error={undefined}>
                <select id={`${row.key}-contractType`} value={row.contractType} onChange={(event) => setRow(row.key, { contractType: event.target.value as ContractType })}>
                  {CONTRACT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {contractTypeLabel(t, type)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id={`${row.key}-biddingForm`} label={t('bid.editor.row.form')} error={undefined}>
                <select id={`${row.key}-biddingForm`} value={row.biddingForm} onChange={(event) => setRow(row.key, { biddingForm: event.target.value as BiddingForm })}>
                  {BIDDING_FORMS.map((biddingForm) => (
                    <option key={biddingForm} value={biddingForm}>
                      {biddingFormLabel(t, biddingForm)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id={`${row.key}-allocationLineId`} label={t('bid.editor.row.line')} error={message(errors.packages[row.key]?.allocationLineId)} hint={t('bid.editor.row.lineHint')}>
                <input
                  id={`${row.key}-allocationLineId`}
                  list="plan-lines"
                  value={row.allocationLineId}
                  aria-invalid={errors.packages[row.key]?.allocationLineId !== undefined}
                  onChange={(event) => setRow(row.key, { allocationLineId: event.target.value })}
                />
              </Field>
              <RowInput id={`${row.key}-period`} label={t('bid.editor.row.period')} hint={t('bid.editor.row.periodHint')} value={row.period} error={message(errors.packages[row.key]?.period)} onChange={(value) => setRow(row.key, { period: value })} />
              <RowInput
                id={`${row.key}-duration`}
                label={t('bid.editor.row.duration')}
                value={row.duration}
                inputMode="numeric"
                error={message(errors.packages[row.key]?.duration)}
                onChange={(value) => setRow(row.key, { duration: value })}
              />
            </div>
            <button
              type="button"
              disabled={form.rows.length === 1}
              onClick={() => {
                setForm((previous) => ({ ...previous, rows: previous.rows.filter((other) => other.key !== row.key) }));
                touch();
              }}
            >
              {t('bid.editor.row.remove')}
            </button>
          </fieldset>
        ))}
        <p className="sub" data-testid="running-total">
          {t('bid.editor.total.text', { total: formatVnd(total) })}
        </p>
        <StickyActions
          primary={
            <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending}>
              {t('bid.editor.submit.action')}
            </button>
          }
          secondary={[
            <button
              key="add"
              type="button"
              className="ui-button ui-button--outline"
              onClick={() => {
                setForm((previous) => ({ ...previous, rows: [...previous.rows, emptyRow()] }));
                touch();
              }}
            >
              {t('bid.editor.row.add')}
            </button>,
          ]}
        />
      </form>
      <p className="prototype-note">{t('bid.editor.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function RowInput({ id, label, hint, value, error, inputMode, onChange }: { id: string; label: string; hint?: string; value: string; error: string | undefined; inputMode?: 'numeric'; onChange: (value: string) => void }) {
  return (
    <Field id={id} label={label} error={error} {...(hint === undefined ? {} : { hint })}>
      <input id={id} value={value} aria-invalid={error !== undefined} {...(inputMode === undefined ? {} : { inputMode })} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}
