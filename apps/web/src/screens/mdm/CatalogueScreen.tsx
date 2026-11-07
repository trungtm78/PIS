import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { hasMessage, useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { RulePanel } from './RulePanel';
import { CATALOGUES, camel, download, inTreeOrder, toCsv } from './catalogues';
import type { CatalogueConfig, CellContext } from './catalogues';
import { useCatalogue, useCrosswalks, useTypePolicies } from './hooks';
import { recordStatusLabel, recordStatusTone, scopeLabel } from './labels';
import { PROPOSE_PERMISSION, recordLink } from './model';
import type { RecordStatus } from './model';
import { KitTable } from '../adm/KitTable';
import '../adm/adm-kit.css';
import { StatusPill } from '../../ui';

const CREATE_PATH = '/mdm/mdm-25';
const DETAIL_PATH = '/mdm/mdm-27';
const STATUSES: readonly RecordStatus[] = ['EFFECTIVE', 'DRAFT', 'IN_REVIEW', 'APPROVED', 'RETIRED', 'MERGED'];
const NEVER_EMPTY = (): boolean => false;
const TREE_INDENT_PX = 16;

/**
 * MDM-04 to MDM-10: the catalogues of the capital chain (funding sources, programmes, sectors, project groups and types, stages, decision
 * authorities and decision types) on one engine. The entries of the platform and of the tenant are listed together, each marked, with the
 * rule data that applies to them below; a change goes through the form and the review of the other master data screens.
 */
export default function CatalogueScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  const config = CATALOGUES[route.id];
  if (config === undefined) throw new Error(`screen ${route.id} is not a catalogue`);
  // The filters and the entries belong to one tenant: a switch starts the screen over.
  return <CatalogueContent key={`${tenantId ?? 'none'}:${route.id}`} route={route} config={config} />;
}

