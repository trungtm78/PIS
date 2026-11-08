import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { hasMessage, useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, SectionCard, StatusPill } from '../../../ui';
import { useAdopt, useNotify, usePropose, useRatingProposals, useRespond, useWithdraw } from './rating-hooks';
import { RATING_CRITERIA, RATING_KINDS, RATING_PROPOSE_PERMISSION, RATING_READ_PERMISSION, RESPONSE_KINDS, clockTone, emptyProposal, missingCriteria, overridesBody, proposalBody, proposalProblem, responseBody, responseProblem, stateTone } from './rating-model';
import type { OverrideForm, ProposalView, ResponseForm, ResponseKind } from './rating-model';
import { camel, dateText } from './model';
import './analytics.css';

type Dialog = { kind: 'notify' | 'respond' | 'adopt' | 'withdraw'; proposal: ProposalView };

const todayText = (): string => new Date().toISOString().slice(0, 10);

/** The refusal of the server in words: the code has a text of its own, any other is said generally. */
function refusalText(t: ReturnType<typeof useTranslation>['t'], error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === undefined) return t('ca3.rating.error.generic');
  return hasMessage(`ca3.rating.error.${camel(code)}`) ? t(`ca3.rating.error.${camel(code)}`) : t('ca3.rating.error.generic');
}

/**
 * CTR-37: the proposals of a rating of the performance of a contractor (CA-3, in the manner of the CPARS): the score proposed from the data with what each criterion was made of (a criterion with no data has no score and
 * says why, never zero), the window the contractor has to answer with its clock, the answer, and the steps: a second person tells the contractor, the contractor answers, a person other than the proposer adopts the
 * proposal into the evaluation of CTR-23. The server judges every step again.
 */
