import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useAdvances, useRecoveryPlan } from '../../pay/advance/hooks';
import { kindLabel, statusLabel } from '../../pay/advance/labels';
import { listLink, recoveredShare, scheduleLink, signedAmountText } from '../../pay/advance/model';
import { BackLink } from '../components';
import '../ctr.css';

/**
 * CTR-06: the advances of a contract and the schedule of their recovery (ST-PAY-004, PAY 3.2, BR-PAY-04, BR-PAY-10). For each advance: its value, what has come back and what is still owed, the
 * day it must be back by, the cap the rule of the day gave the member (and that the rule waits for its confirmation, when it does), and the member of the joint venture it was paid to. For the
 * advance in view, the recovery by the formula: it is recovered in proportion to what the member asked to be paid, and in full once that reaches the threshold of the work of the member, whatever
 * the other members have done. Every figure is the server's and read-only.
 */
export default function ScheduleScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The schedule belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <ScheduleContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ScheduleContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const [search] = useSearchParams();
  const contractId = search.get('contract');
  const named = search.get('advance');
  const advances = useAdvances({ contractId: contractId ?? undefined });
  const list = contractId === null ? [] : (advances.data ?? []);
  const inView = list.find((advance) => advance.id === named) ?? list[0];
  const plan = useRecoveryPlan(inView?.id);
  const state = useScreenState({ isLoading: advances.isLoading, error: advances.error, data: contractId === null ? null : advances.data, isEmpty: (data) => data === null });
  const money = (value: string): string => signedAmountText(value, locale) ?? value;
  const awaiting = list.find((advance) => advance.capRuleAwaitingConfirmation);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      {contractId === null ? null : <BackLink to={listLink(contractId)}>{t('ctr.advance.back')}</BackLink>}
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctr.advance.title')}</h1>
          <p>{t('ctr.advance.subtitle')}</p>
        </div>
      </div>
      {contractId === null ? (
        <p className="callout" role="status" data-testid="no-contract">
          {t('ctr.advance.none')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void advances.refetch()}>
          {awaiting === undefined ? null : (
            <p className="callout warning" role="status" data-testid="awaiting">
              {t('ctr.advance.awaiting', { cxn: awaiting.capRuleCxn ?? '' })}
            </p>
          )}
          <article className="card" aria-label={t('ctr.advance.advances')}>
            {list.length === 0 ? (
              <p className="sub" data-testid="no-advances">
                {t('ctr.advance.empty')}
              </p>
            ) : (
              <table className="table" data-testid="advances">
                <thead>
                  <tr>
                    <th scope="col">{t('ctr.advance.column.tranche')}</th>
                    <th scope="col">{t('ctr.advance.column.member')}</th>
                    <th scope="col" className="ctr-amount">
                      {t('ctr.advance.column.amount')}
                    </th>
                    <th scope="col" className="ctr-amount">
                      {t('ctr.advance.column.recovered')}
                    </th>
                    <th scope="col" className="ctr-amount">
                      {t('ctr.advance.column.outstanding')}
                    </th>
                    <th scope="col">{t('ctr.advance.column.deadline')}</th>
                    <th scope="col" className="ctr-amount">
                      {t('ctr.advance.column.cap')}
                    </th>
                    <th scope="col">{t('ctr.advance.column.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((advance) => (
                    <tr key={advance.id} data-advance={advance.id} aria-current={advance.id === inView?.id ? 'true' : undefined}>
                      <td>
                        <Link to={scheduleLink(advance.contract.id, advance.id)} data-testid="open">
                          {t('ctr.advance.tranche', { no: advance.trancheNo, kind: kindLabel(t, advance.kind) })}
                        </Link>
                      </td>
                      <td data-testid="member">
                        {advance.party.name ?? advance.party.role} · {advance.party.role}
                      </td>
                      <td className="ctr-amount" data-testid="amount">
                        {money(advance.amountVnd)}
                      </td>
                      <td className="ctr-amount" data-testid="recovered">
                        {money(advance.recoveredVnd)}
                      </td>
                      <td className="ctr-amount" data-testid="outstanding">
                        {money(advance.outstandingVnd)}
                      </td>
                      <td data-testid="deadline">{advance.recoveryDeadline ?? ''}</td>
                      <td className="ctr-amount" data-testid="cap">
                        {advance.capPct === null ? money(advance.capVnd) : t('ctr.advance.cap', { pct: advance.capPct, amount: money(advance.capVnd) })}
                      </td>
                      <td data-testid="status">{statusLabel(t, advance.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </article>
          {inView === undefined ? null : (
            <article className="card" aria-label={t('ctr.advance.schedule')}>
              <h2>{t('ctr.advance.schedule')}</h2>
              {plan.data === null || plan.data === undefined ? (
                <p className="sub" data-testid="no-plan">
                  {plan.isLoading ? t('ctr.advance.loading') : t('ctr.advance.noPlan')}
                </p>
              ) : (
                <>
                  <dl className="ctr-facts">
                    <dt>{t('ctr.advance.fact.threshold')}</dt>
                    <dd data-testid="threshold">{t('ctr.advance.fact.thresholdValue', { pct: plan.data.advance.thresholdPct, amount: money(plan.data.thresholdValueVnd) })}</dd>
                    <dt>{t('ctr.advance.fact.work')}</dt>
                    <dd data-testid="work">{money(plan.data.advance.party.workValueVnd)}</dd>
                    <dt>{t('ctr.advance.fact.gross')}</dt>
                    <dd data-testid="gross">{money(plan.data.grossToDateVnd)}</dd>
                    <dt>{t('ctr.advance.fact.remaining')}</dt>
                    <dd data-testid="remaining">{money(plan.data.remainingToThresholdVnd)}</dd>
                    <dt>{t('ctr.advance.fact.target')}</dt>
                    <dd data-testid="target">{money(plan.data.targetRecoveredVnd)}</dd>
                    <dt>{t('ctr.advance.fact.behind')}</dt>
                    <dd data-testid="behind">{money(plan.data.behindVnd)}</dd>
                  </dl>
                  <progress max={100} value={recoveredShare(plan.data.advance)} aria-label={t('ctr.advance.share')} data-testid="share" />
                  <table className="table" data-testid="milestones">
                    <thead>
                      <tr>
                        <th scope="col" className="ctr-amount">
                          {t('ctr.advance.milestone.share')}
                        </th>
                        <th scope="col" className="ctr-amount">
                          {t('ctr.advance.milestone.gross')}
                        </th>
                        <th scope="col" className="ctr-amount">
                          {t('ctr.advance.milestone.recovered')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.data.milestones.map((milestone) => (
                        <tr key={milestone.atPct} data-milestone={milestone.atPct}>
                          <td className="ctr-amount">{milestone.atPct}%</td>
                          <td className="ctr-amount" data-testid="milestone-gross">
                            {money(milestone.atGrossVnd)}
                          </td>
                          <td className="ctr-amount" data-testid="milestone-recovered">
                            {money(milestone.recoveredVnd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </article>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('ctr.advance.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
