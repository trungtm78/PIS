import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import '../aud.css';
import { recommendationStatusLabel, recommendationTypeLabel } from '../conclusion/labels';
import { RECOMMENDATION_STATUSES, RECOMMENDATION_TYPES } from '../conclusion/model';
import { todayInVietnam } from '../model';
import { DueDay, EngagementFilter, Money, useCaller } from './components';
import { AssignDialog, DecisionDialog, DisputeDialog } from './dialogs';
import { useRecommendationBoard } from './hooks';
import type { BoardFilter } from './hooks';
import { BOARD_PATH, canAssign, canDecide, canDispute, matching } from './model';
import type { BoardItem } from './model';

type Dialog = { kind: 'assign' | 'dispute' | 'decide'; item: BoardItem };

/**
 * AUD-06: the recommendations of the engagements, who they were given to and by when (ST-AUD-003, AUD 3.3 and 3.5). A leader gives one to a unit of their scope with a day read from the
 * conclusion; the owner explains a recommendation they hold should not stand; the verifier records the answer of the authority. The data are confidential: the list holds the recommendations of
 * the engagements whose scope meets a grant of the caller, and the ones given to them.
 */
export default function RecommendationsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <RecommendationsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RecommendationsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const caller = useCaller();
  const [params] = useSearchParams();
  const engagementId = params.get('engagement') ?? undefined;
  const [filter, setFilter] = useState<Pick<BoardFilter, 'status' | 'type'>>({ status: '', type: '' });
  const [words, setWords] = useState('');
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const list = useRecommendationBoard({ engagementId, ...filter });
  // The list stays under its filters when they match nothing: the empty words are the table's, not the screen's.
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const shown = useMemo(() => matching(list.data ?? [], words), [list.data, words]);
  const today = todayInVietnam();
  const close = (): void => setDialog(undefined);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('aud.remediation.list.title')}</h1>
          <p>{t('aud.remediation.list.subtitle')}</p>
        </div>
      </div>
      <p className="callout" data-testid="confidential-note">
        {t('aud.remediation.confidential.note')}
      </p>
      <div className="card">
        <div className="aud-filters">
          <div className="field">
            <label htmlFor="remediation-search">{t('aud.remediation.filter.search.label')}</label>
            <input id="remediation-search" type="search" value={words} placeholder={t('aud.remediation.filter.search.placeholder')} onChange={(event) => setWords(event.target.value)} />
          </div>
          <EngagementFilter selected={engagementId} />
          <div className="field">
            <label htmlFor="remediation-status">{t('aud.remediation.filter.status.label')}</label>
            <select id="remediation-status" value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value as BoardFilter['status'] })}>
              <option value="">{t('aud.remediation.filter.status.all')}</option>
              {RECOMMENDATION_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {recommendationStatusLabel(t, status)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="remediation-type">{t('aud.remediation.filter.type.label')}</label>
            <select id="remediation-type" value={filter.type} onChange={(event) => setFilter({ ...filter, type: event.target.value as BoardFilter['type'] })}>
              <option value="">{t('aud.remediation.filter.type.all')}</option>
              {RECOMMENDATION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {recommendationTypeLabel(t, type)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          {shown.length === 0 ? (
            <p className="muted" data-testid="no-recommendations">
              {t('aud.remediation.list.none.text')}
            </p>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('aud.remediation.list.col.code')}</th>
                    <th>{t('aud.remediation.list.col.type')}</th>
                    <th>{t('aud.remediation.list.col.amount')}</th>
                    <th>{t('aud.remediation.list.col.owner')}</th>
                    <th>{t('aud.remediation.list.col.due')}</th>
                    <th>{t('aud.remediation.list.col.status')}</th>
                    <th>{t('aud.remediation.list.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((item) => (
                    <tr key={item.id} data-recommendation-id={item.id}>
                      <td>
                        <strong>{item.code}</strong>
                        <div className="sub">{item.description}</div>
                        <div className="sub">{item.engagement.code}</div>
                      </td>
                      <td>{recommendationTypeLabel(t, item.type)}</td>
                      <td>
                        <Money item={item} />
                      </td>
                      <td>
                        {item.ownerUnit === null ? (
                          t('aud.remediation.owner.none')
                        ) : (
                          <>
                            {item.ownerUnit.name}
                            {item.ownerUser === null ? null : <div className="sub">{item.ownerUser.name}</div>}
                          </>
                        )}
                      </td>
                      <td>
                        <DueDay item={item} today={today} />
                      </td>
                      <td>
                        <span className="aud-badge">{recommendationStatusLabel(t, item.status)}</span>
                      </td>
                      <td>
                        <div className="aud-row-actions">
                          {canAssign(item, caller) ? (
                            <button type="button" onClick={() => setDialog({ kind: 'assign', item })}>
                              {item.status === 'OPEN' ? t('aud.remediation.assign.action') : t('aud.remediation.reassign.action')}
                            </button>
                          ) : null}
                          {canDispute(item, caller) ? (
                            <button type="button" onClick={() => setDialog({ kind: 'dispute', item })}>
                              {t('aud.remediation.dispute.action')}
                            </button>
                          ) : null}
                          {canDecide(item, caller) ? (
                            <button type="button" onClick={() => setDialog({ kind: 'decide', item })}>
                              {t('aud.remediation.decision.action')}
                            </button>
                          ) : null}
                          <Link to={`${BOARD_PATH}?engagement=${item.engagement.id}`}>{t('aud.remediation.list.open.link')}</Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="sub" data-testid="recommendation-count">
            {t('aud.remediation.list.count.text', { count: shown.length })}
          </p>
        </StateBoundary>
      </div>
      {dialog?.kind === 'assign' ? <AssignDialog item={dialog.item} onClose={close} /> : null}
      {dialog?.kind === 'dispute' ? <DisputeDialog item={dialog.item} onClose={close} /> : null}
      {dialog?.kind === 'decide' ? <DecisionDialog item={dialog.item} onClose={close} /> : null}
      <p className="prototype-note">{t('aud.remediation.list.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