export default function RatingScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <RatingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RatingContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const contractId = search.get('contract') ?? undefined;
  const canRead = permissions === undefined || permissions.includes(RATING_READ_PERMISSION);
  const canPropose = (permissions === undefined || permissions.includes(RATING_PROPOSE_PERMISSION)) && mode !== 'READ_ONLY';
  const proposals = useRatingProposals(contractId, canRead);
  const state = useScreenState({ isLoading: proposals.isLoading, error: proposals.error, data: proposals.data, isEmpty: () => false });
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const writable = mode !== 'READ_ONLY';
  const items = proposals.data ?? [];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ca3.rating.title')}</h1>
          <p>{t('ca3.rating.subtitle')}</p>
        </div>
        <Link className="ui-button ui-button--outline" to="/ctr/ctr-28?report=performance-rating">
          {t('ca3.rating.back')}
        </Link>
      </div>
      <StateBoundary state={!canRead ? 'denied' : state} onRetry={() => void proposals.refetch()}>
        {contractId !== undefined ? (
          <p className="callout ca1-notice" role="status" data-testid="contract-filter">
            {t('ca3.rating.contractOnly')}{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setSearch({})}>
              {t('ca3.rating.showAll')}
            </button>
          </p>
        ) : null}
        {canPropose && contractId !== undefined ? <ProposeForm contractId={contractId} /> : null}
        {items.length === 0 ? (
          <p className="callout" role="status" data-testid="no-proposals">
            {t('ca3.rating.empty')}
          </p>
        ) : (
          <ul className="ca3-proposals" data-testid="proposals">
            {items.map((proposal) => (
              <li key={proposal.id} data-proposal-id={proposal.id} data-state={proposal.state}>
                <ProposalCard proposal={proposal} writable={writable} locale={locale} onStep={(kind) => setDialog({ kind, proposal })} />
              </li>
            ))}
          </ul>
        )}
      </StateBoundary>
      {dialog === undefined ? null : <StepDialog key={`${dialog.kind}:${dialog.proposal.id}`} dialog={dialog} onClose={() => setDialog(undefined)} />}
      <p className="prototype-note">{t('ctr.list.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function ProposeForm({ contractId }: { contractId: string }) {
  const { t } = useTranslation();
  const propose = usePropose();
  const [form, setForm] = useState(emptyProposal);
  const [submitted, setSubmitted] = useState(false);
  const problem = proposalProblem(form);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (propose.isPending || problem !== undefined) return;
    propose.mutate({ contractId, body: proposalBody(form) }, { onSuccess: () => setForm(emptyProposal()) });
  };
  return (
    <SectionCard title={t('ca3.rating.propose.title')}>
      <form className="ca1-filters" onSubmit={send} aria-label={t('ca3.rating.propose.title')} data-testid="propose-form">
        <div className="field">
          <label htmlFor="rating-period">{t('ca3.rating.propose.period')}</label>
          <input id="rating-period" value={form.periodLabel} maxLength={40} aria-invalid={submitted && problem !== undefined} onChange={(event) => setForm({ ...form, periodLabel: event.target.value })} />
          {submitted && problem !== undefined ? (
            <span className="field-error" role="alert">
              {t('ca3.rating.propose.periodRequired')}
            </span>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="rating-kind">{t('ca3.rating.propose.kind')}</label>
          <select id="rating-kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
            <option value="">{t('ca3.rating.propose.kindAuto')}</option>
            {RATING_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`ca3.rating.kind.${camel(kind)}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rating-note">{t('ca3.rating.propose.note')}</label>
          <input id="rating-note" value={form.note} maxLength={2000} onChange={(event) => setForm({ ...form, note: event.target.value })} />
        </div>
        <button type="submit" className="ui-button" disabled={propose.isPending}>
          {t('ca3.rating.propose.submit')}
        </button>
      </form>
      {propose.isError ? (
        <p className="callout warning" role="alert" data-testid="propose-error">
          {refusalText(t, propose.error)}
        </p>
      ) : null}
    </SectionCard>
  );
}

function ProposalCard({ proposal, writable, locale, onStep }: { proposal: ProposalView; writable: boolean; locale: string; onStep: (kind: Dialog['kind']) => void }) {
  const { t } = useTranslation();
  const score = (value: string): string => (locale === 'vi' ? value.replace('.', ',') : value);
  return (
    <SectionCard title={`${proposal.contractCode} · ${proposal.periodLabel} · ${t(`ca3.rating.kind.${camel(proposal.kind)}`)}`}>
      <p className="ca3-badges">
        <StatusPill tone={stateTone(proposal.state)}>{t(`ca3.rating.state.${camel(proposal.state)}`)}</StatusPill>{' '}
        {proposal.rating === null ? (
          <span className="ca1-na" data-testid="no-overall">
            {t('ca3.rating.noOverall')}
          </span>
        ) : (
          <StatusPill tone={proposal.rating === 'POOR' ? 'danger' : proposal.rating === 'FAIR' ? 'warning' : 'success'}>{t(`ca3.rating.level.${camel(proposal.rating)}`)}</StatusPill>
        )}{' '}
        {proposal.overallScore === null ? null : <strong data-testid="overall">{score(proposal.overallScore)}</strong>}{' '}
        {proposal.clock === null ? null : <StatusPill tone={clockTone(proposal.clock.status)}>{t(`ca3.rating.clock.${camel(proposal.clock.status)}`)}</StatusPill>}
      </p>
      {proposal.clock === null ? null : (
        <p className="sub" data-testid="clock">
          {t('ca3.rating.responseDue', { day: dateText(proposal.clock.dueAt) })}
          {proposal.clock.basis === 'CALENDAR_UNAVAILABLE' ? ` · ${t('ca3.rating.calendarUnavailable')}` : ''}
        </p>
      )}
      <table className="ca3-criteria" aria-label={t('ca3.rating.criteria.aria')}>
        <thead>
          <tr>
            <th scope="col">{t('ca3.rating.criteria.criterion')}</th>
            <th scope="col">{t('ca3.rating.criteria.score')}</th>
            <th scope="col">{t('ca3.rating.criteria.basis')}</th>
          </tr>
        </thead>
        <tbody>
          {RATING_CRITERIA.map((criterion) => {
            const found = proposal.criteria[criterion];
            return (
              <tr key={criterion} data-criterion={criterion}>
                <th scope="row">{t(`ca3.rating.criterion.${camel(criterion)}`)}</th>
                <td>{found?.score === null || found === undefined ? '—' : String(found.score)}</td>
                <td>
                  {found?.score === null || found === undefined ? (
                    <span className="ca1-na" data-testid="criterion-reason">
                      {hasMessage(`ca1.na.${camel(found?.reason ?? 'noRows')}`) ? t(`ca1.na.${camel(found?.reason ?? 'noRows')}`) : (found?.reason ?? '')}
                    </span>
                  ) : (
                    Object.entries(found.readings)
                      .map(([name, value]) => `${t(`ca3.rating.reading.${camel(name)}`)}: ${String(value)}`)
                      .join(' · ')
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="sub">
        {t('ca3.rating.rule', { version: proposal.rule.version, source: proposal.rule.source === 'RULE' ? t('ca3.rating.ruleSource.rule') : t('ca3.rating.ruleSource.default') })} · {t('ca3.rating.covered', { count: proposal.covered })} · {t('ca3.rating.unverified')}
      </p>
      {proposal.response === null ? null : (
        <p className="callout" data-testid="response">
          {t(`ca3.rating.response.${camel(proposal.response.kind)}`)} · {dateText(proposal.response.receivedOn)}
          {proposal.response.text === null ? '' : ` · ${proposal.response.text}`}
        </p>
      )}
      {proposal.adopted === null ? null : (
        <p className="callout" data-testid="adopted">
          {t('ca3.rating.adopted')} <Link to="/ctr/ctr-23">{t('ca3.related.ctr23')}</Link>
        </p>
      )}
      {writable ? (
        <div className="ctr-row-actions">
          {proposal.allowed.notify ? (
            <button type="button" className="ui-button ui-button--small" data-notify onClick={() => onStep('notify')}>
              {t('ca3.rating.step.notify')}
            </button>
          ) : null}
          {proposal.allowed.respond ? (
            <button type="button" className="ui-button ui-button--small" data-respond onClick={() => onStep('respond')}>
              {t('ca3.rating.step.respond')}
            </button>
          ) : null}
          {proposal.allowed.adopt ? (
            <button type="button" className="ui-button ui-button--small" data-adopt onClick={() => onStep('adopt')}>
              {t('ca3.rating.step.adopt')}
            </button>
          ) : null}
          {proposal.allowed.withdraw ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-withdraw onClick={() => onStep('withdraw')}>
              {t('ca3.rating.step.withdraw')}
            </button>
          ) : null}
        </div>
      ) : null}
    </SectionCard>
  );
}

function StepDialog({ dialog, onClose }: { dialog: Dialog; onClose: () => void }) {
  const { t } = useTranslation();
  const { proposal } = dialog;
  const notify = useNotify();
  const respond = useRespond();
  const adopt = useAdopt();
  const withdraw = useWithdraw();
  const [answer, setAnswer] = useState<ResponseForm>({ kind: 'ACCEPT', receivedOn: todayText() });
  const [overrides, setOverrides] = useState<Record<string, OverrideForm>>({});
  const [text, setText] = useState('');
  const mutation = dialog.kind === 'notify' ? notify : dialog.kind === 'respond' ? respond : dialog.kind === 'adopt' ? adopt : withdraw;
  const missing = dialog.kind === 'adopt' ? missingCriteria(proposal) : [];
  const filled = overridesBody(overrides);
  const answerProblem = dialog.kind === 'respond' ? responseProblem(answer, text, todayText()) : undefined;
  const context = [
    { label: t('ca3.rating.dialog.contract'), value: proposal.contractCode },
    { label: t('ca3.rating.dialog.period'), value: proposal.periodLabel },
  ];
  const confirm = (reason?: string): void => {
    const note = reason?.trim() ?? '';
    setText(note);
    if (dialog.kind === 'withdraw') withdraw.mutate({ id: proposal.id, version: proposal.version, body: { reason: note } }, { onSuccess: onClose });
    else if (dialog.kind === 'notify') notify.mutate({ id: proposal.id, version: proposal.version, body: note === '' ? {} : { note } }, { onSuccess: onClose });
    else if (dialog.kind === 'respond') {
      if (responseProblem(answer, note, todayText()) !== undefined) return;
      respond.mutate({ id: proposal.id, version: proposal.version, body: responseBody(answer, note) }, { onSuccess: onClose });
    } else {
      if (filled.problem !== undefined || missing.some((criterion) => filled.body[criterion] === undefined)) return;
      adopt.mutate({ id: proposal.id, version: proposal.version, body: { ...(note === '' ? {} : { note }), ...(Object.keys(filled.body).length === 0 ? {} : { overrides: filled.body }) } }, { onSuccess: onClose });
    }
  };
  const reason =
    dialog.kind === 'withdraw'
      ? { label: t('ca3.rating.dialog.reason'), required: true, minLength: 10, hint: t('ca3.rating.dialog.reasonHint') }
      : dialog.kind === 'respond'
        ? { label: t('ca3.rating.dialog.responseText'), required: answer.kind === 'DISPUTE', ...(answer.kind === 'DISPUTE' ? { minLength: 20, hint: t('ca3.rating.dialog.disputeHint') } : {}) }
        : { label: t('ca3.rating.dialog.note'), required: false };
  return (
    <ConfirmDialog
      open
      title={t(`ca3.rating.dialog.${dialog.kind}`)}
      context={context}
      confirmLabel={t(`ca3.rating.step.${dialog.kind}`)}
      cancelLabel={t('ca3.rating.dialog.cancel')}
      onConfirm={confirm}
      onCancel={onClose}
      pending={mutation.isPending}
      reason={reason}
      {...(mutation.isError ? { error: refusalText(t, mutation.error) as string } : {})}
    >
      {dialog.kind === 'notify' ? <p className="sub">{t('ca3.rating.dialog.notifyEffect')}</p> : null}
      {dialog.kind === 'respond' ? (
        <>
          <div className="field">
            <label htmlFor="answer-kind">{t('ca3.rating.dialog.responseKind')}</label>
            <select id="answer-kind" value={answer.kind} onChange={(event) => setAnswer({ ...answer, kind: event.target.value as ResponseKind })}>
              {RESPONSE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`ca3.rating.response.${camel(kind)}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="answer-day">{t('ca3.rating.dialog.receivedOn')}</label>
            <input id="answer-day" type="date" max={todayText()} value={answer.receivedOn} aria-invalid={answerProblem === 'day'} onChange={(event) => setAnswer({ ...answer, receivedOn: event.target.value })} />
          </div>
        </>
      ) : null}
      {dialog.kind === 'adopt' && missing.length > 0 ? (
        <fieldset className="ca3-overrides" data-testid="overrides">
          <legend>{t('ca3.rating.dialog.overrides')}</legend>
          {missing.map((criterion) => (
            <div key={criterion} className="field" data-override={criterion}>
              <label htmlFor={`score-${criterion}`}>{t(`ca3.rating.criterion.${camel(criterion)}`)}</label>
              <input id={`score-${criterion}`} inputMode="numeric" value={overrides[criterion]?.score ?? ''} placeholder={t('ca3.rating.dialog.overrideScore')} onChange={(event) => setOverrides({ ...overrides, [criterion]: { score: event.target.value, reason: overrides[criterion]?.reason ?? '' } })} />
              <input id={`reason-${criterion}`} aria-label={t('ca3.rating.dialog.overrideReason')} value={overrides[criterion]?.reason ?? ''} placeholder={t('ca3.rating.dialog.overrideReason')} onChange={(event) => setOverrides({ ...overrides, [criterion]: { score: overrides[criterion]?.score ?? '', reason: event.target.value } })} />
            </div>
          ))}
        </fieldset>
      ) : null}
    </ConfirmDialog>
  );
}
