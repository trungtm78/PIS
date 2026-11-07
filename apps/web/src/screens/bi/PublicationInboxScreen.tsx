import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import { useDecidePublication, usePublications, useSubmitPublication } from './hooks';
import { checkLabel, decisionLabel, kindLabel, refusalMessage, requestProblemMessage, statusLabel } from './publication-labels';
import { EMPTY_REQUEST, KINDS, PUBLISH_PERMISSION, REQUEST_PERMISSION, STATUSES, decisionProblem, describePublicationProblem, validateRequest } from './publication-model';
import type { Decision, PublicationRequest, RequestForm } from './publication-model';
import '../dis/dis.css';
import './bi-kit.css';
import { ContextBar, FilterPanel, SectionCard, StatusPill } from '../../ui';
import { requestStatusTone } from './tones';

const ALL = 'ALL';
const day = (stamp: string): string => stamp.slice(0, 10);

/**
 * BI-11: the inbox of the requests to publish (ST-BI-006, BI F5): a metric to certify, a version of a dashboard to publish, an access policy to activate, each with who asked and the checks it was made with (a metric was
 * rerun over the latest frozen snapshot). The approver decides one at a time; they are never the one who asked, and a rejection says why. The server runs the checks again and judges the decision.
 */
export default function PublicationInboxScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <InboxContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function InboxContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const writable = mode !== 'READ_ONLY';
  const mayDecide = writable && (permissions === undefined || permissions.includes(PUBLISH_PERMISSION));
  const mayAsk = writable && (permissions === undefined || permissions.includes(REQUEST_PERMISSION));
  const [status, setStatus] = useState<string>('PENDING');
  const list = usePublications(status === ALL ? undefined : status);
  const decide = useDecidePublication();
  const ask = useSubmitPublication();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [comment, setComment] = useState('');
  const [rejected, setRejected] = useState(false);
  const [form, setForm] = useState<RequestForm>(EMPTY_REQUEST);
  const [attempted, setAttempted] = useState(false);
  const [asked, setAsked] = useState(false);
  const state = useScreenState({
    isLoading: list.isLoading,
    error: list.error,
    data: list.data,
  });
  const chosen: PublicationRequest | undefined = (list.data ?? []).find((request) => request.id === selected && request.status === 'PENDING');
  const own = chosen !== undefined && chosen.requestedBy.id === tenant?.membershipId;
  const refusal = decide.isError ? describePublicationProblem(decide.error) : undefined;
  const askRefusal = ask.isError ? describePublicationProblem(ask.error) : undefined;
  const problems = attempted ? validateRequest(form) : {};

  const choose = (request: PublicationRequest): void => {
    decide.reset();
    setSelected(request.id);
    setComment('');
    setRejected(false);
  };
  const settle = (request: PublicationRequest, decision: Decision): void => {
    if (decide.isPending) return;
    if (decisionProblem(decision, comment) !== undefined) {
      setRejected(true);
      return;
    }
    decide.mutate(
      { requestId: request.id, version: request.version, decision, comment },
      {
        onSuccess: () => {
          setSelected(undefined);
          setComment('');
          setRejected(false);
        },
      },
    );
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    setAsked(false);
    if (ask.isPending || validateRequest(form).objectId !== undefined) return;
    ask.mutate(form, {
      onSuccess: () => {
        setForm({ ...form, objectId: '' });
        setAttempted(false);
        setAsked(true);
      },
    });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.pub.inbox.title')}</h1>
          <p>{t('bi.pub.inbox.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('bi.pub.ctx.scope'), value: tenant?.name ?? t('bi.pub.ctx.scope.all') },
          { label: t('bi.pub.ctx.count'), value: String((list.data ?? []).length) },
        ]}
        {...(list.dataUpdatedAt > 0 ? { asOf: new Date(list.dataUpdatedAt).toLocaleString('vi-VN') } : {})}
      />
      <FilterPanel applied={status === ALL ? 0 : 1}>
      <div className="mne-filters">
        <Field id="pub-status" label={t('bi.pub.filter.status')} error={undefined}>
          <select
            id="pub-status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setSelected(undefined);
            }}
          >
            <option value={ALL}>{t('bi.pub.status.all')}</option>
            {STATUSES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {statusLabel(t, candidate)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      </FilterPanel>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <table className="table" aria-label={t('bi.pub.inbox.title')} data-testid="requests">
          <thead>
            <tr>
              <th scope="col">{t('bi.pub.col.object')}</th>
              <th scope="col">{t('bi.pub.col.requested')}</th>
              <th scope="col">{t('bi.pub.col.checks')}</th>
              <th scope="col">{t('bi.pub.col.state')}</th>
              <th scope="col">{t('bi.pub.col.action')}</th>
            </tr>
          </thead>
          <tbody>
            {(list.data ?? []).map((request) => (
              <tr key={request.id} data-request={request.id} data-status={request.status}>
                <td>
                  <StatusPill tone="neutral">{kindLabel(t, request.kind)}</StatusPill> {request.objectCode ?? request.objectId}
                  {request.objectRevision === null ? null : (
                    <span className="sub">
                      {' '}
                      ·{' '}
                      {t('bi.pub.revision', {
                        revision: request.objectRevision,
                      })}
                    </span>
                  )}
                </td>
                <td>
                  {t('bi.pub.requested', {
                    name: request.requestedBy.name ?? request.requestedBy.id,
                    date: day(request.createdAt),
                  })}
                </td>
                <td>
                  {request.checks.map((check) => (
                    <span key={check.code} data-check={check.code} data-passed={check.passed}>
                      <StatusPill tone={check.passed ? 'success' : 'warning'}>{checkLabel(t, check.code)}</StatusPill>
                    </span>
                  ))}
                </td>
                <td>
                  <StatusPill tone={requestStatusTone(request.status)}>{statusLabel(t, request.status)}</StatusPill>
                  {request.decision === null ? null : (
                    <p className="sub" data-testid="decision">
                      {t('bi.pub.decided', {
                        decision: decisionLabel(t, request.decision),
                        name: request.decidedBy?.name ?? request.decidedBy?.id ?? '',
                      })}
                      {request.comment === null ? null : ` — ${request.comment}`}
                    </p>
                  )}
                </td>
                <td>
                  {mayDecide && request.status === 'PENDING' ? (
                    <button type="button" onClick={() => choose(request)}>
                      {t('bi.pub.review')}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </StateBoundary>
      {chosen === undefined ? null : (
        <div data-testid="decide" className="bi-decide">
        <SectionCard
          title={t('bi.pub.decide.title', {
            object: chosen.objectCode ?? chosen.objectId,
          })}
        >
          {refusal === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="refusal" data-reason={refusal.reason}>
              {refusalMessage(t, refusal.reason, refusal.detail)}
            </p>
          )}
          {own ? (
            <p className="callout" data-testid="self">
              {t('bi.pub.self')}
            </p>
          ) : (
            <>
              <Field id="pub-comment" label={t('bi.pub.decide.comment')} error={rejected ? t('bi.pub.decide.reason') : undefined}>
                <textarea id="pub-comment" value={comment} aria-invalid={rejected} onChange={(event) => setComment(event.target.value)} />
              </Field>
              <div className="formfooter">
                <button type="button" className="ui-button ui-button--primary" disabled={decide.isPending} onClick={() => settle(chosen, 'APPROVED')}>
                  {t('bi.pub.decide.approve')}
                </button>
                <button type="button" disabled={decide.isPending} onClick={() => settle(chosen, 'REJECTED')}>
                  {t('bi.pub.decide.reject')}
                </button>
              </div>
            </>
          )}
        </SectionCard>
        </div>
      )}
      {mayAsk ? (
        <SectionCard title={t('bi.pub.request.title')}>
        <form onSubmit={submit} noValidate aria-label={t('bi.pub.request.title')}>
          <p className="sub">{t('bi.pub.request.help')}</p>
          {askRefusal === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="request-refusal" data-reason={askRefusal.reason}>
              {refusalMessage(t, askRefusal.reason, askRefusal.detail)}
            </p>
          )}
          {asked ? (
            <p className="callout" role="status" data-testid="asked">
              {t('bi.pub.request.saved')}
            </p>
          ) : null}
          <Field id="pub-kind" label={t('bi.pub.request.kind')} error={undefined}>
            <select
              id="pub-kind"
              value={form.kind}
              onChange={(event) =>
                setForm({
                  ...form,
                  kind: event.target.value as RequestForm['kind'],
                })
              }
            >
              {KINDS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {kindLabel(t, candidate)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="pub-object" label={t('bi.pub.request.object')} error={problems.objectId === undefined ? undefined : requestProblemMessage(t, problems.objectId)}>
            <input id="pub-object" value={form.objectId} aria-invalid={problems.objectId !== undefined} onChange={(event) => setForm({ ...form, objectId: event.target.value })} />
          </Field>
          <div className="formfooter">
            <button type="submit" className="ui-button ui-button--primary" disabled={ask.isPending}>
              {t('bi.pub.request.submit')}
            </button>
          </div>
        </form>
        </SectionCard>
      ) : null}
      <p className="prototype-note">{t('bi.dash.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
