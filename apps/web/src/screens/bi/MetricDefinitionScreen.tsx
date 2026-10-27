import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { AGGREGATES, AGGREGATIONS, CATALOGUE_PATH, EMPTY_VALUES, MANAGE_PERMISSION, NULL_POLICIES, describeProblem, metricFormula, validateMetric } from './bi-model';
import type { Aggregate, Aggregation, Metric, MetricErrors, MetricValues, NullPolicy, Operand } from './bi-model';
import { useCreateMetric, useMetric } from './hooks';
import { aggregateLabel, aggregationLabel, fieldProblemMessage, nullPolicyLabel, originLabel, problemMessage, statusLabel } from './labels';

/**
 * BI-06: the definition of a metric (ST-BI-001, BI 3 F1). With an id it shows one revision, read-only: a metric of the platform changes by the files of the repository, and a draft of the tenant is judged
 * by its certifier, a person other than its author. Without one it is the form that drafts a metric of the tenant: the formula is an aggregate over a field of the dataset (a ratio has a numerator and a
 * denominator), so a node outside the allowed grammar cannot be written here; the server judges again.
 */
export default function MetricDefinitionScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  const [params] = useSearchParams();
  const id = params.get('id') ?? undefined;
  // What is open belongs to one member of one tenant and one revision: a switch starts the screen over.
  return <DefinitionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${id ?? 'new'}`} route={route} id={id} />;
}

function DefinitionContent({ route, id }: ScreenProps & { id: string | undefined }) {
  const { t } = useTranslation();
  const metric = useMetric(id);
  const state = useScreenState({ isLoading: id !== undefined && metric.isLoading, error: id === undefined ? undefined : metric.error, data: id === undefined ? [] : metric.data, isEmpty: () => false });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.definition.page.title')}</h1>
          <p>{t('bi.definition.page.subtitle')}</p>
        </div>
        <Link className="button" to={CATALOGUE_PATH}>
          {t('bi.definition.back')}
        </Link>
      </div>
      <StateBoundary state={state} onRetry={() => void metric.refetch()}>
        {id === undefined ? <MetricForm /> : metric.data === undefined ? null : <MetricView metric={metric.data} />}
      </StateBoundary>
    </section>
  );
}

function MetricView({ metric }: { metric: Metric }) {
  const { t } = useTranslation();
  const rows: Array<[string, string]> = [
    [t('bi.definition.field.code'), `${metric.code} (${t('bi.catalogue.revision', { revision: metric.revision })})`],
    [t('bi.definition.field.formula'), metricFormula(metric)],
    [t('bi.definition.field.grain'), metric.grain],
    [t('bi.definition.field.aggregation'), aggregationLabel(t, metric.aggregationType)],
    [t('bi.definition.field.unit'), metric.unit],
    [t('bi.definition.field.nullPolicy'), nullPolicyLabel(t, metric.nullPolicy)],
    [t('bi.definition.field.dimensions'), metric.dimensionCodes.length === 0 ? t('bi.catalogue.none') : metric.dimensionCodes.join(', ')],
    [t('bi.definition.field.effective'), `${metric.effectiveFrom ?? t('bi.catalogue.none')} → ${metric.effectiveUntil ?? t('bi.definition.open')}`],
    [t('bi.definition.field.origin'), originLabel(t, metric.origin)],
    [t('bi.definition.field.commit'), metric.sourceCommit ?? t('bi.catalogue.none')],
    [t('bi.definition.field.hash'), metric.definitionSha256 ?? t('bi.catalogue.none')],
    [t('bi.definition.field.status'), statusLabel(t, metric.status)],
  ];
  return (
    <section className="card" aria-labelledby="metric-view-title" data-testid="metric-view" data-origin={metric.origin}>
      <h2 id="metric-view-title">{metric.code}</h2>
      {metric.origin === 'PLATFORM_CODE' ? (
        <p className="pill" data-testid="metric-platform-note">
          {t('bi.definition.platformNote')}
        </p>
      ) : null}
      <dl className="mne-lines">
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function OperandFields({ id, name, label, operand, error, onChange }: { id: string; name: string; label: string; operand: Operand; error: string | undefined; onChange: (next: Operand) => void }) {
  const { t } = useTranslation();
  return (
    <fieldset className="mne-filters" data-operand={name}>
      <legend>{label}</legend>
      <Field id={`${id}-aggregate`} label={t('bi.definition.aggregate.label')} error={undefined}>
        <select id={`${id}-aggregate`} value={operand.aggregate} onChange={(event) => onChange({ ...operand, aggregate: event.target.value as Aggregate })}>
          {AGGREGATES.map((aggregate) => (
            <option key={aggregate} value={aggregate}>
              {aggregateLabel(t, aggregate)}
            </option>
          ))}
        </select>
      </Field>
      <Field id={`${id}-field`} label={t('bi.definition.operandField.label')} error={error} hint={t('bi.definition.operandField.hint')}>
        <input id={`${id}-field`} value={operand.field} aria-invalid={error !== undefined} onChange={(event) => onChange({ ...operand, field: event.target.value })} />
      </Field>
    </fieldset>
  );
}

function MetricForm() {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const create = useCreateMetric();
  const [values, setValues] = useState<MetricValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<MetricErrors>({});
  const may = (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';
  const refused = create.isError ? describeProblem(create.error) : undefined;
  const set = <K extends keyof MetricValues>(field: K, value: MetricValues[K]): void => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };
  const error = (field: keyof MetricErrors): string | undefined => {
    const problem = errors[field];
    return problem === undefined ? undefined : fieldProblemMessage(t, problem);
  };
  const ratio = values.aggregationType === 'ratio';
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending) return;
    const found = validateMetric(values);
    setErrors(found);
    if (Object.keys(found).length === 0) create.mutate(values);
  };
  if (!may) {
    return (
      <p className="callout warning" role="status" data-testid="metric-form-denied">
        {t('bi.definition.noPermission')}
      </p>
    );
  }
  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('bi.definition.form.title')}>
      <h2>{t('bi.definition.form.title')}</h2>
      <p className="sub">{t('bi.definition.form.hint')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="metric-refused">
          {problemMessage(t, refused)}
        </p>
      )}
      {create.isSuccess ? (
        <p className="callout" role="status" data-testid="metric-saved">
          {t('bi.definition.saved')}
        </p>
      ) : null}
      <div className="mne-filters">
        <Field id="metric-code" label={t('bi.definition.field.code')} error={error('code')} hint={t('bi.definition.code.hint')}>
          <input id="metric-code" value={values.code} aria-invalid={errors.code !== undefined} onChange={(event) => set('code', event.target.value)} />
        </Field>
        <Field id="metric-grain" label={t('bi.definition.field.grain')} error={error('grain')}>
          <input id="metric-grain" value={values.grain} aria-invalid={errors.grain !== undefined} onChange={(event) => set('grain', event.target.value)} />
        </Field>
        <Field id="metric-aggregation" label={t('bi.definition.field.aggregation')} error={undefined}>
          <select id="metric-aggregation" value={values.aggregationType} onChange={(event) => set('aggregationType', event.target.value as Aggregation)}>
            {AGGREGATIONS.map((aggregation) => (
              <option key={aggregation} value={aggregation}>
                {aggregationLabel(t, aggregation)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="metric-unit" label={t('bi.definition.field.unit')} error={error('unit')}>
          <input id="metric-unit" value={values.unit} aria-invalid={errors.unit !== undefined} onChange={(event) => set('unit', event.target.value)} />
        </Field>
      </div>
      {ratio ? (
        <>
          <OperandFields id="metric-numerator" name="numerator" label={t('bi.definition.numerator')} operand={values.numerator} error={error('numerator')} onChange={(next) => set('numerator', next)} />
          <OperandFields id="metric-denominator" name="denominator" label={t('bi.definition.denominator')} operand={values.denominator} error={error('denominator')} onChange={(next) => set('denominator', next)} />
        </>
      ) : (
        <OperandFields id="metric-expression" name="expression" label={t('bi.definition.expression')} operand={values.expression} error={error('expression')} onChange={(next) => set('expression', next)} />
      )}
      <div className="mne-filters">
        <Field id="metric-null-policy" label={t('bi.definition.field.nullPolicy')} error={undefined}>
          <select id="metric-null-policy" value={values.nullPolicy} onChange={(event) => set('nullPolicy', event.target.value as NullPolicy)}>
            {NULL_POLICIES.map((policy) => (
              <option key={policy} value={policy}>
                {nullPolicyLabel(t, policy)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="metric-dimensions" label={t('bi.definition.field.dimensions')} error={error('dimensions')} hint={t('bi.definition.dimensions.hint')}>
          <input id="metric-dimensions" value={values.dimensions} aria-invalid={errors.dimensions !== undefined} onChange={(event) => set('dimensions', event.target.value)} />
        </Field>
        <Field id="metric-dataset" label={t('bi.definition.field.dataset')} error={error('datasetId')}>
          <input id="metric-dataset" value={values.datasetId} aria-invalid={errors.datasetId !== undefined} onChange={(event) => set('datasetId', event.target.value)} />
        </Field>
        <Field id="metric-from" label={t('bi.definition.field.from')} error={error('effectiveFrom')}>
          <input id="metric-from" type="date" value={values.effectiveFrom} aria-invalid={errors.effectiveFrom !== undefined} onChange={(event) => set('effectiveFrom', event.target.value)} />
        </Field>
      </div>
      <div className="mne-actions">
        <button type="submit" className="btn" disabled={create.isPending}>
          {t('bi.definition.save')}
        </button>
      </div>
    </form>
  );
}
