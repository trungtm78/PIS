import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../components';
import '../dgv.css';
import { changeLabel, compatibilityLabel, kindLabel, problemMessage } from './labels';
import { useDecideConsumer, useWaiting } from './hooks';
import { CONSUME_PERMISSION, describeContractProblem } from './model';
import type { WaitingApproval } from './model';

/**
 * DGV-19: the approvals that wait for the person as the owner of a consumer (ST-DGV-005, UAT-AC50): the revisions of the contracts that are in review with a breaking change, each with the consumer the person answers for, what
 * changes and the day it takes effect. The person approves or rejects with a comment; a decision is final, and it is theirs alone to make.
 */
export default function ConsumerInboxScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // A move to another tenant or person starts the screen over: no comment typed for the one is left for the other.
  return <InboxContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function InboxContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const list = useWaiting();
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data });
  const mayDecide = mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(CONSUME_PERMISSION));
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dgv.inbox.title')}</h1>
          <p>{t('dgv.inbox.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <ul className="grid" data-testid="inbox" aria-label={t('dgv.inbox.title')}>
          {(list.data ?? []).map((waiting) => (
            <li key={waiting.approval.id} className="card" data-approval={waiting.approval.id}>
              <Waiting waiting={waiting} mayDecide={mayDecide} />
            </li>
          ))}
        </ul>
      </StateBoundary>
      <p className="prototype-note">{t('dgv.inbox.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Waiting({ waiting, mayDecide }: { waiting: WaitingApproval; mayDecide: boolean }) {
  const { approval } = waiting;
  const { t } = useTranslation();
  const send = useDecideConsumer();
  const [comment, setComment] = useState('');
  const failure = send.isError ? describeContractProblem(send.error) : undefined;
  const decide = (decision: 'APPROVED' | 'REJECTED'): void => {
    if (send.isPending) return;
    send.mutate({ id: approval.id, version: approval.version, decision, comment });
  };
  return (
    <>
      <h2>
        <code>{waiting.datasetCode}</code> · {t('dgv.inbox.revision', { revision: waiting.revision })}
      </h2>
      <p>
        <span className={`pill ${waiting.compatibility === 'BREAKING' ? 'red' : 'green'}`}>{compatibilityLabel(t, waiting.compatibility)}</span>
      </p>
      <dl>
        <div>
          <dt>{t('dgv.inbox.consumer')}</dt>
          <dd data-testid="consumer">
            {kindLabel(t, approval.kind)} · <code>{approval.ref}</code>
          </dd>
        </div>
        <div>
          <dt>{t('dgv.inbox.effective')}</dt>
          <dd>{waiting.effectiveFrom ?? t('dgv.contract.none')}</dd>
        </div>
      </dl>
      {waiting.changes.length === 0 ? null : (
        <div data-testid="changes">
          <h3>{t('dgv.contract.changes.title')}</h3>
          {waiting.changes.map((change) => (
            <p key={`${change.kind}:${change.object}:${change.column}`} data-breaking={change.breaking}>
              {changeLabel(t, change.kind, change.column)}
            </p>
          ))}
        </div>
      )}
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="refusal" data-reason={failure.reason}>
          {problemMessage(t, failure.reason, failure.detail)}
        </p>
      )}
      {mayDecide ? (
        <>
          <Field id={`comment-${approval.id}`} label={t('dgv.inbox.comment')} error={undefined}>
            <input id={`comment-${approval.id}`} value={comment} maxLength={2000} onChange={(event) => setComment(event.target.value)} />
          </Field>
          <div className="formfooter">
            <button type="button" className="primary" disabled={send.isPending} onClick={() => decide('APPROVED')}>
              {t('dgv.inbox.approve')}
            </button>
            <button type="button" disabled={send.isPending} onClick={() => decide('REJECTED')}>
              {t('dgv.inbox.reject')}
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}
