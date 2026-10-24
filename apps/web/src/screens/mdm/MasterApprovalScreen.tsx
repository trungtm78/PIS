import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field, ImpactTable } from './components';
import { useDecideChange, usePublishRecord, useQueue } from './hooks';
import { changeKindLabel, problemMessage } from './labels';
import { PUBLISH_PERMISSION, REASON_MAX_LENGTH, REASON_MIN_LENGTH, REVIEW_PERMISSION, describeProblem, proposalRows, recordLink } from './model';
import type { ChangeView, ProposalField } from './model';

const DETAIL_PATH = '/mdm/mdm-27';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NEVER_EMPTY = (): boolean => false;

type Decision = 'approve' | 'reject' | 'return';
const DECISIONS: readonly Decision[] = ['approve', 'reject', 'return'];

function proposalFieldName(t: ReturnType<typeof useTranslation>['t'], field: ProposalField): string {
  switch (field) {
    case 'label':
      return t('mdm.history.field.label.text');
    case 'attributes':
      return t('mdm.history.field.attributes.text');
    case 'parent':
      return t('mdm.history.field.parent.text');
    case 'validUntil':
      return t('mdm.approval.proposal.validUntil.text');
    case 'legalBasis':
      return t('mdm.history.field.legalBasis.text');
    case 'successor':
      return t('mdm.approval.proposal.successor.text');
  }
}

function decisionLabel(t: ReturnType<typeof useTranslation>['t'], decision: Decision): string {
  switch (decision) {
    case 'approve':
      return t('mdm.approval.decision.approve.action');
    case 'reject':
      return t('mdm.approval.decision.reject.action');
    case 'return':
      return t('mdm.approval.decision.return.action');
  }
}

/** MDM-32: the queue of change requests that wait for a reviewer and for a publisher; neither role is ever the proposer (ST-MDM-001). */
export default function MasterApprovalScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <MasterApprovalContent key={tenantId ?? 'none'} route={route} />;
}

function MasterApprovalContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, tenant, mode } = useSession();
  const frozen = mode === 'READ_ONLY';
  const canReview = (permissions === undefined || permissions.includes(REVIEW_PERMISSION)) && !frozen;
  const canPublish = (permissions === undefined || permissions.includes(PUBLISH_PERMISSION)) && !frozen;
  const review = useQueue('IN_REVIEW');
  const publication = useQueue('APPROVED');
  const decide = useDecideChange();
  const publish = usePublishRecord();
  const [acting, setActing] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [problemField, setProblemField] = useState<'reason' | 'document' | undefined>(undefined);
  const state = useScreenState({
    isLoading: review.isLoading || publication.isLoading,
    error: review.error ?? publication.error,
    data: review.data === undefined || publication.data === undefined ? undefined : [...review.data, ...publication.data],
    isEmpty: NEVER_EMPTY,
  });
  const decideProblem = decide.isError ? describeProblem(decide.error) : undefined;
  const publishProblem = publish.isError ? describeProblem(publish.error) : undefined;

  const open = (id: string): void => {
    setActing(id);
    setReason('');
    setDocumentId('');
    setProblemField(undefined);
    decide.reset();
    publish.reset();
  };

  const send = (event: FormEvent, change: ChangeView, decision: Decision): void => {
    event.preventDefault();
    if (decide.isPending) return;
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN_LENGTH || trimmed.length > REASON_MAX_LENGTH) {
      setProblemField('reason');
      return;
    }
    decide.mutate({ id: change.id, version: change.version, decision, reason: trimmed }, { onSuccess: () => setActing(undefined) });
  };

  const sendPublish = (event: FormEvent, change: ChangeView): void => {
    event.preventDefault();
    if (publish.isPending || change.masterRecordId === null || change.recordVersion === null) return;
    if (!UUID.test(documentId.trim())) {
      setProblemField('document');
      return;
    }
    publish.mutate({ id: change.masterRecordId, version: change.recordVersion, decisionDocumentId: documentId.trim().toLowerCase() }, { onSuccess: () => setActing(undefined) });
  };

  const summary = (change: ChangeView): string => {
    const label = typeof change.proposed.label === 'string' ? change.proposed.label : '';
    return change.changeKind === 'RETIRE' ? t('mdm.approval.retire.summary') : label;
  };

  const row = (change: ChangeView, stage: 'review' | 'publish') => {
    const own = change.createdBy === tenant?.membershipId;
    const allowed = stage === 'review' ? canReview : canPublish;
    return (
      <tr key={change.id} data-change-id={change.id} data-stage={stage}>
        <td>{changeKindLabel(t, change.changeKind)}</td>
        <td>
          {change.businessKey === null ? (
            change.masterType
          ) : (
            <Link to={recordLink(DETAIL_PATH, change.masterType, change.businessKey, change.namespace)}>
              {change.masterType} · {change.businessKey}
            </Link>
          )}
          <div className="sub">{summary(change)}</div>
        </td>
        <td>{change.impact === null ? t('mdm.approval.impact.missing.text') : t('mdm.approval.impact.total.text', { total: change.impact.total })}</td>
        <td>{change.effectiveFrom}</td>
        <td className="row-actions">
          {!allowed ? null : own ? (
            <span className="sub" data-testid="own-request">
              {t('mdm.approval.own.hint')}
            </span>
          ) : acting === change.id ? null : (
            <button type="button" onClick={() => open(change.id)}>
              {stage === 'review' ? t('mdm.approval.review.action') : t('mdm.approval.publish.action')}
            </button>
          )}
        </td>
      </tr>
    );
  };

  const panel = (change: ChangeView, stage: 'review' | 'publish') => (
    <tr key={`${change.id}:panel`} data-panel-for={change.id}>
      <td colSpan={5}>
        {change.impact === null ? null : (
          <>
            <h3>{t('mdm.approval.impact.title')}</h3>
            <ImpactTable impact={change.impact} />
          </>
        )}
        <h3>{t('mdm.approval.proposal.title')}</h3>
        <table className="table" data-testid="proposal">
          <thead>
            <tr>
              <th>{t('mdm.approval.proposal.col.field')}</th>
              <th>{t('mdm.approval.proposal.col.before')}</th>
              <th>{t('mdm.approval.proposal.col.after')}</th>
            </tr>
          </thead>
          <tbody>
            {proposalRows(change.before, change.proposed).map((item) => (
              <tr key={item.field} data-field={item.field}>
                <th scope="row">{proposalFieldName(t, item.field)}</th>
                <td>{item.before ?? ''}</td>
                <td>{item.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="sub">{change.reason}</p>
        {stage === 'review' ? (
          <form noValidate aria-label={t('mdm.approval.review.action')} onSubmit={(event) => event.preventDefault()}>
            <Field id={`reason-${change.id}`} label={t('mdm.approval.reason.label')} error={problemField === 'reason' ? t('mdm.field.tooShort.error') : undefined}>
              <textarea id={`reason-${change.id}`} rows={2} value={reason} aria-invalid={problemField === 'reason'} onChange={(event) => { setReason(event.target.value); setProblemField(undefined); }} />
            </Field>
            <div className="formfooter">
              {DECISIONS.map((decision) => (
                <button key={decision} type="button" className={decision === 'approve' ? 'primary' : undefined} disabled={decide.isPending} data-decision={decision} onClick={(event) => send(event, change, decision)}>
                  {decisionLabel(t, decision)}
                </button>
              ))}
              <button type="button" onClick={() => setActing(undefined)}>
                {t('mdm.approval.cancel.action')}
              </button>
            </div>
          </form>
        ) : (
          <form noValidate aria-label={t('mdm.approval.publish.action')} onSubmit={(event) => sendPublish(event, change)}>
            <Field id={`document-${change.id}`} label={t('mdm.approval.document.label')} error={problemField === 'document' ? t('mdm.approval.document.error') : undefined} hint={t('mdm.approval.document.hint')}>
              <input id={`document-${change.id}`} value={documentId} aria-invalid={problemField === 'document'} onChange={(event) => { setDocumentId(event.target.value); setProblemField(undefined); }} />
            </Field>
            <div className="formfooter">
              <button type="submit" className="primary" disabled={publish.isPending || change.recordVersion === null}>
                {t('mdm.approval.publish.confirm.action')}
              </button>
              <button type="button" onClick={() => setActing(undefined)}>
                {t('mdm.approval.cancel.action')}
              </button>
            </div>
          </form>
        )}
      </td>
    </tr>
  );

  const table = (title: string, empty: string, changes: ChangeView[], stage: 'review' | 'publish') => (
    <section className="card" aria-label={title} data-stage-section={stage}>
      <h2>{title}</h2>
      {changes.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('mdm.approval.col.kind')}</th>
              <th>{t('mdm.approval.col.entry')}</th>
              <th>{t('mdm.approval.col.impact')}</th>
              <th>{t('mdm.approval.col.effective')}</th>
              <th>
                <span className="sr-only">{t('mdm.approval.col.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {changes.flatMap((change) => (acting === change.id ? [row(change, stage), panel(change, stage)] : [row(change, stage)]))}
          </tbody>
        </table>
      )}
    </section>
  );

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mdm.approval.page.title')}</h1>
          <p>{t('mdm.approval.page.subtitle')}</p>
        </div>
      </div>
      {frozen ? (
        <p className="callout warning" role="status">
          {t('mdm.readOnly.frozen.notice')}
        </p>
      ) : null}
      {decide.isSuccess ? (
        <p className="callout" role="status">
          {t('mdm.approval.decided.notice')}
        </p>
      ) : null}
      {publish.isSuccess ? (
        <p className="callout" role="status">
          {t('mdm.approval.published.notice')}
        </p>
      ) : null}
      {decideProblem === undefined ? null : (
        <p className="callout warning" role="alert">
          {problemMessage(t, decideProblem)}
        </p>
      )}
      {publishProblem === undefined ? null : (
        <p className="callout warning" role="alert">
          {problemMessage(t, publishProblem)}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void Promise.all([review.refetch(), publication.refetch()])}>
        <div className="mdm-queues">
          {table(t('mdm.approval.review.title'), t('mdm.approval.review.empty'), review.data ?? [], 'review')}
          {table(t('mdm.approval.publish.title'), t('mdm.approval.publish.empty'), publication.data ?? [], 'publish')}
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('mdm.approval.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
