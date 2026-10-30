import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ISSUE_STATUSES } from '../issue-model';
import { statusLabel } from '../issue-labels';
import '../iss.css';
import { useWeeklyMatrix } from './hooks';
import { READ_PERMISSION, drillLink, isWeek, progressPercent } from './model';
import type { Matrix } from './model';
import { useWeek } from './useWeek';
import { WeekControls } from './WeekControls';

/** What both screens share: the week and the unit, the read of the matrix with its seven states, and the frame. The reader of one screen sees the same matrix as the reader of the other. */
function Frame({ route, title, subtitle, children }: ScreenProps & { title: string; subtitle: string; children(matrix: Matrix): ReactNode }) {
  const { t } = useTranslation();
  const { permissions, tenant } = useSession();
  const { week, unitId, set } = useWeek();
  const canRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const valid = isWeek(week);
  const matrix = useWeeklyMatrix(week, unitId, canRead && valid);
  // The choice of units is the units of the matrix of the week as a whole, also while one of them is chosen.
  const everyone = useWeeklyMatrix(week, '', canRead && valid);
  const choices = (everyone.data?.units ?? []).map((entry) => entry.unit);
  const state = useScreenState({ isLoading: valid && matrix.isLoading, error: valid ? matrix.error : undefined, data: valid ? matrix.data : undefined, isEmpty: (data: unknown) => data === null });
  const view = valid ? (matrix.data ?? undefined) : undefined;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`}>
      <div className="heading">
        <div>
          <h1 id="screen-title">{title}</h1>
          <p>{subtitle}</p>
        </div>
      </div>
      <WeekControls week={week} unitId={unitId} units={choices} onChange={set} />
      <StateBoundary state={!canRead ? 'denied' : !valid ? 'default' : state} onRetry={() => void matrix.refetch()}>
        {view === undefined ? null : (
          <>
            <p className="sub" data-testid="range">
              {t('iss.weekly.range.text', { week: view.week, from: view.from, to: view.to })}
            </p>
            {view.rows.length === 0 ? (
              <p className="callout" role="status" data-testid="no-rows">
                {t('iss.weekly.empty.notice')}
              </p>
            ) : (
              children(view)
            )}
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('iss.weekly.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/**
 * ISS-08: the matrix of the issues by week (ST-ISS-006, BR-ISS-08): for each unit and group of issues, what stood open when the week began, what became open in it, what was closed and what stood open when it ended; and the
 * issues of each unit by the status they had when the week ended, each count opening the list of the issues it counts.
 */
export function IssueMatrixScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  return (
    <Frame route={route} title={t('iss.weekly.matrix.title')} subtitle={t('iss.weekly.matrix.subtitle')}>
      {(matrix) => (
        <>
          <div className="card">
            <table className="table" data-testid="flows">
              <thead>
                <tr>
                  <th scope="col">{t('iss.weekly.column.week')}</th>
                  <th scope="col">{t('iss.weekly.column.unit')}</th>
                  <th scope="col">{t('iss.weekly.column.group')}</th>
                  <th scope="col">{t('iss.weekly.column.opened')}</th>
                  <th scope="col">{t('iss.weekly.column.opening')}</th>
                  <th scope="col">{t('iss.weekly.column.resolved')}</th>
                  <th scope="col">{t('iss.weekly.column.closing')}</th>
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map((row) => (
                  <tr key={`${row.unit.id}:${row.categoryVersionId}`} data-unit={row.unit.id} data-group={row.categoryVersionId}>
                    <td>{matrix.week}</td>
                    <td data-testid="unit">{row.unit.name}</td>
                    <td data-testid="group">{row.categoryLabel}</td>
                    <td data-testid="opened">{row.opened}</td>
                    <td data-testid="opening">{row.opening}</td>
                    <td data-testid="resolved">{row.resolved}</td>
                    <td data-testid="closing">
                      <Link to={drillLink({ unitId: row.unit.id, week: matrix.week, categoryVersionId: row.categoryVersionId, open: true })}>{row.closing}</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr data-testid="totals">
                  <th scope="row" colSpan={3}>
                    {t('iss.weekly.column.total')}
                  </th>
                  <td data-testid="total-opened">{matrix.totals.opened}</td>
                  <td data-testid="total-opening">{matrix.totals.opening}</td>
                  <td data-testid="total-resolved">{matrix.totals.resolved}</td>
                  <td data-testid="total-closing">{matrix.totals.closing}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="card">
            <h2>{t('iss.weekly.status.title')}</h2>
            <table className="table" data-testid="statuses">
              <thead>
                <tr>
                  <th scope="col">{t('iss.weekly.column.unit')}</th>
                  {ISSUE_STATUSES.map((status) => (
                    <th key={status} scope="col">
                      {statusLabel(t, status)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.units.map((unit) => (
                  <tr key={unit.unit.id} data-unit={unit.unit.id}>
                    <td>{unit.unit.name}</td>
                    {ISSUE_STATUSES.map((status) => (
                      <td key={status} data-status={status}>
                        {unit.byStatus[status] === 0 ? 0 : <Link to={drillLink({ unitId: unit.unit.id, week: matrix.week, status })}>{unit.byStatus[status]}</Link>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Frame>
  );
}

/** ISS-06: the progress of the handling by unit for a week: what is new, what is overdue, what was closed and the share of what was open that was closed. */
export function IssueProgressScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  return (
    <Frame route={route} title={t('iss.weekly.progress.title')} subtitle={t('iss.weekly.progress.subtitle')}>
      {(matrix) => (
        <div className="card">
          <table className="table" data-testid="progress">
            <thead>
              <tr>
                <th scope="col">{t('iss.weekly.column.unit')}</th>
                <th scope="col">{t('iss.weekly.column.new')}</th>
                <th scope="col">{t('iss.weekly.column.overdue')}</th>
                <th scope="col">{t('iss.weekly.column.closed')}</th>
                <th scope="col">{t('iss.weekly.column.progress')}</th>
              </tr>
            </thead>
            <tbody>
              {matrix.units.map((unit) => {
                const percent = progressPercent(unit);
                return (
                  <tr key={unit.unit.id} data-unit={unit.unit.id}>
                    <td data-testid="unit">
                      <Link to={drillLink({ unitId: unit.unit.id, week: matrix.week })}>{unit.unit.name}</Link>
                    </td>
                    <td data-testid="new">{unit.opened}</td>
                    <td data-testid="overdue">{unit.overdue}</td>
                    <td data-testid="closed">{unit.resolved}</td>
                    <td data-testid="percent">{percent === undefined ? t('iss.weekly.progress.none') : t('iss.weekly.progress.percent', { percent })}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Frame>
  );
}
