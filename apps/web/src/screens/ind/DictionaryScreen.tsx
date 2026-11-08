import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { FiguresPanel } from './FiguresPanel';
import { IndicatorDetail } from './IndicatorDetail';
import { GovernanceLink, OriginBadge, StateNote } from './ind-components';
import { useDictionary } from './ind-hooks';
import { categoryLabel, findingLabel, unitLabel, valueKindLabel } from './ind-labels';
import { CATEGORIES, DASH, NO_FILTER, PATH_MAPPINGS, PATH_RULES, VALUE_KINDS, categoryOf, isFiltered, valueKindOf, vietnamDateTime } from './ind-model';
import type { DictionaryFilter, Indicator } from './ind-model';
import './ind.css';

/**
 * IND-01: the indicator dictionary (DL.02). An indicator is a definition of the KPI register (code, name, unit, formula, owner, version) that also says how its figure is obtained and entered, so that the
 * command centre, the boards, the forms of the customer and the entry rules all read one list. The list below is filtered by the server; the findings say what must be settled before a form can be mapped
 * (two indicators with one name in the forms, an entered figure that no rule can see). Definitions are changed through the governance rules; figures of the entered indicators are typed here.
 */
export default function DictionaryScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The selection and the entry belong to one membership: a switch of tenant or of membership starts the screen over.
  return <DictionaryContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DictionaryContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const ids = useId();
  const [filter, setFilter] = useState<DictionaryFilter>(NO_FILTER);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [entering, setEntering] = useState<string | undefined>(undefined);
  const dictionary = useDictionary(filter);
  const state = useScreenState({ isLoading: dictionary.isLoading, error: dictionary.data === undefined ? dictionary.error : undefined, data: dictionary.data ?? null, isEmpty: () => false });
  const data = dictionary.data;
  const items = data?.items ?? [];
  const asOf = vietnamDateTime(data?.asOf);

  const columns: Array<DataTableColumn<Indicator>> = [
    {
      key: 'code',
      header: t('ind.dict.column.code'),
      pinned: true,
      render: (row) => (
        <button type="button" className="ui-button ui-button--outline ui-button--small" aria-pressed={selected === row.code} aria-label={t('ind.dict.select.label', { code: row.code })} onClick={() => setSelected(selected === row.code ? undefined : row.code)}>
          {row.code}
        </button>
      ),
    },
    { key: 'name', header: t('ind.dict.column.name'), render: (row) => row.name },
    { key: 'unit', header: t('ind.dict.column.unit'), render: (row) => unitLabel(t, row.unit) },
    { key: 'category', header: t('ind.dict.column.category'), render: (row) => (row.category === null ? DASH : categoryLabel(t, row.category)) },
    {
      key: 'kind',
      header: t('ind.dict.column.kind'),
      render: (row) => (
        <StatusPill tone={row.enterable ? 'info' : 'neutral'}>{valueKindLabel(t, row.valueKind)}</StatusPill>
      ),
    },
    { key: 'owner', header: t('ind.dict.column.owner'), render: (row) => row.owner || DASH },
    { key: 'version', header: t('ind.dict.column.version'), align: 'right', render: (row) => (row.version === 0 ? t('ind.dict.column.versionDefault') : `v${row.version}`) },
    { key: 'origin', header: t('ind.dict.column.origin'), render: (row) => <OriginBadge origin={row.origin} unverified={row.unverified} /> },
  ];

  const body = (() => {
    if (state !== 'default' || data === undefined) {
      return <StateNote state={state === 'default' ? 'error' : state} name="dictionary" texts={{ loading: t('ind.dict.state.loading'), denied: t('ind.dict.state.denied'), error: t('ind.dict.state.error') }} onRetry={() => void dictionary.refetch()} />;
    }
    if (items.length === 0) {
      return (
        <div className="callout" role="status" data-testid="dictionary-empty">
          <p>{isFiltered(filter) ? t('ind.dict.state.emptyFiltered') : t('ind.dict.state.empty')}</p>
          {isFiltered(filter) ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setFilter(NO_FILTER)}>
              {t('ind.dict.filter.clear')}
            </button>
          ) : null}
        </div>
      );
    }
    return (
      <div data-testid="dictionary-table">
        <DataTable caption={t('ind.dict.table.caption')} columns={columns} rows={items} rowKey={(row) => row.code} rowAttrs={(row) => ({ 'data-code': row.code, 'data-kind': row.valueKind, 'data-origin': row.origin, 'data-selected': selected === row.code ? 'true' : undefined })} />
      </div>
    );
  })();

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="ind-screen">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ind.dict.page.title')}</h1>
          <p>{t('ind.dict.page.subtitle')}</p>
        </div>
        <div className="ind-links">
          <Link to={PATH_RULES}>{t('ind.dict.link.rules')}</Link>
          <Link to={PATH_MAPPINGS}>{t('ind.dict.link.mappings')}</Link>
        </div>
      </div>
      <ContextBar items={[{ label: t('ind.common.context.scope'), value: tenant?.name ?? '' }]} {...(asOf === '' ? {} : { asOf })} stale={dictionary.isError && data !== undefined} />
      {data === undefined || data.findings.length === 0 ? null : (
        <div className="callout warning" role="status" data-testid="dictionary-findings">
          <p>{t('ind.dict.findings.title')}</p>
          <ul>
            {data.findings.map((finding) => (
              <li key={`${finding.code}:${finding.detail}`} data-finding={finding.code}>
                {findingLabel(t, finding.code, finding.detail)} ({finding.indicators.join(', ')})
              </li>
            ))}
          </ul>
        </div>
      )}
      <SectionCard title={t('ind.dict.list.title')}>
        <form className="ind-filter" role="search" aria-label={t('ind.dict.filter.title')} onSubmit={(event) => event.preventDefault()}>
          <div className="field">
            <label htmlFor={`${ids}-q`}>{t('ind.dict.filter.q')}</label>
            <input id={`${ids}-q`} type="search" value={filter.q} onChange={(event) => setFilter({ ...filter, q: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor={`${ids}-category`}>{t('ind.dict.filter.category')}</label>
            <select id={`${ids}-category`} value={filter.category} onChange={(event) => setFilter({ ...filter, category: categoryOf(event.target.value) ?? '' })}>
              <option value="">{t('ind.dict.filter.all')}</option>
              {CATEGORIES.map((one) => (
                <option key={one} value={one}>
                  {categoryLabel(t, one)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${ids}-kind`}>{t('ind.dict.filter.kind')}</label>
            <select id={`${ids}-kind`} value={filter.valueKind} onChange={(event) => setFilter({ ...filter, valueKind: valueKindOf(event.target.value) ?? '' })}>
              <option value="">{t('ind.dict.filter.all')}</option>
              {VALUE_KINDS.map((one) => (
                <option key={one} value={one}>
                  {valueKindLabel(t, one)}
                </option>
              ))}
            </select>
          </div>
          <div className="field ind-check">
            <input id={`${ids}-enterable`} type="checkbox" checked={filter.enterableOnly} onChange={(event) => setFilter({ ...filter, enterableOnly: event.target.checked })} />
            <label htmlFor={`${ids}-enterable`}>{t('ind.dict.filter.enterable')}</label>
          </div>
        </form>
        {body}
        <GovernanceLink />
      </SectionCard>
      {selected === undefined ? null : (
        <IndicatorDetail
          key={`detail:${selected}`}
          code={selected}
          onClose={() => setSelected(undefined)}
          onEnter={(code) => {
            setEntering(code);
          }}
        />
      )}
      <FiguresPanel key={`entry:${entering ?? 'none'}`} initial={entering} />
      <p className="prototype-note">{t('ind.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
