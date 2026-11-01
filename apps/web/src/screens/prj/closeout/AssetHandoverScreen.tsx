import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useTrace } from '../../ast/handover/hooks';
import { kindLabel, statusLabel } from '../../ast/handover/labels';
import { READ_PERMISSION as HANDOVER_READ_PERMISSION } from '../../ast/handover/model';
import type { HandoverLine } from '../../ast/handover/model';
import { useProjects } from '../hooks';
import { READ_PERMISSION as PROJECT_READ_PERMISSION } from '../model';
import '../prj.css';
import { NONE, ProjectChooser, useMoney, useProjectParam } from '../revision/shared';
import { useProjectHandovers } from './hooks';
import { assetStateLabel } from './labels';
import { handoverCounts, handoverTone, mayRead } from './model';

const handoverLink = (id: string): string => `/ast/ast-02?id=${id}`;

/**
 * PRJ-11: the handover of the assets of a project (ST-PRJ-011): each handover with the unit that receives it, the day it was planned and the day it was handed over, and, on request, the assets it carries with their value and
 * state. The screen only reads what AST answers; accepting or returning a handover stays in AST-02, which the line links to. Whoever may not read handovers sees the standard denied card, never an empty list.
 */
export default function AssetHandoverScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const { projectId } = useProjectParam();
  // The handovers are read for one person in one tenant and one project: a move to another starts the screen over, with no handover left open.
  return <HandoverContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${projectId ?? ''}`} route={route} />;
}

function HandoverContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const { projectId, choose } = useProjectParam();
  const [params, setParams] = useSearchParams();
  const readable = mayRead(permissions, HANDOVER_READ_PERMISSION) && mayRead(permissions, PROJECT_READ_PERMISSION);
  const asked = readable && projectId !== undefined;
  const handovers = useProjectHandovers(projectId, readable);
  const projects = useProjects();
  const state = useScreenState({ isLoading: asked && handovers.isLoading, error: asked ? handovers.error : undefined, data: asked ? handovers.data : undefined });
  const lines = handovers.data ?? [];
  const counts = handoverCounts(lines);
  const opened = lines.find((line) => line.id === params.get('handover'));
  const project = (projects.data ?? []).find((candidate) => candidate.id === projectId);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.handover.page.title')}</h1>
          <p>{t('prj.handover.page.subtitle')}</p>
        </div>
      </div>
      {readable ? <ProjectChooser id="handover-project" projectId={projectId} choose={choose} /> : null}
      {readable && projectId === undefined ? (
        <p className="callout" role="status" data-testid="no-project">
          {t('prj.revision.noProject.notice')}
        </p>
      ) : (
        <StateBoundary state={readable ? state : 'denied'} onRetry={() => void handovers.refetch()}>
          <p data-testid="counts">{t('prj.handover.summary.counts', { accepted: counts.accepted, open: counts.open, project: project?.code ?? '' })}</p>
          <div className="tablewrap">
            <table className="table" aria-label={t('prj.handover.table.aria')} data-testid="handovers">
              <thead>
                <tr>
                  <th scope="col">{t('prj.handover.column.no')}</th>
                  <th scope="col">{t('prj.handover.column.kind')}</th>
                  <th scope="col">{t('prj.handover.column.recipient')}</th>
                  <th scope="col">{t('prj.handover.column.planned')}</th>
                  <th scope="col">{t('prj.handover.column.handed')}</th>
                  <th scope="col">{t('prj.handover.column.status')}</th>
                  <th scope="col">{t('prj.handover.column.critical')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('prj.handover.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} data-handover={line.id} data-status={line.status} aria-selected={line.id === opened?.id}>
                    <th scope="row">
                      <code>{line.handoverNo}</code>
                      <small className="sub"> {line.contract.code}</small>
                    </th>
                    <td>{kindLabel(t, line.kind)}</td>
                    <td>{line.recipientUnit.name}</td>
                    <td>{line.plannedOn ?? NONE}</td>
                    <td>{line.handedOn ?? NONE}</td>
                    <td>
                      <span className={`pill ${handoverTone(line.status)}`}>{statusLabel(t, line.status)}</span>
                    </td>
                    <td>{line.openCriticalCount}</td>
                    <td>
                      <button type="button" onClick={() => setParams({ id: projectId ?? '', handover: line.id })}>
                        {t('prj.handover.assets.action', { no: line.handoverNo })}
                      </button>{' '}
                      <Link className="button" to={handoverLink(line.id)}>
                        {t('prj.handover.open.action', { no: line.handoverNo })}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {opened === undefined ? null : <AssetsPanel line={opened} onClose={() => setParams({ id: projectId ?? '' })} />}
        </StateBoundary>
      )}
    </section>
  );
}

function AssetsPanel({ line, onClose }: { line: HandoverLine; onClose(): void }) {
  const { t } = useTranslation();
  const money = useMoney();
  const trace = useTrace(line.id);
  const state = useScreenState({ isLoading: trace.isLoading, error: trace.error, data: trace.data, isEmpty: () => false });
  const found = trace.data ?? undefined;
  return (
    <div className="card" role="region" aria-label={t('prj.handover.detail.title', { no: line.handoverNo })} data-testid="assets-panel">
      <h2>{t('prj.handover.detail.title', { no: line.handoverNo })}</h2>
      <StateBoundary state={state} onRetry={() => void trace.refetch()}>
        {found === undefined ? (
          <p role="status" data-testid="trace-missing">
            {t('prj.handover.detail.missing.notice')}
          </p>
        ) : (
          <>
            <p data-testid="trace-facts">{t('prj.handover.detail.facts', { documents: found.documents.length, items: found.items.length, critical: line.openCriticalCount })}</p>
            {found.assets.length === 0 ? (
              <p role="status" data-testid="assets-none">
                {t('prj.handover.assets.none.notice')}
              </p>
            ) : (
              <div className="tablewrap">
                <table className="table" aria-label={t('prj.handover.assets.aria')} data-testid="assets">
                  <thead>
                    <tr>
                      <th scope="col">{t('prj.handover.asset.code')}</th>
                      <th scope="col">{t('prj.handover.asset.name')}</th>
                      <th scope="col">{t('prj.handover.asset.value')}</th>
                      <th scope="col">{t('prj.handover.asset.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {found.assets.map((asset) => (
                      <tr key={asset.id} data-asset={asset.id}>
                        <th scope="row">
                          <code>{asset.assetCode}</code>
                        </th>
                        <td>{asset.name ?? NONE}</td>
                        <td>{money(asset.valueVnd)}</td>
                        <td>{assetStateLabel(t, asset.status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </StateBoundary>
      <button type="button" onClick={onClose}>
        {t('prj.handover.detail.close.action')}
      </button>
    </div>
  );
}
