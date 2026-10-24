import { useState } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { CloseForm, RefuseForm, ReopenForm, RequestVerificationForm } from './ClosureForms';
import { IssueActionFrame } from './IssueActionFrame';
import type { FrameContext } from './IssueActionFrame';
import { closureActionsOf, closureRightsOf, lastVerificationRequest } from './closure-model';
import { useMoment } from './issue-components';
import { ISSUE_ASSIGN_PERMISSION, hasPermission } from './issue-model';

/**
 * ISS-07: the verification and the closing of an issue. The handler declares the work done with the result and the evidence; a different person
 * reads both and closes the issue, or gives it back with the reason; a closed issue can be reopened while the window lasts. The person who
 * handles the issue is offered the request and never the closing, so the independence of BR-ISS-05 is seen on the screen, and the server and the
 * database hold it again.
 */
export default function IssueVerificationScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  return (
    <IssueActionFrame route={route} title={t('iss.verification.page.title')}>
      {(context) => <VerificationContent {...context} />}
    </IssueActionFrame>
  );
}

function VerificationContent({ issue, reload }: FrameContext) {
  const { t } = useTranslation();
  const moment = useMoment();
  const { permissions, mode, tenant } = useSession();
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const live = mode !== 'READ_ONLY';
  const actions = closureActionsOf(issue, closureRightsOf(permissions, live), tenant?.membershipId);
  const refuse = hasPermission(permissions, ISSUE_ASSIGN_PERMISSION) && live && actions.close;
  const request = lastVerificationRequest(issue.events);
  const handler = tenant?.membershipId !== undefined && issue.assignee?.id === tenant.membershipId;
  const waiting = issue.status === 'PENDING_VERIFICATION';
  const nothing = !actions.request && !actions.close && !actions.reopen;

  return (
    <>
      {notice === undefined ? null : (
        <p className="callout" role="status" data-testid="done">
          {notice}
        </p>
      )}
      {request === undefined ? null : (
        <article className="card" aria-label={t('iss.verification.result.title')}>
          <h2>{t('iss.verification.result.title')}</h2>
          <p className="sub" data-testid="result-by">
            {t('iss.verification.result.by.text', { name: request.actor?.name ?? t('iss.value.none.text'), date: moment(request.createdAt) })}
          </p>
          {request.note === null ? (
            <p className="muted" data-testid="result-hidden">
              {t('iss.workspace.description.hidden')}
            </p>
          ) : (
            <p className="iss-note" data-testid="result-note">
              {request.note}
            </p>
          )}
          <h3>{t('iss.verification.result.evidence.title')}</h3>
          {request.evidenceIds.length === 0 ? (
            <p className="muted" data-testid="result-no-evidence">
              {t('iss.verification.result.noEvidence.text')}
            </p>
          ) : (
            <ul data-testid="result-evidence">
              {request.evidenceIds.map((documentId) => (
                <li key={documentId}>
                  <code>{documentId}</code>
                </li>
              ))}
            </ul>
          )}
        </article>
      )}
      {waiting && handler ? (
        <p className="callout" role="status" data-testid="independence">
          {t('iss.verification.independence.notice')}
        </p>
      ) : null}
      {actions.request ? <RequestVerificationForm issue={issue} onReload={reload} onDone={setNotice} /> : null}
      {actions.close ? <CloseForm issue={issue} onReload={reload} onDone={setNotice} /> : null}
      {refuse ? <RefuseForm issue={issue} onReload={reload} onDone={setNotice} /> : null}
      {actions.reopen ? <ReopenForm issue={issue} onReload={reload} onDone={setNotice} /> : null}
      {nothing && !(waiting && handler) ? (
        <p className="callout" role="status" data-testid="read-only">
          {live ? t('iss.verification.nothing.notice') : t('iss.workspace.actions.frozen.notice')}
        </p>
      ) : null}
    </>
  );
}
