import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { useMoment } from './hooks';
import { classificationLabel, routeLabel, runStatusLabel, runTone } from './labels';
import { formatVnd, hasFindings, progressPath, workbenchPath } from './model';
import type { Run } from './model';
import '../bid.css';

/** The runs of a proposal, newest first: how each ended, the class and the route of its data, what it found and what it cost, and the way to its progress and its evidence. */
export function RunList({ runs }: { runs: readonly Run[] }) {
  const { t, locale } = useTranslation();
  const moment = useMoment();
  return (
    <div className="tablewrap">
      <table className="table" aria-label={t('bid.analysis.runs.aria')} data-testid="runs">
        <thead>
          <tr>
            <th scope="col">{t('bid.analysis.runs.col.started')}</th>
            <th scope="col">{t('bid.analysis.runs.col.status')}</th>
            <th scope="col">{t('bid.analysis.runs.col.data')}</th>
            <th scope="col" className="num">
              {t('bid.analysis.runs.col.findings')}
            </th>
            <th scope="col" className="num">
              {t('bid.analysis.runs.col.cost')}
            </th>
            <th scope="col">{t('bid.analysis.runs.col.open')}</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} data-run={run.id} data-status={run.status}>
              <td>{moment(run.startedAt)}</td>
              <td>
                <span className={`bid-badge ${runTone(run.status)}`} data-testid="run-status">
                  {runStatusLabel(t, run.status)}
                </span>
              </td>
              <td>{t('bid.analysis.runs.data', { classification: classificationLabel(t, run.dataClassification), route: routeLabel(t, run.routeClass) })}</td>
              <td className="num">{t('bid.analysis.runs.findings', { count: run.findingCount, missing: run.missingSourceCount })}</td>
              <td className="num">{run.costVnd === null ? '' : formatVnd(run.costVnd, locale)}</td>
              <td>
                <Link to={progressPath(run.id)}>{t('bid.analysis.runs.progress')}</Link>
                {hasFindings(run) ? (
                  <>
                    {' · '}
                    <Link to={workbenchPath(run.id)}>{t('bid.analysis.runs.evidence')}</Link>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
