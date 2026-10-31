import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../prj/components';
import '../../prj/prj.css';
import { NO_FILTER, useCatalog } from '../hooks';
import { useBindTerm, useBindings, useTerms } from './hooks';
import { EMPTY_BIND, GLOSSARY_READ_PERMISSION, MANAGE_PERMISSION, bindBody, describeBind, holds, validateBind } from './model';
import type { BindField, BindForm, BindProblem, BindingView, FormProblem } from './model';

type T = Translator['t'];
const NONE = '—';

function problemMessage(t: T, problem: BindProblem): string {
  switch (problem) {
    case 'notPublished':
      return t('dgv.glossary.problem.notPublished');
    case 'scopeDenied':
      return t('dgv.glossary.problem.scopeDenied');
    case 'notFound':
      return t('dgv.glossary.problem.notFound');
    case 'validation':
      return t('dgv.glossary.problem.validation');
    case 'general':
      return t('dgv.glossary.problem.general');
  }
}

const fieldMessage = (t: T, problem: FormProblem | undefined): string | undefined =>
  problem === undefined ? undefined : problem === 'required' ? t('dgv.glossary.field.required.error') : t('dgv.glossary.field.invalid.error');

/**
 * DGV-02: the glossary bound to a dataset (ST-DGV-007, DGV 3.1). A published term of the glossary of MDM is bound to the dataset or to one of its columns; DGV holds no table of terms. A binding whose revision was
 * deprecated is warned about in words and the revision in force is offered; binding it replaces the old binding for the column. The coverage says how many bindings stand, how many of them are out of date and how many terms.
 */
