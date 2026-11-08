import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { ImportFlow } from './ImportFlow';
import { ImportHistory } from './ImportHistory';
import { MappingDetail } from './MappingDetail';
import { GovernanceLink, OriginBadge, StateNote } from './ind-components';
import { useMappings } from './ind-hooks';
import { layoutLabel, numberFormatLabel } from './ind-labels';
import { DASH, PATH_DICTIONARY, PATH_RULES, vietnamDateTime } from './ind-model';
import type { Mapping } from './ind-model';
import './ind.css';

/**
 * IND-03: the Excel import mappings (DL.02). A mapping says which column (or row) of a form of the customer is which indicator of the dictionary, in which unit the sheet is written and how its numbers are spelled.
 * It has versions and an approver (a maker is not the checker): only an approved version in force reads a file, the platform's samples are templates. A file is read in a dry run first and applied once; a number
 * that differs from the one the register holds becomes a difference with an owner and never overwrites it.
 */
export default function MappingsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The selection and the flow belong to one membership: a switch of tenant or of membership starts the screen over.
  return <MappingsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function MappingsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const mappings = useMappings();
  const state = useScreenState({ isLoading: mappings.isLoading, error: mappings.data === undefined ? mappings.error : undefined, data: mappings.data ?? null, isEmpty: () => false });
  const data = mappings.data;
  const items = data?.items ?? [];
  const asOf = vietnamDateTime(data?.asOf);

  const columns: Array<DataTableColumn<Mapping>> = [
    {
      key: 'code',
      header: t('ind.map.column.code'),
      pinned: true,
      render: (row) => (
        <button type="button" className="ui-button ui-button--outline ui-button--small" aria-pressed={selected === row.code} aria-label={t('ind.map.select.label', { code: row.code })} onClick={() => setSelected(selected === row.code ? undefined : row.code)}>
          {row.code}
        </button>
      ),
    },
    { key: 'name', header: t('ind.map.column.name'), render: (row) => row.name },
    { key: 'layout', header: t('ind.map.column.layout'), render: (row) => layoutLabel(t, row.layout) },
    { key: 'format', header: t('ind.map.column.numberFormat'), render: (row) => numberFormatLabel(t, row.numberFormat) },
    { key: 'lines', header: t('ind.map.column.lines'), align: 'right', render: (row) => String(row.lines.length) },
    {
      key: 'state',
      header: t('ind.map.column.state'),
      render: (row) => (
        <span data-testid="mapping-state" data-active={row.active ? 'true' : 'false'}>
          <StatusPill tone={row.active ? 'success' : 'neutral'} icon={row.active ? '✓' : '○'}>
            {row.active ? t('ind.map.state.active') : t('ind.map.state.template')}
          </StatusPill>
        </span>
      ),
    },
    { key: 'origin', header: t('ind.map.column.origin'), render: (row) => <OriginBadge origin={row.origin} unverified={row.unverified} /> },
    { key: 'version', header: t('ind.map.column.version'), align: 'right', render: (row) => (row.version === 0 ? t('ind.map.column.versionDefault') : `v${row.version}`) },
    { key: 'effective', header: t('ind.map.column.effective'), render: (row) => (row.effectiveFrom === null ? DASH : `${row.effectiveFrom} → ${row.effectiveTo ?? DASH}`) },
    {
      key: 'problems',
      header: t('ind.map.column.problems'),
      align: 'right',
      render: (row) => (row.problems.length === 0 ? DASH : <StatusPill tone="danger" icon="✕">{t('ind.map.problems.count', { n: row.problems.length })}</StatusPill>),
    },
  ];

  const body = (() => {
    if (state !== 'default' || data === undefined) {
      return <StateNote state={state === 'default' ? 'error' : state} name="mappings" texts={{ loading: t('ind.map.state.loading'), denied: t('ind.map.state.denied'), error: t('ind.map.state.error') }} onRetry={() => void mappings.refetch()} />;
    }
    if (items.length === 0) {
      return (
        <p className="callout" role="status" data-testid="mappings-empty">
          {t('ind.map.state.empty')}
        </p>
      );
    }
    return (
      <>
        {items.some((one) => one.active) ? null : (
          <p className="callout" role="status" data-testid="mappings-none-active">
            {t('ind.map.state.noneActive')}
          </p>
        )}
        <div data-testid="mappings-table">
          <DataTable caption={t('ind.map.table.caption')} columns={columns} rows={items} rowKey={(row) => row.code} rowAttrs={(row) => ({ 'data-code': row.code, 'data-active': row.active ? 'true' : 'false', 'data-selected': selected === row.code ? 'true' : undefined })} />
        </div>
      </>
    );
  })();

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="ind-screen">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ind.map.page.title')}</h1>
          <p>{t('ind.map.page.subtitle')}</p>
        </div>
        <div className="ind-links">
          <Link to={PATH_DICTIONARY}>{t('ind.map.link.dictionary')}</Link>
          <Link to={PATH_RULES}>{t('ind.map.link.rules')}</Link>
        </div>
      </div>
      <ContextBar items={[{ label: t('ind.common.context.scope'), value: tenant?.name ?? '' }]} {...(asOf === '' ? {} : { asOf })} stale={mappings.isError && data !== undefined} />
      <SectionCard title={t('ind.map.list.title')}>
        <p className="sub">{t('ind.map.list.note')}</p>
        {body}
        <GovernanceLink />
      </SectionCard>
      {selected === undefined ? null : <MappingDetail key={selected} code={selected} onClose={() => setSelected(undefined)} />}
      <ImportFlow />
      <ImportHistory />
      <p className="prototype-note">{t('ind.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
