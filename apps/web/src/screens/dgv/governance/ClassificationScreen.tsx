import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { routeLabel } from '../../llm/labels';
import { Field } from '../../mne/components';
import { NO_FILTER, useCatalog } from '../hooks';
import { classificationLabel } from '../labels';
import { CLASSIFICATION_LIST } from '../model';
import type { Classification } from '../model';
import { Frame, Gate } from './components';
import { CATALOG_READ_PERMISSION, classificationCounts, holdsPersonalData, routesOf } from './model';

/**
 * DGV-15: the classification and the rights over data (ST-DGV-010, DGV 3.1, BR-DGV-11): how many datasets stand at each of the five levels, and for each dataset its level, whether it holds personal data and the routes of the
 * AI gateway its level allows. The classification of a dataset is where the routing of AI and the policy of BI start from. The catalogue is read with the rights of the caller: a dataset the caller may not see is not listed and
 * is not counted.
 */
export default function ClassificationScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const tenant = useSession().tenant;
  // What is chosen belongs to one member of one tenant: a switch starts the screen over.
  return (
    <Frame key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} title={t('dgv.governance.cls.page.title')} subtitle={t('dgv.governance.cls.page.subtitle')}>
      <Gate permission={CATALOG_READ_PERMISSION} name="classification">
        <ClassificationView />
      </Gate>
    </Frame>
  );
}

function ClassificationView() {
  const { t } = useTranslation();
  const [level, setLevel] = useState<'' | Classification>('');
  const catalog = useCatalog(NO_FILTER);
  const state = useScreenState({ isLoading: catalog.isLoading, error: catalog.error, data: catalog.data });
  const counts = classificationCounts(catalog.data ?? []);
  const rows = (catalog.data ?? []).filter((dataset) => level === '' || dataset.classification === level);
  return (
    <StateBoundary state={state} onRetry={() => void catalog.refetch()}>
      <ul className="aud-cards" data-testid="classification-counts">
        {CLASSIFICATION_LIST.map((entry) => (
          <li key={entry} className="card" data-classification={entry}>
            <strong>{counts[entry]}</strong> <span className="sub">{classificationLabel(t, entry)}</span>
          </li>
        ))}
      </ul>
      <p className="sub" data-testid="classification-policy">
        {t('dgv.governance.cls.policy.note')}
      </p>
      <div className="card">
        <Field id="cls-level" label={t('dgv.governance.cls.filter.level')} error={undefined}>
          <select id="cls-level" value={level} onChange={(event) => setLevel(event.target.value as '' | Classification)}>
            <option value="">{t('dgv.governance.filter.all')}</option>
            {CLASSIFICATION_LIST.map((entry) => (
              <option key={entry} value={entry}>
                {classificationLabel(t, entry)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="tablewrap">
        <table className="table" data-testid="classification-table" aria-label={t('dgv.governance.cls.table.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('dgv.governance.cls.column.dataset')}</th>
              <th scope="col">{t('dgv.governance.cls.column.level')}</th>
              <th scope="col">{t('dgv.governance.cls.column.pii')}</th>
              <th scope="col">{t('dgv.governance.cls.column.routes')}</th>
              <th scope="col">{t('dgv.governance.cls.column.owner')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((dataset) => (
              <tr key={dataset.id} data-dataset-id={dataset.id} data-classification={dataset.classification}>
                <td>
                  <strong>{dataset.datasetCode}</strong> <span className="sub">{dataset.title}</span>
                  <br />
                  <span className="sub">{dataset.domain}</span>
                </td>
                <td>
                  {classificationLabel(t, dataset.classification)}
                  {dataset.isCritical ? <span className="aud-badge warning"> {t('dgv.governance.cls.critical')}</span> : null}
                </td>
                <td>{holdsPersonalData(dataset.classification) ? t('dgv.governance.cls.pii.yes') : t('dgv.governance.cls.pii.no')}</td>
                <td>
                  {routesOf(dataset.classification)
                    .map((entry) => routeLabel(t, entry))
                    .join(', ')}
                </td>
                <td>{dataset.ownerName ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? <p data-testid="classification-none">{t('dgv.governance.cls.none.notice')}</p> : null}
    </StateBoundary>
  );
}
