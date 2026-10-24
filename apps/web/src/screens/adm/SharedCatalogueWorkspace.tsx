import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { WebRoute } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { recordStatusLabel } from '../mdm/labels';
import type { RecordView } from '../mdm/model';
import { HUB_PATH, catalogueRoute, entryRoute, groupsOf, nameOf, validityOf, versionOf } from './catalogues/model';

export interface SharedCatalogueWorkspaceProps {
  route: WebRoute;
  records: readonly RecordView[];
}

/**
 * ADM-05: the shared catalogues of the tenant (ST-ADM-019). Administration shows what master data holds to those who may read it (the screen is denied to the rest);
 * it writes nothing: every change of an entry goes through the commands of master data (MDM), with their impact preview and approval.
 */
export function SharedCatalogueWorkspace({ route, records }: SharedCatalogueWorkspaceProps) {
  const tenantId = useSession().tenant?.id;
  // The filter belongs to one tenant: a switch starts it over.
  return <Workspace key={tenantId ?? 'none'} route={route} records={records} />;
}

function Workspace({ route, records }: SharedCatalogueWorkspaceProps) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState('');
  const groups = useMemo(() => groupsOf(records), [records]);
  const shown = useMemo(() => records.filter((record) => chosen === '' || record.masterType === chosen), [records, chosen]);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.catalogues.page.title')}</h1>
          <p>{t('adm.catalogues.page.subtitle')}</p>
        </div>
        <div className="row-actions">
          <Link to={HUB_PATH} data-testid="hub-link">
            {t('adm.catalogues.hub.link')}
          </Link>
        </div>
      </div>
      <div className="cards" aria-label={t('adm.catalogues.types.title')}>
        {groups.map((group) => (
          <div key={group.masterType} className="card" data-type-card={group.masterType}>
            <strong>{group.masterType}</strong>
            <span className="sub">{t('adm.catalogues.card.summary', { total: group.total, inForce: group.inForce })}</span>
            <Link to={catalogueRoute(group.masterType)} data-testid="open-catalogue">
              {t('adm.catalogues.open.action')}
            </Link>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="field" data-field="catalogue-type">
          <label htmlFor="catalogue-type">{t('adm.catalogues.type.label')}</label>
          <select id="catalogue-type" value={chosen} onChange={(event) => setChosen(event.target.value)}>
            <option value="">{t('adm.catalogues.type.all.option')}</option>
            {groups.map((group) => (
              <option key={group.masterType} value={group.masterType}>
                {group.masterType}
              </option>
            ))}
          </select>
        </div>
        <table className="table" aria-label={t('adm.catalogues.table.aria')}>
          <caption className="sr-only">{t('adm.catalogues.table.caption', { count: shown.length })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('adm.catalogues.column.type')}</th>
              <th scope="col">{t('adm.catalogues.column.key')}</th>
              <th scope="col">{t('adm.catalogues.column.name')}</th>
              <th scope="col">{t('adm.catalogues.column.validity')}</th>
              <th scope="col">{t('adm.catalogues.column.namespace')}</th>
              <th scope="col">{t('adm.catalogues.column.version')}</th>
              <th scope="col">
                <span className="sr-only">{t('adm.catalogues.column.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((record) => (
              <tr key={record.id} data-record-id={record.id} data-status={record.status}>
                <td>{record.masterType}</td>
                <td>
                  <code>{record.businessKey}</code>
                </td>
                <td>
                  {nameOf(record)} <small className="sub">{recordStatusLabel(t, record.status)}</small>
                </td>
                <td>{validityOf(record)}</td>
                <td data-namespace={record.namespace}>{record.namespace === 'PLATFORM' ? t('adm.catalogues.namespace.platform.label') : t('adm.catalogues.namespace.tenant.label')}</td>
                <td>{versionOf(record)}</td>
                <td className="row-actions">
                  <Link to={entryRoute(record)} data-testid="open-entry">
                    {t('adm.catalogues.detail.action')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="prototype-note">{t('adm.catalogues.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
