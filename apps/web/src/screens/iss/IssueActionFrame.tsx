import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useIssue } from './hooks';
import { BackLink, DueBadge, PersonText, SeverityBadge, StatusBadge, useMoment } from './issue-components';
import { LIST_PATH, WORKSPACE_PATH } from './issue-model';
import type { IssueView } from './issue-model';
import './iss.css';

const NEVER_EMPTY = (): boolean => false;

export interface FrameContext {
  issue: IssueView;
  reload: () => void;
}

interface FrameProps extends ScreenProps {
  title: string;
  children: (context: FrameContext) => ReactNode;
}

/** The address of the workspace of an issue, which the screens of an action lead back to. */
const workspaceOf = (issueId: string): string => `${WORKSPACE_PATH}?id=${issueId}`;

/**
 * The frame of a screen that acts on one issue named in its address (ISS-04, ISS-07, ISS-10 detail): the link back to the workspace, the heading
 * with the state of the issue, the reading of the issue with its loading, failure and "not in your scope" states, and the content the screen puts
 * in it. The server decides again on every command, in the scope of the issue.
 */
export function IssueActionFrame({ route, title, children }: FrameProps) {
  const { tenant } = useSession();
  return (
    <IssueActionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} title={title}>
      {children}
    </IssueActionContent>
  );
}

function IssueActionContent({ route, title, children }: FrameProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const issueId = params.get('id') ?? undefined;
  const issue = useIssue(issueId);
  const state = useScreenState({ isLoading: issue.isLoading, error: issue.error, data: issueId === undefined ? undefined : (issue.data ?? undefined), isEmpty: NEVER_EMPTY });
  const missing = issueId === undefined || (issue.isSuccess && issue.data === null);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={issueId === undefined ? LIST_PATH : workspaceOf(issueId)}>{issueId === undefined ? t('iss.back.list.link') : t('iss.action.back.workspace.link')}</BackLink>
      {missing ? (
        <>
          <div className="heading">
            <h1 id="screen-title">{title}</h1>
          </div>
          <p className="callout warning" role="status" data-testid="no-issue">
            {t('iss.workspace.noIssue.notice')}
          </p>
        </>
      ) : (
        <StateBoundary state={state} onRetry={() => void issue.refetch()}>
          {issue.data === undefined || issue.data === null ? null : (
            <>
              <IssueHeading issue={issue.data} title={title} />
              {children({ issue: issue.data, reload: () => void issue.refetch() })}
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('iss.workspace.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function IssueHeading({ issue, title }: { issue: IssueView; title: string }) {
  const { t } = useTranslation();
  const moment = useMoment();
  return (
    <>
      <div className="heading">
        <div>
          <h1 id="screen-title">{title}</h1>
          <p>
            {issue.code} · {issue.title}
          </p>
          <p>
            <StatusBadge status={issue.status} /> <SeverityBadge severity={issue.severity} /> <DueBadge line={issue} now={new Date()} />
          </p>
        </div>
      </div>
      <article className="card" aria-label={t('iss.action.summary.title')}>
        <h2>{t('iss.action.summary.title')}</h2>
        <dl className="iss-facts" data-testid="action-summary">
          <dt>{t('iss.workspace.field.assignee')}</dt>
          <dd>
            <PersonText person={issue.assignee} />
          </dd>
          <dt>{t('iss.workspace.field.due')}</dt>
          <dd>{moment(issue.dueAt)}</dd>
          <dt>{t('iss.workspace.field.overdue')}</dt>
          <dd>{issue.overdueSince === null ? t('iss.value.none.text') : moment(issue.overdueSince)}</dd>
        </dl>
      </article>
    </>
  );
}
