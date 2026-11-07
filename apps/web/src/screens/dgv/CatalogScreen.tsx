import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, FilterPanel, SectionCard } from '../../ui';
import { Field, QualityPill } from './components';
import { NO_FILTER, useCatalog } from './hooks';
import type { CatalogFilter } from './hooks';
import { classificationLabel, freshnessLabel } from './labels';
import { CATALOG_MANAGE_PERMISSION, CLASSIFICATION_LIST } from './model';
import type { Classification } from './model';
import './dgv-kit.css';

const NEVER_EMPTY = (): boolean => false;
const OWNERS_PATH = '/dgv/dgv-03';

/**
 * DGV-04: the data catalogue. A reader sees the datasets that their roles and the classification of each allow; a dataset outside
 * that is not listed and is not counted, so the screen has nothing to say about what it cannot show (ST-DGV-001, DGV 3.1 F1).
 */
export default function CatalogScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The filters belong to one tenant: a switch starts the screen over.
  return <CatalogContent key={tenantId ?? 'none'} route={route} />;
}

function CatalogContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, tenant } = useSession();
  // A link from another screen (BI-07) names the entry it means: that row is marked as the current one.
  const selected = useSearchParams()[0].get('dataset');
  const [draft, setDraft] = useState<CatalogFilter>(NO_FILTER);
  const [applied, setApplied] = useState<CatalogFilter>(NO_FILTER);
  const datasets = useCatalog(applied);
  const state = useScreenState({ isLoading: datasets.isLoading, error: datasets.error, data: datasets.data, isEmpty: NEVER_EMPTY });
  const rows = datasets.data ?? [];
  const filtering = applied.text.trim() !== '' || applied.domain !== '' || applied.classification !== '';
  const mayManage = permissions === undefined || permissions.includes(CATALOG_MANAGE_PERMISSION);

  const apply = (event: FormEvent): void => {
    event.preventDefault();
    setApplied(draft);
  };
  const clear = (): void => {
    setDraft(NO_FILTER);
    setApplied(NO_FILTER);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dgv.catalog.page.title')}</h1>
          <p>{t('dgv.catalog.page.subtitle')}</p>
        </div>
        {mayManage ? (
          <Link className="ui-button ui-button--outline" to={OWNERS_PATH}>
            {t('dgv.catalog.manage.link')}
          </Link>
        ) : null}
      </div>
      <ContextBar
        items={[
          { label: t('dgv.catalog.ctx.scope'), value: tenant?.name ?? t('dgv.catalog.ctx.scope.all') },
          { label: t('dgv.catalog.ctx.datasets'), value: String(rows.length) },
        ]}
        {...(datasets.dataUpdatedAt > 0 ? { asOf: new Date(datasets.dataUpdatedAt).toLocaleString('vi-VN') } : {})}
      />
      <StateBoundary state={state} onRetry={() => void datasets.refetch()}>
        <FilterPanel applied={[applied.text.trim() !== '', applied.domain !== '', applied.classification !== ''].filter(Boolean).length}>
          <form className="dgv-filters" role="search" onSubmit={apply} aria-label={t('dgv.catalog.filter.title')}>
            <Field id="catalog-text" label={t('dgv.catalog.filter.text.label')} error={undefined}>
              <input id="catalog-text" type="search" value={draft.text} placeholder={t('dgv.catalog.filter.text.placeholder')} onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
            </Field>
            <Field id="catalog-domain" label={t('dgv.catalog.filter.domain.label')} error={undefined}>
              <input id="catalog-domain" value={draft.domain} onChange={(event) => setDraft({ ...draft, domain: event.target.value })} />
            </Field>
            <Field id="catalog-classification" label={t('dgv.catalog.filter.classification.label')} error={undefined}>
              <select id="catalog-classification" value={draft.classification} onChange={(event) => setDraft({ ...draft, classification: event.target.value as Classification | '' })}>
                <option value="">{t('dgv.catalog.filter.all.option')}</option>
                {CLASSIFICATION_LIST.map((classification) => (
                  <option key={classification} value={classification}>
                    {classificationLabel(t, classification)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="formfooter">
              <button type="button" className="ui-button ui-button--outline" onClick={clear}>
                {t('dgv.catalog.filter.clear.action')}
              </button>
              <button type="submit" className="ui-button ui-button--primary">
                {t('dgv.catalog.filter.apply.action')}
              </button>
            </div>
          </form>
        </FilterPanel>
        <SectionCard title={t('dgv.catalog.section.title')}>
          {rows.length === 0 ? (
            <p className="muted" data-testid="empty-catalog">
              {filtering ? t('dgv.catalog.noMatch.text') : t('dgv.catalog.empty.text')}
            </p>
          ) : (
            <div className="tablewrap">
            <table className="table" aria-label={t('dgv.catalog.table.aria')}>
              <thead>
                <tr>
                  <th>{t('dgv.catalog.dataset.column')}</th>
                  <th>{t('dgv.catalog.grain.column')}</th>
                  <th>{t('dgv.catalog.source.column')}</th>
                  <th>{t('dgv.catalog.classification.column')}</th>
                  <th>{t('dgv.catalog.freshness.column')}</th>
                  <th>{t('dgv.catalog.contract.column')}</th>
                  <th>{t('dgv.catalog.people.column')}</th>
                  <th>{t('dgv.catalog.badge.column')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} data-dataset-id={row.id} data-dataset-code={row.datasetCode} data-classification={row.classification} aria-current={row.id === selected ? 'true' : undefined} className={row.id === selected ? 'dgv-selected' : undefined}>
                    <td>
                      {row.title}
                      <code className="dgv-code">{row.datasetCode}</code>
                    </td>
                    <td>{row.grain}</td>
                    <td>{row.producerModule}</td>
                    <td>{classificationLabel(t, row.classification)}</td>
                    <td>{freshnessLabel(t, row.freshnessSloSeconds)}</td>
                    <td>{row.contractRevision === null ? t('dgv.catalog.contract.none') : t('dgv.catalog.contract.revision', { revision: row.contractRevision })}</td>
                    <td>
                      {row.ownerName ?? t('dgv.catalog.person.unknown')} / {row.stewardName ?? t('dgv.catalog.person.unknown')}
                    </td>
                    <td>
                      <QualityPill badge={row.qualityBadge} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
          <p className="sub" data-testid="count">
            {t('dgv.catalog.count.text', { count: rows.length })}
          </p>
          <p className="sub">{t('dgv.catalog.visibility.note')}</p>
        </SectionCard>
      </StateBoundary>
      <p className="prototype-note">{t('dgv.catalog.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
