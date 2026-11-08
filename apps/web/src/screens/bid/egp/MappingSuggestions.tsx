import { useTranslation } from '../../../i18n';
import { SectionCard } from '../../../ui';
import { Likeness } from './MappingInfo';
import { useSuggestions } from './mapping-hooks';
import { dongText, formOfSuggestion, likenessText } from './mapping-model';
import type { ProposeForm } from './mapping-model';
import './mapping.css';

export interface MappingSuggestionsProps {
  /** Whether the caller may propose: without the right the list is only read. */
  canPropose: boolean;
  onPropose: (form: ProposeForm) => void;
}

/**
 * "Gợi ý chờ xác nhận": the packages of the network that no mapping names yet, with the packages of ours whose budget equals the imported price to the unit and whose names are alike. It is a hint
 * a person confirms: nothing is linked here, the button only opens the proposal with the fields filled.
 */
export function MappingSuggestions({ canPropose, onPropose }: MappingSuggestionsProps) {
  const { t, locale } = useTranslation();
  const query = useSuggestions();
  const list = query.data;

  return (
    <SectionCard title={t('egp.mapping.suggest.title')} status={list === undefined ? undefined : <Likeness asOf={list.asOf} list={list} />}>
      <p className="sub">{t('egp.mapping.suggest.intro')}</p>
      {query.isLoading && (
        <div role="status" aria-busy="true" className="mapping-state" data-testid="suggestions-loading">
          <span className="ui-skeleton ui-skeleton--line" aria-hidden="true" />
          <span className="ui-sr-only">{t('egp.mapping.suggest.loading')}</span>
        </div>
      )}
      {query.isError && (
        <div role="alert" className="mapping-state mapping-state--error" data-testid="suggestions-error">
          <p>{t('egp.mapping.suggest.error')}</p>
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void query.refetch()}>
            {t('states.retry.action')}
          </button>
        </div>
      )}
      {list !== undefined && list.items.length === 0 && (
        <p className="callout" role="status" data-testid="suggestions-empty">
          {t('egp.mapping.suggest.empty')}
        </p>
      )}
      {list !== undefined && list.items.length > 0 && (
        <ul className="mapping-suggestions" data-testid="suggestions">
          {list.items.map((item) => (
            <li key={`${item.importId}:${item.externalCode}`} className="mapping-suggestion" data-external-code={item.externalCode}>
              <div className="mapping-suggestion__head">
                <strong>{t('egp.mapping.suggest.external', { code: item.externalCode, name: item.importedName })}</strong>
                <span className="mapping-suggestion__meta">{t('egp.mapping.suggest.meta', { price: dongText(item.importedPriceVnd, locale), plan: item.planCode })}</span>
              </div>
              <ul className="mapping-candidates">
                {item.candidates.map((candidate) => (
                  <li key={candidate.packageId} className="mapping-candidate" data-package-id={candidate.packageId}>
                    <span className="mapping-candidate__body">
                      <span>{t('egp.mapping.suggest.candidate', { code: candidate.code, name: candidate.name })}</span>
                      <span className="mapping-suggestion__meta">{t('egp.mapping.suggest.budget', { amount: dongText(candidate.budgetVnd, locale) })}</span>
                    </span>
                    <span className="mapping-candidate__likeness" data-testid="likeness">
                      {t('egp.mapping.suggest.likeness', { value: likenessText(candidate.confidence, locale) })}
                      <Likeness asOf={list.asOf} list={list} />
                    </span>
                    {canPropose && (
                      <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('egp.mapping.suggest.propose.label', { ours: candidate.code, external: item.externalCode })} onClick={() => onPropose(formOfSuggestion(item.externalCode, candidate))}>
                        {t('egp.mapping.suggest.propose.action')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
