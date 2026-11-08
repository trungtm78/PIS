import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard, StatusPill } from '../../../ui';
import { vietnamStamp } from '../shared/vnd-model';
import { Empty, ReceiptNote, StaleNotice, useReceipt, useWriter } from '../shared/vnd-ui';
import { AnswerRequestDialog, SubmitCertificateDialog } from './portal-dialogs';
import { usePortalRequests } from './portal-hooks';
import { requestKindLabel, requestStatusLabel } from './portal-labels';
import { PORTAL_PERMISSION, REQUEST_STATUSES, answeredLate, canRespond, requestStatusIcon, requestStatusTone } from './portal-model';
import type { PortalRequest } from './portal-model';
import { PortalBoundary, PortalLayout, RequestClockCell } from './portal-ui';

type Dialog = { kind: 'answer'; request: PortalRequest } | { kind: 'certificate'; request: PortalRequest };

/** VND-17, the requests that staff sent the contractor and its answers. An answer after the time limit is still taken and is marked late; a request returned for more shows what was missing and the round. */
export default function PortalRequestsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const scope = `${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`;
  return <Requests key={scope} route={route} />;
}

function Requests({ route }: ScreenProps) {
  const { t } = useTranslation();
  const writer = useWriter();
  const [status, setStatus] = useState('');
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const receipt = useReceipt();
  const query = usePortalRequests(status);
  const page = query.data;
  const state: ScreenState = useScreenState({ isLoading: query.isLoading, error: page === undefined ? query.error : undefined, data: page, isEmpty: (data) => status === '' && (data as { items: unknown[] }).items.length === 0 });
  const refreshFailed = query.isError && page !== undefined;
  const canAnswer = !writer.readOnly && writer.can(PORTAL_PERMISSION.respond);
  const canUpload = !writer.readOnly && writer.can(PORTAL_PERMISSION.certificate);
  const done = (what: string): void => {
    setDialog(undefined);
    receipt.show(t('vnd.receipt.done.text', { what, time: vietnamStamp(new Date().toISOString()) }));
  };
  return (
    <PortalLayout route={route} active="VND-17" title={t('vnp.requests.page.title')} subtitle={t('vnp.requests.page.subtitle')} asOf={page?.as_of} stale={refreshFailed}>
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <PortalBoundary state={state} onRetry={() => void query.refetch()}>
        {page !== undefined && (
          <SectionCard title={t('vnp.requests.section.title')}>
            <div className="vnd-filters">
              <label>
                {t('vnp.requests.filter.status.label')}
                <select value={status} onChange={(event) => setStatus(event.target.value)}>
                  <option value="">{t('vnp.requests.filter.all.text')}</option>
                  {REQUEST_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {requestStatusLabel(t, value)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {page.items.length === 0 ? (
              <Empty text={t('vnp.requests.filtered.empty.text')} testId="requests-filtered-empty" />
            ) : (
              <div data-testid="request-list">
                {page.items.map((request) => (
                  <RequestCard
                    key={request.id}
                    request={request}
                    asOf={page.as_of}
                    onAnswer={canAnswer && canRespond(request) ? () => setDialog({ kind: 'answer', request }) : undefined}
                    onCertificate={canUpload && canRespond(request) && request.kind === 'CERTIFICATE_UPLOAD' ? () => setDialog({ kind: 'certificate', request }) : undefined}
                  />
                ))}
              </div>
            )}
          </SectionCard>
        )}
      </PortalBoundary>
      {dialog?.kind === 'answer' && <AnswerRequestDialog request={dialog.request} onClose={() => setDialog(undefined)} onDone={() => done(t('vnp.answer.title.text'))} />}
      {dialog?.kind === 'certificate' && <SubmitCertificateDialog requestId={dialog.request.id} onClose={() => setDialog(undefined)} onDone={() => done(t('vnp.certificate.add.title'))} />}
    </PortalLayout>
  );
}

function RequestCard({ request, asOf, onAnswer, onCertificate }: { request: PortalRequest; asOf: string; onAnswer: (() => void) | undefined; onCertificate: (() => void) | undefined }) {
  const { t } = useTranslation();
  const late = answeredLate(request);
  const returned = request.status === 'OPEN' && request.round > 1;
  return (
    <article className="portal-request" data-request-id={request.id} data-status={request.status} aria-label={request.title}>
      <div className="portal-request__head">
        <strong>{request.title}</strong>
        <span className="vnd-row">
          <StatusPill tone="neutral">{requestKindLabel(t, request.kind)}</StatusPill>
          <StatusPill tone={requestStatusTone(request.status)} icon={requestStatusIcon(request.status)}>
            {requestStatusLabel(t, request.status)}
          </StatusPill>
        </span>
      </div>
      {request.body.trim() !== '' && <p className="portal-request__body">{request.body}</p>}
      <p className="vnd-note vnd-row">
        <span>{t('vnp.requests.due.text', { time: vietnamStamp(request.due_at) })}</span>
        <RequestClockCell clock={request.clock} dueAt={request.due_at} asOf={asOf} />
      </p>
      {returned && (
        <p className="callout" role="status" data-testid="returned-note">
          {t('vnp.requests.returned.text', { round: request.round })}
          {request.review_note !== null && ` ${request.review_note}`}
        </p>
      )}
      {request.response_text !== null && (
        <div className="portal-answer" data-testid="answer-text">
          <strong>{t('vnp.requests.answer.label')}</strong>
          {request.responded_at !== null && <span className="vnd-days">{` ${vietnamStamp(request.responded_at)}`}</span>}
          {late && (
            <span className="portal-late" data-testid="late-label">
              {` · ${t('vnp.requests.late.label')}`}
            </span>
          )}
          <p className="portal-request__body">{request.response_text}</p>
        </div>
      )}
      {(onAnswer !== undefined || onCertificate !== undefined) && (
        <span className="vnd-row">
          {onAnswer !== undefined && (
            <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="answer" onClick={onAnswer}>
              {returned ? t('vnp.requests.answerAgain.action') : t('vnp.requests.answer.action')}
            </button>
          )}
          {onCertificate !== undefined && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="upload-certificate" onClick={onCertificate}>
              {t('vnp.requests.certificate.action')}
            </button>
          )}
        </span>
      )}
    </article>
  );
}
