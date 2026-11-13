import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { resolveDoa, unitPathsOf } from '../adm/doa/engine';
import { useDoaMatrices, useRoleOptions } from '../adm/doa/hooks';
import { previewFailureMessage } from '../adm/doa/labels';
import { useOrgUnits } from '../adm/org-tree/hooks';
import { listItems, useDecideReview, useDraft, useDraftList, useReturnDocument, useTimeline } from './drafts/hooks';
import { checklistLabel, eventLabel, failureMessage, fieldProblemMessage, problemMessage, signingModeLabel, statusLabel, urgencyLabel } from './drafts/labels';
import { describeProblem } from './drafts/problems';
import type { DraftProblem } from './drafts/problems';
import { checklistBody, checklistComplete, reasonProblem } from './drafts/rules';
import { REVIEW_CHECKLIST, REVIEW_DOCUMENT_PERMISSION } from './drafts/types';
import type { ChecklistKey } from './drafts/types';
import './drafts/drafts.css';

const EDITOR_PATH = '/doc/doc-02';
const SIGNING_PATH = '/doc/doc-05';
const SHORT_ID = 8;
const shortId = (id: string | null): string => (id === null || id === '' ? '' : id.slice(-SHORT_ID));
/** What the screen reads to say who may sign under the delegation-of-authority matrix: the matrix, the units (for the subtree of a rule) and the roles. */
const DOA_READS = ['adm.doa.read', 'organization_unit.read', 'role_grant.read'] as const;
const todayInVietnam = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

/** DOC-04: a reviewer other than the drafter checks the format, and the final PDF is locked for the signer. */
export default function OutgoingReviewScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The choice, the checklist and the comment belong to one tenant: a switch starts the screen over.
  return <ReviewContent key={tenantId ?? 'none'} route={route} />;
}

function ReviewContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const [params, setParams] = useSearchParams();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const frozen = mode === 'READ_ONLY';
  const canReview = (permissions === undefined || permissions.includes(REVIEW_DOCUMENT_PERMISSION)) && !frozen;
  const inReview = useDraftList({ status: 'IN_REVIEW', docTypeCode: '', year: '' });
  const submitted = useDraftList({ status: 'SUBMITTED', docTypeCode: '', year: '' });
  const queue = useMemo(() => [...listItems(inReview.data), ...listItems(submitted.data)].sort((left, right) => right.createdAt.localeCompare(left.createdAt)), [inReview.data, submitted.data]);
  const selectedId = params.get('doc') ?? queue[0]?.id;
  const detail = useDraft(selectedId);
  const doc = detail.data;
  const timeline = useTimeline(doc?.documentId);
  const [checks, setChecks] = useState<Partial<Record<ChecklistKey, boolean>>>({});
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState('');
  const [refused, setRefused] = useState(false);
  const [problem, setProblem] = useState<DraftProblem | undefined>(undefined);
  const [done, setDone] = useState<{ kind: 'approved' | 'returned'; sha: string | undefined } | undefined>(undefined);
  const decide = useDecideReview();
  const sendBack = useReturnDocument();
  const busy = decide.isPending || sendBack.isPending;
  // The signing authority under the DoA matrix in force: read only by a reviewer who may read the matrix, the units and the roles; the server checks the signer again when the document is signed.
  const doaReadable = permissions !== undefined && DOA_READS.every((permission) => permissions.includes(permission));
  const matrices = useDoaMatrices(doaReadable);
  const units = useOrgUnits(doaReadable);
  const roles = useRoleOptions(doaReadable);
  const state = useScreenState({
    isLoading: inReview.isLoading || submitted.isLoading,
    error: inReview.error ?? submitted.error,
    data: inReview.data === undefined || submitted.data === undefined ? undefined : queue,
  });

  const own = doc !== undefined && tenant?.membershipId === doc.drafterUserId;
  const complete = checklistComplete(checks);
  // Only the final PDF that is current is the one that is locked; an earlier one that was taken back stays in the history.
  const finalFile = doc?.versions.find((version) => version.id === doc.currentVersionId && version.stage === 'RENDERED_FINAL');
  const lockedSha = done?.sha ?? finalFile?.checksum ?? doc?.latestReview?.fileSha256 ?? undefined;
  const reviewing = doc?.status === 'IN_REVIEW';
  // A document already approved shows the checklist and the opinion its reviewer recorded, read-only.
  const recorded = doc?.latestReview?.kind === 'REVIEW_APPROVED' ? doc.latestReview : undefined;
  const shownChecks = reviewing ? checks : (recorded?.checklist ?? {});
  const shownComment = reviewing ? comment : (recorded?.comment ?? '');
  const authority = ((): string => {
    if (doc === undefined) return '';
    if (!doaReadable) return t('doc.review.doa.unreadable');
    if (matrices.isError || units.isError || roles.isError) return t('doc.review.doa.failed');
    if (matrices.data === undefined || units.data === undefined || roles.data === undefined) return t('doc.review.doa.loading');
    if (doc.draftingUnitId === '') return previewFailureMessage(t, 'unit');
    const amount = typeof doc.payload.amount_vnd === 'string' && doc.payload.amount_vnd.trim() !== '' ? doc.payload.amount_vnd.trim() : null;
    const records = matrices.data.map((matrix) => ({ id: matrix.id, status: matrix.status, effectiveFrom: matrix.effectiveFrom, effectiveUntil: matrix.effectiveUntil, rules: matrix.rules }));
    const found = resolveDoa(records, unitPathsOf(units.data), { documentType: doc.docTypeCode, amountVnd: amount, unitId: doc.draftingUnitId, businessDate: todayInVietnam() });
    if (!found.ok) return previewFailureMessage(t, found.failure);
    const role = roles.data.find((entry) => entry.id === found.resolution.approverRoleId)?.code ?? found.resolution.approverRoleId;
    return t('doc.review.doa.resolved', { role, levels: found.resolution.approvalLevels });
  })();

  const choose = (id: string): void => {
    setParams({ doc: id });
    setChecks({});
    setComment('');
    setReason('');
    setRefused(false);
    setProblem(undefined);
    setDone(undefined);
  };

  const approve = (): void => {
    if (doc === undefined || !canReview || busy || own || !complete) return;
    setProblem(undefined);
    decide.mutate(
      { documentId: doc.id, version: doc.version, decision: 'APPROVE', comment, checklist: checklistBody(checks) },
      { onSuccess: (result) => setDone({ kind: 'approved', sha: result.fileSha256 }), onError: (error) => setProblem(describeProblem(error)) },
    );
  };

  const returnIt = (event: FormEvent): void => {
    event.preventDefault();
    if (doc === undefined || !canReview || busy) return;
    if (reasonProblem(reason) !== undefined) {
      setRefused(true);
      return;
    }
    setProblem(undefined);
    const onError = (error: unknown): void => setProblem(describeProblem(error));
    if (doc.status === 'IN_REVIEW') {
      decide.mutate({ documentId: doc.id, version: doc.version, decision: 'RETURN', comment: reason, checklist: undefined }, { onSuccess: () => setDone({ kind: 'returned', sha: undefined }), onError });
    } else {
      sendBack.mutate({ documentId: doc.id, version: doc.version, reason }, { onSuccess: () => setDone({ kind: 'returned', sha: undefined }), onError });
    }
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="doc-drafts">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.review.page.title')}</h1>
          <p>{t('doc.review.page.subtitle')}</p>
        </div>
      </div>
      {frozen ? (
        <p className="callout warning" role="status">
          {t('doc.review.frozen.notice')}
        </p>
      ) : null}
      <StateBoundary
        state={state}
        onRetry={() => {
          void inReview.refetch();
          void submitted.refetch();
        }}
      >
        <div className="review-layout">
          <div className="card">
            <h2>{t('doc.review.queue.title')}</h2>
            <ul className="review-queue" aria-label={t('doc.review.queue.title')}>
              {queue.map((row) => (
                <li key={row.id} className={row.id === selectedId ? 'selected' : undefined} data-document-id={row.id}>
                  <a
                    href={`?doc=${row.id}`}
                    aria-current={row.id === selectedId ? 'true' : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      choose(row.id);
                    }}
                  >
                    {row.title}
                  </a>
                  <div className="sub">
                    {row.docTypeCode} · {statusLabel(t, row.status)}
                  </div>
                </li>
              ))}
            </ul>
            {inReview.hasNextPage || submitted.hasNextPage ? (
              <button
                type="button"
                onClick={() => {
                  if (inReview.hasNextPage) void inReview.fetchNextPage();
                  if (submitted.hasNextPage) void submitted.fetchNextPage();
                }}
              >
                {t('doc.review.queue.more.action')}
              </button>
            ) : null}
          </div>
          <div>
            {doc === undefined ? (
              detail.isError ? (
                <p className="callout warning" role="alert">
                  {problemMessage(t, describeProblem(detail.error))}
                </p>
              ) : (
                <p className="muted" role="status">
                  {selectedId === undefined ? t('doc.review.none.text') : t('doc.review.loading.text')}
                </p>
              )
            ) : (
              <div className="card" data-document-id={doc.id} data-status={doc.status}>
                <h2>{doc.title}</h2>
                <dl className="facts">
                  <div>
                    <dt>{t('doc.review.fact.type')}</dt>
                    <dd>{doc.docTypeCode}</dd>
                  </div>
                  <div>
                    <dt>{t('doc.review.fact.status')}</dt>
                    <dd>{statusLabel(t, doc.status)}</dd>
                  </div>
                  <div>
                    <dt>{t('doc.review.fact.drafter')}</dt>
                    <dd title={doc.drafterUserId}>{shortId(doc.drafterUserId)}</dd>
                  </div>
                  <div>
                    <dt>{t('doc.review.fact.signer')}</dt>
                    <dd title={doc.signerUserId ?? undefined}>{shortId(doc.signerUserId)}</dd>
                  </div>
                  <div>
                    <dt>{t('doc.review.fact.mode')}</dt>
                    <dd>{signingModeLabel(t, doc.signingMode)}</dd>
                  </div>
                  <div>
                    <dt>{t('doc.review.fact.urgency')}</dt>
                    <dd>{urgencyLabel(t, doc.urgency)}</dd>
                  </div>
                  <div>
                    <dt>{t('doc.review.fact.amount')}</dt>
                    <dd>{typeof doc.payload.amount_vnd === 'string' ? doc.payload.amount_vnd : t('doc.review.fact.noAmount')}</dd>
                  </div>
                </dl>
                <h3>{t('doc.review.recipients.title')}</h3>
                <ul>
                  {doc.recipients.map((recipient) => (
                    <li key={`${recipient.kind}:${recipient.name}`}>{recipient.name}</li>
                  ))}
                </ul>
                <h3>{t('doc.review.content.title')}</h3>
                <dl className="facts" data-content="payload">
                  {Object.entries(doc.payload)
                    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
                    .map(([name, value]) => (
                      <div key={name}>
                        <dt>{name}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                </dl>
                <dl className="facts">
                  <div>
                    <dt>{t('doc.review.hash.title')}</dt>
                    {lockedSha === undefined ? (
                      <dd className="muted">{t('doc.review.hash.pending')}</dd>
                    ) : (
                      <dd data-final-sha={lockedSha}>
                        <span className="hash">{lockedSha}</span>
                      </dd>
                    )}
                  </div>
                  <div>
                    <dt>{t('doc.review.doa.title')}</dt>
                    <dd data-testid="doa-authority">
                      {authority}
                      <small className="sub">{t('doc.review.doa.hint', { delegation: doc.delegationId === null ? t('doc.review.doa.noDelegation') : shortId(doc.delegationId) })}</small>
                    </dd>
                  </div>
                </dl>
                {doc.latestReview?.kind === 'RETURNED' && doc.status === 'DRAFT' ? (
                  <p className="callout warning" role="status">
                    {t('doc.review.returned.text', { comment: doc.latestReview.comment ?? '' })}
                  </p>
                ) : null}
                {done === undefined ? null : (
                  <p className="callout" role="status">
                    {done.kind === 'approved' ? t('doc.review.approved.notice') : t('doc.review.returned.notice')}{' '}
                    {done.kind === 'approved' ? <Link to={`${SIGNING_PATH}?doc=${doc.id}`}>{t('doc.review.approved.next')}</Link> : <Link to={`${EDITOR_PATH}?doc=${doc.id}`}>{t('doc.review.returned.next')}</Link>}
                  </p>
                )}
                <fieldset className="checklist" disabled={!reviewing || !canReview || busy || own}>
                  <legend>{t('doc.review.checklist.title')}</legend>
                  <ul className="checklist-items">
                    {REVIEW_CHECKLIST.map((key) => (
                      <li key={key} className="check">
                        <input id={`check-${key}`} type="checkbox" checked={shownChecks[key] === true} onChange={(event) => setChecks({ ...checks, [key]: event.target.checked })} />
                        <label htmlFor={`check-${key}`}>{checklistLabel(t, key)}</label>
                      </li>
                    ))}
                  </ul>
                  <div className="field">
                    <label htmlFor="review-comment">{t('doc.review.comment.label')}</label>
                    <textarea id="review-comment" value={shownComment} onChange={(event) => setComment(event.target.value)} />
                  </div>
                </fieldset>
                {own && doc.status === 'IN_REVIEW' ? (
                  <p className="callout warning" role="status" data-self-review="true">
                    {t('doc.review.own.notice')}
                  </p>
                ) : null}
                {problem === undefined ? null : (
                  <div className="callout warning" role="alert" data-problem={problem.reason}>
                    <p>{problemMessage(t, problem)}</p>
                    {problem.reason === 'formatCheck' ? (
                      <ul>
                        {problem.failures.map((failure) => (
                          <li key={`${failure.field}:${failure.code}`}>{failureMessage(t, failure)}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                )}
                {canReview && (doc.status === 'IN_REVIEW' || doc.status === 'SUBMITTED') ? (
                  <div className="row gap">
                    {doc.status === 'IN_REVIEW' ? (
                      <button type="button" className="primary" disabled={busy || own || !complete} title={own ? t('doc.review.approve.own') : !complete ? t('doc.review.approve.incomplete') : undefined} onClick={approve}>
                        {t('doc.review.approve.action')}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {canReview && (doc.status === 'IN_REVIEW' || doc.status === 'SUBMITTED') ? (
                  <form onSubmit={returnIt} noValidate aria-label={t('doc.review.return.title')}>
                    <h3>{t('doc.review.return.title')}</h3>
                    <p className="sub">{doc.status === 'SUBMITTED' ? t('doc.review.return.locked') : t('doc.review.return.hint')}</p>
                    <div className="field">
                      <label htmlFor="review-reason">{t('doc.review.return.reason.label')}</label>
                      <textarea id="review-reason" value={reason} aria-invalid={refused && reasonProblem(reason) !== undefined} onChange={(event) => setReason(event.target.value)} />
                      {refused && reasonProblem(reason) !== undefined ? (
                        <small role="alert" className="field-error">
                          {fieldProblemMessage(t, { field: 'reason', code: reasonProblem(reason) === 'REQUIRED' ? 'REQUIRED' : 'TOO_SHORT' })}
                        </small>
                      ) : null}
                    </div>
                    <button type="submit" disabled={busy}>
                      {t('doc.review.return.action')}
                    </button>
                  </form>
                ) : null}
                <h3>{t('doc.review.history.title')}</h3>
                {timeline.data === undefined || timeline.data.events.length === 0 ? (
                  <p className="muted">{t('doc.review.history.empty')}</p>
                ) : (
                  <ol className="history" aria-label={t('doc.review.history.title')}>
                    {timeline.data.events.map((event) => (
                      <li key={event.id}>
                        <strong>{eventLabel(t, event.kind)}</strong> · {event.occurredAt.slice(0, 16).replace('T', ' ')} · {shortId(event.actorId)}
                        {event.comment === null ? null : <div className="sub">{event.comment}</div>}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </div>
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('doc.review.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
