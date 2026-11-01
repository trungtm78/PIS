import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../ctr/components';
import { useOnline } from '../../qms/offline/hooks';
import { useReturnDocument } from '../drafts/hooks';
import { queueItems, useCompleteSigning, useDownloadUrl, useOutgoingDocument, useOutgoingQueue, useStartLeaderSigning } from '../outgoing/hooks';
import { adapterLabel, problemMessage, stageLabel } from '../outgoing/labels';
import { describeProblem } from '../outgoing/problems';
import type { ProblemContext } from '../outgoing/problems';
import { activeCertificates, canStartSigning, currentVersion, lastSessionOf, minutesLeft, openSessionOf, signerOf } from '../outgoing/rules';
import '../outgoing/outgoing.css';
import './mobile.css';
import { OUTGOING_READ, OUTGOING_REVIEW, OUTGOING_SIGN, holds } from './model';

const SHORT_CHECKSUM = 12;
const REASON_MAX = 2000;

/**
 * DOC-22: the leader approves and signs a document on a phone (ST-DOC-020, DOC 4, CXN-DOC-07). Signing goes only through the remote certificate authority and is confirmed with the one-time code on the signer's device;
 * the session lasts 15 minutes and, once it has lapsed, completing it is refused (409 SIGNING_SESSION_EXPIRED) and a new one is opened. There is no offline signing: with no connection the commands are not offered, and
 * nothing is kept on the device, so no signing command can wait in a queue. The document may be returned to its drafter with a reason instead. Reviewing a draft (the format checklist) stays on DOC-04.
 */
