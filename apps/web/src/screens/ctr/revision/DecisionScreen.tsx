import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useBoqLines } from '../boq-hooks';
import { boqLink } from '../boq-model';
import { ChangeBadge } from '../change/components';
import { useChain } from '../change/hooks';
import { problemMessage, stageLabel } from '../change/labels';
import { MAX_TEXT, chainLink, describeProblem, requestLink, signedAmountText } from '../change/model';
import type { ChangeRequest } from '../change/model';
import { BackLink, Field } from '../components';
import { useContract } from '../hooks';
import { amountText } from '../model';
import type { ContractView } from '../model';
import { vietnamToday } from '../workspace/model';
import { useDecideChange } from './hooks';

type DecideMutation = ReturnType<typeof useDecideChange>;
import { decisionLabel, decisionProblemMessage, decisionSubmitLabel, lineChangeLabel } from './labels';
import { DECISIONS, decisionBody, diffLines, emptyDecision, validateDecision, versionsLink } from './model';
import type { Decision, DecisionBody, DecisionForm, LineDiff } from './model';
import '../ctr.css';
import { SectionCard } from '../../../ui';

/**
 * CTR-08: compare a change order with the contract and decide it (ST-CTR-007, CTR 3.3 step 4). The screen sets what the change does to the value and the schedule beside what the contract
 * has now, and once the change order is approved, the BOQ of the revision it made beside the BOQ it follows. The person who may decide it (not one who had a part in its chain) approves it
 * on a decision document, from a day that is not before today, with the amount and the lines of the new BOQ; or gives it back to be assessed again, or rejects it, with the reason. The server
 * judges the decision again: the people, the document, the day, the floor under the value, the delegation limit and the capital.
 */