function CatalogueContent({ route, config }: ScreenProps & { config: CatalogueConfig }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<RecordStatus | ''>('');
  const [type, setType] = useState('');
  const entries = useCatalogue(config.types);
  const rules = useCatalogue(config.rules);
  const policies = useTypePolicies();
  // The codes of another system are part of the screen when it shows them: a read that failed is an error, never a column that looks empty.
  const links = useCrosswalks({ sourceSystem: config.linked?.sourceSystem, externalType: config.linked?.externalType, status: 'ACTIVE' }, config.linked !== undefined);
  // The rules are part of the screen: a rule that could not be read is an error with a retry, never an empty list that looks like no rule.
  const state = useScreenState({ isLoading: entries.isLoading || rules.isLoading || links.isLoading, error: entries.error ?? rules.error ?? links.error, data: entries.data, isEmpty: NEVER_EMPTY });
  const canPropose = (permissions === undefined || permissions.includes(PROPOSE_PERMISSION)) && mode !== 'READ_ONLY';
  const target = type === '' ? (config.types[0] ?? '') : type;
  const policy = policies.data?.find((candidate) => candidate.masterType === target);
  const canAdd = canPropose && policy?.scope !== 'PLATFORM_ONLY';

  const context = useMemo<CellContext>(
    () => ({
      byId: new Map((entries.data ?? []).map((record) => [record.id, record])),
      value: (family, raw) => {
        const named = typeof raw === 'boolean' ? String(raw) : raw;
        if (typeof named !== 'string' || named === '') return '';
        const key = `mdm.value.${family}.${camel(named)}`;
        return hasMessage(key) ? t(key) : named;
      },
      linked: (record) => (links.data ?? []).filter((link) => link.masterRecordId === record.id).map((link) => link.externalCode).join(', '),
      awaiting: (record) => (record.attributes.awaiting_confirmation === true ? t('mdm.rule.awaiting.pill', { cxn: String(record.attributes.cxn ?? '') }) : ''),
    }),
    [entries.data, links.data, t],
  );

  const filtered = (entries.data ?? []).filter((record) => {
    if (type !== '' && record.masterType !== type) return false;
    if (status !== '' && record.status !== status) return false;
    const needle = search.trim().toLowerCase();
    return needle === '' || `${record.businessKey} ${record.label ?? ''} ${record.legalBasis ?? ''}`.toLowerCase().includes(needle);
  });
  const filtering = search.trim() !== '' || status !== '' || type !== '';
  const rows = config.tree && !filtering ? inTreeOrder(filtered) : [...filtered].sort((left, right) => `${left.masterType}:${left.businessKey}`.localeCompare(`${right.masterType}:${right.businessKey}`)).map((record) => ({ record, depth: 0 }));
  const inForce = (rules.data ?? []).filter((record) => record.status === 'EFFECTIVE');

  const exportRows = (): void => {
    const heads = [...config.columns.map((item) => t(`mdm.catalogue.${item.key}.column`)), t('mdm.catalogue.status.column')];
    download(`${config.slug}.csv`, toCsv(heads, rows.map(({ record }) => [...config.columns.map((item) => item.read(record, context)), recordStatusLabel(t, record.status)])));
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t(`mdm.${config.slug}.page.title`)}</h1>
          <p>{t('mdm.catalogue.page.subtitle')}</p>
        </div>
        <div className="row-actions">
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={exportRows} disabled={rows.length === 0}>
            {t('mdm.catalogue.export.action')}
          </button>
          {canAdd ? (
            <Link className="button primary" to={`${CREATE_PATH}?${new URLSearchParams({ type: target }).toString()}`}>
              {t('mdm.catalogue.add.action')}
            </Link>
          ) : null}
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void Promise.all([entries.refetch(), rules.refetch(), config.linked === undefined ? undefined : links.refetch()])}>
        <div className="card">
          <form className="mdm-filters" role="search" onSubmit={(event) => event.preventDefault()} aria-label={t('mdm.catalogue.filter.title')}>
            <div className="field">
              <label htmlFor="catalogue-search">{t('mdm.catalogue.search.label')}</label>
              <input id="catalogue-search" type="search" value={search} placeholder={t('mdm.catalogue.search.placeholder')} onChange={(event) => setSearch(event.target.value)} />
            </div>
            {config.types.length > 1 ? (
              <div className="field">
                <label htmlFor="catalogue-type">{t('mdm.catalogue.type.label')}</label>
                <select id="catalogue-type" value={type} onChange={(event) => setType(event.target.value)}>
                  <option value="">{t('mdm.catalogue.type.all')}</option>
                  {config.types.map((candidate) => (
                    <option key={candidate} value={candidate}>
                      {candidate}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="catalogue-status">{t('mdm.catalogue.status.label')}</label>
              <select id="catalogue-status" value={status} onChange={(event) => setStatus(event.target.value as RecordStatus | '')}>
                <option value="">{t('mdm.catalogue.status.all')}</option>
                {STATUSES.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {recordStatusLabel(t, candidate)}
                  </option>
                ))}
              </select>
            </div>
          </form>
          {policies.data === undefined ? null : (
            <ul className="plain mdm-scopes" data-testid="scopes">
              {config.types.map((candidate) => {
                const found = policies.data?.find((item) => item.masterType === candidate);
                return found === undefined ? null : (
                  <li key={candidate} data-scope={found.scope}>
                    <code>{candidate}</code> · {scopeLabel(t, found.scope)}
                  </li>
                );
              })}
            </ul>
          )}
          {rows.length === 0 ? (
            <p className="muted" data-testid="empty-catalogue">
              {filtering ? t('mdm.catalogue.noMatch.text') : t('mdm.catalogue.empty.text')}
            </p>
          ) : (
            <KitTable caption={t('w2mdm.catalogue.table.caption')}>
              <thead>
                <tr>
                  {config.columns.map((item) => (
                    <th key={item.key}>{t(`mdm.catalogue.${item.key}.column`)}</th>
                  ))}
                  <th>{t('mdm.catalogue.status.column')}</th>
                  <th>
                    {t('mdm.catalogue.actions.column')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ record, depth }) => (
                  <tr key={record.id} data-record-id={record.id} data-key={record.businessKey} data-namespace={record.namespace} data-status={record.status}>
                    {config.columns.map((item, index) => (
                      <td key={item.key} style={index === 0 && depth > 0 ? { paddingInlineStart: depth * TREE_INDENT_PX } : undefined}>
                        {item.key === 'key' ? <code>{item.read(record, context)}</code> : item.read(record, context)}
                      </td>
                    ))}
                    <td>
                      <StatusPill tone={recordStatusTone(record.status)}>{recordStatusLabel(t, record.status)}</StatusPill>
                      {record.namespace === 'PLATFORM' ? <StatusPill tone="neutral">{t('mdm.catalogue.platform.pill')}</StatusPill> : null}
                      {record.openChangeRequestId === null ? null : <StatusPill tone="neutral">{t('mdm.catalogue.pending.pill')}</StatusPill>}
                    </td>
                    <td className="row-actions">
                      <Link to={recordLink(DETAIL_PATH, record.masterType, record.businessKey, record.namespace)}>{t('mdm.catalogue.open.action')}</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </KitTable>
          )}
          <p className="sub" data-testid="count">
            {t('mdm.catalogue.count.text', { count: rows.length })}
          </p>
        </div>
        {config.rules.length === 0 ? null : <RulePanel rules={inForce} />}
      </StateBoundary>
      <p className="prototype-note">{t('mdm.catalogue.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
