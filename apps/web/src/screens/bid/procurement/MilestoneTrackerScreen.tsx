import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useMilestones, useTrackedPackages } from './hooks';
import { milestoneLabel, sourceLabel } from './labels';
import { MilestoneDialog } from './MilestoneDialog';
import { canManage, milestonesOf, projectsOf, trackedPackages, vietnamDay } from './model';
import type { MilestoneLine, TrackedPackage } from './model';
import '../bid.css';

/** The path of the reconciliation view that BID-17 points to. */
export const LINKS_PATH = '/bid/bid-19';

type Dialog = { pack: TrackedPackage; line: MilestoneLine | undefined };

/**
 * BID-17: the milestones of the choice of a contractor, package by package (ST-BID-005): the invitation, the clarification deadline, the closing and opening of the bid, the
 * evaluation, the approval and the publication of the result, and the contract, each with its planned and its actual date and who wrote it last (a planner by hand, or the
 * file of the national bidding system). A planner records a milestone under the version of the package they saw; the server keeps the milestones in order.
 */
export default function MilestoneTrackerScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The packages and the dialog belong to one membership: a switch of tenant or of membership starts the screen over.
  return <TrackerContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function TrackerContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const packages = useTrackedPackages();
  const milestones = useMilestones();
  const [projectId, setProjectId] = useState('');
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const mayRecord = canManage(permissions, mode);
  const state = useScreenState({
    isLoading: packages.isLoading || milestones.isLoading,
    error: packages.error ?? milestones.error,
    data: packages.data !== undefined && milestones.data !== undefined ? { packages: packages.data, milestones: milestones.data } : undefined,
    isEmpty: (data) => trackedPackages((data as { packages: TrackedPackage[] }).packages, '').length === 0,
  });
  const projects = useMemo(() => projectsOf(packages.data ?? []), [packages.data]);
  const shown = useMemo(() => trackedPackages(packages.data ?? [], projectId), [packages.data, projectId]);
  const refetch = (): void => {
    void packages.refetch();
    void milestones.refetch();
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.milestones.page.title')}</h1>
          <p>{t('bid.milestones.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={refetch}>
        <div className="card">
          <div className="field">
            <label htmlFor="milestones-project">{t('bid.milestones.project.label')}</label>
            <select id="milestones-project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">{t('bid.milestones.project.all')}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {`${project.code} · ${project.name}`}
                </option>
              ))}
            </select>
          </div>
          <p className="sub">
            <Link to={LINKS_PATH}>{t('bid.milestones.links.link')}</Link>
          </p>
          <table className="table" data-testid="packages">
            <thead>
              <tr>
                <th scope="col">{t('bid.milestones.column.package')}</th>
                <th scope="col">{t('bid.milestones.column.project')}</th>
                <th scope="col">{t('bid.milestones.column.milestones')}</th>
                <th scope="col">{t('bid.milestones.column.action')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((pack) => {
                const held = milestonesOf(pack.id, milestones.data ?? []);
                return (
                  <tr key={pack.id} data-package-id={pack.id}>
                    <th scope="row">{pack.title === null ? pack.code : `${pack.code} · ${pack.title}`}</th>
                    <td>{pack.project.code}</td>
                    <td>
                      {held.length === 0 ? (
                        <span className="sub" data-testid="no-milestones">
                          {t('bid.milestones.none.text')}
                        </span>
                      ) : (
                        <ol className="bid-milestones">
                          {held.map((line) => (
                            <li key={line.id} data-kind={line.kind}>
                              <strong>{milestoneLabel(t, line.kind)}</strong>
                              <span data-testid="planned">{line.plannedAt === null ? '' : ` ${t('bid.milestones.planned.text', { date: vietnamDay(line.plannedAt) })}`}</span>
                              <span data-testid="actual">{line.actualAt === null ? '' : ` ${t('bid.milestones.actual.text', { date: vietnamDay(line.actualAt) })}`}</span>
                              <span className={line.source === 'IMPORT' ? 'bid-badge ok' : 'bid-badge'} data-testid="source">
                                {sourceLabel(t, line.source)}
                              </span>
                              {mayRecord ? (
                                <button type="button" className="button" aria-label={t('bid.milestones.edit.aria', { kind: milestoneLabel(t, line.kind), code: pack.code })} onClick={() => setDialog({ pack, line })}>
                                  {t('bid.milestones.edit.action')}
                                </button>
                              ) : null}
                            </li>
                          ))}
                        </ol>
                      )}
                    </td>
                    <td>
                      {mayRecord ? (
                        <button type="button" className="button primary" aria-label={t('bid.milestones.record.aria', { code: pack.code })} onClick={() => setDialog({ pack, line: undefined })}>
                          {t('bid.milestones.record.action')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {shown.length === 0 ? (
            <p className="callout" role="status" data-testid="no-match">
              {t('bid.milestones.noMatch.notice')}
            </p>
          ) : null}
        </div>
      </StateBoundary>
      {dialog === undefined ? null : <MilestoneDialog pack={dialog.pack} line={dialog.line} held={milestonesOf(dialog.pack.id, milestones.data ?? [])} onClose={() => setDialog(undefined)} />}
      <p className="prototype-note">{t('bid.milestones.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
