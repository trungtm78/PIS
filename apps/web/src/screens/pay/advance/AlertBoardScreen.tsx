import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { AcknowledgeDialog, RecoveryDialog } from './AdvanceDialogs';
import { useOverdueAdvances } from './hooks';
import { kindLabel, levelLabel } from './labels';
import { ALERT_LEVELS, scheduleLink, signedAmountText } from './model';
import type { Advance, AlertLevel } from './model';
import '../pay.css';

type Dialog = { kind: 'recovery' | 'acknowledge'; advance: Advance };

const levelOf = (value: string | null): AlertLevel | null => ALERT_LEVELS.find((level) => String(level) === value) ?? null;

/**
 * PAY-12: the advances that are owed past the day they had to be recovered by, or are about to be (ST-PAY-011, PAY 3.2 steps 4 and 5, UAT-AC328, UAT-AC329), narrowed by the level of the alert: seven days before the
 * deadline, the deadline, overdue, escalated to the leader. For each: the contract and the member, what is still owed, the deadline, the days late and the plan that was given. A person who may record a recovery or give a
 * plan has the buttons; a plan stores a note and a day and nothing else, and no button here marks an advance as recovered. The server judges each command again.
 */
export default function AlertBoardScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The board belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <AlertBoardContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function AlertBoardContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const level = levelOf(search.get('level'));
  const board = useOverdueAdvances(level);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);
  const state = useScreenState({ isLoading: board.isLoading, error: board.error, data: board.data, isEmpty: () => false });
  const money = (value: string): string => signedAmountText(value, locale) ?? value;
  const writable = mode !== 'READ_ONLY';
  const choose = (value: string): void => setSearch(value === '' ? {} : { level: value }, { replace: true });
  const finished = (message: string) => (): void => {
    setDone(message);
    setDialog(undefined);
  };
  // A dialog on an advance names the advance, not a copy of it: it is read again from the board each time it is drawn, so that a retry sends the version the board shows now.
  const advances = board.data ?? [];
  const target = dialog === undefined ? undefined : advances.find((advance) => advance.id === dialog.advance.id);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.alert.title')}</h1>
          <p>{t('pay.alert.subtitle')}</p>
        </div>
      </div>
      <article className="card" aria-label={t('pay.alert.filter')}>
        <label>
          {t('pay.alert.level.filter')}
          <select value={level === null ? '' : String(level)} onChange={(event) => choose(event.target.value)} data-testid="filter-level">
            <option value="">{t('pay.advance.list.all')}</option>
            {ALERT_LEVELS.map((candidate) => (
              <option key={candidate} value={String(candidate)}>
                {levelLabel(t, candidate)}
              </option>
            ))}
          </select>
        </label>
      </article>
      {done === undefined ? null : (
        <p className="callout" role="status" data-testid="done">
          {done}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void board.refetch()}>
        <article className="card" aria-label={t('pay.alert.list')}>
          {advances.length === 0 ? (
            <p className="sub" data-testid="no-alerts">
              {t('pay.alert.empty')}
            </p>
          ) : (
            <table className="table" data-testid="alerts">
              <thead>
                <tr>
                  <th scope="col">{t('pay.advance.column.contract')}</th>
                  <th scope="col">{t('pay.advance.column.member')}</th>
                  <th scope="col" className="pay-amount">
                    {t('pay.advance.column.outstanding')}
                  </th>
                  <th scope="col">{t('pay.advance.column.deadline')}</th>
                  <th scope="col" className="pay-amount">
                    {t('pay.advance.column.overdue')}
                  </th>
                  <th scope="col">{t('pay.alert.column.level')}</th>
                  <th scope="col">{t('pay.alert.column.plan')}</th>
                  <th scope="col">{t('pay.advance.column.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {advances.map((advance) => (
                  <tr key={advance.id} data-advance={advance.id} data-level={advance.lastAlertLevel}>
                    <td>
                      <Link to={scheduleLink(advance.contract.id, advance.id)} data-testid="schedule">
                        {advance.contract.code}
                      </Link>{' '}
                      <span className="sub" data-testid="tranche">
                        {t('pay.advance.tranche', { no: advance.trancheNo, kind: kindLabel(t, advance.kind) })}
                      </span>
                    </td>
                    <td data-testid="member">{advance.party.name ?? advance.party.role}</td>
                    <td className="pay-amount" data-testid="outstanding">
                      {money(advance.outstandingVnd)}
                    </td>
                    <td data-testid="deadline">{advance.recoveryDeadline ?? ''}</td>
                    <td className="pay-amount" data-testid="overdue">
                      {advance.overdueDays ?? ''}
                    </td>
                    <td>
                      <span className={advance.lastAlertLevel >= 3 ? 'pay-badge warning' : 'pay-badge'} data-testid="level">
                        {levelLabel(t, levelOf(String(advance.lastAlertLevel)) ?? 1)}
                      </span>
                    </td>
                    <td data-testid="plan">
                      {advance.acknowledgement === null ? t('pay.alert.noPlan') : t('pay.alert.plan', { day: advance.acknowledgement.planDueOn })}
                      {advance.acknowledgement === null ? null : (
                        <span className="sub" data-testid="plan-note">
                          {' '}
                          {advance.acknowledgement.note}
                        </span>
                      )}
                    </td>
                    <td>
                      {writable && advance.actions.recordRecovery ? (
                        <button type="button" onClick={() => setDialog({ kind: 'recovery', advance })} data-action="recover">
                          {t('pay.advance.action.recover')}
                        </button>
                      ) : null}{' '}
                      {writable && advance.actions.acknowledgeAlert ? (
                        <button type="button" onClick={() => setDialog({ kind: 'acknowledge', advance })} data-action="acknowledge">
                          {t('pay.alert.action.acknowledge')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      </StateBoundary>
      {dialog?.kind === 'recovery' && target !== undefined ? <RecoveryDialog advance={target} onDone={finished(t('pay.advance.done.recovered'))} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'acknowledge' && target !== undefined ? <AcknowledgeDialog advance={target} onDone={finished(t('pay.alert.done.acknowledged'))} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('pay.alert.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
