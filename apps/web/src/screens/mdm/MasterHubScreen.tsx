import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useQueue, useRecords } from './hooks';
import { recordStatusLabel } from './labels';
import { PROPOSE_PERMISSION, recordLink } from './model';
import type { RecordView } from './model';

const CREATE_PATH = '/mdm/mdm-25';
const DETAIL_PATH = '/mdm/mdm-27';
const HISTORY_PATH = '/mdm/mdm-28';
const APPROVAL_PATH = '/mdm/mdm-32';

interface TypeCard {
  masterType: string;
  total: number;
  inForce: number;
  open: number;
}

function cardsOf(records: readonly RecordView[]): TypeCard[] {
  const byType = new Map<string, TypeCard>();
  for (const record of records) {
    const card = byType.get(record.masterType) ?? { masterType: record.masterType, total: 0, inForce: 0, open: 0 };
    card.total += 1;
    if (record.status === 'EFFECTIVE') card.inForce += 1;
    if (record.openChangeRequestId !== null) card.open += 1;
    byType.set(record.masterType, card);
  }
  return [...byType.values()].sort((left, right) => left.masterType.localeCompare(right.masterType));
}

/** MDM-01: the master data hub: the catalogues of the tenant, what is in force and what waits for a decision. */
export default function MasterHubScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <MasterHubContent key={tenantId ?? 'none'} route={route} />;
}

function MasterHubContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const chosen = params.get('type') ?? undefined;
  const canPropose = (permissions === undefined || permissions.includes(PROPOSE_PERMISSION)) && mode !== 'READ_ONLY';
  const records = useRecords(undefined);
  const waiting = useQueue('IN_REVIEW');
  const state = useScreenState({ isLoading: records.isLoading, error: records.error, data: records.data });
  const cards = useMemo(() => cardsOf(records.data ?? []), [records.data]);
  const shown = useMemo(() => (records.data ?? []).filter((record) => chosen === undefined || record.masterType === chosen), [records.data, chosen]);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mdm.hub.page.title')}</h1>
          <p>{t('mdm.hub.page.subtitle')}</p>
        </div>
        <div className="row-actions">
          <Link to={APPROVAL_PATH} data-testid="queue-link">
            {t('mdm.hub.queue.link', { count: waiting.data?.length ?? 0 })}
          </Link>
          {canPropose ? (
            <Link className="button primary" to={CREATE_PATH}>
              {t('mdm.hub.add.action')}
            </Link>
          ) : null}
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void records.refetch()}>
        <div className="cards" aria-label={t('mdm.hub.types.title')}>
          {cards.map((card) => (
            <button
              key={card.masterType}
              type="button"
              className="card"
              data-type-card={card.masterType}
              aria-pressed={chosen === card.masterType}
              onClick={() => setParams(chosen === card.masterType ? {} : { type: card.masterType })}
            >
              <strong>{card.masterType}</strong>
              <span className="sub">{t('mdm.hub.card.summary', { total: card.total, inForce: card.inForce, open: card.open })}</span>
            </button>
          ))}
        </div>
        <div className="card">
          <h2>{chosen === undefined ? t('mdm.hub.table.all.title') : t('mdm.hub.table.type.title', { type: chosen })}</h2>
          <table className="table">
            <thead>
              <tr>
                <th>{t('mdm.hub.col.type')}</th>
                <th>{t('mdm.hub.col.key')}</th>
                <th>{t('mdm.hub.col.name')}</th>
                <th>{t('mdm.hub.col.status')}</th>
                <th>{t('mdm.hub.col.validity')}</th>
                <th>
                  <span className="sr-only">{t('mdm.hub.col.actions')}</span>
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
                  <td>{record.label ?? ''}</td>
                  <td>
                    {recordStatusLabel(t, record.status)}
                    {record.openChangeRequestId === null ? null : <span className="pill gray">{t('mdm.hub.pending.pill')}</span>}
                  </td>
                  <td>{record.validFrom === null ? '' : `${record.validFrom} → ${record.validUntil ?? ''}`}</td>
                  <td className="row-actions">
                    <Link to={recordLink(DETAIL_PATH, record.masterType, record.businessKey)}>{t('mdm.hub.open.action')}</Link>
                    <Link to={recordLink(HISTORY_PATH, record.masterType, record.businessKey)}>{t('mdm.hub.history.action')}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('mdm.hub.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