export default function GlossaryScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const [params] = useSearchParams();
  // The address decides the dataset: a move to another one starts the screen over.
  return <GlossaryContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${params.get('id') ?? ''}`} route={route} />;
}

function GlossaryContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const datasetId = params.get('id') ?? undefined;
  const catalog = useCatalog(NO_FILTER);
  const list = useBindings(datasetId);
  const items = (list.data?.items ?? []).filter((item) => !item.replaced);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: datasetId === undefined || list.data === undefined ? undefined : items, isEmpty: () => false });
  const manage = holds(permissions, MANAGE_PERMISSION, mode);
  const bind = useBindTerm();
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dgv.glossary.page.title')}</h1>
          <p>{t('dgv.glossary.page.subtitle')}</p>
        </div>
      </div>
      <div className="prj-filters">
        <label htmlFor="glossary-dataset">{t('dgv.glossary.filter.dataset.label')}</label>
        <select id="glossary-dataset" value={datasetId ?? ''} onChange={(event) => setParams(event.target.value === '' ? {} : { id: event.target.value })}>
          <option value="">{NONE}</option>
          {(catalog.data ?? []).map((dataset) => (
            <option key={dataset.id} value={dataset.id}>
              {dataset.datasetCode} {dataset.title}
            </option>
          ))}
        </select>
      </div>
      {datasetId === undefined ? (
        <p className="callout" role="status" data-testid="no-dataset">
          {t('dgv.glossary.noDataset.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          {list.data === undefined ? null : (
            <>
              <section aria-labelledby="coverage-title" data-testid="coverage">
                <h2 id="coverage-title">{t('dgv.glossary.coverage.title')}</h2>
                <dl>
                  <div data-figure="bound">
                    <dt>{t('dgv.glossary.coverage.bound')}</dt>
                    <dd>{list.data.coverage.bound}</dd>
                  </div>
                  <div data-figure="terms">
                    <dt>{t('dgv.glossary.coverage.terms')}</dt>
                    <dd>{list.data.coverage.terms}</dd>
                  </div>
                  <div data-figure="deprecated">
                    <dt>{t('dgv.glossary.coverage.deprecated')}</dt>
                    <dd>{list.data.coverage.deprecated}</dd>
                  </div>
                </dl>
              </section>
              {manage ? <BindPanel datasetId={datasetId} /> : null}
              <div className="tablewrap">
                <table className="table" aria-label={t('dgv.glossary.list.aria')} data-testid="bindings">
                  <thead>
                    <tr>
                      <th scope="col">{t('dgv.glossary.col.term')}</th>
                      <th scope="col">{t('dgv.glossary.col.column')}</th>
                      <th scope="col">{t('dgv.glossary.col.status')}</th>
                      <th scope="col">{t('dgv.glossary.col.bound')}</th>
                      <th scope="col">
                        <span className="sr-only">{t('dgv.glossary.col.actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <BindingRow key={item.id} item={item} canBind={manage} pending={bind.isPending} onBind={(termId, column) => bind.mutate({ datasetId, body: bindBody({ termId, columnName: column ?? '' }) })} />
                    ))}
                  </tbody>
                </table>
              </div>
              {bind.isError ? (
                <p className="callout warning" role="alert" data-testid="successor-refusal">
                  {problemMessage(t, describeBind(bind.error))}
                </p>
              ) : null}
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('dgv.glossary.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function BindingRow({ item, canBind, pending, onBind }: { item: BindingView; canBind: boolean; pending: boolean; onBind(termId: string, column: string | undefined): void }) {
  const { t } = useTranslation();
  return (
    <tr data-binding={item.id} data-deprecated={item.deprecated}>
      <td>
        <code>{item.term.termCode}</code> {item.term.termVi}
        <span className="prj-code">{t('dgv.glossary.row.revision', { revision: item.term.revision })}</span>
        <span className="prj-code">{item.term.definition}</span>
      </td>
      <td>{item.columnName ?? t('dgv.glossary.row.wholeDataset')}</td>
      <td>
        {item.deprecated ? (
          <span className="pill warn" data-testid="deprecated">
            {t('dgv.glossary.row.deprecated')}
          </span>
        ) : (
          <span className="pill green">{t('dgv.glossary.row.current')}</span>
        )}
        {item.deprecated ? (
          <p className="callout warning" role="status" data-testid="deprecated-warning">
            {item.successor === null ? t('dgv.glossary.row.noSuccessor') : t('dgv.glossary.row.successor', { revision: item.successor.revision })}
          </p>
        ) : null}
      </td>
      <td>
        {item.boundBy}
        <span className="prj-code">{item.boundAt}</span>
      </td>
      <td>
        {canBind && item.deprecated && item.successor !== null ? (
          <button type="button" disabled={pending} onClick={() => onBind(item.successor?.id ?? '', item.columnName ?? undefined)}>
            {t('dgv.glossary.row.rebind.action', { revision: item.successor.revision })}
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function BindPanel({ datasetId }: { datasetId: string }) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const send = useBindTerm();
  const mayList = holds(permissions, GLOSSARY_READ_PERMISSION, undefined);
  const terms = useTerms(mayList);
  const [form, setForm] = useState<BindForm>(EMPTY_BIND);
  const [problems, setProblems] = useState<Partial<Record<BindField, FormProblem>>>({});
  const [saved, setSaved] = useState(false);
  const refusal = send.isError ? describeBind(send.error) : undefined;
  const options = terms.data ?? [];
  const set = (patch: Partial<BindForm>): void => {
    setSaved(false);
    setForm((value) => ({ ...value, ...patch }));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateBind(form);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate(
      { datasetId, body: bindBody(form) },
      {
        onSuccess: () => {
          setForm(EMPTY_BIND);
          setSaved(true);
        },
      },
    );
  };
  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('dgv.glossary.form.title')}>
      <h2>{t('dgv.glossary.form.title')}</h2>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="bind-refusal">
          {problemMessage(t, refusal)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="bind-saved">
          {t('dgv.glossary.form.saved')}
        </p>
      ) : null}
      {mayList && (terms.isLoading || options.length > 0) ? (
        <Field id="bind-term" label={t('dgv.glossary.field.term.label')} error={fieldMessage(t, problems.termId)}>
          <select id="bind-term" value={form.termId} onChange={(event) => set({ termId: event.target.value })}>
            <option value="">{NONE}</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.termCode} {option.termVi} {t('dgv.glossary.row.revision', { revision: option.revision })}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <Field id="bind-term" label={t('dgv.glossary.field.term.label')} error={fieldMessage(t, problems.termId)} hint={t('dgv.glossary.field.term.hint')}>
          <input id="bind-term" type="text" value={form.termId} onChange={(event) => set({ termId: event.target.value })} />
        </Field>
      )}
      <Field id="bind-column" label={t('dgv.glossary.field.column.label')} error={fieldMessage(t, problems.columnName)} hint={t('dgv.glossary.field.column.hint')}>
        <input id="bind-column" type="text" value={form.columnName} onChange={(event) => set({ columnName: event.target.value })} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending}>
          {t('dgv.glossary.form.submit.action')}
        </button>
      </div>
    </form>
  );
}
