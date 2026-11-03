import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useAcceptances } from '../acceptance/hooks';
import { useChain } from '../change/hooks';
import { problemMessage } from '../change/labels';
import { MAX_TEXT, chainLink, describeProblem, signedAmountText } from '../change/model';
import type { ChangeRequest } from '../change/model';
import { BackLink, Field } from '../components';
import { useContract, useContracts } from '../hooks';
import { DRAFT_PATH, amountText, draftLink } from '../model';
import type { ContractView } from '../model';
import { versionsLink } from '../revision/model';
import { vietnamToday } from '../workspace/model';
import { AdjustmentView } from './AdjustmentView';
import { useAdjustChange } from './hooks';
import { adjustProblemMessage, daysText } from './labels';
import { adjustBody, adjustable, delaySummary, emptyAdjustment, mismatchOf, reachable, reconciled, toggled, validateAdjustment } from './model';
import type { AdjustForm } from './model';
import '../ctr.css';

type AdjustMutation = ReturnType<typeof useAdjustChange>;

/**
 * CTR-14: the delays of a contract and the retroactive adjustment of its change orders (ST-CTR-016, CTR 3.3 step 6, BR-CTR-03). The summary reads what the change orders do to the completion day.
 * The adjustment approves an assessed change order that applies from a day before today: the person who had no part in its chain names the day, the document it rests on, the new lines of the
 * BOQ and the acceptances it re-prices; the server finds the acceptances itself and says which the list left out or named in vain. What was approved is not touched: the difference of each
 * balance becomes an entry of the ledger of PAY. The server judges it all again: the people, the document, the settlements that have read the ledger, the floor under the value, the delegation
 * limit and the capital. The pricing of the delays themselves (what a delay costs) waits for a rule the business has not given.
 */
