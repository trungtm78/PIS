import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import { SectionCard } from '../../../ui';
import { Field } from '../components';
import { Banner } from './components';
import { usePropose } from './hooks';
import { FIGURE_KINDS, GRAINS, describeProblem, formProblems, grainOfKind, ordinalsOf, proposalBody, todayOf, camel } from './model';
import type { BatchField, BatchForm as Form, FigureKind, FundingTaxonomy, Grain } from './model';
import { useReopenProjects } from '../hooks';

const EMPTY = (taxonomy: FundingTaxonomy): Form => ({
  projectId: '',
  classCode: taxonomy.classes[0]?.code ?? '',
  tierCode: taxonomy.tiers[0]?.code ?? '',
  measure: taxonomy.measures[0] ?? 'DISBURSED',
  kind: 'ESTIMATE',
  grain: 'MONTH',
  planYear: Number(todayOf().slice(0, 4)),
  asOfDate: todayOf(),
  amounts: {},
  explanation: '',
  basis: 'REPORTED',
  adjustsPlanYear: '',
  adjustsOrdinal: '',
  decisionDocumentId: '',
});

/**
 * The form that prepares a batch (DIS-28): which project, class and tier, which measure, which kind of figure (the phasing of the plan by quarter or month, an estimate, an actual, a late adjustment), the year, the day
 * the figure is known from, and one amount for each period. The form says what is wrong before it sends, naming the field; the server judges the identities again (the sum of the quarters against the year plan, a locked
 * period, an estimate after an actual). Nothing is sent until the person asks, and the batch is a draft until somebody other than the preparer accepts it.
 */