export default function MobileApprovalScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  // The list, the code and the reason belong to one membership: a switch of tenant or of membership starts the screen over.
  const key = `${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.mobile.out.page.title')}</h1>
          <p>{t('doc.mobile.out.page.subtitle')}</p>
        </div>
      </div>
      {holds(permissions, OUTGOING_READ) ? <Approvals key={key} /> : <StateBoundary state="denied" />}
      <p className="prototype-note">{t('doc.mobile.out.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Approvals() {
  const { t } = useTranslation();
  const { mode } = useSession();
  const online = useOnline();
  const [params, setParams] = useSearchParams();
  const queue = useOutgoingQueue('SUBMITTED');
  const queued = useMemo(() => queueItems(queue.data), [queue.data]);
  // A page that could not be read after others were leaves the documents read where they are, with a control to ask for it again.
  const moreFailed = queue.isFetchNextPageError;
  const loaded = useScreenState({ isLoading: queue.isLoading, error: moreFailed ? null : queue.error, data: queue.data === undefined ? undefined : queued });
  // With no connection the read waits for it; a person who has nothing to show yet is told so, instead of being left with a spinner.
  const state = !online && loaded === 'loading' ? 'offline' : loaded;
  const chosen = params.get('doc') ?? undefined;
  return (
    <>
      {online ? null : (
        <p className="callout warning" role="status" data-testid="offline-note">
          {t('doc.mobile.out.offline.notice')}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void queue.refetch()}>
        <ul className="mobile-list" data-testid="waiting">
          {queued.map((row) => (
            <li key={row.id} className="card" data-document-id={row.id} data-chosen={row.id === chosen ? 'yes' : 'no'}>
              <p>
                <strong>{row.title}</strong>
              </p>
              <p className="sub">{t('doc.mobile.out.row.facts', { type: row.docTypeCode, signer: row.signerTitle ?? '' })}</p>
              <button type="button" data-open={row.id} onClick={() => setParams({ doc: row.id })}>
                {t('doc.mobile.out.open.action')}
              </button>
            </li>
          ))}
        </ul>
        {queue.hasNextPage ? (
          <button type="button" disabled={queue.isFetchingNextPage} onClick={() => void queue.fetchNextPage()}>
            {t('doc.mobile.out.more.action')}
          </button>
        ) : null}
      </StateBoundary>
      {moreFailed ? (
        <div className="callout warning" role="alert" data-testid="more-failed">
          <p>{t('doc.mobile.out.moreFailed.notice')}</p>
          <button type="button" disabled={queue.isFetchingNextPage || !online} onClick={() => void queue.fetchNextPage()}>
            {t('doc.mobile.out.moreRetry.action')}
          </button>
        </div>
      ) : null}
      {chosen === undefined ? null : <Decision key={chosen} id={chosen} acting={online && mode !== 'READ_ONLY'} onClose={() => setParams({})} />}
    </>
  );
}

function Decision({ id, acting, onClose }: { id: string; acting: boolean; onClose(): void }) {
  const { t, locale } = useTranslation();
  const { tenant, permissions } = useSession();
  const detail = useOutgoingDocument(id);
  const start = useStartLeaderSigning();
  const complete = useCompleteSigning();
  const sendBack = useReturnDocument();
  const download = useDownloadUrl();
  const [otp, setOtp] = useState('');
  const [otpMissing, setOtpMissing] = useState(false);
  const [signed, setSigned] = useState(false);
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const [file, setFile] = useState<{ versionId: string; url: string } | undefined>(undefined);
  const [context, setContext] = useState<ProblemContext>('start');
  const state = useScreenState({ isLoading: detail.isLoading, error: detail.error, data: detail.data });
  const doc = detail.data;
  const now = new Date();
  const version = doc === undefined ? undefined : currentVersion(doc);
  const open = doc === undefined ? undefined : openSessionOf(doc, 'LEADER', now);
  const last = doc === undefined ? undefined : lastSessionOf(doc, 'LEADER');
  const certificate = doc === undefined ? undefined : activeCertificates(doc, 'PERSONAL')[0];
  const mine = doc !== undefined && doc.signerUserId === tenant?.membershipId;
  const signer = mine && holds(permissions, OUTGOING_SIGN);
  const maySign = acting && signer;
  const mayReturn = acting && holds(permissions, OUTGOING_REVIEW);
  const failure = sendBack.isError
    ? { error: sendBack.error, context: 'start' as const }
    : context === 'start' && start.isError
      ? { error: start.error, context }
      : context === 'complete' && complete.isError
        ? { error: complete.error, context }
        : undefined;
  const lapsed = last?.status === 'EXPIRED' && open === undefined;
  const timeOf = (iso: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Bangkok' }).format(new Date(iso));

  const begin = (): void => {
    if (doc === undefined || start.isPending || !maySign) return;
    setContext('start');
    complete.reset();
    start.mutate({ documentId: doc.id, version: doc.version, certificateId: certificate?.id, adapterCode: 'REMOTE_CA' });
  };
  const confirm = (event: FormEvent): void => {
    event.preventDefault();
    if (doc === undefined || open === undefined || complete.isPending || !maySign) return;
    setOtpMissing(otp.trim() === '');
    if (otp.trim() === '') return;
    setContext('complete');
    complete.mutate({ sessionId: open.id, version: open.version, confirmation: otp.trim() }, { onSuccess: () => setSigned(true) });
  };
  const giveBack = (event: FormEvent): void => {
    event.preventDefault();
    if (doc === undefined || sendBack.isPending || !mayReturn) return;
    const words = reason.trim();
    setReasonMissing(words === '' || words.length > REASON_MAX);
    if (words === '' || words.length > REASON_MAX) return;
    sendBack.mutate({ documentId: doc.id, version: doc.version, reason: words }, { onSuccess: onClose });
  };
  const openFile = (): void => {
    if (version === undefined) return;
    const asked = version.id;
    download.mutate(asked, { onSuccess: (url) => setFile({ versionId: asked, url }) });
  };

  return (
    <div className="card" data-testid="decision">
      <div className="actions">
        <h2>{t('doc.mobile.out.decision.title')}</h2>
        <button type="button" onClick={onClose}>
          {t('doc.mobile.out.close.action')}
        </button>
      </div>
      <StateBoundary state={state} onRetry={() => void detail.refetch()}>
        {doc === undefined ? null : (
          <div data-document-id={doc.id} data-status={doc.status}>
            <p>
              <strong>{doc.title}</strong>
            </p>
            <dl className="mobile-facts">
              <dt>{t('doc.mobile.out.fact.signer')}</dt>
              <dd>{signerOf(doc)}</dd>
              <dt>{t('doc.mobile.out.fact.file')}</dt>
              <dd data-testid="file-facts">
                {version === undefined
                  ? t('doc.mobile.out.fact.noFile')
                  : t('doc.mobile.out.fact.version', { version: version.version, pages: version.pageCount, stage: stageLabel(t, version.stage), checksum: version.checksum.slice(0, SHORT_CHECKSUM) })}
              </dd>
              <dt>{t('doc.mobile.out.fact.method')}</dt>
              <dd data-testid="method">{adapterLabel(t, 'REMOTE_CA')}</dd>
            </dl>
            {version === undefined ? null : (
              <p className="row">
                <button type="button" onClick={openFile} disabled={download.isPending}>
                  {t('doc.mobile.out.pdf.action')}
                </button>
                {file === undefined || file.versionId !== version.id ? null : (
                  <a href={file.url} target="_blank" rel="noreferrer">
                    {t('doc.mobile.out.pdf.link')}
                  </a>
                )}
              </p>
            )}
            {download.isError ? <p className="callout warning">{t('doc.mobile.out.pdf.failed')}</p> : null}
            {failure === undefined ? null : (
              <p className="callout warning" role="alert" data-testid="refusal">
                {problemMessage(t, describeProblem(failure.error, failure.context))}
              </p>
            )}
            {lapsed && failure === undefined ? (
              <p className="callout warning" role="status" data-testid="lapsed">
                {t('doc.mobile.out.expired.notice')}
              </p>
            ) : null}
            {signed || doc.leaderSignedAt !== null ? (
              <p className="callout" role="status" data-testid="signed">
                {t('doc.mobile.out.signed.notice')}
              </p>
            ) : !acting ? (
              <p className="callout warning" role="status" data-testid="no-signing">
                {t('doc.mobile.out.noSigning.notice')}
              </p>
            ) : open !== undefined && maySign ? (
              <form onSubmit={confirm} noValidate aria-label={t('doc.mobile.out.confirm.form')}>
                <p className="sub">{t('doc.mobile.out.confirm.hint', { minutes: minutesLeft(open.expiresAt, now), until: timeOf(open.expiresAt) })}</p>
                <Field id="mobile-otp" label={t('doc.mobile.out.otp.label')} error={otpMissing ? t('doc.mobile.out.otp.required') : undefined}>
                  <input id="mobile-otp" autoComplete="one-time-code" inputMode="numeric" value={otp} onChange={(event) => setOtp(event.target.value)} />
                </Field>
                <button type="submit" className="primary" disabled={complete.isPending}>
                  {t('doc.mobile.out.confirm.action')}
                </button>
              </form>
            ) : maySign && canStartSigning(doc, now) ? (
              <button type="button" className="primary" data-action="start" disabled={start.isPending} onClick={begin}>
                {lapsed ? t('doc.mobile.out.restart.action') : t('doc.mobile.out.start.action')}
              </button>
            ) : (
              <p className="callout warning" role="status" data-testid="cannot-sign">
                {signer ? t('doc.mobile.out.cannotSign.notice') : t('doc.mobile.out.notSigner.notice')}
              </p>
            )}
            {mayReturn && !signed && doc.leaderSignedAt === null ? (
              returning ? (
                <form onSubmit={giveBack} noValidate aria-label={t('doc.mobile.out.return.form')}>
                  <Field id="mobile-reason" label={t('doc.mobile.out.reason.label')} error={reasonMissing ? t('doc.mobile.out.reason.required') : undefined}>
                    <textarea id="mobile-reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
                  </Field>
                  <button type="submit" disabled={sendBack.isPending}>
                    {t('doc.mobile.out.return.submit')}
                  </button>
                </form>
              ) : (
                <button type="button" data-action="return" onClick={() => setReturning(true)}>
                  {t('doc.mobile.out.return.action')}
                </button>
              )
            ) : null}
          </div>
        )}
      </StateBoundary>
    </div>
  );
}
