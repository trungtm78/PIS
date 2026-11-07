import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { AuditLine, SectionCard, StatusPill } from '../../ui';
import { AssignForm, CommentForm, StartForm, TransferForm } from './IssueActions';
import { closureRightsOf, extensionLink, verificationLink } from './closure-model';
import { useIssue, useUnits } from './hooks';
import { BackLink, DeadlineLine, DueBadge, PersonText, SeverityBadge, StatusBadge, Timeline, useMoment } from './issue-components';
import { sourceLabel } from './issue-labels';
import { ESCALATION_BOARD_PATH, ISSUE_ASSIGN_PERMISSION, ISSUE_WORK_PERMISSION, LIST_PATH, actionsOf, hasPermission, stripeOf } from './issue-model';
import type { IssueView } from './issue-model';
import './iss.css';

const NEVER_EMPTY = (): boolean => false;

/**
 * ISS-03: the workspace of one issue: what it is, the SLA it was opened under, where it stands against its deadline, the timeline of everything
 * that was done to it and the commands that move it on. The buttons follow the state of the issue and the permissions of the person; the
 * server decides again on every command, in the scope of the issue.
 */
export default function IssueWorkspaceScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <IssueWorkspaceContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function IssueWorkspaceContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const issueId = params.get('id') ?? undefined;
  const issue = useIssue(issueId);
  const state = useScreenState({ isLoading: issue.isLoading, error: issue.error, data: issueId === undefined ? undefined : (issue.data ?? undefined), isEmpty: NEVER_EMPTY });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={LIST_PATH}>{t('iss.back.list.link')}</BackLink>
      {issueId === undefined || (issue.isSuccess && issue.data === null) ? (
        <>
          <div className="heading">
            <h1 id="screen-title">{t('iss.workspace.page.title')}</h1>
          </div>
          <p className="callout warning" role="status" data-testid="no-issue">
            {t('iss.workspace.noIssue.notice')}
          </p>
        </>
      ) : (
        <StateBoundary state={state} onRetry={() => void issue.refetch()}>
          {issue.data === undefined || issue.data === null ? null : <Workspace issue={issue.data} onReload={() => void issue.refetch()} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('iss.workspace.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Workspace({ issue, onReload }: { issue: IssueView; onReload: () => void }) {
  const { t } = useTranslation();
  const moment = useMoment();
  const { permissions, mode, tenant } = useSession();
  const units = useUnits();
  const live = mode !== 'READ_ONLY';
  const rights = { assign: hasPermission(permissions, ISSUE_ASSIGN_PERMISSION) && live, work: hasPermission(permissions, ISSUE_WORK_PERMISSION) && live };
  const actions = actionsOf(issue, rights, tenant?.membershipId);
  const unitName = useMemo(() => {
    const names = new Map((units.data ?? []).map((unit) => [unit.id, `${unit.code} · ${unit.name}`]));
    return (unitId: string | null): string => (unitId === null ? t('iss.value.none.text') : (names.get(unitId) ?? unitId));
  }, [units.data, t]);
  const none = t('iss.value.none.text');
  const closure = closureRightsOf(permissions, live);
  const verificationOffered = (closure.work && issue.status === 'IN_PROGRESS') || (closure.close && issue.status === 'PENDING_VERIFICATION') || (closure.reopen && issue.status === 'CLOSED');
  const extensionOffered =
    (closure.extend && issue.status !== 'CLOSED' && issue.status !== 'PENDING_VERIFICATION') || (closure.escalate && (issue.status === 'ASSIGNED' || issue.status === 'IN_PROGRESS'));
  const boardOffered = issue.escalations.length > 0;
  const nothingToDo = !actions.assign && !actions.start && !actions.comment && !actions.transfer && !verificationOffered && !extensionOffered && !boardOffered;
  const now = new Date();
  const stripe = stripeOf(issue, now);

  return (
    <>
      <div className="heading iss-record-head" {...(stripe === null ? {} : { 'data-stripe': stripe })}>
        <div>
          <h1 id="screen-title">
            {issue.code} · {issue.title}
          </h1>
          {stripe === null ? null : <span className="ui-sr-only">{t('ui.dataTable.severityPrefix', { label: stripe === 'URGENT' ? t('ui.dataTable.severity.urgent') : t('ui.dataTable.severity.action') })}</span>}
          <p className="iss-chips">
            <StatusBadge status={issue.status} />
            <SeverityBadge severity={issue.severity} />
            <DueBadge line={issue} now={now} />
            <DeadlineLine line={issue} now={now} />
          </p>
        </div>
      </div>
      <div className="iss-grid">
        <div className="iss-stack">
          <SectionCard title={t('iss.workspace.summary.title')}>
            <dl className="iss-facts" data-testid="summary">
              <Fact label={t('iss.workspace.field.project')}>
                {issue.projectCode} · {issue.projectName}
              </Fact>
              <Fact label={t('iss.workspace.field.category')}>{issue.categoryLabel}</Fact>
              <Fact label={t('iss.workspace.field.unit')}>{issue.ownerUnitName}</Fact>
              <Fact label={t('iss.workspace.field.assignee')}>
                <PersonText person={issue.assignee} />
              </Fact>
              <Fact label={t('iss.workspace.field.reporter')}>
                <PersonText person={issue.reporter} />
              </Fact>
              <Fact label={t('iss.workspace.field.source')}>{sourceLabel(t, issue.sourceModule)}</Fact>
              <Fact label={t('iss.workspace.field.escalation')}>{issue.escalationLevel > 0 ? t('iss.escalation.level.text', { level: issue.escalationLevel }) : t('iss.escalation.none.text')}</Fact>
              <Fact label={t('iss.workspace.field.opened')}>{moment(issue.openedAt)}</Fact>
              <Fact label={t('iss.workspace.field.description')}>
                {issue.description === null ? (
                  <span className="muted" data-testid="description-hidden">
                    {t('iss.workspace.description.hidden')}
                  </span>
                ) : (
                  <span className="iss-note">{issue.description}</span>
                )}
              </Fact>
            </dl>
          </SectionCard>
          <SectionCard title={t('iss.workspace.sla.title')}>
            <dl className="iss-facts" data-testid="sla">
              <Fact label={t('iss.workspace.field.responseDue')}>
                {moment(issue.responseDueAt)}
                {issue.respondedAt === null ? '' : ` · ${t('iss.workspace.sla.responded.text', { date: moment(issue.respondedAt) })}`}
              </Fact>
              <Fact label={t('iss.workspace.field.due')}>{moment(issue.dueAt)}</Fact>
              <Fact label={t('iss.workspace.field.overdue')}>
                {issue.overdueSince === null
                  ? none
                  : `${moment(issue.overdueSince)} · ${issue.overdueDays === null ? t('iss.due.overdueUnknown.text') : t('iss.due.overdueDays.text', { count: issue.overdueDays })}`}
              </Fact>
              {issue.closedAt === null ? null : <Fact label={t('iss.workspace.field.closed')}>{moment(issue.closedAt)}</Fact>}
            </dl>
            {issue.sla === null ? null : (
              <>
                <p className="sub">{t('iss.workspace.sla.policy.text', { code: issue.sla.policyCode, revision: issue.sla.policyRevision })}</p>
                <p className="sub">{t('iss.workspace.sla.hours.text', { response: issue.sla.responseHours, resolve: issue.sla.resolveHours, calendar: issue.sla.calendarCode })}</p>
                <p className="sub">
                  {issue.sla.requireEvidence ? t('iss.workspace.sla.evidence.text') : t('iss.workspace.sla.noEvidence.text')} ·{' '}
                  {issue.sla.requireIndependentVerifier ? t('iss.workspace.sla.independent.text') : t('iss.workspace.sla.noIndependent.text')}
                </p>
              </>
            )}
          </SectionCard>
          <SectionCard title={t('iss.workspace.geo.title')}>
            {issue.geo === null ? (
              <p className="muted" data-testid="geo-none">
                {issue.geoConsent ? t('iss.workspace.geo.consentOnly.text') : t('iss.workspace.geo.none.text')}
              </p>
            ) : (
              <p data-testid="geo">
                {t('iss.workspace.geo.value.text', { lat: issue.geo.lat, lng: issue.geo.lng })}
                {issue.geo.accuracyM === null ? '' : ` · ${t('iss.workspace.geo.accuracy.text', { accuracy: issue.geo.accuracyM })}`}{' '}
                {issue.geo.lowAccuracy ? (
                  <span data-testid="geo-low-accuracy">
                    <StatusPill tone="warning">{t('iss.workspace.geo.low.badge')}</StatusPill>
                  </span>
                ) : null}
              </p>
            )}
          </SectionCard>
          <SectionCard title={t('iss.workspace.timeline.title')}>
            <Timeline events={issue.events} unitName={unitName} />
          </SectionCard>
          <AuditLine
            items={[
              { label: t('iss.workspace.field.reporter'), value: issue.reporter === null ? none : issue.reporter.name === '' ? issue.reporter.id : issue.reporter.name },
              { label: t('iss.workspace.field.opened'), value: moment(issue.openedAt) },
              { label: t('w2iss.audit.version'), value: String(issue.version) },
            ]}
          />
        </div>
        <div className="iss-stack">
          {nothingToDo ? (
            <p className="callout" role="status" data-testid="read-only">
              {issue.status === 'CLOSED' ? t('iss.workspace.actions.closed.notice') : live ? t('iss.workspace.actions.denied.notice') : t('iss.workspace.actions.frozen.notice')}
            </p>
          ) : null}
          {actions.start ? <StartForm issue={issue} onReload={onReload} /> : null}
          {actions.assign ? <AssignForm issue={issue} onReload={onReload} /> : null}
          {actions.comment ? <CommentForm issue={issue} onReload={onReload} /> : null}
          {actions.transfer ? <TransferForm issue={issue} onReload={onReload} /> : null}
          {verificationOffered || extensionOffered || boardOffered ? (
            <nav className="card" aria-label={t('iss.workspace.more.title')} data-testid="more-actions">
              <h2>{t('iss.workspace.more.title')}</h2>
              <ul>
                {verificationOffered ? (
                  <li>
                    <Link to={verificationLink(issue.id)}>{t('iss.workspace.more.verification.link')}</Link>
                  </li>
                ) : null}
                {extensionOffered ? (
                  <li>
                    <Link to={extensionLink(issue.id)}>{t('iss.workspace.more.extension.link')}</Link>
                  </li>
                ) : null}
                {boardOffered ? (
                  <li>
                    <Link to={ESCALATION_BOARD_PATH}>{t('iss.workspace.more.board.link')}</Link>
                  </li>
                ) : null}
              </ul>
            </nav>
          ) : null}
        </div>
      </div>
    </>
  );
}
