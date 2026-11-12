import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { datasetSourceLabel, evalProblemMessage } from './eval-labels';
import { DATASET_SOURCES, EMPTY_DATASET, EVAL_MANAGE, MAX_CASES, validateDataset } from './eval-model';
import type { DatasetErrors, DatasetSource, DatasetValues } from './eval-model';
import { useCreateDataset, useDatasets } from './hooks';
import { classificationLabel, refusalMessage } from './labels';
import { describeLlmProblem } from './llm-model';
import './llm-kit.css';

/**
 * LLM-12: the datasets that models and profiles are evaluated on (ST-LLM-004, LLM F4): each is a numbered version of synthetic or anonymised cases (a case of real data that was not made harmless is not accepted) and it has at
 * least one case that tries to make the model leave its instructions, because a release that was never tried against that is not safe. A version does not change: a new one is made.
 */
export default function DatasetsScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <DatasetsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DatasetsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const may = (permissions === undefined || permissions.includes(EVAL_MANAGE)) && mode !== 'READ_ONLY';
  const datasets = useDatasets();
  const state = useScreenState({ isLoading: datasets.isLoading, error: datasets.error, data: datasets.data === undefined ? undefined : { rows: datasets.data } });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.datasets.page.title')}</h1>
          <p>{t('llm.datasets.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void datasets.refetch()}>
        <div className="tablewrap" role="region" aria-label={t('llm.datasets.table.aria')} tabIndex={0}>
          <table className="table" data-testid="dataset-table" aria-label={t('llm.datasets.table.aria')}>
            <thead>
              <tr>
                <th scope="col">{t('llm.datasets.column.code')}</th>
                <th scope="col">{t('llm.datasets.column.revision')}</th>
                <th scope="col">{t('llm.datasets.column.task')}</th>
                <th scope="col">{t('llm.datasets.column.source')}</th>
                <th scope="col">{t('llm.datasets.column.max')}</th>
                <th scope="col">{t('llm.datasets.column.cases')}</th>
                <th scope="col">{t('llm.datasets.column.injection')}</th>
              </tr>
            </thead>
            <tbody>
              {(datasets.data ?? []).map((dataset) => (
                <tr key={dataset.id} data-dataset-id={dataset.id}>
                  <td>{dataset.code}</td>
                  <td>{dataset.revision}</td>
                  <td>{dataset.taskType}</td>
                  <td>{datasetSourceLabel(t, dataset.source)}</td>
                  <td>{classificationLabel(t, dataset.maxClassification)}</td>
                  <td>{dataset.caseCount}</td>
                  <td>{dataset.injectionCases}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(datasets.data ?? []).length === 0 ? <p data-testid="datasets-none">{t('llm.datasets.none')}</p> : null}
        {may ? <DatasetForm /> : null}
      </StateBoundary>
    </section>
  );
}

function DatasetForm() {
  const { t } = useTranslation();
  const create = useCreateDataset();
  const [values, setValues] = useState<DatasetValues>(EMPTY_DATASET);
  const [errors, setErrors] = useState<DatasetErrors>({});
  const refused = create.isError ? describeLlmProblem(create.error) : undefined;
  const set = <K extends keyof DatasetValues>(field: K, value: DatasetValues[K]): void => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors({});
  };
  const message = (field: keyof DatasetErrors): string | undefined => (errors[field] === undefined ? undefined : evalProblemMessage(t, errors[field]));
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending) return;
    const found = validateDataset(values);
    setErrors(found);
    if (Object.keys(found).length === 0) create.mutate(values);
  };
  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('llm.datasets.form.title')}>
      <h2>{t('llm.datasets.form.title')}</h2>
      <p className="sub">{t('llm.datasets.form.hint', { count: MAX_CASES })}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="dataset-refused">
          {refusalMessage(t, refused.reason, refused.detail)}
        </p>
      )}
      {create.isSuccess ? (
        <p className="callout" role="status" data-testid="dataset-saved">
          {t('llm.datasets.form.saved')}
        </p>
      ) : null}
      <div className="mne-filters">
        <Field id="dataset-code" label={t('llm.datasets.form.code')} error={message('code')}>
          <input id="dataset-code" value={values.code} onChange={(event) => set('code', event.target.value)} maxLength={60} />
        </Field>
        <Field id="dataset-task" label={t('llm.datasets.form.task')} error={message('taskType')}>
          <input id="dataset-task" value={values.taskType} onChange={(event) => set('taskType', event.target.value)} maxLength={80} />
        </Field>
        <Field id="dataset-source" label={t('llm.datasets.form.source')} error={undefined}>
          <select id="dataset-source" value={values.source} onChange={(event) => set('source', event.target.value as DatasetSource)}>
            {DATASET_SOURCES.map((source) => (
              <option key={source} value={source}>
                {datasetSourceLabel(t, source)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field id="dataset-cases" label={t('llm.datasets.form.cases')} error={message('cases')} hint={t('llm.datasets.form.casesHint')}>
        <textarea id="dataset-cases" rows={8} value={values.cases} onChange={(event) => set('cases', event.target.value)} />
      </Field>
      <div className="mne-actions">
        <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending}>
          {t('llm.datasets.form.submit')}
        </button>
      </div>
    </form>
  );
}
