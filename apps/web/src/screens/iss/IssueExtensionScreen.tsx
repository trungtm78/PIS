import { useState } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { ExtendForm } from './ClosureForms';
import { EscalateForm, EscalationList } from './EscalationForms';
import { IssueActionFrame } from './IssueActionFrame';
import type { FrameContext } from './IssueActionFrame';
import { closureActionsOf, closureRightsOf } from './closure-model';
import { PersonText, useMoment } from './issue-components';

/**
 * ISS-04: the extension of the deadline of an issue. A person other than the handler grants it, at most the number of times the tenant allows,
 * by no more than the resolution time of the SLA on the working calendar, and the days overdue are kept (BR-ISS-04). The history of the extensions
 * is the timeline of the issue, read here.
 */
export default function IssueExtensionScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  return (
    <IssueActionFrame route={route} title={t('iss.extension.page.title')}>
      {(context) => <ExtensionContent {...context} />}
    </IssueActionFrame>
  );
}

function ExtensionContent({ issue, reload }: FrameContext) {
  const { t } = useTranslation();
  const moment = useMoment();
  const { permissions, mode, tenant } = useSession();
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const live = mode !== 'READ_ONLY';
  const actions = closureActionsOf(issue, closureRightsOf(permissions, live), tenant?.membershipId);
  const handler = tenant?.membershipId !== undefined && issue.assignee?.id === tenant.membershipId;
  const extensions = issue.events.filter((event) => event.kind === 'EXTENDED');
  const finished = issue.status === 'CLOSED' || issue.status === 'PENDING_VERIFICATION';

  return (
    <>
      {notice === undefined ? null : (
        <p className="callout" role="status" data-testid="done">
          {notice}
        </p>
      )}
      <article className="card" aria-label={t('iss.extension.escalations.title')}>
        <h2>{t('iss.extension.escalations.title')}</h2>
        <EscalationList issue={issue} />
      </article>
      {actions.escalate ? <EscalateForm issue={issue} onReload={reload} onDone={setNotice} /> : null}
      <article className="card" aria-label={t('iss.extension.history.title')}>
        <h2>{t('iss.extension.history.title')}</h2>
        {extensions.length === 0 ? (
          <p className="muted" data-testid="no-extensions">
            {t('iss.extension.history.none.text')}
          </p>
        ) : (
          <ol data-testid="extensions">
            {extensions.map((event) => (
              <li key={event.id}>
                <p>
                  {t('iss.extension.history.item.text', { from: moment(event.previousDueAt), to: moment(event.newDueAt) })} · <PersonText person={event.actor} />
                </p>
                {event.note === null ? null : <p className="iss-note">{event.note}</p>}
              </li>
            ))}
          </ol>
        )}
      </article>
      {actions.extend ? (
        <ExtendForm issue={issue} onReload={reload} onDone={setNotice} />
      ) : actions.escalate ? null : (
        <p className="callout" role="status" data-testid="extension-unavailable">
          {!live
            ? t('iss.workspace.actions.frozen.notice')
            : handler
              ? t('iss.extension.extend.handler.notice')
              : finished
                ? t('iss.extension.extend.state.notice')
                : t('iss.workspace.actions.denied.notice')}
        </p>
      )}
    </>
  );
}
