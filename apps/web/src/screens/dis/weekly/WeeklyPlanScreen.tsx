import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import '../dis.css';
import { Field } from '../components';
import { NONE, money, signedVnd } from '../rates/components';
import { useWeeklyPlans } from './hooks';
import { isValidationRefusal, planYearOf, standingOf } from './model';
import type { Standing } from './model';

const TONE: Readonly<Record<Standing, string>> = { short: 'warn', met: 'green', over: 'green', unknown: 'gray' };

/**
 * DIS-24: the weekly commitment of each project against what the Treasury paid in the week, with the leader in charge (ST-DIS-014, FR-DIS-24, Directive 162). Read only: the commitments are registered
 * on the capital schedule and the actuals are the frozen close snapshots. A commitment is a plan: it is never added to what was disbursed, and a week that is not frozen yet has no actual (it is not zero).
 */
export default function WeeklyPlanScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <WeeklyPlanContent key={tenantId ?? 'none'} route={route} />;
}

function WeeklyPlanContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [yearInput, setYearInput] = useState('');
  const year = planYearOf(yearInput);
  const plans = useWeeklyPlans({ planYear: year.year });
  const state = useScreenState({ isLoading: plans.isLoading, error: plans.error, data: plans.data, isEmpty: (data) => (data as { pages: Array<{ items: unknown[] }> }).pages.every((page) => page.items.length === 0) });
  const items = (plans.data?.pages ?? []).flatMap((page) => page.items);
  const shownYear = plans.data?.pages[0]?.planYear;
  const refused = plans.isError && isValidationRefusal(plans.error);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dis.weekly.page.title')}</h1>
          <p>{t('dis.weekly.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <div className="dis-filters" role="group" aria-label={t('dis.weekly.filter.title')}>
          <Field id="weekly-year" label={t('dis.weekly.filter.year')} error={year.valid ? undefined : t('dis.weekly.filter.year.invalid')} hint={t('dis.weekly.filter.year.hint')}>
            <input id="weekly-year" inputMode="numeric" maxLength={4} value={yearInput} onChange={(event) => setYearInput(event.target.value)} />
          </Field>
        </div>
      </div>
      {refused ? (
        <p className="callout warning" role="alert" data-testid="weekly-refusal">
          {t('dis.weekly.problem.validation')}
        </p>
      ) : null}
      <StateBoundary state={refused ? 'default' : state} onRetry={() => void plans.refetch()}>
        <section className="card" aria-labelledby="weekly-table-title">
          <h2 id="weekly-table-title">{t('dis.weekly.table.title', { year: shownYear === undefined ? NONE : String(shownYear) })}</h2>
          <p className="sub">{t('dis.weekly.table.note')}</p>
          <div className="tablewrap">
            <table className="table" aria-label={t('dis.weekly.table.aria')} data-testid="weekly-table">
              <thead>
                <tr>
                  <th scope="col">{t('dis.weekly.col.project')}</th>
                  <th scope="col">{t('dis.weekly.col.leader')}</th>
                  <th scope="col">{t('dis.weekly.col.week')}</th>
                  <th scope="col" className="num">
                    {t('dis.weekly.col.commitment')}
                  </th>
                  <th scope="col" className="num">
                    {t('dis.weekly.col.actual')}
                  </th>
                  <th scope="col" className="num">
                    {t('dis.weekly.col.difference')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => {
                  const standing = standingOf(row.differenceVnd);
                  return (
                    <tr key={`${row.projectId}|${row.periodId}`} data-project={row.projectId} data-period={row.periodId}>
                      <td>
                        {row.projectCode}
                        <span className="dis-code">{row.projectName}</span>
                      </td>
                      <td data-cell="leader">{row.leader === null ? t('dis.weekly.leader.none') : row.leader.displayName}</td>
                      <td>
                        {row.periodCode}
                        <span className="dis-code">{t('dis.weekly.week.range', { start: row.startDate, end: row.endDate })}</span>
                      </td>
                      <td className="num" data-cell="commitment">
                        {money(row.commitmentVnd)}
                      </td>
                      <td className="num" data-cell="actual">
                        {row.actualVnd === null ? <span className="muted">{t('dis.weekly.actual.pending')}</span> : money(row.actualVnd)}
                        {row.actualVnd !== null && row.fromYearStart ? <span className="dis-code">{t('dis.weekly.actual.fromYearStart')}</span> : null}
                      </td>
                      <td className="num" data-cell="difference">
                        {row.differenceVnd === null ? (
                          NONE
                        ) : (
                          <span className={`pill ${TONE[standing]}`} data-standing={standing}>
                            {signedVnd(row.differenceVnd)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {plans.hasNextPage ? (
            <p>
              <button type="button" disabled={plans.isFetchingNextPage} onClick={() => void plans.fetchNextPage()}>
                {t('dis.weekly.more.action')}
              </button>
            </p>
          ) : null}
        </section>
      </StateBoundary>
      <p className="prototype-note">{t('dis.weekly.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
