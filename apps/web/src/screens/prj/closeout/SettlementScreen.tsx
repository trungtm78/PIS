import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { READ_PERMISSION as SETTLEMENT_READ_PERMISSION, settlementLink } from '../../pay/settlement/model';
import type { Settlement } from '../../pay/settlement/model';
import { scopeLabel, statusLabel } from '../../pay/settlement/labels';
import { useProjects } from '../hooks';
import { stageLabel } from '../labels';
import { READ_PERMISSION as PROJECT_READ_PERMISSION } from '../model';
import '../prj.css';
import { NONE, ProjectChooser, useMoney, useProjectParam } from '../revision/shared';
import { useProjectSettlements } from './hooks';
import { closureMessage } from './labels';
import { closingSettlement, closureOf, mayRead } from './model';

const DAY = 10;

/**
 * PRJ-12: where the settlement of a project stands (ST-PRJ-011, PRJ 3.1): the stage of the project, whether the settlement of the project has closed, the figures of the one that stands now and every revision there was. The
 * project moves to SETTLED only when its payment settlement closes, so the screen says in words which of the two is waited for. It only reads what PAY answers; the steps of the settlement stay in PAY-15, which each line links
 * to. The conclusions of the audit are shown only when the read gave them, that is to whoever may read them.
 */
export default function SettlementScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const { projectId } = useProjectParam();
  // The settlement is read for one person in one tenant and one project: a move to another starts the screen over.
  return <SettlementContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${projectId ?? ''}`} route={route} />;
}

function SettlementContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const money = useMoney();
  const { permissions } = useSession();
  const { projectId, choose } = useProjectParam();
  const readable = mayRead(permissions, SETTLEMENT_READ_PERMISSION) && mayRead(permissions, PROJECT_READ_PERMISSION);
  const asked = readable && projectId !== undefined;
  const projects = useProjects();
  const settlements = useProjectSettlements(projectId, readable);
  const project = (projects.data ?? []).find((candidate) => candidate.id === projectId);
  const state = useScreenState({
    isLoading: asked && (projects.isLoading || settlements.isLoading),
    error: asked ? (projects.error ?? settlements.error) : undefined,
    data: asked && projects.data !== undefined ? settlements.data : undefined,
    isEmpty: () => false,
  });
  const list = settlements.data ?? [];
  const closing = closingSettlement(list);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.settlement.page.title')}</h1>
          <p>{t('prj.settlement.page.subtitle')}</p>
        </div>
      </div>
      {readable ? <ProjectChooser id="settlement-project" projectId={projectId} choose={choose} /> : null}
      {readable && projectId === undefined ? (
        <p className="callout" role="status" data-testid="no-project">
          {t('prj.revision.noProject.notice')}
        </p>
      ) : (
        <StateBoundary state={readable ? state : 'denied'} onRetry={() => void Promise.all([projects.refetch(), settlements.refetch()])}>
          {project === undefined ? null : (
            <div className="card" data-testid="closure" data-closure={closureOf(project.status, closing)}>
              <p>{t('prj.settlement.stage.text', { stage: stageLabel(t, project.status) })}</p>
              <p role="status">{closureMessage(t, closureOf(project.status, closing))}</p>
            </div>
          )}
          {closing === undefined ? (
            <p role="status" data-testid="no-settlement">
              {t('prj.settlement.none.notice')}
            </p>
          ) : (
            <div className="card" data-testid="standing">
              <h2>{t('prj.settlement.standing.title', { revision: closing.revision })}</h2>
              <dl className="prj-facts">
                <dt>{t('prj.settlement.field.status')}</dt>
                <dd>{statusLabel(t, closing.status)}</dd>
                <dt>{t('prj.settlement.field.settled')}</dt>
                <dd>{money(closing.settledVnd)}</dd>
                <dt>{t('prj.settlement.field.outstanding')}</dt>
                <dd>{money(closing.outstandingVnd)}</dd>
                <dt>{t('prj.settlement.field.advance')}</dt>
                <dd>{money(closing.unrecoveredAdvanceVnd)}</dd>
                <dt>{t('prj.settlement.field.due')}</dt>
                <dd>{closing.verificationDueOn ?? NONE}</dd>
                <dt>{t('prj.settlement.field.closed')}</dt>
                <dd>{closing.closedAt === null ? NONE : closing.closedAt.slice(0, DAY)}</dd>
                <dt>{t('prj.settlement.field.exception')}</dt>
                <dd>{closing.exceptionApprovedAt === null ? t('prj.settlement.exception.none') : t('prj.settlement.exception.approved', { day: closing.exceptionApprovedAt.slice(0, DAY) })}</dd>
                {closing.auditFindingRefs === null ? null : (
                  <>
                    <dt>{t('prj.settlement.field.findings')}</dt>
                    <dd data-testid="findings">{t('prj.settlement.findings.count', { count: closing.auditFindingRefs.length })}</dd>
                  </>
                )}
              </dl>
            </div>
          )}
          {list.length === 0 ? null : <RevisionTable list={list} />}
        </StateBoundary>
      )}
    </section>
  );
}

function RevisionTable({ list }: { list: readonly Settlement[] }) {
  const { t } = useTranslation();
  const money = useMoney();
  return (
    <div className="tablewrap">
      <table className="table" aria-label={t('prj.settlement.table.aria')} data-testid="settlements">
        <thead>
          <tr>
            <th scope="col">{t('prj.settlement.column.scope')}</th>
            <th scope="col">{t('prj.settlement.column.revision')}</th>
            <th scope="col">{t('prj.settlement.column.status')}</th>
            <th scope="col">{t('prj.settlement.column.settled')}</th>
            <th scope="col">{t('prj.settlement.column.outstanding')}</th>
            <th scope="col">{t('prj.settlement.column.advance')}</th>
            <th scope="col">{t('prj.settlement.column.due')}</th>
            <th scope="col">
              <span className="sr-only">{t('prj.settlement.column.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((settlement) => (
            <tr key={settlement.id} data-settlement={settlement.id} data-status={settlement.status}>
              <th scope="row">
                {scopeLabel(t, settlement.scope)}
                {settlement.contractCode === null && settlement.fiscalYear === null ? null : (
                  <small className="sub"> {settlement.contractCode ?? t('prj.settlement.year.text', { year: settlement.fiscalYear ?? '' })}</small>
                )}
              </th>
              <td>{settlement.revision}</td>
              <td>{statusLabel(t, settlement.status)}</td>
              <td>{money(settlement.settledVnd)}</td>
              <td>{money(settlement.outstandingVnd)}</td>
              <td>{money(settlement.unrecoveredAdvanceVnd)}</td>
              <td>{settlement.verificationDueOn ?? NONE}</td>
              <td>
                <Link className="button" to={settlementLink(settlement.id)}>
                  {t('prj.settlement.open.action', { revision: settlement.revision })}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