export function BatchForm({ taxonomy, onSaved }: { taxonomy: FundingTaxonomy; onSaved: () => void }) {
  const { t } = useTranslation();
  const projects = useReopenProjects(true);
  const propose = usePropose();
  const [form, setForm] = useState<Form>(() => EMPTY(taxonomy));
  const [shown, setShown] = useState<BatchField[]>([]);
  const grain: Grain = grainOfKind(form.kind, form.grain);
  const update = (patch: Partial<Form>): void => setForm((current) => ({ ...current, ...patch, grain: grainOfKind((patch.kind ?? current.kind) as FigureKind, (patch.grain ?? current.grain) as Grain) }));
  const submit = (): void => {
    const problems = formProblems({ ...form, grain }, taxonomy.phasing_must_sum === true);
    setShown(problems);
    if (problems.length > 0) return;
    propose.mutate(
      { body: proposalBody({ ...form, grain }) },
      {
        onSuccess: () => {
          setForm(EMPTY(taxonomy));
          onSaved();
        },
      },
    );
  };
  const error = (field: BatchField): string | undefined => (shown.includes(field) ? t(`dis.funding.field.${camel(field)}`) : undefined);
  const problem = propose.error === null ? undefined : describeProblem(propose.error);
  const classes = taxonomy.classes;
  const tiers = taxonomy.tiers;

  return (
    <SectionCard title={t('dis.funding.form.title')}>
      <form
        className="dis-funding-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        noValidate
      >
        <Field id="fnd-project" label={t('dis.funding.form.project')} error={error('project')}>
          <select id="fnd-project" value={form.projectId} onChange={(event) => update({ projectId: event.target.value })}>
            <option value="">{t('dis.funding.form.project.choose')}</option>
            {(projects.data ?? []).map((one) => (
              <option key={one.id} value={one.id}>
                {one.code} · {one.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="fnd-class" label={t('dis.funding.form.class')} error={error('class')}>
          <select id="fnd-class" value={form.classCode} onChange={(event) => update({ classCode: event.target.value })}>
            {classes.map((one) => (
              <option key={one.code} value={one.code}>
                {one.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="fnd-tier" label={t('dis.funding.form.tier')} error={undefined}>
          <select id="fnd-tier" value={form.tierCode} onChange={(event) => update({ tierCode: event.target.value })}>
            {tiers.map((one) => (
              <option key={one.code} value={one.code}>
                {one.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="fnd-measure" label={t('dis.funding.form.measure')} error={undefined}>
          <select id="fnd-measure" value={form.measure} onChange={(event) => update({ measure: event.target.value })}>
            {taxonomy.measures.map((one) => (
              <option key={one} value={one}>
                {t(`dis.funding.measure.${camel(one)}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="fnd-kind" label={t('dis.funding.form.kind')} error={undefined}>
          <select id="fnd-kind" value={form.kind} onChange={(event) => update({ kind: event.target.value as FigureKind, amounts: {} })}>
            {FIGURE_KINDS.filter((one) => (one !== 'PLAN_YEAR' && one !== 'PLAN_ADJUSTED') || form.measure !== 'DISBURSED').map((one) => (
              <option key={one} value={one}>
                {t(`dis.funding.kind.${camel(one)}`)}
              </option>
            ))}
          </select>
        </Field>
        {form.kind === 'ESTIMATE' || form.kind === 'ACTUAL' ? (
          <Field id="fnd-grain" label={t('dis.funding.form.grain')} error={undefined}>
            <select id="fnd-grain" value={form.grain} onChange={(event) => update({ grain: event.target.value as Grain, amounts: {} })}>
              {GRAINS.filter((one) => one !== 'YEAR' || form.kind === 'ESTIMATE').map((one) => (
                <option key={one} value={one}>
                  {t(`dis.funding.grain.${camel(one)}`)}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {form.kind === 'ACTUAL' ? (
          <Field id="fnd-basis" label={t('dis.funding.form.basis')} error={undefined}>
            <select id="fnd-basis" value={form.basis} onChange={(event) => update({ basis: event.target.value as Form['basis'], amounts: {} })}>
              {(['REPORTED', 'ADJUSTMENT', 'OPENING_BALANCE'] as const).map((one) => (
                <option key={one} value={one}>
                  {t(`dis.funding.basis.${camel(one)}`)}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field id="fnd-plan-year" label={t('dis.funding.form.year')} error={undefined}>
          <input id="fnd-plan-year" type="number" min={1990} max={2100} value={form.planYear} onChange={(event) => update({ planYear: Number(event.target.value) })} />
        </Field>
        <Field id="fnd-as-of" label={t('dis.funding.form.asOf')} hint={t('dis.funding.form.asOf.hint')} error={error('asOf')}>
          <input id="fnd-as-of" type="date" value={form.asOfDate} onChange={(event) => update({ asOfDate: event.target.value })} />
        </Field>
        {form.basis === 'ADJUSTMENT' && form.kind === 'ACTUAL' ? (
          <Field id="fnd-adjusts" label={t('dis.funding.form.adjusts')} hint={t('dis.funding.form.adjusts.hint')} error={error('adjusts')}>
            <span>
              <input id="fnd-adjusts" aria-label={t('dis.funding.form.adjusts.year')} type="number" min={1990} max={2100} value={form.adjustsPlanYear} onChange={(event) => update({ adjustsPlanYear: event.target.value })} />
              <select aria-label={t('dis.funding.form.adjusts.month')} value={form.adjustsOrdinal} onChange={(event) => update({ adjustsOrdinal: event.target.value })}>
                <option value="" />
                {ordinalsOf('MONTH').map((one) => (
                  <option key={one} value={one}>
                    {one}
                  </option>
                ))}
              </select>
            </span>
          </Field>
        ) : null}
        {form.kind === 'PLAN_ADJUSTED' ? (
          <Field id="fnd-decision" label={t('dis.funding.form.decision')} error={error('decision')}>
            <input id="fnd-decision" value={form.decisionDocumentId} onChange={(event) => update({ decisionDocumentId: event.target.value })} />
          </Field>
        ) : null}
        <fieldset className="dis-funding-amounts" aria-invalid={shown.includes('amounts')}>
          <legend>{t('dis.funding.form.amounts')}</legend>
          {(form.basis === 'OPENING_BALANCE' && form.kind === 'ACTUAL' ? [0] : form.basis === 'ADJUSTMENT' && form.kind === 'ACTUAL' ? [] : ordinalsOf(grain)).map((ordinal) => (
            <label key={ordinal}>
              <span>{t(`dis.funding.period.${camel(grain)}`, { n: ordinal === 0 ? form.planYear : ordinal })}</span>
              <input inputMode="numeric" value={form.amounts[ordinal] ?? ''} onChange={(event) => update({ amounts: { ...form.amounts, [ordinal]: event.target.value } })} />
            </label>
          ))}
          {form.basis === 'ADJUSTMENT' && form.kind === 'ACTUAL' ? (
            <label>
              <span>{t('dis.funding.form.adjustment.amount')}</span>
              <select aria-label={t('dis.funding.form.adjustment.booked')} value={Object.keys(form.amounts)[0] ?? ''} onChange={(event) => update({ amounts: { [event.target.value]: Object.values(form.amounts)[0] ?? '' } })}>
                <option value="" />
                {ordinalsOf('MONTH').map((one) => (
                  <option key={one} value={one}>
                    {one}
                  </option>
                ))}
              </select>
              <input inputMode="numeric" value={Object.values(form.amounts)[0] ?? ''} onChange={(event) => update({ amounts: { [Object.keys(form.amounts)[0] ?? String(new Date().getMonth() + 1)]: event.target.value } })} />
            </label>
          ) : null}
          {error('amounts') === undefined ? null : <span role="alert">{error('amounts')}</span>}
          {taxonomy.phasing_must_sum === true && (form.kind === 'PLAN_QUARTER' || form.kind === 'PLAN_MONTH') ? <small>{t('dis.funding.form.amounts.mustSum')}</small> : null}
        </fieldset>
        <Field id="fnd-explanation" label={t('dis.funding.form.explanation')} hint={t('dis.funding.form.explanation.hint')} error={error('explanation')}>
          <textarea id="fnd-explanation" rows={3} value={form.explanation} onChange={(event) => update({ explanation: event.target.value })} />
        </Field>
        {problem === undefined ? null : (
          <Banner tone="warning" testId="problem">
            {t(`dis.funding.problem.${camel(problem)}`)}
          </Banner>
        )}
        <div className="dis-funding-actions">
          <button type="submit" className="ui-button" disabled={propose.isPending}>
            {t('dis.funding.form.save')}
          </button>
          <small>{t('dis.funding.form.makerChecker')}</small>
        </div>
      </form>
    </SectionCard>
  );
}
