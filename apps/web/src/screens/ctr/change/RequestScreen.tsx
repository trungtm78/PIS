import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { BackLink, Field, StatusBadge } from '../components';
import { useContract } from '../hooks';
import { LIST_PATH, amountText } from '../model';
import type { ContractView } from '../model';
import { ContractPicker, RequestsTable } from './components';
import { useChain, useOpenChange } from './hooks';
import { eventKindLabel, formProblemMessage, problemMessage, stageLabel } from './labels';
import { CHANGEABLE_CONTRACT_STATUSES, EVENT_KINDS, MAX_TEXT, chainLink, describeProblem, emptyOpen, openBody, tiersLink, validateOpen } from './model';
import type { Chain, EventKind, OpenForm, Stage } from './model';
import '../ctr.css';
import { SectionCard } from '../../../ui';

/**
 * CTR-07: raise a change on a contract that is being performed (ST-CTR-006, CTR 3.3). The request starts at the first tier of the chain of the project (the event with three tiers, the
 * PCO with two, the CO with one) and rests on the revision of the contract that is in force; the person says what changed, why, what it is thought to cost and how far it moves the
 * schedule. The first request of a project fixes the number of its tiers, and the screen says so before it is sent. The server judges the command again.
 */
export default function RequestScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The contract and the form belong to one membership: a switch of tenant or of membership starts the screen over.
  return <RequestContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RequestContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const contractId = search.get('contract');
  const contract = useContract(contractId);
  const chain = useChain(contract.data?.projectId, contractId);
  // A contract that does not exist for the caller is an empty screen; the chain is read once the contract is known.
  const data = contractId === null || contract.data === null ? null : contract.data === undefined ? undefined : chain.data;
  const state = useScreenState({ isLoading: contract.isLoading || chain.isLoading, error: contract.error ?? chain.error, data, isEmpty: (value) => value === null });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctr.change.request.title')}</h1>
          <p>{t('ctr.change.request.subtitle')}</p>
        </div>
      </div>
      <BackLink to={LIST_PATH}>{t('ctr.back.list.link')}</BackLink>
      {contractId === null ? (
        <ContractPicker onPick={(id) => setSearch({ contract: id })} />
      ) : (
        <StateBoundary
          state={state}
          onRetry={() => {
            void contract.refetch();
            void chain.refetch();
          }}
        >
          {contract.data === null || contract.data === undefined || chain.data === null || chain.data === undefined ? null : (
            <Request contract={contract.data} chain={chain.data} locale={locale} readOnly={mode === 'READ_ONLY'} />
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('ctr.change.request.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface RequestProps {
  contract: ContractView;
  chain: Chain;
  locale: string;
  readOnly: boolean;
}

function Request({ contract, chain, locale, readOnly }: RequestProps) {
  const { t } = useTranslation();
  const { config } = chain;
  const inForce = contract.revisions.filter((revision) => revision.status === 'EFFECTIVE');
  const changeable = CHANGEABLE_CONTRACT_STATUSES.includes(contract.status);
  const start: Stage | undefined = config?.stages[0];
  // The notice that stands in place of the form, in the order the server judges: the right, the contract, the tiers, the revision in force.
  const blocked =
    readOnly || !chain.canOpen
      ? t('ctr.change.request.noCommand')
      : !changeable
        ? t('ctr.change.request.notPerformed')
        : start === undefined
          ? undefined
          : inForce.length === 0
            ? t('ctr.change.request.noRevision')
            : null;
  const [round, setRound] = useState(0);
  const [done, setDone] = useState(false);

  return (
    <div className="ctr-grid">
      <div>
        <SectionCard title={t('ctr.change.request.contract.title')}>
          <p>
            <strong data-testid="contract-code">{contract.code}</strong> · {contract.title ?? t('ctr.change.none.text')} <StatusBadge status={contract.status} />
          </p>
          <dl className="ctr-facts" data-testid="facts">
            <dt>{t('ctr.change.request.fact.project')}</dt>
            <dd>{`${contract.projectCode} · ${contract.projectName}`}</dd>
            <dt>{t('ctr.change.request.fact.value')}</dt>
            <dd data-testid="value">{t('ctr.value.amount', { amount: amountText(contract.contractValueVnd, locale) })}</dd>
          </dl>
        </SectionCard>
        <SectionCard title={t('ctr.change.request.list.title')}>
          {chain.requests.length === 0 ? (
            <p className="callout" role="status" data-testid="no-requests">
              {t('ctr.change.request.list.empty')}
            </p>
          ) : (
            <RequestsTable requests={chain.requests} projectId={contract.projectId} locale={locale} />
          )}
          <p>
            <Link to={chainLink(contract.projectId, contract.id)} data-testid="board-link">
              {t('ctr.change.request.board.link')}
            </Link>
          </p>
        </SectionCard>
      </div>
      <SectionCard title={t('ctr.change.request.form.title')}>
        {blocked === undefined ? (
          <p className="callout" role="status" data-testid="not-configured">
            {t('ctr.change.request.notConfigured')} {chain.canConfigure ? <Link to={tiersLink(contract.projectId)}>{t('ctr.change.request.tiers.link')}</Link> : null}
          </p>
        ) : blocked !== null ? (
          <p className="callout" role="status" data-testid="no-command">
            {blocked}
          </p>
        ) : (
          <>
            {done ? (
              <p className="callout" role="status" data-testid="done">
                {t('ctr.change.request.done.notice')}
              </p>
            ) : null}
            <Form
              key={round}
              contract={contract}
              stage={start ?? 'CO'}
              baselineRevisionId={inForce[inForce.length - 1]?.id ?? ''}
              revisions={inForce.map((revision) => ({ id: revision.id, label: t('ctr.change.request.revision.option', { revision: revision.revision, amount: amountText(revision.amountVnd, locale) }) }))}
              locksTiers={config?.locked === false}
              tierCount={config?.tierCount ?? 1}
              onDone={() => {
                setDone(true);
                setRound(round + 1);
              }}
            />
          </>
        )}
      </SectionCard>
    </div>
  );
}

interface FormProps {
  contract: ContractView;
  stage: Stage;
  baselineRevisionId: string;
  revisions: Array<{ id: string; label: string }>;
  locksTiers: boolean;
  tierCount: number;
  onDone(): void;
}

function Form({ contract, stage, baselineRevisionId, revisions, locksTiers, tierCount, onDone }: FormProps) {
  const { t } = useTranslation();
  const open = useOpenChange();
  const [form, setForm] = useState<OpenForm>(emptyOpen(baselineRevisionId));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateOpen(form);
  const error = (field: keyof OpenForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (open.isPending || Object.keys(problems).length > 0) return;
    open.mutate({ contractId: contract.id, body: openBody(form, stage) }, { onSuccess: onDone });
  };
  const set = (patch: Partial<OpenForm>): void => setForm({ ...form, ...patch });

  return (
    <form onSubmit={send} noValidate>
      {open.isError ? (
        <p className="callout warning" role="alert" data-testid="refusal">
          {problemMessage(t, describeProblem(open.error))}
        </p>
      ) : null}
      <p data-testid="start-stage">{t('ctr.change.request.stage.notice', { stage: stageLabel(t, stage), count: tierCount })}</p>
      {locksTiers ? (
        <p className="callout warning" role="status" data-testid="locks-notice">
          {t('ctr.change.request.locks.notice', { count: tierCount })}
        </p>
      ) : null}
      <div className="formgrid">
        <Field id="request-baseline" label={t('ctr.change.request.baseline.label')} error={error('baselineRevisionId')} hint={t('ctr.change.request.baseline.hint')}>
          <select id="request-baseline" value={form.baselineRevisionId} onChange={(event) => set({ baselineRevisionId: event.target.value })}>
            {revisions.map((revision) => (
              <option key={revision.id} value={revision.id}>
                {revision.label}
              </option>
            ))}
          </select>
        </Field>
        <Field id="request-kind" label={t('ctr.change.request.kind.label')} error={undefined}>
          <select id="request-kind" value={form.eventKind} onChange={(event) => set({ eventKind: EVENT_KINDS.find((kind: EventKind) => kind === event.target.value) ?? '' })}>
            <option value="">{t('ctr.change.request.kind.choose')}</option>
            {EVENT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {eventKindLabel(t, kind)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="request-reason" label={t('ctr.change.request.reason.label')} error={error('reason')}>
          <textarea id="request-reason" rows={4} maxLength={MAX_TEXT} value={form.reason} onChange={(event) => set({ reason: event.target.value })} />
        </Field>
        <Field id="request-estimated" label={t('ctr.change.request.estimated.label')} error={error('estimatedDeltaVnd')} hint={t('ctr.change.request.estimated.hint')}>
          <input id="request-estimated" inputMode="numeric" autoComplete="off" value={form.estimatedDeltaVnd} onChange={(event) => set({ estimatedDeltaVnd: event.target.value })} />
        </Field>
        <Field id="request-days" label={t('ctr.change.request.days.label')} error={error('scheduleImpactDays')} hint={t('ctr.change.request.days.hint')}>
          <input id="request-days" inputMode="numeric" autoComplete="off" value={form.scheduleImpactDays} onChange={(event) => set({ scheduleImpactDays: event.target.value })} />
        </Field>
      </div>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={open.isPending}>
          {open.isPending ? t('ctr.change.dialog.pending') : t('ctr.change.request.submit')}
        </button>
      </div>
    </form>
  );
}