export default function DecisionScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The change order and the form belong to one membership: a switch of tenant or of membership starts the screen over.
  return <DecisionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DecisionContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { mode } = useSession();
  const [search] = useSearchParams();
  const projectId = search.get('project');
  const requestId = search.get('request');
  // The decision is sent and told here, not in the form: the board is read again when it is made, and the change order, now another version, mounts its form afresh before the answer is
  // reported (a callback of a mutation of a component that is gone is not called).
  const decide = useDecideChange();
  const [done, setDone] = useState<Decision | undefined>(undefined);
  const send = (request: ChangeRequest, body: DecisionBody): void => {
    const chosen = body.decision;
    decide.mutate({ id: request.id, version: request.version, body }, { onSuccess: () => setDone(chosen) });
  };
  const chain = useChain(projectId);
  const request = chain.data?.requests.find((candidate) => candidate.id === requestId);
  const contract = useContract(request?.contract.id);
  const state = useScreenState({
    isLoading: chain.isLoading || contract.isLoading,
    error: chain.error ?? contract.error,
    data: projectId === null || requestId === null ? null : chain.data === undefined ? undefined : request === undefined ? null : (contract.data ?? undefined),
    isEmpty: (data) => data === null,
  });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={requestLink()}>{t('ctr.change.request.title')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctr.revision.decision.title')}</h1>
          <p>{t('ctr.revision.decision.subtitle')}</p>
        </div>
      </div>
      {projectId === null || requestId === null ? (
        <p className="callout" role="status" data-testid="no-request">
          {t('ctr.revision.decision.none.notice')}
        </p>
      ) : (
        <StateBoundary
          state={state}
          onRetry={() => {
            void chain.refetch();
            void contract.refetch();
          }}
        >
          {request === undefined || contract.data === null || contract.data === undefined ? null : <Decision key={`${request.id}:${request.version}`} request={request} contract={contract.data} locale={locale} readOnly={mode === 'READ_ONLY'} done={done} decide={decide} onSend={send} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('ctr.revision.decision.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface DecisionProps {
  request: ChangeRequest;
  contract: ContractView;
  locale: string;
  readOnly: boolean;
  done: Decision | undefined;
  decide: DecideMutation;
  onSend(request: ChangeRequest, body: DecisionBody): void;
}

function Decision({ request, contract, locale, readOnly, done, decide, onSend }: DecisionProps) {
  const { t } = useTranslation();
  const may = !readOnly && request.actions?.decide === true;
  return (
    <div className="ctr-grid">
      <div>
        <Compare request={request} contract={contract} locale={locale} />
        {request.resultingRevisionId === null ? null : <Lines request={request} contract={contract} locale={locale} />}
      </div>
      <SectionCard title={t('ctr.revision.form.title')}>
        {done === undefined ? null : (
          <p className="callout" role="status" data-testid="done">
            {t('ctr.revision.done.notice', { decision: decisionLabel(t, done) })}
          </p>
        )}
        {request.status === 'APPROVED' && request.resultingRevisionId !== null ? (
          <p>
            <Link to={boqLink(contract.id, request.resultingRevisionId)} data-testid="boq-link">
              {t('ctr.revision.boq.link')}
            </Link>{' '}
            ·{' '}
            <Link to={versionsLink(contract.id)} data-testid="versions-link">
              {t('ctr.revision.versions.link')}
            </Link>
          </p>
        ) : null}
        {may ? (
          <DecisionFormView request={request} decide={decide} onSend={onSend} />
        ) : done === undefined ? (
          <p className="callout" role="status" data-testid="no-command">
            {readOnly ? t('ctr.revision.readOnly.notice') : request.status === 'EVALUATED' ? t('ctr.revision.noCommand.notice') : t('ctr.revision.notEvaluated.notice')}
          </p>
        ) : null}
      </SectionCard>
    </div>
  );
}

/** What the change does to the contract, beside what the contract has now. */
function Compare({ request, contract, locale }: { request: ChangeRequest; contract: ContractView; locale: string }) {
  const { t } = useTranslation();
  const { detail } = request;
  const delta = request.status === 'APPROVED' ? (detail?.approvedDeltaVnd ?? null) : (detail?.evaluatedDeltaVnd ?? detail?.estimatedDeltaVnd ?? null);
  const now = contract.contractValueVnd;
  const funding = detail?.fundingImpactNote ?? null;
  const scope = detail?.scopeImpactNote ?? null;
  const after = delta !== null && /^-?\d+$/.test(delta) && /^\d+$/.test(now) ? (BigInt(now) + BigInt(delta)).toString() : null;
  const money = (value: string | null): string => {
    const shown = signedAmountText(value, locale);
    return shown === null ? t('ctr.revision.none.text') : t('ctr.value.amount', { amount: shown });
  };
  return (
    <SectionCard title={t('ctr.revision.compare.title')}>
      <p>
        <strong data-testid="request-code">{request.code ?? request.id}</strong> · {stageLabel(t, request.stage)} <ChangeBadge status={request.status} /> ·{' '}
        <Link to={versionsLink(contract.id)}>{contract.code}</Link>
      </p>
      <p>
        <Link to={chainLink(request.projectId)} data-testid="board-link">
          {t('ctr.revision.back.board.link')}
        </Link>
      </p>
      {detail === undefined ? null : <p data-testid="request-reason">{detail.reason}</p>}
      <table className="table" data-testid="compare">
        <thead>
          <tr>
            <th scope="col">{t('ctr.revision.compare.item')}</th>
            <th scope="col" className="ctr-amount">
              {t('ctr.revision.compare.now')}
            </th>
            <th scope="col" className="ctr-amount">
              {t('ctr.revision.compare.after')}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr data-row="value">
            <th scope="row">{t('ctr.revision.compare.value')}</th>
            <td className="ctr-amount">{t('ctr.value.amount', { amount: amountText(now, locale) })}</td>
            <td className="ctr-amount" data-testid="after-value">
              {after === null ? t('ctr.revision.none.text') : t('ctr.value.amount', { amount: amountText(after, locale) })}
            </td>
          </tr>
          <tr data-row="delta">
            <th scope="row">{t('ctr.revision.compare.delta')}</th>
            <td className="ctr-amount">{t('ctr.revision.none.text')}</td>
            <td className="ctr-amount" data-testid="delta">
              {money(delta)}
            </td>
          </tr>
          <tr data-row="days">
            <th scope="row">{t('ctr.revision.compare.days')}</th>
            <td className="ctr-amount">{t('ctr.revision.none.text')}</td>
            <td className="ctr-amount" data-testid="days">
              {detail === undefined ? t('ctr.revision.none.text') : t('ctr.change.days.value', { days: detail.scheduleImpactDays })}
            </td>
          </tr>
          <tr data-row="effective">
            <th scope="row">{t('ctr.revision.compare.effective')}</th>
            <td className="ctr-amount">{t('ctr.revision.none.text')}</td>
            <td className="ctr-amount" data-testid="effective">
              {detail?.effectiveOn ?? t('ctr.revision.none.text')}
            </td>
          </tr>
        </tbody>
      </table>
      {funding === null ? null : (
        <p className="sub" data-testid="funding-note">
          {funding}
        </p>
      )}
      {scope === null ? null : (
        <p className="sub" data-testid="scope-note">
          {scope}
        </p>
      )}
    </SectionCard>
  );
}

const sign = (value: string | undefined, locale: string): string => (value === undefined ? '—' : amountText(value, locale));

/** The BOQ of the revision the change order made against the BOQ of the one it follows. */
function Lines({ request, contract, locale }: { request: ChangeRequest; contract: ContractView; locale: string }) {
  const { t } = useTranslation();
  const lines = useBoqLines(contract.id);
  const made = contract.revisions.find((revision) => revision.id === request.resultingRevisionId);
  const state = useScreenState({ isLoading: lines.isLoading, error: lines.error, data: lines.data });
  const diff: LineDiff[] =
    made === undefined || lines.data === undefined
      ? []
      : diffLines(
          lines.data.filter((line) => line.revisionId === made.supersedesId),
          lines.data.filter((line) => line.revisionId === made.id),
        );
  return (
    <SectionCard title={t('ctr.revision.lines.title')}>
      <StateBoundary state={state} onRetry={() => void lines.refetch()}>
        <table className="table" data-testid="lines">
          <thead>
            <tr>
              <th scope="col">{t('ctr.revision.lines.item')}</th>
              <th scope="col" className="ctr-amount">
                {t('ctr.revision.lines.quantity')}
              </th>
              <th scope="col" className="ctr-amount">
                {t('ctr.revision.lines.price')}
              </th>
              <th scope="col" className="ctr-amount">
                {t('ctr.revision.lines.amount')}
              </th>
              <th scope="col">{t('ctr.revision.lines.change')}</th>
            </tr>
          </thead>
          <tbody>
            {diff.map((row) => (
              <tr key={row.businessKey} data-line={row.businessKey} data-change={row.change}>
                <th scope="row">{`${row.businessKey} · ${row.description}`}</th>
                <td className="ctr-amount">{`${sign(row.before?.quantity, locale)} → ${sign(row.after?.quantity, locale)}`}</td>
                <td className="ctr-amount">{`${sign(row.before?.unitPrice, locale)} → ${sign(row.after?.unitPrice, locale)}`}</td>
                <td className="ctr-amount">{`${sign(row.before?.amountVnd, locale)} → ${sign(row.after?.amountVnd, locale)}`}</td>
                <td>{lineChangeLabel(t, row.change)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </StateBoundary>
    </SectionCard>
  );
}

function DecisionFormView({ request, decide, onSend }: { request: ChangeRequest; decide: DecideMutation; onSend(request: ChangeRequest, body: DecisionBody): void }) {
  const { t } = useTranslation();
  const today = vietnamToday(new Date());
  const [form, setForm] = useState<DecisionForm>(emptyDecision(request.detail?.evaluatedDeltaVnd ?? null, today));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateDecision(form, today);
  const error = (field: keyof DecisionForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? decisionProblemMessage(t, problem) : undefined;
  };
  const set = (patch: Partial<DecisionForm>): void => setForm({ ...form, ...patch });

  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (decide.isPending || form.decision === '' || Object.keys(problems).length > 0) return;
    onSend(request, decisionBody(form, form.decision));
  };

  return (
    <form onSubmit={send} noValidate>
      {decide.isError ? (
        <p className="callout warning" role="alert" data-testid="refusal">
          {problemMessage(t, describeProblem(decide.error))}
        </p>
      ) : null}
      <fieldset className="field" data-field="decision">
        <legend>{t('ctr.revision.decision.legend')}</legend>
        {DECISIONS.map((decision) => (
          <label key={decision} className="radio">
            <input type="radio" name="decision" value={decision} data-decision={decision} checked={form.decision === decision} onChange={() => set({ decision })} /> {decisionLabel(t, decision)}
          </label>
        ))}
        {error('decision') === undefined ? null : (
          <small role="alert" className="field-error">
            {error('decision')}
          </small>
        )}
      </fieldset>
      {form.decision === '' ? null : (
        <>
          <Field id="decision-reason" label={t('ctr.revision.field.reason')} error={error('reason')}>
            <textarea id="decision-reason" rows={3} maxLength={MAX_TEXT} value={form.reason} onChange={(event) => set({ reason: event.target.value })} />
          </Field>
          <Field id="decision-evidence" label={t('ctr.revision.field.evidence')} error={error('evidence')} hint={t('ctr.revision.field.evidence.hint')}>
            <textarea id="decision-evidence" rows={2} value={form.evidence} onChange={(event) => set({ evidence: event.target.value })} />
          </Field>
          {form.decision === 'approve' ? (
            <div className="formgrid">
              <Field id="decision-document" label={t('ctr.revision.field.document')} error={error('documentVersionId')} hint={t('ctr.revision.field.document.hint')}>
                <input id="decision-document" autoComplete="off" value={form.documentVersionId} onChange={(event) => set({ documentVersionId: event.target.value })} />
              </Field>
              <Field id="decision-delta" label={t('ctr.revision.field.delta')} error={error('approvedDeltaVnd')} hint={t('ctr.revision.field.delta.hint')}>
                <input id="decision-delta" inputMode="numeric" autoComplete="off" value={form.approvedDeltaVnd} onChange={(event) => set({ approvedDeltaVnd: event.target.value })} />
              </Field>
              <Field id="decision-day" label={t('ctr.revision.field.day')} error={error('effectiveOn')} hint={t('ctr.revision.field.day.hint')}>
                <input id="decision-day" type="date" value={form.effectiveOn} onChange={(event) => set({ effectiveOn: event.target.value })} />
              </Field>
              <Field id="decision-lines" label={t('ctr.revision.field.lines')} error={error('boqLines')} hint={t('ctr.revision.field.lines.hint')}>
                <textarea id="decision-lines" rows={4} spellCheck={false} value={form.boqLines} onChange={(event) => set({ boqLines: event.target.value })} />
              </Field>
            </div>
          ) : null}
          <div className="formfooter">
            <button type="submit" className="primary" disabled={decide.isPending}>
              {decide.isPending ? t('ctr.change.dialog.pending') : decisionSubmitLabel(t, form.decision)}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
