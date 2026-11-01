import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../mne/components';
import { classificationLabel, typeLabel } from './labels';
import { useSearch } from './hooks';
import { SEARCH_PERMISSION, ofType, openPath, queryProblem, typesOf } from './model';
import type { SearchHit } from './model';

const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

/**
 * IAM-07: global search (ST-IAM-008, FR-IAM-07, UI-IAM-07). The keyword is part of the address, so back and a shared link keep it. The list is what the caller may open and nothing more: it has no total (and shows no count
 * of any kind), because the API filters by tenant and scope before ranking and a number would show what lies outside. Opening a hit goes to the screen of the record, which asks the API again.
 */
export default function SearchScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What was asked belongs to one member of one tenant: a switch starts the screen over.
  return <SearchContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function SearchContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const allowed = holds(permissions, SEARCH_PERMISSION);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('iam.search.page.title')}</h1>
          <p>{t('iam.search.page.subtitle')}</p>
        </div>
      </div>
      {allowed ? (
        <Search />
      ) : (
        <div data-testid="search-denied">
          <StateBoundary state="denied" />
        </div>
      )}
      <p className="prototype-note">{t('iam.search.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Search() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const asked = (params.get('q') ?? '').trim();
  const [draft, setDraft] = useState(asked);
  const [showProblem, setShowProblem] = useState(false);
  const [type, setType] = useState('');
  const draftProblem = queryProblem(draft);
  const run = asked !== '' && queryProblem(asked) === undefined;
  const search = useSearch(asked, run);
  const hits = (search.data?.pages ?? []).flatMap((page) => page.items);
  const state = useScreenState({
    isLoading: search.isLoading,
    error: search.error,
    data: search.data === undefined ? undefined : hits,
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (draftProblem !== undefined) {
      setShowProblem(true);
      return;
    }
    setShowProblem(false);
    setType('');
    setParams({ q: draft.trim() }, { replace: true });
  };

  const problem = showProblem ? draftProblem : asked === '' ? undefined : queryProblem(asked);
  const error = problem === undefined ? undefined : problem === 'long' ? t('iam.search.query.tooLong') : t('iam.search.query.tooShort');
  const kinds = typesOf(hits);
  const shown = ofType(hits, kinds.includes(type) ? type : '');
  return (
    <>
      <form className="card" role="search" aria-label={t('iam.search.form.aria')} onSubmit={submit} noValidate>
        <div className="filters">
          <Field id="search-query" label={t('iam.search.query.label')} hint={t('iam.search.query.hint')} error={error}>
            <input id="search-query" type="search" autoComplete="off" value={draft} onChange={(event) => setDraft(event.target.value)} aria-invalid={error !== undefined} />
          </Field>
          <Field id="search-type" label={t('iam.search.type.label')} error={undefined}>
            <select id="search-type" value={kinds.includes(type) ? type : ''} onChange={(event) => setType(event.target.value)} disabled={kinds.length === 0}>
              <option value="">{t('iam.search.type.all')}</option>
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {typeLabel(t, kind)}
                </option>
              ))}
            </select>
          </Field>
          <div>
            <button type="submit" className="primary">
              {t('iam.search.submit.action')}
            </button>
          </div>
        </div>
        <p className="sub" data-testid="search-scope">
          {t('iam.search.scope.note')}
        </p>
      </form>
      {asked === '' ? (
        <p data-testid="search-pick">{t('iam.search.pick.notice')}</p>
      ) : run ? (
        <StateBoundary state={state} onRetry={() => void search.refetch()}>
          <section className="card" aria-label={t('iam.search.results.aria')} data-testid="search-results" aria-busy={search.isFetching}>
            <h2>{t('iam.search.results.title')}</h2>
            <p className="sub" data-testid="search-nototal">
              {t('iam.search.nototal.note')}
            </p>
            <ul>
              {shown.map((hit) => (
                <HitItem key={`${hit.entityType}:${hit.entityId}`} hit={hit} />
              ))}
            </ul>
            {search.hasNextPage ? (
              <div className="formfooter">
                <span />
                <button type="button" onClick={() => void search.fetchNextPage()} disabled={search.isFetchingNextPage}>
                  {t('iam.search.more.action')}
                </button>
              </div>
            ) : null}
          </section>
        </StateBoundary>
      ) : null}
    </>
  );
}

function HitItem({ hit }: { hit: SearchHit }) {
  const { t } = useTranslation();
  const path = openPath(hit);
  const title = hit.title === null ? t('iam.search.hidden.title') : hit.title;
  return (
    <li className="item" data-entity-type={hit.entityType} data-classification={hit.classification}>
      <div className="title">{path === undefined ? title : <Link to={path}>{title}</Link>}</div>
      <div className="sub">
        {typeLabel(t, hit.entityType)} · <span className="pill gray">{classificationLabel(t, hit.classification)}</span>
      </div>
      {hit.snippet === null ? null : <p className="sub">{hit.snippet}</p>}
    </li>
  );
}
