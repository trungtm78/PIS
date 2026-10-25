import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { amountText } from '../model';
import { useHolds } from './hooks';
import { blockerLabel, conditionLabel, statusLabel } from './labels';
import type { HoldLine } from './model';
import { ReleaseDialog } from './ReleaseDialog';
import '../../qms/qms.css';

/**
 * CTR-21: the retention held back from the payments of a contract, by line of the BOQ (ST-CTR-010, CTR 3.5, BR-CTR-09). For each line it shows what is held, the condition of the release (the end of the
 * warranty, the completion of the contract or a decision of the authority) with whether it is met today and, if not, what it waits for, the earliest day, what was released and what is still held.
 * The chief accountant releases a hold once its condition is met, never above what is held and never the money held in their own name. The server judges every command again.
 */
export default function RetentionScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The holds and the dialog belong to one membership: a switch of tenant or of membership starts the screen over.
  return <RetentionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RetentionContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { mode } = useSession();
  const [search] = useSearchParams();
  const contractId = search.get('contract');
  const holds = useHolds(contractId);
  const [releasing, setReleasing] = useState<HoldLine | undefined>(undefined);
  const state = useScreenState({ isLoading: holds.isLoading, error: holds.error, data: contractId === null || holds.isLoading ? undefined : holds.data, isEmpty: (data) => data === null });
  const writable = mode !== 'READ_ONLY';
  const money = (value: string): string => t('ctr.value.amount', { amount: amountText(value, locale) });
  const view = holds.data ?? undefined;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctr.retention.page.title')}</h1>
          <p>{t('ctr.retention.page.subtitle')}</p>
        </div>
      </div>
      {contractId === null ? (
        <p className="callout" role="status" data-testid="no-contract">
          {t('ctr.retention.none.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void holds.refetch()}>
          {view === undefined ? null : (
            <>
              <div className="card" data-testid="totals">
                <strong data-testid="contract">{t('ctr.retention.contract.label', { code: view.contract.code })}</strong>
                <small className="sub qms-regime" data-testid="held-total">
                  {t('ctr.retention.totals.held', { amount: money(view.contract.heldVnd) })}
                </small>
                <small className="sub qms-regime" data-testid="released-total">
                  {t('ctr.retention.totals.released', { amount: money(view.contract.releasedVnd) })}
                </small>
              </div>
              <div className="card">
                {view.items.length === 0 ? (
                  <p className="callout" role="status" data-testid="no-holds">
                    {t('ctr.retention.empty.notice')}
                  </p>
                ) : (
                  <table className="table" data-testid="holds">
                    <thead>
                      <tr>
                        <th scope="col">{t('ctr.retention.column.item')}</th>
                        <th scope="col">{t('ctr.retention.column.held')}</th>
                        <th scope="col">{t('ctr.retention.column.condition')}</th>
                        <th scope="col">{t('ctr.retention.column.notBefore')}</th>
                        <th scope="col">{t('ctr.retention.column.released')}</th>
                        <th scope="col">{t('ctr.retention.column.left')}</th>
                        <th scope="col">{t('ctr.retention.column.status')}</th>
                        <th scope="col">
                          <span className="sr-only">{t('ctr.retention.column.actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.items.map((line) => (
                        <tr key={line.id} data-hold={line.id} data-status={line.status}>
                          <td>
                            <strong data-testid="item">{line.item.key}</strong> <span data-testid="description">{line.item.description}</span>
                          </td>
                          <td data-testid="held">{money(line.heldVnd)}</td>
                          <td>
                            <span data-testid="condition">{conditionLabel(t, line.condition)}</span>
                            {line.status === 'HELD' || line.status === 'PARTIALLY_RELEASED' ? (
                              <small className="sub qms-regime" role="status" data-testid="condition-state">
                                {line.blocker === null ? t('ctr.retention.condition.met') : blockerLabel(t, line.blocker, line.releaseNotBefore)}
                              </small>
                            ) : null}
                          </td>
                          <td data-testid="not-before">{line.releaseNotBefore ?? t('ctr.retention.notBefore.none')}</td>
                          <td data-testid="released">
                            {money(line.releasedVnd)}
                            {line.releasedAt === null ? null : <small className="sub qms-regime">{t('ctr.retention.released.on', { day: line.releasedAt.slice(0, 10) })}</small>}
                          </td>
                          <td data-testid="left">{money(line.leftVnd)}</td>
                          <td>
                            <span className={line.status === 'RELEASED' ? 'qms-badge ok' : 'qms-badge'} data-testid="status">
                              {statusLabel(t, line.status)}
                            </span>
                          </td>
                          <td>
                            {writable && line.canRelease ? (
                              <button type="button" data-release={line.id} onClick={() => setReleasing(line)}>
                                {t('ctr.retention.release.action')}
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </StateBoundary>
      )}
      {releasing === undefined ? null : <ReleaseDialog hold={releasing} onClose={() => setReleasing(undefined)} />}
      <p className="prototype-note">{t('ctr.retention.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
