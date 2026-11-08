import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { Info } from '../../gov11/gov11-kit';
import { useCollections } from '../../llm/knowledge/hooks';
import { LIMIT_DEFAULT, LIMIT_MAX, QUESTION_MAX, describePassageRefusal, distanceText, passageProblems, toPassages } from './passage-model';
import type { PassageQuery, PassageResult } from './passage-model';

function usePassages(packageId: string, query: PassageQuery | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PassageResult>({
    queryKey: ['bid-passages', tenant?.id, tenant?.membershipId, packageId, query ?? null],
    queryFn: async () => toPassages(await client.read('searchProposalPassages', { path: { id: packageId }, query: { embedding_model_id: (query as PassageQuery).modelId, question: (query as PassageQuery).question.trim(), limit: (query as PassageQuery).limit } })),
    enabled: tenant !== undefined && packageId !== '' && query !== undefined,
    retry: false,
    staleTime: 0,
  });
}

/**
 * BID-09: the passages of the proposals of a package that are nearest to a question, for the member of the evaluation team who has them in full. The server ranks only pages the caller may read, applies the access list before it
 * measures closeness, and refuses a model that is not approved or a route the class of the files forbids; each of those is told in words. Nothing is ranked as an answer: a passage is a place to read, and the distance only orders them.
 */
export function PassageSearchPanel({ packageId }: { packageId: string }) {
  const { t } = useTranslation();
  const collections = useCollections();
  const models = useMemo(() => {
    const seen = new Map<string, string>();
    for (const collection of collections.data ?? []) if (!seen.has(collection.embeddingModelId)) seen.set(collection.embeddingModelId, collection.code);
    return [...seen.entries()].map(([id, code]) => ({ id, code }));
  }, [collections.data]);
  const [draft, setDraft] = useState({ modelId: '', question: '', limit: String(LIMIT_DEFAULT) });
  const [asked, setAsked] = useState<PassageQuery | undefined>(undefined);
  const [tried, setTried] = useState(false);
  const query: PassageQuery = { modelId: draft.modelId, question: draft.question, limit: Number(draft.limit) };
  const problems = tried ? passageProblems(query) : {};
  const found = usePassages(packageId, asked);
  const refusal = found.isError ? describePassageRefusal(found.error) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setTried(true);
    if (Object.keys(passageProblems(query)).length > 0) return;
    setAsked({ ...query, question: query.question.trim() });
  };
  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="passages-title" data-testid="passage-search">
      <h2 id="passages-title">{t('bid.passages.title')}</h2>
      <p className="sub">{t('bid.passages.help')}</p>
      <div className="field">
        <label htmlFor="passages-model">{t('bid.passages.model.label')}</label>
        <select id="passages-model" value={draft.modelId} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })} disabled={collections.isLoading} aria-invalid={problems.model !== undefined}>
          <option value="">{collections.isLoading ? t('bid.passages.loading') : t('bid.passages.model.choose')}</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {t('bid.passages.model.option', { code: model.code })}
            </option>
          ))}
        </select>
        {problems.model === undefined ? null : <small role="alert" className="field-error">{t('bid.passages.error.model')}</small>}
        {collections.isError ? (
          <small role="alert" data-testid="passages-models-error">
            {t('bid.passages.model.error')}
          </small>
        ) : null}
        {!collections.isLoading && !collections.isError && models.length === 0 ? (
          <small data-testid="passages-no-models">{t('bid.passages.model.none')}</small>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="passages-question">{t('bid.passages.question.label')}</label>
        <textarea id="passages-question" rows={3} value={draft.question} onChange={(event) => setDraft({ ...draft, question: event.target.value })} aria-invalid={problems.question !== undefined} />
        {problems.question === undefined ? null : <small role="alert" className="field-error">{problems.question === 'questionRequired' ? t('bid.passages.error.questionRequired') : t('bid.passages.error.questionLong', { max: QUESTION_MAX })}</small>}
      </div>
      <div className="field">
        <label htmlFor="passages-limit">{t('bid.passages.limit.label')}</label>
        <input id="passages-limit" type="number" min={1} max={LIMIT_MAX} value={draft.limit} onChange={(event) => setDraft({ ...draft, limit: event.target.value })} aria-invalid={problems.limit !== undefined} />
        {problems.limit === undefined ? null : <small role="alert" className="field-error">{t('bid.passages.error.limit', { max: LIMIT_MAX })}</small>}
      </div>
      <div className="formfooter">
        <button type="submit" className="button primary" disabled={found.isFetching} data-testid="passages-submit">
          {found.isFetching ? t('bid.passages.searching') : t('bid.passages.submit')}
        </button>
      </div>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="passages-refusal">
          {refusal === 'undeclared'
            ? t('bid.passages.refused.undeclared')
            : refusal === 'route'
              ? t('bid.passages.refused.route')
              : refusal === 'killSwitch'
                ? t('bid.passages.refused.killSwitch')
                : refusal === 'model'
                  ? t('bid.passages.refused.model')
                  : refusal === 'validation'
                    ? t('bid.passages.refused.validation')
                    : refusal === 'denied'
                      ? t('bid.passages.refused.denied')
                      : t('bid.passages.refused.general')}{' '}
          <button type="button" className="button" onClick={() => void found.refetch()}>
            {t('bid.passages.retry')}
          </button>
        </p>
      )}
      {found.data === undefined ? null : found.data.items.length === 0 ? (
        <p className="callout" role="status" data-testid="passages-empty">
          {t('bid.passages.empty')}
        </p>
      ) : (
        <>
          <p className="sub">
            {t('bid.passages.count', { count: found.data.items.length })}{' '}
            <Info name={t('bid.passages.distance')} rule={undefined} fallbackFormula={t('bid.passages.distance.formula')} owner={t('bid.passages.owner')} asOf={found.data.asOf.slice(0, 10)} />
          </p>
          <ol data-testid="passages">
            {found.data.items.map((passage) => (
              <li key={`${passage.documentVersionId}:${passage.pageIndex}:${passage.chunkNo}`} data-distance={passage.distance}>
                <p className="sub">{t('bid.passages.where', { page: passage.pageIndex + 1, chunk: passage.chunkNo + 1, classification: passage.classification, distance: distanceText(passage.distance) })}</p>
                <p>{passage.text}</p>
              </li>
            ))}
          </ol>
        </>
      )}
    </form>
  );
}
