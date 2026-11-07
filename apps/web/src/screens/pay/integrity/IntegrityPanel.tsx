import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard, StatusPill } from '../../../ui';
import { useCheckIntegrity, useChecks, useDecideException, useRequestException } from './hooks';
import { ceilingLabel, codeLabel, codeMeaning, figureLabel, outcomeLabel, sourceLabel, statusLabel } from './labels';
import { EXCEPTION_CEILINGS, dayText, exceptionTone, figuresOf, isWholeAmount, outcomeTone, vnd } from './model';
import type { Checks, Exception, ExceptionCeiling, Finding, Run } from './model';
import './integrity.css';

type T = Translator['t'];
const ymd = (offsetDays: number): string => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const refusalText = (t: T, error: unknown): string => (error instanceof ApiError ? t('govd.integrity.error.refused', { code: error.code }) : t('govd.integrity.error.failed'));

function FindingItem({ finding, locale }: { finding: Finding; locale: string }) {
  const { t } = useTranslation();
  const figures = figuresOf(finding);
  const tone = finding.excused ? 'excused' : finding.kind === 'INVARIANT' ? 'block' : 'signal';
  return (
    <li className={`integrity-finding integrity-finding--${tone}`} data-finding={finding.code} data-kind={finding.kind}>
      <h4>
        <span>{codeLabel(t, finding.code)}</span>
        <StatusPill tone={finding.excused ? 'success' : finding.kind === 'INVARIANT' ? 'danger' : 'warning'}>{finding.excused ? t('govd.integrity.finding.excused') : finding.kind === 'INVARIANT' ? t('govd.integrity.finding.block') : t('govd.integrity.finding.signal')}</StatusPill>
      </h4>
      <p>{codeMeaning(t, finding.code)}</p>
      {typeof finding.subject.other_hidden === 'boolean' ? <p className="muted">{t('govd.integrity.finding.twinHidden')}</p> : null}
      {typeof finding.subject.other_request_id === 'string' ? (
        <p>
          <Link to={`/pay/pay-03?request=${encodeURIComponent(finding.subject.other_request_id)}`}>{t('govd.integrity.finding.twin')}</Link>
        </p>
      ) : null}
      {figures.length === 0 ? null : (
        <dl className="integrity-figures">
          {figures.map((figure) => (
            <div key={figure.key} style={{ display: 'contents' }}>
              <dt>{figureLabel(t, figure.key)}</dt>
              <dd data-figure={figure.key}>{figure.money ? vnd(figure.value, locale) : figure.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

function RuleLine({ run }: { run: Run }) {
  const { t } = useTranslation();
  return (
    <div className="integrity-rule" data-testid="rule">
      <p>{t(run.rule.source === 'RULE' ? 'govd.integrity.rule.approved' : 'govd.integrity.rule.default', { version: run.rule.version, day: dayText(run.asOf) })}</p>
      {run.rule.unverified ? (
        <p className="callout warning" role="status" data-testid="unverified">
          {t('govd.integrity.rule.unverified')}
        </p>
      ) : null}
      {run.rule.formula === '' ? null : <p className="muted" data-testid="formula">{t('govd.integrity.rule.formula', { formula: run.rule.formula })}</p>}
      {run.rule.origin === '' ? null : <p className="muted" data-testid="origin">{t('govd.integrity.rule.origin', { origin: run.rule.origin, day: dayText(run.rule.asOf) })}</p>}
    </div>
  );
}

function ExceptionRow({ exception, writable, mayDecide, locale }: { exception: Exception; writable: boolean; mayDecide: boolean; locale: string }) {
  const { t } = useTranslation();
  const decide = useDecideException();
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | undefined>(undefined);
  const canDecide = writable && mayDecide;
  const send = (move: 'approve' | 'reject' | 'revoke'): void => {
    if (move !== 'approve' && note.trim() === '') {
      setMessage(t('govd.integrity.exception.reasonNeeded'));
      return;
    }
    setMessage(undefined);
    decide.mutate({ id: exception.id, version: exception.version, move, text: note.trim() }, { onSuccess: () => setNote(''), onError: (error) => setMessage(refusalText(t, error)) });
  };
  return (
    <li className="integrity-finding integrity-finding--signal" data-exception={exception.id}>
      <h4>
        <span>{ceilingLabel(t, exception.ceiling)}</span>
        <StatusPill tone={exceptionTone(exception.status)}>{statusLabel(t, exception.status)}</StatusPill>
      </h4>
      <dl className="integrity-figures">
        <dt>{t('govd.integrity.exception.amount')}</dt>
        <dd data-figure="allowed">{vnd(exception.allowedAmountVnd, locale)}</dd>
        <dt>{t('govd.integrity.exception.validTo')}</dt>
        <dd>{dayText(exception.validTo)}</dd>
        <dt>{t('govd.integrity.exception.reason')}</dt>
        <dd>{exception.reason}</dd>
        {exception.decisionNote === null ? null : (
          <>
            <dt>{t('govd.integrity.exception.note')}</dt>
            <dd>{exception.decisionNote}</dd>
          </>
        )}
      </dl>
      {canDecide && (exception.status === 'REQUESTED' || exception.status === 'APPROVED') ? (
        <div className="integrity-form">
          <label>
            {exception.status === 'REQUESTED' ? t('govd.integrity.exception.note.optional') : t('govd.integrity.exception.note.required')}
            <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={2000} data-testid="decision-note" />
          </label>
          <div className="integrity-actions">
            {exception.status === 'REQUESTED' ? (
              <>
                <button type="button" className="ui-button ui-button--primary" disabled={decide.isPending} onClick={() => send('approve')} data-action="approve-exception">
                  {t('govd.integrity.exception.approve')}
                </button>
                <button type="button" className="ui-button ui-button--outline" disabled={decide.isPending} onClick={() => send('reject')} data-action="reject-exception">
                  {t('govd.integrity.exception.reject')}
                </button>
              </>
            ) : (
              <button type="button" className="ui-button ui-button--outline" disabled={decide.isPending} onClick={() => send('revoke')} data-action="revoke-exception">
                {t('govd.integrity.exception.revoke')}
              </button>
            )}
          </div>
          {message === undefined ? null : (
            <p className="callout integrity-error" role="alert" data-testid="exception-error">
              {message}
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

function ExceptionForm({ requestId, ceilings, onDone }: { requestId: string; ceilings: readonly ExceptionCeiling[]; onDone: () => void }) {
  const { t } = useTranslation();
  const ask = useRequestException();
  const [ceiling, setCeiling] = useState<ExceptionCeiling>(ceilings[0] ?? 'EXCEEDS_PLAN');
  const [amount, setAmount] = useState('');
  const [validTo, setValidTo] = useState(ymd(7));
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | undefined>(undefined);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!isWholeAmount(amount.trim())) return setMessage(t('govd.integrity.form.amountInvalid'));
    if (reason.trim() === '') return setMessage(t('govd.integrity.exception.reasonNeeded'));
    setMessage(undefined);
    ask.mutate({ requestId, body: { ceiling, allowed_amount_vnd: amount.trim(), valid_to: validTo, reason: reason.trim() } }, { onSuccess: onDone, onError: (error) => setMessage(refusalText(t, error)) });
  };
  return (
    <form className="integrity-form" onSubmit={submit} data-testid="exception-form" aria-label={t('govd.integrity.form.title')}>
      <h4>{t('govd.integrity.form.title')}</h4>
      <p className="muted">{t('govd.integrity.form.hint')}</p>
      <label>
        {t('govd.integrity.form.ceiling')}
        <select value={ceiling} onChange={(event) => setCeiling(event.target.value as ExceptionCeiling)} data-testid="ceiling">
          {ceilings.map((one) => (
            <option key={one} value={one}>
              {ceilingLabel(t, one)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('govd.integrity.form.amount')}
        <input inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} data-testid="amount" />
      </label>
      <label>
        {t('govd.integrity.form.validTo')}
        <input type="date" value={validTo} min={ymd(0)} onChange={(event) => setValidTo(event.target.value)} data-testid="valid-to" />
      </label>
      <label>
        {t('govd.integrity.form.reason')}
        <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={2000} data-testid="reason" />
      </label>
      {message === undefined ? null : (
        <p className="callout integrity-error" role="alert" data-testid="form-error">
          {message}
        </p>
      )}
      <div className="integrity-actions">
        <button type="submit" className="ui-button ui-button--primary" disabled={ask.isPending} data-action="ask-exception">
          {t('govd.integrity.form.submit')}
        </button>
        <button type="button" className="ui-button ui-button--outline" onClick={onDone}>
          {t('govd.integrity.form.cancel')}
        </button>
      </div>
    </form>
  );
}

function Body({ requestId, checks, canCheck, canAsk, canDecide, writable, locale }: { requestId: string; checks: Checks; canCheck: boolean; canAsk: boolean; canDecide: boolean; writable: boolean; locale: string }) {
  const { t } = useTranslation();
  const check = useCheckIntegrity();
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const run = checks.run;
  const draft = checks.requestStatus === 'DRAFT';
  const blocking = run?.findings.filter((finding) => finding.kind === 'INVARIANT') ?? [];
  const signals = run?.findings.filter((finding) => finding.kind === 'SIGNAL') ?? [];
  const live = checks.exceptions.filter((exception) => exception.status === 'REQUESTED' || exception.status === 'APPROVED');
  // An exception is asked for a ceiling that stands and that nobody has covered or asked a way past yet.
  const askable = EXCEPTION_CEILINGS.filter((ceiling) => blocking.some((finding) => finding.code === ceiling && !finding.excused) && !live.some((exception) => exception.ceiling === ceiling));
  return (
    <>
      {run === null ? (
        <p className="callout" role="status" data-testid="never-checked">
          {t('govd.integrity.never')}
        </p>
      ) : (
        <>
          <p data-testid="outcome-line">
            <StatusPill tone={outcomeTone(run.outcome)}>{outcomeLabel(t, run.outcome)}</StatusPill>{' '}
            <span>{t('govd.integrity.counts', { blocks: run.invariantCount, signals: run.signalCount, excused: run.excusedCount })}</span>{' '}
            <span className="muted">{t(run.trigger === 'SUBMIT' ? 'govd.integrity.trigger.submit' : 'govd.integrity.trigger.preview', { day: dayText(run.createdAt) })}</span>
          </p>
          <RuleLine run={run} />
          {run.unavailable.length === 0 ? null : (
            <p className="callout warning" role="status" data-testid="unavailable">
              {t('govd.integrity.unavailable', { sources: run.unavailable.map((source) => sourceLabel(t, source)).join(', ') })}
            </p>
          )}
          {run.outcome === 'PASSED' ? (
            <p className="callout" role="status" data-testid="passed">
              {t('govd.integrity.passed')}
            </p>
          ) : null}
          {blocking.length === 0 ? null : (
            <>
              <h3>{t('govd.integrity.group.block')}</h3>
              <ul className="integrity-group" data-testid="blocking">
                {blocking.map((finding) => (
                  <FindingItem key={finding.id} finding={finding} locale={locale} />
                ))}
              </ul>
            </>
          )}
          {signals.length === 0 ? null : (
            <>
              <h3>{t('govd.integrity.group.signal')}</h3>
              <ul className="integrity-group" data-testid="signals">
                {signals.map((finding) => (
                  <FindingItem key={finding.id} finding={finding} locale={locale} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {checks.exceptions.length === 0 ? null : (
        <>
          <h3>{t('govd.integrity.group.exceptions')}</h3>
          <ul className="integrity-group" data-testid="exceptions">
            {checks.exceptions.map((exception) => (
              <ExceptionRow key={exception.id} exception={exception} writable={writable} mayDecide={canDecide} locale={locale} />
            ))}
          </ul>
        </>
      )}
      {writable && draft && canCheck ? (
        <div className="integrity-actions">
          <button type="button" className="ui-button ui-button--outline" disabled={check.isPending} data-action="check-integrity" onClick={() => check.mutate({ requestId }, { onSuccess: () => setMessage(undefined), onError: (error) => setMessage(refusalText(t, error)) })}>
            {run === null ? t('govd.integrity.check') : t('govd.integrity.recheck')}
          </button>
          {canAsk && askable.length > 0 && !asking ? (
            <button type="button" className="ui-button ui-button--outline" onClick={() => setAsking(true)} data-action="open-exception-form">
              {t('govd.integrity.ask')}
            </button>
          ) : null}
        </div>
      ) : null}
      {message === undefined ? null : (
        <p className="callout integrity-error" role="alert" data-testid="check-error">
          {message}
        </p>
      )}
      {asking && askable.length > 0 ? <ExceptionForm requestId={requestId} ceilings={askable} onDone={() => setAsking(false)} /> : null}
    </>
  );
}

/**
 * The checks of a payment request, on PAY-03 (G4-2, G4-5): what the last run found for the approver, with the rule that decided (version, day, whether its numbers are confirmed, formula and source), what could not be read, and the
 * way past a ceiling (an exception, asked and decided by two people). A request that was never checked says so; one that is not there for the caller is not shown at all.
 */
export function IntegrityPanel({ requestId }: { requestId: string }) {
  const { t, locale } = useTranslation();
  const { mode, permissions } = useSession();
  const checks = useChecks(requestId);
  const state = useScreenState({ isLoading: checks.isLoading, error: checks.error, data: checks.data, isEmpty: (data) => data === null });
  // Permissions that the session does not know yet leave the buttons to the server, which refuses what the caller may not do.
  const may = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const run = checks.data?.run ?? null;
  return (
    <SectionCard title={t('govd.integrity.title')} unit={t('govd.integrity.unit')} status={run === null ? undefined : <StatusPill tone={outcomeTone(run.outcome)}>{outcomeLabel(t, run.outcome)}</StatusPill>}>
      <div data-testid="integrity-panel">
        <StateBoundary state={state} onRetry={() => void checks.refetch()}>
          {checks.data === null || checks.data === undefined ? null : (
            <Body requestId={requestId} checks={checks.data} canCheck={may('payment.integrity.check')} canAsk={may('disbursement.exception.request')} canDecide={may('disbursement.exception.approve')} writable={mode !== 'READ_ONLY'} locale={locale} />
          )}
        </StateBoundary>
      </div>
    </SectionCard>
  );
}