export default function RetroactiveScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The contract, the change orders and the form belong to one membership: a switch of tenant or of membership starts the screen over.
  return <RetroactiveContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RetroactiveContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const contractId = search.get('id');
  const requestId = search.get('request');
  // The adjustment is sent and told here, not in the form: the board is read again when it is made, and the change order, now another version, leaves the form before the answer is reported
  // (a callback of a mutation of a component that is gone is not called).
  const adjust = useAdjustChange();
  const [done, setDone] = useState<string | undefined>(undefined);
  const contract = useContract(contractId);
  const chain = useChain(contract.data?.projectId, contractId);
  const state = useScreenState({
    isLoading: contract.isLoading || chain.isLoading,
    error: contract.error ?? chain.error,
    data: contractId === null ? null : contract.data === undefined ? undefined : contract.data === null ? null : chain.data,
    isEmpty: (data) => data === null,
  });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={contractId === null ? DRAFT_PATH : draftLink(contractId)}>{t('ctr.retro.back.link')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctr.retro.title')}</h1>
          <p>{t('ctr.retro.subtitle')}</p>
        </div>
      </div>
      {contractId === null ? (
        <ContractPicker onPick={(id) => setSearch({ id })} />
      ) : (
        <StateBoundary
          state={state}
          onRetry={() => {
            void contract.refetch();
            void chain.refetch();
          }}
        >
          {contract.data === null || contract.data === undefined || chain.data === null || chain.data === undefined ? null : (
            <Content
              contract={contract.data}
              requests={chain.data.requests}
              locale={locale}
              readOnly={mode === 'READ_ONLY'}
              selected={requestId}
              onSelect={(id) => setSearch({ id: contractId, request: id })}
              done={done}
              adjust={adjust}
              onSend={(request, body) => adjust.mutate({ id: request.id, version: request.version, body }, { onSuccess: () => setDone(request.code ?? request.id) })}
            />
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('ctr.retro.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The contract whose delays are read: a screen opened without one asks for it. */
function ContractPicker({ onPick }: { onPick(contractId: string): void }) {
  const { t } = useTranslation();
  const contracts = useContracts();
  const state = useScreenState({ isLoading: contracts.isLoading, error: contracts.error, data: contracts.data });
  return (
    <StateBoundary state={state} onRetry={() => void contracts.refetch()}>
      <article className="card" aria-label={t('ctr.retro.pick.title')}>
        <h2>{t('ctr.retro.pick.title')}</h2>
        <div className="field" data-field="retro-contract">
          <label htmlFor="retro-contract">{t('ctr.retro.pick.label')}</label>
          <select id="retro-contract" value="" onChange={(event) => (event.target.value === '' ? undefined : onPick(event.target.value))}>
            <option value="">{t('ctr.retro.pick.choose')}</option>
            {(contracts.data ?? []).map((contract) => (
              <option key={contract.id} value={contract.id}>
                {`${contract.code} · ${contract.title ?? contract.projectName}`}
              </option>
            ))}
          </select>
        </div>
      </article>
    </StateBoundary>
  );
}

interface ContentProps {
  contract: ContractView;
  requests: ChangeRequest[];
  locale: string;
  readOnly: boolean;
  selected: string | null;
  onSelect(requestId: string): void;
  done: string | undefined;
  adjust: AdjustMutation;
  onSend(request: ChangeRequest, body: ReturnType<typeof adjustBody>): void;
}

function Content({ contract, requests, locale, readOnly, selected, onSelect, done, adjust, onSend }: ContentProps) {
  const { t } = useTranslation();
  const candidates = adjustable(requests, contract.id);
  const request = candidates.find((candidate) => candidate.id === selected) ?? candidates[0];
  return (
    <>
      <Delays contract={contract} requests={requests} />
      <article className="card" aria-label={t('ctr.retro.adjust.title')}>
        <h2>{t('ctr.retro.adjust.title')}</h2>
        {done === undefined ? null : (
          <p className="callout" role="status" data-testid="done">
            {t('ctr.retro.done.notice', { code: done })}{' '}
            <Link to={versionsLink(contract.id)} data-testid="versions-link">
              {t('ctr.retro.versions.link')}
            </Link>
          </p>
        )}
        {request === undefined ? (
          done === undefined ? (
            <p className="callout" role="status" data-testid="no-command">
              {readOnly ? t('ctr.retro.readOnly.notice') : t('ctr.retro.none.notice')}
            </p>
          ) : null
        ) : readOnly ? (
          <p className="callout" role="status" data-testid="no-command">
            {t('ctr.retro.readOnly.notice')}
          </p>
        ) : (
          <>
            {candidates.length > 1 ? (
              <div className="field" data-field="retro-request">
                <label htmlFor="retro-request">{t('ctr.retro.adjust.request')}</label>
                <select id="retro-request" value={request.id} onChange={(event) => onSelect(event.target.value)}>
                  {candidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.code ?? candidate.id}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <AdjustFormView key={`${request.id}:${request.version}`} request={request} contract={contract} locale={locale} adjust={adjust} onSend={onSend} />
          </>
        )}
      </article>
      <History contract={contract} locale={locale} />
    </>
  );
}

/** What the change orders of the contract do to its schedule, beside the completion day it carries. */
function Delays({ contract, requests }: { contract: ContractView; requests: ChangeRequest[] }) {
  const { t } = useTranslation();
  const summary = delaySummary(requests, contract.id, contract.completionDue);
  return (
    <article className="card" aria-label={t('ctr.retro.delay.title')}>
      <h2>{t('ctr.retro.delay.title')}</h2>
      <p>
        <strong data-testid="contract-code">{contract.code}</strong> · {contract.title ?? contract.projectName} ·{' '}
        <Link to={chainLink(contract.projectId, contract.id)} data-testid="board-link">
          {t('ctr.retro.delay.board.link')}
        </Link>
      </p>
      <dl className="ctr-facts" data-testid="delay-facts">
        <dt>{t('ctr.retro.delay.planned')}</dt>
        <dd data-testid="planned-due">{summary.plannedDue ?? t('ctr.retro.none.text')}</dd>
        <dt>{t('ctr.retro.delay.approved')}</dt>
        <dd data-testid="approved-days">{daysText(t, summary.approvedDays)}</dd>
        <dt>{t('ctr.retro.delay.forecast')}</dt>
        <dd data-testid="forecast-due">{summary.forecastDue ?? t('ctr.retro.none.text')}</dd>
        <dt>{t('ctr.retro.delay.waiting')}</dt>
        <dd data-testid="waiting-days">{daysText(t, summary.waitingDays)}</dd>
      </dl>
      {summary.lines.length === 0 ? (
        <p className="sub" data-testid="delay-none">
          {t('ctr.retro.delay.none')}
        </p>
      ) : (
        <ul data-testid="delay-lines">
          {summary.lines.map((line) => (
            <li key={line.id} data-request={line.id} data-status={line.status}>
              {line.status === 'APPROVED' ? t('ctr.retro.delay.line.approved', { code: line.code ?? line.id, days: daysText(t, line.days) }) : t('ctr.retro.delay.line.waiting', { code: line.code ?? line.id, days: daysText(t, line.days) })}
              {line.retroactive ? ` · ${t('ctr.retro.delay.line.retroactive')}` : ''}
            </li>
          ))}
        </ul>
      )}
      <p className="sub">{t('ctr.retro.delay.note')}</p>
    </article>
  );
}

/** The adjustments already made on the contract. */
function History({ contract, locale }: { contract: ContractView; locale: string }) {
  const { t } = useTranslation();
  if (contract.retroactiveAdjustments.length === 0) return null;
  return (
    <article className="card" aria-label={t('ctr.retro.history.title')}>
      <h2>{t('ctr.retro.history.title')}</h2>
      <ol className="ctr-timeline" data-testid="history">
        {contract.retroactiveAdjustments.map((record) => (
          <li key={record.id} data-adjustment-item={record.id}>
            <h3>{record.changeRequestCode ?? record.changeRequestId}</h3>
            <AdjustmentView record={record} locale={locale} />
          </li>
        ))}
      </ol>
    </article>
  );
}

interface FormProps {
  request: ChangeRequest;
  contract: ContractView;
  locale: string;
  adjust: AdjustMutation;
  onSend(request: ChangeRequest, body: ReturnType<typeof adjustBody>): void;
}

function AdjustFormView({ request, contract, locale, adjust, onSend }: FormProps) {
  const { t } = useTranslation();
  const acceptances = useAcceptances(contract.id);
  const today = vietnamToday(new Date());
  const [form, setForm] = useState<AdjustForm>(emptyAdjustment(request.detail?.evaluatedDeltaVnd ?? null));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateAdjustment(form, today);
  const error = (field: keyof AdjustForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? adjustProblemMessage(t, problem) : undefined;
  };
  const set = (patch: Partial<AdjustForm>): void => setForm({ ...form, ...patch });
  const choices = reachable(acceptances.data ?? [], form.effectiveOn);
  const mismatch = mismatchOf(adjust.error);
  const names = new Map((acceptances.data ?? []).map((acceptance) => [acceptance.id, acceptance.acceptanceNo]));
  const nameOf = (id: string): string => names.get(id) ?? id;
  const delta = signedAmountText(request.detail?.evaluatedDeltaVnd ?? null, locale);

  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (adjust.isPending || Object.keys(problems).length > 0) return;
    onSend(request, adjustBody(form));
  };

  return (
    <form onSubmit={send} noValidate>
      <p>
        <strong data-testid="request-code">{request.code ?? request.id}</strong>
        {delta === null ? null : <span data-testid="request-delta"> · {t('ctr.value.amount', { amount: delta })}</span>}
      </p>
      {adjust.isError ? (
        <p className="callout warning" role="alert" data-testid="refusal">
          {problemMessage(t, describeProblem(adjust.error))}
        </p>
      ) : null}
      {mismatch === undefined ? null : (
        <div className="callout warning" role="alert" data-testid="mismatch">
          {mismatch.missing.length === 0 ? null : (
            <p data-testid="mismatch-missing">{t('ctr.retro.mismatch.missing', { list: mismatch.missing.map(nameOf).join(', ') })}</p>
          )}
          {mismatch.unexpected.length === 0 ? null : (
            <p data-testid="mismatch-unexpected">{t('ctr.retro.mismatch.unexpected', { list: mismatch.unexpected.map(nameOf).join(', ') })}</p>
          )}
          <button type="button" data-testid="mismatch-apply" onClick={() => set({ affected: reconciled(form.affected, mismatch) })}>
            {t('ctr.retro.mismatch.apply')}
          </button>
        </div>
      )}
      <div className="formgrid">
        <Field id="retro-day" label={t('ctr.retro.field.day')} error={error('effectiveOn')} hint={t('ctr.retro.field.day.hint')}>
          <input id="retro-day" type="date" max={today} value={form.effectiveOn} onChange={(event) => set({ effectiveOn: event.target.value })} />
        </Field>
        <Field id="retro-document" label={t('ctr.retro.field.document')} error={error('documentVersionId')} hint={t('ctr.retro.field.document.hint')}>
          <input id="retro-document" autoComplete="off" value={form.documentVersionId} onChange={(event) => set({ documentVersionId: event.target.value })} />
        </Field>
        <Field id="retro-delta" label={t('ctr.retro.field.delta')} error={error('approvedDeltaVnd')} hint={t('ctr.retro.field.delta.hint')}>
          <input id="retro-delta" inputMode="numeric" autoComplete="off" value={form.approvedDeltaVnd} onChange={(event) => set({ approvedDeltaVnd: event.target.value })} />
        </Field>
        <Field id="retro-lines" label={t('ctr.retro.field.lines')} error={error('boqLines')} hint={t('ctr.retro.field.lines.hint')}>
          <textarea id="retro-lines" rows={4} spellCheck={false} value={form.boqLines} onChange={(event) => set({ boqLines: event.target.value })} />
        </Field>
      </div>
      <Field id="retro-basis" label={t('ctr.retro.field.basis')} error={error('basis')}>
        <textarea id="retro-basis" rows={3} maxLength={MAX_TEXT} value={form.basis} onChange={(event) => set({ basis: event.target.value })} />
      </Field>
      <fieldset className="field" data-field="retro-affected">
        <legend>{t('ctr.retro.field.affected')}</legend>
        <small className="sub">{t('ctr.retro.field.affected.hint')}</small>
        {choices.length === 0 ? (
          <p className="sub" data-testid="affected-none">
            {t('ctr.retro.field.affected.none')}
          </p>
        ) : (
          <ul data-testid="affected-choices">
            {choices.map((acceptance) => (
              <li key={acceptance.id}>
                <label>
                  <input type="checkbox" data-acceptance={acceptance.id} checked={form.affected.includes(acceptance.id)} onChange={() => set({ affected: toggled(form.affected, acceptance.id) })} />{' '}
                  {t('ctr.retro.field.affected.option', { no: acceptance.acceptanceNo, day: acceptance.acceptedOn, amount: amountText(acceptance.amountVnd, locale) })}
                </label>
              </li>
            ))}
          </ul>
        )}
        {error('affected') === undefined ? null : (
          <small role="alert" className="field-error">
            {error('affected')}
          </small>
        )}
      </fieldset>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={adjust.isPending}>
          {adjust.isPending ? t('ctr.change.dialog.pending') : t('ctr.retro.submit')}
        </button>
      </div>
    </form>
  );
}
