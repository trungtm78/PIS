import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { mayAct } from '../approval-model';
import { Money } from '../components';
import { useProjects } from '../plan-hooks';
import { monthLabel } from '../schedule-labels';
import { ADJUSTMENT_MONTH, REGISTER_SCHEDULE_PERMISSION } from '../schedule-model';
import '../cap.css';
import { EacPanel, NONE, Picker, useChoice } from './components';
import { useScheduleLines } from './hooks';
import { EAC_READ_PERMISSION, ENTRY_PATH, READ_PERMISSION, linkTo, mayRead, planRows, planTotals, signedMillions } from './model';

/**
 * CAP-12: the plan of estimated disbursement of a project in a year (ST-CAP-012, CAP 3.1 F7, BR-CAP-08): for each month what is estimated, what was registered, what the Treasury paid and the difference between the estimate
 * and the registration, with the year-end estimate (EAC) that DIS gives for the project. An estimate is a promise and never money paid, so the paid column is that of the registrations alone. Estimates are entered on CAP-13,
 * which whoever may register is sent to.
 */
export default function ForecastPlanScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The plan is read for one person in one tenant: a move to another starts the screen over.
  return <PlanContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PlanContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const readable = mayRead(permissions, READ_PERMISSION);
  const projects = useProjects(readable);
  const offered = projects.data ?? [];
  const { selected, typedYear, year, chooseProject, chooseYear } = useChoice(offered);
  const lines = useScheduleLines(selected?.id, year, readable);
  // The choice stays on screen while a project or a year is read: only the register of projects replaces the whole screen, the schedules have their own card inside the plan.
  const state = useScreenState({ isLoading: readable && projects.isLoading, error: readable ? projects.error : undefined, data: readable ? projects.data : undefined });
  const linesState = useScreenState({ isLoading: lines.isLoading, error: lines.error, data: lines.data, isEmpty: () => false });
  const rows = planRows(lines.data ?? []);
  const total = planTotals(rows);
  const empty = lines.data !== undefined && lines.data.length === 0;
  const figure = (vnd: string | null) => (vnd === null ? <small className="sub">{NONE}</small> : <Money vnd={vnd} />);
  const difference = (vnd: string | null) => (vnd === null ? <small className="sub">{NONE}</small> : signedMillions(vnd, locale));
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.forecast.page.title')}</h1>
          <p>{t('cap.forecast.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={readable ? state : 'denied'} onRetry={() => void projects.refetch()}>
        {selected === undefined ? null : (
          <>
            <Picker id="plan" offered={offered} selected={selected} typedYear={typedYear} yearValid={year !== undefined} onProject={chooseProject} onYear={chooseYear} />
            <p className="callout" role="note" data-testid="promise">
              {t('cap.forecast.note.promise.notice')}
            </p>
            <EacPanel projectId={selected.id} allowed={mayRead(permissions, EAC_READ_PERMISSION)} />
            {year === undefined ? null : (
              <div className="card" data-testid="plan" data-year={year}>
                <h2>{t('cap.forecast.table.title', { year })}</h2>
                {empty ? (
                  <p className="callout" role="status" data-testid="no-estimate">
                    {t('cap.forecast.empty.notice')}
                  </p>
                ) : null}
                <StateBoundary state={linesState} onRetry={() => void lines.refetch()}>
                  <div className="cap-scroll">
                    <table className="table cap-table" aria-label={t('cap.forecast.table.aria', { year })}>
                      <thead>
                        <tr>
                          <th scope="col">{t('cap.forecast.column.month')}</th>
                          <th scope="col" className="cap-number">
                            {t('cap.forecast.column.forecast')}
                          </th>
                          <th scope="col" className="cap-number">
                            {t('cap.forecast.column.registered')}
                          </th>
                          <th scope="col" className="cap-number">
                            {t('cap.forecast.column.actual')}
                          </th>
                          <th scope="col" className="cap-number">
                            {t('cap.forecast.column.difference')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.month} data-month={row.month}>
                            <th scope="row">{monthLabel(t, row.month, row.month === ADJUSTMENT_MONTH)}</th>
                            <td className="cap-number" data-testid="forecast">
                              {figure(row.forecastVnd)}
                            </td>
                            <td className="cap-number" data-testid="registered">
                              {figure(row.registeredVnd)}
                            </td>
                            <td className="cap-number" data-testid="actual">
                              {figure(row.actualVnd)}
                            </td>
                            <td className="cap-number" data-testid="difference">
                              {difference(row.differenceVnd)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <th scope="row">{t('cap.forecast.total.label')}</th>
                          <td className="cap-number" data-testid="total-forecast">
                            {figure(total.forecastVnd)}
                          </td>
                          <td className="cap-number" data-testid="total-registered">
                            {figure(total.registeredVnd)}
                          </td>
                          <td className="cap-number" data-testid="total-actual">
                            {figure(total.actualVnd)}
                          </td>
                          <td className="cap-number" data-testid="total-difference">
                            {difference(total.differenceVnd)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </StateBoundary>
              </div>
            )}
            {mayAct(permissions, mode, REGISTER_SCHEDULE_PERMISSION) ? (
              <p>
                <Link className="button" to={linkTo(ENTRY_PATH, selected.id, typedYear)} data-testid="enter">
                  {t('cap.forecast.enter.action')}
                </Link>
              </p>
            ) : null}
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('cap.forecast.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
